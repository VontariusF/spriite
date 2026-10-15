/**
 * Spriite pose vocabulary (docs/design/redesign/MotionLab.dc.html).
 *
 * Twelve drawn poses, in the board's order. Older code and scene producers
 * still carry semantic tags from the previous vocabulary (`waiting`,
 * `repair`, ...); those stay valid scene names and normalize onto the drawn
 * poses through LEGACY_POSE_MAP and toPose(), following the moments each
 * pose is shown in the motion lab.
 *
 * No runtime imports and erasable-only syntax, so Node scripts load it
 * directly.
 */

export const POSE_NAMES = [
  'idle',
  'listening',
  'talking',
  'thinking',
  'building',
  'delegating',
  'checking',
  'asking',
  'celebrate',
  'blocked',
  'paused',
  'offline',
] as const
export type PoseName = (typeof POSE_NAMES)[number]

export const LEGACY_POSE_NAMES = [
  'waiting',
  'planning',
  'repair',
  'accepted',
  'disconnected',
  'switching',
  'receiving',
  'researching',
  'reconciling',
  'briefing',
] as const
export type LegacyPoseName = (typeof LEGACY_POSE_NAMES)[number]

/** Every name a Scene/EngineView may carry: the 12 drawn poses plus legacy semantic tags. */
export type ScenePose = PoseName | LegacyPoseName
export const SCENE_POSE_NAMES: readonly ScenePose[] = [...POSE_NAMES, ...LEGACY_POSE_NAMES]

/** Legacy semantic tags -> the drawn pose that shows that moment (MotionLab). */
export const LEGACY_POSE_MAP: Record<LegacyPoseName, PoseName> = {
  waiting: 'building',
  planning: 'thinking',
  researching: 'thinking',
  repair: 'blocked',
  accepted: 'celebrate',
  disconnected: 'offline',
  switching: 'idle',
  receiving: 'talking',
  reconciling: 'checking',
  briefing: 'talking',
}

const DRAWN: ReadonlySet<string> = new Set(POSE_NAMES)

/** Normalize any scene pose (or unknown string) to one of the twelve drawn poses. */
export function toPose(p: ScenePose | string): PoseName {
  if (DRAWN.has(p)) return p as PoseName
  if (Object.prototype.hasOwnProperty.call(LEGACY_POSE_MAP, p)) return LEGACY_POSE_MAP[p as LegacyPoseName]
  return 'idle'
}

/** MotionLab META, verbatim: display name, the moment the pose is shown, frame count. */
export const POSE_META: Record<PoseName, { name: string; when: string; frames: number }> = {
  idle: { name: 'Idle', when: 'Nothing needs you. Spriite bobs, glances around and blinks.', frames: 4 },
  listening: { name: 'Listening', when: 'While you hold the touchpad or after “Hey Spriite”. Sound waves grow toward it.', frames: 3 },
  talking: { name: 'Talking', when: 'Reading a reply aloud, or repeating back what it heard before acting.', frames: 3 },
  thinking: { name: 'Planning', when: 'The Lead is planning. Ideas orbit its leaf while it looks up.', frames: 3 },
  building: { name: 'Building', when: 'Workers are coding. Squash and stretch, a second leaf unfurls and bits fly off.', frames: 3 },
  delegating: { name: 'Delegating', when: 'The Lead hands work out. Small helper sprites peel away to each side.', frames: 3 },
  checking: { name: 'Checking', when: 'The reviewer runs checks. A lens sweeps from side to side.', frames: 2 },
  asking: { name: 'Asking', when: 'A question is waiting for you. Head tilted, question mark bobbing.', frames: 2 },
  celebrate: { name: 'Celebrating', when: 'A milestone or build lands. A hop, its leaves open and little leaves fall, then it settles.', frames: 4 },
  blocked: { name: 'Blocked', when: 'Something failed and needs a fix. Brows down, leaf drooping, under a small rain cloud.', frames: 2 },
  paused: { name: 'Paused', when: 'You paused the build. Eyes closed, leaf folded into a bud, pause bars beside it.', frames: 1 },
  offline: { name: 'Offline', when: 'The glasses or the host link dropped. Dim and dozing until it reconnects.', frames: 2 },
}
