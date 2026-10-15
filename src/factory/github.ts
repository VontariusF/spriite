/**
 * GitHub client (bring-your-own-token). The repository the workers build on
 * comes from the user's own GitHub: list what they have, or create a new
 * one. A personal access token with the "repo" scope (classic) or
 * "Repository creation" write permission (fine-grained) covers everything
 * here. CORS allows direct browser calls (verified).
 *
 * Every call goes through a transport (docs/design/HOST-GITHUB-PLAN.md): the
 * phone's own token, or the paired host's `gh` sign-in through the broker's
 * one allowlisted route. Both hand back GitHub's own status and body, so the
 * parsing and the error kinds below are the same whichever one ran. A plain
 * string where a transport is expected is the token transport, unchanged.
 *
 * No imports and erasable-only syntax: dev scripts load this file with Node.
 */

export type GitHubErrorKind = 'auth' | 'permission' | 'quota' | 'exists' | 'network' | 'service'

export class GitHubError extends Error {
  readonly kind: GitHubErrorKind
  constructor(kind: GitHubErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

const API = 'https://api.github.com'

export interface GitHubUser {
  login: string
  name: string
}

export interface GitHubRepo {
  /** "owner/repo" */
  fullName: string
  url: string
  private: boolean
  /** Last push, ISO date; repos sort by this, newest first. */
  pushedAt: string
}

export interface GitHubCreatedRepo {
  fullName: string
  url: string
  private?: boolean
}

function pickString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** GitHub's answer as a transport hands it back: its own status and body. */
export interface GitHubReply {
  status: number
  text(): Promise<string>
  json(): Promise<unknown>
}

export interface GitHubCallOptions {
  accept?: string
  raw?: boolean
}

/** One way to reach GitHub. `send` throws GitHubError when no reply arrived. */
export interface GitHubTransport {
  readonly via: 'token' | 'host'
  /** The whole call's deadline; past it the outcome is unconfirmed. */
  readonly deadlineMs: number
  send(method: string, path: string, body: unknown, opts: GitHubCallOptions, signal: AbortSignal): Promise<GitHubReply>
}

/** The phone's token, or a transport chosen by selectGitHub. */
export type GitHubAuth = string | GitHubTransport

/** The bring-your-own-token transport: direct browser calls with the bearer. */
export function githubTokenTransport(token: string): GitHubTransport {
  return {
    via: 'token',
    deadlineMs: 30_000,
    async send(method, path, body, opts, signal) {
      try {
        return await fetch(`${API}${path}`, {
          method,
          signal,
          headers: {
            Accept: opts.accept ?? 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2026-03-10',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        })
      } catch {
        throw new GitHubError('network', 'GitHub unreachable')
      }
    },
  }
}

/** What the broker's `POST /v1/native/github/call` takes. */
export interface GitHubHostRequest {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
}

/**
 * The paired host's transport. `post` sends one request to the broker route
 * and resolves GitHub's `{status, body}`; a broker-side failure (refused,
 * busy, signed out, unreachable) it throws as a GitHubError itself. No header
 * travels, so the readme comes back as GitHub's default JSON and is decoded
 * here into the raw text the token path gets.
 */
export function githubHostTransport(post: (request: GitHubHostRequest) => Promise<{ status: number; body: unknown }>): GitHubTransport {
  return {
    via: 'host',
    // The broker's own gh timeout is 30 s; the hop to it rides on top.
    deadlineMs: 45_000,
    async send(method, path, body, opts) {
      if (method !== 'GET' && method !== 'POST') throw new GitHubError('permission', 'The paired host does not make that GitHub call')
      const reply = await post({ method, path, ...(body !== undefined ? { body } : {}) })
      const payload = reply.body
      return {
        status: reply.status,
        text: async () => opts.raw === true ? readmeText(payload)
          : typeof payload === 'string' ? payload : payload === null || payload === undefined ? '' : JSON.stringify(payload),
        json: async () => payload ?? null,
      }
    },
  }
}

/** A readme's text from GitHub's JSON form (`content`, base64). */
function readmeText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  const p = payload as { content?: unknown; encoding?: unknown } | null
  if (!p || typeof p.content !== 'string' || p.encoding !== 'base64') return ''
  try {
    const binary = atob(p.content.replace(/\s+/g, ''))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

/**
 * The paired host's GitHub, as selection sees it: a cached answer (null while
 * unknown), a probe that settles it, and the transport to use when it is on.
 */
export interface GitHubHostAccess {
  known(): boolean | null
  check(): Promise<boolean>
  transport(): GitHubTransport | null
  label(): string | null
}

export interface GitHubSelection {
  via: 'host' | 'token'
  auth: GitHubAuth
  /** The host's label when the host provides GitHub. */
  hostLabel: string | null
}

/**
 * The one selection rule (HOST-GITHUB-PLAN): a paired host with GitHub
 * available, else the token saved on the phone, else nothing.
 */
export async function selectGitHub(host: GitHubHostAccess | null | undefined, token: string): Promise<GitHubSelection | null> {
  if (host && await host.check().catch(() => false)) {
    const transport = host.transport()
    if (transport) return { via: 'host', auth: transport, hostLabel: host.label() }
  }
  return token ? { via: 'token', auth: token, hostLabel: null } : null
}

/** The same rule on what is known now (no probe): for gates and copy. */
export function selectGitHubNow(host: GitHubHostAccess | null | undefined, token: string): GitHubSelection | null {
  const transport = host?.known() === true ? host.transport() : null
  if (host && transport) return { via: 'host', auth: transport, hostLabel: host.label() }
  return token ? { via: 'token', auth: token, hostLabel: null } : null
}

const transportOf = (auth: GitHubAuth): GitHubTransport => typeof auth === 'string' ? githubTokenTransport(auth) : auth

async function call<T>(
  auth: GitHubAuth,
  method: string,
  path: string,
  body?: unknown,
  allow404 = false,
  opts: GitHubCallOptions = {},
): Promise<T> {
  const transport = transportOf(auth)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      callResponse<T>(transport, method, path, body, allow404, opts, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new GitHubError('network', 'GitHub request deadline exceeded (outcome unconfirmed)'))
          controller.abort()
        }, transport.deadlineMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function callResponse<T>(
  transport: GitHubTransport, method: string, path: string, body: unknown,
  allow404: boolean, opts: GitHubCallOptions, signal: AbortSignal,
): Promise<T> {
  const res = await transport.send(method, path, body, opts, signal)
  if (res.status === 401) throw new GitHubError('auth', 'GitHub rejected the token')
  if (res.status === 403 || res.status === 429) {
    const text = await res.text().catch(() => '')
    if (res.status === 429 || /rate ?limit/i.test(text)) {
      throw new GitHubError('quota', 'GitHub rate or usage limit')
    }
    // 403 with the token accepted: missing scope/permission (fine-grained
    // tokens without "Repository creation" land here), or a suspended org.
    throw new GitHubError('permission', 'The token is missing permission for that')
  }
  if (res.status === 422) throw new GitHubError('exists', 'That repository name is taken or invalid')
  if (res.status === 404 && allow404) return null as T
  if (!(res.status >= 200 && res.status < 300)) throw new GitHubError('service', `GitHub HTTP ${res.status}`)
  if (opts.raw === true) return (await res.text()) as T
  return (await res.json().catch(() => null)) as T
}

/** Verify a token; returns the account login (and display name if set). */
export async function githubUser(auth: GitHubAuth): Promise<GitHubUser> {
  const body = await call<Record<string, unknown>>(auth, 'GET', '/user')
  const login = pickString(body?.login)
  if (!login) throw new GitHubError('service', 'GitHub returned no account')
  return { login, name: pickString(body?.name) }
}

/** Repositories the account can build on, newest push first, forks hidden. */
export async function githubRepos(auth: GitHubAuth): Promise<GitHubRepo[]> {
  const rows: Array<Record<string, unknown>> = []
  for (let page = 1; page <= 50; page++) {
    const body = await call<Array<Record<string, unknown>>>(
      auth, 'GET', `/user/repos?per_page=100&sort=pushed&direction=desc&page=${page}`)
    if (!Array.isArray(body)) throw new GitHubError('service', 'Repository discovery is incomplete (malformed page)')
    rows.push(...body)
    if (body.length < 100) return [...new Map(rows
    .filter((r) => !r.fork)
    .map((r) => ({
      fullName: pickString(r.full_name),
      url: pickString(r.html_url),
      private: r.private === true,
      pushedAt: pickString(r.pushed_at),
    }))
    .filter((r) => r.fullName && r.url).map(r => [r.fullName.toLowerCase(), r])).values()]
  }
  throw new GitHubError('service', 'Repository discovery exceeded its safety bound; destination must be resolved explicitly')
}

/** Create a repository under the account and return it, ready to build on. */
export async function githubCreateRepo(
  auth: GitHubAuth,
  name: string,
  isPrivate: boolean,
): Promise<GitHubCreatedRepo> {
  // The host creates private repositories only (its allowlist refuses a
  // public create), so a public one is refused here, before anything is sent.
  if (typeof auth !== 'string' && auth.via === 'host' && !isPrivate) {
    throw new GitHubError('permission', 'The paired host creates private repositories only')
  }
  const body = await call<Record<string, unknown>>(auth, 'POST', '/user/repos', {
    name,
    description: 'Built by Spriite',
    private: isPrivate,
    auto_init: true,
  })
  const fullName = pickString(body?.full_name)
  const url = pickString(body?.html_url)
  if (!fullName || !url) throw new GitHubError('service', 'GitHub returned no repository')
  return { fullName, url }
}

/**
 * Does the account already have a repository with this exact name?
 *
 * Used to reconcile a create whose outcome was never observed (a transport
 * timeout, or the process dying between the request and the response). The
 * name is deterministic, so the repository's existence IS the evidence that
 * the create landed — and adopting it is what keeps a retry from creating a
 * near-duplicate (`name-2`).
 *
 * A lookup that cannot complete THROWS: "could not tell" must never be read
 * as "not created", or the retry would create a second repository.
 */
export async function githubFindRepo(auth: GitHubAuth, name: string, account?: string, isPrivate?: boolean): Promise<GitHubCreatedRepo | null> {
  const user = await githubUser(auth)
  if (account && user.login.toLowerCase() !== account.toLowerCase()) {
    throw new GitHubError('permission', 'The dispatched repository belongs to a different account')
  }
  const body = await call<Record<string, unknown> | null>(
    auth,
    'GET',
    `/repos/${encodeURIComponent(user.login)}/${encodeURIComponent(name)}`,
    undefined,
    true,
  )
  if (body === null) return null
  const fullName = pickString(body.full_name)
  const url = pickString(body.html_url)
  if (!fullName || !url || fullName.toLowerCase() !== `${user.login}/${name}`.toLowerCase() ||
    (isPrivate !== undefined && body.private !== isPrivate)) {
    throw new GitHubError('service', 'Repository lookup did not match the dispatched identity')
  }
  return { fullName, url, private: body.private === true }
}

/** Independent repository/ref evidence, not a branch string from model prose. */
export async function githubRepositoryBase(auth: GitHubAuth, repository: string, selectedRef?: string): Promise<{ ref: string; sha: string; repositoryId: number }> {
  const metadata = await call<{ id?: unknown; full_name?: unknown; default_branch?: unknown }>(auth, 'GET', `/repos/${enc(repository)}`)
  if (typeof metadata?.full_name !== 'string' || metadata.full_name.toLowerCase() !== repository.toLowerCase() ||
    typeof metadata.id !== 'number' || !Number.isSafeInteger(metadata.id) || metadata.id <= 0) {
    throw new GitHubError('service', 'Repository identity could not be independently verified')
  }
  const ref = selectedRef ?? metadata.default_branch
  if (typeof ref !== 'string' || !ref || ref.trim() !== ref || /[\s~^:?*[\]\\]/.test(ref) || ref.includes('..')) {
    throw new GitHubError('service', 'Repository base is unavailable; no branch was guessed')
  }
  const branch = await call<{ commit?: { sha?: unknown } }>(auth, 'GET', `/repos/${enc(repository)}/branches/${encodeURIComponent(ref)}`)
  const sha = branch?.commit?.sha
  if (typeof sha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) {
    throw new GitHubError('service', 'Repository base commit is unavailable; execution is held')
  }
  return { ref, sha, repositoryId: metadata.id }
}

export async function githubBranchEvidence(auth: GitHubAuth, repository: string, branch: string, baseRef: string): Promise<{ headSha: string; baseSha: string }> {
  const read = (ref: string) => call<{ commit?: { sha?: unknown } }>(auth, 'GET', `/repos/${enc(repository)}/branches/${encodeURIComponent(ref)}`)
  const [head, base] = await Promise.all([read(branch), read(baseRef)])
  const sha = (v: unknown): v is string => typeof v === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(v)
  if (!sha(head?.commit?.sha) || !sha(base?.commit?.sha) || head.commit.sha === base.commit.sha) {
    throw new GitHubError('service', 'No independently verified changed branch commit')
  }
  const comparison = await call<{ status?: unknown; ahead_by?: unknown; files?: unknown[]; merge_base_commit?: { sha?: unknown } }>(
    auth, 'GET', `/repos/${enc(repository)}/compare/${base.commit.sha}...${head.commit.sha}`)
  if (comparison?.status !== 'ahead' || typeof comparison.ahead_by !== 'number' || comparison.ahead_by < 1 ||
    !Array.isArray(comparison.files) || !comparison.files.length || comparison.merge_base_commit?.sha !== base.commit.sha) {
    throw new GitHubError('service', 'Branch does not contain verified changes based on the selected base commit')
  }
  return { headSha: head.commit.sha, baseSha: base.commit.sha }
}

export async function githubPullEvidence(auth: GitHubAuth, repository: string, number: number, branch: string, baseRef: string, headSha: string, baseSha?: string): Promise<void> {
  const body = await call<{ state?: unknown; head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } }; base?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } } }>(
    auth, 'GET', `/repos/${enc(repository)}/pulls/${number}`)
  if (body?.state !== 'open' || body.head?.ref !== branch || body.head?.sha !== headSha ||
    body.base?.ref !== baseRef || (baseSha !== undefined && body.base?.sha !== baseSha) || typeof body.head?.repo?.full_name !== 'string' ||
    body.head.repo.full_name.toLowerCase() !== repository.toLowerCase() ||
    typeof body.base?.repo?.full_name !== 'string' || body.base.repo.full_name.toLowerCase() !== repository.toLowerCase()) {
    throw new GitHubError('service', 'Pull request does not match the reviewed repository/base/head commit')
  }
}

/**
 * Reads for X request context: a repository's readme, an issue, a pull
 * request, and the repository list a project-name match runs against. All
 * through the owner's own token, so a link the owner posts is opened with
 * the access the owner already granted — never an anonymous fetch.
 */
export interface GitHubRefContent {
  title: string
  body: string
}

export interface GitHubIntakeSource {
  repos(): Promise<GitHubRepo[]>
  readme(fullName: string): Promise<string | null>
  issue(fullName: string, number: number): Promise<GitHubRefContent | null>
  pull(fullName: string, number: number): Promise<GitHubRefContent | null>
}

const enc = (fullName: string): string => {
  const [owner = '', name = ''] = fullName.split('/')
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

/** A repository's readme as text, or null when it has none. */
export async function githubReadme(auth: GitHubAuth, fullName: string): Promise<string | null> {
  const text = await call<string>(auth, 'GET', `/repos/${enc(fullName)}/readme`, undefined, true, {
    accept: 'application/vnd.github.raw+json',
    raw: true,
  })
  return typeof text === 'string' && text.trim() !== '' ? text : null
}

/** One issue (title and body), or null when GitHub has none. */
export async function githubIssue(auth: GitHubAuth, fullName: string, number: number): Promise<GitHubRefContent | null> {
  const body = await call<Record<string, unknown> | null>(
    auth,
    'GET',
    `/repos/${enc(fullName)}/issues/${number}`,
    undefined,
    true,
  )
  if (body === null) return null
  const title = pickString(body.title)
  if (title === '') return null
  return { title, body: pickString(body.body) }
}

/** One pull request (title and body), or null when GitHub has none. */
export async function githubPull(auth: GitHubAuth, fullName: string, number: number): Promise<GitHubRefContent | null> {
  const body = await call<Record<string, unknown> | null>(
    auth,
    'GET',
    `/repos/${enc(fullName)}/pulls/${number}`,
    undefined,
    true,
  )
  if (body === null) return null
  const title = pickString(body.title)
  if (title === '') return null
  return { title, body: pickString(body.body) }
}

/**
 * The owner's reads through the selected transport, or null while there is
 * none: no token saved and no paired host known to be signed in to GitHub.
 * A host not yet probed reads as none (a reader that later fails would turn
 * "no GitHub" into "incomplete"), and is asked now so the next read knows.
 */
export function githubIntakeSource(tokenOf: () => string, host?: GitHubHostAccess | null): GitHubIntakeSource | null {
  const token = tokenOf()
  if (!host) {
    if (!token) return null
    return {
      repos: () => githubRepos(token),
      readme: (fullName) => githubReadme(token, fullName),
      issue: (fullName, n) => githubIssue(token, fullName, n),
      pull: (fullName, n) => githubPull(token, fullName, n),
    }
  }
  if (!token && host.known() !== true) {
    if (host.known() === null) void host.check().catch(() => false)
    return null
  }
  const auth = async (): Promise<GitHubAuth> => {
    const chosen = await selectGitHub(host, token)
    if (!chosen) throw new GitHubError('auth', 'GitHub is not connected')
    return chosen.auth
  }
  return {
    repos: async () => githubRepos(await auth()),
    readme: async (fullName) => githubReadme(await auth(), fullName),
    issue: async (fullName, n) => githubIssue(await auth(), fullName, n),
    pull: async (fullName, n) => githubPull(await auth(), fullName, n),
  }
}
