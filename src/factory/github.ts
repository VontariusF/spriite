/**
 * GitHub client (bring-your-own-token). The repository the workers build on
 * comes from the user's own GitHub: list what they have, or create a new
 * one. A personal access token with the "repo" scope (classic) or
 * "Repository creation" write permission (fine-grained) covers everything
 * here. CORS allows direct browser calls (verified).
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
}

function pickString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

async function call<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2026-03-10',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  } catch {
    throw new GitHubError('network', 'GitHub unreachable')
  }
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
  if (!res.ok) throw new GitHubError('service', `GitHub HTTP ${res.status}`)
  return (await res.json().catch(() => null)) as T
}

/** Verify a token; returns the account login (and display name if set). */
export async function githubUser(token: string): Promise<GitHubUser> {
  const body = await call<Record<string, unknown>>(token, 'GET', '/user')
  const login = pickString(body?.login)
  if (!login) throw new GitHubError('service', 'GitHub returned no account')
  return { login, name: pickString(body?.name) }
}

/** Repositories the account can build on, newest push first, forks hidden. */
export async function githubRepos(token: string): Promise<GitHubRepo[]> {
  const body = await call<Array<Record<string, unknown>>>(
    token,
    'GET',
    '/user/repos?per_page=100&sort=pushed&direction=desc',
  )
  return (Array.isArray(body) ? body : [])
    .filter((r) => !r.fork)
    .map((r) => ({
      fullName: pickString(r.full_name),
      url: pickString(r.html_url),
      private: r.private === true,
      pushedAt: pickString(r.pushed_at),
    }))
    .filter((r) => r.fullName && r.url)
}

/** Create a repository under the account and return it, ready to build on. */
export async function githubCreateRepo(
  token: string,
  name: string,
  isPrivate: boolean,
): Promise<GitHubCreatedRepo> {
  const body = await call<Record<string, unknown>>(token, 'POST', '/user/repos', {
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
