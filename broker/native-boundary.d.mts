import type { NativeIntent } from '../src/native/protocol.js'
import type {
  NativeHostBinding, NativePhysicalWorkspaceProof, NativeEnforcementLease,
  NativeSendPermit, NativeHostOperation, NativeHostBoundary, NativeDeploymentPolicy, CompiledNativePolicy,
} from './provider-contract.js'
import type { KeyObject } from 'node:crypto'
export declare const NATIVE_EVIDENCE_MAX_BYTES: 1048576
export declare const NATIVE_LEASE_MAX_MS: 300000
export declare const NATIVE_PERMIT_MAX_MS: 5000
export interface NativeEvidenceExpectation {
  kind: 'workspace' | 'lease' | 'revocation'
  subjectHash: string
  binding: NativeHostBinding
  nonce: string
  deploymentDigest: string
  dimensions: string[]
  now?: number
}
export interface NativeSignedEvidence {
  manifest: {
    version: 1
    evidenceId: string
    kind: NativeEvidenceExpectation['kind']
    subjectHash: string
    binding: NativeHostBinding
    nonce: string
    deploymentDigest: string
    issuedAt: string
    expiresAt: string
    artifacts: Array<{ id: string; dimension: string; sha256: string }>
  }
  signature: string
}
export interface NativeEvidenceAuthority {
  verify(ids: string[], expected: NativeEvidenceExpectation): void
}
export declare function assertNativeFreshness(issuedAt: string | null, expiresAt: string, now?: number, maxMs?: number): void
export declare function createNativeEvidenceAuthority(options: {
  publicKey: KeyObject | string | Buffer
  readEvidence(id: string): NativeSignedEvidence
  readArtifact(id: string): Uint8Array
  now?: () => number
}): NativeEvidenceAuthority
export declare function verifyNativeEvidence(authority: NativeEvidenceAuthority, ids: string[], expected: NativeEvidenceExpectation): void
export declare function validateEnforcementLease(lease: NativeEnforcementLease, options: {
  intent: NativeIntent
  binding: NativeHostBinding
  workspaceProof: NativePhysicalWorkspaceProof
  compiledPolicy: CompiledNativePolicy
  deployment: NativeDeploymentPolicy
  nonce: string
  evidenceAuthority: NativeEvidenceAuthority
  now?: number
}): NativeEnforcementLease
export declare function validateSendPermit(permit: NativeSendPermit, options: {
  lease: NativeEnforcementLease
  binding: NativeHostBinding
  connectionId: string
  operation: NativeHostOperation
  sessionId: string
  requestHash: string
  revocationGeneration: number
  now?: number
}): NativeSendPermit
export declare const NATIVE_READ_ONLY_METHODS: readonly string[]
export declare function nativeFrameRequestHash(frame: string | object): string
export interface NativeGuardState {
  intent: NativeIntent
  binding: NativeHostBinding
  workspaceProof: NativePhysicalWorkspaceProof
  compiledPolicy: CompiledNativePolicy
  lease: NativeEnforcementLease
  revocationGeneration: number
  sessionIds: string[]
  guard(): void
  readGuard(): void
}
export interface NativeGuardableTransport {
  send(data: string): void
  disconnect(): void
  isConnected(): boolean
  getConnectionId(): string | null
  connect?(url: string): Promise<void>
  isRelayConnection?(): boolean
  getTransportKind?(): unknown
  on?(event: string, handler: (...args: any[]) => void): void
  off?(event: string, handler: (...args: any[]) => void): void
}
export declare function createGuardedTransport<T extends NativeGuardableTransport>(options: {
  transport: T
  boundary: NativeHostBoundary | null
  getState(): NativeGuardState
  now?: () => number
}): {
  transport: T
  authorizeSend(input: { operation: NativeHostOperation; sessionId: string; requestHash: string }): Promise<NativeSendPermit>
  invalidate(): void
  readonly pendingPermitCount: number
}
export declare function createBudgetReservationBook(options: { unit: string; capUnits: string }): {
  reserve(reservationId: string, maximumChargeUnits: string): void
  markSent(reservationId: string): void
  releaseUnsent(reservationId: string): void
  settle(reservationId: string, actualChargeUnits: string): void
  snapshot(): Readonly<{
    unit: string; capUnits: string; settledUnits: string; reservedUnits: string
    remainingUnits: string; reservationCount: number
  }>
}
