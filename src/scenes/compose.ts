/**
 * Deterministic status text. Percentages are computed here from the progress
 * object only — the HUD never draws a percentage from free-form text and the
 * engine never freehands one (spec §8, §11.1).
 */
import type { SceneProgress } from './types'

export function verifiedPercent(p: SceneProgress): number {
  return Math.round((100 * p.acceptedWeight) / p.totalWeight)
}

export function pendingPercent(p: SceneProgress): number {
  return Math.round((100 * p.pendingReviewWeight) / p.totalWeight)
}

export function composeStatus(progress: SceneProgress | null, note = ''): string {
  if (!progress) return note
  const parts = [`${verifiedPercent(progress)}% verified`]
  if (progress.pendingReviewWeight > 0) parts.push(`${pendingPercent(progress)}% in review`)
  if (note) parts.push(note)
  return parts.join(' | ')
}
