/**
 * `spriite pair` end to end, offline: code formats, the CPace exchange through
 * the real relay mailbox (relay/pair.mjs via the Node runner and via the
 * Worker's Durable Object path), one-time codes, expiry, a wrong code burning
 * the session, slot re-rolls, relay traffic free of secrets, the phone's
 * bundle apply into the vaults, vault field validation, isSetupComplete, and
 * the CLI's discovery and redacted dry run with injected env and commands.
 *
 * Usage: node --import ./scripts/ts-resolve.mjs scripts/test-pairing.mjs
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as P from '../broker/pair-protocol.mjs'
import { createPairMailbox, PAIR_BODY_MAX, PAIR_TTL_MS } from '../relay/pair.mjs'
import { relayHandle } from '../relay/node.mjs'
import { handle as workerHandle, PairMailbox } from '../relay/worker.js'
import { KeyVault, realSetupWorks } from '../src/voice/keys.ts'
import { PrefsVault } from '../src/state/prefs.ts'
import { FeedVault } from '../src/state/feed.ts'
import { isSetupComplete } from '../src/state/setup-state.ts'
import { createPairingClient, validatePairingBundle } from '../src/pair/client.ts'
import { discover, dryRunPlan, parseInstallSummary, summaryRows, toBundle } from '../cli/lib/discover.mjs'
import { runPair, parsePairArgs } from '../cli/lib/pair.mjs'
import { bigCode, terminalQr } from '../cli/lib/terminal.mjs'
import { chooseRelay, relayUrl } from '../cli/lib/config.mjs'

let passed = 0, failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${detail ? ` :: ${detail}` : ''}`) }
}
const section = name => console.log(`\n-- ${name}`)
const tick = () => new Promise(resolve => setImmediate(resolve))
const fastSleep = async (_ms, signal) => { if (signal?.aborted) throw new P.PairError('cancelled'); await tick() }

// Secrets the host holds: none may ever appear in relay traffic or terminal output.
const SECRETS = {
  factory: 'fk-fixture-NEVER-SENT-1a2b3c4d',
  github: 'gho_fixtureNEVERSENT0123456789abcd',
  bearer: 'bearer-fixture-NEVER-SENT-0123456789abcdefghijklmnop',
  eleven: 'el-fixture-NEVER-SENT-9876',
}

/** A relay fetch over the Node runner's real request path, recording every byte. */
function relayFixture({ now = () => Date.now(), ...opts } = {}) {
  const mailbox = createPairMailbox({ now, ...opts })
  const traffic = []
  const fetchImpl = async (url, init = {}) => {
    const request = new Request(url, init)
    const body = init.body ? String(init.body) : ''
    const response = await relayHandle(request, null, { ALLOWED_ORIGINS: '*' }, { pair: mailbox, client: opts.client ?? '198.51.100.7' })
    const text = await response.text()
    traffic.push({ url: String(url), body, status: response.status, text })
    return new Response(text, { status: response.status, headers: response.headers })
  }
  return { mailbox, traffic, fetchImpl, client: P.createRelayClient({ base: 'https://relay.example.com/pair/v1', fetchImpl }) }
}

function memoryGateway(map = new Map()) {
  return {
    map,
    call: async (op) => op({
      getLocalStorage: async (k) => map.get(k) ?? '',
      setLocalStorage: async (k, v) => { map.set(k, v); return true },
    }),
  }
}
async function vaults(map = new Map()) {
  const gateway = memoryGateway(map)
  const keys = new KeyVault(gateway), prefs = new PrefsVault(gateway), feed = new FeedVault(gateway)
  await keys.load(); await prefs.load(); await feed.load()
  return { gateway, keys, prefs, feed, map }
}

const BUNDLE = () => ({
  v: 1, kind: 'pair', createdAt: Date.now(),
  host: { label: 'studio', machineId: 'machine-studio-1', ownerId: 'owner-example', brokerUrl: 'https://broker.example.com/', via: 'tailscale', os: 'macos', online: true },
  factory: { apiKey: SECRETS.factory, computerId: 'comp-studio', computerName: 'studio', computerOnline: true },
  github: { token: SECRETS.github, login: 'your-org', repoCount: 12 },
  broker: { bearerToken: SECRETS.bearer },
  voice: { elevenLabsKey: SECRETS.eleven },
  x: { hostSignIn: true },
  native: { brokerUrl: 'https://broker.example.com', ownerId: 'owner-example', machineId: 'machine-studio-1', cwd: '/srv/work', baseRef: 'refs/heads/main' },
})

// ------------------------------------------------------------ codes
section('code formats')
{
  check('a typed pair code normalizes: k7q-2mf -> K7Q2MF', P.normalizePairCode('k7q-2mf ') === 'K7Q2MF')
  check('Crockford reading: O is 0, I and L are 1', P.normalizePairCode('oli-2mf') === '0112MF')
  check('a pair code displays as K7Q-2MF', P.formatPairCode('K7Q2MF') === 'K7Q-2MF')
  check('U and wrong lengths are not pair codes', P.normalizePairCode('K7Q2MU') === null && P.normalizePairCode('K7Q2M') === null)
  const codes = new Set(Array.from({ length: 200 }, () => P.generatePairCode()))
  check('generated pair codes are 6 Crockford characters', [...codes].every(c => /^[0-9A-HJKMNP-TV-Z]{6}$/.test(c)))
  check('a transfer code normalizes: wren 41 oak -> WREN-41-OAK', P.normalizeTransferCode('wren 41 oak') === 'WREN-41-OAK')
  check('a transfer code displays as WREN · 41 · OAK', P.formatTransferCode('WREN-41-OAK') === 'WREN · 41 · OAK')
  check('the display form reads back as the same transfer code', P.normalizeTransferCode('WREN · 41 · OAK') === 'WREN-41-OAK')
  check('words outside the list are not transfer codes', P.normalizeTransferCode('WREN 41 XYZZY') === null && P.normalizeTransferCode('WREN 4 OAK') === null)
  check('the transfer word list has exactly 256 distinct words', P.TRANSFER_WORDS.length === 256 && new Set(P.TRANSFER_WORDS).size === 256)
  check('generated transfer codes are WORD-NN-WORD', Array.from({ length: 100 }, () => P.generateTransferCode()).every(c => P.normalizeTransferCode(c) === c))
  check('the public slot is the first 2 characters (pair) and the first word (move)', P.slotOf('pair', 'K7Q2MF') === 'K7' && P.slotOf('move', 'WREN-41-OAK') === 'WREN')
  const qr = P.encodeQr({ kind: 'pair', code: 'K7Q2MF', secret: new Uint8Array(16).fill(7), relay: 'https://relay.example.com' })
  const parsed = P.parseQr(qr, 'pair')
  check('the QR carries the code, a 16-byte secret and the relay base', parsed?.code === 'K7Q2MF' && P.fromB64u(parsed.secret)?.length === 16 && parsed.relay === 'https://relay.example.com')
  check('a pasted code parses as a code without a secret', P.parseQr('k7q-2mf', 'pair')?.secret === null)
  check('a move QR is not read as a pair QR', P.parseQr(P.encodeQr({ kind: 'move', code: 'WREN-41-OAK', secret: new Uint8Array(16) }), 'pair') === null)
  const m = P.qrMatrix(qr)
  const finder = (x, y) => [0, 1, 2, 3, 4, 5, 6].every(i => m[y][x + i] && m[y + 6][x + i] && m[y + i][x] && m[y + i][x + 6])
  check('the QR matrix is square with three finder patterns', m.length >= 21 && m.every(r => r.length === m.length) &&
    finder(0, 0) && finder(m.length - 7, 0) && finder(0, m.length - 7))
  check('the terminal QR draws every module row in half blocks', terminalQr(m).split('\n').length === Math.ceil((m.length + 8) / 2))
  check('the code prints large: five rows of block letters', bigCode('K7Q-2MF').split('\n').length === 5 && bigCode('K7Q-2MF').includes('█'))
}

// ------------------------------------------------------------ PAKE through the relay
section('CPace pairing through the relay mailbox')
{
  const r = relayFixture()
  const host = await P.openHostSession({ kind: 'pair', relay: r.client, relayLabel: 'https://relay.example.com', sleep: fastSleep })
  const sealed = BUNDLE()
  const finish = host.finish(() => sealed)
  const joined = await P.joinSession({ kind: 'pair', relay: r.client, code: host.display.toLowerCase(), sleep: fastSleep })
  const result = await finish
  check('the PAKE round trip delivers the bundle intact', joined.ok && JSON.stringify(joined.payload) === JSON.stringify(sealed))
  check('the host sees the phone confirm (done)', result.ok === true)
  const all = r.traffic.map(t => t.body + t.text).join('\n')
  check('relay traffic never contains a plaintext secret', Object.values(SECRETS).every(s => !all.includes(s)))
  check('relay traffic never contains the full code or the QR secret', !all.includes(host.code) && !all.includes(host.secret))
  check('relay traffic carries no plaintext bundle field names', !/apiKey|bearerToken|elevenLabsKey|computerId/.test(all))
  const again = await P.joinSession({ kind: 'pair', relay: r.client, code: host.code, sleep: fastSleep })
  check('a code works once: a second claim after success is refused', !again.ok && (again.reason === 'used' || again.reason === 'not_found'), JSON.stringify(again))
  const opened = r.traffic.find(t => t.url.endsWith('/open'))
  const openBody = JSON.parse(opened.body)
  check('the mailbox open carries only slot, session id and public shares', Object.keys(openBody).sort().join() === 'kind,sid,slot,ya' &&
    openBody.slot === host.code.slice(0, 2) && P.fromB64u(openBody.ya.code).length === 32 && openBody.ya.code !== openBody.ya.qr)
}
{
  const r = relayFixture()
  const host = await P.openHostSession({ kind: 'pair', relay: r.client, sleep: fastSleep })
  const finish = host.finish(() => BUNDLE())
  const qr = P.parseQr(host.qrText, 'pair')
  const joined = await P.joinSession({ kind: 'pair', relay: r.client, code: qr.code, qrSecret: qr.secret, sleep: fastSleep })
  const result = await finish
  check('a scanned QR (code plus 16-byte secret) pairs too', joined.ok && result.ok)
  const putB = r.traffic.find(t => t.url.endsWith('/put') && JSON.parse(t.body).role === 'b')
  check('the phone declares which variant it used (qr)', JSON.parse(putB.body).msg.variant === 'qr')
}
{
  const r = relayFixture()
  const host = await P.openHostSession({ kind: 'pair', relay: r.client, sleep: fastSleep })
  const finish = host.finish(() => BUNDLE())
  const qr = P.parseQr(host.qrText, 'pair')
  const wrongSecret = P.toB64u(new Uint8Array(16).fill(1))
  const joined = await P.joinSession({ kind: 'pair', relay: r.client, code: qr.code, qrSecret: wrongSecret, sleep: fastSleep })
  const result = await finish
  check('a right code with the wrong QR secret fails key confirmation', !joined.ok && joined.reason === 'wrong_code' && result.reason === 'wrong_code')
}

section('one online guess per code: a wrong code burns the session')
{
  const r = relayFixture()
  const host = await P.openHostSession({ kind: 'pair', relay: r.client, sleep: fastSleep })
  let released = false
  const finish = host.finish(() => { released = true; return BUNDLE() })
  const last = host.code[5]
  const wrong = host.code.slice(0, 5) + (P.PAIR_ALPHABET[(P.PAIR_ALPHABET.indexOf(last) + 1) % 32])
  const guess = await P.joinSession({ kind: 'pair', relay: r.client, code: wrong, sleep: fastSleep })
  const result = await finish
  check('a wrong code fails key confirmation on both ends', !guess.ok && guess.reason === 'wrong_code' && !result.ok && result.reason === 'wrong_code')
  check('the host releases nothing after a failed confirmation', released === false)
  const all = r.traffic.map(t => t.text).join('\n')
  check('no ciphertext ever reached the mailbox for the wrong guess', !/"ct"/.test(all))
  const real = await P.joinSession({ kind: 'pair', relay: r.client, code: host.code, sleep: fastSleep })
  check('the burned session refuses even the right code afterwards', !real.ok && real.reason === 'used', JSON.stringify(real))
}

section('expiry: 10 minutes, enforced by the relay and both ends')
{
  let clock = 1_000_000
  const now = () => clock
  const r = relayFixture({ now })
  const host = await P.openHostSession({ kind: 'pair', relay: r.client, now, sleep: fastSleep })
  check('the host shows a 10-minute expiry from the relay clock', host.expiresAt - clock === PAIR_TTL_MS && PAIR_TTL_MS === 600000)
  clock += PAIR_TTL_MS + 1
  const late = await P.joinSession({ kind: 'pair', relay: r.client, code: host.code, now, sleep: fastSleep })
  check('a claim after 10 minutes is refused as expired', !late.ok && late.reason === 'expired', JSON.stringify(late))
  const hostEnd = await host.finish(() => BUNDLE())
  check('the host stops waiting at its own deadline (expired)', !hostEnd.ok && hostEnd.reason === 'expired')
  const tomb = await r.mailbox.route('claim', { kind: 'pair', slot: host.code.slice(0, 2) }, 'x')
  check('an expired session keeps only a bare tombstone that answers expired', tomb.status === 410)
  clock += 61_000
  await r.mailbox.sweep()
  check('the sweep leaves nothing behind after expiry', (await r.mailbox.route('claim', { kind: 'pair', slot: host.code.slice(0, 2) }, 'x')).status === 404)
}
{
  let clock = 5_000_000
  const now = () => clock
  const r = relayFixture({ now })
  const host = await P.openHostSession({ kind: 'pair', relay: r.client, now, sleep: fastSleep })
  const finish = host.finish(() => BUNDLE())
  const slowSleep = async () => { clock += 5 * 60_000; await tick() }
  // The phone claims in time, then the host never answers: the phone gives up at the deadline.
  const phone = await P.joinSession({ kind: 'pair', relay: { ...r.client, call: async (route, body, s) => {
    if (route === 'get') { clock += PAIR_TTL_MS; return { msg: null, closed: null, expiresAt: 0, now: clock } }
    return r.client.call(route, body, s)
  } }, code: host.code, now, sleep: slowSleep })
  check('the phone end enforces the expiry too', !phone.ok && phone.reason === 'expired', JSON.stringify(phone))
  await host.cancel()
  await finish
}

section('slot collisions re-roll the code')
{
  const r = relayFixture()
  const first = await P.openHostSession({ kind: 'pair', relay: r.client, sleep: fastSleep, code: 'K7Q2MF' })
  const plan = ['K7ABCD', 'M3XY9Z']
  const idx = c => P.PAIR_ALPHABET.indexOf(c)
  const random = n => {
    if (n === 6 && plan.length) return Uint8Array.from([...plan.shift()].map(idx))
    return P.randomBytes(n)
  }
  const second = await P.openHostSession({ kind: 'pair', relay: r.client, sleep: fastSleep, random })
  check('a second open on a taken slot is refused (slot_taken) and the host re-rolls', second.code === 'M3XY9Z' && first.code === 'K7Q2MF')
  const opens = r.traffic.filter(t => t.url.endsWith('/open')).map(t => t.status)
  check('the relay answered the colliding open with 409', opens.join() === '200,409,200', opens.join())
  await first.cancel(); await second.cancel()
}

section('relay mailbox rules')
{
  let clock = 0
  const mailbox = createPairMailbox({ now: () => clock })
  const sid = P.toB64u(P.randomBytes(16)), point = P.toB64u(P.randomBytes(32))
  const open = await mailbox.route('open', { kind: 'pair', slot: 'AB', sid, ya: { code: point, qr: point } }, 'c1')
  check('open answers a host token and a 10-minute expiry', open.status === 200 && open.body.expiresAt === PAIR_TTL_MS && typeof open.body.hostToken === 'string')
  const claim = await mailbox.route('claim', { kind: 'pair', slot: 'AB' }, 'c1')
  const claim2 = await mailbox.route('claim', { kind: 'pair', slot: 'AB' }, 'c2')
  check('one claim per session', claim.status === 200 && claim2.status === 409)
  const ref = { kind: 'pair', slot: 'AB', sid }
  const forged = await mailbox.route('put', { ...ref, token: P.toB64u(P.randomBytes(32)), role: 'a', msg: { tag: 'x' } }, 'c3')
  check('a put without the session token is forbidden', forged.status === 403)
  await mailbox.route('put', { ...ref, token: claim.body.claimToken, role: 'b', msg: { y: point, variant: 'code', tag: 'abc' } }, 'c1')
  const twice = await mailbox.route('put', { ...ref, token: claim.body.claimToken, role: 'b', msg: { y: point, variant: 'code', tag: 'abc' } }, 'c1')
  check('one message per role', twice.status === 409)
  await mailbox.route('put', { ...ref, token: open.body.hostToken, role: 'a', msg: { tag: 't', iv: 'i', ct: 'CIPHERTEXT' } }, 'c1')
  await mailbox.route('close', { ...ref, token: claim.body.claimToken, reason: 'done' }, 'c1')
  const after = await mailbox.route('poll', { ...ref, token: open.body.hostToken }, 'c1')
  check('closing drops the ciphertext and shares, keeping only the reason', after.body.closed === 'done' && after.body.msg === null &&
    !JSON.stringify(after.body).includes('CIPHERTEXT'))
  const reopen = await mailbox.route('open', { kind: 'pair', slot: 'AB', sid: P.toB64u(P.randomBytes(16)), ya: { code: point, qr: point } }, 'c1')
  check('a closed slot can be opened again by a new session', reopen.status === 200)
  let limited = 0
  for (let i = 0; i < 12; i++) if ((await mailbox.route('claim', { kind: 'pair', slot: 'ZZ' }, 'one-ip')).status === 429) limited++
  check('claims are rate limited per client (10 a minute)', limited === 2)
  clock += 60_000
  check('the claim rate limit refills after a minute', (await mailbox.route('claim', { kind: 'pair', slot: 'ZZ' }, 'one-ip')).status === 404)
  const big = await relayHandle(new Request('https://relay.example.com/pair/v1/put', { method: 'POST', body: 'x'.repeat(PAIR_BODY_MAX + 1) }), null, { ALLOWED_ORIGINS: '*' }, { pair: mailbox })
  check('a body over 1 MB is refused with 413', big.status === 413)
  const get = await relayHandle(new Request('https://relay.example.com/pair/v1/claim'), null, { ALLOWED_ORIGINS: '*' }, { pair: mailbox })
  check('mailbox routes are POST only', get.status === 405)
  const pre = await relayHandle(new Request('https://relay.example.com/pair/v1/claim', { method: 'OPTIONS', headers: { origin: 'https://app.example' } }), null, { ALLOWED_ORIGINS: '*' }, { pair: mailbox })
  check('mailbox routes answer CORS preflights like the bridge', pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*')
  const refused = await relayHandle(new Request('https://relay.example.com/pair/v1/claim', { method: 'POST', body: '{}', headers: { origin: 'https://evil.example' } }), null, { ALLOWED_ORIGINS: 'https://app.example' }, { pair: mailbox })
  check('an origin the relay was not configured for is refused before the mailbox', refused.status === 403)
}
{
  // Cloudflare: the worker sends every mailbox request to one Durable Object.
  const storage = new Map()
  let alarm = null
  const state = { storage: {
    get: async k => storage.get(k), put: async (k, v) => { storage.set(k, structuredClone(v)) }, delete: async k => { storage.delete(k) },
    list: async () => new Map(storage), getAlarm: async () => alarm, setAlarm: async t => { alarm = t },
  } }
  const object = new PairMailbox(state)
  const ns = { idFromName: name => name, get: () => ({ fetch: req => object.fetch(req) }) }
  const env = { ALLOWED_ORIGINS: '*', PAIR_MAILBOX: ns }
  const fetchImpl = async (url, init) => workerHandle(new Request(url, init), env)
  const client = P.createRelayClient({ base: 'https://relay.example.com/pair/v1', fetchImpl })
  const host = await P.openHostSession({ kind: 'pair', relay: client, sleep: fastSleep })
  const finish = host.finish(() => BUNDLE())
  const joined = await P.joinSession({ kind: 'pair', relay: client, code: host.code, sleep: fastSleep })
  check('the Worker pairs through its Durable Object mailbox', joined.ok && (await finish).ok)
  check('the Durable Object schedules its expiry sweep', typeof alarm === 'number')
  const none = await workerHandle(new Request('https://relay.example.com/pair/v1/claim', { method: 'POST', body: '{}' }), { ALLOWED_ORIGINS: '*' })
  check('a Worker without the PAIR_MAILBOX binding refuses the mailbox (503), never a split-brain memory one', none.status === 503)
  const wrangler = readFileSync(new URL('../relay/wrangler.toml', import.meta.url), 'utf8')
  check('wrangler.toml binds PAIR_MAILBOX to the PairMailbox class with a migration', /name = "PAIR_MAILBOX", class_name = "PairMailbox"/.test(wrangler) && /new_sqlite_classes = \["PairMailbox"\]/.test(wrangler))
}

// ------------------------------------------------------------ vaults
section('vault fields and setup completion')
{
  const store = new Map([['spriite.prefs.v1', JSON.stringify({ v: 1, setupCompletedAt: '5', runOn: 'mars', pairedHost: { label: 'studio' }, setupPath: 'teleport', spokenReplies: 'no' })],
    ['spriite.keys.v1', JSON.stringify({ v: 1, factory: 'fk-x', repoMode: 'many' })]])
  const { keys, prefs } = await vaults(store)
  check('wrong-typed stored values read as absence', prefs.setupCompletedAt === 0 && prefs.runOn === 'cloud' && prefs.pairedHost === null &&
    prefs.setupPath === '' && prefs.spokenReplies === true && keys.repoMode === 'one')
  check('setters refuse malformed values', !(await prefs.setRunOn('mars')) && !(await prefs.setPairedHost({ label: '' })) && !(await keys.setRepoMode('many')))
  await prefs.setPairedHost({ label: 'studio', machineId: 'machine-1', ownerId: 'owner-example', brokerUrl: 'https://broker.example.com/', via: 'tailscale', os: 'linux', pairedAt: 1 })
  check('runOn defaults to the paired computer once there is one', prefs.runOn === 'host' && prefs.pairedHost?.brokerUrl === 'https://broker.example.com')
  await prefs.setRunOn('cloud'); await prefs.setSpokenReplies(false); await prefs.setSetupPath('key_only'); await prefs.setSetupCompleted(1234)
  await keys.setRepoMode('per_idea')
  const reread = await vaults(store)
  check('the new fields survive a reload', reread.prefs.runOn === 'cloud' && reread.prefs.spokenReplies === false && reread.prefs.setupPath === 'key_only' &&
    reread.prefs.setupCompletedAt === 1234 && reread.keys.repoMode === 'per_idea' && reread.prefs.pairedHost?.label === 'studio')
  check('realSetupWorks: a Factory key and a repo, or a Factory key with a new repo per idea',
    realSetupWorks({ factory: 'k', repoUrl: 'https://github.com/your-org/shop-site' }) && realSetupWorks({ factory: 'k', repoUrl: '', repoMode: 'per_idea' }) &&
    !realSetupWorks({ factory: 'k', repoUrl: '' }) && !realSetupWorks({ factory: '', repoUrl: '', repoMode: 'per_idea' }))
  check('isSetupComplete: Finish setup, or an existing working setup', isSetupComplete({ factory: '', repoUrl: '' }, { setupCompletedAt: 1 }) &&
    isSetupComplete({ factory: 'k', repoUrl: 'https://github.com/your-org/shop-site' }, { setupCompletedAt: 0 }) &&
    !isSetupComplete({ factory: 'k', repoUrl: '' }, { setupCompletedAt: 0 }) && !isSetupComplete({ factory: '', repoUrl: '', repoMode: 'per_idea' }, { setupCompletedAt: 0 }))
  const legacy = await vaults(new Map([['spriite.keys.v1', JSON.stringify({ v: 1, factory: 'fk-old', repoUrl: 'https://github.com/your-org/shop-site' })]]))
  check('an existing install with a working setup never sees Welcome again', isSetupComplete(legacy.keys, legacy.prefs))
}

section('bundle apply stores a paired X app and token pair')
{
  const { keys, prefs } = await vaults()
  const client = createPairingClient({ keys, prefs, feed: { restore: () => [], save: async () => true }, relayBase: 'https://relay.example.com/pair/v1' })
  const b = BUNDLE()
  b.x = { hostSignIn: true, clientId: 'x-client-fixture', accessToken: 'x-access-fixture-1', refreshToken: 'x-refresh-fixture-1' }
  const applied = await client.applyPairingBundle(validatePairingBundle(b), { runOn: 'host' })
  check('the X pair and client id are written', applied.applied.includes('x') && keys.x === 'x-access-fixture-1' && prefs.xClientId === 'x-client-fixture')
}

section('bundle apply writes the vaults through their setters')
{
  const { keys, prefs } = await vaults()
  await prefs.setNativeLaunchProfile({ brokerUrl: '', ownerId: '', machineId: '', cwd: '/home/me/kept-checkout', baseRef: '' })
  const client = createPairingClient({ keys, prefs, feed: { restore: () => [], save: async () => true }, relayBase: 'https://relay.example.com/pair/v1', now: () => 99 })
  const bundle = validatePairingBundle(BUNDLE())
  const applied = await client.applyPairingBundle(bundle, { runOn: 'host' })
  check('apply reports every item it wrote', applied.ok && ['factory', 'computer', 'github', 'broker', 'voice', 'pairedHost', 'runOn', 'setupPath', 'nativeProfile'].every(id => applied.applied.includes(id)), JSON.stringify(applied))
  check('keys land in KeyVault', keys.factory === SECRETS.factory && keys.github === SECRETS.github && keys.elevenLabs === SECRETS.eleven && keys.computerId === 'comp-studio')
  check('the broker bearer is bound to the canonical broker URL', keys.nativeBrokerFor('https://broker.example.com/') === SECRETS.bearer && keys.nativeBrokerFor('https://other.example.com') === '')
  check('pairedHost, runOn and setupPath are stored', prefs.pairedHost?.label === 'studio' && prefs.pairedHost.pairedAt === 99 && prefs.runOn === 'host' && prefs.setupPath === 'paired')
  const p = prefs.nativeLaunchProfile
  check('empty native profile fields are prefilled from pairing', p.brokerUrl === 'https://broker.example.com' && p.ownerId === 'owner-example' && p.machineId === 'machine-studio-1' && p.baseRef === 'refs/heads/main')
  check('a filled native profile field is never overwritten', p.cwd === '/home/me/kept-checkout')
}
{
  const { keys, prefs } = await vaults()
  const client = createPairingClient({ keys, prefs, feed: { restore: () => [], save: async () => true }, relayBase: 'https://relay.example.com/pair/v1' })
  const applied = await client.applyPairingBundle(validatePairingBundle(BUNDLE()), { runOn: 'cloud' })
  check('no X pair in the bundle writes no X credential', !applied.applied.includes('x') && keys.x === '')
  check('Factory cloud: the Droid computer id is not written', !applied.applied.includes('computer') && keys.computerId === '' && prefs.runOn === 'cloud')
  check('a malformed bundle is refused whole', validatePairingBundle({ ...BUNDLE(), host: { ...BUNDLE().host, brokerUrl: 'http://evil.example' } }) === null &&
    validatePairingBundle({ ...BUNDLE(), v: 2 }) === null)
}

{
  // A computer paired without the Spriite host: the installer sends
  // "unknown" ids and no host link. Nothing invented is stored or prefilled.
  const { keys, prefs } = await vaults()
  const client = createPairingClient({ keys, prefs, feed: { restore: () => [], save: async () => true }, relayBase: 'https://relay.example.com/pair/v1' })
  const hostless = { ...BUNDLE(), host: { ...BUNDLE().host, machineId: 'unknown', ownerId: 'unknown', brokerUrl: '', via: 'none' },
    broker: { bearerToken: null }, native: null }
  const bundle = validatePairingBundle(hostless)
  const applied = await client.applyPairingBundle(bundle, { runOn: 'cloud' })
  check('a hostless pairing stores the computer without placeholder ids', applied.applied.includes('pairedHost') &&
    prefs.pairedHost?.machineId === '' && prefs.pairedHost?.ownerId === '' && prefs.pairedHost?.via === 'none')
  check('a hostless pairing prefills no Factory-native ids', prefs.nativeLaunchProfile.ownerId === '' && prefs.nativeLaunchProfile.machineId === '')
}

section('phone claim, end to end through the pairing client')
{
  const r = relayFixture()
  const { keys, prefs, feed } = await vaults()
  const client = createPairingClient({ keys, prefs, feed, relayBase: 'https://relay.example.com/pair/v1', fetchImpl: r.fetchImpl, sleep: fastSleep })
  check('normalizePairCode / formatPairCode match C5', client.normalizePairCode('k7q-2mf ') === 'K7Q2MF' && client.formatPairCode('K7Q2MF') === 'K7Q-2MF')
  const host = await P.openHostSession({ kind: 'pair', relay: r.client, sleep: fastSleep })
  const finish = host.finish(() => BUNDLE())
  const outcome = await client.claimPairing(host.display)
  await finish
  check('claimPairing returns the validated bundle', outcome.ok && outcome.bundle.host.label === 'studio' && outcome.bundle.factory.apiKey === SECRETS.factory)
  const bad = await client.claimPairing('nope')
  check('a malformed code is invalid before any network call', !bad.ok && bad.reason === 'invalid')
  // A slot no session holds: the open host session's own code shares the
  // first two characters (the mailbox slot) with 'ZZ…' about 1 in 1024 runs.
  const unused = client.normalizePairCode(host.display).startsWith('ZZ') ? 'YYYYYY' : 'ZZZZZZ'
  const missing = await client.claimPairing(unused)
  check('a code nobody opened is not_found', !missing.ok && missing.reason === 'not_found')
  const down = createPairingClient({ keys, prefs, feed, relayBase: 'https://relay.example.com/pair/v1', fetchImpl: async () => { throw new TypeError('offline') } })
  check('an unreachable relay reads as unreachable', (await down.claimPairing('K7Q2MF')).reason === 'unreachable')
  const ctl = new AbortController(); ctl.abort()
  check('an aborted claim reads as cancelled', (await client.claimPairing('K7Q2MF', { signal: ctl.signal })).reason === 'cancelled')
}

// ------------------------------------------------------------ CLI discovery
section('spriite pair: discovery with injected env and commands')
const home = mkdtempSync(join(tmpdir(), 'spriite-pair-'))
try {
  const base = join(home, '.local/share/spriite/native-broker')
  const files = new Map([
    [join(base, 'broker.env'), "export SPRIITE_NATIVE_OWNER_ID='owner-example'\nexport SPRIITE_NATIVE_MACHINE_ID='machine-studio-1'\nexport SPRIITE_NATIVE_PORT='47821'\nexport SPRIITE_NATIVE_X_READER='1'\n"],
    [join(base, 'bearer-token'), SECRETS.bearer],
    [join(base, 'secrets', 'factory-api-key'), SECRETS.factory],
  ])
  const ran = []
  const commands = {
    'gh auth token': { status: 0, stdout: `${SECRETS.github}\n` },
    'gh api user': { status: 0, stdout: JSON.stringify({ login: 'your-org', public_repos: 9, total_private_repos: 3 }) },
    'tailscale serve status --json': { status: 0, stdout: JSON.stringify({ TCP: { 47822: { HTTPS: true } }, Web: { 'studio.tailnet.example:47822': {} } }) },
    'tailscale status --json': { status: 0, stdout: JSON.stringify({ Self: { DNSName: 'studio.tailnet.example.' } }) },
  }
  const run = (cmd, args, opts = {}) => { ran.push({ cmd, args, env: opts.env }); return commands[[cmd, ...args].join(' ')] ?? { status: 127, stdout: '' } }
  const relay = relayFixture()
  const fetchImpl = async (url, init) => {
    const u = String(url)
    if (u === 'http://127.0.0.1:47821/v1/native/capabilities') return new Response('{}', { status: init?.headers?.authorization === `Bearer ${SECRETS.bearer}` ? 200 : 401 })
    if (u === 'https://api.factory.ai/api/v0/computers') return new Response(JSON.stringify({ computers: [{ id: 'other', name: 'laptop', status: 'active' }, { id: 'machine-studio-1', name: 'studio', status: 'active' }] }), { status: 200 })
    if (u.startsWith('https://relay.example.com/pair/v1/')) return relay.fetchImpl(url, init)
    return new Response('{}', { status: 404 })
  }
  const ctx = { env: { ELEVENLABS_API_KEY: SECRETS.eleven }, platform: 'linux', home, hostname: 'studio.local', run, readFile: p => files.get(p) ?? null, fetch: fetchImpl, sleep: tick, installer: '/x/install-native-broker.sh' }
  const d = await discover(ctx)
  check('discovery reuses the running broker install', d.install.present && d.install.action === 'reuse' && d.brokerOnline)
  check('the Factory key comes from the installed key file', d.factory.apiKey === SECRETS.factory && d.factory.keySource === 'install')
  check('FACTORY_API_KEY wins over the key file', (await discover({ ...ctx, env: { FACTORY_API_KEY: 'fk-from-env-123456789' } })).factory.keySource === 'env')
  check('the Droid computer is matched to this machine in the account list', d.factory.computerId === 'machine-studio-1' && d.factory.computerName === 'studio' && d.factory.computerOnline)
  check('GitHub comes from gh auth token with a repo count', d.github.token === SECRETS.github && d.github.repoCount === 12 && d.github.login === 'your-org')
  check('the private host URL comes from tailscale serve', d.host.brokerUrl === 'https://studio.tailnet.example:47822' && d.host.via === 'tailscale')
  check('owner, machine and bearer come from the install', d.host.ownerId === 'owner-example' && d.host.machineId === 'machine-studio-1' && d.host.bearerToken === SECRETS.bearer)
  check('ElevenLabs and host X sign-in are found', d.voice.elevenLabsKey === SECRETS.eleven && d.x.hostSignIn === true)
  const bundle = validatePairingBundle(toBundle(d, Date.now()))
  check('the discovery builds a valid PairingBundle', bundle !== null && bundle.native?.brokerUrl === 'https://studio.tailnet.example:47822' && bundle.broker.bearerToken === SECRETS.bearer)
  const rows = summaryRows(d)
  check('the summary rows match the Review screen', rows.map(r => `${r.found ? 'Found' : 'Later'} ${r.name}: ${r.detail}`).join('|') ===
    'Found Factory account: Signed in on studio|Found Droid computer: studio · online|Found Spriite host: Private link over Tailscale|' +
    'Found GitHub: From the GitHub CLI · 12 repos|Found Voice replies: ElevenLabs key from this computer|Later X requests: Connect from your computer later')
  // Saved on the host: the ElevenLabs key file and the owner's X app + token pair.
  const xp = { clientId: 'x-client-fixture', accessToken: 'x-access-fixture-1', refreshToken: 'x-refresh-fixture-1' }
  const saved = new Map([...files, [join(base, 'secrets', 'elevenlabs-api-key'), 'sk_from_key_file_123\n'], [join(base, 'secrets', 'x-pair.json'), JSON.stringify(xp)]])
  const ds = await discover({ ...ctx, env: {}, readFile: q => saved.get(q) ?? null })
  check('the ElevenLabs key file is read when the env has none', ds.voice.elevenLabsKey === 'sk_from_key_file_123')
  check('the saved X pair is found', ds.x.pair?.clientId === xp.clientId && ds.x.pairFile === join(base, 'secrets', 'x-pair.json'))
  const xb = validatePairingBundle(toBundle(ds, Date.now()))
  check('the bundle carries the X client id and token pair', xb?.x.clientId === xp.clientId && xb.x.accessToken === xp.accessToken && xb.x.refreshToken === xp.refreshToken)
  check('the X row reads Found with a saved pair', summaryRows(ds).at(-1).found && summaryRows(ds).at(-1).detail === 'X app and token from this computer')
  const badX = new Map([...files, [join(base, 'secrets', 'x-pair.json'), JSON.stringify({ ...xp, refreshToken: xp.accessToken })]])
  check('a malformed X pair is ignored', (await discover({ ...ctx, readFile: q => badX.get(q) ?? null })).x.pair === null)
  check('the dry run redacts the X pair', !dryRunPlan(ds, { relay: 'https://relay.example.com' }).includes(xp.refreshToken))
  check('a bundle without X pair fields stays valid', validatePairingBundle(toBundle(d, Date.now()))?.x.accessToken === null)
  const plan = dryRunPlan(d, { relay: 'https://relay.example.com' })
  check('the dry run redacts every secret', Object.values(SECRETS).every(s => !plan.includes(s)) && plan.includes('•••• (found)'))

  // No install yet: the installer runs non-interactively with the discovered inputs.
  const bare = new Map([[join(home, '.factory', 'auth.json'), JSON.stringify({ tokens: { api: 'fk-droid-login-key-12345' } })]])
  const installed = { ...ctx, readFile: p => bare.get(p) ?? null }
  const skipped = await discover(installed)
  check('without MODELS a first install is skipped with the reason (Later)', skipped.install.action === 'skip' && /MODELS/.test(skipped.install.note) && skipped.factory.keySource === 'droid')
  ran.length = 0
  const summary = { v: 1, os: 'linux', base, ownerId: 'owner-example', machineId: 'machine-studio-1', port: 47821, brokerUrl: 'https://studio.tailnet.example:47822', via: 'tailscale', tokenFile: join(base, 'bearer-token'), xReader: true }
  commands['bash /x/install-native-broker.sh --non-interactive --summary'] = { status: 0, stdout: `== next steps\nSPRIITE_INSTALL_SUMMARY ${JSON.stringify(summary)}\n` }
  commands['tailscale version'] = { status: 0, stdout: '1.0' }
  const withModels = await discover({ ...installed, models: '["model-fixture"]', readFile: p => (ran.some(x => x.cmd === 'bash') ? files.get(p) : null) ?? bare.get(p) ?? null })
  const call = ran.find(x => x.cmd === 'bash')
  check('a first install runs the installer non-interactively with the discovered key and models', withModels.install.action === 'install' && call &&
    call.env.FACTORY_API_KEY === 'fk-droid-login-key-12345' && call.env.MODELS === '["model-fixture"]' && call.env.EXPOSE === 'tailscale')
  check('the installer summary line is parsed', parseInstallSummary(commands['bash /x/install-native-broker.sh --non-interactive --summary'].stdout)?.machineId === 'machine-studio-1')
  const before = ran.length
  const dry = await discover({ ...installed, models: '["m"]', dryRun: true })
  check('--dry-run never runs the installer', dry.install.action === 'install' && !ran.slice(before).some(x => x.cmd === 'bash'))
  const noInstall = await discover({ ...installed, models: '["m"]', noInstall: true })
  check('--no-install never installs', noInstall.install.action === 'skip')

  // The whole command: the code, the QR, the phone, the summary.
  section('spriite pair: the whole command against a local relay')
  let out = '', err = ''
  const phone = await vaults()
  const pairing = createPairingClient({ keys: phone.keys, prefs: phone.prefs, feed: phone.feed, relayBase: 'https://relay.example.com/pair/v1', fetchImpl: relay.fetchImpl, sleep: fastSleep })
  let claimed = null
  const exit = await runPair(['--relay', 'https://relay.example.com'], {
    ...ctx, now: Date.now, out: t => { out += t }, err: t => { err += t }, isTTY: false, color: false, protocol: P,
    loadConfig: () => null, saveConfig: () => {},
    onSession: session => { claimed = pairing.claimPairing(session.display) },
  })
  const got = await claimed
  check('spriite pair exits 0 after the phone opened the bundle', exit === 0, err)
  check('the phone received the discovered keys', got?.ok && got.bundle.factory.apiKey === SECRETS.factory && got.bundle.broker.bearerToken === SECRETS.bearer)
  check('the terminal shows the code large, the QR and the expiry', /[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}/.test(out) && out.includes('█') && /Works once · expires in 10:00/.test(out))
  check('the command finishes with the Found / Later summary', /Paired with “studio”/.test(out) && /Found  Factory account/.test(out) && /Later  X requests/.test(out))
  check('the terminal never prints a secret', Object.values(SECRETS).every(s => !out.includes(s) && !err.includes(s)))
  check('relay traffic from the command carries no secret', Object.values(SECRETS).every(s => !relay.traffic.some(t => t.body.includes(s) || t.text.includes(s))))
  // A saved X pair travels once: the host copy is removed after the phone has it.
  {
    const removed = []
    const xFile = join(base, 'secrets', 'x-pair.json')
    const xSaved = new Map([...files, [xFile, JSON.stringify({ clientId: 'x-client-fixture', accessToken: 'x-access-fixture-2', refreshToken: 'x-refresh-fixture-2' })]])
    const phone2 = await vaults()
    const pairing2 = createPairingClient({ keys: phone2.keys, prefs: phone2.prefs, feed: phone2.feed, relayBase: 'https://relay.example.com/pair/v1', fetchImpl: relay.fetchImpl, sleep: fastSleep })
    let claimed2 = null, out2 = ''
    const exit2 = await runPair(['--relay', 'https://relay.example.com'], {
      ...ctx, readFile: q => xSaved.get(q) ?? null, removeFile: q => removed.push(q), now: Date.now, out: t => { out2 += t }, err: () => {}, isTTY: false, color: false, protocol: P,
      loadConfig: () => null, saveConfig: () => {}, onSession: session => { claimed2 = pairing2.claimPairing(session.display) },
    })
    const got2 = await claimed2
    check('a saved X pair reaches the phone and the host copy is removed', exit2 === 0 && got2?.ok && got2.bundle.x.refreshToken === 'x-refresh-fixture-2' &&
      removed.length === 1 && removed[0] === xFile && /Found  X requests/.test(out2) && !out2.includes('x-refresh-fixture-2'))
  }
  check('argument parsing: --relay, --dry-run, --no-install; unknown options refused',
    parsePairArgs(['--relay=https://relay.example.com', '--dry-run', '--no-install']).opts?.noInstall === true && parsePairArgs(['--bogus']).error)
  check('the relay comes from --relay, then SPRIITE_RELAY, then the saved config', chooseRelay({ flag: null, env: { SPRIITE_RELAY: 'https://relay.example.com/' }, saved: { relay: 'https://other.example.com' } }) === 'https://relay.example.com' &&
    chooseRelay({ flag: null, env: {}, saved: { relay: 'https://other.example.com' } }) === 'https://other.example.com' && relayUrl('http://relay.example.com') === null)
  let noRelayErr = ''
  const noRelay = await runPair([], { ...ctx, out: () => {}, err: t => { noRelayErr += t }, isTTY: false, protocol: P, loadConfig: () => null, saveConfig: () => {} })
  check('without a relay (and no terminal to ask) the command explains and exits 2', noRelay === 2 && /--relay/.test(noRelayErr))
  let dryOut = ''
  const dryExit = await runPair(['--dry-run', '--relay', 'https://relay.example.com'], { ...ctx, out: t => { dryOut += t }, err: () => {}, isTTY: false, protocol: P, loadConfig: () => null, saveConfig: () => { throw new Error('dry run saved') } })
  check('the dry run prints the plan, redacted, and opens no session', dryExit === 0 && /nothing is changed/.test(dryOut) && Object.values(SECRETS).every(s => !dryOut.includes(s)) && !/expires in/.test(dryOut))
  const winErr = []
  check('Windows is refused with the reason', (await runPair([], { ...ctx, platform: 'win32', out: () => {}, err: t => winErr.push(t), protocol: P })) === 1 && /Windows is not supported/.test(winErr.join('')))
} finally {
  rmSync(home, { recursive: true, force: true })
}

section('package registration')
{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const qualify = readFileSync(new URL('./qualify.mjs', import.meta.url), 'utf8')
  const suites = ['phone-redesign', 'setup-flow', 'pairing', 'transfer', 'host-x-signin', 'hud-redesign']
  check('every redesign suite is a package script and a qualify SUITES row', suites.every(s =>
    pkg.scripts[`test:${s}`] === `node --import ./scripts/ts-resolve.mjs scripts/test-${s}.mjs` && qualify.includes(`script: 'test:${s}'`)))
  check('qualify expects twelve poses, not seventeen', qualify.includes("'twelve poses'") && !qualify.includes('seventeen'))
  check('npm run pair runs the bin from the checkout', pkg.scripts.pair === 'node cli/bin/spriite.mjs pair')
  check('the noble libraries are pinned to exact versions', /^\d+\.\d+\.\d+$/.test(pkg.dependencies['@noble/curves']) && /^\d+\.\d+\.\d+$/.test(pkg.dependencies['@noble/hashes']))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) { console.log('PAIRING TESTS FAILED'); process.exitCode = 1 } else console.log('PAIRING TESTS PASSED')
