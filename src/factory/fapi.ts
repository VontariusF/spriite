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
}

async function call<T>(
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API}${path}`, {
      method,
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
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
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
    status: s?.status === 'pending' || s?.status === 'running' ? s.status : 'idle',
    updatedAt: Number(s?.updatedAt ?? 0),
    computerId: typeof s?.computerId === 'string' ? s.computerId : '',
  })).filter((s) => s.sessionId)
}

/** Create the orchestrator session in the user's account. */
export async function factoryCreateSession(
  key: string,
  o: { computerId?: string } = {},
): Promise<{ sessionId: string; status: string }> {
  const body = await call<Record<string, unknown>>(key, 'POST', '/api/v0/sessions', {
    ...(o.computerId ? { computerId: o.computerId } : {}),
  })
  const sessionId = String(body?.sessionId ?? '')
  if (!sessionId) throw new FactoryError('service', 'Factory returned no session id')
  return { sessionId, status: String(body?.status ?? 'idle') }
}

/** Poll the session: execution status and message count. */
export async function factoryGetSession(
  key: string,
  sessionId: string,
): Promise<FactorySessionInfo> {
  const body = await call<Record<string, unknown>>(key, 'GET', `/api/v0/sessions/${sessionId}`)
  return {
    sessionId: String(body?.sessionId ?? sessionId),
    status: String(body?.status ?? 'idle'),
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
  return {
    messageId: String(body?.messageId ?? ''),
    status: String(body?.status ?? 'running'),
  }
}

/** Read the session's messages (assistant replies become HUD cards). */
export async function factoryGetMessages(
  key: string,
  sessionId: string,
): Promise<FactoryMessage[]> {
  const body = await call<{ messages?: Array<Record<string, unknown>> }>(
    key,
    'GET',
    `/api/v0/sessions/${sessionId}/messages?limit=100`,
  )
  return (body?.messages ?? []).map((m) => ({
    id: String(m?.id ?? ''),
    role: String(m?.role ?? ''),
    text: messageText(m?.content),
  })).filter((m) => m.id)
}

/** Interrupt the running turn (pause). Idempotent when already idle. */
export async function factoryInterrupt(key: string, sessionId: string): Promise<void> {
  await call(key, 'POST', `/api/v0/sessions/${sessionId}/interrupt`)
}
