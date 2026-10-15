/**
 * Regression tests for runtime capacity/backoff fixes in the supervisor and
 * native mission actor. Actual Supervisor/actors/store seams; no network.
 * Run: node --import ./scripts/ts-resolve.mjs scripts/test-runtime-fixes.mjs
 */
import assert from 'node:assert/strict'
import { Supervisor } from '../src/runtime/supervisor.ts'
import { createRuntimeStore } from '../src/state/runtime-store.ts'
import { TestKV, SETTINGS, makeClients } from './lib/runtime-fake.mjs'

let passed = 0
let failed = 0
const test = async (name, fn) => {
  try {
    await fn()
    passed++
    console.log(`PASS ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}`)
    console.log(error)
  }
}

const profile = {
  brokerUrl: 'https://broker.original.test', ownerId: 'owner-1',
  machineId: 'machine-1', cwd: '/work/exact-checkout', baseRef: 'develop',
}
const capabilities = {
  protocolVersion: 1, qualificationId: 'fixture-only', transportVersion: 'static-test-1',
  qualified: true, launch: true, rootAttention: true, childAttention: true,
  recoverAttention: true, pause: true, resume: true, cancel: true,
}
function intent(id = 'native-1') {
  return {
    protocolVersion: 1, missionId: id, ownerId: profile.ownerId, commandId: `command-${id}`,
    goal: 'Keep the fixture intact.', scopeRevision: 1, operation: 'implement',
    workspace: { machineId: profile.machineId, cwd: profile.cwd, repository: SETTINGS.repository,
      baseRef: 'develop', baseSha: 'base-exact' },
    references: [], acceptanceCriteria: ['A real fixture passes'], restrictions: [],
    policy: { autonomy: 'high', allowCreateRepository: false, allowPush: false, allowPr: false, allowMerge: false, allowDeploy: false },
    scopeApproved: true, highAutonomyApproved: true, settings: {},
  }
}
function snapshot(i = intent()) {
  return {
    protocolVersion: 1, backend: 'factory_native', missionId: i.missionId, ownerId: i.ownerId,
    scopeRevision: i.scopeRevision, brokerSeq: 1, state: 'running', control: 'running',
    binding: { sessionId: 'root-native', ...i.workspace, baseSha: i.workspace.baseSha ?? null },
    capabilities: { ...capabilities }, attention: [], features: [], history: [],
    commands: [], lastObservedAt: '2026-10-12T00:10:00.000Z', completeness: 'complete', holdReason: null, finalization: null,
  }
}
function broker(i = intent()) {
  const b = {
    value: snapshot(i), reads: [],
    async capabilities() { return structuredClone(capabilities) },
    async prepare(v) {
      b.value.missionId = v.missionId; b.value.ownerId = v.ownerId
      return structuredClone(b.value)
    },
    async observe(id, owner) { b.reads.push({ id, owner }); return structuredClone(b.value) },
    async command(v) { return { commandId: v.commandId, state: 'confirmed', reason: null } },
  }
  return b
}
function runtime(maxConcurrentWorkers) {
  const kv = new TestKV()
  const native = broker()
  const clock = { now: Date.parse('2026-10-12T00:10:00.000Z') }
  const config = { ...SETTINGS, sessionSettings: {}, nativeProfile: { ...profile } }
  const supervisor = new Supervisor({
    store: createRuntimeStore(kv), kv, clients: makeClients(), nativeClient: native, settings: () => config,
    now: () => clock.now, emitView: () => {}, ...(maxConcurrentWorkers ? { maxConcurrentWorkers } : {}),
  })
  return { supervisor, clock, kv, native }
}

await test('native mission with no live actor never takes a legacy worker slot', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  await ctx.supervisor.flush()
  const mission = ctx.supervisor.missions[0]
  assert.equal(mission.config.executionBackend, 'factory_native')
  // Simulate the retire-then-commit window of promote/dismissHeldNativeIntent:
  // the actor is gone but the mission is still non-terminal and running.
  const actors = ctx.supervisor.actors
  const actor = actors.get('native-1')
  assert.ok(actor, 'native actor spawned')
  actors.delete('native-1')
  const scheduler = ctx.supervisor.scheduler
  const before = scheduler.inFlight
  ctx.supervisor.tick(ctx.clock.now)
  assert.equal(scheduler.isAdmitted('native-1'), false, 'native mission not admitted to the legacy scheduler')
  assert.equal(scheduler.isWaiting('native-1'), false, 'native mission not queued in the legacy scheduler')
  assert.equal(scheduler.inFlight, before, 'no legacy capacity consumed')
  // The actor comes back (restoreActor after a failed commit): still no slot.
  actors.set('native-1', actor)
  ctx.supervisor.tick(ctx.clock.now)
  assert.equal(scheduler.inFlight, before, 'no leaked capacity once the actor returns')
})

await test('quarantined native mission never takes a legacy worker slot', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  await ctx.supervisor.flush()
  const actors = ctx.supervisor.actors
  actors.get('native-1').dispose(); actors.delete('native-1')
  const result = await ctx.supervisor.missionStore.commit(s => ({
    state: { ...s, missions: s.missions.map(m => m.missionId === 'native-1'
      ? { ...m, config: { ...m.config, nativeQuarantine: 'Nested native record quarantined' } } : m) },
    events: [],
  }))
  assert.equal(result.ok, true)
  const scheduler = ctx.supervisor.scheduler
  for (let n = 0; n < 3; n++) ctx.supervisor.tick(ctx.clock.now += 1000)
  assert.equal(scheduler.isAdmitted('native-1'), false)
  assert.equal(scheduler.inFlight, 0, 'quarantined mission holds no capacity')
})

await test('broken storage keeps the native poll backoff between observations', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  await ctx.supervisor.flush()
  const actor = ctx.supervisor.actor('native-1')
  // Break storage on the next observation's save.
  ctx.kv.failNextSets = 1
  ctx.native.value.brokerSeq++
  ctx.clock.now += 6000
  ctx.supervisor.tick(ctx.clock.now); await ctx.supervisor.flush()
  assert.equal(ctx.supervisor.missionStore.durability, 'broken')
  let observes = 0
  const original = actor.observe.bind(actor)
  actor.observe = async () => { observes++; return original() }
  // Ten 400ms app ticks (4s) stay inside one 5s poll window.
  ctx.clock.now += 6000
  ctx.supervisor.tick(ctx.clock.now); await ctx.supervisor.flush()
  for (let n = 0; n < 10; n++) {
    ctx.clock.now += 400
    ctx.supervisor.tick(ctx.clock.now); await ctx.supervisor.flush()
  }
  assert.equal(observes, 1, `one scheduled observation per poll window while broken, saw ${observes}`)
  ctx.clock.now += 6000
  ctx.supervisor.tick(ctx.clock.now); await ctx.supervisor.flush()
  assert.equal(observes, 2, 'polling resumes after the backoff')
})

console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
