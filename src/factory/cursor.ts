/**
 * Cursor Cloud Agents client (bring-your-own-key), v1.
 *
 * The durable agent holds repo state; runs carry execution. The app creates
 * one agent per mission ("the worker"), drives follow-up runs on it (fix,
 * open the PR), and polls run state. Cursor accepts Basic or Bearer auth.
 * api.cursor.com does not grant CORS to browser origins on its API paths
 * (only Cursor's own web pages), so a WebView can never call it directly:
 * under the dev server (prototype mode) calls go same-origin through the
 * Vite proxy; installed builds go through the self-hosted relay named at
 * build time by VITE_SPRIITE_RELAY (see relay/). A build without a relay
 * still tries the API directly and fails as a network fault.
 *
 * No imports and erasable-only syntax: dev scripts load this file with Node
 * (import.meta.env is undefined there, so Node keeps the absolute URL).
 */

export type CursorErrorKind = 'auth' | 'quota' | 'network' | 'service'

export class CursorError extends Error {
  readonly kind: CursorErrorKind
  constructor(kind: CursorErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

const ENV = (import.meta as { env?: { DEV?: boolean; VITE_SPRIITE_RELAY?: string } }).env
const RELAY = (ENV?.VITE_SPRIITE_RELAY ?? '').replace(/\/+$/, '')
const API = ENV?.DEV ? '/api/cursor' : RELAY ? `${RELAY}/cursor` : 'https://api.cursor.com'
const UNREACHABLE = ENV && !ENV.DEV && !RELAY
  ? 'Cursor unreachable (this build has no relay)'
  : 'Cursor unreachable'

export interface CursorAgentRun {
  agentId: string
  runId: string | null
}

export interface CursorBranch {
  repoUrl: string
  branch?: string
  prUrl?: string
}

export interface CursorRunState {
  id: string
  status: string
  /** Final assistant reply, when the run reached a terminal state. */
  text: string
  branches: CursorBranch[]
}

export interface CursorKeyInfo {
  apiKeyName: string
  email: string
}

/** One cloud build row for the home list (from the account's agent list). */
export interface CursorAgentCard {
  agentId: string
  name: string
  status: string
  latestRunId: string | null
  updatedAt: number
}

function auth(key: string): string {
  return `Basic ${btoa(`${key}:`)}`
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
        Authorization: auth(key),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  } catch {
    throw new CursorError('network', UNREACHABLE)
  }
  if (res.status === 401 || res.status === 403) throw new CursorError('auth', 'Cursor rejected the key')
  if (res.status === 429) throw new CursorError('quota', 'Cursor rate or usage limit')
  if (!res.ok) throw new CursorError('service', `Cursor HTTP ${res.status}`)
  return (await res.json().catch(() => null)) as T
}

/** Verify a key; returns its name and the account email. */
export async function cursorMe(key: string): Promise<CursorKeyInfo> {
  const body = await call<Record<string, unknown>>(key, 'GET', '/v1/me')
  return {
    apiKeyName: String(body?.apiKeyName ?? ''),
    email: String(body?.userEmail ?? ''),
  }
}

/** GitHub repositories the user's Cursor account can build on. */
export async function cursorRepositories(key: string): Promise<string[]> {
  const body = await call<{ items?: Array<{ url?: string }> }>(key, 'GET', '/v1/repositories')
  return (body?.items ?? []).map((r) => String(r?.url ?? '')).filter(Boolean)
}

function pickRunId(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null
  return v
}

function parseRun(raw: Record<string, unknown> | null | undefined): CursorAgentRun {
  const agent = (raw?.agent ?? {}) as Record<string, unknown>
  const run = (raw?.run ?? {}) as Record<string, unknown>
  const agentId = String(agent?.id ?? raw?.agentId ?? '')
  const runId = pickRunId(String(run?.id ?? agent?.latestRunId ?? raw?.runId ?? ''))
  if (!agentId) throw new CursorError('service', 'Cursor returned no agent id')
  return { agentId, runId }
}

/** List the account's cloud agents (the Cursor builds, newest first). */
export async function cursorAgents(key: string, limit = 10): Promise<CursorAgentCard[]> {
  const body = await call<{ items?: Array<Record<string, unknown>> }>(
    key,
    'GET',
    `/v1/agents?limit=${limit}&includeArchived=false`,
  )
  return (body?.items ?? []).map((a) => ({
    agentId: String(a?.id ?? ''),
    name: String(a?.name ?? ''),
    status: a?.status === 'ACTIVE' ? 'ACTIVE' : 'IDLE',
    latestRunId: typeof a?.latestRunId === 'string' && a.latestRunId ? a.latestRunId : null,
    updatedAt: Date.parse(String(a?.updatedAt ?? '')) || 0,
  })).filter((a) => a.agentId)
}

/** Create the worker agent and its first run on the user's repository. */
export async function createCursorAgent(
  key: string,
  o: { promptText: string; repoUrl: string; name?: string },
): Promise<CursorAgentRun> {
  const body = await call<Record<string, unknown>>(key, 'POST', '/v1/agents', {
    name: o.name ?? 'Spriite worker',
    prompt: { text: o.promptText },
    repos: [{ url: o.repoUrl }],
  })
  return parseRun(body)
}

/** Follow-up run on the same durable agent (fix, open the PR, answer). */
export async function createCursorRun(
  key: string,
  agentId: string,
  o: { promptText: string },
): Promise<{ runId: string }> {
  const body = await call<Record<string, unknown>>(key, 'POST', `/v1/agents/${agentId}/runs`, {
    prompt: { text: o.promptText },
  })
  const runId = pickRunId(String((body as Record<string, unknown>)?.id ?? (body as Record<string, unknown>)?.runId ?? ''))
  if (!runId) throw new CursorError('service', 'Cursor returned no run id')
  return { runId }
}

/** Poll a run: status, final reply, and pushed branches. */
export async function getCursorRun(
  key: string,
  agentId: string,
  runId: string,
): Promise<CursorRunState> {
  const body = await call<Record<string, unknown>>(key, 'GET', `/v1/agents/${agentId}/runs/${runId}`)
  const result = (body?.result ?? {}) as Record<string, unknown>
  const git = (result?.git ?? body?.git ?? {}) as Record<string, unknown>
  const branches = (git?.branches ?? []) as Array<Record<string, unknown>>
  return {
    id: String(body?.id ?? runId),
    status: String(body?.status ?? 'RUNNING'),
    text: String(result?.text ?? ''),
    branches: branches
      .map((b) => ({
        repoUrl: String(b?.repoUrl ?? ''),
        branch: b?.branch ? String(b.branch) : undefined,
        prUrl: b?.prUrl ? String(b.prUrl) : undefined,
      }))
      .filter((b) => b.repoUrl || b.branch || b.prUrl),
  }
}

/** Cancel the active run. Terminal; continue with a new run on the agent. */
export async function cancelCursorRun(
  key: string,
  agentId: string,
  runId: string,
): Promise<void> {
  await call(key, 'POST', `/v1/agents/${agentId}/runs/${runId}/cancel`)
}
