/**
 * Global scheduler for the runtime (spec §14): admission control over a
 * bounded pool of concurrent provider worker runs, shared fairly across all
 * active missions. The selected/focused mission has NO scheduling
 * privilege — eligibility comes from durable mission state only.
 *
 * Fairness contract:
 *  - capacity is counted in worker runs; a mission admits once for its
 *    frozen `maxConcurrentWorkers` (its engine spawns that many at build);
 *  - when capacity is short, missions join a FIFO waiting queue; a later
 *    mission can never take a freed slot ahead of an earlier waiter
 *    (a busy mission cannot starve another eligible one, §25.8);
 *  - pause and cancel remove missions from admission without touching
 *    other missions' eligibility;
 *  - observation is never capacity-gated: capacity limits launches, not
 *    polling (spec §14 "reserve the ability to observe and review").
 */

/** Spec §14: default maximum concurrent worker runs across the entity. */
export const DEFAULT_MAX_CONCURRENT_WORKERS = 4

export type AdmissionChange =
  | { kind: 'admitted'; missionId: string }
  | { kind: 'released'; missionId: string; freedWorkers: number }

interface Waiting {
  missionId: string
  workers: number
}

export class Scheduler {
  private readonly maxWorkers: number
  private readonly admitted = new Map<string, number>() // missionId -> workers
  private readonly waiting: Waiting[] = [] // FIFO; head admitted first
  private readonly notify: (change: AdmissionChange) => void

  constructor(
    maxConcurrentWorkers = DEFAULT_MAX_CONCURRENT_WORKERS,
    notify: (change: AdmissionChange) => void = () => undefined,
  ) {
    this.maxWorkers = Math.max(1, Math.floor(maxConcurrentWorkers))
    this.notify = notify
  }

  get capacity(): number {
    return this.maxWorkers
  }

  get inFlight(): number {
    let n = 0
    for (const w of this.admitted.values()) n += w
    return n
  }

  get waitingList(): readonly string[] {
    return this.waiting.map((w) => w.missionId)
  }

  private hasCapacity(workers: number): boolean {
    return this.inFlight + workers <= this.maxWorkers
  }

  /**
   * Admit a mission for its build stage. Returns 'admitted' immediately when
   * capacity fits AND no earlier mission is waiting; otherwise the mission
   * joins the FIFO queue (a later mission cannot cut ahead of a waiter).
   */
  admit(missionId: string, workers: number): 'admitted' | 'queued' | 'already' {
    if (this.admitted.has(missionId)) return 'already'
    const w = Math.min(Math.max(1, Math.floor(workers)), this.maxWorkers)
    if (this.waiting.length === 0 && this.hasCapacity(w)) {
      this.admitted.set(missionId, w)
      this.notify({ kind: 'admitted', missionId })
      return 'admitted'
    }
    if (!this.waiting.some((x) => x.missionId === missionId)) {
      this.waiting.push({ missionId, workers: w })
    }
    return 'queued'
  }

  /** Release a mission's capacity (terminal, cancelled, or paused);
   *  the tick's promote loop hands the freed slots to the queue head. */
  release(missionId: string): number {
    const w = this.admitted.get(missionId)
    if (w === undefined) {
      const i = this.waiting.findIndex((x) => x.missionId === missionId)
      if (i !== -1) this.waiting.splice(i, 1)
      return 0
    }
    this.admitted.delete(missionId)
    this.notify({ kind: 'released', missionId, freedWorkers: w })
    return w
  }

  /** True while the mission holds admission. */
  isAdmitted(missionId: string): boolean {
    return this.admitted.has(missionId)
  }

  /** True while the mission waits for capacity. */
  isWaiting(missionId: string): boolean {
    return this.waiting.some((x) => x.missionId === missionId)
  }

  /**
   * Remove a mission from the waiting queue without touching admitted
   * capacity: used when a mission becomes blocked (pause requested) while
   * queued — it must not be handed a slot it cannot use, but its in-flight
   * work may still land, so held capacity is not freed until the block is
   * confirmed (release()).
   */
  dequeue(missionId: string): void {
    const i = this.waiting.findIndex((x) => x.missionId === missionId)
    if (i !== -1) this.waiting.splice(i, 1)
  }

  /** The missions currently holding admission (tests and surfaces). */
  get admittedList(): readonly string[] {
    return [...this.admitted.keys()]
  }

  /**
   * Promote the head of the waiting queue — and only the head — once the
   * freed capacity fits it. Strict FIFO: a later, smaller waiter can never
   * jump an earlier, larger one (§25.8), even when it would fit; capacity
   * must not reorder the queue. Call after a release or config change;
   * returns the promoted mission or null.
   */
  promoteNext(): string | null {
    const next = this.waiting[0]
    if (next === undefined || !this.hasCapacity(next.workers)) return null
    this.waiting.shift()
    this.admitted.set(next.missionId, next.workers)
    this.notify({ kind: 'admitted', missionId: next.missionId })
    return next.missionId
  }
}
