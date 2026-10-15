import type { NativeIntent } from '../src/native/protocol.js'
import type { NativeDeploymentPolicy, NativeHostBinding, NativeHostBoundary, CompiledNativePolicy } from './provider-contract.js'
export declare const NATIVE_BUDGET_MAX_DIGITS: 64
export declare const NATIVE_REASONING_EFFORTS: readonly string[]
export declare const NATIVE_HOST_OPERATIONS: readonly string[]
export declare const NATIVE_UNSUPPORTED_CONTROLS: Readonly<{ pause: false; resume: false; cancel: false }>
export declare const NATIVE_BOUNDARY_DIMENSIONS: readonly string[]
export declare const NATIVE_BUDGET_DIMENSIONS: readonly ['complete_inference_billing', 'atomic_budget_reservation']
export declare const NATIVE_DELIVERY_DIMENSION: 'delivery_mediation'
export declare function nativeConsequences(intent: NativeIntent): Readonly<{
  createRepository: boolean; push: boolean; pr: boolean; merge: boolean
}>
export declare function nativeRequiredDimensions(intent: NativeIntent): string[]
export declare function nativeBudgetEnforcement(intent: NativeIntent): 'reserved' | 'none'
export declare const NATIVE_MISSION_V2_ORCHESTRATOR_TOOLS: readonly ['RecommendMission', 'ExitMissionPlanning', 'Task', 'Script']
export declare const NATIVE_MISSION_V2_AGENTS_TOOLS: readonly ['SpawnAgent', 'SendMessage', 'ListAgents', 'InterruptAgent']
export declare const NATIVE_MISSION_V2_INITIALIZE_TAGS: readonly [{ readonly name: 'mission-v2' }]
export declare function requireMissionV2Tools(restrictToolIds: readonly string[]): readonly string[]
export declare function freezeNative<T>(value: T): T
export declare function parseBudgetUnits(value: string, options?: { allowZero?: boolean; maxDigits?: number }): bigint
export declare function validateBudgetUnit(value: string): string
export declare function validateFullGitRef(value: string): string
export declare function validateGitSha(value: string, objectFormat?: 'sha1' | 'sha256'): string
export declare function getNativeHashes(intent: NativeIntent): { scopeHash: string; policyHash: string }
export declare function validateHostBinding(binding: NativeHostBinding, expected: NativeHostBinding): NativeHostBinding
export declare function requireNativeBoundary(boundary: NativeHostBoundary | null): NativeHostBoundary
export declare function isCompiledNativePolicy(value: unknown): boolean
export declare function compileNativePolicy(intent: NativeIntent, deployment: NativeDeploymentPolicy): CompiledNativePolicy
