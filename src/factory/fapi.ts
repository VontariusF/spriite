/**
 * Factory Public API client (bring-your-own-key): Sessions + Computers.
 *
 * The orchestrator is a Droid session in the user's own Factory account:
 * create it, drive it with messages, poll its status and replies, interrupt
 * it to pause. api.factory.ai does not grant CORS to browser origins on its
 * API paths (only the root page does), so a WebView can never call it
 * directly: under the dev server (prototype mode) calls go same-origin
 * through the Vite proxy; installed builds go through the self-hosted relay
 * named at build time by VITE_SPRIITE_RELAY (see relay/). A build without a
 * relay still tries the API directly and fails as a network fault.
 *
 * No imports and erasable-only syntax: dev scripts load this file with Node
 * (import.meta.env is undefined there, so Node keeps the absolute URL).
 */

/**
 * - 'offline': the API is up but the mission's Droid Computer is not. The
 *   daemon on that machine is not running (Factory app closed or Remote
 *   Access off): start it in the Factory app (Settings -> Droid Computers ->
 *   Remote Access) or run `droid daemon --remote-access`, then retry.
 */
export type FactoryErrorKind =
  | 'auth'
  | 'forbidden'
  | 'quota'
  | 'billing'
  | 'network'
  | 'timeout'
  | 'unknown'
  | 'offline'
  | 'service'

export class FactoryError extends Error {
  readonly kind: FactoryErrorKind
  constructor(kind: FactoryErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

const ENV = (import.meta as { env?: { DEV?: boolean; VITE_SPRIITE_RELAY?: string } }).env
const RELAY = (ENV?.VITE_SPRIITE_RELAY ?? '').replace(/\/+$/, '')
const API = ENV?.DEV ? '/api/factory' : RELAY ? `${RELAY}/factory` : 'https://api.factory.ai'
const UNREACHABLE = ENV && !ENV.DEV && !RELAY
  ? 'Factory unreachable (this build has no relay)'
  : 'Factory unreachable'

export interface FactoryComputer {
  id: string
  name: string
  status: string
  providerType: string
}

export interface FactorySessionInfo {
  sessionId: string
  status: string
  messageCount: number
}

/** One cloud build row for the home list (from the account's session list). */
export interface FactorySessionCard {
  sessionId: string
  title: string
  status: string
  updatedAt: number
  /** Empty for sessions run locally (Factory app, CLI): the API cannot drive them. */
  computerId: string
}

export interface FactoryMessage {
  id: string
  role: string
  text: string
  /** Observation only, never proof that a file changed or a test passed. */
  hasToolActivity?: boolean
  /** Native prompts are readable, but text POST is not a native tool answer. */
  nativeQuestions?: Array<{ toolId: string; text: string; pending: boolean }>
  completedToolIds?: string[]
}

export type FactoryMessageHistory = FactoryMessage[] & { complete?: boolean; incompleteReason?: string }
/** Plain arrays from older clients remain compatible; adapters label bounded reads. */
export function factoryHistoryComplete(messages: FactoryMessage[]): boolean {
  return (messages as FactoryMessageHistory).complete !== false
}

export const FACTORY_REQUEST_TIMEOUT_MS = 30_000

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content)
    ? content.filter((b): b is Record<string, unknown> => b !== null && typeof b === 'object')
    : []
}

async function call<T>(
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      callResponse<T>(key, method, path, body, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new FactoryError('timeout', 'Factory request deadline exceeded (outcome unconfirmed)'))
          controller.abort()
        }, FACTORY_REQUEST_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function callResponse<T>(key: string, method: string, path: string, body: unknown, signal: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API}${path}`, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  } catch {
    throw new FactoryError('network', UNREACHABLE)
  }
  if (res.status === 401) throw new FactoryError('auth', 'Factory rejected the key')
  if (res.status === 403) throw new FactoryError('forbidden', 'Factory refused the request')
  if (res.status === 429) throw new FactoryError('quota', 'Factory rate or usage limit')
  // 402: the account needs billing or credits before anything can run.
  if (res.status === 402) throw new FactoryError('billing', 'Factory needs billing or credits')
  if (res.status === 502 || res.status === 504) {
    // A gateway response does not prove that the session or POST failed.
    throw new FactoryError('timeout', `Factory HTTP ${res.status} (request outcome unconfirmed)`)
  }
  if (res.status === 503) {
    // The mission's computer is not reachable: its daemon is not running
    // (BYOM machines report active in the list regardless, so this is the
    // first honest signal). Ride the API's reason for the phone.
    let detail = ''
    try {
      const raw = await res.text()
      try {
        const parsed = JSON.parse(raw) as { detail?: unknown; title?: unknown; message?: unknown }
        detail = [parsed?.title, parsed?.detail ?? parsed?.message]
          .filter(Boolean).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(': ')
      } catch {
        detail = raw.slice(0, 200)
      }
    } catch {
      detail = ''
    }
    throw new FactoryError('offline', `Factory could not reach the computer${detail ? ` (${detail})` : ''}`)
  }
  if (!res.ok) {
    // The API's own reason (FactoryApiError: title + detail, or a bare
    // message) rides in the error so the phone can show it.
    let detail = ''
    try {
      const raw = await res.text()
      try {
        const parsed = JSON.parse(raw) as { detail?: unknown; title?: unknown; message?: unknown; error?: unknown }
        detail = [parsed?.title, parsed?.detail ?? parsed?.message ?? parsed?.error]
          .filter(Boolean).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(': ')
      } catch {
        detail = raw.slice(0, 200)
      }
    } catch {
      detail = ''
    }
    throw new FactoryError('service', `Factory HTTP ${res.status}${detail ? ` (${detail})` : ''}`)
  }
  if (res.status === 204) return null as T
  return (await res.json().catch(() => null)) as T
}

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((c): c is { type: string; text?: string } => typeof c === 'object' && c !== null)
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    // Replies carry line-framed completion markers. Preserve text verbatim
    // and keep separate text blocks from merging protocol lines.
    .join('\n')
}

/** List the account's Droid Computers (BYOM machines and cloud computers). */
export async function factoryComputers(key: string): Promise<FactoryComputer[]> {
  const body = await call<{ computers?: Array<Record<string, unknown>> }>(key, 'GET', '/api/v0/computers')
  return (body?.computers ?? []).map((c) => ({
    id: String(c?.id ?? ''),
    name: String(c?.name ?? 'computer'),
    status: String(c?.status ?? ''),
    providerType: String(c?.providerType ?? ''),
  })).filter((c) => c.id)
}

/**
 * Epoch milliseconds from an API timestamp (ms, seconds, or ISO string);
 * 0 when unknown. Home rows sort Factory and Cursor builds together, so a
 * seconds value must not sort as 1970.
 */
export function epochMs(v: unknown): number {
  if (typeof v === 'string' && v && !/^\d+(\.\d+)?$/.test(v)) return Date.parse(v) || 0
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (n >= 1e12) return Math.floor(n)
  if (n >= 1e9) return Math.floor(n * 1000)
  return 0
}

/** Missing metadata is not evidence that a session is idle. */
function sessionStatus(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : 'unknown'
}

/** List the account's Droid sessions (the cloud builds, newest first). */
export async function factorySessions(key: string, limit = 10): Promise<FactorySessionCard[]> {
  const body = await call<{ sessions?: Array<Record<string, unknown>> }>(
    key,
    'GET',
    `/api/v0/sessions?limit=${limit}`,
  )
  return (body?.sessions ?? []).map((s) => ({
    sessionId: String(s?.sessionId ?? ''),
    title: String(s?.title ?? ''),
    status: sessionStatus(s?.status),
    updatedAt: epochMs(s?.updatedAt),
    computerId: typeof s?.computerId === 'string' ? s.computerId : '',
  })).filter((s) => s.sessionId)
}

/** One Factory session tag: a name and optional string metadata. */
export interface SessionTag {
  name: string
  metadata?: Record<string, string>
}

/**
 * A custom instruction. Factory takes either a bare string (which REPLACES
 * Droid's own prompt) or the preset form (which APPENDS to it). Spriite only
 * ever sends the preset form: a session that lost Droid's own system prompt
 * would lose its tool protocol and the HUD's reply format with it.
 */
export type SystemPromptInput = string | { type: 'preset'; preset: 'droid'; append: string }

/**
 * Session settings Factory accepts at CREATE time. Model is a free-form
 * Factory model id (no listing endpoint exists; empty = the account
 * default). Reasoning effort, interaction mode and autonomy are Factory's
 * enums; empty means "leave at the account default".
 *
 * Frozen per build, never PATCHed: `systemPrompt` and the tool lists are not
 * in the update schema at all, and Factory never reports settings back, so a
 * mid-build change could be neither honored nor confirmed. See
 * docs/MISSION-PROBE-FINDINGS.md and MissionSessionSettings.
 */
export interface SessionSettings {
  model?: string
  reasoningEffort?: string
  autonomyLevel?: string
  interactionMode?: string
  specModeModel?: string
  specModeReasoningEffort?: string
  enabledToolIds?: string[]
  disabledToolIds?: string[]
  restrictToolIds?: string[]
  systemPrompt?: SystemPromptInput
  tags?: SessionTag[]
}

/** The non-empty ids of a tool list, or undefined for none. */
function toolIds(ids: string[] | undefined): string[] | undefined {
  const kept = (ids ?? []).map((id) => id.trim()).filter((id) => id !== '')
  return kept.length > 0 ? kept : undefined
}

/** A tag with no name is not a tag (the API requires one). */
function tags(input: SessionTag[] | undefined): SessionTag[] | undefined {
  const kept = (input ?? [])
    .map((t) => ({ name: (t?.name ?? '').trim(), ...(t?.metadata ? { metadata: t.metadata } : {}) }))
    .filter((t) => t.name !== '')
  return kept.length > 0 ? kept : undefined
}

/**
 * Only the set values travel (an empty choice means "Factory's default", and
 * an empty PATCH is a wasted round trip). Every string is trimmed and every
 * blank string or empty list is dropped, so a half-filled phone field can
 * never send a value Factory would reject.
 */
export function settingsBody(o: SessionSettings | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
  const put = (key: string, v: unknown): void => {
    if (v !== undefined) out[key] = v
  }
  put('model', str(o?.model))
  put('reasoningEffort', str(o?.reasoningEffort))
  put('autonomyLevel', str(o?.autonomyLevel))
  put('interactionMode', str(o?.interactionMode))
  put('specModeModel', str(o?.specModeModel))
  put('specModeReasoningEffort', str(o?.specModeReasoningEffort))
  put('enabledToolIds', toolIds(o?.enabledToolIds))
  put('disabledToolIds', toolIds(o?.disabledToolIds))
  put('restrictToolIds', toolIds(o?.restrictToolIds))
  const prompt = o?.systemPrompt
  if (typeof prompt === 'string') put('systemPrompt', str(prompt))
  else if (prompt && typeof prompt === 'object' && str(prompt.append) !== undefined) {
    out.systemPrompt = { type: prompt.type, preset: prompt.preset, append: prompt.append.trim() }
  }
  put('tags', tags(o?.tags))
  return out
}

/** Create the orchestrator session in the user's account. */
export async function factoryCreateSession(
  key: string,
  o: { computerId?: string; sessionSettings?: SessionSettings } = {},
): Promise<{ sessionId: string; status: string }> {
  const settings = settingsBody(o.sessionSettings)
  const body = await call<Record<string, unknown>>(key, 'POST', '/api/v0/sessions', {
    ...(o.computerId ? { computerId: o.computerId } : {}),
    ...(Object.keys(settings).length > 0 ? { sessionSettings: settings } : {}),
  })
  const sessionId = String(body?.sessionId ?? '')
  if (!sessionId) throw new FactoryError('unknown', 'Factory returned no session id (outcome unconfirmed)')
  return { sessionId, status: String(body?.status ?? 'idle') }
}

/**
 * The computerId query for reads of a session that runs on a Droid Computer.
 * Factory looks such a session up on that computer only when it is named;
 * without it the API answers 404 (session does not exist).
 */
function onComputer(computerId: string | undefined, sep: '?' | '&'): string {
  return computerId ? `${sep}computerId=${encodeURIComponent(computerId)}` : ''
}

/** Poll the session: execution status and message count. */
export async function factoryGetSession(
  key: string,
  sessionId: string,
  computerId?: string,
): Promise<FactorySessionInfo> {
  const body = await call<Record<string, unknown>>(
    key,
    'GET',
    `/api/v0/sessions/${sessionId}${onComputer(computerId, '?')}`,
  )
  return {
    sessionId: String(body?.sessionId ?? sessionId),
    status: sessionStatus(body?.status),
    messageCount: Number(body?.messageCount ?? 0),
  }
}

/** Send the orchestrator a message (goal, answer, verdict request, resume). */
export async function factoryPostMessage(
  key: string,
  sessionId: string,
  text: string,
  computerId?: string,
): Promise<{ messageId: string; status: string }> {
  const body = await call<Record<string, unknown>>(key, 'POST', `/api/v0/sessions/${sessionId}/messages`, {
    text,
    ...(computerId ? { computerId } : {}),
  })
  if (typeof body?.messageId !== 'string' || !body.messageId.trim()) {
    // A 2xx without an acknowledgment is ambiguous, not proof of delivery.
    // Retain the adapter's public error dialect; the execution classifier
    // treats this successful-but-unreadable acknowledgment as UNKNOWN.
    throw new FactoryError('service', 'Factory returned no message acknowledgment (outcome unconfirmed)')
  }
  return {
    messageId: body.messageId,
    status: String(body?.status ?? 'running'),
  }
}

/**
 * The last complete newest-first history per session, so a poll reads only
 * the pages newer than what it already has instead of the whole conversation
 * every few seconds. Bounded; any doubt falls back to a full read.
 */
const historyCache = new Map<string, { newestId: string; newestAt: number; messages: Array<Record<string, unknown>> }>()
const HISTORY_CACHE_SESSIONS = 64

/** Read the session's messages (assistant replies become HUD cards). */
export async function factoryGetMessages(
  key: string,
  sessionId: string,
  computerId?: string,
): Promise<FactoryMessage[]> {
  const messages: Array<Record<string, unknown>> = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  let complete = false
  let incompleteReason = 'Message history exceeded the 2000-message safety bound'
  const cacheKey = `${key.length}:${key.slice(-6)}|${sessionId}|${computerId ?? ''}`
  const cached = historyCache.get(cacheKey)
  for (let page = 0; page < 20; page++) {
    let body: { messages?: Array<Record<string, unknown>>; pagination?: { hasMore?: unknown; nextCursor?: unknown } }
    try {
      body = await call(key, 'GET',
        `/api/v0/sessions/${sessionId}/messages?limit=100${onComputer(computerId, '&')}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    } catch (e) {
      if (!messages.length) throw e
      incompleteReason = 'Message history continuation unavailable'
      break
    }
    if (!Array.isArray(body?.messages)) { incompleteReason = 'Malformed message history'; break }
    messages.push(...body.messages)
    // Reached the newest message already held, on provably newest-first
    // pages: everything older is the cached complete history.
    if (cached) {
      const at = messages.map(m => epochMs(m?.createdAt))
      const descending = at.length > 0 && at.every((t, i) => t > 0 && (i === 0 || t <= at[i - 1]))
      const hit = messages.findIndex(m => m?.id === cached.newestId)
      if (descending && hit >= 0 && epochMs(messages[hit]?.createdAt) === cached.newestAt) {
        const fresh = new Set(messages.map(m => m?.id))
        messages.push(...cached.messages.filter(m => !fresh.has(m.id)))
        complete = true
        break
      }
    }
    const pagination = body.pagination
    if (pagination?.hasMore === false) { complete = true; break }
    const next = pagination?.nextCursor
    if (typeof next !== 'string' || !next || cursors.has(next)) {
      incompleteReason = 'Message history continuation boundary unavailable'
      break
    }
    cursors.add(next)
    cursor = next
  }
  const unique = [...new Map(messages.filter(m => m && typeof m === 'object').map(m => [m.id, m])).values()]
  const first = unique[0]
  const firstAt = epochMs(first?.createdAt)
  if (complete && typeof first?.id === 'string' && firstAt > 0 &&
    unique.every((m, i) => i === 0 || (epochMs(m.createdAt) > 0 && epochMs(m.createdAt) <= epochMs(unique[i - 1].createdAt)))) {
    historyCache.delete(cacheKey)
    historyCache.set(cacheKey, { newestId: first.id, newestAt: firstAt, messages: unique })
    if (historyCache.size > HISTORY_CACHE_SESSIONS) historyCache.delete(historyCache.keys().next().value!)
  } else if (complete) historyCache.delete(cacheKey)
  const dated = unique
    .filter((m) => typeof m === 'object' && m !== null && typeof m.id === 'string' && m.id.trim())
    .map((message, index) => ({ message, index, at: epochMs(message.createdAt) }))
  // The live API returns newest-first. Engine request boundaries require
  // oldest-first, including equal-time entries. updatedAt cannot order turns:
  // a streamed edit is still part of the message's original turn.
  const timestamps = dated.filter((entry) => entry.at > 0)
  const newestFirst = timestamps.length > 1 && timestamps[0].at >= timestamps.at(-1)!.at
  if (dated.every((entry) => entry.at > 0)) {
    dated.sort((a, b) => a.at - b.at || (newestFirst ? b.index - a.index : a.index - b.index))
  } else if (newestFirst) dated.reverse()
  const resultId = (b: Record<string, unknown>): string =>
    b.type === 'tool_result' ? typeof b.toolUseId === 'string' ? b.toolUseId
      : typeof b.tool_use_id === 'string' ? b.tool_use_id : '' : ''
  const completed = new Set(dated.flatMap(({ message }) => contentBlocks(message.content).map(resultId).filter(Boolean)))
  const history: FactoryMessageHistory = dated.map(({ message: m }) => ({
    id: String(m?.id ?? ''),
    role: String(m?.role ?? ''),
    text: messageText(m?.content),
    ...(Array.isArray(m?.content) && m.content.some((b: unknown) =>
      b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_use')
      ? { hasToolActivity: true } : {}),
    ...(m.role === 'assistant' && contentBlocks(m.content).some(b => b.type === 'tool_use' && b.name === 'AskUser')
      ? { nativeQuestions: contentBlocks(m.content).flatMap(b => {
        const input = b.input as { questionnaire?: unknown } | null
        if (b.type !== 'tool_use' || b.name !== 'AskUser' || typeof b.id !== 'string' || !b.id.trim() ||
            !input || typeof input.questionnaire !== 'string' || !input.questionnaire.trim()) return []
        return [{ toolId: b.id, text: input.questionnaire, pending: !completed.has(b.id) }]
      }) } : {}),
    ...(contentBlocks(m.content).some(b => resultId(b))
      ? { completedToolIds: contentBlocks(m.content).map(resultId).filter(Boolean) } : {}),
  })).filter((m) => m.id)
  Object.defineProperty(history, 'complete', { value: complete, enumerable: false })
  if (!complete) Object.defineProperty(history, 'incompleteReason', { value: incompleteReason, enumerable: false })
  return history
}

/** Interrupt the running turn (pause). Idempotent when already idle. */
export async function factoryInterrupt(key: string, sessionId: string): Promise<void> {
  await call(key, 'POST', `/api/v0/sessions/${sessionId}/interrupt`)
}
