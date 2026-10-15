/**
 * Coverage receipts (spec §16 acknowledgement and consistency).
 *
 * The ledger has two parts, exactly as the spec prescribes:
 *  - a contiguous acknowledged watermark (`acknowledgedSeq`): every journal
 *    event at or below it was covered by an acknowledged briefing;
 *  - sparse acknowledgements (`acknowledgedEvents`): eventId -> ack time,
 *    for events covered beyond the watermark by a mission-scoped briefing.
 *
 * The invariant that makes "no skipped unseen outcomes, no replay" both true:
 * the watermark only advances over events the ledger can PROVE were covered.
 * A global cursor never passes an omitted unseen event; a covered event beyond
 * the watermark is held by the sparse set so the next briefing does not
 * repeat it either.
 *
 * Delivery is not acknowledgement. getBriefing records per-surface delivery
 * attempts (kept separately, bounded); only acknowledgeBriefing() moves this
 * ledger, and an acknowledged briefing never answers a decision, approves a
 * deployment, or accepts a milestone (those are distinct commands, §16).
 */
import type { BriefingRecord, BriefingScope, DomainEvent, SpriiteState } from '../domain/types'

/** The durable coverage ledger, read off the state. */
export interface Coverage {
  acknowledgedSeq: number
  acknowledgedEvents: Record<string, string>
}

export function coverageOf(state: SpriiteState): Coverage {
  return {
    acknowledgedSeq: state.acknowledgedSeq,
    acknowledgedEvents: state.acknowledgedEvents ?? {},
  }
}

/**
 * Events a future briefing must still account for: above the watermark, and
 * not individually acknowledged. Scope narrows to one mission's events.
 */
export function unseenEvents(
  events: readonly DomainEvent[],
  coverage: Coverage,
  scope: BriefingScope,
): DomainEvent[] {
  return events.filter(
    (e) =>
      e.seq > coverage.acknowledgedSeq &&
      !(e.eventId in coverage.acknowledgedEvents) &&
      (scope.kind === 'owner' || e.missionId === scope.missionId),
  )
}

/**
 * The exact event ids an acknowledgement of this briefing covers.
 *  - owner scope: every event up to the fixed target was CONSIDERED by the
 *    briefing (meaningful or not — the owner dismissed the account of the
 *    whole range), so all of them are covered;
 *  - mission scope: only that mission's events in the range; other missions'
 *    events in the same range stay unseen.
 */
export function coveredIdsFor(
  briefing: BriefingRecord,
  events: readonly DomainEvent[],
): Set<string> {
  const covered = new Set<string>()
  for (const e of events) {
    if (e.seq > briefing.targetSeq) break
    if (briefing.scope.kind === 'owner' || e.missionId === briefing.scope.missionId) {
      covered.add(e.eventId)
    }
  }
  return covered
}

/**
 * Advance the contiguous watermark: walk events by seq, one at a time, and
 * stop at the FIRST event the acknowledgement does not cover — or at the
 * first GAP (an event the window no longer holds): a cursor never passes an
 * omitted unseen event it cannot see, whichever comes first (§16). Journal
 * seqs are contiguous 1..n, so a discontinuity is a compaction gap.
 */
export function advanceWatermark(
  events: readonly DomainEvent[],
  covered: Set<string>,
  from: number,
): number {
  let watermark = from
  for (const e of events) {
    if (e.seq <= watermark) continue
    if (e.seq !== watermark + 1) break
    if (!covered.has(e.eventId)) break
    watermark = e.seq
  }
  return watermark
}

/** The result of applying one acknowledgement. */
export interface AcknowledgementOutcome {
  /** The new contiguous watermark. */
  acknowledgedSeq: number
  /** The sparse set, pruned to events above the watermark. */
  acknowledgedEvents: Record<string, string>
  /** How many event ids this acknowledgement covered. */
  coveredCount: number
}

/** Pure application of an acknowledgement; the caller commits this. */
export function applyAcknowledgement(
  briefing: BriefingRecord,
  events: readonly DomainEvent[],
  coverage: Coverage,
  ackedAt: string,
): AcknowledgementOutcome {
  const covered = coveredIdsFor(briefing, events)
  // The record's OWN declared ids are proven too. The surface echoed exactly
  // them (coversMatch validated it), and a briefing may legitimately declare
  // an id outside its scope — the runtime-absence line names an owner-wide
  // recovery event inside a mission-scoped brief. Without this, that echo
  // would be accepted and then settle nothing, so the line would repeat on
  // every reconnect forever. Seeding cannot let an UNSEEN event through: the
  // echo was already validated against the pending record (§16/§20).
  for (const id of briefing.coveredEventIds) covered.add(id)
  // The walk treats THIS ack's covered ids AND the prior sparse set as
  // proven: an event acknowledged by an earlier mission brief must never
  // stop a later owner ack from advancing over it.
  const proven = new Set(covered)
  for (const id of Object.keys(coverage.acknowledgedEvents)) proven.add(id)
  // A named compaction gap is unseeable history, not unseen history: the
  // briefing told the owner it happened and they acknowledged the account,
  // so those seqs are settled. Without this the watermark could never pass
  // the gap and the gap card would repeat forever (§9/§16).
  let from = coverage.acknowledgedSeq
  if (briefing.gapBeforeSeq !== undefined) from = Math.max(from, briefing.gapBeforeSeq)
  const watermark = advanceWatermark(events, proven, from)
  // Start from the FULL prior sparse set: an earlier mission-scoped ack must
  // survive a later one, or its events would replay (no replay, §16).
  const sparse: Record<string, string> = { ...coverage.acknowledgedEvents }
  for (const id of covered) sparse[id] = coverage.acknowledgedEvents[id] ?? ackedAt
  // Prune: below the watermark the sparse entries are redundant; entries whose
  // event left the window cannot repeat and are dropped.
  const pruned: Record<string, string> = {}
  for (const e of events) {
    const at = sparse[e.eventId]
    if (at !== undefined && e.seq > watermark) pruned[e.eventId] = at
  }
  return { acknowledgedSeq: watermark, acknowledgedEvents: pruned, coveredCount: covered.size }
}

/**
 * Is this event id acknowledged — below the watermark, or sparsely? Used to
 * sweep pending briefings superseded by an acknowledgement on another
 * surface (cross-surface acknowledgement, §16).
 */
export function isAcknowledged(
  eventId: string,
  events: readonly DomainEvent[],
  coverage: Coverage,
): boolean {
  if (eventId in coverage.acknowledgedEvents) return true
  const e = events.find((x) => x.eventId === eventId)
  return e !== undefined && e.seq <= coverage.acknowledgedSeq
}

/**
 * Validate an acknowledgement against the pending briefing: the client must
 * echo the exact covered ids it saw (a stale view cannot acknowledge
 * something else, spec §20). Sorted comparison; duplicates collapse.
 */
export function coversMatch(briefing: BriefingRecord, coveredEventIds: readonly string[]): boolean {
  const claimed = [...new Set(coveredEventIds)].sort()
  const actual = [...new Set(briefing.coveredEventIds)].sort()
  return claimed.length === actual.length && claimed.every((id, i) => id === actual[i])
}
