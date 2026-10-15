/**
 * Bridge gateway (spec §9.2 "Even plugin / bridge"). Every bridge call is
 * serialized through one queue and wrapped in a bounded timeout: a flaky BLE
 * hop must never wedge the render pipeline (glasses-ui best practice).
 *
 * Two priority lanes share the single serialized link: text, page, and control
 * calls are 'hi'; bulk image pushes are 'lo'. A waiting 'hi' call is never
 * delayed behind queued image frames, so text and progress updates stay
 * responsive while the sprite animates. Exactly one call is in flight at a
 * time — the glasses link itself stays strictly serial.
 */
import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'

export type CallPriority = 'hi' | 'lo'

/** How long a call that never settles may hold the serial link. */
function hungCeilingMs(timeoutMs: number): number {
  return Math.max(timeoutMs * 3, 15000)
}

interface Task {
  priority: CallPriority
  run: () => Promise<void>
}

export class BridgeGateway {
  private bridge: EvenAppBridge | null = null
  private queue: Task[] = []
  private active = false

  async init(): Promise<EvenAppBridge> {
    this.bridge = await waitForEvenAppBridge()
    return this.bridge
  }

  get raw(): EvenAppBridge {
    if (!this.bridge) throw new Error('bridge used before init')
    return this.bridge
  }

  /**
   * Enqueue one bridge operation. Resolves with the result, or null on error
   * or timeout. The timeout starts only when the op starts (not while it is
   * queued). The caller gets its null at the timeout, but the queue advances
   * only when the op actually settles: a slow transfer that outlives its
   * timeout is still on the link, and starting the next call then would put
   * two in flight (spec §11.5). A host call that never settles releases the
   * queue at a hard ceiling, so one hung call cannot block every later call.
   */
  call<T>(
    op: (b: EvenAppBridge) => Promise<T>,
    label = 'op',
    timeoutMs = 5000,
    priority: CallPriority = 'hi',
  ): Promise<T | null> {
    return new Promise((resolve) => {
      const task: Task = {
        priority,
        run: async () => {
          let timer: ReturnType<typeof setTimeout> | undefined
          const timeout = new Promise<null>((r) => {
            timer = setTimeout(() => {
              console.warn(`[bridge] ${label} timed out after ${timeoutMs}ms`)
              r(null)
            }, timeoutMs)
          })
          // Start the op inside the chain: a synchronous throw (the raw getter
          // before init, an SDK constructor rejecting its input) must resolve
          // null like any other failure, never leave the caller pending.
          const work = Promise.resolve().then(() => op(this.raw)).catch((e) => {
            console.warn(`[bridge] ${label} failed:`, e)
            return null
          })
          try {
            resolve(await Promise.race([work, timeout]))
          } finally {
            clearTimeout(timer)
          }
          // The link stays busy until the op settles (or the hung ceiling).
          let ceiling: ReturnType<typeof setTimeout> | undefined
          const hung = new Promise<void>((r) => {
            ceiling = setTimeout(() => {
              console.warn(`[bridge] ${label} never settled; releasing the link after ${hungCeilingMs(timeoutMs)}ms`)
              r()
            }, hungCeilingMs(timeoutMs))
            ;(ceiling as { unref?: () => void }).unref?.()
          })
          try {
            await Promise.race([work.then(() => undefined), hung])
          } finally {
            clearTimeout(ceiling)
          }
        },
      }
      if (priority === 'hi') {
        // Jump ahead of waiting image pushes, but keep hi-calls in order.
        const i = this.queue.findIndex((t) => t.priority === 'lo')
        if (i === -1) this.queue.push(task)
        else this.queue.splice(i, 0, task)
      } else {
        this.queue.push(task)
      }
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.active) return
    this.active = true
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()
        if (!task) continue
        await task.run()
      }
    } finally {
      this.active = false
    }
  }
}
