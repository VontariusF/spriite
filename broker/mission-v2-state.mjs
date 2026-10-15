/**
 * Pure Factory Mission v2 projection. Notification-derived facts are never
 * completion authority by themselves; only a verified durable record that
 * agrees with the latest snapshot may complete a Mission or expose features.
 */
import { createHash } from 'node:crypto'
import { array, boundedJson, clone, feature, hash, id, int, one, str, time } from './validation.mjs'
import { MISSION_V2_OUTCOMES, requestPayload, validateMissionV2Checks } from './sdk-wire.mjs'

const FEATURE_STATUS = Object.freeze({ met: 'completed', waived: 'cancelled', unmet: 'unmet' })
// Broker progressLog bound (rows), and a byte budget that keeps the whole observation
// inside the broker's 256 KiB observation bound.
const PROGRESS_MAX_ROWS = 512
const PROGRESS_MAX_BYTES = 65536
const PROGRESS_TEXT_MAX = 4096
const SUMMARY_MAX = 4096
const REASON_MAX = 160

const invalid = reason => ({ verified: false, reason })
const trimmedChecks = checks => checks.map(check => Object.fromEntries(Object.entries(check)
  .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])))
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * Whether a persisted request still needs an answer. A correlated native
 * resolution closes it (AskUser tool termination included, even though that is
 * not proof of which answer was accepted), and so does a root tool_result for
 * every tool use of a root permission request.
 */
function requestOpen(record, row, toolResultIds) {
  const a = row.attention
  if (a.state === 'resolved' || record.resolutions.some(item => item.attentionId === a.attentionId)) return false
  return !(row.envelope.method === 'daemon.request_permission' && a.sessionId === record.rootSessionId &&
    a.toolUseIds.length > 0 && a.toolUseIds.every(toolUseId => toolResultIds.has(toolUseId)))
}

/** Facts persisted by the provider, shaped as deriveMissionV2State inputs (without a record). */
export function missionV2Inputs(record) {
  const m = record?.missionV2
  if (record?.dialect !== 'v2' || !m) return null
  const approved = m.approval && record.requests.find(row => row.attention.attentionId === m.approval.attentionId)
  const approvedDetails = approved ? requestPayload(approved).toolUses[0].details : null
  const toolResultIds = new Set((m.toolResults ?? []).map(row => row.toolUseId))
  const turn = m.lastTurn
  return {
    dialect: 'v2',
    openAttention: record.requests.some(row => requestOpen(record, row, toolResultIds)),
    planApproved: Boolean(approved),
    rootWorkingState: m.rootWorking?.state ?? null,
    // A completion is current only when no root activity or approval followed it.
    lastTurn: turn ? {
      reason: turn.reason, current: turn.seq > m.rootBusySeq && (!m.approval || turn.seq > m.approval.seq),
    } : null,
    workers: m.workers.map(row => ({
      sessionId: row.childSessionId, toolUseId: row.toolUseId, subagentType: row.subagentType,
      description: row.description, startedAt: row.startedAt, finishedAt: row.finishedAt,
      failed: row.failed, finished: row.finishedAt !== null,
    })),
    snapshot: m.snapshot ? clone(m.snapshot.envelope.params.notification.snapshot) : null,
    approvedChecks: approvedDetails ? clone(approvedDetails.checks) : null,
    // droid writes the approved missionPlan to mission.md; planHash = sha256(mission.md).
    approvedPlanHash: approvedDetails ? sha256(approvedDetails.missionPlan) : null,
  }
}

export function missionV2WorkerSessionIds(inputs) {
  return (inputs?.workers ?? []).filter(row => row.subagentType === 'worker').map(row => row.sessionId)
}

/** Bounded, plain-data form of an injected reader result. Never throws. */
export function normalizeMissionV2Record(result) {
  if (!result || typeof result !== 'object') return invalid('mission_record_invalid')
  if (result.verified !== true) {
    return invalid(typeof result.reason === 'string' && result.reason && result.reason.length <= REASON_MAX
      ? result.reason : 'mission_record_unverified')
  }
  try {
    validateMissionV2Checks(result.checks); int(result.latestEventNumber)
    const source = result.evaluations instanceof Map ? [...result.evaluations.entries()]
      : result.evaluations && Object.getPrototypeOf(result.evaluations) === Object.prototype
        ? Object.entries(result.evaluations) : null
    if (!source || source.length > 512) return invalid('mission_record_invalid')
    const evaluations = {}
    for (const [checkId, row] of source) {
      str(checkId, 256)
      if (Object.hasOwn(evaluations, checkId) || !row || typeof row !== 'object') return invalid('mission_record_invalid')
      one(row.outcome, MISSION_V2_OUTCOMES); int(row.eventNumber, 1); time(row.recordedAt)
      if (typeof row.summary !== 'string') return invalid('mission_record_invalid')
      // A long evaluation summary is display text only: keep a marked prefix, never invalidate the record.
      const summaryTruncated = row.summary.length > SUMMARY_MAX
      const summary = summaryTruncated ? row.summary.slice(0, SUMMARY_MAX) : row.summary
      str(summary, SUMMARY_MAX, true)
      evaluations[checkId] = {
        outcome: row.outcome, summary, eventNumber: row.eventNumber, recordedAt: row.recordedAt,
        ...(summaryTruncated ? { summaryTruncated: true } : {}),
      }
    }
    const value = { verified: true, checks: clone(result.checks), evaluations, latestEventNumber: result.latestEventNumber }
    boundedJson(value, 4194304)
    return value
  } catch { return invalid('mission_record_invalid') }
}

/**
 * Agreement between the approved plan, the latest snapshot and a normalized
 * verified record. `complete` requires every check met or waived.
 */
export function checkMissionV2Record({ snapshot, approvedChecks, approvedPlanHash, verifiedRecord }) {
  if (!verifiedRecord || verifiedRecord.verified !== true) return { ok: false, complete: false, reason: verifiedRecord?.reason ?? 'mission_record_unavailable' }
  if (!snapshot) return { ok: false, complete: false, reason: 'mission_snapshot_unavailable' }
  if (!Array.isArray(approvedChecks) || !approvedChecks.length) return { ok: false, complete: false, reason: 'approved_plan_unavailable' }
  // The verified record proves sha256(mission.md) === snapshot.planHash; this binds it to the owner-approved plan.
  if (typeof approvedPlanHash !== 'string') return { ok: false, complete: false, reason: 'approved_plan_unavailable' }
  if (approvedPlanHash !== snapshot.planHash) return { ok: false, complete: false, reason: 'approved_plan_hash_mismatch' }
  if (hash(trimmedChecks(verifiedRecord.checks)) !== hash(trimmedChecks(approvedChecks))) {
    return { ok: false, complete: false, reason: 'approved_checks_mismatch' }
  }
  if (verifiedRecord.latestEventNumber !== snapshot.latestEventNumber) return { ok: false, complete: false, reason: 'event_number_mismatch' }
  const ids = new Set(approvedChecks.map(check => check.id))
  const counts = { total: approvedChecks.length, met: 0, unmet: 0, waived: 0 }
  for (const [checkId, row] of Object.entries(verifiedRecord.evaluations)) {
    if (!ids.has(checkId)) return { ok: false, complete: false, reason: 'unknown_check_evaluation' }
    if (row.eventNumber > snapshot.latestEventNumber) return { ok: false, complete: false, reason: 'future_check_evaluation' }
    counts[row.outcome]++
  }
  if (hash(counts) !== hash(snapshot.checkCounts)) return { ok: false, complete: false, reason: 'check_counts_mismatch' }
  return { ok: true, complete: counts.met + counts.waived === counts.total, reason: null }
}

/**
 * Derived Mission state for a v2 job, or null for any other dialect.
 * inputs: { dialect, openAttention, planApproved, rootWorkingState, lastTurn: { reason, current } | null,
 *           workers: [{ finished }], snapshot, approvedChecks, verifiedRecord }
 */
export function deriveMissionV2State(inputs) {
  if (inputs?.dialect !== 'v2') return null
  const { openAttention, planApproved, rootWorkingState = null, lastTurn = null, workers = [] } = inputs
  const idle = rootWorkingState === 'idle'
  const turnDone = idle && lastTurn?.current === true
  // 'paused' is never derived: no observed turn reason (including 'cancelled', an
  // interrupted turn) proves that the Mission itself is paused.
  if (openAttention) return 'awaiting_input'
  if (!planApproved) return idle ? 'awaiting_input' : 'planning'
  if (!idle || workers.some(row => !row.finished)) return 'running'
  if (turnDone && lastTurn.reason === 'completed' && checkMissionV2Record(inputs).complete) return 'completed'
  return 'awaiting_input'
}

/** One feature per approved check, or null if any check is not representable. */
export function projectV2Features(approvedChecks, verifiedRecord) {
  try {
    array(approvedChecks, 512, () => {})
    const evaluations = verifiedRecord?.verified === true ? verifiedRecord.evaluations : {}
    const rows = approvedChecks.map(check => {
      const outcome = Object.hasOwn(evaluations, check.id) ? evaluations[check.id].outcome : null
      const row = {
        id: check.id, description: check.description, status: outcome ? FEATURE_STATUS[outcome] : 'pending',
        expectedBehavior: check.how === undefined ? [] : [check.how], milestone: check.group,
      }
      feature(row)
      return row
    })
    if (new Set(rows.map(row => row.id)).size !== rows.length) return null
    return rows
  } catch { return null }
}

const bounded = text => typeof text === 'string' && text.length <= PROGRESS_TEXT_MAX ? { text, omitted: false } : { text: null, omitted: true }

/**
 * Bounded JSON progress rows (worker start/finish and latest check evaluations).
 * Over the row or byte budget, the latest rows are kept behind one explicit
 * `progress_omitted` row with the omitted count. Null only for a malformed row.
 */
export function projectV2Progress({ workers = [], verifiedRecord = null } = {}) {
  const rows = []
  for (const worker of workers) {
    const description = bounded(worker.description ?? '')
    rows.push({
      type: 'worker_started', timestamp: worker.startedAt, workerSessionId: worker.sessionId, toolUseId: worker.toolUseId,
      subagentType: worker.subagentType ?? null, description: description.text, descriptionOmitted: description.omitted,
    })
    if (worker.finishedAt) rows.push({
      type: 'worker_finished', timestamp: worker.finishedAt, workerSessionId: worker.sessionId,
      toolUseId: worker.toolUseId, failed: worker.failed === true,
    })
  }
  if (verifiedRecord?.verified === true) {
    for (const [checkId, row] of Object.entries(verifiedRecord.evaluations)) {
      const summary = bounded(row.summary)
      rows.push({
        type: 'check_evaluated', timestamp: row.recordedAt, checkId, outcome: row.outcome,
        eventNumber: row.eventNumber, summary: summary.text, summaryOmitted: summary.omitted,
        ...(row.summaryTruncated ? { summaryTruncated: true } : {}),
      })
    }
  }
  rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.type.localeCompare(b.type))
  const sizes = []
  try { for (const row of rows) sizes.push(Buffer.byteLength(boundedJson(row, 16384))) } catch { return null }
  return keepLatestProgress(rows, sizes)
}

/** Sorted rows within the row and byte budget, or the newest rows behind one omission marker. */
function keepLatestProgress(rows, sizes) {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (rows.length <= PROGRESS_MAX_ROWS && total <= PROGRESS_MAX_BYTES) return rows
  // Reserve one row and its bytes for the omission marker, then keep the newest rows.
  let kept = 0, bytes = 256
  for (let i = rows.length - 1; i >= 0 && kept < PROGRESS_MAX_ROWS - 1 && bytes + sizes[i] <= PROGRESS_MAX_BYTES; i--) {
    kept++; bytes += sizes[i]
  }
  const omitted = rows.length - kept, tail = rows.slice(omitted)
  return [{ type: 'progress_omitted', timestamp: rows[omitted - 1].timestamp, omittedCount: omitted }, ...tail]
}

// ---- legacy Mission ('v1' dialect) ----
// v1 notifications are display facts only; these projections never derive state.

// Leaves room for history, progress and session ids inside the broker's 256 KiB bound.
const V1_FEATURES_MAX_BYTES = 98304

/**
 * Broker features from the latest root mission_features_changed list. Null (no
 * claim) when the list is malformed, has duplicate ids, or exceeds the row or
 * byte budget: a clipped feature list would misstate what remains.
 */
export function projectV1Features(list) {
  try {
    const rows = list.map(row => {
      const out = { id: row.id, description: row.description, status: row.status, expectedBehavior: clone(row.expectedBehavior),
        ...(row.milestone === undefined ? {} : { milestone: row.milestone }) }
      feature(out)
      return out
    })
    if (rows.length > PROGRESS_MAX_ROWS || new Set(rows.map(row => row.id)).size !== rows.length) return null
    boundedJson(rows, V1_FEATURES_MAX_BYTES)
    return rows
  } catch { return null }
}

/** The latest root mission_progress_entry log inside the progress budget. Null only for a malformed row. */
export function projectV1Progress(log) {
  if (!Array.isArray(log)) return null
  const rows = clone(log), sizes = []
  try { for (const row of rows) sizes.push(Buffer.byteLength(boundedJson(row, 16384))) } catch { return null }
  return keepLatestProgress(rows, sizes)
}

// ---- droid >= 0.238 Missions 2.0 agents ('v2-agents' dialect) ----
// No plan approval, no snapshot and no durable record: state is derived from root
// lifecycle facts and the root's own SpawnAgent/ListAgents tool results only.

/** Default quiet period after a completed orchestrator turn before 'completed' may be derived. */
export const MISSION_V2_AGENTS_SETTLE_MS = 90000
/** Reason reported in read diagnostics instead of a record agreement result. */
export const MISSION_V2_AGENTS_NO_RECORD = 'mission_v2_agents_no_durable_record'
/** Bound on tracked agents, so features plus session ids stay inside the broker observation bounds. */
export const MISSION_V2_AGENTS_MAX = 200
const AGENT_TITLE_MAX = 512
const AGENT_RESULT_MAX = 262144
const AGENT_STATUS_FEATURE = Object.freeze({ running: 'in_progress', pending: 'pending', idle: 'completed' })

const isAgentId = value => { try { id(value); return true } catch { return false } }
const boundedTitle = value => typeof value === 'string' && value.trim()
  ? value.trim().slice(0, AGENT_TITLE_MAX) : null
/** Text of a tool_result content field (string or text blocks), or null. */
function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const texts = content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text)
  return texts.length ? texts.join('') : null
}
function resultJson(content) {
  const text = resultText(content)
  if (text === null || text.length > AGENT_RESULT_MAX) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch { return null }
}
const agentStatus = value => value === null || value === undefined ? null
  : ['idle', 'pending', 'running'].includes(value) ? value : 'unknown'
const agentWaitingOn = value => value === null || value === undefined ? null
  : typeof value === 'string' && value.length <= 128 && value.trim() ? value : 'unknown'

/**
 * Parse a root SpawnAgent / ListAgents tool result. Malformed or unexpected
 * results are ignored (null), never a fault: they are display/progress facts.
 * SpawnAgent → { kind: 'spawned', sessionId }; ListAgents → { kind: 'listed', agents }.
 */
export function parseMissionV2AgentResult(name, content) {
  const value = resultJson(content)
  if (!value) return null
  if (name === 'SpawnAgent') return isAgentId(value.sessionId) ? { kind: 'spawned', sessionId: value.sessionId } : null
  if (name === 'ListAgents') {
    if (!Array.isArray(value.agents) || value.agents.length > 1024) return null
    const agents = []
    for (const row of value.agents) {
      if (!row || typeof row !== 'object' || !isAgentId(row.sessionId)) continue
      if (agents.some(item => item.sessionId === row.sessionId)) continue
      agents.push({ sessionId: row.sessionId, title: boundedTitle(row.title), status: agentStatus(row.status), waitingOn: agentWaitingOn(row.waitingOn) })
    }
    return { kind: 'listed', agents }
  }
  return null
}

/**
 * Facts persisted by the provider, shaped as deriveMissionV2AgentsState inputs.
 * `live` is true only for a connected, unfenced provider that can see new root
 * activity; a 'completed' state is never newly derived otherwise.
 */
export function missionV2AgentsInputs(record, { nowMs = Date.now(), settleMs = MISSION_V2_AGENTS_SETTLE_MS, live = false } = {}) {
  const m = record?.missionV2Agents
  if (record?.dialect !== 'v2-agents' || !m) return null
  const toolResultIds = new Set((m.toolResults ?? []).map(row => row.toolUseId))
  const turn = m.lastTurn
  const idleAt = m.rootWorking?.state === 'idle' ? Date.parse(m.rootWorking.observedAt) : 0
  const settleFrom = turn ? Math.max(Date.parse(turn.observedAt), idleAt) : null
  return {
    dialect: 'v2-agents',
    openAttention: record.requests.some(row => requestOpen(record, row, toolResultIds)),
    rootWorkingState: m.rootWorking?.state ?? null,
    lastTurn: turn ? { reason: turn.reason, current: turn.seq > m.rootBusySeq, observedAt: turn.observedAt } : null,
    settled: settleFrom !== null && Number.isFinite(settleMs) && nowMs - settleFrom >= settleMs,
    agents: m.agents.map(row => clone(row)),
    agentsOverflow: m.agentsOverflow === true,
    completed: m.completed ? clone(m.completed) : null,
    faulted: Boolean(record.ingestionFault),
    live: live === true,
  }
}

/**
 * Every known agent finished (idle, waiting on nothing). An orchestrator that
 * spawned no agent did the work itself: its settled completed turn is enough.
 */
export const missionV2AgentsSettled = agents =>
  agents.every(row => row.status === 'idle' && row.waitingOn === null)

/**
 * Derived Mission state for a v2-agents job, or null for any other dialect.
 * A latched completion is terminal (late root activity is progress only).
 * Otherwise: open attention → awaiting_input; root not idle → running; a current
 * completed orchestrator turn, settled for the window, with at least one known
 * agent and every known agent idle and waiting on nothing → completed (live only);
 * anything else → awaiting_input. 'paused' and 'planning' are never derived.
 */
export function deriveMissionV2AgentsState(inputs) {
  if (inputs?.dialect !== 'v2-agents') return null
  if (inputs.completed) return 'completed'
  const { openAttention, rootWorkingState = null, lastTurn = null, agents = [] } = inputs
  if (openAttention) return 'awaiting_input'
  if (rootWorkingState !== 'idle') return 'running'
  if (inputs.live === true && !inputs.faulted && lastTurn?.current === true && lastTurn.reason === 'completed' &&
      inputs.settled === true && !inputs.agentsOverflow && missionV2AgentsSettled(agents)) return 'completed'
  return 'awaiting_input'
}

/** One feature per known agent, or null if any is not representable. */
export function projectV2AgentFeatures(agents) {
  try {
    array(agents, MISSION_V2_AGENTS_MAX, () => {})
    const rows = agents.map(agent => {
      const row = {
        id: agent.sessionId, description: agent.title ?? `Agent ${agent.sessionId.slice(0, 8)}`,
        status: AGENT_STATUS_FEATURE[agent.status] ?? 'pending', expectedBehavior: [],
      }
      if (agent.status === 'idle' && agent.waitingOn !== null) row.status = 'in_progress'
      feature(row)
      return row
    })
    if (new Set(rows.map(row => row.id)).size !== rows.length) return null
    return rows
  } catch { return null }
}

/**
 * Bounded progress rows for agents, the latest orchestrator turn, completion and late activity.
 * Over the row or byte budget, the latest rows are kept behind one explicit
 * `progress_omitted` row with the omitted count. Null only for a malformed row.
 */
export function projectV2AgentProgress(inputs) {
  if (!inputs) return null
  const rows = []
  for (const agent of inputs.agents) {
    rows.push({ type: 'agent_spawned', timestamp: agent.firstSeenAt, agentSessionId: agent.sessionId,
      title: agent.title, source: agent.source })
    if (agent.listedAt) rows.push({ type: 'agent_status', timestamp: agent.listedAt, agentSessionId: agent.sessionId,
      status: agent.status, waitingOn: agent.waitingOn })
  }
  if (inputs.lastTurn) rows.push({ type: 'orchestrator_turn_completed', timestamp: inputs.lastTurn.observedAt, reason: inputs.lastTurn.reason })
  if (inputs.completed) {
    rows.push({ type: 'mission_completed', timestamp: inputs.completed.observedAt })
    if (inputs.completed.lateActivity > 0) rows.push({
      type: 'activity_after_completion', timestamp: inputs.completed.lastLateActivityAt, count: inputs.completed.lateActivity,
    })
  }
  rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.type.localeCompare(b.type))
  const sizes = []
  try { for (const row of rows) sizes.push(Buffer.byteLength(boundedJson(row, 16384))) } catch { return null }
  return keepLatestProgress(rows, sizes)
}
