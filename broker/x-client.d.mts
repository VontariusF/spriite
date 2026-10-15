import { BrokerError } from './validation.mjs'
import type { XCredentialStore } from './x-credential.mjs'
import type { XErrorKind, XPost, XIncludes, XUser } from '../src/intake/x-transport.ts'
export type { XErrorKind } from '../src/intake/x-transport.ts'
export declare const X_API_ORIGIN: 'https://api.x.com'
export declare const X_ERROR_KINDS: readonly XErrorKind[]
export declare class XClientError extends BrokerError {
  constructor(kind: XErrorKind, options?: { reason?: string; renewalUnknown?: boolean })
  readonly kind: XErrorKind
  /** A code such as `x_timeout` or `x_rotation_lost`; never a token or body. */
  readonly reason: string
  readonly renewalUnknown: boolean
}
export interface XPostPage {
  posts: XPost[]
  includes: XIncludes
  nextToken: string | null
}
export interface XClient {
  me(): Promise<XUser>
  /** GET /2/users/by/username/:username; the answer must carry the asked handle. */
  userByUsername(handle: string): Promise<XUser>
  userPosts(userId: string, options?: { sinceId?: string | null; paginationToken?: string | null; startTime?: string | null; untilId?: string | null }): Promise<XPostPage>
  post(id: string): Promise<{ post: XPost; includes: XIncludes } | null>
}
export declare function createXClient(options: {
  credential: Pick<XCredentialStore, 'current' | 'renew'>
  fetch?: typeof fetch
  timeoutMs?: number
}): XClient
