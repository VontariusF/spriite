import type {
  NativeIntent, NativeCommand, NativeCommandReceipt, NativeSnapshot, NativeCapabilities,
  NativeBinding, NativeAttention, NativeFeature, NativeHistoryEntry, NativeBrokerClient,
  NativeAdmissionDraft, NativeAdmissionPreview,
} from '../src/native/protocol.js'
import type { Server } from 'node:http'
import type { NativeProviderJournal } from './provider-contract.js'

export interface BrokerContext {
  ownerId: string
  missionId: string
  machineId: string
  binding: NativeBinding | null
  epoch: number
  scopeHash: string
  policyHash: string
  commandId?: string
  providerJournal?: NativeProviderJournal
  /** Must be checked immediately before every execution-affecting send. */
  guard(): void
}
export interface BrokerObservation {
  binding: NativeBinding
  state: Exclude<NativeSnapshot['state'], 'held'>
  features: NativeFeature[]
  progressLog: unknown[]
  workerSessionIds: string[]
  pending: Array<{ attention: NativeAttention; raw: unknown; proposalHash?: string | null }>
  pendingComplete: boolean
  pendingSource: 'authoritative' | 'notification'
  sessionIds: string[]
  completeness: NativeSnapshot['completeness']
  effectiveSettings: NativeIntent['settings']
  scopeRevision: number
  scopeHash: string
  policyHash: string
  providerAt?: string | null
  summary?: string | null
  /** True when the summary is a marked prefix of a longer provider text. */
  summaryTruncated?: boolean
  evidence?: Array<{ id: string; url: string; commitSha: string | null }>
  workersSettled?: boolean
  commandResolutions?: Array<{ commandId: string; requestHash: string; status: 'confirmed' | 'rejected'; receiptId: string }>
  history?: Array<Omit<NativeHistoryEntry, 'who'> & { who: 'owner' | 'factory' }>
  /** Omitted sections preserve prior data without acquiring fresh authority. */
  presentSections?: Array<'mission' | 'features' | 'progress' | 'workers' | 'pending' | 'settings' | 'history' | 'finalization'>
}
export interface BrokerTransport {
  version: string
  support: Partial<Pick<NativeCapabilities, 'launch' | 'rootAttention' | 'childAttention' | 'recoverAttention' | 'pause' | 'resume' | 'cancel'>> & {
    readOnlyObservation?: boolean
  }
  inspectAdmission?(draft: NativeAdmissionDraft, context: {
    ownerId: string; missionId: string; machineId: string; epoch: number; readOnly: true
  }): Promise<NativeAdmissionPreview>
  validateProviderRecord?(value: unknown, context: Omit<BrokerContext, 'binding' | 'guard' | 'providerJournal'>): void
  preflight?(intent: NativeIntent, context: BrokerContext): Promise<{
    workspace: Omit<NativeBinding, 'sessionId'>
    effectiveSettings: NativeIntent['settings']
    scopeHash: string
    policyHash: string
    availableAutonomyLevels: string[]
    readiness: boolean
    policyEnforced: boolean
    budgetEnforced: boolean
    /** Honest reporting: 'next_day_unenforced' when no budget cap is enforced. */
    usageReporting: 'enforced' | 'next_day_unenforced'
    destinationVerified: boolean
    settingsEvidence?: 'prospective' | 'effective'
  }>
  launch?(intent: NativeIntent, context: BrokerContext): Promise<{
    status: 'confirmed'; commandId: string; receiptId: string
    binding: NativeBinding; effectiveSettings: NativeIntent['settings']
    /** Present when the daemon did not report these requested mission settings back. */
    unconfirmedSettings?: string[]
  }>
  answer?(answer: NonNullable<NativeCommand['answer']>, context: BrokerContext): Promise<{ status: 'sent'; commandId: string }>
  observe?(binding: NativeBinding, context: { ownerId: string; missionId: string; epoch: number; readOnly: true }): Promise<BrokerObservation>
}
export interface OpenBrokerOptions {
  directory: string
  ownerId: string
  machineId: string
  bearerToken?: string
  transport?: BrokerTransport
  qualificationPath?: string
  qualificationPublicKey?: string | Buffer
  /** Host enforcer; enables consequence intents, new-repository admission, delivery. */
  host?: import('./native-host.js').NativeHost
  delivery?: import('./native-host.js').NativeDeliveryPort
  usage?: { query(input: { sessionIds: string[]; completedAt: string }): Promise<import('./native-host.js').NativeUsageResult> }
  deploymentDigest?: string
  hostQualification?: import('./qualification.js').NativeHostQualificationRecord
  hostQualificationPath?: string
  hostQualificationPublicKey?: import('node:crypto').KeyObject | string | Buffer
  timeoutMs?: number
  now?: () => number
}
export {
  loadHostQualification, verifyHostQualification, isHostQualificationFor,
  HOST_QUALIFICATION_CHECKS, publicKeySha256,
} from './qualification.js'
export {
  createNativeHost, createHostRoutedTransport, createNativeUsageClient,
  loadOrCreateHostKey, NATIVE_HOST_ROOT, NATIVE_HOST_DIMENSIONS, NATIVE_NEW_REPOSITORY_BASE,
} from './native-host.js'
export type { NativeHost, NativeDeliveryPort, NativeDeliveryInput, NativeUsageResult } from './native-host.js'
export type { NativeHostQualificationRecord, NativeQualificationRecord } from './qualification.js'
export type { DeliveryJournal, DeliveryContext, DeliveryEffect } from './native-delivery.mjs'
export declare class NativeBroker implements NativeBrokerClient {
  static open(options: OpenBrokerOptions): Promise<NativeBroker>
  capabilities(): Promise<NativeCapabilities>
  prepare(intent: NativeIntent): Promise<NativeSnapshot>
  inspectAdmission(draft: NativeAdmissionDraft): Promise<NativeAdmissionPreview>
  observe(missionId: string, ownerId: string): Promise<NativeSnapshot>
  project(missionId: string, ownerId: string): NativeSnapshot
  command(command: NativeCommand): Promise<NativeCommandReceipt>
  ingestObservation(missionId: string, ownerId: string, observation: BrokerObservation): NativeSnapshot
  ingestNotification(missionId: string, ownerId: string, notification: {
    machineId: string; sessionId: string
    type: 'mission_state_changed' | 'mission_features_changed' | 'mission_progress_entry' | 'mission_heartbeat' |
      'mission_worker_started' | 'mission_worker_completed'
    payload: unknown
  }): void
  ingestProviderEnvelope(missionId: string, ownerId: string, envelope: unknown): NativeSnapshot
  readEvents(ownerId: string, after?: number, limit?: number): Array<{
    seq: number; missionId: string; ownerId: string; kind: string; at: string; data: unknown
  }>
  startObservationLoop(options?: { intervalMs?: number }): void
  close(): void
  shutdown(): Promise<void>
  resumeDeliveries(): void
  settleDeliveries(): Promise<void>
  deliveryContext(missionId: string): import('./native-delivery.mjs').DeliveryContext
}
export declare const unavailableTransport: BrokerTransport
export declare function createNativeProviderBrokerBridge(options: {
  broker: NativeBroker; missionId: string; ownerId: string
}): (decoded: import('./sdk-wire.mjs').DecodedSdkEnvelope) => void
export declare class BrokerError extends Error { code: string; status: number }
export declare const NATIVE_RESPONSE_MAX_BYTES: 1048576
export declare const NATIVE_MAX_OUTSTANDING_READS: 8
export declare class FileStore {
  static open(options: { directory: string; ownerId: string; secrets?: string[] }): FileStore
  assertWriter(epoch?: number): void
  close(): void
}
export declare function recoverDeadWriter(options: { directory: string; expectedToken: string }): void
export declare function createRouter(options: { broker: NativeBroker; bearerToken: string; allowedOrigins?: string[]; github?: import('./native-github.mjs').NativeGitHub | null; githubCapabilityWaitMs?: number }): import('node:http').RequestListener
export declare function startBrokerServer(options: {
  broker: NativeBroker; bearerToken: string; host?: '127.0.0.1' | '::1'; port?: number; allowedOrigins?: string[]
  github?: import('./native-github.mjs').NativeGitHub | null
}): Promise<Server>
export declare function startFromEnv(env?: Record<string, string | undefined>): Promise<{
  broker: NativeBroker; server: Server; close(): Promise<void>
}>
export declare const QUALIFICATION_GATES: readonly string[]
export declare function unavailableCapabilities(transportVersion?: string): NativeCapabilities
export declare function loadQualification(options?: {
  path?: string; publicKey?: string | Buffer; ownerId?: string; machineId?: string; transportVersion?: string; now?: number
}): Promise<{
  qualificationId: string; transportVersion: string; issuedAt: string; expiresAt: string; manifestHash: string
} | null>
