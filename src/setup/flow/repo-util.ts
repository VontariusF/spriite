/**
 * Repository helpers for the Repo step: read any pasted GitHub link without
 * a GitHub or Cursor key, and the board's "Private · updated today" meta.
 *
 * No runtime imports and erasable-only syntax.
 */

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})'
const NAME = '[A-Za-z0-9._-]{1,100}'
const HTTP_FORM = new RegExp(`^(?:https?://)?(?:www\\.)?github\\.com/(${OWNER})/(${NAME})(?:/.*)?$`, 'i')
const SSH_FORM = new RegExp(`^git@github\\.com:(${OWNER})/(${NAME})$`, 'i')

/**
 * Any GitHub repository link -> "https://github.com/owner/name", or null.
 * Accepts https or bare, www, a trailing ".git" or slash, a deeper path
 * (/tree/main, /pulls) and the ssh form.
 */
export function parseGithubUrl(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  const m = HTTP_FORM.exec(text) ?? SSH_FORM.exec(text)
  if (!m) return null
  const owner = m[1]
  const name = m[2].replace(/\.git$/i, '')
  if (!name || name === '.' || name === '..') return null
  return `https://github.com/${owner}/${name}`
}

/** "https://github.com/owner/name" -> "owner/name". */
export function repoFullName(url: string): string {
  const m = /github\.com\/([^/]+)\/([^/]+)/i.exec(url)
  return m ? `${m[1]}/${m[2]}` : url
}

const DAY = 86_400_000

/** today / this week / this month / last month / N months ago, from a push timestamp. */
export function repoAge(pushedAt: string, now: number): string {
  const at = Date.parse(pushedAt)
  if (!Number.isFinite(at)) return ''
  const days = Math.floor(Math.max(0, now - at) / DAY)
  if (days < 1) return 'today'
  if (days < 7) return 'this week'
  if (days < 30) return 'this month'
  if (days < 60) return 'last month'
  return `${Math.floor(days / 30)} months ago`
}

/** "Private · updated today" (the Repo board's row meta). */
export function repoMeta(repo: { private: boolean; pushedAt: string }, now: number): string {
  const vis = repo.private ? 'Private' : 'Public'
  const age = repoAge(repo.pushedAt, now)
  return age ? `${vis} · updated ${age}` : vis
}
