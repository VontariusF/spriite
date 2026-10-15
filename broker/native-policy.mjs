/**
 * Pure prospective policy compilation. This does not observe SDK settings,
 * enforce an OS sandbox, provision a checkout, or capture Factory billing.
 */
import { hash, fail, object, str, id, array, unique, digest, int, boundedJson, intent as validateIntent } from './validation.mjs'
import { scopeOf } from './store.mjs'

export const NATIVE_BUDGET_MAX_DIGITS = 64
export const NATIVE_REASONING_EFFORTS = Object.freeze([
  'none', 'dynamic', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
])
export const NATIVE_HOST_OPERATIONS = Object.freeze([
  'initialize', 'owner_turn', 'permission_response', 'ask_user_response',
])
export const NATIVE_UNSUPPORTED_CONTROLS = Object.freeze({ pause: false, resume: false, cancel: false })
// Owner decision 2026-10-13: Factory exposes no live per-job usage, so there is
// no hard budget. Next-day usage is reported and labelled as not enforced.
export const NATIVE_BOUNDARY_DIMENSIONS = Object.freeze([
  'physical_workspace', 'filesystem_containment', 'credential_isolation',
  'consequence_mediation', 'root_worker_validator_coverage',
  'usage_reporting', 'ongoing_revocation',
])
// Only an explicit budget asks for these; no qualified host attests them, so a
// budgeted job stays held instead of pretending a cap is enforced.
export const NATIVE_BUDGET_DIMENSIONS = Object.freeze(['complete_inference_billing', 'atomic_budget_reservation'])
export const NATIVE_DELIVERY_DIMENSION = 'delivery_mediation'
const SETTING_KEYS = [
  'modelId', 'reasoningEffort', 'workerModel', 'workerReasoningEffort',
  'validationWorkerModel', 'validationWorkerReasoningEffort', 'restrictToolIds',
  'skipScrutiny', 'skipUserTesting',
]
const CONSEQUENCES = ['allowCreateRepository', 'allowPush', 'allowPr', 'allowMerge']
const RESTRICTION_CONFLICTS = {
  allowPush: ['no push', 'do not push'],
  allowPr: ['no pr', 'do not create pull requests'],
  allowMerge: ['no merge', 'do not merge'],
  allowCreateRepository: ['no repository creation', 'do not create repositories'],
}

/** Consequence flags plus their dependency rules; pure, no deployment needed. */
export function nativeConsequences(intent) {
  const p = intent.policy, d = intent.destination
  if (p.allowDeploy) fail('native_deploy_unavailable')
  if (['clone', 'fork'].includes(intent.operation) ||
      (d && d.initialization !== 'empty')) fail('native_provisioning_or_publication_unavailable')
  if ((p.allowMerge && !p.allowPr) || (p.allowPr && !p.allowPush)) fail('native_consequence_dependency_invalid')
  if (d?.kind === 'new_repository') {
    if (!p.allowCreateRepository) fail('native_new_repository_requires_create_permission')
    if (d.visibility !== 'private') fail('native_new_repository_must_be_private')
    // The host creates the repository and pushes its seed before any work: a
    // new repository without push could never start (held at prepare instead).
    if (!p.allowPush) fail('native_new_repository_requires_push')
  } else if (p.allowCreateRepository) fail('native_create_repository_requires_new_destination')
  for (const [key, phrases] of Object.entries(RESTRICTION_CONFLICTS)) {
    if (p[key] && intent.restrictions.some(row => phrases.includes(row.trim().toLowerCase()))) fail('native_restriction_conflicts_policy')
  }
  return freezeNative({
    createRepository: p.allowCreateRepository, push: p.allowPush, pr: p.allowPr, merge: p.allowMerge,
  })
}

/** Dimensions a host must attest for this intent, independent of deployment. */
export function nativeRequiredDimensions(intent) {
  const consequences = nativeConsequences(intent)
  return [
    ...NATIVE_BOUNDARY_DIMENSIONS,
    ...(intent.policy.budget ? NATIVE_BUDGET_DIMENSIONS : []),
    ...(Object.values(consequences).some(Boolean) ? [NATIVE_DELIVERY_DIMENSION] : []),
    intent.operation === 'inspect' ? 'readonly_execution' : 'bounded_checkout_writes',
  ]
}
export const nativeBudgetEnforcement = intent => intent.policy.budget ? 'reserved' : 'none'
const compiledPolicies = new WeakSet()
// Controlled vocabulary only. Other prose remains in the frozen intent but
// cannot be promoted to a mechanically enforced restriction by this compiler.
const REPRESENTABLE_RESTRICTIONS = new Set([
  'no push', 'no pr', 'no merge', 'no deploy', 'no repository creation',
  'do not push', 'do not create pull requests', 'do not merge',
  'do not deploy', 'do not create repositories',
])

// droid 0.227.0 runs Missions as v2: the orchestrator plans and approves through
// these tools, starts workers with Task and records check evaluations with Script.
export const NATIVE_MISSION_V2_ORCHESTRATOR_TOOLS = Object.freeze(['RecommendMission', 'ExitMissionPlanning', 'Task', 'Script'])
// droid >= 0.238 (v2-agents): the tagged orchestrator drives agents with these
// root-session tools. Task and Script stay optional there.
export const NATIVE_MISSION_V2_AGENTS_TOOLS = Object.freeze(['SpawnAgent', 'SendMessage', 'ListAgents', 'InterruptAgent'])
// droid >= 0.238 enters Missions 2.0 only through this session tag; 0.227 sets it itself.
export const NATIVE_MISSION_V2_INITIALIZE_TAGS = Object.freeze([Object.freeze({ name: 'mission-v2' })])

/** A restricted tool list that would strand a v2 Mission orchestrator (either dialect) is refused. */
export function requireMissionV2Tools(restrictToolIds) {
  const covers = tools => tools.every(tool => restrictToolIds.includes(tool))
  if (!Array.isArray(restrictToolIds) ||
      !(covers(NATIVE_MISSION_V2_ORCHESTRATOR_TOOLS) || covers(NATIVE_MISSION_V2_AGENTS_TOOLS))) fail('native_mission_v2_tools_missing')
  return restrictToolIds
}

export function freezeNative(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeNative)
    Object.freeze(value)
  }
  return value
}

export function parseBudgetUnits(value, { allowZero = false, maxDigits = NATIVE_BUDGET_MAX_DIGITS } = {}) {
  if (!Number.isSafeInteger(maxDigits) || maxDigits < 1 || maxDigits > NATIVE_BUDGET_MAX_DIGITS ||
      typeof value !== 'string' || value.length > maxDigits ||
      !/^(0|[1-9][0-9]*)$/.test(value)) fail('native_invalid_budget_units')
  const units = BigInt(value)
  if (!allowZero && units === 0n) fail('native_invalid_budget_units')
  return units
}

export function validateBudgetUnit(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(value)) fail('native_invalid_budget_unit')
  return value
}

export function validateFullGitRef(value) {
  str(value, 256)
  if (!value.startsWith('refs/') || value.length < 6 ||
      /[\x00-\x20\x7f~^:?*[\]\\]/.test(value) || value.includes('..') ||
      value.includes('@{') || value.includes('//') || value.endsWith('.') ||
      value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    fail('native_full_git_ref_required')
  }
  return value
}

export function validateGitSha(value, objectFormat) {
  if (objectFormat !== undefined && !['sha1', 'sha256'].includes(objectFormat)) fail('native_git_object_format_unsupported')
  const size = objectFormat === 'sha1' ? 40 : objectFormat === 'sha256' ? 64 : null
  if (typeof value !== 'string' || !(size ? new RegExp(`^[a-f0-9]{${size}}$`) : /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).test(value)) {
    fail('native_immutable_sha_required')
  }
  return value
}

/** Keep the broker's existing meanings; absence of budget creates no new field. */
export function getNativeHashes(intent) {
  return { scopeHash: hash(scopeOf(intent)), policyHash: hash({ policy: intent.policy, settings: intent.settings }) }
}

export function validateHostBinding(binding, expected) {
  object(binding, ['ownerId', 'missionId', 'machineId', 'scopeHash', 'policyHash', 'epoch'])
  for (const key of ['ownerId', 'missionId', 'machineId']) id(binding[key])
  for (const key of ['scopeHash', 'policyHash']) digest(binding[key])
  int(binding.epoch, 1)
  if (!expected || Object.keys(binding).some(key => binding[key] !== expected[key])) fail('native_stale_host_binding')
  return binding
}

export function requireNativeBoundary(boundary) {
  if (!boundary || ['verifyWorkspace', 'acquireLease', 'authorizeSend', 'assertAndConsumePermit', 'revoke']
    .some(key => typeof boundary[key] !== 'function')) fail('native_host_boundary_unavailable', 503)
  return boundary
}

export function isCompiledNativePolicy(value) {
  return !!value && compiledPolicies.has(value)
}

export function compileNativePolicy(intent, deployment) {
  // Validate the shared legacy fields without depending on a concurrent schema
  // migration accepting budget. Never alter the original/hash projection.
  boundedJson(intent, 1048576)
  const shape = structuredClone(intent)
  const budget = shape.policy?.budget
  if (shape.policy) delete shape.policy.budget
  validateIntent(shape)
  if (!intent.scopeApproved || !intent.highAutonomyApproved) fail('native_consent_required')
  object(deployment, [
    'ownerId', 'machineId', 'deploymentDigest', 'allowedModelIds', 'allowedToolIds',
    'budgetUnit', 'maxBudgetUnits', 'boundary',
  ], ['ownerId', 'machineId', 'deploymentDigest', 'allowedModelIds', 'allowedToolIds', 'boundary'])
  id(deployment.ownerId); id(deployment.machineId); digest(deployment.deploymentDigest)
  if (intent.ownerId !== deployment.ownerId || intent.workspace.machineId !== deployment.machineId) fail('native_wrong_deployment')
  requireNativeBoundary(deployment.boundary)
  for (const key of ['allowedModelIds', 'allowedToolIds']) {
    array(deployment[key], 128, value => str(value, 256)); unique(deployment[key])
    if (!deployment[key].length) fail('native_empty_deployment_allowlist')
  }
  if (budget) {
    object(budget, ['unit', 'capUnits'])
    if (deployment.budgetUnit === undefined || deployment.maxBudgetUnits === undefined) fail('native_budget_exceeds_deployment')
    validateBudgetUnit(deployment.budgetUnit); validateBudgetUnit(budget.unit)
    if (budget.unit !== deployment.budgetUnit ||
        parseBudgetUnits(budget.capUnits) > parseBudgetUnits(deployment.maxBudgetUnits)) fail('native_budget_exceeds_deployment')
  }
  const consequences = nativeConsequences(intent)
  if (CONSEQUENCES.some(key => typeof intent.policy[key] !== 'boolean')) fail('native_consequence_dependency_invalid')
  validateGitSha(intent.workspace.baseSha)
  validateFullGitRef(intent.workspace.baseRef)
  for (const restriction of intent.restrictions) {
    if (!REPRESENTABLE_RESTRICTIONS.has(restriction.trim().toLowerCase())) fail('native_unrepresented_restriction')
  }
  const s = intent.settings
  object(s, SETTING_KEYS)
  for (const key of ['modelId', 'workerModel', 'validationWorkerModel']) {
    if (!deployment.allowedModelIds.includes(s[key])) fail('native_model_not_permitted')
  }
  for (const key of ['reasoningEffort', 'workerReasoningEffort', 'validationWorkerReasoningEffort']) {
    if (!NATIVE_REASONING_EFFORTS.includes(s[key])) fail('native_reasoning_effort_unsupported')
  }
  if (s.skipScrutiny !== false || s.skipUserTesting !== false) fail('native_validation_must_be_enabled')
  if (!s.restrictToolIds.length || s.restrictToolIds.some(tool => !deployment.allowedToolIds.includes(tool))) fail('native_tool_not_permitted')
  const settings = structuredClone(s)
  const initialize = {
    interactionMode: 'mission', autonomyLevel: 'high',
    modelId: s.modelId, reasoningEffort: s.reasoningEffort,
    missionSettings: {
      workerModel: s.workerModel, workerReasoningEffort: s.workerReasoningEffort,
      validationWorkerModel: s.validationWorkerModel,
      validationWorkerReasoningEffort: s.validationWorkerReasoningEffort,
      skipScrutiny: false, skipUserTesting: false,
    },
    restrictToolIds: [...s.restrictToolIds], autoRejectPermissionRequests: false,
    tags: NATIVE_MISSION_V2_INITIALIZE_TAGS.map(tag => ({ ...tag })),
  }
  const hashes = getNativeHashes(intent)
  const requiredBoundaryDimensions = nativeRequiredDimensions(intent)
  const budgetEnforcement = nativeBudgetEnforcement(intent)
  const result = freezeNative({
    ...hashes, settings, initialize, requiredBoundaryDimensions, consequences, budgetEnforcement,
    compiledPolicyHash: hash({
      version: 2, ...hashes, deploymentDigest: deployment.deploymentDigest,
      initialize, budget: budget ?? null, budgetEnforcement, consequences, requiredBoundaryDimensions,
    }),
  })
  compiledPolicies.add(result)
  return result
}
