/**
 * Explicit opt-in composition. Construction starts no daemon, model, GitHub
 * mutation or websocket. Launch remains held by unqualified host/provider controls.
 */
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync, openSync, closeSync, fstatSync, lstatSync, statSync, accessSync, realpathSync, constants } from 'node:fs'
import { join, isAbsolute, delimiter } from 'node:path'
import {
  createNativeHost, createHostRoutedTransport, createNativeUsageClient, loadOrCreateHostKey, composeDaemonPath,
} from './native-host.mjs'
import { createNativeDelivery, createProductionRunner } from './native-delivery.mjs'
import { createNativeGitHub, GITHUB_CALL_RUNNER_MAX_BYTES } from './native-github.mjs'
import { createInjectedNativeProvider } from './sdk-provider.mjs'
import { compileNativePolicy } from './native-policy.mjs'
import { validateWorkspaceProof } from './native-workspace.mjs'
import { validateEnforcementLease } from './native-boundary.mjs'
import { SDK_TRANSPORT_VERSION } from './sdk-wire.mjs'
import { createMissionV2RecordReader } from './mission-v2-record.mjs'
import { digest, fail, id, str, hash, BrokerError } from './validation.mjs'

/** Environment overrides for the host tools; each wins over PATH search. */
export const HOST_TOOL_ENV = Object.freeze({
  droid: 'SPRIITE_NATIVE_DROID_PATH', gh: 'SPRIITE_NATIVE_GH_PATH', git: 'SPRIITE_NATIVE_GIT_PATH',
})
const isExecutableFile = path => {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile() } catch { return false }
}

/**
 * Absolute path of one host tool on this Factory host (Linux or macOS): the
 * SPRIITE_NATIVE_<TOOL>_PATH override when set, else the first absolute PATH
 * entry holding an executable file of that name. Relative PATH entries are
 * skipped, so the working directory never supplies a binary. A tool that can't
 * be found fails with `native_host_binary_missing:<tool>`.
 */
export function resolveHostTool(name, env = process.env) {
  const key = HOST_TOOL_ENV[name]
  if (!key) fail('native_host_configuration_required', 503)
  const override = env[key]
  if (override !== undefined && override !== '') {
    if (typeof override !== 'string' || !isAbsolute(override) || override.includes('\0')) fail('native_host_configuration_required', 503)
    if (!isExecutableFile(override)) fail(`native_host_binary_missing:${name}`, 503)
    return override
  }
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir) || dir.includes('\0')) continue
    const candidate = join(dir, name)
    if (isExecutableFile(candidate)) return candidate
  }
  return fail(`native_host_binary_missing:${name}`, 503)
}

/** droid, gh and git for this host, each resolved by resolveHostTool. */
export function resolveHostTools(env = process.env) {
  return { droidPath: resolveHostTool('droid', env), ghPath: resolveHostTool('gh', env), gitPath: resolveHostTool('git', env) }
}

/** Explicit paths win; any tool left unset is resolved from this process's env. */
function toolPaths({ droidPath, ghPath, gitPath }) {
  return {
    droidPath: droidPath ?? resolveHostTool('droid'),
    ghPath: ghPath ?? resolveHostTool('gh'),
    gitPath: gitPath ?? resolveHostTool('git'),
  }
}

/**
 * The daemon PATH for the production composition: the droid, gh and git
 * directories plus the broker's own Node directory, so Mission tools can run
 * node, npm and npx when Node comes from nvm, fnm, volta or asdf rather than a
 * system directory. See composeDaemonPath for the rest.
 */
export function productionDaemonPath({ droidPath, ghPath, gitPath, nodePath = process.execPath, exists }) {
  return composeDaemonPath({ toolPaths: [droidPath, ghPath, gitPath, nodePath], ...(exists ? { exists } : {}) })
}

/** Host operations retain their intended environment, but never resolve Git
 * through that environment's PATH. Recheck the deployment before each call. */
export function createPinnedHostGitRunner({ gitPath, execFilePort = execFile, validateRuntime = () => {} }) {
  str(gitPath, 4096)
  if (!gitPath.startsWith('/') || gitPath.includes('\0')) fail('native_host_configuration_required', 503)
  return async ({ args, cwd, env, timeoutMs = 60000 }) => {
    validateRuntime()
    return new Promise((resolve, reject) => {
      execFilePort(gitPath, args, {
        cwd, env, timeout: timeoutMs, maxBuffer: 4 * 1048576, shell: false,
      }, (error, stdout) => {
        if (error && (error.killed || error.signal || typeof error.code !== 'number')) {
          reject(new BrokerError('native_host_git_failed', 503))
        } else resolve({ stdout: String(stdout), exitCode: error ? error.code : 0 })
      })
    })
  }
}

/** Rechecked on every use; never follow a replaced symlink or accept group/world
 * readable secrets. Contents are never included in errors or diagnostics. */
export function readPrivateSecretFile(path) {
  let fd
  try {
    if (typeof path !== 'string' || !path.startsWith('/') || realpathSync(path) !== path) throw new Error()
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) ||
        stat.nlink !== 1 || stat.size < 1 || stat.size > 4096) throw new Error()
    const value = readFileSync(fd, 'utf8').trim()
    if (!value || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error()
    return value
  } catch { fail('native_secret_file_unsafe', 503) }
  finally { if (fd !== undefined) closeSync(fd) }
}

/**
 * True when another account could replace this executable. World-writable is
 * always unsafe. Group-writable is accepted only for a file the broker's own
 * user owns in its own primary group: under a umask of 002 (the default for
 * user-private-group accounts on Ubuntu and Debian), installers such as
 * Factory's leave droid at 0775, and that group holds only this user.
 */
export function executableWritableByOthers(stat, { uid = process.getuid(), gid = process.getgid() } = {}) {
  if (stat.mode & 0o002) return true
  if (!(stat.mode & 0o020)) return false
  return !(stat.uid === uid && stat.gid === gid)
}

function validateExecutable(path) {
  str(path, 4096)
  if (!path.startsWith('/')) fail('native_host_configuration_required', 503)
  try {
    const stat = lstatSync(realpathSync(path))
    if (!stat.isFile() || !(stat.mode & 0o111) || executableWritableByOthers(stat)) throw new Error()
  } catch { fail('native_host_binary_unsafe', 503) }
}

/**
 * The broker loads sdk-adapter.ts directly, so Node must strip TypeScript
 * types without a flag: Node 22.18+, 23.6+ or 24+.
 */
export function nodeSupportsTypeStripping(version = process.versions.node) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number)
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false
  return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)
}

/** Public reproducible binding, never hashes credential contents. Changing
 * binaries, broker code, SDK protocol, or approved configuration needs a new
 * deployment digest and fresh qualification. This does not establish controls.
 * Binaries are bound by resolved real path and content, so the same digest
 * cannot silently follow a different droid/gh/git on another PATH. */
export function productionDeploymentBinding({
  root, ownerId, machineId, factoryApiKeyFile, extensionTokenFile,
  droidPath: droid, ghPath: gh, gitPath: git, allowedModelIds, allowedToolIds,
}) {
  const { droidPath, ghPath, gitPath } = toolPaths({ droidPath: droid, ghPath: gh, gitPath: git })
  const sha = bytes => createHash('sha256').update(bytes).digest('hex')
  const binaries = Object.fromEntries(Object.entries({ droidPath, ghPath, gitPath }).map(([name, path]) => {
    validateExecutable(path)
    return [name, { path: realpathSync(path), sha256: sha(readFileSync(path)) }]
  }))
  const modules = ['host-production.mjs', 'native-host.mjs', 'sdk-provider.mjs', 'sdk-wire.mjs',
    'sdk-adapter.ts', 'native-boundary.mjs', 'native-policy.mjs', 'qualification.mjs', 'server.mjs',
    'broker.mjs', 'native-delivery.mjs', 'store.mjs', 'validation.mjs']
  const code = Object.fromEntries(modules.map(name => [name, sha(readFileSync(new URL(name, import.meta.url)))]))
  const binding = { version: 1, platform: process.platform, arch: process.arch, nodeVersion: process.version,
    transportVersion: SDK_TRANSPORT_VERSION, root, ownerId, machineId, factoryApiKeyFile, extensionTokenFile,
    allowedModelIds, allowedToolIds, binaries, code }
  return { deploymentDigest: hash(binding), binding }
}

/** A single, non-reconnecting connection, bound to the host's exact loopback URL. */
export function createHostLoopbackSocket({ url, WebSocketClass = globalThis.WebSocket, timeoutMs = 5000 }) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1' || !parsed.port ||
      parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') fail('native_daemon_url_invalid', 503)
  const events = new EventEmitter()
  events.on('error', () => {}) // Safe even before a client is attached.
  let socket = null, connectionId = null, permanentlyClosed = false
  return {
    async connect(requested) {
      if (requested !== url || socket || permanentlyClosed || typeof WebSocketClass !== 'function') fail('native_socket_connection_refused', 503)
      socket = new WebSocketClass(url)
      await new Promise((resolve, reject) => {
        let settled = false
        const finish = error => {
          if (settled) return
          settled = true; clearTimeout(timer)
          if (error) { permanentlyClosed = true; socket.close(); reject(error) } else resolve()
        }
        const timer = setTimeout(() => finish(new Error('native_socket_timeout')), timeoutMs)
        socket.addEventListener('open', () => {
          if (permanentlyClosed) { socket.close(); return }
          connectionId = randomUUID(); events.emit('open'); finish()
        })
        socket.addEventListener('message', event => {
          if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 1048576) {
            permanentlyClosed = true; events.emit('error', new Error('native_socket_message_refused')); socket.close(); return
          }
          events.emit('message', event.data)
        })
        socket.addEventListener('close', event => {
          permanentlyClosed = true; connectionId = null
          events.emit('close', event.code, 'native_socket_closed')
          finish(new Error('native_socket_closed'))
        })
        socket.addEventListener('error', () => {
          events.emit('error', new Error('native_socket_error')); finish(new Error('native_socket_error'))
        })
      })
    },
    disconnect() { permanentlyClosed = true; connectionId = null; socket?.close() },
    isConnected: () => !!connectionId && socket?.readyState === 1 && !permanentlyClosed,
    getConnectionId: () => connectionId,
    send(data) {
      if (!connectionId || socket?.readyState !== 1 || permanentlyClosed) fail('sdk_disconnected', 503)
      str(data, 1048576)
      if (Buffer.byteLength(data) > 1048576) fail('native_socket_message_refused', 503)
      socket.send(data)
    },
    isRelayConnection: () => false,
    getTransportKind: () => 'websocket',
    on: (event, handler) => { events.on(event, handler) },
    off: (event, handler) => { events.off(event, handler) },
  }
}

/** Non-execution admission client: provider inspection never needs an SDK RPC. */
export function createHostAdmissionClient(transport) {
  const refused = () => fail('native_readonly_admission_rpc_refused', 503)
  return {
    isConnected: () => false, getConnectionId: () => null,
    onMessage: handler => transport.on('message', handler),
    onConnectionOpen: handler => transport.on('open', handler),
    onConnectionClose: handler => transport.on('close', handler),
    onConnectionError: handler => transport.on('error', handler),
    initializeSession: refused, addUserMessage: refused, inspectMissionReadiness: refused,
    listAvailableSessions: refused, getSessionMessages: refused,
    sendPermissionResponse: refused, sendAskUserResponse: refused,
  }
}

export function createProductionNativeComposition({
  enabled, root, ownerId, machineId, deploymentDigest, factoryApiKeyFile, extensionTokenFile,
  allowedModelIds, allowedToolIds, droidPath: droid, ghPath: gh, gitPath: git,
  hostQualification = null, trustedHost = false,
}) {
  if (enabled !== true) fail('native_host_opt_in_required', 503)
  // Fail at startup, not at the first Mission launch inside createJobTransport.
  if (!nodeSupportsTypeStripping()) fail('native_node_version_unsupported', 503)
  const { droidPath, ghPath, gitPath } = toolPaths({ droidPath: droid, ghPath: gh, gitPath: git })
  id(ownerId); id(machineId); digest(deploymentDigest)
  for (const path of [root, factoryApiKeyFile, extensionTokenFile, droidPath]) {
    str(path, 4096); if (!path.startsWith('/')) fail('native_host_configuration_required', 503)
  }
  readPrivateSecretFile(factoryApiKeyFile); readPrivateSecretFile(extensionTokenFile)
  for (const path of [droidPath, ghPath, gitPath]) validateExecutable(path)
  try {
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
      fail('native_host_root_permissions_unsafe', 503)
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!Array.isArray(allowedModelIds) || !allowedModelIds.length || !Array.isArray(allowedToolIds) || !allowedToolIds.length) fail('native_host_configuration_required', 503)
  allowedModelIds.forEach(value => str(value, 256)); allowedToolIds.forEach(value => id(value))
  const runtime = productionDeploymentBinding({
    root, ownerId, machineId, factoryApiKeyFile, extensionTokenFile, droidPath, ghPath, gitPath, allowedModelIds, allowedToolIds,
  })
  if (runtime.deploymentDigest !== deploymentDigest) fail('native_deployment_digest_mismatch', 503)
  const validateRuntime = () => {
    if (productionDeploymentBinding({
      root, ownerId, machineId, factoryApiKeyFile, extensionTokenFile, droidPath, ghPath, gitPath, allowedModelIds, allowedToolIds,
    }).deploymentDigest !== deploymentDigest) fail('native_deployment_digest_mismatch', 503)
  }
  const delivery = createNativeDelivery({
    gh: createProductionRunner(ghPath), git: createProductionRunner(gitPath),
    now: () => new Date().toISOString(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  })
  const host = createNativeHost({
    root, hostKey: loadOrCreateHostKey(join(root, 'host-key')), machineId, deploymentDigest,
    factoryApiKeyFile, droidPath, delivery, sensitiveFiles: [extensionTokenFile],
    daemonPath: productionDaemonPath({ droidPath, ghPath, gitPath }),
    git: createPinnedHostGitRunner({ gitPath, validateRuntime }),
    readFactoryCredential: () => readPrivateSecretFile(factoryApiKeyFile),
    validateRuntime, trustedHost: trustedHost === true,
  })
  const deployment = { ownerId, machineId, deploymentDigest, allowedModelIds, allowedToolIds, boundary: host }
  const common = {
    deployment, evidenceAuthority: host.evidenceAuthority, hostPublicKey: host.publicKey, hostQualification,
    trustedHost: trustedHost === true,
    safeExtensionTokenGetter: async () => {
      return readPrivateSecretFile(extensionTokenFile)
    },
  }
  const transport = createHostRoutedTransport({
    host, version: SDK_TRANSPORT_VERSION,
    // Trusted host: child requests stay owner handoffs and restarts re-prepare,
    // which the owner accepted in place of a qualified recovery contract.
    support: { launch: true, rootAttention: true, childAttention: trustedHost === true, recoverAttention: trustedHost === true,
      pause: false, resume: false, cancel: false, readOnlyObservation: true },
    createAdmissionTransport(input) {
      const wire = createHostLoopbackSocket({ url: 'ws://127.0.0.1:1' })
      return createInjectedNativeProvider({
        ...common, ...input, transport: wire, createClient: createHostAdmissionClient,
        policy: { compileNativePolicy, validateWorkspaceProof, validateEnforcementLease },
      })
    },
    async createJobTransport({ daemon, workspaceHost, missionId }) {
      // Optional SDK import happens only in this explicitly selected composition.
      const { createOptionalDaemonAdapter } = await import('./sdk-adapter.ts')
      const wire = createHostLoopbackSocket({ url: daemon.url })
      const provider = await createOptionalDaemonAdapter({
        ...common, transport: wire, workspaceHost,
        clientConfig: { machineType: 'local', requestTimeout: 5000 },
        missionRecordReader: createMissionV2RecordReader({
          factoryDir: join(host.job(missionId).homeDir, '.factory'), localMachineId: machineId,
        }),
      })
      await wire.connect(daemon.url)
      return Object.assign(provider, { close() { provider.detach(); wire.disconnect() } })
    },
  })
  // Host GitHub for the phone: the same pinned gh and owner login delivery uses.
  const github = createNativeGitHub({ gh: createProductionRunner(ghPath, { maxBytes: GITHUB_CALL_RUNNER_MAX_BYTES }) })
  return {
    host, delivery, github, transport, deploymentDigest, hostQualification, trustedHost: trustedHost === true,
    usage: createNativeUsageClient({ apiKeyFile: factoryApiKeyFile, fs: { readFileSync: () => readPrivateSecretFile(factoryApiKeyFile) } }),
    setHostQualification(record) { common.hostQualification = record },
  }
}
