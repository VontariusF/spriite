/**
 * Host deployment contracts, not Factory SDK APIs or evidence that a sandbox,
 * billing boundary, complete pending snapshot or Mission control exists.
 */
import type { NativeBinding, NativeIntent, NativeWorkspace } from '../src/native/protocol.js'

export interface NativeHostBinding {
  ownerId: string
  missionId: string
  machineId: string
  scopeHash: string
  policyHash: string
  epoch: number
}
export interface NativePhysicalWorkspaceProof {
  attestationId: string
  nonce: string
  binding: NativeHostBinding
  executionHostId: string
  executionInstanceId: string
  canonicalCwd: string
  canonicalRepoRoot: string
  canonicalGitDir: string
  canonicalCommonDir: string
  rootIdentity: { device: string; inode: string }
  gitDirIdentity: { device: string; inode: string }
  repositoryId: string
  objectFormat: 'sha1' | 'sha256'
  baseRef: string
  baseSha: string
  initialHeadSha: string
  executionRef: string | null
  checkoutGeneration: string
  observedAt: string
  expiresAt: string
  evidenceIds: string[]
}
export interface NativeEnforcementLease {
  leaseId: string
  binding: NativeHostBinding
  workspaceAttestationId: string
  deploymentDigest: string
  boundaryPolicyHash: string
  revocationGeneration: number
  expiresAt: string
  /** A reserved cap when the intent carries a budget, or an explicit honest
   * non-enforcement marker when it does not. */
  budget: { accountId: string; unit: string; capUnits: string; enforcementId: string } | { enforcement: 'none' }
  evidenceIds: string[]
}
export type NativeHostOperation = 'initialize' | 'owner_turn' | 'permission_response' | 'ask_user_response'
export interface NativeSendPermit {
  permitId: string
  leaseId: string
  connectionId: string
  operation: NativeHostOperation
  sessionId: string
  requestHash: string
  expiresAt: string
  revocationGeneration: number
}
export interface NativeHostBoundary {
  /** A deployment must enforce ongoing effects/inference, not only SDK sends. */
  verifyWorkspace(input: NativeHostBinding & {
    workspace: NativeWorkspace; nonce: string
  }): Promise<NativePhysicalWorkspaceProof>
  acquireLease(input: NativeHostBinding & {
    workspaceAttestationId: string; compiledPolicyHash: string; nonce: string
  }): Promise<NativeEnforcementLease>
  authorizeSend(input: NativeHostBinding & {
    leaseId: string; connectionId: string; operation: NativeHostOperation
    sessionId: string; requestHash: string; nonce: string
  }): Promise<NativeSendPermit>
  /** Synchronous at actual transport.send, not before an SDK/authentication await. */
  assertAndConsumePermit(permit: NativeSendPermit): void
  revoke(input: NativeHostBinding & {
    leaseId: string; expectedRevocationGeneration: number; reason: string
  }): Promise<{ receiptId: string; revocationGeneration: number; evidenceIds: string[] }>
}
export interface NativeDeploymentPolicy {
  ownerId: string
  machineId: string
  deploymentDigest: string
  allowedModelIds: string[]
  allowedToolIds: string[]
  /** Required only while the deployment still enforces a global budget cap;
   * an intent-level budget is the authoritative cap. */
  budgetUnit?: string
  maxBudgetUnits?: string
  /** Only a verified, externally provisioned boundary may supply these facts. */
  boundary: NativeHostBoundary | null
}
export interface CompiledNativePolicy {
  scopeHash: string
  policyHash: string
  compiledPolicyHash: string
  settings: NativeIntent['settings']
  initialize: {
    interactionMode: 'mission'
    autonomyLevel: 'high'
    modelId: string
    reasoningEffort: string
    missionSettings: {
      workerModel: string
      workerReasoningEffort: string
      validationWorkerModel: string
      validationWorkerReasoningEffort: string
      skipScrutiny: false
      skipUserTesting: false
    }
    restrictToolIds: string[]
    autoRejectPermissionRequests: false
    /** Missions 2.0 entry tag (droid >= 0.238); absent in provider records written before it. */
    tags?: Array<{ name: 'mission-v2' }>
  }
  requiredBoundaryDimensions: string[]
  /** Delivery consequences the host must mediate after completion. */
  consequences: { createRepository: boolean; push: boolean; pr: boolean; merge: boolean }
  /** 'reserved' only when an intent-level budget cap is enforced; 'none' reports honestly. */
  budgetEnforcement: 'reserved' | 'none'
}
/** Single-writer broker storage. No SDK cache becomes execution authority. */
export interface NativeProviderJournal {
  read(): unknown | null
  write(value: unknown): Promise<void>
  /** Preserve a positively initialized resource even when its goal is unsent/unknown. */
  initialized(binding: NativeBinding): Promise<void>
}
