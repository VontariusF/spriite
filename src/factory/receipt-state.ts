/** Receipt state contains no execution grant, task, provider preference or credentials. */
export interface DeliveryAttempt {
  sessionId: string
  text: string
  beforeMessageIds: string[] | null
}
export interface ReceiptRecord {
  sessionId: string
  /** A tombstone prevents stale UI snapshots from resurrecting resolved holds. */
  attempt: DeliveryAttempt | null
}
export interface WatchReceiptState {
  records: ReceiptRecord[]
  blocked: string | null
}
export const MAX_RECEIPT_SESSIONS = 128
export const MAX_RECEIPT_CHARS = 2_000_000
export function receiptSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value)
}
/** Damaged known-session records become non-reconcilable holds, never absence. */
export function decodeDeliveryAttempt(value: unknown): DeliveryAttempt | null {
  if (!value || typeof value !== 'object') return null
  const d = value as Partial<DeliveryAttempt>
  if (!receiptSessionId(d.sessionId)) return null
  const validText = typeof d.text === 'string' && d.text.trim() !== '' && d.text.length <= 160_000
  return {
    sessionId: d.sessionId,
    text: validText ? d.text! : 'Previous request (receipt record damaged; verify in Factory)',
    beforeMessageIds: validText && Array.isArray(d.beforeMessageIds) && d.beforeMessageIds.length <= 2000 &&
      d.beforeMessageIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256)
      ? [...d.beforeMessageIds] : null,
  }
}
export function decodeWatchReceipts(raw: string | null): WatchReceiptState {
  if (raw === null) return { records: [], blocked: null }
  const blocked = (): WatchReceiptState => ({ records: [], blocked: 'Receipt storage is damaged or exceeds its safety limit. Sending is held.' })
  if (raw.length > MAX_RECEIPT_CHARS) return blocked()
  let value: unknown
  try { value = JSON.parse(raw) } catch { return blocked() }
  if (!value || typeof value !== 'object') return blocked()
  const data = value as { version?: unknown; records?: unknown; deliveryAttempts?: unknown }
  const legacy = data.version === undefined && Array.isArray(data.deliveryAttempts)
  const rows = legacy ? data.deliveryAttempts : data.version === 1 ? data.records : null
  if (!Array.isArray(rows) || rows.length > MAX_RECEIPT_SESSIONS) return blocked()
  const records = new Map<string, ReceiptRecord>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') return blocked()
    const r = row as { sessionId?: unknown; attempt?: unknown }
    if (!receiptSessionId(r.sessionId) || records.has(r.sessionId)) return blocked()
    const nested = r.attempt && typeof r.attempt === 'object' ? r.attempt as Partial<DeliveryAttempt> : null
    const attempt = !legacy && r.attempt === null ? null
      : decodeDeliveryAttempt(legacy ? row : nested?.sessionId === r.sessionId
        ? nested : { sessionId: r.sessionId })
    if (attempt === null && (legacy || r.attempt !== null)) return blocked()
    records.set(r.sessionId, { sessionId: r.sessionId, attempt })
  }
  return { records: [...records.values()], blocked: null }
}
