/**
 * Spriite relay: a stateless CORS bridge for the two APIs that do not grant
 * CORS to browser origins (api.factory.ai, api.cursor.com).
 *
 *   /factory/<path>  ->  https://api.factory.ai/<path>
 *   /cursor/<path>   ->  https://api.cursor.com/<path>
 *
 * It forwards the method, path, query, body, and only the Authorization,
 * Content-Type, and Accept headers. It stores nothing, logs nothing, and
 * refuses every other destination and path. Runs as a Cloudflare Worker
 * (wrangler.toml) or under Node 18+ (node.mjs).
 *
 * Optional env ALLOWED_ORIGINS: comma-separated origins allowed to read
 * responses. Default "*" (the plugin WebView origin is host-defined).
 */

const UPSTREAMS = {
  factory: { origin: 'https://api.factory.ai', paths: [/^\/api\/v0\//] },
  cursor: { origin: 'https://api.cursor.com', paths: [/^\/v0\//, /^\/v1\//] },
}

const FORWARD_HEADERS = ['authorization', 'content-type', 'accept']
const METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
const MAX_BODY_BYTES = 1_000_000

function corsHeaders(request, env) {
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

function reply(status, text, cors) {
  const h = new Headers(cors)
  h.set('Content-Type', 'text/plain; charset=utf-8')
  return new Response(text, { status, headers: h })
}

export async function handle(request, env = {}) {
  const cors = corsHeaders(request, env)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })

  const url = new URL(request.url)
  if (url.pathname === '/' || url.pathname === '/health') return reply(200, 'spriite relay ok', cors)

  const match = /^\/(factory|cursor)(\/.*)$/.exec(url.pathname)
  const upstream = match ? UPSTREAMS[match[1]] : undefined
  const path = match ? match[2] : ''
  if (!upstream || !upstream.paths.some((re) => re.test(path))) return reply(404, 'not relayed', cors)

  const headers = new Headers()
  for (const name of FORWARD_HEADERS) {
    const v = request.headers.get(name)
    if (v) headers.set(name, v)
  }

  let body
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const buf = await request.arrayBuffer()
    if (buf.byteLength > MAX_BODY_BYTES) return reply(413, 'body too large', cors)
    if (buf.byteLength > 0) body = buf
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
