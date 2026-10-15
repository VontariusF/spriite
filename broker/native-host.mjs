/**
 * Host enforcer for native Missions: provisions a never-reused job root, runs a
 * dedicated whole-process-sandboxed droid daemon per job, live-probes its
 * containment, and signs host evidence for the boundary validators. It does
 * not cap spend (owner decision: usage is reported next day, not enforced).
 * In owner-trusted host mode the daemon runs unsandboxed instead.
 *
 * Portable across POSIX Factory hosts (Linux and macOS; Windows is not
 * supported): tools are invoked by absolute path, the daemon PATH is composed
 * from the resolved tool directories (composeDaemonPath), process identity is
 * read from /proc on Linux and ps elsewhere, and no temp or home location is
 * hardcoded.
 */
import * as nodeFs from 'node:fs'
import { spawn as nodeSpawn, execFile } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { homedir, hostname } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, KeyObject,
} from 'node:crypto'
import { canonical, hash, fail, id, digest, str, object, BrokerError, clone } from './validation.mjs'
import {
  getNativeHashes, nativeRequiredDimensions, nativeBudgetEnforcement, nativeConsequences, validateFullGitRef, validateGitSha,
} from './native-policy.mjs'
import { buildNativeGitArgs } from './native-workspace.mjs'
import { createNativeEvidenceAuthority, NATIVE_LEASE_MAX_MS, NATIVE_PERMIT_MAX_MS } from './native-boundary.mjs'

export const NATIVE_HOST_ROOT = join(homedir(), '.spriite-native')
export const NATIVE_HOST_DIMENSIONS = Object.freeze([
  'physical_workspace', 'destination_identity', 'filesystem_containment', 'bounded_checkout_writes',
  'credential_isolation', 'consequence_mediation', 'root_worker_validator_coverage',
  'ongoing_revocation', 'usage_reporting', 'delivery_mediation',
])
/**
 * Local seed recipe only. The SHA is minted locally with the configured Git
 * identity during admission and must be returned to the owner for consent.
 */
export const NATIVE_NEW_REPOSITORY_BASE = Object.freeze({
  baseRef: 'refs/heads/main',
  message: 'Initialize repository',
})
const HOST_BINDING_KEYS = ['ownerId', 'missionId', 'machineId', 'scopeHash', 'policyHash', 'epoch']
const DAEMON_ENV_KEYS = Object.freeze(['PATH', 'HOME', 'LANG', 'FACTORY_API_KEY'])
// Owner-home secret locations denied to the sandbox. Platform-specific entries
// (macOS Keychains, Linux keyrings) are harmless where they do not exist.
const OWNER_SECRET_PATHS = ['.ssh', '.aws', '.config/gh', '.gitconfig', '.git-credentials', '.netrc', '.npmrc',
  '.docker', '.kube', '.gnupg', '.factory', '.config/git', 'Library/Keychains', '.local/share/keyrings', '.password-store']
const HOME_CREDENTIAL_PATHS = ['.ssh', '.config/gh', '.gitconfig', '.git-credentials', '.netrc', '.aws', '.config/git/credentials']
/** Standard POSIX tool directories present on Linux and macOS hosts alike. */
export const DAEMON_SYSTEM_PATH_DIRS = Object.freeze(['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])
/** Package-manager prefixes added only when they exist on this host. */
export const DAEMON_OPTIONAL_PATH_DIRS = Object.freeze(['/opt/homebrew/bin', '/home/linuxbrew/.linuxbrew/bin'])
// Locale every supported host has: macOS ships en_US.UTF-8, while minimal Linux
// images often ship only C.UTF-8.
const DAEMON_LANG = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
const PROBE_TIMEOUT_MS = 90000
const STOP_GRACE_MS = 5000
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/**
 * PATH for the dedicated daemon: the directories of the resolved host tools
 * (droid, gh, git) first, then existing package-manager prefixes, then the
 * standard system directories. Never inherits the broker's own PATH, and drops
 * relative or ':'-containing entries. Works on any Linux or macOS layout.
 */
export function composeDaemonPath({ toolPaths = [], exists = path => nodeFs.existsSync(path) } = {}) {
  const dirs = toolPaths.filter(path => typeof path === 'string' && path.startsWith('/')).map(path => dirname(path))
  for (const dir of DAEMON_OPTIONAL_PATH_DIRS) if (exists(dir)) dirs.push(dir)
  dirs.push(...DAEMON_SYSTEM_PATH_DIRS)
  return [...new Set(dirs)].filter(dir => dir.startsWith('/') && !dir.includes(':') && !dir.includes('\0')).join(':')
}
const bind = value => Object.fromEntries(HOST_BINDING_KEYS.map(key => [key, value[key]]))

/** Creates (mode 0600) or loads the host's ed25519 signing key. */
export function loadOrCreateHostKey(path = join(NATIVE_HOST_ROOT, 'host-key'), fs = nodeFs) {
  if (fs.existsSync(path)) {
    const stat = fs.statSync(path)
    if ((stat.mode & 0o077) !== 0 || fs.realpathSync(path) !== resolve(path) ||
        stat.isFile?.() === false || (typeof stat.uid === 'number' && stat.uid !== process.getuid())) {
      fail('native_host_key_permissions_unsafe', 503)
    }
    const key = createPrivateKey(fs.readFileSync(path))
    if (key.asymmetricKeyType !== 'ed25519') fail('native_host_key_invalid', 503)
    return key
  }
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const parent = fs.statSync(dirname(path))
  if ((parent.mode & 0o077) || fs.realpathSync(dirname(path)) !== resolve(dirname(path))) {
    fail('native_host_key_permissions_unsafe', 503)
  }
  const { privateKey } = generateKeyPairSync('ed25519')
  fs.writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })
  return privateKey
}

/** Remote URL for a repository id; credentials are never part of it. */
export function repositoryUrlFor(repository) {
  return `https://github.com/${canonicalRepositoryId(repository)}.git`
}
export function stripUrlCredentials(value) {
  try {
    const url = new URL(value)
    url.username = ''; url.password = ''
    return url.href
  } catch { return value.replace(/\/\/[^/@]*@/, '//') }
}

/**
 * Canonical `owner/name` for either the id form or the phone/X URL form
 * (https://github.com/owner/name, any scheme/host casing, trailing .git).
 */
export function canonicalRepositoryId(repository) {
  str(repository, 512)
  const valid = value => {
    const parts = value.split('/')
    if (parts.length !== 2 || !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(parts[0]) ||
        !/^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/.test(parts[1]) ||
        ['.', '..'].includes(parts[1]) || /\.git$/i.test(parts[1])) fail('native_repository_url_invalid')
    return value
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return valid(repository.replace(/\.git$/i, ''))
  let url
  try { url = new URL(repository) } catch { return fail('native_repository_url_invalid') }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port ||
      url.username || url.password || url.search || url.hash) fail('native_repository_url_invalid')
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) fail('native_repository_url_invalid')
  return valid(`${parts[0]}/${parts[1].replace(/\.git$/i, '')}`)
}

export function nativeSandboxSettings({ workDir, ownerHome, root, apiKeyFile = join(root, 'factory-api-key'), sensitiveFiles = [], fs = nodeFs }) {
  const canonicalPath = path => {
    path = resolve(path)
    let ancestor = path, suffix = []
    while (!fs.existsSync(ancestor) && dirname(ancestor) !== ancestor) {
      suffix.unshift(ancestor.split('/').at(-1))
      ancestor = dirname(ancestor)
    }
    return join(fs.realpathSync(ancestor), ...suffix)
  }
  return {
    sandbox: {
      enabled: true,
      mode: 'whole-process',
      filesystem: {
        allowWrite: [workDir],
        denyRead: [...new Set([
          ...OWNER_SECRET_PATHS.map(path => join(ownerHome, path)),
          join(root, 'host-key'), join(root, 'evidence'), apiKeyFile, ...sensitiveFiles,
        ].flatMap(path => [resolve(path), canonicalPath(path)]))],
      },
      network: { allowedDomains: [] },
    },
  }
}

/** The owner-home write target is the only path outside work/ the probe touches; the host removes it. */
export function containmentProbeScript({ workDir, ownerHome, nonce }) {
  for (const value of [workDir, ownerHome, nonce]) {
    if (/['"\\$`\n]/.test(value)) fail('native_probe_path_unsafe')
  }
  const result = `${workDir}/.git/spriite-probe-${nonce}.json`
  return [
    '#!/bin/sh',
    `w=0; if : > '${workDir}/.git/spriite-probe-write-${nonce}' 2>/dev/null; then w=1; fi`,
    `o=0; if : > '${ownerHome}/.spriite-probe-${nonce}' 2>/dev/null; then o=1; fi`,
    // curl is resolved from the daemon PATH (its location differs across hosts).
    // A host without curl reports 2, which fails the probe instead of passing it.
    'n=0; if command -v curl >/dev/null 2>&1; then if curl -sf -m 5 -o /dev/null https://github.com 2>/dev/null; then n=1; fi; else n=2; fi',
    `printf '{"nonce":"%s","workWrite":%s,"ownerHomeWrite":%s,"githubReachable":%s}\\n' '${nonce}' "$w" "$o" "$n" > '${result}'`,
    "echo 'Spriite containment probe complete; prompt intentionally blocked.' >&2",
    // Exit 2 blocks the prompt so the probe session never reaches a model.
    'exit 2',
    '',
  ].join('\n')
}

function defaultGit({ args, cwd, env, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout: timeoutMs, maxBuffer: 4 * 1048576, shell: false }, (error, stdout) => {
      if (error && (error.killed || error.signal || typeof error.code !== 'number')) reject(new BrokerError('native_host_git_failed', 503))
      else resolve({ stdout: String(stdout), exitCode: error ? error.code : 0 })
    })
  })
}
async function defaultAllocatePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}
function defaultWaitForDaemon({ port, child, timeoutMs = 20000, sleep }) {
  const deadline = Date.now() + timeoutMs
  return (async () => {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode) return false
      const open = await new Promise(resolve => {
        const socket = connect({ host: '127.0.0.1', port })
        socket.once('connect', () => { socket.destroy(); resolve(true) })
        socket.once('error', () => resolve(false))
      })
      if (open) return true
      await sleep(200)
    }
    return false
  })()
}
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms))
/**
 * The complete command line of a live PID: null when no such process exists,
 * false when it cannot be read. Linux reads /proc (minimal images may lack a
 * full ps); other POSIX hosts ask ps. A zombie reads as an empty command, which
 * never matches a persisted daemon command, so it stays unverified.
 */
const defaultInspectProcess = pid => {
  if (process.platform === 'linux' && nodeFs.existsSync('/proc/self/cmdline')) {
    try {
      return Promise.resolve(nodeFs.readFileSync(`/proc/${Number(pid)}/cmdline`).toString('utf8')
        .replace(/\0+$/, '').split('\0').join(' ').trim())
    } catch (error) { return Promise.resolve(error?.code === 'ENOENT' || error?.code === 'ESRCH' ? null : false) }
  }
  return new Promise(resolve => {
    const ps = ['/bin/ps', '/usr/bin/ps'].find(path => nodeFs.existsSync(path))
    if (!ps) return resolve(false)
    execFile(ps, ['-p', String(pid), '-o', 'command='], { timeout: 5000, maxBuffer: 8192 },
      (error, stdout) => resolve(error?.code === 1 ? null : error ? false : String(stdout).trim()))
  })
}

/**
 * @param {object} options
 * @param {string} [options.root] host root, default ~/.spriite-native
 * @param {import('node:crypto').KeyObject} options.hostKey ed25519 private key
 */
export function createNativeHost({
  root = NATIVE_HOST_ROOT, hostKey, spawn = nodeSpawn, fs = nodeFs, git = defaultGit, delivery,
  now = Date.now, factoryApiKeyFile, machineId, deploymentDigest, ownerHome = homedir(),
  droidPath = 'droid', daemonPath = composeDaemonPath({ toolPaths: [droidPath] }), ownerGitEnv = process.env,
  executionHostId = `host-${sha256(hostname()).slice(0, 16)}`, randomId = randomUUID,
  allocatePort = defaultAllocatePort, waitForDaemon, sleep = defaultSleep, parentPid = process.pid,
  inspectProcess = defaultInspectProcess, signalProcess = (pid, signal) => process.kill(pid, signal),
  sensitiveFiles = [], readFactoryCredential, validateRuntime = () => {},
  /** Owner opt-in: accept the documented host risks instead of holding every job. */
  trustedHost = false,
  /** Start each daemon in its own process group and stop the whole group.
   * Defaults on for the real spawn; injected test spawns opt in explicitly. */
  processGroups = spawn === nodeSpawn,
}) {
  if (!(hostKey instanceof KeyObject) || hostKey.type !== 'private' || hostKey.asymmetricKeyType !== 'ed25519') fail('native_host_key_invalid', 503)
  id(machineId); digest(deploymentDigest); id(executionHostId)
  if (typeof root !== 'string' || !root.startsWith('/')) fail('native_host_root_invalid', 503)
  if (typeof factoryApiKeyFile !== 'string' || !factoryApiKeyFile.startsWith('/')) fail('native_factory_key_file_required', 503)
  const publicKey = createPublicKey(hostKey)
  const waitReady = waitForDaemon ?? (input => defaultWaitForDaemon({ ...input, sleep }))
  const children = new Map(), leases = new Map(), attestations = new Map()
  const issued = new Map(), artifactPaths = new Map()
  const iso = ms => new Date(ms).toISOString()
  const jobsDir = join(root, 'jobs'), evidenceDir = join(root, 'evidence')
  const jobRoot = missionId => join(jobsDir, id(missionId))
  const jobFile = missionId => join(jobRoot(missionId), 'job.json')
  const localGitEnv = Object.freeze({
    PATH: '/usr/bin:/bin', HOME: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', LANG: 'C',
  })
  const ownerEnv = { ...ownerGitEnv, GIT_TERMINAL_PROMPT: '0' }

  function writeJson(path, value, mode = 0o600) {
    fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode })
  }
  function loadJob(missionId) {
    const path = jobFile(missionId)
    if (!fs.existsSync(path)) fail('native_job_not_provisioned', 409)
    return JSON.parse(fs.readFileSync(path, 'utf8'))
  }
  const saveJob = job => writeJson(jobFile(job.missionId), job)
  async function runGit(args, { cwd, env = localGitEnv, allow = [0] } = {}) {
    const result = await git({ args, cwd, env, timeoutMs: 60000 })
    if (!result || !allow.includes(result.exitCode)) fail('native_host_git_failed', 503)
    return String(result.stdout)
  }
  const query = async (q, cwd) => {
    const out = await runGit(buildNativeGitArgs(q, cwd), {
      cwd, allow: ['execution_ref', 'ancestor'].includes(q.kind) ? [0, 1] : [0],
    })
    return q.kind === 'dirty' ? out : out.replace(/\n$/, '')
  }

  function readEvidence(evidenceId) {
    id(evidenceId)
    const path = join(evidenceDir, `${evidenceId}.json`)
    if (!fs.existsSync(path)) fail('native_evidence_missing')
    return JSON.parse(fs.readFileSync(path, 'utf8'))
  }
  function readArtifact(artifactId) {
    id(artifactId)
    let path = artifactPaths.get(artifactId)
    if (!path && fs.existsSync(jobsDir)) {
      for (const mission of fs.readdirSync(jobsDir)) {
        const candidate = join(jobsDir, mission, 'artifacts', `${artifactId}.json`)
        if (fs.existsSync(candidate)) { path = candidate; break }
      }
    }
    if (!path) fail('native_evidence_artifact_missing')
    artifactPaths.set(artifactId, path)
    return new Uint8Array(fs.readFileSync(path))
  }
  /** Same manifest/signature format verified by createNativeEvidenceAuthority. */
  function attest({ evidenceId, missionId, kind, subject, binding, nonce, facts }) {
    id(evidenceId)
    const at = now()
    const artifactsDir = join(jobRoot(missionId), 'artifacts')
    fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o700 })
    const artifacts = Object.entries(facts).map(([dimension, fact]) => {
      const artifactId = `${evidenceId}-${dimension}`
      const bytes = Buffer.from(canonical({ dimension, missionId, observedAt: iso(at), fact }))
      const path = join(artifactsDir, `${artifactId}.json`)
      fs.writeFileSync(path, bytes, { mode: 0o600 })
      artifactPaths.set(artifactId, path)
      return { id: artifactId, dimension, sha256: sha256(bytes) }
    })
    const manifest = {
      version: 1, evidenceId, kind, subjectHash: hash(subject), binding: bind(binding), nonce,
      deploymentDigest, issuedAt: iso(at), expiresAt: iso(at + NATIVE_LEASE_MAX_MS), artifacts,
    }
    const signature = sign(null, Buffer.from(canonical(manifest)), hostKey).toString('base64')
    fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
    writeJson(join(evidenceDir, `${evidenceId}.json`), { manifest, signature })
    return evidenceId
  }

  const isAlive = missionId => {
    const row = children.get(missionId)
    return !!row && !row.exited && row.child.exitCode === null && !row.child.signalCode
  }
  function settingsFor(job) {
    // Trusted host: droid runs unsandboxed, as when the owner runs it directly,
    // on every platform. droid 0.238's whole-process sandbox refused to start on
    // macOS (its unix_socket_not_blocked self-check failed); on Linux it may
    // start, but trusted-host mode does not depend on it. Without trusted host,
    // the sandbox must start and pass the containment probe or the job holds.
    if (trustedHost) return { sandbox: { enabled: false } }
    return nativeSandboxSettings({ workDir: job.workDir, ownerHome, root, apiKeyFile: factoryApiKeyFile, sensitiveFiles, fs })
  }
  function homeCredentialFacts(job) {
    const present = HOME_CREDENTIAL_PATHS.filter(path => fs.existsSync(join(job.homeDir, path)))
    return { checkedPaths: HOME_CREDENTIAL_PATHS, present }
  }
  async function cloneCredentialFacts(job) {
    const config = await runGit(['-C', job.workDir, 'config', '--local', '--list'], { cwd: job.workDir })
    const lines = config.split('\n').filter(Boolean)
    const helpers = lines.filter(line => /^credential\./i.test(line))
    const remote = lines.find(line => line.startsWith('remote.origin.url=')) ?? null
    const remoteUrl = remote && remote.slice('remote.origin.url='.length)
    return { credentialHelpers: helpers.length, remoteUrl, remoteHasUserinfo: !!remoteUrl && /\/\/[^/]*@/.test(remoteUrl) }
  }

  // With processGroups (the default for real spawns) the daemon leads its own
  // process group, and stopping signals the whole group: SIGTERM, then SIGKILL
  // if the daemon is still running, then a final SIGKILL to the group so a
  // worker's background process (`npm run dev &`, a watcher) can't outlive the
  // job and keep ports or CPU. A descendant that calls setsid() leaves the group
  // and is not reached; under systemd a service restart still ends it. Outside
  // trusted-host mode this is why native_process_tree_revocation_unproven stays
  // a qualification hold. In trusted-host mode no hold applies and the owner
  // accepts that cleanup is best effort.
  const signalTree = (row, signal) => {
    if (row.group && Number.isInteger(row.child.pid) && row.child.pid > 1) {
      try { signalProcess(-row.child.pid, signal); return } catch {}
    }
    try { row.child.kill(signal) } catch {}
  }
  const reapGroup = row => {
    if (!row.group || !Number.isInteger(row.child.pid) || row.child.pid <= 1) return
    try { signalProcess(-row.child.pid, 'SIGKILL') } catch {}
  }
  async function stopChild(missionId) {
    const row = children.get(missionId)
    if (!row) {
      const job = loadJob(missionId)
      if (job.daemon && !job.terminationVerified) fail('native_orphan_termination_unverified', 503)
      return { stopped: true, signal: null }
    }
    if (row.exited) { reapGroup(row); return { stopped: true, signal: null } }
    signalTree(row, 'SIGTERM')
    for (let waited = 0; !row.exited && row.child.exitCode === null && waited < STOP_GRACE_MS; waited += 100) await sleep(100)
    if (row.exited || row.child.exitCode !== null) { reapGroup(row); return { stopped: true, signal: 'SIGTERM' } }
    signalTree(row, 'SIGKILL')
    for (let waited = 0; !row.exited && row.child.exitCode === null && waited < STOP_GRACE_MS; waited += 100) await sleep(100)
    if (!row.exited && row.child.exitCode === null) fail('native_daemon_termination_unverified', 503)
    reapGroup(row)
    return { stopped: true, signal: 'SIGKILL' }
  }
  function daemonEnv(job) {
    let key
    try { key = readFactoryCredential ? readFactoryCredential() : fs.readFileSync(factoryApiKeyFile, 'utf8').trim() } catch { fail('native_factory_key_unavailable', 503) }
    if (!key) fail('native_factory_key_unavailable', 503)
    return { PATH: daemonPath, HOME: job.homeDir, LANG: DAEMON_LANG, FACTORY_API_KEY: key }
  }
  function runToExit(command, args, { cwd, env, timeoutMs }) {
    return new Promise(resolve => {
      let child, done = false, timedOut = false
      const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value) } }
      try { child = spawn(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'ignore'] }) }
      catch { return resolve({ exitCode: null, spawnFailed: true }) }
      const timer = setTimeout(async () => {
        timedOut = true
        try { child.kill('SIGKILL') } catch {}
        for (let waited = 0; !done && child.exitCode === null && waited < STOP_GRACE_MS; waited += 100) await sleep(100)
        if (!done) finish({ exitCode: child.exitCode, timedOut: true, terminationUnverified: child.exitCode === null })
      }, timeoutMs)
      timer.unref?.()
      child.on('error', () => finish({ exitCode: null, spawnFailed: true }))
      child.on('exit', code => finish({ exitCode: code, timedOut }))
    })
  }

  const host = {
    publicKey,
    root,
    qualificationHolds: trustedHost ? Object.freeze([]) : Object.freeze(['native_credential_isolation_unproven',
      'native_daemon_authentication_unqualified', 'native_process_tree_revocation_unproven']),
    trustedHost,
    evidenceAuthority: createNativeEvidenceAuthority({ publicKey, readEvidence, readArtifact, now }),
    readEvidence, readArtifact,
    workDirFor: missionId => join(jobRoot(missionId), 'work'),
    jobRootFor: jobRoot,
    executionRefFor: missionId => `refs/heads/spriite/${id(missionId)}`,
    /**
     * Local read-only admission: clone/inspect only, never start a daemon, turn,
     * create a GitHub repository or push. Synthetic consent is never persisted.
     */
    async resolveAdmissionWorkspace(draft) {
      if (draft.workspace.cwd !== host.workDirFor(draft.missionId)) fail('native_workspace_not_host_provisioned')
      if (draft.workspace.machineId !== machineId) fail('native_wrong_deployment')
      if (draft.destination?.kind === 'new_repository') {
        const d = draft.destination
        if (d.visibility !== 'private' || d.initialization !== 'empty' ||
            draft.workspace.repository !== `${d.account}/${d.name}` ||
            draft.workspace.baseRef !== NATIVE_NEW_REPOSITORY_BASE.baseRef) fail('native_new_repository_base_mismatch')
      }
      const result = await host.provision({ ...clone(draft), scopeApproved: false, highAutonomyApproved: false })
      return { ...draft.workspace, baseSha: result.baseSha }
    },
    /** Persist restart fencing before any provider can reconstruct authority. */
    async recoverAfterRestart() {
      if (!fs.existsSync(jobsDir)) return []
      const recovered = []
      for (const missionId of fs.readdirSync(jobsDir)) {
        if (!fs.existsSync(jobFile(missionId))) continue
        const job = loadJob(missionId)
        if (!['starting', 'running', 'recovery_required'].includes(job.state) &&
            !(job.daemon && job.terminationVerified !== true)) continue
        job.state = 'recovery_required'; job.generation += 1
        job.recoveryReason = 'Broker restarted; mission must be re-prepared'
        job.probes = null
        saveJob(job)
        // Never signal a stale/reused PID. Match the complete persisted command,
        // including job-specific settings, port and original parent.
        const command = job.daemon && await inspectProcess(job.daemon.pid)
        const expected = `${droidPath} daemon --host 127.0.0.1 --port ${job.daemon?.port} --parent-pid ${job.daemon?.parentPid} --settings ${join(job.homeDir, '.factory', 'settings.json')}`
        job.terminationVerified = command === null || !job.daemon
        if (command === expected) {
          for (const signal of ['SIGTERM', 'SIGKILL']) {
            const before = await inspectProcess(job.daemon.pid)
            if (before === null) { job.terminationVerified = true; break }
            if (before !== expected) break
            // A daemon started as a group leader is stopped with its group.
            if (job.daemon.processGroup === true) {
              try { signalProcess(-job.daemon.pid, signal) } catch { try { signalProcess(job.daemon.pid, signal) } catch {} }
            } else {
              try { signalProcess(job.daemon.pid, signal) } catch {}
            }
            for (let waited = 0; waited < STOP_GRACE_MS; waited += 100) {
              const current = await inspectProcess(job.daemon.pid)
              if (current === null) { job.terminationVerified = true; break }
              if (current !== expected) break
              await sleep(100)
            }
            if (job.terminationVerified) break
          }
        }
        saveJob(job)
        recovered.push(missionId)
      }
      return recovered
    },

    /** Workspace host metadata for validateWorkspaceProof, per provisioned job. */
    workspaceHostFor(missionId) {
      const job = loadJob(missionId)
      return {
        executionMachineId: machineId, localMachineId: machineId, executionHostId,
        executionInstanceId: job.instanceId, checkoutGeneration: job.checkoutGeneration,
        repositoryId: job.repository, deploymentDigest, permittedRoots: [job.jobRoot],
        executionRef: job.executionRef,
      }
    },
    job: missionId => clone(loadJob(missionId)),
    daemonFor(missionId) {
      const job = loadJob(missionId)
      if (!isAlive(missionId) || !job.daemon) fail('native_daemon_not_running', 503)
      return { pid: job.daemon.pid, port: job.daemon.port, url: `ws://127.0.0.1:${job.daemon.port}` }
    },

    /**
     * Clone an existing repository with the broker's credentials, then strip
     * them. New repositories get a local-only seed; remote creation and seed
     * publication belong exclusively to the broker's journalled delivery port.
     */
    async provision(intent) {
      const missionId = id(intent.missionId)
      const consequences = nativeConsequences(intent)
      const path = jobRoot(missionId), workDir = join(path, 'work'), homeDir = join(path, 'home')
      if (intent.workspace.cwd !== workDir) fail('native_workspace_not_host_provisioned')
      if (intent.workspace.machineId !== machineId) fail('native_wrong_deployment')
      if (intent.destination?.kind === 'existing' &&
          canonicalRepositoryId(intent.workspace.repository) !== `${intent.destination.account}/${intent.destination.name}`) fail('native_destination_identity_mismatch')
      if (intent.destination?.kind === 'new_repository') {
        const d = intent.destination
        if (!consequences.createRepository || d.visibility !== 'private' || d.initialization !== 'empty') fail('native_new_repository_must_be_private')
        if (intent.workspace.repository !== `${d.account}/${d.name}`) fail('native_new_repository_identity_mismatch')
        if (intent.workspace.baseRef !== NATIVE_NEW_REPOSITORY_BASE.baseRef) fail('native_new_repository_base_mismatch')
      }
      validateFullGitRef(intent.workspace.baseRef)
      const executionRef = host.executionRefFor(missionId)
      if (fs.existsSync(path)) {
        const prior = fs.existsSync(jobFile(missionId)) ? loadJob(missionId) : null
        // Admission may provision before prepare; anything beyond that is reuse.
        if (!prior || prior.state !== 'provisioned' || prior.repository !== intent.workspace.repository ||
            prior.baseRef !== intent.workspace.baseRef ||
            !!prior.localSeed !== (intent.destination?.kind === 'new_repository') ||
            (intent.workspace.baseSha && intent.workspace.baseSha !== prior.baseSha)) fail('native_job_root_reused')
        prior.intent = clone(intent); prior.hashes = getNativeHashes(intent)
        saveJob(prior)
        return { workDir: prior.workDir, baseSha: prior.baseSha, repositoryUrl: prior.repositoryUrl, created: prior.created }
      }
      fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 })
      fs.mkdirSync(path, { mode: 0o700 })
      fs.mkdirSync(homeDir, { mode: 0o700 })
      fs.mkdirSync(join(homeDir, '.factory'), { mode: 0o700 })
      let repositoryUrl, created = false
      const d = intent.destination
      if (d?.kind === 'new_repository') {
        if (!consequences.createRepository || d.visibility !== 'private' || d.initialization !== 'empty') fail('native_new_repository_must_be_private')
        if (intent.workspace.repository !== `${d.account}/${d.name}`) fail('native_new_repository_identity_mismatch')
        if (intent.workspace.baseRef !== NATIVE_NEW_REPOSITORY_BASE.baseRef) fail('native_new_repository_base_mismatch')
        // A client cannot predetermine the SHA of a not-yet-minted local seed.
        if (intent.workspace.baseSha) fail('native_new_repository_seed_admission_required')
        repositoryUrl = repositoryUrlFor(intent.workspace.repository)
      } else repositoryUrl = repositoryUrlFor(intent.workspace.repository)
      const branch = intent.workspace.baseRef.slice('refs/heads/'.length)
      let baseSha
      if (d?.kind === 'new_repository') {
        // git var uses the configured identity unchanged. Never synthesize a
        // name/email, set GIT_*_IDENTITY, or override user.* config.
        for (const variable of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
          const result = await git({ args: ['var', variable], cwd: ownerHome, env: ownerEnv, timeoutMs: 60000 })
          if (result?.exitCode !== 0 || !String(result.stdout).trim()) fail('native_git_identity_required', 503)
        }
        await runGit(['init', '--quiet', '--initial-branch=main', workDir], { cwd: path, env: ownerEnv })
        // Refuse custom/template hooks instead of bypassing them. The owner's
        // identity and signing policy remain unchanged for the seed commit.
        const hooksConfig = await git({ args: ['-C', workDir, 'config', '--get', 'core.hooksPath'],
          cwd: workDir, env: ownerEnv, timeoutMs: 60000 })
        if (hooksConfig?.exitCode !== 1 || String(hooksConfig.stdout ?? '') !== '')
          fail('native_git_hooks_unsafe', 503)
        const hooksDir = join(workDir, '.git', 'hooks')
        if (fs.existsSync(hooksDir) && (fs.lstatSync(hooksDir).isSymbolicLink() ||
            fs.readdirSync(hooksDir).some(name => !name.endsWith('.sample'))))
          fail('native_git_hooks_unsafe', 503)
        await runGit(['-C', workDir, 'commit', '--quiet',
          '--allow-empty', '-m', NATIVE_NEW_REPOSITORY_BASE.message], { cwd: workDir, env: ownerEnv })
        baseSha = (await runGit(['-C', workDir, 'rev-parse', 'HEAD'], { cwd: workDir })).trim()
        await runGit(['-C', workDir, 'update-ref', executionRef, baseSha], { cwd: workDir })
        await runGit(['-C', workDir, 'symbolic-ref', 'HEAD', executionRef], { cwd: workDir })
        await runGit(['-C', workDir, 'remote', 'add', 'origin', repositoryUrl], { cwd: workDir })
      } else {
        await runGit(['clone', '--quiet', '--no-hardlinks', '--', repositoryUrl, workDir], { cwd: path, env: ownerEnv })
        const result = await git({ args: ['-C', workDir, 'rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`],
          cwd: workDir, env: localGitEnv, timeoutMs: 60000 })
        if (result?.exitCode !== 0) fail('native_existing_empty_repository_adoption_required', 409)
        baseSha = String(result.stdout).trim()
        validateGitSha(baseSha)
        if (intent.workspace.baseSha && intent.workspace.baseSha !== baseSha) fail('native_workspace_base_mismatch')
        await runGit(['-C', workDir, 'checkout', '--quiet', '-B', executionRef.slice('refs/heads/'.length), baseSha], { cwd: workDir })
      }
      validateGitSha(baseSha)
      if (intent.workspace.baseSha && intent.workspace.baseSha !== baseSha) fail('native_workspace_base_mismatch')
      await runGit(['-C', workDir, 'config', '--local', '--unset-all', 'credential.helper'], { cwd: workDir, allow: [0, 5] })
      await runGit(['-C', workDir, 'remote', 'set-url', 'origin', stripUrlCredentials(repositoryUrl)], { cwd: workDir })
      const job = {
        version: 1, missionId, state: 'provisioned', jobRoot: path, workDir, homeDir,
        repository: intent.workspace.repository, repositoryUrl: stripUrlCredentials(repositoryUrl), created,
        localSeed: d?.kind === 'new_repository',
        baseRef: intent.workspace.baseRef, baseSha, executionRef,
        instanceId: `instance-${randomId()}`, checkoutGeneration: `checkout-${randomId()}`,
        generation: 0, intent: clone(intent), hashes: getNativeHashes(intent),
        settingsSha256: null, daemon: null, probes: null, createdAt: iso(now()),
      }
      const credentials = await cloneCredentialFacts(job)
      if (credentials.credentialHelpers || credentials.remoteHasUserinfo) fail('native_clone_credentials_not_stripped', 503)
      const settingsBytes = Buffer.from(`${JSON.stringify(settingsFor(job), null, 2)}\n`)
      fs.writeFileSync(join(homeDir, '.factory', 'settings.json'), settingsBytes, { mode: 0o600 })
      job.settingsSha256 = sha256(settingsBytes)
      saveJob(job)
      return { workDir, baseSha, repositoryUrl: job.repositoryUrl, created }
    },

    async startDaemon({ missionId }) {
      validateRuntime()
      const job = loadJob(missionId)
      if (job.state === 'revoked') fail('native_job_revoked')
      if (job.state === 'recovery_required') fail('native_broker_restarted_reprepare_required')
      if (isAlive(missionId)) return host.daemonFor(missionId)
      if (job.state !== 'provisioned') fail('native_broker_restarted_reprepare_required')
      const env = daemonEnv(job)
      const port = await allocatePort()
      const settingsPath = join(job.homeDir, '.factory', 'settings.json')
      if (sha256(fs.readFileSync(settingsPath)) !== job.settingsSha256) fail('native_sandbox_settings_changed', 503)
      const child = spawn(droidPath, ['daemon', '--host', '127.0.0.1', '--port', String(port),
        '--parent-pid', String(parentPid), '--settings', settingsPath], {
        cwd: job.workDir, env, stdio: ['ignore', 'ignore', 'ignore'],
        // Its own process group, so stopping reaches the workers it starts.
        ...(processGroups ? { detached: true } : {}),
      })
      const row = { child, exited: false, group: processGroups }
      children.set(missionId, row)
      child.on?.('exit', () => { row.exited = true })
      child.on?.('error', () => { if (!child.pid) row.exited = true })
      job.state = 'starting'
      job.daemon = { pid: child.pid, port, parentPid, envKeys: Object.keys(env).sort(), startedAt: iso(now()),
        ...(processGroups ? { processGroup: true } : {}) }
      job.terminationVerified = false
      job.probes = null
      saveJob(job)
      // Whole-process mode refuses to start without isolation; that is a hold.
      if (!await waitReady({ port, child }) || !isAlive(missionId)) {
        await stopChild(missionId)
        job.state = 'stopped'; job.terminationVerified = true
        saveJob(job)
        fail('native_daemon_refused_start', 503)
      }
      job.state = 'running'
      saveJob(job)
      return host.daemonFor(missionId)
    },

    async stopDaemon({ missionId }) {
      const job = loadJob(missionId)
      const result = await stopChild(missionId)
      job.terminationVerified = true
      if (['starting', 'running'].includes(job.state)) job.state = 'stopped'
      saveJob(job)
      return result
    },

    /**
     * One `droid exec` with the daemon's HOME, env and sandbox settings plus a
     * probe-only UserPromptSubmit hook. Hooks run inside the sandbox; the hook
     * exits 2 to block the prompt, so no model turn is expected.
     */
    async runContainmentProbes({ missionId }) {
      validateRuntime()
      const job = loadJob(missionId)
      if (!isAlive(missionId)) fail('native_daemon_not_running', 503)
      if (trustedHost) {
        // Nothing to prove without a sandbox: record that honestly instead of
        // a probe result, so evidence never claims containment that isn't there.
        job.probes = {
          nonce: `trusted-${randomId()}`, passed: true, method: 'owner_trusted_host_unsandboxed', exitCode: null,
          timedOut: false, observed: { workWrite: null, ownerHomeWrite: null, githubReachable: null },
          settingsSha256: job.settingsSha256, generation: job.generation, ranAt: iso(now()),
        }
        saveJob(job)
        return clone(job.probes)
      }
      const nonce = `probe-${randomId()}`
      const probeDir = join(job.jobRoot, 'probe')
      fs.mkdirSync(probeDir, { recursive: true, mode: 0o700 })
      const scriptPath = join(probeDir, `${nonce}.sh`)
      fs.writeFileSync(scriptPath, containmentProbeScript({ workDir: job.workDir, ownerHome, nonce }), { mode: 0o700 })
      const probeSettingsPath = join(probeDir, `${nonce}.settings.json`)
      writeJson(probeSettingsPath, {
        ...settingsFor(job),
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `/bin/sh ${scriptPath}`, timeout: 30 }] }] },
      })
      const settingsPath = join(job.homeDir, '.factory', 'settings.json')
      if (sha256(fs.readFileSync(settingsPath)) !== job.settingsSha256) fail('native_sandbox_settings_changed', 503)
      const exit = await runToExit(droidPath, ['exec', '--settings', probeSettingsPath, '--cwd', job.workDir,
        '--auto', 'low', 'spriite-containment-probe'], { cwd: job.workDir, env: daemonEnv(job), timeoutMs: PROBE_TIMEOUT_MS })
      const resultPath = join(job.workDir, '.git', `spriite-probe-${nonce}.json`)
      let observed = null
      try { observed = JSON.parse(fs.readFileSync(resultPath, 'utf8')) } catch {}
      for (const leftover of [resultPath, join(job.workDir, '.git', `spriite-probe-write-${nonce}`),
        join(ownerHome, `.spriite-probe-${nonce}`)]) {
        try { fs.rmSync(leftover, { force: true }) } catch {}
      }
      const passed = !exit.timedOut && !exit.spawnFailed && !exit.terminationUnverified &&
        !!observed && observed.nonce === nonce && observed.workWrite === 1 &&
        observed.ownerHomeWrite === 0 && observed.githubReachable === 0
      job.probes = {
        nonce, passed, method: 'droid_exec_user_prompt_submit_hook', exitCode: exit.exitCode ?? null,
        timedOut: !!exit.timedOut, observed, settingsSha256: job.settingsSha256,
        generation: job.generation, ranAt: iso(now()),
      }
      saveJob(job)
      if (!passed) fail('native_containment_probe_failed', 503)
      return clone(job.probes)
    },

    async verifyWorkspace(input) {
      const job = loadJob(input.missionId)
      const w = input.workspace
      if (input.machineId !== machineId || w.machineId !== machineId) fail('native_workspace_machine_mismatch')
      if (job.state === 'revoked') fail('native_job_revoked')
      if (job.state === 'recovery_required') fail('native_broker_restarted_reprepare_required')
      if (w.cwd !== job.workDir || w.repository !== job.repository || w.baseRef !== job.baseRef ||
          (w.baseSha && w.baseSha !== job.baseSha)) fail('native_workspace_checkout_mismatch')
      const cwd = fs.realpathSync(job.workDir)
      if (cwd !== job.workDir) fail('native_workspace_alias_refused')
      const repoRoot = await query({ kind: 'root' }, cwd)
      const gitDir = await query({ kind: 'git_dir' }, cwd)
      const commonDir = await query({ kind: 'common_dir' }, cwd)
      const objectFormat = await query({ kind: 'object_format' }, cwd)
      const head = await query({ kind: 'head_sha' }, cwd)
      const ref = await query({ kind: 'execution_ref' }, cwd)
      const dirty = await query({ kind: 'dirty' }, cwd)
      if (head !== job.baseSha || dirty.length || ref !== job.executionRef) fail('native_clean_initial_checkout_required')
      const remote = (await runGit(['-C', cwd, 'remote', 'get-url', 'origin'], { cwd })).trim()
      const identity = path => {
        const stat = fs.statSync(path, { bigint: true })
        return { device: String(stat.dev), inode: String(stat.ino) }
      }
      const at = now(), expiresAt = iso(at + NATIVE_LEASE_MAX_MS)
      const evidenceId = `ev-${randomId()}`
      // The subject hash covers evidenceIds, so the id is fixed before signing.
      const proof = {
        attestationId: `attestation-${randomId()}`, nonce: input.nonce, binding: bind(input),
        executionHostId, executionInstanceId: job.instanceId,
        canonicalCwd: cwd, canonicalRepoRoot: repoRoot, canonicalGitDir: gitDir, canonicalCommonDir: commonDir,
        rootIdentity: identity(repoRoot), gitDirIdentity: identity(gitDir),
        repositoryId: job.repository, objectFormat, baseRef: job.baseRef, baseSha: job.baseSha,
        initialHeadSha: head, executionRef: job.executionRef, checkoutGeneration: job.checkoutGeneration,
        observedAt: iso(at), expiresAt, evidenceIds: [evidenceId],
      }
      const facts = {
        physical_workspace: { realpath: cwd, gitToplevel: repoRoot, gitDir, headSha: head, executionRef: ref,
          remoteUrl: stripUrlCredentials(remote), clean: true },
        destination_identity: { repository: job.repository, remoteUrl: stripUrlCredentials(remote),
          createdPrivate: job.created, baseRef: job.baseRef, baseSha: job.baseSha },
      }
      attest({ evidenceId, missionId: job.missionId, kind: 'workspace', subject: proof, binding: input, nonce: input.nonce, facts })
      attestations.set(proof.attestationId, { missionId: job.missionId, expiresAt })
      return proof
    },

    async acquireLease(input) {
      validateRuntime()
      const job = loadJob(input.missionId)
      const attestation = attestations.get(input.workspaceAttestationId)
      if (!attestation || attestation.missionId !== job.missionId || Date.parse(attestation.expiresAt) <= now()) fail('native_workspace_attestation_unknown')
      if (job.state !== 'running' || !isAlive(job.missionId) || !job.daemon) fail('native_daemon_not_running', 503)
      if (!job.probes?.passed || job.probes.generation !== job.generation ||
          job.probes.settingsSha256 !== job.settingsSha256) fail('native_containment_unproven', 503)
      if (input.scopeHash !== job.hashes.scopeHash || input.policyHash !== job.hashes.policyHash ||
          input.machineId !== machineId) fail('native_lease_binding_mismatch')
      digest(input.compiledPolicyHash); id(input.nonce)
      if (nativeBudgetEnforcement(job.intent) !== 'none') fail('native_budget_enforcement_unavailable', 503)
      const dimensions = nativeRequiredDimensions(job.intent)
      if (dimensions.some(dimension => !NATIVE_HOST_DIMENSIONS.includes(dimension))) fail('native_host_dimension_unavailable', 503)
      const consequences = nativeConsequences(job.intent)
      const settings = settingsFor(job)
      const credentials = await cloneCredentialFacts(job)
      const home = homeCredentialFacts(job)
      if (credentials.credentialHelpers || credentials.remoteHasUserinfo || home.present.length ||
          job.daemon.envKeys.join(',') !== [...DAEMON_ENV_KEYS].sort().join(',')) fail('native_credential_isolation_unproven', 503)
      const at = now()
      // A denylist and scrubbed environment do not isolate arbitrary owner files
      // or the daemon's own FACTORY_API_KEY from agent code. Never sign that claim.
      // Trusted host: the owner accepted that agent code can read the daemon's key,
      // exactly as when they run droid themselves on this machine.
      if (dimensions.includes('credential_isolation') && !trustedHost) fail('native_credential_isolation_unproven', 503)
      const lease = {
        leaseId: `lease-${randomId()}`, binding: bind(input), workspaceAttestationId: input.workspaceAttestationId,
        deploymentDigest, boundaryPolicyHash: input.compiledPolicyHash, revocationGeneration: job.generation,
        expiresAt: iso(Math.min(at + NATIVE_LEASE_MAX_MS, Date.parse(attestation.expiresAt))),
        budget: { enforcement: 'none' }, evidenceIds: [],
      }
      const containment = {
        settingsSha256: job.settingsSha256, mode: settings.sandbox.enabled === false ? 'unsandboxed' : settings.sandbox.mode,
        allowWrite: settings.sandbox.filesystem?.allowWrite ?? [],
        probe: job.probes,
      }
      const all = {
        physical_workspace: { workDir: job.workDir, baseSha: job.baseSha, executionRef: job.executionRef },
        filesystem_containment: containment,
        bounded_checkout_writes: containment,
        credential_isolation: { daemonEnvKeys: job.daemon.envKeys, home, clone: credentials },
        consequence_mediation: { allowedDomains: settings.sandbox.network?.allowedDomains ?? null,
          githubReachableFromSandbox: job.probes.observed.githubReachable === 1, deliveryPerformedBy: 'broker' },
        root_worker_validator_coverage: trustedHost
          ? { mode: 'unsandboxed', coverage: 'owner-trusted host: root, workers and validators run without a sandbox' }
          : { mode: 'whole-process', coverage: 'root, workers and validators share one sandboxed process tree' },
        ongoing_revocation: { daemonPid: job.daemon.pid, revokePath: ['SIGTERM', `SIGKILL after ${STOP_GRACE_MS}ms`, 'generation bump'],
          generation: job.generation },
        usage_reporting: { enforced: false, method: 'next_day_factory_analytics', budget: 'none' },
        delivery_mediation: { consequences, performedBy: 'broker_outside_sandbox', agentHoldsGithubCredentials: false },
      }
      const facts = Object.fromEntries(dimensions.map(dimension => [dimension, all[dimension]]))
      const evidenceId = `ev-${randomId()}`
      lease.evidenceIds = [evidenceId]
      attest({ evidenceId, missionId: job.missionId, kind: 'lease', subject: lease, binding: input, nonce: input.nonce, facts })
      leases.set(lease.leaseId, { lease: clone(lease), missionId: job.missionId, revoked: false, hostExpiresAt: Date.parse(lease.expiresAt) })
      return lease
    },

    /**
     * Host-side renewal while the daemon runs; issued leases never outlive revocation.
     * This never extends send authority: the signed lease.expiresAt (capped by the
     * workspace attestation) is what the provider guard and boundary enforce, and
     * authorizeSend refuses past it. Sending later requires a fresh acquireLease.
     */
    renewLeases() {
      for (const row of leases.values()) {
        if (!row.revoked && isAlive(row.missionId) && loadJob(row.missionId).state === 'running') row.hostExpiresAt = now() + NATIVE_LEASE_MAX_MS
      }
    },

    async authorizeSend(input) {
      validateRuntime()
      for (const [permitId, row] of issued) if (Date.parse(row.permit.expiresAt) <= now()) issued.delete(permitId)
      const row = leases.get(input.leaseId)
      if (!row || row.revoked || row.missionId !== input.missionId) fail('native_lease_unknown_or_revoked')
      const job = loadJob(row.missionId)
      if (row.lease.revocationGeneration !== job.generation || !isAlive(row.missionId) || row.hostExpiresAt <= now()) fail('native_lease_unknown_or_revoked')
      // Never mint a permit the signed lease no longer covers, renewed or not.
      const signedExpiresAt = Date.parse(row.lease.expiresAt)
      if (!(signedExpiresAt > now())) fail('native_lease_expired_reacquire_required')
      if (hash(bind(input)) !== hash(row.lease.binding)) fail('native_send_binding_mismatch')
      str(input.connectionId, 256); id(input.sessionId); digest(input.requestHash)
      const permit = {
        permitId: `permit-${randomId()}`, leaseId: row.lease.leaseId, connectionId: input.connectionId,
        operation: input.operation, sessionId: input.sessionId, requestHash: input.requestHash,
        expiresAt: iso(Math.min(now() + NATIVE_PERMIT_MAX_MS, row.hostExpiresAt, signedExpiresAt)),
        revocationGeneration: job.generation,
      }
      issued.set(permit.permitId, { permit: clone(permit), missionId: row.missionId })
      return permit
    },

    assertAndConsumePermit(permit) {
      object(permit, ['permitId', 'leaseId', 'connectionId', 'operation', 'sessionId', 'requestHash', 'expiresAt', 'revocationGeneration'])
      const row = issued.get(permit.permitId)
      if (!row || hash(row.permit) !== hash(permit)) fail('native_permit_unknown_or_reused')
      issued.delete(permit.permitId)
      const lease = leases.get(permit.leaseId)
      if (!lease || lease.revoked || Date.parse(permit.expiresAt) <= now() || !isAlive(row.missionId) ||
          lease.lease.revocationGeneration !== permit.revocationGeneration) fail('native_permit_revoked_or_expired')
    },

    async revoke(input) {
      const job = loadJob(input.missionId)
      job.generation += 1; job.state = 'revoked'
      for (const row of leases.values()) if (row.missionId === job.missionId) row.revoked = true
      for (const [permitId, row] of issued) if (row.missionId === job.missionId) issued.delete(permitId)
      saveJob(job)
      const stop = await stopChild(job.missionId)
      job.terminationVerified = true
      saveJob(job)
      const evidenceId = `ev-${randomId()}`
      const receipt = { receiptId: `revoke-${randomId()}`, revocationGeneration: job.generation, evidenceIds: [evidenceId] }
      attest({
        evidenceId, missionId: job.missionId, kind: 'revocation', subject: { ...receipt, reason: String(input.reason ?? '').slice(0, 256) },
        binding: input, nonce: `revoke-${receipt.receiptId}`,
        facts: { ongoing_revocation: { stop, generation: job.generation, daemonPid: job.daemon?.pid ?? null } },
      })
      return receipt
    },

    /** Inputs for broker-side delivery; the daemon must already be stopped. */
    deliveryInput(missionId) {
      const job = loadJob(missionId)
      if (isAlive(missionId)) fail('native_daemon_still_running')
      if (job.state === 'recovery_required' || (job.daemon && !job.terminationVerified)) fail('native_orphan_termination_unverified', 503)
      return {
        missionId: job.missionId, workDir: job.workDir, repository: canonicalRepositoryId(job.repository), repositoryUrl: job.repositoryUrl,
        baseRef: job.baseRef, baseSha: job.baseSha,
        policy: {
          allowCreateRepository: job.intent.policy.allowCreateRepository, allowPush: job.intent.policy.allowPush,
          allowPr: job.intent.policy.allowPr, allowMerge: job.intent.policy.allowMerge,
        },
      }
    },
    /** Local facts only; caller must separately journal/authorize each remote
     * create and initial-base push. created:false must never mean adoption. */
    privateRepositoryInitializationInput(missionId) {
      const job = loadJob(missionId)
      if (!job.localSeed || job.intent.destination?.kind !== 'new_repository' ||
          !job.intent.scopeApproved || !job.intent.highAutonomyApproved ||
          !job.intent.policy.allowCreateRepository || !job.intent.policy.allowPush ||
          job.intent.workspace.baseSha !== job.baseSha) fail('native_private_repository_initialization_not_approved', 409)
      return {
        ...host.deliveryInput(missionId), account: job.intent.destination.account,
        name: job.intent.destination.name, visibility: 'private', initialization: 'empty',
        seedSha: job.baseSha, requiresCreatedRepository: true, adoptionAllowed: false,
      }
    },
  }

  return Object.freeze(host)
}

/**
 * Routes BrokerTransport calls to one provider per job, each bound to that
 * job's dedicated daemon and workspace host metadata.
 */
export function createHostRoutedTransport({ host, createJobTransport, createAdmissionTransport, version, support }) {
  if (!host || typeof createJobTransport !== 'function' || typeof createAdmissionTransport !== 'function') fail('native_host_transport_invalid', 503)
  str(version, 256)
  const transports = new Map()
  const pending = new Map()
  const forJob = missionId => {
    let row = transports.get(missionId)
    if (!row) {
      if (!pending.has(missionId)) {
        const result = createJobTransport({ missionId, phase: 'execution', daemon: host.daemonFor(missionId), workspaceHost: host.workspaceHostFor(missionId) })
        if (result?.then) {
          // forget() may run while this is still connecting; a late transport
          // must then be closed, never installed for the forgotten mission.
          const inflight = Promise.resolve(result).then(value => {
            if (pending.get(missionId) !== inflight) { value?.close?.(); fail('native_provider_forgotten') }
            transports.set(missionId, value); pending.delete(missionId); return value
          }, error => { if (pending.get(missionId) === inflight) pending.delete(missionId); throw error })
          pending.set(missionId, inflight)
        } else transports.set(missionId, result)
      }
      row = transports.get(missionId) ?? pending.get(missionId)
    }
    return row
  }
  return Object.freeze({
    version, support: Object.freeze({ ...support }),
    async inspectAdmission(draft, context) {
      const workspace = await host.resolveAdmissionWorkspace(draft)
      const prospective = false // Local seeds are now real physical workspaces.
      const inspection = await createAdmissionTransport({
        missionId: context.missionId, phase: 'admission', daemon: null,
        workspaceHost: prospective ? undefined : host.workspaceHostFor(context.missionId),
        resolveAdmissionWorkspace: async () => clone(workspace),
        prospectiveNewRepository: prospective,
      })
      return inspection.inspectAdmission(draft, context)
    },
    validateProviderRecord(value, context) {
      // Journal validation is synchronous, including while lazily composing.
      const row = transports.get(context.missionId)
      if (!row) fail('native_provider_not_ready')
      return row.validateProviderRecord?.(value, context)
    },
    preflight: async (intent, context) => (await forJob(context.missionId)).preflight(intent, context),
    launch: async (intent, context) => (await forJob(context.missionId)).launch(intent, context),
    answer: async (answer, context) => (await forJob(context.missionId)).answer(answer, context),
    observe: async (binding, context) => (await forJob(context.missionId)).observe(binding, context),
    forget(missionId) { transports.get(missionId)?.close?.(); transports.delete(missionId); pending.delete(missionId) },
  })
}

/**
 * Next-day per-session usage from Factory Analytics. Not a budget: Factory
 * exposes no live per-job usage. Non-Enterprise accounts get 403 -> unavailable.
 */
export function createNativeUsageClient({
  apiKeyFile, fetch = globalThis.fetch, baseUrl = 'https://api.factory.ai', now = Date.now, fs = nodeFs,
}) {
  if (typeof apiKeyFile !== 'string' || !apiKeyFile.startsWith('/') || typeof fetch !== 'function') fail('native_usage_client_invalid', 503)
  return Object.freeze({
    async query({ sessionIds, completedAt }) {
      const done = Date.parse(completedAt)
      if (!Number.isFinite(done)) return { state: 'pending' }
      const nextDay = new Date(done); nextDay.setUTCHours(24, 0, 0, 0)
      if (now() < nextDay.getTime()) return { state: 'pending' }
      let key
      try { key = fs.readFileSync(apiKeyFile, 'utf8').trim() } catch { return { state: 'unavailable' } }
      let response
      try {
        response = await fetch(`${baseUrl}/api/v1/analytics/cost/me/query?queryKey=top_sessions`, {
          headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        })
      } catch { return { state: 'pending' } }
      if (response.status === 403 || response.status === 401) return { state: 'unavailable' }
      if (!response.ok) return { state: 'pending' }
      let body
      try { body = await response.json() } catch { return { state: 'pending' } }
      const rows = [body?.data, body?.rows, body?.results, body?.sessions, body].find(Array.isArray) ?? []
      let credits = 0, found = 0
      for (const row of rows) {
        const sessionId = row?.sessionId ?? row?.session_id ?? row?.id
        if (!sessionIds.includes(sessionId)) continue
        const value = [row.credits, row.totalCredits, row.cost, row.total_credits].find(Number.isFinite)
        if (value === undefined) continue
        credits += value; found++
      }
      return found ? { state: 'available', credits } : { state: 'pending' }
    },
  })
}
