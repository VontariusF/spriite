/** Isolated ?fresh=1&fake-native=1&flags=persistent_runtime_v2&fake-phone=now&fake-native-channel=<port>
 * simulator only (Mission v1 fixture; use fake-native=v2 for the Mission v2
 * fixture, detected from its first request). Exercises projections, never
 * qualifies Factory runtime. The channel is the simulator's automation port:
 * each fixture simulator polls its own control file, so simulators on other
 * ports never receive this walkthrough's commands. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const controls = resolve(root, '.screenshots/native-mission')
const shots = process.argv[3] ? resolve(process.argv[3]) : controls
const port = process.argv[2] ?? '9916'
const base = `http://127.0.0.1:${port}`
const controlFile = resolve(controls, `control-${port}.json`)
mkdirSync(shots, { recursive: true })
let sequence = Date.now()
let lastId = 0
const results = new Map()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function pull() {
  const response = await fetch(`${base}/api/console${lastId ? `?since_id=${lastId}` : ''}`, { signal: AbortSignal.timeout(5000) })
  assert.ok(response.ok)
  const body = await response.json()
  for (const entry of body.entries) {
    lastId = Math.max(lastId, entry.id)
    if (entry.message.startsWith('[native-probe] {')) {
      const data = JSON.parse(entry.message.slice('[native-probe] '.length))
      results.set(data.sequence, data)
    }
    assert.ok(!entry.message.startsWith('[uncaught]') && !entry.message.startsWith('[unhandledrejection]'), entry.message)
  }
}
async function command(action, extra = {}) {
  const id = ++sequence
  writeFileSync(controlFile, JSON.stringify({ sequence: id, action, ...extra }))
  const until = Date.now() + 90000
  while (Date.now() < until) {
    await pull()
    if (results.has(id)) {
      const value = results.get(id)
      assert.equal(value.ok, true, value.error)
      return value
    }
    await sleep(350)
  }
  throw new Error('Offline native simulator probe timed out')
}
async function state(predicate, timeout = 60000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const value = await command('inspect')
    if (value.snapshot?.holdReason?.startsWith('Local save failed')) {
      throw new Error('Local store halted after a simulator stall; restart the simulator')
    }
    if (predicate(value)) return value
    await sleep(400)
  }
  throw new Error('Offline native scene did not advance')
}
async function screenshot(name) {
  // Webview capture can stall host bridge replies for tens of seconds after
  // the image returns. A save in that window times out and halts the store,
  // so pause scheduling once queued saves finish and resume after the stall.
  const before = Date.now()
  await state(v => v.snapshot.state === 'completed' || Date.parse(v.snapshot.lastObservedAt) > before)
  await command('capture_quiet') // replies only after queued saves finish
  for (const surface of ['glasses', 'webview']) {
    const response = await fetch(`${base}/api/screenshot/${surface}`, { signal: AbortSignal.timeout(20000) })
    assert.ok(response.ok)
    writeFileSync(resolve(shots, `${name}-${surface}.png`), Buffer.from(await response.arrayBuffer()))
  }
  // Console lines travel over the same host bridge as storage, so a relayed
  // reply proves the bridge answers again before saves are allowed to resume.
  await command('inspect')
  await command('capture_resume')
  // Webview capture can stall simulator bridge callbacks. Wait for a new
  // authoritative fixture read, never bypass the actor's freshness/storage gate.
  const capturedAt = Date.now()
  await state(v => v.snapshot.state === 'completed' ||
    Date.parse(v.snapshot.lastObservedAt) > capturedAt)
}
let checks = 0
function check(value, label) { assert.ok(value, label); checks++; console.log(`PASS: ${label}`) }
await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(5000) })
let current = await state(v => v.snapshot.attention.some(a => a.state === 'open'))
if (process.argv[3]) await command('capture_viewport')
check(current.snapshot.backend === 'factory_native', 'offline fixture uses the independent native actor')
const open = kind => v => v.snapshot.attention.find(a => a.kind === kind && a.state === 'open')
if (open('permission')(current)?.title === 'Plan as a Factory Mission') {
  // ?fake-native=v2: Mission v2 as projected by the broker.
  const recommend = open('permission')(current)
  check(recommend.options.map(o => o.label).join('|') === 'Start Mission planning|Continue normally',
    'v2 recommendation keeps the provider option labels')
  await screenshot('v2-01-recommend')
  await command('respond', { attentionId: recommend.attentionId })
  current = await state(v => open('proposal')(v))
  const plan = open('proposal')(current)
  check(plan.options.some(o => o.label === 'Approve Mission' && o.value === 'proceed_once'),
    'v2 plan approval is labelled by the provider, not a separate start step')
  await screenshot('v2-02-plan')
  await command('phone_scroll', { offset: 0 })
  await screenshot('v2-02a-plan-phone')
  await command('respond', { attentionId: plan.attentionId })
  current = await state(v => v.snapshot.state === 'running' && v.snapshot.features.length === 3)
  check(!current.snapshot.attention.some(a => a.kind === 'start'), 'v2 plan approval starts the run without a start request')
  // Factory-reported features draw as a dotted/dim bar (recorded deviation):
  // a bar may show, but nothing counts as accepted reviewed weight.
  check(current.scene.progress === null || current.scene.progress.acceptedWeight === 0,
    'v2 checks are not accepted reviewed weights')
  await screenshot('v2-03-running')
  current = await state(v => v.snapshot.features.some(f => f.status === 'unmet'), 150000)
  check(/unmet/.test(current.scene.status ?? '') &&
    /1\/3 done/.test(current.scene.status ?? ''), 'unmet check is shown as not done on the HUD status')
  await screenshot('v2-04-unmet')
  await command('phone_scroll', { offset: 0 })
  await screenshot('v2-04a-unmet-phone')
  current = await state(v => v.snapshot.state === 'completed', 150000)
  check(current.snapshot.features.every(f => f.status === 'completed'), 'v2 completion follows every check met')
  check(current.snapshot.finalization.state === 'incomplete' && !current.snapshot.finalization.evidence.length,
    'v2 completion states missing artifact evidence instead of claiming delivery')
  await command('phone_top')
  await screenshot('v2-05-completed')
  current = await state(v => v.snapshot.delivery?.step === 'not_merged', 150000)
  check(current.scene.status === 'Not merged: no checks configured',
    'v2 delivery with zero checks is shown as not merged, never delivered')
  check(!/delivered/i.test(current.scene.utterance.replace(/Not delivered/, '')),
    'a not-merged job is never described as delivered')
  check(current.snapshot.usage?.state === 'unavailable', 'v2 usage reports unavailable honestly')
  await command('phone_top')
  await screenshot('v2-06-not-merged')
  writeFileSync(resolve(shots, 'evidence.json'), JSON.stringify({
    fixture: true, dialect: 'v2', providerQualified: false, checks, snapshot: current.snapshot,
  }, null, 2))
  console.log(`${checks} offline native v2 simulator checks passed; provider and hardware qualification not exercised`)
  console.log('NATIVE WALKTHROUGH PASSED (offline v2 fixture only)')
  process.exit(0)
}
current = await state(v => v.snapshot.attention.some(a => a.kind === 'proposal' && a.state === 'open'))
check(current.scene.progress === null, 'native proposal does not invent reviewed weighted progress')
await screenshot('01-proposal')
await command('respond', { attentionId: current.snapshot.attention.find(a => a.kind === 'proposal' && a.state === 'open').attentionId })
current = await state(v => v.snapshot.attention.some(a => a.kind === 'start' && a.state === 'open'))
check(current.snapshot.state === 'initializing', 'proposal approval does not bypass the separate native run-start request')
await screenshot('02-start')
await command('respond', { attentionId: current.snapshot.attention.find(a => a.kind === 'start' && a.state === 'open').attentionId })
current = await state(v => v.snapshot.attention.filter(a => a.state === 'open').length === 2)
check(current.snapshot.attention.some(a => a.kind === 'ask_user' && a.sessionId === 'fixture-child'),
  'native worker questionnaire keeps exact child ownership')
check(current.snapshot.attention.some(a => a.kind === 'permission' && a.sessionId === 'fixture-root'),
  'root permission remains visible alongside the child question')
check(current.scene.progress === null, 'running native features are not accepted reviewed weights')
await screenshot('03-attention-queue')
await command('phone_scroll', { offset: 0 })
await screenshot('03a-permission-phone')
await command('phone_scroll', { offset: 500 })
await screenshot('03b-questionnaire-phone')
await command('phone_scroll', { offset: 850 })
await screenshot('03c-questionnaire-controls-phone')
const permission = current.snapshot.attention.find(a => a.kind === 'permission' && a.state === 'open')
await command('respond', { attentionId: permission.attentionId })
current = await state(v => v.snapshot.attention.some(a => a.kind === 'ask_user' && a.state === 'open') &&
  !v.snapshot.attention.some(a => a.kind === 'permission' && a.state === 'open'))
check(current.snapshot.attention.find(a => a.kind === 'ask_user').questions.length === 2,
  'full multi-question and multi-select worker data survive permission resolution')
await screenshot('04-worker-question')
await command('respond', { attentionId: current.snapshot.attention.find(a => a.kind === 'ask_user' && a.state === 'open').attentionId })
current = await state(v => v.snapshot.state === 'completed')
check(current.snapshot.finalization.state === 'incomplete' && !current.snapshot.finalization.evidence.length,
  'native completion states missing artifact evidence instead of claiming delivery')
check(!current.snapshot.capabilities.cancel, 'unsupported whole-Mission cancellation is not claimed')
await command('phone_top')
await screenshot('05-finalization')
current = await state(v => ['pr_open', 'checks_pending'].includes(v.snapshot.delivery?.step), 150000)
check(/^PR open · checks [12]\/3$/.test(current.scene.status), 'open PR shows check progress, not delivery')
check(!/Delivered/.test(current.scene.utterance), 'an open PR is never described as delivered')
await screenshot('05a-pr-open')
current = await state(v => v.snapshot.delivery?.step === 'merged', 150000)
check(current.scene.status === 'Merged', 'merged PR is the only delivered state')
check(/Delivered/.test(current.scene.utterance), 'merged delivery is described as delivered')
check(current.snapshot.usage?.state === 'pending', 'usage is pending until the next day')
await command('phone_top')
await screenshot('05b-merged')
if (process.argv[3]) {
  for (const section of ['settings', 'inspection', 'consent']) {
    await command('phone_admission', { section })
    await screenshot(`06-admission-${section}`)
  }
}
writeFileSync(resolve(shots, 'evidence.json'), JSON.stringify({
  fixture: true, providerQualified: false, checks, snapshot: current.snapshot,
}, null, 2))
console.log(`${checks} offline native simulator checks passed; provider and hardware qualification not exercised`)
console.log('NATIVE WALKTHROUGH PASSED (offline fixture only)')
