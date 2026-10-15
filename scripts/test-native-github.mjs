/**
 * Host GitHub broker half, offline with a fake gh: the exact allowlist (every
 * REST call the phone's src/factory/github.ts makes passes, everything else is
 * refused before gh runs), the forced-private create, GitHub status and JSON
 * passed through (422 exists included), bearer and origin rules shared with
 * the other /v1/native routes, the concurrency cap, the capability probe and
 * its cache, and no token in any response or log.
 *
 * Usage: node --import ./scripts/ts-resolve.mjs scripts/test-native-github.mjs
 */
import { createServer } from 'node:http'
import {
  allowedGitHubCall, createNativeGitHub, parseIncluded, GITHUB_CAPABILITY_TTL_MS, GITHUB_CALL_MAX_CONCURRENT,
  GITHUB_CAPABILITY_MISS_TTL_MS, GITHUB_PROBE_TIMEOUT_MS,
} from '../broker/native-github.mjs'
import { createProductionRunner } from '../broker/native-delivery.mjs'
import { createRouter } from '../broker/server.mjs'
import { BrokerError } from '../broker/validation.mjs'
import {
  githubUser, githubRepos, githubCreateRepo, githubFindRepo, githubRepositoryBase, githubBranchEvidence,
  githubPullEvidence, githubReadme, githubIssue, githubPull,
} from '../src/factory/github.ts'

let passed = 0, failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${detail ? ` :: ${detail}` : ''}`) }
}
const section = name => console.log(`\n-- ${name}`)
const BEARER = 'bearer-fixture-0123456789abcdefghijklmnopqrstuvwxyz'
const GH_TOKEN = 'gho_FIXTURE0TOKEN0NEVER0LEAVES0GH0000000'
const SHA_A = 'a'.repeat(40), SHA_B = 'b'.repeat(40)

const refusedCode = fn => { try { fn(); return null } catch (error) { return error instanceof BrokerError ? `${error.status}:${error.code}` : 'other' } }

/** Fake gh: `gh auth status`, `gh api /user` and `gh api --include ...` with GitHub-shaped output. */
function fakeGh({ login = 'owner-login', signedIn = true, answer = () => ({ status: 200, body: { ok: true } }), hold = null } = {}) {
  const calls = []
  const fn = async (args, options = {}) => {
    calls.push({ args, options })
    // Every channel the token could ride on carries it, so a leak would show.
    const stderr = `token ${GH_TOKEN}`
    if (args[0] === 'auth') return signedIn
      ? { status: 0, stdout: `github.com\n  Logged in to github.com account ${login}\n  Token: ${GH_TOKEN}\n`, stderr }
      : { status: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' }
    if (args[0] === 'api' && !args.includes('--include')) return signedIn
      ? { status: 0, stdout: JSON.stringify({ login, token_echo: GH_TOKEN }), stderr }
      : { status: 1, stdout: '', stderr }
    if (hold) await hold()
    if (!signedIn) return { status: 1, stdout: '', stderr: 'gh: To get started with GitHub CLI, please run:  gh auth login' }
    const path = args[args.length - 1], method = args[args.indexOf('--method') + 1]
    const reply = answer({ method, path, input: options.input })
    if (reply === null) return { status: null, stdout: '', stderr: '' }
    // gh exited without any HTTP response (DNS, reset, TLS, or signed out).
    if (reply.exit !== undefined) return { status: reply.exit, stdout: '', stderr: reply.stderr ?? '' }
    const text = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body))
    const stdout = `HTTP/2.0 ${reply.status} ${reply.status < 400 ? 'OK' : 'Error'}\r\nContent-Type: application/json\r\nX-Fixture-Token: ${GH_TOKEN}\r\n\r\n${text}`
    return { status: reply.status < 400 ? 0 : 1, stdout, stderr }
  }
  return Object.assign(fn, { calls, apiCalls: () => calls.filter(c => c.args.includes('--include')) })
}

const broker = { async capabilities() { return { qualified: false, launch: false } } }
async function serve(router) {
  const server = createServer(router)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (path, { method = 'GET', body, auth = `Bearer ${BEARER}`, headers = {} } = {}) => {
    const res = await fetch(base + path, { method,
      headers: { ...(auth ? { authorization: auth } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    return { status: res.status, text, body: text ? JSON.parse(text) : null }
  }
  return { call, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
}

section('the allowlist covers every GitHub call the phone makes')
{
  // Drive the phone's real client with a recording fetch, then hold every
  // request it made against the broker allowlist.
  const seen = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    const path = u.pathname + u.search
    seen.push({ method: init.method ?? 'GET', path, ...(init.body !== undefined ? { body: JSON.parse(init.body) } : {}) })
    const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (path === '/user') return json({ login: 'owner-login', name: 'Owner' })
    if (path.startsWith('/user/repos?')) return json([{ full_name: 'owner-login/app', html_url: 'https://github.com/owner-login/app', private: true, pushed_at: '2026-01-01' }])
    if (path === '/user/repos') return json({ full_name: 'owner-login/new-app', html_url: 'https://github.com/owner-login/new-app' })
    if (/\/branches\//.test(path)) return json({ commit: { sha: path.endsWith('/main') ? SHA_A : SHA_B } })
    if (/\/compare\//.test(path)) return json({ status: 'ahead', ahead_by: 1, files: [{}], merge_base_commit: { sha: SHA_A } })
    if (/\/pulls\//.test(path)) return json({ title: 'T', body: 'B', state: 'open', head: { ref: 'spriite/m-1', sha: SHA_B, repo: { full_name: 'owner-login/app' } }, base: { ref: 'main', sha: SHA_A, repo: { full_name: 'owner-login/app' } } })
    if (/\/issues\//.test(path)) return json({ title: 'Issue', body: 'text' })
    if (path.endsWith('/readme')) return new Response('# readme', { status: 200 })
    if (path === '/repos/owner-login/app') return json({ id: 7, full_name: 'owner-login/app', default_branch: 'main', html_url: 'https://github.com/owner-login/app', private: true })
    if (path === '/repos/owner-login/new-app') return json({ full_name: 'owner-login/new-app', html_url: 'https://github.com/owner-login/new-app', private: true })
    return new Response('{}', { status: 404 })
  }
  try {
    await githubUser('t'); await githubRepos('t'); await githubCreateRepo('t', 'new-app', true)
    await githubFindRepo('t', 'new-app', 'owner-login', true); await githubRepositoryBase('t', 'owner-login/app')
    await githubRepositoryBase('t', 'owner-login/app', 'feature/nested.ref')
    await githubBranchEvidence('t', 'owner-login/app', 'spriite/m-1', 'main')
    await githubPullEvidence('t', 'owner-login/app', 12, 'spriite/m-1', 'main', SHA_B, SHA_A)
    await githubReadme('t', 'owner-login/app'); await githubIssue('t', 'owner-login/app', 3); await githubPull('t', 'owner-login/app', 4)
  } finally { globalThis.fetch = realFetch }
  const kinds = new Set(seen.map(row => `${row.method} ${row.path.replace(/\?.*$/, '?').replace(/\/(?:[0-9]+|[0-9a-f]{40}\.\.\.[0-9a-f]{40})$/, '/N')}`))
  check('the phone client made all nine call shapes (user, listing, create, repo, branch, compare, pull, issue, readme)', seen.length >= 14 && kinds.size >= 9, [...kinds].join(', '))
  for (const row of seen) {
    const code = refusedCode(() => allowedGitHubCall(row))
    check(`allowed: ${row.method} ${row.path}`, code === null, code ?? '')
  }
  check('a slash in a branch name arrives as one encoded segment and passes', seen.some(row => row.path.endsWith('/branches/feature%2Fnested.ref')))
}

section('everything else is refused before gh runs')
{
  const refusals = [
    ['PATCH', { method: 'PATCH', path: '/repos/o/r', body: {} }],
    ['PUT', { method: 'PUT', path: '/repos/o/r/contents/x' }],
    ['DELETE', { method: 'DELETE', path: '/repos/o/r' }],
    ['lowercase method', { method: 'get', path: '/user' }],
    ['GraphQL', { method: 'POST', path: '/graphql', body: { query: '{ viewer { login } }' } }],
    ['GraphQL path without a slash', { method: 'POST', path: 'graphql', body: {} }],
    ['another POST', { method: 'POST', path: '/repos/o/r/issues', body: { title: 'x' } }],
    ['org repository create', { method: 'POST', path: '/orgs/acme/repos', body: { name: 'x', description: '', private: true, auto_init: true } }],
    ['a path outside the list', { method: 'GET', path: '/user/emails' }],
    ['an absolute URL', { method: 'GET', path: 'https://api.github.com/user' }],
    ['another host', { method: 'GET', path: '//evil.example/user' }],
    ['dot-dot traversal', { method: 'GET', path: '/repos/o/r/../../user/emails' }],
    ['an extra path segment', { method: 'GET', path: '/repos/o/r/readme/docs' }],
    ['repo contents', { method: 'GET', path: '/repos/o/r/contents/.env' }],
    ['repo listing for another user', { method: 'GET', path: '/users/someone/repos' }],
    ['a trailing slash', { method: 'GET', path: '/user/' }],
    ['a query on /user', { method: 'GET', path: '/user?per_page=1' }],
    ['an unknown query key', { method: 'GET', path: '/user/repos?per_page=100&visibility=all' }],
    ['a duplicated query key', { method: 'GET', path: '/user/repos?page=1&page=2' }],
    ['a page beyond the phone bound', { method: 'GET', path: '/user/repos?page=51' }],
    ['an out-of-range per_page', { method: 'GET', path: '/user/repos?per_page=1000' }],
    ['an empty query', { method: 'GET', path: '/user/repos?' }],
    ['a query on a repository read', { method: 'GET', path: '/repos/o/r?ref=main' }],
    ['a gh placeholder', { method: 'GET', path: '/repos/{owner}/{repo}' }],
    ['an invalid owner', { method: 'GET', path: '/repos/-bad/r' }],
    ['an over-long owner', { method: 'GET', path: `/repos/${'o'.repeat(40)}/r` }],
    ['a dot repository', { method: 'GET', path: '/repos/o/..' }],
    ['an encoded slash in a repository', { method: 'GET', path: '/repos/o/r%2Fx' }],
    ['a non-numeric pull number', { method: 'GET', path: '/repos/o/r/pulls/1abc' }],
    ['a zero issue number', { method: 'GET', path: '/repos/o/r/issues/0' }],
    ['a short compare sha', { method: 'GET', path: `/repos/o/r/compare/abc...${SHA_B}` }],
    ['a two-dot compare', { method: 'GET', path: `/repos/o/r/compare/${SHA_A}..${SHA_B}` }],
    ['a branch with dot-dot', { method: 'GET', path: '/repos/o/r/branches/a..b' }],
    ['a branch with a raw slash', { method: 'GET', path: '/repos/o/r/branches/a/b' }],
    ['a non-canonical branch encoding', { method: 'GET', path: '/repos/o/r/branches/%6Dain' }],
    ['a branch with a space', { method: 'GET', path: '/repos/o/r/branches/a%20b' }],
    ['a GET with a body', { method: 'GET', path: '/user', body: {} }],
    ['an extra top-level key', { method: 'GET', path: '/user', headers: { authorization: 'x' } }],
    ['no path', { method: 'GET' }],
    ['not an object', 'GET /user'],
    ['an array', [{ method: 'GET', path: '/user' }]],
    ['a public create', { method: 'POST', path: '/user/repos', body: { name: 'app', description: 'Built by Spriite', private: false, auto_init: true } }],
    ['a create without private', { method: 'POST', path: '/user/repos', body: { name: 'app', description: 'Built by Spriite', auto_init: true } }],
    ['private as a string', { method: 'POST', path: '/user/repos', body: { name: 'app', description: 'd', private: 'true', auto_init: true } }],
    ['auto_init false', { method: 'POST', path: '/user/repos', body: { name: 'app', description: 'd', private: true, auto_init: false } }],
    ['an extra create field', { method: 'POST', path: '/user/repos', body: { name: 'app', description: 'd', private: true, auto_init: true, visibility: 'public' } }],
    ['a template create field', { method: 'POST', path: '/user/repos', body: { name: 'app', description: 'd', private: true, auto_init: true, team_id: 1 } }],
    ['an invalid repository name', { method: 'POST', path: '/user/repos', body: { name: 'bad name', description: 'd', private: true, auto_init: true } }],
    ['a dot-dot repository name', { method: 'POST', path: '/user/repos', body: { name: '..', description: 'd', private: true, auto_init: true } }],
    ['an over-long repository name', { method: 'POST', path: '/user/repos', body: { name: 'a'.repeat(101), description: 'd', private: true, auto_init: true } }],
    ['a 351-character description', { method: 'POST', path: '/user/repos', body: { name: 'app', description: 'd'.repeat(351), private: true, auto_init: true } }],
    ['a description that is not a string', { method: 'POST', path: '/user/repos', body: { name: 'app', description: null, private: true, auto_init: true } }],
    ['a create without a body', { method: 'POST', path: '/user/repos' }],
    ['a create with a query', { method: 'POST', path: '/user/repos?org=acme', body: { name: 'app', description: 'd', private: true, auto_init: true } }],
  ]
  const gh = fakeGh()
  const github = createNativeGitHub({ gh })
  for (const [label, input] of refusals) {
    let code = null
    try { await github.call(input) } catch (error) { code = error instanceof BrokerError ? `${error.status}:${error.code}` : 'other' }
    check(`refused: ${label}`, code === '403:github_call_refused', code ?? 'allowed')
  }
  check('gh never ran for any refused call', gh.calls.length === 0, String(gh.calls.length))
  check('a 350-character description is the limit and passes', refusedCode(() => allowedGitHubCall({ method: 'POST', path: '/user/repos',
    body: { name: 'app', description: 'd'.repeat(350), private: true, auto_init: true } })) === null)
}

section('allowed calls run gh exactly, with GitHub status and JSON passed through')
{
  const gh = fakeGh({ answer: ({ method, path, input }) => {
    if (method === 'POST' && JSON.parse(input).name === 'taken') return { status: 422, body: { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] } }
    if (method === 'POST') return { status: 201, body: { full_name: 'owner-login/new-app', html_url: 'https://github.com/owner-login/new-app', private: true } }
    if (path === '/repos/owner-login/missing') return { status: 404, body: { message: 'Not Found' } }
    if (path === '/repos/owner-login/html') return { status: 502, raw: '<html>bad gateway</html>' }
    if (path === '/repos/owner-login/null') return null
    return { status: 200, body: { login: 'owner-login', path } }
  } })
  const github = createNativeGitHub({ gh })
  const user = await github.call({ method: 'GET', path: '/user' })
  check('GET /user answers GitHub\'s status and JSON', user.status === 200 && user.body.login === 'owner-login' && Object.keys(user).join() === 'status,body')
  const args = gh.apiCalls()[0].args
  check('gh runs as `api --hostname github.com --method GET --include <path>`', args.join(' ') === 'api --hostname github.com --method GET --include /user', args.join(' '))
  check('gh runs with the bounded timeout and no stdin for a read', gh.apiCalls()[0].options.timeoutMs === 30000 && gh.apiCalls()[0].options.input === undefined)
  const created = await github.call({ method: 'POST', path: '/user/repos', body: { name: 'new-app', description: 'Built by Spriite', private: true, auto_init: true } })
  const post = gh.apiCalls()[1]
  check('a private create answers 201 and the repository', created.status === 201 && created.body.full_name === 'owner-login/new-app')
  check('the create runs `--method POST --include --input - /user/repos`', post.args.join(' ') === 'api --hostname github.com --method POST --include --input - /user/repos', post.args.join(' '))
  check('the body on stdin is exactly the forced-private create', post.options.input === JSON.stringify({ name: 'new-app', description: 'Built by Spriite', private: true, auto_init: true }))
  const taken = await github.call({ method: 'POST', path: '/user/repos', body: { name: 'taken', description: 'Built by Spriite', private: true, auto_init: true } })
  check('422 "name already exists" keeps GitHub\'s status and body', taken.status === 422 && taken.body.errors[0].message === 'name already exists on this account')
  const missing = await github.call({ method: 'GET', path: '/repos/owner-login/missing' })
  check('404 passes through for the phone\'s allow404 lookups', missing.status === 404 && missing.body.message === 'Not Found')
  const html = await github.call({ method: 'GET', path: '/repos/owner-login/html' })
  check('a non-JSON GitHub body keeps the status with a null body', html.status === 502 && html.body === null)
  let code = null
  try { await github.call({ method: 'GET', path: '/repos/owner-login/null' }) } catch (error) { code = error.code }
  check('a gh timeout or oversized output is github_call_failed', code === 'github_call_failed')
  const signedOut = createNativeGitHub({ gh: fakeGh({ signedIn: false }) })
  code = null
  try { await signedOut.call({ method: 'GET', path: '/user' }) } catch (error) { code = `${error.status}:${error.code}` }
  check('gh with no login (no HTTP response) is 503 github_unavailable', code === '503:github_unavailable')
  const noAuth = createNativeGitHub({ gh: fakeGh({ answer: () => ({ exit: 4 }) }) })
  code = null
  try { await noAuth.call({ method: 'GET', path: '/user' }) } catch (error) { code = `${error.status}:${error.code}` }
  check('gh exit 4 (authentication required) is 503 github_unavailable', code === '503:github_unavailable', code ?? '')
  const blip = fakeGh({ answer: () => ({ exit: 1, stderr: 'Post "https://api.github.com/user/repos": read tcp: connection reset by peer' }) })
  const unreachable = createNativeGitHub({ gh: blip })
  for (const input of [{ method: 'GET', path: '/user' }, { method: 'POST', path: '/user/repos', body: { name: 'app', description: 'd', private: true, auto_init: true } }]) {
    code = null
    try { await unreachable.call(input) } catch (error) { code = `${error.status}:${error.code}` }
    check(`a ${input.method} gh could not get through (no HTTP response, not signed out) is 502 github_unreachable, not signed out`, code === '502:github_unreachable', code ?? '')
  }
  check('parseIncluded reads an LF-only response and an empty body', JSON.stringify(parseIncluded('HTTP/1.1 204 No Content\nA: b\n\n')) === '{"status":204,"body":null}')
  code = null
  try { parseIncluded(`HTTP/2.0 200 OK\n\n"${'x'.repeat(1048576)}"`) } catch (error) { code = error.code }
  check('a GitHub body over the 1 MB cap is refused', code === 'github_response_too_large')
}

section('the concurrency cap answers 429')
{
  let release
  const gate = new Promise(resolve => { release = resolve })
  const gh = fakeGh({ hold: () => gate })
  const github = createNativeGitHub({ gh })
  const running = Array.from({ length: GITHUB_CALL_MAX_CONCURRENT }, () => github.call({ method: 'GET', path: '/user' }))
  await new Promise(resolve => setImmediate(resolve))
  let code = null
  try { await github.call({ method: 'GET', path: '/user' }) } catch (error) { code = `${error.status}:${error.code}` }
  check('the fifth concurrent call is 429 github_call_busy', GITHUB_CALL_MAX_CONCURRENT === 4 && code === '429:github_call_busy', code ?? '')
  check('the refused call never reached gh', gh.apiCalls().length === 4)
  release()
  const done = await Promise.all(running)
  check('the four running calls complete', done.every(row => row.status === 200))
  check('a slot frees once a call finishes', (await github.call({ method: 'GET', path: '/user' })).status === 200)
}

section('the capability comes from gh and is cached for 5 minutes')
{
  let clock = 1000
  const gh = fakeGh({ login: 'owner-login' })
  const github = createNativeGitHub({ gh, now: () => clock })
  const first = await github.capability()
  check('available and login come from gh auth status + gh api /user', first.available === true && first.login === 'owner-login' && Object.keys(first).join() === 'available,login')
  check('the probe asks only about github.com', gh.calls[0].args.join(' ') === 'auth status --hostname github.com' &&
    gh.calls[1].args.join(' ') === 'api --hostname github.com /user')
  check('each probe step is bounded at 5 s, under the phone\'s 15 s capabilities timeout',
    GITHUB_PROBE_TIMEOUT_MS === 5000 && gh.calls.slice(0, 2).every(c => c.options.timeoutMs === GITHUB_PROBE_TIMEOUT_MS))
  await Promise.all([github.capability(), github.capability()])
  clock += GITHUB_CAPABILITY_TTL_MS - 1
  await github.capability()
  check('within 5 minutes the cached answer is reused', gh.calls.length === 2 && GITHUB_CAPABILITY_TTL_MS === 300000)
  clock += 2
  await github.capability()
  check('after 5 minutes gh is asked again', gh.calls.length === 4)
  const outGh = fakeGh({ signedIn: false })
  const outGitHub = createNativeGitHub({ gh: outGh, now: () => clock })
  const out = await outGitHub.capability()
  check('a signed-out gh reads as unavailable with no login', out.available === false && out.login === null)
  clock += GITHUB_CAPABILITY_MISS_TTL_MS - 1
  await outGitHub.capability()
  check('a no is reused within 30 s', outGh.calls.length === 1 && GITHUB_CAPABILITY_MISS_TTL_MS === 30000)
  clock += 2
  await outGitHub.capability()
  check('a no is asked again after 30 s, not 5 minutes', outGh.calls.length === 2)
  const odd = await createNativeGitHub({ gh: fakeGh({ login: 'not a login; rm -rf' }) }).capability()
  check('a malformed login reads as unavailable', odd.available === false && odd.login === null)
  const thrown = await createNativeGitHub({ gh: async () => { throw new Error(GH_TOKEN) } }).capability()
  check('a runner that throws reads as unavailable', thrown.available === false && !JSON.stringify(thrown).includes(GH_TOKEN))
  const concurrent = fakeGh()
  const once = createNativeGitHub({ gh: concurrent })
  await Promise.all([once.capability(), once.capability(), once.capability()])
  check('concurrent first probes share one gh run', concurrent.calls.length === 2)
}

section('the broker routes: auth, origin, capability and the call')
{
  const logs = []
  const gh = fakeGh({ answer: ({ method }) => method === 'POST'
    ? { status: 422, body: { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] } }
    : { status: 200, body: { login: 'owner-login' } } })
  const github = createNativeGitHub({ gh })
  const { call, close } = await serve(createRouter({ broker, bearerToken: BEARER, allowedOrigins: ['https://phone.example'], github, log: line => logs.push(line) }))
  const texts = []
  const record = r => { texts.push(r.text); return r }
  try {
    const caps = record(await call('/v1/native/capabilities'))
    check('capabilities gain github { available, login }', caps.status === 200 && caps.body.github?.available === true &&
      caps.body.github.login === 'owner-login' && caps.body.qualified === false, caps.text)
    const ok = record(await call('/v1/native/github/call', { method: 'POST', body: { method: 'GET', path: '/user' } }))
    check('POST /v1/native/github/call answers { status, body }', ok.status === 200 && ok.body.status === 200 && ok.body.body.login === 'owner-login', ok.text)
    const exists = record(await call('/v1/native/github/call', { method: 'POST', body: { method: 'POST', path: '/user/repos', body: { name: 'taken', description: 'Built by Spriite', private: true, auto_init: true } } }))
    check('422 exists passes through the route', exists.status === 200 && exists.body.status === 422 && /already exists/.test(exists.body.body.errors[0].message))
    const before = gh.calls.length
    const pub = record(await call('/v1/native/github/call', { method: 'POST', body: { method: 'POST', path: '/user/repos', body: { name: 'app', description: 'd', private: false, auto_init: true } } }))
    check('a public create through the route is 403 github_call_refused', pub.status === 403 && pub.body.error === 'github_call_refused')
    const gql = record(await call('/v1/native/github/call', { method: 'POST', body: { method: 'POST', path: '/graphql', body: {} } }))
    check('GraphQL through the route is 403 and gh did not run', gql.status === 403 && gh.calls.length === before)
    check('the call route needs the bearer, like capabilities', (await call('/v1/native/github/call', { method: 'POST', body: { method: 'GET', path: '/user' }, auth: null })).status === 401 &&
      (await call('/v1/native/capabilities', { auth: null })).status === 401)
    check('a wrong bearer is refused', (await call('/v1/native/github/call', { method: 'POST', body: { method: 'GET', path: '/user' }, auth: `Bearer ${'x'.repeat(BEARER.length)}` })).status === 401)
    check('GET on the call route is not a route', (await call('/v1/native/github/call')).status === 404)
    check('a query string is not the call route', (await call('/v1/native/github/call?x=1', { method: 'POST', body: { method: 'GET', path: '/user' } })).status === 404)
    check('a non-JSON content type is refused', (await call('/v1/native/github/call', { method: 'POST', headers: { 'content-type': 'text/plain' } })).status === 415)
    const foreign = await call('/v1/native/github/call', { method: 'POST', body: { method: 'GET', path: '/user' }, headers: { origin: 'https://untrusted.example' } })
    const foreignCaps = await call('/v1/native/capabilities', { headers: { origin: 'https://untrusted.example' } })
    check('an untrusted origin is refused exactly as on capabilities', foreign.status === 403 && foreign.body.error === 'origin_forbidden' &&
      foreignCaps.status === 403 && foreignCaps.body.error === 'origin_forbidden')
    check('an allowed origin passes', (await call('/v1/native/github/call', { method: 'POST', body: { method: 'GET', path: '/user' }, headers: { origin: 'https://phone.example' } })).status === 200)
    check('the CORS preflight admits the call route', (await call('/v1/native/github/call', { method: 'OPTIONS', auth: null, headers: { origin: 'https://phone.example' } })).status === 200)
    check('the CORS preflight still refuses other GitHub-ish routes', (await call('/v1/native/github/proxy', { method: 'OPTIONS', auth: null, headers: { origin: 'https://phone.example' } })).status === 404)
    check('the bearer never reaches gh', !gh.calls.some(c => JSON.stringify(c).includes(BEARER)))
  } finally { await close() }
  check('no response carries the gh token, its stderr or its headers', !texts.some(t => t.includes(GH_TOKEN) || /x-fixture-token|token_echo|Logged in/i.test(t)))
  check('no log line carries the gh token', !logs.some(line => line.includes(GH_TOKEN)))

  const bare = await serve(createRouter({ broker, bearerToken: BEARER, log: () => {} }))
  try {
    const caps = await bare.call('/v1/native/capabilities')
    check('a broker without host GitHub reports github unavailable', caps.body.github?.available === false && caps.body.github.login === null)
    const r = await bare.call('/v1/native/github/call', { method: 'POST', body: { method: 'GET', path: '/user' } })
    check('the call route answers 503 github_unavailable without host GitHub', r.status === 503 && r.body.error === 'github_unavailable')
  } finally { await bare.close() }

  let probes = 0
  const flaky = { capability: async () => { probes++; throw new Error(GH_TOKEN) }, call: async () => ({ status: 200, body: null }) }
  const f = await serve(createRouter({ broker, bearerToken: BEARER, github: flaky, log: () => {} }))
  try {
    const caps = await f.call('/v1/native/capabilities')
    check('a failing capability probe never fails capabilities or leaks', caps.status === 200 && caps.body.github.available === false && probes === 1 && !caps.text.includes(GH_TOKEN))
  } finally { await f.close() }

  // A gh that hangs never holds the native capabilities past the wait.
  let finish
  const slowGh = fakeGh()
  const slow = createNativeGitHub({ gh: async (args, options) => { if (args[0] === 'auth') await new Promise(resolve => { finish = resolve }); return slowGh(args, options) } })
  const s = await serve(createRouter({ broker, bearerToken: BEARER, github: slow, githubCapabilityWaitMs: 50, log: () => {} }))
  try {
    const started = Date.now()
    const caps = await s.call('/v1/native/capabilities')
    check('a hung gh probe: capabilities still answers in time, github unavailable for now', caps.status === 200 && caps.body.qualified === false &&
      caps.body.github.available === false && Date.now() - started < 2000, caps.text)
    finish()
    await new Promise(resolve => setTimeout(resolve, 20))
    const later = await s.call('/v1/native/capabilities')
    check('once the probe settles, its answer is served from the cache', later.body.github.available === true && later.body.github.login === 'owner-login')
  } finally { await s.close() }
}

section('the production runner feeds stdin for --input -')
{
  const seen = []
  const port = (bin, args, options, callback) => {
    const child = { stdin: { on: (event) => seen.push(`on:${event}`), end: input => seen.push(`end:${input}`) } }
    queueMicrotask(() => callback(null, 'HTTP/2.0 201 Created\n\n{}', ''))
    return child
  }
  const run = createProductionRunner('/usr/bin/gh', { execFilePort: port, env: { PATH: '/bin', HOME: '/h' } })
  const result = await run(['api', '--input', '-', '/user/repos'], { timeoutMs: 1000, input: '{"name":"x"}' })
  check('the input is written to stdin and closed, with an error guard', result.status === 0 && seen.join() === 'on:error,end:{"name":"x"}', seen.join())
  seen.length = 0
  await run(['api', '/user'], { timeoutMs: 1000 })
  check('a read leaves stdin alone', seen.length === 0)
  const refused = await run(['api'], { timeoutMs: 1000, input: 42 })
  check('a non-string input is refused without spawning', refused.status === null && seen.length === 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) { console.log('NATIVE GITHUB TESTS FAILED'); process.exitCode = 1 } else console.log('NATIVE GITHUB TESTS PASSED')
