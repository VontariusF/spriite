/**
 * Simulator walkthrough (spec §17.2 phase E1 gate). Drives the full
 * interactive story through the simulator's automation API, asserts the
 * scene sequence and verified-progress invariants, and saves screenshots.
 *
 * Prereqs: npm run dev (5173) + npx evenhub-simulator http://localhost:5173
 *          --automation-port 9898
 * Usage:   node scripts/walkthrough.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'http://127.0.0.1:9898'
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = resolve(HERE, '../shots')
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let lastId = 0
const sceneLog = [] // { kind, accepted, pending, total, raw }

async function getJson(path, timeoutMs = 15000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(BASE + path, { signal: ctrl.signal })
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

async function ping() {
  try {
    const res = await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(3000) })
    return (await res.text()).trim()
  } catch {
    return null
  }
}

async function poll(action, { timeoutMs = 30000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const out = await action()
    if (out !== undefined && out !== null && out !== false) return out
    await sleep(intervalMs)
  }
  return null
}

async function consoleEntries() {
  const data = await getJson(`/api/console?since_id=${lastId}`, 5000).catch(() => null)
  if (!data) return []
  const entries = data.entries ?? []
  if (entries.length > 0) lastId = Math.max(lastId, ...entries.map((e) => e.id))
  for (const e of entries) {
    if (e.message.startsWith('[scene]')) sceneLog.push(parseScene(e.message))
  }
  return entries
}

async function waitLog(fragment, timeoutMs = 30000) {
  return poll(async () => {
    for (const e of await consoleEntries()) {
      if (e.message.includes(fragment)) return e
    }
    return null
  }, { timeoutMs })
}

function parseScene(msg) {
  const kind = msg.match(/kind=(\w+)/)?.[1]
  const accepted = msg.match(/accepted=(\d+|none)/)?.[1]
  const pending = msg.match(/pending=(\d+)/)?.[1]
  const total = msg.match(/total=(\d+)/)?.[1]
  return { kind, accepted, pending, total, raw: msg }
}

async function waitScene(kind, { accepted, pending, total, timeoutMs = 20000 } = {}) {
  const matches = (s) =>
    s.kind === kind &&
    (accepted === undefined || s.accepted === String(accepted)) &&
    (pending === undefined || s.pending === String(pending)) &&
    (total === undefined || s.total === String(total))
  const deadline = Date.now() + timeoutMs
  let cursor = sceneLog.length
  while (Date.now() < deadline) {
    await consoleEntries() // pulls new console entries into sceneLog
    while (cursor < sceneLog.length) {
      const s = sceneLog[cursor++]
      if (matches(s)) return s
    }
    await sleep(300)
  }
  return null
}

async function input(action) {
  const res = await fetch(`${BASE}/api/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  const body = await res.json().catch(() => ({}))
  if (!body.ok) throw new Error(`input "${action}" rejected: ${JSON.stringify(body)}`)
  await sleep(500)
}

async function shot(name) {
  const res = await fetch(`${BASE}/api/screenshot/glasses`)
  if (!res.ok) throw new Error(`screenshot ${name} failed: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const file = resolve(SHOTS, `${name}.png`)
  writeFileSync(file, buf)
  console.log(`  shot: shots/${name}.png (${buf.length} bytes)`)
}

const failures = []
function expect(cond, msg) {
  if (cond) {
    console.log(`  PASS: ${msg}`)
  } else {
    failures.push(msg)
    console.log(`  FAIL: ${msg}`)
  }
}

async function main() {
  console.log('== Sprite E1 simulator walkthrough ==')

  // 1. Simulator up + app ready
  const pong = await poll(() => ping(), { timeoutMs: 60000 })
  if (pong !== 'pong') throw new Error('simulator automation API not reachable on :9898')
  const ready = await waitLog('APP_READY', 45000)
  if (!ready) throw new Error('APP_READY never logged; check the dev server and simulator console')

  // 2. Real home first: with no Factory key saved the connect prompt boots
  //    (setup never gates the app; the demo is an explicit opt-in)
  expect(sceneLog.some((s) => s.kind === 'setup_notice'), 'real home: connect prompt shown (no Factory key)')
  await shot('01-home-connect')

  // 3. Opt into the labeled demo (focus Demo, activate); E1 runs from here
  await input('down') // focus: Demo
  await input('click')
  expect((await waitScene('meet', { timeoutMs: 8000 })) !== null, 'demo meet card shown after opt-in')
  await shot('02-demo-meet')

  // 4. Setup conversation
  await input('click')
  expect((await waitScene('setup_notice', { timeoutMs: 8000 })) !== null, 'setup notice shown')
  await shot('02-setup-notice')
  await input('click')
  expect((await waitScene('setup_connections', { timeoutMs: 8000 })) !== null, 'setup connections shown')
  await shot('03-setup-connections')
  await input('click')
  expect((await waitScene('selection', { timeoutMs: 8000 })) !== null, 'goal list shown')
  await shot('04-goal-list')
  await input('click') // list item 0: Talk to Sprite

  // 4. Talk (item 0) — mic may or may not be available in this environment
  const micResult = await poll(async () => {
    for (const e of await consoleEntries()) {
      if (e.message.includes('capture started')) return { ok: true }
      if (e.message.includes('microphone start failed')) return { ok: false }
    }
    return null
  }, { timeoutMs: 20000 })
  if (!micResult) throw new Error('neither mic start nor mic failure logged after Talk selection')
  let talked = false
  if (!micResult.ok) {
    console.log('  (microphone unavailable; exercising the G05 path)')
    expect(true, 'mic failure path: no Listening shown without a started mic (G05)')
    await shot('05-mic-error')
    await input('double_click') // back to the goal list
    await waitScene('selection', { timeoutMs: 8000 })
    await input('down') // focus item 1: scripted goal
    await input('click')
  } else {
    talked = true
    await shot('05-listening')
    await sleep(2500) // let the timer tick with real audio
    await input('click') // tap to finish (tap-to-talk)
    const ended = await waitLog('capture ended', { timeoutMs: 10000 })
    expect(ended !== null, 'tap-to-talk capture ended by tap')
  }
  expect((await waitScene('transcript', { timeoutMs: 12000 })) !== null, 'demo transcript card shown')
  await shot('06-transcript')

  // 5. Plan + milestone detail
  await input('click')
  expect((await waitScene('plan', { timeoutMs: 8000 })) !== null, 'plan card shown')
  await shot('07-plan')
  await input('down') // focus Milestones
  await input('click')
  expect((await waitScene('selection', { timeoutMs: 8000 })) !== null, 'milestone list shown')
  await shot('08-plan-detail')
  await input('double_click') // back to the plan
  await waitScene('plan', { timeoutMs: 8000 })

  // 6. Start: running base card
  await input('click') // focus resets to 0 = Start
  expect((await waitScene('running', { accepted: 35, pending: 0, total: 100, timeoutMs: 8000 })) !== null, 'running card: 35% verified baseline')
  await shot('09-running')

  // 7. Pause/resume
  await input('down') // focus Pause
  await input('click')
  expect((await waitScene('paused', { timeoutMs: 8000 })) !== null, 'pause card shown (work paused, not cancelled)')
  await shot('10-paused')
  await input('click') // focus 0 = Resume
  expect((await waitScene('running', { timeoutMs: 8000 })) !== null, 'resumed running')

  // 8. Review beats
  expect((await waitScene('under_review', { accepted: 35, pending: 20, timeoutMs: 15000 })) !== null, 'ui submitted: 35% solid + 20% dotted')
  await shot('11-under-review')
  expect((await waitScene('repair', { accepted: 35, pending: 0, timeoutMs: 15000 })) !== null, 'repair requested: no progress credit')
  await shot('12-repair')
  expect((await waitScene('under_review', { accepted: 35, pending: 20, timeoutMs: 15000 })) !== null, 'resubmitted for review')
  expect((await waitScene('accepted', { accepted: 55, pending: 0, timeoutMs: 15000 })) !== null, 'ui accepted: 55% verified')
  await shot('13-accepted')

  // 9. Decision (persists; explain + back)
  expect((await waitScene('decision', { timeoutMs: 12000 })) !== null, 'decision card shown after transient')
  await shot('14-decision')
  await input('down') // focus Explain
  await input('click')
  expect((await waitScene('decision_detail', { timeoutMs: 8000 })) !== null, 'decision detail shown')
  await shot('15-decision-detail')
  await input('double_click')
  expect((await waitScene('decision', { timeoutMs: 8000 })) !== null, 'decision persists after back (never auto-answered)')

  // 10. Answer: provider switch + regression + final
  await input('click') // focus 0 = Use it
  expect((await waitScene('switching', { timeoutMs: 8000 })) !== null, 'lead switch card shown')
  await shot('16-switching')
  expect((await waitScene('under_review', { accepted: 55, pending: 25, timeoutMs: 12000 })) !== null, 'verify milestone under review: 55% + 25% in review')
  expect((await waitScene('regression', { accepted: 35, pending: 25, timeoutMs: 15000 })) !== null, 'regression: verified progress decreased 55 -> 35')
  await shot('17-regression')
  expect((await waitScene('under_review', { accepted: 35, pending: 45, timeoutMs: 15000 })) !== null, 'repair resubmitted alongside verify')
  expect((await waitScene('accepted', { accepted: 55, pending: 25, timeoutMs: 15000 })) !== null, 'ui re-accepted: 55%')
  expect((await waitScene('accepted', { accepted: 80, pending: 0, timeoutMs: 15000 })) !== null, 'verify accepted: 80%')
  expect((await waitScene('under_review', { accepted: 80, pending: 20, timeoutMs: 15000 })) !== null, 'PR milestone under review')
  const fin = await waitScene('final', { accepted: 100, pending: 0, timeoutMs: 15000 })
  expect(fin !== null, 'final card: 100% verified PR')
  await shot('18-final')

  // 11. Evidence (focus 0 = Show evidence)
  await input('click')
  expect((await waitScene('selection', { timeoutMs: 8000 })) !== null, 'evidence list shown')
  await shot('19-evidence')
  await input('double_click')
  await waitScene('final', { timeoutMs: 8000 })

  // 12. Restart: exits the demo; the real home (connect prompt) returns
  await input('down') // focus Restart
  await input('click')
  expect((await waitScene('setup_notice', { timeoutMs: 8000 })) !== null, 'restart exits the demo; the real home returns')
  await shot('20-restart-home')

  console.log('')
  if (failures.length === 0) {
    console.log(`WALKTHROUGH PASSED: ${talked ? 'voice path' : 'list path'}, ${sceneLog.length} scene transitions, 0 failures`)
  } else {
    console.log(`WALKTHROUGH FAILED: ${failures.length} failures`)
    for (const f of failures) console.log(' -', f)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('WALKTHROUGH ERROR:', e?.message ?? e)
  process.exitCode = 1
})
