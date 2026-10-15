/**
 * Sprite frames for the glasses: the twelve poses of
 * docs/design/redesign/Sprite.dc.html, drawn by draw.ts on the 32x32 master
 * grid and doubled into the 64x64 image container. Grey levels 0-15; the
 * hardware draws them green. Transparent cells become 0 (off).
 *
 * Every pose frame is one FrameName (`${pose}.${index}`). On the glasses
 * each frame holds max(d, 1000) ms (MotionLab "Glasses speed · about 1 fps"),
 * which keeps the serialized image transfers ahead of the animation. Lift is
 * part of each frame (the board draws the bob), so there is no separate
 * hover cycle. Every pose loops, celebrate included: Sprite.dc.html's
 * schedule() wraps every pose with more than one frame (`(i + 1) % length`),
 * so celebrate plays its four frames over and over, as drawn.
 *
 * No runtime imports beyond the sibling sprite modules, so dev scripts can
 * load it with the ts-resolve loader.
 */
import { POSE_NAMES, type PoseName } from './poses'
import { POSES, drawFrame, holdMs } from './draw'

export { POSE_NAMES }
export type { PoseName }

export const GRID = 32
export const SCALE = 2
export const SIZE = GRID * SCALE

/** Kept for the renderer's transport signature; lift lives inside each frame now. */
export type Lift = 0

/** One drawn frame of one pose. */
export type FrameName = `${PoseName}.${number}`

export const FRAME_NAMES: FrameName[] = POSE_NAMES.flatMap((pose) =>
  POSES[pose].map((_, i): FrameName => `${pose}.${i}`),
)

export interface AnimStep {
  frame: FrameName
  /** Glasses hold: max(d, 1000) ms. */
  holdMs: number
}

export interface PoseAnim {
  /** The frame shown alone in static and reduce-motion mode. */
  key: FrameName
  steps: AnimStep[]
  /** false = play once and stay on the last step (celebrate settles). */
  loop: boolean
}

/**
 * Poses that play once and settle on their last frame. None: the board's
 * renderer loops every pose (Sprite.dc.html schedule()).
 */
const ONE_SHOT: ReadonlySet<PoseName> = new Set<PoseName>([])

function animFor(pose: PoseName): PoseAnim {
  const frames = POSES[pose]
  const loop = !ONE_SHOT.has(pose)
  const steps = frames.map((f, i): AnimStep => ({ frame: `${pose}.${i}`, holdMs: holdMs(f, 'glasses') }))
  return { key: loop ? `${pose}.0` : `${pose}.${frames.length - 1}`, steps, loop }
}

export const ANIMS: Record<PoseName, PoseAnim> = Object.fromEntries(
  POSE_NAMES.map((pose) => [pose, animFor(pose)]),
) as Record<PoseName, PoseAnim>

/** Split a frame name into its pose and index; null when it names no drawn frame. */
export function parseFrameName(name: string): { pose: PoseName; index: number } | null {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const pose = name.slice(0, dot) as PoseName
  const index = Number(name.slice(dot + 1))
  const frames = (POSES as Record<string, readonly unknown[] | undefined>)[pose]
  if (!frames || !Number.isInteger(index) || index < 0 || index >= frames.length) return null
  return { pose, index }
}

const cache = new Map<string, number[]>()

/** Raw 4-bit grey pixels (0-15), length SIZE*SIZE, for updateImageRawData. */
export function framePixels(name: FrameName, _lift: Lift = 0): number[] {
  const hit = cache.get(name)
  if (hit) return hit
  const parsed = parseFrameName(name)
  if (!parsed) throw new Error(`unknown sprite frame "${name}"`)
  const g = drawFrame(POSES[parsed.pose][parsed.index])
  const out = new Array<number>(SIZE * SIZE)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const v = g[Math.floor(y / SCALE) * GRID + Math.floor(x / SCALE)]
      out[y * SIZE + x] = v < 0 ? 0 : v
    }
  }
  cache.set(name, out)
  return out
}
