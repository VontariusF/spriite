import { verify, createHash, createPublicKey, KeyObject } from 'node:crypto'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { BrokerError, canonical, hash, object, str, id, time, digest, array, bool, one, boundedJson } from './validation.mjs'

export const QUALIFICATION_GATES = Object.freeze([
  'initialization_workspace', 'proposal_start_scope', 'root_child_attention',
  'owner_machine_routing', 'restart_resolution', 'replay_containment',
  'effective_settings_policy_cost', 'snapshot_completeness', 'readonly_finalization',
])
export const unavailableCapabilities = (transportVersion = 'unavailable') => ({
  protocolVersion: 1, qualificationId: null, transportVersion, qualified: false,
  launch: false, rootAttention: false, childAttention: false, recoverAttention: false,
  pause: false, resume: false, cancel: false,
})
async function boundedFile(path, max) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > max) throw new Error()
    const bytes = Buffer.alloc(max + 1)
    let length = 0, read
    do {
      read = (await file.read(bytes, length, bytes.length - length, null)).bytesRead
      length += read
      if (length > max) throw new Error()
    } while (read)
    return bytes.subarray(0, length)
  } finally { await file.close() }
}

/** Host-provisioned, signed evidence; never accept client capability flags. */
export async function loadQualification({ path, publicKey, ownerId, machineId, transportVersion, now = Date.now() } = {}) {
  if (!path || !publicKey) return null
  try {
    if (!isAbsolute(path)) throw new Error()
    const envelope = JSON.parse((await boundedFile(path, 65536)).toString('utf8'))
    boundedJson(envelope, 65536)
    object(envelope, ['manifest', 'signature'])
    str(envelope.signature, 256)
    const m = envelope.manifest
    object(m, ['version', 'qualificationId', 'ownerId', 'machineId', 'transportVersion', 'issuedAt', 'expiresAt', 'gates', 'controls'])
    if (m.version !== 1 || m.ownerId !== ownerId || m.machineId !== machineId || m.transportVersion !== transportVersion) throw new Error()
    id(m.qualificationId); time(m.issuedAt); time(m.expiresAt)
    if (Date.parse(m.issuedAt) > now || Date.parse(m.expiresAt) <= now) throw new Error()
    if (!verify(null, Buffer.from(canonical(m)), publicKey, Buffer.from(envelope.signature, 'base64'))) throw new Error()
    array(m.gates, QUALIFICATION_GATES.length, row => {
      object(row, ['name', 'evidencePath', 'sha256', 'verifiedAt'])
      str(row.name, 128); str(row.evidencePath, 2048); digest(row.sha256); time(row.verifiedAt)
      if (Date.parse(row.verifiedAt) > now || Date.parse(row.verifiedAt) < Date.parse(m.issuedAt)) throw new Error()
    })
    if (QUALIFICATION_GATES.some(gate => m.gates.filter(row => row.name === gate).length !== 1)) throw new Error()
    for (const row of m.gates) {
      if (!isAbsolute(row.evidencePath)) throw new Error()
      // Evidence bytes are signed by digest; parsing prose cannot establish a gate.
      const bytes = await boundedFile(row.evidencePath, 1048576)
      const { createHash } = await import('node:crypto')
      if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new Error()
    }
    object(m.controls, ['pause', 'resume', 'cancel'])
    for (const key of Object.keys(m.controls)) bool(m.controls[key])
    boundedJson(m, 65536)
    return { ...m, manifestHash: hash(m) }
  } catch {
    throw new BrokerError('qualification_invalid', 503)
  }
}

export const HOST_QUALIFICATION_CHECKS = Object.freeze(['containment_probes', 'mission_delivery', 'revocation'])
const hostQualifications = new WeakSet()
const asPublicKey = key => key instanceof KeyObject && key.type === 'public' ? key : createPublicKey(key)
export const publicKeySha256 = key => createHash('sha256')
  .update(asPublicKey(key).export({ type: 'spki', format: 'der' })).digest('hex')

/**
 * Pure verification of a live host canary record: signed, unexpired, every
 * check passed, and bound to this deployment digest and this host public key.
 */
export function verifyHostQualification(envelope, { publicKey, deploymentDigest, hostPublicKey, machineId, now = Date.now() }) {
  try {
    boundedJson(envelope, 65536)
    object(envelope, ['manifest', 'signature'])
    str(envelope.signature, 256)
    const m = envelope.manifest
    object(m, ['version', 'kind', 'qualificationId', 'machineId', 'deploymentDigest', 'hostPublicKeySha256',
      'droidVersion', 'issuedAt', 'expiresAt', 'checks'])
    if (m.version !== 1 || m.kind !== 'host_qualification' || m.machineId !== machineId ||
        m.deploymentDigest !== deploymentDigest || m.hostPublicKeySha256 !== publicKeySha256(hostPublicKey)) throw new Error()
    id(m.qualificationId); str(m.droidVersion, 64); time(m.issuedAt); time(m.expiresAt)
    if (Date.parse(m.issuedAt) > now || Date.parse(m.expiresAt) <= now) throw new Error()
    if (!verify(null, Buffer.from(canonical(m)), asPublicKey(publicKey), Buffer.from(envelope.signature, 'base64'))) throw new Error()
    array(m.checks, HOST_QUALIFICATION_CHECKS.length, row => {
      object(row, ['name', 'passed', 'evidenceSha256', 'verifiedAt'])
      one(row.name, HOST_QUALIFICATION_CHECKS); digest(row.evidenceSha256); time(row.verifiedAt)
      if (row.passed !== true || Date.parse(row.verifiedAt) < Date.parse(m.issuedAt) || Date.parse(row.verifiedAt) > now) throw new Error()
    })
    if (HOST_QUALIFICATION_CHECKS.some(name => m.checks.filter(row => row.name === name).length !== 1)) throw new Error()
    const result = Object.freeze({ ...structuredClone(m), manifestHash: hash(m) })
    hostQualifications.add(result)
    return result
  } catch {
    throw new BrokerError('host_qualification_invalid', 503)
  }
}
export async function loadHostQualification({ path, ...expected } = {}) {
  if (!path) return null
  if (!isAbsolute(path)) throw new BrokerError('host_qualification_invalid', 503)
  let envelope
  try { envelope = JSON.parse((await boundedFile(path, 65536)).toString('utf8')) }
  catch { throw new BrokerError('host_qualification_invalid', 503) }
  return verifyHostQualification(envelope, expected)
}
export function isHostQualificationFor(record, { deploymentDigest, hostPublicKey, now = Date.now() } = {}) {
  if (!record || !hostQualifications.has(record) || !hostPublicKey) return false
  try {
    return record.deploymentDigest === deploymentDigest && Date.parse(record.expiresAt) > now &&
      record.hostPublicKeySha256 === publicKeySha256(hostPublicKey)
  } catch { return false }
}

export function capabilitiesFor(qualification, transport, now = Date.now()) {
  const result = unavailableCapabilities(transport?.version)
  if (!qualification || Date.parse(qualification.expiresAt) <= now || qualification.transportVersion !== transport?.version) return result
  const support = transport.support ?? {}
  // A signed qualification cannot make an adapter implement missing behavior.
  result.qualificationId = qualification.qualificationId
  result.qualified = true
  result.launch = support.launch === true
  result.rootAttention = support.rootAttention === true
  result.childAttention = support.childAttention === true
  result.recoverAttention = support.recoverAttention === true
  // This broker does not yet implement a proven whole-Mission control contract.
  // Even a signed manifest cannot turn interrupt/close into pause/cancel semantics.
  return result
}
