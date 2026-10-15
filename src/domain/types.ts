/**
 * Spriite domain model — schema v2 (Persistent Companion spec §6).
 *
 * The runtime owns this model; views are projections and never mutate it.
 * Every durable record carries schemaVersion so future migrations can
 * distinguish revisions honestly instead of guessing.
 *
 * Baseline defects this model retires (spec §3): goal-keyed projects are
 * replaced by ID-keyed missions (two requests with identical wording are
 * two missions); no fixed cap can evict active work; per-mission config is
 * frozen at creation so changed global preferences cannot prevent
 * restoration; and control mode (paused) is explicit durable state, not an
 * implicit resume.
 */

import type { ExecutionBackend, NativeIntent, NativeLaunchProfile } from '../native/protocol'

/** Mission phases, in normal-path order (spec §7). */
export const MISSION_PHASES = [
  'received',
  'gathering_context',
  'planning',
  'ready',
  'building',
  'reviewing',
  'repairing',
  'integrating',
  'awaiting_decision',
  'completed',
  'failed',
  'cancelled',
] as const
export type MissionPhase = (typeof MISSION_PHASES)[number]

/** Terminal phases keep their evidence and records (retention applies later). */
export const TERMINAL_PHASES: readonly MissionPhase[] = ['completed', 'failed', 'cancelled']

/** The one terminal-phase test: views, briefings, and the runtime all agree. */
export function isTerminalPhase(phase: MissionPhase): boolean {
  return TERMINAL_PHASES.includes(phase)
}

/** Control is orthogonal to phase (spec §7). */
export const CONTROL_MODES = ['running', 'pause_requested', 'paused', 'cancel_requested'] as const
export type ControlMode = (typeof CONTROL_MODES)[number]

/** Freshness says when state was last confirmed against provider reality. */
export const FRESHNESS = ['current', 'stale', 'reconciling', 'unknown'] as const
export type Freshness = (typeof FRESHNESS)[number]

export const DISPATCH_STATES = ['prepared', 'sending', 'confirmed', 'unknown', 'rejected'] as const
export type DispatchState = (typeof DISPATCH_STATES)[number]

export const INPUT_SOURCES = ['phone_text', 'phone_voice', 'glasses_voice', 'x'] as const
export type InputSource = (typeof INPUT_SOURCES)[number]

export type ProviderKind = 'factory' | 'cursor' | 'x'

/**
 * A normalized owner request (spec §10): every surface (phone text, phone
 * voice, glasses voice, X) becomes one of these before the pipeline runs.
 * The dedupeKey is what makes duplicate deliveries harmless.
 */
export interface CommandEnvelope {
  schemaVersion: 2
  commandId: string
  source: InputSource
  sourceEventId: string
  ownerId: string
  receivedAt: string
  issuedAt?: string
  text: string
  productHint?: string
  targetMissionId?: string
  contextRefs: string[]
  dedupeKey: string
  policyRevision: string
}

/**
 * The Factory session settings a mission froze when it was created (spec §7):
 * the lead session's model, effort, mode and autonomy, the worker sessions'
 * model, effort, extra instructions and tool policy. Absent keys mean "leave
 * Factory's account default" — never an empty choice sent upstream.
 *
 * Frozen, not live: the API only accepts extra instructions and the tool
 * policy at CREATE time (they are not in the update schema), and Factory
 * never reports settings back, so a save mid-build could not be honored or
 * even confirmed. A save therefore applies to the next build.
 */
export interface MissionSessionSettings {
  interactionMode?: string
  specModeModel?: string
  specModeReasoningEffort?: string
  leadModel?: string
  leadReasoningEffort?: string
  leadAutonomyLevel?: string
  workerModel?: string
  workerReasoningEffort?: string
  /** Appended to the worker's own system prompt, never replacing it. */
  workerInstructions?: string
  workerEnabledToolIds?: string[]
  workerDisabledToolIds?: string[]
  workerRestrictToolIds?: string[]
}

/** Frozen at mission creation; global preference changes apply to new
 *  missions only unless the owner explicitly migrates (spec §7). */
export interface MissionConfig {
  /** Absent means established pre-native legacy ownership, never a default. */
  readonly executionBackend?: ExecutionBackend
  readonly nativeIntent?: NativeIntent
  readonly nativeProfile?: NativeLaunchProfile
  /** Damaged/unsupported ownership is held, never reconstructed as legacy. */
  nativeQuarantine?: string
  /** Where a native intent came from. Absent reads as 'generic'. */
  nativeOrigin?: 'x' | 'generic'
  /**
   * A held (unapproved) native intent the owner resolved: superseded by an
   * approved promotion, or dismissed. Its actor is never respawned.
   */
  nativeHeldResolution?: { outcome: 'promoted'; missionId: string } | { outcome: 'dismissed' }
  leadProvider: 'factory'
  workerProviders: Array<'factory' | 'cursor'>
  maxConcurrentWorkers: number
  repository: string
  baseRef: string
  policyRevision: string
  /**
   * The session settings this mission's Factory sessions were created with.
   * Absent when the owner had chosen nothing (the account defaults stand) and
   * for every mission created before this field existed.
   */
  sessionSettings?: MissionSessionSettings
  /**
   * The engine's worker preference as of creation ('auto', 'cursor',
   * 'factory', 'mix'). `workerProviders` says which providers MAY run the
   * worker role; this says how the mission actually splits it, which is what
   * an engine restore needs to reproduce the same setup (spec §7, §25.6).
   */
  workerPreference?: 'auto' | 'cursor' | 'factory' | 'mix'
  /**
   * The owner started this mission as "New repo": it owns no repository yet
   * and must CREATE one, never adopt the configured default. Recorded
   * durably so a relaunch resumes the create instead of quietly planning on
   * the default repository (the owner's report: New repo did nothing).
   */
  newRepository?: boolean
  /**
   * The repository name the owner typed on the phone for that create, when
   * they did. Absent means the engine derives the name from the goal.
   */
  newRepositoryName?: string
  /**
   * The owner already approved starting this build where they asked for it
   * (an X post): once the plan lands the build starts with no Start tap,
   * since nobody is at the glasses to give one. Pause, capacity, and the PR
   * gate still apply.
   */
  startApproved?: boolean
  /** A locally reviewed watched-chat scope. It bypasses planning, not policy. */
  approvedPlan?: string[]
  buildSourceSessionId?: string
}

export interface Mission {
  schemaVersion: 2
  missionId: string
  entityId: string
  productId: string
  originatingCommandId: string
  title: string
  goal: string
  phase: MissionPhase
  control: ControlMode
  freshness: Freshness
  /**
   * The phase a decision interrupted (spec §7: "Any phase can require a
   * decision; record the suspended phase and resume target explicitly").
   * Null while no decision is holding the mission.
   */
  suspendedPhase?: MissionPhase | null
  planRevision: number
  config: MissionConfig
  activeRunIds: string[]
  decisionIds: string[]
  lastAppliedSeq: number
  lastObservedAt: string | null
  createdAt: string
  updatedAt: string
}

/** A provider-side execution the runtime can observe (spec §6). */
export interface ProviderRun {
  schemaVersion: 2
  runId: string
  missionId: string
  provider: 'factory' | 'cursor'
  role: 'lead' | 'worker'
  accountId: string | null
  /** Factory sessionId or Cursor agentId, whichever the provider uses. */
  sessionOrAgentId: string | null
  /** Cursor runId when the provider nests runs under agents. */
  remoteRunId: string | null
  branch: string
  baseSha: string
  currentSha: string
  observedState: string
  lastObservedAt: string | null
}

/**
 * Durable dispatch intent (spec §8): written BEFORE any remote launch call;
 * recovered and reconciled after a crash, never blindly retried.
 */
export interface DispatchRecord {
  schemaVersion: 2
  actionId: string
  missionId: string
  runtimeEpoch: number
  provider: ProviderKind
  /** Deterministic request key: a retried send reuses it. */
  requestKey: string
  requestHash: string
  state: DispatchState
  attempts: number
  remoteIds: string[]
  createdAt: string
  updatedAt: string
}

/** An owner question with stable option IDs (stale views cannot approve a
 *  changed decision — compare revisions, spec §20). */
export interface DecisionRecord {
  schemaVersion: 2
  decisionId: string
  missionId: string | null
  revision: number
  question: string
  /** Optional for legacy records; binds an answer to question and destination. */
  questionIdentity?: string
  options: Array<{ optionId: string; label: string }>
  scope: string
  consequence: string
  expiryAt: string | null
  openedAt: string
  answeredAt: string | null
  answerOptionId: string | null
  answerText: string | null
}

/** The stable Spriite identity that survives every provider session. */
export interface EntityRecord {
  schemaVersion: 2
  entityId: string
  name: string
  preferencesRevision: string
  createdAt: string
}

/** What a briefing was built for. An owner-wide return briefing covers
 *  everything up to its target; a mission-scoped one covers only that
 *  mission's window (switching to a mission, spec §16). */
export type BriefingScope = { kind: 'owner' } | { kind: 'mission'; missionId: string }

/** The return-briefing variants (spec §16): a delta account, a nothing-new
 *  status line, or the runtime-absent line. 'return' and 'absent' carry a
 *  fixed target the owner acknowledges; 'status' is a repeatable one-liner. */
export const BRIEFING_KINDS = ['return', 'status', 'absent'] as const
export type BriefingKind = (typeof BRIEFING_KINDS)[number]

/**
 * One ranked briefing card. The copy is direct outcome language; the exact
 * event ids it was built from ride along so the phone can show the
 * event-backed detail and so acknowledgement can name what it covered.
 */
export interface BriefingCard {
  /** 1: urgent decision or failure; 2: completed/accepted work; 3: material
   *  repair or scope change; 4: current work and next step; 5: status only. */
  rank: 1 | 2 | 3 | 4 | 5
  missionId?: string
  headline: string
  detail?: string
  /** The most useful evidence link (a PR URL), when one exists. */
  evidenceUrl?: string
  /** Set while the card is an unresolved decision the owner must answer. */
  decisionId?: string
  /** Native request ownership/version/state, not a generic legacy decision grant. */
  nativeRequestKey?: string
  /** `current` claims nothing beyond the last observation; anything older is
   *  labeled last-known (spec §5, §25.23). */
  freshness: Freshness
  lastObservedAt: string | null
  coveredEventIds: string[]
}

/** A durable return briefing (spec §6/§16): fixed journal target, exact
 *  covered event ids, and the cards built from them. */
export interface BriefingRecord {
  schemaVersion: 2
  briefingId: string
  scope: BriefingScope
  kind: BriefingKind
  /** Fixed at build: events with seq above this were never considered. */
  targetSeq: number
  /** The exact meaningful event ids covered; acknowledgement names them. */
  coveredEventIds: string[]
  /** missionId -> planRevision at build time (a stale view is detectable). */
  missionRevisions: Record<string, number>
  /**
   * Set when the briefing had to tell the owner that earlier changes were
   * compacted before they could be seen: the last seq that is provably
   * unseeable (the window starts at `gapBeforeSeq + 1`). Acknowledging the
   * card settles the gap — those seqs can never be re-covered, so leaving
   * them below the watermark would repeat the gap card forever (§9/§16).
   */
  gapBeforeSeq?: number
  cards: BriefingCard[]
  createdAt: string
}

/** One delivery attempt to a surface. Kept per-surface and separately from
 *  acknowledgement: transport success is never proof of reading (§16). */
export interface BriefingDelivery {
  briefingId: string
  surfaceId: string
  deliveredAt: string
}

/**
 * One domain fact (spec §9). Events record facts and references, never
 * presentation; ordering authority is the local journal seq assigned at
 * commit time. Provider timestamps stay evidence inside payloads.
 */
export interface DomainEvent {
  schemaVersion: 2
  eventId: string
  seq: number
  entityId: string
  missionId?: string
  type: string
  observedAt: string
  occurredAt?: string
  causalCommandId?: string
  providerEventId?: string
  payload: Record<string, unknown>
}

/** The full durable runtime state — one commit envelope's state payload. */
export interface SpriiteState {
  schemaVersion: 2
  entity: EntityRecord
  missions: Mission[]
  runs: Record<string, ProviderRun>
  outbox: DispatchRecord[]
  decisions: DecisionRecord[]
  /** Consumed provider/intake cursors, advanced only inside a commit. */
  cursors: Record<string, string>
  /** Owner-wide briefing coverage watermark (spec §16). */
  acknowledgedSeq: number
  /**
   * Sparse acknowledgements: eventId -> ack time, for covered events beyond
   * the contiguous watermark (mission-scoped briefings). Pruned to the
   * watermark at ack time so it stays bounded.
   */
  acknowledgedEvents?: Record<string, string>
  /** Unacknowledged briefings, oldest first (usually zero or one). */
  briefings?: BriefingRecord[]
  /** Per-surface delivery attempts; never proof of reading. Bounded per surface. */
  briefingDeliveries?: BriefingDelivery[]
  /** Set once by the v1 migration; guards against re-running it. */
  migratedFromV1: boolean
  /**
   * Per-mission engine working state (the lead engine's own snapshot,
   * restored as-is by the owning mission actor). Domain fields above stay
   * canonical for views and briefings; this record is runtime machinery.
   */
  engineSnapshots?: Record<string, unknown>
  /**
   * Command dedupe ledger: dedupeKey -> commandId. Lets a duplicate delivery
   * resolve to the original receipt instead of creating a second mission
   * (spec §9/§10). Compact tombstones; retention compacts it later.
   */
  commandDedupe?: Record<string, string>
  /** Owner X intake (spec §11): binding, checkpoint, private receipts. */
  xFollowups?: XFollowup[]
  xIntake?: XIntakeState
  /** Captured request context keyed by commandId (spec §12). Bounded. */
  contextArtifacts?: Record<string, ContextArtifact[]>
}

// ------------------------------------------------------------- X intake

/**
 * The owner's X binding (spec §11). Authority is the NUMERIC ids; handles are
 * display labels that can change. The credential is referenced by vault key,
 * never stored here.
 */
export interface XOwnerBinding {
  ownerXUserId: string
  ownerHandle: string
  spriiteXUserId: string
  spriiteHandle: string
  verifiedAt: string
  /** How ownership was proven: the owner's own user-context token answered /2/users/me. */
  verification: 'users_me'
  credentialRef: string
  enabled: boolean
  /** Protected-account delivery is a separate capability gate (§11). */
  protectedOwner: boolean
  /** The configured product an X build goes to when the post names none. */
  defaultRepository?: string
}

export const X_RECEIPT_STATUSES = [
  'submitted',
  'extended',
  'status_reported',
  'held_window',
  'held_confirm',
  'clarify',
  'dismissed',
] as const
export type XReceiptStatus = (typeof X_RECEIPT_STATUSES)[number]

/** Targeted X words, immutable across deliveries; attempts require explicit owner consent. */
export interface XFollowup {
  dedupeKey: string
  ownerId: string
  missionId: string
  instruction: string
  state: 'pending' | 'sending' | 'sent' | 'unknown' | 'dismissed'
  attempt: number
  receivedAt: string
}

/** One private receipt per logical owner post. Never posted back to X. */
export interface XIntakeReceipt {
  dedupeKey: string
  logicalPostId: string
  /** The newest revision (edit) this receipt was evaluated against. */
  revisionId: string
  conversationId: string | null
  status: XReceiptStatus
  /** Why it was held or needs clarification (short, owner-facing). */
  reason?: string
  /** The owner's own instruction, mentions stripped (local only, never logged). */
  instruction: string
  postedAt: string
  /** False when legacy restore or missing upstream time substituted receive time. */
  postedAtTrusted?: boolean
  /** Local delivery facts; an archive receipt alone does not attest delivery. */
  followupDelivery?: XFollowup['state']
  followupAttempt?: number
  receivedAt: string
  via: 'catch_up' | 'stream' | 'import'
  commandId?: string
  missionId?: string
  repository?: string
  /** A held new-or-existing ask: the project the owner's post named. */
  projectName?: string
  /** A held new-or-existing ask: the owner's repositories that match it. */
  repositoryChoices?: string[]
  /** An edit observed after dispatch: a proposed change, never applied silently. */
  proposedRevisionId?: string
  /** The post was deleted on X; recorded, never a cancellation. */
  deletedAt?: string
}

export interface XDeliveryGap {
  from: string
  to: string
  reason: string
  observedAt: string
}

export interface XIntakeState {
  binding: XOwnerBinding | null
  /** Last attempt (successful or not) — "has the connection been checked". */
  lastCheckedAt: string | null
  /** The start of the last fully successful check; the next catch-up overlaps it. */
  lastSuccessAt: string | null
  lastError: string | null
  lastReceivedAt: string | null
  lastReceivedPostId: string | null
  /** The newest post id the last successful check saw (any post, not only requests). */
  lastSeenPostId?: string | null
  receipts: XIntakeReceipt[]
  gaps: XDeliveryGap[]
  /** Non-owner or spoofed triggers refused before planning: a count, no content. */
  rejectedCount: number
}

/** One captured piece of request context with provenance (spec §12). */
export interface ContextArtifact {
  artifactId: string
  kind:
    | 'x_post'
    | 'link'
    /** A GitHub repository's readme, issue, or pull request opened through the owner's token. */
    | 'github_repo'
    | 'github_issue'
    | 'github_pull'
  /** Whose words these are: only the owner's instruction is an instruction. */
  role: 'owner_instruction' | 'parent_post' | 'quoted_post' | 'thread_post' | 'link'
  sourceId: string
  authorId: string | null
  authorIsOwner: boolean
  retrievedAt: string
  contentHash: string | null
  completeness: 'complete' | 'truncated' | 'unavailable' | 'not_fetched'
  method: 'x_api_v2' | 'x_event_payload' | 'github_api' | 'none'
  text: string
  missingReason?: string
}
