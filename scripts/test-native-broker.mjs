import assert from 'node:assert/strict'
import { readFile, writeFile, unlink, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { request } from 'node:http'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync, sign } from 'node:crypto'
import {
  NativeBroker, FileStore, recoverDeadWriter, startBrokerServer, startFromEnv,
  NATIVE_RESPONSE_MAX_BYTES, NATIVE_MAX_OUTSTANDING_READS, BrokerError,
} from '../broker/index.mjs'
import { hash, clone, canonical, NATIVE_SNAPSHOT_ADMISSION_BYTES } from '../broker/validation.mjs'
import { verifyHostQualification, HOST_QUALIFICATION_CHECKS, publicKeySha256 } from '../broker/qualification.mjs'
import { SDK_TRANSPORT_VERSION } from '../broker/sdk-wire.mjs'
import { createNativeDelivery } from '../broker/native-delivery.mjs'
import { scopeOf, validateLedger, EVENT_WINDOW } from '../broker/store.mjs'
import { deliveryIsTerminal } from '../broker/validation.mjs'
import {
  fixture, fakeTransport, makeIntent, makeCommand, makeAttention, makeAnswer, observation,
  OWNER, MACHINE, TOKEN,
} from '../broker/fixtures/offline.mjs'

let passed = 0
const tests = []
const prepareGitCheckout = async workTree => ({ gitDir: '/tmp/offline-trusted-broker-git', workTree })
const reviewedRepoResult = { status: 0, stdout: JSON.stringify({ id: 'R_fixture_reviewed', visibility: 'PRIVATE', isEmpty: false }), stderr: '' }
const test = (name, fn) => tests.push({ name, fn })
async function rejects(fn, code) {
  await assert.rejects(fn, error => error.code === code, `Expected ${code}`)
}
async function launched(f, intent = makeIntent()) {
  const snapshot = await f.broker.prepare(intent)
  assert.equal(snapshot.commands[0].state, 'confirmed')
  assert.equal(snapshot.state, 'held') // A session receipt is not observed Mission execution.
  assert.equal(snapshot.lastObservedAt, null)
  return { intent, binding: snapshot.binding }
}
function ingest(f, intent, binding, overrides = {}) {
  return f.broker.ingestObservation(intent.missionId, OWNER, observation(intent, binding, overrides))
}
async function withFixture(fn, options) {
  const f = await fixture(options)
  try { await fn(f) } finally { await f.cleanup() }
}
async function serve(f, fn) {
  const server = await startBrokerServer({ broker: f.broker, bearerToken: TOKEN })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (path, value, options = {}) => {
    const response = await fetch(base + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
      body: value === undefined ? undefined : JSON.stringify(value),
      ...options,
    })
    return { status: response.status, body: await response.json() }
  }
  try { await fn(call, base) }
  finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
}

test('real router authentication, owner isolation, held admission and exact routes', () => withFixture(async f => {
  await serve(f, async call => {
    assert.equal((await call('/v1/native/capabilities', undefined, { headers: {} })).status, 401)
    const caps = await call('/v1/native/capabilities')
    assert.equal(caps.body.qualified, false); assert.equal(caps.body.launch, false)
    const intent = makeIntent()
    const prepared = await call('/v1/native/jobs', intent)
    assert.equal(prepared.status, 200)
    assert.equal(prepared.body.state, 'held')
    assert.equal(prepared.body.holdReason, 'native_launch_unqualified')
    assert.equal((await call('/v1/native/jobs', { ...intent, ownerId: 'someone-else', missionId: 'other' })).status, 403)
    assert.equal((await call('/v1/native/jobs/mission-1?ownerId=someone-else')).status, 403)
    assert.equal((await call('/v1/native/jobs/mission-1?ownerId=owner-fixture')).status, 200)
    assert.equal((await call('/v1/native/jobs/mission-1?ownerId=owner-fixture&ownerId=owner-fixture')).status, 400)
    assert.equal((await call('/v1/native/shell', { command: 'touch /tmp/no' })).status, 404)
    assert.equal((await call('/v1/native/jobs/other/commands', makeCommand(prepared.body, 'cancel'))).status, 400)
    assert.equal(f.transport.calls.length, 0)
    assert.equal(JSON.stringify(f.broker.store.data).includes(TOKEN), false)
  })
}, { qualified: false }))

test('signed qualification is required; boolean/fake manifests do not enable launch', () => withFixture(async f => {
  assert.equal((await f.broker.capabilities()).qualified, true)
  assert.equal((await f.broker.capabilities()).cancel, false)
  f.broker.close()
  const file = f.options.qualificationPath
  const saved = await readFile(file, 'utf8')
  const envelope = JSON.parse(saved); envelope.manifest.controls.cancel = true
  await writeFile(file, JSON.stringify(envelope))
  await rejects(() => NativeBroker.open(f.options), 'qualification_invalid')
  await writeFile(file, JSON.stringify({ qualified: true, launch: true }))
  await rejects(() => NativeBroker.open(f.options), 'qualification_invalid')
  await writeFile(file, saved)
  const restored = await NativeBroker.open(f.options)
  restored.close()
}))

test('consent, machine, immutable base, destination and settings holds have no side effects', () => withFixture(async f => {
  const cases = [
    [{ scopeApproved: false }, 'exact_scope_and_high_consent_required'],
    [{ highAutonomyApproved: false }, 'exact_scope_and_high_consent_required'],
    [{ workspace: { ...makeIntent().workspace, machineId: 'different-machine' } }, 'selected_machine_unavailable'],
    [{ workspace: { ...makeIntent().workspace, baseSha: undefined } }, 'immutable_base_required'],
    [{ destination: undefined }, 'explicit_destination_required'],
    [{ destination: { ...makeIntent().destination, kind: 'new_repository' } }, 'workspace_preparation_capability_unavailable'],
    [{ operation: 'clone' }, 'workspace_preparation_capability_unavailable'],
    [{ settings: {} }, 'effective_model_settings_required'],
  ]
  for (let i = 0; i < cases.length; i++) {
    const [overrides, reason] = cases[i]
    const input = JSON.parse(JSON.stringify(makeIntent(`held-${i}`, overrides)))
    const snapshot = await f.broker.prepare(input)
    assert.equal(snapshot.holdReason, reason)
  }
  assert.equal(f.transport.calls.length, 0)
}))

test('unsafe settings, secret material and oversized or malformed nested input refused', () => withFixture(async f => {
  await rejects(() => f.broker.prepare(makeIntent('unsafe', { settings: { skipScrutiny: true } })), 'validation_skipping_refused')
  await rejects(() => f.broker.prepare(makeIntent('secret', { goal: TOKEN })), 'secret_material_refused')
  await rejects(() => f.broker.prepare(makeIntent('huge', { goal: 'x'.repeat(200000) })), 'payload_too_large')
  await rejects(() => f.broker.prepare(makeIntent('extra', { settings: { token: 'not-allowed' } })), 'invalid_fields')
  await rejects(() => f.broker.prepare(makeIntent('malformed', { workspace: { machineId: MACHINE } })), 'invalid_fields')
  assert.equal(Object.keys(f.broker.store.data.jobs).length, 0)
}))

test('preflight binds actual workspace, effective settings, policy and High availability', async () => {
  for (const change of [
    { availableAutonomyLevels: ['low'] }, { policyEnforced: false }, { budgetEnforced: true }, { usageReporting: 'enforced' },
    { effectiveSettings: { ...makeIntent().settings, workerModel: 'substituted' } },
    { workspace: { ...makeIntent().workspace, cwd: '/wrong/checkout' } },
  ]) {
    const transport = fakeTransport()
    const preflight = transport.preflight
    transport.preflight = async function (...args) { return { ...await preflight.apply(this, args), ...change } }
    await withFixture(async f => {
      const result = await f.broker.prepare(makeIntent())
      assert.equal(result.commands[0].state, 'rejected')
      assert.equal(transport.calls.filter(call => call.method === 'launch').length, 0)
    }, { transport })
  }
})

test('launch receipt with unconfirmed mission settings never records effective settings', async () => {
  const keys = ['workerModel', 'skipScrutiny']
  const transport = fakeTransport()
  const launch = transport.launch
  transport.launch = async function (...args) { return { ...await launch.apply(this, args), unconfirmedSettings: keys } }
  await withFixture(async f => {
    const snapshot = await f.broker.prepare(makeIntent())
    assert.equal(snapshot.commands[0].state, 'confirmed')
    const job = f.broker.store.data.jobs['mission-1']
    assert.equal(job.effectiveSettings, null)
    const event = f.broker.store.data.events.find(row => row.kind === 'settings_unconfirmed')
    assert.deepEqual(event.data.keys, keys)
  }, { transport })
  for (const bad of [[], ['modelId'], ['workerModel', 'workerModel'], 'workerModel']) {
    const malformed = fakeTransport()
    const original = malformed.launch
    malformed.launch = async function (...args) { return { ...await original.apply(this, args), unconfirmedSettings: bad } }
    await withFixture(async f => {
      const snapshot = await f.broker.prepare(makeIntent())
      assert.equal(snapshot.commands[0].state, 'unknown')
      assert.equal(f.broker.store.data.events.some(row => row.kind === 'settings_unconfirmed'), false)
    }, { transport: malformed })
  }
})

test('intent and action dedupe is durable, conflict preserving and not provider exactly-once', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  const pending = makeAttention()
  const snapshot = ingest(f, intent, binding, { pending: [pending] })
  await f.broker.prepare(intent)
  assert.equal(f.transport.calls.filter(call => call.method === 'launch').length, 1)
  await rejects(() => f.broker.prepare({ ...intent, goal: 'Changed goal.' }), 'intent_conflict')
  const action = makeCommand(snapshot, 'answer', { answer: makeAnswer(pending.attention) })
  const first = await f.broker.command(action)
  assert.equal(first.state, 'unknown')
  assert.equal(f.broker.project('mission-1', OWNER).attention[0].state, 'answer_unknown')
  assert.deepEqual(await f.broker.command(action), first)
  await rejects(() => f.broker.command({ ...action, answer: { ...action.answer, selectedOption: 'cancel' } }), 'command_identity_conflict')
  assert.equal(f.transport.calls.filter(call => call.method === 'answer').length, 1)
  f.broker.close()
  const restored = await NativeBroker.open(f.options)
  try {
    assert.deepEqual(await restored.command(action), first)
    assert.equal(restored.project('mission-1', OWNER).completeness, 'unknown')
    assert.equal(f.transport.calls.filter(call => call.method === 'answer').length, 1)
  } finally { restored.close() }
}))

test('empty, malformed, mismatched and lost launch success hold unknown without retry', async () => {
  for (const mode of ['empty', 'mismatched', 'wrong-binding', 'lost']) {
    const transport = fakeTransport()
    const launch = transport.launch
    transport.launch = async function (...args) {
      const normal = await launch.apply(this, args)
      if (mode === 'empty') return {}
      if (mode === 'mismatched') return { ...normal, commandId: 'wrong-command' }
      if (mode === 'wrong-binding') return { ...normal, binding: { ...normal.binding, cwd: '/wrong/checkout' } }
      throw new Error('Bearer provider-private-secret-must-not-leak')
    }
    await withFixture(async f => {
      const result = await f.broker.prepare(makeIntent())
      assert.equal(result.commands[0].state, 'unknown')
      assert.equal(result.binding, null)
      assert.equal(result.holdReason, 'unknown_command_requires_reconciliation')
      await f.broker.prepare(makeIntent())
      assert.equal(transport.calls.filter(call => call.method === 'launch').length, 1)
      assert.equal((await readFile(join(f.ledgerDir, 'ledger.json'), 'utf8')).includes('provider-private-secret'), false)
    }, { transport })
  }
})

test('request, scope, revision, offered outcome, machine and session are exact barriers', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  const pending = makeAttention()
  const snapshot = ingest(f, intent, binding, { pending: [pending] })
  for (const [override, code] of [
    [{ requestId: 'old-request' }, 'stale_attention'],
    [{ payloadHash: 'b'.repeat(64) }, 'stale_attention'],
    [{ revision: 2 }, 'stale_attention'],
    [{ machineId: 'other-machine' }, 'stale_attention'],
    [{ sessionId: 'other-session' }, 'stale_attention'],
    [{ selectedOption: 'not-offered' }, 'option_not_offered'],
  ]) {
    await rejects(() => f.broker.command(makeCommand(snapshot, 'answer', { answer: makeAnswer(pending.attention, override) })), code)
  }
  await rejects(() => f.broker.command(makeCommand(snapshot, 'answer', { expectedScopeRevision: 2, answer: makeAnswer(pending.attention) })), 'stale_scope')
  await rejects(() => f.broker.command(makeCommand(snapshot, 'answer', { expectedBrokerSeq: 0, answer: makeAnswer(pending.attention) })), 'stale_broker_revision')
  assert.equal(f.transport.calls.filter(call => call.method === 'answer').length, 0)
}))

test('root/child permission associations are one request, not answer fanout', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  const pending = makeAttention({ sessionId: 'worker-1' })
  pending.attention.associatedSessionIds = [binding.sessionId]
  const secondView = clone(pending); secondView.attention.associatedSessionIds = ['worker-1']
  const snapshot = ingest(f, intent, binding, {
    pending: [pending, secondView], workerSessionIds: ['worker-1'], sessionIds: [binding.sessionId, 'worker-1'],
  })
  assert.equal(snapshot.attention.length, 1)
  assert.deepEqual(snapshot.attention[0].associatedSessionIds.sort(), [binding.sessionId, 'worker-1'].sort())
  await f.broker.command(makeCommand(snapshot, 'answer', { answer: makeAnswer(snapshot.attention[0]) }))
  assert.equal(f.transport.calls.filter(call => call.method === 'answer').length, 1)
  assert.equal(f.transport.calls.find(call => call.method === 'answer').answer.sessionId, 'worker-1')
}))

const QUESTIONS = [
  { index: 1, topic: 'Accent', question: 'Choose the full accent label.', multiSelect: false,
    options: [{ id: 'a', label: 'Same fitted prefix, turquoise', value: 'turquoise-full-value' }, { id: 'b', label: 'Same fitted prefix, teal', value: 'teal-full-value' }] },
  { index: 2, topic: 'Platforms', question: 'Choose all target platforms.', multiSelect: true,
    options: [{ id: 'ios', label: 'iOS', value: 'ios' }, { id: 'android', label: 'Android', value: 'android' }] },
]
test('root and child multiquestion/multiselect retain raw values and complete answers', async () => {
  for (const sessionId of ['session-mission-1', 'worker-1']) await withFixture(async f => {
    const { intent, binding } = await launched(f)
    const pending = makeAttention({ kind: 'ask_user', sessionId, questions: QUESTIONS })
    const snapshot = ingest(f, intent, binding, { pending: [pending], sessionIds: [binding.sessionId, 'worker-1'], workerSessionIds: ['worker-1'] })
    const answer = makeAnswer(pending.attention)
    delete answer.selectedOption
    answer.answers = [{ index: 1, answer: 'turquoise-full-value' }]
    await rejects(() => f.broker.command(makeCommand(snapshot, 'answer', { answer })), 'complete_questionnaire_required')
    answer.answers.push({ index: 2, answer: '["ios","android"]' })
    await f.broker.command(makeCommand(snapshot, 'answer', { answer }))
    assert.deepEqual(f.transport.calls.find(call => call.method === 'answer').answer.answers, answer.answers)
    assert.equal(f.broker.project('mission-1', OWNER).attention[0].questions[0].options[0].label, QUESTIONS[0].options[0].label)
  })
})

test('external resolution needs complete authoritative child boundaries, never optimistic disappearance', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  const pending = makeAttention({ sessionId: 'worker-1' })
  ingest(f, intent, binding, { pending: [pending], sessionIds: [binding.sessionId, 'worker-1'], workerSessionIds: ['worker-1'] })
  let snapshot = ingest(f, intent, binding, { pending: [], pendingComplete: false, completeness: 'gap' })
  assert.equal(snapshot.attention[0].state, 'open')
  snapshot = ingest(f, intent, binding, { pending: [] }) // Child session boundary missing.
  assert.equal(snapshot.attention[0].state, 'open')
  snapshot = ingest(f, intent, binding, { pending: [], sessionIds: [binding.sessionId, 'worker-1'] })
  assert.equal(snapshot.attention[0].state, 'resolved')
  await rejects(() => f.broker.command(makeCommand(snapshot, 'answer', { answer: makeAnswer(pending.attention) })), 'attention_not_open')
}))

test('proposal and run-start are separate; only correlated acceptance authorizes exact start', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  const proposal = makeAttention({ kind: 'proposal', requestId: 'proposal-rpc' })
  let snapshot = ingest(f, intent, binding, { pending: [proposal] })
  const action = makeCommand(snapshot, 'answer', { answer: makeAnswer(proposal.attention) })
  await f.broker.command(action)
  const start = makeAttention({ kind: 'start', requestId: 'start-rpc' })
  start.proposalHash = proposal.attention.payloadHash
  snapshot = ingest(f, intent, binding, { pending: [start] })
  assert.equal(snapshot.attention.find(a => a.kind === 'proposal').state, 'resolved')
  assert.equal(snapshot.commands.find(row => row.commandId === action.commandId).state, 'unknown')
  await rejects(() => f.broker.command(makeCommand(snapshot, 'answer', { answer: makeAnswer(start.attention) })), 'unknown_or_active_command')
  snapshot = ingest(f, intent, binding, { pending: [start], commandResolutions: [
    { commandId: action.commandId, requestHash: hash(action), status: 'confirmed', receiptId: 'authoritative-native-outcome-1' },
  ] })
  const receipt = await f.broker.command(makeCommand(snapshot, 'answer', { answer: makeAnswer(start.attention) }))
  assert.equal(receipt.state, 'unknown')
  assert.equal(snapshot.state, 'awaiting_input')
  assert.equal(f.transport.calls.filter(call => call.method === 'answer').length, 2)
}))

test('replacement features and progress do not accumulate; heartbeats do not fake freshness', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  const before = ingest(f, intent, binding)
  const notify = (type, payload) => f.broker.ingestNotification('mission-1', OWNER, { machineId: MACHINE, sessionId: binding.sessionId, type, payload })
  const a = { id: 'f1', description: 'Feature', status: 'completed', expectedBehavior: ['Evidence still required.'] }
  notify('mission_features_changed', { features: [a] })
  notify('mission_features_changed', { features: [] })
  notify('mission_progress_entry', { progressLog: [{ type: 'worker_failed', timestamp: '2026-10-12T00:00:00Z', reason: 'partial' }] })
  notify('mission_progress_entry', { progressLog: [] })
  notify('mission_heartbeat', { timestamp: '2026-10-12T00:01:00Z' })
  const result = f.broker.project('mission-1', OWNER)
  assert.deepEqual(result.features, [])
  assert.deepEqual(f.broker.store.data.jobs['mission-1'].progressLog, [])
  assert.equal(result.lastObservedAt, before.lastObservedAt)
  assert.equal(result.finalization, null)
}))

test('scope/settings changes, malformed observation, and stale pending reads never authorize answers', () => withFixture(async f => {
  const { intent, binding } = await launched(f), pending = makeAttention()
  let snapshot = ingest(f, intent, binding, { pending: [pending], scopeRevision: 2 })
  await rejects(() => f.broker.command(makeCommand(snapshot, 'answer', { answer: makeAnswer(pending.attention) })), 'fresh_observation_required')
  assert.equal(snapshot.holdReason, 'scope_policy_observation_mismatch')
  snapshot = ingest(f, intent, binding, { pending: [pending], effectiveSettings: { ...intent.settings, workerModel: 'policy-substitution' } })
  await rejects(() => f.broker.command(makeCommand(snapshot, 'answer', { answer: makeAnswer(pending.attention) })), 'fresh_observation_required')
  const seq = snapshot.brokerSeq
  assert.throws(() => ingest(f, intent, binding, { pending: [{ ...pending, raw: {} }] }), error => error.code === 'invalid_pending_binding')
  assert.equal(f.broker.project('mission-1', OWNER).brokerSeq, seq)
}))

test('requested pause/cancel and terminal state block every subsequent execution send', async () => {
  for (const kind of ['pause', 'cancel', 'completed']) await withFixture(async f => {
    const { intent, binding } = await launched(f), pending = makeAttention()
    let snapshot = ingest(f, intent, binding, { pending: [pending] })
    if (kind === 'completed') snapshot = ingest(f, intent, binding, { state: 'completed', pending: [pending] })
    else {
      const receipt = await f.broker.command(makeCommand(snapshot, kind))
      assert.equal(receipt.state, 'rejected')
      assert.match(receipt.reason, /unavailable_factory_handoff/)
      snapshot = f.broker.project('mission-1', OWNER)
      assert.equal(snapshot.control, kind === 'pause' ? 'pause_requested' : 'cancel_requested')
      snapshot = ingest(f, intent, binding, { state: 'running', pending: [pending] })
    }
    await rejects(() => f.broker.command(makeCommand(snapshot, 'answer', { answer: makeAnswer(pending.attention) })), 'execution_stopped')
    const resume = await f.broker.command(makeCommand(snapshot, 'resume'))
    assert.equal(resume.state, 'rejected')
    assert.equal(f.transport.calls.filter(call => call.method === 'answer').length, 0)
  })
})

test('cancel concurrent with initialization tracks late session without fake cancellation', () => withFixture(async f => {
  let settle
  const original = f.transport.launch
  f.transport.launch = async function (...args) {
    const result = await original.apply(this, args)
    return new Promise(resolve => { settle = () => resolve(result) })
  }
  const prepared = f.broker.prepare(makeIntent())
  while (!settle) await new Promise(resolve => setImmediate(resolve))
  const during = f.broker.project('mission-1', OWNER)
  await f.broker.command(makeCommand(during, 'cancel'))
  settle()
  const after = await prepared
  assert.equal(after.control, 'cancel_requested')
  assert.ok(after.binding)
  assert.notEqual(after.control, 'cancelled')
  assert.equal(f.transport.calls.filter(call => call.method === 'launch').length, 1)
}))

test('launch timeout keeps unknown; eventual resources are attached without replay or claiming stop', () => withFixture(async f => {
  const original = f.transport.launch
  let settle
  f.transport.launch = async function (...args) {
    const result = await original.apply(this, args)
    return new Promise(resolve => { settle = () => resolve(result) })
  }
  const before = await f.broker.prepare(makeIntent())
  assert.equal(before.commands[0].state, 'unknown')
  assert.equal(before.commands[0].reason, 'invoked_timeout')
  assert.equal(before.binding, null)
  await f.broker.command(makeCommand(before, 'cancel'))
  settle()
  await new Promise(resolve => setImmediate(resolve))
  const after = f.broker.project('mission-1', OWNER)
  assert.ok(after.binding)
  assert.equal(after.commands[0].state, 'unknown')
  assert.equal(after.control, 'cancel_requested')
  assert.ok(f.broker.readEvents(OWNER).some(event => event.kind === 'late_binding_observed'))
}, { timeoutMs: 20 }))

test('guard immediately before SDK-like send rejects self-reactivation after concurrent pause', () => withFixture(async f => {
  const { intent, binding } = await launched(f), pending = makeAttention()
  const snapshot = ingest(f, intent, binding, { pending: [pending] })
  let send
  f.transport.answer = async (answer, ctx) => new Promise((resolve, reject) => {
    send = () => {
      try { ctx.guard(); f.transport.calls.push({ method: 'answer', answer }); resolve({ status: 'sent', commandId: ctx.commandId }) }
      catch (error) { reject(error) }
    }
  })
  const operation = f.broker.command(makeCommand(snapshot, 'answer', { answer: makeAnswer(pending.attention) }))
  while (!send) await new Promise(resolve => setImmediate(resolve))
  await f.broker.command(makeCommand(f.broker.project('mission-1', OWNER), 'pause'))
  send()
  assert.equal((await operation).state, 'unknown')
  assert.equal(f.transport.calls.filter(call => call.method === 'answer').length, 0)
}))

test('single writer lock, owner mismatch and stale fencing prevent competing execution', () => withFixture(async f => {
  await rejects(() => NativeBroker.open(f.options), 'writer_locked')
  const { intent, binding } = await launched(f), pending = makeAttention()
  const snapshot = ingest(f, intent, binding, { pending: [pending] })
  const lockPath = join(f.ledgerDir, '.writer', 'owner.json')
  const savedLock = await readFile(lockPath, 'utf8')
  await writeFile(lockPath, JSON.stringify({ ...JSON.parse(savedLock), token: 'other-writer-token' }))
  await rejects(() => f.broker.command(makeCommand(snapshot, 'answer', { answer: makeAnswer(pending.attention) })), 'writer_fenced')
  assert.equal(f.transport.calls.filter(call => call.method === 'answer').length, 0)
  await writeFile(lockPath, savedLock)
  f.broker.close()
  await rejects(() => NativeBroker.open({ ...f.options, ownerId: 'different-owner', qualificationPath: undefined, qualificationPublicKey: undefined }), 'store_owner_mismatch')
}))

test('real process loss after launch or before invocation is durable and never auto-replayed', async () => {
  for (const crashAt of ['prepared', 'launch']) await withFixture(async f => {
    f.broker.close()
    const configPath = join(f.directory, 'crash-config.json')
    await writeFile(configPath, JSON.stringify({ crashAt, options: { ...f.options, transport: undefined, now: undefined, timeoutMs: 500 } }))
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../broker/fixtures/crash-worker.mjs', import.meta.url)), configPath], { timeout: 5000, encoding: 'utf8' })
    assert.equal(child.status, 17, child.stderr)
    await rejects(() => NativeBroker.open(f.options), 'writer_locked')
    const lock = JSON.parse(await readFile(join(f.ledgerDir, '.writer', 'owner.json'), 'utf8'))
    recoverDeadWriter({ directory: f.ledgerDir, expectedToken: lock.token })
    const restored = await NativeBroker.open(f.options)
    try {
      const snapshot = await restored.prepare(makeIntent())
      assert.equal(snapshot.commands[0].state, crashAt === 'launch' ? 'unknown' : 'prepared')
      assert.equal(snapshot.binding, null)
      assert.equal(f.transport.calls.length, 0)
      const same = await restored.prepare(makeIntent())
      assert.equal(same.commands[0].state, snapshot.commands[0].state)
    } finally { restored.close() }
  })
})

test('real process loss during answer requires exact recovery and never resends archived RPC', () => withFixture(async f => {
  const { intent, binding } = await launched(f), pending = makeAttention()
  ingest(f, intent, binding, { pending: [pending] })
  f.broker.close()
  const configPath = join(f.directory, 'crash-config.json')
  await writeFile(configPath, JSON.stringify({
    crashAt: 'answer', options: { ...f.options, transport: undefined, now: undefined, timeoutMs: 500 },
    observation: observation(intent, binding, { pending: [pending] }),
  }))
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../broker/fixtures/crash-worker.mjs', import.meta.url)), configPath], { timeout: 5000, encoding: 'utf8' })
  assert.equal(child.status, 17, child.stderr)
  const lock = JSON.parse(await readFile(join(f.ledgerDir, '.writer', 'owner.json'), 'utf8'))
  recoverDeadWriter({ directory: f.ledgerDir, expectedToken: lock.token })
  const restored = await NativeBroker.open(f.options)
  try {
    const snapshot = restored.project('mission-1', OWNER)
    assert.equal(snapshot.commands.find(row => row.commandId === 'crash-answer').state, 'unknown')
    assert.equal(snapshot.attention[0].state, 'answer_unknown')
    await rejects(() => restored.command(makeCommand(snapshot, 'answer', { answer: makeAnswer(pending.attention) })), 'unknown_or_active_command')
    assert.equal(f.transport.calls.filter(call => call.method === 'answer').length, 0)
  } finally { restored.close() }
}))

test('checksum, nested corruption, missing ledger and unsafe recovery are refused', async () => {
  for (const corruption of ['checksum', 'nested', 'missing']) await withFixture(async f => {
    await f.broker.prepare(makeIntent())
    const ledgerPath = join(f.ledgerDir, 'ledger.json')
    f.broker.close()
    if (corruption === 'missing') await unlink(ledgerPath)
    else {
      const envelope = JSON.parse(await readFile(ledgerPath, 'utf8'))
      if (corruption === 'checksum') envelope.checksum = 'f'.repeat(64)
      else {
        envelope.data.jobs['mission-1'].snapshot.attention.push({ requestId: 'damaged' })
        envelope.checksum = hash(envelope.data)
      }
      await writeFile(ledgerPath, JSON.stringify(envelope))
    }
    await rejects(() => NativeBroker.open(f.options), 'store_corrupt')
  })
  await withFixture(async f => {
    const lock = JSON.parse(await readFile(join(f.ledgerDir, '.writer', 'owner.json'), 'utf8'))
    assert.throws(() => recoverDeadWriter({ directory: f.ledgerDir, expectedToken: lock.token }), error => error.code === 'writer_alive')
    assert.equal((await lstat(join(f.ledgerDir, '.writer'))).isDirectory(), true)
  })
})

test('a provider record failing SDK revalidation is quarantined per job, never store-wide corruption', () => withFixture(async f => {
  await launched(f)
  await launched(f, makeIntent('mission-2'))
  f.broker.close()
  const ledgerPath = join(f.ledgerDir, 'ledger.json')
  const envelope = JSON.parse(await readFile(ledgerPath, 'utf8'))
  const job = envelope.data.jobs['mission-1']
  // A well-formed ledger row whose SDK provider record no longer validates, as
  // written by an older or newer build (recordHash stays honest).
  const value = { version: 1, step: 'step_from_a_newer_provider' }
  job.providerRecord = { transportVersion: SDK_TRANSPORT_VERSION, scopeHash: job.scopeHash, policyHash: job.policyHash,
    epoch: envelope.data.epoch, recordHash: hash(value), value }
  envelope.checksum = hash(envelope.data)
  await writeFile(ledgerPath, JSON.stringify(envelope))
  const restored = await NativeBroker.open(f.options)
  try {
    const held = restored.project('mission-1', OWNER)
    assert.equal(held.holdReason, 'sdk_provider_record_unreadable')
    assert.equal(held.completeness, 'gap')
    assert.notEqual(restored.project('mission-2', OWNER).holdReason, 'sdk_provider_record_unreadable')
    const quarantined = restored.store.data.jobs['mission-1'].providerRecord
    assert.equal(quarantined.quarantine, 'sdk_provider_record_unreadable')
    assert.equal(quarantined.value.step, 'step_from_a_newer_provider') // evidence retained
  } finally { restored.close() }
  // The quarantine is durable: reopening never fails and never re-derives authority.
  const again = await NativeBroker.open(f.options)
  try {
    assert.equal(again.project('mission-1', OWNER).holdReason, 'sdk_provider_record_unreadable')
    assert.notEqual(again.project('mission-2', OWNER).holdReason, 'sdk_provider_record_unreadable')
  } finally { again.close() }
}))

test('read-only finalization persists, deadlines bound collection and artifact claims stay unverified', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  let snapshot = ingest(f, intent, binding, { state: 'completed', workersSettled: false })
  assert.equal(snapshot.finalization.state, 'pending')
  const last = snapshot.lastObservedAt
  f.broker.close()
  const restored = await NativeBroker.open(f.options)
  try {
    snapshot = restored.project('mission-1', OWNER)
    assert.equal(snapshot.lastObservedAt, last)
    assert.equal(snapshot.completeness, 'unknown')
    assert.equal(snapshot.finalization.state, 'pending')
    snapshot = restored.ingestObservation('mission-1', OWNER, observation(intent, binding, {
      state: 'completed', workersSettled: true, summary: 'Native summary observed.',
      evidence: [{ id: 'artifact-1', url: 'https://example.com/claimed-artifact', commitSha: 'c'.repeat(40) }],
    }))
    assert.equal(snapshot.finalization.state, 'incomplete')
    assert.equal(snapshot.finalization.evidence[0].verified, false)
    assert.equal(f.transport.calls.filter(call => call.method === 'launch').length, 1)
  } finally { restored.close() }
}))

test('failed read does not refresh state; deadlines and retained events are bounded owner-scoped', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  const snapshot = ingest(f, intent, binding)
  const failed = await f.broker.observe('mission-1', OWNER)
  assert.equal(failed.lastObservedAt, snapshot.lastObservedAt)
  assert.equal(failed.completeness, 'gap')
  const events = f.broker.readEvents(OWNER, 0, 200)
  assert.equal(events.every((event, i) => event.seq === i + 1), true)
  assert.throws(() => f.broker.readEvents('different-owner', 0, 1), error => error.code === 'owner_forbidden')
  assert.throws(() => f.broker.readEvents(OWNER, 0, 201), error => error.code === 'invalid_cursor')
}))

test('disconnected phone request never cancels broker work or detaches provider requests', () => withFixture(async f => {
  await serve(f, async (call, base) => {
    let settle
    const original = f.transport.launch
    f.transport.launch = async function (...args) {
      const result = await original.apply(this, args)
      return new Promise(resolve => { settle = () => resolve(result) })
    }
    const req = request(base + '/v1/native/jobs', {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    })
    req.on('error', () => {})
    req.end(JSON.stringify(makeIntent()))
    while (!settle) await new Promise(resolve => setImmediate(resolve))
    req.destroy()
    settle()
    await new Promise(resolve => setTimeout(resolve, 10))
    const observed = await call('/v1/native/jobs/mission-1?ownerId=owner-fixture')
    assert.equal(observed.status, 200)
    assert.ok(observed.body.binding)
    assert.equal(observed.body.commands[0].state, 'confirmed')
    assert.equal(f.transport.calls.filter(call => call.method === 'launch').length, 1)
  })
}))

test('default startup does not expose a public port or load an SDK; errors are safe', () => withFixture(async f => {
  await rejects(() => startBrokerServer({ broker: f.broker, bearerToken: TOKEN, host: '0.0.0.0' }), 'loopback_only')
  await rejects(() => startFromEnv({}), 'host_configuration_required')
  await serve(f, async call => {
    const response = await call('/v1/native/jobs', { ...makeIntent(), secret: 'anything' })
    assert.deepEqual(response.body, { error: 'secret_material_refused' })
    const origin = await call('/v1/native/capabilities', undefined, { headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://untrusted.example' } })
    assert.equal(origin.status, 403)
  })
}, { qualified: false }))

test('two jobs and identical replacement questions never reuse ownership or notice identity', () => withFixture(async f => {
  const first = await launched(f)
  const second = await launched(f, makeIntent('mission-2'))
  const question = makeAttention({ kind: 'ask_user', questions: [QUESTIONS[0]] })
  const other = makeAttention({ kind: 'ask_user', requestId: 'other-rpc', sessionId: second.binding.sessionId, questions: [QUESTIONS[0]] })
  ingest(f, first.intent, first.binding, { pending: [question] })
  let snapshot = ingest(f, second.intent, second.binding, { pending: [other] })
  const wrong = makeAnswer(question.attention); delete wrong.selectedOption
  wrong.answers = [{ index: 1, answer: 'teal-full-value' }]
  await rejects(() => f.broker.command(makeCommand(snapshot, 'answer', { answer: wrong })), 'attention_not_open')
  ingest(f, first.intent, first.binding)
  const replacement = makeAttention({ kind: 'ask_user', requestId: 'replacement-rpc', questions: [QUESTIONS[0]] })
  snapshot = ingest(f, first.intent, first.binding, { pending: [replacement] })
  assert.equal(snapshot.attention.length, 2)
  assert.equal(snapshot.attention[0].state, 'resolved')
  assert.equal(snapshot.attention[1].state, 'open')
  assert.equal(f.broker.readEvents(OWNER).filter(event => event.kind === 'attention_opened').length, 3)
  assert.equal(f.transport.calls.filter(call => call.method === 'answer').length, 0)
}))

test('a retained child outside latest complete pending boundaries cannot be answered', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  const pending = makeAttention({ sessionId: 'worker-1' })
  ingest(f, intent, binding, { pending: [pending], sessionIds: [binding.sessionId, 'worker-1'], workerSessionIds: ['worker-1'] })
  const snapshot = ingest(f, intent, binding) // root-only read, child handle not revalidated.
  assert.equal(snapshot.attention[0].state, 'open')
  await rejects(() => f.broker.command(makeCommand(snapshot, 'answer', { answer: makeAnswer(pending.attention) })), 'pending_request_reconciliation_required')
  assert.equal(f.transport.calls.filter(call => call.method === 'answer').length, 0)
}))

test('malformed/empty answer receipts and duplicate live requests remain outcome unknown', async () => {
  for (const response of [{}, { status: 'sent', commandId: 'wrong' }, { status: 'confirmed' }]) await withFixture(async f => {
    const { intent, binding } = await launched(f), pending = makeAttention()
    const snapshot = ingest(f, intent, binding, { pending: [pending] })
    f.transport.answer = async (answer, ctx) => { ctx.guard(); f.transport.calls.push({ method: 'answer', answer }); return response }
    const action = makeCommand(snapshot, 'answer', { answer: makeAnswer(pending.attention) })
    assert.equal((await f.broker.command(action)).state, 'unknown')
    const fresh = ingest(f, intent, binding, { pending: [pending] })
    await rejects(() => f.broker.command(makeCommand(fresh, 'answer', { answer: action.answer })), 'unknown_or_active_command')
    assert.equal(fresh.attention[0].state, 'answer_unknown')
    assert.equal(f.transport.calls.filter(call => call.method === 'answer').length, 1)
  })
})

test('terminal deadline is enforced without a supported adapter; no post-terminal summary turn', async () => {
  let now = Date.now()
  await withFixture(async f => {
    const { intent, binding } = await launched(f)
    let snapshot = ingest(f, intent, binding, { state: 'completed' })
    assert.equal(snapshot.finalization.state, 'pending')
    now += 60001
    f.transport.support.readOnlyObservation = false
    snapshot = await f.broker.observe('mission-1', OWNER)
    assert.equal(snapshot.finalization.state, 'incomplete')
    assert.equal(snapshot.finalization.reason, 'readonly_collection_deadline_or_attempt_limit')
    assert.equal(f.transport.calls.filter(call => call.method === 'observe').length, 0)
    assert.equal(f.transport.calls.filter(call => call.method === 'launch').length, 1)
    snapshot = ingest(f, intent, binding, { state: 'running' })
    assert.equal(snapshot.state, 'completed')
    assert.equal(snapshot.completeness, 'gap')
    assert.equal(snapshot.finalization.state, 'incomplete')
  }, { now: () => now })
})

test('service read-only loop continues observation without a phone or HTTP client', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  f.transport.observations.set(binding.sessionId, observation(intent, binding, { state: 'running' }))
  f.broker.startObservationLoop({ intervalMs: 20 })
  for (let i = 0; i < 100 && f.broker.project('mission-1', OWNER).state !== 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5))
  const snapshot = f.broker.project('mission-1', OWNER)
  assert.equal(snapshot.state, 'running')
  assert.equal(snapshot.completeness, 'complete')
  assert.ok(f.transport.calls.some(call => call.method === 'observe' && call.readOnly))
  assert.equal(f.transport.calls.filter(call => call.method === 'launch').length, 1)
}))

test('restore freezes original workspace despite future settings and machine defaults', () => withFixture(async f => {
  const { intent, binding } = await launched(f), pending = makeAttention()
  ingest(f, intent, binding, { pending: [pending] })
  f.broker.close()
  const transport = fakeTransport()
  const restored = await NativeBroker.open({
    ...f.options, machineId: 'new-default-machine', qualificationPath: undefined,
    qualificationPublicKey: undefined, transport,
  })
  try {
    const snapshot = restored.project('mission-1', OWNER)
    assert.deepEqual(snapshot.binding, binding)
    assert.equal(snapshot.binding.baseRef, 'trunk')
    assert.equal(snapshot.binding.machineId, MACHINE)
    await rejects(() => restored.command(makeCommand(snapshot, 'answer', { answer: makeAnswer(pending.attention) })), 'qualification_changed_or_unavailable')
    assert.equal(transport.calls.length, 0)
  } finally { restored.close() }
}))

test('SDK boundary stays optional and pinned; standalone package never imports execution SDK', async () => {
  const adapterPath = fileURLToPath(new URL('../broker/sdk-adapter.ts', import.meta.url))
  const checked = spawnSync(process.execPath, ['--experimental-strip-types', '--check', adapterPath], { encoding: 'utf8', timeout: 5000 })
  assert.equal(checked.status, 0, checked.stderr)
  const metadata = JSON.parse(await readFile(new URL('../broker/package.json', import.meta.url), 'utf8'))
  assert.equal(metadata.peerDependencies['@factory/droid-sdk'], '0.9.1')
  assert.equal(metadata.peerDependenciesMeta['@factory/droid-sdk'].optional, true)
  const adapter = await readFile(adapterPath, 'utf8')
  assert.ok(adapter.includes('createInjectedNativeProvider'))
  assert.ok(adapter.includes('createClient(transport)'))
  assert.ok(adapter.includes('client.initializeSession'))
  assert.ok(adapter.includes('client.addUserMessage'))
  assert.equal(/client\.(?:loadSession|interruptSession|killWorkerSession|closeSession)\(/.test(adapter), false)
  assert.equal(/(?:new sdk\.DaemonSessionController|sdk\.connectToDaemon|sdk\.connectAndAuthenticate)/.test(adapter), false)
  for (const path of ['index.mjs', 'broker.mjs', 'server.mjs', 'store.mjs']) {
    assert.equal((await readFile(new URL(`../broker/${path}`, import.meta.url), 'utf8')).includes('import(\'@factory/droid-sdk\')'), false)
  }
})

function largeAttention(requestId, sessionId = 'session-mission-1', details = 'd'.repeat(55000)) {
  const row = makeAttention({ requestId, sessionId })
  row.raw.details = details
  row.attention.details = details
  row.attention.payloadHash = hash(row.raw)
  return row
}
const nextTick = () => new Promise(resolve => setImmediate(resolve))
const wireBytes = snapshot => Buffer.byteLength(JSON.stringify(snapshot))

test('timed-out provider reads retain a real reservation across direct, HTTP and service retries', async () => {
  for (const lateOutcome of ['fulfilled', 'rejected']) await withFixture(async f => {
    const { intent, binding } = await launched(f)
    const before = ingest(f, intent, binding)
    let calls = 0, settle
    f.transport.observe = () => {
      calls++
      return new Promise((resolve, reject) => {
        settle = () => lateOutcome === 'fulfilled'
          ? resolve(observation(intent, binding, { state: 'running' }))
          : reject(new Error('Late fixture rejection, not a provider credential.'))
      })
    }
    for (let i = 0; i < 12; i++) await f.broker.observe('mission-1', OWNER)
    assert.equal(calls, 1)
    assert.equal(f.broker.reads.size, 1)
    const timedOut = f.broker.project('mission-1', OWNER)
    assert.equal(timedOut.completeness, 'gap')
    assert.equal(timedOut.lastObservedAt, before.lastObservedAt)
    await Promise.all(Array.from({ length: 12 }, () => f.broker.observe('mission-1', OWNER)))
    await serve(f, async call => {
      for (let i = 0; i < 12; i++) {
        const result = await call('/v1/native/jobs/mission-1?ownerId=owner-fixture')
        assert.equal(result.status, 200)
        assert.equal(result.body.completeness, 'gap')
      }
      // startBrokerServer already owns a timer. Replace just the fixture's interval
      // so retries exercise multiple poll cycles rather than waiting five seconds.
      clearInterval(f.broker.observationTimer); f.broker.observationTimer = null
      f.broker.startObservationLoop({ intervalMs: 20 })
      await new Promise(resolve => setTimeout(resolve, 80))
      assert.equal(calls, 1)
      assert.equal(f.broker.reads.size, 1)
      clearInterval(f.broker.observationTimer); f.broker.observationTimer = null
      const seq = f.broker.project('mission-1', OWNER).brokerSeq
      const unhandled = []
      const capture = error => unhandled.push(error)
      process.on('unhandledRejection', capture)
      try { settle(); await nextTick(); await nextTick() }
      finally { process.off('unhandledRejection', capture) }
      assert.deepEqual(unhandled, [])
      assert.equal(f.broker.reads.size, 0)
      const afterLate = f.broker.project('mission-1', OWNER)
      assert.equal(afterLate.brokerSeq, seq)
      assert.equal(afterLate.state, before.state) // Late success is not fresh authority.
      assert.equal(afterLate.completeness, 'gap')
      f.transport.observe = async () => { calls++; return observation(intent, binding, { state: 'planning' }) }
      const recovered = await call('/v1/native/jobs/mission-1?ownerId=owner-fixture')
      assert.equal(recovered.status, 200)
      assert.equal(recovered.body.state, 'planning')
      assert.equal(recovered.body.completeness, 'complete')
      assert.equal(calls, 2)
      assert.equal(f.broker.reads.size, 0)
    })
  }, { timeoutMs: 20 })
})

test('global read capacity counts stalled underlying operations, not expired caller waits', () => withFixture(async f => {
  const jobs = []
  for (let i = 0; i < NATIVE_MAX_OUTSTANDING_READS + 2; i++) jobs.push(await launched(f, makeIntent(`read-${i}`)))
  let calls = 0
  const settle = new Map()
  f.transport.observe = (binding, ctx) => {
    calls++
    return new Promise(resolve => { settle.set(ctx.missionId, () => resolve(observation(jobs.find(job => job.intent.missionId === ctx.missionId).intent, binding))) })
  }
  for (const { intent } of jobs) await f.broker.observe(intent.missionId, OWNER)
  assert.equal(calls, NATIVE_MAX_OUTSTANDING_READS)
  assert.equal(f.broker.reads.size, NATIVE_MAX_OUTSTANDING_READS)
  for (const { intent } of jobs.slice(NATIVE_MAX_OUTSTANDING_READS)) {
    const snapshot = f.broker.project(intent.missionId, OWNER)
    assert.equal(snapshot.completeness, 'gap')
    assert.equal(snapshot.holdReason, 'observation_capacity_exceeded')
    assert.equal(snapshot.lastObservedAt, null)
  }
  for (let i = 0; i < 12; i++) for (const { intent } of jobs) await f.broker.observe(intent.missionId, OWNER)
  assert.equal(calls, NATIVE_MAX_OUTSTANDING_READS)
  settle.get(jobs[0].intent.missionId)()
  await nextTick()
  assert.equal(f.broker.reads.size, NATIVE_MAX_OUTSTANDING_READS - 1)
  const newlyStarted = jobs[NATIVE_MAX_OUTSTANDING_READS].intent.missionId
  await f.broker.observe(newlyStarted, OWNER)
  assert.equal(calls, NATIVE_MAX_OUTSTANDING_READS + 1)
  assert.equal(f.broker.reads.size, NATIVE_MAX_OUTSTANDING_READS)
  for (const release of settle.values()) release()
  await nextTick()
  assert.equal(f.broker.reads.size, 0)
}, { timeoutMs: 20 }))

test('a provider read settling after broker close cannot mutate restored authority', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  ingest(f, intent, binding)
  let settle
  f.transport.observe = () => new Promise(resolve => { settle = () => resolve(observation(intent, binding, { state: 'running' })) })
  await f.broker.observe('mission-1', OWNER)
  assert.equal(f.broker.reads.size, 1)
  f.broker.close()
  const restored = await NativeBroker.open(f.options)
  try {
    const before = restored.project('mission-1', OWNER)
    const ledger = await readFile(join(f.ledgerDir, 'ledger.json'), 'utf8')
    settle(); await nextTick()
    assert.equal(f.broker.reads.size, 0)
    assert.deepEqual(restored.project('mission-1', OWNER), before)
    assert.equal(await readFile(join(f.ledgerDir, 'ledger.json'), 'utf8'), ledger)
  } finally { restored.close() }
}, { timeoutMs: 20 }))

test('twenty valid 55k requests cannot make retained history unreadable; rejection and gap survive GET/restart', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  let retained, rejected = 0
  await serve(f, async call => {
    for (let i = 0; i < 20; i++) {
      const incoming = largeAttention(`capacity-${i}`)
      const before = f.broker.project('mission-1', OWNER)
      const beforeMeta = clone(f.broker.store.data.jobs['mission-1'].attentionMeta)
      f.transport.observations.set(binding.sessionId, observation(intent, binding, { pending: [incoming] }))
      const result = await call('/v1/native/jobs/mission-1?ownerId=owner-fixture')
      assert.equal(result.status, 200)
      assert.ok(wireBytes(result.body) <= NATIVE_RESPONSE_MAX_BYTES)
      if (result.body.holdReason === 'projection_capacity_exceeded') {
        rejected++
        assert.equal(result.body.completeness, 'gap')
        assert.equal(result.body.lastObservedAt, before.lastObservedAt)
        assert.deepEqual(result.body.attention, before.attention) // No partial native closure.
        assert.deepEqual(f.broker.store.data.jobs['mission-1'].attentionMeta, beforeMeta)
        assert.equal(result.body.attention.some(a => a.requestId === incoming.attention.requestId), false)
        assert.equal(f.broker.store.data.jobs['mission-1'].reconciledEpoch, 0)
        assert.deepEqual(f.broker.store.data.jobs['mission-1'].pendingRequestIds, [])
      }
      retained = result.body
    }
    assert.ok(rejected > 0)
    assert.ok(retained.attention.length < 20)
    assert.equal(retained.attention.at(-1).state, 'open')
    assert.equal(retained.attention.every(a => a.details === 'd'.repeat(55000)), true)
    const response = await call('/v1/native/jobs/mission-1/commands', makeCommand(retained, 'answer', {
      answer: makeAnswer(retained.attention.at(-1)),
    }))
    assert.equal(response.status, 409)
    assert.equal(response.body.error, 'fresh_observation_required')
    assert.equal(f.transport.calls.filter(row => row.method === 'answer').length, 0)
    const gaps = f.broker.readEvents(OWNER, 0, 200).filter(event => event.data.reason === 'projection_capacity_exceeded')
    assert.equal(gaps.length, 1) // Repeated overflow is a stable hold, not unbounded gap records.
    assert.equal(gaps[0].data.source, 'snapshot')
    assert.match(gaps[0].data.rejectedHash, /^[a-f0-9]{64}$/)
  })
  f.broker.close()
  const restored = await NativeBroker.open(f.options)
  try {
    const snapshot = restored.project('mission-1', OWNER)
    assert.equal(snapshot.completeness, 'gap')
    assert.equal(snapshot.holdReason, 'projection_capacity_exceeded')
    assert.deepEqual(snapshot.attention, retained.attention)
    await serve({ ...f, broker: restored }, async call => {
      for (let i = 0; i < 3; i++) {
        const result = await call('/v1/native/jobs/mission-1?ownerId=owner-fixture')
        assert.equal(result.status, 200)
        assert.equal(result.body.completeness, 'gap')
        assert.equal(result.body.holdReason, 'projection_capacity_exceeded')
        assert.ok(wireBytes(result.body) <= NATIVE_RESPONSE_MAX_BYTES)
        assert.deepEqual(result.body.attention, retained.attention)
      }
    })
  } finally { restored.close() }
}))

test('projection capacity preserves every admitted unresolved child and raw multibyte value', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  let rejected = 0
  for (let i = 0; i < 20; i++) {
    const sessionId = `capacity-child-${i}`
    const incoming = largeAttention(`child-rpc-${i}`, sessionId, '界'.repeat(18000))
    const before = f.broker.project('mission-1', OWNER)
    const beforeMeta = clone(f.broker.store.data.jobs['mission-1'].attentionMeta)
    const snapshot = ingest(f, intent, binding, {
      pending: [incoming], sessionIds: [binding.sessionId, sessionId], workerSessionIds: [sessionId],
    })
    assert.ok(wireBytes(snapshot) <= NATIVE_RESPONSE_MAX_BYTES)
    if (snapshot.holdReason === 'projection_capacity_exceeded') {
      rejected++
      assert.deepEqual(snapshot.attention, before.attention)
      assert.deepEqual(f.broker.store.data.jobs['mission-1'].attentionMeta, beforeMeta)
      assert.equal(snapshot.completeness, 'gap')
    }
    for (const a of snapshot.attention) {
      assert.equal(a.state, 'open')
      assert.equal(a.details, '界'.repeat(18000))
      assert.equal(a.machineId, MACHINE)
      assert.deepEqual(a.associatedSessionIds, [a.sessionId])
      assert.equal(hash(f.broker.store.data.jobs['mission-1'].attentionMeta[a.attentionId].raw), a.payloadHash)
    }
  }
  assert.ok(rejected > 0)
  const snapshot = f.broker.project('mission-1', OWNER)
  await rejects(() => f.broker.command(makeCommand(snapshot, 'answer', { answer: makeAnswer(snapshot.attention.at(-1)) })), 'fresh_observation_required')
}))

test('notification growth is also rejected atomically without clipping retained attention', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  for (let i = 0; i < 18; i++) ingest(f, intent, binding, { pending: [largeAttention(`notification-${i}`)] })
  const before = f.broker.project('mission-1', OWNER)
  const beforeMeta = clone(f.broker.store.data.jobs['mission-1'].attentionMeta)
  f.broker.ingestNotification('mission-1', OWNER, {
    machineId: MACHINE, sessionId: binding.sessionId, type: 'mission_features_changed',
    payload: { features: Array.from({ length: 12 }, (_, i) => ({
      id: `oversize-feature-${i}`, description: 'f'.repeat(8192), status: 'pending', expectedBehavior: [],
    })) },
  })
  const after = f.broker.project('mission-1', OWNER)
  assert.equal(after.holdReason, 'projection_capacity_exceeded')
  assert.equal(after.completeness, 'gap')
  assert.deepEqual(after.features, before.features)
  assert.deepEqual(after.attention, before.attention)
  assert.deepEqual(f.broker.store.data.jobs['mission-1'].attentionMeta, beforeMeta)
  assert.equal(after.lastObservedAt, before.lastObservedAt)
  assert.ok(wireBytes(after) <= NATIVE_RESPONSE_MAX_BYTES)
  await serve(f, async call => {
    const result = await call('/v1/native/jobs/mission-1?ownerId=owner-fixture')
    assert.equal(result.status, 200)
    // A failed provider read cannot erase the explicit projection-capacity hold.
    assert.equal(result.body.holdReason, 'projection_capacity_exceeded')
  })
}))

test('emergency projection reserve remains readable, permits other jobs, and recovers only on a fresh bounded read', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  let last
  for (let i = 0; i < 18; i++) {
    last = largeAttention(`reserve-${i}`)
    ingest(f, intent, binding, { pending: [last] })
  }
  const padded = f.broker.project('mission-1', OWNER)
  for (let i = 0; wireBytes(padded) < NATIVE_SNAPSHOT_ADMISSION_BYTES; i++) {
    const row = { id: `reserve-padding-${i}`, who: 'factory', text: '', at: '2026-10-12T00:00:00.000Z' }
    padded.history.push(row)
    row.text = 'h'.repeat(Math.min(32768, NATIVE_SNAPSHOT_ADMISSION_BYTES - wireBytes(padded)))
  }
  f.broker.store.transaction(data => { data.jobs['mission-1'].snapshot.history = clone(padded.history) })
  assert.equal(wireBytes(f.broker.project('mission-1', OWNER)), NATIVE_SNAPSHOT_ADMISSION_BYTES)
  f.broker.ingestNotification('mission-1', OWNER, {
    machineId: MACHINE, sessionId: binding.sessionId, type: 'mission_features_changed',
    payload: { features: [{ id: 'small-but-no-room', description: 'New feature', status: 'pending', expectedBehavior: [] }] },
  })
  const held = f.broker.project('mission-1', OWNER)
  assert.equal(held.holdReason, 'projection_capacity_exceeded')
  assert.equal(held.completeness, 'gap')
  assert.ok(wireBytes(held) > NATIVE_SNAPSHOT_ADMISSION_BYTES)
  assert.ok(wireBytes(held) <= NATIVE_RESPONSE_MAX_BYTES)
  assert.deepEqual(held.features, [])
  // A reserved-space hold is not a global inability to transact other jobs.
  await launched(f, makeIntent('separate-readable-job'))
  assert.deepEqual(f.broker.project('mission-1', OWNER), held)
  await rejects(() => f.broker.command(makeCommand(held, 'answer', { answer: makeAnswer(last.attention) })), 'fresh_observation_required')
  // No lost/overflowing request is replayed: this is an independent exact current read.
  const recovered = ingest(f, intent, binding, { pending: [last] })
  assert.equal(recovered.completeness, 'complete')
  assert.equal(recovered.holdReason, null)
  assert.ok(wireBytes(recovered) <= NATIVE_SNAPSHOT_ADMISSION_BYTES)
  assert.equal(f.transport.calls.filter(row => row.method === 'answer').length, 0)
}))

test('store-wide precommit projection guard refuses unreadable growth without changing disk', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  ingest(f, intent, binding)
  const before = clone(f.broker.store.data)
  const ledger = await readFile(join(f.ledgerDir, 'ledger.json'), 'utf8')
  assert.throws(() => f.broker.store.transaction(data => {
    data.jobs['mission-1'].snapshot.history.push(...Array.from({ length: 33 }, (_, i) => ({
      id: `too-large-history-${i}`, who: 'factory', text: 'h'.repeat(32768), at: '2026-10-12T00:00:00.000Z',
    })))
  }), error => error.code === 'projection_capacity_exceeded')
  assert.deepEqual(f.broker.store.data, before)
  assert.equal(await readFile(join(f.ledgerDir, 'ledger.json'), 'utf8'), ledger)
  assert.ok(wireBytes(f.broker.project('mission-1', OWNER)) <= NATIVE_RESPONSE_MAX_BYTES)
}))

function fakeHost(calls, overrides = {}) {
  const { publicKey } = generateKeyPairSync('ed25519')
  let prepared
  return {
    publicKey,
    workDirFor: () => makeIntent().workspace.cwd,
    async provision(intent) { prepared = clone(intent); calls.push(['provision', intent.missionId]) },
    async startDaemon({ missionId }) { calls.push(['startDaemon', missionId]) },
    async runContainmentProbes({ missionId }) { calls.push(['probe', missionId]) },
    async stopDaemon({ missionId }) { calls.push(['stopDaemon', missionId]) },
    renewLeases() {},
    deliveryInput(missionId) {
      return { missionId, workDir: makeIntent().workspace.cwd, repository: 'fixture/fixture-repo',
        baseRef: 'trunk', baseSha: 'a'.repeat(40), policy: { allowCreateRepository: false, allowPush: true, allowPr: true, allowMerge: true },
        ...(prepared ? { reviewedRepositoryIdentity: { repository: 'fixture/fixture-repo', repositoryId: 'R_fixture_reviewed',
          visibility: 'PRIVATE', baseSha: prepared.workspace.baseSha,
          scopeHash: hash(scopeOf(prepared)), policyHash: hash({ policy: prepared.policy, settings: prepared.settings }) } } : {}) }
    },
    ...overrides,
  }
}
function fakeDelivery(calls) {
  const state = (step, extra = {}) => ({
    step, branch: 'spriite/mission-1', headSha: 'b'.repeat(40), updatedAt: new Date().toISOString(),
    missionId: 'mission-1', workDir: makeIntent().workspace.cwd, repository: 'fixture/fixture-repo',
    baseRef: 'trunk', baseSha: 'a'.repeat(40), policy: { allowPush: true, allowPr: true, allowMerge: true },
    title: 't', body: 'b', ...extra,
  })
  return {
    async createPrivateRepository() { throw new Error('not used') },
    async deliver(input) {
      calls.push(['deliver', input])
      return state('checks_pending', { prUrl: 'https://github.com/fixture/fixture-repo/pull/7', prNumber: 7,
        checks: { total: 2, passed: 1, failed: 0, pending: 1 } })
    },
    async resume(previous) {
      calls.push(['resume', previous.step])
      return state('merged', { prUrl: previous.prUrl, prNumber: previous.prNumber, checks: { total: 2, passed: 2, failed: 0, pending: 0 } })
    },
  }
}
const deliverableIntent = () => makeIntent('mission-1', {
  restrictions: [],
  policy: { autonomy: 'high', allowCreateRepository: false, allowPush: true, allowPr: true, allowMerge: true, allowDeploy: false },
})

test('consequence flags hold without a host enforcer and delivery', () => withFixture(async f => {
  const snapshot = await f.broker.prepare(deliverableIntent())
  assert.equal(snapshot.holdReason, 'native_delivery_unavailable')
  assert.equal(f.transport.calls.length, 0)
}))

test('host path provisions and probes before preflight; host failure rejects without preflight', async () => {
  const calls = []
  await withFixture(async f => {
    const { intent } = await launched(f, deliverableIntent())
    assert.deepEqual(calls.map(row => row[0]), ['provision', 'startDaemon', 'probe'])
    assert.equal(f.transport.calls[0].method, 'preflight')
    assert.equal(intent.missionId, 'mission-1')
  }, { extra: { host: fakeHost(calls), delivery: fakeDelivery(calls) } })
  const failing = []
  await withFixture(async f => {
    const snapshot = await f.broker.prepare(deliverableIntent())
    assert.equal(snapshot.commands[0].state, 'rejected')
    assert.equal(snapshot.commands[0].reason, 'native_containment_probe_failed')
    assert.equal(f.transport.calls.length, 0)
    assert.deepEqual(failing.map(row => row[0]), ['provision', 'startDaemon', 'stopDaemon'])
  }, { extra: { host: fakeHost(failing, { async runContainmentProbes() { throw new BrokerError('native_containment_probe_failed', 503) } }), delivery: fakeDelivery(failing) } })
  await withFixture(async f => {
    const snapshot = await f.broker.prepare(makeIntent('mission-1', { ...deliverableIntent(),
      workspace: { ...makeIntent().workspace, cwd: '/not/the/host/job' } }))
    assert.equal(snapshot.holdReason, 'native_workspace_not_host_provisioned')
  }, { extra: { host: fakeHost([]), delivery: fakeDelivery([]) } })
  await withFixture(async f => {
    const snapshot = await f.broker.prepare(makeIntent('mission-1', { ...deliverableIntent(),
      destination: { kind: 'new_repository', account: 'fixture', name: 'fresh', visibility: 'private', initialization: 'empty' } }))
    // Without a verified host qualification record a new repository stays held.
    assert.equal(snapshot.holdReason, 'workspace_preparation_capability_unavailable')
  }, { extra: { host: fakeHost([]), delivery: fakeDelivery([]) } })
})

test('delivery runs only after completion and finalization, persists state, and resumes after restart', async () => {
  const calls = []
  const usage = { async query(input) { calls.push(['usage', input.sessionIds]); return { state: 'unavailable' } } }
  await withFixture(async f => {
    const { intent, binding } = await launched(f, deliverableIntent())
    ingest(f, intent, binding, { state: 'running' })
    await f.broker.observe(intent.missionId, OWNER); await f.broker.settleDeliveries()
    assert.equal(calls.some(row => row[0] === 'deliver'), false)
    let snapshot = ingest(f, intent, binding, { state: 'completed', workersSettled: false })
    assert.equal(snapshot.finalization.state, 'pending')
    f.broker.afterObservation(intent.missionId); await f.broker.settleDeliveries()
    assert.equal(calls.some(row => row[0] === 'deliver'), false)
    ingest(f, intent, binding, { state: 'completed', workersSettled: true, summary: 'Done.' })
    snapshot = await f.broker.observe(intent.missionId, OWNER)
    await f.broker.settleDeliveries()
    const order = calls.map(row => row[0]).filter(name => ['stopDaemon', 'deliver'].includes(name))
    assert.deepEqual(order, ['stopDaemon', 'deliver'])
    const deliverInput = calls.find(row => row[0] === 'deliver')[1]
    assert.deepEqual(Object.keys(deliverInput).sort(), ['baseRef', 'baseSha', 'body', 'missionId', 'policy', 'repository', 'repositoryIdentity', 'title', 'workDir'])
    assert.deepEqual(deliverInput.policy, { allowPush: true, allowPr: true, allowMerge: true })
    snapshot = f.broker.project(intent.missionId, OWNER)
    assert.equal(snapshot.delivery.step, 'checks_pending')
    assert.deepEqual(snapshot.delivery.checks, { total: 2, passed: 1, failed: 0, pending: 1 })
    assert.equal(snapshot.delivery.workDir, undefined) // Resume inputs are not projected.
    assert.deepEqual(snapshot.usage, { state: 'unavailable' })
    assert.equal(f.broker.store.data.jobs[intent.missionId].delivery.workDir, makeIntent().workspace.cwd)
    f.broker.close()
    const restored = await NativeBroker.open(f.options)
    try {
      restored.now = () => Date.now() + 30001 // Durable retry cooldown also survives restart.
      restored.resumeDeliveries(); await restored.settleDeliveries()
      assert.deepEqual(calls.filter(row => row[0] === 'resume'), [['resume', 'checks_pending']])
      const final = restored.project(intent.missionId, OWNER)
      assert.equal(final.delivery.step, 'merged')
      restored.resumeDeliveries(); await restored.settleDeliveries()
      assert.equal(calls.filter(row => row[0] === 'resume').length, 1) // Terminal states are not resumed.
    } finally { restored.close() }
  }, { extra: { host: fakeHost(calls), delivery: fakeDelivery(calls), usage } })
})

test('host revocation runs on every prepare failure, ambiguous launch and unconfirmed settings', async () => {
  for (const stage of ['preflight_throw', 'preflight_invalid', 'launch_throw', 'settings_unconfirmed']) {
    const calls = []
    const transport = fakeTransport()
    if (stage === 'preflight_throw') transport.preflight = async () => { throw new Error('fixture') }
    if (stage === 'preflight_invalid') transport.preflight = async () => ({ readiness: true })
    if (stage === 'launch_throw') transport.launch = async () => { throw new Error('fixture') }
    if (stage === 'settings_unconfirmed') {
      const launch = transport.launch.bind(transport)
      transport.launch = async (...args) => ({ ...await launch(...args), unconfirmedSettings: ['workerModel'] })
    }
    const host = fakeHost(calls, {
      async revoke(input) { calls.push(['revoke', input.reason]) },
      job: () => ({ created: true, repositoryUrl: 'https://github.com/fixture/retained' }),
    })
    await withFixture(async f => {
      const snapshot = await f.broker.prepare(deliverableIntent())
      assert.equal(calls.filter(row => row[0] === 'revoke').length, 1, stage)
      assert.equal(f.broker.store.data.jobs['mission-1'].hostShutdown, 'revoked')
      assert.equal(f.broker.store.data.jobs['mission-1'].hostFailure.repositoryUrl, 'https://github.com/fixture/retained')
      assert(snapshot.history.some(row => row.text.includes('Repository retained after failed preparation: https://github.com/fixture/retained')))
      assert.throws(() => f.broker.context(f.broker.store.data.jobs['mission-1']).guard(), error => error.code === 'execution_stopped')
    }, { transport, extra: { host, delivery: fakeDelivery(calls) } })
  }
})

test('completion without push (after its closing read settles) and persisted provider faults revoke the real broker host route', async () => {
  for (const terminal of [true, false]) {
    const calls = []
    const host = fakeHost(calls, { async revoke(input) { calls.push(['revoke', input.reason]) } })
    await withFixture(async f => {
      const { intent, binding } = await launched(f, makeIntent())
      if (terminal) {
        ingest(f, intent, binding, { state: 'completed', workersSettled: true })
        await f.broker.settleDeliveries()
        // The daemon stays up for the read-only closing collection...
        assert.equal(calls.filter(row => row[0] === 'revoke').length, 0, 'no revoke while finalization is pending')
        // ...and is revoked once that settles (here: its deadline/attempt limit).
        f.broker.finishIncomplete(intent.missionId)
      } else await f.broker.context(f.broker.store.data.jobs[intent.missionId]).providerJournal.write({ ingestionFault: 'sdk_connection_closed_handoff' })
      await f.broker.settleDeliveries()
      assert.equal(calls.filter(row => row[0] === 'revoke').length, 1)
      assert.equal(calls.some(row => row[0] === 'deliver'), false)
      assert.equal(f.broker.store.data.jobs[intent.missionId].hostShutdown, 'revoked')
    }, { extra: { host, delivery: fakeDelivery(calls) } })
  }
})

test('broker restart holds active host missions without daemon reconstruction or replay', async () => {
  const calls = []
  const host = fakeHost(calls, { async recoverAfterRestart() { return ['mission-1'] } })
  await withFixture(async f => {
    const { intent } = await launched(f)
    const sends = f.transport.calls.length
    f.broker.close()
    const restored = await NativeBroker.open(f.options)
    try {
      let snapshot = await restored.observe(intent.missionId, OWNER)
      assert.equal(snapshot.holdReason, 'Broker restarted; mission must be re-prepared')
      assert.equal(restored.store.data.jobs[intent.missionId].hostRecovery, true)
      snapshot = await restored.prepare(intent)
      assert.equal(snapshot.holdReason, 'Broker restarted; mission must be re-prepared')
      assert.equal(f.transport.calls.length, sends)
      assert.throws(() => restored.context(restored.store.data.jobs[intent.missionId]).guard(), error => error.code === 'execution_stopped')
    } finally { restored.close() }
  }, { extra: { host } })
})

test('transient held delivery resumes through actual delivery interface; final security holds never retry', async () => {
  for (const mode of ['transient', 'exception', 'security']) {
    const calls = [], runnerCalls = []
    let first = true, pushed = false
    const actual = createNativeDelivery({
      now: () => new Date().toISOString(), sleep: async () => {},
      verifyPushSafety: () => true,
      prepareGitCheckout,
      gh: async args => { assert.equal(args[0], 'repo'); return reviewedRepoResult },
      git: async args => {
        runnerCalls.push(args)
        if (args.includes('status') && first && mode === 'transient') { first = false; return { status: null, stdout: '', stderr: '' } }
        if (args.includes('rev-parse')) return { status: 0, stdout: `${'b'.repeat(40)}\n` }
        if (args.includes('rev-list')) return { status: 0, stdout: `${'b'.repeat(40)}\n` }
        if (args.includes('cat-file')) return { status: 0, stdout: args.includes('-t') ? 'blob\n' : 'safe\n' }
        if (args.includes('diff') && mode === 'security') return { status: 0, stdout: '+++ b/leak.env\n+Bearer fixtureCredential01234567890\n' }
        if (args.includes('ls-remote')) return { status: 0, stdout: pushed ? `${'b'.repeat(40)}\trefs/heads/spriite/mission-1\n` : '' }
        if (args.includes('push')) pushed = true
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    let initialCalls = 0, resumeCalls = 0
    const delivery = {
      async deliver(input, context) {
        initialCalls++
        if (mode === 'exception' && initialCalls === 1) throw new Error('Unexpected transient runner failure')
        return actual.deliver(input, context)
      },
      async resume(state, context) { resumeCalls++; return actual.resume(state, context) },
    }
    await withFixture(async f => {
      const intent = deliverableIntent(); intent.policy.allowPr = false; intent.policy.allowMerge = false
      const { binding } = await launched(f, intent)
      ingest(f, intent, binding, { state: 'completed', workersSettled: true, summary: 'Done.' })
      f.broker.afterObservation(intent.missionId); await f.broker.settleDeliveries()
      const persisted = f.broker.store.data.jobs[intent.missionId].delivery
      assert.equal(persisted.step, 'held')
      assert.equal(persisted.repository, 'fixture/fixture-repo')
      assert.equal(persisted.missionId, intent.missionId)
      assert.equal(f.broker.store.data.jobs[intent.missionId].deliveryAttempts, 1)
      assert.equal(deliveryIsTerminal(persisted), mode === 'security')
      assert.equal(f.broker.deliveryDue(f.broker.store.data.jobs[intent.missionId]), false) // Cooldown.
      f.broker.close()
      const restored = await NativeBroker.open(f.options)
      try {
        restored.now = () => Date.now() + 30001
        restored.resumeDeliveries(); await restored.settleDeliveries()
        if (mode === 'security') {
          assert.equal(resumeCalls, 0); assert.equal(runnerCalls.some(args => args.includes('push')), false)
        } else {
          assert.equal(resumeCalls, 1)
          assert.equal(restored.project(intent.missionId, OWNER).delivery.step, 'pushed')
          assert.equal(restored.deliveryDue(restored.store.data.jobs[intent.missionId]), false)
        }
      } finally { restored.close() }
    }, { extra: { host: fakeHost(calls), delivery } })
  }
})

test('delivery retries have a durable eight-attempt limit and keep complete resume input', async () => {
  const calls = []
  const delivery = {
    async deliver() { throw new Error('temporary failure') },
    async resume() { throw new Error('temporary failure') },
  }
  await withFixture(async f => {
    const { intent, binding } = await launched(f, deliverableIntent())
    ingest(f, intent, binding, { state: 'completed', workersSettled: true, summary: 'Done.' })
    let clock = Date.now(); f.broker.now = () => clock
    for (let i = 0; i < 12; i++) {
      clock += 30001
      await f.broker.runDelivery(intent.missionId)
    }
    const job = f.broker.store.data.jobs[intent.missionId]
    assert.equal(job.deliveryAttempts, 8)
    assert.equal(job.deliveryRetryExhausted, true)
    assert.equal(job.delivery.reason, 'Delivery retry limit reached; owner recovery required')
    assert.equal(job.delivery.workDir, intent.workspace.cwd)
    assert.equal(f.broker.deliveryDue(job), false)
  }, { extra: { host: fakeHost(calls), delivery } })
})

test('broker transaction crash matrix durably fences dispatch and reconciles exact pushed head after restart', async () => {
  for (const phase of ['pre-save', 'before-effect', 'after-effect', 'after-receipt']) {
    const calls = [], remoteCalls = []
    let remote = false
    const actual = createNativeDelivery({
      now: () => new Date().toISOString(), sleep: () => {}, verifyPushSafety: () => true,
      prepareGitCheckout,
      gh: async args => { assert.equal(args[0], 'repo'); return reviewedRepoResult },
      git: async args => {
        remoteCalls.push(args)
        if (args.includes('rev-parse') || args.includes('rev-list')) return { status: 0, stdout: `${'b'.repeat(40)}\n` }
        if (args.includes('cat-file')) return { status: 0, stdout: args.includes('-t') ? 'blob\n' : 'safe content\n' }
        if (args.includes('ls-remote')) return { status: 0, stdout: remote ? `${'b'.repeat(40)}\trefs/heads/spriite/mission-1\n` : '' }
        if (args.includes('push')) remote = true
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    await withFixture(async f => {
      const intent = deliverableIntent(); intent.policy.allowPr = false; intent.policy.allowMerge = false
      const { binding } = await launched(f, intent)
      const factory = f.broker.deliveryContext.bind(f.broker)
      let triggered = false
      f.broker.deliveryContext = missionId => {
        const context = factory(missionId), save = context.journal.save
        return { journal: { ...context.journal, save(row, checkpoint) {
          const hit = !triggered && (['pre-save', 'before-effect'].includes(phase) ? row.state === 'intent' : row.state === 'confirmed')
          if (hit) triggered = true
          if (hit && ['pre-save', 'after-effect'].includes(phase)) throw new Error('crash before durable write')
          save(row, checkpoint)
          if (hit) throw new Error('crash after durable write')
        } } }
      }
      ingest(f, intent, binding, { state: 'completed', workersSettled: true, summary: 'Done.' })
      f.broker.afterObservation(intent.missionId); await f.broker.settleDeliveries()
      assert.equal(remoteCalls.filter(args => args.includes('push')).length, ['after-effect', 'after-receipt'].includes(phase) ? 1 : 0)
      const disk = JSON.parse(await readFile(join(f.ledgerDir, 'ledger.json'), 'utf8')).data
      const effects = Object.values(disk.jobs[intent.missionId].deliveryEffects ?? {})
      assert.equal(effects.length, phase === 'pre-save' ? 0 : 1)
      if (effects.length) {
        assert.equal(effects[0].state, phase === 'after-receipt' ? 'confirmed' : 'intent')
        assert.equal(disk.jobs[intent.missionId].delivery.headSha, 'b'.repeat(40))
      }
      f.broker.close()
      const restored = await NativeBroker.open(f.options)
      try {
        restored.now = () => Date.now() + 30001
        remoteCalls.length = 0
        restored.resumeDeliveries(); await restored.settleDeliveries()
        assert.equal(remoteCalls.filter(args => args.includes('push')).length, phase === 'pre-save' ? 1 : 0)
        assert.equal(restored.project(intent.missionId, OWNER).delivery.step, phase === 'before-effect' ? 'held' : 'pushed')
        assert.ok(!JSON.stringify(restored.project(intent.missionId, OWNER)).includes('effectId'))
        assert.ok(restored.store.data.events.filter(event => event.kind === 'delivery_effect').every(event =>
          Object.keys(event.data).sort().join(',') === 'effectId,kind,state'))
      } finally { restored.close() }
    }, { extra: { host: fakeHost(calls), delivery: actual } })
  }
})

test('delivery journal rejects changed scope, head identity, policy and stale writer capabilities', () => withFixture(async f => {
  const intent = deliverableIntent()
  await launched(f, intent)
  const context = f.broker.deliveryContext(intent.missionId)
  f.broker.store.transaction(data => { data.jobs[intent.missionId].deliveryInput = {
    missionId: intent.missionId, workDir: intent.workspace.cwd, repository: 'fixture/fixture-repo', baseRef: 'trunk',
    baseSha: intent.workspace.baseSha, policy: { allowPush: true, allowPr: true, allowMerge: true }, title: 't', body: 'b',
    repositoryIdentity: { repositoryId: 'R_fixture_reviewed', visibility: 'PRIVATE' },
  } })
  const identity = { ...context.journal.identity, kind: 'branch_push', repository: 'fixture/fixture-repo',
    headSha: 'b'.repeat(40), branch: 'spriite/mission-1',
    repositoryId: 'R_fixture_reviewed', visibility: 'PRIVATE',
    policy: { allowPush: true, allowPr: true, allowMerge: true } }
  const row = { effectId: hash(identity), identity, state: 'intent', updatedAt: new Date().toISOString() }
  context.journal.save(row)
  for (const change of [{ headSha: 'c'.repeat(40) }, { repository: 'foreign/project' }, { policyHash: 'f'.repeat(64) },
    { policy: { allowPush: true, allowPr: false, allowMerge: false } }]) {
    const altered = { ...identity, ...change }
    assert.throws(() => context.journal.save({ ...row, identity: altered, effectId: hash(altered) }), BrokerError)
  }
  const receipt = { ...row, state: 'confirmed', receipt: { headSha: identity.headSha } }
  context.journal.save(receipt)
  assert.throws(() => context.journal.save(row), BrokerError)
  f.broker.close()
  assert.throws(() => context.journal.save(receipt), error => error.code === 'writer_fenced')
}, { extra: { host: fakeHost([]), delivery: fakeDelivery([]) } }))

async function initializationFixture(mode, fn) {
  const calls = [], remoteCalls = []
  let repo = mode === 'adopted' ? { id: 'R_adopted', visibility: 'PRIVATE', isEmpty: true } : null
  let remote = null, f
  const host = fakeHost(calls, {
    async provision(intent) {
      calls.push(['provision', intent.missionId])
      if (mode === 'held-after-provision') f.broker.store.transaction(data => {
        data.jobs[intent.missionId].snapshot.holdReason = 'Offline fixture hold'
      })
    },
    job: () => ({ created: false, repositoryUrl: 'https://github.com/fixture/fresh' }),
    privateRepositoryInitializationInput(missionId) {
      calls.push(['initializationInput', missionId])
      const intent = f.broker.store.data.jobs[missionId].intent
      if (!intent.policy.allowCreateRepository || !intent.policy.allowPush) throw new BrokerError('native_private_repository_initialization_not_approved', 409)
      return { missionId, workDir: intent.workspace.cwd, repository: 'fixture/fresh',
        repositoryUrl: 'https://github.com/fixture/fresh', account: 'fixture', name: 'fresh',
        baseRef: intent.workspace.baseRef, baseSha: intent.workspace.baseSha,
        seedSha: mode === 'wrong-sha' ? 'f'.repeat(40) : intent.workspace.baseSha,
        visibility: 'private', initialization: 'empty', requiresCreatedRepository: true, adoptionAllowed: false,
        policy: { ...intent.policy } }
    },
    async startDaemon({ missionId }) {
      const effects = Object.values(f.broker.store.data.jobs[missionId].deliveryEffects ?? {})
      assert.deepEqual(effects.map(row => [row.identity.kind, row.state]), [['create_repository', 'confirmed'], ['initial_seed_push', 'confirmed']])
      calls.push(['startDaemon', missionId])
    },
  })
  const keys = generateKeyPairSync('ed25519'), deploymentDigest = 'd'.repeat(64), at = Date.now()
  const manifest = { version: 1, kind: 'host_qualification', qualificationId: 'OFFLINE-initialization-fixture',
    machineId: MACHINE, deploymentDigest, hostPublicKeySha256: publicKeySha256(host.publicKey), droidVersion: 'offline-fixture',
    issuedAt: new Date(at - 1000).toISOString(), expiresAt: new Date(at + 3600000).toISOString(),
    checks: HOST_QUALIFICATION_CHECKS.map(name => ({ name, passed: true, evidenceSha256: 'e'.repeat(64), verifiedAt: new Date(at).toISOString() })) }
  const hostQualification = verifyHostQualification({ manifest, signature: sign(null, Buffer.from(canonical(manifest)), keys.privateKey).toString('base64') },
    { publicKey: keys.publicKey, deploymentDigest, hostPublicKey: host.publicKey, machineId: MACHINE, now: at })
  const revokeConsent = () => f.broker.store.transaction(data => {
    data.jobs['mission-1'].intent.scopeApproved = false
    data.jobs['mission-1'].intentHash = hash(data.jobs['mission-1'].intent)
  })
  const delivery = createNativeDelivery({ now: () => new Date().toISOString(), sleep: () => {}, verifyPushSafety: () => true, prepareGitCheckout,
    gh: async args => {
      remoteCalls.push(args)
      if (args[1] === 'view') {
        if (!repo && mode === 'consent-before-create') revokeConsent()
        return repo ? { status: 0, stdout: JSON.stringify(repo), stderr: '' }
          : { status: 1, stdout: '', stderr: 'Could not resolve to a Repository' }
      }
      if (args[1] === 'create') {
        repo = { id: 'R_created_exact', visibility: 'PRIVATE', isEmpty: true }
        if (mode === 'consent-after-create') revokeConsent()
        if (mode === 'qualification-after-create') f.broker.hostQualification = null
        return { status: 0, stdout: '', stderr: '' }
      }
      throw new Error('No PR operation allowed during initialization')
    },
    git: async args => {
      remoteCalls.push(args)
      if (args.includes('rev-list')) {
        if (mode === 'consent-before-seed') revokeConsent()
        return { status: 0, stdout: `${'a'.repeat(40)}\n` }
      }
      if (args.includes('cat-file')) return { status: 0, stdout: args.includes('-t') ? 'blob\n' : 'safe seed\n' }
      if (args.includes('ls-remote')) return { status: 0, stdout: remote ? `${remote}\trefs/heads/main\n` : '' }
      if (args.includes('push')) { remote = 'a'.repeat(40); repo.isEmpty = false; return { status: 0, stdout: '', stderr: '' } }
      throw new Error('Unexpected local initialization read')
    } })
  await withFixture(async value => {
    f = value
    const intent = makeIntent('mission-1', {
      restrictions: [], destination: { kind: 'new_repository', account: 'fixture', name: 'fresh', visibility: 'private', initialization: 'empty' },
      workspace: { ...makeIntent().workspace, repository: 'fixture/fresh', baseRef: 'refs/heads/main' },
      policy: { autonomy: 'high', allowCreateRepository: true, allowPush: true, allowPr: false, allowMerge: false, allowDeploy: false },
    })
    if (mode === 'no-consent') intent.scopeApproved = false
    if (mode === 'no-create') intent.policy.allowCreateRepository = false
    if (mode === 'no-push') intent.policy.allowPush = false
    const match = /^(create_repository|initial_seed_push):(pre-save|before-effect|after-effect|after-receipt)$/.exec(mode)
    if (match) {
      const factory = f.broker.deliveryContext.bind(f.broker)
      let triggered = false
      f.broker.deliveryContext = missionId => {
        const context = factory(missionId)
        return { journal: { ...context.journal, save(row, checkpoint) {
          const hit = !triggered && row.identity.kind === match[1] &&
            (['pre-save', 'before-effect'].includes(match[2]) ? row.state === 'intent' : row.state === 'confirmed')
          if (hit) triggered = true
          if (hit && ['pre-save', 'after-effect'].includes(match[2])) throw new Error('Offline crash before durable save')
          context.journal.save(row, checkpoint)
          if (hit) throw new Error('Offline crash after durable save')
        } } }
      }
    }
    await fn({ f, intent, calls, remoteCalls, get repo() { return repo }, get remote() { return remote } })
  }, { extra: { host, delivery, deploymentDigest, hostQualification: mode === 'unqualified' ? null : hostQualification } })
}

test('new repository prepare uses local host contract and actual durable create/seed runners before daemon startup', async () => {
  await initializationFixture('happy', async ({ f, intent, calls, remoteCalls }) => {
    const snapshot = await f.broker.prepare(intent)
    assert.equal(snapshot.commands[0].state, 'confirmed')
    assert.deepEqual(calls.map(row => row[0]), ['provision', 'initializationInput', 'startDaemon', 'probe'])
    assert.equal(remoteCalls.filter(args => args[1] === 'create').length, 1)
    assert.equal(remoteCalls.filter(args => args.includes('push')).length, 1)
    const effects = Object.values(f.broker.store.data.jobs[intent.missionId].deliveryEffects)
    assert.equal(effects[0].receipt.repositoryId, 'R_created_exact')
    assert.equal(effects[1].receipt.headSha, intent.workspace.baseSha)
    assert.ok(!JSON.stringify(snapshot).includes('effectId'))
  })
})

for (const mode of ['adopted', 'wrong-sha', 'no-consent', 'no-create', 'no-push', 'unqualified',
  'consent-before-create', 'consent-after-create', 'consent-before-seed', 'qualification-after-create', 'held-after-provision']) {
  test(`new repository initialization negative ${mode} has no unapproved seed or daemon`, async () => {
    await initializationFixture(mode, async ({ f, intent, calls, remoteCalls }) => {
      const snapshot = await f.broker.prepare(intent)
      assert.notEqual(snapshot.commands[0].state, 'confirmed')
      assert.equal(remoteCalls.some(args => args.includes('push')), false)
      assert.equal(calls.some(row => row[0] === 'startDaemon'), false)
      if (!['consent-after-create', 'consent-before-seed', 'qualification-after-create'].includes(mode))
        assert.equal(remoteCalls.some(args => args[1] === 'create'), false)
      else {
        assert.equal(f.broker.store.data.jobs[intent.missionId].hostFailure.created, true)
        assert(snapshot.history.some(row => row.text.includes('https://github.com/fixture/fresh')))
      }
    })
  })
}

for (const kind of ['create_repository', 'initial_seed_push']) for (const phase of ['pre-save', 'before-effect', 'after-effect', 'after-receipt']) {
  test(`broker initialization crash ${kind} ${phase} holds and restart never replays`, async () => {
    await initializationFixture(`${kind}:${phase}`, async ({ f, intent, calls, remoteCalls }) => {
      const snapshot = await f.broker.prepare(intent)
      assert.notEqual(snapshot.commands[0].state, 'confirmed')
      assert.equal(calls.some(row => row[0] === 'startDaemon'), false)
      const effects = Object.values(f.broker.store.data.jobs[intent.missionId].deliveryEffects ?? {})
      const row = effects.find(value => value.identity.kind === kind)
      assert.equal(row?.state, phase === 'pre-save' ? undefined : phase === 'after-receipt' ? 'confirmed' : 'intent')
      if (kind === 'initial_seed_push' || phase === 'after-receipt')
        assert.equal(f.broker.store.data.jobs[intent.missionId].hostFailure.created, true)
      const count = remoteCalls.length
      f.broker.close()
      const restored = await NativeBroker.open(f.options)
      try {
        const again = await restored.prepare(intent)
        assert.notEqual(again.commands[0].state, 'confirmed')
        assert.equal(remoteCalls.length, count)
        assert.equal(calls.some(row => row[0] === 'startDaemon'), false)
      } finally { restored.close() }
    })
  })
}

test('fine-grained credential patterns in intent, provider summary and history never persist or project', () => withFixture(async f => {
  const dummy = `github_pat_${'Q'.repeat(70)}`
  await rejects(() => f.broker.prepare(makeIntent('fine-grained-token', { goal: dummy })), 'secret_material_refused')
  assert.equal(Object.keys(f.broker.store.data.jobs).length, 0)
  const { intent, binding } = await launched(f)
  for (const extra of [
    { summary: dummy, state: 'completed', workersSettled: true },
    { history: [{ id: 'credential-fixture', who: 'factory', text: dummy, at: new Date().toISOString() }] },
  ]) assert.throws(() => ingest(f, intent, binding, extra), error => error.code === 'secret_material_refused')
  await rejects(() => f.broker.context(f.broker.store.data.jobs[intent.missionId]).providerJournal.write({ summary: dummy }), 'secret_material_refused')
  assert.ok(!JSON.stringify(f.broker.project(intent.missionId, OWNER)).includes(dummy))
  assert.ok(!(await readFile(join(f.ledgerDir, 'ledger.json'), 'utf8')).includes(dummy))
}))

test('existing delivery without scoped reviewed repository identity stays held without dispatch', async () => {
  for (const mode of ['missing', 'wrong-scope']) {
    const calls = [], host = fakeHost(calls, { deliveryInput(missionId) {
      return { missionId, workDir: makeIntent().workspace.cwd, repository: 'fixture/fixture-repo',
        baseRef: 'trunk', baseSha: 'a'.repeat(40),
        ...(mode === 'wrong-scope' ? { reviewedRepositoryIdentity: { repository: 'fixture/fixture-repo',
          repositoryId: 'R_unreviewed', visibility: 'PRIVATE', baseSha: 'a'.repeat(40),
          scopeHash: 'f'.repeat(64), policyHash: 'f'.repeat(64) } } : {}) }
    } })
    await withFixture(async f => {
      const { intent, binding } = await launched(f, deliverableIntent())
      ingest(f, intent, binding, { state: 'completed', workersSettled: true, summary: 'Done.' })
      f.broker.afterObservation(intent.missionId); await f.broker.settleDeliveries()
      const state = f.broker.project(intent.missionId, OWNER).delivery
      assert.equal(state.step, 'held')
      assert.equal(state.reason, 'native_delivery_reviewed_repository_identity_required')
      assert.equal(calls.some(row => row[0] === 'deliver'), false)
    }, { extra: { host, delivery: fakeDelivery(calls) } })
  }
})

test('event feed is a bounded window: compaction keeps seq monotonic, writes and restart working', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  const store = f.broker.store
  // Fill past the window in one transaction (an ~11h single-mission observation loop).
  store.transaction(data => {
    for (let i = 0; i < EVENT_WINDOW + 100; i++) store.event(data, data.jobs[intent.missionId], 'fixture_fill')
  })
  const seq = store.data.seq
  assert.ok(seq > EVENT_WINDOW)
  assert.ok(store.data.events.length <= EVENT_WINDOW)
  assert.equal(store.data.events.at(-1).seq, seq)
  const snapshot = ingest(f, intent, binding, { state: 'running' }) // Not event_capacity_exceeded.
  assert.equal(snapshot.state, 'running')
  assert.equal(snapshot.brokerSeq, seq + 1)
  const [oldest] = f.broker.readEvents(OWNER, 0, 1)
  assert.equal(oldest.seq, store.data.seq - store.data.events.length + 1)
  assert.ok(oldest.seq > 1)
  // Only a contiguous window ending at seq is valid; a hole is still corruption.
  const holed = clone(store.data); holed.events.splice(10, 1)
  assert.throws(() => validateLedger(holed, OWNER), error => error.code === 'store_corrupt')
  const ahead = clone(store.data); ahead.seq++
  assert.throws(() => validateLedger(ahead, OWNER), error => error.code === 'store_corrupt')
  f.broker.close()
  const restored = await NativeBroker.open(f.options)
  try { assert.equal(restored.store.data.seq, seq + 1) } finally { restored.close() }
}))

test('resolved attention retires at capacity; retired requests still cannot reappear or be reused', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  const batch = (round, n = 64) => Array.from({ length: n }, (_, i) => makeAttention({ requestId: `rpc-r${round}-${i}` }))
  for (let round = 0; round < 4; round++) {
    ingest(f, intent, binding, { pending: batch(round) })
    ingest(f, intent, binding, { pending: [] }) // Authoritative disappearance resolves them.
  }
  let snapshot = f.broker.project(intent.missionId, OWNER)
  assert.equal(snapshot.attention.length, 256)
  assert.ok(snapshot.attention.every(a => a.state === 'resolved'))
  const fresh = makeAttention({ requestId: 'rpc-after-capacity' })
  snapshot = ingest(f, intent, binding, { pending: [fresh] }) // Was attention_capacity_exceeded -> permanent gap.
  assert.equal(snapshot.completeness, 'complete')
  assert.equal(snapshot.attention.length, 256)
  assert.equal(snapshot.attention.find(a => a.attentionId === fresh.attention.attentionId).state, 'open')
  assert.equal(snapshot.attention.some(a => a.requestId === 'rpc-r0-0'), false) // Oldest resolved retired.
  const job = f.broker.store.data.jobs[intent.missionId]
  assert.equal(Object.keys(job.attentionMeta).length, 256)
  assert.equal(job.retiredAttention.length, 2)
  assert.ok(f.broker.readEvents(OWNER, f.broker.store.data.seq - 5, 10).some(e => e.kind === 'attention_retired'))
  assert.throws(() => ingest(f, intent, binding, { pending: [fresh, makeAttention({ requestId: 'rpc-r0-0' })] }),
    error => error.code === 'resolved_request_reappeared')
  const reused = makeAttention({ requestId: 'rpc-reuse' }); reused.attention.attentionId = 'attention-rpc-r0-0'
  assert.throws(() => ingest(f, intent, binding, { pending: [fresh, reused] }), error => error.code === 'attention_identity_reused')
  f.broker.close()
  const restored = await NativeBroker.open(f.options) // Retirement state passes the store validator.
  restored.close()
}))

test('attention capacity still refuses when every slot is live', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  const live = Array.from({ length: 256 }, (_, i) => makeAttention({ requestId: `rpc-live-${i}` }))
  ingest(f, intent, binding, { pending: live })
  assert.throws(() => ingest(f, intent, binding, { pending: [...live.slice(1), makeAttention({ requestId: 'rpc-extra' })] }),
    error => error.code === 'attention_capacity_exceeded')
}))

test('retained history is a bounded sliding projection that keeps the goal and never bricks ingest', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  const base = Date.now()
  for (let round = 0; round < 5; round++) { // 640 distinct provider rows, more than the 512 store cap.
    const history = Array.from({ length: 128 }, (_, i) => ({
      id: `history-${round}-${i}`, who: 'factory', text: `row ${round}/${i}`, at: new Date(base + (round * 128 + i) * 1000).toISOString(),
    }))
    const snapshot = ingest(f, intent, binding, { history })
    assert.equal(snapshot.completeness, 'complete')
  }
  const snapshot = f.broker.project(intent.missionId, OWNER)
  assert.equal(snapshot.history.length, 384)
  assert.equal(snapshot.history[0].id, intent.commandId) // The owner's goal survives compaction.
  assert.equal(snapshot.history.at(-1).id, 'history-4-127')
  assert.equal(snapshot.history.some(h => h.id === 'history-0-0'), false)
}))

test('observation loop contains synchronous host and post-observation faults', () => withFixture(async f => {
  const { intent, binding } = await launched(f)
  f.transport.observations.set(binding.sessionId, observation(intent, binding, { state: 'running' }))
  let renewals = 0, after = 0
  f.broker.host = { renewLeases() { renewals++; throw new Error('corrupt job file') } }
  f.broker.afterObservation = () => { after++; throw new Error('projection fault') }
  const unhandled = []
  const capture = error => unhandled.push(error)
  process.on('unhandledRejection', capture)
  try {
    f.broker.startObservationLoop({ intervalMs: 20 })
    for (let i = 0; i < 200 && renewals < 3; i++) await new Promise(resolve => setTimeout(resolve, 5))
    await new Promise(resolve => setTimeout(resolve, 10))
  } finally { clearInterval(f.broker.observationTimer); f.broker.host = undefined; process.off('unhandledRejection', capture) }
  assert.deepEqual(unhandled, [])
  assert.ok(renewals >= 3) // The loop keeps ticking after each fault.
  assert.ok(after >= 3) // A renewal fault does not skip post-observation work.
}))

for (const { name, fn } of tests) {
  try { await fn(); passed++; process.stdout.write(`ok ${passed} - ${name}\n`) }
  catch (error) {
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`)
    process.exitCode = 1
    break
  }
}
process.stdout.write(`Native broker: ${passed}/${tests.length} offline checks passed; no SDK import or live Mission.\n`)
