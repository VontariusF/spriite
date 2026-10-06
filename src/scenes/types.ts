/**
 * Scene protocol — the typed, validated view contract between the (demo)
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
  // Engine-only: a connected service failed while running the real
  // orchestrator. Not local: the engine owns service state.
  'factory_error',
] as const
export type SceneKind = (typeof SCENE_KINDS)[number]

/** Kinds that only local device code may emit (capture and link state are local). */
export const LOCAL_SCENE_KINDS: readonly SceneKind[] = [
  'mic_error', 'transcribing', 'connection_lost', 'voice_heard', 'voice_confirm', 'voice_error',
]

// The pose vocabulary is owned by the sprite character definition
// (src/sprite/frames.ts) so the scene protocol and the animation stay in
// lockstep: every valid pose has a key frame and a frame script.
import type { PoseName } from '../sprite/frames'

export type SpritePose = PoseName
export { POSE_NAMES as SPRITE_POSES } from '../sprite/frames'

export type SceneActionKind = 'read_only' | 'local_capture' | 'command' | 'system'

export interface SceneAction {
  id: string
  label: string
  kind: SceneActionKind
}

export interface SceneProgress {
  /** Sum of weights of milestones with an accepted, un-invalidated review. */
  acceptedWeight: number
  /** Sum of weights of milestones whose work is submitted, awaiting review. */
  pendingReviewWeight: number
  /** Frozen plan weight. Zero or negative is invalid (spec §11.2). */
  totalWeight: number
  planRevision: number
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
  /** Demo honesty invariant: every scene is labeled (spec §4.4). */
  demo: boolean
  /** 0 = persist until answered/acted on; >0 = brief display, then return. */
  transientMs: number
}
