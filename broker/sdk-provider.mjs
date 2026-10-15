/**
 * Owned, injected public DaemonClient port. No SDK import, process, controller,
 * session load, answer replay, inferred control or production qualification.
 */
import { randomUUID } from 'node:crypto'
import {
  admissionDraft, admissionPreview, array, attention as checkAttention, bool, boundedJson, clone, digest, fail, hash, id,
  int, NATIVE_RESPONSE_MAX_BYTES, object, one, secretFree, settings, str, time, unique, validateBinding, workspace,
} from './validation.mjs'
import {
  freezeNative, getNativeHashes, NATIVE_REASONING_EFFORTS, requireMissionV2Tools, validateFullGitRef, validateGitSha,
} from './native-policy.mjs'
import {
  correlateNativeResolution, decodeSdkEnvelope, MISSION_STATES, MISSION_V2_INITIALIZE_TAGS, missionDialectOf,
  missionV2GatingFault, missionV2RequestType, missionV2TagDialect, missionV2TagOf, outgoingDescriptor,
  requestPayload, safeDecodeSdkEnvelope, SDK_TRANSPORT_VERSION, validateMissionV2Snapshot, validateSdkMessage, withoutOpaque,
  isInternalSdkMessage,
} from './sdk-wire.mjs'
import {
  checkMissionV2Record, deriveMissionV2AgentsState, deriveMissionV2State, MISSION_V2_AGENTS_MAX,
  MISSION_V2_AGENTS_NO_RECORD, MISSION_V2_AGENTS_SETTLE_MS, missionV2AgentsInputs, missionV2AgentsSettled,
  missionV2Inputs, missionV2WorkerSessionIds, normalizeMissionV2Record, parseMissionV2AgentResult,
  projectV1Features, projectV1Progress, projectV2AgentFeatures, projectV2AgentProgress, projectV2Features, projectV2Progress,
} from './mission-v2-state.mjs'
import { isHostQualificationFor } from './qualification.mjs'

// Sized to hold the broker's per-request raw bound (128 KiB) plus a full
// 256 KiB notification envelope for one plan proposal, with ledger headroom.
const MAX_RECORD_BYTES = 524288
// Minimal surviving record after a persistence fault: the last committed record
// minus notification history/child traffic, plus the fault code.
const MAX_FAULT_BYTES = 262144
// Message rows are kept in the record only for identity tracking; content for
// observe() comes from get_session_messages. Beyond this many rows, only {id, text} stay.
const HISTORY_IDENTITY_ROWS = 512
const STEP_STATES = ['prepared', 'invoked', 'confirmed', 'unknown']
const READ_METHODS = new Set([
  'daemon.inspect_mission_readiness', 'daemon.list_opened_sessions',
  'daemon.list_available_sessions', 'daemon.get_session_messages', 'daemon.list_models',
])
const ANCHORS = ['ownerId', 'missionId', 'machineId', 'scopeHash', 'policyHash']
const nullable = (value, visit) => { if (value !== null) visit(value) }
const assertBinding = (actual, expected) => {
  for (const key of ANCHORS) if (actual[key] !== expected[key]) fail('sdk_provider_binding_mismatch')
}
const hostBinding = context => Object.fromEntries([...ANCHORS, 'epoch'].map(key => [key, context[key]]))
const date = now => new Date(now()).toISOString()
const ADMISSION_SETTINGS = [
  'modelId', 'reasoningEffort', 'workerModel', 'workerReasoningEffort',
  'validationWorkerModel', 'validationWorkerReasoningEffort', 'restrictToolIds',
  'skipScrutiny', 'skipUserTesting',
]
const ADMISSION_POLICY_HOLDS = new Set([
  'native_unrepresented_restriction', 'native_budget_boundary_required',
  'native_budget_exceeds_deployment', 'native_provisioning_or_publication_unavailable',
  'native_host_boundary_unavailable', 'native_deploy_unavailable', 'native_consequence_dependency_invalid',
  'native_new_repository_requires_create_permission', 'native_new_repository_must_be_private', 'native_new_repository_requires_push',
  'native_create_repository_requires_new_destination', 'native_restriction_conflicts_policy',
])
// Lifted only by a verified host qualification record for this exact deployment and host key.
const HOST_QUALIFIED_HOLDS = new Set(['live_sdk_qualification', 'native_enforcement_lease_unavailable'])
/**
 * Structural holds an owner-trusted host accepts as known risks. Policy-compile
 * holds (destination, consequences, restrictions, budget) are never in here.
 */
export const TRUSTED_HOST_ACCEPTED_RISKS = Object.freeze([
  'native_child_attention', 'passive_authoritative_pending_recovery', 'live_sdk_qualification',
  'native_enforcement_lease_unavailable', 'sdk_high_autonomy_unobserved', 'sdk_mission_settings_unconfirmed',
  'native_credential_isolation_unproven', 'native_daemon_authentication_unqualified',
  'native_process_tree_revocation_unproven', 'native_new_repository_initialization_unqualified',
  'native_prospective_workspace_only',
])
const TRUSTED_LIFTED = new Set(TRUSTED_HOST_ACCEPTED_RISKS)

function checkHostBinding(row) {
  object(row, [...ANCHORS, 'epoch'])
  for (const key of ['ownerId', 'missionId', 'machineId']) id(row[key])
  digest(row.scopeHash); digest(row.policyHash); int(row.epoch, 1)
}
function checkProof(row) {
  object(row, ['attestationId', 'nonce', 'binding', 'executionHostId', 'executionInstanceId',
    'canonicalCwd', 'canonicalRepoRoot', 'canonicalGitDir', 'canonicalCommonDir', 'rootIdentity',
    'gitDirIdentity', 'repositoryId', 'objectFormat', 'baseRef', 'baseSha', 'initialHeadSha',
    'executionRef', 'checkoutGeneration', 'observedAt', 'expiresAt', 'evidenceIds'])
  checkHostBinding(row.binding)
  for (const key of ['attestationId', 'nonce', 'executionHostId', 'executionInstanceId', 'repositoryId',
    'checkoutGeneration']) str(row[key], 512)
  for (const key of ['canonicalCwd', 'canonicalRepoRoot', 'canonicalGitDir', 'canonicalCommonDir']) {
    str(row[key], 2048); if (!row[key].startsWith('/')) fail('sdk_noncanonical_workspace')
  }
  for (const key of ['rootIdentity', 'gitDirIdentity']) {
    object(row[key], ['device', 'inode']); str(row[key].device, 128); str(row[key].inode, 128)
  }
  one(row.objectFormat, ['sha1', 'sha256'])
  const length = row.objectFormat === 'sha1' ? 40 : 64
  for (const key of ['baseSha', 'initialHeadSha']) {
    if (typeof row[key] !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`).test(row[key])) fail('sdk_invalid_workspace_sha')
  }
  str(row.baseRef, 256); nullable(row.executionRef, value => str(value, 256))
  time(row.observedAt); time(row.expiresAt)
  array(row.evidenceIds, 128, value => str(value, 512)); if (!row.evidenceIds.length) fail('sdk_workspace_evidence_missing')
}
function checkLease(row) {
  object(row, ['leaseId', 'binding', 'workspaceAttestationId', 'deploymentDigest', 'boundaryPolicyHash',
    'revocationGeneration', 'expiresAt', 'budget', 'evidenceIds'])
  checkHostBinding(row.binding)
  str(row.leaseId, 512); str(row.workspaceAttestationId, 512)
  digest(row.deploymentDigest); digest(row.boundaryPolicyHash); int(row.revocationGeneration); time(row.expiresAt)
  if (row.budget?.enforcement !== undefined) {
    object(row.budget, ['enforcement']); one(row.budget.enforcement, ['none'])
  } else {
    object(row.budget, ['accountId', 'unit', 'capUnits', 'enforcementId'])
    for (const key of Object.keys(row.budget)) str(row.budget[key], 512)
    if (!/^[1-9]\d{0,63}$/.test(row.budget.capUnits)) fail('sdk_invalid_budget_receipt')
  }
  array(row.evidenceIds, 128, value => str(value, 512)); if (!row.evidenceIds.length) fail('sdk_lease_evidence_missing')
}
/**
 * Loose list_available_sessions `mission` shape for rows we do not own: 'v1',
 * 'v2', 'unknown' or null. Never throws: an unrelated session with odd metadata
 * must not fence our observation. Strict validation happens only for owned rows.
 */
function rowMissionShape(mission) {
  if (!mission) return null
  if (typeof mission !== 'object' || Array.isArray(mission)) return 'unknown'
  if (MISSION_STATES.includes(mission.state)) return 'v1'
  if (typeof mission.planHash === 'string' && typeof mission.checksHash === 'string' &&
      typeof mission.sessionId === 'string') return 'v2'
  return 'unknown'
}
/** Strict `mission` metadata validation, only for the root row and owned children. */
function checkOwnedMissionShape(mission, shape) {
  if (shape === 'v1') {
    for (const key of ['title', 'workingDirectory', 'createdAt', 'updatedAt']) {
      if (mission[key] !== undefined && mission[key] !== null) str(mission[key], 8192, true)
    }
    for (const key of ['elapsedMs', 'completedFeatures', 'totalFeatures']) {
      if (mission[key] !== undefined && mission[key] !== null && !Number.isFinite(mission[key])) fail('sdk_session_mission_invalid')
    }
    return
  }
  if (shape === 'v2') {
    try { validateMissionV2Snapshot(mission) } catch { fail('sdk_session_mission_invalid') }
    return
  }
  if (mission) fail('sdk_session_mission_invalid')
}
// Flat text prefix for message identity tracking, small enough that the full
// retention window cannot push the record over its persistence budget.
const historyText = message => message.content.filter(block => block.type === 'text')
  .map(block => block.text).join('\n').slice(0, 160)
const lastAssistantText = messages => {
  const rows = [...messages].filter(message => message.role === 'assistant')
    .sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt)
  for (const message of rows) {
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
    if (text) return text
  }
  return null
}
/** Finalization fields from the latest assistant text, or {} when there is none. */
function closingSummary(messages, workersSettled) {
  const summary = lastAssistantText(messages.values())
  if (!summary) return {}
  // A long closing summary is display text: a marked prefix never blocks completion.
  const truncated = summary.length > 4096
  return {
    summary: truncated ? `${summary.slice(0, 4082)}\n… [truncated]` : summary,
    summaryTruncated: truncated, workersSettled,
  }
}
function checkMissionV2Facts(value) {
  const m = value.missionV2, corrupt = () => fail('sdk_provider_mission_v2_corrupt')
  object(m, ['seq', 'approval', 'snapshot', 'rootWorking', 'rootBusySeq', 'lastTurn', 'workers', 'toolResults'],
    ['seq', 'approval', 'snapshot', 'rootWorking', 'rootBusySeq', 'lastTurn', 'workers'])
  int(m.seq); int(m.rootBusySeq); if (m.rootBusySeq > m.seq) corrupt()
  const seq = item => { int(item, 1); if (item > m.seq) corrupt() }
  nullable(m.approval, row => {
    object(row, ['attentionId', 'proposalHash', 'observedAt', 'seq'])
    id(row.attentionId); digest(row.proposalHash); time(row.observedAt); seq(row.seq)
    const request = value.requests.find(item => item.attention.attentionId === row.attentionId)
    const proof = value.resolutions.find(item => item.attentionId === row.attentionId)
    if (!request || missionV2RequestType(request) !== 'exit_mission_planning' || request.proposalHash !== row.proposalHash ||
        request.attention.sessionId !== value.rootSessionId || !proof || proof.effect.kind !== 'permission_effect' ||
        proof.effect.selectedOption !== 'proceed_once' || proof.observedAt !== row.observedAt) corrupt()
  })
  nullable(m.snapshot, row => {
    object(row, ['envelope', 'observedAt', 'seq']); time(row.observedAt); seq(row.seq)
    const decoded = decodeSdkEnvelope(row.envelope, {
      machineId: value.machineId, connectionId: value.connectionId, rootSessionId: value.rootSessionId, observedAt: row.observedAt,
    })
    if (decoded.kind !== 'notification' || decoded.sessionId !== value.rootSessionId ||
        decoded.envelope.params.notification.type !== 'mission_v2_snapshot_changed' ||
        decoded.envelope.params.notification.snapshot.sessionId !== value.rootSessionId) corrupt()
  })
  nullable(m.rootWorking, row => { object(row, ['state', 'observedAt', 'seq']); str(row.state, 128); time(row.observedAt); seq(row.seq) })
  if (m.rootWorking && m.rootWorking.state !== 'idle' && m.rootBusySeq !== m.rootWorking.seq) corrupt()
  nullable(m.lastTurn, row => {
    object(row, ['reason', 'turnId', 'observedAt', 'seq'])
    str(row.reason, 128); nullable(row.turnId, item => str(item, 512)); time(row.observedAt); seq(row.seq)
  })
  array(m.workers, 256, row => {
    object(row, ['childSessionId', 'toolUseId', 'subagentType', 'description', 'startedAt', 'startSeq',
      'finishedAt', 'finishSeq', 'failed'])
    id(row.childSessionId); id(row.toolUseId); nullable(row.subagentType, item => str(item, 256))
    nullable(row.description, item => str(item, 65536, true)); time(row.startedAt); seq(row.startSeq)
    nullable(row.finishedAt, time); nullable(row.finishSeq, seq); nullable(row.failed, bool)
    if ((row.finishedAt === null) !== (row.finishSeq === null) || (row.finishedAt === null) !== (row.failed === null) ||
        (row.finishSeq !== null && row.finishSeq <= row.startSeq)) corrupt()
    const session = value.sessions.find(item => item.sessionId === row.childSessionId)
    if (!session || session.parentSessionId !== value.rootSessionId) corrupt()
  })
  unique(m.workers.map(row => row.childSessionId)); unique(m.workers.map(row => row.toolUseId))
  // Root-session tool_result toolUseIds (including ones seen before their child registered).
  if (m.toolResults !== undefined) {
    array(m.toolResults, 512, row => {
      object(row, ['toolUseId', 'seq', 'failed'])
      id(row.toolUseId); seq(row.seq); bool(row.failed)
    })
    unique(m.toolResults.map(row => row.toolUseId))
  }
}

// Root tool uses whose results carry agent facts; other agent tools are activity only.
const AGENT_RESULT_TOOLS = ['SpawnAgent', 'ListAgents']
const AGENT_TOOL_USES_MAX = 128
function checkMissionV2AgentsFacts(value) {
  const m = value.missionV2Agents, corrupt = () => fail('sdk_provider_mission_v2_agents_corrupt')
  object(m, ['seq', 'tag', 'rootWorking', 'rootBusySeq', 'lastTurn', 'agents', 'agentsOverflow', 'toolUses', 'toolResults', 'completed'])
  int(m.seq); int(m.rootBusySeq); if (m.rootBusySeq > m.seq) corrupt()
  const seq = item => { int(item, 1); if (item > m.seq) corrupt() }
  object(m.tag, ['kind', 'missionId'])
  if (m.tag.kind !== 'orchestrator' || m.tag.missionId !== value.rootSessionId) corrupt()
  nullable(m.rootWorking, row => { object(row, ['state', 'observedAt', 'seq']); str(row.state, 128); time(row.observedAt); seq(row.seq) })
  if (m.rootWorking && m.rootWorking.state !== 'idle' && m.rootBusySeq < m.rootWorking.seq) corrupt()
  nullable(m.lastTurn, row => {
    object(row, ['reason', 'turnId', 'observedAt', 'seq'])
    str(row.reason, 128); nullable(row.turnId, item => str(item, 512)); time(row.observedAt); seq(row.seq)
  })
  array(m.agents, MISSION_V2_AGENTS_MAX, row => {
    object(row, ['sessionId', 'title', 'status', 'waitingOn', 'source', 'firstSeenAt', 'listedAt', 'seq'])
    id(row.sessionId); nullable(row.title, item => str(item, 512))
    nullable(row.status, item => one(item, ['idle', 'pending', 'running', 'unknown']))
    nullable(row.waitingOn, item => str(item, 128)); one(row.source, ['spawn', 'list'])
    time(row.firstSeenAt); nullable(row.listedAt, time); seq(row.seq)
    if (row.sessionId === value.rootSessionId) corrupt()
  })
  unique(m.agents.map(row => row.sessionId)); bool(m.agentsOverflow)
  array(m.toolUses, AGENT_TOOL_USES_MAX, row => {
    object(row, ['toolUseId', 'name', 'title', 'seq']); id(row.toolUseId); one(row.name, AGENT_RESULT_TOOLS)
    nullable(row.title, item => str(item, 512)); seq(row.seq)
  })
  unique(m.toolUses.map(row => row.toolUseId))
  array(m.toolResults, 512, row => { object(row, ['toolUseId', 'seq', 'failed']); id(row.toolUseId); seq(row.seq); bool(row.failed) })
  unique(m.toolResults.map(row => row.toolUseId))
  nullable(m.completed, row => {
    object(row, ['observedAt', 'seq', 'lateActivity', 'lastLateActivityAt'])
    time(row.observedAt); seq(row.seq); int(row.lateActivity); nullable(row.lastLateActivityAt, time)
    if ((row.lateActivity === 0) !== (row.lastLateActivityAt === null)) corrupt()
  })
}

/** Store decoder: strict stable v1 structure, recursively bounded and secret-free. */
export function validateProviderRecord(value, expectedBindingContext) {
  boundedJson(value, MAX_RECORD_BYTES); secretFree(value)
  const required = ['version', ...ANCHORS, 'rootSessionId', 'epoch', 'scopeRevision', 'connectionId',
    'workspace', 'goalText', 'initializeParams', 'compiledPolicyHash', 'workspaceProof', 'enforcementLease',
    'initialize', 'goal', 'binding', 'effectiveSettings', 'settingsObservedAt', 'sessions',
    'requests', 'answerAttempts', 'resolutions', 'observations', 'ingestionFault', 'recoveryHold']
  // Mission dialect fields are optional so records written before v2 support stay valid.
  object(value, [...required, 'dialect', 'missionV2', 'missionV2Agents', 'settingsUnconfirmed'], required)
  one(value.version, [1]); checkHostBinding(hostBinding(value)); assertBinding(value, expectedBindingContext)
  const dialect = value.dialect ?? null
  if (dialect !== null) one(dialect, ['v1', 'v2', 'v2-agents'])
  const hasV2 = value.missionV2 !== undefined && value.missionV2 !== null
  const hasAgents = value.missionV2Agents !== undefined && value.missionV2Agents !== null
  if (hasV2 !== (dialect === 'v2') || hasAgents !== (dialect === 'v2-agents')) fail('sdk_provider_dialect_corrupt')
  const consistent = fact => {
    if (fact === 'mixed' || (fact === 'v2' && dialect !== 'v2') || (fact === 'v2-agents' && dialect !== 'v2-agents') ||
        (fact === 'v1' && (dialect === 'v2' || dialect === 'v2-agents'))) fail('sdk_provider_dialect_corrupt')
  }
  if (expectedBindingContext.epoch !== undefined && value.epoch > expectedBindingContext.epoch) fail('sdk_provider_future_epoch')
  id(value.rootSessionId); int(value.scopeRevision, 1); str(value.connectionId, 160)
  workspace(value.workspace); str(value.goalText, 65536); digest(value.compiledPolicyHash)
  if (value.workspace.machineId !== value.machineId) fail('sdk_provider_workspace_mismatch')
  const params = value.initializeParams
  // `tags` is optional so records compiled before the droid 0.238 entry tag stay valid.
  object(params, ['machineId', 'cwd', 'sessionId', 'interactionMode', 'autonomyLevel', 'modelId',
    'reasoningEffort', 'missionSettings', 'restrictToolIds', 'autoRejectPermissionRequests', 'tags'],
  ['machineId', 'cwd', 'sessionId', 'interactionMode', 'autonomyLevel', 'modelId',
    'reasoningEffort', 'missionSettings', 'restrictToolIds', 'autoRejectPermissionRequests'])
  if (Object.hasOwn(params, 'tags') && hash(params.tags) !== hash(MISSION_V2_INITIALIZE_TAGS)) fail('sdk_provider_initialize_corrupt')
  if (params.machineId !== value.machineId || params.cwd !== value.workspace.cwd ||
      params.sessionId !== value.rootSessionId) fail('sdk_provider_initialize_corrupt')
  one(params.interactionMode, ['mission']); one(params.autonomyLevel, ['high'])
  str(params.modelId, 256); str(params.reasoningEffort, 256)
  object(params.missionSettings, ['workerModel', 'workerReasoningEffort', 'validationWorkerModel',
    'validationWorkerReasoningEffort', 'skipScrutiny', 'skipUserTesting'])
  for (const key of ['workerModel', 'workerReasoningEffort', 'validationWorkerModel', 'validationWorkerReasoningEffort']) {
    str(params.missionSettings[key], 256)
  }
  one(params.missionSettings.skipScrutiny, [false]); one(params.missionSettings.skipUserTesting, [false])
  one(params.autoRejectPermissionRequests, [false]); array(params.restrictToolIds, 128, id); unique(params.restrictToolIds)
  if (expectedBindingContext.binding) {
    const { sessionId: _, ...bound } = expectedBindingContext.binding
    const { baseSha = null, ...source } = value.workspace
    if (hash({ ...source, baseSha }) !== hash(bound)) fail('sdk_provider_workspace_mismatch')
    if (hash(value.binding) !== hash(expectedBindingContext.binding)) fail('sdk_provider_session_mismatch')
  }
  for (const key of ['initialize', 'goal']) {
    const step = value[key]
    object(step, ['state', 'requestHash', 'rpcId', 'messageId', 'receiptHash', 'fault'])
    one(step.state, STEP_STATES); digest(step.requestHash)
    nullable(step.rpcId, id); nullable(step.messageId, id); nullable(step.receiptHash, digest)
    nullable(step.fault, code => str(code, 160))
    if (step.state === 'confirmed' && !step.receiptHash) fail('sdk_provider_missing_receipt')
  }
  // initializeSession has no caller-selectable RPC ID; never invent one.
  if (value.initialize.rpcId !== null || value.initialize.messageId !== null) fail('sdk_initialize_rpc_id_not_public')
  if (!value.goal.rpcId || !value.goal.messageId) fail('sdk_goal_ids_missing')
  const owned = hash([value.ownerId, value.missionId, value.machineId, value.scopeHash, value.policyHash])
  if (value.rootSessionId !== ownedRootSessionId(owned) || value.goal.rpcId !== `goal-${owned}` ||
      value.goal.messageId !== `message-${owned}`) fail('sdk_provider_owned_ids_corrupt')
  if (value.initialize.requestHash !== hash({ method: 'daemon.initialize_session', params }) ||
      value.goal.requestHash !== hash({
        method: 'daemon.add_user_message', id: value.goal.rpcId,
        params: { sessionId: value.rootSessionId, messageId: value.goal.messageId, text: value.goalText },
      })) fail('sdk_provider_step_hash_corrupt')
  nullable(value.workspaceProof, row => {
    checkProof(row); assertBinding(row.binding, value)
    if (row.binding.epoch !== value.epoch || row.canonicalCwd !== value.workspace.cwd ||
        row.repositoryId !== value.workspace.repository || row.baseRef !== value.workspace.baseRef ||
        row.baseSha !== value.workspace.baseSha) fail('sdk_provider_workspace_proof_corrupt')
  })
  nullable(value.enforcementLease, row => {
    checkLease(row); assertBinding(row.binding, value)
    if (!value.workspaceProof || row.binding.epoch !== value.epoch ||
        row.workspaceAttestationId !== value.workspaceProof.attestationId ||
        row.boundaryPolicyHash !== value.compiledPolicyHash ||
        Date.parse(row.expiresAt) > Date.parse(value.workspaceProof.expiresAt)) fail('sdk_provider_lease_mismatch')
  })
  nullable(value.binding, validateBinding)
  if (value.binding && (value.binding.machineId !== value.machineId ||
      value.binding.cwd !== value.workspace.cwd || value.binding.repository !== value.workspace.repository ||
      value.binding.baseRef !== value.workspace.baseRef || value.binding.baseSha !== (value.workspace.baseSha ?? null))) {
    fail('sdk_provider_resource_mismatch')
  }
  nullable(value.effectiveSettings, settings); nullable(value.settingsObservedAt, time)
  if ((value.effectiveSettings === null) !== (value.settingsObservedAt === null)) fail('sdk_provider_settings_provenance')
  if (value.settingsUnconfirmed !== undefined) {
    array(value.settingsUnconfirmed, MISSION_SETTING_KEYS.length, key => one(key, MISSION_SETTING_KEYS))
    unique(value.settingsUnconfirmed)
    if (!value.settingsUnconfirmed.length || !value.effectiveSettings) fail('sdk_provider_settings_provenance')
  }
  if (value.initialize.state === 'confirmed' && (!value.binding || value.binding.sessionId !== value.rootSessionId ||
      !value.effectiveSettings || value.initialize.receiptHash !== initializeReceipt(
        value.binding.sessionId, value.effectiveSettings, value.settingsUnconfirmed,
      ))) fail('sdk_provider_initialize_receipt_corrupt')
  if (value.goal.state === 'confirmed' && value.goal.receiptHash !== hash({
    requestId: value.goal.rpcId, messageId: value.goal.messageId, result: {},
  })) fail('sdk_provider_goal_receipt_corrupt')
  if (value.goal.state !== 'prepared' && (!value.binding || !value.effectiveSettings || value.initialize.state !== 'confirmed')) {
    fail('sdk_goal_without_initialized_settings')
  }
  array(value.sessions, 256, row => {
    object(row, ['sessionId', 'parentSessionId', 'connectionId', 'active', 'source'])
    id(row.sessionId); nullable(row.parentSessionId, id); str(row.connectionId, 160); bool(row.active)
    one(row.source, ['owned_root', 'initialize', 'worker_notification', 'child_notification', 'opened_query', 'available_query'])
    if (row.sessionId !== value.rootSessionId && !row.parentSessionId) fail('sdk_unowned_child_session')
  })
  unique(value.sessions.map(row => row.sessionId))
  for (const session of value.sessions) {
    let parent = session, seen = new Set()
    while (parent.sessionId !== value.rootSessionId) {
      if (seen.has(parent.sessionId)) fail('sdk_provider_session_cycle')
      seen.add(parent.sessionId)
      parent = value.sessions.find(row => row.sessionId === parent.parentSessionId)
      if (!parent) fail('sdk_provider_unknown_parent')
    }
  }
  array(value.requests, 128, row => {
    // `raw` is optional: it is always byte-identical to envelope.params, so new rows
    // persist it only when envelope.params is missing (never happens for live traffic).
    object(row, ['attention', 'raw', 'envelope', 'connectionId', 'proposalHash', 'unsupportedReason'],
      ['attention', 'envelope', 'connectionId', 'proposalHash', 'unsupportedReason'])
    checkAttention(row.attention); str(row.connectionId, 160)
    if (row.connectionId !== value.connectionId ||
        (row.attention.state !== 'resolved' && row.attention.resolvedAt !== null)) fail('sdk_provider_request_generation_corrupt')
    nullable(row.proposalHash, digest); nullable(row.unsupportedReason, reason => str(reason, 160))
    if (row.raw !== undefined && row.raw !== null) boundedJson(row.raw)
    const decoded = decodeSdkEnvelope(row.envelope, {
      machineId: value.machineId, connectionId: row.connectionId, rootSessionId: value.rootSessionId,
      observedAt: row.attention.openedAt,
    })
    if (decoded.kind !== 'request' || (row.raw != null && hash(row.raw) !== hash(decoded.raw)) ||
        hash({ ...row.attention, state: 'open', resolvedAt: null }) !== hash(decoded.attention) ||
        row.proposalHash !== decoded.proposalHash || row.unsupportedReason !== decoded.unsupportedReason ||
        !value.sessions.some(session => session.sessionId === row.attention.sessionId)) fail('sdk_provider_request_corrupt')
    consistent(missionDialectOf(decoded))
  })
  unique(value.requests.map(row => row.attention.attentionId))
  array(value.resolutions, 128, row => {
    object(row, ['attentionId', 'envelope', 'effect', 'observedAt'])
    id(row.attentionId); time(row.observedAt)
    const request = value.requests.find(request => request.attention.attentionId === row.attentionId)
    if (!request) fail('sdk_provider_orphan_resolution')
    const decoded = decodeSdkEnvelope(row.envelope, {
      machineId: value.machineId, connectionId: request.connectionId,
      rootSessionId: value.rootSessionId, observedAt: row.observedAt,
    })
    const effect = correlateNativeResolution(request, row.envelope)
    if (decoded.kind !== 'notification' || !effect || hash(effect) !== hash(row.effect)) {
      fail('sdk_provider_resolution_corrupt')
    }
  })
  unique(value.resolutions.map(row => row.attentionId))
  for (const row of value.requests) if (row.attention.state === 'resolved') {
    const proof = value.resolutions.find(resolution => resolution.attentionId === row.attention.attentionId)
    if (!proof || proof.effect.kind !== 'permission_effect' || row.attention.resolvedAt !== proof.observedAt) {
      fail('sdk_provider_unproved_request_closure')
    }
  }
  array(value.answerAttempts, 128, row => {
    object(row, ['commandId', 'attentionId', 'requestHash', 'response', 'state', 'invokedAt'])
    id(row.commandId); id(row.attentionId); digest(row.requestHash); time(row.invokedAt)
    one(row.state, ['invoked', 'sent', 'unknown'])
    const request = value.requests.find(request => request.attention.attentionId === row.attentionId)
    if (!request) fail('sdk_provider_orphan_answer')
    if (request.unsupportedReason) fail('sdk_provider_unsupported_answer')
    if (request.envelope.method === 'daemon.ask_user') {
      object(row.response, ['sessionId', 'answers', 'cancelled'])
      bool(row.response.cancelled)
      array(row.response.answers, 64, answer => {
        object(answer, ['index', 'question', 'answer'])
        int(answer.index, 1); str(answer.answer, 8192, true)
        if (!requestPayload(request).questions.some(question => question.index === answer.index && question.question === answer.question)) {
          fail('sdk_provider_answer_question_corrupt')
        }
      })
      unique(row.response.answers.map(answer => answer.index))
      if (!row.response.cancelled && row.response.answers.length !== requestPayload(request).questions.length) fail('sdk_provider_incomplete_answer')
    } else {
      object(row.response, ['sessionId', 'selectedOption'])
      one(row.response.selectedOption, ['proceed_once', 'cancel'])
      if (!request.attention.options.some(option => option.value === row.response.selectedOption)) fail('sdk_provider_unoffered_answer')
    }
    const descriptor = outgoingDescriptor({
      type: 'response', jsonrpc: '2.0', factoryApiVersion: '1.0.0',
      id: request.attention.requestId, result: row.response,
    })
    if (descriptor.requestHash !== row.requestHash || descriptor.sessionId !== request.attention.sessionId) fail('sdk_provider_answer_corrupt')
  })
  unique(value.answerAttempts.map(row => row.commandId))
  object(value.observations, ['mission', 'features', 'progress', 'workers', 'history'])
  for (const key of ['mission', 'features', 'progress']) nullable(value.observations[key], row => {
    object(row, ['envelope', 'observedAt']); time(row.observedAt)
    const decoded = decodeSdkEnvelope(row.envelope, {
      machineId: value.machineId, connectionId: value.connectionId, rootSessionId: value.rootSessionId,
      observedAt: row.observedAt,
    })
    const type = { mission: 'mission_state_changed', features: 'mission_features_changed', progress: 'mission_progress_entry' }[key]
    if (decoded.kind !== 'notification' || decoded.sessionId !== value.rootSessionId ||
        decoded.envelope.params.notification.type !== type) fail('sdk_provider_observation_corrupt')
    consistent('v1')
  })
  array(value.observations.workers, 256, row => {
    object(row, ['envelope', 'observedAt']); time(row.observedAt)
    const decoded = decodeSdkEnvelope(row.envelope, {
      machineId: value.machineId, connectionId: value.connectionId, rootSessionId: value.rootSessionId,
      observedAt: row.observedAt,
    })
    if (decoded.kind !== 'notification' || decoded.sessionId !== value.rootSessionId ||
        !['mission_worker_started', 'mission_worker_completed'].includes(decoded.envelope.params.notification.type)) {
      fail('sdk_provider_worker_corrupt')
    }
    consistent('v1')
  })
  // History is persisted only for identity tracking. Rows beyond the retention
  // window keep just {id, text}; full message content is read back per observe().
  array(value.observations.history, 4096, row => {
    if (Object.hasOwn(row, 'content')) validateSdkMessage(row)
    else { object(row, ['id', 'text']); id(row.id); str(row.text, 65536, true) }
  })
  if (hasV2) checkMissionV2Facts(value)
  if (hasAgents) checkMissionV2AgentsFacts(value)
  nullable(value.ingestionFault, reason => str(reason, 160)); bool(value.recoveryHold)
  return clone(value)
}

/** Actual transport.send boundary, including sends delayed by SDK auth gates. */
/**
 * Deterministic owned root session id in UUID shape (version-8 layout). The
 * daemon reuses the session id as the model prompt-cache key, which providers
 * cap at 64 characters, so the full 71-character prefixed digest is refused.
 */
export function ownedRootSessionId(owned) {
  digest(owned)
  const variant = ((parseInt(owned[16], 16) & 0x3) | 0x8).toString(16)
  return `${owned.slice(0, 8)}-${owned.slice(8, 12)}-8${owned.slice(13, 16)}-${variant}${owned.slice(17, 20)}-${owned.slice(20, 32)}`
}

export function createGuardedDaemonTransport(transport, { boundary, readGuard, now = Date.now }) {
  if (!transport || typeof transport.send !== 'function' || !boundary ||
      typeof boundary.assertAndConsumePermit !== 'function') fail('sdk_send_boundary_missing')
  let armed = null
  const consumed = new Set(), authenticated = new Set()
  const wrapped = {
    connect: url => transport.connect(url), disconnect: () => transport.disconnect(),
    isConnected: () => transport.isConnected(), getConnectionId: () => transport.getConnectionId(),
    isRelayConnection: () => transport.isRelayConnection(), getTransportKind: () => transport.getTransportKind(),
    on: (event, handler) => transport.on(event, handler), off: (event, handler) => transport.off(event, handler),
    send(data) {
      const frame = JSON.parse(data)
      // droid >= 0.238 hides every daemon method until the connection
      // authenticates. The handshake executes nothing: it is the exact SDK
      // shape, once per connection, and only the key itself may be secret.
      if (frame.type === 'request' && frame.method === 'daemon.authenticate') {
        const params = frame.params
        object(params, ['apiKey', 'caller', 'metadata'])
        str(params.apiKey, 65536); one(params.caller, ['sdk'])
        const { apiKey: _key, ...rest } = params
        boundedJson({ ...frame, params: rest }); secretFree({ ...frame, params: rest })
        if (!transport.isConnected()) fail('sdk_disconnected')
        const connection = transport.getConnectionId()
        if (authenticated.has(connection)) fail('sdk_authenticate_repeated')
        authenticated.add(connection)
        return transport.send(data)
      }
      if (frame.type === 'request' && READ_METHODS.has(frame.method)) {
        boundedJson(frame); secretFree(frame)
        if (typeof readGuard !== 'function') fail('sdk_read_guard_missing')
        readGuard(frame)
        if (!transport.isConnected()) fail('sdk_disconnected')
        return transport.send(data)
      }
      const descriptor = outgoingDescriptor(frame), current = armed
      armed = null
      if (!current) fail('sdk_send_permit_missing')
      current.guard()
      const permit = current.permit
      if (!transport.isConnected() || transport.getConnectionId() !== permit.connectionId ||
          descriptor.operation !== permit.operation || descriptor.sessionId !== permit.sessionId ||
          descriptor.requestHash !== permit.requestHash || Date.parse(permit.expiresAt) <= now()) {
        fail('sdk_send_permit_mismatch')
      }
      boundary.assertAndConsumePermit(clone(permit))
      current.guard()
      return transport.send(data)
    },
  }
  return {
    transport: wrapped,
    arm(permit, guard) {
      if (armed) fail('sdk_send_already_armed')
      object(permit, ['permitId', 'leaseId', 'connectionId', 'operation', 'sessionId', 'requestHash',
        'expiresAt', 'revocationGeneration'])
      for (const key of ['permitId', 'leaseId', 'connectionId', 'sessionId']) str(permit[key], 512)
      one(permit.operation, ['initialize', 'owner_turn', 'permission_response', 'ask_user_response'])
      digest(permit.requestHash); time(permit.expiresAt); int(permit.revocationGeneration)
      if (consumed.has(permit.permitId) || consumed.size >= 4096) fail('sdk_permit_reused')
      consumed.add(permit.permitId)
      armed = { permit: clone(permit), guard }
    },
    disarm() { armed = null },
  }
}

function effectiveSettings(result, compiled) {
  if (!result || typeof result !== 'object' || !result.settings || !result.session ||
      !Array.isArray(result.session.messages)) fail('sdk_initialize_result_invalid')
  array(result.session.messages, 512, message => { if (!isInternalSdkMessage(message)) validateSdkMessage(message) })
  const actual = result.settings
  if (actual.interactionMode !== 'mission' || actual.autonomyLevel !== 'high' ||
      !Array.isArray(actual.availableAutonomyLevels) || !actual.availableAutonomyLevels.includes('high')) {
    fail('sdk_effective_mission_autonomy_unproven')
  }
  const wanted = compiled.initialize
  for (const key of ['modelId', 'reasoningEffort', 'restrictToolIds']) {
    if (!Object.hasOwn(actual, key)) fail('sdk_effective_settings_unconfirmed')
    if (hash(actual[key]) !== hash(wanted[key])) fail('sdk_effective_settings_mismatch')
  }
  if (hash(actual.restrictToolIds ?? null) !== hash(wanted.restrictToolIds)) fail('sdk_effective_settings_mismatch')
  // Daemon 0.227 neither echoes nor persists missionSettings. Absence is recorded as
  // unconfirmed (never as proof); a present but different value is still a mismatch.
  const reported = actual.missionSettings ?? {}
  if (actual.missionSettings === null || typeof reported !== 'object' || Array.isArray(reported)) fail('sdk_initialize_result_invalid')
  for (const [key, value] of Object.entries(reported)) {
    if (!Object.hasOwn(wanted.missionSettings, key) || hash(value) !== hash(wanted.missionSettings[key])) fail('sdk_effective_settings_mismatch')
  }
  const unconfirmed = Object.keys(wanted.missionSettings).filter(key => !Object.hasOwn(reported, key))
  const normalized = {
    modelId: actual.modelId, reasoningEffort: actual.reasoningEffort,
    ...wanted.missionSettings, ...reported, restrictToolIds: clone(actual.restrictToolIds),
  }
  settings(normalized)
  // Normalize only fields requested by the compiler, preserving exact broker settings shape.
  const matched = Object.fromEntries(Object.keys(compiled.settings).map(key => [key, normalized[key]]))
  if (hash(matched) !== hash(compiled.settings)) fail('sdk_effective_settings_mismatch')
  return {
    settings: matched, unconfirmed: unconfirmed.filter(key => Object.hasOwn(compiled.settings, key)),
    tag: initializeTag(actual, result.sessionId),
  }
}
/**
 * The `mission-v2` tag reported by initialize_session, or null when none is
 * reported (droid 0.227 sets its tag later). A droid 0.238 tag must name this
 * session as the orchestrator of its own Mission.
 */
function initializeTag(actual, rootSessionId) {
  if (!Object.hasOwn(actual, 'tags') || actual.tags === undefined) return null
  array(actual.tags, 128, tag => {
    if (!tag || typeof tag !== 'object' || Array.isArray(tag)) fail('sdk_initialize_result_invalid')
    str(tag.name, 256)
    if (tag.metadata !== undefined) {
      if (!tag.metadata || typeof tag.metadata !== 'object' || Array.isArray(tag.metadata) ||
          Object.keys(tag.metadata).length > 64) fail('sdk_initialize_result_invalid')
      for (const item of Object.values(tag.metadata)) str(item, 8192, true)
    }
  })
  const tag = missionV2TagOf(actual)
  if (!tag) return null
  const dialect = missionV2TagDialect(tag)
  if (dialect === 'v2-agents' && !agentsOrchestratorTag(tag, rootSessionId)) fail('sdk_mission_v2_tag_mismatch')
  return { dialect, tag: clone(tag) }
}
const agentsOrchestratorTag = (tag, rootSessionId) =>
  tag?.metadata?.kind === 'orchestrator' && tag.metadata.missionId === rootSessionId
const MISSION_SETTING_KEYS = Object.freeze(['workerModel', 'workerReasoningEffort', 'validationWorkerModel',
  'validationWorkerReasoningEffort', 'skipScrutiny', 'skipUserTesting'])
const initializeReceipt = (sessionId, settings, unconfirmed) =>
  hash({ sessionId, settings, ...(unconfirmed?.length ? { unconfirmed } : {}) })

export function createInjectedNativeProvider(options) {
  const { deployment, policy, safeExtensionTokenGetter, createClient } = options
  const now = options.now ?? Date.now
  int(options.maxReadPages ?? 8, 1)
  if ((options.maxReadPages ?? 8) > 32) fail('sdk_read_page_limit')
  int(options.requestTimeoutMs ?? 30000, 1)
  if ((options.requestTimeoutMs ?? 30000) > 60000) fail('sdk_request_timeout_limit')
  if (options.missionRecordReader !== undefined && typeof options.missionRecordReader?.read !== 'function') {
    fail('sdk_mission_record_reader_invalid')
  }
  // Quiet period after a completed v2-agents orchestrator turn; injectable for offline tests.
  const agentsSettleMs = options.missionV2AgentsSettleMs ?? MISSION_V2_AGENTS_SETTLE_MS
  int(agentsSettleMs); if (agentsSettleMs > 3600000) fail('sdk_mission_v2_agents_settle_limit')
  if (!deployment?.boundary || !policy || typeof policy.compileNativePolicy !== 'function' ||
      typeof policy.validateWorkspaceProof !== 'function' || typeof policy.validateEnforcementLease !== 'function' ||
      typeof safeExtensionTokenGetter !== 'function' || typeof createClient !== 'function') {
    fail('sdk_host_boundary_missing')
  }
  const boundary = deployment.boundary
  let record = null, journal = null, compiled = null, restored = false, fenced = false
  const gate = createGuardedDaemonTransport(options.transport, {
    boundary, now,
    readGuard(frame) {
      if (!record || record.ownerId !== deployment.ownerId || record.machineId !== deployment.machineId) fail('sdk_read_scope_missing')
      one(frame.jsonrpc, ['2.0']); one(frame.factoryApiVersion, ['1.0.0']); id(frame.id)
      const params = frame.params
      if (frame.method === 'daemon.inspect_mission_readiness') {
        object(params, ['cwd']); if (params.cwd !== record.workspace.cwd) fail('sdk_read_wrong_workspace')
      } else if (frame.method === 'daemon.get_session_messages') {
        object(params, ['sessionId', 'limit', 'cursor', 'role'], ['sessionId', 'limit'])
        if (!record.sessions.some(row => row.sessionId === params.sessionId)) fail('sdk_read_wrong_session')
        int(params.limit, 1); if (params.limit > 100) fail('sdk_read_limit')
        if (params.cursor !== undefined) str(params.cursor, 8192)
      } else if (frame.method === 'daemon.list_available_sessions') {
        object(params, ['limit', 'endBefore', 'includeArchived', 'includeMissionMetadata'], ['limit'])
        int(params.limit, 1); if (params.limit > 100) fail('sdk_read_limit')
      } else object(params, [])
    },
  })
  const client = createClient(gate.transport)
  let effectInFlight = false
  const exclusive = operation => async (...args) => {
    if (effectInFlight) fail('sdk_effect_in_flight')
    effectInFlight = true
    try { return await operation(...args) } finally { effectInFlight = false }
  }
  let queue = Promise.resolve()
  const serial = operation => {
    const next = queue.then(operation)
    queue = next.catch(() => { fenced = true })
    return next
  }
  const checkContext = context => {
    context.guard()
    if (context.ownerId !== deployment.ownerId || context.machineId !== deployment.machineId) fail('sdk_wrong_host')
    if (record) {
      assertBinding(record, context)
      if (context.binding && hash(context.binding) !== hash(record.binding)) fail('sdk_wrong_execution_binding')
    }
  }
  const guard = context => {
    checkContext(context)
    if (fenced || record?.ingestionFault) fail('sdk_ingestion_fenced')
    if (restored || record?.recoveryHold || record?.epoch !== context.epoch) fail('sdk_restored_readonly_handoff')
    if (!client.isConnected() || !client.getConnectionId() ||
        (record && client.getConnectionId() !== record.connectionId)) fail('sdk_connection_changed_handoff')
    if (record?.workspaceProof && Date.parse(record.workspaceProof.expiresAt) <= now()) fail('sdk_workspace_proof_expired')
    if (record?.enforcementLease && Date.parse(record.enforcementLease.expiresAt) <= now()) fail('sdk_enforcement_lease_expired')
  }
  const commit = async () => {
    validateProviderRecord(record, hostBinding(record))
    await journal.write(clone(record))
  }
  // The fault path must persist even when the full record overflowed: drop
  // bulk notification history, retry with the fault code, then the code stays
  // in memory only (the provider is fenced either way).
  const minimalRecord = code => ({
    ...clone(record), ingestionFault: code,
    observations: { mission: null, features: null, progress: null, workers: [], history: [] },
  })
  const commitFault = async code => {
    record.ingestionFault = code
    try {
      await commit()
      return
    } catch { /* Full record no longer fits; persist the minimal fault record. */ }
    try {
      const minimal = minimalRecord(code)
      boundedJson(minimal, MAX_FAULT_BYTES); secretFree(minimal)
      validateProviderRecord(minimal, hostBinding(minimal))
      await journal.write(minimal)
    } catch { /* In-memory fencing still holds; nothing safe left to persist. */ }
  }
  const fault = code => {
    fenced = true
    if (record) void serial(() => commitFault(code)).catch(() => {})
    try { options.onDiagnostic?.({ code }) } catch { /* Diagnostic failure cannot unfence. */ }
  }
  const bindJournal = (intent, context) => {
    checkContext(context)
    if (!context.providerJournal || typeof context.providerJournal.read !== 'function' ||
        typeof context.providerJournal.write !== 'function' || typeof context.providerJournal.initialized !== 'function') {
      fail('sdk_provider_journal_missing')
    }
    if (journal && journal !== context.providerJournal) fail('sdk_provider_journal_changed')
    journal = context.providerJournal
    if (!record) {
      const previous = journal.read()
      if (previous !== null) {
        record = validateProviderRecord(previous, context)
        restored = true; fenced = true
        fail('sdk_restored_readonly_handoff')
      }
      const connectionId = client.getConnectionId()
      if (!client.isConnected() || !connectionId) fail('sdk_disconnected')
      const owned = hash([context.ownerId, context.missionId, context.machineId, context.scopeHash, context.policyHash])
      const rootSessionId = ownedRootSessionId(owned), rpcId = `goal-${owned}`, messageId = `message-${owned}`
      const goalText = JSON.stringify({
        goal: intent.goal, acceptanceCriteria: intent.acceptanceCriteria,
        restrictions: intent.restrictions, references: intent.references,
      })
      const initializeParams = {
        machineId: context.machineId, cwd: intent.workspace.cwd, sessionId: rootSessionId,
        ...clone(compiled.initialize),
      }
      record = {
        version: 1, ...hostBinding(context), rootSessionId, scopeRevision: intent.scopeRevision, connectionId,
        workspace: clone(intent.workspace), goalText, initializeParams, compiledPolicyHash: compiled.compiledPolicyHash,
        workspaceProof: null, enforcementLease: null,
        initialize: {
          state: 'prepared', requestHash: hash({ method: 'daemon.initialize_session', params: initializeParams }),
          rpcId: null, messageId: null, receiptHash: null, fault: null,
        },
        goal: {
          state: 'prepared', requestHash: hash({
            method: 'daemon.add_user_message', id: rpcId,
            params: { sessionId: rootSessionId, messageId, text: goalText },
          }), rpcId, messageId, receiptHash: null, fault: null,
        },
        binding: null, effectiveSettings: null, settingsObservedAt: null,
        sessions: [{ sessionId: rootSessionId, parentSessionId: null, connectionId, active: false, source: 'owned_root' }],
        requests: [], answerAttempts: [], resolutions: [],
        observations: { mission: null, features: null, progress: null, workers: [], history: [] },
        ingestionFault: null, recoveryHold: false,
      }
    }
    guard(context)
  }

  const member = sessionId => record.sessions.find(row => row.sessionId === sessionId)
  const addMember = (sessionId, parentSessionId, source) => {
    if (!member(sessionId)) record.sessions.push({
      sessionId, parentSessionId, source, active: true, connectionId: record.connectionId,
    })
  }
  // Read-only resource preservation, intentionally independent of the current send epoch.
  const preserveInitialized = async binding => {
    if (record.binding) {
      if (hash(record.binding) !== hash(binding)) fail('sdk_initialized_resource_conflict')
      return
    }
    await journal.initialized(clone(binding))
    record.binding = clone(binding)
    await commit()
  }
  const hasV1Facts = () => ['mission', 'features', 'progress'].some(key => record.observations[key] !== null) ||
    record.observations.workers.length > 0 ||
    record.requests.some(row => missionDialectOf({ kind: 'request', envelope: row.envelope, raw: row.raw ?? null }) === 'v1')
  // The first decisive fact fixes the dialect; a later fact of the other dialect is a fault.
  // A 'v2-agents' fact is only ever adopted from a tag that names the root as orchestrator.
  const adoptDialect = fact => {
    if (fact === 'none') return true
    const current = record.dialect ?? null
    if (fact === 'mixed' || (current !== null && current !== fact)) return false
    if (current === null) {
      if ((fact === 'v2' || fact === 'v2-agents') && hasV1Facts()) return false
      record.dialect = fact
      if (fact === 'v2') {
        record.missionV2 = { seq: 0, approval: null, snapshot: null, rootWorking: null, rootBusySeq: 0, lastTurn: null, workers: [], toolResults: [] }
      }
      if (fact === 'v2-agents') {
        record.missionV2Agents = {
          seq: 0, tag: { kind: 'orchestrator', missionId: record.rootSessionId }, rootWorking: null, rootBusySeq: 0,
          lastTurn: null, agents: [], agentsOverflow: false, toolUses: [], toolResults: [], completed: null,
        }
      }
    }
    return true
  }
  // Root activity: busy working state, messages, tool results or requests. After a latched
  // completion it is counted as progress only and never changes agents or state.
  const agentsActivity = observedAt => {
    const m = record.missionV2Agents
    m.rootBusySeq = ++m.seq
    if (m.completed) { m.completed.lateActivity++; m.completed.lastLateActivityAt = observedAt }
    return m.rootBusySeq
  }
  const upsertAgent = (sessionId, fields, observedAt) => {
    const m = record.missionV2Agents
    if (sessionId === record.rootSessionId) return
    let agent = m.agents.find(row => row.sessionId === sessionId)
    if (!agent) {
      if (m.agents.length >= MISSION_V2_AGENTS_MAX) { m.agentsOverflow = true; return }
      agent = { sessionId, title: null, status: null, waitingOn: null, source: fields.source, firstSeenAt: observedAt, listedAt: null, seq: 0 }
      m.agents.push(agent)
    }
    if (fields.title !== null && fields.title !== undefined) agent.title = fields.title
    if (fields.source === 'list') {
      agent.status = fields.status; agent.waitingOn = fields.waitingOn; agent.listedAt = observedAt
    } else if (agent.listedAt === null) {
      // A spawned agent runs its opening prompt; only a later ListAgents result can show it idle.
      agent.status = 'running'
    }
    agent.seq = ++m.seq
  }
  const ingestMissionV2Agents = (notification, observedAt) => {
    const m = record.missionV2Agents, type = notification.type
    if (type === 'settings_updated') {
      // Metadata may grow (spaceId); losing the tag or changing kind/missionId is a fault.
      if (Object.hasOwn(notification.settings, 'tags') && !agentsOrchestratorTag(missionV2TagOf(notification.settings), record.rootSessionId)) {
        return 'sdk_mission_v2_tag_changed'
      }
    } else if (type === 'droid_working_state_changed') {
      const seq = notification.newState === 'idle' ? ++m.seq : agentsActivity(observedAt)
      m.rootWorking = { state: notification.newState, observedAt, seq }
    } else if (type === 'agent_turn_completed') {
      m.lastTurn = { reason: notification.reason, turnId: notification.turnId ?? null, observedAt, seq: ++m.seq }
    } else if (type === 'create_message') {
      agentsActivity(observedAt)
      const message = notification.message
      // An agent's report to the orchestrator is a root user message droid
      // attributes with sender { kind: 'agent', sessionId }: that agent has
      // finished its turn (a later SendMessage to it marks it running again).
      const sender = message.role === 'user' && message.sender && typeof message.sender === 'object' ? message.sender : null
      if (!m.completed && sender?.kind === 'agent' && typeof sender.sessionId === 'string') {
        try {
          id(sender.sessionId)
          const title = typeof sender.title === 'string' && sender.title.trim() ? sender.title.trim().slice(0, 512) : null
          upsertAgent(sender.sessionId, { source: 'list', title, status: 'idle', waitingOn: null }, observedAt)
        } catch { /* an unusable sender is display noise, never a fault */ }
      }
      if (!m.completed && message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'tool_use' && (block.name === 'SendMessage' || block.name === 'SpawnAgent') &&
              typeof block.input?.sessionId === 'string') {
            const agent = m.agents.find(row => row.sessionId === block.input.sessionId)
            if (agent) { agent.status = 'running'; agent.waitingOn = null; agent.seq = ++m.seq }
          }
          if (block.type !== 'tool_use' || !AGENT_RESULT_TOOLS.includes(block.name) ||
              m.toolUses.some(row => row.toolUseId === block.id)) continue
          if (m.toolUses.length >= AGENT_TOOL_USES_MAX) m.toolUses.shift()
          const title = typeof block.input?.title === 'string' && block.input.title.trim()
            ? block.input.title.trim().slice(0, 512) : null
          m.toolUses.push({ toolUseId: block.id, name: block.name, title, seq: ++m.seq })
        }
      }
    } else if (type === 'tool_result') {
      agentsActivity(observedAt)
      const failed = notification.isError === true
      if (!m.toolResults.some(row => row.toolUseId === notification.toolUseId)) {
        if (m.toolResults.length >= 512) m.toolResults.shift()
        m.toolResults.push({ toolUseId: notification.toolUseId, seq: ++m.seq, failed })
      }
      if (failed) {
        const text = typeof notification.content === 'string' ? notification.content
          : Array.isArray(notification.content) ? notification.content.filter(item => item.type === 'text').map(item => item.text).join('\n') : ''
        const gating = missionV2GatingFault(text)
        if (gating) return gating
      }
      const index = m.toolUses.findIndex(row => row.toolUseId === notification.toolUseId)
      if (index >= 0) {
        const [use] = m.toolUses.splice(index, 1)
        const parsed = failed || m.completed ? null : parseMissionV2AgentResult(use.name, notification.content)
        if (parsed?.kind === 'spawned') upsertAgent(parsed.sessionId, { source: 'spawn', title: use.title }, observedAt)
        if (parsed?.kind === 'listed') {
          for (const row of parsed.agents) upsertAgent(row.sessionId, { source: 'list', ...row }, observedAt)
        }
      }
    }
    return null
  }
  // Root-session v2 facts. Every check precedes its mutation so a fault leaves a valid record.
  const finishWorker = (worker, observedAt, failed) => {
    worker.finishedAt = observedAt; worker.finishSeq = ++record.missionV2.seq; worker.failed = failed
    member(worker.childSessionId).active = false
  }
  const ingestMissionV2 = (decoded, notification, observedAt) => {
    const m = record.missionV2, type = notification.type
    if (type === 'mission_v2_snapshot_changed') {
      const next = notification.snapshot, previous = m.snapshot?.envelope.params.notification.snapshot
      if (next.sessionId !== record.rootSessionId) return 'sdk_mission_v2_snapshot_wrong_session'
      if (previous && previous.planHash === next.planHash && next.latestEventNumber < previous.latestEventNumber) {
        return 'sdk_mission_v2_snapshot_regressed'
      }
      m.snapshot = { envelope: decoded.envelope, observedAt, seq: ++m.seq }
    } else if (type === 'droid_working_state_changed') {
      const seq = ++m.seq
      m.rootWorking = { state: notification.newState, observedAt, seq }
      if (notification.newState !== 'idle') m.rootBusySeq = seq
    } else if (type === 'agent_turn_completed') {
      m.lastTurn = { reason: notification.reason, turnId: notification.turnId ?? null, observedAt, seq: ++m.seq }
    } else if (type === 'child_session_available' && (notification.toolUseId !== undefined || notification.subagentType === 'worker')) {
      // A worker that cannot be finished by a correlated tool_result would make completion unprovable.
      if (notification.toolUseId === undefined) return 'sdk_mission_v2_worker_unbound'
      const child = notification.childSessionId, toolUseId = notification.toolUseId
      const same = m.workers.find(row => row.childSessionId === child || row.toolUseId === toolUseId)
      if (same && (same.childSessionId !== child || same.toolUseId !== toolUseId)) return 'sdk_mission_v2_worker_conflict'
      if (member(child)?.parentSessionId !== record.rootSessionId) return 'sdk_mission_v2_worker_conflict'
      if (!same) {
        if (m.workers.length >= 256) return 'sdk_mission_v2_worker_capacity'
        const worker = {
          childSessionId: child, toolUseId, subagentType: notification.subagentType ?? null,
          description: notification.description ?? null, startedAt: observedAt, startSeq: ++m.seq,
          finishedAt: null, finishSeq: null, failed: null,
        }
        m.workers.push(worker)
        // A tool_result may arrive before child_session_available; it still finishes the worker.
        const prior = m.toolResults.find(row => row.toolUseId === toolUseId)
        if (prior) finishWorker(worker, observedAt, prior.failed)
      }
    } else if (type === 'tool_result') {
      const known = m.toolResults.find(row => row.toolUseId === notification.toolUseId)
      if (!known) {
        if (m.toolResults.length >= 512) m.toolResults.shift()
        m.toolResults.push({ toolUseId: notification.toolUseId, seq: ++m.seq, failed: notification.isError === true })
      }
      const worker = m.workers.find(row => row.toolUseId === notification.toolUseId && row.finishedAt === null)
      if (worker) finishWorker(worker, observedAt, (known ?? { failed: notification.isError === true }).failed)
    }
    return null
  }
  const ingest = async decoded => {
    if (!record || !journal || restored || fenced) return
    const observedAt = date(now), connectionId = client.getConnectionId()
    if (connectionId !== record.connectionId) return fault('sdk_connection_changed_handoff')
    if (decoded.kind === 'receipt') {
      // A late positive resource observation is not a successful launch/goal receipt.
      if (!record.binding && decoded.resourceSessionId === record.rootSessionId &&
          ['invoked', 'unknown'].includes(record.initialize.state)) {
        await preserveInitialized({
          sessionId: decoded.resourceSessionId, ...clone(record.workspace), baseSha: record.workspace.baseSha ?? null,
        })
      } else return
    } else if (decoded.kind === 'request') {
      if (!member(decoded.attention.sessionId)) return // Unowned daemon traffic is never retargeted.
      const existing = record.requests.find(row => row.attention.attentionId === decoded.attention.attentionId)
      if (existing && hash(requestPayload(existing)) !== hash(decoded.raw)) return fault('sdk_request_identity_conflict')
      if (existing) return // Never expose a fresh open prompt over a durably resolved duplicate.
      if (!adoptDialect(missionDialectOf(decoded))) return fault('sdk_mission_dialect_mixed')
      if (record.dialect === 'v2-agents' && decoded.attention.sessionId === record.rootSessionId) agentsActivity(observedAt)
      // `raw` equals envelope.params; persisting both doubles the largest record
      // field. The envelope is the stored proof; validation derives the raw copy.
      if (!existing) record.requests.push({
        attention: decoded.attention, envelope: decoded.envelope, connectionId,
        proposalHash: decoded.proposalHash, unsupportedReason: decoded.unsupportedReason,
      })
    } else if (decoded.kind === 'notification') {
      if (!member(decoded.sessionId)) return
      const notification = decoded.envelope.params.notification
      const session = member(decoded.sessionId)
      const root = decoded.sessionId === record.rootSessionId
      let fact = missionDialectOf(decoded)
      if (fact === 'v2-agents' && !root) fact = 'none' // Agent-kind tags on member sessions prove nothing about the root.
      if (fact === 'v2-agents' && record.dialect !== 'v2-agents' &&
          !agentsOrchestratorTag(missionV2TagOf(notification.settings), record.rootSessionId)) return fault('sdk_mission_v2_tag_mismatch')
      if (!adoptDialect(fact)) return fault('sdk_mission_dialect_mixed')
      if (notification.type === 'settings_updated' && decoded.sessionId === record.rootSessionId) {
        const changed = notification.settings, expected = record.initializeParams
        for (const key of ['modelId', 'reasoningEffort', 'interactionMode', 'autonomyLevel', 'restrictToolIds']) {
          if (Object.hasOwn(changed, key) && hash(changed[key]) !== hash(expected[key])) return fault('sdk_effective_settings_changed')
        }
        for (const [key, value] of Object.entries(changed.missionSettings ?? {})) {
          if (hash(value) !== hash(expected.missionSettings[key])) return fault('sdk_effective_settings_changed')
        }
        // The deprecated alias is tolerated only as the exact spelling of high autonomy.
        if (Object.hasOwn(changed, 'autonomyMode') && changed.autonomyMode !== 'auto-high') return fault('sdk_effective_settings_changed')
        if ((changed.availableAutonomyLevels && !changed.availableAutonomyLevels.includes('high')) ||
            ['enabledToolIds', 'disabledToolIds', 'additionalToolIds'].some(key => Object.hasOwn(changed, key))) {
          return fault('sdk_effective_settings_changed')
        }
        // Matching partial updates are not a fresh complete settings snapshot.
      }
      if (notification.type === 'settings_updated' && decoded.sessionId !== record.rootSessionId) {
        const changed = notification.settings, expected = record.initializeParams
        // Roles have not been proven by the pinned protocol. Reject settings
        // outside BOTH approved role pairs, but never call either pair proven.
        const pairs = [
          [expected.missionSettings.workerModel, expected.missionSettings.workerReasoningEffort],
          [expected.missionSettings.validationWorkerModel, expected.missionSettings.validationWorkerReasoningEffort],
        ]
        if (!pairs.some(([model, effort]) =>
          (!Object.hasOwn(changed, 'modelId') || changed.modelId === model) &&
          (!Object.hasOwn(changed, 'reasoningEffort') || changed.reasoningEffort === effort)) ||
            (Object.hasOwn(changed, 'restrictToolIds') && hash(changed.restrictToolIds) !== hash(expected.restrictToolIds)) ||
            ['enabledToolIds', 'disabledToolIds', 'additionalToolIds'].some(key => Object.hasOwn(changed, key))) {
          return fault('sdk_effective_child_settings_changed')
        }
      }
      if (['session_inactivity', 'session_process_exited', 'session_closed', 'session_unsubscribed'].includes(notification.type)) {
        session.active = false
      }
      if (notification.type === 'session_working_directory_changed' && notification.cwd !== record.workspace.cwd) {
        return fault('sdk_workspace_changed_handoff')
      }
      if (notification.type === 'child_session_available') addMember(notification.childSessionId, decoded.sessionId, 'child_notification')
      if (decoded.sessionId === record.rootSessionId) {
        const sections = {
          mission_state_changed: 'mission', mission_features_changed: 'features', mission_progress_entry: 'progress',
        }
        if (sections[notification.type]) record.observations[sections[notification.type]] = { envelope: decoded.envelope, observedAt }
        if (notification.type === 'mission_worker_started') {
          addMember(notification.workerSessionId, decoded.sessionId, 'worker_notification')
        }
        if (['mission_worker_started', 'mission_worker_completed'].includes(notification.type)) {
          record.observations.workers.push({ envelope: decoded.envelope, observedAt })
          if (notification.type === 'mission_worker_completed' && member(notification.workerSessionId)) {
            member(notification.workerSessionId).active = false
          }
        }
        if (record.dialect === 'v2') {
          const code = ingestMissionV2(decoded, notification, observedAt)
          if (code) return fault(code)
        }
        if (record.dialect === 'v2-agents') {
          const code = ingestMissionV2Agents(notification, observedAt)
          if (code) return fault(code)
        }
      }
      if (notification.type === 'create_message') {
        const message = notification.message, history = record.observations.history
        const previous = history.find(row => row.id === message.id)
        if (previous) {
          const same = Object.hasOwn(previous, 'content') ? hash(previous) === hash(message) : previous.text === historyText(message)
          if (!same) return fault('sdk_history_identity_conflict')
        } else if (record.dialect === 'v2' || record.dialect === 'v2-agents' || history.length >= HISTORY_IDENTITY_ROWS) {
          // Identity tracking only; full content is re-read per observe(). A v2
          // record must stay commit-sized no matter how chatty the Mission is.
          history.push({ id: message.id, text: historyText(message) })
        } else history.push(message)
      }
      for (const request of record.requests) {
        const effect = correlateNativeResolution(request, decoded.envelope)
        if (!effect || record.resolutions.some(row => row.attentionId === request.attention.attentionId)) continue
        record.resolutions.push({ attentionId: request.attention.attentionId, envelope: decoded.envelope, effect, observedAt })
        if (effect.kind === 'permission_effect') {
          request.attention.state = 'resolved'; request.attention.resolvedAt = observedAt
          // In v2, approving the exact plan both approves and starts the run.
          if (effect.selectedOption === 'proceed_once' && record.dialect === 'v2' &&
              request.attention.sessionId === record.rootSessionId &&
              missionV2RequestType(request) === 'exit_mission_planning') {
            record.missionV2.approval = {
              attentionId: request.attention.attentionId, proposalHash: request.proposalHash,
              observedAt, seq: ++record.missionV2.seq,
            }
          }
        }
      }
    } else return
    await commit() // Durable before a callback can expose actions.
    await options.onEnvelope?.(clone(decoded))
  }
  client.onMessage(data => {
    try {
      if (!record) return
      const decoded = safeDecodeSdkEnvelope(data, {
        machineId: record.machineId, connectionId: client.getConnectionId() ?? 'disconnected',
        rootSessionId: record.rootSessionId, observedAt: date(now),
      })
      if (decoded.kind === 'diagnostic') return fault(decoded.code)
      void serial(() => ingest(decoded)).catch(() => fault('sdk_ingestion_persistence_failed'))
    } catch { fault('sdk_ingestion_invalid') }
  })
  client.onConnectionClose(() => fault('sdk_connection_closed_handoff'))
  client.onConnectionError(() => fault('sdk_connection_error'))
  client.onConnectionOpen(() => {
    try { if (record && client.getConnectionId() !== record.connectionId) fault('sdk_connection_changed_handoff') }
    catch { fault('sdk_connection_error') }
  })

  const authorize = async (context, operation, sessionId, requestHash) => {
    guard(context)
    const lease = record.enforcementLease
    if (!lease) fail('sdk_enforcement_lease_missing')
    const permit = await boundary.authorizeSend({
      ...hostBinding(context), leaseId: lease.leaseId, connectionId: record.connectionId,
      operation, sessionId, requestHash, nonce: `permit-${hash([requestHash, context.commandId, context.epoch])}`,
    })
    guard(context)
    if (permit.leaseId !== lease.leaseId || permit.revocationGeneration !== lease.revocationGeneration ||
        permit.connectionId !== record.connectionId || permit.operation !== operation ||
        permit.sessionId !== sessionId || permit.requestHash !== requestHash) fail('sdk_send_permit_mismatch')
    gate.arm(permit, () => guard(context))
  }
  // Bounded, never-throwing read of droid gating reasons from an RPC error.
  const gatingOf = error => {
    try {
      const data = error?.data
      return missionV2GatingFault(error?.message, error?.reason, error?.code, data?.reason,
        typeof data === 'string' ? data : data && typeof data === 'object' ? JSON.stringify(data).slice(0, 65536) : null)
    } catch { return null }
  }
  const unknown = async (step, code) => {
    gate.disarm()
    await serial(async () => {
      record[step].state = 'unknown'; record[step].fault = code; record.recoveryHold = true
      await commit()
    })
  }

  return {
    version: SDK_TRANSPORT_VERSION,
    // These are source implementations, NOT signed production qualification.
    support: Object.freeze({
      launch: true, rootAttention: true, childAttention: false, recoverAttention: false,
      pause: false, resume: false, cancel: false, readOnlyObservation: true,
    }),
    schemaNeeded: true,
    client,
    validateProviderRecord,
    async inspectAdmission(draft, context) {
      boundedJson(draft); secretFree(draft); admissionDraft(draft)
      if (context?.readOnly !== true || context.ownerId !== deployment.ownerId ||
          context.machineId !== deployment.machineId || context.ownerId !== draft.ownerId ||
          context.missionId !== draft.missionId || context.machineId !== draft.workspace.machineId) {
        fail('sdk_readonly_admission_required')
      }
      int(context.epoch, 1)
      // Snapshot before any await; neither synthetic consent nor host evidence
      // escapes into a journal, SDK call, or owner consent record.
      const original = freezeNative(clone(draft)), draftHash = hash(original)
      const readOnlyContext = freezeNative({
        ownerId: context.ownerId, missionId: context.missionId,
        machineId: context.machineId, epoch: context.epoch, readOnly: true,
      })
      let resolvedWorkspace = clone(original.workspace)
      if (!resolvedWorkspace.baseSha) {
        if (typeof options.resolveAdmissionWorkspace !== 'function') fail('immutable_base_required')
        resolvedWorkspace = await options.resolveAdmissionWorkspace(original, readOnlyContext)
        boundedJson(resolvedWorkspace); secretFree(resolvedWorkspace); workspace(resolvedWorkspace)
        if (['machineId', 'cwd', 'repository', 'baseRef'].some(key => resolvedWorkspace[key] !== original.workspace[key])) {
          fail('admission_binding_mismatch')
        }
        if (!resolvedWorkspace.baseSha) fail('immutable_base_required')
      }
      validateGitSha(resolvedWorkspace.baseSha); validateFullGitRef(resolvedWorkspace.baseRef)
      const prospective = freezeNative({
        ...original, workspace: clone(resolvedWorkspace), scopeApproved: true, highAutonomyApproved: true,
      })
      // Validate settings even when the pure compiler stops earlier at a policy
      // hold (e.g. absent budget or an unrepresentable prose restriction).
      const s = prospective.settings
      object(s, ADMISSION_SETTINGS); settings(s)
      for (const key of ['modelId', 'workerModel', 'validationWorkerModel']) {
        if (!deployment.allowedModelIds.includes(s[key])) fail('native_model_not_permitted')
      }
      for (const key of ['reasoningEffort', 'workerReasoningEffort', 'validationWorkerReasoningEffort']) {
        if (!NATIVE_REASONING_EFFORTS.includes(s[key])) fail('native_reasoning_effort_unsupported')
      }
      if (s.skipScrutiny !== false || s.skipUserTesting !== false) fail('native_validation_must_be_enabled')
      if (!s.restrictToolIds.length || s.restrictToolIds.some(tool => !deployment.allowedToolIds.includes(tool))) {
        fail('native_tool_not_permitted')
      }
      requireMissionV2Tools(s.restrictToolIds)
      const hashes = getNativeHashes(prospective)
      const inspectionBinding = hostBinding({ ...readOnlyContext, ...hashes })
      const hostQualified = isHostQualificationFor(options.hostQualification, {
        deploymentDigest: deployment.deploymentDigest, hostPublicKey: options.hostPublicKey, now: now(),
      })
      const holds = [
        'native_child_attention', 'passive_authoritative_pending_recovery', 'live_sdk_qualification',
        'native_enforcement_lease_unavailable', 'sdk_high_autonomy_unobserved',
        // No complete supported readback has been qualified.
        'sdk_mission_settings_unconfirmed',
        'native_credential_isolation_unproven',
        ...(boundary.qualificationHolds ?? []),
      ].filter(code => !(hostQualified && HOST_QUALIFIED_HOLDS.has(code)))
      const trusted = options.trustedHost === true
      const open = list => trusted ? [...new Set(list)].filter(code => !TRUSTED_LIFTED.has(code)) : [...new Set(list)]
      try {
        const result = policy.compileNativePolicy(prospective, deployment)
        boundedJson(result); secretFree(result)
        if (result.scopeHash !== hashes.scopeHash || result.policyHash !== hashes.policyHash ||
            hash(result.settings) !== hash(s)) fail('sdk_compiled_scope_mismatch')
      } catch (error) {
        if (!ADMISSION_POLICY_HOLDS.has(error?.code)) throw error
        holds.push(error.code)
      }
      const nonce = `admission-${randomUUID()}`
      if (original.destination?.kind === 'new_repository' && options.prospectiveNewRepository === true) {
        // No physical workspace exists. This value is a prospective placeholder,
        // never an attestation/lease or a claim that initialization is approved.
        holds.push('native_new_repository_initialization_unqualified', 'native_prospective_workspace_only')
        const observed = now()
        return freezeNative(admissionPreview({
          protocolVersion: 1, missionId: original.missionId, ownerId: original.ownerId, draftHash,
          workspace: clone(prospective.workspace), prospectiveSettings: clone(s),
          observedAt: new Date(observed).toISOString(), expiresAt: new Date(observed + 60000).toISOString(),
          launchEligible: trusted && open(holds).length === 0, holds: open(holds),
        }, original))
      }
      const rawProof = await boundary.verifyWorkspace({ ...inspectionBinding, workspace: clone(prospective.workspace), nonce })
      boundedJson(rawProof); secretFree(rawProof); checkProof(rawProof)
      const proof = policy.validateWorkspaceProof(rawProof, prospective, inspectionBinding, {
        host: options.workspaceHost, nonce, evidenceAuthority: options.evidenceAuthority, now: now(),
      })
      assertBinding(proof.binding, inspectionBinding)
      const observed = now(), expires = Math.min(observed + 60000, Date.parse(proof.expiresAt))
      if (proof.binding.epoch !== readOnlyContext.epoch || proof.nonce !== nonce ||
          proof.canonicalCwd !== prospective.workspace.cwd || proof.repositoryId !== prospective.workspace.repository ||
          proof.baseRef !== prospective.workspace.baseRef || proof.baseSha !== prospective.workspace.baseSha ||
          Date.parse(proof.observedAt) > observed || expires <= observed) fail('sdk_canonical_workspace_proof_mismatch')
      return freezeNative(admissionPreview({
        protocolVersion: 1, missionId: original.missionId, ownerId: original.ownerId, draftHash,
        workspace: clone(prospective.workspace), prospectiveSettings: clone(s),
        observedAt: new Date(observed).toISOString(), expiresAt: new Date(expires).toISOString(),
        launchEligible: trusted && open(holds).length === 0, holds: open(holds),
      }, original))
    },
    preflight: exclusive(async (intent, context) => {
      compiled = policy.compileNativePolicy(intent, deployment)
      boundedJson(compiled); secretFree(compiled)
      requireMissionV2Tools(compiled.initialize.restrictToolIds)
      if (compiled.scopeHash !== context.scopeHash || compiled.policyHash !== context.policyHash) fail('sdk_compiled_scope_mismatch')
      bindJournal(intent, context)
      const nonce = `workspace-${hash([record.rootSessionId, context.epoch])}`
      const rawProof = await boundary.verifyWorkspace({ ...hostBinding(context), workspace: clone(intent.workspace), nonce })
      guard(context); checkProof(rawProof)
      const proof = policy.validateWorkspaceProof(rawProof, intent, hostBinding(context), {
        host: options.workspaceHost, nonce, evidenceAuthority: options.evidenceAuthority, now: now(),
      })
      assertBinding(proof.binding, context)
      if (proof.binding.epoch !== context.epoch || proof.nonce !== nonce ||
          proof.canonicalCwd !== intent.workspace.cwd || proof.repositoryId !== intent.workspace.repository ||
          proof.baseRef !== intent.workspace.baseRef || proof.baseSha !== intent.workspace.baseSha ||
          Date.parse(proof.expiresAt) <= now()) fail('sdk_canonical_workspace_proof_mismatch')
      const leaseNonce = `lease-${hash([nonce, compiled.compiledPolicyHash])}`
      const rawLease = await boundary.acquireLease({
        ...hostBinding(context), workspaceAttestationId: proof.attestationId,
        compiledPolicyHash: compiled.compiledPolicyHash, nonce: leaseNonce,
      })
      guard(context); checkLease(rawLease)
      const lease = policy.validateEnforcementLease(rawLease, {
        intent, binding: hostBinding(context), workspaceProof: proof, compiledPolicy: compiled,
        deployment, nonce: leaseNonce, evidenceAuthority: options.evidenceAuthority, now: now(),
      })
      assertBinding(lease.binding, context)
      if (lease.binding.epoch !== context.epoch || lease.workspaceAttestationId !== proof.attestationId ||
          lease.deploymentDigest !== deployment.deploymentDigest ||
          lease.boundaryPolicyHash !== compiled.compiledPolicyHash || Date.parse(lease.expiresAt) <= now()) fail('sdk_lease_binding_mismatch')
      await serial(async () => { record.workspaceProof = clone(proof); record.enforcementLease = clone(lease); await commit() })
      guard(context)
      const readiness = await client.inspectMissionReadiness({ cwd: intent.workspace.cwd })
      guard(context); boundedJson(readiness); secretFree(readiness)
      object(readiness, ['isGitRepo', 'hasRemote', 'remoteUrl', 'isEmpty', 'warning'], ['isGitRepo', 'hasRemote', 'remoteUrl', 'isEmpty'])
      for (const key of ['isGitRepo', 'hasRemote', 'isEmpty']) bool(readiness[key])
      nullable(readiness.remoteUrl, value => str(value, 2048))
      if (readiness.warning !== undefined) {
        object(readiness.warning, ['state', 'repoUrl', 'level'], ['state'])
        one(readiness.warning.state, ['ok', 'no_git', 'no_remote', 'no_report', 'low_score'])
        if (readiness.warning.repoUrl !== undefined) str(readiness.warning.repoUrl, 2048)
        if (readiness.warning.level !== undefined) one(readiness.warning.level, [1, 2, 3, 4, 5])
      }
      const { machineId, cwd, repository, baseRef, baseSha } = intent.workspace
      return {
        workspace: { machineId, cwd, repository, baseRef, baseSha: baseSha ?? null },
        effectiveSettings: clone(compiled.settings), settingsEvidence: 'prospective',
        scopeHash: context.scopeHash, policyHash: context.policyHash, availableAutonomyLevels: [],
        readiness: readiness.isGitRepo && readiness.hasRemote && !readiness.isEmpty,
        policyEnforced: true, budgetEnforced: compiled.budgetEnforcement !== 'none', destinationVerified: true,
        usageReporting: compiled.budgetEnforcement === 'none' ? 'next_day_unenforced' : 'enforced',
      }
    }),
    launch: exclusive(async (intent, context) => {
      if (!record || !journal || !compiled || !record.workspaceProof || !record.enforcementLease) fail('sdk_preflight_required')
      guard(context)
      if (record.initialize.state !== 'prepared' || record.goal.state !== 'prepared') fail('sdk_launch_replay_refused')
      if (hash(policy.compileNativePolicy(intent, deployment)) !== hash(compiled)) fail('sdk_launch_scope_changed')
      const params = clone(record.initializeParams)
      record.initialize.requestHash = hash({ method: 'daemon.initialize_session', params })
      await serial(commit); guard(context)
      let result
      try {
        const token = await safeExtensionTokenGetter()
        guard(context); str(token, 65536)
        await serial(async () => { record.initialize.state = 'invoked'; await commit() })
        guard(context)
        await authorize(context, 'initialize', record.rootSessionId, record.initialize.requestHash)
        result = await client.initializeSession({ ...params, token }, { timeout: options.requestTimeoutMs ?? 30000 })
        gate.disarm()
        // Track a positive resource BEFORE any epoch/settings gate can reject it.
        id(result?.sessionId)
        const binding = { sessionId: result.sessionId, ...clone(record.workspace), baseSha: record.workspace.baseSha ?? null }
        validateBinding(binding)
        await serial(() => preserveInitialized(binding))
        guard(context)
        if (result.sessionId !== record.rootSessionId) fail('sdk_initialized_wrong_session')
        const { settings: effective, unconfirmed, tag } = effectiveSettings(result, compiled)
        await serial(async () => {
          // The initialize result's tag is the first decisive Missions 2.0 fact for droid >= 0.238.
          if (tag && !adoptDialect(tag.dialect)) fail('sdk_mission_dialect_mixed')
          record.initialize.state = 'confirmed'
          record.initialize.receiptHash = initializeReceipt(result.sessionId, effective, unconfirmed)
          if (unconfirmed.length) record.settingsUnconfirmed = [...unconfirmed]
          record.effectiveSettings = effective; record.settingsObservedAt = date(now)
          addMember(result.sessionId, null, 'initialize')
          member(result.sessionId).active = true
          member(result.sessionId).source = 'initialize'
          await commit()
        })
        guard(context)
      } catch (error) {
        // droid-side Missions 2.0 gating is recorded as its own clear fault; the outcome stays unknown.
        const gating = gatingOf(error) ?? (error?.code === 'sdk_mission_v2_tag_mismatch' ? error.code : null)
        await unknown('initialize', gating ?? 'sdk_initialize_outcome_unknown')
        if (gating) { try { options.onDiagnostic?.({ code: gating }) } catch { /* Diagnostics never unfence. */ } }
        fail('sdk_initialize_outcome_unknown')
      }
      try {
        await serial(async () => { record.goal.state = 'invoked'; await commit() }); guard(context)
        await authorize(context, 'owner_turn', record.rootSessionId, record.goal.requestHash)
        const response = await client.addUserMessage({
          sessionId: record.rootSessionId, messageId: record.goal.messageId, text: record.goalText,
        }, record.goal.rpcId)
        gate.disarm(); guard(context)
        // 0.9.1 result schema is {}. A literal null/undefined/malformed response is not a receipt.
        object(response, [])
        await serial(async () => {
          record.goal.state = 'confirmed'
          record.goal.receiptHash = hash({ requestId: record.goal.rpcId, messageId: record.goal.messageId, result: response })
          await commit()
        })
        guard(context)
      } catch (error) {
        const gating = gatingOf(error)
        await unknown('goal', gating ?? 'sdk_goal_outcome_unknown')
        if (gating) { try { options.onDiagnostic?.({ code: gating }) } catch { /* Diagnostics never unfence. */ } }
        fail('sdk_goal_outcome_unknown')
      }
      return {
        status: 'confirmed', commandId: context.commandId,
        // Label this as a broker-derived evidence reference, not a native SDK receipt ID.
        receiptId: `broker-sdk-evidence:${record.goal.receiptHash}`,
        binding: clone(record.binding), effectiveSettings: clone(record.effectiveSettings),
        ...(record.settingsUnconfirmed ? { unconfirmedSettings: clone(record.settingsUnconfirmed) } : {}),
      }
    }),
    answer: exclusive(async (answer, context) => {
      guard(context); await queue; guard(context)
      const request = record.requests.find(row => row.attention.attentionId === answer.attentionId)
      if (!request || request.connectionId !== client.getConnectionId() || request.unsupportedReason) fail('sdk_attention_handoff')
      const a = request.attention, session = member(a.sessionId)
      if (!session?.active || a.sessionId !== record.rootSessionId) fail('sdk_inactive_or_child_handoff')
      for (const key of ['requestId', 'sessionId', 'machineId', 'revision', 'payloadHash']) {
        if (a[key] !== answer[key]) fail('sdk_stale_request')
      }
      if (a.state !== 'open' || hash(requestPayload(request)) !== a.payloadHash) fail('sdk_stale_payload')
      let response, operation
      if (a.kind === 'ask_user') {
        if (a.questions.some(q => q.multiSelect)) fail('sdk_multiselect_encoding_unqualified')
        if (answer.selectedOption !== undefined) fail('sdk_invalid_questionnaire')
        bool(answer.cancelled ?? false)
        array(answer.answers ?? [], 64, row => { object(row, ['index', 'answer']); int(row.index, 1); str(row.answer, 8192, true) })
        unique((answer.answers ?? []).map(row => row.index))
        if (!answer.cancelled && (answer.answers?.length !== a.questions.length ||
            a.questions.some(q => !answer.answers.some(row => row.index === q.index)))) fail('sdk_incomplete_questionnaire')
        response = {
          sessionId: a.sessionId, cancelled: answer.cancelled ?? false,
          answers: (answer.answers ?? []).map(row => {
            const question = a.questions.find(q => q.index === row.index)
            if (!question) fail('sdk_wrong_question')
            return { index: row.index, question: question.question, answer: row.answer }
          }),
        }
        operation = 'ask_user_response'
      } else {
        if (answer.answers !== undefined || answer.cancelled !== undefined ||
            !a.options.some(option => option.value === answer.selectedOption)) fail('sdk_outcome_not_offered')
        if (!['proceed_once', 'cancel'].includes(answer.selectedOption)) fail('sdk_policy_escalation_refused')
        response = { sessionId: a.sessionId, selectedOption: answer.selectedOption }
        operation = 'permission_response'
      }
      const requestHash = hash({ type: 'response', id: a.requestId, result: response })
      id(context.commandId)
      const attempt = {
        commandId: context.commandId, attentionId: a.attentionId, requestHash, response: clone(response),
        state: 'invoked', invokedAt: date(now),
      }
      await serial(async () => { a.state = 'answer_unknown'; record.answerAttempts.push(attempt); await commit() })
      guard(context)
      try {
        await authorize(context, operation, a.sessionId, requestHash)
        if (operation === 'permission_response') client.sendPermissionResponse(a.requestId, response)
        else client.sendAskUserResponse(a.requestId, response)
        await serial(async () => { attempt.state = 'sent'; await commit() })
      } catch (error) {
        await serial(async () => { attempt.state = 'unknown'; await commit() })
        throw error
      } finally { gate.disarm() }
      guard(context)
      return { status: 'sent', commandId: context.commandId }
    }),
    async observe(binding, context) {
      validateBinding(binding)
      if (!record) {
        const source = options.journalForObservation?.(context) ?? context.providerJournal
        if (!source) fail('sdk_observation_journal_missing')
        journal = source
        const previous = journal.read()
        if (!previous) fail('sdk_observation_journal_missing')
        record = validateProviderRecord(previous, {
          ...hostBinding(previous), ...context, machineId: binding.machineId, binding,
        })
        restored = true; fenced = true
      }
      if (context.ownerId !== record.ownerId || context.missionId !== record.missionId ||
          hash(binding) !== hash(record.binding)) fail('sdk_observation_wrong_binding')
      await queue
      const presentSections = [], history = [], sessionIds = [record.rootSessionId]
      let state = record.observations.mission?.envelope.params.notification.state ?? 'awaiting_input'
      let providerAt = null, found = false, metadataComplete = false, messagesComplete = false
      let cursor
      const pageLimit = options.maxReadPages ?? 8, seen = new Set()
      for (let page = 0; page < pageLimit; page++) {
        const params = { limit: 100, includeArchived: true, includeMissionMetadata: true }
        if (cursor !== undefined) params.endBefore = cursor
        const result = await client.listAvailableSessions(params)
        boundedJson(result); secretFree({ hasMore: result?.hasMore, nextCursor: result?.nextCursor })
        object(result, ['sessions', 'hasMore', 'nextCursor'], ['sessions', 'hasMore'])
        bool(result.hasMore); array(result.sessions, 100, row => {
          if (!row || typeof row !== 'object') fail('sdk_session_row_invalid')
          id(row.sessionId)
          if (!Number.isFinite(row.updatedAt)) fail('sdk_session_row_invalid')
          for (const key of ['cwd', 'title', 'callingSessionId', 'callingToolUseId', 'organizationId']) {
            if (row[key] !== undefined) str(row[key], 8192, true)
          }
          const shape = rowMissionShape(row.mission)
          const ownedRow = row.sessionId === record.rootSessionId || row.callingSessionId === record.rootSessionId ||
            record.sessions.some(session => session.sessionId === row.sessionId)
          // Mission metadata is evidence only for our own sessions; unrelated rows
          // on the shared daemon are ignored, whatever their shape.
          if (ownedRow) {
            secretFree(row)
            checkOwnedMissionShape(row.mission, shape)
            if (row.missionV2 !== undefined && row.missionV2 !== null) checkOwnedMissionShape(row.missionV2, 'v2')
          }
          if (row.sessionId === record.rootSessionId) {
            found = true
            if (row.cwd && row.cwd !== binding.cwd) fail('sdk_observed_workspace_mismatch')
            // v1 metadata for a v2 root (or the reverse) is contradictory evidence, never fresh state.
            if ((shape === 'v1' && (record.dialect === 'v2' || record.dialect === 'v2-agents')) ||
                (shape === 'v2' && record.dialect === 'v1')) {
              fail('sdk_mission_dialect_mixed')
            }
            if (shape === 'v1') {
              one(row.mission.state, MISSION_STATES)
              state = row.mission.state
              if (row.mission.updatedAt !== undefined && row.mission.updatedAt !== null) {
                str(row.mission.updatedAt, 128); providerAt = row.mission.updatedAt
              }
              if (!presentSections.includes('mission')) presentSections.push('mission')
            }
          }
          if (row.callingSessionId === record.rootSessionId) sessionIds.push(row.sessionId)
        })
        if (!result.hasMore) { metadataComplete = true; break }
        if (typeof result.nextCursor !== 'number' || !Number.isFinite(result.nextCursor) || seen.has(result.nextCursor)) break
        seen.add(result.nextCursor); cursor = result.nextCursor
      }
      cursor = undefined; seen.clear()
      const messages = new Map()
      for (let page = 0; page < pageLimit; page++) {
        const params = { sessionId: binding.sessionId, limit: 100 }
        if (cursor !== undefined) params.cursor = cursor
        const raw = await client.getSessionMessages(params)
        // A page is bounded by the transport limit before opaque reasoning is
        // stripped; projected history is clipped to its own bound below.
        boundedJson(raw, NATIVE_RESPONSE_MAX_BYTES)
        const result = withoutOpaque(raw)
        secretFree(result)
        object(result, ['messages', 'hasMore', 'nextCursor'], ['messages', 'hasMore'])
        bool(result.hasMore); array(result.messages, 100, message => { if (!isInternalSdkMessage(message)) validateSdkMessage(message) })
        result.messages = result.messages.filter(message => !isInternalSdkMessage(message))
        for (const message of result.messages) {
          const previous = messages.get(message.id)
          if (previous && hash(previous) !== hash(message)) fail('sdk_history_identity_conflict')
          messages.set(message.id, message)
        }
        if (!result.hasMore) { messagesComplete = true; break }
        if (typeof result.nextCursor !== 'string' || !result.nextCursor || seen.has(result.nextCursor)) break
        seen.add(result.nextCursor); cursor = result.nextCursor
      }
      // A bounded pagination gap carries no history rows or history authority.
      // Never clip an SDK page and then represent it as a complete section.
      let historyClipped = false
      if (messagesComplete) {
        presentSections.push('history')
        for (const message of messages.values()) {
          if (!['user', 'assistant'].includes(message.role)) continue
          let text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
          if (!text) continue
          if (text.length > 32768) { text = `${text.slice(0, 32754)}\n… [truncated]`; historyClipped = true }
          history.push({ id: `sdk-${hash([binding.sessionId, message.id])}`, who: message.role === 'user' ? 'owner' : 'factory',
            text, at: new Date(message.createdAt).toISOString() })
        }
        // The broker accepts at most 128 rows inside a bounded observation. Keep
        // the latest rows that fit; the daemon holds the rest (re-read any time),
        // and the clip is reported in read diagnostics, never silent.
        let bytes = 0, kept = 0
        for (let i = history.length - 1; i >= 0; i--) {
          const size = Buffer.byteLength(history[i].text)
          if (kept >= 128 || bytes + size > 65536) break
          kept++; bytes += size
        }
        if (history.length > kept) { history.splice(0, history.length - kept); historyClipped = true }
      }
      let features = [], progressLog = [], workerSessionIds = [], finalization = {}, missionRecord = null
      if (record.dialect === 'v1') {
        // Legacy display facts from the latest persisted root notifications. A
        // section that cannot be represented inside the bounds is omitted (no claim).
        const latest = key => record.observations[key]?.envelope.params.notification ?? null
        const projected = latest('features') ? projectV1Features(latest('features').features) : null
        if (projected) { features = projected; presentSections.push('features') }
        const progress = latest('progress') ? projectV1Progress(latest('progress').progressLog) : null
        if (progress) { progressLog = progress; presentSections.push('progress') }
        workerSessionIds = [...new Set(record.observations.workers.map(row => row.envelope.params.notification)
          .filter(n => n.type === 'mission_worker_started').map(n => n.workerSessionId))]
        sessionIds.push(...workerSessionIds)
        presentSections.push('workers')
      }
      if (record.dialect === 'v2') {
        let inputs = missionV2Inputs(record), verifiedRecord = null
        // The durable record is consulted only for an approved v2 plan with a persisted snapshot.
        if (inputs.planApproved && inputs.snapshot && options.missionRecordReader) {
          const before = hash(record.missionV2.snapshot)
          try {
            verifiedRecord = normalizeMissionV2Record(await options.missionRecordReader.read({
              machineId: record.machineId, sessionId: record.rootSessionId, snapshot: clone(inputs.snapshot),
            }))
          } catch { verifiedRecord = { verified: false, reason: 'mission_record_read_failed' } }
          await queue
          if (hash(record.missionV2.snapshot) !== before) verifiedRecord = { verified: false, reason: 'mission_snapshot_advanced' }
          inputs = missionV2Inputs(record)
        }
        if (checkMissionV2Record({ ...inputs, verifiedRecord }).ok) {
          const projected = projectV2Features(inputs.approvedChecks, verifiedRecord)
          const progress = projectV2Progress({ workers: inputs.workers, verifiedRecord })
          if (projected && progress) {
            features = projected; progressLog = progress
            presentSections.push('features', 'progress')
          } else verifiedRecord = { verified: false, reason: 'mission_record_unrepresentable' }
        }
        const agreement = checkMissionV2Record({ ...inputs, verifiedRecord })
        missionRecord = verifiedRecord ? (agreement.ok ? 'verified' : agreement.reason) : null
        state = deriveMissionV2State({ ...inputs, verifiedRecord })
        if (!presentSections.includes('mission')) presentSections.push('mission')
        workerSessionIds = missionV2WorkerSessionIds(inputs)
        sessionIds.push(...inputs.workers.map(row => row.sessionId))
        presentSections.push('workers')
        if (state === 'completed' && messagesComplete) {
          finalization = closingSummary(messages, inputs.workers.every(row => row.finished))
          if (finalization.summary) presentSections.push('finalization')
        }
      }
      if (record.dialect === 'v2-agents') {
        // No durable record exists for v2-agents; the reader is never consulted.
        missionRecord = MISSION_V2_AGENTS_NO_RECORD
        const live = () => !restored && !fenced && !record.ingestionFault && client.isConnected() &&
          client.getConnectionId() === record.connectionId
        // A completion is latched (and persisted) only by a live provider that could
        // have seen any new root activity during the settle window.
        if (live()) {
          await serial(async () => {
            const m = record.missionV2Agents
            if (m.completed || !live()) return
            const current = missionV2AgentsInputs(record, { nowMs: now(), settleMs: agentsSettleMs, live: true })
            if (deriveMissionV2AgentsState(current) !== 'completed') return
            m.completed = { observedAt: date(now), seq: ++m.seq, lateActivity: 0, lastLateActivityAt: null }
            await commit()
          })
        }
        const inputs = missionV2AgentsInputs(record, { nowMs: now(), settleMs: agentsSettleMs, live: false })
        state = deriveMissionV2AgentsState(inputs)
        const projected = projectV2AgentFeatures(inputs.agents)
        const progress = projectV2AgentProgress(inputs)
        if (projected && progress) {
          features = projected; progressLog = progress
          presentSections.push('features', 'progress')
        }
        if (!presentSections.includes('mission')) presentSections.push('mission')
        workerSessionIds = inputs.agents.map(row => row.sessionId)
        sessionIds.push(...workerSessionIds)
        presentSections.push('workers')
        if (state === 'completed' && messagesComplete) {
          finalization = closingSummary(messages, missionV2AgentsSettled(inputs.agents))
          if (finalization.summary) presentSections.push('finalization')
        }
      }
      options.onReadDiagnostics?.({
        found, metadataComplete, messagesComplete, restored, pendingComplete: false,
        historyHold: messagesComplete ? null : 'sdk_history_pagination_incomplete',
        ...(historyClipped ? { historyClipped: true } : {}),
        ...(record.dialect ? { dialect: record.dialect } : {}),
        ...(record.dialect === 'v2' || record.dialect === 'v2-agents' ? { missionRecord } : {}),
      })
      return {
        binding: clone(binding), state, features, progressLog, workerSessionIds,
        pending: [], pendingComplete: false, pendingSource: 'notification', sessionIds: [...new Set(sessionIds)],
        completeness: 'gap', effectiveSettings: {}, scopeRevision: record.scopeRevision,
        scopeHash: record.scopeHash, policyHash: record.policyHash, providerAt, history, presentSections, ...finalization,
      }
    },
    async flush() {
      let pending
      do { pending = queue; await pending } while (pending !== queue)
    },
    providerRecord() { return record ? clone(record) : null },
    isFenced() { return fenced || restored },
    detach() { fenced = true; gate.disarm() }, // Phone absence must never call client.destroy/disconnect.
  }
}
