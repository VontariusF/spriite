/**
 * Real-engine simulator walkthrough (dev tool). Walks every real-engine card
 * and every glasses action through the simulator's automation API against
 * the scripted fake API (?fake=1; see src/factory/fake.ts), so the full
 * live flow renders with zero keys, zero network, and zero credits.
 *
 * Variants (match the simulator's launch URL; see the sim:* npm scripts):
 * - offline (port 9899): the computer daemon is down (HTTP 503) at the first
 *   start; Retry resumes, then the full mission runs: milestones, build
 *   gate, pause/resume, review, Talk, PR gate, evidence, restart, home
 *   rows (resume, cloud watch, New build, goal list).
 * - blocked (port 9900): no repository and no GitHub token: the repo prompt
 *   (Pick on phone / New repo / Talk), the token prompt, back navigation.
 * - newrepo (port 9901): a goal that starts in a brand-new repository.
 *
 * Usage: npm run dev; npm run sim:offline (background);
 *        node scripts/walkthrough-real.mjs 9899 offline
 *
 * Waits are anchored to a mark taken before each input: a wait only matches
 * scenes emitted after that input, so repeated card kinds never miscount.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = process.argv[2] ?? '9899'
const VARIANT = process.argv[3] ?? 'offline'
const BASE = `http://127.0.0.1:${PORT}`
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = resolve(HERE, '../shots')
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let lastId = 0
const allEntries = []
const sceneLog = [] // { kind, accepted, pending, total, items, raw }
const failures = []
let micFailed = false
let mark = 0 // sceneLog index before the latest input
let logMark = 0 // allEntries index before the latest input

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
  const entries = data?.entries ?? []
  for (const e of entries) {
    if (e.id <= lastId && lastId > 0) continue
    lastId = Math.max(lastId, e.id)
    allEntries.push(e)
    const m = e.message
    if (m.startsWith('[scene]')) {
      sceneLog.push({
        kind: m.match(/kind=(\w+)/)?.[1],
        accepted: m.match(/accepted=(\d+)/)?.[1],
        pending: m.match(/pending=(\d+)/)?.[1],
        total: m.match(/total=(\d+)/)?.[1],
        items: Number(m.match(/items=(\d+)/)?.[1] ?? 0),
        purpose: m.match(/purpose=(\w+)/)?.[1],
        raw: m,
      })
    }
    if (m.includes('microphone start failed')) micFailed = true
  }
}

/** A log line containing `fragment`, anywhere since `from` (default: ever). */
async function waitLog(fragment, { from = 0, timeoutMs = 30000 } = {}) {
  return poll(async () => {
    await pull()
    return allEntries.slice(from).find((e) => e.message.includes(fragment)) ?? null
  }, { timeoutMs })
}

/**
 * The next scene of `kind` emitted after the latest input. `orCurrent`
 * also accepts the card already showing (persistent cards like a gate).
 */
async function waitScene(kind, { accepted, pending, total, purpose, orCurrent = false, timeoutMs = 30000 } = {}) {
  const ok = (s) =>
    s.kind === kind &&
    (purpose === undefined || s.purpose === purpose) &&
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

/** Move list/action focus down n times, then one input mark covers the select. */
async function downTimes(n) {
  for (let i = 0; i < n; i++) await input('down')
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

/** The focused action is Talk: activate it and finish the turn either way. */
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
    await shotGlasses(`r-${VARIANT}-mic-error`)
    await input('down') // focus Cancel
    await input('click') // back to the engine card
    return
  }
  await sleep(2000)
  await input('click') // tap to finish
  expect((await waitLog('capture ended', { from: logMark, timeoutMs: 10000 })) !== null, `${label}: tap-to-talk capture ended by tap`)
}

/** The latest home list's row count (New build is the last row). */
function homeItems() {
  for (let i = sceneLog.length - 1; i >= 0; i--) {
    if (sceneLog[i].kind === 'selection' && sceneLog[i].purpose === 'projects') return sceneLog[i].items
  }
  return 0
}

async function main() {
  console.log(`== Spriite real-engine walkthrough (${VARIANT}, port ${PORT}) ==`)
  if ((await poll(() => ping(), { timeoutMs: 60000 })) !== 'pong') {
    throw new Error('simulator automation API not reachable on ' + BASE)
  }
  if (!(await waitLog('fake mode', { timeoutMs: 45000 }))) {
    throw new Error('fake mode never logged; launch the simulator with ?fake=1')
  }
  expect((await waitLog('APP_READY', { timeoutMs: 45000 })) !== null, 'app ready')
  mark = 0
  expect((await waitScene('transcript', { timeoutMs: 15000 })) !== null, 'boot: transcript card carries the seeded goal')
  await sleep(800)
  await shotGlasses(`r-${VARIANT}-01-transcript`)
  await shotPhone(`r-${VARIANT}-p01-phone`)

  if (VARIANT === 'blocked') return blockedVariant()
  if (VARIANT === 'newrepo') return newRepoVariant()
  return offlineVariant()
}

async function offlineVariant() {
  // Start planning -> the offline (503) fault card
  await input('click')
  expect((await waitScene('factory_error', { timeoutMs: 20000 })) !== null, 'offline: fault card after the failed session create')
  expect((await waitLog('fault (offline)', { timeoutMs: 5000 })) !== null, 'offline: the engine classified the 503 as an offline computer')
  await shotGlasses('r-offline-02-fault')
  await shotPhone('r-offline-p02-phone-fault')

  // Retry -> drafting, then the ready plan
  await input('click')
  expect((await waitScene('plan', { accepted: 0, timeoutMs: 20000 })) !== null, 'offline: Retry shows the drafting card')
  expect((await waitScene('plan', { accepted: 20, total: 100, timeoutMs: 30000 })) !== null, 'offline: plan ready, plan milestone verified (20%)')
  await sleep(500)
  await shotGlasses('r-offline-03-plan')

  // Milestones overlay, then back to the plan
  await input('down')
  await input('click')
  expect((await waitScene('selection', { purpose: 'plan_detail', timeoutMs: 8000 })) !== null, 'offline: Milestones opens the list')
  await shotGlasses('r-offline-04-plan-detail')
  await input('click')
  expect((await waitScene('plan', { timeoutMs: 8000 })) !== null, 'offline: selecting a row returns to the plan')

  // Build gate: Start build arms it; the gate's own button confirms
  await input('click')
  expect((await waitScene('decision', { timeoutMs: 8000 })) !== null, 'offline: build gate asks before spending credits')
  await shotGlasses('r-offline-05-build-gate')
  await shotPhone('r-offline-p03-phone-gate')
  await input('click')
  expect((await waitScene('running', { accepted: 20, timeoutMs: 15000 })) !== null, 'offline: the gate button starts the build')
  await shotGlasses('r-offline-06-building')

  // Pause / resume
  await input('down')
  await input('click')
  expect((await waitScene('paused', { timeoutMs: 8000 })) !== null, 'offline: Pause shows the paused card')
  await shotGlasses('r-offline-07-paused')
  await input('click')
  expect((await waitScene('running', { timeoutMs: 15000 })) !== null, 'offline: Resume returns to running')

  // Review, then the PR gate (persists until answered)
  expect((await waitScene('under_review', { accepted: 20, pending: 65, timeoutMs: 40000 })) !== null, 'offline: branch under review (20% + 65%)')
  await shotGlasses('r-offline-08-review')
  expect((await waitScene('decision', { orCurrent: true, timeoutMs: 40000 })) !== null, 'offline: PR gate after the review passes')
  await sleep(500)
  await shotGlasses('r-offline-09-pr-gate')

  // Talk on the gate card (mic paths), the gate stays
  await input('down')
  await walkTalk('offline PR gate')
  await input('double_click') // back never drops a pending question
  expect((await waitScene('decision', { timeoutMs: 8000 })) !== null, 'offline: back keeps the PR gate (never auto-answered)')

  // Open PR -> verified beat -> final
  await input('click')
  expect((await waitScene('accepted', { timeoutMs: 15000 })) !== null, 'offline: Open PR shows the verified beat')
  expect((await waitScene('final', { accepted: 100, pending: 0, timeoutMs: 60000 })) !== null, 'offline: final card, 100% verified')
  await sleep(500)
  await shotGlasses('r-offline-10-final')
  await shotPhone('r-offline-p04-phone-final')

  // Evidence, then Restart to the home
  await input('click')
  expect((await waitScene('selection', { purpose: 'evidence', timeoutMs: 8000 })) !== null, 'offline: Show evidence opens the list')
  await shotGlasses('r-offline-11-evidence')
  await input('click')
  expect((await waitScene('final', { timeoutMs: 8000 })) !== null, 'offline: closing evidence returns to final')
  await input('down')
  await input('click')
  expect((await waitScene('selection', { purpose: 'projects', timeoutMs: 10000 })) !== null, 'offline: Restart returns to the projects home')
  await sleep(1500) // the cloud rows refresh in
  await pull()
  await shotGlasses('r-offline-12-home')
  await shotPhone('r-offline-p05-phone-home')
  let n = homeItems()
  expect(n >= 3, `offline: home lists the mission, the cloud build, and New build (${n} rows)`)

  // Row 0: the finished mission resumes its snapshot
  await input('click')
  expect((await waitScene('final', { timeoutMs: 10000 })) !== null, 'offline: the mission row resumes the finished mission')
  await input('down')
  await input('click') // Restart -> home
  expect((await waitScene('selection', { purpose: 'projects', timeoutMs: 10000 })) !== null, 'offline: Restart from the resumed mission reaches the home')
  await sleep(1500)
  await pull()
  n = homeItems()

  // Cloud row (just above New build): watch, then back
  await downTimes(n - 2)
  await input('click')
  expect((await waitScene('running', { timeoutMs: 15000 })) !== null, 'offline: the cloud row opens a watch card')
  await sleep(3500) // the first poll primes the status
  await shotGlasses('r-offline-13-cloud-watch')
  await input('double_click')
  expect((await waitScene('selection', { purpose: 'projects', timeoutMs: 10000 })) !== null, 'offline: back leaves the watch for the home')
  await sleep(1500)
  await pull()
  n = homeItems()

  // New build (last row) -> goal list -> Talk -> back to the home
  await downTimes(n - 1)
  await input('click')
  expect((await waitScene('selection', { purpose: 'goal', timeoutMs: 10000 })) !== null, 'offline: New build opens the goal list')
  await shotGlasses('r-offline-14-goal-list')
  await walkTalk('offline goal list')
  await input('double_click')
  expect((await waitScene('selection', { purpose: 'projects', orCurrent: true, timeoutMs: 10000 })) !== null, 'offline: back from the goal list reaches the home')
}

async function blockedVariant() {
  // Start planning -> the repo prompt
  await input('click')
  expect((await waitScene('setup_notice', { timeoutMs: 15000 })) !== null, 'blocked: repo prompt from inside the flow')
  await shotGlasses('r-blocked-02-need-repo')

  // Pick on phone: the phone Setup tab opens the repository step
  await input('click')
  await sleep(1200)
  await shotPhone('r-blocked-p02-phone-repo-step')

  // New repo without a GitHub token -> the token prompt
  await input('down')
  await input('click')
  expect((await waitScene('setup_notice', { timeoutMs: 10000 })) !== null, 'blocked: New repo without a token asks for one')
  await shotGlasses('r-blocked-03-need-github')
  await input('click') // Connect -> the phone opens the GitHub step
  await sleep(1200)
  await shotPhone('r-blocked-p03-phone-github-step')

  // Talk on the prompt (mic paths), then back to the goal list and home
  await input('down')
  await walkTalk('blocked prompt')
  await input('double_click')
  expect((await waitScene('selection', { purpose: 'goal', timeoutMs: 10000 })) !== null, 'blocked: back from the prompt reaches the goal list')
  await shotGlasses('r-blocked-04-goal-list')
  await input('double_click')
  expect((await waitScene('selection', { purpose: 'projects', timeoutMs: 10000 })) !== null, 'blocked: back from the goal list reaches the home')
  await sleep(1500)
  await pull()
  const n = homeItems()
  await shotGlasses('r-blocked-05-home')
  await downTimes(n - 2)
  await input('click')
  expect((await waitScene('running', { timeoutMs: 15000 })) !== null, 'blocked: the cloud row opens a watch card')
  await input('double_click')
  expect((await waitScene('selection', { purpose: 'projects', timeoutMs: 10000 })) !== null, 'blocked: back leaves the watch')
}

async function newRepoVariant() {
  await input('click') // Start planning (no repository chosen)
  expect((await waitScene('setup_notice', { timeoutMs: 15000 })) !== null, 'newrepo: repo prompt offers New repo')
  await input('down')
  await input('click')
  expect((await waitScene('status_answer', { timeoutMs: 15000 })) !== null, 'newrepo: creating-repository card')
  await shotGlasses('r-newrepo-02-creating')
  expect((await waitScene('plan', { accepted: 20, total: 100, timeoutMs: 30000 })) !== null, 'newrepo: plan ready in the new repository')
  await sleep(500)
  await shotGlasses('r-newrepo-03-plan')
  await shotPhone('r-newrepo-p02-phone-plan')

  await input('click')
  expect((await waitScene('decision', { timeoutMs: 8000 })) !== null, 'newrepo: build gate')
  await input('click')
  expect((await waitScene('running', { accepted: 20, timeoutMs: 15000 })) !== null, 'newrepo: build starts')
  expect((await waitScene('final', { accepted: 100, pending: 0, timeoutMs: 60000 })) !== null, 'newrepo: final card, PR opened in the new repository')
  await sleep(500)
  await shotGlasses('r-newrepo-04-final')
  await shotPhone('r-newrepo-p03-phone-final')
  await input('down')
  await input('click')
  expect((await waitScene('selection', { purpose: 'projects', timeoutMs: 10000 })) !== null, 'newrepo: Restart returns to the projects home')
}

main()
  .catch((e) => {
    failures.push(`error: ${e?.message ?? e}`)
    console.error('WALKTHROUGH ERROR:', e?.message ?? e)
  })
  .then(() => {
    console.log('')
    if (failures.length === 0) {
      console.log(`REAL WALKTHROUGH PASSED (${VARIANT}): ${sceneLog.length} scene transitions, mic ${micFailed ? 'unavailable (failure paths walked)' : 'available'}`)
    } else {
      console.log(`REAL WALKTHROUGH FAILED (${VARIANT}): ${failures.length} failures`)
      for (const f of failures) console.log(' -', f)
      process.exitCode = 1
    }
  })
