import { fail } from './validation.mjs'

// Host GitHub: the phone's GitHub REST calls run here, through the owner's own
// gh login, so a paired phone needs no GitHub token. This is an allowlist, not a
// proxy: only the exact reads the phone makes and the forced-private repository
// create pass, and anything else is refused before gh runs. Runner output is
// parsed, never logged; stderr and response headers never leave this module,
// because gh output can hold credentials.

export const GITHUB_CALL_TIMEOUT_MS = 30000
export const GITHUB_CALL_MAX_BYTES = 1048576
// gh --include prints the status line and headers before the body.
export const GITHUB_CALL_RUNNER_MAX_BYTES = GITHUB_CALL_MAX_BYTES + 65536
export const GITHUB_CALL_MAX_CONCURRENT = 4
export const GITHUB_CAPABILITY_TTL_MS = 300000
// A no is asked again sooner, and each probe step is bounded well under the
// phone's 15 s capabilities timeout, because the capabilities route waits on it.
export const GITHUB_CAPABILITY_MISS_TTL_MS = 30000
export const GITHUB_PROBE_TIMEOUT_MS = 5000
// How long GET /v1/native/capabilities waits on a probe before it answers
// unavailable for now; the probe keeps running and its answer is cached.
export const GITHUB_CAPABILITY_WAIT_MS = 3000
// gh's documented exit code for "authentication required".
const GH_EXIT_AUTH = 4
export const GITHUB_REPO_DESCRIPTION_MAX = 350

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const NUMBER = /^[1-9][0-9]{0,9}$/

const owner = value => OWNER.test(value)
const repo = value => REPO.test(value) && value !== '.' && value !== '..'
const number = value => NUMBER.test(value) && Number(value) <= 2147483647
const sha = value => SHA.test(value)
/** One encodeURIComponent'd branch segment (a slash in the ref arrives as %2F). */
function branch(segment) {
  if (!/^(?:[A-Za-z0-9._~!'()-]|%[0-9A-F]{2}){1,768}$/.test(segment)) return false
  let ref
  try { ref = decodeURIComponent(segment) } catch { return false }
  return encodeURIComponent(ref) === segment && ref.length <= 255 && !/[\x00-\x20\x7f~^:?*[\]\\]/.test(ref) &&
    !ref.includes('..') && !ref.includes('//') && !ref.includes('@{') && !ref.startsWith('/') && !ref.startsWith('-') &&
    !ref.endsWith('/') && !ref.endsWith('.') && !ref.endsWith('.lock')
}

const intRange = (min, max) => value => /^[0-9]{1,4}$/.test(value) && Number(value) >= min && Number(value) <= max
/**
 * The GET allowlist: every REST read src/factory/github.ts makes (the phone's
 * repository listings in the setup Repo screen, the X panel and the intake
 * source all go through githubRepos). Each path is anchored, every variable
 * segment validated, and only the listed query keys (each at most once) pass.
 */
export const GITHUB_GET_ALLOWLIST = Object.freeze([
  { name: 'user', pattern: /^\/user$/, segments: [] },
  { name: 'user_repos', pattern: /^\/user\/repos$/, segments: [], query: {
    per_page: intRange(1, 100), sort: v => ['created', 'updated', 'pushed', 'full_name'].includes(v),
    direction: v => v === 'asc' || v === 'desc', page: intRange(1, 50),
  } },
  { name: 'repo', pattern: /^\/repos\/([^/]+)\/([^/]+)$/, segments: [owner, repo] },
  { name: 'branch', pattern: /^\/repos\/([^/]+)\/([^/]+)\/branches\/([^/]+)$/, segments: [owner, repo, branch] },
  { name: 'compare', pattern: /^\/repos\/([^/]+)\/([^/]+)\/compare\/([^/.]+)\.\.\.([^/.]+)$/, segments: [owner, repo, sha, sha] },
  { name: 'pull', pattern: /^\/repos\/([^/]+)\/([^/]+)\/pulls\/([^/]+)$/, segments: [owner, repo, number] },
  { name: 'issue', pattern: /^\/repos\/([^/]+)\/([^/]+)\/issues\/([^/]+)$/, segments: [owner, repo, number] },
  { name: 'readme', pattern: /^\/repos\/([^/]+)\/([^/]+)\/readme$/, segments: [owner, repo] },
].map(row => Object.freeze(row)))

const refused = () => fail('github_call_refused', 403)

function allowedQuery(search, keys) {
  if (search === '') return true
  if (!keys) return false
  const seen = new Set()
  for (const pair of search.split('&')) {
    const match = /^([a-z_]+)=([A-Za-z0-9_]+)$/.exec(pair)
    if (!match || !Object.hasOwn(keys, match[1]) || seen.has(match[1]) || !keys[match[1]](match[2])) return false
    seen.add(match[1])
  }
  return true
}

/**
 * The exact call gh may make, or a 403 github_call_refused. GET only on the
 * allowlist without a body; POST only /user/repos with exactly
 * { name, description, private: true, auto_init: true } (githubCreateRepo).
 */
export function allowedGitHubCall(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) refused()
  if (Object.keys(input).some(key => !['method', 'path', 'body'].includes(key))) refused()
  const { method, path } = input
  if (typeof path !== 'string' || path.length > 1024 || !path.startsWith('/') || /[\s#\\{}\0]/.test(path)) refused()
  if (method === 'GET') {
    if (Object.hasOwn(input, 'body')) refused()
    const at = path.indexOf('?')
    const pathname = at === -1 ? path : path.slice(0, at), search = at === -1 ? '' : path.slice(at + 1)
    if (at !== -1 && search === '') refused()
    const rule = GITHUB_GET_ALLOWLIST.find(row => row.pattern.test(pathname))
    if (!rule) refused()
    const parts = rule.pattern.exec(pathname).slice(1)
    if (parts.length !== rule.segments.length || parts.some((part, i) => !rule.segments[i](part))) refused()
    if (!allowedQuery(search, rule.query)) refused()
    return Object.freeze({ method: 'GET', path })
  }
  if (method === 'POST') {
    if (path !== '/user/repos') refused()
    const body = input.body
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) refused()
    const keys = Object.keys(body)
    if (keys.length !== 4 || !['name', 'description', 'private', 'auto_init'].every(key => Object.hasOwn(body, key))) refused()
    // A public create is refused: a host-created repository is always private.
    if (body.private !== true || body.auto_init !== true) refused()
    if (typeof body.name !== 'string' || !repo(body.name) || /\.git$/i.test(body.name)) refused()
    if (typeof body.description !== 'string' || body.description.length > GITHUB_REPO_DESCRIPTION_MAX || /[\0\r\n]/.test(body.description)) refused()
    return Object.freeze({ method: 'POST', path, body: Object.freeze({ name: body.name, description: body.description, private: true, auto_init: true }) })
  }
  refused()
}

/** Status and JSON body from `gh api --include` output; null when there is no HTTP response in it. */
export function parseIncluded(stdout) {
  if (typeof stdout !== 'string') return null
  const status = /^HTTP\/[0-9.]+ ([1-5][0-9]{2})(?: [^\r\n]*)?\r?\n/.exec(stdout)
  if (!status) return null
  const end = /\r?\n\r?\n/.exec(stdout)
  const text = end ? stdout.slice(end.index + end[0].length) : ''
  if (Buffer.byteLength(text) > GITHUB_CALL_MAX_BYTES - 1024) fail('github_response_too_large', 502)
  let body = null
  if (text.trim() !== '') { try { body = JSON.parse(text) } catch { body = null } }
  return { status: Number(status[1]), body }
}

/**
 * Host GitHub port over a gh runner (createProductionRunner: no shell, bounded
 * output, timeout, limited env). `capability()` never throws and never carries
 * the token; `call(input)` answers GitHub's own status and parsed JSON.
 */
export function createNativeGitHub({ gh, now = () => Date.now(), ttlMs = GITHUB_CAPABILITY_TTL_MS, missTtlMs = GITHUB_CAPABILITY_MISS_TTL_MS, maxConcurrent = GITHUB_CALL_MAX_CONCURRENT }) {
  if (typeof gh !== 'function' || typeof now !== 'function') fail('native_github_ports_invalid')
  let cached = null, pending = null, active = 0
  const run = async (args, input, timeoutMs = GITHUB_CALL_TIMEOUT_MS) => {
    try { return await gh(args, { timeoutMs, ...(input !== undefined ? { input } : {}) }) }
    catch { return { status: null, stdout: '', stderr: '' } }
  }
  async function probe() {
    const status = await run(['auth', 'status', '--hostname', 'github.com'], undefined, GITHUB_PROBE_TIMEOUT_MS)
    if (status?.status !== 0) return { available: false, login: null }
    const user = await run(['api', '--hostname', 'github.com', '/user'], undefined, GITHUB_PROBE_TIMEOUT_MS)
    if (user?.status !== 0 || typeof user.stdout !== 'string') return { available: false, login: null }
    let login = null
    try { login = JSON.parse(user.stdout)?.login } catch {}
    return typeof login === 'string' && OWNER.test(login) ? { available: true, login } : { available: false, login: null }
  }
  async function capability() {
    if (cached && now() - cached.at < (cached.value.available ? ttlMs : missTtlMs)) return { ...cached.value }
    pending ??= probe().catch(() => ({ available: false, login: null })).then(value => {
      cached = { at: now(), value: Object.freeze(value) }; pending = null; return value
    })
    return { ...(await pending) }
  }
  async function call(input) {
    const allowed = allowedGitHubCall(input)
    if (active >= maxConcurrent) fail('github_call_busy', 429)
    active++
    try {
      const args = ['api', '--hostname', 'github.com', '--method', allowed.method, '--include',
        ...(allowed.method === 'POST' ? ['--input', '-'] : []), allowed.path]
      const result = await run(args, allowed.body !== undefined ? JSON.stringify(allowed.body) : undefined)
      if (!result || result.status === null) fail('github_call_failed', 502)
      const parsed = parseIncluded(result.stdout)
      if (!parsed) {
        // No HTTP response at all. Only gh's own "authentication required"
        // (exit 4, or its gh auth login hint) is a signed-out host, where nothing
        // reached GitHub. Anything else (DNS, reset, TLS) may have sent the
        // request, so it is not a definite refusal: a create stays unconfirmed.
        cached = null
        if (result.status === GH_EXIT_AUTH || /\bgh auth login\b/.test(String(result.stderr ?? ''))) fail('github_unavailable', 503)
        fail('github_unreachable', 502)
      }
      if (parsed.status === 401) cached = null
      return { status: parsed.status, body: parsed.body }
    } finally { active-- }
  }
  return Object.freeze({ capability, call })
}

/** The capability a broker without host GitHub reports. */
export const GITHUB_UNAVAILABLE = Object.freeze({ available: false, login: null })
