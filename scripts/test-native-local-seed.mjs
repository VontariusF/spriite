/** Real local Git only, configured owner identity unchanged. No remote writes,
 * model, Droid, GitHub, identity config edits or author/committer overrides. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { createNativeHost } from '../broker/native-host.mjs'

const exec = promisify(execFile)
const root = realpathSync(mkdtempSync(join(tmpdir(), 'spriite-real-local-seed-')))
const ownerEnv = { PATH: '/usr/bin:/bin', HOME: homedir(), LANG: 'C' }
// No test-supplied identity. A missing owner identity is an environment failure.
const ident = async variable => {
  try {
    const value = (await exec('/usr/bin/git', ['var', variable], { env: ownerEnv, cwd: homedir() })).stdout.trim()
    if (!value) throw new Error()
    return value
  } catch { throw new Error('Environment blocker: configured Git author and committer identity is required; no override attempted') }
}
const author = await ident('GIT_AUTHOR_IDENT'), committer = await ident('GIT_COMMITTER_IDENT')
const identity = value => value.replace(/ \d+ [+-]\d{4}$/, '')
const calls = []
const git = async ({ args, cwd, env, timeoutMs }) => {
  assert(!args.some(arg => ['clone', 'push', 'fetch', 'checkout', 'reset', 'clean'].includes(arg)))
  assert(!args.some(arg => /^user\.(name|email)=/.test(arg)))
  assert(!args.some(arg => arg.startsWith('core.hooksPath=') || ['--no-verify', '--no-gpg-sign'].includes(arg)))
  assert(!Object.keys(env).some(key => /^GIT_(AUTHOR|COMMITTER)_/.test(key)))
  calls.push(args)
  try { return { stdout: (await exec('/usr/bin/git', args, { cwd, env, timeout: timeoutMs })).stdout, exitCode: 0 } }
  catch (error) { return { stdout: error.stdout ?? '', exitCode: typeof error.code === 'number' ? error.code : 1 } }
}
const host = createNativeHost({
  root, hostKey: generateKeyPairSync('ed25519').privateKey, machineId: 'machine-seed',
  deploymentDigest: 'd'.repeat(64), factoryApiKeyFile: join(root, 'NEVER_READ'),
  ownerGitEnv: ownerEnv, git, spawn() { throw new Error('No process activation allowed') },
})
const missionId = 'mission-real-local-seed'
const draft = {
  protocolVersion: 1, ownerId: 'owner-seed', missionId, commandId: 'admit-seed', scopeRevision: 1,
  operation: 'implement', goal: 'Dummy local seed', references: [], acceptanceCriteria: ['Local only'], restrictions: ['No deploy'],
  destination: { kind: 'new_repository', account: 'dummy-owner', name: 'never-created', visibility: 'private', initialization: 'empty' },
  workspace: { machineId: 'machine-seed', cwd: host.workDirFor(missionId), repository: 'dummy-owner/never-created', baseRef: 'refs/heads/main' },
  policy: { autonomy: 'high', allowCreateRepository: true, allowPush: true, allowPr: true, allowMerge: false, allowDeploy: false },
  settings: { modelId: 'dummy', reasoningEffort: 'high', workerModel: 'dummy', workerReasoningEffort: 'high',
    validationWorkerModel: 'dummy', validationWorkerReasoningEffort: 'high', skipScrutiny: false, skipUserTesting: false,
    restrictToolIds: ['Read', 'RecommendMission', 'ExitMissionPlanning', 'Task', 'Script'] },
}
const workspace = await host.resolveAdmissionWorkspace(draft)
assert.match(workspace.baseSha, /^[a-f0-9]{40}$/)
const job = host.job(missionId)
assert.equal(job.localSeed, true); assert.equal(job.created, false)
assert.equal(job.intent.scopeApproved, false); assert.equal(job.intent.highAutonomyApproved, false)
const show = (await exec('/usr/bin/git', ['-C', workspace.cwd, 'show', '-s', '--format=%an <%ae>%n%cn <%ce>', workspace.baseSha], { env: ownerEnv })).stdout.trim().split('\n')
assert.equal(show[0], identity(author)); assert.equal(show[1], identity(committer))
assert.throws(() => host.privateRepositoryInitializationInput(missionId), { code: 'native_private_repository_initialization_not_approved' })
await host.provision({ ...draft, workspace, scopeApproved: true, highAutonomyApproved: true })
const input = host.privateRepositoryInitializationInput(missionId)
assert.equal(input.seedSha, workspace.baseSha); assert.equal(input.adoptionAllowed, false)
assert.equal(input.requiresCreatedRepository, true)
assert.equal((await host.resolveAdmissionWorkspace(draft)).baseSha, workspace.baseSha)
await assert.rejects(host.provision({ ...draft, workspace: { ...workspace, baseSha: 'f'.repeat(40) } }), { code: 'native_job_root_reused' })
assert.equal(calls.filter(args => args.includes('commit')).length, 1)
assert(!readFileSync(join(workspace.cwd, '.git/config'), 'utf8').includes('credential.helper'))
console.log(`Real local seed: configured author/committer preserved; SHA ${workspace.baseSha}; no remote/model/daemon actions. Root: ${root}`)
