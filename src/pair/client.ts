/**
 * The phone's pairing client (docs/design/REDESIGN-PLAN.md C5,
 * docs/design/PAIRING-PROTOCOL.md): claims a `spriite pair` session, opens
 * the PAKE-encrypted PairingBundle and writes it into the vaults; offers and
 * receives "Move to another phone" transfers; draws QR codes; and drives the
 * host-run X sign-in on the paired computer.
 *
 * Every vault write goes through the existing setters (same validation, same
 * serialized storage queue). Nothing here logs, and no error carries a key.
 */
import type { KeyVault } from '../voice/keys'
import type { PrefsVault } from '../state/prefs'
import { FEED_KEEP, type FeedEntry, type FeedVault } from '../state/feed'
import type { NativeLaunchProfile } from '../native/protocol'
import { canonicalBrokerUrl } from '../native/decode'
import {
  PAIR_BODY_MAX, PAIR_TTL_MS, createRelayClient, formatPairCode, formatTransferCode, joinSession,
  normalizePairCode, normalizeTransferCode, openHostSession, parseQr, qrMatrix, type Sleep,
} from '../../broker/pair-protocol.mjs'
import type {
  ApplyResult, HostXSignInState, MoveBundle, PairFailure, PairingBundle, PairingClient, PairedHost, RunOn,
  TransferFailure, TransferOfferResult, TransferReceiveOutcome,
} from './types'

const ENV = (import.meta as { env?: { DEV?: boolean; VITE_SPRIITE_RELAY?: string } }).env
const RELAY = (ENV?.VITE_SPRIITE_RELAY ?? '').replace(/\/+$/, '')
/** Same-origin in dev (vite proxies /api/pair to the dev relay); the built relay otherwise. */
export const DEFAULT_PAIR_BASE = ENV?.DEV ? '/api/pair/v1' : RELAY ? `${RELAY}/pair/v1` : ''

/** Build history a move may carry, when the phone shell provides it (optional). */
export interface HistoryPort {
  /** The records to move (null = none); must not contain credentials. */
  export(): unknown | Promise<unknown>
  /** How many builds the export holds (the Move summary). */
  count(): number
  import(history: unknown): Promise<boolean>
}

/** The archive mirror's device key: moving it lets the new phone restore from the relay archive. */
export interface ArchiveKeyPort {
  readonly deviceKey: string
  adoptDeviceKey(key: string): Promise<boolean>
}

export interface PairingClientDeps {
  keys: KeyVault
  prefs: PrefsVault
  feed: FeedVault
  relayBase?: string
  fetchImpl?: typeof fetch
  now?: () => number
  /** Optional: build history and the archive key for "Move to another phone". */
  history?: HistoryPort
  archive?: ArchiveKeyPort
  /** Test seams. */
  sleep?: Sleep
  pollMs?: number
}

// ---------------------------------------------------------------- bundle validation
const str = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length <= max
const strOrNull = (v: unknown, max = 4096): string | null => (typeof v === 'string' && v !== '' && v.length <= max ? v : null)
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/

/** Shaped fields only: anything else makes the bundle invalid (never half-applied). */
export function validatePairingBundle(raw: unknown): PairingBundle | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, any>
  if (b.v !== 1 || b.kind !== 'pair' || typeof b.createdAt !== 'number' || !Number.isFinite(b.createdAt)) return null
  const h = b.host, f = b.factory, g = b.github, br = b.broker, vo = b.voice, x = b.x
  if (!h || !f || !g || !br || !vo || !x) return null
  if (!str(h.label, 64) || h.label.trim() === '' || !str(h.machineId) || !ID.test(h.machineId) || !str(h.ownerId) || !ID.test(h.ownerId) ||
    !str(h.brokerUrl) || !['tailscale', 'https', 'none'].includes(h.via) || !['linux', 'macos'].includes(h.os) ||
    typeof h.online !== 'boolean') return null
  if (h.brokerUrl !== '' && !canonicalBrokerUrl(h.brokerUrl)) return null
  if (typeof f.computerOnline !== 'boolean' || typeof x.hostSignIn !== 'boolean') return null
  const repoCount = g.repoCount === null || g.repoCount === undefined ? null
    : Number.isInteger(g.repoCount) && g.repoCount >= 0 ? g.repoCount : NaN
  if (Number.isNaN(repoCount)) return null
  let native: PairingBundle['native'] = null
  if (b.native !== null && b.native !== undefined) {
    const n = b.native
    if (!n || !['brokerUrl', 'ownerId', 'machineId', 'cwd', 'baseRef'].every((k) => str(n[k]))) return null
    native = { brokerUrl: n.brokerUrl, ownerId: n.ownerId, machineId: n.machineId, cwd: n.cwd, baseRef: n.baseRef }
  }
  return {
    v: 1, kind: 'pair', createdAt: b.createdAt,
    host: { label: h.label.trim(), machineId: h.machineId, ownerId: h.ownerId, brokerUrl: h.brokerUrl ? canonicalBrokerUrl(h.brokerUrl)! : '', via: h.via, os: h.os, online: h.online },
    factory: { apiKey: strOrNull(f.apiKey), computerId: strOrNull(f.computerId, 160), computerName: strOrNull(f.computerName, 120), computerOnline: f.computerOnline },
    github: { token: strOrNull(g.token), login: strOrNull(g.login, 64), repoCount },
    broker: { bearerToken: strOrNull(br.bearerToken) },
    voice: { elevenLabsKey: strOrNull(vo.elevenLabsKey) },
    x: { hostSignIn: x.hostSignIn, clientId: strOrNull(x.clientId, 256), accessToken: strOrNull(x.accessToken), refreshToken: strOrNull(x.refreshToken) },
    native,
  }
}

export function validateMoveBundle(raw: unknown): MoveBundle | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, any>
  if (b.v !== 1 || b.kind !== 'move' || typeof b.createdAt !== 'number') return null
  if (!b.keys || typeof b.keys !== 'object' || Array.isArray(b.keys)) return null
  if (!b.prefs || typeof b.prefs !== 'object' || Array.isArray(b.prefs)) return null
  const keys: Record<string, string> = {}
  for (const [k, v] of Object.entries(b.keys)) if (typeof v === 'string') keys[k] = v
  const feed = Array.isArray(b.feed) ? b.feed.filter((e: any) => e && typeof e.at === 'number' && Number.isFinite(e.at) &&
    typeof e.label === 'string' && typeof e.text === 'string').map((e: any) => ({ at: e.at, label: e.label, text: e.text })) : []
  const s = b.summary && typeof b.summary === 'object' ? b.summary : {}
  return {
    v: 1, kind: 'move', createdAt: b.createdAt, keys, prefs: b.prefs, feed, history: b.history ?? null,
    summary: {
      hostLabel: typeof s.hostLabel === 'string' ? s.hostLabel : null,
      buildCount: Number.isInteger(s.buildCount) && s.buildCount >= 0 ? s.buildCount : 0,
      keyCount: Object.keys(keys).length,
    },
  }
}

/** A sealed bundle older than the code's own life is refused (both ends hold the 10 minutes). */
const fresh = (createdAt: number, now: number): boolean => now - createdAt <= PAIR_TTL_MS + 60_000 && createdAt - now <= PAIR_TTL_MS

function feedUnion(a: readonly FeedEntry[], b: readonly FeedEntry[]): FeedEntry[] {
  const byKey = new Map<string, FeedEntry>()
  for (const e of [...a, ...b]) byKey.set(`${e.at}\u0000${e.label}\u0000${e.text}`, e)
  return [...byKey.values()].sort((x, y) => y.at - x.at).slice(0, FEED_KEEP)
}

// ---------------------------------------------------------------- the client
export function createPairingClient(deps: PairingClientDeps): PairingClient {
  const { keys, prefs, feed } = deps
  const now = deps.now ?? Date.now
  const relay = createRelayClient({ base: deps.relayBase ?? DEFAULT_PAIR_BASE, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) })
  const fetchImpl: typeof fetch = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a))
  const timing = { now, ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}) }
  const noRelay = (): boolean => relay.base === ''

  async function claimPairing(code: string, opts: { signal?: AbortSignal; qrSecret?: string | null } = {}) {
    const normalized = normalizePairCode(code)
    if (!normalized) return { ok: false as const, reason: 'invalid' as PairFailure }
    if (noRelay()) return { ok: false as const, reason: 'unreachable' as PairFailure }
    const joined = await joinSession({ kind: 'pair', relay, code: normalized, qrSecret: opts.qrSecret ?? null, signal: opts.signal, ...timing })
    if (!joined.ok) {
      const reason = (joined as { reason: string }).reason
      return { ok: false as const, reason: (reason === 'too_large' ? 'invalid' : reason) as PairFailure }
    }
    const bundle = validatePairingBundle((joined as { payload: unknown }).payload)
    if (!bundle) return { ok: false as const, reason: 'invalid' as PairFailure }
    if (!fresh(bundle.createdAt, now())) return { ok: false as const, reason: 'expired' as PairFailure }
    return { ok: true as const, bundle }
  }

  async function applyPairingBundle(bundle: PairingBundle, opts: { runOn: RunOn }): Promise<ApplyResult> {
    const applied: string[] = [], failed: string[] = []
    const step = async (id: string, write: () => Promise<boolean>) => {
      let ok = false
      try { ok = await write() } catch { ok = false }
      ;(ok ? applied : failed).push(id)
    }
    if (bundle.factory.apiKey) await step('factory', () => keys.setFactory(bundle.factory.apiKey!))
    if (opts.runOn === 'host' && bundle.factory.computerId) await step('computer', () => keys.setComputerId(bundle.factory.computerId!))
    if (bundle.github.token) await step('github', () => keys.setGithub(bundle.github.token!))
    const brokerUrl = canonicalBrokerUrl(bundle.host.brokerUrl)
    if (bundle.broker.bearerToken && brokerUrl) await step('broker', () => keys.setNativeBroker(bundle.broker.bearerToken!, brokerUrl))
    if (bundle.voice.elevenLabsKey) await step('voice', () => keys.setElevenLabs(bundle.voice.elevenLabsKey!))
    const xb = bundle.x
    if (xb.clientId && xb.accessToken && xb.refreshToken && xb.accessToken !== xb.refreshToken) {
      await step('x', async () => (await prefs.setXClientId(xb.clientId!)) && keys.setX(xb.accessToken!, xb.refreshToken!))
    }
    // The installer sends "unknown" when the host has no broker identity:
    // a placeholder is never stored as an id (nothing invented is prefilled).
    const known = (id: string): string => (id === 'unknown' ? '' : id)
    const host: PairedHost = {
      label: bundle.host.label, machineId: known(bundle.host.machineId), ownerId: known(bundle.host.ownerId),
      brokerUrl: brokerUrl ?? '', via: brokerUrl ? bundle.host.via : 'none', os: bundle.host.os, pairedAt: now(),
    }
    await step('pairedHost', () => prefs.setPairedHost(host))
    await step('runOn', () => prefs.setRunOn(opts.runOn))
    await step('setupPath', () => prefs.setSetupPath('paired'))
    if (bundle.native) {
      // Prefill only: a field the owner already filled is never overwritten.
      const current = prefs.nativeLaunchProfile
      const next: NativeLaunchProfile = { ...current }
      let changed = false
      for (const k of ['brokerUrl', 'ownerId', 'machineId', 'cwd', 'baseRef'] as const) {
        const incoming = k === 'brokerUrl' ? canonicalBrokerUrl(bundle.native.brokerUrl) ?? '' : bundle.native[k].trim()
        if (current[k] === '' && incoming !== '') { next[k] = incoming; changed = true }
      }
      if (changed) await step('nativeProfile', () => prefs.setNativeLaunchProfile(next))
    }
    return { ok: failed.length === 0, applied, failed }
  }

  async function buildMoveBundle(withHistory: boolean): Promise<MoveBundle> {
    let history: unknown = null
    const archiveKey = deps.archive?.deviceKey ?? ''
    let records: unknown = null
    if (withHistory && deps.history) {
      try { records = await deps.history.export() } catch { records = null }
    }
    if (archiveKey || records !== null) history = { ...(archiveKey ? { archiveDeviceKey: archiveKey } : {}), ...(records !== null ? { records } : {}) }
    const keyRec = keys.exportForTransfer()
    return {
      v: 1, kind: 'move', createdAt: now(), keys: keyRec, prefs: prefs.exportForTransfer(),
      feed: feed.restore().map((e) => ({ at: e.at, label: e.label, text: e.text })), history,
      summary: {
        hostLabel: prefs.pairedHost?.label ?? null,
        buildCount: records !== null && deps.history ? deps.history.count() : 0,
        keyCount: Object.keys(keyRec).length,
      },
    }
  }
  const sizeOf = (b: MoveBundle): number => Math.ceil((new TextEncoder().encode(JSON.stringify(b)).length + 16) * 4 / 3) + 1024

  async function offerTransfer(opts: { signal?: AbortSignal } = {}): Promise<TransferOfferResult> {
    if (noRelay()) return { ok: false, reason: 'unreachable' }
    // Trim build history first when the bundle would not fit the mailbox.
    let bundle = await buildMoveBundle(true)
    if (sizeOf(bundle) > PAIR_BODY_MAX) bundle = await buildMoveBundle(false)
    if (sizeOf(bundle) > PAIR_BODY_MAX) return { ok: false, reason: 'too_large' }
    let session
    try {
      session = await openHostSession({ kind: 'move', relay, relayLabel: RELAY, signal: opts.signal, ...timing })
    } catch (error) {
      return { ok: false, reason: ((error as { reason?: TransferFailure }).reason ?? 'unreachable') as TransferFailure }
    }
    const done = session.finish(() => ({ ...bundle, createdAt: now() })).then((r) =>
      r.ok ? { ok: true as const } : { ok: false as const, reason: r.reason as TransferFailure })
    return {
      ok: true,
      offer: {
        code: session.code, display: session.display, qrText: session.qrText, expiresAt: session.expiresAt,
        done, cancel: () => { void session.cancel() },
      },
    }
  }

  async function receiveTransfer(code: string, opts: { signal?: AbortSignal; qrSecret?: string | null } = {}): Promise<TransferReceiveOutcome> {
    const normalized = normalizeTransferCode(code)
    if (!normalized) return { ok: false, reason: 'invalid' }
    if (noRelay()) return { ok: false, reason: 'unreachable' }
    const joined = await joinSession({ kind: 'move', relay, code: normalized, qrSecret: opts.qrSecret ?? null, signal: opts.signal, ...timing })
    if (!joined.ok) return { ok: false, reason: (joined as { reason: string }).reason as TransferFailure }
    const bundle = validateMoveBundle((joined as { payload: unknown }).payload)
    if (!bundle) return { ok: false, reason: 'invalid' }
    if (!fresh(bundle.createdAt, now())) return { ok: false, reason: 'expired' }
    return { ok: true, bundle }
  }

  async function applyMoveBundle(bundle: MoveBundle): Promise<ApplyResult> {
    const applied: string[] = [], failed: string[] = []
    const step = async (id: string, write: () => Promise<boolean>) => {
      let ok = false
      try { ok = await write() } catch { ok = false }
      ;(ok ? applied : failed).push(id)
    }
    if (Object.keys(bundle.keys).length > 0) await step('keys', () => keys.importFromTransfer(bundle.keys))
    if (Object.keys(bundle.prefs).length > 0) await step('prefs', () => prefs.importFromTransfer(bundle.prefs))
    if (bundle.feed.length > 0) await step('feed', () => feed.save(feedUnion(feed.restore(), bundle.feed)))
    const h = bundle.history as { archiveDeviceKey?: unknown; records?: unknown } | null
    if (h && typeof h === 'object') {
      if (typeof h.archiveDeviceKey === 'string' && h.archiveDeviceKey && deps.archive) {
        const key = h.archiveDeviceKey
        await step('archive', () => deps.archive!.adoptDeviceKey(key))
      }
      if (h.records !== undefined && h.records !== null && deps.history) {
        const records = h.records
        await step('history', () => deps.history!.import(records))
      }
    }
    await step('setupPath', () => prefs.setSetupPath('moved'))
    return { ok: failed.length === 0, applied, failed }
  }

  // ---------------------------------------------------------------- host X sign-in
  const hostLink = (): { url: string; token: string } | null => {
    const url = canonicalBrokerUrl(prefs.pairedHost?.brokerUrl || prefs.nativeLaunchProfile.brokerUrl)
    if (!url) return null
    const token = keys.nativeBrokerFor(url)
    return token ? { url, token } : null
  }
  const asState = (raw: unknown): HostXSignInState => {
    const r = raw as Record<string, unknown> | null
    switch (r?.state) {
      case 'idle': return { state: 'idle' }
      case 'pending': return { state: 'pending', startedAt: typeof r.startedAt === 'number' ? r.startedAt : now() }
      case 'connected': return { state: 'connected', handle: typeof r.handle === 'string' ? r.handle : null }
      case 'failed': return { state: 'failed', reason: typeof r.reason === 'string' ? r.reason.slice(0, 128) : 'x_signin_failed' }
      case 'unavailable': return { state: 'unavailable', reason: typeof r.reason === 'string' ? r.reason.slice(0, 128) : 'x_signin_unavailable' }
      default: return { state: 'failed', reason: 'x_signin_unreadable' }
    }
  }
  async function hostCall(method: 'GET' | 'POST', body?: unknown): Promise<HostXSignInState> {
    const link = hostLink()
    if (!link) return { state: 'unavailable', reason: 'not_paired' }
    let res: Response
    try {
      res = await fetchImpl(`${link.url}/v1/native/x/signin`, {
        method,
        headers: { authorization: `Bearer ${link.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch {
      return { state: 'unavailable', reason: 'host_unreachable' }
    }
    let json: unknown = null
    try { json = await res.json() } catch { json = null }
    if (res.ok) return asState(json)
    const code = typeof (json as { error?: unknown })?.error === 'string' ? (json as { error: string }).error.slice(0, 128) : `http_${res.status}`
    return res.status === 401 ? { state: 'failed', reason: 'unauthorized' }
      : res.status === 404 || res.status === 503 ? { state: 'unavailable', reason: code } : { state: 'failed', reason: code }
  }

  return {
    normalizePairCode,
    formatPairCode,
    parsePairQr(text: string) {
      const parsed = parseQr(text, 'pair')
      return parsed ? { code: parsed.code, secret: parsed.secret } : null
    },
    claimPairing,
    applyPairingBundle,
    parseTransferQr,
    normalizeTransferCode,
    formatTransferCode,
    offerTransfer,
    receiveTransfer,
    applyMoveBundle,
    qrMatrix,
    hostXSignIn: {
      available: () => hostLink() !== null,
      start: (opts: { clientId?: string } = {}) => {
        const clientId = (opts.clientId ?? prefs.xClientId).trim()
        return hostCall('POST', clientId ? { clientId } : {})
      },
      status: () => hostCall('GET'),
    },
  }
}

/** Reads a scanned transfer QR (code and secret) for the Move receiver. */
export function parseTransferQr(text: string): { code: string; secret: string | null } | null {
  const parsed = parseQr(text, 'move')
  return parsed ? { code: parsed.code, secret: parsed.secret } : null
}
