import {
  fail, BrokerError, clone, hash, object, id, int, str, one, array, digest,
  intent as validateIntent, command as validateCommand, attention as validateAttention,
  validateBinding, feature, settings, secretFree, boundedJson, safeUrl, time,
  readableSnapshot, NATIVE_RESPONSE_MAX_BYTES, NATIVE_MAX_OUTSTANDING_READS,
  admissionDraft, admissionPreview, deliveryProjection, deliveryEffect, usageState, deliveryIsTerminal,
} from './validation.mjs'
import { FileStore, scopeOf, workspaceMatches, attentionIdentity, RETIRED_ATTENTION_MAX } from './store.mjs'
import { loadQualification, capabilitiesFor, loadHostQualification, isHostQualificationFor } from './qualification.mjs'
import { nativeConsequences } from './native-policy.mjs'
import { validateNativeDeliveryInput } from './native-delivery-input.mjs'
import {
  decodeSdkEnvelope, SDK_TRANSPORT_VERSION, correlateNativeResolution, requestPayload, MISSION_V2_NOTIFICATION_TYPES,
} from './sdk-wire.mjs'
import {
  deriveMissionV2AgentsState, deriveMissionV2State, missionV2AgentsInputs, missionV2Inputs, missionV2WorkerSessionIds,
} from './mission-v2-state.mjs'
import { validateProviderRecord } from './sdk-provider.mjs'
import * as nodeFs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createXCredentialStore } from './x-credential.mjs'
import { createXClient, XClientError } from './x-client.mjs'

const REQUIRED_SETTINGS = ['modelId', 'workerModel', 'validationWorkerModel']
const FINALIZATION_MS = 60000
const ATTENTION_FRESH_MS = 30000
const UNKNOWN_HOLD = 'unknown_command_requires_reconciliation'
const ATTENTION_MAX = 256 // Mirrors the store validator cap on snapshot.attention.
// History is a sliding projection the provider can re-serve, kept well below
// the store's 512-row cap so union-merging new provider rows never bricks ingest.
const HISTORY_RETAIN = 384
const providerKeyOf = a => `${a.machineId}/${a.sessionId}/${a.requestId}`
const retiredRequest = key => hash(['retired_attention_request', key])
const retiredIdentity = attentionId => hash(['retired_attention_id', attentionId])
/**
 * At capacity, retire the oldest resolved request nothing still depends on:
 * not in the current pending read, not the approved proposal grant, and not
 * answered by a command whose outcome is still unsettled. Its identity digests
 * stay behind so a retired request reappearing is still refused.
 */
function retireResolvedAttention(job, pendingKeys) {
  const grant = job.approvedProposal
  const index = job.snapshot.attention.findIndex(a => a.state === 'resolved' && !pendingKeys.has(providerKeyOf(a)) &&
    !(grant && a.kind === 'proposal' && a.requestId === grant.requestId && a.payloadHash === grant.payloadHash) &&
    !Object.values(job.records).some(row => row.request.answer?.attentionId === a.attentionId &&
      !['confirmed', 'rejected'].includes(row.receipt.state)))
  if (index < 0) return null
  const [a] = job.snapshot.attention.splice(index, 1)
  delete job.attentionMeta[a.attentionId]
  job.retiredAttention = [...(job.retiredAttention ?? []),
    retiredRequest(providerKeyOf(a)), retiredIdentity(a.attentionId)].slice(-RETIRED_ATTENTION_MAX)
  return a
}
const STATE_VALUES = ['planning', 'awaiting_input', 'initializing', 'running', 'paused', 'orchestrator_turn', 'completed']
const SECTIONS = ['mission', 'features', 'progress', 'workers', 'pending', 'settings', 'history', 'finalization']
const AUTHORITY_SECTIONS = ['mission', 'features', 'progress', 'workers', 'pending', 'settings']
const LAUNCH_RECEIPT_KEYS = ['status', 'commandId', 'receiptId', 'binding', 'effectiveSettings']
const UNCONFIRMABLE_SETTINGS = ['workerModel', 'workerReasoningEffort', 'validationWorkerModel',
  'validationWorkerReasoningEffort', 'skipScrutiny', 'skipUserTesting']
function unconfirmedSettings(value) {
  if (value === undefined) return
  array(value, UNCONFIRMABLE_SETTINGS.length, key => one(key, UNCONFIRMABLE_SETTINGS))
  if (!value.length || new Set(value).size !== value.length) fail('malformed_transport_receipt')
}

/** No provider is loaded or invoked by default. */
export const unavailableTransport = Object.freeze({
  version: 'unavailable',
  support: Object.freeze({}),
})

function record(request, epoch, at) {
  return {
    request: clone(request), requestHash: hash(request), leaseEpoch: epoch,
    receipt: { commandId: request.commandId, state: 'prepared', reason: null },
    preparedAt: at, invokedAt: null, outcomeAt: null, providerReceipt: null,
  }
}
function syncReceipts(job) {
  job.snapshot.commands = Object.values(job.records).map(row => clone(row.receipt))
}
function hasUnknown(job) {
  return Object.values(job.records).some(row => ['invoked', 'unknown'].includes(row.receipt.state))
}
function missionDialect(job) {
  const p = job.providerRecord
  return p?.transportVersion === SDK_TRANSPORT_VERSION ? p.value?.dialect ?? null : null
}
/** Mission v2 in either droid dialect: 0.227 plan approval ('v2') or 0.238 agents ('v2-agents'). */
const isMissionV2 = job => ['v2', 'v2-agents'].includes(missionDialect(job))
function isStopped(job) {
  return job.hostRecovery === true || job.hostShutdown === 'revoked' || job.hostShutdown === 'failed' ||
    job.snapshot.state === 'completed' || job.snapshot.state === 'paused' ||
    job.snapshot.control !== 'running'
}
function exactAnswer(job, input, now, epoch, capabilities) {
  const a = job.snapshot.attention.find(a => a.attentionId === input.attentionId)
  if (!a || a.state !== 'open') fail('attention_not_open')
  const meta = job.attentionMeta[a.attentionId]
  for (const key of ['requestId', 'sessionId', 'machineId', 'revision', 'payloadHash']) {
    if (a[key] !== input[key]) fail('stale_attention')
  }
  if (!job.snapshot.binding || a.machineId !== job.snapshot.binding.machineId) fail('wrong_machine')
  const root = a.sessionId === job.snapshot.binding.sessionId
  if (!capabilities.rootAttention || (!root && !capabilities.childAttention)) fail('attention_unavailable')
  if (a.kind === 'unsupported') fail('unsupported_attention_handoff')
  if (job.reconciledEpoch !== epoch || job.snapshot.completeness !== 'complete' ||
      !job.lastPendingAt || now - Date.parse(job.lastPendingAt) > ATTENTION_FRESH_MS ||
      meta.source !== 'authoritative' || !job.pendingRequestIds.includes(a.attentionId)) fail('pending_request_reconciliation_required')
  if (meta.scopeRevision !== job.intent.scopeRevision || meta.scopeHash !== job.scopeHash || meta.policyHash !== job.policyHash) fail('stale_scope_or_policy')
  if (!job.intent.scopeApproved || !job.intent.highAutonomyApproved) fail('consent_required')
  if (a.kind === 'ask_user') {
    if (input.selectedOption !== undefined) fail('invalid_questionnaire_answer', 400)
    if (input.cancelled === true) {
      if (input.answers?.length) fail('invalid_questionnaire_answer', 400)
    } else {
      if (!input.answers || input.answers.length !== a.questions.length || !a.questions.length) fail('complete_questionnaire_required', 400)
      for (const q of a.questions) {
        const answer = input.answers.find(row => row.index === q.index)
        if (!answer) fail('complete_questionnaire_required', 400)
        // Canonical answer encoding/custom rules must come from the exact raw provider request.
        // SDK questions use free canonical strings. No HUD option parsing or index-only replay.
        const rule = meta.raw.questions?.find(row => row.index === q.index)
        if (!rule || typeof rule.allowCustom !== 'boolean') fail('questionnaire_rules_unavailable')
        if (!rule.allowCustom) {
          if (q.multiSelect) {
            let selected
            try { selected = JSON.parse(answer.answer) } catch { fail('invalid_multiselect_answer', 400) }
            if (!Array.isArray(selected) || selected.length === 0 || new Set(selected).size !== selected.length ||
                selected.some(value => !q.options.some(option => option.value === value))) fail('invalid_multiselect_answer', 400)
          } else if (!q.options.some(option => option.value === answer.answer)) fail('option_not_offered', 400)
        }
      }
    }
  } else {
    if (input.answers !== undefined || input.cancelled !== undefined || input.selectedOption === undefined ||
        !a.options.some(option => option.value === input.selectedOption)) fail('option_not_offered', 400)
    // The shared protocol has no separately informed permanent permission-policy grant.
    if (/always|permanent/i.test(input.selectedOption) ||
        a.options.some(option => option.value === input.selectedOption && /always|permanent/i.test(option.label))) fail('permanent_permission_grant_unavailable')
    // There is no editedSpecContent field in NativeAnswer.
    if (input.selectedOption === 'proceed_edit') fail('proposal_edit_protocol_unavailable')
    if (!['proceed_once', 'cancel'].includes(input.selectedOption)) fail('permission_policy_escalation_unavailable')
    // v2 approval of the exact plan starts the run; a start request cannot exist there.
    if (a.kind === 'start' && isMissionV2(job)) fail('mission_v2_start_unavailable')
    if (a.kind === 'start' && input.selectedOption === 'proceed_once') {
      const proposal = job.approvedProposal
      if (!proposal || meta.proposalHash !== proposal.payloadHash ||
          proposal.scopeHash !== job.scopeHash || proposal.policyHash !== job.policyHash) fail('approved_proposal_binding_required')
    }
  }
  return a
}
function normalizeObservation(value, binding, intent, secrets) {
  boundedJson(value); secretFree(value, secrets)
  object(value, ['binding', 'state', 'features', 'progressLog', 'workerSessionIds', 'pending', 'pendingComplete',
    'pendingSource', 'sessionIds', 'completeness', 'effectiveSettings', 'scopeRevision', 'scopeHash',
    'policyHash', 'providerAt', 'summary', 'summaryTruncated', 'evidence', 'workersSettled', 'commandResolutions', 'history', 'presentSections'],
  ['binding', 'state', 'features', 'progressLog', 'workerSessionIds', 'pending', 'pendingComplete',
    'pendingSource', 'sessionIds', 'completeness', 'effectiveSettings', 'scopeRevision', 'scopeHash', 'policyHash'])
  validateBinding(value.binding)
  if (hash(value.binding) !== hash(binding) || !workspaceMatches(intent.workspace, value.binding)) fail('observation_wrong_binding')
  one(value.state, STATE_VALUES); array(value.features, 512, feature)
  if (new Set(value.features.map(row => row.id)).size !== value.features.length) fail('duplicate_feature', 400)
  array(value.progressLog, 512, row => boundedJson(row, 16384))
  array(value.workerSessionIds, 256, id); array(value.sessionIds, 256, id)
  if (!value.sessionIds.includes(binding.sessionId) ||
      new Set(value.sessionIds).size !== value.sessionIds.length ||
      value.workerSessionIds.some(s => !value.sessionIds.includes(s))) fail('session_routing_incomplete')
  if (typeof value.pendingComplete !== 'boolean') fail('invalid_boolean', 400)
  one(value.pendingSource, ['authoritative', 'notification'])
  one(value.completeness, ['complete', 'gap', 'unknown'])
  if (value.presentSections !== undefined) {
    array(value.presentSections, SECTIONS.length, s => one(s, SECTIONS))
    if (new Set(value.presentSections).size !== value.presentSections.length) fail('duplicate_section', 400)
    if (!value.presentSections.includes('pending') && (value.pendingComplete || value.pending.length)) fail('absent_pending_section', 400)
    if (!value.presentSections.includes('history') && value.history?.length) fail('absent_history_section', 400)
    if (!value.presentSections.includes('finalization') &&
        (value.summary || value.evidence?.length || value.workersSettled)) fail('absent_finalization_section', 400)
  }
  settings(value.effectiveSettings); int(value.scopeRevision, 1); digest(value.scopeHash); digest(value.policyHash)
  if (value.providerAt !== undefined && value.providerAt !== null) time(value.providerAt)
  array(value.pending, 256, row => {
    object(row, ['attention', 'raw', 'proposalHash'], ['attention', 'raw'])
    validateAttention(row.attention); boundedJson(row.raw, 131072)
    if (hash(row.raw) !== row.attention.payloadHash || row.attention.state !== 'open' || row.attention.resolvedAt !== null ||
        row.attention.machineId !== binding.machineId || !value.sessionIds.includes(row.attention.sessionId) ||
        row.attention.associatedSessionIds.some(s => !value.sessionIds.includes(s))) fail('invalid_pending_binding')
    if (row.proposalHash !== undefined && row.proposalHash !== null) digest(row.proposalHash)
  })
  if (value.summary !== undefined && value.summary !== null) str(value.summary, 32768)
  if (value.summaryTruncated !== undefined && typeof value.summaryTruncated !== 'boolean') fail('invalid_boolean', 400)
  if (value.workersSettled !== undefined && typeof value.workersSettled !== 'boolean') fail('invalid_boolean', 400)
  if (value.evidence !== undefined) array(value.evidence, 128, row => {
    object(row, ['id', 'url', 'commitSha']); id(row.id); safeUrl(row.url)
    if (row.commitSha !== null && !/^[a-f0-9]{40,64}$/.test(row.commitSha)) fail('invalid_commit', 400)
  })
  if (value.commandResolutions !== undefined) array(value.commandResolutions, 128, row => {
    object(row, ['commandId', 'requestHash', 'status', 'receiptId'])
    id(row.commandId); digest(row.requestHash); one(row.status, ['confirmed', 'rejected']); str(row.receiptId, 512)
  })
  if (value.history !== undefined) array(value.history, 128, row => {
    object(row, ['id', 'who', 'text', 'at']); id(row.id); one(row.who, ['owner', 'factory']); str(row.text, 32768); time(row.at)
  })
  return value
}

/**
 * A completed job keeps its daemon until the read-only closing collection has
 * settled (or hit its deadline): revoking first would make the final read
 * impossible and always end finalization incomplete.
 */
const completionSettled = job => job.snapshot.state === 'completed' &&
  !!job.snapshot.finalization && job.snapshot.finalization.state !== 'pending'

export class NativeBroker {
  static async open({
    directory, ownerId, machineId, bearerToken, transport = unavailableTransport,
    qualificationPath, qualificationPublicKey, timeoutMs = 5000, now = Date.now,
    host = null, delivery = null, usage = null, deploymentDigest = null,
    hostQualification = null, hostQualificationPath, hostQualificationPublicKey, trustedHost = false,
  }) {
    id(ownerId); id(machineId); str(transport.version, 256)
    if (bearerToken !== undefined) str(bearerToken, 4096)
    int(timeoutMs, 1); if (timeoutMs > 30000) fail('invalid_timeout', 400)
    const qualification = await loadQualification({
      path: qualificationPath, publicKey: qualificationPublicKey, ownerId, machineId,
      transportVersion: transport.version, now: now(),
    })
    if (host && (!host.publicKey || typeof host.provision !== 'function')) fail('native_host_invalid', 503)
    if (!hostQualification && hostQualificationPath && host) {
      hostQualification = await loadHostQualification({
        path: hostQualificationPath, publicKey: hostQualificationPublicKey ?? host.publicKey,
        deploymentDigest, hostPublicKey: host.publicKey, machineId, now: now(),
      })
    }
    const store = FileStore.open({ directory, ownerId, secrets: [bearerToken].filter(Boolean) })
    const broker = new NativeBroker({
      store, ownerId, machineId, transport, qualification, timeoutMs, now,
      host, delivery, usage, deploymentDigest, hostQualification, trustedHost: trustedHost === true && !!host,
    })
    try { if (host) {
      const recovered = await host.recoverAfterRestart?.() ?? []
      for (const missionId of recovered) {
        if (!store.data.jobs[missionId]) continue
        store.transaction(data => {
          const job = data.jobs[missionId]
          job.hostRecovery = true
          job.snapshot.holdReason = 'Broker restarted; mission must be re-prepared'
          if (!job.snapshot.binding) job.snapshot.state = 'held'
          store.event(data, job, 'host_restart_recovery_required')
        })
      }
    } } catch (error) { store.close(); throw error }
    return broker
  }
  constructor(options) {
    Object.assign(this, options)
    this.active = new Map()
    this.reads = new Map()
    this.admissionReads = new Map()
    this.providerJournals = new Map()
    this.deliveries = new Map()
    this.usageChecks = new Map()
    this.hostRevocations = new Map()
  }
  /** Host holds lift only for a verified live canary record bound to this deployment and host key. */
  hostQualified() {
    if (this.trustedHost && this.host) return true
    return !!this.host && isHostQualificationFor(this.hostQualification, {
      deploymentDigest: this.deploymentDigest, hostPublicKey: this.host.publicKey, now: this.now(),
    })
  }
  /**
   * The qualification a launch was made under: the signed manifest's hash, or
   * for an owner-trusted host a digest of its trusted-host id (which changes
   * with the deployment), so a later redeploy is still noticed.
   */
  launchQualificationHash() {
    if (this.qualification?.manifestHash) return this.qualification.manifestHash
    const caps = this.getCapabilities()
    return this.trustedHost && caps.qualificationId ? hash(caps.qualificationId) : null
  }
  getCapabilities() {
    const result = capabilitiesFor(this.qualification, this.transport, this.now())
    if (!this.trustedHost || !this.host) return result
    // Owner-trusted host: no signed manifest, the accepted risks stand in for one.
    // Only what the adapter actually supports is reported.
    const support = this.transport?.support ?? {}
    return { ...result, qualified: true,
      qualificationId: `owner-trusted-host:${String(this.deploymentDigest ?? 'unknown').slice(0, 16)}`,
      launch: support.launch === true, rootAttention: support.rootAttention === true,
      childAttention: support.childAttention === true, recoverAttention: support.recoverAttention === true }
  }
  async capabilities() { return this.getCapabilities() }
  /** Read-only inspection does not persist a job, acquire execution authority or invoke a goal. */
  async inspectAdmission(input) {
    this.checkInput(input); admissionDraft(input); this.authorize(input.ownerId)
    input = clone(input)
    if (input.workspace.machineId !== this.machineId) fail('selected_machine_unavailable')
    if (this.store.data.jobs[input.missionId]) fail('admission_identity_already_prepared')
    if (!this.transport.inspectAdmission) fail('native_admission_unavailable', 503)
    const epoch = this.store.data.epoch
    this.store.assertWriter(epoch)
    const requestHash = hash(input)
    let reservation = this.admissionReads.get(input.missionId)
    if (reservation && reservation.requestHash !== requestHash) fail('admission_inflight_conflict')
    if (!reservation) {
      if (this.reads.size + this.admissionReads.size >= NATIVE_MAX_OUTSTANDING_READS) fail('observation_capacity_exceeded', 503)
      reservation = { requestHash, rawSettled: false, resultSettled: false, result: null }
      this.admissionReads.set(input.missionId, reservation)
      const release = () => {
        if (reservation.rawSettled && reservation.resultSettled &&
            this.admissionReads.get(input.missionId) === reservation) this.admissionReads.delete(input.missionId)
      }
      const raw = Promise.resolve().then(() => {
        this.store.assertWriter(epoch)
        return this.transport.inspectAdmission(clone(input), {
      ownerId: this.ownerId, missionId: input.missionId, machineId: this.machineId, epoch, readOnly: true,
        })
      })
      raw.then(() => { reservation.rawSettled = true; release() }, () => { reservation.rawSettled = true; release() })
      reservation.result = this.bounded(() => raw)
      reservation.result.then(() => { reservation.resultSettled = true; release() }, () => { reservation.resultSettled = true; release() })
    }
    const response = await reservation.result
    this.store.assertWriter(epoch)
    this.checkInput(response); admissionPreview(response, input)
    if (this.store.data.jobs[input.missionId]) fail('admission_identity_already_prepared')
    if (Date.parse(response.observedAt) > this.now() + 5000 || Date.parse(response.expiresAt) <= this.now() ||
        Date.parse(response.expiresAt) - Date.parse(response.observedAt) > 60000) fail('admission_evidence_expired')
    const candidate = { ...input, workspace: response.workspace, scopeApproved: true, highAutonomyApproved: true }
    const hold = this.admissionHold(candidate, this.getCapabilities())
    const holds = [...new Set([...response.holds, ...(hold ? [hold] : [])])]
    return { ...clone(response), launchEligible: response.launchEligible && holds.length === 0, holds }
  }
  authorize(ownerId) { if (ownerId !== this.ownerId) fail('owner_forbidden', 403) }
  job(missionId, ownerId) {
    this.authorize(ownerId); id(missionId)
    const job = this.store.data.jobs[missionId]
    if (!job) fail('job_not_found', 404)
    return job
  }
  project(missionId, ownerId) {
    const job = this.job(missionId, ownerId)
    const result = clone(job.snapshot)
    result.capabilities = this.getCapabilities()
    if (job.delivery) result.delivery = deliveryProjection(job.delivery)
    if (job.usage) result.usage = { state: job.usage.state, ...(job.usage.credits === undefined ? {} : { credits: job.usage.credits }) }
    readableSnapshot(result, NATIVE_RESPONSE_MAX_BYTES)
    return result
  }
  checkInput(value) { boundedJson(value, 131072); secretFree(value, this.store.secrets) }
  async bounded(operation) {
    let timer
    // An invoked timeout MUST NOT cancel/retry the execution transport.
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new BrokerError('transport_timeout', 503)), this.timeoutMs) }),
      ])
    } finally { clearTimeout(timer) }
  }
  hold(job, reason) {
    job.snapshot.holdReason = reason
    if (!job.snapshot.binding) job.snapshot.state = 'held'
  }
  admissionHold(intent, capabilities) {
    if (!intent.scopeApproved || !intent.highAutonomyApproved) return 'exact_scope_and_high_consent_required'
    if (intent.workspace.machineId !== this.machineId) return 'selected_machine_unavailable'
    if (!intent.workspace.baseSha) return 'immutable_base_required'
    if (!intent.destination) return 'explicit_destination_required'
    const hostNewRepository = intent.destination.kind === 'new_repository' && this.hostQualified() &&
      intent.destination.visibility === 'private' && intent.destination.initialization === 'empty' &&
      intent.policy.allowCreateRepository === true
    if ((intent.destination.kind === 'new_repository' && !hostNewRepository) || intent.operation === 'clone' ||
        intent.operation === 'fork' || ['clone', 'fork', 'scaffold'].includes(intent.destination.initialization)) return 'workspace_preparation_capability_unavailable'
    if (this.host) {
      try { nativeConsequences(intent) } catch (error) { return error instanceof BrokerError ? error.code : 'native_policy_invalid' }
      if (intent.workspace.cwd !== this.host.workDirFor(intent.missionId)) return 'native_workspace_not_host_provisioned'
      if (Object.values(nativeConsequences(intent)).some(Boolean) && !this.delivery) return 'native_delivery_unavailable'
      if (!this.trustedHost && this.host.qualificationHolds?.length) return this.host.qualificationHolds[0]
    } else if (['allowCreateRepository', 'allowPush', 'allowPr', 'allowMerge', 'allowDeploy'].some(key => intent.policy[key])) {
      return 'native_delivery_unavailable'
    }
    if (REQUIRED_SETTINGS.some(key => typeof intent.settings[key] !== 'string')) return 'effective_model_settings_required'
    if (!capabilities.qualified || !capabilities.launch || !capabilities.rootAttention ||
        !capabilities.childAttention || !capabilities.recoverAttention) return 'native_launch_unqualified'
    return null
  }
  /** @param {import('../src/native/protocol.js').NativeIntent} input */
  async prepare(input) {
    this.checkInput(input); validateIntent(input); this.authorize(input.ownerId)
    const prior = this.store.data.jobs[input.missionId]
    if (prior) {
      if (prior.intentHash !== hash(input)) fail('intent_conflict')
      return this.project(input.missionId, input.ownerId)
    }
    if (Object.values(this.store.data.jobs).some(job => Object.hasOwn(job.records, input.commandId))) fail('command_identity_conflict')
    if (Object.keys(this.store.data.jobs).length >= 128) fail('job_capacity_exceeded', 503)
    const at = new Date(this.now()).toISOString()
    const capabilities = this.getCapabilities()
    const hold = this.admissionHold(input, capabilities)
    this.store.transaction(data => {
      const job = {
        intent: clone(input), intentHash: hash(input), scopeHash: hash(scopeOf(input)),
        policyHash: hash({ policy: input.policy, settings: input.settings }), records: {},
        attentionMeta: {}, effectiveSettings: null, approvedProposal: null, progressLog: [],
        workerSessionIds: [], reconciledEpoch: 0, lastPendingAt: null, pendingRequestIds: [],
        finalizationDeadline: null, finalizationAttempts: 0, launchQualification: null,
        snapshot: {
          protocolVersion: 1, backend: 'factory_native', missionId: input.missionId, ownerId: input.ownerId,
          scopeRevision: input.scopeRevision, brokerSeq: data.seq, state: 'held', control: 'running', binding: null,
          capabilities, attention: [], features: [], history: [{ id: input.commandId, who: 'owner', text: input.goal, at }],
          commands: [], lastObservedAt: null, completeness: 'unknown', holdReason: hold, finalization: null,
        },
      }
      job.records[input.commandId] = record(input, data.epoch, at)
      if (hold) job.records[input.commandId].receipt = { commandId: input.commandId, state: 'rejected', reason: hold }
      syncReceipts(job); data.jobs[input.missionId] = job
      this.store.event(data, job, 'intent_prepared', { commandId: input.commandId, scopeHash: job.scopeHash, holdReason: hold })
    })
    if (hold) return this.project(input.missionId, input.ownerId)
    this.active.set(input.missionId, input.commandId)
    try {
      const job = this.job(input.missionId, input.ownerId)
      if (this.host) {
        // Provision, start the dedicated sandboxed daemon and probe it before any
        // workspace proof or lease can be requested. Any failure holds the job.
        try {
          await this.host.provision(clone(input))
          if (input.destination.kind === 'new_repository') {
            const context = this.deliveryContext(input.missionId)
            const frozenGuard = () => {
              context.journal.guard()
              const current = this.job(input.missionId, input.ownerId)
              if (hash(current.intent) !== hash(input) || !current.intent.scopeApproved || !current.intent.highAutonomyApproved)
                fail('native_delivery_effect_scope_mismatch', 409)
              if (current.snapshot.holdReason || current.records[input.commandId]?.receipt.state !== 'prepared')
                fail('native_private_repository_initialization_held', 409)
              const hold = this.admissionHold(current.intent, this.getCapabilities())
              if (hold) fail(hold, 409)
            }
            const initializationContext = Object.freeze({ journal: Object.freeze({ ...context.journal, guard: frozenGuard }) })
            frozenGuard()
            if (typeof this.host.privateRepositoryInitializationInput !== 'function' ||
                typeof this.delivery?.createPrivateRepository !== 'function' || typeof this.delivery?.pushInitialSeed !== 'function')
              fail('native_private_repository_initialization_unavailable', 503)
            const target = await this.host.privateRepositoryInitializationInput(input.missionId)
            this.checkInput(target)
            const repository = `${input.destination.account}/${input.destination.name}`
            if (target.missionId !== input.missionId || target.account !== input.destination.account ||
                target.name !== input.destination.name || target.repository !== repository ||
                target.workDir !== input.workspace.cwd || target.baseRef !== input.workspace.baseRef ||
                target.baseSha !== input.workspace.baseSha || target.seedSha !== input.workspace.baseSha ||
                target.visibility !== 'private' || target.initialization !== 'empty' ||
                target.requiresCreatedRepository !== true || target.adoptionAllowed !== false ||
                !input.policy.allowCreateRepository || !input.policy.allowPush)
              fail('native_private_repository_initialization_mismatch', 409)
            frozenGuard()
            const exact = row => row.identity.repository === repository && row.identity.baseSha === input.workspace.baseSha &&
              row.identity.headSha === input.workspace.baseSha && row.identity.baseRef === input.workspace.baseRef.replace(/^refs\/heads\//, '') &&
              row.identity.missionId === context.journal.identity.missionId && row.identity.ownerId === context.journal.identity.ownerId &&
              row.identity.machineId === context.journal.identity.machineId && row.identity.scopeHash === context.journal.identity.scopeHash &&
              row.identity.policyHash === context.journal.identity.policyHash && row.state === 'confirmed'
            const creationConfirmed = () => Object.values(this.job(input.missionId, input.ownerId).deliveryEffects ?? {}).some(row =>
              exact(row) && row.identity.kind === 'create_repository' && row.receipt?.created === true && row.receipt.repositoryId)
            const created = await this.delivery.createPrivateRepository({ account: target.account, name: target.name }, initializationContext)
            frozenGuard()
            if (created?.created !== true || created.repositoryUrl !== `https://github.com/${repository}`)
              fail('native_private_repository_adoption_refused', 409)
            if (!creationConfirmed()) fail('native_delivery_provisioning_journal_missing', 503)
            await this.delivery.pushInitialSeed({
              missionId: input.missionId, workDir: target.workDir, repository,
              baseRef: target.baseRef, baseSha: target.baseSha,
            }, initializationContext)
            frozenGuard()
            const effects = Object.values(this.job(input.missionId, input.ownerId).deliveryEffects ?? {})
            if (!creationConfirmed() ||
                !effects.some(row => exact(row) && row.identity.kind === 'initial_seed_push' &&
                  row.identity.branch === input.workspace.baseRef.replace(/^refs\/heads\//, '') && row.receipt?.headSha === input.workspace.baseSha))
              fail('native_delivery_provisioning_journal_missing', 503)
          }
          await this.host.startDaemon({ missionId: input.missionId })
          await this.host.runContainmentProbes({ missionId: input.missionId })
        } catch (error) {
          await this.revokeHost(input.missionId, 'prepare_failed')
          this.rejectPrepared(input.missionId, input.commandId, error instanceof BrokerError ? error.code : 'native_host_unavailable')
          return this.project(input.missionId, input.ownerId)
        }
      }
      let preflight
      try { preflight = await this.bounded(() => this.transport.preflight(clone(input), this.context(job))) }
      catch (error) {
        // The code only (never the message): enough to diagnose without leaking.
        process.stderr.write(`[broker] preflight for ${input.missionId} failed: ${error?.code ?? error?.name ?? 'unknown'}\n`)
        fail('preflight_unavailable', 503)
      }
      this.checkInput(preflight)
      object(preflight, ['workspace', 'effectiveSettings', 'scopeHash', 'policyHash', 'availableAutonomyLevels', 'readiness', 'policyEnforced', 'budgetEnforced', 'destinationVerified', 'settingsEvidence', 'usageReporting'],
        ['workspace', 'effectiveSettings', 'scopeHash', 'policyHash', 'availableAutonomyLevels', 'readiness', 'policyEnforced', 'budgetEnforced', 'destinationVerified'])
      if (preflight.settingsEvidence !== undefined) one(preflight.settingsEvidence, ['prospective', 'effective'])
      const expected = { ...input.workspace, baseSha: input.workspace.baseSha ?? null }
      validateBinding({ ...preflight.workspace, sessionId: 'preflight' })
      settings(preflight.effectiveSettings)
      if (hash(preflight.workspace) !== hash(expected)) fail('workspace_verification_failed')
      array(preflight.availableAutonomyLevels, 8, value => str(value, 64))
      if ((preflight.settingsEvidence !== 'prospective' && !preflight.availableAutonomyLevels.includes('high')) || preflight.readiness !== true ||
          preflight.policyEnforced !== true ||
          // Without a budget the honest answer is "not enforced, reported next day".
          (input.policy.budget ? preflight.budgetEnforced !== true
            : preflight.budgetEnforced !== false || preflight.usageReporting !== 'next_day_unenforced') ||
          preflight.destinationVerified !== true || preflight.scopeHash !== job.scopeHash ||
          preflight.policyHash !== job.policyHash || hash(preflight.effectiveSettings) !== hash(input.settings)) fail('effective_policy_settings_unproven')
      const current = this.job(input.missionId, input.ownerId)
      if (isStopped(current) || current.records[input.commandId].receipt.state !== 'prepared' ||
          this.admissionHold(current.intent, this.getCapabilities())) fail('launch_barrier_changed')
      this.store.transaction(data => {
        const job = data.jobs[input.missionId]
        job.effectiveSettings = preflight.settingsEvidence === 'prospective' ? null : clone(preflight.effectiveSettings)
        job.launchQualification = this.launchQualificationHash()
      })
      await this.invoke(input.missionId, input.commandId, 'launch', clone(input))
    } catch (error) {
      if (!this.store.closed) this.rejectPrepared(input.missionId, input.commandId, error instanceof BrokerError ? error.code : 'preflight_invalid')
    } finally {
      this.active.delete(input.missionId)
      const current = this.store.data.jobs[input.missionId]
      // droid never echoes worker/validation settings (sdk_mission_settings_unconfirmed).
      // A qualified host revokes such a launch; an owner-trusted host accepted
      // that risk, so a confirmed launch keeps running on the requested settings.
      if (this.host && current && (current.records[input.commandId].receipt.state !== 'confirmed' ||
          (current.effectiveSettings === null && !this.trustedHost))) await this.revokeHost(input.missionId, 'prepare_unqualified_or_failed')
    }
    return this.project(input.missionId, input.ownerId)
  }
  context(job, commandId = null) {
    const epoch = this.store.data.epoch
    return Object.freeze({
      ownerId: this.ownerId, missionId: job.intent.missionId, machineId: this.machineId,
      binding: clone(job.snapshot.binding), epoch,
      scopeHash: job.scopeHash, policyHash: job.policyHash,
      ...(commandId ? { commandId } : {}),
      providerJournal: this.providerJournal(job, epoch),
      // Adapter must run this immediately before *each* execution-affecting send.
      guard: () => {
        this.store.assertWriter(epoch)
        const current = this.job(job.intent.missionId, this.ownerId)
        if (isStopped(current)) fail('execution_stopped')
        if (!this.getCapabilities().qualified) fail('qualification_expired')
        if (commandId) {
          const row = current.records[commandId]
          if (!row || !['prepared', 'invoked'].includes(row.receipt.state)) fail('command_no_longer_invokable')
          if (row.request.answer) exactAnswer(current, row.request.answer, this.now(), epoch, this.getCapabilities())
        }
      },
    })
  }
  providerJournal(job, epoch) {
    const missionId = job.intent.missionId
    const key = `${epoch}/${missionId}`
    if (this.providerJournals.has(key)) return this.providerJournals.get(key)
    const current = () => {
      this.store.assertWriter(epoch)
      const value = this.job(missionId, this.ownerId)
      if (value.scopeHash !== job.scopeHash || value.policyHash !== job.policyHash) fail('provider_journal_binding_changed')
      return value
    }
    const journal = Object.freeze({
      read: () => {
        const row = current().providerRecord
        if (!row) return null
        if (row.transportVersion !== this.transport.version) fail('provider_journal_transport_changed')
        return clone(row.value)
      },
      write: async value => {
        current(); this.checkInputProviderRecord(value)
        this.transport.validateProviderRecord?.(value, {
          ownerId: this.ownerId, missionId, machineId: this.machineId, epoch,
          scopeHash: job.scopeHash, policyHash: job.policyHash,
        })
        // The ledger keeps only hash/epoch integrity; strict SDK-shape authority
        // is enforced here on every write (the store quarantines legacy records
        // at open instead of rejecting them).
        if (this.transport.version === SDK_TRANSPORT_VERSION) {
          validateProviderRecord(value, {
            ownerId: this.ownerId, missionId, machineId: this.machineId, epoch,
            scopeHash: job.scopeHash, policyHash: job.policyHash,
            ...(value?.binding && job.snapshot.binding ? { binding: job.snapshot.binding } : {}),
          })
        }
        this.store.transaction(data => {
          const target = data.jobs[missionId]
          target.providerRecord = { transportVersion: this.transport.version, scopeHash: target.scopeHash,
            policyHash: target.policyHash, epoch, recordHash: hash(value), value: clone(value) }
        })
        if (value?.ingestionFault && this.host) await this.revokeHost(missionId, value.ingestionFault)
      },
      initialized: async binding => {
        const target = current()
        this.checkInput(binding); validateBinding(binding)
        if (!workspaceMatches(target.intent.workspace, binding) ||
            (target.snapshot.binding && hash(target.snapshot.binding) !== hash(binding))) fail('initialized_binding_changed')
        this.store.transaction(data => {
          const target = data.jobs[missionId]
          target.snapshot.binding = clone(binding)
          // Resource retention alone establishes neither goal acceptance nor launch authority.
          this.store.event(data, target, 'initialized_resource_retained', { binding })
        })
      },
    })
    this.providerJournals.set(key, journal)
    return journal
  }
  checkInputProviderRecord(value) { boundedJson(value, 524288); secretFree(value, this.store.secrets) }
  rejectPrepared(missionId, commandId, reason) {
    this.store.transaction(data => {
      const job = data.jobs[missionId], row = job.records[commandId]
      if (row.receipt.state !== 'prepared') return
      row.receipt.state = 'rejected'; row.receipt.reason = reason; row.outcomeAt = new Date(this.now()).toISOString()
      this.hold(job, reason); syncReceipts(job)
      this.store.event(data, job, 'command_rejected', { commandId, reason })
    })
  }
  /** @param {import('../src/native/protocol.js').NativeCommand} input */
  async command(input) {
    this.checkInput(input); validateCommand(input)
    const job = this.job(input.missionId, input.ownerId)
    const prior = job.records[input.commandId]
    if (prior) {
      if (prior.requestHash !== hash(input)) fail('command_identity_conflict')
      return clone(prior.receipt)
    }
    if (Object.values(this.store.data.jobs).some(other => Object.hasOwn(other.records, input.commandId))) fail('command_identity_conflict')
    if (input.expectedScopeRevision !== job.intent.scopeRevision) fail('stale_scope')
    if (input.expectedBrokerSeq !== job.snapshot.brokerSeq) fail('stale_broker_revision')
    if (Object.keys(job.records).length >= 512) fail('command_capacity_exceeded', 503)
    let rejection = null
    const caps = this.getCapabilities()
    if (['pause', 'cancel'].includes(input.kind)) {
      if (job.snapshot.control === 'cancelled' || job.snapshot.state === 'completed') rejection = 'terminal_execution'
      else if (!caps[input.kind]) rejection = `${input.kind}_unavailable_factory_handoff`
      else rejection = 'provider_control_semantics_unimplemented'
    } else if (input.kind === 'resume') rejection = 'resume_unavailable_factory_handoff'
    else if (input.kind === 'prepare') rejection = 'prepare_requires_native_intent'
    else {
      if (!job.snapshot.binding) fail('binding_unavailable')
      if (isStopped(job)) fail('execution_stopped')
      if (hasUnknown(job) || this.active.has(input.missionId)) fail('unknown_or_active_command')
      if (!caps.qualified || job.launchQualification !== this.launchQualificationHash()) fail('qualification_changed_or_unavailable')
      if (job.reconciledEpoch !== this.store.data.epoch || job.snapshot.completeness !== 'complete' ||
          !job.snapshot.lastObservedAt || this.now() - Date.parse(job.snapshot.lastObservedAt) > ATTENTION_FRESH_MS) fail('fresh_observation_required')
      if (input.kind === 'answer') exactAnswer(job, input.answer, this.now(), this.store.data.epoch, caps)
      if (input.kind === 'owner_turn') {
        // NativeIntent lacks revisioned follow-up criteria/context. Never let a free
        // message change frozen scope or stand in for an approval.
        rejection = 'owner_turn_scope_binding_unavailable'
      }
    }
    this.store.transaction(data => {
      const job = data.jobs[input.missionId]
      const row = record(input, data.epoch, new Date(this.now()).toISOString())
      job.records[input.commandId] = row
      if (['pause', 'cancel'].includes(input.kind) && job.snapshot.state !== 'completed' && job.snapshot.control !== 'cancelled') {
        if (input.kind === 'cancel') job.snapshot.control = 'cancel_requested'
        else if (job.snapshot.control !== 'cancel_requested') job.snapshot.control = 'pause_requested'
        this.hold(job, rejection ?? 'control_requested_not_confirmed')
        this.store.event(data, job, 'control_requested', { kind: input.kind, commandId: input.commandId })
      }
      if (rejection) {
        row.receipt.state = 'rejected'; row.receipt.reason = rejection; row.outcomeAt = new Date(this.now()).toISOString()
      }
      syncReceipts(job)
      this.store.event(data, job, rejection ? 'command_rejected' : 'command_prepared', { commandId: input.commandId, reason: rejection })
    })
    if (!rejection) {
      this.active.set(input.missionId, input.commandId)
      try { await this.invoke(input.missionId, input.commandId, 'answer', clone(input.answer)) }
      finally { this.active.delete(input.missionId) }
    }
    return clone(this.job(input.missionId, input.ownerId).records[input.commandId].receipt)
  }
  async invoke(missionId, commandId, method, payload) {
    const job = this.job(missionId, this.ownerId), epoch = this.store.data.epoch
    const ctx = this.context(job, commandId)
    ctx.guard()
    this.store.transaction(data => {
      const job = data.jobs[missionId], row = job.records[commandId]
      if (row.receipt.state !== 'prepared') fail('command_not_prepared')
      row.receipt.state = 'invoked'; row.invokedAt = new Date(this.now()).toISOString()
      syncReceipts(job)
      this.store.event(data, job, 'command_invoked', { commandId, leaseEpoch: epoch })
    })
    let response, reason = null, timedOut = false
    try {
      ctx.guard(); this.store.assertWriter(epoch)
      const operation = Promise.resolve().then(() => {
        ctx.guard(); this.store.assertWriter(epoch)
        return this.transport[method](payload, { ...ctx, commandId })
      })
      operation.then(late => {
        if (!timedOut || method !== 'launch' || this.store.closed) return
        try {
          this.checkInput(late)
          object(late, [...LAUNCH_RECEIPT_KEYS, 'unconfirmedSettings'], LAUNCH_RECEIPT_KEYS)
          one(late.status, ['confirmed']); str(late.receiptId, 512); validateBinding(late.binding); settings(late.effectiveSettings)
          unconfirmedSettings(late.unconfirmedSettings)
          if (late.commandId !== commandId || !workspaceMatches(job.intent.workspace, late.binding) ||
              hash(late.effectiveSettings) !== hash(job.intent.settings)) return
          this.store.assertWriter(epoch)
          this.store.transaction(data => {
            const job = data.jobs[missionId], row = job.records[commandId]
            if (row.receipt.state !== 'unknown') return
            job.snapshot.binding = clone(late.binding)
            row.providerReceipt = late.receiptId
            // Resource discovery is not execution reconciliation or stop confirmation.
            this.store.event(data, job, 'late_binding_observed', { commandId, binding: late.binding })
          })
        } catch { /* Fenced/corrupt late results cannot grant authority. */ }
      }, () => {})
      response = await this.bounded(() => operation)
      this.checkInput(response)
      if (method === 'launch') {
        object(response, [...LAUNCH_RECEIPT_KEYS, 'unconfirmedSettings'], LAUNCH_RECEIPT_KEYS)
        one(response.status, ['confirmed']); id(response.commandId); str(response.receiptId, 512)
        validateBinding(response.binding); settings(response.effectiveSettings); unconfirmedSettings(response.unconfirmedSettings)
        if (response.commandId !== commandId || !workspaceMatches(job.intent.workspace, response.binding) ||
            hash(response.effectiveSettings) !== hash(job.intent.settings)) fail('malformed_transport_receipt')
      } else {
        object(response, ['status', 'commandId'], ['status', 'commandId'])
        one(response.status, ['sent']); id(response.commandId)
        if (response.commandId !== commandId) fail('malformed_transport_receipt')
        reason = 'transport_sent_pending_native_resolution'
      }
    } catch (error) {
      timedOut = error instanceof BrokerError && error.code === 'transport_timeout'
      reason = timedOut ? 'invoked_timeout' : 'invoked_outcome_unknown'
    }
    this.store.assertWriter(epoch)
    this.store.transaction(data => {
      const job = data.jobs[missionId], row = job.records[commandId]
      // A resolution may have arrived while the transport was pending.
      if (!['invoked', 'unknown'].includes(row.receipt.state)) return
      if (!reason && method === 'launch') {
        // Track late resources even when pause/cancel raced initialization.
        job.snapshot.binding = clone(response.binding)
        // Requested values the daemon never reported back are not effective-settings evidence.
        job.effectiveSettings = response.unconfirmedSettings ? null : clone(response.effectiveSettings)
        if (response.unconfirmedSettings) {
          this.store.event(data, job, 'settings_unconfirmed', { commandId, keys: clone(response.unconfirmedSettings) })
        }
        row.providerReceipt = response.receiptId
        row.receipt.state = 'confirmed'; row.receipt.reason = null
        if (!isStopped(job)) this.hold(job, 'authoritative_observation_required')
      } else {
        row.receipt.state = 'unknown'; row.receipt.reason = reason
        this.hold(job, UNKNOWN_HOLD)
        if (row.request.answer) {
          const a = job.snapshot.attention.find(a => a.attentionId === row.request.answer.attentionId)
          if (a && a.state !== 'resolved') a.state = 'answer_unknown'
        }
      }
      row.outcomeAt = new Date(this.now()).toISOString(); syncReceipts(job)
      this.store.event(data, job, row.receipt.state === 'confirmed' ? 'command_confirmed' : 'command_unknown', {
        commandId, reason: row.receipt.reason, binding: method === 'launch' && !reason ? job.snapshot.binding : null,
      })
    })
    if (reason && this.host) await this.revokeHost(missionId, reason)
  }
  /** Bounded read-only observation; HTTP disconnect never controls provider lifetime. */
  async observe(missionId, ownerId) {
    const job = this.job(missionId, ownerId)
    if (job.hostRecovery) return this.project(missionId, ownerId)
    if (job.snapshot.finalization && job.snapshot.finalization.state !== 'pending') {
      this.afterObservation(missionId)
      return this.project(missionId, ownerId)
    }
    if (job.snapshot.finalization?.state === 'pending' && job.finalizationDeadline &&
        (this.now() >= Date.parse(job.finalizationDeadline) || job.finalizationAttempts >= 8)) {
      this.finishIncomplete(missionId)
      return this.project(missionId, ownerId)
    }
    if (!job.snapshot.binding || !this.transport.support?.readOnlyObservation || !this.transport.observe) return this.project(missionId, ownerId)
    if (this.reads.has(missionId)) { await this.reads.get(missionId).result; return this.project(missionId, ownerId) }
    if (this.reads.size + this.admissionReads.size >= NATIVE_MAX_OUTSTANDING_READS) {
      this.observationGap(missionId, 'observation_capacity_exceeded')
      return this.project(missionId, ownerId)
    }
    const reservation = { rawSettled: false, resultSettled: false, result: null }
    this.reads.set(missionId, reservation)
    const release = () => {
      if (reservation.rawSettled && reservation.resultSettled && this.reads.get(missionId) === reservation) this.reads.delete(missionId)
    }
    // The reservation belongs to the real operation, not Promise.race's caller
    // deadline. Late fulfillments are never ingested; late rejections are consumed.
    const raw = Promise.resolve().then(() => {
      this.store.assertWriter()
      return this.transport.observe(clone(job.snapshot.binding), { ...this.context(job), readOnly: true })
    })
    raw.then(() => { reservation.rawSettled = true; release() }, () => { reservation.rawSettled = true; release() })
    reservation.result = this.readObservation(missionId, raw)
    reservation.result.then(() => { reservation.resultSettled = true; release() }, () => { reservation.resultSettled = true; release() })
    await reservation.result
    this.afterObservation(missionId)
    return this.project(missionId, ownerId)
  }
  /** Delivery and usage run detached; observation never waits on GitHub or analytics. */
  afterObservation(missionId) {
    if (this.store.closed) return
    const job = this.store.data.jobs[missionId]
    if (!job) return
    if (this.host && completionSettled(job)) this.revokeHost(missionId, 'terminal_completion').catch(() => {})
    if (this.deliveryDue(job)) this.runDelivery(missionId).catch(() => {})
    if (this.usage && job.snapshot.state === 'completed' && job.snapshot.binding) this.refreshUsage(missionId).catch(() => {})
  }
  deliveryDue(job) {
    if (!this.host || !this.delivery || this.deliveries.has(job.intent.missionId) ||
        job.hostRecovery || job.hostShutdown === 'failed' || job.deliveryRetryExhausted ||
        (job.deliveryAttempts ?? 0) >= 8 ||
        (job.deliveryAttemptedAt && this.now() - Date.parse(job.deliveryAttemptedAt) < 30000)) return false
    if (job.delivery) return !deliveryIsTerminal(job.delivery)
    if (job.deliveryStartedAt) return true
    // Only after observed completion and settled read-only finalization.
    return job.intent.policy.allowPush === true && job.snapshot.state === 'completed' &&
      !!job.snapshot.finalization && job.snapshot.finalization.state !== 'pending' && !hasUnknown(job)
  }
  /** Broker-only capability: no route exposes journal writes to the agent. */
  deliveryContext(missionId) {
    const job = this.job(missionId, this.ownerId), epoch = this.store.data.epoch
    const identity = Object.freeze({
      ownerId: this.ownerId, machineId: this.machineId, missionId,
      scopeHash: job.scopeHash, policyHash: job.policyHash,
      baseRef: job.intent.workspace.baseRef.replace(/^refs\/heads\//, ''),
      baseSha: job.intent.workspace.baseSha,
    })
    const journal = Object.freeze({
      identity,
      guard: () => {
        this.store.assertWriter(epoch)
        const current = this.job(missionId, this.ownerId)
        if (current.scopeHash !== identity.scopeHash || current.policyHash !== identity.policyHash)
          fail('native_delivery_effect_scope_mismatch', 409)
        if (current.snapshot.control !== 'running' || current.hostRecovery || current.hostShutdown === 'failed')
          fail('execution_stopped', 409)
      },
      read: effectId => { this.store.assertWriter(epoch); return clone(this.job(missionId, this.ownerId).deliveryEffects?.[effectId] ?? null) },
      list: () => { this.store.assertWriter(epoch); return clone(Object.values(this.job(missionId, this.ownerId).deliveryEffects ?? {})) },
      save: (row, checkpoint) => {
        this.store.assertWriter(epoch); this.checkInput(row); deliveryEffect(row)
        for (const key of ['ownerId', 'machineId', 'missionId', 'scopeHash', 'policyHash', 'baseRef', 'baseSha'])
          if (row.identity[key] !== identity[key]) fail('native_delivery_effect_scope_mismatch', 409)
        const current = this.job(missionId, this.ownerId)
        const expectedRepository =
          (current.intent.destination.account && current.intent.destination.name
            ? `${current.intent.destination.account}/${current.intent.destination.name}`
            : current.intent.workspace.repository?.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, ''))
        if (row.identity.repository !== expectedRepository) fail('native_delivery_effect_scope_mismatch', 409)
        if (row.identity.kind !== 'create_repository') {
          const creation = Object.values(current.deliveryEffects ?? {}).find(value =>
            value.identity.kind === 'create_repository' && value.state === 'confirmed' && value.receipt?.created === true)
          const expected = creation ? { repositoryId: creation.receipt.repositoryId, visibility: 'PRIVATE' }
            : current.deliveryInput?.repositoryIdentity
          if (!expected || row.identity.repositoryId !== expected.repositoryId || row.identity.visibility !== expected.visibility ||
              row.identity.visibility !== current.intent.destination.visibility.toUpperCase())
            fail('native_delivery_effect_repository_identity_mismatch', 409)
        }
        const flag = { create_repository: 'allowCreateRepository', initial_seed_push: 'allowPush',
          branch_push: 'allowPush', pr_create: 'allowPr', pr_merge: 'allowMerge' }[row.identity.kind]
        if (current.intent.policy[flag] !== true) fail('native_delivery_effect_policy_refused', 409)
        if (row.identity.policy && hash(row.identity.policy) !== hash({
          allowPush: current.intent.policy.allowPush, allowPr: current.intent.policy.allowPr, allowMerge: current.intent.policy.allowMerge,
        })) fail('native_delivery_effect_scope_mismatch', 409)
        if (checkpoint) {
          this.checkInput(checkpoint); deliveryProjection(checkpoint)
          if (checkpoint.missionId !== missionId || checkpoint.repository !== row.identity.repository ||
              checkpoint.headSha !== row.identity.headSha || checkpoint.workDir !== current.intent.workspace.cwd ||
              checkpoint.branch !== `spriite/${missionId}`) fail('native_delivery_effect_scope_mismatch', 409)
        }
        this.store.transaction(data => {
          const target = data.jobs[missionId]
          target.deliveryEffects ??= {}
          const prior = target.deliveryEffects[row.effectId]
          if (Object.values(target.deliveryEffects).some(value =>
            value.identity.kind === row.identity.kind && value.effectId !== row.effectId))
            fail('native_delivery_effect_identity_changed', 409)
          if (prior && (hash(prior.identity) !== hash(row.identity) ||
              (prior.state === 'confirmed' && (row.state !== 'confirmed' || hash(prior.receipt) !== hash(row.receipt)))))
            fail('native_delivery_effect_identity_changed', 409)
          target.deliveryEffects[row.effectId] = clone(row)
          if (checkpoint) target.delivery = clone(checkpoint)
          this.store.event(data, target, 'delivery_effect', { effectId: row.effectId, kind: row.identity.kind, state: row.state })
        })
      },
    })
    return Object.freeze({ journal })
  }
  runDelivery(missionId) {
    if (this.deliveries.has(missionId)) return this.deliveries.get(missionId)
    const run = (async () => {
      const epoch = this.store.data.epoch
      let job = this.job(missionId, this.ownerId)
      if (job.hostRecovery || job.hostShutdown === 'failed' || job.deliveryRetryExhausted ||
          (job.deliveryAttemptedAt && this.now() - Date.parse(job.deliveryAttemptedAt) < 30000) ||
          (job.deliveryAttempts ?? 0) >= 8 || (job.delivery && deliveryIsTerminal(job.delivery))) return
      if (!job.deliveryStartedAt) {
        this.store.transaction(data => {
          data.jobs[missionId].deliveryStartedAt = new Date(this.now()).toISOString()
          this.store.event(data, data.jobs[missionId], 'delivery_started')
        })
      }
      // The agent must not be able to change the checkout while it is delivered.
      await this.revokeHost(missionId, 'terminal_delivery')
      this.store.assertWriter(epoch)
      job = this.job(missionId, this.ownerId)
      if (job.hostShutdown === 'failed') return
      let state
      let input
      try {
        if (job.deliveryInput) input = validateNativeDeliveryInput(job.deliveryInput)
        if (!input && !job.delivery) {
          const target = this.host.deliveryInput(missionId)
          const creation = Object.values(job.deliveryEffects ?? {}).find(row => row.identity.kind === 'create_repository' &&
            row.state === 'confirmed' && row.receipt?.created === true)
          let repositoryIdentity
          if (!creation) {
            const reviewed = target.reviewedRepositoryIdentity
            if (!reviewed || reviewed.repository !== target.repository || reviewed.baseSha !== job.intent.workspace.baseSha ||
                reviewed.scopeHash !== job.scopeHash || reviewed.policyHash !== job.policyHash ||
                reviewed.visibility !== job.intent.destination.visibility.toUpperCase())
              fail('native_delivery_reviewed_repository_identity_required', 409)
            repositoryIdentity = { repositoryId: reviewed.repositoryId, visibility: reviewed.visibility }
          }
          const goal = job.intent.goal.trim()
          input = validateNativeDeliveryInput({
            missionId, workDir: target.workDir, repository: target.repository,
            baseRef: target.baseRef, baseSha: target.baseSha,
            ...(repositoryIdentity ? { repositoryIdentity } : {}),
            policy: { allowPush: job.intent.policy.allowPush, allowPr: job.intent.policy.allowPr, allowMerge: job.intent.policy.allowMerge },
            title: `Spriite: ${goal.split('\n')[0].slice(0, 72)}`,
            body: [goal, '', ...job.intent.acceptanceCriteria.map(row => `- ${row}`)].join('\n').slice(0, 16384),
          })
          this.checkInput(input)
        }
        const expectedRepository = `${job.intent.destination.account}/${job.intent.destination.name}`
        for (const value of [input, job.delivery].filter(value => value?.missionId)) {
          if (value.missionId !== missionId || value.workDir !== job.intent.workspace.cwd ||
              value.repository !== expectedRepository || value.baseSha !== job.intent.workspace.baseSha ||
              value.baseRef.replace(/^refs\/heads\//, '') !== job.intent.workspace.baseRef.replace(/^refs\/heads\//, '') ||
              hash(value.policy) !== hash({ allowPush: job.intent.policy.allowPush,
                allowPr: job.intent.policy.allowPr, allowMerge: job.intent.policy.allowMerge }))
            fail('native_delivery_input_scope_mismatch', 409)
        }
        this.store.transaction(data => {
          const target = data.jobs[missionId]
          if (input) target.deliveryInput = clone(input)
          target.deliveryAttempts = (target.deliveryAttempts ?? 0) + 1
          target.deliveryAttemptedAt = new Date(this.now()).toISOString()
        })
        if (job.delivery) {
          if (!job.delivery.missionId) fail('native_delivery_resume_input_missing', 409)
          state = await this.delivery.resume(clone(job.delivery), this.deliveryContext(missionId))
        } else {
          state = await this.delivery.deliver(clone(input), this.deliveryContext(missionId))
        }
      } catch (error) {
        job = this.job(missionId, this.ownerId)
        if (job.delivery?.missionId) state = {
          ...clone(job.delivery),
          ...(error instanceof BrokerError && error.status < 500 ? {
            step: 'held', reason: error.code, updatedAt: new Date(this.now()).toISOString(),
          } : {}),
        }
        else state = {
          ...(input ?? {}),
          step: 'held', branch: `spriite/${missionId}`, headSha: '',
          reason: input && (!(error instanceof BrokerError) || error.status >= 500)
            ? 'Delivery interrupted during broker invocation; resume to retry'
            : error instanceof BrokerError ? error.code : 'native_delivery_failed',
          updatedAt: new Date(this.now()).toISOString(),
        }
      }
      if (this.store.closed) return
      this.store.assertWriter(epoch)
      const value = JSON.parse(JSON.stringify(state))
      this.checkInput(value); deliveryProjection(value)
      this.store.transaction(data => {
        const target = data.jobs[missionId]
        target.delivery = value
        if ((target.deliveryAttempts ?? 0) >= 8 && !deliveryIsTerminal(value)) {
          target.deliveryRetryExhausted = true
          target.delivery.reason = 'Delivery retry limit reached; owner recovery required'
        }
        this.store.event(data, target, 'delivery_state', { step: value.step, reason: value.reason ?? null })
      })
    })().finally(() => { this.deliveries.delete(missionId) })
    this.deliveries.set(missionId, run)
    return run
  }
  /** Restart continuation: resume every started, non-terminal delivery. */
  resumeDeliveries() {
    for (const job of Object.values(this.store.data.jobs)) {
      if ((job.delivery || job.deliveryStartedAt) && this.deliveryDue(job)) this.runDelivery(job.intent.missionId).catch(() => {})
    }
  }
  async settleDeliveries() { await Promise.allSettled([...this.deliveries.values(), ...this.usageChecks.values(), ...this.hostRevocations.values()]) }
  async revokeHost(missionId, reason) {
    if (!this.host || this.store.closed) return
    if (this.hostRevocations.has(missionId)) return this.hostRevocations.get(missionId)
    const job = this.job(missionId, this.ownerId)
    if (job.hostShutdown === 'revoked') return
    const run = (async () => {
      let failure = null, metadata
      if (reason !== 'terminal_completion' && reason !== 'terminal_delivery') {
        const creation = Object.values(job.deliveryEffects ?? {}).find(row =>
          row.identity.kind === 'create_repository' && row.state === 'confirmed' && row.receipt?.created === true)
        if (creation) metadata = { created: true, repositoryUrl: `https://github.com/${creation.identity.repository}` }
      }
      try {
        if (this.host.revoke) await this.host.revoke({
          ownerId: this.ownerId, machineId: this.machineId, missionId,
          scopeHash: job.scopeHash, policyHash: job.policyHash, epoch: this.store.data.epoch, reason,
        })
        else await this.host.stopDaemon({ missionId })
      } catch (error) {
        if (error?.code !== 'native_job_not_provisioned') failure = error?.code ?? 'native_host_revocation_failed'
      }
      try {
        const provisioned = this.host.job?.(missionId)
        if (reason !== 'terminal_completion' && reason !== 'terminal_delivery' &&
            provisioned?.created && provisioned.repositoryUrl) metadata = { created: true, repositoryUrl: provisioned.repositoryUrl }
      } catch {}
      if (this.store.closed) return
      this.store.transaction(data => {
        const target = data.jobs[missionId]
        target.hostShutdown = failure ? 'failed' : 'revoked'
        if (failure) target.snapshot.holdReason = failure
        if (failure || metadata) target.hostFailure = { reason: failure ?? reason, ...metadata }
        if (metadata) target.snapshot.history.push({
          id: `host-repository-${missionId}`, who: 'factory',
          text: `Repository retained after failed preparation: ${metadata.repositoryUrl}`, at: new Date(this.now()).toISOString(),
        })
        this.store.event(data, target, failure ? 'host_revocation_failed' : 'host_revoked', { reason: failure ?? reason, ...metadata })
      })
      this.transport.forget?.(missionId)
    })().finally(() => this.hostRevocations.delete(missionId))
    this.hostRevocations.set(missionId, run)
    return run
  }
  refreshUsage(missionId) {
    if (this.usageChecks.has(missionId)) return this.usageChecks.get(missionId)
    const job = this.job(missionId, this.ownerId)
    if (job.usage && job.usage.state !== 'pending') return Promise.resolve()
    if (job.usage?.checkedAt && this.now() - Date.parse(job.usage.checkedAt) < 3600000) return Promise.resolve()
    const epoch = this.store.data.epoch
    const run = (async () => {
      const completedAt = job.usage?.completedAt ?? new Date(this.now()).toISOString()
      const sessionIds = [...new Set([job.snapshot.binding.sessionId, ...job.workerSessionIds])]
      let result
      try { result = await this.usage.query({ sessionIds, completedAt }) } catch { result = { state: 'pending' } }
      if (this.store.closed) return
      this.store.assertWriter(epoch)
      const value = {
        state: ['pending', 'available', 'unavailable'].includes(result?.state) ? result.state : 'pending',
        ...(result?.state === 'available' && Number.isFinite(result.credits) && result.credits >= 0 ? { credits: result.credits } : {}),
        checkedAt: new Date(this.now()).toISOString(), completedAt,
      }
      if (value.state === 'available' && value.credits === undefined) value.state = 'pending'
      usageState(value)
      this.store.transaction(data => { data.jobs[missionId].usage = value })
    })().finally(() => { this.usageChecks.delete(missionId) })
    this.usageChecks.set(missionId, run)
    return run
  }
  async readObservation(missionId, raw) {
    const job = this.job(missionId, this.ownerId), epoch = this.store.data.epoch
    if (job.snapshot.finalization?.state !== undefined && job.snapshot.finalization.state !== 'pending') return
    if (job.finalizationDeadline && (this.now() >= Date.parse(job.finalizationDeadline) || job.finalizationAttempts >= 8)) {
      this.finishIncomplete(missionId); return
    }
    try {
      const observation = await this.bounded(() => raw)
      this.store.assertWriter(epoch)
      this.ingestObservation(missionId, this.ownerId, observation)
    } catch (error) {
      // The code only (never the message): enough to diagnose without leaking.
      process.stderr.write(`[broker] observation for ${missionId} failed: ${error?.code ?? error?.name ?? 'unknown'}\n`)
      if (this.store.closed) return
      this.store.assertWriter(epoch)
      this.store.transaction(data => {
        const job = data.jobs[missionId]
        job.snapshot.completeness = 'gap'; job.reconciledEpoch = 0; job.lastPendingAt = null
        job.pendingRequestIds = []
        if (job.snapshot.finalization?.state === 'pending') job.finalizationAttempts++
        if (!hasUnknown(job) && job.snapshot.holdReason !== 'projection_capacity_exceeded') this.hold(job, 'observation_unavailable')
        this.store.event(data, job, 'observation_gap')
      }, { projectionHeadroom: true })
    }
  }
  observationGap(missionId, reason, evidence = {}) {
    const prior = this.job(missionId, this.ownerId)
    if (prior.snapshot.holdReason === 'projection_capacity_exceeded') reason = prior.snapshot.holdReason
    if (prior.snapshot.completeness === 'gap' && prior.snapshot.holdReason === reason &&
        prior.reconciledEpoch === 0 && prior.lastPendingAt === null && !prior.pendingRequestIds.length) return
    this.store.transaction(data => {
      const job = data.jobs[missionId]
      // Reject the candidate atomically: no clipping, compaction, resolution or
      // partial authority import. Preserve every previously admitted raw request.
      job.snapshot.completeness = 'gap'; job.reconciledEpoch = 0
      job.lastPendingAt = null; job.pendingRequestIds = []
      this.hold(job, reason)
      this.store.event(data, job, 'observation_gap', { reason, ...evidence })
    }, { projectionHeadroom: true })
  }
  /** Trusted adapter boundary, never an HTTP mutation route. */
  ingestObservation(missionId, ownerId, value) {
    const prior = this.job(missionId, ownerId)
    if (!prior.snapshot.binding) fail('binding_unavailable')
    normalizeObservation(value, prior.snapshot.binding, prior.intent, this.store.secrets)
    const observedAt = new Date(this.now()).toISOString()
    try { this.store.transaction(data => {
      const job = data.jobs[missionId], snapshot = job.snapshot
      const present = new Set(value.presentSections ?? SECTIONS)
      const allAuthoritySections = AUTHORITY_SECTIONS.every(s => present.has(s))
      const scopeMatches = value.scopeRevision === job.intent.scopeRevision && value.scopeHash === job.scopeHash && value.policyHash === job.policyHash
      // droid never reports mission settings back. A qualified host holds on
      // that; an owner-trusted host accepted it, so an absent settings section
      // is not a mismatch there (a present, different one still is).
      const settingsMatch = present.has('settings') ? hash(value.effectiveSettings) === hash(job.intent.settings)
        : this.trustedHost === true
      const terminalRegression = present.has('mission') && snapshot.state === 'completed' && value.state !== 'completed'
      const authoritative = allAuthoritySections && !terminalRegression && value.completeness === 'complete' && value.pendingComplete && value.pendingSource === 'authoritative'
      const previousState = snapshot.state
      if (present.has('mission')) {
        if (snapshot.state !== 'completed') snapshot.state = value.state
        else if (value.state !== 'completed') this.hold(job, 'terminal_state_regression')
        // A v2-derived 'paused' (an interrupted turn, not a confirmed Mission
        // pause) must never change control; the v2 derivation no longer emits it.
        if (value.state === 'paused' && snapshot.control === 'running' && !isMissionV2(job)) {
          snapshot.control = 'paused'
        }
      }
      // A running observation cannot erase local requested/confirmed stops.
      if (present.has('features')) snapshot.features = clone(value.features)
      if (present.has('progress')) job.progressLog = clone(value.progressLog) // Replacement, NOT append.
      if (present.has('workers')) job.workerSessionIds = clone(value.workerSessionIds)
      snapshot.lastObservedAt = observedAt
      snapshot.completeness = terminalRegression ? 'gap' : allAuthoritySections ? value.completeness : value.completeness === 'gap' ? 'gap' : 'unknown'
      if (present.has('settings')) job.effectiveSettings = clone(value.effectiveSettings)
      job.sectionMeta ??= {}
      for (const section of present) job.sectionMeta[section] = {
        source: value.pendingSource, observedAt, providerAt: value.providerAt ?? null,
      }
      job.reconciledEpoch = authoritative && scopeMatches && settingsMatch ? data.epoch : 0
      job.lastPendingAt = authoritative ? observedAt : null
      job.pendingRequestIds = authoritative ? [...new Set(value.pending.map(row => row.attention.attentionId))] : []
      const incomingRequests = new Set()
      const pendingKeys = new Set((present.has('pending') ? value.pending : []).map(row => providerKeyOf(row.attention)))
      for (const row of present.has('pending') ? value.pending : []) {
        const incoming = clone(row.attention)
        const providerKey = `${incoming.machineId}/${incoming.sessionId}/${incoming.requestId}`
        if (incomingRequests.has(providerKey)) {
          const same = snapshot.attention.find(a => `${a.machineId}/${a.sessionId}/${a.requestId}` === providerKey)
          if (!same || same.payloadHash !== incoming.payloadHash || hash(attentionIdentity(same)) !== hash(attentionIdentity(incoming))) fail('conflicting_pending_request')
          same.associatedSessionIds = [...new Set([...same.associatedSessionIds, ...incoming.associatedSessionIds])]
          continue
        }
        incomingRequests.add(providerKey)
        let existing = snapshot.attention.find(a => `${a.machineId}/${a.sessionId}/${a.requestId}` === providerKey)
        if (existing) {
          if (existing.attentionId !== incoming.attentionId || existing.payloadHash !== incoming.payloadHash ||
              hash(attentionIdentity(existing)) !== hash(attentionIdentity(incoming))) fail('request_payload_changed_requires_new_identity')
          if (existing.state === 'resolved') fail('resolved_request_reappeared')
          existing.associatedSessionIds = [...new Set([...existing.associatedSessionIds, ...incoming.associatedSessionIds])]
        } else {
          if (job.retiredAttention?.includes(retiredRequest(providerKey))) fail('resolved_request_reappeared')
          if (snapshot.attention.some(a => a.attentionId === incoming.attentionId) ||
              job.retiredAttention?.includes(retiredIdentity(incoming.attentionId))) fail('attention_identity_reused')
          if (snapshot.attention.length >= ATTENTION_MAX) {
            const retired = retireResolvedAttention(job, pendingKeys)
            // Only live or still-referenced requests fill every slot: refuse honestly.
            if (!retired) fail('attention_capacity_exceeded', 503)
            this.store.event(data, job, 'attention_retired', { attentionId: retired.attentionId, requestId: retired.requestId })
          }
          snapshot.attention.push(incoming); existing = incoming
          if (existing.kind === 'proposal') job.approvedProposal = null
          this.store.event(data, job, 'attention_opened', { attentionId: existing.attentionId, requestId: existing.requestId, kind: existing.kind })
        }
        job.attentionMeta[existing.attentionId] = {
          raw: clone(row.raw), scopeHash: value.scopeHash, policyHash: value.policyHash, scopeRevision: value.scopeRevision,
          source: value.pendingSource, observedAt, proposalHash: row.proposalHash ?? null,
          requestHash: hash(attentionIdentity(existing)),
        }
      }
      if (authoritative) {
        for (const a of snapshot.attention) {
          if (a.state === 'resolved' || incomingRequests.has(`${a.machineId}/${a.sessionId}/${a.requestId}`)) continue
          if (!value.sessionIds.includes(a.sessionId)) continue // Missing child boundaries cannot close requests.
          a.state = 'resolved'; a.resolvedAt = observedAt
          for (const row of Object.values(job.records)) {
            const answer = row.request.answer
            if (answer?.attentionId !== a.attentionId || answer.requestId !== a.requestId ||
                answer.payloadHash !== a.payloadHash || answer.revision !== a.revision ||
                !['unknown', 'invoked'].includes(row.receipt.state)) continue
            row.receipt.state = 'unknown'
            row.receipt.reason = 'native_request_resolved_delivery_attribution_unknown'
            row.outcomeAt = observedAt
            // Native disappearance is NOT proof which actor accepted which outcome.
          }
          this.store.event(data, job, 'attention_resolved', { attentionId: a.attentionId, requestId: a.requestId, attribution: 'unknown_or_external' })
        }
      }
      // Only an independently correlated receipt may establish proposal acceptance.
      if (authoritative && scopeMatches && settingsMatch) {
        for (const resolution of value.commandResolutions ?? []) {
          const row = job.records[resolution.commandId]
          if (!row || row.requestHash !== resolution.requestHash) fail('resolution_wrong_command')
          if (row.receipt.state === 'rejected') continue
          if (!row.invokedAt) fail('resolution_without_invocation')
          row.receipt.state = resolution.status; row.receipt.reason = null
          row.providerReceipt = resolution.receiptId; row.outcomeAt = observedAt
          const a = row.request.answer && snapshot.attention.find(a => a.attentionId === row.request.answer.attentionId)
          if (resolution.status === 'confirmed' && a?.kind === 'proposal' &&
              a.state === 'resolved' && row.request.answer.selectedOption === 'proceed_once' &&
              !snapshot.attention.some(other => other.kind === 'proposal' && other.state !== 'resolved' && other.requestId !== a.requestId)) {
            job.approvedProposal = { requestId: a.requestId, payloadHash: a.payloadHash, scopeHash: job.scopeHash, policyHash: job.policyHash }
          }
        }
      }
      for (const h of present.has('history') ? value.history ?? [] : []) {
        const existing = snapshot.history.find(item => item.id === h.id)
        if (existing && hash(existing) !== hash(h)) fail('history_identity_conflict')
        if (!existing) snapshot.history.push(clone(h))
      }
      snapshot.history.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
      if (snapshot.history.length > HISTORY_RETAIN) {
        // Keep the owner's goal plus the most recent rows; order is preserved.
        const goal = snapshot.history.find(h => h.id === job.intent.commandId)
        const kept = new Set(snapshot.history.filter(h => h !== goal).slice(-(goal ? HISTORY_RETAIN - 1 : HISTORY_RETAIN)))
        snapshot.history = snapshot.history.filter(h => h === goal || kept.has(h))
      }
      if (hasUnknown(job)) this.hold(job, UNKNOWN_HOLD)
      else if (!scopeMatches) this.hold(job, 'scope_policy_observation_mismatch')
      else if (!settingsMatch) this.hold(job, present.has('settings') ? 'effective_settings_changed' : 'effective_settings_observation_unavailable')
      else if (!authoritative) this.hold(job, 'pending_request_reconciliation_required')
      else if (snapshot.control === 'running' && snapshot.state !== 'completed') snapshot.holdReason = null
      if (snapshot.state === 'completed') {
        if (!snapshot.finalization) {
          snapshot.finalization = { state: 'pending', summary: null, reason: null, evidence: [] }
          job.finalizationDeadline = new Date(this.now() + FINALIZATION_MS).toISOString()
          this.store.event(data, job, 'finalization_pending')
        }
        if (snapshot.finalization.state === 'pending') {
          job.finalizationAttempts++
          if (present.has('finalization') && value.summary) snapshot.finalization.summary = value.summary
          if (present.has('finalization') && value.evidence) snapshot.finalization.evidence = value.evidence.map(row => ({ ...clone(row), verified: false }))
          // Provider artifact claims are never independently verified here.
          if (present.has('finalization') && authoritative && value.workersSettled === true && !snapshot.attention.some(a => a.state !== 'resolved') &&
              snapshot.finalization.summary && !hasUnknown(job)) {
            snapshot.finalization.state = 'incomplete'
            snapshot.finalization.reason = 'artifact_and_criteria_verification_unavailable'
            this.store.event(data, job, 'finalization_incomplete')
          }
        }
      }
      syncReceipts(job)
      this.store.event(data, job, 'observation_committed', {
        state: snapshot.state, previousState, completeness: snapshot.completeness,
        providerAt: value.providerAt ?? null, progressHash: hash(job.progressLog), featuresHash: hash(snapshot.features),
      })
    }) } catch (error) {
      if (!(error instanceof BrokerError) || error.code !== 'projection_capacity_exceeded') throw error
      this.observationGap(missionId, error.code, { source: 'snapshot', rejectedHash: hash(value), pendingCount: value.pending.length })
    }
    if (this.host && completionSettled(this.store.data.jobs[missionId])) {
      this.revokeHost(missionId, 'terminal_completion').catch(() => {})
    }
    return this.project(missionId, ownerId)
  }
  ingestNotification(missionId, ownerId, value) {
    const prior = this.job(missionId, ownerId)
    this.checkInput(value)
    object(value, ['machineId', 'sessionId', 'type', 'payload'])
    if (!prior.snapshot.binding || value.machineId !== prior.snapshot.binding.machineId ||
        value.sessionId !== prior.snapshot.binding.sessionId) fail('notification_wrong_binding')
    if (MISSION_V2_NOTIFICATION_TYPES.includes(value.type)) fail('mission_v2_notification_unsupported', 400)
    // v2 state is derived from persisted provider facts only; v1 claims cannot override it.
    if (isMissionV2(prior) && value.type !== 'mission_heartbeat') fail('sdk_mission_dialect_mixed')
    one(value.type, ['mission_state_changed', 'mission_features_changed', 'mission_progress_entry', 'mission_heartbeat',
      'mission_worker_started', 'mission_worker_completed'])
    const p = value.payload
    if (value.type === 'mission_state_changed') {
      object(p, ['state', 'updatedAt'], ['state']); one(p.state, STATE_VALUES)
      if (p.updatedAt !== undefined) time(p.updatedAt)
    } else if (value.type === 'mission_features_changed') {
      object(p, ['features']); array(p.features, 512, feature)
    } else if (value.type === 'mission_progress_entry') {
      object(p, ['progressLog']); array(p.progressLog, 512, row => boundedJson(row, 16384))
    } else if (value.type === 'mission_heartbeat') { object(p, ['timestamp']); time(p.timestamp) }
    else if (value.type === 'mission_worker_started') { object(p, ['workerSessionId']); id(p.workerSessionId) }
    else { object(p, ['workerSessionId', 'exitCode']); id(p.workerSessionId); int(p.exitCode, -65535) }
    try { this.store.transaction(data => {
      const job = data.jobs[missionId]
      if (value.type === 'mission_state_changed' && job.snapshot.state !== 'completed') {
        job.snapshot.state = p.state
        if (p.state === 'paused' && job.snapshot.control === 'running') job.snapshot.control = 'paused'
        if (p.state === 'completed' && !job.snapshot.finalization) {
          job.snapshot.finalization = { state: 'pending', summary: null, reason: null, evidence: [] }
          job.finalizationDeadline = new Date(this.now() + FINALIZATION_MS).toISOString()
        }
      } else if (value.type === 'mission_features_changed') job.snapshot.features = clone(p.features)
      else if (value.type === 'mission_progress_entry') job.progressLog = clone(p.progressLog)
      else if (value.type === 'mission_worker_started' && !job.workerSessionIds.includes(p.workerSessionId)) job.workerSessionIds.push(p.workerSessionId)
      // Heartbeats do not refresh authoritative state or pending-request ownership.
      this.store.event(data, job, value.type, { payloadHash: hash(p), providerAt: p.updatedAt ?? p.timestamp ?? null })
    }) } catch (error) {
      if (!(error instanceof BrokerError) || error.code !== 'projection_capacity_exceeded') throw error
      this.observationGap(missionId, error.code, { source: value.type, rejectedHash: hash(value) })
    }
  }
  /** Persisted SDK facts, not command-delivery receipts. Host callback only. */
  ingestProviderEnvelope(missionId, ownerId, envelope) {
    const prior = this.job(missionId, ownerId), p = prior.providerRecord
    if (!prior.snapshot.binding || p?.transportVersion !== SDK_TRANSPORT_VERSION) fail('sdk_projection_registry_required')
    const registry = p.value
    const decoded = decodeSdkEnvelope(envelope, {
      machineId: this.machineId, connectionId: registry.connectionId,
      rootSessionId: registry.rootSessionId, observedAt: new Date(this.now()).toISOString(),
    })
    if (decoded.kind !== 'request' && decoded.kind !== 'notification') return this.project(missionId, ownerId)
    if (!registry.sessions.some(row => row.sessionId === (decoded.kind === 'request' ? decoded.attention.sessionId : decoded.sessionId))) {
      fail('sdk_projection_unowned_session')
    }
    // Only currently actionable requests enter the pending projection. An
    // answer_unknown row remains in the registry/local snapshot as uncertainty;
    // re-admitting it here would violate the open-pending observation contract.
    const pending = registry.requests.filter(row => row.attention.state === 'open').map(row => ({
      attention: { ...clone(row.attention), ...(row.unsupportedReason ? { kind: 'unsupported' } : {}) },
      raw: clone(requestPayload(row)), proposalHash: row.proposalHash,
    }))
    const sessionIds = [...new Set([
      ...registry.sessions.map(row => row.sessionId),
      // Associations are display metadata only, never child ownership or a complete boundary.
      ...pending.flatMap(row => row.attention.associatedSessionIds),
    ])]
    const value = {
      binding: clone(prior.snapshot.binding), state: prior.snapshot.state === 'held' ? 'awaiting_input' : prior.snapshot.state,
      features: [], progressLog: [], workerSessionIds: [], pending, pendingComplete: false,
      pendingSource: 'notification', sessionIds, completeness: 'unknown', effectiveSettings: {},
      scopeRevision: prior.intent.scopeRevision, scopeHash: prior.scopeHash, policyHash: prior.policyHash,
      presentSections: ['pending'],
    }
    if (decoded.kind === 'request') {
      if (!registry.requests.some(row => hash(row.envelope) === hash(envelope))) fail('sdk_projection_not_persisted')
    } else {
      const n = envelope.params.notification
      const root = decoded.sessionId === registry.rootSessionId
      const sections = { mission_state_changed: 'mission', mission_features_changed: 'features', mission_progress_entry: 'progress' }
      const section = root && sections[n.type]
      if (section) {
        if (hash(registry.observations[section]?.envelope) !== hash(envelope)) fail('sdk_projection_not_persisted')
        value.presentSections.push(section)
        if (section === 'mission') value.state = n.state
        if (section === 'features') value.features = n.features.map(row => ({
          id: row.id, description: row.description, status: row.status, expectedBehavior: row.expectedBehavior,
          ...(row.milestone === undefined ? {} : { milestone: row.milestone }),
        }))
        if (section === 'progress') value.progressLog = clone(n.progressLog)
      }
      if (n.type === 'permission_resolved' || n.type === 'tool_result') {
        const effects = registry.resolutions.filter(row => hash(row.envelope) === hash(envelope))
        if (!effects.length && n.type === 'permission_resolved' &&
            registry.requests.some(row => row.attention.requestId === n.requestId &&
              row.attention.sessionId === decoded.sessionId)) fail('sdk_projection_not_persisted')
        for (const effect of effects) {
          const request = registry.requests.find(row => row.attention.attentionId === effect.attentionId)
          const correlated = request && correlateNativeResolution(request, envelope)
          if (!correlated || hash(correlated) !== hash(effect.effect)) fail('sdk_resolution_not_correlated')
          const existing = prior.snapshot.attention.find(row => row.attentionId === effect.attentionId)
          if (!existing) continue
          if (existing.payloadHash !== request.attention.payloadHash ||
              existing.sessionId !== request.attention.sessionId || existing.requestId !== request.attention.requestId ||
              existing.machineId !== request.attention.machineId ||
              hash([...existing.toolUseIds].sort()) !== hash([...request.attention.toolUseIds].sort())) fail('sdk_resolution_wrong_request')
          if (correlated.kind !== 'permission_effect') continue // Tool termination is not AskUser answer acceptance.
          this.store.transaction(data => {
            const job = data.jobs[missionId], a = job.snapshot.attention.find(row => row.attentionId === effect.attentionId)
            if (a.state === 'resolved') return
            a.state = 'resolved'; a.resolvedAt = effect.observedAt
            job.reconciledEpoch = 0; job.lastPendingAt = null; job.pendingRequestIds = []
            job.snapshot.completeness = 'unknown'
            for (const row of Object.values(job.records)) {
              if (row.request.answer?.attentionId === a.attentionId && ['invoked', 'unknown'].includes(row.receipt.state)) {
                row.receipt.state = 'unknown'; row.receipt.reason = 'native_request_resolved_delivery_attribution_unknown'
              }
            }
            syncReceipts(job)
            this.hold(job, hasUnknown(job) ? UNKNOWN_HOLD : 'pending_request_reconciliation_required')
            this.store.event(data, job, 'attention_resolved', {
              attentionId: a.attentionId, requestId: a.requestId, attribution: 'unknown_or_external',
              selectedOption: correlated.selectedOption, source: 'native_notification',
            })
          })
        }
      }
    }
    const v2 = missionV2Inputs(registry)
    if (v2) {
      if (decoded.kind === 'notification' && decoded.sessionId === registry.rootSessionId &&
          envelope.params.notification.type === 'mission_v2_snapshot_changed' &&
          hash(registry.missionV2.snapshot?.envelope) !== hash(envelope)) fail('sdk_projection_not_persisted')
      // No verified record here: never completed, and features/progress stay absent.
      // A completed job keeps its state rather than regressing on a later notification.
      if (prior.snapshot.state !== 'completed') {
        value.state = deriveMissionV2State(v2); value.presentSections.push('mission')
      }
      value.workerSessionIds = missionV2WorkerSessionIds(v2); value.presentSections.push('workers')
    }
    // v2-agents: never newly completed here (no settle window is observable on this path);
    // only a completion the provider latched and persisted is reported as completed.
    const agents = missionV2AgentsInputs(registry, { live: false })
    if (agents) {
      if (prior.snapshot.state !== 'completed') {
        value.state = deriveMissionV2AgentsState(agents); value.presentSections.push('mission')
      }
      value.workerSessionIds = agents.agents.map(row => row.sessionId)
      value.sessionIds = [...new Set([...value.sessionIds, ...value.workerSessionIds])]
      value.presentSections.push('workers')
    }
    return this.ingestObservation(missionId, ownerId, value)
  }
  finishIncomplete(missionId) {
    this.store.transaction(data => {
      const job = data.jobs[missionId]
      if (job.snapshot.finalization?.state !== 'pending') return
      job.snapshot.finalization.state = 'incomplete'; job.snapshot.finalization.reason = 'readonly_collection_deadline_or_attempt_limit'
      this.store.event(data, job, 'finalization_incomplete')
    })
    const job = this.store.data.jobs[missionId]
    if (this.host && job && completionSettled(job)) this.revokeHost(missionId, 'terminal_completion').catch(() => {})
  }
  readEvents(ownerId, after, limit) { return this.store.readEvents(ownerId, after, limit) }
  /**
   * The owner's job ids and states, so the phone can adopt host-launched
   * missions and observe each through its own route. No goal, intent or history.
   */
  listJobs(ownerId) {
    this.authorize(ownerId)
    return { jobs: Object.values(this.store.data.jobs).map(job => ({
      missionId: job.intent.missionId, state: job.snapshot.state, scopeRevision: job.snapshot.scopeRevision,
      brokerSeq: job.snapshot.brokerSeq, holdReason: job.snapshot.holdReason ?? null,
      // A held job may still have launched (an unknown outcome); bound is what
      // tells the phone there is a session to observe.
      bound: !!job.snapshot.binding,
    })) }
  }
  /** Explicit opt-in (SPRIITE_NATIVE_X_READER=1). Without it every X route answers 503. */
  enableXReader(options = {}) {
    if (this.xHost) fail('x_reader_already_enabled', 503)
    this.xHost = new NativeXHost({ ...options, broker: this, directory: this.store.directory })
    return this.xHost
  }
  requireXHost() { if (!this.xHost) fail('x_reader_unavailable', 503); return this.xHost }
  async xHandoff(input) { return this.requireXHost().handoff(input) }
  async xStatus() { return this.requireXHost().status() }
  async xStop(input) { return this.requireXHost().stop(input) }
  /** Service-owned observation capacity; no HTTP/phone lifetime abort signal. */
  startObservationLoop({ intervalMs = 5000 } = {}) {
    int(intervalMs, 20)
    if (intervalMs > 60000) fail('invalid_observation_interval', 400)
    if (this.observationTimer) return
    this.resumeDeliveries()
    let busy = false
    this.observationTimer = setInterval(async () => {
      if (busy || this.store.closed || this.store.poisoned) return
      busy = true
      try {
        const jobs = Object.values(this.store.data.jobs).filter(job =>
          job.snapshot.binding && (!job.snapshot.finalization || job.snapshot.finalization.state === 'pending'))
        // At most eight simultaneous read-only requests, regardless of client count.
        for (let i = 0; i < jobs.length && !this.store.closed; i += NATIVE_MAX_OUTSTANDING_READS) {
          await Promise.allSettled(jobs.slice(i, i + NATIVE_MAX_OUTSTANDING_READS).map(job => this.observe(job.intent.missionId, this.ownerId)))
        }
        // A timer callback has no caller: a host or projection fault must not
        // escape as an unhandled rejection, nor skip the remaining jobs.
        try { this.host?.renewLeases?.() } catch {}
        for (const job of Object.values(this.store.data.jobs)) {
          try { this.afterObservation(job.intent.missionId) } catch {}
        }
      } catch {} finally { busy = false }
    }, intervalMs)
    this.observationTimer.unref()
  }
  close() {
    if (this.observationTimer) clearInterval(this.observationTimer)
    this.xHost?.halt().catch(() => {})
    this.store.close()
  }
  /** Explicit server shutdown verifies daemon revocation before closing storage. */
  async shutdown() {
    if (this.observationTimer) clearInterval(this.observationTimer)
    await this.xHost?.halt()
    await Promise.allSettled(Object.keys(this.store.data.jobs).map(missionId => this.revokeHost(missionId, 'broker_shutdown')))
    await this.settleDeliveries()
    this.close()
  }
}

const X_HANDOFF_FIELDS = ['accessToken', 'refreshToken', 'expiresAt', 'clientId', 'spriiteHandle', 'spriiteXUserId',
  'defaultRepository', 'repositoryAccount', 'template', 'delivery', 'startAt', 'seenPostIds', 'repositories']
const X_HANDOFF_REQUIRED = ['accessToken', 'refreshToken', 'clientId', 'spriiteHandle', 'template', 'delivery']
const X_CONFIG_FIELDS = ['version', 'enabled', 'ownerXUserId', 'spriiteHandle', 'spriiteXUserId', 'defaultRepository',
  'repositoryAccount', 'repositories', 'template', 'delivery', 'savedAt']
const X_CONFIG_MAX_BYTES = 262144
const X_MAX_REPOSITORIES = 500
const X_MAX_SEEN_POSTS = 100
const X_FULL_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})$/
const validFullName = v => typeof v === 'string' && X_FULL_NAME.test(v) && !/^\.{1,2}$/.test(v.split('/')[1])
const validRepositories = v => v === null || (Array.isArray(v) && v.length <= X_MAX_REPOSITORIES && v.every(validFullName))
const X_TOKEN = /^[\x21-\x7e]{1,4096}$/
const X_CLIENT_ID = /^[A-Za-z0-9._~-]{1,256}$/
const X_HANDLE = /^@?([A-Za-z0-9_]{1,15})$/
const X_USER_ID = /^\d{1,20}$/
const X_ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const X_REPOSITORY = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/
const X_RECEIPTS_SHOWN = 50
/**
 * The checkpoint the phone adopts on taking X back. Mid-backlog it is the
 * newest post the host read: a post in the unread older span is then left to
 * the gap the host reported, never launched a second time by the phone.
 */
const pickCheckpoint = c => {
  if (!c || typeof c !== 'object') return null
  const ids = [c.lastSeenPostId, c.backlog?.newestId].filter(v => typeof v === 'string' && X_USER_ID.test(v))
  const lastSeenPostId = ids.reduce((a, b) => (a === null || BigInt(b) > BigInt(a) ? b : a), null)
  return { lastSeenPostId, lastSuccessAt: typeof c.lastSuccessAt === 'string' ? c.lastSuccessAt : null }
}
const errorCode = error => error instanceof BrokerError && /^[a-z0-9_]{1,128}$/.test(error.code) ? error.code : 'x_reader_failed'

/**
 * The host X reader's owner: the handoff (verify, persist the credential and
 * config, start), status (no secrets) and stop. The credential file and the
 * reader ledger live beside the broker ledger; tokens are never logged, never
 * returned and never written anywhere but the credential store.
 */
export class NativeXHost {
  constructor({
    broker, directory, hostRoot, baseRef = 'refs/heads/main', fs = nodeFs, fetch, now = Date.now,
    loadReader = () => import('./x-reader.mjs'), loadLauncher = () => import('./x-launch.mjs'),
  }) {
    if (typeof hostRoot !== 'string' || !hostRoot.startsWith('/') || typeof baseRef !== 'string') fail('x_reader_configuration_required', 503)
    str(directory, 2048); str(hostRoot, 1800); str(baseRef, 256)
    Object.assign(this, { broker, directory, hostRoot, baseRef, fs, fetch, now, loadReader, loadLauncher })
    this.configPath = join(directory, 'x-reader-config.json')
    this.ledgerPath = join(directory, 'x-reader.json')
    this.credential = createXCredentialStore({ path: join(directory, 'x-credential.json'), fs, fetch, now })
    this.reader = null; this.lastError = null; this.lastCheckpoint = null; this.queue = Promise.resolve()
  }
  /** Handoff, stop and resume never interleave. */
  serial(operation) {
    const run = this.queue.then(operation, operation)
    this.queue = run.catch(() => {})
    return run
  }
  async modules() {
    let reader, launcher
    try { [reader, launcher] = await Promise.all([this.loadReader(), this.loadLauncher()]) } catch { fail('x_reader_unavailable', 503) }
    if (typeof reader?.createXReader !== 'function' || typeof launcher?.createXLauncher !== 'function') fail('x_reader_unavailable', 503)
    return { reader, launcher }
  }
  secrets() { return [this.credential.current()?.accessToken, ...this.broker.store.secrets].filter(Boolean) }

  readConfig() {
    const fs = this.fs
    let fd
    try { fd = fs.openSync(this.configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) } catch (error) {
      if (error?.code === 'ENOENT') return null
      fail('x_reader_config_unsafe', 503)
    }
    let value
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > X_CONFIG_MAX_BYTES ||
          (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('x_reader_config_unsafe', 503)
      value = JSON.parse(fs.readFileSync(fd, 'utf8'))
    } catch (error) {
      if (error instanceof BrokerError) throw error
      fail('x_reader_config_invalid', 503)
    } finally { fs.closeSync(fd) }
    try {
      object(value, X_CONFIG_FIELDS)
      if (value.version !== 1 || typeof value.enabled !== 'boolean' || typeof value.ownerXUserId !== 'string' ||
          !X_USER_ID.test(value.ownerXUserId) || typeof value.spriiteHandle !== 'string' || !X_HANDLE.test(value.spriiteHandle) ||
          (value.spriiteXUserId !== null && (typeof value.spriiteXUserId !== 'string' || !X_USER_ID.test(value.spriiteXUserId))) ||
          (value.repositoryAccount !== null && (typeof value.repositoryAccount !== 'string' || !X_ACCOUNT.test(value.repositoryAccount))) ||
          (value.defaultRepository !== null && (typeof value.defaultRepository !== 'string' || !X_REPOSITORY.test(value.defaultRepository))) ||
          !validRepositories(value.repositories ?? null)) fail('x_reader_config_invalid', 503)
      time(value.savedAt); boundedJson(value, X_CONFIG_MAX_BYTES)
    } catch { fail('x_reader_config_invalid', 503) }
    return value
  }
  /** Temp file, fsync, rename, directory fsync: a crash leaves the old or the new config. */
  writeConfig(value) {
    const fs = this.fs, temp = `${this.configPath}.${randomUUID()}.tmp`
    try {
      const fd = fs.openSync(temp, 'wx', 0o600)
      try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(temp, this.configPath)
      const dir = fs.openSync(this.directory, 'r')
      try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
    } catch {
      try { fs.unlinkSync(temp) } catch {}
      fail('x_reader_config_persist_failed', 503)
    }
  }

  parseHandoff(input, launcher) {
    object(input, X_HANDOFF_FIELDS, X_HANDOFF_REQUIRED)
    const { accessToken, refreshToken, clientId } = input
    if (typeof accessToken !== 'string' || !X_TOKEN.test(accessToken) || typeof refreshToken !== 'string' ||
        !X_TOKEN.test(refreshToken) || accessToken === refreshToken) fail('x_handoff_token_invalid', 400)
    if (typeof clientId !== 'string' || !X_CLIENT_ID.test(clientId)) fail('x_handoff_client_invalid', 400)
    const handle = typeof input.spriiteHandle === 'string' ? X_HANDLE.exec(input.spriiteHandle) : null
    if (!handle) fail('x_handoff_handle_invalid', 400)
    let defaultRepository = null
    if (input.defaultRepository !== undefined && input.defaultRepository !== null) {
      const repo = typeof input.defaultRepository === 'string' ? X_REPOSITORY.exec(input.defaultRepository) : null
      if (!repo || /^\.{1,2}$/.test(repo[2]) || /\.git$/i.test(repo[2])) fail('x_handoff_repository_invalid', 400)
      defaultRepository = `https://github.com/${repo[1]}/${repo[2]}`
    }
    let spriiteXUserId = null
    if (input.spriiteXUserId !== undefined && input.spriiteXUserId !== null) {
      if (typeof input.spriiteXUserId !== 'string' || !X_USER_ID.test(input.spriiteXUserId)) fail('x_handoff_spriite_id_invalid', 400)
      spriiteXUserId = input.spriiteXUserId
    }
    // New repositories go under the owner's account: stated, else the default repository's owner.
    let repositoryAccount = defaultRepository && X_REPOSITORY.exec(defaultRepository)[1]
    if (input.repositoryAccount !== undefined && input.repositoryAccount !== null) {
      if (typeof input.repositoryAccount !== 'string' || !X_ACCOUNT.test(input.repositoryAccount)) fail('x_handoff_account_invalid', 400)
      repositoryAccount = input.repositoryAccount
    }
    const template = launcher.xLaunchTemplate(input.template)
    if (!template) fail('x_handoff_template_invalid', 400)
    const delivery = launcher.xLaunchDelivery(input.delivery)
    if (!delivery) fail('x_handoff_delivery_invalid', 400)
    // The owner's repository names, read on the phone through their GitHub token:
    // a word naming one is asked about instead of routed to the default.
    let repositories = null
    if (input.repositories !== undefined && input.repositories !== null) {
      if (!validRepositories(input.repositories)) fail('x_handoff_repositories_invalid', 400)
      repositories = [...new Set(input.repositories)]
    }
    // Where the phone's reading ended, so the host's first read starts there.
    let startAt = null
    if (input.startAt !== undefined && input.startAt !== null) {
      if (typeof input.startAt !== 'string' || input.startAt.length > 40 || !Number.isFinite(Date.parse(input.startAt))) fail('x_handoff_start_invalid', 400)
      startAt = new Date(Date.parse(input.startAt)).toISOString()
    }
    let seenPostIds = []
    if (input.seenPostIds !== undefined && input.seenPostIds !== null) {
      if (!Array.isArray(input.seenPostIds) || input.seenPostIds.length > X_MAX_SEEN_POSTS ||
          !input.seenPostIds.every(v => typeof v === 'string' && X_USER_ID.test(v))) fail('x_handoff_seen_invalid', 400)
      seenPostIds = [...new Set(input.seenPostIds)]
    }
    let expiresAt = new Date(this.now()).toISOString()
    if (input.expiresAt !== undefined) {
      if (typeof input.expiresAt !== 'string' || input.expiresAt.length > 40 || !Number.isFinite(Date.parse(input.expiresAt))) fail('x_handoff_expiry_invalid', 400)
      expiresAt = new Date(Date.parse(input.expiresAt)).toISOString()
    }
    const config = { spriiteHandle: handle[1], spriiteXUserId, defaultRepository, repositoryAccount: repositoryAccount ?? null,
      repositories, template, delivery }
    // Nothing secret may ride along into the config file or a status reply.
    secretFree(config, [accessToken, refreshToken, ...this.broker.store.secrets])
    return { pair: { accessToken, refreshToken, expiresAt, clientId }, config, start: { startAt, seenPostIds } }
  }
  /** `GET /2/users/me` with the handed-over access token only: verification never renews or rotates. */
  async verify(pair) {
    const probe = createXClient({ fetch: this.fetch, credential: {
      current: () => Object.freeze({ accessToken: pair.accessToken, expiresAt: pair.expiresAt, clientId: pair.clientId, ownerId: '0', state: 'active' }),
      renew: async () => fail('x_credential_missing', 503),
    } })
    let me
    try { me = await probe.me() } catch (error) {
      const kind = error instanceof XClientError ? error.kind : 'service'
      if (kind === 'auth' || kind === 'forbidden') fail('x_handoff_rejected', 409)
      fail(`x_handoff_${kind}`, 503)
    }
    if (typeof me?.id !== 'string' || !X_USER_ID.test(me.id)) fail('x_handoff_unverified', 503)
    return me
  }
  build(config, modules) {
    const launch = modules.launcher.createXLauncher({
      broker: this.broker, ownerId: this.broker.ownerId, machineId: this.broker.machineId,
      hostRoot: this.hostRoot, baseRef: this.baseRef, template: config.template, delivery: config.delivery,
      newRepositoryAccount: config.repositoryAccount,
    })
    const repositories = Array.isArray(config.repositories) ? Object.freeze([...config.repositories]) : null
    return { launch, create: () => modules.reader.createXReader({
      client: createXClient({ credential: this.credential, fetch: this.fetch }), launch,
      ledgerPath: this.ledgerPath, now: this.now,
      ...(repositories ? { repositories: () => repositories } : {}),
      // A job the broker does not know reads as live: a reply is then held, never launched.
      missionLive: missionId => this.broker.store.data.jobs[missionId]?.snapshot.state !== 'completed',
      // Event names only: reader fields are codes, but nothing else reaches a log.
      log: event => { process.stderr.write(`[x-reader] ${String(event).replace(/[^a-z0-9_]/g, '')}\n`) },
    }) }
  }
  /**
   * A handoff binds the reader afresh (`start` given: a new ownership period
   * from where the phone stopped reading). A resume starts the stored binding
   * only when it is the config's; otherwise it rebinds to the config first, so
   * the ledger never runs another handoff's owner, Spriite or default.
   */
  async run(config, modules, start = null) {
    const reader = this.build(config, modules).create()
    if (!reader || typeof reader.start !== 'function' || typeof reader.stop !== 'function') fail('x_reader_unavailable', 503)
    // Owned from here, so a failure below stops it rather than leaving it orphaned.
    this.reader = reader
    const input = {
      spriiteHandle: config.spriiteHandle, ownerId: config.ownerXUserId,
      ...(config.spriiteXUserId ? { spriiteUserId: config.spriiteXUserId } : {}),
      ...(config.defaultRepository ? { defaultRepository: config.defaultRepository } : {}),
    }
    if (start) await reader.bind({ ...input, fresh: true, startAt: start.startAt, seenPostIds: start.seenPostIds })
    else if (!this.bindingMatches(reader, config)) await reader.bind(input)
    await reader.start()
    this.lastError = null
  }
  bindingMatches(reader, config) {
    let b = null
    try { b = reader.status?.()?.binding ?? null } catch { return false }
    return !!b && b.ownerXUserId === config.ownerXUserId &&
      typeof b.spriiteHandle === 'string' && b.spriiteHandle.toLowerCase() === config.spriiteHandle.toLowerCase() &&
      (config.spriiteXUserId === null || b.spriiteXUserId === config.spriiteXUserId) &&
      (b.defaultRepository ?? null) === config.defaultRepository
  }
  /** Stops the reader and waits for its in-flight check: no two readers ever write one ledger. */
  async halt() {
    const reader = this.reader
    this.reader = null
    if (!reader) return
    try { await reader.stop() } catch {}
    try { this.lastCheckpoint = structuredClone(reader.status?.()?.checkpoint ?? null) } catch {}
  }
  /** Erase the X pair at rest; a failure is reported, never hidden. */
  clearCredential() {
    try { this.credential.clear(); return true } catch (error) { this.lastError = errorCode(error); return false }
  }

  /**
   * The config is enabled only once the reader is bound and started: until
   * then it is written disabled, so a crash or a failed bind never leaves an
   * enabled config for resume(). A failure after the credential was stored
   * erases it again; the phone still holds its own pair until it sees the host read.
   */
  handoff(input) {
    return this.serial(async () => {
      const modules = await this.modules()
      const { pair, config, start } = this.parseHandoff(input, modules.launcher)
      const me = await this.verify(pair)
      if (typeof me.username === 'string' && me.username.toLowerCase() === config.spriiteHandle.toLowerCase()) fail('x_handoff_handle_is_owner', 400)
      const saved = { version: 1, enabled: false, ownerXUserId: me.id, ...config, savedAt: new Date(this.now()).toISOString() }
      // Validate the launcher configuration before anything is persisted.
      this.build(saved, modules)
      // One writer of the credential: the old reader stops (its check drained) before the pair is replaced.
      await this.halt()
      this.credential.save({ ...pair, ownerId: me.id })
      try {
        this.writeConfig(saved)
        await this.run(saved, modules, start)
        this.writeConfig({ ...saved, enabled: true })
      } catch (error) {
        this.lastError = errorCode(error)
        await this.halt()
        this.clearCredential()
        try { this.writeConfig(saved) } catch {}
        throw error
      }
      return this.statusNow()
    })
  }
  /** Stop reading and erase the pair: the host keeps no grant it could later renew. */
  stop(input = {}) {
    object(input, [])
    return this.serial(async () => {
      await this.halt()
      const config = this.readConfig()
      if (config?.enabled) this.writeConfig({ ...config, enabled: false })
      if (!this.clearCredential()) fail('x_credential_persist_failed', 503)
      if (!this.lastCheckpoint) this.lastCheckpoint = await this.peekCheckpoint()
      return this.statusNow()
    })
  }
  /** The ledger's checkpoint without a running reader (after a restart), or null. */
  async peekCheckpoint() {
    try {
      const { reader } = await this.modules()
      const inert = async () => { throw new BrokerError('x_reader_stopped', 409) }
      const peek = reader.createXReader({ ledgerPath: this.ledgerPath, client: { me: inert, userPosts: inert },
        launch: async () => ({ status: 'held', reason: 'stopped' }), now: this.now })
      return structuredClone(peek.status?.()?.checkpoint ?? null)
    } catch { return null }
  }
  /**
   * Broker startup: start only an enabled config whose stored credential is the
   * config's owner. A disabled config never leaves a grant at rest. Never throws.
   */
  resume() {
    return this.serial(async () => {
      try {
        const config = this.readConfig()
        const credential = this.credential.load()
        if (!config?.enabled) {
          if (credential) this.clearCredential()
          return false
        }
        if (!credential) { this.lastError = 'x_credential_missing'; return false }
        if (credential.ownerId !== config.ownerXUserId) { this.lastError = 'x_reader_owner_mismatch'; return false }
        try { await this.run(config, await this.modules()) } catch (error) { await this.halt(); throw error }
        return true
      } catch (error) { this.lastError = errorCode(error); return false }
    })
  }
  status() { return this.statusNow() }
  async statusNow() {
    let config = null, configError = null
    try { config = this.readConfig() } catch (error) { configError = errorCode(error) }
    const credential = this.credential.current()
    let reader = null
    if (this.reader && typeof this.reader.status === 'function') {
      try {
        const raw = structuredClone(await this.reader.status())
        if (raw && Array.isArray(raw.receipts)) raw.receipts = raw.receipts.slice(0, X_RECEIPTS_SHOWN) // newest first
        boundedJson(raw, 262144); secretFree(raw, this.secrets())
        reader = raw
      } catch { reader = { withheld: 'x_reader_status_unreadable' } }
    }
    return {
      enabled: config?.enabled === true, running: !!this.reader,
      ownerXUserId: config?.ownerXUserId ?? null, spriiteHandle: config?.spriiteHandle ?? null,
      spriiteXUserId: config?.spriiteXUserId ?? null, defaultRepository: config?.defaultRepository ?? null,
      repositoryAccount: config?.repositoryAccount ?? null, delivery: config?.delivery ?? null,
      credential: credential ? { state: credential.state, expiresAt: credential.expiresAt } : null,
      // Where the host's reading reached, so the phone resumes after it, never before.
      checkpoint: reader && !reader.withheld && reader.checkpoint ? pickCheckpoint(reader.checkpoint) : pickCheckpoint(this.lastCheckpoint),
      lastError: this.lastError ?? configError, reader,
    }
  }
}
