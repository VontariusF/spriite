/**
 * Phase 2 runtime tests (Persistent Companion spec §25 core correctness).
 *
 * These run the real Supervisor, MissionActor, Scheduler, Outbox, and
 * MissionStore against a scripted provider and an in-memory KV, with a
 * virtual clock: no network, no bridge, no simulator. They cover the crash
 * matrix around receipt, dispatch, and snapshot save, the fairness contract,
 * pause/cancel durability and honesty, decision staleness, migration, and the
 * runtime epoch. The scripted provider and KV harness live in
 * scripts/lib/runtime-fake.mjs, shared with the briefing suite.
 *
 * Usage: npm run test:runtime
 */
import {
  TestKV,
  makeClients as makeProviderClients,
  makeRuntime,
  cmd,
  mission,
  snapshotOf,
  drive,
  settle,
  settleAll,
  quiesce,
  forgetEngineSnapshots,
  eventsOf,
  makeTally,
  REPO,
} from './lib/runtime-fake.mjs'
import { Scheduler } from '../src/runtime/scheduler.ts'

// This suite's Cursor provider must report the PR's actual source branch,
// rather than the shared helper's old hard-coded "spriite/job-1" placeholder.
function makeClients(opts = {}) {
  const clients = makeProviderClients(opts)
  const runs = new Map()
  const cursorRun = clients.cursorRun
  const cursorGet = clients.cursorGet
  clients.cursorRun = async (agentId, prompt) => {
    const result = await cursorRun(agentId, prompt)
    runs.set(result.runId, prompt)
    return result
  }
  clients.cursorGet = async (agentId, runId) => {
    const result = await cursorGet(agentId, runId)
    const prompt = runs.get(runId) ?? ''
    if (result.status === 'FINISHED' && /Open a pull request/.test(prompt)) {
      result.branches = result.branches.map((b) => ({ ...b, branch: /from branch "([^"]+)"/.exec(prompt)?.[1] }))
    }
    return result
  }
  return clients
}

const { assert, failures } = makeTally()
console.log('== Runtime supervisor tests (Persistent Companion spec §25) ==')

// ------------------------------------------- A. command pipeline and identity
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients)
  const boot = await ctx.supervisor.boot()
  assert(boot.epoch === 1 && boot.origin === 'fresh', 'first boot takes epoch 1 on fresh storage')

  const a = await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'x:1'))
  const b = await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'x:2'))
  assert(a.receipt === 'saved' && b.receipt === 'saved', 'commands are reported saved only after the commit')
  assert(a.missionId !== b.missionId, 'two identical goal strings create distinct mission IDs (§25.1)')
  const dup = await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'x:1'))
  assert(
    dup.receipt === 'duplicate' && dup.missionId === a.missionId,
    'a duplicate source event resolves to the original receipt (§25.1)',
  )
  assert(ctx.supervisor.missions.length === 2, 'the duplicate delivery created no second mission')

  const [r1, r2] = await Promise.all([
    ctx.supervisor.submitCommand(cmd('Ship the login fix', 'x:3')),
    ctx.supervisor.submitCommand(cmd('Ship the login fix', 'x:3')),
  ])
  assert(
    r1.receipt === 'saved' && r2.receipt === 'duplicate' && r1.missionId === r2.missionId,
    'a concurrent duplicate delivery resolves to one mission',
  )
  assert(ctx.supervisor.missions.length === 3, 'three distinct dedupe keys made three missions')
  const empty = await ctx.supervisor.submitCommand(cmd('   ', 'x:4'))
  assert(empty.receipt === 'rejected', 'an empty command is rejected, never launched')
  await ctx.supervisor.flush()
}

// ------------------------- B. missions run independently of the selected view
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const ids = []
  for (const i of [1, 2, 3]) {
    const r = await ctx.supervisor.submitCommand(cmd(`Goal number ${i}`, `g${i}`))
    ids.push(r.missionId)
  }
  await ctx.supervisor.flush()
  const started = await drive(
    ctx,
    () => ids.every((id) => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0),
    30000,
  )
  assert(started, 'every mission starts its own lead session without being selected (§25.7)')
  for (const id of ids) ctx.supervisor.handleAction(id, 'begin')
  for (const id of ids) ctx.supervisor.handleAction(id, 'use_it')
  const building = await drive(ctx, () => clients.counts.createSession === 6, 30000)
  assert(building, 'three missions build in parallel under one supervisor')
  assert(clients.counts.createSession === 6, 'each mission owns a lead session plus its own worker session')
  assert(
    ctx.views.every((v) => typeof v.missionId === 'string' && v.missionId !== ''),
    'every emitted card is tagged with the mission it belongs to',
  )
  assert(
    ids.every((id) => ctx.views.some((v) => v.missionId === id)),
    'no mission is silenced by another mission being on screen',
  )
}

// ------------------------------------------------- C. fair capacity scheduling
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 1 })
  await ctx.supervisor.boot()
  const m1 = (await ctx.supervisor.submitCommand(cmd('Goal one', 'k1'))).missionId
  const m2 = (await ctx.supervisor.submitCommand(cmd('Goal two', 'k2'))).missionId
  const m3 = (await ctx.supervisor.submitCommand(cmd('Goal three', 'k3'))).missionId
  ctx.clock.now = 2000
  ctx.supervisor.tick(2000)
  await ctx.supervisor.flush()
  assert(ctx.supervisor.schedulerState.waiting.length === 2, 'capacity 1 queues the two later missions')
  assert(
    ctx.supervisor.schedulerState.waiting[0] === m2 && ctx.supervisor.schedulerState.waiting[1] === m3,
    'the waiting queue is arrival order (FIFO), so a later mission cannot cut ahead',
  )

  const planned = await drive(ctx, () => (snapshotOf(ctx, m2)?.planLabels.length ?? 0) > 0, 30000)
  assert(planned, 'a mission waiting for worker capacity still plans (capacity limits launches, not observation)')
  ctx.supervisor.handleAction(m2, 'begin')
  const held = ctx.supervisor.handleAction(m2, 'use_it')
  assert(held.kind === 'held' && held.reason === 'capacity', 'a queued mission cannot start workers')
  const beforeWorkers = clients.counts.createSession
  await settle(ctx, 6000)
  assert(clients.counts.createSession === beforeWorkers, 'the held approval launched nothing')

  ctx.supervisor.handleAction(m1, 'pause')
  await ctx.supervisor.flush()
  ctx.clock.now += 40000
  ctx.supervisor.tick(ctx.clock.now)
  await ctx.supervisor.flush()
  await quiesce()
  ctx.supervisor.tick(ctx.clock.now)
  await ctx.supervisor.flush()
  assert(
    ctx.supervisor.schedulerState.waiting.length === 1 && ctx.supervisor.schedulerState.waiting[0] === m3,
    'freeing capacity promoted the FIRST waiter; a later mission did not starve it (§25.8)',
  )
  const launched = await drive(ctx, () => clients.counts.createSession > beforeWorkers, 30000)
  assert(launched, 'the promoted mission replays the approval it was holding')
  assert(
    clients.counts.createSession === beforeWorkers + 1,
    'exactly one worker session was created for the promoted mission',
  )
  assert((snapshotOf(ctx, m3)?.jobs ?? []).length === 0, 'the starved mission did not launch workers')

  // The waiters drain in arrival order: pausing the slot holder promotes the
  // NEXT waiter, and a pause itself cannot hold capacity.
  ctx.supervisor.handleAction(m2, 'pause')
  await ctx.supervisor.flush()
  ctx.clock.now += 40000
  ctx.supervisor.tick(ctx.clock.now)
  await ctx.supervisor.flush()
  await quiesce()
  assert(
    ctx.supervisor.schedulerState.waiting.length === 0 && ctx.supervisor.schedulerState.admitted.includes(m3),
    'the next waiter was promoted in arrival order once the holder paused (§25.8)',
  )
  const afterPromote = clients.counts.createSession
  await settle(ctx, 4000)
  assert(clients.counts.createSession === afterPromote, 'a promoted mission without a queued approval launches nothing')
  ctx.supervisor.handleAction(m3, 'begin')
  assert(ctx.supervisor.handleAction(m3, 'use_it').kind === 'forwarded', 'the admitted mission proceeds with its approval')
  const beforeWorker = clients.counts.createSession
  await drive(ctx, () => (snapshotOf(ctx, m3)?.jobs ?? []).some((j) => j.state === 'building'), 30000)
  assert(clients.counts.createSession === beforeWorker + 1, 'the promoted mission launched its own worker')
}

// ------------------------ C2. a held approval is dropped by a pause (§7, §10)
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 1 })
  await ctx.supervisor.boot()
  const m1 = (await ctx.supervisor.submitCommand(cmd('Goal one', 'c2:1'))).missionId
  const m2 = (await ctx.supervisor.submitCommand(cmd('Goal two', 'c2:2'))).missionId
  ctx.clock.now = 2000
  ctx.supervisor.tick(2000)
  await ctx.supervisor.flush()
  await drive(ctx, () => (snapshotOf(ctx, m1)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(m1, 'begin')
  ctx.supervisor.handleAction(m1, 'use_it')
  await drive(ctx, () => (snapshotOf(ctx, m1)?.jobs ?? []).some((j) => j.state === 'building'), 30000)
  assert(ctx.supervisor.schedulerState.admitted.includes(m1), 'the first mission holds the only slot')

  await drive(ctx, () => (snapshotOf(ctx, m2)?.planLabels.length ?? 0) > 0, 30000)
  const held = ctx.supervisor.handleAction(m2, 'use_it')
  assert(held.kind === 'held' && held.reason === 'capacity', 'the queued mission holds its approval')
  ctx.supervisor.handleAction(m2, 'pause')
  await ctx.supervisor.flush()
  ctx.clock.now += 40000
  ctx.supervisor.tick(ctx.clock.now)
  await ctx.supervisor.flush()
  await quiesce()
  assert(mission(ctx, m2).control === 'paused', 'the queued mission pauses')
  assert(
    !ctx.supervisor.schedulerState.admitted.includes(m2) && !ctx.supervisor.schedulerState.waiting.includes(m2),
    'a paused mission holds no capacity and waits in no queue (§14)',
  )

  // Free the slot: the paused mission must NOT be promoted, and its dropped
  // approval must not fire even after a resume puts it back in line.
  ctx.supervisor.handleAction(m1, 'pause')
  await ctx.supervisor.flush()
  ctx.clock.now += 40000
  ctx.supervisor.tick(ctx.clock.now)
  await ctx.supervisor.flush()
  await quiesce()
  assert(
    ctx.supervisor.schedulerState.waiting.length === 0 && ctx.supervisor.schedulerState.admitted.length === 0,
    'the freed slot went to nobody: the paused mission cannot be promoted',
  )
  const beforeResume = clients.counts.createSession
  ctx.supervisor.handleAction(m2, 'resume')
  await ctx.supervisor.flush()
  await settle(ctx, 6000)
  assert(mission(ctx, m2).control === 'running' && ctx.supervisor.schedulerState.admitted.includes(m2), 'resume re-admits the mission')
  assert(
    clients.counts.createSession === beforeResume,
    'the approval the pause dropped did not silently fire after the resume (§7)',
  )
  ctx.supervisor.handleAction(m2, 'begin')
  assert(ctx.supervisor.handleAction(m2, 'use_it').kind === 'forwarded', 'a FRESH approval still proceeds')
  await drive(ctx, () => clients.counts.createSession > beforeResume, 30000)
  assert(clients.counts.createSession === beforeResume + 1, 'the fresh approval launched the worker')
}

// -------------- C3. a typed approval cannot launch past the scheduler either
{
  // The gate button path is held at the action boundary; the TYPED "yes" path
  // goes through the engine, so the launch seam itself must hold it (§14):
  // a queued mission that types "yes" gets a named capacity refusal and the
  // build starts only once the mission is admitted.
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 1 })
  await ctx.supervisor.boot()
  const m1 = (await ctx.supervisor.submitCommand(cmd('Goal one', 'c3:1'))).missionId
  const m2 = (await ctx.supervisor.submitCommand(cmd('Goal two', 'c3:2'))).missionId
  ctx.clock.now = 2000
  ctx.supervisor.tick(2000)
  await ctx.supervisor.flush()
  await drive(ctx, () => (snapshotOf(ctx, m1)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(m1, 'begin')
  ctx.supervisor.handleAction(m1, 'use_it')
  await drive(ctx, () => (snapshotOf(ctx, m1)?.jobs ?? []).some((j) => j.state === 'building'), 30000)
  await drive(ctx, () => (snapshotOf(ctx, m2)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(m2, 'begin')
  await ctx.supervisor.flush()
  assert(
    mission(ctx, m2).phase === 'awaiting_decision' && ctx.supervisor.schedulerState.waiting.includes(m2),
    'the queued mission opens its gate while it waits',
  )
  const before = clients.counts.createSession
  const where = ctx.supervisor.say(m2, 'yes')
  await drive(ctx, () => snapshotOf(ctx, m2)?.faultKind === 'capacity', 30000)
  assert(where === 'decision', 'the typed yes was routed as a decision answer')
  assert(
    snapshotOf(ctx, m2)?.faultKind === 'capacity',
    'the typed approval on an unadmitted mission is refused BY NAME at the launch seam',
  )
  assert(clients.counts.createSession === before, 'the typed approval launched no worker past the scheduler')
  const decisionRecord = ctx.supervisor.decisions.find((d) => d.missionId === m2)
  assert(
    decisionRecord?.answeredAt !== null && decisionRecord?.answerText === 'yes',
    'the approval itself is durable even while the launch waits for capacity',
  )

  // Once the slot frees and the mission is promoted, the refused step retries.
  ctx.supervisor.handleAction(m1, 'pause')
  await ctx.supervisor.flush()
  ctx.clock.now += 40000
  ctx.supervisor.tick(ctx.clock.now)
  await ctx.supervisor.flush()
  await quiesce()
  ctx.supervisor.tick(ctx.clock.now)
  await ctx.supervisor.flush()
  const launched = await drive(ctx, () => clients.counts.createSession > before, 30000)
  assert(launched, 'the suppressed build retried once the mission was admitted')
  assert(clients.counts.createSession === before + 1, 'exactly one worker session came out of the retry')
}

// ------------------------------------------- D. pause durability and honesty
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'p1'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  await drive(ctx, () => (snapshotOf(ctx, id)?.jobs ?? []).every((j) => j.state === 'building'), 30000)

  ctx.supervisor.handleAction(id, 'pause')
  await settleAll(ctx)
  assert(mission(ctx, id).control === 'paused', 'pause confirms once no dispatch is in flight')
  assert(eventsOf(ctx, 'pause_requested').length === 1, 'the pause intent is a durable event')
  assert(eventsOf(ctx, 'pause_confirmed').length === 1, 'the pause confirmation is a durable event')
  const dropped = ctx.supervisor.handleAction(id, 'retry')
  assert(dropped.kind === 'dropped' && dropped.reason === 'paused', 'a paused mission drops launch actions')
  const sessionsBefore = clients.counts.createSession

  const advanced = await drive(ctx, () => mission(ctx, id).phase !== 'building', 40000)
  assert(advanced, 'a completion of already-running remote work is still recorded while paused (§25.5)')
  assert(mission(ctx, id).control === 'paused', 'recording progress does not resume the mission')
  assert(clients.counts.createSession === sessionsBefore, 'pausing launched nothing new')

  const ctx2 = makeRuntime(kv, clients, { capacity: 4 })
  ctx2.clock.now = ctx.clock.now
  const boot2 = await ctx2.supervisor.boot()
  assert(boot2.restoreRefused.length === 0, 'the engine working state restored cleanly')
  assert(mission(ctx2, id).control === 'paused', 'a paused mission stays paused after a restart (§25.5)')
  assert((snapshotOf(ctx2, id)?.phase ?? 'meet') !== 'meet', 'the mission resumed its engine, not a blank card')
  const droppedAfterBoot = ctx2.supervisor.handleAction(id, 'use_it')
  assert(
    droppedAfterBoot.kind === 'dropped' && droppedAfterBoot.reason === 'paused',
    'a restored pause still suppresses launches',
  )
  assert(
    clients.counts.interrupt >= 2,
    'boot re-asserts the pause on the engine itself, not only in the control record (§25.5)',
  )
  const resumed = ctx2.supervisor.handleAction(id, 'resume')
  await ctx2.supervisor.flush()
  assert(
    resumed.kind === 'forwarded' && mission(ctx2, id).control === 'running',
    'resume is the only thing that clears a pause',
  )
}

// --------- E. pause suppresses launches the engine starts on its own (cursor)
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4, settings: { workerPref: 'cursor' } })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'q1'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  await drive(ctx, () => clients.counts.cursorAgent === 1, 30000)
  assert(clients.counts.cursorAgent === 1, 'the cursor worker was launched before the pause')

  ctx.supervisor.handleAction(id, 'pause')
  await settleAll(ctx)
  const runsBefore = clients.counts.cursorRun
  await drive(ctx, () => snapshotOf(ctx, id)?.faultKind === 'paused', 60000)
  const heldView = ctx.supervisor.actor(id).currentView
  assert(snapshotOf(ctx, id)?.paused === true && mission(ctx, id).control === 'paused' &&
    heldView.type === 'scene' && heldView.scene.kind === 'paused',
    'a paused automatic follow-up stays deferred and shows the owner the pause, without forcing a dispatch attempt')
  assert(clients.counts.cursorRun === runsBefore, 'no follow-up run reached the provider while paused')
  assert(
    ctx.supervisor.dispatches.every((d) => d.state !== 'unknown'),
    'a refused launch leaves no dispatch record that recovery would later call unknown',
  )
  const resumed = ctx.supervisor.handleAction(id, 'resume')
  assert(resumed.kind === 'forwarded', 'resume clears the pause')
  const retried = await drive(ctx, () => clients.counts.cursorRun > runsBefore, 30000)
  assert(retried, 'resuming retries the follow-up the pause refused')
}

// ---------------------------------------- F. crash matrix around the dispatch
{
  // F1. Durable command, launch refused by policy, restart: one resumed start.
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, {
    policy: () => ({ revision: 'narrow', allowLaunch: false, allowedRepositories: null }),
  })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'c1'))).missionId
  await settleAll(ctx)
  assert(clients.counts.createSession === 0, 'a narrowed policy prevents the launch immediately (§25.10)')
  assert(ctx.supervisor.dispatches.length === 0, 'a policy-refused launch is not a dispatch record')
  assert((snapshotOf(ctx, id)?.faultKind ?? null) === 'policy', 'the refusal surfaces as a named fault, not a silent stall')

  const ctx2 = makeRuntime(kv, clients, { capacity: 4 })
  const boot2 = await ctx2.supervisor.boot()
  assert(boot2.resumedStarts.includes(id), 'a durably received command that never launched resumes at boot (§24)')
  assert(ctx2.supervisor.missions.length === 1, 'recovery does not mint a second mission for the same command')
  await drive(ctx2, () => clients.counts.createSession === 1, 30000)
  assert(clients.counts.createSession === 1, 'the resumed command launched exactly one lead session')
}

{
  // F2. Unknown launch outcome: blocked, never blindly retried, never duplicated.
  const kv = new TestKV()
  const clients = makeClients({ transportFailCreateSession: true })
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'u1'))).missionId
  await settleAll(ctx)
  const record = ctx.supervisor.dispatches.find((d) => d.missionId === id)
  assert(record?.state === 'unknown', 'a launch whose answer never arrived is recorded unknown (§8)')
  assert(clients.counts.createSession === 1, 'the provider was called exactly once')

  const before = clients.counts.createSession
  ctx.supervisor.handleAction(id, 'retry')
  await settle(ctx, 4000)
  assert(clients.counts.createSession === before, 'an unknown launch is not retried blindly (§8)')
  assert(
    snapshotOf(ctx, id)?.faultKind !== null,
    'the mission surfaces the unresolved launch instead of pretending the retry worked',
  )
  const reconciled = await ctx2Reconcile(ctx, id)
  assert(reconciled.unresolved.length === 1, 'reconciliation reports the unresolved launch')

  const other = (await ctx.supervisor.submitCommand(cmd('Goal two', 'u2'))).missionId
  await settleAll(ctx)
  assert(clients.counts.createSession === before + 1, 'an unknown dispatch blocks only its own mission')
  assert((snapshotOf(ctx, other)?.sessionId ?? null) !== null, 'the other mission launched normally')

  // And the block survives a restart, because it is durable.
  const ctx2 = makeRuntime(kv, clients, { capacity: 4 })
  const boot2 = await ctx2.supervisor.boot()
  assert(boot2.unresolvedDispatches.length >= 1, 'boot reports the unresolved dispatch it recovered')
}

{
  // F3. Crash between "confirmed by the provider" and "snapshot saved":
  // recovery re-adopts the recorded session instead of launching a second one.
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'r1'))).missionId
  const started = await drive(ctx, () => (snapshotOf(ctx, id)?.sessionId ?? null) !== null, 20000)
  assert(started, 'the first process created a lead session')
  const sessionId = snapshotOf(ctx, id).sessionId
  assert(clients.counts.createSession === 1, 'one lead session for the first process')

  await forgetEngineSnapshots(kv)
  const ctx2 = makeRuntime(kv, clients, { capacity: 4 })
  await ctx2.supervisor.boot()
  await ctx2.supervisor.flush()
  assert(
    snapshotOf(ctx2, id)?.sessionId === sessionId,
    'recovery re-adopted the recorded session instead of launching a duplicate (§25.28)',
  )
  assert(clients.counts.createSession === 1, 'no second session was created for the recovered mission')
}

{
  // F4. A dispatch left mid-flight by the dead epoch recovers as unknown.
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, {
    policy: () => ({ revision: 'blocked', allowLaunch: false, allowedRepositories: null }),
  })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 's1'))).missionId
  await settleAll(ctx)
  await ctx.supervisor.missionStore.commit((s) => ({
    state: {
      ...s,
      outbox: [
        ...s.outbox,
        {
          schemaVersion: 2,
          actionId: 'act_dead_epoch',
          missionId: id,
          runtimeEpoch: 1,
          provider: 'factory',
          requestKey: `m:${id}:factory.session:0`,
          requestHash: 'seeded',
          state: 'sending',
          attempts: 1,
          remoteIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
    events: [],
  }))
  const ctx2 = makeRuntime(kv, clients, { capacity: 4 })
  const boot2 = await ctx2.supervisor.boot()
  assert(boot2.epoch === 2, 'each boot takes a new runtime epoch (spec §8)')
  assert(
    ctx2.supervisor.dispatches.find((d) => d.actionId === 'act_dead_epoch')?.state === 'unknown',
    "a dispatch left 'sending' by the previous epoch recovers as unknown",
  )
  assert(boot2.unresolvedDispatches.length === 1, 'the unresolved dispatch is reported at boot')
  assert(boot2.warnings.some((w) => w.includes('unknown')), 'recovery warns instead of retrying silently')
}

{
  // F5. Definite vs unknown follows the provider adapters' ACTUAL error
  // kinds (src/factory/fapi.ts, src/factory/cursor.ts): auth/offline/HTTP 4xx
  // are definite rejections (retry is safe); network and HTTP 5xx may have
  // landed upstream (retry stays blocked).
  const kinds = [
    { kind: 'auth', message: 'Factory auth failed (401)', definite: true },
    { kind: 'quota', message: 'Factory rate limit reached (429)', definite: true },
    { kind: 'offline', message: 'Factory could not reach the computer (daemon not running)', definite: true },
    { kind: 'service', message: 'Factory HTTP 403 (forbidden)', definite: true },
    { kind: 'network', message: 'fetch failed (no response reached us)', definite: false },
    { kind: 'service', message: 'Factory HTTP 500 (backend exploded)', definite: false },
  ]
  for (let i = 0; i < kinds.length; i++) {
    const { kind, message, definite } = kinds[i]
    const kv = new TestKV()
    const failure = new Error(message)
    failure.kind = kind
    const clients = makeClients({ createSessionFailures: [failure] })
    const ctx = makeRuntime(kv, clients, { capacity: 4 })
    await ctx.supervisor.boot()
    const id = (await ctx.supervisor.submitCommand(cmd(`Goal for ${kind}`, `f5:${i}`))).missionId
    await settleAll(ctx)
    const record = ctx.supervisor.dispatches.find((d) => d.missionId === id)
    assert(
      record?.state === (definite ? 'rejected' : 'unknown'),
      `kind "${kind}" is recorded ${definite ? 'rejected' : 'unknown'} (${message})`,
    )
    assert(clients.counts.createSession === 1, `kind "${kind}": the provider was called exactly once`)
    const before = clients.counts.createSession
    ctx.supervisor.handleAction(id, 'retry')
    await settle(ctx, 4000)
    if (definite) {
      assert(
        clients.counts.createSession === before + 1,
        `kind "${kind}": a definite rejection is retried (the launch provably never happened)`,
      )
    } else {
      assert(
        clients.counts.createSession === before,
        `kind "${kind}": an unknown outcome blocks the retry (§8)`,
      )
      assert(
        (snapshotOf(ctx, id)?.faultKind ?? null) !== null,
        `kind "${kind}": the mission surfaces the unresolved launch instead of silently retrying (§8)`,
      )
    }
  }
}

{
  // F6. Crash in the prepared window (intent recorded, call never started):
  // recovery marks it rejected — retry is safe — and never calls it unknown.
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'f6'))).missionId
  const started = await drive(ctx, () => (snapshotOf(ctx, id)?.sessionId ?? null) !== null, 20000)
  assert(started, 'the mission has a live lead session before the injected crash window')
  await ctx.supervisor.missionStore.commit((s) => ({
    state: {
      ...s,
      outbox: [
        ...s.outbox,
        {
          schemaVersion: 2,
          actionId: 'act_prepared_window',
          missionId: id,
          runtimeEpoch: 1,
          provider: 'factory',
          requestKey: `m:${id}:factory.session:1`,
          requestHash: 'seeded',
          state: 'prepared',
          attempts: 2,
          remoteIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
    events: [],
  }))
  const ctx2 = makeRuntime(kv, clients, { capacity: 4 })
  const boot2 = await ctx2.supervisor.boot()
  assert(
    ctx2.supervisor.dispatches.find((d) => d.actionId === 'act_prepared_window')?.state === 'rejected',
    "a dispatch left 'prepared' by the previous epoch recovers as rejected (the call never started)",
  )
  assert(
    !boot2.warnings.some((w) => w.includes('act_prepared_window') || w.includes('unknown')),
    'the prepared window is not reported as an unknown launch',
  )
  assert(
    !boot2.unresolvedDispatches.some((u) => u.includes('act_prepared_window')),
    'a prepared dispatch does not block the mission (§8)',
  )
}

{
  // F7. A policy that narrows AFTER the mission started applies to that
  // mission's next action immediately, and pause/cancel stay available (§21,
  // §25.10). Widening again releases the held work.
  let allowLaunch = true
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, {
    capacity: 4,
    policy: () => ({ revision: 'p1', allowLaunch, allowedRepositories: null }),
  })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'f7'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  assert(clients.counts.createSession === 1, 'the mission planned under the wide policy')

  allowLaunch = false
  ctx.supervisor.handleAction(id, 'begin')
  const denied = ctx.supervisor.handleAction(id, 'use_it')
  assert(denied.kind === 'dropped' && denied.reason === 'policy', 'the narrowed policy drops the approval of an older mission')
  const before = clients.counts.createSession
  await settle(ctx, 4000)
  assert(clients.counts.createSession === before, 'the narrowed policy launched nothing')
  const stillPausable = ctx.supervisor.handleAction(id, 'pause')
  await ctx.supervisor.flush()
  assert(stillPausable.kind === 'forwarded' && mission(ctx, id).control === 'paused', 'pausing stays available under a narrowed policy (§21)')
  const resumable = ctx.supervisor.handleAction(id, 'resume')
  await ctx.supervisor.flush()
  assert(resumable.kind === 'forwarded' && mission(ctx, id).control === 'running', 'resuming stays available under a narrowed policy (§21)')

  allowLaunch = true
  const allowed = ctx.supervisor.handleAction(id, 'use_it')
  assert(allowed.kind === 'forwarded', 'widening the policy releases the approval')
  await drive(ctx, () => clients.counts.createSession > before, 30000)
  assert(clients.counts.createSession === before + 1, 'the worker launched after the policy widened')
}

{
  // F8. A launch whose intent write is not acknowledged never goes out, and
  // surfaces as a STORAGE fault, not a provider one (spec §8).
  const kv = new TestKV()
  const failure = new Error('Factory auth failed (401)')
  failure.kind = 'auth'
  const clients = makeClients({ createSessionFailures: [failure] })
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'f8'))).missionId
  await settleAll(ctx)
  assert(
    ctx.supervisor.dispatches.find((d) => d.missionId === id)?.state === 'rejected',
    'the setup rejection is definite, so the retry is allowed',
  )
  kv.failNextSets = 1 // the NEXT commit fails: the retry's dispatch-intent write
  ctx.supervisor.handleAction(id, 'retry')
  await settle(ctx, 4000)
  assert(clients.counts.createSession === 1, 'a launch with no durable intent never reached the provider')
  assert(
    snapshotOf(ctx, id)?.faultKind === 'storage',
    "the unrecorded launch surfaces as the runtime's own storage fault",
  )
  assert(
    String(snapshotOf(ctx, id)?.faultDetail ?? '').includes('no launch was attempted'),
    'the fault says the launch was never attempted',
  )
  assert(
    ctx.supervisor.dispatches.filter((d) => d.missionId === id).every((d) => d.state !== 'unknown'),
    'a launch that never went out leaves no unknown record behind',
  )
}

{
  // F9. Strict head-of-line promotion: a later, smaller waiter never jumps an
  // earlier, larger one — even when it would fit (§25.8).
  const s = new Scheduler(3)
  assert(s.admit('a1', 2) === 'admitted' && s.admit('a2', 1) === 'admitted', 'capacity 3 admits 2 + 1')
  assert(s.admit('big', 3) === 'queued', 'the 3-worker mission waits (nothing fits)')
  assert(s.admit('small', 1) === 'queued', 'the 1-worker mission queues behind it')
  s.release('a1')
  assert(s.promoteNext() === null, 'the small waiter did NOT jump the big head while it did not fit')
  assert(s.isWaiting('small') && s.isWaiting('big'), 'both waiters stayed in arrival order')
  s.release('a2')
  assert(s.promoteNext() === 'big', 'the head is promoted the moment it fits')
  assert(s.isWaiting('small'), 'the next waiter stays queued while capacity is full')
  s.release('big')
  assert(s.promoteNext() === 'small', 'the next waiter follows once capacity frees again')
  assert(!s.isWaiting('small') && !s.isWaiting('big'), 'the queue drained in order')
}

{
  // F10. A repository allowlist narrows LAUNCHES only: a mission already
  // running on a now-disallowed repository can still be paused and cancelled
  // (spec §21 — the owner can always stop work).
  let allowlist = null
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, {
    capacity: 4,
    policy: () => ({ revision: 'p3', allowLaunch: true, allowedRepositories: allowlist }),
    settings: { repository: 'https://github.com/example/other' },
  })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'f10'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  assert(clients.counts.createSession === 1, 'the mission planned before the policy narrowed')

  allowlist = [REPO] // the mission's own repository is now off the list
  const denied = ctx.supervisor.handleAction(id, 'use_it')
  assert(denied.kind === 'dropped' && denied.reason === 'policy', 'the narrowed allowlist drops the launch action')
  const paused = ctx.supervisor.handleAction(id, 'pause')
  await ctx.supervisor.flush()
  assert(paused.kind === 'forwarded' && mission(ctx, id).control === 'paused', 'pausing stays available (§21)')
  const resumed = ctx.supervisor.handleAction(id, 'resume')
  await ctx.supervisor.flush()
  assert(resumed.kind === 'forwarded' && mission(ctx, id).control === 'running', 'resuming stays available (§21)')
  ctx.supervisor.handleAction(id, 'restart')
  const settled = await drive(ctx, () => mission(ctx, id).phase === 'cancelled', 40000)
  assert(settled, 'cancelling stays available under the narrowed allowlist (§21)')
}

// Explicit continuation is a lead-chat request, never a build approval.
for (const refusal of [null, 'policy', 'repository', 'paused', 'cancelling', 'terminal']) {
  let policy = { revision: 'session-continuation', allowLaunch: true, allowedRepositories: null }
  const clients = makeClients()
  const ctx = makeRuntime(new TestKV(), clients, { policy: () => policy })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Continue an existing chat', `continue-${refusal}`))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  const actor = ctx.supervisor.actor(id)
  const saved = actor.snapshot
  Object.assign(saved, { phase: 'plan', awaiting: 'plan', planLabels: [], planProtocol: 'marker-v1' })
  actor.engine.restore(saved)
  actor.engine.clients.getSession = async () => ({ messageCount: 0, status: 'idle' })
  actor.engine.clients.getMessages = async () => []
  await actor.engine.pollLead()
  if (refusal === 'policy') policy.allowLaunch = false
  if (refusal === 'repository') policy.allowedRepositories = []
  if (['paused', 'cancelling', 'terminal'].includes(refusal)) {
    await ctx.supervisor.missionStore.commit(s => ({
      state: { ...s, missions: s.missions.map(m => m.missionId === id ? {
        ...m,
        control: refusal === 'paused' ? 'paused' : 'cancel_requested',
        ...(refusal === 'terminal' ? { phase: 'cancelled' } : {}),
      } : m) },
      events: [],
    }))
  }
  const before = clients.counts.postMessage
  const created = clients.counts.createSession
  const outcome = ctx.supervisor.handleAction(id, 'continue_session')
  await settleAll(ctx)
  if (refusal === null) {
    assert(outcome.kind === 'forwarded' && clients.counts.postMessage === before + 1, 'permitted Continue sends one request to the existing chat')
    assert(actor.snapshot.awaiting === 'plan' && !actor.snapshot.decisionGate, 'Continue neither approves a build nor changes the awaited result')
  } else {
    assert(outcome.kind === 'dropped' && clients.counts.postMessage === before, `${refusal} blocks Continue before any provider message`)
  }
  assert(clients.counts.createSession === created, 'Continue never creates another session or worker')
}

// ----------------------------------------------------- G. decisions and plans
{
  const ctx = makeRuntime(new TestKV(), makeClients(), { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Observe native questions', 'native-accounting'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  const actor = ctx.supervisor.actor(id)
  const engine = actor.engine
  engine.nativeQuestion = { sessionId: engine.sessionId, toolId: 'native-tool', text: 'Which store?' }
  engine.decisionPending = true
  engine.decisionText = 'Which store?'
  engine.decisionOptions = []
  engine.decisionGate = false
  actor.syncDomain()
  await ctx.supervisor.flush()
  const question = ctx.supervisor.decisions.find(d => d.missionId === id && d.answeredAt === null)
  assert(question?.scope === 'factory_native' && question.options.length === 0, 'native questions have no synthetic approval option')
  assert(actor.answerDecision(question.decisionId, 'proceed') === 'unsupported', 'durable phone API rejects approval of a native question')
  ctx.supervisor.say(id, 'Postgres please')
  ctx.supervisor.handleAction(id, 'use_it')
  ctx.supervisor.handleAction(id, 'continue_session')
  await ctx.supervisor.flush()
  assert(engine.nativeQuestion?.toolId === 'native-tool' &&
    ctx.supervisor.decisions.find(d => d.decisionId === question.decisionId).answeredAt === null,
    'ordinary text and approval actions neither answer nor falsely acknowledge a native question')
  engine.nativeQuestion = null
  engine.decisionPending = false
  actor.syncDomain()
  await ctx.supervisor.flush()
  const closed = ctx.supervisor.decisions.find(d => d.decisionId === question.decisionId)
  assert(closed.answeredAt !== null && closed.answerOptionId === null && closed.answerText === null &&
    eventsOf(ctx, 'decision_answered').find(e => e.payload.decisionId === question.decisionId)?.payload.outcome === 'closed',
    'observed provider closure does not invent an app-side answer')
}
for (const input of ['phone', 'text', 'selection']) {
  const ctx = makeRuntime(new TestKV(), makeClients(), { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Preserve legacy answer', `legacy-${input}`))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  const actor = ctx.supervisor.actor(id)
  if (input === 'phone') ctx.supervisor.handleAction(id, 'begin')
  else {
    actor.engine.decisionPending = true
    actor.engine.decisionText = 'Which layout?'
    actor.engine.decisionOptions = ['Compact', 'Wide']
    actor.engine.decisionGate = false
    actor.engine.emitCurrent()
    actor.syncDomain()
  }
  await ctx.supervisor.flush()
  const old = ctx.supervisor.decisions.find((d) => d.missionId === id && d.answeredAt === null)
  await ctx.supervisor.missionStore.commit((s) => ({
    state: { ...s, decisions: s.decisions.map((d) => {
      if (d.decisionId !== old.decisionId) return d
      const { questionIdentity, ...legacy } = d
      return legacy
    }) },
    events: [],
  }))
  assert(ctx.supervisor.decisions.find((d) => d.decisionId === old.decisionId).questionIdentity === undefined, `${input}: fixture is a real legacy record`)
  if (input === 'phone') ctx.supervisor.answerDecision(id, old.decisionId, 'proceed')
  else if (input === 'text') ctx.supervisor.say(id, 'Compact please')
  else ctx.supervisor.chooseDecisionList(id, 0)
  await ctx.supervisor.flush()
  const answered = ctx.supervisor.decisions.find((d) => d.decisionId === old.decisionId)
  assert(answered.answerOptionId !== null || answered.answerText !== null, `${input}: legacy answer retains its actual owner input`)
  assert(eventsOf(ctx, 'decision_answered').find((e) => e.payload.decisionId === old.decisionId)?.payload.outcome === 'answered', `${input}: legacy approval is not mislabeled closed`)
}
{
  const ctx = makeRuntime(new TestKV(), makeClients(), { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Replace pending questions safely', 'replacement'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  const actor = ctx.supervisor.actor(id)
  const engine = actor.engine
  const snapshot = engine.snapshot.bind(engine)
  engine.snapshot = () => ({ ...snapshot(), decisionJob: engine.decisionJob ?? null })
  engine.decisionPending = true
  engine.decisionText = 'Which layout?'
  engine.decisionOptions = ['Compact', 'Wide']
  engine.decisionGate = false
  actor.syncDomain()
  await ctx.supervisor.flush()
  const opened = () => ctx.supervisor.decisions.find((d) => d.missionId === id && d.answeredAt === null)
  const old = opened()
  engine.planLabels = [...engine.planLabels, 'Verify replacement']
  engine.decisionText = 'Start this build?'
  engine.decisionOptions = []
  engine.decisionGate = true
  assert(actor.answerDecision(old.decisionId, 'proceed') === 'stale', 'a replaced live question rejects the old phone answer before a tick')
  actor.syncDomain()
  await ctx.supervisor.flush()
  let current = opened()
  assert(current.decisionId !== old.decisionId && current.revision === mission(ctx, id).planRevision, 'replacement gate opens at the revised plan')
  assert(eventsOf(ctx, 'decision_answered').find((e) => e.payload.decisionId === old.decisionId)?.payload.outcome === 'closed', 'superseded question closes without approval')
  for (const change of [
    () => { engine.planLabels = [...engine.planLabels, 'Verify again'] },
    () => { engine.decisionOptions = ['Proceed', 'Wait'] },
    () => { engine.decisionJob = 0 },
    () => { engine.decisionJob = 1 },
  ]) {
    const previous = current
    actor.syncDomain() // queued old observation must not resurrect its question
    change()
    assert(actor.answerDecision(previous.decisionId, 'proceed') === 'stale', 'revision, options and worker origin invalidate old input before ticks')
    actor.decisionAnswer = { optionId: 'proceed', answerText: 'old answer', outcome: 'answered' }
    actor.syncDomain()
    await ctx.supervisor.flush()
    current = opened()
    assert(current.decisionId !== previous.decisionId && current.revision === mission(ctx, id).planRevision, 'changed decision identity gets a fresh record')
    assert(actor.decisionAnswer === null, 'replacement cannot inherit the previous answer')
  }
  actor.syncDomain()
  await ctx.supervisor.flush()
  assert(opened().decisionId === current.decisionId, 'unchanged question retains its stable identity')
  actor.decisionAnswer = {
    optionId: 'proceed', answerText: 'The actual first answer', outcome: 'answered',
    questionIdentity: current.questionIdentity,
  }
  engine.decisionText = 'The next worker question?'
  actor.syncDomain()
  await ctx.supervisor.flush()
  const answered = ctx.supervisor.decisions.find((d) => d.decisionId === current.decisionId)
  assert(answered.answerText === 'The actual first answer', 'question handoff records the answer against the question actually answered')
  assert(eventsOf(ctx, 'decision_answered').find((e) => e.payload.decisionId === current.decisionId)?.payload.outcome === 'answered', 'answered question is not mislabeled as merely superseded')
  assert(opened().answerText === null, 'next worker question inherits no prior answer')
}
{
  const ctx = makeRuntime(new TestKV(), makeClients(), { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Bind approvals to their plan', 'same-question-new-plan'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  const actor = ctx.supervisor.actor(id)
  actor.engine.decisionPending = true
  actor.engine.decisionText = 'Which layout?'
  actor.engine.decisionOptions = ['Compact', 'Wide']
  actor.engine.decisionGate = false
  actor.engine.emitCurrent()
  actor.syncDomain()
  await ctx.supervisor.flush()
  const old = ctx.supervisor.decisions.find((d) => d.missionId === id && d.answeredAt === null)
  actor.engine.planLabels = [...actor.engine.planLabels, 'Verify the changed plan']
  ctx.supervisor.say(id, 'Compact please')
  await ctx.supervisor.flush()
  const results = eventsOf(ctx, 'decision_answered')
  assert(results.find((e) => e.payload.decisionId === old.decisionId)?.payload.outcome === 'closed', 'new-plan input cannot approve an identical old-plan question')
  assert(results.filter((e) => e.payload.outcome === 'answered').length === 1, 'one owner input creates exactly one answered decision')
  assert(ctx.supervisor.decisions.some((d) => d.missionId === id && d.revision === old.revision + 1 && d.answerText === 'Compact please'), 'the actual answer belongs to the revised plan')
}
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'd1'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  await ctx.supervisor.flush()
  const m = mission(ctx, id)
  assert(m.phase === 'awaiting_decision', 'a pending question moves the mission to awaiting_decision')
  assert(m.suspendedPhase === 'planning', 'the suspended phase is recorded explicitly (§7)')
  const open = ctx.supervisor.decisions.find((d) => d.missionId === id && d.answeredAt === null)
  assert(open !== undefined && open.revision === m.planRevision, 'the decision records the plan revision it belongs to')
  assert(eventsOf(ctx, 'decision_opened').length === 1, 'opening the decision is a durable event')

  await ctx.supervisor.missionStore.commit((s) => ({
    state: {
      ...s,
      missions: s.missions.map((mm) => (mm.missionId === id ? { ...mm, planRevision: mm.planRevision + 1 } : mm)),
    },
    events: [],
  }))
  const stale = ctx.supervisor.answerDecision(id, open.decisionId, 'proceed')
  assert(stale === 'stale', 'a stale decision revision cannot approve a changed plan (§25.9)')
  assert(m2Control(ctx, id) === 'running', 'a rejected answer leaves the mission untouched')

  await ctx.supervisor.missionStore.commit((s) => ({
    state: {
      ...s,
      missions: s.missions.map((mm) => (mm.missionId === id ? { ...mm, planRevision: open.revision } : mm)),
    },
    events: [],
  }))
  const answered = ctx.supervisor.answerDecision(id, open.decisionId, 'proceed')
  assert(answered === 'answered', 'answering by stable option id proceeds')
  await ctx.supervisor.flush()
  assert(eventsOf(ctx, 'decision_answered').length === 1, 'the answer is a durable event')
  const spawned = await drive(ctx, () => clients.counts.createSession >= 2, 30000)
  assert(spawned, 'proceeding from the decision started the build')
  assert(mission(ctx, id).phase !== 'awaiting_decision', 'the mission left awaiting_decision')
}

// ------------------------- G2. approvals journal as approvals, never refusals
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()

  // The HUD button path: use_it at the gate.
  const hud = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'g2:1'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, hud)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(hud, 'begin')
  await ctx.supervisor.flush()
  ctx.supervisor.handleAction(hud, 'use_it')
  await ctx.supervisor.flush()
  const hudAnswer = eventsOf(ctx, 'decision_answered').find((e) => e.payload.decisionId !== undefined)
  assert(
    hudAnswer !== undefined && hudAnswer.payload.outcome === 'answered',
    'an approval via use_it is journaled as answered, not as a refusal',
  )
  const hudRecord = ctx.supervisor.decisions.find((d) => d.missionId === hud)
  assert(hudRecord?.answerOptionId === 'proceed', "the record states the owner's choice ('proceed')")
  const built = await drive(ctx, () => (snapshotOf(ctx, hud)?.jobs ?? []).some((j) => j.state === 'building'), 30000)
  assert(built, 'the approval launched the build')

  // The typed-text path: "yes" at the gate.
  const typed = (await ctx.supervisor.submitCommand(cmd('Deliver the bounds screen', 'g2:2'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, typed)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(typed, 'begin')
  await ctx.supervisor.flush()
  ctx.supervisor.say(typed, 'yes')
  await ctx.supervisor.flush()
  const typedRecord = ctx.supervisor.decisions.find((d) => d.missionId === typed)
  assert(
    typedRecord?.answeredAt !== null && typedRecord?.answerText === 'yes',
    'a typed "yes" is recorded as the owner answering, not as a refusal',
  )
  const typedBuilt = await drive(ctx, () => (snapshotOf(ctx, typed)?.jobs ?? []).some((j) => j.state === 'building'), 30000)
  assert(typedBuilt, 'the typed approval launched the build')
}

// ------------------ G2c. a gate surfaced between ticks is journal-opened by
// ------------------     the tap that answers it (a quick approval never skips)
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4, settings: { askBeforePr: true } })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'g2c'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  await ctx.supervisor.flush()
  await drive(ctx, () => mission(ctx, id).phase === 'awaiting_decision', 30000)
  ctx.supervisor.handleAction(id, 'use_it')
  await ctx.supervisor.flush()
  assert(
    ctx.supervisor.decisions.find((d) => d.missionId === id && d.answeredAt === null) === undefined,
    'the answered start gate left no open record',
  )
  // The build finishes and the PR gate surfaces from a provider reply that
  // lands BETWEEN the actor's ticks: its open record does not exist yet when
  // the owner's tap arrives.
  const gate = await drive(
    ctx,
    () => snapshotOf(ctx, id)?.decisionPending === true && snapshotOf(ctx, id)?.decisionKind === 'pr',
    60000,
  )
  assert(gate, 'the PR gate surfaced')
  assert(
    ctx.supervisor.decisions.find((d) => d.missionId === id && d.answeredAt === null) === undefined,
    'the gate surfaced between ticks, so its record is not open yet (the window a quick tap hits)',
  )
  const tapped = ctx.supervisor.handleAction(id, 'open_pr')
  await settleAll(ctx)
  assert(tapped.kind === 'forwarded', 'the PR approval went through')
  const rec = ctx.supervisor.decisions.find((d) => d.missionId === id && d.scope === 'pr')
  assert(rec !== undefined, 'the quick tap opened the PR gate\'s record before answering it (never skipped the journal)')
  assert(rec.answeredAt !== null, 'the PR approval is journaled')
  assert(rec.answerOptionId === 'proceed' && rec.answerText === null, 'the record states the approval the owner gave')
  const answeredEvents = eventsOf(ctx, 'decision_answered').filter((e) => e.payload.decisionId === rec.decisionId)
  assert(answeredEvents.length === 1 && answeredEvents[0].payload.outcome === 'answered', 'the approval is a durable answered event on its record')
  const prOpened = await drive(ctx, () => (snapshotOf(ctx, id)?.prUrl ?? '') !== '', 60000)
  assert(prOpened, 'the approved PR stage ran')
}

// ---------------------- G2b. option-list answers are attributed durably
{
  const kv = new TestKV()
  const clients = makeClients({
    planQuestion: 'DECISION: Which database?\nOPTIONS: Postgres | SQLite',
  })
  let allowLaunch = true
  const ctx = makeRuntime(kv, clients, {
    capacity: 4,
    policy: () => ({ revision: 'option-policy', allowLaunch, allowedRepositories: null }),
  })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'g2b'))).missionId
  const asked = await drive(ctx, () => (snapshotOf(ctx, id)?.decisionOptions?.length ?? 0) === 2, 30000)
  assert(asked, 'the lead asks a durable option-list question')
  const before = clients.counts.postMessage
  allowLaunch = false
  ctx.supervisor.chooseDecisionList(id, 1)
  await settleAll(ctx)
  assert(
    clients.counts.postMessage === before && snapshotOf(ctx, id)?.decisionPending === true,
    'an option tap cannot bypass a narrowed runtime policy',
  )
  allowLaunch = true
  const answer = ctx.supervisor.chooseDecisionList(id, 1)
  await settleAll(ctx)
  const record = ctx.supervisor.decisions.find((d) => d.missionId === id)
  const event = eventsOf(ctx, 'decision_answered').find((e) => e.missionId === id)
  assert(answer === 'done', 'the selected row answers the lead')
  assert(
    record?.answerText === 'The owner chose: SQLite' &&
      event?.payload.outcome === 'answered' &&
      event?.payload.answerText === 'The owner chose: SQLite',
    'the durable decision records the selected option, not an unattributed close',
  )
}

// ------------- G3. a cancelled mission leaves no decision answerable behind
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'g3'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  await ctx.supervisor.flush()
  const open = ctx.supervisor.decisions.find((d) => d.missionId === id && d.answeredAt === null)
  assert(open !== undefined, 'the gate question is an open, answerable decision')

  ctx.supervisor.handleAction(id, 'restart')
  const settled = await drive(ctx, () => mission(ctx, id).phase === 'cancelled', 40000)
  assert(settled, 'the mission cancels while its question is open')
  const closedRecord = ctx.supervisor.decisions.find((d) => d.decisionId === open.decisionId)
  assert(
    closedRecord?.answeredAt !== null,
    "cancelling closes the open question: it can't stay answerable on a dead mission",
  )
  const closedEvent = eventsOf(ctx, 'decision_answered').find((e) => e.payload.decisionId === open.decisionId)
  assert(
    closedEvent?.payload.outcome === 'closed',
    "the closed question is journaled 'closed', not as an invented refusal or approval",
  )
  assert(
    ctx.supervisor.answerDecision(id, open.decisionId, 'proceed') === 'stale',
    'answering a decision on a cancelled mission is refused as stale',
  )
}

// ------------- G4. a late cancellation never rewrites a finished mission
{
  // The interrupts hang AFTER the PR execution was dispatched; its result
  // finishes anyway. Cancellation must never authorize a new PR dispatch.
  // The terminal record stays
  // completed, and the journal states that the cancellation was superseded
  // (spec §7: a delivered result is never rewritten into a cancellation).
  const kv = new TestKV()
  const clients = makeClients({ interruptGate: true })
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'g4'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  await drive(ctx, () => (snapshotOf(ctx, id)?.jobs ?? []).some((j) => j.stage === 'pr' && j.state === 'building'), 30000)

  ctx.supervisor.handleAction(id, 'restart')
  await ctx.supervisor.flush()
  assert(mission(ctx, id).control === 'cancel_requested', 'the cancellation intent is recorded and pending')
  const finished = await drive(ctx, () => mission(ctx, id).phase === 'completed', 120000, 500)
  assert(finished, 'the run finished while its cancellation requests were still hanging')
  clients.releaseInterrupts()
  // At the PR boundary both the lead and worker can be cancellation targets.
  // Requests are sequential, so let the second request start before releasing
  // it too; releasing only the first would model a still-hanging provider.
  await quiesce()
  clients.releaseInterrupts()
  await settle(ctx, 30000)
  await ctx.supervisor.flush()
  const confirmed = eventsOf(ctx, 'cancel_confirmed')
  assert(confirmed.length === 1, 'the superseded cancellation is confirmed exactly once')
  assert(confirmed[0]?.payload.basis === 'requests_superseded', "the confirmation states it was superseded, not 'accepted'")
  assert(mission(ctx, id).phase === 'completed', 'the completed record was not rewritten into a cancellation')
  assert(mission(ctx, id).control === 'running', 'control settled after the superseded confirmation')
  assert(
    eventsOf(ctx, 'mission_completed').length === 1,
    'the completion stayed in the journal ahead of the cancellation story',
  )
}

// ------------- G5. a refused gate is a recorded refusal, never a silent no-op
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'g5'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  await ctx.supervisor.flush()
  const open = ctx.supervisor.decisions.find((d) => d.missionId === id && d.answeredAt === null)
  assert(open !== undefined, 'the gate question is an open, answerable decision')
  assert(clients.counts.postMessage === 1, 'the lead has only the plan request so far')

  // The owner refuses ("not yet"): the refusal is recorded on the decision
  // and the engine's gate clears; the caller then ends the mission.
  assert(ctx.supervisor.declineGate(id, 'not yet') === true, 'a refusal word at the gate is recognized')
  await settleAll(ctx)
  const record = ctx.supervisor.decisions.find((d) => d.decisionId === open.decisionId)
  const event = eventsOf(ctx, 'decision_answered').find((e) => e.payload.decisionId === open.decisionId)
  assert(
    record?.answeredAt !== null && record?.answerText === 'not yet',
    "the refusal is the decision's answer, recorded as the owner's own words",
  )
  assert(event?.payload.outcome === 'declined', "the refusal is journaled 'declined', never an invented approval or a silent clear")
  assert(snapshotOf(ctx, id)?.decisionPending === false, 'the engine gate cleared with the refusal')
  assert(clients.counts.postMessage === 1, 'the refusal posted nothing to the lead session')
  assert(ctx.supervisor.declineGate(id, 'no') === false, 'a second refusal finds no gate left to refuse')

  // The caller ends the refused mission (the restart path): the record closes
  // as the recorded refusal, and the mission is honestly terminal.
  ctx.supervisor.handleAction(id, 'restart')
  const settled = await drive(ctx, () => mission(ctx, id).phase === 'cancelled', 40000)
  assert(settled, 'the refused mission ends on the record instead of sitting at a plan that can never start')
  const finalRecord = ctx.supervisor.decisions.find((d) => d.decisionId === open.decisionId)
  assert(finalRecord?.answerText === 'not yet', 'cancelling never rewrites the recorded refusal')
  assert(eventsOf(ctx, 'decision_answered').filter((e) => e.missionId === id).length === 1, 'the decision answer is journaled exactly once')

  // A lead question (no gate) is answered, never "declined": only the gate —
  // the mission's only start/finish action — ends a mission by refusal.
  const kvQ = new TestKV()
  const clientsQ = makeClients({ planQuestion: 'DECISION: Which database?\nOPTIONS: Postgres | SQLite' })
  const ctxQ = makeRuntime(kvQ, clientsQ, { capacity: 4 })
  await ctxQ.supervisor.boot()
  const q = (await ctxQ.supervisor.submitCommand(cmd('Deliver the bounds screen', 'g5:q'))).missionId
  const asked = await drive(ctxQ, () => snapshotOf(ctxQ, q)?.decisionPending === true, 30000)
  assert(asked, 'the lead asks a mid-plan question (no gate behind it)')
  assert(ctxQ.supervisor.declineGate(q, 'no') === false, 'a lead question is answered to the lead, never declined away')
  const postsBefore = clientsQ.counts.postMessage
  const where = ctxQ.supervisor.say(q, 'No, skip storage entirely')
  await settleAll(ctxQ)
  assert(where === 'decision', "the owner's words reach the lead as the answer")
  assert(clientsQ.counts.postMessage > postsBefore, 'the answer was posted to the lead session')
  const qRecord = ctxQ.supervisor.decisions.find((d) => d.missionId === q)
  assert(
    qRecord?.answeredAt !== null && qRecord?.answerText === 'No, skip storage entirely',
    'the lead question records the answer, not a refusal',
  )
}

// -------------------------------------------------- H. migration and epochs
{
  const kv = new TestKV()
  const clients = makeClients()
  kv.map.set(
    'sprite.factory.v1',
    JSON.stringify({
      v: 1,
      engine: {
        v: 1,
        real: true,
        phase: 'building',
        goal: 'Deliver the migrated screen',
        sessionId: 'sess-v1',
        repoUrl: REPO,
        missionRepo: REPO,
        workerPref: 'auto',
        jobCount: 2,
        jobs: [
          {
            label: 'Job one',
            mode: 'session',
            stage: 'build',
            sessionId: 'sess-v1-worker',
            state: 'building',
            branch: 'spriite/job-1',
            weight: 40,
          },
        ],
      },
    }),
  )
  kv.map.set(
    'spriite.projects.v1',
    JSON.stringify({ v: 1, projects: [{ goal: 'Ship the migrated login fix', status: 'building', snapshot: null }] }),
  )
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  const boot = await ctx.supervisor.boot()
  assert(boot.migration.migrated && boot.missionCount === 2, 'v1 records import as two missions (§22)')
  assert(boot.epoch === 1, 'the migration boot is epoch 1')
  const migrated = ctx.supervisor.missions.find((m) => m.goal === 'Deliver the migrated screen')
  assert(migrated.config.workerPreference === 'auto', 'the v1 worker preference is preserved, not reinterpreted')
  assert(migrated.config.maxConcurrentWorkers === 2, 'the v1 split count is frozen with the mission')
  assert(mission(ctx, migrated.missionId).control === 'running', 'migrated missions restore their control mode')
  const actor = ctx.supervisor.actor(migrated.missionId)
  assert(actor.restoreRefused === false, 'the migrated engine snapshot was adopted')
  assert(snapshotOf(ctx, migrated.missionId).sessionId === 'sess-v1', 'the migrated mission resumes its v1 session')
  assert(
    mission(ctx, migrated.missionId).activeRunIds.length >= 1,
    'migrated provider runs are first-class run records',
  )

  const ctx2 = makeRuntime(kv, clients, { capacity: 4, settings: { workerPref: 'mix', jobs: 4, repository: 'https://github.com/example/other' } })
  const boot2 = await ctx2.supervisor.boot()
  assert(boot2.migration.migrated === false, 'the migration marker makes it one-time and idempotent')
  assert(ctx2.supervisor.missions.length === 2, 'no mission was imported twice')
  assert(boot2.epoch === 2, 'the second boot took epoch 2')
  assert(
    boot2.restoreRefused.length === 0,
    'changed global preferences do not prevent restoring an existing mission (§25.6)',
  )
}

// --------------------------------------------------- I. cancel honesty
{
  const kv = new TestKV()
  const clients = makeClients({ interruptFails: true })
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'x9'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  await drive(ctx, () => (snapshotOf(ctx, id)?.jobs ?? []).some((j) => j.state === 'building'), 30000)
  await ctx.supervisor.flush()

  ctx.supervisor.handleAction(id, 'restart')
  await ctx.supervisor.flush()
  assert(eventsOf(ctx, 'cancel_requested').length === 1, 'cancel records its intent before acting')
  const settled = await drive(ctx, () => mission(ctx, id).phase === 'cancelled', 40000)
  assert(settled, 'the mission reaches the terminal cancelled phase')
  const confirmed = ctx.supervisor.missionStore.events.filter((e) => e.type === 'cancel_confirmed')
  assert(confirmed.length === 1, 'the cancellation confirmation is recorded once')
  assert(confirmed[0].payload.basis === 'requests_partial', 'a refused cancellation is recorded as partial, not as success')
  assert(
    Array.isArray(confirmed[0].payload.unresolved) && confirmed[0].payload.unresolved.length > 0,
    'the unresolved remainder is preserved on the confirmation',
  )
  assert(
    String(confirmed[0].payload.note).includes('may still be running'),
    'the record never claims all work stopped without confirmation (§7)',
  )
  assert(
    ctx.supervisor.handleAction(id, 'use_it').kind === 'dropped',
    'a cancelled mission takes no further launch actions',
  )
  assert(clients.counts.interrupt >= 1, 'a cancellation request was actually sent to the provider')

  // A double-tap restart cannot double the cancellation round: the intent is
  // a compare-and-set, so the second tap declines and nothing re-sends.
  const id2 = (await ctx.supervisor.submitCommand(cmd('Deliver the bounds screen', 'i2'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id2)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id2, 'begin')
  ctx.supervisor.handleAction(id2, 'use_it')
  await drive(ctx, () => (snapshotOf(ctx, id2)?.jobs ?? []).some((j) => j.state === 'building'), 60000, 500)
  await settleAll(ctx)
  const cancellationSessions = new Set([
    snapshotOf(ctx, id2).sessionId,
    ...snapshotOf(ctx, id2).jobs.map(j => j.sessionId),
  ].filter(Boolean))
  const interruptsBefore = clients.counts.interrupt
  ctx.supervisor.handleAction(id2, 'restart')
  ctx.supervisor.handleAction(id2, 'restart') // before the first intent lands
  await settleAll(ctx)
  await drive(ctx, () => mission(ctx, id2).phase === 'cancelled', 40000)
  assert(
    eventsOf(ctx, 'cancel_requested').filter((e) => e.missionId === id2).length === 1,
    'a double-tap restart journals one cancellation intent, not two',
  )
  assert(
    clients.counts.interrupt === interruptsBefore + cancellationSessions.size,
    'one round cancels both lead and worker sessions without double-tap duplicates',
  )
}

// --------------- I2. a restart mid-cancellation re-asks, never invents (§7)
{
  // Generation 1 records the cancellation intent and sends its interrupt
  // request; the provider never answers (the gate holds it). Generation 2
  // boots while the request is still in flight: its bookkeeping is fresh,
  // so it must re-ask the provider — a confirmation that "requests were
  // accepted" from a generation that never sent one would be invented, and
  // a fresh-settled actor could otherwise confirm with no request at all.
  const kv = new TestKV()
  const clients = makeClients({ interruptGate: true })
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'x10'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  await drive(ctx, () => (snapshotOf(ctx, id)?.jobs ?? []).some((j) => j.state === 'building'), 30000)
  await ctx.supervisor.flush()
  const runId = mission(ctx, id).activeRunIds[0]
  assert(typeof runId === 'string' && runId !== '', 'a live run is there to cancel')

  ctx.supervisor.handleAction(id, 'restart')
  await ctx.supervisor.flush()
  assert(mission(ctx, id).control === 'cancel_requested', 'the cancellation intent is durable and pending')
  const interruptsBefore = clients.counts.interrupt
  assert(interruptsBefore >= 1, 'generation 1 sent its cancellation request')
  const restoreCancellationSessions = new Set([
    snapshotOf(ctx, id).sessionId,
    ...snapshotOf(ctx, id).jobs.map(j => j.sessionId),
  ].filter(Boolean))

  // The restart: a fresh supervisor over the same durable state, while the
  // first generation's request is still hanging.
  const ctx2 = makeRuntime(kv, clients, { capacity: 4 })
  ctx2.clock.now = ctx.clock.now
  const boot2 = await ctx2.supervisor.boot()
  assert(boot2.restoreRefused.length === 0, 'the cancelled-request mission restored cleanly')
  assert(mission(ctx2, id).control === 'cancel_requested', 'the intent outlives the restart')
  await ctx2.supervisor.flush()
  assert(
    clients.counts.interrupt === interruptsBefore + restoreCancellationSessions.size,
    'the new generation re-asks every known lead and worker cancellation (§7, §8)',
  )

  // The provider finally answers: the confirmation states this generation's
  // own observed outcome, once.
  clients.releaseInterrupts()
  const settled = await drive(ctx2, () => mission(ctx2, id).phase === 'cancelled', 40000)
  assert(settled, 'the re-asked cancellation settles to the terminal phase')
  const confirmed = ctx2.supervisor.missionStore.events.filter((e) => e.type === 'cancel_confirmed')
  assert(confirmed.length === 1, 'the cancellation confirmation is recorded once across generations')
  assert(confirmed[0].payload.basis === 'requests_accepted', 'the confirmation states the basis this generation observed')
  assert(
    Array.isArray(confirmed[0].payload.requestedRuns) && confirmed[0].payload.requestedRuns.includes(runId),
    'the record names the run it asked the provider to stop',
  )
  assert(mission(ctx2, id).phase === 'cancelled', 'the mission is terminal')
}

// --------------------------- Z. the inbox projects X intake's own facts
// buildInbox is the phone projection's honest health line (spec §11):
// "configured" is the store's binding fact, and the check time is the
// store's last-check fact — "never checked" stays its own state, never
// "no requests". A hardcoded phase marker would say "not configured" while
// intake runs, which is a lie the phone could repeat.
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients)
  await ctx.supervisor.boot()
  const fresh = ctx.supervisor.getInbox()
  assert(
    fresh.health.intake.configured === false && fresh.health.intake.lastCheckAt === null,
    'a store with no X binding projects "not configured" and "never checked", its own states',
  )
  const ok = await ctx.supervisor.missionStore.commit((s) => ({
    state: {
      ...s,
      xIntake: {
        binding: {
          ownerXUserId: '1758000001', ownerHandle: 'owner', spriiteXUserId: '1758000002', spriiteHandle: 'spriite',
          verifiedAt: '2026-10-08T01:00:00.000Z', verification: 'users_me', credentialRef: 'ref-1',
          enabled: true, protectedOwner: false,
        },
        lastCheckedAt: '2026-10-08T01:05:00.000Z',
        lastSuccessAt: null, lastError: null, lastReceivedAt: null, lastReceivedPostId: null,
        receipts: [], gaps: [], rejectedCount: 0,
      },
    },
    events: [],
  }))
  assert(ok.ok === true, 'the xIntake facts are committed through the store')
  const bound = ctx.supervisor.getInbox()
  assert(
    bound.health.intake.configured === true && bound.health.intake.lastCheckAt === '2026-10-08T01:05:00.000Z',
    'a bound, checked intake projects its own facts: configured, and when it last checked',
  )
}

// ------------- X. a start the owner already approved builds without a glasses tap
// The owner's report: an X build "just gave the plan but didn't start the
// build". Every mission stopped on Plan ready / Start build, and nobody is at
// the glasses for a post. An approved start launches once the plan lands —
// still through the scheduler, still stopped by a pause.
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const approved = (await ctx.supervisor.submitCommand({ ...cmd('Deliver the empty-state screen', 'xa:1'), startApproved: true })).missionId
  const plain = (await ctx.supervisor.submitCommand(cmd('Deliver the settings screen', 'xa:2'))).missionId
  assert(mission(ctx, approved)?.config.startApproved === true, 'the approval is a durable fact on the mission')
  assert(mission(ctx, plain)?.config.startApproved === undefined, 'a phone goal carries no approval')
  await ctx.supervisor.flush()
  await drive(ctx, () => (snapshotOf(ctx, plain)?.planLabels.length ?? 0) > 0, 30000)
  const launched = await drive(ctx, () => spawned(ctx, approved), 30000)
  assert(launched, 'an approved mission starts its build when the plan lands, with no Start tap')
  await settle(ctx, 6000)
  assert(!spawned(ctx, plain), 'an unapproved mission still waits on Plan ready')
}
{
  // Paused before the plan lands: the approval waits for Resume.
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand({ ...cmd('Deliver the empty-state screen', 'xa:3'), startApproved: true })).missionId
  await ctx.supervisor.flush()
  await drive(ctx, () => (snapshotOf(ctx, id)?.sessionId ?? null) !== null, 30000)
  ctx.supervisor.handleAction(id, 'pause')
  await ctx.supervisor.flush()
  await settle(ctx, 8000)
  assert(!spawned(ctx, id), 'a paused approved mission launches no worker')
  ctx.supervisor.handleAction(id, 'resume')
  await ctx.supervisor.flush()
  const resumed = await drive(ctx, () => spawned(ctx, id), 30000)
  assert(resumed, 'after Resume the approved build starts')
}
{
  // Capacity: an approved mission waiting for a slot never launches past
  // the scheduler; it starts when the slot frees.
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 1 })
  await ctx.supervisor.boot()
  const first = (await ctx.supervisor.submitCommand(cmd('Goal one', 'xa:4'))).missionId
  const queued = (await ctx.supervisor.submitCommand({ ...cmd('Goal two', 'xa:5'), startApproved: true })).missionId
  ctx.clock.now = 2000
  ctx.supervisor.tick(2000)
  await ctx.supervisor.flush()
  await drive(ctx, () => (snapshotOf(ctx, queued)?.planLabels.length ?? 0) > 0, 30000)
  await settle(ctx, 6000)
  assert(
    !spawned(ctx, queued),
    'an approved mission without capacity launches no worker',
  )
  ctx.supervisor.handleAction(first, 'pause')
  await ctx.supervisor.flush()
  const freed = await drive(ctx, () => spawned(ctx, queued), 60000)
  assert(freed, 'when capacity frees, the approved mission starts its build')
}

{
  // A saved unapproved plan is not four running workers. Reopening the
  // app must not let that old plan starve an explicitly approved X build.
  const kv = new TestKV()
  const clients = makeClients()
  const first = makeRuntime(kv, clients, { capacity: 4, settings: { jobs: 4 } })
  await first.supervisor.boot()
  const old = (await first.supervisor.submitCommand(cmd('Prepare the old project', 'saved-plan:1'))).missionId
  await drive(first, () => (snapshotOf(first, old)?.planLabels.length ?? 0) > 0, 30000)
  await settleAll(first)
  const reopened = makeRuntime(kv, clients, { capacity: 4 })
  await reopened.supervisor.boot()
  assert(!reopened.supervisor.schedulerState.admitted.includes(old), 'a restored unapproved plan with no workers reserves no worker slots')
  const next = (await reopened.supervisor.submitCommand({
    ...cmd('Implement the new project', 'saved-plan:2'), source: 'x', startApproved: true,
  })).missionId
  assert(await drive(reopened, () => spawned(reopened, next), 30000), 'the newest approved build starts without cancelling an older saved plan')
  assert(!spawned(reopened, old), 'the old plan stays saved without silently starting')
  assert(!isTerminalOld(reopened, old), 'freeing stale reservations preserves the old build')
  reopened.supervisor.handleAction(old, 'begin')
  reopened.supervisor.handleAction(old, 'use_it')
  assert(
    reopened.supervisor.schedulerState.admitted.includes(old) || reopened.supervisor.schedulerState.waiting.includes(old),
    'explicitly starting a saved plan requests capacity again',
  )
}

{
  const kv = new TestKV()
  const clients = makeClients()
  const first = makeRuntime(kv, clients, { capacity: 4, settings: { jobs: 4 } })
  await first.supervisor.boot()
  const old = (await first.supervisor.submitCommand(cmd('The previously faulted X build', 'saved-fault:1'))).missionId
  await drive(first, () => (snapshotOf(first, old)?.planLabels.length ?? 0) > 0, 30000)
  await settleAll(first)
  const snap = snapshotOf(first, old)
  await first.supervisor.missionStore.commit((s) => ({
    state: {
      ...s,
      missions: s.missions.map((m) => m.missionId === old ? { ...m, config: { ...m.config, startApproved: true } } : m),
      engineSnapshots: { ...s.engineSnapshots, [old]: { ...snap, faultKind: 'service' } },
    },
    events: [],
  }))
  const reopened = makeRuntime(kv, clients, { capacity: 4 })
  await reopened.supervisor.boot()
  await settle(reopened, 6000)
  assert(!reopened.supervisor.schedulerState.admitted.includes(old), 'automatic checks never reclaim slots for a restored faulted approved plan')
  const next = (await reopened.supervisor.submitCommand({
    ...cmd('The new X build after a provider fault', 'saved-fault:2'), source: 'x', startApproved: true,
  })).missionId
  assert(await drive(reopened, () => spawned(reopened, next), 30000), 'an old faulted X plan cannot block the latest approved build')
}

// Existing Factory sessions still execute work: an automatic FAIL repair or
// PASS integration/PR must cross the same final authority gate as Cursor runs.
for (const stage of ['fix', 'integration', 'pr']) {
  for (const refusal of ['policy', 'repository', 'paused', 'cancelling', 'capacity']) {
    let policy = { revision: 'worker-authority', allowLaunch: true, allowedRepositories: null }
    const clients = makeClients()
    const posts = []
    const post = clients.postMessage
    clients.postMessage = async (id, text, computer) => {
      posts.push({ id, text })
      return post(id, text, computer)
    }
    const ctx = makeRuntime(new TestKV(), clients, {
      capacity: 4, policy: () => policy,
      settings: { jobs: stage === 'integration' ? 2 : 1, askBeforePr: false },
    })
    await ctx.supervisor.boot()
    const id = (await ctx.supervisor.submitCommand(cmd(`Gate ${stage} ${refusal}`, `worker-gate:${stage}:${refusal}`))).missionId
    await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
    ctx.supervisor.handleAction(id, 'begin')
    ctx.supervisor.handleAction(id, 'use_it')
    await drive(ctx, () => (snapshotOf(ctx, id)?.jobs ?? []).every((j) => !!j.sessionId) &&
      (snapshotOf(ctx, id)?.jobs.length ?? 0) > 0, 30000)
    const actor = ctx.supervisor.actor(id)
    const engine = actor.engine
    const admitted = actor.canLaunch
    const sessionsBefore = clients.counts.createSession
    const workerIds = engine.jobs.map((j) => j.sessionId)
    engine.jobs.forEach((j, i) => {
      j.branch = engine.missionBranch(`job-${i + 1}`)
      j.state = i === 0 ? 'review' : 'accepted'
      j.stage = 'build'
    })
    engine.reviewQueue = []
    engine.verdictJob = 0
    engine.verdictToken = 'worker-authority'
    engine.awaiting = 'verdict'
    engine.phase = 'review'
    engine.busy = false
    if (refusal === 'policy') policy = { ...policy, allowLaunch: false }
    if (refusal === 'repository') policy = { ...policy, allowedRepositories: ['https://github.com/other/repo'] }
    // Exercise the admission callback independently of policy/control: it is
    // the scheduler's existing boolean contract, not a new capacity budget.
    if (refusal === 'capacity') actor.canLaunch = () => false
    if (refusal === 'paused' || refusal === 'cancelling') {
      await ctx.supervisor.missionStore.commit((s) => ({
        state: { ...s, missions: s.missions.map((m) => m.missionId === id
          ? { ...m, control: refusal === 'paused' ? 'paused' : 'cancel_requested' } : m) },
        events: [],
      }))
    }
    const execution = () => posts.filter((p) => /Fix the findings|Merge these branches|Open a pull request/.test(p.text))
    const before = execution().length
    engine.handleReply(`VERDICT: ${stage === 'fix' ? 'FAIL Fix the bounds.' : 'PASS'}\nREQUEST: worker-authority\nVERDICT_READY`)
    await quiesce()
    const expectedFault = refusal === 'repository' ? 'policy' : refusal
    assert(execution().length === before, `${refusal} suppresses automatic Factory ${stage} execution`)
    assert(engine.faultKind === expectedFault && engine.faultRetry === stage,
      `${refusal} leaves a recoverable ${stage} refusal, not an unknown launch`)
    assert(clients.counts.createSession === sessionsBefore, `${stage} refusal never creates replacement workers`)
    // A coordinator POST is still a write that can trigger execution. Its
    // apparent read-only wording cannot bypass the same final authority gate.
    const notesBefore = posts.length
    let refusedNote = false
    try { await engine.clients.postMessage(engine.sessionId, 'Observation-only note') }
    catch (error) { refusedNote = ['policy', 'paused', 'cancelling', 'capacity'].includes(error.kind) }
    assert(refusal === 'capacity'
      ? !refusedNote && posts.length === notesBefore + 1
      : refusedNote && posts.length === notesBefore,
      refusal === 'capacity' ? 'existing coordinator conversation is capacity-exempt, without starting a worker'
        : 'coordinator messages cannot bypass a narrowed policy, pause or cancellation barrier')
    policy = { revision: 'worker-authority', allowLaunch: true, allowedRepositories: null }
    actor.canLaunch = admitted
    await ctx.supervisor.missionStore.commit((s) => ({
      state: { ...s, missions: s.missions.map((m) => m.missionId === id ? { ...m, control: 'running' } : m) },
      events: [],
    }))
    actor.retryRefusedStep()
    await quiesce()
    assert(execution().length === before + 1 && execution().at(-1).id === workerIds[0],
      `permitted ${stage} recovery executes once in the original worker session`)
    actor.retryRefusedStep()
    await quiesce()
    assert(execution().length === before + 1 && clients.counts.createSession === sessionsBefore,
      `${stage} recovery cannot duplicate the execution or worker jobs`)
    if (stage === 'integration') assert(execution().at(-1).text.includes(engine.missionBranch('job-1')) &&
      execution().at(-1).text.includes(engine.missionBranch('job-2')), 'integration retry retains both originally reviewed branches')
    assert(await drive(ctx, () => mission(ctx, id)?.phase === 'completed', 60000),
      `${refusal} ${stage} recovery reaches a valid reviewed PR completion`)
    assert(clients.counts.createSession === sessionsBefore &&
      engine.jobs.every((j, i) => j.sessionId === workerIds[i]),
      `${refusal} ${stage} completion preserves the original workers`)
  }
}

// An unsent repair retry is execution too; it cannot bypass a newly narrowed
// policy when the first send was refused before transport. Network
// acknowledgment loss is held instead, covered by the team delivery suite.
{
  let allowed = true
  const clients = makeClients()
  const post = clients.postMessage
  let attempts = 0
  clients.postMessage = async (id, text, computer) => {
    if (/Fix the findings/.test(text) && ++attempts === 1) {
      throw Object.assign(new Error('Execution refused before provider dispatch'), { kind: 'policy', notDispatched: true })
    }
    return post(id, text, computer)
  }
  const ctx = makeRuntime(new TestKV(), clients, {
    policy: () => ({ revision: 'pending-worker', allowLaunch: allowed, allowedRepositories: null }),
  })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Repair with deferred delivery', 'pending-worker'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  await drive(ctx, () => !!snapshotOf(ctx, id)?.jobs[0]?.sessionId, 30000)
  const actor = ctx.supervisor.actor(id)
  const e = actor.engine
  const j = e.jobs[0]
  j.branch = e.missionBranch('job-1')
  j.state = 'review'
  e.verdictJob = 0
  e.verdictToken = 'pending-repair'
  e.awaiting = 'verdict'
  e.handleReply('VERDICT: FAIL Fix bounds.\nREQUEST: pending-repair\nVERDICT_READY')
  await quiesce()
  assert(attempts === 1 && e.faultKind === 'policy' && e.faultRetry === 'fix',
    'pre-send refusal retains a classified unsent repair execution')
  const sessions = clients.counts.createSession
  allowed = false
  actor.retryRefusedStep()
  await quiesce()
  assert(attempts === 1 && e.faultKind === 'policy' && e.faultRetry === 'fix',
    'pending repair retry respects current policy before any provider call')
  allowed = true
  actor.retryRefusedStep()
  await quiesce()
  assert(attempts === 2 && !j.pendingPrompt && clients.counts.createSession === sessions,
    'permitted pending repair recovery posts once without replacing the worker')
}

// Revoke authority while the actual KV write of the sending intent is
// suspended. The provider must not inherit permission from before that await.
for (const kind of ['factory.session', 'factory.worker_session', 'cursor.agent', 'cursor.run', 'github.repo']) {
  for (const { refusal, failSending } of ['policy', 'paused', 'cancelling', 'capacity'].flatMap((refusal) =>
    [{ refusal, failSending: false }, { refusal, failSending: true }])) {
    // Lead sessions are deliberately exempt from worker admission.
    if (kind === 'factory.session' && refusal === 'capacity') continue
    const kv = new TestKV()
    const clients = makeClients()
    let allowed = true
    const ctx = makeRuntime(kv, clients, {
      policy: () => ({ revision: 'last-dispatch', allowLaunch: allowed, allowedRepositories: null }),
    })
    await ctx.supervisor.boot()
    const id = (await ctx.supervisor.submitCommand(cmd(`Deferred ${kind}`, `dispatch-race:${kind}:${refusal}`))).missionId
    await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
    ctx.supervisor.handleAction(id, 'begin')
    ctx.supervisor.handleAction(id, 'use_it')
    await drive(ctx, () => !!snapshotOf(ctx, id)?.jobs[0]?.sessionId, 30000)
    const actor = ctx.supervisor.actor(id)
    const admission = actor.canLaunch
    const wrapped = actor.engine.clients
    const countName = kind.startsWith('factory.') ? 'createSession' :
      kind === 'cursor.agent' ? 'cursorAgent' : kind === 'cursor.run' ? 'cursorRun' : 'createRepo'
    const invoke = () => kind === 'factory.session' ? wrapped.createSession({ computerId: 'comp-1' }) :
      kind === 'factory.worker_session' ? wrapped.createWorkerSession({ computerId: 'comp-1' }) :
      kind === 'cursor.agent' ? wrapped.cursorAgent('Deferred build', REPO) :
      kind === 'cursor.run' ? wrapped.cursorRun('test-agent', 'Deferred repair') :
      wrapped.createRepo('deferred-dispatch', true)
    let release
    let entered
    const waiting = new Promise((resolve) => { entered = resolve })
    const gate = new Promise((resolve) => { release = resolve })
    const set = kv.set.bind(kv)
    let held = false
    kv.set = async (key, value) => {
      let envelope
      try { envelope = JSON.parse(value) } catch {}
      if (!held && key.endsWith('.0') && envelope?.state?.outbox?.some((d) =>
        d.missionId === id && d.requestKey.includes(`:${kind}:`) && d.state === 'sending')) {
        held = true
        entered()
        await gate
      }
      return set(key, value)
    }
    const before = clients.counts[countName]
    const result = invoke().then(() => null, (e) => e)
    await waiting
    if (refusal === 'policy') allowed = false
    if (refusal === 'paused') actor.pause()
    if (refusal === 'cancelling') actor.cancel()
    if (refusal === 'capacity') actor.canLaunch = () => false
    if (failSending) kv.failNextSets = 1
    release()
    const error = await result
    await quiesce()
    const attempts = ctx.supervisor.missionStore.current.outbox.filter((d) =>
      d.missionId === id && d.requestKey.includes(`:${kind}:`))
    assert(clients.counts[countName] === before,
      `${refusal} during ${failSending ? 'failed' : 'acknowledged'} sending KV commit prevents ${kind} dispatch`)
    assert(error && error.name !== 'DispatchUnknownError' &&
      attempts.at(-1)?.state === (failSending ? 'prepared' : 'rejected'),
      `known-unlaunched ${kind} stays safe, never unknown`)
    if (failSending) {
      // A failed KV write stops the store. Do not pretend cleanup was durable:
      // its previously acknowledged prepared intent is safe on reload.
      await ctx.supervisor.missionStore.reload()
      const warnings = await ctx.supervisor.outboxValue.recoverInFlight()
      assert(warnings.length === 0 && ctx.supervisor.missionStore.current.outbox.filter((d) =>
        d.missionId === id && d.requestKey.includes(`:${kind}:`)).at(-1)?.state === 'rejected',
        'failed sending write reloads as safe unlaunched work, not an unknown provider call')
    }
    if (refusal !== 'cancelling') {
      allowed = true
      actor.canLaunch = admission
      if (refusal === 'paused') {
        await actor.flush()
        actor.resume()
        await actor.flush()
      }
      await invoke()
      assert(clients.counts[countName] === before + 1, `permitted ${kind} retry dispatches exactly once`)
    } else {
      assert(clients.counts[countName] === before, `cancelled ${kind} never dispatches a replacement`)
    }
  }
}

// A worker CREATE can land under permission and resolve after permission
// changes. Its first executable message needs its OWN last-moment check.
for (const refusal of ['policy', 'paused', 'cancelling', 'capacity']) {
  const clients = makeClients()
  let release
  let entered
  const waiting = new Promise((resolve) => { entered = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const create = clients.createSession
  clients.createSession = async (opts) => {
    const result = await create(opts)
    if (clients.counts.createSession === 2) { entered(); await gate }
    return result
  }
  const posts = []
  const post = clients.postMessage
  clients.postMessage = async (id, text, computer) => { posts.push({ id, text }); return post(id, text, computer) }
  let allowed = true
  const ctx = makeRuntime(new TestKV(), clients, {
    policy: () => ({ revision: 'first-build', allowLaunch: allowed, allowedRepositories: null }),
  })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deferred initial build', `initial-build:${refusal}`))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  await waiting
  const actor = ctx.supervisor.actor(id)
  const admission = actor.canLaunch
  if (refusal === 'policy') allowed = false
  if (refusal === 'paused') actor.pause()
  if (refusal === 'cancelling') actor.cancel()
  if (refusal === 'capacity') actor.canLaunch = () => false
  await quiesce()
  release()
  await quiesce()
  const e = actor.engine
  const worker = e.jobs[0].sessionId
  const builds = () => posts.filter((p) => p.id === worker && /Your job/.test(p.text))
  assert(builds().length === 0, `${refusal} after worker create prevents its initial build instruction`)
  assert(!!worker && !!e.jobs[0].pendingPrompt && !!e.faultKind,
    'created worker and unposted instruction remain available without a replacement CREATE')
  const saved = JSON.parse(JSON.stringify(e.snapshot()))
  // A restored queue must be safe even before a local fault/pause flag is
  // reasserted: the runtime's current authority is the final source of truth.
  saved.faultKind = null
  saved.faultRetry = null
  saved.paused = false
  e.restore(saved)
  e.retryPendingPrompts()
  await quiesce()
  assert(builds().length === 0, 'restored pending build cannot bypass the current execution gate')
  assert(!!e.jobs[0].pendingPrompt && !!e.faultKind,
    'refused restored build retains its exact instruction for safe recovery')
  if (refusal !== 'cancelling') {
    allowed = true
    actor.canLaunch = admission
    if (refusal === 'paused') { await actor.flush(); actor.resume(); await actor.flush() }
    actor.retryRefusedStep()
    await quiesce()
    e.retryPendingPrompts()
    await quiesce()
    assert(builds().length === 1 && clients.counts.createSession === 2 &&
      e.jobs[0].sessionId === worker, 'permitted initial-build retry uses one instruction and the original worker')
    actor.retryRefusedStep()
    e.retryPendingPrompts()
    await quiesce()
    assert(builds().length === 1, 'initial build recovery cannot duplicate its instruction')
  }
}

{
  let allowed = true
  let loseNextResultAck = false
  const clients = makeClients()
  const posts = []
  const postDestinations = []
  const executions = []
  const post = clients.postMessage
  clients.postMessage = async (id, text, computer) => {
    posts.push(text)
    postDestinations.push({ id, computer })
    if (loseNextResultAck && /^Report the result of your existing /.test(text)) {
      loseNextResultAck = false
      throw Object.assign(new Error('Result-query acknowledgment lost'), { kind: 'timeout' })
    }
    await post(id, text, computer)
    const reply = clients.sessions.get(id)?.msgs.at(-1)
    if (/^Report the result of your existing /.test(text) && reply?.text.startsWith('Still waiting for the existing result.')) {
      // A progress response has no completion terminator or fabricated
      // SUMMARY/BRANCH artifact. The task remains in flight.
      reply.text = 'Still waiting for the existing result.'
    }
  }
  clients.postWorkerExecution = async (id, text, stage, computer) => {
    executions.push(stage)
    return clients.postMessage(id, text, computer)
  }
  const ctx = makeRuntime(new TestKV(), clients, {
    policy: () => ({ revision: 'legacy-build', allowLaunch: allowed, allowedRepositories: null }),
  })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Legacy queued build', 'legacy-build'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  await drive(ctx, () => !!snapshotOf(ctx, id)?.jobs[0]?.sessionId, 30000)
  const e = ctx.supervisor.actor(id).engine
  const saved = JSON.parse(JSON.stringify(e.snapshot()))
  saved.jobs[0].pendingPrompt = clients.sessions.get(saved.jobs[0].sessionId).msgs[0].text
  // This recovery fixture has no completed result to reconcile by GET.
  // Keep the original user request, but model its missing provider reply.
  const workerHistory = clients.sessions.get(saved.jobs[0].sessionId)
  workerHistory.msgs = workerHistory.msgs.filter(message => message.role === 'user')
  workerHistory.count = workerHistory.msgs.length
  delete saved.jobs[0].requestToken
  e.restore(saved)
  allowed = false
  const beforePosts = posts.length
  const beforeExecutions = executions.length
  e.retryPendingPrompts()
  await quiesce()
  assert(posts.length === beforePosts && e.needsResponseRefresh(), 'legacy queued build is not blindly executed on restore')
  await e.refreshResponses()
  assert(posts.length === beforePosts && e.needsResponseRefresh(),
    'a result-only coordinator turn still respects the narrowed launch policy')
  const deferred = JSON.parse(JSON.stringify(e.snapshot()))
  const query = deferred.jobs[0].pendingPrompt
  const queryToken = deferred.jobs[0].requestToken
  assert(query.startsWith('Report the result of your existing build') &&
    query.includes(`"REQUEST: ${queryToken}"`) && query !== saved.jobs[0].pendingPrompt,
    'a refused refresh durably replaces the old execution instruction with its exact result-only query')
  assert(deferred.deliveryAttempts.length === 0 && deferred.faultKind === null,
    'a final-gate refusal is definite-unsent refresh state, not an unknown delivery or invented provider fault')
  e.restore(deferred)
  e.retryPendingPrompts()
  await e.refreshResponses()
  assert(posts.length === beforePosts && e.needsResponseRefresh() &&
    e.jobs[0].requestToken === queryToken && e.jobs[0].pendingPrompt === query,
    'restore and repeated refused refreshes retain the same query/token without opening the execution retry pump')
  allowed = true
  await e.refreshResponses()
  assert(posts.length === beforePosts + 1 && /^Report the result of your existing build/.test(posts.at(-1)) &&
    posts.at(-1).includes('Do not repeat work'), 'legacy build migration asks only for existing results')
  assert(executions.length === beforeExecutions && clients.counts.createSession === 2,
    'result-only refresh is not worker execution and never creates a replacement worker')
  assert(posts.at(-1) === query && postDestinations.at(-1).id === saved.jobs[0].sessionId &&
    postDestinations.at(-1).computer === saved.missionComputerId,
    'permission recovery sends the original full query to its original worker/computer exactly once')
  await e.pollJob(e.jobs[0])
  assert(e.jobs[0].state === 'building' && e.jobs[0].pendingPrompt === null &&
    !e.needsResponseRefresh() && !workerHistory.msgs.at(-1).text.includes('WORK_READY'),
    'an acknowledged query waiting on its existing task clears only unsent state, never fabricates completion')
  await e.refreshResponses()
  e.retryPendingPrompts()
  await quiesce()
  assert(posts.length === beforePosts + 1, 'an acknowledged result query is not replayed by refresh taps or ticks')

  // Model a separate explicit legacy-result query with an unreadable
  // acknowledgment; its original invocation may still settle upstream.
  const legacyAgain = JSON.parse(JSON.stringify(e.snapshot()))
  delete legacyAgain.jobs[0].requestToken
  legacyAgain.jobs[0].pendingPrompt = saved.jobs[0].pendingPrompt
  e.restore(legacyAgain)
  loseNextResultAck = true
  await e.refreshResponses()
  const unknown = JSON.parse(JSON.stringify(e.snapshot()))
  const unknownQuery = posts.at(-1)
  assert(e.hasUnconfirmedDelivery && unknown.deliveryAttempts[0].text === unknownQuery &&
    unknown.jobs[0].pendingPrompt === null,
    'a lost result-query acknowledgment preserves the entire turn as uncertainty, never as an unsent execution')
  const unknownPosts = posts.length
  e.restore(unknown)
  await e.refreshResponses()
  e.retryPendingPrompts()
  await quiesce()
  assert(posts.length === unknownPosts && e.hasUnconfirmedDelivery,
    'restoring and requesting refresh cannot replay an invoked unknown result query')
  workerHistory.msgs.push({ id: 'late-accepted-result-query', role: 'user', text: unknownQuery },
    { id: 'late-result-query-progress', role: 'assistant', text: 'Still waiting for the existing result.' })
  workerHistory.count = workerHistory.msgs.length
  await e.pollJob(e.jobs[0])
  assert(!e.hasUnconfirmedDelivery && posts.length === unknownPosts && e.jobs[0].state === 'building',
    'independent GET acceptance of the original query resolves uncertainty without a duplicate POST or false completion')
  assert(executions.length === beforeExecutions && clients.counts.createSession === 2,
    'deferral, restart, and unknown-query reconciliation never execute or replace the existing worker')
}

console.log(failures() === 0 ? '\nAll runtime tests passed.' : `\n${failures()} runtime test(s) FAILED.`)
process.exit(failures() === 0 ? 0 : 1)

/** A worker run exists for one of the mission's jobs. */
function spawned(ctx, id) {
  return (snapshotOf(ctx, id)?.jobs ?? []).some((j) => Boolean(j.agentId || j.runId || j.sessionId))
}

function isTerminalOld(ctx, id) {
  return ['completed', 'failed', 'cancelled'].includes(mission(ctx, id)?.phase)
}

function m2Control(ctx, id) {
  return mission(ctx, id)?.control
}

async function ctx2Reconcile(ctx, id) {
  return ctx.supervisor.reconcile({ missionId: id })
}
