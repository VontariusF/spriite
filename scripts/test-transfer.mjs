/**
 * "Move to another phone", offline: the old phone offers a one-time
 * WREN · 41 · OAK code, the new phone receives the PAKE-encrypted MoveBundle
 * through the real relay mailbox and applies keys, the host link, defaults,
 * the activity feed and build history; oversized history is trimmed and an
 * oversized bundle fails with too_large; codes expire after 10 minutes and
 * work once.
 *
 * Usage: node --import ./scripts/ts-resolve.mjs scripts/test-transfer.mjs
 */
import * as P from '../broker/pair-protocol.mjs'
import { createPairMailbox } from '../relay/pair.mjs'
import { relayHandle } from '../relay/node.mjs'
import { KeyVault } from '../src/voice/keys.ts'
import { PrefsVault } from '../src/state/prefs.ts'
import { FeedVault } from '../src/state/feed.ts'
import { isSetupComplete } from '../src/state/setup-state.ts'
import { createPairingClient, parseTransferQr, validateMoveBundle } from '../src/pair/client.ts'

let passed = 0, failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${detail ? ` :: ${detail}` : ''}`) }
}
const section = name => console.log(`\n-- ${name}`)
const tick = () => new Promise(resolve => setImmediate(resolve))
const fastSleep = async (_ms, signal) => { if (signal?.aborted) throw new P.PairError('cancelled'); await tick() }
const BASE = 'https://relay.example.com/pair/v1'
const SECRET_FACTORY = 'fk-move-fixture-NEVER-SENT-77'
const SECRET_BEARER = 'bearer-move-fixture-NEVER-SENT-0123456789abcdefghij'
const SECRET_X_REFRESH = 'x-refresh-fixture-NEVER-MOVES'

function relayFixture(now = () => Date.now()) {
  const mailbox = createPairMailbox({ now })
  const traffic = []
  const fetchImpl = async (url, init = {}) => {
    const response = await relayHandle(new Request(url, init), null, { ALLOWED_ORIGINS: '*' }, { pair: mailbox })
    const text = await response.text()
    traffic.push(String(init.body ?? '') + text)
    return new Response(text, { status: response.status, headers: response.headers })
  }
  return { mailbox, traffic, fetchImpl }
}
const memoryGateway = (map = new Map()) => ({
  call: async (op) => op({
    getLocalStorage: async (k) => map.get(k) ?? '',
    setLocalStorage: async (k, v) => { map.set(k, v); return true },
  }),
})
async function phone(opts = {}) {
  const gateway = memoryGateway()
  const keys = new KeyVault(gateway), prefs = new PrefsVault(gateway), feed = new FeedVault(gateway)
  await keys.load(); await prefs.load(); await feed.load()
  return { keys, prefs, feed, ...opts }
}

async function seededOldPhone() {
  const old = await phone()
  await old.keys.setFactory(SECRET_FACTORY)
  await old.keys.setGithub('gho_moveFixture0123456789abcdefgh')
  await old.keys.setRepoUrl('https://github.com/your-org/shop-site')
  await old.keys.setRepoMode('per_idea')
  await old.keys.setComputerId('comp-studio')
  await old.keys.setNativeBroker(SECRET_BEARER, 'https://broker.example.com')
  await old.keys.setX('x-access-fixture', SECRET_X_REFRESH)
  await old.prefs.setPairedHost({ label: 'studio', machineId: 'machine-studio-1', ownerId: 'owner-example', brokerUrl: 'https://broker.example.com', via: 'tailscale', os: 'macos', pairedAt: 1 })
  await old.prefs.setRunOn('host')
  await old.prefs.setJobs(3)
  await old.prefs.setAskBeforePr(true)
  await old.prefs.setSetupCompleted(1700)
  await old.prefs.setSetupPath('paired')
  await old.prefs.setFlag('archive_mirror', true)
  await old.feed.save([{ at: 2, label: 'Build', text: 'Shop site shipped' }, { at: 1, label: 'Build', text: 'Started shop site' }])
  return old
}

section('offer, receive and apply')
{
  const r = relayFixture()
  const old = await seededOldPhone()
  const records = { missions: [{ id: 'm1', title: 'Shop site' }, { id: 'm2', title: 'Blog' }] }
  let imported = null, adopted = null
  const oldClient = createPairingClient({ keys: old.keys, prefs: old.prefs, feed: old.feed, relayBase: BASE, fetchImpl: r.fetchImpl, sleep: fastSleep,
    history: { export: () => records, count: () => 2, import: async () => true }, archive: { deviceKey: 'archive-device-key-fixture', adoptDeviceKey: async () => true } })
  const fresh = await phone()
  const newClient = createPairingClient({ keys: fresh.keys, prefs: fresh.prefs, feed: fresh.feed, relayBase: BASE, fetchImpl: r.fetchImpl, sleep: fastSleep,
    history: { export: () => null, count: () => 0, import: async h => { imported = h; return true } },
    archive: { deviceKey: '', adoptDeviceKey: async k => { adopted = k; return true } } })
  const offered = await oldClient.offerTransfer()
  check('the old phone offers a WORD-NN-WORD code shown as WREN · 41 · OAK style', offered.ok && P.normalizeTransferCode(offered.offer.code) === offered.offer.code &&
    offered.offer.display === offered.offer.code.split('-').join(' · '))
  check('the offer expires in 10 minutes', offered.ok && Math.abs(offered.offer.expiresAt - Date.now() - 600000) < 5000)
  check('the offer carries a QR with the code and a secret', offered.ok && parseTransferQr(offered.offer.qrText)?.code === offered.offer.code && !!parseTransferQr(offered.offer.qrText)?.secret)
  check('normalizeTransferCode / formatTransferCode match C5', newClient.normalizeTransferCode('wren 41 oak') === 'WREN-41-OAK' && newClient.formatTransferCode('WREN-41-OAK') === 'WREN · 41 · OAK')
  const received = await newClient.receiveTransfer(offered.offer.display.toLowerCase())
  const done = await offered.offer.done
  check('the new phone receives the MoveBundle and the old phone sees it done', received.ok && done.ok)
  const b = received.bundle
  check('the summary counts the keys and builds and names the host', b.summary.hostLabel === 'studio' && b.summary.buildCount === 2 && b.summary.keyCount === Object.keys(b.keys).length)
  check('the X pair does not move (a rotating grant cannot live on two phones)', !('x' in b.keys) && !('xRefresh' in b.keys) && !JSON.stringify(b).includes(SECRET_X_REFRESH))
  const applied = await newClient.applyMoveBundle(b)
  check('apply reports keys, prefs, feed, archive, history and setupPath', applied.ok && ['keys', 'prefs', 'feed', 'archive', 'history', 'setupPath'].every(id => applied.applied.includes(id)), JSON.stringify(applied))
  check('every key and the link to the computer moved', fresh.keys.factory === SECRET_FACTORY && fresh.keys.computerId === 'comp-studio' &&
    fresh.keys.nativeBrokerFor('https://broker.example.com') === SECRET_BEARER && fresh.prefs.pairedHost?.label === 'studio')
  check('build defaults and repo choices moved', fresh.keys.repoMode === 'per_idea' && fresh.keys.repoUrl === 'https://github.com/your-org/shop-site' &&
    fresh.prefs.jobs === 3 && fresh.prefs.askBeforePr === true && fresh.prefs.runOn === 'host' && fresh.prefs.flags.archive_mirror === true)
  check('build history and chats moved (feed, history records, archive key)', fresh.feed.restore().map(e => e.text).join() === 'Shop site shipped,Started shop site' &&
    JSON.stringify(imported) === JSON.stringify(records) && adopted === 'archive-device-key-fixture')
  check('the new phone is set up (moved) and never sees Welcome', fresh.prefs.setupPath === 'moved' && isSetupComplete(fresh.keys, fresh.prefs))
  check('nothing secret crossed the relay in the clear', !r.traffic.some(t => t.includes(SECRET_FACTORY) || t.includes(SECRET_BEARER) || t.includes('Shop site')))
  const again = await newClient.receiveTransfer(offered.offer.code)
  check('a transfer code works once', !again.ok && (again.reason === 'used' || again.reason === 'not_found'), JSON.stringify(again))
}

section('oversized history is trimmed; an oversized bundle is too_large')
{
  const r = relayFixture()
  const old = await seededOldPhone()
  const huge = { missions: [{ id: 'm1', chat: 'x'.repeat(1_200_000) }] }
  const oldClient = createPairingClient({ keys: old.keys, prefs: old.prefs, feed: old.feed, relayBase: BASE, fetchImpl: r.fetchImpl, sleep: fastSleep,
    history: { export: () => huge, count: () => 1, import: async () => true }, archive: { deviceKey: 'archive-key', adoptDeviceKey: async () => true } })
  const fresh = await phone()
  const newClient = createPairingClient({ keys: fresh.keys, prefs: fresh.prefs, feed: fresh.feed, relayBase: BASE, fetchImpl: r.fetchImpl, sleep: fastSleep })
  const offered = await oldClient.offerTransfer()
  const received = await newClient.receiveTransfer(offered.offer.code)
  await offered.offer.done
  check('history over the 1 MB mailbox is trimmed, and everything else still moves', received.ok && received.bundle.history?.records === undefined &&
    received.bundle.history?.archiveDeviceKey === 'archive-key' && received.bundle.keys.factory === SECRET_FACTORY)
  const bigFeed = { restore: () => [{ at: 1, label: 'Build', text: 'y'.repeat(1_100_000) }], save: async () => true }
  const tooBig = createPairingClient({ keys: old.keys, prefs: old.prefs, feed: bigFeed, relayBase: BASE, fetchImpl: r.fetchImpl, sleep: fastSleep })
  const refused = await tooBig.offerTransfer()
  check('a bundle that cannot fit even without history fails with too_large', !refused.ok && refused.reason === 'too_large')
  // The protocol holds the cap too, and tells the receiver.
  const client = P.createRelayClient({ base: BASE, fetchImpl: r.fetchImpl })
  const host = await P.openHostSession({ kind: 'move', relay: client, sleep: fastSleep, maxBytes: 2048 })
  const finish = host.finish(() => ({ v: 1, kind: 'move', blob: 'z'.repeat(4096) }))
  const joined = await P.joinSession({ kind: 'move', relay: client, code: host.code, sleep: fastSleep })
  check('an oversized sealed payload reaches neither the relay nor the phone (too_large on both ends)', (await finish).reason === 'too_large' && !joined.ok && joined.reason === 'too_large')
}

section('expiry and wrong codes')
{
  let clock = 10_000_000
  const now = () => clock
  const r = relayFixture(now)
  const old = await seededOldPhone()
  const oldClient = createPairingClient({ keys: old.keys, prefs: old.prefs, feed: old.feed, relayBase: BASE, fetchImpl: r.fetchImpl, sleep: fastSleep, now })
  const fresh = await phone()
  const newClient = createPairingClient({ keys: fresh.keys, prefs: fresh.prefs, feed: fresh.feed, relayBase: BASE, fetchImpl: r.fetchImpl, sleep: fastSleep, now })
  const offered = await oldClient.offerTransfer()
  clock += 10 * 60_000 + 1
  const late = await newClient.receiveTransfer(offered.offer.code)
  check('a transfer code expires after 10 minutes', !late.ok && late.reason === 'expired', JSON.stringify(late))
  const done = await offered.offer.done
  check('the old phone reports the expiry too', !done.ok && done.reason === 'expired')
  check('nothing was applied on the new phone', fresh.keys.factory === '')
}
{
  const r = relayFixture()
  const old = await seededOldPhone()
  const oldClient = createPairingClient({ keys: old.keys, prefs: old.prefs, feed: old.feed, relayBase: BASE, fetchImpl: r.fetchImpl, sleep: fastSleep })
  const fresh = await phone()
  const newClient = createPairingClient({ keys: fresh.keys, prefs: fresh.prefs, feed: fresh.feed, relayBase: BASE, fetchImpl: r.fetchImpl, sleep: fastSleep })
  const offered = await oldClient.offerTransfer()
  const [w1, nn, w2] = offered.offer.code.split('-')
  const wrong = `${w1}-${String((Number(nn) + 1) % 100).padStart(2, '0')}-${w2}`
  const guess = await newClient.receiveTransfer(wrong)
  check('a wrong transfer code fails key confirmation', !guess.ok && guess.reason === 'wrong_code')
  check('the old phone sees the burned session', (await offered.offer.done).reason === 'wrong_code')
  check('the burned code refuses the right code afterwards', (await newClient.receiveTransfer(offered.offer.code)).reason === 'used')
}
{
  const r = relayFixture()
  const old = await seededOldPhone()
  const oldClient = createPairingClient({ keys: old.keys, prefs: old.prefs, feed: old.feed, relayBase: BASE, fetchImpl: r.fetchImpl, sleep: fastSleep })
  const offered = await oldClient.offerTransfer()
  offered.offer.cancel()
  const done = await offered.offer.done
  const fresh = await phone()
  const newClient = createPairingClient({ keys: fresh.keys, prefs: fresh.prefs, feed: fresh.feed, relayBase: BASE, fetchImpl: r.fetchImpl, sleep: fastSleep })
  check('cancelling the offer ends it on both sides', !done.ok && done.reason === 'cancelled' && (await newClient.receiveTransfer(offered.offer.code)).reason === 'used')
  check('a receive without a relay is unreachable, a malformed code is invalid', (await createPairingClient({ keys: fresh.keys, prefs: fresh.prefs, feed: fresh.feed, relayBase: '' }).receiveTransfer('WREN-41-OAK')).reason === 'unreachable' &&
    (await newClient.receiveTransfer('not a code')).reason === 'invalid')
  check('a move bundle with the wrong shape is refused', validateMoveBundle({ v: 1, kind: 'pair' }) === null && validateMoveBundle({ v: 1, kind: 'move', createdAt: 1, keys: [], prefs: {} }) === null)
}

section('vault transfer validation')
{
  const fresh = await phone()
  const ok = await fresh.keys.importFromTransfer({ factory: 'fk-import', repoMode: 'teleport', nativeBroker: 'token-without-scope', bogus: 'x' })
  check('imported keys pass restore validation (bad repoMode and an unscoped broker token dropped)', ok && fresh.keys.factory === 'fk-import' &&
    fresh.keys.repoMode === 'one' && fresh.keys.nativeBroker === '')
  const pok = await fresh.prefs.importFromTransfer({ jobs: '4', runOn: 'host', pairedHost: { label: 'x' }, spokenReplies: false, worker: 'factory' })
  check('imported prefs pass restore validation (wrong-typed values dropped)', pok && fresh.prefs.jobs === 1 && fresh.prefs.runOn === 'host' &&
    fresh.prefs.pairedHost === null && fresh.prefs.spokenReplies === false && fresh.prefs.worker === 'factory')
  check('an empty or non-object record is refused', !(await fresh.prefs.importFromTransfer([])) && !(await fresh.keys.importFromTransfer({})))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) { console.log('TRANSFER TESTS FAILED'); process.exitCode = 1 } else console.log('TRANSFER TESTS PASSED')
