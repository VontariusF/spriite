/**
 * Offline checks for the host X credential store and read-only client. Every
 * request goes to a fake fetch; files live in a private temporary directory.
 * No real X API call and no real credential is read.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BrokerError } from '../broker/validation.mjs'
import { createXCredentialStore, X_TOKEN_URL } from '../broker/x-credential.mjs'
import { createXClient, XClientError } from '../broker/x-client.mjs'

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const code = expected => error => error instanceof BrokerError && error.code === expected
const kind = (expected, reason) => error => error instanceof XClientError && error.kind === expected &&
  (reason === undefined || error.reason === reason)
const NOW = Date.parse('2026-10-14T12:00:00.000Z')
// Fixture values only; shaped so a leak is unmistakable in any message.
const PAIR = Object.freeze({
  accessToken: 'AT-fixture-access-0001', refreshToken: 'RT-fixture-refresh-0001',
  expiresAt: '2026-10-14T14:00:00.000Z', clientId: 'fixture-client-id', ownerId: '1234567890',
})
const SECRETS = ['AT-fixture', 'RT-fixture']

function dir() {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'spriite-x-credential-test-')))
  fs.chmodSync(base, 0o700)
  return base
}
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })
function fakeFetch(handler) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init, calls.length)
  }
  return Object.assign(fn, { calls })
}
const tokenResponse = n => json(200, {
  token_type: 'bearer', expires_in: 7200, access_token: `AT-fixture-access-${n}`, refresh_token: `RT-fixture-refresh-${n}`,
})
function setup({ fetch = fakeFetch(() => tokenResponse('0002')), fsPort = fs, timeoutMs = 1000 } = {}) {
  const base = dir(), path = join(base, 'x-credential.json')
  const store = createXCredentialStore({ path, fs: fsPort, fetch, now: () => NOW, timeoutMs })
  store.save({ ...PAIR })
  return { base, path, store, fetch }
}
const onDisk = path => JSON.parse(fs.readFileSync(path, 'utf8'))
function assertSecretFree(error) {
  const text = `${error?.message} ${error?.code} ${error?.reason ?? ''} ${error?.stack ?? ''} ${JSON.stringify(error)}`
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `error leaked a token: ${error?.code}`)
}

test('save writes a 0600 owner-only file and current() hides the refresh token', () => {
  const { path, store } = setup()
  const stat = fs.statSync(path)
  assert.equal(stat.mode & 0o777, 0o600)
  assert.equal(stat.uid, process.getuid())
  assert.deepEqual(onDisk(path), { version: 1, ...PAIR, state: 'active' })
  const view = store.current()
  assert.equal(view.accessToken, PAIR.accessToken)
  assert.equal(view.state, 'active')
  assert.ok(!('refreshToken' in view))
  assert.ok(Object.isFrozen(view))
  assert.equal(fs.readdirSync(dirname(path)).length, 1, 'no temp file left behind')
})

test('renew sends exactly one refresh-grant POST for a public client', async () => {
  const { store, fetch } = setup()
  await store.renew()
  assert.equal(fetch.calls.length, 1)
  const [{ url, init }] = fetch.calls
  assert.equal(url, X_TOKEN_URL)
  assert.equal(init.method, 'POST')
  assert.equal(init.redirect, 'manual')
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded')
  assert.ok(!('Authorization' in init.headers), 'a public PKCE client sends no secret')
  const form = new URLSearchParams(init.body)
  assert.deepEqual([...form.keys()].sort(), ['client_id', 'grant_type', 'refresh_token'])
  assert.equal(form.get('grant_type'), 'refresh_token')
  assert.equal(form.get('refresh_token'), PAIR.refreshToken)
  assert.equal(form.get('client_id'), PAIR.clientId)
})

test('the rotated pair is durable before renew() resolves', async () => {
  let path
  let seenAtResolve = null
  const fetch = fakeFetch(() => tokenResponse('0002'))
  ;({ path } = setup({ fetch }))
  const store = createXCredentialStore({ path, fetch, now: () => NOW })
  store.load()
  const view = await store.renew().then(result => { seenAtResolve = onDisk(path); return result })
  assert.equal(view.accessToken, 'AT-fixture-access-0002')
  assert.equal(seenAtResolve.accessToken, 'AT-fixture-access-0002')
  assert.equal(seenAtResolve.refreshToken, 'RT-fixture-refresh-0002')
  assert.equal(seenAtResolve.state, 'active')
  assert.equal(seenAtResolve.expiresAt, new Date(NOW + 7200000).toISOString())
  assert.equal(fs.statSync(path).mode & 0o777, 0o600)
})

test('the file write is temp + fsync + rename + chmod + directory fsync', async () => {
  const log = []
  const spy = {
    ...fs, constants: fs.constants,
    openSync: (p, ...rest) => { const fd = fs.openSync(p, ...rest); log.push(['open', String(p), fd]); return fd },
    fsyncSync: fd => { log.push(['fsync', fd]); return fs.fsyncSync(fd) },
    renameSync: (from, to) => { log.push(['rename', String(from), String(to)]); return fs.renameSync(from, to) },
    chmodSync: (p, mode) => { log.push(['chmod', String(p), mode]); return fs.chmodSync(p, mode) },
  }
  const { path } = setup({ fsPort: spy })
  const rename = log.findIndex(row => row[0] === 'rename')
  const temp = log.find(row => row[0] === 'open' && row[1].includes('.x-credential-'))
  assert.ok(temp && rename > 0)
  assert.ok(log.slice(0, rename).some(row => row[0] === 'fsync' && row[1] === temp[2]), 'temp fsynced before rename')
  assert.equal(log[rename][1], temp[1]); assert.equal(log[rename][2], path)
  assert.deepEqual(log[rename + 1], ['chmod', path, 0o600])
  const dirOpen = log.findIndex((row, i) => i > rename && row[0] === 'open' && row[1] === dirname(path))
  assert.ok(dirOpen > rename && log[dirOpen + 1][0] === 'fsync', 'directory fsynced after rename')
})

test('a crash after rotation is persisted resumes with the new pair', async () => {
  const fetch = fakeFetch(() => tokenResponse('0002'))
  const { path, store } = setup({ fetch })
  await store.renew()
  // A fresh process: the old pair is dead at X, the new one is on disk.
  const restarted = createXCredentialStore({ path, fetch, now: () => NOW })
  assert.equal(restarted.load().accessToken, 'AT-fixture-access-0002')
  const reads = fakeFetch(() => json(200, { data: { id: '1234567890', username: 'owner' } }))
  await createXClient({ credential: restarted, fetch: reads }).me()
  assert.equal(reads.calls[0].init.headers.Authorization, 'Bearer AT-fixture-access-0002')
  await restarted.renew()
  assert.equal(new URLSearchParams(fetch.calls[1].init.body).get('refresh_token'), 'RT-fixture-refresh-0002')
})

test('a crash while the request is on the wire quarantines the refresh token at load', async () => {
  let release
  const fetch = fakeFetch(() => new Promise(resolve => { release = resolve }))
  const { path, store } = setup({ fetch })
  const pending = store.renew()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(onDisk(path).state, 'renewing', 'intent is durable before the request')
  // Process dies here; a new one loads the file.
  const restarted = createXCredentialStore({ path, fetch, now: () => NOW })
  assert.equal(restarted.load().state, 'rotation_lost')
  assert.equal(onDisk(path).refreshToken, '')
  assert.equal(onDisk(path).state, 'rotation_lost')
  await assert.rejects(restarted.renew(), code('x_rotation_lost'))
  assert.equal(fetch.calls.length, 1, 'the possibly consumed grant is never replayed')
  release(tokenResponse('0002')); await pending.catch(() => {})
})

test('a persist failure after rotation refuses the unsaved pair and fails closed', async () => {
  let failRename = false
  const flaky = { ...fs, constants: fs.constants, renameSync: (a, b) => { if (failRename) throw new Error('disk'); return fs.renameSync(a, b) } }
  const fetch = fakeFetch(() => { failRename = true; return tokenResponse('0002') })
  const { path, store } = setup({ fetch, fsPort: flaky })
  await assert.rejects(store.renew(), error => { assertSecretFree(error); return code('x_credential_persist_failed')(error) })
  assert.equal(store.current().state, 'rotation_lost')
  assert.equal(store.current().accessToken, PAIR.accessToken, 'the unsaved token is never handed out')
  assert.equal(onDisk(path).state, 'renewing', 'a restart quarantines rather than replays')
  assert.ok(!fs.readdirSync(dirname(path)).some(name => name.endsWith('.tmp')), 'temp file removed')
  await assert.rejects(store.renew(), code('x_rotation_lost'))
  assert.equal(fetch.calls.length, 1)
})

for (const [label, handler] of [
  ['network error', () => { throw new TypeError('fetch failed') }],
  ['timeout', () => new Promise(() => {})],
  ['unreadable 200', () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('cut') } })],
  ['200 without an access token', () => json(200, { token_type: 'bearer' })],
]) {
  test(`a lost renewal (${label}) marks rotation_lost and never retries`, async () => {
    const fetch = fakeFetch(handler)
    const { path, store } = setup({ fetch, timeoutMs: 30 })
    await assert.rejects(store.renew(), error => { assertSecretFree(error); return code('x_renewal_lost')(error) })
    assert.equal(fetch.calls.length, 1)
    assert.equal(store.current().state, 'rotation_lost')
    assert.equal(onDisk(path).state, 'rotation_lost')
    assert.equal(onDisk(path).refreshToken, '')
    await assert.rejects(store.renew(), code('x_rotation_lost'))
    assert.equal(fetch.calls.length, 1)
    // Only a new handoff clears it.
    store.save({ ...PAIR, refreshToken: 'RT-fixture-refresh-0009' })
    assert.equal(store.current().state, 'active')
  })
}

for (const [status, expected] of [[402, 'x_renewal_credits'],
  [403, 'x_renewal_forbidden'], [429, 'x_renewal_quota'], [500, 'x_renewal_service']]) {
  test(`a definite ${status} from the token endpoint keeps the credential active`, async () => {
    const fetch = fakeFetch(() => json(status, { error: 'invalid_request', error_description: 'RT-fixture-refresh-0001' }))
    const { path, store } = setup({ fetch })
    await assert.rejects(store.renew(), error => { assertSecretFree(error); return code(expected)(error) })
    assert.equal(store.current().state, 'active')
    assert.deepEqual(onDisk(path), { version: 1, ...PAIR, state: 'active' })
  })
}

test('concurrent renew() calls share one token request', async () => {
  const fetch = fakeFetch(() => tokenResponse('0002'))
  const { store } = setup({ fetch })
  const [a, b] = await Promise.all([store.renew(), store.renew()])
  assert.equal(fetch.calls.length, 1)
  assert.equal(a.accessToken, b.accessToken)
})

test('a save during a renewal drops the late answer', async () => {
  let release
  const fetch = fakeFetch(() => new Promise(resolve => { release = resolve }))
  const { path, store } = setup({ fetch })
  const pending = store.renew()
  await new Promise(resolve => setImmediate(resolve))
  store.save({ ...PAIR, accessToken: 'AT-fixture-access-0007', refreshToken: 'RT-fixture-refresh-0007' })
  release(tokenResponse('0002'))
  await assert.rejects(pending, code('x_credential_replaced'))
  assert.equal(onDisk(path).accessToken, 'AT-fixture-access-0007')
  assert.equal(store.current().accessToken, 'AT-fixture-access-0007')
})

test('clear removes the file and renewal then refuses', async () => {
  const { path, store } = setup()
  store.clear()
  assert.equal(fs.existsSync(path), false)
  assert.equal(store.current(), null)
  assert.equal(store.load(), null)
  await assert.rejects(store.renew(), code('x_credential_missing'))
  store.clear()
})

test('load refuses symlinked, group/world-readable, hard-linked or invalid files', () => {
  const { base, path } = setup()
  const open = () => createXCredentialStore({ path, fetch: fakeFetch(() => tokenResponse('x')) })
  assert.equal(open().load().accessToken, PAIR.accessToken)
  for (const mode of [0o640, 0o604, 0o660]) {
    fs.chmodSync(path, mode)
    assert.throws(() => open().load(), error => { assertSecretFree(error); return code('x_credential_unsafe')(error) })
  }
  fs.chmodSync(path, 0o600)
  const real = join(base, 'real.json'); fs.renameSync(path, real); fs.symlinkSync(real, path)
  assert.throws(() => open().load(), code('x_credential_unsafe'))
  assert.throws(() => open().save({ ...PAIR }), code('x_credential_persist_failed'), 'never write through a symlink path')
  fs.unlinkSync(path); fs.linkSync(real, path)
  assert.throws(() => open().load(), code('x_credential_unsafe'))
  fs.unlinkSync(real)
  fs.writeFileSync(path, '{"version":1,"accessToken":"AT-fixture-x"', { mode: 0o600 })
  assert.throws(() => open().load(), error => { assertSecretFree(error); return code('x_credential_invalid')(error) })
  const wideDir = dir(); fs.chmodSync(wideDir, 0o777)
  const wide = createXCredentialStore({ path: join(wideDir, 'x.json') })
  assert.throws(() => wide.save({ ...PAIR }), code('x_credential_persist_failed'))
  assert.throws(() => wide.load(), code('x_credential_unsafe'))
  assert.throws(() => createXCredentialStore({ path: 'relative.json' }), code('x_credential_path_invalid'))
})

test('save validates the handoff without echoing values', () => {
  const { store } = setup()
  for (const [patch, expected] of [
    [{ accessToken: 'AT-fixture bad space' }, 'x_credential_token_invalid'],
    [{ refreshToken: '' }, 'x_credential_token_invalid'],
    [{ clientId: 'bad/client' }, 'x_credential_client_invalid'],
    [{ ownerId: 'owner' }, 'x_credential_owner_invalid'],
    [{ expiresAt: 'soon' }, 'x_credential_expiry_invalid'],
  ]) assert.throws(() => store.save({ ...PAIR, ...patch }), error => { assertSecretFree(error); return code(expected)(error) })
  assert.throws(() => store.save({ ...PAIR, extra: 1 }), code('invalid_fields'))
})

// ---------- client ----------

function stubCredential(tokens = ['AT-fixture-access-0001', 'AT-fixture-access-0002']) {
  let index = 0, renewals = 0, failure = null
  return {
    current: () => ({ accessToken: tokens[index], state: 'active' }),
    async renew() { renewals++; if (failure) throw failure; index++; return this.current() },
    fail(error) { failure = error },
    get renewals() { return renewals },
  }
}

test('client reads only GETs on api.x.com with the x-transport fields', async () => {
  const credential = stubCredential()
  const fetch = fakeFetch(url => {
    if (url.includes('/2/users/me')) return json(200, { data: { id: '1234567890', username: 'owner' } })
    if (url.includes('/tweets?')) return json(200, { data: [{ id: '5', text: 'hi' }], includes: { users: [] }, meta: { next_token: 'abc123' } })
    return json(200, { data: { id: '5', text: 'hi' }, includes: { tweets: [] } })
  })
  const client = createXClient({ credential, fetch })
  assert.equal((await client.me()).id, '1234567890')
  const page = await client.userPosts('1234567890', { sinceId: '100', paginationToken: 'tok_1' })
  assert.deepEqual(page, { posts: [{ id: '5', text: 'hi' }], includes: { users: [] }, nextToken: 'abc123' })
  assert.equal((await client.post('5')).post.id, '5')
  for (const { url, init } of fetch.calls) {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.body, undefined)
    assert.equal(new URL(url).origin, 'https://api.x.com')
    assert.equal(init.headers.Authorization, 'Bearer AT-fixture-access-0001')
  }
  const me = new URL(fetch.calls[0].url)
  assert.equal(me.pathname, '/2/users/me'); assert.equal(me.searchParams.get('user.fields'), 'protected,username')
  const posts = new URL(fetch.calls[1].url)
  assert.equal(posts.pathname, '/2/users/1234567890/tweets')
  assert.equal(posts.searchParams.get('max_results'), '100')
  assert.equal(posts.searchParams.get('exclude'), 'retweets')
  assert.equal(posts.searchParams.get('since_id'), '100')
  assert.equal(posts.searchParams.get('pagination_token'), 'tok_1')
  assert.equal(posts.searchParams.get('tweet.fields'),
    'created_at,author_id,conversation_id,edit_history_tweet_ids,entities,referenced_tweets,in_reply_to_user_id,display_text_range,note_tweet')
  assert.equal(posts.searchParams.get('expansions'), 'referenced_tweets.id,referenced_tweets.id.author_id,author_id')
  assert.equal(posts.searchParams.get('user.fields'), 'protected,username')
  const one = new URL(fetch.calls[2].url)
  assert.equal(one.pathname, '/2/tweets/5')
  assert.equal(one.searchParams.get('expansions'), 'referenced_tweets.id,referenced_tweets.id.author_id,author_id')
  const first = await client.userPosts('1', { startTime: '2026-10-13T12:00:00Z' })
  assert.deepEqual(first.nextToken, 'abc123')
  const firstUrl = new URL(fetch.calls[3].url)
  assert.equal(firstUrl.searchParams.get('start_time'), '2026-10-13T12:00:00.000Z')
  assert.equal(firstUrl.searchParams.has('since_id'), false)
})

test('client refuses malformed ids before any request', async () => {
  const fetch = fakeFetch(() => json(200, {}))
  const client = createXClient({ credential: stubCredential(), fetch })
  assert.equal(await client.post('../2/users/me'), null)
  await assert.rejects(client.userPosts('me/../x'), kind('not_found'))
  await assert.rejects(client.userPosts('1', { sinceId: '1&x=1' }), kind('service'))
  await assert.rejects(client.userPosts('1', { paginationToken: 'a b' }), kind('service'))
  assert.equal(fetch.calls.length, 0)
})

test('a 401 renews once and retries once with the new token', async () => {
  const credential = stubCredential()
  const fetch = fakeFetch((_, init) => init.headers.Authorization.endsWith('0001')
    ? json(401, {}) : json(200, { data: { id: '1', username: 'owner' } }))
  assert.equal((await createXClient({ credential, fetch }).me()).id, '1')
  assert.equal(credential.renewals, 1)
  assert.deepEqual(fetch.calls.map(c => c.init.headers.Authorization), ['Bearer AT-fixture-access-0001', 'Bearer AT-fixture-access-0002'])
})

test('a second 401 is reported as auth, never renewed again', async () => {
  const credential = stubCredential()
  const fetch = fakeFetch(() => json(401, {}))
  await assert.rejects(createXClient({ credential, fetch }).me(), error => { assertSecretFree(error); return kind('auth', 'x_rejected')(error) })
  assert.equal(credential.renewals, 1)
  assert.equal(fetch.calls.length, 2)
})

test('a 401 against a token already renewed elsewhere retries without renewing', async () => {
  let index = 0
  const credential = { current: () => ({ accessToken: ['AT-fixture-access-0001', 'AT-fixture-access-0002'][index] }), renew: async () => { throw new Error('unexpected') } }
  const fetch = fakeFetch((_, init) => {
    if (init.headers.Authorization.endsWith('0001')) { index = 1; return json(401, {}) }
    return json(200, { data: { id: '1', username: 'owner' } })
  })
  assert.equal((await createXClient({ credential, fetch }).me()).id, '1')
})

test('real store and client: 401 path rotates durably and the retry uses the persisted token', async () => {
  const fetch = fakeFetch((url, init) => {
    if (url === X_TOKEN_URL) return tokenResponse('0002')
    return init.headers.Authorization === 'Bearer AT-fixture-access-0002'
      ? json(200, { data: { id: '1234567890', username: 'owner' } }) : json(401, {})
  })
  const { path, store } = setup({ fetch })
  const me = await createXClient({ credential: store, fetch }).me()
  assert.equal(me.id, '1234567890')
  assert.equal(fetch.calls.filter(c => c.url === X_TOKEN_URL).length, 1)
  assert.equal(onDisk(path).refreshToken, 'RT-fixture-refresh-0002')
})

test('real store and client: a lost renewal surfaces as network, then auth', async () => {
  const fetch = fakeFetch(url => {
    if (url === X_TOKEN_URL) throw new TypeError('socket hang up')
    return json(401, {})
  })
  const { store } = setup({ fetch })
  const client = createXClient({ credential: store, fetch })
  await assert.rejects(client.me(), error => {
    assertSecretFree(error)
    return kind('network', 'x_renewal_lost')(error) && error.renewalUnknown === true
  })
  await assert.rejects(client.me(), error => kind('auth', 'x_rotation_lost')(error) && error.renewalUnknown === true)
  assert.equal(fetch.calls.filter(c => c.url === X_TOKEN_URL).length, 1)
})

for (const [status, expected] of [[402, 'credits'], [403, 'forbidden'], [404, 'not_found'], [429, 'quota'],
  [500, 'service'], [503, 'service'], [302, 'service']]) {
  test(`HTTP ${status} maps to ${expected}`, async () => {
    const fetch = fakeFetch(() => json(status, { detail: 'AT-fixture-access-0001' }))
    await assert.rejects(createXClient({ credential: stubCredential(), fetch }).me(),
      error => { assertSecretFree(error); return kind(expected)(error) })
  })
}

for (const [label, renewal, expected] of [
  ['quota', 'x_renewal_quota', 'quota'], ['credits', 'x_renewal_credits', 'credits'],
  ['forbidden', 'x_renewal_forbidden', 'forbidden'], ['rejected', 'x_renewal_rejected', 'auth'],
  ['missing', 'x_credential_missing', 'auth'], ['persist', 'x_credential_persist_failed', 'service'],
]) {
  test(`a renewal ${label} refusal maps to ${expected}`, async () => {
    const credential = stubCredential()
    credential.fail(new BrokerError(renewal, 503))
    await assert.rejects(createXClient({ credential, fetch: fakeFetch(() => json(401, {})) }).me(), kind(expected, renewal))
  })
}

test('a 404 from post() reads as gone; network errors and timeouts are network', async () => {
  const gone = createXClient({ credential: stubCredential(), fetch: fakeFetch(() => json(404, {})) })
  assert.equal(await gone.post('5'), null)
  const down = createXClient({ credential: stubCredential(), fetch: fakeFetch(() => { throw new TypeError('ECONNRESET AT-fixture-access-0001') }) })
  await assert.rejects(down.me(), error => { assertSecretFree(error); return kind('network', 'x_unreachable')(error) })
  let aborted = false
  const hang = createXClient({ credential: stubCredential(), timeoutMs: 20, fetch: fakeFetch((_, init) => {
    init.signal.addEventListener('abort', () => { aborted = true })
    return new Promise(() => {})
  }) })
  await assert.rejects(hang.userPosts('1'), kind('network', 'x_timeout'))
  assert.ok(aborted, 'the request is aborted at the deadline')
  const slowBody = createXClient({ credential: stubCredential(), timeoutMs: 20,
    fetch: fakeFetch(() => ({ status: 200, ok: true, json: () => new Promise(() => {}) })) })
  await assert.rejects(slowBody.post('5'), kind('network', 'x_timeout'))
  const garbage = createXClient({ credential: stubCredential(), fetch: fakeFetch(() => json(200, { data: 'nope' })) })
  await assert.rejects(garbage.userPosts('1'), kind('service', 'x_unreadable'))
  await assert.rejects(garbage.me(), kind('service', 'x_no_user'))
})

test('a client with no credential loaded refuses without a request', async () => {
  const fetch = fakeFetch(() => json(200, {}))
  await assert.rejects(createXClient({ credential: { current: () => null, renew: async () => {} }, fetch }).me(), kind('auth', 'x_credential_missing'))
  assert.equal(fetch.calls.length, 0)
})

// ------------------------------------------------------ review regressions

for (const [label, cause] of [['ENOTFOUND', 'ENOTFOUND'], ['ECONNREFUSED', 'ECONNREFUSED'], ['EAI_AGAIN', 'EAI_AGAIN'],
  ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT']]) {
  test(`a renewal that never left the machine (${label}) keeps the grant active`, async () => {
    const fetch = fakeFetch(() => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: cause }) }) })
    const { path, store } = setup({ fetch })
    await assert.rejects(store.renew(), error => { assertSecretFree(error); return code('x_renewal_network')(error) })
    assert.equal(store.current().state, 'active')
    assert.deepEqual(onDisk(path), { version: 1, ...PAIR, state: 'active' })
    await assert.rejects(store.renew(), code('x_renewal_network'))
    assert.equal(fetch.calls.length, 2, 'the untouched grant is tried again on the next renewal')
  })
}

test('a synchronous throw before dispatch keeps the grant; a reset after connecting still quarantines', async () => {
  // Not async: the throw happens before any promise, so nothing was dispatched.
  const a = setup({ fetch: () => { throw new TypeError('bad init') } })
  await assert.rejects(a.store.renew(), code('x_renewal_network'))
  assert.equal(a.store.current().state, 'active')
  const reset = fakeFetch(() => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) }) })
  const b = setup({ fetch: reset })
  await assert.rejects(b.store.renew(), code('x_renewal_lost'))
  assert.equal(b.store.current().state, 'rotation_lost')
})

for (const status of [400, 401]) {
  test(`a refused grant (${status}) is erased and never sent again until a new handoff`, async () => {
    const fetch = fakeFetch(() => json(status, { error: 'invalid_request', error_description: 'RT-fixture-refresh-0001' }))
    const { path, store } = setup({ fetch })
    await assert.rejects(store.renew(), error => { assertSecretFree(error); return code('x_renewal_rejected')(error) })
    assert.equal(store.current().state, 'rejected')
    assert.equal(onDisk(path).state, 'rejected')
    assert.equal(onDisk(path).refreshToken, '')
    await assert.rejects(store.renew(), code('x_renewal_rejected'))
    assert.equal(fetch.calls.length, 1, 'the dead grant is not re-sent')
    // A restart reads it as rejected too.
    const restarted = createXCredentialStore({ path, fetch, now: () => NOW })
    assert.equal(restarted.load().state, 'rejected')
    await assert.rejects(restarted.renew(), code('x_renewal_rejected'))
    assert.equal(fetch.calls.length, 1)
    store.save({ ...PAIR, refreshToken: 'RT-fixture-refresh-0009' })
    assert.equal(store.current().state, 'active')
  })
}

test('real store and client: a renewal network failure maps to network and keeps the credential', async () => {
  const fetch = fakeFetch(url => {
    if (url === X_TOKEN_URL) throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
    return json(401, {})
  })
  const { store } = setup({ fetch })
  await assert.rejects(createXClient({ credential: store, fetch }).me(), kind('network', 'x_renewal_network'))
  assert.equal(store.current().state, 'active')
})

test('userByUsername reads /2/users/by/username/:username and checks the answer names the handle', async () => {
  const fetch = fakeFetch(url => url.includes('/by/username/SpriiteBot')
    ? json(200, { data: { id: '222', username: 'spriitebot' } }) : json(200, { data: { id: '333', username: 'someone_else' } }))
  const client = createXClient({ credential: stubCredential(), fetch })
  assert.deepEqual(await client.userByUsername('@SpriiteBot'), { id: '222', username: 'spriitebot' })
  const url = new URL(fetch.calls[0].url)
  assert.equal(url.origin + url.pathname, 'https://api.x.com/2/users/by/username/SpriiteBot')
  assert.equal(fetch.calls[0].init.method, 'GET')
  await assert.rejects(client.userByUsername('Other'), kind('service', 'x_user_mismatch'))
  await assert.rejects(client.userByUsername('../me'), kind('not_found', 'x_handle_invalid'))
  assert.equal(fetch.calls.length, 2)
})

test('userPosts passes until_id for a backlog read and refuses a malformed one', async () => {
  const fetch = fakeFetch(() => json(200, { meta: {} }))
  const client = createXClient({ credential: stubCredential(), fetch })
  await client.userPosts('1', { sinceId: '10', untilId: '50' })
  const url = new URL(fetch.calls[0].url)
  assert.equal(url.searchParams.get('until_id'), '50'); assert.equal(url.searchParams.get('since_id'), '10')
  await assert.rejects(client.userPosts('1', { untilId: '5&x' }), kind('service', 'x_until_id_invalid'))
  assert.equal(fetch.calls.length, 1)
})

function dirname(path) { return path.slice(0, path.lastIndexOf('/')) }

let passed = 0
for (const { name, fn } of tests) {
  try { await fn(); passed++; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL: ${name}`); console.error(error); process.exitCode = 1 }
}
console.log(`Host X credential/client checks: ${passed}/${tests.length} passed; fake fetch, no X API call or real credential.`)
