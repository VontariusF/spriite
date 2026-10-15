import type * as nodeFs from 'node:fs'
import type { XClient } from './x-client.mjs'
import type { XUser } from '../src/intake/x-transport.ts'
import type * as XRules from './x-rules.mjs'

export declare const X_READER_LEDGER_MAX_BYTES: 1048576
export declare const X_READER_MAX_RECEIPTS: 512
export declare const X_READER_STATUS_RECEIPTS: 50
export declare const X_LAUNCH_UNKNOWN_REASON: 'The launch outcome is unknown. Check the missions on the phone before posting it again.'

export interface XReaderBinding {
  ownerXUserId: string
  ownerHandle: string
  spriiteXUserId: string
  spriiteHandle: string
  /** First reads cover only posts made after this (or after readFrom). */
  boundAt: string
  /** A handoff's first read starts here: the phone's last successful check. */
  readFrom?: string
  /** The repository designated for X builds that name none. */
  defaultRepository?: string
}
export type XReceiptStatus = 'submitted' | 'held' | 'clarify' | 'ignored' | 'launching'
export interface XReaderReceipt {
  dedupeKey: string
  logicalPostId: string
  revisionId: string
  status: XReceiptStatus
  reason?: string
  missionId?: string
  /** The existing destination, `https://github.com/<account>/<name>`. */
  repository?: string
  /** The new private repository's name when the request gets its own. */
  newRepository?: string
  at: string
  /** A later edit of a launched request: recorded, never launched. */
  proposedRevisionId?: string
  /** launch() was (or may have been) called for this key; it never is again. */
  launchAttempted?: true
}
export type XLaunchDestination =
  | { kind: 'existing'; repository: string }
  | { kind: 'new_repository'; name: string }
/** What the reader hands launch(): the owner's verified, routed request. */
export interface XLaunchRequest {
  readonly origin: 'x'
  readonly dedupeKey: string
  readonly logicalPostId: string
  readonly revisionId: string
  readonly postId: string
  readonly ownerXUserId: string
  readonly postUrl: string
  readonly postedAt: string
  /** The visible text minus the Spriite mention: the goal, byte-for-byte. */
  readonly instruction: string
  readonly destination: Readonly<XLaunchDestination>
}
export type XLaunchResult =
  | { status: 'submitted'; missionId: string }
  | { status: 'held'; reason: string }
export type XOutcomeStatus = 'submitted' | 'held' | 'clarify' | 'ignored' | 'duplicate' | 'rejected'
export interface XReaderOutcome {
  postId: string
  status: XOutcomeStatus
  dedupeKey?: string
  reason?: string
  missionId?: string
}
export interface XCheckResult {
  ok: boolean
  checked: number
  outcomes: XReaderOutcome[]
  /** More posts than one check reads; the older part is read by the next checks. */
  gap?: boolean
  error?: string
  errorKind?: 'auth' | 'forbidden' | 'quota' | 'credits' | 'not_found' | 'network' | 'service' | 'storage' | 'stopped'
}
export interface XReaderStatus {
  readonly running: boolean
  readonly bound: boolean
  readonly binding: Readonly<XReaderBinding> | null
  readonly checkpoint: {
    readonly lastSeenPostId: string | null
    readonly lastSuccessAt: string | null
    /** An older span still being read: posts below untilId, then the checkpoint moves to newestId. */
    readonly backlog?: { readonly untilId: string; readonly newestId: string }
  }
  readonly lastCheckedAt: string | null
  readonly lastError: string | null
  readonly lastErrorKind: string | null
  readonly backoffUntil: string | null
  readonly nextCheckAt: string | null
  readonly rejectedCount: number
  readonly gapCount: number
  /** Newest first, at most X_READER_STATUS_RECEIPTS. */
  readonly receipts: readonly Readonly<XReaderReceipt>[]
}
export interface XReaderBindInput {
  spriiteHandle: string
  /** The credential's numeric X owner id; /2/users/me must answer it. */
  ownerId: string
  /** Skips the handle lookup when already known. */
  spriiteUserId?: string
  defaultRepository?: string
  /** A handoff: a new ownership period even for the same owner (checkpoint dropped). */
  fresh?: boolean
  /** With fresh: the phone's last successful check, where the first read starts. */
  startAt?: string | null
  /** With fresh: logical post ids the phone already handled (at most 100). */
  seenPostIds?: string[]
}
export interface XReader {
  bind(input: XReaderBindInput): Promise<Readonly<XReaderBinding>>
  start(): void
  /** Resolves once the check in flight has drained; nothing is written after it. */
  stop(): Promise<void>
  wake(): boolean
  checkNow(): Promise<XCheckResult>
  status(): XReaderStatus
}
export declare function createXReader(options: {
  ledgerPath: string
  client: Pick<XClient, 'me' | 'userPosts'> & { userByUsername?(handle: string): Promise<XUser> }
  rules?: typeof XRules
  launch(request: XLaunchRequest): Promise<XLaunchResult>
  now?: () => number
  intervalMs?: number
  backoffMs?: number
  autoLaunchWindowMs?: number
  maxPages?: number
  log?: (event: string, fields: Record<string, unknown>) => void
  fs?: typeof nodeFs
  /** The owner's repository full names (`account/name`), or null when unreadable. */
  repositories?: (() => readonly string[] | null) | null
  /** Whether a launched mission is still live (a reply under it is a follow-up). */
  missionLive?: (missionId: string) => boolean
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
}): XReader
