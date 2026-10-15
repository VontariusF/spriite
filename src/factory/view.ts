/**
 * The view an engine emits for the HUD and the phone mirror: a validated
 * scene, or a selection list (goal list, plan detail, evidence, builds, a
 * pending question's options).
 */
import type { Scene, SpritePose } from '../scenes/types'

export type EngineView =
  | { type: 'scene'; scene: Scene }
  | {
      type: 'selection'
      /** 'decision': a pending question's option list (options + speak row). */
      purpose: 'goal' | 'plan_detail' | 'evidence' | 'projects' | 'decision'
      contextLabel: string
      /** Right half of the HUD context line (HudAsk: the build's title). Optional. */
      contextDetail?: string
      title: string
      items: string[]
      pose: SpritePose
    }
