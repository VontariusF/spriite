/**
 * Host contract validation and a final wire-send fence, NOT a host sandbox or
 * billing gateway. Production still requires independently qualified deployment
 * evidence and a boundary covering effects/inference of already-running workers.
 */
import { createPublicKey, KeyObject, verify, randomUUID, createHash } from 'node:crypto'
import { hash, canonical, fail, object, id, str, int, digest, array, unique, boundedJson } from './validation.mjs'
import {
  freezeNative, validateHostBinding, requireNativeBoundary, getNativeHashes,
  parseBudgetUnits, validateBudgetUnit, NATIVE_HOST_OPERATIONS, isCompiledNativePolicy, compileNativePolicy,
} from './native-policy.mjs'
import { isVerifiedWorkspaceProof } from './native-workspace.mjs'

export const NATIVE_EVIDENCE_MAX_BYTES = 1048576
export const NATIVE_LEASE_MAX_MS = 300000
export const NATIVE_PERMIT_MAX_MS = 5000
const authorities = new WeakSet()
const verifiedLeases = new WeakMap()

export function assertNativeFreshness(issuedAt, expiresAt, now = Date.now(), maxMs = NATIVE_LEASE_MAX_MS) {
  if (!Number.isSafeInteger(now) || typeof expiresAt !== 'string' || expiresAt.length > 40 ||
      (issuedAt !== null && (typeof issuedAt !== 'string' || issuedAt.length > 40))) fail('native_invalid_freshness')
  const expiry = Date.parse(expiresAt), issued = issuedAt === null ? now : Date.parse(issuedAt)
  if (!Number.isFinite(expiry) || !Number.isFinite(issued) || issued > now ||
      expiry <= now || expiry <= issued || expiry - issued > maxMs) fail('native_expired_evidence')
}

function bytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength > NATIVE_EVIDENCE_MAX_BYTES) fail('native_evidence_artifact_invalid')
  return Buffer.from(value)
}
function evidenceIds(value) {
  array(value, 16, id); unique(value)
  if (!value.length) fail('native_evidence_required')
}

/**
 * Only this signed/digest-verifying authority is accepted by validators. The
 * public key and ID-to-artifact ports must be pinned by the trusted deployment,
 * never supplied by HTTP clients. Signatures authenticate a qualified verifier;
 * they do not turn synthetic tests or signed prose into production qualification.
 */
export function createNativeEvidenceAuthority({ publicKey, readEvidence, readArtifact, now = Date.now }) {
  let key
  try { key = publicKey instanceof KeyObject ? publicKey : createPublicKey(publicKey) }
  catch { return fail('native_evidence_key_invalid', 503) }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519' ||
      typeof readEvidence !== 'function' || typeof readArtifact !== 'function') fail('native_evidence_authority_invalid', 503)
  const authority = Object.freeze({
    verify(ids, expected) {
      evidenceIds(ids)
      const seenDimensions = new Set()
      for (const evidenceId of ids) {
        const envelope = readEvidence(evidenceId)
        boundedJson(envelope, 65536)
        object(envelope, ['manifest', 'signature'])
        const m = envelope.manifest
        object(m, ['version', 'evidenceId', 'kind', 'subjectHash', 'binding', 'nonce',
          'deploymentDigest', 'issuedAt', 'expiresAt', 'artifacts'])
        if (m.version !== 1 || m.evidenceId !== evidenceId || m.kind !== expected.kind ||
            m.subjectHash !== expected.subjectHash || m.nonce !== expected.nonce ||
            m.deploymentDigest !== expected.deploymentDigest) fail('native_evidence_subject_mismatch')
        digest(m.subjectHash); digest(m.deploymentDigest); id(m.nonce)
        validateHostBinding(m.binding, expected.binding)
        assertNativeFreshness(m.issuedAt, m.expiresAt, expected.now ?? now())
        if (typeof envelope.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature) ||
            !verify(null, Buffer.from(canonical(m)), key, Buffer.from(envelope.signature, 'base64'))) fail('native_evidence_signature_invalid')
        array(m.artifacts, 16, artifact => {
          object(artifact, ['id', 'dimension', 'sha256'])
          id(artifact.id); id(artifact.dimension); digest(artifact.sha256)
          const content = bytes(readArtifact(artifact.id))
          if (createHash('sha256').update(content).digest('hex') !== artifact.sha256) fail('native_evidence_digest_mismatch')
          seenDimensions.add(artifact.dimension)
        })
        if (!m.artifacts.length) fail('native_evidence_artifact_required')
        unique(m.artifacts.map(row => row.id))
      }
      if (expected.dimensions.some(dimension => !seenDimensions.has(dimension))) fail('native_boundary_coverage_missing')
    },
  })
  authorities.add(authority)
  return authority
}

export function verifyNativeEvidence(authority, ids, expected) {
  if (!authorities.has(authority)) fail('native_verified_evidence_authority_required', 503)
  authority.verify(ids, expected)
}

export function validateEnforcementLease(lease, {
  intent, binding, workspaceProof, compiledPolicy, deployment, nonce, evidenceAuthority, now = Date.now(),
}) {
  boundedJson(lease, 65536)
  object(lease, ['leaseId', 'binding', 'workspaceAttestationId', 'deploymentDigest',
    'boundaryPolicyHash', 'revocationGeneration', 'expiresAt', 'budget', 'evidenceIds'])
  requireNativeBoundary(deployment.boundary)
  if (!isCompiledNativePolicy(compiledPolicy)) fail('native_compiled_policy_required')
  if (!isVerifiedWorkspaceProof(workspaceProof)) fail('native_verified_workspace_proof_required')
  validateHostBinding(lease.binding, binding)
  validateHostBinding(workspaceProof.binding, binding)
  id(lease.leaseId); id(lease.workspaceAttestationId); id(nonce)
  int(lease.revocationGeneration, 0)
  digest(lease.deploymentDigest); digest(lease.boundaryPolicyHash)
  if (lease.workspaceAttestationId !== workspaceProof.attestationId ||
      lease.deploymentDigest !== deployment.deploymentDigest ||
      lease.boundaryPolicyHash !== compiledPolicy.compiledPolicyHash ||
      compiledPolicy.scopeHash !== binding.scopeHash || compiledPolicy.policyHash !== binding.policyHash) fail('native_lease_binding_mismatch')
  const intentHashes = getNativeHashes(intent)
  if (intentHashes.scopeHash !== binding.scopeHash || intentHashes.policyHash !== binding.policyHash) fail('native_lease_binding_mismatch')
  if (compileNativePolicy(intent, deployment).compiledPolicyHash !== compiledPolicy.compiledPolicyHash) fail('native_lease_deployment_policy_changed')
  assertNativeFreshness(null, lease.expiresAt, now)
  if (Date.parse(lease.expiresAt) > Date.parse(workspaceProof.expiresAt)) fail('native_lease_outlives_workspace_proof')
  if (compiledPolicy.budgetEnforcement === 'none') {
    // No budget was requested: the lease must say so rather than imply a cap.
    object(lease.budget, ['enforcement'])
    if (lease.budget.enforcement !== 'none' || intent.policy.budget !== undefined) fail('native_lease_budget_mismatch')
  } else {
    object(lease.budget, ['accountId', 'unit', 'capUnits', 'enforcementId'])
    id(lease.budget.accountId); id(lease.budget.enforcementId); validateBudgetUnit(lease.budget.unit)
    if (lease.budget.unit !== deployment.budgetUnit || lease.budget.unit !== intent.policy.budget?.unit ||
        lease.budget.capUnits !== intent.policy.budget?.capUnits ||
        parseBudgetUnits(lease.budget.capUnits) > parseBudgetUnits(deployment.maxBudgetUnits)) fail('native_lease_budget_mismatch')
  }
  evidenceIds(lease.evidenceIds)
  verifyNativeEvidence(evidenceAuthority, lease.evidenceIds, {
    kind: 'lease', subjectHash: hash(lease), binding, nonce,
    deploymentDigest: deployment.deploymentDigest,
    dimensions: compiledPolicy.requiredBoundaryDimensions, now,
  })
  const result = freezeNative(structuredClone(lease))
  verifiedLeases.set(result, workspaceProof)
  return result
}

export function validateSendPermit(permit, {
  lease, binding, connectionId, operation, sessionId, requestHash, revocationGeneration,
  now = Date.now(),
}) {
  boundedJson(permit, 16384)
  object(permit, ['permitId', 'leaseId', 'connectionId', 'operation', 'sessionId',
    'requestHash', 'expiresAt', 'revocationGeneration'])
  if (!verifiedLeases.has(lease)) fail('native_verified_lease_required')
  validateHostBinding(lease.binding, binding)
  assertNativeFreshness(null, lease.expiresAt, now)
  id(permit.permitId); str(permit.connectionId, 256); id(permit.sessionId); digest(permit.requestHash)
  int(permit.revocationGeneration, 0)
  if (!NATIVE_HOST_OPERATIONS.includes(operation) || permit.operation !== operation ||
      permit.leaseId !== lease.leaseId || permit.connectionId !== connectionId ||
      permit.sessionId !== sessionId || permit.requestHash !== requestHash ||
      permit.revocationGeneration !== revocationGeneration ||
      revocationGeneration !== lease.revocationGeneration) fail('native_send_permit_mismatch')
  assertNativeFreshness(null, permit.expiresAt, now, NATIVE_PERMIT_MAX_MS)
  if (Date.parse(permit.expiresAt) > Date.parse(lease.expiresAt)) fail('native_permit_outlives_lease')
  return freezeNative(structuredClone(permit))
}

const MUTATIONS = new Map([
  ['daemon.initialize_session', 'initialize'],
  ['daemon.add_user_message', 'owner_turn'],
])
export const NATIVE_READ_ONLY_METHODS = Object.freeze([
  'daemon.get_default_settings', 'daemon.list_models',
  'daemon.inspect_mission_readiness', 'daemon.list_opened_sessions',
  'daemon.get_session_messages',
])

function frameObject(frame) {
  if (typeof frame === 'string') {
    if (Buffer.byteLength(frame) > 262144) fail('native_wire_frame_too_large')
    try { frame = JSON.parse(frame) } catch { return fail('native_invalid_wire_frame') }
  }
  boundedJson(frame, 262144)
  if (frame?.jsonrpc !== '2.0' || typeof frame.id !== 'string') fail('native_invalid_wire_frame')
  str(frame.id, 160)
  return frame
}

/** Hash semantic requests (SDK-generated RPC id omitted), exact response ids
 * retained. Tokens remain only in the authenticated transport, never in hashes. */
export function nativeFrameRequestHash(input) {
  const frame = frameObject(input)
  if (frame.method !== undefined) {
    object(frame, ['jsonrpc', 'id', 'method', 'params'])
    str(frame.method, 128)
    const params = structuredClone(frame.params)
    if (!params || typeof params !== 'object' || Array.isArray(params)) fail('native_invalid_wire_frame')
    delete params.token
    return hash({ method: frame.method, params })
  }
  object(frame, ['jsonrpc', 'id', 'result'])
  return hash({ id: frame.id, result: frame.result })
}

function classifyMutation(frame) {
  if (frame.method !== undefined) {
    object(frame, ['jsonrpc', 'id', 'method', 'params'])
    const operation = MUTATIONS.get(frame.method)
    if (!operation) fail('native_sdk_mutation_unavailable')
    id(frame.params?.sessionId)
    return { operation, sessionId: frame.params.sessionId }
  }
  object(frame, ['jsonrpc', 'id', 'result'])
  id(frame.result?.sessionId)
  const r = frame.result
  if (typeof r.selectedOption === 'string') {
    object(r, ['sessionId', 'selectedOption'], ['sessionId', 'selectedOption'])
    if (!['proceed_once', 'cancel'].includes(r.selectedOption)) fail('native_permission_escalation_unavailable')
    return { operation: 'permission_response', sessionId: r.sessionId }
  }
  object(r, ['sessionId', 'answers', 'cancelled'], ['sessionId'])
  if (r.cancelled !== undefined && typeof r.cancelled !== 'boolean') fail('native_invalid_wire_frame')
  if (r.answers !== undefined) array(r.answers, 128, answer => {
    object(answer, ['index', 'question', 'answer'])
    int(answer.index); str(answer.question, 8192); str(answer.answer, 8192, true)
  })
  if (r.answers === undefined && r.cancelled !== true) fail('native_invalid_wire_frame')
  return { operation: 'ask_user_response', sessionId: r.sessionId }
}

function assertMutationProjection(frame, state, operation) {
  const p = frame.params
  if (operation === 'initialize') {
    const initialize = state.compiledPolicy.initialize
    const keys = ['token', 'machineId', 'cwd', 'sessionId', ...Object.keys(initialize)]
    object(p, keys, keys.filter(key => key !== 'token'))
    if (p.token !== undefined) str(p.token, 8192)
    if (p.machineId !== state.binding.machineId || p.cwd !== state.workspaceProof.canonicalCwd ||
        hash(Object.fromEntries(Object.keys(initialize).map(key => [key, p[key]]))) !== hash(initialize)) fail('native_initialize_projection_mismatch')
  } else if (operation === 'owner_turn') {
    object(p, ['sessionId', 'text', 'messageId'], ['sessionId', 'text'])
    str(p.text, 32768)
    if (p.messageId !== undefined) id(p.messageId)
  }
}

function assertReadOnly(frame, state) {
  object(frame, ['jsonrpc', 'id', 'method', 'params'])
  if (!NATIVE_READ_ONLY_METHODS.includes(frame.method)) return false
  const p = frame.params
  if (['daemon.get_default_settings', 'daemon.list_models', 'daemon.list_opened_sessions'].includes(frame.method)) object(p, [])
  else if (frame.method === 'daemon.inspect_mission_readiness') {
    object(p, ['cwd'])
    if (p.cwd !== state.workspaceProof.canonicalCwd) fail('native_read_wrong_workspace')
  } else {
    object(p, ['sessionId', 'limit', 'cursor'], ['sessionId'])
    id(p.sessionId)
    if (!state.sessionIds.includes(p.sessionId)) fail('native_read_wrong_session')
    if (p.limit !== undefined && (!Number.isSafeInteger(p.limit) || p.limit < 1 || p.limit > 200)) fail('native_read_limit')
    if (p.cursor !== undefined) str(p.cursor, 256)
  }
  return true
}

/**
 * Install around the actual transport supplied to DaemonClient. Host must
 * provide an already-authenticated transport; authentication is not an escape
 * hatch here. No buffering/replay. Authorization alone never sends a frame.
 */
export function createGuardedTransport({ transport, boundary, getState, now = Date.now }) {
  requireNativeBoundary(boundary)
  if (!transport || typeof transport.send !== 'function' || typeof getState !== 'function') fail('native_transport_unavailable')
  const pending = new Map(), seenPermits = new Set()
  const authorizing = new Set()
  let closed = false, invalidationGeneration = 0
  function stateForWrite() {
    if (closed || !transport.isConnected()) fail('native_transport_disconnected')
    const state = getState()
    if (!state || typeof state.guard !== 'function' || !verifiedLeases.has(state.lease) ||
        !isVerifiedWorkspaceProof(state.workspaceProof) ||
        verifiedLeases.get(state.lease) !== state.workspaceProof ||
        !isCompiledNativePolicy(state.compiledPolicy)) fail('native_verified_lease_required')
    state.guard()
    validateHostBinding(state.lease.binding, state.binding)
    validateHostBinding(state.workspaceProof.binding, state.binding)
    if (state.compiledPolicy.scopeHash !== state.binding.scopeHash ||
        state.compiledPolicy.policyHash !== state.binding.policyHash ||
        state.lease.boundaryPolicyHash !== state.compiledPolicy.compiledPolicyHash ||
        state.lease.workspaceAttestationId !== state.workspaceProof.attestationId ||
        state.revocationGeneration !== state.lease.revocationGeneration) fail('native_live_policy_changed')
    const hashes = getNativeHashes(state.intent)
    if (hashes.scopeHash !== state.binding.scopeHash || hashes.policyHash !== state.binding.policyHash) fail('native_live_policy_changed')
    assertNativeFreshness(null, state.lease.expiresAt, now())
    assertNativeFreshness(state.workspaceProof.observedAt, state.workspaceProof.expiresAt, now())
    return state
  }
  const wrapped = {
    send(data) {
      if (typeof data !== 'string') fail('native_invalid_wire_frame')
      const frame = frameObject(data)
      const sendGeneration = invalidationGeneration
      if (closed || !transport.isConnected()) fail('native_transport_disconnected')
      const readState = getState()
      if (frame.method !== undefined && assertReadOnly(frame, readState)) {
        // Reads do not acquire execution authority and remain available after
        // revocation, provided the owning adapter still establishes scope.
        if (typeof readState.readGuard !== 'function') fail('native_read_guard_required')
        readState.readGuard()
        return transport.send(data)
      }
      const state = stateForWrite()
      const leaseAtSend = state.lease, bindingHashAtSend = hash(state.binding)
      const { operation, sessionId } = classifyMutation(frame)
      if (!state.sessionIds.includes(sessionId)) fail('native_send_wrong_session')
      assertMutationProjection(frame, state, operation)
      const requestHash = nativeFrameRequestHash(frame)
      const key = `${operation}:${sessionId}:${requestHash}`
      const permit = pending.get(key)
      if (!permit) fail('native_send_permit_required')
      // Remove before calling external code. Throwing/ambiguous sends are never
      // replayable; the broker retains the invoked/unknown outcome.
      pending.delete(key)
      validateSendPermit(permit, {
        lease: state.lease, binding: state.binding, connectionId: transport.getConnectionId(),
        operation, sessionId, requestHash, revocationGeneration: state.revocationGeneration, now: now(),
      })
      state.guard()
      const latest = stateForWrite()
      if (latest.lease !== leaseAtSend || hash(latest.binding) !== bindingHashAtSend ||
          latest.revocationGeneration !== permit.revocationGeneration) fail('native_live_policy_changed')
      boundary.assertAndConsumePermit(permit)
      // The host synchronously consumes/rechecks ongoing revocation authority.
      const final = stateForWrite()
      if (sendGeneration !== invalidationGeneration || final.lease !== leaseAtSend || transport.getConnectionId() !== permit.connectionId ||
          hash(final.binding) !== bindingHashAtSend) fail('native_live_policy_changed')
      if (!final.sessionIds.includes(sessionId)) fail('native_send_wrong_session')
      assertMutationProjection(frame, final, operation)
      validateSendPermit(permit, {
        lease: final.lease, binding: final.binding, connectionId: transport.getConnectionId(),
        operation, sessionId, requestHash, revocationGeneration: final.revocationGeneration, now: now(),
      })
      transport.send(data)
    },
  }
  for (const method of ['connect', 'isConnected', 'getConnectionId', 'isRelayConnection', 'getTransportKind', 'on', 'off']) {
    if (typeof transport[method] === 'function') wrapped[method] = transport[method].bind(transport)
  }
  wrapped.disconnect = () => {
    closed = true
    invalidationGeneration++
    pending.clear()
    transport.disconnect()
  }
  return Object.freeze({
    transport: Object.freeze(wrapped),
    async authorizeSend({ operation, sessionId, requestHash }) {
      if (!NATIVE_HOST_OPERATIONS.includes(operation)) fail('native_sdk_mutation_unavailable')
      id(sessionId); digest(requestHash)
      const state = stateForWrite()
      if (!state.sessionIds.includes(sessionId)) fail('native_send_wrong_session')
      if (pending.size + authorizing.size >= 8 || seenPermits.size >= 4096) fail('native_send_capacity_exceeded')
      const connectionId = transport.getConnectionId()
      str(connectionId, 256)
      const key = `${operation}:${sessionId}:${requestHash}`
      if (pending.has(key) || authorizing.has(key)) fail('native_send_permit_reused')
      const generation = invalidationGeneration, originalBindingHash = hash(state.binding), originalLease = state.lease
      authorizing.add(key)
      try {
        const permit = await boundary.authorizeSend({
          ...state.binding, leaseId: state.lease.leaseId, connectionId,
          operation, sessionId, requestHash, nonce: randomUUID(),
        })
        const current = stateForWrite()
        if (generation !== invalidationGeneration || current.lease !== originalLease ||
            hash(current.binding) !== originalBindingHash ||
            transport.getConnectionId() !== connectionId) fail('native_authorization_changed')
        const validated = validateSendPermit(permit, {
          lease: current.lease, binding: current.binding, connectionId,
          operation, sessionId, requestHash, revocationGeneration: current.revocationGeneration, now: now(),
        })
        if (pending.has(key) || seenPermits.has(validated.permitId) || pending.size >= 8 ||
            seenPermits.size >= 4096) fail('native_send_permit_reused')
        seenPermits.add(validated.permitId)
        pending.set(key, validated)
        return validated
      } finally { authorizing.delete(key) }
    },
    invalidate() { invalidationGeneration++; pending.clear() },
    get pendingPermitCount() { return pending.size },
  })
}

/** Pure single-process arithmetic only. Not a Factory billing integration. */
export function createBudgetReservationBook({ unit, capUnits }) {
  validateBudgetUnit(unit)
  const cap = parseBudgetUnits(capUnits), reservations = new Map()
  let settled = 0n, reserved = 0n
  return Object.freeze({
    reserve(reservationId, maximumChargeUnits) {
      id(reservationId)
      // Unknown pricing/maximum output liability cannot be reserved.
      const amount = parseBudgetUnits(maximumChargeUnits)
      if (reservations.has(reservationId) || reservations.size >= 1024) fail('native_budget_reservation_conflict')
      if (settled + reserved + amount > cap) fail('native_budget_exhausted')
      reservations.set(reservationId, { amount, sent: false })
      reserved += amount
    },
    markSent(reservationId) {
      const row = reservations.get(reservationId)
      if (!row || row.sent) fail('native_budget_reservation_conflict')
      row.sent = true
    },
    releaseUnsent(reservationId) {
      const row = reservations.get(reservationId)
      if (!row || row.sent) fail('native_budget_unknown_charge')
      reserved -= row.amount; reservations.delete(reservationId)
    },
    settle(reservationId, actualChargeUnits) {
      const row = reservations.get(reservationId)
      const actual = parseBudgetUnits(actualChargeUnits, { allowZero: true })
      if (!row || !row.sent || actual > row.amount) fail('native_budget_reservation_exceeded')
      reserved -= row.amount; settled += actual; reservations.delete(reservationId)
    },
    snapshot() {
      return Object.freeze({
        unit, capUnits, settledUnits: String(settled), reservedUnits: String(reserved),
        remainingUnits: String(cap - settled - reserved), reservationCount: reservations.size,
      })
    },
  })
}
