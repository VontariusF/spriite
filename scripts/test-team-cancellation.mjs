// Synthetic providers and memory-only storage: no credentials or live calls.
import assert from 'node:assert/strict'
import { TestKV, makeClients, makeRuntime, cmd, drive, quiesce, mission, eventsOf } from './lib/runtime-fake.mjs'

let checks = 0
let failures = 0
function check(value, label) {
  checks++
  try { assert.ok(value, label); console.log(`PASS: ${label}`) }
  catch { failures++; console.error(`FAIL: ${label}`) }
}
const gate = () => {
  let release
  const promise = new Promise(r => { release = r })
  return { promise, release }
}
async function beat(ctx) {
  ctx.supervisor.tick(ctx.clock.now += 500)
  await ctx.supervisor.flush()
  await quiesce()
}

for (const kind of ['cursor.agent', 'factory.worker_session', 'factory.session']) {
  const clients = makeClients()
  const launch = gate()
  const cancellation = gate()
  const calls = []
  let lateId
  const createName = kind === 'cursor.agent' ? 'cursorAgent' : 'createSession'
  const create = clients[createName]
  let armed = kind === 'factory.session'
  clients[createName] = async (...args) => {
    const result = await create(...args)
    if (armed) {
      lateId = result.agentId ?? result.sessionId
      await launch.promise
    }
    return result
  }
  clients.interrupt = async id => {
    calls.push({ provider: 'factory', id })
    if (id === lateId) await cancellation.promise
  }
  clients.cursorCancel = async (id, runId) => {
    calls.push({ provider: 'cursor', id, runId })
    if (id === lateId) await cancellation.promise
  }
  const ctx = makeRuntime(new TestKV(), clients, {
    capacity: 1, settings: { workerPref: kind.startsWith('cursor') ? 'cursor' : 'factory' },
  })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd(`Cancel late ${kind}`, kind))).missionId
  if (kind !== 'factory.session') {
    await drive(ctx, () => ctx.supervisor.actor(id).snapshot.planLabels.length > 0)
    armed = true
    ctx.supervisor.handleAction(id, 'begin')
    ctx.supervisor.handleAction(id, 'use_it')
  }
  await quiesce()
  check(ctx.supervisor.dispatches.some(d => d.missionId === id && d.state === 'sending'), `${kind}: launch is in flight`)
  ctx.supervisor.handleAction(id, 'restart')
  await quiesce()
  await beat(ctx)
  check(mission(ctx, id).phase !== 'cancelled', `${kind}: no terminal receipt before launch resolves`)
  check(ctx.supervisor.schedulerState.admitted.includes(id), `${kind}: capacity remains held across the late launch`)
  launch.release()
  await quiesce()
  await beat(ctx)
  if (kind === 'factory.session') check(clients.counts.postMessage === 0,
    'factory.session: late creation cannot post a fresh planning request after cancellation')
  check(calls.filter(c => c.id === lateId).length === 1, `${kind}: late remote resource receives one cancellation`)
  check(mission(ctx, id).phase !== 'cancelled', `${kind}: cancellation acknowledgement precedes terminal receipt`)
  check(ctx.supervisor.schedulerState.admitted.includes(id), `${kind}: unacknowledged cleanup retains capacity`)
  cancellation.release()
  for (let n = 0; n < 4; n++) await beat(ctx)
  const receipt = eventsOf(ctx, 'cancel_confirmed').find(e => e.missionId === id)
  check(mission(ctx, id).phase === 'cancelled' && receipt?.payload.basis === 'requests_accepted',
    `${kind}: accepted cleanup produces one terminal receipt`)
  check(receipt?.payload.requestedRuns.length >= (kind === 'factory.session' ? 1 : 2),
    `${kind}: receipt names the late resource as well as previously known runs`)
  check(calls.filter(c => c.id === lateId).length === 1 && eventsOf(ctx, 'cancel_confirmed').filter(e => e.missionId === id).length === 1,
    `${kind}: repeated ticks cannot duplicate cancellation or receipt`)
  check(!ctx.supervisor.schedulerState.admitted.includes(id), `${kind}: acknowledged terminal cleanup releases capacity`)
}

{
  const clients = makeClients()
  const response = gate()
  clients.cursorAgent = async () => { await response.promise; throw new Error('Lost creation response') }
  const ctx = makeRuntime(new TestKV(), clients, { settings: { workerPref: 'cursor' } })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Unknown cancelled launch', 'unknown-cancel'))).missionId
  await drive(ctx, () => ctx.supervisor.actor(id).snapshot.planLabels.length > 0)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  await quiesce()
  ctx.supervisor.handleAction(id, 'restart')
  await quiesce()
  response.release()
  await quiesce()
  for (let n = 0; n < 4; n++) await beat(ctx)
  const receipt = eventsOf(ctx, 'cancel_confirmed').find(e => e.missionId === id)
  check(receipt?.payload.basis === 'requests_partial' && receipt.payload.unresolved.some(x => x.includes('dispatch')),
    'unknown launch: terminal receipt preserves unresolved provider cleanup')
  check(mission(ctx, id).control === 'cancel_requested' && mission(ctx, id).freshness === 'unknown',
    'unknown launch: manual cleanup warning remains durable')
  check(clients.counts.cursorCancel === 0, 'unknown launch: no invented remote ID or blind relaunch')
}

{
  // Recovery knows a confirmed launch even when no engine ever adopted its id.
  const clients = makeClients()
  const cancelled = []
  clients.cursorCancel = async (agent, run) => { cancelled.push({ agent, run }) }
  const kv = new TestKV()
  const first = makeRuntime(kv, clients)
  await first.supervisor.boot()
  const id = (await first.supervisor.submitCommand(cmd('Recover late cleanup', 'restore-cleanup'))).missionId
  await quiesce()
  await first.supervisor.flush()
  await first.supervisor.missionStore.commit(s => ({
    state: {
      ...s,
      missions: s.missions.map(m => m.missionId === id ? { ...m, control: 'cancel_requested' } : m),
      outbox: [...s.outbox, {
        schemaVersion: 2, actionId: 'late-confirmed', missionId: id, runtimeEpoch: first.supervisor.epoch,
        provider: 'cursor', requestKey: `m:${id}:cursor.agent:0`, requestHash: 'synthetic',
        state: 'confirmed', attempts: 1, remoteIds: ['recovered-agent', 'recovered-run'],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }],
    }, events: [],
  }))
  const restored = makeRuntime(kv, clients)
  await restored.supervisor.boot()
  await quiesce()
  for (let n = 0; n < 4; n++) await beat(restored)
  check(cancelled.length === 1 && cancelled[0].agent === 'recovered-agent' && cancelled[0].run === 'recovered-run',
    'restore: an unadopted confirmed worker is cancelled exactly once')
  const receipt = eventsOf(restored, 'cancel_confirmed').find(e => e.missionId === id)
  check(receipt?.payload.requestedRuns.includes('dispatch:late-confirmed') && receipt.payload.basis === 'requests_accepted',
    'restore: the late launch has a durable cancellation receipt')
}

{
  const clients = makeClients()
  const ctx = makeRuntime(new TestKV(), clients)
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Refuse undurable cancellation', 'failed-cancel'))).missionId
  await drive(ctx, () => ctx.supervisor.actor(id).snapshot.planLabels.length > 0)
  await ctx.supervisor.flush()
  const before = clients.counts.interrupt
  ctx.supervisor.missionStore.kv.failNextSets = 1
  ctx.supervisor.handleAction(id, 'restart')
  await ctx.supervisor.flush()
  await quiesce()
  check(clients.counts.interrupt === before && mission(ctx, id).control === 'running',
    'storage failure: no cancellation request precedes a durable intent')
  check(eventsOf(ctx, 'cancel_confirmed').every(e => e.missionId !== id),
    'storage failure: no fabricated cancellation receipt')
}

console.log(`Cancellation regressions: ${checks - failures}/${checks} passed`)
process.exitCode = failures ? 1 : 0
