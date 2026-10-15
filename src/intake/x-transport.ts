/**
 * X API v2 transport for owner intake (spec §11, §21). READ-ONLY against
 * posts by construction: the only request primitive for content is `get()`,
 * so there is no code path that can post, reply, like, or repost.
 *
 * Endpoints used (each validated against the account's access at bind time,
 * never assumed):
 *   GET  /2/users/me                   — proves the token is the owner's own
 *   GET  /2/users/by/username/:handle  — resolves the Spriite account's id
 *   GET  /2/users/:id/tweets           — catch-up over the owner's own posts
 *   GET  /2/tweets/:id                 — authoritative revalidation / import
 *   POST /2/oauth2/token               — renews the token pair (see below)
 *
 * The POST is OAuth renewal, not a write to X: one fixed endpoint, no path
 * or body the caller can point anywhere else. X rotates the refresh token on
 * every renewal and kills the old pair, so a refresh that is not persisted
 * immediately would brick the credential — callers must supply the persist
 * hook (`refresh.persist`) when a refresh token is stored.
 *
 * The X Activity API stream delivers `post.create` with sub-second latency but
 * documents no replay, so catch-up uses the owner's post timeline from a
 * persisted checkpoint with an overlap window. Streaming through the relay is
 * an unqualified transport (buffering, timeouts, background behavior) and is
 * accepted only as a hint: every streamed post is re-fetched here first.
 *
 * Under the dev server calls go through the Vite proxy (/api/x); installed
 * builds go through the self-hosted relay's /x route. Both allow the four
 * lookups and exactly the one OAuth token route.
 *
 * No runtime imports and erasable-only syntax so Node test scripts load it.
 */

export type XErrorKind = 'auth' | 'forbidden' | 'quota' | 'credits' | 'not_found' | 'network' | 'service'

export class XTransportError extends Error {
  readonly kind: XErrorKind
  readonly renewalUnknown: boolean
  constructor(kind: XErrorKind, message: string, renewalUnknown = false) {
    super(message)
    this.kind = kind
    this.renewalUnknown = renewalUnknown
  }
}

export interface XMention {
  start: number
  end: number
  username: string
  id?: string
}

export interface XUrlEntity {
  start: number
  end: number
  url: string
  expanded_url?: string
}

export interface XEntities {
  mentions?: XMention[]
  urls?: XUrlEntity[]
}

export interface XReference {
  type: 'replied_to' | 'quoted' | 'retweeted'
  id: string
}

/** The fields of an X v2 Post this intake reads (event payloads share them). */
export interface XPost {
  id: string
  text: string
  author_id?: string
  created_at?: string
  conversation_id?: string
  edit_history_tweet_ids?: string[]
  entities?: XEntities
  referenced_tweets?: XReference[]
  in_reply_to_user_id?: string
  display_text_range?: [number, number]
  /** Long posts: the full text and its own entities. */
  note_tweet?: { text: string; entities?: XEntities }
}

export interface XUser {
  id: string
  username: string
  protected?: boolean
}

export interface XIncludes {
  tweets?: XPost[]
  users?: XUser[]
}

export interface XPostPage {
  posts: XPost[]
  includes: XIncludes
  nextToken: string | null
}

export interface XTransport {
  me(): Promise<XUser>
  userByUsername(handle: string): Promise<XUser>
  /**
   * Newest-first page of the user's own posts. `sinceId` (the last post id a
   * check saw) reads exactly the newer posts; `startTime` is the first-check
   * path, where no id exists yet.
   */
  ownerPosts(userId: string, startTime: string, paginationToken?: string, sinceId?: string | null): Promise<XPostPage>
  /** One post by id, with its referenced posts expanded. Null when gone. */
  post(id: string): Promise<{ post: XPost; includes: XIncludes } | null>
}

const ENV = (import.meta as { env?: { DEV?: boolean; VITE_SPRIITE_RELAY?: string } }).env
const RELAY = (ENV?.VITE_SPRIITE_RELAY ?? '').replace(/\/+$/, '')
const DEFAULT_BASE = ENV?.DEV ? '/api/x' : RELAY ? `${RELAY}/x` : 'https://api.x.com'

/**
 * The OAuth client id names the X developer app a token belongs to. Each
 * owner registers their own app (bring your own; see docs/X-INTAKE-HANDOFF.md)
 * and saves its client id in Setup, which hands it to every renewal below.
 * A public client has no secret, and the refresh request carries none; the
 * id only names the app. None is baked in, and renewal refuses to run
 * without one, so it can never name an app the owner did not register.
 */

/** The one non-GET path this client talks to. */
const OAUTH_TOKEN_PATH = '/2/oauth2/token'

const POST_FIELDS = [
  'created_at',
  'author_id',
  'conversation_id',
  'edit_history_tweet_ids',
  'entities',
  'referenced_tweets',
  'in_reply_to_user_id',
  'display_text_range',
  'note_tweet',
].join(',')
const EXPANSIONS = 'referenced_tweets.id,referenced_tweets.id.author_id,author_id'
const USER_FIELDS = 'protected,username'

const NUMERIC_ID = /^\d{1,20}$/
const HANDLE = /^[A-Za-z0-9_]{1,15}$/

export interface XTransportOptions {
  token: string
  base?: string
  fetch?: typeof fetch
  /** Absent when the phone has no refresh token stored. */
  refresh?: XRefreshHook
  clientId?: string
  /** Read/renewal deadline; production defaults to 20 seconds. */
  timeoutMs?: number
}

/** An access/refresh pair. Both tokens move together: X rotates the pair. */
export interface XTokenPair {
  accessToken: string
  refreshToken: string
}

/** What the transport needs to renew a credential by itself. */
export interface XRefreshHook {
  /** The stored refresh token, read lazily so a rotation is never reused. */
  token: () => string
  /**
   * Save the rotated pair BEFORE the retry uses it. Returning false is a hard
   * stop: the old pair is already dead, so a token this launch cannot save
   * must not be used.
   */
  persist?: (pair: XTokenPair) => Promise<boolean>
  /**
   * The attempt's outcome, for the phone's health line: ok or failed, never a
   * token value.
   */
  outcome?: (result: 'ok' | 'failed') => void
}

/** Lenient reader: a paste may carry either token, a refresh response both. */
function readTokenPair(body: unknown): XTokenPair | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as { access_token?: unknown; refresh_token?: unknown }
  const accessToken = typeof b.access_token === 'string' ? b.access_token : ''
  const refreshToken = typeof b.refresh_token === 'string' ? b.refresh_token : ''
  if (!accessToken && !refreshToken) return null
  return { accessToken, refreshToken }
}

/**
 * The phone paste field accepts what X hands you: the whole token JSON
 * ({"token_type":"bearer","expires_in":7200,"access_token":"…","scope":"…",
 * "refresh_token":"…"}) or a bare access token. A paste that claims to be the
 * token JSON but does not read as one — clipped by the phone keyboard, quotes
 * rewritten by autocorrect, half the copy — is refused (`unparsable`) instead
 * of being read as a bare access token: storing the wreckage would save
 * garbage over a good credential.
 */
export type XPasteParse =
  | { ok: true; pair: XTokenPair }
  | { ok: false; reason: 'unparsable' }

export function parseXTokenPaste(raw: string): XPasteParse {
  const text = raw.trim()
  // A bare access token is one unbroken value: no braces, no quoted JSON
  // field names. Anything JSON-shaped is parsed or refused, never treated as
  // a token value — including a paste that lost its opening or closing brace.
  const jsonShaped =
    text.startsWith('{') || text.endsWith('}') ||
    /"\s*(?:access_token|refresh_token)\s*"/.test(text)
  if (jsonShaped) {
    try {
      const pair = readTokenPair(JSON.parse(text))
      if (pair !== null && (pair.accessToken !== '' || pair.refreshToken !== '')) return { ok: true, pair }
    } catch {
      // clipped or quote-rewritten: refused below
    }
    return { ok: false, reason: 'unparsable' }
  }
  return { ok: true, pair: { accessToken: text, refreshToken: '' } }
}

/**
 * Exchange a refresh token for a fresh pair at the OAuth token endpoint. The
 * request is form-encoded with no client secret (a native public client), and
 * it is the only non-GET call in this file. X rotates the refresh token here:
 * the caller must persist the returned pair at once.
 */
export async function refreshXToken(opts: {
  refreshToken: string
  base?: string
  fetch?: typeof fetch
  clientId?: string
  timeoutMs?: number
}): Promise<XTokenPair> {
  const clientId = (opts.clientId ?? '').trim()
  // Fail closed before any request: with no client id saved there is no app
  // to renew against, and the honest answer is the missing configuration,
  // never a request that names some other app.
  if (!clientId) throw new XTransportError('auth', 'No X app client id is saved in Setup')
  if (uncertainRefreshes.has(opts.refreshToken)) throw unknownRenewal()
  const base = (opts.base ?? DEFAULT_BASE).replace(/\/+$/, '')
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init))
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: clientId,
  }).toString()
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(unknownRenewal())
    }, opts.timeoutMs ?? 20_000)
  })
  const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, deadline])
  try {
    let res: Response
    try {
      res = await bounded(doFetch(`${base}${OAUTH_TOKEN_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'manual',
        signal: controller.signal,
      }))
    } catch {
      uncertainRefreshes.add(opts.refreshToken)
      throw unknownRenewal()
    }
    if (res.status === 400 || res.status === 401) throw new XTransportError('auth', 'X rejected the token')
    // 402 is the credit balance, not a rate limit: the owner can fix it in the
    // X console, and the phone must be able to say exactly that.
    if (res.status === 402) throw new XTransportError('credits', 'X API credits depleted')
    if (res.status === 403) throw new XTransportError('forbidden', 'X refused this request for the account’s access level')
    if (res.status === 429) throw new XTransportError('quota', 'X rate or usage limit')
    if (!res.ok) throw new XTransportError('service', `X HTTP ${res.status}`)
    let pair: XTokenPair | null
    try {
      pair = readTokenPair(await bounded(res.json()))
    } catch {
      uncertainRefreshes.add(opts.refreshToken)
      throw unknownRenewal()
    }
    if (pair === null || !pair.accessToken) throw new XTransportError('auth', 'X rejected the token')
    // X normally rotates the refresh token too; if a response omits it, the one
    // just presented stays valid until it is actually consumed.
    return { accessToken: pair.accessToken, refreshToken: pair.refreshToken || opts.refreshToken }
  } finally { clearTimeout(timeout!) }
}

// A lost response is not proof the one-use refresh grant was unconsumed.
// Also protects repeated standalone refresh-only pastes in this launch.
const uncertainRefreshes = new Set<string>()
const unknownRenewal = (): XTransportError => new XTransportError(
  'network', 'X renewal could not be confirmed. Reconnect with a fresh token JSON from X.', true,
)

export function createXTransport(opts: XTransportOptions): XTransport {
  const base = (opts.base ?? DEFAULT_BASE).replace(/\/+$/, '')
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init))
  // A renewal replaces this for the rest of this instance's life, so a page
  // fetched after a recovery never re-presents the dead token.
  let token = opts.token

  /** One renewal: mint, persist, and hand back the new access token. */
  async function rotate(): Promise<string> {
    const refreshToken = opts.refresh?.token() ?? ''
    if (!refreshToken) {
      opts.refresh?.outcome?.('failed')
      throw new XTransportError('auth', 'X rejected the token')
    }
    let pair: XTokenPair
    try {
      pair = await refreshXToken({ refreshToken, base, fetch: doFetch, clientId: opts.clientId, timeoutMs: opts.timeoutMs })
    } catch (err) {
      if (err instanceof XTransportError && err.renewalUnknown) {
        // Disable renewal durably where possible, without guessing a rotated
        // pair. Quarantine above still prevents replay if storage is broken.
        try { await opts.refresh?.persist?.({ accessToken: token, refreshToken: '' }) } catch { /* reconnect remains required */ }
      }
      opts.refresh?.outcome?.('failed')
      throw err instanceof XTransportError ? err : new XTransportError('auth', 'X rejected the token')
    }
    // Persist before the retry reads with it: the old pair is already dead.
    if (opts.refresh?.persist && (await opts.refresh.persist(pair)) !== true) {
      opts.refresh.outcome?.('failed')
      throw new XTransportError('service', 'X rotated the token but this phone could not save it')
    }
    opts.refresh?.outcome?.('ok')
    return pair.accessToken
  }

  async function get<T>(path: string, query: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(query).toString()
    let res: Response
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000)
    const send = async (): Promise<Response> => {
      try {
        return await doFetch(`${base}${path}${qs ? `?${qs}` : ''}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          redirect: 'manual',
          signal: controller.signal,
        })
      } catch {
        throw new XTransportError('network', 'X unreachable')
      }
    }
    try {
      res = await send()
      // A 401 is the only signal that an access token died. It earns exactly
      // one renewal, then the retry stands on its own: a second failure is
      // reported, never retried again.
      if (res.status === 401 && opts.refresh) {
        token = await rotate()
        res = await send()
      }
      if (res.status === 401) throw new XTransportError('auth', 'X rejected the token')
      // 402 is the project's credit balance (the X console answers it);
      // 429 is a rate limit. The phone distinguishes the two.
      if (res.status === 402) throw new XTransportError('credits', 'X API credits depleted')
      if (res.status === 403) throw new XTransportError('forbidden', 'X refused this request for the account’s access level')
      if (res.status === 404) throw new XTransportError('not_found', 'X has no such resource')
      if (res.status === 429) throw new XTransportError('quota', 'X rate or usage limit')
      if (!res.ok) throw new XTransportError('service', `X HTTP ${res.status}`)
      try {
        return (await res.json()) as T
      } catch {
        throw new XTransportError(controller.signal.aborted ? 'network' : 'service', 'X returned an unreadable response')
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  type Envelope<D> = { data?: D; includes?: XIncludes; meta?: { next_token?: string }; errors?: unknown[] }

  return {
    async me() {
      const body = await get<Envelope<XUser>>('/2/users/me', { 'user.fields': USER_FIELDS })
      if (!body.data || !NUMERIC_ID.test(body.data.id)) throw new XTransportError('service', 'X returned no user')
      return body.data
    },
    async userByUsername(handle) {
      const h = handle.replace(/^@/, '')
      if (!HANDLE.test(h)) throw new XTransportError('not_found', 'not an X handle')
      const body = await get<Envelope<XUser>>(`/2/users/by/username/${h}`, { 'user.fields': USER_FIELDS })
      if (!body.data || !NUMERIC_ID.test(body.data.id)) throw new XTransportError('not_found', 'X has no such account')
      return body.data
    },
    async ownerPosts(userId, startTime, paginationToken, sinceId) {
      if (!NUMERIC_ID.test(userId)) throw new XTransportError('not_found', 'not an X user id')
      const query: Record<string, string> = {
        max_results: '100',
        exclude: 'retweets',
        'tweet.fields': POST_FIELDS,
        expansions: EXPANSIONS,
        'user.fields': USER_FIELDS,
        // since_id is exact (every post with a greater id); start_time only
        // covers the first check, where no id has been seen yet.
        ...(sinceId ? { since_id: sinceId } : { start_time: startTime }),
      }
      if (paginationToken) query.pagination_token = paginationToken
      const body = await get<Envelope<XPost[]>>(`/2/users/${userId}/tweets`, query)
      return { posts: body.data ?? [], includes: body.includes ?? {}, nextToken: body.meta?.next_token ?? null }
    },
    async post(id) {
      if (!NUMERIC_ID.test(id)) return null
      try {
        const body = await get<Envelope<XPost>>(`/2/tweets/${id}`, {
          'tweet.fields': POST_FIELDS,
          expansions: EXPANSIONS,
          'user.fields': USER_FIELDS,
        })
        if (!body.data) return null
        return { post: body.data, includes: body.includes ?? {} }
      } catch (err) {
        if (err instanceof XTransportError && err.kind === 'not_found') return null
        throw err
      }
    },
  }
}

/** The numeric post id in an x.com / twitter.com status link, or null. */
export function postIdFromLink(link: string): string | null {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase().replace(/^(www\.|mobile\.)/, '')
  if (host !== 'x.com' && host !== 'twitter.com') return null
  const m = /^\/(?:[A-Za-z0-9_]{1,15}|i(?:\/web)?)\/status(?:es)?\/(\d{1,20})(?:\/|$)/.exec(url.pathname)
  return m ? m[1] : null
}
