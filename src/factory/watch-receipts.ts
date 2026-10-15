import type { KVBackend } from '../state/mission-store'
import {
  decodeWatchReceipts, MAX_RECEIPT_CHARS, MAX_RECEIPT_SESSIONS, receiptSessionId,
  type DeliveryAttempt, type WatchReceiptState,
} from './receipt-state'

/** Independent of AppStore/SDK background snapshots and the selected mission. */
export const WATCH_RECEIPT_KEY = 'spriite.watch-receipts.v1'
export class WatchReceiptStore {
  private current: WatchReceiptState = { records: [], blocked: 'Receipt storage has not been read. Sending is held.' }
  private chain: Promise<void> = Promise.resolve()
  private readonly kv: KVBackend
  constructor(kv: KVBackend) { this.kv = kv }
  async load(): Promise<void> {
    try { this.current = decodeWatchReceipts(await this.kv.get(WATCH_RECEIPT_KEY)) }
    catch { this.current = { records: [], blocked: 'Receipt storage read is unavailable. Sending is held.' } }
  }
  get state(): WatchReceiptState { return this.current }
  private update(sessionId: string, attempt: DeliveryAttempt | null): void {
    if (this.current.blocked) return
    if (!receiptSessionId(sessionId)) {
      this.current.blocked = 'Receipt session cannot be stored safely. Sending is held.'
      return
    }
    const records = this.current.records.filter(r => r.sessionId !== sessionId)
    records.push({ sessionId, attempt })
    if (records.length > MAX_RECEIPT_SESSIONS) {
      this.current.blocked = 'Receipt storage is full. Sending is held.'
      return
    }
    const raw = JSON.stringify({ version: 1, records })
    if (raw.length > MAX_RECEIPT_CHARS || (attempt && attempt.text.length > 160_000)) {
      this.current.blocked = 'Receipt storage exceeds its safety limit. Sending is held.'
      return
    }
    this.current = { records, blocked: null }
    // Capture each mutation; a later clear cannot replace the pre-send hold
    // while its acknowledged write is still in flight.
    this.chain = this.chain.catch(() => undefined).then(async () => {
      if (await this.kv.set(WATCH_RECEIPT_KEY, raw) !== true) throw new Error('Receipt storage write was not acknowledged')
    })
    // Post-dispatch clears are best effort, but flush still observes failure.
    void this.chain.catch(() => undefined)
  }
  dependencies() {
    return {
      receiptState: (): WatchReceiptState => this.current,
      onReceiptMutation: (sessionId: string, attempt: DeliveryAttempt | null): void => this.update(sessionId, attempt),
      beforeSessionDispatch: async (): Promise<void> => {
        if (this.current.blocked) throw Object.assign(new Error(this.current.blocked), { kind: 'storage' })
        try { await this.chain }
        catch { throw Object.assign(new Error('Receipt storage write was not acknowledged; nothing sent'), { kind: 'storage' }) }
      },
    }
  }
}
/** Await recovery before constructing either production detached engine. */
export async function createWatchReceiptDependencies(kv: KVBackend) {
  const store = new WatchReceiptStore(kv)
  await store.load()
  return store.dependencies()
}
