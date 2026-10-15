/**
 * Entirely offline. Synthetic in-memory signed fixtures and injected Git/fs/
 * transport ports are NOT production qualification. No SDK import, subprocess,
 * real checkout inspection, credential access, or filesystem writes.
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { hash, canonical, BrokerError } from '../broker/validation.mjs'
import { scopeOf } from '../broker/store.mjs'
import {
  compileNativePolicy, getNativeHashes, validateGitSha, validateFullGitRef,
  parseBudgetUnits, NATIVE_UNSUPPORTED_CONTROLS, NATIVE_MISSION_V2_AGENTS_TOOLS, NATIVE_MISSION_V2_INITIALIZE_TAGS,
  requireMissionV2Tools,
} from '../broker/native-policy.mjs'
import {
  createNativeEvidenceAuthority, validateEnforcementLease, validateSendPermit,
  createGuardedTransport, nativeFrameRequestHash, createBudgetReservationBook,
} from '../broker/native-boundary.mjs'
import {
  validateWorkspaceProof, createReadOnlyWorkspaceVerifier, buildNativeGitArgs,
  createProductionGitRunner, NATIVE_GIT_MAX_BYTES,
} from '../broker/native-workspace.mjs'

const clone = value => structuredClone(value)
const SHA = 'a'.repeat(40), NEXT_SHA = 'b'.repeat(40), DIGEST = 'd'.repeat(64)
const BASE_TIME = Date.parse('2026-10-12T12:00:00.000Z')
let assertions = 0
function check(fn, code) {
  assertions++
  assert.throws(fn, error => error instanceof BrokerError && (!code || error.code === code))
}
async function rejects(fn, code) {
  assertions++
  await assert.rejects(fn, error => code ? error.code === code : !!error)
}
const tests = []
function test(name, fn) { tests.push({ name, fn }) }

function fixture() {
  let clock = BASE_TIME, permitCounter = 0, revoked = false
  const consumed = new Set(), sent = [], envelopes = new Map(), artifacts = new Map()
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const boundary = {
    async verifyWorkspace() { throw new Error('offline_fixture_only') },
    async acquireLease() { throw new Error('offline_fixture_only') },
    async authorizeSend(input) {
      return {
        permitId: `permit-${++permitCounter}`, leaseId: input.leaseId,
        connectionId: input.connectionId, operation: input.operation,
        sessionId: input.sessionId, requestHash: input.requestHash,
        expiresAt: new Date(clock + 1000).toISOString(), revocationGeneration: 0,
      }
    },
    assertAndConsumePermit(permit) {
      if (revoked || consumed.has(permit.permitId)) throw new BrokerError('fixture_host_revoked')
      consumed.add(permit.permitId)
    },
    async revoke() { revoked = true; return { receiptId: 'revoked', revocationGeneration: 1, evidenceIds: [] } },
  }
  const intent = {
    protocolVersion: 1, missionId: 'mission-one', ownerId: 'owner-one', commandId: 'command-one',
    goal: 'Implement the exact approved local feature.', scopeRevision: 1, operation: 'implement',
    workspace: { machineId: 'machine-one', cwd: '/fixtures/repo', repository: 'immutable-repo-123',
      baseRef: 'refs/heads/main', baseSha: SHA },
    references: [], acceptanceCriteria: ['Offline synthetic fixture only.'],
    restrictions: ['No push', 'No deploy'],
    policy: {
      autonomy: 'high', allowCreateRepository: false, allowPush: false, allowPr: false,
      allowMerge: false, allowDeploy: false, budget: { unit: 'testUnits', capUnits: '100' },
    },
    scopeApproved: true, highAutonomyApproved: true,
    settings: {
      modelId: 'orchestrator', reasoningEffort: 'high',
      workerModel: 'worker', workerReasoningEffort: 'medium',
      validationWorkerModel: 'validator', validationWorkerReasoningEffort: 'high',
      restrictToolIds: ['Read', 'Edit', 'Execute'], skipScrutiny: false, skipUserTesting: false,
    },
  }
  const deployment = {
    ownerId: intent.ownerId, machineId: intent.workspace.machineId, deploymentDigest: DIGEST,
    allowedModelIds: ['orchestrator', 'worker', 'validator'], allowedToolIds: ['Read', 'Edit', 'Execute'],
    budgetUnit: 'testUnits', maxBudgetUnits: '200', boundary,
  }
  const compiledPolicy = compileNativePolicy(intent, deployment)
  const binding = { ownerId: intent.ownerId, missionId: intent.missionId,
    machineId: intent.workspace.machineId, ...getNativeHashes(intent), epoch: 1 }
  const host = {
    executionMachineId: 'machine-one', localMachineId: 'machine-one',
    executionHostId: 'host-one', executionInstanceId: 'instance-one',
    checkoutGeneration: 'checkout-one', repositoryId: intent.workspace.repository,
    deploymentDigest: DIGEST, permittedRoots: ['/fixtures'], executionRef: 'refs/heads/job',
  }
  function attest(evidenceId, kind, subject, dimensions, nonce) {
    const manifest = {
      version: 1, evidenceId, kind, subjectHash: hash(subject), binding: clone(binding),
      nonce, deploymentDigest: DIGEST,
      issuedAt: new Date(clock - 100).toISOString(), expiresAt: new Date(clock + 60000).toISOString(),
      artifacts: dimensions.map((dimension, index) => {
        const id = `${evidenceId}-artifact-${index}`
        const content = Buffer.from(JSON.stringify({ fixture: true, dimension }))
        artifacts.set(id, content)
        return { id, dimension, sha256: createHash('sha256').update(content).digest('hex') }
      }),
    }
    envelopes.set(evidenceId, { manifest, signature: sign(null, Buffer.from(canonical(manifest)), privateKey).toString('base64') })
  }
  const evidenceAuthority = createNativeEvidenceAuthority({
    publicKey, readEvidence: evidenceId => clone(envelopes.get(evidenceId)),
    readArtifact: artifactId => artifacts.get(artifactId), now: () => clock,
  })
  const rawProof = {
    attestationId: 'workspace-proof-one', nonce: 'workspace-nonce-one', binding: clone(binding),
    executionHostId: host.executionHostId, executionInstanceId: host.executionInstanceId,
    canonicalCwd: intent.workspace.cwd, canonicalRepoRoot: intent.workspace.cwd,
    canonicalGitDir: `${intent.workspace.cwd}/.git`, canonicalCommonDir: `${intent.workspace.cwd}/.git`,
    rootIdentity: { device: '1', inode: '10' }, gitDirIdentity: { device: '1', inode: '11' },
    repositoryId: host.repositoryId, objectFormat: 'sha1',
    baseRef: intent.workspace.baseRef, baseSha: SHA, initialHeadSha: SHA, executionRef: host.executionRef,
    checkoutGeneration: host.checkoutGeneration,
    observedAt: new Date(clock - 100).toISOString(), expiresAt: new Date(clock + 60000).toISOString(),
    evidenceIds: ['workspace-evidence'],
  }
  const proofOptions = { host, nonce: rawProof.nonce, evidenceAuthority, now: clock }
  attest('workspace-evidence', 'workspace', rawProof, ['physical_workspace', 'destination_identity'], rawProof.nonce)
  const workspaceProof = validateWorkspaceProof(rawProof, intent, binding, proofOptions)
  const rawLease = {
    leaseId: 'lease-one', binding: clone(binding), workspaceAttestationId: workspaceProof.attestationId,
    deploymentDigest: DIGEST, boundaryPolicyHash: compiledPolicy.compiledPolicyHash,
    revocationGeneration: 0, expiresAt: new Date(clock + 40000).toISOString(),
    budget: { accountId: 'account-one', unit: 'testUnits', capUnits: '100', enforcementId: 'enforcer-one' },
    evidenceIds: ['lease-evidence'],
  }
  const leaseOptions = { intent, binding, workspaceProof, compiledPolicy, deployment,
    nonce: 'lease-nonce-one', evidenceAuthority, now: clock }
  attest('lease-evidence', 'lease', rawLease, compiledPolicy.requiredBoundaryDimensions, leaseOptions.nonce)
  const lease = validateEnforcementLease(rawLease, leaseOptions)
  const state = {
    intent, binding, workspaceProof, compiledPolicy, lease, revocationGeneration: 0,
    sessionIds: ['session-root', 'worker-one'],
    guard() { if (revoked) throw new BrokerError('fixture_execution_stopped') },
    readGuard() {},
  }
  let connectionId = 'connection-one', connected = true
  const transport = {
    send: data => sent.push(JSON.parse(data)), disconnect() { connected = false },
    isConnected: () => connected, getConnectionId: () => connectionId,
    getTransportKind: () => 'ipc', isRelayConnection: () => false, on() {}, off() {},
  }
  const guarded = createGuardedTransport({ transport, boundary, getState: () => state, now: () => clock })
  const initializeFrame = {
    jsonrpc: '2.0', id: 'sdk-init-id', method: 'daemon.initialize_session',
    params: { token: 'synthetic-not-a-credential', machineId: binding.machineId,
      cwd: intent.workspace.cwd, sessionId: 'session-root', ...clone(compiledPolicy.initialize) },
  }
  const turnFrame = {
    jsonrpc: '2.0', id: 'sdk-turn-id', method: 'daemon.add_user_message',
    params: { sessionId: 'session-root', text: intent.goal, messageId: 'owner-message-one' },
  }
  const authorize = (frame, operation = 'owner_turn') => guarded.authorizeSend({
    operation, sessionId: frame.params?.sessionId ?? frame.result.sessionId,
    requestHash: nativeFrameRequestHash(frame),
  })
  return {
    intent, deployment, binding, compiledPolicy, host, boundary, evidenceAuthority, attest,
    rawProof, workspaceProof, proofOptions, rawLease, lease, leaseOptions, state, guarded,
    initializeFrame, turnFrame, authorize, sent, consumed, envelopes, artifacts, publicKey,
    now: () => clock, advance: ms => { clock += ms }, revoke: () => { revoked = true },
    reconnect: () => { connectionId = 'connection-two' },
  }
}

function fakeWorkspacePorts(f) {
  const values = { head: SHA, base: SHA, objectFormat: 'sha1', dirty: '', ancestor: true,
    root: '/fixtures/repo', gitDir: '/fixtures/repo/.git', commonDir: '/fixtures/repo/.git' }
  const queries = []
  const fs = {
    async realpath(path) { return path },
    async identity(path) { return { device: '1', inode: path.endsWith('/.git') ? '11' : '10' } },
  }
  const git = async input => {
    assert.deepEqual(input.args, buildNativeGitArgs(input.query, input.cwd))
    queries.push(input.query.kind)
    const output = {
      root: values.root, git_dir: values.gitDir, common_dir: values.commonDir,
      object_format: values.objectFormat, base_sha: values.base, base_object: SHA,
      head_sha: values.head, execution_ref: f.host.executionRef,
      dirty: values.dirty, ancestor: '',
    }[input.query.kind]
    return { stdout: Buffer.from(input.query.kind === 'dirty' ? output : `${output}\n`),
      exitCode: input.query.kind === 'ancestor' && !values.ancestor ? 1 : 0 }
  }
  const ports = { fs, git, values, queries, verifier: () => createReadOnlyWorkspaceVerifier({
    host: f.host, fs: ports.fs, git: ports.git, now: f.now,
  }) }
  return ports
}

test('Compiler projects exact native fields and preserves old hashes/lossless input', () => {
  const f = fixture(), before = clone(f.intent)
  assert.deepEqual(f.intent, before)
  assert.deepEqual(f.compiledPolicy.settings, f.intent.settings)
  assert.equal(f.compiledPolicy.initialize.workerModel, undefined)
  assert.equal(f.compiledPolicy.initialize.missionSettings.workerModel, 'worker')
  assert.equal(f.compiledPolicy.initialize.missionSettings.validationWorkerModel, 'validator')
  assert.equal(f.compiledPolicy.initialize.autoRejectPermissionRequests, false)
  assert.equal(f.compiledPolicy.scopeHash, hash(scopeOf(f.intent)))
  assert.equal(f.compiledPolicy.policyHash, hash({ policy: f.intent.policy, settings: f.intent.settings }))
  const old = clone(f.intent); delete old.policy.budget
  assert.deepEqual(getNativeHashes(old), { scopeHash: hash(scopeOf(old)), policyHash: hash({ policy: old.policy, settings: old.settings }) })
  const unbudgeted = compileNativePolicy(old, f.deployment)
  assert.equal(unbudgeted.budgetEnforcement, 'none')
  assert(unbudgeted.requiredBoundaryDimensions.includes('usage_reporting'))
  assert(!unbudgeted.requiredBoundaryDimensions.includes('atomic_budget_reservation'))
  assert(!unbudgeted.requiredBoundaryDimensions.includes('complete_inference_billing'))
  assert.equal(f.compiledPolicy.budgetEnforcement, 'reserved')
  assert(f.compiledPolicy.requiredBoundaryDimensions.includes('atomic_budget_reservation'))
  const { budgetUnit: _, maxBudgetUnits: __, ...noBudgetDeployment } = f.deployment
  assert.equal(compileNativePolicy(old, noBudgetDeployment).budgetEnforcement, 'none')
  check(() => compileNativePolicy(f.intent, noBudgetDeployment), 'native_budget_exceeds_deployment')
  assert(Object.isFrozen(f.compiledPolicy.initialize.missionSettings))
  assert.deepEqual(NATIVE_UNSUPPORTED_CONTROLS, { pause: false, resume: false, cancel: false })
})

test('Compiler sends the bare Missions 2.0 entry tag; the projection guard binds it exactly', async () => {
  const f = fixture()
  assert.deepEqual(f.compiledPolicy.initialize.tags, [{ name: 'mission-v2' }])
  assert(Object.isFrozen(f.compiledPolicy.initialize.tags) && Object.isFrozen(f.compiledPolicy.initialize.tags[0]))
  assert.deepEqual(NATIVE_MISSION_V2_INITIALIZE_TAGS, [{ name: 'mission-v2' }])
  // The compiled policy hash covers the tag: a different tag set is a different compiled policy.
  assert.equal(typeof f.compiledPolicy.compiledPolicyHash, 'string')
  for (const tags of [undefined, [], [{ name: 'mission-v2', metadata: { kind: 'orchestrator', missionId: 'session-root' } }], [{ name: 'other' }]]) {
    const frame = clone(f.initializeFrame)
    if (tags === undefined) delete frame.params.tags; else frame.params.tags = tags
    await f.authorize(frame, 'initialize')
    // A missing tag key is refused as a missing field; any other tag set as a projection mismatch.
    check(() => f.guarded.transport.send(JSON.stringify(frame)), tags === undefined ? 'invalid_fields' : 'native_initialize_projection_mismatch')
  }
  assert.equal(f.sent.length, 0)
  // Tool fence: the 0.238 agents tools or the 0.227 planning tools, never a partial set.
  assert.deepEqual([...NATIVE_MISSION_V2_AGENTS_TOOLS], ['SpawnAgent', 'SendMessage', 'ListAgents', 'InterruptAgent'])
  assert.deepEqual(requireMissionV2Tools(['Read', ...NATIVE_MISSION_V2_AGENTS_TOOLS]), ['Read', ...NATIVE_MISSION_V2_AGENTS_TOOLS])
  check(() => requireMissionV2Tools(['Read', 'SpawnAgent', 'ListAgents']), 'native_mission_v2_tools_missing')
  check(() => requireMissionV2Tools(['RecommendMission', 'ExitMissionPlanning', 'Task']), 'native_mission_v2_tools_missing')
})

test('Compiler requires explicit efforts/models/validation/tool fences', () => {
  const f = fixture()
  for (const key of Object.keys(f.intent.settings)) {
    const input = clone(f.intent); delete input.settings[key]
    check(() => compileNativePolicy(input, f.deployment))
  }
  for (const key of ['skipScrutiny', 'skipUserTesting']) {
    const input = clone(f.intent); input.settings[key] = true
    check(() => compileNativePolicy(input, f.deployment))
  }
  for (const [key, value] of [['workerModel', 'unknown'], ['reasoningEffort', 'turbo'],
    ['restrictToolIds', ['UnknownTool']], ['restrictToolIds', []], ['enabledToolIds', ['Execute']],
    ['skipPermissionsUnsafe', true], ['interactionMode', 'auto']]) {
    const input = clone(f.intent); input.settings[key] = value
    check(() => compileNativePolicy(input, f.deployment))
  }
})

test('Compiler holds missing ShadowHost, arbitrary restrictions and provisioning/publication', () => {
  const f = fixture()
  check(() => compileNativePolicy(f.intent, { ...f.deployment, boundary: null }), 'native_host_boundary_unavailable')
  check(() => compileNativePolicy(f.intent, { ...f.deployment, boundary: { policyEnforced: true, budgetEnforced: true } }))
  for (const key of ['scopeApproved', 'highAutonomyApproved']) {
    const input = clone(f.intent); input[key] = false
    check(() => compileNativePolicy(input, f.deployment), 'native_consent_required')
  }
  const deliverable = input => { input.restrictions = ['No deploy']; return input }
  const deploy = clone(f.intent); deploy.policy.allowDeploy = true
  check(() => compileNativePolicy(deploy, f.deployment), 'native_deploy_unavailable')
  for (const flags of [{ allowPr: true }, { allowMerge: true }, { allowPush: true, allowMerge: true }]) {
    const input = deliverable(clone(f.intent)); Object.assign(input.policy, flags)
    check(() => compileNativePolicy(input, f.deployment), 'native_consequence_dependency_invalid')
  }
  const conflicting = clone(f.intent); conflicting.policy.allowPush = true
  check(() => compileNativePolicy(conflicting, f.deployment), 'native_restriction_conflicts_policy')
  for (const flags of [{ allowPush: true }, { allowPush: true, allowPr: true }, { allowPush: true, allowPr: true, allowMerge: true }]) {
    const input = deliverable(clone(f.intent)); Object.assign(input.policy, flags)
    const compiled = compileNativePolicy(input, f.deployment)
    assert(compiled.requiredBoundaryDimensions.includes('delivery_mediation'))
    assert.equal(compiled.consequences.push, true)
    assert.notEqual(compiled.compiledPolicyHash, f.compiledPolicy.compiledPolicyHash)
  }
  assert(!f.compiledPolicy.requiredBoundaryDimensions.includes('delivery_mediation'))
  const createOnExisting = deliverable(clone(f.intent)); createOnExisting.policy.allowCreateRepository = true
  check(() => compileNativePolicy(createOnExisting, f.deployment), 'native_create_repository_requires_new_destination')
  for (const operation of ['clone', 'fork']) {
    const input = clone(f.intent); input.operation = operation
    check(() => compileNativePolicy(input, f.deployment), 'native_provisioning_or_publication_unavailable')
  }
  const newRepository = clone(f.intent)
  newRepository.destination = { kind: 'new_repository', account: 'owner', name: 'new',
    visibility: 'private', initialization: 'empty' }
  check(() => compileNativePolicy(newRepository, f.deployment), 'native_new_repository_requires_create_permission')
  newRepository.policy.allowCreateRepository = true
  // The host creates and seeds a new repository by pushing: without push it could never start.
  check(() => compileNativePolicy({ ...newRepository, policy: { ...newRepository.policy, allowPush: false } }, f.deployment),
    'native_new_repository_requires_push')
  newRepository.policy.allowPush = true
  newRepository.restrictions = newRepository.restrictions.filter(row => row.trim().toLowerCase() !== 'no push')
  assert.equal(compileNativePolicy(newRepository, f.deployment).consequences.createRepository, true)
  check(() => compileNativePolicy({ ...newRepository, destination: { ...newRepository.destination, visibility: 'public' } }, f.deployment),
    'native_new_repository_must_be_private')
  for (const initialization of ['scaffold', 'clone', 'fork']) {
    check(() => compileNativePolicy({ ...newRepository, destination: { ...newRepository.destination, initialization } }, f.deployment),
      'native_provisioning_or_publication_unavailable')
  }
  const hardRestriction = clone(f.intent); hardRestriction.restrictions.push('Never alter config, even through symlinks.')
  const original = clone(hardRestriction)
  check(() => compileNativePolicy(hardRestriction, f.deployment), 'native_unrepresented_restriction')
  assert.deepEqual(hardRestriction, original)
})

test('Canonical positive decimal budget bounds do not assume Factory units', () => {
  const f = fixture()
  for (const value of ['0', '-1', '+1', '01', '1.0', '1e3', '', '9'.repeat(65), 100, null]) {
    check(() => parseBudgetUnits(value), 'native_invalid_budget_units')
  }
  assert.equal(parseBudgetUnits('9'.repeat(64)), BigInt('9'.repeat(64)))
  for (const budget of [{ unit: 'otherUnit', capUnits: '100' }, { unit: 'testUnits', capUnits: '201' }]) {
    const input = clone(f.intent); input.policy.budget = budget
    check(() => compileNativePolicy(input, f.deployment), 'native_budget_exceeds_deployment')
  }
  const book = createBudgetReservationBook({ unit: 'deploy_defined_units', capUnits: '100' })
  book.reserve('request-one', '60'); book.reserve('request-two', '40')
  check(() => book.reserve('request-three', '1'), 'native_budget_exhausted')
  check(() => book.reserve('unknown-price', null), 'native_invalid_budget_units')
  book.markSent('request-one')
  check(() => book.releaseUnsent('request-one'), 'native_budget_unknown_charge')
  check(() => book.settle('request-one', '61'), 'native_budget_reservation_exceeded')
  assert.equal(book.snapshot().reservedUnits, '100')
  book.settle('request-one', '50'); book.releaseUnsent('request-two')
  assert.deepEqual(book.snapshot(), { unit: 'deploy_defined_units', capUnits: '100',
    settledUnits: '50', reservedUnits: '0', remainingUnits: '50', reservationCount: 0 })
  book.reserve('request-three', '50')
  check(() => book.reserve('request-four', '1'), 'native_budget_exhausted')
})

test('SHA/object format, full refs and fixed argv reject revision/shell option injection', () => {
  for (const sha of ['a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'A'.repeat(40), '--help', 'HEAD']) check(() => validateGitSha(sha))
  assert.equal(validateGitSha('a'.repeat(64), 'sha256'), 'a'.repeat(64))
  check(() => validateGitSha(SHA, 'sha256'))
  check(() => validateGitSha(SHA, 'unknown'), 'native_git_object_format_unsupported')
  for (const ref of ['main', '--help', 'refs/heads/a..b', 'refs/heads/a^', 'refs/heads/a@{0}',
    'refs/heads/a\nb', 'refs/heads/a.lock', 'refs/heads/a./b', 'refs//heads/a']) check(() => validateFullGitRef(ref))
  assert.equal(validateFullGitRef('refs/heads/legal;literal'), 'refs/heads/legal;literal')
  const args = buildNativeGitArgs({ kind: 'base_sha', ref: 'refs/heads/legal;literal' }, '/fixtures/repo with spaces')
  assert(args.includes('refs/heads/legal;literal^{commit}'))
  assert(args.includes('/fixtures/repo with spaces'))
  assert(args.includes('--end-of-options'))
  for (const query of [{ kind: 'push' }, { kind: 'root', ref: '--help' }, { kind: 'base_object', baseSha: 'HEAD; touch /tmp/bad' }]) check(() => buildNativeGitArgs(query, '/fixtures/repo'))
  for (const cwd of ['relative', '/fixtures/../escape', '/fixtures/repo\nbad', '/fixtures/repo/']) check(() => buildNativeGitArgs({ kind: 'root' }, cwd))
})

test('Workspace proof binds physical host, generation, immutable base and signed artifacts', () => {
  const f = fixture()
  for (const [key, value] of [['executionInstanceId', 'wrong-instance'], ['executionHostId', 'wrong-host'],
    ['repositoryId', 'wrong-repo'], ['checkoutGeneration', 'wrong-generation'],
    ['baseSha', NEXT_SHA], ['initialHeadSha', NEXT_SHA], ['canonicalCwd', '/fixtures/repo/../other'],
    ['canonicalGitDir', '/outside/.git'], ['canonicalCommonDir', '/fixtures/other/.git']]) {
    const proof = clone(f.rawProof); proof[key] = value
    check(() => validateWorkspaceProof(proof, f.intent, f.binding, f.proofOptions))
  }
  check(() => validateWorkspaceProof(f.rawProof, f.intent, { ...f.binding, epoch: 2 }, f.proofOptions), 'native_stale_host_binding')
  check(() => validateWorkspaceProof(f.rawProof, f.intent, f.binding, {
    ...f.proofOptions, evidenceAuthority: { verify: () => true },
  }), 'native_verified_evidence_authority_required')
  const artifact = f.envelopes.get('workspace-evidence').manifest.artifacts[0].id
  f.artifacts.set(artifact, Buffer.from('tampered'))
  check(() => validateWorkspaceProof(f.rawProof, f.intent, f.binding, f.proofOptions), 'native_evidence_digest_mismatch')
})

test('Lease rejects claimed booleans, unverified proof, wrong cap/hash, missing billing coverage', () => {
  const f = fixture()
  check(() => validateEnforcementLease(f.rawLease, { ...f.leaseOptions, workspaceProof: f.rawProof }), 'native_verified_workspace_proof_required')
  check(() => validateEnforcementLease(f.rawLease, {
    ...f.leaseOptions, compiledPolicy: clone(f.compiledPolicy),
  }), 'native_compiled_policy_required')
  for (const [key, value] of [['deploymentDigest', 'e'.repeat(64)], ['boundaryPolicyHash', 'e'.repeat(64)],
    ['workspaceAttestationId', 'wrong'], ['expiresAt', new Date(BASE_TIME - 1).toISOString()]]) {
    const lease = clone(f.rawLease); lease[key] = value
    check(() => validateEnforcementLease(lease, f.leaseOptions))
  }
  for (const capUnits of ['101', '99', '01']) {
    const lease = clone(f.rawLease); lease.budget.capUnits = capUnits
    check(() => validateEnforcementLease(lease, f.leaseOptions), 'native_lease_budget_mismatch')
  }
  const missingCoverage = clone(f.rawLease)
  f.attest('lease-evidence', 'lease', missingCoverage, ['physical_workspace'], f.leaseOptions.nonce)
  check(() => validateEnforcementLease(missingCoverage, f.leaseOptions), 'native_boundary_coverage_missing')
  const booleans = { ...f.rawLease, policyEnforced: true, budgetEnforced: true }
  check(() => validateEnforcementLease(booleans, f.leaseOptions), 'invalid_fields')
})

test('Injected read-only workspace verification distinguishes initial base from legitimate later HEAD', async () => {
  const f = fixture(), ports = fakeWorkspacePorts(f)
  const observation = await ports.verifier().inspect(f.intent, f.binding)
  assert.equal(observation.currentHeadSha, SHA)
  assert.equal(observation.attestationId, undefined)
  ports.values.head = NEXT_SHA
  ports.values.base = NEXT_SHA // Moving execution branch must not replace base.
  ports.values.dirty = ' M feature.ts\0'
  const later = await ports.verifier().inspect(f.intent, f.binding, { initialProof: f.workspaceProof })
  assert.equal(later.initialHeadSha, SHA)
  assert.equal(later.baseSha, SHA)
  assert.equal(later.currentHeadSha, NEXT_SHA)
  assert.equal(later.dirty, true)
  assert(ports.queries.includes('base_object'))
  await rejects(() => ports.verifier().inspect(f.intent, f.binding), 'native_workspace_base_mismatch')
  ports.values.ancestor = false
  await rejects(() => ports.verifier().inspect(f.intent, f.binding, { initialProof: f.workspaceProof }), 'native_execution_lineage_mismatch')
})

test('Read-only verification rejects remote/local confusion, aliases, dirty initial checkout and root escape', async () => {
  const f = fixture(), ports = fakeWorkspacePorts(f)
  f.host.localMachineId = 'broker-other-machine'
  await rejects(() => ports.verifier().inspect(f.intent, f.binding), 'native_remote_workspace_requires_host_verifier')
  assert.equal(ports.queries.length, 0)
  f.host.localMachineId = 'machine-one'
  ports.values.dirty = '?? owner-work.txt\0'
  await rejects(() => ports.verifier().inspect(f.intent, f.binding), 'native_clean_initial_checkout_required')
  ports.values.dirty = ''; ports.values.root = '/fixtures-other/repo'
  await rejects(() => ports.verifier().inspect(f.intent, f.binding), 'native_workspace_outside_permitted_roots')
  ports.values.root = '/fixtures/repo'
  ports.fs.realpath = async path => path === '/fixtures/repo' ? '/fixtures/alias' : path
  await rejects(() => ports.verifier().inspect(f.intent, f.binding), 'native_workspace_alias_refused')
  ports.fs.realpath = async path => path
  ports.git = async () => ({ stdout: Buffer.alloc(NATIVE_GIT_MAX_BYTES + 1), exitCode: 0 })
  await rejects(() => ports.verifier().inspect(f.intent, f.binding), 'native_git_read_invalid')
})

test('Production Git adapter uses fixed argv, sanitized env, timeout/output limits and eight slots', async () => {
  const callbacks = []
  const runner = createProductionGitRunner({
    gitExecutable: '/trusted/git', timeoutMs: 100, maxBytes: 32,
    execFilePort(executable, args, options, callback) {
      assert.equal(executable, '/trusted/git')
      assert.equal(options.shell, false)
      assert.equal(options.timeout, 100); assert.equal(options.maxBuffer, 32)
      assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0')
      assert.equal(options.env.GIT_CONFIG_GLOBAL, '/dev/null')
      assert.equal(options.env.HOME, '/dev/null')
      assert.equal(options.env.FACTORY_API_KEY, undefined)
      assert.equal(options.env.GIT_DIR, undefined)
      assert(args.includes('core.fsmonitor=false'))
      assert(args.includes('core.hooksPath=/dev/null'))
      callbacks.push(callback)
    },
  })
  const input = { query: { kind: 'root' }, cwd: '/fixtures/repo',
    args: buildNativeGitArgs({ kind: 'root' }, '/fixtures/repo') }
  const pending = Array.from({ length: 8 }, () => runner(input))
  await rejects(() => runner(input), 'native_git_capacity_exceeded')
  callbacks.splice(0).forEach(callback => callback(null, Buffer.from('ok'), Buffer.alloc(0)))
  assert.equal((await Promise.all(pending)).length, 8)
  const overflow = runner(input)
  callbacks.shift()(null, Buffer.alloc(33), Buffer.alloc(0))
  await assert.rejects(overflow, /native_git_read_failed/)
  const timeout = runner(input)
  callbacks.shift()({ killed: true, signal: 'SIGTERM' }, Buffer.alloc(0), Buffer.alloc(0))
  await assert.rejects(timeout, /native_git_read_failed/)
  await rejects(() => runner({ ...input, args: ['push'] }), 'native_git_argv_mismatch')
})

test('Timed-out injected workspace reads retain bounded outstanding-I/O accounting', async () => {
  const f = fixture(), ports = fakeWorkspacePorts(f), releases = []
  const verifier = createReadOnlyWorkspaceVerifier({
    host: f.host, git: ports.git, readTimeoutMs: 5, now: f.now,
    fs: { ...ports.fs, realpath: () => new Promise(resolve => { releases.push(resolve) }) },
  })
  for (let i = 0; i < 8; i++) {
    await rejects(() => verifier.inspect(f.intent, f.binding), 'native_workspace_read_timeout')
  }
  await rejects(() => verifier.inspect(f.intent, f.binding), 'native_workspace_read_capacity_exceeded')
  assert.equal(releases.length, 8)
  releases.forEach(resolve => resolve('/fixtures'))
})

test('Final transport send consumes a one-time permit, including SDK-generated request ids', async () => {
  const f = fixture()
  check(() => f.guarded.transport.send(JSON.stringify(f.turnFrame)), 'native_send_permit_required')
  await f.authorize(f.initializeFrame, 'initialize')
  const generated = clone(f.initializeFrame); generated.id = 'sdk-later-generated-id'
  f.guarded.transport.send(JSON.stringify(generated))
  assert.equal(f.sent.length, 1)
  check(() => f.guarded.transport.send(JSON.stringify(generated)), 'native_send_permit_required')
  await f.authorize(f.turnFrame)
  assert.equal(f.sent.length, 1) // Authorization is not a send.
  f.guarded.transport.send(JSON.stringify(f.turnFrame))
  assert.equal(f.sent.length, 2)
  assert.equal(f.consumed.size, 2)
  const wrongProjection = clone(f.initializeFrame); wrongProjection.params.missionSettings.skipScrutiny = true
  await f.authorize(wrongProjection, 'initialize')
  check(() => f.guarded.transport.send(JSON.stringify(wrongProjection)), 'native_initialize_projection_mismatch')
})

test('Guard catches expiry, revoked policy, machine/session changes at actual send', async () => {
  for (const mutation of ['expiry', 'scope', 'revocation', 'connection', 'session', 'host']) {
    const f = fixture()
    await f.authorize(f.turnFrame)
    if (mutation === 'expiry') f.advance(1001)
    if (mutation === 'scope') f.state.intent = { ...f.intent, goal: 'Changed approved scope.' }
    if (mutation === 'revocation') f.revoke()
    if (mutation === 'connection') f.reconnect()
    if (mutation === 'session') f.state.sessionIds = []
    if (mutation === 'host') f.state.workspaceProof = clone(f.rawProof)
    check(() => f.guarded.transport.send(JSON.stringify(f.turnFrame)))
    assert.equal(f.sent.length, 0)
  }
})

test('Host consumption cannot invalidate or alter scope immediately before the wire send', async () => {
  for (const change of ['invalidate', 'scope', 'lease', 'session']) {
    const f = fixture()
    await f.authorize(f.turnFrame)
    const otherRawLease = { ...clone(f.rawLease), leaseId: 'lease-renewed' }
    f.attest('lease-evidence', 'lease', otherRawLease, f.compiledPolicy.requiredBoundaryDimensions, f.leaseOptions.nonce)
    const otherLease = validateEnforcementLease(otherRawLease, f.leaseOptions)
    const consume = f.boundary.assertAndConsumePermit
    f.boundary.assertAndConsumePermit = permit => {
      consume(permit)
      if (change === 'invalidate') f.guarded.invalidate()
      else if (change === 'scope') f.state.intent = { ...f.intent, goal: 'Changed during host consumption.' }
      else if (change === 'lease') f.state.lease = otherLease
      else f.state.sessionIds = []
    }
    check(() => f.guarded.transport.send(JSON.stringify(f.turnFrame)),
      change === 'session' ? 'native_send_wrong_session' : 'native_live_policy_changed')
    assert.equal(f.sent.length, 0)
    assert.equal(f.guarded.pendingPermitCount, 0)
  }
})

test('Revocation/invalidation during awaited authorization cannot register a stale permit', async () => {
  for (const invalidation of ['revoke', 'invalidate', 'reconnect']) {
    const f = fixture()
    let release
    const original = f.boundary.authorizeSend
    f.boundary.authorizeSend = async input => {
      await new Promise(resolve => { release = resolve })
      return original(input)
    }
    const wait = f.authorize(f.turnFrame)
    if (invalidation === 'revoke') f.revoke()
    if (invalidation === 'invalidate') f.guarded.invalidate()
    if (invalidation === 'reconnect') f.reconnect()
    release()
    await assert.rejects(wait)
    assert.equal(f.guarded.pendingPermitCount, 0)
    assert.equal(f.sent.length, 0)
  }
})

test('Concurrent permits are bounded, same operation deduplicated and ids cannot be reused', async () => {
  const f = fixture(), releases = []
  const original = f.boundary.authorizeSend
  f.boundary.authorizeSend = async input => {
    await new Promise(resolve => releases.push(resolve))
    return original(input)
  }
  const frames = Array.from({ length: 8 }, (_, i) => ({
    ...clone(f.turnFrame), params: { ...f.turnFrame.params, messageId: `message-${i}` },
  }))
  const waits = frames.map(frame => f.authorize(frame))
  await rejects(() => f.authorize({ ...clone(f.turnFrame), params: { ...f.turnFrame.params, messageId: 'ninth' } }), 'native_send_capacity_exceeded')
  releases.splice(0).forEach(release => release())
  await Promise.all(waits)
  assert.equal(f.guarded.pendingPermitCount, 8)
  frames.forEach(frame => f.guarded.transport.send(JSON.stringify(frame)))
  const reusedId = 'permit-1'
  f.boundary.authorizeSend = async input => ({ ...await original(input), permitId: reusedId })
  await rejects(() => f.authorize(f.turnFrame), 'native_send_permit_reused')
  const g = fixture()
  await g.authorize(g.turnFrame)
  await rejects(() => g.authorize(g.turnFrame), 'native_send_permit_reused')
})

test('Permission/questionnaire response permits bind exact request ids and raw payload', async () => {
  const f = fixture()
  const permission = { jsonrpc: '2.0', id: 'permission-request', result: {
    sessionId: 'worker-one', selectedOption: 'proceed_once',
  } }
  await f.authorize(permission, 'permission_response')
  check(() => f.guarded.transport.send(JSON.stringify({ ...permission, id: 'replacement-request' })), 'native_send_permit_required')
  f.guarded.transport.send(JSON.stringify(permission))
  const questionnaire = { jsonrpc: '2.0', id: 'ask-request', result: {
    sessionId: 'worker-one', answers: [{ index: 0, question: 'Exact raw question?', answer: 'Exact raw answer.' }],
  } }
  await f.authorize(questionnaire, 'ask_user_response')
  f.guarded.transport.send(JSON.stringify(questionnaire))
  const always = { ...permission, result: { ...permission.result, selectedOption: 'proceed_always' } }
  await f.authorize(always, 'permission_response')
  check(() => f.guarded.transport.send(JSON.stringify(always)), 'native_permission_escalation_unavailable')
  assert.equal(f.sent.length, 2)
})

test('Unknown SDK mutations/controls/load/authentication and malformed reads never escape', () => {
  const f = fixture()
  for (const method of [
    'daemon.git_push', 'daemon.create_pr', 'daemon.interrupt_session', 'daemon.close_session',
    'daemon.kill_worker_session', 'daemon.load_session', 'daemon.update_session_settings',
    'daemon.write_data', 'daemon.update_session_defaults', 'daemon.authenticate', 'daemon.sf.publish_workstream_content',
  ]) check(() => f.guarded.transport.send(JSON.stringify({
    jsonrpc: '2.0', id: 'unavailable', method, params: { sessionId: 'session-root' },
  })), 'native_sdk_mutation_unavailable')
  check(() => f.guarded.transport.send(JSON.stringify({ jsonrpc: '2.0', id: 'bad-read',
    method: 'daemon.get_default_settings', params: { runtimeSettingsPath: '/user/home' } })), 'invalid_fields')
  check(() => f.guarded.transport.send(JSON.stringify({ jsonrpc: '2.0', id: 'wrong-read',
    method: 'daemon.get_session_messages', params: { sessionId: 'unrelated' } })), 'native_read_wrong_session')
  f.revoke()
  f.guarded.transport.send(JSON.stringify({ jsonrpc: '2.0', id: 'read',
    method: 'daemon.get_session_messages', params: { sessionId: 'session-root', limit: 100 } }))
  assert.equal(f.sent.length, 1)
})

test('Standalone permit validator rejects unverified lease and all mismatched fields', async () => {
  const f = fixture(), requestHash = nativeFrameRequestHash(f.turnFrame)
  const permit = await f.boundary.authorizeSend({ leaseId: f.lease.leaseId, connectionId: 'connection-one',
    operation: 'owner_turn', sessionId: 'session-root', requestHash })
  const options = { lease: f.lease, binding: f.binding, connectionId: 'connection-one',
    operation: 'owner_turn', sessionId: 'session-root', requestHash, revocationGeneration: 0, now: f.now() }
  validateSendPermit(permit, options)
  check(() => validateSendPermit(permit, { ...options, lease: f.rawLease }), 'native_verified_lease_required')
  for (const [key, value] of [['connectionId', 'wrong'], ['sessionId', 'wrong'], ['leaseId', 'wrong'],
    ['requestHash', 'f'.repeat(64)], ['revocationGeneration', 1], ['operation', 'resume']]) {
    check(() => validateSendPermit({ ...permit, [key]: value }, options), 'native_send_permit_mismatch')
  }
})

for (const { name, fn } of tests) {
  await fn()
  console.log(`PASS ${name}`)
}
console.log(`Native provider policy: ${tests.length} offline groups; ${assertions} fail-closed assertions. No live qualification.`)
