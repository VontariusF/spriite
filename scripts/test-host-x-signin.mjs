/**
 * Host-run X sign-in (OAuth 2.0 PKCE on the paired computer), offline: the
 * S256 challenge, the state check, the loopback redirect, the token exchange
 * with an injected fetch, where the pair goes (credential store + reader
 * resume, or held for a token-less handoff), the broker routes and their
 * bearer gate, and the phone client that drives them.
 *
 * Usage: node --import ./scripts/ts-resolve.mjs scripts/test-host-x-signin.mjs
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  authorizeUrl, createHostXSignIn, defaultOpenBrowser, pkcePair, X_SIGNIN_DEFAULT_PORT, X_SIGNIN_SCOPES,
} from '../broker/x-signin.mjs'
import { adoptSignedIn, createRouter, hostXSignInFor } from '../broker/server.mjs'
import { KeyVault } from '../src/voice/keys.ts'
import { PrefsVault } from '../src/state/prefs.ts'
import { createPairingClient } from '../src/pair/client.ts'

let passed = 0, failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${detail ? ` :: ${detail}` : ''}`) }
}
const section = name => console.log(`\n-- ${name}`)
const ACCESS = 'x-access-fixture-NEVER-ON-PHONE', REFRESH = 'x-refresh-fixture-NEVER-ON-PHONE'
const TOKEN = 'bearer-fixture-0123456789abcdefghijklmnopqrstuvwxyz'

function xFetch({ tokenStatus = 200, tokens = { access_token: ACCESS, refresh_token: REFRESH, expires_in: 7200, token_type: 'bearer' }, me = { id: '111', username: 'owner_handle' } } = {}) {
  const calls = []
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url) === 'https://api.x.com/2/oauth2/token') return new Response(JSON.stringify(tokens), { status: tokenStatus })
    if (String(url).startsWith('https://api.x.com/2/users/me')) return new Response(JSON.stringify({ data: me }), { status: me ? 200 : 401 })
    return new Response('{}', { status: 404 })
  }
  return Object.assign(fn, { calls })
}
async function signInFlow(opts = {}) {
  const opened = []
  const credentials = []
  const fetch = opts.fetch ?? xFetch()
  const signin = createHostXSignIn({
    port: 0, fetch, clientId: opts.clientId ?? 'fixture-client-id',
    openBrowser: opts.openBrowser ?? (async url => { opened.push(url); return true }),
    onCredential: opts.onCredential ?? (async pair => { credentials.push(pair); return { held: true } }),
    ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
  })
  return { signin, opened, credentials, fetch }
}
const redirect = async (signin, query) => {
  const res = await globalThis.fetch(`${signin.redirectUri()}?${new URLSearchParams(query)}`)
  return { status: res.status, text: await res.text() }
}

section('PKCE')
{
  const { verifier, challenge } = pkcePair()
  check('the verifier is 43 base64url characters (RFC 7636)', /^[A-Za-z0-9_-]{43}$/.test(verifier))
  check('the challenge is S256 of the verifier', challenge === createHash('sha256').update(verifier).digest('base64url'))
  const url = new URL(authorizeUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:47823/x/callback', state: 'st', challenge }))
  check('the authorize URL asks for code with S256, the state and a loopback redirect', url.origin === 'https://x.com' &&
    url.searchParams.get('response_type') === 'code' && url.searchParams.get('code_challenge_method') === 'S256' &&
    url.searchParams.get('code_challenge') === challenge && url.searchParams.get('state') === 'st' &&
    url.searchParams.get('redirect_uri') === 'http://127.0.0.1:47823/x/callback')
  check('the scopes are the host reader\'s, including offline.access', url.searchParams.get('scope') === 'tweet.read users.read offline.access' && X_SIGNIN_SCOPES.includes('offline.access'))
  check('the documented default redirect port is 47823', X_SIGNIN_DEFAULT_PORT === 47823)
}

section('the sign-in runs on the host')
{
  const { signin, opened, credentials, fetch } = await signInFlow()
  const started = await signin.start({})
  check('start opens the system browser and reports pending', started.state === 'pending' && opened.length === 1 && opened[0].startsWith('https://x.com/i/oauth2/authorize?'))
  const auth = new URL(opened[0])
  check('the redirect listens on loopback only', /^http:\/\/127\.0\.0\.1:\d+\/x\/callback$/.test(signin.redirectUri()) && auth.searchParams.get('redirect_uri') === signin.redirectUri())
  const back = await redirect(signin, { code: 'auth-code-1', state: auth.searchParams.get('state') })
  check('the callback page tells the owner to go back to Spriite', back.status === 200 && /go back to Spriite/.test(back.text) && !back.text.includes(ACCESS))
  const exchange = fetch.calls.find(c => c.url === 'https://api.x.com/2/oauth2/token')
  const form = new URLSearchParams(exchange?.init.body)
  check('the code is exchanged on the host with the verifier that matches the challenge', form.get('grant_type') === 'authorization_code' && form.get('code') === 'auth-code-1' &&
    createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === auth.searchParams.get('code_challenge') &&
    form.get('client_id') === 'fixture-client-id' && form.get('redirect_uri') === auth.searchParams.get('redirect_uri'))
  check('the verified pair goes to the credential handler with the owner id', credentials.length === 1 && credentials[0].accessToken === ACCESS &&
    credentials[0].refreshToken === REFRESH && credentials[0].ownerId === '111' && credentials[0].clientId === 'fixture-client-id' && Date.parse(credentials[0].expiresAt) > Date.now())
  const status = await signin.status()
  check('status reports connected with the X handle and no token', status.state === 'connected' && status.handle === 'owner_handle' && !JSON.stringify(status).includes(ACCESS))
  check('the held pair waits for the phone\'s reader settings', signin.heldPair()?.accessToken === ACCESS)
  check('the redirect listener is closed after one callback', signin.redirectUri() === null)
}
{
  const { signin, opened, credentials, fetch } = await signInFlow()
  await signin.start()
  const back = await redirect(signin, { code: 'auth-code-2', state: 'forged-state' })
  check('a callback with the wrong state is refused', back.status === 400 && (await signin.status()).reason === 'x_signin_state_mismatch')
  check('a state mismatch never reaches the token endpoint', !fetch.calls.some(c => c.url.includes('oauth2/token')) && credentials.length === 0 && opened.length === 1)
}
{
  const { signin, opened } = await signInFlow()
  await signin.start()
  const back = await redirect(signin, { error: 'access_denied', state: new URL(opened[0]).searchParams.get('state') })
  check('a denied sign-in fails cleanly', back.status === 400 && (await signin.status()).reason === 'x_signin_denied')
}
{
  const { signin, opened, credentials } = await signInFlow({ fetch: xFetch({ tokens: { access_token: ACCESS, expires_in: 7200 } }) })
  await signin.start()
  await redirect(signin, { code: 'c', state: new URL(opened[0]).searchParams.get('state') })
  check('a grant without a refresh token (no offline.access) is refused', (await signin.status()).reason === 'x_signin_no_refresh' && credentials.length === 0)
}
{
  const { signin, opened } = await signInFlow({ fetch: xFetch({ tokenStatus: 400, tokens: { error: 'invalid_grant' } }) })
  await signin.start()
  await redirect(signin, { code: 'c', state: new URL(opened[0]).searchParams.get('state') })
  check('a refused code exchange reads as rejected', (await signin.status()).reason === 'x_signin_rejected')
}
{
  const { signin } = await signInFlow({ clientId: '' })
  check('without a client id the sign-in says so', (await signin.start({})).reason === 'x_client_id_required')
  const { signin: s2, opened } = await signInFlow({ clientId: '' })
  const r = await s2.start({ clientId: 'phone-client-id' })
  check('the client id may come from the request', r.state === 'pending' && new URL(opened[0]).searchParams.get('client_id') === 'phone-client-id')
  s2.close()
  check('unknown fields are refused', (await signin.start({ clientId: 'x', token: 'y' })).reason === 'invalid_fields')
  const env = hostXSignInFor({ xHost: {} }, { SPRIITE_X_CLIENT_ID: 'env-client-id', SPRIITE_X_SIGNIN_PORT: '0' }, { openBrowser: async () => true })
  const fromEnv = await env.start({})
  check('SPRIITE_X_CLIENT_ID is the default client id', fromEnv.state === 'pending')
  env.close()
  const none = hostXSignInFor({ xHost: null }, { SPRIITE_X_SIGNIN_PORT: '0' })
  check('without the host X reader the sign-in is unavailable', (await none.start({ clientId: 'c' })).state === 'unavailable' && (await none.status()).state === 'unavailable')
}
{
  const { signin } = await signInFlow({ openBrowser: async () => false })
  check('no browser on the host fails with the reason', (await signin.start()).reason === 'x_signin_browser_unavailable')
  const { signin: slow } = await signInFlow({ ttlMs: 20 })
  await slow.start()
  await new Promise(resolve => setTimeout(resolve, 60))
  check('an unanswered sign-in expires', (await slow.status()).reason === 'x_signin_expired' && slow.redirectUri() === null)
  const busy = createServer(() => {})
  await new Promise(resolve => busy.listen(0, '127.0.0.1', resolve))
  const taken = createHostXSignIn({ port: busy.address().port, clientId: 'c', openBrowser: async () => true })
  check('a busy redirect port is reported', (await taken.start()).reason === 'x_signin_port_busy')
  busy.close()
  const spawned = []
  const fakeSpawn = (cmd, args) => { spawned.push([cmd, ...args]); return { once: (ev, cb) => { if (ev === 'spawn') setImmediate(cb) }, unref() {} } }
  await defaultOpenBrowser('https://x.com/i/oauth2/authorize?a=1', { platform: 'darwin', spawnImpl: fakeSpawn })
  await defaultOpenBrowser('https://x.com/i/oauth2/authorize?a=1', { platform: 'linux', spawnImpl: fakeSpawn })
  check('the browser opens with open (macOS) or xdg-open (Linux), URL as an argument', spawned[0].join(' ') === 'open https://x.com/i/oauth2/authorize?a=1' && spawned[1][0] === 'xdg-open')
}

section('where the pair goes')
{
  const log = []
  const host = {
    readConfig: () => ({ enabled: true }),
    serial: async op => op(),
    halt: async () => { log.push('halt') },
    credential: { save: pair => { log.push(`save:${pair.ownerId}:${pair.accessToken === ACCESS}`) } },
    resume: async () => { log.push('resume'); return true },
  }
  const r = await adoptSignedIn({ xHost: host }, { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 'z', clientId: 'c', ownerId: '111' })
  check('with an enabled reader the pair goes to the credential store and the reader resumes', r.held === false && log.join() === 'halt,save:111:true,resume')
  log.length = 0
  const held = await adoptSignedIn({ xHost: { ...host, readConfig: () => ({ enabled: false }) } }, { accessToken: ACCESS })
  check('without reader settings the pair stays in memory only (no grant at rest)', held.held === true && log.length === 0)
  let threw = null
  try { await adoptSignedIn({ xHost: null }, {}) } catch (error) { threw = error.code }
  check('without the host X reader nothing is stored', threw === 'x_reader_unavailable')
}

section('broker routes')
{
  const handoffs = []
  const broker = { xHandoff: async input => { handoffs.push(input); return { enabled: true, running: true } } }
  let heldPair = { accessToken: ACCESS, refreshToken: REFRESH, clientId: 'fixture-client-id', expiresAt: '2026-10-14T14:00:00.000Z', ownerId: '111', handle: 'owner_handle' }
  const starts = []
  const xSignIn = {
    start: async input => { starts.push(input); return { state: 'pending', startedAt: 5 } },
    status: async () => ({ state: 'connected', handle: 'owner_handle' }),
    heldPair: () => heldPair, clearHeld: () => { heldPair = null },
  }
  const serve = async (router) => {
    const server = createServer(router)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const call = async (path, { method = 'GET', body, auth = true, headers = {} } = {}) => {
      const res = await fetch(base + path, { method, headers: { ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body) })
      const text = await res.text()
      return { status: res.status, text, body: text ? JSON.parse(text) : null }
    }
    return { server, call }
  }
  const { server, call } = await serve(createRouter({ broker, bearerToken: TOKEN, allowedOrigins: ['https://phone.example'], xSignIn, log: () => {} }))
  try {
    check('POST and GET /v1/native/x/signin need the bearer', (await call('/v1/native/x/signin', { method: 'POST', body: {}, auth: false })).status === 401 &&
      (await call('/v1/native/x/signin', { auth: false })).status === 401)
    const pre = await call('/v1/native/x/signin', { method: 'OPTIONS', auth: false, headers: { origin: 'https://phone.example' } })
    check('the CORS preflight admits the sign-in route', pre.status === 200)
    const started = await call('/v1/native/x/signin', { method: 'POST', body: { clientId: 'phone-client-id' } })
    check('POST starts the host sign-in and answers its state', started.status === 200 && started.body.state === 'pending' && starts[0]?.clientId === 'phone-client-id')
    const status = await call('/v1/native/x/signin')
    check('GET answers the state without any token', status.body.state === 'connected' && !status.text.includes(ACCESS) && !status.text.includes(REFRESH))
    check('a query string is not a sign-in route', (await call('/v1/native/x/signin?x=1')).status === 404)
    const settings = { spriiteHandle: '@SpriiteBot', template: { t: 1 }, delivery: { d: 1 } }
    const handed = await call('/v1/native/x/handoff', { method: 'POST', body: settings })
    check('a token-less handoff after sign-in carries the held pair to the reader', handed.status === 200 && handoffs[0]?.accessToken === ACCESS &&
      handoffs[0]?.refreshToken === REFRESH && handoffs[0]?.clientId === 'fixture-client-id' && handoffs[0]?.spriiteHandle === '@SpriiteBot')
    check('the held pair is used once and never echoed', heldPair === null && !handed.text.includes(ACCESS))
    await call('/v1/native/x/handoff', { method: 'POST', body: { ...settings, accessToken: 'phone-a', refreshToken: 'phone-r', clientId: 'c' } })
    check('a phone-held pair keeps its own handoff path', handoffs[1]?.accessToken === 'phone-a')
  } finally { server.close() }
  const bare = await serve(createRouter({ broker, bearerToken: TOKEN, log: () => {} }))
  try {
    const r = await bare.call('/v1/native/x/signin', { method: 'POST', body: {} })
    check('a broker without host sign-in answers unavailable', r.status === 200 && r.body.state === 'unavailable')
  } finally { bare.server.close() }
}

section('the phone drives the sign-in through its host link')
{
  const map = new Map()
  const gateway = { call: async op => op({ getLocalStorage: async k => map.get(k) ?? '', setLocalStorage: async (k, v) => { map.set(k, v); return true } }) }
  const keys = new KeyVault(gateway), prefs = new PrefsVault(gateway)
  await keys.load(); await prefs.load()
  const calls = []
  let answer = { status: 200, body: { state: 'pending', startedAt: 7 } }
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, auth: init.headers?.authorization, body: init.body })
    if (answer === 'offline') throw new TypeError('offline')
    return new Response(JSON.stringify(answer.body), { status: answer.status })
  }
  const client = createPairingClient({ keys, prefs, feed: { restore: () => [], save: async () => true }, relayBase: '', fetchImpl })
  check('without a paired host the sign-in is unavailable', !client.hostXSignIn.available() && (await client.hostXSignIn.start()).state === 'unavailable' && calls.length === 0)
  await prefs.setPairedHost({ label: 'studio', machineId: 'm1', ownerId: 'owner-example', brokerUrl: 'https://broker.example.com', via: 'tailscale', os: 'macos', pairedAt: 1 })
  await keys.setNativeBroker(TOKEN, 'https://broker.example.com')
  await prefs.setXClientId('saved-client-id')
  check('with the host link the sign-in is available', client.hostXSignIn.available())
  const started = await client.hostXSignIn.start()
  check('start posts to the paired broker with its bearer and the saved client id', started.state === 'pending' && calls[0].url === 'https://broker.example.com/v1/native/x/signin' &&
    calls[0].method === 'POST' && calls[0].auth === `Bearer ${TOKEN}` && JSON.parse(calls[0].body).clientId === 'saved-client-id')
  answer = { status: 200, body: { state: 'connected', handle: 'owner_handle' } }
  const st = await client.hostXSignIn.status()
  check('status reads connected with the handle', st.state === 'connected' && st.handle === 'owner_handle' && calls[1].method === 'GET')
  answer = { status: 401, body: { error: 'unauthorized' } }
  check('a refused bearer reads as failed: unauthorized', (await client.hostXSignIn.status()).reason === 'unauthorized')
  answer = 'offline'
  check('an unreachable host reads as unavailable', (await client.hostXSignIn.status()).reason === 'host_unreachable')
  check('the phone never asked for or received token JSON', !calls.some(c => String(c.body ?? '').includes('refresh')))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) { console.log('HOST X SIGN-IN TESTS FAILED'); process.exitCode = 1 } else console.log('HOST X SIGN-IN TESTS PASSED')
