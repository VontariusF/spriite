import type { NativeAttention } from '../src/native/protocol.js'
import type { MissionV2Artifact, MissionV2Check, MissionV2Snapshot } from './mission-v2-record.mjs'
export declare const SDK_TRANSPORT_VERSION: '@factory/droid-sdk@0.9.1/daemon'
export declare const SDK_PROTOCOL_VERSION: '1.201.1'
export declare const MISSION_STATES: readonly string[]
export declare const MISSION_V2_TAG: 'mission-v2'
export declare const MISSION_V2_INITIALIZE_TAGS: readonly [{ readonly name: 'mission-v2' }]
export declare const MISSION_V2_AGENTS_TAG_KINDS: readonly ['orchestrator', 'agent']
export declare const MISSION_V2_AGENT_TOOL_NAMES: readonly ['SpawnAgent', 'ListAgents', 'SendMessage', 'InterruptAgent']
export declare const MISSION_V2_AGENT_STATUSES: readonly ['idle', 'pending', 'running']
export declare const MISSION_V2_GATING_FAULTS: Readonly<Record<string, string>>
/** Provider fault code for droid Missions 2.0 gating text in any of the values, or null. */
export declare function missionV2GatingFault(...values: unknown[]): string | null
export declare function missionV2TagOf(settings: unknown): { name: string; metadata?: Record<string, string> } | null
export declare function missionV2TagDialect(tag: { name: string; metadata?: Record<string, string> } | null): 'v2' | 'v2-agents' | 'none'
export declare const MISSION_V2_REQUEST_TYPES: readonly ['recommend_mission', 'exit_mission_planning']
export declare const MISSION_V1_REQUEST_TYPES: readonly ['propose_mission', 'start_mission_run']
export declare const MISSION_V2_NOTIFICATION_TYPES: readonly ['mission_v2_snapshot_changed', 'agent_turn_completed']
/** v1-only notification types; mission_heartbeat is not dialect-decisive. */
export declare const MISSION_V1_NOTIFICATION_TYPES: readonly string[]
export declare const MISSION_V2_CHECK_KINDS: readonly ['verification', 'review', 'decision']
export declare const MISSION_V2_OUTCOMES: readonly ['met', 'unmet', 'waived']
/** Largest exit_mission_planning payload (UTF-8 bytes) offered as an approvable proposal; larger is a handoff. */
export declare const MISSION_V2_PLAN_REQUEST_MAX_BYTES: 131072
export declare function validateMissionV2Check(value: unknown): MissionV2Check
export declare function validateMissionV2Artifact(value: unknown): MissionV2Artifact
export declare function validateMissionV2Checks(value: unknown): MissionV2Check[]
export declare function validateMissionV2Snapshot(value: unknown): MissionV2Snapshot
/** Mission dialect proven by one decoded fact. */
export declare function missionDialectOf(decoded: DecodedSdkEnvelope | { kind: 'request'; envelope: any; raw: any }): 'v1' | 'v2' | 'v2-agents' | 'none' | 'mixed'
export declare function missionV2RequestType(request: { envelope: any; raw?: any }): 'recommend_mission' | 'exit_mission_planning' | null
/** Request params; persisted rows may omit the redundant `raw` copy of `envelope.params`. */
export declare function requestPayload(request: { envelope?: any; raw?: any } | null | undefined): any
export interface SdkDecodeContext {
  machineId: string; connectionId: string; rootSessionId: string; observedAt: string
}
export type DecodedSdkEnvelope =
  | { kind: 'request'; envelope: any; raw: any; attention: NativeAttention; proposalHash: string | null; unsupportedReason: string | null }
  | { kind: 'notification'; sessionId: string; envelope: any }
  | { kind: 'receipt'; requestId: string | null; hasResult: boolean; resourceSessionId: string | null }
  | { kind: 'diagnostic'; code: string }
  | { kind: 'ignored' }
export declare function decodeSdkEnvelope(data: unknown, context: SdkDecodeContext): DecodedSdkEnvelope
export declare function safeDecodeSdkEnvelope(data: unknown, context: SdkDecodeContext): DecodedSdkEnvelope
export declare function validateSdkFeature(value: unknown): unknown
export declare function validateSdkProgress(value: unknown): unknown
export declare function validateSdkMessage(value: unknown): unknown
export declare function validateSdkNotification(value: unknown): boolean
export declare function correlateNativeResolution(request: Extract<DecodedSdkEnvelope, { kind: 'request' }> | {
  envelope: any; raw: any; attention: NativeAttention
}, envelope: any): {
  kind: 'permission_effect'; selectedOption: string; attribution: 'unknown_or_external'
} | {
  kind: 'ask_user_tool_terminated'; answerAcceptance: 'unknown'; attribution: 'unknown_or_external'
} | null
export declare function outgoingDescriptor(data: unknown): {
  operation: 'initialize' | 'owner_turn' | 'permission_response' | 'ask_user_response'
  sessionId: string; requestHash: string
}
export declare function validateRequestHash(value: unknown): void
export function isInternalSdkMessage(message: unknown): boolean
