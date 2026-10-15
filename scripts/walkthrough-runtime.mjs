/**
 * Durable-runtime simulator walkthrough (dev tool). Drives the app with
 * `persistent_runtime_v2` ON against the scripted fake API (?fake=1), so the
 * HUD's flow runs over the durable Supervisor: the spoken goal becomes a
 * saved command, the mission's own actor owns the card, and the home lists
 * runtime missions instead of a snapshot.
 *
 * What this walkthrough exists to prove (spec §10, §11, §17, §25.7, §26):
 *  - the flag boots the runtime and the runtime takes the mission;
 *  - the offline fault, Retry, plan, build gate, pause/resume, review, PR
 *    gate, evidence, and final cards all render off the mission actor;
 *  - backing out of a running mission reaches the home while the mission
 *    keeps working, and reopening the row shows a card that moved on;
 *  - Restart (cancel) leaves the record on the home.
 *
 * Two observables, deliberately:
 *  - `[scene]` lines come from an engine as it emits a NEW card;
 *  - `[runtime] view:` lines come from the adapter when view OWNERSHIP
 *    changes, and carry the card it forwards. A forwarded card emits no scene
 *    line (the engine logged it earlier), so every "what is on the HUD now"
 *    assertion reads the trace, and every "the mission emitted a card"
 *    assertion reads the scene log.
 *
 * Usage: npm run dev; npm run sim:runtime (background, port 9903);
 *        node scripts/walkthrough-runtime.mjs [port]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = process.argv[2] ?? '9903'
const BASE = `http://127.0.0.1:${PORT}`
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = process.env.SPRIITE_SHOTS_DIR
  ? resolve(process.env.SPRIITE_SHOTS_DIR)
  : resolve(HERE, '../shots')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let lastId = 0
const allEntries = []
const sceneLog = []
const failures = []
let micFailed = false
let mark = 0
let logMark = 0

/** A reload with ?fresh=1 destroys the mission under test. Do not turn that
 * into ten misleading gate/final timeouts or accept scenes from two boots. */
export function runtimeBootGuard() {
  let firstBoot = null
  return (entry) => {
    if (!entry.message.startsWith('[runtime] boot epoch=')) return
    if (firstBoot !== null) {
      throw new Error(`App rebooted during the walkthrough (runtime boot logs ${firstBoot} and ${entry.id}). A fresh boot resets fake sessions/missions. Rerun on a fresh isolated simulator with source edits/HMR stopped.`)
    }
    firstBoot = entry.id
  }
}

const observeBoot = runtimeBootGuard()

async function ping() {
  try {
    const res = await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(3000) })
    return (await res.text()).trim()
  } catch {
    return null
  }
}

async function poll(action, { timeoutMs = 30000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const out = await action()
    if (out !== undefined && out !== null && out !== false) return out
    await sleep(intervalMs)
  }
  return null
}

async function pull() {
  const url = lastId > 0 ? `${BASE}/api/console?since_id=${lastId}` : `${BASE}/api/console`
  const data = await fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => null)
  for (const e of data?.entries ?? []) {
    if (lastId > 0 && e.id <= lastId) continue
    lastId = Math.max(lastId, e.id)
    allEntries.push(e)
    observeBoot(e)
    const m = e.message
    if (m.startsWith('[scene]')) {
      sceneLog.push({
        kind: m.match(/kind=(\w+)/)?.[1],
        seq: Number(m.match(/seq=(\d+)/)?.[1] ?? -1),
        accepted: m.match(/accepted=(\d+)/)?.[1],
        pending: m.match(/pending=(\d+)/)?.[1],
        total: m.match(/total=(\d+)/)?.[1],
        items: Number(m.match(/items=(\d+)/)?.[1] ?? 0),
        purpose: m.match(/purpose=(\w+)/)?.[1],
        actions: (m.match(/actions=([\w,]+)/)?.[1] ?? '').split(',').filter(Boolean),
        raw: m,
      })
    }
    if (m.includes('microphone start failed')) micFailed = true
  }
}

/** A log line containing `fragment`, emitted after `from` (an allEntries index). */
async function waitLog(fragment, { from = 0, timeoutMs = 30000 } = {}) {
  return poll(async () => {
    await pull()
    return allEntries.slice(from).find((e) => e.message.includes(fragment)) ?? null
  }, { timeoutMs })
}

/** The next `[runtime] view:` line after `from` (view ownership changed). */
async function waitView(fragment, { from = logMark, timeoutMs = 20000 } = {}) {
  return poll(async () => {
    await pull()
    return allEntries.slice(from).find((e) => e.message.startsWith('[runtime] view:') && e.message.includes(fragment)) ?? null
  }, { timeoutMs })
}

/**
 * The next scene of `kind` emitted after the latest input. `orCurrent` also
 * accepts the card already showing.
 */
async function waitScene(kind, { accepted, pending, total, purpose, action, orCurrent = false, timeoutMs = 30000 } = {}) {
  const ok = (s) =>
    s.kind === kind &&
    (purpose === undefined || s.purpose === purpose) &&
    (action === undefined || (s.actions ?? []).includes(action)) &&
    (accepted === undefined || s.accepted === String(accepted)) &&
    (pending === undefined || s.pending === String(pending)) &&
    (total === undefined || s.total === String(total))
  const from = orCurrent ? Math.max(0, mark - 1) : mark
  return poll(async () => {
    await pull()
    return sceneLog.slice(from).find(ok) ?? null
  }, { timeoutMs })
}

async function input(action) {
  await pull()
  mark = sceneLog.length
  logMark = allEntries.length
  const res = await fetch(`${BASE}/api/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  const body = await res.json().catch(() => ({}))
  if (!body.ok) throw new Error(`input "${action}" rejected: ${JSON.stringify(body)}`)
  await sleep(500)
}

async function shotGlasses(name) {
  const res = await fetch(`${BASE}/api/screenshot/glasses`)
  if (!res.ok) throw new Error(`glasses screenshot ${name} failed: ${res.status}`)
  writeFileSync(resolve(SHOTS, `${name}.png`), Buffer.from(await res.arrayBuffer()))
  console.log(`  shot: shots/${name}.png`)
}

async function shotPhone(name) {
  const res = await fetch(`${BASE}/api/screenshot/webview`).catch(() => null)
  if (!res || !res.ok) {
    console.log(`  (webview screenshot ${name} unavailable)`)
    return
  }
  writeFileSync(resolve(SHOTS, `${name}.png`), Buffer.from(await res.arrayBuffer()))
  console.log(`  shot: shots/${name}.png`)
}

function expect(cond, msg) {
  if (cond) console.log(`  PASS: ${msg}`)
  else {
    failures.push(msg)
    console.log(`  FAIL: ${msg}`)
  }
}

/** The card summary the adapter logged on a `[runtime] view:` line. */
function cardOf(line) {
  const msg = line?.message ?? ''
  const m = /card=(\w+)(?: rev=(\d+))?(?: accepted=(-?\d+))?/.exec(msg)
  return {
    kind: m?.[1] ?? '',
    rev: Number(m?.[2] ?? -1),
    accepted: Number(m?.[3] ?? -1),
    items: Number(/items=(\d+)/.exec(msg)?.[1] ?? -1),
  }
}

/** The latest card the mission actor emitted (its scene log). */
function lastScene(kind) {
  for (let i = sceneLog.length - 1; i >= 0; i--) {
    if (sceneLog[i].kind === kind) return sceneLog[i]
  }
  return null
}

/**
 * The focused action is Talk: activate it and finish the turn either way
 * (mic available or refused), the way the legacy walkthrough does.
 */
async function walkTalk(label) {
  await input('click')
  const from = logMark
  const started = await poll(async () => {
    await pull()
    const hit = allEntries.slice(from).find((e) =>
      e.message.includes('capture started') || e.message.includes('microphone start failed'))
    return hit ? { ok: hit.message.includes('capture started') } : null
  }, { timeoutMs: 20000 })
  if (started === null) {
    expect(false, `${label}: Talk started a capture or reported the mic failure`)
    return
  }
  if (!started.ok) {
    expect((await waitScene('mic_error', { timeoutMs: 8000 })) !== null, `${label}: mic failure card (no Listening without a started mic)`)
    await input('down')
    await input('click')
    return
  }
  await sleep(2000)
  await input('click') // tap to finish
  expect((await waitLog('capture ended', { from: logMark, timeoutMs: 10000 })) !== null, `${label}: tap-to-talk capture ended by tap`)
  await input('click') // back out of the readback the capture leaves
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  console.log(`== Spriite durable-runtime walkthrough (port ${PORT}) ==`)
  if ((await poll(() => ping(), { timeoutMs: 60000 })) !== 'pong') {
    throw new Error(`simulator automation API not reachable on ${BASE}`)
  }
  if (!(await waitLog('fake mode', { timeoutMs: 45000 }))) {
    throw new Error(
      'fake mode never logged: restart the simulator (npm run sim:runtime) so the page boots fresh with ?fake=1',
    )
  }
  expect(
    (await waitLog('flags] persistent_runtime_v2=on', { timeoutMs: 45000 })) !== null,
    'boot: the persistent runtime flag is on',
  )
  const boot = await waitLog('[runtime] boot', { timeoutMs: 45000 })
  expect(boot !== null, 'boot: the durable runtime reports its boot')
  expect(boot !== null && !/durability=broken/.test(boot.message), 'boot: the store reported healthy durability')
  expect((await waitLog('APP_READY', { timeoutMs: 45000 })) !== null, 'app ready')
  mark = 0
  logMark = 0
  expect((await waitScene('transcript', { timeoutMs: 15000 })) !== null, 'boot: transcript card carries the seeded goal')
  await sleep(800)
  await shotGlasses('rt-01-transcript')
  await shotPhone('rt-p01-phone')

  // Start planning -> the durable command -> the offline (503) fault card
  await input('click')
  expect((await waitLog('[runtime] command saved mission=', { from: logMark, timeoutMs: 15000 })) !== null, 'command: the goal was saved before anything started')
  expect((await waitView('view: mission', { timeoutMs: 15000 })) !== null, 'command: the new mission takes the screen')
  expect((await waitScene('factory_error', { timeoutMs: 20000 })) !== null, 'fault: card after the failed session create')
  expect((await waitLog('fault (offline)', { from: logMark, timeoutMs: 5000 })) !== null, 'fault: classified as an offline computer')
  await shotGlasses('rt-02-fault')
  await shotPhone('rt-p02-phone-fault')

  // Retry -> drafting, then the ready plan (the mission actor owns the card).
  // A plan is a proposal, never verified work (0% until a milestone passes);
  // the ready card is the one that offers Start build.
  await input('click')
  expect((await waitScene('plan', { accepted: 0, timeoutMs: 20000 })) !== null, 'plan: Retry shows the drafting card')
  expect((await waitScene('plan', { accepted: 0, total: 100, action: 'begin', timeoutMs: 30000 })) !== null, 'plan: plan ready, nothing verified yet')
  await sleep(500)
  await shotGlasses('rt-03-plan')

  // Milestones overlay (HudRun plan card: Start build, Send message, Milestones), then the build gate
  await input('up')
  await input('click')
  expect((await waitScene('selection', { purpose: 'plan_detail', timeoutMs: 8000 })) !== null, 'plan: Milestones opens the list')
  await input('click')
  expect((await waitScene('plan', { action: 'begin', timeoutMs: 8000 })) !== null, 'plan: selecting a row returns to the plan')
  await input('click')
  expect((await waitScene('decision', { timeoutMs: 8000 })) !== null, 'gate: build asks before spending credits')
  await shotGlasses('rt-04-gate')
  await input('click')
  expect((await waitScene('running', { accepted: 0, timeoutMs: 15000 })) !== null, 'build: the gate button starts the build')
  await shotGlasses('rt-05-building')

  // Pause / resume through the Supervisor (HudRun: Pause is the first action)
  await input('click')
  expect((await waitScene('paused', { timeoutMs: 8000 })) !== null, 'control: Pause shows the paused card')
  await input('click')
  expect((await waitScene('running', { timeoutMs: 15000 })) !== null, 'control: Resume returns to running')
  const leftRev = lastScene('running')?.seq ?? -1

  // Back out while it builds: the mission keeps working off screen. The home
  // card is forwarded from the lobby (no scene line of its own), so the trace
  // is what says the HUD is on the home and what that card carries.
  await input('double_click')
  const home = await waitView('view: home card=list=projects', { timeoutMs: 10000 })
  expect(home !== null, 'focus: back from a running mission reaches the home')
  const homeCard = cardOf(home)
  expect(
    homeCard.items >= 2,
    `home: the home card on the HUD carries the mission row and New build (${homeCard.items} rows)`,
  )
  await sleep(1000)
  await shotGlasses('rt-06-home-running')

  // The mission keeps working while the home is on screen: reopening the row
  // shows a card that moved on. The glasses' home is the idle card (HudIdle);
  // its Builds action opens the rows.
  await sleep(6000)
  await openBuilds()
  await input('click')
  const reopen = await waitView('view: mission', { timeoutMs: 10000 })
  expect(reopen !== null, 'home: opening the runtime mission row shows its own card')
  const reopened = cardOf(reopen)
  expect(
    reopened.rev > leftRev || reopened.kind !== 'running',
    `off screen: the unfocused mission kept working (reopened at ${reopened.kind} rev=${reopened.rev}, left at rev=${leftRev})`,
  )
  await sleep(500)
  await shotGlasses('rt-07-reopened')

  // Review, then the PR gate (both may have been emitted while off screen;
  // the waits are anchored to their own weights so an older card of the same
  // kind — the build gate, at 0% — can never satisfy them). One job of 65 and
  // the PR of 15 share the bar: the job is 81% of it.
  expect((await waitScene('under_review', { pending: 81, timeoutMs: 40000 })) !== null, 'review: branch under review')
  expect((await waitScene('decision', { accepted: 81, timeoutMs: 40000 })) !== null, 'gate: PR gate after the review passes')
  await sleep(500)
  await shotGlasses('rt-08-pr-gate')

  // Back never drops a pending question: leaving the mission re-raises its
  // unanswered ask, which brings the asking mission straight back, so the
  // last view the adapter settles on still carries the gate.
  await input('double_click')
  await sleep(1500)
  await pull()
  const views = allEntries.slice(logMark).filter((e) => e.message.startsWith('[runtime] view:'))
  expect(views.length === 0 || cardOf(views.at(-1)).kind === 'decision', 'gate: back does not leave a pending question behind')
  await shotGlasses('rt-08a-after-back')

  // Open PR -> final -> evidence -> Restart -> home with the record kept
  await input('click')
  expect((await waitScene('accepted', { accepted: 81, timeoutMs: 15000 })) !== null, 'final: Open PR shows the verified beat')
  expect((await waitScene('final', { accepted: 100, pending: 0, timeoutMs: 60000 })) !== null, 'final: final card, 100% verified')
  await sleep(500)
  await shotGlasses('rt-09-final')
  // HudDone: Read summary, Next idea, Evidence (one swipe back from the first).
  await input('up')
  await input('click')
  expect((await waitScene('selection', { purpose: 'evidence', timeoutMs: 8000 })) !== null, 'evidence: Evidence opens the list')
  await input('click')
  expect((await waitScene('final', { timeoutMs: 8000 })) !== null, 'evidence: closing it returns to final')
  await input('down')
  await input('click')
  const cancelled = await waitView('view: home', { timeoutMs: 10000 })
  expect(cancelled !== null, 'cancel: Next idea returns to the home')
  expect(
    cardOf(cancelled).items >= 1,
    `home: the cancelled mission keeps its record (${cardOf(cancelled).items} rows)`,
  )
  await sleep(2000)
  await pull()
  await shotGlasses('rt-10-home')
  await shotPhone('rt-p03-phone-home')

  // The record row: the mission actor is still here in this launch
  await openBuilds()
  await input('click')
  const record = await waitView('view: mission', { timeoutMs: 10000 })
  expect(record !== null && cardOf(record).kind === 'final', 'home: opening the runtime mission row shows its final card')
  await input('double_click')
  expect((await waitView('view: home', { timeoutMs: 10000 })) !== null, 'home: back leaves the record for the home')

  // The lobby's own paths stay intact under the runtime: New build (the last
  // home row) opens the goal list, and Talk there drives the mic path.
  const homeRows = await poll(async () => {
    await pull()
    return allEntries.slice(logMark).find((e) => e.message.startsWith('[runtime] view: home')) ?? null
  }, { timeoutMs: 5000 })
  const rows = cardOf(homeRows).items
  if (rows < 2) {
    expect(false, `lobby: the home carries a New build row to open (${rows} rows)`)
  } else {
    await openBuilds()
    for (let i = 0; i < rows - 1; i++) await input('down')
    await input('click')
    expect((await waitScene('selection', { purpose: 'goal', timeoutMs: 10000 })) !== null, 'lobby: New build opens the goal list')
    await walkTalk('runtime goal list')
    await input('double_click')
    expect(
      (await waitScene('selection', { purpose: 'projects', timeoutMs: 10000 })) !== null,
      'lobby: back from the goal list reaches the home',
    )
  }
}

/** HudIdle: the glasses' home is the idle card; its Builds action (one swipe) opens the rows. */
async function openBuilds() {
  await input('down')
  await input('click')
  await sleep(600)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
  .catch((e) => {
    failures.push(`error: ${e?.message ?? e}`)
    console.error('WALKTHROUGH ERROR:', e?.message ?? e)
  })
  .then(() => {
    console.log('')
    if (failures.length === 0) {
      console.log(
        `RUNTIME WALKTHROUGH PASSED: ${sceneLog.length} scene transitions, mic ${micFailed ? 'unavailable (failure paths walked)' : 'available'}`,
      )
    } else {
      console.log(`RUNTIME WALKTHROUGH FAILED: ${failures.length} failures`)
      for (const f of failures) console.log(' -', f)
      process.exitCode = 1
    }
    process.exit(failures.length === 0 ? 0 : 1)
  })
