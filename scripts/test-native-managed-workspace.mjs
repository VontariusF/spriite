/**
 * Explicit app/host allocation contract. Actual broker + daemon-free production
 * admission provider; injected git/spawn fixtures only. No model or remote writes.
 * node --import ./scripts/ts-resolve.mjs scripts/test-native-managed-workspace.mjs
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { NativeAdmissionCoordinator } from '../src/native/admission.ts'
import { nativeFingerprint } from '../src/native/fingerprint.ts'
import { decodeNativeProfile } from '../src/native/decode.ts'
import { nativeProfileOf, PrefsVault } from '../src/state/prefs.ts'
import { canonicalNativeHostRoot, nativeJobCheckout } from '../src/native/workspace.ts'
import { validateCanonicalWorkspacePath } from '../broker/native-workspace.mjs'
import { fixture as hostFixture } from './test-native-host.mjs'
import { NativeBroker } from '../broker/broker.mjs'
import { createHostRoutedTransport, NATIVE_NEW_REPOSITORY_BASE } from '../broker/native-host.mjs'
import { createHostAdmissionClient, createHostLoopbackSocket } from '../broker/host-production.mjs'
import { createInjectedNativeProvider } from '../broker/sdk-provider.mjs'
import { SDK_TRANSPORT_VERSION } from '../broker/sdk-wire.mjs'
import { compileNativePolicy } from '../broker/native-policy.mjs'
import { validateWorkspaceProof } from '../broker/native-workspace.mjs'
import { validateEnforcementLease } from '../broker/native-boundary.mjs'
import { hash } from '../broker/validation.mjs'
import { Supervisor } from '../src/runtime/supervisor.ts'
import { createRuntimeStore } from '../src/state/runtime-store.ts'
import { initialSpriiteState, validateSpriiteState } from '../src/domain/state.ts'
import { assembleRecords, mergeRestore } from '../src/state/archive.ts'
import { SETTINGS, TestKV, makeClients } from './lib/runtime-fake.mjs'

let groups = 0
const test = async (label, fn) => { await fn(); groups++; console.log(`PASS ${label}`) }
const defaults = { createPrivateRepositories: false, pushBranch: false, openPr: false, mergeAfterChecks: false }
const profileFor = root => ({ brokerUrl: 'https://broker.fixture.invalid', ownerId: 'owner-host',
  machineId: 'machine-host', cwd: '/retained/static-checkout', baseRef: 'refs/heads/main',
  workspaceMode: 'host_managed', hostRoot: root })
const settings = { modelId: 'm', reasoningEffort: 'high', workerModel: 'm', workerReasoningEffort: 'medium',
  validationWorkerModel: 'm', validationWorkerReasoningEffort: 'high', restrictToolIds: ['Read'],
  skipScrutiny: false, skipUserTesting: false }
function requestFor(profile, destination = { kind: 'existing', account: 'owner', name: 'repo',
  visibility: 'private', initialization: 'empty' }) {
  return { protocolVersion: 1, brokerUrl: profile.brokerUrl, ownerId: profile.ownerId,
    goal: '  Exact owner words\nand references  ', scopeRevision: 1, operation: 'implement',
    destination, workspace: { machineId: profile.machineId,
      cwd: profile.workspaceMode === 'host_managed' ? profile.hostRoot : profile.cwd,
      repository: `https://github.com/${destination.account}/${destination.name}`, baseRef: profile.baseRef },
    references: ['https://reference.invalid/not-destination'], acceptanceCriteria: ['Fixture passes'],
    restrictions: ['No deploy'], policy: { autonomy: 'high', allowCreateRepository: destination.kind === 'new_repository',
      // A new repository is created and seeded by pushing, so it needs push.
      allowPush: destination.kind === 'new_repository', allowPr: false, allowMerge: false, allowDeploy: false }, settings: structuredClone(settings) }
}
function synthetic(profile = profileFor('/fixture/native')) {
  const state = { profile, defaults: { ...defaults }, credential: 'synthetic', drafts: [], change: null }
  let count = 0
  const coordinator = new NativeAdmissionCoordinator({
    profile: () => state.profile, deliveryDefaults: () => state.defaults, credential: () => state.credential,
    mint: kind => `${kind}-${++count}`, client: () => ({
      async inspectAdmission(draft) {
        state.drafts.push(structuredClone(draft))
        const response = { protocolVersion: 1, ownerId: draft.ownerId, missionId: draft.missionId,
          draftHash: await nativeFingerprint(draft), workspace: { ...draft.workspace, baseSha: 'c'.repeat(40) },
          prospectiveSettings: structuredClone(draft.settings), observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 59000).toISOString(), launchEligible: true, holds: [] }
        state.change?.(response, draft)
        return response
      },
    }),
  })
  return { state, coordinator, request: requestFor(profile) }
}
const approved = (request, preview) => ({ ...request, workspace: preview.workspace, settings: preview.prospectiveSettings,
  admission: preview, scopeApproved: true, highAutonomyApproved: true })

await test('explicit profile mode persists independently of the untouched static cwd', async () => {
  const staticProfile = profileFor('/fixture/native')
  delete staticProfile.workspaceMode; delete staticProfile.hostRoot
  assert.deepEqual(nativeProfileOf(staticProfile), staticProfile)
  assert.deepEqual(decodeNativeProfile(staticProfile), staticProfile)
  const storage = new Map()
  const gateway = { call: fn => fn({ getLocalStorage: async k => storage.get(k) ?? '',
    setLocalStorage: async (k, v) => { storage.set(k, v); return true } }) }
  const prefs = new PrefsVault(gateway)
  await prefs.load()
  const managed = profileFor('/fixture/native')
  assert.equal(await prefs.setNativeLaunchProfile(managed), true)
  const restored = new PrefsVault(gateway)
  await restored.load()
  assert.deepEqual(restored.nativeLaunchProfile, managed)
  assert.equal(restored.nativeLaunchProfile.cwd, staticProfile.cwd)
  assert.deepEqual(decodeNativeProfile({ ...managed, cwd: '' }), { ...managed, cwd: '' })
  assert.equal(nativeProfileOf({ ...managed, workspaceMode: 'automatic' }), null)
  assert.equal(decodeNativeProfile({ ...staticProfile, hostRoot: '/fixture/native' }), null)
})

await test('unsafe roots and ID traversal are refused without normalization or broker calls', async () => {
  for (const root of ['/', '', 'relative/root', '~/native', '/fixture//native', '/fixture/native/',
    '/fixture/./native', '/fixture/a/../native', '/fixture\\native', '/fixture/\nname', ' /fixture/native']) {
    assert.equal(canonicalNativeHostRoot(root), false, JSON.stringify(root))
    assert.equal(nativeProfileOf(profileFor(root)), null)
    assert.equal(decodeNativeProfile(profileFor(root)), null)
    const fixture = synthetic(profileFor(root))
    await assert.rejects(() => fixture.coordinator.inspect(fixture.request))
    assert.equal(fixture.state.drafts.length, 0)
  }
  for (const id of ['..', '.', '../sibling', 'mission/work', '/absolute', 'mission\\work', '']) {
    assert.equal(nativeJobCheckout(profileFor('/fixture/native'), id), null, id)
  }
  for (const root of ['/fixture/native', '/private/tmp/native', '/Users/Owner/native host']) {
    assert.equal(canonicalNativeHostRoot(root), true)
    assert.equal(validateCanonicalWorkspacePath(root), root)
  }
})

await test('post-mint allocation hashes the exact checkout and take is single-use', async () => {
  const f = synthetic()
  const preview = await f.coordinator.inspect(f.request)
  const draft = f.state.drafts[0]
  assert.equal(preview.missionId, 'mission-1')
  assert.equal(draft.workspace.cwd, '/fixture/native/jobs/mission-1/work')
  assert.equal(draft.workspace.repository, f.request.workspace.repository, 'existing URL stays strict')
  assert.equal(preview.draftHash, await nativeFingerprint(draft))
  assert.equal(preview.draftHash, hash(draft))
  assert.notEqual(preview.draftHash, hash({ ...draft, workspace: f.request.workspace }))
  const request = approved(f.request, preview)
  const result = f.coordinator.take(request)
  assert.equal(result.missionId, preview.missionId)
  assert.equal(result.commandId, 'command-2')
  assert.equal(result.workspace.cwd, draft.workspace.cwd)
  assert.equal(result.goal, f.request.goal)
  assert.equal(f.coordinator.take(request), null)
})

await test('crafted sibling/root/traversal previews and takes never inherit allocation authority', async () => {
  for (const cwd of ['/fixture/native', '/fixture/native/jobs/sibling/work',
    '/other/jobs/mission-1/work', '/fixture/native/jobs/mission-1/work/../work',
    '/fixture/native//jobs/mission-1/work', '/fixture/native/jobs/mission-1/work/child']) {
    const f = synthetic()
    f.state.change = response => { response.workspace.cwd = cwd }
    await assert.rejects(() => f.coordinator.inspect(f.request), /does not match/)
    const g = synthetic()
    const p = await g.coordinator.inspect(g.request)
    assert.equal(g.coordinator.take({ ...approved(g.request, p), workspace: { ...p.workspace, cwd } }), null)
  }
  const f = synthetic()
  f.state.change = response => { response.workspace.repository = 'https://github.com/other/repo' }
  await assert.rejects(() => f.coordinator.inspect(f.request))
  const mutating = synthetic()
  mutating.state.change = (response, draft) => {
    draft.workspace.cwd = '/fixture/native/jobs/sibling/work'
    response.workspace.cwd = draft.workspace.cwd
    response.draftHash = hash(draft)
  }
  await assert.rejects(() => mutating.coordinator.inspect(mutating.request),
    /does not match/, 'a rewritten client-owned draft cannot change the private allocation/hash authority')
})

await test('root/mode/profile/default/credential changes and either missing consent revoke review', async () => {
  for (const change of [
    state => { state.profile = { ...state.profile, hostRoot: '/changed/root' } },
    state => { const { workspaceMode, hostRoot, ...profile } = state.profile; state.profile = profile },
    state => { state.profile = { ...state.profile, cwd: '/different-retained-static-cwd' } },
    state => { state.defaults.pushBranch = true },
    state => { state.credential = 'rotated' },
  ]) {
    const f = synthetic()
    const preview = await f.coordinator.inspect(f.request)
    change(f.state)
    assert.equal(f.coordinator.take(approved(f.request, preview)), null)
  }
  for (const consent of ['scopeApproved', 'highAutonomyApproved']) {
    const f = synthetic()
    const preview = await f.coordinator.inspect(f.request)
    assert.equal(f.coordinator.take({ ...approved(f.request, preview), [consent]: false }), null)
  }
  const f = synthetic()
  f.state.change = () => { f.state.profile.hostRoot = '/changed/root' }
  await assert.rejects(() => f.coordinator.inspect(f.request))
})

await test('legacy static profiles still send/review their exact cwd and URL without allocation', async () => {
  const profile = profileFor('/unused')
  delete profile.workspaceMode; delete profile.hostRoot
  const f = synthetic(profile)
  const preview = await f.coordinator.inspect(f.request)
  assert.equal(f.state.drafts[0].workspace.cwd, profile.cwd)
  assert.equal(f.coordinator.take(approved(f.request, preview)).workspace.cwd, profile.cwd)
  const g = synthetic(profile)
  g.request.destination.kind = 'new_repository'; g.request.policy.allowCreateRepository = true
  const p = await g.coordinator.inspect(g.request)
  assert.equal(g.state.drafts[0].workspace.repository, 'https://github.com/owner/repo')
  assert.equal(g.coordinator.take(approved(g.request, p)).workspace.repository, 'https://github.com/owner/repo')
})

await test('managed new-repo identity is exactly the named owner/name, never a URL/source substitution', async () => {
  const f = synthetic()
  f.request.destination.kind = 'new_repository'
  f.request.policy.allowCreateRepository = true
  const p = await f.coordinator.inspect(f.request)
  assert.equal(f.state.drafts[0].workspace.repository, 'owner/repo')
  assert.equal(f.coordinator.take(approved(f.request, p)).workspace.repository, 'owner/repo')
  for (const repository of ['https://github.com/other/repo', 'https://github.com/owner/repo.git',
    'owner/source', 'https://github.com/owner/repo/']) {
    const bad = synthetic()
    bad.request.destination.kind = 'new_repository'
    bad.request.policy.allowCreateRepository = true
    bad.request.workspace.repository = repository
    await assert.rejects(() => bad.coordinator.inspect(bad.request), /destination/)
    assert.equal(bad.state.drafts.length, 0)
  }
  const profile = profileFor('/fixture/native')
  let called = false
  const craftedMint = new NativeAdmissionCoordinator({
    profile: () => profile, credential: () => 'synthetic', mint: () => '../sibling',
    client: () => ({ inspectAdmission() { called = true; throw new Error('Must not reach broker') } }),
  })
  await assert.rejects(() => craftedMint.inspect(requestFor(profile)), /allocation/)
  assert.equal(called, false)
})

await test('actual daemon-free broker/host inspection accepts derived existing/new destinations and preserves all holds', async () => {
  for (const kind of ['existing', 'new_repository']) {
    const h = hostFixture()
    h.advance(Date.now() - h.now())
    let executions = 0
    const transport = createHostRoutedTransport({
      host: h.host, version: SDK_TRANSPORT_VERSION, support: { launch: true, rootAttention: true },
      createJobTransport() { executions++; throw new Error('No execution in admission') },
      createAdmissionTransport(input) { return createInjectedNativeProvider({
        ...input, deployment: h.deployment, evidenceAuthority: h.host.evidenceAuthority,
        hostPublicKey: h.host.publicKey, now: h.now,
        transport: createHostLoopbackSocket({ url: 'ws://127.0.0.1:1' }), createClient: createHostAdmissionClient,
        safeExtensionTokenGetter: async () => { throw new Error('No extension credential read') },
        policy: { compileNativePolicy, validateWorkspaceProof, validateEnforcementLease },
      }) },
    })
    const broker = await NativeBroker.open({ directory: join(h.base, 'broker'), ownerId: 'owner-host',
      machineId: 'machine-host', bearerToken: 'offline-fixture', host: h.host, delivery: h.delivery,
      deploymentDigest: h.deployment.deploymentDigest, transport, now: h.now })
    try {
      const profile = profileFor(h.host.root)
      const destination = { kind, account: 'owner', name: kind === 'existing' ? 'repo' : 'new-repo',
        visibility: 'private', initialization: 'empty' }
      const request = requestFor(profile, destination)
      request.settings = h.intentFor().settings
      let sent
      const coordinator = new NativeAdmissionCoordinator({
        profile: () => profile, deliveryDefaults: () => ({ ...defaults, createPrivateRepositories: kind === 'new_repository', pushBranch: kind === 'new_repository' }),
        credential: () => 'offline-fixture', now: h.now, mint: type => `${type}-allocated-${kind}`,
        client: () => ({ inspectAdmission: draft => { sent = structuredClone(draft); return broker.inspectAdmission(draft) } }),
      })
      const preview = await coordinator.inspect(request)
      assert.equal(sent.workspace.cwd, h.host.workDirFor(preview.missionId))
      assert.equal(preview.workspace.cwd, sent.workspace.cwd)
      assert.equal(preview.draftHash, hash(sent))
      assert.equal(preview.launchEligible, false)
      assert.equal(coordinator.take(approved(request, preview)), null, 'holds cannot be waived by either consent')
      for (const hold of ['native_credential_isolation_unproven', 'sdk_mission_settings_unconfirmed',
        'native_child_attention', 'passive_authoritative_pending_recovery']) assert.ok(preview.holds.includes(hold), hold)
      assert.equal(h.spawns.length, 0); assert.equal(h.delivery.calls.length, 0); assert.equal(executions, 0)
      assert.equal(Object.keys(broker.store.data.jobs).length, 0)
      if (kind === 'new_repository') {
        assert.equal(sent.workspace.repository, 'owner/new-repo')
        assert.equal(preview.workspace.baseSha, 'c'.repeat(40)) // Actual fixture seed, not a prescribed production SHA.
        assert.equal(h.gitCalls.filter(row => row.args.includes('commit')).length, 1)
        assert.equal(h.host.job(preview.missionId).localSeed, true)
        assert.equal(h.host.job(preview.missionId).created, false)
        assert.ok(!preview.holds.includes('native_prospective_workspace_only'))
      } else {
        assert.equal(sent.workspace.repository, 'https://github.com/owner/repo')
        assert.equal(h.host.job(preview.missionId).state, 'provisioned')
      }
    } finally { broker.close(); h.cleanup() }
  }
})

await test('supervisor exact binding, held promotion, checkpoint and archive preserve managed ownership', async () => {
  const profile = profileFor('/fixture/native')
  const kv = new TestKV(), clients = makeClients()
  const config = { ...SETTINGS, nativeProfile: profile, nativeDelivery: { ...defaults },
    sessionSettings: {}, executionBackend: 'factory_native' }
  const supervisor = new Supervisor({ kv, clients, store: createRuntimeStore(kv), nativeClient: null,
    settings: () => config, emitView: () => {} })
  await supervisor.boot()
  const request = requestFor(profile)
  const missionId = 'managed-supervisor'
  const { brokerUrl: _, ...body } = request
  const intent = { ...body, missionId, commandId: 'managed-command', scopeApproved: true, highAutonomyApproved: true,
    workspace: { ...body.workspace, cwd: nativeJobCheckout(profile, missionId) } }
  for (const cwd of [profile.hostRoot, profile.cwd, '/fixture/native/jobs/sibling/work',
    '/fixture/native/jobs/managed-supervisor/work/../work', '/other/jobs/managed-supervisor/work']) {
    assert.equal((await supervisor.submitNativeIntent({ ...intent, workspace: { ...intent.workspace, cwd } })).receipt, 'rejected')
  }
  assert.equal((await supervisor.submitNativeIntent(intent)).receipt, 'saved')
  assert.ok(!supervisor.missions[0].config.nativeQuarantine)
  assert.ok(validateSpriiteState(supervisor.missionStore.current))
  const sources = { missions: () => supervisor.missions, snapshotFor: id => supervisor.engineSnapshotFor(id),
    nativeCacheFor: id => supervisor.nativeCacheFor(id), chatTailFor: () => [], feed: () => [], receipts: () => [] }
  const rows = [...assembleRecords(`mission:${missionId}`, sources), ...assembleRecords(`snapshot:${missionId}`, sources)]
  const restored = mergeRestore(initialSpriiteState(), rows)
  assert.equal(restored.applied, 1)
  assert.deepEqual(restored.state.missions[0].config.nativeProfile, profile)
  assert.equal(restored.state.missions[0].config.nativeIntent.workspace.cwd, intent.workspace.cwd)
  assert.ok(!validateSpriiteState(restored.state).missions[0].config.nativeQuarantine)
  const held = await supervisor.submitCommand({ text: '  Held exact goal\nand reference  ', source: 'x',
    sourceEventId: 'managed-held', dedupeKey: 'managed-held', contextRefs: ['exact-ref'] })
  const prior = supervisor.missions.find(m => m.missionId === held.missionId).config.nativeIntent
  assert.equal(prior.workspace.cwd, nativeJobCheckout(profile, held.missionId))
  const promoted = { ...prior, missionId: 'managed-promotion', commandId: 'managed-promotion-command',
    workspace: { ...prior.workspace, cwd: nativeJobCheckout(profile, 'managed-promotion') },
    settings: structuredClone(settings), scopeApproved: true, highAutonomyApproved: true }
  assert.equal((await supervisor.promoteHeldNativeIntent(held.missionId,
    { ...promoted, workspace: prior.workspace })).receipt, 'rejected')
  const store = supervisor.missionStore
  const commit = store.commit.bind(store)
  let rotateRoot = true
  store.commit = mutate => commit(state => {
    if (rotateRoot) { config.nativeProfile = { ...profile, hostRoot: '/changed/native' }; rotateRoot = false }
    return mutate(state)
  })
  assert.equal((await supervisor.promoteHeldNativeIntent(held.missionId, promoted)).receipt, 'rejected',
    'root rotation while retiring/serializing cannot save the old reviewed allocation')
  assert.equal(supervisor.missions.some(m => m.missionId === promoted.missionId), false)
  store.commit = commit
  config.nativeProfile = profile
  assert.equal((await supervisor.promoteHeldNativeIntent(held.missionId, promoted)).receipt, 'saved')
  const saved = supervisor.missions.find(m => m.missionId === promoted.missionId).config.nativeIntent
  assert.equal(saved.goal, prior.goal); assert.deepEqual(saved.references, prior.references)
  const newId = 'managed-new-repo'
  config.nativeDelivery.createPrivateRepositories = true
  const newIntent = { ...intent, missionId: newId, commandId: 'managed-new-command',
    destination: { ...request.destination, kind: 'new_repository' }, policy: { ...intent.policy, allowCreateRepository: true, allowPush: true },
    workspace: { ...intent.workspace, cwd: nativeJobCheckout(profile, newId), repository: 'owner/repo' } }
  assert.equal((await supervisor.submitNativeIntent({ ...newIntent,
    workspace: { ...newIntent.workspace, repository: 'https://github.com/owner/repo' } })).receipt, 'rejected')
  assert.equal((await supervisor.submitNativeIntent(newIntent)).receipt, 'saved', 'recorded locally; host still gates execution')
  for (const key of ['createSession', 'postMessage', 'cursorAgent', 'cursorRun', 'createRepo']) assert.equal(clients.counts[key], 0)
  await supervisor.flush()
  const rebooted = new Supervisor({ kv, clients, store: createRuntimeStore(kv), nativeClient: null,
    settings: () => config, emitView: () => {} })
  await rebooted.boot(); await rebooted.flush()
  assert.ok(rebooted.missions.every(m => !m.config.nativeQuarantine))
})

console.log(`Managed native workspace: ${groups}/${groups} offline groups passed; no daemon/model/remote writes.`)
