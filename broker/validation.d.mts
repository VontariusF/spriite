export declare class BrokerError extends Error {
  constructor(code: string, status?: number)
  code: string
  status: number
}
export declare function fail(code: string, status?: number): never
export declare function hash(value: unknown): string
export declare function boundedJson(value: unknown, max?: number): string
export declare function secretFree(value: unknown, secrets?: string[]): void
export declare const SECRET_PATTERNS: readonly RegExp[]
export declare function object(value: unknown, keys: string[], required?: string[]): Record<string, unknown>
export declare function str(value: unknown, max?: number, empty?: boolean): string
export declare const NATIVE_RESPONSE_MAX_BYTES: 1048576
export declare const NATIVE_SNAPSHOT_ADMISSION_BYTES: number
export declare const NATIVE_SNAPSHOT_MAX_BYTES: number
export declare const NATIVE_MAX_OUTSTANDING_READS: 8
export declare function readableSnapshot(value: unknown, max?: number): string
export declare function deliveryIsTerminal(state: { step: string; reason?: string }): boolean
export declare function deliveryEffect(value: unknown): import('./native-delivery.mjs').DeliveryEffect
