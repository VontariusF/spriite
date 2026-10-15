/**
 * Phone companion regressions:
 * - A mirror action whose engine took the tap (a queued start, a send still
 *   unconfirmed) is never turned off as "nothing to do" while the card waits
 *   for its answer, and a verdict the engine later contradicts on an
 *   identical card is revoked (the control turns back on).
 * - Setup never says Factory is "Connected" or "Ready to build" when the key
 *   works but the account has no active Droid Computer to run builds on.
 *
 * Usage: node --import ./scripts/ts-resolve.mjs scripts/test-phone-fixes.mjs
 */
import { mountPhoneApp } from '../src/phone/app.ts'
import { mountSetupPanel } from '../src/setup/panel.ts'
import { PrefsVault } from '../src/state/prefs.ts'
import { FeedVault } from '../src/state/feed.ts'
import { KeyVault } from '../src/voice/keys.ts'
import { makeTally } from './lib/runtime-fake.mjs'
import { phoneDom, makeElement, textOf, phoneFakes } from './lib/phone-dom.mjs'

const { assert, failures } = makeTally()
const section = (name) => console.log(`\n-- ${name}`)
console.log('== Phone companion fixes ==')

function gateway(store = new Map()) {
  return {
    store,
    call: (fn) =>
      fn({
        getLocalStorage: async (k) => store.get(k) ?? '',
        setLocalStorage: async (k, v) => {
          store.set(k, v)
          return true
        },
      }),
  }
}

const findAll = (node, pred, out = []) => {
  if (node === null || node === undefined || typeof node === 'string') return out
  if (pred(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, pred, out)
  return out
}
const byId = (root, id) => findAll(root, (n) => n.id === id)[0] ?? null

/** Capture the 2.5s mirror verdict timers so the test fires them by hand. */
function withDeferredVerdicts(run) {
  const original = globalThis.setTimeout
  const deferred = []
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 2500) {
      deferred.push(() => callback(...args))
      return 0
    }
    return original(callback, delay, ...args)
  }
  try { run() } finally { globalThis.setTimeout = original }
  return deferred
}

async function mountMirror(engine, onAction) {
  phoneDom()
  const gw = gateway()
  const keys = new KeyVault(gw)
  const prefs = new PrefsVault(gw)
  const feed = new FeedVault(gw)
  await keys.load()
  await prefs.load()
  await feed.load()
  const root = makeElement('div')
  const handle = mountPhoneApp(root, { ...phoneFakes(),
    keys, prefs, feed,
    engine: () => engine,
    runAction: onAction,
    onSaved: () => {},
  })
  const button = (label) => findAll(root, (n) => n.tagName === 'BUTTON' && textOf(n) === label)[0]
  const status = (text) => findAll(root, (n) => n.role === 'status' && textOf(n).includes(text))[0]
  return { root, handle, button, status }
}

const stubEngine = (state) => ({
  hasPendingDecision: false,
  hasUnconfirmedDelivery: false,
  currentView: null,
  acceptsGoal: () => false,
  canStartNewRepo: () => false,
  watchOnly: () => false,
  say: () => 'none',
  snapshot: () => ({ blockedStart: null, ...state }),
  listBuilds: () => [],
  canOpenBuilds: () => true,
  pendingAsks: () => [],
  chatLog: () => [],
  showMission: () => false,
})

const sceneView = (actions) => ({
  type: 'scene',
  scene: {
    schemaVersion: 1, sceneId: 'phone-fix', sceneRevision: 1, missionId: null, stateSequence: 1,
    kind: 'running', spritePose: 'waiting', contextLabel: 'SPRIITE', utterance: 'Build is running',
    status: '', progress: null, actions,
    evidenceIds: [], generatedAt: '', transientMs: 0,
  },
})

section('a tap the engine queued is not called dead while its card waits')
{
  const state = { queuedStart: null }
  const engine = stubEngine(state)
  // Open PR while busy: the engine queues the start and emits nothing yet.
  const m = await mountMirror(engine, (a) => { if (a.id === 'open_pr') state.queuedStart = 'pr' })
  m.handle.notify(sceneView([{ id: 'open_pr', label: 'Open PR', kind: 'command' }]))
  const deferred = withDeferredVerdicts(() => m.button('Open PR').click())
  assert(deferred.length === 1, 'the tap starts its bounded verdict timer')
  deferred[0]()
  assert(m.button('Open PR').disabled !== true, 'a queued Open PR stays live: the engine took the tap')
  assert(m.status('has nothing to do') === undefined, 'no "nothing to do" note for a tap the engine took')
}

section('a send still unconfirmed is never called dead')
{
  const engine = stubEngine({})
  const m = await mountMirror(engine, () => { engine.hasUnconfirmedDelivery = true })
  m.handle.notify(sceneView([{ id: 'retry', label: 'Retry', kind: 'command' }]))
  const deferred = withDeferredVerdicts(() => m.button('Retry').click())
  deferred[0]()
  assert(m.button('Retry').disabled !== true, 'a tap whose delivery is unconfirmed stays live')
  assert(m.status('has nothing to do') === undefined, 'no false "nothing to do" note while the send is in flight')
}

section('a slow answer on an identical card revokes the verdict')
{
  const state = { baseSha: null }
  const engine = stubEngine(state)
  const view = sceneView([{ id: 'retry', label: 'Refresh plan', kind: 'command' }])
  const m = await mountMirror(engine, () => {})
  m.handle.notify(view)
  const deferred = withDeferredVerdicts(() => m.button('Refresh plan').click())
  deferred[0]()
  assert(m.button('Refresh plan').disabled === true, 'a tap that moved nothing is still turned off (the owner report)')
  assert(m.status('has nothing to do') !== undefined, 'and the note says why')
  // The network step finishes late and re-emits the same card.
  state.baseSha = 'a'.repeat(40)
  m.handle.notify(view)
  assert(m.button('Refresh plan').disabled !== true, 'the late answer turns the control back on')
  assert(m.status('has nothing to do') === undefined, 'and takes back the "nothing to do" note')
  // A truly dead action on an unmoving engine stays off across re-renders.
  const again = withDeferredVerdicts(() => m.button('Refresh plan').click())
  again[0]()
  m.handle.notify(view)
  assert(m.button('Refresh plan').disabled === true, 'an unchanged engine keeps the dead control off on re-render')
}

section('setup is not ready when no Droid Computer is active')
{
  const realFetch = globalThis.fetch
  let computers = [{ id: 'c1', name: 'Workstation', status: 'inactive' }]
  globalThis.fetch = async () => new Response(JSON.stringify({ computers }), { status: 200 })
  try {
    phoneDom()
    const gw = gateway()
    const keys = new KeyVault(gw)
    const prefs = new PrefsVault(gw)
    await keys.load()
    await prefs.load()
    assert(await keys.setRepoUrl('https://github.com/acme/app'), 'the repository is chosen')
    const readiness = []
    const root = makeElement('div')
    const setup = mountSetupPanel(root, keys, prefs, { onReadiness: (n) => readiness.push(n) })
    const factory = byId(root, 'sec-factory')
    const pillText = () => textOf(findAll(factory, (n) => typeof n.className === 'string' && n.className.split(' ').includes('pill'))[0])
    const input = findAll(factory, (n) => n.tagName === 'INPUT')[0]
    const save = findAll(factory, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Save and test')[0]
    input.value = 'fk-test-key'
    await save.onclick()
    assert(keys.factory === 'fk-test-key', 'the key is saved')
    assert(pillText() !== 'Connected', 'the Factory pill does not say Connected with only an inactive computer')
    assert(pillText() === 'Check computer', 'the Factory pill names the computer as the thing to check')
    assert(setup.missingRequired() === 1, 'setup counts the missing runnable computer as a step left')
    assert(!textOf(root).includes('Ready to build'), 'the top card does not say Ready to build')
    assert(readiness.at(-1) === 1, 'the Now badge hears one step left')

    computers = []
    await save.onclick()
    assert(pillText() === 'Check computer' && setup.missingRequired() === 1, 'an account with no computer at all is not ready either')

    computers = [{ id: 'c2', name: 'Cloud', status: 'active' }]
    await save.onclick()
    assert(pillText() === 'Connected', 'a later test that finds an active computer reads Connected')
    assert(setup.missingRequired() === 0 && textOf(root).includes('Ready to build'), 'and setup is ready to build')
    assert(readiness.at(-1) === 0, 'the Now badge clears')
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log(failures() === 0 ? '\nAll phone fix tests passed.' : `\n${failures()} phone fix test(s) FAILED.`)
process.exit(failures() === 0 ? 0 : 1)
