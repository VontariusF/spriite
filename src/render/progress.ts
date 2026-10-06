/**
 * Progress bar pixels (spec §8 "HUD representation"). Geometry is computed
 * from backend numbers only:
 *   solid  = accepted weight
 *   dotted = submitted work awaiting review (bounded adjacent width)
 *   dim baseline = remaining scope
 * The renderer clamps and validates that accepted + pending never exceeds
 * total. The numeric status label stays authoritative if the bar quantizes.
 */
import type { SceneProgress } from '../scenes/types'

export const BAR_W = 256
export const BAR_H = 20

export function progressPixels(p: SceneProgress): number[] {
  const total = Math.max(1, p.totalWeight)
  const accepted = Math.min(Math.max(p.acceptedWeight, 0), total)
  const pending = Math.min(Math.max(p.pendingReviewWeight, 0), total - accepted)
  const acceptedPx = Math.round((BAR_W * accepted) / total)
  const pendingPx = Math.round((BAR_W * pending) / total)
  const out = new Array<number>(BAR_W * BAR_H).fill(0)
  for (let y = 0; y < BAR_H; y++) {
    for (let x = 0; x < BAR_W; x++) {
      if (x < acceptedPx) {
        out[y * BAR_W + x] = 15 // solid, full height
      } else if (x < acceptedPx + pendingPx) {
        // dotted: alternating columns, half height — visually "under review"
        const dotted = x % 2 === 0 && y >= 6 && y <= 13
        out[y * BAR_W + x] = dotted ? 8 : 0
      } else if (y >= BAR_H - 2) {
        out[y * BAR_W + x] = 3 // dim baseline: remaining scope stays visible
      }
    }
  }
  return out
}

export function progressSignature(p: SceneProgress): string {
  return `${p.acceptedWeight}/${p.pendingReviewWeight}/${p.totalWeight}/${p.planRevision}`
}
