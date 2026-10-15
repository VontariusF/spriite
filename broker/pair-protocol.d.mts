/** Types for broker/pair-protocol.mjs (docs/design/PAIRING-PROTOCOL.md). */
export type PairKind = 'pair' | 'move'
export type SessionFailure =
  | 'not_found' | 'expired' | 'used' | 'wrong_code' | 'unreachable' | 'cancelled' | 'invalid' | 'too_large'

export declare const PAIR_TTL_MS: number
export declare const PAIR_BODY_MAX: number
export declare const PAIR_ALPHABET: string
export declare const PAIR_KINDS: readonly PairKind[]
export declare const QR_SECRET_BYTES: number
export declare const MAX_SLOT_ROLLS: number
export declare const TRANSFER_WORDS: readonly string[]
export declare const SLOT_PATTERN: Readonly<Record<PairKind, RegExp>>

export declare function utf8(s: string): Uint8Array
export declare function concatBytes(...parts: Uint8Array[]): Uint8Array
export declare function toB64u(bytes: Uint8Array): string
export declare function fromB64u(text: string): Uint8Array | null
export declare function randomBytes(n: number): Uint8Array
export declare function lvCat(...parts: Uint8Array[]): Uint8Array

export declare function normalizePairCode(input: string): string | null
export declare function formatPairCode(code: string): string
export declare function generatePairCode(random?: (n: number) => Uint8Array): string
export declare function normalizeTransferCode(input: string): string | null
export declare function formatTransferCode(code: string): string
export declare function generateTransferCode(random?: (n: number) => Uint8Array): string
export declare function normalizeCode(kind: PairKind, input: string): string | null
export declare function formatCode(kind: PairKind, code: string): string
export declare function slotOf(kind: PairKind, code: string): string

export declare function encodeQr(opts: { kind: PairKind; code: string; secret: Uint8Array | string; relay?: string }): string
export declare function parseQr(text: string, expectKind?: PairKind | null):
  { kind: PairKind; code: string; secret: string | null; relay: string | null } | null

export interface CPacePoint { multiply(s: bigint): CPacePoint; toBytes(): Uint8Array }
export declare function passwordFor(kind: PairKind, code: string, variant: 'code' | 'qr', secret?: Uint8Array | string | null): Uint8Array
export declare function cpaceGenerator(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): CPacePoint
export declare function cpaceShare(generator: CPacePoint, random?: (n: number) => Uint8Array): { y: bigint; Y: Uint8Array }
export declare function cpaceSecret(y: bigint, peer: Uint8Array): Uint8Array | null
export declare function cpaceIsk(sid: Uint8Array, K: Uint8Array, Ya: Uint8Array, ADa: Uint8Array, Yb: Uint8Array, ADb: Uint8Array): Uint8Array
export declare function sessionKeys(isk: Uint8Array, sid: Uint8Array): { confA: Uint8Array; confB: Uint8Array; aes: Uint8Array }

export declare class PairError extends Error {
  readonly reason: SessionFailure | 'slot_taken'
  constructor(reason: SessionFailure | 'slot_taken')
}
export interface RelayClient {
  readonly base: string
  call(route: 'open' | 'claim' | 'put' | 'poll' | 'get' | 'close', body: unknown, signal?: AbortSignal): Promise<Record<string, any>>
}
export declare function createRelayClient(opts: { base: string; fetchImpl?: typeof fetch }): RelayClient

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>
export interface HostSession {
  readonly code: string
  readonly display: string
  readonly secret: string
  readonly qrText: string
  readonly expiresAt: number
  cancel(): Promise<void>
  finish(payload: () => unknown | Promise<unknown>): Promise<{ ok: true } | { ok: false; reason: SessionFailure }>
}
export declare function openHostSession(opts: {
  kind: PairKind
  relay: RelayClient
  relayLabel?: string
  random?: (n: number) => Uint8Array
  now?: () => number
  sleep?: Sleep
  pollMs?: number
  signal?: AbortSignal
  code?: string | null
  maxBytes?: number
  onClaimed?: () => void
}): Promise<HostSession>
export declare function joinSession(opts: {
  kind: PairKind
  relay: RelayClient
  code: string
  qrSecret?: string | null
  random?: (n: number) => Uint8Array
  now?: () => number
  sleep?: Sleep
  pollMs?: number
  signal?: AbortSignal
}): Promise<{ ok: true; payload: unknown } | { ok: false; reason: SessionFailure }>

/** QR modules for `text`, row-major; true = dark module. */
export declare function qrMatrix(text: string): boolean[][]
