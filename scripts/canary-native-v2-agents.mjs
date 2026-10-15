/**
 * Live end-to-end canary for native Missions 2.0 (droid >= 0.238, v2-agents)
 * through the REAL production path: host composition, broker HTTP server, and
 * the phone's own HTTP client and admission coordinator, with the owner
 * trusted-host mode on. Costs Factory credits; run only when authorized.
 *
 * The job runs against an existing private scratch repository you own
 * (CANARY_ACCOUNT/CANARY_REPO) and ends in a local commit: no push, no PR,
 * nothing is created or written on GitHub.
 *
 *   CANARY_ACCOUNT=<github-owner> CANARY_REPO=<scratch-repo> CANARY_MODEL=<model-id> \
 *   FACTORY_API_KEY=... node --import ./scripts/ts-resolve.mjs scripts/canary-native-v2-agents.mjs
 *
 * Env:
 *   CANARY_ACCOUNT, CANARY_REPO   required: the existing private scratch repository
 *   CANARY_MODEL                  model id (required locally; remote mode defaults to the
 *                                 broker's first allowed model)
 *   FACTORY_API_KEY or FACTORY_KEY_FILE   local mode only; never printed
 *   CANARY_DROID                  droid executable (default: droid on PATH, ~/.local/bin/droid)
 *   CANARY_BROKER_URL             drive an installed broker instead of an in-process one
 *   CANARY_OWNER                  owner id for remote mode (default: the installed broker.env)
 *   SPRIITE_HOME                  installed broker dir, as for scripts/install-native-broker.sh
 *   CANARY_MINUTES                default 20
 */
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createProductionNativeComposition, productionDeploymentBinding } from '../broker/host-production.mjs'
import { NativeBroker } from '../broker/broker.mjs'
import { startBrokerServer } from '../broker/server.mjs'
import { HttpNativeBrokerClient } from '../src/native/client.ts'
import { NativeAdmissionCoordinator } from '../src/native/admission.ts'

const required = (name, why) => {
  const value = process.env[name]
  if (!value) { console.error(`${name} is required: ${why}`); process.exit(2) }
  return value
}
/** The installer's base dir: SPRIITE_HOME, else the per-OS default. */
function brokerHome() {
  if (process.env.SPRIITE_HOME) return process.env.SPRIITE_HOME
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support/Spriite/native-broker')
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'spriite/native-broker')
}
/** First executable named `name` on PATH, then any extra candidates. */
function which(name, extra = []) {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const path of [...dirs.map(dir => join(dir, name)), ...extra]) {
    try { accessSync(path, constants.X_OK); return path } catch {}
  }
  return null
}
/** A value the installer wrote into broker.env, if present. */
function installed(home, key) {
  try {
    return new RegExp(`^export ${key}='(.*)'$`, 'm').exec(readFileSync(join(home, 'broker.env'), 'utf8'))?.[1] ?? null
  } catch { return null }
}

const remoteUrl = process.env.CANARY_BROKER_URL
const account = required('CANARY_ACCOUNT', 'the GitHub owner of an existing private scratch repository')
const name = required('CANARY_REPO', 'the name of an existing private scratch repository under CANARY_ACCOUNT')
const deployed = brokerHome()
let key = null
if (!remoteUrl) {
  key = process.env.FACTORY_API_KEY
  if (!key && process.env.FACTORY_KEY_FILE) {
    const text = readFileSync(process.env.FACTORY_KEY_FILE, 'utf8')
    key = /^\s*(?:export\s+)?FACTORY_API_KEY=["']?([^\s"']+)/m.exec(text)?.[1] ?? text.trim()
  }
  if (!key) { console.error('FACTORY_API_KEY or FACTORY_KEY_FILE is required for an in-process broker'); process.exit(2) }
}
const redact = value => key ? String(value).split(key).join('[key]') : String(value)
const stamp = Date.now()
// The secret-file check refuses symlinked paths, and the temp dir can be one (macOS /tmp).
const base = join(realpathSync(tmpdir()), 'spriite-canary', `e2e-${stamp}`)
const root = join(base, 'host'), store = join(base, 'store')
mkdirSync(base, { recursive: true, mode: 0o700 }); mkdirSync(root, { mode: 0o700 }); mkdirSync(store, { mode: 0o700 })
const out = join(base, 'canary.jsonl')
const log = (kind, data) => { const row = redact(JSON.stringify({ at: new Date().toISOString(), kind, data })); appendFileSync(out, row + '\n'); console.log(row.slice(0, 600)) }
const secret = (file, value) => { const path = join(base, file); writeFileSync(path, value, { mode: 0o600 }); chmodSync(path, 0o600); return path }
// CANARY_BROKER_URL drives an already-installed broker (the per-user service from
// scripts/install-native-broker.sh) exactly as the phone does. That is also the
// only way to exercise droid's whole-process sandbox from inside an already
// sandboxed shell, where a nested sandbox cannot start.
if (remoteUrl && !existsSync(join(deployed, 'bearer-token'))) {
  console.error(`No installed broker token at ${join(deployed, 'bearer-token')} (set SPRIITE_HOME to your broker dir)`)
  process.exit(2)
}
const TOKEN = remoteUrl ? readFileSync(join(deployed, 'bearer-token'), 'utf8').trim()
  : randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
const ownerId = remoteUrl ? (process.env.CANARY_OWNER ?? installed(deployed, 'SPRIITE_NATIVE_OWNER_ID') ??
  required('CANARY_OWNER', 'the installed broker owner id (none found in broker.env)')) : 'owner-canary'
const computerFile = join(homedir(), '.factory/computer.json')
if (!existsSync(computerFile)) { console.error(`${computerFile} not found: run droid once and sign in first`); process.exit(2) }
const machineId = JSON.parse(readFileSync(computerFile, 'utf8')).computerId
const installedModels = remoteUrl ? JSON.parse(installed(deployed, 'SPRIITE_NATIVE_ALLOWED_MODEL_IDS') ?? '[]') : []
const model = process.env.CANARY_MODEL ?? installedModels[0] ??
  required('CANARY_MODEL', 'a Factory model id your account can run (and, remotely, one in the broker MODELS allowlist)')
const tools = ['Read', 'LS', 'Glob', 'Grep', 'Execute', 'Create', 'Edit', 'ApplyPatch', 'TodoWrite', 'Script', 'Task',
  'SpawnAgent', 'SendMessage', 'ListAgents', 'InterruptAgent']
let broker = null, server = null, composition = null, hostRoot = root, brokerUrl
if (remoteUrl) {
  brokerUrl = remoteUrl
  hostRoot = join(deployed, 'host')
} else {
  const droidPath = process.env.CANARY_DROID ?? which('droid', [join(homedir(), '.local/bin/droid')])
  const ghPath = which('gh'), gitPath = which('git')
  if (!droidPath || !ghPath || !gitPath) { console.error('droid, gh and git must be on PATH (or set CANARY_DROID)'); process.exit(2) }
  const config = { root, ownerId, machineId, factoryApiKeyFile: secret('factory-api-key', key),
    extensionTokenFile: secret('extension-token', key), droidPath, ghPath, gitPath, allowedModelIds: [model], allowedToolIds: tools }
  const { deploymentDigest } = productionDeploymentBinding(config)
  composition = createProductionNativeComposition({ enabled: true, deploymentDigest, trustedHost: true, ...config })
  broker = await NativeBroker.open({ directory: store, ownerId, machineId, bearerToken: TOKEN, ...composition,
    qualificationPublicKey: composition.host.publicKey, trustedHost: true })
  server = await startBrokerServer({ broker, bearerToken: TOKEN })
  brokerUrl = `http://127.0.0.1:${server.address().port}`
}
const client = new HttpNativeBrokerClient({ brokerUrl, credential: () => TOKEN })
log('capabilities', await client.capabilities())

const missionId = `mission-e2e-${stamp.toString(36)}`, commandId = `command-e2e-${stamp.toString(36)}`
const profile = { brokerUrl, ownerId, machineId, cwd: hostRoot, baseRef: 'refs/heads/main', workspaceMode: 'host_managed', hostRoot }
const deliveryDefaults = { createPrivateRepositories: false, pushBranch: false, openPr: false, mergeAfterChecks: false }
const coordinator = new NativeAdmissionCoordinator({
  profile: () => profile, deliveryDefaults: () => deliveryDefaults, credential: () => TOKEN, client: () => client,
  mint: kind => kind === 'mission' ? missionId : commandId,
})
const destination = { kind: 'existing', account, name, visibility: 'private', initialization: 'empty' }
const request = {
  protocolVersion: 1, brokerUrl, ownerId, scopeRevision: 1, operation: 'implement',
  goal: 'Add greet.js exporting greet(name) that returns "Hello, <name>!", and greet.test.js using node:test that covers it. ' +
    'Add "test": "node --test" to package.json scripts (create package.json if missing). npm test must pass. Commit locally on the current branch.',
  workspace: { machineId, cwd: hostRoot, repository: `https://github.com/${account}/${name}`, baseRef: 'refs/heads/main' },
  destination, references: [], acceptanceCriteria: ['npm test passes', 'greet("Ada") returns "Hello, Ada!"'],
  restrictions: ['no push', 'no pr', 'no deploy'],
  policy: { autonomy: 'high', allowCreateRepository: false, allowPush: false, allowPr: false, allowMerge: false, allowDeploy: false },
  settings: { modelId: model, reasoningEffort: 'medium', workerModel: model, workerReasoningEffort: 'medium',
    validationWorkerModel: model, validationWorkerReasoningEffort: 'medium', restrictToolIds: tools,
    skipScrutiny: false, skipUserTesting: false },
}
const deadline = Date.now() + Number(process.env.CANARY_MINUTES ?? 20) * 60000
let final = null
try {
  const preview = await coordinator.inspect(request)
  log('preview', { launchEligible: preview.launchEligible, holds: preview.holds, workspace: preview.workspace })
  const intent = coordinator.take({ ...request, workspace: preview.workspace, settings: preview.prospectiveSettings,
    admission: preview, scopeApproved: true, highAutonomyApproved: true })
  if (!intent) throw new Error(`admission not launch-eligible: ${preview.holds.join(', ')}`)
  log('prepared', await client.prepare(intent))
  let last = ''
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10000))
    const s = await client.observe(missionId, ownerId)
    const brief = { state: s.state, hold: s.holdReason ?? null, features: (s.features ?? []).map(f => `${f.status}:${f.description}`),
      attention: (s.attention ?? []).filter(a => a.state === 'open').map(a => `${a.kind}:${a.title}`) }
    if (JSON.stringify(brief) !== last) { log('observe', brief); last = JSON.stringify(brief) }
    final = s
    if (['completed', 'failed', 'cancelled'].includes(s.state) || (s.state === 'held' && Date.now() - stamp > 120000)) break
  }
  const work = join(hostRoot, 'jobs', missionId, 'work')
  try {
    log('git', { log: execFileSync('git', ['-C', work, 'log', '--oneline', '-5']).toString(),
      status: execFileSync('git', ['-C', work, 'status', '--short']).toString(),
      test: execFileSync('npm', ['test', '--silent'], { cwd: work }).toString().slice(-400) })
  } catch (error) { log('git_error', String(error?.message ?? error).slice(0, 800)) }
} catch (error) {
  log('error', { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 1500) })
  process.exitCode = 1
} finally {
  log('final', final ? { state: final.state, hold: final.holdReason ?? null, features: final.features?.length ?? 0 } : null)
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  await broker?.shutdown?.()
  console.log(`evidence: ${out}`)
  process.exit()
}
