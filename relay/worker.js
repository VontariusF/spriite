/**
 * Spriite relay: a stateless CORS bridge for the APIs that do not grant
 * CORS to browser origins (api.factory.ai, api.cursor.com, api.x.com).
 *
 *   /factory/<path>  ->  https://api.factory.ai/<path>
 *   /cursor/<path>   ->  https://api.cursor.com/<path>
 *   /x/<path>        ->  https://api.x.com/<path>   (owner intake)
 *
 * The X route is narrow (spec §21): the four lookups owner intake reads
 * (GET/HEAD only) plus exactly one fixed POST, the OAuth token endpoint that
 * renews the owner's own token pair. That POST is a fixed destination with a
 * pass-through body: the relay has no general write proxy, and cannot post,
 * reply, like, or repost on anyone's behalf.
 *
 * The /spriite/* archive routes (docs/VPS-ARCHIVE-SPEC.md) are not here on
 * purpose: the worker has no SQLite, so it answers those paths with its usual
 * 404. They live on the Node runner only (node.mjs + archive.mjs).
 *
 * The /pair/v1/* pairing mailbox (relay/pair.mjs, docs/design/PAIRING-
 * PROTOCOL.md) is the one stateful part: it holds public CPace shares and
 * AES-GCM ciphertext for at most 10 minutes so `spriite pair` (and "Move to
 * another phone") can hand an end-to-end encrypted bundle to a phone. On
 * Cloudflare it lives in one Durable Object (PairMailbox, bound as
 * PAIR_MAILBOX in wrangler.toml) so a code is claimed exactly once; the Node
 * runner keeps it in memory. The relay cannot read what it holds.
 *
 * The bridge forwards the method, path, query, body, and only the
 * Authorization, Content-Type, and Accept headers. It stores nothing, logs
 * nothing, and refuses every other destination and path. Runs as a Cloudflare Worker
 * (wrangler.toml) or under Node 22+ (node.mjs, which needs node:sqlite for
 * the archive mirror it also hosts).
 *
 * Optional env ALLOWED_ORIGINS: comma-separated origins allowed to read
 * responses. Default "*" (the plugin WebView origin is host-defined).
 */

import { createPairMailbox, durableStore, PAIR_BODY_MAX } from './pair.mjs'

/** The one non-GET X route: token renewal, POST only, fixed destination. */
const X_OAUTH_TOKEN_PATH = /^\/2\/oauth2\/token$/

/**
 * The write routes this relay serves, declared in one shape so the
 * source-grep test can count them. Three exist across the relay sources:
 * this one — the X OAuth token POST — plus the two archive POSTs in
 * archive.mjs, which only the Node runner serves. Adding a route here means
 * updating that count; there is no other way to write through this relay.
 */
const WRITE_ROUTES = [{ method: 'POST', path: X_OAUTH_TOKEN_PATH }]

const UPSTREAMS = {
  factory: { origin: 'https://api.factory.ai', paths: [/^\/api\/v0\//] },
  cursor: { origin: 'https://api.cursor.com', paths: [/^\/v0\//, /^\/v1\//] },
  x: {
    origin: 'https://api.x.com',
    paths: [
      /^\/2\/users\/me$/,
      /^\/2\/users\/by\/username\/[A-Za-z0-9_]{1,15}$/,
      /^\/2\/users\/\d{1,20}\/tweets$/,
      /^\/2\/tweets\/\d{1,20}$/,
      X_OAUTH_TOKEN_PATH,
    ],
    readOnly: true,
  },
}

const FORWARD_HEADERS = ['authorization', 'content-type', 'accept']
const METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
const MAX_BODY_BYTES = 1_000_000

/** exported because archive.mjs answers its two routes with this exact same
 *  policy: no CORS exists beyond what the bridge already sends. */
export function corsHeaders(request, env) {
  const allowed = String(env?.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean)
  const origin = request.headers.get('origin') ?? ''
  const allowOrigin = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : ''
  const h = new Headers({
    'Access-Control-Allow-Methods': METHODS,
    // Authorization is never covered by a "*" allow-headers, so it is named.
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  })
  if (allowOrigin) h.set('Access-Control-Allow-Origin', allowOrigin)
  return h
}

/** read a request body without ever holding more than maxBytes of it: the
 *  declared length is refused first, then the stream is counted chunk by
 *  chunk and cancelled the moment it passes the cap, so a chunked or lying
 *  upload can never land whole in memory. answers { bytes } (null for no
 *  body), { tooLarge: true }, or { failed: true } when the stream breaks.
 *  exported because archive.mjs reads its bodies the same way. */
export async function readCappedBody(request, maxBytes) {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) return { tooLarge: true }
  if (request.body === null) return { bytes: null }
  const reader = request.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        reader.cancel().catch(() => {})
        return { tooLarge: true }
      }
      chunks.push(value)
    }
  } catch {
    return { failed: true }
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.byteLength
  }
  return { bytes }
}

/** exported with corsHeaders: the archive routes speak the same reply shape. */
export function reply(status, text, cors) {
  const h = new Headers(cors)
  h.set('Content-Type', 'text/plain; charset=utf-8')
  return new Response(text, { status, headers: h })
}

/**
 * A /pair/v1/* request: answered by the runner's own mailbox (Node), else by
 * the Durable Object binding (Cloudflare). Without either the mailbox is
 * refused: an isolate's memory is not one consistent mailbox.
 */
async function pairRoute(request, env, cors, ctx) {
  if (ctx?.pair) return ctx.pair.handle(request, { cors, client: ctx.client ?? 'unknown', readBody: readCappedBody })
  const ns = env?.PAIR_MAILBOX
  if (!ns || typeof ns.idFromName !== 'function') return reply(503, 'pairing mailbox not configured', cors)
  if (request.method !== 'POST') return reply(405, 'pairing route is POST only', cors)
  const read = await readCappedBody(request, PAIR_BODY_MAX)
  if (read.tooLarge) return reply(413, 'body too large', cors)
  if (read.failed) return reply(400, 'body unreadable', cors)
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.set('x-spriite-client-ip', request.headers.get('cf-connecting-ip') ?? 'unknown')
  let res
  try {
    const stub = ns.get(ns.idFromName('pair-mailbox-v1'))
    res = await stub.fetch(new Request(request.url, { method: request.method, headers, body: read.bytes ?? '' }))
  } catch {
    return reply(503, 'pairing mailbox unavailable', cors)
  }
  const out = new Headers(cors)
  out.set('Content-Type', 'application/json; charset=utf-8')
  out.set('Cache-Control', 'no-store')
  return new Response(await res.text(), { status: res.status, headers: out })
}

/**
 * The pairing mailbox as one Durable Object: every request runs through one
 * instance, in order, so "one claim per code" holds under any concurrency.
 * Records live in its storage (never longer than 10 minutes); an alarm
 * sweeps expired ones.
 */
export class PairMailbox {
  constructor(state) {
    this.state = state
    this.mailbox = createPairMailbox({ store: durableStore(state.storage) })
  }
  async fetch(request) {
    const res = await this.mailbox.handle(request, { client: request.headers.get('x-spriite-client-ip') ?? 'unknown' })
    try {
      if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + 60_000)
    } catch { /* the next request schedules it */ }
    return res ?? new Response('{"error":"not_found"}', { status: 404 })
  }
  async alarm() {
    await this.mailbox.sweep()
    const left = await this.state.storage.list({ limit: 1 })
    if (left.size > 0) await this.state.storage.setAlarm(Date.now() + 60_000)
  }
}

export async function handle(request, env = {}, ctx = undefined) {
  const cors = corsHeaders(request, env)
  // A browser origin the relay was not configured for can never read the
  // answer, so nothing is forwarded (no key leaves for nothing) and the
  // refusal names the origin, which shows in the relay's own status log.
  const origin = request.headers.get('origin')
  if (origin && !cors.has('Access-Control-Allow-Origin')) {
    return reply(403, `origin not allowed: ${origin.slice(0, 200)} (add it to ALLOWED_ORIGINS)`, cors)
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })

  const url = new URL(request.url)
  if (url.pathname === '/' || url.pathname === '/health') return reply(200, 'spriite relay ok', cors)
  if (url.pathname === '/pair/v1' || url.pathname.startsWith('/pair/v1/')) return pairRoute(request, env, cors, ctx)

  const match = /^\/(factory|cursor|x)(\/.*)$/.exec(url.pathname)
  const upstream = match ? UPSTREAMS[match[1]] : undefined
  const path = match ? match[2] : ''
  if (!upstream || !upstream.paths.some((re) => re.test(path))) return reply(404, 'not relayed', cors)
  if (upstream.readOnly) {
    const write = WRITE_ROUTES.find((r) => r.path.test(path))
    if (write) {
      // exactly one non-GET route, and it answers its declared method only
      if (request.method !== write.method) return reply(405, 'oauth token route is POST only', cors)
    } else if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply(405, 'read-only route', cors)
    }
  }

  const headers = new Headers()
  for (const name of FORWARD_HEADERS) {
    const v = request.headers.get(name)
    if (v) headers.set(name, v)
  }

  let body
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // capped while it streams, never buffered whole first (readCappedBody)
    const read = await readCappedBody(request, MAX_BODY_BYTES)
    if (read.tooLarge) return reply(413, 'body too large', cors)
    if (read.failed) return reply(400, 'body unreadable', cors)
    // an ArrayBuffer, as before: the reader's array is exactly the body's length
    if (read.bytes !== null && read.bytes.byteLength > 0) body = read.bytes.buffer
  }

  let res
  try {
    res = await fetch(`${upstream.origin}${path}${url.search}`, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
    })
  } catch {
    return reply(502, 'upstream unreachable', cors)
  }

  const out = new Headers(cors)
  const type = res.headers.get('content-type')
  if (type) out.set('Content-Type', type)
  return new Response(res.status === 204 || res.status === 304 ? null : res.body, {
    status: res.status,
    headers: out,
  })
}

export default { fetch: handle }
