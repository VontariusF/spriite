import type { NativeAdmissionDraft, NativeAdmissionPreview, NativeDeliveryDefaults, NativeIntent, NativeSnapshot } from '../src/native/protocol.js'
import type { NativeXAutoTemplate } from '../src/native/x-auto.js'
import type { XLaunchRequest as XReaderLaunchRequest } from './x-reader.mjs'

/** A routed X request: destination already resolved to an account and name. */
export interface XRoutedLaunchRequest {
  goal: string
  references: string[]
  destination: { kind: 'existing' | 'new_repository'; account: string; name: string }
  logicalPostId: string
  dedupeKey: string
}
export type XLaunchOutcome =
  | { status: 'submitted'; missionId: string }
  | { status: 'held'; reason: string }
/** Either the reader's request or an already routed one. */
export type XLaunchRequest = XReaderLaunchRequest | XRoutedLaunchRequest
export type XLaunch = (request: XLaunchRequest) => Promise<XLaunchOutcome>

/** The broker surface the launcher uses: the same admission path as the phone. */
export interface XLaunchBroker {
  inspectAdmission(draft: NativeAdmissionDraft): Promise<NativeAdmissionPreview>
  prepare(intent: NativeIntent): Promise<NativeSnapshot>
  /** Read-only projection of an existing job, used when a crash replays a launch. */
  project?(missionId: string, ownerId: string): NativeSnapshot
  host?: { workDirFor?(missionId: string): string } | null
}

export declare function xLaunchTemplate(raw: unknown): NativeXAutoTemplate | null
export declare function xLaunchDelivery(raw: unknown): NativeDeliveryDefaults | null
export declare function createXLauncher(options: {
  broker: XLaunchBroker
  ownerId: string
  machineId: string
  /** Canonical host root; each job checkout is <hostRoot>/jobs/<missionId>/work. */
  hostRoot: string
  baseRef?: string
  template: NativeXAutoTemplate
  delivery: NativeDeliveryDefaults
  /** The owner's GitHub account a new private repository is created under; null holds such requests. */
  newRepositoryAccount?: string | null
  /** Mission/command ids; the default is deterministic per dedupe key. */
  mint?: (kind: 'mission' | 'command', request: XLaunchRequest) => string
}): XLaunch
