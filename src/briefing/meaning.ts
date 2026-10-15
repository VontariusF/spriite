/**
 * Which journal events are worth an owner's attention (spec §16). Shared by
 * the briefing builder (ranking), the coverage ledger (what a mission-scoped
 * acknowledgement may also settle), and the phone inbox (unseen badges).
 *
 * The mapping is the domain vocabulary, not the current engine's output: the
 * adapter today emits mission_completed, decision_opened/answered,
 * plan_revised, run_observed, provider_connectivity_changed, and
 * cancel_confirmed. The remaining types (mission_failed, milestone_accepted,
 * milestone_invalidated, repair_requested/completed, integration_completed)
 * are mapped so that the day the adapter starts emitting one, it is news by
 * construction instead of being silently dropped. Anything unmapped is noise
 * by definition — intermediate phase churn, not an outcome.
 */
import type { DomainEvent } from '../domain/types'

export type Meaning = { meaningful: false } | { meaningful: true; rank: 1 | 2 | 3 | 4 }

export function meaningOf(e: DomainEvent): Meaning {
  switch (e.type) {
    case 'mission_completed':
    case 'mission_failed':
    case 'integration_completed':
    case 'milestone_accepted':
    case 'native_finalization_changed':
      return { meaningful: true, rank: 2 }
    case 'decision_opened':
      return { meaningful: true, rank: 1 }
    case 'decision_answered':
      // Only a runtime-closed question is news; the owner answered their own.
      return String(e.payload.outcome) === 'closed' ? { meaningful: true, rank: 3 } : { meaningful: false }
    case 'plan_revised':
    case 'milestone_invalidated':
    case 'repair_requested':
    case 'repair_completed':
    case 'native_features_changed':
    case 'native_attention_resolved':
    case 'native_control_observed':
      return { meaningful: true, rank: 3 }
    case 'native_history_observed':
      return { meaningful: true, rank: 4 }
    case 'run_observed':
      // A repair is material; the other phase transitions are intermediate.
      return e.payload.phase === 'repairing' ? { meaningful: true, rank: 3 } : { meaningful: false }
    case 'provider_connectivity_changed':
      // A NEW block; a recovery is only news relative to an earlier block.
      return e.payload.kind !== 'recovered' ? { meaningful: true, rank: 1 } : { meaningful: false }
    case 'cancel_confirmed':
      // A clean cancel is what the owner asked for; the rest is news.
      return e.payload.basis === 'requests_accepted' ? { meaningful: false } : { meaningful: true, rank: 2 }
    // Owner X intake (§11): a held or unclear request and an edit that
    // arrived after dispatch both wait on the owner; a delivery gap is a
    // coverage limit the owner must be told about, never hidden.
    case 'x_request_needs_owner':
    case 'x_edit_after_dispatch':
      return { meaningful: true, rank: 1 }
    case 'x_delivery_gap':
      return { meaningful: true, rank: 3 }
    case 'mission_migrated_from_v1':
    case 'runtime_migration_completed':
      return { meaningful: true, rank: 4 }
    default:
      return { meaningful: false }
  }
}

export function isMeaningful(e: DomainEvent): boolean {
  return meaningOf(e).meaningful
}

/**
 * The runtime was absent since the owner last acknowledged: a recovery from
 * a LATER epoch (the previous generation died) or one that had to resume a
 * started command. A first-ever boot (epoch 1, nothing resumed) is not an
 * absence.
 */
export function isAbsence(e: DomainEvent): boolean {
  if (e.type !== 'recovery_completed') return false
  const epoch = Number(e.payload.epoch)
  const resumed = Array.isArray(e.payload.resumedStarts) && e.payload.resumedStarts.length > 0
  return (Number.isFinite(epoch) && epoch > 1) || resumed
}
