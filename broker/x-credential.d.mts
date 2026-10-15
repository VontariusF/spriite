import type * as nodeFs from 'node:fs'
export declare const X_TOKEN_URL: 'https://api.x.com/2/oauth2/token'
export declare const X_CREDENTIAL_MAX_BYTES: 16384
export type XCredentialState = 'active' | 'renewing' | 'rotation_lost' | 'rejected'
/** The handoff: the phone's live pair plus the app and owner it belongs to. */
export interface XCredentialPair {
  accessToken: string
  refreshToken: string
  expiresAt: string
  clientId: string
  ownerId: string
}
/** What callers may see. The refresh token never leaves the store. */
export interface XCredentialView {
  readonly accessToken: string
  readonly expiresAt: string
  readonly clientId: string
  readonly ownerId: string
  readonly state: XCredentialState
}
export interface XCredentialStore {
  /** Reads and rechecks the file; null when absent. A `renewing` file is quarantined. */
  load(): XCredentialView | null
  current(): XCredentialView | null
  /** A new handoff: replaces the file atomically and clears any rotation loss. */
  save(pair: XCredentialPair): XCredentialView
  /** One token request; the rotated pair is durable before this resolves. A refused
   * grant marks the store `rejected` and is never sent again until save(). */
  renew(): Promise<XCredentialView>
  clear(): void
}
export declare function createXCredentialStore(options: {
  path: string
  fs?: typeof nodeFs
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
}): XCredentialStore
