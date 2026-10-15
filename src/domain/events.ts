/**
 * Domain event vocabulary (spec §9). This registry is the minimum event
 * families the persistent runtime understands; unknown `type` strings are
 * preserved on read so a newer journal never breaks an older reader more
 * than it must.
 *
 * Events are drafted without a seq: the store assigns the journal sequence
 * when the commit lands, so a rejected or crashed mutation never leaves a
 * gap or a phantom event behind.
 */
import { mintId, nowIso } from './ids'

export const EVENT_TYPES = [
  'command_received',
  'command_rejected',
  'context_captured',
  'context_incomplete',
  'product_resolved',
  'mission_created',
  'plan_proposed',
  'plan_accepted',
  'plan_revised',
  'dispatch_prepared',
  'dispatch_confirmed',
  'dispatch_uncertain',
  'run_observed',
  'milestone_submitted',
  'milestone_accepted',
  'milestone_rejected',
  'milestone_invalidated',
  'repair_requested',
  'repair_completed',
  'decision_opened',
  'decision_answered',
  'pause_requested',
  'pause_confirmed',
  'resume_requested',
  'resume_confirmed',
  'cancel_requested',
  'cancel_confirmed',
  'integration_completed',
  'mission_completed',
  'mission_failed',
  'provider_connectivity_changed',
  'recovery_completed',
  'briefing_acknowledged',
  // Native observations are not legacy acceptance/review/PR authority.
  'native_features_changed',
  'native_finalization_changed',
  'native_attention_resolved',
  'native_control_observed',
  'native_history_observed',
  'native_intent_promoted',
  'native_intent_dismissed',
  // Migration family (spec §22): imports are labeled, never fabricated.
  'mission_migrated_from_v1',
  'runtime_migration_completed',
  // Owner X intake (spec §11): private receipts, never posted back to X.
  'x_binding_changed',
  'x_request_received',
  'x_request_needs_owner',
  'x_edit_after_dispatch',
  'x_post_deleted',
  'x_delivery_gap',
] as const
export type KnownEventType = (typeof EVENT_TYPES)[number]

/** An event before the store assigns its journal seq. */
export interface EventDraft {
  eventId: string
  entityId: string
  missionId?: string
  type: string
  observedAt: string
  occurredAt?: string
  causalCommandId?: string
  providerEventId?: string
  payload: Record<string, unknown>
}

export function draftEvent(
  type: KnownEventType,
  payload: Record<string, unknown>,
  refs: {
    entityId: string
    missionId?: string
    causalCommandId?: string
    providerEventId?: string
    occurredAt?: string
  },
): EventDraft {
  return {
    eventId: mintId('evt'),
    entityId: refs.entityId,
    missionId: refs.missionId,
    type,
    observedAt: nowIso(),
    occurredAt: refs.occurredAt,
    causalCommandId: refs.causalCommandId,
    providerEventId: refs.providerEventId,
    payload,
  }
}
