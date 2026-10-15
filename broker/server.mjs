import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { hostname } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { NativeBroker } from './broker.mjs'
import { recoverDeadWriter } from './store.mjs'
import { BrokerError, fail, id, boundedJson, NATIVE_RESPONSE_MAX_BYTES } from './validation.mjs'
import { createHostXSignIn, X_SIGNIN_DEFAULT_PORT } from './x-signin.mjs'
import { GITHUB_CAPABILITY_WAIT_MS, GITHUB_UNAVAILABLE } from './native-github.mjs'

const LOOPBACK = new Set(['127.0.0.1', '::1'])
function authorized(request, token) {
  if (request.rawHeaders.filter((value, i) => i % 2 === 0 && value.toLowerCase() === 'authorization').length !== 1) return false
  const supplied = request.headers.authorization
  if (typeof supplied !== 'string' || supplied.length > 4200 || !supplied.startsWith('Bearer ')) return false
  const actual = Buffer.from(supplied.slice(7)), expected = Buffer.from(token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
function reply(response, status, value) {
  const bytes = boundedJson(value, NATIVE_RESPONSE_MAX_BYTES)
  if (response.destroyed) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(bytes),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  })
  response.end(bytes)
}
async function body(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') fail('json_content_type_required', 415)
  const length = request.headers['content-length']
  if (length && (!/^\d+$/.test(length) || Number(length) > 131072)) fail('payload_too_large', 413)
  let bytes = 0
  const chunks = []
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 131072) fail('payload_too_large', 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { fail('invalid_json', 400) }
}
function ownerQuery(url) {
  if (url.searchParams.getAll('ownerId').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'ownerId')) fail('owner_query_required', 400)
  return id(url.searchParams.get('ownerId'))
}
const printable = value => String(value).slice(0, 200).replace(/[^\x20-\x7e]/g, '?')
/**
 * Authenticated exact protocol routes only; no shell, SDK RPC, or admin route.
 * `allowedOrigins` lists exact browser origins; '*' allows any origin, including
 * the opaque 'null' some app WebViews send. CORS is not the auth gate: every
 * GET/POST needs the bearer token, and no cookies are used.
 */
export function createRouter({ broker, bearerToken, allowedOrigins = [], xSignIn = null, github = null, githubCapabilityWaitMs = GITHUB_CAPABILITY_WAIT_MS, log = line => process.stderr.write(line) }) {
  if (typeof bearerToken !== 'string' || Buffer.byteLength(bearerToken) < 32 || bearerToken.length > 4096 ||
      !/^[A-Za-z0-9._~-]+$/.test(bearerToken)) fail('host_bearer_token_required', 503)
  const origins = new Set(allowedOrigins)
  const anyOrigin = origins.delete('*')
  for (const origin of origins) {
    if (origin === 'null') continue
    let url
    try { url = new URL(origin) } catch { fail('invalid_origin_configuration', 503) }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) fail('invalid_origin_configuration', 503)
  }
  // Each refused origin is logged once (bounded), so the owner can copy it into ORIGINS.
  const refused = new Set()
  let active = 0
  return async (request, response) => {
    try {
      const origin = request.headers.origin
      if (origin) {
        // Set before any refusal so a browser can read the error code.
        response.setHeader('access-control-allow-origin', origin)
        response.setHeader('vary', 'Origin')
      }
      if (origin && !anyOrigin && !origins.has(origin)) {
        if (!refused.has(origin) && refused.size < 32) {
          refused.add(origin)
          try { log(`Native broker refused browser origin ${JSON.stringify(printable(origin))}; add it to ORIGINS (or use ORIGINS='*') and rerun the installer\n`) } catch {}
        }
        fail('origin_forbidden', 403)
      }
      if (request.method === 'OPTIONS' && origin) {
        if (typeof request.url !== 'string' || request.url.length > 2048 ||
            !/^\/v1\/native\/(?:capabilities|admission|github\/call|x\/(?:handoff|status|stop|signin)|jobs(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/commands)?)?)(?:\?ownerId=[A-Za-z0-9._:-]+)?$/.test(request.url)) fail('route_not_found', 404)
        // Browser preflights carry no bearer. Only public route metadata is returned;
        // every actual GET/POST still passes token authentication below.
        response.setHeader('access-control-allow-methods', 'GET, POST')
        response.setHeader('access-control-allow-headers', 'Authorization, Content-Type')
        reply(response, 200, {})
        return
      }
      if (!authorized(request, bearerToken)) fail('unauthorized', 401)
      if (active >= 32) fail('request_capacity_exceeded', 503)
      active++
      try {
        if (typeof request.url !== 'string' || request.url.length > 2048 || !request.url.startsWith('/')) fail('invalid_route', 400)
        const url = new URL(request.url, 'http://localhost')
        if (url.hash || url.pathname.includes('%') || url.origin !== 'http://localhost') fail('invalid_route', 400)
        if (request.method === 'GET' && url.pathname === '/v1/native/capabilities' && !url.search) {
          // A slow or unreachable gh never holds the native capabilities up: past
          // the wait this answers unavailable and the probe settles into the cache.
          let waited
          const githubCapability = github ? Promise.race([
            github.capability().catch(() => GITHUB_UNAVAILABLE),
            new Promise(resolve => { waited = setTimeout(resolve, githubCapabilityWaitMs, GITHUB_UNAVAILABLE) }),
          ]).finally(() => clearTimeout(waited)) : GITHUB_UNAVAILABLE
          reply(response, 200, { ...(await broker.capabilities()), github: { ...(await githubCapability) } }); return
        }
        // Host GitHub: allowlisted REST calls through the host's gh login. The reply
        // is GitHub's own status and JSON; the token never leaves gh.
        if (request.method === 'POST' && url.pathname === '/v1/native/github/call' && !url.search) {
          const input = await body(request)
          if (!github) fail('github_unavailable', 503)
          reply(response, 200, await github.call(input)); return
        }
        if (request.method === 'POST' && url.pathname === '/v1/native/jobs' && !url.search) {
          reply(response, 200, await broker.prepare(await body(request))); return
        }
        if (request.method === 'POST' && url.pathname === '/v1/native/admission' && !url.search) {
          reply(response, 200, await broker.inspectAdmission(await body(request))); return
        }
        if (request.method === 'GET' && url.pathname === '/v1/native/jobs') {
          reply(response, 200, broker.listJobs(ownerQuery(url))); return
        }
        // Host X reader. The handoff body carries the live X pair: it goes to the
        // credential store only and is never echoed, logged or projected.
        if (request.method === 'POST' && url.pathname === '/v1/native/x/handoff' && !url.search) {
          const input = await body(request)
          // After a host sign-in the phone sends its reader settings without
          // tokens: the pair the sign-in holds in memory joins them here, so
          // it never travels to the phone and back.
          const held = xSignIn?.heldPair?.()
          if (held && input && typeof input === 'object' && !Array.isArray(input) &&
              input.accessToken === undefined && input.refreshToken === undefined) {
            const result = await broker.xHandoff({ ...input, accessToken: held.accessToken, refreshToken: held.refreshToken,
              clientId: held.clientId, expiresAt: held.expiresAt })
            xSignIn.clearHeld()
            reply(response, 200, result); return
          }
          reply(response, 200, await broker.xHandoff(input)); return
        }
        // Host-run X sign-in (PKCE on this computer); the phone never sees a token.
        if (url.pathname === '/v1/native/x/signin' && !url.search && (request.method === 'POST' || request.method === 'GET')) {
          if (!xSignIn) { reply(response, 200, { state: 'unavailable', reason: 'x_signin_unavailable' }); return }
          reply(response, 200, request.method === 'POST' ? await xSignIn.start(await body(request)) : await xSignIn.status()); return
        }
        if (request.method === 'GET' && url.pathname === '/v1/native/x/status' && !url.search) {
          reply(response, 200, await broker.xStatus()); return
        }
        if (request.method === 'POST' && url.pathname === '/v1/native/x/stop' && !url.search) {
          reply(response, 200, await broker.xStop(await body(request))); return
        }
        const match = /^\/v1\/native\/jobs\/([A-Za-z0-9][A-Za-z0-9._:-]*)(\/commands)?$/.exec(url.pathname)
        if (!match) fail('route_not_found', 404)
        id(match[1])
        if (request.method === 'GET' && !match[2]) {
          reply(response, 200, await broker.observe(match[1], ownerQuery(url))); return
        }
        if (request.method === 'POST' && match[2] && !url.search) {
          const input = await body(request)
          if (input?.missionId !== match[1]) fail('route_mission_mismatch', 400)
          reply(response, 200, await broker.command(input)); return
        }
        fail('route_not_found', 404)
      } finally { active-- }
    } catch (error) {
      const safe = error instanceof BrokerError && /^[a-z0-9_]{1,128}$/.test(error.code)
      reply(response, safe ? error.status : 503, { error: safe ? error.code : 'broker_unavailable' })
    }
  }
}

/** Starts only on a literal loopback address. Default port 0 is OS-selected. */
export async function startBrokerServer({ broker, bearerToken, host = '127.0.0.1', port = 0, allowedOrigins = [], xSignIn = null, github = null, log }) {
  if (!LOOPBACK.has(host)) fail('loopback_only', 503)
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('invalid_port', 503)
  const server = createServer({
    maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 1000,
  }, createRouter({ broker, bearerToken, allowedOrigins, xSignIn, github, ...(log ? { log } : {}) }))
  server.maxConnections = 64
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.removeListener('error', reject); resolve() })
  })
  broker.startObservationLoop()
  return server
}

/**
 * Releases store/.writer only when its recorded host is this host and its pid
 * no longer exists (ESRCH), using recoverDeadWriter's checks. A live writer, a
 * lock from another host or an unreadable lock is left for the owner, and
 * FileStore.open then still fails with writer_locked. Returns the released lock.
 */
export function recoverStaleWriterLock({ directory, hostName = hostname(), isAlive = defaultIsAlive }) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) return null
  let lock
  try {
    if (realpathSync(directory) !== directory) return null
    const path = join(directory, '.writer', 'owner.json')
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 4096) return null
    lock = JSON.parse(readFileSync(path, 'utf8'))
  } catch { return null }
  if (!lock || typeof lock.token !== 'string' || !Number.isInteger(lock.pid) || lock.pid < 1 ||
      lock.host !== hostName || lock.pid === process.pid || isAlive(lock.pid)) return null
  try { recoverDeadWriter({ directory, expectedToken: lock.token }) } catch { return null }
  return { pid: lock.pid, host: lock.host }
}
function defaultIsAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

/**
 * Where a host sign-in's verified X pair goes: with an enabled reader
 * configuration, into the existing credential store (the old reader stops
 * first, so one writer owns the pair) and the reader resumes on it; without
 * one, it stays in memory only until the phone sends its reader settings.
 */
export async function adoptSignedIn(broker, pair) {
  const host = broker?.xHost
  if (!host) fail('x_reader_unavailable', 503)
  let config = null
  try { config = host.readConfig() } catch { config = null }
  if (!config?.enabled) return { held: true }
  await host.serial(async () => {
    await host.halt()
    host.credential.save({ accessToken: pair.accessToken, refreshToken: pair.refreshToken, expiresAt: pair.expiresAt,
      clientId: pair.clientId, ownerId: pair.ownerId })
  })
  await host.resume()
  return { held: false }
}

/** The sign-in a broker serves: only while the host X reader is enabled. */
export function hostXSignInFor(broker, env = process.env, overrides = {}) {
  const port = env.SPRIITE_X_SIGNIN_PORT === undefined ? X_SIGNIN_DEFAULT_PORT : Number(env.SPRIITE_X_SIGNIN_PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('invalid_x_signin_port', 503)
  return createHostXSignIn({
    clientId: env.SPRIITE_X_CLIENT_ID ?? '', port,
    available: () => !!broker.xHost,
    onCredential: pair => adoptSignedIn(broker, pair),
    ...overrides,
  })
}

/** Default remains read-only; host composition requires an explicit opt-in. */
export async function startFromEnv(env = process.env) {
  const ownerId = env.SPRIITE_NATIVE_OWNER_ID, machineId = env.SPRIITE_NATIVE_MACHINE_ID
  const directory = env.SPRIITE_NATIVE_STORE_DIR, bearerToken = env.SPRIITE_NATIVE_BEARER_TOKEN
  if (!ownerId || !machineId || !directory || !bearerToken) fail('host_configuration_required', 503)
  const host = env.SPRIITE_NATIVE_HOST ?? '127.0.0.1'
  if (!LOOPBACK.has(host)) fail('loopback_only', 503)
  const port = env.SPRIITE_NATIVE_PORT === undefined ? 0 : Number(env.SPRIITE_NATIVE_PORT)
  // Validate auth BEFORE opening/writing a store.
  createRouter({ broker: null, bearerToken })
  let composition = {}
  if (env.SPRIITE_NATIVE_ENABLE_HOST === '1') {
    const { createProductionNativeComposition, resolveHostTools } = await import('./host-production.mjs')
    const list = key => {
      try { return JSON.parse(env[key]) } catch { fail('native_host_configuration_required', 503) }
    }
    // droid, gh and git come from SPRIITE_NATIVE_*_PATH or this env's PATH, so the
    // broker runs wherever Factory's droid is installed (Linux or macOS).
    const tools = resolveHostTools(env)
    composition = createProductionNativeComposition({
      enabled: true, root: env.SPRIITE_NATIVE_HOST_ROOT, ownerId, machineId,
      deploymentDigest: env.SPRIITE_NATIVE_DEPLOYMENT_DIGEST,
      factoryApiKeyFile: env.SPRIITE_NATIVE_FACTORY_KEY_FILE,
      extensionTokenFile: env.SPRIITE_NATIVE_EXTENSION_TOKEN_FILE,
      ...tools,
      allowedModelIds: list('SPRIITE_NATIVE_ALLOWED_MODEL_IDS'),
      allowedToolIds: list('SPRIITE_NATIVE_ALLOWED_TOOL_IDS'),
      trustedHost: env.SPRIITE_NATIVE_TRUSTED_HOST === '1',
    })
  }
  // A broker killed without its shutdown handler (OOM killer, SIGKILL, power
  // loss) leaves store/.writer behind; without this every service restart fails
  // with writer_locked. Only a lock from this host whose process is gone is
  // released. SPRIITE_NATIVE_RECOVER_DEAD_WRITER=0 turns this off.
  if (env.SPRIITE_NATIVE_RECOVER_DEAD_WRITER !== '0') {
    const recovered = recoverStaleWriterLock({ directory })
    if (recovered) process.stderr.write(`Native broker released a stale store lock left by exited pid ${recovered.pid}\n`)
  }
  const broker = await NativeBroker.open({
    directory, ownerId, machineId, bearerToken, ...composition,
    qualificationPath: env.SPRIITE_NATIVE_QUALIFICATION_PATH,
    qualificationPublicKey: composition.host?.publicKey,
    hostQualificationPath: env.SPRIITE_NATIVE_HOST_QUALIFICATION_PATH,
    trustedHost: composition.trustedHost === true,
  })
  composition.setHostQualification?.(broker.hostQualification)
  try {
    // Host X reader: explicit opt-in; it starts only from an enabled config with
    // a stored credential (the phone's handoff writes both), ledger beside the store.
    if (env.SPRIITE_NATIVE_X_READER === '1') {
      broker.enableXReader({
        hostRoot: composition.host?.root ?? env.SPRIITE_NATIVE_HOST_ROOT,
        ...(env.SPRIITE_NATIVE_X_BASE_REF ? { baseRef: env.SPRIITE_NATIVE_X_BASE_REF } : {}),
      })
      await broker.xHost.resume()
    }
    // Browser origins that may call this broker (comma-separated, exact origins).
    const allowedOrigins = (env.SPRIITE_NATIVE_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const xSignIn = hostXSignInFor(broker, env)
    const server = await startBrokerServer({ broker, bearerToken, host, port, allowedOrigins, xSignIn, github: composition.github ?? null })
    return { broker, server, xSignIn, close: async () => {
      xSignIn.close()
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections() })
      await broker.shutdown()
    } }
  } catch (error) { broker.close(); throw error }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFromEnv().then(({ broker, server, close }) => {
    const address = server.address()
    const caps = broker.getCapabilities()
    process.stdout.write(`Native broker listening on loopback ${address.address}:${address.port}; ${caps.launch && caps.qualified
      ? `launch available (${caps.qualificationId})` : 'launch unavailable'}\n`)
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { close().then(() => { process.exitCode = 0 }) })
  }).catch(error => {
    // Only a bounded broker code is printed (e.g. native_host_binary_missing:gh);
    // never a message, stack or configuration value.
    const code = error instanceof BrokerError && /^[a-z0-9_]{1,128}(?::[a-z0-9_-]{1,32})?$/.test(error.code) ? ` (${error.code})` : ''
    process.stderr.write(`Native broker refused startup${code}; check host configuration/store integrity\n`)
    process.exitCode = 1
  })
}
