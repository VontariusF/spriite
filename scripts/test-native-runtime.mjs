/**
 * Actual Supervisor/actors/store/HTTP client seams; no provider/network.
 * Run: node --import ./scripts/ts-resolve.mjs scripts/test-native-runtime.mjs
 */
import assert from 'node:assert/strict'
import { Supervisor } from '../src/runtime/supervisor.ts'
import { NativeMissionActor, nativeDetailRows, nativePose } from '../src/runtime/native-mission.ts'
import { RuntimeEngine } from '../src/runtime/app-engine.ts'
import { createRuntimeStore } from '../src/state/runtime-store.ts'
import { initialSpriiteState, validateSpriiteState } from '../src/domain/state.ts'
import { assembleRecords, mergeRestore } from '../src/state/archive.ts'
import { HttpNativeBrokerClient } from '../src/native/client.ts'
import { NativeAdmissionCoordinator } from '../src/native/admission.ts'
import { nativeFingerprint } from '../src/native/fingerprint.ts'
import { decodeNativeCache, decodeNativeDelivery, decodeNativeIntent, decodeNativeSnapshot } from '../src/native/decode.ts'
import { nativeArtifactsVerified, nativePresentation, nativeTerminalCopy } from '../src/native/presentation.ts'
import { buildBriefing, nativeBriefingRequestKey } from '../src/briefing/build.ts'
import { homeStatusOf } from '../src/runtime/app-engine.ts'
import { draftEvent } from '../src/domain/events.ts'
import { validateScene } from '../src/scenes/validate.ts'
import { TestKV, SETTINGS, makeClients, quiesce } from './lib/runtime-fake.mjs'

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed++
  console.log(`PASS ${name}`)
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
const reviewedSettings = {
  modelId: 'fixture-root', reasoningEffort: 'high', workerModel: 'fixture-worker',
  workerReasoningEffort: 'medium', validationWorkerModel: 'fixture-validator',
  validationWorkerReasoningEffort: 'high', restrictToolIds: ['Read', 'Edit'],
  skipScrutiny: false, skipUserTesting: false,
}
function intent(id = 'native-1') {
  return {
    protocolVersion: 1, missionId: id, ownerId: profile.ownerId, commandId: `command-${id}`,
    goal: 'Keep ALL owner words\nand restrictions intact.  No publication.',
    scopeRevision: 1, operation: 'implement',
    workspace: { machineId: profile.machineId, cwd: profile.cwd, repository: SETTINGS.repository,
      baseRef: 'develop', baseSha: 'base-exact' },
    references: ['https://example.test/reference'], acceptanceCriteria: ['A real fixture passes'],
    restrictions: ['No publication'],
    policy: { autonomy: 'high', allowCreateRepository: false, allowPush: false, allowPr: false, allowMerge: false, allowDeploy: false },
    scopeApproved: true, highAutonomyApproved: true, settings: { workerModel: 'explicit-native-model' },
  }
}
function attention(id = 'ask-1', kind = 'ask_user') {
  return {
    attentionId: id, requestId: `rpc-${id}`, sessionId: 'root-native', machineId: profile.machineId,
    toolUseIds: ['tool-exact'], associatedSessionIds: ['child-native'], revision: 1, payloadHash: `hash-${id}`,
    kind, title: 'Choose the exact destination', details: 'Not a fitted display label.',
    options: kind === 'ask_user' ? [] : [{ id: 'p', label: 'Proceed once', value: 'proceed_once' }],
    questions: kind === 'ask_user' ? [
      { index: 7, topic: 'Region', question: 'Which region?', multiSelect: false,
        options: [{ id: 'long-a', label: 'Same prefix A', value: 'raw_A' }, { id: 'long-b', label: 'Same prefix B', value: 'raw_B' }] },
      { index: 11, topic: 'Features', question: 'Which features?', multiSelect: true,
        options: [{ id: 'one', label: 'Feature one', value: 'feature1' }, { id: 'two', label: 'Feature two', value: 'feature2' }] },
    ] : [],
    state: 'open', openedAt: '2026-10-12T00:00:00.000Z', resolvedAt: null,
  }
}
const answer = a => ({
  attentionId: a.attentionId, requestId: a.requestId, sessionId: a.sessionId, machineId: a.machineId,
  revision: a.revision, payloadHash: a.payloadHash,
  ...(a.kind === 'ask_user' ? { answers: [{ index: 7, answer: 'raw_B' }, { index: 11, answer: '["feature1","feature2"]' }] } :
    { selectedOption: 'proceed_once' }),
})
function snapshot(i = intent()) {
  return {
    protocolVersion: 1, backend: 'factory_native', missionId: i.missionId, ownerId: i.ownerId,
    scopeRevision: i.scopeRevision, brokerSeq: 1, state: 'running', control: 'running',
    binding: { sessionId: 'root-native', ...i.workspace, baseSha: i.workspace.baseSha ?? null },
    capabilities: { ...capabilities }, attention: [attention()],
    features: [{ id: 'f-1', description: 'Provider reports feature one', status: 'completed', expectedBehavior: ['A real fixture passes'] }],
    history: [{ id: 'h-1', who: 'owner', text: i.goal, at: '2026-10-12T00:00:00.000Z' },
      { id: 'h-2', who: 'factory', text: 'Question observed', at: '2026-10-12T00:01:00.000Z' }],
    commands: [], lastObservedAt: '2026-10-12T00:10:00.000Z', completeness: 'complete', holdReason: null, finalization: null,
  }
}
function broker(i = intent()) {
  const b = {
    value: snapshot(i), prepared: [], reads: [], commands: [], failCommand: false, failPrepare: false,
    async capabilities() { return structuredClone(capabilities) },
    async prepare(v) {
      b.prepared.push(structuredClone(v))
      if (b.failPrepare) throw new Error('response lost after launch')
      b.value.missionId = v.missionId; b.value.ownerId = v.ownerId
      return structuredClone(b.value)
    },
    async observe(id, owner) { b.reads.push({ id, owner }); return structuredClone(b.value) },
    async command(v) {
      b.commands.push(structuredClone(v))
      if (b.failCommand) throw new Error('response lost after command')
      return { commandId: v.commandId, state: 'confirmed', reason: null }
    },
  }
  return b
}
function runtime(kv = new TestKV(), native = broker(), settings = {}) {
  const clients = makeClients()
  const clock = { now: Date.parse('2026-10-12T00:10:00.000Z') }
  const config = { ...SETTINGS, sessionSettings: {}, nativeProfile: { ...profile }, ...settings }
  const views = []
  const supervisor = new Supervisor({
    store: createRuntimeStore(kv), kv, clients, nativeClient: native, settings: () => config,
    now: () => clock.now, emitView: (id, view) => views.push({ id, view }),
  })
  return { supervisor, clients, clock, config, kv, native, views }
}
const mission = ctx => ctx.supervisor.missions[0]
async function read(ctx) {
  ctx.clock.now += 6000
  ctx.supervisor.tick(ctx.clock.now)
  await ctx.supervisor.flush()
}
const zeroLegacy = ctx => {
  const c = ctx.clients.counts
  for (const k of ['createSession', 'postMessage', 'cursorAgent', 'cursorRun', 'createRepo']) assert.equal(c[k], 0, k)
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function until(check, label) {
  for (let n = 0; n < 30; n++) {
    if (check()) return
    await quiesce()
  }
  assert.fail(`did not reach ${label}`)
}
const requestCards = brief => brief.cards.filter(c => c.nativeRequestKey !== undefined)
const recoveryEvents = ctx => ctx.supervisor.missionStore.events.filter(e =>
  e.type === 'provider_connectivity_changed' && e.payload.kind === 'recovered' &&
  e.payload.recoveryDomain === 'native_observation')

await test('independent actor, exact intent, zero legacy/Cursor writes, truthful scenes', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot()
  const i = intent()
  const receipt = await ctx.supervisor.submitNativeIntent(i)
  assert.equal(receipt.receipt, 'saved')
  const actor = ctx.supervisor.actor(i.missionId)
  assert.ok(actor instanceof NativeMissionActor)
  assert.equal(actor.backend, 'factory_native')
  assert.deepEqual(ctx.native.prepared, [i])
  i.workspace.cwd = '/caller-mutated'
  assert.equal(mission(ctx).config.nativeIntent.workspace.cwd, profile.cwd)
  assert.equal(ctx.supervisor.engineSnapshotFor('native-1'), null)
  // HudRun's bar from the provider's report: a reported-complete feature is
  // drawn dotted (reported, not verified) and never counts as accepted.
  assert.deepEqual(actor.currentView.scene.progress,
    { acceptedWeight: 0, pendingReviewWeight: 100, totalWeight: 100, planRevision: 1, milestones: ['review'] })
  const result = validateScene(actor.currentView.scene, 'engine')
  assert.deepEqual(result, [])
  assert.equal(ctx.supervisor.missionStore.events.some(e => e.type === 'milestone_accepted'), false)
  assert.equal(actor.handleAction('use_it').kind, 'rejected')
  assert.equal(actor.say('yes'), 'none')
  zeroLegacy(ctx)
})

await test('generic native/X approval creates a held ungranted intent', async () => {
  const ctx = runtime(undefined, broker(), { executionBackend: 'factory_native', workerPref: 'cursor' })
  await ctx.supervisor.boot()
  const a = await ctx.supervisor.submitCommand({ text: '  Exact   X words\nkeep spacing', source: 'x',
    sourceEventId: 'x-1', dedupeKey: 'x-event-1', startApproved: true })
  const b = await ctx.supervisor.submitCommand({ text: 'same delivered event', source: 'x',
    sourceEventId: 'x-1', dedupeKey: 'x-event-1', startApproved: true })
  assert.equal(a.receipt, 'saved')
  assert.equal(b.receipt, 'duplicate')
  assert.equal(a.missionId, b.missionId)
  assert.equal(mission(ctx).goal, '  Exact   X words\nkeep spacing')
  assert.equal(mission(ctx).config.nativeIntent.scopeApproved, false)
  assert.equal(mission(ctx).config.nativeIntent.highAutonomyApproved, false)
  assert.equal(mission(ctx).config.startApproved, undefined)
  assert.deepEqual(mission(ctx).config.workerProviders, ['factory'])
  assert.equal(ctx.native.prepared.length, 0)
  zeroLegacy(ctx)
})

await test('explicit intent identity cannot silently accept revised scope/grants', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  assert.equal((await ctx.supervisor.submitNativeIntent(intent())).receipt, 'duplicate')
  assert.equal((await ctx.supervisor.submitNativeIntent({ ...intent(), goal: 'Substantive corrected scope' })).receipt, 'rejected')
  assert.equal((await ctx.supervisor.submitNativeIntent({ ...intent(), policy: { ...intent().policy, allowPush: true } })).receipt, 'rejected')
  assert.equal(ctx.native.prepared.length, 1)
  assert.equal(mission(ctx).goal, intent().goal)
  zeroLegacy(ctx)
})

await test('answers bind indices/raw values/request identity, sent is not resolved', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const a = attention()
  for (const wrong of [
    { ...answer(a), requestId: 'different-rpc' }, { ...answer(a), machineId: 'different-machine' },
    { ...answer(a), revision: 0 }, { ...answer(a), payloadHash: 'different-hash' },
    { ...answer(a), answers: [{ index: 0, answer: 'raw_B' }, { index: 11, answer: '["feature1"]' }] },
    { ...answer(a), answers: [{ index: 7, answer: 'Same prefix B' }, { index: 11, answer: '["feature1"]' }] },
  ]) assert.equal((await ctx.supervisor.answerNative('native-1', wrong)).state, 'rejected')
  assert.equal(ctx.native.commands.length, 0)
  const sent = await ctx.supervisor.answerNative('native-1', answer(a))
  assert.equal(sent.state, 'confirmed')
  assert.deepEqual(ctx.native.commands[0].answer, answer(a))
  assert.equal(ctx.native.commands[0].expectedBrokerSeq, 1)
  assert.equal(ctx.native.commands[0].expectedScopeRevision, 1)
  assert.equal(ctx.supervisor.actor('native-1').hasPendingDecision, true)
  assert.equal(ctx.supervisor.nativeSnapshotFor('native-1').attention[0].state, 'answer_unknown')
  assert.equal(ctx.supervisor.missionStore.events.some(e => e.type === 'decision_answered'), false)
  ctx.native.value.attention = []
  ctx.native.value.brokerSeq++
  await read(ctx)
  assert.equal(ctx.supervisor.nativeSnapshotFor('native-1').completeness, 'gap')
  assert.equal(ctx.supervisor.actor('native-1').hasPendingDecision, true)
  ctx.native.value.attention = [{ ...a, state: 'resolved', resolvedAt: '2026-10-12T00:15:00.000Z' }]
  ctx.native.value.brokerSeq++
  ctx.native.value.commands = [sent]
  await read(ctx)
  assert.equal(ctx.supervisor.actor('native-1').hasPendingDecision, false)
  assert.ok(ctx.supervisor.missionStore.events.some(e => e.type === 'decision_answered' && e.payload.outcome === 'native_resolution_observed'))
  zeroLegacy(ctx)
})

await test('unknown answer survives restart without launch/answer replay', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  ctx.native.failCommand = true
  const receipt = await ctx.supervisor.answerNative('native-1', answer(attention()))
  assert.equal(receipt.state, 'unknown')
  const restarted = runtime(ctx.kv, ctx.native, { executionBackend: 'legacy', workerPref: 'cursor' })
  const boot = await restarted.supervisor.boot()
  await restarted.supervisor.flush()
  assert.deepEqual(boot.resumedStarts, [])
  assert.equal(ctx.native.prepared.length, 1)
  assert.equal(ctx.native.commands.length, 1)
  assert.equal(restarted.supervisor.actor('native-1').hasUnconfirmedDelivery, true)
  assert.equal((await restarted.supervisor.answerNative('native-1', answer(attention()))).state, 'rejected')
  assert.equal(ctx.native.commands.length, 1)
  zeroLegacy(restarted)
})

await test('unknown prepare only reconciles original job on boot', async () => {
  const ctx = runtime()
  ctx.native.failPrepare = true
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  assert.equal(ctx.supervisor.nativeCacheFor('native-1').prepareReceipt.state, 'unknown')
  const restored = runtime(ctx.kv, ctx.native)
  await restored.supervisor.boot(); await restored.supervisor.flush()
  assert.equal(ctx.native.prepared.length, 1)
  assert.equal(restored.supervisor.nativeCacheFor('native-1').prepareReceipt.state, 'confirmed')
  zeroLegacy(restored)
})

await test('successful unchanged reads refresh timestamps; failed reads do not', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const old = mission(ctx).lastObservedAt
  const events = ctx.supervisor.missionStore.events.length
  await read(ctx)
  assert.notEqual(mission(ctx).lastObservedAt, old)
  assert.equal(ctx.supervisor.missionStore.events.length, events)
  const at = mission(ctx).lastObservedAt
  ctx.native.observe = async () => { throw new Error('offline') }
  await read(ctx)
  assert.equal(mission(ctx).lastObservedAt, at)
  assert.notEqual(mission(ctx).freshness, 'current')
})

await test('broken local store pauses reads, refuses answers and says so on phone and glasses', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const actor = ctx.supervisor.actor('native-1')
  const events = ctx.supervisor.missionStore.events.length
  ctx.kv.failNextSets = 1
  ctx.native.value.brokerSeq++
  await read(ctx)
  assert.equal(ctx.supervisor.missionStore.durability, 'broken')
  const reads = ctx.native.reads.length
  await read(ctx); await read(ctx)
  assert.equal(ctx.native.reads.length, reads, 'no reads that can never be saved')
  const held = ctx.supervisor.nativeSnapshotFor('native-1')
  assert.match(held.holdReason, /Local save failed/)
  assert.equal(held.attention[0].state, 'open', 'cached request is shown, not resolved')
  assert.match(actor.currentView.scene.utterance, /Local save failed/)
  assert.match(actor.currentView.scene.status, /not saving/)
  assert.deepEqual(validateScene(actor.currentView.scene, 'engine'), [])
  assert.equal((await ctx.supervisor.answerNative('native-1', answer(attention()))).state, 'rejected')
  assert.equal(ctx.native.commands.length, 0)
  assert.equal(ctx.supervisor.missionStore.events.some((e, n) => n >= events &&
    e.payload?.kind === 'native_observation_quarantined'), false, 'storage failure is not misreported as quarantine')
})

await test('HTTP success cannot re-date stale broker/provider observation', async () => {
  const ctx = runtime()
  ctx.native.value.lastObservedAt = '2026-10-12T00:00:00.000Z'
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const observed = ctx.supervisor.nativeSnapshotFor('native-1')
  assert.equal(observed.lastObservedAt, '2026-10-12T00:00:00.000Z')
  assert.equal(ctx.supervisor.nativeCacheFor('native-1').lastClientObservedAt, new Date(ctx.clock.now).toISOString())
  assert.equal(mission(ctx).freshness, 'stale')
  assert.equal((await ctx.supervisor.answerNative('native-1', answer(attention()))).state, 'rejected')
  await read(ctx)
  assert.equal(ctx.supervisor.nativeSnapshotFor('native-1').lastObservedAt, observed.lastObservedAt)
  assert.equal(ctx.native.commands.length, 0)
})

await test('terminal observations keep persistent read-only finalization through restart', async () => {
  const ctx = runtime()
  ctx.native.value.attention = []
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  ctx.native.value.state = 'completed'; ctx.native.value.brokerSeq++
  await read(ctx)
  assert.equal(mission(ctx).phase, 'completed')
  assert.equal(ctx.supervisor.nativeSnapshotFor('native-1').finalization.state, 'pending')
  const restored = runtime(ctx.kv, ctx.native)
  await restored.supervisor.boot(); await restored.supervisor.flush()
  const reads = ctx.native.reads.length
  restored.clock.now += 130000
  await read(restored)
  assert.ok(ctx.native.reads.length > reads)
  assert.equal(restored.supervisor.nativeSnapshotFor('native-1').finalization.state, 'incomplete')
  assert.equal(ctx.native.commands.length, 0)
  assert.equal(ctx.native.prepared.length, 1)
  zeroLegacy(restored)
})

await test('stale/policy/pause gates do not send an implicit approval', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  ctx.clock.now += 31000
  assert.equal((await ctx.supervisor.answerNative('native-1', answer(attention()))).state, 'rejected')
  await read(ctx)
  ctx.native.value.control = 'paused'; ctx.native.value.state = 'paused'; ctx.native.value.brokerSeq++
  await read(ctx)
  assert.equal((await ctx.supervisor.answerNative('native-1', answer(attention()))).state, 'rejected')
  assert.equal(ctx.native.commands.length, 0)
  const held = runtime(undefined, broker())
  held.supervisor = new Supervisor({
    kv: held.kv, store: createRuntimeStore(held.kv), clients: held.clients, nativeClient: held.native,
    settings: () => held.config, policy: () => ({ revision: 'deny', allowLaunch: false, allowedRepositories: null }),
    emitView: () => {}, now: () => held.clock.now,
  })
  await held.supervisor.boot(); await held.supervisor.submitNativeIntent(intent())
  assert.equal(held.native.prepared.length, 0)
  zeroLegacy(held)
})

await test('nested decode quarantine prevents backend conversion or permission resurrection', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const raw = structuredClone(ctx.supervisor.missionStore.current)
  raw.engineSnapshots['native-1'].snapshot.attention[0].questions[0].options = [{ id: 'bad' }]
  assert.equal(decodeNativeCache(raw.engineSnapshots['native-1']), null)
  const decoded = validateSpriiteState(raw)
  assert.equal(decoded.missions[0].config.executionBackend, 'factory_native')
  assert.ok(decoded.missions[0].config.nativeQuarantine)
  assert.equal(decoded.missions[0].config.nativeIntent, undefined)
  const cleanKV = new TestKV()
  const store = createRuntimeStore(cleanKV)
  await store.load()
  assert.equal((await store.commit(() => ({ state: raw, events: [] }))).ok, true)
  const restored = runtime(cleanKV, ctx.native)
  await restored.supervisor.boot(); await restored.supervisor.flush()
  assert.equal(restored.supervisor.actor('native-1'), null)
  zeroLegacy(restored)
  for (const mutate of [
    s => { s.binding.cwd = 10 }, s => { s.commands = [{ commandId: 'x', state: 'made_up', reason: null }] },
    s => { s.finalization = { state: 'complete', summary: 'claim', reason: null, evidence: [{ verified: 'yes' }] } },
  ]) { const s = snapshot(); mutate(s); assert.equal(decodeNativeSnapshot(s), null) }
})

await test('native archives round-trip exact binding/grants/uncertainty without main/real shells', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  ctx.native.failCommand = true
  await ctx.supervisor.answerNative('native-1', answer(attention()))
  const sources = {
    missions: () => ctx.supervisor.missions, snapshotFor: id => ctx.supervisor.engineSnapshotFor(id),
    nativeCacheFor: id => ctx.supervisor.nativeCacheFor(id), chatTailFor: () => [], feed: () => [], receipts: () => [],
  }
  const rows = [...assembleRecords('mission:native-1', sources), ...assembleRecords('snapshot:native-1', sources)]
  const merged = mergeRestore(initialSpriiteState(), rows)
  assert.equal(merged.applied, 1)
  const m = merged.state.missions[0]
  assert.equal(m.config.executionBackend, 'factory_native')
  assert.equal(m.config.baseRef, 'develop')
  assert.equal(m.config.nativeProfile.brokerUrl, profile.brokerUrl)
  assert.deepEqual(m.config.nativeIntent, intent())
  assert.equal(merged.state.engineSnapshots['native-1'].pendingWrites[0].receipt.state, 'unknown')
  assert.equal(merged.state.engineSnapshots['native-1'].real, undefined)
  assert.equal(merged.state.engineSnapshots['native-1'].imported, true)
  assert.ok(validateSpriiteState(merged.state))
  const corrupt = structuredClone(rows)
  const parsed = JSON.parse(corrupt[1].json)
  parsed.cache.snapshot.binding = { sessionId: 'bad' }
  corrupt[1].json = JSON.stringify(parsed)
  assert.equal(mergeRestore(initialSpriiteState(), corrupt).applied, 0)
  assert.equal(mergeRestore(initialSpriiteState(), [rows[0]]).applied, 0)
  const relayRow = { ...rows[0] }
  delete relayRow.execution_backend // the existing relay ignores new columns
  assert.equal(mergeRestore(initialSpriiteState(), [relayRow]).applied, 0)
  assert.equal(mergeRestore(initialSpriiteState(), [relayRow, { ...rows[1], json: '{broken' }]).applied, 0)
  assert.equal(mergeRestore(initialSpriiteState(), [relayRow, rows[1]]).applied, 1)
  const legacyRow = { ...rows[0], execution_backend: 'legacy', updated_at: rows[0].updated_at + 1000 }
  assert.equal(mergeRestore(merged.state, [legacyRow]).applied, 0)
})

await test('HTTP seam freezes original URL, gets credentials lazily, and never replays writes', async () => {
  const calls = []
  let token = 'fixture-token-1'
  const fakeFetch = async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/capabilities')) return Response.json(capabilities)
    if (url.endsWith('/commands')) return new Response('', { status: 200 })
    return Response.json(snapshot())
  }
  const client = new HttpNativeBrokerClient({ brokerUrl: profile.brokerUrl, credential: () => token, fetch: fakeFetch })
  const ctx = runtime(undefined, client)
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-token-1')
  token = 'fixture-token-2'
  ctx.config.nativeProfile = { ...profile, brokerUrl: 'https://broker.new-default.test', cwd: '/other-checkout' }
  ctx.supervisor.configure(ctx.config)
  await read(ctx)
  assert.ok(calls.every(c => c.url.startsWith(profile.brokerUrl)))
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer fixture-token-2')
  assert.equal((await ctx.supervisor.answerNative('native-1', answer(attention()))).state, 'unknown')
  assert.equal(calls.filter(c => c.url.endsWith('/commands')).length, 1)
  const restoredClient = new HttpNativeBrokerClient({ brokerUrl: 'https://broker.new-default.test', credential: () => token, fetch: fakeFetch })
  const restored = runtime(ctx.kv, restoredClient, { nativeProfile: ctx.config.nativeProfile })
  await restored.supervisor.boot(); await restored.supervisor.flush()
  assert.ok(calls.at(-1).url.startsWith(profile.brokerUrl))
  assert.equal(calls.filter(c => c.url.endsWith('/commands')).length, 1)
  const serialized = JSON.stringify(restored.supervisor.missionStore.current)
  assert.equal(serialized.includes(token), false)
  zeroLegacy(restored)
})

await test('HTTP deadlines include body/credential waits; malformed success is unknown', async () => {
  let count = 0
  const hanging = new HttpNativeBrokerClient({ brokerUrl: profile.brokerUrl, credential: () => 'fixture',
    timeoutMs: 10, fetch: async () => { count++; return { ok: true, json: () => new Promise(() => {}) } } })
  await assert.rejects(hanging.prepare(intent()), e => e.outcome === 'unknown')
  assert.equal(count, 1)
  const credentialWait = new HttpNativeBrokerClient({ brokerUrl: profile.brokerUrl,
    credential: () => new Promise(() => {}), timeoutMs: 10, fetch: async () => { count++; return Response.json(snapshot()) } })
  await assert.rejects(credentialWait.prepare(intent()), e => e.outcome === 'rejected')
  assert.equal(count, 1)
  assert.throws(() => new HttpNativeBrokerClient({ brokerUrl: 'https://user:secret@broker.test', credential: () => '' }))
})

await test('RuntimeEngine native identity/history/answer API stays actor-neutral', async () => {
  const ctx = runtime()
  let engine
  ctx.supervisor = new Supervisor({
    store: createRuntimeStore(ctx.kv), kv: ctx.kv, clients: ctx.clients, nativeClient: ctx.native,
    settings: () => ctx.config, emitView: (id, view) => engine?.onMissionView(id, view), now: () => ctx.clock.now,
  })
  await ctx.supervisor.boot()
  const asks = []
  const lobby = {
    snapshot: () => ({ real: true, v: 1, phase: 'meet', jobs: [], chat: [], goal: '' }),
    currentView: { type: 'selection', purpose: 'projects', contextLabel: 'Home', title: 'Home', items: [], pose: 'idle' },
    boot() {}, reset() {}, canOpenBuilds: () => true, enableManagedWatchBuildHandoff() {},
    hasPendingDecision: false, chatLog: () => [], watching: () => false, watchOnly: () => false,
  }
  engine = new RuntimeEngine({ supervisor: ctx.supervisor, makeLobby: () => lobby,
    emit: () => {}, notice: () => {}, copy: { notSaved: 'Not saved', finishedRecord: 'Record' },
    onAsk: (id, title) => asks.push({ id, title }) })
  await engine.submitNativeIntent(intent())
  assert.equal(engine.nativeSnapshot().backend, 'factory_native')
  assert.equal(engine.snapshot().real, undefined)
  assert.equal(engine.presentation().questionIdentity.includes('rpc-ask-1'), true)
  assert.equal(engine.chatLogFor('native-1').log[0].text, intent().goal)
  assert.equal(engine.factorySessionLink(), 'https://app.factory.ai/sessions/root-native')
  engine.showHome()
  ctx.native.value.attention = [attention('replacement-identical-text')]
  ctx.native.value.brokerSeq++
  await read(ctx)
  assert.equal(asks.at(-1).id, 'native-1')
  assert.equal(engine.showMission('native-1'), true)
  assert.equal(await engine.answerNative(answer(attention('replacement-identical-text'))), false) // missing prior request creates a gap
  zeroLegacy(ctx)
})

await test('legacy/Cursor jobs keep their backend across changed native defaults', async () => {
  const ctx = runtime(undefined, broker(), { workerPref: 'cursor', nativeProfile: profile })
  await ctx.supervisor.boot()
  const receipt = await ctx.supervisor.submitCommand({ text: 'Legacy goal', source: 'phone_text', sourceEventId: 'legacy', dedupeKey: 'legacy' })
  await quiesce(); await ctx.supervisor.flush()
  const created = ctx.supervisor.missions[0]
  assert.equal(created.config.executionBackend, 'legacy')
  assert.deepEqual(created.config.workerProviders, ['cursor'])
  const restored = runtime(ctx.kv, ctx.native, { executionBackend: 'factory_native', workerPref: 'factory' })
  await restored.supervisor.boot(); await quiesce(); await restored.supervisor.flush()
  assert.equal(restored.supervisor.actor(receipt.missionId).backend, 'legacy')
  assert.deepEqual(restored.supervisor.missions[0].config.workerProviders, ['cursor'])
  assert.equal(ctx.native.prepared.length, 0)
})

await test('concurrent native taps produce one bound write, not replay', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const results = await Promise.all([
    ctx.supervisor.answerNative('native-1', answer(attention())),
    ctx.supervisor.answerNative('native-1', answer(attention())),
  ])
  assert.equal(results.filter(r => r.state === 'confirmed').length, 1)
  assert.equal(results.filter(r => r.state === 'rejected').length, 1)
  assert.equal(ctx.native.commands.length, 1)
  zeroLegacy(ctx)
})

await test('child questions route to their owning session, not the root link', async () => {
  const ctx = runtime()
  const a = { ...attention('child-request'), sessionId: 'exact child/session', associatedSessionIds: ['root-native'] }
  ctx.native.value.attention = [a]
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const actor = ctx.supervisor.actor('native-1')
  assert.equal(actor.nativeQuestionLink(), 'https://app.factory.ai/sessions/exact%20child%2Fsession')
  assert.equal((await ctx.supervisor.answerNative('native-1', answer(a))).state, 'confirmed')
  assert.equal(ctx.native.commands[0].answer.sessionId, a.sessionId)
  assert.equal(ctx.native.commands[0].answer.machineId, a.machineId)
  zeroLegacy(ctx)
})

await test('missing recovery/worker-attention qualification holds admission', async () => {
  for (const gate of ['rootAttention', 'childAttention', 'recoverAttention']) {
    const ctx = runtime()
    ctx.native.capabilities = async () => ({ ...capabilities, [gate]: false })
    await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
    assert.equal(ctx.native.prepared.length, 0)
    assert.equal(ctx.supervisor.nativeSnapshotFor('native-1').state, 'held')
    zeroLegacy(ctx)
  }
})

await test('unqualified revisioned native follow-ups retain caller/X drafts', async () => {
  const ctx = runtime()
  ctx.native.value.attention = []
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const actor = ctx.supervisor.actor('native-1')
  assert.equal(actor.say('Keep this complete correction; do not push.'), 'none')
  assert.equal(actor.steer('Keep the spoken draft.'), false)
  assert.equal(actor.followupReady, false)
  assert.equal(await actor.sendFollowup('Keep the targeted X draft.', () => true), 'deferred')
  assert.equal(ctx.native.commands.length, 0)
  zeroLegacy(ctx)
})

await test('legacy R05 uses successful reads, never restored/diff timestamps', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot()
  await ctx.supervisor.submitCommand({ text: 'Observed legacy goal', source: 'phone_text', sourceEventId: 'r05', dedupeKey: 'r05' })
  await quiesce()
  async function legacyRead() {
    ctx.clock.now += 6000
    ctx.supervisor.tick(ctx.clock.now)
    await quiesce()
    ctx.supervisor.tick(ctx.clock.now)
    await ctx.supervisor.flush()
  }
  await legacyRead()
  const first = mission(ctx).lastObservedAt
  assert.ok(first)
  await legacyRead()
  assert.notEqual(mission(ctx).lastObservedAt, first)
  const old = mission(ctx).lastObservedAt
  const restored = new Supervisor({
    kv: ctx.kv, store: createRuntimeStore(ctx.kv), clients: ctx.clients, nativeClient: ctx.native,
    settings: () => ctx.config, now: () => ctx.clock.now, emitView: () => {},
  })
  await restored.boot(); await restored.flush()
  assert.equal(restored.missions[0].lastObservedAt, old)
  assert.notEqual(restored.missions[0].freshness, 'current')
  const actor = restored.actor(mission(ctx).missionId)
  actor.engine.clients.getSession = async () => { throw Object.assign(new Error('read timeout'), { kind: 'timeout' }) }
  ctx.clock.now += 6000
  restored.tick(ctx.clock.now); await quiesce(); restored.tick(ctx.clock.now); await restored.flush()
  assert.equal(restored.missions[0].lastObservedAt, old)
})

await test('legacy R07 pending terminal observation survives boot and ends read-only at deadline', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot()
  const received = await ctx.supervisor.submitCommand({ text: 'Terminal observation goal', source: 'phone_text',
    sourceEventId: 'r07', dedupeKey: 'r07' })
  await quiesce(); await ctx.supervisor.flush()
  ctx.supervisor.tick(ctx.clock.now); await quiesce(); ctx.supervisor.tick(ctx.clock.now)
  await ctx.supervisor.flush()
  const actor = ctx.supervisor.actor(received.missionId)
  actor.engine.phase = 'final'
  actor.engine.awaiting = 'summary'
  actor.engine.finalSummary = ''
  ctx.supervisor.tick(ctx.clock.now)
  await ctx.supervisor.flush()
  assert.equal(mission(ctx).phase, 'completed')
  assert.equal(actor.observationPending, true)
  const key = `runtime.finalization.${received.missionId}`
  assert.equal(ctx.supervisor.missionStore.current.cursors[`${key}.status`], 'pending')
  const restored = new Supervisor({
    kv: ctx.kv, store: createRuntimeStore(ctx.kv), clients: ctx.clients, settings: () => ctx.config,
    now: () => ctx.clock.now, emitView: () => {},
  })
  const boot = await restored.boot(); await restored.flush()
  assert.ok(restored.actor(received.missionId))
  assert.deepEqual(boot.resumedStarts, [])
  assert.equal(restored.schedulerState.inFlight, 0)
  const before = { ...ctx.clients.counts }
  ctx.clock.now += 130000
  restored.tick(ctx.clock.now); await restored.flush()
  assert.equal(restored.missionStore.current.cursors[`${key}.status`], 'incomplete')
  assert.equal(restored.actor(received.missionId).observationPending, false)
  assert.equal(ctx.clients.counts.postMessage, before.postMessage)
  assert.equal(ctx.clients.counts.createSession, before.createSession)
})

await test('native proposal → start request replaces an unacknowledged mission briefing', async () => {
  const ctx = runtime()
  const proposal = attention('proposal-1', 'proposal')
  ctx.native.value.attention = [proposal]
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const scope = { kind: 'mission', missionId: 'native-1' }
  const old = await ctx.supervisor.getBriefing('phone', scope)
  assert.equal(requestCards(old)[0].nativeRequestKey, nativeBriefingRequestKey('native-1', proposal))
  const start = attention('start-1', 'start')
  ctx.native.value.attention = [{ ...proposal, state: 'resolved', resolvedAt: '2026-10-12T00:10:01.000Z' }, start]
  ctx.native.value.brokerSeq++
  await read(ctx)
  const next = await ctx.supervisor.getBriefing('phone', scope)
  assert.notEqual(next.briefingId, old.briefingId)
  assert.deepEqual(requestCards(next).map(c => c.nativeRequestKey), [nativeBriefingRequestKey('native-1', start)])
  assert.equal(ctx.native.commands.length, 0)
  zeroLegacy(ctx)
})

await test('same native attention id outruns old revision/hash/request/state keys', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const scope = { kind: 'mission', missionId: 'native-1' }
  let old = await ctx.supervisor.getBriefing('phone', scope)
  for (const changes of [
    { revision: 2, payloadHash: 'hash-revised' },
    { requestId: 'rpc-new', sessionId: 'exact-other-session' },
    { state: 'answer_unknown' },
  ]) {
    ctx.native.value.attention[0] = { ...ctx.native.value.attention[0], ...changes }
    ctx.native.value.brokerSeq++
    await read(ctx)
    const next = await ctx.supervisor.getBriefing('phone', scope)
    assert.notEqual(next.briefingId, old.briefingId)
    assert.equal(requestCards(next)[0].nativeRequestKey,
      nativeBriefingRequestKey('native-1', ctx.native.value.attention[0]))
    old = next
  }
  ctx.native.value.attention[0].state = 'open'
  ctx.native.value.brokerSeq++
  await read(ctx)
  // A transient open row is not evidence that an unknown answer can replay.
  assert.equal((await ctx.supervisor.getBriefing('phone', scope)).briefingId, old.briefingId)
  assert.equal(ctx.native.commands.length, 0)
  zeroLegacy(ctx)
})

await test('authoritatively resolved native request cannot keep asking without a replacement', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const old = await ctx.supervisor.getBriefing('phone')
  ctx.native.value.attention[0] = { ...attention(), state: 'resolved', resolvedAt: '2026-10-12T00:10:01.000Z' }
  ctx.native.value.brokerSeq++
  await read(ctx)
  const next = await ctx.supervisor.getBriefing('phone')
  assert.notEqual(next.briefingId, old.briefingId)
  assert.deepEqual(requestCards(next), [])
  assert.equal(next.cards.some(c => c.decisionId === 'ask-1'), false)
  assert.equal((await ctx.supervisor.getBriefing('glasses')).cards.some(c => c.decisionId === 'ask-1'), false)
  assert.equal(ctx.native.commands.length, 0)
  zeroLegacy(ctx)
})

await test('native coalescing isolates mission scopes while owner scope sees changed requests', async () => {
  const native = broker()
  const jobs = new Map()
  native.prepare = async i => {
    native.prepared.push(structuredClone(i))
    const value = snapshot(i)
    value.attention = [attention(`proposal-${i.missionId}`, 'proposal')]
    jobs.set(i.missionId, value)
    return structuredClone(value)
  }
  native.observe = async (id, owner) => {
    native.reads.push({ id, owner })
    return structuredClone(jobs.get(id))
  }
  const ctx = runtime(undefined, native)
  await ctx.supervisor.boot()
  await ctx.supervisor.submitNativeIntent(intent('native-1'))
  await ctx.supervisor.submitNativeIntent(intent('native-2'))
  const scoped = await ctx.supervisor.getBriefing('phone', { kind: 'mission', missionId: 'native-1' })
  const owner = await ctx.supervisor.getBriefing('glasses')
  const changed = jobs.get('native-2')
  changed.attention[0] = { ...changed.attention[0], revision: 2, payloadHash: 'scope-2-only', state: 'answer_unknown' }
  changed.brokerSeq++
  await read(ctx)
  assert.equal((await ctx.supervisor.getBriefing('phone', { kind: 'mission', missionId: 'native-1' })).briefingId, scoped.briefingId)
  const nextOwner = await ctx.supervisor.getBriefing('glasses')
  assert.notEqual(nextOwner.briefingId, owner.briefingId)
  assert.ok(requestCards(nextOwner).some(c => c.nativeRequestKey === nativeBriefingRequestKey('native-2', changed.attention[0])))
  assert.equal(native.commands.length, 0)
  zeroLegacy(ctx)
})

await test('native key invalidation preserves legacy decision fixed-target coalescing', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const initial = await ctx.supervisor.getBriefing('phone')
  const d = { schemaVersion: 2, decisionId: 'legacy-owner-choice', missionId: null, revision: 1,
    question: 'A legacy owner choice?', options: [{ optionId: 'legacy-option', label: 'Proceed' }],
    scope: 'legacy', consequence: 'Read only fixture', expiryAt: null,
    openedAt: new Date(ctx.clock.now).toISOString(), answeredAt: null, answerOptionId: null, answerText: null }
  await ctx.supervisor.missionStore.commit(s => ({
    state: { ...s, decisions: [...s.decisions, d] },
    events: [draftEvent('decision_opened', {}, { entityId: 'legacy-owner-choice' })],
  }))
  const open = await ctx.supervisor.getBriefing('phone')
  assert.notEqual(open.briefingId, initial.briefingId)
  assert.ok(open.cards.some(c => c.decisionId === d.decisionId && c.nativeRequestKey === undefined))
  await ctx.supervisor.missionStore.commit(s => ({
    state: { ...s, decisions: s.decisions.map(row => row.decisionId === d.decisionId ?
      { ...row, answeredAt: new Date(ctx.clock.now).toISOString(), answerOptionId: 'legacy-option' } : row) },
    events: [],
  }))
  assert.equal((await ctx.supervisor.getBriefing('glasses')).briefingId, open.briefingId)
  zeroLegacy(ctx)
})

await test('terminal summary is an unverified report, never authoritative readiness or delivery', async () => {
  const ctx = runtime()
  const providerSummary = 'Your app is ready for production and delivered.'
  Object.assign(ctx.native.value, { state: 'completed', attention: [],
    finalization: { state: 'incomplete', summary: providerSummary, evidence: [], completedAt: null, reason: null } })
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const actor = ctx.supervisor.actor('native-1')
  const scene = actor.currentView.scene
  assert.deepEqual(validateScene(scene, 'engine'), [])
  assert.equal(scene.kind, 'final')
  // Unverified completion: the bar shows the report dotted, nothing accepted.
  assert.equal(scene.progress.acceptedWeight, 0)
  assert.equal(scene.progress.milestones.includes('done'), false)
  assert.equal(scene.contextDetail, 'DONE')
  // An unverified finish has not landed: no celebration (MotionLab).
  assert.equal(scene.spritePose, 'blocked')
  assert.deepEqual(scene.actions.map(a => `${a.id}:${a.label}`), ['chat:Read summary', 'restart:Next idea', 'show_evidence:Evidence'])
  assert.match(scene.utterance, /Factory reports completion/)
  assert.equal(scene.utterance.includes('Your app'), false)
  assert.match(scene.utterance, /incomplete|not verified/)
  assert.match(actor.presentation.finalSummary, /Provider summary \(unverified report\): Your app/)
  actor.handleAction('read_native')
  assert.equal(actor.currentView.type, 'selection')
  assert.ok(actor.currentView.items.includes(`Provider summary (unverified report): ${providerSummary}`))
  assert.equal(actor.currentView.items.includes(providerSummary), false)
  const f = { state: 'complete', summary: providerSummary, evidence: [
    { id: 'artifact-1', kind: 'file', url: 'https://example.test/artifact', commitSha: null, verified: true },
  ], completedAt: '2026-10-12T00:10:00.000Z', reason: null }
  for (const value of [
    { ...ctx.native.value, finalization: { ...f, evidence: [] } },
    { ...ctx.native.value, finalization: { ...f, evidence: [{ ...f.evidence[0], verified: false }] } },
    { ...ctx.native.value, finalization: { ...f, evidence: [{ ...f.evidence[0], url: '' }] } },
    { ...ctx.native.value, finalization: { ...f, state: 'incomplete' } },
    { ...ctx.native.value, finalization: f, capabilities: { ...capabilities, qualified: false } },
    { ...ctx.native.value, finalization: f, completeness: 'gap' },
  ]) {
    assert.equal(nativeArtifactsVerified(value), false)
    assert.match(nativeTerminalCopy(value), /incomplete|not verified/)
  }
  const verified = { ...ctx.native.value, finalization: f }
  assert.equal(nativeArtifactsVerified(verified), true)
  assert.match(nativeTerminalCopy(verified), /artifact evidence is verified; no production or publication claim/)
  assert.match(nativePresentation(verified).finalSummary, /Provider summary \(unverified report\)/)
  zeroLegacy(ctx)
})

await test('cancelled native work is not presented or journalled as completion', async () => {
  for (const state of ['running', 'completed']) {
    const ctx = runtime()
    Object.assign(ctx.native.value, { state, control: 'cancelled', attention: [], finalization: null })
    await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
    const actor = ctx.supervisor.actor('native-1')
    assert.equal(mission(ctx).phase, 'cancelled')
    assert.equal(actor.presentation.phase, 'cancelled')
    assert.match(actor.currentView.scene.utterance, /^Factory reports cancellation/)
    assert.equal(actor.currentView.scene.utterance.includes('Factory reports completion'), false)
    assert.equal(actor.currentView.scene.status.includes('pending'), false)
    assert.equal(ctx.supervisor.missionStore.events.some(e => e.type === 'mission_completed'), false)
    zeroLegacy(ctx)
  }
})

await test('fresh complete observation emits exact recovery and replaces stale outage briefing', async () => {
  const ctx = runtime()
  ctx.native.value.attention = []
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const observe = ctx.native.observe
  ctx.native.observe = async () => { throw new Error('offline') }
  await read(ctx)
  const block = ctx.supervisor.nativeCacheFor('native-1').observationBlock
  assert.equal(block.kind, 'native_observation_unavailable')
  const old = await ctx.supervisor.getBriefing('phone', { kind: 'mission', missionId: 'native-1' })
  assert.ok(old.cards.some(c => /native_observation_unavailable/.test(c.headline)))
  ctx.native.observe = observe
  await read(ctx)
  const recovery = recoveryEvents(ctx)
  assert.equal(recovery.length, 1)
  assert.equal(recovery[0].payload.recoveredKind, block.kind)
  assert.equal(recovery[0].payload.recoveredEventId, block.eventId)
  assert.equal(ctx.supervisor.nativeCacheFor('native-1').observationBlock, null)
  const next = await ctx.supervisor.getBriefing('phone', { kind: 'mission', missionId: 'native-1' })
  assert.notEqual(next.briefingId, old.briefingId)
  assert.equal(next.cards.some(c => /native_observation_unavailable|stopped/.test(c.headline)), false)
  await read(ctx)
  assert.equal(recoveryEvents(ctx).length, 1)
  zeroLegacy(ctx)
})

await test('observation-only recovery survives actor/store restart without write replay', async () => {
  const ctx = runtime()
  ctx.native.value.attention = []
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const observe = ctx.native.observe
  ctx.native.observe = async () => { throw new Error('offline before restart') }
  await read(ctx)
  const block = ctx.supervisor.nativeCacheFor('native-1').observationBlock
  await ctx.supervisor.getBriefing('phone')
  ctx.supervisor.actor('native-1').dispose()
  ctx.native.observe = observe
  const restored = runtime(ctx.kv, ctx.native)
  await restored.supervisor.boot(); await restored.supervisor.flush()
  assert.equal(recoveryEvents(restored).length, 1)
  assert.equal(recoveryEvents(restored)[0].payload.recoveredEventId, block.eventId)
  assert.equal(restored.supervisor.nativeCacheFor('native-1').observationBlock, null)
  assert.equal((await restored.supervisor.getBriefing('phone')).cards.some(c => /native_observation_unavailable/.test(c.headline)), false)
  assert.equal(ctx.native.prepared.length, 1)
  assert.equal(ctx.native.commands.length, 0)
  zeroLegacy(restored)
})

await test('observation recovery does not erase local unqualified or provider workspace holds', async () => {
  for (const kind of ['unqualified', 'workspace']) {
    const ctx = runtime()
    ctx.native.value.attention = []
    if (kind === 'unqualified') {
      ctx.native.capabilities = async () => ({ ...capabilities, qualified: false })
    } else {
      ctx.native.value.state = 'held'
      ctx.native.value.holdReason = 'Workspace approval required'
    }
    await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
    const reason = ctx.supervisor.nativeSnapshotFor('native-1').holdReason
    const observe = ctx.native.observe
    ctx.native.observe = async () => { throw new Error('temporary observation outage') }
    await read(ctx)
    const old = await ctx.supervisor.getBriefing('phone')
    ctx.native.observe = observe
    await read(ctx)
    assert.equal(recoveryEvents(ctx).length, 1)
    assert.equal(ctx.supervisor.nativeSnapshotFor('native-1').holdReason, reason)
    const retained = ctx.supervisor.missionStore.events.find(e =>
      e.payload.retainedAfterObservationRecovery === true)
    assert.ok(retained.seq > recoveryEvents(ctx)[0].seq)
    assert.equal(retained.payload.reason, reason)
    const next = await ctx.supervisor.getBriefing('phone')
    assert.notEqual(next.briefingId, old.briefingId)
    assert.ok(next.cards.some(c => c.rank === 1 && /native_hold/.test(c.headline)))
    assert.equal(next.cards.some(c => /native_observation_unavailable/.test(c.headline)), false)
    assert.equal(ctx.native.commands.length, 0)
    zeroLegacy(ctx)
  }
})

await test('incomplete, stale and quarantined observations cannot claim recovery; read latch clears on errors', async () => {
  const ctx = runtime()
  ctx.native.value.attention = []
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const observe = ctx.native.observe
  ctx.native.observe = async () => { throw new Error('offline') }
  await read(ctx)
  ctx.native.observe = observe
  ctx.native.value.completeness = 'gap'
  await read(ctx)
  assert.equal(recoveryEvents(ctx).length, 0)
  assert.equal(ctx.supervisor.nativeCacheFor('native-1').observationBlock.kind, 'native_observation_gap')
  ctx.native.value.completeness = 'complete'
  ctx.native.value.lastObservedAt = new Date(ctx.clock.now - 31000).toISOString()
  await read(ctx)
  assert.equal(recoveryEvents(ctx).length, 0)
  assert.match(ctx.supervisor.actor('native-1').currentView.scene.status, /Last known/)
  ctx.native.value.binding.cwd = '/wrong-workspace'
  await read(ctx)
  assert.equal(recoveryEvents(ctx).length, 0)
  assert.equal(ctx.supervisor.nativeCacheFor('native-1').observationBlock.kind, 'native_observation_quarantined')
  assert.equal(ctx.supervisor.nativeCacheFor('native-1').localHoldReason, null)
  ctx.native.value.binding.cwd = profile.cwd
  ctx.native.value.lastObservedAt = new Date(ctx.clock.now).toISOString()
  await read(ctx)
  assert.equal(recoveryEvents(ctx).length, 1)
  assert.equal(ctx.supervisor.nativeSnapshotFor('native-1').holdReason, null)
  assert.equal(ctx.native.prepared.length, 1)
  zeroLegacy(ctx)
})

await test('12 ticks during delayed prepare coalesce one read and do not bury owner answer', async () => {
  const ctx = runtime()
  const prepareGate = deferred(), readGate = deferred()
  ctx.native.prepare = async i => {
    ctx.native.prepared.push(structuredClone(i))
    await prepareGate.promise
    return structuredClone(ctx.native.value)
  }
  ctx.native.observe = async (id, owner) => {
    ctx.native.reads.push({ id, owner })
    await readGate.promise
    return structuredClone(ctx.native.value)
  }
  await ctx.supervisor.boot()
  const submission = ctx.supervisor.submitNativeIntent(intent())
  await until(() => ctx.native.prepared.length === 1, 'delayed prepare')
  for (let n = 0; n < 12; n++) {
    ctx.clock.now += 250
    ctx.supervisor.tick(ctx.clock.now)
  }
  assert.equal(ctx.native.reads.length, 0)
  prepareGate.resolve()
  assert.equal((await submission).receipt, 'saved')
  await until(() => ctx.native.reads.length === 1, 'one scheduled read')
  const ownerAnswer = ctx.supervisor.answerNative('native-1', answer(attention()))
  readGate.resolve()
  assert.equal((await ownerAnswer).state, 'confirmed')
  await ctx.supervisor.flush()
  assert.equal(ctx.native.reads.length, 1)
  assert.equal(ctx.native.commands.length, 1)
  assert.equal(ctx.native.prepared.length, 1)
  ctx.supervisor.actor('native-1').dispose()
  ctx.clock.now += 6000; ctx.supervisor.tick(ctx.clock.now); await ctx.supervisor.flush()
  assert.equal(ctx.native.reads.length, 1)
  zeroLegacy(ctx)
})

await test('12 ticks during delayed command coalesce one read while owner navigation/actions remain usable', async () => {
  const ctx = runtime()
  const commandGate = deferred(), readGate = deferred()
  ctx.native.command = async c => {
    ctx.native.commands.push(structuredClone(c))
    if (ctx.native.commands.length === 1) await commandGate.promise
    return { commandId: c.commandId, state: 'confirmed', reason: null }
  }
  ctx.native.observe = async (id, owner) => {
    ctx.native.reads.push({ id, owner })
    await readGate.promise
    return structuredClone(ctx.native.value)
  }
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const first = ctx.supervisor.answerNative('native-1', answer(attention()))
  await until(() => ctx.native.commands.length === 1, 'delayed command')
  for (let n = 0; n < 12; n++) {
    ctx.clock.now += 250
    ctx.supervisor.tick(ctx.clock.now)
  }
  const actor = ctx.supervisor.actor('native-1')
  assert.equal(actor.handleAction('read_native').kind, 'forwarded')
  assert.equal(actor.currentView.type, 'selection')
  assert.equal(ctx.native.reads.length, 0)
  commandGate.resolve()
  assert.equal((await first).state, 'confirmed')
  await until(() => ctx.native.reads.length === 1, 'one read after delayed command')
  const next = attention('ask-next')
  ctx.native.value.attention = [{ ...attention(), state: 'resolved', resolvedAt: new Date(ctx.clock.now).toISOString() }, next]
  ctx.native.value.brokerSeq++
  readGate.resolve()
  await ctx.supervisor.flush()
  assert.equal(ctx.native.reads.length, 1)
  assert.equal((await ctx.supervisor.answerNative('native-1', answer(next))).state, 'confirmed')
  assert.equal(ctx.native.commands.length, 2)
  assert.equal(ctx.native.commands[1].expectedBrokerSeq, 2)
  zeroLegacy(ctx)
})

await test('disposal releases a scheduled read and ignores its late observation/error', async () => {
  for (const outcome of ['success', 'error']) {
    const ctx = runtime()
    const gate = deferred()
    ctx.native.observe = async (id, owner) => {
      ctx.native.reads.push({ id, owner })
      await gate.promise
      return structuredClone(ctx.native.value)
    }
    await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
    ctx.clock.now += 6000; ctx.supervisor.tick(ctx.clock.now)
    await until(() => ctx.native.reads.length === 1, 'read before disposal')
    const actor = ctx.supervisor.actor('native-1')
    const seq = ctx.supervisor.missionStore.journalSeq, views = ctx.views.length
    actor.dispose()
    assert.equal(actor.readScheduled, false)
    ctx.native.value.brokerSeq++
    if (outcome === 'success') gate.resolve()
    else gate.reject(new Error('late read failure after disposal'))
    await ctx.supervisor.flush()
    assert.equal(ctx.supervisor.missionStore.journalSeq, seq)
    assert.equal(ctx.views.length, views)
    assert.equal(actor.snapshot.brokerSeq, 1)
    ctx.clock.now += 6000; ctx.supervisor.tick(ctx.clock.now); await ctx.supervisor.flush()
    assert.equal(ctx.native.reads.length, 1)
    zeroLegacy(ctx)
  }
})

// Mission v2 as projected by the broker: same attention kinds, checks as features.
const v2Checks = (statuses = ['pending', 'pending', 'pending']) => [
  { id: 'badge-renders', description: 'The badge renders.', milestone: 'build', expectedBehavior: ['Open the page.'] },
  { id: 'tests-pass', description: 'The tests pass.', milestone: 'quality', expectedBehavior: ['Run npm test.'] },
  { id: 'docs-updated', description: 'The README is updated.', milestone: 'quality', expectedBehavior: [] },
].map((f, i) => ({ ...f, status: statuses[i] }))
const v2Recommend = () => ({ ...attention('recommend-1', 'permission'), title: 'Plan as a Factory Mission',
  details: 'Several files change and tests are needed, so planning as a Mission is recommended.',
  options: [{ id: 'proceed_once', label: 'Start Mission planning', value: 'proceed_once' },
    { id: 'cancel', label: 'Continue normally', value: 'cancel' }] })
const v2Plan = (details = 'Plan text.\n\nChecks:\n- [build] badge-renders: The badge renders.') => ({
  ...attention('plan-1', 'proposal'), title: 'Build status badge', details,
  options: [{ id: 'proceed_once', label: 'Approve Mission', value: 'proceed_once' },
    { id: 'cancel', label: 'Request changes', value: 'cancel' }] })
async function readFresh(ctx, change) {
  change?.(ctx.native.value)
  ctx.native.value.brokerSeq++
  ctx.native.value.lastObservedAt = new Date(ctx.clock.now + 6000).toISOString()
  await read(ctx)
}
const resolved = (a, ctx) => ({ ...a, state: 'resolved', resolvedAt: new Date(ctx.clock.now).toISOString() })

await test('v2 recommend permission answers proceed_once and keeps provider labels', async () => {
  const ctx = runtime()
  Object.assign(ctx.native.value, { state: 'awaiting_input', features: [], attention: [v2Recommend()] })
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const actor = ctx.supervisor.actor('native-1')
  assert.equal(actor.currentView.scene.kind, 'decision')
  assert.match(actor.currentView.scene.utterance, /^Plan as a Factory Mission\. 1 request; answer on phone\./)
  assert.deepEqual(actor.presentation.decisionOptions, ['Start Mission planning', 'Continue normally'])
  actor.handleAction('read_native')
  assert.ok(actor.currentView.items.includes('Start Mission planning (proceed_once)'))
  assert.ok(actor.currentView.items.includes('Continue normally (cancel)'))
  actor.back()
  const sent = await ctx.supervisor.answerNative('native-1', answer(v2Recommend()))
  assert.equal(sent.state, 'confirmed')
  assert.equal(ctx.native.commands[0].answer.selectedOption, 'proceed_once')
  await readFresh(ctx, v => {
    v.state = 'awaiting_input'
    v.attention = [resolved(v2Recommend(), ctx), v2Plan()]
    v.commands = [sent]
  })
  assert.equal(actor.snapshot.attention.find(a => a.attentionId === 'plan-1').state, 'open')
  assert.ok(ctx.supervisor.missionStore.events.some(e => e.type === 'decision_answered' && e.payload.decisionId === 'recommend-1'))
  zeroLegacy(ctx)
})

await test('v2 plan approval starts the run with no start request; a long plan stays bounded on glasses', async () => {
  const ctx = runtime()
  const para = 'This paragraph explains part of the plan in enough words to wrap across several glasses rows. '
  const long = [...Array.from({ length: 400 }, (_, i) => `Step ${i + 1}. ${para.repeat(1 + (i % 3))}`),
    'Checks:', ...v2Checks().map(c => `- [${c.milestone}] ${c.id}: ${c.description}`)].join('\n\n')
  assert.ok(long.length > 60000)
  const plan = v2Plan(long)
  Object.assign(ctx.native.value, { state: 'awaiting_input', features: [], attention: [plan] })
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const actor = ctx.supervisor.actor('native-1')
  assert.deepEqual(validateScene(actor.currentView.scene, 'engine'), [])
  actor.handleAction('read_native')
  const view = actor.currentView
  assert.equal(view.type, 'selection')
  const { getTextWidth } = await import('@evenrealities/pretext')
  const { SELECTION_ROW_W } = await import('../src/render/layout.ts')
  assert.ok(view.items.length <= 30, `bounded rows, got ${view.items.length}`)
  assert.ok(view.items.every(row => !row.includes('\n') && getTextWidth(`> ${row}`) <= SELECTION_ROW_W), 'one HUD row each')
  assert.ok(view.items.includes('More text: read the full request on the phone.'))
  assert.deepEqual(view.items.slice(-2), ['Approve Mission (proceed_once)', 'Request changes (cancel)'])
  assert.equal(actor.snapshot.attention[0].details, long, 'full plan text is retained for the phone')
  actor.back()
  const sent = await ctx.supervisor.answerNative('native-1', answer(plan))
  assert.equal(sent.state, 'confirmed')
  await readFresh(ctx, v => {
    v.state = 'running'
    v.attention = [resolved(plan, ctx)]
    v.features = v2Checks()
    v.commands = [sent]
  })
  assert.equal(actor.hasPendingDecision, false)
  assert.equal(actor.observationPending, false)
  assert.equal(mission(ctx).phase, 'building')
  const scene = actor.currentView.scene
  assert.equal(scene.kind, 'running')
  assert.deepEqual(validateScene(scene, 'engine'), [])
  assert.match(scene.status, /^running · 0\/3 done$/)
  assert.match(scene.utterance, /Factory reports 0 of 3 features or checks done\. Not verified acceptance\./)
  assert.equal(ctx.native.commands.length, 1, 'no start answer is sent or awaited')
  zeroLegacy(ctx)
})

await test('native asks name the asking session, and only a landed build celebrates', async () => {
  const ctx = runtime()
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const actor = ctx.supervisor.actor('native-1')
  assert.equal(actor.currentView.scene.contextLabel, 'LEAD ASKS', 'the root session asks as the Lead')
  await readFresh(ctx, v => { v.attention = v.attention.map(a => ({ ...a, sessionId: 'child-worker' })) })
  assert.equal(actor.currentView.scene.contextLabel, 'WORKER ASKS', 'a child session asks as a worker')
  const done = (over) => ({ attention: [], control: 'running', state: 'completed', delivery: null, finalization: null, ...over })
  const o = { evaluating: false, storageBroken: false, linkFresh: true }
  assert.equal(nativePose(done({ delivery: { step: 'merged' } }), { ...o, delivered: true }), 'celebrate', 'merged: the build landed')
  assert.equal(nativePose(done({ delivery: { step: 'pr_open' } }), { ...o, delivered: false }), 'checking', 'a PR still open is checking, not celebrating')
  assert.equal(nativePose(done({ delivery: { step: 'not_merged' } }), { ...o, delivered: false }), 'blocked', 'not merged is not a landing')
  assert.equal(nativePose(done({ finalization: { state: 'incomplete' } }), { ...o, delivered: false }), 'blocked', 'unverified evidence is not a landing')
  assert.equal(nativePose(done({ delivery: { step: 'merged' } }), { ...o, linkFresh: false, delivered: true }), 'offline', 'a dropped host link dozes, finished or not')
})

await test('native cards follow HudRun/HudDone and the MotionLab moments', async () => {
  const four = statuses => [...v2Checks(statuses.slice(0, 3)),
    { id: 'pr-opened', description: 'A pull request is open.', milestone: 'delivery', expectedBehavior: [], status: statuses[3] }]
  const ctx = runtime()
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const actor = ctx.supervisor.actor('native-1')
  // A question waiting for the owner: Asking (never the microphone pose).
  assert.equal(actor.currentView.scene.kind, 'decision')
  assert.equal(actor.currentView.scene.spritePose, 'asking')
  assert.equal(actor.currentView.scene.contextLabel, 'LEAD ASKS')
  actor.handleAction('read_native')
  assert.equal(actor.currentView.pose, 'asking')
  actor.back()
  // Factory coding: Building, the build title left and PHASE · N OF M right.
  await readFresh(ctx, v => { v.attention = v.attention.map(a => resolved(a, ctx)); v.state = 'running'; v.features = four(['completed', 'completed', 'in_progress', 'pending']) })
  let scene = actor.currentView.scene
  assert.deepEqual(validateScene(scene, 'engine'), [])
  assert.equal(scene.kind, 'running')
  assert.equal(scene.spritePose, 'building')
  assert.equal(scene.contextLabel, 'KEEP ALL OWNER WORDS')
  assert.equal(scene.contextDetail, 'BUILDING · 2 OF 4')
  assert.deepEqual(scene.progress.milestones, ['review', 'review', 'todo', 'todo'], 'reported done is dotted, never solid accepted')
  assert.equal(scene.progress.acceptedWeight, 0)
  assert.deepEqual(scene.actions.map(a => `${a.id}:${a.label}`), ['pause:Pause', 'milestones:Milestones'])
  assert.equal(actor.handleAction('milestones').kind, 'forwarded')
  assert.equal(actor.currentView.type, 'selection', 'Milestones opens the reported progress')
  actor.back()
  // You paused the build: Paused.
  await readFresh(ctx, v => { v.control = 'paused'; v.state = 'paused' })
  scene = actor.currentView.scene
  assert.equal(scene.kind, 'paused')
  assert.equal(scene.spritePose, 'paused')
  assert.equal(scene.contextDetail, 'PAUSED · 2 OF 4')
  assert.equal(scene.actions[0].id, 'resume')
  // The build lands: Celebrating, DONE, Read summary / Next idea / Evidence.
  await readFresh(ctx, v => {
    v.control = 'running'; v.state = 'completed'; v.features = four(['completed', 'completed', 'completed', 'completed'])
    v.finalization = { state: 'complete', summary: 'Done.', evidence: [
      { id: 'artifact-1', kind: 'file', url: 'https://example.test/artifact', commitSha: null, verified: true }],
    completedAt: new Date(ctx.clock.now).toISOString(), reason: null }
  })
  scene = actor.currentView.scene
  assert.deepEqual(validateScene(scene, 'engine'), [])
  assert.equal(scene.kind, 'final')
  assert.equal(scene.spritePose, 'celebrate')
  assert.equal(scene.contextDetail, 'DONE')
  assert.deepEqual(scene.actions.map(a => a.label), ['Read summary', 'Next idea', 'Evidence'])
  assert.equal(nativeArtifactsVerified(ctx.native.value), true)
  assert.deepEqual(scene.progress.milestones, ['done', 'done', 'done', 'done'], 'verified evidence draws the full bar')
  zeroLegacy(ctx)
  // The host link dropped on a running build: Offline (dim, dozing).
  const off = runtime()
  Object.assign(off.native.value, { attention: [], features: v2Checks() })
  await off.supervisor.boot(); await off.supervisor.submitNativeIntent(intent())
  assert.equal(off.supervisor.actor('native-1').currentView.scene.spritePose, 'building')
  off.native.observe = async () => { throw new Error('offline') }
  off.clock.now += 60000
  await read(off)
  assert.match(off.supervisor.actor('native-1').currentView.scene.status, /Last known/)
  assert.equal(off.supervisor.actor('native-1').currentView.scene.spritePose, 'offline')
})

await test('v2 unmet check is never counted or shown as done', async () => {
  const ctx = runtime()
  Object.assign(ctx.native.value, { attention: [], features: v2Checks() })
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const actor = ctx.supervisor.actor('native-1')
  await readFresh(ctx, v => { v.features = v2Checks(['completed', 'unmet', 'pending']) })
  const scene = actor.currentView.scene
  assert.deepEqual(validateScene(scene, 'engine'), [])
  assert.equal(scene.status, 'running · 1/3 done · 1 unmet')
  assert.match(scene.utterance, /1 of 3 features or checks done; 1 unmet\. Not verified acceptance\./)
  const changed = ctx.supervisor.missionStore.events.filter(e => e.type === 'native_features_changed').at(-1)
  assert.equal(changed.payload.reportedComplete, 1)
  assert.equal(changed.payload.reportedUnmet, 1)
  actor.handleAction('read_native')
  const rows = actor.currentView.items
  assert.equal(rows[0], 'Reported: 1/3 done · 1 unmet')
  assert.ok(rows.includes('unmet · quality: The tests pass.'))
  assert.ok(rows.includes('done · build: The badge renders.'))
  assert.equal(rows.some(r => /tests pass/.test(r) && r.startsWith('done')), false)
  assert.ok(decodeNativeSnapshot({ ...ctx.native.value, features: v2Checks(['unmet', 'unmet', 'unmet']) }))
  assert.equal(decodeNativeSnapshot({ ...ctx.native.value, features: v2Checks(['met', 'pending', 'pending']) }), null,
    'raw v2 outcomes stay strict; only the projected statuses decode')
  await readFresh(ctx, v => { v.features = v2Checks(['completed', 'completed', 'cancelled']) })
  assert.equal(actor.snapshot.features[2].status, 'cancelled')
  assert.equal(actor.currentView.items[0], 'Reported: 2/3 done · 1 cancelled/waived')
  zeroLegacy(ctx)
})

await test('v2 completion shows final checks and no delivery claim', async () => {
  const ctx = runtime()
  Object.assign(ctx.native.value, { attention: [], features: v2Checks(['completed', 'unmet', 'completed']) })
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const actor = ctx.supervisor.actor('native-1')
  await readFresh(ctx, v => {
    v.state = 'completed'
    v.features = v2Checks(['completed', 'completed', 'completed'])
  })
  const scene = actor.currentView.scene
  assert.equal(scene.kind, 'final')
  assert.deepEqual(validateScene(scene, 'engine'), [])
  assert.match(scene.utterance, /Factory reports completion\. Read-only evidence collection is pending; delivery is not verified\./)
  assert.ok(ctx.supervisor.missionStore.events.some(e => e.type === 'mission_completed'))
  actor.handleAction('read_native')
  assert.equal(actor.currentView.purpose, 'evidence')
  assert.ok(actor.currentView.items.includes('Reported: 3/3 done'))
  zeroLegacy(ctx)
})

const MORE = 'More text: read the full request on the phone.'
const { getTextWidth: widthOf } = await import('@evenrealities/pretext')
const { SELECTION_ROW_W: ROW_W } = await import('../src/render/layout.ts')
const oneHudRow = rows => rows.every(row => !row.includes('\n') && widthOf(`> ${row}`) <= ROW_W)

await test('unspaced CJK and long URLs wrap by grapheme without losing text; cut text always says More', async () => {
  const han = '工厂任务计划说明每一步都需要完整保留不能在眼镜上被悄悄丢弃'
  const paragraphs = [0, 1, 2].map(i => `${i}${han.repeat(10)}`.slice(0, 300))
  const rows = nativeDetailRows(paragraphs.join('\n\n'))
  assert.equal(rows.length, 26)
  assert.equal(rows.at(-1), MORE)
  assert.ok(oneHudRow(rows))
  const shown = rows.slice(0, -1).join('')
  assert.ok(shown.length > 300, 'more than the first paragraph is shown')
  assert.equal(shown, paragraphs.join('').slice(0, shown.length), 'every CJK character up to the cap is kept in order')
  const url = `https://example.test/${Array.from({ length: 60 }, (_, i) => `segment-${i}`).join('/')}?q=1`
  const urlRows = nativeDetailRows(`See ${url} for the plan.`)
  assert.ok(urlRows.length > 2 && !urlRows.includes(MORE))
  assert.ok(oneHudRow(urlRows))
  assert.equal(urlRows[0], 'See')
  assert.equal(urlRows.join(''), `See${url} for the plan.`, 'URL wraps across rows without loss')
  const exact = nativeDetailRows(Array.from({ length: 25 }, (_, i) => `Row ${i}.`).join('\n'))
  assert.equal(exact.length, 25, 'text that fills the cap exactly adds no More row')
  assert.equal(nativeDetailRows(`${'Step. '.repeat(10)}\n${url.repeat(40)}`).at(-1), MORE)
})

await test('64KB emoji/CJK details and 8KB check descriptions stay bounded and fast', async () => {
  nativeDetailRows('warm 😀 工')
  for (const [label, text] of [['emoji', '😀'.repeat(32768)], ['CJK', '工'.repeat(65536)],
    ['spaced emoji', '😀👩‍👩‍👧 '.repeat(9000)]]) {
    const started = performance.now()
    const rows = nativeDetailRows(text)
    const ms = performance.now() - started
    assert.ok(ms < 50, `${label} detail took ${ms.toFixed(1)}ms`)
    assert.equal(rows.length, 26, label)
    assert.equal(rows.at(-1), MORE, label)
    assert.ok(oneHudRow(rows), label)
  }
  const ctx = runtime()
  const description = '工'.repeat(8192)
  Object.assign(ctx.native.value, { attention: [], features: Array.from({ length: 40 }, (_, i) =>
    ({ id: `f-${i}`, description, status: 'pending', expectedBehavior: [] })) })
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const actor = ctx.supervisor.actor('native-1')
  actor.handleAction('read_native')
  const started = performance.now()
  const view = actor.currentView
  assert.ok(performance.now() - started < 50, 'feature rows are cut before measuring')
  const row = view.items.find(r => r.startsWith('pending · '))
  assert.ok(row.length < 400 && row.endsWith('…'), 'a cut check description is marked as cut')
})

await test('Read with no detail view keeps the scene and never latches a later detail', async () => {
  const ctx = runtime()
  Object.assign(ctx.native.value, { attention: [], features: [] })
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const actor = ctx.supervisor.actor('native-1')
  actor.handleAction('read_native')
  assert.equal(actor.hasNavigationLayer, false)
  assert.equal(actor.currentView.type, 'scene')
  await readFresh(ctx, v => { v.features = v2Checks() })
  assert.equal(actor.currentView.type, 'scene', 'no automatic jump to progress')
  await readFresh(ctx, v => { v.attention = [attention()] })
  assert.equal(actor.currentView.scene.kind, 'decision', 'a new request shows the decision, not plan detail')
  actor.handleAction('read_native')
  assert.equal(actor.currentView.purpose, 'plan_detail')
  await readFresh(ctx, v => { v.attention = [resolved(attention(), ctx)] })
  assert.equal(actor.hasNavigationLayer, false)
  assert.equal(actor.currentView.type, 'scene', 'resolved request detail does not become progress detail')
  actor.handleAction('read_native')
  assert.equal(actor.currentView.title, 'Factory-reported progress')
  await readFresh(ctx, v => { v.attention = [{ ...attention('ask-2'), revision: 2 }] })
  assert.equal(actor.currentView.scene.kind, 'decision', 'a request arriving during progress detail is shown as a decision')
  await readFresh(ctx, v => { v.attention = [resolved({ ...attention('ask-2'), revision: 2 }, ctx)] })
  assert.equal(actor.currentView.type, 'scene', 'progress detail does not resurface by itself')
})

await test('HUD status keeps every reported count inside the 440px status budget', async () => {
  const ctx = runtime()
  const statuses = [...Array(100).fill('completed'), ...Array(12).fill('unmet'), ...Array(8).fill('cancelled')]
  const features = statuses.map((status, i) => ({ id: `c-${i}`, description: `Check ${i}.`, status, expectedBehavior: [] }))
  Object.assign(ctx.native.value, { attention: [], features })
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const actor = ctx.supervisor.actor('native-1')
  for (const state of ['running', 'orchestrator_turn', 'awaiting_input', 'initializing']) {
    await readFresh(ctx, v => { v.state = state })
    const { status } = actor.currentView.scene
    assert.ok(widthOf(status) <= 440, `${state}: ${status} is ${widthOf(status)}px`)
    assert.ok(!status.endsWith('…'), `${state}: ${status}`)
    assert.match(status, /100\/120 done · 12 unmet · 8 (cancelled\/waived|dropped)$/, state)
  }
  await readFresh(ctx, v => {
    v.state = 'orchestrator_turn'
    v.features = [...Array(1000).fill('completed'), ...Array(1200).fill('unmet'), ...Array(1800).fill('cancelled')]
      .map((status, i) => ({ id: `c-${i}`, description: 'x', status, expectedBehavior: [] }))
  })
  const big = actor.currentView.scene.status
  assert.ok(widthOf(big) <= 440 && /^1000\/4000 done · 1200 unmet · 1800 (cancelled\/waived|dropped)$/.test(big), big)
})

await test('an approved plan still deriving awaiting_input is evaluating, not planning', async () => {
  const ctx = runtime()
  const plan = v2Plan()
  Object.assign(ctx.native.value, { state: 'awaiting_input', features: [], attention: [plan] })
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const actor = ctx.supervisor.actor('native-1')
  const sent = await ctx.supervisor.answerNative('native-1', answer(plan))
  assert.equal(sent.state, 'confirmed')
  await readFresh(ctx, v => { v.state = 'awaiting_input'; v.attention = [resolved(plan, ctx)]; v.features = []; v.commands = [sent] })
  const scene = actor.currentView.scene
  assert.equal(scene.kind, 'running')
  assert.match(scene.utterance, /^Factory is evaluating; no request to answer\./)
  assert.doesNotMatch(scene.utterance + scene.status, /awaiting input|deliver/i)
  assert.match(scene.status, /^evaluating · /)
  assert.deepEqual(validateScene(scene, 'engine'), [])
  assert.equal(mission(ctx).phase, 'building')
  assert.equal(actor.presentation.activityStatus, 'building')

  const other = runtime()
  Object.assign(other.native.value, { state: 'awaiting_input', features: [], attention: [plan] })
  await other.supervisor.boot(); await other.supervisor.submitNativeIntent(intent())
  const rejecter = other.supervisor.actor('native-1')
  const changes = await other.supervisor.answerNative('native-1', { ...answer(plan), selectedOption: 'cancel' })
  assert.equal(changes.state, 'confirmed')
  await readFresh(other, v => { v.state = 'awaiting_input'; v.attention = [resolved(plan, other)]; v.features = []; v.commands = [changes] })
  assert.equal(rejecter.currentView.scene.kind, 'plan', 'requested plan changes stay in planning')
  assert.equal(mission(other).phase, 'planning')
  await readFresh(other, v => { v.features = v2Checks() })
  assert.equal(rejecter.currentView.scene.kind, 'running', 'reported checks mean the plan was approved elsewhere')
})

await test('held native intents: origin, listing, exact promotion, idempotency, dismiss, restart', async () => {
  const settings = { executionBackend: 'factory_native', workerPref: 'factory' }
  const ctx = runtime(undefined, broker(), settings)
  await ctx.supervisor.boot()
  const xGoal = '  Exact   X words\nkeep spacing'
  const x = await ctx.supervisor.submitCommand({ text: xGoal, source: 'x', sourceEventId: 'x-1',
    dedupeKey: 'x-event-1', startApproved: true, contextRefs: ['ctx-a', 'ctx-b'] })
  ctx.clock.now += 1000
  const g = await ctx.supervisor.submitCommand({ text: 'Phone words', source: 'phone_text', sourceEventId: 'p-1',
    dedupeKey: 'phone-1' })
  assert.equal(x.receipt, 'saved'); assert.equal(g.receipt, 'saved')
  const byId = id => ctx.supervisor.missions.find(m => m.missionId === id)
  assert.equal(byId(x.missionId).config.nativeOrigin, 'x')
  assert.equal(byId(g.missionId).config.nativeOrigin, 'generic')
  const listed = ctx.supervisor.heldNativeIntents()
  assert.deepEqual(listed.map(h => [h.missionId, h.origin]), [[g.missionId, 'generic'], [x.missionId, 'x']])
  assert.equal(listed[1].goal, xGoal)
  assert.deepEqual(listed[1].references, ['ctx-a', 'ctx-b'])
  assert.equal(listed[1].repository, SETTINGS.repository)

  const held = byId(x.missionId).config.nativeIntent
  const approved = (over = {}) => ({ ...structuredClone(held), missionId: 'promoted-1', commandId: 'command-promoted-1',
    scopeApproved: true, highAutonomyApproved: true, settings: reviewedSettings,
    references: ['ctx-a', 'ctx-b', 'owner-extra'], ...over })
  const rejected = async (over, label) => assert.equal(
    (await ctx.supervisor.promoteHeldNativeIntent(x.missionId, approved(over))).receipt, 'rejected', label)
  await rejected({ goal: 'Exact X words\nkeep spacing' }, 'normalized goal')
  await rejected({ references: ['ctx-a'] }, 'dropped reference')
  await rejected({ scopeApproved: false }, 'no scope approval')
  await rejected({ highAutonomyApproved: false }, 'no High approval')
  await rejected({ missionId: x.missionId }, 'reused mission id')
  await rejected({ commandId: held.commandId }, 'reused command id')
  await rejected({ workspace: { ...held.workspace, cwd: '/elsewhere' } }, 'unbound profile')
  assert.equal((await ctx.supervisor.promoteHeldNativeIntent('missing', approved())).receipt, 'rejected')
  assert.equal(ctx.native.prepared.length, 0)
  assert.equal(ctx.supervisor.heldNativeIntents().length, 2)

  const first = await ctx.supervisor.promoteHeldNativeIntent(x.missionId, approved())
  assert.equal(first.receipt, 'saved'); assert.equal(first.missionId, 'promoted-1')
  const again = await ctx.supervisor.promoteHeldNativeIntent(x.missionId,
    approved({ missionId: 'promoted-2', commandId: 'command-promoted-2' }))
  assert.deepEqual([again.receipt, again.missionId], ['duplicate', 'promoted-1'])
  assert.equal(ctx.native.prepared.length, 1, 'one job only')
  assert.equal(ctx.native.prepared[0].goal, xGoal)
  assert.equal(byId('promoted-2'), undefined)
  assert.equal(byId(x.missionId).phase, 'cancelled')
  assert.equal(byId(x.missionId).config.nativeHeldResolution.missionId, 'promoted-1')
  assert.equal(byId('promoted-1').config.nativeOrigin, 'x')
  assert.equal(ctx.supervisor.actor(x.missionId), null)
  const events = ctx.supervisor.missionStore.events
  const promoted = events.filter(e => e.type === 'native_intent_promoted')
  assert.equal(promoted.length, 1)
  assert.equal(promoted[0].missionId, x.missionId)
  assert.equal(promoted[0].payload.newMissionId, 'promoted-1')
  assert.equal(events.filter(e => e.type === 'mission_created' && e.missionId === 'promoted-1').length, 1)
  assert.equal(events.some(e => e.type === 'mission_completed' && e.missionId === x.missionId), false)
  assert.deepEqual(ctx.supervisor.heldNativeIntents().map(h => h.missionId), [g.missionId])

  assert.equal(await ctx.supervisor.dismissHeldNativeIntent('missing'), false)
  assert.equal(await ctx.supervisor.dismissHeldNativeIntent('promoted-1'), false, 'approved jobs are not held')
  assert.equal(await ctx.supervisor.dismissHeldNativeIntent(g.missionId), true)
  assert.equal(await ctx.supervisor.dismissHeldNativeIntent(g.missionId), false)
  assert.equal(byId(g.missionId).phase, 'cancelled')
  assert.equal(ctx.supervisor.missionStore.events.filter(e => e.type === 'native_intent_dismissed' && e.missionId === g.missionId).length, 1)
  assert.equal((await ctx.supervisor.promoteHeldNativeIntent(g.missionId,
    { ...approved(), goal: 'Phone words', references: [] })).receipt, 'rejected', 'dismissed cannot promote')
  assert.deepEqual(ctx.supervisor.heldNativeIntents(), [])
  await ctx.supervisor.flush()

  const restored = runtime(ctx.kv, broker(), settings)
  await restored.supervisor.boot()
  const r = id => restored.supervisor.missions.find(m => m.missionId === id)
  assert.deepEqual(restored.supervisor.heldNativeIntents(), [])
  assert.equal(r(x.missionId).phase, 'cancelled')
  assert.equal(r(x.missionId).config.nativeOrigin, 'x')
  assert.equal(r(g.missionId).config.nativeHeldResolution.outcome, 'dismissed')
  assert.equal(restored.supervisor.actor(x.missionId), null)
  assert.equal(restored.supervisor.actor(g.missionId), null)
  const replay = await restored.supervisor.promoteHeldNativeIntent(x.missionId,
    approved({ missionId: 'promoted-3', commandId: 'command-promoted-3' }))
  assert.deepEqual([replay.receipt, replay.missionId], ['duplicate', 'promoted-1'])
  assert.equal(restored.native.prepared.length, 0)
  zeroLegacy(ctx); zeroLegacy(restored)
})

await test('pre-origin held records read as generic; bad origin is rejected by the validator', async () => {
  const ctx = runtime(undefined, broker(), { executionBackend: 'factory_native', workerPref: 'factory' })
  await ctx.supervisor.boot()
  await ctx.supervisor.submitCommand({ text: 'old', source: 'x', sourceEventId: 'x-9', dedupeKey: 'x-9' })
  await ctx.supervisor.flush()
  const state = structuredClone(ctx.supervisor.missionStore.current)
  delete state.missions[0].config.nativeOrigin
  const old = validateSpriiteState(state)
  assert.equal(old.missions[0].config.nativeOrigin, undefined)
  state.missions[0].config.nativeOrigin = 'stranger'
  assert.equal(validateSpriiteState(state), null)
  state.missions[0].config.nativeOrigin = 'x'
  state.missions[0].config.nativeHeldResolution = { outcome: 'promoted' }
  assert.equal(validateSpriiteState(state), null)
})

await test('resolved held missions read as approved/dismissed, never fault, cancelled or done', async () => {
  const ctx = runtime(undefined, broker(), { executionBackend: 'factory_native', workerPref: 'factory' })
  await ctx.supervisor.boot()
  const a = await ctx.supervisor.submitCommand({ text: 'Promote me', source: 'x', sourceEventId: 'x-a', dedupeKey: 'x-a' })
  const b = await ctx.supervisor.submitCommand({ text: 'Dismiss me', source: 'x', sourceEventId: 'x-b', dedupeKey: 'x-b' })
  const held = ctx.supervisor.missions.find(m => m.missionId === a.missionId).config.nativeIntent
  await ctx.supervisor.promoteHeldNativeIntent(a.missionId, { ...structuredClone(held), missionId: 'p-1',
    commandId: 'c-p-1', scopeApproved: true, highAutonomyApproved: true, settings: reviewedSettings })
  await ctx.supervisor.dismissHeldNativeIntent(b.missionId)
  await ctx.supervisor.flush()
  const byId = id => ctx.supervisor.missions.find(m => m.missionId === id)
  assert.equal(homeStatusOf(byId(a.missionId), null), 'promoted')
  assert.equal(homeStatusOf(byId(b.missionId), null), 'dismissed')
  const state = ctx.supervisor.missionStore.current
  for (const id of [a.missionId, b.missionId]) {
    const brief = buildBriefing({ state, events: ctx.supervisor.missionStore.events, journalSeq: 1e9,
      scope: { kind: 'mission', missionId: id }, now: ctx.clock.now })
    const text = brief.cards.map(c => `${c.headline} ${c.detail ?? ''}`).join(' ')
    assert.match(text, id === a.missionId ? /approved as a new native job/ : /dismissed/)
    assert.doesNotMatch(text, /cancel|is ready|completed|delivered|failed/i)
  }
})

await test('an approved native job saved before a crash is prepared on the next boot, behind launch gates', async () => {
  const kv = new TestKV()
  const gated = runtime(kv, null)
  await gated.supervisor.boot()
  assert.equal((await gated.supervisor.submitNativeIntent(intent())).receipt, 'saved')
  await gated.supervisor.flush()
  assert.equal(gated.supervisor.missionStore.current.engineSnapshots['native-1'].prepareReceipt, null, 'gate held the launch')
  const restored = runtime(kv, broker())
  await restored.supervisor.boot()
  await until(() => restored.native.prepared.length === 1, 'resumed prepare')
  await restored.supervisor.flush()
  assert.equal(restored.native.prepared[0].commandId, intent().commandId)
  const again = runtime(kv, restored.native)
  await again.supervisor.boot(); await again.supervisor.flush(); await quiesce()
  assert.equal(restored.native.prepared.length, 1, 'a recorded prepare is never repeated')
  zeroLegacy(restored)
})

await test('broker delivery is projected honestly; only merged reads as delivered', async () => {
  const delivering = { ...intent(), policy: { ...intent().policy, allowPush: true, allowPr: true, allowMerge: true } }
  const ctx = runtime(new TestKV(), broker(delivering))
  ctx.native.value.attention = []
  await ctx.supervisor.boot()
  assert.equal((await ctx.supervisor.submitNativeIntent(delivering)).receipt, 'saved')
  const actor = ctx.supervisor.actor('native-1')
  const pr = { branch: 'spriite/native-1', headSha: 'c'.repeat(40), prUrl: 'https://github.com/example/sprite-test/pull/5',
    prNumber: 5, updatedAt: '2026-10-12T00:20:00.000Z' }
  await readFresh(ctx, v => { v.state = 'completed' })
  assert.equal(actor.observationPending, true, 'a completed job with push allowed keeps observing for delivery')
  await readFresh(ctx, v => { v.delivery = { ...pr, step: 'pr_open', checks: { total: 3, passed: 2, failed: 0, pending: 1 } } })
  let scene = actor.currentView.scene
  assert.deepEqual(validateScene(scene, 'engine'), [])
  assert.equal(scene.status, 'PR open · checks 2/3')
  assert.match(scene.utterance, /Not delivered\./)
  assert.equal(actor.observationPending, true, 'an open PR keeps observing')
  const homeOpen = homeStatusOf(mission(ctx), nativePresentation(actor.snapshot))
  assert.equal(homeOpen, 'pr_open')
  let brief = buildBriefing({ state: ctx.supervisor.missionStore.current, events: ctx.supervisor.missionStore.events,
    journalSeq: 1e9, scope: { kind: 'mission', missionId: 'native-1' }, now: ctx.clock.now })
  let text = brief.cards.map(c => `${c.headline} ${c.detail ?? ''}`).join(' ')
  assert.match(text, /not delivered/)
  assert.match(text, /PR open · checks 2\/3/)
  assert.doesNotMatch(text.replace(/not delivered/g, ''), /delivered/i)
  await readFresh(ctx, v => {
    v.delivery = { ...pr, step: 'merged', checks: { total: 3, passed: 3, failed: 0, pending: 0 } }
    v.usage = { state: 'pending' }
    v.finalization = { state: 'incomplete', summary: null, reason: 'No artifact evidence', evidence: [] }
  })
  scene = actor.currentView.scene
  assert.deepEqual(validateScene(scene, 'engine'), [])
  assert.equal(scene.status, 'Merged')
  assert.match(scene.utterance, /Delivered: PR #5 merged after checks passed\./)
  assert.equal(actor.observationPending, false, 'a merged delivery stops delivery polling')
  assert.equal(homeStatusOf(mission(ctx), nativePresentation(actor.snapshot)), 'merged')
  actor.handleAction('read_native')
  assert.ok(actor.currentView.items.includes('Usage: available tomorrow'))
  assert.ok(actor.currentView.items.some(r => r.startsWith('PR: https://github.com/example/sprite-test/pull/5')))
  brief = buildBriefing({ state: ctx.supervisor.missionStore.current, events: ctx.supervisor.missionStore.events,
    journalSeq: 1e9, scope: { kind: 'mission', missionId: 'native-1' }, now: ctx.clock.now })
  text = brief.cards.map(c => `${c.headline} ${c.detail ?? ''} ${c.evidenceUrl ?? ''}`).join(' ')
  assert.match(text, /delivered, PR merged/)
  assert.match(text, /Usage: available tomorrow/)
  assert.match(text, /pull\/5/)
  const cached = decodeNativeCache(ctx.supervisor.missionStore.current.engineSnapshots['native-1'])
  assert.equal(cached.snapshot.delivery.step, 'merged', 'delivery survives the device cache round trip')
  assert.deepEqual(cached.snapshot.usage, { state: 'pending' })
  zeroLegacy(ctx)
})

await test('delivery outside the frozen policy or of unknown shape is ignored, never shown', async () => {
  const ctx = runtime()
  ctx.native.value.attention = []
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  const actor = ctx.supervisor.actor('native-1')
  await readFresh(ctx, v => {
    v.state = 'completed'
    v.delivery = { step: 'merged', branch: 'spriite/native-1', headSha: 'c'.repeat(40),
      prUrl: 'https://github.com/example/sprite-test/pull/5', prNumber: 5, updatedAt: '2026-10-12T00:20:00.000Z' }
  })
  assert.equal(actor.snapshot.delivery, undefined)
  assert.ok(actor.snapshot.diagnostics.includes('delivery_outside_policy'))
  assert.notEqual(actor.currentView.scene.status, 'Merged')
  assert.doesNotMatch(actor.currentView.scene.utterance, /Delivered/)
  assert.equal(actor.observationPending, true, 'still collecting finalization evidence')
  await readFresh(ctx, v => { v.delivery = { step: 'shipped' }; v.usage = { state: 'available' } })
  assert.equal(actor.snapshot.delivery, undefined)
  assert.ok(actor.snapshot.diagnostics.includes('delivery_unrecognized') && actor.snapshot.diagnostics.includes('usage_unrecognized'))
  assert.equal(homeStatusOf(mission(ctx), nativePresentation(actor.snapshot)), 'final')
  zeroLegacy(ctx)
})

await test('budget-free intents decode and legacy explicit budgets round-trip without alteration', async () => {
  const free = decodeNativeIntent(intent())
  assert.ok(free)
  assert.equal(Object.hasOwn(free.policy, 'budget'), false)
  const legacy = { ...intent(), policy: { ...intent().policy, budget: { unit: 'legacy-units', capUnits: '250' } } }
  assert.deepEqual(decodeNativeIntent(legacy).policy.budget, legacy.policy.budget)
  assert.equal(decodeNativeIntent({ ...legacy, policy: { ...legacy.policy, budget: { unit: '', capUnits: '0' } } }), null)
})

await test('held delivery without a pushed head preserves the real reason; other states require a SHA', async () => {
  const held = { step: 'held', branch: 'spriite/native-1', headSha: '',
    reason: 'Working tree is dirty; broker refused the push', updatedAt: '2026-10-12T00:20:00.000Z' }
  assert.deepEqual(decodeNativeDelivery(held), held)
  for (const step of ['pushed', 'pr_open', 'checks_pending', 'checks_failed', 'merged', 'not_merged']) {
    assert.equal(decodeNativeDelivery({ ...held, step, prNumber: 1,
      prUrl: 'https://github.com/example/sprite-test/pull/1' }), null, step)
  }
  assert.equal(decodeNativeDelivery({ ...held, headSha: 'bad' }), null)
  const ctx = runtime()
  ctx.native.value.attention = []
  await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
  await readFresh(ctx, v => { v.state = 'completed'; v.delivery = held })
  const actor = ctx.supervisor.actor('native-1')
  assert.deepEqual(actor.snapshot.delivery, held)
  actor.handleAction('read_native')
  assert.match(actor.currentView.items.join(' '), /Working tree is dirty/)
  assert.doesNotMatch(actor.currentView.items.join(' '), /Delivered:/)
  const brief = buildBriefing({ state: ctx.supervisor.missionStore.current, events: ctx.supervisor.missionStore.events,
    journalSeq: 1e9, scope: { kind: 'mission', missionId: 'native-1' }, now: ctx.clock.now })
  assert.match(JSON.stringify(brief.cards), /Working tree is dirty/)
  zeroLegacy(ctx)
})

await test('restored/imported out-of-policy delivery is diagnosed before any actor or briefing renders', async () => {
  for (const step of ['merged', 'pr_open', 'not_merged', 'held']) {
    const ctx = runtime()
    ctx.native.value.attention = []
    await ctx.supervisor.boot(); await ctx.supervisor.submitNativeIntent(intent())
    await readFresh(ctx, v => { v.state = 'completed' })
    const forged = { step, branch: 'spriite/native-1', headSha: 'c'.repeat(40),
      prUrl: 'https://github.com/example/sprite-test/pull/9', prNumber: 9,
      updatedAt: '2026-10-12T00:20:00.000Z' }
    await ctx.supervisor.missionStore.commit(s => ({ state: { ...s,
      engineSnapshots: { ...s.engineSnapshots, 'native-1': {
        ...s.engineSnapshots['native-1'], snapshot: { ...s.engineSnapshots['native-1'].snapshot, delivery: forged },
      } },
    }, events: [] }))
    const restored = new NativeMissionActor({ missionId: 'native-1', intent: intent(),
      store: ctx.supervisor.missionStore, client: null, emitView: () => {}, launchPermitted: () => false,
      now: () => ctx.clock.now })
    assert.equal(restored.snapshot.delivery, undefined, step)
    assert.ok(restored.snapshot.diagnostics.includes('delivery_outside_policy'), step)
    assert.doesNotMatch(JSON.stringify(restored.currentView), /Delivered:|PR #9 merged/)
    const actorless = new Supervisor({ store: ctx.supervisor.missionStore, kv: ctx.kv,
      clients: ctx.clients, settings: () => ctx.config, emitView: () => {} })
    assert.equal(actorless.actor('native-1'), null)
    assert.equal(actorless.nativeSnapshotFor('native-1').delivery, undefined)
    assert.ok(actorless.nativeCacheFor('native-1').snapshot.diagnostics.includes('delivery_outside_policy'))
    assert.notEqual(actorless.presentationFor('native-1').nativeState, 'merged')
    const brief = buildBriefing({ state: ctx.supervisor.missionStore.current, events: ctx.supervisor.missionStore.events,
      journalSeq: 1e9, scope: { kind: 'mission', missionId: 'native-1' }, now: ctx.clock.now })
    assert.match(JSON.stringify(brief.cards), /outside the frozen job policy/)
    assert.doesNotMatch(JSON.stringify(brief.cards), /delivered, PR merged|pull\/9/)
    restored.dispose(); ctx.supervisor.actor('native-1').dispose()
    zeroLegacy(ctx)
  }
})

await test('crafted held promotions fail before saving malformed destinations, dependencies or reviewed settings', async () => {
  const defaults = { createPrivateRepositories: true, pushBranch: true, openPr: true, mergeAfterChecks: true }
  const ctx = runtime(undefined, broker(), { executionBackend: 'factory_native', nativeDelivery: defaults })
  await ctx.supervisor.boot()
  const receipt = await ctx.supervisor.submitCommand({ text: '  Preserve exact goal\nand refs  ', source: 'x',
    sourceEventId: 'crafted', dedupeKey: 'crafted', contextRefs: ['exact-ref'] })
  const held = ctx.supervisor.missions[0].config.nativeIntent
  const target = { kind: 'new_repository', account: 'example', name: 'sprite-test', visibility: 'private', initialization: 'empty' }
  const valid = { ...structuredClone(held), missionId: 'crafted-new', commandId: 'crafted-command',
    destination: target, settings: structuredClone(reviewedSettings), scopeApproved: true, highAutonomyApproved: true,
    policy: { ...held.policy, allowCreateRepository: true, allowPush: true, allowPr: true, allowMerge: true } }
  for (const bad of [
    { destination: { ...target, visibility: 'public' } },
    { destination: { ...target, initialization: 'clone' } },
    { destination: { ...target, sourceUrl: 'https://github.com/example/source' } },
    { destination: { ...target, name: 'different' } },
    { policy: { ...valid.policy, allowCreateRepository: false }, destination: { ...target, visibility: 'public' } },
    { policy: { ...valid.policy, allowCreateRepository: false } },
    { policy: { ...valid.policy, allowPr: false } },
    { policy: { ...valid.policy, allowPush: false } },
    { policy: { ...valid.policy, allowDeploy: true } },
    { policy: { ...valid.policy, allowMerge: false } },
    { settings: {} },
    { settings: { ...reviewedSettings, skipScrutiny: true } },
    { settings: { ...reviewedSettings, skipUserTesting: true } },
    { settings: { ...reviewedSettings, restrictToolIds: ['Read', 'Read'] } },
    { settings: { ...reviewedSettings, restrictToolIds: ['Read/Edit'] } },
    { settings: { ...reviewedSettings, modelId: ' ' } },
    { operation: 'fork' },
  ]) {
    const result = await ctx.supervisor.promoteHeldNativeIntent(receipt.missionId, { ...valid, ...bad })
    assert.equal(result.receipt, 'rejected', JSON.stringify(bad))
    assert.equal(ctx.supervisor.missions.length, 1)
    assert.equal(ctx.native.prepared.length, 0)
  }
  // A change during the asynchronous retire/store boundary also invalidates
  // the frozen reviewed policy, rather than replacing it with the new defaults.
  const store = ctx.supervisor.missionStore
  const commit = store.commit.bind(store)
  let changeDefaults = true
  store.commit = mutate => commit(s => {
    if (changeDefaults) { ctx.config.nativeDelivery = { ...defaults, mergeAfterChecks: false }; changeDefaults = false }
    return mutate(s)
  })
  assert.equal((await ctx.supervisor.promoteHeldNativeIntent(receipt.missionId, valid)).receipt, 'rejected')
  assert.equal(ctx.supervisor.missions.length, 1)
  store.commit = commit
  ctx.config.nativeDelivery = defaults
  assert.equal((await ctx.supervisor.promoteHeldNativeIntent(receipt.missionId, valid)).receipt, 'saved')
  const saved = ctx.supervisor.missions.find(m => m.missionId === valid.missionId).config.nativeIntent
  assert.equal(saved.goal, held.goal)
  assert.deepEqual(saved.references, held.references)
  assert.deepEqual(saved.policy, valid.policy)
  zeroLegacy(ctx)
})

await test('admission coordinator invalidates stale saved delivery defaults without requiring a phone redraw', async () => {
  const defaults = { createPrivateRepositories: false, pushBranch: false, openPr: false, mergeAfterChecks: false }
  const original = intent()
  const { missionId: _, commandId: __, scopeApproved: ___, highAutonomyApproved: ____, ...body } = original
  const request = { ...body, workspace: { ...body.workspace, baseSha: 'a'.repeat(40) }, settings: reviewedSettings, brokerUrl: profile.brokerUrl }
  const coordinator = new NativeAdmissionCoordinator({
    profile: () => profile, deliveryDefaults: () => defaults, credential: () => 'synthetic',
    mint: kind => `reserved-${kind}`, client: () => ({ async inspectAdmission(draft) {
      return { protocolVersion: 1, ownerId: draft.ownerId, missionId: draft.missionId,
        draftHash: await nativeFingerprint(draft), workspace: draft.workspace, prospectiveSettings: draft.settings,
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 59000).toISOString(),
        launchEligible: true, holds: [] }
    } }),
  })
  const admission = await coordinator.inspect(request)
  defaults.pushBranch = true
  assert.equal(coordinator.take({ ...request, admission, scopeApproved: true, highAutonomyApproved: true }), null)
})

console.log(`\n${passed} native runtime journeys passed (no live provider calls).`)
