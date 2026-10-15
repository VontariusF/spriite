/**
 * App-wiring regression tests: the bridge gateway's never-hang contract and
 * the device-status handler's pre-boot window.
 *
 * - BridgeGateway.call() resolves null on EVERY failure path, including an op
 *   that throws synchronously (the raw getter before init), and one bad task
 *   never stalls the queue behind it.
 * - A device-status event that lands during init()'s awaits (before `engine`
 *   is assigned) never dereferences the engine; boot() presents instead, and
 *   once booted the reconnect re-presents the engine card as before.
 *
 * Usage: node --import ./scripts/ts-resolve.mjs scripts/test-wiring-fixes.mjs
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { BridgeGateway } from '../src/bridge/bridge.ts'

let passed = 0
let failed = 0
async function test(label, run) {
  try { await run(); passed++; console.log(`PASS: ${label}`) }
  catch (e) { failed++; console.log(`FAIL: ${label}\n  ${e?.stack ?? e}`) }
}
function check(ok, msg) { if (!ok) throw new Error(msg) }

const unhandled = []
process.on('unhandledRejection', (e) => unhandled.push(e))
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const HANG = Symbol('hang')
const within = (p, ms = 200) => Promise.race([p, new Promise((r) => setTimeout(() => r(HANG), ms))])
const quiet = (fn) => async () => {
  const warn = console.warn
  console.warn = () => {}
  try { await fn() } finally { console.warn = warn }
}

// ------------------------------------------------------------ bridge gateway

await test('call() before init resolves null instead of hanging', quiet(async () => {
  unhandled.length = 0
  const gw = new BridgeGateway()
  const out = await within(gw.call(async () => 'never', 'pre-init', 50))
  check(out !== HANG, 'call() never settled')
  check(out === null, `expected null, got ${String(out)}`)
  await settle()
  check(unhandled.length === 0, `unhandled rejection: ${unhandled[0]}`)
}))

await test('a synchronously throwing op resolves null and the queue keeps draining', quiet(async () => {
  unhandled.length = 0
  const gw = new BridgeGateway()
  gw.bridge = {} // a ready bridge; the ops below never touch it
  const bad = gw.call(() => { throw new Error('sync boom') }, 'sync', 50)
  const good = gw.call(async () => 'ok', 'after', 50)
  const [a, b] = await within(Promise.all([bad, good]))
  check(a === null, `throwing op should resolve null, got ${String(a)}`)
  check(b === 'ok', `later op should still run, got ${String(b)}`)
  await settle()
  check(unhandled.length === 0, `unhandled rejection: ${unhandled[0]}`)
}))

await test('async rejection and timeout still resolve null', quiet(async () => {
  const gw = new BridgeGateway()
  gw.bridge = {}
  check(await gw.call(async () => { throw new Error('x') }, 'rej', 50) === null, 'rejection')
  check(await gw.call(() => new Promise(() => {}), 'hung', 20) === null, 'timeout')
}))

await test('a call that outlives its timeout holds the link: never two transfers in flight', quiet(async () => {
  const gw = new BridgeGateway()
  gw.bridge = {}
  let inflight = 0
  let maxInflight = 0
  const slow = (ms) => () => new Promise((r) => { inflight++; maxInflight = Math.max(maxInflight, inflight); setTimeout(() => { inflight--; r('success') }, ms) })
  const first = gw.call(slow(60), 'image:slow', 20, 'lo')
  const second = gw.call(slow(5), 'image:next', 200, 'lo')
  check(await first === null, 'the caller still gets its null at the timeout')
  check(await second === 'success', 'the next call runs once the slow one settled')
  check(maxInflight === 1, `at most one call in flight (saw ${maxInflight})`)
}))

// ------------------------------------------------------- device-status window

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
function productionFunction(start, end, context) {
  const source = main.slice(main.indexOf(start), main.indexOf(end, main.indexOf(start)))
  const sandbox = vm.createContext(context)
  vm.runInContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, sandbox)
  return sandbox
}
function deviceSandbox(overrides = {}) {
  const presented = []
  const sb = productionFunction('function onDeviceStatus(', 'async function onForeground(', {
    console,
    cleanedUp: false,
    glassesConnected: null,
    historyOpen: false,
    scribe: null,
    liveVoice: false,
    displayed: null,
    phone: null,
    store: { uiMode: 'scene' },
    talk: { isActive: false },
    renderer: { setSurfaceAttached() {}, invalidatePage() {} },
    presentEngineView: async (v) => { presented.push(['engine', v]); return true },
    presentLocalScene: async (s) => { presented.push(['local', s]); return true },
    connectionLostScene: () => 'lost',
    engine: undefined,
    engineBooted: false,
    ...overrides,
  })
  return { sb, presented }
}
const status = (connected) => ({ isConnected: () => connected })

await test('a connect event before the engine exists does not throw or present', async () => {
  unhandled.length = 0
  const { sb, presented } = deviceSandbox()
  sb.onDeviceStatus(status(true))
  await settle()
  check(unhandled.length === 0, `unhandled rejection: ${unhandled[0]}`)
  check(sb.glassesConnected === true, 'connection state must still be recorded for boot')
  check(presented.length === 0, 'nothing may present before boot')
  await sb.onGlassesReconnected() // direct await must not reject either
})

await test('a flap before boot ends on a connected link without touching the engine', async () => {
  unhandled.length = 0
  const { sb } = deviceSandbox({ glassesConnected: true })
  const lost = sb.onGlassesLost()
  sb.glassesConnected = true // reconnected while the teardown was in flight
  await lost
  await settle()
  check(unhandled.length === 0, `unhandled rejection: ${unhandled[0]}`)
})

await test('after boot a reconnect re-presents the engine card', async () => {
  const view = { type: 'scene', scene: 'home' }
  const { sb, presented } = deviceSandbox({ engine: { currentView: view }, engineBooted: true, glassesConnected: false })
  sb.onDeviceStatus(status(true))
  await settle()
  check(presented.length === 1 && presented[0][1] === view, `expected engine present, got ${JSON.stringify(presented)}`)
})

await test('init() marks the engine booted right after engine.boot()', () => {
  check(/\n  engine\.boot\(\)[^\n]*\n  engineBooted = true\n/.test(main), 'engineBooted must be set after the boot in init()')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
