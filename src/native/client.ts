import type { NativeBrokerClient, NativeCommand, NativeIntent, NativeAdmissionDraft, NativeHostClient,
  NativeJobSummary, NativeState, NativeXHandoff, NativeXHostReader, NativeXHostReceipt, NativeXHostStatus } from './protocol'
import { canonicalBrokerUrl, decodeNativeCapabilities, decodeNativeIntent, decodeNativeCommand,
  decodeNativeReceipt, decodeNativeSnapshot, decodeNativeAdmissionDraft, decodeNativeAdmissionPreview } from './decode'
import { canonicalNativeJson, nativeFingerprint } from './fingerprint'

export class NativeBrokerError extends Error {
  readonly outcome: 'rejected' | 'unknown'
  /** The broker's own error code (`{error}` body), when it answered one. Never a body echo. */
  readonly code: string | null
  readonly status: number | null
  constructor(outcome: 'rejected' | 'unknown', message: string, code: string | null = null, status: number | null = null) {
    super(message)
    this.outcome = outcome
    this.code = code
    this.status = status
    this.name = 'NativeBrokerError'
  }
}
export interface NativeHttpOptions {
  brokerUrl: string
  /** The only credential seam; never capture a token in config/cache. */
  credential: () => string | Promise<string>
  fetch?: typeof fetch
  timeoutMs?: number
}
export type BoundNativeBrokerClient = NativeBrokerClient & NativeHostClient & {
  readonly brokerUrl: string
  githubCall(call: { method: 'GET' | 'POST'; path: string; body?: unknown }): Promise<{ status: number; body: unknown }>
  forBroker(url: string): NativeBrokerClient
}

/** One bounded HTTP attempt. Redirects and write replays are prohibited. */
export class HttpNativeBrokerClient implements BoundNativeBrokerClient {
  readonly brokerUrl: string
  private readonly options: NativeHttpOptions
  constructor(options: NativeHttpOptions) {
    const url = canonicalBrokerUrl(options.brokerUrl)
    if (!url) throw new NativeBrokerError('rejected', 'invalid native broker URL')
    this.brokerUrl = url
    this.options = { ...options, brokerUrl: url }
    Object.defineProperty(this, 'brokerUrl', { writable: false })
  }
  forBroker(url: string): NativeBrokerClient {
    return new HttpNativeBrokerClient({ ...this.options, brokerUrl: url })
  }
  capabilities() {
    return this.request('GET', '/v1/native/capabilities', undefined, decodeNativeCapabilities)
  }
  prepare(intent: NativeIntent) {
    const decoded = decodeNativeIntent(intent)
    if (!decoded) return Promise.reject(new NativeBrokerError('rejected', 'invalid native intent'))
    return this.request('POST', '/v1/native/jobs', decoded, decodeNativeSnapshot)
  }
  observe(missionId: string, ownerId: string) {
    return this.request('GET', `/v1/native/jobs/${encodeURIComponent(missionId)}?ownerId=${encodeURIComponent(ownerId)}`,
      undefined, decodeNativeSnapshot)
  }
  command(command: NativeCommand) {
    const decoded = decodeNativeCommand(command)
    if (!decoded) return Promise.reject(new NativeBrokerError('rejected', 'invalid native command'))
    return this.request('POST', `/v1/native/jobs/${encodeURIComponent(decoded.missionId)}/commands`, decoded, decodeNativeReceipt)
  }
  async inspectAdmission(draft: NativeAdmissionDraft) {
    const decoded = decodeNativeAdmissionDraft(draft)
    if (!decoded) throw new NativeBrokerError('rejected', 'invalid native admission draft')
    const draftHash = await nativeFingerprint(decoded)
    const preview = await this.request('POST', '/v1/native/admission', decoded, decodeNativeAdmissionPreview, false)
    if (preview.missionId !== decoded.missionId || preview.ownerId !== decoded.ownerId ||
      preview.draftHash !== draftHash ||
      ['machineId', 'cwd', 'repository', 'baseRef'].some(k => preview.workspace[k as keyof typeof preview.workspace] !== decoded.workspace[k as keyof typeof decoded.workspace]) ||
      (decoded.workspace.baseSha && decoded.workspace.baseSha !== preview.workspace.baseSha) ||
      canonicalNativeJson(preview.prospectiveSettings) !== canonicalNativeJson(decoded.settings) ||
      Date.parse(preview.observedAt) > Date.now() + 5000 || Date.parse(preview.expiresAt) <= Date.now() ||
      Date.parse(preview.expiresAt) - Date.parse(preview.observedAt) > 60000) {
      throw new NativeBrokerError('rejected', 'native admission evidence mismatch or expiry')
    }
    return preview
  }
  async listJobs(ownerId: string) {
    return (await this.request('GET', `/v1/native/jobs?ownerId=${encodeURIComponent(ownerId)}`, undefined, decodeNativeJobList)).jobs
  }
  /**
   * One handoff of the live X pair. Verification runs on the host against X
   * (/2/users/me), so the deadline is longer than a job read. A 5xx after the
   * body was sent is 'unknown': the host may hold the pair.
   */
  xHandoff(handoff: NativeXHandoff) {
    return this.request('POST', '/v1/native/x/handoff', handoff, decodeNativeXHostStatus, true, 45000)
  }
  xStatus() {
    return this.request('GET', '/v1/native/x/status', undefined, decodeNativeXHostStatus)
  }
  xStop() {
    return this.request('POST', '/v1/native/x/stop', {}, decodeNativeXHostStatus)
  }
  /**
   * One GitHub call run by the host's `gh` (HOST-GITHUB-PLAN). The broker
   * allowlists the call and answers GitHub's own status and parsed body; a
   * refusal, a busy host or a signed-out `gh` is a broker error code. The
   * deadline covers the broker's 30 s `gh` timeout.
   */
  githubCall(call: { method: 'GET' | 'POST'; path: string; body?: unknown }) {
    return this.request('POST', '/v1/native/github/call', call, decodeGitHubCallReply, call.method === 'POST', 40000)
  }
  private async request<T>(method: string, path: string, body: unknown, decode: (x: unknown) => T | null,
    executionWrite = method === 'POST', timeoutMs = this.options.timeoutMs ?? 15000): Promise<T> {
    const controller = new AbortController()
    let invoked = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = async () => {
      const credential = await this.options.credential()
      if (!credential || controller.signal.aborted) throw new NativeBrokerError('rejected', 'native broker credential unavailable')
      invoked = true
      const response = await (this.options.fetch ?? fetch)(`${this.brokerUrl}${path}`, {
        method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      // Server-side ambiguous failures can follow an executed write.
      if (!response.ok) throw new NativeBrokerError(executionWrite && response.status >= 500 ? 'unknown' : 'rejected',
        `native broker HTTP ${response.status}`, await errorCodeOf(response), response.status)
      const parsed = decode(await response.json())
      if (!parsed) throw new NativeBrokerError(executionWrite ? 'unknown' : 'rejected', 'malformed native broker response')
      return parsed
    }
    try {
      return await Promise.race([attempt(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new NativeBrokerError(executionWrite && invoked ? 'unknown' : 'rejected', 'native broker deadline exceeded'))
        }, Math.max(1, timeoutMs))
      })])
    } catch (error) {
      if (error instanceof NativeBrokerError) throw error
      // Deliberately omit the raw exception/body/credential from diagnostics.
      throw new NativeBrokerError(executionWrite && invoked ? 'unknown' : 'rejected', 'native broker transport unavailable')
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }
}
export const createNativeBrokerClient = (options: NativeHttpOptions): BoundNativeBrokerClient =>
  new HttpNativeBrokerClient(options)

/** GitHub's status and body as the broker relays them; nothing else is kept. */
export function decodeGitHubCallReply(v: unknown): { status: number; body: unknown } | null {
  if (!isRecord(v) || typeof v.status !== 'number' || !Number.isInteger(v.status) || v.status < 100 || v.status > 599) return null
  return { status: v.status, body: v.body === undefined ? null : v.body }
}

/** The broker's `{error: code}` only, and only a plain code; anything else reads as no code. */
async function errorCodeOf(response: Response): Promise<string | null> {
  try {
    const value = await response.json() as { error?: unknown }
    return typeof value?.error === 'string' && /^[a-z0-9_]{1,128}$/.test(value.error) ? value.error : null
  } catch { return null }
}

const NATIVE_STATES: readonly NativeState[] = ['held', 'planning', 'awaiting_input', 'initializing',
  'running', 'paused', 'orchestrator_turn', 'completed']
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const shortText = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length <= max
const nullableText = (v: unknown, max = 4096): v is string | null => v === null || shortText(v, max)
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

export function decodeNativeJobList(v: unknown): { jobs: NativeJobSummary[] } | null {
  if (!isRecord(v) || !Array.isArray(v.jobs) || v.jobs.length > 10000) return null
  const jobs: NativeJobSummary[] = []
  for (const j of v.jobs) {
    if (!isRecord(j) || typeof j.missionId !== 'string' || !MISSION_ID.test(j.missionId) ||
      !NATIVE_STATES.includes(j.state as NativeState) || !count(j.scopeRevision) || !count(j.brokerSeq) ||
      !nullableText(j.holdReason) || (j.bound !== undefined && typeof j.bound !== 'boolean')) return null
    jobs.push({ missionId: j.missionId, state: j.state as NativeState, scopeRevision: j.scopeRevision,
      brokerSeq: j.brokerSeq, holdReason: j.holdReason, ...(typeof j.bound === 'boolean' ? { bound: j.bound } : {}) })
  }
  return { jobs }
}

const RECEIPT_STATUSES = ['submitted', 'held', 'clarify', 'ignored', 'launching'] as const
function decodeHostReceipt(v: unknown): NativeXHostReceipt | null {
  if (!isRecord(v) || !shortText(v.dedupeKey, 256) || !shortText(v.logicalPostId, 64) || !shortText(v.revisionId, 64) ||
    !RECEIPT_STATUSES.includes(v.status as NativeXHostReceipt['status']) || !shortText(v.at, 64)) return null
  const out: NativeXHostReceipt = { dedupeKey: v.dedupeKey, logicalPostId: v.logicalPostId, revisionId: v.revisionId,
    status: v.status as NativeXHostReceipt['status'], at: v.at }
  for (const key of ['reason', 'missionId', 'repository', 'newRepository', 'proposedRevisionId'] as const) {
    if (v[key] === undefined) continue
    if (!shortText(v[key], 1024)) return null
    out[key] = v[key] as string
  }
  return out
}

function decodeHostReader(v: unknown): NativeXHostReader | 'withheld' | null | undefined {
  if (v === null) return null
  if (isRecord(v) && v.withheld !== undefined) return 'withheld'
  if (!isRecord(v) || typeof v.running !== 'boolean' || typeof v.bound !== 'boolean' ||
    !isRecord(v.checkpoint) || !nullableText(v.checkpoint.lastSuccessAt, 64) ||
    !['lastCheckedAt', 'lastError', 'nextCheckAt', 'backoffUntil'].every(k => nullableText(v[k], 256)) ||
    !count(v.rejectedCount) || !count(v.gapCount) || !Array.isArray(v.receipts) || v.receipts.length > 50) return undefined
  const receipts = v.receipts.map(decodeHostReceipt)
  if (receipts.some(r => r === null)) return undefined
  return {
    running: v.running, bound: v.bound, lastCheckedAt: v.lastCheckedAt as string | null,
    lastSuccessAt: v.checkpoint.lastSuccessAt as string | null, lastError: v.lastError as string | null,
    nextCheckAt: v.nextCheckAt as string | null, backoffUntil: v.backoffUntil as string | null,
    rejectedCount: v.rejectedCount, gapCount: v.gapCount, receipts: receipts as NativeXHostReceipt[],
  }
}

/** Whitelisted, typed fields only: an unknown field (a token included) never reaches the phone's state. */
export function decodeNativeXHostStatus(v: unknown): NativeXHostStatus | null {
  if (!isRecord(v) || typeof v.enabled !== 'boolean' || typeof v.running !== 'boolean' ||
    !['ownerXUserId', 'spriiteHandle', 'spriiteXUserId', 'defaultRepository', 'repositoryAccount', 'lastError']
      .every(k => nullableText(v[k], 256))) return null
  let credential: NativeXHostStatus['credential'] = null
  if (v.credential !== null) {
    if (!isRecord(v.credential) || !shortText(v.credential.state, 64) || !nullableText(v.credential.expiresAt, 64)) return null
    credential = { state: v.credential.state, expiresAt: v.credential.expiresAt }
  }
  const reader = decodeHostReader(v.reader)
  if (reader === undefined) return null
  let checkpoint: NativeXHostStatus['checkpoint'] = null
  if (v.checkpoint !== undefined && v.checkpoint !== null) {
    const c = v.checkpoint
    if (!isRecord(c) || !(c.lastSeenPostId === null || (typeof c.lastSeenPostId === 'string' && /^\d{1,20}$/.test(c.lastSeenPostId))) ||
      !(c.lastSuccessAt === null || (shortText(c.lastSuccessAt, 64) && Number.isFinite(Date.parse(c.lastSuccessAt))))) return null
    checkpoint = { lastSeenPostId: c.lastSeenPostId as string | null, lastSuccessAt: c.lastSuccessAt as string | null }
  }
  return {
    enabled: v.enabled, running: v.running, ownerXUserId: v.ownerXUserId as string | null,
    spriiteHandle: v.spriiteHandle as string | null, spriiteXUserId: v.spriiteXUserId as string | null,
    defaultRepository: v.defaultRepository as string | null, repositoryAccount: v.repositoryAccount as string | null,
    credential, checkpoint, lastError: v.lastError as string | null, reader,
  }
}
