/**
 * Deterministic status text. Percentages are computed here from the progress
 * object only — the HUD never draws a percentage from free-form text and the
 * engine never freehands one (spec §8, §11.1). A zero-weight plan (no
 * milestones yet) divides by zero, so the honest share is 0 — never "NaN%",
 * the same guard the phone's mirror applies (src/phone/app.ts).
 */
import type { SceneProgress } from './types'

/** The boards' separator between status parts ('6 checks passed · 3 agents'). */
export const SEP = ' · '

export function verifiedPercent(p: SceneProgress): number {
  return p.totalWeight > 0 ? Math.round((100 * p.acceptedWeight) / p.totalWeight) : 0
}

export function pendingPercent(p: SceneProgress): number {
  return p.totalWeight > 0 ? Math.round((100 * p.pendingReviewWeight) / p.totalWeight) : 0
}

export function composeStatus(progress: SceneProgress | null, note = ''): string {
  if (!progress) return note
  const parts = [`${verifiedPercent(progress)}% verified`]
  if (progress.pendingReviewWeight > 0) parts.push(`${pendingPercent(progress)}% in review`)
  if (note) parts.push(note)
  return parts.join(SEP)
}
