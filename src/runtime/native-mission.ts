/**
 * Independent companion actor. Only broker prepare/observe/commands exist
 * here: no RealOrchestrator, workers, reviewer, repair, PR or summary turn.
 */
import type { EngineView } from '../factory/view'
import type { ChatWho } from '../domain/speaker'
import type { Mission, MissionPhase, SpriiteState } from '../domain/types'
import { draftEvent, type EventDraft } from '../domain/events'
import { mintId } from '../domain/ids'
import type { MissionStore } from '../state/mission-store'
import type { NativeAnswer, NativeBrokerClient, NativeCommand, NativeCommandReceipt,
  NativeIntent, NativeSnapshot } from '../native/protocol'
import { decodeNativeAnswer, decodeNativeCache, decodeNativeCapabilities, decodeNativeSnapshot,
  decodeNativeReceipt, type NativeMissionCache } from '../native/decode'
import { NativeBrokerError } from '../native/client'
import { NATIVE_FEATURE_STATUS_WORD, nativeArtifactsVerified, nativeEvaluating, nativeFeatureCounts, nativeFeatureReport,
  nativeFeatureTally, nativePresentation, nativeProviderSummary, nativeTerminalCopy } from '../native/presentation'
import type { NativeFeature } from '../native/protocol'
import { constrainNativeDelivery, deliveryLine, usageLine } from '../native/delivery'
import type { ActionOutcome } from './mission'
import { getTextWidth, pxTruncate } from '@evenrealities/pretext'
import { BUDGETS, fitsSingleLine, fitsWrappedLines } from '../scenes/validate'
import type { MilestoneMark, SceneAction, SceneProgress, SpritePose } from '../scenes/types'
import { COPY, buildTitle } from '../factory/copy'
import { SELECTION_ROW_W, SELECTION_VISIBLE_ROWS } from '../render/layout'

const POLL_MS = 5000
const FRESH_MS = 30000
const FINALIZATION_MS = 120000
const STORAGE_HOLD = 'Local save failed; native updates paused. Restart Spriite to reload saved state.'
const emptyCapabilities = () => ({
  protocolVersion: 1 as const, qualificationId: null, transportVersion: 'unqualified',
  qualified: false, launch: false, rootAttention: false, childAttention: false,
  recoverAttention: false, pause: false, resume: false, cancel: false,
})
export function heldNativeSnapshot(intent: NativeIntent, reason: string): NativeSnapshot {
  return {
    protocolVersion: 1, backend: 'factory_native', missionId: intent.missionId, ownerId: intent.ownerId,
    scopeRevision: intent.scopeRevision, brokerSeq: 0, state: 'held', control: 'running', binding: null,
    capabilities: emptyCapabilities(), attention: [], features: [], history: [], commands: [],
    lastObservedAt: null, completeness: 'unknown', holdReason: reason, finalization: null,
  }
}
function fit(text: string, width: number, lines = 1): string {
  // 1000 UTF-16 units overflow every HUD budget, so the cut always truncates visibly.
  const clean = (text.length > 1000 ? `${head(text, 1000)}…` : text).replace(/\s+/g, ' ').trim()
  if (fitsWrappedLines(clean, width, lines)) return clean
  let budget = width * lines
  let out = pxTruncate(clean, budget)
  while (!fitsWrappedLines(out, width, lines) && budget > 16) {
    budget *= 0.8
    out = pxTruncate(clean, budget)
  }
  return out
}
/** The context line's right half, cut to its 240 px budget. */
function fitDetail(text: string): string {
  return fitsSingleLine(text, BUDGETS.contextDetail.width) ? text : pxTruncate(text, BUDGETS.contextDetail.width)
}
// Glasses selection rows are single clipped lines scrolled one ring tick at a
// time; a v2 plan can carry ~64KB of text, so only a bounded head is shown
// and the full text stays on the phone request panel.
const DETAIL_ROW_W = SELECTION_ROW_W - getTextWidth('> ')
const DETAIL_TEXT_ROWS = SELECTION_VISIBLE_ROWS * 5
const FEATURE_ROWS = SELECTION_VISIBLE_ROWS * 8
const DETAIL_MORE = 'More text: read the full request on the phone.'
// Measurement cost grows with input, so text is cut to a fixed head before
// splitting or measuring; no glasses row can show more than this anyway.
const DETAIL_CHARS_PER_ROW = 200
const WORD_MEASURE_MAX = 200
const ROW_CHARS_MAX = 300
/** UTF-16 head without a split surrogate pair. */
function head(text: string, max: number): string {
  if (text.length <= max) return text
  const code = text.charCodeAt(max - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}
const graphemeSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
function graphemes(word: string): string[] {
  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(word), s => s.segment) : Array.from(word)
}
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff
const lastChar = (s: string) => s.slice(s.length > 1 && isLowSurrogate(s.charCodeAt(s.length - 1)) ? -2 : -1)
const firstChar = (s: string) => String.fromCodePoint(s.codePointAt(0)!)
/**
 * pretext sums per-codepoint advances, each kerned against the next
 * codepoint, so joining two measured strings only changes the advance at
 * the seam. Wrapping then measures each piece once instead of re-measuring
 * every growing row candidate.
 */
function rowMeter() {
  const cache = new Map<string, number>()
  const width = (s: string): number => {
    let w = cache.get(s)
    if (w === undefined) { w = getTextWidth(s); cache.set(s, w) }
    return w
  }
  const join = (a: string, wa: number, b: string, wb: number): number => {
    if (!a || !b) return wa + wb
    const l = lastChar(a), f = firstChar(b)
    return wa + wb + width(l + f) - width(l) - width(f)
  }
  return { width, join }
}
type RowMeter = ReturnType<typeof rowMeter>
/** Appends `line` as rows of at most DETAIL_ROW_W; returns false if `max` cut it short. */
function wrapRows(line: string, rows: string[], max: number, m: RowMeter): boolean {
  let current = ''
  let cw = 0
  const spaceW = m.width(' ')
  for (const word of line.split(' ')) {
    if (rows.length >= max) return false
    if (word.length <= WORD_MEASURE_MAX) {
      const ww = m.width(word)
      if (current) {
        const w = m.join(current, cw, ` ${word}`, m.join(' ', spaceW, word, ww))
        if (w <= DETAIL_ROW_W) { current = `${current} ${word}`; cw = w; continue }
        rows.push(current); current = ''; cw = 0
        if (rows.length >= max) return false
      }
      if (ww <= DETAIL_ROW_W) { current = word; cw = ww; continue }
    } else if (current) {
      // Overlong words start a fresh row rather than measuring a huge candidate.
      rows.push(current); current = ''; cw = 0
      if (rows.length >= max) return false
    }
    // A word wider than a row (CJK without spaces, URLs, emoji runs) breaks
    // between graphemes so no text is silently dropped.
    for (const g of graphemes(word)) {
      const gw = m.width(g)
      const w = m.join(current, cw, g, gw)
      if (!current || w <= DETAIL_ROW_W) { current += g; cw = w; continue }
      rows.push(current)
      if (rows.length >= max) return false
      current = g; cw = gw
    }
  }
  if (current) {
    if (rows.length >= max) return false
    rows.push(current)
  }
  return true
}
/** Plan/permission text as at most `max` single-line rows, plus a phone pointer if any text is omitted. */
export function nativeDetailRows(text: string, max = DETAIL_TEXT_ROWS): string[] {
  const rows: string[] = []
  const meter = rowMeter()
  const cut = head(text, max * DETAIL_CHARS_PER_ROW)
  let omitted = cut.length < text.length
  const lines = cut.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  for (const line of lines) {
    if (!wrapRows(line, rows, max + 1, meter) || rows.length > max) { omitted = true; break }
  }
  return omitted ? [...rows.slice(0, max), DETAIL_MORE] : rows
}
/** Bounded single selection row; the renderer clips by width, this bounds measuring cost. */
function boundedRow(text: string): string {
  const cut = head(text, ROW_CHARS_MAX * 2)
  const clean = cut.replace(/\s+/g, ' ').trim()
  return clean.length > ROW_CHARS_MAX || cut.length < text.length ? `${head(clean, ROW_CHARS_MAX)}…` : clean
}
function featureRow(f: NativeFeature): string {
  return boundedRow(`${NATIVE_FEATURE_STATUS_WORD[f.status]} · ${f.milestone ? `${f.milestone}: ` : ''}${f.description}`)
}
/** Most bar segments drawn; longer feature lists are shown proportionally. */
const BAR_SEGMENTS_MAX = 12
/** The HUD context line's left half (HudRun 'CHECKOUT FLOW'). */
const HUD_TITLE_W = 260
/**
 * HudRun/HudDone's segmented bar from the features Factory reports. A
 * provider report is not verified acceptance, so a reported-complete
 * feature is drawn dotted ("in review": reported, not verified) and only
 * counts as solid done once the outcome is verified (listed artifact
 * evidence verified, or the broker's delivery merged after checks passed).
 * Nothing reported, no bar.
 */
export function nativeProgress(features: readonly NativeFeature[], verified: boolean): SceneProgress | null {
  const total = features.length
  if (!total) return null
  const reported = features.filter(f => f.status === 'completed').length
  const mark: MilestoneMark = verified ? 'done' : 'review'
  const n = Math.min(total, BAR_SEGMENTS_MAX)
  const filled = total <= BAR_SEGMENTS_MAX ? -1 : Math.round((reported * n) / total)
  const milestones: MilestoneMark[] = total <= BAR_SEGMENTS_MAX
    ? features.map((f): MilestoneMark => f.status === 'completed' ? mark : 'todo')
    : Array.from({ length: n }, (_, i): MilestoneMark => i < filled ? mark : 'todo')
  const share = Math.round((reported * 100) / total)
  return {
    acceptedWeight: verified ? share : 0,
    pendingReviewWeight: verified ? 0 : share,
    totalWeight: 100,
    planRevision: 1,
    milestones,
  }
}
/**
 * The MotionLab moment for a native mission's card: a waiting question is
 * Asking, a paused build Paused, Factory coding Building, Factory evaluating
 * Checking, a local save failure Blocked, and a stale broker observation
 * (the host link dropped) Offline, a finished one included. A finished build
 * Celebrates only once it landed (verified or merged, "a milestone or build
 * lands"); while its PR and checks are still out it is Checking, and an
 * undelivered or unverified finish is Blocked. Idle is only for nothing
 * needing the owner.
 */
export function nativePose(s: NativeSnapshot, o: { evaluating: boolean; storageBroken: boolean; linkFresh: boolean; delivered: boolean }): SpritePose {
  if (o.storageBroken) return 'blocked'
  if (s.attention.some(a => a.state !== 'resolved')) return 'asking'
  if (s.control === 'cancelled') return 'idle'
  if (!o.linkFresh) return 'offline'
  if (s.state === 'completed') {
    if (o.delivered) return 'celebrate'
    const step = s.delivery?.step
    if (step === 'pushed' || step === 'pr_open' || step === 'checks_pending') return 'checking'
    if (!s.delivery && (!s.finalization || s.finalization.state === 'pending')) return 'checking'
    return 'blocked'
  }
  if (s.control === 'paused' || s.state === 'paused') return 'paused'
  if (o.evaluating) return 'checking'
  if (s.state === 'running' || s.state === 'orchestrator_turn') return 'building'
  if (s.state === 'planning') return 'thinking'
  return 'idle'
}
function featureRows(features: readonly NativeFeature[]): string[] {
  const rows = features.slice(0, FEATURE_ROWS).map(featureRow)
  return features.length > FEATURE_ROWS
    ? [...rows, `${features.length - FEATURE_ROWS} more on the phone.`] : rows
}
/** HUD status tally that keeps every shown count inside the one-line budget. */
function nativeStatusLine(stateLabel: string, c: ReturnType<typeof nativeFeatureCounts>): string {
  const fits = (s: string) => getTextWidth(s) <= BUDGETS.status.width
  const tally = nativeFeatureTally(c)
  const compact = [`${c.done}/${c.total} done`, c.unmet ? `${c.unmet} unmet` : '',
    c.cancelled ? `${c.cancelled} dropped` : ''].filter(Boolean).join(' · ')
  return [`${stateLabel} · ${tally}`, tally, compact].find(fits) ?? compact
}
/**
 * Approval is known locally when this actor sent a non-cancel outcome for
 * the most recently resolved plan proposal; plan checks only exist after
 * approval, so reported features also count.
 */
function planApprovedIn(cache: NativeMissionCache): boolean {
  const s = cache.snapshot
  if (s.features.length) return true
  const proposal = s.attention.filter(a => a.kind === 'proposal' && a.state === 'resolved')
    .sort((x, y) => Date.parse(x.resolvedAt ?? '') - Date.parse(y.resolvedAt ?? '')).at(-1)
  if (!proposal) return false
  return cache.pendingWrites.some(({ command: c, receipt }) => c.kind === 'answer' && receipt.state !== 'rejected' &&
    c.answer?.attentionId === proposal.attentionId && c.answer.revision === proposal.revision &&
    c.answer.selectedOption !== undefined && c.answer.selectedOption !== 'cancel')
}
function phaseOf(s: NativeSnapshot, planApproved: boolean): MissionPhase {
  if (s.control === 'cancelled') return 'cancelled'
  if (s.state === 'completed') return 'completed'
  if (s.attention.some(a => a.state !== 'resolved')) return 'awaiting_decision'
  if (s.state === 'running' || s.state === 'orchestrator_turn' || nativeEvaluating(s, planApproved)) return 'building'
  return s.state === 'held' ? 'received' : 'planning'
}
function unsettled(c: NativeCommandReceipt): boolean {
  return ['prepared', 'invoked', 'unknown'].includes(c.state)
}
export interface NativeMissionActorDeps {
  missionId: string
  intent: NativeIntent
  store: MissionStore<SpriiteState>
  client: NativeBrokerClient | null
  emitView: (missionId: string, view: EngineView) => void
  launchPermitted: () => boolean
  now?: () => number
}
export class NativeMissionActor {
  readonly backend = 'factory_native' as const
  readonly missionId: string
  private readonly deps: NativeMissionActorDeps
  private readonly now: () => number
  private cache: NativeMissionCache
  private chain: Promise<unknown> = Promise.resolve()
  private busy = false
  /** Covers both queued and running reads, set before touching the chain. */
  private readScheduled = false
  private fresh = false
  private lastReadAt = 0
  private nextReadAt = 0
  private disposed = false
  /** The detail view the owner opened; a different current target shows the scene instead. */
  private detail: string | null = null
  private viewSeq = 0
  private refused = false
  private storageReported = false
  constructor(deps: NativeMissionActorDeps) {
    this.deps = deps
    this.missionId = deps.missionId
    this.now = deps.now ?? Date.now
    const raw = deps.store.current.engineSnapshots?.[deps.missionId]
    const decoded = decodeNativeCache(raw)
    this.refused = raw !== undefined && decoded === null
    this.cache = decoded ?? {
      nativeCacheVersion: 1, backend: 'factory_native',
      snapshot: heldNativeSnapshot(deps.intent, this.refused ? 'Native cache quarantined' : 'Fresh scope and High-autonomy approval required'),
      pendingWrites: [], prepareReceipt: null, finalizationDeadline: null, lastClientObservedAt: null, imported: false,
      observationBlock: null, localHoldReason: null,
    }
    this.cache.snapshot = constrainNativeDelivery(this.cache.snapshot, deps.intent.policy)
    // Crash after invocation is uncertainty, not a replayable queued write.
    this.cache.pendingWrites = this.cache.pendingWrites.map(x => ({
      ...x, receipt: unsettled(x.receipt) ? { ...x.receipt, state: 'unknown', reason: 'Reconcile prior invocation; do not resend' } : x.receipt,
    }))
    if (this.cache.prepareReceipt && unsettled(this.cache.prepareReceipt)) {
      this.cache.prepareReceipt = { ...this.cache.prepareReceipt, state: 'unknown', reason: 'Reconcile launch; do not prepare again' }
    }
  }
  get snapshot(): NativeSnapshot { return structuredClone(this.visible) }
  // A broken store refuses every later commit until relaunch, so the last
  // cached snapshot would otherwise read as live and answerable.
  private get storageBroken() { return this.deps.store.durability === 'broken' }
  private get visible(): NativeSnapshot {
    return this.storageBroken ? { ...this.cache.snapshot, holdReason: STORAGE_HOLD } : this.cache.snapshot
  }
  get presentation() { return nativePresentation(this.snapshot, this.hasUnconfirmedDelivery, planApprovedIn(this.cache)) }
  get restoreRefused() { return this.refused }
  get hasNavigationLayer() { return this.detail !== null && this.detail === this.detailTarget() }
  get missionRecord(): Mission | null { return this.deps.store.current.missions.find(m => m.missionId === this.missionId) ?? null }
  get hasPendingDecision() { return this.cache.snapshot.attention.some(a => a.state !== 'resolved') }
  /** v1 does not qualify revisioned follow-up scope/criteria authority. */
  get followupReady() { return false }
  get hasUnconfirmedDelivery() {
    return !!(this.cache.prepareReceipt && unsettled(this.cache.prepareReceipt)) ||
      this.cache.pendingWrites.some(x => unsettled(x.receipt)) ||
      this.cache.snapshot.attention.some(a => a.state === 'answer_unknown') ||
      this.cache.snapshot.commands.some(unsettled)
  }
  get observationPending() {
    const s = this.cache.snapshot
    return this.hasPendingDecision || this.hasUnconfirmedDelivery ||
      (s.state === 'completed' && (!s.finalization || s.finalization.state === 'pending')) ||
      (s.state === 'completed' && s.control !== 'cancelled' && this.deps.intent.policy.allowPush &&
        (!s.delivery || ['pushed', 'pr_open', 'checks_pending'].includes(s.delivery.step)))
  }
  start(): boolean {
    this.emit()
    // Boot is observe/reconcile only, including imported and unknown starts.
    if (!this.refused) this.requestObservation(true)
    return !this.refused
  }
  async prepare(): Promise<void> {
    return this.schedule(async () => {
      if (this.cache.prepareReceipt || this.refused || this.cache.imported) return
      const intent = this.deps.intent
      if (!intent.scopeApproved || !intent.highAutonomyApproved) {
        await this.hold('Fresh scope and High-autonomy approval required')
        return
      }
      if (!this.deps.client || !this.deps.launchPermitted()) { await this.hold('Native launch unavailable or policy held'); return }
      try {
        const capabilities = decodeNativeCapabilities(await this.deps.client.capabilities())
        if (!capabilities?.qualified || !capabilities.launch || !capabilities.qualificationId ||
          !capabilities.rootAttention || !capabilities.childAttention || !capabilities.recoverAttention) {
          await this.hold('Native provider lifecycle is not qualified'); return
        }
      } catch { await this.hold('Native capability observation unavailable'); return }
      if (!this.deps.launchPermitted()) { await this.hold('Native policy held'); return }
      this.cache.prepareReceipt = { commandId: intent.commandId, state: 'invoked', reason: null }
      if (!await this.persist([])) return // receipt must commit before transport
      if (!this.deps.launchPermitted()) {
        this.cache.prepareReceipt = { commandId: intent.commandId, state: 'rejected', reason: 'Native launch barrier changed before invocation' }
        await this.hold('Native policy held')
        return
      }
      try {
        const observed = await this.deps.client.prepare(structuredClone(intent))
        if (!await this.acceptObservation(observed)) throw new NativeBrokerError('unknown', 'Invalid native prepare response')
        this.cache.prepareReceipt = { commandId: intent.commandId, state: 'confirmed', reason: null }
      } catch (error) {
        this.cache.prepareReceipt = { commandId: intent.commandId,
          state: error instanceof NativeBrokerError && error.outcome === 'rejected' ? 'rejected' : 'unknown',
          reason: 'Native launch response unavailable; reconcile before any further action' }
        this.fresh = false
      }
      await this.persist([this.event(this.cache.prepareReceipt?.state === 'confirmed' ? 'dispatch_confirmed' : 'dispatch_uncertain', { native: true, commandId: intent.commandId,
        state: this.cache.prepareReceipt?.state })])
      this.emit()
    })
  }
  tick(now = this.now()): void {
    if (this.disposed || this.refused || this.busy || this.readScheduled || now < this.nextReadAt) return
    if ((this.cache.snapshot.state === 'completed' || this.cache.snapshot.control === 'cancelled') && !this.observationPending) return
    this.requestObservation()
  }
  async flush(): Promise<void> { await this.chain }
  dispose(): void { this.disposed = true; this.readScheduled = false }
  configure(_settings: unknown): void { /* frozen intent, URL and binding */ }
  private schedule<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work)
    this.chain = next.catch(() => {})
    return next
  }
  private requestObservation(persistBeforeRead = false): void {
    if (this.disposed || this.refused || this.readScheduled) return
    this.readScheduled = true
    void this.schedule(async () => {
      try {
        if (this.disposed) return
        if (persistBeforeRead) await this.persist([])
        await this.observe()
      } finally { this.readScheduled = false }
    })
  }
  private event(type: Parameters<typeof draftEvent>[0], payload: Record<string, unknown>): EventDraft {
    return draftEvent(type, { ...payload, backend: this.backend },
      { entityId: this.deps.store.current.entity.entityId, missionId: this.missionId })
  }
  private async persist(events: EventDraft[]): Promise<boolean> {
    const cache = structuredClone(this.cache)
    const snap = cache.snapshot
    const result = await this.deps.store.commit(s => {
      const idx = s.missions.findIndex(m => m.missionId === this.missionId)
      if (idx < 0 || s.missions[idx].config.executionBackend !== 'factory_native') return null
      const missions = [...s.missions]
      missions[idx] = {
        ...missions[idx], phase: phaseOf(snap, planApprovedIn(cache)),
        control: snap.control === 'cancelled' ? 'cancel_requested' : snap.control,
        freshness: this.fresh && this.brokerObservationFresh() ? snap.completeness === 'complete' ? 'current' : 'unknown' : 'stale',
        lastObservedAt: cache.lastClientObservedAt ?? missions[idx].lastObservedAt, updatedAt: new Date(this.now()).toISOString(),
      }
      return { state: { ...s, missions, engineSnapshots: { ...s.engineSnapshots, [this.missionId]: cache } }, events }
    })
    return result.ok === true
  }
  private async hold(reason: string) {
    this.cache.localHoldReason = reason
    this.cache.snapshot = { ...this.cache.snapshot, holdReason: reason }
    await this.persist([this.event('provider_connectivity_changed', { kind: 'native_hold', reason })])
    this.emit()
  }
  private async observationFailed(kind: NonNullable<NativeMissionCache['observationBlock']>['kind'], reason?: string) {
    this.fresh = false
    const backup = this.cache
    const event = this.cache.observationBlock?.kind === kind ? null :
      this.event('provider_connectivity_changed', { kind, recoveryDomain: 'native_observation' })
    this.cache = { ...this.cache,
      snapshot: reason ? { ...this.cache.snapshot, holdReason: reason } : this.cache.snapshot,
      observationBlock: event ? { kind, eventId: event.eventId } : this.cache.observationBlock }
    if (!await this.persist(event ? [event] : [])) this.cache = backup
  }
  private async observe(): Promise<void> {
    if (this.disposed || !this.deps.client || this.refused) return
    if (this.storageBroken) {
      // Keep the poll backoff while storage is broken; otherwise every
      // supervisor tick re-schedules this no-op observation.
      this.nextReadAt = this.now() + POLL_MS
      this.fresh = false
      if (!this.storageReported) { this.storageReported = true; this.emit() }
      return
    }
    this.busy = true
    this.nextReadAt = this.now() + POLL_MS
    try {
      const raw = await this.deps.client.observe(this.missionId, this.deps.intent.ownerId)
      if (this.disposed) return
      if (!await this.acceptObservation(raw) && !this.storageBroken) {
        await this.observationFailed('native_observation_quarantined',
          'Native observation quarantined: identity, revision or nested data mismatch')
      }
    } catch {
      if (!this.disposed) await this.observationFailed('native_observation_unavailable')
    } finally { this.busy = false; this.emit() }
    if (this.disposed) return
    // Bounded read-only finalization: no new provider turn, PR or review.
    if (this.cache.snapshot.state === 'completed' &&
      this.cache.finalizationDeadline && this.now() >= Date.parse(this.cache.finalizationDeadline) &&
      (!this.cache.snapshot.finalization || this.cache.snapshot.finalization.state === 'pending')) {
      this.cache.snapshot.finalization = { state: 'incomplete', summary: this.cache.snapshot.finalization?.summary ?? null,
        reason: 'Read-only evidence collection deadline elapsed', evidence: this.cache.snapshot.finalization?.evidence ?? [] }
      await this.persist([this.event('native_finalization_changed', { nativeFinalization: 'incomplete', readOnly: true })])
      this.emit()
    }
  }
  private async acceptObservation(raw: unknown): Promise<boolean> {
    const decoded = decodeNativeSnapshot(raw)
    const snap = decoded ? constrainNativeDelivery(decoded, this.deps.intent.policy) : null
    const prev = this.cache.snapshot
    const intent = this.deps.intent
    if (!snap || snap.missionId !== this.missionId || snap.ownerId !== intent.ownerId ||
      snap.scopeRevision !== intent.scopeRevision || snap.brokerSeq < prev.brokerSeq ||
      (snap.binding && (snap.binding.machineId !== intent.workspace.machineId ||
        snap.binding.cwd !== intent.workspace.cwd || snap.binding.repository !== intent.workspace.repository ||
        snap.binding.baseRef !== intent.workspace.baseRef ||
        (intent.workspace.baseSha && snap.binding.baseSha !== intent.workspace.baseSha))) ||
      (prev.binding && JSON.stringify(prev.binding) !== JSON.stringify(snap.binding))) return false
    if (snap.attention.some(a => a.state !== 'resolved' &&
      (a.machineId !== intent.workspace.machineId || !snap.binding))) return false
    const events: EventDraft[] = []
    // Missing rows are never matching resolution evidence. Preserve the
    // request even if a server labels its incomplete queue "complete".
    const missing = prev.attention.filter(a => a.state !== 'resolved' && !snap.attention.some(n => n.attentionId === a.attentionId))
    if (missing.length) { snap.attention.push(...missing); snap.completeness = 'gap' }
    for (const a of snap.attention) {
      const old = prev.attention.find(x => x.attentionId === a.attentionId)
      if (old && (a.revision < old.revision || (a.revision === old.revision && a.payloadHash !== old.payloadHash))) return false
      if (old && old.state !== 'resolved' && a.state === 'resolved' &&
        (old.requestId !== a.requestId || old.revision !== a.revision || old.payloadHash !== a.payloadHash)) return false
      if ((!old || old.revision !== a.revision || old.requestId !== a.requestId) && a.state !== 'resolved') {
        events.push(this.event('decision_opened', { decisionId: a.attentionId, revision: a.revision, nativeKind: a.kind }))
      } else if (old && old.state !== 'resolved' && a.state === 'resolved' &&
        old.requestId === a.requestId && old.payloadHash === a.payloadHash && old.revision === a.revision) {
        events.push(this.event('decision_answered', { decisionId: a.attentionId, outcome: 'native_resolution_observed' }))
        events.push(this.event('native_attention_resolved', { attentionId: a.attentionId,
          requestId: a.requestId, revision: a.revision, payloadHash: a.payloadHash }))
      } else if (old?.state === 'answer_unknown' && a.state === 'open') a.state = 'answer_unknown'
    }
    if (prev.state !== snap.state) events.push(this.event(snap.state === 'completed' && snap.control !== 'cancelled' ? 'mission_completed' : 'run_observed',
      { nativeState: snap.state, nativeFinalization: snap.finalization?.state ?? null }))
    if (JSON.stringify(prev.features) !== JSON.stringify(snap.features)) {
      const counts = nativeFeatureCounts(snap.features)
      events.push(this.event('native_features_changed', { nativeFeatures: counts.total,
        reportedComplete: counts.done, reportedUnmet: counts.unmet, reportedCancelled: counts.cancelled }))
    }
    if (snap.control !== prev.control) events.push(this.event('native_control_observed', { control: snap.control }))
    const historyById = new Map(prev.history.map(h => [h.id, h]))
    const changedHistory = snap.history.filter(h => {
      const old = historyById.get(h.id)
      return !old || old.text !== h.text || old.at !== h.at || old.who !== h.who
    })
    if (changedHistory.length) events.push(this.event('native_history_observed', {
      entries: changedHistory.length, entryIds: changedHistory.map(h => h.id),
    }))
    if (JSON.stringify(prev.finalization) !== JSON.stringify(snap.finalization) && snap.finalization) {
      events.push(this.event('native_finalization_changed', { nativeFinalization: snap.finalization.state, readOnly: true }))
    }
    if (snap.state === 'completed') {
      if (!this.cache.finalizationDeadline) this.cache.finalizationDeadline = new Date(this.now() + FINALIZATION_MS).toISOString()
      snap.finalization ??= { state: 'pending', summary: null, reason: null, evidence: [] }
    }
    snap.holdReason ??= this.cache.localHoldReason
    let observationBlock = this.cache.observationBlock
    if (snap.completeness !== 'complete') {
      if (observationBlock?.kind !== 'native_observation_gap') {
        const event = this.event('provider_connectivity_changed', { kind: 'native_observation_gap', recoveryDomain: 'native_observation' })
        events.push(event)
        observationBlock = { kind: 'native_observation_gap', eventId: event.eventId }
      }
    } else if (observationBlock && this.brokerObservationFresh(snap)) {
      events.push(this.event('provider_connectivity_changed', {
        kind: 'recovered', recoveryDomain: 'native_observation',
        recoveredKind: observationBlock.kind, recoveredEventId: observationBlock.eventId,
      }))
      observationBlock = null
      // Existing briefing readers coalesce connectivity per mission. Reassert
      // unrelated CURRENT holds after this narrowly attributed recovery, so
      // they cannot be accidentally erased by a successful observation.
      const retainedHold = snap.holdReason || (!this.deps.launchPermitted() ? 'Native policy held' :
        !snap.capabilities.qualified ? 'Native provider lifecycle is not qualified' : null)
      if (retainedHold) events.push(this.event('provider_connectivity_changed', {
        kind: 'native_hold', reason: retainedHold, retainedAfterObservationRecovery: true,
      }))
    }
    // A successful HTTP read must not re-date a stale broker/provider cache.
    const nextWrites = this.cache.pendingWrites.map(x => {
      const receipt = snap.commands.find(c => c.commandId === x.command.commandId)
      return receipt ? { ...x, receipt } : x
    })
    const backup = this.cache
    this.cache = { ...this.cache, snapshot: snap, pendingWrites: nextWrites,
      lastClientObservedAt: new Date(this.now()).toISOString(), observationBlock }
    if (this.cache.prepareReceipt && unsettled(this.cache.prepareReceipt)) {
      this.cache.prepareReceipt = { ...this.cache.prepareReceipt, state: 'confirmed', reason: 'Original job observed' }
    }
    this.fresh = true
    this.lastReadAt = this.now()
    if (!await this.persist(events)) { this.cache = backup; this.fresh = false; return false }
    return true
  }
  private actionable(kind: NativeCommand['kind']): string | null {
    const s = this.cache.snapshot
    if (this.storageBroken) return STORAGE_HOLD
    if (!this.deps.client || !this.fresh || !this.brokerObservationFresh() ||
      this.now() - this.lastReadAt > FRESH_MS || s.completeness !== 'complete') return 'Fresh complete native observation required'
    if (this.hasUnconfirmedDelivery) return 'Native write outcome unresolved'
    if (s.state === 'completed' || s.control === 'cancelled') return 'Native job terminal'
    if (kind !== 'pause' && kind !== 'cancel') {
      if (!this.deps.launchPermitted() || !this.deps.intent.scopeApproved || !this.deps.intent.highAutonomyApproved ||
        !s.capabilities.qualified || s.holdReason) return 'Native scope or policy held'
      if (s.control !== 'running' && !(kind === 'resume' && s.control === 'paused')) return 'Native control held'
    }
    if ((kind === 'pause' || kind === 'resume' || kind === 'cancel') && !s.capabilities[kind]) return 'Native control unavailable'
    return null
  }
  private brokerObservationFresh(snapshot = this.cache.snapshot): boolean {
    const at = snapshot.lastObservedAt
    if (!at) return false
    const age = this.now() - Date.parse(at)
    return age >= -5000 && age <= FRESH_MS
  }
  async answerNative(raw: NativeAnswer): Promise<NativeCommandReceipt> {
    const answer = decodeNativeAnswer(raw)
    if (!answer) return { commandId: '', state: 'rejected', reason: 'Invalid native answer' }
    return this.send('answer', undefined, answer)
  }
  private async send(kind: NativeCommand['kind'], text?: string, answer?: NativeAnswer, finalGate: () => boolean = () => true): Promise<NativeCommandReceipt> {
    const captured = this.cache.snapshot
    const command: NativeCommand = {
      protocolVersion: 1, commandId: mintId('native-command'), missionId: this.missionId, ownerId: this.deps.intent.ownerId,
      kind, expectedScopeRevision: captured.scopeRevision, expectedBrokerSeq: captured.brokerSeq,
      ...(text === undefined ? {} : { text }), ...(answer === undefined ? {} : { answer: structuredClone(answer) }),
    }
    return this.schedule(async () => {
      const reject = (reason: string): NativeCommandReceipt => ({ commandId: command.commandId, state: 'rejected', reason })
      const blocked = this.actionable(kind)
      if (blocked) return reject(blocked)
      const s = this.cache.snapshot
      if (s.brokerSeq !== command.expectedBrokerSeq || s.scopeRevision !== command.expectedScopeRevision) return reject('Stale native action')
      if (answer) {
        const a = s.attention.find(x => x.attentionId === answer.attentionId)
        if (!a || a.state !== 'open' || a.requestId !== answer.requestId || a.sessionId !== answer.sessionId ||
          a.machineId !== answer.machineId || a.revision !== answer.revision || a.payloadHash !== answer.payloadHash ||
          a.kind === 'unsupported') return reject('Stale or unsupported native request')
        if (!s.capabilities.rootAttention || (a.sessionId !== s.binding?.sessionId && !s.capabilities.childAttention) ||
          (this.cache.imported && !s.capabilities.recoverAttention)) return reject('Native attention capability unavailable')
        if (a.kind === 'ask_user') {
          if (answer.selectedOption !== undefined || (answer.cancelled && answer.answers?.length)) return reject('Invalid questionnaire response')
          if (!answer.cancelled && (!answer.answers || answer.answers.length !== a.questions.length ||
            answer.answers.some(x => {
              const q = a.questions.find(q => q.index === x.index)
              // No custom-answer grant is present in v1. Multi-select uses a
              // JSON array of exact raw values; never split fitted labels.
              if (!q) return true
              if (!q.options.length) return x.answer.trim() === ''
              if (!q.multiSelect) return !q.options.some(o => o.value === x.answer)
              try {
                const values = JSON.parse(x.answer)
                return !Array.isArray(values) || !values.length || new Set(values).size !== values.length ||
                  values.some(v => !q.options.some(o => o.value === v))
              } catch { return true }
            }))) return reject('Unbound question index or raw option')
        } else if (answer.answers !== undefined || answer.cancelled !== undefined ||
          answer.selectedOption === 'proceed_edit' ||
          !a.options.some(o => o.value === answer.selectedOption)) return reject('Unbound or unsupported native outcome')
      } else if (kind === 'owner_turn' && this.hasPendingDecision) return reject('Answer the exact native request separately')
      const row: NativeMissionCache['pendingWrites'][number] = {
        command, receipt: { commandId: command.commandId, state: 'invoked', reason: null },
      }
      this.cache.pendingWrites.push(row)
      if (!await this.persist([])) {
        row.receipt = { ...row.receipt, state: 'unknown', reason: 'Local write receipt not durable' }
        return reject('Native command not durably recorded')
      }
      if (!finalGate() || ((kind !== 'pause' && kind !== 'cancel') && !this.deps.launchPermitted())) {
        const receipt = reject('Native command barrier changed before invocation')
        this.cache.pendingWrites = this.cache.pendingWrites.map(x => x.command.commandId === command.commandId ? { command, receipt } : x)
        await this.persist([])
        return receipt
      }
      let receipt: NativeCommandReceipt
      try {
        const decoded = decodeNativeReceipt(await this.deps.client!.command(command))
        receipt = decoded?.commandId === command.commandId ? decoded :
          { commandId: command.commandId, state: 'unknown', reason: 'Native command acknowledgment malformed' }
      } catch (error) {
        receipt = { commandId: command.commandId, state: error instanceof NativeBrokerError && error.outcome === 'rejected' ? 'rejected' : 'unknown',
          reason: 'Native command response unavailable' }
      }
      this.cache.pendingWrites = this.cache.pendingWrites.map(x => x.command.commandId === command.commandId ? { command, receipt } : x)
      // Sent/confirmed is not request closure; only matching observations close.
      if (answer && receipt.state !== 'rejected') {
        this.cache.snapshot.attention = s.attention.map(a => a.attentionId === answer.attentionId ? { ...a, state: 'answer_unknown' } : a)
      }
      if (kind === 'pause' && receipt.state !== 'rejected') this.cache.snapshot.control = 'pause_requested'
      if (kind === 'cancel' && receipt.state !== 'rejected') this.cache.snapshot.control = 'cancel_requested'
      this.fresh = false // transport delivery is not a new provider observation
      await this.persist([this.event(unsettled(receipt) ? 'dispatch_uncertain' : 'dispatch_confirmed',
        { commandId: command.commandId, nativeKind: kind, state: receipt.state })])
      this.nextReadAt = 0
      this.emit()
      return receipt
    })
  }
  handleAction(id: string): ActionOutcome {
    if (['read_native', 'decision_detail', 'explain', 'milestones', 'show_evidence'].includes(id)) { this.detail = this.detailTarget(); this.emit(); return { kind: 'forwarded' } }
    if (id === 'show_builds') return { kind: 'forwarded' }
    const kind = id === 'restart' ? 'cancel' : id
    if (kind === 'pause' || kind === 'resume' || kind === 'cancel') {
      if (this.actionable(kind)) return { kind: 'rejected', reason: 'unknown_action' }
      void this.send(kind)
      return { kind: 'forwarded' }
    }
    return { kind: 'rejected', reason: 'unknown_action' }
  }
  // Keep phone/voice/X drafts rather than optimistically consuming a turn
  // the broker cannot bind to a new frozen scope. Exact answers use the
  // separate request-bound API; ordinary text is never native permission.
  say(_text: string): 'steer' | 'none' { return 'none' }
  steer(_text: string): boolean { return false }
  async sendFollowup(_text: string, _allowed: () => boolean): Promise<'sent' | 'deferred' | 'unknown'> { return 'deferred' }
  declineGate(_text: string): boolean { return false }
  answerDecision(_decisionId: string, _optionId: string): 'missing' { return 'missing' }
  chooseDecisionList(_index: number): 'done' { return 'done' }
  chooseGoalList(_index: number): 'done' { return 'done' }
  chooseList(_index: number): void { /* no inferred native answer */ }
  transcriptGoal(_sec: number): void {}
  voiceGoal(text: string, _sec: number): 'steer' | 'none' { return this.say(text) }
  back(): 'handled' { this.detail = null; this.emit(); return 'handled' }
  talkStatus(): void { this.emit() }
  acceptsGoal(): boolean { return false }
  canPause(): boolean { return !this.actionable('pause') }
  canResume(): boolean { return this.cache.snapshot.control === 'paused' && !this.actionable('resume') }
  canExplain(): boolean { return true }
  chatLog(): Array<{ who: ChatWho; text: string; at: number }> {
    return [...this.cache.snapshot.history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map(h => ({
      who: h.who === 'owner' ? 'you' : h.who === 'factory' ? 'lead' : 'spriite',
      text: h.who === 'factory' && h.text === this.cache.snapshot.finalization?.summary ? nativeProviderSummary(h.text) : h.text,
      at: Date.parse(h.at),
    }))
  }
  factorySessionLink(): string | null {
    const session = this.cache.snapshot.binding?.sessionId
    return session ? `https://app.factory.ai/sessions/${encodeURIComponent(session)}` : null
  }
  nativeQuestionLink(): string | null {
    const session = this.cache.snapshot.attention.find(a => a.state !== 'resolved')?.sessionId
    return session ? `https://app.factory.ai/sessions/${encodeURIComponent(session)}` : null
  }
  private detailTarget(): string | null {
    const s = this.cache.snapshot
    const a = s.attention.find(x => x.state !== 'resolved')
    if (a) return `attention:${a.attentionId}:${a.requestId}:${a.revision}`
    if (s.state === 'completed' || s.control === 'cancelled') return 'terminal'
    return s.features.length ? 'progress' : null
  }
  get currentView(): EngineView {
    const s = this.cache.snapshot
    const pending = s.attention.filter(a => a.state !== 'resolved')
    const a = pending[0]
    const terminal = s.state === 'completed' || s.control === 'cancelled'
    const detail = this.hasNavigationLayer
    const evaluating = nativeEvaluating(s, planApprovedIn(this.cache))
    const counts = nativeFeatureCounts(s.features)
    const tally = counts.total ? [`Reported: ${nativeFeatureTally(counts)}`, ...featureRows(s.features)] : []
    if (detail && a) return {
      type: 'selection', purpose: 'plan_detail', contextLabel: 'Factory Mission', title: fit(head(a.title, ROW_CHARS_MAX * 2), 480),
      items: [...nativeDetailRows(a.details), ...a.questions.map(q => boundedRow(`${q.index}: ${q.question}`)),
        ...a.options.map(o => boundedRow(`${o.label} (${o.value})`))].filter(Boolean),
      pose: 'asking',
    }
    if (detail && terminal) return {
      type: 'selection', purpose: 'evidence', contextLabel: 'Factory Mission', title: 'Native outcome',
      items: [nativeTerminalCopy(s), s.delivery?.prUrl ? `PR: ${s.delivery.prUrl}` : '', s.usage ? usageLine(s.usage) : '',
        nativeProviderSummary(s.finalization?.summary ?? ''),
        ...(s.finalization?.evidence.map(e => `${e.verified ? 'Provider-reported artifact verification' : 'Unverified artifact claim'}: ${e.url}`) ?? []),
        ...tally].filter(Boolean).map(boundedRow),
      pose: 'idle',
    }
    if (detail && tally.length) return {
      type: 'selection', purpose: 'evidence', contextLabel: 'Factory Mission', title: 'Factory-reported progress',
      items: [...tally, 'Provider report only; not verified acceptance.'], pose: 'idle',
    }
    const kind = terminal ? 'final' : pending.length ? 'decision' : s.control === 'paused' || s.state === 'paused' ? 'paused' :
      s.state === 'running' || s.state === 'orchestrator_turn' || evaluating ? 'running' : 'plan'
    const report = nativeFeatureReport(counts)
    const stateLabel = evaluating ? 'evaluating' : s.state.replace(/_/g, ' ')
    const utterance = this.storageBroken ? STORAGE_HOLD : terminal ? nativeTerminalCopy(s) : a ?
      `${a.title || a.questions[0]?.question || 'Factory needs your answer'}. ${pending.length} request${pending.length === 1 ? '' : 's'}; answer on phone.` :
      s.holdReason || (s.state === 'running' ? report || 'Factory Mission: running. No features or checks reported yet.' :
        evaluating ? ['Factory is evaluating; no request to answer.', report].filter(Boolean).join(' ') :
        [`Factory Mission: ${stateLabel}.`, report].filter(Boolean).join(' '))
    const linkFresh = this.fresh && this.brokerObservationFresh()
    const verified = nativeArtifactsVerified(s) || s.delivery?.step === 'merged'
    const progress = nativeProgress(s.features, s.state === 'completed' && s.control !== 'cancelled' && verified)
    const title = this.hudTitle()
    const words = COPY.hud.phaseWords
    const word = kind === 'paused' ? words.paused : kind === 'plan' ? words.planning
      : evaluating ? words.review : words.building
    // HudRun: '<BUILD TITLE>' left, '<PHASE> · N OF M' right (N = features
    // Factory reports done); HudDone: 'DONE'; HudAsk: the asker, then the title.
    // The asker by session: the root (lead) session, or a child (worker) one.
    const contextLabel = kind === 'decision'
      ? (a && s.binding && a.sessionId !== s.binding.sessionId ? COPY.hud.workerAsks : COPY.hud.leadAsks)
      : title
    const contextDetail = kind === 'decision' ? fitDetail(buildTitle(this.deps.intent.goal).toUpperCase())
      : kind === 'final' ? s.control === 'cancelled' ? '' : COPY.hud.doneDetail
        : COPY.hud.phaseDetail(word, counts.done, counts.total)
    return { type: 'scene', scene: {
      schemaVersion: 1, sceneId: `native-${this.missionId}-${this.viewSeq}`, sceneRevision: this.viewSeq,
      stateSequence: s.brokerSeq, missionId: this.missionId, kind,
      spritePose: nativePose(s, { evaluating, storageBroken: this.storageBroken, linkFresh,
        // Landed: merged when the broker delivers, else verified artifacts.
        delivered: s.delivery ? s.delivery.step === 'merged' : nativeArtifactsVerified(s) }),
      contextLabel, contextDetail, utterance: fit(utterance, BUDGETS.utterance.width, BUDGETS.utterance.lines),
      status: fit(this.storageBroken ? 'Last known · not saving' : !this.fresh || !this.brokerObservationFresh() ? 'Last known · reconciling' : terminal ?
        s.control === 'cancelled' ? 'Native cancellation reported' : s.delivery ? deliveryLine(s.delivery) :
          nativeArtifactsVerified(s) ? 'Native artifacts verified' :
          s.finalization?.state === 'pending' || !s.finalization ? 'Evidence collection pending' : 'Evidence incomplete' :
        nativeStatusLine(stateLabel, counts), BUDGETS.status.width),
      progress, actions: this.cardActions(kind, counts.total > 0),
      evidenceIds: s.finalization?.evidence.filter(e => e.verified).map(e => e.id) ?? [],
      generatedAt: new Date(this.now()).toISOString(), transientMs: 0, speaker: 'spriite',
    } }
  }
  /** The build's short title, uppercase as drawn (HudRun 'CHECKOUT FLOW'). */
  private hudTitle(): string {
    const upper = buildTitle(head(this.deps.intent.goal ?? '', 400)).toUpperCase()
    if (!upper) return 'FACTORY MISSION'
    return fitsSingleLine(upper, HUD_TITLE_W) ? upper : pxTruncate(upper, HUD_TITLE_W)
  }
  /**
   * HudRun: ‹ [Pause] Milestones › while running (Resume when paused);
   * HudDone: [Read summary] Next idea Evidence. Message is not offered: a
   * Factory Mission takes no ordinary messages (only exact request answers),
   * so it would never send. Milestones needs reported features; a card with
   * nothing else to offer keeps Builds. Other cards keep Read / Builds.
   */
  private cardActions(kind: string, reported: boolean): SceneAction[] {
    if (kind === 'final') return COPY.real.finalActions.map(a => ({ ...a }))
    if (kind === 'running' || kind === 'paused') {
      const out: SceneAction[] = []
      if (kind === 'paused' ? this.canResume() : this.canPause()) {
        out.push(kind === 'paused' ? { id: 'resume', label: 'Resume', kind: 'command' } : { id: 'pause', label: 'Pause', kind: 'command' })
      }
      if (reported) out.push({ id: 'milestones', label: 'Milestones', kind: 'read_only' })
      if (out.length < 2) out.push({ id: 'show_builds', label: 'Builds', kind: 'read_only' })
      return out
    }
    return [{ id: 'read_native', label: 'Read', kind: 'read_only' }, { id: 'show_builds', label: 'Builds', kind: 'read_only' }]
  }
  private emit(): void {
    if (this.disposed) return
    // A detail opened for one request or report never resurfaces for a later one.
    if (this.detail !== null && this.detail !== this.detailTarget()) this.detail = null
    this.viewSeq++; this.deps.emitView(this.missionId, this.currentView)
  }
}
