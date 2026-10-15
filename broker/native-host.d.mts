import type { KeyObject } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { NativeIntent, NativeWorkspace, NativeAdmissionDraft } from '../src/native/protocol.js'
import type {
  NativeHostBinding, NativeHostBoundary, NativePhysicalWorkspaceProof,
  NativeEnforcementLease, NativeSendPermit, NativeHostOperation,
} from './provider-contract.js'
import type { NativeEvidenceAuthority, NativeSignedEvidence } from './native-boundary.js'
import type { BrokerTransport } from './index.js'
import type { NativeWorkspaceHost } from './native-workspace.js'

export declare const NATIVE_HOST_ROOT: string
export declare const NATIVE_HOST_DIMENSIONS: readonly string[]
export declare const NATIVE_NEW_REPOSITORY_BASE: Readonly<{
  baseRef: 'refs/heads/main'
  message: 'Initialize repository'
}>

export interface NativeHostFsPort {
  existsSync(path: string): boolean
  statSync(path: string): { mode: number; isFile?(): boolean }
  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): unknown
  readFileSync(path: string, encoding?: string): any
  writeFileSync(path: string, data: any, options?: { mode?: number; flag?: string }): void
  rmSync(path: string, options?: { force?: boolean }): void
  readdirSync(path: string): string[]
  realpathSync(path: string): string
}
export type NativeHostSpawnPort = typeof import('node:child_process').spawn
export type NativeHostGitPort = (options: {
  args: string[]; cwd: string; env: Record<string, string | undefined>; timeoutMs?: number
}) => Promise<{ stdout: string; exitCode: number }>

export declare function loadOrCreateHostKey(path?: string, fs?: NativeHostFsPort): KeyObject
export declare function repositoryUrlFor(repository: string): string
export declare function stripUrlCredentials(value: string): string
export declare function canonicalRepositoryId(value: string): string
export declare function nativeSandboxSettings(options: {
  workDir: string; ownerHome: string; root: string; apiKeyFile?: string; sensitiveFiles?: string[]; fs?: NativeHostFsPort
}): {
  sandbox: {
    enabled: true
    mode: 'whole-process'
    filesystem: { allowWrite: string[]; denyRead: string[] }
    network: { allowedDomains: string[] }
  }
}
export declare const DAEMON_SYSTEM_PATH_DIRS: readonly string[]
export declare const DAEMON_OPTIONAL_PATH_DIRS: readonly string[]
/** Daemon PATH: resolved tool directories, existing package-manager prefixes, then system dirs. */
export declare function composeDaemonPath(options?: {
  toolPaths?: Array<string | undefined>
  exists?: (path: string) => boolean
}): string
export declare function containmentProbeScript(options: { workDir: string; ownerHome: string; nonce: string }): string

export interface NativeDeliveryPort {
  createPrivateRepository(input: { account: string; name: string }): Promise<{ created: boolean; repositoryUrl: string }>
  deliver(input: NativeDeliveryInput): Promise<unknown>
}
export interface NativeDeliveryInput {
  missionId: string
  workDir: string
  repository: string
  repositoryUrl: string
  baseRef: string
  baseSha: string
  policy: { allowCreateRepository: boolean; allowPush: boolean; allowPr: boolean; allowMerge: boolean }
}

export interface NativeDaemonHandle {
  pid: number
  port: number
  url: string
}
export interface NativeProvisionResult {
  workDir: string
  baseSha: string
  repositoryUrl: string
  created: boolean
  localSeed?: boolean
}
export interface NativeContainmentProbeResult {
  nonce: string
  passed: boolean
  method: 'droid_exec_user_prompt_submit_hook'
  exitCode: number | null
  timedOut: boolean
  observed: { nonce: string; workWrite: number; ownerHomeWrite: number; githubReachable: number } | null
  settingsSha256: string
  generation: number
  ranAt: string
}
export interface NativeJobRecord {
  version: 1
  missionId: string
  state: 'provisioned' | 'starting' | 'running' | 'stopped' | 'revoked' | 'recovery_required'
  jobRoot: string
  workDir: string
  homeDir: string
  repository: string
  repositoryUrl: string
  created: boolean
  localSeed?: boolean
  baseRef: string
  baseSha: string
  executionRef: string
  instanceId: string
  checkoutGeneration: string
  generation: number
  settingsSha256: string | null
  daemon: { pid: number; port: number; parentPid: number; envKeys: string[]; startedAt: string; processGroup?: boolean } | null
  terminationVerified?: boolean
  recoveryReason?: string
  probes: NativeContainmentProbeResult | null
  createdAt: string
}

export interface NativeHost extends NativeHostBoundary {
  publicKey: KeyObject
  root: string
  qualificationHolds: readonly string[]
  evidenceAuthority: NativeEvidenceAuthority
  readEvidence(evidenceId: string): NativeSignedEvidence
  readArtifact(artifactId: string): Uint8Array
  workDirFor(missionId: string): string
  jobRootFor(missionId: string): string
  executionRefFor(missionId: string): string
  workspaceHostFor(missionId: string): NativeWorkspaceHost
  job(missionId: string): NativeJobRecord
  daemonFor(missionId: string): NativeDaemonHandle
  provision(intent: NativeIntent): Promise<NativeProvisionResult>
  resolveAdmissionWorkspace(draft: NativeAdmissionDraft): Promise<NativeWorkspace & { baseSha: string }>
  recoverAfterRestart(): Promise<string[]>
  startDaemon(input: { missionId: string }): Promise<NativeDaemonHandle>
  stopDaemon(input: { missionId: string }): Promise<{ stopped: boolean; signal: 'SIGTERM' | 'SIGKILL' | null }>
  runContainmentProbes(input: { missionId: string }): Promise<NativeContainmentProbeResult>
  renewLeases(): void
  deliveryInput(missionId: string): NativeDeliveryInput
  privateRepositoryInitializationInput(missionId: string): NativeDeliveryInput & {
    account: string; name: string; visibility: 'private'; initialization: 'empty'
    seedSha: string; requiresCreatedRepository: true; adoptionAllowed: false
  }
}

export declare function createNativeHost(options: {
  root?: string
  hostKey: KeyObject
  spawn?: NativeHostSpawnPort
  fs?: NativeHostFsPort
  git?: NativeHostGitPort
  delivery?: NativeDeliveryPort
  now?: () => number
  factoryApiKeyFile: string
  sensitiveFiles?: string[]
  readFactoryCredential?: () => string
  validateRuntime?: () => void
  machineId: string
  deploymentDigest: string
  ownerHome?: string
  droidPath?: string
  daemonPath?: string
  ownerGitEnv?: Record<string, string | undefined>
  executionHostId?: string
  randomId?: () => string
  allocatePort?: () => Promise<number>
  waitForDaemon?: (input: { port: number; child: ChildProcess }) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  parentPid?: number
  inspectProcess?(pid: number): Promise<string | null | false>
  signalProcess?(pid: number, signal: string): unknown
  trustedHost?: boolean
  /** Start each daemon in its own process group and stop the whole group (default: on for the real spawn). */
  processGroups?: boolean
}): NativeHost

export declare function createHostRoutedTransport(options: {
  host: NativeHost
  createJobTransport(input: {
    missionId: string
    phase: 'execution'
    daemon: NativeDaemonHandle
    workspaceHost: NativeWorkspaceHost
  }): BrokerTransport | Promise<BrokerTransport>
  createAdmissionTransport(input: {
    missionId: string; phase: 'admission'; daemon: null; workspaceHost?: NativeWorkspaceHost
    prospectiveNewRepository: boolean
    resolveAdmissionWorkspace(): Promise<NativeWorkspace & { baseSha: string }>
  }): BrokerTransport | Promise<BrokerTransport>
  version: string
  support?: BrokerTransport['support']
}): BrokerTransport & { forget(missionId: string): void }

export type NativeUsageResult =
  | { state: 'pending' }
  | { state: 'unavailable' }
  | { state: 'available'; credits: number }

export declare function createNativeUsageClient(options: {
  apiKeyFile: string
  fetch?: typeof globalThis.fetch
  baseUrl?: string
  now?: () => number
  fs?: { readFileSync(path: string, encoding: string): string }
}): {
  query(input: { sessionIds: string[]; completedAt: string }): Promise<NativeUsageResult>
}
