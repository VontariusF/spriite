/** Types for broker/x-signin.mjs: host-run X OAuth 2.0 PKCE sign-in (REDESIGN-PLAN C7). */
export type HostXSignInState =
  | { state: 'idle' }
  | { state: 'pending'; startedAt: number }
  | { state: 'connected'; handle: string | null }
  | { state: 'failed'; reason: string }
  | { state: 'unavailable'; reason: string }

export interface SignedInXPair {
  accessToken: string
  refreshToken: string
  expiresAt: string
  clientId: string
  ownerId: string
  handle: string | null
}

export declare const X_AUTHORIZE_URL: 'https://x.com/i/oauth2/authorize'
export declare const X_ME_URL: 'https://api.x.com/2/users/me'
export declare const X_SIGNIN_SCOPES: readonly string[]
export declare const X_SIGNIN_DEFAULT_PORT: 47823
export declare const X_SIGNIN_CALLBACK_PATH: '/x/callback'
export declare const X_SIGNIN_TTL_MS: number

export declare function pkcePair(random?: (n: number) => Uint8Array): { verifier: string; challenge: string }
export declare function authorizeUrl(opts: { clientId: string; redirectUri: string; state: string; challenge: string; scopes?: readonly string[] }): string
export declare function defaultOpenBrowser(url: string, opts?: { platform?: string; spawnImpl?: unknown }): Promise<boolean>

export interface HostXSignIn {
  start(input?: { clientId?: string }): Promise<HostXSignInState>
  status(): Promise<HostXSignInState>
  heldPair(): SignedInXPair | null
  clearHeld(): void
  redirectUri(): string | null
  close(): void
}
export declare function createHostXSignIn(options?: {
  clientId?: string
  port?: number
  host?: string
  fetch?: typeof fetch
  openBrowser?: (url: string) => Promise<boolean> | boolean
  now?: () => number
  random?: (n: number) => Uint8Array
  ttlMs?: number
  /** Store the verified pair; answer { held: true } to keep it in memory for a token-less handoff. */
  onCredential?: (pair: SignedInXPair) => Promise<{ held?: boolean } | void>
  available?: () => boolean
}): HostXSignIn
