/**
 * Sprite animator. Runs two timelines against the renderer's serialized image
 * queue: the per-pose frame script from frames.ts, and a continuous hover
 * (lift 0 -> 1 -> 2 -> 1) shared by every pose except disconnected. Each
 * rendered image is the current pose frame at the current hover height.
 *
 * Animation is decorative and strictly bounded (user-facing invariant: motion
 * never blocks text or progress):
 * - at most ONE frame is ever queued; the next frame is only queued after the
 *   previous one finished sending, and sprite frames travel on the gateway's
 *   low-priority lane, so text and progress always jump ahead of motion;
 * - timelines run on wall-clock deadlines, so a slow BLE link lowers the frame
 *   rate instead of building a backlog;
 * - every pose has a key frame, and static mode pins each pose there, grounded;
 * - a pose change or stop() cancels the running schedule immediately.
 */
import {
  ANIMS,
  HOVER_CYCLE,
  HOVER_HOLD_MS,
  type FrameName,
  type Lift,
  type PoseName,
} from './frames'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export type ShowFrame = (frame: FrameName, lift: Lift) => Promise<void>

export class SpriteAnimator {
  private pose: PoseName = 'idle'
  private gen = 0
  private staticMode = false
  private current: FrameName = 'idle'
  private lift: Lift = 0
  private hoverIdx = 0
  private readonly show: ShowFrame

  constructor(show: ShowFrame) {
    this.show = show
  }

  get isStatic(): boolean {
    return this.staticMode
  }

  /** Switch pose; restarts that pose's script from its first step. */
  setPose(pose: PoseName, opts: { force?: boolean } = {}): void {
    if (pose === this.pose && !opts.force) return
    this.pose = pose
    this.start()
  }

  /** Static mode: show only each pose's key frame, grounded; no timers. */
  setStatic(on: boolean): void {
    if (this.staticMode === on) return
    this.staticMode = on
    this.start()
  }

  toggleStatic(): boolean {
    this.setStatic(!this.staticMode)
    return this.staticMode
  }

  /** Re-present the current frame if the host wiped it (e.g. page rebuild). */
  invalidate(): void {
    void this.show(this.current, this.lift)
  }

  /** Halt every schedule; nothing further is ever queued. */
  stop(): void {
    this.gen += 1 // running loops see the bump and never queue another frame
  }

  private start(): void {
    const gen = ++this.gen
    const anim = ANIMS[this.pose]
    const hover = anim.hover !== false
    if (this.staticMode) {
      this.current = anim.key
      this.lift = 0
      void this.show(anim.key, 0)
      return
    }
    const steps = anim.steps
    const holdOf = (i: number): number => {
      const s = steps[i]
      const terminal = !anim.loop && i === steps.length - 1
      if (!s || terminal) return Infinity
      return s.holdMs + (s.jitterMs ? Math.random() * s.jitterMs : 0)
    }
    // Hover keeps its phase across pose changes so the float never jumps.
    if (!hover) this.hoverIdx = 0
    void (async () => {
      let step = 0
      let now = Date.now()
      let stepEnds = now + holdOf(0)
      let hoverEnds = hover ? now + HOVER_HOLD_MS : Infinity
      while (gen === this.gen) {
        const s = steps[step]
        if (!s) return
        this.current = s.frame
        this.lift = hover ? HOVER_CYCLE[this.hoverIdx] : 0
        await this.show(this.current, this.lift)
        if (gen !== this.gen) return // pose changed mid-send; the new script owns the sprite
        const next = Math.min(stepEnds, hoverEnds)
        if (next === Infinity) return // grounded, settled pose: nothing left to animate
        await sleep(Math.max(0, next - Date.now()))
        if (gen !== this.gen) return
        now = Date.now()
        if (now >= stepEnds) {
          step = step + 1 < steps.length ? step + 1 : anim.loop ? 0 : step
          stepEnds = now + holdOf(step)
        }
        if (now >= hoverEnds) {
          this.hoverIdx = (this.hoverIdx + 1) % HOVER_CYCLE.length
          hoverEnds = now + HOVER_HOLD_MS
        }
      }
    })()
  }
}
