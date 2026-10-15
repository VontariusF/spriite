/**
 * Pose resolution (spec §18 "Priority and scope").
 *
 * Presentation is a PURE function of observable application state: the
 * focused mission, actual interaction, freshness, and any pending briefing.
 * No model, provider, or remote response chooses a pose — a model may suggest
 * approved short copy, never a pose name. That is what makes the character's
 * meaning trustworthy: the same state always draws the same sprite.
 *
 * Priority (highest first), onto the twelve drawn poses
 * (docs/design/REDESIGN-PLAN.md C2, the MotionLab moments):
 *   1. the displayed link is unavailable          -> offline
 *   2. microphone capture is actually active      -> listening
 *   3. a spoken reply is playing                  -> talking
 *   4. an actionable foreground decision          -> asking
 *   5. a blocking condition needing attention     -> blocked
 *   6. a live transient: a receipt                -> talking
 *                        a focus change           -> idle
 *   7. displayed status is unknown                -> checking
 *   8. a return briefing is on screen             -> talking
 *   9. focused mission activity                   -> the phase's pose
 *  10. nothing focused                            -> idle
 *
 * Scope: an operational blocker in an UNRELATED mission is a badge/briefing
 * item, never a sprite hijack — it is reported as `badge`, not as a pose.
 * Only an owner-critical global issue may interrupt the focused sprite.
 */
import type { ControlMode, Freshness, MissionPhase } from '../domain/types'
import { toPose, type PoseName, type ScenePose } from './poses'

/** Live transients: a request just arrived, or the focus just changed. */
export type TransientPose = 'receiving' | 'switching'

export interface PoseInputs {
  /** The displayed communication path is unavailable (link state, not mission). */
  linkDown: boolean
  /** Microphone capture is actually active — observed, never assumed. */
  capturing: boolean
  /** A spoken reply is playing on the phone right now. */
  speaking?: boolean
  /** An actionable decision is on the focused mission, right now. */
  decisionPending: boolean
  /** A blocking condition that needs immediate attention on the FOCUSED mission. */
  blocked: boolean
  /** An owner-critical global issue: may interrupt the focused sprite. */
  ownerCritical: boolean
  /**
   * A transient that is live RIGHT NOW (a request that just arrived while the
   * surface was present, or an explicit focus change). Never a replay.
   */
  transient: TransientPose | null
  /** The displayed status is not currently known. */
  statusUnknown: boolean
  /** A return briefing is on screen. */
  briefingPending: boolean
  /** The focused mission's own activity, or null when nothing is focused. Legacy names normalize. */
  activity: ScenePose | null
  /** A blocking condition exists in a mission that is NOT the focused one. */
  unrelatedBlocked: boolean
}

export interface PoseDecision {
  pose: PoseName
  /**
   * True when a blocker exists outside the focused mission: the surface shows
   * a badge or briefing item, and the sprite keeps the focused meaning.
   */
  badge: boolean
}

/** The focused mission fields the activity mapping reads. */
export interface FocusedActivity {
  phase: MissionPhase
  control: ControlMode
}

/**
 * The pose a focused mission's own activity earns. Control outranks phase: a
 * mission the owner paused is resting, whatever the engine last reported; a
 * cancellation still in flight is still working, not yet cancelled.
 */
export function activityPoseFor(focused: FocusedActivity): PoseName {
  if (focused.control === 'paused') return 'paused'
  if (focused.control === 'pause_requested' || focused.control === 'cancel_requested') return 'building'
  switch (focused.phase) {
    case 'received':
      return 'talking'
    case 'gathering_context':
      return 'thinking'
    case 'planning':
      return 'thinking'
    case 'ready':
      // Approved and being handed out to workers.
      return 'delegating'
    case 'building':
      return 'building'
    case 'reviewing':
      return 'checking'
    case 'repairing':
      return 'blocked'
    case 'integrating':
      return 'building'
    case 'awaiting_decision':
      return 'asking'
    case 'completed':
      return 'celebrate'
    case 'failed':
      return 'blocked'
    case 'cancelled':
      return 'idle'
  }
}

/** Does this freshness mean the displayed status is not currently known? */
export function statusUnknownFor(freshness: Freshness): boolean {
  return freshness === 'unknown' || freshness === 'reconciling'
}

/**
 * Resolve the pose for one surface. Pure and total: every input combination
 * maps to exactly one pose, and the order below is the spec's priority.
 */
export function resolvePose(inputs: PoseInputs): PoseDecision {
  const badge = inputs.unrelatedBlocked
  const decide = (pose: PoseName): PoseDecision => ({ pose, badge })

  if (inputs.linkDown) return decide('offline')
  if (inputs.capturing) return decide('listening')
  if (inputs.speaking) return decide('talking')
  if (inputs.decisionPending) return decide('asking')
  if (inputs.blocked || inputs.ownerCritical) return decide('blocked')
  // A live transient is direct feedback for something the owner just did; it
  // outranks steady-state status but never an actionable decision or a block.
  if (inputs.transient === 'receiving') return decide('talking')
  if (inputs.transient === 'switching') return decide('idle')
  if (inputs.statusUnknown) return decide('checking')
  if (inputs.briefingPending) return decide('talking')
  return decide(inputs.activity === null ? 'idle' : toPose(inputs.activity))
}
