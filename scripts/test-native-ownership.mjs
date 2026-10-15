import assert from 'node:assert/strict'
import { canonicalVoiceDraft, focusCaptureOwner, nativeCaptureKey } from '../src/voice/action-ownership.ts'
import { VoiceTurnGuard } from '../src/voice/turn.ts'
import { nativeFixtureClient, nativeFixtureDialectFromLocation } from '../src/probe/native-fixture.ts'
import { decodeNativeSnapshot } from '../src/native/decode.ts'
import { nativeFeatureCounts } from '../src/native/presentation.ts'
const v2Checks = status => ['a', 'b'].map(id => ({ id, description: id, status, expectedBehavior: [] }))
import { briefingSurface, briefingText } from '../src/briefing/view.ts'
import { buildBriefing } from '../src/briefing/build.ts'
import { meaningOf } from '../src/briefing/meaning.ts'
import { initialSpriiteState } from '../src/domain/state.ts'

let checks = 0
const check = (value, label) => {
  assert.ok(value, label)
  checks++
  console.log(`  PASS: ${label}`)
}

const full = `Build the dashboard ${'with detailed requirements '.repeat(90)}only in a new private repository; do not deploy or publish.`
check(canonicalVoiceDraft(`  ${full}  `) === full, 'canonical voice keeps trailing destination and publication restrictions beyond HUD budget')

let pending = true
let focused = null
const calls = []
let resolveRender
const render = new Promise(resolve => { resolveRender = resolve })
const task = focusCaptureOwner({
  target: 'asking',
  pending: () => pending,
  show: id => { calls.push('show'); focused = id; return true },
  render: async () => { calls.push('render'); await render; return true },
  current: id => focused === id,
})
check(calls.join(',') === 'show,render', 'background ask focuses its owner before awaited render')
let ready = false
task.then(value => { ready = value })
await Promise.resolve()
check(!ready, 'background ask capture does not open before render completes')
resolveRender()
check(await task, 'background ask capture uses the requesting owner after render')

pending = false
calls.length = 0
check(!await focusCaptureOwner({
  target: 'asking', pending: () => pending,
  show: () => { calls.push('show'); return true },
  render: async () => true,
  current: () => true,
}) && calls.length === 0, 'answered stale ask notice cannot capture for another task')

pending = true
check(!await focusCaptureOwner({
  target: 'asking', pending: () => pending, show: () => true,
  render: async () => { focused = 'other'; return true },
  current: id => focused === id,
}), 'task switch during rendered focus refuses microphone capture')

check(!await focusCaptureOwner({
  target: 'missing', pending: () => true, show: () => false,
  render: async () => { throw new Error('must not render') }, current: () => true,
}), 'missing request owner refuses capture without switching current surface')

const guard = new VoiceTurnGuard()
const turn = guard.begin({ engine: {}, mission: 'asking' })
guard.invalidate()
check(!guard.complete(turn), 'exit invalidation prevents a settling voice turn from dispatching')
check(!await focusCaptureOwner({
  target: 'asking', pending: () => true, show: () => true,
  render: async () => false, current: () => true,
}), 'refused display transport cannot arm capture from an unseen ask owner')
const attn = { attentionId: 'attention', requestId: 'request', revision: 1, payloadHash: 'hash', state: 'open' }
const native = { scopeRevision: 1, attention: [attn] }
const key = nativeCaptureKey('mission', native)
check(key !== nativeCaptureKey('mission', { ...native, attention: [{ ...attn, state: 'answer_unknown' }] }),
  'uncertain response state invalidates native voice ownership')
check(key !== nativeCaptureKey('mission', { ...native, attention: [{ ...attn, machineId: 'different-machine' }] }),
  'native voice ownership includes the exact owning machine')
check(key !== nativeCaptureKey('mission', { ...native, attention: [{ ...attn, sessionId: 'different-session' }] }),
  'native voice ownership includes the exact owning session')
check(key === nativeCaptureKey('mission', { ...native }), 'native activity churn preserves the same request capture owner')
check(key !== nativeCaptureKey('mission', { ...native, scopeRevision: 2 }), 'new native scope invalidates capture ownership')
check(key !== nativeCaptureKey('mission', { ...native, attention: [{ ...attn, requestId: 'replacement' }] }),
  'identical native question text with a replacement request cannot inherit voice capture')
check(key !== nativeCaptureKey('mission', { ...native, attention: [{ ...attn, payloadHash: 'changed' }] }),
  'changed native request payload invalidates capture ownership')
const fixture = nativeFixtureClient()
let snapshot = await fixture.prepare({
  protocolVersion: 1, missionId: 'fixture-mission', commandId: 'fixture-create', ownerId: 'fixture-owner',
  goal: 'OFFLINE native projection fixture', scopeRevision: 1, operation: 'implement',
  workspace: { machineId: 'fixture-machine', cwd: '/tmp/offline-native-fixture',
    repository: 'https://github.com/example/fixture', baseRef: 'develop' },
  references: [], acceptanceCriteria: ['Projection only'], restrictions: ['No execution'],
  policy: { autonomy: 'high', allowCreateRepository: false, allowPush: false, allowPr: false, allowMerge: false, allowDeploy: false },
  scopeApproved: true, highAutonomyApproved: true, settings: {},
})
check(snapshot.attention[0].kind === 'proposal', 'offline native fixture begins with separate proposal approval')
let number = 0
const response = async (attention, answer) => fixture.command({
  protocolVersion: 1, commandId: `fixture-answer-${++number}`,
  missionId: snapshot.missionId, ownerId: snapshot.ownerId,
  kind: 'answer', expectedScopeRevision: snapshot.scopeRevision, expectedBrokerSeq: snapshot.brokerSeq,
  answer: { attentionId: attention.attentionId, requestId: attention.requestId,
    sessionId: attention.sessionId, machineId: attention.machineId, revision: attention.revision,
    payloadHash: attention.payloadHash, ...answer },
})
check((await response(snapshot.attention[0], { selectedOption: 'proceed_always' })).state === 'rejected',
  'offline native fixture refuses an outcome not offered by the actual request')
check((await response(snapshot.attention[0], { selectedOption: 'proceed_once' })).state === 'confirmed',
  'offline native fixture sends an exact proposal response')
snapshot = await fixture.observe(snapshot.missionId, snapshot.ownerId)
check(snapshot.attention.some(a => a.kind === 'start' && a.state === 'open'),
  'offline native fixture requires separate run-start approval')
await response(snapshot.attention.find(a => a.kind === 'start'), { selectedOption: 'proceed_once' })
snapshot = await fixture.observe(snapshot.missionId, snapshot.ownerId)
check(snapshot.attention.some(a => a.kind === 'permission' && a.state === 'open') &&
  snapshot.attention.some(a => a.kind === 'ask_user' && a.sessionId === 'fixture-child' && a.state === 'open'),
  'offline native fixture retains root permission and child questionnaire together')
const child = snapshot.attention.find(a => a.kind === 'ask_user')
const queued = structuredClone(snapshot)
check((await response(child, { answers: [{ index: 0, answer: 'sqlite' }] })).state === 'rejected',
  'offline questionnaire refuses an incomplete multi-question response')
await response(snapshot.attention.find(a => a.kind === 'permission'), { selectedOption: 'proceed_once' })
check((await response(child, { answers: [{ index: 0, answer: 'sqlite' }, { index: 1, answer: 'unit, ui' }] })).state === 'rejected',
  'offline fixture refuses ambiguous comma-joined multi-select answers')
await response(child, { answers: [{ index: 0, answer: 'sqlite' }, { index: 1, answer: '["unit","ui"]' }] })
snapshot = await fixture.observe(snapshot.missionId, snapshot.ownerId)
check(snapshot.attention.every(a => a.state === 'resolved'),
  'offline fixture does not lose simultaneous root and child response resolution')
check(snapshot.state === 'completed' && snapshot.finalization.state === 'incomplete' &&
  snapshot.finalization.evidence.length === 0,
  'offline fixture completion claims no code, artifact, or provider qualification')
check(nativeFixtureDialectFromLocation() === 'v1', 'offline fixture defaults to the v1 scenario outside the simulator URL')
const v2 = nativeFixtureClient('v2')
let v2Snap = await v2.prepare({
  protocolVersion: 1, missionId: 'fixture-v2', commandId: 'fixture-v2-create', ownerId: 'fixture-owner',
  goal: 'OFFLINE native v2 projection fixture', scopeRevision: 1, operation: 'implement',
  workspace: { machineId: 'fixture-machine', cwd: '/tmp/offline-native-fixture',
    repository: 'https://github.com/example/fixture', baseRef: 'develop' },
  references: [], acceptanceCriteria: ['Projection only'], restrictions: ['No execution'],
  policy: { autonomy: 'high', allowCreateRepository: false, allowPush: false, allowPr: false, allowMerge: false, allowDeploy: false },
  scopeApproved: true, highAutonomyApproved: true, settings: {},
})
let v2Number = 0
const v2Answer = async (attention, selectedOption = 'proceed_once') => v2.command({
  protocolVersion: 1, commandId: `fixture-v2-answer-${++v2Number}`,
  missionId: v2Snap.missionId, ownerId: v2Snap.ownerId,
  kind: 'answer', expectedScopeRevision: v2Snap.scopeRevision, expectedBrokerSeq: v2Snap.brokerSeq,
  answer: { attentionId: attention.attentionId, requestId: attention.requestId,
    sessionId: attention.sessionId, machineId: attention.machineId, revision: attention.revision,
    payloadHash: attention.payloadHash, selectedOption },
})
const v2Open = () => v2Snap.attention.filter(a => a.state === 'open')
const v2Recommend = v2Open()[0]
check(v2Snap.state === 'awaiting_input' && v2Recommend?.kind === 'permission' &&
  v2Recommend.title === 'Plan as a Factory Mission' &&
  v2Recommend.options.map(o => `${o.value}:${o.label}`).join('|') === 'proceed_once:Start Mission planning|cancel:Continue normally',
  'v2 fixture opens with the recommend-Mission permission and provider option labels')
check((await v2Answer(v2Recommend)).state === 'confirmed', 'v2 fixture accepts proceed_once on the recommendation')
v2Snap = await v2.observe(v2Snap.missionId, v2Snap.ownerId)
const v2Plan = v2Open()[0]
check(v2Plan?.kind === 'proposal' && v2Plan.details.includes('Checks:') &&
  ['badge-renders', 'tests-pass', 'docs-updated'].every(id => v2Plan.details.includes(id)) &&
  v2Plan.options.some(o => o.value === 'proceed_once' && o.label === 'Approve Mission'),
  'v2 fixture plan proposal carries plan text, three checks and Approve Mission')
await v2Answer(v2Plan)
v2Snap = await v2.observe(v2Snap.missionId, v2Snap.ownerId)
check(v2Snap.state === 'running' && !v2Open().length && !v2Snap.attention.some(a => a.kind === 'start') &&
  v2Snap.features.length === 3 && v2Snap.features.every(f => f.status === 'pending'),
  'v2 fixture plan approval starts the run without a separate start request')
check(v2Snap.history.some(h => h.who === 'factory' && /fixture-worker-1 started/.test(h.text)),
  'v2 fixture reports worker start as progress')
const seen = []
let decoded = true
for (let n = 0; n < 40 && v2Snap.state !== 'completed'; n++) {
  v2Snap = await v2.observe(v2Snap.missionId, v2Snap.ownerId)
  decoded &&= decodeNativeSnapshot(v2Snap) !== null
  seen.push(v2Snap.features.map(f => f.status).join(','))
}
check(decoded, 'every v2 fixture observation, including unmet checks, decodes strictly')
check(seen.includes('completed,unmet,pending'), 'v2 fixture evaluates one check unmet before it is met')
check(nativeFeatureCounts(v2Snap.features).done === 3 && v2Snap.state === 'completed' &&
  v2Snap.finalization.state === 'incomplete' && !v2Snap.finalization.evidence.length,
  'v2 fixture completes only after every check is met, without artifact claims')
check(nativeFeatureCounts(v2Checks('unmet')).done === 0, 'unmet checks never count as done')
const nativeMission = {
  schemaVersion: 2, missionId: snapshot.missionId, title: 'Offline mission',
  phase: 'building', control: 'running', planRevision: 1, freshness: 'current',
  lastObservedAt: snapshot.lastObservedAt, updatedAt: snapshot.lastObservedAt,
  config: { executionBackend: 'factory_native' },
}
const cacheFor = value => ({
  nativeCacheVersion: 1, backend: 'factory_native', snapshot: value, pendingWrites: [],
  prepareReceipt: null, finalizationDeadline: null, lastClientObservedAt: value.lastObservedAt, imported: false,
})
const briefState = value => ({
  ...initialSpriiteState(), missions: [nativeMission],
  engineSnapshots: { [snapshot.missionId]: cacheFor(value) },
})
const pendingBrief = buildBriefing({
  state: briefState(queued), events: [], journalSeq: 0, scope: { kind: 'owner' },
})
check(pendingBrief.cards.filter(c => c.decisionId).length === 2,
  'return briefing keeps simultaneous native requests even with no unseen journal events')
check(pendingBrief.cards.some(c => c.evidenceUrl === 'https://app.factory.ai/sessions/fixture-child'),
  'native briefing child handoff uses its exact session rather than the root')
check(pendingBrief.cards.every(c => c.coveredEventIds.length === 0),
  'state-driven unresolved native requests never fabricate covered events')
const terminalState = briefState(snapshot)
terminalState.missions[0] = { ...nativeMission, phase: 'completed' }
const completionBrief = buildBriefing({
  state: terminalState, journalSeq: 1, scope: { kind: 'owner' },
  events: [{ eventId: 'native-completed', seq: 1, type: 'mission_completed',
    missionId: snapshot.missionId, observedAt: snapshot.lastObservedAt, payload: { backend: 'factory_native' } }],
})
check(completionBrief.cards[0].headline.includes('artifact evidence incomplete') &&
  !completionBrief.cards[0].headline.includes('is ready'),
  'native completion briefing cannot borrow legacy verified-ready copy')
for (const type of ['native_features_changed', 'native_finalization_changed',
  'native_attention_resolved', 'native_control_observed', 'native_history_observed']) {
  check(meaningOf({ type, payload: {} }).meaningful, `${type} remains meaningful return-briefing news`)
}
const account = {
  schemaVersion: 2, briefingId: 'account', scope: { kind: 'owner' }, kind: 'return',
  targetSeq: 5, coveredEventIds: ['e1', 'e2', 'e3', 'e4', 'e5'], missionRevisions: {},
  cards: Array.from({ length: 5 }, (_, i) => ({
    rank: 1, headline: `Question ${i + 1}`, decisionId: `decision-${i}`,
    freshness: 'unknown', lastObservedAt: null, coveredEventIds: [`e${i + 1}`],
  })), createdAt: new Date().toISOString(),
}
const surface = briefingSurface(account)
check(surface.cards.length === 3 && briefingText(surface).status.includes('2 not shown'),
  'return briefing discloses cards outside the glasses three-card budget')
surface.confirming = true
check(briefingText(surface).body.includes('Questions stay open') &&
  briefingText(surface).body.includes('not mean every item was read'),
  'account acknowledgment explicitly does not answer questions or claim full reading')
check(account.coveredEventIds.length === 5 && account.cards.every(c => c.decisionId),
  'briefing presentation leaves full fixed coverage and unresolved decisions untouched')
console.log(`${checks} native ownership checks passed`)
