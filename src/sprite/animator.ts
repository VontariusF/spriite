/**
 * Sprite animator. Plays each pose's frame script from frames.ts against the
 * renderer's serialized image queue. On the glasses every frame holds
 * max(d, 1000) ms (MotionLab "Glasses speed"); the bob is drawn into the
 * frames themselves, so there is no separate hover timeline.
 *
 * Animation is decorative and strictly bounded (user-facing invariant: motion
 * never blocks text or progress), and the transport rules are the spec's:
 * - at most ONE sprite image transfer is ever in flight, and only the NEWEST
 *   pending frame is retained — a slow link lowers the frame rate, it never
 *   builds a history of frames to catch up on;
 * - each frame's hold is timed from the moment its transfer finished (the
 *   frame is on screen), so a slow transfer followed by a fast one can
 *   never shorten the earlier frame below its hold, and a delayed transfer
 *   cannot cause a burst of queued frames;
 * - a stale generation never enqueues another frame after cancellation: every
 *   step re-checks its generation before touching the queue;
 * - every pose has a key frame, and static (or reduce-motion) mode pins each
 *   pose there with no timers (frame 0; celebrate pins its settled last frame);
 * - nothing is sent while no display surface is attached, though the runtime
 *   and domain work continue independently;
 * - reduce motion drops the frame alternation while preserving the semantic
 *   pose (and all text).
 */
import { ANIMS, type FrameName, type Lift, type PoseName } from './frames'
import { toPose, type ScenePose } from './poses'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export type ShowFrame = (frame: FrameName, lift: Lift) => Promise<void>

interface Pending {
  frame: FrameName
  lift: Lift
  /** Settles when this frame's transfer finished, or it was superseded or dropped. */
  done: () => void
}

export class SpriteAnimator {
  private pose: PoseName = 'idle'
  private gen = 0
  private staticMode = false
  private reduceMotion = false
  private surfaceAttached = true
  private current: FrameName = 'idle.0'
  /** The one newest frame waiting for the single in-flight transfer. */
  private queued: Pending | null = null
  private pumping = false
  private readonly show: ShowFrame

  constructor(show: ShowFrame) {
    this.show = show
  }

  get isStatic(): boolean {
    return this.staticMode
  }

  get isReduceMotion(): boolean {
    return this.reduceMotion
  }

  get currentPose(): PoseName {
    return this.pose
  }

  /** The frame most recently handed to the transport (for tests and repaints). */
  get currentFrame(): FrameName {
    return this.current
  }

  /**
   * Switch pose; a NEW pose plays its script from the first step. Legacy
   * scene names normalize onto the twelve drawn poses. Forcing the same pose
   * (a page rebuild) repaints it without replaying a one-shot: a celebration
   * is for a new event, never a replay.
   */
  setPose(scenePose: ScenePose, opts: { force?: boolean } = {}): void {
    const pose = toPose(scenePose)
    if (pose === this.pose) {
      if (opts.force) this.start(false)
      return
    }
    this.pose = pose
    this.start(true)
  }

  /** Static mode: show only each pose's key frame, grounded; no timers. */
  setStatic(on: boolean): void {
    if (this.staticMode === on) return
    this.staticMode = on
    this.start(false)
  }

  toggleStatic(): boolean {
    this.setStatic(!this.staticMode)
    return this.staticMode
  }

  /** Reduce motion: no frame alternation; the key frame keeps the meaning. */
  setReduceMotion(on: boolean): void {
    if (this.reduceMotion === on) return
    this.reduceMotion = on
    this.start(false)
  }

  /**
   * The display surface came or went. With no surface there is nothing to
   * draw: schedules stop and no frame is sent. Reattaching repaints the
   * current pose (a one-shot shows its settled frame, not a replay). The
   * transport must not dedupe that repaint against the detached surface.
   */
  setSurfaceAttached(on: boolean): void {
    if (this.surfaceAttached === on) return
    this.surfaceAttached = on
    if (on) this.start(false)
    else this.stop()
  }

  /** Re-present the current frame if the host wiped it (e.g. page rebuild). */
  invalidate(): void {
    this.enqueue(this.current)
  }

  /** Halt every schedule; nothing further is ever queued. */
  stop(): void {
    this.gen += 1 // running loops see the bump and never queue another frame
    this.queued?.done()
    this.queued = null
  }

  private start(fromBeginning: boolean): void {
    const gen = ++this.gen
    this.queued?.done()
    this.queued = null
    if (!this.surfaceAttached) return
    const anim = ANIMS[this.pose]
    // Reduce motion keeps the pose's meaning and drops its motion: like static
    // mode, it pins the key frame and runs no timers.
    if (this.staticMode || this.reduceMotion) {
      this.current = anim.key
      this.enqueue(anim.key)
      return
    }
    const steps = anim.steps
    const holdOf = (i: number): number => {
      const s = steps[i]
      const terminal = !anim.loop && i === steps.length - 1
      if (!s || terminal || steps.length < 2) return Infinity
      return s.holdMs
    }
    void (async () => {
      let step = fromBeginning || anim.loop ? 0 : steps.length - 1
      while (gen === this.gen) {
        const s = steps[step]
        if (!s) return
        this.current = s.frame
        const hold = holdOf(step)
        // The hold starts when the frame is actually on screen: wait for its
        // transfer to finish, then hold it (MotionLab: at least 1000 ms at
        // glasses speed, however long the previous transfer took).
        await this.enqueue(this.current)
        if (gen !== this.gen) return // cancelled mid-transfer: queue nothing further
        if (hold === Infinity) return // settled or single-frame pose: nothing left to animate
        await sleep(hold)
        if (gen !== this.gen) return // cancelled mid-wait: queue nothing further
        // One step per hold, never a backlog: a late wake-up or a stalled
        // link moves one step at most, so it cannot produce a catch-up burst.
        step = step + 1 < steps.length ? step + 1 : anim.loop ? 0 : step
      }
    })()
  }

  /**
   * Keep only the newest pending frame, and run at most one transfer at a
   * time. A frame arriving while a transfer is in flight REPLACES the pending
   * one instead of queueing behind it, so a slow link shows the current
   * meaning rather than a stale backlog.
   */
  private enqueue(frame: FrameName): Promise<void> {
    if (!this.surfaceAttached) return Promise.resolve()
    this.queued?.done() // the newer frame replaces it: it will never be sent
    let done: () => void = () => {}
    const landed = new Promise<void>((resolve) => { done = resolve })
    this.queued = { frame, lift: 0, done }
    void this.drain()
    return landed
  }

  private async drain(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queued !== null && this.surfaceAttached) {
        const item = this.queued
        this.queued = null
        try {
          await this.show(item.frame, item.lift)
        } catch (err) {
          // Decorative motion never breaks the app: drop the frame, keep pumping.
          console.warn('[sprite] frame transfer failed:', err)
        } finally {
          item.done()
        }
      }
    } finally {
      this.pumping = false
      // Detached mid-drain: a frame still waiting will never be sent.
      if (!this.surfaceAttached && this.queued !== null) {
        this.queued.done()
        this.queued = null
      }
    }
  }
}
