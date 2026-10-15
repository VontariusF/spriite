/**
 * Scene protocol — the typed, validated view contract between the
 * factory engine and the HUD renderer. Mirrors spec §11.1
 * "Application-owned scene example".
 *
 * The renderer never invents content and never computes progress numbers:
 * every field it draws comes from a validated scene, and every percentage is
 * composed deterministically from the progress object (see compose.ts).
 */

export const SCENE_SCHEMA_VERSION = 1

export const SCENE_KINDS = [
  'meet',
  'setup_notice',
  'setup_connections',
  'transcript',
  'plan',
  'running',
  'under_review',
  'repair',
  'accepted',
  'regression',
  'decision',
  'decision_detail',
  'switching',
  'final',
  'paused',
  'explain',
  'status_answer',
  // Local-only kinds. The engine ("cloud") may never assert these states;
  // microphone and capture state are local and observed (spec §11.2).
  'mic_error',
  'transcribing',
  'connection_lost',
  'voice_heard',
  'voice_confirm',
  'voice_error',
  // Local notices: another mission or the X intake needs the owner (the
  // engine may never assert them; they are app-side observation).
  'ask_notice',
  'x_notice',
  // Engine-only: a connected service failed while running the real
  // orchestrator. Not local: the engine owns service state.
  'factory_error',
] as const
export type SceneKind = (typeof SCENE_KINDS)[number]

/** Kinds that only local device code may emit (capture and link state are local). */
export const LOCAL_SCENE_KINDS: readonly SceneKind[] = [
  'mic_error', 'transcribing', 'connection_lost', 'voice_heard', 'voice_confirm', 'voice_error',
  'ask_notice', 'x_notice',
]

// The pose vocabulary is owned by the sprite character definition
// (src/sprite/poses.ts). A scene may carry any of the twelve drawn poses or a
// legacy semantic tag (stored records and fixtures keep validating); the
// renderer always draws toPose(scene.spritePose).
import type { ScenePose } from '../sprite/poses'
import type { ChatWho } from '../domain/speaker'

export type SpritePose = ScenePose
export { SCENE_POSE_NAMES as SPRITE_POSES } from '../sprite/poses'

export type SceneActionKind = 'read_only' | 'local_capture' | 'command' | 'system'

export interface SceneAction {
  id: string
  label: string
  kind: SceneActionKind
}

/**
 * One segment of the HUD's milestone bar (HudRun/HudDone boards): done is
 * solid, review is dotted (submitted, awaiting its check), todo is dim.
 */
export type MilestoneMark = 'done' | 'review' | 'todo'

export interface SceneProgress {
  /** Sum of weights of milestones with an accepted, un-invalidated review. */
  acceptedWeight: number
  /** Sum of weights of milestones whose work is submitted, awaiting review. */
  pendingReviewWeight: number
  /** Frozen plan weight. Zero or negative is invalid (spec §11.2). */
  totalWeight: number
  planRevision: number
  /**
   * Per-milestone marks in plan order, when the producer knows them. Absent:
   * the HUD and the phone derive the segments from the weights.
   */
  milestones?: MilestoneMark[]
}

export interface Scene {
  schemaVersion: number
  sceneId: string
  sceneRevision: number
  missionId: string | null
  stateSequence: number
  kind: SceneKind
  spritePose: SpritePose
  contextLabel: string
  utterance: string
  /** Deterministic composition from progress (percentages live here only). */
  status: string
  progress: SceneProgress | null
  actions: SceneAction[]
  evidenceIds: string[]
  generatedAt: string
  /** 0 = persist until answered/acted on; >0 = brief display, then return. */
  transientMs: number
  /**
   * Whose words or work the card shows (the activity log names it). Absent
   * on local cards and on cards built before speakers existed: Spriite.
   */
  speaker?: ChatWho
  /**
   * The right half of the HUD context line (for example
   * 'BUILDING · 2 OF 4', '3 builds · 1 needs you'). Absent: nothing drawn.
   */
  contextDetail?: string
}
