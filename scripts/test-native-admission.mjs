import assert from 'node:assert/strict'
import { NativeAdmissionCoordinator } from '../src/native/admission.ts'
import { HttpNativeBrokerClient, NativeBrokerError } from '../src/native/client.ts'
import { canonicalNativeJson, nativeFingerprint } from '../src/native/fingerprint.ts'
import { NativeBroker } from '../broker/broker.mjs'
import { startBrokerServer } from '../broker/server.mjs'
import { createNativeProviderBrokerBridge } from '../broker/provider-bridge.mjs'
import { SDK_TRANSPORT_VERSION, decodeSdkEnvelope } from '../broker/sdk-wire.mjs'
import { ownedRootSessionId, createInjectedNativeProvider } from '../broker/sdk-provider.mjs'
import { fixture as hostFixture } from './test-native-host.mjs'
import { createHostRoutedTransport, NATIVE_NEW_REPOSITORY_BASE } from '../broker/native-host.mjs'
import { createHostAdmissionClient, createHostLoopbackSocket } from '../broker/host-production.mjs'
import { compileNativePolicy } from '../broker/native-policy.mjs'
import { validateWorkspaceProof } from '../broker/native-workspace.mjs'
import { validateEnforcementLease } from '../broker/native-boundary.mjs'
import { join } from 'node:path'
import { hash, clone } from '../broker/validation.mjs'
import { fixture, fakeTransport, makeIntent, observation, makeAttention, OWNER, MACHINE, TOKEN } from '../broker/fixtures/offline.mjs'

let checks = 0
const test = async (name, fn) => { await fn(); console.log(`PASS ${++checks}: ${name}`) }
const draftOf = (intent = makeIntent()) => {
  const { scopeApproved: _, highAutonomyApproved: __, ...draft } = intent
  return draft
}
const previewOf = draft => ({
  protocolVersion: 1, missionId: draft.missionId, ownerId: draft.ownerId, draftHash: hash(draft),
  workspace: { ...draft.workspace, baseSha: draft.workspace.baseSha ?? 'a'.repeat(40) },
  prospectiveSettings: draft.settings, observedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 30000).toISOString(), launchEligible: true, holds: [],
})
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const inspectTransport = () => fakeTransport({
  async inspectAdmission(draft, context) {
    assert.equal(context.readOnly, true); assert.equal(context.machineId, MACHINE)
    return previewOf(draft)
  },
})
await test('broker inspection is pre-consent, owner-scoped and leaves ledger/provider execution untouched', async () => {
  const f = await fixture({ transport: inspectTransport() })
  try {
    const draft = draftOf()
    const seq = f.broker.store.data.seq
    const p = await f.broker.inspectAdmission(draft)
    assert.equal(p.launchEligible, true)
    assert.equal(Object.keys(f.broker.store.data.jobs).length, 0)
    assert.equal(f.broker.store.data.seq, seq); assert.equal(f.transport.calls.length, 0)
    await assert.rejects(() => f.broker.inspectAdmission({ ...draft, scopeApproved: false }), e => e.code === 'admission_consent_fields_refused')
    await assert.rejects(() => f.broker.inspectAdmission({ ...draft, ownerId: 'other' }), e => e.code === 'owner_forbidden')
    await assert.rejects(() => f.broker.inspectAdmission({ ...draft, workspace: { ...draft.workspace, baseSha: 'a'.repeat(41) } }), e => e.code === 'invalid_base_sha')
  } finally { await f.cleanup() }
})
await test('inspection retains honest holds and rejects changed SHA/settings/hash/expiry without preparing', async () => {
  for (const change of [
    { draftHash: 'b'.repeat(64) }, { prospectiveSettings: { modelId: 'other' } },
    { workspace: { ...makeIntent().workspace, baseSha: 'b'.repeat(40) } },
    { expiresAt: new Date(Date.now() - 60000).toISOString() },
  ]) {
    const transport = inspectTransport()
    transport.inspectAdmission = async draft => ({ ...previewOf(draft), ...change })
    const f = await fixture({ transport })
    try {
      await assert.rejects(() => f.broker.inspectAdmission(draftOf()))
      assert.equal(Object.keys(f.broker.store.data.jobs).length, 0)
    } finally { await f.cleanup() }
  }
  const f = await fixture({ qualified: false, transport: inspectTransport() })
  try {
    const p = await f.broker.inspectAdmission(draftOf())
    assert.equal(p.launchEligible, false); assert(p.holds.includes('native_launch_unqualified'))
  } finally { await f.cleanup() }
})
await test('HTTP client verifies the actual read-only response and never treats inspection failure as execution unknown', async () => {
  const draft = draftOf()
  const client = new HttpNativeBrokerClient({
    brokerUrl: 'https://broker.fixture.invalid', credential: () => 'synthetic-test-only',
    fetch: async (url, options) => {
      assert(url.endsWith('/v1/native/admission'))
      assert.equal(options.method, 'POST')
      const body = JSON.parse(options.body)
      assert.equal('scopeApproved' in body, false)
      return new Response(JSON.stringify(previewOf(body)), { status: 200 })
    },
  })
  assert.equal((await client.inspectAdmission(draft)).draftHash, hash(draft))
  for (const bad of ['expiry', 'settings', '500', 'malformed', 'network']) {
    const c = new HttpNativeBrokerClient({
      brokerUrl: 'https://broker.fixture.invalid', credential: () => 'synthetic-test-only',
      fetch: async () => {
        if (bad === 'network') throw new Error('safe synthetic failure')
        if (bad === '500') return new Response('{}', { status: 503 })
        const p = previewOf(draft)
        if (bad === 'expiry') p.expiresAt = new Date(Date.now() - 100000).toISOString()
        if (bad === 'settings') p.prospectiveSettings.modelId = 'substituted'
        return new Response(JSON.stringify(bad === 'malformed' ? {} : p), { status: 200 })
      },
    })
    await assert.rejects(() => c.inspectAdmission(draft), e => e instanceof NativeBrokerError && e.outcome === 'rejected')
  }
})
function coordinator(clientOverride) {
  const intent = makeIntent()
  let profile = { brokerUrl: 'https://broker.fixture.invalid', ownerId: OWNER,
    machineId: MACHINE, cwd: intent.workspace.cwd, baseRef: intent.workspace.baseRef }
  let credential = 'synthetic-credential'
  let count = 0
  const { missionId: _, commandId: __, ...draft } = draftOf(intent)
  const request = { ...clone(draft), brokerUrl: profile.brokerUrl }
  const c = new NativeAdmissionCoordinator({
    profile: () => profile, credential: () => credential,
    mint: kind => `${kind}-${++count}`,
    client: () => ({ inspectAdmission: async body => previewOf(body), ...clientOverride }),
  })
  return { c, request, setCredential: value => { credential = value }, changeProfile: () => { profile = { ...profile, cwd: '/different' } } }
}
await test('main admission seam reserves exact IDs, binds reviewed SHA/settings and consumes once', async () => {
  const { c, request } = coordinator()
  const preview = await c.inspect(request)
  const approved = { ...request, workspace: preview.workspace, settings: preview.prospectiveSettings,
    admission: preview, scopeApproved: true, highAutonomyApproved: true }
  const intent = c.take(approved)
  assert.equal(intent.missionId, preview.missionId)
  assert.equal(intent.commandId, 'command-2')
  assert.equal(intent.workspace.baseSha, 'a'.repeat(40))
  assert.deepEqual(intent.settings, request.settings)
  assert.equal(c.take(approved), null)
})
await test('late inspection cannot retain proof across concurrent inspection, credential/profile changes or explicit invalidation', async () => {
  for (const mode of ['credential', 'profile', 'invalidate', 'newer']) {
    const hold = deferred()
    let body
    const { c, request, setCredential, changeProfile } = coordinator({
      inspectAdmission: async draft => { body = draft; await hold.promise; return previewOf(draft) },
    })
    const first = c.inspect(request)
    await Promise.resolve()
    assert(body)
    if (mode === 'credential') setCredential('rotated')
    if (mode === 'profile') changeProfile()
    if (mode === 'invalidate') c.invalidate()
    let second
    if (mode === 'newer') second = c.inspect({ ...request, goal: 'Different goal' })
    hold.resolve()
    await assert.rejects(first)
    if (second) await second
  }
})
await test('consent, edited frozen scope, identity, forged proof and expired proof never pass the main submission seam', async () => {
  for (const mode of ['scope', 'high', 'goal', 'sha', 'settings', 'budget', 'credential', 'profile', 'proof', 'expiry']) {
    const { c, request, setCredential, changeProfile } = coordinator()
    const p = await c.inspect(request)
    const approved = { ...request, admission: p, workspace: p.workspace, settings: p.prospectiveSettings,
      scopeApproved: true, highAutonomyApproved: true }
    if (mode === 'scope') approved.scopeApproved = false
    if (mode === 'high') approved.highAutonomyApproved = false
    if (mode === 'goal') approved.goal += ' Publish it.'
    if (mode === 'sha') approved.workspace = { ...approved.workspace, baseSha: 'b'.repeat(40) }
    if (mode === 'settings') approved.settings = { ...approved.settings, workerModel: 'substituted' }
    if (mode === 'budget') approved.policy = { ...approved.policy, budget: { unit: 'fixture-unit', capUnits: '999' } }
    if (mode === 'credential') setCredential('rotated')
    if (mode === 'profile') changeProfile()
    if (mode === 'proof') approved.admission = { ...p, draftHash: 'b'.repeat(64) }
    if (mode === 'expiry') approved.admission = { ...p, expiresAt: new Date(Date.now() - 60000).toISOString() }
    assert.equal(c.take(approved), null, mode)
  }
})
await test('partial observations preserve omitted data and cannot refresh authoritative pending or clear requests', async () => {
  const f = await fixture()
  try {
    const intent = makeIntent()
    const s = await f.broker.prepare(intent)
    const pending = makeAttention()
    f.broker.ingestObservation(intent.missionId, OWNER, observation(intent, s.binding, {
      state: 'running', features: [{ id: 'feature', description: 'Retained', status: 'in_progress', expectedBehavior: ['Preserved'] }],
      workerSessionIds: ['child'], sessionIds: [s.binding.sessionId, 'child'], progressLog: [{ retained: true }], pending: [pending],
    }))
    const before = clone(f.broker.store.data.jobs[intent.missionId])
    const after = f.broker.ingestObservation(intent.missionId, OWNER, observation(intent, s.binding, {
      state: 'planning', effectiveSettings: {}, pendingComplete: false, pendingSource: 'notification',
      presentSections: ['history'], history: [{ id: 'history-only', who: 'factory', text: 'Passive history', at: new Date().toISOString() }],
    }))
    assert.equal(after.state, before.snapshot.state)
    assert.deepEqual(after.features, before.snapshot.features)
    assert.deepEqual(f.broker.store.data.jobs[intent.missionId].workerSessionIds, before.workerSessionIds)
    assert.deepEqual(f.broker.store.data.jobs[intent.missionId].progressLog, before.progressLog)
    assert.deepEqual(f.broker.store.data.jobs[intent.missionId].effectiveSettings, before.effectiveSettings)
    assert.equal(after.attention[0].state, 'open')
    assert.equal(after.completeness, 'unknown')
    assert.equal(f.broker.store.data.jobs[intent.missionId].reconciledEpoch, 0)
    assert.equal(f.broker.store.data.jobs[intent.missionId].lastPendingAt, null)
    f.broker.close()
    const restored = await NativeBroker.open(f.options)
    try { assert.equal(restored.project(intent.missionId, OWNER).attention[0].state, 'open') }
    finally { restored.close() }
  } finally { await f.cleanup() }
})
await test('initialized resource and provider substeps survive unsent goal and restart without granting effective settings or replay', async () => {
  const transport = fakeTransport()
  const preflight = transport.preflight
  transport.preflight = async function (...args) { return { ...await preflight.apply(this, args), settingsEvidence: 'prospective' } }
  transport.launch = async function (intent, ctx) {
    this.calls.push({ method: 'launch' })
    assert.equal(ctx.commandId, intent.commandId)
    await ctx.providerJournal.write({ version: 1, step: 'initialize_invoked' })
    await ctx.providerJournal.initialized({ ...intent.workspace, sessionId: 'initialized-resource' })
    await ctx.providerJournal.write({ version: 1, step: 'goal_unsent' })
    throw new Error('Synthetic effective-settings mismatch')
  }
  const f = await fixture({ transport })
  try {
    const intent = makeIntent()
    const s = await f.broker.prepare(intent)
    assert.equal(s.binding.sessionId, 'initialized-resource')
    assert.equal(s.commands[0].state, 'unknown')
    assert.equal(f.broker.store.data.jobs[intent.missionId].effectiveSettings, null)
    assert.equal(f.broker.context(f.broker.job(intent.missionId, OWNER)).providerJournal.read().step, 'goal_unsent')
    f.broker.close()
    const restored = await NativeBroker.open(f.options)
    try {
      const row = restored.job(intent.missionId, OWNER)
      assert.equal(restored.context(row).providerJournal.read().step, 'goal_unsent')
      await restored.prepare(intent)
      assert.equal(transport.calls.filter(c => c.method === 'launch').length, 1)
    } finally { restored.close() }
  } finally { await f.cleanup() }
})
await test('canonical fingerprint parity includes explicit budget and retains legacy scope hashes without a budget', async () => {
  const intent = makeIntent('budget', { policy: { ...makeIntent().policy, budget: { unit: 'fixture-credit-micro', capUnits: '123000' } } })
  assert.equal(await nativeFingerprint(intent), hash(intent))
  assert.equal(canonicalNativeJson(clone(intent)), canonicalNativeJson(intent))
  // A budgeted intent is only admitted by a transport that reports actual enforcement.
  const transport = fakeTransport()
  const preflight = transport.preflight
  transport.preflight = async function (...args) {
    return { ...await preflight.apply(this, args), budgetEnforced: true, usageReporting: 'enforced' }
  }
  const f = await fixture({ transport })
  try {
    assert.equal((await f.broker.prepare(intent)).commands[0].state, 'confirmed')
    assert.deepEqual(f.broker.store.data.jobs.budget.intent.policy.budget, intent.policy.budget)
  } finally { await f.cleanup() }
})
await test('real authenticated admission HTTP route supports CORS and stays read-only', async () => {
  const f = await fixture({ transport: inspectTransport() })
  const server = await startBrokerServer({ broker: f.broker, bearerToken: TOKEN, allowedOrigins: ['https://phone.fixture.invalid'] })
  const url = `http://127.0.0.1:${server.address().port}/v1/native/admission`
  try {
    const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://phone.fixture.invalid' } })
    assert.equal(preflight.status, 200)
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://phone.fixture.invalid')
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draftOf()) })).status, 401)
    const response = await fetch(url, { method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(draftOf()) })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).draftHash, hash(draftOf()))
    assert.equal(Object.keys(f.broker.store.data.jobs).length, 0)
    assert.equal(f.transport.calls.length, 0)
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    await f.cleanup()
  }
})
await test('timed-out inspections retain bounded actual-read slots until raw promises settle', async () => {
  const hold = deferred()
  let reads = 0
  const transport = inspectTransport()
  transport.inspectAdmission = async draft => { reads++; await hold.promise; return previewOf(draft) }
  const f = await fixture({ transport, timeoutMs: 15 })
  try {
    for (let i = 0; i < 8; i++) await assert.rejects(() => f.broker.inspectAdmission(draftOf(makeIntent(`slot-${i}`))), e => e.code === 'transport_timeout')
    assert.equal(reads, 8)
    await assert.rejects(() => f.broker.inspectAdmission(draftOf(makeIntent('slot-8'))), e => e.code === 'observation_capacity_exceeded')
    await assert.rejects(() => f.broker.inspectAdmission(draftOf(makeIntent('slot-0'))), e => e.code === 'transport_timeout')
    assert.equal(reads, 8)
    assert.equal(f.broker.admissionReads.size, 8)
    hold.resolve(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.broker.admissionReads.size, 0)
    assert.equal(Object.keys(f.broker.store.data.jobs).length, 0)
    assert.equal((await f.broker.inspectAdmission(draftOf(makeIntent('released')))).launchEligible, true)
  } finally { hold.resolve(); await f.cleanup() }
})
await test('journal identity is stable across preflight/invocation while prospective High/settings await initialization', async () => {
  let journal
  const transport = fakeTransport()
  const launch = transport.launch, preflight = transport.preflight
  transport.preflight = async function (...args) {
    journal = args[1].providerJournal
    return { ...await preflight.apply(this, args), settingsEvidence: 'prospective', availableAutonomyLevels: [] }
  }
  transport.launch = async function (...args) {
    assert.equal(args[1].providerJournal, journal)
    assert.equal(args[1].commandId, args[0].commandId)
    return launch.apply(this, args)
  }
  const f = await fixture({ transport })
  try { assert.equal((await f.broker.prepare(makeIntent())).commands[0].state, 'confirmed') }
  finally { await f.cleanup() }
})
await test('persisted native requests and permission effects project without fabricating local delivery or full pending recovery', async () => {
  const intent = makeIntent()
  const scopeHash = hash(Object.fromEntries(Object.entries(intent).filter(([key]) => !['commandId', 'scopeApproved', 'highAutonomyApproved'].includes(key))))
  const policyHash = hash({ policy: intent.policy, settings: intent.settings })
  const owned = hash([OWNER, intent.missionId, MACHINE, scopeHash, policyHash])
  const root = ownedRootSessionId(owned)
  const transport = fakeTransport()
  const launch = transport.launch
  transport.launch = async function (...args) {
    const result = await launch.apply(this, args); result.binding.sessionId = root; return result
  }
  const f = await fixture({ transport })
  try {
    const snapshot = await f.broker.prepare(intent)
    const ctx = f.broker.context(f.broker.job(intent.missionId, OWNER))
    const at = new Date().toISOString()
    const wrap = (type, extra) => ({ type, jsonrpc: '2.0', factoryApiVersion: '1.0.0', factoryProtocolVersion: '1.201.1', ...extra })
    const envelope = wrap('request', { id: 'native-rpc', method: 'daemon.request_permission', params: {
      sessionId: root, associatedSessionIds: [root],
      toolUses: [{ toolUse: { type: 'tool_use', id: 'native-tool', name: 'Execute', input: { command: 'echo fixture' } },
        confirmationType: 'exec', details: { type: 'exec', command: 'echo', fullCommand: 'echo fixture' } }],
      options: [{ label: 'Allow once', value: 'proceed_once' }, { label: 'Cancel', value: 'cancel' }],
    } })
    const decoded = decodeSdkEnvelope(envelope, { machineId: MACHINE, connectionId: 'fixture-connection', rootSessionId: root, observedAt: at })
    const initializeParams = {
      machineId: MACHINE, cwd: intent.workspace.cwd, sessionId: root, interactionMode: 'mission',
      autonomyLevel: 'high', modelId: 'fixture-orchestrator', reasoningEffort: 'high',
      missionSettings: { workerModel: 'fixture-worker', workerReasoningEffort: 'high',
        validationWorkerModel: 'fixture-validator', validationWorkerReasoningEffort: 'high',
        skipScrutiny: false, skipUserTesting: false },
      restrictToolIds: ['Read'], autoRejectPermissionRequests: false,
    }
    const goalText = JSON.stringify({ goal: intent.goal })
    const record = {
      version: 1, ownerId: OWNER, missionId: intent.missionId, machineId: MACHINE, scopeHash, policyHash,
      rootSessionId: root, epoch: ctx.epoch, scopeRevision: 1, connectionId: 'fixture-connection',
      workspace: intent.workspace, goalText, initializeParams, compiledPolicyHash: 'b'.repeat(64),
      workspaceProof: null, enforcementLease: null,
      initialize: { state: 'prepared', requestHash: hash({ method: 'daemon.initialize_session', params: initializeParams }),
        rpcId: null, messageId: null, receiptHash: null, fault: null },
      goal: { state: 'prepared', requestHash: hash({ method: 'daemon.add_user_message', id: `goal-${owned}`,
        params: { sessionId: root, messageId: `message-${owned}`, text: goalText } }),
        rpcId: `goal-${owned}`, messageId: `message-${owned}`, receiptHash: null, fault: null },
      binding: snapshot.binding, effectiveSettings: null, settingsObservedAt: null,
      sessions: [{ sessionId: root, parentSessionId: null, connectionId: 'fixture-connection', active: true, source: 'initialize' }],
      requests: [{ attention: decoded.attention, raw: decoded.raw, envelope: decoded.envelope,
        connectionId: 'fixture-connection', proposalHash: null, unsupportedReason: null }],
      answerAttempts: [], resolutions: [],
      observations: { mission: null, features: null, progress: null, workers: [], history: [] },
      ingestionFault: null, recoveryHold: false,
    }
    // Synthetic fixture has no SDK connection. Changing the version invalidates
    // its signed launch qualification rather than enabling real native work.
    transport.version = SDK_TRANSPORT_VERSION
    await ctx.providerJournal.write(record)
    const bridge = createNativeProviderBrokerBridge({ broker: f.broker, missionId: intent.missionId, ownerId: OWNER })
    bridge(decoded)
    const pending = f.broker.project(intent.missionId, OWNER)
    assert.equal(pending.attention[0].requestId, 'native-rpc')
    assert.equal(pending.attention[0].state, 'open')
    assert.notEqual(pending.completeness, 'complete')
    assert.equal(pending.capabilities.qualified, false)
    const uncertainResponse = { sessionId: root, selectedOption: 'proceed_once' }
    record.requests[0].attention.state = 'answer_unknown'
    record.answerAttempts.push({
      commandId: 'answer-unknown', attentionId: decoded.attention.attentionId,
      requestHash: hash({ type: 'response', id: 'native-rpc', result: uncertainResponse }),
      response: uncertainResponse, state: 'unknown', invokedAt: at,
    })
    await ctx.providerJournal.write(record)
    const heartbeatEnvelope = wrap('notification', { method: 'daemon.session_notification',
      params: { sessionId: root, notification: { type: 'mission_heartbeat', timestamp: at } } })
    bridge(decodeSdkEnvelope(heartbeatEnvelope, {
      machineId: MACHINE, connectionId: 'fixture-connection', rootSessionId: root, observedAt: at,
    }))
    const uncertain = f.broker.project(intent.missionId, OWNER)
    assert.equal(uncertain.attention.length, 1)
    assert.equal(uncertain.attention[0].requestId, 'native-rpc')
    assert.equal(uncertain.attention[0].state, 'open')
    assert.notEqual(uncertain.completeness, 'complete')
    const resolvedEnvelope = wrap('notification', { method: 'daemon.session_notification',
      params: { sessionId: root, notification: { type: 'permission_resolved',
        requestId: 'native-rpc', toolUseIds: ['native-tool'], selectedOption: 'proceed_once' } } })
    const resolved = decodeSdkEnvelope(resolvedEnvelope, { machineId: MACHINE, connectionId: 'fixture-connection', rootSessionId: root, observedAt: at })
    assert.throws(() => bridge(resolved), e => e.code === 'sdk_projection_not_persisted')
    record.requests[0].attention.state = 'resolved'; record.requests[0].attention.resolvedAt = at
    record.resolutions.push({ attentionId: decoded.attention.attentionId, envelope: resolvedEnvelope, observedAt: at,
      effect: { kind: 'permission_effect', selectedOption: 'proceed_once', attribution: 'unknown_or_external' } })
    await ctx.providerJournal.write(record)
    bridge(resolved)
    const closed = f.broker.project(intent.missionId, OWNER)
    assert.equal(closed.attention[0].state, 'resolved')
    assert.equal(f.broker.store.data.jobs[intent.missionId].approvedProposal, null)
    assert.equal(f.broker.store.data.jobs[intent.missionId].reconciledEpoch, 0)
    assert.equal(closed.commands.length, 1) // No invented answer command/receipt.
    const corrupt = clone(record); corrupt.goal.requestHash = 'f'.repeat(64)
    await assert.rejects(() => ctx.providerJournal.write(corrupt))
  } finally { await f.cleanup() }
})
await test('persisted Mission v2 facts project derived state and workers; v2 bypasses of the notification route fail', async () => {
  const intent = makeIntent()
  const scopeHash = hash(Object.fromEntries(Object.entries(intent).filter(([key]) => !['commandId', 'scopeApproved', 'highAutonomyApproved'].includes(key))))
  const policyHash = hash({ policy: intent.policy, settings: intent.settings })
  const owned = hash([OWNER, intent.missionId, MACHINE, scopeHash, policyHash])
  const root = ownedRootSessionId(owned)
  const transport = fakeTransport()
  const launch = transport.launch
  transport.launch = async function (...args) {
    const result = await launch.apply(this, args); result.binding.sessionId = root; return result
  }
  const f = await fixture({ transport })
  try {
    const snapshot = await f.broker.prepare(intent)
    const ctx = f.broker.context(f.broker.job(intent.missionId, OWNER))
    const at = new Date().toISOString(), connectionId = 'fixture-connection'
    const wrap = (type, extra) => ({ type, jsonrpc: '2.0', factoryApiVersion: '1.0.0', factoryProtocolVersion: '1.201.1', ...extra })
    const note = notification => wrap('notification', { method: 'daemon.session_notification', params: { sessionId: root, notification } })
    const decode = envelope => decodeSdkEnvelope(envelope, { machineId: MACHINE, connectionId, rootSessionId: root, observedAt: at })
    const checks = [{ id: 'greeting-works', group: 'Feature', description: 'greet(name) returns the greeting.', how: 'Run npm test.' }]
    const details = { type: 'exit_mission_planning', title: 'Add greeting', missionPlan: 'Add greet(name).', checks }
    const planEnvelope = wrap('request', { id: 'plan-rpc', method: 'daemon.request_permission', params: {
      sessionId: root, associatedSessionIds: [root],
      toolUses: [{ toolUse: { type: 'tool_use', id: 'plan-tool', name: 'ExitMissionPlanning', input: {} },
        confirmationType: 'exit_mission_planning', details }],
      options: [{ label: 'Approve Mission', value: 'proceed_once' }, { label: 'Request changes', value: 'cancel' }],
    } })
    const plan = decode(planEnvelope)
    assert.equal(plan.attention.kind, 'proposal')
    const resolvedEnvelope = note({ type: 'permission_resolved', requestId: 'plan-rpc', toolUseIds: ['plan-tool'], selectedOption: 'proceed_once' })
    const v2Snapshot = latestEventNumber => ({ sessionId: root, title: 'Add greeting', approvedAt: at, latestEventNumber,
      planHash: 'a'.repeat(64), checksHash: 'b'.repeat(64), checkCounts: { total: 1, met: latestEventNumber, unmet: 0, waived: 0 } })
    const snapshotEnvelope = note({ type: 'mission_v2_snapshot_changed', snapshot: v2Snapshot(0) })
    const initializeParams = {
      machineId: MACHINE, cwd: intent.workspace.cwd, sessionId: root, interactionMode: 'mission',
      autonomyLevel: 'high', modelId: 'fixture-orchestrator', reasoningEffort: 'high',
      missionSettings: { workerModel: 'fixture-worker', workerReasoningEffort: 'high',
        validationWorkerModel: 'fixture-validator', validationWorkerReasoningEffort: 'high',
        skipScrutiny: false, skipUserTesting: false },
      restrictToolIds: ['Read', 'RecommendMission', 'ExitMissionPlanning', 'Task', 'Script'], autoRejectPermissionRequests: false,
    }
    const goalText = JSON.stringify({ goal: intent.goal })
    const record = {
      version: 1, ownerId: OWNER, missionId: intent.missionId, machineId: MACHINE, scopeHash, policyHash,
      rootSessionId: root, epoch: ctx.epoch, scopeRevision: 1, connectionId,
      workspace: intent.workspace, goalText, initializeParams, compiledPolicyHash: 'b'.repeat(64),
      workspaceProof: null, enforcementLease: null,
      initialize: { state: 'prepared', requestHash: hash({ method: 'daemon.initialize_session', params: initializeParams }),
        rpcId: null, messageId: null, receiptHash: null, fault: null },
      goal: { state: 'prepared', requestHash: hash({ method: 'daemon.add_user_message', id: `goal-${owned}`,
        params: { sessionId: root, messageId: `message-${owned}`, text: goalText } }),
        rpcId: `goal-${owned}`, messageId: `message-${owned}`, receiptHash: null, fault: null },
      binding: snapshot.binding, effectiveSettings: null, settingsObservedAt: null,
      sessions: [
        { sessionId: root, parentSessionId: null, connectionId, active: true, source: 'initialize' },
        { sessionId: 'worker-1', parentSessionId: root, connectionId, active: true, source: 'child_notification' },
      ],
      requests: [{ attention: { ...plan.attention, state: 'resolved', resolvedAt: at }, raw: plan.raw, envelope: plan.envelope,
        connectionId, proposalHash: plan.proposalHash, unsupportedReason: null }],
      answerAttempts: [],
      resolutions: [{ attentionId: plan.attention.attentionId, envelope: resolvedEnvelope, observedAt: at,
        effect: { kind: 'permission_effect', selectedOption: 'proceed_once', attribution: 'unknown_or_external' } }],
      observations: { mission: null, features: null, progress: null, workers: [], history: [] },
      ingestionFault: null, recoveryHold: false, dialect: 'v2',
      missionV2: {
        seq: 4, rootBusySeq: 3,
        approval: { attentionId: plan.attention.attentionId, proposalHash: plan.proposalHash, observedAt: at, seq: 1 },
        snapshot: { envelope: snapshotEnvelope, observedAt: at, seq: 2 },
        rootWorking: { state: 'executing_tool', observedAt: at, seq: 3 }, lastTurn: null,
        workers: [{ childSessionId: 'worker-1', toolUseId: 'task-1', subagentType: 'worker', description: 'Implement',
          startedAt: at, startSeq: 4, finishedAt: null, finishSeq: null, failed: null }],
      },
    }
    transport.version = SDK_TRANSPORT_VERSION
    await ctx.providerJournal.write(record)
    const bridge = createNativeProviderBrokerBridge({ broker: f.broker, missionId: intent.missionId, ownerId: OWNER })
    bridge(decode(snapshotEnvelope))
    const job = () => f.broker.store.data.jobs[intent.missionId]
    let projected = f.broker.project(intent.missionId, OWNER)
    assert.equal(projected.state, 'running')
    assert.deepEqual(job().workerSessionIds, ['worker-1'])
    assert.deepEqual(projected.features, []); assert.notEqual(projected.completeness, 'complete')
    // An envelope the provider did not persist is never projected.
    assert.throws(() => bridge(decode(note({ type: 'mission_v2_snapshot_changed', snapshot: v2Snapshot(1) }))),
      e => e.code === 'sdk_projection_not_persisted')
    // Root idle after a completed turn with the worker finished: no verified record here, so never completed.
    const finished = clone(record)
    Object.assign(finished.missionV2, {
      seq: 8, snapshot: { envelope: note({ type: 'mission_v2_snapshot_changed', snapshot: v2Snapshot(1) }), observedAt: at, seq: 6 },
      lastTurn: { reason: 'completed', turnId: null, observedAt: at, seq: 7 },
      rootWorking: { state: 'idle', observedAt: at, seq: 8 },
    })
    Object.assign(finished.missionV2.workers[0], { finishedAt: at, finishSeq: 5, failed: false })
    await ctx.providerJournal.write(finished)
    const idle = note({ type: 'droid_working_state_changed', newState: 'idle' })
    bridge(decode(idle))
    projected = f.broker.project(intent.missionId, OWNER)
    assert.equal(projected.state, 'awaiting_input'); assert.equal(projected.finalization, null)
    for (const [type, payload, code] of [
      ['mission_v2_snapshot_changed', { snapshot: v2Snapshot(1) }, 'mission_v2_notification_unsupported'],
      ['agent_turn_completed', { reason: 'completed' }, 'mission_v2_notification_unsupported'],
      ['mission_state_changed', { state: 'completed' }, 'sdk_mission_dialect_mixed'],
      ['mission_features_changed', { features: [] }, 'sdk_mission_dialect_mixed'],
    ]) {
      assert.throws(() => f.broker.ingestNotification(intent.missionId, OWNER, { machineId: MACHINE, sessionId: root, type, payload }),
        e => e.code === code)
    }
    assert.equal(f.broker.project(intent.missionId, OWNER).state, 'awaiting_input')
    f.broker.ingestNotification(intent.missionId, OWNER, { machineId: MACHINE, sessionId: root, type: 'mission_heartbeat', payload: { timestamp: at } })
    const mixed = clone(finished); mixed.observations.mission = { envelope: note({ type: 'mission_state_changed', state: 'running' }), observedAt: at }
    await assert.rejects(() => ctx.providerJournal.write(mixed))
  } finally { await f.cleanup() }
})
await test('persisted v2-agents (droid 0.238) facts project agents and derived state; only a latched completion completes', async () => {
  const intent = makeIntent()
  const scopeHash = hash(Object.fromEntries(Object.entries(intent).filter(([key]) => !['commandId', 'scopeApproved', 'highAutonomyApproved'].includes(key))))
  const policyHash = hash({ policy: intent.policy, settings: intent.settings })
  const owned = hash([OWNER, intent.missionId, MACHINE, scopeHash, policyHash])
  const root = ownedRootSessionId(owned)
  const transport = fakeTransport()
  const launch = transport.launch
  transport.launch = async function (...args) {
    const result = await launch.apply(this, args); result.binding.sessionId = root; return result
  }
  const f = await fixture({ transport })
  try {
    const snapshot = await f.broker.prepare(intent)
    const ctx = f.broker.context(f.broker.job(intent.missionId, OWNER))
    const at = new Date().toISOString(), connectionId = 'fixture-connection', agent = '7b9ae5c2-16b7-47fc-871f-3e5cd6ddc3c4'
    const wrap = (type, extra) => ({ type, jsonrpc: '2.0', factoryApiVersion: '1.0.0', factoryProtocolVersion: '1.201.1', ...extra })
    const note = notification => wrap('notification', { method: 'daemon.session_notification', params: { sessionId: root, notification } })
    const decode = envelope => decodeSdkEnvelope(envelope, { machineId: MACHINE, connectionId, rootSessionId: root, observedAt: at })
    const initializeParams = {
      machineId: MACHINE, cwd: intent.workspace.cwd, sessionId: root, interactionMode: 'mission',
      autonomyLevel: 'high', modelId: 'fixture-orchestrator', reasoningEffort: 'high',
      missionSettings: { workerModel: 'fixture-worker', workerReasoningEffort: 'high',
        validationWorkerModel: 'fixture-validator', validationWorkerReasoningEffort: 'high',
        skipScrutiny: false, skipUserTesting: false },
      restrictToolIds: ['Read', 'SpawnAgent', 'SendMessage', 'ListAgents', 'InterruptAgent'], autoRejectPermissionRequests: false,
      tags: [{ name: 'mission-v2' }],
    }
    const goalText = JSON.stringify({ goal: intent.goal })
    const record = {
      version: 1, ownerId: OWNER, missionId: intent.missionId, machineId: MACHINE, scopeHash, policyHash,
      rootSessionId: root, epoch: ctx.epoch, scopeRevision: 1, connectionId,
      workspace: intent.workspace, goalText, initializeParams, compiledPolicyHash: 'b'.repeat(64),
      workspaceProof: null, enforcementLease: null,
      initialize: { state: 'prepared', requestHash: hash({ method: 'daemon.initialize_session', params: initializeParams }),
        rpcId: null, messageId: null, receiptHash: null, fault: null },
      goal: { state: 'prepared', requestHash: hash({ method: 'daemon.add_user_message', id: `goal-${owned}`,
        params: { sessionId: root, messageId: `message-${owned}`, text: goalText } }),
        rpcId: `goal-${owned}`, messageId: `message-${owned}`, receiptHash: null, fault: null },
      binding: snapshot.binding, effectiveSettings: null, settingsObservedAt: null,
      sessions: [{ sessionId: root, parentSessionId: null, connectionId, active: true, source: 'initialize' }],
      requests: [], answerAttempts: [], resolutions: [],
      observations: { mission: null, features: null, progress: null, workers: [], history: [] },
      ingestionFault: null, recoveryHold: false, dialect: 'v2-agents',
      missionV2Agents: {
        seq: 3, tag: { kind: 'orchestrator', missionId: root }, rootBusySeq: 3,
        rootWorking: { state: 'executing_tool', observedAt: at, seq: 3 }, lastTurn: null,
        agents: [{ sessionId: agent, title: 'Greeting feature and tests', status: 'running', waitingOn: null,
          source: 'spawn', firstSeenAt: at, listedAt: null, seq: 2 }],
        agentsOverflow: false, toolUses: [], toolResults: [{ toolUseId: 'call-spawn', seq: 1, failed: false }], completed: null,
      },
    }
    transport.version = SDK_TRANSPORT_VERSION
    await ctx.providerJournal.write(record)
    const bridge = createNativeProviderBrokerBridge({ broker: f.broker, missionId: intent.missionId, ownerId: OWNER })
    const job = () => f.broker.store.data.jobs[intent.missionId]
    bridge(decode(note({ type: 'droid_working_state_changed', newState: 'executing_tool' })))
    let projected = f.broker.project(intent.missionId, OWNER)
    assert.equal(projected.state, 'running'); assert.deepEqual(job().workerSessionIds, [agent])
    assert.notEqual(projected.completeness, 'complete')
    // Settled facts (completed turn, root idle, agent idle) never complete on the envelope path.
    const settled = clone(record)
    Object.assign(settled.missionV2Agents, {
      seq: 6, lastTurn: { reason: 'completed', turnId: 'turn-1', observedAt: at, seq: 5 },
      rootWorking: { state: 'idle', observedAt: at, seq: 6 },
    })
    Object.assign(settled.missionV2Agents.agents[0], { status: 'idle', source: 'spawn', listedAt: at, seq: 4 })
    await ctx.providerJournal.write(settled)
    bridge(decode(note({ type: 'droid_working_state_changed', newState: 'idle' })))
    assert.equal(f.broker.project(intent.missionId, OWNER).state, 'awaiting_input')
    // A completion the live provider latched and persisted is reported; late activity never regresses it.
    const latched = clone(settled)
    latched.missionV2Agents.seq = 8
    latched.missionV2Agents.completed = { observedAt: at, seq: 7, lateActivity: 1, lastLateActivityAt: at }
    latched.missionV2Agents.rootBusySeq = 8
    latched.missionV2Agents.rootWorking = { state: 'thinking', observedAt: at, seq: 8 }
    await ctx.providerJournal.write(latched)
    bridge(decode(note({ type: 'droid_working_state_changed', newState: 'thinking' })))
    projected = f.broker.project(intent.missionId, OWNER)
    assert.equal(projected.state, 'completed'); assert.notEqual(projected.holdReason, 'terminal_state_regression')
    for (const [type, payload, code] of [
      ['agent_turn_completed', { reason: 'completed' }, 'mission_v2_notification_unsupported'],
      ['mission_state_changed', { state: 'running' }, 'sdk_mission_dialect_mixed'],
      ['mission_worker_started', { workerSessionId: agent }, 'sdk_mission_dialect_mixed'],
    ]) {
      assert.throws(() => f.broker.ingestNotification(intent.missionId, OWNER, { machineId: MACHINE, sessionId: root, type, payload }),
        e => e.code === code)
    }
    const mixed = clone(latched); mixed.observations.mission = { envelope: note({ type: 'mission_state_changed', state: 'running' }), observedAt: at }
    await assert.rejects(() => ctx.providerJournal.write(mixed))
    const badTag = clone(latched); badTag.missionV2Agents.tag.missionId = 'someone-else'
    await assert.rejects(() => ctx.providerJournal.write(badTag))
  } finally { await f.cleanup() }
})
await test('host-routed admission integrates actual provider, HTTP client and coordinator without a daemon or model (default and owner-trusted host)', async () => {
  for (const trusted of [false, true]) for (const kind of ['existing', 'new_repository']) {
    const h = hostFixture()
    h.advance(Date.now() - h.now())
    const missionId = `mission-admission-${kind}${trusted ? '-trusted' : ''}`
    let intent = h.intentFor({ missionId })
    delete intent.workspace.baseSha
    if (kind === 'new_repository') {
      intent.destination = { kind, account: 'owner', name: 'new-repo', visibility: 'private', initialization: 'empty' }
      intent.workspace.repository = 'owner/new-repo'
      intent.policy.allowCreateRepository = true
    }
    let executionFactories = 0
    const transport = createHostRoutedTransport({
      host: h.host, version: SDK_TRANSPORT_VERSION,
      support: { launch: true, rootAttention: true, childAttention: trusted, recoverAttention: trusted },
      createJobTransport() { executionFactories++; throw new Error('Execution must not be composed for inspection') },
      createAdmissionTransport(input) {
        return createInjectedNativeProvider({
          ...input, deployment: h.deployment, evidenceAuthority: h.host.evidenceAuthority,
          hostPublicKey: h.host.publicKey, now: h.now, trustedHost: trusted,
          transport: createHostLoopbackSocket({ url: 'ws://127.0.0.1:1' }),
          createClient: createHostAdmissionClient,
          safeExtensionTokenGetter: async () => { throw new Error('No credential read in admission') },
          policy: { compileNativePolicy, validateWorkspaceProof, validateEnforcementLease },
        })
      },
    })
    const broker = await NativeBroker.open({
      directory: join(h.base, 'broker'), ownerId: intent.ownerId, machineId: intent.workspace.machineId,
      bearerToken: TOKEN, host: h.host, delivery: h.delivery, deploymentDigest: h.deployment.deploymentDigest,
      transport, now: h.now, trustedHost: trusted,
    })
    let server
    try {
      server = await startBrokerServer({ broker, bearerToken: TOKEN })
      const brokerUrl = `http://127.0.0.1:${server.address().port}`
      const client = new HttpNativeBrokerClient({ brokerUrl, credential: () => TOKEN })
      const profile = { brokerUrl, ownerId: intent.ownerId, machineId: intent.workspace.machineId,
        cwd: intent.workspace.cwd, baseRef: intent.workspace.baseRef }
      const coordinator = new NativeAdmissionCoordinator({
        profile: () => profile, credential: () => TOKEN, client: () => client,
        mint: kind => kind === 'mission' ? missionId : intent.commandId, now: h.now,
      })
      const draft = draftOf(intent)
      const { missionId: _, commandId: __, ...body } = draft
      const request = { ...body, brokerUrl }
      const preview = await coordinator.inspect(request)
      assert.equal(preview.draftHash, hash(draft))
      assert.equal(preview.workspace.cwd, intent.workspace.cwd)
      assert.equal(preview.workspace.baseSha, 'c'.repeat(40)) // Fixture-minted SHA, never a production constant.
      const caps = broker.getCapabilities()
      if (trusted) {
        // The owner accepted the structural risks: no holds remain, consent can be taken.
        assert.deepEqual(preview.holds, [])
        assert.equal(preview.launchEligible, true)
        assert(caps.qualified && caps.launch && caps.rootAttention && caps.childAttention && caps.recoverAttention)
        assert.match(caps.qualificationId, /^owner-trusted-host:/)
        const taken = coordinator.take({ ...request, workspace: preview.workspace, settings: preview.prospectiveSettings,
          admission: preview, scopeApproved: true, highAutonomyApproved: true })
        assert(taken && taken.scopeApproved && taken.highAutonomyApproved)
      } else {
        assert.equal(preview.launchEligible, false)
        assert.equal(caps.qualified, false)
        for (const hold of ['native_credential_isolation_unproven', 'sdk_mission_settings_unconfirmed',
          'native_child_attention', 'passive_authoritative_pending_recovery']) assert(preview.holds.includes(hold))
        assert.equal(coordinator.take({ ...request, workspace: preview.workspace, admission: preview,
          scopeApproved: true, highAutonomyApproved: true }), null)
      }
      assert.equal(executionFactories, 0)
      assert.equal(h.spawns.length, 0)
      assert.equal(h.delivery.calls.length, 0)
      assert.equal(Object.keys(broker.store.data.jobs).length, 0)
      assert.equal(broker.store.data.seq, 0)
      if (kind === 'existing') {
        const provisioned = h.host.job(missionId)
        assert.equal(provisioned.state, 'provisioned')
        assert.equal(provisioned.intent.scopeApproved, false)
        assert.equal(provisioned.intent.highAutonomyApproved, false)
        assert.equal(h.gitCalls.filter(row => row.args[0] === 'clone').length, 1)
      } else {
        const provisioned = h.host.job(missionId)
        assert.equal(provisioned.localSeed, true)
        assert.equal(provisioned.created, false)
        assert.equal(provisioned.intent.scopeApproved, false)
        assert.equal(h.gitCalls.filter(row => row.args.includes('commit')).length, 1)
        assert.equal(h.gitCalls.filter(row => row.args[0] === 'clone').length, 0)
        assert(!preview.holds.includes('native_prospective_workspace_only'))
      }
    } finally {
      if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
      broker.close(); h.cleanup()
    }
  }
})
console.log(`Native admission: ${checks}/${checks} offline groups passed; no SDK import or native execution.`)
