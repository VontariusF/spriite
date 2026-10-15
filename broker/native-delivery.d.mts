export type DeliveryStep = 'held' | 'pushed' | 'pr_open' | 'checks_pending' | 'checks_failed' | 'merged' | 'not_merged'

export interface RunnerResult { status: number | null, stdout: string, stderr: string }
export type Runner = (args: string[], options: { cwd?: string, timeoutMs: number, gitEnvironment?: Readonly<Record<string, string>>, input?: string }) => Promise<RunnerResult> | RunnerResult
export interface RepositoryIdentity { readonly repositoryId: string; readonly visibility: 'PRIVATE' | 'PUBLIC' }

export interface DeliveryPolicy { allowCreateRepository?: boolean, allowPush: boolean, allowPr: boolean, allowMerge: boolean }

export interface DeliveryChecks { total: number, passed: number, failed: number, pending: number }

export interface DeliveryProjection {
  readonly step: DeliveryStep
  readonly branch: string
  readonly headSha: string
  readonly prUrl?: string
  readonly prNumber?: number
  readonly checks?: Readonly<DeliveryChecks>
  readonly reason?: string
  readonly updatedAt: string
}

/** Full persisted state; the projection fields plus what resume needs. */
export interface DeliveryState extends DeliveryProjection {
  readonly missionId: string
  readonly workDir: string
  readonly repository: string
  readonly baseRef: string
  readonly baseSha: string
  readonly policy: Readonly<{ allowPush: boolean, allowPr: boolean, allowMerge: boolean }>
  readonly title: string
  readonly body: string
  readonly repositoryIdentity?: RepositoryIdentity
}

export interface DeliverInput {
  missionId: string
  workDir: string
  repository: string
  baseRef: string
  baseSha: string
  policy: DeliveryPolicy
  title: string
  body: string
  repositoryIdentity?: RepositoryIdentity
}

export interface DeliveryEffect {
  readonly effectId: string
  readonly identity: Readonly<{
    ownerId: string; machineId: string; missionId: string; scopeHash: string; policyHash: string
    kind: 'create_repository' | 'initial_seed_push' | 'branch_push' | 'pr_create' | 'pr_merge'
    repository: string; baseRef: string; baseSha: string; headSha: string
    branch?: string; policy?: Readonly<DeliveryPolicy>; prNumber?: number; prUrl?: string
    repositoryId?: string; visibility?: 'PRIVATE' | 'PUBLIC'
  }>
  readonly state: 'intent' | 'confirmed'
  readonly receipt?: Readonly<{ created?: boolean; repositoryId?: string; headSha?: string; prNumber?: number; prUrl?: string }>
  readonly updatedAt: string
}
export interface DeliveryJournal {
  readonly identity: Readonly<{ ownerId: string; machineId: string; missionId: string; scopeHash: string; policyHash: string; baseRef: string; baseSha: string }>
  read(effectId: string): DeliveryEffect | null | Promise<DeliveryEffect | null>
  list(): DeliveryEffect[] | Promise<DeliveryEffect[]>
  /** Synchronous writer/scope fence immediately before external dispatch. */
  guard?(): void
  /** Must resolve only after durable atomic storage; failure prevents dispatch. */
  save(effect: DeliveryEffect, checkpoint?: DeliveryState): void | Promise<void>
}
export interface DeliveryContext { readonly journal: DeliveryJournal }
export interface NativeDelivery {
  createPrivateRepository(input: { account: string, name: string }, context?: DeliveryContext): Promise<Readonly<{ repositoryUrl: string, created: boolean }>>
  pushInitialSeed(input: Pick<DeliverInput, 'missionId' | 'workDir' | 'repository' | 'baseRef' | 'baseSha'>, context: DeliveryContext): Promise<Readonly<{ repository: string; baseSha: string; seeded: true }>>
  deliver(input: DeliverInput, context?: DeliveryContext): Promise<DeliveryState>
  resume(state: DeliveryState, context?: DeliveryContext): Promise<DeliveryState>
}

export declare const DELIVERY_STEPS: readonly DeliveryStep[]
export declare const DELIVERY_RUNNER_TIMEOUT_MS: number
export declare const DELIVERY_RUNNER_MAX_BYTES: number
export declare const DELIVERY_PR_FOOTER: string
export declare const REASONS: Readonly<Record<string, string | ((step: string) => string)>>

export declare function createNativeDelivery(options: {
  gh: Runner
  git: Runner
  now: () => string | Date
  sleep: (ms: number) => Promise<void> | void
  timeoutMs?: number
  pollAttempts?: number
  pollIntervalMs?: number
  /** Isolated test ports only; production checks and refuses configured/custom hooks. */
  verifyPushSafety?: (workDir: string) => boolean | Promise<boolean>
  /** Trusted broker implementation or isolated fake ports; never worker supplied. */
  prepareGitCheckout?: (workDir: string) => Promise<{ gitDir: string; workTree: string; cleanup?: () => Promise<void> | void }> | { gitDir: string; workTree: string; cleanup?: () => Promise<void> | void }
}): NativeDelivery

export declare function projectDeliveryState(state: DeliveryState): DeliveryProjection
/** Filenames whose added diff lines contain explicit credential patterns. Never returns secret material. */
export declare function secretsInDiff(diff: unknown): string[]
export declare function validateRepository(value: unknown): string
export declare function shortBaseRef(value: unknown): string
export declare function validateRepositoryIdentity(value: unknown): RepositoryIdentity
export declare function createProductionRunner(bin: string, options?: {
  maxBytes?: number
  execFilePort?: unknown
  env?: Record<string, string | undefined>
}): Runner
