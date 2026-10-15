/**
 * Automatic launch of held X requests (src/native/x-auto.ts): the request it
 * builds, the broker-hold gate, once-per-intent attempts, and the off switch.
 * Offline: fake admission and promotion, no broker or network.
 */
import assert from 'node:assert/strict'
import { XAutoLauncher, decodeNativeXAutoTemplate, xAutoAdmissionRequest } from '../src/native/x-auto.ts'
import { derivedRepositoryName } from '../src/native/delivery.ts'

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log(`  PASS: ${name}`) }

const profile = { brokerUrl: 'https://mac.example.ts.net:47822', ownerId: 'owner-1', machineId: 'machine-1',
  cwd: '/host/root', baseRef: 'refs/heads/main', workspaceMode: 'host_managed', hostRoot: '/host/root' }
const defaults = { createPrivateRepositories: true, pushBranch: true, openPr: true, mergeAfterChecks: false }
const template = {
  settings: { modelId: 'm', reasoningEffort: 'medium', workerModel: 'm', workerReasoningEffort: 'medium',
    validationWorkerModel: 'm', validationWorkerReasoningEffort: 'medium',
    restrictToolIds: ['Read', 'SpawnAgent', 'SendMessage', 'ListAgents', 'InterruptAgent'] },
  acceptanceCriteria: ['The request in the post works and its tests pass'], restrictions: ['no deploy'],
}
const heldExisting = { missionId: 'held-1', origin: 'x', goal: 'Fix the header\nexactly as posted ', references: ['x:post:1'],
  repository: 'https://github.com/owner/site', createdAt: '2026-10-14T10:00:00.000Z' }
const heldNew = { missionId: 'held-2', origin: 'x', goal: 'Build a habit tracker', references: [],
  repository: 'https://github.com/owner/habit-tracker-12345', createdAt: '2026-10-14T10:01:00.000Z',
  destination: { kind: 'new_repository', account: 'owner', name: 'habit-tracker-12345', visibility: 'private', initialization: 'empty' } }
const preview = (request, extra = {}) => ({ protocolVersion: 1, missionId: 'new-mission', ownerId: request.ownerId, draftHash: 'a'.repeat(64),
  workspace: { ...request.workspace, cwd: '/host/root/jobs/new-mission/work', baseSha: 'b'.repeat(40) },
  prospectiveSettings: request.settings, observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30000).toISOString(),
  launchEligible: true, holds: [], ...extra })

const launcher = ({ enabled = true, held = [heldExisting], inspect, promote } = {}) => {
  const calls = { inspect: [], promote: [] }
  const l = new XAutoLauncher({
    prefs: () => ({ enabled, template: decodeNativeXAutoTemplate(template) }),
    profile: () => profile, deliveryDefaults: () => defaults, held: () => held,
    inspect: async r => { calls.inspect.push(r); return inspect ? inspect(r) : preview(r) },
    promote: async (id, r) => { calls.promote.push([id, r]); return promote ? promote(id, r) : { status: 'saved', missionId: `launched-${id}` } },
  })
  return { l, calls }
}

await test('the request carries the held goal byte-for-byte, its references and destination', () => {
  const r = xAutoAdmissionRequest(heldExisting, profile, defaults, decodeNativeXAutoTemplate(template))
  assert.equal(r.goal, heldExisting.goal)
  assert.deepEqual(r.references, heldExisting.references)
  assert.deepEqual([r.destination.kind, r.destination.account, r.destination.name], ['existing', 'owner', 'site'])
  assert.equal(r.workspace.repository, 'https://github.com/owner/site')
  assert.equal(r.workspace.cwd, '/host/root')
  assert.equal(r.policy.allowPush, true); assert.equal(r.policy.allowPr, true); assert.equal(r.policy.allowMerge, false)
  assert.equal(r.policy.allowCreateRepository, false, 'an existing repository is never created')
  assert.equal(r.settings.skipScrutiny, false); assert.equal(r.settings.skipUserTesting, false)
})
await test('a new-repository request needs private-repository creation allowed', () => {
  const r = xAutoAdmissionRequest(heldNew, profile, defaults, decodeNativeXAutoTemplate(template))
  assert.equal(r.destination.kind, 'new_repository'); assert.equal(r.policy.allowCreateRepository, true)
  assert.equal(xAutoAdmissionRequest(heldNew, profile, { ...defaults, createPrivateRepositories: false }, decodeNativeXAutoTemplate(template)), null)
})
await test('an invalid template is refused, never partially used', () => {
  assert.equal(decodeNativeXAutoTemplate({ ...template, acceptanceCriteria: [] }), null)
  assert.equal(decodeNativeXAutoTemplate({ ...template, settings: { ...template.settings, restrictToolIds: [] } }), null)
  assert.equal(decodeNativeXAutoTemplate({ ...template, settings: { ...template.settings, modelId: '' } }), null)
  assert.ok(decodeNativeXAutoTemplate(template))
})
await test('an eligible preview launches through promotion with both consents', async () => {
  const { l, calls } = launcher()
  const [outcome] = await l.tick()
  assert.equal(outcome.status, 'launched'); assert.equal(outcome.newMissionId, 'launched-held-1')
  const [, approved] = calls.promote[0]
  assert.equal(approved.scopeApproved, true); assert.equal(approved.highAutonomyApproved, true)
  assert.equal(approved.workspace.cwd, '/host/root/jobs/new-mission/work', 'the reviewed workspace, not the draft root')
})
await test('any broker hold keeps the request held, with the reason, and nothing is promoted', async () => {
  const { l, calls } = launcher({ inspect: r => preview(r, { launchEligible: false, holds: ['native_destination_unverified'] }) })
  const [outcome] = await l.tick()
  assert.equal(outcome.status, 'held'); assert.match(outcome.reason, /native_destination_unverified/)
  assert.equal(calls.promote.length, 0)
  assert.match(l.reasonFor('held-1'), /native_destination_unverified/)
})
await test('each held request is tried once: no retry loop against the broker', async () => {
  const { l, calls } = launcher({ inspect: () => { throw new Error('broker unreachable') } })
  await l.tick(); await l.tick(); await l.tick()
  assert.equal(calls.inspect.length, 1)
})
await test('off, or not from X: nothing is inspected', async () => {
  const off = launcher({ enabled: false }); await off.l.tick(); assert.equal(off.calls.inspect.length, 0)
  const generic = launcher({ held: [{ ...heldExisting, origin: 'generic' }] }); await generic.l.tick()
  assert.equal(generic.calls.inspect.length, 0)
})
await test('a failed promotion stays held', async () => {
  const { l } = launcher({ promote: () => ({ status: 'failed', reason: 'The goal must match the held request exactly' }) })
  const [outcome] = await l.tick()
  assert.equal(outcome.status, 'held'); assert.match(outcome.reason, /must match/)
})
await test('derived repository names are stable per post and distinct across posts', () => {
  const a = derivedRepositoryName('@Spriite build a dark mode toggle', '1844000000000000001')
  assert.equal(a, derivedRepositoryName('@Spriite build a dark mode toggle', '1844000000000000001'))
  assert.notEqual(a, derivedRepositoryName('@Spriite build a dark mode toggle', '1844000000000000002'))
  assert.match(a, /^dark-mode-toggle-[0-9a-z]+$/)
  assert.ok(!/spriite/.test(derivedRepositoryName('@Spriite spriite app please', '9')), 'never named after Spriite')
})
console.log(`Native X auto-launch: ${passed} passed, 0 failed`)
