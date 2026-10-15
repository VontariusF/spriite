/**
 * The phone activity log's durable copy (spec §1: "When you return, Spriite
 * tells you what changed while you were away"). The feed is a record of what
 * really happened, so it replays exactly the entries that were logged —
 * never an invented "while away" account (spec §22). Stored in the Even
 * app's SDK storage next to (but separate from) keys, preferences, and
 * mission state, through the same serialized bridge.
 */
import type { BridgeGateway } from '../bridge/bridge'

const KEY = 'spriite.feed.v1'

/** One activity row exactly as it was logged: what, how it was labeled, when. */
export interface FeedEntry {
  at: number
  label: string
  text: string
}

/**
 * What the activity log keeps. The in-memory list and the durable copy agree
 * on the cap, so the pill count can never claim rows the owner cannot scroll
 * to, and a reload can never restore more than the card renders.
 */
export const FEED_KEEP = 30

interface StoredFeed {
  v: 1
  entries: FeedEntry[]
}

/**
 * Only shaped rows render: a corrupt row is dropped, never repaired or
 * guessed at (an unreadable log is absence, not a crash).
 */
const sanitize = (raw: unknown): FeedEntry[] => {
  if (!Array.isArray(raw)) return []
  const out: FeedEntry[] = []
  for (const e of raw) {
    if (out.length >= FEED_KEEP) break
    if (
      typeof e !== 'object' || e === null ||
      typeof (e as FeedEntry).at !== 'number' || !Number.isFinite((e as FeedEntry).at) ||
      typeof (e as FeedEntry).label !== 'string' ||
      typeof (e as FeedEntry).text !== 'string'
    ) continue
    out.push({ at: (e as FeedEntry).at, label: (e as FeedEntry).label, text: (e as FeedEntry).text })
  }
  return out
}

/** The §7 feed key: one row's identity is when it happened, its label, and
 *  its text — the same key the archive's feed table and the phone page's
 *  restore union use. */
const feedKey = (e: FeedEntry): string => `${e.at}\u0000${e.label}\u0000${e.text}`

/** Union two lists by that key, newest first, capped at what both ends keep. */
const union = (a: readonly FeedEntry[], b: readonly FeedEntry[]): FeedEntry[] => {
  const byKey = new Map<string, FeedEntry>()
  for (const e of a) byKey.set(feedKey(e), e)
  for (const e of b) byKey.set(feedKey(e), e)
  return [...byKey.values()].sort((x, y) => y.at - x.at).slice(0, FEED_KEEP)
}

export class FeedVault {
  private entries: FeedEntry[] = []
  private readonly gateway: BridgeGateway
  /**
   * True while the boot read never answered: the SDK returns '' for a
   * missing key, so a null from the gateway is a transport failure, not
   * absence. The page's in-memory list then starts empty, and a save that
   * replaced the stored list would quietly drop the log the failed read
   * never saw — the save unions with storage instead until a read answers.
   */
  private unknownRead = false
  private writes: Promise<unknown> = Promise.resolve()
  // Rows the page never restored after a failed boot read. Keep unioning
  // them into later page snapshots, which still may not contain those rows.
  private recovered: FeedEntry[] = []

  constructor(gateway: BridgeGateway) {
    this.gateway = gateway
  }

  async load(): Promise<void> {
    const raw = await this.gateway.call((b) => b.getLocalStorage(KEY), 'getFeed')
    if (raw === null) {
      // A transport failure is not a missing key: retry once, and only an
      // answer may load.
      const retry = await this.gateway.call((b) => b.getLocalStorage(KEY), 'getFeedRetry')
      if (retry === null) {
        this.unknownRead = true
        return
      }
      this.unknownRead = false
      this.take(retry)
      return
    }
    this.unknownRead = false
    if (raw === '') return
    this.take(raw)
  }

  /** Adopt a stored record, whatever rows in it are shaped. */
  private take(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as StoredFeed
      if (parsed?.v === 1) this.entries = sanitize(parsed.entries)
    } catch {
      console.warn('[feed] stored activity unreadable; ignoring')
    }
  }

  /** The restored entries, newest first (the order the card renders in). */
  restore(): FeedEntry[] {
    return this.entries
  }

  /**
   * Write the whole list, once per append. The caller snapshots its list at
   * each append, so the serialized bridge lands writes in append order and
   * the newest write wins. The in-memory record follows only what storage
   * took — the same discipline every vault here follows — so a later reader
   * (the archive mirror's feed source, a restore's union) sees the feed this
   * phone actually holds. A failed write is reported as false and nothing
   * more: the in-memory feed stands, and the page never dies because a log
   * line could not be stored.
   *
   * When the boot read never answered, the incoming list is a subset of what
   * storage may hold: the write unions with the stored log instead of
   * replacing it, so one blip at boot cannot erase the record of what
   * happened while the owner was away (spec §1).
   */
  save(entries: FeedEntry[]): Promise<boolean> {
    const input = sanitize(entries) // snapshot before entering the queue
    const run = this.writes.then(async () => {
      try {
        let recovered = this.recovered
        if (this.unknownRead) {
          const stored = await this.gateway.call((b) => b.getLocalStorage(KEY), 'getFeedMerge')
          if (stored === null) return false
          if (stored !== '') {
            try {
              const parsed = JSON.parse(stored) as StoredFeed
              if (parsed?.v === 1) recovered = union(recovered, sanitize(parsed.entries))
            } catch {
              /* an unreadable stored log is absence, never a crash */
            }
          }
        }
        const next = recovered.length > 0 ? union(recovered, input) : input
        const ok = await this.gateway.call(
          (b) => b.setLocalStorage(KEY, JSON.stringify({ v: 1, entries: next })),
          'setFeed',
        )
        if (ok !== true) return false
        this.entries = next
        this.recovered = recovered
        this.unknownRead = false
        return true
      } catch {
        return false
      }
    })
    this.writes = run.catch(() => undefined)
    return run
  }
}
