/**
 * Runtime supervisor (spec §4, §8, §14, §20, §26 phase 2): the single owner of
 * execution authority on this host.
 *
 * Boot order is the spec's recovery order:
 *   1. load and validate the latest checkpoint (the store does the validating;
 *      a corrupt slot is rejected, never merged);
 *   2. run the one-time v1 migration;
 *   3. take a new runtime epoch (this process generation) and record it;
 *   4. recover dispatch records left in flight by the previous epoch;
 *   5. restore every nonterminal mission and spawn its actor;
 *   6. report what could not be reconciled instead of pretending it was.
 *
 * The supervisor owns what must be global: the mission registry, the fair
 * capacity scheduler, the command pipeline (durable receipt + dedupe), and the
 * one place that decides which mission may launch workers. Mission-local state
 * lives in MissionActor; nothing here reads the selected view, so a mission
 * runs the same whether or not its card is on screen (spec §2).
 *
 * X intake (§11) lives in src/intake/x.ts and enters through submitCommand
 * like every other surface.
 */
import { draftEvent } from '../domain/events'
import { mintId, nowIso } from '../domain/ids'
import type {
  BriefingRecord,
  BriefingScope,
  CommandEnvelope,
  DomainEvent,
  InputSource,
  Mission,
  MissionConfig,
  MissionSessionSettings,
  SpriiteState,
  XFollowup,
  XIntakeReceipt,
} from '../domain/types'
import { buildBriefing, nativeBriefingRequestKey, requiresAcknowledgement } from '../briefing/build'
import { meaningOf } from '../briefing/meaning'
import { validBuildDraft } from '../factory/build-intent'
import {
  applyAcknowledgement,
  coversMatch,
  coverageOf,
  isAcknowledged,
} from '../briefing/receipts'
import { buildInbox, type InboxView } from '../phone/inbox'
import type { RealClients, RealSnapshot } from '../factory/real'
import type { KVBackend, LoadResult, MissionStore } from '../state/mission-store'
import { migrateV1, type MigrationOutcome } from '../state/migrate-v1'
import { Outbox } from './outbox'
import {
  CAPACITY_ACTIONS,
  isTerminalMission,
  LAUNCH_ACTIONS,
  MissionActor,
  providersFromWorkerPref,
  SUPPRESSION_FAULT_KINDS,
  workerPrefFromProviders,
  type ActionOutcome,
} from './mission'
import { DEFAULT_MAX_CONCURRENT_WORKERS, Scheduler } from './scheduler'
import type { WorkerPref } from '../state/prefs'
import type { ExecutionBackend, NativeAnswer, NativeBrokerClient, NativeCommandReceipt,
  NativeIntent, NativeLaunchProfile, NativeSnapshot, MissionPresentation, HeldNativeIntent, NativeDeliveryDefaults } from '../native/protocol'
import { decodeNativeCache, decodeNativeIntent, decodeNativeProfile, decodeNativeSnapshot, type NativeMissionCache } from '../native/decode'
import { nativeDestinationRepository, nativeIntentMatchesProfile, nativeJobCheckout } from '../native/workspace'
import { constrainNativeDelivery, deliveryPolicyFlags, deliveryPolicyProblem, reviewedNativeSettingsProblem, NO_NATIVE_DELIVERY, normalizeDeliveryDefaults, validGithubAccount, validRepositoryName } from '../native/delivery'
import { X_NATIVE_DISMISSED_REASON, X_NATIVE_PROMOTED_REASON } from '../intake/x-native-copy'
import type { BoundNativeBrokerClient } from '../native/client'
import { NativeMissionActor } from './native-mission'
import type { RuntimeMissionActor } from './mission-actor'
import { legacyPresentation, nativePresentation } from '../native/presentation'

/** Cursor in which the process generation is recorded (spec §4, §8). */
export const EPOCH_CURSOR = 'runtime.epoch'
/** The policy revision this release applies to missions it creates. */
export const DEFAULT_POLICY_REVISION = 'v2-default'

export type DropReason = 'policy'

export interface SupervisorPolicy {
  revision: string
  /** False stops every new remote launch immediately, for every mission. */
  allowLaunch: boolean
  /** null allows any repository; a list narrows what may be built on. */
  allowedRepositories: string[] | null
}

export interface SupervisorSettings {
  executionBackend?: ExecutionBackend
  /** Backend for X-triggered builds only (voice and phone goals keep executionBackend). */
  xExecutionBackend?: ExecutionBackend
  nativeProfile?: NativeLaunchProfile
  /** Native delivery defaults for NEW jobs; absent means everything off. */
  nativeDelivery?: NativeDeliveryDefaults
  factoryKey: string
  cursorKey: string
  githubToken: string
  computerId: string
  /** Live defaults applied to NEW missions only (spec §7 frozen config). */
  workerPref: WorkerPref
  jobs: number
  askBeforePr: boolean
  /**
   * Factory session settings for NEW missions only (spec §7 frozen config).
   * A running mission keeps the block its config froze at creation: the API's
   * update schema cannot carry the extra instructions or the tool policy, and
   * Factory never reports settings back, so a save mid-build could neither be
   * honored nor confirmed (docs/MISSION-PROBE-FINDINGS.md).
   */
  sessionSettings: MissionSessionSettings
  repository: string
  baseRef: string
}

export interface SupervisorDeps {
  nativeClient?: NativeBrokerClient
  store: MissionStore<SpriiteState>
  /** v1 record access for the one-time migration. */
  kv: KVBackend
  clients: RealClients
  settings: () => SupervisorSettings
  policy?: () => SupervisorPolicy
  /** Global worker-run ceiling; the spec's starting limit is four. */
  maxConcurrentWorkers?: number
  emitView: (missionId: string, view: import('../factory/view').EngineView) => void
  now?: () => number
  snapshotDebounceMs?: number
}

export interface BootReport {
  epoch: number
  origin: LoadResult['origin']
  checkpointSeq: number
  durability: 'ok' | 'broken'
  migration: MigrationOutcome
  missionCount: number
  admitted: string[]
  queued: string[]
  warnings: string[]
  /** Missions whose engine working state could not be adopted. */
  restoreRefused: string[]
  /** Missions whose durable command never launched and was resumed at boot. */
  resumedStarts: string[]
  /** Launch attempts whose outcome is unknown; retries stay blocked. */
  unresolvedDispatches: string[]
}

export interface SubmitCommandInput {
  text: string
  source: InputSource
  sourceEventId: string
  dedupeKey: string
  ownerId?: string
  commandId?: string
  issuedAt?: string
  productHint?: string
  targetMissionId?: string
  contextRefs?: string[]
  policyRevision?: string
  /**
   * The product this command was routed to (spec §10 routing order). Absent,
   * the configured default applies. Frozen into the mission config.
   */
  repository?: string
  /**
   * The owner asked for this goal to start in a brand-new repository. The
   * mission freezes no repository, records the intent durably, and the engine
   * creates one — the configured default is never adopted for it.
   */
  newRepository?: boolean
  /** The repository name the owner typed on the phone, when they did. */
  newRepositoryName?: string
  /** Native only: the owner's GitHub account the new private repository belongs to. */
  newRepositoryAccount?: string
  /** The owner approved the build start at the source (see MissionConfig.startApproved). */
  startApproved?: boolean
  approvedPlan?: string[]
  buildSourceSessionId?: string
}

export interface SubmitReceipt {
  commandId: string
  receipt: 'saved' | 'duplicate' | 'rejected'
  missionId?: string
  reason?: string
}

export interface RuntimeActionOutcome {
  kind: ActionOutcome['kind'] | 'dropped' | 'unknown_mission'
  reason?: string
}

/** Acknowledging a return briefing (spec §16). */
export type AcknowledgeBriefingResult =
  | { ok: true; briefingId: string; acknowledgedSeq: number; superseded: string[] }
  /** 'unknown': not pending (already acknowledged elsewhere, or never
   *  existed) — the surface has nothing left to do for this id. */
  /** 'stale': the echoed covered ids do not match the pending briefing; the
   *  surface must re-show the account and echo `expected`. */
  /** 'storage': the ledger write did not land, so the acknowledgement is NOT
   *  in effect; the surface must keep the briefing and retry. Distinct from
   *  'unknown' so a storage failure is never reported as success (§8). */
  | { ok: false; reason: 'unknown' | 'stale' | 'storage'; expected?: string[] }

const DEFAULT_POLICY: SupervisorPolicy = {
  revision: DEFAULT_POLICY_REVISION,
  allowLaunch: true,
  allowedRepositories: null,
}

/**
 * Fault kinds that are the runtime's OWN refusal marker rather than a provider
 * failure: `SUPPRESSION_FAULT_KINDS` in mission.ts is the one list, so the
 * actor's retry logic and the supervisor's boot logic can never disagree
 * about what counts as a runtime refusal.
 */
const SUPPRESSION_FAULTS = SUPPRESSION_FAULT_KINDS

export class Supervisor {
  private readonly store: MissionStore<SpriiteState>
  private readonly kv: KVBackend
  private readonly clients: RealClients
  private readonly settings: () => SupervisorSettings
  private readonly policySource: () => SupervisorPolicy
  private readonly emitView: (missionId: string, view: import('../factory/view').EngineView) => void
  private readonly now: () => number
  private readonly snapshotDebounceMs: number | undefined
  private readonly actors = new Map<string, RuntimeMissionActor>()
  private readonly nativeClient: NativeBrokerClient | undefined
  private readonly heldActions = new Map<string, string>()
  /** Restored drafts reserve workers only when an execution action asks. */
  private readonly deferredReservations = new Set<string>()
  private readonly scheduler: Scheduler
  private outboxValue: Outbox | null = null
  private epochValue = 0
  private xFollowupGate: () => boolean = () => false
  private followupDrain: Promise<void> | null = null
  private booted = false
  private warningsValue: string[] = []

  constructor(deps: SupervisorDeps) {
    this.store = deps.store
    this.kv = deps.kv
    this.clients = deps.clients
    this.settings = deps.settings
    this.policySource = deps.policy ?? (() => DEFAULT_POLICY)
    this.emitView = deps.emitView
    this.now = deps.now ?? (() => Date.now())
    this.snapshotDebounceMs = deps.snapshotDebounceMs
    this.nativeClient = deps.nativeClient
    // Capacity notifications are informational: promotion is driven by tick,
    // so a release can never grant an earlier arrival's slot to a later one.
    this.scheduler = new Scheduler(deps.maxConcurrentWorkers ?? DEFAULT_MAX_CONCURRENT_WORKERS)
  }

  get epoch(): number {
    return this.epochValue
  }

  get warnings(): readonly string[] {
    return this.warningsValue
  }

  get schedulerState(): {
    capacity: number
    inFlight: number
    waiting: readonly string[]
    admitted: readonly string[]
  } {
    return {
      capacity: this.scheduler.capacity,
      inFlight: this.scheduler.inFlight,
      waiting: this.scheduler.waitingList,
      admitted: this.scheduler.admittedList,
    }
  }

  get missions(): readonly Mission[] {
    return this.store.current.missions
  }

  /** The durable record this runtime owns (diagnostics and tests). */
  get missionStore(): MissionStore<SpriiteState> {
    return this.store
  }

  get dispatches(): SpriiteState['outbox'] {
    return this.store.current.outbox
  }

  get decisions(): SpriiteState['decisions'] {
    return this.store.current.decisions
  }

  /** Launch attempts whose outcome is unknown: retries stay blocked. */
  get unresolvedDispatches(): string[] {
    const legacy = this.store.current.outbox
      .filter((d) => d.state === 'unknown')
      .map((d) => `${d.missionId}:${d.provider}:${d.actionId}`)
    const native = this.store.current.missions.flatMap(m => {
      const cache = this.nativeCacheFor(m.missionId)
      if (!cache) return []
      return [...cache.pendingWrites.map(x => x.receipt), ...cache.snapshot.commands,
        ...(cache.prepareReceipt ? [cache.prepareReceipt] : [])]
        .filter(c => ['prepared', 'invoked', 'unknown'].includes(c.state))
        .map(c => `${m.missionId}:factory_native:${c.commandId}`)
    })
    return [...new Set([...legacy, ...native])]
  }

  actor(missionId: string): RuntimeMissionActor | null {
    return this.actors.get(missionId) ?? null
  }

  /**
   * The durable engine snapshot of ANY mission — the working state its last
   * save landed. A live actor holds fresher state; this is the record a
   * mission without an actor leaves behind (terminal after a relaunch), and
   * the only place a finished build's history survives. Null when nothing
   * valid is stored: never a guess at the shape.
   */
  engineSnapshotFor(missionId: string): RealSnapshot | null {
    const mission = this.store.current.missions.find(m => m.missionId === missionId)
    if (!mission || mission.config.executionBackend === 'factory_native' || mission.config.nativeQuarantine) return null
    const raw = this.store.current.engineSnapshots?.[missionId]
    if (raw === null || raw === undefined) return null
    const snap = raw as RealSnapshot
    if (snap.real !== true || snap.v !== 1) return null
    return snap
  }

  nativeSnapshotFor(missionId: string): NativeSnapshot | null {
    const actor = this.actors.get(missionId)
    if (actor?.backend === 'factory_native') return actor.snapshot
    const mission = this.store.current.missions.find(m => m.missionId === missionId)
    if (mission?.config.executionBackend !== 'factory_native' || mission.config.nativeQuarantine) return null
    const snapshot = decodeNativeCache(this.store.current.engineSnapshots?.[missionId])?.snapshot
    return snapshot ? constrainNativeDelivery(snapshot, decodeNativeIntent(mission.config.nativeIntent)?.policy) : null
  }

  nativeCacheFor(missionId: string) {
    const mission = this.store.current.missions.find(m => m.missionId === missionId)
    if (mission?.config.executionBackend !== 'factory_native' || mission.config.nativeQuarantine) return null
    const cache = decodeNativeCache(this.store.current.engineSnapshots?.[missionId])
    return cache ? { ...cache, snapshot: constrainNativeDelivery(cache.snapshot,
      decodeNativeIntent(mission.config.nativeIntent)?.policy) } : null
  }

  presentationFor(missionId: string): MissionPresentation | null {
    const actor = this.actors.get(missionId)
    if (actor) return actor.presentation
    const native = this.nativeSnapshotFor(missionId)
    if (native) return nativePresentation(native)
    const legacy = this.engineSnapshotFor(missionId)
    return legacy ? legacyPresentation(legacy) : null
  }

  answerNative(missionId: string, answer: NativeAnswer): Promise<NativeCommandReceipt> {
    const actor = this.actors.get(missionId)
    return actor?.backend === 'factory_native' ? actor.answerNative(answer) :
      Promise.resolve({ commandId: '', state: 'rejected', reason: 'Native mission unavailable' })
  }

  /**
   * Boot: acquire authority, recover, restore, and start observing. Calling
   * boot twice is a programming error (two runtimes on one store), so the
   * second call is refused explicitly rather than silently double-scheduling.
   */
  async boot(): Promise<BootReport> {
    if (this.booted) throw new Error('runtime already booted: only one supervisor may hold authority')
    this.booted = true

    const load = await this.store.load()
    const warnings: string[] = [...load.warnings]
    const migration = await migrateV1(this.kv, this.store)
    warnings.push(...migration.warnings)
    if (migration.error !== undefined) warnings.push(`v1 migration failed (${migration.error}); it will retry on the next boot`)

    // Epoch: this process generation. Dispatch records carry it so recovery can
    // tell "mine" from "the generation that died".
    const previousEpoch = Number(this.store.current.cursors[EPOCH_CURSOR] ?? '0')
    const epoch = Number.isFinite(previousEpoch) && previousEpoch > 0 ? previousEpoch + 1 : 1
    const epochCommit = await this.store.commit((s) => ({
      state: { ...s, cursors: { ...s.cursors, [EPOCH_CURSOR]: String(epoch) } },
      events: [],
    }))
    if (epochCommit.ok === true) this.epochValue = epoch
    else {
      warnings.push(`runtime epoch could not be recorded (${epochCommit.reason})`)
      this.epochValue = epoch
    }

    const outbox = new Outbox({ commit: (m) => this.store.commit(m), state: () => this.store.current, epoch: this.epochValue })
    this.outboxValue = outbox
    const recovered = await outbox.recoverInFlight()
    warnings.push(...recovered)
    // Report EVERY unresolved launch, not only the ones this boot transitioned:
    // an attempt that was already unknown still blocks its retry (§8).
    const unresolvedDispatches = this.unresolvedDispatches

    await this.recoverXFollowups()

    const admitted: string[] = []
    const queued: string[] = []
    const restoreRefused: string[] = []
    const resumedStarts: string[] = []
    for (const mission of this.store.current.missions) {
      if (mission.config.nativeQuarantine) {
        restoreRefused.push(mission.missionId)
        warnings.push(`mission ${mission.missionId}: ownership/cache quarantined; no execution actor`)
        continue
      }
      // Native terminal jobs may still collect evidence / reconcile writes.
      // Even fully settled ones remain readable, with no start replay.
      if (isTerminal(mission) && mission.config.executionBackend !== 'factory_native' &&
        !(mission.phase === 'completed' && this.engineSnapshotFor(mission.missionId)?.finalSummary === '')) continue
      const actor = this.spawn(mission.missionId)
      if (actor === null) continue
      if (!actor.start()) restoreRefused.push(mission.missionId)
      if (actor.backend === 'factory_native') {
        // A crash between the durable save and prepare() leaves an approved
        // job that was never launched. prepare() records its receipt before
        // invoking and re-checks every launch gate, so resuming is safe.
        const intent = mission.config.nativeIntent
        const rawCache = this.store.current.engineSnapshots?.[mission.missionId]
        const cache = rawCache === undefined ? undefined : decodeNativeCache(rawCache)
        if (!isTerminal(mission) && intent?.scopeApproved && intent.highAutonomyApproved &&
          (cache === undefined || (cache !== null && cache.prepareReceipt === null && !cache.imported))) {
          void (actor as NativeMissionActor).prepare().catch(() => {})
        }
        continue
      }
      if (isTerminal(mission)) continue // read-only collection holds no worker reservation
      const snap = actor.snapshot
      const hasWorkerDispatch = this.store.current.outbox.some((d) =>
        d.missionId === mission.missionId && d.state !== 'rejected' &&
        (d.provider === 'cursor' || d.requestKey.startsWith(`m:${mission.missionId}:factory.worker_session:`)),
      )
      const suppressed = snap.faultKind !== null && SUPPRESSION_FAULTS.includes(snap.faultKind)
      const creatingRepository = mission.config.newRepository === true && mission.config.repository === ''
      const dormant = snap.jobs.length === 0 && !hasWorkerDispatch && !suppressed && !creatingRepository &&
        (mission.config.startApproved !== true || snap.requiresFreshApproval === true ||
          (snap.faultKind !== null && !SUPPRESSION_FAULTS.includes(snap.faultKind)))
      if (dormant) {
        this.deferredReservations.add(mission.missionId)
      } else {
        const admission = this.scheduler.admit(mission.missionId, mission.config.maxConcurrentWorkers)
        if (admission === 'admitted') admitted.push(mission.missionId)
        else if (admission === 'queued') queued.push(mission.missionId)
      }
      // Recovery step 6: a command that was durably received but whose launch
      // never happened resumes that same command — the outbox hands back any
      // confirmed session instead of creating a second one (spec §8, §24).
      if (this.resumeUnstarted(mission, actor)) resumedStarts.push(mission.missionId)
    }

    // Recovery is a FACT this generation owns, not only a warning log: the
    // return briefing detects runtime absence by an unseen recovery event
    // from a later epoch (spec §16). Always journaled; warnings ride along.
    await this.store.commit((s) => ({
      state: s,
      events: [
        draftEvent(
          'recovery_completed',
          {
            epoch: this.epochValue,
            origin: load.origin,
            checkpointSeq: load.seq,
            missions: this.store.current.missions.length,
            admitted: admitted.length,
            queued: queued.length,
            restoreRefused,
            resumedStarts,
            unresolvedDispatches,
            warnings: warnings.length,
          },
          { entityId: s.entity.entityId },
        ),
      ],
    }))
    this.warningsValue = warnings
    return {
      epoch: this.epochValue,
      origin: load.origin,
      checkpointSeq: load.seq,
      durability: this.store.durability,
      migration,
      missionCount: this.store.current.missions.length,
      admitted,
      queued,
      warnings,
      restoreRefused,
      resumedStarts,
      unresolvedDispatches,
    }
  }

  // ------------------------------------------------------ command pipeline

  /**
   * One durable command pipeline (spec §10, §20): verify -> deduplicate ->
   * durably receive -> create or extend -> schedule. The receipt is honest:
   * 'saved' means the command and its mission are committed, and only then
   * does the goal reach the engine.
   */
  async submitCommand(input: SubmitCommandInput): Promise<SubmitReceipt> {
    const nativeSettings = this.settings()
    const backend = input.source === 'x'
      ? nativeSettings.xExecutionBackend ?? nativeSettings.executionBackend : nativeSettings.executionBackend
    if (backend === 'factory_native') {
      const profile = decodeNativeProfile(nativeSettings.nativeProfile)
      if (!profile || input.approvedPlan !== undefined || input.buildSourceSessionId !== undefined) {
        return { commandId: input.commandId ?? '', receipt: 'rejected', reason: 'Explicit native destination/scope required' }
      }
      let destination: NativeIntent['destination']
      if (input.newRepository) {
        const account = input.newRepositoryAccount?.trim() ?? ''
        const name = input.newRepositoryName?.trim() ?? ''
        if (!normalizeDeliveryDefaults(nativeSettings.nativeDelivery).createPrivateRepositories) {
          return { commandId: input.commandId ?? '', receipt: 'rejected', reason: 'Native repository creation is off in settings' }
        }
        if (!validGithubAccount(account) || !validRepositoryName(name)) {
          return { commandId: input.commandId ?? '', receipt: 'rejected', reason: 'A valid GitHub account and repository name are required' }
        }
        destination = { kind: 'new_repository', account, name, visibility: 'private', initialization: 'empty' }
      }
      // Generic/X starts carry no native scope or High grant. The saved job
      // is held until an explicit separately approved native intent; delivery
      // flags are applied from current settings at review.
      const missionId = mintId('mission')
      const cwd = profile.workspaceMode === 'host_managed' ? nativeJobCheckout(profile, missionId) : profile.cwd
      if (!cwd) return { commandId: input.commandId ?? '', receipt: 'rejected', reason: 'Invalid host-managed allocation' }
      return this.recordNativeIntent({
        protocolVersion: 1, missionId, ownerId: profile.ownerId,
        commandId: input.commandId ?? mintId('command'), goal: input.text,
        scopeRevision: 1, operation: 'implement',
        ...(destination ? { destination } : {}),
        workspace: { machineId: profile.machineId, cwd,
          repository: destination ? nativeDestinationRepository(profile, destination)
            : input.repository ?? nativeSettings.repository, baseRef: profile.baseRef },
        references: [...(input.contextRefs ?? [])], acceptanceCriteria: [], restrictions: [],
        policy: { autonomy: 'high', allowCreateRepository: destination !== undefined,
          allowPush: false, allowPr: false, allowMerge: false, allowDeploy: false },
        scopeApproved: false, highAutonomyApproved: false, settings: {},
      }, input.dedupeKey, true, input.source === 'x' ? 'x' : 'generic')
    }
    const commandId = input.commandId ?? mintId('command')
    const text = input.text.replace(/\s+/g, ' ').trim()
    if (text === '' || input.dedupeKey.trim() === '') {
      return { commandId, receipt: 'rejected', reason: 'empty command' }
    }
    if (input.approvedPlan !== undefined || input.buildSourceSessionId !== undefined) {
      if (!['phone_text', 'glasses_voice'].includes(input.source) || input.startApproved !== true ||
        !validBuildDraft({ requestId: 'checked', sourceSessionId: input.buildSourceSessionId,
          goal: text, repository: input.repository, plan: input.approvedPlan })) {
        return { commandId, receipt: 'rejected', reason: 'invalid local build approval' }
      }
    }
    const policy = this.policySource()
    const settings = this.settings()
    let duplicateMission: string | undefined
    let duplicateCommand: string | undefined
    let createdMission: string | undefined

    const commit = await this.store.commit((s) => {
      const existing = s.commandDedupe?.[input.dedupeKey]
      if (existing !== undefined) {
        const prior = s.missions.find((m) => m.originatingCommandId === existing)
        if (prior !== undefined) {
          duplicateMission = prior.missionId
          duplicateCommand = existing
        }
        return null // nothing to write: the receipt is the original one
      }
      const entityId = s.entity.entityId
      // "New repo" freezes NO repository and records the intent: the engine
      // creates one, and the configured default is never adopted for it (a
      // frozen-empty config alone cannot say which of the two the owner
      // meant, so the intent is its own durable fact).
      const newRepo = input.newRepository === true
      const frozenSettings = freezeSessionSettings(settings.sessionSettings)
      const config: MissionConfig = {
        executionBackend: 'legacy',
        leadProvider: 'factory',
        workerProviders: providersFromWorkerPref(settings.workerPref, settings.cursorKey !== ''),
        maxConcurrentWorkers: Math.max(1, Math.min(4, Math.round(settings.jobs))),
        repository: newRepo ? '' : (input.repository ?? settings.repository),
        baseRef: settings.baseRef,
        policyRevision: input.policyRevision ?? policy.revision,
        workerPreference: settings.workerPref,
        ...(newRepo
          ? {
              newRepository: true,
              ...(input.newRepositoryName !== undefined && input.newRepositoryName !== ''
                ? { newRepositoryName: input.newRepositoryName }
                : {}),
            }
          : {}),
        // Session settings are frozen here, at creation: a later save applies
        // to the next mission, never to this one (spec §7).
        ...(frozenSettings !== null ? { sessionSettings: frozenSettings } : {}),
        ...(input.startApproved === true ? { startApproved: true } : {}),
        ...(input.approvedPlan !== undefined ? {
          approvedPlan: [...input.approvedPlan],
          buildSourceSessionId: input.buildSourceSessionId,
        } : {}),
      }
      const mission: Mission = {
        schemaVersion: 2,
        missionId: mintId('mission'),
        entityId,
        productId: input.productHint ?? 'default',
        originatingCommandId: commandId,
        title: text.length > 64 ? `${text.slice(0, 61).trimEnd()}...` : text,
        goal: text,
        phase: 'received',
        control: 'running',
        freshness: 'reconciling',
        suspendedPhase: null,
        planRevision: 1,
        config,
        activeRunIds: [],
        decisionIds: [],
        lastAppliedSeq: 0,
        lastObservedAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      createdMission = mission.missionId
      const envelope: CommandEnvelope = {
        schemaVersion: 2,
        commandId,
        source: input.source,
        sourceEventId: input.sourceEventId,
        ownerId: input.ownerId ?? entityId,
        receivedAt: nowIso(),
        issuedAt: input.issuedAt,
        text,
        productHint: input.productHint,
        targetMissionId: input.targetMissionId,
        contextRefs: input.contextRefs ?? [],
        dedupeKey: input.dedupeKey,
        policyRevision: config.policyRevision,
      }
      const events = [
        draftEvent('command_received', { source: envelope.source, sourceEventId: envelope.sourceEventId, hasTarget: envelope.targetMissionId !== undefined }, { entityId, causalCommandId: commandId }),
        draftEvent(
          'mission_created',
          {
            goal: text,
            productId: mission.productId,
            repository: config.repository,
            repositoryKnown: config.repository !== '',
            newRepository: newRepo,
            workerProviders: config.workerProviders,
            maxConcurrentWorkers: config.maxConcurrentWorkers,
            policyRevision: config.policyRevision,
          },
          { entityId, missionId: mission.missionId, causalCommandId: commandId },
        ),
      ]
      return {
        state: {
          ...s,
          missions: [...s.missions, mission],
          commandDedupe: { ...(s.commandDedupe ?? {}), [input.dedupeKey]: commandId },
        },
        events,
      }
    })

    if (duplicateMission !== undefined) {
      // A delivery of a dedupe key we already received resolves to the
      // original receipt: one command, one mission, no second launch.
      return { commandId: duplicateCommand ?? commandId, receipt: 'duplicate', missionId: duplicateMission }
    }
    if (commit.ok === true && createdMission !== undefined) {
      const missionId = createdMission
      const actor = this.spawn(missionId)
      const mission = this.store.current.missions.find((m) => m.missionId === missionId)
      this.scheduler.admit(missionId, mission?.config.maxConcurrentWorkers ?? 1)
      if (actor === null) return { commandId, receipt: 'saved', missionId, reason: 'mission recorded; actor unavailable' }
      // Only now does the goal reach the engine: a command that was not
      // durably received never becomes a provider session (spec §8).
      if (actor.backend === 'legacy') actor.beginGoal(text)
      return { commandId, receipt: 'saved', missionId }
    }
    // The mutation declined, so another delivery of this dedupe key won the
    // race in the store's serialized queue. Resolve to its mission.
    const winner = this.store.current.commandDedupe?.[input.dedupeKey]
    const prior = this.store.current.missions.find((m) => m.originatingCommandId === winner)
    if (prior !== undefined) return { commandId, receipt: 'duplicate', missionId: prior.missionId }
    return { commandId, receipt: 'rejected', reason: `not durably recorded (${commit.ok === false ? commit.reason : 'rejected'})` }
  }

  /**
   * Exact explicit native job. Saved means a local durable receipt, not
   * running. The actor checks the qualified broker gate before preparation.
   */
  submitNativeIntent(intent: NativeIntent): Promise<SubmitReceipt> {
    return this.recordNativeIntent(intent, `native:${intent?.commandId ?? ''}`)
  }

  /** The decoded intent and live profile, or null when they are invalid or not bound to each other. */
  private boundNativeIntent(raw: NativeIntent): { intent: NativeIntent; profile: NativeLaunchProfile } | null {
    const intent = decodeNativeIntent(raw)
    const profile = decodeNativeProfile(this.settings().nativeProfile)
    if (!this.booted || !intent || !profile || !nativeIntentMatchesProfile(profile, intent)) return null
    return { intent, profile }
  }

  private nativeMission(intent: NativeIntent, profile: NativeLaunchProfile, origin: 'x' | 'generic',
    entityId: string, at: string): Mission {
    return {
      schemaVersion: 2, missionId: intent.missionId, entityId, productId: 'default',
      originatingCommandId: intent.commandId, title: intent.goal.slice(0, 64), goal: intent.goal,
      phase: 'received', control: 'running', freshness: 'unknown', suspendedPhase: null,
      planRevision: intent.scopeRevision, config: {
        executionBackend: 'factory_native', nativeIntent: structuredClone(intent), nativeProfile: structuredClone(profile),
        nativeOrigin: origin,
        leadProvider: 'factory', workerProviders: ['factory'], workerPreference: 'factory', maxConcurrentWorkers: 1,
        repository: intent.workspace.repository, baseRef: intent.workspace.baseRef, policyRevision: this.policySource().revision,
      }, activeRunIds: [], decisionIds: [], lastAppliedSeq: 0, lastObservedAt: null, createdAt: at, updatedAt: at,
    }
  }

  /** Held native intents: saved, live, and lacking scope or High approval. Newest first. */
  heldNativeIntents(): HeldNativeIntent[] {
    const out: Array<HeldNativeIntent & { order: number }> = []
    this.store.current.missions.forEach((m, order) => {
      const held = this.heldIntentOf(m)
      if (!held) return
      out.push({ missionId: m.missionId, origin: m.config.nativeOrigin ?? 'generic', goal: held.goal,
        references: [...held.references], repository: held.workspace.repository, createdAt: m.createdAt, order,
        ...(held.destination?.kind === 'new_repository' ? { destination: { ...held.destination } } : {}) })
    })
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.order - a.order)
    return out.map(({ order: _order, ...h }) => h)
  }

  private heldIntentOf(m: Mission): NativeIntent | null {
    if (m.config.executionBackend !== 'factory_native' || m.config.nativeQuarantine ||
      m.config.nativeHeldResolution || isTerminal(m)) return null
    const intent = decodeNativeIntent(m.config.nativeIntent)
    if (!intent || (intent.scopeApproved && intent.highAutonomyApproved)) return null
    return intent
  }

  /** X receipts for a resolved held mission say what the owner decided, not "held". */
  private xReceiptsFor(s: SpriiteState, missionId: string, reason: string): SpriiteState {
    if (!s.xIntake) return s
    return { ...s, xIntake: { ...s.xIntake, receipts: s.xIntake.receipts.map((r) =>
      r.missionId === missionId && r.status === 'submitted' ? { ...r, reason } : r) } }
  }

  /** Retire the held actor so a later observation write cannot resurrect its phase. */
  private async retireActor(missionId: string): Promise<void> {
    const actor = this.actors.get(missionId)
    if (!actor) return
    actor.dispose()
    await actor.flush()
    this.actors.delete(missionId)
  }

  private restoreActor(missionId: string): void {
    const m = this.store.current.missions.find(x => x.missionId === missionId)
    if (!m || m.config.nativeHeldResolution || this.actors.has(missionId)) return
    this.spawn(missionId)?.start()
  }

  /**
   * Turn a held intent into one approved native job. The held goal and every
   * held reference carry over unchanged; the new job and the held mission's
   * terminal transition land in one commit, so a retry can never make two.
   */
  async promoteHeldNativeIntent(heldMissionId: string, raw: NativeIntent): Promise<SubmitReceipt> {
    const reject = (reason: string): SubmitReceipt => ({ commandId: raw?.commandId ?? '', receipt: 'rejected', reason })
    const priorOf = (s: SpriiteState): SubmitReceipt | null => {
      const res = s.missions.find(m => m.missionId === heldMissionId)?.config.nativeHeldResolution
      if (res?.outcome !== 'promoted') return null
      const next = s.missions.find(m => m.missionId === res.missionId)
      return { commandId: next?.originatingCommandId ?? '', receipt: 'duplicate', missionId: res.missionId }
    }
    const already = priorOf(this.store.current)
    if (already) return already
    const bound = this.boundNativeIntent(raw)
    if (!bound) return reject('Invalid or unbound native intent/profile')
    const { intent, profile } = bound
    const held = this.store.current.missions.find(m => m.missionId === heldMissionId)
    const heldIntent = held ? this.heldIntentOf(held) : null
    if (!held || !heldIntent) return reject('No held native intent with that id')
    if (!intent.scopeApproved || !intent.highAutonomyApproved) return reject('Scope and High-autonomy approval are both required')
    if (intent.goal !== held.goal) return reject('The goal must match the held request exactly')
    if (!heldIntent.references.every(r => intent.references.includes(r))) return reject('Every held reference must be kept')
    if (intent.missionId === heldMissionId || intent.commandId === held.originatingCommandId) return reject('A promotion needs fresh mission and command ids')
    if (intent.ownerId !== heldIntent.ownerId) return reject('Owner does not match the held request')
    if (intent.operation === 'clone' || intent.operation === 'fork') return reject('Native clone/fork jobs are not supported')
    if (intent.destination) {
      const repository = intent.workspace.repository.replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase()
      if (repository !== nativeDestinationRepository(profile, intent.destination).toLowerCase()) {
        return reject('Reviewed destination does not match the selected workspace repository')
      }
    }
    // Re-validate the delivery policy the way the phone draft builds it: the
    // broker would fail closed anyway, but a crafted promote must fail fast here.
    const policyProblem = reviewedNativeSettingsProblem(intent.settings) || deliveryPolicyProblem(intent.policy, intent.destination,
      this.settings().nativeDelivery ?? NO_NATIVE_DELIVERY)
    if (policyProblem) return reject(policyProblem)
    const dedupeKey = `native:${intent.commandId}`
    await this.retireActor(heldMissionId)
    let duplicate: SubmitReceipt | null = null
    const result = await this.store.commit(s => {
      duplicate = priorOf(s)
      if (duplicate) return null
      if (JSON.stringify(decodeNativeProfile(this.settings().nativeProfile)) !== JSON.stringify(profile)) return null
      // Retirement/serialized storage can yield. Changed defaults invalidate
      // approval; never replace the reviewed policy with newly read defaults.
      if (deliveryPolicyProblem(intent.policy, intent.destination,
        this.settings().nativeDelivery ?? NO_NATIVE_DELIVERY)) return null
      const idx = s.missions.findIndex(m => m.missionId === heldMissionId)
      if (idx < 0 || !this.heldIntentOf(s.missions[idx])) return null
      if (s.commandDedupe?.[dedupeKey] !== undefined || s.missions.some(m =>
        m.missionId === intent.missionId || m.originatingCommandId === intent.commandId)) return null
      const at = new Date(this.now()).toISOString()
      const entityId = s.entity.entityId
      const prior = s.missions[idx]
      const mission = this.nativeMission(intent, profile, prior.config.nativeOrigin ?? 'generic', entityId, at)
      const missions = [...s.missions]
      missions[idx] = { ...prior, phase: 'cancelled', updatedAt: at,
        config: { ...prior.config, nativeHeldResolution: { outcome: 'promoted', missionId: intent.missionId } } }
      missions.push(mission)
      return { state: this.xReceiptsFor({ ...s, missions, commandDedupe: { ...s.commandDedupe, [dedupeKey]: intent.commandId } },
        heldMissionId, X_NATIVE_PROMOTED_REASON),
        events: [
          draftEvent('native_intent_promoted', { newMissionId: intent.missionId },
            { entityId, missionId: heldMissionId, causalCommandId: intent.commandId }),
          draftEvent('mission_created', { backend: 'factory_native', scopeRevision: intent.scopeRevision,
            scopeApproved: true, highAutonomyApproved: true, promotedFrom: heldMissionId },
            { entityId, missionId: intent.missionId, causalCommandId: intent.commandId }),
        ] }
    })
    if (duplicate) return duplicate
    if (!result.ok || !this.store.current.missions.some(m => m.missionId === intent.missionId)) {
      this.restoreActor(heldMissionId)
      return reject('Native identity collision or storage unavailable')
    }
    const actor = this.spawn(intent.missionId)
    if (actor?.backend === 'factory_native') await actor.prepare()
    return { commandId: intent.commandId, receipt: 'saved', missionId: intent.missionId,
      ...(actor ? {} : { reason: 'Recorded; native actor unavailable' }) }
  }

  /** Close a held intent without running it. False when nothing held matches. */
  async dismissHeldNativeIntent(heldMissionId: string): Promise<boolean> {
    const held = this.store.current.missions.find(m => m.missionId === heldMissionId)
    if (!this.booted || !held || !this.heldIntentOf(held)) return false
    await this.retireActor(heldMissionId)
    let done = false
    const result = await this.store.commit(s => {
      const idx = s.missions.findIndex(m => m.missionId === heldMissionId)
      if (idx < 0 || !this.heldIntentOf(s.missions[idx])) return null
      const at = new Date(this.now()).toISOString()
      const missions = [...s.missions]
      missions[idx] = { ...missions[idx], phase: 'cancelled', updatedAt: at,
        config: { ...missions[idx].config, nativeHeldResolution: { outcome: 'dismissed' } } }
      done = true
      return { state: this.xReceiptsFor({ ...s, missions }, heldMissionId, X_NATIVE_DISMISSED_REASON),
        events: [draftEvent('native_intent_dismissed', {},
        { entityId: s.entity.entityId, missionId: heldMissionId })] }
    })
    if (!result.ok || !done) { this.restoreActor(heldMissionId); return false }
    return true
  }

  /**
   * Show a job your Factory host launched itself (its X reader) as a native
   * mission observed through the broker. The broker already holds the
   * owner's consent and the frozen intent, so the record is approved and
   * marked imported: no actor ever prepares it again, and boot only
   * observes. Only a bound job of this profile's owner and machine is
   * adopted; the observation-side intent mirrors the broker's binding
   * exactly, because every later read is checked against it.
   */
  async adoptHostNativeJob(raw: NativeSnapshot): Promise<SubmitReceipt> {
    const reject = (reason: string): SubmitReceipt => ({ commandId: '', receipt: 'rejected', reason })
    const snapshot = decodeNativeSnapshot(raw)
    const profile = decodeNativeProfile(this.settings().nativeProfile)
    if (!this.booted || !snapshot || !profile) return reject('Invalid host job or native profile')
    if (snapshot.ownerId !== profile.ownerId) return reject('The host job belongs to another owner')
    const binding = snapshot.binding
    if (!binding || binding.machineId !== profile.machineId) return reject('The host job is not bound to this machine yet')
    const commandId = `host:${snapshot.missionId}`
    const dedupeKey = `native-host:${snapshot.missionId}`
    const existing = this.store.current.missions.find(m => m.missionId === snapshot.missionId)
    if (existing) {
      return existing.config.executionBackend === 'factory_native' && existing.originatingCommandId === commandId
        ? { commandId, receipt: 'duplicate', missionId: existing.missionId }
        : reject('A mission with that id already exists')
    }
    // A host-managed new repository is bound as `account/name`; an existing
    // one is the full https URL (broker/x-launch.mjs).
    const full = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(binding.repository)
    const bare = /^([^/:]+)\/([^/:]+)$/.exec(binding.repository)
    const destination: NonNullable<NativeIntent['destination']> | undefined = full
      ? { kind: 'existing', account: full[1], name: full[2], visibility: 'private', initialization: 'empty' }
      : bare ? { kind: 'new_repository', account: bare[1], name: bare[2], visibility: 'private', initialization: 'empty' }
        : undefined
    const goal = snapshot.history.find(h => h.who === 'owner' && h.text.trim())?.text.trim().slice(0, 4000) ??
      'Started from X on your Factory host'
    const intent = decodeNativeIntent({
      protocolVersion: 1, missionId: snapshot.missionId, ownerId: snapshot.ownerId, commandId, goal,
      scopeRevision: snapshot.scopeRevision, operation: 'implement',
      workspace: { machineId: binding.machineId, cwd: binding.cwd, repository: binding.repository,
        baseRef: binding.baseRef, ...(binding.baseSha ? { baseSha: binding.baseSha } : {}) },
      ...(destination ? { destination } : {}),
      references: [], acceptanceCriteria: [], restrictions: [],
      policy: { autonomy: 'high', ...deliveryPolicyFlags(this.settings().nativeDelivery ?? NO_NATIVE_DELIVERY, destination) },
      scopeApproved: true, highAutonomyApproved: true, settings: {},
    })
    if (!intent) return reject('The host job cannot be represented as a native mission')
    let duplicate: Mission | undefined
    const result = await this.store.commit(s => {
      const prior = s.missions.find(m => m.missionId === intent.missionId || m.originatingCommandId === commandId)
      if (prior || s.commandDedupe?.[dedupeKey] !== undefined) {
        if (prior?.originatingCommandId === commandId) duplicate = prior
        return null
      }
      if (JSON.stringify(decodeNativeProfile(this.settings().nativeProfile)) !== JSON.stringify(profile)) return null
      const at = new Date(this.now()).toISOString()
      const cache: NativeMissionCache = {
        nativeCacheVersion: 1, backend: 'factory_native', snapshot: constrainNativeDelivery(snapshot, intent.policy),
        pendingWrites: [], prepareReceipt: null, finalizationDeadline: null, lastClientObservedAt: null,
        observationBlock: null, localHoldReason: null, imported: true,
      }
      return { state: { ...s, missions: [...s.missions, this.nativeMission(intent, profile, 'x', s.entity.entityId, at)],
        engineSnapshots: { ...s.engineSnapshots, [intent.missionId]: cache },
        commandDedupe: { ...s.commandDedupe, [dedupeKey]: commandId } },
        events: [draftEvent('mission_created', { backend: 'factory_native', scopeRevision: intent.scopeRevision,
          scopeApproved: true, highAutonomyApproved: true, adoptedFromHost: true },
          { entityId: s.entity.entityId, missionId: intent.missionId, causalCommandId: commandId })] }
    })
    if (duplicate) return { commandId, receipt: 'duplicate', missionId: duplicate.missionId }
    if (!result.ok || !this.store.current.missions.some(m => m.missionId === intent.missionId)) {
      return reject('Native identity collision or storage unavailable')
    }
    const actor = this.spawn(intent.missionId)
    actor?.start()
    return { commandId, receipt: 'saved', missionId: intent.missionId,
      ...(actor ? {} : { reason: 'Recorded; native actor unavailable' }) }
  }

  /**
   * The phone takes X back from the Factory host: its intake resumes after
   * the host's checkpoint, never before it, so a post the host already
   * launched (under its own mission id) is not read and launched again here.
   * Only ever moves the checkpoint forward, and only for the owner the phone
   * is bound to.
   */
  async adoptHostXCheckpoint(ownerXUserId: string,
    checkpoint: { lastSeenPostId: string | null; lastSuccessAt: string | null }): Promise<boolean> {
    const id = checkpoint.lastSeenPostId
    const at = checkpoint.lastSuccessAt
    if (!/^\d{1,20}$/.test(ownerXUserId) || (id !== null && !/^\d{1,20}$/.test(id)) ||
      (at !== null && !Number.isFinite(Date.parse(at)))) return false
    if (id === null && at === null) return true
    // Nothing to move is not a failure: no intake yet, another owner's (a later
    // bind starts fresh anyway), or already at or past the Factory host's checkpoint.
    let unchanged = false
    const result = await this.store.commit(s => {
      const x = s.xIntake
      if (!x || (x.binding !== null && x.binding.ownerXUserId !== ownerXUserId)) { unchanged = true; return null }
      const own = x.lastSeenPostId ?? null
      const lastSeenPostId = id !== null && (own === null || BigInt(id) > BigInt(own)) ? id : own
      const lastSuccessAt = at !== null && (x.lastSuccessAt === null || Date.parse(at) > Date.parse(x.lastSuccessAt))
        ? new Date(Date.parse(at)).toISOString() : x.lastSuccessAt
      if (lastSeenPostId === own && lastSuccessAt === x.lastSuccessAt) { unchanged = true; return null }
      return { state: { ...s, xIntake: { ...x, lastSeenPostId, lastSuccessAt } }, events: [] }
    })
    return unchanged || result.ok
  }

  /** True when new X commands become held native intents rather than legacy builds. */
  nativeExecution(): boolean {
    const s = this.settings()
    return (s.xExecutionBackend ?? s.executionBackend) === 'factory_native'
  }

  /** Native X posts may ask for a new private repository only while the owner's setting allows it. */
  nativeCreatesPrivateRepositories(): boolean {
    return this.nativeExecution() && normalizeDeliveryDefaults(this.settings().nativeDelivery).createPrivateRepositories
  }

  /** The owner's GitHub account, from the configured repository; null when none is set. */
  nativeRepositoryAccount(): string | null {
    const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/[^/]+?\/?$/.exec(this.settings().repository.trim())
    return m && validGithubAccount(m[1]) ? m[1] : null
  }

  private async recordNativeIntent(raw: NativeIntent, dedupeKey: string, receiptOnlyDedupe = false,
    origin: 'x' | 'generic' = 'generic'): Promise<SubmitReceipt> {
    const bound = this.boundNativeIntent(raw)
    if (!bound || !dedupeKey.trim()) {
      return { commandId: raw?.commandId ?? '', receipt: 'rejected', reason: 'Invalid or unbound native intent/profile' }
    }
    const { intent, profile } = bound
    let created = false
    let duplicate: Mission | undefined
    const result = await this.store.commit(s => {
      const priorCommand = s.commandDedupe?.[dedupeKey]
      const prior = s.missions.find(m => m.missionId === intent.missionId ||
        m.originatingCommandId === intent.commandId || m.originatingCommandId === priorCommand)
      if (prior) {
        // Backend ownership and exact scope are immutable; collisions cannot
        // replace a job or turn a cached legacy mission into a native one.
        if (prior.config.executionBackend === 'factory_native' &&
          ((receiptOnlyDedupe && priorCommand !== undefined) ||
            JSON.stringify(prior.config.nativeIntent) === JSON.stringify(intent))) duplicate = prior
        return null
      }
      if (JSON.stringify(decodeNativeProfile(this.settings().nativeProfile)) !== JSON.stringify(profile)) return null
      const at = new Date(this.now()).toISOString()
      const mission = this.nativeMission(intent, profile, origin, s.entity.entityId, at)
      created = true
      return { state: { ...s, missions: [...s.missions, mission],
        commandDedupe: { ...s.commandDedupe, [dedupeKey]: intent.commandId } },
        events: [draftEvent('mission_created', { backend: 'factory_native', scopeRevision: intent.scopeRevision,
          scopeApproved: intent.scopeApproved, highAutonomyApproved: intent.highAutonomyApproved },
          { entityId: s.entity.entityId, missionId: intent.missionId, causalCommandId: intent.commandId })] }
    })
    if (duplicate) return { commandId: duplicate.originatingCommandId, receipt: 'duplicate', missionId: duplicate.missionId }
    if (!result.ok || !created) return { commandId: intent.commandId, receipt: 'rejected', reason: 'Native identity collision or storage unavailable' }
    const actor = this.spawn(intent.missionId)
    if (actor?.backend === 'factory_native') await actor.prepare()
    return { commandId: intent.commandId, receipt: 'saved', missionId: intent.missionId,
      ...(actor ? {} : { reason: 'Recorded; native actor unavailable' }) }
  }

  /** The connection owns the live credential/feature gate; absent wiring is off. */
  setXFollowupGate(gate: () => boolean): void { this.xFollowupGate = gate }

  private followupReceipt(r: XIntakeReceipt, f: XFollowup): XIntakeReceipt {
    const state = f.state === 'sending' ? 'unknown' : f.state
    return { ...r, missionId: f.missionId, instruction: f.instruction,
      followupDelivery: state, followupAttempt: f.attempt,
      status: state === 'sent' ? 'extended' : state === 'dismissed' ? 'dismissed' : 'held_confirm',
      reason: state === 'pending' ? 'Saved for this build; waiting to send.' : state === 'unknown'
        ? 'Delivery could not be confirmed. Resending may add it twice. Choose Resend or Dismiss.' : undefined }
  }

  private updateFollowup(s: SpriiteState, f: XFollowup): SpriiteState {
    return { ...s, xFollowups: (s.xFollowups ?? []).map((p) => p.dedupeKey === f.dedupeKey ? f : p),
      ...(s.xIntake ? { xIntake: { ...s.xIntake, receipts: s.xIntake.receipts.map((r) =>
        r.dedupeKey === f.dedupeKey ? this.followupReceipt(r, f) : r) } } : {}) }
  }

  /** Atomic receipt + targeted intent: never a new mission or frozen-config mutation. */
  async submitXFollowup(receipt: XIntakeReceipt, ownerId: string): Promise<{ status: 'saved' | 'duplicate' | 'failed' }> {
    let duplicate = false
    const result = await this.store.commit((s) => {
      if ((s.xFollowups ?? []).some((f) => f.dedupeKey === receipt.dedupeKey)) { duplicate = true; return null }
      const binding = s.xIntake?.binding
      if (!binding?.enabled || binding.protectedOwner || binding.ownerXUserId !== ownerId ||
        !receipt.dedupeKey.startsWith(`x:${ownerId}:`) || !receipt.missionId || !receipt.instruction.trim() ||
        (s.xFollowups?.length ?? 0) >= 2000) return null
      const f: XFollowup = { dedupeKey: receipt.dedupeKey, ownerId, missionId: receipt.missionId,
        instruction: receipt.instruction, receivedAt: receipt.receivedAt, attempt: 0, state: 'pending' }
      const r = this.followupReceipt(receipt, f)
      const receipts = s.xIntake!.receipts.some((p) => p.dedupeKey === r.dedupeKey)
        ? s.xIntake!.receipts.map((p) => p.dedupeKey === r.dedupeKey ? r : p) : [...s.xIntake!.receipts, r]
      return { state: { ...s, xFollowups: [...(s.xFollowups ?? []), f], xIntake: { ...s.xIntake!, receipts,
        lastReceivedAt: r.receivedAt, lastReceivedPostId: r.revisionId } },
        events: [draftEvent('x_request_received', { status: 'held_confirm', via: r.via, logicalPostId: r.logicalPostId,
          missionId: f.missionId }, { entityId: s.entity.entityId })] }
    })
    if (duplicate) return { status: 'duplicate' }
    if (!result.ok) return { status: 'failed' }
    void this.drainXFollowups().catch(() => {})
    return { status: 'saved' }
  }

  /** A sending claim has no proof of non-delivery, even after a local crash. */
  private async recoverXFollowups(): Promise<void> {
    await this.store.commit((s) => {
      let changed = false
      let next = s
      for (const f of s.xFollowups ?? []) {
        if (f.state !== 'sending') continue
        changed = true
        next = this.updateFollowup(next, { ...f, state: 'unknown' })
      }
      const missing = (s.xIntake?.receipts ?? []).filter((r) => r.missionId && !r.commandId &&
        (r.status === 'extended' || r.status === 'held_confirm') &&
        !(s.xFollowups ?? []).some((f) => f.dedupeKey === r.dedupeKey))
      for (const r of missing) {
        const ownerId = /^x:(\d{1,20}):/.exec(r.dedupeKey)?.[1]
        if (!ownerId || !r.instruction.trim() || (next.xFollowups?.length ?? 0) >= 2000) continue
        const f: XFollowup = { dedupeKey: r.dedupeKey, ownerId, missionId: r.missionId!, instruction: r.instruction,
          receivedAt: r.receivedAt, attempt: 0, state: 'unknown' }
        next = { ...next, xFollowups: [...(next.xFollowups ?? []), f] }
        next = this.updateFollowup(next, f)
        changed = true
      }
      return changed ? { state: next, events: [] } : null
    })
  }

  private followupAllowed(f: XFollowup): boolean {
    const s = this.store.current
    const binding = s.xIntake?.binding
    const mission = s.missions.find((m) => m.missionId === f.missionId)
    const policy = this.policySource()
    return this.booted && this.xFollowupGate() && binding?.enabled === true && !binding.protectedOwner &&
      binding.ownerXUserId === f.ownerId && !!mission && !isTerminal(mission) && mission.control === 'running' &&
      policy.allowLaunch && (policy.allowedRepositories === null || policy.allowedRepositories.includes(mission.config.repository))
  }

  drainXFollowups(): Promise<void> {
    if (this.followupDrain !== null) return this.followupDrain
    const run = this.drainXFollowupsNow()
    this.followupDrain = run
    void run.finally(() => { if (this.followupDrain === run) this.followupDrain = null }).catch(() => {})
    return run
  }

  private async drainXFollowupsNow(): Promise<void> {
    await this.recoverXFollowups()
    // Each key is considered once, with the ledger's 2000-entry bound.
    // Appended rows can drain too, without spinning on a deferred head.
    // Unknown/sending are unresolved too: later words for that same mission
    // cannot overtake them on a subsequent drain or after crash recovery.
    const blocked = new Set<string>()
    const considered = new Set<string>()
    for (let remaining = 2000; remaining > 0; remaining--) {
      if (!this.xFollowupGate()) return
      const f = (this.store.current.xFollowups ?? []).find((p) =>
        (p.state === 'pending' || p.state === 'sending' || p.state === 'unknown') &&
        !considered.has(p.dedupeKey) && !blocked.has(p.missionId))
      if (!f) return
      considered.add(f.dedupeKey)
      if (f.state !== 'pending') { blocked.add(f.missionId); continue }
      const mission = this.store.current.missions.find((m) => m.missionId === f.missionId)
      if (!mission || isTerminal(mission) || this.store.current.xIntake?.binding?.ownerXUserId !== f.ownerId) {
        await this.store.commit((s) => {
          const current = s.xFollowups?.find((p) => p.dedupeKey === f.dedupeKey)
          return current?.state === 'pending' && current.attempt === f.attempt
            ? { state: this.updateFollowup(s, { ...current, state: 'unknown' }), events: [] } : null
        })
        blocked.add(f.missionId)
        continue
      }
      const actor = this.actors.get(f.missionId)
      if (!this.followupAllowed(f) || !actor?.followupReady) { blocked.add(f.missionId); continue }
      let claimed = false
      const claim = await this.store.commit((s) => {
        const current = s.xFollowups?.find((p) => p.dedupeKey === f.dedupeKey)
        const head = s.xFollowups?.find((p) => p.missionId === f.missionId &&
          (p.state === 'pending' || p.state === 'sending' || p.state === 'unknown'))
        if (current?.state !== 'pending' || current.attempt !== f.attempt || head?.dedupeKey !== f.dedupeKey ||
            !this.followupAllowed(f) || !actor.followupReady) return null
        claimed = true
        return { state: this.updateFollowup(s, { ...current, state: 'sending' }), events: [] }
      })
      if (!claim.ok) return
      if (!claimed) { blocked.add(f.missionId); continue }
      let outcome: 'sent' | 'deferred' | 'unknown' = 'unknown'
      try {
        outcome = await actor.sendFollowup(f.instruction, () => this.followupAllowed(f) &&
          this.store.current.xFollowups?.find((p) => p.dedupeKey === f.dedupeKey)?.state === 'sending' &&
          this.store.current.xFollowups?.find((p) => p.missionId === f.missionId &&
            (p.state === 'pending' || p.state === 'sending' || p.state === 'unknown'))?.dedupeKey === f.dedupeKey)
      } catch { /* No proof that a rejected transport promise did not reach the provider. */ }
      const acknowledged = await this.store.commit((s) => {
        const current = s.xFollowups?.find((p) => p.dedupeKey === f.dedupeKey)
        if (current?.state !== 'sending' || current.attempt !== f.attempt) return null
        return { state: this.updateFollowup(s, { ...current,
          state: outcome === 'sent' ? 'sent' : outcome === 'deferred' ? 'pending' : 'unknown' }), events: [] }
      })
      if (!acknowledged.ok) return
      if (outcome !== 'sent') blocked.add(f.missionId)
    }
  }

  /** Compare-and-set attempt prevents a repeated/stale resend tap from creating another attempt. */
  async resolveXFollowup(key: string, action: 'resend' | 'dismiss', attempt: number): Promise<boolean> {
    // An active sending claim may already have reached the provider. Keep its
    // receipt honest instead of waiting and treating a stale tap as consent.
    if (action === 'dismiss' && this.followupDrain &&
        this.store.current.xFollowups?.some((f) => f.dedupeKey === key && f.state === 'sending')) return false
    if (this.followupDrain) await this.followupDrain
    await this.recoverXFollowups()
    let changed = false
    const result = await this.store.commit((s) => {
      const f = s.xFollowups?.find((p) => p.dedupeKey === key)
      if (!f || f.state !== 'unknown' || f.attempt !== attempt ||
        s.xIntake?.binding?.ownerXUserId !== f.ownerId || (action === 'resend' && !this.xFollowupGate())) return null
      changed = true
      return { state: this.updateFollowup(s, { ...f, state: action === 'resend' ? 'pending' : 'dismissed',
        attempt: action === 'resend' ? f.attempt + 1 : f.attempt }), events: [] }
    })
    if (result.ok && changed && action === 'resend') void this.drainXFollowups().catch(() => {})
    return result.ok && changed
  }

  // ------------------------------------------------------------- scheduling

  /**
   * One runtime step: tick every nonterminal actor (observation is never
   * capacity-gated), release capacity from terminal work, then promote waiters
   * in FIFO order and replay the action each was holding.
   */
  tick(now = this.now()): void {
    void this.drainXFollowups().catch(() => {})
    for (const mission of this.store.current.missions) {
      const existingActor = this.actors.get(mission.missionId)
      if (existingActor?.backend === 'factory_native') {
        existingActor.tick(now)
        continue // broker owns native worker capacity and all execution loops
      }
      if (mission.config.executionBackend === 'factory_native' || mission.config.nativeQuarantine) {
        // Keyed on config, not actor presence: a native mission between
        // actor retirement and its commit, or a quarantined mission that
        // never gets an actor, must never take a legacy worker slot. Any slot
        // it somehow holds is handed back rather than leaked.
        if (this.scheduler.isAdmitted(mission.missionId) || this.scheduler.isWaiting(mission.missionId)) {
          this.scheduler.release(mission.missionId)
        }
        this.heldActions.delete(mission.missionId)
        this.deferredReservations.delete(mission.missionId)
        continue
      }
      if (isTerminal(mission)) {
        if (existingActor?.observationPending) existingActor.tick(now)
        this.deferredReservations.delete(mission.missionId)
        if (this.scheduler.isAdmitted(mission.missionId) || this.scheduler.isWaiting(mission.missionId)) {
          this.scheduler.release(mission.missionId)
          this.heldActions.delete(mission.missionId)
        }
        continue
      }
      const actor = this.actors.get(mission.missionId)
      const snap = actor?.backend === 'legacy' ? actor.snapshot : null
      if (mission.config.startApproved === true && snap?.phase === 'plan' &&
        snap.planLabels.length > 0 && snap.requiresFreshApproval !== true &&
        !snap.decisionPending && !snap.faultKind && !snap.paused) {
        this.requestDeferredAdmission(mission.missionId)
      }
      actor?.tick(now)
      if (mission.control === 'paused') {
        // A CONFIRMED pause frees the capacity the mission holds — admitted OR
        // queued: a blocked mission must not sit where a freed slot could be
        // handed to it (spec §14). `pause_requested` is handled below
        // instead: its dispatches may still land, so its capacity is not
        // free yet. The queued action is DROPPED in both cases, not parked:
        // a stale approval must never fire after a resume or once a
        // cancellation is underway (§7, §10).
        this.scheduler.release(mission.missionId)
        this.heldActions.delete(mission.missionId)
      } else if (mission.control === 'cancel_requested') {
        // A remote create can still land after the cancel intent. Retain its
        // admitted capacity until the actor durably receipts all cleanup;
        // terminal partial receipts retain the existing manual-cleanup warning.
        this.scheduler.dequeue(mission.missionId)
        this.heldActions.delete(mission.missionId)
      } else if (mission.control === 'pause_requested') {
        // Out of line for a slot it cannot use; capacity is released only
        // once the pause is confirmed (settleControl sees no dispatch in
        // flight) or the mission resumes.
        this.scheduler.dequeue(mission.missionId)
        this.heldActions.delete(mission.missionId)
      } else if (!this.deferredReservations.has(mission.missionId) &&
        !this.scheduler.isAdmitted(mission.missionId) && !this.scheduler.isWaiting(mission.missionId)) {
        this.scheduler.admit(mission.missionId, mission.config.maxConcurrentWorkers)
      }
    }
    for (;;) {
      const promoted = this.scheduler.promoteNext()
      if (promoted === null) break
      this.replayHeld(promoted)
    }
  }

  async flush(): Promise<void> {
    if (this.followupDrain) await this.followupDrain
    for (const actor of this.actors.values()) await actor.flush()
  }

  /**
   * Hot-apply a phone save to every live mission (spec §12, §17): credentials
   * and the operational computer id reach the actor engines, and a mission
   * whose repository was never assigned adopts the one the owner just saved.
   * Without this, a mission blocked on a missing piece could never resume on
   * save (the actor captured its credentials at spawn) even though the phone
   * says it will. The frozen per-mission config (worker preference, job count)
   * is untouched.
   */
  configure(settings: SupervisorSettings): void {
    for (const actor of this.actors.values()) actor.configure(settings)
  }

  // --------------------------------------------------------------- commands

  private requestDeferredAdmission(missionId: string): void {
    if (!this.deferredReservations.has(missionId)) return
    const mission = this.store.current.missions.find((m) => m.missionId === missionId)
    if (mission === undefined || isTerminal(mission) || mission.control !== 'running') return
    if (this.policyDenial(missionId, 'use_it') !== null) return
    this.deferredReservations.delete(missionId)
    this.scheduler.admit(missionId, mission.config.maxConcurrentWorkers)
  }

  handleAction(missionId: string, actionId: string): RuntimeActionOutcome {
    const actor = this.actors.get(missionId)
    if (actor === undefined) return { kind: 'unknown_mission' }
    const denied = this.policyDenial(missionId, actionId)
    if (denied !== null) return { kind: 'dropped', reason: denied }
    if (CAPACITY_ACTIONS.includes(actionId)) this.requestDeferredAdmission(missionId)
    const outcome = actor.handleAction(actionId)
    if (outcome.kind === 'forwarded' && (actionId === 'pause' || actionId === 'restart')) {
      // A pause or cancel intent drops the queued approval IMMEDIATELY — the
      // tick is the backstop for capacity, but a pause+resume that completes
      // between ticks must never replay a stale approval (§7, §10).
      this.heldActions.delete(missionId)
      if (actionId === 'restart') this.scheduler.dequeue(missionId)
    }
    return outcome
  }

  say(missionId: string, text: string): 'goal' | 'steer' | 'decision' | 'none' {
    const actor = this.actors.get(missionId)
    if (actor === undefined) return 'none'
    if (this.policyDenial(missionId, 'use_it') !== null) return 'none'
    if (actor.hasPendingDecision) this.requestDeferredAdmission(missionId)
    return actor.say(text)
  }

  /**
   * The owner refused a pending gate ("no", "not yet", "later"). True when a
   * gate was pending and the refusal was recorded; the caller then ends the
   * mission (a refused gate is the only thing that would have started or
   * finished it — a dead end, never a parked plan). Recording only: the end
   * (the cancel, the home card) stays the caller's one decision, exactly like
   * the restart action.
   */
  declineGate(missionId: string, text: string): boolean {
    const actor = this.actors.get(missionId)
    if (actor === undefined) return false
    if (this.policyDenial(missionId, 'use_it') !== null) return false
    return actor.declineGate(text)
  }

  steer(missionId: string, text: string): boolean {
    const actor = this.actors.get(missionId)
    if (actor === undefined) return false
    if (this.policyDenial(missionId, 'use_it') !== null) return false
    return actor.steer(text)
  }

  answerDecision(missionId: string, decisionId: string, optionId: string): ReturnType<MissionActor['answerDecision']> | 'dropped' {
    const actor = this.actors.get(missionId)
    if (actor === undefined) return 'missing'
    if (this.policyDenial(missionId, 'use_it') !== null) return 'dropped'
    if (actor.hasPendingDecision) this.requestDeferredAdmission(missionId)
    return actor.answerDecision(decisionId, optionId)
  }

  chooseDecisionList(missionId: string, index: number): 'talk' | 'done' {
    const actor = this.actors.get(missionId)
    if (actor === undefined || this.policyDenial(missionId, 'use_it') !== null) return 'done'
    if (actor.hasPendingDecision) this.requestDeferredAdmission(missionId)
    return actor.chooseDecisionList(index)
  }

  // ------------------------------------------------ briefings + inbox (§16/§17)

  /**
   * The return briefing for a surface (spec §16). Two guarantees:
   *  - reconnect coalescing: while a briefing for this scope is pending
   *    acknowledgement, it is returned again instead of being rebuilt — the
   *    surface re-shows the same account, never a different one mid-flight;
   *  - durability: a briefing the owner may acknowledge is committed BEFORE
   *    it is shown, so a crash cannot lose the account. Status one-liners
   *    (nothing meaningful changed) are repeatable by design and are not
   *    persisted; return and absence briefings both are.
   *
   * Coalescing stops at urgent news: if a rank-1 fact (a new failure or
   * provider block) or an unanswered decision is missing from the pending
   * account, the pending record is replaced rather than re-shown — a fixed
   * target delays lower-rank news to the next brief, never an emergency.
   *
   * A brief is an account, never an action: it must not pause, cancel, or
   * answer anything on the owner's behalf.
   *
   * Throws on a durability failure: an account the owner may acknowledge is
   * never handed to a surface before it is committed, so there is no honest
   * value to return when the commit did not land (§8).
   */
  async getBriefing(surfaceId: string, scope: BriefingScope = { kind: 'owner' }): Promise<BriefingRecord> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = (this.store.current.briefings ?? []).find((b) => sameScope(b.scope, scope))
      if (existing !== undefined && !this.briefingOutrun(existing)) {
        await this.recordDelivery(surfaceId, existing.briefingId)
        return existing
      }
      const record = buildBriefing({
        state: this.store.current,
        events: this.store.events,
        journalSeq: this.store.journalSeq,
        scope,
      })
      if (!requiresAcknowledgement(record)) return record
      const commit = await this.store.commit((s) => {
        const landed = (s.briefings ?? []).find((b) => sameScope(b.scope, scope))
        // A same-scope briefing landed concurrently and is still current:
        // show that one instead of a second record for the same scope.
        if (landed !== undefined && !this.briefingOutrun(landed, s, this.store.events)) return null
        return {
          state: {
            ...s,
            // At most one pending briefing per scope: the replacement covers
            // a superset of the range the old one covered.
            briefings: [
              ...(s.briefings ?? []).filter((b) => !sameScope(b.scope, scope)),
              record,
            ],
            briefingDeliveries: deliveryLog(s.briefingDeliveries, surfaceId, record.briefingId),
          },
          events: [],
        }
      })
      if (commit.ok === true) return record
      if (commit.reason !== 'rejected') throw new Error(`briefing could not be recorded (${commit.reason})`)
    }
    throw new Error('briefing could not be built: coalescing kept losing the race')
  }

  /**
   * Has an urgent fact arrived that the pending briefing cannot account for?
   * Only rank-1 news (a failure, a new provider block) and unanswered
   * decisions count: those must never wait behind a fixed target. Ordinary
   * outcomes keep coalescing until the owner acknowledges (§16).
   *
   * Reads the state and window it is given so the check inside a commit
   * mutation sees that commit's own view, not a possibly older snapshot.
   */
  private briefingOutrun(
    brief: BriefingRecord,
    state: SpriiteState = this.store.current,
    events: readonly DomainEvent[] = this.store.events,
  ): boolean {
    const inScope = (missionId: string | undefined): boolean =>
      brief.scope.kind === 'owner' || missionId === brief.scope.missionId
    // Native attention does not live in legacy state.decisions. Compare the
    // complete durable request key in both directions: replacements,
    // revisions, delivery-state changes AND authoritative closure invalidate
    // an old account, without disturbing another mission's fixed target.
    const currentNative = new Set<string>()
    for (const m of state.missions) {
      if (!inScope(m.missionId) || m.config.executionBackend !== 'factory_native') continue
      const cache = decodeNativeCache(state.engineSnapshots?.[m.missionId])
      for (const a of cache?.snapshot.attention ?? []) {
        if (a.state !== 'resolved') currentNative.add(nativeBriefingRequestKey(m.missionId, a))
      }
    }
    const shownNative = new Set(brief.cards
      .filter(c => inScope(c.missionId) && c.nativeRequestKey !== undefined)
      .map(c => c.nativeRequestKey!))
    if ([...currentNative].some(key => !shownNative.has(key)) ||
      [...shownNative].some(key => !currentNative.has(key))) return true
    // A decision is state, not journal history: an open one missing from the
    // cards outranks every other consideration.
    const shown = new Set(brief.cards.filter(c => c.nativeRequestKey === undefined)
      .map((c) => c.decisionId).filter((id): id is string => id !== undefined))
    for (const d of state.decisions) {
      if (d.answeredAt !== null || shown.has(d.decisionId)) continue
      if (brief.scope.kind === 'mission' && d.missionId !== brief.scope.missionId) continue
      if (d.missionId === null && brief.scope.kind !== 'owner') continue
      return true
    }
    // Journal facts above the fixed target: a failure or a new block is
    // urgent; a completion, repair, or plan change is not. A decision_opened
    // event is judged by whether the question is still open (the state check
    // above), never by the journal: answering it is not an emergency.
    for (const e of events) {
      if (e.seq <= brief.targetSeq || !inScope(e.missionId)) continue
      // A resolved observation outage must not remain a cached rank-1
      // "stopped" card merely because recovery is intentionally quiet news.
      if (e.type === 'provider_connectivity_changed' && e.payload.kind === 'recovered' &&
        e.payload.recoveryDomain === 'native_observation' &&
        typeof e.payload.recoveredEventId === 'string' &&
        brief.cards.some(c => c.coveredEventIds.includes(e.payload.recoveredEventId as string))) return true
      if (e.type === 'decision_opened') continue
      const meaning = meaningOf(e)
      if (!meaning.meaningful) continue
      if (e.type === 'mission_failed' || meaning.rank === 1) return true
    }
    return false
  }

  /**
   * Acknowledge a briefing: the client echoes the exact covered event ids it
   * saw (a stale view cannot acknowledge a different account, §20). Applies
   * the coverage ledger, journals `briefing_acknowledged`, clears the
   * pending briefing, and sweeps any pending briefing on ANY surface whose
   * covered events are now all acknowledged (cross-surface acknowledgement,
   * §16 — a phone ack suppresses the glasses replay of the same events).
   * A briefing that named a compaction gap settles it as it is
   * acknowledged: those seqs are unseeable, so the gap card must not repeat.
   *
   * The result distinguishes outcomes a surface must act on differently:
   * `ok` (the account is settled), `stale` (re-show and echo `expected`),
   * `unknown` (already settled elsewhere), `storage` (nothing landed — keep
   * the brief and retry). A storage failure is never reported as success.
   *
   * Acknowledging never answers a decision or lands an action (§16): those
   * are distinct commands with their own guards.
   */
  async acknowledgeBriefing(input: {
    briefingId: string
    coveredEventIds: readonly string[]
    surfaceId?: string
  }): Promise<AcknowledgeBriefingResult> {
    const brief = (this.store.current.briefings ?? []).find((b) => b.briefingId === input.briefingId)
    if (brief === undefined) {
      // Not pending: either acknowledged elsewhere or never existed. Both
      // mean the surface has nothing left to do for this id.
      return { ok: false, reason: 'unknown' }
    }
    if (!coversMatch(brief, input.coveredEventIds)) {
      return { ok: false, reason: 'stale', expected: brief.coveredEventIds }
    }
    const ackedAt = nowIso()
    let supersededIds: string[] = []
    const commit = await this.store.commit((s) => {
      const current = (s.briefings ?? []).find((b) => b.briefingId === input.briefingId)
      if (current === undefined || !coversMatch(current, input.coveredEventIds)) return null
      const coverage = applyAcknowledgement(current, this.store.events, coverageOf(s), ackedAt)
      const superseded: string[] = []
      const briefings: BriefingRecord[] = []
      for (const b of s.briefings ?? []) {
        if (b.briefingId === current.briefingId) continue
        // Everything the other brief CONSIDERED is now covered: either its
        // whole range sits at or below the contiguous watermark (every event
        // up to the watermark is covered by definition), or each id it named
        // is provably acknowledged. The range test is what sweeps a brief
        // whose covered events were compacted out of the window: without it
        // such a record could never be swept and would replay forever
        // (§16 cross-surface acknowledgement, §25.21).
        const allSeen =
          b.targetSeq <= coverage.acknowledgedSeq ||
          (b.coveredEventIds.length > 0 &&
            b.coveredEventIds.every((id) => isAcknowledged(id, this.store.events, coverage)))
        if (allSeen) superseded.push(b.briefingId)
        else briefings.push(b)
      }
      supersededIds = superseded
      const state: SpriiteState = {
        ...s,
        acknowledgedSeq: coverage.acknowledgedSeq,
        acknowledgedEvents: coverage.acknowledgedEvents,
        briefings,
      }
      return {
        state,
        events: [
          draftEvent(
            'briefing_acknowledged',
            {
              briefingId: current.briefingId,
              scope: current.scope.kind,
              targetSeq: current.targetSeq,
              coveredCount: current.coveredEventIds.length,
              acknowledgedSeq: coverage.acknowledgedSeq,
              sparseCount: Object.keys(coverage.acknowledgedEvents).length,
              supersededCount: superseded.length,
              surfaceId: input.surfaceId ?? null,
            },
            { entityId: s.entity.entityId },
          ),
        ],
      }
    })
    if (commit.ok === true) {
      const after = coverageOf(this.store.current)
      return {
        ok: true,
        briefingId: input.briefingId,
        acknowledgedSeq: after.acknowledgedSeq,
        superseded: supersededIds,
      }
    }
    // 'rejected': the mutation proved the brief is no longer pending (acked
    // concurrently) — the caller's outcome, whatever the surface did.
    if (commit.reason === 'rejected') return { ok: false, reason: 'unknown' }
    // The ledger write did NOT land. The briefing is still pending and the
    // watermark did not move: reporting success here would lose the account
    // the owner believes they acknowledged (§8).
    return { ok: false, reason: 'storage' }
  }

  /**
   * The phone inbox projection (spec §17): the durable store rendered for the
   * detailed control surface, computed on demand — never a second authority.
   */
  getInbox(): InboxView {
    return buildInbox(this.store.current, this.store.events, {
      epoch: this.epochValue,
      durability: this.store.durability,
    })
  }

  /**
   * Reconcile a scope: re-observe, save the engine working state, and report
   * what could not be resolved. It never claims a launch was resolved: without
   * an idempotency key from the provider, an unknown launch stays unknown
   * until the owner decides (spec §8, §27).
   */
  async reconcile(scope: { missionId?: string } = {}): Promise<{ reconciled: string[]; unresolved: string[] }> {
    const reconciled: string[] = []
    const unresolved = this.unresolvedDispatches.filter(id =>
      scope.missionId === undefined || id.startsWith(`${scope.missionId}:`))
    for (const mission of this.store.current.missions) {
      if (scope.missionId !== undefined && mission.missionId !== scope.missionId) continue
      if (isTerminal(mission) && !this.actors.get(mission.missionId)?.observationPending) continue
      const actor = this.actors.get(mission.missionId)
      if (actor === undefined) continue
      actor.tick(this.now())
      await actor.flush()
      reconciled.push(mission.missionId)
    }
    return { reconciled, unresolved }
  }

  /** Mission views for the current surfaces (projection helper). */
  activeMissions(): Mission[] {
    return this.store.current.missions.filter((m) => !isTerminal(m))
  }

  // ---------------------------------------------------------------- private

  /**
   * Resume a mission whose durable command never became a live run.
   *
   *  - The engine sits on the runtime's OWN refusal marker (a pause or a
   *    narrowed policy from the previous generation): re-attempt that step
   *    under this boot's control and policy.
   *  - The engine has no lead session and no worker at all: the launch never
   *    happened, so the same command resumes (the outbox still hands back any
   *    session it had already confirmed, so this cannot duplicate work).
   *
   * A paused or cancelling mission is left alone: control wins.
   */
  private resumeUnstarted(mission: Mission, actor: MissionActor): boolean {
    if (mission.control !== 'running') return false
    const snap = actor.snapshot
    if (snap.faultKind !== null && SUPPRESSION_FAULTS.includes(snap.faultKind)) {
      return actor.retryRefusedStep()
    }
    const hasLiveRun =
      snap.sessionId !== null || snap.jobs.some((j) => j.agentId !== null || j.sessionId !== null)
    if (hasLiveRun) return false
    return actor.beginGoal(mission.goal)
  }

  private policyDenial(missionId: string, actionId: string): DropReason | null {
    const policy = this.policySource()
    if (policy.allowLaunch) {
      // The repository allowlist narrows LAUNCHES only: a mission already
      // building on a now-disallowed repository can still be read, paused,
      // and cancelled — the owner can always stop work (spec §21).
      if (isLaunchAction(actionId)) {
        const mission = this.store.current.missions.find((m) => m.missionId === missionId)
        const repo = mission?.config.repository ?? ''
        if (policy.allowedRepositories !== null && repo !== '' && !policy.allowedRepositories.includes(repo)) {
          return 'policy'
        }
      }
      return null
    }
    // A narrowed policy takes effect immediately, including for missions that
    // were created under a wider one (spec §21, §25.10) — but reading,
    // pausing, and cancelling stay available so the owner can always stop work.
    return isLaunchAction(actionId) ? 'policy' : null
  }

  private spawn(missionId: string): RuntimeMissionActor | null {
    const existing = this.actors.get(missionId)
    if (existing !== undefined) return existing
    const outbox = this.outboxValue
    if (outbox === null) return null
    const mission = this.store.current.missions.find((m) => m.missionId === missionId)
    if (mission === undefined) return null
    if (mission.config.nativeQuarantine) return null
    // A resolved held intent never ran and has nothing to observe.
    if (mission.config.nativeHeldResolution) return null
    if (mission.config.executionBackend === 'factory_native') {
      const intent = decodeNativeIntent(mission.config.nativeIntent)
      const profile = decodeNativeProfile(mission.config.nativeProfile)
      if (!intent || !profile) return null
      const source = this.nativeClient as Partial<BoundNativeBrokerClient> & NativeBrokerClient | undefined
      let client: NativeBrokerClient | null = source ?? null
      // Production HTTP clients rebind using the mission's frozen URL, never
      // the host newly selected in Setup. Injected clients must be pre-bound.
      if (source?.forBroker) client = source.forBroker(profile.brokerUrl)
      else if (source?.brokerUrl && source.brokerUrl !== profile.brokerUrl) client = null
      const actor = new NativeMissionActor({
        missionId, intent, store: this.store, client, emitView: this.emitView, now: this.now,
        launchPermitted: () => this.policyDenial(missionId, 'use_it') === null,
      })
      this.actors.set(missionId, actor)
      return actor
    }
    const settings = this.settings()
    const actor = new MissionActor({
      missionId,
      store: this.store,
      clients: this.clients,
      wrapClients: (clients, id, known, beforeLaunch) => outbox.wrapClients(clients, id, known, beforeLaunch),
      engine: {
        factoryKey: settings.factoryKey,
        cursorKey: settings.cursorKey,
        githubToken: settings.githubToken,
        computerId: settings.computerId,
        // The mission's provider choice is frozen; only the credentials and
        // the operational computer id come from live settings (spec §7).
        workerPref: mission.config.workerPreference ?? workerPrefFromProviders(mission.config.workerProviders),
        jobs: mission.config.maxConcurrentWorkers,
        askBeforePr: settings.askBeforePr,
        // A mission created before the owner saved a repository adopts the
        // saved one; once assigned, the frozen config wins (spec §12).
        liveRepository: settings.repository,
        // The session settings this mission's sessions were created with.
        // Frozen, never live: a save applies to the next mission (spec §7).
        settings: mission.config.sessionSettings ?? {},
        missionId,
        now: this.now,
      },
      emitView: this.emitView,
      canLaunch: () => {
        const current = this.store.current.missions.find((m) => m.missionId === missionId)
        if (current === undefined || isTerminal(current)) return false
        if (current.control !== 'running') return false
        if (this.policyDenial(missionId, 'use_it') !== null) return false
        return this.scheduler.isAdmitted(missionId)
      },
      launchPermitted: () => this.policyDenial(missionId, 'start_planning') === null,
      onActionHeld: (id, actionId) => {
        // One held approval per mission: a second tap cannot queue a second
        // launch, it just confirms the same intent.
        if (!this.heldActions.has(id)) this.heldActions.set(id, actionId)
      },
      snapshotDebounceMs: this.snapshotDebounceMs,
    })
    this.actors.set(missionId, actor)
    return actor
  }

  /** Forward an action that was waiting for capacity, once, on admission. */
  private replayHeld(missionId: string): void {
    const actionId = this.heldActions.get(missionId)
    if (actionId === undefined) return
    this.heldActions.delete(missionId)
    const actor = this.actors.get(missionId)
    if (actor === undefined) return
    if (this.policyDenial(missionId, actionId) !== null) return
    actor.handleAction(actionId)
  }

  /** Record (idempotently) that a surface was handed a pending briefing. */
  private async recordDelivery(surfaceId: string, briefingId: string): Promise<void> {
    await this.store.commit((s) => {
      const already = (s.briefingDeliveries ?? []).some(
        (d) => d.surfaceId === surfaceId && d.briefingId === briefingId,
      )
      if (already) return null
      return {
        state: {
          ...s,
          briefingDeliveries: deliveryLog(s.briefingDeliveries, surfaceId, briefingId),
        },
        events: [],
      }
    })
  }
}

export function isTerminal(mission: Mission): boolean {
  return isTerminalMission(mission)
}

/**
 * A mission freezes its own copy of the session settings it was created with:
 * the config must not share an array with the live preference record, or a
 * later save (or a caller mutating the object it passed) could reach back into
 * a running build through it. Null means the owner had chosen nothing, and the
 * config carries no block at all — not an empty one, so an untouched setup
 * reads upstream as "Factory's account default".
 */
export function freezeSessionSettings(
  s: MissionSessionSettings | undefined,
): MissionSessionSettings | null {
  if (s === undefined || Object.keys(s).length === 0) return null
  const out: MissionSessionSettings = { ...s }
  if (s.workerEnabledToolIds) out.workerEnabledToolIds = [...s.workerEnabledToolIds]
  if (s.workerDisabledToolIds) out.workerDisabledToolIds = [...s.workerDisabledToolIds]
  if (s.workerRestrictToolIds) out.workerRestrictToolIds = [...s.workerRestrictToolIds]
  return out
}

function isLaunchAction(actionId: string): boolean {
  return LAUNCH_ACTIONS.includes(actionId)
}

/** Same brief scope (owner, or the same mission). */
function sameScope(a: BriefingScope, b: BriefingScope): boolean {
  if (a.kind === 'owner' && b.kind === 'owner') return true
  if (a.kind === 'mission' && b.kind === 'mission') return a.missionId === b.missionId
  return false
}

/** The per-surface delivery log: one latest row per surface, bounded. */
function deliveryLog(
  prior: SpriiteState['briefingDeliveries'],
  surfaceId: string,
  briefingId: string,
): SpriiteState['briefingDeliveries'] {
  return [
    ...(prior ?? []).filter((d) => d.surfaceId !== surfaceId),
    { briefingId, surfaceId, deliveredAt: nowIso() },
  ].slice(-32)
}
