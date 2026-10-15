/**
 * MissionStore (Persistent Companion spec §8): a durable, crash-consistent
 * commit layer over an untransactional string KV — the SDK's companion-app
 * storage, which offers neither multi-key transactions nor compare-and-swap.
 *
 * Commit contract: one commit is one versioned envelope — the state
 * mutation, its events, the outbox entries and the consumed provider
 * cursors all live in the envelope's state — and a commit is either
 * recoverably present in full or absent. Durability order per commit:
 *
 *   1. chunk writes    <ns>.slot.<a|b>.<i>   envelope JSON, bounded pieces
 *   2. manifest write   <ns>.slot.<a|b>.m    { v, seq, chunks, checksum }
 *   3. head write       <ns>.head            { v, slot, seq } — advisory
 *
 * The manifest is written after its chunks, so a torn mid-write fails the
 * slot's checksum and recovery falls back to the other slot's last
 * complete envelope. The head is only a hint: recovery validates BOTH
 * slots and picks the newest valid sequence, so a torn pointer can never
 * discard a complete valid checkpoint (spec §8). A checksum proves the
 * integrity of what was written; it is not proof the host persisted an
 * unacknowledged write — that guarantee is qualified by the Phase 0 probe
 * and, ultimately, on hardware.
 *
 * Writes are serialized through one queue (single writer). A failed write
 * marks the store broken: no commit may build on state that might have
 * partially landed. reload() revalidates the KV — if the failed write
 * actually landed, the newer valid envelope wins and is adopted. Nothing
 * outside the store observes a commit until it is acked, so a crash
 * between the slot write and the ack recovers the same durable commit
 * exactly once.
 */
import { nowIso } from '../domain/ids'
import type { DomainEvent } from '../domain/types'
import type { EventDraft } from '../domain/events'

export const CHECKPOINT_NAMESPACE = 'spriite.runtime.v2'
/** Max chars per KV write; sized against the Phase 0 probe's observations. */
export const DEFAULT_CHUNK_CHARS = 40_000
/** Bounded recent-event window carried in each envelope (spec §9 compaction). */
export const DEFAULT_EVENT_WINDOW = 200
/**
 * Hard ceiling for held-back unseen events (§9: bounded envelopes). Sized as
 * a byte budget, not a policy: at roughly 0.4 KB per event this keeps an
 * envelope near 250 KB even when nothing has been acknowledged, while still
 * holding far more history than a run produces. Past it, held events ARE
 * evicted, the store records a warning, and the briefing names the gap.
 */
export const DEFAULT_MAX_EVENT_WINDOW = 600

export type SlotName = 'a' | 'b'

/** Definitively missing → null. A transport failure must throw, never read
 *  as absence (an unknown read is not a missing key, spec §8). */
export interface KVBackend {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<boolean>
}

/** The full commit payload: next state plus the events this commit records. */
export interface CommitPayload<S> {
  state: S
  events: EventDraft[]
}

/** A pure mutation: null rejects the commit (validation failed) and nothing
 *  changes — the state it receives is a private clone it may edit freely. */
export type Mutation<S> = (state: S) => CommitPayload<S> | null

export interface CommitEnvelope {
  v: 2
  seq: number
  eventSeq: number
  createdAt: string
  state: unknown
  events: DomainEvent[]
  checksum: string
}

export interface LoadResult {
  /** fresh = nothing durable yet; checkpoint = restored from a valid
   *  envelope; corruption = raw data existed but no valid envelope. */
  origin: 'fresh' | 'checkpoint' | 'corruption'
  seq: number
  warnings: string[]
}

export type CommitResult = { ok: true; seq: number } | { ok: false; reason: 'rejected' | 'broken' | 'storage' }

interface SlotCandidate {
  slot: SlotName
  env: CommitEnvelope
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface MissionStoreOptions<S> {
  initial(): S
  validateState(raw: unknown): S | null
  namespace?: string
  chunkChars?: number
  eventWindow?: number
  /**
   * The event window is the retention compaction (spec §9), and compaction
   * "preserves briefing coverage": events the owner has not yet acknowledged
   * are held back from eviction past the normal window. This reads the
   * coverage watermark (journal seq) off the state; events with a higher seq
   * are held up to `maxEventWindow` regardless of the soft window size.
   * A watermark of 0 holds EVERYTHING (nothing acknowledged yet); omit the
   * option to hold nothing.
   */
  holdEventsAfter?: (state: S) => number
  /**
   * Hard ceiling for the held-back window; beyond it events ARE evicted
   * (unbounded envelopes are their own failure) and the briefing builder
   * labels the gap honestly. Raised to at least `eventWindow`: the ceiling
   * can never make the window smaller than the soft size promises.
   */
  maxEventWindow?: number
  /**
   * Called inside the commit queue after each commit that landed, with the
   * state before and after it. The archive mirror's only durable-write
   * trigger (VPS-ARCHIVE-SPEC §6): absent by default, and a throw inside it
   * can never change the commit's outcome — the record is already durable.
   */
  observe?: (prev: S, next: S) => void
}

export class MissionStore<S> {
  private state: S
  private seq = 0
  private eventSeq = 0
  private window: DomainEvent[] = []
  private lastSlot: SlotName = 'b' // the first commit writes slot a
  private broken = false
  private loaded = false
  private queue: Promise<unknown> = Promise.resolve()
  private warnings: string[] = []
  private readonly kv: KVBackend
  private readonly initial: () => S
  private readonly validateState: (raw: unknown) => S | null
  private readonly ns: string
  private readonly chunkChars: number
  private readonly windowSize: number
  private readonly holdEventsAfter: (state: S) => number
  private readonly maxWindow: number
  private readonly observe: ((prev: S, next: S) => void) | undefined

  constructor(kv: KVBackend, opts: MissionStoreOptions<S>) {
    this.kv = kv
    this.initial = opts.initial
    this.validateState = opts.validateState
    this.ns = opts.namespace ?? CHECKPOINT_NAMESPACE
    this.chunkChars = opts.chunkChars ?? DEFAULT_CHUNK_CHARS
    this.windowSize = opts.eventWindow ?? DEFAULT_EVENT_WINDOW
    this.holdEventsAfter = opts.holdEventsAfter ?? (() => Number.POSITIVE_INFINITY)
    this.observe = opts.observe
    // The ceiling is a hard bound: an explicitly configured ceiling below the
    // soft window wins, and the soft window is clamped to it. A soft window
    // larger than the ceiling would be a contradiction (the ceiling is what
    // actually bounds the envelope), so the smaller number is the honest one.
    this.maxWindow = opts.maxEventWindow ?? DEFAULT_MAX_EVENT_WINDOW
    this.windowSize = Math.min(this.windowSize, this.maxWindow)
    this.state = opts.initial()
  }

  get current(): S {
    return this.state
  }

  get events(): readonly DomainEvent[] {
    return this.window
  }

  get checkpointSeq(): number {
    return this.seq
  }

  get journalSeq(): number {
    return this.eventSeq
  }

  get durability(): 'ok' | 'broken' {
    return this.broken ? 'broken' : 'ok'
  }

  get lastWarnings(): string[] {
    return this.warnings
  }

  private key(slot: SlotName, part: number | 'm'): string {
    return `${this.ns}.slot.${slot}.${part}`
  }

  private headKey(): string {
    return `${this.ns}.head`
  }

  /**
   * Validate both slots and restore the newest complete valid envelope.
   * Never trusts the head pointer as authority (spec §8); a torn or stale
   * head cannot discard a valid checkpoint.
   */
  async load(): Promise<LoadResult> {
    const [a, b] = await Promise.all([this.readSlot('a'), this.readSlot('b')])
    const candidates: SlotCandidate[] = []
    if (a) candidates.push({ slot: 'a', env: a })
    if (b) candidates.push({ slot: 'b', env: b })
    if (candidates.length === 0) {
      const rawExisted = await this.anyManifestRaw()
      this.state = this.initial()
      this.seq = 0
      this.eventSeq = 0
      this.window = []
      this.lastSlot = 'b'
      this.broken = false
      this.loaded = true
      this.warnings = rawExisted ? ['all checkpoints unreadable; starting fresh'] : []
      return { origin: rawExisted ? 'corruption' : 'fresh', seq: 0, warnings: this.warnings }
    }
    let best = candidates[0]
    if (candidates.length > 1 && candidates[0].env.seq === candidates[1].env.seq) {
      // Same-seq ties cannot arise from serial commits; break by head hint.
      const head = await this.readHead()
      best = candidates.find((c) => c.slot === head?.slot) ?? candidates.find((c) => c.slot === 'a') ?? best
    } else {
      for (const c of candidates) if (c.env.seq > best.env.seq) best = c
    }
    const env = best.env
    this.state = env.state as S
    this.seq = env.seq
    this.eventSeq = env.eventSeq
    this.window = env.events
    this.lastSlot = best.slot
    this.broken = false
    this.loaded = true
    this.warnings = []
    return { origin: 'checkpoint', seq: env.seq, warnings: [] }
  }

  /** Revalidate from the KV after a broken write; adopts the newest valid
   *  envelope (including a write that failed its ack but landed). */
  async reload(): Promise<LoadResult> {
    return this.load()
  }

  /**
   * Commit one mutation durably. Serialized: callers can fire commits
   * concurrently; they apply in order, each against the prior commit's
   * state. Returns only after the envelope is acknowledged by the host —
   * before that, the commit does not exist for any caller.
   */
  commit(mutation: Mutation<S>): Promise<CommitResult> {
    const run = async (): Promise<CommitResult> => {
      if (this.broken) return { ok: false, reason: 'broken' }
      if (!this.loaded) {
        // Never derive an envelope from unloaded memory: committing before
        // load would write a seq-1 envelope over a possibly-newer valid
        // slot and ack a commit recovery would discard — destroying the
        // newest checkpoint (spec §8). Loading here is safe: we are inside
        // the serialized queue, and the mutation still applies on top of
        // the durable state it should see.
        // A transport failure during the read is a durability failure, not
        // an absence: the store stops rather than committing blind.
        try {
          await this.load()
        } catch {
          this.broken = true
          return { ok: false, reason: 'storage' }
        }
      }
      const previous = this.state
      const draft = mutation(structuredClone(this.state))
      if (draft === null || draft === undefined) return { ok: false, reason: 'rejected' }
      // The state that goes into the envelope must survive the SAME validation
      // recovery applies: a state that fails it would be written, acked, and
      // then rejected on the next boot — silently discarding this commit and
      // every later one while the runtime believed they landed (spec §8).
      if (this.validateState(draft.state) === null) return { ok: false, reason: 'rejected' }
      const events: DomainEvent[] = draft.events.map((e, i) => ({
        schemaVersion: 2,
        eventId: e.eventId,
        seq: this.eventSeq + 1 + i,
        entityId: e.entityId,
        missionId: e.missionId,
        type: e.type,
        observedAt: e.observedAt,
        occurredAt: e.occurredAt,
        causalCommandId: e.causalCommandId,
        providerEventId: e.providerEventId,
        payload: e.payload,
      }))
      const combined = [...this.window, ...events]
      // Retention compaction (spec §9): keep the soft window, but never
      // evict an event the owner has not acknowledged (briefing coverage)
      // until the hard ceiling. A gap above the ceiling is labeled honestly
      // by the briefing builder, never silently skipped.
      const holdAfter = this.holdEventsAfter(draft.state)
      let cut = Math.max(0, combined.length - this.windowSize)
      const firstHeld = combined.findIndex((e) => e.seq > holdAfter)
      if (firstHeld !== -1) cut = Math.min(cut, firstHeld)
      // The ceiling is a floor on the cut: past it, held events are evicted.
      cut = Math.max(cut, combined.length - this.maxWindow)
      if (firstHeld !== -1 && cut > firstHeld) {
        // Never silent (§9): the owner is told about the gap by the briefing
        // builder, and the operator can see that storage pressure is real.
        // One line, not one per commit.
        const note = `event window ceiling reached (${this.maxWindow}): unacknowledged events were evicted`
        if (!this.warnings.includes(note)) this.warnings.push(note)
      }
      const window = combined.slice(cut)
      const env: CommitEnvelope = {
        v: 2,
        seq: this.seq + 1,
        eventSeq: this.eventSeq + draft.events.length,
        createdAt: nowIso(),
        state: draft.state,
        events: window,
        checksum: '',
      }
      env.checksum = await sha256Hex(JSON.stringify({ ...env, checksum: undefined }))
      const slot: SlotName = this.lastSlot === 'a' ? 'b' : 'a'
      // A transport failure that THROWS is the same durability failure as a
      // `false` return (the KVBackend contract says a failed read throws, and
      // a failed write may do either): the store stops, and the caller gets a
      // typed result instead of an exception it cannot classify (§8/§24).
      let wrote = false
      try {
        wrote = await this.writeEnvelope(slot, env)
      } catch {
        wrote = false
      }
      if (!wrote) {
        // The envelope may or may not have landed; never build on top of
        // uncertain storage. The durability failure is caller-visible.
        this.broken = true
        return { ok: false, reason: 'storage' }
      }
      // Durable ack: only now does the commit exist for callers.
      this.state = draft.state
      this.seq = env.seq
      this.eventSeq = env.eventSeq
      this.window = window
      this.lastSlot = slot
      if (this.observe !== undefined) {
        // The commit is already durable and its result decided, so the
        // observer may not change either: a mirror enqueue that throws is
        // swallowed here, never surfaced as a commit failure (§8 honesty —
        // a landed record must not read as rejected).
        try {
          this.observe(previous, draft.state)
        } catch {
          /* the observer's own failure is its to report, not the store's */
        }
      }
      try {
        const headOk = await this.kv.set(this.headKey(), JSON.stringify({ v: 2, slot, seq: env.seq }))
        if (!headOk) console.warn('[store] head pointer write failed (advisory; slots stay authoritative)')
      } catch {
        // The head is advisory only: recovery validates both slots, so a
        // failed pointer write cannot lose the commit we just acked.
        console.warn('[store] head pointer write threw (advisory; slots stay authoritative)')
      }
      return { ok: true, seq: this.seq }
    }
    const out = this.queue.then(run, run)
    this.queue = out.catch(() => undefined)
    return out
  }

  /** Resolves once every commit queued so far has finished, either way. */
  settled(): Promise<void> {
    return this.queue.then(() => undefined)
  }

  private async writeEnvelope(slot: SlotName, env: CommitEnvelope): Promise<boolean> {
    const json = JSON.stringify(env)
    const chunks: string[] = []
    for (let i = 0; i < json.length; i += this.chunkChars) chunks.push(json.slice(i, i + this.chunkChars))
    for (let i = 0; i < chunks.length; i++) {
      if (!(await this.kv.set(this.key(slot, i), chunks[i]))) return false
    }
    const manifest = JSON.stringify({
      v: 2,
      seq: env.seq,
      chunks: chunks.length,
      checksum: env.checksum,
      createdAt: env.createdAt,
    })
    return this.kv.set(this.key(slot, 'm'), manifest)
  }

  /** Validate one slot end-to-end: manifest shape, chunk count, envelope
   *  shape, checksum, and state validation. Any failure → null (the other
   *  slot decides recovery). */
  private async readSlot(slot: SlotName): Promise<CommitEnvelope | null> {
    const mRaw = await this.kv.get(this.key(slot, 'm'))
    if (mRaw === null) return null
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(mRaw) as Record<string, unknown>
    } catch {
      return null
    }
    if (
      !manifest ||
      manifest.v !== 2 ||
      typeof manifest.seq !== 'number' ||
      typeof manifest.checksum !== 'string' ||
      typeof manifest.chunks !== 'number' ||
      manifest.chunks < 1
    ) {
      return null
    }
    const pieces: string[] = []
    for (let i = 0; i < manifest.chunks; i++) {
      const part = await this.kv.get(this.key(slot, i))
      if (part === null) return null // missing chunk: slot incomplete
      pieces.push(part)
    }
    let env: Record<string, unknown>
    try {
      env = JSON.parse(pieces.join('')) as Record<string, unknown>
    } catch {
      return null
    }
    if (
      !env ||
      env.v !== 2 ||
      env.seq !== manifest.seq ||
      typeof env.eventSeq !== 'number' ||
      !Array.isArray(env.events) ||
      typeof env.checksum !== 'string'
    ) {
      return null
    }
    const checksum = env.checksum as string
    delete env.checksum
    const expected = await sha256Hex(JSON.stringify(env))
    if (checksum !== expected) return null
    const state = this.validateState(env.state)
    if (state === null) return null
    return { ...(env as unknown as CommitEnvelope), state, checksum }
  }

  private async readHead(): Promise<{ slot: SlotName; seq: number } | null> {
    const raw = await this.kv.get(this.headKey())
    if (raw === null) return null
    try {
      const h = JSON.parse(raw) as Record<string, unknown>
      if (!h || h.v !== 2) return null
      const slot = h.slot === 'a' || h.slot === 'b' ? (h.slot as SlotName) : null
      if (slot === null || typeof h.seq !== 'number') return null
      return { slot, seq: h.seq }
    } catch {
      return null
    }
  }

  private async anyManifestRaw(): Promise<boolean> {
    const a = await this.kv.get(this.key('a', 'm'))
    if (a !== null) return true
    const b = await this.kv.get(this.key('b', 'm'))
    return b !== null
  }
}
