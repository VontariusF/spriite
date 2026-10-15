/**
 * Phase 1 store tests (Persistent Companion spec §25 core correctness, the
 * items testable without the runtime): commit durability, alternating-slot
 * crash recovery, single-writer serialization, event window bounds, and
 * the v1 migration. Runs on the Node TS loader, no bridge, no network.
 *
 * Usage: npm run test:store
 */
import { MissionStore, CHECKPOINT_NAMESPACE } from '../src/state/mission-store.ts'
import { initialSpriiteState, validateSpriiteState } from '../src/domain/state.ts'
import { mintId } from '../src/domain/ids.ts'
import { draftEvent } from '../src/domain/events.ts'
import { migrateV1, V1_RECOVERY_REQUIRED } from '../src/state/migrate-v1.ts'

let failures = 0

function assert(ok, label) {
  if (ok) console.log('  PASS:', label)
  else {
    failures++
    console.log('  FAIL:', label)
  }
}

const now = () => new Date().toISOString()

/** In-memory KV with failure injection for the crash matrix. */
class TestKV {
  constructor() {
    this.map = new Map()
    this.failNextSets = 0
    this.throwNextSets = 0
    this.throwNextGets = 0
  }

  async get(key) {
    if (this.throwNextGets > 0) {
      this.throwNextGets--
      throw new Error('transport failure (get)')
    }
    return this.map.has(key) ? this.map.get(key) : null
  }

  async set(key, value) {
    if (this.throwNextSets > 0) {
      this.throwNextSets--
      throw new Error('transport failure (set)')
    }
    if (this.failNextSets > 0) {
      this.failNextSets--
      return false
    }
    this.map.set(key, value)
    return true
  }

  // -- failure/corruption helpers (simulating host-level damage) --
  raw(key, value) {
    this.map.set(key, value)
  }

  drop(key) {
    this.map.delete(key)
  }

  corrupt(key) {
    const v = this.map.get(key)
    if (v === undefined) return
    this.map.set(key, v.slice(0, Math.max(4, Math.floor(v.length / 2))))
  }
}

const SLOT_KEY = (slot, part) => `${CHECKPOINT_NAMESPACE}.slot.${slot}.${part}`
const HEAD_KEY = () => `${CHECKPOINT_NAMESPACE}.head`

function makeStore(kv, opts = {}) {
  return new MissionStore(kv, {
    initial: initialSpriiteState,
    validateState: validateSpriiteState,
    ...opts,
  })
}

function missionDraft(state, goal, extra = {}) {
  const missionId = mintId('mission')
  const mission = {
    schemaVersion: 2,
    missionId,
    entityId: state.entity.entityId,
    productId: 'p_test',
    originatingCommandId: 'cmd_test',
    title: goal,
    goal,
    phase: 'building',
    control: 'running',
    freshness: 'current',
    planRevision: 1,
    config: {
      leadProvider: 'factory',
      workerProviders: ['cursor'],
      maxConcurrentWorkers: 1,
      repository: 'https://github.com/example/x',
      baseRef: 'main',
      policyRevision: 'test',
    },
    activeRunIds: [],
    decisionIds: [],
    lastAppliedSeq: 0,
    lastObservedAt: null,
    createdAt: now(),
    updatedAt: now(),
    ...extra,
  }
  return {
    state: { ...state, missions: [...state.missions, mission] },
    events: [draftEvent('mission_created', { goal }, { entityId: state.entity.entityId, missionId })],
  }
}

function addMission(store, goal, extra) {
  return store.commit((s) => missionDraft(s, goal, extra))
}

console.log('== Phase 1: MissionStore + v1 migration ==')

// 1. Fresh load: nothing durable yet.
{
  const kv = new TestKV()
  const store = makeStore(kv)
  const loaded = await store.load()
  assert(loaded.origin === 'fresh' && loaded.seq === 0, 'fresh load: origin fresh, seq 0')
  assert(store.current.missions.length === 0, 'fresh load: no missions')
}

// 2. Commit + reload roundtrip.
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  const r = await addMission(store, 'Build the Acme landing page')
  assert(r.ok === true && r.seq === 1, 'first commit acks seq 1')
  const reloaded = makeStore(kv)
  const loaded = await reloaded.load()
  assert(loaded.origin === 'checkpoint' && loaded.seq === 1, 'reload: recovers checkpoint seq 1')
  assert(reloaded.current.missions.length === 1 && reloaded.current.missions[0].goal === 'Build the Acme landing page', 'reload: mission survives')
  assert(reloaded.events.some((e) => e.type === 'mission_created'), 'reload: event journal window survives')
}

// 3. No fixed cap: 12 missions survive (v1 evicted everything past 8).
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  for (let i = 0; i < 12; i++) await addMission(store, `Mission number ${i}`)
  const reloaded = makeStore(kv)
  await reloaded.load()
  assert(reloaded.current.missions.length === 12, '12 missions survive save/reload without eviction')
}

// 4. Identical goal strings are distinct missions (goal-key collision fix).
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  await addMission(store, 'Ship the landing page')
  await addMission(store, 'Ship the landing page')
  const reloaded = makeStore(kv)
  await reloaded.load()
  const ids = reloaded.current.missions.map((m) => m.missionId)
  assert(
    reloaded.current.missions.length === 2 && ids[0] !== ids[1],
    'identical goal strings produce two distinct mission IDs',
  )
}

// 5. Paused intent survives restart (v1 restore forced paused = false).
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  await addMission(store, 'Paused build', { control: 'paused' })
  const reloaded = makeStore(kv)
  await reloaded.load()
  assert(reloaded.current.missions[0].control === 'paused', 'paused mission stays paused after reload')
}

// 6. Rejected mutation changes nothing.
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  await addMission(store, 'One')
  const r = await store.commit(() => null)
  assert(r.ok === false && r.reason === 'rejected', 'null mutation rejects the commit')
  assert(store.current.missions.length === 1 && store.checkpointSeq === 1, 'rejected mutation: state and seq unchanged')
}

// 7. Cursors advance only inside a commit (with their events).
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  await store.commit((s) => ({
    state: { ...s, cursors: { ...s.cursors, 'factory.sess-1': '4' } },
    events: [draftEvent('run_observed', { sessionId: 'sess-1', count: 4 }, { entityId: s.entity.entityId })],
  }))
  await store.commit(() => null) // rejected: cursor must not move alone
  const reloaded = makeStore(kv)
  await reloaded.load()
  assert(reloaded.current.cursors['factory.sess-1'] === '4', 'cursor committed with its event')
  assert(reloaded.events.some((e) => e.type === 'run_observed'), 'cursor commit records its event')
}

// 8. Crash after the slot write, before the head pointer: head is advisory.
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  await addMission(store, 'Survives head loss')
  kv.drop(HEAD_KEY())
  const reloaded = makeStore(kv)
  const loaded = await reloaded.load()
  assert(
    loaded.origin === 'checkpoint' && loaded.seq === 1 && reloaded.current.missions.length === 1,
    'torn/missing head pointer never discards a complete checkpoint',
  )
}

// 9. Torn manifest on the newer slot: fall back to the older complete slot.
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  await addMission(store, 'First')
  await addMission(store, 'Second')
  kv.corrupt(SLOT_KEY('b', 'm')) // slot b held seq 2
  const reloaded = makeStore(kv)
  const loaded = await reloaded.load()
  assert(loaded.seq === 1 && reloaded.current.missions.length === 1, 'torn manifest falls back to the older valid slot')
}

// 10. Corrupt chunk on the newer slot: checksum catches the mix.
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  await addMission(store, 'First')
  await addMission(store, 'Second')
  kv.raw(SLOT_KEY('b', 0), '{"v":2,"seq":2,"poison')
  const reloaded = makeStore(kv)
  const loaded = await reloaded.load()
  assert(loaded.seq === 1, 'corrupt chunk invalidates only its slot; the older slot wins')
}

// 11. Both slots damaged: honest corruption, fresh state, surfaced warning.
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  await addMission(store, 'First')
  await addMission(store, 'Second')
  kv.corrupt(SLOT_KEY('a', 'm'))
  kv.corrupt(SLOT_KEY('b', 'm'))
  const reloaded = makeStore(kv)
  const loaded = await reloaded.load()
  assert(loaded.origin === 'corruption' && loaded.seq === 0, 'both slots corrupt: origin corruption, seq 0')
  assert(loaded.warnings.length > 0, 'corruption surfaces a warning, not a silent reset')
  assert(reloaded.current.missions.length === 0, 'corrupt state never leaks into runtime state')
}

// 12. Single writer: concurrent commits serialize with distinct seqs.
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => addMission(store, `Concurrent ${i}`)),
  )
  const seqs = results.map((r) => (r.ok ? r.seq : -1)).sort((a, b) => a - b)
  assert(
    results.every((r) => r.ok) && seqs.join(',') === '1,2,3,4,5,6,7,8,9,10',
    '10 concurrent commits serialize: seqs 1..10, all acked',
  )
  const reloaded = makeStore(kv)
  await reloaded.load()
  assert(reloaded.current.missions.length === 10, 'all serialized commits persist')
}

// 13. Storage failure: broken store, honest error, recovery via reload.
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  await addMission(store, 'Durable one')
  kv.failNextSets = 1 // the next set fails (a chunk of the second commit)
  const failed = await addMission(store, 'Lost two')
  assert(failed.ok === false && failed.reason === 'storage', 'failed write reports storage, never success')
  assert(store.current.missions.length === 1 && store.durability === 'broken', 'failed write: state unchanged, store broken')
  const blocked = await addMission(store, 'Blocked three')
  assert(blocked.ok === false && blocked.reason === 'broken', 'broken store refuses further commits')
  const reloaded = await store.reload()
  assert(reloaded.origin === 'checkpoint' && store.durability === 'ok', 'reload revalidates and clears broken')
  assert(store.current.missions.length === 1, 'reload recovers the last good envelope, not the failed commit')
  const after = await addMission(store, 'After recovery')
  assert(after.ok === true, 'store commits again after recovery')
}

// 14. Event window bound: old events compact away, seqs stay monotonic.
{
  const kv = new TestKV()
  const store = makeStore(kv, { eventWindow: 3 })
  await store.load()
  for (let i = 0; i < 5; i++) {
    await store.commit((s) => ({
      state: s,
      events: [draftEvent('run_observed', { i }, { entityId: s.entity.entityId })],
    }))
  }
  const reloaded = makeStore(kv, { eventWindow: 3 })
  await reloaded.load()
  assert(reloaded.events.length === 3, 'event window keeps only the last 3 events')
  const seqs = reloaded.events.map((e) => e.seq)
  assert(seqs.join(',') === '3,4,5', 'window seqs are the newest, journal counter intact')
  assert(reloaded.journalSeq === 5, 'journal counter survives compaction')
}

// 15. Briefing coverage hold-back: unseen events are not compacted away, and
//     the ceiling is the only thing that evicts them (spec §9).
{
  const kv = new TestKV()
  const store = makeStore(kv, {
    eventWindow: 2,
    maxEventWindow: 4,
    holdEventsAfter: (s) => s.acknowledgedSeq,
  })
  await store.load()
  const commitOne = (s) => ({
    state: s,
    events: [draftEvent('run_observed', { n: store.journalSeq }, { entityId: s.entity.entityId })],
  })
  for (let i = 0; i < 4; i++) await store.commit(commitOne)
  assert(store.events.length === 4, 'nothing acknowledged: the soft window (2) does not evict unseen events')
  assert(
    store.events.map((e) => e.seq).join(',') === '1,2,3,4',
    'every unseen event is still held, oldest first',
  )

  // Past the ceiling the hold-back gives way, and the store says so.
  for (let i = 0; i < 2; i++) await store.commit(commitOne)
  assert(store.events.length === 4, 'the ceiling bounds the held window')
  assert(store.events.map((e) => e.seq).join(',') === '3,4,5,6', 'the ceiling evicts the oldest held events')
  assert(
    store.lastWarnings.some((w) => w.includes('ceiling')),
    'hitting the ceiling is reported, never silent (§9)',
  )

  // Acknowledging everything lets the soft window take over again.
  await store.commit((s) => ({ state: { ...s, acknowledgedSeq: store.journalSeq }, events: [] }))
  await store.commit(commitOne)
  assert(store.events.length === 2, 'acknowledged history compacts back to the soft window')
  assert(store.events.map((e) => e.seq).join(',') === '6,7', 'the compacted window keeps the newest events')

  // The default (no hold-back option) still behaves exactly as before.
  const plain = makeStore(new TestKV(), { eventWindow: 2 })
  await plain.load()
  for (let i = 0; i < 3; i++) await plain.commit((s) => ({
    state: s,
    events: [draftEvent('run_observed', { i }, { entityId: s.entity.entityId })],
  }))
  assert(plain.events.length === 2, 'omitting the hold-back option holds nothing (unchanged behaviour)')
}

// 16. A THROWING backend is the same durability failure as a false return:
//     typed result, store marked broken, no commit built on uncertain storage.
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  kv.throwNextSets = 1
  const thrown = await store.commit((s) => ({
    state: s,
    events: [draftEvent('run_observed', { i: 1 }, { entityId: s.entity.entityId })],
  }))
  assert(
    thrown.ok === false && thrown.reason === 'storage',
    'a KV write that throws is reported as a storage failure, never as an exception or a success (§8)',
  )
  assert(store.durability === 'broken', 'a throwing write marks the store broken, exactly like a false return')
  const blocked = await store.commit((s) => ({ state: s, events: [] }))
  assert(blocked.ok === false && blocked.reason === 'broken', 'no commit builds on storage that may have partially landed')

  // A throwing READ during the commit's auto-load is the same failure class.
  const kv2 = new TestKV()
  const unloaded = makeStore(kv2)
  kv2.throwNextGets = 2
  const readFail = await unloaded.commit((s) => ({ state: s, events: [] }))
  assert(
    readFail.ok === false && readFail.reason === 'storage',
    'a transport failure while reading is a durability failure, never read as absence (§8)',
  )
  assert(unloaded.durability === 'broken', 'the store stops after a failed read rather than committing blind')
}

// 17. A state that would fail recovery validation is rejected BEFORE it is
//     written: never acked-then-lost (spec §8).
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  const good = await addMission(store, 'Mission A')
  assert(good.ok === true, 'a valid state commits')
  const seqBefore = store.checkpointSeq
  const bad = await store.commit((s) => ({
    // A malformed briefing: the shape recovery would reject on the next boot.
    state: { ...s, briefings: [{ schemaVersion: 2, briefingId: 'b', kind: 'nope', targetSeq: 1, coveredEventIds: [], missionRevisions: {}, cards: [], createdAt: now() }] },
    events: [],
  }))
  assert(
    bad.ok === false && bad.reason === 'rejected',
    'a state that would fail recovery validation is rejected, not written and acked',
  )
  assert(store.checkpointSeq === seqBefore, 'the rejected commit left the checkpoint sequence untouched')
  assert(store.current.missions.length === 1, 'the rejected commit did not mutate the live state')
  const reloaded = makeStore(kv)
  const loaded = await reloaded.load()
  assert(
    loaded.origin === 'checkpoint' && reloaded.current.missions.length === 1,
    'recovery still finds the last good state (nothing unloadable was written)',
  )
}

// 18. An explicit ceiling below the soft window is honored, not silently raised.
{
  const kv = new TestKV()
  const store = makeStore(kv, { eventWindow: 200, maxEventWindow: 5 })
  await store.load()
  for (let i = 0; i < 8; i++) {
    await store.commit((s) => ({
      state: s,
      events: [draftEvent('run_observed', { i }, { entityId: s.entity.entityId })],
    }))
  }
  assert(store.events.length === 5, 'the configured ceiling bounds the window even when the soft window is larger')
  assert(store.events.map((e) => e.seq).join(',') === '4,5,6,7,8', 'the ceiling keeps the newest events')
}

// 19. Migration: v1 snapshots + projects import as frozen-config missions.
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  const snap = {
    v: 1,
    real: true,
    phase: 'building',
    goal: 'Build the Acme landing page',
    capturedSec: 12,
    repoUrl: 'https://github.com/example/acme',
    missionRepo: 'https://github.com/example/acme',
    sessionId: 'sess-lead-1',
    workerPref: 'cursor',
    jobCount: 2,
    askBeforePr: false,
    decisionPending: false,
    faultKind: null,
    messageCount: 4,
    jobs: [
      {
        label: 'Job 1',
        mode: 'cursor',
        stage: 'build',
        agentId: 'agent-1',
        runId: 'run-1',
        branch: 'spriite/job-1',
        state: 'building',
      },
    ],
  }
  kv.raw('sprite.factory.v1', JSON.stringify({ v: 1, engine: snap, focusIdx: 0, uiMode: 'scene', savedAt: Date.now() }))
  kv.raw(
    'spriite.projects.v1',
    JSON.stringify({
      v: 1,
      projects: [
        { goal: 'Build the Acme landing page', status: 'building', updatedAt: 1, snapshot: snap },
        {
          goal: 'Fix the mobile layout',
          status: 'review',
          updatedAt: 2,
          snapshot: { ...snap, goal: 'Fix the mobile layout', phase: 'review', sessionId: 'sess-2' },
        },
      ],
    }),
  )
  const out = await migrateV1(kv, store)
  assert(out.migrated === true && out.missionCount === 2, 'migration imports deduped: 2 missions, not 3')
  const missions = store.current.missions
  assert(
    missions.every((m) => m.control === 'running' && m.freshness === 'stale'),
    'migrated missions: honest control running, freshness stale',
  )
  const acme = missions.find((m) => m.goal === 'Build the Acme landing page')
  const layout = missions.find((m) => m.goal === 'Fix the mobile layout')
  assert(acme.config.repository === 'https://github.com/example/acme' && acme.config.maxConcurrentWorkers === 2, 'mission config frozen from its snapshot')
  assert(acme.missionId !== layout.missionId, 'distinct goals -> distinct stable IDs')
  const runRefs = Object.values(store.current.runs)
  assert(
    runRefs.some((r) => r.sessionOrAgentId === 'sess-lead-1' && r.role === 'lead') &&
      runRefs.some((r) => r.sessionOrAgentId === 'agent-1' && r.remoteRunId === 'run-1'),
    'provider session/agent/run references preserved as runs',
  )
  assert(acme.activeRunIds.length >= 2, 'mission links its runs')
  assert(
    store.events.some((e) => e.type === 'mission_migrated_from_v1') &&
      store.events.some((e) => e.type === 'runtime_migration_completed'),
    'migration records labeled events, not fabricated history',
  )
  assert(store.current.migratedFromV1 === true, 'migration marker set')
  assert(kv.map.has('sprite.factory.v1') && kv.map.has('spriite.projects.v1'), 'v1 records left intact')
  const again = await migrateV1(kv, store)
  assert(again.migrated === false && again.missionCount === 0, 'migration is idempotent')
  const reloaded = makeStore(kv)
  await reloaded.load()
  assert(
    reloaded.current.migratedFromV1 === true && reloaded.current.missions.length === 2,
    'migration persists through reload',
  )
}

// 16. Migration: identical goals across entries stay distinct missions.
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  const snap = {
    v: 1,
    real: true,
    phase: 'building',
    goal: 'Same goal text',
    repoUrl: 'https://github.com/example/x',
    missionRepo: 'https://github.com/example/x',
    sessionId: 'sess-a',
    workerPref: 'factory',
    jobCount: 1,
    jobs: [],
  }
  kv.raw(
    'spriite.projects.v1',
    JSON.stringify({
      v: 1,
      projects: [
        { goal: 'Same goal text', status: 'building', updatedAt: 1, snapshot: snap },
        { goal: 'Same goal text', status: 'repair', updatedAt: 2, snapshot: { ...snap, phase: 'repair' } },
      ],
    }),
  )
  const out = await migrateV1(kv, store)
  assert(out.migrated === true && out.missionCount === 2, 'two same-goal entries import as two distinct missions')
  const ids = store.current.missions.map((m) => m.missionId)
  assert(ids[0] !== ids[1], 'no goal-key collision in the v2 model')
}

// 17. Migration: watches are not missions; missing config is held.
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  kv.raw(
    'sprite.factory.v1',
    JSON.stringify({
      v: 1,
      engine: {
        v: 1,
        real: true,
        phase: 'attach',
        goal: 'Watch someone elses build',
        sessionId: 'sess-attach',
        workerPref: 'auto',
        jobCount: 1,
        jobs: [],
      },
      focusIdx: 0,
      uiMode: 'scene',
      savedAt: Date.now(),
    }),
  )
  kv.raw(
    'spriite.projects.v1',
    JSON.stringify({
      v: 1,
      projects: [{ goal: 'Orphaned entry', status: 'building', updatedAt: 1, snapshot: null }],
    }),
  )
  const out = await migrateV1(kv, store)
  assert(out.migrated === true && out.missionCount === 1, 'attach watches are not imported as missions')
  assert(out.warnings.some((w) => w.includes('watching an external cloud build')), 'watch skip surfaces a warning')
  const orphan = store.current.missions[0]
  assert(
    orphan.config.policyRevision === V1_RECOVERY_REQUIRED && orphan.config.repository === '',
    'missing snapshot config is held for recovery, never defaulted',
  )
  assert(out.warnings.some((w) => w.includes('no recoverable repository')), 'config hold surfaces a warning')
}

// 18. Big state: the envelope chunks and reassembles exactly.
{
  const kv = new TestKV()
  const store = makeStore(kv, { chunkChars: 40_000 })
  await store.load()
  const bigGoal = 'x'.repeat(60_000)
  await addMission(store, bigGoal)
  assert(kv.map.has(SLOT_KEY('a', 1)), 'large envelope splits into multiple chunks')
  const reloaded = makeStore(kv, { chunkChars: 40_000 })
  await reloaded.load()
  assert(
    reloaded.current.missions.length === 1 && reloaded.current.missions[0].goal === bigGoal,
    'chunked envelope reassembles byte-exact',
  )
}

// 19. Migration: faulted v1 missions import as failed, never as live.
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  const base = {
    v: 1,
    real: true,
    phase: 'building',
    goal: 'placeholder',
    repoUrl: 'https://github.com/example/x',
    missionRepo: 'https://github.com/example/x',
    sessionId: 'sess-f',
    workerPref: 'cursor',
    jobCount: 1,
    jobs: [],
  }
  kv.raw(
    'spriite.projects.v1',
    JSON.stringify({
      v: 1,
      projects: [
        {
          goal: 'Auth-broken mission',
          status: 'fault',
          updatedAt: 3,
          snapshot: { ...base, goal: 'Auth-broken mission', faultKind: 'auth' },
        },
        { goal: 'Faulted without snapshot', status: 'fault', updatedAt: 4, snapshot: null },
      ],
    }),
  )
  const out = await migrateV1(kv, store)
  assert(out.migrated === true && out.missionCount === 2, 'faulted v1 entries import as missions')
  assert(
    store.current.missions.every((m) => m.phase === 'failed'),
    'faulted v1 missions import as failed (status fault and snapshot faultKind both map)',
  )
}

// 19b. Migration warnings carry identifiers, never owner content (spec §21:
// these warnings reach the console). The diverged-copy graft names the
// mission by id, and the goal text the owner typed never rides along.
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  kv.raw(
    'spriite.projects.v1',
    JSON.stringify({
      v: 1,
      projects: [
        {
          goal: 'Portfolio redesign',
          status: 'building',
          updatedAt: 2,
          snapshot: {
            real: true, phase: 'building', goal: 'Portfolio redesign',
            repoUrl: 'https://github.com/example/x', missionRepo: 'https://github.com/example/x',
            workerPref: 'factory', jobCount: 1, jobs: [],
          },
        },
      ],
    }),
  )
  kv.raw(
    'sprite.factory.v1',
    JSON.stringify({
      v: 1,
      engine: {
        real: true, phase: 'building', goal: 'Portfolio redesign', sessionId: 'sess-live-1',
        repoUrl: 'https://github.com/example/x', missionRepo: 'https://github.com/example/x',
        workerPref: 'factory', jobCount: 1, jobs: [],
      },
      focusIdx: 0,
      uiMode: 'scene',
      savedAt: Date.now(),
    }),
  )
  const out = await migrateV1(kv, store)
  assert(out.migrated === true && out.missionCount === 1, 'the vault copy and the live snapshot are one mission')
  const mission = store.current.missions[0]
  assert(
    mission.activeRunIds.length === 1 &&
      Object.values(store.current.runs).some((r) => r.role === 'lead' && r.sessionOrAgentId === 'sess-live-1'),
    'the live lead session was grafted onto the imported mission',
  )
  assert(
    out.warnings.some((w) => w.includes('diverged') && w.includes(mission.missionId)),
    'the diverged copy says which mission, by id',
  )
  assert(
    out.warnings.every((w) => !w.includes('Portfolio redesign')),
    'migration warnings never carry the owner\u2019s goal text into the logs',
  )
}

// 20. Commit before load: auto-loads inside the queue, stacks on durable state.
{
  const kv = new TestKV()
  const first = makeStore(kv)
  await first.load()
  await addMission(first, 'Mission A')
  await addMission(first, 'Mission B')
  const second = makeStore(kv)
  const r = await addMission(second, 'Mission C') // no load() call first
  assert(r.ok === true && r.seq === 3, 'unloaded store auto-loads: commit acks seq 3, not seq 1')
  const reloaded = makeStore(kv)
  await reloaded.load()
  assert(reloaded.current.missions.length === 3, 'unloaded commit destroys no prior checkpoint data')

  // The same ack must be honest when the durable write FAILS: the commit is
  // reported not-ok, and the failed mutation never touches a checkpoint.
  const third = makeStore(kv)
  kv.failNextSets = 1
  const failed = await addMission(third, 'Mission D')
  assert(failed.ok === false, 'a commit whose checkpoint write failed is reported not-ok')
  const after = makeStore(kv)
  await after.load()
  assert(
    after.current.missions.every((m) => m.goal !== 'Mission D'),
    'the failed commit left no trace in the durable state',
  )
}

// 21. Migration decides on DURABLE state: v1 keys appearing after this store
// instance already loaded (and committed) are still imported, and the
// existing v2 missions survive the import.
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  await addMission(store, 'Mission A') // marker-less checkpoint is durable now
  kv.raw(
    'spriite.projects.v1',
    JSON.stringify({
      v: 1,
      projects: [{ goal: 'Migrated mission', status: 'building', updatedAt: 5, snapshot: null }],
    }),
  )
  const out = await migrateV1(kv, store)
  assert(out.migrated === true && out.missionCount === 1, 'v1 keys that appeared after load are still imported')
  assert(
    store.current.missions.some((m) => m.goal === 'Mission A') && store.current.missions.some((m) => m.goal === 'Migrated mission'),
    'the import stacks on the durable v2 state, it does not replace it',
  )
  assert(store.current.migratedFromV1 === true, 'migration marker lands durably')
  const again = await migrateV1(kv, makeStore(kv))
  assert(again.migrated === false, 'the durable marker makes migration one-time, even for a new instance')
}

// 22. Migration never splits one lead session across two missions: a v1
// snapshot naming a session the durable runtime already owns is skipped. This
// is the case a stale `sprite.factory.v1` write creates (any writer, any
// version), and it is what stops a second record from resuming work that is
// already running under the durable runtime.
{
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  await addMission(store, 'Deliver the empty-state screen')
  const missionId = store.current.missions[store.current.missions.length - 1].missionId
  await store.commit((s) => ({
    state: {
      ...s,
      runs: {
        ...s.runs,
        run_lead_v2: {
          schemaVersion: 2,
          runId: 'run_lead_v2',
          missionId,
          provider: 'factory',
          role: 'lead',
          accountId: null,
          sessionOrAgentId: 'sess-runtime-1',
          remoteRunId: null,
          branch: '',
          baseSha: '',
          currentSha: '',
          observedState: 'running',
          lastObservedAt: null,
        },
      },
      missions: s.missions.map((m) =>
        m.missionId === missionId ? { ...m, activeRunIds: [...m.activeRunIds, 'run_lead_v2'] } : m,
      ),
    },
    events: [],
  }))
  kv.raw(
    'sprite.factory.v1',
    JSON.stringify({
      v: 1,
      engine: {
        real: true,
        phase: 'building',
        goal: 'Deliver the empty-state screen',
        capturedSec: 10,
        repoUrl: 'https://github.com/example/sprite',
        missionRepo: 'https://github.com/example/sprite',
        sessionId: 'sess-runtime-1',
        workerPref: 'factory',
        jobCount: 1,
        askBeforePr: false,
        decisionPending: false,
        faultKind: null,
        messageCount: 3,
        jobs: [],
      },
      focusIdx: 0,
      uiMode: 'scene',
      savedAt: Date.now(),
    }),
  )
  const out = await migrateV1(kv, store)
  assert(out.missionCount === 0, 'a v1 snapshot naming a durable lead session imports no second mission')
  assert(store.current.missions.length === 1, 'the durable mission stays the only record')
  assert(
    out.warnings.some((w) => w.includes('already owns its lead session')),
    'the skipped import says why',
  )
  assert(kv.map.has('sprite.factory.v1'), 'the v1 record is left intact, only not re-imported')
}

// ------------------------------------------------- commit observer (archive)
// The archive mirror's one durable-write trigger (VPS-ARCHIVE-SPEC §6): the
// store observes its own commits. The contract the mirror depends on: the
// observer sees the state before and after every commit that LANDED, is
// never told about a commit that did not, and can never turn a landed commit
// into a failure — including by throwing.
{
  const kv = new TestKV()
  const seen = []
  const boom = () => {
    throw new Error('observer may not break the commit')
  }
  const store = makeStore(kv, { observe: (prev, next) => seen.push([prev, next]) })
  await store.load()
  await store.commit((s) => missionDraft(s, 'Deliver the empty-state screen'))
  assert(seen.length === 1, 'the observer fires once per landed commit')
  assert(
    seen[0][0].missions.length === 0 && seen[0][1].missions.length === 1,
    'the observer sees the state before and after the commit',
  )
  assert(store.current.missions.length === 1, 'the commit itself landed')
  await store.commit(() => null)
  assert(seen.length === 1, 'a mutation that declined is not a commit and is not observed')
  kv.failNextSets = 1
  const refused = await store.commit((s) => missionDraft(s, 'Second goal'))
  assert(refused.ok === false && refused.reason === 'storage', 'a failed write is reported to its caller')
  assert(seen.length === 1, 'a commit whose write did not land is never observed')
  const threw = new MissionStore(new TestKV(), {
    initial: initialSpriiteState,
    validateState: validateSpriiteState,
    observe: boom,
  })
  await threw.load()
  const survived = await threw.commit((s) => missionDraft(s, 'Third goal'))
  assert(survived.ok === true, 'an observer that throws cannot make a landed commit read as failed')
  assert(threw.current.missions.length === 1, 'the state the observer tried to break stands')
}

// Restoration must never admit a mission whose frozen configuration crashes
// spawn. Older optional config fields remain absent, not invented on load.
{
  const base = missionDraft(initialSpriiteState(), 'Checkpoint validation').state
  const invalid = [
    ['missing config', (m) => { delete m.config }],
    ['null config', (m) => { m.config = null }],
    ['array config', (m) => { m.config = [] }],
    ['invalid lead', (m) => { m.config.leadProvider = 'x' }],
    ['missing workers', (m) => { delete m.config.workerProviders }],
    ['scalar workers', (m) => { m.config.workerProviders = 'cursor' }],
    ['invalid worker', (m) => { m.config.workerProviders = [null] }],
    ['non-numeric capacity', (m) => { m.config.maxConcurrentWorkers = '1' }],
    ['zero capacity', (m) => { m.config.maxConcurrentWorkers = 0 }],
    ['fractional capacity', (m) => { m.config.maxConcurrentWorkers = 1.5 }],
    ['missing repository', (m) => { delete m.config.repository }],
    ['object repository', (m) => { m.config.repository = {} }],
    ['null base ref', (m) => { m.config.baseRef = null }],
    ['invalid policy revision', (m) => { m.config.policyRevision = 2 }],
    ['invalid preference', (m) => { m.config.workerPreference = 'other' }],
    ['null session settings', (m) => { m.config.sessionSettings = null }],
    ['array session settings', (m) => { m.config.sessionSettings = [] }],
    ['non-string model', (m) => { m.config.sessionSettings = { leadModel: {} } }],
    ['non-string instructions', (m) => { m.config.sessionSettings = { workerInstructions: 1 } }],
    ['non-array tools', (m) => { m.config.sessionSettings = { workerEnabledToolIds: 'tool' } }],
    ['invalid tool id', (m) => { m.config.sessionSettings = { workerRestrictToolIds: [null] } }],
    ['invalid new-repo intent', (m) => { m.config.newRepository = 'true' }],
    ['invalid new-repo name', (m) => { m.config.newRepositoryName = {} }],
    ['invalid approval', (m) => { m.config.startApproved = 'true' }],
    ['missing active runs', (m) => { delete m.activeRunIds }],
    ['invalid active runs', (m) => { m.activeRunIds = [null] }],
    ['invalid decisions', (m) => { m.decisionIds = {} }],
    ['invalid plan revision', (m) => { m.planRevision = '1' }],
  ]
  for (const [label, mutate] of invalid) {
    const bad = structuredClone(base)
    mutate(bad.missions[0])
    assert(validateSpriiteState(bad) === null, `mission validation rejects ${label}`)
    const kv = new TestKV()
    const store = makeStore(kv)
    await store.load()
    await store.commit(() => ({ state: base, events: [] }))
    const rejected = await store.commit(() => ({ state: bad, events: [] }))
    assert(!rejected.ok && rejected.reason === 'rejected', `malformed commit rejected: ${label}`)
    // Model a checksum-valid corrupt newer envelope without defeating the
    // production validator on recovery.
    const unchecked = makeStore(kv, { validateState: (s) => s })
    await unchecked.load()
    await unchecked.commit(() => ({ state: bad, events: [] }))
    const recovered = makeStore(kv)
    const loaded = await recovered.load()
    assert(loaded.seq === 1 && JSON.stringify(recovered.current) === JSON.stringify(base),
      `recovery falls back from checksum-valid ${label}`)
  }
  const kv = new TestKV()
  const store = makeStore(kv)
  await store.load()
  const modern = structuredClone(base)
  Object.assign(modern.missions[0].config, {
    workerPreference: 'mix', newRepository: true, newRepositoryName: 'repo',
    startApproved: true, sessionSettings: {
      interactionMode: 'auto', specModeModel: 'spec', specModeReasoningEffort: 'high',
      leadModel: 'lead', leadReasoningEffort: 'high', leadAutonomyLevel: 'auto',
      workerModel: 'worker', workerReasoningEffort: 'low', workerInstructions: 'Instructions',
      workerEnabledToolIds: [], workerDisabledToolIds: ['a'], workerRestrictToolIds: ['b'],
      futureSetting: { retained: true },
    },
  })
  for (const [label, state] of [['legacy optional fields absent', base], ['modern config', modern]]) {
    const saved = await store.commit(() => ({ state, events: [] }))
    const restored = makeStore(kv)
    await restored.load()
    assert(saved.ok && JSON.stringify(restored.current) === JSON.stringify(state),
      `${label} roundtrips exactly`)
  }
}

console.log('')
if (failures === 0) console.log('store tests: all passed')
else {
  console.log(`store tests: ${failures} FAILED`)
  process.exitCode = 1
}
