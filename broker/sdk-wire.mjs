/**
 * Static 0.9.1 daemon dialect. This module neither imports nor executes the SDK.
 * Raw provider strings are never fitted, and SDK prompt stores are never authority.
 */
import {
  array, attention as validateAttention, bool, boundedJson, clone, digest, fail, hash,
  id, int, NATIVE_RESPONSE_MAX_BYTES, object, one, secretFree, str, time, unique,
} from './validation.mjs'

export const SDK_TRANSPORT_VERSION = '@factory/droid-sdk@0.9.1/daemon'
export const SDK_PROTOCOL_VERSION = '1.201.1'
export const MISSION_STATES = Object.freeze([
  'planning', 'awaiting_input', 'initializing', 'running', 'paused', 'orchestrator_turn', 'completed',
])
const OUTCOMES = [
  'proceed_once', 'proceed_always', 'proceed_always_file', 'proceed_auto_run',
  'proceed_auto_run_low', 'proceed_auto_run_medium', 'proceed_auto_run_high',
  'proceed_new_session', 'proceed_new_session_low', 'proceed_new_session_medium',
  'proceed_new_session_high', 'proceed_edit', 'proceed_always_tools',
  'proceed_always_server', 'proceed_report_false_positive', 'cancel',
]
const dict = value => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('sdk_invalid_object')
  return value
}
const finite = value => { if (typeof value !== 'number' || !Number.isFinite(value)) fail('sdk_invalid_number') }
const strings = (value, max = 128) => array(value, max, row => str(row, 8192, true))
const optional = (row, key, visit) => { if (Object.hasOwn(row, key)) visit(row[key]) }
const strict = (row, keys) => { dict(row); if (Object.keys(row).some(key => !keys.includes(key))) fail('sdk_unknown_field') }
const filled = (value, max = 65536) => { str(value, max); if (!value.trim()) fail('sdk_blank_string') }

export const MISSION_V2_TAG = 'mission-v2'
/** Compiled initialize tags: droid >= 0.238 enters Missions 2.0 only through this session tag. */
export const MISSION_V2_INITIALIZE_TAGS = Object.freeze([Object.freeze({ name: MISSION_V2_TAG })])
/** droid 0.238 tag metadata kinds (`{ kind, missionId }`); the root of a job must be the orchestrator. */
export const MISSION_V2_AGENTS_TAG_KINDS = Object.freeze(['orchestrator', 'agent'])
/** droid 0.238 root-session tools that drive Missions 2.0 agents. */
export const MISSION_V2_AGENT_TOOL_NAMES = Object.freeze(['SpawnAgent', 'ListAgents', 'SendMessage', 'InterruptAgent'])
export const MISSION_V2_AGENT_STATUSES = Object.freeze(['idle', 'pending', 'running'])
/** droid-side Missions 2.0 org/session gating reasons and the provider fault each maps to. */
export const MISSION_V2_GATING_FAULTS = Object.freeze({
  missions_v2_disabled: 'sdk_missions_v2_disabled',
  missions_v2_access_restricted: 'sdk_missions_v2_access_restricted',
  missions_v2_access_unavailable: 'sdk_missions_v2_access_unavailable',
  mission_v2_session_not_active: 'sdk_mission_v2_session_not_active',
  mission_v2_legacy_mission_active: 'sdk_mission_v2_legacy_mission_active',
})
/** Provider fault for droid gating text found in a bounded string, or null. Never throws. */
export function missionV2GatingFault(...values) {
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue
    const text = value.length > 65536 ? value.slice(0, 65536) : value
    for (const [reason, code] of Object.entries(MISSION_V2_GATING_FAULTS)) {
      if (new RegExp(`(?:^|[^a-z0-9_])${reason}(?:$|[^a-z0-9_])`).test(text)) return code
    }
  }
  return null
}
/** The `mission-v2` tag of a settings object, or null (validated shape from validateSdkNotification). */
export function missionV2TagOf(settings) {
  if (!settings || !Array.isArray(settings.tags)) return null
  return settings.tags.find(tag => tag && tag.name === MISSION_V2_TAG) ?? null
}
/**
 * Dialect proven by a `mission-v2` tag: droid 0.238 tags carry `metadata.kind`
 * ('v2-agents'); droid 0.227 tags carry none or only plan-approval metadata ('v2').
 */
export function missionV2TagDialect(tag) {
  if (!tag) return 'none'
  return tag.metadata && Object.hasOwn(tag.metadata, 'kind') ? 'v2-agents' : 'v2'
}
export const MISSION_V2_REQUEST_TYPES = Object.freeze(['recommend_mission', 'exit_mission_planning'])
export const MISSION_V1_REQUEST_TYPES = Object.freeze(['propose_mission', 'start_mission_run'])
export const MISSION_V2_NOTIFICATION_TYPES = Object.freeze(['mission_v2_snapshot_changed', 'agent_turn_completed'])
// mission_heartbeat is deliberately absent: it is not proven to be v1-only.
export const MISSION_V1_NOTIFICATION_TYPES = Object.freeze([
  'mission_state_changed', 'mission_features_changed', 'mission_progress_entry',
  'mission_worker_started', 'mission_worker_completed',
])
export const MISSION_V2_CHECK_KINDS = Object.freeze(['verification', 'review', 'decision'])
export const MISSION_V2_OUTCOMES = Object.freeze(['met', 'unmet', 'waived'])
const MISSION_V2_MAX_CHECKS = 256
// Text fields are bounded only by the 256 KiB frame bound. Display limits live in
// missionV2PlanText, so an oversized but well-formed plan is a handoff, not a fault.
const MISSION_V2_TEXT_MAX = 262144
/**
 * Largest exit_mission_planning payload (request params, UTF-8 JSON bytes) that is
 * offered as an approvable proposal. Equals the broker's per-request raw bound
 * (attentionMeta / pending raw); with the plan text copy it stays well inside the
 * provider record budget. Larger plans are review-in-Factory handoffs.
 */
export const MISSION_V2_PLAN_REQUEST_MAX_BYTES = 131072
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

/** Strict droid 0.227.0 Mission v2 Check. */
export function validateMissionV2Check(row) {
  strict(row, ['id', 'group', 'description', 'about', 'kind', 'how'])
  filled(row.id, 256); filled(row.group, MISSION_V2_TEXT_MAX); filled(row.description, MISSION_V2_TEXT_MAX)
  optional(row, 'about', value => filled(value, MISSION_V2_TEXT_MAX))
  optional(row, 'kind', value => one(value, MISSION_V2_CHECK_KINDS))
  optional(row, 'how', value => filled(value, MISSION_V2_TEXT_MAX))
  return row
}
/** Strict droid 0.227.0 Mission v2 Artifact. */
export function validateMissionV2Artifact(row) {
  strict(row, ['id', 'where', 'description', 'identity'])
  str(row.id, 256); if (!ARTIFACT_ID.test(row.id)) fail('sdk_mission_v2_artifact_id')
  filled(row.where, MISSION_V2_TEXT_MAX)
  optional(row, 'description', value => filled(value, MISSION_V2_TEXT_MAX))
  optional(row, 'identity', value => filled(value, MISSION_V2_TEXT_MAX))
  return row
}
export function validateMissionV2Checks(checks) {
  array(checks, MISSION_V2_MAX_CHECKS, validateMissionV2Check)
  unique(checks.map(check => check.id))
  return checks
}
/** Strict mission_v2_snapshot_changed snapshot. */
export function validateMissionV2Snapshot(row) {
  strict(row, ['sessionId', 'title', 'approvedAt', 'latestEventNumber', 'planHash', 'checksHash', 'checkCounts'])
  id(row.sessionId); str(row.title, 8192)
  if (typeof row.approvedAt !== 'string' || !ISO_UTC.test(row.approvedAt)) fail('sdk_invalid_time')
  time(row.approvedAt); int(row.latestEventNumber); digest(row.planHash); digest(row.checksHash)
  strict(row.checkCounts, ['total', 'met', 'unmet', 'waived'])
  for (const key of ['total', 'met', 'unmet', 'waived']) int(row.checkCounts[key])
  const c = row.checkCounts
  if (c.met + c.unmet + c.waived > c.total) fail('sdk_mission_v2_counts_invalid')
  return row
}
function validateExitMissionPlanning(details) {
  str(details.missionPlan, MISSION_V2_TEXT_MAX, true); filled(details.title, MISSION_V2_TEXT_MAX)
  optional(details, 'validationStrategy', value => str(value, MISSION_V2_TEXT_MAX, true))
  validateMissionV2Checks(details.checks)
  optional(details, 'artifacts', rows => {
    array(rows, 128, validateMissionV2Artifact); unique(rows.map(row => row.id))
  })
}
const isFeatureId = value => { try { id(value); return true } catch { return false } }
/**
 * Owner-readable plan covering every hashed field (plan, validation strategy,
 * checks with kind/about/how, artifacts), or null when it cannot be shown or
 * tracked without clipping.
 */
function missionV2PlanText(details, raw) {
  if (Buffer.byteLength(JSON.stringify(raw)) > MISSION_V2_PLAN_REQUEST_MAX_BYTES) return null
  if (!details.checks.length || details.checks.length > 512 || details.title.length > 8192) return null
  // Feature projection (validation.feature) bounds description/milestone/how at 8192.
  if (details.checks.some(check => !isFeatureId(check.id) || check.description.length > 8192 ||
      check.group.length > 8192 || (check.how !== undefined && check.how.length > 8192))) return null
  const list = details.checks.map(check => `- ${check.id} (${check.group}): ${check.description}` +
    (check.kind === undefined ? '' : `\n  Kind: ${check.kind}`) +
    (check.about === undefined ? '' : `\n  About: ${check.about}`) +
    (check.how === undefined ? '' : `\n  How: ${check.how}`)).join('\n')
  const strategy = details.validationStrategy?.trim() ? `\n\nValidation strategy:\n${details.validationStrategy}` : ''
  const artifacts = details.artifacts?.length ? `\n\nArtifacts:\n${details.artifacts.map(row => `- ${row.id}: ${row.where}` +
    (row.description === undefined ? '' : `\n  Description: ${row.description}`) +
    (row.identity === undefined ? '' : `\n  Identity: ${row.identity}`)).join('\n')}` : ''
  const text = `${details.missionPlan}${strategy}\n\nChecks:\n${list}${artifacts}`
  return text.length > 65536 ? null : text
}
/** Request params; persisted rows may omit the redundant `raw` copy of `envelope.params`. */
export const requestPayload = request => request?.raw ?? request?.envelope?.params

/** Mission dialect proven by one decoded fact: 'v1', 'v2', 'v2-agents', 'none' or 'mixed' (one envelope with both). */
export function missionDialectOf(decoded) {
  if (decoded?.kind === 'request') {
    const raw = requestPayload(decoded)
    if (decoded.envelope?.method !== 'daemon.request_permission' || !Array.isArray(raw?.toolUses)) return 'none'
    const types = raw.toolUses.map(item => item.details.type)
    const v1 = types.some(type => MISSION_V1_REQUEST_TYPES.includes(type))
    const v2 = types.some(type => MISSION_V2_REQUEST_TYPES.includes(type))
    return v1 && v2 ? 'mixed' : v2 ? 'v2' : v1 ? 'v1' : 'none'
  }
  if (decoded?.kind === 'notification') {
    const n = decoded.envelope.params.notification
    if (n.type === 'mission_v2_snapshot_changed') return 'v2'
    if (MISSION_V1_NOTIFICATION_TYPES.includes(n.type)) return 'v1'
    if (n.type === 'settings_updated') return missionV2TagDialect(missionV2TagOf(n.settings))
  }
  return 'none'
}
/** The single-tool-use v2 request type, or null. */
export function missionV2RequestType(request) {
  const uses = requestPayload(request)?.toolUses
  if (request?.envelope?.method !== 'daemon.request_permission' || !Array.isArray(uses) || uses.length !== 1) return null
  return MISSION_V2_REQUEST_TYPES.includes(uses[0].details.type) ? uses[0].details.type : null
}

export function validateSdkFeature(row) {
  dict(row)
  id(row.id); str(row.description, 8192, true)
  one(row.status, ['pending', 'in_progress', 'completed', 'cancelled'])
  str(row.skillName, 8192, true); strings(row.preconditions); strings(row.expectedBehavior)
  for (const key of ['fulfills', 'workerSessionIds']) optional(row, key, strings)
  optional(row, 'milestone', value => str(value, 8192, true))
  for (const key of ['currentWorkerSessionId', 'completedWorkerSessionId']) {
    optional(row, key, value => { if (value !== null) id(value) })
  }
  return row
}

function handoff(row) {
  dict(row)
  for (const key of ['whatWasImplemented', 'whatWasLeftUndone']) str(row[key], 65536, true)
  optional(row, 'salientSummary', value => str(value, 65536, true))
  dict(row.verification)
  array(row.verification.commandsRun, 128, item => {
    dict(item); str(item.command, 8192, true); finite(item.exitCode); str(item.observation, 8192, true)
  })
  optional(row.verification, 'interactiveChecks', value => array(value, 128, item => {
    dict(item); str(item.action, 8192, true); str(item.observed, 8192, true)
  }))
  dict(row.tests); str(row.tests.coverage, 8192, true)
  array(row.tests.added, 128, item => {
    dict(item); str(item.file, 8192, true)
    array(item.cases, 128, test => { dict(test); str(test.name, 8192, true); str(test.verifies, 8192, true) })
  })
  optional(row.tests, 'updated', strings)
  array(row.discoveredIssues, 128, item => {
    dict(item); str(item.severity, 128); str(item.description, 8192, true)
    optional(item, 'suggestedFix', value => str(value, 8192, true))
  })
  optional(row, 'skillFeedback', feedback => {
    dict(feedback); bool(feedback.followedProcedure)
    array(feedback.deviations, 128, item => {
      dict(item); for (const key of ['step', 'whatIDidInstead', 'why']) str(item[key], 8192, true)
    })
    optional(feedback, 'suggestedChanges', strings)
  })
}

export function validateSdkProgress(row) {
  dict(row); str(row.timestamp, 128)
  const required = {
    mission_accepted: ['title'], mission_paused: [], mission_resumed: [], mission_run_started: [],
    worker_started: ['workerSessionId', 'spawnId'], worker_selected_feature: ['workerSessionId', 'featureId'],
    worker_completed: ['workerSessionId', 'featureId'], worker_failed: ['spawnId', 'reason'],
    worker_paused: ['workerSessionId'], handoff_items_dismissed: [],
    milestone_validation_triggered: ['milestone', 'featureId'],
  }
  one(row.type, Object.keys(required))
  required[row.type].forEach(key => str(row[key], 8192, true))
  for (const key of ['pauseReason', 'resumeWorkerSessionId', 'message', 'featureId', 'modelId',
    'substitutedFromModelId', 'workerSessionId', 'failureReason']) {
    optional(row, key, value => str(value, 8192, true))
  }
  optional(row, 'exitCode', finite)
  if (row.type === 'worker_completed') {
    one(row.successState, ['success', 'partial', 'failure'])
    bool(row.returnToOrchestrator); finite(row.exitCode)
    for (const key of ['commitId', 'repoPath']) optional(row, key, value => { if (value !== null) str(value, 8192, true) })
    optional(row, 'validatorsPassed', bool); optional(row, 'handoff', handoff)
  }
  optional(row, 'dismissals', value => array(value, 128, item => {
    dict(item)
    for (const key of ['type', 'sourceFeatureId', 'summary', 'justification']) str(item[key], 8192, true)
  }))
  return row
}

/**
 * droid >= 0.238 emits internal bookkeeping messages whose ids start with
 * underscores ("__…__…__<uuid>"). They are never projected or stored; any
 * other malformed id still fails validation.
 */
export const isInternalSdkMessage = message => typeof message?.id === 'string' && message.id.length <= 160 &&
  /^_+[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(message.id)

/** Validate the message data consumed for history, including nested content. */
export function validateSdkMessage(row) {
  dict(row); id(row.id)
  one(row.role, ['user', 'assistant', 'tool', 'system']); finite(row.createdAt); finite(row.updatedAt)
  array(row.content, 512, block => {
    dict(block)
    one(block.type, ['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking', 'image', 'document'])
    if (block.type === 'text') str(block.text, 65536, true)
    if (block.type === 'tool_use') { id(block.id); str(block.name, 256); dict(block.input) }
    if (block.type === 'tool_result') {
      id(block.toolUseId); optional(block, 'isError', bool)
      optional(block, 'content', content => {
        if (typeof content === 'string') str(content, 65536, true)
        else array(content, 512, item => {
          dict(item); one(item.type, ['text', 'image', 'document'])
          if (item.type === 'text') str(item.text, 65536, true)
          else dict(item.source)
        })
      })
    }
    if (block.type === 'thinking') { str(block.thinking, 65536, true); optional(block, 'signature', value => str(value, 65536, true)) }
    if (block.type === 'redacted_thinking') str(block.data, 65536, true)
    if (['image', 'document'].includes(block.type)) dict(block.source)
  })
  return row
}

function decodeRequest(envelope, context) {
  const raw = envelope.params
  dict(raw); id(raw.sessionId); id(envelope.id)
  const common = {
    attentionId: `att-${hash([context.machineId, raw.sessionId, context.connectionId, envelope.id])}`,
    requestId: envelope.id, sessionId: raw.sessionId, machineId: context.machineId,
    toolUseIds: [], associatedSessionIds: [], revision: 1, payloadHash: hash(raw),
    kind: 'unsupported', title: 'Factory request', details: '', options: [], questions: [],
    state: 'open', openedAt: context.observedAt, resolvedAt: null,
  }
  let unsupportedReason = null, proposalHash = null
  if (envelope.method === 'daemon.ask_user') {
    id(raw.toolCallId); common.toolUseIds = [raw.toolCallId]
    array(raw.questions, 64, q => {
      dict(q); int(q.index, 1); str(q.topic, 8192, true); str(q.question, 8192)
      optional(q, 'multiSelect', bool); strings(q.options)
    })
    unique(raw.questions.map(q => q.index))
    common.questions = raw.questions.map(q => ({
      index: q.index, topic: q.topic, question: q.question, multiSelect: q.multiSelect ?? false,
      options: q.options.map((value, index) => ({ id: `option-${index + 1}`, label: value, value })),
    }))
    unsupportedReason = raw.questions.some(q => q.multiSelect) ? 'sdk_multiselect_encoding_unqualified' : null
    common.kind = unsupportedReason ? 'unsupported' : 'ask_user'
    common.title = 'Factory questions'
    common.details = raw.questions.map(q => q.question).join('\n')
  } else {
    array(raw.toolUses, 128, item => {
      dict(item); dict(item.toolUse); dict(item.details)
      one(item.toolUse.type, ['tool_use']); id(item.toolUse.id); str(item.toolUse.name, 256); dict(item.toolUse.input)
      str(item.confirmationType, 256); str(item.details.type, 256)
      if (item.details.type === 'propose_mission') {
        str(item.details.proposal, 65536, true); optional(item.details, 'title', value => str(value, 8192))
      }
      if (item.details.type === 'start_mission_run') {
        finite(item.details.runningMissionCount); array(item.details.runningMissionSessionIds, 128, id)
      }
      if (item.details.type === 'recommend_mission') filled(item.details.reason, 65536)
      if (item.details.type === 'exit_mission_planning') validateExitMissionPlanning(item.details)
      const required = {
        edit: ['filePath', 'fileName'], exec: ['fullCommand', 'command'],
        create: ['filePath', 'fileName', 'content'], apply_patch: ['filePath', 'fileName', 'patchContent'],
        mcp_tool: ['toolName', 'impactLevel'], exit_spec_mode: ['plan'], ask_user: ['questionnaire'],
      }
      for (const key of required[item.details.type] ?? []) str(item.details[key], 65536, true)
      if (item.details.type === 'exec') optional(item.details, 'extractedCommands', strings)
      if (item.details.type === 'apply_patch') optional(item.details, 'files', rows => array(rows, 128, file => {
        dict(file); str(file.filePath, 2048); str(file.fileName, 2048)
        one(file.operation, ['create', 'update', 'delete'])
        for (const key of ['moveTo', 'oldContent', 'newContent']) optional(file, key, value => str(value, 65536, true))
      }))
    })
    array(raw.options, 128, option => { dict(option); str(option.label, 8192); one(option.value, OUTCOMES) })
    unique(raw.options.map(option => option.value))
    optional(raw, 'associatedSessionIds', value => { array(value, 128, id); unique(value) })
    common.toolUseIds = raw.toolUses.map(item => item.toolUse.id); unique(common.toolUseIds)
    common.associatedSessionIds = raw.associatedSessionIds ?? []
    common.options = raw.options.map((option, index) => ({ id: `option-${index + 1}`, ...option }))
    const kinds = new Set(raw.toolUses.map(item => item.details.type))
    let text = null
    if (!raw.toolUses.length || kinds.size !== 1) unsupportedReason = 'sdk_mixed_permission_handoff'
    else {
      const type = raw.toolUses[0].details.type
      if ([...MISSION_V1_REQUEST_TYPES, ...MISSION_V2_REQUEST_TYPES].includes(type) && raw.toolUses.length !== 1) {
        unsupportedReason = 'sdk_batched_mission_permission_handoff'
      } else if (type === 'propose_mission') {
        common.kind = 'proposal'; common.title = raw.toolUses[0].details.title ?? 'Factory proposal'
        proposalHash = hash(raw.toolUses[0].details)
      } else if (type === 'start_mission_run') { common.kind = 'start'; common.title = 'Start Factory Mission' }
      else if (type === 'recommend_mission') {
        common.kind = 'permission'; common.title = 'Plan as a Factory Mission'; text = raw.toolUses[0].details.reason
      } else if (type === 'exit_mission_planning') {
        const details = raw.toolUses[0].details
        text = missionV2PlanText(details, raw)
        // Approval of an exact plan is its own start in v2; there is no later start request.
        proposalHash = hash(details)
        if (text === null) {
          unsupportedReason = 'sdk_mission_v2_plan_unrepresentable'
          text = 'This Factory Mission plan cannot be shown or tracked here without clipping. Review it in Factory.'
        } else { common.kind = 'proposal'; common.title = details.title }
      }
      else if (['exec', 'edit', 'create', 'apply_patch', 'mcp_tool'].includes(type)) common.kind = 'permission'
      else unsupportedReason = 'sdk_confirmation_handoff'
    }
    common.details = text ?? JSON.stringify(raw.toolUses.map(item => item.details))
  }
  if (raw.sessionId !== context.rootSessionId) unsupportedReason ??= 'sdk_child_attention_unqualified'
  validateAttention(common)
  return { kind: 'request', envelope: clone(envelope), raw: clone(raw), attention: common, proposalHash, unsupportedReason }
}

export function validateSdkNotification(notification) {
  dict(notification); str(notification.type, 128)
  switch (notification.type) {
    case 'mission_state_changed':
      one(notification.state, MISSION_STATES); optional(notification, 'updatedAt', value => str(value, 128)); break
    case 'mission_features_changed': array(notification.features, 2048, validateSdkFeature); break
    case 'mission_progress_entry': array(notification.progressLog, 4096, validateSdkProgress); break
    case 'mission_heartbeat': str(notification.timestamp, 128); break
    case 'mission_worker_started': id(notification.workerSessionId); break
    case 'mission_worker_completed': id(notification.workerSessionId); finite(notification.exitCode); break
    case 'mission_v2_snapshot_changed': validateMissionV2Snapshot(notification.snapshot); break
    case 'agent_turn_completed': {
      // Token usage and timing fields are not consumed and stay unvalidated beyond bounded JSON.
      // Any session may send this; an unusable one is ignored (never a turn completion), not a fault.
      const { reason, turnId } = notification
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 128 || reason.includes('\0')) return false
      if (turnId !== undefined && (typeof turnId !== 'string' || !turnId.trim() || turnId.length > 512 || turnId.includes('\0'))) return false
      break
    }
    case 'permission_resolved':
      id(notification.requestId); array(notification.toolUseIds, 128, id); unique(notification.toolUseIds)
      one(notification.selectedOption, OUTCOMES); break
    case 'tool_result':
      id(notification.messageId); id(notification.toolUseId); optional(notification, 'isError', bool)
      optional(notification, 'content', value => {
        if (typeof value === 'string') str(value, 65536, true)
        else array(value, 512, item => {
          dict(item); one(item.type, ['text', 'image', 'document'])
          if (item.type === 'text') str(item.text, 65536, true)
          else dict(item.source)
        })
      }); break
    case 'create_message':
      // droid >= 0.238 internal bookkeeping messages carry nothing to project.
      if (isInternalSdkMessage(notification.message)) return false
      validateSdkMessage(notification.message); optional(notification, 'requestId', id); break
    case 'settings_updated':
      dict(notification.settings); optional(notification, 'requestId', id)
      for (const key of ['modelId', 'reasoningEffort', 'interactionMode', 'autonomyLevel', 'autonomyMode']) {
        optional(notification.settings, key, value => str(value, 256))
      }
      for (const key of ['restrictToolIds', 'enabledToolIds', 'disabledToolIds', 'additionalToolIds', 'availableAutonomyLevels']) {
        optional(notification.settings, key, strings)
      }
      optional(notification.settings, 'missionSettings', value => {
        dict(value)
        for (const key of ['workerModel', 'workerReasoningEffort', 'validationWorkerModel', 'validationWorkerReasoningEffort']) {
          optional(value, key, item => str(item, 256))
        }
        optional(value, 'skipScrutiny', bool); optional(value, 'skipUserTesting', bool)
      })
      optional(notification.settings, 'tags', tags => array(tags, 128, tag => {
        dict(tag); str(tag.name, 256)
        optional(tag, 'metadata', metadata => {
          dict(metadata)
          if (Object.keys(metadata).length > 64) fail('sdk_tag_metadata_too_large')
          for (const value of Object.values(metadata)) str(value, 8192, true)
        })
      }))
      break
    case 'child_session_available':
      id(notification.childSessionId); finite(notification.timestamp)
      optional(notification, 'toolUseId', id); optional(notification, 'subagentType', value => str(value, 256))
      optional(notification, 'description', value => str(value, 65536, true)); break
    case 'droid_working_state_changed': str(notification.newState, 128); break
    case 'session_inactivity': finite(notification.timestamp); finite(notification.timeoutSeconds); str(notification.message, 8192); break
    case 'session_process_exited': finite(notification.timestamp); str(notification.message, 8192); break
    case 'session_closed': finite(notification.timestamp); break
    case 'session_unsubscribed': str(notification.message, 8192); break
    case 'session_working_directory_changed': str(notification.cwd, 2048); break
    default: return false
  }
  return true
}

/** Throws on malformed known dialects. safeDecodeSdkEnvelope catches at the interceptor. */
const OPAQUE_KEYS = new Set(['openaiEncryptedContent', 'encryptedContent', 'encrypted_content'])

/**
 * Provider-encrypted reasoning blobs and thinking signatures are random base64
 * that can look like credentials to the secret scanner. They carry no evidence
 * the broker may read, so they are dropped before scanning and never stored.
 */
export function withoutOpaque(value) {
  if (Array.isArray(value)) return value.map(withoutOpaque)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (OPAQUE_KEYS.has(key)) continue
    if (key === 'signature' && value.type === 'thinking') continue
    out[key] = key === 'data' && value.type === 'redacted_thinking' ? '' : withoutOpaque(item)
  }
  return out
}

export function decodeSdkEnvelope(data, context) {
  str(context.machineId, 160); str(context.connectionId, 160); id(context.rootSessionId); time(context.observedAt)
  const parsed = typeof data === 'string' ? JSON.parse(data) : clone(data)
  // Opaque reasoning blobs can dominate a frame. Bound the raw frame by the
  // transport limit, and the stored (stripped) envelope by the observation bound.
  boundedJson(parsed, NATIVE_RESPONSE_MAX_BYTES)
  const envelope = withoutOpaque(parsed)
  boundedJson(envelope)
  dict(envelope)
  one(envelope.jsonrpc, ['2.0']); one(envelope.factoryApiVersion, ['1.0.0'])
  optional(envelope, 'factoryProtocolVersion', value => str(value, 128))
  one(envelope.type, ['request', 'response', 'notification'])
  if (envelope.type === 'response') {
    // Initialization responses can contain MCP secrets. Never persist/hash their raw result.
    if (envelope.id !== null) id(envelope.id)
    if (!Object.hasOwn(envelope, 'result') && !Object.hasOwn(envelope, 'error')) fail('sdk_response_missing_result')
    let resourceSessionId = null
    const result = envelope.result
    if (!Object.hasOwn(envelope, 'error') && result && typeof result.sessionId === 'string' &&
        result.session && Array.isArray(result.session.messages) &&
        result.settings && typeof result.settings === 'object' && !Array.isArray(result.settings)) {
      id(result.sessionId); resourceSessionId = result.sessionId
    }
    return { kind: 'receipt', requestId: envelope.id, hasResult: Object.hasOwn(envelope, 'result'), resourceSessionId }
  }
  secretFree(envelope)
  if (envelope.type === 'request') {
    one(envelope.method, ['daemon.request_permission', 'daemon.ask_user'])
    return decodeRequest(envelope, context)
  }
  if (envelope.method !== 'daemon.session_notification') return { kind: 'ignored' }
  dict(envelope.params); id(envelope.params.sessionId)
  if (!validateSdkNotification(envelope.params.notification)) return { kind: 'ignored' }
  return { kind: 'notification', sessionId: envelope.params.sessionId, envelope: clone(envelope) }
}

export function safeDecodeSdkEnvelope(data, context) {
  try { return decodeSdkEnvelope(data, context) }
  catch (error) {
    // Shape only (never content): which frame and which check refused it.
    let shape = 'unparseable'
    try {
      const e = typeof data === 'string' ? JSON.parse(data) : data
      shape = `${e?.type}/${e?.method}/${e?.params?.notification?.type ?? e?.params?.toolUses?.[0]?.details?.type ?? '-'}`
      const n = e?.params?.notification
      if (n?.type === 'create_message') {
        const sketch = v => typeof v === 'string' ? v.replace(/[A-Za-z]/g, 'a').replace(/[0-9]/g, '9').slice(0, 80) : String(v)
        shape += ` ids msg=${sketch(n.message?.id)} req=${sketch(n.requestId)} blocks=${(n.message?.content ?? [])
          .map(b => `${b?.type}:${sketch(b?.id ?? b?.toolUseId)}`).join(',').slice(0, 300)}`
      }
    } catch {}
    process.stderr.write(`[broker] sdk frame refused: ${shape}: ${error?.code ?? error?.name ?? 'unknown'}\n`)
    return { kind: 'diagnostic', code: 'sdk_ingestion_invalid' }
  }
}

/** Correlation proves native effects, never the identity of the answering actor. */
export function correlateNativeResolution(request, envelope) {
  const notification = envelope.params.notification
  if (envelope.params.sessionId !== request.attention.sessionId) return null
  if (notification.type === 'permission_resolved') {
    if (request.envelope.method !== 'daemon.request_permission' ||
        notification.requestId !== request.attention.requestId ||
        hash([...notification.toolUseIds].sort()) !== hash([...request.attention.toolUseIds].sort()) ||
        !request.attention.options.some(option => option.value === notification.selectedOption)) return null
    return { kind: 'permission_effect', selectedOption: notification.selectedOption, attribution: 'unknown_or_external' }
  }
  if (notification.type === 'tool_result' && request.envelope.method === 'daemon.ask_user' &&
      notification.toolUseId === requestPayload(request).toolCallId) {
    return { kind: 'ask_user_tool_terminated', answerAcceptance: 'unknown', attribution: 'unknown_or_external' }
  }
  return null
}

/** Hash only execution semantics; never include/hash an extension credential. */
export function outgoingDescriptor(data) {
  const envelope = typeof data === 'string' ? JSON.parse(data) : data
  dict(envelope); one(envelope.jsonrpc, ['2.0']); one(envelope.factoryApiVersion, ['1.0.0'])
  const params = dict(envelope.type === 'response' ? envelope.result : envelope.params)
  const safe = clone(params)
  if (envelope.type === 'request' && envelope.method === 'daemon.initialize_session') delete safe.token
  boundedJson(safe); secretFree(safe)
  if (envelope.type === 'request' && envelope.method === 'daemon.initialize_session') {
    id(params.sessionId); id(params.machineId); str(params.token, 65536); str(params.cwd, 2048)
    // The only tag the broker may set is the bare Missions 2.0 entry tag.
    if (Object.hasOwn(params, 'tags') && hash(params.tags) !== hash(MISSION_V2_INITIALIZE_TAGS)) fail('sdk_send_tags_refused')
    return { operation: 'initialize', sessionId: params.sessionId, requestHash: hash({ method: envelope.method, params: safe }) }
  }
  if (envelope.type === 'request' && envelope.method === 'daemon.add_user_message') {
    id(envelope.id); id(params.sessionId); str(params.text, 65536)
    return { operation: 'owner_turn', sessionId: params.sessionId, requestHash: hash({ method: envelope.method, id: envelope.id, params: safe }) }
  }
  if (envelope.type === 'response') {
    id(envelope.id); id(params.sessionId)
    const permission = Object.hasOwn(params, 'selectedOption')
    if (permission) one(params.selectedOption, OUTCOMES)
    else { array(params.answers, 64, item => { dict(item); int(item.index, 1); str(item.question, 8192); str(item.answer, 8192, true) }); optional(params, 'cancelled', bool) }
    return {
      operation: permission ? 'permission_response' : 'ask_user_response', sessionId: params.sessionId,
      requestHash: hash({ type: 'response', id: envelope.id, result: safe }),
    }
  }
  fail('sdk_send_method_refused')
}

export function validateRequestHash(value) { digest(value) }
