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
 * card is live.
 * This is retained session/agent orchestration, not a native Factory
 * root/spec/child adapter. That actual native adapter remains unimplemented
 * and unavailable; offline retained qualification is not a native canary gate.
 *
 * Turn protocol with the lead session (kept deliberately strict so replies
 * are parseable on a 4-line HUD):
 * - plan request  -> "N. Label" lines
 * - verdict reply -> "VERDICT: PASS" / "VERDICT: FAIL <reasons>"
 * - any question  -> "DECISION: <one short question>" then an
 *   "OPTIONS: one | two | three" line (2-4 one-line options; a question
 *   without them still gets the plain decision card)
 * - summary reply -> "SUMMARY: <one sentence>"
 *
 * Worker replies (session workers) use:
 * - "SUMMARY: <one sentence>" plus "BRANCH: <name>" or "PR: <url>"
 */
import { SPEAKER_LABEL, isChatWho, type ChatWho } from '../domain/speaker'
import { SEP, composeStatus } from '../scenes/compose'
import type { MilestoneMark, Scene, SceneProgress, SpritePose } from '../scenes/types'
import type { RepoMode } from '../pair/types'
import { destinationRepositoryFrom } from '../intake/x'
import { BUDGETS, fitsSingleLine, fitsWrappedLines } from '../scenes/validate'
import { sanitizeSpoken } from '../voice/intent'
import { pxTruncate } from '@evenrealities/pretext'
import type { WorkerPref } from '../state/prefs'
import type { MissionSessionSettings } from '../domain/types'
import { COPY, buildTitle, buildName } from './copy'
import { decodeDeliveryAttempt, type DeliveryAttempt, type WatchReceiptState } from './receipt-state'
import {
  cancelCursorRun,
  createCursorAgent,
  createCursorRun,
  cursorAgents,
  getCursorRun,
  type CursorAgentCard,
  type CursorRunState,
} from './cursor'
import type { EngineView } from './view'
import type { FactoryEngine } from './engine'
import {
  factoryComputers,
  factoryCreateSession,
  factoryGetMessages,
  factoryHistoryComplete,
  factoryGetSession,
  factoryInterrupt,
  factoryPostMessage,
  factorySessions,
  type FactoryMessage,
  type FactorySessionCard,
  type SessionSettings,
} from './fapi'
import { githubCreateRepo, githubFindRepo, githubUser, githubRepositoryBase, githubBranchEvidence, githubPullEvidence,
  selectGitHub, type GitHubAuth, type GitHubHostAccess } from './github'
import { PLAN_AGAIN_LINE, chatReply, hudReply, ownerWords, readableReply, readableQuestionnaire } from './response'
import { chatBuildScope, isBuildDirective, isScopeReviewDirective, isBuildApproval, isBuildCancellation, isGeneratedConversationControl, validApprovedPlan, validBuildDraft, type ChatBuildDraft } from './build-intent'
import { mintId } from '../domain/ids'

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

interface NativeQuestionReference {
  toolId: string
  sessionId: string
}

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
  /** Identifies the current Factory worker turn, not a streamed message revision. */
  requestToken?: string
  count: number
  lastCount: number
  awaiting: 'build' | 'fix' | null
  branch: string
  state: 'building' | 'queued' | 'review' | 'repair' | 'accepted' | 'stopped'
  weight: number
  nextPoll: number
  polling: boolean
  /**
   * The worker prompt a network blip interrupted: the tick re-sends it. A
   * session worker that never hears its prompt is a job that can never
   * deliver, so the prompt is durable pending state, not a dropped request.
   */
  pendingPrompt: string | null
  /** An unresolved question from this worker, not from the lead session. */
  question?: { text: string; options: string[]; native?: NativeQuestionReference; messageId?: string } | null
  executionObserved?: boolean
  headSha?: string
  baseSha?: string
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
  /**
   * The computer the mission's sessions run on, resolved when planning
   * started. Session reads and writes name it (the API finds a
   * computer-hosted session only there), so a restored mission keeps calling
   * without re-resolving. Null on old snapshots; the saved pick stands in.
   */
  missionComputerId: string | null
  baseRef?: string
  baseSha?: string | null
  baseSelection?: 'explicit' | 'default'
  baseRepositoryId?: number | null
  quarantined?: boolean
  /** Revocation of an earlier source approval, not a transient fault. */
  requiresFreshApproval?: boolean
  /** Exact first-turn retry proof. Null bytes mean a migrated opaque POST. */
  initialPlanTurn?: { sessionId: string; text: string | null; state: 'unsent' | 'unknown' | 'accepted' } | null
  retainedDraft?: { sessionId: string; text: string } | null
  localEchoes?: DeliveryAttempt[]
  plainQuestionMessageId?: string | null
  /** A start waiting on a missing piece; null while nothing waits. */
  blockedStart: BlockedStart | null
  sessionId: string | null
  awaiting: 'plan' | 'verdict' | 'summary' | 'steer' | null
  buildDraft?: ChatBuildDraft | null
  approvedPlan?: string[]
  ownerClarifications?: string[]
  /** Includes in-flight requests: restored attempts are uncertain, never unsent. */
  deliveryAttempts?: DeliveryAttempt[]
  deliveryProtocol?: 'receipt-v1'
  /** Provider observation for presentation, never restored as live evidence. */
  activityStatus?: 'running' | 'pending' | 'idle' | 'unknown'
  workerPref: WorkerPref
  jobCount: number
  askBeforePr: boolean
  /**
   * A worker stopped without delivering; shown until the user acts. Optional
   * because older snapshots never carried it: a restore without it must not
   * lose the stopped card the owner still has to answer.
   */
  workerIssue?: string | null
  /**
   * Genuinely unsent coordinator turns. Pre-receipt-protocol snapshots may
   * contain ambiguous attempted sends; those require individual resolution.
   */
  pendingLeadPosts?: Array<{ text: string; awaiting: RealSnapshot['awaiting']; soft: boolean; protectDelivery?: boolean; legacyDeliveryUnknown?: boolean }>
  /** A confirmed gate step waiting for busy to clear (a restart runs it). */
  queuedStart?: 'build' | 'pr' | 'integration' | null
  /**
   * The branches the integration step is merging, captured when it started
   * (it consumes job 0's branch, so a retry cannot recompute the list from
   * the jobs). Optional because older snapshots never carried it.
   */
  integrationBranches?: string[]
  /**
   * The owner paused this mission (an interrupt request went out). Optional
   * because older snapshots never carried it; without it a restore un-pauses
   * and the interrupted lead would never be told to continue — a silent
   * stall the owner has no card for.
   */
  paused?: boolean
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
  /**
   * The session's chat tail, newest last: the goal, the lead's questions and
   * replies, and the owner's answers. Restored with the mission so history
   * survives a restart (the full text lives here; cards clamp it). Every
   * line carries the seq it was born with — its stable per-mission identity,
   * never its position in the tail, which the cap would rebind.
   */
  chat: Array<{ who: ChatWho; text: string; at: number; seq: number }>
  /**
   * The next chat line's seq (chat's own counter, persisted beside the tail:
   * the tail slides, so its highest seq alone cannot be trusted to stay
   * ahead of the rows the archive already holds). Absent on pre-seq
   * snapshots, whose lines take fresh seqs on restore.
   */
  chatSeq?: number
  reviewQueue: number[]
  verdictJob: number | null
  verdictToken?: string | null
  integrating: boolean
  decisionPending: boolean
  decisionText: string
  /** The question's parsed options (empty: plain decision card). */
  decisionOptions: string[]
  decisionGate: boolean
  decisionKind: 'build' | 'pr'
  /** Null/absent is the lead or a local gate; otherwise the worker index. */
  decisionJob?: number | null
  /** Older snapshots consumed worker questions without presenting them. */
  workerQuestionsRouted?: boolean
  /** Older builds consumed newest-first replies before their request boundary. */
  workerChronologyFixed?: boolean
  queuedLeadQuestion?: { text: string; options: string[]; awaiting: RealSnapshot['awaiting']; verdictToken: string | null; native?: NativeQuestionReference; messageId?: string } | null
  nativeQuestion?: NativeQuestionReference | null
  chatSeenIds?: string[]
  leadQuestionRequest?: string | null
  planLabels: string[]
  /** Missing on old snapshots: ready plans remain ready; awaited plans
   * require an explicit marker without silently re-sending their request. */
  planProtocol?: 'marker-v1' | 'legacy'
  /** A lost POST acknowledgment is not permission to resend the same turn. */
  pendingLeadDelivery?: { sessionId: string; text: string; beforeMessageIds: string[] | null } | null
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
  createSession(opts: { computerId?: string; sessionSettings?: SessionSettings }): Promise<{ sessionId: string }>
  /**
   * A Factory-mode WORKER session (a job building on the user's own
   * computer). Optional: when absent the worker uses createSession — but the
   * durable runtime wraps this method separately, because worker spawns are
   * capacity-gated while the lead conversation is not (spec §14).
   */
  createWorkerSession?(opts: { computerId?: string; sessionSettings?: SessionSettings }): Promise<{ sessionId: string }>
  /**
   * Session reads and writes name the computer a session runs on: Factory
   * only finds a computer-hosted session there (404 otherwise).
   */
  getSession(sessionId: string, computerId?: string): Promise<{ messageCount: number; status?: string }>
  getMessages(sessionId: string, computerId?: string): Promise<FactoryMessage[]>
  postMessage(sessionId: string, text: string, computerId?: string): Promise<void>
  /**
   * Execution on an existing Factory worker, distinct from owner follow-ups
   * and result-only refreshes. The runtime gates this seam just like a Cursor
   * run; legacy clients may fall back to postMessage.
   */
  postWorkerExecution?(sessionId: string, text: string, stage: RealJob['stage'], computerId?: string): Promise<void>
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
  /**
   * Does the account already have a repository with this exact name?
   * Optional: used ONLY to reconcile a repository create whose outcome was
   * never observed (a timeout, or the process dying mid-create), so a retry
   * adopts the repository instead of leaving the mission permanently blocked
   * or creating a near-duplicate. Absent, an unknown create stays blocked.
   * A lookup that cannot complete must THROW, never answer "not found".
   */
  findRepo?(name: string, account?: string, isPrivate?: boolean): Promise<{ url: string } | null>
  repoAccount?(): Promise<string>
  /**
   * The paired host's GitHub sign-in (HOST-GITHUB-PLAN), as the start gates
   * see it: the cached answer (null while unknown) and a probe. Absent, only
   * the phone's GitHub token counts.
   */
  githubHost?: { known(): boolean | null; check(): Promise<boolean> }
  repositoryBase?(repository: string, selectedRef?: string): Promise<{ ref: string; sha: string; repositoryId: number }>
  branchEvidence?(repository: string, branch: string, baseRef: string): Promise<{ headSha: string; baseSha: string }>
  pullEvidence?(repository: string, number: number, branch: string, baseRef: string, headSha: string, baseSha?: string): Promise<void>
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
  list(): Array<{
    goal: string
    status: string
    updatedAt?: number
    sessionId?: string | null
    id?: string
    /**
     * Remote ids this mission already owns (its lead session plus every worker
     * session, Cursor agent, and run). The home list dedups these so one of our
     * own workers is never shown as a foreign, adoptable build (spec §4).
     */
    ownedRemoteIds?: string[]
  }>
  snapshotFor(goal: string): RealSnapshot | null
  /**
   * Open a local row elsewhere (the durable runtime focuses its own mission
   * actor). True means handled: this engine must not restore anything, or
   * two orchestrators would drive the same provider work.
   */
  open?(row: { id?: string; goal: string }): boolean
}

/**
 * The network clients, reading keys at call time so a phone save applies to
 * the next request. Shared by every mission actor under the durable runtime.
 */
export function liveClients(keys: () => {
  factoryKey: string
  cursorKey: string
  githubToken: string
  /** The paired host's GitHub; absent or null, the token alone (unchanged). */
  githubHost?: GitHubHostAccess | null
}): RealClients {
  // Selection per call: the host when it provides GitHub, else the token.
  // With neither, the empty token runs and fails as it always did.
  const github = async (): Promise<GitHubAuth> => {
    const k = keys()
    if (!k.githubHost) return k.githubToken
    return (await selectGitHub(k.githubHost, k.githubToken))?.auth ?? k.githubToken
  }
  return {
    githubHost: {
      known: () => { const host = keys().githubHost; return host ? host.known() : false },
      check: async () => (await keys().githubHost?.check().catch(() => false)) ?? false,
    },
    createSession: (o) => factoryCreateSession(keys().factoryKey, o),
    getSession: (id, computerId) => factoryGetSession(keys().factoryKey, id, computerId),
    getMessages: (id, computerId) => factoryGetMessages(keys().factoryKey, id, computerId),
    postMessage: async (id, text, computerId) => {
      await factoryPostMessage(keys().factoryKey, id, text, computerId)
    },
    interrupt: async (id) => {
      await factoryInterrupt(keys().factoryKey, id)
    },
    computers: () => factoryComputers(keys().factoryKey),
    listFactorySessions: () => factorySessions(keys().factoryKey),
    listCursorAgents: () => cursorAgents(keys().cursorKey),
    createRepo: async (name, isPrivate) => githubCreateRepo(await github(), name, isPrivate),
    findRepo: async (name, account, isPrivate) => githubFindRepo(await github(), name, account, isPrivate),
    repoAccount: async () => (await githubUser(await github())).login,
    repositoryBase: async (repository, selectedRef) => githubRepositoryBase(await github(), repository, selectedRef),
    branchEvidence: async (repository, branch, baseRef) => githubBranchEvidence(await github(), repository, branch, baseRef),
    pullEvidence: async (repository, number, branch, baseRef, headSha, baseSha) => githubPullEvidence(await github(), repository, number, branch, baseRef, headSha, baseSha),
    cursorAgent: (promptText, repoUrl) => createCursorAgent(keys().cursorKey, { promptText, repoUrl }),
    cursorRun: (agentId, promptText) => createCursorRun(keys().cursorKey, agentId, { promptText }),
    cursorGet: (agentId, runId) => getCursorRun(keys().cursorKey, agentId, runId),
    cursorCancel: async (agentId, runId) => {
      await cancelCursorRun(keys().cursorKey, agentId, runId)
    },
  }
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
  /** The projects source's own id for a local row. */
  projectId?: string
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
  /** Consecutive failed status checks; at ATTACH_UNKNOWN_AFTER the card says so. */
  misses: number
  /** Cursor: next agent-list check for a newer run than the one watched. */
  nextRunCheck: number
  /** Last time the build's status or reply changed (epoch ms; 0 = unknown). */
  changedAt: number
  /** Read freshness is separate from the time the content last changed. */
  checkedAt: number | null
}

interface TransientState {
  scene: Scene
  until: number
}

const MS = (s: number) => s * 1000
const SESSION_POLL_MS = 3000
const STATUS_FRESH_MS = SESSION_POLL_MS * 3
const RUN_POLL_MS = 5000
/** Home-list cloud refresh cadence (the list stays fresh while it shows). */
const CLOUD_REFRESH_MS = 10000
/** Failed status checks in a row before a watch card stops showing the last status. */
const ATTACH_UNKNOWN_AFTER = 2
/** Statuses where a build is doing work right now (no age shown on its row). */
const ACTIVE_STATUSES = new Set(['running', 'pending', 'ACTIVE', 'RUNNING'])
/** Cursor run states that end the run; a newer run may follow on the agent. */
const TERMINAL_RUN = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED'])

/** "45s", "12m", "3h", "2d": a compact age for HUD lines. */
function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
/** Home rows capped before the New-build entry (HUD scroll stays sane). */
const MAX_HOME_ROWS = 9
/** Home list item width (matches the copy measurer's list-item budget). */
const LIST_ITEM_W = 500

/**
 * A job's display name. A job that covers several plan lines keeps them
 * all (one per line) for the worker's prompt; every row that names it
 * (Milestones, the phone's timeline) reads them as one line.
 */
export function jobTitle(label: string): string {
  return String(label ?? '').split('\n').map((l) => l.trim()).filter(Boolean).join(', ')
}
/** Widest build title the HUD context line gives the left half (the detail takes the right). */
const HUD_TITLE_W = 260

/** Longest form of `text` that fits the utterance budget's line count. */
function fitUtterance(text: string, maxLines: number = BUDGETS.utterance.lines): string {
  const clean = sanitizeSpoken(text.replace(/\s+/g, ' ').trim())
  if (fitsWrappedLines(clean, BUDGETS.utterance.width, maxLines)) return clean
  const words = clean.split(' ')
  while (words.length > 1) {
    words.pop()
    const shortened = `${words.join(' ')}...`
    if (fitsWrappedLines(shortened, BUDGETS.utterance.width, maxLines)) return shortened
  }
  // One unbreakable token (a URL, a branch name) over the whole budget: cut
  // it by pixels and re-check the wrap — a raw token here would fail scene
  // validation and the card it belongs to (G39) would be silently swallowed.
  let budget = BUDGETS.utterance.width * maxLines
  let out = pxTruncate(clean, budget)
  while (!fitsWrappedLines(out, BUDGETS.utterance.width, maxLines) && budget > 64) {
    budget = Math.floor(budget * 0.75)
    out = pxTruncate(clean, budget)
  }
  return out
}

/** One option row: sanitized, trailing punctuation off, fitted to one line. */
function fitItem(text: string): string {
  const clean = sanitizeSpoken(String(text ?? '').replace(/\s+/g, ' ').trim()).replace(/[.?!:,;]+$/, '')
  if (fitsWrappedLines(clean, LIST_ITEM_W, 1)) return clean
  const words = clean.split(' ')
  while (words.length > 1) {
    words.pop()
    const shortened = `${words.join(' ')}...`
    if (fitsWrappedLines(shortened, LIST_ITEM_W, 1)) return shortened
  }
  return clean // an overlong single word: the list row clips it
}

/** Split an "OPTIONS:" payload into one-line option labels. */
function splitOptions(raw: string): string[] {
  return raw
    .split(/[|;]+/)
    // Strip bullets and numbered prefixes without eating digits that belong
    // to an option ("30 seconds", "2.5 GB").
    .map((o) => o.replace(/^\s*(?:\d+[.)]\s+|[-–—•*]\s+)/, '').trim())
    .filter((o) => o.length > 0)
    .filter((o) => o.length > 0)
    .filter((o, i, all) => all.indexOf(o) === i) // duplicates waste rows
    .slice(0, 4)
}

/**
 * The question and its options, parsed from a lead reply. The protocol line
 * is "OPTIONS: one | two | three" after the question; without it, a short
 * "this or that?" question still yields its two alternatives (agents ask
 * that way even unprompted). Anything else is a plain question: the card
 * with Confirm and Talk, no list.
 */
function parseQuestion(flat: string): { text: string; options: string[] } {
  const bare = flat.replace(/^DECISION:\s*/i, '').trim()
  const opt = /(?:^|\s)OPTIONS?:\s*/i.exec(flat)
  if (opt) {
    const text = flat.slice(0, opt.index).replace(/^DECISION:\s*/i, '').replace(/\s*OPTIONS?:\s*$/i, '').trim()
    const options = splitOptions(flat.slice(opt.index + opt[0].length))
    if (options.length >= 2) return { text: text || bare, options }
    // An OPTIONS: marker with fewer than two usable options is not a list:
    // keep the whole reply as the question.
    return { text: bare, options: [] }
  }
  const either = /^(.{1,90}?)\s*([\w][\w' -]{1,28}) or ([\w][\w' -]{1,28})[?.!]*$/.exec(bare)
  if (either && /\?\s*$/.test(bare)) {
    const options = splitOptions(`${either[2]} | ${either[3]}`)
    if (options.length === 2) return { text: bare, options }
  }
  return { text: bare, options: [] }
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

/** A refusal word at a gate: "no", "nope", "not yet", "later", ... */
const GATE_DECLINE_RE = /^(n|no|nope|stop|cancel|wait|not yet|later|hold off)\b/i

/**
 * True when `text` refuses a pending gate. Exported so the durable runtime
 * can recognize the same refusal the engine's say box does (the owner's
 * report: a declined gate must end the mission honestly everywhere, never
 * leave a plan that can never start).
 */
export function isGateDecline(text: string): boolean {
  return GATE_DECLINE_RE.test(text.replace(/\s+/g, ' ').trim())
}

/** One latest text per message, persisted in the existing seen-ID arrays.
 * Legacy bare IDs prime a baseline once, rather than replaying old replies.
 * Empty messages are never consumed: their text may arrive at the same count.
 */
function freshMessage(seen: Set<string>, m: FactoryMessage): boolean {
  if (m.role !== 'assistant' || !m.text.trim()) return false
  const prefix = `text:${JSON.stringify(m.id)}:`
  const key = prefix + JSON.stringify(m.text)
  if (seen.has(key)) return false
  const legacy = seen.delete(m.id)
  for (const old of seen) if (old.startsWith(prefix)) seen.delete(old)
  seen.add(key)
  return !legacy
}

/** Retained protocol scaffolding is not an owner answer to a question. */
function ownerProviderTurn(message: FactoryMessage): boolean {
  if (message.role !== 'user' || !message.text.trim() || isGeneratedConversationControl(message.text)) return false
  return !/^(?:You are the orchestrator of a software factory run by Spriite for one developer\.\n|You are the execution worker\. Implement the authorized outcome, not another proposal\.\n|The worker pushed branch "[^\n]+"\s+on |The pull request is open: https:\/\/|The review failed\. Findings:\n|The review passed\.\nOpen a pull request |Mission goal:[\s\S]*?\nAll jobs passed review\. Merge these branches |Report the result of your existing (?:build|fix|integration|pr) task\. Do not repeat work,)/.test(message.text)
}

export class RealOrchestrator implements FactoryEngine {
  private phase: RealPhase = 'meet'
  private transient: TransientState | null = null
  private paused = false
  private goal = ''
  private capturedSec = 0
  private sessionId: string | null = null
  private awaiting: RealSnapshot['awaiting'] = null
  private activity = new Map<string, { status: string; checkedAt: number }>()
  private jobs: RealJob[] = []
  private reviewQueue: number[] = []
  private verdictJob: number | null = null
  private verdictToken: string | null = null
  private integrating = false
  private decisionPending = false
  /** The session's chat log (goal, questions, answers, replies), newest last. */
  private chatLogEntries: Array<{ who: ChatWho; text: string; at: number; seq: number }> = []
  /**
   * The seq the next chat line takes. Assigned once at chat() time and never
   * rebased: the archive keys a chat row on (mission_id, seq), so a reused
   * seq would rewrite history on the relay. It rides the snapshot past the
   * tail's own slide, and reset never rewinds it — a new mission is a new
   * archive namespace, and an old seq must never name a new line.
   */
  private chatSeqCount = 0
  /** The question already logged to the chat (one entry per ask). */
  private chatAsked: string = ''
  /** The goal already logged to the chat (one entry per goal). */
  private chatGoal: string = ''
  private chatSeenIds = new Set<string>()
  private pendingLeadDelivery: NonNullable<RealSnapshot['pendingLeadDelivery']> | null = null
  private deliveryAttempts = new Map<string, DeliveryAttempt>()
  private scopeRevision = 0
  private ownerClarifications: string[] = []
  private observedLeadMessages: { sessionId: string; ids: string[]; scope: ReturnType<typeof chatBuildScope> } | null = null
  /** Navigation cache, never a source of provider activity or execution. */
  private watchChats = new Map<string, {
    entries: Array<{ who: ChatWho; text: string; at: number; seq: number }>
    seen: string[]
    delivery: RealSnapshot['pendingLeadDelivery']
  }>()
  private decisionText = ''
  /** The pending question's options (empty: the plain decision card). */
  private decisionOptions: string[] = []
  private decisionGate = false
  private decisionKind: RealSnapshot['decisionKind'] = 'build'
  private decisionJob: number | null = null
  private nativeQuestion: NativeQuestionReference | null = null
  private queuedLeadQuestion: RealSnapshot['queuedLeadQuestion'] = null
  private leadQuestionRequest: string | null = null
  private plainQuestionMessageId: string | null = null
  private localEchoes: DeliveryAttempt[] = []
  private planLabels: string[] = []
  private planProtocol: 'marker-v1' | 'legacy' = 'marker-v1'
  private milestones = initialMilestones()
  private prUrl = ''
  private lastReply = ''
  private failReason = ''
  private finalSummary = ''
  private repairCount = 0
  private seenMessageIds = new Set<string>()
  private messageCount = 0
  private overlay: 'plan_detail' | 'explain' | 'evidence' | 'watch_pause' | 'delivery' | 'chat_build' | 'builds' | null = null
  private buildDraft: ChatBuildDraft | null = null
  private approvedPlan: string[] = []
  private approvedGoal = ''
  private preparingBuild = false
  private managedWatchHandoff = false
  /** The repository name being created for this mission (null when none is pending). */
  private creatingRepo: string | null = null
  /** A create whose answer never arrived (it may exist): adopted on retry. */
  private uncertainRepoCreate: string | null = null
  /** A worker stopped without delivering; shown until the user acts. */
  private workerIssue: string | null = null
  /**
   * Lead posts a network blip interrupted (plan, verdict, summary, an
   * answer, a resume): the tick re-sends them. A post that never lands
   * parks its step forever — the awaited reply can never arrive.
   */
  private pendingLeadPosts: NonNullable<RealSnapshot['pendingLeadPosts']> = []
  /** True while this tick's lead-post retries are still in flight. */
  private leadPostInFlight = false
  private leadDispatchOwner: object | null = null
  /**
   * A confirmed gate step (start the build, open the PR) that arrived while
   * another async step held `busy`: the decision was consumed, so the step
   * must run the moment busy clears — the tick pumps it. Without it the
   * cleared gate parks the mission on the plan card with nothing pending.
   */
  private queuedStart: 'build' | 'pr' | 'integration' | null = null
  /**
   * The branches the integration step must merge, captured before the step
   * consumes job 0's branch. A retry (the fault card, a restart) must merge
   * the SAME list: recomputing it from the jobs would silently drop the
   * branch the first attempt already cleared.
   */
  private integrationBranches: string[] = []
  /**
   * Bumped by reset() and restore(). An async continuation that started
   * under an older generation belongs to a mission this engine no longer
   * holds: a poll resolving after a restart, a session create landing after
   * a reset. Such a continuation must not write its result onto the fresh
   * engine — the stale reply would open a decision card on the home, arm
   * `awaiting` on a mission that never asked, or fault a dead session onto a
   * live card. Every awaited step captures the generation before its first
   * await and abandons itself when it moved.
   */
  private generation = 0
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
  /** Engine time of the last complete cloud list (0: never). */
  private cloudFetchedAt = 0
  /** The latest cloud list refresh failed: rows are as of cloudFetchedAt. */
  private cloudFailing = false
  /** Phase at the previous tick: entering the home refreshes it at once. */
  private tickPhase: RealPhase | null = null
  /** A cloud build picked from the home list, watched live. */
  private attach: AttachWatch | null = null
  /** Engine clock: kept in sync with tick(now); transients expire on it. */
  private nowMs = 0
  /** Lead-post retry backoff: when the next pass may run, and how many passes failed. */
  private leadRetryAt = 0
  private leadRetryFails = 0
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
  /** The owner's repository mode: 'per_idea' starts each plain goal in a new private repo. */
  private repoMode: RepoMode = 'one'
  /**
   * The Factory session settings this build runs with. Under the durable
   * runtime these come from the frozen MissionConfig, so a preference save
   * never moves a running build; the legacy engine passes the live
   * preferences, which then apply to the session it creates at start.
   * Absent keys mean "Factory's account default".
   */
  private settings: MissionSessionSettings = {}
  /**
   * The mission these sessions belong to, tagged onto worker sessions so the
   * owner can find them in Factory's own app. Empty for a cloud build the
   * phone merely attached to.
   */
  private missionId = ''
  private readonly clients: RealClients
  private readonly projectsSource: ProjectsSource | null
  /** Runtime storage barrier; failure means transport must not be invoked. */
  private readonly beforeSessionDispatch?: () => Promise<void>
  private readonly receiptState?: () => WatchReceiptState
  private readonly onReceiptMutation?: (sessionId: string, attempt: DeliveryAttempt | null) => void
  /**
   * The computer the mission's sessions run on, validated against the live
   * list at mission start (a saved id can go stale; an empty one means the
   * account had no computer when the key was saved). Factory requires a
   * computerId on every session create, and finds a computer-hosted session
   * only on that computer, so every session read and write names it too.
   */
  private resolvedComputerId: string | null = null
  /** The repository this mission builds on, frozen when planning starts. */
  private missionRepo = ''
  private baseRef = ''
  private baseSha: string | null = null
  private baseSelection: 'explicit' | 'default' = 'default'
  private baseRepositoryId: number | null = null
  private quarantined = false
  private requiresFreshApproval = false
  private initialPlanTurn: RealSnapshot['initialPlanTurn'] = null
  private readonly configuredBaseRef: string
  private retainedDraft: RealSnapshot['retainedDraft'] = null
  private historyObservations = new Map<string, string>()

  constructor(
    emitView: (view: EngineView) => void,
    deps: {
      factoryKey?: string
      cursorKey?: string
      githubToken?: string
      /** The paired host's GitHub, for the clients this engine builds itself. */
      githubHost?: GitHubHostAccess | null
      repoUrl?: string
      computerId?: string
      workerPref?: WorkerPref
      jobs?: number
      askBeforePr?: boolean
      settings?: MissionSessionSettings
      repoMode?: RepoMode
      missionId?: string
      approvedPlan?: string[]
      approvedGoal?: string
      baseRef?: string
      clients?: RealClients
      projects?: ProjectsSource
      beforeSessionDispatch?: () => Promise<void>
      receiptState?: () => WatchReceiptState
      onReceiptMutation?: (sessionId: string, attempt: DeliveryAttempt | null) => void
    },
  ) {
    this.emitView = emitView
    this.factoryKey = deps.factoryKey ?? ''
    this.cursorKey = deps.cursorKey ?? ''
    this.githubToken = deps.githubToken ?? ''
    this.repoUrl = deps.repoUrl ?? ''
    this.projectsSource = deps.projects ?? null
    this.beforeSessionDispatch = deps.beforeSessionDispatch
    this.receiptState = deps.receiptState
    this.onReceiptMutation = deps.onReceiptMutation
    this.computerId = deps.computerId ?? ''
    this.workerPref = deps.workerPref ?? 'auto'
    this.jobCount = deps.jobs ?? 1
    this.askBeforePr = deps.askBeforePr === true
    this.repoMode = deps.repoMode === 'per_idea' ? 'per_idea' : 'one'
    this.settings = deps.settings ?? {}
    this.missionId = deps.missionId ?? ''
    this.approvedPlan = validApprovedPlan(deps.approvedPlan) ? [...deps.approvedPlan] : []
    this.approvedGoal = deps.approvedGoal ?? ''
    this.baseRef = deps.baseRef?.trim() || ''
    this.configuredBaseRef = this.baseRef
    this.baseSelection = this.baseRef ? 'explicit' : 'default'
    this.clients =
      deps.clients ??
      liveClients(() => ({ factoryKey: this.factoryKey, cursorKey: this.cursorKey, githubToken: this.githubToken, githubHost: deps.githubHost ?? null }))
    this.syncReceiptState()
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
   * The settings the LEAD session is created with: the model, reasoning
   * effort and autonomy the orchestrator runs at, plus the interaction mode
   * and (only in spec mode) its spec-mode model and effort. The lead carries
   * no owner worker instructions or worker tool policy. A pre-approved
   * handoff has no initial planning prompt, so its coordinator role must be
   * appended at creation instead, without replacing the harness or its reply
   * formats.
   */
  private leadSettings(): SessionSettings {
    const s: SessionSettings = {}
    const f = this.settings
    if (f.leadModel) s.model = f.leadModel
    if (f.leadReasoningEffort) s.reasoningEffort = f.leadReasoningEffort
    if (f.leadAutonomyLevel) s.autonomyLevel = f.leadAutonomyLevel
    if (f.interactionMode) {
      s.interactionMode = f.interactionMode
      // Spec-mode settings travel only with spec mode: sent in another mode
      // they would claim a choice the owner did not make.
      if (f.interactionMode === 'spec') {
        if (f.specModeModel) s.specModeModel = f.specModeModel
        if (f.specModeReasoningEffort) s.specModeReasoningEffort = f.specModeReasoningEffort
      }
    }
    if (this.approvedGoal === this.goal && this.approvedPlan.length) {
      s.systemPrompt = { type: 'preset', preset: 'droid',
        append: "You are Spriite's coordinator and reviewer, not its execution worker. Do not edit code or launch agents. The owner-approved scope is executed by a separate worker. Review and summarize when requested, following each message's exact reply format; do not generate another plan." }
    }
    return s
  }

  /**
   * The settings a Factory-mode WORKER session is created with: its own
   * model and effort, the extra instructions the owner wrote (APPENDED to
   * Droid's own prompt), the tool policy, and a tag naming the mission so the
   * owner can find the session in Factory's app.
   */
  private workerSettings(): SessionSettings {
    // The owner approved implementation, not another specification session.
    // Preserve their chosen autonomy, rather than inheriting unrelated
    // account defaults or silently increasing permission.
    const s: SessionSettings = { interactionMode: 'auto' }
    const f = this.settings
    if (f.leadAutonomyLevel) s.autonomyLevel = f.leadAutonomyLevel
    if (f.workerModel) s.model = f.workerModel
    if (f.workerReasoningEffort) s.reasoningEffort = f.workerReasoningEffort
    if (f.workerInstructions) {
      s.systemPrompt = { type: 'preset', preset: 'droid', append: f.workerInstructions }
    }
    if (f.workerEnabledToolIds?.length) s.enabledToolIds = [...f.workerEnabledToolIds]
    if (f.workerDisabledToolIds?.length) s.disabledToolIds = [...f.workerDisabledToolIds]
    if (f.workerRestrictToolIds?.length) s.restrictToolIds = [...f.workerRestrictToolIds]
    s.tags = [{ name: 'spriite', ...(this.missionId ? { metadata: { missionId: this.missionId } } : {}) }]
    return s
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
    settings?: MissionSessionSettings
    repoMode?: RepoMode
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
    if (this.computerId !== oldComputerId && !this.sessionId && !this.jobs.length) {
      this.resolvedComputerId = null // revalidate against the new setup
    }
    this.workerPref = o.workerPref ?? this.workerPref
    this.jobCount = o.jobs ?? this.jobCount
    this.askBeforePr = o.askBeforePr ?? this.askBeforePr
    if (o.repoMode !== undefined) this.repoMode = o.repoMode === 'per_idea' ? 'per_idea' : 'one'
    // A save applies to the next build this engine starts. A live session is
    // never PATCHed: the API's update schema carries neither the extra
    // instructions nor the tool policy, and Factory never reports settings
    // back, so a live change could be neither honored nor confirmed — and a
    // build the owner already approved would quietly change underneath it.
    this.settings = o.settings ?? this.settings
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
      if (this.blockedStart === 'github' && this.githubReady()) {
        void this.startNewRepo()
        return
      }
      if (this.blockedStart === 'github' && this.clients.githubHost?.known() === null) {
        // The paired host may provide GitHub: its answer resumes the start.
        const gen = this.generation
        void this.clients.githubHost.check().catch(() => false).then((ok) => {
          if (ok && !this.genStale(gen) && this.blockedStart === 'github' && this.phase === 'transcript') this.startNewRepo()
        })
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
    if (this.blockedStart === 'github' && !this.githubReady()) return 'github'
    if (!(this.missionRepo || this.repoUrl)) return 'repo'
    // A computer needs a live list to check; only the prompt's Retry does.
    return this.blockedStart === 'computer' ? 'computer' : null
  }

  /**
   * GitHub is there for a new repository: the phone's token, or the paired
   * host's sign-in as last known (HOST-GITHUB-PLAN selection 1 and 2).
   */
  private githubReady(): boolean {
    return Boolean(this.githubToken) || this.clients.githubHost?.known() === true
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
    // A plan is a proposal, never evidence of implemented or reviewed work.
    // Normalize the work/PR weights, including pre-fix saved snapshots.
    const work = this.displayWork()
    const total = work.reduce((n, m) => n + m.weight, 0) || 100
    const accepted = work
      .filter((m) => m.status === 'accepted')
      .reduce((n, m) => n + m.weight, 0)
    const pending = work
      .filter((m) => m.status === 'submitted')
      .reduce((n, m) => n + m.weight, 0)
    const acceptedWeight = Math.round(accepted * 100 / total)
    return {
      acceptedWeight,
      pendingReviewWeight: Math.min(100 - acceptedWeight, Math.round(pending * 100 / total)),
      totalWeight: 100,
      planRevision: 1,
      ...(work.length > 0 ? { milestones: work.map((m): MilestoneMark => m.status === 'accepted' ? 'done' : m.status === 'submitted' ? 'review' : 'todo') } : {}),
    }
  }

  /**
   * The milestones a card counts, draws and lists: a ready plan's own lines
   * while it waits for Start build, then the jobs and the PR (the plan step
   * itself is a proposal, never counted).
   */
  private displayWork(): RealMilestone[] {
    if (this.phase === 'plan' && this.jobs.length === 0 && this.awaiting !== 'plan' && this.planLabels.length > 0) {
      const n = this.planLabels.length
      return this.planLabels.map((label, i) => ({
        id: `step_${i}`, label, weight: Math.floor(100 / n) + (i < 100 % n ? 1 : 0), status: 'pending' as const,
      }))
    }
    return this.milestones.filter((m) => m.id !== 'plan')
  }

  /** The build's short title for the HUD context line (uppercase as drawn). */
  private hudTitle(width: number = HUD_TITLE_W): string {
    const title = sanitizeSpoken(buildTitle(this.goal))
    const upper = title.toUpperCase()
    return upper && fitsSingleLine(upper, width) ? upper : pxTruncate(upper, width)
  }

  /** Who a question card says is asking (HudAsk 'LEAD ASKS'). */
  private askerLabel(): string {
    if (this.decisionGate || this.decisionKind === 'pr') return COPY.hud.spriiteAsks
    return this.decisionJob !== null ? COPY.hud.workerAsks : COPY.hud.leadAsks
  }

  /** The context line's left half: the asker on a question, else the build's title. */
  private hudContextLabel(kind: Scene['kind']): string {
    if (kind === 'decision') return this.askerLabel()
    return this.missionActive() && this.goal ? this.hudTitle() || COPY.real.context : COPY.real.context
  }

  /**
   * The context line's right half (HudRun 'BUILDING · 2 OF 4', HudDone
   * 'DONE', HudAsk: the build's title). Empty off a mission.
   */
  private hudContextDetail(kind: Scene['kind']): string {
    // The title sits in the detail half here: the validator's half-line budget.
    if (kind === 'decision') return this.missionActive() && this.goal ? this.hudTitle(BUDGETS.contextDetail.width) : ''
    if (!this.missionActive()) return ''
    const words = COPY.hud.phaseWords
    const work = this.displayWork()
    const done = work.filter((m) => m.status === 'accepted').length
    if (this.phase === 'final') return COPY.hud.doneDetail
    const word = this.paused ? words.paused
      : this.phase === 'plan' ? words.planning
      : this.phase === 'review' ? words.review
      : this.phase === 'repair' ? words.repair
      : this.phase === 'pr' ? words.pr
      : words.building
    return work.length > 0 ? COPY.hud.phaseDetail(word, done, work.length) : word
  }

  /** The Run board's subline: checks passed so far and the agents on it (lead + workers). */
  private runStatus(): string {
    const checks = this.milestones.filter((m) => m.id !== 'plan' && m.status === 'accepted').length
    return COPY.hud.runStatus(checks, 1 + Math.max(1, this.jobs.length))
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

  /** A saved phase, an awaited reply, and old tools do not prove current work. */
  private activityStatus(): NonNullable<RealSnapshot['activityStatus']> {
    const working = this.phase === 'review' ? [] : this.jobs.filter((j) => j.state === 'building')
    const ids = working.length > 0
      ? working.map((j) => j.mode === 'cursor' ? j.runId : j.sessionId)
      : [this.sessionId]
    const statuses = ids.map((id) => {
      const observed = id ? this.activity.get(id) : undefined
      if (!observed || this.nowMs - observed.checkedAt >= STATUS_FRESH_MS) return 'unknown'
      if (observed.status === 'pending') return 'pending'
      if (ACTIVE_STATUSES.has(observed.status)) return 'running'
      if (observed.status === 'idle' || observed.status === 'IDLE' || TERMINAL_RUN.has(observed.status)) return 'idle'
      return 'unknown'
    })
    if (statuses.includes('running')) return 'running'
    if (statuses.includes('pending')) return 'pending'
    return statuses.length > 0 && statuses.every((s) => s === 'idle') ? 'idle' : 'unknown'
  }

  private observeActivity(id: string, status: string | undefined): boolean {
    const before = this.activityStatus()
    this.activity.set(id, { status: status ?? 'unknown', checkedAt: this.nowMs })
    const changed = before !== this.activityStatus()
    if (changed) this.clearActivityAnswer()
    return changed
  }

  /** An eight-second Status card must not mask newer provider evidence. */
  private clearActivityAnswer(): void {
    const transient = this.transient
    if (transient?.scene.kind === 'status_answer' &&
      Object.values(COPY.real.activityStatus).some((word) => transient.scene.status.includes(word))) {
      this.transient = null
    }
  }

  private waitingActivity(planning = false, stage: 'plan' | 'review' | 'work' = planning ? 'plan' : 'work'): {
    pose: SpritePose; utterance: string; statusNote: string; actions: Scene['actions']
  } {
    const status = this.activityStatus()
    const canContinue = this.canContinueSession()
    return {
      // MotionLab: the Lead planning is Planning (thinking) unless Factory
      // reports it idle, the reviewer's turn is Checking; work follows the
      // observed activity.
      pose: stage === 'plan' ? (status === 'idle' ? 'idle' : 'planning') : stage === 'review' ? 'checking'
        : status === 'running' || status === 'pending' ? 'building' : status === 'idle' ? 'idle' : 'reconciling',
      utterance: this.canReviewChatBuild() ? COPY.real.scopeAvailable
        : planning && this.planLabels.length > 0 && this.awaiting === 'plan' && status !== 'idle' ? COPY.real.planUpdating
        : status === 'running' ? COPY.real.planRunning
        : status === 'pending' ? COPY.real.sessionQueued
        : status === 'idle' ? (planning ? (canContinue ? COPY.real.planIdle : COPY.real.planIdleMessage) : COPY.real.sessionIdle)
        : planning ? COPY.real.planUnknown : COPY.real.sessionUnknown,
      statusNote: COPY.real.activityStatus[status],
      actions: this.canReviewChatBuild() ? COPY.real.scopeAvailableActions
        : canContinue ? COPY.real.inactiveActions : COPY.real.planDraftingActions,
    }
  }

  private scene(kind: Scene['kind'], o: {
    pose: SpritePose
    utterance: string
    status?: string
    statusNote?: string
    actions?: Scene['actions']
    evidence?: string[]
    transientMs?: number
    speaker?: ChatWho
  }): Scene {
    const progress = this.progress()
    return {
      speaker: o.speaker ?? this.speakerOf(kind),
      schemaVersion: 1,
      sceneId: `${kind}_${this.seq + 1}`,
      sceneRevision: this.seq + 1,
      missionId: this.missionActive() ? 'mission_live' : null,
      stateSequence: this.seq + 1,
      kind,
      spritePose: o.pose,
      contextLabel: this.hudContextLabel(kind),
      contextDetail: this.hudContextDetail(kind),
      utterance: o.utterance,
      status: o.status ?? composeStatus(progress, o.statusNote ?? ''),
      progress,
      actions: o.actions ?? [],
      evidenceIds: o.evidence ?? [],
      generatedAt: new Date().toISOString(),
      transientMs: o.transientMs ?? 0,
    }
  }

  /**
   * Who is behind a card of this kind right now: the watched build's own
   * progress, the worker's build and fix progress, the lead's planning,
   * review, and questions, the owner's goal; Spriite for everything else
   * (its own notes, gates, faults, explanations).
   */
  private speakerOf(kind: Scene['kind']): ChatWho {
    if (this.phase === 'attach') return kind === 'running' ? 'watched' : 'spriite'
    switch (kind) {
      case 'transcript':
        return 'you'
      case 'plan':
      case 'under_review':
        return 'lead'
      case 'repair':
        return this.workerIssue ? 'spriite' : 'worker'
      case 'running':
        return this.phase === 'building' || this.phase === 'pr' || this.phase === 'repair' ? 'worker' : 'spriite'
      case 'decision':
        return this.decisionGate ? 'spriite' : 'lead'
      default:
        return 'spriite'
    }
  }

  /** One HUD list line: "title · tail", fit to one row (the tail always shows). */
  private listRow(title: string, tail: string): string {
    const clean = sanitizeSpoken(String(title ?? '').replace(/\s+/g, ' ').trim())
    const text = `${clean}${SEP}${tail}`
    if (fitsWrappedLines(text, LIST_ITEM_W, 1)) return text
    const words = clean.split(' ')
    while (words.length > 1) {
      words.pop()
      const shortened = `${words.join(' ')}...${SEP}${tail}`
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
    const projects = this.projectsSource?.list() ?? []
    const locals = projects.map((p) => ({
      kind: 'local' as const,
      title: buildName(p.goal), // the build's name, as the HUD titles it
      tail: COPY.real.statusWords[String(p.status ?? '')] ?? 'building',
      status: String(p.status ?? ''),
      goal: p.goal,
      ...(p.id !== undefined ? { projectId: p.id } : {}),
      sessionId: p.sessionId ?? null,
      agentId: null,
      runId: null,
      computerId: null,
      updatedAt: p.updatedAt ?? 0,
    }))
    // Every remote id a local mission owns, so its own worker sessions and
    // Cursor agents never appear as foreign builds the owner could adopt or
    // steer (spec §4: one orchestrator per provider job).
    const tracked = new Set<string>()
    for (const p of projects) {
      if (p.sessionId) tracked.add(p.sessionId)
      for (const id of p.ownedRemoteIds ?? []) tracked.add(id)
    }
    const factories = this.cloudSessions
      .filter((s) => !tracked.has(s.sessionId))
      .map((s) => ({
        kind: 'factory' as const,
        title: s.title || 'Factory build',
        tail: this.cloudTail(COPY.real.factoryTag, s.status, s.updatedAt),
        status: s.status,
        goal: null,
        sessionId: s.sessionId,
        agentId: null,
        runId: null,
        computerId: s.computerId || null,
        updatedAt: s.updatedAt,
      }))
    const cursors = this.cloudAgents
      .filter((a) => !tracked.has(a.agentId) && (a.latestRunId === null || !tracked.has(a.latestRunId)))
      .map((a) => ({
        kind: 'cursor' as const,
        title: a.name || 'Cursor build',
        tail: this.cloudTail(COPY.real.cursorTag, a.status, a.updatedAt),
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

  /**
   * A cloud row's tail: source, status, and, for a build not working right
   * now, how long ago it last changed ("Factory: idle 3h"). Ages only show
   * for real epoch timestamps, in hours or days: a changed row re-sends the
   * glasses list page (resetting its highlight), so row text must not tick
   * every minute.
   */
  private cloudTail(tag: string, status: string, updatedAt: number): string {
    const word = COPY.real.statusWords[status] ?? COPY.real.statusWords.unknown
    const age = this.nowMs - updatedAt
    if (ACTIVE_STATUSES.has(status) || updatedAt < 1e12 || age < 3600_000) return `${tag}: ${word}`
    return `${tag}: ${word} ${ageText(age)}`
  }

  private watchUnknown(watch: AttachWatch): boolean {
    return watch.misses >= ATTACH_UNKNOWN_AFTER || watch.checkedAt === null ||
      this.nowMs - watch.checkedAt >= CLOUD_REFRESH_MS * 2 || watch.runStatus === 'unknown' ||
      !COPY.real.statusWords[watch.runStatus]
  }

  private watchWord(watch: AttachWatch): string {
    if (watch.misses >= ATTACH_UNKNOWN_AFTER) return COPY.real.attachUnknown
    return this.watchUnknown(watch) ? COPY.real.statusWords.unknown : COPY.real.statusWords[watch.runStatus]
  }

  /** The home title; says so when the cloud rows are not current. */
  private projectsTitle(): string {
    if (!this.cloudFailing) return COPY.real.projectsTitle
    if (this.cloudFetchedAt === 0) return COPY.real.projectsCloudDown
    return COPY.real.projectsStale(`${ageText(this.nowMs - this.cloudFetchedAt)} ago`)
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
      title: this.projectsTitle(),
      items: [
        ...rows.map((r) => this.listRow(r.title, r.tail)),
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
    const unknown = this.watchUnknown(watch)
    const word = this.watchWord(watch)
    const only = this.attachSteerable() ? '' : `${SEP}${COPY.real.attachWatchOnly}`
    // The pose follows the build: working, idle or finished, or status unknown.
    const pose = unknown ? 'reconciling' : ACTIVE_STATUSES.has(watch.runStatus) ? 'waiting' : 'idle'
    return {
      type: 'scene',
      scene: this.scene('running', {
        pose,
        // watch.title is provider text (a cloud session title, a mission goal
        // the projects row carried) and may be the only line on the card:
        // fit it like every other provider-derived utterance, or a title
        // with "50%" (or a novel-long name) fails validation and the watch
        // card is swallowed by the G39 fallback while the build watches on.
        utterance: this.canReviewChatBuild() ? COPY.real.scopeAvailable
          : this.lastReply ? fitUtterance(`Last reply: ${this.lastReply}`) : fitUtterance(watch.title),
        statusNote: `${tag}: ${word}${only}`,
        actions: this.canReviewChatBuild() ? COPY.real.scopeAvailableActions
          : this.canContinueSession() ? COPY.real.inactiveActions
          : this.attachSteerable() ? COPY.real.attachActions
          : watch.source === 'factory' ? COPY.real.factoryWatchOnlyActions : COPY.real.attachWatchOnlyActions,
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
            // The goal the owner spoke is short, but an X-origin goal can be
            // the composed request (instruction + captured context, up to
            // 3000 chars, src/context/gather.ts): fitted here like every
            // other provider-derived utterance, or the transcript card
            // fails scene validation and the mission's first card never
            // presents. The full goal stays in the mission record and the
            // chat log; the HUD shows the honest 4-line preview.
            // MotionLab "Talking": repeating back what it heard before acting.
            pose: 'talking', utterance: fitUtterance(this.goal),
            status: COPY.real.transcriptStatus(this.capturedSec),
            actions: COPY.real.transcriptActions,
          }),
        }
      case 'plan':
        if (this.needsPlanRefresh()) {
          if (this.canContinueSession()) return {
            type: 'scene', scene: this.scene('plan', this.waitingActivity(true)),
          }
          return {
            type: 'scene',
            scene: this.scene('plan', {
              pose: 'waiting', utterance: COPY.real.planRefresh,
              statusNote: COPY.real.planRefreshStatus,
              actions: COPY.real.planRefreshActions,
            }),
          }
        }
        // No plan yet, or the owner's answer/steer made the shown plan stale
        // and the Lead's revised plan is still awaited: no Start build.
        if (this.planLabels.length === 0 || this.awaiting === 'plan') {
          return { type: 'scene', scene: this.scene('plan', { ...this.waitingActivity(true), speaker: 'spriite' }) }
        }
        return {
          type: 'scene',
          scene: this.scene('plan', {
            pose: 'planning',
            utterance: this.jobCount > 1 ? COPY.real.planReadySplit(this.jobCount) : COPY.real.planReady,
            statusNote: this.jobCount > 1 ? `${this.planLabels.length} jobs` : `${this.planLabels.length} milestones`,
            actions: COPY.real.planActions,
          }),
        }
      case 'building':
        if (!this.jobs.some((j) => j.pendingPrompt) && this.activityStatus() === 'idle') {
          return { type: 'scene', scene: this.scene('running', { ...this.waitingActivity(), speaker: 'spriite' }) }
        }
        return {
          type: 'scene',
          scene: this.scene('running', {
            // MotionLab "Building": workers are coding (unconfirmed activity checks).
            pose: this.activityStatus() === 'running' ? 'building' : 'reconciling',
            utterance: this.integrating ? COPY.real.integrationStage
              : this.jobs.some((job) => job.pendingPrompt) ? COPY.real.workerQueued
              : this.jobs.some((job) => job.executionObserved) ? COPY.real.workerActivity
              : this.jobs.length > 1 ? COPY.real.buildingSplit(this.jobs.length)
                : COPY.real.building,
            // HudRun's subline once the work is confirmed running; until then
            // the honest activity word stays (sent does not mean working).
            ...(this.activityStatus() === 'running'
              ? { status: this.runStatus() }
              : { statusNote: COPY.real.activityStatus[this.activityStatus()] }),
            actions: COPY.real.runningActions,
          }),
        }
      case 'review':
        if (this.activityStatus() !== 'running') {
          // A review card is a review claim: the validator requires evidence.
          // The session ids are that evidence; with none yet the card is the
          // honest waiting card, not a review claim.
          const evidence = this.evidenceIds()
          return evidence.length > 0
            ? { type: 'scene', scene: this.scene('under_review', { ...this.waitingActivity(false, 'review'), speaker: 'spriite', evidence }) }
            : { type: 'scene', scene: this.scene('running', { ...this.waitingActivity(false, 'review'), speaker: 'spriite' }) }
        }
        return {
          type: 'scene',
          scene: this.scene('under_review', {
            pose: 'checking', utterance: COPY.real.pushedForReview,
            statusNote: COPY.real.reviewStatusNote, actions: COPY.real.beatActions,
            evidence: this.evidenceIds(),
          }),
        }
      case 'repair':
        if (this.activityStatus() !== 'running') {
          return { type: 'scene', scene: this.scene('repair', { ...this.waitingActivity(), speaker: 'spriite' }) }
        }
        return {
          type: 'scene',
          scene: this.scene('repair', {
            pose: 'repair', utterance: COPY.real.verdictFail,
            statusNote: COPY.real.repairStatusNote, actions: COPY.real.beatActions,
            evidence: this.evidenceIds(),
          }),
        }
      case 'pr':
        if (this.activityStatus() !== 'running') {
          return { type: 'scene', scene: this.scene('running', { ...this.waitingActivity(), speaker: 'spriite' }) }
        }
        return {
          type: 'scene',
          scene: this.scene('running', {
            pose: 'delegating', utterance: COPY.real.prStage,
            statusNote: COPY.real.prStatusNote, actions: COPY.real.runningActions,
          }),
        }
      case 'final':
        return {
          type: 'scene',
          // HudDone: the build landed (MotionLab "Celebrating"); the lead's
          // summary stays in the chat, read with Read summary.
          scene: this.scene('final', {
            pose: 'celebrate', utterance: COPY.hud.done(sanitizeSpoken(buildTitle(this.goal))),
            status: COPY.hud.doneStatus,
            actions: COPY.real.finalActions, evidence: this.evidenceIds(),
          }),
        }
    }
  }

  private overlayView(): EngineView {
    switch (this.overlay) {
      case 'builds':
        return this.meetView()
      case 'chat_build':
        return { type: 'scene', scene: this.scene('status_answer', {
          pose: 'asking',
          utterance: fitUtterance(COPY.real.chatBuildReview(this.buildDraft?.repository.replace('https://github.com/', '') ?? 'the selected repository')),
          statusNote: COPY.real.chatBuildReviewStatus,
          actions: COPY.real.chatBuildActions,
        }) }
      case 'plan_detail': {
        // The milestones the card counts and the bar draws ('0 OF 2'), each
        // with its state; a ready plan's lines are planned, not started.
        const work = this.displayWork()
        return {
          type: 'selection', purpose: 'plan_detail',
          contextLabel: this.hudContextLabel('plan'), contextDetail: this.hudContextDetail('plan'),
          title: COPY.real.planDetailTitle(work.length),
          items: work.length > 0
            // One row each: a long name is shortened, its status always shows.
            ? work.map((m) => this.listRow(jobTitle(m.label), m.id.startsWith('step_') ? COPY.real.plannedWord : milestoneStatusWord(m.status)))
            : [COPY.real.noMilestones],
          pose: 'planning',
        }
      }
      case 'evidence':
        return {
          type: 'selection', purpose: 'evidence',
          contextLabel: this.hudContextLabel('final'), contextDetail: this.hudContextDetail('final'),
          title: COPY.real.evidenceTitle, items: this.evidenceItems(), pose: 'accepted',
        }
      case 'explain':
        if (this.phase === 'attach' && this.attach) return this.attachExplainView(this.attach)
        return {
          type: 'scene',
          scene: this.scene('explain', {
            pose: 'checking',
            utterance: this.lastReply || this.failReason || COPY.real.statusAnswers[this.phase] || COPY.real.prReady,
            actions: [{ id: 'back', label: 'Back', kind: 'command' }],
            evidence: this.evidenceIds(),
          }),
        }
      case 'watch_pause':
        return {
          type: 'scene',
          scene: this.scene('status_answer', {
            pose: 'asking', utterance: COPY.real.watchPauseAsk,
            statusNote: COPY.real.watchPauseStatus, actions: COPY.real.watchPauseActions,
          }),
        }
      case 'delivery':
        return { type: 'scene', scene: this.scene('status_answer', {
          pose: 'asking', utterance: COPY.real.deliveryResolve,
          statusNote: COPY.real.messageUnconfirmedStatus, actions: COPY.real.deliveryResolveActions,
        }) }
      default:
        return this.baseView()
    }
  }

  /** Explain on a watched build: source, title, latest reply, status, freshness, control. */
  private attachExplainView(watch: AttachWatch): EngineView {
    const tag = watch.source === 'factory' ? COPY.real.factoryTag : COPY.real.cursorTag
    const steerable = this.attachSteerable()
    const word = this.watchWord(watch)
    const age = watch.changedAt > 0 && this.nowMs >= watch.changedAt ? ageText(this.nowMs - watch.changedAt) : ''
    const title = fitUtterance(sanitizeSpoken(watch.title.replace(/\s+/g, ' ').trim()), 1)
    // Status line candidates, most informative first: the first that fits wins.
    const statusNote = [
      COPY.real.attachExplainStatus(word, age, steerable),
      COPY.real.attachExplainStatus(word, '', steerable),
      word,
    ].find((s) => fitsSingleLine(s, BUDGETS.status.width)) ?? word
    return {
      type: 'scene',
      scene: this.scene('explain', {
        pose: 'checking',
        utterance: fitUtterance(COPY.real.attachExplain(tag, title, this.lastReply)),
        statusNote,
        actions: [{ id: 'back', label: 'Back', kind: 'command' }],
      }),
    }
  }

  private computeView(): EngineView {
    // The goal is logged once, when its transcript card first shows (all goal
    // paths land here); the chat history then keeps it past the card.
    if (this.phase === 'transcript' && this.goal && this.chatGoal !== this.goal) {
      this.chatGoal = this.goal
      this.chat('you', this.goal)
    }
    if (this.faultKind) return this.faultView()
    if (this.decisionPending) {
      this.chatLogQuestion()
      if (this.nativeQuestion) return {
        type: 'scene',
        scene: this.scene('decision', {
          pose: 'asking', utterance: fitUtterance(this.decisionText),
          statusNote: 'Answer in Factory',
          actions: [
            { id: 'chat', label: 'Read', kind: 'read_only' },
            { id: 'open_factory', label: 'Open on phone', kind: 'read_only' },
            { id: 'show_builds', label: 'Builds', kind: 'read_only' },
          ],
          speaker: this.decisionJob !== null ? 'worker' : this.phase === 'attach' ? 'watched' : 'lead',
        }),
      }
      // A question with options renders the way chat does: the question on
      // top, one row per option, and the speak-another-answer row last. The
      // gates (start/PR) keep their own yes card; option-less questions keep
      // Confirm + Talk.
      if (this.decisionOptions.length >= 2 && !this.decisionGate && this.decisionKind !== 'pr') {
        return {
          type: 'selection',
          purpose: 'decision',
          // HudAsk: who asks on the left, the build on the right.
          contextLabel: this.askerLabel(),
          contextDetail: this.missionActive() && this.goal ? this.hudTitle() : '',
          title: this.decisionListTitle(),
          items: [...this.decisionOptions.map((option, index, all) => {
            const label = fitItem(option)
            return all.some((other, i) => i !== index && fitItem(other) === label)
              ? fitItem(`${index + 1}. ${option}`) : label
          }), COPY.real.speakAnswer],
          pose: 'asking',
        }
      }
      return {
        type: 'scene',
        scene: this.scene('decision', {
          pose: 'asking', utterance: fitUtterance(this.decisionText),
          statusNote: this.decisionJob !== null ? 'Worker needs an answer' : '1 choice needed',
          // The gates confirm a start (their own buttons); an open question
          // from the lead gets Confirm (yes) and Talk (any answer).
          actions: this.decisionKind === 'pr'
            ? COPY.real.prGateActions
            : this.decisionGate
              ? COPY.real.gateActions
              : COPY.real.decisionActions,
          evidence: this.evidenceIds(),
          speaker: this.decisionJob !== null ? 'worker' : undefined,
        }),
      }
    }
    if (this.workerIssue) {
      return {
        type: 'scene',
        scene: this.scene('repair', {
          pose: 'repair', utterance: fitUtterance(this.workerIssue),
          statusNote: 'Worker stopped', actions: COPY.real.stoppedActions,
          evidence: this.evidenceIds(),
        }),
      }
    }
    if (this.paused) {
      return {
        type: 'scene',
        scene: this.scene('paused', {
          pose: 'paused',
          // Nothing runs before Start build: the worker line would be untrue.
          utterance: this.jobs.some((j) => j.state === 'building' || j.state === 'repair') ? COPY.real.paused : COPY.real.pausedNoWorker,
          actions: COPY.real.pausedActions,
        }),
      }
    }
    if (this.receiptState?.().blocked && this.sessionId) return {
      type: 'scene', scene: this.scene('status_answer', {
        pose: 'reconciling', utterance: 'Receipt storage cannot be verified. Sending is held. Reopen Spriite to check storage again.',
        statusNote: 'Receipt storage held', actions: [{ id: 'back', label: 'Back', kind: 'command' }],
      }),
    }
    if (this.activeDelivery() && this.overlay === 'delivery') return this.overlayView()
    if (this.activeDelivery()) return {
      type: 'scene', scene: this.scene('status_answer', {
        pose: 'reconciling', utterance: COPY.real.deliveryUnknown,
        statusNote: COPY.real.messageUnconfirmedStatus, actions: COPY.real.deliveryUnknownActions,
      }),
    }
    if (this.needsResponseRefresh()) {
      return { type: 'scene', scene: this.scene('setup_notice', {
        pose: 'waiting', utterance: 'Refresh the saved result format.',
        statusNote: 'Older pending reply',
        actions: [{ id: 'retry', label: 'Refresh result', kind: 'command' }],
      }) }
    }
    if (this.transient) return { type: 'scene', scene: this.transient.scene }
    if (this.creatingRepo !== null) {
      return {
        type: 'scene',
        scene: this.scene('status_answer', {
          pose: 'delegating', utterance: COPY.real.creatingRepo,
          statusNote: COPY.real.creatingRepoStatus,
          actions: [{ id: 'status', label: 'Status', kind: 'read_only' }],
        }),
      }
    }
    if (this.overlay) return this.overlayView()
    return this.baseView()
  }

  private faultView(): EngineView {
    const errors = COPY.real.errors as Record<string, string>
    // The runtime's own refusals (capacity, policy, paused, terminal, storage)
    // are named like provider faults, but their copy says what actually
    // happened — a held launch, not a service failure.
    const utterance =
      this.faultKind !== null && errors[this.faultKind] !== undefined
        ? errors[this.faultKind]
        : COPY.real.errors.service
    return {
      type: 'scene',
      scene: this.scene('factory_error', {
        // MotionLab: a dropped computer/host link is Offline (dim, dozing
        // until it reconnects); Blocked is for something that failed.
        pose: this.faultKind === 'offline' ? 'offline' : 'blocked', utterance,
        status: this.faultStatusNote(),
        // A paused build's failure resumes first: Retry would only be held.
        actions: this.paused ? COPY.real.failPausedActions : COPY.real.failActions,
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
    const text = `Service failed${SEP}${short}`
    if (fitsWrappedLines(text, BUDGETS.status.width, BUDGETS.status.lines)) return text
    return `Service failed${SEP}${short.slice(0, 16)}...`
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
    // Point only at an action the card that opened this list offers.
    if (this.lastReply) items.push(this.phase === 'final' ? COPY.real.evidenceSummaryRow : COPY.real.evidenceReplyRow)
    return items.length > 0 ? items : ['Nothing recorded yet']
  }

  private emit(view: EngineView): void {
    this.seq += 1
    this.lastView = view
    if (view.type === 'scene') {
      const p = view.scene.progress
      console.log(
        `[scene] kind=${view.scene.kind} seq=${view.scene.stateSequence} rev=${view.scene.sceneRevision} pose=${view.scene.spritePose} live=1` +
          (p ? ` accepted=${p.acceptedWeight} pending=${p.pendingReviewWeight} total=${p.totalWeight}` : '') +
          // The card's action ids, so a walkthrough can tell a ready plan from a drafting one.
          ` actions=${view.scene.actions.map((a) => a.id).join(',') || 'none'}`,
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
    const previousActivity = this.activityStatus()
    const previousWatchUnknown = this.attach ? this.watchUnknown(this.attach) : false
    this.nowMs = now
    if (previousActivity !== this.activityStatus() ||
      (this.attach && previousWatchUnknown !== this.watchUnknown(this.attach))) {
      this.clearActivityAnswer()
      this.emitCurrent()
    }
    if (this.transient && now >= this.transient.until) {
      this.transient = null
      this.emitCurrent()
    }
    // Timed retries back off while lead posts keep failing; explicit calls
    // (restore, owner actions) still retry at once.
    if (now >= this.leadRetryAt) this.retryPendingPrompts()
    if (this.faultKind) return // a failed service stays failed until acted on
    this.pumpQueuedStart()
    // Arriving on the home (back from a watch, a restart) refreshes it now
    // instead of showing rows up to a full cadence old.
    if (this.phase === 'meet' && this.tickPhase !== 'meet') this.nextCloudPoll = 0
    this.tickPhase = this.phase
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
    if (watch && watch.source === 'cursor' && watch.agentId && !watch.polling) {
      // A finished (or absent) run cannot change; the agent may start a newer
      // one, so the agent list is checked for it on the slower cadence.
      const runLive = watch.runId !== null && !TERMINAL_RUN.has(watch.runStatus)
      if (runLive && now >= watch.nextPoll) {
        watch.nextPoll = now + RUN_POLL_MS
        void this.pollAttachWorker()
      } else if (!runLive && now >= watch.nextRunCheck) {
        watch.nextRunCheck = now + CLOUD_REFRESH_MS
        void this.checkAttachLatestRun()
      }
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

  private isReadBlip(e: unknown): boolean {
    return this.isBlip(e) || (e instanceof Error && 'kind' in e && e.kind === 'timeout')
  }

  private isUnconfirmedPost(e: unknown): boolean {
    if (e instanceof Error && 'notDispatched' in e && e.notDispatched === true) return false
    if (e instanceof Error && 'kind' in e) {
      const kind = String(e.kind)
      if (['auth', 'forbidden', 'permission', 'billing', 'quota', 'exists', 'offline',
        'storage', 'policy', 'paused', 'cancelling', 'terminal', 'capacity'].includes(kind)) return false
      if (kind === 'service' && /HTTP 4\d\d\b/.test(e.message)) return false
    }
    // An invoked call is unknown unless an explicit refusal proves it was
    // unsent. Unclassified exceptions are not permission for a blind replay.
    return true
  }

  /** True when `gen` is no longer this engine's generation (reset/restore). */
  private genStale(gen: number): boolean {
    return this.generation !== gen
  }

  /**
   * Dispatch only genuinely unsent turns, in order. Invoked requests with
   * lost acknowledgments are receipt holds, never automatic retries.
   *
   * The queued lead posts re-send ONE AT A TIME, in the order they were
   * sent: they are turns of one conversation (an answer, then a steer), and
   * the lead reading them transposed would answer the wrong thing. The
   * worker prompts are independent sessions and stay parallel.
   */
  private retryPendingPrompts(): void {
    if (this.paused || this.busy || this.faultKind || this.activeDelivery() || this.needsResponseRefresh()) return
    if (this.sessionId !== null && this.pendingLeadPosts.length > 0 && !this.leadPostInFlight &&
      !this.nativeQuestion && !this.queuedLeadQuestion?.native) {
      const sessionId = this.sessionId
      const pending = this.pendingLeadPosts
      const queuedBefore = pending.length
      this.leadPostInFlight = true
      const gen = this.generation
      void (async () => {
        for (const p of pending) {
          this.pendingLeadPosts = pending.slice(pending.indexOf(p))
          if (p.legacyDeliveryUnknown) {
            this.pendingLeadPosts = pending.slice(pending.indexOf(p) + 1)
            this.awaiting = p.soft ? (this.awaiting ?? p.awaiting) : p.awaiting
            this.beginDelivery(sessionId, p.text, null)
            break
          }
          try {
            await this.postLead(p.text, p.awaiting, p.soft, p.protectDelivery, true)
            if (this.generation !== gen || this.sessionId !== sessionId) break
            if (this.activeDelivery()) {
              for (const rest of pending.slice(pending.indexOf(p) + 1)) {
                this.queueLeadPost(rest.text, rest.awaiting, rest.soft, rest.protectDelivery, rest.legacyDeliveryUnknown)
              }
              break
            }
            if (this.pendingLeadPosts.some(rest => rest.text === p.text && rest.awaiting === p.awaiting)) {
              this.pendingLeadPosts = pending.slice(pending.indexOf(p))
              break
            }
            this.awaiting = p.soft ? (this.awaiting ?? p.awaiting) : p.awaiting
            this.emitCurrent()
          } catch (e) {
            if (this.generation !== gen || this.sessionId !== sessionId) break
            this.pendingLeadPosts = []
            // postLead retains every invoked unknown itself. A thrown read
            // error or explicit refusal leaves this head genuinely unsent.
            for (const rest of pending.slice(pending.indexOf(p))) {
              this.queueLeadPost(rest.text, rest.awaiting, rest.soft, rest.protectDelivery, rest.legacyDeliveryUnknown)
            }
            if (this.isReadBlip(e)) {
              this.activity.delete(sessionId)
              this.emitCurrent()
            } else this.fault(e, 'factory', 'steer')
            break
          }
        }
        if (this.generation === gen) {
          this.leadPostInFlight = false
          // Still queued after a pass: back off (1s, 2s, 4s … 30s) instead of
          // re-reading the conversation on every 400 ms tick during an outage.
          if (this.pendingLeadPosts.length >= queuedBefore && !this.nativeQuestion && !this.queuedLeadQuestion?.native) {
            this.leadRetryFails++
            this.leadRetryAt = this.nowMs + Math.min(30_000, 1000 * 2 ** Math.min(this.leadRetryFails - 1, 5))
          } else { this.leadRetryFails = 0; this.leadRetryAt = 0 }
        }
      })()
    }
    for (const job of this.jobs) {
      if (job.pendingPrompt === null || !job.sessionId || job.polling || job.state === 'stopped') continue
      const text = job.pendingPrompt
      const index = this.jobs.indexOf(job)
      const retry: FaultRetry =
        job.stage === 'pr' ? 'pr' : job.stage === 'integration' ? 'integration' : job.stage === 'fix' ? 'fix' : 'build'
      job.polling = true
      const gen = this.generation
      void this.postWorkerPrompt(job, text, job.stage)
        .then(() => {
          if (this.generation !== gen) return
          job.pendingPrompt = null
          job.polling = false
        })
        .catch((e: unknown) => {
          job.polling = false
          if (this.generation !== gen) return
          if (!this.isBlip(e)) {
            // A created build worker cannot be recreated to recover an
            // unposted first instruction. Keep it for the owner's retry.
            if (job.stage !== 'build') job.pendingPrompt = null
            this.fault(e, 'factory', retry, index >= 0 ? index : undefined)
          }
        })
    }
  }

  /**
   * Queue a lead post a network blip interrupted. Bounded: at most 16 queued
   * posts, retried with exponential backoff (to 30 s) while they keep
   * failing, and an identical queued post is never duplicated.
   */
  private queueLeadPost(text: string, awaiting: RealSnapshot['awaiting'], soft: boolean, protectDelivery = true, legacyDeliveryUnknown = false): void {
    if (this.pendingLeadPosts.length >= 16) {
      if (this.sessionId) this.retainDraft(this.sessionId, text)
      return // never drop an earlier owner turn to make room
    }
    if (!this.pendingLeadPosts.some((p) => p.text === text && p.awaiting === awaiting)) {
      this.pendingLeadPosts.push({ text, awaiting, soft, protectDelivery, legacyDeliveryUnknown })
    }
  }

  /**
   * One post to the lead session. A network blip (the response lost, or the
   * request never sent) does NOT fault the mission: the post is queued for
   * the tick to re-send, because the awaited reply can never arrive
   * otherwise. `soft` keeps an already-awaited value instead of replacing
   * it (an answer never cancels what the lead still owes).
   */
  private async postLead(text: string, awaiting: RealSnapshot['awaiting'], soft: boolean, protectDelivery = true, queuedHead = false): Promise<void> {
    if (this.quarantined) throw Object.assign(new Error('Saved execution is quarantined; no coordinator turn was dispatched'), { kind: 'policy', notDispatched: true })
    if (this.leadDispatchOwner) {
      this.queueLeadPost(text, awaiting, soft, true)
      this.emitCurrent()
      return
    }
    const owner = {}
    this.leadDispatchOwner = owner
    try { await this.postLeadTurn(text, awaiting, soft, protectDelivery, queuedHead) }
    finally { if (this.leadDispatchOwner === owner) this.leadDispatchOwner = null }
  }

  private async postLeadTurn(text: string, awaiting: RealSnapshot['awaiting'], soft: boolean, protectDelivery = true, queuedHead = false): Promise<void> {
    // All coordinator turns can cause remote execution, including reviews and
    // summaries. Legacy callers cannot opt out of receipts or final barriers.
    protectDelivery = true
    if (this.sessionId === null) return
    if (this.activeDelivery()) {
      // Later coordinator requests are genuinely unsent. Do not drop a
      // verdict/summary while an owner's earlier turn awaits acknowledgment.
      if (text !== this.activeDelivery()!.text) this.queueLeadPost(text, awaiting, soft, protectDelivery)
      this.emitCurrent()
      return
    }
    if (protectDelivery && !queuedHead && this.pendingLeadPosts.length > 0) {
      const head = this.pendingLeadPosts[0]
      if (head.text === text && head.awaiting === awaiting && head.soft === soft && !head.legacyDeliveryUnknown) {
        queuedHead = true // explicit retry of this SAME provably unsent head
      } else {
        this.queueLeadPost(text, awaiting, soft, true)
        this.emitCurrent()
        return // genuinely unsent, ordered behind an earlier turn
      }
    }
    const sessionId = this.sessionId
    const gen = this.generation
    // Record the provably unsent head BEFORE its mandatory prerequisite GET.
    // A read failure or restart must not drop a review/answer/summary.
    this.queueLeadPost(text, awaiting, soft, true)
    this.awaiting = soft ? (this.awaiting ?? awaiting) : awaiting
    this.emitCurrent()
    let beforeMessageIds = this.observedLeadMessages?.sessionId === sessionId
      && this.observedLeadMessages.ids.length <= 2000 ? [...this.observedLeadMessages.ids] : null
    if (protectDelivery) {
      let messages: FactoryMessage[]
      try { messages = await this.clients.getMessages(sessionId, this.computerFor(sessionId)) }
      catch (e) {
        if (this.genStale(gen) || this.sessionId !== sessionId) return
        this.activity.delete(sessionId)
        this.emitCurrent()
        if (this.isReadBlip(e)) return // no POST, no receipt; exact queue owns retry
        throw e
      }
      if (this.genStale(gen) || this.sessionId !== sessionId) return
      if (this.activeDelivery()) return // never replace another turn's unknown
      this.observeNativeQuestions(messages, sessionId)
      if (!factoryHistoryComplete(messages) || this.paused || this.nativeQuestion || this.queuedLeadQuestion?.native) {
        // Held, not dropped: the queued head is re-sent once the pause or
        // attention clears. It is Spriite's own turn (a review request, an
        // answer envelope), never the owner's words, and it WILL be sent,
        // so no owner bubble and no "not sent" draft note.
        this.queueLeadPost(text, awaiting, soft, true)
        this.emitCurrent()
        return
      }
      beforeMessageIds = messages.length <= 2000 ? messages.map(m => m.id) : null
    }
    this.activity.delete(sessionId)
    if (this.observedLeadMessages?.sessionId === sessionId) this.observedLeadMessages.scope = null
    if (this.attach?.source === 'factory' && this.attach.sessionId === sessionId) this.attach.checkedAt = null
    if (protectDelivery) {
      // Replace only this head with its delivery hold. Later unsent turns
      // must remain in every checkpoint made during the transport await.
      this.pendingLeadPosts = this.pendingLeadPosts.filter(p => p.text !== text || p.awaiting !== awaiting)
    }
    const initial = this.initialPlanTurn?.sessionId === sessionId && this.initialPlanTurn.text === text
      ? this.initialPlanTurn : null
    if (initial) initial.state = 'unknown'
    const attempt = protectDelivery ? this.beginDelivery(sessionId, text, beforeMessageIds) : null
    let dispatched = false
    try {
      if (attempt && this.beforeSessionDispatch) {
        await this.beforeSessionDispatch()
        if (this.deliveryAttempts.get(sessionId) !== attempt) return
        if (this.genStale(gen) || this.sessionId !== sessionId) {
          this.finishDelivery(attempt)
          return
        }
      }
      if (this.paused || this.nativeQuestion || this.queuedLeadQuestion?.native) {
        throw Object.assign(new Error('Message authority changed before dispatch'), { kind: 'policy' })
      }
      dispatched = true
      await this.clients.postMessage(sessionId, text, this.computerFor(sessionId))
      if (initial && !this.genStale(gen)) initial.state = 'accepted'
      if (!this.genStale(gen) && awaiting === 'plan' &&
        text.includes('After ALL numbered plan lines, end with a final line exactly PLAN_READY.')) this.planProtocol = 'marker-v1'
      if (attempt) this.finishDelivery(attempt)
      if (this.generation !== gen || this.sessionId !== sessionId) return
      this.awaiting = soft ? (this.awaiting ?? awaiting) : awaiting
    } catch (e) {
      if (attempt && dispatched && this.isUnconfirmedPost(e)) {
        // The session owns the attempt even after navigation changed the view.
        if (this.deliveryAttempts.get(sessionId) === attempt && this.sessionId === sessionId) {
          this.pendingLeadDelivery = attempt
          this.awaiting = soft ? (this.awaiting ?? awaiting) : awaiting
          this.emitCurrent()
        }
        return
      }
      if (initial) initial.state = 'unsent' // explicit refusal or never invoked
      if (attempt) this.finishDelivery(attempt)
      if (this.generation !== gen || this.sessionId !== sessionId) return
      // Known-none retries keep this saved FIFO turn, including its token.
      this.queueLeadPost(text, awaiting, soft, true)
      this.emitCurrent()
      if (!dispatched) throw e
      if (!this.isBlip(e)) throw e
    }
  }

  private activeDelivery(): DeliveryAttempt | null {
    this.syncReceiptState()
    if (this.receiptState?.().blocked && this.sessionId) return {
      sessionId: this.sessionId, text: 'Receipt storage cannot be verified', beforeMessageIds: null,
    }
    return (this.sessionId ? this.deliveryAttempts.get(this.sessionId) : undefined) ??
      this.pendingLeadDelivery ??
      this.jobs.map(job => job.sessionId ? this.deliveryAttempts.get(job.sessionId) : undefined).find(Boolean) ?? null
  }

  private syncReceiptState(): void {
    const state = this.receiptState?.()
    if (!state || state.blocked) return
    if (this.pendingLeadDelivery && !this.deliveryAttempts.has(this.pendingLeadDelivery.sessionId)) {
      const attempt = decodeDeliveryAttempt(this.pendingLeadDelivery)
      if (attempt) this.deliveryAttempts.set(attempt.sessionId, attempt)
    }
    const known = new Set(state.records.map(r => r.sessionId))
    // Import an older snapshot hold only when this independent ledger has
    // never recorded that session. Its resolved tombstones always win.
    for (const [sessionId, attempt] of this.deliveryAttempts) {
      if (!known.has(sessionId)) this.onReceiptMutation?.(sessionId, attempt)
    }
    for (const record of state.records) {
      if (record.attempt === null) this.deliveryAttempts.delete(record.sessionId)
      else if (this.deliveryAttempts.get(record.sessionId)?.text !== record.attempt.text ||
        JSON.stringify(this.deliveryAttempts.get(record.sessionId)?.beforeMessageIds) !== JSON.stringify(record.attempt.beforeMessageIds)) {
        this.deliveryAttempts.set(record.sessionId, record.attempt)
      }
    }
    if (this.sessionId) this.pendingLeadDelivery = this.deliveryAttempts.get(this.sessionId) ?? null
  }

  private beginDelivery(sessionId: string, text: string, beforeMessageIds: string[] | null): DeliveryAttempt {
    if (this.deliveryAttempts.has(sessionId)) {
      throw Object.assign(new Error('An existing delivery outcome is unknown; no replacement turn was dispatched'), { kind: 'policy', notDispatched: true })
    }
    const attempt = { sessionId, text, beforeMessageIds }
    this.localEchoes.push(attempt)
    this.localEchoes = this.localEchoes.slice(-32)
    this.deliveryAttempts.set(sessionId, attempt)
    this.onReceiptMutation?.(sessionId, attempt)
    if (sessionId === this.sessionId) this.pendingLeadDelivery = attempt
    // Publish the attempt before invoking transport; a restart must hold it.
    this.emitCurrent()
    return attempt
  }

  private finishDelivery(attempt: DeliveryAttempt): void {
    if (this.deliveryAttempts.get(attempt.sessionId) !== attempt) return
    this.deliveryAttempts.delete(attempt.sessionId)
    this.onReceiptMutation?.(attempt.sessionId, null)
    if (this.pendingLeadDelivery === attempt) this.pendingLeadDelivery = null
    this.emitCurrent()
  }

  private reconcileDelivery(sessionId: string, messages: FactoryMessage[]): void {
    this.reconcileLegacyInitialPlan(sessionId, messages)
    const attempt = this.deliveryAttempts.get(sessionId)
    if (attempt?.beforeMessageIds !== null && attempt &&
      messages.some(m => m.role === 'user' && m.text === attempt.text && !attempt.beforeMessageIds!.includes(m.id))) {
      if (this.initialPlanTurn?.sessionId === sessionId && this.initialPlanTurn.text === attempt.text) {
        this.initialPlanTurn.state = 'accepted'
      }
      if (attempt.text.includes('After ALL numbered plan lines, end with a final line exactly PLAN_READY.')) {
        this.planProtocol = 'marker-v1'
      }
      this.finishDelivery(attempt)
    }
  }

  private legacyInitialPlanText(): string {
    return `Legacy initial planning POST (original bytes unavailable)\nMission goal: ${this.goal}\nRepository: ${this.missionRepo}`
  }

  /** Only positive, complete owner+plan history can resolve the opaque legacy
   * initial intent. Absence, idle, or a timeout never grants a replay. */
  private reconcileLegacyInitialPlan(sessionId: string, messages: FactoryMessage[]): void {
    const initial = this.initialPlanTurn
    if (!initial || initial.sessionId !== sessionId || initial.state !== 'unknown' || initial.text !== null ||
      !factoryHistoryComplete(messages) || messages.some(m => m.nativeQuestions?.some(q => q.pending))) return
    const index = messages.findIndex(m => m.role === 'user' &&
      /^(?:You are the orchestrator|You coordinate;)/.test(m.text) &&
      m.text.match(/(?:^|\n)Mission goal:[ \t]*([\s\S]*?)(?=\nRepository(?: the worker builds on)?:)/)?.[1]?.trim() === this.goal &&
      this.githubRepository(m.text.match(/(?:^|\n)Repository(?: the worker builds on)?:\s*(\S+)/)?.[1] ?? '') === this.githubRepository(this.missionRepo))
    if (index < 0) return
    const reply = messages.slice(index + 1).findLast(m => m.role === 'assistant')
    const lines = reply?.text.trim().split('\n').map(s => s.trim()).filter(Boolean) ?? []
    if (lines.at(-1) !== 'PLAN_READY' || lines.length < 2 ||
      !lines.slice(0, -1).every((s, i) => new RegExp(`^${i + 1}[.)]\\s+\\S`).test(s))) return
    const attempt = this.deliveryAttempts.get(sessionId)
    if (!attempt || attempt.text !== this.legacyInitialPlanText()) return
    initial.text = messages[index].text
    initial.state = 'accepted'
    this.finishDelivery(attempt)
  }

  /** Accepted owner input supersedes readiness, not the frozen repository/settings. */
  private ownerTurn(text: string, preserveDecisionRevision = false): void {
    this.scopeRevision++
    if (this.phase !== 'plan' || this.jobs.length) return
    if (!isGeneratedConversationControl(text)) this.requiresFreshApproval = true
    this.ownerClarifications.push(text)
    // An explicit answer is recorded against the displayed decision's plan
    // revision. Awaiting a new plan still makes these old labels unlaunchable.
    if (!preserveDecisionRevision) this.planLabels = []
    this.approvedPlan = []
    this.awaiting = 'plan'
    this.buildDraft = null
    if (this.overlay === 'chat_build') this.overlay = null
    if (this.decisionGate && this.decisionKind === 'build') {
      this.decisionPending = false
      this.decisionGate = false
      this.queuedStart = null
      this.chatAsked = ''
    }
  }

  private async pollLead(): Promise<void> {
    if (!this.sessionId || this.pollingLead || this.faultKind) return
    const sessionId = this.sessionId
    this.pollingLead = true
    const gen = this.generation
    try {
      const info = await this.clients.getSession(sessionId, this.computerFor(sessionId))
      if (this.generation !== gen || this.sessionId !== sessionId) return
      const activityChanged = this.observeActivity(sessionId, info.status)
      this.messageCount = info.messageCount
      const watch = this.attach
      if (watch && watch.source === 'factory' && watch.sessionId === this.sessionId) {
        const recovered = this.attachSeen(watch)
        if (watch.runStatus !== (info.status ?? 'unknown') || recovered) {
          if (info.status && info.status !== watch.runStatus) watch.changedAt = this.nowMs
          watch.runStatus = info.status ?? 'unknown'
          this.emitCurrent()
        }
        if (!watch.primed) {
          // First watch poll: mark the existing history seen, show the latest
          // reply, and only surface messages that arrive from here on.
          const messages = await this.clients.getMessages(sessionId, this.computerFor(sessionId))
          if (this.generation !== gen || this.sessionId !== sessionId) return
          this.observeLeadDelivery(sessionId, messages)
          watch.primed = true
          this.seenMessageIds.clear()
          this.observeResponses(messages, this.sessionId, 'watched')
          this.observeNativeQuestions(messages, this.sessionId)
          for (const m of messages) freshMessage(this.seenMessageIds, m)
          const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.text)
          if (last) this.lastReply = fitUtterance(hudReply(last.text))
          if (last && !messages.slice(messages.indexOf(last) + 1).some(m => m.role === 'user') &&
            (/^DECISION:/i.test(last.text.trim()) || last.text.trim().endsWith('?'))) {
            this.handleReply(last.text, false, last.id)
          }
          this.emitCurrent()
          return
        }
      }
      // Counts do not change when a streamed message gains text or a native
      // question. Poll once on the normal cadence and dedupe by revision.
      if (!watch && activityChanged) this.emitCurrent()
      await this.fetchNewMessages(gen)
    } catch (e) {
      if (this.generation === gen && this.sessionId === sessionId) {
        if (this.sessionId) this.activity.delete(this.sessionId)
        this.clearActivityAnswer()
        if (!this.isReadBlip(e)) this.fault(e, 'factory')
        else if (this.attach?.source === 'factory') {
          this.attach.checkedAt = null
          this.attachMissed(this.attach)
          this.emitCurrent()
        }
        else this.emitCurrent()
      }
    } finally {
      if (this.generation === gen) this.pollingLead = false
    }
  }

  /** A watch status check failed on a blip; past the limit the card says so. */
  private attachMissed(watch: AttachWatch): void {
    watch.misses += 1
    if (watch.misses === ATTACH_UNKNOWN_AFTER && this.attach === watch && this.phase === 'attach') {
      this.emitCurrent()
    }
  }

  /** A watch status check succeeded; true when the card was showing unknown. */
  private attachSeen(watch: AttachWatch): boolean {
    const wasUnknown = this.watchUnknown(watch)
    watch.misses = 0
    watch.checkedAt = this.nowMs
    return wasUnknown
  }

  private async fetchNewMessages(gen: number): Promise<void> {
    if (!this.sessionId) return
    const sessionId = this.sessionId
    const messages = await this.clients.getMessages(sessionId, this.computerFor(sessionId))
    if (this.generation !== gen || this.sessionId !== sessionId) return
    this.observeLeadDelivery(sessionId, messages)
    this.observeResponses(messages, this.sessionId, this.phase === 'attach' ? 'watched' : 'lead')
    this.observeNativeQuestions(messages, this.sessionId)
    if (!factoryHistoryComplete(messages)) {
      this.activity.delete(sessionId)
      this.lastReply = 'Factory history is incomplete. Check the exact conversation in Factory; execution is held.'
      this.emitCurrent()
      return
    }
    this.observeHistoryActivity(sessionId, messages)
    const fresh: FactoryMessage[] = []
    for (const m of messages) {
      if (freshMessage(this.seenMessageIds, m)) fresh.push(m)
    }
    if (fresh.length > 0 && this.attach?.source === 'factory') this.attach.changedAt = this.nowMs
    const latestUser = messages.findLastIndex(ownerProviderTurn)
    for (const m of fresh) {
      if (messages.indexOf(m) < latestUser && (/^DECISION:/i.test(m.text.trim()) || m.text.trim().endsWith('?'))) continue
      // A revision of an older assistant message is not the response to the
      // owner's newer scope turn, even when it grows a completion marker.
      if (this.phase === 'plan' && this.ownerClarifications.length && messages.indexOf(m) < latestUser) continue
      this.handleReply(m.text, false, m.id)
    }
  }

  private observeHistoryActivity(sessionId: string, messages: FactoryMessage[]): void {
    const signature = JSON.stringify(messages.map(m => [m.id, m.role, m.text, m.hasToolActivity]))
    const prior = this.historyObservations.get(sessionId)
    this.historyObservations.set(sessionId, signature)
    if (prior !== undefined && prior !== signature && this.activity.get(sessionId)?.status === 'idle') {
      // Idle contradicted by newly observed activity is not readiness. A
      // subsequent unchanged observation can report idle, not eternal busy.
      this.activity.set(sessionId, { status: 'unknown', checkedAt: this.nowMs })
      this.clearActivityAnswer()
      this.emitCurrent()
    }
  }

  private retainDraft(sessionId: string, text: string): void {
    if (this.retainedDraft?.sessionId !== sessionId || this.retainedDraft.text !== text) {
      this.retainedDraft = { sessionId, text }
      this.chat('you', text)
      this.chat('spriite', `Draft retained for Factory session ${sessionId}; not sent. Resolve the active attention and send it explicitly.`)
    }
    this.emitCurrent()
  }

  private observeResponses(messages: FactoryMessage[], sessionId: string, who: ChatWho): void {
    for (const message of messages) {
      if (message.role === 'user' && message.text.trim()) {
        const id = `user:${JSON.stringify(sessionId)}:${JSON.stringify(message.id)}`
        if (!this.chatSeenIds.has(id)) {
          this.chatSeenIds.add(id)
          const echo = this.localEchoes.findIndex(e => e.sessionId === sessionId && e.text === message.text &&
            e.beforeMessageIds !== null && !e.beforeMessageIds.includes(message.id))
          const words = ownerWords(readableReply(message.text))
          const localAlreadyDisplayed = echo >= 0 && this.chatLogEntries.some(e => e.who === 'you' && e.text === words)
          if (echo >= 0) this.localEchoes.splice(echo, 1)
          // Spriite's own protocol turns (the orchestrator brief, review and
          // worker requests, Continue) are scaffolding, never the owner's words.
          if (!localAlreadyDisplayed && ownerProviderTurn(message) &&
            !/^You coordinate; you do not edit code\.\n/.test(message.text)) this.chat('you', message.text)
        }
      }
      if (freshMessage(this.chatSeenIds, { ...message, id: `${sessionId}:${message.id}` })) {
        this.chat(who, message.text)
      }
      for (const question of message.nativeQuestions ?? []) {
        const text = readableQuestionnaire(question.text)
        if (freshMessage(this.chatSeenIds, { id: `${sessionId}:native:${question.toolId}`, role: 'assistant', text })) this.chat(who, text)
      }
    }
  }

  private observeLeadDelivery(sessionId: string, messages: FactoryMessage[]): void {
    const firstRead = this.observedLeadMessages?.sessionId !== sessionId
    const priorIds = new Set(firstRead ? [] : this.observedLeadMessages!.ids)
    const latestAssistant = messages.findLastIndex(m => m.role === 'assistant')
    if (factoryHistoryComplete(messages)) {
      for (const [index, message] of messages.entries()) {
        if (!ownerProviderTurn(message) || (firstRead ? index <= latestAssistant : priorIds.has(message.id))) continue
        const local = this.localEchoes.some(e => e.sessionId === sessionId && e.text === message.text &&
          e.beforeMessageIds !== null && !e.beforeMessageIds.includes(message.id))
        if (!local && !this.ownerClarifications.includes(message.text)) this.ownerTurn(message.text)
      }
    }
    const pending = this.pendingLeadDelivery
    this.reconcileDelivery(sessionId, messages)
    const scope = chatBuildScope(messages, this.phase === 'plan' ? { goal: this.goal, repository: this.missionRepo } : undefined)
    const scopeChanged = JSON.stringify(scope) !== JSON.stringify(this.observedLeadMessages?.scope ?? null)
    this.observedLeadMessages = { sessionId, ids: messages.map(m => m.id), scope }
    this.observeExternalQuestionClosure(messages, sessionId)
    if (pending?.sessionId === sessionId && pending.beforeMessageIds !== null &&
      messages.some(m => m.role === 'user' && m.text === pending.text && !pending.beforeMessageIds!.includes(m.id))) {
      this.pendingLeadDelivery = null
      this.pendingLeadPosts = this.pendingLeadPosts.filter(p => p.text !== pending.text)
      this.lastSteer = ''
      this.transient = null
      this.overlay = null
      this.emitCurrent()
    } else if (firstRead || scopeChanged) this.emitCurrent()
  }

  private observeExternalQuestionClosure(messages: FactoryMessage[], sessionId: string, job?: RealJob): void {
    if (!factoryHistoryComplete(messages)) return
    const question = job?.question ?? (this.decisionPending && !this.decisionGate &&
      this.decisionJob === null && this.sessionId === sessionId
      ? { text: this.decisionText, options: this.decisionOptions, native: this.nativeQuestion ?? undefined,
          messageId: this.plainQuestionMessageId ?? undefined } : null)
    if (!question || question.native) return
    const asked = messages.findLastIndex(m => m.role === 'assistant' && (question.messageId
      ? m.id === question.messageId
      : parseQuestion(m.text.replace(/^REQUEST:\s*\S+\s*$/gim, '').replace(/\s+/g, ' ').trim()).text === question.text))
    if (asked < 0 || !messages.slice(asked + 1).some(ownerProviderTurn)) return
    if (job) job.question = null
    if ((!job && this.decisionJob === null) || (job && this.decisionJob === this.jobs.indexOf(job))) {
      this.decisionPending = false
      this.decisionOptions = []
      this.decisionJob = null
      this.chatAsked = ''
    }
  }

  /** Native tool input is not resolved by sending ordinary steering text. */
  private observeNativeQuestions(messages: FactoryMessage[], sessionId: string, job?: RealJob): void {
    const before = JSON.stringify([this.decisionPending, this.decisionText, this.nativeQuestion, this.queuedLeadQuestion])
    const completed = new Set(messages.flatMap(m => m.completedToolIds ?? []))
    if (job?.question?.native && completed.has(job.question.native.toolId)) job.question = null
    if (this.queuedLeadQuestion?.native?.sessionId === sessionId &&
        completed.has(this.queuedLeadQuestion.native.toolId)) this.queuedLeadQuestion = null
    if (this.nativeQuestion?.sessionId === sessionId && completed.has(this.nativeQuestion.toolId)) {
      this.nativeQuestion = null
      this.decisionPending = false
      this.decisionJob = null
      this.chatAsked = ''
    }
    for (const message of messages) for (const question of message.nativeQuestions ?? []) {
      if (!question.pending) continue
      const text = readableQuestionnaire(question.text)
      const native = { toolId: question.toolId, sessionId }
      if (job) {
        job.question = { text, options: [], native }
        if (this.decisionPending && this.decisionJob === this.jobs.indexOf(job)) {
          this.decisionText = text
          this.decisionOptions = []
          this.nativeQuestion = native
        }
      } else if (this.decisionPending && this.decisionJob !== null) {
        this.queuedLeadQuestion = { text, options: [], awaiting: this.awaiting, verdictToken: this.verdictToken, native }
      } else {
        this.decisionText = text
        this.decisionOptions = []
        this.decisionPending = true
        this.decisionGate = false
        this.decisionJob = null
        this.nativeQuestion = native
      }
    }
    this.showWorkerQuestion()
    if (before !== JSON.stringify([this.decisionPending, this.decisionText, this.nativeQuestion, this.queuedLeadQuestion])) this.emitCurrent()
  }

  private async pollJob(job: RealJob): Promise<void> {
    if (job.polling || job.state !== 'building' || this.faultKind) return
    job.polling = true
    const gen = this.generation
    const source = job.mode === 'cursor' ? 'cursor' : 'factory'
    try {
      if (job.mode === 'cursor') {
        if (!job.agentId || !job.runId) return
        const run = await this.clients.cursorGet(job.agentId, job.runId)
        if (this.generation !== gen) return
        if (this.observeActivity(job.runId, run.status)) this.emitCurrent()
        job.runStatus = run.status
        if (run.status === 'FINISHED') await this.handleRunDone(job, run, gen)
        else if (run.status === 'ERROR' || run.status === 'CANCELLED' || run.status === 'EXPIRED') {
          this.handleRunFailed(job, run)
        }
      } else {
        if (!job.sessionId) return
        const info = await this.clients.getSession(job.sessionId, this.computerFor(job.sessionId))
        if (this.generation !== gen) return
        job.runStatus = info.status ?? 'unknown'
        if (this.observeActivity(job.sessionId, info.status)) this.emitCurrent()
        job.count = info.messageCount
        // Active workers may stream text without changing messageCount.
        // One fetch per scheduled poll, never a prompt resend or busy loop.
        if (job.state === 'building') {
          const messages = await this.clients.getMessages(job.sessionId, this.computerFor(job.sessionId))
          if (this.generation !== gen) return
          this.reconcileDelivery(job.sessionId, messages)
          job.lastCount = info.messageCount
          const seen = new Set(job.seenIds)
          let requestStart = -1
          messages.forEach((message, index) => {
            if (job.requestToken && message.role === 'user' && message.text.includes(`"REQUEST: ${job.requestToken}"`)) requestStart = index
          })
          this.observeResponses(messages, job.sessionId, 'worker')
          this.observeExternalQuestionClosure(messages, job.sessionId, job)
          this.observeNativeQuestions(messages.map((m, index) => index >= requestStart ? m : { ...m, nativeQuestions: [] }), job.sessionId, job)
          this.observeHistoryActivity(job.sessionId, messages)
          const latestUser = messages.findLastIndex(ownerProviderTurn)
          for (const [index, m] of messages.entries()) {
            const currentRequest = factoryHistoryComplete(messages) && requestStart >= 0 && index >= requestStart
            if (currentRequest && m.role === 'assistant' && m.hasToolActivity && !seen.has(`activity:${m.id}`)) {
              seen.add(`activity:${m.id}`)
              job.executionObserved = true
              this.emitCurrent()
            }
            if (job.state === 'building' && freshMessage(seen, m) && currentRequest) {
              if (index < latestUser && (/^DECISION:/i.test(m.text.trim()) || m.text.trim().endsWith('?'))) continue
              this.handleWorkerReply(job, m.text, false, m.id)
            }
          }
          job.seenIds = [...seen]
        }
      }
    } catch (e) {
      if (this.generation === gen) {
        const id = job.mode === 'cursor' ? job.runId : job.sessionId
        if (id) this.activity.delete(id)
        this.clearActivityAnswer()
        if (!this.isReadBlip(e)) this.fault(e, source)
        else this.emitCurrent()
      }
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
    const gen = this.generation
    let failed = false
    const list = async (run: () => Promise<void>, label: string) => {
      try {
        await run()
      } catch (e) {
        failed = true
        console.warn(`[engine] ${label} list failed:`, e instanceof Error ? e.message : e)
      }
    }
    try {
      // Each source refreshes on its own: one failing keeps its last rows
      // without blocking the other's update.
      if (this.factoryKey)
        await list(async () => {
          const rows = await this.clients.listFactorySessions()
          if (!this.genStale(gen)) this.cloudSessions = rows
        }, 'Factory')
      if (this.cursorKey)
        await list(async () => {
          const rows = await this.clients.listCursorAgents()
          if (!this.genStale(gen)) this.cloudAgents = rows
        }, 'Cursor')
      if (this.genStale(gen)) return
      this.cloudFailing = failed
      if (!failed) this.cloudFetchedAt = this.nowMs
    } finally {
      if (this.genStale(gen)) return
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
    const gen = this.generation
    try {
      const run = await this.clients.cursorGet(watch.agentId, watch.runId)
      if (this.attach !== watch || this.genStale(gen)) return // the user moved on
      const recovered = this.attachSeen(watch)
      const text = run.text ? fitUtterance(run.text) : ''
      if (text && text !== this.lastReply) {
        watch.runStatus = run.status
        watch.changedAt = this.nowMs
        this.lastReply = text
        this.emitCurrent()
        return
      }
      if (watch.runStatus !== run.status || recovered) {
        if (watch.runStatus !== run.status) watch.changedAt = this.nowMs
        watch.runStatus = run.status
        this.emitCurrent()
      }
    } catch (e) {
      if (!this.genStale(gen)) {
        if (!this.isBlip(e)) this.fault(e, 'cursor')
        else this.attachMissed(watch)
      }
    } finally {
      watch.polling = false
    }
  }

  /**
   * A watched Cursor agent whose run has ended (or that had none): look for
   * a newer run on it, so a follow-up started elsewhere shows as building
   * instead of the old run's "done". Listing failures stay quiet.
   */
  private async checkAttachLatestRun(): Promise<void> {
    const watch = this.attach
    if (!watch || watch.source !== 'cursor' || !watch.agentId || watch.polling || this.faultKind) return
    watch.polling = true
    const gen = this.generation
    try {
      const agents = await this.clients.listCursorAgents()
      if (this.attach !== watch || this.genStale(gen)) return
      const agent = agents.find((a) => a.agentId === watch.agentId)
      const recovered = agent ? this.attachSeen(watch) : false
      if (agent?.latestRunId && agent.latestRunId !== watch.runId) {
        watch.runId = agent.latestRunId
        watch.runStatus = agent.status
        watch.nextPoll = 0 // poll the new run on the next tick
        this.lastReply = ''
        this.emitCurrent()
      } else if (recovered && agent) {
        if (watch.runStatus === 'unknown' || watch.runId === null) watch.runStatus = agent.status
        this.emitCurrent()
      }
    } catch (e) {
      console.warn('[engine] Cursor agent check failed:', e instanceof Error ? e.message : e)
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

  /**
   * The computer a session call must name. Factory finds a computer-hosted
   * session only on its own computer: a read or write that names none (or a
   * different one) answers 404 "session does not exist", so every session
   * call passes one. A watched cloud build names the computer its row
   * carries, which can differ from the mission's; a local watch has none, so
   * its refused message keeps the honest 400 instead of a wrong-computer 404.
   */
  private computerFor(sessionId: string | null): string | undefined {
    const watch = this.attach
    if (sessionId && watch && watch.source === 'factory' && watch.sessionId === sessionId) {
      return watch.computerId ?? undefined
    }
    if (sessionId && (sessionId === this.sessionId || this.jobs.some(j => j.sessionId === sessionId))) {
      return this.resolvedComputerId ?? undefined
    }
    return this.resolvedComputerId ?? (this.computerId || undefined)
  }

  /** Resolve through published read APIs, then bind the plan to that commit.
   * A changed default/ref/commit invalidates readiness; it is never silently
   * substituted under an already approved first worker launch.
   */
  private async freezeRepositoryBase(beforeExecution = false): Promise<boolean> {
    if (!this.clients.repositoryBase) return true // Older synthetic client seams have no live GitHub capability.
    const gen = this.generation
    const repository = this.githubRepository(this.missionRepo || this.repoUrl)
    if (!repository) throw Object.assign(new Error('Repository base cannot be resolved independently'), { kind: 'policy', source: 'github' })
    let observed: { ref: string; sha: string; repositoryId: number }
    try { observed = await this.clients.repositoryBase(repository, this.baseSelection === 'explicit' ? this.baseRef : undefined) }
    catch (e) { if (e instanceof Error) Object.assign(e, { source: 'github' }); throw e }
    if (this.genStale(gen)) return false
    if (!observed.ref || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(observed.sha) ||
      !Number.isSafeInteger(observed.repositoryId) || observed.repositoryId <= 0 ||
      (this.baseRepositoryId !== null && this.baseRepositoryId !== observed.repositoryId)) {
      throw Object.assign(new Error('Repository/base identity changed or is unverified; no execution was dispatched'), { kind: 'policy', source: 'github' })
    }
    const changed = this.baseSha !== null && (this.baseRef !== observed.ref || this.baseSha !== observed.sha)
    const unboundApproval = beforeExecution && this.baseSha === null
    this.baseRef = observed.ref
    this.baseSha = observed.sha
    this.baseRepositoryId = observed.repositoryId
    if (changed || unboundApproval) {
      this.scopeRevision++
      this.requiresFreshApproval = true
      this.planLabels = []
      this.approvedPlan = []
      this.approvedGoal = ''
      this.buildDraft = null
      this.decisionPending = false
      this.decisionGate = false
      this.queuedStart = null
      this.pendingLeadPosts = this.pendingLeadPosts.filter(p => p.awaiting !== 'plan' || p.soft)
      // A live legacy worker or retained owner turn cannot be rebound to a
      // newly discovered base by Retry. Keep exact identities/text inspectable
      // and require explicit recovery, instead of replaying old instructions.
      if (this.jobs.some(job => this.jobSpawned(job)) || this.pendingLeadPosts.length) {
        this.quarantined = true
        this.paused = true
      } else this.jobs = []
      this.awaiting = 'plan'
      this.planProtocol = 'legacy'
      this.phase = 'plan'
      this.chat('spriite', `Repository base now observed as ${repository}#${observed.ref} at ${observed.sha}. Previous execution approval was not applied; refresh and approve the scope against this base.`)
      this.showNotice('Repository base needs a scope refresh. No worker was launched.', 'Approval not applied', 'idle')
      return false
    }
    return true
  }

  private async requireExecutionBase(gen: number): Promise<void> {
    const revision = this.scopeRevision
    if (this.quarantined || !await this.freezeRepositoryBase(true) ||
      this.genStale(gen) || this.scopeRevision !== revision || this.quarantined) {
      throw Object.assign(new Error('Repository base or approved scope requires recovery; no execution was dispatched'), { kind: 'policy', source: 'github', notDispatched: true })
    }
  }

  /** Create the lead session and ask for the milestone (or job) plan. */
  private async startPlanning(): Promise<void> {
    if (this.quarantined) return
    if (this.busy) return
    if (this.sessionId) {
      // A definitely rejected first turn owns an existing lead. Retry that
      // turn, not session creation, and never replay an unresolved receipt.
      const initial = this.initialPlanTurn
      if (this.phase === 'plan' && !this.planLabels.length && !this.activeDelivery() &&
        initial?.sessionId === this.sessionId && initial.state === 'unsent' && initial.text) {
        this.busy = true
        const gen = this.generation
        try {
          if (!await this.freezeRepositoryBase()) return
          await this.postLead(initial.text, 'plan', false)
        }
        catch (e) { if (!this.genStale(gen)) this.fault(e, e instanceof Error && 'source' in e && e.source === 'github' ? 'github' : 'factory', 'plan') }
        finally { if (!this.genStale(gen)) this.busy = false }
      }
      return
    }
    // Per-idea repositories (C8): a goal that names a GitHub repository builds
    // there; any other goal starts in a new private repository named from the
    // request (the existing New repo path). With the mode 'one' nothing here
    // runs and the configured default applies exactly as before.
    if (this.factoryKey && this.repoMode === 'per_idea' && !this.missionRepo) {
      const named = destinationRepositoryFrom(this.goal)
      if (named !== null) {
        this.missionRepo = named
      } else if (this.goal) {
        this.startNewRepo()
        return
      }
    }
    this.busy = true // held across the awaits so a double save cannot double-start
    const gen = this.generation
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
      if (this.genStale(gen)) return
      if (!computerId) {
        this.emitBlockedPrompt('computer')
        return
      }
      this.blockedStart = null
      // The repository is frozen per mission: a panel save mid-mission never
      // moves a live run onto a different repository.
      this.missionRepo = this.missionRepo || this.repoUrl
      if (!await this.freezeRepositoryBase()) return
      if (this.genStale(gen)) return
      this.phase = 'plan'
      this.emitCurrent() // current activity is not confirmed by a request
      const created = await this.clients.createSession({ computerId, sessionSettings: this.leadSettings() })
      if (this.genStale(gen)) return // a reset restarted this engine mid-create
      this.sessionId = created.sessionId
      this.seenMessageIds.clear()
      if (this.approvedGoal === this.goal && validApprovedPlan(this.approvedPlan)) {
        // A saved, owner-reviewed scope goes directly to execution. The new
        // lead remains a reviewer; it is not asked to generate another plan.
        this.planLabels = [this.goal]
        this.awaiting = null
        this.setStatus('plan', 'submitted')
        this.emitCurrent()
        return
      }
      const text = this.planRequest()
      this.initialPlanTurn = { sessionId: this.sessionId, text, state: 'unsent' }
      await this.postLead(text, 'plan', false)
    } catch (e) {
      // A session CREATE is not re-sendable traffic: unlike a post, the
      // engine has no durable record of a half-landed create, so a blip here
      // must surface as a fault (the card's Retry re-runs the start) instead
      // of parking the mission on a drafting card with nothing pending.
      if (!this.genStale(gen)) this.fault(e, e instanceof Error && 'source' in e && e.source === 'github' ? 'github' : 'factory', 'plan')
    } finally {
      if (!this.genStale(gen)) this.busy = false
    }
  }

  private planRequest(): string {
    this.planProtocol = 'marker-v1'
    const lines = [
      'You are the orchestrator of a software factory run by Spriite for one developer.',
      'You coordinate; you do not edit code.',
      `Mission goal: ${this.goal}`,
      `Repository the worker builds on: ${this.missionRepo}`,
      ...(this.baseSha ? [`Selected base: ${this.baseRef}`, `Frozen base commit: ${this.baseSha}`] : []),
    ]
    if (this.jobCount > 1) {
      lines.push(
        `The work will be split across ${this.jobCount} workers building in parallel, each on its own branch.`,
        `Reply with 2 to ${this.jobCount} numbered lines, each exactly "N. Label", grouping the goal into jobs that can be built independently.`,
      )
    } else {
      lines.push('Reply with a milestone plan: 3 to 5 numbered lines, each exactly "N. Label - what done means".')
    }
    lines.push('After ALL numbered plan lines, end with a final line exactly PLAN_READY. Do not emit PLAN_READY until the complete plan is ready. No other text.')
    lines.push(`Exception: ${this.decisionProtocol()}`)
    return lines.join('\n')
  }

  private needsPlanRefresh(): boolean {
    return this.phase === 'plan' && this.awaiting === 'plan' &&
      this.planProtocol === 'legacy' && this.sessionId !== null && this.jobs.length === 0
  }

  /** Owner-requested migration, never a restore-time send or session CREATE.
   * Reuse retry so runtime pause/cancel/capacity and provider policy gates
   * remain authoritative. A refused send keeps the actionable refresh card.
   */
  private async refreshPlan(): Promise<void> {
    if (!this.needsPlanRefresh() || this.paused || this.busy || this.faultKind || this.pendingLeadDelivery) return
    this.busy = true
    const gen = this.generation
    try {
      if (!await this.freezeRepositoryBase()) return
      await this.postLead(this.planRequest(), 'plan', false)
      if (this.genStale(gen)) return
      this.transient = null
      this.emitCurrent()
    } catch (e) {
      if (this.generation !== gen) return
      this.planProtocol = 'legacy'
      this.lastReply = this.failureNote(e)
      this.emitCurrent()
    } finally {
      if (!this.genStale(gen)) this.busy = false
    }
  }

  /** The question protocol, taught wherever the lead might ask the owner. */
  private decisionProtocol(): string {
    return [
      'When you need the user to decide something, reply DECISION: followed by one short question (under 80 characters),',
      'then a line "OPTIONS:" with 2 to 4 short options separated by | (each under 30 characters),',
      'and wait for the answer instead of continuing.',
    ].join(' ')
  }

  private verdictRequest(job: RealJob): string {
    return [
      `The worker pushed branch "${job.branch}" on ${this.missionRepo}.`,
      `Job: ${job.label}`,
      `Review the diff on that branch against the goal: ${this.goal}`,
      `Base ref: ${this.baseRef}${this.baseSha || job.baseSha ? ` (${this.baseSha || job.baseSha})` : ''}`,
      ...(job.headSha ? [`Review only immutable head commit ${job.headSha}. A moved branch needs a new review.`] : []),
      'Full approved acceptance criteria (all apply, not just the job title):',
      ...(this.approvedPlan.length ? this.approvedPlan : this.planLabels),
      ...(this.lastDecision ? [`Owner's last scope answer: ${this.lastDecision}`] : []),
      ...(this.ownerClarifications.length ? ['Owner clarifications (take precedence):', ...this.ownerClarifications] : []),
      'Reply with VERDICT: PASS or VERDICT: FAIL followed by the key reasons, under 80 words.',
      this.decisionProtocol(),
    ].join('\n')
  }

  private retireLeadQuestion(force = false, request: string | null = null): void {
    if (force || (request && this.queuedLeadQuestion?.verdictToken === request)) this.queuedLeadQuestion = null
    if (!this.decisionGate && this.decisionJob === null &&
      (force || (request && this.leadQuestionRequest === request))) {
      this.decisionPending = false
      this.decisionOptions = []
      this.chatAsked = ''
      this.leadQuestionRequest = null
    }
  }

  private handleReply(text: string, record = true, messageId?: string): void {
    if (this.quarantined) return
    const payload = this.protocolReady(text, this.verdictToken, 'VERDICT_READY')
      ? text.trim().split('\n').slice(0, -2).join('\n') : text
    const questionRequest = /^REQUEST:\s*(\S+)\s*$/im.exec(text)?.[1] ?? null
    const flat = payload.replace(/^REQUEST:\s*\S+\s*$/gim, '').replace(/\s+/g, ' ').trim()
    if (record) this.chat(this.phase === 'attach' ? 'watched' : 'lead', payload)
    if (this.nativeQuestion?.sessionId === this.sessionId) return
    const decision = /^DECISION:\s*/i.exec(flat)
    // A question for the owner never waits in silence: it becomes a decision
    // card the wearer answers by voice (or Confirm). The awaited reply keeps
    // waiting, so the plan/verdict/summary still lands after the answer. Both
    // the protocol prefix and a plain question mark count (agents do not
    // always use the prefix).
    const question = decision
      ? (flat.slice(decision[0].length).trim() || COPY.real.startDecision)
      : flat.endsWith('?')
        ? flat
        : ''
    if (question) {
      if (questionRequest && questionRequest !== this.verdictToken) return
      // A lead observation must not steal the answer to a worker's question.
      const parsed = parseQuestion(flat)
      if (this.decisionPending && this.decisionJob !== null) {
        this.queuedLeadQuestion = {
          text: parsed.text || question, options: parsed.options,
          awaiting: this.awaiting, verdictToken: questionRequest,
          messageId,
        }
        this.emitCurrent()
        return
      }
      // Options ride the protocol ("OPTIONS: one | two") or the question
      // itself ("Postgres or SQLite?"): with two or more, the HUD shows the
      // chat-style option list plus the speak-another-answer row.
      this.lastReply = fitUtterance(hudReply(flat))
      this.decisionText = parsed.text || question
      this.nativeQuestion = null
      this.chatAsked = this.decisionText
      this.decisionOptions = parsed.options
      this.decisionGate = false
      this.decisionJob = null
      this.leadQuestionRequest = questionRequest
      this.plainQuestionMessageId = messageId ?? null
      this.decisionKind = 'build'
      this.decisionPending = true
      this.emitCurrent() // the option list (or the decision card) asks the wearer
      return
    }
    switch (this.awaiting) {
      case 'plan': {
        // A streaming response can contain a valid numbered prefix. Only the
        // explicit final marker proves the complete plan has been emitted.
        // Status is deliberately irrelevant (the service may always say idle).
        const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
        if (lines.at(-1) !== 'PLAN_READY') {
          if (this.planProtocol === 'legacy') {
            this.lastReply = fitUtterance(hudReply(flat))
            this.emitCurrent()
          } else this.emitLeadNote(flat)
          return
        }
        const labels: string[] = []
        for (const line of lines.slice(0, -1)) {
          const m = /^(\d+)[.)]\s*(.+)$/.exec(line)
          if (!m || Number(m[1]) !== labels.length + 1) {
            this.emitLeadNote(flat)
            return
          }
          labels.push(m[2].trim())
        }
        if (labels.length < 1) {
          this.emitLeadNote(flat)
          return
        }
        this.awaiting = null
        this.planLabels = labels
        this.retireLeadQuestion(true)
        this.setStatus('plan', 'accepted')
        this.showWorkerQuestion()
        this.lastReply = fitUtterance(hudReply(flat))
        this.emitCurrent()
        return
      }
      case 'verdict': {
        const v = /^VERDICT:\s*(PASS|FAIL)\b/i.exec(flat)
        if (!v || !this.protocolReady(text, this.verdictToken, 'VERDICT_READY')) {
          this.emitLeadNote(flat)
          return
        }
        this.retireLeadQuestion(false, this.verdictToken)
        this.awaiting = null
        this.lastReply = fitUtterance(hudReply(flat))
        const index = this.verdictJob
        this.verdictJob = null
        this.verdictToken = null
        if (v && v[1].toUpperCase() === 'PASS') {
          this.acceptJob(index)
          this.showWorkerQuestion()
          return
        }
        this.failJob(index, flat)
        this.showWorkerQuestion()
        return
      }
      case 'summary': {
        this.awaiting = null
        this.finalSummary = fitUtterance(hudReply(flat))
        this.lastReply = this.finalSummary
        this.chat('lead', flat)
        this.showWorkerQuestion()
        this.emitCurrent()
        return
      }
      default: {
        // The lead said something the plan is not waiting on: show it, so
        // the conversation comes back instead of hiding behind Explain.
        this.emitLeadNote(flat)
        return
      }
    }
  }

  /**
   * A lead note (a reply with nothing awaited): a card for eight seconds,
   * then the mission card returns. Never mistaken for an awaited reply.
   */
  private emitLeadNote(raw: string, who: ChatWho = this.phase === 'attach' ? 'watched' : 'lead'): void {
    // The HUD shows the reply, never its protocol markers (SUMMARY:, BRANCH:).
    const flat = hudReply(raw)
    this.lastReply = fitUtterance(flat)
    this.emitTransientScene(
      this.scene('status_answer', {
        // The card carries the first lines; the full text lives in the chat
        // log (readable again from the History action — cards do not hold it).
        // MotionLab "Talking": a reply, read aloud when spoken replies are on.
        pose: 'talking', utterance: fitUtterance(flat, 2),
        statusNote: COPY.real.repliedStatus(SPEAKER_LABEL[who]),
        actions: this.canReviewChatBuild() ? COPY.real.scopeAvailableActions : COPY.real.repliedActions,
        speaker: who,
        transientMs: MS(8),
      }),
      MS(8),
    )
  }

  // ------------------------------------------------------------- the jobs

  private createJobs(): RealJob[] {
    const labels = this.planLabels.length > 0 ? this.planLabels : [`Deliver: ${this.goal}`]
    const count = Math.min(this.jobCount, Math.max(1, labels.length))
    const modes = this.jobModes(count)
    const base = Math.floor(65 / count)
    const bump = 65 - base * count
    // Contiguous partitions cover the complete plan, including done criteria.
    return Array.from({ length: count }, (_, i) => ({
      label: labels.slice(Math.floor(i * labels.length / count), Math.floor((i + 1) * labels.length / count)).join('\n'),
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
      pendingPrompt: null,
    }))
  }

  private buildMilestones(jobs: RealJob[]): RealMilestone[] {
    return [
      { id: 'plan', label: 'Plan', weight: 20, status: 'accepted' },
      ...jobs.map((j, i) => ({ id: `job_${i}`, label: jobTitle(j.label), weight: j.weight, status: 'pending' as const })),
      { id: 'pr', label: 'PR', weight: 15, status: 'pending' },
    ]
  }

  private replyFormat(job: RealJob): string[] {
    return job.mode === 'session'
      ? ['When done, reply with exactly these lines:', 'SUMMARY: <one sentence>', job.stage === 'pr' ? 'PR: <pull request URL>' : 'BRANCH: <branch name>', `If blocked, ${this.decisionProtocol()}`]
      : ['When done, reply with a short summary of what you changed.']
  }

  private missionBranch(name: string): string {
    // Runtime IDs are stable; legacy missions use their persisted lead ID.
    const id = (this.missionId || this.sessionId || 'legacy').replace(/[^a-zA-Z0-9_-]/g, '-')
    return `spriite/${id}/${name}`
  }

  private jobBuildPrompt(job: RealJob, index: number, total: number): string {
    return [
      'You are the execution worker. Implement the authorized outcome, not another proposal.',
      `Mission goal: ${this.goal}`,
      `Your job (job ${index + 1} of ${total}): ${job.label}`,
      `Implement it on the repository ${this.missionRepo}.`,
      `Start from the selected base ref "${this.baseRef}". Do not change the base or default branch.`,
      ...(this.baseSha ? [`Use frozen base commit ${this.baseSha}; if the ref moved, ask rather than silently rebasing.`] : []),
      ...(this.approvedPlan.length
        ? ['Owner-approved plan and done-means criteria:', ...this.approvedPlan]
        : ['Overall approved plan (implement only your assigned job above):', ...this.planLabels]),
      ...(this.lastDecision ? [`Owner's last scope answer: ${this.lastDecision}`] : []),
      ...(this.ownerClarifications.length ? ['Owner clarifications (take precedence over earlier plans):', ...this.ownerClarifications] : []),
      'If the reference is unavailable or the plan conflicts with an owner clarification, ask a concrete question before changing scope. Do not guess.',
      `Push your work to a new branch named ${this.missionBranch(`job-${index + 1}`)}. Do not open a pull request.`,
      ...this.replyFormat(job),
    ].join('\n')
  }

  private jobFixPrompt(job: RealJob): string {
    return [
      'The review failed. Findings:',
      this.failReason || 'The reviewer rejected the change.',
      'Fix the findings. Push to your branch. Do not open a pull request.',
      `Use the branch named ${job.branch}.`,
      ...(job.mode === 'session'
        ? ['Reply with SUMMARY: and BRANCH: lines as before.']
        : ['Reply with a short summary of what you changed.']),
    ].join('\n')
  }

  private integrationPrompt(job: RealJob, branches: string[]): string {
    return [
      `Mission goal: ${this.goal}`,
      `All jobs passed review. Merge these branches into one new branch named ${this.missionBranch('integration')}:`,
      ...branches.map((b) => `- ${b}`),
      `Repository: ${this.missionRepo}. Resolve conflicts; keep every feature.`,
      `Use the selected base ref "${this.baseRef}". Do not change the base or default branch.`,
      ...(this.baseSha ? [`Frozen base commit: ${this.baseSha}.`] : []),
      'Push the integration branch. Do not open a pull request.',
      ...this.replyFormat(job),
    ].join('\n')
  }

  private prPrompt(job: RealJob): string {
    const branch = job.branch
    const lines = [
      'The review passed.',
      `Open a pull request from branch "${branch}" to the ${this.baseRef} branch on ${this.missionRepo}.`,
      ...(this.baseSha ? [`Frozen approved base commit: ${this.baseSha}. Do not substitute a moved base.`] : []),
    ]
    if (job.mode === 'session') {
      lines.push('Reply with exactly these lines:', 'SUMMARY: <one sentence>', 'PR: <the pull request URL>')
    } else {
      lines.push('Reply with the pull request URL.')
    }
    return lines.join('\n')
  }

  /** Spawn a brand-new worker for a job (build stage only). */
  private async spawnJob(job: RealJob, promptText: string, gen: number): Promise<void> {
    await this.requireExecutionBase(gen)
    if (job.mode === 'session') promptText = this.workerRequest(job, promptText)
    if (job.mode === 'cursor') {
      // A retry after a failed first run reuses the agent already created:
      // a second agent would orphan the first, building untracked and
      // beyond the reach of Restart's cancel.
      if (job.agentId) {
        job.runId = (await this.clients.cursorRun(job.agentId, promptText)).runId
      } else {
        const created = await this.clients.cursorAgent(promptText, this.missionRepo)
        if (this.genStale(gen)) return
        job.agentId = created.agentId
        if (created.runId) {
          job.runId = created.runId
        } else {
          job.runId = (await this.clients.cursorRun(job.agentId, promptText)).runId
        }
      }
      if (this.genStale(gen)) return
      job.runStatus = 'RUNNING'
    } else {
      // Factory plays the worker too: a session on the user's own computer,
      // separate from the lead so builder and reviewer differ. The dedicated
      // seam lets a wrapping runtime gate worker spawns by capacity while the
      // lead conversation is exempt (spec §14).
      const spawn = this.clients.createWorkerSession ?? this.clients.createSession
      if (!this.resolvedComputerId) throw Object.assign(new Error('Saved mission computer is unknown. Inspect its exact Factory session before launching work.'), { kind: 'policy' })
      const created = await spawn.call(
        this.clients,
        { computerId: this.resolvedComputerId, sessionSettings: this.workerSettings() },
      )
      if (this.genStale(gen)) return
      job.sessionId = created.sessionId
      job.count = 0
      job.lastCount = 0
      job.seenIds = []
      job.pendingPrompt = promptText
      try {
        await this.postWorkerPrompt(job, promptText, 'build')
        if (this.genStale(gen)) return
        job.pendingPrompt = null
      } catch (e) {
        if (!this.isBlip(e)) throw e
        job.pendingPrompt = promptText // the tick re-sends it
      }
    }
    job.state = 'building'
    job.nextPoll = 0
  }

  /** Send a follow-up prompt to a job's existing worker (fix, integrate, PR). */
  private async runJobPrompt(job: RealJob, promptText: string, gen: number, stage = job.stage): Promise<void> {
    await this.requireExecutionBase(gen)
    job.executionObserved = false
    if (job.mode === 'session') promptText = this.workerRequest(job, promptText)
    if (job.mode === 'cursor') {
      if (!job.agentId) throw new Error('no worker agent')
      const run = await this.clients.cursorRun(job.agentId, promptText)
      if (this.genStale(gen)) return
      job.runId = run.runId
      job.runStatus = 'RUNNING'
    } else {
      if (!job.sessionId) throw new Error('no worker session')
      try {
        await this.postWorkerPrompt(job, promptText, stage)
        if (this.genStale(gen)) return
        job.pendingPrompt = null
      } catch (e) {
        if (!this.isBlip(e)) throw e
        job.pendingPrompt = promptText // the tick re-sends it
      }
    }
    job.state = 'building'
    job.nextPoll = 0
  }

  private async postWorkerPrompt(job: RealJob, text: string, stage: RealJob['stage']): Promise<void> {
    if (this.quarantined) throw Object.assign(new Error('Saved execution is quarantined; no worker turn was dispatched'), { kind: 'policy', notDispatched: true })
    if (job.sessionId) this.activity.delete(job.sessionId)
    if (!job.sessionId) throw new Error('no worker session')
    if (this.deliveryAttempts.has(job.sessionId)) return
    const gen = this.generation
    const revision = this.scopeRevision
    const sessionId = job.sessionId
    const resultQuery = this.isResultQuery(job, text)
    // Reporting the existing task does not authorize another execution
    // stage. Its ordinary POST still crosses the final coordinator gate.
    if (!resultQuery) await this.requireExecutionBase(gen)
    const messages = await this.clients.getMessages(sessionId, this.computerFor(sessionId))
    if (this.genStale(gen)) return
    this.observeNativeQuestions(messages, sessionId, job)
    if (!factoryHistoryComplete(messages) || job.question?.native) {
      this.retainDraft(sessionId, text)
      throw Object.assign(new Error('Worker attention/history requires an exact Factory handoff; nothing sent'), { kind: 'policy' })
    }
    if (this.paused || this.quarantined || this.scopeRevision !== revision) throw Object.assign(new Error('Execution scope changed before dispatch'), { kind: 'policy', notDispatched: true })
    const attempt = this.beginDelivery(sessionId, text, messages.length <= 2000 ? messages.map(m => m.id) : null)
    let dispatched = false
    try {
      if (this.beforeSessionDispatch) {
        await this.beforeSessionDispatch()
        if (this.deliveryAttempts.get(sessionId) !== attempt) return
        if (this.genStale(gen)) { this.finishDelivery(attempt); return }
        if (this.paused) throw Object.assign(new Error('Execution paused before dispatch'), { kind: 'policy' })
      }
      if (this.paused || this.quarantined || this.scopeRevision !== revision || job.question?.native) throw Object.assign(new Error('Execution authority changed before dispatch'), { kind: 'policy', notDispatched: true })
      dispatched = true
      if (!resultQuery && this.clients.postWorkerExecution) {
        await this.clients.postWorkerExecution(sessionId, text, stage, this.computerFor(sessionId))
      } else await this.clients.postMessage(sessionId, text, this.computerFor(sessionId))
      // Persist the acknowledged outcome without leaving a stale unsent
      // query/instruction in the snapshot emitted by finishDelivery.
      if (job.pendingPrompt === text) job.pendingPrompt = null
      this.finishDelivery(attempt)
    } catch (e) {
      if (dispatched && this.isUnconfirmedPost(e)) {
        job.pendingPrompt = null // dispatched, not an unsent retry
        this.emitCurrent()
        return
      }
      this.finishDelivery(attempt)
      throw e
    }
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
    if (this.requiresFreshApproval || this.quarantined || this.paused || this.busy || this.faultKind || this.activeDelivery()) return
    if (this.jobs.length > 0 && this.jobs.every((j) => this.jobSpawned(j) && !j.pendingPrompt)) return // in flight
    this.busy = true
    this.decisionPending = false
    this.queuedStart = null
    const gen = this.generation
    const revision = this.scopeRevision
    try {
      if (this.jobs.length === 0 && !await this.freezeRepositoryBase(true)) return
      if (this.genStale(gen) || this.scopeRevision !== revision || this.paused || this.faultKind || this.decisionPending || this.activeDelivery()) return
      if (this.jobs.length === 0) {
        this.jobs = this.createJobs()
        this.milestones = this.buildMilestones(this.jobs)
      }
      const total = this.jobs.length
      for (let i = 0; i < total; i++) {
        const job = this.jobs[i]
        if (this.jobSpawned(job)) {
          // Reuse the exact unsent request/token, never CREATE another worker
          // or regenerate an instruction that a queued retry already owns.
          if (job.mode === 'session' && job.pendingPrompt && job.requestToken && !job.polling) {
            try {
              await this.postWorkerPrompt(job, job.pendingPrompt, 'build')
              if (this.genStale(gen)) return
              job.pendingPrompt = null
            } catch (e) {
              if (!this.isBlip(e)) throw e
            }
          }
          continue
        }
        await this.spawnJob(this.jobs[i], this.jobBuildPrompt(this.jobs[i], i, total), gen)
        if (this.genStale(gen)) return
      }
      this.phase = 'building'
      this.emitCurrent()
    } catch (e) {
      // A worker spawn is a launch, not re-sendable post traffic: a blip has
      // no durable record here, so it surfaces as a fault (the durable
      // runtime's outbox classifies it as unknown and blocks the retry).
      if (!this.genStale(gen)) {
        const stalled = this.jobs.find((j) => !this.jobSpawned(j))
        this.fault(e, e instanceof Error && 'source' in e && e.source === 'github' ? 'github' : stalled?.mode === 'cursor' ? 'cursor' : 'factory', 'build')
      }
    } finally {
      if (!this.genStale(gen)) this.busy = false
    }
  }

  /**
   * A confirmed step asked while `busy` held the engine: the gate is already
   * consumed, so queue the step for the tick instead of dropping it — the
   * owner answered, the mission must run.
   */
  private startBuildOrQueue(): void {
    if (this.pendingLeadDelivery) return
    if (this.busy || this.faultKind) {
      this.queuedStart = 'build'
      return
    }
    void this.startBuild()
  }

  /**
   * Start a build the owner approved where they asked for it, skipping the
   * Start build card and its confirm. Only from a ready plan that has not
   * started, with no question open: anything else (a lead question, a fault,
   * a pause, a start already queued) keeps its own path. Returns whether it
   * started, so the caller acts once.
   */
  beginApproved(): boolean {
    if (this.requiresFreshApproval || this.quarantined) return false
    if (this.pendingLeadDelivery) return false
    if (this.phase !== 'plan' || this.awaiting === 'plan' || this.planLabels.length === 0 || this.jobs.length > 0) return false
    if (this.decisionPending || this.paused || this.faultKind || this.busy || this.queuedStart) return false
    this.chat('spriite', 'Starting the build you asked for.')
    void this.startBuild()
    return true
  }

  /** The PR stage's queue twin (see startBuildOrQueue). */
  private startPrOrQueue(): void {
    if (this.busy || this.faultKind || this.activeDelivery()) {
      this.queuedStart = 'pr'
      return
    }
    void this.startPrStage()
  }

  /** The tick pumps a queued start once busy clears. */
  private pumpQueuedStart(): void {
    if (!this.queuedStart || this.busy || this.faultKind || this.activeDelivery() || this.paused) return
    const step = this.queuedStart
    this.queuedStart = null
    if (step === 'build') void this.startBuild()
    else if (step === 'pr') void this.startPrStage()
    else if (step === 'integration') void this.startIntegration()
  }

  private async startFixRun(index: number): Promise<void> {
    const job = this.jobs[index]
    if (!job || this.quarantined || this.paused || this.faultKind || (job.sessionId && this.deliveryAttempts.has(job.sessionId))) return
    const gen = this.generation
    try {
      await this.runJobPrompt(job, this.jobFixPrompt(job), gen, 'fix')
      if (this.genStale(gen)) return
      job.awaiting = 'fix'
      job.stage = 'fix'
      this.workerIssue = null
      this.updatePhase()
      this.emitCurrent()
    } catch (e) {
      // A cursor run is a launch; a session prompt blip never reaches here
      // (runJobPrompt parks it as a pending prompt). Fault either way: the
      // fix step has no other retry pump, and a swallowed blip would park the
      // job on a repair card with nothing pending.
      if (!this.genStale(gen)) this.fault(e, e instanceof Error && 'source' in e && e.source === 'github' ? 'github' : job.mode === 'cursor' ? 'cursor' : 'factory', 'fix', index)
    }
  }

  /** All jobs passed: one worker merges the branches into one. */
  private async startIntegration(): Promise<void> {
    if (this.quarantined || this.paused || this.busy || this.faultKind || this.activeDelivery()) return
    // The retry (the fault card, a restart) must merge the SAME branches: the
    // first attempt consumes job 0's branch, so the list cannot be recomputed
    // from the jobs again. Captured before anything is cleared.
    const branches = this.integrating && this.integrationBranches.length > 0
      ? this.integrationBranches
      : this.jobs.map((j) => j.branch).filter(Boolean)
    if (branches.length === 0) return
    const job = this.jobs[0]
    if (!job) return
    this.busy = true
    this.integrating = true
    this.integrationBranches = branches
    const gen = this.generation
    try {
      job.stage = 'integration'
      job.branch = ''
      await this.runJobPrompt(job, this.integrationPrompt(job, branches), gen)
      if (this.genStale(gen)) return
      this.setStatus('pr', 'submitted')
      this.updatePhase()
      this.emitCurrent()
    } catch (e) {
      // See startFixRun: an integration launch blip must surface, never park
      // the mission on an integration card with nothing pending.
      if (!this.genStale(gen)) this.fault(e, e instanceof Error && 'source' in e && e.source === 'github' ? 'github' : job.mode === 'cursor' ? 'cursor' : 'factory', 'integration')
    } finally {
      if (!this.genStale(gen)) this.busy = false
    }
  }

  /** Ask before the worker opens the PR, or open it now (a preference). */
  private askPrOrOpen(): void {
    if (this.askBeforePr) {
      this.decisionKind = 'pr'
      this.decisionJob = null
      this.decisionGate = true
      this.decisionText = COPY.real.prAsk
      this.decisionOptions = [] // the gate is its own yes card
      this.decisionPending = true
      this.emitCurrent()
      return
    }
    this.startPrOrQueue()
  }

  private async startPrStage(): Promise<void> {
    if (this.quarantined || this.paused || this.busy || this.faultKind || this.activeDelivery()) return
    const job = this.jobs[0]
    if (!job || !(job.mode === 'cursor' ? job.agentId : job.sessionId)) return
    this.busy = true
    const gen = this.generation
    this.emitTransientScene(
      this.scene('accepted', {
        pose: 'accepted', utterance: COPY.real.verified,
        actions: COPY.real.beatActions, evidence: this.evidenceIds(),
        transientMs: MS(6),
      }),
      MS(6),
    )
    try {
      if (this.clients.branchEvidence) {
        const repo = this.githubRepository(this.missionRepo)
        if (!repo || !job.headSha) throw new Error('PR requires an independently reviewed commit')
        const evidence = await this.clients.branchEvidence(repo, job.branch, this.baseRef)
        if (this.genStale(gen)) return
        if (evidence.headSha !== job.headSha || evidence.baseSha !== job.baseSha) {
          throw new Error('Reviewed base/head moved; a new review is required before a PR')
        }
      }
      job.stage = 'pr'
      await this.runJobPrompt(job, this.prPrompt(job), gen)
      if (this.genStale(gen)) return
      this.setStatus('pr', 'submitted')
      this.phase = 'pr'
    } catch (e) {
      // See startFixRun: a PR-stage launch blip must surface, never park the
      // mission right after the verified card.
      if (!this.genStale(gen)) this.fault(e, e instanceof Error && 'source' in e && e.source === 'github' ? 'github' : job.mode === 'cursor' ? 'cursor' : 'factory', 'pr')
    } finally {
      if (!this.genStale(gen)) this.busy = false
    }
  }

  /** A job's branch (or the integration branch) is ready: queue it for the
   *  lead's verdict; verdicts stay sequential so replies stay parseable. */
  private queueForReview(job: RealJob): void {
    if (this.clients.branchEvidence) {
      const gen = this.generation
      const branch = job.branch
      const previousHead = job.headSha
      job.state = 'queued'
      void (async () => {
        try {
          const repo = this.githubRepository(this.missionRepo)
          if (!repo) throw new Error('Worker repository is not independently resolvable')
          const evidence = await this.clients.branchEvidence!(repo, branch, this.baseRef)
          if (this.genStale(gen) || job.branch !== branch) return
          if (job.stage === 'fix' && evidence.headSha === previousHead) throw new Error('Repair returned the unchanged reviewed commit')
          if (this.baseSha && evidence.baseSha !== this.baseSha) throw new Error('Selected base moved after approval; a scope refresh is required')
          job.headSha = evidence.headSha
          job.baseSha = evidence.baseSha
          this.enqueueVerifiedReview(job)
        } catch (e) {
          if (this.genStale(gen)) return
          job.state = 'stopped'
          this.workerIssue = 'Branch evidence could not be verified. Inspect the exact repository and commit in GitHub.'
          this.failReason = e instanceof Error ? e.message : 'Branch evidence unavailable'
          this.emitCurrent()
        }
      })()
      return
    }
    // Retained injectable clients predating the evidence seam remain readable;
    // production liveClients always supplies independent GitHub reads.
    this.enqueueVerifiedReview(job)
  }

  private enqueueVerifiedReview(job: RealJob): void {
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
    this.verdictToken = crypto.randomUUID()
    this.updatePhase()
    this.emitCurrent()
    void this.postVerdictRequest(job)
  }

  private async postVerdictRequest(job: RealJob): Promise<void> {
    if (!this.sessionId) return
    const gen = this.generation
    try {
      if (this.clients.branchEvidence) {
        const repo = this.githubRepository(this.missionRepo)
        if (!repo) throw new Error('Reviewer repository cannot be resolved independently')
        const evidence = await this.clients.branchEvidence(repo, job.branch, this.baseRef)
        if (this.genStale(gen)) return
        if (this.baseSha && evidence.baseSha !== this.baseSha) throw new Error('Selected base moved; the approved review scope is stale')
        if (job.headSha !== evidence.headSha || job.baseSha !== evidence.baseSha) {
          this.verdictToken = crypto.randomUUID()
        }
        job.headSha = evidence.headSha
        job.baseSha = evidence.baseSha
      }
      this.verdictToken ??= crypto.randomUUID()
      await this.postLead(this.verdictRequest(job) + '\n' + this.protocolInstructions(this.verdictToken, 'VERDICT_READY'), 'verdict', false)
    } catch (e) {
      const index = this.jobs.indexOf(job)
      if (!this.genStale(gen) && !this.isBlip(e)) this.fault(e, 'factory', 'verdict', index >= 0 ? index : undefined)
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
    // The lead is free again: other finished jobs must not wait on this
    // job's repair round-trip (one verdict in flight still holds).
    this.dequeueNextReview()
  }

  // ---------------------------------------------------------- worker side

  private resultQueryBody(job: RealJob): string {
    return `Report the result of your existing ${job.stage} task. Do not repeat work, create another branch, or open another PR. If the task is still running, wait for its result. Reply with SUMMARY: and ${job.stage === 'pr' ? 'PR:' : 'BRANCH:'} lines for that existing result.`
  }

  private isResultQuery(job: RealJob, text: string | null): boolean {
    return !!job.requestToken && text === `${this.resultQueryBody(job)}\n${this.protocolInstructions(job.requestToken, 'WORK_READY')}`
  }

  private needsResponseRefresh(): boolean {
    return ((this.awaiting === 'verdict' || this.verdictJob !== null) && !this.verdictToken) ||
      this.jobs.some((job) => job.mode === 'session' && job.state === 'building' && !!job.sessionId &&
        (!job.requestToken || this.isResultQuery(job, job.pendingPrompt)))
  }

  /** Owner-requested format migration: report existing work, never recreate it. */
  private async refreshResponses(): Promise<void> {
    if (this.paused || this.busy || this.faultKind || this.activeDelivery() || !this.needsResponseRefresh()) return
    this.busy = true
    const gen = this.generation
    try {
      if ((this.awaiting === 'verdict' || this.verdictJob !== null) && !this.verdictToken) {
        const job = this.verdictJob !== null ? this.jobs[this.verdictJob] : undefined
        if (job) {
          this.pendingLeadPosts = this.pendingLeadPosts.filter((p) => p.awaiting !== 'verdict')
          await this.postVerdictRequest(job)
          if (this.genStale(gen)) return
        }
      }
      for (const job of this.jobs) {
        if (this.paused || this.genStale(gen)) return
        if (job.mode !== 'session' || job.state !== 'building' || !job.sessionId ||
          (job.requestToken && !this.isResultQuery(job, job.pendingPrompt))) continue
        // Only ask for the result of the existing task. In particular, never
        // send the old build/merge/open-PR instruction again during migration.
        const prompt = this.isResultQuery(job, job.pendingPrompt)
          ? job.pendingPrompt! : this.workerRequest(job, this.resultQueryBody(job))
        // Before any persistence hook runs, token and full pending text must
        // describe the same query, never the old build/PR instruction.
        job.pendingPrompt = prompt
        try {
          await this.postWorkerPrompt(job, prompt, job.stage)
          if (this.genStale(gen)) return
          job.pendingPrompt = null
        } catch (e) {
          if (this.genStale(gen)) return
          job.pendingPrompt = prompt
          if (e instanceof Error && 'kind' in e &&
            ['policy', 'paused', 'cancelling', 'terminal', 'capacity'].includes(String(e.kind))) {
            // A definite local refusal is still an owner-requested refresh,
            // not an execution retry or a provider fault. Keep its exact token
            // and text actionable without opening the automatic retry pump.
            this.emitCurrent()
            return
          }
          if (!this.isReadBlip(e)) throw e
        }
      }
      this.emitCurrent()
    } catch (e) {
      if (!this.genStale(gen)) this.fault(e, 'factory')
    } finally {
      if (!this.genStale(gen)) this.busy = false
    }
  }

  private protocolInstructions(token: string, marker: string): string {
    return `For this request only, append a line exactly "REQUEST: ${token}" and then a final line exactly ${marker}. If blocked, include that REQUEST line with your question but do not emit the final marker. Emit the final marker only after the complete result. Never repeat a previous request token.`
  }

  private protocolReady(text: string, token: string | null | undefined, marker: string): boolean {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
    return !!token && lines.at(-1) === marker && lines.at(-2) === `REQUEST: ${token}`
  }

  private workerRequest(job: RealJob, prompt: string): string {
    job.requestToken = crypto.randomUUID()
    return prompt + '\n' + this.protocolInstructions(job.requestToken, 'WORK_READY')
  }

  /** Parse a session worker's structured reply and route it by stage. */
  private handleWorkerReply(job: RealJob, text: string, record = true, messageId?: string): void {
    if (record) this.chat('worker', text)
    if (job.question?.native) return
    const flat = text.replace(/^REQUEST:\s*\S+\s*$/gim, '').replace(/\s+/g, ' ').trim()
    if (/^DECISION:\s*/i.test(flat) || flat.endsWith('?')) {
      const request = /^REQUEST:\s*(\S+)\s*$/im.exec(text)?.[1]
      if (request && request !== job.requestToken) return
      const parsed = parseQuestion(flat)
      job.question = { text: parsed.text || flat.replace(/^DECISION:\s*/i, ''), options: parsed.options, messageId }
      this.chatAsked = job.question.text
      if (this.decisionPending && this.decisionJob === this.jobs.indexOf(job)) {
        this.nativeQuestion = null
        this.decisionText = job.question.text
        this.decisionOptions = [...job.question.options]
        this.emitCurrent()
        return
      }
      this.showWorkerQuestion()
      return
    }
    if (!this.protocolReady(text, job.requestToken, 'WORK_READY')) {
      this.emitLeadNote(readableReply(text), 'worker')
      return
    }
    const branch = /^BRANCH:\s*(\S+)\s*$/im.exec(text)?.[1] ?? ''
    const prUrl = /^PR:\s*(https?:\/\/\S+)\s*$/im.exec(text)?.[1] ?? ''
    const summary = /^SUMMARY:\s*(.+)$/im.exec(text)?.[1] ?? ''
    // Never retain a rejected PR payload: URLs can contain credentials.
    if (job.stage === 'pr' && (!summary || !job.branch || !this.validPrUrl(prUrl))) {
      // The reply is already seen, so it never re-fires: stop the job and
      // surface the repair card instead of leaving a silent 'building' card.
      this.lastReply = COPY.real.workerNoPr
      this.failReason = COPY.real.workerNoPr
      this.workerIssue = COPY.real.workerNoPr
      job.state = 'stopped'
      this.emitCurrent()
      return
    }
    if (!summary || (job.stage === 'pr' ? !prUrl : !branch)) {
      this.lastReply = fitUtterance(hudReply(text))
      this.emitCurrent()
      return
    }
    this.lastReply = fitUtterance(summary)
    job.question = null
    if (this.decisionJob === this.jobs.indexOf(job)) {
      this.decisionPending = false
      this.decisionJob = null
      this.chatAsked = ''
      this.showWorkerQuestion()
    }
    const gen = this.generation // handleWorkerReply runs inside a guarded poll
    if (job.stage === 'pr') {
      if (prUrl) {
        job.state = 'accepted' // delivered: stop polling this worker
        void this.finishPr(prUrl, gen, job)
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

  private showWorkerQuestion(): void {
    if (this.decisionPending) return
    const lead = this.queuedLeadQuestion
    this.queuedLeadQuestion = null
    if (lead && (lead.verdictToken === null || (lead.awaiting === this.awaiting && lead.verdictToken === this.verdictToken))) {
      this.decisionText = lead.text
      this.nativeQuestion = lead.native ?? null
      this.decisionOptions = [...lead.options]
      this.decisionGate = false
      this.decisionJob = null
      this.leadQuestionRequest = lead.verdictToken
      this.plainQuestionMessageId = lead.messageId ?? null
      this.decisionKind = 'build'
      this.decisionPending = true
      this.emitCurrent()
      return
    }
    const index = this.jobs.findIndex((job) => job.question)
    if (index < 0) return
    const question = this.jobs[index].question!
    this.decisionJob = index
    this.decisionText = question.text
    this.nativeQuestion = question.native ?? null
    this.decisionOptions = [...question.options]
    this.decisionKind = 'build'
    this.decisionGate = false
    this.decisionPending = true
    this.transient = null
    this.emitCurrent()
  }

  private async handleRunDone(job: RealJob, run: CursorRunState, gen: number): Promise<void> {
    job.runStatus = ''
    if (job.stage === 'pr') {
      // The PR must be attached to the already-reviewed branch in ONE entry;
      // unrelated branch/PR entries are not combinable delivery evidence.
      const repo = this.githubRepository(this.missionRepo)
      const prUrl = run.branches.find((b) => !!job.branch && b.branch === job.branch &&
        repo !== null && this.githubRepository(b.repoUrl) === repo &&
        !!b.prUrl && this.validPrUrl(b.prUrl))?.prUrl
      if (prUrl) {
        job.state = 'accepted' // delivered: stop polling this worker
        await this.finishPr(prUrl, gen, job)
        return
      }
      this.failReason = COPY.real.workerNoPr
      this.workerIssue = COPY.real.workerNoPr
      job.state = 'stopped'
      this.emitCurrent()
      return
    }
    const repo = this.githubRepository(this.missionRepo)
    const branch = run.branches.find(b => b.branch && repo !== null &&
      this.githubRepository(b.repoUrl) === repo)?.branch ?? ''
    if (branch) job.branch = branch
    // build or fix finished: hand the branch to the lead for review
    if (!branch) {
      this.failReason = run.text
      this.workerIssue = /(?:\?\s*$|^DECISION:)/i.test(run.text?.trim() ?? '')
        ? 'Cursor needs an answer. Open the exact agent in Cursor; answering here is unavailable.'
        : COPY.real.workerNoBranch
      if (this.workerIssue !== COPY.real.workerNoBranch) {
        this.chat('worker', run.text)
        this.chat('spriite', `Cursor handoff: agent ${job.agentId ?? 'unknown'}, run ${job.runId ?? 'unknown'}. No supported answer transport is established; no new run was launched.`)
      }
      job.state = 'stopped'
      this.emitCurrent()
      return
    }
    this.queueForReview(job)
  }

  /** GitHub names are case-insensitive; clone URLs may carry a .git suffix. */
  private githubRepository(raw: string): string | null {
    try {
      const url = new URL(raw)
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port ||
        url.username || url.password) return null
      const match = /^\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname)
      return match ? `${match[1]}/${match[2].replace(/\.git$/i, '')}`.toLowerCase() : null
    } catch {
      return null
    }
  }

  private validPrUrl(raw: string): boolean {
    try {
      const url = new URL(raw)
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port ||
        url.username || url.password) return false
      const match = /^\/([^/]+)\/([^/]+)\/pull\/[1-9]\d*\/?$/.exec(url.pathname)
      const repo = this.githubRepository(this.missionRepo)
      return !!match && repo !== null && `${match[1]}/${match[2]}`.toLowerCase() === repo
    } catch {
      return false
    }
  }

  private handleRunFailed(job: RealJob, run: CursorRunState): void {
    job.runStatus = ''
    this.failReason = run.text
    this.workerIssue = COPY.real.workerFailed
    job.state = 'stopped'
    this.emitCurrent()
  }

  private async finishPr(prUrl: string, gen: number, job?: RealJob): Promise<void> {
    if (this.clients.pullEvidence) {
      try {
        const repo = this.githubRepository(this.missionRepo)
        const number = Number(new URL(prUrl).pathname.match(/\/pull\/(\d+)\/?$/)?.[1])
        if (!repo || !job?.headSha || !number) throw new Error('PR has no immutable reviewed commit')
        await this.clients.pullEvidence(repo, number, job.branch, this.baseRef, job.headSha, this.baseSha ?? job.baseSha)
        if (this.genStale(gen)) return
      } catch (e) {
        if (this.genStale(gen)) return
        if (job) job.state = 'stopped'
        this.workerIssue = 'Pull request evidence does not match the reviewed repository/base/head.'
        this.failReason = e instanceof Error ? e.message : 'PR evidence unavailable'
        this.emitCurrent()
        return
      }
    }
    this.prUrl = prUrl
    this.setStatus('pr', 'accepted')
    this.phase = 'final'
    this.emitCurrent()
    await this.postPrSummary(gen)
  }

  /** Ask the lead for the final one-sentence summary (after the PR opens). */
  private async postPrSummary(gen: number = this.generation): Promise<void> {
    if (!this.sessionId) return
    try {
      await this.postLead(
        [
          `The pull request is open: ${this.prUrl}`,
          'Reply with SUMMARY: one sentence on what was delivered.',
        ].join('\n'),
        'summary',
        false,
      )
    } catch (e) {
      if (!this.genStale(gen) && !this.isBlip(e)) this.fault(e, 'factory', 'summary')
    }
  }

  // ----------------------------------------------------------- engine I/O

  handleAction(id: string): void {
    if (this.activeDelivery() && ['confirm_chat_build', 'continue_session', 'retry', 'begin', 'use_it', 'open_pr', 'start_planning', 'new_repo'].includes(id)) {
      this.transient = null
      this.emitCurrent()
      return
    }
    switch (id) {
      case 'show_builds':
        this.showHome()
        return
      case 'review_chat_build':
        void this.prepareChatBuild()
        return
      case 'confirm_chat_build':
        // A foreign watch is handed off ONLY by the durable RuntimeEngine.
        if (this.phase !== 'attach') void this.confirmOwnedChatBuild()
        return
      case 'continue_session':
        if (this.canReviewChatBuild()) {
          void this.prepareChatBuild()
        } else if (this.canContinueSession()) {
          void this.postSteer(COPY.real.continueMessage, true, this.needsPlanRefresh())
        }
        return
      case 'check_delivery':
        void this.pollLead()
        for (const job of this.jobs) if (job.sessionId && this.deliveryAttempts.has(job.sessionId)) void this.pollJob(job)
        return
      case 'resolve_delivery':
        if (this.receiptState?.().blocked) return
        if (this.activeDelivery()) {
          this.overlay = 'delivery'
          this.emitCurrent()
        }
        return
      case 'delivery_seen': {
        if (this.receiptState?.().blocked) return
        const attempt = this.activeDelivery()
        if (attempt && this.overlay === 'delivery') {
          const text = attempt.text
          this.finishDelivery(attempt)
          this.pendingLeadDelivery = null
          this.pendingLeadPosts = this.pendingLeadPosts.filter(p => p.text !== text)
          this.lastSteer = ''
          this.overlay = null
          this.chat('you', 'I checked the Factory chat and marked this request received. Nothing was resent.')
          this.emitCurrent()
        }
        return
      }
      case 'delivery_release': {
        if (this.receiptState?.().blocked) return
        const attempt = this.activeDelivery()
        if (attempt && this.overlay === 'delivery') {
          this.finishDelivery(attempt)
          this.pendingLeadDelivery = null
          this.pendingLeadPosts = []
          this.queuedStart = null
          this.lastSteer = ''
          this.overlay = null
          this.transient = null
          if (this.phase === 'plan' && this.awaiting === 'plan') this.planProtocol = 'legacy'
          this.chat('you', 'I stopped waiting for delivery. The request may still arrive. Queued requests here were cleared; nothing was resent.')
          this.emitCurrent()
        }
        return
      }
      case 'open_factory':
        if (this.factorySessionLink()) {
          this.emitTransientScene(this.scene('status_answer', {
            pose: 'waiting', utterance: this.nativeQuestion ? COPY.real.nativeQuestionHelp : COPY.real.factoryWatchOnlyHelp,
            statusNote: COPY.real.attachWatchOnly, actions: COPY.real.factoryWatchOnlyHelpActions,
            transientMs: MS(8),
          }), MS(8))
        }
        return
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
        if (!this.faultKind && this.needsResponseRefresh()) {
          void this.refreshResponses()
          return
        }
        if (!this.faultKind && this.needsPlanRefresh()) {
          void this.refreshPlan()
          return
        }
        this.retryFault()
        return
      case 'begin':
        // Start build: confirm once; live runs spend credits.
        if (this.phase === 'plan' && this.awaiting !== 'plan' && this.planLabels.length > 0) {
          this.decisionKind = 'build'
          this.decisionJob = null
          this.decisionGate = true
          this.decisionText = COPY.real.startDecision
          this.decisionOptions = [] // the gate is its own yes card
          this.decisionPending = true
          this.emitCurrent()
        }
        return
      case 'use_it': {
        if (this.canConfirmChatBuild()) {
          if (this.phase !== 'attach') void this.confirmOwnedChatBuild()
          return
        }
        if (!this.decisionPending) return
        if (this.decisionGate) {
          const kind = this.decisionKind
          this.decisionPending = false
          this.chatAsked = ''
          this.decisionGate = false
          this.chat('you', kind === 'pr' ? 'Yes, open the PR.' : 'Yes, start the build.')
          if (kind === 'pr') this.startPrOrQueue()
          else {
            if (this.phase !== 'plan' || this.awaiting === 'plan' || !this.planLabels.length) return
            this.requiresFreshApproval = false // explicit approval of THIS ready scope
            this.startBuildOrQueue()
          }
          return
        }
        void this.answerDecision('Yes - proceed with your recommendation.')
        return
      }
      case 'open_pr':
        if (this.decisionPending && this.decisionKind === 'pr') {
          this.decisionPending = false
          this.chatAsked = ''
          this.decisionGate = false
          this.chat('you', 'Yes, open the PR.')
          this.startPrOrQueue()
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
      case 'status':
        this.talkStatus()
        return
      case 'show_evidence':
        this.overlay = 'evidence'
        break
      case 'back':
        if (this.overlay === 'chat_build') this.buildDraft = null
        if (this.overlay) this.overlay = null
        else if (this.transient) this.transient = null
        // The watch card's own Back leaves the watch, exactly like the
        // double-tap (the build keeps running). Without this it redrew the
        // same card and looked broken.
        else if (this.phase === 'attach') this.detach()
        break
      case 'confirm_watch_pause':
        this.confirmWatchPause()
        return
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
    if (this.nativeQuestion) return
    if (this.activeDelivery()) return
    if (!this.decisionPending || !this.sessionId || this.busy) return
    const index = this.decisionJob
    const job = index !== null ? this.jobs[index] : null
    if (index !== null && !job?.sessionId) return
    const question = { text: this.decisionText, options: [...this.decisionOptions] }
    // While planning, the answer can change the plan: the Lead is asked for
    // the complete plan again, so Start build returns with the revised plan
    // instead of waiting on a plan a bare answer never produces.
    const replan = !job && this.phase === 'plan' && this.jobs.length === 0 && this.planProtocol !== 'legacy'
    this.decisionPending = false
    this.decisionOptions = []
    this.chatAsked = ''
    this.lastDecision = text
    if (!job) this.ownerTurn(text, true)
    this.chat('you', text)
    this.busy = true
    const gen = this.generation
    try {
      // A question never cancels the awaited reply; a blip defers the answer
      // to the tick instead of losing the owner's words on the wire.
      if (job) {
        // Answer the builder that is actually blocked, retaining the current
        // request token. Never create a second worker or steer the lead.
        const reply = [text, ...this.replyFormat(job)].join('\n')
        const answer = job.requestToken
          ? `${reply}\n${this.protocolInstructions(job.requestToken, 'WORK_READY')}`
          : this.workerRequest(job, reply)
        job.pendingPrompt = answer
        job.question = null
        try {
          await this.postWorkerPrompt(job, answer, job.stage)
          if (this.genStale(gen)) return
          if (job.pendingPrompt === answer) job.pendingPrompt = null
        } catch (e) {
          if (!this.isBlip(e)) throw e
        }
      } else await this.postLead(replan ? `${text}\n${PLAN_AGAIN_LINE}` : text, this.awaiting ?? 'steer', true, true)
      if (this.genStale(gen)) return
      if (!this.decisionPending) this.decisionJob = null
      this.showWorkerQuestion()
      this.emitCurrent()
    } catch (e) {
      if (!this.genStale(gen) && !this.isBlip(e)) {
        if (job && !job.question) job.question = question
        if (!this.decisionPending) {
          this.decisionPending = true
          this.decisionJob = index
          this.decisionText = question.text
          this.decisionOptions = [...question.options]
        }
        this.fault(e, 'factory', 'decision')
      }
    } finally {
      if (!this.genStale(gen)) this.busy = false
    }
  }

  /**
   * The durable runtime recorded the owner's refusal of the pending gate: the
   * mission is ending on the record (the driver cancels it), so the gate
   * clears here and the session chat keeps the owner's words next to the
   * question it refused. The driver owns the end state — this engine never
   * resets itself under the runtime (that would strand the durable record).
   */
  declinePendingGate(text: string): void {
    if (!this.decisionPending || !this.decisionGate) return
    this.decisionPending = false
    this.decisionGate = false
    this.decisionOptions = []
    this.chatAsked = ''
    // A refusal cancels any start it confirmed earlier and is still waiting
    // on: the queue must never outlive the owner's "no".
    this.queuedStart = null
    this.chat('you', text)
  }

  // ---------------------------------------------------- new-repo missions

  /**
   * Start the pending goal in a brand-new GitHub repository. The glasses
   * action derives the name from the goal; the phone can type one (kept in
   * repoName by sayNewRepo). With neither a GitHub token nor a paired host
   * signed in to GitHub, the card says how to get one, and the save that adds
   * it resumes the start.
   */
  startNewRepo(name = ''): void {
    if (this.faultKind) {
      this.emitCurrent() // the fault card is the reason, and offers Retry
      return
    }
    const blocked = this.creatingRepo !== null
      ? COPY.real.newRepoStill(this.creatingRepo)
      : this.sessionId ? COPY.real.newRepoLive
        : !this.goal ? COPY.real.newRepoNoGoal
          : this.busy ? COPY.real.newRepoBusy
            : null
    if (blocked !== null) {
      console.warn('[engine] new repo not started:', blocked)
      this.emitTransientScene(
        this.scene('status_answer', {
          pose: this.creatingRepo !== null ? 'delegating' : 'idle', utterance: blocked,
          statusNote: this.creatingRepo !== null ? COPY.real.creatingRepoStatus : COPY.real.newRepoBlockedStatus,
          actions: [{ id: 'back', label: 'Back', kind: 'command' }],
          transientMs: MS(8),
        }),
        MS(8),
      )
      return
    }
    const typed = name.replace(/\s+/g, ' ').trim()
    if (typed !== '') this.repoName = typed
    if (!this.githubReady()) {
      const host = this.clients.githubHost
      if (!host || host.known() !== null) {
        this.emitBlockedPrompt('github')
        return
      }
      // Not known yet whether the paired host has GitHub: ask it once, then
      // create there or show the prompt (selection case 3).
      const gen = this.generation
      void host.check().catch(() => false).then((ok) => {
        if (this.genStale(gen)) return
        if (ok) void this.createRepoAndPlan()
        else this.emitBlockedPrompt('github')
      })
      return
    }
    void this.createRepoAndPlan()
  }

  /** This engine can start a goal in a brand-new repository. */
  canStartNewRepo(): boolean {
    return true
  }

  /**
   * Typed goal from the phone that should build in a brand-new repository.
   * Returns where the text went, like say().
   */
  sayNewRepo(text: string, name: string): 'goal' | 'steer' | 'none' {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean || !this.acceptsGoal()) return 'none'
    this.leaveFinished()
    if (this.phase === 'attach') this.detach() // a new repository is never the watched build's
    this.repoName = name.replace(/\s+/g, ' ').trim()
    // A new-repository request is never steering: sending it into a live
    // session is how it used to land in the previous build's repository.
    if (this.sessionId) return 'none'
    this.goal = clean
    this.capturedSec = 0
    this.phase = 'transcript'
    this.emitCurrent()
    this.startNewRepo()
    return 'goal'
  }

  /**
   * Create `base`; a taken name steps aside (-2, -3, then a dated name).
   * A create whose answer was lost may have succeeded: the retry adopts that
   * exact repository instead of minting a "-2" duplicate beside it.
   */
  private async createRepoWithFallback(base: string): Promise<{ url: string }> {
    const isTaken = (e: unknown): boolean =>
      e instanceof Error && 'kind' in e && (e as { kind: unknown }).kind === 'exists'
    const uncertain = this.uncertainRepoCreate
    if (uncertain !== null && this.clients.findRepo) {
      const found = await this.clients.findRepo(uncertain, undefined, true)
      if (found !== null) { this.uncertainRepoCreate = null; return found }
    }
    const attempt = async (name: string): Promise<{ url: string }> => {
      try {
        const created = await this.clients.createRepo(name, true)
        this.uncertainRepoCreate = null
        return created
      } catch (e) {
        if (!isTaken(e)) this.uncertainRepoCreate = name
        throw e
      }
    }
    for (const name of [base, `${base}-2`, `${base}-3`]) {
      try {
        return await attempt(name)
      } catch (e) {
        if (!isTaken(e)) throw e
      }
    }
    const dated = `${base}-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}`
    try {
      return await attempt(dated)
    } catch (e) {
      if (!isTaken(e)) throw e
      return attempt(`${dated}-${Math.random().toString(36).slice(2, 6)}`)
    }
  }

  /** Create the new repository, freeze it as this mission's repo, and plan. */
  private async createRepoAndPlan(): Promise<void> {
    if (this.busy || this.sessionId) return
    const base = this.repoName || repoNameFromGoal(this.goal)
    this.repoName = base // keep the typed identity through a failed create/restart
    this.busy = true
    this.blockedStart = null
    this.chat('spriite', COPY.real.creatingRepo)
    // The creating card is state, not a timed card: it holds for as long as
    // the create is pending. A 20-second card used to expire back onto the
    // transcript, whose New repo then hit the busy guard in silence.
    this.creatingRepo = base
    this.transient = null
    this.emitCurrent()
    const gen = this.generation
    try {
      const created = await this.createRepoWithFallback(base)
      if (this.genStale(gen)) return
      this.missionRepo = created.url
      this.repoName = ''
    } catch (e) {
      // A repository create is a launch: a blip has no durable record here,
      // so it surfaces as a fault (Retry re-runs the create) instead of
      // expiring the "creating" card onto a transcript that never started.
      if (!this.genStale(gen)) this.fault(e, 'github', 'repo')
      return
    } finally {
      if (!this.genStale(gen)) { this.busy = false; this.creatingRepo = null }
    }
    if (this.genStale(gen)) return
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
    if (this.pendingLeadPosts.length && retry !== null &&
      ['plan', 'verdict', 'summary', 'decision', 'steer'].includes(retry)) {
      this.retryPendingPrompts()
      this.emitCurrent()
      return
    }
    switch (retry) {
      case 'plan':
        void this.startPlanning()
        return
      case 'repo':
        void this.createRepoAndPlan()
        return
      case 'build':
        this.startBuildOrQueue()
        return
      case 'fix':
        if (index !== null) void this.startFixRun(index)
        else this.emitCurrent()
        return
      case 'integration':
        this.queuedStart = 'integration'
        this.pumpQueuedStart()
        return
      case 'pr':
        this.startPrOrQueue()
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
      case 'steer': {
        // The steer may itself be a queued turn a fault interrupted: the
        // tick re-sends the queue, so never post a turn that is still
        // pending — the owner's words go out once, in order.
        const stillQueued = this.lastSteer !== '' && this.pendingLeadPosts.some((p) => p.text === this.lastSteer)
        if (this.lastSteer && !stillQueued) void this.postSteer(this.lastSteer)
        else this.emitCurrent() // the queued turns re-send on the next tick
        return
      }
      default:
        this.emitCurrent() // a poll fault: the tick loop resumes
    }
  }

  chooseGoalList(_index: number): 'talk' | 'done' {
    // Real mode takes goals by voice; the list offers the Talk entry only.
    return 'talk'
  }

  /**
   * Pick a row of a pending question's option list. An option row answers
   * the lead at once ("The owner chose: X"); the last row opens Talk so any
   * alternative can be spoken. The UI verifies the rendered question before
   * passing its row index here.
   */
  chooseDecisionList(index: number): 'talk' | 'done' {
    if (this.nativeQuestion) return 'done'
    if (!this.decisionPending || this.decisionGate || this.decisionKind === 'pr') return 'done'
    const rows = [...this.decisionOptions, COPY.real.speakAnswer]
    const row = rows[index]
    if (row === undefined) return 'done'
    if (row === COPY.real.speakAnswer) return 'talk'
    void this.answerDecision(`The owner chose: ${row}`)
    return 'done'
  }

  /** The question on the option list: fitted to the selection title lines. */
  private decisionListTitle(): string {
    const clean = sanitizeSpoken(this.decisionText.replace(/\s+/g, ' ').trim())
    if (fitsWrappedLines(clean, BUDGETS.utterance.width, 2)) return clean
    const words = clean.split(' ')
    while (words.length > 1) {
      words.pop()
      const shortened = `${words.join(' ')}...`
      if (fitsWrappedLines(shortened, BUDGETS.utterance.width, 2)) return shortened
    }
    return clean
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
      this.openRow(rows[index])
      return
    }
    if (index === rows.length) {
      this.phase = 'goal' // the goal list: Talk (or a saved goal)
      this.emitCurrent()
    }
  }

  private openRow(row: HomeRow): void {
    if (row.kind === 'local') {
      if (row.goal !== null && this.projectsSource?.open?.({ id: row.projectId, goal: row.goal }) === true) return
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
  }

  /**
   * Leave whatever pre-mission card is up so a picked row can open: a watch
   * (it keeps running), its overlays, the goal list, or an unstarted goal.
   * Never called while Spriite's own mission runs (canOpenBuilds guards).
   */
  private leaveForRow(): void {
    this.overlay = null
    this.transient = null
    this.leaveFinished()
    if (this.phase === 'attach') this.leaveWatch()
    if (this.phase === 'goal' || this.phase === 'transcript') {
      this.goal = ''
      this.capturedSec = 0
      this.phase = 'meet'
    }
  }

  /** Watch a Factory cloud session picked from the home list. */
  private attachFactoryRow(row: HomeRow): void {
    if (!row.sessionId) return
    this.openWatchChat(`factory:${row.sessionId}`)
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
      misses: 0,
      nextRunCheck: 0,
      changedAt: row.updatedAt,
      checkedAt: this.cloudFailing ? null : this.nowMs,
    }
    this.phase = 'attach'
    this.sessionId = row.sessionId
    this.awaiting = 'steer' // replies surface as cards; Talk steers it
    this.seenMessageIds.clear()
    this.messageCount = 0
    this.lastReply = ''
    this.nextLeadPoll = 0 // first poll primes history, then new replies show
    this.emitCurrent()
  }

  /** Watch a Cursor cloud agent picked from the home list. */
  private attachCursorRow(row: HomeRow): void {
    if (!row.agentId) return
    this.openWatchChat(`cursor:${row.agentId}`)
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
      misses: 0,
      nextRunCheck: 0,
      changedAt: row.updatedAt,
      checkedAt: this.cloudFailing ? null : this.nowMs,
    }
    this.phase = 'attach'
    this.sessionId = null
    this.awaiting = null
    this.lastReply = ''
    this.emitCurrent()
  }

  /** Leave a watch for another row: the watched build's question is its own and keeps waiting there. */
  private leaveWatch(): void {
    this.decisionPending = false
    this.decisionOptions = []
    this.decisionText = ''
    this.nativeQuestion = null
    this.queuedLeadQuestion = null
    this.decisionGate = false
    this.decisionJob = null
    this.leadQuestionRequest = null
    this.buildDraft = null
    this.overlay = null
    this.transient = null
    this.detach()
  }

  /** Leave a watched build (it keeps running; nothing is cancelled). */
  private detach(): void {
    this.rememberWatchChat()
    // The next selection owns its own reads and acknowledgments, even when
    // the owner returns to the same session before an old request settles.
    this.generation += 1
    this.leadDispatchOwner = null
    this.preparingBuild = false
    this.cloudBusy = false
    this.busy = false
    this.pollingLead = false
    this.chatLogEntries = []
    this.chatSeenIds.clear()
    this.pendingLeadDelivery = null
    this.observedLeadMessages = null
    this.pendingLeadPosts = [] // a retry must never follow the owner into another chat
    this.attach = null
    this.phase = 'meet'
    this.sessionId = null
    this.awaiting = null
    this.lastReply = ''
    this.seenMessageIds.clear()
    this.messageCount = 0
    this.nextLeadPoll = 0
    this.nextCloudPoll = 0 // refresh the row's live status for the list
  }

  private openWatchChat(key: string): void {
    const saved = this.watchChats.get(key)
    this.chatLogEntries = saved ? saved.entries.map(e => ({ ...e })) : []
    this.chatSeenIds = new Set(saved?.seen ?? [])
    this.pendingLeadDelivery = key.startsWith('factory:') ? this.deliveryAttempts.get(key.slice('factory:'.length)) ?? null : null
    this.observedLeadMessages = null
    this.chatAsked = ''
    this.chatGoal = ''
  }

  private rememberWatchChat(): void {
    const watch = this.attach
    const key = watch?.source === 'factory' && watch.sessionId ? `factory:${watch.sessionId}`
      : watch?.source === 'cursor' && watch.agentId ? `cursor:${watch.agentId}` : null
    if (!key) return
    this.watchChats.delete(key)
    this.watchChats.set(key, { entries: this.chatLogEntries.map(e => ({ ...e })), seen: [...this.chatSeenIds],
      delivery: this.pendingLeadDelivery ? { ...this.pendingLeadDelivery,
        beforeMessageIds: this.pendingLeadDelivery.beforeMessageIds ? [...this.pendingLeadDelivery.beforeMessageIds] : null } : null })
    // Each log is already bounded. Older provider history is fetched again
    // on selection; retain only the eight most recently visited local tails.
    while (this.watchChats.size > 8) this.watchChats.delete(this.watchChats.keys().next().value!)
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
        actions: COPY.real.needVoiceActions, status: `Voice${SEP}key needed`,
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
    this.leaveFinished()
    if (this.phase === 'attach') this.detach() // the watched build keeps running
    if (this.sessionId) {
      // A running mission takes a new spoken goal as steering for the lead
      // (it can re-plan). Overwriting the goal silently would strand the
      // live run behind a card whose Start action no-ops.
      this.steer(`New goal: ${text}`)
      return
    }
    // A fresh goal displaces any lingering note card (the decline note after
    // a refused gate): the owner has moved on, so the transcript card leads.
    this.transient = null
    this.goal = text
    this.capturedSec = sec
    this.phase = 'transcript'
    this.emitCurrent()
  }

  steer(text: string): boolean {
    if (this.quarantined) return false
    if (this.canConfirmChatBuild()) {
      if (isBuildCancellation(text)) { this.back(); return true }
      if (isBuildApproval(text)) {
        if (this.phase !== 'attach') void this.confirmOwnedChatBuild()
        return true
      }
    }
    if (isBuildDirective(text) && this.decisionPending && this.decisionGate && this.decisionKind === 'build' &&
      !this.busy && !this.paused && !this.faultKind && !this.nativeQuestion &&
      !this.queuedLeadQuestion && !this.pendingLeadDelivery && !this.leadPostInFlight) {
      this.handleAction('use_it')
      return true
    }
    if ((isBuildDirective(text) || (isScopeReviewDirective(text) && this.canReviewChatBuild())) &&
      this.sessionId && !this.decisionPending) {
      void this.prepareChatBuild()
      return true
    }
    if (this.pendingLeadDelivery) return false
    if (this.nativeQuestion) return false
    if (this.decisionPending && !this.decisionGate && this.decisionJob !== null && this.sessionId) {
      // Send message was captured for the coordinator; a new worker question
      // must not silently rebind it or let it pass to the coordinator.
      this.retainDraft(this.sessionId, text)
      return true
    }
    if (this.busy || this.leadPostInFlight || this.paused || this.queuedLeadQuestion?.native) return false // keep unsent input
    if (this.faultKind && this.faultSource === 'factory') return false
    if (!this.sessionId) return false
    if (this.phase === 'attach' && !this.attachSteerable()) return false
    void this.postSteer(text)
    return true
  }

  canConfirmChatBuild(): boolean {
    return this.overlay === 'chat_build' && validBuildDraft(this.buildDraft) &&
      this.buildDraft.sourceSessionId === this.sessionId &&
      ((this.phase === 'attach' && this.managedWatchHandoff) || (this.phase === 'plan' && this.jobs.length === 0)) &&
      !this.busy && !this.paused && !this.faultKind && !this.decisionPending &&
      !this.nativeQuestion && !this.queuedLeadQuestion && !this.pendingLeadDelivery &&
      !this.leadPostInFlight && this.pendingLeadPosts.length === 0
  }

  /** Observed scope is a hint for review, never a restored approval or launch. */
  canReviewChatBuild(): boolean {
    if (!this.sessionId || this.busy || this.paused || this.faultKind || this.decisionPending ||
      this.nativeQuestion || this.queuedLeadQuestion || this.pendingLeadDelivery ||
      this.leadPostInFlight || this.pendingLeadPosts.length || this.jobs.length) return false
    if (this.observedLeadMessages?.sessionId !== this.sessionId || !this.observedLeadMessages.scope) return false
    if (this.phase === 'attach') {
      return this.managedWatchHandoff && this.attach?.source === 'factory' &&
        !this.watchUnknown(this.attach) && this.attach.runStatus === 'idle'
    }
    const lead = this.activity.get(this.sessionId)
    return this.phase === 'plan' && (this.awaiting === 'plan' || this.planLabels.length === 0) &&
      lead?.status === 'idle' && this.nowMs - lead.checkedAt < STATUS_FRESH_MS
  }

  /** Runtime capability, not a grant that may be imported from a snapshot. */
  enableManagedWatchBuildHandoff(): void { this.managedWatchHandoff = true }

  /** Re-read before accepting approval; questions and changed scope win. */
  async verifiedChatBuildDraft(): Promise<ChatBuildDraft | null> {
    if (!this.canConfirmChatBuild() || this.preparingBuild) return null
    const draft = this.buildDraft!
    const watch = this.attach
    const gen = this.generation
    const scopeRevision = this.scopeRevision
    this.preparingBuild = true
    try {
      const info = await this.clients.getSession(draft.sourceSessionId, this.computerFor(draft.sourceSessionId))
      const messages = await this.clients.getMessages(draft.sourceSessionId, this.computerFor(draft.sourceSessionId))
      if (this.genStale(gen) || this.scopeRevision !== scopeRevision || this.attach !== watch || this.buildDraft !== draft || !this.canConfirmChatBuild()) return null
      this.observeNativeQuestions(messages, draft.sourceSessionId)
      if (!this.canConfirmChatBuild()) { this.emitCurrent(); return null }
      const scope = chatBuildScope(messages, this.phase === 'plan' ? { goal: this.goal, repository: this.missionRepo } : undefined)
      if (info.status !== 'idle' || !scope || scope.goal !== draft.goal ||
        scope.repository !== draft.repository || scope.plan.join('\n') !== draft.plan.join('\n')) {
        this.buildDraft = null
        this.overlay = null
        this.showNotice(COPY.real.chatBuildChanged, 'Approval not applied', 'idle')
        return null
      }
      return { ...draft, plan: [...draft.plan] }
    } catch {
      if (!this.genStale(gen) && this.attach === watch && this.buildDraft === draft) {
        this.showNotice(COPY.real.chatBuildVerifyFailed, 'Approval not applied', 'idle')
      }
      return null
    } finally { if (!this.genStale(gen)) this.preparingBuild = false }
  }

  private async confirmOwnedChatBuild(): Promise<void> {
    const draft = await this.verifiedChatBuildDraft()
    if (!draft || this.phase !== 'plan') return
    this.approvedPlan = [...draft.plan]
    this.requiresFreshApproval = false
    this.goal = draft.goal
    this.planLabels = [this.goal]
    this.awaiting = null
    this.buildDraft = null
    this.overlay = null
    this.setStatus('plan', 'submitted')
    this.startBuildOrQueue()
  }

  private async prepareChatBuild(): Promise<void> {
    if (this.preparingBuild) return
    if (this.buildDraft && this.canConfirmChatBuild()) { this.emitCurrent(); return }
    if (!this.sessionId || this.busy || this.paused || this.faultKind || this.decisionPending ||
      this.nativeQuestion || this.queuedLeadQuestion || this.pendingLeadDelivery ||
      this.leadPostInFlight || this.pendingLeadPosts.length) { this.emitCurrent(); return }
    if (this.phase !== 'attach' && this.phase !== 'plan') {
      this.showNotice(COPY.real.chatBuildAlreadyOwned, 'No duplicate build', 'idle')
      return
    }
    if (this.phase === 'plan' && this.planLabels.length && this.awaiting !== 'plan') {
      this.handleAction('begin')
      return
    }
    if (this.phase === 'attach' && this.attach?.source !== 'factory') return
    if (this.phase === 'attach' && !this.managedWatchHandoff) {
      this.showNotice(COPY.real.chatBuildRuntimeRequired, 'No build started', 'idle')
      return
    }
    const sid = this.sessionId
    const watch = this.attach
    const gen = this.generation
    this.preparingBuild = true
    try {
      const info = await this.clients.getSession(sid, this.computerFor(sid))
      const messages = await this.clients.getMessages(sid, this.computerFor(sid))
      if (this.genStale(gen) || this.sessionId !== sid || this.attach !== watch) return
      this.observeNativeQuestions(messages, sid)
      if (this.decisionPending || this.nativeQuestion || this.queuedLeadQuestion) { this.emitCurrent(); return }
      if (info.status !== 'idle') {
        this.showNotice(COPY.real.chatBuildNoIdle, 'No build started', 'idle')
        return
      }
      const scope = chatBuildScope(messages, this.phase === 'plan' ? { goal: this.goal, repository: this.missionRepo } : undefined)
      if (!scope) {
        this.showNotice(COPY.real.chatBuildMissing, 'No build started', 'idle')
        return
      }
      this.buildDraft = { ...scope, requestId: mintId('build'), sourceSessionId: sid }
      this.chat('spriite', [
        'Build scope, not started:', scope.goal, `Repository: ${scope.repository}`,
        'Plan for your approval:', ...scope.plan,
        this.phase === 'attach'
          ? 'The original chat stays watched. Start build saves a new managed execution, using your current new-build settings and credits.'
          : 'Start build executes this scope in the existing mission, with its frozen settings and credits.',
      ].join('\n'))
      this.transient = null
      this.overlay = 'chat_build'
      this.emitCurrent()
    } catch {
      if (!this.genStale(gen) && this.sessionId === sid && this.attach === watch) {
        this.showNotice(COPY.real.chatBuildReadFailed, 'No build started', 'idle')
      }
    } finally { if (!this.genStale(gen)) this.preparingBuild = false }
  }

  /** Continue is an explicit chat request, not a build approval or native answer. */
  private canContinueSession(): boolean {
    if (!this.sessionId || this.busy || this.paused || this.faultKind || this.decisionPending ||
      this.nativeQuestion || this.pendingLeadDelivery || this.leadPostInFlight || this.pendingLeadPosts.length > 0 || this.missionFinished()) return false
    if (this.observedLeadMessages?.sessionId !== this.sessionId) return false
    if (this.phase === 'attach') {
      return this.attachSteerable() && this.attach !== null && !this.watchUnknown(this.attach) && this.attach.runStatus === 'idle'
    }
    const lead = this.activity.get(this.sessionId)
    return this.activityStatus() === 'idle' && lead?.status === 'idle' && this.nowMs - lead.checkedAt < STATUS_FRESH_MS
  }

  /** Durable X delivery owns its retries; never use postLead's blip queue. */
  get followupReady(): boolean {
    return !this.quarantined && !this.leadDispatchOwner && this.sessionId !== null && !this.busy && !this.leadPostInFlight &&
      this.pendingLeadPosts.length === 0 && !this.activeDelivery() && this.faultKind === null && !this.paused &&
      !this.nativeQuestion && !this.queuedLeadQuestion?.native &&
      (this.phase !== 'attach' || this.attachSteerable())
  }

  async sendFollowup(text: string, allowed: () => boolean): Promise<'sent' | 'deferred' | 'unknown'> {
    if (!this.followupReady || !allowed() || this.sessionId === null) return 'deferred'
    const owner = {}
    this.leadDispatchOwner = owner
    this.busy = true
    const generation = this.generation
    const sessionId = this.sessionId
    let attempt: DeliveryAttempt | null = null
    let dispatched = false
    try {
      const messages = await this.clients.getMessages(sessionId, this.computerFor(sessionId))
      if (this.genStale(generation) || this.sessionId !== sessionId) return 'deferred'
      this.observeNativeQuestions(messages, sessionId)
      if (!factoryHistoryComplete(messages) || this.activeDelivery() || this.paused || this.nativeQuestion || this.queuedLeadQuestion?.native || !allowed()) return 'deferred'
      attempt = this.beginDelivery(sessionId, text, messages.length <= 2000 ? messages.map(m => m.id) : null)
      if (this.beforeSessionDispatch) await this.beforeSessionDispatch()
      // No await between the final authority check and initiating the request.
      if (this.deliveryAttempts.get(sessionId) !== attempt) return 'deferred'
      if (this.genStale(generation) || this.sessionId !== sessionId || this.paused ||
        this.nativeQuestion || this.queuedLeadQuestion?.native || !allowed()) {
        this.finishDelivery(attempt)
        return 'deferred'
      }
      dispatched = true
      await this.clients.postMessage(sessionId, text, this.computerFor(sessionId))
      this.finishDelivery(attempt)
      if (!this.genStale(generation)) {
        this.ownerTurn(text)
        // Do not arm the engine's legacy Retry steer path: this ledger alone
        // owns whether these words may ever be posted again.
        this.awaiting = this.awaiting ?? 'steer'
        if (!this.decisionGate && this.decisionJob === null) {
          this.decisionPending = false
          this.decisionOptions = []
          this.showWorkerQuestion()
        }
        this.chat('you', text)
        this.emitCurrent()
      }
      return 'sent'
    } catch (e) {
      if (!dispatched || !this.isUnconfirmedPost(e)) {
        if (attempt) this.finishDelivery(attempt)
        if (!dispatched) return 'deferred'
        throw e
      }
      // A lost response is not evidence that the provider did not receive it.
      return 'unknown'
    } finally {
      if (this.leadDispatchOwner === owner) this.leadDispatchOwner = null
      if (!this.genStale(generation)) this.busy = false
    }
  }

  /** Typed text from the phone: decision answer, goal, or steering. */
  say(text: string): 'goal' | 'steer' | 'decision' | 'none' {
    if (this.nativeQuestion) return 'none'
    if (this.activeDelivery()) return 'none'
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) return 'none'
    if (this.canConfirmChatBuild() && (isBuildApproval(clean) || isBuildCancellation(clean))) {
      this.steer(clean)
      return 'decision'
    }
    if (this.decisionPending) {
      if (this.busy && !this.decisionGate) return 'none'
      if (this.decisionGate) {
        // The gate is Spriite's own confirmation (credits, PR): yes confirms,
        // no declines, other words go to the lead while the gate waits.
        if ((this.decisionKind === 'build' && isBuildApproval(clean)) ||
          /^(?:y|yes|yep|yeah|sure|ok|okay|go|start|begin|confirm|proceed|do it|please do|(?:yes|okay|ok)[, ]+ (?:please|go ahead|please do))[.!]?$/i.test(clean) ||
          (this.decisionKind === 'pr' && /^(?:yes[, ]+)?(?:please )?open (?:the )?(?:pr|pull request)[.!]?$/i.test(clean))) {
          this.handleAction('use_it')
          return 'decision'
        }
        if (isGateDecline(clean)) {
          const kind = this.decisionKind
          this.decisionPending = false
          // The decline is an answer: log it, and re-arm the chat ask key so
          // an identical later gate question logs again.
          this.chatAsked = ''
          this.chat('you', clean)
          // A refused gate is a dead end for the mission: nothing will ever
          // start the build or open its PR, so the mission ends here — a
          // visible decline card, then the home — instead of sitting on a
          // plan card whose start was refused. Every goal the owner speaks
          // next must start a fresh build, never silently steer a session
          // that will not run (the owner's report).
          this.reset()
          this.emitTransientScene(
            this.scene('status_answer', {
              pose: 'idle',
              utterance: kind === 'pr' ? COPY.real.prDeclined : COPY.real.startDeclined,
              statusNote: COPY.real.declineStatus,
              actions: COPY.real.declineActions,
              transientMs: MS(8),
            }),
            MS(8),
          )
          return 'decision'
        }
        if (this.decisionKind === 'pr') {
          // Conditional yes/okay is a scope restriction, never permission to
          // publish. Retain it and hold the built work for explicit review.
          this.ownerClarifications.push(clean)
          this.lastDecision = clean
          this.decisionPending = false
          this.decisionGate = false
          this.queuedStart = null
          this.paused = true
          if (this.sessionId) this.retainDraft(this.sessionId, clean)
          return 'decision'
        }
        if (this.steer(clean)) return 'steer'
        return 'none'
      }
      void this.answerDecision(clean)
      return 'decision'
    }
    if ((isBuildDirective(clean) || (isScopeReviewDirective(clean) && this.canReviewChatBuild())) && this.sessionId) {
      void this.prepareChatBuild()
      return 'steer'
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
  listBuilds(): Array<{ title: string; note: string; kind: 'local' | 'factory' | 'cursor'; missionId?: string }> {
    return this.buildHomeRows().map((r) => ({
      title: sanitizeSpoken(String(r.title ?? '').replace(/\s+/g, ' ').trim()),
      note: r.tail,
      kind: r.kind,
      // A Spriite row names its mission: with no live actor a finished
      // runtime mission emits no card, so this id is the phone's only way
      // to the record it left.
      ...(r.projectId !== undefined ? { missionId: r.projectId } : {}),
    }))
  }

  /**
   * Open a build row from the phone, from any pre-mission card (the home, a
   * watch, the goal list, the transcript card). False while Spriite's own
   * mission owns the engine, or when the index no longer names a row.
   */
  openBuild(index: number): boolean {
    if (!this.canOpenBuilds()) return false
    const row = this.buildHomeRows()[index]
    if (row === undefined) return false
    if (row.kind === 'local' && row.goal !== null && this.projectsSource?.open !== undefined) {
      // A runtime mission row focuses its own actor. A held goal stays on the
      // lobby for when the owner comes back; a watch does not (Back from the
      // mission must land home, not on a build the owner already left).
      this.overlay = null
      this.transient = null
      const left = this.phase === 'attach'
      if (left) this.leaveWatch()
      if (this.projectsSource.open({ id: row.projectId, goal: row.goal }) === true) {
        // After the open, so the focused mission's card is never preceded by
        // a flash of the home; this refreshes the lobby's own last card.
        if (left) this.emitCurrent()
        return true
      }
    }
    this.leaveForRow()
    this.openRow(row)
    return true
  }

  private async postSteer(text: string, protectDelivery = true, upgradeLegacy = false): Promise<void> {
    if (this.busy || !this.sessionId || this.pendingLeadDelivery) return
    const sessionId = this.sessionId
    this.busy = true
    const gen = this.generation
    this.ownerTurn(text)
    if (!this.decisionGate && this.decisionJob === null) {
      // A spoken answer replaces the lead's question (the option list goes).
      // ownerTurn already retired any build gate for the superseded scope.
      // A PR gate belongs to already-built work and remains independent.
      this.decisionPending = false
      this.decisionOptions = [] // a spoken answer replaces the option list
      this.showWorkerQuestion()
    }
    this.lastSteer = text
    const watching = this.phase === 'attach'
    let attempted = false
    try {
      if (protectDelivery && this.pendingLeadPosts.length === 0) {
        // An older identical turn that arrived since the last poll is not
        // acknowledgment of the request the owner is sending now.
        const messages = await this.clients.getMessages(sessionId, this.computerFor(sessionId))
        if (this.genStale(gen) || this.sessionId !== sessionId) return
        this.observeLeadDelivery(sessionId, messages)
        this.observeNativeQuestions(messages, sessionId)
        if (!factoryHistoryComplete(messages) || this.paused || this.nativeQuestion || this.queuedLeadQuestion?.native ||
          (this.decisionPending && this.decisionJob !== null)) {
          this.lastSteer = ''
          this.retainDraft(sessionId, text)
          this.emitCurrent()
          return
        }
      }
      if (upgradeLegacy) {
        text = `${text}\n\n${this.planRequest()}`
        this.lastSteer = text
      }
      attempted = true
      await this.postLead(text, this.awaiting ?? 'steer', true, protectDelivery)
      if (this.genStale(gen) || this.sessionId !== sessionId) return
      this.chat('you', text)
      if (this.pendingLeadDelivery) {
        this.transient = null
        this.emitCurrent() // show History / Factory / Resolve, not a sent-message notice
        return
      }
      this.emitTransientScene(
        this.scene('status_answer', {
          pose: 'waiting', utterance: fitUtterance(text, 2),
          statusNote: this.pendingLeadDelivery || this.pendingLeadPosts.some((p) => p.text === text)
            ? COPY.real.messageUnconfirmedStatus : COPY.real.steeredStatusNote,
          actions: [{ id: 'back', label: 'Back', kind: 'command' }],
          transientMs: MS(8),
        }),
        MS(8),
      )
    } catch (e) {
      if (this.genStale(gen) || this.sessionId !== sessionId) return
      if (upgradeLegacy && !this.pendingLeadDelivery) this.planProtocol = 'legacy'
      if (!attempted) {
        if (upgradeLegacy) this.retainDraft(sessionId, text) // never upgrade a protocol from a failed GET
        else this.queueLeadPost(text, this.awaiting ?? 'steer', true, true)
        this.emitCurrent()
      }
      if (!attempted && this.isReadBlip(e)) {
        this.activity.delete(sessionId)
        if (this.attach?.source === 'factory') this.attach.checkedAt = null
        this.lastSteer = ''
        this.chat('you', text)
        this.chat('spriite', COPY.real.messageReadFailed)
        this.emitTransientScene(this.scene('status_answer', {
          pose: 'reconciling', utterance: COPY.real.messageReadFailed,
          statusNote: COPY.real.activityStatus.unknown, actions: COPY.real.messageReadFailedActions,
          transientMs: MS(8),
        }), MS(8))
        return
      }
      if (this.isBlip(e)) return
      if (watching) {
        // A watched build is not Spriite's mission: a refused message says
        // why on a card and leaves the watch (and the app) usable. Keep its
        // bytes as a handoff draft, not an automatic refusal retry loop.
        this.pendingLeadPosts = this.pendingLeadPosts.filter(p => p.text !== text)
        this.retainDraft(sessionId, text)
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
      if (!this.genStale(gen)) this.busy = false
    }
  }

  talkStatus(): void {
    if (this.creatingRepo !== null) {
      this.startNewRepo() // the still-creating card is the status
      return
    }
    if (this.phase === 'attach' && this.attach) {
      // A watched build's status is its Explain card (source, status, age).
      this.overlay = 'explain'
      this.emitCurrent()
      return
    }
    const workMilestones = this.milestones.filter((m) => m.id !== 'plan')
    const acceptedCount = workMilestones.filter((m) => m.status === 'accepted').length
    if (this.phase === 'plan' && this.planLabels.length > 0) {
      this.emitTransientScene(this.scene('status_answer', {
        pose: 'waiting', utterance: this.jobCount > 1 ? COPY.real.planReadySplit(this.jobCount) : COPY.real.planReady,
        statusNote: COPY.real.statusWords.ready, speaker: 'spriite',
        actions: [{ id: 'back', label: 'Back', kind: 'command' }], transientMs: MS(8),
      }), MS(8))
      return
    }
    if ((this.phase === 'plan' && this.planLabels.length === 0) ||
      (['building', 'review', 'repair', 'pr'].includes(this.phase) && this.activityStatus() !== 'running')) {
      this.emitTransientScene(
        this.scene('status_answer', {
          ...this.waitingActivity(this.phase === 'plan'),
          speaker: 'spriite', actions: [{ id: 'back', label: 'Back', kind: 'command' }],
          transientMs: MS(8),
        }),
        MS(8),
      )
      return
    }
    this.emitTransientScene(
      this.scene('status_answer', {
        pose: this.phase === 'final' ? 'accepted' : 'waiting',
        utterance: COPY.real.statusAnswers[this.phase] || COPY.real.prReady,
        statusNote: workMilestones.length > 0 ? `${acceptedCount} of ${workMilestones.length} steps verified` : 'No steps yet',
        actions: [{ id: 'back', label: 'Back', kind: 'command' }],
        evidence: this.evidenceIds(),
        transientMs: MS(8),
      }),
      MS(8),
    )
  }

  pauseToggle(): void {
    if (this.phase === 'attach') {
      // A watched build is not Spriite's run: Pause only interrupts it after
      // a confirmation, and never enters the paused state (Resume would post
      // "Continue." into someone else's session).
      if (this.attachSteerable() && this.sessionId) {
        this.overlay = 'watch_pause'
        this.emitCurrent()
        return
      }
      this.emitTransientScene(
        this.scene('status_answer', {
          pose: 'idle', utterance: COPY.voice.watchNoPause,
          statusNote: COPY.real.attachWatchOnly,
          actions: [{ id: 'back', label: 'Back', kind: 'command' }],
          transientMs: MS(8),
        }),
        MS(8),
      )
      return
    }
    if (this.paused) {
      this.paused = false
      if (this.pendingLeadDelivery || this.pendingLeadPosts.length > 0) {
        // A turn held during the pause (a review request, an answer) is
        // what resumes the lead: the tick sends it. A "Continue." behind it
        // would only earn a stray lead note over the awaited card.
        this.emitCurrent()
        return
      }
      void this.resumeLead()
      return
    }
    if (!this.sessionId || this.decisionPending || this.phase === 'final') {
      console.warn('[engine] pause needs a running orchestrator')
      return
    }
    this.paused = true
    void this.clients.interrupt(this.sessionId).catch(() => undefined)
    this.emitCurrent()
  }

  /** The owner confirmed stopping a watched build's current turn. */
  private confirmWatchPause(): void {
    if (this.overlay !== 'watch_pause') return
    this.overlay = null
    if (this.phase !== 'attach' || !this.attachSteerable() || !this.sessionId) {
      this.emitCurrent()
      return
    }
    void this.clients.interrupt(this.sessionId).catch(() => undefined)
    this.emitTransientScene(
      this.scene('status_answer', {
        pose: 'idle', utterance: COPY.real.watchPaused,
        statusNote: COPY.real.watchPausedStatus,
        actions: [{ id: 'back', label: 'Back', kind: 'command' }],
        transientMs: MS(8),
      }),
      MS(8),
    )
  }

  /** A short reason card (an action that could not run says why; Back returns). */
  noticeView(utterance: string, statusNote: string): EngineView {
    return {
      type: 'scene',
      scene: this.scene('status_answer', {
        pose: 'idle', utterance: fitUtterance(utterance), statusNote,
        actions: [{ id: 'back', label: 'Back', kind: 'command' }],
      }),
    }
  }

  /** Show a reason card on this engine for a few seconds. */
  showNotice(utterance: string, statusNote: string, pose: 'idle' | 'delegating' = 'idle'): void {
    this.emitTransientScene(
      this.scene('status_answer', {
        pose, utterance: fitUtterance(utterance), statusNote,
        actions: [{ id: 'back', label: 'Back', kind: 'command' }],
        transientMs: MS(8),
      }),
      MS(8),
    )
  }

  /** Drop a notice early (the outcome it announced has arrived). */
  clearNotice(): void {
    if (this.transient === null) return
    this.transient = null
    this.emitCurrent()
  }

  /** A build from the home list is being watched (not run by Spriite). */
  watching(): boolean {
    return this.phase === 'attach' && this.attach !== null
  }

  /** The watched build cannot take messages (Cursor, or no computer). */
  watchOnly(): boolean {
    return this.watching() && !this.attachSteerable()
  }

  /**
   * Re-send the interrupt a pause asked for. A restart cannot know whether
   * the previous generation's request reached the provider (an interrupt is
   * a request, never proof the work stopped), so the durable runtime
   * re-asserts the pause on an already-paused engine instead of trusting
   * the flag. Idempotent: one extra interrupt is noise, a missing one is a
   * lead that keeps spending credits while the record says paused.
   */
  reassertPause(): void {
    if (!this.paused || !this.sessionId) return
    void this.clients.interrupt(this.sessionId).catch(() => undefined)
  }

  private async resumeLead(): Promise<void> {
    if (!this.sessionId) return
    this.busy = true
    this.lastSteer = 'Continue.'
    const gen = this.generation
    try {
      // A blip defers the resume note to the tick: the paused lead would
      // otherwise never be told to continue.
      await this.postLead('Continue.', this.awaiting ?? 'steer', true)
      if (this.genStale(gen)) return
      this.emitCurrent()
    } catch (e) {
      if (!this.genStale(gen) && !this.isBlip(e)) this.fault(e, 'factory', 'steer')
    } finally {
      if (!this.genStale(gen)) this.busy = false
    }
  }

  /**
   * The loaded mission is over: its final card is up and nothing waits on the
   * owner. A new goal (or New repo) replaces it with a fresh mission. Without
   * this, text typed after a finished build steered the finished session, and
   * New repo did nothing because the old session id still owned the engine.
   */
  private missionFinished(): boolean {
    return this.phase === 'final' && !this.decisionPending && !this.faultKind
  }

  /** Leave a finished mission so the next goal starts clean (its row stays on the home). */
  private leaveFinished(): void {
    if (this.missionFinished()) this.reset()
  }

  acceptsGoal(): boolean {
    if (this.faultKind) return false // the fault card owns the engine until acted on
    if (this.missionFinished()) return true
    if (this.phase === 'attach') return !this.attachSteerable()
    // 'plan' only before the lead session exists; once it does, a new goal is
    // steering (voiceGoal routes it), not a fresh transcript.
    return (
      ['meet', 'goal', 'transcript'].includes(this.phase) ||
      (this.phase === 'plan' && !this.sessionId)
    )
  }

  canPause(): boolean {
    if (this.phase === 'attach') return this.attachSteerable() && this.overlay !== 'watch_pause' && !this.faultKind
    // A finished build has nothing left to pause (the Done card offers none).
    return Boolean(this.sessionId) && !this.paused && !this.faultKind && !this.decisionPending && this.phase !== 'final'
  }

  canResume(): boolean {
    return this.paused
  }

  canExplain(): boolean {
    return this.missionActive() || this.phase === 'attach'
  }

  get hasPendingDecision(): boolean {
    return this.decisionPending || this.canConfirmChatBuild()
  }

  nativeQuestionLink(): string | null {
    return this.decisionPending && this.nativeQuestion
      ? `https://app.factory.ai/sessions/${encodeURIComponent(this.nativeQuestion.sessionId)}` : null
  }

  factorySessionLink(): string | null {
    const native = this.nativeQuestionLink()
    if (native) return native
    const delivery = this.activeDelivery()
    if (delivery) {
      return `https://app.factory.ai/sessions/${encodeURIComponent(delivery.sessionId)}`
    }
    return this.attach?.source === 'factory' && this.attach.sessionId && !this.attachSteerable()
      ? `https://app.factory.ai/sessions/${encodeURIComponent(this.attach.sessionId)}` : null
  }

  get hasUnconfirmedDelivery(): boolean { return this.activeDelivery() !== null }

  /** The session's chat log, oldest first (goal, questions, answers, replies). */
  chatLog(): Array<{ who: ChatWho; text: string; at: number }> {
    return [...this.chatLogEntries]
  }

  /** One mission at a time: no other mission can be waiting on the owner. */
  pendingAsks(): Array<{ missionId: string; title: string }> {
    return []
  }

  showMission(_missionId: string): boolean {
    return false
  }

  /** Exactly when openBuild will open a row (the phone enables rows from this). */
  canOpenBuilds(): boolean {
    if (this.faultKind || this.creatingRepo !== null) return false
    if (this.missionFinished()) return true
    return ['meet', 'goal', 'transcript', 'attach'].includes(this.phase)
  }

  /**
   * Append one chat entry. The text is sanitized and bounded (the log feeds
   * glasses pages, not a transcript archive); a consecutive duplicate is
   * dropped so re-emitted cards never double a line. The seq is assigned
   * here, once, from the mission's own counter — the identity the archive
   * keys the row on, which no later slide of the capped tail may rebind.
   */
  private chat(who: ChatWho, text: string): void {
    // The owner's own words, and replies without their protocol tags.
    const clean = who === 'you' ? ownerWords(readableReply(String(text ?? ''))) : chatReply(String(text ?? ''))
    if (!clean) return
    const last = this.chatLogEntries[this.chatLogEntries.length - 1]
    if (last && last.text === clean) return
    this.chatLogEntries.push({ who, text: clean, at: this.nowMs || Date.now(), seq: this.chatSeqCount++ })
    if (this.chatLogEntries.length > 60) this.chatLogEntries.splice(0, this.chatLogEntries.length - 60)
    // Evict whole old entries, never the tail of the response being read.
    let size = this.chatLogEntries.reduce((n, entry) => n + entry.text.length, 0)
    while (size > 64_000 && this.chatLogEntries.length > 1) {
      size -= this.chatLogEntries.shift()!.text.length
    }
  }

  /** Log the pending question once per ask (computeView re-runs on every emit). */
  private chatLogQuestion(): void {
    if (!this.decisionPending || this.chatAsked === this.decisionText) return
    this.chatAsked = this.decisionText
    // The start and PR gates are Spriite's own confirmations; any other
    // question came from the lead (or the watched build).
    this.chat(this.decisionGate ? 'spriite' : this.decisionJob !== null ? 'worker' : this.phase === 'attach' ? 'watched' : 'lead', this.decisionText)
  }

  back(): 'exit' | 'handled' {
    if (this.overlay) {
      if (this.overlay === 'chat_build') this.buildDraft = null
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
      if (this.phase === 'attach') {
        this.showHome()
        return 'handled'
      }
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
        // Once the lead session exists the plan is live work, a root card
        // like building: stepping back onto the transcript would offer a
        // Start for a goal that already started.
        if (this.sessionId) return 'exit'
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

  /** A watch's provider state stays remote; its local delivery hold is cached. */
  showHome(): void {
    if (this.phase === 'attach') this.leaveWatch()
    else if (this.phase === 'goal' || this.phase === 'transcript') {
      this.overlay = 'builds'
      this.emitCurrent()
      return // keep the unsubmitted goal; Back returns to its card
    }
    else if (!['meet', 'goal', 'transcript'].includes(this.phase)) {
      this.showNotice('This build stays open. Use the durable runtime to switch builds.', 'Nothing cancelled', 'idle')
      return
    }
    this.phase = 'meet'
    this.goal = ''
    this.chatGoal = ''
    this.transient = null
    this.overlay = null
    this.buildDraft = null
    this.faultKind = null
    this.faultSource = null
    this.faultDetail = ''
    this.emitCurrent()
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
    this.quarantined = false
    this.requiresFreshApproval = false
    this.initialPlanTurn = null
    // Async steps the reset interrupts belong to the mission being ended: a
    // poll or create that resolves later must not write onto this engine.
    this.generation += 1
    this.leadDispatchOwner = null
    this.preparingBuild = false
    this.cloudBusy = false
    // While watching, sessionId is the watched build's session: Restart only
    // ever ends Spriite's own work, never someone else's run.
    if (this.sessionId && this.phase !== 'attach') {
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
    this.creatingRepo = null
    this.paused = false
    this.decisionPending = false
    this.chatAsked = ''
    this.chatGoal = ''
    this.chatLogEntries = []
    this.chatSeenIds.clear()
    this.pendingLeadDelivery = null
    this.observedLeadMessages = null
    this.watchChats.clear()
    this.deliveryAttempts.clear()
    this.ownerClarifications = []
    this.scopeRevision++
    this.nativeQuestion = null
    this.decisionGate = false
    this.decisionKind = 'build'
    this.decisionJob = null
    this.decisionText = ''
    this.queuedLeadQuestion = null
    this.leadQuestionRequest = null
    this.decisionOptions = []
    this.goal = ''
    this.capturedSec = 0
    this.sessionId = null
    this.awaiting = null
    this.buildDraft = null
    this.approvedPlan = []
    this.approvedGoal = ''
    this.jobs = []
    this.reviewQueue = []
    this.verdictJob = null
    this.verdictToken = null
    this.integrating = false
    this.integrationBranches = []
    this.planLabels = []
    this.planProtocol = 'marker-v1'
    this.milestones = initialMilestones()
    this.prUrl = ''
    this.lastReply = ''
    this.failReason = ''
    this.finalSummary = ''
    this.repairCount = 0
    this.workerIssue = null
    this.pendingLeadPosts = []
    this.leadPostInFlight = false
    this.queuedStart = null
    this.seenMessageIds.clear()
    this.messageCount = 0
    this.faultKind = null
    this.faultSource = null
    this.faultDetail = ''
    this.faultRetry = null
    this.faultRetryIndex = null
    this.blockedStart = null
    this.missionRepo = ''
    this.baseRef = this.configuredBaseRef
    this.baseSelection = this.baseRef ? 'explicit' : 'default'
    this.baseSha = null
    this.baseRepositoryId = null
    this.activity.clear()
    this.repoName = ''
    this.lastSteer = ''
    this.lastDecision = ''
    this.busy = false
    // A poll the generation bump interrupted never clears its own flag.
    this.pollingLead = false
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

  get hasNavigationLayer(): boolean {
    return this.overlay !== null || this.transient !== null
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
      missionComputerId: this.resolvedComputerId,
      baseRef: this.baseRef,
      baseSha: this.baseSha,
      baseSelection: this.baseSelection,
      baseRepositoryId: this.baseRepositoryId,
      quarantined: this.quarantined,
      requiresFreshApproval: this.requiresFreshApproval,
      initialPlanTurn: this.initialPlanTurn ? { ...this.initialPlanTurn } : null,
      retainedDraft: this.retainedDraft ? { ...this.retainedDraft } : null,
      localEchoes: this.localEchoes.map(e => ({ ...e, beforeMessageIds: e.beforeMessageIds ? [...e.beforeMessageIds] : null })),
      plainQuestionMessageId: this.plainQuestionMessageId,
      blockedStart: this.blockedStart,
      sessionId: this.sessionId,
      awaiting: this.awaiting,
      activityStatus: this.activityStatus(),
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
      chat: this.chatLogEntries.slice(-40),
      chatSeq: this.chatSeqCount,
      chatSeenIds: [...this.chatSeenIds],
      pendingLeadDelivery: this.pendingLeadDelivery ? { ...this.pendingLeadDelivery,
        beforeMessageIds: this.pendingLeadDelivery.beforeMessageIds ? [...this.pendingLeadDelivery.beforeMessageIds] : null } : null,
      nativeQuestion: this.nativeQuestion ? { ...this.nativeQuestion } : null,
      workerIssue: this.workerIssue,
      pendingLeadPosts: this.pendingLeadPosts.map((p) => ({ ...p })),
      queuedStart: this.queuedStart,
      integrationBranches: [...this.integrationBranches],
      paused: this.paused,
      jobs: this.jobs.map((j) => ({
        label: j.label,
        mode: j.mode,
        stage: j.stage,
        agentId: j.agentId,
        runId: j.runId,
        runStatus: j.runStatus,
        sessionId: j.sessionId,
        seenIds: [...j.seenIds],
        requestToken: j.requestToken,
        count: j.count,
        lastCount: j.lastCount,
        awaiting: j.awaiting,
        branch: j.branch,
        state: j.state,
        weight: j.weight,
        pendingPrompt: j.pendingPrompt,
        question: j.question ? { ...j.question, options: [...j.question.options] } : null,
        executionObserved: j.executionObserved === true,
        headSha: j.headSha,
        baseSha: j.baseSha,
      })),
      reviewQueue: [...this.reviewQueue],
      verdictJob: this.verdictJob,
      verdictToken: this.verdictToken,
      integrating: this.integrating,
      decisionPending: this.decisionPending,
      decisionText: this.decisionText,
      decisionOptions: [...this.decisionOptions],
      decisionGate: this.decisionGate,
      decisionKind: this.decisionKind,
      decisionJob: this.decisionJob,
      workerQuestionsRouted: true,
      workerChronologyFixed: true,
      queuedLeadQuestion: this.queuedLeadQuestion
        ? { ...this.queuedLeadQuestion, options: [...this.queuedLeadQuestion.options] } : null,
      leadQuestionRequest: this.leadQuestionRequest,
      planLabels: this.planLabels,
      planProtocol: this.planProtocol,
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
      buildDraft: this.buildDraft ? { ...this.buildDraft, plan: [...this.buildDraft.plan] } : null,
      approvedPlan: [...this.approvedPlan],
      ownerClarifications: [...this.ownerClarifications],
      deliveryAttempts: [...this.deliveryAttempts.values()].map(d => ({ ...d, beforeMessageIds: d.beforeMessageIds ? [...d.beforeMessageIds] : null })),
      deliveryProtocol: 'receipt-v1',
      repoName: this.repoName,
      seq: this.seq,
    }
  }

  restore(snap: unknown): void {
    const s = snap as RealSnapshot | null
    if (!s || s.real !== true || s.v !== 1) return // not ours: start fresh
    if (damagedRealSnapshot(s)) {
      // Quarantine the whole authority-bearing record. Salvage only safe
      // remote identities and receipt holds for inspection/reconciliation.
      const clean = this.snapshot()
      const str = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null
      clean.goal = str(s.goal) ?? 'Saved mission (damaged state)'
      clean.missionRepo = str(s.missionRepo) ?? str(s.repoUrl) ?? ''
      clean.missionComputerId = str(s.missionComputerId)
      clean.sessionId = str(s.sessionId)
      clean.jobs = (Array.isArray(s.jobs) ? s.jobs : []).slice(0, 16).map(row => {
        const j = row && typeof row === 'object' ? row : {} as Partial<RealJob>
        return { label: str(j.label) ?? 'Saved worker', mode: j.mode === 'cursor' ? 'cursor' : 'session',
          stage: 'build', agentId: str(j.agentId), runId: str(j.runId), runStatus: 'unknown',
          sessionId: str(j.sessionId), seenIds: [], count: 0, lastCount: 0, awaiting: null,
          branch: '', state: 'stopped', weight: 0, pendingPrompt: null, question: null }
      })
      clean.phase = clean.sessionId || clean.jobs.length ? 'plan' : 'meet'
      clean.paused = true
      clean.quarantined = true
      clean.requiresFreshApproval = true
      clean.initialPlanTurn = null
      clean.decisionPending = false
      clean.decisionGate = false
      clean.decisionText = ''
      clean.decisionOptions = []
      clean.decisionJob = null
      clean.nativeQuestion = null
      clean.queuedLeadQuestion = null
      clean.pendingLeadPosts = []
      clean.queuedStart = null
      clean.buildDraft = null
      clean.approvedPlan = []
      clean.planLabels = []
      clean.reviewQueue = []
      clean.verdictJob = null
      clean.verdictToken = null
      clean.awaiting = null
      clean.attach = null
      clean.chat = []
      clean.ownerClarifications = []
      clean.pendingLeadDelivery = decodeDeliveryAttempt(s.pendingLeadDelivery)
      clean.deliveryAttempts = (Array.isArray(s.deliveryAttempts) ? s.deliveryAttempts : [])
        .map(decodeDeliveryAttempt).filter((d): d is DeliveryAttempt => d !== null)
      clean.faultKind = 'storage'
      clean.faultSource = 'factory'
      clean.faultDetail = 'Saved execution state is damaged and quarantined. Inspect provider sessions; no restored approval or queued work is trusted.'
      clean.faultRetry = null
      clean.faultRetryIndex = null
      clean.lastSteer = ''
      clean.lastDecision = ''
      clean.workerIssue = null
      clean.retainedDraft = null
      this.restore(clean)
      return
    }
    // Job-based snapshots only; older single-worker formats start fresh.
    if (!Array.isArray(s.jobs)) return
    // The worker setup is fixed at construction (it depends on connected
    // accounts and preferences). A snapshot from another setup belongs to
    // another mission: start fresh rather than track workers we cannot reach.
    if ((s.workerPref ?? 'auto') !== this.workerPref || (s.jobCount ?? 1) !== this.jobCount) return
    // A restore replaces whatever this engine held (a vault row picked on
    // the home): async steps from the previous mission must not land here.
    this.verdictToken = typeof s.verdictToken === 'string' ? s.verdictToken : null
    this.generation += 1
    this.leadDispatchOwner = null
    this.preparingBuild = false
    this.cloudBusy = false
    // A poll the generation bump interrupted never clears its own flag.
    this.pollingLead = false
    this.scopeRevision++
    this.quarantined = s.quarantined === true
    // An older pre-execution cache cannot prove which base/scope its source
    // approved. Preserve its identities/proposal, not an implicit grant.
    this.requiresFreshApproval = s.requiresFreshApproval ?? (!!s.sessionId && s.jobs.length === 0)
    this.initialPlanTurn = s.initialPlanTurn ? { ...s.initialPlanTurn } : null
    this.deliveryAttempts.clear()
    this.localEchoes = (Array.isArray(s.localEchoes) ? s.localEchoes : []).map(decodeDeliveryAttempt)
      .filter((d): d is DeliveryAttempt => d !== null).slice(-32)
    this.plainQuestionMessageId = typeof s.plainQuestionMessageId === 'string' ? s.plainQuestionMessageId : null
    this.ownerClarifications = Array.isArray(s.ownerClarifications) ? s.ownerClarifications.filter((t): t is string => typeof t === 'string') : []
    this.activity.clear()
    this.historyObservations.clear()
    this.observedLeadMessages = null
    this.pendingLeadDelivery = null
    this.watchChats.clear()
    // An unknown phase word would leave the render with no card: fall back
    // to what the restored jobs honestly show (updatePhase derives it) or
    // the meet card when the mission never started.
    const phaseKnown = REAL_PHASES.includes(s.phase)
    this.phase = phaseKnown ? s.phase : 'meet'
    this.goal = s.goal ?? ''
    this.capturedSec = s.capturedSec ?? 0
    // The mission's repository is frozen per mission; older snapshots carry
    // only the global one (which the mission used back then).
    this.missionRepo = s.missionRepo ?? s.repoUrl ?? ''
    // The mission's computer is frozen with it: the resumed session calls
    // keep naming it (old snapshots resolve again on the next start).
    this.resolvedComputerId = s.missionComputerId ?? null
    this.baseRef = typeof s.baseRef === 'string' && s.baseRef.trim() ? s.baseRef : this.baseRef
    this.baseSha = typeof s.baseSha === 'string' ? s.baseSha : null
    // Old snapshots carried an implicit "main", not an owner selection.
    this.baseSelection = s.baseSelection ?? (this.configuredBaseRef ? 'explicit' : 'default')
    if (!s.baseSelection && this.configuredBaseRef) this.baseRef = this.configuredBaseRef
    this.baseRepositoryId = typeof s.baseRepositoryId === 'number' ? s.baseRepositoryId : null
    this.retainedDraft = s.retainedDraft && typeof s.retainedDraft.sessionId === 'string' &&
      typeof s.retainedDraft.text === 'string' ? { ...s.retainedDraft } : null
    this.blockedStart = s.blockedStart ?? null // a later panel save still resumes it
    this.sessionId = s.sessionId ?? null
    this.buildDraft = validBuildDraft(s.buildDraft) && s.buildDraft.sourceSessionId === this.sessionId
      ? { ...s.buildDraft, plan: [...s.buildDraft.plan] } : null
    if (validApprovedPlan(s.approvedPlan)) this.approvedPlan = [...s.approvedPlan]
    else if (s.approvedPlan !== undefined) this.approvedPlan = []
    this.awaiting =
      s.awaiting === 'plan' || s.awaiting === 'verdict' || s.awaiting === 'summary' || s.awaiting === 'steer'
        ? s.awaiting
        : null
    const JOB_STATES: ReadonlyArray<RealJob['state']> = ['building', 'queued', 'review', 'repair', 'accepted', 'stopped']
    const int = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isSafeInteger(v) ? v : fallback
    this.jobs = s.jobs.map((j) => ({
      label: String(j.label ?? ''),
      mode: j.mode === 'cursor' ? 'cursor' : 'session',
      stage: j.stage === 'fix' || j.stage === 'integration' || j.stage === 'pr' ? j.stage : 'build',
      agentId: j.agentId ?? null,
      runId: j.runId ?? null,
      runStatus: j.runStatus ?? '',
      sessionId: j.sessionId ?? null,
      seenIds: Array.isArray(j.seenIds) ? j.seenIds.map(String) : [],
      requestToken: typeof j.requestToken === 'string' ? j.requestToken : undefined,
      count: int(j.count, 0),
      lastCount: int(j.lastCount, 0),
      awaiting: JOB_AWAITING.includes(j.awaiting) ? j.awaiting : null,
      branch: j.branch ?? '',
      // An unknown state word would park the job forever (no poll, no
      // review, no stopped card): a corrupt row falls back to building,
      // which every path can still move.
      state: JOB_STATES.includes(j.state) ? j.state : 'building',
      weight: int(j.weight, 0),
      nextPoll: 0,
      polling: false,
      pendingPrompt: typeof j.pendingPrompt === 'string' && j.pendingPrompt ? j.pendingPrompt : null,
      question: j.question && typeof j.question.text === 'string' && Array.isArray(j.question.options)
        ? { text: j.question.text, options: j.question.options.filter((o): o is string => typeof o === 'string'),
            ...(typeof j.question.messageId === 'string' ? { messageId: j.question.messageId } : {}),
            ...(j.question.native ? { native: { ...j.question.native } } : {}) }
        : null,
      executionObserved: j.executionObserved === true,
      headSha: typeof j.headSha === 'string' ? j.headSha : undefined,
      baseSha: typeof j.baseSha === 'string' ? j.baseSha : undefined,
    }))
    if (s.workerQuestionsRouted !== true || s.workerChronologyFixed !== true) {
      // Re-observe previously swallowed questions on upgrade. Completion
      // replies still need the persisted request token, never a new launch.
      for (const job of this.jobs) if (job.state === 'building') job.seenIds = []
    }
    this.reviewQueue = (Array.isArray(s.reviewQueue) ? s.reviewQueue : [])
      .map(Number)
      .filter((n) => Number.isSafeInteger(n) && n >= 0 && n < this.jobs.length)
    // Indices must name a restored job (as decisionJob does): an
    // out-of-range verdictJob would block every queued review forever.
    this.verdictJob =
      typeof s.verdictJob === 'number' && Number.isSafeInteger(s.verdictJob) && s.verdictJob >= 0 &&
        s.verdictJob < this.jobs.length ? s.verdictJob : null
    // A verdict token answers only the job under review: without one, a
    // matching reply must not accept or fail a job that does not exist.
    if (this.verdictJob === null) this.verdictToken = null
    this.integrating = s.integrating === true
    this.integrationBranches = (Array.isArray(s.integrationBranches) ? s.integrationBranches : [])
      .filter((b): b is string => typeof b === 'string' && b !== '')
    this.queuedLeadQuestion = s.queuedLeadQuestion
      ? { ...s.queuedLeadQuestion, options: [...s.queuedLeadQuestion.options] } : null
    this.leadQuestionRequest = s.leadQuestionRequest ?? null
    this.decisionPending = s.decisionPending ?? false
    this.nativeQuestion = s.nativeQuestion ? { ...s.nativeQuestion } : null
    this.chatSeenIds = new Set(Array.isArray(s.chatSeenIds) ? s.chatSeenIds.filter((id): id is string => typeof id === 'string') : [])
    this.decisionText = s.decisionText ?? ''
    this.decisionOptions = Array.isArray(s.decisionOptions) ? s.decisionOptions.map(String) : []
    // The chat tail rides the snapshot; a restored mission keeps its history
    // without re-logging the goal that was already on the transcript card.
    // Every line keeps the seq it was born with — the archive keys a row on
    // it, so a restore must never reassign one to a different line. Lines
    // from a pre-seq snapshot are an older format: they take fresh seqs in
    // arrival order (the same order the old index-based writer mirrored, so
    // already-archived rows line up), stable from then on.
    const chatRaw: unknown[] = Array.isArray(s.chat) ? s.chat : []
    const shaped = chatRaw
      .map((c): { who: ChatWho; text: string; at: number; seq: number | null } | null => {
        if (c === null || typeof c !== 'object') return null
        const e = c as { who?: unknown; text?: unknown; at?: unknown; seq?: unknown }
        if (!isChatWho(e.who)) return null
        if (typeof e.text !== 'string' || e.text.trim() === '') return null
        const seq = typeof e.seq === 'number' && Number.isSafeInteger(e.seq) && e.seq >= 0 ? e.seq : null
        return { who: e.who, text: e.text, at: Number(e.at) || 0, seq }
      })
      .filter((c): c is { who: ChatWho; text: string; at: number; seq: number | null } => c !== null)
      .slice(-60)
    let synthSeq = shaped.reduce((top, c) => Math.max(top, c.seq ?? -1), -1) + 1
    this.chatLogEntries = shaped.map((c) => ({ who: c.who, text: c.text, at: c.at, seq: c.seq ?? synthSeq++ }))
    // The counter stays ahead of every seq the log holds AND of the
    // persisted watermark: the snapshot's tail slid past lines the archive
    // already holds rows for, and the next line must never reuse one.
    const topSeq = this.chatLogEntries.reduce((top, c) => Math.max(top, c.seq), -1)
    this.chatSeqCount = Math.max(
      topSeq + 1,
      typeof s.chatSeq === 'number' && Number.isSafeInteger(s.chatSeq) && s.chatSeq >= 0 ? s.chatSeq : 0,
    )
    // A pending question the log already carries (computeView logged it
    // before the snapshot) keeps its ask key, so boot does not log it twice.
    // One that never reached the log stays unasked and logs on boot.
    this.chatAsked =
      this.decisionPending && this.chatLogEntries.some((c) => c.who !== 'you' && c.text === this.decisionText)
        ? this.decisionText
        : ''
    // A snapshot from before the chat log existed carries no chat: its goal
    // was never logged, so let the transcript card log it once it shows.
    this.chatGoal = this.chatLogEntries.length > 0 ? this.goal : ''
    this.decisionGate = s.decisionGate ?? false
    this.decisionKind = s.decisionKind === 'pr' ? 'pr' : 'build'
    this.decisionJob = Number.isInteger(s.decisionJob) && s.decisionJob! >= 0 &&
      s.decisionJob! < this.jobs.length && !this.decisionGate ? s.decisionJob! : null
    const a = s.attach
    this.attach =
      a && (a.source === 'factory' || a.source === 'cursor')
        ? {
            source: a.source,
            title: String(a.title ?? ''),
            sessionId: a.sessionId ?? null,
            agentId: a.agentId ?? null,
            runId: a.runId ?? null,
            runStatus: 'unknown',
            computerId: typeof a.computerId === 'string' && a.computerId ? a.computerId : null,
            // The first poll after a restore re-primes: history stays seen,
            // then new replies surface.
            primed: false,
            nextPoll: 0,
            polling: false,
            misses: 0,
            nextRunCheck: 0,
            changedAt: 0,
            checkedAt: null,
          }
        : null
    if (!phaseKnown) this.updatePhase() // the honest phase the restored jobs show
    if (this.phase === 'attach' && !this.attach) this.phase = 'meet'
    this.planLabels = (Array.isArray(s.planLabels) ? s.planLabels : [])
      .filter((l): l is string => typeof l === 'string' && l !== '')
    this.planProtocol = s.planProtocol === 'marker-v1' ? 'marker-v1' : 'legacy'
    // Provisional labels are never approval evidence, including old snapshots.
    if (this.awaiting === 'plan') this.planLabels = []
    this.milestones =
      Array.isArray(s.milestones) && s.milestones.length >= 2 && s.milestones.every(isRealMilestone)
        ? s.milestones
        : initialMilestones()
    this.prUrl = s.prUrl ?? ''
    this.lastReply = s.lastReply ?? ''
    this.failReason = s.failReason ?? ''
    this.finalSummary = s.finalSummary ?? ''
    this.repairCount = int(s.repairCount, 0)
    this.seenMessageIds = new Set(Array.isArray(s.seenMessageIds) ? s.seenMessageIds : [])
    this.messageCount = int(s.messageCount, 0)
    // The owner's pause rides the snapshot: without it a restart silently
    // un-pauses a mission whose lead was interrupted and never told to
    // continue — a stall with no card. Old snapshots never carried it.
    this.paused = s.paused === true
    this.faultKind = typeof s.faultKind === 'string' && s.faultKind ? s.faultKind : null
    this.faultSource =
      s.faultSource === 'factory' || s.faultSource === 'cursor' || s.faultSource === 'github' ? s.faultSource : null
    this.faultDetail = typeof s.faultDetail === 'string' ? s.faultDetail : ''
    this.faultRetry = FAULT_RETRIES.includes(s.faultRetry as FaultRetry) ? (s.faultRetry as FaultRetry) : null
    this.faultRetryIndex =
      typeof s.faultRetryIndex === 'number' && Number.isSafeInteger(s.faultRetryIndex) && s.faultRetryIndex >= 0
        ? s.faultRetryIndex
        : null
    this.lastSteer = s.lastSteer ?? ''
    this.lastDecision = s.lastDecision ?? ''
    this.repoName = s.repoName ?? ''
    this.transient = null
    this.overlay = null
    // A stopped worker's issue card rides the snapshot: without it a restore
    // shows a dead job as a plain building card the owner cannot answer.
    this.workerIssue = typeof s.workerIssue === 'string' && s.workerIssue ? s.workerIssue : null
    // Lead posts a blip interrupted resume too, or the restart inherits the
    // parked step (plan/verdict/summary/answer). Bounded and shape-checked:
    // a malformed row is dropped, never trusted.
    const AWAITING: ReadonlyArray<NonNullable<RealSnapshot['awaiting']>> = ['plan', 'verdict', 'summary', 'steer']
    this.pendingLeadPosts = (Array.isArray(s.pendingLeadPosts) ? s.pendingLeadPosts : [])
      .filter(
        (p): p is NonNullable<RealSnapshot['pendingLeadPosts']>[number] =>
          p !== null && typeof p === 'object' &&
          typeof p.text === 'string' && p.text.trim() !== '' &&
          (p.awaiting === null || AWAITING.includes(p.awaiting)) &&
          typeof p.soft === 'boolean',
      )
      .slice(0, 16)
      .map((p) => ({ text: p.text, awaiting: p.awaiting, soft: p.soft,
        protectDelivery: true,
        legacyDeliveryUnknown: p.legacyDeliveryUnknown === true || s.deliveryProtocol !== 'receipt-v1' }))
    const delivery = s.pendingLeadDelivery
    if (delivery && delivery.sessionId === this.sessionId && typeof delivery.text === 'string' && delivery.text.trim()) {
      this.pendingLeadDelivery = { sessionId: delivery.sessionId, text: delivery.text,
        beforeMessageIds: Array.isArray(delivery.beforeMessageIds) && delivery.beforeMessageIds.length <= 2000 &&
          delivery.beforeMessageIds.every(id => typeof id === 'string') ? [...delivery.beforeMessageIds] : null }
    }
    for (const d of Array.isArray(s.deliveryAttempts) ? s.deliveryAttempts : []) {
      const attempt = decodeDeliveryAttempt(d)
      if (attempt) this.deliveryAttempts.set(attempt.sessionId, attempt)
    }
    if (this.pendingLeadDelivery) this.deliveryAttempts.set(this.pendingLeadDelivery.sessionId, this.pendingLeadDelivery)
    if (this.sessionId) this.pendingLeadDelivery = this.deliveryAttempts.get(this.sessionId) ?? null
    if (s.initialPlanTurn === undefined && this.sessionId && this.phase === 'plan' &&
      !this.planLabels.length && this.faultRetry === 'plan') {
      // Old successful-but-unreadable POSTs and old definite rejections used
      // the same faultRetry. There is no safe way to infer unsent from it.
      this.initialPlanTurn = { sessionId: this.sessionId, text: null, state: 'unknown' }
      this.requiresFreshApproval = true
      this.awaiting = 'plan'
      this.faultKind = null
      this.faultSource = null
      this.faultDetail = ''
      this.faultRetry = null
      this.faultRetryIndex = null
      if (!this.deliveryAttempts.has(this.sessionId)) {
        this.beginDelivery(this.sessionId, this.legacyInitialPlanText(), null)
      }
    }
    // A partial older cache may retain the uncertainty proof while omitting
    // its receipt collection. Never reinterpret that omission as acceptance.
    if (this.initialPlanTurn?.state === 'unknown' && this.initialPlanTurn.sessionId === this.sessionId &&
      !this.deliveryAttempts.has(this.initialPlanTurn.sessionId)) {
      this.beginDelivery(this.initialPlanTurn.sessionId, this.initialPlanTurn.text ?? this.legacyInitialPlanText(), null)
    }
    // Old pending execution prompts do not distinguish unsent traffic from
    // a dispatched request whose acknowledgment was lost. Never guess.
    if (s.deliveryProtocol !== 'receipt-v1') {
      for (const job of this.jobs) if (job.sessionId && job.pendingPrompt) {
        this.deliveryAttempts.set(job.sessionId, { sessionId: job.sessionId, text: job.pendingPrompt, beforeMessageIds: null })
        job.pendingPrompt = null
      }
    }
    // Old builds mislabeled gateway failures as terminal service failures.
    // Reopen reads, but never replay a possibly delivered steering request.
    if (this.faultSource === 'factory' && this.faultKind === 'service' &&
      /Factory HTTP (502|504)\b/.test(this.faultDetail) &&
      (this.faultRetry === null || this.faultRetry === 'steer')) {
      if (this.faultRetry === 'steer' && this.sessionId) {
        this.pendingLeadDelivery ??= { sessionId: this.sessionId,
          text: this.lastSteer.trim() || 'Previous request (text unavailable)', beforeMessageIds: null }
      }
      this.faultKind = null
      this.faultSource = null
      this.faultDetail = ''
      this.faultRetry = null
      this.faultRetryIndex = null
    }
    this.leadPostInFlight = false
    // A confirmed step the restart interrupted runs on the first tick: the
    // gate was already consumed, so nothing else would ever start it.
    this.queuedStart =
      s.queuedStart === 'build' || s.queuedStart === 'pr' || s.queuedStart === 'integration' ? s.queuedStart : null
    // The scene counter rides the snapshot: scenes carry sceneId/stateSequence
    // from it, and a restart that rewound it to zero would re-emit ids the
    // surfaces already saw (a restore must never replay an old identity).
    this.seq = typeof s.seq === 'number' && Number.isSafeInteger(s.seq) && s.seq >= 0 ? s.seq : 0
    this.busy = false
    if (this.buildDraft && this.buildDraft.sourceSessionId === this.sessionId &&
      ((this.phase === 'attach' && this.managedWatchHandoff) || this.phase === 'plan') && !this.nativeQuestion &&
      !this.decisionPending && !this.pendingLeadDelivery) this.overlay = 'chat_build'
  }
}

/** The restore's allow-lists for snapshot fields (untrusted persisted JSON). */
const REAL_PHASES: ReadonlyArray<RealPhase> = [
  'meet', 'goal', 'transcript', 'plan', 'building', 'review', 'repair', 'pr', 'final', 'attach',
]
const FAULT_RETRIES: ReadonlyArray<FaultRetry> = [
  'plan', 'repo', 'build', 'fix', 'integration', 'pr', 'verdict', 'summary', 'decision', 'steer',
]
const JOB_AWAITING: ReadonlyArray<NonNullable<RealJob['awaiting']>> = ['build', 'fix']

/** Persisted records cannot restore grants by coercing arbitrary JSON values. */
function damagedRealSnapshot(s: RealSnapshot): boolean {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const string = (v: unknown): boolean => v === undefined || v === null || typeof v === 'string'
  const strings = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.every(x => typeof x === 'string'))
  const native = (v: unknown): boolean => v === undefined || v === null || (object(v) &&
    typeof v.toolId === 'string' && !!v.toolId.trim() && typeof v.sessionId === 'string' && !!v.sessionId.trim())
  const question = (v: unknown): boolean => v === undefined || v === null || (object(v) &&
    typeof v.text === 'string' && Array.isArray(v.options) && strings(v.options) && native(v.native))
  if (!REAL_PHASES.includes(s.phase)) return true
  if (s.quarantined !== undefined && typeof s.quarantined !== 'boolean') return true
  if (s.requiresFreshApproval !== undefined && typeof s.requiresFreshApproval !== 'boolean') return true
  if (s.initialPlanTurn !== undefined && s.initialPlanTurn !== null) {
    const turn = s.initialPlanTurn
    if (!object(turn) || turn.sessionId !== s.sessionId || typeof turn.sessionId !== 'string' ||
      !['unsent', 'unknown', 'accepted'].includes(turn.state) ||
      (typeof turn.text !== 'string' && !(turn.text === null && turn.state === 'unknown')) ||
      (typeof turn.text === 'string' && !turn.text.trim())) return true
  }
  if (s.baseSelection !== undefined && s.baseSelection !== 'explicit' && s.baseSelection !== 'default') return true
  if (s.baseSha !== undefined && s.baseSha !== null &&
    (typeof s.baseSha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(s.baseSha))) return true
  if (s.baseRepositoryId !== undefined && s.baseRepositoryId !== null &&
    (typeof s.baseRepositoryId !== 'number' || !Number.isSafeInteger(s.baseRepositoryId) || s.baseRepositoryId <= 0)) return true
  if (s.baseSha && (!s.baseRef || s.baseRepositoryId === undefined || s.baseRepositoryId === null)) return true
  if (!Array.isArray(s.jobs) || s.jobs.length > 16) return true
  for (const j of s.jobs) {
    if (!object(j) || !string(j.label) || !string(j.sessionId) || !string(j.agentId) || !string(j.runId) ||
      !string(j.branch) || !string(j.runStatus) || !string(j.pendingPrompt) || !strings(j.seenIds) || !question(j.question)) return true
    if (j.question?.native && j.question.native.sessionId !== j.sessionId) return true
    if (j.mode !== undefined && !['cursor', 'session'].includes(j.mode)) return true
    if (j.stage !== undefined && !['build', 'fix', 'integration', 'pr'].includes(j.stage)) return true
    if (j.state !== undefined && !['building', 'queued', 'review', 'repair', 'accepted', 'stopped'].includes(j.state)) return true
  }
  const top = ['goal', 'repoUrl', 'missionRepo', 'missionComputerId', 'sessionId', 'decisionText', 'prUrl',
    'lastReply', 'failReason', 'finalSummary', 'lastSteer', 'lastDecision', 'repoName', 'leadQuestionRequest', 'baseRef'] as const
  if (top.some(k => !string(s[k])) || !strings(s.decisionOptions) || !strings(s.planLabels) ||
    !strings(s.seenMessageIds) || !question(s.queuedLeadQuestion) || !native(s.nativeQuestion)) return true
  if (s.attach && (!object(s.attach) || !string(s.attach.title) || !string(s.attach.sessionId) ||
    !string(s.attach.agentId) || !string(s.attach.runId) || !string(s.attach.computerId))) return true
  for (const field of ['decisionPending', 'decisionGate', 'paused', 'integrating'] as const) {
    if (s[field] !== undefined && typeof s[field] !== 'boolean') return true
  }
  if (s.nativeQuestion) {
    const owner = Number.isInteger(s.decisionJob) && s.decisionJob! >= 0
      ? s.jobs[s.decisionJob!]?.sessionId : s.sessionId
    if (s.nativeQuestion.sessionId !== owner) return true
  }
  if (s.queuedLeadQuestion?.native && s.queuedLeadQuestion.native.sessionId !== s.sessionId) return true
  if (s.deliveryAttempts !== undefined && (!Array.isArray(s.deliveryAttempts) ||
    s.deliveryAttempts.some(d => decodeDeliveryAttempt(d) === null))) return true
  if (s.pendingLeadDelivery && decodeDeliveryAttempt(s.pendingLeadDelivery) === null) return true
  return false
}

/** A milestone row a snapshot may carry: shape-checked, never trusted. */
function isRealMilestone(m: unknown): m is RealMilestone {
  if (m === null || typeof m !== 'object') return false
  const x = m as { id?: unknown; label?: unknown; weight?: unknown; status?: unknown }
  return (
    typeof x.id === 'string' && x.id !== '' &&
    typeof x.label === 'string' &&
    typeof x.weight === 'number' && Number.isSafeInteger(x.weight) && x.weight >= 0 &&
    (x.status === 'pending' || x.status === 'submitted' || x.status === 'repair' || x.status === 'accepted')
  )
}
