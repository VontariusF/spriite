/**
 * The app's engine under `persistent_runtime_v2` (spec §17, §26): the same
 * FactoryEngine surface the HUD and phone already drive, fronting the
 * durable Supervisor.
 *
 * Two parts:
 *  - the lobby, a RealOrchestrator that only ever shows the home list, the
 *    goal list, and the transcript card. It never starts planning: the
 *    moment the owner says "plan it", the goal becomes a durable command
 *    (supervisor.submitCommand) and its own mission actor takes over;
 *  - the focused mission, whose actor's card is what the surfaces show.
 *    Focus is a view choice only. Every mission keeps running whether or not
 *    it is focused (spec §2, §25.7), and actions reach it through the
 *    Supervisor so pause, policy, and capacity gates always apply.
 *
 * The home list lists runtime missions, and opening one focuses its actor.
 * Nothing here ever restores a saved engine snapshot into the lobby: that
 * would put a second orchestrator on the same provider sessions.
 */
import { isChatWho, type ChatWho } from '../domain/speaker'
import type { Mission } from '../domain/types'
import { isTerminalPhase } from '../domain/types'
import { mintId } from '../domain/ids'
import type { EngineView } from '../factory/view'
import type { FactoryEngine } from '../factory/engine'
import type { ProjectsSource, RealOrchestrator, RealSnapshot } from '../factory/real'
import type { InputSource } from '../domain/types'
import type { RuntimeActionOutcome, Supervisor, SubmitReceipt } from './supervisor'
import { COPY, buildName } from '../factory/copy'
import { isBuildDirective, isScopeReviewDirective, isBuildApproval, isBuildCancellation, type ChatBuildDraft } from '../factory/build-intent'
import type { MissionPresentation, NativeAnswer, NativeIntent, NativeSnapshot } from '../native/protocol'
import { legacyPresentation, nativePresentation } from '../native/presentation'
import { destinationRepositoryFrom } from '../intake/x'
import type { RepoMode } from '../pair/types'

/**
 * Where a new goal's mission should build (C8, the Repo board's default
 * "new private repo per idea"). Only the per-idea mode changes anything: a
 * goal that names a GitHub repository builds there, any other goal starts in
 * a new private repository named from the request. X requests keep their own
 * routing (spec: X builds never land in the default repository), and an
 * explicit choice (New repo, a reviewed chat build) is never overridden.
 */
export function perIdeaRouting(
  mode: RepoMode | undefined,
  text: string,
  source: InputSource,
): { newRepository: true } | { repository: string } | null {
  if (mode !== 'per_idea' || source === 'x') return null
  const named = destinationRepositoryFrom(text)
  return named !== null ? { repository: named } : { newRepository: true }
}

/** Why a gated mission action did not run, in the owner's words (null = nothing to say). */
function outcomeReason(outcome: RuntimeActionOutcome): string | null {
  const errors = COPY.real.errors
  switch (outcome.kind) {
    case 'forwarded':
      return null
    case 'held':
      return errors.capacity
    case 'unknown_mission':
      return COPY.real.actionGone
    case 'rejected':
      if (outcome.reason === 'duplicate_pause') return COPY.real.actionPausing
      if (outcome.reason === 'cancelling') return COPY.real.actionStopping
      return null
    case 'dropped':
      if (outcome.reason === 'paused') return errors.paused
      if (outcome.reason === 'cancelling') return COPY.real.actionStopping
      if (outcome.reason === 'terminal') return errors.terminal
      return errors.policy
  }
  return null
}

export interface RuntimeEngineDeps {
  supervisor: Supervisor
  /** Build the lobby orchestrator over the given home-list source. */
  makeLobby: (emit: (view: EngineView) => void, projects: ProjectsSource) => RealOrchestrator
  /** Every view the surfaces should show now. */
  emit: (view: EngineView) => void
  /** A short private notice (a local card), e.g. a request that did not save. */
  notice: (text: string) => void
  copy: { notSaved: string; finishedRecord: string }
  /**
   * A mission the HUD is not on just asked the owner to answer. Surfaced once
   * per ask (a stall here freezes the mission, spec §16/§17).
   */
  onAsk?: (missionId: string, title: string) => void
  /**
   * View-ownership trace (dev logs, qualification diagnostics). The engine
   * logs its own cards; this records which mission owned the screen, which no
   * scene line can show once the adapter forwards a stored card.
   */
  trace?: (message: string) => void
  /**
   * The owner's repository mode (KeyVault.repoMode). 'per_idea': a goal that
   * names no repository starts in a new private one. Absent or 'one': the
   * configured default repository, exactly as before.
   */
  repoMode?: () => RepoMode
}

/** The question a view asks, or null when the view asks nothing. */
function askOfView(view: EngineView): { title: string; key: string } | null {
  if (view.type === 'selection' && view.purpose === 'decision') {
    return { title: view.title, key: `sel\n${view.title}\n${view.items.join('\n')}` }
  }
  if (view.type === 'scene' && view.scene.kind === 'decision') {
    return { title: view.scene.utterance, key: `scn\n${view.scene.utterance}` }
  }
  return null
}

const MAX_HOME_MISSIONS = 8
/** How many goals typed mid-commit are held before the phone keeps the text. */
const MAX_QUEUED_SAY = 4

/**
 * Every remote id a mission already owns (its lead session, its worker
 * sessions, and its Cursor agents/runs). The lobby's cloud list dedups these
 * away so one of our own workers is never offered as a foreign build the
 * owner could adopt or steer (spec §4).
 */
function ownedRemoteIdsOf(snap: RealSnapshot | NativeSnapshot | null): string[] {
  if (snap === null) return []
  if ('backend' in snap) return snap.binding ? [snap.binding.sessionId,
    ...snap.attention.flatMap(a => [a.sessionId, ...a.associatedSessionIds])] : []
  const ids: string[] = []
  if (snap.sessionId) ids.push(snap.sessionId)
  for (const job of snap.jobs ?? []) {
    if (job.sessionId) ids.push(job.sessionId)
    if (job.agentId) ids.push(job.agentId)
    if (job.runId) ids.push(job.runId)
  }
  return ids
}

/**
 * One line describing the card the surfaces are about to show. A forwarded
 * card produces no scene log of its own (the engine logged it when it was
 * emitted), so a focus change records what it is showing.
 */
function cardSummary(view: EngineView): string {
  if (view.type !== 'scene') return `list=${view.purpose} items=${view.items.length}`
  const p = view.scene.progress
  const progress = p === null ? '' : ` accepted=${p.acceptedWeight} pending=${p.pendingReviewWeight}`
  return `${view.scene.kind} rev=${view.scene.sceneRevision}${progress}`
}

/**
 * One chat entry as a persisted snapshot may carry it. Snapshots come back
 * from storage, so a malformed line is dropped, never trusted: the same
 * shape check the engine's restore applies.
 */
function chatEntryOf(c: unknown): { who: ChatWho; text: string; at: number } | null {
  if (c === null || typeof c !== 'object') return null
  const e = c as { who?: unknown; text?: unknown; at?: unknown }
  if (!isChatWho(e.who)) return null
  if (typeof e.text !== 'string' || e.text.trim() === '') return null
  return { who: e.who, text: e.text, at: Number(e.at) || 0 }
}

/** Mission -> the home row's status word key (COPY.real.statusWords). */
export function homeStatusOf(m: Mission, snap: RealSnapshot | MissionPresentation | null): string {
  if (m.config.nativeQuarantine) return 'fault'
  if (m.config.nativeHeldResolution?.outcome === 'promoted') return 'promoted'
  if (m.config.nativeHeldResolution?.outcome === 'dismissed') return 'dismissed'
  if (m.phase === 'completed') {
    const delivery = snap && 'native' in snap ? snap.native?.delivery : undefined
    if (!delivery) return 'final'
    return delivery.step === 'merged' ? 'merged' : delivery.step === 'held' ? 'delivery_held'
      : delivery.step === 'checks_failed' || delivery.step === 'not_merged' ? 'not_merged'
        : delivery.step === 'pushed' ? 'pr' : 'pr_open'
  }
  if (m.phase === 'failed' || m.phase === 'cancelled') return 'fault'
  if (snap?.faultKind) return 'fault'
  // The owner's own pause is the dominant fact about the row: a paused
  // mission does no work whatever phase it froze in, so the word says the
  // control state instead (spec §7: explicit, never implied by the phase).
  // `pause_requested` is not one yet — its interrupts may still land, so
  // the phase stays the honest word until the pause is confirmed.
  if (m.control === 'paused') return 'paused'
  // A mission waiting on the owner is not "planning": the home row must show
  // that it needs an answer (spec §16, §17).
  if (m.phase === 'awaiting_decision' || snap?.decisionPending) return 'decision'
  if (snap && 'planLabels' in snap && snap.phase === 'plan' && snap.planLabels?.length > 0 && snap.awaiting !== 'plan') return 'ready'
  if (snap?.activityStatus) return snap.activityStatus
  switch (m.phase) {
    case 'building':
      return 'building'
    case 'reviewing':
      return 'review'
    case 'repairing':
      return 'repair'
    case 'integrating':
      return 'pr'
    default:
      return 'planning'
  }
}

export class RuntimeEngine implements FactoryEngine {
  private readonly supervisor: Supervisor
  private readonly lobby: RealOrchestrator
  private readonly emitOut: (view: EngineView) => void
  private readonly notice: (text: string) => void
  private readonly copy: RuntimeEngineDeps['copy']
  private readonly trace: (message: string) => void
  private readonly repoMode: () => RepoMode
  private focused: string | null = null
  private booted = false
  private submitting = false
  /** Selection intent, including selecting Home when already there. */
  private navigationGeneration = 0
  private confirmingChatBuild = false
  /** Where the goal sitting on the lobby's transcript card came from. */
  private lobbySource: InputSource = 'glasses_voice'
  /**
   * The dedupe key for the goal currently on the lobby card, kept so a retry
   * of the SAME utterance resolves to the original receipt instead of a second
   * mission (spec §10 deduplicate). Cleared once the goal leaves the lobby, so
   * deliberately speaking the same words again is still a new request.
   */
  private pendingKey: { goal: string; source: InputSource; key: string } | null = null
  /** Goals typed while a durable commit was in flight, drained in order. */
  private queuedSay: Array<{ text: string; generation: number }> = []
  /** One ask notification per mission question (spec §16/§17). */
  private asked = new Map<string, string>()
  private readonly onAsk?: (missionId: string, title: string) => void

  constructor(deps: RuntimeEngineDeps) {
    this.supervisor = deps.supervisor
    this.emitOut = deps.emit
    this.notice = deps.notice
    this.copy = deps.copy
    this.onAsk = deps.onAsk
    this.trace = deps.trace ?? (() => {})
    this.repoMode = deps.repoMode ?? (() => 'one')
    this.lobby = deps.makeLobby((view) => {
      if (this.focused === null) this.emitOut(view)
    }, this.projectsSource())
    this.lobby.enableManagedWatchBuildHandoff?.()
  }

  /** The mission on screen, or null for the home/lobby. */
  get focusedMissionId(): string | null {
    return this.focused
  }

  /** The Supervisor's per-mission views land here. */
  onMissionView(missionId: string, view: EngineView): void {
    if (missionId === this.focused) {
      if (!this.supervisor.actor(missionId)?.hasPendingDecision) this.asked.delete(missionId)
      this.emitOut(view)
      return
    }
    this.trackAsk(missionId, view)
  }

  /**
   * A mission the HUD is not on asked a question. One notification per ask:
   * repeats of the same question stay silent, a new question speaks again, and
   * an answered mission clears its slot.
   */
  private trackAsk(missionId: string, view: EngineView): void {
    const snap = this.missionPresentation(missionId)
    const ask = snap?.decisionPending && snap.decisionText
      ? { title: snap.decisionText, key: snap.questionIdentity ?? `pending\n${snap.decisionText}\n${JSON.stringify(snap.decisionOptions)}` }
      : askOfView(view)
    if (ask === null) {
      // The ask stands until the question is actually gone: another card
      // from the same mission (a status note while it waits) must not reset
      // the slot, or the next re-emit of the same question would re-notify
      // forever instead of staying silent.
      if (this.asked.has(missionId) && !this.supervisor.actor(missionId)?.hasPendingDecision) {
        this.asked.delete(missionId)
      }
      return
    }
    if (this.asked.get(missionId) === ask.key) return
    this.asked.set(missionId, ask.key)
    this.onAsk?.(missionId, ask.title)
  }

  /** The focused session's chat log, oldest first (the lobby's when home). */
  chatLog(): Array<{ who: ChatWho; text: string; at: number }> {
    return this.focusedActor()?.chatLog() ?? this.lobby.chatLog()
  }

  nativeQuestionLink(): string | null {
    const actor = this.focusedActor()
    return actor !== null ? actor.nativeQuestionLink() : this.lobby.nativeQuestionLink?.() ?? null
  }

  factorySessionLink(): string | null {
    const actor = this.focusedActor()
    return actor !== null ? actor.factorySessionLink() : this.focused === null ? this.lobby.factorySessionLink() : null
  }
  get hasUnconfirmedDelivery(): boolean {
    const actor = this.focusedActor()
    return actor !== null ? actor.hasUnconfirmedDelivery : this.focused === null && this.lobby.hasUnconfirmedDelivery
  }

  /**
   * Any mission's session chat, oldest first — the one honest history a
   * finished build leaves. A live mission reads its actor's log; one with no
   * actor (terminal after a relaunch) reads the durable snapshot tail the
   * store keeps. The title is the mission record's own, so a surface can say
   * whose log it is; null when no record exists. An unknown id is empty,
   * never a crash.
   */
  chatLogFor(missionId: string): {
    title: string | null
    /** The build's name ('Checkout flow'), from the full goal, never the clipped title. */
    name: string | null
    log: Array<{ who: ChatWho; text: string; at: number }>
  } {
    const mission = this.supervisor.missions.find((m) => m.missionId === missionId) ?? null
    const name = mission ? buildName(mission.goal || mission.title) || null : null
    const actor = this.supervisor.actor(missionId)
    if (actor !== null) return { title: mission?.title ?? null, name, log: actor.chatLog() }
    const native = this.supervisor.nativeSnapshotFor?.(missionId)
    if (native) return { title: mission?.title ?? null, name, log: [...native.history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map(h => ({
      who: h.who === 'owner' ? 'you' : h.who === 'factory' ? 'lead' : 'spriite',
      text: h.text, at: Date.parse(h.at),
    })) }
    const chat = this.supervisor.engineSnapshotFor(missionId)?.chat ?? []
    return {
      title: mission?.title ?? null,
      name,
      log: (Array.isArray(chat) ? chat : [])
        .map(chatEntryOf)
        .filter((e): e is { who: ChatWho; text: string; at: number } => e !== null),
    }
  }

  /**
   * Missions waiting on the owner's answer right now (any mission).
   *
   * The focused mission is included too: "the question is on screen" is an
   * assumption, not a fact — the HUD can drop the emission (a capture owned
   * it, the glasses were away) and then the banner would be the ONLY surface
   * that still says a question waits. A pending question outranks every
   * status card on every surface, and the row's Show re-presents it.
   */
  pendingAsks(): Array<{ missionId: string; title: string; options?: string[]; who?: ChatWho }> {
    const out: Array<{ missionId: string; title: string; options?: string[]; who?: ChatWho }> = []
    for (const m of this.supervisor.missions) {
      if (isTerminalPhase(m.phase) && m.config.executionBackend !== 'factory_native') continue
      const actor = this.supervisor.actor(m.missionId)
      const snap = this.missionPresentation(m.missionId)
      if (m.phase !== 'awaiting_decision' && !snap?.decisionPending) continue
      const view = actor?.currentView
      const title =
        view?.type === 'selection' && view.purpose === 'decision'
          ? view.title
          : view?.type === 'scene' && view.scene.kind === 'decision'
            ? view.scene.utterance
            : snap?.decisionText || m.goal
      // The answers the question offers (Home's Needs you draws the first
      // two for any build, not only the focused one). The selection's last
      // row is "speak another answer", which the phone's Say it covers.
      const options =
        view?.type === 'selection' && view.purpose === 'decision'
          ? view.items.slice(0, -1)
          : view?.type === 'scene' && view.scene.kind === 'decision'
            ? view.scene.actions.filter((a) => a.kind === 'command').map((a) => a.label)
            : []
      // Who asks: a gate is Spriite's, a worker's question the worker's.
      const who: ChatWho =
        view?.type === 'scene' && view.scene.kind === 'decision' && view.scene.speaker ? view.scene.speaker
          : view?.type === 'selection' && view.purpose === 'decision' && view.contextLabel === COPY.hud.workerAsks ? 'worker'
            : view?.type === 'selection' && view.purpose === 'decision' && view.contextLabel === COPY.hud.spriiteAsks ? 'spriite'
              : 'lead'
      out.push({ missionId: m.missionId, title, ...(options.length > 0 ? { options } : {}), who })
    }
    return out
  }

  /** Bring a mission's cards to the HUD (the phone banner, an ask's Show). */
  showMission(missionId: string): boolean {
    if (this.supervisor.actor(missionId) === null) return false
    this.focus(missionId)
    return true
  }

  /**
   * Parallel missions: a focused mission never blocks switching (it keeps
   * running). Only the lobby's own state can refuse: its fault card.
   */
  canOpenBuilds(): boolean {
    return this.lobby.canOpenBuilds()
  }

  /** Watches live on the lobby; a focused mission is always Spriite's own. */
  watching(): boolean {
    return this.focusedActor() === null && this.lobby.watching()
  }

  watchOnly(): boolean {
    return this.focusedActor() === null && this.lobby.watchOnly()
  }

  // ------------------------------------------------------------- lifecycle

  boot(): void {
    if (!this.booted) {
      this.booted = true
      // Recovery owns execution, not screen selection. Saved builds and
      // questions remain on the home/phone until the owner opens one.
      this.lobby.boot()
      return
    }
    if (this.focused !== null) this.emitOut(this.currentView)
    else this.lobby.boot()
  }

  tick(now?: number): void {
    this.supervisor.tick(now)
    this.lobby.tick(now)
  }

  get currentView(): EngineView {
    const actor = this.focusedActor()
    return actor !== null ? actor.currentView : this.lobby.currentView
  }

  /**
   * What is on screen, for the phone's live card. Never a restore source:
   * managed mission state is the Supervisor's durable store. restore() only
   * accepts a read-only foreign watch, never a managed execution grant.
   */
  snapshot(): RealSnapshot | NativeSnapshot {
    return this.focusedActor()?.snapshot ?? (this.lobby.snapshot() as RealSnapshot)
  }

  nativeSnapshot(): NativeSnapshot | null {
    return this.focused === null ? null : this.supervisor.nativeSnapshotFor(this.focused)
  }
  presentation(): MissionPresentation | null {
    return this.focused === null ? null : this.missionPresentation(this.focused)
  }
  async answerNative(answer: NativeAnswer): Promise<boolean> {
    if (this.focused === null) return false
    const receipt = await this.supervisor.answerNative(this.focused, answer)
    return receipt.state === 'confirmed'
  }
  async submitNativeIntent(intent: NativeIntent): Promise<SubmitReceipt> {
    const generation = ++this.navigationGeneration
    const receipt = await this.supervisor.submitNativeIntent(intent)
    if (receipt.missionId && receipt.receipt !== 'rejected' && generation === this.navigationGeneration) {
      this.focus(receipt.missionId)
    }
    return receipt
  }

  restore(_snap: unknown): void {
    // Only a read-only foreign watch can restore here. Managed execution is
    // always restored by the Supervisor, never adopted from a UI snapshot.
    const s = _snap as RealSnapshot | null
    if (s?.phase === 'attach' && s.attach?.source === 'factory' &&
      s.attach.sessionId === s.sessionId && s.jobs?.length === 0 &&
      !s.queuedStart && !s.decisionGate && !s.approvedPlan?.length &&
      !s.planLabels?.length && !s.pendingLeadPosts?.length &&
      this.focused === null) this.lobby.restore(s)
  }

  configure(o: Parameters<RealOrchestrator['configure']>[0]): void {
    // The repository mode is applied here, at submit (perIdeaRouting): the
    // lobby never plans, so it never needs it.
    const { repoMode: _mode, ...rest } = o
    this.lobby.configure(rest)
  }

  // ---------------------------------------------------------------- input

  handleAction(id: string): void {
    if (id === 'show_builds') { this.showHome(); return }
    if (id === 'use_it' && this.focused === null && this.lobby.canConfirmChatBuild()) id = 'confirm_chat_build'
    if (this.focused === null && (id === 'review_chat_build' ||
      (id === 'continue_session' && this.lobby.canReviewChatBuild())) &&
      this.routeWatchedBuild('Build it', 'glasses_voice')) return
    const missionId = this.focused
    if (missionId !== null) {
      if (id === 'restart') {
        this.reset()
        return
      }
      const outcome = this.supervisor.handleAction(missionId, id)
      if (outcome.kind === 'forwarded') return
      // A gated tap must change the card: re-emitting the same card is what
      // read as a dead button on the glasses.
      const reason = outcomeReason(outcome)
      this.emitOut(reason !== null ? this.lobby.noticeView(reason, COPY.real.actionNotRunStatus) : this.currentView)
      return
    }
    if (id === 'confirm_chat_build') {
      if (!this.submitting && !this.confirmingChatBuild) void this.confirmWatchedBuild()
      return
    }
    if ((id === 'start_planning' || id === 'new_repo' || id === 'retry_start') && this.lobbyHoldsGoal()) {
      // The durable save can take seconds over the bridge: the card says it
      // is saving at once, and a second tap meanwhile gets the same answer
      // instead of a silent no-op.
      this.lobby.showNotice(COPY.real.savingRequest, COPY.real.savingRequestStatus, 'delegating')
      if (this.submitting) return
      void this.submit(this.lobbyGoal(), this.lobbySource, id === 'new_repo' ? 'new_repo' : null)
      return
    }
    // The lobby never starts planning on its own: a start action with no goal
    // on the card is a stale tap (focus churn, a phone action), and forwarding
    // it would create a provider session the durable runtime does not own.
    if (id === 'start_planning' || id === 'new_repo' || id === 'retry_start') {
      this.emitOut(this.currentView)
      return
    }
    this.lobby.handleAction(id)
  }

  back(): 'exit' | 'handled' {
    this.navigationGeneration++
    const actor = this.focusedActor()
    if (actor !== null) {
      if (actor.hasNavigationLayer) actor.back()
      else this.focus(null) // questions remain on their actor; Back never answers them
      return 'handled'
    }
    return this.lobby.back()
  }

  chooseGoalList(index: number): 'talk' | 'done' {
    const actor = this.focusedActor()
    return actor !== null ? actor.chooseGoalList(index) : this.lobby.chooseGoalList(index)
  }

  chooseDecisionList(index: number): 'talk' | 'done' {
    const missionId = this.focused
    return missionId !== null
      ? this.supervisor.chooseDecisionList(missionId, index)
      : this.lobby.chooseDecisionList(index)
  }

  chooseList(index: number): void {
    const actor = this.focusedActor()
    if (actor !== null) actor.chooseList(index)
    else this.lobby.chooseList(index)
  }

  transcriptGoal(sec: number): void {
    const actor = this.focusedActor()
    if (actor !== null) {
      actor.transcriptGoal(sec)
      return
    }
    this.navigationGeneration++
    this.lobbySource = 'glasses_voice'
    this.lobby.transcriptGoal(sec)
  }

  voiceGoal(text: string, sec: number): void {
    const actor = this.focusedActor()
    if (actor !== null) {
      actor.voiceGoal(text, sec)
      return
    }
    this.navigationGeneration++
    this.lobbySource = 'glasses_voice'
    this.lobby.voiceGoal(text, sec)
  }

  steer(text: string): boolean {
    if (this.routeBuildReview(text)) return true
    if (this.routeWatchedBuild(text, 'glasses_voice')) return true
    const missionId = this.focused
    if (missionId !== null) return this.supervisor.steer(missionId, text)
    return this.lobby.steer(text)
  }

  /**
   * The phone's "Start in a new repository" row. On a focused mission the
   * engine decides (a live session takes it as steering); on the lobby it is
   * a durable command that creates the repository, exactly like the glasses'
   * New repo action.
   */
  sayNewRepo(text: string, name: string): 'goal' | 'steer' | 'none' {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (clean === '' || this.submitting) return 'none'
    // A new repository is always a NEW mission, running alongside whatever is
    // on screen: the focused mission keeps running and stays on the home.
    // Routing it into the focused mission is how it used to land as steering
    // in the previous build's repository.
    if (this.focused !== null) this.focus(null, false)
    this.lobby.reset()
    void this.submit(clean, 'phone_text', 'new_repo', name.replace(/\s+/g, ' ').trim())
    return 'goal'
  }

  /** Back to the home without touching any mission (they keep running). */
  showHome(): void {
    this.focus(null, false)
    if (this.lobby.showHome) this.lobby.showHome()
    else this.lobby.reset()
    this.emitOut(this.lobby.currentView)
  }

  canStartNewRepo(): boolean {
    return true
  }

  say(text: string): 'goal' | 'steer' | 'decision' | 'none' {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (clean === '') return 'none'
    if (this.routeBuildReview(clean)) return 'decision'
    if (this.routeWatchedBuild(clean, 'phone_text')) return 'steer'
    const missionId = this.focused
    if (missionId !== null) {
      // A refused start/PR gate ends the mission: the gate is the only thing
      // that would have started or finished it, so the refusal is recorded on
      // the decision, the mission is cancelled (its records stay), and the
      // home returns — never the dead mission's plan card, and never a new
      // goal silently steering a session that will never run (the owner's
      // report: after declining a question, nothing responded again).
      if (this.supervisor.declineGate(missionId, clean)) {
        this.reset() // the restart path: cancel the focused mission, show the home
        return 'decision'
      }
      return this.supervisor.say(missionId, clean)
    }
    // A watched cloud build takes typed text as a message; anywhere else on
    // the lobby, typed text is a new request.
    if ((this.lobby.snapshot() as RealSnapshot).phase === 'attach') return this.lobby.say(clean)
    // A durable commit can take seconds over the serialized bridge. A second
    // goal typed in that window must not be dropped while the phone reports
    // it accepted (spec §10): queue it, and say 'none' if the queue is full
    // so the phone keeps the text instead of clearing it.
    if (this.submitting) {
      if (this.queuedSay.length >= MAX_QUEUED_SAY) return 'none'
      this.queuedSay.push({ text: clean, generation: ++this.navigationGeneration })
      return 'goal'
    }
    void this.submit(clean, 'phone_text', null)
    return 'goal'
  }

  listBuilds(): Array<{ title: string; note: string; kind: 'local' | 'factory' | 'cursor' }> {
    return this.lobby.listBuilds()
  }

  openBuild(index: number): boolean {
    if (!this.lobby.canOpenBuilds() || this.lobby.listBuilds()[index] === undefined) return false
    this.navigationGeneration++
    const from = this.focused
    if (from !== null) this.focus(null, false)
    const opened = this.lobby.openBuild(index)
    if (!opened && from !== null) this.focus(from, false)
    else if (opened && this.focused === null && from !== null && !this.lobby.watching()) {
      // A finished record has no card to show: the screen the owner left stays.
      this.focus(from, false)
    }
    return opened
  }

  talkStatus(): void {
    const actor = this.focusedActor()
    if (actor !== null) actor.talkStatus()
    else this.lobby.talkStatus()
  }

  pauseToggle(): void {
    const missionId = this.focused
    const actor = this.focusedActor()
    if (missionId === null || actor === null) {
      this.lobby.pauseToggle()
      return
    }
    if (actor.canResume()) this.supervisor.handleAction(missionId, 'resume')
    else if (actor.canPause()) this.supervisor.handleAction(missionId, 'pause')
    this.emitOut(this.currentView)
  }

  /**
   * Restart: a live mission is cancelled (its records and evidence stay) and
   * the home returns; a finished one simply leaves the screen. Never an
   * in-place reset that would reuse a mission under a new goal.
   */
  reset(): void {
    this.navigationGeneration++
    const missionId = this.focused
    if (missionId !== null) {
      const m = this.supervisor.missions.find((mm) => mm.missionId === missionId)
      if (m !== undefined && !isTerminalPhase(m.phase)) this.supervisor.handleAction(missionId, 'restart')
      this.focus(null, false)
    }
    this.lobby.reset()
    this.emitOut(this.lobby.currentView)
  }

  acceptsGoal(): boolean {
    const actor = this.focusedActor()
    return actor !== null ? actor.acceptsGoal() : this.lobby.acceptsGoal()
  }

  canPause(): boolean {
    const actor = this.focusedActor()
    return actor !== null ? actor.canPause() : this.lobby.canPause()
  }

  canResume(): boolean {
    const actor = this.focusedActor()
    return actor !== null ? actor.canResume() : this.lobby.canResume()
  }

  canExplain(): boolean {
    const actor = this.focusedActor()
    return actor !== null ? actor.canExplain() : this.lobby.canExplain()
  }

  get hasPendingDecision(): boolean {
    const actor = this.focusedActor()
    return actor !== null ? actor.hasPendingDecision : this.lobby.hasPendingDecision
  }

  // --------------------------------------------------------------- private

  private focusedActor(): ReturnType<Supervisor['actor']> {
    return this.focused !== null ? this.supervisor.actor(this.focused) : null
  }

  private missionPresentation(missionId: string): MissionPresentation | null {
    const projection = this.supervisor.presentationFor?.(missionId)
    if (projection) return projection
    // The structural boundary also supports retained legacy embedders that
    // expose actors but have not yet added the optional neutral projection.
    const snap = this.supervisor.actor(missionId)?.snapshot ?? this.supervisor.engineSnapshotFor?.(missionId)
    return snap ? 'backend' in snap ? nativePresentation(snap) : legacyPresentation(snap) : null
  }

  private routeWatchedBuild(text: string, source: InputSource): boolean {
    if (this.focused !== null ||
      !(isBuildDirective(text) || (isScopeReviewDirective(text) && this.lobby.canReviewChatBuild())) || this.lobby.hasPendingDecision ||
      this.lobby.hasUnconfirmedDelivery) return false
    const snap = this.lobby.snapshot() as RealSnapshot
    if (snap.phase !== 'attach' || snap.attach?.source !== 'factory' || !snap.sessionId) return false
    // An explicit saved handoff outranks an older recovered planning lead.
    // Otherwise an archive merge could re-open the old coordinator and start
    // a second worker for a scope that already has an execution controller.
    const owner = this.supervisor.missions.find(m =>
      m.config.buildSourceSessionId === snap.sessionId && this.supervisor.actor(m.missionId) !== null) ??
      this.supervisor.missions.find(m => m.config.buildSourceSessionId === snap.sessionId) ??
      this.supervisor.missions.find(m =>
      [...ownedRemoteIdsOf(this.supervisor.actor(m.missionId)?.snapshot ?? null),
        ...ownedRemoteIdsOf(this.supervisor.engineSnapshotFor(m.missionId))].includes(snap.sessionId!))
    if (owner) {
      if (this.supervisor.actor(owner.missionId) === null) this.notice(this.copy.finishedRecord)
      else {
        this.focus(owner.missionId)
        const actor = this.supervisor.actor(owner.missionId)!
        if (actor.backend === 'legacy' && actor.snapshot.sessionId && !actor.hasPendingDecision) this.supervisor.say(owner.missionId, text)
      }
      return true
    }
    this.lobbySource = source
    return this.lobby.steer(text)
  }

  private routeBuildReview(text: string): boolean {
    const actor = this.focusedActor()
    if (actor?.backend === 'factory_native') return false
    const review = actor?.snapshot.buildDraft ?? (this.lobby.snapshot() as RealSnapshot).buildDraft
    const view = this.currentView
    if (!review || view.type !== 'scene' || !view.scene.actions.some(a => a.id === 'confirm_chat_build')) return false
    if (isBuildCancellation(text)) { this.back(); return true }
    if (!isBuildApproval(text)) return false
    this.handleAction('use_it')
    return true
  }

  private async confirmWatchedBuild(): Promise<void> {
    this.confirmingChatBuild = true
    const generation = this.navigationGeneration
    try {
      const draft = await this.lobby.verifiedChatBuildDraft()
      if (!draft || !this.lobby.watching() || generation !== this.navigationGeneration) return
      this.lobby.showNotice(COPY.real.savingRequest, COPY.real.savingRequestStatus, 'delegating')
      await this.submit(draft.goal, this.lobbySource, null, '', generation, draft)
    } finally { this.confirmingChatBuild = false }
  }

  private focus(missionId: string | null, emit = true): void {
    this.navigationGeneration++
    const previous = this.focused
    const previousView = this.currentView
    const changed = this.focused !== missionId
    this.focused = missionId
    if (changed) {
      if (previous !== null) this.trackAsk(previous, previousView)
      const where = missionId === null ? 'home' : `mission ${missionId}`
      this.trace(`[runtime] view: ${where} card=${cardSummary(this.currentView)}`)
    }
    if (emit) this.emitOut(this.currentView)
  }

  private lobbyGoal(): string {
    return (this.lobby.snapshot() as RealSnapshot).goal ?? ''
  }

  /** The lobby is on a goal the owner has not started yet. */
  private lobbyHoldsGoal(): boolean {
    const snap = this.lobby.snapshot() as RealSnapshot
    return snap.goal !== '' && snap.sessionId === null && this.lobby.acceptsGoal()
  }

  /**
   * Durable receipt first (spec §10): only a saved command leaves the lobby.
   * A command that did not save stays on the transcript card and says so.
   */
  private async submit(
    text: string,
    source: InputSource,
    then: 'new_repo' | null,
    newRepoName = '',
    generation = ++this.navigationGeneration,
    buildDraft?: ChatBuildDraft,
  ): Promise<SubmitReceipt | null> {
    if (this.submitting || text.trim() === '') return null
    this.submitting = true
    // Per-idea repositories (C8): only a plain goal is routed; New repo and a
    // reviewed chat build keep the choice the owner already made.
    const perIdea = then === null && !buildDraft ? perIdeaRouting(this.repoMode(), text, source) : null
    try {
      // Same goal from the same place while it is still on the card = a retry
      // of one request, so it reuses the key. A new goal (or the same words
      // after the card cleared) mints a fresh one.
      if (this.pendingKey === null || this.pendingKey.goal !== text || this.pendingKey.source !== source) {
        this.pendingKey = { goal: text, source, key: `${source}:${mintId('request')}` }
      }
      const receipt = await this.supervisor.submitCommand({
        text,
        source,
        sourceEventId: mintId('utterance'),
        dedupeKey: this.pendingKey.key,
        ...(buildDraft ? {
          dedupeKey: `chat-build:${buildDraft.sourceSessionId}`,
          repository: buildDraft.repository,
          startApproved: true,
          approvedPlan: [...buildDraft.plan],
          buildSourceSessionId: buildDraft.sourceSessionId,
          contextRefs: [`factory-session:${buildDraft.sourceSessionId}`],
        } : {}),
        // "New repo" freezes NO repository and records the intent durably:
        // the mission creates its own repository, and the configured default
        // is never adopted for it (the owner's report: New repo did nothing
        // and the mission quietly planned on the default repository).
        ...(then === 'new_repo'
          ? { newRepository: true, ...(newRepoName !== '' ? { newRepositoryName: newRepoName } : {}) }
          : {}),
        ...(perIdea ?? {}),
      })
      if (receipt.receipt === 'rejected' || receipt.missionId === undefined) {
        console.error('[runtime] request not saved:', receipt.reason ?? 'unknown')
        if (generation === this.navigationGeneration) {
          this.lobby.clearNotice() // the saving card would claim a save in progress
          this.notice(this.copy.notSaved)
        }
        return receipt
      }
      this.trace(`[runtime] command ${receipt.receipt} mission=${receipt.missionId}`)
      if (generation === this.navigationGeneration) {
        this.focus(receipt.missionId, false) // execution saved; selection still belongs to it
        this.lobby.reset()
        this.emitOut(this.currentView)
      }
      this.pendingKey = null // the goal left the card; a later repeat is new
      // The start action is the mission's own durable fact now: beginGoal
      // issues new_repo from the frozen config, so nothing has to be replayed
      // here (and a relaunch resumes the same create).
      return receipt
    } finally {
      this.submitting = false
      // Drain one queued goal (spec §10): a goal typed while this commit was
      // in flight is submitted now instead of being silently lost.
      const next = this.queuedSay.shift()
      if (next !== undefined) void this.submit(next.text, 'phone_text', null, '', next.generation)
    }
  }

  private projectsSource(): ProjectsSource {
    return {
      list: () =>
        [...this.supervisor.missions]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, MAX_HOME_MISSIONS)
          .map((m) => {
            const snap = this.supervisor.actor(m.missionId)?.snapshot ?? null
            const projection = this.missionPresentation(m.missionId)
            return {
              id: m.missionId,
              // The full goal: the lobby names the row from it (a clipped
              // title can cut a scoped goal mid-section).
              goal: m.goal || m.title,
              status: homeStatusOf(m, projection ?? (snap && !('backend' in snap) ? snap : null)),
              updatedAt: Date.parse(m.updatedAt) || 0,
              sessionId: snap ? 'backend' in snap ? snap.binding?.sessionId ?? null : snap.sessionId : null,
              // Every provider session this mission owns, so the lobby's cloud
              // list never shows one of our own workers as an adoptable,
              // steerable "other" build (spec §4).
              ownedRemoteIds: ownedRemoteIdsOf(snap),
            }
          }),
      snapshotFor: () => null,
      open: (row) => {
        if (row.id === undefined) return true // never a snapshot restore
        if (this.supervisor.actor(row.id) !== null) {
          this.focus(row.id)
          return true
        }
        // A mission that finished before this launch has no actor; its
        // record lives on the phone.
        this.notice(this.copy.finishedRecord)
        return true
      },
    }
  }
}
