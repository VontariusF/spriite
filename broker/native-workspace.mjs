/**
 * Bounded read-only checkout observation and signed-proof validation. Observation
 * is not provisioning, a sandbox, or remote-machine identity authentication.
 */
import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, normalize, relative, sep } from 'node:path'
import { fail, object, str, id, digest, hash, boundedJson, BrokerError } from './validation.mjs'
import { validateFullGitRef, validateGitSha, validateHostBinding, getNativeHashes, freezeNative } from './native-policy.mjs'
import { assertNativeFreshness, verifyNativeEvidence } from './native-boundary.mjs'

export const NATIVE_GIT_MAX_SLOTS = 8
export const NATIVE_GIT_TIMEOUT_MS = 3000
export const NATIVE_GIT_MAX_BYTES = 262144
const verifiedProofs = new WeakSet()
const PROOF_KEYS = [
  'attestationId', 'nonce', 'binding', 'executionHostId', 'executionInstanceId',
  'canonicalCwd', 'canonicalRepoRoot', 'canonicalGitDir', 'canonicalCommonDir',
  'rootIdentity', 'gitDirIdentity', 'repositoryId', 'objectFormat', 'baseRef',
  'baseSha', 'initialHeadSha', 'executionRef', 'checkoutGeneration',
  'observedAt', 'expiresAt', 'evidenceIds',
]

export function validateCanonicalWorkspacePath(value) {
  str(value, 2048)
  if (!isAbsolute(value) || normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value) ||
      (value !== sep && value.endsWith(sep))) fail('native_canonical_workspace_required')
  return value
}
function inside(root, path) {
  const r = relative(root, path)
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r))
}
function permitted(path, roots) {
  validateCanonicalWorkspacePath(path)
  if (!Array.isArray(roots) || !roots.length || roots.length > 16 ||
      !roots.some(root => inside(validateCanonicalWorkspacePath(root), path))) fail('native_workspace_outside_permitted_roots')
}
function identity(value) {
  object(value, ['device', 'inode'])
  for (const key of ['device', 'inode']) {
    if (typeof value[key] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value[key]) || value[key].length > 32) fail('native_workspace_identity_invalid')
  }
}
function expectedBinding(intent, context) {
  const hashes = getNativeHashes(intent)
  const expected = {
    ownerId: intent.ownerId, missionId: intent.missionId,
    machineId: intent.workspace.machineId, ...hashes, epoch: context.epoch,
  }
  validateHostBinding(expected, context)
  return expected
}
function hostMetadata(host, binding) {
  for (const key of ['executionHostId', 'executionInstanceId', 'checkoutGeneration']) id(host?.[key])
  str(host.repositoryId, 512); digest(host.deploymentDigest)
  if (host.executionMachineId !== binding.machineId) fail('native_workspace_machine_mismatch')
  if (host.executionRef !== null) validateFullGitRef(host.executionRef)
  if (!Array.isArray(host.permittedRoots) || !host.permittedRoots.length || host.permittedRoots.length > 16) fail('native_workspace_roots_required')
  host.permittedRoots.forEach(validateCanonicalWorkspacePath)
}

export function isVerifiedWorkspaceProof(proof) {
  return !!proof && verifiedProofs.has(proof)
}

export function validateWorkspaceProof(proof, intent, context, {
  host, nonce, evidenceAuthority, now = Date.now(), initialProof,
}) {
  boundedJson(proof, 65536)
  object(proof, PROOF_KEYS)
  const binding = expectedBinding(intent, context)
  validateHostBinding(proof.binding, binding)
  hostMetadata(host, binding)
  id(proof.attestationId); id(proof.nonce); id(nonce)
  if (proof.nonce !== nonce || proof.executionHostId !== host.executionHostId ||
      proof.executionInstanceId !== host.executionInstanceId ||
      proof.checkoutGeneration !== host.checkoutGeneration ||
      proof.repositoryId !== host.repositoryId || proof.repositoryId !== intent.workspace.repository ||
      proof.executionRef !== host.executionRef) fail('native_workspace_instance_mismatch')
  for (const key of ['canonicalCwd', 'canonicalRepoRoot', 'canonicalGitDir', 'canonicalCommonDir']) permitted(proof[key], host.permittedRoots)
  if (proof.canonicalCwd !== intent.workspace.cwd ||
      !inside(proof.canonicalRepoRoot, proof.canonicalCwd)) fail('native_workspace_checkout_mismatch')
  // Initial source supports standalone pre-provisioned repositories. Shared
  // worktree Git administration/lifecycle requires additional deployed proof.
  if (proof.canonicalGitDir !== proof.canonicalCommonDir) fail('native_shared_git_admin_unavailable')
  if (!inside(proof.canonicalRepoRoot, proof.canonicalGitDir) ||
      proof.canonicalRepoRoot === proof.canonicalGitDir) fail('native_git_admin_outside_checkout')
  identity(proof.rootIdentity); identity(proof.gitDirIdentity)
  validateFullGitRef(proof.baseRef)
  validateGitSha(proof.baseSha, proof.objectFormat)
  validateGitSha(proof.initialHeadSha, proof.objectFormat)
  if (proof.baseRef !== intent.workspace.baseRef || proof.baseSha !== intent.workspace.baseSha ||
      proof.initialHeadSha !== proof.baseSha) fail('native_workspace_base_mismatch')
  if (proof.executionRef !== null) validateFullGitRef(proof.executionRef)
  assertNativeFreshness(proof.observedAt, proof.expiresAt, now)
  if (initialProof) {
    if (!verifiedProofs.has(initialProof)) fail('native_initial_workspace_proof_required')
    for (const key of ['executionHostId', 'executionInstanceId', 'canonicalCwd', 'canonicalRepoRoot',
      'canonicalGitDir', 'canonicalCommonDir', 'rootIdentity', 'gitDirIdentity', 'repositoryId',
      'objectFormat', 'baseRef', 'baseSha', 'initialHeadSha', 'executionRef', 'checkoutGeneration']) {
      if (hash(proof[key]) !== hash(initialProof[key])) fail('native_workspace_replaced')
    }
  }
  verifyNativeEvidence(evidenceAuthority, proof.evidenceIds, {
    kind: 'workspace', subjectHash: hash(proof), binding, nonce,
    deploymentDigest: host.deploymentDigest,
    dimensions: ['physical_workspace', 'destination_identity'], now,
  })
  const result = freezeNative(structuredClone(proof))
  verifiedProofs.add(result)
  return result
}

/** Finite argv builder; callers never supply arbitrary arguments or commands. */
export function buildNativeGitArgs(query, cwd) {
  validateCanonicalWorkspacePath(cwd)
  object(query, ['kind', 'ref', 'baseSha', 'headSha'], ['kind'])
  let args
  switch (query.kind) {
    case 'root': args = ['rev-parse', '--show-toplevel']; break
    case 'git_dir': args = ['rev-parse', '--absolute-git-dir']; break
    case 'common_dir': args = ['rev-parse', '--path-format=absolute', '--git-common-dir']; break
    case 'object_format': args = ['rev-parse', '--show-object-format']; break
    case 'base_sha':
      validateFullGitRef(query.ref)
      args = ['rev-parse', '--verify', '--end-of-options', `${query.ref}^{commit}`]
      break
    case 'base_object':
      validateGitSha(query.baseSha)
      args = ['rev-parse', '--verify', '--end-of-options', `${query.baseSha}^{commit}`]
      break
    case 'head_sha': args = ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']; break
    case 'execution_ref': args = ['symbolic-ref', '--quiet', 'HEAD']; break
    case 'dirty': args = ['status', '--porcelain=v1', '-z', '--untracked-files=all']; break
    case 'ancestor':
      validateGitSha(query.baseSha); validateGitSha(query.headSha)
      args = ['merge-base', '--is-ancestor', query.baseSha, query.headSha]
      break
    default: return fail('native_git_query_unavailable')
  }
  const expectedKeys = {
    base_sha: ['kind', 'ref'], base_object: ['kind', 'baseSha'], ancestor: ['kind', 'baseSha', 'headSha'],
  }[query.kind] ?? ['kind']
  object(query, expectedKeys)
  return Object.freeze([
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args,
  ])
}

/** Optional trusted, co-located production port. Does not run at import time. */
export function createProductionGitRunner({
  gitExecutable, timeoutMs = NATIVE_GIT_TIMEOUT_MS, maxBytes = NATIVE_GIT_MAX_BYTES,
  execFilePort = execFile,
}) {
  validateCanonicalWorkspacePath(gitExecutable)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > NATIVE_GIT_TIMEOUT_MS ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > NATIVE_GIT_MAX_BYTES ||
      typeof execFilePort !== 'function') fail('native_git_limits_invalid')
  let active = 0
  return async ({ query, cwd, args }) => {
    const fixed = buildNativeGitArgs(query, cwd)
    if (hash(args) !== hash(fixed)) fail('native_git_argv_mismatch')
    if (active >= NATIVE_GIT_MAX_SLOTS) fail('native_git_capacity_exceeded', 503)
    active++
    try {
      return await new Promise((resolve, reject) => {
        execFilePort(gitExecutable, fixed, {
          shell: false, timeout: timeoutMs, maxBuffer: maxBytes, encoding: 'buffer',
          windowsHide: true,
          env: {
            PATH: '/usr/bin:/bin', HOME: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
            LC_ALL: 'C', LANG: 'C',
          },
        }, (error, stdout, stderr) => {
          if (stdout.length > maxBytes || stderr.length > maxBytes ||
              (error && (error.killed || error.signal || error.code !== 1 ||
                !['execution_ref', 'ancestor'].includes(query.kind)))) {
            reject(new Error('native_git_read_failed'))
          } else resolve({ stdout, exitCode: error ? 1 : 0 })
        })
      })
    } finally { active-- }
  }
}

export function createNativeWorkspaceFsPort() {
  return Object.freeze({
    realpath,
    async identity(path) {
      const row = await stat(path, { bigint: true })
      if (!row.isDirectory()) fail('native_workspace_directory_required')
      return { device: String(row.dev), inode: String(row.ino) }
    },
  })
}

/**
 * Produces a read-only observation, not a signed proof. A separately qualified
 * host must attest it and provide evidence before validateWorkspaceProof accepts
 * execution. Remote providers must inspect on their own physical host, not here.
 */
export function createReadOnlyWorkspaceVerifier({ host, fs, git, now = Date.now, readTimeoutMs = NATIVE_GIT_TIMEOUT_MS }) {
  if (!fs || typeof fs.realpath !== 'function' || typeof fs.identity !== 'function' || typeof git !== 'function') fail('native_workspace_ports_required')
  if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1 || readTimeoutMs > NATIVE_GIT_TIMEOUT_MS) fail('native_git_limits_invalid')
  let active = 0, outstandingReads = 0
  const boundedRead = async operation => {
    if (outstandingReads >= NATIVE_GIT_MAX_SLOTS) fail('native_workspace_read_capacity_exceeded', 503)
    outstandingReads++
    const raw = Promise.resolve().then(operation)
    // A timed-out port remains accounted for until its actual settlement. Never
    // manufacture available capacity while abandoned I/O is still outstanding.
    raw.then(() => { outstandingReads-- }, () => { outstandingReads-- })
    let timer
    try {
      return await Promise.race([raw, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new BrokerError('native_workspace_read_timeout', 503)), readTimeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }
  return Object.freeze({
    async inspect(intent, context, { initialProof } = {}) {
      const binding = expectedBinding(intent, context)
      hostMetadata(host, binding)
      if (host.localMachineId !== host.executionMachineId) fail('native_remote_workspace_requires_host_verifier')
      if (active >= NATIVE_GIT_MAX_SLOTS) fail('native_workspace_capacity_exceeded', 503)
      if (initialProof && !verifiedProofs.has(initialProof)) fail('native_initial_workspace_proof_required')
      active++
      try {
        const cwd = validateCanonicalWorkspacePath(intent.workspace.cwd)
        permitted(cwd, host.permittedRoots)
        for (const root of host.permittedRoots) {
          if (await boundedRead(() => fs.realpath(root)) !== root) fail('native_permitted_root_not_canonical')
        }
        if (await boundedRead(() => fs.realpath(cwd)) !== cwd) fail('native_workspace_alias_refused')
        validateFullGitRef(intent.workspace.baseRef); validateGitSha(intent.workspace.baseSha)
        const read = async query => {
          const result = await boundedRead(() => git({ cwd, query, args: buildNativeGitArgs(query, cwd) }))
          object(result, ['stdout', 'exitCode'])
          const stdout = result.stdout
          if ((typeof stdout !== 'string' && !(stdout instanceof Uint8Array)) ||
              Buffer.byteLength(stdout) > NATIVE_GIT_MAX_BYTES ||
              ![0, 1].includes(result.exitCode) ||
              (result.exitCode === 1 && !['execution_ref', 'ancestor'].includes(query.kind))) fail('native_git_read_invalid')
          return { stdout: Buffer.from(stdout).toString('utf8'), exitCode: result.exitCode }
        }
        const canonical = async query => {
          const path = (await read(query)).stdout.replace(/\n$/, '')
          permitted(path, host.permittedRoots)
          if (await boundedRead(() => fs.realpath(path)) !== path) fail('native_git_path_not_canonical')
          return path
        }
        const canonicalRepoRoot = await canonical({ kind: 'root' })
        const canonicalGitDir = await canonical({ kind: 'git_dir' })
        const canonicalCommonDir = await canonical({ kind: 'common_dir' })
        if (!inside(canonicalRepoRoot, cwd)) fail('native_workspace_checkout_mismatch')
        if (canonicalGitDir !== canonicalCommonDir) fail('native_shared_git_admin_unavailable')
        if (!inside(canonicalRepoRoot, canonicalGitDir) || canonicalRepoRoot === canonicalGitDir) fail('native_git_admin_outside_checkout')
        const objectFormat = (await read({ kind: 'object_format' })).stdout.trim()
        validateGitSha(intent.workspace.baseSha, objectFormat)
        const baseSha = (await read(initialProof
          ? { kind: 'base_object', baseSha: intent.workspace.baseSha }
          : { kind: 'base_sha', ref: intent.workspace.baseRef })).stdout.trim()
        const currentHeadSha = (await read({ kind: 'head_sha' })).stdout.trim()
        validateGitSha(baseSha, objectFormat); validateGitSha(currentHeadSha, objectFormat)
        if (baseSha !== intent.workspace.baseSha) fail('native_workspace_base_mismatch')
        const ref = await read({ kind: 'execution_ref' })
        const executionRef = ref.exitCode === 1 ? null : validateFullGitRef(ref.stdout.trim())
        if (executionRef !== host.executionRef) fail('native_execution_ref_mismatch')
        const dirty = !!(await read({ kind: 'dirty' })).stdout.length
        if ((!initialProof && (currentHeadSha !== baseSha || dirty)) ||
            (intent.operation === 'inspect' && dirty)) fail('native_clean_initial_checkout_required')
        if (initialProof && (await read({ kind: 'ancestor', baseSha, headSha: currentHeadSha })).exitCode !== 0) fail('native_execution_lineage_mismatch')
        const rootIdentity = await boundedRead(() => fs.identity(canonicalRepoRoot))
        const gitDirIdentity = await boundedRead(() => fs.identity(canonicalGitDir))
        identity(rootIdentity); identity(gitDirIdentity)
        const observation = {
          binding, executionHostId: host.executionHostId, executionInstanceId: host.executionInstanceId,
          canonicalCwd: cwd, canonicalRepoRoot, canonicalGitDir, canonicalCommonDir,
          rootIdentity, gitDirIdentity, repositoryId: host.repositoryId, objectFormat,
          baseRef: intent.workspace.baseRef, baseSha,
          initialHeadSha: initialProof?.initialHeadSha ?? currentHeadSha,
          executionRef, checkoutGeneration: host.checkoutGeneration,
          currentHeadSha, dirty, observedAt: new Date(now()).toISOString(),
        }
        if (observation.repositoryId !== intent.workspace.repository) fail('native_repository_identity_mismatch')
        if (initialProof) {
          validateHostBinding(initialProof.binding, binding)
          for (const key of ['executionHostId', 'executionInstanceId', 'canonicalCwd', 'canonicalRepoRoot',
            'canonicalGitDir', 'canonicalCommonDir', 'rootIdentity', 'gitDirIdentity', 'repositoryId',
            'objectFormat', 'baseRef', 'baseSha', 'initialHeadSha', 'executionRef', 'checkoutGeneration']) {
            if (hash(observation[key]) !== hash(initialProof[key])) fail('native_workspace_replaced')
          }
        }
        // Re-read physical identities and HEAD to catch ordinary concurrent
        // replacement. This cannot defeat hostile TOCTOU without the host fence.
        if (await boundedRead(() => fs.realpath(cwd)) !== cwd ||
            hash(await boundedRead(() => fs.identity(canonicalRepoRoot))) !== hash(rootIdentity) ||
            hash(await boundedRead(() => fs.identity(canonicalGitDir))) !== hash(gitDirIdentity) ||
            (await read({ kind: 'head_sha' })).stdout.trim() !== currentHeadSha) fail('native_workspace_changed_during_read')
        return freezeNative(observation)
      } finally { active-- }
    },
  })
}
