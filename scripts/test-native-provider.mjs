/**
 * Production provider/wire modules exercised with offline public-SDK/host ports.
 * No SDK import, daemon, real host boundary, existing key reads, repository writes or network.
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createInjectedNativeProvider, createGuardedDaemonTransport, validateProviderRecord } from '../broker/sdk-provider.mjs'
import { correlateNativeResolution, decodeSdkEnvelope, outgoingDescriptor, requestPayload, safeDecodeSdkEnvelope } from '../broker/sdk-wire.mjs'
import { compileNativePolicy, getNativeHashes } from '../broker/native-policy.mjs'
import { createNativeEvidenceAuthority } from '../broker/native-boundary.mjs'
import { validateWorkspaceProof } from '../broker/native-workspace.mjs'
import { admissionPreview, canonical, clone, hash } from '../broker/validation.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyHostQualification } from '../broker/qualification.mjs'
import { createMissionV2RecordReader } from '../broker/mission-v2-record.mjs'
import { requireMissionV2Tools, NATIVE_MISSION_V2_AGENTS_TOOLS, NATIVE_MISSION_V2_ORCHESTRATOR_TOOLS } from '../broker/native-policy.mjs'
import {
  checkMissionV2Record, deriveMissionV2AgentsState, deriveMissionV2State, normalizeMissionV2Record, parseMissionV2AgentResult,
  projectV2AgentFeatures, projectV2AgentProgress, projectV2Progress,
} from '../broker/mission-v2-state.mjs'

const NOW = Date.parse('2026-10-12T12:00:00.000Z')
const stamp = new Date(NOW).toISOString(), expiry = new Date(NOW + 60000).toISOString()
const base = 'a'.repeat(40), digest = 'b'.repeat(64)
const hostKeys = ['ownerId', 'missionId', 'machineId', 'scopeHash', 'policyHash', 'epoch']
const bind = value => Object.fromEntries(hostKeys.map(key => [key, value[key]]))
const envelope = (type, extra) => ({
  type, jsonrpc: '2.0', factoryApiVersion: '1.0.0', factoryProtocolVersion: '1.201.1', ...extra,
})
const notification = (sessionId, payload) => envelope('notification', {
  method: 'daemon.session_notification', params: { sessionId, notification: payload },
})
const message = (id, text, role = 'assistant') => ({
  id, role, content: [{ type: 'text', text }], createdAt: NOW, updatedAt: NOW,
})
function permission(sessionId, requestId = 'permission-1', details = { type: 'exec', command: 'echo', fullCommand: 'echo hi' }) {
  return envelope('request', { id: requestId, method: 'daemon.request_permission', params: {
    sessionId, associatedSessionIds: [sessionId],
    toolUses: [{ toolUse: { type: 'tool_use', id: `tool-${requestId}`, name: 'Execute', input: { command: 'echo hi' } },
      confirmationType: details.type, details }],
    options: [{ label: 'Allow once', value: 'proceed_once' }, { label: 'Cancel', value: 'cancel' }],
  } })
}
function questionnaire(sessionId, requestId = 'question-1', multiSelect = false) {
  return envelope('request', { id: requestId, method: 'daemon.ask_user', params: {
    sessionId, toolCallId: `tool-${requestId}`, questions: [
      { index: 1, topic: 'Topic', question: 'Which exact value?', options: ['first full value', 'second full value'], multiSelect },
      { index: 3, topic: '', question: 'Explain?', options: [] },
    ],
  } })
}
const decodeContext = { machineId: 'machine-1', connectionId: 'connection-1', rootSessionId: 'root-1', observedAt: stamp }
let count = 0
async function test(name, run) {
  await run(); count++; console.log(`PASS ${name}`)
}
const asDraft = intent => {
  const { scopeApproved: _scope, highAutonomyApproved: _high, ...draft } = clone(intent)
  return draft
}
const inspectionContext = context => ({
  ownerId: context.ownerId, missionId: context.missionId, machineId: context.machineId, epoch: context.epoch, readOnly: true,
})

// Ephemeral in-memory signatures exercise B's actual validator, not a Boolean
// proof port. These synthetic artifacts are never production qualification.
function offlineWorkspaceEvidence(config) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const manifests = new Map(), artifact = Buffer.from('Offline physical workspace test fixture')
  const artifactHash = createHash('sha256').update(artifact).digest('hex')
  return {
    authority: createNativeEvidenceAuthority({
      publicKey, readEvidence: id => manifests.get(id), readArtifact: () => artifact, now: () => NOW,
    }),
    record(proof) {
      const manifest = {
        version: 1, evidenceId: proof.evidenceIds[0], kind: 'workspace', subjectHash: hash(proof),
        binding: proof.binding, nonce: proof.nonce, deploymentDigest: digest, issuedAt: stamp, expiresAt: expiry,
        artifacts: ['physical_workspace', 'destination_identity'].map(dimension => ({
          id: `offline-${dimension}`, dimension, sha256: artifactHash,
        })),
      }
      const signature = sign(null, Buffer.from(canonical(manifest)), privateKey)
      if (config.forgedEvidence) signature[0] ^= 1
      manifests.set(manifest.evidenceId, { manifest, signature: signature.toString('base64') })
    },
  }
}

function fixture(config = {}) {
  const calls = [], writes = [], resources = [], exposed = [], diagnostics = [], readDiagnostics = [], hostCalls = [], proofInputs = []
  const workspaceEvidence = config.actualWorkspaceProof ? offlineWorkspaceEvidence(config) : null
  let journalReads = 0
  let saved = config.saved ? clone(config.saved) : null, revoked = false, connectionId = 'connection-1', permitCount = 0
  const transport = {
    connect: async () => { throw new Error('unexpected connect') }, disconnect: () => { throw new Error('unexpected disconnect') },
    isConnected: () => true, getConnectionId: () => connectionId, isRelayConnection: () => false,
    getTransportKind: () => 'in_process', on() {}, off() {},
    send(data) {
      const frame = JSON.parse(data)
      // Never retain the ephemeral extension credential even inside the fixture.
      const clean = clone(frame); if (clean.params) delete clean.params.token
      calls.push(clean)
      if (config.sendFailure && frame.method === 'daemon.add_user_message') throw new Error('lost send')
    },
  }
  const boundary = {
    async verifyWorkspace(input) {
      hostCalls.push('verifyWorkspace'); proofInputs.push(clone(input))
      if (config.beforeProof) await config.beforeProof()
      const proof = {
        attestationId: 'attestation-1', nonce: input.nonce, binding: bind(input),
        executionHostId: 'host-1', executionInstanceId: 'instance-1',
        canonicalCwd: config.wrongCwd ?? input.workspace.cwd, canonicalRepoRoot: input.workspace.cwd,
        canonicalGitDir: `${input.workspace.cwd}/.git`, canonicalCommonDir: `${input.workspace.cwd}/.git`,
        rootIdentity: { device: '1', inode: '2' }, gitDirIdentity: { device: '1', inode: '3' },
        repositoryId: input.workspace.repository, objectFormat: 'sha1', baseRef: input.workspace.baseRef,
        baseSha: input.workspace.baseSha, initialHeadSha: input.workspace.baseSha,
        executionRef: input.workspace.baseRef, checkoutGeneration: 'checkout-1',
        observedAt: stamp, expiresAt: expiry, evidenceIds: ['offline-workspace-evidence'],
      }
      config.mutateProof?.(proof)
      workspaceEvidence?.record(proof)
      return proof
    },
    async acquireLease(input) {
      hostCalls.push('acquireLease')
      return {
        leaseId: 'lease-1', binding: bind(input), workspaceAttestationId: input.workspaceAttestationId,
        deploymentDigest: digest, boundaryPolicyHash: input.compiledPolicyHash, revocationGeneration: 0,
        expiresAt: expiry, budget: { accountId: 'account-1', unit: 'credits', capUnits: '100', enforcementId: 'budget-1' },
        evidenceIds: ['offline-lease-evidence'],
      }
    },
    async authorizeSend(input) {
      hostCalls.push('authorizeSend')
      const permit = {
        permitId: `permit-${++permitCount}`, leaseId: input.leaseId, connectionId: input.connectionId,
        operation: input.operation, sessionId: input.sessionId, requestHash: input.requestHash,
        expiresAt: expiry, revocationGeneration: 0,
      }
      if (config.revokeDuringAuthorization) revoked = true
      return permit
    },
    assertAndConsumePermit(permit) {
      hostCalls.push('assertAndConsumePermit')
      if (revoked || config.revokeAtSend) throw new Error('boundary revoked')
      assert.equal(permit.connectionId, connectionId)
      if (config.revokeInConsume) revoked = true
    },
    async revoke() { hostCalls.push('revoke'); revoked = true; return { receiptId: 'revoke-1', revocationGeneration: 1, evidenceIds: ['offline-revoke-evidence'] } },
  }
  const intent = {
    protocolVersion: 1, ownerId: 'owner-1', missionId: 'mission-1', commandId: 'launch-1',
    goal: 'Implement the complete owner goal without clipping.', scopeRevision: 1, operation: 'implement',
    workspace: { machineId: 'machine-1', cwd: '/offline/approved', repository: 'repo-1', baseRef: 'refs/heads/main', baseSha: base },
    references: ['Attributed supplied context.'], acceptanceCriteria: ['Retain exact owner goal.'],
    restrictions: ['no push', 'no pr', 'no deploy', 'no merge', 'no repository creation'],
    policy: {
      autonomy: 'high', allowCreateRepository: false, allowPush: false, allowPr: false, allowMerge: false, allowDeploy: false,
      budget: { unit: 'credits', capUnits: '100' },
    },
    scopeApproved: true, highAutonomyApproved: true,
    settings: {
      modelId: 'model-root', reasoningEffort: 'high', workerModel: 'model-worker', workerReasoningEffort: 'medium',
      validationWorkerModel: 'model-validator', validationWorkerReasoningEffort: 'high',
      skipScrutiny: false, skipUserTesting: false,
      restrictToolIds: config.agentTools
        ? ['Read', 'Execute', 'SpawnAgent', 'SendMessage', 'ListAgents', 'InterruptAgent']
        : ['Read', 'Execute', 'RecommendMission', 'ExitMissionPlanning', 'Task', 'Script'],
    },
  }
  const deployment = {
    ownerId: 'owner-1', machineId: 'machine-1', deploymentDigest: digest,
    allowedModelIds: ['model-root', 'model-worker', 'model-validator'], 
    allowedToolIds: ['Read', 'Execute', 'RecommendMission', 'ExitMissionPlanning', 'Task', 'Script',
      'SpawnAgent', 'SendMessage', 'ListAgents', 'InterruptAgent'],
    budgetUnit: 'credits', maxBudgetUnits: '1000', boundary,
  }
  const journal = {
    read: () => { journalReads++; return saved === null ? null : clone(saved) },
    async write(value) {
      if (config.journalFailure) throw new Error('disk unavailable')
      assert.equal(JSON.stringify(value).includes('ephemeral-extension-value'), false)
      saved = clone(value); writes.push(clone(value))
    },
    async initialized(binding) { resources.push(clone(binding)); if (config.revokeAfterInitialize) revoked = true },
  }
  const context = {
    ownerId: intent.ownerId, missionId: intent.missionId, machineId: intent.workspace.machineId,
    ...getNativeHashes(intent), epoch: config.epoch ?? 1, binding: null, commandId: intent.commandId,
    providerJournal: journal, guard() { if (revoked) throw new Error('context revoked') },
  }
  let interceptor, onOpen, onClose, fake
  const options = {
    deployment, transport, now: () => NOW,
    workspaceHost: {
      executionMachineId: 'machine-1', executionHostId: 'host-1', executionInstanceId: 'instance-1',
      checkoutGeneration: 'checkout-1', repositoryId: 'repo-1', deploymentDigest: digest,
      permittedRoots: ['/offline'], executionRef: 'refs/heads/main',
    },
    evidenceAuthority: workspaceEvidence?.authority ?? {},
    // Explicit fake proof ports: these tests do NOT qualify a real host/evidence boundary.
    policy: {
      compileNativePolicy,
      validateWorkspaceProof: config.actualWorkspaceProof ? validateWorkspaceProof : value => value,
      validateEnforcementLease: value => value,
    },
    safeExtensionTokenGetter: async () => { hostCalls.push('safeExtensionTokenGetter'); return 'ephemeral-extension-value' },
    onEnvelope: value => { assert.ok(saved); exposed.push(clone(value)); if (config.callbackFailure) throw new Error('callback failed') },
    onDiagnostic: value => diagnostics.push(value),
    onReadDiagnostics: value => readDiagnostics.push(value),
    journalForObservation: config.contextObservationJournal ? undefined : () => journal,
    resolveAdmissionWorkspace: config.resolveAdmissionWorkspace,
    maxReadPages: config.maxReadPages ?? 8,
    ...(config.missionRecordReader ? { missionRecordReader: config.missionRecordReader } : {}),
    ...(config.extraOptions ?? {}),
    createClient(guarded) {
      fake = {
        isConnected: () => guarded.isConnected(), getConnectionId: () => guarded.getConnectionId(),
        onMessage(handler) { assert.equal(interceptor, undefined); interceptor = handler },
        onConnectionOpen(handler) { onOpen = handler },
        onConnectionClose(handler) { onClose = handler }, onConnectionError() {},
        async initializeSession(params, settings) {
          assert.equal(settings.timeout, 30000)
          assert.equal(saved.initialize.state, 'invoked')
          if (config.beforeInitializeSend) await config.beforeInitializeSend()
          guarded.send(JSON.stringify(envelope('request', { id: 'sdk-generated-initialize-rpc', method: 'daemon.initialize_session', params })))
          if (config.lostInitialize) throw new Error('response lost')
          if (config.initializeError) throw config.initializeError
          if (config.malformedInitialize) return config.malformedInitialize
          const result = {
            sessionId: params.sessionId, session: { messages: [] },
            settings: {
              modelId: params.modelId, reasoningEffort: params.reasoningEffort,
              interactionMode: params.interactionMode, autonomyLevel: params.autonomyLevel,
              availableAutonomyLevels: ['off', 'high'], missionSettings: clone(params.missionSettings),
              restrictToolIds: clone(params.restrictToolIds),
            },
          }
          if (config.settingsMismatch) result.settings.missionSettings.skipScrutiny = true
          if (config.missingAutonomy) delete result.settings.availableAutonomyLevels
          if (config.noMissionSettingsEcho) delete result.settings.missionSettings
          if (config.partialMissionSettingsEcho) result.settings.missionSettings = { workerModel: params.missionSettings.workerModel }
          if (config.initTags) result.settings.tags = config.initTags(params)
          return result
        },
        async addUserMessage(params, requestId) {
          assert.equal(saved.goal.state, 'invoked'); assert.equal(resources.length, 1)
          assert.equal(saved.initialize.state, 'confirmed'); assert.deepEqual(saved.effectiveSettings, intent.settings)
          if (config.beforeGoalSend) await config.beforeGoalSend()
          guarded.send(JSON.stringify(envelope('request', { id: requestId, method: 'daemon.add_user_message', params })))
          if (config.lostGoal) throw new Error('response lost')
          return Object.hasOwn(config, 'goalResponse') ? config.goalResponse : {}
        },
        async inspectMissionReadiness(params) {
          guarded.send(JSON.stringify(envelope('request', { id: 'readiness-rpc', method: 'daemon.inspect_mission_readiness', params })))
          return { isGitRepo: true, hasRemote: true, remoteUrl: 'https://example.invalid/source', isEmpty: false }
        },
        async listAvailableSessions(params) {
          guarded.send(JSON.stringify(envelope('request', { id: 'available-rpc', method: 'daemon.list_available_sessions', params })))
          if (config.availablePage) return config.availablePage(params, saved)
          return { sessions: [{ sessionId: saved.rootSessionId, updatedAt: NOW / 1000, cwd: intent.workspace.cwd,
            mission: { state: 'planning', updatedAt: stamp } }], hasMore: false }
        },
        async getSessionMessages(params) {
          guarded.send(JSON.stringify(envelope('request', { id: 'messages-rpc', method: 'daemon.get_session_messages', params })))
          if (config.messagePage) return config.messagePage(params)
          return { messages: [message('history-1', 'Native history text.')], hasMore: false }
        },
        sendPermissionResponse(requestId, result) {
          assert.equal(saved.answerAttempts.at(-1).state, 'invoked')
          guarded.send(JSON.stringify(envelope('response', { id: requestId, result })))
        },
        sendAskUserResponse(requestId, result) {
          assert.equal(saved.answerAttempts.at(-1).state, 'invoked')
          guarded.send(JSON.stringify(envelope('response', { id: requestId, result })))
        },
      }
      return fake
    },
  }
  const provider = createInjectedNativeProvider(options)
  return {
    provider, intent, context, options, boundary, journal, calls, writes, resources, exposed, diagnostics, readDiagnostics, hostCalls, proofInputs,
    get saved() { return saved },
    get journalReads() { return journalReads },
    emit(frame) { interceptor(typeof frame === 'string' ? frame : JSON.stringify(frame)) },
    reconnect() { connectionId = 'connection-2'; onClose(1006, 'offline gap'); onOpen() },
    revoke() { revoked = true },
    async launch() { await provider.preflight(intent, context); return provider.launch(intent, context) },
    answerPayload(attention, extra) {
      return Object.fromEntries(['attentionId', 'requestId', 'sessionId', 'machineId', 'revision', 'payloadHash'].map(key => [key, attention[key]]).concat(Object.entries(extra)))
    },
  }
}

await test('actual daemon envelopes retain one-based indices and plain option values', () => {
  const result = decodeSdkEnvelope(questionnaire('root-1'), decodeContext)
  assert.deepEqual(result.attention.questions.map(row => row.index), [1, 3])
  assert.equal(result.attention.questions[0].options[1].value, 'second full value')
  assert.equal(result.attention.payloadHash, hash(result.raw))
  assert.equal(result.unsupportedReason, null)
})
await test('opaque encrypted reasoning blobs are dropped, while secrets in real text still fail closed', () => {
  const blob = 'AAAA' + 'sk-' + 'Z'.repeat(40) + 'AAAA'
  const frame = text => ({
    jsonrpc: '2.0', factoryApiVersion: '1.0.0', type: 'notification', method: 'daemon.session_notification',
    params: { sessionId: 'root-1', notification: { type: 'create_message', message: {
      id: 'msg-1', role: 'assistant', createdAt: 1, updatedAt: 1, openaiEncryptedContent: blob,
      content: [{ type: 'thinking', thinking: 'plan', signature: blob }, { type: 'text', text }],
    } } },
  })
  const result = decodeSdkEnvelope(frame('Done.'), decodeContext)
  assert.equal(result.kind, 'notification')
  const stored = JSON.stringify(result.envelope)
  assert.ok(!stored.includes('openaiEncryptedContent') && !stored.includes(blob))
  assert.equal(safeDecodeSdkEnvelope(frame(`key ${'sk-' + 'Q'.repeat(30)}`), decodeContext).kind, 'diagnostic')
})
await test('SDK multiselect stays a handoff, not invented JSON-array encoding', () => {
  const result = decodeSdkEnvelope(questionnaire('root-1', 'q-multi', true), decodeContext)
  assert.equal(result.attention.kind, 'unsupported')
  assert.equal(result.unsupportedReason, 'sdk_multiselect_encoding_unqualified')
})
await test('wrong dialect and zero-based SDK questions are ingestion failures', () => {
  const bad = questionnaire('root-1'); bad.params.questions[0].index = 0
  assert.equal(safeDecodeSdkEnvelope(bad, decodeContext).kind, 'diagnostic')
  bad.method = 'droid.ask_user'
  assert.equal(safeDecodeSdkEnvelope(bad, decodeContext).kind, 'diagnostic')
})
await test('mixed permission groups preserve full envelope and require handoff', () => {
  const frame = permission('root-1')
  frame.params.toolUses.push({ toolUse: { type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} },
    confirmationType: 'edit', details: { type: 'edit', filePath: '/x', fileName: 'x' } })
  const result = decodeSdkEnvelope(frame, decodeContext)
  assert.equal(result.attention.kind, 'unsupported')
  assert.deepEqual(result.envelope, frame)
})
await test('all native offered outcomes are preserved without enabling escalation', () => {
  const frame = permission('root-1')
  frame.params.options.push({ label: 'Auto high', value: 'proceed_auto_run_high' })
  assert.equal(decodeSdkEnvelope(frame, decodeContext).attention.options.at(-1).value, 'proceed_auto_run_high')
})
await test('native proposal and run-start fields are decoded without invented revision', () => {
  assert.equal(decodeSdkEnvelope(permission('root-1', 'proposal', { type: 'propose_mission', proposal: 'Exact plan' }), decodeContext).attention.kind, 'proposal')
  const start = permission('root-1', 'start', { type: 'start_mission_run', runningMissionCount: 2, runningMissionSessionIds: ['other-1', 'other-2'] })
  assert.equal(decodeSdkEnvelope(start, decodeContext).attention.kind, 'start')
})
await test('missing host boundary and missing journal reject before provider invocation', async () => {
  const f = fixture()
  assert.throws(() => createInjectedNativeProvider({ ...f.options, deployment: { ...f.options.deployment, boundary: null } }))
  await assert.rejects(f.provider.preflight(f.intent, { ...f.context, providerJournal: undefined }))
  assert.equal(f.calls.length, 0)
})
await test('canonical workspace mismatch rejects before any SDK call', async () => {
  const f = fixture({ wrongCwd: '/offline/other' })
  await assert.rejects(f.launch())
  assert.equal(f.calls.length, 0)
})
await test('prospective preflight never calls readiness a launch or effective setting proof', async () => {
  const f = fixture(), inspected = await f.provider.inspectAdmission(asDraft(f.intent), inspectionContext(f.context))
  assert.equal(inspected.launchEligible, false)
  assert.deepEqual(inspected.prospectiveSettings, f.intent.settings)
  const preflight = await f.provider.preflight(f.intent, f.context)
  assert.equal(preflight.settingsEvidence, 'prospective')
  assert.deepEqual(preflight.availableAutonomyLevels, [])
  assert.equal(f.calls.filter(row => row.method === 'daemon.initialize_session').length, 0)
})
await test('initialize and goal WAL substeps precede calls; effective settings precede goal', async () => {
  const f = fixture(), result = await f.launch()
  assert.equal(result.status, 'confirmed')
  assert.equal(f.saved.initialize.state, 'confirmed'); assert.equal(f.saved.goal.state, 'confirmed')
  assert.equal(f.saved.initialize.rpcId, null)
  assert.ok(f.saved.goal.rpcId.startsWith('goal-'))
  assert.equal(f.resources.length, 1)
  assert.deepEqual(validateProviderRecord(f.saved, f.context), f.saved)
  const params = f.calls.find(row => row.method === 'daemon.add_user_message').params
  assert.equal(JSON.parse(params.text).goal, f.intent.goal)
  assert.equal(f.provider.support.recoverAttention, false); assert.equal(f.provider.support.childAttention, false)
  assert.equal(f.provider.support.pause, false); assert.equal(f.provider.support.cancel, false)
  await assert.rejects(f.provider.launch(f.intent, f.context))
})
for (const config of [{ settingsMismatch: true }, { missingAutonomy: true }, { malformedInitialize: { sessionId: 'observed-positive-resource' } }]) {
  await test(`positive initialization resource survives settings/result mismatch ${JSON.stringify(config)}`, async () => {
    const f = fixture(config)
    await assert.rejects(f.launch())
    assert.equal(f.resources.length, 1)
    assert.equal(f.saved.initialize.state, 'unknown'); assert.equal(f.saved.goal.state, 'prepared')
    assert.equal(f.calls.filter(row => row.method === 'daemon.add_user_message').length, 0)
  })
}
await test('positive late-epoch initialized resource is tracked before revoked guard rejects', async () => {
  const f = fixture({ revokeAfterInitialize: true })
  await assert.rejects(f.launch())
  assert.equal(f.resources.length, 1); assert.equal(f.saved.goal.state, 'prepared')
})
await test('lost initialization is held and never retried', async () => {
  const f = fixture({ lostInitialize: true })
  await assert.rejects(f.launch())
  assert.equal(f.saved.initialize.state, 'unknown')
  await assert.rejects(f.provider.launch(f.intent, f.context))
  assert.equal(f.calls.filter(row => row.method === 'daemon.initialize_session').length, 1)
})
for (const config of [{ lostGoal: true }, { goalResponse: null }, { goalResponse: { bogus: true } }, { sendFailure: true }]) {
  await test(`lost/malformed goal receipt preserves initialized binding ${JSON.stringify(config)}`, async () => {
    const f = fixture(config)
    await assert.rejects(f.launch())
    assert.equal(f.saved.initialize.state, 'confirmed'); assert.equal(f.saved.goal.state, 'unknown')
    assert.equal(f.resources.length, 1); assert.ok(f.saved.binding)
  })
}
await test('journal failure causes zero execution-affecting sends', async () => {
  const f = fixture({ journalFailure: true })
  await assert.rejects(f.launch())
  assert.equal(f.calls.length, 0)
})
for (const config of [{ revokeDuringAuthorization: true }, { revokeAtSend: true }, { revokeInConsume: true }]) {
  await test(`final transport.send rechecks revocation ${JSON.stringify(config)}`, async () => {
    const f = fixture(config)
    await assert.rejects(f.launch())
    assert.equal(f.calls.filter(row => row.method === 'daemon.initialize_session').length, 0)
  })
}
await test('delayed SDK send cannot outlive context revocation', async () => {
  let f
  f = fixture({ beforeInitializeSend: async () => f.revoke() })
  await assert.rejects(f.launch())
  assert.equal(f.calls.filter(row => row.method === 'daemon.initialize_session').length, 0)
})
await test('pure actual-send permit binds method/session/hash and strips only initialization token', () => {
  const first = envelope('request', { id: 'rpc-1', method: 'daemon.initialize_session',
    params: { sessionId: 'root-1', machineId: 'machine-1', cwd: '/offline', token: 'one' } })
  const second = clone(first); second.params.token = 'two'
  assert.equal(outgoingDescriptor(first).requestHash, outgoingDescriptor(second).requestHash)
  const writes = []
  const transport = { ...fixture().options.transport, send: data => writes.push(data) }
  const boundary = { assertAndConsumePermit() {} }
  const gate = createGuardedDaemonTransport(transport, { boundary, now: () => NOW })
  const desc = outgoingDescriptor(first)
  const permit = { permitId: 'permit-1', leaseId: 'lease-1', connectionId: 'connection-1',
    ...desc, expiresAt: expiry, revocationGeneration: 0 }
  gate.arm(permit, () => {})
  const wrong = clone(first); wrong.params.cwd = '/wrong'
  assert.throws(() => gate.transport.send(JSON.stringify(wrong)))
  assert.equal(writes.length, 0)
  assert.throws(() => gate.arm(permit, () => {}))
  assert.throws(() => gate.transport.send(JSON.stringify(envelope('request', { id: 'bad', method: 'daemon.load_session', params: {} }))))
})
await test('request interception persists exact envelope before exposing owner action', async () => {
  const f = fixture(); await f.launch()
  const frame = permission(f.saved.rootSessionId)
  f.emit(frame); await f.provider.flush()
  assert.equal(f.saved.requests.length, 1)
  // The params copy is not persisted a second time; the envelope is the stored proof.
  assert.equal(Object.hasOwn(f.saved.requests[0], 'raw'), false)
  assert.deepEqual(requestPayload(f.saved.requests[0]), frame.params)
  assert.equal(f.exposed.at(-1).kind, 'request')
  assert.equal(f.saved.requests[0].attention.payloadHash, hash(frame.params))
})
await test('permission send void stays unknown until exact native effect; attribution remains unknown', async () => {
  const f = fixture(); await f.launch(); f.emit(permission(f.saved.rootSessionId)); await f.provider.flush()
  const a = f.saved.requests[0].attention
  const result = await f.provider.answer(f.answerPayload(a, { selectedOption: 'proceed_once' }), { ...f.context, commandId: 'answer-1' })
  assert.equal(result.status, 'sent'); assert.equal(f.saved.requests[0].attention.state, 'answer_unknown')
  assert.equal(f.saved.answerAttempts[0].state, 'sent')
  f.emit(notification(a.sessionId, { type: 'permission_resolved', requestId: a.requestId,
    toolUseIds: a.toolUseIds, selectedOption: 'proceed_once' }))
  await f.provider.flush()
  assert.equal(f.saved.requests[0].attention.state, 'resolved')
  assert.equal(f.saved.resolutions[0].effect.attribution, 'unknown_or_external')
  assert.equal(Object.hasOwn(f.saved.resolutions[0], 'receiptId'), false)
})
await test('external permission resolution closes request without inventing broker answer delivery', async () => {
  const f = fixture(); await f.launch(); f.emit(permission(f.saved.rootSessionId)); await f.provider.flush()
  const a = f.saved.requests[0].attention
  f.emit(notification(a.sessionId, { type: 'permission_resolved', requestId: a.requestId,
    toolUseIds: a.toolUseIds, selectedOption: 'cancel' }))
  await f.provider.flush()
  assert.equal(f.saved.requests[0].attention.state, 'resolved')
  assert.equal(f.saved.answerAttempts.length, 0)
})
await test('wrong owner/tool resolution cannot close native permission', async () => {
  const request = decodeSdkEnvelope(permission('root-1'), decodeContext)
  const wrong = notification('other-1', { type: 'permission_resolved', requestId: 'permission-1',
    toolUseIds: request.attention.toolUseIds, selectedOption: 'proceed_once' })
  assert.equal(correlateNativeResolution(request, wrong), null)
  wrong.params.sessionId = 'root-1'; wrong.params.notification.toolUseIds = ['wrong-tool']
  assert.equal(correlateNativeResolution(request, wrong), null)
})
await test('AskUser sends canonical strings with exact indices; termination is not answer acceptance', async () => {
  const f = fixture(); await f.launch(); f.emit(questionnaire(f.saved.rootSessionId)); await f.provider.flush()
  const a = f.saved.requests[0].attention
  await assert.rejects(f.provider.answer(f.answerPayload(a, { answers: [{ index: 0, answer: 'x' }] }), { ...f.context, commandId: 'bad-answer' }))
  await f.provider.answer(f.answerPayload(a, { answers: [{ index: 1, answer: 'second full value' }, { index: 3, answer: 'Canonical custom answer.' }] }),
    { ...f.context, commandId: 'ask-answer' })
  const send = f.calls.find(row => row.type === 'response')
  assert.equal(send.result.answers[1].question, 'Explain?')
  assert.equal(send.result.answers[1].index, 3)
  f.emit(notification(a.sessionId, { type: 'tool_result', messageId: 'tool-message', toolUseId: a.toolUseIds[0], content: 'Tool finished' }))
  await f.provider.flush()
  assert.equal(f.saved.requests[0].attention.state, 'answer_unknown')
  assert.equal(f.saved.resolutions[0].effect.answerAcceptance, 'unknown')
})
await test('root/child membership is retained without promising child answer propagation', async () => {
  const f = fixture(); await f.launch()
  f.emit(permission('unowned-session', 'ignored-request')); await f.provider.flush()
  assert.equal(f.saved.requests.length, 0)
  f.emit(notification(f.saved.rootSessionId, { type: 'mission_worker_started', workerSessionId: 'worker-1' }))
  f.emit(permission('worker-1', 'worker-permission')); await f.provider.flush()
  assert.equal(f.saved.requests.length, 1)
  assert.equal(f.saved.requests[0].unsupportedReason, 'sdk_child_attention_unqualified')
  await assert.rejects(f.provider.answer(f.answerPayload(f.saved.requests[0].attention, { selectedOption: 'proceed_once' }), f.context))
})
await test('mixed/multiselect requests are handoff and cannot send invented questionnaire arrays', async () => {
  const f = fixture(); await f.launch()
  f.emit(questionnaire(f.saved.rootSessionId, 'multi', true)); await f.provider.flush()
  await assert.rejects(f.provider.answer(f.answerPayload(f.saved.requests[0].attention, { answers: [{ index: 1, answer: '["a","b"]' }] }), f.context))
  assert.equal(f.calls.filter(row => row.type === 'response').length, 0)
})
await test('inactive SDK request rejects without load/controller/replay', async () => {
  const f = fixture(); await f.launch(); f.emit(permission(f.saved.rootSessionId)); await f.provider.flush()
  f.emit(notification(f.saved.rootSessionId, { type: 'session_inactivity', timestamp: NOW, timeoutSeconds: 60, message: 'Inactive' }))
  await f.provider.flush()
  await assert.rejects(f.provider.answer(f.answerPayload(f.saved.requests[0].attention, { selectedOption: 'proceed_once' }), f.context))
  assert.equal(f.calls.some(row => row.method?.includes('load')), false)
})
await test('malformed or secret request never throws into SDK engine and fences ingestion', async () => {
  const f = fixture(); await f.launch()
  assert.doesNotThrow(() => f.emit('{bad json')); await f.provider.flush()
  assert.equal(f.provider.isFenced(), true)
  assert.equal(f.saved.ingestionFault, 'sdk_ingestion_invalid')
  const bad = permission('root-1'); bad.params.apiKey = 'secret material'
  assert.equal(safeDecodeSdkEnvelope(bad, decodeContext).kind, 'diagnostic')
})
await test('callback failure fences without throwing out of synchronous interception', async () => {
  const f = fixture({ callbackFailure: true }); await f.launch()
  assert.doesNotThrow(() => f.emit(permission(f.saved.rootSessionId)))
  await f.provider.flush(); await f.provider.flush()
  assert.equal(f.provider.isFenced(), true)
})
await test('native feature/progress notification arrays replace rather than append', async () => {
  const f = fixture(); await f.launch()
  f.emit(notification(f.saved.rootSessionId, { type: 'mission_progress_entry', progressLog: [{ type: 'mission_accepted', timestamp: stamp, title: 'One' }] }))
  f.emit(notification(f.saved.rootSessionId, { type: 'mission_progress_entry', progressLog: [{ type: 'mission_accepted', timestamp: stamp, title: 'Two' }] }))
  await f.provider.flush()
  assert.equal(f.saved.observations.progress.envelope.params.notification.progressLog.length, 1)
  assert.equal(f.saved.observations.progress.envelope.params.notification.progressLog[0].title, 'Two')
})
await test('passive paginated reads expose only fresh sections, never complete pending/settings/workers', async () => {
  const f = fixture({
    availablePage: (params, saved) => params.endBefore ? { sessions: [{ sessionId: saved.rootSessionId, updatedAt: NOW / 1000,
      mission: { state: 'running', updatedAt: stamp } }], hasMore: false } :
      { sessions: [{ sessionId: 'unrelated-1', updatedAt: NOW / 1000 }], hasMore: true, nextCursor: 12 },
    messagePage: params => params.cursor ? { messages: [message('old', 'Older owner text', 'user')], hasMore: false } :
      { messages: [message('new', 'Newer native text')], hasMore: true, nextCursor: 'older' },
  })
  const launched = await f.launch(), observed = await f.provider.observe(launched.binding, { ...f.context, readOnly: true })
  assert.equal(observed.state, 'running')
  assert.deepEqual(observed.presentSections, ['mission', 'history'])
  assert.equal(observed.pendingComplete, false); assert.equal(observed.completeness, 'gap')
  assert.deepEqual(observed.effectiveSettings, {}); assert.equal(observed.history.length, 2)
  assert.equal(f.calls.some(row => row.method === 'daemon.load_session'), false)
})
await test('repeated cursors stop bounded reads and history freshness is not invented', async () => {
  const f = fixture({ maxReadPages: 3, messagePage: () => ({ messages: [message('one', 'Partial')], hasMore: true, nextCursor: 'repeat' }) })
  const launched = await f.launch(), observed = await f.provider.observe(launched.binding, { ...f.context, readOnly: true })
  assert.equal(observed.presentSections.includes('history'), false)
  assert.deepEqual(observed.history, [])
  assert.equal(f.readDiagnostics.at(-1).historyHold, 'sdk_history_pagination_incomplete')
  assert.equal(f.calls.filter(row => row.method === 'daemon.get_session_messages').length, 2)
})
await test('restart reads prior registry but never replays invoked/confirmed native work', async () => {
  const before = fixture(), launched = await before.launch()
  const after = fixture({ saved: before.saved, epoch: 2 })
  await assert.rejects(after.provider.preflight(after.intent, after.context))
  assert.equal(after.calls.length, 0)
  const observation = await after.provider.observe(launched.binding, { ...after.context, readOnly: true })
  assert.equal(observation.pendingComplete, false)
  assert.equal(after.calls.every(row => ['daemon.list_available_sessions', 'daemon.get_session_messages'].includes(row.method)), true)
  await assert.rejects(after.provider.launch(after.intent, after.context))
})
await test('reconnect invalidates old RPC ids, preserving read-only handoff without auto-load', async () => {
  const f = fixture(), launched = await f.launch()
  f.emit(permission(f.saved.rootSessionId)); await f.provider.flush(); f.reconnect(); await f.provider.flush()
  await assert.rejects(f.provider.answer(f.answerPayload(f.saved.requests[0].attention, { selectedOption: 'proceed_once' }), f.context))
  assert.equal(f.provider.isFenced(), true)
  await f.provider.observe(launched.binding, { ...f.context, readOnly: true })
  assert.equal(f.calls.some(row => row.method === 'daemon.load_session'), false)
})
await test('nested registry corruption, hash drift, orphan closure and wrong anchors are rejected', async () => {
  const f = fixture(); await f.launch(); f.emit(permission(f.saved.rootSessionId)); await f.provider.flush()
  for (const mutate of [
    row => { row.ownerId = 'other-owner' },
    row => { row.goal.requestHash = 'c'.repeat(64) },
    row => { row.requests[0].envelope.params.options[0].value = 'cancel' },
    row => { row.requests[0].attention.state = 'resolved'; row.requests[0].attention.resolvedAt = stamp },
    row => { row.workspaceProof.rootIdentity.inode = 12 },
    row => { row.answerAttempts.push({ commandId: 'bad' }) },
  ]) {
    const bad = clone(f.saved); mutate(bad)
    assert.throws(() => validateProviderRecord(bad, f.context))
  }
})

await test('read-only admission without a budget compiles (no cap) but stays held without host qualification', async () => {
  const f = fixture(), draft = asDraft(f.intent)
  delete draft.policy.budget
  const inspected = await f.provider.inspectAdmission(draft, inspectionContext(f.context))
  admissionPreview(inspected, draft)
  assert.equal(inspected.launchEligible, false)
  assert.ok(!inspected.holds.includes('native_budget_boundary_required'))
  assert.ok(inspected.holds.includes('native_enforcement_lease_unavailable'))
  assert.ok(inspected.holds.includes('live_sdk_qualification'))
  assert.equal(f.calls.length, 0)
  assert.equal(f.writes.length, 0)
  await assert.rejects(f.provider.inspectAdmission(draft, { ...inspectionContext(f.context), ownerId: 'other' }))
})
await test('a verified host qualification lifts only the live-qualification and lease holds', async () => {
  const signer = generateKeyPairSync('ed25519'), hostKey = generateKeyPairSync('ed25519')
  const at = new Date(NOW - 60000).toISOString()
  const manifest = {
    version: 1, kind: 'host_qualification', qualificationId: 'qual-1', machineId: 'machine-1', deploymentDigest: digest,
    hostPublicKeySha256: createHash('sha256').update(hostKey.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
    droidVersion: '1.0.0', issuedAt: at, expiresAt: new Date(NOW + 3600000).toISOString(),
    checks: ['containment_probes', 'mission_delivery', 'revocation'].map(name => ({ name, passed: true, evidenceSha256: 'c'.repeat(64), verifiedAt: at })),
  }
  const envelope = { manifest, signature: sign(null, Buffer.from(canonical(manifest)), signer.privateKey).toString('base64') }
  const record = verifyHostQualification(envelope, { publicKey: signer.publicKey, deploymentDigest: digest, hostPublicKey: hostKey.publicKey, machineId: 'machine-1', now: NOW })
  const holdsWith = async extraOptions => {
    const f = fixture({ extraOptions }), draft = asDraft(f.intent)
    delete draft.policy.budget
    return (await f.provider.inspectAdmission(draft, inspectionContext(f.context))).holds
  }
  const lifted = await holdsWith({ hostQualification: record, hostPublicKey: hostKey.publicKey })
  assert.ok(!lifted.includes('live_sdk_qualification'))
  assert.ok(!lifted.includes('native_enforcement_lease_unavailable'))
  const wrongHost = await holdsWith({ hostQualification: record, hostPublicKey: generateKeyPairSync('ed25519').publicKey })
  assert.ok(wrongHost.includes('live_sdk_qualification'))
  const forged = await holdsWith({ hostQualification: { ...record }, hostPublicKey: hostKey.publicKey })
  assert.ok(forged.includes('native_enforcement_lease_unavailable'))
  assert.throws(() => verifyHostQualification({ ...envelope, signature: Buffer.alloc(64).toString('base64') },
    { publicKey: signer.publicKey, deploymentDigest: digest, hostPublicKey: hostKey.publicKey, machineId: 'machine-1', now: NOW }))
})
await test('a resolved repeated RPC does not re-expose an optimistic open attention', async () => {
  const f = fixture(); await f.launch()
  const frame = permission(f.saved.rootSessionId)
  f.emit(frame); await f.provider.flush()
  const a = f.saved.requests[0].attention
  f.emit(notification(a.sessionId, { type: 'permission_resolved', requestId: a.requestId,
    toolUseIds: a.toolUseIds, selectedOption: 'cancel' }))
  await f.provider.flush()
  const before = f.exposed.length
  f.emit(frame); await f.provider.flush()
  assert.equal(f.exposed.length, before)
  assert.equal(f.saved.requests[0].attention.state, 'resolved')
})
await test('changed payload under the same RPC identity fences instead of replacing a grant', async () => {
  const f = fixture(); await f.launch()
  const frame = permission(f.saved.rootSessionId)
  f.emit(frame); await f.provider.flush()
  frame.params.toolUses[0].details.fullCommand = 'different exact command'
  f.emit(frame); await f.provider.flush()
  assert.equal(f.provider.isFenced(), true)
  assert.equal(f.saved.ingestionFault, 'sdk_request_identity_conflict')
})
await test('single-select SDK answers reject array encodings and stale payload hashes', async () => {
  const f = fixture(); await f.launch(); f.emit(questionnaire(f.saved.rootSessionId)); await f.provider.flush()
  const a = f.saved.requests[0].attention
  await assert.rejects(f.provider.answer(f.answerPayload(a, {
    answers: [{ index: 1, answer: ['a', 'b'] }, { index: 3, answer: 'x' }],
  }), f.context))
  const bad = f.answerPayload(a, { answers: [{ index: 1, answer: 'a' }, { index: 3, answer: 'x' }] })
  bad.payloadHash = 'f'.repeat(64)
  await assert.rejects(f.provider.answer(bad, f.context))
  assert.equal(f.calls.filter(row => row.type === 'response').length, 0)
})
await test('malformed passive Mission metadata is not fresh authoritative state', async () => {
  const f = fixture({ availablePage: (_params, saved) => ({
    sessions: [{ sessionId: saved.rootSessionId, mission: { state: 'cancelled' } }], hasMore: false,
  }) })
  const launched = await f.launch()
  await assert.rejects(f.provider.observe(launched.binding, { ...f.context, readOnly: true }))
})
await test('malformed nested history responses reject before projection', async () => {
  const f = fixture({ messagePage: () => ({ messages: [{ ...message('broken', 'x'), content: [{ type: 'tool_result', toolUseId: 9 }] }], hasMore: false }) })
  const launched = await f.launch()
  await assert.rejects(f.provider.observe(launched.binding, { ...f.context, readOnly: true }))
})
await test('finite read and timeout limits are not fixture-controlled admission flags', () => {
  const f = fixture()
  assert.throws(() => createInjectedNativeProvider({ ...f.options, maxReadPages: 1000000 }))
  assert.throws(() => createInjectedNativeProvider({ ...f.options, requestTimeoutMs: 1000000 }))
})
await test('concurrent execution effects cannot obtain a second SDK invocation', async () => {
  let release
  const paused = new Promise(resolve => { release = resolve })
  const f = fixture({ beforeInitializeSend: () => paused })
  await f.provider.preflight(f.intent, f.context)
  const first = f.provider.launch(f.intent, f.context)
  await assert.rejects(f.provider.launch(f.intent, f.context))
  release(); await first
  assert.equal(f.calls.filter(row => row.method === 'daemon.initialize_session').length, 1)
})
await test('late positive initialized resource is retained after SDK timeout without launch replay', async () => {
  const f = fixture({ lostInitialize: true })
  await assert.rejects(f.launch())
  f.emit(envelope('response', { id: 'sdk-generated-initialize-rpc', result: {
    sessionId: f.saved.rootSessionId, session: { messages: [] }, settings: {},
    mcpServers: [{ clientSecret: 'private value must not enter journal or callbacks' }],
  } }))
  await f.provider.flush()
  assert.equal(f.resources.length, 1)
  assert.ok(f.saved.binding)
  assert.equal(f.saved.initialize.state, 'unknown')
  assert.equal(f.saved.goal.state, 'prepared')
  assert.equal(JSON.stringify(f.saved).includes('private value'), false)
  assert.equal(JSON.stringify(f.exposed).includes('private value'), false)
  await assert.rejects(f.provider.launch(f.intent, f.context))
})
await test('native settings drift fences future responses without a corrective SDK update', async () => {
  const f = fixture(); await f.launch()
  f.emit(notification(f.saved.rootSessionId, { type: 'settings_updated', settings: { missionSettings: { skipScrutiny: true } } }))
  await f.provider.flush()
  assert.equal(f.provider.isFenced(), true)
  assert.equal(f.saved.ingestionFault, 'sdk_effective_settings_changed')
  assert.equal(f.calls.some(row => row.method === 'daemon.update_session_settings'), false)
})
await test('matching partial settings event never refreshes complete effective-settings authority', async () => {
  const f = fixture(), launched = await f.launch()
  f.emit(notification(f.saved.rootSessionId, { type: 'settings_updated', settings: { modelId: f.intent.settings.modelId } }))
  await f.provider.flush()
  assert.equal(f.provider.isFenced(), false)
  const observed = await f.provider.observe(launched.binding, { ...f.context, readOnly: true })
  assert.equal(observed.presentSections.includes('settings'), false)
})
await test('partial mission settings echo treats omitted fields as unknown, not mismatched or proven', async () => {
  const f = fixture({ partialMissionSettingsEcho: true }), launched = await f.launch()
  assert.deepEqual(launched.unconfirmedSettings, [
    'workerReasoningEffort', 'validationWorkerModel', 'validationWorkerReasoningEffort', 'skipScrutiny', 'skipUserTesting',
  ])
  assert.deepEqual(validateProviderRecord(f.saved, { ...bind(f.saved), binding: f.saved.binding }), f.saved)
})
await test('owned child settings drift fences without guessing worker/validator role or mutating settings', async () => {
  const f = fixture(); await f.launch()
  f.emit(notification(f.saved.rootSessionId, { type: 'child_session_available', childSessionId: 'worker-1', timestamp: NOW }))
  f.emit(notification('worker-1', { type: 'settings_updated', settings: { modelId: 'model-root' } }))
  await f.provider.flush()
  assert.equal(f.saved.ingestionFault, 'sdk_effective_child_settings_changed')
  assert.equal(f.provider.isFenced(), true)
  assert.equal(f.calls.some(row => row.method === 'daemon.update_session_settings'), false)
})

await test('daemon 0.227 omits missionSettings: launch records them as unconfirmed, never as proof', async () => {
  const f = fixture({ noMissionSettingsEcho: true }), launched = await f.launch()
  const keys = ['workerModel', 'workerReasoningEffort', 'validationWorkerModel', 'validationWorkerReasoningEffort', 'skipScrutiny', 'skipUserTesting']
  assert.deepEqual(launched.unconfirmedSettings, keys)
  assert.deepEqual(f.saved.settingsUnconfirmed, keys)
  assert.equal(f.saved.initialize.state, 'confirmed'); assert.equal(f.saved.goal.state, 'confirmed')
  assert.deepEqual(validateProviderRecord(f.saved, { ...bind(f.saved), binding: f.saved.binding }), f.saved)
  // The unconfirmed list is bound into the initialize receipt.
  const stripped = clone(f.saved); delete stripped.settingsUnconfirmed
  assert.throws(() => validateProviderRecord(stripped, bind(stripped)), { code: 'sdk_provider_initialize_receipt_corrupt' })
  for (const bad of [[], ['modelId'], ['skipScrutiny', 'skipScrutiny']]) {
    assert.throws(() => validateProviderRecord({ ...clone(f.saved), settingsUnconfirmed: bad }, bind(f.saved)))
  }
  const echoed = fixture(); const confirmed = await echoed.launch()
  assert.equal(Object.hasOwn(confirmed, 'unconfirmedSettings'), false)
  assert.equal(Object.hasOwn(echoed.saved, 'settingsUnconfirmed'), false)
})
await test('owned root session id is UUID-shaped and fits the 64-character prompt-cache key cap', async () => {
  const f = fixture(); await f.launch()
  assert.match(f.saved.rootSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.ok(f.saved.rootSessionId.length <= 64)
  const forged = { ...clone(f.saved), rootSessionId: `sprite-${'a'.repeat(64)}` }
  assert.throws(() => validateProviderRecord(forged, bind(forged)))
})
await test('a present but different missionSettings echo is still a settings mismatch', async () => {
  const f = fixture({ settingsMismatch: true })
  await assert.rejects(f.launch(), { code: 'sdk_initialize_outcome_unknown' })
  assert.equal(f.saved.initialize.state, 'unknown'); assert.equal(f.saved.goal.state, 'prepared')
})
await test('deprecated autonomyMode alias is accepted only as auto-high', async () => {
  const f = fixture({ noMissionSettingsEcho: true }); await f.launch()
  f.emit(notification(f.saved.rootSessionId, { type: 'settings_updated', settings: {
    autonomyMode: 'auto-high', interactionMode: 'mission', autonomyLevel: 'high', tags: [{ name: 'mission-v2' }] } }))
  await f.provider.flush()
  assert.equal(f.provider.isFenced(), false)
  for (const mode of ['auto-low', 'auto-medium', 'normal', 'spec']) {
    const g = fixture(); await g.launch()
    g.emit(notification(g.saved.rootSessionId, { type: 'settings_updated', settings: { autonomyMode: mode } }))
    await g.provider.flush()
    assert.equal(g.saved.ingestionFault, 'sdk_effective_settings_changed')
  }
})
await test('admission always holds on unconfirmable mission settings', async () => {
  const f = fixture({ actualWorkspaceProof: true })
  const preview = await f.provider.inspectAdmission(asDraft(f.intent), inspectionContext(f.context))
  assert.equal(preview.launchEligible, false)
  assert.ok(preview.holds.includes('sdk_mission_settings_unconfirmed'))
})

await test('admission is the real contract with exact nine prospective settings and no effects', async () => {
  const f = fixture({ actualWorkspaceProof: true }), draft = asDraft(f.intent), before = clone(draft)
  const preview = await f.provider.inspectAdmission(draft, inspectionContext(f.context))
  assert.deepEqual(admissionPreview(preview, draft), preview)
  assert.equal(preview.draftHash, hash(before))
  assert.deepEqual(preview.workspace, draft.workspace)
  assert.deepEqual(preview.prospectiveSettings, draft.settings)
  assert.equal(Object.keys(preview.prospectiveSettings).length, 9)
  assert.equal(preview.launchEligible, false)
  for (const hold of ['native_child_attention', 'passive_authoritative_pending_recovery', 'live_sdk_qualification',
    'native_enforcement_lease_unavailable', 'sdk_high_autonomy_unobserved']) assert.ok(preview.holds.includes(hold))
  assert.ok(Date.parse(preview.expiresAt) - Date.parse(preview.observedAt) <= 60000)
  assert.deepEqual(draft, before)
  assert.equal(Object.hasOwn(draft, 'scopeApproved'), false)
  assert.equal(Object.hasOwn(draft, 'highAutonomyApproved'), false)
  assert.ok(Object.isFrozen(preview.workspace)); assert.ok(Object.isFrozen(preview.prospectiveSettings.restrictToolIds))
  assert.deepEqual(f.hostCalls, ['verifyWorkspace'])
  assert.equal(f.calls.length, 0); assert.equal(f.journalReads, 0); assert.equal(f.writes.length, 0)
  assert.equal(f.resources.length, 0); assert.equal(f.provider.providerRecord(), null)
})
await test('admission proof uses fresh nonces and expires no later than verified physical proof', async () => {
  const f = fixture({ actualWorkspaceProof: true, mutateProof: proof => { proof.expiresAt = new Date(NOW + 15000).toISOString() } })
  const one = await f.provider.inspectAdmission(asDraft(f.intent), inspectionContext(f.context))
  const two = await f.provider.inspectAdmission(asDraft(f.intent), inspectionContext(f.context))
  assert.notEqual(f.proofInputs[0].nonce, f.proofInputs[1].nonce)
  assert.equal(one.expiresAt, new Date(NOW + 15000).toISOString())
  assert.equal(two.expiresAt, one.expiresAt)
})
await test('missing immutable base fails explicitly without a trusted resolver', async () => {
  const f = fixture(), draft = asDraft(f.intent)
  delete draft.workspace.baseSha
  await assert.rejects(f.provider.inspectAdmission(draft, inspectionContext(f.context)), { code: 'immutable_base_required' })
  assert.equal(f.hostCalls.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.journalReads, 0)
})
await test('trusted base resolution binds proof to resolved intent but hashes the original draft', async () => {
  let resolverCalls = 0
  const f = fixture({ actualWorkspaceProof: true, resolveAdmissionWorkspace: async (draft, context) => {
    resolverCalls++
    assert.equal(context.readOnly, true); assert.ok(Object.isFrozen(draft)); assert.ok(Object.isFrozen(context))
    assert.equal(Object.hasOwn(draft, 'scopeApproved'), false)
    return { ...draft.workspace, baseSha: base }
  } })
  const draft = asDraft(f.intent); delete draft.workspace.baseSha
  const before = clone(draft), preview = await f.provider.inspectAdmission(draft, inspectionContext(f.context))
  admissionPreview(preview, draft)
  assert.equal(preview.draftHash, hash(before)); assert.equal(preview.workspace.baseSha, base)
  assert.deepEqual(draft, before); assert.equal(resolverCalls, 1)
  const resolvedIntent = { ...draft, workspace: preview.workspace, scopeApproved: true, highAutonomyApproved: true }
  const hashes = getNativeHashes(resolvedIntent)
  assert.equal(f.proofInputs[0].scopeHash, hashes.scopeHash); assert.equal(f.proofInputs[0].policyHash, hashes.policyHash)
  assert.notEqual(hashes.scopeHash, getNativeHashes({ ...resolvedIntent, workspace: draft.workspace }).scopeHash)
  assert.deepEqual(f.hostCalls, ['verifyWorkspace']); assert.equal(f.writes.length, 0); assert.equal(f.calls.length, 0)
})
await test('a supplied immutable base never invokes even an installed resolver', async () => {
  const f = fixture({ resolveAdmissionWorkspace: async () => { throw new Error('must not resolve a supplied base') } })
  await f.provider.inspectAdmission(asDraft(f.intent), inspectionContext(f.context))
  assert.deepEqual(f.hostCalls, ['verifyWorkspace'])
})
await test('resolver cannot redirect a workspace or return a mutable/invalid base', async () => {
  for (const resolved of [
    workspace => ({ ...workspace, baseSha: base, cwd: '/offline/elsewhere' }),
    workspace => ({ ...workspace, baseSha: 'refs/heads/main' }),
    workspace => ({ ...workspace }),
    workspace => ({ ...workspace, baseSha: base, run: 'arbitrary command' }),
  ]) {
    const f = fixture({ resolveAdmissionWorkspace: async draft => resolved(draft.workspace) }), draft = asDraft(f.intent)
    delete draft.workspace.baseSha
    await assert.rejects(f.provider.inspectAdmission(draft, inspectionContext(f.context)))
    assert.equal(f.hostCalls.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0)
  }
})
await test('unrepresentable restrictions and unavailable genuine budget remain holds, not approval', async () => {
  for (const alter of [
    draft => { draft.restrictions.push('Never exceed arbitrary invented API accounting units') },
    draft => { draft.policy.budget.capUnits = '1001' },
  ]) {
    const f = fixture({ actualWorkspaceProof: true }), draft = asDraft(f.intent); alter(draft)
    const preview = await f.provider.inspectAdmission(draft, inspectionContext(f.context))
    admissionPreview(preview, draft)
    assert.equal(preview.launchEligible, false)
    assert.ok(preview.holds.some(code => ['native_unrepresented_restriction', 'native_budget_exceeds_deployment'].includes(code)))
    assert.deepEqual(f.hostCalls, ['verifyWorkspace']); assert.equal(f.writes.length, 0); assert.equal(f.calls.length, 0)
  }
})
await test('invalid or unsafe prospective settings fail even behind an earlier policy hold', async () => {
  for (const alter of [
    draft => { draft.settings.skipScrutiny = true },
    draft => { delete draft.settings.validationWorkerModel },
    draft => { draft.settings.reasoningEffort = 'unsupported' },
    draft => { draft.settings.modelId = 'unpermitted' },
    draft => { draft.settings.restrictToolIds = [] },
    draft => { draft.settings.enabledToolIds = ['Execute'] },
    draft => { draft.settings.disableAllSafety = true },
  ]) {
    const f = fixture(), draft = asDraft(f.intent); delete draft.policy.budget; alter(draft)
    await assert.rejects(f.provider.inspectAdmission(draft, inspectionContext(f.context)))
    assert.equal(f.hostCalls.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.journalReads, 0)
  }
})
await test('admission rejects consent fields, hidden resolver/control claims and wrong read-only identity', async () => {
  const f = fixture(), context = inspectionContext(f.context)
  for (const extra of [{ scopeApproved: true }, { highAutonomyApproved: false },
    { resolveAdmissionWorkspace: 'client-controlled' }, { pause: true }, { loadSession: 'untrusted-session' }]) {
    await assert.rejects(f.provider.inspectAdmission({ ...asDraft(f.intent), ...extra }, context))
  }
  for (const extra of [{ readOnly: false }, { ownerId: 'other' }, { missionId: 'other' },
    { machineId: 'other' }, { epoch: 0 }]) {
    await assert.rejects(f.provider.inspectAdmission(asDraft(f.intent), { ...context, ...extra }))
  }
  assert.equal(f.hostCalls.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0)
})
for (const config of [
  { forgedEvidence: true },
  { mutateProof: proof => { proof.expiresAt = stamp } },
  { mutateProof: proof => { proof.nonce = 'replayed-nonce' } },
  { mutateProof: proof => { proof.binding.scopeHash = 'c'.repeat(64) } },
]) {
  await test(`admission rejects forged/stale/replayed physical evidence ${Object.keys(config)[0]}`, async () => {
    const f = fixture({ actualWorkspaceProof: true, ...config })
    await assert.rejects(f.provider.inspectAdmission(asDraft(f.intent), inspectionContext(f.context)))
    assert.deepEqual(f.hostCalls, ['verifyWorkspace'])
    assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.provider.providerRecord(), null)
  })
}
await test('provider exposes the actual strict journal validator, not a no-op port', async () => {
  const f = fixture(); await f.launch()
  assert.equal(f.provider.validateProviderRecord, validateProviderRecord)
  assert.deepEqual(f.provider.validateProviderRecord(f.saved, f.context), f.saved)
  const bad = clone(f.saved); bad.goal.requestHash = 'c'.repeat(64)
  assert.throws(() => f.provider.validateProviderRecord(bad, f.context))
})
await test('passive restart observation falls back to the parent context journal without lease or replay', async () => {
  const before = fixture(), launched = await before.launch()
  const after = fixture({ saved: before.saved, epoch: 2, contextObservationJournal: true })
  const observed = await after.provider.observe(launched.binding, { ...after.context, readOnly: true })
  assert.equal(observed.pendingComplete, false); assert.equal(after.provider.isFenced(), true)
  assert.equal(after.journalReads, 1); assert.equal(after.writes.length, 0); assert.equal(after.resources.length, 0)
  assert.equal(after.hostCalls.length, 0)
  assert.deepEqual(after.calls.map(frame => frame.method), ['daemon.list_available_sessions', 'daemon.get_session_messages'])
})
await test('a read-page limit gap discards rows rather than projecting clipped history', async () => {
  const f = fixture({ maxReadPages: 1, messagePage: () => ({ messages: [message('one', 'Partial')], hasMore: true, nextCursor: 'older' }) })
  const launched = await f.launch(), observed = await f.provider.observe(launched.binding, { ...f.context, readOnly: true })
  assert.deepEqual(observed.history, []); assert.equal(observed.presentSections.includes('history'), false)
  assert.equal(f.readDiagnostics.at(-1).messagesComplete, false)
  assert.equal(f.readDiagnostics.at(-1).historyHold, 'sdk_history_pagination_incomplete')
})


// ---- Factory Mission v2 (droid 0.227.0 shapes; canary record fixture ac657282) ----
const V2_FIXTURE = new URL('./fixtures/mission-v2/ac657282/', import.meta.url)
const v2Approval = JSON.parse(await readFile(new URL('approval-checks.json', V2_FIXTURE), 'utf8'))
const v2Snapshots = JSON.parse(await readFile(new URL('snapshots.json', V2_FIXTURE), 'utf8'))
const V2_CHECK_IDS = v2Approval.checks.map(check => check.id)
const v2Recommend = { type: 'recommend_mission', reason: 'This spans code, tests and a commit; plan it as a Mission.' }
// The approved plan text is the canary's mission.md verbatim: droid writes the
// approved missionPlan there, so sha256(missionPlan) must equal the snapshot planHash.
const v2Plan = {
  type: 'exit_mission_planning', title: 'Add and test greeting',
  missionPlan: await readFile(new URL('final/mission.md', V2_FIXTURE), 'utf8'),
  validationStrategy: 'Run npm test and inspect the commit.', checks: clone(v2Approval.checks), artifacts: clone(v2Approval.artifacts),
}
function v2Request(sessionId, requestId, details, toolUses = 1) {
  const recommend = details.type === 'recommend_mission'
  return envelope('request', { id: requestId, method: 'daemon.request_permission', params: {
    sessionId, associatedSessionIds: [sessionId],
    toolUses: Array.from({ length: toolUses }, (_, index) => ({
      toolUse: { type: 'tool_use', id: `tool-${requestId}-${index}`, name: recommend ? 'RecommendMission' : 'ExitMissionPlanning', input: {} },
      confirmationType: details.type, details: clone(details),
    })),
    options: recommend
      ? [{ label: 'Start Mission planning', value: 'proceed_once' }, { label: 'Continue normally', value: 'cancel' }]
      : [{ label: 'Approve Mission', value: 'proceed_once' }, { label: 'Request changes', value: 'cancel' }],
  } })
}
const v2Snapshot = (root, which = 'final', overrides = {}) => ({ ...clone(v2Snapshots[which]), sessionId: root, ...overrides })
const evaluation = (outcome, eventNumber = 1) => ({ outcome, summary: `Evaluated ${outcome}.`, eventNumber, recordedAt: stamp })
const verifiedRecord = (outcomes, latestEventNumber = 1) => ({
  verified: true, checks: clone(v2Approval.checks), latestEventNumber,
  evaluations: Object.fromEntries(V2_CHECK_IDS.map((checkId, index) => [checkId, outcomes[index]]).filter(([, row]) => row)),
})
async function v2Journey(config = {}) {
  const reads = []
  const reader = config.reader === null ? undefined : {
    read(input) {
      reads.push(clone(input))
      const result = typeof config.reader === 'function' ? config.reader(input) : config.reader
      return result ?? { verified: false, reason: 'missing_record' }
    },
  }
  const f = fixture({
    missionRecordReader: reader,
    availablePage: (_params, saved) => ({ sessions: [{ sessionId: saved.rootSessionId, updatedAt: NOW / 1000, cwd: '/offline/approved' }], hasMore: false }),
    ...config.fixture,
  })
  const launched = await f.launch(), root = f.saved.rootSessionId
  let answers = 0
  const j = {
    f, root, reads, launched,
    say: payload => f.emit(notification(root, payload)),
    observe: () => f.provider.observe(launched.binding, { ...f.context, readOnly: true }),
    async request(details, requestId) {
      f.emit(v2Request(root, requestId, details)); await f.provider.flush()
      return f.saved.requests.find(row => row.attention.requestId === requestId)
    },
    async resolve(row, selectedOption, viaAnswer = true) {
      const a = row.attention
      if (viaAnswer) await f.provider.answer(f.answerPayload(a, { selectedOption }), { ...f.context, commandId: `v2-answer-${++answers}` })
      j.say({ type: 'permission_resolved', requestId: a.requestId, toolUseIds: a.toolUseIds, selectedOption })
      await f.provider.flush()
    },
    async approve() {
      j.say({ type: 'settings_updated', settings: { tags: [{ name: 'mission-v2' }] } })
      await j.resolve(await j.request(v2Recommend, 'recommend-1'), 'proceed_once')
      j.say({ type: 'droid_working_state_changed', newState: 'streaming_assistant_message' })
      const plan = await j.request(v2Plan, 'plan-1')
      await j.resolve(plan, 'proceed_once')
      j.say({ type: 'settings_updated', settings: { tags: [{ name: 'mission-v2', metadata: { planningApproved: 'true', title: v2Plan.title, approvedAt: v2Snapshots.approval.approvedAt } }] } })
      j.say({ type: 'mission_v2_snapshot_changed', snapshot: v2Snapshot(root, 'approval') })
      await f.provider.flush()
      return plan
    },
    async runWorker(id = 'worker-1', toolUseId = 'task-1') {
      j.say({ type: 'child_session_available', childSessionId: id, toolUseId, subagentType: 'worker', description: 'Implement greeting', timestamp: NOW })
      await f.provider.flush()
      j.say({ type: 'tool_result', messageId: `result-${id}`, toolUseId, content: 'Worker done' })
      await f.provider.flush()
    },
    async finishTurn(reason = 'completed', snapshot = v2Snapshot(root)) {
      j.say({ type: 'droid_working_state_changed', newState: 'executing_tool' })
      if (snapshot) j.say({ type: 'mission_v2_snapshot_changed', snapshot })
      j.say({ type: 'agent_turn_completed', reason, turnId: 'turn-1' })
      j.say({ type: 'droid_working_state_changed', newState: 'idle' })
      await f.provider.flush()
    },
  }
  return j
}

await test('v2 recommend_mission is an answerable permission with exact reason and native options', async () => {
  const j = await v2Journey()
  j.say({ type: 'settings_updated', settings: { tags: [{ name: 'mission-v2' }] } }); await j.f.provider.flush()
  assert.equal(j.f.provider.isFenced(), false); assert.equal(j.f.saved.dialect, 'v2')
  const row = await j.request(v2Recommend, 'recommend-1')
  assert.equal(row.attention.kind, 'permission'); assert.equal(row.attention.title, 'Plan as a Factory Mission')
  assert.equal(row.attention.details, v2Recommend.reason); assert.equal(row.unsupportedReason, null)
  assert.deepEqual(row.attention.options.map(option => [option.label, option.value]),
    [['Start Mission planning', 'proceed_once'], ['Continue normally', 'cancel']])
  assert.equal(j.f.exposed.at(-1).kind, 'request')
  await j.resolve(row, 'proceed_once')
  const sent = j.f.calls.filter(frame => frame.type === 'response').at(-1)
  assert.deepEqual(sent.result, { sessionId: j.root, selectedOption: 'proceed_once' })
  assert.equal(j.f.saved.requests[0].attention.state, 'resolved')
  assert.equal(j.f.saved.missionV2.approval, null) // Recommending planning approves nothing.
  const cancelled = await v2Journey()
  await cancelled.resolve(await cancelled.request(v2Recommend, 'recommend-2'), 'cancel')
  assert.equal(cancelled.f.calls.filter(frame => frame.type === 'response').at(-1).result.selectedOption, 'cancel')
})
await test('v2 exit_mission_planning is a proposal with full plan, check list and hash of the exact details', async () => {
  const decoded = decodeSdkEnvelope(v2Request('root-1', 'plan-1', v2Plan), decodeContext)
  assert.equal(decoded.attention.kind, 'proposal'); assert.equal(decoded.attention.title, v2Plan.title)
  assert.equal(decoded.proposalHash, hash(v2Plan)); assert.equal(decoded.unsupportedReason, null)
  assert.ok(decoded.attention.details.startsWith(v2Plan.missionPlan))
  for (const check of v2Plan.checks) {
    assert.ok(decoded.attention.details.includes(`- ${check.id} (${check.group}): ${check.description}`))
    assert.ok(decoded.attention.details.includes(`How: ${check.how}`))
  }
  assert.ok(decoded.attention.details.includes(`Validation strategy:\n${v2Plan.validationStrategy}`))
  for (const check of v2Plan.checks) {
    assert.ok(decoded.attention.details.includes(`Kind: ${check.kind}`))
    if (check.about !== undefined) assert.ok(decoded.attention.details.includes(`About: ${check.about}`))
  }
  assert.ok(decoded.attention.details.includes('Artifacts:'))
  for (const artifact of v2Plan.artifacts) {
    assert.ok(decoded.attention.details.includes(`- ${artifact.id}: ${artifact.where}`))
    assert.ok(decoded.attention.details.includes(`Description: ${artifact.description}`))
    if (artifact.identity !== undefined) assert.ok(decoded.attention.details.includes(`Identity: ${artifact.identity}`))
  }
  assert.deepEqual(decoded.attention.options.map(option => option.label), ['Approve Mission', 'Request changes'])
})
await test('v2 approval is recorded only for a correlated proceed_once on the exact plan', async () => {
  const j = await v2Journey()
  const plan = await j.approve()
  assert.deepEqual(Object.keys(j.f.saved.missionV2.approval).sort(), ['attentionId', 'observedAt', 'proposalHash', 'seq'])
  assert.equal(j.f.saved.missionV2.approval.attentionId, plan.attention.attentionId)
  assert.equal(j.f.saved.missionV2.approval.proposalHash, hash(v2Plan))
  assert.equal(j.f.saved.missionV2.snapshot.envelope.params.notification.snapshot.latestEventNumber, 0)
  assert.equal(j.f.provider.isFenced(), false)
  assert.deepEqual(validateProviderRecord(j.f.saved, j.f.context), j.f.saved)
  const rejected = await v2Journey()
  rejected.say({ type: 'settings_updated', settings: { tags: [{ name: 'mission-v2' }] } })
  await rejected.resolve(await rejected.request(v2Plan, 'plan-1'), 'cancel')
  assert.equal(rejected.f.saved.missionV2.approval, null)
  const external = await v2Journey()
  external.say({ type: 'settings_updated', settings: { tags: [{ name: 'mission-v2' }] } })
  const row = await external.request(v2Plan, 'plan-1')
  external.say({ type: 'permission_resolved', requestId: row.attention.requestId, toolUseIds: ['other-tool'], selectedOption: 'proceed_once' })
  await external.f.provider.flush()
  assert.equal(external.f.saved.missionV2.approval, null) // Uncorrelated tool ids never approve.
})
await test('v2 state derivation: planning, awaiting_input, running, never paused, never completed without a record', async () => {
  const j = await v2Journey({ reader: null })
  j.say({ type: 'settings_updated', settings: { tags: [{ name: 'mission-v2' }] } })
  j.say({ type: 'droid_working_state_changed', newState: 'thinking' }); await j.f.provider.flush()
  assert.equal((await j.observe()).state, 'planning')
  const plan = await j.request(v2Plan, 'plan-1')
  assert.equal((await j.observe()).state, 'awaiting_input')
  await j.resolve(plan, 'proceed_once')
  j.say({ type: 'mission_v2_snapshot_changed', snapshot: v2Snapshot(j.root, 'approval') })
  j.say({ type: 'child_session_available', childSessionId: 'worker-1', toolUseId: 'task-1', subagentType: 'worker', description: 'Implement', timestamp: NOW })
  j.say({ type: 'droid_working_state_changed', newState: 'idle' }); await j.f.provider.flush()
  const running = await j.observe()
  assert.equal(running.state, 'running'); assert.deepEqual(running.workerSessionIds, ['worker-1'])
  assert.ok(running.sessionIds.includes('worker-1')); assert.ok(running.presentSections.includes('workers'))
  j.say({ type: 'tool_result', messageId: 'result-1', toolUseId: 'task-1', content: 'done' }); await j.f.provider.flush()
  assert.notEqual(j.f.saved.missionV2.workers[0].finishedAt, null)
  await j.finishTurn()
  const unverified = await j.observe()
  assert.equal(unverified.state, 'awaiting_input')
  assert.equal(unverified.presentSections.includes('features'), false); assert.deepEqual(unverified.features, [])
  assert.equal(unverified.presentSections.includes('finalization'), false)
  await j.finishTurn('cancelled', null)
  // An interrupted turn is unproven, not a Mission pause: it stays awaiting_input.
  assert.equal((await j.observe()).state, 'awaiting_input')
  j.say({ type: 'droid_working_state_changed', newState: 'thinking' }); await j.f.provider.flush()
  assert.equal((await j.observe()).state, 'running') // A later busy root supersedes the old turn.
})
await test('v2 completion requires a verified record that agrees with the approved plan and latest snapshot', async () => {
  const j = await v2Journey({ reader: verifiedRecord([evaluation('met'), evaluation('met'), evaluation('met')]) })
  await j.approve(); await j.runWorker(); await j.finishTurn()
  const done = await j.observe()
  assert.equal(done.state, 'completed')
  assert.deepEqual(done.features.map(row => [row.id, row.status, row.milestone]),
    v2Approval.checks.map(check => [check.id, 'completed', check.group]))
  assert.deepEqual(done.features[0].expectedBehavior, [v2Approval.checks[0].how])
  assert.ok(done.presentSections.includes('features') && done.presentSections.includes('progress'))
  assert.deepEqual(done.progressLog.map(row => row.type).sort(),
    ['check_evaluated', 'check_evaluated', 'check_evaluated', 'worker_finished', 'worker_started'])
  assert.equal(done.summary, 'Native history text.'); assert.equal(done.workersSettled, true)
  assert.ok(done.presentSections.includes('finalization'))
  assert.equal(j.reads.length, 1)
  assert.deepEqual(j.reads[0], { machineId: 'machine-1', sessionId: j.root, snapshot: v2Snapshot(j.root) })
  assert.equal(j.f.readDiagnostics.at(-1).missionRecord, 'verified'); assert.equal(j.f.readDiagnostics.at(-1).dialect, 'v2')
})
for (const [name, reader, reason] of [
  ['unverified reader result', { verified: false, reason: 'plan_hash_mismatch' }, 'plan_hash_mismatch'],
  ['thrown reader', () => { throw new Error('disk gone') }, 'mission_record_read_failed'],
  ['counts disagreeing with the snapshot', verifiedRecord([evaluation('met'), evaluation('met')]), 'check_counts_mismatch'],
  ['event number behind the snapshot', verifiedRecord([evaluation('met'), evaluation('met'), evaluation('met')], 0), 'event_number_mismatch'],
  ['checks changed after approval', { ...verifiedRecord([evaluation('met'), evaluation('met'), evaluation('met')]),
    checks: v2Approval.checks.map((check, index) => index ? check : { ...check, id: 'replaced-check' }) }, 'approved_checks_mismatch'],
  ['malformed reader result', { verified: true, checks: 'nope' }, 'mission_record_invalid'],
]) {
  await test(`v2 ${name} leaves features/progress absent and the Mission not completed`, async () => {
    const j = await v2Journey({ reader })
    await j.approve(); await j.runWorker(); await j.finishTurn()
    const observed = await j.observe()
    assert.equal(observed.state, 'awaiting_input')
    assert.equal(observed.presentSections.includes('features'), false); assert.equal(observed.presentSections.includes('progress'), false)
    assert.deepEqual(observed.features, []); assert.deepEqual(observed.progressLog, [])
    assert.equal(j.f.readDiagnostics.at(-1).missionRecord, reason)
  })
}
await test('v2 unmet evaluation is shown as unmet and never completes the Mission', async () => {
  const j = await v2Journey({ reader: verifiedRecord([evaluation('met'), evaluation('unmet'), evaluation('waived')]) })
  await j.approve(); await j.runWorker()
  await j.finishTurn('completed', v2Snapshot(j.root, 'final', { checkCounts: { total: 3, met: 1, unmet: 1, waived: 1 } }))
  const observed = await j.observe()
  assert.equal(observed.state, 'awaiting_input')
  assert.deepEqual(observed.features.map(row => row.status), ['completed', 'unmet', 'cancelled'])
})
await test('v2 waived checks count toward completion; unevaluated checks stay pending', async () => {
  const waived = await v2Journey({ reader: verifiedRecord([evaluation('met'), evaluation('waived'), evaluation('met')]) })
  await waived.approve(); await waived.runWorker()
  await waived.finishTurn('completed', v2Snapshot(waived.root, 'final', { checkCounts: { total: 3, met: 2, unmet: 0, waived: 1 } }))
  assert.equal((await waived.observe()).state, 'completed')
  const partial = await v2Journey({ reader: verifiedRecord([evaluation('met')]) })
  await partial.approve(); await partial.runWorker()
  await partial.finishTurn('completed', v2Snapshot(partial.root, 'final', { checkCounts: { total: 3, met: 1, unmet: 0, waived: 0 } }))
  const observed = await partial.observe()
  assert.equal(observed.state, 'awaiting_input'); assert.deepEqual(observed.features.map(row => row.status), ['completed', 'pending', 'pending'])
})
await test('v2 unfinished worker or open attention blocks completion even with a complete record', async () => {
  const j = await v2Journey({ reader: verifiedRecord([evaluation('met'), evaluation('met'), evaluation('met')]) })
  await j.approve()
  j.say({ type: 'child_session_available', childSessionId: 'worker-1', toolUseId: 'task-1', subagentType: 'worker', timestamp: NOW })
  await j.finishTurn()
  assert.equal((await j.observe()).state, 'running')
  j.say({ type: 'tool_result', messageId: 'result-1', toolUseId: 'task-1' }); await j.f.provider.flush()
  assert.equal((await j.observe()).state, 'completed')
  await j.request(v2Recommend, 'late-request')
  assert.equal((await j.observe()).state, 'awaiting_input')
})
await test('v2 record reader is never called before approval, without a snapshot, or for v1 jobs', async () => {
  const j = await v2Journey({ reader: verifiedRecord([evaluation('met'), evaluation('met'), evaluation('met')]) })
  j.say({ type: 'settings_updated', settings: { tags: [{ name: 'mission-v2' }] } }); await j.f.provider.flush()
  await j.observe(); await j.request(v2Plan, 'plan-1'); await j.observe()
  assert.equal(j.reads.length, 0)
  await j.resolve(j.f.saved.requests[0], 'proceed_once'); await j.observe()
  assert.equal(j.reads.length, 0) // Approved but no snapshot yet.
  const reads = []
  const v1 = fixture({ missionRecordReader: { read: input => { reads.push(input); return { verified: false, reason: 'x' } } } })
  const launched = await v1.launch()
  v1.emit(permission(v1.saved.rootSessionId, 'proposal', { type: 'propose_mission', proposal: 'Exact plan' })); await v1.provider.flush()
  const observed = await v1.provider.observe(launched.binding, { ...v1.context, readOnly: true })
  assert.equal(observed.state, 'planning'); assert.equal(v1.saved.dialect, 'v1'); assert.equal(Object.hasOwn(v1.saved, 'missionV2'), false)
  assert.equal(reads.length, 0); assert.equal(Object.hasOwn(v1.readDiagnostics.at(-1), 'missionRecord'), false)
  assert.throws(() => createInjectedNativeProvider({ ...v1.options, missionRecordReader: {} }), { code: 'sdk_mission_record_reader_invalid' })
})
await test('v2 snapshot changing during a record read is not trusted', async () => {
  let j
  j = await v2Journey({ reader: () => {
    j.say({ type: 'mission_v2_snapshot_changed', snapshot: v2Snapshot(j.root, 'final', { latestEventNumber: 2 }) })
    return verifiedRecord([evaluation('met'), evaluation('met'), evaluation('met')])
  } })
  await j.approve(); await j.runWorker(); await j.finishTurn()
  const observed = await j.observe()
  assert.equal(observed.state, 'awaiting_input'); assert.equal(observed.presentSections.includes('features'), false)
  assert.equal(j.f.readDiagnostics.at(-1).missionRecord, 'mission_snapshot_advanced')
})
await test('v2 real record reader over the canary record completes against its final snapshot', async () => {
  const factoryDir = await mkdtemp(join(tmpdir(), 'sprite-provider-v2-'))
  try {
    const j = await v2Journey({ reader: input => reader.read(input) })
    const dir = join(factoryDir, 'missionsV2', j.root)
    await mkdir(dir, { recursive: true })
    for (const name of ['mission.md', 'checks.json', 'events.jsonl']) {
      await writeFile(join(dir, name), await readFile(new URL(`final/${name}`, V2_FIXTURE)))
    }
    const reader = createMissionV2RecordReader({ factoryDir, localMachineId: 'machine-1' })
    await j.approve(); await j.runWorker(); await j.finishTurn()
    const observed = await j.observe()
    assert.equal(j.f.readDiagnostics.at(-1).missionRecord, 'verified')
    assert.equal(observed.state, 'completed')
    assert.deepEqual(observed.features.map(row => row.status), ['completed', 'completed', 'completed'])
  } finally { await rm(factoryDir, { recursive: true, force: true }) }
})
await test('v2 worker binding faults: unbound worker, conflicting ids, snapshot regression, wrong snapshot session', async () => {
  for (const [code, steps] of [
    ['sdk_mission_v2_worker_unbound', j => j.say({ type: 'child_session_available', childSessionId: 'worker-1', subagentType: 'worker', timestamp: NOW })],
    ['sdk_mission_v2_worker_conflict', j => {
      j.say({ type: 'child_session_available', childSessionId: 'worker-1', toolUseId: 'task-1', subagentType: 'worker', timestamp: NOW })
      j.say({ type: 'child_session_available', childSessionId: 'worker-2', toolUseId: 'task-1', subagentType: 'worker', timestamp: NOW })
    }],
    ['sdk_mission_v2_snapshot_regressed', j => {
      j.say({ type: 'mission_v2_snapshot_changed', snapshot: v2Snapshot(j.root) })
      j.say({ type: 'mission_v2_snapshot_changed', snapshot: v2Snapshot(j.root, 'approval') })
    }],
    ['sdk_mission_v2_snapshot_wrong_session', j => j.say({ type: 'mission_v2_snapshot_changed', snapshot: v2Snapshot('other-root') })],
  ]) {
    const j = await v2Journey()
    await j.approve(); steps(j); await j.f.provider.flush()
    assert.equal(j.f.provider.isFenced(), true); assert.equal(j.f.saved.ingestionFault, code)
    assert.deepEqual(validateProviderRecord(j.f.saved, j.f.context), j.f.saved)
  }
})
await test('v1 and v2 facts in one job fault with sdk_mission_dialect_mixed', async () => {
  for (const steps of [
    async j => { await j.request(v2Recommend, 'recommend-1'); j.f.emit(permission(j.root, 'proposal', { type: 'propose_mission', proposal: 'v1 plan' })) },
    async j => { j.say({ type: 'mission_state_changed', state: 'planning' }); await j.f.provider.flush(); await j.request(v2Plan, 'plan-1') },
    async j => { j.say({ type: 'settings_updated', settings: { tags: [{ name: 'mission-v2' }] } }); j.say({ type: 'mission_heartbeat', timestamp: stamp }); j.say({ type: 'mission_progress_entry', progressLog: [] }) },
    async j => { j.say({ type: 'mission_worker_started', workerSessionId: 'worker-1' }); j.say({ type: 'mission_v2_snapshot_changed', snapshot: v2Snapshot(j.root) }) },
  ]) {
    const j = await v2Journey()
    await steps(j); await j.f.provider.flush()
    assert.equal(j.f.provider.isFenced(), true); assert.equal(j.f.saved.ingestionFault, 'sdk_mission_dialect_mixed')
  }
  const v2Row = await v2Journey({ fixture: { availablePage: (_params, saved) => ({
    sessions: [{ sessionId: saved.rootSessionId, updatedAt: NOW / 1000, mission: { state: 'running', updatedAt: stamp } }], hasMore: false,
  }) } })
  await v2Row.approve()
  await assert.rejects(v2Row.observe(), { code: 'sdk_mission_dialect_mixed' })
})
await test('batched, malformed and unrepresentable v2 requests are handoffs or diagnostics, never approvable', async () => {
  const batched = decodeSdkEnvelope(v2Request('root-1', 'batch', v2Plan, 2), decodeContext)
  assert.equal(batched.attention.kind, 'unsupported'); assert.equal(batched.unsupportedReason, 'sdk_batched_mission_permission_handoff')
  for (const mutate of [
    details => { delete details.checks }, details => { details.checks = [{ id: 'x', group: 'g', description: 'd', extra: true }] },
    details => { details.checks.push(clone(details.checks[0])) }, details => { details.title = '  ' },
    details => { details.artifacts = [{ id: '../escape', where: '/x' }] }, details => { details.checks[0].kind = 'other' },
  ]) {
    const details = clone(v2Plan); mutate(details)
    assert.equal(safeDecodeSdkEnvelope(v2Request('root-1', 'bad', details), decodeContext).kind, 'diagnostic')
  }
  assert.equal(safeDecodeSdkEnvelope(v2Request('root-1', 'bad', { type: 'recommend_mission', reason: '' }), decodeContext).kind, 'diagnostic')
  const spaced = clone(v2Plan); spaced.checks[0].id = 'has space'
  const handoff = decodeSdkEnvelope(v2Request('root-1', 'spaced', spaced), decodeContext)
  assert.equal(handoff.attention.kind, 'unsupported'); assert.equal(handoff.unsupportedReason, 'sdk_mission_v2_plan_unrepresentable')
  const child = decodeSdkEnvelope(v2Request('worker-1', 'child', v2Recommend), decodeContext)
  assert.equal(child.unsupportedReason, 'sdk_child_attention_unqualified')
  const bad = notification('root-1', { type: 'mission_v2_snapshot_changed', snapshot: { ...v2Snapshot('root-1'), extra: 1 } })
  assert.equal(safeDecodeSdkEnvelope(bad, decodeContext).kind, 'diagnostic')
})
await test('v2 orchestrator tools are required by admission and preflight', async () => {
  assert.deepEqual([...NATIVE_MISSION_V2_ORCHESTRATOR_TOOLS], ['RecommendMission', 'ExitMissionPlanning', 'Task', 'Script'])
  assert.throws(() => requireMissionV2Tools(['Read', 'Execute', 'Task', 'Script']), { code: 'native_mission_v2_tools_missing' })
  const f = fixture()
  f.intent.settings.restrictToolIds = ['Read', 'Execute', 'RecommendMission', 'Task', 'Script']
  await assert.rejects(f.provider.inspectAdmission(asDraft(f.intent), inspectionContext(f.context)), { code: 'native_mission_v2_tools_missing' })
  await assert.rejects(f.provider.preflight(f.intent, { ...f.context, ...getNativeHashes(f.intent) }), { code: 'native_mission_v2_tools_missing' })
  assert.equal(f.calls.length, 0); assert.equal(f.hostCalls.length, 0)
})
await test('v2 provider record corruption is rejected; v1 records stay valid without dialect fields', async () => {
  const j = await v2Journey()
  await j.approve(); await j.runWorker()
  for (const mutate of [
    row => { row.dialect = 'v1' }, row => { delete row.missionV2 },
    row => { row.missionV2.approval.proposalHash = 'c'.repeat(64) },
    row => { row.missionV2.approval.attentionId = row.requests[0].attention.attentionId },
    row => { row.missionV2.workers[0].finishSeq = null },
    row => { row.missionV2.workers.push(clone(row.missionV2.workers[0])) },
    row => { row.missionV2.snapshot.envelope.params.notification.snapshot.sessionId = 'other-root' },
    row => { row.missionV2.rootBusySeq = row.missionV2.seq + 1 },
    row => { row.missionV2.extra = true },
  ]) {
    const bad = clone(j.f.saved); mutate(bad)
    assert.throws(() => validateProviderRecord(bad, j.f.context))
  }
  const v1 = fixture(); await v1.launch()
  const legacy = clone(v1.saved); delete legacy.dialect; delete legacy.missionV2
  assert.deepEqual(validateProviderRecord(legacy, v1.context), legacy)
})
await test('pure v2 derivation and record agreement mirror the design table', () => {
  const base = { dialect: 'v2', openAttention: false, planApproved: true, rootWorkingState: 'idle',
    lastTurn: { reason: 'completed', current: true }, workers: [{ finished: true }],
    snapshot: v2Snapshot('root-1'), approvedChecks: clone(v2Approval.checks), approvedPlanHash: v2Snapshots.final.planHash }
  const complete = normalizeMissionV2Record(verifiedRecord([evaluation('met'), evaluation('met'), evaluation('met')]))
  assert.equal(deriveMissionV2State({ ...base, dialect: 'v1' }), null)
  assert.equal(deriveMissionV2State({ ...base, verifiedRecord: complete }), 'completed')
  assert.equal(deriveMissionV2State(base), 'awaiting_input')
  assert.equal(deriveMissionV2State({ ...base, verifiedRecord: complete, lastTurn: { reason: 'error', current: true } }), 'awaiting_input')
  assert.equal(deriveMissionV2State({ ...base, verifiedRecord: complete, lastTurn: { reason: 'completed', current: false } }), 'awaiting_input')
  assert.equal(deriveMissionV2State({ ...base, verifiedRecord: complete, openAttention: true }), 'awaiting_input')
  assert.equal(deriveMissionV2State({ ...base, rootWorkingState: 'thinking' }), 'running')
  assert.equal(deriveMissionV2State({ ...base, planApproved: false, rootWorkingState: 'thinking' }), 'planning')
  assert.equal(deriveMissionV2State({ ...base, planApproved: false }), 'awaiting_input')
  assert.equal(deriveMissionV2State({ ...base, lastTurn: { reason: 'cancelled', current: true } }), 'awaiting_input')
  assert.deepEqual(checkMissionV2Record({ ...base, verifiedRecord: complete }), { ok: true, complete: true, reason: null })
  const evaluations = new Map([[V2_CHECK_IDS[0], { ...evaluation('met'), eventNumber: 2 }]])
  const future = normalizeMissionV2Record({ verified: true, checks: clone(v2Approval.checks), latestEventNumber: 1, evaluations })
  assert.equal(checkMissionV2Record({ ...base, verifiedRecord: future }).reason, 'future_check_evaluation')
  assert.equal(normalizeMissionV2Record({ verified: false, reason: 'x'.repeat(500) }).reason, 'mission_record_unverified')
})

await test('v2 AskUser resolved via Spriite or externally no longer blocks derived completion', async () => {
  const complete = () => verifiedRecord([evaluation('met'), evaluation('met'), evaluation('met')])
  // Answered through Spriite: the answer stays outcome-unknown, but the tool
  // termination proves the daemon is no longer waiting for the request.
  const viaSpriite = await v2Journey({ reader: complete() })
  viaSpriite.say({ type: 'settings_updated', settings: { tags: [{ name: 'mission-v2' }] } })
  viaSpriite.f.emit(questionnaire(viaSpriite.root, 'q-1')); await viaSpriite.f.provider.flush()
  const asked = viaSpriite.f.saved.requests.find(row => row.attention.requestId === 'q-1')
  await viaSpriite.f.provider.answer(viaSpriite.f.answerPayload(asked.attention, {
    answers: [{ index: 1, answer: 'first full value' }, { index: 3, answer: 'because' }],
  }), { ...viaSpriite.f.context, commandId: 'ask-1' })
  viaSpriite.say({ type: 'tool_result', messageId: 'm-q-1', toolUseId: 'tool-q-1', content: 'answered' })
  await viaSpriite.f.provider.flush()
  await viaSpriite.approve(); await viaSpriite.runWorker(); await viaSpriite.finishTurn()
  assert.equal(viaSpriite.f.saved.requests.find(row => row.attention.requestId === 'q-1').attention.state, 'answer_unknown')
  assert.equal((await viaSpriite.observe()).state, 'completed')
  // Answered externally: only the tool_result correlation arrives.
  const external = await v2Journey({ reader: complete() })
  external.say({ type: 'settings_updated', settings: { tags: [{ name: 'mission-v2' }] } })
  external.f.emit(questionnaire(external.root, 'q-2')); await external.f.provider.flush()
  external.say({ type: 'tool_result', messageId: 'm-q-2', toolUseId: 'tool-q-2', content: 'answered' })
  await external.f.provider.flush()
  await external.approve(); await external.runWorker(); await external.finishTurn()
  assert.equal((await external.observe()).state, 'completed')
  // A genuinely open AskUser still blocks completion.
  const open = await v2Journey({ reader: complete() })
  await open.approve(); await open.runWorker()
  open.f.emit(questionnaire(open.root, 'q-3')); await open.f.provider.flush()
  await open.finishTurn()
  assert.equal((await open.observe()).state, 'awaiting_input')
})
await test('v2 root permission request closed by a root tool_result no longer blocks derived state', async () => {
  const j = await v2Journey({ reader: verifiedRecord([evaluation('met'), evaluation('met'), evaluation('met')]) })
  await j.approve(); await j.runWorker()
  j.f.emit(permission(j.root, 'exec-1')); await j.f.provider.flush()
  await j.finishTurn()
  assert.equal((await j.observe()).state, 'awaiting_input')
  j.say({ type: 'tool_result', messageId: 'result-exec-1', toolUseId: 'tool-exec-1', content: 'ran' })
  await j.f.provider.flush()
  await j.finishTurn()
  assert.equal((await j.observe()).state, 'completed')
})
await test('v2 worker finished by a tool_result that arrived before child_session_available', async () => {
  const j = await v2Journey({ reader: verifiedRecord([evaluation('met'), evaluation('met'), evaluation('met')]) })
  await j.approve()
  j.say({ type: 'tool_result', messageId: 'result-early', toolUseId: 'task-1', content: 'done' })
  j.say({ type: 'child_session_available', childSessionId: 'worker-1', toolUseId: 'task-1', subagentType: 'worker', description: 'Implement greeting', timestamp: NOW })
  await j.f.provider.flush()
  assert.notEqual(j.f.saved.missionV2.workers[0].finishedAt, null)
  assert.equal(j.f.saved.missionV2.workers[0].failed, false)
  await j.finishTurn()
  assert.equal((await j.observe()).state, 'completed')
})
await test('v2 unusable agent_turn_completed rows are ignored, never a fault or a turn completion', async () => {
  const j = await v2Journey({ reader: verifiedRecord([evaluation('met'), evaluation('met'), evaluation('met')]) })
  await j.approve(); await j.runWorker()
  for (const bad of [
    { reason: '', turnId: 'turn-1' }, { reason: '   ', turnId: 'turn-1' }, { turnId: 'turn-1' },
    { reason: 'completed', turnId: null }, { reason: 'x'.repeat(200), turnId: 'turn-1' }, { reason: 7, turnId: 'turn-1' },
  ]) j.say({ type: 'agent_turn_completed', ...bad })
  j.say({ type: 'droid_working_state_changed', newState: 'idle' })
  await j.f.provider.flush()
  assert.equal(j.f.provider.isFenced(), false)
  assert.equal(j.f.saved.missionV2.lastTurn, null)
  assert.equal(j.f.readDiagnostics.length, 0)
  await j.finishTurn()
  assert.equal(j.f.saved.missionV2.lastTurn.reason, 'completed')
  assert.equal((await j.observe()).state, 'completed')
})
await test('v2 large plan requests are persisted once and oversized plans hand off instead of faulting', async () => {
  const j = await v2Journey()
  j.say({ type: 'settings_updated', settings: { tags: [{ name: 'mission-v2' }] } })
  const planText = `# Plan\n${'Implement and verify the greeting step. '.repeat(1200)}` // ~49KB
  for (const requestId of ['plan-big-1', 'plan-big-2']) {
    const details = { ...clone(v2Plan), missionPlan: planText }
    const frame = v2Request(j.root, requestId, details)
    frame.params.toolUses[0].toolUse.input = { missionPlan: planText } // daemon repeats the plan in the tool input
    j.f.emit(frame); await j.f.provider.flush()
    const row = j.f.saved.requests.find(stored => stored.attention.requestId === requestId)
    assert.ok(row); assert.equal(row.attention.kind, 'proposal'); assert.equal(row.unsupportedReason, null)
    assert.equal(Object.hasOwn(row, 'raw'), false) // the envelope is the single source of truth
  }
  assert.equal(j.f.provider.isFenced(), false)
  assert.deepEqual(validateProviderRecord(j.f.saved, j.f.context), j.f.saved)
  // Well-formed but unrepresentable plans (text or byte budget) are handoffs, never faults.
  const oversizedText = { ...clone(v2Plan), missionPlan: `# Big\n${'Step. '.repeat(12000)}` } // ~72KB of text
  const oversizedBytes = { ...clone(v2Plan), missionPlan: 'p'.repeat(132000) } // raw request over the byte budget
  const oversizedCheck = { ...clone(v2Plan), checks: [{ id: 'check-1', group: 'g', description: 'd'.repeat(70000), how: 'h', kind: 'verification' }] }
  for (const [requestId, details] of [['plan-huge-1', oversizedText], ['plan-huge-2', oversizedBytes], ['plan-huge-3', oversizedCheck]]) {
    const decoded = decodeSdkEnvelope(v2Request('root-1', requestId, details), decodeContext)
    assert.equal(decoded.attention.kind, 'unsupported')
    assert.equal(decoded.unsupportedReason, 'sdk_mission_v2_plan_unrepresentable')
  }
  // End-to-end the handoff is persisted and never fences the provider.
  j.f.emit(v2Request(j.root, 'plan-huge-1', oversizedText)); await j.f.provider.flush()
  const handoff = j.f.saved.requests.find(stored => stored.attention.requestId === 'plan-huge-1')
  assert.equal(handoff.unsupportedReason, 'sdk_mission_v2_plan_unrepresentable')
  assert.equal(j.f.provider.isFenced(), false)
  assert.equal(j.f.readDiagnostics.length, 0)
  assert.deepEqual(validateProviderRecord(j.f.saved, j.f.context), j.f.saved)
})
await test('a record that outgrows the journal persists a minimal ingestion fault', async () => {
  const f = fixture(); await f.launch()
  const block = 'Tool output line. '.repeat(3612) // ~65KB, one block at the per-text bound
  const bigMessage = id => ({ id, role: 'assistant', content: [0, 1, 2, 3].map(() => ({ type: 'text', text: block })), createdAt: NOW, updatedAt: NOW })
  for (let index = 0; index < 4 && !f.provider.isFenced(); index++) {
    f.emit(notification(f.saved.rootSessionId, { type: 'create_message', message: bigMessage(`big-${index}`) }))
    await f.provider.flush()
  }
  await f.provider.flush()
  assert.equal(f.provider.isFenced(), true)
  // The fault itself must survive a restart: a minimal record (bulk observations
  // dropped) is committed when the full record no longer fits.
  assert.equal(f.saved.ingestionFault, 'sdk_ingestion_persistence_failed')
  assert.deepEqual(f.saved.observations.history, [])
  assert.deepEqual(validateProviderRecord(f.saved, f.context), f.saved)
})
await test('v2 observe ignores malformed mission metadata on unrelated sessions only', async () => {
  const unrelated = (_params, saved) => ({ sessions: [
    { sessionId: saved.rootSessionId, updatedAt: NOW / 1000, cwd: '/offline/approved' },
    { sessionId: 'other-v2', updatedAt: NOW / 1000, cwd: '/elsewhere',
      mission: { ...v2Snapshot('other-v2'), state: 'running_v2' }, missionV2: { bogus: true } },
    { sessionId: 'other-garbage', updatedAt: NOW / 1000, mission: 'not-an-object' },
  ], hasMore: false })
  const j = await v2Journey({
    reader: verifiedRecord([evaluation('met'), evaluation('met'), evaluation('met')]),
    fixture: { availablePage: unrelated },
  })
  await j.approve(); await j.runWorker(); await j.finishTurn()
  assert.equal((await j.observe()).state, 'completed')
  const mixed = await v2Journey({
    reader: verifiedRecord([evaluation('met'), evaluation('met'), evaluation('met')]),
    fixture: {
      availablePage: (_params, saved) => ({ sessions: [
        { sessionId: saved.rootSessionId, updatedAt: NOW / 1000, cwd: '/offline/approved' },
        { sessionId: 'worker-1', updatedAt: NOW / 1000, callingSessionId: saved.rootSessionId, missionV2: { bogus: true } },
      ], hasMore: false }),
    },
  })
  await mixed.approve(); await mixed.runWorker(); await mixed.finishTurn()
  await assert.rejects(mixed.observe(), error => error.code === 'sdk_session_mission_invalid')
})
await test('v2 completion is refused when the approved plan text does not match the snapshot planHash', async () => {
  const tampered = { ...clone(v2Plan), missionPlan: '# Add and test greeting\n\nA different plan than the approved one.' }
  const j = await v2Journey({ reader: verifiedRecord([evaluation('met'), evaluation('met'), evaluation('met')]) })
  j.say({ type: 'settings_updated', settings: { tags: [{ name: 'mission-v2' }] } })
  await j.resolve(await j.request(v2Recommend, 'recommend-1'), 'proceed_once')
  j.say({ type: 'droid_working_state_changed', newState: 'streaming_assistant_message' })
  await j.resolve(await j.request(tampered, 'plan-1'), 'proceed_once')
  j.say({ type: 'settings_updated', settings: { tags: [{ name: 'mission-v2', metadata: { planningApproved: 'true', title: v2Plan.title, approvedAt: v2Snapshots.approval.approvedAt } }] } })
  j.say({ type: 'mission_v2_snapshot_changed', snapshot: v2Snapshot(j.root, 'approval') })
  await j.runWorker(); await j.finishTurn()
  const observed = await j.observe()
  assert.equal(observed.state, 'awaiting_input')
  assert.equal(observed.presentSections.includes('features'), false)
  assert.equal(j.f.readDiagnostics.at(-1).missionRecord, 'approved_plan_hash_mismatch')
  const complete = normalizeMissionV2Record(verifiedRecord([evaluation('met'), evaluation('met'), evaluation('met')]))
  assert.equal(checkMissionV2Record({
    snapshot: v2Snapshot('root-1'), approvedChecks: clone(v2Approval.checks),
    approvedPlanHash: 'f'.repeat(64), verifiedRecord: complete,
  }).reason, 'approved_plan_hash_mismatch')
})
await test('v2 long evaluation summaries truncate with a marker; completion is not blocked', async () => {
  const longSummary = 'Evidence line. '.repeat(5000) // 75000 chars, over the projection bound
  const record = verifiedRecord([{ ...evaluation('met'), summary: longSummary }, evaluation('met'), evaluation('met')])
  const normalized = normalizeMissionV2Record(record)
  assert.equal(normalized.verified, true)
  assert.equal(normalized.evaluations[V2_CHECK_IDS[0]].summaryTruncated, true)
  assert.equal(normalized.evaluations[V2_CHECK_IDS[0]].summary.length, 4096)
  const j = await v2Journey({ reader: record })
  await j.approve(); await j.runWorker(); await j.finishTurn()
  const observed = await j.observe()
  assert.equal(observed.state, 'completed')
  const projected = observed.progressLog.find(row => row.type === 'check_evaluated' && row.checkId === V2_CHECK_IDS[0])
  assert.equal(projected.summary.length, 4096)
  assert.equal(projected.summaryTruncated, true)
})
await test('v2 progress keeps the latest rows behind an explicit omission marker', () => {
  const many = Array.from({ length: 300 }, (_, index) => ({
    sessionId: `worker-${index}`, toolUseId: `task-${index}`, subagentType: 'worker',
    description: 'Implement greeting',
    startedAt: new Date(NOW + index * 1000).toISOString(),
    finishedAt: new Date(NOW + index * 1000 + 500).toISOString(),
    failed: false, finished: true,
  }))
  const rows = projectV2Progress({ workers: many })
  assert.ok(rows.length <= 512)
  assert.equal(rows[0].type, 'progress_omitted')
  assert.equal(rows[0].omittedCount, 600 - (rows.length - 1))
  assert.equal(rows.at(-1).type, 'worker_finished')
  assert.equal(rows.at(-1).workerSessionId, 'worker-299')
  assert.ok(!rows.some(row => row.workerSessionId === 'worker-0'))
})
await test('v2 observe bounds projected history with an explicit clip diagnostic', async () => {
  const messages = Array.from({ length: 130 }, (_, index) => message(`history-${index}`, `Assistant line ${index}.`))
  const j = await v2Journey({
    reader: verifiedRecord([evaluation('met'), evaluation('met'), evaluation('met')]),
    fixture: {
      messagePage: params => {
        const start = params.cursor === undefined ? 0 : Number(params.cursor)
        return { messages: messages.slice(start, start + 100), hasMore: start + 100 < messages.length, nextCursor: String(start + 100) }
      },
    },
  })
  await j.approve(); await j.runWorker(); await j.finishTurn()
  const observed = await j.observe()
  assert.equal(observed.state, 'completed')
  assert.equal(observed.history.length, 128)
  assert.equal(j.f.readDiagnostics.at(-1).historyClipped, true)
  // A very long closing assistant text is a bounded, marked summary, never an invalid observation.
  const longFinal = [message('history-1', 'Native history text.'),
    { ...message('final-long', 'Done. '.repeat(1200)), createdAt: NOW + 1000, updatedAt: NOW + 1000 }]
  const verbose = await v2Journey({
    reader: verifiedRecord([evaluation('met'), evaluation('met'), evaluation('met')]),
    fixture: { messagePage: () => ({ messages: longFinal, hasMore: false }) },
  })
  await verbose.approve(); await verbose.runWorker(); await verbose.finishTurn()
  const verboseObserved = await verbose.observe()
  assert.equal(verboseObserved.state, 'completed')
  assert.equal(verboseObserved.summary.length, 4096)
  assert.equal(verboseObserved.summaryTruncated, true)
})

// ---- droid 0.238 Missions 2.0 agents ('v2-agents'; real canary fixture, trimmed) ----
const AGENTS_FIXTURE = new URL('./fixtures/mission-v2-agents/', import.meta.url)
const agentsMeta = JSON.parse(await readFile(new URL('meta.json', AGENTS_FIXTURE), 'utf8'))
const agentsEventsText = await readFile(new URL('root-events.jsonl', AGENTS_FIXTURE), 'utf8')
const AGENT_ID = agentsMeta.agentSessionId
/** Real root notifications with the canary root id replaced by this job's owned root. */
const agentsEvents = root => agentsEventsText.trim().split('\n')
  .map(line => JSON.parse(line.split(agentsMeta.rootSessionId).join(root)))
const orchestratorTag = (root, extra = {}) => [{ name: 'mission-v2', metadata: { kind: 'orchestrator', missionId: root, ...extra } }]
async function agentsJourney(config = {}) {
  let clock = NOW
  const reads = []
  const f = fixture({
    agentTools: true,
    initTags: config.initTags === undefined ? params => orchestratorTag(params.sessionId) : config.initTags,
    missionRecordReader: { read(input) { reads.push(clone(input)); return { verified: false, reason: 'never' } } },
    availablePage: (_params, saved) => ({ sessions: [{ sessionId: saved.rootSessionId, updatedAt: NOW / 1000, cwd: '/offline/approved' }], hasMore: false }),
    extraOptions: { now: () => clock, missionV2AgentsSettleMs: 1000 },
    ...config.fixture,
  })
  const launched = await f.launch(), root = f.saved.rootSessionId
  const j = {
    f, root, reads, launched,
    advance(ms) { clock += ms },
    say: payload => f.emit(notification(root, payload)),
    observe: () => f.provider.observe(launched.binding, { ...f.context, readOnly: true }),
    async replay(filter = () => true) {
      for (const row of agentsEvents(root).filter(filter)) j.say(row.notification)
      await f.provider.flush()
    },
    async listAgents(toolUseId, agents) {
      j.say({ type: 'create_message', message: { id: `m-${toolUseId}`, role: 'assistant', createdAt: NOW, updatedAt: NOW,
        content: [{ type: 'tool_use', id: toolUseId, name: 'ListAgents', input: {} }] } })
      j.say({ type: 'tool_result', messageId: `r-${toolUseId}`, toolUseId, content: JSON.stringify({ agents }) })
      await f.provider.flush()
    },
    async finishTurn(reason = 'completed') {
      j.say({ type: 'create_message', message: message(`final-${reason}-${clock}`, 'All agents are idle; the Mission is done.') })
      j.say({ type: 'agent_turn_completed', reason, turnId: `turn-${clock}` })
      j.say({ type: 'droid_working_state_changed', newState: 'idle' })
      await f.provider.flush()
    },
  }
  return j
}
const idleAgent = (extra = {}) => ({ sessionId: AGENT_ID, title: 'Greeting feature and tests', status: 'idle', waitingOn: null,
  createdAt: 1791990964936, updatedAt: 1791991100000, ...extra })

await test('v2-agents compiled initialize sends only the bare mission-v2 tag and the wire hashes it', async () => {
  const f = fixture({ agentTools: true, initTags: params => orchestratorTag(params.sessionId) })
  const compiled = compileNativePolicy(f.intent, f.options.deployment)
  assert.deepEqual(compiled.initialize.tags, [{ name: 'mission-v2' }])
  await f.launch()
  const sent = f.calls.find(frame => frame.method === 'daemon.initialize_session')
  assert.deepEqual(sent.params.tags, [{ name: 'mission-v2' }])
  assert.deepEqual(f.saved.initializeParams.tags, [{ name: 'mission-v2' }])
  assert.equal(f.saved.initialize.requestHash, hash({ method: 'daemon.initialize_session', params: f.saved.initializeParams }))
  // No new RPC: initialize, goal, readiness and read methods only.
  assert.deepEqual([...new Set(f.calls.map(frame => frame.method))].sort(),
    ['daemon.add_user_message', 'daemon.initialize_session', 'daemon.inspect_mission_readiness'])
  const frame = tags => envelope('request', { id: 'init', method: 'daemon.initialize_session',
    params: { sessionId: 'root-1', machineId: 'machine-1', token: 'opaque', cwd: '/offline/approved', tags } })
  assert.equal(outgoingDescriptor(frame([{ name: 'mission-v2' }])).operation, 'initialize')
  for (const tags of [[{ name: 'mission-v2', metadata: { kind: 'orchestrator', missionId: 'root-1' } }], [{ name: 'other' }], []]) {
    assert.throws(() => outgoingDescriptor(frame(tags)), { code: 'sdk_send_tags_refused' })
  }
  const legacy = clone(f.saved); delete legacy.initializeParams.tags
  assert.throws(() => validateProviderRecord(legacy, f.context)) // hash binds the tags
  const tampered = clone(f.saved); tampered.initializeParams.tags = [{ name: 'mission-v2', metadata: { kind: 'agent' } }]
  assert.throws(() => validateProviderRecord(tampered, f.context), { code: 'sdk_provider_initialize_corrupt' })
})
await test('v2-agents tool policy accepts the agents set or the legacy set, never a partial set', () => {
  assert.deepEqual([...NATIVE_MISSION_V2_AGENTS_TOOLS], ['SpawnAgent', 'SendMessage', 'ListAgents', 'InterruptAgent'])
  assert.ok(requireMissionV2Tools(['Read', 'SpawnAgent', 'SendMessage', 'ListAgents', 'InterruptAgent']))
  assert.ok(requireMissionV2Tools(['SpawnAgent', 'SendMessage', 'ListAgents', 'InterruptAgent', 'Task', 'Script']))
  assert.ok(requireMissionV2Tools(['RecommendMission', 'ExitMissionPlanning', 'Task', 'Script']))
  for (const tools of [['SpawnAgent', 'SendMessage', 'ListAgents'], ['SpawnAgent', 'RecommendMission', 'ExitMissionPlanning', 'Task'], []]) {
    assert.throws(() => requireMissionV2Tools(tools), { code: 'native_mission_v2_tools_missing' })
  }
})
await test('v2-agents dialect is adopted from the initialize result tag naming the root as orchestrator', async () => {
  const j = await agentsJourney()
  assert.equal(j.f.saved.dialect, 'v2-agents')
  assert.deepEqual(j.f.saved.missionV2Agents.tag, { kind: 'orchestrator', missionId: j.root })
  assert.equal(Object.hasOwn(j.f.saved, 'missionV2'), false)
  assert.deepEqual(validateProviderRecord(j.f.saved, j.f.context), j.f.saved)
  // A legacy 0.227 tag in the result keeps the legacy dialect.
  const legacy = await agentsJourney({ initTags: () => [{ name: 'mission-v2' }] })
  assert.equal(legacy.f.saved.dialect, 'v2')
  // No tag in the result: undecided until the first decisive fact.
  const untagged = await agentsJourney({ initTags: null })
  assert.equal(untagged.f.saved.dialect ?? null, null)
  untagged.say({ type: 'settings_updated', settings: { tags: orchestratorTag(untagged.root) } }); await untagged.f.provider.flush()
  assert.equal(untagged.f.saved.dialect, 'v2-agents'); assert.equal(untagged.f.provider.isFenced(), false)
  for (const tags of [
    params => [{ name: 'mission-v2', metadata: { kind: 'agent', missionId: params.sessionId } }],
    () => [{ name: 'mission-v2', metadata: { kind: 'orchestrator', missionId: 'someone-else' } }],
  ]) {
    const f = fixture({ agentTools: true, initTags: tags })
    await f.provider.preflight(f.intent, f.context)
    await assert.rejects(f.provider.launch(f.intent, f.context), { code: 'sdk_initialize_outcome_unknown' })
    assert.equal(f.saved.initialize.fault, 'sdk_mission_v2_tag_mismatch')
    assert.equal(f.saved.recoveryHold, true); assert.equal(f.saved.dialect ?? null, null)
  }
})
await test('v2-agents replay of the real 0.238 canary: agents tracked, spaceId growth tolerated, never completed while an agent runs', async () => {
  const j = await agentsJourney()
  await j.replay()
  assert.equal(j.f.provider.isFenced(), false); assert.equal(j.f.saved.ingestionFault, null)
  const m = j.f.saved.missionV2Agents
  assert.deepEqual(m.agents.map(row => [row.sessionId, row.title, row.status, row.source]),
    [[AGENT_ID, 'Greeting feature and tests', 'running', 'spawn']])
  assert.notEqual(m.agents[0].listedAt, null) // Later ListAgents results ('running') were applied.
  assert.equal(m.toolUses.length, 0) // Every SpawnAgent/ListAgents use was matched to its result.
  assert.equal(m.lastTurn.reason, 'completed'); assert.equal(m.rootWorking.state, 'idle')
  assert.deepEqual(validateProviderRecord(j.f.saved, j.f.context), j.f.saved)
  const observed = await j.observe()
  assert.equal(observed.state, 'awaiting_input')
  assert.deepEqual(observed.features, [{ id: AGENT_ID, description: 'Greeting feature and tests', status: 'in_progress', expectedBehavior: [] }])
  assert.deepEqual(observed.workerSessionIds, [AGENT_ID]); assert.ok(observed.sessionIds.includes(AGENT_ID))
  for (const section of ['mission', 'features', 'progress', 'workers']) assert.ok(observed.presentSections.includes(section))
  assert.equal(observed.presentSections.includes('finalization'), false)
  assert.ok(observed.progressLog.some(row => row.type === 'agent_spawned' && row.agentSessionId === AGENT_ID))
  assert.ok(observed.progressLog.some(row => row.type === 'agent_status' && row.status === 'running'))
  assert.equal(j.reads.length, 0) // No durable record exists in this dialect.
  assert.equal(j.f.readDiagnostics.at(-1).dialect, 'v2-agents')
  assert.equal(j.f.readDiagnostics.at(-1).missionRecord, 'mission_v2_agents_no_durable_record')
  j.advance(5000) // Long past the settle window: the agent's last known status is still 'running'.
  assert.equal((await j.observe()).state, 'awaiting_input')
  assert.equal(j.f.saved.missionV2Agents.completed, null)
})
await test('v2-agents completes only after the settle window with every agent idle; late activity is progress only', async () => {
  const j = await agentsJourney()
  await j.replay()
  j.say({ type: 'droid_working_state_changed', newState: 'executing_tool' })
  await j.listAgents('call_final_list', [idleAgent()])
  await j.finishTurn()
  assert.equal(j.f.saved.missionV2Agents.agents[0].status, 'idle')
  assert.equal((await j.observe()).state, 'awaiting_input') // Inside the settle window.
  j.advance(999)
  assert.equal((await j.observe()).state, 'awaiting_input')
  j.advance(1)
  const done = await j.observe()
  assert.equal(done.state, 'completed')
  assert.deepEqual(done.features.map(row => [row.id, row.status]), [[AGENT_ID, 'completed']])
  assert.equal(done.summary, 'Native history text.'); assert.equal(done.workersSettled, true)
  assert.ok(done.presentSections.includes('finalization'))
  assert.notEqual(j.f.saved.missionV2Agents.completed, null) // Latched and persisted.
  assert.deepEqual(validateProviderRecord(j.f.saved, j.f.context), j.f.saved)
  // Late root activity (an agent report starts a new orchestrator turn) never regresses the job.
  j.say({ type: 'create_message', message: message('late-report', 'Agent report after completion.', 'user') })
  j.say({ type: 'droid_working_state_changed', newState: 'thinking' })
  await j.listAgents('call_late_list', [idleAgent({ status: 'running' })])
  const late = await j.observe()
  assert.equal(late.state, 'completed')
  assert.equal(j.f.saved.missionV2Agents.agents[0].status, 'idle') // Agents are frozen after completion.
  const row = late.progressLog.find(item => item.type === 'activity_after_completion')
  assert.ok(row && row.count >= 3)
  assert.ok(late.progressLog.some(item => item.type === 'mission_completed'))
  assert.deepEqual(validateProviderRecord(j.f.saved, j.f.context), j.f.saved)
})
await test('v2-agents derived state: open attention, busy root, interrupted turn, new activity and restored providers', async () => {
  const j = await agentsJourney()
  await j.replay()
  await j.listAgents('call_list_idle', [idleAgent()])
  j.f.emit(permission(j.root, 'exec-1')); await j.f.provider.flush()
  await j.finishTurn(); j.advance(2000)
  assert.equal((await j.observe()).state, 'awaiting_input') // The open root permission blocks completion.
  j.say({ type: 'tool_result', messageId: 'r-exec', toolUseId: 'tool-exec-1', content: 'ran' })
  j.say({ type: 'droid_working_state_changed', newState: 'executing_tool' }); await j.f.provider.flush()
  assert.equal((await j.observe()).state, 'running')
  await j.finishTurn('cancelled'); j.advance(2000)
  assert.equal((await j.observe()).state, 'awaiting_input') // Only a 'completed' turn can complete; never 'paused'.
  await j.finishTurn(); j.advance(500)
  j.say({ type: 'create_message', message: message('agent-report', 'Report from an agent.', 'user') }); await j.f.provider.flush()
  j.advance(2000)
  assert.equal((await j.observe()).state, 'awaiting_input') // Activity after the turn: the turn is no longer current.
  // A restored (read-only) provider never newly derives completion, even when settled.
  await j.finishTurn(); j.advance(2000)
  const restart = () => fixture({ saved: j.f.saved, epoch: 2, agentTools: true,
    availablePage: (_params, saved) => ({ sessions: [{ sessionId: saved.rootSessionId, updatedAt: NOW / 1000 }], hasMore: false }),
    extraOptions: { now: () => NOW + 60000, missionV2AgentsSettleMs: 1000 } })
  const restored = restart()
  const observed = await restored.provider.observe(j.launched.binding, { ...restored.context, readOnly: true })
  assert.equal(observed.state, 'awaiting_input'); assert.equal(restored.writes.length, 0)
  assert.equal((await j.observe()).state, 'completed') // The live provider does.
  const latched = restart()
  assert.equal((await latched.provider.observe(j.launched.binding, { ...latched.context, readOnly: true })).state, 'completed')
  // v1 mission metadata on a v2-agents root is contradictory evidence.
  const contradicted = fixture({ saved: j.f.saved, epoch: 2, agentTools: true })
  await assert.rejects(contradicted.provider.observe(j.launched.binding, { ...contradicted.context, readOnly: true }),
    { code: 'sdk_mission_dialect_mixed' })
})
await test('v2-agents never completes with an agent pending or waiting; an agent-less orchestrator completes once settled', async () => {
  for (const [agents, expected] of [
    [null, 'completed'],
    [[idleAgent({ status: 'pending' })], 'awaiting_input'],
    [[idleAgent({ waitingOn: 'permission' })], 'awaiting_input'],
    [[idleAgent({ status: null })], 'awaiting_input'],
    [[idleAgent({ status: 'brand_new_status' })], 'awaiting_input'],
    [[idleAgent()], 'completed'],
  ]) {
    const j = await agentsJourney()
    j.say({ type: 'droid_working_state_changed', newState: 'thinking' })
    if (agents) await j.listAgents('call_list', agents)
    await j.finishTurn(); j.advance(2000)
    const observed = await j.observe()
    assert.equal(observed.state, expected, JSON.stringify(agents))
    if (agents?.[0]?.waitingOn === 'permission') assert.equal(observed.features[0].status, 'in_progress')
    if (agents?.[0]?.status === 'brand_new_status') assert.equal(j.f.saved.missionV2Agents.agents[0].status, 'unknown')
  }
})
await test('droid 0.238 internal underscore-id messages are ignored, other bad ids still refuse', () => {
  const ctx = { machineId: 'm', connectionId: 'c', rootSessionId: 'root-1', observedAt: new Date(NOW).toISOString() }
  const frame = id => ({ jsonrpc: '2.0', factoryApiVersion: '1.0.0', type: 'notification', method: 'daemon.session_notification',
    params: { sessionId: 'root-1', notification: { type: 'create_message',
      message: { id, role: 'user', createdAt: NOW, updatedAt: NOW, content: [] } } } })
  assert.equal(decodeSdkEnvelope(frame('__internal__mission-reminder__1b2c3d4e-0000-4000-8000-000000000000'), ctx).kind, 'ignored')
  assert.throws(() => decodeSdkEnvelope(frame('../escape'), ctx))
  assert.equal(decodeSdkEnvelope(frame('msg-ok'), ctx).kind, 'notification')
})
await test('droid 0.238 authenticate handshake passes the send guard once per connection, exact shape only', () => {
  const sent = []
  const transport = { send: data => sent.push(data), isConnected: () => true, getConnectionId: () => 'conn-1',
    connect() {}, disconnect() {}, isRelayConnection: () => false, getTransportKind: () => 'websocket', on() {}, off() {} }
  const gate = createGuardedDaemonTransport(transport, { boundary: { assertAndConsumePermit() {} }, readGuard() {} })
  const frame = params => JSON.stringify({ jsonrpc: '2.0', factoryApiVersion: '1.0.0', type: 'request', id: 'auth-1',
    method: 'daemon.authenticate', params })
  const good = { apiKey: 'fk-offline-fixture-not-a-real-key', caller: 'sdk', metadata: { sdk: { language: 'typescript', version: '0.9.1' } } }
  gate.transport.send(frame(good))
  assert.equal(sent.length, 1)
  assert.throws(() => gate.transport.send(frame(good)), { code: 'sdk_authenticate_repeated' })
  assert.throws(() => gate.transport.send(frame({ ...good, sessionId: 'x' })))
  assert.throws(() => gate.transport.send(frame({ ...good, caller: 'cli' })))
  assert.equal(sent.length, 1, 'only the one exact handshake reached the daemon')
})
await test('v2-agents: an attributed agent report finishes that agent; messaging it again resumes it', async () => {
  const j = await agentsJourney()
  const report = (id, sessionId) => j.say({ type: 'create_message', message: { id, role: 'user', createdAt: NOW, updatedAt: NOW,
    sender: { kind: 'agent', title: 'Greeting', sessionId }, content: [{ type: 'text', text: 'Done: committed.' }] } })
  j.say({ type: 'droid_working_state_changed', newState: 'thinking' })
  await j.listAgents('call_list', [idleAgent({ status: 'running' })])
  report('m-report', AGENT_ID)
  await j.finishTurn(); j.advance(2000)
  const done = await j.observe()
  assert.equal(done.state, 'completed')
  assert.equal(done.features[0].status, 'completed')
  const k = await agentsJourney()
  k.say({ type: 'droid_working_state_changed', newState: 'thinking' })
  await k.listAgents('call_list', [idleAgent({ status: 'running' })])
  const reportK = (id) => k.say({ type: 'create_message', message: { id, role: 'user', createdAt: NOW, updatedAt: NOW,
    sender: { kind: 'agent', sessionId: AGENT_ID }, content: [{ type: 'text', text: 'Draft ready.' }] } })
  reportK('m-r1')
  k.say({ type: 'create_message', message: { id: 'm-steer', role: 'assistant', createdAt: NOW, updatedAt: NOW,
    content: [{ type: 'tool_use', id: 'call_send', name: 'SendMessage', input: { sessionId: AGENT_ID, message: 'Now commit.' } }] } })
  await k.finishTurn(); k.advance(2000)
  assert.equal((await k.observe()).state, 'awaiting_input', 'a steered agent is running again until it reports')
})
await test('v2-agents malformed agent tool results are ignored, never fatal', async () => {
  const j = await agentsJourney()
  const use = (toolUseId, name, input = {}) => j.say({ type: 'create_message', message: { id: `m-${toolUseId}`, role: 'assistant',
    createdAt: NOW, updatedAt: NOW, content: [{ type: 'tool_use', id: toolUseId, name, input }] } })
  for (const [toolUseId, name, content, isError] of [
    ['spawn-1', 'SpawnAgent', 'not json', false],
    ['spawn-2', 'SpawnAgent', JSON.stringify({ sessionId: '../escape' }), false],
    ['spawn-3', 'SpawnAgent', JSON.stringify({ sessionId: 'agent-3' }), true],
    ['spawn-4', 'SpawnAgent', [{ type: 'text', text: '{"sessionId":' }, { type: 'text', text: '"agent-4"}' }], false],
    ['list-1', 'ListAgents', JSON.stringify({ agents: 'nope' }), false],
    ['list-2', 'ListAgents', JSON.stringify({ agents: [null, 7, { sessionId: '' }, { sessionId: 'agent-5', title: 9, status: 'idle', waitingOn: 3 }] }), false],
    ['list-3', 'ListAgents', JSON.stringify([1, 2]), false],
  ]) {
    use(toolUseId, name)
    j.say({ type: 'tool_result', messageId: `r-${toolUseId}`, toolUseId, content, ...(isError ? { isError } : {}) })
  }
  j.say({ type: 'tool_result', messageId: 'r-orphan', toolUseId: 'orphan', content: JSON.stringify({ sessionId: 'agent-x' }) })
  await j.f.provider.flush()
  assert.equal(j.f.provider.isFenced(), false)
  assert.deepEqual(j.f.saved.missionV2Agents.agents.map(row => [row.sessionId, row.title, row.status, row.waitingOn]),
    [['agent-4', null, 'running', null], ['agent-5', null, 'idle', 'unknown']])
  assert.deepEqual(validateProviderRecord(j.f.saved, j.f.context), j.f.saved)
})
await test('v2-agents tag and dialect faults: lost tag, changed kind or missionId, legacy v2 or v1 facts', async () => {
  for (const [code, steps] of [
    ['sdk_mission_v2_tag_changed', j => j.say({ type: 'settings_updated', settings: { tags: [] } })],
    ['sdk_mission_v2_tag_changed', j => j.say({ type: 'settings_updated', settings: { tags: [{ name: 'other' }] } })],
    ['sdk_mission_v2_tag_changed', j => j.say({ type: 'settings_updated', settings: { tags: orchestratorTag('someone-else') } })],
    ['sdk_mission_v2_tag_changed', j => j.say({ type: 'settings_updated', settings: { tags: [{ name: 'mission-v2', metadata: { kind: 'agent', missionId: j.root } }] } })],
    ['sdk_mission_dialect_mixed', j => j.say({ type: 'settings_updated', settings: { tags: [{ name: 'mission-v2' }] } })],
    ['sdk_mission_dialect_mixed', j => j.f.emit(v2Request(j.root, 'recommend-1', v2Recommend))],
    ['sdk_mission_dialect_mixed', j => j.f.emit(v2Request(j.root, 'plan-1', v2Plan))],
    ['sdk_mission_dialect_mixed', j => j.say({ type: 'mission_v2_snapshot_changed', snapshot: v2Snapshot(j.root) })],
    ['sdk_mission_dialect_mixed', j => j.say({ type: 'mission_state_changed', state: 'running' })],
    ['sdk_mission_dialect_mixed', j => j.f.emit(permission(j.root, 'proposal', { type: 'propose_mission', proposal: 'v1 plan' }))],
  ]) {
    const j = await agentsJourney()
    await j.replay(row => row.notification.type === 'settings_updated')
    steps(j); await j.f.provider.flush()
    assert.equal(j.f.provider.isFenced(), true, code); assert.equal(j.f.saved.ingestionFault, code)
  }
  // A mismatched orchestrator tag before adoption is its own fault.
  const untagged = await agentsJourney({ initTags: null })
  untagged.say({ type: 'settings_updated', settings: { tags: orchestratorTag('someone-else') } }); await untagged.f.provider.flush()
  assert.equal(untagged.f.saved.ingestionFault, 'sdk_mission_v2_tag_mismatch')
  // Legacy v2 first, then a 0.238 tag: mixed.
  const legacy = await agentsJourney({ initTags: () => [{ name: 'mission-v2' }] })
  legacy.say({ type: 'settings_updated', settings: { tags: orchestratorTag(legacy.root) } }); await legacy.f.provider.flush()
  assert.equal(legacy.f.saved.ingestionFault, 'sdk_mission_dialect_mixed')
  // Settings updates without tags, and metadata growth, are not faults.
  const ok = await agentsJourney()
  ok.say({ type: 'settings_updated', settings: { interactionMode: 'mission' } })
  ok.say({ type: 'settings_updated', settings: { tags: orchestratorTag(ok.root, { spaceId: 'space-1', extra: 'grown' }) } })
  await ok.f.provider.flush()
  assert.equal(ok.f.provider.isFenced(), false)
})
await test('v2-agents unknown permission types stay confirmation handoffs; droid gating maps to clear faults', async () => {
  const j = await agentsJourney()
  j.f.emit(permission(j.root, 'workstream-1', { type: 'propose_workstream', title: 'Split the work', workstreams: [{ id: 'w1' }] }))
  await j.f.provider.flush()
  const row = j.f.saved.requests.find(item => item.attention.requestId === 'workstream-1')
  assert.equal(row.unsupportedReason, 'sdk_confirmation_handoff'); assert.equal(row.attention.kind, 'unsupported')
  assert.equal(j.f.provider.isFenced(), false)
  await assert.rejects(j.f.provider.answer(j.f.answerPayload(row.attention, { selectedOption: 'proceed_once' }),
    { ...j.f.context, commandId: 'workstream-answer' }), { code: 'sdk_attention_handoff' })
  // A root tool error carrying droid's Missions 2.0 gating reason fences with a named fault.
  j.say({ type: 'create_message', message: { id: 'm-gated', role: 'assistant', createdAt: NOW, updatedAt: NOW,
    content: [{ type: 'tool_use', id: 'spawn-gated', name: 'SpawnAgent', input: { title: 't', prompt: 'p' } }] } })
  j.say({ type: 'tool_result', messageId: 'r-gated', toolUseId: 'spawn-gated', isError: true,
    content: 'Missions 2.0 is not available for this organization (missions_v2_disabled)' })
  await j.f.provider.flush()
  assert.equal(j.f.saved.ingestionFault, 'sdk_missions_v2_disabled')
  for (const [reason, code] of [
    ['missions_v2_access_restricted', 'sdk_missions_v2_access_restricted'],
    ['missions_v2_access_unavailable', 'sdk_missions_v2_access_unavailable'],
    ['mission_v2_session_not_active', 'sdk_mission_v2_session_not_active'],
    ['mission_v2_legacy_mission_active', 'sdk_mission_v2_legacy_mission_active'],
  ]) {
    const error = Object.assign(new Error('Missions 2.0 refused'), { data: { reason } })
    const f = fixture({ agentTools: true, initializeError: error })
    await f.provider.preflight(f.intent, f.context)
    await assert.rejects(f.provider.launch(f.intent, f.context), { code: 'sdk_initialize_outcome_unknown' })
    assert.equal(f.saved.initialize.state, 'unknown'); assert.equal(f.saved.recoveryHold, true)
    assert.equal(f.saved.initialize.fault, code); assert.ok(f.diagnostics.some(row => row.code === code))
  }
})
await test('v2-agents provider record corruption is rejected', async () => {
  const j = await agentsJourney()
  await j.replay()
  await j.listAgents('call_list_idle', [idleAgent()])
  await j.finishTurn(); j.advance(2000); await j.observe()
  assert.notEqual(j.f.saved.missionV2Agents.completed, null)
  for (const mutate of [
    row => { row.dialect = 'v2' }, row => { delete row.missionV2Agents },
    row => { row.missionV2Agents.tag.kind = 'agent' }, row => { row.missionV2Agents.tag.missionId = 'other' },
    row => { row.missionV2Agents.agents.push(clone(row.missionV2Agents.agents[0])) },
    row => { row.missionV2Agents.agents[0].status = 'done' },
    row => { row.missionV2Agents.agents[0].sessionId = row.rootSessionId },
    row => { row.missionV2Agents.rootBusySeq = row.missionV2Agents.seq + 1 },
    row => { row.missionV2Agents.completed.lateActivity = 2 },
    row => { row.missionV2Agents.toolUses.push({ toolUseId: 'x', name: 'SendMessage', title: null, seq: 1 }) },
    row => { row.missionV2Agents.extra = true },
    row => { row.missionV2 = { seq: 0 } },
  ]) {
    const bad = clone(j.f.saved); mutate(bad)
    assert.throws(() => validateProviderRecord(bad, j.f.context))
  }
})
await test('pure v2-agents derivation and parsing mirror the design table', () => {
  const agent = { sessionId: AGENT_ID, title: 'Greeting', status: 'idle', waitingOn: null, source: 'list', firstSeenAt: stamp, listedAt: stamp, seq: 1 }
  const base = { dialect: 'v2-agents', openAttention: false, rootWorkingState: 'idle', lastTurn: { reason: 'completed', current: true, observedAt: stamp },
    settled: true, agents: [agent], agentsOverflow: false, completed: null, faulted: false, live: true }
  assert.equal(deriveMissionV2AgentsState(base), 'completed')
  assert.equal(deriveMissionV2AgentsState({ ...base, dialect: 'v2' }), null)
  assert.equal(deriveMissionV2AgentsState({ ...base, live: false }), 'awaiting_input')
  assert.equal(deriveMissionV2AgentsState({ ...base, settled: false }), 'awaiting_input')
  assert.equal(deriveMissionV2AgentsState({ ...base, faulted: true }), 'awaiting_input')
  assert.equal(deriveMissionV2AgentsState({ ...base, agentsOverflow: true }), 'awaiting_input')
  assert.equal(deriveMissionV2AgentsState({ ...base, agents: [] }), 'completed') // orchestrator did the work itself
  assert.equal(deriveMissionV2AgentsState({ ...base, agents: [{ ...agent, status: 'running' }] }), 'awaiting_input')
  assert.equal(deriveMissionV2AgentsState({ ...base, lastTurn: { ...base.lastTurn, current: false } }), 'awaiting_input')
  assert.equal(deriveMissionV2AgentsState({ ...base, lastTurn: { ...base.lastTurn, reason: 'cancelled' } }), 'awaiting_input')
  assert.equal(deriveMissionV2AgentsState({ ...base, openAttention: true }), 'awaiting_input')
  assert.equal(deriveMissionV2AgentsState({ ...base, rootWorkingState: 'thinking' }), 'running')
  assert.equal(deriveMissionV2AgentsState({ ...base, rootWorkingState: null }), 'running')
  const latched = { observedAt: stamp, seq: 2, lateActivity: 1, lastLateActivityAt: stamp }
  assert.equal(deriveMissionV2AgentsState({ ...base, rootWorkingState: 'thinking', openAttention: true, completed: latched }), 'completed')
  assert.deepEqual(projectV2AgentFeatures([agent, { ...agent, sessionId: 'a-2', status: 'running', title: null },
    { ...agent, sessionId: 'a-3', status: 'pending' }, { ...agent, sessionId: 'a-4', status: 'unknown' }]).map(row => [row.description, row.status]),
  [['Greeting', 'completed'], ['Agent a-2', 'in_progress'], ['Greeting', 'pending'], ['Greeting', 'pending']])
  assert.equal(projectV2AgentFeatures([agent, agent]), null)
  assert.deepEqual(parseMissionV2AgentResult('SpawnAgent', '{"sessionId":"a-1"}'), { kind: 'spawned', sessionId: 'a-1' })
  assert.equal(parseMissionV2AgentResult('SendMessage', '{"sessionId":"a-1"}'), null)
  assert.equal(parseMissionV2AgentResult('ListAgents', '{"agents":{}}'), null)
})

// ---- regression: size bounds apply after opaque reasoning is stripped ----
const bigOpaque = bytes => 'A'.repeat(bytes)
await test('a frame over 256 KiB only because of opaque reasoning decodes and stores no blob', () => {
  const frame = blob => notification('root-1', { type: 'create_message', message: {
    id: 'msg-big', role: 'assistant', createdAt: 1, updatedAt: 1, openaiEncryptedContent: blob,
    content: [{ type: 'thinking', thinking: 'plan', signature: blob }, { type: 'redacted_thinking', data: blob }, { type: 'text', text: 'Done.' }],
  } })
  const result = safeDecodeSdkEnvelope(JSON.stringify(frame(bigOpaque(100000))), decodeContext)
  assert.equal(result.kind, 'notification')
  assert.ok(JSON.stringify(result.envelope).length < 4096)
  // Beyond the transport limit the raw frame is still refused.
  assert.equal(safeDecodeSdkEnvelope(frame(bigOpaque(400000)), decodeContext).kind, 'diagnostic')
  // The stored envelope keeps the 256 KiB bound once stripped.
  const text = notification('root-1', { type: 'create_message', message: message('msg-text', 'x'.repeat(270000)) })
  assert.equal(safeDecodeSdkEnvelope(text, decodeContext).kind, 'diagnostic')
})
await test('observe reads a message page over 256 KiB only because of opaque reasoning', async () => {
  const heavy = index => ({ ...message(`heavy-${index}`, `Reasoned line ${index}.`), openaiEncryptedContent: bigOpaque(60000),
    content: [{ type: 'thinking', thinking: 'plan', signature: bigOpaque(30000) }, { type: 'text', text: `Reasoned line ${index}.` }] })
  const f = fixture({ messagePage: () => ({ messages: Array.from({ length: 5 }, (_, index) => heavy(index)), hasMore: false }) })
  const launched = await f.launch()
  const observed = await f.provider.observe(launched.binding, { ...f.context, readOnly: true })
  assert.ok(observed.presentSections.includes('history'))
  assert.deepEqual(observed.history.map(row => row.text), [0, 1, 2, 3, 4].map(index => `Reasoned line ${index}.`))
  assert.ok(!JSON.stringify(observed).includes(bigOpaque(1000)))
})
await test('v2-agents progress keeps the newest rows inside the byte budget behind an omission marker', () => {
  const agents = Array.from({ length: 200 }, (_, index) => ({
    sessionId: `agent-${index}`, title: 'T'.repeat(512), source: 'spawn', status: 'idle', waitingOn: null,
    firstSeenAt: new Date(NOW + index * 1000).toISOString(), listedAt: new Date(NOW + index * 1000 + 500).toISOString(),
  }))
  const rows = projectV2AgentProgress({ agents, lastTurn: null, completed: null })
  assert.ok(Buffer.byteLength(JSON.stringify(rows)) <= 65536 + 1024)
  assert.equal(rows[0].type, 'progress_omitted')
  assert.equal(rows[0].omittedCount, 400 - (rows.length - 1))
  assert.equal(rows.at(-1).agentSessionId, 'agent-199')
  assert.ok(!rows.some(row => row.agentSessionId === 'agent-0'))
  // A small mission is returned whole, with no marker.
  const small = projectV2AgentProgress({ agents: agents.slice(0, 3), lastTurn: null, completed: null })
  assert.equal(small.length, 6); assert.ok(!small.some(row => row.type === 'progress_omitted'))
})
await test('v1 observe projects the persisted features, progress and worker sessions', async () => {
  const f = fixture(); const launched = await f.launch(), root = f.saved.rootSessionId
  const sdkFeature = (id, status) => ({ id, description: `Feature ${id}`, status, skillName: 'impl', preconditions: [], expectedBehavior: ['Works.'] })
  f.emit(notification(root, { type: 'mission_features_changed', features: [sdkFeature('f-1', 'completed'), sdkFeature('f-2', 'in_progress')] }))
  f.emit(notification(root, { type: 'mission_progress_entry', progressLog: [{ type: 'mission_accepted', timestamp: stamp, title: 'One' }] }))
  f.emit(notification(root, { type: 'mission_worker_started', workerSessionId: 'worker-1' }))
  await f.provider.flush()
  assert.equal(f.saved.dialect, 'v1')
  const observed = await f.provider.observe(launched.binding, { ...f.context, readOnly: true })
  assert.deepEqual(observed.features.map(row => [row.id, row.status]), [['f-1', 'completed'], ['f-2', 'in_progress']])
  assert.equal(observed.progressLog[0].title, 'One')
  assert.deepEqual(observed.workerSessionIds, ['worker-1'])
  assert.ok(observed.sessionIds.includes('worker-1'))
  for (const section of ['features', 'progress', 'workers']) assert.ok(observed.presentSections.includes(section))
  // Duplicate feature ids cannot be represented: the section is omitted, never clipped.
  f.emit(notification(root, { type: 'mission_features_changed', features: [sdkFeature('f-1', 'completed'), sdkFeature('f-1', 'pending')] }))
  await f.provider.flush()
  const again = await f.provider.observe(launched.binding, { ...f.context, readOnly: true })
  assert.equal(again.presentSections.includes('features'), false)
  assert.deepEqual(again.features, [])
})

console.log(`Native provider offline qualification: ${count} cases passed. Real SDK/host qualification remains unavailable.`)
