/**
 * Offline checks for the host X launcher and the broker's X routes. The broker
 * is the offline fixture (fake transport); every X request goes to a fake
 * fetch and the reader is a fake module except in one smoke test of the real
 * one. No real X API call, no Factory call and no real credential is read.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { startBrokerServer } from '../broker/server.mjs'
import { BrokerError, hash } from '../broker/validation.mjs'
import { NativeXHost } from '../broker/broker.mjs'
import { createXLauncher, xLaunchTemplate, xLaunchDelivery } from '../broker/x-launch.mjs'
import { fixture, fakeTransport, OWNER, MACHINE, TOKEN } from '../broker/fixtures/offline.mjs'

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const HOST_ROOT = '/offline/x-host-root'
const TEMPLATE = Object.freeze({
  settings: {
    modelId: 'fixture-orchestrator', reasoningEffort: 'high', workerModel: 'fixture-worker', workerReasoningEffort: 'medium',
    validationWorkerModel: 'fixture-validator', validationWorkerReasoningEffort: 'medium',
    restrictToolIds: ['SpawnAgent', 'SendMessage', 'ListAgents', 'InterruptAgent'],
  },
  acceptanceCriteria: ['The requested change is visible.'],
  restrictions: ['do not merge'],
})
const NO_DELIVERY = Object.freeze({ createPrivateRepositories: false, pushBranch: false, openPr: false, mergeAfterChecks: false })
const FULL_DELIVERY = Object.freeze({ createPrivateRepositories: true, pushBranch: true, openPr: true, mergeAfterChecks: false })
// Fixture values only; shaped so a leak is unmistakable anywhere it appears.
const ACCESS = 'AT-fixture-handoff-access-0001', REFRESH = 'RT-fixture-handoff-refresh-0001'
const leaks = value => [ACCESS, REFRESH, TOKEN].some(secret => JSON.stringify(value).includes(secret))

/** The reader's request shape (broker/x-reader.mjs ingest). */
function readerRequest(overrides = {}) {
  return {
    origin: 'x', dedupeKey: 'x:111:2001', logicalPostId: '2001', revisionId: '2001', postId: '2001',
    ownerXUserId: '111', postUrl: 'https://x.com/i/status/2001', postedAt: '2026-10-14T11:59:00.000Z',
    instruction: 'add a dark mode toggle', destination: { kind: 'existing', repository: 'https://github.com/owner/app' },
    ...overrides,
  }
}
function routedRequest(overrides = {}) {
  return {
    goal: 'add a dark mode toggle', references: ['https://x.com/i/status/2001'],
    destination: { kind: 'existing', account: 'owner', name: 'app' }, logicalPostId: '2001', dedupeKey: 'x:111:2001',
    ...overrides,
  }
}

/** A broker double recording the exact admission path. */
function fakeBroker({ holds = [], eligible = true, inspect, prepare } = {}) {
  const calls = []
  return {
    calls,
    async inspectAdmission(draft) {
      calls.push({ method: 'inspectAdmission', draft: structuredClone(draft) })
      if (inspect) return inspect(draft)
      return {
        protocolVersion: 1, missionId: draft.missionId, ownerId: draft.ownerId, draftHash: hash(draft),
        workspace: { ...draft.workspace, baseSha: 'b'.repeat(40) }, prospectiveSettings: structuredClone(draft.settings),
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30000).toISOString(),
        launchEligible: eligible && !holds.length, holds,
      }
    },
    async prepare(intent) {
      calls.push({ method: 'prepare', intent: structuredClone(intent) })
      if (prepare) return prepare(intent)
      return { missionId: intent.missionId, holdReason: null, commands: [{ commandId: intent.commandId, state: 'confirmed', reason: null }] }
    },
  }
}
const launcher = (broker, options = {}) => createXLauncher({
  broker, ownerId: OWNER, machineId: MACHINE, hostRoot: HOST_ROOT, template: TEMPLATE, delivery: NO_DELIVERY, ...options,
})

// ------------------------------------------------------------- launcher

test('an eligible request is previewed, then prepared with both consents and the preview\'s workspace', async () => {
  const broker = fakeBroker()
  const result = await launcher(broker)(readerRequest())
  assert.equal(result.status, 'submitted')
  assert.match(result.missionId, /^x-mission-[a-f0-9]{32}$/)
  const [inspect, prepare] = broker.calls
  assert.deepEqual(broker.calls.map(c => c.method), ['inspectAdmission', 'prepare'])
  const draft = inspect.draft
  assert.equal(Object.hasOwn(draft, 'scopeApproved') || Object.hasOwn(draft, 'highAutonomyApproved'), false)
  assert.equal(draft.missionId, result.missionId)
  assert.equal(draft.goal, 'add a dark mode toggle')
  assert.deepEqual(draft.references, ['https://x.com/i/status/2001'])
  assert.deepEqual(draft.workspace, { machineId: MACHINE, cwd: `${HOST_ROOT}/jobs/${result.missionId}/work`,
    repository: 'https://github.com/owner/app', baseRef: 'refs/heads/main' })
  assert.deepEqual(draft.destination, { kind: 'existing', account: 'owner', name: 'app', visibility: 'private', initialization: 'empty' })
  assert.deepEqual(draft.policy, { autonomy: 'high', allowCreateRepository: false, allowPush: false, allowPr: false, allowMerge: false, allowDeploy: false })
  assert.deepEqual(draft.settings, { ...TEMPLATE.settings, skipScrutiny: false, skipUserTesting: false })
  assert.deepEqual(draft.acceptanceCriteria, TEMPLATE.acceptanceCriteria)
  assert.deepEqual(draft.restrictions, TEMPLATE.restrictions)
  assert.equal(prepare.intent.scopeApproved, true); assert.equal(prepare.intent.highAutonomyApproved, true)
  assert.equal(prepare.intent.workspace.baseSha, 'b'.repeat(40))
  assert.equal(prepare.intent.commandId, draft.commandId)
  // The same logical post always names the same job.
  assert.equal((await launcher(fakeBroker())(readerRequest())).missionId, result.missionId)
  assert.notEqual((await launcher(fakeBroker())(readerRequest({ dedupeKey: 'x:111:2002' }))).missionId, result.missionId)
  // A routed request is accepted too.
  assert.equal((await launcher(fakeBroker())(routedRequest())).missionId, result.missionId)
})

test('delivery defaults set the policy; a new repository needs create AND push', async () => {
  const broker = fakeBroker()
  const full = launcher(broker, { delivery: FULL_DELIVERY, newRepositoryAccount: 'owner' })
  const created = await full(readerRequest({ destination: { kind: 'new_repository', name: 'dark-mode' } }))
  assert.equal(created.status, 'submitted')
  const draft = broker.calls[0].draft
  assert.deepEqual(draft.policy, { autonomy: 'high', allowCreateRepository: true, allowPush: true, allowPr: true, allowMerge: false, allowDeploy: false })
  assert.equal(draft.workspace.repository, 'owner/dark-mode')
  assert.deepEqual(draft.destination, { kind: 'new_repository', account: 'owner', name: 'dark-mode', visibility: 'private', initialization: 'empty' })
  // Existing destination: never repository creation.
  const existing = fakeBroker()
  await launcher(existing, { delivery: FULL_DELIVERY })(readerRequest())
  assert.equal(existing.calls[0].draft.policy.allowCreateRepository, false)

  for (const delivery of [{ ...FULL_DELIVERY, pushBranch: false }, { ...NO_DELIVERY, createPrivateRepositories: false, pushBranch: true }]) {
    const b = fakeBroker()
    const held = await launcher(b, { delivery, newRepositoryAccount: 'owner' })(readerRequest({ destination: { kind: 'new_repository', name: 'dark-mode' } }))
    assert.equal(held.status, 'held')
    assert.match(held.reason, /create private repositories.*push branch/)
    assert.equal(b.calls.length, 0)
  }
  const noAccount = fakeBroker()
  const held = await launcher(noAccount, { delivery: FULL_DELIVERY })(readerRequest({ destination: { kind: 'new_repository', name: 'dark-mode' } }))
  assert.equal(held.status, 'held'); assert.match(held.reason, /No GitHub account/)
  assert.equal(noAccount.calls.length, 0)
})

test('a preview with holds, or not launch-eligible, is held and never prepared', async () => {
  const broker = fakeBroker({ holds: ['native_launch_unqualified', 'native_delivery_unavailable'] })
  const result = await launcher(broker)(readerRequest())
  assert.deepEqual(result, { status: 'held', reason: 'The broker holds this request: native_launch_unqualified; native_delivery_unavailable' })
  assert.deepEqual(broker.calls.map(c => c.method), ['inspectAdmission'])
  const ineligible = fakeBroker({ eligible: false })
  assert.deepEqual(await launcher(ineligible)(readerRequest()), { status: 'held', reason: 'The broker holds this request: not launch-eligible' })
  const unreachable = fakeBroker({ inspect: () => { throw new BrokerError('transport_timeout', 503) } })
  assert.deepEqual(await launcher(unreachable)(readerRequest()), { status: 'held', reason: 'The broker could not preview this request: transport_timeout' })
  // A non-broker error never leaks its message.
  const odd = fakeBroker({ inspect: () => { throw new Error('secret detail') } })
  assert.equal((await launcher(odd)(readerRequest())).reason, 'The broker could not preview this request: broker_unavailable')
})

test('a prepare failure or a rejected receipt is held with the broker\'s reason', async () => {
  const thrown = fakeBroker({ prepare: () => { throw new BrokerError('job_capacity_exceeded', 503) } })
  assert.deepEqual(await launcher(thrown)(readerRequest()), { status: 'held', reason: 'The broker could not prepare this request: job_capacity_exceeded' })
  const rejected = fakeBroker({ prepare: intent => ({ missionId: intent.missionId, holdReason: 'preflight_unavailable',
    commands: [{ commandId: intent.commandId, state: 'rejected', reason: 'preflight_unavailable' }] }) })
  assert.deepEqual(await launcher(rejected)(readerRequest()), { status: 'held', reason: 'The broker did not launch this request: preflight_unavailable' })
  const unknown = fakeBroker({ prepare: intent => ({ missionId: intent.missionId, holdReason: null,
    commands: [{ commandId: intent.commandId, state: 'unknown', reason: null }] }) })
  assert.deepEqual(await launcher(unknown)(readerRequest()), { status: 'held', reason: 'The broker did not launch this request: launch_unknown' })
})

test('malformed requests and configuration fail closed', async () => {
  const broker = fakeBroker()
  const launch = launcher(broker)
  for (const bad of [null, routedRequest({ goal: '' }), routedRequest({ references: [1] }),
    routedRequest({ destination: { kind: 'existing', account: '-bad', name: 'app' } }),
    routedRequest({ logicalPostId: 'abc' }), readerRequest({ destination: { kind: 'existing', repository: 'https://example.com/o/r' } })]) {
    assert.equal((await launch(bad)).status, 'held')
  }
  assert.equal(broker.calls.length, 0)
  const code = expected => error => error instanceof BrokerError && error.code === expected
  assert.throws(() => launcher(broker, { hostRoot: '/a/../b' }), code('x_launch_host_root_invalid'))
  assert.throws(() => launcher(broker, { hostRoot: '/' }), code('x_launch_host_root_invalid'))
  assert.throws(() => launcher(broker, { template: { ...TEMPLATE, acceptanceCriteria: [] } }), code('x_launch_template_invalid'))
  assert.throws(() => launcher(broker, { template: { ...TEMPLATE, settings: { ...TEMPLATE.settings, skipScrutiny: true } } }), code('x_launch_template_invalid'))
  assert.throws(() => launcher(broker, { delivery: { pushBranch: true } }), code('x_launch_delivery_invalid'))
  assert.throws(() => launcher(broker, { newRepositoryAccount: 'not valid' }), code('x_launch_account_invalid'))
  assert.deepEqual(xLaunchDelivery({ createPrivateRepositories: false, pushBranch: false, openPr: true, mergeAfterChecks: true }), NO_DELIVERY)
  assert.equal(xLaunchTemplate({ ...TEMPLATE, extra: 1 }), null)
  // A broker host whose checkout layout differs is refused before any preview.
  const hosted = { ...fakeBroker(), host: { workDirFor: id => `/elsewhere/${id}` } }
  assert.match((await launcher(hosted)(readerRequest())).reason, /host root does not match/)
})

/** The real broker's admission path over the offline transport. */
function admissionTransport() {
  return fakeTransport({
    async inspectAdmission(draft) {
      this.calls.push({ method: 'inspectAdmission' })
      return {
        protocolVersion: 1, missionId: draft.missionId, ownerId: draft.ownerId, draftHash: hash(draft),
        workspace: { ...draft.workspace, baseSha: 'a'.repeat(40) }, prospectiveSettings: structuredClone(draft.settings),
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30000).toISOString(),
        launchEligible: true, holds: [],
      }
    },
  })
}

test('the real broker launches an eligible request once; a replay reports the same job', async () => {
  const f = await fixture({ transport: admissionTransport() })
  try {
    const launch = launcher(f.broker)
    const first = await launch(readerRequest())
    assert.equal(first.status, 'submitted')
    assert.deepEqual(f.transport.calls.map(c => c.method), ['inspectAdmission', 'preflight', 'launch'])
    assert.deepEqual(f.broker.listJobs(OWNER).jobs.map(j => j.missionId), [first.missionId])
    // A crash between prepare and the reader's receipt replays onto the same job.
    assert.deepEqual(await launch(readerRequest()), first)
    assert.equal(f.transport.calls.filter(c => c.method === 'launch').length, 1)
    // An unqualified delivery request is held by the broker itself.
    const pushing = await launcher(f.broker, { delivery: { ...NO_DELIVERY, pushBranch: true } })(readerRequest({ dedupeKey: 'x:111:2003', logicalPostId: '2003' }))
    assert.deepEqual(pushing, { status: 'held', reason: 'The broker holds this request: native_delivery_unavailable' })
  } finally { await f.cleanup() }
})

// ---------------------------------------------------------------- routes

/** A reader double with the real reader's surface; `ledger` is the shared x-reader.json. */
function fakeReaderModule(statusExtra = {}, { ledger = { binding: null }, stop } = {}) {
  const readers = []
  return {
    readers, ledger,
    createXReader(options) {
      const reader = {
        options, bound: null, running: false, starts: 0, stops: 0,
        async bind(input) {
          this.bound = input
          ledger.binding = { ownerXUserId: input.ownerId, ownerHandle: 'owner_handle', spriiteHandle: input.spriiteHandle,
            spriiteXUserId: input.spriiteUserId ?? '222', boundAt: '2026-10-14T12:00:00.000Z',
            ...(input.defaultRepository ? { defaultRepository: input.defaultRepository } : {}) }
          return input
        },
        start() { this.running = true; this.starts++ },
        stop() { this.running = false; this.stops++; return stop?.() },
        status() {
          return { running: this.running, bound: !!ledger.binding, binding: ledger.binding,
            checkpoint: { lastSeenPostId: '2001', lastSuccessAt: '2026-10-14T12:01:00.000Z' },
            receipts: [{ dedupeKey: 'x:111:2001', status: 'submitted', missionId: 'x-mission-1' }], ...statusExtra }
        },
      }
      readers.push(reader)
      return reader
    },
  }
}
const xJson = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })
function fakeXFetch({ meStatus = 200 } = {}) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization })
    if (String(url).startsWith('https://api.x.com/2/users/me')) {
      return meStatus === 200 ? xJson(200, { data: { id: '111', username: 'owner_handle' } }) : xJson(meStatus, {})
    }
    if (/\/2\/users\/111\/tweets/.test(String(url))) return xJson(200, { meta: { result_count: 0 } })
    return xJson(404, {})
  }
  return Object.assign(fn, { calls })
}
const HANDOFF = Object.freeze({
  accessToken: ACCESS, refreshToken: REFRESH, clientId: 'fixture-client-id', spriiteHandle: '@SpriiteBot',
  spriiteXUserId: '222', defaultRepository: 'https://github.com/owner/app', template: TEMPLATE, delivery: FULL_DELIVERY,
  expiresAt: '2026-10-14T14:00:00.000Z',
})

async function withRoutes(fn, { enable = true, reader = fakeReaderModule(), fetch: xFetch = fakeXFetch(), loadReader, allowedOrigins = [] } = {}) {
  const f = await fixture({ transport: admissionTransport() })
  if (enable) f.broker.enableXReader({ hostRoot: HOST_ROOT, fetch: xFetch, loadReader: loadReader ?? (async () => reader) })
  const server = await startBrokerServer({ broker: f.broker, bearerToken: TOKEN, allowedOrigins })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (path, value, { auth = true, headers = {}, method } = {}) => {
    const response = await fetch(base + path, {
      method: method ?? (value === undefined ? 'GET' : 'POST'),
      headers: { ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: value === undefined ? undefined : typeof value === 'string' ? value : JSON.stringify(value),
    })
    const text = await response.text()
    return { status: response.status, body: JSON.parse(text), text }
  }
  try { await fn({ f, call, reader, fetch: xFetch }) } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    await f.cleanup()
  }
}
const files = f => ({
  credential: join(f.ledgerDir, 'x-credential.json'), config: join(f.ledgerDir, 'x-reader-config.json'),
})

test('every new route requires the bearer; CORS preflight admits only the exact new paths', () => withRoutes(async ({ call }) => {
  for (const [path, body] of [['/v1/native/jobs?ownerId=owner-fixture'], ['/v1/native/x/status'],
    ['/v1/native/x/handoff', HANDOFF], ['/v1/native/x/stop', {}], ['/v1/native/x/signin', {}], ['/v1/native/x/signin']]) {
    const result = await call(path, body, { auth: false })
    assert.equal(result.status, 401, path); assert.deepEqual(result.body, { error: 'unauthorized' })
  }
  assert.equal((await call('/v1/native/x/status', undefined, { headers: { authorization: `Bearer ${'x'.repeat(TOKEN.length)}` }, auth: false })).status, 401)
}).then(() => withRoutes(async ({ call }) => {
  const origin = 'https://phone.example'
  for (const path of ['/v1/native/x/handoff', '/v1/native/x/status', '/v1/native/x/stop', '/v1/native/x/signin', '/v1/native/jobs?ownerId=owner-fixture']) {
    assert.equal((await call(path, undefined, { auth: false, method: 'OPTIONS', headers: { origin } })).status, 200, path)
  }
  assert.equal((await call('/v1/native/x/other', undefined, { auth: false, method: 'OPTIONS', headers: { origin } })).status, 404)
}, { allowedOrigins: ['https://phone.example'] })))

test('the jobs list is owner-scoped and exact about its query', () => withRoutes(async ({ f, call }) => {
  assert.deepEqual((await call('/v1/native/jobs?ownerId=owner-fixture')).body, { jobs: [] })
  const launched = await launcher(f.broker)(readerRequest())
  const list = await call('/v1/native/jobs?ownerId=owner-fixture')
  assert.equal(list.status, 200)
  assert.deepEqual(list.body.jobs.map(j => j.missionId), [launched.missionId])
  assert.deepEqual(Object.keys(list.body.jobs[0]).sort(), ['bound', 'brokerSeq', 'holdReason', 'missionId', 'scopeRevision', 'state'])
  assert.equal(list.body.jobs[0].bound, f.broker.store.data.jobs[launched.missionId].snapshot.binding !== null)
  assert.equal(list.text.includes('dark mode'), false) // No goal or history in the list.
  assert.equal((await call('/v1/native/jobs?ownerId=someone-else')).status, 403)
  for (const query of ['', '?ownerId=owner-fixture&ownerId=owner-fixture', '?ownerId=owner-fixture&x=1', '?ownerId=bad%20id']) {
    assert.equal((await call(`/v1/native/jobs${query}`)).status, 400, query)
  }
}))

test('without the opt-in every X route answers 503 x_reader_unavailable', () => withRoutes(async ({ f, call }) => {
  for (const [path, body] of [['/v1/native/x/status'], ['/v1/native/x/handoff', HANDOFF], ['/v1/native/x/stop', {}]]) {
    assert.deepEqual(await call(path, body).then(r => [r.status, r.body]), [503, { error: 'x_reader_unavailable' }])
  }
  assert.equal(fs.existsSync(files(f).credential), false)
}, { enable: false }))

test('handoff validation refuses bad input before any X request or file write', () => withRoutes(async ({ f, call, fetch }) => {
  const cases = [
    [{ ...HANDOFF, extra: 1 }, 'invalid_fields'],
    [(({ refreshToken, ...rest }) => rest)(HANDOFF), 'invalid_fields'],
    [{ ...HANDOFF, accessToken: 'has space' }, 'x_handoff_token_invalid'],
    [{ ...HANDOFF, refreshToken: ACCESS }, 'x_handoff_token_invalid'],
    [{ ...HANDOFF, clientId: 'bad/id' }, 'x_handoff_client_invalid'],
    [{ ...HANDOFF, spriiteHandle: 'way_too_long_handle_name' }, 'x_handoff_handle_invalid'],
    [{ ...HANDOFF, spriiteXUserId: 'abc' }, 'x_handoff_spriite_id_invalid'],
    [{ ...HANDOFF, defaultRepository: 'https://gitlab.com/o/r' }, 'x_handoff_repository_invalid'],
    [{ ...HANDOFF, repositoryAccount: '-bad' }, 'x_handoff_account_invalid'],
    [{ ...HANDOFF, template: { ...TEMPLATE, acceptanceCriteria: [] } }, 'x_handoff_template_invalid'],
    [{ ...HANDOFF, delivery: { pushBranch: 'yes' } }, 'x_handoff_delivery_invalid'],
    [{ ...HANDOFF, expiresAt: 'soon' }, 'x_handoff_expiry_invalid'],
    // A token smuggled into the config is refused, never persisted.
    [{ ...HANDOFF, template: { ...TEMPLATE, acceptanceCriteria: [`Use ${ACCESS}`] } }, 'secret_material_refused'],
  ]
  for (const [body, code] of cases) {
    const result = await call('/v1/native/x/handoff', body)
    assert.deepEqual([result.status, result.body], [400, { error: code }], code)
    assert.equal(leaks(result.body), false)
  }
  assert.equal((await call('/v1/native/x/handoff', 'not json', { headers: { 'content-type': 'text/plain' } })).status, 415)
  assert.equal((await call('/v1/native/x/stop', { now: true })).status, 400)
  assert.equal(fetch.calls.length, 0)
  assert.equal(fs.existsSync(files(f).credential) || fs.existsSync(files(f).config), false)
}))

test('a rejected or unreachable verification persists nothing', () => withRoutes(async ({ f, call }) => {
  const result = await call('/v1/native/x/handoff', HANDOFF)
  assert.deepEqual([result.status, result.body], [409, { error: 'x_handoff_rejected' }])
  assert.equal(fs.existsSync(files(f).credential) || fs.existsSync(files(f).config), false)
}, { fetch: fakeXFetch({ meStatus: 401 }) }).then(() => withRoutes(async ({ call }) => {
  assert.deepEqual(await call('/v1/native/x/handoff', HANDOFF).then(r => [r.status, r.body]), [503, { error: 'x_handoff_quota' }])
}, { fetch: fakeXFetch({ meStatus: 429 }) })).then(() => withRoutes(async ({ f, call }) => {
  // The reader module is not there: a clear 503 and nothing written.
  assert.deepEqual(await call('/v1/native/x/handoff', HANDOFF).then(r => [r.status, r.body]), [503, { error: 'x_reader_unavailable' }])
  assert.equal(fs.existsSync(files(f).credential), false)
}, { loadReader: async () => { throw new Error('missing module') } })))

test('a verified handoff persists the credential and config (0600), binds and starts the reader; status has no secrets', () => withRoutes(async ({ f, call, reader, fetch }) => {
  const result = await call('/v1/native/x/handoff', HANDOFF)
  assert.equal(result.status, 200, result.text)
  assert.equal(leaks(result.body), false)
  assert.equal(result.body.running, true); assert.equal(result.body.enabled, true)
  assert.equal(result.body.ownerXUserId, '111'); assert.equal(result.body.spriiteHandle, 'SpriiteBot')
  assert.deepEqual(result.body.credential, { state: 'active', expiresAt: '2026-10-14T14:00:00.000Z' })
  // Verification used the handed-over access token against /2/users/me only.
  assert.deepEqual(fetch.calls.map(c => c.url.split('?')[0]), ['https://api.x.com/2/users/me'])
  assert.equal(fetch.calls[0].auth, `Bearer ${ACCESS}`)
  const [r] = reader.readers
  assert.deepEqual(r.bound, { spriiteHandle: 'SpriiteBot', ownerId: '111', spriiteUserId: '222', defaultRepository: 'https://github.com/owner/app',
    fresh: true, startAt: null, seenPostIds: [] })
  assert.equal(r.running, true)
  assert.equal(r.options.ledgerPath, join(f.ledgerDir, 'x-reader.json'))
  assert.equal(typeof r.options.launch, 'function')
  const { credential, config } = files(f)
  for (const path of [credential, config]) assert.equal(fs.statSync(path).mode & 0o777, 0o600, path)
  const stored = JSON.parse(fs.readFileSync(credential, 'utf8'))
  assert.equal(stored.refreshToken, REFRESH); assert.equal(stored.ownerId, '111')
  const saved = JSON.parse(fs.readFileSync(config, 'utf8'))
  assert.equal(leaks(saved), false)
  assert.equal(saved.enabled, true); assert.equal(saved.repositoryAccount, 'owner')
  // The reader's launch is the broker's own admission path.
  assert.equal((await r.options.launch(readerRequest())).status, 'held') // Delivery is on, no delivery port: held.

  const status = await call('/v1/native/x/status')
  assert.equal(status.status, 200)
  assert.equal(leaks(status.body), false)
  assert.equal(status.body.reader.receipts.length, 1)
  assert.equal(JSON.stringify(f.broker.store.data).includes(ACCESS), false)

  const stopped = await call('/v1/native/x/stop', {})
  assert.equal(stopped.status, 200)
  assert.equal(stopped.body.running, false); assert.equal(stopped.body.enabled, false)
  assert.equal(r.running, false)
  assert.equal(leaks(stopped.body), false)
  // Stop hands nothing back and erases the pair: no grant stays at rest.
  assert.equal(fs.existsSync(credential), false)
  assert.equal(stopped.body.credential, null)
  assert.deepEqual(stopped.body.checkpoint, { lastSeenPostId: '2001', lastSuccessAt: '2026-10-14T12:01:00.000Z' })
}))

test('a reader status carrying a token is withheld', () => withRoutes(async ({ call }) => {
  assert.equal((await call('/v1/native/x/handoff', HANDOFF)).status, 200)
  const status = await call('/v1/native/x/status')
  assert.deepEqual(status.body.reader, { withheld: 'x_reader_status_unreadable' })
  assert.equal(leaks(status.body), false)
}, { reader: fakeReaderModule({ note: ACCESS }) }))

test('startup resumes only an enabled config with a stored credential, without rebinding', async () => {
  const f = await fixture({ transport: admissionTransport() })
  try {
    const reader = fakeReaderModule()
    const host = f.broker.enableXReader({ hostRoot: HOST_ROOT, fetch: fakeXFetch(), loadReader: async () => reader })
    assert.equal(await host.resume(), false) // Nothing handed off yet.
    await host.handoff(structuredClone(HANDOFF))
    await host.halt()
    const again = new NativeXHost({ broker: f.broker, directory: f.ledgerDir, hostRoot: HOST_ROOT, fetch: fakeXFetch(), loadReader: async () => reader })
    assert.equal(await again.resume(), true)
    const resumed = reader.readers.at(-1)
    assert.equal(resumed.running, true); assert.equal(resumed.bound, null, 'the stored binding is the config\'s: no rebind')
    await again.stop()
    const third = new NativeXHost({ broker: f.broker, directory: f.ledgerDir, hostRoot: HOST_ROOT, fetch: fakeXFetch(), loadReader: async () => reader })
    assert.equal(await third.resume(), false) // Stopped stays stopped across restarts.
    fs.chmodSync(join(f.ledgerDir, 'x-reader-config.json'), 0o644)
    assert.equal(await third.resume(), false)
    assert.equal((await third.status()).lastError, 'x_reader_config_unsafe')
  } finally { await f.cleanup() }
})

test('the real reader module binds and polls through the fake fetch only', () => withRoutes(async ({ call, fetch }) => {
  const result = await call('/v1/native/x/handoff', HANDOFF)
  assert.equal(result.status, 200, result.text)
  assert.equal(result.body.reader.running, true)
  assert.equal(result.body.reader.binding.spriiteXUserId, '222')
  for (let i = 0; i < 50 && !fetch.calls.some(c => c.url.includes('/tweets')); i++) await new Promise(r => setTimeout(r, 10))
  assert.ok(fetch.calls.every(c => c.url.startsWith('https://api.x.com/2/users/')))
  assert.equal((await call('/v1/native/x/stop', {})).body.running, false)
}, { loadReader: () => import('../broker/x-reader.mjs') }))

// ------------------------------------------------------ review regressions

/** X over fake fetch: /2/users/me, the handle lookup and the owner's timeline. */
function realXFetch({ lookup = () => xJson(200, { data: { id: '222', username: 'spriitebot' } }), posts = [] } = {}) {
  const calls = []
  const fn = async (url, init) => {
    const u = String(url)
    calls.push({ url: u, auth: init?.headers?.Authorization, method: init?.method })
    if (u.startsWith('https://api.x.com/2/users/me')) return xJson(200, { data: { id: '111', username: 'owner_handle' } })
    if (u.startsWith('https://api.x.com/2/users/by/username/')) return lookup(u)
    if (/\/2\/users\/111\/tweets/.test(u)) return xJson(200, { data: posts, meta: { result_count: posts.length } })
    return xJson(404, {})
  }
  return Object.assign(fn, { calls })
}
const PHONE_HANDOFF = Object.freeze((({ spriiteXUserId, expiresAt, ...rest }) => rest)(HANDOFF))
const realReader = () => import('../broker/x-reader.mjs')
const waitFor = async (cond, n = 100) => { for (let i = 0; i < n && !cond(); i++) await new Promise(r => setTimeout(r, 10)) }

test('end to end: the phone\'s payload (no Spriite id) binds the real reader through the real client', () => withRoutes(async ({ f, call, fetch }) => {
  const result = await call('/v1/native/x/handoff', PHONE_HANDOFF)
  assert.equal(result.status, 200, result.text)
  assert.equal(result.body.running, true); assert.equal(result.body.enabled, true)
  assert.equal(result.body.reader.binding.spriiteXUserId, '222')
  const lookup = fetch.calls.find(c => c.url.includes('/by/username/'))
  assert.equal(new URL(lookup.url).pathname, '/2/users/by/username/SpriiteBot')
  assert.ok(fetch.calls.every(c => c.method === 'GET' && c.url.startsWith('https://api.x.com/2/')), 'read-only GETs only')
  assert.equal(JSON.parse(fs.readFileSync(files(f).config, 'utf8')).enabled, true)
  await call('/v1/native/x/stop', {})
}, { fetch: realXFetch(), loadReader: realReader }))

for (const [label, lookup, error] of [
  ['an unknown handle', () => xJson(404, {}), 'x_not_found'],
  ['the owner\'s own account', () => xJson(200, { data: { id: '111', username: 'spriitebot' } }), 'x_same_account'],
]) {
  test(`a handoff whose bind fails (${label}) erases the credential and leaves the config disabled`, () => withRoutes(async ({ f, call }) => {
    const result = await call('/v1/native/x/handoff', PHONE_HANDOFF)
    assert.equal(result.body.error, error)
    assert.equal(fs.existsSync(files(f).credential), false, 'the handed-over pair is not left at rest')
    assert.equal(JSON.parse(fs.readFileSync(files(f).config, 'utf8')).enabled, false)
    const status = await call('/v1/native/x/status')
    assert.equal(status.body.running, false); assert.equal(status.body.enabled, false); assert.equal(status.body.credential, null)
    // A restart before the phone's stop lands resumes nothing.
    assert.equal(await f.broker.xHost.resume(), false)
    assert.equal(fs.existsSync(files(f).credential), false)
  }, { fetch: realXFetch({ lookup }), loadReader: realReader }))
}

test('resume refuses a credential whose owner is not the config\'s, and erases a grant behind a disabled config', async () => {
  const f = await fixture({ transport: admissionTransport() })
  try {
    const reader = fakeReaderModule()
    const host = f.broker.enableXReader({ hostRoot: HOST_ROOT, fetch: fakeXFetch(), loadReader: async () => reader })
    await host.handoff(structuredClone(HANDOFF))
    await host.halt()
    host.credential.save({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: HANDOFF.expiresAt, clientId: 'fixture-client-id', ownerId: '999' })
    const again = new NativeXHost({ broker: f.broker, directory: f.ledgerDir, hostRoot: HOST_ROOT, fetch: fakeXFetch(), loadReader: async () => reader })
    assert.equal(await again.resume(), false)
    assert.equal((await again.status()).lastError, 'x_reader_owner_mismatch')
    const config = JSON.parse(fs.readFileSync(files(f).config, 'utf8'))
    again.writeConfig({ ...config, enabled: false })
    assert.equal(await again.resume(), false)
    assert.equal(fs.existsSync(files(f).credential), false)
  } finally { await f.cleanup() }
})

test('resume rebinds to the config when the ledger holds another binding', async () => {
  const f = await fixture({ transport: admissionTransport() })
  try {
    const reader = fakeReaderModule()
    const host = f.broker.enableXReader({ hostRoot: HOST_ROOT, fetch: fakeXFetch(), loadReader: async () => reader })
    await host.handoff(structuredClone(HANDOFF))
    await host.halt()
    // A crash after the config was written but before the binding was: the ledger is stale.
    reader.ledger.binding = { ...reader.ledger.binding, defaultRepository: 'https://github.com/owner/old' }
    const again = new NativeXHost({ broker: f.broker, directory: f.ledgerDir, hostRoot: HOST_ROOT, fetch: fakeXFetch(), loadReader: async () => reader })
    assert.equal(await again.resume(), true)
    const resumed = reader.readers.at(-1)
    assert.deepEqual(resumed.bound, { spriiteHandle: 'SpriiteBot', ownerId: '111', spriiteUserId: '222', defaultRepository: 'https://github.com/owner/app' })
    assert.equal(reader.ledger.binding.defaultRepository, 'https://github.com/owner/app')
    // An unbound ledger is bound too, instead of failing x_reader_unbound.
    await again.halt()
    reader.ledger.binding = null
    const third = new NativeXHost({ broker: f.broker, directory: f.ledgerDir, hostRoot: HOST_ROOT, fetch: fakeXFetch(), loadReader: async () => reader })
    assert.equal(await third.resume(), true)
    assert.equal(reader.readers.at(-1).running, true)
  } finally { await f.cleanup() }
})

test('a handoff waits for the old reader\'s in-flight check before the pair is replaced', async () => {
  const f = await fixture({ transport: admissionTransport() })
  try {
    let release
    const drained = new Promise(resolve => { release = resolve })
    const reader = fakeReaderModule({}, { stop: () => drained })
    const host = f.broker.enableXReader({ hostRoot: HOST_ROOT, fetch: fakeXFetch(), loadReader: async () => reader })
    await host.handoff(structuredClone(HANDOFF))
    const second = host.handoff({ ...structuredClone(HANDOFF), accessToken: 'AT-fixture-handoff-access-0002', refreshToken: 'RT-fixture-handoff-refresh-0002' })
    await waitFor(() => reader.readers[0].stops > 0)
    assert.equal(reader.readers[0].stops, 1)
    assert.equal(reader.readers.length, 1, 'no second reader exists while the first drains')
    assert.equal(JSON.parse(fs.readFileSync(files(f).credential, 'utf8')).refreshToken, REFRESH, 'the pair is not replaced under a running check')
    release()
    await second
    assert.equal(reader.readers.length, 2)
    assert.equal(JSON.parse(fs.readFileSync(files(f).credential, 'utf8')).refreshToken, 'RT-fixture-handoff-refresh-0002')
    await host.stop()
  } finally { await f.cleanup() }
})

test('the handoff carries the phone\'s checkpoint, handled posts and repository names to the reader', () => withRoutes(async ({ f, call, reader }) => {
  const bad = [
    [{ ...HANDOFF, repositories: ['owner/ok', 'not a repo'] }, 'x_handoff_repositories_invalid'],
    [{ ...HANDOFF, seenPostIds: ['1', 'x'] }, 'x_handoff_seen_invalid'],
    [{ ...HANDOFF, startAt: 'later' }, 'x_handoff_start_invalid'],
  ]
  for (const [body, code] of bad) assert.deepEqual(await call('/v1/native/x/handoff', body).then(r => [r.status, r.body]), [400, { error: code }])
  const result = await call('/v1/native/x/handoff', { ...HANDOFF, startAt: '2026-10-14T11:50:00Z', seenPostIds: ['2001', '2001'],
    repositories: ['owner/app', 'owner/habit-log'] })
  assert.equal(result.status, 200, result.text)
  const [r] = reader.readers
  assert.equal(r.bound.fresh, true); assert.equal(r.bound.startAt, '2026-10-14T11:50:00.000Z'); assert.deepEqual(r.bound.seenPostIds, ['2001'])
  assert.deepEqual(r.options.repositories(), ['owner/app', 'owner/habit-log'])
  assert.deepEqual(JSON.parse(fs.readFileSync(files(f).config, 'utf8')).repositories, ['owner/app', 'owner/habit-log'])
  assert.equal(typeof r.options.missionLive, 'function')
  assert.equal(r.options.missionLive('x-mission-unknown'), true, 'an unknown job reads as live: a reply is held')
}))

let passed = 0
for (const { name, fn } of tests) {
  try { await fn(); passed++; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL: ${name}`); console.error(error); process.exitCode = 1 }
}
console.log(`Host X launch/routes checks: ${passed}/${tests.length} passed; fake broker transport and fake fetch, no X API or Factory call.`)
