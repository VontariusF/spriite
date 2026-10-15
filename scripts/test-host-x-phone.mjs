/**
 * Phone side of the host X reader (docs/HOST-X-READER-PLAN.md): the handoff
 * from Setup → X requests, phone polling deferral, and adoption of
 * host-launched jobs as observed native missions. Real KeyVault, PrefsVault,
 * mountXPanel, XConnection, Supervisor and HTTP client over fake fetch and
 * injected host ports. No network, no X, no Factory.
 *
 * Run: node --import ./scripts/ts-resolve.mjs scripts/test-host-x-phone.mjs
 */
import { KeyVault } from '../src/voice/keys.ts'
import { PrefsVault } from '../src/state/prefs.ts'
import { mountXPanel } from '../src/setup/x-panel.ts'
import { XConnection } from '../src/intake/connection.ts'
import { HttpNativeBrokerClient, NativeBrokerError, decodeNativeXHostStatus } from '../src/native/client.ts'
import { HostJobAdopter, HOST_MISSION_ID } from '../src/native/adopt.ts'
import { Supervisor } from '../src/runtime/supervisor.ts'
import { createRuntimeStore } from '../src/state/runtime-store.ts'
import { decodeNativeCache } from '../src/native/decode.ts'
import { TestKV, SETTINGS, makeClients, quiesce } from './lib/runtime-fake.mjs'
import { makeElement, phoneDom, textOf } from './lib/phone-dom.mjs'

let passed = 0
let failed = 0
const assert = (cond, label) => {
  if (cond) { passed++; console.log(`  ok  ${label}`) } else { failed++; console.log(`  FAIL ${label}`) }
}
const section = (name) => console.log(`\n== ${name} ==`)

const BROKER = 'https://broker.test'
const TEMPLATE = {
  settings: { modelId: 'root-model', reasoningEffort: 'high', workerModel: 'worker-model', workerReasoningEffort: 'medium',
    validationWorkerModel: 'validator-model', validationWorkerReasoningEffort: 'high', restrictToolIds: ['Read', 'Edit'],
    skipScrutiny: false, skipUserTesting: false },
  acceptanceCriteria: ['Tests pass'], restrictions: ['No publication'],
}
const DELIVERY = { createPrivateRepositories: true, pushBranch: true, openPr: true, mergeAfterChecks: false }
const PROFILE = { brokerUrl: BROKER, ownerId: 'owner-1', machineId: 'machine-1', cwd: '/work/exact-checkout', baseRef: 'develop' }

function vaults() {
  const stored = new Map()
  const gateway = { call: (fn) => fn({
    getLocalStorage: async (k) => stored.get(k) ?? '',
    setLocalStorage: async (k, v) => { stored.set(k, v); return true },
  }) }
  return { gateway, stored, keys: new KeyVault(gateway), prefs: new PrefsVault(gateway) }
}

/** A fully set-up phone: live X pair, client id, handle, X template, broker profile and credential. */
async function readyPhone() {
  const v = vaults()
  await v.keys.setX('access-live', 'refresh-live')
  await v.prefs.setXClientId('client-1')
  await v.prefs.setXSpriiteHandle('Spriite')
  await v.prefs.setXDefaultRepository('https://github.com/owner/estate')
  await v.prefs.setNativeXAuto(true, TEMPLATE)
  await v.prefs.setNativeDeliveryDefaults(DELIVERY)
  await v.prefs.setNativeLaunchProfile(PROFILE)
  await v.keys.setNativeBroker('broker-credential', BROKER)
  return v
}

const readingStatus = (over = {}) => ({
  enabled: true, running: true, ownerXUserId: '9', spriiteHandle: 'Spriite', spriiteXUserId: '77',
  defaultRepository: 'https://github.com/owner/estate', repositoryAccount: 'owner',
  credential: { state: 'active', expiresAt: '2026-10-14T02:00:00.000Z' }, lastError: null,
  reader: { running: true, bound: true, binding: null, lastCheckedAt: null, lastError: null, lastErrorKind: null,
    checkpoint: { lastSeenPostId: '100', lastSuccessAt: '2026-10-14T00:01:00.000Z' },
    nextCheckAt: null, backoffUntil: null, rejectedCount: 0, gapCount: 0,
    receipts: [{ dedupeKey: 'x:9:100', logicalPostId: '100', revisionId: '100', status: 'submitted',
      missionId: 'x-mission-' + 'a'.repeat(32), repository: 'https://github.com/owner/estate', at: '2026-10-14T00:01:00.000Z' }] },
  ...over,
})
const stoppedStatus = () => ({ ...readingStatus(), enabled: false, running: false, reader: null, credential: null,
  checkpoint: { lastSeenPostId: '100', lastSuccessAt: '2026-10-14T00:01:00.000Z' } })

/** An injected host port that records every call and answers from a script. */
function hostPort(script) {
  const calls = []
  const port = {
    calls,
    xHandoff: async (body) => { calls.push({ op: 'handoff', body }); return script.handoff(body) },
    xStatus: async () => { calls.push({ op: 'status' }); return script.status() },
    xStop: async () => { calls.push({ op: 'stop' }); return script.stop() },
  }
  return port
}

const findAll = (node, pred, out = []) => {
  if (node === null || node === undefined) return out
  if (pred(node)) out.push(node)
  for (const c of node.children ?? []) findAll(c, pred, out)
  return out
}

/** The app's side of the handoff: native mode on, and a recorded checkpoint adoption. */
function hostBridge(over = {}) {
  const adopted = []
  return { adopted, nativeExecution: () => true,
    adoptCheckpoint: async (owner, cp) => { adopted.push({ owner, ...cp }); return true }, ...over }
}
async function mount(v, port, { bridge = hostBridge(), connection = null, hostXSignIn = undefined } = {}) {
  phoneDom()
  const root = makeElement('div')
  mountXPanel(root, { connection, keys: v.keys, prefs: v.prefs, onSaved: () => {}, onOpenRuntimePrefs: () => {},
    hostClient: (url) => { port.urls = [...(port.urls ?? []), url]; return port }, hostBridge: bridge,
    ...(hostXSignIn ? { hostXSignIn, hostLabel: () => 'studio' } : {}) })
  const button = (text) => findAll(root, (n) => n.tagName === 'BUTTON' && n.textContent === text)[0]
  const result = findAll(root, (n) => n.role === 'status')[0]
  const press = async (text) => {
    button(text).click()
    for (let i = 0; i < 400 && result.textContent === 'Working…'; i++) await new Promise((r) => setTimeout(r, 1))
    return result.textContent
  }
  const toggle = findAll(root, (n) => n.tagName === 'INPUT' && n.type === 'checkbox')[0]
  const flip = async (checked) => {
    toggle.checked = checked
    toggle.onchange()
    for (let i = 0; i < 400 && result.textContent === 'Working…'; i++) await new Promise((r) => setTimeout(r, 1))
    return result.textContent
  }
  return { root, button, result, press, flip, bridge }
}

// ------------------------------------------------------------------ client
section('HTTP client: host routes')
{
  const requests = []
  const answers = []
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init })
    const [status, body] = answers.shift()
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  const client = new HttpNativeBrokerClient({ brokerUrl: BROKER, credential: () => 'broker-credential', fetch: fetchImpl })
  answers.push([200, { jobs: [{ missionId: 'x-mission-' + 'b'.repeat(32), state: 'running', scopeRevision: 1, brokerSeq: 4, holdReason: null }] }])
  const jobs = await client.listJobs('owner 1')
  assert(jobs.length === 1 && jobs[0].brokerSeq === 4, 'listJobs decodes the id/state rows')
  assert(requests[0].url === `${BROKER}/v1/native/jobs?ownerId=owner%201` && requests[0].init.method === 'GET',
    'listJobs reads GET /v1/native/jobs with the encoded owner')
  answers.push([200, { jobs: [{ missionId: '../x', state: 'running', scopeRevision: 1, brokerSeq: 1, holdReason: null }] }])
  let threw = null
  try { await client.listJobs('owner-1') } catch (e) { threw = e }
  assert(threw instanceof NativeBrokerError && threw.outcome === 'rejected', 'a malformed job row refuses the whole list')

  answers.push([200, { ...readingStatus(), accessToken: 'leak', credential: { state: 'active', expiresAt: null, refreshToken: 'leak' } }])
  const status = await client.xStatus()
  assert(!JSON.stringify(status).includes('leak'), 'status decoding whitelists fields: no token field reaches the phone')
  assert(status.reader.receipts.length === 1 && status.reader.lastSuccessAt === '2026-10-14T00:01:00.000Z', 'status keeps receipts and checkpoint')
  assert(decodeNativeXHostStatus({ ...readingStatus(), reader: { withheld: 'x_reader_status_unreadable' } }).reader === 'withheld',
    'a withheld reader status stays withheld')

  answers.push([409, { error: 'x_handoff_rejected' }])
  threw = null
  try { await client.xHandoff({ accessToken: 'a', refreshToken: 'r', clientId: 'c', spriiteHandle: 'S', template: TEMPLATE, delivery: DELIVERY }) } catch (e) { threw = e }
  const sent = requests.at(-1)
  assert(sent.url === `${BROKER}/v1/native/x/handoff` && sent.init.method === 'POST' && JSON.parse(sent.init.body).refreshToken === 'r',
    'the handoff POSTs the pair in the body only')
  assert(!sent.url.includes('r=') && sent.init.headers.Authorization === 'Bearer broker-credential', 'no secret in the URL; bearer auth to the broker')
  assert(threw instanceof NativeBrokerError && threw.code === 'x_handoff_rejected' && threw.status === 409 && !threw.message.includes('a'.repeat(2)),
    'the broker code is carried as a code, never a body echo')
  answers.push([503, { error: 'x_reader_config_persist_failed' }])
  threw = null
  try { await client.xHandoff({ accessToken: 'a', refreshToken: 'r', clientId: 'c', spriiteHandle: 'S', template: TEMPLATE, delivery: DELIVERY }) } catch (e) { threw = e }
  assert(threw?.outcome === 'unknown', 'a 5xx after the handoff body was sent is unknown, not refused')
  answers.push([200, stoppedStatus()])
  await client.xStop()
  assert(requests.at(-1).url === `${BROKER}/v1/native/x/stop` && requests.at(-1).init.body === '{}', 'stop sends an empty body')
}

// ------------------------------------------------------------------- prefs
section('prefs: xHostReader validator')
{
  const v = vaults()
  assert(v.prefs.xHostReader === false, 'the phone reads X by default')
  await v.prefs.setXHostReader(true)
  const again = new PrefsVault(v.gateway)
  await again.load()
  assert(again.xHostReader === true, 'the flag survives a relaunch')
  const record = JSON.parse(v.stored.get('spriite.prefs.v1'))
  v.stored.set('spriite.prefs.v1', JSON.stringify({ ...record, xHostReader: 'yes' }))
  const corrupt = new PrefsVault(v.gateway)
  await corrupt.load()
  assert(corrupt.xHostReader === false, 'a corrupt flag reads as the phone reading')
}

// ----------------------------------------------------------------- handoff
section('handoff: verified success clears the refresh token')
{
  const v = await readyPhone()
  const port = hostPort({ handoff: () => readingStatus(), status: () => readingStatus(), stop: () => stoppedStatus() })
  const p = await mount(v, port)
  const text = await p.press('Read X on my Factory host')
  const body = port.calls[0]?.body
  assert(port.calls.length === 1 && body.accessToken === 'access-live' && body.refreshToken === 'refresh-live', 'the live pair is handed off once')
  assert(body.clientId === 'client-1' && body.spriiteHandle === 'Spriite' && body.defaultRepository === 'https://github.com/owner/estate',
    'client id, handle and designated repository travel with it')
  assert(JSON.stringify(body.template) === JSON.stringify(v.prefs.nativeXAuto.template) &&
    JSON.stringify(body.delivery) === JSON.stringify(DELIVERY), 'the saved X template and delivery defaults travel with it')
  assert(port.urls[0] === BROKER, 'the handoff goes to the profile’s broker')
  assert(v.keys.xRefresh === '' && v.keys.x === 'access-live', 'verified success drops only the refresh token')
  assert(v.prefs.xHostReader === true, 'verified success records the host reader')
  assert(text.startsWith('Your Factory host reads X as @Spriite.'), 'the result names the Factory host reading')
  const shown = textOf(p.root)
  assert(shown.includes('Receipts from your Factory host') && shown.includes('submitted → https://github.com/owner/estate'),
    'host receipts are shown in place of phone ones')
  assert(!shown.includes('refresh-live') && !shown.includes('access-live'), 'no token is rendered')
  assert(p.button('Read X on my Factory host').hidden && !p.button('Read X on this phone again').hidden, 'the control flips to taking X back')
  const verify = await p.press('Save and verify')
  assert(/Tap Read X on this phone again first/.test(verify), 'the phone refuses to verify a paste while the Factory host owns the pair')
}

section('handoff after host sign-in: the reader settings travel without any token')
{
  const v = await readyPhone()
  await v.keys.clearX()
  const signIn = { available: () => true, start: async () => ({ state: 'connected', handle: 'Spriite' }),
    status: async () => ({ state: 'connected', handle: 'Spriite' }) }
  const port = hostPort({ handoff: () => readingStatus(), status: () => readingStatus(), stop: () => stoppedStatus() })
  const p = await mount(v, port, { hostXSignIn: signIn })
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1))
  assert(!v.keys.x && !v.keys.xRefresh, 'the phone holds no X token after a host sign-in')
  assert(textOf(p.root).includes('Your computer signed in to X and holds the token'), 'the host note says the computer holds the token')
  const text = await p.press('Read X on my Factory host')
  const body = port.calls.find((c) => c.op === 'handoff')?.body
  assert(body !== undefined && !('accessToken' in body) && !('refreshToken' in body),
    'a token-less handoff carries no accessToken or refreshToken (the broker joins the pair its sign-in holds)')
  assert(body?.spriiteHandle === 'Spriite' && JSON.stringify(body?.template) === JSON.stringify(v.prefs.nativeXAuto.template),
    'the reader settings still travel: handle and X template')
  assert(v.prefs.xHostReader === true && text.startsWith('Your Factory host reads X as @Spriite.'), 'the computer reads X and the phone records it')
}

section('handoff: a refusal before storage keeps the phone reading')
{
  const v = await readyPhone()
  const port = hostPort({
    handoff: () => { throw new NativeBrokerError('rejected', 'native broker HTTP 409', 'x_handoff_rejected', 409) },
    status: () => readingStatus(), stop: () => stoppedStatus(),
  })
  const p = await mount(v, port)
  const text = await p.press('Read X on my Factory host')
  assert(v.keys.xRefresh === 'refresh-live' && v.prefs.xHostReader === false, 'refresh token kept and phone reading restored')
  assert(text.startsWith('X refused this token on the Factory host.') && text.endsWith('This phone keeps reading X.'), 'the reason is named')
  assert(port.calls.length === 1, 'no status or stop for a refusal the broker made before storing')
}

section('handoff: an unknown outcome settled by status (not reading) stops the Factory host')
{
  const v = await readyPhone()
  const port = hostPort({
    handoff: () => { throw new NativeBrokerError('unknown', 'native broker HTTP 503', 'x_reader_config_persist_failed', 503) },
    status: () => ({ ...readingStatus(), running: false, reader: null, lastError: 'x_reader_config_persist_failed' }),
    stop: () => stoppedStatus(),
  })
  const p = await mount(v, port)
  const text = await p.press('Read X on my Factory host')
  assert(port.calls.map((c) => c.op).join(',') === 'handoff,status,stop', 'status settles the outcome, then the Factory host is stopped')
  assert(v.keys.xRefresh === 'refresh-live' && v.prefs.xHostReader === false, 'not verified: the refresh token stays and the phone reads again')
  assert(/did not start reading X \(x_reader_config_persist_failed\)/.test(text), 'the host error is named')
}

section('handoff: an unknown outcome settled by status (reading) is a success')
{
  const v = await readyPhone()
  const port = hostPort({
    handoff: () => { throw new NativeBrokerError('unknown', 'native broker deadline exceeded') },
    status: () => readingStatus(), stop: () => stoppedStatus(),
  })
  const p = await mount(v, port)
  await p.press('Read X on my Factory host')
  assert(v.keys.xRefresh === '' && v.prefs.xHostReader === true, 'a status showing the Factory host reading with this handle is verification')
}

section('handoff: an unconfirmable outcome stays paused and keeps the token')
{
  const v = await readyPhone()
  const port = hostPort({
    handoff: () => { throw new NativeBrokerError('unknown', 'native broker transport unavailable') },
    status: () => { throw new NativeBrokerError('rejected', 'native broker transport unavailable') },
    stop: () => stoppedStatus(),
  })
  const p = await mount(v, port)
  const text = await p.press('Read X on my Factory host')
  assert(v.keys.xRefresh === 'refresh-live', 'unverified: the refresh token is never cleared')
  assert(v.prefs.xHostReader === true, 'phone reading stays paused so two readers never renew one pair')
  assert(/stays paused/.test(text), 'the result says the phone is paused')
}

section('handoff: an answer that does not show the Factory host reading is not verification')
{
  for (const [label, status] of [
    ['not running', { ...readingStatus(), running: false }],
    ['no stored credential', { ...readingStatus(), credential: null }],
    ['another handle', { ...readingStatus(), spriiteHandle: 'Someone' }],
    ['withheld reader', { ...readingStatus(), reader: 'withheld' }],
  ]) {
    const v = await readyPhone()
    const port = hostPort({ handoff: () => status, status: () => status, stop: () => stoppedStatus() })
    const p = await mount(v, port)
    await p.press('Read X on my Factory host')
    assert(v.keys.xRefresh === 'refresh-live' && v.prefs.xHostReader === false &&
      port.calls.at(-1).op === 'stop', `${label}: the Factory host is stopped and the phone keeps its pair`)
  }
}

section('handoff: a renewal during the handoff is caught')
{
  const v = await readyPhone()
  const port = hostPort({
    handoff: async () => { await v.keys.setXRotation('access-2', 'refresh-2'); return readingStatus() },
    status: () => readingStatus(), stop: () => stoppedStatus(),
  })
  const p = await mount(v, port)
  await p.press('Read X on my Factory host')
  assert(v.keys.xRefresh === 'refresh-2' && v.prefs.xHostReader === false && port.calls.at(-1).op === 'stop',
    'the Factory host holding a dead pair is stopped; the phone keeps the live one')
}

section('handoff: preconditions send nothing')
{
  for (const [label, setup, re] of [
    ['no broker credential', (v) => v.keys.clearNativeBroker(), /Factory-native broker/],
    // The phone never asks for token JSON (REDESIGN-SPEC §6): a phone-held
    // token without its refresh token is pointed at host sign-in instead.
    ['no refresh token', (v) => v.keys.setX('access-live'), /no X token with a refresh token to hand over\. Sign in on your computer/],
    ['no client id', (v) => v.prefs.setXClientId(''), /client id/],
    ['no X template', (v) => v.prefs.setNativeXAuto(false, null), /X launch settings/],
  ]) {
    const v = await readyPhone()
    await setup(v)
    const port = hostPort({ handoff: () => readingStatus(), status: () => readingStatus(), stop: () => stoppedStatus() })
    const p = await mount(v, port)
    const text = await p.press('Read X on my Factory host')
    assert(port.calls.length === 0 && re.test(text) && v.prefs.xHostReader === false, `${label}: refused before any call`)
  }
}

section('read X on this phone again')
{
  const v = await readyPhone()
  await v.prefs.setXHostReader(true)
  await v.keys.clearXRefresh()
  const port = hostPort({ handoff: () => readingStatus(), status: () => readingStatus(), stop: () => stoppedStatus() })
  const p = await mount(v, port)
  await quiesce()
  assert(port.calls[0]?.op === 'status' && textOf(p.root).includes('Receipts from your Factory host'), 'mounting with the host reader loads host status')
  const text = await p.press('Read X on this phone again')
  assert(port.calls.at(-1).op === 'stop' && v.prefs.xHostReader === false, 'stop is sent and the flag cleared')
  assert(/sign in on your computer/.test(text) && /erased its copy/.test(text) && !/token JSON/.test(text),
    'the owner is told to connect again by signing in on the computer, never to paste token JSON')
  assert(p.bridge.adopted.length === 1 && p.bridge.adopted[0].owner === '9' && p.bridge.adopted[0].lastSeenPostId === '100',
    'the phone adopts the Factory host\u2019s checkpoint before it reads X again')

  const v2 = await readyPhone()
  await v2.prefs.setXHostReader(true)
  const failing = hostPort({ handoff: () => readingStatus(), status: () => readingStatus(),
    stop: () => { throw new NativeBrokerError('unknown', 'native broker transport unavailable') } })
  const p2 = await mount(v2, failing)
  await p2.press('Read X on this phone again')
  assert(v2.prefs.xHostReader === true, 'an unconfirmed stop keeps phone reading off')
}

// --------------------------------------------------------- polling deferral
section('polling deferral')
{
  const v = await readyPhone()
  const kv = new TestKV()
  const supervisor = new Supervisor({ store: createRuntimeStore(kv), kv, clients: makeClients(),
    settings: () => ({ ...SETTINGS, sessionSettings: {} }), now: () => Date.parse('2026-10-14T00:00:00.000Z'), emitView: () => {} })
  await supervisor.boot()
  const calls = []
  const transport = {
    me: async () => { calls.push('me'); return { id: '9', username: 'owner', protected: false } },
    userByUsername: async () => { calls.push('user'); return { id: '77', username: 'Spriite' } },
    ownerPosts: async () => { calls.push('timeline'); return { posts: [], includes: {}, nextToken: null } },
    post: async () => { calls.push('post'); throw new Error('unused') },
  }
  let xEnabled = true
  // The exact gate src/main.ts builds: the host reader turns phone polling off.
  const connection = new XConnection({ keys: v.keys, supervisor, foreground: () => true,
    enabled: () => xEnabled && !v.prefs.xHostReader, repository: () => '', transport: () => transport,
    now: () => Date.parse('2026-10-14T00:00:00.000Z') })
  const bound = await connection.connect('', 'Spriite')
  assert(bound.ok === true && connection.active, 'phone intake is live before the handoff')
  await v.prefs.setXHostReader(true)
  calls.length = 0
  connection.tick()
  await quiesce()
  assert(!connection.active && calls.length === 0, 'with the host reader on the phone never reads X')
  assert(await connection.check() === 'X intake is off or its token is not verified.', 'an explicit check is refused too')
  xEnabled = true
  await v.prefs.setXHostReader(false)
  assert(connection.active, 'taking X back re-enables phone polling')
}

// ---------------------------------------------------------------- adoption
section('adoption of host-launched jobs')
{
  const HOST_ID = 'x-mission-' + 'c'.repeat(32)
  const OTHER_ID = 'x-mission-' + 'd'.repeat(32)
  const host = (id, over = {}) => ({
    protocolVersion: 1, backend: 'factory_native', missionId: id, ownerId: PROFILE.ownerId, scopeRevision: 1, brokerSeq: 3,
    state: 'running', control: 'running',
    binding: { sessionId: 'root-host', machineId: PROFILE.machineId, cwd: `/host/jobs/${id}/work`,
      repository: 'https://github.com/owner/estate', baseRef: 'refs/heads/main', baseSha: 'b'.repeat(40) },
    capabilities: { protocolVersion: 1, qualificationId: 'q', transportVersion: 't', qualified: true, launch: true,
      rootAttention: true, childAttention: true, recoverAttention: true, pause: true, resume: true, cancel: true },
    attention: [], features: [], commands: [],
    history: [{ id: 'h-1', who: 'owner', text: 'Build the estate page', at: '2026-10-14T00:00:00.000Z' }],
    lastObservedAt: '2026-10-14T00:00:00.000Z', completeness: 'complete', holdReason: null, finalization: null, ...over,
  })
  // Held after a launch whose outcome was lost: bound, and maybe running on the Factory host.
  const HELD_ID = 'x-mission-' + '9'.repeat(32)
  const snapshots = new Map([[HOST_ID, host(HOST_ID)], [OTHER_ID, host(OTHER_ID, { ownerId: 'someone-else' })],
    [HELD_ID, host(HELD_ID, { state: 'held', holdReason: 'launch_unknown' })]])
  const broker = {
    prepared: [], reads: [],
    async capabilities() { return host(HOST_ID).capabilities },
    async prepare(v) { broker.prepared.push(v); throw new Error('never prepared') },
    async observe(id, owner) { broker.reads.push({ id, owner }); return structuredClone(snapshots.get(id)) },
    async command() { throw new Error('no commands here') },
    async listJobs() {
      return [
        { missionId: HOST_ID, state: 'running', scopeRevision: 1, brokerSeq: 3, holdReason: null },
        { missionId: OTHER_ID, state: 'running', scopeRevision: 1, brokerSeq: 3, holdReason: null },
        { missionId: 'phone-made-1', state: 'running', scopeRevision: 1, brokerSeq: 1, holdReason: null },
        { missionId: 'x-mission-' + 'e'.repeat(32), state: 'held', scopeRevision: 1, brokerSeq: 1, holdReason: 'selected_machine_unavailable', bound: false },
        { missionId: HELD_ID, state: 'held', scopeRevision: 1, brokerSeq: 4, holdReason: 'launch_unknown', bound: true },
      ]
    },
  }
  const kv = new TestKV()
  const config = { ...SETTINGS, sessionSettings: {}, nativeProfile: { ...PROFILE }, nativeDelivery: DELIVERY }
  const supervisor = new Supervisor({ store: createRuntimeStore(kv), kv, clients: makeClients(), nativeClient: broker,
    settings: () => config, now: () => Date.parse('2026-10-14T00:05:00.000Z'), emitView: () => {} })
  await supervisor.boot()
  let profile = { ...PROFILE }
  const adopter = new HostJobAdopter({
    profile: () => profile, credential: () => 'broker-credential', client: () => broker,
    known: (id) => supervisor.missions.some((m) => m.missionId === id),
    adopt: (s) => supervisor.adoptHostNativeJob(s), enabled: () => true,
  })
  assert(HOST_MISSION_ID.test(HOST_ID) && !HOST_MISSION_ID.test('phone-made-1'), 'host ids are the reader’s deterministic mint')
  const first = await adopter.pass()
  await supervisor.flush(); await quiesce()
  assert(first.adopted.length === 2 && first.adopted[0] === HOST_ID, 'the owner’s host job is adopted')
  assert(first.adopted.includes(HELD_ID) && supervisor.missions.some((m) => m.missionId === HELD_ID),
    'a bound held host job is adopted too, so its hold reason shows on the phone')
  assert(first.deferred.includes(OTHER_ID) && !supervisor.missions.some((m) => m.missionId === OTHER_ID),
    'another owner’s job is never adopted')
  assert(!broker.reads.some((r) => r.id === 'phone-made-1' || r.id.endsWith('e'.repeat(32))),
    'non-host ids and never-bound host jobs are not even read')
  const mission = supervisor.missions.find((m) => m.missionId === HOST_ID)
  const cache = decodeNativeCache(supervisor.missionStore.current.engineSnapshots[HOST_ID])
  assert(mission?.config.executionBackend === 'factory_native' && mission.config.nativeOrigin === 'x' &&
    mission.goal === 'Build the estate page', 'it is a native X mission with the owner’s words as its goal')
  assert(mission.config.nativeIntent.scopeApproved && mission.config.nativeIntent.highAutonomyApproved && cache?.imported === true,
    'already approved and marked imported')
  assert(mission.config.nativeIntent.workspace.cwd === `/host/jobs/${HOST_ID}/work` &&
    mission.config.nativeIntent.policy.allowPush === true && mission.config.nativeIntent.policy.allowCreateRepository === false,
    'the intent mirrors the broker binding and the delivery defaults')
  assert(broker.prepared.length === 0, 'adoption never prepares the job again')
  assert(broker.reads.filter((r) => r.id === HOST_ID).length >= 2 && supervisor.nativeSnapshotFor(HOST_ID)?.state === 'running',
    'the adopted mission is observed through the broker')
  assert(supervisor.heldNativeIntents().length === 0 && supervisor.presentationFor(HOST_ID) !== null,
    'it is a live mission, not a held intent')

  const reads = broker.reads.length
  const second = await adopter.pass()
  assert(second.adopted.length === 0 && supervisor.missions.filter((m) => m.missionId === HOST_ID).length === 1,
    'a second pass adopts nothing twice')
  assert(!broker.reads.slice(reads).some((r) => r.id === HOST_ID), 'a known job is not re-read for adoption')
  const again = await supervisor.adoptHostNativeJob(host(HOST_ID))
  assert(again.receipt === 'duplicate' && again.missionId === HOST_ID, 'adopting the same snapshot again is a duplicate')
  const foreign = await supervisor.adoptHostNativeJob(host('x-mission-' + 'f'.repeat(32), { ownerId: 'someone-else' }))
  assert(foreign.receipt === 'rejected' && /another owner/.test(foreign.reason), 'the supervisor refuses another owner’s job')
  const unbound = await supervisor.adoptHostNativeJob(host('x-mission-' + '1'.repeat(32), { binding: null }))
  assert(unbound.receipt === 'rejected', 'an unbound job waits for a later pass')
  const elsewhere = await supervisor.adoptHostNativeJob(host('x-mission-' + '2'.repeat(32),
    { binding: { ...host(HOST_ID).binding, machineId: 'other-machine' } }))
  assert(elsewhere.receipt === 'rejected', 'a job bound to another machine is refused')

  // Crash replay: a new runtime over the same store observes, never prepares.
  const supervisor2 = new Supervisor({ store: createRuntimeStore(kv), kv, clients: makeClients(), nativeClient: broker,
    settings: () => config, now: () => Date.parse('2026-10-14T00:06:00.000Z'), emitView: () => {} })
  await supervisor2.boot()
  await supervisor2.flush(); await quiesce()
  assert(broker.prepared.length === 0 && supervisor2.missions.filter((m) => m.missionId === HOST_ID).length === 1,
    'a relaunch restores the adopted mission without preparing it')

  profile = { ...PROFILE, ownerId: 'owner-2' }
  const changed = await adopter.pass()
  assert(changed.adopted.length === 0, 'a profile owner change adopts nothing for the old owner')
  const disabled = new HostJobAdopter({ profile: () => PROFILE, credential: () => '', client: () => { throw new Error('no client') },
    known: () => false, adopt: async () => ({ receipt: 'saved' }), enabled: () => true })
  const none = await disabled.pass()
  assert(none.adopted.length === 0, 'no broker credential: no list and no adoption')
}

// ------------------------------------------------------ review regressions
section('handoff: only an owner who opted into automatic native X builds hands off')
{
  for (const [label, setup, bridge, re] of [
    ['auto-run off', (v) => v.prefs.setNativeXAuto(false, TEMPLATE), hostBridge(), /running X requests automatically/],
    ['legacy backend', async () => {}, hostBridge({ nativeExecution: () => false }), /Factory-native missions only/],
    ['backend unknown', async () => {}, hostBridge({ nativeExecution: undefined }), /Factory-native missions only/],
    ['no repository account', (v) => v.prefs.setXDefaultRepository(''), hostBridge(), /new repositories from X are created under that account/],
    ['unreadable repositories', async () => {}, hostBridge({ repositories: () => Promise.reject(new Error('github down')) }), /repositories could not be read/],
  ]) {
    const v = await readyPhone()
    await setup(v)
    const port = hostPort({ handoff: () => readingStatus(), status: () => readingStatus(), stop: () => stoppedStatus() })
    const p = await mount(v, port, { bridge })
    const text = await p.press('Read X on my Factory host')
    assert(port.calls.length === 0 && re.test(text) && v.prefs.xHostReader === false && v.keys.xRefresh === 'refresh-live',
      `${label}: refused before anything is sent`)
  }
}

section('handoff: the account for new repositories and the owner’s repository names travel with it')
{
  const v = await readyPhone()
  await v.keys.setRepoUrl('https://github.com/appowner/spriite')
  const port = hostPort({ handoff: () => readingStatus(), status: () => readingStatus(), stop: () => stoppedStatus() })
  const p = await mount(v, port, { bridge: hostBridge({ repositories: async () => ['owner/estate', 'owner/habit-log', 'bad name'] }) })
  await p.press('Read X on my Factory host')
  const body = port.calls[0]?.body
  const expected = 'appowner'
  assert(body?.repositoryAccount === expected, 'the app repository’s account (else the X default’s) is sent for new repositories')
  assert(JSON.stringify(body.repositories) === JSON.stringify(['owner/estate', 'owner/habit-log']), 'repository names travel, malformed ones dropped')
  assert(body.startAt === undefined && body.seenPostIds === undefined, 'no phone checkpoint without a phone intake')
}

/** A real XConnection over a fake transport whose timeline read can be held open and rotate the pair. */
async function liveConnection(v) {
  const kv = new TestKV()
  const supervisor = new Supervisor({ store: createRuntimeStore(kv), kv, clients: makeClients(),
    settings: () => ({ ...SETTINGS, sessionSettings: {} }), now: () => Date.parse('2026-10-14T00:00:00.000Z'), emitView: () => {} })
  await supervisor.boot()
  const gate = { hold: null, release: null }
  const transport = {
    me: async () => ({ id: '9', username: 'owner', protected: false }),
    userByUsername: async () => ({ id: '77', username: 'Spriite' }),
    ownerPosts: async () => {
      if (gate.hold) { await gate.hold; await v.keys.setXRotation('access-2', 'refresh-2') }
      return { posts: [], includes: {}, nextToken: null }
    },
    post: async () => null,
  }
  const connection = new XConnection({ keys: v.keys, supervisor, foreground: () => true,
    enabled: () => !v.prefs.xHostReader, repository: () => '', transport: () => transport,
    now: () => Date.parse('2026-10-14T00:00:00.000Z') })
  const bound = await connection.connect('', 'Spriite')
  assert(bound.ok === true, 'the phone intake is bound')
  await connection.check()
  return { connection, gate, supervisor }
}

section('handoff: a phone renewal already in flight finishes before the pair is read')
{
  const v = await readyPhone()
  await v.prefs.setFlag('persistent_runtime_v2', true)
  const { connection, gate } = await liveConnection(v)
  const lastSuccessAt = connection.health().lastSuccessAt
  gate.hold = new Promise((resolve) => { gate.release = resolve })
  const inFlight = connection.check()
  await quiesce()
  const port = hostPort({ handoff: () => readingStatus(), status: () => readingStatus(), stop: () => stoppedStatus() })
  const p = await mount(v, port, { connection })
  const pressing = p.press('Read X on my Factory host')
  await quiesce()
  assert(port.calls.length === 0, 'nothing is sent while a phone check is still in the air')
  gate.release()
  const text = await pressing
  await inFlight
  const body = port.calls[0]?.body
  assert(body?.refreshToken === 'refresh-2' && body.accessToken === 'access-2', 'the handoff carries the pair the in-flight renewal rotated to')
  assert(v.keys.xRefresh === '' && v.prefs.xHostReader === true && /Your Factory host reads X/.test(text), 'and the handoff completes with it')
  assert(lastSuccessAt !== null && body.startAt === lastSuccessAt, 'the Factory host starts reading where the phone’s last check began')
  const phoneHealth = findAll(p.root, (n) => n.className === 'msg muted' && /X intake is off/.test(n.textContent ?? ''))
  assert(phoneHealth.every((n) => n.hidden), 'the phone’s own "X intake is off" summary is hidden while the Factory host reads')
}

section('kill switch and Disconnect stop the Factory host first')
{
  const v = await readyPhone()
  await v.prefs.setFlag('persistent_runtime_v2', true)
  await v.prefs.setFlag('x_owner_intake', true)
  await v.prefs.setXHostReader(true)
  const port = hostPort({ handoff: () => readingStatus(), status: () => readingStatus(), stop: () => stoppedStatus() })
  const p = await mount(v, port)
  const off = await p.flip(false)
  assert(port.calls.some((c) => c.op === 'stop') && v.prefs.xHostReader === false && /Your Factory host stopped reading X/.test(off),
    'turning X requests off stops the Factory host and says so only once it is confirmed')

  const v2 = await readyPhone()
  await v2.prefs.setFlag('persistent_runtime_v2', true)
  await v2.prefs.setXHostReader(true)
  const failing = hostPort({ handoff: () => readingStatus(), status: () => readingStatus(),
    stop: () => { throw new NativeBrokerError('unknown', 'native broker transport unavailable') } })
  const p2 = await mount(v2, failing)
  const offFailed = await p2.flip(false)
  assert(/may still be reading X/.test(offFailed) && v2.prefs.xHostReader === true, 'an unconfirmed stop is never reported as off')
  const kept = await p2.press('Disconnect X')
  assert(/Nothing was disconnected/.test(kept) && v2.keys.x === 'access-live', 'Disconnect does not leave the Factory host reading behind it')

  const v3 = await readyPhone()
  await v3.prefs.setXHostReader(true)
  const port3 = hostPort({ handoff: () => readingStatus(), status: () => readingStatus(), stop: () => stoppedStatus() })
  const p3 = await mount(v3, port3)
  const gone = await p3.press('Disconnect X')
  assert(port3.calls.some((c) => c.op === 'stop') && gone === 'Disconnected.' && v3.keys.x === '' && v3.prefs.xHostReader === false,
    'Disconnect stops the Factory host, then disconnects')
}

section('taking X back adopts the Factory host’s checkpoint or stays paused')
{
  const v = await readyPhone()
  await v.prefs.setXHostReader(true)
  const port = hostPort({ handoff: () => readingStatus(), status: () => readingStatus(), stop: () => stoppedStatus() })
  const p = await mount(v, port, { bridge: hostBridge({ adoptCheckpoint: async () => false }) })
  const text = await p.press('Read X on this phone again')
  assert(v.prefs.xHostReader === true && /stays paused/.test(text), 'an unsaved checkpoint keeps the phone paused')

  // The supervisor only ever moves the phone checkpoint forward.
  const v2 = await readyPhone()
  await v2.prefs.setFlag('persistent_runtime_v2', true)
  const { supervisor } = await liveConnection(v2)
  const before = supervisor.missionStore.current.xIntake.lastSeenPostId ?? null
  assert(await supervisor.adoptHostXCheckpoint('9', { lastSeenPostId: '500', lastSuccessAt: '2026-10-14T00:02:00.000Z' }), 'adopted')
  assert(supervisor.missionStore.current.xIntake.lastSeenPostId === '500' && before !== '500', 'the phone resumes after the Factory host')
  assert(await supervisor.adoptHostXCheckpoint('9', { lastSeenPostId: '400', lastSuccessAt: null }) &&
    supervisor.missionStore.current.xIntake.lastSeenPostId === '500', 'an older checkpoint never moves it back')
  assert(await supervisor.adoptHostXCheckpoint('4242', { lastSeenPostId: '900', lastSuccessAt: null }) &&
    supervisor.missionStore.current.xIntake.lastSeenPostId === '500', 'another owner’s checkpoint is not adopted')
  assert(!(await supervisor.adoptHostXCheckpoint('9', { lastSeenPostId: '1x', lastSuccessAt: null })), 'a malformed id is refused')
}

section('client: status checkpoint and job bound decoding')
{
  const ok = decodeNativeXHostStatus({ ...stoppedStatus() })
  assert(ok?.checkpoint?.lastSeenPostId === '100', 'the checkpoint is decoded')
  assert(decodeNativeXHostStatus({ ...stoppedStatus(), checkpoint: { lastSeenPostId: 'x', lastSuccessAt: null } }) === null,
    'a malformed checkpoint refuses the status')
  assert(decodeNativeXHostStatus((({ checkpoint, ...rest }) => rest)(readingStatus()))?.checkpoint === null, 'an older broker reads as no checkpoint')
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} host X phone: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
