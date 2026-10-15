import type { NativeFeature } from '../src/native/protocol.js'
import type { MissionV2Check, MissionV2Evaluation, MissionV2Snapshot } from './mission-v2-record.mjs'
import type { NativeProviderRecord } from './sdk-provider.mjs'

export type MissionV2RecordResult =
  | { verified: true; checks: MissionV2Check[]; evaluations: Record<string, MissionV2Evaluation>; latestEventNumber: number }
  | { verified: false; reason: string }
/** Raw reader output; evaluations may also be a Map keyed by check id (latest evaluation per check). */
export type MissionV2RecordReaderResult =
  | { verified: true; checks: MissionV2Check[]; latestEventNumber: number
      evaluations: Record<string, MissionV2Evaluation> | Map<string, MissionV2Evaluation> }
  | { verified: false; reason: string }
/** Read-only, host-local durable record reader injected into the provider (see mission-v2-record.mjs). */
export interface MissionV2ProviderRecordReader {
  read(input: { machineId: string; sessionId: string; snapshot: MissionV2Snapshot }):
    MissionV2RecordReaderResult | Promise<MissionV2RecordReaderResult>
}
export interface MissionV2Worker {
  sessionId: string
  toolUseId: string
  subagentType: string | null
  description: string | null
  startedAt: string
  finishedAt: string | null
  failed: boolean | null
  finished: boolean
}
export interface MissionV2Inputs {
  dialect: 'v2'
  openAttention: boolean
  planApproved: boolean
  rootWorkingState: string | null
  lastTurn: { reason: string; current: boolean } | null
  workers: MissionV2Worker[]
  snapshot: MissionV2Snapshot | null
  approvedChecks: MissionV2Check[] | null
  /** sha256 hex of the owner-approved missionPlan (must equal snapshot.planHash). */
  approvedPlanHash: string | null
  verifiedRecord?: MissionV2RecordResult | null
}
export type MissionV2DerivedState = 'planning' | 'awaiting_input' | 'running' | 'paused' | 'completed'

export declare function missionV2Inputs(record: NativeProviderRecord | null | undefined): MissionV2Inputs | null
export declare function missionV2WorkerSessionIds(inputs: MissionV2Inputs | null | undefined): string[]
export declare function normalizeMissionV2Record(result: unknown): MissionV2RecordResult
export declare function checkMissionV2Record(input: {
  snapshot: MissionV2Snapshot | null
  approvedChecks: MissionV2Check[] | null
  approvedPlanHash?: string | null
  verifiedRecord?: MissionV2RecordResult | null
}): { ok: boolean; complete: boolean; reason: string | null }
export declare function deriveMissionV2State(inputs: MissionV2Inputs | { dialect: unknown } | null | undefined): MissionV2DerivedState | null
export declare function projectV2Features(approvedChecks: MissionV2Check[] | null, verifiedRecord: MissionV2RecordResult | null): NativeFeature[] | null
export declare function projectV2Progress(input?: {
  workers?: MissionV2Worker[]; verifiedRecord?: MissionV2RecordResult | null
}): Array<Record<string, unknown>> | null

// ---- legacy Mission ('v1') ----
export declare function projectV1Features(list: unknown[]): NativeFeature[] | null
export declare function projectV1Progress(log: unknown[]): Array<Record<string, unknown>> | null

// ---- droid >= 0.238 Missions 2.0 agents ('v2-agents') ----
export declare const MISSION_V2_AGENTS_SETTLE_MS: 90000
export declare const MISSION_V2_AGENTS_NO_RECORD: 'mission_v2_agents_no_durable_record'
export declare const MISSION_V2_AGENTS_MAX: 200
export type MissionV2AgentStatus = 'idle' | 'pending' | 'running' | 'unknown'
export interface MissionV2Agent {
  sessionId: string
  title: string | null
  /** Last ListAgents status; 'running' from SpawnAgent until listed; 'unknown' for an unrecognized value. */
  status: MissionV2AgentStatus | null
  waitingOn: string | null
  source: 'spawn' | 'list'
  firstSeenAt: string
  listedAt: string | null
  seq: number
}
export interface MissionV2AgentsInputs {
  dialect: 'v2-agents'
  openAttention: boolean
  rootWorkingState: string | null
  lastTurn: { reason: string; current: boolean; observedAt: string } | null
  settled: boolean
  agents: MissionV2Agent[]
  agentsOverflow: boolean
  completed: { observedAt: string; seq: number; lateActivity: number; lastLateActivityAt: string | null } | null
  faulted: boolean
  live: boolean
}
export declare function parseMissionV2AgentResult(name: string, content: unknown):
  | { kind: 'spawned'; sessionId: string }
  | { kind: 'listed'; agents: Array<Pick<MissionV2Agent, 'sessionId' | 'title' | 'status' | 'waitingOn'>> }
  | null
export declare function missionV2AgentsInputs(record: NativeProviderRecord | null | undefined,
  options?: { nowMs?: number; settleMs?: number; live?: boolean }): MissionV2AgentsInputs | null
export declare function missionV2AgentsSettled(agents: MissionV2Agent[]): boolean
export declare function deriveMissionV2AgentsState(inputs: MissionV2AgentsInputs | { dialect: unknown } | null | undefined):
  'running' | 'awaiting_input' | 'completed' | null
export declare function projectV2AgentFeatures(agents: MissionV2Agent[]): NativeFeature[] | null
export declare function projectV2AgentProgress(inputs: MissionV2AgentsInputs | null): Array<Record<string, unknown>> | null
