/**
 * Host GitHub, phone half (docs/design/HOST-GITHUB-PLAN.md), offline: the host
 * transport maps GitHub's replies to the same results and GitHubError kinds as
 * the token transport; broker failures map to the kinds the phone already
 * handles; selection order (paired host with GitHub, else the phone token,
 * else nothing); the token path unchanged when no host is wired; a new repo
 * with no phone token and a paired host creates through the host and plans;
 * with neither, the blocked prompt, the composer help and their new copy; and
 * Settings > GitHub reading "Through <host>". No network: fetch is stubbed and
 * the broker is a fake client.
 *
 * Usage: node --import ./scripts/ts-resolve.mjs scripts/test-host-github-phone.mjs
 */
import {
  GitHubError, githubUser, githubRepos, githubCreateRepo, githubFindRepo, githubRepositoryBase, githubBranchEvidence,
  githubPullEvidence, githubReadme, githubIssue, githubPull, githubHostTransport, githubIntakeSource,
  selectGitHub, selectGitHubNow,
} from '../src/factory/github.ts'
import { createGitHubHost } from '../src/factory/github-host.ts'
import { NativeBrokerError, createNativeBrokerClient, decodeGitHubCallReply } from '../src/native/client.ts'
import { decodeNativeCapabilities } from '../src/native/decode.ts'
import { liveClients, RealOrchestrator } from '../src/factory/real.ts'
import { fakeClients, FAKE } from '../src/factory/fake.ts'
import { COPY } from '../src/factory/copy.ts'
import { mountPhoneApp } from '../src/phone/app.ts'
import { KeyVault } from '../src/voice/keys.ts'
import { PrefsVault } from '../src/state/prefs.ts'
import { FeedVault } from '../src/state/feed.ts'
import { mountSetupPanel } from '../src/setup/panel.ts'
import { createRepoPicker } from '../src/setup/flow/repo.ts'
import { phoneDom, phoneFakes, makeElement, allNodes, textOf, control } from './lib/phone-dom.mjs'
import { setupDom } from './lib/setup-dom.mjs'

let passed = 0, failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${detail ? ` :: ${detail}` : ''}`) }
}
const section = name => console.log(`\n-- ${name}`)
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }

const TOKEN = 'ghp_PHONE0FIXTURE0TOKEN000000000000000'
const BEARER = 'broker-bearer-fixture-0123456789abcdef'
const BROKER = 'https://studio.tail0000.ts.net:47822'
const SHA_A = 'a'.repeat(40), SHA_B = 'b'.repeat(40)
const NEW_COPY = 'Spriite needs GitHub to create the repository. Pair with your computer (it uses its GitHub sign-in), or add a GitHub token in Settings.'

// Every network attempt this suite did not script fails loudly.
let fetchHandler = null
const fetchLog = []
globalThis.fetch = async (url, init = {}) => {
  fetchLog.push({ url: String(url), init })
  if (!fetchHandler) throw new Error(`unexpected network: ${url}`)
  return fetchHandler(String(url), init)
}

/** Outcome of a call: its value, or the GitHubError kind it threw. */
async function outcome(fn) {
  try { return { ok: true, value: JSON.stringify(await fn()) } } catch (e) {
    return { ok: false, kind: e instanceof GitHubError ? e.kind : `other:${e?.message}` }
  }
}

/**
 * GitHub's answer to a request: one table both transports read. `raw` is the
 * readme as the token path's raw Accept returns it; the host gets the JSON form.
 */
function makeGitHub(overrides = {}) {
  const readme = '# Hello\n\nUnicode stays: café ✓\n'
  const created = new Set()
  return (method, path, body) => {
    const key = `${method} ${path}`
    if (overrides[key]) return overrides[key](body)
    if (method === 'POST' && path === '/user/repos') created.add(body.name)
    const made = /^\/repos\/owner-login\/([^/]+)(\/branches\/main)?$/.exec(path)
    if (method === 'GET' && made && created.has(made[1])) return made[2]
      ? { status: 200, body: { commit: { sha: SHA_A } } }
      : { status: 200, body: { id: 90, full_name: `owner-login/${made[1]}`, default_branch: 'main', private: true, html_url: `https://github.com/owner-login/${made[1]}` } }
    if (key === 'GET /user') return { status: 200, body: { login: 'owner-login', name: 'Owner' } }
    if (key.startsWith('GET /user/repos?')) return { status: 200, body: [
      { full_name: 'owner-login/alpha', html_url: 'https://github.com/owner-login/alpha', private: true, pushed_at: '2026-10-01T00:00:00Z' },
      { full_name: 'owner-login/forked', html_url: 'https://github.com/owner-login/forked', fork: true },
    ] }
    if (key === 'POST /user/repos') return { status: 201, body: { full_name: `owner-login/${body.name}`, html_url: `https://github.com/owner-login/${body.name}`, private: body.private } }
    if (key === 'GET /repos/owner-login/alpha') return { status: 200, body: { id: 77, full_name: 'owner-login/alpha', default_branch: 'main', private: true, html_url: 'https://github.com/owner-login/alpha' } }
    if (key === 'GET /repos/owner-login/missing') return { status: 404, body: { message: 'Not Found' } }
    if (key === 'GET /repos/owner-login/alpha/branches/main') return { status: 200, body: { commit: { sha: SHA_A } } }
    if (key === 'GET /repos/owner-login/alpha/branches/spriite%2Fwork') return { status: 200, body: { commit: { sha: SHA_B } } }
    if (key === `GET /repos/owner-login/alpha/compare/${SHA_A}...${SHA_B}`) return { status: 200, body: { status: 'ahead', ahead_by: 1, files: [{}], merge_base_commit: { sha: SHA_A } } }
    if (key === 'GET /repos/owner-login/alpha/pulls/5') return { status: 200, body: { state: 'open', title: 'PR five', body: 'pr body',
      head: { ref: 'spriite/work', sha: SHA_B, repo: { full_name: 'owner-login/alpha' } }, base: { ref: 'main', sha: SHA_A, repo: { full_name: 'owner-login/alpha' } } } }
    if (key === 'GET /repos/owner-login/alpha/issues/3') return { status: 200, body: { title: 'Issue three', body: 'issue body' } }
    if (key === 'GET /repos/owner-login/alpha/issues/4') return { status: 404, body: { message: 'Not Found' } }
    if (key === 'GET /repos/owner-login/alpha/readme') return { status: 200, raw: readme,
      body: { encoding: 'base64', content: Buffer.from(readme, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n') } }
    return { status: 404, body: { message: 'Not Found' } }
  }
}

/** The token path: GitHub over the stubbed fetch, with the raw readme when asked. */
function tokenPath(github) {
  fetchHandler = (url, init) => {
    const path = url.replace('https://api.github.com', '')
    const reply = github(init.method, path, init.body ? JSON.parse(init.body) : undefined)
    const raw = String(init.headers?.Accept ?? '').includes('raw')
    const text = raw && reply.raw !== undefined ? reply.raw : reply.body === undefined ? '' : JSON.stringify(reply.body)
    return new Response(reply.status === 204 ? null : text, { status: reply.status })
  }
}
/** The host path: the same table, through the broker route's `{status, body}`. */
function hostPath(github, log = []) {
  return githubHostTransport(async (request) => {
    log.push(request)
    const reply = github(request.method, request.path, request.body)
    return { status: reply.status, body: reply.body === undefined ? null : reply.body }
  })
}

const CALLS = [
  ['user', a => githubUser(a)],
  ['repos', a => githubRepos(a)],
  ['create', a => githubCreateRepo(a, 'fresh-idea', true)],
  ['find existing', a => githubFindRepo(a, 'alpha', 'owner-login', true)],
  ['find missing', a => githubFindRepo(a, 'missing')],
  ['find other account', a => githubFindRepo(a, 'alpha', 'someone-else')],
  ['repository base', a => githubRepositoryBase(a, 'owner-login/alpha')],
  ['branch evidence', a => githubBranchEvidence(a, 'owner-login/alpha', 'spriite/work', 'main')],
  ['pull evidence', a => githubPullEvidence(a, 'owner-login/alpha', 5, 'spriite/work', 'main', SHA_B, SHA_A)],
  ['pull evidence mismatch', a => githubPullEvidence(a, 'owner-login/alpha', 5, 'spriite/other', 'main', SHA_B)],
  ['readme', a => githubReadme(a, 'owner-login/alpha')],
  ['readme missing', a => githubReadme(a, 'owner-login/missing')],
  ['issue', a => githubIssue(a, 'owner-login/alpha', 3)],
  ['issue missing', a => githubIssue(a, 'owner-login/alpha', 4)],
  ['pull', a => githubPull(a, 'owner-login/alpha', 5)],
]

section('host transport: same results and errors as the token transport')
{
  const github = makeGitHub()
  for (const [name, fn] of CALLS) {
    tokenPath(github)
    const viaToken = await outcome(() => fn(TOKEN))
    fetchHandler = null
    const before = fetchLog.length
    const viaHost = await outcome(() => fn(hostPath(github)))
    check(`${name}: host and token agree (${viaToken.ok ? 'value' : viaToken.kind})`,
      JSON.stringify(viaToken) === JSON.stringify(viaHost), `token=${JSON.stringify(viaToken)} host=${JSON.stringify(viaHost)}`)
    check(`${name}: the host path makes no direct GitHub request`, fetchLog.length === before)
  }
  const readme = await githubReadme(hostPath(github), 'owner-login/alpha')
  check('the host readme is decoded from base64 JSON into the raw text', readme?.startsWith('# Hello') && readme.includes('café ✓'))

  const statuses = [
    [401, { message: 'Bad credentials' }, 'auth'],
    [403, { message: 'Resource not accessible by integration' }, 'permission'],
    [403, { message: 'API rate limit exceeded for user' }, 'quota'],
    [429, { message: 'Too many requests' }, 'quota'],
    [422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] }, 'exists'],
    [500, { message: 'Server Error' }, 'service'],
    [502, null, 'service'],
  ]
  for (const [status, body, kind] of statuses) {
    const failing = makeGitHub({ 'POST /user/repos': () => ({ status, body }) })
    tokenPath(failing)
    const viaToken = await outcome(() => githubCreateRepo(TOKEN, 'taken', true))
    fetchHandler = null
    const viaHost = await outcome(() => githubCreateRepo(hostPath(failing), 'taken', true))
    check(`create ${status}${kind === 'quota' && status === 403 ? ' rate limit' : ''} reads ${kind} on both paths`,
      viaToken.kind === kind && viaHost.kind === kind, `token=${viaToken.kind} host=${viaHost.kind}`)
  }
  const log = []
  await githubCreateRepo(hostPath(github, log), 'fresh-idea', true)
  check('the host create sends exactly { name, description, private: true, auto_init: true }',
    JSON.stringify(log[0]) === JSON.stringify({ method: 'POST', path: '/user/repos', body: { name: 'fresh-idea', description: 'Built by Spriite', private: true, auto_init: true } }))
  const pub = await outcome(() => githubCreateRepo(hostPath(github, log), 'public-one', false))
  check('a public create through the host is refused before anything is sent', !pub.ok && pub.kind === 'permission' && log.length === 1)
  const verb = await outcome(() => hostPath(github).send('DELETE', '/repos/owner-login/alpha', undefined, {}, new AbortController().signal))
  check('a method the host does not relay is refused locally', !verb.ok && verb.kind === 'permission')
  const sent = []
  await githubRepos(hostPath(github, sent))
  check('the host GET carries no body key', sent.every(r => !('body' in r)) && sent[0].path === '/user/repos?per_page=100&sort=pushed&direction=desc&page=1')
}

section('token transport unchanged')
{
  const github = makeGitHub()
  tokenPath(github)
  fetchLog.length = 0
  await githubCreateRepo(TOKEN, 'fresh-idea', false)
  const req = fetchLog[0]
  check('a string is the token transport: direct GitHub call with the bearer and API headers',
    req.url === 'https://api.github.com/user/repos' && req.init.method === 'POST' &&
    req.init.headers.Authorization === `Bearer ${TOKEN}` && req.init.headers.Accept === 'application/vnd.github+json' &&
    req.init.headers['X-GitHub-Api-Version'] === '2026-03-10' && req.init.headers['Content-Type'] === 'application/json' &&
    req.init.body === JSON.stringify({ name: 'fresh-idea', description: 'Built by Spriite', private: false, auto_init: true }))
  fetchHandler = () => { throw new TypeError('offline') }
  const offline = await outcome(() => githubUser(TOKEN))
  check('an unreachable GitHub is still a network error on the token path', offline.kind === 'network')
  fetchHandler = null
}

/** A fake broker for createGitHubHost: capabilities and the GitHub route, both recorded. */
function fakeBroker({ github = { available: true, login: 'owner-login' }, answer = makeGitHub(), fail = null } = {}) {
  const calls = { capabilities: 0, github: [], credentials: [] }
  const client = (brokerUrl, credential) => ({
    async capabilities() {
      calls.capabilities++
      calls.credentials.push(credential())
      if (github instanceof Error) throw github
      return { protocolVersion: 1, qualified: false, ...(github ? { github } : {}) }
    },
    async githubCall(request) {
      calls.github.push({ brokerUrl, request, credential: credential() })
      if (fail) throw fail(request)
      const reply = answer(request.method, request.path, request.body)
      return { status: reply.status, body: reply.body ?? null }
    },
  })
  return { calls, client }
}
function hostFor(broker, { paired = true, bearer = BEARER, now } = {}) {
  const state = { paired, bearer, label: 'Studio Mac' }
  const host = createGitHubHost({
    host: () => state.paired ? { brokerUrl: BROKER, label: state.label } : null,
    credential: (url) => url === BROKER ? state.bearer : '',
    client: broker.client,
    ...(now ? { now } : {}),
  })
  return { host, state }
}

section('broker capability and failures')
{
  const caps = decodeNativeCapabilities({ protocolVersion: 1, qualificationId: null, transportVersion: 't', qualified: true, launch: true,
    rootAttention: true, childAttention: true, recoverAttention: true, pause: true, resume: true, cancel: true,
    github: { available: true, login: 'owner-login', token: 'gho_leak' } })
  check('the capability decode keeps available and login only', JSON.stringify(caps.github) === JSON.stringify({ available: true, login: 'owner-login' }))
  const bad = decodeNativeCapabilities({ protocolVersion: 1, qualificationId: null, transportVersion: 't', qualified: true, launch: true,
    rootAttention: true, childAttention: true, recoverAttention: true, pause: true, resume: true, cancel: true,
    github: { available: true, login: 'bad login!' } })
  check('a malformed github block reads as absent, never available', bad !== null && bad.github === undefined)
  const noLogin = decodeNativeCapabilities({ protocolVersion: 1, qualificationId: null, transportVersion: 't', qualified: true, launch: true,
    rootAttention: true, childAttention: true, recoverAttention: true, pause: true, resume: true, cancel: true,
    github: { available: true, login: null } })
  check('available without a login reads as unavailable', noLogin.github.available === false)
  check('the route reply decode keeps status and body only', JSON.stringify(decodeGitHubCallReply({ status: 422, body: { m: 1 }, headers: { x: 1 } })) === JSON.stringify({ status: 422, body: { m: 1 } }) &&
    decodeGitHubCallReply({ status: 'x' }) === null && decodeGitHubCallReply({ status: 99 }) === null)

  // The HTTP client posts to the one route with the bearer, nothing else.
  const seen = []
  const http = createNativeBrokerClient({ brokerUrl: BROKER, credential: () => BEARER,
    fetch: async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify({ status: 201, body: { full_name: 'o/r' } }), { status: 200 }) } })
  const reply = await http.githubCall({ method: 'POST', path: '/user/repos', body: { name: 'r' } })
  check('the HTTP client posts { method, path, body } to /v1/native/github/call with the bearer',
    seen[0].url === `${BROKER}/v1/native/github/call` && seen[0].init.method === 'POST' && seen[0].init.headers.Authorization === `Bearer ${BEARER}` &&
    seen[0].init.body === JSON.stringify({ method: 'POST', path: '/user/repos', body: { name: 'r' } }) && seen[0].init.redirect === 'error' &&
    reply.status === 201)

  const kinds = [
    ['github_call_refused', 403, 'permission'],
    ['github_call_busy', 429, 'quota'],
    ['github_call_failed', 502, 'network'],
    ['github_unreachable', 502, 'network'],
    ['github_response_too_large', 502, 'service'],
    ['github_unavailable', 503, 'auth'],
    [null, 401, 'auth'],
    [null, null, 'network'],
  ]
  for (const [code, status, kind] of kinds) {
    const broker = fakeBroker({ fail: () => new NativeBrokerError('rejected', 'native broker HTTP', code, status) })
    const { host } = hostFor(broker)
    await host.check()
    const result = await outcome(() => githubUser(host.transport()))
    check(`broker ${code ?? status ?? 'transport failure'} reads ${kind}`, result.kind === kind, result.kind)
    if (kind === 'auth' || kind === 'network') check(`after ${code ?? status ?? 'a transport failure'} the host answer is asked again`, host.known() === null)
  }
  const signedOut = fakeBroker({ fail: () => new NativeBrokerError('rejected', 'x', 'github_unavailable', 503) })
  const { host: outHost } = hostFor(signedOut)
  await outHost.check()
  check('with the host answering available, it is selected', (await selectGitHub(outHost, TOKEN)).via === 'host')
  await outcome(() => githubUser(outHost.transport()))
  check('a call that finds the host signed out drops the cached yes, so the next selection asks again',
    outHost.known() === null && selectGitHubNow(outHost, TOKEN)?.via === 'token')
  // A gh that could not reach GitHub is not a signed-out host: a create stays
  // unconfirmed (network), so the durable outbox marks it unknown and reconciles.
  const blip = fakeBroker({ fail: () => new NativeBrokerError('rejected', 'x', 'github_unreachable', 502) })
  const { host: blipHost } = hostFor(blip)
  await blipHost.check()
  let blipError = null
  try { await githubCreateRepo(blipHost.transport(), 'fresh-idea', true) } catch (e) { blipError = e }
  check('a create the host could not get through to GitHub is network, outcome unconfirmed, not auth',
    blipError instanceof GitHubError && blipError.kind === 'network' && /unconfirmed/.test(blipError.message), `${blipError?.kind} ${blipError?.message}`)
  const brokerGh = fakeBroker({ github: { available: false, login: null } })
  const { host: fallback } = hostFor(brokerGh)
  check('a host whose gh is signed out falls back to the phone token', (await selectGitHub(fallback, TOKEN)).via === 'token')
}

section('selection order')
{
  const on = hostFor(fakeBroker()).host
  const off = hostFor(fakeBroker({ github: { available: false, login: null } })).host
  const old = hostFor(fakeBroker({ github: null })).host
  const down = hostFor(fakeBroker({ github: new Error('unreachable') })).host
  const unpaired = hostFor(fakeBroker(), { paired: false }).host
  const unlinked = hostFor(fakeBroker(), { bearer: '' }).host
  const pick = async (host, token) => (await selectGitHub(host, token))?.via ?? 'none'
  check('1. a paired host with github.available wins over a phone token', await pick(on, TOKEN) === 'host')
  check('1. a paired host with github.available works with no phone token', await pick(on, '') === 'host')
  check('2. a host without GitHub: the phone token', await pick(off, TOKEN) === 'token')
  check('2. a broker from before host GitHub: the phone token', await pick(old, TOKEN) === 'token')
  check('2. an unreachable host: the phone token', await pick(down, TOKEN) === 'token')
  check('2. no paired host: the phone token', await pick(unpaired, TOKEN) === 'token')
  check('2. a paired host this phone holds no broker credential for: the phone token', await pick(unlinked, TOKEN) === 'token')
  check('2. no host wired at all: the phone token', await pick(null, TOKEN) === 'token')
  check('3. neither: nothing', await pick(off, '') === 'none' && await pick(null, '') === 'none' && await pick(unpaired, '') === 'none')
  check('the host selection names the host', (await selectGitHub(on, ''))?.hostLabel === 'Studio Mac')

  const broker = fakeBroker()
  let t = 0
  const { host, state } = hostFor(broker, { now: () => t })
  check('an unprobed paired host is unknown, an unpaired one is known-off', host.known() === null && unpaired.known() === false)
  // The read starts the probe in the background (so a gate that only reads
  // still learns the answer) but never waits on it.
  check('selectGitHubNow does not wait on a probe: unknown host, token in hand -> token', selectGitHubNow(host, TOKEN)?.via === 'token' && broker.calls.capabilities === 1)
  await Promise.all([host.check(), host.check(), host.check()])
  check('concurrent probes, the read\'s included, share one capabilities call', broker.calls.capabilities === 1)
  check('after the probe the host is known and selected without waiting', host.known() === true && selectGitHubNow(host, TOKEN)?.via === 'host' && host.login() === 'owner-login')
  t = 59_000; await host.check()
  check('a yes holds for a minute', broker.calls.capabilities === 1)
  t = 61_000; await host.check()
  check('then it is asked again', broker.calls.capabilities === 2)
  check('the probe used the paired broker credential', broker.calls.credentials.every(c => c === BEARER))
  let changes = 0
  host.onChange(() => changes++)
  state.bearer = 'rotated-bearer'
  check('a new broker credential is a new answer (unknown until asked)', host.known() === null)
  await host.check()
  check('a settled answer that changed identity notifies', changes === 1)
  const transport = host.transport()
  state.paired = false
  check('an unpaired phone has no host transport', host.transport() === null && host.known() === false)
  await outcome(() => githubUser(transport))
  check('a transport built before unpairing sends no credential afterwards', broker.calls.github.at(-1).credential === '')
}

section('liveClients: the durable runtime and the engines select per call')
{
  const github = makeGitHub()
  const broker = fakeBroker({ answer: github })
  const { host } = hostFor(broker)
  const k = { factoryKey: 'f', cursorKey: '', githubToken: TOKEN, githubHost: host }
  const clients = liveClients(() => k)
  fetchHandler = null
  fetchLog.length = 0
  const created = await clients.createRepo('fresh-idea', true)
  check('with the host available, createRepo runs on the host even with a token saved',
    created.url === 'https://github.com/owner-login/fresh-idea' && fetchLog.length === 0 && broker.calls.github.at(-1).request.path === '/user/repos')
  check('repoAccount and repositoryBase go through the host too',
    await clients.repoAccount() === 'owner-login' &&
    (await clients.repositoryBase('owner-login/alpha')).sha === SHA_A && fetchLog.length === 0)
  check('the clients expose the host answer to the start gates', clients.githubHost.known() === true && await clients.githubHost.check() === true)

  const off = hostFor(fakeBroker({ github: { available: false, login: null } })).host
  const k2 = { factoryKey: 'f', cursorKey: '', githubToken: TOKEN, githubHost: off }
  tokenPath(github)
  fetchLog.length = 0
  await liveClients(() => k2).createRepo('fresh-idea', true)
  check('a host without GitHub: createRepo uses the phone token', fetchLog.length === 1 && fetchLog[0].init.headers.Authorization === `Bearer ${TOKEN}`)
  fetchLog.length = 0
  const plain = liveClients(() => ({ factoryKey: 'f', cursorKey: '', githubToken: TOKEN }))
  await plain.repoAccount()
  check('no host wired: the token path exactly as before', fetchLog.length === 1 && fetchLog[0].url === 'https://api.github.com/user' &&
    plain.githubHost.known() === false)
  fetchHandler = null

  const intake = githubIntakeSource(() => '', host)
  check('the intake source exists with no token when the host provides GitHub', intake !== null &&
    (await intake.issue('owner-login/alpha', 3))?.title === 'Issue three' && (await intake.readme('owner-login/alpha'))?.startsWith('# Hello'))
  const unprobedBroker = fakeBroker()
  const unprobed = hostFor(unprobedBroker).host
  check('an unprobed host without a token reads as no source, and is asked', githubIntakeSource(() => '', unprobed) === null && unprobedBroker.calls.capabilities === 1)
  await unprobed.check()
  check('once it answers, the next read has a source', githubIntakeSource(() => '', unprobed) !== null)
  await off.check()
  check('the intake source is null with neither', githubIntakeSource(() => '', off) === null)
  check('the intake source without a host is the token source as before', githubIntakeSource(() => '') === null && githubIntakeSource(() => TOKEN) !== null)
}

section('a new repo with no phone token and a paired host creates through the host and plans')
{
  const github = makeGitHub()
  const broker = fakeBroker({ answer: github })
  const { host } = hostFor(broker)
  const fake = fakeClients()
  const live = liveClients(() => ({ factoryKey: FAKE.factoryKey, cursorKey: '', githubToken: '', githubHost: host }))
  const clients = { ...fake, createRepo: live.createRepo, findRepo: live.findRepo, repoAccount: live.repoAccount,
    repositoryBase: live.repositoryBase, githubHost: live.githubHost }
  const views = []
  const engine = new RealOrchestrator((v) => views.push(v), {
    ...FAKE, githubToken: '', repoUrl: '', workerPref: 'factory', jobs: 1, clients, missionId: 'host-gh-new-repo',
  })
  engine.boot()
  engine.voiceGoal('Build a docs site', 10)
  fetchHandler = null
  fetchLog.length = 0
  engine.handleAction('new_repo')
  for (let i = 0; i < 40 && !engine.snapshot().missionRepo; i++) await flush(5)
  const creates = broker.calls.github.filter(c => c.request.method === 'POST')
  check('the repository is created on the host (one create, private, with the broker bearer)',
    creates.length === 1 && creates[0].request.body.private === true && creates[0].credential === BEARER && creates[0].brokerUrl === BROKER)
  check('the mission builds in the host-created repository', engine.snapshot().missionRepo.startsWith('https://github.com/owner-login/'))
  for (let i = 0; i < 40 && engine.snapshot().planLabels.length === 0; i++) { await engine.pollLead().catch(() => {}); await flush(5) }
  check('and plans', engine.snapshot().planLabels.length > 0, JSON.stringify(engine.snapshot().phase))
  check('the base was read through the host', broker.calls.github.some(c => c.request.path.startsWith('/repos/owner-login/')))
  check('no direct GitHub request and no blocked prompt', fetchLog.length === 0 && engine.snapshot().blockedStart === null)
}

section('with neither: the prompt and the new copy')
{
  check('the glasses prompt copy is the plan’s', COPY.real.needGithub === NEW_COPY)
  const off = hostFor(fakeBroker({ github: { available: false, login: null } })).host
  // The engine's own keys, read per call as the engine's liveClients reads them.
  const vault = { factoryKey: FAKE.factoryKey, cursorKey: '', githubToken: '', githubHost: off }
  const live = liveClients(() => vault)
  const views = []
  const engine = new RealOrchestrator((v) => views.push(v), {
    ...FAKE, githubToken: '', repoUrl: '', workerPref: 'factory', jobs: 1,
    clients: { ...fakeClients(), githubHost: live.githubHost, createRepo: live.createRepo }, missionId: 'host-gh-neither',
  })
  engine.boot()
  engine.voiceGoal('Build a docs site', 10)
  engine.handleAction('new_repo')
  await flush()
  const v = engine.currentView
  check('a host without GitHub and no token: blockedStart github with the new copy',
    engine.snapshot().blockedStart === 'github' && v.type === 'scene' && v.scene.utterance === NEW_COPY && v.scene.status === 'Connect GitHub')
  tokenPath(makeGitHub())
  fetchLog.length = 0
  vault.githubToken = 'gh-test'
  engine.configure({ githubToken: 'gh-test' })
  for (let i = 0; i < 40 && !engine.snapshot().missionRepo; i++) await flush(5)
  check('a token save still resumes the start, on the token', engine.snapshot().missionRepo !== '' && engine.snapshot().blockedStart === null &&
    fetchLog.some(r => r.init.headers.Authorization === 'Bearer gh-test'),
    JSON.stringify({ repo: engine.snapshot().missionRepo, blocked: engine.snapshot().blockedStart, fault: engine.snapshot().faultKind, fetches: fetchLog.map(r => r.url) }))
  fetchHandler = null

  // Plain fake clients (no host seam at all): unchanged behavior, new copy.
  const bare = new RealOrchestrator(() => {}, { ...FAKE, githubToken: '', repoUrl: '', workerPref: 'factory', jobs: 1, clients: fakeClients() })
  bare.boot()
  bare.voiceGoal('Build a docs site', 10)
  bare.handleAction('new_repo')
  check('no host seam and no token: the prompt shows at once', bare.snapshot().blockedStart === 'github' && bare.currentView.scene.utterance === NEW_COPY)
}

section('phone: composer help and Settings > GitHub')
{
  phoneDom()
  const kvOf = (map) => ({ call: async (op) => op({ getLocalStorage: async (k) => map.get(k) ?? '', setLocalStorage: async (k, v) => { map.set(k, v); return true } }) })
  const mount = async (githubHost) => {
    const kv = kvOf(new Map())
    const keys = new KeyVault(kv), prefs = new PrefsVault(kv), feed = new FeedVault(kv)
    await keys.load(); await prefs.load(); await feed.load()
    await keys.setFactory(FAKE.factoryKey)
    await keys.setRepoMode('per_idea')
    const engine = new RealOrchestrator(() => {}, { ...FAKE, githubToken: '', repoUrl: '', clients: fakeClients() })
    engine.boot()
    const root = makeElement('div')
    const handle = mountPhoneApp(root, { ...phoneFakes(), keys, prefs, feed, engine: () => engine, runAction: () => {}, onSaved: () => {},
      setupSatisfied: () => true, ...(githubHost ? { githubHost } : {}) })
    handle.notify(engine.currentView)
    return { root, handle, engine }
  }
  const byId = (root, id) => allNodes(root, n => n.id === id)[0]
  const off = hostFor(fakeBroker({ github: { available: false, login: null } })).host
  await off.check()
  const neither = await mount(off)
  await flush()
  neither.handle.notify(neither.engine.currentView)
  check('with neither, the composer help is the new copy', textOf(byId(neither.root, 'ph-home-help')) === NEW_COPY, textOf(byId(neither.root, 'ph-home-help')))
  const plainPhone = await mount(null)
  check('no host wired and no token: the same help line', textOf(byId(plainPhone.root, 'ph-home-help')) === NEW_COPY)

  const { host: on } = hostFor(fakeBroker())
  const through = await mount(on)
  await flush()
  through.handle.notify(through.engine.currentView)
  check('with the host providing GitHub, the composer carries no GitHub help', textOf(byId(through.root, 'ph-home-help')) === '')
  const row = byId(through.root, 'ph-conn-github')
  check('Settings > GitHub reads "Through <host label>" and Working', textOf(row).includes('Through Studio Mac') && textOf(row).includes('Working'), textOf(row))
  const neitherRow = byId(neither.root, 'ph-conn-github')
  check('without it the row keeps the board copy', textOf(neitherRow).includes('Can create and push repos') && !textOf(neitherRow).includes('Through'))

  // Past the phone's 60 s TTL nothing else re-probes; the stale yes must hold
  // for the gates and copy while the read itself starts the re-check.
  let clock = 1_000_000
  const ttlBroker = fakeBroker()
  const { host: aging } = hostFor(ttlBroker, { now: () => clock })
  const aged = await mount(aging)
  await flush()
  const probesBefore = ttlBroker.calls.capabilities
  clock += 61_000
  aged.handle.notify(aged.engine.currentView)
  check('past the TTL the composer still carries no GitHub help', textOf(byId(aged.root, 'ph-home-help')) === '', textOf(byId(aged.root, 'ph-home-help')))
  check('past the TTL Settings > GitHub still reads "Through <host label>"', textOf(byId(aged.root, 'ph-conn-github')).includes('Through Studio Mac'), textOf(byId(aged.root, 'ph-conn-github')))
  check('past the TTL known() keeps the yes and the read starts a re-check', aging.known() === true && ttlBroker.calls.capabilities > probesBefore)
  await flush()
  check('the re-check settles a fresh yes', aging.known() === true)

  // A stale yes that re-checks to no takes the host away and redraws.
  let flips = 0
  let current = fakeBroker()
  const { host: flipping } = hostFor({ client: (...args) => current.client(...args) }, { now: () => clock })
  await flipping.check()
  flipping.onChange(() => { flips++ })
  current = fakeBroker({ github: { available: false, login: null } })
  clock += 61_000
  check('a stale yes reads yes while the re-check runs', flipping.known() === true)
  await flush()
  check('when the re-check settles no, known() is false and onChange fires', flipping.known() === false && flips === 1 && current.calls.capabilities === 1)

  // After invalidate() the next read re-probes on its own, and onChange redraws.
  const { host: dropped } = hostFor(fakeBroker(), { now: () => clock })
  await dropped.check()
  let redraws = 0
  dropped.onChange(() => { redraws++ })
  dropped.invalidate()
  check('after invalidate() known() is null', dropped.known() === null)
  await flush()
  check('the read started the re-check, which settled yes and redrew', dropped.known() === true && redraws === 1)
}

section('setup Repo screens: the list and the create run through the host')
{
  setupDom()
  const listed = []
  const pickerFor = (githubHost, token = '') => createRepoPicker({
    githubToken: () => token, githubHost,
    github: { repos: async (auth) => { listed.push(auth); return [] } },
    initialMode: 'one', initialUrl: '',
  })
  const { host: on } = hostFor(fakeBroker())
  pickerFor(on)
  await flush()
  check('the Repo board list asks the host when it provides GitHub (no token)', listed.length === 1 && typeof listed[0] === 'object' && listed[0].via === 'host')
  const off = hostFor(fakeBroker({ github: { available: false, login: null } })).host
  pickerFor(off, TOKEN)
  await flush()
  check('a host without GitHub: the list uses the token', listed.length === 2 && listed[1] === TOKEN)
  pickerFor(null, TOKEN)
  await flush()
  check('no host wired: the list uses the token as before', listed.length === 3 && listed[2] === TOKEN)
  await off.check()
  pickerFor(off, '')
  await flush()
  check('neither: no list call', listed.length === 3)

  const kvOf = (map) => ({ call: async (op) => op({ getLocalStorage: async (k) => map.get(k) ?? '', setLocalStorage: async (k, v) => { map.set(k, v); return true } }) })
  const kv = kvOf(new Map())
  const keys = new KeyVault(kv), prefs = new PrefsVault(kv)
  await keys.load(); await prefs.load()
  const broker = fakeBroker()
  const { host } = hostFor(broker)
  await host.check()
  phoneDom()
  const root = makeElement('div')
  mountSetupPanel(root, keys, prefs, { githubHost: host })
  const name = allNodes(root, n => n.tagName === 'INPUT' && n.placeholder === 'new-repository-name')[0]
  const privateBox = allNodes(root, n => n.tagName === 'LABEL' && textOf(n) === 'Private')[0]
  check('with the host, the create box shows and the Private choice is hidden (host repos are private)', name !== undefined && privateBox?.hidden === true)
  name.value = 'from-settings'
  fetchHandler = null
  fetchLog.length = 0
  await control(root, 'Create and use it').onclick()
  const create = broker.calls.github.find(c => c.request.method === 'POST')
  check('Settings > Repository creates through the host with no token saved',
    create?.request.body.name === 'from-settings' && create.request.body.private === true && fetchLog.length === 0 &&
    keys.repoUrl === 'https://github.com/owner-login/from-settings')
  const gh = allNodes(root, n => n.id === 'sec-github')[0]
  check('the GitHub step says it runs through the host', textOf(gh).includes('Through Studio Mac'))
}

section('no token in what the phone keeps or shows')
{
  const broker = fakeBroker()
  const { host } = hostFor(broker)
  await host.check()
  const shown = JSON.stringify({ known: host.known(), login: host.login(), label: host.label() })
  check('the host link exposes a login and a label, never a credential', !shown.includes(BEARER) && !shown.includes('gho_') && shown.includes('owner-login'))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
