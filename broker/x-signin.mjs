/**
 * Host-run X sign-in (docs/design/REDESIGN-PLAN.md C7): OAuth 2.0 PKCE on the
 * paired Factory computer, so the phone never asks for token JSON.
 *
 *   phone  POST /v1/native/x/signin { clientId? }   -> { state: 'pending', startedAt }
 *   host   opens the system browser at X's authorize page (S256 challenge, state)
 *   X      redirects to http://127.0.0.1:<port>/x/callback on this computer
 *   host   checks the state, exchanges the code with the verifier, reads /2/users/me
 *   phone  GET /v1/native/x/signin                   -> { state: 'connected', handle }
 *
 * The token pair goes to the existing x-credential store through the
 * broker's host X reader (server.mjs adoptSignedIn): when the reader already
 * has an enabled configuration it resumes on the new pair; otherwise the pair
 * is held in this process's memory only until the phone sends its reader
 * settings (a handoff without tokens), so no grant rests on disk unconfigured.
 *
 * Nothing here logs or returns a token. The redirect listener binds loopback
 * only, accepts exactly one matching callback and closes; the flow expires
 * after 10 minutes. The default port is 47823 (SPRIITE_X_SIGNIN_PORT), and the
 * X app must list http://127.0.0.1:47823/x/callback as a callback URL.
 */
import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { X_TOKEN_URL } from './x-credential.mjs'

export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize'
export const X_ME_URL = 'https://api.x.com/2/users/me'
/** What the host reader needs: read posts and users, and renew without the owner (offline.access). */
export const X_SIGNIN_SCOPES = Object.freeze(['tweet.read', 'users.read', 'offline.access'])
export const X_SIGNIN_DEFAULT_PORT = 47823
export const X_SIGNIN_CALLBACK_PATH = '/x/callback'
export const X_SIGNIN_TTL_MS = 10 * 60 * 1000
const CLIENT_ID = /^[A-Za-z0-9._~-]{1,256}$/
const TOKEN = /^[\x21-\x7e]{1,4096}$/
const USER_ID = /^[0-9]{1,20}$/
const HANDLE = /^[A-Za-z0-9_]{1,15}$/

const b64u = bytes => Buffer.from(bytes).toString('base64url')
/** RFC 7636: a 43-char verifier and its S256 challenge. */
export function pkcePair(random = randomBytes) {
  const verifier = b64u(random(32))
  return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) }
}
export function authorizeUrl({ clientId, redirectUri, state, challenge, scopes = X_SIGNIN_SCOPES }) {
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: scopes.join(' '),
    state, code_challenge: challenge, code_challenge_method: 'S256',
  })
  return `${X_AUTHORIZE_URL}?${q}`
}
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** open (macOS) / xdg-open (Linux), detached; the URL is an argument, never a shell string. */
export function defaultOpenBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const cmd = platform === 'darwin' ? 'open' : 'xdg-open'
  return new Promise(resolve => {
    try {
      const child = spawnImpl(cmd, [url], { stdio: 'ignore', detached: true })
      child.once?.('error', () => resolve(false))
      child.once?.('spawn', () => resolve(true))
      child.unref?.()
    } catch { resolve(false) }
  })
}

const PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
  `<title>${title}</title><body style="margin:0;background:#07110A;color:#EAF5EC;font:16px/1.45 'Instrument Sans','Helvetica Neue',Helvetica,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center">` +
  `<main style="max-width:420px;padding:24px"><h1 style="font:700 28px/1.1 'Bricolage Grotesque',Georgia,serif;margin:0 0 8px">${title}</h1><p style="margin:0;color:#9AB1A0">${body}</p></main>`

/**
 * One sign-in at a time. `onCredential(pair)` receives the verified pair
 * ({ accessToken, refreshToken, expiresAt, clientId, ownerId, handle }) and
 * stores it; the sign-in keeps no copy unless `hold` is answered.
 */
export function createHostXSignIn({
  clientId: defaultClientId = '', port = X_SIGNIN_DEFAULT_PORT, host = '127.0.0.1',
  fetch: fetchImpl = globalThis.fetch, openBrowser = defaultOpenBrowser, now = Date.now,
  random = randomBytes, ttlMs = X_SIGNIN_TTL_MS, onCredential = async () => ({ held: true }),
  available = () => true,
} = {}) {
  let state = { state: 'idle' }
  let flow = null
  let held = null

  const finish = next => {
    state = next
    const f = flow
    flow = null
    if (f) {
      clearTimeout(f.timer)
      f.server.close()
      f.server.closeAllConnections?.()
    }
  }

  async function exchange(f, code) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: f.redirectUri, code_verifier: f.verifier, client_id: f.clientId,
    })
    let res
    try {
      res = await fetchImpl(X_TOKEN_URL, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: String(body),
      })
    } catch { return { error: 'x_signin_unreachable' } }
    let tokens = null
    try { tokens = await res.json() } catch {}
    if (!res.ok) return { error: res.status === 400 || res.status === 401 ? 'x_signin_rejected' : 'x_signin_service' }
    const accessToken = tokens?.access_token, refreshToken = tokens?.refresh_token
    if (!TOKEN.test(accessToken ?? '')) return { error: 'x_signin_rejected' }
    if (!TOKEN.test(refreshToken ?? '')) return { error: 'x_signin_no_refresh' }
    const seconds = Number(tokens.expires_in)
    const expiresAt = new Date(now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 7200) * 1000).toISOString()
    let me
    try {
      const r = await fetchImpl(`${X_ME_URL}?user.fields=username`, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } })
      me = r.ok ? (await r.json())?.data : null
    } catch { me = null }
    if (!USER_ID.test(me?.id ?? '')) return { error: 'x_signin_unverified' }
    return { pair: { accessToken, refreshToken, expiresAt, clientId: f.clientId, ownerId: me.id, handle: HANDLE.test(me.username ?? '') ? me.username : null } }
  }

  async function callback(f, url, response) {
    const send = (status, title, text) => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      response.end(PAGE(title, text))
    }
    if (f.done) { send(410, 'Already used', 'This sign-in link was already used. Start again from Spriite on your phone.'); return }
    f.done = true
    if (!sameText(url.searchParams.get('state'), f.state)) {
      send(400, 'Sign-in did not match', 'Start the X sign-in again from Spriite on your phone.')
      finish({ state: 'failed', reason: 'x_signin_state_mismatch' })
      return
    }
    const code = url.searchParams.get('code')
    if (url.searchParams.get('error') || !code) {
      send(400, 'X sign-in was cancelled', 'Nothing was connected. You can start again from Spriite on your phone.')
      finish({ state: 'failed', reason: 'x_signin_denied' })
      return
    }
    const result = await exchange(f, code)
    if (result.error) {
      send(502, 'X sign-in failed', 'X did not complete the sign-in. Start again from Spriite on your phone.')
      finish({ state: 'failed', reason: result.error })
      return
    }
    let outcome
    try { outcome = await onCredential(result.pair) } catch (error) {
      send(503, 'Could not save the sign-in', 'Spriite could not store the X sign-in on this computer. Start again from your phone.')
      finish({ state: 'failed', reason: typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : 'x_signin_store_failed' })
      return
    }
    held = outcome?.held ? result.pair : null
    send(200, 'Signed in to X', 'You can close this tab and go back to Spriite.')
    finish({ state: 'connected', handle: result.pair.handle })
  }

  async function start(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'clientId')) {
      return { state: 'failed', reason: 'invalid_fields' }
    }
    if (!available()) return { state: 'unavailable', reason: 'x_reader_unavailable' }
    const clientId = typeof input.clientId === 'string' && input.clientId.trim() ? input.clientId.trim() : defaultClientId
    if (!CLIENT_ID.test(clientId ?? '')) return { state: 'failed', reason: clientId ? 'x_client_id_invalid' : 'x_client_id_required' }
    if (flow) finish({ state: 'idle' })
    const { verifier, challenge } = pkcePair(random)
    const f = { clientId, verifier, state: b64u(random(16)), done: false, redirectUri: '', server: null, timer: null }
    f.server = createServer({ requestTimeout: 10000, headersTimeout: 5000 }, (request, response) => {
      let url
      try { url = new URL(request.url ?? '/', 'http://127.0.0.1') } catch { url = null }
      if (request.method !== 'GET' || !url || url.pathname !== X_SIGNIN_CALLBACK_PATH) {
        response.writeHead(404, { 'content-type': 'text/plain' }); response.end('not found'); return
      }
      callback(f, url, response).catch(() => {
        try { response.writeHead(500); response.end() } catch {}
        finish({ state: 'failed', reason: 'x_signin_failed' })
      })
    })
    try {
      await new Promise((resolve, reject) => {
        f.server.once('error', reject)
        f.server.listen(port, host, () => { f.server.removeListener('error', reject); resolve() })
      })
    } catch (error) {
      return (state = { state: 'failed', reason: error?.code === 'EADDRINUSE' ? 'x_signin_port_busy' : 'x_signin_listen_failed' })
    }
    f.redirectUri = `http://127.0.0.1:${f.server.address().port}${X_SIGNIN_CALLBACK_PATH}`
    f.timer = setTimeout(() => { if (flow === f) finish({ state: 'failed', reason: 'x_signin_expired' }) }, ttlMs)
    f.timer.unref?.()
    flow = f
    held = null
    state = { state: 'pending', startedAt: now() }
    const opened = await openBrowser(authorizeUrl({ clientId, redirectUri: f.redirectUri, state: f.state, challenge }))
    if (opened === false && flow === f) finish({ state: 'failed', reason: 'x_signin_browser_unavailable' })
    return state
  }

  return {
    start,
    status: async () => (available() || state.state !== 'idle' ? state : { state: 'unavailable', reason: 'x_reader_unavailable' }),
    /** The verified pair waiting for the phone's reader settings (token-less handoff), or null. */
    heldPair: () => held,
    clearHeld: () => { held = null },
    /** The live redirect URI while a sign-in is pending (tests, diagnostics). */
    redirectUri: () => flow?.redirectUri ?? null,
    close: () => { if (flow) finish({ state: 'idle' }) },
  }
}
