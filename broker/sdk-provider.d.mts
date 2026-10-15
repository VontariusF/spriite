import type {
  NativeBinding, NativeIntent, NativeAttention, NativeAnswer, NativeAdmissionDraft, NativeAdmissionPreview, NativeWorkspace,
} from '../src/native/protocol.js'
import type { BrokerContext, BrokerTransport, BrokerObservation } from './index.js'
import type {
  NativeDeploymentPolicy, NativeProviderJournal, NativeHostBinding, NativePhysicalWorkspaceProof,
  NativeEnforcementLease, CompiledNativePolicy, NativeSendPermit,
} from './provider-contract.js'
import type { NativeEvidenceAuthority, validateEnforcementLease } from './native-boundary.mjs'
import type { NativeWorkspaceHost, validateWorkspaceProof } from './native-workspace.mjs'
import type { DecodedSdkEnvelope } from './sdk-wire.mjs'
import type { MissionV2Agent, MissionV2ProviderRecordReader } from './mission-v2-state.mjs'
import type { KeyObject } from 'node:crypto'

export interface PublicDaemonTransportPort {
  connect(url: string): Promise<void>
  disconnect(): void
  isConnected(): boolean
  getConnectionId(): string | null
  send(data: string): void
  isRelayConnection(): boolean
  getTransportKind(): unknown
  on(event: string, handler: (...args: any[]) => void): void
  off(event: string, handler: (...args: any[]) => void): void
}
export type SdkInitializeParams = CompiledNativePolicy['initialize'] & {
  machineId: string; cwd: string; sessionId: string; token: string
}
export interface PublicDaemonClientPort {
  isConnected(): boolean
  getConnectionId(): string | null
  onMessage(handler: (data: string) => void): void
  onConnectionOpen(handler: () => void): void
  onConnectionClose(handler: (code: number, reason: string) => void): void
  onConnectionError(handler: (error: Error) => void): void
  initializeSession(params: SdkInitializeParams, options?: { timeout?: number }): Promise<unknown>
  addUserMessage(params: { sessionId: string; messageId: string; text: string }, requestId?: string): Promise<unknown>
  inspectMissionReadiness(params: { cwd: string }): Promise<unknown>
  listAvailableSessions(params: {
    limit: number; endBefore?: number; includeArchived: boolean; includeMissionMetadata: boolean
  }): Promise<unknown>
  getSessionMessages(params: { sessionId: string; limit: number; cursor?: string }): Promise<unknown>
  sendPermissionResponse(requestId: string, result: { sessionId: string; selectedOption: string }): void
  sendAskUserResponse(requestId: string, result: {
    sessionId: string; cancelled: boolean; answers: Array<{ index: number; question: string; answer: string }>
  }): void
}
export interface NativeAdmissionReadOnlyContext {
  ownerId: string
  missionId: string
  machineId: string
  epoch: number
  readOnly: true
}
export interface NativeObservationReadOnlyContext {
  ownerId: string
  missionId: string
  epoch: number
  readOnly: true
  providerJournal?: NativeProviderJournal
}
export interface NativeProviderStep {
  state: 'prepared' | 'invoked' | 'confirmed' | 'unknown'
  requestHash: string
  /** initializeSession has no caller-selectable wire RPC id, so initialization stores null. */
  rpcId: string | null
  messageId: string | null
  receiptHash: string | null
  fault: string | null
}
export interface NativeProviderRequest {
  attention: NativeAttention
  /** Optional: always byte-identical to envelope.params, so new rows omit it. */
  raw?: unknown
  envelope: unknown
  connectionId: string
  proposalHash: string | null
  unsupportedReason: string | null
}
/** Persisted root-session Mission v2 facts; `seq` orders facts within this record. */
export interface NativeProviderMissionV2 {
  seq: number
  /** Correlated proceed_once resolution of the exact exit_mission_planning request. */
  approval: { attentionId: string; proposalHash: string; observedAt: string; seq: number } | null
  /** Latest mission_v2_snapshot_changed envelope for the root session. */
  snapshot: { envelope: unknown; observedAt: string; seq: number } | null
  rootWorking: { state: string; observedAt: string; seq: number } | null
  /** Seq of the latest non-idle root working state. */
  rootBusySeq: number
  lastTurn: { reason: string; turnId: string | null; observedAt: string; seq: number } | null
  workers: Array<{
    childSessionId: string; toolUseId: string; subagentType: string | null; description: string | null
    startedAt: string; startSeq: number; finishedAt: string | null; finishSeq: number | null; failed: boolean | null
  }>
  /** Bounded ring of root tool_result toolUseIds (absent in records written before out-of-order handling). */
  toolResults?: Array<{ toolUseId: string; seq: number; failed: boolean }>
}
/** Persisted root-session facts for droid >= 0.238 Missions 2.0 agents; `seq` orders facts. */
export interface NativeProviderMissionV2Agents {
  seq: number
  /** The root's own `mission-v2` tag identity; metadata growth (spaceId) is not tracked. */
  tag: { kind: 'orchestrator'; missionId: string }
  rootWorking: { state: string; observedAt: string; seq: number } | null
  /** Seq of the latest root activity (busy state, message, tool result, request). */
  rootBusySeq: number
  lastTurn: { reason: string; turnId: string | null; observedAt: string; seq: number } | null
  agents: MissionV2Agent[]
  /** True once an agent beyond MISSION_V2_AGENTS_MAX was seen; completion is then never derived. */
  agentsOverflow: boolean
  /** Root SpawnAgent/ListAgents tool uses awaiting their tool_result. */
  toolUses: Array<{ toolUseId: string; name: 'SpawnAgent' | 'ListAgents'; title: string | null; seq: number }>
  toolResults: Array<{ toolUseId: string; seq: number; failed: boolean }>
  /** Latched completion; later root activity is counted here as progress only. */
  completed: { observedAt: string; seq: number; lateActivity: number; lastLateActivityAt: string | null } | null
}
export interface NativeProviderRecord extends NativeHostBinding {
  version: 1
  rootSessionId: string
  scopeRevision: number
  connectionId: string
  workspace: NativeIntent['workspace']
  goalText: string
  initializeParams: Omit<SdkInitializeParams, 'token'>
  compiledPolicyHash: string
  workspaceProof: NativePhysicalWorkspaceProof | null
  enforcementLease: NativeEnforcementLease | null
  initialize: NativeProviderStep
  goal: NativeProviderStep
  binding: NativeBinding | null
  effectiveSettings: NativeIntent['settings'] | null
  settingsObservedAt: string | null
  sessions: Array<{
    sessionId: string; parentSessionId: string | null; connectionId: string; active: boolean
    source: 'owned_root' | 'initialize' | 'worker_notification' | 'child_notification' | 'opened_query' | 'available_query'
  }>
  requests: NativeProviderRequest[]
  answerAttempts: Array<{
    commandId: string; attentionId: string; requestHash: string; response: unknown
    state: 'invoked' | 'sent' | 'unknown'; invokedAt: string
  }>
  resolutions: Array<{
    attentionId: string; envelope: unknown; observedAt: string
    effect: { kind: 'permission_effect'; selectedOption: string; attribution: 'unknown_or_external' } |
      { kind: 'ask_user_tool_terminated'; answerAcceptance: 'unknown'; attribution: 'unknown_or_external' }
  }>
  observations: {
    mission: { envelope: unknown; observedAt: string } | null
    features: { envelope: unknown; observedAt: string } | null
    progress: { envelope: unknown; observedAt: string } | null
    workers: Array<{ envelope: unknown; observedAt: string }>
    /** Identity tracking only: full SDK messages, or bounded {id, text} rows past the retention window. */
    history: unknown[]
  }
  ingestionFault: string | null
  recoveryHold: boolean
  /** Absent in records written before Mission v2 support. Fixed by the first decisive fact. */
  dialect?: 'v1' | 'v2' | 'v2-agents' | null
  /** Present exactly when dialect is 'v2'. */
  missionV2?: NativeProviderMissionV2 | null
  /** Present exactly when dialect is 'v2-agents' (droid >= 0.238). */
  missionV2Agents?: NativeProviderMissionV2Agents | null
  /** Requested mission settings the daemon did not report back; never effective-settings proof. */
  settingsUnconfirmed?: Array<'workerModel' | 'workerReasoningEffort' | 'validationWorkerModel' |
    'validationWorkerReasoningEffort' | 'skipScrutiny' | 'skipUserTesting'>
}
export interface InjectedNativeProviderOptions {
  transport: PublicDaemonTransportPort
  /** Creates an owned client around THIS transport; cannot reuse another interceptor/client. */
  createClient(transport: PublicDaemonTransportPort): PublicDaemonClientPort
  deployment: NativeDeploymentPolicy
  workspaceHost?: NativeWorkspaceHost
  /** Trusted host-only path; permits prospective review, NEVER physical proof or launch. */
  prospectiveNewRepository?: boolean
  evidenceAuthority: NativeEvidenceAuthority
  policy: {
    compileNativePolicy(intent: NativeIntent, deployment: NativeDeploymentPolicy): CompiledNativePolicy
    validateWorkspaceProof: typeof validateWorkspaceProof
    validateEnforcementLease: typeof validateEnforcementLease
  }
  safeExtensionTokenGetter(): Promise<string>
  onEnvelope?(envelope: DecodedSdkEnvelope): void | Promise<void>
  onDiagnostic?(diagnostic: { code: string }): void
  onReadDiagnostics?(diagnostic: {
    found: boolean; metadataComplete: boolean; messagesComplete: boolean; restored: boolean; pendingComplete: false
    historyHold: 'sdk_history_pagination_incomplete' | null
    /** True when a complete history read was clipped to the broker's row/byte bounds. */
    historyClipped?: true
    dialect?: 'v1' | 'v2' | 'v2-agents'
    /** v2 / v2-agents only ('mission_v2_agents_no_durable_record' for v2-agents): 'verified', an agreement/reader failure reason, or null when the record was not consulted. */
    missionRecord?: string | null
  }): void
  journalForObservation?(context: NativeObservationReadOnlyContext): NativeProviderJournal | null
  /** Trusted bounded read-only host resolver; never an HTTP/client-supplied facility.
   * May only add baseSha, preserving all other draft workspace fields. */
  resolveAdmissionWorkspace?(draft: NativeAdmissionDraft, context: NativeAdmissionReadOnlyContext):
    Promise<NativeWorkspace & { baseSha: string }>
  /** Read-only host-local Mission v2 record reader; consulted only for an approved v2 plan with a snapshot. */
  missionRecordReader?: MissionV2ProviderRecordReader
  /** v2-agents quiet period after a completed orchestrator turn (default 90000, max 3600000). */
  missionV2AgentsSettleMs?: number
  requestTimeoutMs?: number
  maxReadPages?: number
  /** Verified live host qualification; lifts only the live-qualification and lease holds. */
  hostQualification?: unknown
  hostPublicKey?: KeyObject | string | Buffer
  now?: () => number
}
export type InjectedNativeProvider = Omit<BrokerTransport, 'inspectAdmission' | 'validateProviderRecord' | 'observe'> & {
  schemaNeeded: true
  client: PublicDaemonClientPort
  inspectAdmission(draft: NativeAdmissionDraft, context: NativeAdmissionReadOnlyContext): Promise<NativeAdmissionPreview>
  validateProviderRecord: typeof validateProviderRecord
  preflight: NonNullable<BrokerTransport['preflight']>
  launch: NonNullable<BrokerTransport['launch']>
  answer(answer: NativeAnswer, context: BrokerContext): Promise<{ status: 'sent'; commandId: string }>
  observe(binding: NativeBinding, context: NativeObservationReadOnlyContext): Promise<BrokerObservation>
  flush(): Promise<void>
  providerRecord(): NativeProviderRecord | null
  isFenced(): boolean
  detach(): void
}
export declare function createInjectedNativeProvider(options: InjectedNativeProviderOptions): InjectedNativeProvider
export declare function validateProviderRecord(value: unknown, expectedBindingContext: Omit<NativeHostBinding, 'epoch'> & {
  epoch?: number; binding?: NativeBinding | null
}): NativeProviderRecord
/** UUID-shaped root session id derived from the owned binding digest (36 characters). */
export declare function ownedRootSessionId(owned: string): string
export declare function createGuardedDaemonTransport(transport: PublicDaemonTransportPort, options: {
  boundary: NonNullable<NativeDeploymentPolicy['boundary']>
  readGuard?(frame: unknown): void
  now?: () => number
}): {
  transport: PublicDaemonTransportPort
  arm(permit: NativeSendPermit, guard: () => void): void
  disarm(): void
}
