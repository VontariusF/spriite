/**
 * HUD bar pixels.
 *
 * The milestone bar (HudRun/HudDone boards, drawn at 2x; 1x here): x 112,
 * y 200, 440 wide, 8 high, one segment per milestone with a 6 px gap, radius
 * 2. Done is solid, in review is dotted (5 on, 4 off), remaining is dim. The
 * firmware caps an image container at 288 px wide and 20 px tall at least,
 * so the 440 px bar travels as two 220x20 halves (left id 4, right id 11)
 * with the segments drawn in rows 0-7.
 *
 * The capture bar (HudListen board): x 112, y 206, 440 wide, 3 high, the
 * elapsed share solid over a dim track, in the same two halves.
 *
 * Geometry is computed from the scene's numbers only (spec §8): the marks
 * come from progress.milestones when the producer knows them, else they are
 * derived from the weights. The legacy 256x20 continuous bar
 * (progressPixels) stays exported for the text-only fallback and old tests.
 */
import type { MilestoneMark, SceneProgress } from '../scenes/types'

/** Image levels (0-15) for the board colours: #9DFFB0 on, #12301A dim track. */
export const LEVEL_ON = 15
export const LEVEL_DIM = 3

/** The full bar as drawn at 1x (both halves together). */
export const SEG_X = 112
export const SEG_Y = 200
export const SEG_W = 440
export const SEG_H = 8
export const SEG_GAP = 6
/** Each half's image container: 220 wide, 20 tall (the firmware minimum). */
export const HALF_W = 220
export const HALF_H = 20
/** Most segments the bar draws (more milestones are grouped). */
export const MAX_SEGMENTS = 16
/** Dotted "in review" pattern (board: 10 px on, 8 px off at 2x). */
export const DOT_ON = 5
export const DOT_PERIOD = 9

export const CAPTURE_Y = 206
export const CAPTURE_H = 3

/** Segments derived from weights when the producer gave no marks. */
export const DERIVED_SEGMENTS = 4

/**
 * The segment marks to draw. Producer marks win; without them the weights
 * are cut into four equal segments: whole quarters accepted are done, whole
 * quarters covered by accepted + pending are in review, the rest remain.
 */
export function milestoneMarks(p: SceneProgress): MilestoneMark[] {
  const given = Array.isArray(p.milestones) ? p.milestones.filter((m) => m === 'done' || m === 'review' || m === 'todo') : []
  if (given.length > 0) {
    if (given.length <= MAX_SEGMENTS) return given
    // Group into MAX_SEGMENTS buckets: a bucket is only as far as its least
    // finished milestone (done < review < todo), never more finished.
    const rank: Record<MilestoneMark, number> = { done: 0, review: 1, todo: 2 }
    const out: MilestoneMark[] = []
    for (let i = 0; i < MAX_SEGMENTS; i++) {
      const from = Math.floor((i * given.length) / MAX_SEGMENTS)
      const to = Math.floor(((i + 1) * given.length) / MAX_SEGMENTS)
      let worst: MilestoneMark = 'done'
      for (let j = from; j < to; j++) if (rank[given[j]] > rank[worst]) worst = given[j]
      out.push(worst)
    }
    return out
  }
  const total = p.totalWeight > 0 ? p.totalWeight : 0
  const n = DERIVED_SEGMENTS
  if (total <= 0) return new Array<MilestoneMark>(n).fill('todo')
  const accepted = Math.min(Math.max(p.acceptedWeight, 0), total)
  const pending = Math.min(Math.max(p.pendingReviewWeight, 0), total - accepted)
  const done = Math.floor((accepted * n) / total + 1e-9)
  const reviewEnd = Math.floor(((accepted + pending) * n) / total + 1e-9)
  const out: MilestoneMark[] = []
  for (let i = 0; i < n; i++) out.push(i < done ? 'done' : i < reviewEnd ? 'review' : 'todo')
  return out
}

/** Segment i's [start, end) columns on the 440 px bar. */
export function segmentSpan(i: number, n: number): [number, number] {
  const w = (SEG_W - SEG_GAP * (n - 1)) / n
  const start = Math.round(i * (w + SEG_GAP))
  const end = Math.round(i * (w + SEG_GAP) + w)
  return [start, Math.min(SEG_W, end)]
}

/** The whole 440x20 milestone bar (segments in rows 0-7, radius 2). */
export function segmentBarPixels(marks: readonly MilestoneMark[]): number[] {
  const out = new Array<number>(SEG_W * HALF_H).fill(0)
  const n = marks.length
  if (n === 0) return out
  for (let i = 0; i < n; i++) {
    const [s, e] = segmentSpan(i, n)
    const mark = marks[i]
    for (let y = 0; y < SEG_H; y++) {
      for (let x = s; x < e; x++) {
        const corner = (x === s || x === e - 1) && (y === 0 || y === SEG_H - 1)
        if (corner) continue // the 2 px radius at 1x clips the corner pixel
        let v = 0
        if (mark === 'done') v = LEVEL_ON
        else if (mark === 'review') v = (x - s) % DOT_PERIOD < DOT_ON ? LEVEL_ON : 0
        else v = LEVEL_DIM
        out[y * SEG_W + x] = v
      }
    }
  }
  return out
}

/** The capture bar: elapsed share solid over the dim track (rows 0-2). */
export function captureBarPixels(fraction: number): number[] {
  const out = new Array<number>(SEG_W * HALF_H).fill(0)
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  const filled = Math.round(SEG_W * f)
  for (let y = 0; y < CAPTURE_H; y++) {
    for (let x = 0; x < SEG_W; x++) {
      const corner = (x === 0 || x === SEG_W - 1) && (y === 0 || y === CAPTURE_H - 1)
      if (corner) continue
      out[y * SEG_W + x] = x < filled ? LEVEL_ON : LEVEL_DIM
    }
  }
  return out
}

/** Split a 440x20 bar into its two 220x20 container images. */
export function splitHalves(full: readonly number[]): [number[], number[]] {
  const left = new Array<number>(HALF_W * HALF_H)
  const right = new Array<number>(HALF_W * HALF_H)
  for (let y = 0; y < HALF_H; y++) {
    for (let x = 0; x < HALF_W; x++) {
      left[y * HALF_W + x] = full[y * SEG_W + x] ?? 0
      right[y * HALF_W + x] = full[y * SEG_W + HALF_W + x] ?? 0
    }
  }
  return [left, right]
}

/** Parse a capture timer ('0:07 of 0:30') into the elapsed share. */
export function captureFraction(timerText: string): number {
  const m = /(\d+):(\d{2})\s+of\s+(\d+):(\d{2})/.exec(timerText)
  if (!m) return 0
  const elapsed = Number(m[1]) * 60 + Number(m[2])
  const limit = Number(m[3]) * 60 + Number(m[4])
  return limit > 0 ? elapsed / limit : 0
}

/** What the milestone bar shows, as a dedupe key (marks + plan revision). */
export function segmentSignature(p: SceneProgress): string {
  return `${milestoneMarks(p).join(',')}#${p.planRevision}`
}

// ------------------------------------------------------------------ legacy

/** Legacy continuous bar (256x20): kept for the text-only fallback. */
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
        out[y * BAR_W + x] = 15
      } else if (x < acceptedPx + pendingPx) {
        const dotted = x % 2 === 0 && y >= 6 && y <= 13
        out[y * BAR_W + x] = dotted ? 8 : 0
      } else if (y >= BAR_H - 2) {
        out[y * BAR_W + x] = 3
      }
    }
  }
  return out
}

export function progressSignature(p: SceneProgress): string {
  return `${p.acceptedWeight}/${p.pendingReviewWeight}/${p.totalWeight}/${p.planRevision}`
}
