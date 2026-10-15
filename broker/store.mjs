import {
  mkdirSync, openSync, writeFileSync, readSync, closeSync, fsyncSync, renameSync,
  unlinkSync, rmdirSync, lstatSync, fstatSync, realpathSync, readdirSync, constants,
} from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  BrokerError, fail, object, id, int, str, one, array, hash, digest, intent, command,
  attention, validateBinding, feature, time, clone, boundedJson, secretFree, settings,
  readableSnapshot, NATIVE_SNAPSHOT_ADMISSION_BYTES, deliveryProjection, deliveryEffect, usageState, bool, safeUrl,
} from './validation.mjs'
import { validateProviderRecord } from './sdk-provider.mjs'
import { SDK_TRANSPORT_VERSION } from './sdk-wire.mjs'
import { validateNativeDeliveryInput } from './native-delivery-input.mjs'

const MAX_BYTES = 8 * 1024 * 1024
// The event feed is a bounded audit window, not an authority: seq stays
// monotonic forever while the oldest events are compacted away. Pruning to
// EVENT_RETAIN (not one-at-a-time) keeps compaction rare.
export const EVENT_WINDOW = 8192
export const EVENT_RETAIN = 6144
// Identity digests of resolved attention evicted at capacity, so a retired
// request reappearing is still refused (two digests per retired request).
export const RETIRED_ATTENTION_MAX = 512
const RECEIPT_STATES = ['prepared', 'invoked', 'confirmed', 'rejected', 'unknown']
function receipt(row) {
  object(row, ['commandId', 'state', 'reason']); id(row.commandId); one(row.state, RECEIPT_STATES)
  if (row.reason !== null) str(row.reason, 256)
}
function history(row) {
  object(row, ['id', 'who', 'text', 'at']); id(row.id); one(row.who, ['owner', 'factory', 'spriite'])
  str(row.text, 32768, true); time(row.at)
}
function finalization(row) {
  if (row === null) return
  object(row, ['state', 'summary', 'reason', 'evidence'])
  one(row.state, ['pending', 'complete', 'incomplete'])
  if (row.summary !== null) str(row.summary, 32768)
  if (row.reason !== null) str(row.reason, 256)
  array(row.evidence, 128, e => {
    object(e, ['id', 'url', 'verified', 'commitSha'])
    id(e.id); str(e.url, 2048)
    if (typeof e.verified !== 'boolean') fail('store_corrupt', 503)
    if (e.commitSha !== null && !/^[a-f0-9]{40,64}$/.test(e.commitSha)) fail('store_corrupt', 503)
  })
}
function snapshot(row) {
  object(row, ['protocolVersion', 'backend', 'missionId', 'ownerId', 'scopeRevision', 'brokerSeq', 'state', 'control', 'binding',
    'capabilities', 'attention', 'features', 'history', 'commands', 'lastObservedAt', 'completeness', 'holdReason', 'finalization'])
  one(row.protocolVersion, [1]); one(row.backend, ['factory_native']); id(row.missionId); id(row.ownerId)
  int(row.scopeRevision, 1); int(row.brokerSeq)
  one(row.state, ['held', 'planning', 'awaiting_input', 'initializing', 'running', 'paused', 'orchestrator_turn', 'completed'])
  one(row.control, ['running', 'pause_requested', 'paused', 'cancel_requested', 'cancelled'])
  if (row.binding !== null) validateBinding(row.binding)
  object(row.capabilities, ['protocolVersion', 'qualificationId', 'transportVersion', 'qualified', 'launch', 'rootAttention',
    'childAttention', 'recoverAttention', 'pause', 'resume', 'cancel'])
  one(row.capabilities.protocolVersion, [1]); str(row.capabilities.transportVersion, 256)
  if (row.capabilities.qualificationId !== null) id(row.capabilities.qualificationId)
  for (const key of ['qualified', 'launch', 'rootAttention', 'childAttention', 'recoverAttention', 'pause', 'resume', 'cancel']) {
    if (typeof row.capabilities[key] !== 'boolean') fail('store_corrupt', 503)
  }
  array(row.attention, 256, attention); array(row.features, 512, feature)
  array(row.history, 512, history); array(row.commands, 512, receipt)
  if (row.lastObservedAt !== null) time(row.lastObservedAt)
  one(row.completeness, ['complete', 'gap', 'unknown'])
  if (row.holdReason !== null) str(row.holdReason, 256)
  finalization(row.finalization)
  readableSnapshot(row)
}
export function validateLedger(data, ownerId) {
  object(data, ['version', 'ownerId', 'epoch', 'seq', 'jobs', 'events'])
  one(data.version, [1]); id(data.ownerId); if (data.ownerId !== ownerId) fail('store_owner_mismatch', 503)
  int(data.epoch); int(data.seq)
  object(data.jobs, Object.keys(data.jobs), [])
  if (Object.keys(data.jobs).length > 128) fail('capacity_exceeded', 503)
  for (const [missionId, job] of Object.entries(data.jobs)) {
    id(missionId)
    object(job, ['intent', 'intentHash', 'scopeHash', 'policyHash', 'snapshot', 'records', 'attentionMeta',
      'effectiveSettings', 'approvedProposal', 'progressLog', 'workerSessionIds', 'reconciledEpoch',
      'lastPendingAt', 'pendingRequestIds', 'finalizationDeadline', 'finalizationAttempts', 'launchQualification',
      'providerRecord', 'sectionMeta', 'delivery', 'deliveryStartedAt', 'deliveryInput',
      'deliveryAttempts', 'deliveryAttemptedAt', 'deliveryRetryExhausted', 'deliveryEffects', 'hostRecovery', 'hostShutdown', 'hostFailure', 'usage',
      'retiredAttention'],
    ['intent', 'intentHash', 'scopeHash', 'policyHash', 'snapshot', 'records', 'attentionMeta',
      'effectiveSettings', 'approvedProposal', 'progressLog', 'workerSessionIds', 'reconciledEpoch',
      'lastPendingAt', 'pendingRequestIds', 'finalizationDeadline', 'finalizationAttempts', 'launchQualification'])
    intent(job.intent); digest(job.intentHash); digest(job.scopeHash); digest(job.policyHash)
    if (hash(job.intent) !== job.intentHash || job.scopeHash !== hash(scopeOf(job.intent)) ||
        job.policyHash !== hash({ policy: job.intent.policy, settings: job.intent.settings })) fail('store_corrupt', 503)
    snapshot(job.snapshot)
    if (job.intent.missionId !== missionId || job.snapshot.missionId !== missionId ||
        job.intent.ownerId !== ownerId || job.snapshot.ownerId !== ownerId ||
        job.snapshot.scopeRevision !== job.intent.scopeRevision || job.snapshot.brokerSeq > data.seq) fail('store_corrupt', 503)
    if (job.snapshot.binding && !workspaceMatches(job.intent.workspace, job.snapshot.binding)) fail('store_corrupt', 503)
    object(job.records, Object.keys(job.records), [])
    if (Object.keys(job.records).length > 512) fail('capacity_exceeded', 503)
    for (const [commandId, record] of Object.entries(job.records)) {
      id(commandId)
      object(record, ['request', 'requestHash', 'receipt', 'leaseEpoch', 'preparedAt', 'invokedAt', 'outcomeAt', 'providerReceipt'])
      if (record.request.kind === undefined) intent(record.request)
      else command(record.request)
      digest(record.requestHash); receipt(record.receipt); int(record.leaseEpoch, 1); time(record.preparedAt)
      if (record.invokedAt !== null) time(record.invokedAt)
      if (record.outcomeAt !== null) time(record.outcomeAt)
      if (record.providerReceipt !== null) str(record.providerReceipt, 512)
      if (hash(record.request) !== record.requestHash || record.request.ownerId !== ownerId ||
          record.request.missionId !== missionId || record.request.commandId !== commandId ||
          record.receipt.commandId !== commandId || record.leaseEpoch > data.epoch) fail('store_corrupt', 503)
    }
    if (hash(job.snapshot.commands) !== hash(Object.values(job.records).map(record => record.receipt))) fail('store_corrupt', 503)
    object(job.attentionMeta, Object.keys(job.attentionMeta), [])
    if (Object.keys(job.attentionMeta).length !== job.snapshot.attention.length ||
        new Set(job.snapshot.attention.map(a => a.attentionId)).size !== job.snapshot.attention.length) fail('store_corrupt', 503)
    for (const a of job.snapshot.attention) {
      const meta = job.attentionMeta[a.attentionId]
      object(meta, ['raw', 'scopeHash', 'policyHash', 'scopeRevision', 'source', 'observedAt', 'proposalHash', 'requestHash'])
      digest(meta.scopeHash); digest(meta.policyHash); int(meta.scopeRevision, 1)
      one(meta.source, ['authoritative', 'notification']); time(meta.observedAt)
      if (meta.proposalHash !== null) digest(meta.proposalHash)
      digest(meta.requestHash)
      if (hash(meta.raw) !== a.payloadHash || hash(attentionIdentity(a)) !== meta.requestHash) fail('store_corrupt', 503)
      boundedJson(meta.raw, 131072)
    }
    if (job.effectiveSettings !== null) settings(job.effectiveSettings)
    if (job.approvedProposal !== null) {
      object(job.approvedProposal, ['requestId', 'payloadHash', 'scopeHash', 'policyHash'])
      id(job.approvedProposal.requestId)
      for (const key of ['payloadHash', 'scopeHash', 'policyHash']) digest(job.approvedProposal[key])
      const grant = job.approvedProposal
      const request = job.snapshot.attention.find(a => a.kind === 'proposal' && a.requestId === grant.requestId &&
        a.payloadHash === grant.payloadHash && a.state === 'resolved')
      if (!request || grant.scopeHash !== job.scopeHash || grant.policyHash !== job.policyHash ||
          !Object.values(job.records).some(row => row.request.answer?.requestId === grant.requestId &&
            row.request.answer?.payloadHash === grant.payloadHash && row.request.answer?.selectedOption === 'proceed_once' &&
            row.receipt.state === 'confirmed' && row.invokedAt !== null && row.providerReceipt !== null)) fail('store_corrupt', 503)
    }
    if (job.retiredAttention !== undefined) array(job.retiredAttention, RETIRED_ATTENTION_MAX, digest)
    array(job.progressLog, 512, row => { boundedJson(row, 16384) })
    array(job.workerSessionIds, 256, id)
    array(job.pendingRequestIds, 256, id)
    if (new Set(job.pendingRequestIds).size !== job.pendingRequestIds.length ||
        job.pendingRequestIds.some(id => !job.snapshot.attention.some(a => a.attentionId === id && a.state !== 'resolved'))) fail('store_corrupt', 503)
    int(job.reconciledEpoch); if (job.reconciledEpoch > data.epoch) fail('store_corrupt', 503)
    if (job.lastPendingAt !== null) time(job.lastPendingAt)
    if (job.finalizationDeadline !== null) time(job.finalizationDeadline)
    int(job.finalizationAttempts)
    if (job.launchQualification !== null) digest(job.launchQualification)
    if (job.delivery !== undefined && job.delivery !== null) deliveryProjection(job.delivery)
    if (job.deliveryEffects !== undefined) {
      object(job.deliveryEffects, Object.keys(job.deliveryEffects), [])
      if (Object.keys(job.deliveryEffects).length > 5) fail('store_corrupt', 503)
      const kinds = new Set()
      let deliveredHead
      for (const [effectId, row] of Object.entries(job.deliveryEffects)) {
        deliveryEffect(row)
        const repository = job.intent.destination.account && job.intent.destination.name
          ? `${job.intent.destination.account}/${job.intent.destination.name}`
          : job.intent.workspace.repository?.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
        if (row.effectId !== effectId || row.identity.missionId !== missionId ||
            row.identity.ownerId !== ownerId || row.identity.machineId !== job.intent.workspace.machineId ||
            row.identity.scopeHash !== job.scopeHash || row.identity.policyHash !== job.policyHash ||
            row.identity.repository !== repository || row.identity.baseSha !== job.intent.workspace.baseSha ||
            row.identity.baseRef !== job.intent.workspace.baseRef.replace(/^refs\/heads\//, '') ||
            kinds.has(row.identity.kind)) fail('store_corrupt', 503)
        const kind = row.identity.kind
        if (kind !== 'create_repository') {
          const creation = Object.values(job.deliveryEffects).find(value =>
            value.identity.kind === 'create_repository' && value.state === 'confirmed' && value.receipt?.created === true)
          const expected = creation ? { repositoryId: creation.receipt.repositoryId, visibility: 'PRIVATE' }
            : job.deliveryInput?.repositoryIdentity
          if (!expected || expected.repositoryId !== row.identity.repositoryId || expected.visibility !== row.identity.visibility ||
              row.identity.visibility !== job.intent.destination.visibility.toUpperCase()) fail('store_corrupt', 503)
        }
        const flag = { create_repository: 'allowCreateRepository', initial_seed_push: 'allowPush',
          branch_push: 'allowPush', pr_create: 'allowPr', pr_merge: 'allowMerge' }[kind]
        if (job.intent.policy[flag] !== true) fail('store_corrupt', 503)
        if (kind === 'create_repository' || kind === 'initial_seed_push') {
          if (row.identity.headSha !== row.identity.baseSha) fail('store_corrupt', 503)
        } else {
          if ((deliveredHead && deliveredHead !== row.identity.headSha) ||
              row.identity.branch !== `spriite/${missionId}` ||
              hash(row.identity.policy) !== hash({ allowPush: job.intent.policy.allowPush,
                allowPr: job.intent.policy.allowPr, allowMerge: job.intent.policy.allowMerge })) fail('store_corrupt', 503)
          deliveredHead = row.identity.headSha
        }
        kinds.add(row.identity.kind)
      }
    }
    if (job.deliveryStartedAt !== undefined && job.deliveryStartedAt !== null) time(job.deliveryStartedAt)
    if (job.deliveryInput !== undefined) {
      boundedJson(job.deliveryInput, 65536); validateNativeDeliveryInput(job.deliveryInput)
    }
    if (job.deliveryAttempts !== undefined) int(job.deliveryAttempts)
    if (job.deliveryAttemptedAt !== undefined) time(job.deliveryAttemptedAt)
    if (job.deliveryRetryExhausted !== undefined) bool(job.deliveryRetryExhausted)
    if (job.hostRecovery !== undefined) bool(job.hostRecovery)
    if (job.hostShutdown !== undefined) one(job.hostShutdown, ['revoked', 'failed'])
    if (job.hostFailure !== undefined) {
      object(job.hostFailure, ['reason', 'repositoryUrl', 'created'], ['reason'])
      str(job.hostFailure.reason, 256)
      if (job.hostFailure.repositoryUrl !== undefined) safeUrl(job.hostFailure.repositoryUrl)
      if (job.hostFailure.created !== undefined) bool(job.hostFailure.created)
    }
    if (job.usage !== undefined && job.usage !== null) usageState(job.usage)
    if (job.providerRecord !== undefined && job.providerRecord !== null) {
      const p = job.providerRecord
      object(p, ['transportVersion', 'scopeHash', 'policyHash', 'epoch', 'recordHash', 'value', 'quarantine'],
        ['transportVersion', 'scopeHash', 'policyHash', 'epoch', 'recordHash', 'value'])
      str(p.transportVersion, 256); digest(p.scopeHash); digest(p.policyHash); digest(p.recordHash); int(p.epoch, 1)
      boundedJson(p.value, 524288)
      if (p.quarantine !== undefined && p.quarantine !== null) str(p.quarantine, 256)
      if (p.scopeHash !== job.scopeHash || p.policyHash !== job.policyHash ||
          p.epoch > data.epoch || p.recordHash !== hash(p.value)) fail('store_corrupt', 503)
      // Strict SDK-shape revalidation happens only in the opening transaction,
      // which quarantines unreadable records per job. Runtime writes are
      // pre-validated by the provider journal before they reach a transaction.
    }
    if (job.sectionMeta !== undefined) {
      const sections = ['mission', 'features', 'progress', 'workers', 'pending', 'settings', 'history', 'finalization']
      object(job.sectionMeta, sections, [])
      for (const m of Object.values(job.sectionMeta)) {
        object(m, ['source', 'observedAt', 'providerAt'])
        one(m.source, ['authoritative', 'notification']); time(m.observedAt)
        if (m.providerAt !== null) time(m.providerAt)
      }
    }
  }
  array(data.events, EVENT_WINDOW, event => {
    object(event, ['seq', 'missionId', 'ownerId', 'kind', 'at', 'data'])
    int(event.seq, 1); id(event.missionId); id(event.ownerId); str(event.kind, 128); time(event.at)
    boundedJson(event.data, 131072)
    if (event.ownerId !== ownerId || !data.jobs[event.missionId]) fail('store_corrupt', 503)
  })
  // A contiguous window ending exactly at seq; only the oldest prefix may be compacted.
  const firstSeq = data.seq - data.events.length + 1
  if (data.events.length > data.seq || (data.seq > 0 && !data.events.length) ||
      data.events.some((event, i) => event.seq !== firstSeq + i)) fail('store_corrupt', 503)
  return data
}
export const scopeOf = intent => {
  const { commandId: _, scopeApproved: __, highAutonomyApproved: ___, ...scope } = intent
  return scope
}
export const workspaceMatches = (w, b) => w.machineId === b.machineId && w.cwd === b.cwd &&
  w.repository === b.repository && w.baseRef === b.baseRef && (w.baseSha ?? null) === b.baseSha
export const attentionIdentity = a => ({
  requestId: a.requestId, sessionId: a.sessionId, machineId: a.machineId, kind: a.kind,
  toolUseIds: a.toolUseIds, title: a.title, details: a.details, options: a.options, questions: a.questions,
  payloadHash: a.payloadHash, revision: a.revision,
})

function boundedRead(path, max = MAX_BYTES) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) fail('store_corrupt', 503)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const actual = fstatSync(fd)
    if (!actual.isFile() || actual.size > max) fail('store_corrupt', 503)
    const bytes = Buffer.alloc(max + 1)
    let length = 0, read
    do {
      read = readSync(fd, bytes, length, bytes.length - length, null)
      length += read
      if (length > max) fail('store_corrupt', 503)
    } while (read)
    return bytes.subarray(0, length).toString('utf8')
  } finally { closeSync(fd) }
}
function durableWrite(path, bytes) {
  const fd = openSync(path, 'wx', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
}
function syncDirectory(dir) {
  const fd = openSync(dir, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** One host/process owns this store for its lifetime. No TTL-based lock stealing. */
export class FileStore {
  static open({ directory, ownerId, secrets = [] }) {
    id(ownerId)
    if (!isAbsolute(directory)) fail('absolute_store_required', 503)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) fail('unsafe_store_path', 503)
    const store = new FileStore(directory, ownerId, secrets)
    try {
      if (readdirSync(directory).includes('.recovery')) fail('writer_locked', 503)
      try { mkdirSync(store.lockDir, { mode: 0o700 }) } catch { fail('writer_locked', 503) }
      store.ownsLock = true
      durableWrite(store.lockPath, JSON.stringify(store.lock))
      syncDirectory(store.lockDir); syncDirectory(directory)
      if (readdirSync(directory).includes('.recovery')) fail('writer_locked', 503)
      const exists = readdirSync(directory).includes('ledger.json')
      if (!exists && readdirSync(directory).some(name => name === '.initialized' || name.startsWith('.commit-'))) fail('store_corrupt', 503)
      if (exists) {
        try {
          const envelope = JSON.parse(boundedRead(store.path))
          object(envelope, ['version', 'checksum', 'data']); one(envelope.version, [1]); digest(envelope.checksum)
          if (hash(envelope.data) !== envelope.checksum) fail('store_corrupt', 503)
          store.data = validateLedger(envelope.data, ownerId)
          secretFree(store.data, secrets)
        } catch (error) {
          if (error instanceof BrokerError && error.code === 'store_owner_mismatch') throw error
          fail('store_corrupt', 503)
        }
      }
      store.transaction(data => {
        data.epoch++
        for (const [missionId, job] of Object.entries(data.jobs)) {
          // Upgrade compatibility: a provider record written by an older build
          // may no longer pass strict revalidation (e.g. a stricter decoder).
          // Quarantine that job's record behind a hold instead of refusing the
          // whole store; other jobs open normally.
          const p = job.providerRecord
          if (p && !p.quarantine && p.transportVersion === SDK_TRANSPORT_VERSION) {
            try {
              validateProviderRecord(p.value, {
                ownerId, missionId, machineId: job.intent.workspace.machineId,
                scopeHash: job.scopeHash, policyHash: job.policyHash, epoch: data.epoch,
                ...(p.value?.binding && job.snapshot.binding ? { binding: job.snapshot.binding } : {}),
              })
            } catch {
              p.quarantine = 'sdk_provider_record_unreadable'
              job.snapshot.holdReason = 'sdk_provider_record_unreadable'
              if (!job.snapshot.binding) job.snapshot.state = 'held'
              store.event(data, job, 'provider_record_quarantined', { reason: 'sdk_provider_record_unreadable' })
            }
          }
          job.snapshot.completeness = ['projection_capacity_exceeded', 'sdk_provider_record_unreadable']
            .includes(job.snapshot.holdReason) ? 'gap' : 'unknown'
          job.reconciledEpoch = 0
          job.lastPendingAt = null
          job.pendingRequestIds = []
          for (const record of Object.values(job.records)) {
            if (record.receipt.state === 'invoked') {
              record.receipt.state = 'unknown'
              record.receipt.reason = 'restart_after_invocation'
              job.snapshot.holdReason = 'unknown_command_requires_reconciliation'
              if (record.request.answer) {
                const a = job.snapshot.attention.find(a => a.attentionId === record.request.answer.attentionId)
                if (a && a.state !== 'resolved') a.state = 'answer_unknown'
              }
              store.event(data, job, 'command_unknown', { commandId: record.receipt.commandId, reason: 'restart_after_invocation' })
            }
          }
          job.snapshot.commands = Object.values(job.records).map(record => clone(record.receipt))
        }
      }, { projectionHeadroom: true })
      if (!readdirSync(directory).includes('.initialized')) {
        durableWrite(join(directory, '.initialized'), '1\n'); syncDirectory(directory)
      }
      return store
    } catch (error) {
      store.close()
      if (error instanceof BrokerError) throw error
      throw new BrokerError('store_corrupt', 503)
    }
  }
  constructor(directory, ownerId, secrets) {
    this.directory = directory; this.ownerId = ownerId; this.secrets = secrets
    this.path = join(directory, 'ledger.json'); this.lockDir = join(directory, '.writer')
    this.lockPath = join(this.lockDir, 'owner.json')
    this.lock = { token: randomUUID(), pid: process.pid, host: hostname() }
    this.ownsLock = false; this.closed = false; this.poisoned = false
    this.data = { version: 1, ownerId, epoch: 0, seq: 0, jobs: {}, events: [] }
  }
  assertWriter(epoch = this.data.epoch) {
    if (this.closed || this.poisoned || !this.ownsLock || epoch !== this.data.epoch) fail('writer_fenced', 503)
    let lock
    try { lock = JSON.parse(boundedRead(this.lockPath, 4096)) } catch { fail('writer_fenced', 503) }
    if (hash(lock) !== hash(this.lock)) fail('writer_fenced', 503)
  }
  transaction(update, { projectionHeadroom = false } = {}) {
    this.assertWriter()
    const next = clone(this.data)
    const result = update(next)
    validateLedger(next, this.ownerId); secretFree(next, this.secrets)
    if (!projectionHeadroom) {
      for (const [missionId, job] of Object.entries(next.jobs)) {
        const nextBytes = Buffer.byteLength(readableSnapshot(job.snapshot))
        const prior = this.data.jobs[missionId]
        const priorBytes = prior ? Buffer.byteLength(readableSnapshot(prior.snapshot)) : 0
        // Existing emergency holds may use the reserve, but ordinary writes
        // cannot grow into it. Unchanged/shrinking jobs do not block other jobs.
        if (nextBytes > NATIVE_SNAPSHOT_ADMISSION_BYTES && nextBytes > priorBytes) fail('projection_capacity_exceeded', 503)
      }
    }
    const bytes = boundedJson({ version: 1, checksum: hash(next), data: next }, MAX_BYTES)
    const temp = join(this.directory, `.commit-${this.lock.token}-${randomUUID()}`)
    try {
      this.assertWriter()
      durableWrite(temp, bytes)
      this.assertWriter()
      renameSync(temp, this.path); syncDirectory(this.directory)
      this.data = next
      return result
    } catch {
      // Rename/fsync ambiguity poisons this writer; never execute after a failed commit.
      this.poisoned = true
      throw new BrokerError('store_write_uncertain', 503)
    }
  }
  event(data, job, kind, payload = {}) {
    // Compact the oldest audit events instead of refusing every later write.
    if (data.events.length >= EVENT_WINDOW) data.events.splice(0, data.events.length - EVENT_RETAIN)
    data.seq++
    job.snapshot.brokerSeq = data.seq
    data.events.push({ seq: data.seq, missionId: job.intent.missionId, ownerId: this.ownerId, kind, at: new Date().toISOString(), data: clone(payload) })
  }
  readEvents(ownerId, after = 0, limit = 100) {
    if (ownerId !== this.ownerId) fail('owner_forbidden', 403)
    int(after); int(limit, 1); if (limit > 200 || after > this.data.seq) fail('invalid_cursor', 400)
    return clone(this.data.events.filter(event => event.seq > after).slice(0, limit))
  }
  close() {
    if (this.closed) return
    this.closed = true
    if (!this.ownsLock) return
    try {
      if (hash(JSON.parse(boundedRead(this.lockPath, 4096))) !== hash(this.lock)) return
      unlinkSync(this.lockPath); rmdirSync(this.lockDir); syncDirectory(this.directory)
    } catch { /* A changed/damaged lock remains fenced for operator investigation. */ }
    this.ownsLock = false
  }
}

/** Local dead-process recovery only: the token must match the lock as read by the operator, or by
 * the broker's startup check (server.mjs recoverStaleWriterLock), and the recorded pid must be gone. */
export function recoverDeadWriter({ directory, expectedToken }) {
  if (!isAbsolute(directory) || realpathSync(directory) !== directory) fail('unsafe_store_path', 503)
  str(expectedToken, 64)
  const recovery = join(directory, '.recovery')
  try { mkdirSync(recovery, { mode: 0o700 }) } catch { fail('writer_locked', 503) }
  try {
    const lockPath = join(directory, '.writer', 'owner.json')
    const lock = JSON.parse(boundedRead(lockPath, 4096))
    object(lock, ['token', 'pid', 'host']); str(lock.token, 64); int(lock.pid, 1); str(lock.host, 256)
    if (lock.token !== expectedToken || lock.host !== hostname()) fail('writer_recovery_refused', 503)
    try { process.kill(lock.pid, 0); fail('writer_alive', 503) }
    catch (error) { if (error.code !== 'ESRCH') throw error }
    if (hash(JSON.parse(boundedRead(lockPath, 4096))) !== hash(lock)) fail('writer_recovery_refused', 503)
    unlinkSync(lockPath); rmdirSync(join(directory, '.writer')); syncDirectory(directory)
  } finally { rmdirSync(recovery); syncDirectory(directory) }
}
