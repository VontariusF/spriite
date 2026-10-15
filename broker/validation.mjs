import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

// One wire limit for the broker/server. Leave space for safety holds and live
// capability substitution instead of discovering an unreadable job after commit.
export const NATIVE_RESPONSE_MAX_BYTES = 1048576
export const NATIVE_SNAPSHOT_ADMISSION_BYTES = NATIVE_RESPONSE_MAX_BYTES - 4096
export const NATIVE_SNAPSHOT_MAX_BYTES = NATIVE_RESPONSE_MAX_BYTES - 2048
export const NATIVE_MAX_OUTSTANDING_READS = 8

export class BrokerError extends Error {
  constructor(code, status = 409) {
    super(code)
    this.code = code
    this.status = status
  }
}
export const fail = (code, status) => { throw new BrokerError(code, status) }
export const clone = value => structuredClone(value)
export const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex')
export function object(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_shape', 400)
  if (Object.keys(value).some(key => !keys.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) fail('invalid_fields', 400)
  return value
}
export function str(value, max = 8192, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.length) || value.includes('\0')) fail('invalid_string', 400)
  return value
}
export function id(value) {
  str(value, 160)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) fail('invalid_id', 400)
  return value
}
export function int(value, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) fail('invalid_integer', 400)
  return value
}
export function bool(value) {
  if (typeof value !== 'boolean') fail('invalid_boolean', 400)
  return value
}
export function one(value, choices) {
  if (!choices.includes(value)) fail('invalid_value', 400)
  return value
}
export function array(value, max, visit) {
  if (!Array.isArray(value) || value.length > max) fail('invalid_array', 400)
  value.forEach(visit)
  return value
}
export function unique(values) {
  if (new Set(values).size !== values.length) fail('duplicate_identity', 400)
}
export function time(value) {
  str(value, 40)
  if (!Number.isFinite(Date.parse(value))) fail('invalid_time', 400)
}
export function digest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('invalid_hash', 400)
}
export const SETTINGS = [
  'modelId', 'reasoningEffort', 'workerModel', 'workerReasoningEffort',
  'validationWorkerModel', 'validationWorkerReasoningEffort',
  'enabledToolIds', 'disabledToolIds', 'restrictToolIds', 'skipScrutiny', 'skipUserTesting',
]
export function settings(value) {
  object(value, SETTINGS, [])
  for (const [key, val] of Object.entries(value)) {
    if (key.endsWith('ToolIds')) { array(val, 128, id); unique(val) }
    else if (key.startsWith('skip')) { bool(val); if (val) fail('validation_skipping_refused') }
    else str(val, 256)
  }
}
export function workspace(value) {
  object(value, ['machineId', 'cwd', 'repository', 'baseRef', 'baseSha'], ['machineId', 'cwd', 'repository', 'baseRef'])
  id(value.machineId); str(value.cwd, 2048); str(value.repository, 512); str(value.baseRef, 256)
  if (!isAbsolute(value.cwd)) fail('absolute_workspace_required', 400)
  if (value.baseSha !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.baseSha)) fail('invalid_base_sha', 400)
}
export function intent(value) {
  object(value, [
    'protocolVersion', 'missionId', 'ownerId', 'commandId', 'goal', 'scopeRevision',
    'operation', 'destination', 'workspace', 'references', 'acceptanceCriteria',
    'restrictions', 'policy', 'scopeApproved', 'highAutonomyApproved', 'settings',
  ], [
    'protocolVersion', 'missionId', 'ownerId', 'commandId', 'goal', 'scopeRevision',
    'operation', 'workspace', 'references', 'acceptanceCriteria', 'restrictions',
    'policy', 'scopeApproved', 'highAutonomyApproved', 'settings',
  ])
  one(value.protocolVersion, [1]); id(value.missionId); id(value.ownerId); id(value.commandId)
  str(value.goal, 32768); int(value.scopeRevision, 1)
  one(value.operation, ['implement', 'integrate', 'clone', 'fork', 'inspect'])
  workspace(value.workspace)
  for (const key of ['references', 'acceptanceCriteria', 'restrictions']) array(value[key], 128, item => str(item, 8192))
  const policyFields = ['autonomy', 'allowCreateRepository', 'allowPush', 'allowPr', 'allowMerge', 'allowDeploy']
  object(value.policy, [...policyFields, 'budget'], policyFields)
  one(value.policy.autonomy, ['high'])
  for (const key of policyFields.filter(key => key !== 'autonomy')) bool(value.policy[key])
  if (value.policy.budget !== undefined) {
    object(value.policy.budget, ['unit', 'capUnits']); id(value.policy.budget.unit)
    if (typeof value.policy.budget.capUnits !== 'string' || !/^[1-9][0-9]{0,35}$/.test(value.policy.budget.capUnits)) fail('invalid_budget', 400)
  }
  bool(value.scopeApproved); bool(value.highAutonomyApproved); settings(value.settings)
  if (value.destination !== undefined) {
    const d = value.destination
    object(d, ['kind', 'account', 'name', 'visibility', 'initialization', 'sourceUrl'], ['kind', 'account', 'name', 'visibility', 'initialization'])
    one(d.kind, ['existing', 'new_repository']); str(d.account, 256); str(d.name, 256)
    one(d.visibility, ['private', 'public']); one(d.initialization, ['empty', 'scaffold', 'clone', 'fork'])
    if (d.sourceUrl !== undefined) safeUrl(d.sourceUrl)
  }
  return value
}
export function admissionDraft(value) {
  // Consent fields are forbidden on this read-only surface.
  if (value && (Object.hasOwn(value, 'scopeApproved') || Object.hasOwn(value, 'highAutonomyApproved'))) fail('admission_consent_fields_refused', 400)
  intent({ ...value, scopeApproved: false, highAutonomyApproved: false })
  return value
}
export function admissionPreview(value, draft) {
  object(value, ['protocolVersion', 'missionId', 'ownerId', 'draftHash', 'workspace',
    'prospectiveSettings', 'observedAt', 'expiresAt', 'launchEligible', 'holds'])
  one(value.protocolVersion, [1]); id(value.missionId); id(value.ownerId); digest(value.draftHash)
  workspace(value.workspace); if (!value.workspace.baseSha) fail('immutable_base_required')
  settings(value.prospectiveSettings); time(value.observedAt); time(value.expiresAt)
  bool(value.launchEligible); array(value.holds, 32, row => str(row, 256)); unique(value.holds)
  if (value.missionId !== draft.missionId || value.ownerId !== draft.ownerId || value.draftHash !== hash(draft) ||
      ['machineId', 'cwd', 'repository', 'baseRef'].some(k => value.workspace[k] !== draft.workspace[k]) ||
      (draft.workspace.baseSha && value.workspace.baseSha !== draft.workspace.baseSha) ||
      hash(value.prospectiveSettings) !== hash(draft.settings)) fail('admission_binding_mismatch')
  if (Date.parse(value.expiresAt) <= Date.parse(value.observedAt)) fail('admission_expiry_invalid')
  return value
}
export function command(value) {
  object(value, ['protocolVersion', 'commandId', 'missionId', 'ownerId', 'kind', 'expectedScopeRevision', 'expectedBrokerSeq', 'text', 'answer'],
    ['protocolVersion', 'commandId', 'missionId', 'ownerId', 'kind', 'expectedScopeRevision', 'expectedBrokerSeq'])
  one(value.protocolVersion, [1]); id(value.commandId); id(value.missionId); id(value.ownerId)
  one(value.kind, ['prepare', 'owner_turn', 'answer', 'pause', 'resume', 'cancel'])
  int(value.expectedScopeRevision, 1); int(value.expectedBrokerSeq)
  if (value.kind === 'owner_turn') { str(value.text, 32768); if (value.answer !== undefined) fail('invalid_fields', 400) }
  else if (value.text !== undefined) fail('invalid_fields', 400)
  if (value.kind === 'answer') answer(value.answer)
  else if (value.answer !== undefined) fail('invalid_fields', 400)
  return value
}
export function answer(value) {
  object(value, ['attentionId', 'requestId', 'sessionId', 'machineId', 'revision', 'payloadHash', 'selectedOption', 'answers', 'cancelled'],
    ['attentionId', 'requestId', 'sessionId', 'machineId', 'revision', 'payloadHash'])
  for (const key of ['attentionId', 'requestId', 'sessionId', 'machineId']) id(value[key])
  int(value.revision, 1); digest(value.payloadHash)
  if (value.selectedOption !== undefined) str(value.selectedOption, 256)
  if (value.cancelled !== undefined) bool(value.cancelled)
  if (value.answers !== undefined) {
    array(value.answers, 64, row => { object(row, ['index', 'answer']); int(row.index); str(row.answer, 8192, true) })
    unique(value.answers.map(row => row.index))
  }
}
export function option(value) {
  object(value, ['id', 'label', 'value']); id(value.id); str(value.label, 8192); str(value.value, 256)
}
export function question(value) {
  object(value, ['index', 'topic', 'question', 'multiSelect', 'options'])
  int(value.index); str(value.topic, 8192, true); str(value.question); bool(value.multiSelect)
  array(value.options, 128, option); unique(value.options.map(row => row.id))
}
export function attention(value) {
  object(value, ['attentionId', 'requestId', 'sessionId', 'machineId', 'toolUseIds', 'associatedSessionIds', 'revision', 'payloadHash',
    'kind', 'title', 'details', 'options', 'questions', 'state', 'openedAt', 'resolvedAt'])
  for (const key of ['attentionId', 'requestId', 'sessionId', 'machineId']) id(value[key])
  array(value.toolUseIds, 128, id); unique(value.toolUseIds)
  array(value.associatedSessionIds, 128, id); unique(value.associatedSessionIds)
  int(value.revision, 1); digest(value.payloadHash)
  one(value.kind, ['ask_user', 'permission', 'proposal', 'start', 'unsupported'])
  str(value.title, 8192); str(value.details, 65536, true)
  array(value.options, 128, option); unique(value.options.map(row => row.id)); unique(value.options.map(row => row.value))
  array(value.questions, 64, question); unique(value.questions.map(row => row.index))
  one(value.state, ['open', 'answer_unknown', 'resolved']); time(value.openedAt)
  if (value.resolvedAt !== null) time(value.resolvedAt)
}
export function validateBinding(value) {
  object(value, ['sessionId', 'machineId', 'cwd', 'repository', 'baseRef', 'baseSha'])
  id(value.sessionId)
  const { sessionId: _, baseSha, ...w } = value
  workspace({ ...w, ...(baseSha === null ? {} : { baseSha }) })
}
export function feature(value) {
  object(value, ['id', 'description', 'status', 'expectedBehavior', 'milestone'], ['id', 'description', 'status', 'expectedBehavior'])
  // 'unmet' is a Mission v2 check outcome and must never be presented as done.
  id(value.id); str(value.description); one(value.status, ['pending', 'in_progress', 'completed', 'cancelled', 'unmet'])
  array(value.expectedBehavior, 128, item => str(item))
  if (value.milestone !== undefined) str(value.milestone)
}
export function safeUrl(value) {
  str(value, 2048)
  let url
  try { url = new URL(value) } catch { fail('invalid_url', 400) }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('unsafe_url', 400)
}
export const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i,
  /(?:sk|fk)-[A-Za-z0-9_-]{20,}/i,
  /gh[pousr]_[A-Za-z0-9]{20,}/i,
  /github_pat_[A-Za-z0-9_]{20,}/i,
  /AKIA[A-Z0-9]{16}/i,
  /Bearer\s+[A-Za-z0-9._~-]{12,}/i,
])
export function secretFree(value, secrets = []) {
  function inspect(row) {
    if (!row || typeof row !== 'object') return
    for (const [key, val] of Object.entries(row)) {
      if (/^(?:password|passwd|secret|clientSecret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token|authorization|cookies?|private[_-]?key|credentials?)$/i.test(key)) fail('secret_material_refused', 400)
      inspect(val)
    }
  }
  inspect(value)
  const text = JSON.stringify(value)
  if (secrets.some(secret => secret && text.includes(secret)) ||
      SECRET_PATTERNS.some(pattern => pattern.test(text))) fail('secret_material_refused', 400)
}
export function boundedJson(value, max = 262144) {
  let nodes = 0
  const ancestors = new Set()
  function inspect(row, depth) {
    if (++nodes > 100000 || depth > 32) fail('json_complexity_exceeded', 413)
    if (row === null || typeof row === 'string' || typeof row === 'boolean') return
    if (typeof row === 'number' && Number.isFinite(row)) return
    if (!row || typeof row !== 'object' ||
        (!Array.isArray(row) && Object.getPrototypeOf(row) !== Object.prototype) || ancestors.has(row)) fail('invalid_json', 400)
    if (Array.isArray(row) && (Object.keys(row).length !== row.length ||
        Object.keys(row).some((key, i) => key !== String(i)))) fail('invalid_json', 400)
    ancestors.add(row)
    for (const key of Object.keys(row)) inspect(row[key], depth + 1)
    ancestors.delete(row)
  }
  inspect(value, 0)
  let text
  try { text = JSON.stringify(value) } catch { fail('invalid_json', 400) }
  if (Buffer.byteLength(text) > max) fail('payload_too_large', 413)
  return text
}
export const DELIVERY_STEPS = Object.freeze(['held', 'pushed', 'pr_open', 'checks_pending', 'checks_failed', 'merged', 'not_merged'])
export const DELIVERY_TERMINAL_STEPS = Object.freeze(['checks_failed', 'merged', 'not_merged'])
export function deliveryEffect(row) {
  object(row, ['effectId', 'identity', 'state', 'updatedAt', 'receipt'], ['effectId', 'identity', 'state', 'updatedAt'])
  digest(row.effectId); time(row.updatedAt); one(row.state, ['intent', 'confirmed'])
  object(row.identity, ['ownerId', 'machineId', 'missionId', 'scopeHash', 'policyHash', 'kind', 'repository',
    'baseRef', 'baseSha', 'headSha', 'branch', 'policy', 'prNumber', 'prUrl', 'repositoryId', 'visibility'],
  ['ownerId', 'machineId', 'missionId', 'scopeHash', 'policyHash', 'kind', 'repository', 'baseRef', 'baseSha', 'headSha'])
  for (const key of ['ownerId', 'machineId', 'missionId']) id(row.identity[key])
  for (const key of ['scopeHash', 'policyHash']) digest(row.identity[key])
  one(row.identity.kind, ['create_repository', 'initial_seed_push', 'branch_push', 'pr_create', 'pr_merge'])
  if (row.identity.kind !== 'create_repository') {
    if (typeof row.identity.repositoryId !== 'string' || !/^[A-Za-z0-9_+/=-]{1,256}$/.test(row.identity.repositoryId))
      fail('invalid_delivery_effect', 400)
    one(row.identity.visibility, ['PRIVATE', 'PUBLIC'])
  }
  str(row.identity.repository, 160); str(row.identity.baseRef, 256)
  for (const key of ['baseSha', 'headSha']) {
    if (!/^[a-f0-9]{40}$/.test(row.identity[key])) fail('invalid_delivery_effect', 400)
  }
  if (row.identity.branch !== undefined) str(row.identity.branch, 256)
  if (row.identity.policy !== undefined) {
    object(row.identity.policy, ['allowPush', 'allowPr', 'allowMerge'])
    Object.values(row.identity.policy).forEach(bool)
  }
  if (row.identity.prNumber !== undefined) int(row.identity.prNumber, 1)
  if (row.identity.prUrl !== undefined) safeUrl(row.identity.prUrl)
  if (hash(row.identity) !== row.effectId) fail('invalid_delivery_effect', 400)
  if (row.state === 'intent' && row.receipt !== undefined) fail('invalid_delivery_effect', 400)
  if (row.state === 'confirmed') {
    const required = row.identity.kind === 'create_repository' ? ['created', 'repositoryId'] :
      ['pr_create', 'pr_merge'].includes(row.identity.kind) ? ['headSha', 'prNumber', 'prUrl'] : ['headSha']
    object(row.receipt, ['created', 'repositoryId', 'headSha', 'prNumber', 'prUrl'], required)
    if (row.receipt.repositoryId !== undefined && (typeof row.receipt.repositoryId !== 'string' ||
        !/^[A-Za-z0-9_+/=-]{1,256}$/.test(row.receipt.repositoryId))) fail('invalid_delivery_effect', 400)
    if (row.receipt.created !== undefined) bool(row.receipt.created)
    if (row.identity.kind === 'create_repository' && row.receipt.created !== true) fail('invalid_delivery_effect', 400)
    if (row.receipt.headSha !== undefined && row.receipt.headSha !== row.identity.headSha) fail('invalid_delivery_effect', 400)
    if (row.receipt.prNumber !== undefined) int(row.receipt.prNumber, 1)
    if (row.receipt.prUrl !== undefined &&
        row.receipt.prUrl !== `https://github.com/${row.identity.repository}/pull/${row.receipt.prNumber}`) fail('invalid_delivery_effect', 400)
    if (row.identity.kind === 'pr_merge' && (row.receipt.prNumber !== row.identity.prNumber ||
        row.receipt.prUrl !== row.identity.prUrl)) fail('invalid_delivery_effect', 400)
  }
  return row
}
export function deliveryIsTerminal(state) {
  return DELIVERY_TERMINAL_STEPS.includes(state.step) ||
    (state.step === 'held' && !/^Delivery interrupted during [^;\r\n]+; resume to retry$/.test(state.reason ?? '')) ||
    (state.step === 'pr_open' && state.reason === 'Merge not allowed by policy') ||
    (state.step === 'pushed' && state.reason === 'Pull request not allowed by policy')
}
/** Phone projection of broker-side delivery (push, PR, checks, merge). */
export function deliveryState(value) {
  object(value, ['step', 'branch', 'headSha', 'prUrl', 'prNumber', 'checks', 'reason', 'updatedAt'],
    ['step', 'branch', 'headSha', 'updatedAt'])
  one(value.step, DELIVERY_STEPS); str(value.branch, 256, true); time(value.updatedAt)
  if (typeof value.headSha !== 'string' || !/^(?:|[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.headSha)) fail('invalid_delivery_state', 400)
  if (value.prUrl !== undefined) safeUrl(value.prUrl)
  if (value.prNumber !== undefined) int(value.prNumber, 1)
  if (value.checks !== undefined) {
    object(value.checks, ['total', 'passed', 'failed', 'pending'])
    for (const key of Object.keys(value.checks)) int(value.checks[key])
  }
  if (value.reason !== undefined) str(value.reason, 512, true)
  return value
}
const DELIVERY_PROJECTION_KEYS = ['step', 'branch', 'headSha', 'prUrl', 'prNumber', 'checks', 'reason', 'updatedAt']
/** Phone-facing subset of the persisted delivery state (which also carries resume inputs). */
export function deliveryProjection(state) {
  boundedJson(state, 65536)
  if (!state || typeof state !== 'object') fail('invalid_delivery_state', 400)
  const result = Object.fromEntries(DELIVERY_PROJECTION_KEYS.filter(key => state[key] !== undefined).map(key => [key, clone(state[key])]))
  return deliveryState(result)
}
export function usageState(value) {
  object(value, ['state', 'credits', 'checkedAt', 'completedAt'], ['state'])
  one(value.state, ['pending', 'available', 'unavailable'])
  if (value.credits !== undefined && (typeof value.credits !== 'number' || !Number.isFinite(value.credits) || value.credits < 0)) fail('invalid_usage_state', 400)
  if (value.state !== 'available' && value.credits !== undefined) fail('invalid_usage_state', 400)
  if (value.checkedAt !== undefined) time(value.checkedAt)
  if (value.completedAt !== undefined) time(value.completedAt)
  return value
}
export function readableSnapshot(value, max = NATIVE_SNAPSHOT_MAX_BYTES) {
  try { return boundedJson(value, max) }
  catch (error) {
    if (error instanceof BrokerError && ['payload_too_large', 'json_complexity_exceeded'].includes(error.code)) fail('projection_capacity_exceeded', 503)
    throw error
  }
}
