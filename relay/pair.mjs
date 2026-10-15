/**
 * Pairing mailbox (docs/design/PAIRING-PROTOCOL.md): a short-lived rendezvous
 * for `spriite pair` and "Move to another phone". It holds only what the two
 * ends post: a public mailbox slot, a random session id, public CPace shares,
 * key-confirmation tags and AES-GCM ciphertext. It cannot read a bundle, and
 * it cannot test a guessed code offline (CPace); the one thing an active relay
 * can do is spend the one claim each code allows.
 *
 *   POST /pair/v1/open   host:  { kind, slot, sid, ya }           -> { hostToken, expiresAt, now }
 *   POST /pair/v1/claim  phone: { kind, slot }                    -> { sid, ya, claimToken, expiresAt, now }
 *   POST /pair/v1/put    either: { kind, slot, sid, token, role, msg }
 *   POST /pair/v1/poll   host:  { kind, slot, sid, token }        -> { claimed, msg, closed, expiresAt, now }
 *   POST /pair/v1/get    phone: { kind, slot, sid, token }        -> { msg, closed, expiresAt, now }
 *   POST /pair/v1/close  either: { kind, slot, sid, token, reason }
 *
 * Rules: one open session per slot (a second open answers 409 slot_taken and
 * the host re-rolls its code), one claim per session, one message per role,
 * every record gone 10 minutes after it opened, a per-client claim rate
 * limit, and a request body cap of 1 MB. Closing drops the messages at once
 * and keeps only a tombstone (the reason) until the record expires.
 *
 * Storage is injected: an in-memory Map with a TTL sweep for the Node runner,
 * a Durable Object's storage on Cloudflare (worker.js), where one object
 * serializes every request so claim-once is strongly consistent. Nothing is
 * logged.
 */
export const PAIR_TTL_MS = 10 * 60 * 1000
export const PAIR_BODY_MAX = 1_000_000
export const PAIR_CLAIMS_PER_MINUTE = 10
export const PAIR_OPENS_PER_MINUTE = 30
/** How long an expired session's bare tombstone (no data) answers "expired". */
const TOMBSTONE_MS = 60_000
const ROUTES = new Set(['open', 'claim', 'put', 'poll', 'get', 'close'])
const SLOT = { pair: /^[0-9A-HJKMNP-TV-Z]{2}$/, move: /^[A-Z]{2,6}$/ }
const B64U = (min, max) => new RegExp(`^[A-Za-z0-9_-]{${min},${max}}$`)
const SID = B64U(22, 22)
const POINT = B64U(43, 43)
const TOKEN = B64U(32, 64)
const CLOSE_REASONS = new Set(['done', 'burned', 'cancelled', 'expired'])

/** In-memory store for the Node runner (and tests): a Map plus a TTL sweep. */
export function createMemoryStore() {
  const map = new Map()
  return {
    async get(key) { return map.get(key) ?? null },
    async put(key, value) { map.set(key, structuredClone(value)) },
    async delete(key) { map.delete(key) },
    async entries() { return [...map.entries()] },
    get size() { return map.size },
  }
}

/** A Durable Object's transactional storage behind the same interface. */
export function durableStore(storage) {
  return {
    async get(key) { return (await storage.get(key)) ?? null },
    async put(key, value) { await storage.put(key, value) },
    async delete(key) { await storage.delete(key) },
    async entries() { return [...(await storage.list()).entries()] },
  }
}

function randomToken() {
  const b = new Uint8Array(32)
  globalThis.crypto.getRandomValues(b)
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** A bounded JSON value: plain objects of strings only, at most 3 levels. */
function shapedMessage(v, depth = 0) {
  if (typeof v === 'string') return v.length <= PAIR_BODY_MAX
  if (!v || typeof v !== 'object' || Array.isArray(v) || depth > 2) return false
  const keys = Object.keys(v)
  return keys.length <= 8 && keys.every(k => /^[a-z]{1,12}$/i.test(k) && shapedMessage(v[k], depth + 1))
}

/**
 * The mailbox. `handle(request, cors, json)` answers a /pair/v1/* request or
 * null for any other path; `sweep()` drops expired records.
 */
export function createPairMailbox({
  store = createMemoryStore(), now = Date.now, ttlMs = PAIR_TTL_MS,
  claimsPerMinute = PAIR_CLAIMS_PER_MINUTE, opensPerMinute = PAIR_OPENS_PER_MINUTE,
} = {}) {
  const buckets = new Map()
  const limited = (name, client, perMinute) => {
    const key = `${name}:${client}`
    const t = now()
    const b = buckets.get(key)
    if (!b || t - b.start >= 60_000) { buckets.set(key, { start: t, n: 1 }); return false }
    if (b.n >= perMinute) return true
    b.n++
    return false
  }
  const keyOf = (kind, slot) => `slot:${kind}:${slot}`

  /**
   * The live record, or { expired: true }. An expired record is cut down to a
   * bare tombstone at once (no shares, tokens or ciphertext), so both ends
   * still read "expired" rather than "not found" until the sweep drops it a
   * minute later.
   */
  async function live(kind, slot) {
    const key = keyOf(kind, slot)
    const rec = await store.get(key)
    if (!rec) return null
    if (rec.expired || now() >= rec.expiresAt) {
      if (!rec.expired) await store.put(key, { kind, slot, sid: rec.sid, expiresAt: rec.expiresAt, expired: true })
      return { expired: true }
    }
    return rec
  }

  async function sweep() {
    const t = now()
    for (const [key, rec] of await store.entries()) {
      if (!rec || t >= rec.expiresAt + TOMBSTONE_MS) await store.delete(key)
      else if (t >= rec.expiresAt && !rec.expired) await store.put(key, { kind: rec.kind, slot: rec.slot, sid: rec.sid, expiresAt: rec.expiresAt, expired: true })
    }
    for (const [key, b] of buckets) if (t - b.start >= 60_000) buckets.delete(key)
  }

  const err = (status, error) => ({ status, body: { error } })
  const ok = body => ({ status: 200, body: { ...body, now: now() } })

  async function route(name, input, client) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return err(400, 'bad_request')
    const { kind, slot } = input
    if (!SLOT[kind]?.test(slot)) return err(400, 'bad_request')
    if (name === 'open') {
      if (!SID.test(input.sid) || !input.ya || !POINT.test(input.ya.code) || !POINT.test(input.ya.qr)) return err(400, 'bad_request')
      if (limited('open', client, opensPerMinute)) return err(429, 'rate_limited')
      const existing = await live(kind, slot)
      if (existing && !existing.expired && !existing.closed) return err(409, 'slot_taken')
      const rec = {
        kind, slot, sid: input.sid, ya: { code: input.ya.code, qr: input.ya.qr },
        createdAt: now(), expiresAt: now() + ttlMs, hostToken: randomToken(),
        claimToken: null, a: null, b: null, closed: null,
      }
      await store.put(keyOf(kind, slot), rec)
      return ok({ hostToken: rec.hostToken, expiresAt: rec.expiresAt })
    }
    if (name === 'claim') {
      if (limited('claim', client, claimsPerMinute)) return err(429, 'rate_limited')
      const rec = await live(kind, slot)
      if (!rec) return err(404, 'not_found')
      if (rec.expired) return err(410, 'expired')
      if (rec.claimToken || rec.closed) return err(409, 'used')
      rec.claimToken = randomToken()
      await store.put(keyOf(kind, slot), rec)
      return ok({ sid: rec.sid, ya: rec.ya, claimToken: rec.claimToken, expiresAt: rec.expiresAt })
    }
    // Every other route names its session and proves its role.
    if (!SID.test(input.sid) || !TOKEN.test(input.token ?? '')) return err(400, 'bad_request')
    const rec = await live(kind, slot)
    if (!rec) return err(404, 'not_found')
    if (rec.expired) return err(410, 'expired')
    if (rec.sid !== input.sid) return err(404, 'not_found')
    const role = sameToken(input.token, rec.hostToken) ? 'a' : rec.claimToken && sameToken(input.token, rec.claimToken) ? 'b' : null
    if (!role) return err(403, 'forbidden')
    if (name === 'put') {
      if (input.role !== role || !shapedMessage(input.msg) || typeof input.msg !== 'object') return err(400, 'bad_request')
      if (rec.closed) return err(409, 'used')
      if (role === 'a' && !rec.claimToken) return err(409, 'not_claimed')
      if (rec[role]) return err(409, 'used')
      rec[role] = input.msg
      await store.put(keyOf(kind, slot), rec)
      return ok({})
    }
    if (name === 'poll') {
      if (role !== 'a') return err(403, 'forbidden')
      return ok({ claimed: !!rec.claimToken, msg: rec.b, delivered: rec.delivered === true, closed: rec.closed, expiresAt: rec.expiresAt })
    }
    if (name === 'get') {
      if (role !== 'b') return err(403, 'forbidden')
      if (rec.a && !rec.delivered) { rec.delivered = true; await store.put(keyOf(kind, slot), rec) }
      return ok({ msg: rec.a, closed: rec.closed, expiresAt: rec.expiresAt })
    }
    if (name === 'close') {
      const reason = CLOSE_REASONS.has(input.reason) ? input.reason : 'cancelled'
      if (!rec.closed) {
        // A closed session keeps only its tombstone: the ciphertext and shares go now.
        const tomb = { ...rec, ya: null, a: rec.a?.error ? rec.a : null, b: null, closed: reason }
        await store.put(keyOf(kind, slot), tomb)
      }
      return ok({})
    }
    return err(404, 'not_found')
  }

  /**
   * One /pair/v1/* request. `cors` is the bridge's CORS header set; `client`
   * is the caller's address as the runner saw it (for the claim rate limit).
   */
  async function handle(request, { cors = new Headers(), client = 'unknown', readBody } = {}) {
    const url = new URL(request.url)
    const m = /^\/pair\/v1\/([a-z]+)$/.exec(url.pathname)
    if (!url.pathname.startsWith('/pair/v1/') && url.pathname !== '/pair/v1') return null
    const reply = ({ status, body }) => {
      const h = new Headers(cors)
      h.set('Content-Type', 'application/json; charset=utf-8')
      h.set('Cache-Control', 'no-store')
      return new Response(JSON.stringify(body), { status, headers: h })
    }
    if (!m || !ROUTES.has(m[1])) return reply(err(404, 'not_found'))
    if (request.method !== 'POST') return reply(err(405, 'post_only'))
    if (url.search) return reply(err(400, 'bad_request'))
    const read = readBody ? await readBody(request, PAIR_BODY_MAX) : { bytes: new Uint8Array(await request.arrayBuffer()) }
    if (read.tooLarge || (read.bytes && read.bytes.byteLength > PAIR_BODY_MAX)) return reply(err(413, 'too_large'))
    if (read.failed || !read.bytes) return reply(err(400, 'bad_request'))
    let input
    try { input = JSON.parse(new TextDecoder().decode(read.bytes)) } catch { return reply(err(400, 'bad_request')) }
    try { return reply(await route(m[1], input, client)) } catch { return reply(err(503, 'mailbox_unavailable')) }
  }

  return { handle, sweep, route }
}
