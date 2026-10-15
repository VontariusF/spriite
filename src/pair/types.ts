/**
 * Shared pairing and transfer types (docs/design/REDESIGN-PLAN.md C4 and C5).
 * Types only: no runtime code, so every package (setup, phone, hud) and the
 * Node test scripts can import it without pulling in a network client.
 */

export type RunOn = 'host' | 'cloud'
export type RepoMode = 'per_idea' | 'one'
export type SetupPath = 'paired' | 'key_only' | 'moved'

/** The Factory computer this phone paired with (no secrets). */
export interface PairedHost {
  label: string
  machineId: string
  ownerId: string
  brokerUrl: string
  via: 'tailscale' | 'https' | 'none'
  os: 'linux' | 'macos'
  pairedAt: number
}

/** What `spriite pair` found on the host. Travels only inside the PAKE-encrypted envelope. */
export interface PairingBundle {
  v: 1
  kind: 'pair'
  createdAt: number
  host: {
    label: string
    machineId: string
    ownerId: string
    brokerUrl: string
    via: 'tailscale' | 'https' | 'none'
    os: 'linux' | 'macos'
    online: boolean
  }
  factory: { apiKey: string | null; computerId: string | null; computerName: string | null; computerOnline: boolean }
  github: { token: string | null; login: string | null; repoCount: number | null }
  broker: { bearerToken: string | null }
  voice: { elevenLabsKey: string | null }
  /** The owner's X app client id and token pair, when the host had them saved. */
  x: { hostSignIn: boolean; clientId: string | null; accessToken: string | null; refreshToken: string | null }
  native: { brokerUrl: string; ownerId: string; machineId: string; cwd: string; baseRef: string } | null
}

export type PairFailure = 'not_found' | 'expired' | 'used' | 'wrong_code' | 'unreachable' | 'cancelled' | 'invalid'
export type PairOutcome = { ok: true; bundle: PairingBundle } | { ok: false; reason: PairFailure }

/** What "Move to another phone" carries. Travels only inside the PAKE-encrypted envelope. */
export interface MoveBundle {
  v: 1
  kind: 'move'
  createdAt: number
  keys: Record<string, string>
  prefs: Record<string, unknown>
  feed: Array<{ at: number; label: string; text: string }>
  history: unknown | null
  summary: { hostLabel: string | null; buildCount: number; keyCount: number }
}

export type TransferFailure = PairFailure | 'too_large'

export interface TransferOffer {
  /** Canonical code, 'WREN-41-OAK'. */
  code: string
  /** What the Move board shows, 'WREN · 41 · OAK'. */
  display: string
  /** What the QR encodes (code, 16-byte secret, relay base). */
  qrText: string
  expiresAt: number
  done: Promise<{ ok: true } | { ok: false; reason: TransferFailure }>
  cancel(): void
}

export type TransferOfferResult = { ok: true; offer: TransferOffer } | { ok: false; reason: TransferFailure }
export type TransferReceiveOutcome = { ok: true; bundle: MoveBundle } | { ok: false; reason: TransferFailure }

/** Which items an apply wrote (stable ids such as 'factory', 'github', 'pairedHost'). */
export interface ApplyResult {
  ok: boolean
  applied: string[]
  failed: string[]
}

export type HostXSignInState =
  | { state: 'idle' }
  | { state: 'pending'; startedAt: number }
  | { state: 'connected'; handle: string | null }
  | { state: 'failed'; reason: string }
  | { state: 'unavailable'; reason: string }

export interface PairingClient {
  /** 'k7q-2mf ' -> 'K7Q2MF'; null when it is not a pair code. */
  normalizePairCode(input: string): string | null
  /** 'K7Q2MF' -> 'K7Q-2MF'. */
  formatPairCode(code: string): string
  parsePairQr(text: string): { code: string; secret: string | null } | null
  /** A scanned "Move to another phone" QR: its transfer code and secret. */
  parseTransferQr(text: string): { code: string; secret: string | null } | null
  claimPairing(code: string, opts?: { signal?: AbortSignal; qrSecret?: string | null }): Promise<PairOutcome>
  applyPairingBundle(bundle: PairingBundle, opts: { runOn: RunOn }): Promise<ApplyResult>
  /** 'wren 41 oak' -> 'WREN-41-OAK'; null when it is not a transfer code. */
  normalizeTransferCode(input: string): string | null
  /** 'WREN-41-OAK' -> 'WREN · 41 · OAK'. */
  formatTransferCode(code: string): string
  offerTransfer(opts?: { signal?: AbortSignal }): Promise<TransferOfferResult>
  receiveTransfer(code: string, opts?: { signal?: AbortSignal; qrSecret?: string | null }): Promise<TransferReceiveOutcome>
  applyMoveBundle(bundle: MoveBundle): Promise<ApplyResult>
  /** QR modules for `text`, row-major; true = dark module. */
  qrMatrix(text: string): boolean[][]
  hostXSignIn: {
    available(): boolean
    start(opts?: { clientId?: string }): Promise<HostXSignInState>
    status(): Promise<HostXSignInState>
  }
}
