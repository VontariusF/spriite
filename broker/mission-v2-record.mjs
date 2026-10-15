// Read-only verifier for Factory Mission v2 durable records
// (~/.factory/missionsV2/<rootSessionId>/). Schemas and hash definitions
// mirror droid 0.227.0: planHash = sha256(mission.md bytes),
// checksHash = sha256(checks.json bytes), latestEventNumber = number of
// events in events.jsonl.
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

export const MISSION_V2_SESSION_ID = /^[A-Za-z0-9-]{1,128}$/
export const MISSION_V2_OUTCOMES = Object.freeze(['met', 'unmet', 'waived'])
export const MISSION_V2_EVENT_TYPES = Object.freeze(['checks_evaluated'])
export const MISSION_V2_CHECK_KINDS = Object.freeze(['verification', 'review', 'decision'])
// droid rejects any single events.jsonl line above 256 KiB.
export const MISSION_V2_MAX_EVENT_LINE_BYTES = 262_144

const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ARTIFACT_REFERENCE = /\[\[([A-Za-z0-9][A-Za-z0-9._-]*)(?:#([^\]\r\n]+))?\]\]/g
const SHA256_HEX = /^[a-f0-9]{64}$/
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
const NEWLINE = 0x0a

class RecordFailure extends Error {
  constructor(reason) {
    super(reason)
    this.reason = reason
  }
}

const reject = (reason) => { throw new RecordFailure(reason) }

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const hasOnlyKeys = (value, required, optional = []) => {
  if (!isPlainObject(value)) return false
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) if (!allowed.has(key)) return false
  for (const key of required) if (!Object.hasOwn(value, key)) return false
  return true
}

const nonEmpty = (value) => typeof value === 'string' && value.length > 0
// zod `.trim().min(1)`: non-empty after trimming.
const nonBlank = (value) => typeof value === 'string' && value.trim().length > 0
const optional = (value, test) => value === undefined || test(value)
const nonNegativeInt = (value) => Number.isSafeInteger(value) && value >= 0

export function isMissionV2Datetime(value) {
  if (typeof value !== 'string') return false
  const match = ISO_DATETIME.exec(value)
  if (!match) return false
  const [, y, mo, d, h, mi, s] = match.map(Number)
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

function validSnapshot(snapshot) {
  if (!hasOnlyKeys(snapshot, ['sessionId', 'title', 'approvedAt', 'latestEventNumber', 'planHash', 'checksHash', 'checkCounts'])) return false
  const counts = snapshot.checkCounts
  return nonBlank(snapshot.sessionId)
    && nonEmpty(snapshot.title)
    && isMissionV2Datetime(snapshot.approvedAt)
    && nonNegativeInt(snapshot.latestEventNumber)
    && typeof snapshot.planHash === 'string' && SHA256_HEX.test(snapshot.planHash)
    && typeof snapshot.checksHash === 'string' && SHA256_HEX.test(snapshot.checksHash)
    && hasOnlyKeys(counts, ['total', 'met', 'unmet', 'waived'])
    && nonNegativeInt(counts.total) && nonNegativeInt(counts.met)
    && nonNegativeInt(counts.unmet) && nonNegativeInt(counts.waived)
}

function validCheck(check) {
  return hasOnlyKeys(check, ['id', 'group', 'description'], ['about', 'kind', 'how'])
    && nonBlank(check.id) && nonBlank(check.group) && nonBlank(check.description)
    && optional(check.about, nonBlank)
    && optional(check.kind, (kind) => MISSION_V2_CHECK_KINDS.includes(kind))
    && optional(check.how, nonBlank)
}

function validArtifact(artifact) {
  return hasOnlyKeys(artifact, ['id', 'where'], ['description', 'identity'])
    && typeof artifact.id === 'string' && ARTIFACT_ID.test(artifact.id)
    && nonBlank(artifact.where)
    && optional(artifact.description, nonBlank)
    && optional(artifact.identity, nonBlank)
}

function checkArtifactReferences(check) {
  const refs = new Set(check.about ? [check.about] : [])
  for (const match of (check.how ?? '').matchAll(ARTIFACT_REFERENCE)) refs.add(match[1])
  return refs
}

function parseChecks(text) {
  let doc
  try { doc = JSON.parse(text) } catch { reject('invalid_checks') }
  if (!hasOnlyKeys(doc, ['checks'], ['artifacts'])) reject('invalid_checks')
  const { checks, artifacts } = doc
  if (!Array.isArray(checks) || checks.length === 0 || !checks.every(validCheck)) reject('invalid_checks')
  if (artifacts !== undefined && (!Array.isArray(artifacts) || !artifacts.every(validArtifact))) reject('invalid_checks')
  const checkIds = new Set(checks.map((check) => check.id))
  if (checkIds.size !== checks.length) reject('invalid_checks')
  const artifactList = artifacts ?? []
  const artifactIds = new Set(artifactList.map((artifact) => artifact.id))
  if (artifactIds.size !== artifactList.length) reject('invalid_checks')
  for (const check of checks) {
    const artifactAware = artifacts !== undefined || check.about || check.how || check.kind
    if (artifactAware && (!check.about || !check.how || !check.kind)) reject('invalid_checks')
    for (const ref of checkArtifactReferences(check)) if (!artifactIds.has(ref)) reject('invalid_checks')
  }
  return { checks, artifacts: artifactList }
}

function validEvidence(item) {
  if (!isPlainObject(item)) return false
  if (item.kind === 'text') return hasOnlyKeys(item, ['kind', 'text']) && nonEmpty(item.text)
  if (item.kind === 'file') return hasOnlyKeys(item, ['kind', 'path'], ['label']) && nonEmpty(item.path) && optional(item.label, nonEmpty)
  return false
}

function validEvaluation(evaluation) {
  if (!hasOnlyKeys(evaluation, ['checkId', 'outcome', 'summary'], ['evidence', 'artifactIdentities', 'checkDefinition'])) return false
  if (!nonEmpty(evaluation.checkId) || !MISSION_V2_OUTCOMES.includes(evaluation.outcome) || !nonEmpty(evaluation.summary)) return false
  if (evaluation.evidence !== undefined && (!Array.isArray(evaluation.evidence) || !evaluation.evidence.every(validEvidence))) return false
  const identities = evaluation.artifactIdentities
  if (identities !== undefined) {
    if (!isPlainObject(identities)) return false
    for (const [key, value] of Object.entries(identities)) if (!nonEmpty(key) || !nonBlank(value)) return false
  }
  return optional(evaluation.checkDefinition, validCheck)
}

function parseEvent(value, expectedNumber) {
  if (!isPlainObject(value)) reject('invalid_event')
  if (!MISSION_V2_EVENT_TYPES.includes(value.type)) reject('unknown_event_type')
  if (!hasOnlyKeys(value, ['type', 'data', 'eventNumber', 'recordedAt'])) reject('invalid_event')
  if (!Number.isSafeInteger(value.eventNumber) || value.eventNumber < 1) reject('invalid_event')
  if (!isMissionV2Datetime(value.recordedAt)) reject('invalid_event')
  const { data } = value
  if (!hasOnlyKeys(data, ['evaluations']) || !Array.isArray(data.evaluations) || data.evaluations.length === 0) reject('invalid_event')
  if (!data.evaluations.every(validEvaluation)) reject('invalid_event')
  if (value.eventNumber !== expectedNumber) reject('event_sequence_invalid')
  return value
}

// Mirrors droid's reader, including its tolerance of a torn final line (a
// write in progress): droid's snapshot excludes it, so the reader does too.
function parseEvents(bytes, maxEvents) {
  if (bytes.length === 0) return []
  const lines = bytes.toString('utf8').split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length > maxEvents) reject('too_many_events')
  const events = []
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(line) > MISSION_V2_MAX_EVENT_LINE_BYTES) reject('event_too_large')
    let value
    try {
      value = JSON.parse(line)
    } catch {
      if (index === lines.length - 1 && bytes.at(-1) !== NEWLINE) break
      reject('invalid_event_json')
    }
    events.push(parseEvent(value, index + 1))
  }
  return events
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function decodeUtf8(bytes) {
  try { return decoder.decode(bytes) } catch { reject('invalid_utf8') }
}

const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino

async function lstatOrNull(path) {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    reject('read_failed')
  }
}

async function inspectDirectory(path, missingReason) {
  const stat = await lstatOrNull(path)
  if (!stat) reject(missingReason)
  if (stat.isSymbolicLink()) reject('symlink_refused')
  if (!stat.isDirectory()) reject('not_directory')
  return stat
}

async function readBounded(dir, name, maxBytes) {
  const path = join(dir, name)
  if (relative(dir, path) !== name) reject('path_escape')
  const before = await lstatOrNull(path)
  if (!before) reject('missing_file')
  if (before.isSymbolicLink()) reject('symlink_refused')
  if (!before.isFile()) reject('not_regular_file')
  if (before.size > BigInt(maxBytes)) reject('file_too_large')
  let handle
  try {
    handle = await open(path, OPEN_FLAGS)
  } catch (error) {
    if (error?.code === 'ELOOP') reject('symlink_refused')
    if (error?.code === 'ENOENT') reject('missing_file')
    reject('read_failed')
  }
  try {
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile() || !sameIdentity(stat, before)) reject('file_changed')
    if (stat.size > BigInt(maxBytes)) reject('file_too_large')
    const buffer = Buffer.alloc(Math.min(Number(stat.size), maxBytes) + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > maxBytes) reject('file_too_large')
    if (BigInt(length) !== stat.size) reject('file_changed')
    return buffer.subarray(0, length)
  } catch (error) {
    if (error instanceof RecordFailure) throw error
    reject('read_failed')
  } finally {
    await handle.close().catch(() => {})
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const positiveInt = (value) => Number.isSafeInteger(value) && value > 0

export function createMissionV2RecordReader({ factoryDir, localMachineId, maxFileBytes = 8_388_608, maxEvents = 4096 } = {}) {
  if (typeof factoryDir !== 'string' || !isAbsolute(factoryDir)) throw new TypeError('factoryDir must be an absolute path')
  // The record is evidence only for a daemon on this machine; read() refuses
  // any other claimed machineId before touching the filesystem.
  if (typeof localMachineId !== 'string' || !localMachineId) throw new TypeError('localMachineId must be a non-empty string')
  // 8 MiB per file: events.jsonl grows by one bounded (256 KiB) line per check
  // evaluation and can reach ~1 MiB within the default 4096-event cap on real
  // runs; 8 MiB covers that comfortably while staying bounded.
  if (!positiveInt(maxFileBytes)) throw new TypeError('maxFileBytes must be a positive integer')
  if (!positiveInt(maxEvents)) throw new TypeError('maxEvents must be a positive integer')
  const rootDir = join(factoryDir, 'missionsV2')

  async function verify(sessionId, snapshot) {
    if (!MISSION_V2_SESSION_ID.test(sessionId)) reject('invalid_session_id')
    if (!validSnapshot(snapshot)) reject('invalid_snapshot')
    if (snapshot.sessionId !== sessionId) reject('session_mismatch')
    const dir = join(rootDir, sessionId)
    if (relative(rootDir, dir) !== sessionId) reject('path_escape')

    await inspectDirectory(rootDir, 'missing_record')
    const dirStat = await inspectDirectory(dir, 'missing_record')

    const missionBytes = await readBounded(dir, 'mission.md', maxFileBytes)
    const checksBytes = await readBounded(dir, 'checks.json', maxFileBytes)
    const eventBytes = await readBounded(dir, 'events.jsonl', maxFileBytes)

    const after = await lstatOrNull(dir)
    if (!after || after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(after, dirStat)) reject('record_changed')

    const missionText = decodeUtf8(missionBytes)
    if (missionText.trim().length === 0) reject('empty_plan')
    const planHash = sha256(missionBytes)
    if (planHash !== snapshot.planHash) reject('plan_hash_mismatch')

    const checksText = decodeUtf8(checksBytes)
    const checksHash = sha256(checksBytes)
    if (checksHash !== snapshot.checksHash) reject('checks_hash_mismatch')
    const { checks, artifacts } = parseChecks(checksText)

    decodeUtf8(eventBytes)
    const events = parseEvents(eventBytes, maxEvents)
    const checkIds = new Set(checks.map((check) => check.id))
    const latest = new Map()
    for (const event of events) {
      for (const evaluation of event.data.evaluations) {
        if (!checkIds.has(evaluation.checkId)) reject('unknown_check_id')
        latest.set(evaluation.checkId, {
          outcome: evaluation.outcome,
          summary: evaluation.summary,
          eventNumber: event.eventNumber,
          recordedAt: event.recordedAt,
        })
      }
    }
    const latestEventNumber = events.length
    if (latestEventNumber !== snapshot.latestEventNumber) reject('record_snapshot_mismatch')

    const counts = { total: checks.length, met: 0, unmet: 0, waived: 0 }
    for (const { outcome } of latest.values()) counts[outcome] += 1
    const expected = snapshot.checkCounts
    if (counts.total !== expected.total || counts.met !== expected.met
      || counts.unmet !== expected.unmet || counts.waived !== expected.waived) reject('check_counts_mismatch')

    return deepFreeze({
      verified: true,
      sessionId,
      title: snapshot.title,
      approvedAt: snapshot.approvedAt,
      planHash,
      checksHash,
      checks,
      artifacts,
      evaluations: Object.fromEntries(latest),
      counts,
      latestEventNumber,
      events: events.map((event) => ({
        eventNumber: event.eventNumber,
        recordedAt: event.recordedAt,
        type: event.type,
        checkIds: event.data.evaluations.map((evaluation) => evaluation.checkId),
      })),
    })
  }

  return Object.freeze({
    async read({ machineId, sessionId, snapshot } = {}) {
      if (typeof machineId !== 'string') throw new TypeError('machineId must be a string')
      if (typeof sessionId !== 'string') throw new TypeError('sessionId must be a string')
      if (snapshot === null || typeof snapshot !== 'object') throw new TypeError('snapshot must be an object')
      if (machineId !== localMachineId) return Object.freeze({ verified: false, reason: 'machine_mismatch' })
      try {
        return await verify(sessionId, snapshot)
      } catch (error) {
        if (error instanceof RecordFailure) return Object.freeze({ verified: false, reason: error.reason })
        return Object.freeze({ verified: false, reason: 'read_failed' })
      }
    },
  })
}
