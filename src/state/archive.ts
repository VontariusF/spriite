/**
 * The phone side of the VPS archive mirror (docs/VPS-ARCHIVE-SPEC.md §5-§7).
 *
 * The phone stays the execution host and the source of truth; this module
 * mirrors its RECORDS to the owner's VPS so a lost, reset, or replaced phone
 * can restore them. One-way (spec §2): the phone writes upserts and asks for
 * restore pages; the archive never dispatches work, holds a credential, or
 * feeds the live HUD. If the VPS is unreachable, nothing here throws into the
 * mission system — the outbox keeps the work and the Setup step shows it.
 *
 * Three parts, one file:
 *  - the mirror's own vault (device key, acknowledged cursor, retry queue)
 *    over the same serialized SDK-storage bridge every other vault uses;
 *  - the payload assembler: mission rows, chat tails, feed entries, X tag
 *    receipts, and opaque engine snapshots flattened into full-row upserts
 *    with the spec §7 column names. Credentials are excluded by
 *    CONSTRUCTION: the record types name every field they carry, none is a
 *    credential, and the type below stops compiling the moment one appears
 *    — never a filter hunting strings downstream;
 *  - the client: a bounded outbox (200 record keys, deduped, 5-minute backoff
 *    doubling to an hour), a 30-second debounce after durable writes, a
 *    flush on background, an owner-forced Sync now, and an explicit,
 *    owner-confirmed restore that merges by `updated_at`, last-write-wins.
 *
 * Erasable-only syntax; every runtime import is a dependency-free state
 * module, so Node test scripts load it.
 */
import { isChatWho, type ChatWho } from '../domain/speaker'
import type { BridgeGateway } from '../bridge/bridge'
import { FEED_KEEP, type FeedEntry, type FeedVault } from './feed'
import { MISSION_PHASES, X_RECEIPT_STATUSES, isTerminalPhase, type Mission, type MissionPhase, type SpriiteState, type XIntakeReceipt } from '../domain/types'
import type { MissionStore } from './mission-store'
import type { RealSnapshot } from '../factory/real'
import type { MissionConfig } from '../domain/types'
import { decodeNativeCache, decodeNativeIntent, decodeNativeProfile, type NativeMissionCache } from '../native/decode'
import { nativeIntentMatchesProfile } from '../native/workspace'

const ENV = (import.meta as { env?: { DEV?: boolean; VITE_SPRIITE_RELAY?: string } }).env
const RELAY = (ENV?.VITE_SPRIITE_RELAY ?? '').replace(/\/+$/, '')
/**
 * The two archive routes live on the relay itself (spec §6): {origin}/spriite/
 * sync and /spriite/archive. Dev builds go same-origin like every other
 * service; an installed build with no relay has no archive to talk to, and the
 * client reports that instead of inventing a URL.
 */
const DEFAULT_BASE = ENV?.DEV ? '/api/spriite' : RELAY ? `${RELAY}/spriite` : ''

/** One batch per debounce window after a durable write (spec §6). */
export const SYNC_DEBOUNCE_MS = 30_000
/** Failed sends retry after 5 minutes, doubling, never more than an hour. */
export const RETRY_BASE_MS = 5 * 60_000
export const RETRY_CAP_MS = 60 * 60_000
/** The retry queue is bounded (spec §2): 200 record keys, oldest evicted. */
export const OUTBOX_MAX = 200
/** One HTTP attempt never hangs the flush that awaits it. */
const FETCH_TIMEOUT_MS = 20_000
/** Restore pages are owner-initiated but still bounded against a runaway. */
export const RESTORE_MAX_PAGES = 50

/**
 * The engine snapshot keeps the newest 40 chat entries per mission at write
 * time (src/factory/real.ts); the archive holds unbounded history and serves
 * it back, and the phone re-applies its own cap on restore (spec §2).
 */
export const ARCHIVE_CHAT_KEEP = 40

// --------------------------------------------------------------- the wire

/** One upsert row. Field names are the spec §7 column names, so the archive's
 *  schema and this payload can never drift apart. */
interface MissionRecord {
  kind: 'mission'
  mission_id: string
  title: string
  goal: string
  /** The mission phase word, terminal or live. */
  status: string
  repo: string
  origin: 'phone' | 'x'
  created_at: number
  updated_at: number
  execution_backend?: 'legacy' | 'factory_native'
}
interface ChatRecord {
  kind: 'chat'
  mission_id: string
  /** Per-mission monotonic; the line's own identity from the engine's chat
   *  counter — never a position in the capped tail, which a slide rebinds. */
  seq: number
  who: ChatWho
  text: string
  at: number
}
interface FeedRecord {
  kind: 'feed'
  at: number
  label: string
  text: string
}
interface TagRecord {
  kind: 'tag'
  dedupe_key: string
  /** The post's stable logical id (the first id of its edit history). */
  logical_post_id: string
  /** The newest revision (edit) this receipt was evaluated against. */
  revision_id: string
  /** How the mention arrived — the receipt's own word, carried both ways. */
  via: 'catch_up' | 'stream' | 'import'
  status: string
  instruction: string
  repository: string
  mission_id: string
  received_at: number
  /** Actual publication time; absent/null for legacy or unknown timestamps. */
  posted_at?: number | null
  /**
   * When the post was deleted on X (ms epoch). Absent or null while the post
   * is live; the row carries it so a restore rebuilds the receipt deleted —
   * a deletion is recorded fact, never a resurrection (§7 tags).
   */
  deleted_at?: number | null
  /**
   * An edit observed after dispatch: the proposed revision's id, recorded
   * and never applied. Absent or null while no edit was seen.
   */
  proposed_revision_id?: string | null
}
interface SnapshotRecord {
  kind: 'snapshot'
  mission_id: string
  /** The whole engine snapshot, JSON-encoded (§7 stores TEXT). */
  json: string
  updated_at: number
}

type ArchiveRecordShape = MissionRecord | ChatRecord | FeedRecord | TagRecord | SnapshotRecord

/** Every field name a credential could ever take, from the vaults. */
type CredentialField =
  | 'elevenLabs'
  | 'factory'
  | 'cursor'
  | 'github'
  | 'nativeBroker'
  | 'x'
  | 'xRefresh'
  | 'xCredentialRef'
  | 'deviceKey'
  | 'token'
  | 'secret'

/**
 * The payload type this module may define. The moment a record kind grows a
 * credential field the whole type collapses to `never`, so every use site
 * stops compiling: the exclusion is asserted by type, not by scrubbing
 * serialized strings downstream (spec §5).
 */
type WithoutCredentials<T> = Extract<keyof T, CredentialField> extends never ? T : never
export type ArchiveRecord = WithoutCredentials<ArchiveRecordShape>
export const ARCHIVE_RECORD_KINDS = ['mission', 'chat', 'feed', 'tag', 'snapshot'] as const

/** POST {relay}/spriite/sync — an upsert batch and the cursor it extends. */
export interface SyncRequest {
  v: 1
  /** The cursor the relay last acknowledged ('' before the first ack). */
  cursor: string
  records: ArchiveRecord[]
}
/** The acknowledged cursor; the phone stores it in the vault. */
export interface SyncResponse {
  v: 1
  cursor: string
}

/** POST {relay}/spriite/archive — a restore page request. */
export interface ArchiveRequest {
  v: 1
  /** '' asks for the first (newest) page; the reply's cursor asks for more. */
  cursor: string
}
/** Records newest-first; an empty cursor means no more pages. */
export interface ArchiveResponse {
  v: 1
  records: ArchiveRecord[]
  cursor: string
}

// ------------------------------------------------------------- the sources

/** One chat entry, the shape the durable snapshot keeps. */
export interface ChatTailEntry {
  who: ChatWho
  text: string
  at: number
  /**
   * The line's stable per-mission identity, assigned once by the engine's
   * chat counter and carried by the durable snapshot. The archive keys chat
   * rows on (mission_id, seq), so this — never the entry's position in the
   * capped tail, which every slide would rebind — is what a row upserts
   * under (the relay overwrites on the pair; a rebind rewrites history).
   */
  seq: number
}

/**
 * What the assembler may read. Narrow by construction: it names the record
 * surfaces only, so a credential has no path into a payload even before the
 * record types do their part.
 */
export interface ArchiveSources {
  missions(): readonly Mission[]
  /** The durable engine snapshot of any mission (engineSnapshotFor's read). */
  snapshotFor(missionId: string): RealSnapshot | null
  /** Native cache is archived with its frozen non-secret execution config. */
  nativeCacheFor?(missionId: string): NativeMissionCache | null
  /** A mission's durable chat tail (chatLogFor's durable reading). */
  chatTailFor(missionId: string): readonly ChatTailEntry[]
  feed(): readonly FeedEntry[]
  receipts(): readonly XIntakeReceipt[]
  /**
   * The originating command ids born from X dedupe keys (the store's own
   * `commandDedupe` map, never pruned). The receipts a mission's origin is
   * read from ARE prunable (bounded intake), so this is the fallback that
   * keeps a long-lived X mission's row saying origin 'x' after its receipt
   * aged out of the phone's cap. Optional so narrow test sources can omit
   * it; absence never invents 'x'.
   */
  xCommandIds?(): Set<string>
}

/**
 * One chat entry as a persisted snapshot may carry it. The same shape check
 * the engine's restore applies (src/runtime/app-engine.ts), plus the one
 * field only the archive path needs: a valid `seq`. A line without one is
 * pre-seq legacy data — dropped here, never keyed by its position, which is
 * exactly the rebind this table must never see. The engine's own restore is
 * the display path and still keeps such lines (it mints fresh seqs); the
 * wire row is dropped, never guessed at.
 */
export function validChatEntry(c: unknown): ChatTailEntry | null {
  if (c === null || typeof c !== 'object') return null
  const e = c as { who?: unknown; text?: unknown; at?: unknown; seq?: unknown }
  if (!isChatWho(e.who)) return null
  if (typeof e.text !== 'string' || e.text.trim() === '') return null
  if (typeof e.seq !== 'number' || !Number.isSafeInteger(e.seq) || e.seq < 0) return null
  return { who: e.who, text: e.text, at: Number(e.at) || 0, seq: e.seq }
}

/** The queue key of one record kind ('feed' covers the whole capped list). */
export function missionKey(missionId: string): string {
  return `mission:${missionId}`
}
export function chatKey(missionId: string): string {
  return `chat:${missionId}`
}
export function snapshotKey(missionId: string): string {
  return `snapshot:${missionId}`
}
export function tagKey(dedupeKey: string): string {
  return `tag:${dedupeKey}`
}
export const FEED_RECORD_KEY = 'feed'

/**
 * The upsert rows one queued key stands for, rebuilt from the CURRENT records
 * at send time: every row is a full-row upsert keyed by id and monotonic
 * `updated_at` (spec §2), so a retry after a newer write simply carries the
 * newer row, and replays are harmless. Null when the source record is gone:
 * there is nothing left to mirror, and the queue slot is released.
 */
export function assembleRecords(key: string, sources: ArchiveSources): ArchiveRecord[] | null {
  if (key === FEED_RECORD_KEY) {
    const entries = sources.feed()
    if (entries.length === 0) return null
    return entries.map((e) => ({ kind: 'feed', at: e.at, label: e.label, text: e.text }))
  }
  const [kind, id] = splitKey(key)
  if (kind === 'mission' && id !== null) {
    const m = sources.missions().find((x) => x.missionId === id)
    if (m === undefined) return null
    // Origin is a fact about the mission's own command, not about which
    // receipts happen to still fit the phone's cap: the X command's
    // originatingCommandId (commandDedupe, never pruned) keeps saying 'x'
    // after the mission's receipt aged out of the bounded intake.
    const origin =
      sources.receipts().some((r) => r.missionId === id) ||
      (sources.xCommandIds?.().has(m.originatingCommandId) ?? false)
        ? 'x'
        : 'phone'
    return [{
      kind: 'mission',
      mission_id: m.missionId,
      title: m.title,
      goal: m.goal,
      // The current relay preserves this column but drops unknown columns.
      // Prefixing ownership makes even an older binary reject native rows,
      // including when their snapshot is missing/corrupt after restore.
      status: m.config.executionBackend === 'factory_native' ? `factory_native:${m.phase}` : m.phase,
      repo: m.config.repository,
      origin,
      created_at: Date.parse(m.createdAt) || 0,
      updated_at: Date.parse(m.updatedAt) || 0,
      ...(m.config.executionBackend === 'factory_native' ? { execution_backend: 'factory_native' as const } : {}),
    }]
  }
  if (kind === 'chat' && id !== null) {
    const rows = sources
      .chatTailFor(id)
      .map(validChatEntry)
      .filter((e): e is ChatTailEntry => e !== null)
    if (rows.length === 0) return null
    // The seq is each line's own (the engine's chat counter, carried by the
    // durable tail), so a row upserts to the line it was born to even after
    // the tail slides past the snapshot's 40-line cap — an index here would
    // rebind seqs to different lines on every sync and rewrite history on
    // the relay's (mission_id, seq) key (§7).
    return rows.map((e) => ({ kind: 'chat', mission_id: id, seq: e.seq, who: e.who, text: e.text, at: e.at }))
  }
  if (kind === 'snapshot' && id !== null) {
    const m = sources.missions().find((x) => x.missionId === id)
    if (m?.config.executionBackend === 'factory_native') {
      const cache = decodeNativeCache(sources.nativeCacheFor?.(id))
      const config = nativeArchiveConfig(m.config)
      if (!cache || !config) return null
      return [{ kind: 'snapshot', mission_id: id,
        json: JSON.stringify({ nativeArchiveVersion: 1, backend: 'factory_native', config, cache }),
        updated_at: Date.parse(m.updatedAt) || 0 }]
    }
    const snap = sources.snapshotFor(id)
    // A snapshot rides a mission row (§7 references missions); without the
    // mission record there is no row to upsert under.
    if (m === undefined || snap === null) return null
    return [{
      kind: 'snapshot',
      mission_id: id,
      json: JSON.stringify(snap),
      updated_at: Date.parse(m.updatedAt) || 0,
    }]
  }
  if (kind === 'tag' && id !== null) {
    const r = sources.receipts().find((x) => x.dedupeKey === id)
    if (r === undefined) return null
    return [{
      kind: 'tag',
      dedupe_key: r.dedupeKey,
      logical_post_id: r.logicalPostId,
      revision_id: r.revisionId,
      via: r.via,
      status: r.status,
      instruction: r.instruction,
      repository: r.repository ?? '',
      mission_id: r.missionId ?? '',
      received_at: Date.parse(r.receivedAt) || 0,
      ...(r.postedAtTrusted !== false && Number.isFinite(Date.parse(r.postedAt)) ? { posted_at: Date.parse(r.postedAt) } : {}),
      // A deletion and an edit-after-dispatch are receipt facts like any
      // other (§7): carried only when the phone observed them, so a row
      // without them is an honest live post, never a cleared one.
      ...(r.deletedAt !== undefined ? { deleted_at: Date.parse(r.deletedAt) || 0 } : {}),
      ...(r.proposedRevisionId !== undefined ? { proposed_revision_id: r.proposedRevisionId } : {}),
    }]
  }
  return null
}

function splitKey(key: string): [string, string | null] {
  const at = key.indexOf(':')
  if (at === -1) return [key, null]
  return [key.slice(0, at), key.slice(at + 1)]
}

// ------------------------------------------------------------ the vault

const VAULT_KEY = 'spriite.archive.v1'

/** One record key the relay has not acknowledged, with its retry state. */
export interface OutboxRow {
  key: string
  /** Failed attempts so far; 0 until the first send fails. */
  attempts: number
  /** The earliest wall-clock ms the next attempt may go out. */
  nextAttemptAt: number
}

interface StoredArchive {
  v: 1
  /** The device key (base64url, >= 32 bytes): the bearer on archive routes
   *  only. Never in a payload, never logged, shown once at generation. */
  deviceKey?: string
  /** The cursor the relay last acknowledged ('' before the first ack). */
  cursor?: string
  /** The bounded retry queue; durable, so a killed flush keeps its work. */
  outbox?: OutboxRow[]
  lastSyncAt?: string
  /** Why the last attempt failed, as a word — never an echoed body, which
   *  can quote credential material back. */
  lastError?: string
}

/** >= 32 random bytes, base64url without padding (43 characters). */
function randomDeviceKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The only key shapes the vault will hold (spec §5: >= 32 bytes base64url). */
export function isDeviceKeyShape(key: string): boolean {
  return /^[A-Za-z0-9_-]{43,}$/.test(key.trim())
}

/**
 * One queue row as storage may hand it back. A corrupt row is dropped, never
 * repaired or guessed at — the same discipline every vault's restore follows
 * (an unreadable outbox is absence, not a crash that kills the mirror).
 */
function validOutboxRow(raw: unknown): OutboxRow | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as { key?: unknown; attempts?: unknown; nextAttemptAt?: unknown }
  if (typeof r.key !== 'string' || r.key === '') return null
  const attempts = typeof r.attempts === 'number' && Number.isFinite(r.attempts) && r.attempts >= 0 ? r.attempts : 0
  const nextAttemptAt =
    typeof r.nextAttemptAt === 'number' && Number.isFinite(r.nextAttemptAt) && r.nextAttemptAt >= 0 ? r.nextAttemptAt : 0
  return { key: r.key, attempts, nextAttemptAt }
}

/** The stored retry queue, bounded and shaped, whatever storage held. */
function validOutbox(raw: unknown): OutboxRow[] {
  if (!Array.isArray(raw)) return []
  const out: OutboxRow[] = []
  for (const row of raw) {
    const r = validOutboxRow(row)
    if (r !== null) out.push(r)
    if (out.length >= OUTBOX_MAX) break
  }
  return out
}

export class ArchiveVault {
  private stored: StoredArchive = { v: 1 }
  private readonly gateway: BridgeGateway
  private writes: Promise<unknown> = Promise.resolve()
  /**
   * True while the boot read never answered: the SDK returns '' for a
   * missing key, so a null from the gateway is a transport failure, not
   * absence. Until a read answers, the record in memory may be a subset of
   * what storage holds, and a commit must merge with the stored record
   * before it overwrites it — otherwise the next write after a boot blip
   * would mint a second device key over the one the owner's VPS knows (and
   * drop the queued rows with it).
   */
  private unknownRead = false

  constructor(gateway: BridgeGateway) {
    this.gateway = gateway
  }

  async load(): Promise<void> {
    const raw = await this.gateway.call((b) => b.getLocalStorage(VAULT_KEY), 'getArchive')
    if (raw === null) {
      // A transport failure is not a missing key: retry once, and only an
      // answer may load.
      const retry = await this.gateway.call((b) => b.getLocalStorage(VAULT_KEY), 'getArchiveRetry')
      if (retry === null) {
        this.unknownRead = true
        return
      }
      this.take(retry)
      return
    }
    this.unknownRead = false
    if (raw === '') return
    this.take(raw)
  }

  /** Adopt a stored record, whatever fields in it are shaped. */
  private take(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as StoredArchive
      if (parsed?.v === 1) {
        // Restore validation, the same rule every vault here follows: only
        // shaped values survive a load. A corrupt outbox, a truncated key,
        // or a wrong-typed cursor is absence — never a crash that takes the
        // Setup step or the mirror's commit observer down with it.
        this.stored = {
          v: 1,
          deviceKey:
            typeof parsed.deviceKey === 'string' && isDeviceKeyShape(parsed.deviceKey)
              ? parsed.deviceKey
              : undefined,
          cursor: typeof parsed.cursor === 'string' ? parsed.cursor : undefined,
          outbox: validOutbox(parsed.outbox),
          lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : undefined,
          lastError: typeof parsed.lastError === 'string' ? parsed.lastError : undefined,
        }
      }
    } catch {
      console.warn('[archive] stored mirror state unreadable; ignoring')
    }
  }

  get deviceKey(): string {
    return this.stored.deviceKey ?? ''
  }

  get cursor(): string {
    return this.stored.cursor ?? ''
  }

  get rows(): OutboxRow[] {
    return this.stored.outbox ?? []
  }

  get lastSyncAt(): string | null {
    return this.stored.lastSyncAt ?? null
  }

  get lastError(): string | null {
    return this.stored.lastError ?? null
  }

  /**
   * Mint this phone's one device key. Returns it exactly once — the caller
   * shows it with a copy affordance and never again. Null when a key
   * already exists (a saved key is never re-shown, including one the boot
   * read never saw: the merge inside the commit keeps it) or the write did
   * not land.
   */
  async generateDeviceKey(): Promise<string | null> {
    if (this.deviceKey !== '') return null
    let minted: string | null = null
    const ok = await this.commit((s) => {
      // Storage may hold a key the boot read never saw: keep it, and let
      // the null answer above stay honest on the caller's side.
      if (s.deviceKey !== undefined) return s
      minted = randomDeviceKey()
      return { ...s, deviceKey: minted }
    })
    return ok && minted !== null ? minted : null
  }

  /** Adopt the key another phone's archive answers to (the restore flow). */
  async adoptDeviceKey(key: string): Promise<boolean> {
    const typed = key.trim()
    if (!isDeviceKeyShape(typed)) return false
    return this.commit((s) => ({ ...s, deviceKey: typed }))
  }

  async setCursor(cursor: string): Promise<boolean> {
    if (cursor === '') return true
    return this.commit((s) => ({ ...s, cursor }))
  }

  /**
   * Mutate the retry queue at WRITE time: the transform sees the rows storage
   * actually took, never a snapshot the caller read before an in-flight write
   * landed. A caller-side snapshot is exactly how a queued key gets
   * overwritten and lost (two commits inside one bridge-write latency, an
   * enqueue landing while a sync's ack path writes) — the record those keys
   * stand for would then never mirror until it changed again, and a terminal
   * mission never changes again.
   */
  updateRows(transform: (rows: OutboxRow[]) => OutboxRow[]): Promise<boolean> {
    return this.commit((s) => ({ ...s, outbox: transform(s.outbox ?? []) }))
  }

  async markSynced(at: string): Promise<boolean> {
    return this.commit((s) => ({ ...s, lastSyncAt: at, lastError: undefined }))
  }

  /** The last attempt's failure word; cleared by the next success. */
  async markError(error: string): Promise<boolean> {
    return this.commit((s) => ({ ...s, lastError: error }))
  }

  /**
   * Resolves when every queued vault write has landed. The client's sync
   * awaits this before it reads the queue, so records enqueued a moment ago
   * are never left behind by an immediately-forced send.
   */
  get settled(): Promise<void> {
    return this.writes.then(
      () => undefined,
      () => undefined,
    )
  }

  /** The serialized-commit pattern the keys vault uses: one queued write per
   *  change, the in-memory record only ever reflecting what storage took. */
  private commit(update: (s: StoredArchive) => StoredArchive): Promise<boolean> {
    const run = this.writes.then(async () => {
      // The boot read never answered: re-read before overwriting, and build
      // the next record on what storage actually holds — or the first
      // successful write after a boot blip would mint a second device key
      // over the one the owner's VPS knows and drop the queued rows with
      // it. A second null keeps the read unknown; the write below then
      // fails through the same bridge in all but a double-blip window.
      if (this.unknownRead) {
        const stored = await this.gateway.call((b) => b.getLocalStorage(VAULT_KEY), 'getArchiveMerge')
        if (stored !== null && stored !== '') this.take(stored)
        if (stored !== null) this.unknownRead = false
      }
      const next = update(this.stored)
      const ok = await this.gateway.call(
        (b) => b.setLocalStorage(VAULT_KEY, JSON.stringify(next)),
        'setArchive',
      )
      if (ok !== true) return false
      this.stored = next
      return true
    })
    this.writes = run.catch(() => undefined)
    return run
  }
}

// ------------------------------------------------------------- the client

export interface ArchiveClientDeps {
  gateway: BridgeGateway
  /** The durable runtime's store: the assembler reads it, restore writes it. */
  store: MissionStore<SpriiteState>
  sources: ArchiveSources
  /** The activity feed's durable copy; restore merges into it. */
  feed: FeedVault
  enabled: () => boolean
  foreground: () => boolean
  /** Test seam: where the relay lives; defaults to the build's resolution. */
  base?: string
  fetch?: typeof fetch
  now?: () => number
  debounceMs?: number
  retryBaseMs?: number
  retryCapMs?: number
  /** The phone page re-renders its feed after a restore merged entries. */
  onFeedRestored?: (entries: FeedEntry[]) => void
}

/** What the Setup step shows: honest counts, never a spinner that lies. */
export interface ArchiveState {
  enabled: boolean
  hasKey: boolean
  syncing: boolean
  /** Records queued and not yet acknowledged. */
  pending: number
  /** Queued records whose last attempt failed. */
  failed: number
  /** ms until the next automatic retry, when one is scheduled. */
  nextRetryIn: number | null
  lastSyncAt: string | null
  lastError: string | null
}

export type SyncOutcome =
  | { status: 'acked'; sent: number }
  | { status: 'off' | 'no_key' | 'no_relay' | 'busy' | 'offline' | 'auth' | 'server' }

export type RestoreOutcome =
  | {
      status: 'restored'
      /** Missions rebuilt from the archive (phone-newer ones were skipped). */
      missions: number
      /** Missions whose chat history came back. */
      chat: number
      /** Feed entries the phone holds after the restore (deduped union). */
      feed: number
      tags: number
      pages: number
      /**
       * The page walk stopped at its bound while the archive still offered
       * more: what came back is real, but it is not the whole archive. The
       * Setup step must be able to say that, never present a capped walk as
       * a complete restore.
       */
      more: boolean
    }
  | { status: 'off' | 'no_key' | 'no_relay' | 'busy' | 'offline' | 'auth' | 'server' | 'storage' }

export class ArchiveClient {
  private readonly deps: ArchiveClientDeps
  private readonly vault: ArchiveVault
  private readonly base: string
  private readonly doFetch: typeof fetch
  private readonly now: () => number
  private readonly debounceMs: number
  private readonly retryBaseMs: number
  private readonly retryCapMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private syncing = false
  private restoring = false
  /**
   * Record keys whose content changed WHILE a batch was in flight. Those keys
   * were sent with their older content, so the ack must not release their
   * slot: the newer record re-queues on its own, and a later batch carries it.
   * Without this, a mission completing inside a send's network window would
   * leave the archive holding the live row forever — the worst stale record a
   * restore can resurrect.
   */
  private readonly arrivedDuringSync = new Set<string>()
  private readonly listeners = new Set<() => void>()

  constructor(deps: ArchiveClientDeps) {
    this.deps = deps
    this.vault = new ArchiveVault(deps.gateway)
    this.base = (deps.base ?? DEFAULT_BASE).replace(/\/+$/, '')
    this.doFetch = deps.fetch ?? ((input, init) => fetch(input, init))
    this.now = deps.now ?? (() => Date.now())
    this.debounceMs = deps.debounceMs ?? SYNC_DEBOUNCE_MS
    this.retryBaseMs = deps.retryBaseMs ?? RETRY_BASE_MS
    this.retryCapMs = deps.retryCapMs ?? RETRY_CAP_MS
  }

  async load(): Promise<void> {
    await this.vault.load()
  }

  /** The Setup step re-renders its state line whenever the mirror moves. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  // ------------------------------------------------------ device key

  hasKey(): boolean {
    return this.vault.deviceKey !== ''
  }

  /**
   * The whole device key, for "Move to another phone" only: the transfer is
   * end-to-end encrypted (src/pair), so the new phone can restore its records
   * from the relay archive. Never shown on screen (keyHint is).
   */
  get deviceKey(): string {
    return this.vault.deviceKey
  }

  /** "abc••••wxyz" for the Setup step; never the whole key. */
  keyHint(): string {
    const k = this.vault.deviceKey
    return k ? `${k.slice(0, 3)}••••${k.slice(-4)}` : ''
  }

  async generateDeviceKey(): Promise<string | null> {
    return this.vault.generateDeviceKey()
  }

  async adoptDeviceKey(key: string): Promise<boolean> {
    return this.vault.adoptDeviceKey(key)
  }

  // ------------------------------------------------------ durable-write hooks

  /**
   * The mission store's commit observer (the one durable-write trigger for
   * mission records, chat tails, snapshots, and receipts): diff the two
   * states, queue the changed record keys, arm the debounce. Never throws —
   * the store swallows anyway, but the mirror's failure is never the
   * mission system's business.
   */
  noteState(prev: SpriiteState, next: SpriiteState): void {
    const keys = new Set<string>()
    const prevMissions = new Map(prev.missions.map((m) => [m.missionId, m]))
    for (const m of next.missions) {
      const before = prevMissions.get(m.missionId)
      if (
        before === undefined ||
        before.updatedAt !== m.updatedAt ||
        before.phase !== m.phase ||
        before.control !== m.control ||
        before.title !== m.title ||
        before.goal !== m.goal ||
        before.config.repository !== m.config.repository
      ) {
        keys.add(missionKey(m.missionId))
        keys.add(chatKey(m.missionId))
        keys.add(snapshotKey(m.missionId))
      }
    }
    const prevSnapshots = prev.engineSnapshots ?? {}
    for (const [id, snap] of Object.entries(next.engineSnapshots ?? {})) {
      if (prevSnapshots[id] === undefined || JSON.stringify(prevSnapshots[id]) !== JSON.stringify(snap)) {
        keys.add(snapshotKey(id))
        keys.add(chatKey(id))
      }
    }
    const prevReceipts = new Map((prev.xIntake?.receipts ?? []).map((r) => [r.dedupeKey, r]))
    for (const r of next.xIntake?.receipts ?? []) {
      const before = prevReceipts.get(r.dedupeKey)
      if (
        before === undefined ||
        before.receivedAt !== r.receivedAt ||
        before.status !== r.status ||
        before.missionId !== r.missionId ||
        before.repository !== r.repository ||
        // A deletion and a proposed revision land on an existing receipt
        // with no other field moving (§11: recorded, never acted on), so
        // the diff must see them or the tag row never re-syncs.
        before.revisionId !== r.revisionId ||
        before.deletedAt !== r.deletedAt ||
        before.proposedRevisionId !== r.proposedRevisionId
      ) {
        keys.add(tagKey(r.dedupeKey))
      }
    }
    this.enqueue([...keys])
  }

  /** The feed append hook: one key covers the whole capped list. */
  noteFeed(): void {
    this.enqueue([FEED_RECORD_KEY])
  }

  /** Arm the debounce only (mission views, receipts landing, a save). */
  touch(): void {
    if (!this.deps.enabled()) return
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.sync(false)
    }, this.debounceMs)
  }

  /**
   * Queue record keys: deduped by key, bounded to OUTBOX_MAX (the
   * longest-queued key is evicted; its record re-queues the next time it
   * changes), and a re-queued key after a failure gets its next attempt back
   * to "due now" — newer content deserves a fresh chance, not the old
   * penalty. The merge runs inside the vault's queued write against the rows
   * storage took, so a write that lands behind another can never drop keys
   * the other added (see ArchiveVault.updateRows).
   */
  private enqueue(keys: string[]): void {
    if (keys.length === 0) return
    const now = this.now()
    if (this.syncing) for (const key of keys) this.arrivedDuringSync.add(key)
    // New rows are due the moment they land (nextAttemptAt 0); a re-queued
    // row keeps the earliest of its own attempt and now (a key whose record
    // changed after a failure is due again, not held to the old penalty).
    const incoming: OutboxRow[] = keys.map((key) => ({ key, attempts: 0, nextAttemptAt: 0 }))
    // The guard is best-effort (rows may move between the read and the
    // write); an extra identical write is harmless, a missed one is not.
    if (sameRows(this.vault.rows, mergeOutboxRows(this.vault.rows, incoming, now))) return
    void this.vault
      .updateRows((rows) => mergeOutboxRows(rows, incoming, now))
      .then(() => this.notify(), () => this.notify())
    this.touch()
  }

  /** The retry beat: one attempt when a queued record is due. */
  tick(): void {
    if (this.timer !== null || this.syncing) return
    if (!this.deps.enabled() || !this.deps.foreground()) return
    const now = this.now()
    if (!this.vault.rows.some((r) => r.nextAttemptAt <= now)) return
    void this.sync(false)
  }

  /** Cancel the debounce and send now; a flush awaits it (app background). */
  async syncNow(): Promise<SyncOutcome> {
    this.cancelTimer()
    return this.sync(true)
  }

  /** The batch's outcome: 'acked' landed, the other words say why not. */
  private async sync(force: boolean): Promise<SyncOutcome> {
    if (!this.deps.enabled()) return { status: 'off' }
    if (this.syncing) return { status: 'busy' }
    const key = this.vault.deviceKey
    if (key === '') return { status: 'no_key' }
    if (this.base === '') return { status: 'no_relay' }
    this.syncing = true
    this.arrivedDuringSync.clear()
    try {
      // Records enqueued a moment ago are still landing in storage; the
      // queue is only what storage took, so the send waits for it.
      await this.vault.settled
      const now = this.now()
      const due = force ? this.vault.rows : this.vault.rows.filter((r) => r.nextAttemptAt <= now)
      const records: ArchiveRecord[] = []
      const sent = new Set<string>()
      const dropped = new Set<string>()
      for (const row of due) {
        const built = assembleRecords(row.key, this.deps.sources)
        if (built === null) {
          dropped.add(row.key)
          continue
        }
        records.push(...built)
        sent.add(row.key)
      }
      if (dropped.size > 0) {
        // The source record is gone: nothing to mirror, so the slot is
        // released rather than retried forever. A key the send window
        // re-queued keeps its slot — its source came back while the batch
        // was in the air, and that newer record still owes a batch.
        await this.vault.updateRows((rows) =>
          rows.filter((r) => (!dropped.has(r.key) || this.arrivedDuringSync.has(r.key))),
        )
      }
      if (records.length === 0) return { status: 'acked', sent: 0 }
      const attempt = await this.postBatch(records, key)
      if (attempt.status !== 'acked') {
        // The batch did not land: every sent key keeps its slot and earns the
        // next backoff step (5 min, doubling, capped at 1 h) — except a key
        // whose content changed during the send, which stays due now so the
        // retry carries the newer record without waiting out the old batch's
        // penalty. Replays are harmless, so a batch that landed against a
        // dead connection is simply re-sent whole.
        const at = this.now()
        await this.vault.updateRows((rows) =>
          rows.map((r) => {
            if (!sent.has(r.key) || this.arrivedDuringSync.has(r.key)) return r
            return {
              key: r.key,
              attempts: r.attempts + 1,
              nextAttemptAt: at + Math.min(this.retryBaseMs * 2 ** r.attempts, this.retryCapMs),
            }
          }),
        )
        await this.vault.markError(attempt.status)
        // A key whose content changed during the failed send stayed due-now
        // (its penalty was waived); nothing else will schedule it if the
        // enqueue's no-change guard skipped the debounce. Arm one batch.
        if (this.vault.rows.some((r) => r.nextAttemptAt <= this.now())) this.touch()
        this.notify()
        return { status: attempt.status }
      }
      // Acknowledged: the cursor moves, the sent keys leave the queue, and
      // the state line gets its honest "last synced". A key re-queued during
      // the send is NOT released — what landed was its older content — and
      // it is due now, so it needs a batch scheduled (its enqueue saw no row
      // change and armed nothing).
      await this.vault.setCursor(attempt.cursor)
      await this.vault.updateRows((rows) =>
        rows.filter((r) => !sent.has(r.key) || this.arrivedDuringSync.has(r.key)),
      )
      if (this.vault.rows.some((r) => r.nextAttemptAt <= this.now())) this.touch()
      await this.vault.markSynced(new Date(this.now()).toISOString())
      this.notify()
      return { status: 'acked', sent: records.length }
    } finally {
      this.syncing = false
      this.arrivedDuringSync.clear()
    }
  }

  /**
   * One upsert batch. `'acked'` carries the acknowledged cursor; the other
   * words are the honest reasons a batch did not land (network, refused key,
   * server error) — never an echoed body, which could quote credential
   * material back.
   */
  private async postBatch(
    records: ArchiveRecord[],
    bearer: string,
  ): Promise<{ status: 'acked'; cursor: string } | { status: 'auth' | 'server' | 'offline' }> {
    let res: Response
    try {
      res = await this.post('/sync', { v: 1, cursor: this.vault.cursor, records }, bearer)
    } catch {
      return { status: 'offline' }
    }
    if (res.status === 401 || res.status === 403) return { status: 'auth' }
    if (res.status === 429) return { status: 'offline' }
    if (!res.ok) return { status: 'server' }
    let cursor = this.vault.cursor
    try {
      const body = (await res.json()) as Partial<SyncResponse>
      if (typeof body?.cursor === 'string' && body.cursor !== '') cursor = body.cursor
    } catch {
      /* an unreadable ack body still acked: the batch landed (2xx) */
    }
    return { status: 'acked', cursor }
  }

  // ------------------------------------------------------------- restore

  /**
   * The owner-confirmed restore (spec §2: always a deliberate action): page
   * the archive newest-first, then merge every record by `updated_at`,
   * last-write-wins, through the store's own commit path — nothing newer on
   * the phone is overwritten, nothing the archive does not hold is invented,
   * and no journal event is fabricated.
   */
  async restore(): Promise<RestoreOutcome> {
    if (!this.deps.enabled()) return { status: 'off' }
    if (this.restoring) return { status: 'busy' }
    const key = this.vault.deviceKey
    if (key === '') return { status: 'no_key' }
    if (this.base === '') return { status: 'no_relay' }
    this.restoring = true
    try {
      const records: ArchiveRecord[] = []
      let cursor = ''
      let pages = 0
      let more = false
      for (let page = 0; page < RESTORE_MAX_PAGES; page++) {
        let res: Response
        try {
          res = await this.post('/archive', { v: 1, cursor }, key)
        } catch {
          return { status: 'offline' }
        }
        if (res.status === 401 || res.status === 403) return { status: 'auth' }
        if (!res.ok) return { status: res.status === 429 ? 'offline' : 'server' }
        let body: ArchiveResponse | null = null
        try {
          body = (await res.json()) as ArchiveResponse
        } catch {
          return { status: 'server' }
        }
        if (body === null || !Array.isArray(body.records)) return { status: 'server' }
        const valid = body.records.filter(isArchiveRecord)
        records.push(...valid)
        pages += 1
        cursor = typeof body.cursor === 'string' ? body.cursor : ''
        // Only the relay says the walk is done (an empty cursor). A page
        // whose rows this build cannot read (another version's, or corrupt)
        // is skipped, not taken for the end: the walk goes on, and the cap
        // still reports anything it did not reach.
        if (cursor === '') break
        if (page === RESTORE_MAX_PAGES - 1) more = true
      }
      const feedRows = records.filter((r): r is FeedRecord => r.kind === 'feed')
      let merge: RestoreMerge | undefined
      const commit = await this.deps.store.commit((s) => {
        merge = mergeRestore(s, records)
        return { state: merge.state, events: [] }
      })
      if (merge === undefined) return { status: 'storage' }
      if (commit.ok !== true) {
        return { status: commit.reason === 'storage' || commit.reason === 'broken' ? 'storage' : 'server' }
      }
      // The feed vault keeps its own copy; union by the same key the §7 feed
      // table uses, newest FEED_KEEP entries first.
      const mergedFeed = unionFeed(this.deps.feed.restore(), feedRows)
      if (!(await this.deps.feed.save(mergedFeed))) return { status: 'storage' }
      this.deps.onFeedRestored?.(mergedFeed)
      this.notify()
      return {
        status: 'restored',
        missions: merge.applied,
        chat: merge.chatRestored,
        // The rows the phone now holds, not the rows the archive sent: the
        // feed table is unbounded and pages may overlap, so the raw count
        // would overstate what actually landed on this phone.
        feed: mergedFeed.length,
        tags: merge.tags,
        pages,
        more,
      }
    } finally {
      this.restoring = false
    }
  }

  state(): ArchiveState {
    const now = this.now()
    const rows = this.vault.rows
    const failedRows = rows.filter((r) => r.attempts > 0)
    const nextRetryIn = failedRows.length > 0
      ? Math.max(0, Math.min(...failedRows.map((r) => r.nextAttemptAt)) - now)
      : null
    return {
      enabled: this.deps.enabled(),
      hasKey: this.vault.deviceKey !== '',
      syncing: this.syncing || this.restoring,
      pending: rows.length,
      failed: failedRows.length,
      nextRetryIn,
      lastSyncAt: this.vault.lastSyncAt,
      lastError: this.vault.lastError,
    }
  }

  // ------------------------------------------------------------- private

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** One authenticated POST to a named archive route (spec §6 paths). */
  private post(path: string, body: unknown, bearer: string): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    return this.doFetch(`${this.base}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout))
  }
}

// ------------------------------------------------------------ the merge

export interface RestoreMerge {
  state: SpriiteState
  /** Missions rebuilt from the archive. */
  applied: number
  /** Missions kept because the phone's record was newer or equal. */
  skippedNewer: number
  /** Rows no honest rebuild exists for (a status word or post-id shape this
   *  build does not know): skipped, never guessed at. Missions and tag
   *  receipts both land here. */
  skippedUnknown: number
  /** Missions whose chat history came back. */
  chatRestored: number
  /** Receipts rebuilt from the archive. */
  tags: number
}

/**
 * Merge one archive batch into the phone's durable state. Pure given the
 * state (it runs inside the store's commit mutation, so it always sees the
 * latest committed view). Records merge by `updated_at`, last-write-wins
 * (spec §6): a phone record newer than or equal to the archive's row keeps
 * the phone's — its chat and snapshot with it.
 */
export function mergeRestore(state: SpriiteState, records: ArchiveRecord[]): RestoreMerge {
  const missions = new Map<string, MissionRecord>()
  const chats = new Map<string, ChatRecord[]>()
  const snapshots = new Map<string, SnapshotRecord>()
  const tags = new Map<string, TagRecord>()
  for (const r of records) {
    if (r.kind === 'mission') missions.set(r.mission_id, r)
    else if (r.kind === 'chat') {
      const list = chats.get(r.mission_id)
      if (list === undefined) chats.set(r.mission_id, [r])
      else list.push(r)
    } else if (r.kind === 'snapshot') snapshots.set(r.mission_id, r)
    else if (r.kind === 'tag') tags.set(r.dedupe_key, r)
  }

  const applied: string[] = []
  let skippedNewer = 0
  let skippedUnknown = 0
  const nextMissions = [...state.missions]
  const nextSnapshots: Record<string, unknown> = { ...(state.engineSnapshots ?? {}) }
  for (const row of missions.values()) {
    const phone = state.missions.find((m) => m.missionId === row.mission_id)
    if (phone !== undefined && Date.parse(phone.updatedAt) >= row.updated_at) {
      // The phone's record is newer or equal: it stands whole (§6), chat
      // and snapshot included.
      skippedNewer += 1
      continue
    }
    const nativeStatus = row.status.startsWith('factory_native:')
    const phaseRow = nativeStatus ? { ...row, status: row.status.slice('factory_native:'.length) } : row
    if (!(MISSION_PHASES as readonly string[]).includes(phaseRow.status)) {
      skippedUnknown += 1
      continue
    }
    let archivedRaw: unknown
    try { archivedRaw = JSON.parse(snapshots.get(row.mission_id)?.json ?? 'null') } catch { archivedRaw = null }
    const native = nativeArchive(archivedRaw, row)
    const nativeMarker = nativeStatus || row.execution_backend === 'factory_native' ||
      (archivedRaw !== null && typeof archivedRaw === 'object' &&
        ('nativeArchiveVersion' in archivedRaw || 'nativeCacheVersion' in archivedRaw ||
          ('backend' in archivedRaw && archivedRaw.backend === 'factory_native')))
    // Missing/corrupt native snapshots are not repaired into real-v1 shells.
    // A row may never replace existing backend or provider ownership.
    if ((nativeMarker && !native) ||
      (phone && (phone.config.executionBackend === 'factory_native') !== !!native) ||
      (row.execution_backend === 'legacy' && native)) {
      skippedUnknown += 1
      continue
    }
    const idx = nextMissions.findIndex((m) => m.missionId === row.mission_id)
    const rebuilt = native ? {
      ...missionFromRow(phaseRow, state.entity.entityId),
      config: native.config, originatingCommandId: native.config.nativeIntent!.commandId,
      planRevision: native.config.nativeIntent!.scopeRevision,
      control: native.cache.snapshot.control === 'cancelled' ? 'cancel_requested' as const : native.cache.snapshot.control,
      goal: native.config.nativeIntent!.goal,
    } : missionFromRow(phaseRow, state.entity.entityId)
    if (phone) {
      // Archive is history, not authority to move an existing repository,
      // provider, scope or computer. Its frozen config always stands.
      if (native && (JSON.stringify(phone.config.nativeIntent) !== JSON.stringify(native.config.nativeIntent) ||
        JSON.stringify(phone.config.nativeProfile) !== JSON.stringify(native.config.nativeProfile))) {
        skippedUnknown += 1; continue
      }
      if (native) {
        const local = decodeNativeCache(state.engineSnapshots?.[row.mission_id])
        if (local && (local.pendingWrites.some(x => ['prepared', 'invoked', 'unknown'].includes(x.receipt.state)) ||
          local.snapshot.attention.some(a => a.state !== 'resolved') ||
          native.cache.snapshot.brokerSeq < local.snapshot.brokerSeq ||
          (local.prepareReceipt && ['prepared', 'invoked', 'unknown'].includes(local.prepareReceipt.state)))) {
          skippedNewer += 1; continue
        }
        if (local?.snapshot.binding && JSON.stringify(local.snapshot.binding) !== JSON.stringify(native.cache.snapshot.binding)) {
          skippedUnknown += 1; continue
        }
      }
      rebuilt.config = phone.config
      rebuilt.originatingCommandId = phone.originatingCommandId
    }
    if (native) nextSnapshots[row.mission_id] = { ...native.cache, imported: true }
    if (idx === -1) nextMissions.push(rebuilt)
    else nextMissions[idx] = rebuilt
    applied.push(row.mission_id)
  }

  let chatRestored = 0
  for (const missionId of applied) {
    if (nextMissions.find(m => m.missionId === missionId)?.config.executionBackend === 'factory_native') {
      chatRestored += 1
      continue
    }
    // The chat table's rows key by (mission_id, seq): pages may overlap, so
    // the row with the highest `at` per seq is the one kept — never a
    // duplicate entry in a restored tail.
    const bySeq = new Map<number, ChatRecord>()
    for (const c of chats.get(missionId) ?? []) {
      const prior = bySeq.get(c.seq)
      if (prior === undefined || c.at >= prior.at) bySeq.set(c.seq, c)
    }
    const chat = [...bySeq.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((c) => validChatEntry(c))
      .filter((e): e is ChatTailEntry => e !== null)
      .slice(-ARCHIVE_CHAT_KEEP)
    if (chat.length === 0 && !snapshots.has(missionId)) continue
    const snap = snapshotForRestore(snapshots.get(missionId), missions.get(missionId)!, chat)
    if (snap === null) continue
    nextSnapshots[missionId] = snap
    chatRestored += 1
  }

  let tagsApplied = 0
  const receiptsByKey = new Map((state.xIntake?.receipts ?? []).map((r) => [r.dedupeKey, r]))
  for (const row of tags.values()) {
    // The store's own receipt validation requires the ids X issues
    // (src/domain/state.ts isNumericId). A row whose ids are not numeric
    // cannot be rebuilt honestly, and rebuilding it anyway would fail the
    // commit's validation and reject the WHOLE restore — every record the
    // walk fetched, unapplied, while the owner reads a generic failure. One
    // hostile or corrupt row is skipped and counted, never a poisoned merge.
    if (!isNumericPostId(row.logical_post_id) || !isNumericPostId(row.revision_id)) {
      skippedUnknown += 1
      continue
    }
    const phone = receiptsByKey.get(row.dedupe_key)
    const archived = receiptFromRow(row)
    const newest = phone !== undefined && Date.parse(phone.receivedAt) >= row.received_at ? phone : archived
    const deleted = [phone?.deletedAt, archived.deletedAt].filter((v): v is string => v !== undefined)
    const proposed = [phone?.proposedRevisionId, archived.proposedRevisionId]
      .filter((v): v is string => v !== undefined && isNumericPostId(v))
      .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)
    const merged = {
      ...newest,
      ...(deleted.length > 0 ? { deletedAt: deleted.sort((a, b) => Date.parse(a) - Date.parse(b))[0] } : {}),
      ...(proposed.length > 0 ? { proposedRevisionId: proposed[proposed.length - 1] } : {}),
    }
    if (phone !== undefined && JSON.stringify(phone) === JSON.stringify(merged)) continue
    receiptsByKey.set(row.dedupe_key, merged)
    tagsApplied += 1
  }
  let nextIntake = state.xIntake
  if (tagsApplied > 0) {
    nextIntake = {
      ...(nextIntake ?? emptyXIntake()),
      receipts: [...receiptsByKey.values()],
    }
  }

  return {
    state: {
      ...state,
      missions: nextMissions,
      engineSnapshots: nextSnapshots,
      ...(tagsApplied > 0 ? { xIntake: nextIntake } : {}),
    },
    applied: applied.length,
    skippedNewer,
    skippedUnknown,
    chatRestored,
    tags: tagsApplied,
  }
}

/**
 * The engine snapshot a restored mission carries: the archive's own opaque
 * copy when it has one (the same `real`/`v` guard engineSnapshotFor applies —
 * anything else is refused, never repaired), else the minimal honest shell
 * that holds the history and claims nothing else: no session, no progress,
 * no live run.
 */
function snapshotForRestore(
  row: SnapshotRecord | undefined,
  mission: MissionRecord,
  chat: ChatTailEntry[],
): RealSnapshot | null {
  let snap: RealSnapshot | null = null
  if (row !== undefined) {
    try {
      const parsed = JSON.parse(row.json) as RealSnapshot
      if (parsed !== null && typeof parsed === 'object' &&
        ('backend' in parsed || 'nativeCacheVersion' in parsed || 'nativeArchiveVersion' in parsed)) return null
      if (parsed !== null && typeof parsed === 'object' && parsed.real === true && parsed.v === 1) snap = parsed
    } catch {
      snap = null
    }
  }
  if (snap === null) snap = shellSnapshot(mission, chat)
  // The chat table is the history of record (§7); the snapshot's own tail is
  // whatever the phone kept when it synced. The archived rows win when they
  // exist, and never drop what the shell was built to carry.
  return { ...snap, chat: chat.length > 0 ? chat : snap.chat ?? [] }
}

/** The same shape initialXIntake() builds (src/intake/x.ts), kept inline so
 *  this module stays free of runtime imports. */
function emptyXIntake(): NonNullable<SpriiteState['xIntake']> {
  return {
    binding: null,
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastReceivedAt: null,
    lastReceivedPostId: null,
    receipts: [],
    gaps: [],
    rejectedCount: 0,
  }
}

/**
 * `new Date(ms).toISOString()` never throws here: an archive row whose epoch
 * is non-finite or past Date's range (a corrupt or hostile page) reads as the
 * epoch instead of raising a RangeError out of the merge — a bad row is
 * skipped or clamped, never a restore that dies mid-page with a generic
 * failure while the records it did fetch go unapplied.
 */
function epochIso(ms: number): string {
  const t = new Date(ms)
  return Number.isNaN(t.getTime()) ? new Date(0).toISOString() : t.toISOString()
}

/**
 * The numeric ids X issues, the same rule the store's receipt validation
 * applies (src/domain/state.ts isNumericId). Kept inline: this module's only
 * runtime imports are dependency-free state modules, and a predicate is
 * cheaper to duplicate than a dependency to add.
 */
function isNumericPostId(v: string): boolean {
  return /^\d{1,20}$/.test(v)
}

/**
 * The rebuilt receipt. The §7 tags table carries the post's own ids and the
 * arrival path (logical_post_id, revision_id, via), so those come back as
 * the receipt's own values, never placeholders. The fields it still does not
 * carry get explicit not-recorded values that still pass the store's own
 * receipt validation: no conversation id. Legacy rows retain received time
 * as a display placeholder explicitly marked untrusted; confirmation must
 * not use it as the publication-time boundary.
 */
function receiptFromRow(row: TagRecord): XIntakeReceipt {
  const receivedAt = epochIso(row.received_at)
  return {
    dedupeKey: row.dedupe_key,
    logicalPostId: row.logical_post_id,
    revisionId: row.revision_id,
    conversationId: null,
    status: row.status as XIntakeReceipt['status'],
    instruction: row.instruction,
    postedAt: row.posted_at != null ? epochIso(row.posted_at) : receivedAt,
    ...(row.posted_at == null ? { postedAtTrusted: false } : {}),
    receivedAt,
    via: row.via,
    ...(row.repository !== '' ? { repository: row.repository } : {}),
    ...(row.mission_id !== '' ? { missionId: row.mission_id } : {}),
    // The late columns are nullable on the wire (a relay row written before
    // the migration restores as null): null is absence, never a zero epoch
    // that would read as deleted in 1970 or an id the post never had.
    ...(row.deleted_at != null ? { deletedAt: epochIso(row.deleted_at) } : {}),
    ...(row.proposed_revision_id != null && isNumericPostId(row.proposed_revision_id)
      ? { proposedRevisionId: row.proposed_revision_id } : {}),
  }
}

/**
 * The rebuilt mission record. The archive carries the §7 columns; the fields
 * around them are the runtime's own machinery and get their honest
 * placeholders: unknown freshness (nothing was observed on this phone),
 * never-observed timestamps, and `archive:<id>` naming where the record came
 * from. A restored LIVE mission lands paused: resuming a build spends
 * credits, so it is as deliberate as the restore itself (spec §2).
 */
function missionFromRow(row: MissionRecord, entityId: string): Mission {
  const phase = row.status as MissionPhase
  return {
    schemaVersion: 2,
    missionId: row.mission_id,
    entityId,
    productId: 'default',
    originatingCommandId: `archive:${row.mission_id}`,
    title: row.title,
    goal: row.goal,
    phase,
    control: isTerminalPhase(phase) ? 'running' : 'paused',
    freshness: 'unknown',
    suspendedPhase: null,
    planRevision: 1,
    config: {
      executionBackend: 'legacy',
      leadProvider: 'factory',
      workerProviders: ['factory'],
      maxConcurrentWorkers: 1,
      repository: row.repo,
      baseRef: 'main',
      // The supervisor's DEFAULT_POLICY_REVISION ('v2-default'); kept inline
      // so this module pulls no runtime imports.
      policyRevision: 'v2-default',
      workerPreference: 'auto',
    },
    activeRunIds: [],
    decisionIds: [],
    lastAppliedSeq: 0,
    lastObservedAt: null,
    createdAt: epochIso(row.created_at),
    updatedAt: epochIso(row.updated_at),
  }
}

/**
 * The minimal snapshot a mission restored with chat rows but no engine
 * snapshot gets. It passes the guards both restores apply (`real`/`v`, a
 * jobs array), carries the history, and claims nothing else.
 */
function shellSnapshot(mission: MissionRecord, chat: ChatTailEntry[]): RealSnapshot {
  return {
    v: 1,
    real: true,
    phase: 'final',
    goal: mission.goal,
    capturedSec: 0,
    repoUrl: mission.repo,
    missionRepo: mission.repo,
    missionComputerId: null,
    blockedStart: null,
    sessionId: null,
    awaiting: null,
    workerPref: 'auto',
    jobCount: 1,
    askBeforePr: false,
    attach: null,
    jobs: [],
    chat,
    reviewQueue: [],
    verdictJob: null,
    integrating: false,
    decisionPending: false,
    decisionText: '',
    decisionOptions: [],
    decisionGate: false,
    decisionKind: 'build',
    planLabels: [],
    milestones: [],
    prUrl: '',
    lastReply: '',
    failReason: '',
    finalSummary: '',
    repairCount: 0,
    seenMessageIds: [],
    messageCount: 0,
    faultKind: null,
    faultSource: null,
    faultDetail: '',
    faultRetry: null,
    faultRetryIndex: null,
    lastSteer: '',
    lastDecision: '',
    repoName: '',
    seq: 0,
  }
}

/** Union the phone's feed with the archive's by the §7 feed key (at, label,
 *  text), newest FEED_KEEP entries first. */
export function unionFeed(entries: readonly FeedEntry[], rows: readonly FeedRecord[]): FeedEntry[] {
  const byKey = new Map<string, FeedEntry>()
  for (const e of entries) byKey.set(`${e.at}\u0000${e.label}\u0000${e.text}`, e)
  for (const r of rows) byKey.set(`${r.at}\u0000${r.label}\u0000${r.text}`, { at: r.at, label: r.label, text: r.text })
  return [...byKey.values()].sort((a, b) => b.at - a.at).slice(0, FEED_KEEP)
}

/**
 * A record the wire may carry: each kind's own shape, everything else
 * dropped (a server that sends a malformed row never crashes the restore,
 * and never gets its row repaired into a guess). Epoch fields must be finite
 * numbers: JSON happily decodes 1e999 into Infinity, and a non-finite epoch
 * poisons every date math and sort the merge does.
 */
export function isArchiveRecord(raw: unknown): raw is ArchiveRecord {
  if (raw === null || typeof raw !== 'object') return false
  const r = raw as Record<string, unknown>
  switch (r.kind) {
    case 'mission':
      return (
        typeof r.mission_id === 'string' && r.mission_id !== '' &&
        typeof r.title === 'string' && typeof r.goal === 'string' &&
        typeof r.status === 'string' && typeof r.repo === 'string' &&
        (r.origin === 'phone' || r.origin === 'x') &&
        typeof r.created_at === 'number' && Number.isFinite(r.created_at) &&
        typeof r.updated_at === 'number' && Number.isFinite(r.updated_at)
        && (r.execution_backend === undefined || r.execution_backend === 'legacy' || r.execution_backend === 'factory_native')
      )
    case 'chat':
      return (
        typeof r.mission_id === 'string' && r.mission_id !== '' &&
        typeof r.seq === 'number' && Number.isInteger(r.seq) && r.seq >= 0 &&
        isChatWho(r.who) &&
        typeof r.text === 'string' &&
        typeof r.at === 'number' && Number.isFinite(r.at)
      )
    case 'feed':
      return (
        typeof r.at === 'number' && Number.isFinite(r.at) &&
        typeof r.label === 'string' && typeof r.text === 'string'
      )
    case 'tag':
      return (
        typeof r.dedupe_key === 'string' && r.dedupe_key.startsWith('x:') &&
        typeof r.logical_post_id === 'string' && r.logical_post_id !== '' &&
        typeof r.revision_id === 'string' && r.revision_id !== '' &&
        (r.via === 'catch_up' || r.via === 'stream' || r.via === 'import') &&
        typeof r.status === 'string' && (X_RECEIPT_STATUSES as readonly string[]).includes(r.status) &&
        typeof r.instruction === 'string' &&
        typeof r.repository === 'string' && typeof r.mission_id === 'string' &&
        typeof r.received_at === 'number' && Number.isFinite(r.received_at) &&
        // The late §7 columns are optional both ways: a relay row written
        // before the migration carries neither, and sqlite answers NULL for
        // them — null is a live post with no proposed change, never a row
        // the restore would drop over a column it does not know yet.
        (r.posted_at === undefined || r.posted_at === null || (typeof r.posted_at === 'number' && Number.isSafeInteger(r.posted_at) && Math.abs(r.posted_at) <= 8.64e15)) &&
        (r.deleted_at === undefined || r.deleted_at === null || (typeof r.deleted_at === 'number' && Number.isFinite(r.deleted_at))) &&
        (r.proposed_revision_id === undefined || r.proposed_revision_id === null || typeof r.proposed_revision_id === 'string')
      )
    case 'snapshot':
      return (
        typeof r.mission_id === 'string' && r.mission_id !== '' &&
        typeof r.json === 'string' &&
        typeof r.updated_at === 'number' && Number.isFinite(r.updated_at)
      )
    default:
      return false
  }
}

function nativeArchiveConfig(raw: unknown): MissionConfig | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as MissionConfig
  const intent = decodeNativeIntent(r.nativeIntent)
  const profile = decodeNativeProfile(r.nativeProfile)
  if (r.executionBackend !== 'factory_native' || r.nativeQuarantine || !intent || !profile ||
    typeof r.policyRevision !== 'string' || intent.ownerId !== profile.ownerId ||
    intent.workspace.machineId !== profile.machineId || !nativeIntentMatchesProfile(profile, intent) ||
    intent.workspace.baseRef !== profile.baseRef || r.repository !== intent.workspace.repository ||
    r.baseRef !== intent.workspace.baseRef) return null
  return { executionBackend: 'factory_native', nativeIntent: intent, nativeProfile: profile,
    leadProvider: 'factory', workerProviders: ['factory'], workerPreference: 'factory', maxConcurrentWorkers: 1,
    repository: intent.workspace.repository, baseRef: intent.workspace.baseRef, policyRevision: r.policyRevision }
}
function nativeArchive(raw: unknown, row: MissionRecord): { config: MissionConfig; cache: NativeMissionCache } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { nativeArchiveVersion?: unknown; backend?: unknown; config?: unknown; cache?: unknown }
  const config = nativeArchiveConfig(r.config)
  const cache = decodeNativeCache(r.cache)
  if (r.nativeArchiveVersion !== 1 || r.backend !== 'factory_native' || !config || !cache ||
    config.nativeIntent!.missionId !== row.mission_id || config.nativeIntent!.goal !== row.goal ||
    config.repository !== row.repo || cache.snapshot.missionId !== row.mission_id ||
    cache.snapshot.ownerId !== config.nativeIntent!.ownerId ||
    cache.snapshot.scopeRevision !== config.nativeIntent!.scopeRevision ||
    (cache.snapshot.binding && (cache.snapshot.binding.machineId !== config.nativeIntent!.workspace.machineId ||
      cache.snapshot.binding.cwd !== config.nativeIntent!.workspace.cwd ||
      cache.snapshot.binding.repository !== config.repository || cache.snapshot.binding.baseRef !== config.baseRef))) return null
  return { config, cache }
}

/**
 * Merge incoming queue rows into the existing ones: a known key keeps its
 * slot and gets the earliest of its own next attempt and `now` (a re-queued
 * key after a failure is due again — newer content deserves a fresh chance,
 * not the old penalty); a new key joins due immediately. The bound evicts
 * the longest-queued key (its record re-queues the next time it changes).
 */
function mergeOutboxRows(existing: OutboxRow[], incoming: OutboxRow[], now: number): OutboxRow[] {
  if (incoming.length === 0) return existing
  const byKey = new Map(existing.map((r) => [r.key, r]))
  for (const row of incoming) {
    const prior = byKey.get(row.key)
    byKey.set(
      row.key,
      prior === undefined
        ? row
        : { ...prior, nextAttemptAt: Math.min(prior.nextAttemptAt, now) },
    )
  }
  const next = [...byKey.values()]
  while (next.length > OUTBOX_MAX) next.shift()
  return next
}

/** Row-identity compare for the enqueue guard (no vault write when the queue
 *  did not actually change). */
function sameRows(a: OutboxRow[], b: OutboxRow[]): boolean {
  if (a.length !== b.length) return false
  return a.every((row, i) => row.key === b[i].key && row.attempts === b[i].attempts && row.nextAttemptAt === b[i].nextAttemptAt)
}
