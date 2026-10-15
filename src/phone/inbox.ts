/**
 * Phone inbox projection (spec §17): the durable store projected into the
 * detailed control surface's data. The current app's phone feed is an
 * in-memory list capped at 30 entries that dies with the page (spec §3);
 * this projection replaces it with the durable truth: every row is derived
 * from committed state and the journal on demand, never cached as its own
 * authority.
 *
 * The projection is read-only. Surfaces render it; only the runtime mutates
 * the state behind it. Health rows are honest by construction: "not
 * checked" is distinct from "nothing new" (spec §11), and an unknown
 * dispatch or a failed freshness check is shown as exactly that, never as a
 * fabricated health score (§21).
 */
import type { DecisionRecord, DomainEvent, Mission, SpriiteState } from '../domain/types'
import { isTerminalPhase } from '../domain/types'
import { coverageOf, unseenEvents } from '../briefing/receipts'
import { isMeaningful } from '../briefing/meaning'

/** One mission row of the inbox: current state plus what the owner hasn't seen. */
export interface InboxMission {
  missionId: string
  title: string
  goal: string
  phase: Mission['phase']
  control: Mission['control']
  freshness: Mission['freshness']
  planRevision: number
  lastObservedAt: string | null
  updatedAt: string
  /** Live provider runs, most recent observation first. */
  runs: Array<{ runId: string; provider: 'factory' | 'cursor'; role: 'lead' | 'worker'; observedState: string; lastObservedAt: string | null }>
  /** The unresolved decision holding this mission, if any. */
  openDecision: { decisionId: string; question: string; revision: number } | null
  /** True when unseen journal events mention this mission. */
  unseenChanges: boolean
  /** The unseen, MEANINGFUL changes (event ids + types), newest first. */
  unseenEventIds: Array<{ eventId: string; type: string }>
}

/** Cross-mission health, exactly as observed (spec §17/§21). */
export interface InboxHealth {
  /** Store writes acknowledged by the KV; 'broken' means mutations failed. */
  durability: 'ok' | 'broken'
  /** Runtime epoch of the process that produced this projection. */
  epoch: number
  /** Dispatch records whose launch outcome is unknown; each blocks its mission. */
  unresolvedDispatches: string[]
  /** Missions whose last freshness check did not confirm provider state. */
  unconfirmedMissions: string[]
  /** X intake: last successful check, or null when never checked (§11 —
   *  "not checked" is its own state, never "no requests"). */
  intake: { lastCheckAt: string | null; source: 'x'; configured: boolean }
}

/** The full phone inbox view. */
export interface InboxView {
  /** Active missions first (updated most recently first), then terminal ones. */
  missions: InboxMission[]
  /** Every unresolved decision across missions, oldest first. */
  openDecisions: Array<{ decisionId: string; missionId: string | null; question: string; revision: number; openedAt: string }>
  /** Unacknowledged briefings waiting for an explicit owner action. */
  pendingBriefings: Array<{ briefingId: string; kind: string; createdAt: string; cardCount: number }>
  /** The coverage watermark (how far the owner has acknowledged). */
  acknowledgedSeq: number
  health: InboxHealth
}

/** How many unseen rows one mission row carries (the badge count is the
 *  meaningful total; this bounds the payload). */
const UNSEEN_ROW_LIMIT = 12

/**
 * Project the durable state into the phone inbox. `epoch` and `durability`
 * come from the runtime (they are process facts, not state fields).
 */
export function buildInbox(
  state: SpriiteState,
  events: readonly DomainEvent[],
  runtime: { epoch: number; durability: 'ok' | 'broken' },
): InboxView {
  const coverage = coverageOf(state)
  const ownerUnseen = unseenEvents(events, coverage, { kind: 'owner' })
  const unseenByMission = new Map<string, DomainEvent[]>()
  for (const e of ownerUnseen) {
    const id = e.missionId ?? ''
    const list = unseenByMission.get(id)
    if (list === undefined) unseenByMission.set(id, [e])
    else list.push(e)
  }
  const missions: InboxMission[] = state.missions.map((m) => {
    // Only meaningful events make a row "changed": a row that flags noise
    // teaches the owner to ignore the flag (§16/§17).
    const missionEvents = (unseenByMission.get(m.missionId) ?? []).filter(isMeaningful)
    const open = state.decisions.find((d) => d.missionId === m.missionId && d.answeredAt === null) ?? null
    const runs = m.activeRunIds
      .map((runId) => state.runs[runId])
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
      .map((r) => ({
        runId: r.runId,
        provider: r.provider,
        role: r.role,
        observedState: r.observedState,
        lastObservedAt: r.lastObservedAt,
      }))
    return {
      missionId: m.missionId,
      title: m.title,
      goal: m.goal,
      phase: m.phase,
      control: m.control,
      freshness: m.freshness,
      planRevision: m.planRevision,
      // Exactly what the runtime observed, never a journal timestamp
      // standing in for a provider check the mission never had (§5).
      lastObservedAt: m.lastObservedAt,
      updatedAt: m.updatedAt,
      runs,
      openDecision:
        open === null
          ? null
          : { decisionId: open.decisionId, question: open.question, revision: open.revision },
      unseenChanges: missionEvents.length > 0,
      unseenEventIds: missionEvents
        .sort((a, b) => b.seq - a.seq)
        .slice(0, UNSEEN_ROW_LIMIT)
        .map((e) => ({ eventId: e.eventId, type: e.type })),
    }
  })

  missions.sort((a, b) => {
    const aTerminal = isTerminalPhase(a.phase)
    const bTerminal = isTerminalPhase(b.phase)
    if (aTerminal !== bTerminal) return aTerminal ? 1 : -1
    return b.updatedAt.localeCompare(a.updatedAt)
  })

  const openDecisions = state.decisions
    .filter((d): d is DecisionRecord => d.answeredAt === null)
    .map((d) => ({
      decisionId: d.decisionId,
      missionId: d.missionId,
      question: d.question,
      revision: d.revision,
      openedAt: d.openedAt,
    }))
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt))

  const pendingBriefings = (state.briefings ?? []).map((b) => ({
    briefingId: b.briefingId,
    kind: b.kind,
    createdAt: b.createdAt,
    cardCount: b.cards.length,
  }))

  const unresolvedDispatches = state.outbox
    .filter((d) => d.state === 'unknown')
    .map((d) => `${d.missionId}:${d.provider}:${d.actionId}`)
  const unconfirmedMissions = state.missions
    .filter((m) => !isTerminalPhase(m.phase) && m.freshness !== 'current')
    .map((m) => m.missionId)

  return {
    missions,
    openDecisions,
    pendingBriefings,
    acknowledgedSeq: state.acknowledgedSeq,
    health: {
      durability: runtime.durability,
      epoch: runtime.epoch,
      unresolvedDispatches,
      unconfirmedMissions,
      // X intake health is the store's own fact: "configured" says a binding
      // exists, and the check time says what the binding last did — "never
      // checked" stays its own state, never "no requests" (spec §11). The
      // binding's credential never projects; health words only.
      intake: {
        lastCheckAt: state.xIntake?.lastCheckedAt ?? null,
        source: 'x',
        configured: state.xIntake?.binding != null,
      },
    },
  }
}
