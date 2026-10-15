/**
 * Read-only X v2 client for the host reader. The only request primitive is a
 * GET to a fixed origin, so there is no code path that posts, replies, likes or
 * reposts; renewal lives in x-credential.mjs. Endpoints: /2/users/me,
 * /2/users/by/username/:username (the handoff's Spriite id), /2/users/:id/tweets
 * and /2/tweets/:id. Fields and expansions match
 * src/intake/x-transport.ts so both readers see the same post shape.
 *
 * A 401 earns exactly one renewal and one retry; a second failure is reported.
 * Errors carry a kind and a code, never a token, URL query or response body.
 */
import { BrokerError } from './validation.mjs'

export const X_API_ORIGIN = 'https://api.x.com'
export const X_ERROR_KINDS = Object.freeze(['auth', 'forbidden', 'quota', 'credits', 'not_found', 'network', 'service'])

const POST_FIELDS = [
  'created_at', 'author_id', 'conversation_id', 'edit_history_tweet_ids', 'entities',
  'referenced_tweets', 'in_reply_to_user_id', 'display_text_range', 'note_tweet',
].join(',')
const EXPANSIONS = 'referenced_tweets.id,referenced_tweets.id.author_id,author_id'
const USER_FIELDS = 'protected,username'
const NUMERIC_ID = /^\d{1,20}$/
const HANDLE = /^[A-Za-z0-9_]{1,15}$/
const PAGINATION_TOKEN = /^[A-Za-z0-9_-]{1,512}$/

export class XClientError extends BrokerError {
  constructor(kind, { reason, renewalUnknown = false } = {}) {
    super(`x_${kind}`, kind === 'not_found' ? 404 : 503)
    this.kind = kind
    this.reason = reason ?? `x_${kind}`
    this.renewalUnknown = renewalUnknown
  }
}

/** Credential-store codes onto the reader's kinds. Rotation loss needs a new
 * handoff (auth); the moment it is lost reads as the network that lost it. */
const RENEWAL_KINDS = {
  x_credential_missing: 'auth', x_renewal_rejected: 'auth', x_credential_replaced: 'auth',
  x_rotation_lost: 'auth', x_renewal_lost: 'network', x_renewal_network: 'network', x_renewal_forbidden: 'forbidden',
  x_renewal_quota: 'quota', x_renewal_credits: 'credits',
}
function renewalError(error) {
  const reason = error instanceof BrokerError ? error.code : 'x_renewal_failed'
  return new XClientError(RENEWAL_KINDS[reason] ?? 'service', {
    reason, renewalUnknown: reason === 'x_rotation_lost' || reason === 'x_renewal_lost',
  })
}
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)

export function createXClient({ credential, fetch = (...args) => globalThis.fetch(...args), timeoutMs = 30000 }) {
  if (!credential || typeof credential.current !== 'function' || typeof credential.renew !== 'function') {
    throw new BrokerError('x_client_configuration_required', 503)
  }

  async function attempt(url, accessToken) {
    const controller = new AbortController()
    let timer
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new XClientError('network', { reason: 'x_timeout' })) }, timeoutMs)
    })
    const bounded = work => Promise.race([work, deadline])
    try {
      let response
      try {
        response = await bounded(fetch(url, {
          method: 'GET', headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'manual', signal: controller.signal,
        }))
      } catch (error) {
        throw error instanceof XClientError ? error : new XClientError('network', { reason: 'x_unreachable' })
      }
      if (response.status === 401) return { unauthorized: true }
      // 402 is the project's credit balance, 429 a rate limit: distinct remedies.
      if (response.status === 402) throw new XClientError('credits')
      if (response.status === 403) throw new XClientError('forbidden')
      if (response.status === 404) throw new XClientError('not_found')
      if (response.status === 429) throw new XClientError('quota')
      if (!response.ok) throw new XClientError('service', { reason: `x_http_${Number(response.status) || 0}` })
      let body
      try { body = await bounded(response.json()) } catch (error) {
        throw error instanceof XClientError ? error : new XClientError('service', { reason: 'x_unreadable' })
      }
      if (!plain(body)) throw new XClientError('service', { reason: 'x_unreadable' })
      return { body }
    } finally { clearTimeout(timer) }
  }

  async function get(path, query) {
    const url = `${X_API_ORIGIN}${path}?${new URLSearchParams(query)}`
    const used = credential.current()
    if (!used) throw new XClientError('auth', { reason: 'x_credential_missing' })
    const first = await attempt(url, used.accessToken)
    if (!first.unauthorized) return first.body
    // Another request may already have renewed past the token this one used.
    if (credential.current()?.accessToken === used.accessToken) {
      try { await credential.renew() } catch (error) { throw renewalError(error) }
    }
    const fresh = credential.current()
    if (!fresh) throw new XClientError('auth', { reason: 'x_credential_missing' })
    const second = await attempt(url, fresh.accessToken)
    if (second.unauthorized) throw new XClientError('auth', { reason: 'x_rejected' })
    return second.body
  }

  return {
    async me() {
      const body = await get('/2/users/me', { 'user.fields': USER_FIELDS })
      if (!plain(body.data) || typeof body.data.id !== 'string' || !NUMERIC_ID.test(body.data.id) ||
          typeof body.data.username !== 'string') throw new XClientError('service', { reason: 'x_no_user' })
      return body.data
    },
    /**
     * The account a handle names, for the handoff's Spriite id. The answer must
     * carry the asked handle (case-insensitively): X's label is never trusted
     * to stand in for a different account.
     */
    async userByUsername(handle) {
      const bare = typeof handle === 'string' ? handle.replace(/^@/, '') : ''
      if (!HANDLE.test(bare)) throw new XClientError('not_found', { reason: 'x_handle_invalid' })
      const body = await get(`/2/users/by/username/${bare}`, { 'user.fields': USER_FIELDS })
      if (!plain(body.data) || typeof body.data.id !== 'string' || !NUMERIC_ID.test(body.data.id) ||
          typeof body.data.username !== 'string' || !HANDLE.test(body.data.username)) {
        throw new XClientError('not_found', { reason: 'x_no_user' })
      }
      if (body.data.username.toLowerCase() !== bare.toLowerCase()) throw new XClientError('service', { reason: 'x_user_mismatch' })
      return body.data
    },
    /** Newest-first page of the user's own posts, reposts excluded. `sinceId`
     * reads exactly the newer posts; `startTime` covers a first read; `untilId`
     * bounds a backlog read to posts older than the oldest one already read. */
    async userPosts(userId, { sinceId, paginationToken, startTime, untilId } = {}) {
      if (typeof userId !== 'string' || !NUMERIC_ID.test(userId)) throw new XClientError('not_found', { reason: 'x_user_id_invalid' })
      if (sinceId !== undefined && sinceId !== null && (typeof sinceId !== 'string' || !NUMERIC_ID.test(sinceId))) {
        throw new XClientError('service', { reason: 'x_since_id_invalid' })
      }
      if (untilId !== undefined && untilId !== null && (typeof untilId !== 'string' || !NUMERIC_ID.test(untilId))) {
        throw new XClientError('service', { reason: 'x_until_id_invalid' })
      }
      if (paginationToken !== undefined && paginationToken !== null &&
          (typeof paginationToken !== 'string' || !PAGINATION_TOKEN.test(paginationToken))) {
        throw new XClientError('service', { reason: 'x_pagination_token_invalid' })
      }
      if (startTime !== undefined && startTime !== null &&
          (typeof startTime !== 'string' || startTime.length > 40 || !Number.isFinite(Date.parse(startTime)))) {
        throw new XClientError('service', { reason: 'x_start_time_invalid' })
      }
      const query = {
        max_results: '100', exclude: 'retweets',
        'tweet.fields': POST_FIELDS, expansions: EXPANSIONS, 'user.fields': USER_FIELDS,
        ...(sinceId ? { since_id: sinceId } : startTime ? { start_time: new Date(startTime).toISOString() } : {}),
        ...(untilId ? { until_id: untilId } : {}),
        ...(paginationToken ? { pagination_token: paginationToken } : {}),
      }
      const body = await get(`/2/users/${userId}/tweets`, query)
      if (body.data !== undefined && !Array.isArray(body.data)) throw new XClientError('service', { reason: 'x_unreadable' })
      const next = body.meta?.next_token
      return {
        posts: body.data ?? [], includes: plain(body.includes) ? body.includes : {},
        nextToken: typeof next === 'string' && PAGINATION_TOKEN.test(next) ? next : null,
      }
    },
    /** One post with its referenced posts expanded; null when gone. */
    async post(id) {
      if (typeof id !== 'string' || !NUMERIC_ID.test(id)) return null
      let body
      try {
        body = await get(`/2/tweets/${id}`, { 'tweet.fields': POST_FIELDS, expansions: EXPANSIONS, 'user.fields': USER_FIELDS })
      } catch (error) {
        if (error instanceof XClientError && error.kind === 'not_found') return null
        throw error
      }
      if (!plain(body.data)) return null
      return { post: body.data, includes: plain(body.includes) ? body.includes : {} }
    },
  }
}
