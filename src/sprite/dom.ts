/**
 * The phone's Spriite: the `<dc-import name="Sprite">` of the redesign
 * boards (docs/design/redesign/Sprite.dc.html). A `div.spr` (role img,
 * 32*px square) holding a canvas drawn cell by cell with the board's
 * colours: level 0 black ink, 1-15 the green ramp from shade(), -1 left
 * transparent.
 *
 * Timing follows the board: preview speed holds each frame for its `d`,
 * glasses speed for max(d, 1000) ms; changing pose or speed restarts at
 * frame 0. A pinned `frame` (>= 0) shows that frame still. `celebrate`
 * plays once and settles on its last frame ("then it settles");
 * prefers-reduced-motion pins the key frame (frame 0; celebrate's settled
 * last frame).
 *
 * Safe under the Node DOM shim: without canvas.getContext it draws nothing
 * and never throws, and every timer is unref()'d when the runtime allows it
 * so test processes can exit.
 */
import { POSES, drawFrame, holdMs, shade } from './draw'
import { toPose, type PoseName, type ScenePose } from './poses'

export type SpriteSpeed = 'preview' | 'glasses'

export interface SpriteViewOptions {
  pose: ScenePose
  /** Size of one grid cell in CSS px (default 4: a 128 px sprite). */
  px?: number
  speed?: SpriteSpeed
  /** A frame index >= 0 pins that frame (clamped to the pose's last frame). */
  frame?: number
  /** Accessible label; default "Spriite, <pose>". */
  label?: string
}

export interface SpriteView {
  readonly el: HTMLElement
  setPose(p: ScenePose): void
  setSpeed(s: SpriteSpeed): void
  destroy(): void
}

interface Ctx2D {
  clearRect(x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  fillStyle: unknown
}

type TimerHandle = ReturnType<typeof setTimeout>

/** None: Sprite.dc.html's schedule() loops every pose, celebrate included. */
const ONE_SHOT: ReadonlySet<PoseName> = new Set<PoseName>([])

function prefersReducedMotion(): boolean {
  try {
    const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia
    return typeof mm === 'function' && mm('(prefers-reduced-motion: reduce)').matches === true
  } catch {
    return false
  }
}

/** The frame shown alone when motion is off: frame 0 (a one-shot pose would show its settled frame). */
function keyIndex(pose: PoseName): number {
  return ONE_SHOT.has(pose) ? POSES[pose].length - 1 : 0
}

export function createSpriteView(opts: SpriteViewOptions): SpriteView {
  const px = Math.max(1, Math.floor(Number(opts.px) || 4))
  const size = 32 * px
  let pose: PoseName = toPose(opts.pose)
  let speed: SpriteSpeed = opts.speed === 'glasses' ? 'glasses' : 'preview'
  const pin = typeof opts.frame === 'number' && Number.isInteger(opts.frame) && opts.frame >= 0 ? opts.frame : -1
  const fixedLabel = opts.label
  let index = 0
  let timer: TimerHandle | null = null
  let destroyed = false

  const el = document.createElement('div')
  el.className = 'spr'
  el.setAttribute('role', 'img')
  const style = el.style as unknown as Record<string, string>
  style.position = 'relative'
  style.width = `${size}px`
  style.height = `${size}px`
  style.flex = '0 0 auto'

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const cstyle = canvas.style as unknown as Record<string, string>
  cstyle.display = 'block'
  cstyle.width = `${size}px`
  cstyle.height = `${size}px`
  el.append(canvas)

  let ctx: Ctx2D | null = null
  try {
    const getContext = (canvas as { getContext?: unknown }).getContext
    if (typeof getContext === 'function') ctx = (canvas.getContext('2d') as unknown as Ctx2D | null) ?? null
  } catch {
    ctx = null
  }

  const label = (): string => fixedLabel ?? `Spriite, ${pose}`

  const draw = (): void => {
    el.setAttribute('aria-label', label())
    if (!ctx) return
    const frames = POSES[pose]
    const g = drawFrame(frames[Math.min(index, frames.length - 1)])
    ctx.clearRect(0, 0, size, size)
    for (let k = 0; k < 1024; k++) {
      const v = g[k]
      if (v < 0) continue
      ctx.fillStyle = shade(v)
      ctx.fillRect((k % 32) * px, Math.floor(k / 32) * px, px, px)
    }
  }

  const clear = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const schedule = (): void => {
    clear()
    if (destroyed || pin >= 0) return
    const frames = POSES[pose]
    if (frames.length < 2) return
    const oneShot = ONE_SHOT.has(pose)
    if (oneShot && index >= frames.length - 1) return // settled
    const d = holdMs(frames[index % frames.length], speed)
    const t = setTimeout(() => {
      timer = null
      if (destroyed) return
      index = (index + 1) % frames.length
      draw()
      schedule()
    }, d)
    ;(t as unknown as { unref?: () => void }).unref?.()
    timer = t
  }

  const restart = (): void => {
    clear()
    if (pin >= 0) index = Math.min(pin, POSES[pose].length - 1)
    else if (prefersReducedMotion()) index = keyIndex(pose)
    else index = 0
    draw()
    if (pin < 0 && !prefersReducedMotion()) schedule()
  }

  restart()

  return {
    el,
    setPose(p: ScenePose): void {
      const next = toPose(p)
      if (destroyed || next === pose) return
      pose = next
      restart()
    },
    setSpeed(s: SpriteSpeed): void {
      const next: SpriteSpeed = s === 'glasses' ? 'glasses' : 'preview'
      if (destroyed || next === speed) return
      speed = next
      restart()
    },
    destroy(): void {
      destroyed = true
      clear()
    },
  }
}
