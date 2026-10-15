/**
 * Offline host-enforcer checks. Spawn, git and the daemon are fakes; the job
 * root is a private temporary directory. No droid process, network or model call.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { generateKeyPairSync, sign } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { BrokerError, canonical, hash } from '../broker/validation.mjs'
import { compileNativePolicy, getNativeHashes } from '../broker/native-policy.mjs'
import { createNativeEvidenceAuthority, validateEnforcementLease, validateSendPermit } from '../broker/native-boundary.mjs'
import { validateWorkspaceProof } from '../broker/native-workspace.mjs'
import {
  createNativeHost, createHostRoutedTransport, loadOrCreateHostKey, createNativeUsageClient, nativeSandboxSettings,
  NATIVE_NEW_REPOSITORY_BASE, repositoryUrlFor, canonicalRepositoryId, stripUrlCredentials, containmentProbeScript,
} from '../broker/native-host.mjs'
import { verifyHostQualification, isHostQualificationFor, publicKeySha256 } from '../broker/qualification.mjs'
import { createHostLoopbackSocket, createProductionNativeComposition, readPrivateSecretFile, productionDeploymentBinding, createPinnedHostGitRunner } from '../broker/host-production.mjs'

const SHA = 'c'.repeat(40), DIGEST = 'e'.repeat(64), MACHINE = 'machine-host'
const tests = []
const test = (name, fn) => tests.push({ name, fn })
const code = expected => error => error instanceof BrokerError && error.code === expected

export function fixture({ probe = { workWrite: 1, ownerHomeWrite: 0, githubReachable: 0 }, daemonStarts = true,
  leaveHelper = false, stubborn = false, unkillable = false, configuredHooks = null, activeHooks = false, trustedHost = false } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'spriite-native-host-test-')))
  const root = join(base, 'native'), ownerHome = join(base, 'owner')
  fs.mkdirSync(ownerHome)
  const keyFile = join(base, 'factory-key')
  fs.writeFileSync(keyFile, 'fk-offline-fixture-not-a-real-key\n', { mode: 0o600 })
  let clock = Date.parse('2026-10-13T12:00:00.000Z'), counter = 0
  const log = [], spawns = [], gitCalls = []
  const state = { head: SHA, ref: null, remoteUrl: null, helper: leaveHelper }
  const git = async ({ args, cwd, env }) => {
    gitCalls.push({ args, cwd, env })
    const a = args.join(' ')
    if (args[0] === 'var') return { stdout: 'Configured fixture identity <fixture@example.invalid> 1 +0000\n', exitCode: 0 }
    if (args[0] === 'init') {
      fs.mkdirSync(join(args.at(-1), '.git'), { recursive: true })
      if (activeHooks) {
        fs.mkdirSync(join(args.at(-1), '.git', 'hooks'))
        fs.writeFileSync(join(args.at(-1), '.git', 'hooks', 'pre-commit'), 'untrusted fixture hook')
      }
      return { stdout: '', exitCode: 0 }
    }
    if (a.includes('config --get core.hooksPath')) return { stdout: configuredHooks === null ? '' : `${configuredHooks}\n`, exitCode: configuredHooks === null ? 1 : 0 }
    if (a.includes('remote add origin')) { state.remoteUrl = args.at(-1); return { stdout: '', exitCode: 0 } }
    if (args.includes('update-ref')) return { stdout: '', exitCode: 0 }
    if (args.includes('symbolic-ref') && args.at(-2) === 'HEAD') { state.ref = args.at(-1); return { stdout: '', exitCode: 0 } }
    if (args[0] === 'clone') {
      log.push('clone')
      const work = args.at(-1)
      fs.mkdirSync(join(work, '.git'), { recursive: true })
      state.remoteUrl = args.at(-2)
      return { stdout: '', exitCode: 0 }
    }
    if (a.includes('config --local --unset-all credential.helper')) { if (!leaveHelper) state.helper = false; return { stdout: '', exitCode: 5 } }
    if (a.includes('remote set-url origin')) { state.remoteUrl = args.at(-1); return { stdout: '', exitCode: 0 } }
    if (a.includes('config --local --list')) {
      return { stdout: `core.bare=false\nremote.origin.url=${state.remoteUrl}\n${state.helper ? 'credential.helper=osxkeychain\n' : ''}`, exitCode: 0 }
    }
    if (a.includes('rev-parse --verify refs/remotes/origin/')) return { stdout: `${SHA}\n`, exitCode: 0 }
    if (args.includes('checkout')) { state.ref = `refs/heads/${args.at(-2) === '-B' ? args.at(-1) : args.at(-2)}`; if (args.at(-2) !== '-B') state.head = args.at(-1); return { stdout: '', exitCode: 0 } }
    if (args.includes('commit')) { log.push('commit'); state.head = SHA; return { stdout: '', exitCode: 0 } }
    if (args.includes('push')) { log.push(`push ${args.at(-1)}`); return { stdout: '', exitCode: 0 } }
    if (a.endsWith('rev-parse HEAD')) return { stdout: `${state.head}\n`, exitCode: 0 }
    const work = args[args.indexOf('-C') + 1]
    if (a.includes('--show-toplevel')) return { stdout: `${work}\n`, exitCode: 0 }
    if (a.includes('--absolute-git-dir') || a.includes('--git-common-dir')) return { stdout: `${work}/.git\n`, exitCode: 0 }
    if (a.includes('--show-object-format')) return { stdout: 'sha1\n', exitCode: 0 }
    if (a.includes('HEAD^{commit}')) return { stdout: `${state.head}\n`, exitCode: 0 }
    if (a.includes('symbolic-ref')) return { stdout: `${state.ref}\n`, exitCode: 0 }
    if (a.includes('status --porcelain')) return { stdout: '', exitCode: 0 }
    if (a.includes('remote get-url origin')) return { stdout: `${state.remoteUrl}\n`, exitCode: 0 }
    throw new Error(`unexpected git ${a}`)
  }
  const spawn = (command, args, options) => {
    const child = new EventEmitter()
    child.pid = 5000 + spawns.length; child.exitCode = null; child.signalCode = null; child.signals = []
    child.kill = signal => {
      child.signals.push(signal)
      if (unkillable || (stubborn && signal === 'SIGTERM')) return true
      child.exitCode = signal === 'SIGKILL' ? 137 : 0
      setImmediate(() => child.emit('exit', child.exitCode, signal))
      return true
    }
    spawns.push({ command, args, options, child })
    if (args[0] === 'daemon' && !daemonStarts) { child.exitCode = 1; setImmediate(() => child.emit('exit', 1)) }
    if (args[0] === 'exec') {
      // Stand in for the sandboxed hook: write the result the probe script would.
      const settingsPath = args[args.indexOf('--settings') + 1]
      const nonce = settingsPath.split('/').at(-1).replace('.settings.json', '')
      const work = args[args.indexOf('--cwd') + 1]
      fs.writeFileSync(join(work, '.git', `spriite-probe-${nonce}.json`), JSON.stringify({ nonce, ...probe }))
      setImmediate(() => { child.exitCode = 1; child.emit('exit', 1) })
    }
    return child
  }
  const delivery = {
    calls: [],
    async createPrivateRepository(input) { log.push('createPrivateRepository'); this.calls.push(input); return { repositoryUrl: `https://github.com/${input.account}/${input.name}`, created: true } },
    async deliver() { throw new Error('not used') }, async resume() { throw new Error('not used') },
  }
  const { privateKey } = generateKeyPairSync('ed25519')
  const hostOptions = {
    root, hostKey: privateKey, spawn, git, delivery, now: () => clock, factoryApiKeyFile: keyFile,
    machineId: MACHINE, deploymentDigest: DIGEST, ownerHome, droidPath: '/fixture/bin/droid',
    ownerGitEnv: { PATH: '/usr/bin:/bin', HOME: ownerHome, GH_TOKEN_FIXTURE: 'owner-env-only' },
    randomId: () => `id${++counter}`, allocatePort: async () => 40123,
    waitForDaemon: async ({ child }) => { await new Promise(r => setImmediate(r)); return child.exitCode === null },
    sleep: async () => { await new Promise(r => setImmediate(r)) }, parentPid: 4242, trustedHost,
  }
  const host = createNativeHost(hostOptions)
  const intentFor = (overrides = {}) => {
    const missionId = overrides.missionId ?? 'mission-host-1'
    return {
      protocolVersion: 1, missionId, ownerId: 'owner-host', commandId: `prepare-${missionId}`,
      goal: 'Implement the approved change.', scopeRevision: 1, operation: 'implement',
      destination: { kind: 'existing', account: 'owner', name: 'repo', visibility: 'private', initialization: 'empty' },
      workspace: { machineId: MACHINE, cwd: host.workDirFor(missionId), repository: 'owner/repo', baseRef: 'refs/heads/main', baseSha: SHA },
      references: [], acceptanceCriteria: ['Change works.'], restrictions: ['No deploy'],
      policy: { autonomy: 'high', allowCreateRepository: false, allowPush: true, allowPr: true, allowMerge: true, allowDeploy: false },
      scopeApproved: true, highAutonomyApproved: true,
      settings: {
        modelId: 'm', reasoningEffort: 'high', workerModel: 'm', workerReasoningEffort: 'medium',
        validationWorkerModel: 'm', validationWorkerReasoningEffort: 'high',
        restrictToolIds: ['Read', 'RecommendMission', 'ExitMissionPlanning', 'Task', 'Script'],
        skipScrutiny: false, skipUserTesting: false,
      },
      ...overrides,
    }
  }
  const deployment = {
    ownerId: 'owner-host', machineId: MACHINE, deploymentDigest: DIGEST, allowedModelIds: ['m'],
    allowedToolIds: ['Read', 'RecommendMission', 'ExitMissionPlanning', 'Task', 'Script'], boundary: host,
  }
  const bindingFor = intent => ({ ownerId: intent.ownerId, missionId: intent.missionId, machineId: MACHINE, ...getNativeHashes(intent), epoch: 1 })
  async function ready(intent = intentFor()) {
    await host.provision(intent)
    await host.startDaemon({ missionId: intent.missionId })
    await host.runContainmentProbes({ missionId: intent.missionId })
    return intent
  }
  async function leased(intent) {
    intent = await ready(intent)
    const binding = bindingFor(intent)
    const nonce = 'workspace-nonce-1'
    const raw = await host.verifyWorkspace({ ...binding, workspace: intent.workspace, nonce })
    const proof = validateWorkspaceProof(raw, intent, binding, {
      host: host.workspaceHostFor(intent.missionId), nonce, evidenceAuthority: host.evidenceAuthority, now: clock,
    })
    const compiled = compileNativePolicy(intent, deployment)
    const leaseNonce = 'lease-nonce-1'
    const rawLease = await host.acquireLease({ ...binding, workspaceAttestationId: proof.attestationId,
      compiledPolicyHash: compiled.compiledPolicyHash, nonce: leaseNonce })
    const lease = validateEnforcementLease(rawLease, {
      intent, binding, workspaceProof: proof, compiledPolicy: compiled, deployment,
      nonce: leaseNonce, evidenceAuthority: host.evidenceAuthority, now: clock,
    })
    return { intent, binding, proof, compiled, rawLease, lease }
  }
  return {
    base, root, ownerHome, host, spawns, gitCalls, log, delivery, intentFor, deployment, bindingFor, ready, leased,
    privateKey, state, keyFile, now: () => clock, advance: ms => { clock += ms },
    restart: overrides => createNativeHost({ ...hostOptions, ...overrides }),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  }
}
const withFixture = (options, fn) => async () => {
  const f = fixture(options)
  try { await fn(f) } finally { f.cleanup() }
}

test('dedicated daemon env is scrubbed to exactly PATH, HOME, LANG, FACTORY_API_KEY', withFixture({}, async f => {
  const intent = await f.ready()
  const daemon = f.spawns.find(row => row.args[0] === 'daemon')
  assert.deepEqual(Object.keys(daemon.options.env).sort(), ['FACTORY_API_KEY', 'HOME', 'LANG', 'PATH'])
  assert.equal(daemon.options.env.HOME, join(f.host.jobRootFor(intent.missionId), 'home'))
  assert.notEqual(daemon.options.env.HOME, f.ownerHome)
  assert.equal(daemon.options.env.FACTORY_API_KEY, 'fk-offline-fixture-not-a-real-key')
  assert.equal(daemon.options.cwd, intent.workspace.cwd)
  assert.deepEqual(daemon.args.slice(0, 7), ['daemon', '--host', '127.0.0.1', '--port', '40123', '--parent-pid', '4242'])
  assert.equal(daemon.args[8], join(f.host.jobRootFor(intent.missionId), 'home', '.factory', 'settings.json'))
  const probe = f.spawns.find(row => row.args[0] === 'exec')
  assert.deepEqual(Object.keys(probe.options.env).sort(), ['FACTORY_API_KEY', 'HOME', 'LANG', 'PATH'])
  assert.equal(probe.options.env.HOME, daemon.options.env.HOME)
  const job = f.host.job(intent.missionId)
  assert.deepEqual(job.daemon.envKeys, ['FACTORY_API_KEY', 'HOME', 'LANG', 'PATH'])
  assert.equal(JSON.stringify(job).includes('fk-offline'), false)
}))

test('settings.json is whole-process with allowWrite [work] and no network domains; roots are 0700', withFixture({}, async f => {
  const intent = await f.ready()
  const jobRoot = f.host.jobRootFor(intent.missionId)
  const path = join(jobRoot, 'home', '.factory', 'settings.json')
  const settings = JSON.parse(fs.readFileSync(path, 'utf8'))
  assert.equal(settings.sandbox.enabled, true)
  assert.equal(settings.sandbox.mode, 'whole-process')
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, [intent.workspace.cwd])
  assert.deepEqual(settings.sandbox.network.allowedDomains, [])
  for (const secret of ['.ssh', '.factory', '.config/gh', '.git-credentials']) {
    assert(settings.sandbox.filesystem.denyRead.includes(join(f.ownerHome, secret)))
  }
  assert(settings.sandbox.filesystem.denyRead.includes(join(f.root, 'host-key')))
  assert.deepEqual(settings, nativeSandboxSettings({ workDir: intent.workspace.cwd, ownerHome: f.ownerHome, root: f.root, apiKeyFile: f.keyFile }))
  assert.equal(fs.statSync(path).mode & 0o777, 0o600)
  for (const dir of [jobRoot, join(jobRoot, 'home')]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  const nonce = f.host.job(intent.missionId).probes.nonce
  const probeSettings = JSON.parse(fs.readFileSync(join(jobRoot, 'probe', `${nonce}.settings.json`), 'utf8'))
  assert.equal(probeSettings.sandbox.mode, 'whole-process')
  assert.equal(probeSettings.hooks.UserPromptSubmit[0].hooks[0].command, `/bin/sh ${join(jobRoot, 'probe', `${nonce}.sh`)}`)
  const script = fs.readFileSync(join(jobRoot, 'probe', `${nonce}.sh`), 'utf8')
  assert.match(script, /exit 2/)
  assert(script.includes(`${f.ownerHome}/.spriite-probe-${nonce}`))
  assert.equal(fs.existsSync(join(intent.workspace.cwd, '.git', `spriite-probe-${nonce}.json`)), false)
  assert.throws(() => containmentProbeScript({ workDir: "/x'y", ownerHome: '/h', nonce: 'n' }), code('native_probe_path_unsafe'))
}))

test('provisioning clones with owner credentials, then strips helper and userinfo', withFixture({}, async f => {
  const intent = f.intentFor()
  await f.host.provision(intent)
  const clone = f.gitCalls.find(row => row.args[0] === 'clone')
  assert.equal(clone.env.GH_TOKEN_FIXTURE, 'owner-env-only')
  assert.equal(clone.args.at(-2), 'https://github.com/owner/repo.git')
  assert(f.gitCalls.some(row => row.args.join(' ').includes('config --local --unset-all credential.helper')))
  const local = f.gitCalls.filter(row => row.args[0] !== 'clone' && !row.args.includes('push'))
  assert(local.every(row => row.env.HOME === '/dev/null' && row.env.GIT_CONFIG_GLOBAL === '/dev/null'))
  const job = f.host.job(intent.missionId)
  assert.equal(job.baseSha, SHA)
  assert.equal(job.executionRef, `refs/heads/spriite/${intent.missionId}`)
  assert.equal(stripUrlCredentials('https://user:token@github.com/owner/repo.git'), 'https://github.com/owner/repo.git')
  assert.throws(() => repositoryUrlFor('https://user:token@github.com/owner/repo.git'), code('native_repository_url_invalid'))
  await assert.rejects(f.host.provision(f.intentFor({ missionId: 'other', workspace: { ...intent.workspace, cwd: '/elsewhere' } })), code('native_workspace_not_host_provisioned'))
}))

test('a clone that keeps a credential helper is refused', withFixture({ leaveHelper: true }, async f => {
  await assert.rejects(f.host.provision(f.intentFor()), code('native_clone_credentials_not_stripped'))
}))

test('job roots are never reused once started or foreign', withFixture({}, async f => {
  const intent = await f.ready()
  await assert.rejects(f.host.provision(intent), code('native_job_root_reused'))
  const foreign = f.intentFor({ missionId: 'mission-foreign' })
  fs.mkdirSync(f.host.jobRootFor('mission-foreign'), { recursive: true })
  await assert.rejects(f.host.provision(foreign), code('native_job_root_reused'))
  const fresh = f.intentFor({ missionId: 'mission-fresh' })
  await f.host.provision(fresh)
  await f.host.provision(fresh) // admission then prepare, before any daemon start
  await assert.rejects(f.host.provision({ ...fresh, workspace: { ...fresh.workspace, baseSha: 'd'.repeat(40) } }), code('native_job_root_reused'))
}))

test('new private admission mints configured-identity local seed and never calls delivery', withFixture({}, async f => {
  for (const created of [true, false]) {
    const intent = f.intentFor({
      missionId: `mission-new-${created}`,
      destination: { kind: 'new_repository', account: 'owner', name: 'fresh', visibility: 'private', initialization: 'empty' },
      policy: { autonomy: 'high', allowCreateRepository: true, allowPush: true, allowPr: false, allowMerge: false, allowDeploy: false },
    })
    intent.workspace = { ...intent.workspace, repository: 'owner/fresh' }
    delete intent.workspace.baseSha
    f.delivery.createPrivateRepository = async () => { f.log.push('create'); return { created, repositoryUrl: 'https://github.com/owner/fresh' } }
    const resolved = await f.host.resolveAdmissionWorkspace(intent)
    assert.equal(resolved.baseSha, SHA)
    assert.equal(f.host.job(intent.missionId).created, false)
    assert.deepEqual(f.log, Array(created ? 1 : 2).fill('commit'))
    assert.equal(f.delivery.calls.length, 0)
    assert.throws(() => f.host.privateRepositoryInitializationInput(intent.missionId), code('native_private_repository_initialization_not_approved'))
    intent.workspace = resolved
    await f.host.provision(intent)
    const input = f.host.privateRepositoryInitializationInput(intent.missionId)
    assert.equal(input.seedSha, SHA)
    assert.equal(input.adoptionAllowed, false)
    assert.equal(input.requiresCreatedRepository, true)
    assert(f.gitCalls.filter(call => call.args.includes('commit')).every(call => !call.args.some(arg => /user\.(name|email)/.test(arg))))
    assert(f.gitCalls.every(call => !call.args.some(arg => arg.startsWith('core.hooksPath=') || ['--no-verify', '--no-gpg-sign'].includes(arg))))
    await assert.rejects(f.host.provision({ ...intent, destination: { ...intent.destination, name: 'redirected' } }), code('native_new_repository_identity_mismatch'))
    await assert.rejects(f.host.provision({ ...intent, destination: { ...intent.destination, kind: 'existing' },
      policy: { ...intent.policy, allowCreateRepository: false } }), code('native_job_root_reused'))
  }
}))
test('local seed refuses configured hook paths without bypassing identity, hooks or signing', withFixture({ configuredHooks: '/dev/null' }, async f => {
  const intent = f.intentFor({
    destination: { kind: 'new_repository', account: 'owner', name: 'fresh', visibility: 'private', initialization: 'empty' },
    policy: { autonomy: 'high', allowCreateRepository: true, allowPush: true, allowPr: false, allowMerge: false, allowDeploy: false },
  })
  intent.workspace.repository = 'owner/fresh'; delete intent.workspace.baseSha
  await assert.rejects(f.host.resolveAdmissionWorkspace(intent), code('native_git_hooks_unsafe'))
  assert.equal(f.gitCalls.some(call => call.args.includes('commit')), false)
  assert.equal(f.delivery.calls.length, 0)
}))
test('local seed refuses active template hooks before invoking commit', withFixture({ activeHooks: true }, async f => {
  const intent = f.intentFor({
    destination: { kind: 'new_repository', account: 'owner', name: 'fresh', visibility: 'private', initialization: 'empty' },
    policy: { autonomy: 'high', allowCreateRepository: true, allowPush: true, allowPr: false, allowMerge: false, allowDeploy: false },
  })
  intent.workspace.repository = 'owner/fresh'; delete intent.workspace.baseSha
  await assert.rejects(f.host.resolveAdmissionWorkspace(intent), code('native_git_hooks_unsafe'))
  assert.equal(f.gitCalls.some(call => call.args.includes('commit')), false)
  assert.equal(f.delivery.calls.length, 0)
}))

test('new seeds reject supplied SHAs and missing configured identity before remote mutation', withFixture({}, async f => {
  const intent = f.intentFor({
    destination: { kind: 'new_repository', account: 'owner', name: 'fresh', visibility: 'private', initialization: 'empty' },
    policy: { autonomy: 'high', allowCreateRepository: true, allowPush: true, allowPr: false, allowMerge: false, allowDeploy: false },
  })
  intent.workspace.repository = 'owner/fresh'
  await assert.rejects(f.host.resolveAdmissionWorkspace(intent), code('native_new_repository_seed_admission_required'))
  assert.equal(f.gitCalls.length, 0); assert.equal(f.delivery.calls.length, 0)
  const noIdentity = f.restart({ git: async () => ({ stdout: '', exitCode: 128 }) })
  intent.missionId = 'mission-missing-identity'; intent.workspace.cwd = noIdentity.workDirFor(intent.missionId)
  delete intent.workspace.baseSha
  await assert.rejects(noIdentity.resolveAdmissionWorkspace(intent), code('native_git_identity_required'))
  assert.throws(() => noIdentity.job(intent.missionId), code('native_job_not_provisioned'))
  assert.equal(f.delivery.calls.length, 0)
}))

test('physical workspace evidence verifies without falsely signing credential isolation', withFixture({}, async f => {
  const intent = await f.ready(), binding = f.bindingFor(intent)
  const proof = await f.host.verifyWorkspace({ ...binding, workspace: intent.workspace, nonce: 'w' })
  const envelope = f.host.readEvidence(proof.evidenceIds[0])
  assert.deepEqual(envelope.manifest.artifacts.map(row => row.dimension), ['physical_workspace', 'destination_identity'])
  const other = generateKeyPairSync('ed25519').publicKey
  const foreign = createNativeEvidenceAuthority({ publicKey: other, readEvidence: f.host.readEvidence, readArtifact: f.host.readArtifact, now: f.now })
  const expected = { kind: 'workspace', subjectHash: hash(proof), binding, nonce: 'w',
    deploymentDigest: DIGEST, dimensions: ['physical_workspace', 'destination_identity'], now: f.now() }
  assert.throws(() => foreign.verify(proof.evidenceIds, expected), code('native_evidence_signature_invalid'))
  f.host.evidenceAuthority.verify(proof.evidenceIds, expected)
  const artifact = envelope.manifest.artifacts[0]
  const path = join(f.host.jobRootFor(intent.missionId), 'artifacts', `${artifact.id}.json`)
  fs.writeFileSync(path, '{"tampered":true}')
  assert.throws(() => f.host.evidenceAuthority.verify(proof.evidenceIds, expected), code('native_evidence_digest_mismatch'))
}))

test('credential isolation holds even with passing containment; unknown/replayed permits fail closed', withFixture({}, async f => {
  await assert.rejects(f.leased(), code('native_credential_isolation_unproven'))
  assert(f.host.qualificationHolds.includes('native_credential_isolation_unproven'))
  const input = { ...f.bindingFor(f.intentFor()), leaseId: 'unknown', connectionId: 'c', operation: 'owner_turn',
    sessionId: 's', requestHash: 'a'.repeat(64), nonce: 'n' }
  await assert.rejects(f.host.authorizeSend(input), code('native_lease_unknown_or_revoked'))
  const permit = { permitId: 'forged', leaseId: 'unknown', connectionId: 'c', operation: 'owner_turn', sessionId: 's',
    requestHash: 'a'.repeat(64), expiresAt: new Date(f.now() + 1000).toISOString(), revocationGeneration: 0 }
  for (let i = 0; i < 2; i++) assert.throws(() => f.host.assertAndConsumePermit(permit), code('native_permit_unknown_or_reused'))
}))

test('revoke waits for SIGKILL exit, bumps generation and signs verified termination only', withFixture({ stubborn: true }, async f => {
  const intent = await f.ready(), binding = f.bindingFor(intent)
  const receipt = await f.host.revoke({ ...binding, reason: 'owner stop' })
  const daemon = f.spawns.find(row => row.args[0] === 'daemon').child
  assert.deepEqual(daemon.signals, ['SIGTERM', 'SIGKILL'])
  assert.notEqual(daemon.exitCode, null)
  assert.equal(receipt.revocationGeneration, 1)
  assert.equal(f.host.job(intent.missionId).terminationVerified, true)
  await assert.rejects(f.host.startDaemon({ missionId: intent.missionId }), code('native_job_revoked'))
  const envelope = f.host.readEvidence(receipt.evidenceIds[0])
  f.host.evidenceAuthority.verify(receipt.evidenceIds, { kind: 'revocation', subjectHash: envelope.manifest.subjectHash,
    binding, nonce: envelope.manifest.nonce, deploymentDigest: DIGEST, dimensions: ['ongoing_revocation'], now: f.now() })
}))

test('failed containment probe or refused daemon start holds; no lease without proof', withFixture({ probe: { workWrite: 1, ownerHomeWrite: 1, githubReachable: 0 } }, async f => {
  const intent = f.intentFor()
  await f.host.provision(intent)
  await f.host.startDaemon({ missionId: intent.missionId })
  await assert.rejects(f.host.runContainmentProbes({ missionId: intent.missionId }), code('native_containment_probe_failed'))
  const binding = f.bindingFor(intent)
  const proof = await f.host.verifyWorkspace({ ...binding, workspace: intent.workspace, nonce: 'w' })
  await assert.rejects(f.host.acquireLease({ ...binding, workspaceAttestationId: proof.attestationId,
    compiledPolicyHash: 'a'.repeat(64), nonce: 'l' }), code('native_containment_unproven'))
}))
test('network reachable from the sandbox fails the probe', withFixture({ probe: { workWrite: 1, ownerHomeWrite: 0, githubReachable: 1 } }, async f => {
  const intent = f.intentFor()
  await f.host.provision(intent); await f.host.startDaemon({ missionId: intent.missionId })
  await assert.rejects(f.host.runContainmentProbes({ missionId: intent.missionId }), code('native_containment_probe_failed'))
}))
test('daemon that refuses to start (sandbox unavailable) is a hold', withFixture({ daemonStarts: false }, async f => {
  const intent = f.intentFor()
  await f.host.provision(intent)
  await assert.rejects(f.host.startDaemon({ missionId: intent.missionId }), code('native_daemon_refused_start'))
}))
test('budgeted intents cannot get a host lease (no budget enforcement exists)', withFixture({}, async f => {
  const intent = f.intentFor({ policy: { autonomy: 'high', allowCreateRepository: false, allowPush: false, allowPr: false,
    allowMerge: false, allowDeploy: false, budget: { unit: 'credits', capUnits: '10' } } })
  await f.ready(intent)
  const binding = f.bindingFor(intent)
  const proof = await f.host.verifyWorkspace({ ...binding, workspace: intent.workspace, nonce: 'w' })
  await assert.rejects(f.host.acquireLease({ ...binding, workspaceAttestationId: proof.attestationId,
    compiledPolicyHash: 'a'.repeat(64), nonce: 'l' }), code('native_budget_enforcement_unavailable'))
}))
test('unverified SIGKILL fails closed and cannot authorize delivery', withFixture({ unkillable: true }, async f => {
  const intent = await f.ready()
  await assert.rejects(f.host.revoke({ ...f.bindingFor(intent), reason: 'fault' }), code('native_daemon_termination_unverified'))
  assert.equal(f.host.job(intent.missionId).state, 'revoked')
  assert.equal(f.host.job(intent.missionId).terminationVerified, false)
  assert.throws(() => f.host.deliveryInput(intent.missionId), code('native_daemon_still_running'))
}))

test('host key file is created 0600 and unsafe permissions are refused', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'spriite-host-key-')))
  try {
    const path = join(dir, 'host-key')
    const key = loadOrCreateHostKey(path)
    assert.equal(key.asymmetricKeyType, 'ed25519')
    assert.equal(fs.statSync(path).mode & 0o777, 0o600)
    assert.equal(loadOrCreateHostKey(path).export({ type: 'pkcs8', format: 'pem' }), key.export({ type: 'pkcs8', format: 'pem' }))
    fs.chmodSync(path, 0o644)
    assert.throws(() => loadOrCreateHostKey(path), code('native_host_key_permissions_unsafe'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('host qualification record is bound to deployment digest and host key', async () => {
  const signer = generateKeyPairSync('ed25519'), hostKey = generateKeyPairSync('ed25519')
  const now = Date.parse('2026-10-13T12:00:00.000Z')
  const manifest = {
    version: 1, kind: 'host_qualification', qualificationId: 'host-canary-1', machineId: MACHINE,
    deploymentDigest: DIGEST, hostPublicKeySha256: publicKeySha256(hostKey.publicKey), droidVersion: '0.227.0',
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86400000).toISOString(),
    checks: ['containment_probes', 'mission_delivery', 'revocation'].map(name => ({
      name, passed: true, evidenceSha256: 'a'.repeat(64), verifiedAt: new Date(now - 500).toISOString(),
    })),
  }
  const envelope = m => ({ manifest: m, signature: sign(null, Buffer.from(canonical(m)), signer.privateKey).toString('base64') })
  const expected = { publicKey: signer.publicKey, deploymentDigest: DIGEST, hostPublicKey: hostKey.publicKey, machineId: MACHINE, now }
  const record = verifyHostQualification(envelope(manifest), expected)
  assert(isHostQualificationFor(record, { deploymentDigest: DIGEST, hostPublicKey: hostKey.publicKey, now }))
  assert(!isHostQualificationFor(record, { deploymentDigest: 'f'.repeat(64), hostPublicKey: hostKey.publicKey, now }))
  assert(!isHostQualificationFor(record, { deploymentDigest: DIGEST, hostPublicKey: signer.publicKey, now }))
  assert(!isHostQualificationFor({ ...record }, { deploymentDigest: DIGEST, hostPublicKey: hostKey.publicKey, now }))
  for (const bad of [
    { ...manifest, deploymentDigest: 'f'.repeat(64) },
    { ...manifest, hostPublicKeySha256: 'f'.repeat(64) },
    { ...manifest, checks: manifest.checks.map((row, i) => i ? row : { ...row, passed: false }) },
    { ...manifest, checks: manifest.checks.slice(1) },
    { ...manifest, expiresAt: new Date(now - 1).toISOString() },
  ]) assert.throws(() => verifyHostQualification(envelope(bad), expected), code('host_qualification_invalid'))
  assert.throws(() => verifyHostQualification({ ...envelope(manifest), signature: envelope({ ...manifest, droidVersion: 'x' }).signature }, expected),
    code('host_qualification_invalid'))
})

test('usage: pending until next UTC day, 403 unavailable, credits summed for job sessions', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'spriite-usage-')))
  try {
    const apiKeyFile = join(dir, 'key'); fs.writeFileSync(apiKeyFile, 'fk-offline-usage-key-fixture')
    let clock = Date.parse('2026-10-13T20:00:00.000Z'), status = 200, calls = []
    const fetch = async (url, options) => {
      calls.push({ url, auth: options.headers.authorization })
      return { status, ok: status === 200, json: async () => ({ data: [
        { sessionId: 'root', credits: 3.5 }, { sessionId: 'worker', credits: 1.5 }, { sessionId: 'other', credits: 99 },
      ] }) }
    }
    const usage = createNativeUsageClient({ apiKeyFile, fetch, now: () => clock })
    const input = { sessionIds: ['root', 'worker'], completedAt: '2026-10-13T19:00:00.000Z' }
    assert.deepEqual(await usage.query(input), { state: 'pending' })
    assert.equal(calls.length, 0)
    clock = Date.parse('2026-10-14T00:30:00.000Z')
    assert.deepEqual(await usage.query(input), { state: 'available', credits: 5 })
    assert.match(calls[0].url, /\/api\/v1\/analytics\/cost\/me\/query\?queryKey=top_sessions$/)
    assert.equal(calls[0].auth, 'Bearer fk-offline-usage-key-fixture')
    status = 403
    assert.deepEqual(await usage.query(input), { state: 'unavailable' })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('delivery canonicalizes GitHub URL forms and rejects credentials, other hosts and malformed paths', withFixture({}, async f => {
  for (const value of ['owner/repo', 'owner/repo.git', 'https://github.com/owner/repo',
    'https://GitHub.com/owner/repo.git/', 'https://github.com/owner/repo/']) {
    assert.equal(canonicalRepositoryId(value), 'owner/repo')
    assert.equal(repositoryUrlFor(value), 'https://github.com/owner/repo.git')
  }
  for (const bad of ['https://token@github.com/owner/repo', 'https://other.invalid/owner/repo',
    'http://github.com/owner/repo', 'https://github.com/owner/repo?x=1', 'https://github.com/owner/repo/issues',
    'https://github.com/owner/%72epo', 'https://github.com:444/owner/repo', 'owner/.']) {
    assert.throws(() => canonicalRepositoryId(bad), code('native_repository_url_invalid'))
  }
  const intent = f.intentFor()
  intent.workspace.repository = 'https://github.com/owner/repo.git/'
  await f.ready(intent)
  await f.host.revoke({ ...f.bindingFor(intent), reason: 'completed' })
  const target = f.host.deliveryInput(intent.missionId)
  assert.equal(target.repository, 'owner/repo')
  assert.equal(f.host.job(intent.missionId).repository, intent.workspace.repository) // Approved identity is not rewritten.
}))

test('denyRead includes actual custom API key file and canonical sensitive aliases', withFixture({}, async f => {
  const alias = join(f.base, 'key-alias')
  fs.symlinkSync(f.keyFile, alias)
  const settings = nativeSandboxSettings({
    workDir: '/work', ownerHome: f.ownerHome, root: f.root, apiKeyFile: alias,
    sensitiveFiles: [join(f.base, 'nested', '..', 'factory-key')],
  })
  assert(settings.sandbox.filesystem.denyRead.includes(alias))
  assert(settings.sandbox.filesystem.denyRead.includes(f.keyFile))
  assert(settings.sandbox.filesystem.denyRead.every(path => !path.includes('/../')))
}))

test('fresh host restart revokes verified orphan only and permanently fences dirty recovery', withFixture({}, async f => {
  const intent = await f.ready()
  const old = f.host.job(intent.missionId)
  f.state.head = 'd'.repeat(40) // Legitimate in-progress Mission, not a clean initial checkout.
  const expected = `/fixture/bin/droid daemon --host 127.0.0.1 --port 40123 --parent-pid 4242 --settings ${join(old.homeDir, '.factory', 'settings.json')}`
  let command = expected
  const signals = []
  const restarted = f.restart({
    inspectProcess: async () => command,
    signalProcess: (pid, signal) => { signals.push([pid, signal]); if (signal === 'SIGKILL') command = null },
  })
  assert.deepEqual(await restarted.recoverAfterRestart(), [intent.missionId])
  assert.deepEqual(signals, [[old.daemon.pid, 'SIGTERM'], [old.daemon.pid, 'SIGKILL']])
  assert.equal(restarted.job(intent.missionId).state, 'recovery_required')
  assert.equal(restarted.job(intent.missionId).terminationVerified, true)
  assert.equal(restarted.job(intent.missionId).recoveryReason, 'Broker restarted; mission must be re-prepared')
  await assert.rejects(restarted.startDaemon({ missionId: intent.missionId }), code('native_broker_restarted_reprepare_required'))
  await assert.rejects(restarted.verifyWorkspace({ ...f.bindingFor(intent), workspace: intent.workspace, nonce: 'w' }), code('native_broker_restarted_reprepare_required'))
  assert.throws(() => restarted.deliveryInput(intent.missionId), code('native_orphan_termination_unverified'))
  assert.equal(f.log.filter(row => row === 'clone').length, 1)
}))

test('restart never signals a reused or unverifiable PID and cannot claim orphan termination', withFixture({}, async f => {
  const intent = await f.ready()
  const signals = []
  const restarted = f.restart({
    inspectProcess: async () => '/usr/bin/sleep 1000',
    signalProcess: (...args) => { signals.push(args) },
  })
  await restarted.recoverAfterRestart()
  assert.deepEqual(signals, [])
  assert.equal(restarted.job(intent.missionId).terminationVerified, false)
  await assert.rejects(restarted.revoke({ ...f.bindingFor(intent), reason: 'restart' }), code('native_orphan_termination_unverified'))
  assert.throws(() => restarted.deliveryInput(intent.missionId), code('native_orphan_termination_unverified'))
}))

test('opt-in production composition starts no SDK, daemon or service and validates secrets', withFixture({}, async f => {
  const extensionTokenFile = join(f.base, 'extension-token')
  fs.writeFileSync(extensionTokenFile, 'fixture-token', { mode: 0o600 })
  assert.throws(() => createProductionNativeComposition({ enabled: false }), code('native_host_opt_in_required'))
  const root = join(f.base, 'composition')
  const configuration = {
    enabled: true, root, ownerId: 'owner-host', machineId: MACHINE, deploymentDigest: DIGEST,
    factoryApiKeyFile: f.keyFile, extensionTokenFile,
    droidPath: process.execPath, ghPath: '/usr/bin/git', allowedModelIds: ['m'],
    allowedToolIds: ['Read', 'RecommendMission', 'ExitMissionPlanning', 'Task', 'Script'],
  }
  assert.throws(() => createProductionNativeComposition(configuration), code('native_deployment_digest_mismatch'))
  configuration.deploymentDigest = productionDeploymentBinding(configuration).deploymentDigest
  const composition = createProductionNativeComposition(configuration)
  assert.deepEqual(fs.readdirSync(root), ['host-key'])
  assert.equal(composition.transport.support.childAttention, false)
  assert.equal(composition.transport.support.cancel, false)
  assert.equal(readPrivateSecretFile(extensionTokenFile), 'fixture-token')
  fs.chmodSync(extensionTokenFile, 0o644)
  assert.throws(() => readPrivateSecretFile(extensionTokenFile), code('native_secret_file_unsafe'))
  fs.chmodSync(extensionTokenFile, 0o600)
  const alias = join(f.base, 'alias')
  fs.symlinkSync(extensionTokenFile, alias)
  assert.throws(() => readPrivateSecretFile(alias), code('native_secret_file_unsafe'))
}))

test('production loopback websocket binds exact URL, forwards events once and never reconnects', async () => {
  class Socket extends EventTarget {
    static latest
    constructor(url) {
      super(); this.url = url; this.readyState = 0; this.sent = []; Socket.latest = this
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) })
    }
    send(data) { this.sent.push(data) }
    close() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: 'not exposed' })) }
    message(data) { this.dispatchEvent(Object.assign(new Event('message'), { data })) }
  }
  const url = 'ws://127.0.0.1:40123'
  for (const invalid of ['ws://other.invalid:40123', 'ws://user@127.0.0.1:40123', 'wss://127.0.0.1:40123',
    'ws://127.0.0.1:40123/other']) assert.throws(() => createHostLoopbackSocket({ url: invalid }), code('native_daemon_url_invalid'))
  const wire = createHostLoopbackSocket({ url, WebSocketClass: Socket })
  const received = []; wire.on('message', value => received.push(value))
  await assert.rejects(wire.connect('ws://127.0.0.1:40124'), code('native_socket_connection_refused'))
  await wire.connect(url)
  assert.equal(wire.isConnected(), true); assert.equal(wire.getTransportKind(), 'websocket')
  assert.equal(wire.isRelayConnection(), false); assert(wire.getConnectionId())
  wire.send('fixture-frame'); assert.deepEqual(Socket.latest.sent, ['fixture-frame'])
  Socket.latest.message('fixture-response'); assert.deepEqual(received, ['fixture-response'])
  Socket.latest.message(new Uint8Array([0]))
  assert.equal(wire.isConnected(), false)
  assert.deepEqual(received, ['fixture-response'])
  assert.throws(() => wire.send('late'), code('sdk_disconnected'))
  await assert.rejects(wire.connect(url), code('native_socket_connection_refused'))
})

test('host Git is pinned despite owner PATH and runtime changes prevent invocation', async () => {
  const calls = [], env = { PATH: '/dummy-untrusted-first:/usr/bin', HOME: '/dummy-owner' }
  let permitted = true, validations = 0
  const runner = createPinnedHostGitRunner({
    gitPath: '/usr/bin/git',
    validateRuntime() { validations++; if (!permitted) throw new BrokerError('native_deployment_digest_mismatch', 503) },
    execFilePort(bin, args, options, callback) {
      calls.push({ bin, args, options }); callback(null, 'configured identity\n')
    },
  })
  assert.deepEqual(await runner({ args: ['var', 'GIT_AUTHOR_IDENT'], cwd: '/dummy-owner', env }),
    { stdout: 'configured identity\n', exitCode: 0 })
  assert.equal(calls[0].bin, '/usr/bin/git')
  assert.equal(calls[0].options.env, env)
  assert.equal(calls[0].options.shell, false)
  permitted = false
  await assert.rejects(runner({ args: ['status'], cwd: '/dummy-work', env }), code('native_deployment_digest_mismatch'))
  assert.equal(calls.length, 1); assert.equal(validations, 2)
  assert.throws(() => createPinnedHostGitRunner({ gitPath: 'git' }), code('native_host_configuration_required'))
})

test('renewLeases never extends send authority past the signed lease expiry', withFixture({ trustedHost: true }, async f => {
  const { binding, lease } = await f.leased()
  const send = () => f.host.authorizeSend({ ...binding, leaseId: lease.leaseId, connectionId: 'c', operation: 'owner_turn',
    sessionId: 's', requestHash: 'a'.repeat(64), nonce: 'n' })
  const signed = Date.parse(lease.expiresAt)
  f.advance(signed - f.now() - 1000)
  f.host.renewLeases()
  const permit = await send()
  assert(Date.parse(permit.expiresAt) <= signed, 'a renewed permit must not outlive the signed lease')
  f.advance(2000)
  f.host.renewLeases()
  await assert.rejects(send(), code('native_lease_expired_reacquire_required'))
}))

test('forget during in-flight job transport closes it and never installs it', async () => {
  let resolve, closed = 0
  const transport = createHostRoutedTransport({
    host: { daemonFor: () => null, workspaceHostFor: () => null }, version: 'v', support: {},
    createAdmissionTransport: async () => ({}),
    createJobTransport: () => new Promise(r => { resolve = r }),
  })
  const call = transport.observe({}, { missionId: 'm1' })
  transport.forget('m1')
  resolve({ observe: async () => 'stale', close: () => { closed++ }, validateProviderRecord: () => 'stale' })
  await assert.rejects(call, code('native_provider_forgotten'))
  assert.equal(closed, 1)
  assert.throws(() => transport.validateProviderRecord({}, { missionId: 'm1' }), code('native_provider_not_ready'))
})

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
let passed = 0
for (const { name, fn } of tests) {
  try { await fn(); passed++; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL: ${name}`); console.error(error); process.exitCode = 1 }
}
console.log(`Native host offline checks: ${passed}/${tests.length} passed; fake spawn/git, no droid, network or model call.`)

}
