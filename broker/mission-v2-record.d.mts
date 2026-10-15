export declare const MISSION_V2_SESSION_ID: RegExp
export declare const MISSION_V2_OUTCOMES: readonly ['met', 'unmet', 'waived']
export declare const MISSION_V2_EVENT_TYPES: readonly ['checks_evaluated']
export declare const MISSION_V2_CHECK_KINDS: readonly ['verification', 'review', 'decision']
export declare const MISSION_V2_MAX_EVENT_LINE_BYTES: 262144
export declare function isMissionV2Datetime(value: unknown): value is string

export type MissionV2Outcome = (typeof MISSION_V2_OUTCOMES)[number]
export type MissionV2EventType = (typeof MISSION_V2_EVENT_TYPES)[number]
export type MissionV2CheckKind = (typeof MISSION_V2_CHECK_KINDS)[number]

export interface MissionV2CheckCounts {
  total: number
  met: number
  unmet: number
  waived: number
}

/** Payload of `mission_v2_snapshot_changed` (strict). */
export interface MissionV2Snapshot {
  sessionId: string
  title: string
  approvedAt: string
  latestEventNumber: number
  /** sha256 hex of mission.md bytes. */
  planHash: string
  /** sha256 hex of checks.json bytes. */
  checksHash: string
  checkCounts: MissionV2CheckCounts
}

export interface MissionV2Check {
  id: string
  group: string
  description: string
  about?: string
  kind?: MissionV2CheckKind
  how?: string
}

export interface MissionV2Artifact {
  id: string
  where: string
  description?: string
  identity?: string
}

export interface MissionV2Evaluation {
  outcome: MissionV2Outcome
  summary: string
  eventNumber: number
  recordedAt: string
}

export interface MissionV2EventSummary {
  eventNumber: number
  recordedAt: string
  type: MissionV2EventType
  checkIds: string[]
}

export interface MissionV2VerifiedRecord {
  verified: true
  sessionId: string
  title: string
  approvedAt: string
  planHash: string
  checksHash: string
  checks: readonly MissionV2Check[]
  artifacts: readonly MissionV2Artifact[]
  /** Latest evaluation per check id; unevaluated checks are absent. */
  evaluations: Readonly<Record<string, MissionV2Evaluation>>
  counts: MissionV2CheckCounts
  latestEventNumber: number
  events: readonly MissionV2EventSummary[]
}

export type MissionV2RecordFailureReason =
  | 'machine_mismatch'
  | 'invalid_session_id'
  | 'invalid_snapshot'
  | 'session_mismatch'
  | 'path_escape'
  | 'missing_record'
  | 'not_directory'
  | 'missing_file'
  | 'symlink_refused'
  | 'not_regular_file'
  | 'file_too_large'
  | 'file_changed'
  | 'record_changed'
  | 'read_failed'
  | 'invalid_utf8'
  | 'empty_plan'
  | 'plan_hash_mismatch'
  | 'checks_hash_mismatch'
  | 'invalid_checks'
  | 'too_many_events'
  | 'event_too_large'
  | 'invalid_event_json'
  | 'invalid_event'
  | 'unknown_event_type'
  | 'event_sequence_invalid'
  | 'unknown_check_id'
  | 'record_snapshot_mismatch'
  | 'check_counts_mismatch'

export interface MissionV2RecordFailure {
  verified: false
  reason: MissionV2RecordFailureReason
}

export interface MissionV2RecordReader {
  /**
   * Never throws for record or snapshot data problems; throws TypeError for
   * non-string machineId/sessionId or non-object snapshot. Returns
   * `{ verified: false, reason: 'machine_mismatch' }` when `machineId` is not
   * the local machine the reader was created for.
   */
  read(input: { machineId: string; sessionId: string; snapshot: MissionV2Snapshot }): Promise<MissionV2VerifiedRecord | MissionV2RecordFailure>
}

export declare function createMissionV2RecordReader(options: {
  /** Absolute path of the daemon host's `~/.factory`. */
  factoryDir: string
  /** Required: the local machine id. A read for any other machineId is refused. */
  localMachineId: string
  /** Per-file read bound in bytes (default 8 MiB; covers a full events.jsonl). */
  maxFileBytes?: number
  maxEvents?: number
}): MissionV2RecordReader
