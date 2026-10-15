import type { MissionPresentation, NativeFeature, NativeSnapshot } from './protocol'
import type { RealSnapshot } from '../factory/real'
import { deliveryLine } from './delivery'

// The phone cannot tell a v1 feature from a v2 check (the broker projects
// both onto NativeFeature), so every word here must be true for either.
export const NATIVE_FEATURE_STATUS_WORD: Record<NativeFeature['status'], string> = {
  pending: 'pending', in_progress: 'in progress', completed: 'done',
  cancelled: 'cancelled/waived', unmet: 'unmet',
}
export interface NativeFeatureCounts { total: number; done: number; unmet: number; cancelled: number }
/** Only `completed` counts as done; `unmet` and `cancelled` never do. */
export function nativeFeatureCounts(features: readonly NativeFeature[]): NativeFeatureCounts {
  const count = (status: NativeFeature['status']) => features.filter(f => f.status === status).length
  return { total: features.length, done: count('completed'), unmet: count('unmet'), cancelled: count('cancelled') }
}
/** "2/3 done · 1 unmet": compact enough for the HUD status line. */
export function nativeFeatureTally(c: NativeFeatureCounts): string {
  return [`${c.done}/${c.total} done`, c.unmet ? `${c.unmet} unmet` : '',
    c.cancelled ? `${c.cancelled} cancelled/waived` : ''].filter(Boolean).join(' · ')
}
export function nativeFeatureReport(c: NativeFeatureCounts): string {
  if (!c.total) return ''
  const extra = [c.unmet ? `${c.unmet} unmet` : '', c.cancelled ? `${c.cancelled} cancelled or waived` : '']
    .filter(Boolean).join(', ')
  return `Factory reports ${c.done} of ${c.total} features or checks done${extra ? `; ${extra}` : ''}. Not verified acceptance.`
}

export const nativeProviderSummary = (summary: string): string =>
  summary.trim() ? `Provider summary (unverified report): ${summary}` : ''

export function nativeArtifactsVerified(s: NativeSnapshot): boolean {
  const f = s.finalization
  return s.capabilities.qualified && s.completeness === 'complete' &&
    f?.state === 'complete' && f.evidence.length > 0 &&
    f.evidence.every(e => e.verified && e.url.trim() !== '')
}

/** Companion assertions never inherit a provider's production/delivery prose. */
export function nativeTerminalCopy(s: NativeSnapshot): string {
  if (s.control === 'cancelled') return 'Factory reports cancellation. Completion and delivery are not established.'
  if (s.control === 'cancel_requested') return 'Cancellation requested. Native stop and delivery are not confirmed.'
  if (s.state !== 'completed') return ''
  if (s.delivery) {
    return s.delivery.step === 'merged'
      ? `Factory reports completion. Delivered: PR${s.delivery.prNumber ? ` #${s.delivery.prNumber}` : ''} merged after checks passed.`
      : `Factory reports completion. ${deliveryLine(s.delivery)}. Not delivered.`
  }
  if (nativeArtifactsVerified(s)) return 'Factory reports completion. Listed artifact evidence is verified; no production or publication claim.'
  if (!s.finalization || s.finalization.state === 'pending') {
    return 'Factory reports completion. Read-only evidence collection is pending; delivery is not verified.'
  }
  return 'Factory reports completion. Artifact evidence is incomplete; delivery is not verified.'
}

/**
 * Factory can derive `awaiting_input` after a plan is approved while it
 * evaluates checks. With nothing open, that is run work, not planning.
 */
export function nativeEvaluating(s: NativeSnapshot, planApproved = false): boolean {
  return s.state === 'awaiting_input' && s.control !== 'cancelled' &&
    !s.attention.some(a => a.state !== 'resolved') && (planApproved || s.features.length > 0)
}

export function nativePresentation(s: NativeSnapshot, uncertainty = false, planApproved = false): MissionPresentation {
  const pending = s.attention.filter(a => a.state !== 'resolved')
  const first = pending[0]
  const evaluating = nativeEvaluating(s, planApproved)
  const phase = s.control === 'cancelled' ? 'cancelled' :
    s.state === 'completed' && s.finalization?.state === 'pending' ? 'finalizing' : evaluating ? 'running' : s.state
  return {
    backend: 'factory_native', phase,
    activityStatus: s.control === 'cancelled' ? 'fault' : s.state === 'completed' ? 'final' :
      s.control === 'paused' || s.state === 'paused' ? 'paused' : pending.length ? 'decision' :
      s.state === 'running' || s.state === 'orchestrator_turn' || evaluating ? 'building' : 'planning',
    decisionPending: pending.length > 0,
    decisionText: first?.title || first?.questions[0]?.question || '',
    decisionOptions: first?.options.map(o => o.label) ?? [],
    questionIdentity: pending.length ? pending.map(a => `${a.attentionId}:${a.requestId}:${a.revision}:${a.payloadHash}`).join('|') : null,
    faultKind: s.holdReason || (s.completeness !== 'complete' ? 'observation_gap' : null),
    finalSummary: [nativeTerminalCopy(s), nativeProviderSummary(s.finalization?.summary ?? '')].filter(Boolean).join(' '),
    failReason: s.finalization?.reason ?? '',
    hasUnconfirmedDelivery: uncertainty || s.commands.some(c => ['unknown', 'invoked'].includes(c.state)) ||
      pending.some(a => a.state === 'answer_unknown'),
    native: s,
  }
}
export function legacyPresentation(s: RealSnapshot): MissionPresentation {
  return {
    backend: 'legacy', phase: s.phase,
    activityStatus: s.phase === 'plan' && s.planLabels?.length && s.awaiting !== 'plan' ? 'ready' : s.activityStatus ?? '',
    decisionPending: s.decisionPending, decisionText: s.decisionText, decisionOptions: [...s.decisionOptions],
    questionIdentity: s.decisionPending ? s.nativeQuestion ?
      `${s.nativeQuestion.sessionId}:${s.nativeQuestion.toolId}` :
      `${s.decisionKind}:${s.decisionJob ?? ''}:${s.decisionText}` : null,
    faultKind: s.faultKind, finalSummary: s.finalSummary, failReason: s.failReason,
    hasUnconfirmedDelivery: !!s.pendingLeadDelivery || !!s.deliveryAttempts?.length ||
      !!s.pendingLeadPosts?.some(p => p.legacyDeliveryUnknown),
    native: null,
  }
}
