/**
 * Spriite's broker protocol, not Factory RPC names.
 * No credentials or optimistic approval/closure belong in these records.
 */
export const NATIVE_PROTOCOL_VERSION = 1 as const
export type ExecutionBackend = 'legacy' | 'factory_native'
export type NativeState =
  | 'held' | 'planning' | 'awaiting_input' | 'initializing'
  | 'running' | 'paused' | 'orchestrator_turn' | 'completed'
export type NativeCommandKind = 'prepare' | 'owner_turn' | 'answer' | 'pause' | 'resume' | 'cancel'
export type NativeCommandState = 'prepared' | 'invoked' | 'confirmed' | 'rejected' | 'unknown'

export interface NativeCapabilities {
  protocolVersion: 1
  qualificationId: string | null
  transportVersion: string
  qualified: boolean
  launch: boolean
  rootAttention: boolean
  childAttention: boolean
  recoverAttention: boolean
  pause: boolean
  resume: boolean
  cancel: boolean
  /** The host's `gh` sign-in for github.com; absent on brokers before it. */
  github?: { available: boolean; login: string | null }
}

/** Non-secret future-job defaults. Consent is always per frozen job. */
export interface NativeLaunchProfile {
  brokerUrl: string
  ownerId: string
  machineId: string
  cwd: string
  baseRef: string
  /** Absent preserves the exact legacy static cwd; never inferred from its path. */
  workspaceMode?: 'host_managed'
  /** Explicit managed-mode host root. cwd remains the retained static profile field. */
  hostRoot?: string
}

export interface NativeWorkspace {
  machineId: string
  cwd: string
  repository: string
  baseRef: string
  baseSha?: string
}

export interface NativePolicy {
  autonomy: 'high'
  allowCreateRepository: boolean
  allowPush: boolean
  allowPr: boolean
  allowMerge: boolean
  allowDeploy: boolean
  /** Legacy explicit record only; new drafts omit this. The native host refuses hard caps. */
  budget?: { unit: string; capUnits: string }
}

export interface NativeIntent {
  protocolVersion: 1
  missionId: string
  ownerId: string
  commandId: string
  goal: string
  scopeRevision: number
  operation: 'implement' | 'integrate' | 'clone' | 'fork' | 'inspect'
  destination?: {
    kind: 'existing' | 'new_repository'
    account: string
    name: string
    visibility: 'private' | 'public'
    initialization: 'empty' | 'scaffold' | 'clone' | 'fork'
    sourceUrl?: string
  }
  workspace: NativeWorkspace
  references: string[]
  acceptanceCriteria: string[]
  restrictions: string[]
  policy: NativePolicy
  scopeApproved: boolean
  highAutonomyApproved: boolean
  settings: Record<string, string | boolean | string[]>
}

export interface NativeOption {
  id: string
  label: string
  value: string
}

export interface NativeQuestion {
  index: number
  topic: string
  question: string
  multiSelect: boolean
  options: NativeOption[]
}

export interface NativeAttention {
  attentionId: string
  requestId: string
  sessionId: string
  machineId: string
  toolUseIds: string[]
  associatedSessionIds: string[]
  revision: number
  payloadHash: string
  kind: 'ask_user' | 'permission' | 'proposal' | 'start' | 'unsupported'
  title: string
  details: string
  options: NativeOption[]
  questions: NativeQuestion[]
  state: 'open' | 'answer_unknown' | 'resolved'
  openedAt: string
  resolvedAt: string | null
}

export interface NativeAnswer {
  attentionId: string
  requestId: string
  sessionId: string
  machineId: string
  revision: number
  payloadHash: string
  selectedOption?: string
  answers?: Array<{ index: number; answer: string }>
  cancelled?: boolean
}

export interface NativeCommand {
  protocolVersion: 1
  commandId: string
  missionId: string
  ownerId: string
  kind: NativeCommandKind
  expectedScopeRevision: number
  expectedBrokerSeq: number
  text?: string
  answer?: NativeAnswer
}

export interface NativeCommandReceipt {
  commandId: string
  state: NativeCommandState
  reason: string | null
}

/**
 * Mission v1 features, or Mission v2 plan checks projected onto the same
 * shape (met → completed, waived → cancelled). `unmet` is a v2 evaluation
 * outcome and is never a done state.
 */
export interface NativeFeature {
  id: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'unmet'
  expectedBehavior: string[]
  milestone?: string
}

export interface NativeHistoryEntry {
  id: string
  who: 'owner' | 'factory' | 'spriite'
  text: string
  at: string
}

export interface NativeBinding {
  sessionId: string
  machineId: string
  cwd: string
  repository: string
  baseRef: string
  baseSha: string | null
}

export interface NativeFinalization {
  state: 'pending' | 'complete' | 'incomplete'
  summary: string | null
  reason: string | null
  /** URLs are claims until independently verified. */
  evidence: Array<{ id: string; url: string; verified: boolean; commitSha: string | null }>
}

export interface NativeSnapshot {
  protocolVersion: 1
  backend: 'factory_native'
  missionId: string
  ownerId: string
  scopeRevision: number
  brokerSeq: number
  state: NativeState
  control: 'running' | 'pause_requested' | 'paused' | 'cancel_requested' | 'cancelled'
  binding: NativeBinding | null
  capabilities: NativeCapabilities
  attention: NativeAttention[]
  features: NativeFeature[]
  history: NativeHistoryEntry[]
  commands: NativeCommandReceipt[]
  lastObservedAt: string | null
  completeness: 'complete' | 'gap' | 'unknown'
  holdReason: string | null
  finalization: NativeFinalization | null
  /** Broker-performed delivery after completion; absent until the broker reports it. */
  delivery?: NativeDeliveryState
  /** Next-day usage report; informational, never an enforced budget. */
  usage?: NativeUsage
  /** Broker fields Spriite could not decode and therefore ignored. */
  diagnostics?: string[]
}

export type NativeDeliveryStep =
  | 'held' | 'pushed' | 'pr_open' | 'checks_pending' | 'checks_failed' | 'merged' | 'not_merged'
export interface NativeDeliveryState {
  step: NativeDeliveryStep
  branch: string
  headSha: string
  prUrl?: string
  prNumber?: number
  checks?: { total: number; passed: number; failed: number; pending: number }
  reason?: string
  updatedAt: string
}
export interface NativeUsage {
  state: 'pending' | 'available' | 'unavailable'
  credits?: number
}

/** Owner settings applied to new native jobs; shown read-only at review. */
export interface NativeDeliveryDefaults {
  createPrivateRepositories: boolean
  pushBranch: boolean
  openPr: boolean
  mergeAfterChecks: boolean
}

export interface NativeBrokerClient {
  capabilities(): Promise<NativeCapabilities>
  prepare(intent: NativeIntent): Promise<NativeSnapshot>
  observe(missionId: string, ownerId: string): Promise<NativeSnapshot>
  command(command: NativeCommand): Promise<NativeCommandReceipt>
  /** Explicit read-only admission inspection; never initializes or sends a goal. */
  inspectAdmission?(draft: NativeAdmissionDraft): Promise<NativeAdmissionPreview>
}

/** Before owner scope/High consent, with IDs reserved by main for exact hashing. */
export type NativeAdmissionDraft = Omit<NativeIntent, 'scopeApproved' | 'highAutonomyApproved'>
export interface NativeAdmissionPreview {
  protocolVersion: 1
  missionId: string
  ownerId: string
  draftHash: string
  workspace: NativeWorkspace & { baseSha: string }
  /** Prospective/permitted settings, not initialized effective settings. */
  prospectiveSettings: NativeIntent['settings']
  observedAt: string
  expiresAt: string
  launchEligible: boolean
  holds: string[]
}

/** Actor-neutral durable projection. Native code must never fake RealSnapshot. */
export interface MissionPresentation {
  backend: ExecutionBackend
  phase: string
  activityStatus: string
  decisionPending: boolean
  decisionText: string
  decisionOptions: string[]
  questionIdentity: string | null
  faultKind: string | null
  finalSummary: string
  failReason: string
  hasUnconfirmedDelivery: boolean
  native: NativeSnapshot | null
}

/** A saved native intent still waiting for the owner's scope and High approval. */
export interface HeldNativeIntent {
  missionId: string
  origin: 'x' | 'generic'
  goal: string
  references: string[]
  repository: string
  createdAt: string
  /** Present for a new-repository request (always private and empty). */
  destination?: NativeIntent['destination']
}

/** One row of `GET /v1/native/jobs`: ids and states only, no goal, intent or history. */
export interface NativeJobSummary {
  missionId: string
  state: NativeState
  scopeRevision: number
  brokerSeq: number
  holdReason: string | null
  /** The broker bound a session (a held job may still have launched); absent from older brokers. */
  bound?: boolean
}

/**
 * `POST /v1/native/x/handoff`: the phone's live X pair moves to the host once.
 * The body is the only place the pair travels; it is never echoed back.
 */
export interface NativeXHandoff {
  accessToken: string
  refreshToken: string
  clientId: string
  spriiteHandle: string
  template: { settings: Record<string, string | boolean | string[]>; acceptanceCriteria: string[]; restrictions: string[] }
  delivery: NativeDeliveryDefaults
  expiresAt?: string
  spriiteXUserId?: string
  defaultRepository?: string
  repositoryAccount?: string
  /** The phone's last successful X check: the Factory host's first read starts there. */
  startAt?: string
  /** Logical post ids the phone already handled (at most 100): never launched again on the Factory host. */
  seenPostIds?: string[]
  /** The owner's repositories (`account/name`, at most 500): a word naming one is asked about. */
  repositories?: string[]
}

/** Where the Factory host's reading reached; the phone adopts it when it takes X back. */
export interface NativeXHostCheckpoint {
  lastSeenPostId: string | null
  lastSuccessAt: string | null
}

/** A host reader receipt as the status route shows it: no post text. */
export interface NativeXHostReceipt {
  dedupeKey: string
  logicalPostId: string
  revisionId: string
  status: 'submitted' | 'held' | 'clarify' | 'ignored' | 'launching'
  reason?: string
  missionId?: string
  repository?: string
  newRepository?: string
  at: string
  proposedRevisionId?: string
}

export interface NativeXHostReader {
  running: boolean
  bound: boolean
  lastCheckedAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  nextCheckAt: string | null
  backoffUntil: string | null
  rejectedCount: number
  gapCount: number
  /** Newest first, at most 50. */
  receipts: NativeXHostReceipt[]
}

/** `GET /v1/native/x/status` (also the handoff and stop answers). Never a secret. */
export interface NativeXHostStatus {
  enabled: boolean
  running: boolean
  ownerXUserId: string | null
  spriiteHandle: string | null
  spriiteXUserId: string | null
  defaultRepository: string | null
  repositoryAccount: string | null
  credential: { state: string; expiresAt: string | null } | null
  /** null when the Factory host has never read (or the broker predates it). */
  checkpoint: NativeXHostCheckpoint | null
  lastError: string | null
  /** null: no reader; 'withheld': the host refused to project an unreadable status. */
  reader: NativeXHostReader | 'withheld' | null
}

/** The host X reader and job-list routes; bound to one broker like the job client. */
export interface NativeHostClient {
  listJobs(ownerId: string): Promise<NativeJobSummary[]>
  observe(missionId: string, ownerId: string): Promise<NativeSnapshot>
  xHandoff(handoff: NativeXHandoff): Promise<NativeXHostStatus>
  xStatus(): Promise<NativeXHostStatus>
  xStop(): Promise<NativeXHostStatus>
}
