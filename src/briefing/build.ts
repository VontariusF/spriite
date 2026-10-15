/**
 * Return briefing builder (spec §16).
 *
 * A briefing is a compact account of MEANINGFUL changes since the owner last
 * acknowledged them, enriched with current status. It is not a playback
 * queue: intermediate transitions and repeated retries collapse into one
 * outcome per mission, ranked so a surface showing three cards shows the
 * right three.
 *
 * Honesty rules baked into the copy:
 *  - freshness is never claimed: a card says when the work was last
 *    OBSERVED and labels last-known state when the last check failed
 *    (§5, §25.23); "just now" is never inferred from a freshness flag;
 *  - unresolved decisions re-appear until answered, even if previously seen
 *    — they come from current state, not from the journal window;
 *  - a compaction gap (events the window no longer holds) is named, never
 *    silently skipped, even when it is the only news.
 *
 * 'return' briefings require explicit acknowledgement; 'status' and
 * 'absent' are honest one-liners that repeat until reality changes.
 */
import { mintId, nowIso } from '../domain/ids'
import type {
  BriefingCard,
  BriefingKind,
  BriefingRecord,
  BriefingScope,
  DecisionRecord,
  DomainEvent,
  Mission,
  SpriiteState,
} from '../domain/types'
import { isTerminalPhase } from '../domain/types'
import { isAbsence, meaningOf } from './meaning'
import { coverageOf, unseenEvents } from './receipts'
import { decodeNativeCache, decodeNativeIntent } from '../native/decode'
import type { NativeAttention } from '../native/protocol'
import { nativeProviderSummary, nativeArtifactsVerified } from '../native/presentation'
import { constrainNativeDelivery, deliveryDelivered, deliveryLine, displayDelivery, usageLine } from '../native/delivery'

/** The fixed journal target is the store's current head at build time. */
export interface BriefingInputs {
  state: SpriiteState
  /** The store's recent-event window (what the briefing can account for). */
  events: readonly DomainEvent[]
  /** The journal's current head seq (events above it were never considered). */
  journalSeq: number
  scope: BriefingScope
  /** Build time (ms), for "last checked N min ago" copy. */
  now?: number
}

/** The glasses show at most this many cards; the phone shows them all. */
export const GLASSES_CARD_LIMIT = 3

/**
 * Does this briefing have something to settle, or is it a repeatable
 * one-liner? A 'status' brief (nothing meaningful changed) carries no
 * covered events by construction and is rebuilt every time it is asked for.
 * 'return' and 'absent' both carry a fixed target the owner can
 * acknowledge, so both are committed before they are shown (§16: delivery is
 * not reading, and an unacknowledged account may have to reappear).
 *
 * A brief made only of unresolved decisions is deliberately in the
 * repeatable class: the decision card IS the briefing, and dismissing it
 * leaves the question pending (§16/§17). Answering the decision is the only
 * thing that settles it — an acknowledgement never answers a decision.
 */
export function requiresAcknowledgement(brief: BriefingRecord): boolean {
  return brief.kind !== 'status'
}

/** The cards a surface should render, in rank order (spec §16/§17). */
export function cardsForSurface(brief: BriefingRecord, surface: 'glasses' | 'phone'): BriefingCard[] {
  return surface === 'glasses' ? brief.cards.slice(0, GLASSES_CARD_LIMIT) : brief.cards.slice()
}

/** Phase verbs for current-work copy; every phase has one (§16 direct language). */
const PHASE_VERB: Record<Mission['phase'], string> = {
  received: 'starting',
  gathering_context: 'reading context for',
  planning: 'planning',
  ready: 'ready to build',
  building: 'building',
  reviewing: 'reviewing',
  repairing: 'fixing',
  integrating: 'integrating',
  awaiting_decision: 'waiting on your choice for',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** Blocks the owner can fix (accounts, keys). */
const OWNER_ACTIONABLE = new Set(['auth', 'billing', 'quota', 'permission', 'forbidden'])

const clip = (text: string, max: number): string => {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  let cut = clean.slice(0, max - 1)
  // Never leave half a surrogate pair before the ellipsis.
  const end = cut.charCodeAt(cut.length - 1)
  if (end >= 0xd800 && end <= 0xdbff) cut = cut.slice(0, -1)
  return `${cut.trimEnd()}…`
}

const article = (word: string): string => (/^[aeiou]/i.test(word) ? 'an' : 'a')

const isTerminal = (m: Mission): boolean => isTerminalPhase(m.phase)

/** "Last checked 5 min ago." from the real observation time, never a flag. */
function checkedAtCopy(lastObservedAt: string | null, now: number): string {
  const at = lastObservedAt === null ? Number.NaN : Date.parse(lastObservedAt)
  if (!Number.isFinite(at)) return 'Not checked yet.'
  const mins = Math.max(0, Math.floor((now - at) / 60000))
  if (mins < 1) return 'Last checked under a minute ago.'
  if (mins < 60) return `Last checked ${mins} min ago.`
  if (mins < 48 * 60) return `Last checked ${Math.floor(mins / 60)} h ago.`
  return `Last checked ${Math.floor(mins / 1440)} days ago.`
}

/** The check-time line plus the last-known label when the last check failed. */
function lastChecked(m: Pick<Mission, 'lastObservedAt' | 'freshness'>, now: number): string {
  const when = checkedAtCopy(m.lastObservedAt, now)
  const failed = m.freshness === 'unknown' || m.freshness === 'stale'
  return failed ? `${when} The last check failed; this is last-known.` : when
}

/** A mission's best evidence link: the PR the engine observed, if any. */
function evidenceUrlFor(state: SpriiteState, missionId: string): string | undefined {
  const raw = state.engineSnapshots?.[missionId]
  if (raw === null || raw === undefined || typeof raw !== 'object') return undefined
  const prUrl = (raw as { prUrl?: unknown }).prUrl
  return typeof prUrl === 'string' && prUrl !== '' ? prUrl : undefined
}

/** The engine's last word on the mission, for card detail copy. */
function engineNote(state: SpriiteState, missionId: string, field: 'finalSummary' | 'failReason'): string {
  const raw = state.engineSnapshots?.[missionId]
  if (raw === null || raw === undefined || typeof raw !== 'object') return ''
  const value = (raw as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : ''
}

/** A block that a later recovery event in the same window already resolved. */
function isStaleBlock(events: readonly DomainEvent[], e: DomainEvent): boolean {
  if (e.type !== 'provider_connectivity_changed') return false
  return events.some(
    (later) =>
      later.seq > e.seq &&
      later.type === 'provider_connectivity_changed' &&
      later.payload.kind === 'recovered' &&
      later.missionId === e.missionId,
  )
}

interface MissionOutcome {
  mission: Mission
  events: DomainEvent[]
  bestRank: 1 | 2 | 3 | 4
  repairs: number
  completed: boolean
  failed: boolean
  cancelledPartial: boolean
  cancelledSuperseded: boolean
  planRevised: number
  blocks: DomainEvent[]
}

function freshCard(mission: Mission): Pick<BriefingCard, 'freshness' | 'lastObservedAt'> {
  return { freshness: mission.freshness, lastObservedAt: mission.lastObservedAt }
}

function decisionCard(d: DecisionRecord, m: Mission | null, coveredEventIds: string[]): BriefingCard {
  const lastKnown = m !== null && (m.freshness === 'unknown' || m.freshness === 'stale')
  return {
    rank: 1,
    ...(m === null ? {} : { missionId: m.missionId }),
    headline: clip(`I need your choice: ${d.question}`, 96),
    detail: lastKnown ? 'Status is last-known; answering checks current state first.' : undefined,
    decisionId: d.decisionId,
    freshness: m?.freshness ?? 'current',
    lastObservedAt: m?.lastObservedAt ?? null,
    coveredEventIds,
  }
}

export function nativeBriefingRequestKey(missionId: string, a: NativeAttention): string {
  return JSON.stringify([missionId, a.attentionId, a.requestId, a.machineId, a.sessionId,
    a.revision, a.payloadHash, a.state])
}

function nativeDecisionCard(a: NativeAttention, m: Mission, coveredEventIds: string[]): BriefingCard {
  return {
    rank: 1, missionId: m.missionId, decisionId: a.attentionId,
    nativeRequestKey: nativeBriefingRequestKey(m.missionId, a),
    headline: clip(a.state === 'open'
      ? `Factory needs your ${a.kind === 'ask_user' ? 'answer' : a.kind === 'permission' ? 'permission' : 'approval'} for ${m.title}.`
      : `Factory request is still unresolved for ${m.title}.`, 96),
    detail: a.state === 'open' ? 'Check the full request and exact session on the phone.'
      : 'Waiting for matching Factory resolution; do not resend.',
    evidenceUrl: `https://app.factory.ai/sessions/${encodeURIComponent(a.sessionId)}`,
    ...freshCard(m), coveredEventIds,
  }
}

/** One collapsed card per mission: the outcome, not the transitions (§16). */
function missionCard(state: SpriiteState, outcome: MissionOutcome, openDecision: DecisionRecord | null): BriefingCard {
  const m = outcome.mission
  const title = clip(m.title, 48)
  const base = freshCard(m)
  const coveredEventIds = outcome.events.map((e) => e.eventId)
  const rank: BriefingCard['rank'] = outcome.bestRank
  const fixes = outcome.repairs > 0 ? `${outcome.repairs} fix${outcome.repairs === 1 ? '' : 'es'} along the way.` : ''

  const resolvedHeld = heldResolutionHeadline(m, title)
  if (resolvedHeld !== null) return { rank: 3, missionId: m.missionId, headline: clip(resolvedHeld, 96), ...base, coveredEventIds }
  // Lead with the decision: an unresolved question outranks every outcome.
  if (openDecision !== null) {
    return { ...decisionCard(openDecision, m, coveredEventIds), evidenceUrl: evidenceUrlFor(state, m.missionId) }
  }
  // Terminal STATE is news even when its journal event is missing from the
  // window (a v1-migrated faulted mission, or a compaction the owner has not
  // seen): the account states what is true now, not only what was journalled.
  if (outcome.failed || m.phase === 'failed') {
    const note = clip(engineNote(state, m.missionId, 'failReason'), 90)
    return {
      rank: 1,
      missionId: m.missionId,
      headline: clip(`${title} failed.`, 96),
      detail: note !== '' ? note : undefined,
      ...base,
      coveredEventIds,
    }
  }
  if (outcome.completed || m.phase === 'completed') {
    if (m.config.executionBackend === 'factory_native') {
      const cached = decodeNativeCache(state.engineSnapshots?.[m.missionId])?.snapshot
      const policy = decodeNativeIntent(m.config.nativeIntent)?.policy
      const snapshot = cached ? constrainNativeDelivery(cached, policy) : undefined
      const finalization = snapshot?.finalization
      const verified = finalization?.evidence.filter(e => e.verified) ?? []
      const complete = snapshot ? nativeArtifactsVerified(snapshot) : false
      // The briefing reads the persisted cache directly, so apply the frozen
      // policy again here: out-of-policy delivery is downgraded, never delivered.
      const delivery = snapshot ? displayDelivery(snapshot, policy) : undefined
      if (delivery) {
        const usage = snapshot?.usage ? ` ${usageLine(snapshot.usage)}.` : ''
        return {
          rank: 2, missionId: m.missionId,
          headline: clip(deliveryDelivered(delivery) ? `Factory completed ${title}; delivered, PR merged.`
            : `Factory completed ${title}; not delivered.`, 96),
          detail: clip(`${deliveryLine(delivery)}.${usage}`, 120),
          evidenceUrl: delivery.prUrl ?? verified[0]?.url, ...base, coveredEventIds,
        }
      }
      return {
        rank: 2, missionId: m.missionId,
        headline: clip(complete ? `Factory completed ${title}; artifact evidence verified.`
          : `Factory completed ${title}; artifact evidence ${finalization?.state === 'pending' ? 'pending' : 'incomplete'}.`, 96),
        detail: snapshot?.diagnostics?.includes('delivery_outside_policy')
          ? 'Delivery claim ignored: outside the frozen job policy. Work is not delivered.'
          : clip((finalization?.reason ?? nativeProviderSummary(finalization?.summary ?? '')) ||
            'No verified delivery claim is available.', 120),
        evidenceUrl: verified[0]?.url, ...base, coveredEventIds,
      }
    }
    const detail = clip(`${fixes} ${engineNote(state, m.missionId, 'finalSummary')}`, 120)
    return {
      // Rank 2 is the spec's "completed or accepted work" slot: a completed
      // mission is not an emergency, whatever else rode the same window.
      rank: 2,
      missionId: m.missionId,
      headline: clip(`${title} is ready.`, 96),
      detail: detail !== '' ? detail : undefined,
      evidenceUrl: evidenceUrlFor(state, m.missionId),
      ...base,
      coveredEventIds,
    }
  }
  if (outcome.cancelledPartial) {
    return {
      rank,
      missionId: m.missionId,
      headline: clip(`${title} was cancelled, but some remote work may still be running.`, 96),
      ...base,
      coveredEventIds,
    }
  }
  if (outcome.cancelledSuperseded) {
    return {
      rank,
      missionId: m.missionId,
      headline: clip(`${title} finished before the cancellation landed.`, 96),
      ...base,
      coveredEventIds,
    }
  }
  if (m.phase === 'cancelled') {
    return {
      rank: 2,
      missionId: m.missionId,
      headline: clip(`${title} was cancelled.`, 96),
      ...base,
      coveredEventIds,
    }
  }
  if (outcome.blocks.length > 0) {
    const latest = outcome.blocks[outcome.blocks.length - 1]
    const kind = String(latest.payload.kind ?? 'service')
    // Provider faults halt the mission until the owner acts: never claim an
    // automatic retry is underway.
    let headline: string
    if (OWNER_ACTIONABLE.has(kind)) headline = `${title} is blocked: ${kind}. Check your accounts.`
    else if (latest.payload.retryable === true) headline = `${title} stopped on ${article(kind)} ${kind} problem. It is waiting for your retry.`
    else headline = `${title} stopped on ${article(kind)} ${kind} problem. It needs your attention.`
    const lastKnown = m.freshness === 'unknown' || m.freshness === 'stale'
    return {
      rank,
      missionId: m.missionId,
      headline: clip(headline, 96),
      detail: lastKnown ? 'The last check failed; progress shown is last-known.' : undefined,
      ...base,
      coveredEventIds,
    }
  }
  if (outcome.repairs > 0 || outcome.planRevised > 0) {
    const bits: string[] = []
    if (outcome.repairs > 0) bits.push(`${outcome.repairs} fix${outcome.repairs === 1 ? '' : 'es'}`)
    if (outcome.planRevised > 0) bits.push(`plan revised (now r${m.planRevision})`)
    return {
      rank,
      missionId: m.missionId,
      headline: clip(`${title}: ${bits.join(', ')}. Now ${PHASE_VERB[m.phase]}.`, 96),
      ...base,
      coveredEventIds,
    }
  }
  // Decision-closed or migration-only outcomes: still say what happened.
  return {
    rank,
    missionId: m.missionId,
    headline: clip(`${title}: ${PHASE_VERB[m.phase]}.`, 96),
    ...base,
    coveredEventIds,
  }
}

/** Status copy for the focused mission when nothing new is unseen. */
/** A resolved held native intent never ran: it was neither cancelled work nor delivered. */
function heldResolutionHeadline(m: Mission, title: string): string | null {
  const r = m.config.nativeHeldResolution
  if (r?.outcome === 'promoted') return `${title}: approved as a new native job.`
  if (r?.outcome === 'dismissed') return `${title}: dismissed.`
  return null
}

function statusCard(m: Mission, now: number, hasOpenDecision: boolean): BriefingCard {
  const title = clip(m.title, 56)
  let headline: string
  const resolvedHeld = heldResolutionHeadline(m, title)
  if (resolvedHeld !== null) headline = `Nothing new. ${resolvedHeld}`
  else if (isTerminal(m)) headline = `Nothing new. ${title} is ${PHASE_VERB[m.phase]}.`
  else if (m.control === 'paused') headline = `Nothing new. ${title} is paused.`
  else if (m.control === 'pause_requested') headline = `Nothing new. Pausing ${title}.`
  else if (m.control === 'cancel_requested') headline = `Nothing new. Cancelling ${title}.`
  else if (m.phase === 'awaiting_decision' && !hasOpenDecision) {
    // The owner has answered; the engine has not cleared the gate yet. Never
    // ask for a choice the durable record says was already given (§16).
    headline = `Nothing new. Picking up ${title} after your choice.`
  } else headline = `Nothing new. Still ${PHASE_VERB[m.phase]} ${title}.`
  return {
    rank: 5,
    missionId: m.missionId,
    headline: clip(headline, 96),
    detail: lastChecked(m, now),
    ...freshCard(m),
    coveredEventIds: [],
  }
}

const byObservation = (a: Mission, b: Mission): number =>
  (b.lastObservedAt ?? b.updatedAt).localeCompare(a.lastObservedAt ?? a.updatedAt)

/**
 * Build one briefing from committed state and the journal window. Pure:
 * same inputs, same cards; the caller owns persistence and delivery.
 */
export function buildBriefing(inputs: BriefingInputs): BriefingRecord {
  const { state, events, journalSeq, scope } = inputs
  const now = inputs.now ?? Date.now()
  const coverage = coverageOf(state)
  const window = unseenEvents(events, coverage, scope)
  // Absence is runtime-level: a mission brief must not imply the runtime
  // was continuously present either, so read it off the owner-wide window.
  const ownerWindow = scope.kind === 'owner' ? window : unseenEvents(events, coverage, { kind: 'owner' })
  const absenceEvents = ownerWindow.filter(isAbsence)
  const absent = absenceEvents.length > 0
  const missionsById = new Map(state.missions.map((m) => [m.missionId, m]))
  const openDecisions = state.decisions.filter((d) => d.answeredAt === null)
  // A mission can hold more than one open question (a build gate and a PR
  // gate); every one of them is rank 1 news until it is answered, so they are
  // kept as a list, never collapsed to the first.
  const openByMission = new Map<string, DecisionRecord[]>()
  const nativeRequests = new Map<string, NativeAttention[]>()
  for (const m of state.missions) {
    if (m.config.executionBackend !== 'factory_native') continue
    const cache = decodeNativeCache(state.engineSnapshots?.[m.missionId])
    const requests = cache?.snapshot.attention.filter(a => a.state !== 'resolved') ?? []
    if (requests.length) nativeRequests.set(m.missionId, requests)
  }
  for (const d of openDecisions) {
    if (d.missionId === null) continue
    const list = openByMission.get(d.missionId)
    if (list === undefined) openByMission.set(d.missionId, [d])
    else list.push(d)
  }

  // Group meaningful unseen events per mission; collapse each to one card.
  const outcomes = new Map<string, MissionOutcome>()
  const cards: BriefingCard[] = []
  for (const e of window) {
    const meaning = meaningOf(e)
    if (!meaning.meaningful || isStaleBlock(window, e)) continue
    if (e.missionId === undefined || !missionsById.has(e.missionId)) {
      const xHeadline = xCardHeadline(e)
      if (xHeadline !== null) {
        cards.push({
          rank: meaning.rank,
          headline: xHeadline,
          freshness: 'current',
          lastObservedAt: e.observedAt,
          coveredEventIds: [e.eventId],
        })
        continue
      }
      if (e.type === 'runtime_migration_completed') {
        cards.push({
          rank: 4,
          headline: 'I restored your missions from the previous version and checked their current runs.',
          freshness: 'current',
          lastObservedAt: e.observedAt,
          coveredEventIds: [e.eventId],
        })
      }
      continue
    }
    const o = outcomes.get(e.missionId) ?? {
      mission: missionsById.get(e.missionId) as Mission,
      events: [],
      bestRank: 4 as const,
      repairs: 0,
      completed: false,
      failed: false,
      cancelledPartial: false,
      cancelledSuperseded: false,
      planRevised: 0,
      blocks: [],
    }
    o.events.push(e)
    // A decision question is rank 1 ONLY while it still waits on the owner;
    // a question opened and answered while the owner was away is material
    // history, not an urgent ask (§16 ranking).
    const rank = e.type === 'decision_opened' && !openByMission.has(e.missionId) ? 3 : meaning.rank
    if (rank < o.bestRank) o.bestRank = rank
    if (e.type === 'run_observed' && e.payload.phase === 'repairing') o.repairs += 1
    if (e.type === 'plan_revised') o.planRevised += 1
    if (e.type === 'mission_completed') o.completed = true
    if (e.type === 'mission_failed') o.failed = true
    if (e.type === 'cancel_confirmed' && e.payload.basis === 'requests_partial') o.cancelledPartial = true
    if (e.type === 'cancel_confirmed' && e.payload.basis === 'requests_superseded') o.cancelledSuperseded = true
    if (e.type === 'provider_connectivity_changed') o.blocks.push(e)
    outcomes.set(e.missionId, o)
  }
  for (const o of outcomes.values()) {
    const request = nativeRequests.get(o.mission.missionId)?.[0]
    cards.push(request ? nativeDecisionCard(request, o.mission, o.events.map(e => e.eventId))
      : missionCard(state, o, openByMission.get(o.mission.missionId)?.[0] ?? null))
  }

  // Unresolved decisions surface whether or not there is other news (§16:
  // preserve unresolved decisions even if previously seen). State-driven:
  // an acknowledgement does not suppress them until they are answered.
  // Every open question gets its own card — a second gate on the same mission
  // is a second rank-1 ask, never hidden behind the first.
  const shown = new Set(cards.map((c) => c.decisionId).filter((id): id is string => id !== undefined))
  for (const [missionId, requests] of nativeRequests) {
    if (scope.kind === 'mission' && missionId !== scope.missionId) continue
    const m = missionsById.get(missionId)!
    for (const request of requests) {
      if (!shown.has(request.attentionId)) {
        cards.push(nativeDecisionCard(request, m, []))
        shown.add(request.attentionId)
      }
    }
  }
  for (const d of openDecisions) {
    if (shown.has(d.decisionId)) continue
    if (d.missionId === null) {
      if (scope.kind === 'owner') cards.push(decisionCard(d, null, []))
      continue
    }
    if (scope.kind === 'mission' && d.missionId !== scope.missionId) continue
    const m = missionsById.get(d.missionId)
    if (m !== undefined) cards.push(decisionCard(d, m, []))
  }

  // The compaction gap is named, never skipped (§9 briefing coverage) —
  // including when it is the only news.
  const firstWindowSeq = events.length > 0 ? events[0].seq : journalSeq + 1
  const gapBeforeSeq = firstWindowSeq > coverage.acknowledgedSeq + 1 ? firstWindowSeq - 1 : undefined
  if (gapBeforeSeq !== undefined) {
    cards.push({
      rank: 3,
      headline: 'Some earlier changes were compacted before you saw them. Check the phone for current state.',
      freshness: 'stale',
      lastObservedAt: null,
      coveredEventIds: [],
    })
  }

  if (absent) {
    // Pushed before the stable rank sort, so it leads its rank. The recovery
    // events it accounts for ride along in coveredEventIds: an absence the
    // owner has dismissed must not greet them on every reconnect.
    cards.unshift({
      rank: 3,
      headline: 'I was offline for part of this. I rechecked the runs that were already started.',
      freshness: 'reconciling',
      lastObservedAt: null,
      coveredEventIds: absenceEvents.map((e) => e.eventId),
    })
  }

  const coveredEventIds = [...new Set(cards.flatMap((c) => c.coveredEventIds))]
  const absenceIds = new Set(absenceEvents.map((e) => e.eventId))
  // A brief is 'absent' when the ONLY thing it has to say is that the runtime
  // was gone; anything else (an outcome, a gap) makes it a 'return'. Both are
  // acknowledgeable and persisted, so the line never becomes a permanent
  // banner (§16).
  const hasNews = coveredEventIds.some((id) => !absenceIds.has(id)) || gapBeforeSeq !== undefined
  const kind: BriefingKind = hasNews ? 'return' : absent ? 'absent' : 'status'

  if (kind === 'status' && cards.every((c) => c.decisionId === undefined)) {
    // "Nothing meaningful changed" is honest status, not an empty journal:
    // say what is running and when it was last checked (§16). With nothing
    // running, the most recent mission still gets the line — an empty screen
    // would read as "no idea", which is worse than "nothing new".
    const active = state.missions.filter((m) => !isTerminal(m))
    const candidates =
      scope.kind === 'owner'
        ? active.length > 0
          ? active
          : state.missions
        : state.missions.filter((m) => m.missionId === scope.missionId)
    const focus = [...candidates].sort(byObservation)[0]
    if (focus !== undefined) {
      cards.push(statusCard(focus, now, openByMission.has(focus.missionId)))
    }
  }

  // Still-running summary: one compact line over running missions not
  // already carried by an outcome card (§16 "state what is still running
  // and when it was last checked"). The line names several missions, so its
  // freshness fields must be honest about ALL of them: 'current' only when
  // every listed mission is current, and the OLDEST observation as the
  // check time — never one mission's freshness lent to the rest (§5).
  if (kind === 'return' && scope.kind === 'owner') {
    const carried = new Set(cards.map((c) => c.missionId ?? ''))
    const running = state.missions.filter(
      (m) => !carried.has(m.missionId) && m.control === 'running' && !isTerminal(m),
    )
    if (running.length > 0) {
      const oldest = [...running].sort(byObservation).at(-1) as Mission
      const unconfirmed = running.filter((m) => m.freshness !== 'current').length
      const when = checkedAtCopy(oldest.lastObservedAt, now)
      cards.push({
        rank: 4,
        headline: clip(`Still running: ${running.map((m) => clip(m.title, 24)).join(', ')}.`, 96),
        detail:
          unconfirmed === 0
            ? when
            : `${when} Not all of these are confirmed current; this is last-known.`,
        freshness: unconfirmed === 0 ? 'current' : 'unknown',
        lastObservedAt: oldest.lastObservedAt,
        coveredEventIds: [],
      })
    }
  }

  cards.sort((a, b) => a.rank - b.rank)

  const missionRevisions: Record<string, number> = {}
  for (const c of cards) {
    const m = c.missionId !== undefined ? missionsById.get(c.missionId) : undefined
    if (m !== undefined) missionRevisions[m.missionId] = m.planRevision
  }

  return {
    schemaVersion: 2,
    briefingId: mintId('brf'),
    scope,
    kind,
    targetSeq: journalSeq,
    coveredEventIds,
    missionRevisions,
    ...(gapBeforeSeq !== undefined ? { gapBeforeSeq } : {}),
    cards,
    createdAt: nowIso(),
  }
}

/**
 * Owner X intake cards. Private by construction: the glasses say what needs
 * the owner and point at the phone; they never quote the post.
 */
function xCardHeadline(e: DomainEvent): string | null {
  switch (e.type) {
    case 'x_request_needs_owner':
      return e.payload.status === 'clarify'
        ? 'I could not act on an X request. Check the phone to clarify it.'
        : 'An X request is waiting for your OK on the phone.'
    case 'x_edit_after_dispatch':
      return 'You edited an X request after I started it. The change is waiting on the phone.'
    case 'x_delivery_gap':
      return 'Some X posts were past what one check reads. Check the phone for missed requests.'
    default:
      return null
  }
}
