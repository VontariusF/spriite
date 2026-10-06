/**
 * Scene validation (spec §11.2). A scene that fails validation is never sent
 * to the renderer unmodified; the caller falls back to the last valid scene.
 */
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext'
import {
  LOCAL_SCENE_KINDS,
  SCENE_KINDS,
  SCENE_SCHEMA_VERSION,
  SPRITE_POSES,
  type Scene,
  type SceneKind,
} from './types'

export interface SceneBudget {
  width: number
  lines: number
}

/** Inner text budgets for the conversation layout (spec §6.1 geometry). */
export const BUDGETS = {
  context: { width: 528, lines: 1 },
  utterance: { width: 440, lines: 4 },
  status: { width: 440, lines: 1 },
  actionLabel: { width: 160, lines: 1 },
} as const satisfies Record<string, SceneBudget>

export type SceneOrigin = 'engine' | 'local'

export interface SceneIssue {
  field: string
  message: string
}

export function fitsSingleLine(text: string, maxWidth: number): boolean {
  if (!text) return true
  if (text.includes('\n')) return false
  return getTextWidth(text) <= maxWidth
}

export function fitsWrappedLines(text: string, maxWidth: number, maxLines: number): boolean {
  if (!text) return true
  const lines = text
    .split('\n')
    .reduce((n, part) => n + (part ? measureTextWrap(part, maxWidth).lineCount : 0), 0)
  return lines <= maxLines
}

const REVIEW_CLAIM_KINDS: readonly SceneKind[] = [
  'under_review',
  'accepted',
  'repair',
  'regression',
]

export function validateScene(scene: Scene, origin: SceneOrigin): SceneIssue[] {
  const issues: SceneIssue[] = []

  if (scene.schemaVersion !== SCENE_SCHEMA_VERSION) {
    issues.push({ field: 'schemaVersion', message: `expected ${SCENE_SCHEMA_VERSION}` })
  }
  if (!SCENE_KINDS.includes(scene.kind)) {
    issues.push({ field: 'kind', message: `unknown kind "${scene.kind}"` })
    return issues // cannot interpret the rest safely
  }
  if (origin === 'engine' && LOCAL_SCENE_KINDS.includes(scene.kind)) {
    issues.push({ field: 'kind', message: 'capture state is local and observed; the engine may not assert it' })
  }
  if (!SPRITE_POSES.includes(scene.spritePose)) {
    issues.push({ field: 'spritePose', message: `unknown pose "${scene.spritePose}"` })
  }
  if (scene.stateSequence < 1) issues.push({ field: 'stateSequence', message: 'must be >= 1' })
  if (scene.sceneRevision < 1) issues.push({ field: 'sceneRevision', message: 'must be >= 1' })

  if (scene.actions.length > 3) issues.push({ field: 'actions', message: 'at most 3 actions per card' })
  const ids = new Set<string>()
  for (const a of scene.actions) {
    if (!a.id) issues.push({ field: 'actions', message: 'empty action id' })
    if (ids.has(a.id)) issues.push({ field: 'actions', message: `duplicate action id "${a.id}"` })
    ids.add(a.id)
    if (a.label.length < 1 || a.label.length > 18) {
      issues.push({ field: 'actions', message: `label "${a.label}" must be 1-18 chars` })
    }
    if (!fitsSingleLine(a.label, BUDGETS.actionLabel.width)) {
      issues.push({ field: 'actions', message: `label "${a.label}" overflows the action budget` })
    }
  }

  if (scene.progress) {
    const p = scene.progress
    if (p.totalWeight < 1) issues.push({ field: 'progress.totalWeight', message: 'must be positive' })
    if (p.acceptedWeight < 0 || p.pendingReviewWeight < 0) {
      issues.push({ field: 'progress', message: 'weights must be non-negative' })
    }
    if (p.acceptedWeight + p.pendingReviewWeight > p.totalWeight) {
      issues.push({ field: 'progress', message: 'accepted + pending must not exceed total' })
    }
    if (p.planRevision < 1) issues.push({ field: 'progress.planRevision', message: 'must be >= 1' })
  }

  if (REVIEW_CLAIM_KINDS.includes(scene.kind)) {
    if (!scene.progress) {
      issues.push({ field: 'progress', message: `kind "${scene.kind}" requires progress` })
    }
    if (scene.evidenceIds.length < 1) {
      issues.push({ field: 'evidenceIds', message: `kind "${scene.kind}" requires evidence` })
    }
  }

  if (scene.demo && !scene.contextLabel.includes('DEMO')) {
    issues.push({ field: 'contextLabel', message: 'demo scenes must be labeled DEMO' })
  }

  if (!fitsSingleLine(scene.contextLabel, BUDGETS.context.width)) {
    issues.push({ field: 'contextLabel', message: 'context overflows one line' })
  }
  if (!fitsWrappedLines(scene.utterance, BUDGETS.utterance.width, BUDGETS.utterance.lines)) {
    issues.push({ field: 'utterance', message: 'utterance exceeds 4 wrapped lines' })
  }
  if (!fitsSingleLine(scene.status, BUDGETS.status.width)) {
    issues.push({ field: 'status', message: 'status overflows one line' })
  }
  // Percentages are authoritative only in the composed status (spec §11.1).
  if (/\d+\s*%/.test(scene.utterance)) {
    issues.push({ field: 'utterance', message: 'percentages belong in status, not utterance' })
  }

  const okTransient = scene.transientMs === 0 || (scene.transientMs >= 1500 && scene.transientMs <= 60000)
  if (!okTransient) issues.push({ field: 'transientMs', message: 'must be 0 or 1500-60000' })

  return issues
}
