// Actual actor/client seam, synthetic providers and memory-only checkpoints.
import assert from 'node:assert/strict'
import { TestKV, makeClients, makeRuntime, cmd, drive, settleAll } from './lib/runtime-fake.mjs'

const kv = new TestKV()
const provider = makeClients({ planQuestion: 'DECISION: Which database?\nOPTIONS: Postgres | SQLite' })
const captures = []
let ctx
const deliveryState = snapshot => {
  if (!snapshot) return snapshot
  // Read-only activity/render updates may land while the durable save awaits.
  const { seq, activityStatus, ...state } = snapshot
  // Before/after the first read, blank and idle both mean no active run.
  // Preserve every authority field and all other (including running) statuses.
  return { ...state, jobs: state.jobs.map(job => ({
    ...job, runStatus: job.runStatus === '' ? 'idle' : job.runStatus,
  })) }
}
const post = provider.postMessage
provider.postMessage = async (sessionId, text, computerId) => {
  const actor = ctx.supervisor.missions.map(m => ctx.supervisor.actor(m.missionId))
    .find(a => a.snapshot.sessionId === sessionId || a.snapshot.jobs.some(j => j.sessionId === sessionId))
  assert.ok(actor, 'the outgoing message belongs to its managed actor')
  captures.push({
    kind: text.startsWith('The owner chose:') ? 'decision'
      : text.startsWith('You are the execution worker.') ? 'execution' : 'planning',
    live: structuredClone(actor.snapshot),
    durable: structuredClone(ctx.supervisor.missionStore.current.engineSnapshots?.[actor.missionId]),
  })
  return post(sessionId, text, computerId)
}
ctx = makeRuntime(kv, provider, { snapshotDebounceMs: 600000 })
await ctx.supervisor.boot()
const admitted = await ctx.supervisor.submitCommand({
  ...cmd('Build a small database-backed form', 'team-durable-delivery'), startApproved: true,
})
assert.ok(admitted.missionId, 'the command is durably admitted')
const actor = ctx.supervisor.actor(admitted.missionId)
if (process.argv.includes('--simulate-missing-barrier')) actor.engine.beforeSessionDispatch = undefined
assert.ok(await drive(ctx, () => actor.snapshot.decisionPending), 'the real actor receives the question')
actor.chooseDecisionList(1)
assert.ok(await drive(ctx, () => actor.snapshot.planLabels.length > 0),
  `the answer returns a fresh plan: phase=${actor.snapshot.phase}, awaiting=${actor.snapshot.awaiting}, pending=${actor.snapshot.decisionPending}`)
ctx.supervisor.handleAction(admitted.missionId, 'begin')
await settleAll(ctx)
if (actor.snapshot.buildDraft) ctx.supervisor.handleAction(admitted.missionId, 'confirm_chat_build')
else if (actor.snapshot.decisionGate) ctx.supervisor.handleAction(admitted.missionId, 'use_it')
assert.ok(await drive(ctx, () => captures.some(c => c.kind === 'execution')), 'the real actor reaches worker execution')
await settleAll(ctx)

let failed = 0
for (const kind of ['decision', 'execution']) {
  try {
    const capture = captures.find(c => c.kind === kind)
    assert.ok(capture, `${kind} POST was exercised`)
    assert.deepEqual(deliveryState(capture.durable), deliveryState(capture.live),
      'current receipt/correlation state must be acknowledged before the POST')
    console.log(`PASS: managed ${kind} POST follows a durable current engine snapshot`)
  } catch (error) {
    failed++
    console.error(`FAIL: managed ${kind} POST precedes its durable delivery state\n${error.message}`)
  }
}
if (!process.argv.includes('--simulate-missing-barrier')) {
  for (const block of ['storage', 'pause']) {
    const memory = new TestKV()
    const synthetic = makeClients({ planQuestion: 'DECISION: Which database?\nOPTIONS: Postgres | SQLite' })
    const runtime = makeRuntime(memory, synthetic, { snapshotDebounceMs: 600000 })
    await runtime.supervisor.boot()
    const receipt = await runtime.supervisor.submitCommand(cmd('Keep this answer safe', `delivery-${block}`))
    const target = runtime.supervisor.actor(receipt.missionId)
    assert.ok(await drive(runtime, () => target.snapshot.decisionPending))
    const count = synthetic.counts.postMessage
    let release
    let entered
    const waiting = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { release = resolve })
    if (block === 'storage') memory.failNextSets = 1
    else {
      const write = memory.set.bind(memory)
      let held = false
      memory.set = async (key, value) => {
        let data
        try { data = JSON.parse(value) } catch {}
        if (!held && data?.state?.engineSnapshots?.[receipt.missionId]?.deliveryAttempts?.length) {
          held = true
          entered()
          await gate
        }
        return write(key, value)
      }
    }
    target.chooseDecisionList(1)
    if (block === 'pause') {
      await waiting
      target.pause()
      release()
    }
    await settleAll(runtime)
    try {
      assert.equal(synthetic.counts.postMessage, count, 'no answer crosses the failed/revoked persistence boundary')
      console.log(`PASS: ${block} at managed delivery persistence prevents the provider POST`)
    } catch (error) {
      failed++
      console.error(`FAIL: ${block} at managed delivery persistence allowed a POST\n${error.message}`)
    }
  }
}
if (failed) process.exitCode = 1
