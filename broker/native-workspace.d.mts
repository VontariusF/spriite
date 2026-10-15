import type { NativeIntent } from '../src/native/protocol.js'
import type { NativeHostBinding, NativePhysicalWorkspaceProof } from './provider-contract.js'
import type { NativeEvidenceAuthority } from './native-boundary.mjs'
import type { execFile } from 'node:child_process'
export declare const NATIVE_GIT_MAX_SLOTS: 8
export declare const NATIVE_GIT_TIMEOUT_MS: 3000
export declare const NATIVE_GIT_MAX_BYTES: 262144
export interface NativeWorkspaceHost {
  executionMachineId: string
  /** Trusted deployment co-location mapping, never client-supplied. */
  localMachineId?: string
  executionHostId: string
  executionInstanceId: string
  checkoutGeneration: string
  repositoryId: string
  deploymentDigest: string
  permittedRoots: string[]
  executionRef: string | null
}
export declare function validateCanonicalWorkspacePath(value: string): string
export declare function isVerifiedWorkspaceProof(proof: unknown): boolean
export declare function validateWorkspaceProof(proof: NativePhysicalWorkspaceProof, intent: NativeIntent, context: NativeHostBinding, options: {
  host: NativeWorkspaceHost
  nonce: string
  evidenceAuthority: NativeEvidenceAuthority
  now?: number
  initialProof?: NativePhysicalWorkspaceProof
}): NativePhysicalWorkspaceProof
export type NativeGitQuery =
  | { kind: 'root' | 'git_dir' | 'common_dir' | 'object_format' | 'head_sha' | 'execution_ref' | 'dirty' }
  | { kind: 'base_sha'; ref: string }
  | { kind: 'base_object'; baseSha: string }
  | { kind: 'ancestor'; baseSha: string; headSha: string }
export type NativeGitRunner = (input: { query: NativeGitQuery; cwd: string; args: readonly string[] }) => Promise<{
  stdout: Uint8Array | string; exitCode: 0 | 1
}>
export interface NativeWorkspaceFsPort {
  realpath(path: string): Promise<string>
  identity(path: string): Promise<{ device: string; inode: string }>
}
export declare function buildNativeGitArgs(query: NativeGitQuery, cwd: string): readonly string[]
export declare function createProductionGitRunner(options: {
  gitExecutable: string; timeoutMs?: number; maxBytes?: number
  /** Trusted test injection only, never an HTTP parameter. */
  execFilePort?: typeof execFile
}): NativeGitRunner
export declare function createNativeWorkspaceFsPort(): NativeWorkspaceFsPort
export type NativeWorkspaceObservation = Omit<NativePhysicalWorkspaceProof, 'attestationId' | 'nonce' | 'expiresAt' | 'evidenceIds'> & {
  currentHeadSha: string
  dirty: boolean
}
export declare function createReadOnlyWorkspaceVerifier(options: {
  host: NativeWorkspaceHost
  fs: NativeWorkspaceFsPort
  git: NativeGitRunner
  now?: () => number
  readTimeoutMs?: number
}): {
  inspect(intent: NativeIntent, context: NativeHostBinding, options?: {
    initialProof?: NativePhysicalWorkspaceProof
  }): Promise<NativeWorkspaceObservation>
}
