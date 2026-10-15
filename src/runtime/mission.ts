/**
 * Mission actor (spec §4, §7, §26 phase 2): the serialized unit of state
 * change for ONE mission.
 *
 * Each actor owns one lead engine (RealOrchestrator), restored from the
 * mission's durable engine snapshot, with every remote LAUNCH routed through
 * the durable dispatch outbox. The actor is where that mission's domain
 * transitions happen: phase mapping, decision records, provider-run
 * observation, pause/resume/cancel control, and snapshot persistence.
 *
 * Independence from the selected view (spec §2, §26 phase-2 exit criterion):
 * nothing here reads or writes UI focus. The supervisor ticks every actor
 * whether or not its mission is on screen, so selecting another card cannot
 * change a mission's eligibility.
 *
 * Crash honesty: the engine snapshot is persisted 1.5 s after ordinary view
 * churn (the baseline debounce) but IMMEDIATELY when the engine starts
 * referencing a new remote id, because that is the moment the durable record
 * stops being able to describe the live run. The residual window (remote
 * session created, snapshot not yet durable) is closed at recovery by the
 * outbox's claim-based reuse, which hands the recorded session back instead
 * of launching a second one (spec §25.28).
 *
 * What this class deliberately does not do: it never claims remote work
 * stopped. Pause sends an interrupt request and keeps observing; cancel
 * records each cancellation request and reports the unresolved remainder.
 */
import type { ChatWho } from '../domain/speaker'
import { draftEvent, type EventDraft, type KnownEventType } from '../domain/events'
import { mintId, nowIso } from '../domain/ids'
import type { DecisionRecord, Mission, MissionPhase, MissionSessionSettings, ProviderRun, SpriiteState } from '../domain/types'
import { isTerminalPhase } from '../domain/types'
import type { EngineView } from '../factory/view'
import { RealOrchestrator, isGateDecline, type RealClients, type RealSnapshot } from '../factory/real'
import type { MissionStore } from '../state/mission-store'
import type { CommitResult } from '../state/mission-store'
import type { WorkerPref } from '../state/prefs'
import { legacyPresentation } from '../native/presentation'

/** Ordinary view churn is debounced like the baseline app (1.5 s). */
export const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 1500
/** A cancellation request that answers slower than this is unresolved. */
const CANCELLATION_TIMEOUT_MS = 15_000

/**
 * Actions that reach the network. Suppressed while the mission is paused or
 * cancelling (spec §7: pause "suppress[es] new launch, follow-up,
 * integration, and approval actions").
 */
export const LAUNCH_ACTIONS: readonly string[] = [
  'confirm_chat_build',
  'continue_session',
  'start_planning',
  'new_repo',
  'retry_start',
  'retry',
  'use_it',
  'open_pr',
]

/**
 * The subset that can create or extend WORKER runs, i.e. that consumes
 * scheduler capacity. A capacity hold is QUEUED (capacity is a scheduling
 * fact); a hold under pause is DROPPED, because a stale approval must never
 * fire after a resume (spec §7, §10).
 */
export const CAPACITY_ACTIONS: readonly string[] = ['confirm_chat_build', 'retry', 'use_it', 'open_pr']

export type ActionOutcome =
  | { kind: 'forwarded' }
  | { kind: 'held'; reason: 'capacity' }
  | { kind: 'dropped'; reason: 'paused' | 'cancelling' | 'terminal' }
  | { kind: 'rejected'; reason: 'unknown_action' | 'duplicate_pause' | 'cancelling' }

/**
 * Fault kinds that are the runtime's OWN refusal marker rather than a provider
 * failure: they are re-attempted once control, policy, and capacity allow it.
 */
export const SUPPRESSION_FAULT_KINDS: readonly string[] = [
  'paused',
  'cancelling',
  'policy',
  'terminal',
  'capacity',
]

export interface CancelTarget {
  runId: string
  provider: 'factory' | 'cursor'
  sessionId: string | null
  agentId: string | null
  remoteRunId: string | null
  role: 'lead' | 'worker'
}

/**
 * A launch the runtime refused on purpose (paused, cancelling, terminal,
 * policy, capacity), as opposed to a provider failure. It carries `kind` so
 * the engine's fault card can name why, and so nothing is ever recorded as
 * an unknown dispatch for a call that never went out.
 */
export class LaunchSuppressedError extends Error {
  readonly kind: string
  readonly actionKind: string
  constructor(reason: 'paused' | 'cancelling' | 'terminal' | 'policy' | 'capacity', actionKind: string) {
    super(`launch suppressed (${reason})`)
    this.name = 'LaunchSuppressedError'
    this.kind = reason
    this.actionKind = actionKind
  }
}

export interface MissionActorEngineConfig {
  factoryKey: string
  cursorKey: string
  githubToken: string
  /**
   * Operational, not frozen: a computer id is validated against the live
   * account at mission start, so a stale saved id cannot strand a mission.
   * The repository IS frozen (MissionConfig.repository) once assigned; a
   * mission created before the owner saved one falls back to `liveRepository`
   * until a save assigns it (spec §12 blocked-start resume).
   */
  computerId: string
  workerPref: WorkerPref
  jobs: number
  askBeforePr: boolean
  /**
   * The Factory session settings this mission froze when it was created
   * (spec §7). Empty means the owner chose nothing and Factory's account
   * defaults stand. Never live: a save applies to the next mission.
   */
  settings: MissionSessionSettings
  /**
   * This mission's id, tagged onto worker sessions so the owner can find
   * them in Factory's own app.
   */
  missionId: string
  /**
   * The owner's currently saved repository. A mission whose frozen repository
   * is still empty resolves to this, so a mission created before the owner
   * saved a repository can start once they do (spec §12, §17).
   */
  liveRepository: string
  now?: () => number
}

export interface MissionActorDeps {
  missionId: string
  store: MissionStore<SpriiteState>
  /** Raw clients; the actor routes this mission's launches through the outbox. */
  clients: RealClients
  /** Prepare the mission's durable launches (claim-based reuse lives here). */
  wrapClients: (
    clients: RealClients,
    missionId: string,
    knownRemoteIds: () => Set<string>,
    beforeLaunch: (kind: string) => void,
  ) => RealClients
  engine: MissionActorEngineConfig
  /** Forward the engine's card to whatever surface subscribed to this mission. */
  emitView: (missionId: string, view: EngineView) => void
  /** True when the supervisor has admitted this mission for worker launches. */
  canLaunch: () => boolean
  /**
   * Policy gate consulted at the launch seam, so a narrowed policy prevents
   * now-disallowed actions immediately, including for older missions and
   * including launches the engine starts on its own (spec §21, §25.10).
   */
  launchPermitted: () => boolean
  /** The supervisor queues the action so it can replay it on admission. */
  onActionHeld: (missionId: string, actionId: string) => void
  snapshotDebounceMs?: number
}

/** Engine phase -> domain phase (spec §7 normal path). */
export function missionPhaseForEngine(phase: string): MissionPhase {
  switch (phase) {
    case 'plan':
      return 'planning'
    case 'building':
      return 'building'
    case 'review':
      return 'reviewing'
    case 'repair':
      return 'repairing'
    case 'pr':
      return 'integrating'
    case 'final':
      return 'completed'
    default:
      // meet / goal / transcript: the goal is still being taken. attach is a
      // watch on someone else's build and is never a mission.
      return 'received'
  }
}

/** The frozen mission config speaks in providers; the engine speaks in prefs. */
export function workerPrefFromProviders(providers: Array<'factory' | 'cursor'>): WorkerPref {
  const factory = providers.includes('factory')
  const cursor = providers.includes('cursor')
  if (factory && cursor) return 'mix'
  if (cursor) return 'cursor'
  return 'factory'
}

/**
 * Freeze the owner's worker preference into the mission's provider list.
 * `auto` means "Cursor when this account has a Cursor key, otherwise the
 * Factory session" — resolving it at creation is what makes the frozen
 * configuration reproducible after a restart (spec §7, §25.6).
 */
export function providersFromWorkerPref(
  pref: WorkerPref,
  hasCursorKey: boolean,
): Array<'factory' | 'cursor'> {
  switch (pref) {
    case 'factory':
      return ['factory']
    case 'mix':
      return ['factory', 'cursor']
    default:
      return hasCursorKey ? ['cursor'] : ['factory']
  }
}

interface RunCandidate {
  provider: 'factory' | 'cursor'
  role: 'lead' | 'worker'
  sessionOrAgentId: string
  remoteRunId: string | null
  observedState: string
  active: boolean
}

export class MissionActor {
  readonly backend = 'legacy' as const
  readonly missionId: string
  private readonly store: MissionStore<SpriiteState>
  private readonly clients: RealClients
  private readonly emitExternalView: (missionId: string, view: EngineView) => void
  private readonly canLaunch: () => boolean
  private readonly launchPermitted: () => boolean
  private readonly onActionHeld: (missionId: string, actionId: string) => void
  private readonly snapshotDebounceMs: number
  private readonly now: () => number
  private readonly engine: RealOrchestrator
  /** The owner's currently saved repository; a save hot-applies it (spec §12). */
  private liveRepository: string

  private dirty = false
  private lastSavedIds = ''
  private lastSavedAt = 0
  private lastPlanLabels = ''
  private lastFaultKey = ''
  /** Whether the last-seen fault was the runtime's own refusal (no provider event). */
  private lastFaultSuppressed = false
  private lastRunsKey = ''
  /** Successful transport observations, never snapshot diffs or restore time. */
  private lastSuccessfulObservation: string | null = null
  private latestObservation: 'unobserved' | 'current' | 'unknown' = 'unobserved'
  private readonly runObservations = new Map<string, string>()
  private chain: Promise<unknown> = Promise.resolve()
  private restoreRefusedFlag = false
  private cancellationFailures: string[] = []
  /** Run ids the cancellation requests were sent for (the confirm's story). */
  private cancellationTargetsSent: string[] = []
  /** False from the moment cancel() runs until the requests have settled. */
  private cancellationSettled = true
  /** Provider identities, not local run ids, survive observation/dispatch races. */
  private readonly cancellationClaims = new Set<string>()
  /** Suppress execution immediately while a control-intent commit is queued. */
  private pendingControl: { reason: 'paused' | 'cancelling' } | null = null
  /**
   * How the owner resolved the engine's pending question (use_it/open_pr/say),
   * captured BEFORE the engine clears it. Auto-closed records state this
   * instead of guessing, and never call an approval a refusal.
   */
  private decisionAnswer:
    | { optionId: string | null; answerText: string | null; outcome: 'answered'; questionIdentity?: string; legacyDecisionId?: string }
    | null = null
  private disposed = false

  constructor(deps: MissionActorDeps) {
    this.missionId = deps.missionId
    this.store = deps.store
    this.clients = deps.clients
    this.emitExternalView = deps.emitView
    this.canLaunch = deps.canLaunch
    this.launchPermitted = deps.launchPermitted
    this.onActionHeld = deps.onActionHeld
    this.snapshotDebounceMs = deps.snapshotDebounceMs ?? DEFAULT_SNAPSHOT_DEBOUNCE_MS
    this.now = deps.engine.now ?? (() => Date.now())
    this.liveRepository = deps.engine.liveRepository
    const wrapped = deps.wrapClients(deps.clients, deps.missionId, () => this.knownRemoteIds(), (kind) =>
      this.assertLaunchAllowed(kind),
    )
    const observed = (key: string) => {
      this.lastSuccessfulObservation = new Date(this.now()).toISOString()
      this.latestObservation = 'current'
      this.runObservations.set(key, this.lastSuccessfulObservation)
    }
    const getSession = wrapped.getSession
    wrapped.getSession = async (...args) => {
      try { const result = await getSession(...args); observed(JSON.stringify(['factory', args[0]])); return result }
      catch (error) { this.latestObservation = 'unknown'; throw error }
    }
    const getMessages = wrapped.getMessages
    wrapped.getMessages = async (...args) => {
      try { const result = await getMessages(...args); observed(JSON.stringify(['factory', args[0]])); return result }
      catch (error) { this.latestObservation = 'unknown'; throw error }
    }
    const cursorGet = wrapped.cursorGet
    wrapped.cursorGet = async (...args) => {
      try { const result = await cursorGet(...args); observed(JSON.stringify(['cursor', args[0], args[1]])); return result }
      catch (error) { this.latestObservation = 'unknown'; throw error }
    }
    const createLead = wrapped.createSession
    wrapped.createSession = async (options) => {
      const created = await createLead(options)
      // The outbox retains the confirmed id for cleanup, but a cancelled
      // create must not return it to a pipeline that posts its first plan
      // AFTER our interrupt. Existing result observation remains untouched.
      const mission = this.mission()
      if (this.pendingControl?.reason === 'cancelling' || mission?.control === 'cancel_requested') {
        throw new LaunchSuppressedError('cancelling', 'factory.session')
      }
      if (!mission || this.isTerminal(mission)) throw new LaunchSuppressedError('terminal', 'factory.session')
      return created
    }
    this.engine = new RealOrchestrator(
      (view) => {
        this.dirty = true
        this.emitExternalView(this.missionId, view)
      },
      {
        factoryKey: deps.engine.factoryKey,
        cursorKey: deps.engine.cursorKey,
        githubToken: deps.engine.githubToken,
        repoUrl: this.effectiveRepository(),
        baseRef: this.mission()?.config.baseRef,
        computerId: deps.engine.computerId,
        workerPref: deps.engine.workerPref,
        jobs: deps.engine.jobs,
        askBeforePr: deps.engine.askBeforePr,
        settings: deps.engine.settings,
        missionId: this.missionId,
        approvedPlan: this.mission()?.config.approvedPlan,
        approvedGoal: this.mission()?.goal,
        beforeSessionDispatch: () => this.saveBeforeFactoryPost(),
        clients: wrapped,
      },
    )
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Restore the mission's last-known engine working state and boot. Returns
   * true when the mission is ready to observe (nothing to adopt, or the
   * snapshot was adopted). False means a snapshot existed and the engine
   * refused it (its worker setup differs from this boot's configuration), so
   * the mission is running on a fresh engine — reported honestly instead of
   * presented as a resume.
   */
  start(): boolean {
    const snapshot = this.persistedSnapshot()
    let adopted = false
    if (snapshot === null) {
      // A mission that never got an engine snapshot (the launch never landed,
      // or the process died before the first write): starting clean is correct,
      // and the supervisor resumes its command from the durable mission goal.
      adopted = true
    } else {
      this.engine.restore(snapshot)
      const live = this.snapshot
      adopted =
        snapshot.goal !== '' &&
        live.goal === snapshot.goal &&
        (snapshot.sessionId === null || live.sessionId === snapshot.sessionId)
      this.restoreRefusedFlag = !adopted
      if (!adopted) {
        console.warn(`[runtime] mission ${this.missionId}: engine snapshot refused (worker setup changed)`)
      }
    }
    this.engine.boot()
    this.dirty = true
    const mission = this.mission()
    if (mission !== null && !this.isTerminal(mission)) {
      // A restored mission reconciles before it can launch (spec §8 step 7);
      // its freshness says "not confirmed against the provider yet".
      this.setFreshness(adopted ? 'reconciling' : 'unknown')
    }
    this.reassertPause()
    // A cancellation whose requests were still in flight when the previous
    // generation died resumes its requests here: the confirmation must state
    // what THIS generation observed, never a fabricated "accepted".
    if (this.mission()?.control === 'cancel_requested') this.resumeCancelRequests()
    this.maybeSaveSnapshot(true)
    return adopted
  }

  get restoreRefused(): boolean {
    return this.restoreRefusedFlag
  }

  get snapshot(): RealSnapshot {
    return this.engine.snapshot() as RealSnapshot
  }

  get presentation() {
    const snap = this.snapshot
    return { ...legacyPresentation(snap), questionIdentity: snap.decisionPending ? decisionIdentity(snap) : null,
      hasUnconfirmedDelivery: this.hasUnconfirmedDelivery }
  }

  /** Terminal summary observation must not be retired on the first PR fact. */
  get observationPending(): boolean {
    return this.store.current.cursors[`runtime.finalization.${this.missionId}.status`] !== 'incomplete' &&
      this.snapshot.phase === 'final' &&
      (this.snapshot.awaiting === 'summary' || this.snapshot.finalSummary === '')
  }

  get currentView(): EngineView {
    const view = this.engine.currentView
    // A paused mission's failure card: Retry would only be refused (launches
    // wait for Resume), so the card offers Resume where Retry was.
    const control = this.control()
    if ((control === 'paused' || control === 'pause_requested') && view.type === 'scene' &&
      view.scene.kind === 'factory_error' && view.scene.actions.some(a => a.id === 'retry')) {
      return { ...view, scene: { ...view.scene, actions: view.scene.actions.map(a =>
        a.id === 'retry' ? { id: 'resume', label: 'Resume', kind: 'command' as const } : a) } }
    }
    return view
  }

  get hasNavigationLayer(): boolean {
    return this.engine.hasNavigationLayer
  }

  get missionRecord(): Mission | null {
    return this.mission()
  }

  /** One scheduling/observation step. Observation is never capacity-gated. */
  tick(now = this.now()): void {
    if (this.disposed) return
    const deadline = this.store.current.cursors[`runtime.finalization.${this.missionId}.deadline`]
    if (this.snapshot.phase === 'final' && deadline && this.now() >= Date.parse(deadline)) {
      this.syncDomain()
      this.maybeSaveSnapshot(false, now)
      return
    }
    this.engine.tick(now)
    this.retrySuppressedStep()
    this.startApprovedBuild()
    this.syncDomain()
    this.syncRuns()
    this.adoptEngineRepository()
    this.settleControl()
    this.maybeSaveSnapshot(false, now)
  }

  /**
   * Record the repository the engine created for a "New repo" mission, once
   * it exists. The engine only learns the URL after the create lands, and the
   * mission config is the durable fact the projects home, the archive row, and
   * a restore all read — leaving it empty would report a mission that built
   * nowhere and hand a restored mission no repository.
   */
  private adoptEngineRepository(): void {
    const mission = this.mission()
    if (mission === null) return
    if (mission.config.repository !== '' || mission.config.newRepository !== true) return
    const created = this.snapshot.missionRepo
    if (created === '') return
    this.enqueue(() =>
      this.store.commit((s) => {
        const idx = s.missions.findIndex((m) => m.missionId === this.missionId)
        if (idx === -1) return null
        const current = s.missions[idx]
        if (current.config.repository !== '') return null
        const missions = [...s.missions]
        missions[idx] = {
          ...current,
          config: { ...current.config, repository: created },
          updatedAt: nowIso(),
        }
        return { state: { ...s, missions }, events: [] }
      }),
    )
  }

  /**
   * A step the runtime refused left the engine on the runtime's OWN marker,
   * not a provider failure. Once the mission is running again, permitted by
   * policy, and holds capacity, that step is retried exactly once (the retry
   * clears the marker, so this cannot loop) — and never before, so a queued
   * mission cannot launch past the scheduler.
   */
  private retrySuppressedStep(): void {
    const mission = this.mission()
    if (mission === null || mission.control !== 'running') return
    if (!SUPPRESSION_FAULT_KINDS.includes(this.snapshot.faultKind ?? '')) return
    if (!this.canLaunch() || !this.launchPermitted()) return
    this.engine.handleAction('retry')
    this.afterInput()
  }

  /**
   * A mission whose start the owner approved at its source (an X post)
   * builds as soon as its plan lands, instead of waiting on a Start tap
   * nobody is there to give. It is checked every tick, so a plan that landed
   * while paused, unadmitted, or before a relaunch starts once it may — and
   * never before: the same control, admission, and policy checks as a tap.
   */
  private startApprovedBuild(): void {
    const mission = this.mission()
    if (mission === null || mission.config.startApproved !== true) return
    if (this.snapshot.requiresFreshApproval === true) return // source approval was revoked by base/scope observation
    if (mission.control !== 'running' || this.isTerminal(mission)) return
    if (!this.canLaunch() || !this.launchPermitted()) return
    if (this.engine.beginApproved()) this.afterInput()
  }

  /**
   * Re-attempt a step a previous runtime generation refused (a pause or a
   * narrowed policy left its marker on the engine). The caller checks
   * admission first: this must never launch past the scheduler.
   */
  retryRefusedStep(): boolean {
    if (this.disposed) return false
    if (!this.canLaunch() || !this.launchPermitted()) return false
    if (!SUPPRESSION_FAULT_KINDS.includes(this.snapshot.faultKind ?? '')) return false
    this.engine.handleAction('retry')
    this.afterInput()
    return true
  }

  /** True while the engine is sitting on one of the runtime's own refusals. */
  get suppressedStepPending(): boolean {
    return SUPPRESSION_FAULT_KINDS.includes(this.snapshot.faultKind ?? '')
  }

  /** Await every commit this actor has started (tests and shutdown). */
  async flush(): Promise<void> {
    await this.chain
    this.maybeSaveSnapshot(true)
    await this.chain
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.maybeSaveSnapshot(true)
  }

  private isTerminal(mission: Mission): boolean {
    return isTerminalMission(mission)
  }

  /**
   * The last gate before a launch leaves this host. Control mode (pause,
   * cancel), policy, and terminal state are enforced here as well as at the
   * action boundary, because the engine also launches from inside its own
   * pipeline (a repair run, integration, the PR stage) or from a typed gate
   * approval — not only from owner actions. Worker launches are also gated
   * by scheduler admission here (the action boundary is the primary, UX
   * path; this seam is what a say("yes") or an engine-started repair
   * actually goes through, spec §14). Existing Factory worker execution
   * posts use this same gate; ordinary messages and result refreshes do not.
   * The lead session is exempt (the lead
   * conversation is observation + steering, not a worker slot).
   */
  private assertLaunchAllowed(kind: string): void {
    const mission = this.mission()
    if (mission === null) throw new LaunchSuppressedError('terminal', kind)
    if (isTerminalMission(mission)) throw new LaunchSuppressedError('terminal', kind)
    if (this.pendingControl) throw new LaunchSuppressedError(this.pendingControl.reason, kind)
    if (!this.launchPermitted()) throw new LaunchSuppressedError('policy', kind)
    if (mission.control === 'pause_requested' || mission.control === 'paused') {
      throw new LaunchSuppressedError('paused', kind)
    }
    if (mission.control === 'cancel_requested') throw new LaunchSuppressedError('cancelling', kind)
    // Worker launches cannot slip past the scheduler through paths that do
    // not go through the action boundary: a typed "yes" at a gate, a decision
    // answer, an engine-started repair. The seam gates them by admission too
    // (spec §14), and the runtime retries the step once the mission is
    // admitted. The lead session is exempt: the lead conversation is the
    // mission's backbone and observation path, not a worker slot.
    if (kind !== 'factory.session' && !this.canLaunch()) {
      throw new LaunchSuppressedError('capacity', kind)
    }
  }

  // -------------------------------------------------------------- commands

  /**
   * Route a HUD/phone action. Launch actions are gated by control mode
   * (dropped) and by scheduler admission (queued), never by which mission the
   * owner happens to be looking at.
   */
  handleAction(id: string): ActionOutcome {
    if (this.disposed) return { kind: 'rejected', reason: 'unknown_action' }
    if (this.snapshot.nativeQuestion && (id === 'use_it' || id === 'open_pr')) return { kind: 'rejected', reason: 'unknown_action' }
    if (id === 'pause') return this.pause()
    if (id === 'resume') return this.resume()
    if (id === 'restart') {
      const mission = this.mission()
      // A finished mission is never rewritten into a cancellation: the surface
      // starts a new mission instead (its records stay as they were).
      if (mission === null || this.isTerminal(mission)) return { kind: 'dropped', reason: 'terminal' }
      // Otherwise the v2 runtime never resets a mission in place: a restart
      // ends this mission (keeping its records and evidence) and the surface
      // starts a new one, so nothing is silently reused under a new goal.
      this.cancel()
      return { kind: 'forwarded' }
    }
    const control = this.control()
    const mission = this.mission()
    if (mission !== null && this.isTerminal(mission) && LAUNCH_ACTIONS.includes(id)) {
      // A terminal mission takes no further worker, integration, or approval
      // action; its records and evidence stay readable.
      return { kind: 'dropped', reason: 'terminal' }
    }
    if (control === 'cancel_requested' && LAUNCH_ACTIONS.includes(id)) {
      return { kind: 'dropped', reason: 'cancelling' }
    }
    if ((control === 'paused' || control === 'pause_requested') && LAUNCH_ACTIONS.includes(id)) {
      return { kind: 'dropped', reason: 'paused' }
    }
    if (CAPACITY_ACTIONS.includes(id) && !this.canLaunch()) {
      this.onActionHeld(this.missionId, id)
      return { kind: 'held', reason: 'capacity' }
    }
    if (
      this.engine.hasPendingDecision &&
      (id === 'use_it' || (id === 'open_pr' && this.snapshot.decisionKind === 'pr'))
    ) {
      // A provider reply can surface the question between ticks, so its open
      // record may not exist yet — exactly like a spoken answer, queue the
      // record BEFORE the tap resolves the question (say/declineGate/
      // chooseDecisionList already pre-sync for this reason). Without it the
      // approval is journaled nowhere and its capture lingers in memory,
      // where a later question's close could inherit it as an invented
      // "proceed".
      this.syncDomain()
      this.decisionAnswer = { optionId: 'proceed', answerText: null, outcome: 'answered', questionIdentity: decisionIdentity(this.snapshot), legacyDecisionId: this.legacyDecisionId() }
    }
    this.engine.handleAction(id)
    this.afterInput()
    return { kind: 'forwarded' }
  }

  /** Typed phone text. Returns 'none' while the mission cannot take input. */
  say(text: string): 'goal' | 'steer' | 'decision' | 'none' {
    if (!this.acceptsInput) return 'none'
    // A provider reply can surface a question between ticks, so its open
    // record may not exist yet: queue it before the words resolve the
    // question, exactly like a tapped option. Otherwise a spoken answer (the
    // common path — free speech goes to say at a pending question) closes a
    // question the journal never opened: no record, no answer, nothing for
    // a relaunch to read.
    if (this.engine.hasPendingDecision) this.syncDomain()
    const hadPending = this.engine.hasPendingDecision
    const questionIdentity = decisionIdentity(this.snapshot)
    const legacyDecisionId = this.legacyDecisionId()
    const where = this.engine.say(text)
    if (hadPending && !this.engine.hasPendingDecision) {
      // The owner's words settled the pending question (a gate "yes"/"no", a
      // free-form answer). The record states what was actually said, not a
      // guess — and a capacity-suppressed launch still leaves the approval
      // durable, because the engine clears the question before launching.
      this.decisionAnswer = { optionId: null, answerText: text, outcome: 'answered', questionIdentity, legacyDecisionId }
    }
    this.afterInput()
    return where
  }

  /**
   * The owner refused the pending start/PR gate ("no", "not yet", "later"):
   * record the refusal and clear the gate. True when it acted. The CALLER
   * ends the mission (a refused gate is a dead end — nothing will ever start
   * the build or open its PR — so the record must not sit on a plan that can
   * never start, and a new goal must begin a fresh mission instead of
   * silently steering a session that will not run).
   */
  declineGate(text: string): boolean {
    if (this.disposed || !this.acceptsInput) return false
    if (!this.engine.hasPendingDecision) return false
    const snap = this.snapshot
    if (!snap.decisionGate || !isGateDecline(text)) return false
    // A question surfaced between ticks may not have its open record yet
    // (a provider reply can land after a tick's sync): queue the open first,
    // then journal the refusal onto it at commit time — the same guarantee a
    // tapped option gets. The refusal is the question's honest answer on the
    // record (never a silent clear, never an invented approval), and the
    // session chat keeps the owner's words with the question they refused.
    this.syncDomain()
    this.closeOpenDecision(text)
    this.engine.declinePendingGate(text)
    this.afterInput()
    return true
  }

  /**
   * Close this mission's open decision with the owner's refusal. The open
   * record is found at COMMIT time, not call time: a question that surfaced
   * between ticks may have its open record still queued ahead of this on the
   * chain (declineGate syncs it first). FIFO ordering is the guarantee.
   */
  private closeOpenDecision(text: string): void {
    this.enqueue(() =>
      this.store.commit((s) => {
        const open = s.decisions.find((d) => d.missionId === this.missionId && d.answeredAt === null)
        if (open === undefined) return null
        return {
          state: {
            ...s,
            decisions: s.decisions.map((d) =>
              d.decisionId === open.decisionId
                ? { ...d, answeredAt: nowIso(), answerOptionId: null, answerText: text }
                : d,
            ),
          },
          events: [
            draftEvent(
              'decision_answered',
              { decisionId: open.decisionId, outcome: 'declined', optionId: null },
              { entityId: s.entity.entityId, missionId: this.missionId },
            ),
          ],
        }
      }),
    )
  }

  /**
   * Seed a freshly created mission's goal and start it (spec §10: the
   * durable receipt happened already; this is the "gathering context ->
   * plan" step). A mission created as "New repo" starts by CREATING its
   * repository; every other mission starts by planning. Returns false when
   * the mission is not in a state to take a goal, which the supervisor
   * reports instead of silently dropping it.
   */
  beginGoal(text: string): boolean {
    if (!this.acceptsInput || !this.engine.acceptsGoal()) return false
    this.engine.voiceGoal(text, 0)
    const config = this.mission()?.config
    if (config?.newRepository === true) {
      // The durable intent decides the start action, so a relaunch resumes
      // the create (resumeUnstarted calls this too) instead of planning on
      // the default repository.
      this.engine.startNewRepo(config.newRepositoryName ?? '')
    } else {
      this.engine.handleAction('start_planning')
    }
    this.afterInput()
    return true
  }

  /**
   * Typed goal from the phone that should build in a brand-new repository.
   * On a mission with a live session this is steering, exactly like any
   * other new goal; otherwise the engine takes the goal and creates the repo.
   */
  sayNewRepo(text: string, name: string): 'goal' | 'steer' | 'none' {
    if (!this.acceptsInput) return 'none'
    const where = this.engine.sayNewRepo(text, name)
    this.afterInput()
    return where
  }

  voiceGoal(text: string, sec: number): 'goal' | 'steer' | 'none' {
    if (!this.acceptsInput) return 'none'
    const wasAccepted = this.engine.acceptsGoal()
    this.engine.voiceGoal(text, sec)
    this.afterInput()
    return wasAccepted ? 'goal' : 'steer'
  }

  transcriptGoal(sec: number): void {
    if (!this.acceptsInput) return
    this.engine.transcriptGoal(sec)
    this.afterInput()
  }

  steer(text: string): boolean {
    if (!this.acceptsInput) return false
    const took = this.engine.steer(text)
    if (took) this.afterInput()
    return took
  }

  get followupReady(): boolean { return this.acceptsInput && this.engine.followupReady }

  async sendFollowup(text: string, allowed: () => boolean): Promise<'sent' | 'deferred' | 'unknown'> {
    if (!this.acceptsInput || !allowed()) return 'deferred'
    const result = await this.engine.sendFollowup(text, () => this.acceptsInput && allowed())
    if (result === 'sent') this.afterInput()
    return result
  }

  /** Pause suppresses follow-up and approval input (spec §7); so does a
   * terminal phase: no words can steer a mission that has already ended. */
  get acceptsInput(): boolean {
    const mission = this.mission()
    return !this.disposed && mission !== null && !this.isTerminal(mission) && this.control() === 'running'
  }

  chooseGoalList(index: number): 'talk' | 'done' {
    return this.engine.chooseGoalList(index)
  }

  chooseDecisionList(index: number): 'talk' | 'done' {
    if (!this.acceptsInput) return 'done'
    // Capture the visible option before the engine clears the list so the
    // durable decision records what the owner actually chose.
    const view = this.engine.currentView
    const option =
      this.engine.hasPendingDecision &&
      view.type === 'selection' &&
      view.purpose === 'decision' &&
      Number.isInteger(index) &&
      index >= 0 &&
      index < view.items.length - 1
        ? view.items[index]
        : null
    // A provider reply can show the question between ticks. Queue its open
    // record before resolving it so a quick tap cannot skip the journal.
    if (option !== null) this.syncDomain()
    const questionIdentity = decisionIdentity(this.snapshot)
    const legacyDecisionId = this.legacyDecisionId()
    const where = this.engine.chooseDecisionList(index)
    if (where === 'done' && option !== null && !this.engine.hasPendingDecision) {
      this.decisionAnswer = { optionId: null, answerText: `The owner chose: ${option}`, outcome: 'answered', questionIdentity, legacyDecisionId }
    }
    this.afterInput()
    return where
  }

  chooseList(index: number): void {
    this.engine.chooseList(index)
    this.afterInput()
  }

  back(): 'exit' | 'handled' {
    const where = this.engine.back()
    if (where === 'handled') this.afterInput()
    return where
  }

  talkStatus(): void {
    this.engine.talkStatus()
  }

  listBuilds(): Array<{ title: string; note: string; kind: 'local' | 'factory' | 'cursor' }> {
    return this.engine.listBuilds()
  }

  openBuild(index: number): boolean {
    const opened = this.engine.openBuild(index)
    if (opened) this.afterInput()
    return opened
  }

  acceptsGoal(): boolean {
    return this.acceptsInput && this.engine.acceptsGoal()
  }

  canPause(): boolean {
    return this.control() === 'running' && this.engine.canPause()
  }

  canResume(): boolean {
    const control = this.control()
    return (control === 'paused' || control === 'pause_requested') && !this.engine.canPause()
  }

  canExplain(): boolean {
    return this.engine.canExplain()
  }

  get hasPendingDecision(): boolean {
    return this.engine.hasPendingDecision
  }

  /** The mission's chat log, oldest first (goal, questions, answers, replies). */
  chatLog(): Array<{ who: ChatWho; text: string; at: number }> {
    return this.engine.chatLog()
  }

  nativeQuestionLink(): string | null {
    return this.engine.nativeQuestionLink()
  }
  factorySessionLink(): string | null {
    return this.engine.factorySessionLink()
  }
  get hasUnconfirmedDelivery(): boolean { return this.engine.hasUnconfirmedDelivery }

  private afterInput(): void {
    this.syncDomain()
    this.syncRuns()
    this.settleControl()
    this.maybeSaveSnapshot(false, this.now())
  }

  // ---------------------------------------------------------------- control

  /**
   * Pause (spec §7): record the intent durably FIRST, suppress launches, send
   * a supported interrupt request, and keep observing. Nothing here claims the
   * remote work stopped; `pause_confirmed` lands once no dispatch of this
   * mission is still in flight.
   */
  pause(): ActionOutcome {
    const mission = this.mission()
    if (mission === null || this.isTerminal(mission)) return { kind: 'rejected', reason: 'unknown_action' }
    if (mission.control === 'paused' || mission.control === 'pause_requested' ||
      this.pendingControl?.reason === 'paused') {
      return { kind: 'rejected', reason: 'duplicate_pause' }
    }
    if (mission.control === 'cancel_requested' || this.pendingControl?.reason === 'cancelling') {
      // A cancellation outranks a pause. Pausing here would overwrite the
      // durable cancel intent and let a later resume resurrect work the owner
      // asked to stop (spec §7).
      return { kind: 'rejected', reason: 'cancelling' }
    }
    const pending = { reason: 'paused' as const }
    this.pendingControl = pending
    const intent = this.patchControl('pause_requested', 'pause_requested', {}, [], {}, ['running'])
    const settled = () => { if (this.pendingControl === pending) this.pendingControl = null }
    void intent.then(settled, settled)
    // Interrupt is a REQUEST: an unacknowledged interrupt is not proof the
    // remote job stopped, so freshness stays honest about being unconfirmed.
    if (this.engine.canPause()) this.engine.pauseToggle()
    this.maybeSaveSnapshot(false, this.now())
    // The confirmation lands once the intent commit is durable and no dispatch
    // of this mission is still in flight (the chained step runs after it).
    this.enqueue(async () => this.settleControl())
    return { kind: 'forwarded' }
  }

  /**
   * Resume (spec §7): an explicit command, the only thing that clears a pause.
   * Freshness goes to `reconciling` until a provider observation lands.
   */
  resume(): ActionOutcome {
    const mission = this.mission()
    if (mission === null) return { kind: 'rejected', reason: 'unknown_action' }
    if (mission.control !== 'paused' && mission.control !== 'pause_requested') {
      return { kind: 'rejected', reason: 'unknown_action' }
    }
    if (this.engine.canResume()) this.engine.pauseToggle()
    this.patchControl('running', 'resume_confirmed', { freshness: 'reconciling' }, ['resume_requested'], {}, [
      'paused',
      'pause_requested',
    ])
    // A follow-up the pause refused is retried by the next tick, once capacity
    // is held again (an admission-queued mission waits its turn like any other).
    this.maybeSaveSnapshot(false, this.now())
    return { kind: 'forwarded' }
  }

  /**
   * Cancel (spec §7): one cancellation request per known run, then a terminal
   * record that states its own basis. The mission is never described as "all
   * work stopped" unless every request was accepted and nothing is unknown.
   */
  cancel(): void {
    const mission = this.mission()
    if (mission === null || this.isTerminal(mission) || mission.control === 'cancel_requested' ||
      this.pendingControl?.reason === 'cancelling') {
      // A finished mission is never rewritten into a cancellation: its terminal
      // record and evidence stay as they were (spec §7).
      return
    }
    const targets = this.cancelTargets()
    this.cancellationFailures = []
    this.cancellationClaims.clear()
    this.cancellationTargetsSent = targets.map((t) => t.runId)
    this.cancellationSettled = targets.length === 0
    const pending = { reason: 'cancelling' as const }
    this.pendingControl = pending
    // The intent is durable before any request goes out, and the requests go
    // out only if this commit actually transitioned the control mode: a
    // duplicate tap (or a resume that landed first) declines the
    // compare-and-set, so it neither journals a second intent nor re-sends
    // interrupts (spec §7, §10).
    void (async () => {
      let intent: CommitResult
      try {
        intent = await this.patchControl(
          'cancel_requested',
          'cancel_requested',
          { freshness: 'reconciling' },
          [],
          {},
          ['running', 'paused', 'pause_requested'],
        )
      } finally {
        if (this.pendingControl === pending) this.pendingControl = null
      }
      if (intent.ok !== true) return
      await this.requestCancellations(targets)
    })()
  }

  private cancelTargets(): CancelTarget[] {
    const out: CancelTarget[] = []
    const state = this.store.current
    const mission = this.mission()
    if (mission === null) return out
    for (const runId of mission.activeRunIds) {
      const run = state.runs[runId]
      if (!run) continue
      out.push({
        runId,
        provider: run.provider,
        sessionId: run.provider === 'factory' ? run.sessionOrAgentId : null,
        agentId: run.provider === 'cursor' ? run.sessionOrAgentId : null,
        remoteRunId: run.remoteRunId,
        role: run.role,
      })
    }
    // The engine can learn a remote id before its run observation is durable.
    const snap = this.snapshot
    for (const c of runCandidates(snap, mission)) {
      if (!c.active) continue
      out.push({
        runId: `${c.provider}:${c.sessionOrAgentId}:${c.remoteRunId ?? ''}`,
        provider: c.provider,
        sessionId: c.provider === 'factory' ? c.sessionOrAgentId : null,
        agentId: c.provider === 'cursor' ? c.sessionOrAgentId : null,
        remoteRunId: c.remoteRunId,
        role: c.role,
      })
    }
    // Confirm is durable BEFORE the create promise resumes the engine. This
    // also closes the crash window where that engine snapshot never landed.
    for (const d of state.outbox) {
      if (d.missionId !== this.missionId || d.state !== 'confirmed' || !d.remoteIds[0]) continue
      const factory = d.requestKey.includes(':factory.session:') || d.requestKey.includes(':factory.worker_session:')
      const cursor = d.requestKey.includes(':cursor.agent:')
      if (!factory && !cursor) continue
      const id = d.remoteIds[0]
      // Do not interrupt historical, already-finished runs solely because
      // their launch receipts are retained. Unobserved receipts still count.
      if (Object.values(state.runs).some(r => r.missionId === this.missionId &&
          r.sessionOrAgentId === id) ||
          snap.jobs.some(j => (j.sessionId === id || j.agentId === id) &&
            (j.state === 'accepted' || j.state === 'stopped'))) continue
      out.push({
        runId: `dispatch:${d.actionId}`,
        provider: factory ? 'factory' : 'cursor',
        sessionId: factory ? id : null,
        agentId: cursor ? id : null,
        remoteRunId: cursor ? d.remoteIds[1] ?? null : null,
        role: d.requestKey.includes(':factory.session:') ? 'lead' : 'worker',
      })
    }
    const unique = new Map<string, CancelTarget>()
    for (const t of out) {
      const key = this.cancelTargetKey(t)
      if (!unique.has(key)) unique.set(key, t)
    }
    return [...unique.values()]
  }

  private cancelTargetKey(t: CancelTarget): string {
    return `${t.provider}:${t.sessionId ?? t.agentId ?? ''}:${t.remoteRunId ?? ''}`
  }

  private unresolvedCancelDispatches(): string[] {
    const snap = this.snapshot
    return this.store.current.outbox.filter(d => d.missionId === this.missionId &&
      (d.state === 'unknown' || (d.state === 'confirmed' && d.requestKey.includes(':cursor.run:') &&
        !snap.jobs.some(j => j.runId === d.remoteIds[0]) &&
        !Object.values(this.store.current.runs).some(r => r.missionId === this.missionId &&
          r.remoteRunId === d.remoteIds[0]))))
      .map(d => `dispatch:${d.actionId}:remote cleanup could not be confirmed`)
  }

  /**
   * Re-send the cancellation requests a restart interrupted. The previous
   * generation's in-memory bookkeeping (which requests went out, which
   * failed) died with it, so a fresh actor must not confirm a cancellation
   * it never asked for: every known active run gets one more interrupt
   * request (they are idempotent asks, never assumed to have landed), and
   * the eventual confirmation records this generation's own story (spec §7,
   * §8 — "never claim the run stopped").
   */
  private resumeCancelRequests(): void {
    const targets = this.cancelTargets()
    this.cancellationFailures = []
    this.cancellationClaims.clear()
    this.cancellationTargetsSent = targets.map((t) => t.runId)
    this.cancellationSettled = targets.length === 0
    if (targets.length === 0) {
      this.settleControl()
      return
    }
    void this.requestCancellations(targets)
  }

  /**
   * Cancellation requests go out unwrapped: they are not launches, and the
   * outbox guards launches only (spec §7 "send supported remote cancellation
   * requests"). Every outcome is recorded, including the failures. Each
   * request is bounded by a timeout: an unresponsive provider must not hang
   * the confirmation forever — a timed-out request is honestly recorded as
   * unresolved, never assumed accepted.
   */
  private async requestCancellations(targets: CancelTarget[]): Promise<void> {
    targets = targets.filter(t => !this.cancellationClaims.has(this.cancelTargetKey(t)))
    if (targets.length === 0) return
    this.cancellationSettled = false
    // Claim synchronously before the first await: ticks cannot double-send.
    for (const t of targets) {
      this.cancellationClaims.add(this.cancelTargetKey(t))
      if (!this.cancellationTargetsSent.includes(t.runId)) this.cancellationTargetsSent.push(t.runId)
    }
    const failed: string[] = []
    await Promise.all(targets.map(async (t) => {
      const label = `${t.provider}:${t.runId}`
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const request = (() => {
          if (t.provider === 'factory' && t.sessionId !== null) return this.clients.interrupt(t.sessionId)
          if (t.provider === 'cursor' && t.agentId !== null) {
            return this.clients.cursorCancel(t.agentId, t.remoteRunId ?? '')
          }
          return Promise.resolve()
        })()
        await Promise.race([
          request,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('cancellation request timed out')), CANCELLATION_TIMEOUT_MS)
          }),
        ])
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e)
        failed.push(`${label}:${why}`)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }))
    if (failed.length > 0) {
      console.warn(`[runtime] mission ${this.missionId}: ${failed.length} cancellation request(s) failed`)
    }
    this.cancellationFailures.push(...failed)
    // Only now are the requests settled: until this point an empty failure list
    // means "not sent yet", which is not the same fact as "all accepted".
    this.cancellationSettled = true
    this.settleControl()
  }

  /**
   * Advance control mode when its durable preconditions hold:
   *  - pause_requested -> paused once no dispatch of this mission is in flight;
   *  - cancel_requested -> cancelled once the requests have SETTLED, with the
   *    unresolved remainder recorded on the confirmation event. The
   *    confirmation is once-only, and every transition is a compare-and-set
   *    at commit time, so a decision made on stale state can never overwrite
   *    a newer intent (a resume, a second cancel, a completion).
   */
  private settleControl(): void {
    const mission = this.mission()
    if (mission === null || mission.phase === 'cancelled') return
    const inFlight = this.inFlightDispatches()
    if (mission.control === 'pause_requested' && inFlight.length === 0) {
      this.patchControl('paused', 'pause_confirmed', {}, [], {}, ['pause_requested'])
      return
    }
    if (mission.control === 'cancel_requested' && this.cancellationSettled && inFlight.length === 0) {
      const late = this.cancelTargets().filter(t => !this.cancellationClaims.has(this.cancelTargetKey(t)))
      if (late.length > 0) {
        void this.requestCancellations(late)
        return
      }
      if (this.isTerminal(mission)) {
        // The mission finished before the cancellation landed (the requests
        // raced a run that was already done). The terminal record stays
        // exactly as it is — a delivered result is never rewritten into a
        // cancellation — and the journal states what actually happened.
        this.commitCancelConfirm('running', {}, {
          basis: 'requests_superseded',
          requestedRuns: this.cancellationTargetsSent,
          unresolved: [...this.cancellationFailures, ...this.unresolvedCancelDispatches()],
          note: 'the mission finished before the cancellation requests landed',
        })
        return
      }
      const unresolved = [...this.cancellationFailures, ...this.unresolvedCancelDispatches()]
      // The phase is terminal either way. Control only returns to `running`
      // when nothing is left outstanding; a partial cancellation keeps the
      // outstanding request visible (spec §7: a terminal mission can carry an
      // unresolved provider cleanup warning).
      this.commitCancelConfirm(
        unresolved.length === 0 ? 'running' : 'cancel_requested',
        {
          phase: 'cancelled',
          // A terminal mission carries no live runs into its permanent
          // record: the confirm is the last commit that can touch them
          // (terminal missions are never ticked again).
          activeRunIds: [],
          freshness: unresolved.length === 0 ? 'current' : 'unknown',
        },
        {
          basis: unresolved.length === 0 ? 'requests_accepted' : 'requests_partial',
          requestedRuns: this.cancellationTargetsSent,
          unresolved,
          note:
            unresolved.length === 0
              ? 'cancellation requests were accepted by the providers'
              : 'remote work may still be running: cancellation requests did not all succeed',
        },
      )
      // A terminal mission leaves no decision open: an answer to it could only
      // be recorded, never acted on.
      this.closeOpenDecisions('closed')
    }
  }

  /**
   * The one-shot cancel confirmation. Compare-and-set on the control mode AND
   * a once-only guard on the phase, both checked AT COMMIT TIME: for a partial
   * cancellation the control mode legitimately stays 'cancel_requested', so a
   * second settle enqueued behind the first would otherwise pass the
   * control check too — the phase guard is what makes the confirmation
   * durable exactly once.
   */
  private commitCancelConfirm(
    control: Mission['control'],
    extra: Partial<Mission>,
    payload: Record<string, unknown>,
  ): void {
    this.enqueue(() =>
      this.store.commit((s) => {
        const idx = s.missions.findIndex((m) => m.missionId === this.missionId)
        if (idx === -1) return null
        const m = s.missions[idx]
        if (m.control !== 'cancel_requested' || m.phase === 'cancelled') return null
        // A confirm queued before a newer durable launch outcome cannot
        // outrun its cleanup. The next tick reconciles the newly known ids.
        if (!this.cancellationSettled || this.inFlightDispatches().length > 0 ||
            this.cancelTargets().some(t => !this.cancellationClaims.has(this.cancelTargetKey(t)))) return null
        const missions = [...s.missions]
        missions[idx] = { ...m, ...extra, control, updatedAt: nowIso() }
        return {
          state: { ...s, missions },
          events: [
            draftEvent('cancel_confirmed', payload, { entityId: s.entity.entityId, missionId: this.missionId }),
          ],
        }
      }),
    )
  }

  private inFlightDispatches(): string[] {
    return this.store.current.outbox
      .filter((d) => d.missionId === this.missionId && (d.state === 'prepared' || d.state === 'sending'))
      .map((d) => d.actionId)
  }

  // -------------------------------------------------------------- decisions

  /**
   * Answer a decision by stable option id, rejecting a stale view (spec §20):
   * a decision opened against another plan revision, or already answered, is
   * not actionable. Free-form answers go through `say()`.
   */
  answerDecision(
    decisionId: string,
    optionId: string,
  ): 'answered' | 'stale' | 'missing' | 'unsupported' | 'blocked' {
    const state = this.store.current
    const mission = this.mission()
    if (mission === null) return 'missing'
    const decision = state.decisions.find((d) => d.decisionId === decisionId)
    if (decision === undefined || decision.missionId !== this.missionId) return 'missing'
    if (decision.answeredAt !== null) return 'stale'
    if (decision.revision !== mission.planRevision) return 'stale'
    if (this.isTerminal(mission)) return 'blocked'
    if (!this.acceptsInput) return 'blocked'
    // The durable record is open, but the engine's live question is what the
    // answer would resolve — if it is already gone (a steer settled it), the
    // answer is stale, not an approval.
    const snap = this.snapshot
    if (snap.nativeQuestion || decision.scope === 'factory_native') return 'unsupported'
    if (!this.engine.hasPendingDecision || !matchesDecision(decision, snap)) return 'stale'
    const labels = snap.planLabels.join('\u0000')
    if (labels && this.lastPlanLabels && labels !== this.lastPlanLabels) return 'stale'
    if (optionId !== 'proceed') return 'unsupported'
    if (!this.canLaunch()) {
      // An approval launches a worker run: unadmitted, it waits its turn
      // like any other launch and is replayed on admission (spec §14). The
      // decision record stays open until the replay actually approves it.
      this.onActionHeld(this.missionId, 'use_it')
      return 'blocked'
    }
    this.engine.handleAction('use_it')
    this.closeDecision(decisionId, 'proceed', null, 'answered')
    this.afterInput()
    return 'answered'
  }

  private closeDecision(
    decisionId: string,
    optionId: string | null,
    answerText: string | null,
    outcome: 'answered' | 'declined' | 'closed',
  ): void {
    this.enqueue(() =>
      this.store.commit((s) => {
        const idx = s.decisions.findIndex((d) => d.decisionId === decisionId)
        if (idx === -1 || s.decisions[idx].answeredAt !== null) return null
        const decisions = [...s.decisions]
        decisions[idx] = { ...decisions[idx], answeredAt: nowIso(), answerOptionId: optionId, answerText }
        return {
          state: { ...s, decisions },
          events: [
            draftEvent(
              'decision_answered',
              { decisionId, outcome, optionId },
              { entityId: s.entity.entityId, missionId: this.missionId },
            ),
          ],
        }
      }),
    )
  }

  /**
   * Journal-close every still-open decision of this mission with an explicit
   * outcome. Used when the mission becomes terminal: an open question on a
   * cancelled mission could only ever be recorded, never acted on, so it must
   * not linger as answerable.
   */
  private closeOpenDecisions(outcome: 'closed' | 'declined'): void {
    const missionId = this.missionId
    this.enqueue(() =>
      this.store.commit((s) => {
        const events: EventDraft[] = []
        const decisions = s.decisions.map((d) => {
          if (d.missionId !== missionId || d.answeredAt !== null) return d
          events.push(
            draftEvent(
              'decision_answered',
              { decisionId: d.decisionId, outcome, optionId: null },
              { entityId: s.entity.entityId, missionId },
            ),
          )
          return { ...d, answeredAt: nowIso(), answerOptionId: null, answerText: null }
        })
        if (events.length === 0) return null
        return { state: { ...s, decisions }, events }
      }),
    )
  }

  // ------------------------------------------------------------ domain sync

  /** Bind legacy attribution before the owner clears its current question. */
  private legacyDecisionId(): string | undefined {
    const mission = this.mission()
    const snap = this.snapshot
    const labels = snap.planLabels.join('\u0000')
    if (labels && this.lastPlanLabels && labels !== this.lastPlanLabels) return undefined
    return this.store.current.decisions.find((d) => d.missionId === this.missionId &&
      d.answeredAt === null && d.revision === mission?.planRevision &&
      d.questionIdentity === undefined && matchesDecision(d, snap))?.decisionId
  }

  /**
   * Map the engine's live state onto the durable mission record: phase,
   * decisions, plan revision, fault and freshness honesty. One commit per
   * change, and none at all when nothing moved.
   */
  private syncDomain(): void {
    const snap = this.snapshot
    this.enqueue(() =>
      this.store.commit((s) => {
        const idx = s.missions.findIndex((m) => m.missionId === this.missionId)
        if (idx === -1) return null
        const live = this.snapshot
        // A queued observation must not replace a newer question or rewind a plan.
        // Keep pending->cleared observations: inputs journal their open before close.
        if (snap.planLabels.join('\u0000') !== live.planLabels.join('\u0000') ||
            (live.decisionPending && (!snap.decisionPending || decisionIdentity(snap) !== decisionIdentity(live)))) return null
        const m = s.missions[idx]
        const now = nowIso()
        const events: EventDraft[] = []
        let next: Mission = m
        let decisions = s.decisions

        // (c) Plan revision: a changed accepted plan is a new revision, so a
        //     stale review can be rejected against it (spec §15).
        const labels = snap.planLabels.join('\u0000')
        if (labels !== '' && this.lastPlanLabels !== '' && labels !== this.lastPlanLabels) {
          next = { ...next, planRevision: next.planRevision + 1 }
          events.push(
            draftEvent(
              'plan_revised',
              { planRevision: next.planRevision, milestones: snap.planLabels.length },
              { entityId: s.entity.entityId, missionId: this.missionId },
            ),
          )
        }
        if (labels !== '') this.lastPlanLabels = labels

        // (a) Decisions: open on the engine's pending question; close any the
        //     engine cleared without this runtime answering it. A TERMINAL
        //     mission opens no new question: the engine's gate may linger on
        //     a dead mission, but its records are frozen (the terminal commit
        //     closed what was open, spec §7).
        const open = decisions.filter((d) => d.missionId === this.missionId && d.answeredAt === null)
        if (snap.decisionPending && !isTerminalMission(next)) {
          const superseded = open.filter((d) => d.revision !== next.planRevision || !matchesDecision(d, snap))
          if (superseded.length > 0) {
            const ids = new Set(superseded.map((d) => d.decisionId))
            decisions = decisions.map((d) => {
              if (!ids.has(d.decisionId)) return d
              // Answering one worker can immediately show the next question.
              // Attribute its captured answer only to the previous identity.
              const captured = this.decisionAnswer
              const answer = matchesCapturedDecision(d, captured) ? captured : null
              events.push(draftEvent('decision_answered',
                answer === null
                  ? { decisionId: d.decisionId, outcome: 'closed', optionId: null }
                  : { decisionId: d.decisionId, outcome: answer.outcome, optionId: answer.optionId, answerText: answer.answerText },
                { entityId: s.entity.entityId, missionId: this.missionId }))
              return { ...d, answeredAt: now, answerOptionId: answer?.optionId ?? null, answerText: answer?.answerText ?? null }
            })
            if (this.decisionAnswer?.questionIdentity !== decisionIdentity(snap)) this.decisionAnswer = null
          }
          if (open.length === superseded.length) {
            const record = buildDecision(this.missionId, next, snap, now)
            decisions = [...decisions, record]
            next = {
              ...next,
              phase: 'awaiting_decision',
              suspendedPhase: missionPhaseForEngine(snap.phase),
              decisionIds: [...next.decisionIds, record.decisionId],
            }
            events.push(
              draftEvent(
                'decision_opened',
                { decisionId: record.decisionId, kind: snap.decisionKind, revision: record.revision, gate: snap.decisionGate },
                { entityId: s.entity.entityId, missionId: this.missionId },
              ),
            )
          } else if (m.phase !== 'awaiting_decision') {
            next = { ...next, phase: 'awaiting_decision', suspendedPhase: missionPhaseForEngine(snap.phase) }
          }
        } else if (open.length > 0) {
          // The engine cleared the question on its own. If this runtime saw
          // HOW the owner resolved it (use_it/open_pr/answer text captured
          // before the engine cleared it), that is what the record states.
          // Otherwise the honest outcome is 'closed': resolved, but not by
          // anything this runtime can attribute — never invented as a refusal.
          decisions = decisions.map((d) => {
            if (d.missionId !== this.missionId || d.answeredAt !== null) return d
            const captured = this.decisionAnswer
            const answer = matchesCapturedDecision(d, captured) ? captured : null
            events.push(
              draftEvent(
                'decision_answered',
                answer === null
                  ? { decisionId: d.decisionId, outcome: 'closed', optionId: null }
                  : {
                      decisionId: d.decisionId,
                      outcome: answer.outcome,
                      optionId: answer.optionId,
                      answerText: answer.answerText,
                    },
                { entityId: s.entity.entityId, missionId: this.missionId },
              ),
            )
            return {
              ...d,
              answeredAt: now,
              answerOptionId: answer === null ? null : answer.optionId,
              answerText: answer === null ? null : answer.answerText,
            }
          })
          this.decisionAnswer = null
        } else if (!snap.decisionPending) {
          // No question pending and none open: a captured answer has nothing
          // left to name. Bounding the capture here means a later question
          // resolved by another path (a steer, a lead reply) can never
          // inherit an approval its question never earned.
          this.decisionAnswer = null
        }

        // (b) Phase: the engine drives the normal path; awaiting_decision holds
        //     until the question is settled, and a cancelled mission stays
        //     cancelled no matter what the engine shows afterwards.
        if (!snap.decisionPending && next.phase !== 'cancelled') {
          const enginePhase = missionPhaseForEngine(snap.phase)
          if (next.phase !== enginePhase) {
            events.push(
              draftEvent(
                enginePhase === 'completed' ? 'mission_completed' : 'run_observed',
                { enginePhase: snap.phase, phase: enginePhase },
                { entityId: s.entity.entityId, missionId: this.missionId },
              ),
            )
            next = { ...next, phase: enginePhase, suspendedPhase: null }
          }
        }

        // (d) Fault honesty: a provider fault is an operational blocker on a
        //     preserved phase, never a silent phase change (spec §7). The
        //     runtime's OWN refusals (pause, cancel, policy, capacity,
        //     terminal) are not provider events at all: they journal nothing
        //     here — the engine snapshot carries the marker, the retry is
        //     bookkept locally, and freshness is untouched by a launch that
        //     never went out.
        const suppression = SUPPRESSION_FAULT_KINDS.includes(snap.faultKind ?? '')
        const faultKey =
          snap.faultKind === null ? '' : `${snap.faultKind}:${snap.faultSource ?? ''}:${snap.faultRetry ?? ''}`
        if (faultKey !== '' && faultKey !== this.lastFaultKey) {
          this.lastFaultKey = faultKey
          this.lastFaultSuppressed = suppression
          if (!suppression) {
            events.push(
              draftEvent(
                'provider_connectivity_changed',
                {
                  provider: snap.faultSource ?? 'unknown',
                  kind: snap.faultKind,
                  retryable: snap.faultRetry !== null,
                  missionPhase: next.phase,
                },
                { entityId: s.entity.entityId, missionId: this.missionId },
              ),
            )
            next = { ...next, freshness: 'unknown' }
          }
        } else if (faultKey === '' && this.lastFaultKey !== '') {
          const wasSuppressed = this.lastFaultSuppressed
          this.lastFaultKey = ''
          this.lastFaultSuppressed = false
          if (!wasSuppressed) {
            events.push(
              draftEvent(
                'provider_connectivity_changed',
                { provider: snap.faultSource ?? 'unknown', kind: 'recovered' },
                { entityId: s.entity.entityId, missionId: this.missionId },
              ),
            )
          }
        }

        // (e) Freshness is evidence-based, not optimistic: "current" means a
        //     provider observation landed since reconciliation started and no
        //     check has failed. Nothing here invents a checked-at timestamp;
        //     the surfaces show the last observed time instead (spec §5).
        if (this.lastSuccessfulObservation !== null &&
          (next.lastObservedAt !== this.lastSuccessfulObservation ||
            (this.latestObservation === 'current' && faultKey === '' && next.freshness !== 'current'))) {
          next = { ...next, lastObservedAt: this.lastSuccessfulObservation,
            ...(faultKey === '' && this.latestObservation === 'current' ? { freshness: 'current' as const } : {}) }
        }
        if (this.latestObservation === 'unknown' && next.freshness !== 'unknown') {
          next = { ...next, freshness: 'unknown' }
        }

        let cursors = s.cursors
        if (snap.phase === 'final') {
          const prefix = `runtime.finalization.${this.missionId}`
          const status = s.cursors[`${prefix}.status`]
          if (!snap.finalSummary && !s.cursors[`${prefix}.deadline`]) {
            cursors = { ...cursors, [`${prefix}.deadline`]: new Date(this.now() + 120000).toISOString(),
              [`${prefix}.status`]: 'pending' }
          } else if (snap.finalSummary && status !== 'complete') {
            cursors = { ...cursors, [`${prefix}.status`]: 'complete' }
            events.push(draftEvent('run_observed', { finalization: 'complete', readOnly: true },
              { entityId: s.entity.entityId, missionId: this.missionId }))
          } else if (!snap.finalSummary && status !== 'incomplete' &&
            this.now() >= Date.parse(s.cursors[`${prefix}.deadline`] ?? '')) {
            cursors = { ...cursors, [`${prefix}.status`]: 'incomplete' }
            events.push(draftEvent('run_observed', { finalization: 'incomplete', readOnly: true,
              reason: 'summary_observation_deadline' }, { entityId: s.entity.entityId, missionId: this.missionId }))
          }
        }
        if (next === m && decisions === s.decisions && cursors === s.cursors) return null
        const missions = [...s.missions]
        missions[idx] = { ...next, updatedAt: now }
        return { state: { ...s, missions, decisions, cursors }, events }
      }),
    )
  }

  /**
   * Provider-run observation (spec §6, §26 phase 2 "adapter reconciliation"):
   * the engine snapshot IS the observation, applied here as durable run
   * records. Identity is the provider's own session/agent/run id, so a restart
   * re-observes the SAME run instead of minting a second one.
   */
  private syncRuns(): void {
    const snap = this.snapshot
    const mission = this.mission()
    if (mission === null) return
    const candidates = runCandidates(snap, mission)
    // `active` is part of the key: a mission going terminal deactivates its
    // runs without the engine snapshot moving, and that change must reach
    // the durable activeRunIds list.
    const key = candidates
      .map((c) => `${c.provider}:${c.role}:${c.sessionOrAgentId}:${c.remoteRunId ?? ''}:${c.observedState}:${c.active}:${
        this.runObservations.get(JSON.stringify(c.provider === 'factory' ? ['factory', c.sessionOrAgentId] :
          ['cursor', c.sessionOrAgentId, c.remoteRunId])) ?? ''}`)
      .join('|')
    if (key === this.lastRunsKey) return
    this.lastRunsKey = key
    this.enqueue(() =>
      this.store.commit((s) => {
        const runs: Record<string, ProviderRun> = { ...s.runs }
        const activeRunIds: string[] = []
        for (const c of candidates) {
          const existing = Object.values(runs).find(
            (r) =>
              r.missionId === this.missionId &&
              r.provider === c.provider &&
              r.sessionOrAgentId === c.sessionOrAgentId &&
              (c.remoteRunId === null || r.remoteRunId === null || r.remoteRunId === c.remoteRunId),
          )
          const runId = existing?.runId ?? mintId('run')
          runs[runId] = {
            schemaVersion: 2,
            runId,
            missionId: this.missionId,
            provider: c.provider,
            role: c.role,
            accountId: existing?.accountId ?? null,
            sessionOrAgentId: c.sessionOrAgentId,
            remoteRunId: c.remoteRunId ?? existing?.remoteRunId ?? null,
            branch: existing?.branch ?? '',
            baseSha: existing?.baseSha ?? '',
            currentSha: existing?.currentSha ?? '',
            observedState: c.observedState,
            lastObservedAt: this.runObservations.get(JSON.stringify(c.provider === 'factory' ? ['factory', c.sessionOrAgentId] :
              ['cursor', c.sessionOrAgentId, c.remoteRunId])) ?? existing?.lastObservedAt ?? null,
          }
          if (c.active) activeRunIds.push(runId)
        }
        const idx = s.missions.findIndex((m) => m.missionId === this.missionId)
        if (idx === -1) return null
        const missions = [...s.missions]
        // Terminal is re-read AT COMMIT TIME: the phase may have been settled
        // by an earlier commit on this chain (a cancellation), and a terminal
        // mission must not carry live runs into its permanent record.
        if (isTerminalMission(missions[idx])) activeRunIds.length = 0
        missions[idx] = { ...missions[idx], activeRunIds, updatedAt: nowIso() }
        return { state: { ...s, runs, missions }, events: [] }
      }),
    )
  }

  /** Remote ids the live engine already owns: the outbox must not reissue them. */
  private knownRemoteIds(): Set<string> {
    const out = new Set<string>()
    const snap = this.snapshot
    if (snap.sessionId !== null) out.add(snap.sessionId)
    for (const job of snap.jobs) {
      if (job.agentId !== null) out.add(job.agentId)
      if (job.runId !== null) out.add(job.runId)
      if (job.sessionId !== null) out.add(job.sessionId)
    }
    const attach = snap.attach
    if (attach) {
      if (attach.sessionId !== null) out.add(attach.sessionId)
      if (attach.agentId !== null) out.add(attach.agentId)
      if (attach.runId !== null) out.add(attach.runId)
    }
    return out
  }

  // ------------------------------------------------------------- snapshot

  private remoteIdSignature(): string {
    const snap = this.snapshot
    const ids: string[] = [snap.sessionId ?? '']
    for (const job of snap.jobs) ids.push(job.agentId ?? '', job.runId ?? '', job.sessionId ?? '')
    return ids.join(',')
  }

  /**
   * Persist the engine working state. Ordinary churn is debounced; a new
   * remote id is written immediately, because from that moment the durable
   * record is the only thing that can describe the live run.
   */
  private maybeSaveSnapshot(force: boolean, nowMs = this.now()): void {
    if (this.disposed && !force) return
    const ids = this.remoteIdSignature()
    const idsChanged = ids !== this.lastSavedIds
    if (!force && !idsChanged && (!this.dirty || nowMs - this.lastSavedAt < this.snapshotDebounceMs)) return
    this.dirty = false
    this.lastSavedAt = nowMs
    this.lastSavedIds = ids
    const snap = this.snapshot
    this.enqueue(() =>
      this.store.commit((s) => {
        if (!s.missions.some((m) => m.missionId === this.missionId)) return null
        const engineSnapshots = { ...(s.engineSnapshots ?? {}) }
        engineSnapshots[this.missionId] = snap
        return { state: { ...s, engineSnapshots }, events: [] }
      }),
    )
  }

  private async saveBeforeFactoryPost(): Promise<void> {
    if (this.disposed) throw new LaunchSuppressedError('terminal', 'factory.message')
    this.maybeSaveSnapshot(true)
    await this.chain
    if (this.store.durability !== 'ok') {
      const error = Object.assign(new Error('Delivery state was not saved; no message was sent.'), {
        kind: 'storage', notDispatched: true,
      })
      throw error
    }
    const mission = this.mission()
    if (!mission || this.isTerminal(mission)) throw new LaunchSuppressedError('terminal', 'factory.message')
    if (this.pendingControl?.reason === 'cancelling' || mission.control === 'cancel_requested') {
      throw new LaunchSuppressedError('cancelling', 'factory.message')
    }
  }

  private persistedSnapshot(): RealSnapshot | null {
    const raw = this.store.current.engineSnapshots?.[this.missionId]
    if (raw === null || raw === undefined) return null
    const snap = raw as RealSnapshot
    if (snap.real !== true || snap.v !== 1) return null
    return snap
  }

  private frozenRepository(): string {
    return this.mission()?.config.repository ?? ''
  }

  /** The repository this mission builds on: frozen once assigned, else live. */
  private effectiveRepository(): string {
    const mission = this.mission()
    const frozen = mission?.config.repository ?? ''
    if (frozen !== '') return frozen
    // A mission created as "New repo" owns no repository yet and must never
    // silently adopt the owner's default: the engine creates one. Injecting
    // the default here is exactly what made "New repo" quietly plan on the
    // default repository while the create never ran.
    if (mission?.config.newRepository === true) return ''
    return this.liveRepository
  }

  /**
   * Hot-apply a phone save (spec §12, §17). Credentials, the computer id and
   * the worker setup always update; the repository is adopted only while this
   * mission has none (once assigned it is frozen, so a later save cannot move
   * a live run). The adopted repository is recorded durably so a relaunch
   * keeps building there.
   *
   * Session settings are NOT applied here: they were frozen when this mission
   * was created (spec §7), so a save reaches the next build, never this one.
   */
  configure(settings: {
    factoryKey: string
    cursorKey: string
    githubToken: string
    computerId: string
    repository: string
  }): void {
    if (this.disposed) return
    this.liveRepository = settings.repository
    // A "New repo" mission is exempt: it adopts nothing until its own
    // repository is created, or a later save would move the create onto the
    // owner's default repository.
    const adoptRepo =
      this.frozenRepository() === '' &&
      settings.repository !== '' &&
      this.mission()?.config.newRepository !== true
    this.engine.configure({
      factoryKey: settings.factoryKey,
      cursorKey: settings.cursorKey,
      githubToken: settings.githubToken,
      computerId: settings.computerId,
      ...(adoptRepo ? { repoUrl: settings.repository } : {}),
    })
    if (adoptRepo) {
      this.enqueue(() =>
        this.store.commit((s) => {
          const idx = s.missions.findIndex((m) => m.missionId === this.missionId)
          if (idx === -1) return null
          const mission = s.missions[idx]
          if (mission.config.repository !== '') return null
          const missions = [...s.missions]
          missions[idx] = { ...mission, config: { ...mission.config, repository: settings.repository }, updatedAt: nowIso() }
          return { state: { ...s, missions }, events: [] }
        }),
      )
    }
  }

  /** A paused mission stays paused across a restart (spec §7, §25.5). */
  private reassertPause(): void {
    const mission = this.mission()
    if (mission === null) return
    if (mission.control !== 'paused' && mission.control !== 'pause_requested') return
    if (this.engine.canPause()) this.engine.pauseToggle() // old snapshot: pause the engine now
    else this.engine.reassertPause() // restored paused: the remote stop is still unconfirmed, ask again
  }

  // -------------------------------------------------------------- plumbing

  private mission(): Mission | null {
    return this.store.current.missions.find((m) => m.missionId === this.missionId) ?? null
  }

  private control(): Mission['control'] {
    return this.mission()?.control ?? 'running'
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work)
    this.chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private setFreshness(freshness: Mission['freshness']): void {
    const mission = this.mission()
    if (mission === null || mission.freshness === freshness) return
    this.enqueue(() =>
      this.store.commit((s) => {
        const idx = s.missions.findIndex((m) => m.missionId === this.missionId)
        if (idx === -1) return null
        const missions = [...s.missions]
        missions[idx] = { ...missions[idx], freshness, updatedAt: nowIso() }
        return { state: { ...s, missions }, events: [] }
      }),
    )
  }

  /**
   * One control transition, committed as a compare-and-set: the commit
   * re-verifies the control mode it was decided against, so a decision made
   * on stale in-memory state (an owner resumed while a pause confirmation
   * was still queued behind it, a second cancel tap before the first landed)
   * can never overwrite a newer intent. `expectPrior` omitted means the
   * transition is unconditional (the caller owns the proof).
   */
  private patchControl(
    control: Mission['control'],
    event: KnownEventType,
    extra: Partial<Mission> = {},
    extraEvents: KnownEventType[] = [],
    payload: Record<string, unknown> = {},
    expectPrior?: readonly Mission['control'][],
  ): Promise<CommitResult> {
    return this.enqueue(() =>
      this.store.commit((s) => {
        const idx = s.missions.findIndex((m) => m.missionId === this.missionId)
        if (idx === -1) return null
        if (expectPrior !== undefined && !expectPrior.includes(s.missions[idx].control)) return null
        const missions = [...s.missions]
        missions[idx] = { ...missions[idx], ...extra, control, updatedAt: nowIso() }
        const events: EventDraft[] = [
          ...extraEvents.map((type) => draftEvent(type, {}, { entityId: s.entity.entityId, missionId: this.missionId })),
          draftEvent(event, payload, { entityId: s.entity.entityId, missionId: this.missionId }),
        ]
        return { state: { ...s, missions }, events }
      }),
    )
  }
}

/** Terminal phases keep their evidence and records; nothing launches after them. */
export function isTerminalMission(mission: Mission): boolean {
  return isTerminalPhase(mission.phase)
}

function runCandidates(snap: RealSnapshot, mission: Mission): RunCandidate[] {
  const out: RunCandidate[] = []
  const terminal = isTerminalMission(mission)
  if (snap.sessionId !== null) {
    out.push({
      provider: 'factory',
      role: 'lead',
      sessionOrAgentId: snap.sessionId,
      remoteRunId: null,
      observedState: snap.phase,
      active: !terminal,
    })
  }
  for (const job of snap.jobs) {
    const active = !terminal && job.state !== 'accepted' && job.state !== 'stopped'
    if (job.mode === 'cursor' && job.agentId !== null) {
      out.push({
        provider: 'cursor',
        role: 'worker',
        sessionOrAgentId: job.agentId,
        remoteRunId: job.runId,
        observedState: job.state,
        active,
      })
    } else if (job.sessionId !== null) {
      out.push({
        provider: 'factory',
        role: 'worker',
        sessionOrAgentId: job.sessionId,
        remoteRunId: null,
        observedState: job.state,
        active,
      })
    }
  }
  return out
}

// Optional persisted identity leaves legacy decision records readable.
function matchesCapturedDecision(record: DecisionRecord, answer: { questionIdentity?: string; legacyDecisionId?: string } | null): boolean {
  if (answer === null) return false
  return record.questionIdentity === undefined
    ? answer.legacyDecisionId === record.decisionId
    : answer.questionIdentity === record.questionIdentity
}
function decisionIdentity(snap: RealSnapshot): string {
  const source = snap.decisionJob ?? null
  const job = source === null ? null : snap.jobs[source]
  const identity = [snap.decisionText, snap.decisionOptions ?? [], snap.decisionKind, snap.decisionGate,
    source, job?.sessionId ?? null, job?.requestToken ?? null, job?.stage ?? null,
    source === null && !snap.decisionGate ? snap.leadQuestionRequest ?? null : null, snap.planLabels]
  return JSON.stringify(snap.nativeQuestion ? [...identity, snap.nativeQuestion] : identity)
}
function matchesDecision(record: DecisionRecord, snap: RealSnapshot): boolean {
  const identity = record.questionIdentity
  return identity !== undefined ? identity === decisionIdentity(snap)
    : (snap.decisionJob === null || snap.decisionJob === undefined) &&
      record.question === snap.decisionText && record.scope === (snap.decisionKind === 'pr' ? 'pr' : 'build')
}
function buildDecision(missionId: string, mission: Mission, snap: RealSnapshot, now: string): DecisionRecord {
  const kind = snap.decisionKind === 'pr' ? 'pr' : 'build'
  const workerQuestion = snap.decisionJob !== null && snap.decisionJob !== undefined
  return {
    schemaVersion: 2,
    decisionId: mintId('decision'),
    missionId,
    revision: mission.planRevision,
    question: snap.decisionText,
    questionIdentity: decisionIdentity(snap),
    options: snap.nativeQuestion ? [] : [
      { optionId: 'proceed', label: workerQuestion ? 'Confirm answer' : kind === 'pr' ? 'Open the pull request' : snap.decisionGate ? 'Start the build' : 'Confirm answer' },
      { optionId: 'reply', label: 'Answer in my own words' },
    ],
    scope: snap.nativeQuestion ? 'factory_native' : kind,
    consequence:
      snap.nativeQuestion
        ? 'This native question is readable here, but must be answered in Factory.'
        : workerQuestion
        ? 'The answer is sent to the existing worker that asked this question.'
        : kind === 'pr'
        ? 'Proceeding opens a pull request on the mission repository.'
        : 'Proceeding spends provider credits on live worker runs.',
    expiryAt: null,
    openedAt: now,
    answeredAt: null,
    answerOptionId: null,
    answerText: null,
  }
}
