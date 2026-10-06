/**
 * Real engine (E2): runs when the user has connected a Factory account and
 * picked a repository. Factory plays both roles: a Droid session in the
 * user's own Factory account is the lead (it plans, reviews every diff, and
 * asks the user questions; it never edits code), and the worker role is
 * either a Cursor cloud agent (when a Cursor key is connected) or a second
 * Factory session on the user's own computer. Large tasks split across up
 * to four parallel workers (a preference), each on its own branch; the
 * lead reviews each branch, fixes loop per job, and after every job passes
 * one worker integrates the branches and opens the pull request. The app
 * (Spriite) coordinates; it never edits code and never sends a key to a
 * service session. Progress stays deterministic milestone weight, and every
 * card is live: demo stays false and the context label carries no DEMO.
 *
 * Turn protocol with the lead session (kept deliberately strict so replies
 * are parseable on a 4-line HUD):
 * - plan request  -> "N. Label" lines
 * - verdict reply -> "VERDICT: PASS" / "VERDICT: FAIL <reasons>"
 * - any question  -> "DECISION: <one short question>"
 * - summary reply -> "SUMMARY: <one sentence>"
 *
 * Worker replies (session workers) use:
 * - "SUMMARY: <one sentence>" plus "BRANCH: <name>" or "PR: <url>"
 */
import { composeStatus } from '../scenes/compose'
import type { Scene, SceneProgress, SpritePose } from '../scenes/types'
import { BUDGETS, fitsWrappedLines } from '../scenes/validate'
import { sanitizeSpoken } from '../voice/intent'
import type { WorkerPref } from '../state/prefs'
import { COPY } from './copy'
import {
  cancelCursorRun,
  createCursorAgent,
  createCursorRun,
  cursorAgents,
  getCursorRun,
  type CursorAgentCard,
  type CursorRunState,
} from './cursor'
import type { EngineView } from './demo'
import type { FactoryEngine } from './engine'
import {
  factoryComputers,
  factoryCreateSession,
  factoryGetMessages,
  factoryGetSession,
  factoryInterrupt,
  factoryPostMessage,
  factorySessions,
  type FactoryMessage,
  type FactorySessionCard,
} from './fapi'
import { githubCreateRepo } from './github'

export type RealPhase =
  | 'meet'
  | 'goal'
  | 'transcript'
  | 'plan'
  | 'building'
  | 'review'
  | 'repair'
  | 'pr'
  | 'final'
  | 'attach'

export interface RealMilestone {
  id: string
  label: string
  weight: number
  status: 'pending' | 'submitted' | 'repair' | 'accepted'
}

/** One parallel job and the worker that builds it. */
export interface RealJob {
  label: string
  mode: 'cursor' | 'session'
  stage: 'build' | 'fix' | 'integration' | 'pr'
  agentId: string | null
  runId: string | null
  runStatus: string
  sessionId: string | null
  seenIds: string[]
  count: number
  lastCount: number
  awaiting: 'build' | 'fix' | null
  branch: string
  state: 'building' | 'queued' | 'review' | 'repair' | 'accepted' | 'stopped'
  weight: number
  nextPoll: number
  polling: boolean
}

/** What the fault card's Retry re-runs (poll faults have none: they resume). */
export type FaultRetry =
  | 'plan'
  | 'repo'
  | 'build'
  | 'fix'
  | 'integration'
  | 'pr'
  | 'verdict'
  | 'summary'
  | 'decision'
  | 'steer'

/** What a waiting start is blocked on (the panel save that fixes it resumes). */
export type BlockedStart = 'factory' | 'repo' | 'computer' | 'github'

export interface RealSnapshot {
  v: 1
  real: true
  phase: RealPhase
  goal: string
  capturedSec: number
  repoUrl: string
  /**
   * The repository this mission builds on, frozen when planning started (a
   * panel save mid-mission never moves a live run). Empty on old snapshots,
   * where the mission used the saved repository.
   */
  missionRepo: string
  /** A start waiting on a missing piece; null while nothing waits. */
  blockedStart: BlockedStart | null
  sessionId: string | null
  awaiting: 'plan' | 'verdict' | 'summary' | 'steer' | null
  workerPref: WorkerPref
  jobCount: number
  askBeforePr: boolean
  /** A cloud build being watched from the home list (no local mission). */
  attach: {
    source: 'factory' | 'cursor'
    title: string
    sessionId: string | null
    agentId: string | null
    runId: string | null
    runStatus: string
    computerId?: string | null
  } | null
  jobs: Array<Omit<RealJob, 'nextPoll' | 'polling'>>
  reviewQueue: number[]
  verdictJob: number | null
  integrating: boolean
  decisionPending: boolean
  decisionText: string
  decisionGate: boolean
  decisionKind: 'build' | 'pr'
  planLabels: string[]
  milestones: RealMilestone[]
  prUrl: string
  lastReply: string
  failReason: string
  finalSummary: string
  repairCount: number
  seenMessageIds: string[]
  messageCount: number
  faultKind: string | null
  faultSource: 'factory' | 'cursor' | 'github' | null
  /** Raw failure reason (console/phone detail; the HUD keeps short copy). */
  faultDetail: string
  /** Which step Retry re-runs on the fault card (null: polling resumes). */
  faultRetry: FaultRetry | null
  /** Job index for the fix/verdict retries. */
  faultRetryIndex: number | null
  /** Last texts sent to the lead (Retry re-sends them after a fault). */
  lastSteer: string
  lastDecision: string
  /** A typed repository name waiting for its new-repo start. */
  repoName: string
  seq: number
}

/** The service clients the engine drives (seam for fake-worker tests). */
export interface RealClients {
  createSession(opts: { computerId?: string }): Promise<{ sessionId: string }>
  getSession(sessionId: string): Promise<{ messageCount: number; status?: string }>
  getMessages(sessionId: string): Promise<Array<{ id: string; role: string; text: string }>>
  postMessage(sessionId: string, text: string, computerId?: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  /** The account's Droid Computers (sessions must name one to run on). */
  computers(): Promise<Array<{ id: string; name: string; status: string }>>
  /** The account's cloud builds (the home list), newest first. */
  listFactorySessions(): Promise<FactorySessionCard[]>
  listCursorAgents(): Promise<CursorAgentCard[]>
  /**
   * Create a repository for a mission that starts from scratch (bring-your-
   * own GitHub token). The name is derived from the goal or typed on the
   * phone; the repository is created private.
   */
  createRepo(name: string, isPrivate: boolean): Promise<{ url: string }>
  cursorAgent(promptText: string, repoUrl: string): Promise<{ agentId: string; runId: string | null }>
  cursorRun(agentId: string, promptText: string): Promise<{ runId: string }>
  cursorGet(agentId: string, runId: string): Promise<CursorRunState>
  cursorCancel(agentId: string, runId: string): Promise<void>
}

/**
 * Recent projects for the home list (the app wires the ProjectsVault in).
 * Read live at render time, so saves the app makes show up on the next card.
 * sessionId lets the home dedup cloud rows against locally-tracked missions.
 */
export interface ProjectsSource {
  list(): Array<{ goal: string; status: string; updatedAt?: number; sessionId?: string | null }>
  snapshotFor(goal: string): RealSnapshot | null
}

/** One row of the merged home list (local missions + cloud builds). */
interface HomeRow {
  kind: 'local' | 'factory' | 'cursor'
  title: string
  /** Text after the pipe: a status word, or "Source: word" for cloud rows. */
  tail: string
  /** Raw cloud status (attach cards start from it). */
  status: string
  goal: string | null
  sessionId: string | null
  agentId: string | null
  runId: string | null
  /** Factory rows: the session's computer; null when it runs locally. */
  computerId: string | null
  updatedAt: number
}

/** A cloud build being watched from the home list (runtime watch state). */
interface AttachWatch {
  source: 'factory' | 'cursor'
  title: string
  sessionId: string | null
  agentId: string | null
  runId: string | null
  runStatus: string
  /**
   * Factory: the session's computer. Sessions run locally (Factory app, CLI)
   * have none and reject API messages with a 400, so those are watch-only.
   */
  computerId: string | null
  /** Factory: existing history is marked seen once, then new replies show. */
  primed: boolean
  nextPoll: number
  polling: boolean
}

interface TransientState {
  scene: Scene
  until: number
}

const MS = (s: number) => s * 1000
const SESSION_POLL_MS = 3000
const RUN_POLL_MS = 5000
/** Home-list cloud refresh cadence (the list stays fresh while it shows). */
const CLOUD_REFRESH_MS = 30000
/** Home rows capped before the New-build entry (HUD scroll stays sane). */
const MAX_HOME_ROWS = 9
/** Home list item width (matches the copy measurer's list-item budget). */
const LIST_ITEM_W = 500

/** Longest form of `text` that fits the utterance budget's line count. */
function fitUtterance(text: string, maxLines = BUDGETS.utterance.lines): string {
  const clean = sanitizeSpoken(text.replace(/\s+/g, ' ').trim())
  if (fitsWrappedLines(clean, BUDGETS.utterance.width, maxLines)) return clean
  const words = clean.split(' ')
  while (words.length > 1) {
    words.pop()
    const shortened = `${words.join(' ')}...`
    if (fitsWrappedLines(shortened, BUDGETS.utterance.width, maxLines)) return shortened
  }
  return clean
}

function initialMilestones(): RealMilestone[] {
  return [
    { id: 'plan', label: 'Plan', weight: 20, status: 'pending' },
    { id: 'work', label: 'Work', weight: 65, status: 'pending' },
    { id: 'pr', label: 'PR', weight: 15, status: 'pending' },
  ]
}

function milestoneStatusWord(status: RealMilestone['status']): string {
  if (status === 'accepted') return 'verified'
  if (status === 'submitted') return 'in review'
  if (status === 'repair') return 'fixing'
  return 'pending'
}

/**
 * A fair repository name for a spoken goal: "Build a landing page for Acme!"
 * -> "build-a-landing-page-for-acme". New-repo missions name themselves.
 */
function repoNameFromGoal(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'spriite-build'
}

export class RealOrchestrator implements FactoryEngine {
  private phase: RealPhase = 'meet'
  private transient: TransientState | null = null
  private paused = false
  private goal = ''
  private capturedSec = 0
  private sessionId: string | null = null
  private awaiting: RealSnapshot['awaiting'] = null
  private jobs: RealJob[] = []
  private reviewQueue: number[] = []
  private verdictJob: number | null = null
  private integrating = false
  private decisionPending = false
  private decisionText = ''
  private decisionGate = false
  private decisionKind: RealSnapshot['decisionKind'] = 'build'
  private planLabels: string[] = []
  private milestones = initialMilestones()
  private prUrl = ''
  private lastReply = ''
  private failReason = ''
  private finalSummary = ''
  private repairCount = 0
  private seenMessageIds = new Set<string>()
  private messageCount = 0
  private lastCount = 0
  private overlay: 'plan_detail' | 'explain' | 'evidence' | null = null
  /** A worker stopped without delivering; shown until the user acts. */
  private workerIssue: string | null = null
  private faultKind: string | null = null
  private faultSource: RealSnapshot['faultSource'] = null
  /** The raw failure reason (e.g. "Factory HTTP 400 (computerId: ...)"). */
  private faultDetail = ''
  /** The step Retry re-runs on the fault card; null lets polling resume. */
  private faultRetry: FaultRetry | null = null
  /** Job index for the fix/verdict retries. */
  private faultRetryIndex: number | null = null
  /** Last texts sent to the lead (Retry re-sends them after a fault). */
  private lastSteer = ''
  private lastDecision = ''
  /**
   * A start that is waiting on a missing piece (key, repository, computer).
   * The configure() call that arrives with the piece resumes the start, so
   * a save on the phone never leaves the glasses on a stale prompt.
   */
  private blockedStart: BlockedStart | null = null
  /** A typed repository name waiting for its new-repo start. */
  private repoName = ''
  private seq = 0
  private nextLeadPoll = 0
  private pollingLead = false
  private busy = false
  /** Cloud builds behind the home rows (refreshed while the home shows). */
  private cloudSessions: FactorySessionCard[] = []
  private cloudAgents: CursorAgentCard[] = []
  private nextCloudPoll = 0
  private cloudBusy = false
  /** A cloud build picked from the home list, watched live. */
  private attach: AttachWatch | null = null
  /** Engine clock: kept in sync with tick(now); transients expire on it. */
  private nowMs = 0
  private lastView: EngineView | null = null
  private readonly emitView: (view: EngineView) => void
  /** Config is mutable: the panel saves hot-apply through configure(). */
  private factoryKey: string
  private cursorKey: string
  /** GitHub token (optional): mission-time repository creation. */
  private githubToken: string
  private repoUrl: string
  private computerId: string
  private workerPref: WorkerPref
  private jobCount: number
  private askBeforePr: boolean
  private readonly clients: RealClients
  private readonly projectsSource: ProjectsSource | null
  /**
   * The computer the mission's sessions run on, validated against the live
   * list at mission start (a saved id can go stale; an empty one means the
   * account had no computer when the key was saved). Factory requires a
   * computerId on every session create; without one the call 400s.
   */
  private resolvedComputerId: string | null = null
  /** The repository this mission builds on, frozen when planning starts. */
  private missionRepo = ''

  constructor(
    emitView: (view: EngineView) => void,
    deps: {
      factoryKey?: string
      cursorKey?: string
      githubToken?: string
      repoUrl?: string
      computerId?: string
      workerPref?: WorkerPref
      jobs?: number
      askBeforePr?: boolean
      clients?: RealClients
      projects?: ProjectsSource
    },
  ) {
    this.emitView = emitView
    this.factoryKey = deps.factoryKey ?? ''
    this.cursorKey = deps.cursorKey ?? ''
    this.githubToken = deps.githubToken ?? ''
    this.repoUrl = deps.repoUrl ?? ''
    this.projectsSource = deps.projects ?? null
    this.computerId = deps.computerId ?? ''
    this.workerPref = deps.workerPref ?? 'auto'
    this.jobCount = deps.jobs ?? 1
    this.askBeforePr = deps.askBeforePr === true
    this.clients = deps.clients ?? {
      createSession: (o) => factoryCreateSession(this.factoryKey, o),
      getSession: (id) => factoryGetSession(this.factoryKey, id),
      getMessages: (id) => factoryGetMessages(this.factoryKey, id),
      postMessage: async (id, text, computerId) => {
        await factoryPostMessage(this.factoryKey, id, text, computerId)
      },
      interrupt: async (id) => {
        await factoryInterrupt(this.factoryKey, id)
      },
      computers: () => factoryComputers(this.factoryKey),
      listFactorySessions: () => factorySessions(this.factoryKey),
      listCursorAgents: () => cursorAgents(this.cursorKey),
      createRepo: (name, isPrivate) => githubCreateRepo(this.githubToken, name, isPrivate),
      cursorAgent: (promptText, repoUrl) =>
        createCursorAgent(this.cursorKey, { promptText, repoUrl }),
      cursorRun: (agentId, promptText) =>
        createCursorRun(this.cursorKey, agentId, { promptText }),
      cursorGet: (agentId, runId) => getCursorRun(this.cursorKey, agentId, runId),
      cursorCancel: async (agentId, runId) => {
        await cancelCursorRun(this.cursorKey, agentId, runId)
      },
    }
  }

  /** Resolve the worker service per parallel job from the preference. */
  private jobModes(count: number): Array<'cursor' | 'session'> {
    if (!this.cursorKey || this.workerPref === 'factory') {
      return Array.from({ length: count }, () => 'session' as const)
    }
    if (this.workerPref === 'cursor' || this.workerPref === 'auto') {
      return Array.from({ length: count }, () => 'cursor' as const)
    }
    // mix: alternate services across the parallel jobs ("either" splits work)
    return Array.from({ length: count }, (_, i) => (i % 2 === 0 ? 'cursor' : 'session') as 'cursor' | 'session')
  }

  /**
   * Hot-apply connected accounts and preferences (the phone panel calls this
   * on every save; no reload, no restart). A running mission keeps its
   * workers; workers spawned afterwards follow the new setup. The home card
   * re-renders when the engine sits there. A start that was waiting on a
   * missing piece resumes in place the moment its save arrives, so the
   * glasses never stall on a prompt the user already answered on the phone.
   */
  configure(o: {
    factoryKey?: string
    cursorKey?: string
    githubToken?: string
    repoUrl?: string
    computerId?: string
    workerPref?: WorkerPref
    jobs?: number
    askBeforePr?: boolean
  }): void {
    const keysChanged =
      (o.factoryKey !== undefined && o.factoryKey !== this.factoryKey) ||
      (o.cursorKey !== undefined && o.cursorKey !== this.cursorKey)
    const oldComputerId = this.computerId
    this.factoryKey = o.factoryKey ?? this.factoryKey
    this.cursorKey = o.cursorKey ?? this.cursorKey
    this.githubToken = o.githubToken ?? this.githubToken
    this.repoUrl = o.repoUrl ?? this.repoUrl
    this.computerId = o.computerId ?? this.computerId
    if (this.computerId !== oldComputerId) {
      this.resolvedComputerId = null // revalidate against the new setup
    }
    this.workerPref = o.workerPref ?? this.workerPref
    this.jobCount = o.jobs ?? this.jobCount
    this.askBeforePr = o.askBeforePr ?? this.askBeforePr
    if (keysChanged) {
      // A different account means a different cloud build list.
      this.cloudSessions = []
      this.cloudAgents = []
      this.nextCloudPoll = 0
    }
    if (this.blockedStart && this.phase === 'transcript') {
      // Resume the waiting start when the arriving save fixes its piece.
      if (this.blockedStart === 'factory' && this.factoryKey) {
        void this.startPlanning()
        return
      }
      if (this.blockedStart === 'github' && this.githubToken) {
        void this.startNewRepo()
        return
      }
      if (this.blockedStart === 'repo' && (this.missionRepo || this.repoUrl)) {
        void this.startPlanning()
        return
      }
      if (this.blockedStart === 'computer' && this.computerId !== oldComputerId) {
        void this.startPlanning() // revalidate against the new saved computer
        return
      }
      // Still blocked: refresh the card only when the missing piece moved.
      const piece = this.blockedPiece()
      if (piece && piece !== this.blockedStart) this.emitBlockedPrompt(piece)
      return
    }
    if (this.phase === 'meet') this.emitCurrent() // connect affordances changed
  }

  /** The first missing piece for a start, in the order startPlanning checks. */
  private blockedPiece(): BlockedStart | null {
    if (!this.factoryKey) return 'factory'
    if (this.blockedStart === 'github' && !this.githubToken) return 'github'
    if (!(this.missionRepo || this.repoUrl)) return 'repo'
    // A computer needs a live list to check; only the prompt's Retry does.
    return this.blockedStart === 'computer' ? 'computer' : null
  }

  /** Show the waiting-start prompt for `piece` and remember the wait. */
  private emitBlockedPrompt(piece: BlockedStart): void {
    this.blockedStart = piece
    if (piece === 'factory') {
      this.emitConnectPrompt(COPY.real.needFactory, COPY.real.needFactoryStatus, COPY.real.needFactoryActions)
      return
    }
    if (piece === 'github') {
      this.emitConnectPrompt(COPY.real.needGithub, COPY.real.needGithubStatus, COPY.real.needGithubActions)
      return
    }
    if (piece === 'repo') {
      this.emitConnectPrompt(COPY.real.needRepo, COPY.real.needRepoStatus, COPY.real.needRepoActions)
      return
    }
    this.emitConnectPrompt(COPY.real.needComputer, COPY.real.needComputerStatus, COPY.real.needComputerActions)
  }

  // ------------------------------------------------------------- progress

  private missionActive(): boolean {
    return ['plan', 'building', 'review', 'repair', 'pr', 'final'].includes(this.phase)
  }

  private progress(): SceneProgress | null {
    if (!this.missionActive()) return null
    const accepted = this.milestones
      .filter((m) => m.status === 'accepted')
      .reduce((n, m) => n + m.weight, 0)
    const pending = this.milestones
      .filter((m) => m.status === 'submitted')
      .reduce((n, m) => n + m.weight, 0)
    return { acceptedWeight: accepted, pendingReviewWeight: pending, totalWeight: 100, planRevision: 1 }
  }

  private setStatus(id: string, status: RealMilestone['status']): void {
    const m = this.milestones.find((x) => x.id === id)
    if (m) m.status = status
  }

  /** Display phase from the parallel jobs (repair > review > building). */
  private updatePhase(): void {
    if (this.phase === 'final') return
    if (this.jobs.some((j) => j.state === 'repair')) {
      this.phase = 'repair'
      return
    }
    const reviewing = this.verdictJob !== null || this.jobs.some((j) => j.state === 'queued' || j.state === 'review')
    if (reviewing) {
      this.phase = 'review'
      return
    }
    if (this.jobs.some((j) => j.state === 'building')) this.phase = 'building'
  }

  // --------------------------------------------------------------- scenes

  private scene(kind: Scene['kind'], o: {
    pose: SpritePose
    utterance: string
    status?: string
    statusNote?: string
    actions?: Scene['actions']
    evidence?: string[]
    transientMs?: number
  }): Scene {
    const progress = this.progress()
    return {
      schemaVersion: 1,
      sceneId: `${kind}_${this.seq + 1}`,
      sceneRevision: this.seq + 1,
      missionId: this.missionActive() ? 'mission_live' : null,
      stateSequence: this.seq + 1,
      kind,
      spritePose: o.pose,
      contextLabel: COPY.real.context,
      utterance: o.utterance,
      status: o.status ?? composeStatus(progress, o.statusNote ?? ''),
      progress,
      actions: o.actions ?? [],
      evidenceIds: o.evidence ?? [],
      generatedAt: new Date().toISOString(),
      demo: false,
      transientMs: o.transientMs ?? 0,
    }
  }

  /** One home-list line: "title | tail", fit to one row. */
  private homeItem(title: string, tail: string): string {
    const clean = sanitizeSpoken(String(title ?? '').replace(/\s+/g, ' ').trim())
    const text = `${clean} | ${tail}`
    if (fitsWrappedLines(text, LIST_ITEM_W, 1)) return text
    const words = clean.split(' ')
    while (words.length > 1) {
      words.pop()
      const shortened = `${words.join(' ')}... | ${tail}`
      if (fitsWrappedLines(shortened, LIST_ITEM_W, 1)) return shortened
    }
    return tail
  }

  /**
   * The merged home rows: locally-tracked missions first-class (a snapshot
   * resumes them), the account's other cloud builds (Factory sessions, Cursor
   * agents) watchable, and cloud rows already tracked locally deduped away.
   * Newest activity wins; capped before the New-build row.
   */
  private buildHomeRows(): HomeRow[] {
    const locals = (this.projectsSource?.list() ?? []).map((p) => ({
      kind: 'local' as const,
      title: p.goal,
      tail: COPY.real.statusWords[String(p.status ?? '')] ?? 'building',
      status: String(p.status ?? ''),
      goal: p.goal,
      sessionId: p.sessionId ?? null,
      agentId: null,
      runId: null,
      computerId: null,
      updatedAt: p.updatedAt ?? 0,
    }))
    const tracked = new Set(locals.map((l) => l.sessionId).filter((id): id is string => Boolean(id)))
    const factories = this.cloudSessions
      .filter((s) => !tracked.has(s.sessionId))
      .map((s) => ({
        kind: 'factory' as const,
        title: s.title || 'Factory build',
        tail: `${COPY.real.factoryTag}: ${COPY.real.statusWords[s.status] ?? 'waiting'}`,
        status: s.status,
        goal: null,
        sessionId: s.sessionId,
        agentId: null,
        runId: null,
        computerId: s.computerId || null,
        updatedAt: s.updatedAt,
      }))
    const cursors = this.cloudAgents.map((a) => ({
      kind: 'cursor' as const,
      title: a.name || 'Cursor build',
      tail: `${COPY.real.cursorTag}: ${COPY.real.statusWords[a.status] ?? 'waiting'}`,
      status: a.status,
      goal: null,
      sessionId: null,
      agentId: a.agentId,
      runId: a.latestRunId,
      computerId: null,
      updatedAt: a.updatedAt,
    }))
    return [...locals, ...factories, ...cursors]
      .sort((x, y) => y.updatedAt - x.updatedAt)
      .slice(0, MAX_HOME_ROWS)
  }

  /** The home card: merged project + cloud rows, New build always last. */
  private meetView(): EngineView {
    if (!this.factoryKey) {
      return {
        type: 'scene',
        scene: this.scene('setup_notice', {
          pose: 'idle', utterance: COPY.real.needFactory,
          statusNote: COPY.real.needFactoryStatus, actions: COPY.real.needFactoryActions,
        }),
      }
    }
    const rows = this.buildHomeRows()
    return {
      type: 'selection', purpose: 'projects', contextLabel: COPY.real.context,
      title: COPY.real.projectsTitle,
      items: [
        ...rows.map((r) => this.homeItem(r.title, r.tail)),
        COPY.real.newBuildItem,
      ],
      pose: 'idle',
    }
  }

  /** A watched cloud build: its live status and latest reply. */
  private attachView(): EngineView {
    const watch = this.attach
    if (!watch) return this.meetView() // a stale snapshot restore falls home
    const tag = watch.source === 'factory' ? COPY.real.factoryTag : COPY.real.cursorTag
    const word = COPY.real.statusWords[watch.runStatus] ?? COPY.real.attachWatching
    const only = this.attachSteerable() ? '' : ` | ${COPY.real.attachWatchOnly}`
    return {
      type: 'scene',
      scene: this.scene('running', {
        pose: 'planning',
        utterance: this.lastReply || watch.title,
        statusNote: `${tag}: ${word}${only}`,
        actions: COPY.real.attachActions,
      }),
    }
  }

  private baseView(): EngineView {
    switch (this.phase) {
      case 'meet':
        // Home. With Factory connected it is the merged builds list (local
        // missions resume, cloud sessions and agents watch); without it, a
        // connect prompt. Setup never gates the app: Spriite boots here first.
        return this.meetView()
      case 'attach':
        return this.attachView()
      case 'goal':
        return { type: 'selection', purpose: 'goal', contextLabel: COPY.real.context, title: COPY.real.goalList.title, items: COPY.real.goalList.items, pose: 'idle' }
      case 'transcript':
        return {
          type: 'scene',
          scene: this.scene('transcript', {
            pose: 'waiting', utterance: this.goal,
            status: COPY.real.transcriptStatus(this.capturedSec),
            actions: COPY.real.transcriptActions,
          }),
        }
      case 'plan':
        return {
          type: 'scene',
          scene: this.scene('plan', {
            pose: 'planning',
            utterance: this.planLabels.length > 0
              ? (this.jobCount > 1 ? COPY.real.planReadySplit(this.jobCount) : COPY.real.planReady)
              : COPY.real.planDrafting,
            statusNote: this.planLabels.length > 0
              ? (this.jobCount > 1 ? `${this.planLabels.length} jobs` : `${this.planLabels.length} milestones`)
              : 'Factory planning',
            actions: this.planLabels.length > 0 ? COPY.real.planActions : COPY.real.planDraftingActions,
          }),
        }
      case 'building':
        return {
          type: 'scene',
          scene: this.scene('running', {
            pose: 'planning',
            utterance: this.integrating ? COPY.real.integrationStage
              : this.jobs.length > 1 ? COPY.real.buildingSplit(this.jobs.length)
                : COPY.real.building,
            statusNote: this.integrating ? COPY.real.integrationStatusNote
              : this.jobs.length > 1 ? COPY.real.buildingStatusNoteSplit(this.jobs.length)
                : COPY.real.buildingStatusNote,
            actions: COPY.real.runningActions,
          }),
        }
      case 'review':
        return {
          type: 'scene',
          scene: this.scene('under_review', {
            pose: 'checking', utterance: COPY.real.pushedForReview,
            statusNote: COPY.real.reviewStatusNote, actions: COPY.real.beatActions,
            evidence: this.evidenceIds(),
          }),
        }
      case 'repair':
        return {
          type: 'scene',
          scene: this.scene('repair', {
            pose: 'repair', utterance: COPY.real.verdictFail,
            statusNote: COPY.real.repairStatusNote, actions: COPY.real.beatActions,
            evidence: this.evidenceIds(),
          }),
        }
      case 'pr':
        return {
          type: 'scene',
          scene: this.scene('running', {
            pose: 'switching', utterance: COPY.real.prStage,
            statusNote: COPY.real.prStatusNote, actions: COPY.real.runningActions,
          }),
        }
      case 'final':
        return {
          type: 'scene',
          scene: this.scene('final', {
            pose: 'accepted', utterance: this.finalSummary || COPY.real.prReady,
            actions: COPY.real.finalActions, evidence: this.evidenceIds(),
          }),
        }
    }
  }

  private overlayView(): EngineView {
    switch (this.overlay) {
      case 'plan_detail':
        return {
          type: 'selection', purpose: 'plan_detail', contextLabel: COPY.real.context,
          title: COPY.real.planDetailTitle,
          items: this.milestones.map((m) => `${m.label} | ${milestoneStatusWord(m.status)}`),
          pose: 'planning',
        }
      case 'evidence':
        return {
          type: 'selection', purpose: 'evidence', contextLabel: COPY.real.context,
          title: COPY.real.evidenceTitle, items: this.evidenceItems(), pose: 'accepted',
        }
      case 'explain':
        return {
          type: 'scene',
          scene: this.scene('explain', {
            pose: 'checking',
            utterance: this.lastReply || this.failReason || COPY.real.statusAnswers[this.phase] || COPY.real.prReady,
            actions: [{ id: 'back', label: 'Back', kind: 'command' }],
            evidence: this.evidenceIds(),
          }),
        }
      default:
        return this.baseView()
    }
  }

  private computeView(): EngineView {
    if (this.faultKind) return this.faultView()
    if (this.decisionPending) {
      return {
        type: 'scene',
        scene: this.scene('decision', {
          pose: 'asking', utterance: this.decisionText,
          statusNote: '1 choice needed',
          actions: this.decisionKind === 'pr' ? COPY.real.prGateActions : COPY.real.gateActions,
          evidence: this.evidenceIds(),
        }),
      }
    }
    if (this.workerIssue) {
      return {
        type: 'scene',
        scene: this.scene('repair', {
          pose: 'repair', utterance: this.workerIssue,
          statusNote: 'Worker stopped', actions: COPY.real.stoppedActions,
          evidence: this.evidenceIds(),
        }),
      }
    }
    if (this.paused) {
      return {
        type: 'scene',
        scene: this.scene('paused', { pose: 'idle', utterance: COPY.real.paused, actions: COPY.real.pausedActions }),
      }
    }
    if (this.transient) return { type: 'scene', scene: this.transient.scene }
    if (this.overlay) return this.overlayView()
    return this.baseView()
  }

  private faultView(): EngineView {
    const utterance =
      this.faultKind === 'forbidden' ? COPY.real.errors.forbidden
        : this.faultKind === 'auth' ? COPY.real.errors.auth
          : this.faultKind === 'billing' ? COPY.real.errors.billing
            : this.faultKind === 'quota' ? COPY.real.errors.quota
              : this.faultKind === 'network' ? COPY.real.errors.network
                : this.faultKind === 'offline' ? COPY.real.errors.offline
                  : this.faultKind === 'permission' ? COPY.real.errors.permission
                    : this.faultKind === 'exists' ? COPY.real.errors.exists
                      : COPY.real.errors.service
    return {
      type: 'scene',
      scene: this.scene('factory_error', {
        pose: 'repair', utterance,
        status: this.faultStatusNote(), actions: COPY.real.failActions,
        evidence: this.evidenceIds(),
      }),
    }
  }

  /**
   * Fault status line: the standard note plus the raw code (e.g. "Factory
   * HTTP 400") fitted to one row, so the glasses name the failure and the
   * phone (which mirrors this line) can lead with it. The offline fault
   * names the machine instead of a code: that is the thing to fix.
   */
  private faultStatusNote(): string {
    if (this.faultKind === 'offline') return COPY.real.offlineStatus
    return this.failureNoteFor(this.faultDetail)
  }

  private failureNote(e: unknown): string {
    return this.failureNoteFor(e instanceof Error ? e.message : String(e ?? ''))
  }

  private failureNoteFor(detail: string): string {
    const base = COPY.real.errorStatus
    if (!detail) return base
    const short = detail.split(' (')[0].replace(/\s+/g, ' ').trim()
    // The utterance already says nothing changed; the row keeps the code.
    const text = `Service failed | ${short}`
    if (fitsWrappedLines(text, BUDGETS.status.width, BUDGETS.status.lines)) return text
    return `Service failed | ${short.slice(0, 16)}...`
  }

  private evidenceIds(): string[] {
    const ids: string[] = []
    if (this.sessionId) ids.push(`lead_${this.sessionId.slice(0, 8)}`)
    for (const job of this.jobs) {
      if (job.sessionId) ids.push(`job_${job.sessionId.slice(0, 8)}`)
      if (job.agentId) ids.push(`job_${job.agentId.slice(0, 8)}`)
      if (job.runId) ids.push(`run_${job.runId.slice(0, 8)}`)
      if (job.branch) ids.push(`branch_${job.branch.slice(0, 24)}`)
    }
    if (this.prUrl) ids.push(`pr_${/pull\/(\d+)/.exec(this.prUrl)?.[1] ?? 'ready'}`)
    return ids
  }

  private evidenceItems(): string[] {
    const items: string[] = []
    if (this.sessionId) items.push(`Lead session ${this.sessionId.slice(0, 8)}`)
    for (const job of this.jobs) {
      const tag = job.mode === 'cursor' ? 'agent' : 'session'
      const id = (job.mode === 'cursor' ? job.agentId : job.sessionId) ?? ''
      if (id) items.push(`Job: ${tag} ${id.slice(0, 8)}`)
      if (job.branch) items.push(`Job: branch ${job.branch.slice(0, 28)}`)
    }
    const prNum = /pull\/(\d+)/.exec(this.prUrl)?.[1]
    if (prNum) items.push(`PR #${prNum}`)
    if (this.lastReply) items.push('Reply saved | see Explain')
    return items.length > 0 ? items : ['Nothing recorded yet']
  }

  private emit(view: EngineView): void {
    this.seq += 1
    this.lastView = view
    if (view.type === 'scene') {
      const p = view.scene.progress
      console.log(
        `[scene] kind=${view.scene.kind} seq=${view.scene.stateSequence} rev=${view.scene.sceneRevision} pose=${view.scene.spritePose} live=1` +
          (p ? ` accepted=${p.acceptedWeight} pending=${p.pendingReviewWeight} total=${p.totalWeight}` : ''),
      )
    } else {
      console.log(`[scene] kind=selection seq=${this.seq} items=${view.items.length} purpose=${view.purpose}`)
    }
    this.emitView(view)
  }

  private emitCurrent(): void {
    this.emit(this.computeView())
  }

  private emitTransientScene(scene: Scene, ms: number): void {
    this.transient = { scene, until: this.nowMs + ms }
    this.emit({ type: 'scene', scene })
  }

  // -------------------------------------------------------------- polling

  tick(now = Date.now()): void {
    this.nowMs = now
    if (this.transient && now >= this.transient.until) {
      this.transient = null
      this.emitCurrent()
    }
    if (this.faultKind) return // a failed service stays failed until acted on
    // The home list stays fresh while it shows (cloud rows update live).
    if (this.phase === 'meet' && this.factoryKey && !this.cloudBusy && now >= this.nextCloudPoll) {
      this.nextCloudPoll = now + CLOUD_REFRESH_MS
      void this.refreshCloud()
    }
    if (this.sessionId && !this.pollingLead && now >= this.nextLeadPoll) {
      this.nextLeadPoll = now + SESSION_POLL_MS
      void this.pollLead()
    }
    const watch = this.attach
    if (
      watch && watch.source === 'cursor' && watch.agentId && watch.runId &&
      !watch.polling && now >= watch.nextPoll
    ) {
      watch.nextPoll = now + RUN_POLL_MS
      void this.pollAttachWorker()
    }
    for (const job of this.jobs) {
      if (job.state === 'building' && !job.polling && now >= job.nextPoll) {
        job.nextPoll = now + (job.mode === 'cursor' ? RUN_POLL_MS : SESSION_POLL_MS)
        void this.pollJob(job)
      }
    }
  }

  /** Network blips are retried on the next tick; other faults surface. */
  private isBlip(e: unknown): boolean {
    return e instanceof Error && 'kind' in e && (e as { kind: unknown }).kind === 'network'
  }

  private async pollLead(): Promise<void> {
    if (!this.sessionId || this.pollingLead || this.faultKind) return
    this.pollingLead = true
    try {
      const info = await this.clients.getSession(this.sessionId)
      this.messageCount = info.messageCount
      const watch = this.attach
      if (watch && watch.source === 'factory' && watch.sessionId === this.sessionId) {
        if (watch.runStatus !== info.status && info.status) {
          watch.runStatus = info.status
          this.emitCurrent()
        }
        if (!watch.primed) {
          // First watch poll: mark the existing history seen, show the latest
          // reply, and only surface messages that arrive from here on.
          watch.primed = true
          this.lastCount = info.messageCount
          const messages = await this.clients.getMessages(this.sessionId)
          for (const m of messages) this.seenMessageIds.add(m.id)
          const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.text)
          if (last) this.lastReply = fitUtterance(last.text)
          this.emitCurrent()
          return
        }
      }
      if (info.messageCount > this.lastCount) {
        this.lastCount = info.messageCount
        await this.fetchNewMessages()
      }
    } catch (e) {
      if (!this.isBlip(e)) this.fault(e, 'factory')
    } finally {
      this.pollingLead = false
    }
  }

  private async fetchNewMessages(): Promise<void> {
    if (!this.sessionId) return
    const messages = await this.clients.getMessages(this.sessionId)
    const fresh: FactoryMessage[] = []
    for (const m of messages) {
      if (this.seenMessageIds.has(m.id)) continue
      this.seenMessageIds.add(m.id)
      if (m.role === 'assistant' && m.text) fresh.push(m as FactoryMessage)
    }
    for (const m of fresh) this.handleReply(m.text)
  }

  private async pollJob(job: RealJob): Promise<void> {
    if (job.polling || job.state !== 'building' || this.faultKind) return
    job.polling = true
    const source = job.mode === 'cursor' ? 'cursor' : 'factory'
    try {
      if (job.mode === 'cursor') {
        if (!job.agentId || !job.runId) return
        const run = await this.clients.cursorGet(job.agentId, job.runId)
        job.runStatus = run.status
        if (run.status === 'FINISHED') await this.handleRunDone(job, run)
        else if (run.status === 'ERROR' || run.status === 'CANCELLED' || run.status === 'EXPIRED') {
          this.handleRunFailed(job, run)
        }
      } else {
        if (!job.sessionId) return
        const info = await this.clients.getSession(job.sessionId)
        job.count = info.messageCount
        if (info.messageCount > job.lastCount) {
          job.lastCount = info.messageCount
          const messages = await this.clients.getMessages(job.sessionId)
          for (const m of messages) {
            if (job.seenIds.includes(m.id)) continue
            job.seenIds.push(m.id)
            if (m.role === 'assistant' && m.text && job.state === 'building') {
              this.handleWorkerReply(job, m.text)
            }
          }
        }
      }
    } catch (e) {
      if (!this.isBlip(e)) this.fault(e, source)
    } finally {
      job.polling = false
    }
  }

  /**
   * Cloud builds for the home rows (Factory sessions, Cursor agents). Listing
   * is a convenience: failures stay quiet (the local rows still render) and
   * the cadence retries; the account gates (401/403) surface on attach only.
   */
  private async refreshCloud(): Promise<void> {
    if (this.cloudBusy || this.faultKind) return
    this.cloudBusy = true
    try {
      if (this.factoryKey) this.cloudSessions = await this.clients.listFactorySessions()
      if (this.cursorKey) this.cloudAgents = await this.clients.listCursorAgents()
    } catch (e) {
      console.warn('[engine] cloud list failed:', e instanceof Error ? e.message : e)
    } finally {
      this.cloudBusy = false
      if (this.phase === 'meet') this.emitCurrent() // rows may have changed
    }
  }

  /** Poll a watched Cursor build: its run state and final summary. */
  private async pollAttachWorker(): Promise<void> {
    const watch = this.attach
    if (!watch || watch.source !== 'cursor' || watch.polling || this.faultKind) return
    if (!watch.agentId || !watch.runId) return
    watch.polling = true
    try {
      const run = await this.clients.cursorGet(watch.agentId, watch.runId)
      if (this.attach !== watch) return // the user moved on
      if (run.text && run.text !== this.lastReply) {
        watch.runStatus = run.status
        this.lastReply = fitUtterance(run.text)
        this.emitCurrent()
        return
      }
      if (watch.runStatus !== run.status) {
        watch.runStatus = run.status
        this.emitCurrent()
      }
    } catch (e) {
      if (!this.isBlip(e)) this.fault(e, 'cursor')
    } finally {
      watch.polling = false
    }
  }

  // -------------------------------------------------------- session turns

  /** A connect prompt (transient-free root card; back returns home). */
  private emitConnectPrompt(utterance: string, statusNote: string, actions: Scene['actions']): void {
    this.emit({
      type: 'scene',
      scene: this.scene('setup_notice', { pose: 'idle', utterance, statusNote, actions }),
    })
  }

  /**
   * The computer this mission's sessions run on. Factory requires an active
   * computerId on every session create; a provisioning, errored, or missing
   * computer fails the create (the generic service-failed card), so only
   * active computers are picked: the saved one when still active, else the
   * account's first active one. An empty result gets an honest connect
   * prompt instead of a failed call.
   */
  private async resolveComputer(): Promise<string> {
    if (this.resolvedComputerId) return this.resolvedComputerId
    let id = ''
    try {
      const computers = await this.clients.computers()
      const saved = this.computerId ? computers.find((c) => c.id === this.computerId) : undefined
      const pick =
        (saved && saved.status === 'active' ? saved : undefined) ??
        computers.find((c) => c.status === 'active')
      if (pick) id = pick.id // a stale/inactive saved pick is replaced
    } catch (e) {
      // Listing failed (e.g. a network blip): fall back to the saved pick;
      // the create call surfaces a real fault if that one is bad too.
      if (!(e instanceof Error) || !('kind' in e) || (e as { kind: unknown }).kind !== 'network') {
        console.warn('[engine] computer list failed:', e instanceof Error ? e.message : e)
      }
      if (this.computerId) id = this.computerId
    }
    if (id) this.resolvedComputerId = id
    return id
  }

  /** Create the lead session and ask for the milestone (or job) plan. */
  private async startPlanning(): Promise<void> {
    if (this.busy || this.sessionId) return
    this.busy = true // held across the awaits so a double save cannot double-start
    try {
      // Missing pieces prompt from inside the flow; they never gate the app.
      // blockedStart remembers the wait, so the panel save that fixes the
      // piece resumes this start (the glasses never stall on a stale prompt).
      if (!this.factoryKey) {
        this.emitBlockedPrompt('factory')
        return
      }
      if (!(this.missionRepo || this.repoUrl)) {
        this.emitBlockedPrompt('repo')
        return
      }
      const computerId = await this.resolveComputer()
      if (!computerId) {
        this.emitBlockedPrompt('computer')
        return
      }
      this.blockedStart = null
      // The repository is frozen per mission: a panel save mid-mission never
      // moves a live run onto a different repository.
      this.missionRepo = this.missionRepo || this.repoUrl
      this.phase = 'plan'
      this.emitCurrent() // drafting card
      const created = await this.clients.createSession({ computerId })
      this.sessionId = created.sessionId
      this.lastCount = 0
      this.seenMessageIds.clear()
      await this.clients.postMessage(this.sessionId, this.planRequest())
      this.awaiting = 'plan'
    } catch (e) {
      if (!this.isBlip(e)) this.fault(e, 'factory', 'plan')
    } finally {
      this.busy = false
    }
  }

  private planRequest(): string {
    const lines = [
      'You are the orchestrator of a software factory run by Spriite for one developer.',
      'You coordinate; you do not edit code.',
      `Mission goal: ${this.goal}`,
      `Repository the worker builds on: ${this.missionRepo}`,
    ]
    if (this.jobCount > 1) {
      lines.push(
        `The work will be split across ${this.jobCount} workers building in parallel, each on its own branch.`,
        `Reply with 2 to ${this.jobCount} numbered lines, each exactly "N. Label", grouping the goal into jobs that can be built independently.`,
      )
    } else {
      lines.push('Reply with a milestone plan: 3 to 5 numbered lines, each exactly "N. Label - what done means".')
    }
    lines.push('Numbered lines only. No other text.')
    return lines.join('\n')
  }

  private verdictRequest(job: RealJob): string {
    return [
      `The worker pushed branch "${job.branch}" on ${this.missionRepo}.`,
      `Job: ${job.label}`,
      `Review the diff on that branch against the goal: ${this.goal}`,
      'Reply with VERDICT: PASS or VERDICT: FAIL followed by the key reasons, under 80 words.',
      'If you need the user to decide something, reply DECISION: followed by one short question.',
    ].join('\n')
  }

  private handleReply(text: string): void {
    const flat = text.replace(/\s+/g, ' ').trim()
    const decision = /^DECISION:\s*/i.exec(flat)
    if (decision) {
      this.lastReply = fitUtterance(flat)
      this.decisionText = fitUtterance(flat.slice(decision[0].length)) || COPY.real.startDecision
      this.decisionGate = false
      this.decisionKind = 'build'
      this.decisionPending = true
      this.awaiting = null
      this.emitCurrent()
      return
    }
    switch (this.awaiting) {
      case 'plan': {
        this.awaiting = null
        // Plan lines are parsed from the raw text: numbered lines only work
        // if newlines survive (they carry one label each).
        const labels: string[] = []
        for (const line of text.split('\n')) {
          const m = /^\s*\d+[.)]\s*(.+)$/.exec(line.trim())
          if (m) labels.push(m[1].replace(/\s*[-–—]\s*.*$/, '').trim())
        }
        this.planLabels = labels.length >= 2 ? labels : [`Deliver: ${this.goal}`]
        this.setStatus('plan', 'accepted')
        this.lastReply = fitUtterance(flat)
        this.emitCurrent()
        return
      }
      case 'verdict': {
        this.awaiting = null
        const v = /VERDICT:\s*(PASS|FAIL)/i.exec(flat)
        this.lastReply = fitUtterance(flat)
        const index = this.verdictJob
        this.verdictJob = null
        if (v && v[1].toUpperCase() === 'PASS') {
          this.acceptJob(index)
          return
        }
        this.failJob(index, flat)
        return
      }
      case 'summary': {
        this.awaiting = null
        this.finalSummary = fitUtterance(flat)
        this.lastReply = this.finalSummary
        this.emitCurrent()
        return
      }
      case 'steer': {
        this.awaiting = null
        this.lastReply = fitUtterance(flat)
        this.emitTransientScene(
          this.scene('status_answer', {
            pose: 'waiting', utterance: this.lastReply,
            statusNote: 'Spriite replied', actions: [{ id: 'back', label: 'Back', kind: 'command' }],
            transientMs: MS(8),
          }),
          MS(8),
        )
        return
      }
      default: {
        this.lastReply = fitUtterance(flat)
        return // general replies stay reachable via Explain and status
      }
    }
  }

  // ------------------------------------------------------------- the jobs

  private createJobs(): RealJob[] {
    const labels = this.planLabels.length > 0 ? this.planLabels : [`Deliver: ${this.goal}`]
    const count = Math.min(this.jobCount, Math.max(1, labels.length))
    const modes = this.jobModes(count)
    const base = Math.floor(65 / count)
    const bump = 65 - base * count
    return labels.slice(0, count).map((label, i) => ({
      label,
      mode: modes[i],
      stage: 'build' as const,
      agentId: null,
      runId: null,
      runStatus: '',
      sessionId: null,
      seenIds: [],
      count: 0,
      lastCount: 0,
      awaiting: 'build' as const,
      branch: '',
      state: 'building' as const,
      weight: base + (i < bump ? 1 : 0),
      nextPoll: 0,
      polling: false,
    }))
  }

  private buildMilestones(jobs: RealJob[]): RealMilestone[] {
    return [
      { id: 'plan', label: 'Plan', weight: 20, status: 'accepted' },
      ...jobs.map((j, i) => ({ id: `job_${i}`, label: j.label, weight: j.weight, status: 'pending' as const })),
      { id: 'pr', label: 'PR', weight: 15, status: 'pending' },
    ]
  }

  private replyFormat(job: RealJob): string[] {
    return job.mode === 'session'
      ? ['When done, reply with exactly these lines:', 'SUMMARY: <one sentence>', 'BRANCH: <branch name>']
      : ['When done, reply with a short summary of what you changed.']
  }

  private jobBuildPrompt(job: RealJob, index: number, total: number): string {
    return [
      `Mission goal: ${this.goal}`,
      `Your job (job ${index + 1} of ${total}): ${job.label}`,
      `Implement it on the repository ${this.missionRepo}.`,
      `Push your work to a new branch named spriite/job-${index + 1}. Do not open a pull request.`,
      ...this.replyFormat(job),
    ].join('\n')
  }

  private jobFixPrompt(job: RealJob): string {
    return [
      'The review failed. Findings:',
      this.failReason || 'The reviewer rejected the change.',
      'Fix the findings. Push to your branch. Do not open a pull request.',
      ...(job.mode === 'session'
        ? ['Reply with SUMMARY: and BRANCH: lines as before.']
        : ['Reply with a short summary of what you changed.']),
    ].join('\n')
  }

  private integrationPrompt(job: RealJob, branches: string[]): string {
    return [
      `Mission goal: ${this.goal}`,
      'All jobs passed review. Merge these branches into one new branch named spriite/integration:',
      ...branches.map((b) => `- ${b}`),
      `Repository: ${this.missionRepo}. Resolve conflicts; keep every feature.`,
      'Push the integration branch. Do not open a pull request.',
      ...this.replyFormat(job),
    ].join('\n')
  }

  private prPrompt(job: RealJob): string {
    const branch = this.integrating ? 'spriite/integration' : job.branch
    const lines = [
      'The review passed.',
      `Open a pull request from branch "${branch}" to the main branch on ${this.missionRepo}.`,
    ]
    if (job.mode === 'session') {
      lines.push('Reply with exactly these lines:', 'SUMMARY: <one sentence>', 'PR: <the pull request URL>')
    } else {
      lines.push('Reply with the pull request URL.')
    }
    return lines.join('\n')
  }

  /** Spawn a brand-new worker for a job (build stage only). */
  private async spawnJob(job: RealJob, promptText: string): Promise<void> {
    if (job.mode === 'cursor') {
      const created = await this.clients.cursorAgent(promptText, this.missionRepo)
      job.agentId = created.agentId
      if (created.runId) {
        job.runId = created.runId
      } else {
        job.runId = (await this.clients.cursorRun(job.agentId, promptText)).runId
      }
      job.runStatus = 'RUNNING'
    } else {
      // Factory plays the worker too: a session on the user's own computer,
      // separate from the lead so builder and reviewer differ.
      const created = await this.clients.createSession({
        computerId: this.resolvedComputerId ?? this.computerId,
      })
      job.sessionId = created.sessionId
      job.count = 0
      job.lastCount = 0
      job.seenIds = []
      await this.clients.postMessage(job.sessionId, promptText)
    }
    job.state = 'building'
    job.nextPoll = 0
  }

  /** Send a follow-up prompt to a job's existing worker (fix, integrate, PR). */
  private async runJobPrompt(job: RealJob, promptText: string): Promise<void> {
    if (job.mode === 'cursor') {
      if (!job.agentId) throw new Error('no worker agent')
      const run = await this.clients.cursorRun(job.agentId, promptText)
      job.runId = run.runId
      job.runStatus = 'RUNNING'
    } else {
      if (!job.sessionId) throw new Error('no worker session')
      await this.clients.postMessage(job.sessionId, promptText)
    }
    job.state = 'building'
    job.nextPoll = 0
  }

  /** True once a job's worker exists (a cursor worker also needs its run). */
  private jobSpawned(job: RealJob): boolean {
    return job.mode === 'cursor' ? Boolean(job.agentId && job.runId) : Boolean(job.sessionId)
  }

  /**
   * Spawn the mission's workers. Jobs that already have a worker are skipped,
   * so the fault card's Retry (after a mid-spawn failure) resumes the build
   * without duplicating the workers that did start.
   */
  private async startBuild(): Promise<void> {
    if (this.busy || this.faultKind) return
    if (this.jobs.length > 0 && this.jobs.every((j) => this.jobSpawned(j))) return // in flight
    this.busy = true
    this.decisionPending = false
    try {
      if (this.jobs.length === 0) {
        this.jobs = this.createJobs()
        this.milestones = this.buildMilestones(this.jobs)
      }
      const total = this.jobs.length
      for (let i = 0; i < total; i++) {
        if (this.jobSpawned(this.jobs[i])) continue // already spawned
        await this.spawnJob(this.jobs[i], this.jobBuildPrompt(this.jobs[i], i, total))
      }
      this.phase = 'building'
      this.emitCurrent()
    } catch (e) {
      const stalled = this.jobs.find((j) => !this.jobSpawned(j))
      if (!this.isBlip(e)) this.fault(e, stalled?.mode === 'cursor' ? 'cursor' : 'factory', 'build')
    } finally {
      this.busy = false
    }
  }

  private async startFixRun(index: number): Promise<void> {
    const job = this.jobs[index]
    if (!job || this.faultKind) return
    try {
      await this.runJobPrompt(job, this.jobFixPrompt(job))
      job.awaiting = 'fix'
      job.stage = 'fix'
      this.workerIssue = null
      this.updatePhase()
      this.emitCurrent()
    } catch (e) {
      if (!this.isBlip(e)) this.fault(e, job.mode === 'cursor' ? 'cursor' : 'factory', 'fix', index)
    }
  }

  /** All jobs passed: one worker merges the branches into one. */
  private async startIntegration(): Promise<void> {
    if (this.busy || this.faultKind) return
    const branches = this.jobs.map((j) => j.branch).filter(Boolean)
    if (branches.length === 0) return
    const job = this.jobs[0]
    if (!job) return
    this.busy = true
    this.integrating = true
    try {
      job.stage = 'integration'
      job.branch = ''
      await this.runJobPrompt(job, this.integrationPrompt(job, branches))
      this.setStatus('pr', 'submitted')
      this.updatePhase()
      this.emitCurrent()
    } catch (e) {
      if (!this.isBlip(e)) this.fault(e, job.mode === 'cursor' ? 'cursor' : 'factory', 'integration')
    } finally {
      this.busy = false
    }
  }

  /** Ask before the worker opens the PR, or open it now (a preference). */
  private askPrOrOpen(): void {
    if (this.askBeforePr) {
      this.decisionKind = 'pr'
      this.decisionGate = true
      this.decisionText = COPY.real.prAsk
      this.decisionPending = true
      this.emitCurrent()
      return
    }
    void this.startPrStage()
  }

  private async startPrStage(): Promise<void> {
    if (this.busy || this.faultKind) return
    const job = this.jobs[0]
    if (!job || !(job.mode === 'cursor' ? job.agentId : job.sessionId)) return
    this.busy = true
    this.emitTransientScene(
      this.scene('accepted', {
        pose: 'accepted', utterance: COPY.real.verified,
        actions: COPY.real.beatActions, evidence: this.evidenceIds(),
        transientMs: MS(6),
      }),
      MS(6),
    )
    try {
      job.stage = 'pr'
      await this.runJobPrompt(job, this.prPrompt(job))
      this.setStatus('pr', 'submitted')
      this.phase = 'pr'
    } catch (e) {
      if (!this.isBlip(e)) this.fault(e, job.mode === 'cursor' ? 'cursor' : 'factory', 'pr')
    } finally {
      this.busy = false
    }
  }

  /** A job's branch (or the integration branch) is ready: queue it for the
   *  lead's verdict; verdicts stay sequential so replies stay parseable. */
  private queueForReview(job: RealJob): void {
    job.awaiting = null
    job.state = 'queued'
    const index = this.jobs.indexOf(job)
    if (job.stage === 'build' || job.stage === 'fix') this.setStatus(`job_${index}`, 'submitted')
    this.reviewQueue.push(index)
    this.updatePhase()
    this.emitCurrent()
    this.dequeueNextReview()
  }

  private dequeueNextReview(): void {
    if (this.verdictJob !== null || !this.sessionId || this.faultKind) return
    const next = this.reviewQueue.shift()
    if (next === undefined) return
    const job = this.jobs[next]
    if (!job) return
    job.state = 'review'
    this.verdictJob = next
    this.updatePhase()
    this.emitCurrent()
    void this.postVerdictRequest(job)
  }

  private async postVerdictRequest(job: RealJob): Promise<void> {
    if (!this.sessionId) return
    try {
      await this.clients.postMessage(this.sessionId, this.verdictRequest(job))
      this.awaiting = 'verdict'
    } catch (e) {
      const index = this.jobs.indexOf(job)
      if (!this.isBlip(e)) this.fault(e, 'factory', 'verdict', index >= 0 ? index : undefined)
    }
  }

  private acceptJob(index: number | null): void {
    const job = typeof index === 'number' ? this.jobs[index] : null
    if (job) {
      job.state = 'accepted'
      if (job.stage === 'build' || job.stage === 'fix') this.setStatus(`job_${index}`, 'accepted')
    }
    if (this.integrating) {
      // the integration branch passed review: open the PR (maybe ask first)
      this.askPrOrOpen()
      return
    }
    if (this.jobs.length > 0 && this.jobs.every((j) => j.state === 'accepted')) {
      if (this.jobs.length > 1) {
        this.emitTransientScene(
          this.scene('accepted', {
            pose: 'accepted', utterance: COPY.real.verified,
            actions: COPY.real.beatActions, evidence: this.evidenceIds(),
            transientMs: MS(6),
          }),
          MS(6),
        )
        void this.startIntegration()
      } else {
        this.askPrOrOpen()
      }
      return
    }
    this.updatePhase()
    this.emitCurrent()
    this.dequeueNextReview()
  }

  private failJob(index: number | null, reply: string): void {
    const job = typeof index === 'number' ? this.jobs[index] : null
    this.repairCount += 1
    this.failReason = fitUtterance(reply.replace(/^.*?VERDICT:\s*FAIL\s*/i, ''))
    if (job) {
      job.state = 'repair'
      if (job.stage === 'build' || job.stage === 'fix') this.setStatus(`job_${index}`, 'repair')
      this.updatePhase()
      this.emitCurrent()
      void this.startFixRun(index)
    } else {
      this.emitCurrent()
    }
  }

  // ---------------------------------------------------------- worker side

  /** Parse a session worker's structured reply and route it by stage. */
  private handleWorkerReply(job: RealJob, text: string): void {
    const reply = text.replace(/\s+/g, ' ').trim()
    const branch = /BRANCH:\s*(\S+)/i.exec(reply)?.[1] ?? ''
    const prUrl = /PR:\s*(\S+)/i.exec(reply)?.[1] ?? ''
    const summary = /SUMMARY:\s*(.*)$/i.exec(reply)?.[1] ?? reply
    this.lastReply = fitUtterance(summary)
    if (job.stage === 'pr') {
      if (prUrl) {
        job.state = 'accepted' // delivered: stop polling this worker
        void this.finishPr(prUrl)
      } else {
        this.failReason = this.lastReply
        this.workerIssue = COPY.real.workerNoPr
        job.state = 'stopped'
        this.emitCurrent()
      }
      return
    }
    // build, fix, or integration: the worker must hand back a branch
    if (!branch) {
      this.failReason = this.lastReply
      this.workerIssue = COPY.real.workerNoBranch
      job.state = 'stopped'
      this.emitCurrent()
      return
    }
    job.branch = branch
    this.queueForReview(job)
  }

  private async handleRunDone(job: RealJob, run: CursorRunState): Promise<void> {
    job.runStatus = ''
    const branch = run.branches.find((b) => b.branch)?.branch ?? job.branch
    const prUrl = run.branches.find((b) => b.prUrl)?.prUrl ?? ''
    if (branch) job.branch = branch
    if (job.stage === 'pr') {
      if (prUrl) {
        job.state = 'accepted' // delivered: stop polling this worker
        await this.finishPr(prUrl)
        return
      }
      this.failReason = run.text
      this.workerIssue = COPY.real.workerNoPr
      job.state = 'stopped'
      this.emitCurrent()
      return
    }
    // build or fix finished: hand the branch to the lead for review
    if (!branch) {
      this.failReason = run.text
      this.workerIssue = COPY.real.workerNoBranch
      job.state = 'stopped'
      this.emitCurrent()
      return
    }
    this.queueForReview(job)
  }

  private handleRunFailed(job: RealJob, run: CursorRunState): void {
    job.runStatus = ''
    this.failReason = run.text
    this.workerIssue = COPY.real.workerFailed
    job.state = 'stopped'
    this.emitCurrent()
  }

  private async finishPr(prUrl: string): Promise<void> {
    this.prUrl = prUrl
    this.setStatus('pr', 'accepted')
    this.phase = 'final'
    this.emitCurrent()
    await this.postPrSummary()
  }

  /** Ask the lead for the final one-sentence summary (after the PR opens). */
  private async postPrSummary(): Promise<void> {
    if (!this.sessionId) return
    try {
      await this.clients.postMessage(this.sessionId, [
        `The pull request is open: ${this.prUrl}`,
        'Reply with SUMMARY: one sentence on what was delivered.',
      ].join('\n'))
      this.awaiting = 'summary'
    } catch (e) {
      if (!this.isBlip(e)) this.fault(e, 'factory', 'summary')
    }
  }

  // ----------------------------------------------------------- engine I/O

  handleAction(id: string): void {
    switch (id) {
      case 'start_planning':
        void this.startPlanning()
        return
      case 'new_repo':
        // The transcript card and the missing-repo prompt offer it: start
        // (or restart) the pending goal in a brand-new repository.
        this.startNewRepo()
        return
      case 'retry_start':
        // The missing-computer prompt: re-attempt the start in place (the
        // user may have just brought the daemon back online).
        void this.startPlanning()
        return
      case 'retry':
        this.retryFault()
        return
      case 'begin':
        // Start build: confirm once; live runs spend credits.
        if (this.phase === 'plan' && this.planLabels.length > 0) {
          this.decisionKind = 'build'
          this.decisionGate = true
          this.decisionText = COPY.real.startDecision
          this.decisionPending = true
          this.emitCurrent()
        }
        return
      case 'use_it': {
        if (!this.decisionPending) return
        if (this.decisionGate) {
          const kind = this.decisionKind
          this.decisionPending = false
          this.decisionGate = false
          if (kind === 'pr') void this.startPrStage()
          else void this.startBuild()
          return
        }
        void this.answerDecision('Yes - proceed with your recommendation.')
        return
      }
      case 'open_pr':
        if (this.decisionPending && this.decisionKind === 'pr') {
          this.decisionPending = false
          this.decisionGate = false
          void this.startPrStage()
        }
        return
      case 'change_goal':
        this.phase = 'goal'
        break
      case 'milestones':
        this.overlay = 'plan_detail'
        break
      case 'explain':
        this.overlay = 'explain'
        break
      case 'show_evidence':
        this.overlay = 'evidence'
        break
      case 'back':
        if (this.overlay) this.overlay = null
        else if (this.transient) this.transient = null
        break
      case 'pause':
        this.pauseToggle()
        return
      case 'resume':
        this.pauseToggle()
        return
      case 'restart':
        this.reset()
        return
      default:
        console.warn('[engine] unknown action', id)
        return
    }
    this.emitCurrent()
  }

  /** Answer the pending decision with the user's words. */
  private async answerDecision(text: string): Promise<void> {
    if (!this.decisionPending || !this.sessionId) return
    this.decisionPending = false
    this.lastDecision = text
    this.busy = true
    try {
      await this.clients.postMessage(this.sessionId, text)
      this.awaiting = 'steer'
      this.emitCurrent()
    } catch (e) {
      if (!this.isBlip(e)) this.fault(e, 'factory', 'decision')
    } finally {
      this.busy = false
    }
  }

  // ---------------------------------------------------- new-repo missions

  /**
   * Start the pending goal in a brand-new GitHub repository. The glasses
   * action derives the name from the goal; the phone can type one (kept in
   * repoName by sayNewRepo). Without a GitHub token the card says how to add
   * one, and the save that adds it resumes the start.
   */
  startNewRepo(): void {
    if (!this.goal || this.sessionId || this.busy || this.faultKind) return
    if (!this.githubToken) {
      this.emitBlockedPrompt('github')
      return
    }
    void this.createRepoAndPlan()
  }

  /**
   * Typed goal from the phone that should build in a brand-new repository.
   * Returns where the text went, like say().
   */
  sayNewRepo(text: string, name: string): 'goal' | 'steer' | 'none' {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean || !this.acceptsGoal()) return 'none'
    this.repoName = name.replace(/\s+/g, ' ').trim()
    if (this.sessionId) {
      // A running mission takes it as steering, like any other new goal.
      return this.steer(`New goal: ${clean}`) ? 'steer' : 'none'
    }
    this.goal = clean
    this.capturedSec = 0
    this.phase = 'transcript'
    this.emitCurrent()
    this.startNewRepo()
    return 'goal'
  }

  /** Create `base`; a taken name steps aside (-2, -3, then a dated name). */
  private async createRepoWithFallback(base: string): Promise<{ url: string }> {
    const isTaken = (e: unknown): boolean =>
      e instanceof Error && 'kind' in e && (e as { kind: unknown }).kind === 'exists'
    for (const name of [base, `${base}-2`, `${base}-3`]) {
      try {
        return await this.clients.createRepo(name, true)
      } catch (e) {
        if (!isTaken(e)) throw e
      }
    }
    return this.clients.createRepo(`${base}-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}`, true)
  }

  /** Create the new repository, freeze it as this mission's repo, and plan. */
  private async createRepoAndPlan(): Promise<void> {
    if (this.busy || this.sessionId) return
    const base = this.repoName || repoNameFromGoal(this.goal)
    this.repoName = ''
    this.busy = true
    this.blockedStart = null
    this.emitTransientScene(
      this.scene('status_answer', {
        pose: 'planning', utterance: COPY.real.creatingRepo,
        statusNote: COPY.real.creatingRepoStatus,
        actions: [{ id: 'back', label: 'Back', kind: 'command' }],
        transientMs: MS(20),
      }),
      MS(20),
    )
    try {
      const created = await this.createRepoWithFallback(base)
      this.missionRepo = created.url
    } catch (e) {
      if (!this.isBlip(e)) this.fault(e, 'github', 'repo')
      return
    } finally {
      this.busy = false
    }
    this.transient = null // the drafting card replaces the creating card
    await this.startPlanning()
  }

  // ---------------------------------------------------------------- faults

  /**
   * The fault card's Retry: clear the failure and re-run the step that
   * failed. Poll faults have no recorded step; clearing the card lets the
   * tick loop resume them.
   */
  private retryFault(): void {
    if (!this.faultKind) return
    const retry = this.faultRetry
    const index = this.faultRetryIndex
    this.faultKind = null
    this.faultSource = null
    this.faultDetail = ''
    this.faultRetry = null
    this.faultRetryIndex = null
    switch (retry) {
      case 'plan':
        void this.startPlanning()
        return
      case 'repo':
        void this.createRepoAndPlan()
        return
      case 'build':
        void this.startBuild()
        return
      case 'fix':
        if (index !== null) void this.startFixRun(index)
        else this.emitCurrent()
        return
      case 'integration':
        void this.startIntegration()
        return
      case 'pr':
        void this.startPrStage()
        return
      case 'verdict': {
        const job = index !== null ? this.jobs[index] : null
        if (job) void this.postVerdictRequest(job)
        else this.emitCurrent()
        return
      }
      case 'summary':
        void this.postPrSummary()
        return
      case 'decision':
        void this.answerDecision(this.lastDecision)
        return
      case 'steer':
        void this.postSteer(this.lastSteer)
        return
      default:
        this.emitCurrent() // a poll fault: the tick loop resumes
    }
  }

  chooseGoalList(_index: number): 'talk' | 'done' {
    // Real mode takes goals by voice; the list offers the Talk entry only.
    return 'talk'
  }

  chooseList(index: number): void {
    if (this.overlay === 'plan_detail' || this.overlay === 'evidence') {
      this.overlay = null
      this.emitCurrent()
      return
    }
    if (this.phase !== 'meet') return
    // Home list: a local row resumes that mission (its snapshot returns;
    // polling picks the lead session back up). A cloud row watches that
    // build live. The last row starts a new one.
    const rows = this.buildHomeRows()
    if (index >= 0 && index < rows.length) {
      const row = rows[index]
      if (row.kind === 'local') {
        const snap = row.goal !== null ? this.projectsSource?.snapshotFor(row.goal) : null
        if (snap) {
          this.restore(snap)
          this.emitCurrent()
        }
        return
      }
      if (row.kind === 'factory') {
        this.attachFactoryRow(row)
        return
      }
      this.attachCursorRow(row)
      return
    }
    if (index === rows.length) {
      this.phase = 'goal' // the goal list: Talk (or a saved goal)
      this.emitCurrent()
    }
  }

  /** Watch a Factory cloud session picked from the home list. */
  private attachFactoryRow(row: HomeRow): void {
    if (!row.sessionId) return
    this.attach = {
      source: 'factory',
      title: row.title,
      sessionId: row.sessionId,
      agentId: null,
      runId: null,
      runStatus: row.status,
      computerId: row.computerId,
      primed: false,
      nextPoll: 0,
      polling: false,
    }
    this.phase = 'attach'
    this.sessionId = row.sessionId
    this.awaiting = 'steer' // replies surface as cards; Talk steers it
    this.seenMessageIds.clear()
    this.messageCount = 0
    this.lastCount = 0
    this.lastReply = ''
    this.nextLeadPoll = 0 // first poll primes history, then new replies show
    this.emitCurrent()
  }

  /** Watch a Cursor cloud agent picked from the home list. */
  private attachCursorRow(row: HomeRow): void {
    if (!row.agentId) return
    this.attach = {
      source: 'cursor',
      title: row.title,
      sessionId: null,
      agentId: row.agentId,
      runId: row.runId,
      runStatus: row.status,
      computerId: null,
      primed: true, // no history to prime; the run poll drives the card
      nextPoll: 0,
      polling: false,
    }
    this.phase = 'attach'
    this.sessionId = null
    this.awaiting = null
    this.lastReply = ''
    this.emitCurrent()
  }

  /** Leave a watched build (it keeps running; nothing is cancelled). */
  private detach(): void {
    this.attach = null
    this.phase = 'meet'
    this.sessionId = null
    this.awaiting = null
    this.lastReply = ''
    this.seenMessageIds.clear()
    this.messageCount = 0
    this.lastCount = 0
    this.nextLeadPoll = 0
    this.nextCloudPoll = 0 // refresh the row's live status for the list
  }

  transcriptGoal(sec: number): void {
    // No live STT this turn: a real mission cannot invent a goal (honesty).
    // Pre-mission, the transcript card replays the captured goal. Mid-mission
    // nothing can be captured, so the card says what is missing instead of
    // switching to a transcript card the running mission cannot answer.
    if (this.goal && !this.sessionId) {
      this.phase = 'transcript'
      this.capturedSec = sec
      this.emitCurrent()
      return
    }
    this.emit({
      type: 'scene',
      scene: this.scene('setup_notice', {
        pose: 'idle', utterance: COPY.real.needsVoiceKey,
        actions: COPY.real.needVoiceActions, status: 'Voice | key needed',
      }),
    })
  }

  /**
   * Only a Factory session on a Droid Computer takes messages from the API.
   * Cursor watches and locally-run Factory sessions are watch-only: a new
   * goal said there starts a new build instead.
   */
  private attachSteerable(): boolean {
    const w = this.attach
    return Boolean(w && w.source === 'factory' && w.sessionId && w.computerId)
  }

  voiceGoal(text: string, sec: number): void {
    if (this.phase === 'attach') this.detach() // the watched build keeps running
    if (this.sessionId) {
      // A running mission takes a new spoken goal as steering for the lead
      // (it can re-plan). Overwriting the goal silently would strand the
      // live run behind a card whose Start action no-ops.
      this.steer(`New goal: ${text}`)
      return
    }
    this.goal = text
    this.capturedSec = sec
    this.phase = 'transcript'
    this.emitCurrent()
  }

  steer(text: string): boolean {
    if (this.faultKind && this.faultSource === 'factory') return false
    if (!this.sessionId) return false
    if (this.phase === 'attach' && !this.attachSteerable()) return false
    void this.postSteer(text)
    return true
  }

  /** Typed text from the phone: decision answer, goal, or steering. */
  say(text: string): 'goal' | 'steer' | 'decision' | 'none' {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) return 'none'
    if (this.decisionPending) {
      if (this.decisionGate) {
        // The gate is Spriite's own confirmation (credits, PR): yes confirms,
        // no declines, other words go to the lead while the gate waits.
        if (/^(y|yes|yep|yeah|sure|ok|okay|go|start|begin|confirm|proceed|do it|please do)\b/i.test(clean)) {
          this.handleAction('use_it')
          return 'decision'
        }
        if (/^(n|no|nope|stop|cancel|wait|not yet|later|hold off)\b/i.test(clean)) {
          this.decisionPending = false
          this.emitCurrent()
          return 'decision'
        }
        if (this.steer(clean)) return 'steer'
        return 'none'
      }
      void this.answerDecision(clean)
      return 'decision'
    }
    if (this.acceptsGoal()) {
      // Typing is deliberate: the phone goal launches planning directly (the
      // credit gate still asks before the build).
      const launch = this.phase !== 'plan'
      this.voiceGoal(clean, 0)
      if (launch) void this.startPlanning()
      return 'goal'
    }
    if (this.steer(clean)) return 'steer'
    return 'none'
  }

  /** The merged builds rows for the phone's companion view. */
  listBuilds(): Array<{ title: string; note: string; kind: 'local' | 'factory' | 'cursor' }> {
    return this.buildHomeRows().map((r) => ({
      title: sanitizeSpoken(String(r.title ?? '').replace(/\s+/g, ' ').trim()),
      note: r.tail,
      kind: r.kind,
    }))
  }

  /** Open a build row from the phone; false while a mission owns the engine. */
  openBuild(index: number): boolean {
    if (this.phase !== 'meet') return false
    this.chooseList(index)
    return true
  }

  private async postSteer(text: string): Promise<void> {
    if (this.busy || !this.sessionId) return
    this.busy = true
    this.decisionPending = false
    this.lastSteer = text
    const watching = this.phase === 'attach'
    try {
      await this.clients.postMessage(this.sessionId, text, this.attach?.computerId ?? undefined)
      this.awaiting = this.awaiting ?? 'steer'
      this.emitCurrent()
    } catch (e) {
      if (this.isBlip(e)) return
      if (watching) {
        // A watched build is not Spriite's mission: a refused message says
        // why on a card and leaves the watch (and the app) usable.
        this.emitTransientScene(
          this.scene('status_answer', {
            pose: 'repair', utterance: COPY.real.attachSendFailed,
            statusNote: this.failureNote(e), actions: [{ id: 'back', label: 'Back', kind: 'command' }],
            transientMs: MS(8),
          }),
          MS(8),
        )
        return
      }
      this.fault(e, 'factory', 'steer')
    } finally {
      this.busy = false
    }
  }

  talkStatus(): void {
    const acceptedCount = this.milestones.filter((m) => m.status === 'accepted').length
    this.emitTransientScene(
      this.scene('status_answer', {
        pose: this.phase === 'final' ? 'accepted' : 'waiting',
        utterance: COPY.real.statusAnswers[this.phase] || COPY.real.prReady,
        statusNote: `${acceptedCount} of ${this.milestones.length} steps verified`,
        actions: [{ id: 'back', label: 'Back', kind: 'command' }],
        evidence: this.evidenceIds(),
        transientMs: MS(8),
      }),
      MS(8),
    )
  }

  pauseToggle(): void {
    if (this.paused) {
      this.paused = false
      void this.resumeLead()
      return
    }
    if (!this.sessionId || this.decisionPending) {
      console.warn('[engine] pause needs a running orchestrator')
      return
    }
    this.paused = true
    void this.clients.interrupt(this.sessionId).catch(() => undefined)
    this.emitCurrent()
  }

  private async resumeLead(): Promise<void> {
    if (!this.sessionId) return
    this.busy = true
    this.lastSteer = 'Continue.'
    try {
      await this.clients.postMessage(this.sessionId, 'Continue.')
      this.awaiting = this.awaiting ?? 'steer'
      this.emitCurrent()
    } catch (e) {
      if (!this.isBlip(e)) this.fault(e, 'factory', 'steer')
    } finally {
      this.busy = false
    }
  }

  acceptsGoal(): boolean {
    if (this.faultKind) return false // the fault card owns the engine until acted on
    if (this.phase === 'attach') return !this.attachSteerable()
    // 'plan' only before the lead session exists; once it does, a new goal is
    // steering (voiceGoal routes it), not a fresh transcript.
    return (
      ['meet', 'goal', 'transcript'].includes(this.phase) ||
      (this.phase === 'plan' && !this.sessionId)
    )
  }

  canPause(): boolean {
    return Boolean(this.sessionId) && !this.paused && !this.faultKind && !this.decisionPending
  }

  canResume(): boolean {
    return this.paused
  }

  canExplain(): boolean {
    return this.missionActive() || this.phase === 'attach'
  }

  get hasPendingDecision(): boolean {
    return this.decisionPending
  }

  back(): 'exit' | 'handled' {
    if (this.overlay) {
      this.overlay = null
      this.emitCurrent()
      return 'handled'
    }
    if (this.transient) {
      this.transient = null
      this.emitCurrent()
      return 'handled'
    }
    if (this.decisionPending) {
      // A pending question persists; it is never dropped by the back gesture.
      this.emitCurrent()
      return 'handled'
    }
    switch (this.phase) {
      case 'goal':
        this.phase = 'meet'
        break
      case 'transcript':
        this.phase = 'goal'
        break
      case 'plan':
        this.phase = 'transcript'
        break
      case 'attach':
        // Leave the watched build (it keeps running; nothing is cancelled).
        this.detach()
        break
      default:
        return 'exit' // meet, building, review, repair, pr, final: root cards
    }
    this.emitCurrent()
    return 'handled'
  }

  // ------------------------------------------------------------- lifecycle

  private fault(
    e: unknown,
    source: 'factory' | 'cursor' | 'github',
    retry?: FaultRetry,
    retryIndex?: number,
  ): void {
    const kind = e instanceof Error && 'kind' in e ? String((e as { kind: unknown }).kind) : 'service'
    if (this.faultKind) return // the first failure owns the card
    this.faultKind = kind
    this.faultSource = source
    this.faultDetail = e instanceof Error ? e.message : String(e ?? '')
    this.faultRetry = retry ?? null
    this.faultRetryIndex = retryIndex ?? null
    console.warn(`[engine] ${source} fault (${kind}):`, this.faultDetail)
    this.emitCurrent()
  }

  reset(): void {
    if (this.sessionId) {
      void this.clients.interrupt(this.sessionId).catch(() => undefined)
    }
    for (const job of this.jobs) {
      if (job.mode === 'cursor') {
        if (job.agentId && job.runId) {
          void this.clients.cursorCancel(job.agentId, job.runId).catch(() => undefined)
        }
      } else if (job.sessionId) {
        void this.clients.interrupt(job.sessionId).catch(() => undefined)
      }
    }
    this.phase = 'meet'
    this.transient = null
    this.overlay = null
    this.paused = false
    this.decisionPending = false
    this.decisionGate = false
    this.decisionKind = 'build'
    this.decisionText = ''
    this.goal = ''
    this.capturedSec = 0
    this.sessionId = null
    this.awaiting = null
    this.jobs = []
    this.reviewQueue = []
    this.verdictJob = null
    this.integrating = false
    this.planLabels = []
    this.milestones = initialMilestones()
    this.prUrl = ''
    this.lastReply = ''
    this.failReason = ''
    this.finalSummary = ''
    this.repairCount = 0
    this.workerIssue = null
    this.seenMessageIds.clear()
    this.messageCount = 0
    this.lastCount = 0
    this.faultKind = null
    this.faultSource = null
    this.faultDetail = ''
    this.faultRetry = null
    this.faultRetryIndex = null
    this.blockedStart = null
    this.missionRepo = ''
    this.repoName = ''
    this.lastSteer = ''
    this.lastDecision = ''
    this.busy = false
    this.attach = null
    this.cloudSessions = []
    this.cloudAgents = []
    this.nextCloudPoll = 0 // the home refetches its cloud rows right away
    this.resolvedComputerId = null // the next mission revalidates the computer
    this.emitCurrent()
  }

  boot(): void {
    this.emitCurrent()
  }

  get currentView(): EngineView {
    return this.lastView ?? this.computeView()
  }

  snapshot(): RealSnapshot {
    return {
      v: 1,
      real: true,
      phase: this.phase,
      goal: this.goal,
      capturedSec: this.capturedSec,
      repoUrl: this.repoUrl,
      missionRepo: this.missionRepo,
      blockedStart: this.blockedStart,
      sessionId: this.sessionId,
      awaiting: this.awaiting,
      workerPref: this.workerPref,
      jobCount: this.jobCount,
      askBeforePr: this.askBeforePr,
      attach: this.attach
        ? {
            source: this.attach.source,
            title: this.attach.title,
            sessionId: this.attach.sessionId,
            agentId: this.attach.agentId,
            runId: this.attach.runId,
            runStatus: this.attach.runStatus,
            computerId: this.attach.computerId,
          }
        : null,
      jobs: this.jobs.map((j) => ({
        label: j.label,
        mode: j.mode,
        stage: j.stage,
        agentId: j.agentId,
        runId: j.runId,
        runStatus: j.runStatus,
        sessionId: j.sessionId,
        seenIds: [...j.seenIds],
        count: j.count,
        lastCount: j.lastCount,
        awaiting: j.awaiting,
        branch: j.branch,
        state: j.state,
        weight: j.weight,
      })),
      reviewQueue: [...this.reviewQueue],
      verdictJob: this.verdictJob,
      integrating: this.integrating,
      decisionPending: this.decisionPending,
      decisionText: this.decisionText,
      decisionGate: this.decisionGate,
      decisionKind: this.decisionKind,
      planLabels: this.planLabels,
      milestones: this.milestones,
      prUrl: this.prUrl,
      lastReply: this.lastReply,
      failReason: this.failReason,
      finalSummary: this.finalSummary,
      repairCount: this.repairCount,
      seenMessageIds: [...this.seenMessageIds],
      messageCount: this.messageCount,
      faultKind: this.faultKind,
      faultSource: this.faultSource,
      faultDetail: this.faultDetail,
      faultRetry: this.faultRetry,
      faultRetryIndex: this.faultRetryIndex,
      lastSteer: this.lastSteer,
      lastDecision: this.lastDecision,
      repoName: this.repoName,
      seq: this.seq,
    }
  }

  restore(snap: unknown): void {
    const s = snap as RealSnapshot | null
    if (!s || s.real !== true || s.v !== 1) return // not ours: start fresh
    // Job-based snapshots only; older single-worker formats start fresh.
    if (!Array.isArray(s.jobs)) return
    // The worker setup is fixed at construction (it depends on connected
    // accounts and preferences). A snapshot from another setup belongs to
    // another mission: start fresh rather than track workers we cannot reach.
    if ((s.workerPref ?? 'auto') !== this.workerPref || (s.jobCount ?? 1) !== this.jobCount) return
    this.phase = s.phase ?? 'meet'
    this.goal = s.goal ?? ''
    this.capturedSec = s.capturedSec ?? 0
    // The mission's repository is frozen per mission; older snapshots carry
    // only the global one (which the mission used back then).
    this.missionRepo = s.missionRepo ?? s.repoUrl ?? ''
    this.blockedStart = s.blockedStart ?? null // a later panel save still resumes it
    this.sessionId = s.sessionId ?? null
    this.awaiting = s.awaiting ?? null
    this.jobs = s.jobs.map((j) => ({
      label: String(j.label ?? ''),
      mode: j.mode === 'cursor' ? 'cursor' : 'session',
      stage: j.stage === 'fix' || j.stage === 'integration' || j.stage === 'pr' ? j.stage : 'build',
      agentId: j.agentId ?? null,
      runId: j.runId ?? null,
      runStatus: j.runStatus ?? '',
      sessionId: j.sessionId ?? null,
      seenIds: Array.isArray(j.seenIds) ? j.seenIds.map(String) : [],
      count: j.count ?? 0,
      lastCount: j.lastCount ?? 0,
      awaiting: j.awaiting ?? null,
      branch: j.branch ?? '',
      state: j.state ?? 'building',
      weight: j.weight ?? 0,
      nextPoll: 0,
      polling: false,
    }))
    this.reviewQueue = Array.isArray(s.reviewQueue) ? s.reviewQueue.map(Number) : []
    this.verdictJob = s.verdictJob ?? null
    this.integrating = s.integrating === true
    this.decisionPending = s.decisionPending ?? false
    this.decisionText = s.decisionText ?? ''
    this.decisionGate = s.decisionGate ?? false
    this.decisionKind = s.decisionKind === 'pr' ? 'pr' : 'build'
    const a = s.attach
    this.attach =
      a && (a.source === 'factory' || a.source === 'cursor')
        ? {
            source: a.source,
            title: String(a.title ?? ''),
            sessionId: a.sessionId ?? null,
            agentId: a.agentId ?? null,
            runId: a.runId ?? null,
            runStatus: String(a.runStatus ?? ''),
            computerId: typeof a.computerId === 'string' && a.computerId ? a.computerId : null,
            // The first poll after a restore re-primes: history stays seen,
            // then new replies surface.
            primed: false,
            nextPoll: 0,
            polling: false,
          }
        : null
    if (this.phase === 'attach' && !this.attach) this.phase = 'meet'
    this.planLabels = Array.isArray(s.planLabels) ? s.planLabels : []
    this.milestones = Array.isArray(s.milestones) && s.milestones.length >= 2 ? s.milestones : initialMilestones()
    this.prUrl = s.prUrl ?? ''
    this.lastReply = s.lastReply ?? ''
    this.failReason = s.failReason ?? ''
    this.finalSummary = s.finalSummary ?? ''
    this.repairCount = s.repairCount ?? 0
    this.seenMessageIds = new Set(Array.isArray(s.seenMessageIds) ? s.seenMessageIds : [])
    this.messageCount = s.messageCount ?? 0
    this.lastCount = this.messageCount
    this.paused = false // a pause never auto-resumes
    this.faultKind = s.faultKind ?? null
    this.faultSource = s.faultSource ?? null
    this.faultDetail = typeof s.faultDetail === 'string' ? s.faultDetail : ''
    this.faultRetry = s.faultRetry ?? null
    this.faultRetryIndex = s.faultRetryIndex ?? null
    this.lastSteer = s.lastSteer ?? ''
    this.lastDecision = s.lastDecision ?? ''
    this.repoName = s.repoName ?? ''
    this.transient = null
    this.overlay = null
    this.workerIssue = null
    this.busy = false
  }
}
