/**
 * Offline checks for the host X reader: trust rules, dedupe across edits, the
 * durable checkpoint, crash replay at every write, quota backoff, the 24-hour
 * window, routing, receipt bounds and ledger permissions. The X client and
 * launch are fakes; ledgers live in private temporary directories. No real X
 * API call, no Factory launch and no real credential is read.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BrokerError } from '../broker/validation.mjs'
import { XClientError } from '../broker/x-client.mjs'
import { createXReader, X_LAUNCH_UNKNOWN_REASON, X_READER_MAX_RECEIPTS } from '../broker/x-reader.mjs'

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const code = expected => error => error instanceof BrokerError && error.code === expected

const OWNER = '1001'
const SPRIITE = '2002'
const NOW = Date.parse('2026-10-14T12:00:00.000Z')
const BOUND = Date.parse('2026-10-14T10:00:00.000Z')
const DEFAULT_REPO = 'https://github.com/owner/designated'

function dir() {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'spriite-x-reader-test-')))
  fs.chmodSync(base, 0o700)
  return base
}
const cpLen = s => Array.from(s).length
/** A post tagging Spriite with a real mention entity at its typed "@". */
function trigger(id, text, extra = {}) {
  const full = `@spriite ${text}`
  return {
    id, text: full, author_id: OWNER, edit_history_tweet_ids: [id],
    created_at: new Date(NOW - 60000).toISOString(),
    entities: { mentions: [{ start: 0, end: cpLen('@spriite'), username: 'spriite', id: SPRIITE }] },
    ...extra,
  }
}
const BUILD = 'build a habit tracker app with streaks'

/** A fake X client: `pages` is the posts every read returns (filtered by since_id like X). */
function fakeClient({ posts = [], me = { id: OWNER, username: 'owner' }, fail = null, userByUsername } = {}) {
  const calls = []
  const client = {
    calls,
    posts,
    fail,
    async me() { return me },
    async userPosts(userId, options = {}) {
      calls.push({ userId, ...options })
      if (client.fail) throw client.fail
      const since = options.sinceId ? BigInt(options.sinceId) : null
      return { posts: client.posts.filter(p => since === null || BigInt(p.id) > since).reverse(), includes: {}, nextToken: null }
    },
  }
  if (userByUsername) client.userByUsername = userByUsername
  return client
}
function fakeLaunch(result = request => ({ status: 'submitted', missionId: `m-${request.logicalPostId}` })) {
  const calls = []
  const fn = async request => { calls.push(request); return typeof result === 'function' ? result(request) : result }
  return Object.assign(fn, { calls })
}
async function setup({ base = dir(), client = fakeClient(), launch = fakeLaunch(), clock = { t: BOUND }, bind = {}, ...rest } = {}) {
  const ledgerPath = join(base, 'x-reader.json')
  const reader = createXReader({ ledgerPath, client, launch, now: () => clock.t, ...rest })
  await reader.bind({ spriiteHandle: '@spriite', ownerId: OWNER, spriiteUserId: SPRIITE, ...bind })
  clock.t = NOW
  return { base, ledgerPath, reader, client, launch, clock }
}
const reopen = ({ ledgerPath, client, clock }, launch = fakeLaunch(), extra = {}) =>
  createXReader({ ledgerPath, client, launch, now: () => clock.t, ...extra })
const onDisk = path => JSON.parse(fs.readFileSync(path, 'utf8'))
const receiptOf = (path, logical) => onDisk(path).receipts.find(r => r.logicalPostId === logical)

// --------------------------------------------------------------- trust

test('only the owner\'s explicit, visible Spriite mention launches; reposts and auto-mentions do not', async () => {
  const replyText = '@spriite @friend build a habit tracker app with streaks'
  const autoMention = {
    id: '11', text: replyText, author_id: OWNER, edit_history_tweet_ids: ['11'],
    created_at: new Date(NOW - 60000).toISOString(), referenced_tweets: [{ type: 'replied_to', id: '5' }],
    display_text_range: [17, cpLen(replyText)],
    entities: { mentions: [{ start: 0, end: 8, username: 'spriite', id: SPRIITE }, { start: 9, end: 16, username: 'friend', id: '77' }] },
  }
  const noEntity = { ...trigger('12', BUILD), entities: { mentions: [] } }
  const wrongId = { ...trigger('13', BUILD), entities: { mentions: [{ start: 0, end: 8, username: 'spriite', id: '999' }] } }
  const repost = trigger('14', BUILD, { referenced_tweets: [{ type: 'retweeted', id: '6' }] })
  const stranger = trigger('15', BUILD, { author_id: '4242' })
  const good = trigger('16', BUILD)
  const client = fakeClient({ posts: [autoMention, noEntity, wrongId, repost, stranger, good] })
  const ctx = await setup({ client })
  const result = await ctx.reader.checkNow()
  assert.equal(result.ok, true)
  assert.equal(ctx.launch.calls.length, 1)
  assert.equal(ctx.launch.calls[0].postId, '16')
  assert.equal(ctx.launch.calls[0].instruction, BUILD)
  assert.equal(ctx.launch.calls[0].dedupeKey, `x:${OWNER}:16`)
  const byId = Object.fromEntries(result.outcomes.map(o => [o.postId, o]))
  assert.equal(byId['11'].status, 'ignored')
  assert.equal(byId['12'].reason, 'not_a_trigger')
  assert.equal(byId['13'].reason, 'not_a_trigger')
  assert.equal(byId['14'].reason, 'repost')
  assert.equal(byId['15'].status, 'rejected')
  const ledger = onDisk(ctx.ledgerPath)
  assert.deepEqual(ledger.receipts.map(r => r.logicalPostId), ['16'], 'non-triggers get no receipt')
  assert.equal(ledger.rejectedCount, 1)
  assert.equal(ledger.checkpoint.lastSeenPostId, '16')
})

test('bind verifies the owner through /2/users/me and resolves the Spriite id', async () => {
  const base = dir(), ledgerPath = join(base, 'x-reader.json')
  const mk = client => createXReader({ ledgerPath, client, launch: fakeLaunch(), now: () => NOW })
  await assert.rejects(mk(fakeClient()).bind({ spriiteHandle: 'spriite', ownerId: '9999', spriiteUserId: SPRIITE }), code('x_owner_mismatch'))
  await assert.rejects(mk(fakeClient()).bind({ spriiteHandle: 'spriite', ownerId: OWNER }), code('x_spriite_lookup_unavailable'))
  await assert.rejects(mk(fakeClient()).bind({ spriiteHandle: 'spriite', ownerId: OWNER, spriiteUserId: OWNER }), code('x_same_account'))
  await assert.rejects(mk(fakeClient({ me: { id: OWNER, username: 'owner', protected: true } }))
    .bind({ spriiteHandle: 'spriite', ownerId: OWNER, spriiteUserId: SPRIITE }), code('x_protected_owner_unsupported'))
  await assert.rejects(mk(fakeClient()).bind({ spriiteHandle: 'spriite', ownerId: OWNER, spriiteUserId: SPRIITE,
    defaultRepository: 'https://github.com/o/r/tree/main' }), code('x_default_repository_invalid'))
  await assert.rejects(mk(fakeClient()).bind({ spriiteHandle: 'not a handle!', ownerId: OWNER }), code('x_spriite_handle_invalid'))
  assert.ok(!fs.existsSync(ledgerPath), 'a refused bind writes nothing')
  const lookups = []
  const reader = mk(fakeClient({ userByUsername: async h => { lookups.push(h); return { id: SPRIITE, username: 'Spriite' } } }))
  const binding = await reader.bind({ spriiteHandle: '@spriite', ownerId: OWNER })
  assert.deepEqual(lookups, ['spriite'])
  assert.equal(binding.spriiteXUserId, SPRIITE)
  assert.equal(onDisk(ledgerPath).binding.ownerXUserId, OWNER)
  assert.throws(() => createXReader({ ledgerPath: join(base, 'other.json'), client: fakeClient(), launch: fakeLaunch() }).start(), code('x_reader_unbound'))
})

// --------------------------------------------------------------- dedupe

test('an edit of a launched post never launches again; it is recorded as a proposed change', async () => {
  const client = fakeClient({ posts: [trigger('100', BUILD)] })
  const ctx = await setup({ client })
  await ctx.reader.checkNow()
  assert.equal(ctx.launch.calls.length, 1)
  client.posts = [trigger('101', `${BUILD} and dark mode`, { edit_history_tweet_ids: ['100', '101'] })]
  const result = await ctx.reader.checkNow()
  assert.equal(result.outcomes[0].status, 'duplicate')
  assert.equal(ctx.launch.calls.length, 1)
  const r = receiptOf(ctx.ledgerPath, '100')
  assert.equal(r.status, 'submitted')
  assert.equal(r.revisionId, '100')
  assert.equal(r.proposedRevisionId, '101')
  assert.equal(r.dedupeKey, `x:${OWNER}:100`)
  // Both revisions read again from scratch (a lost checkpoint) are duplicates.
  const ledger = onDisk(ctx.ledgerPath)
  fs.writeFileSync(ctx.ledgerPath, JSON.stringify({ ...ledger, checkpoint: { lastSeenPostId: null, lastSuccessAt: null } }))
  client.posts = [trigger('100', BUILD), trigger('101', BUILD, { edit_history_tweet_ids: ['100', '101'] })]
  const again = await reopen(ctx, ctx.launch).checkNow()
  assert.deepEqual(again.outcomes.map(o => o.status), ['duplicate', 'duplicate'])
  assert.equal(ctx.launch.calls.length, 1)
})

test('an edit of an unclear post that never launched is re-evaluated and launches once', async () => {
  const client = fakeClient({ posts: [trigger('200', 'hmm')] })
  const ctx = await setup({ client })
  const first = await ctx.reader.checkNow()
  assert.equal(first.outcomes[0].status, 'clarify')
  assert.equal(ctx.launch.calls.length, 0)
  client.posts = [trigger('201', BUILD, { edit_history_tweet_ids: ['200', '201'] })]
  const second = await ctx.reader.checkNow()
  assert.equal(second.outcomes[0].status, 'submitted')
  assert.equal(ctx.launch.calls.length, 1)
  assert.equal(ctx.launch.calls[0].logicalPostId, '200')
  assert.equal(ctx.launch.calls[0].revisionId, '201')
  const ledger = onDisk(ctx.ledgerPath)
  assert.equal(ledger.receipts.length, 1, 'the edit replaced the receipt in place')
  assert.equal(ledger.receipts[0].revisionId, '201')
})

// ---------------------------------------------------------- checkpoint

/** fs whose renameSync fails (before or after the real rename) on chosen calls. */
function crashFs({ failOn = new Set(), after = false } = {}) {
  let n = 0
  const port = {
    ...fs,
    renameSync(from, to) {
      n++
      if (failOn.has(n) && !after) throw Object.assign(new Error('crash'), { code: 'EIO' })
      fs.renameSync(from, to)
      if (failOn.has(n) && after) throw Object.assign(new Error('crash'), { code: 'EIO' })
    },
  }
  Object.defineProperty(port, 'renames', { get: () => n })
  return port
}

test('the checkpoint never passes a post without a durable receipt', async () => {
  const client = fakeClient({ posts: [trigger('300', BUILD), trigger('301', 'cancel the build'), trigger('302', `${BUILD} two`)] })
  const fsPort = crashFs()
  const ctx = await setup({ client, fs: fsPort })
  const before = onDisk(ctx.ledgerPath).checkpoint
  // Fail the receipt write for the second post (renames: marker, final, then 301's receipt).
  const failing = crashFs({ failOn: new Set([3]) })
  const reader = reopen(ctx, ctx.launch, { fs: failing })
  const result = await reader.checkNow()
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'storage')
  assert.equal(result.error, 'x_reader_persist_failed')
  assert.deepEqual(onDisk(ctx.ledgerPath).checkpoint, before, 'the checkpoint did not move')
  assert.equal(reader.status().lastErrorKind, 'storage')
  assert.equal(ctx.launch.calls.length, 1)
  // The re-read absorbs the receipted post and finishes the rest.
  const ok = await reopen(ctx, ctx.launch).checkNow()
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.outcomes.map(o => o.status), ['duplicate', 'held', 'submitted'])
  assert.equal(ctx.launch.calls.length, 2)
  assert.equal(onDisk(ctx.ledgerPath).checkpoint.lastSeenPostId, '302')
})

test('a crash at every durable write replays without launching twice', async () => {
  const posts = [trigger('400', BUILD), trigger('401', 'status'), trigger('402', `${BUILD} again`)]
  // A clean run counts the writes in one check.
  const probe = crashFs()
  const clean = await setup({ client: fakeClient({ posts }) })
  const counted = reopen(clean, fakeLaunch(), { fs: probe })
  await counted.checkNow()
  const writes = probe.renames
  assert.ok(writes >= 6, `expected marker/final/receipt/checkpoint writes, saw ${writes}`)
  for (let step = 1; step <= writes; step++) {
    for (const after of [false, true]) {
      const ctx = await setup({ client: fakeClient({ posts }) })
      const launch = fakeLaunch()
      const crashing = reopen(ctx, launch, { fs: crashFs({ failOn: new Set([step]), after }) })
      await crashing.checkNow()
      // "Restart": a new reader from whatever reached the disk.
      const restarted = reopen(ctx, launch)
      const result = await restarted.checkNow()
      assert.equal(result.ok, true, `step ${step} after=${after}`)
      for (const key of ['400', '402']) {
        const n = launch.calls.filter(c => c.logicalPostId === key).length
        assert.ok(n <= 1, `step ${step} after=${after}: ${key} launched ${n} times`)
        const r = receiptOf(ctx.ledgerPath, key)
        assert.ok(r, `step ${step}: ${key} has a receipt`)
        assert.ok(['submitted', 'held'].includes(r.status))
        if (n === 0) assert.equal(r.status, 'held')
        if (r.status === 'held') assert.equal(r.reason, X_LAUNCH_UNKNOWN_REASON)
      }
      assert.equal(receiptOf(ctx.ledgerPath, '401').status, 'ignored')
      assert.equal(onDisk(ctx.ledgerPath).checkpoint.lastSeenPostId, '402')
      assert.ok(!onDisk(ctx.ledgerPath).receipts.some(r => r.status === 'launching'))
    }
  }
})

test('a crash while launch is in flight resolves to held on restart, never a relaunch', async () => {
  const ctx = await setup({ client: fakeClient({ posts: [trigger('500', BUILD)] }) })
  const hung = fakeLaunch(() => new Promise(() => {}))
  const doomed = reopen(ctx, hung)
  void doomed.checkNow()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(hung.calls.length, 1)
  assert.equal(receiptOf(ctx.ledgerPath, '500').status, 'launching')
  const launch = fakeLaunch()
  const restarted = reopen(ctx, launch)
  const r = receiptOf(ctx.ledgerPath, '500')
  assert.equal(r.status, 'held')
  assert.equal(r.reason, X_LAUNCH_UNKNOWN_REASON)
  assert.equal(r.launchAttempted, true)
  const result = await restarted.checkNow()
  assert.equal(result.outcomes[0].status, 'duplicate')
  assert.equal(launch.calls.length, 0)
})

test('a launch that throws or answers garbage is held as unknown; a held answer stays held', async () => {
  const thrower = fakeLaunch(() => { throw new Error('boom') })
  const a = await setup({ client: fakeClient({ posts: [trigger('600', BUILD)] }), launch: thrower })
  assert.equal((await a.reader.checkNow()).outcomes[0].reason, X_LAUNCH_UNKNOWN_REASON)
  const garbage = fakeLaunch({ status: 'submitted', missionId: '../etc' })
  const b = await setup({ client: fakeClient({ posts: [trigger('601', BUILD)] }), launch: garbage })
  assert.equal((await b.reader.checkNow()).outcomes[0].status, 'held')
  const held = fakeLaunch({ status: 'held', reason: 'The broker holds this request: no baseSha' })
  const c = await setup({ client: fakeClient({ posts: [trigger('602', BUILD)] }), launch: held })
  await c.reader.checkNow()
  assert.equal(receiptOf(c.ledgerPath, '602').reason, 'The broker holds this request: no baseSha')
  // Holds are never retried: a full re-read leaves them alone.
  const ledger = onDisk(c.ledgerPath)
  fs.writeFileSync(c.ledgerPath, JSON.stringify({ ...ledger, checkpoint: { lastSeenPostId: null, lastSuccessAt: null } }))
  await reopen(c, held).checkNow()
  assert.equal(held.calls.length, 1)
})

test('stop() during a check launches nothing more and keeps the checkpoint', async () => {
  let reader
  const launch = fakeLaunch(request => { reader.stop(); return { status: 'submitted', missionId: `m-${request.logicalPostId}` } })
  const ctx = await setup({ client: fakeClient({ posts: [trigger('700', BUILD), trigger('701', `${BUILD} two`)] }), launch })
  reader = ctx.reader
  const before = onDisk(ctx.ledgerPath).checkpoint
  const result = await reader.checkNow()
  assert.equal(result.errorKind, 'stopped')
  assert.equal(launch.calls.length, 1)
  assert.deepEqual(onDisk(ctx.ledgerPath).checkpoint, before)
})

// ---------------------------------------------------------- scheduling

function fakeTimers() {
  const pending = []
  return {
    pending,
    setTimeout(fn, ms) { const h = { fn, ms, cleared: false }; pending.push(h); return h },
    clearTimeout(h) { if (h) h.cleared = true },
    async fire() {
      const h = pending.find(p => !p.cleared && !p.fired)
      assert.ok(h, 'a timer is pending')
      h.fired = true
      h.fn()
      for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
      return h
    },
    next: () => pending.filter(p => !p.cleared && !p.fired).at(-1),
  }
}

test('quota and credits back off five minutes; wake() respects it; success resumes the interval', async () => {
  const timers = fakeTimers()
  const client = fakeClient({ posts: [trigger('800', BUILD)] })
  const ctx = await setup({ client, timers })
  client.fail = new XClientError('quota')
  ctx.reader.start()
  assert.equal(timers.next().ms, 0, 'start reads at once')
  await timers.fire()
  const status = ctx.reader.status()
  assert.equal(status.lastErrorKind, 'quota')
  assert.equal(status.backoffUntil, new Date(NOW + 300000).toISOString())
  assert.equal(timers.next().ms, 300000)
  assert.equal(ctx.reader.wake(), false, 'wake does not spend the quota')
  assert.equal(ctx.launch.calls.length, 0)
  assert.equal(onDisk(ctx.ledgerPath).checkpoint.lastSeenPostId, null)
  client.fail = new XClientError('credits')
  await timers.fire()
  assert.equal(timers.next().ms, 300000)
  client.fail = new XClientError('network', { reason: 'x_unreachable' })
  ctx.clock.t = NOW + 300001
  await timers.fire()
  assert.equal(timers.next().ms, 60000, 'other failures wait the normal interval')
  client.fail = null
  await timers.fire()
  assert.equal(ctx.launch.calls.length, 1)
  assert.equal(timers.next().ms, 60000)
  assert.equal(ctx.reader.status().lastError, null)
  assert.equal(ctx.reader.wake(), true)
  assert.equal(timers.next().ms, 0)
  ctx.reader.stop()
  assert.equal(timers.next(), undefined)
  assert.equal(ctx.reader.wake(), false)
})

test('the first read starts at bind time; later reads use the exact since_id', async () => {
  const client = fakeClient({ posts: [trigger('900', BUILD, { created_at: new Date(BOUND - 1000).toISOString() }), trigger('901', BUILD)] })
  const ctx = await setup({ client })
  const result = await ctx.reader.checkNow()
  assert.equal(client.calls[0].startTime, new Date(BOUND).toISOString())
  assert.equal(client.calls[0].sinceId, undefined)
  assert.deepEqual(result.outcomes.map(o => o.postId), ['901'], 'a post from before binding is never a request')
  await ctx.reader.checkNow()
  assert.equal(client.calls[1].sinceId, '901')
})

// -------------------------------------------------------------- window

test('the 24-hour window: an older or untimed request is held, never launched', async () => {
  const old = trigger('1000', BUILD, { created_at: new Date(NOW - 25 * 3600000).toISOString() })
  const untimed = trigger('1001', BUILD, { created_at: 'yesterday-ish' })
  const missing = trigger('1002', BUILD)
  delete missing.created_at
  const fresh = trigger('1003', BUILD, { created_at: new Date(NOW - 23 * 3600000).toISOString() })
  // Bound long ago so the first read covers them all.
  const clock = { t: NOW - 48 * 3600000 }
  const ctx = await setup({ client: fakeClient({ posts: [old, untimed, missing, fresh] }), clock })
  await ctx.reader.checkNow()
  assert.equal(receiptOf(ctx.ledgerPath, '1000').reason, 'Older than 24 hours, so it was not started. Post it again to start it.')
  assert.equal(receiptOf(ctx.ledgerPath, '1001').status, 'held')
  assert.equal(receiptOf(ctx.ledgerPath, '1002').status, 'held')
  assert.equal(receiptOf(ctx.ledgerPath, '1003').status, 'submitted')
  assert.deepEqual(ctx.launch.calls.map(c => c.postId), ['1003'])
})

test('control, status and unclear posts get held, ignored and clarify receipts', async () => {
  const ctx = await setup({ client: fakeClient({ posts: [
    trigger('1100', 'cancel the build'), trigger('1101', 'status'), trigger('1102', 'nice weather today'),
    { ...trigger('1103', ''), text: '@spriite' },
  ] }) })
  await ctx.reader.checkNow()
  assert.equal(receiptOf(ctx.ledgerPath, '1100').status, 'held')
  assert.equal(receiptOf(ctx.ledgerPath, '1101').status, 'ignored')
  assert.equal(receiptOf(ctx.ledgerPath, '1102').status, 'clarify')
  assert.equal(receiptOf(ctx.ledgerPath, '1103').status, 'clarify')
  assert.equal(ctx.launch.calls.length, 0)
})

// ------------------------------------------------------------- routing

test('routing: the named repository, else the designated default, else a new repository', async () => {
  const named = trigger('1200', 'fix the login bug in https://github.com/owner/webapp')
  const plainBuild = trigger('1201', BUILD)
  const newNamed = trigger('1202', 'build a habit tracker in a new repo called habit-log')
  const reference = trigger('1203', 'build something like https://github.com/other/cool-thing for me')
  const withDefault = await setup({ client: fakeClient({ posts: [named, plainBuild, newNamed, reference] }),
    bind: { defaultRepository: DEFAULT_REPO } })
  await withDefault.reader.checkNow()
  const dest = Object.fromEntries(withDefault.launch.calls.map(c => [c.postId, c.destination]))
  assert.deepEqual(dest['1200'], { kind: 'existing', repository: 'https://github.com/owner/webapp' })
  assert.deepEqual(dest['1201'], { kind: 'existing', repository: DEFAULT_REPO })
  assert.deepEqual(dest['1202'], { kind: 'new_repository', name: 'habit-log' })
  assert.equal(dest['1203'], undefined, 'a reference is never silently the default')
  assert.equal(receiptOf(withDefault.ledgerPath, '1203').status, 'held')
  assert.equal(receiptOf(withDefault.ledgerPath, '1200').repository, 'https://github.com/owner/webapp')
  assert.equal(receiptOf(withDefault.ledgerPath, '1202').newRepository, 'habit-log')

  const noDefault = await setup({ client: fakeClient({ posts: [plainBuild, reference] }) })
  await noDefault.reader.checkNow()
  const d2 = Object.fromEntries(noDefault.launch.calls.map(c => [c.postId, c.destination]))
  assert.equal(d2['1201'].kind, 'new_repository')
  assert.match(d2['1201'].name, /^habit-tracker-app-streaks-1201$/)
  assert.equal(d2['1203'].kind, 'new_repository', 'without a default the request gets its own repository')
  assert.ok(Object.isFrozen(noDefault.launch.calls[0]) && Object.isFrozen(noDefault.launch.calls[0].destination))
})

// -------------------------------------------------------------- ledger

test('receipts are bounded to 512, oldest first out; status shows the newest 50', async () => {
  const total = X_READER_MAX_RECEIPTS + 8
  const posts = Array.from({ length: total }, (_, i) => trigger(String(10000 + i), 'cancel the build'))
  const ctx = await setup({ client: fakeClient({ posts }) })
  const result = await ctx.reader.checkNow()
  assert.equal(result.ok, true)
  const ledger = onDisk(ctx.ledgerPath)
  assert.equal(ledger.receipts.length, X_READER_MAX_RECEIPTS)
  assert.equal(ledger.receipts[0].logicalPostId, '10008')
  assert.equal(ledger.receipts.at(-1).logicalPostId, String(10000 + total - 1))
  const status = ctx.reader.status()
  assert.equal(status.receipts.length, 50)
  assert.equal(status.receipts[0].logicalPostId, String(10000 + total - 1), 'newest first')
  assert.ok(!JSON.stringify(status).includes('cancel the build'), 'status carries no post text')
})

test('the ledger is 0600, atomically written, and an unsafe ledger or directory is refused', async () => {
  const ctx = await setup({ client: fakeClient({ posts: [trigger('1300', BUILD)] }) })
  await ctx.reader.checkNow()
  assert.equal(fs.statSync(ctx.ledgerPath).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(ctx.base), ['x-reader.json'], 'no temp file left behind')
  const mk = () => createXReader({ ledgerPath: ctx.ledgerPath, client: fakeClient(), launch: fakeLaunch() })
  fs.chmodSync(ctx.ledgerPath, 0o644)
  assert.throws(mk, code('x_reader_ledger_unsafe'))
  fs.chmodSync(ctx.ledgerPath, 0o600)
  const good = fs.readFileSync(ctx.ledgerPath, 'utf8')
  fs.writeFileSync(ctx.ledgerPath, '{"version":1')
  assert.throws(mk, code('x_reader_ledger_invalid'))
  fs.writeFileSync(ctx.ledgerPath, JSON.stringify({ ...JSON.parse(good), extra: true }))
  assert.throws(mk, code('x_reader_ledger_invalid'))
  fs.writeFileSync(ctx.ledgerPath, good)
  const linkDir = dir(), link = join(linkDir, 'x-reader.json')
  fs.symlinkSync(ctx.ledgerPath, link)
  assert.throws(() => createXReader({ ledgerPath: link, client: fakeClient(), launch: fakeLaunch() }), code('x_reader_ledger_unsafe'))
  const hard = join(ctx.base, 'hardlink.json')
  fs.linkSync(ctx.ledgerPath, hard)
  assert.throws(mk, code('x_reader_ledger_unsafe'))
  fs.unlinkSync(hard)
  fs.chmodSync(ctx.base, 0o770)
  assert.throws(mk, code('x_reader_ledger_unsafe'))
  fs.chmodSync(ctx.base, 0o700)
  assert.doesNotThrow(mk)
  assert.throws(() => createXReader({ ledgerPath: 'relative.json', client: fakeClient(), launch: fakeLaunch() }), code('x_reader_path_invalid'))
})

test('a resume rebind of the same owner keeps the checkpoint; a handoff or a different owner starts fresh', async () => {
  const ctx = await setup({ client: fakeClient({ posts: [trigger('1400', BUILD)] }) })
  await ctx.reader.checkNow()
  await ctx.reader.bind({ spriiteHandle: 'spriite', ownerId: OWNER, spriiteUserId: SPRIITE, defaultRepository: DEFAULT_REPO })
  assert.equal(onDisk(ctx.ledgerPath).checkpoint.lastSeenPostId, '1400')
  assert.equal(onDisk(ctx.ledgerPath).binding.defaultRepository, DEFAULT_REPO)
  // A handoff is a new ownership period even for the same owner.
  await ctx.reader.bind({ spriiteHandle: 'spriite', ownerId: OWNER, spriiteUserId: SPRIITE, fresh: true })
  assert.deepEqual(onDisk(ctx.ledgerPath).checkpoint, { lastSeenPostId: null, lastSuccessAt: null })
  assert.equal(onDisk(ctx.ledgerPath).binding.boundAt, new Date(NOW).toISOString())
  const other = createXReader({ ledgerPath: ctx.ledgerPath, client: fakeClient({ me: { id: '3003', username: 'other' } }), launch: fakeLaunch(), now: () => NOW })
  await other.bind({ spriiteHandle: 'spriite', ownerId: '3003', spriiteUserId: SPRIITE })
  const ledger = onDisk(ctx.ledgerPath)
  assert.equal(ledger.checkpoint.lastSeenPostId, null)
  assert.equal(ledger.binding.boundAt, new Date(NOW).toISOString())
  assert.equal(ledger.receipts.length, 1, 'receipts are owner-keyed and kept')
})

// ------------------------------------------------------ review regressions

test('a post naming a malformed GitHub repository is held, and later posts still launch', async () => {
  const posts = [
    trigger('1500', 'fix the bug in github.com/me-/app please'),
    trigger('1501', 'fix the login bug in https://github.com/owner/foo.git.git'),
    trigger('1502', BUILD),
  ]
  const ctx = await setup({ client: fakeClient({ posts }) })
  for (let i = 0; i < 2; i++) {
    const result = await ctx.reader.checkNow()
    assert.equal(result.ok, true, `check ${i} is not wedged: ${result.error}`)
  }
  assert.deepEqual(ctx.launch.calls.map(c => c.postId), ['1502'])
  for (const id of ['1500', '1501']) {
    const r = receiptOf(ctx.ledgerPath, id)
    assert.equal(r.status, 'held')
    assert.match(r.reason, /not a valid GitHub repository/)
    assert.equal(r.repository, undefined, 'no repository field the ledger would refuse')
  }
  assert.equal(onDisk(ctx.ledgerPath).checkpoint.lastSeenPostId, '1502')
})

test('stop() resolves only after the in-flight launch drains; the stopped reader writes no checkpoint', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const launchesA = fakeLaunch(async request => { await gate; return { status: 'submitted', missionId: `m-${request.logicalPostId}` } })
  const client = fakeClient({ posts: [trigger('1600', BUILD), trigger('1601', `${BUILD} two`)] })
  const ctx = await setup({ client, launch: launchesA })
  const before = onDisk(ctx.ledgerPath).checkpoint
  const check = ctx.reader.checkNow()
  for (let i = 0; i < 5 && launchesA.calls.length === 0; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(launchesA.calls.length, 1)
  let stopped = false
  const stopping = ctx.reader.stop().then(() => { stopped = true })
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, false, 'stop waits for the launch in flight')
  release()
  await stopping
  assert.equal((await check).errorKind, 'stopped')
  assert.equal(receiptOf(ctx.ledgerPath, '1600').status, 'submitted', 'the launch outcome is recorded')
  assert.equal(receiptOf(ctx.ledgerPath, '1601'), undefined, 'nothing more is written after stop')
  assert.deepEqual(onDisk(ctx.ledgerPath).checkpoint, before)
  // The next reader on the same ledger (a handoff, a restart) never relaunches.
  const launchesB = fakeLaunch()
  const b = reopen(ctx, launchesB)
  assert.equal((await b.checkNow()).ok, true)
  const c = reopen(ctx, launchesB)
  await c.checkNow()
  assert.deepEqual([...launchesA.calls, ...launchesB.calls].map(r => r.postId), ['1600', '1601'])
  assert.equal(onDisk(ctx.ledgerPath).checkpoint.lastSeenPostId, '1601')
})

test('a handoff bind starts at the phone\'s last check and receipts what the phone handled', async () => {
  const base = dir(), ledgerPath = join(base, 'x-reader.json')
  const phoneCheck = new Date(NOW - 10 * 60000).toISOString()
  const before = trigger('1700', BUILD, { created_at: new Date(NOW - 20 * 60000).toISOString() })
  const handled = trigger('1701', `${BUILD} handled`, { created_at: new Date(NOW - 9 * 60000).toISOString() })
  const missed = trigger('1702', `${BUILD} missed`, { created_at: new Date(NOW - 5 * 60000).toISOString() })
  const client = fakeClient({ posts: [before, handled, missed] })
  const launch = fakeLaunch()
  const reader = createXReader({ ledgerPath, client, launch, now: () => NOW })
  await reader.bind({ spriiteHandle: 'spriite', ownerId: OWNER, spriiteUserId: SPRIITE, fresh: true, startAt: phoneCheck,
    seenPostIds: ['1701'] })
  assert.equal(onDisk(ledgerPath).binding.readFrom, phoneCheck)
  await reader.checkNow()
  assert.equal(client.calls[0].startTime, phoneCheck)
  assert.deepEqual(launch.calls.map(c => c.postId), ['1702'], 'the post made while the app was closed launches; the handled one does not')
  assert.equal(receiptOf(ledgerPath, '1701').status, 'ignored')
  // The window bounds how far back a handoff reads.
  const other = createXReader({ ledgerPath: join(dir(), 'x-reader.json'), client: fakeClient(), launch: fakeLaunch(), now: () => NOW })
  const bound = await other.bind({ spriiteHandle: 'spriite', ownerId: OWNER, spriiteUserId: SPRIITE, fresh: true,
    startAt: new Date(NOW - 72 * 3600000).toISOString() })
  assert.equal(bound.readFrom, new Date(NOW - 86400000).toISOString())
  await assert.rejects(other.bind({ spriiteHandle: 'spriite', ownerId: OWNER, spriiteUserId: SPRIITE, seenPostIds: ['x'] }), code('x_bind_invalid'))
})

/** A paging fake: newest first, `size` per page, since_id/until_id like X. */
function pagingClient(posts, size) {
  const calls = []
  return {
    calls, posts,
    async me() { return { id: OWNER, username: 'owner' } },
    async userPosts(userId, options = {}) {
      calls.push({ ...options })
      const since = options.sinceId ? BigInt(options.sinceId) : null
      const until = options.untilId ? BigInt(options.untilId) : null
      const all = this.posts.filter(p => (since === null || BigInt(p.id) > since) && (until === null || BigInt(p.id) < until)).reverse()
      const from = options.paginationToken ? Number(options.paginationToken) : 0
      const page = all.slice(from, from + size)
      return { posts: page, includes: {}, nextToken: from + size < all.length ? String(from + size) : null }
    },
  }
}

test('a backlog larger than one check is read in later checks, never skipped', async () => {
  const client = pagingClient([trigger('1800', BUILD)], 2)
  const ctx = await setup({ client, maxPages: 1 })
  await ctx.reader.checkNow()
  assert.equal(onDisk(ctx.ledgerPath).checkpoint.lastSeenPostId, '1800')
  client.posts = ['1800', '1801', '1802', '1803', '1804', '1805'].map(id => trigger(id, `${BUILD} ${id}`))
  const first = await ctx.reader.checkNow()
  assert.equal(first.gap, true)
  assert.deepEqual(onDisk(ctx.ledgerPath).checkpoint.backlog, { untilId: '1804', newestId: '1805' })
  assert.equal(onDisk(ctx.ledgerPath).checkpoint.lastSeenPostId, '1800', 'the checkpoint does not jump past unread posts')
  await ctx.reader.checkNow()
  assert.equal(client.calls.at(-1).untilId, '1804')
  const last = await ctx.reader.checkNow()
  assert.equal(last.gap, false)
  const cp = onDisk(ctx.ledgerPath).checkpoint
  assert.equal(cp.lastSeenPostId, '1805'); assert.equal(cp.backlog, undefined)
  assert.deepEqual(ctx.launch.calls.map(c => c.postId).sort(), ['1800', '1801', '1802', '1803', '1804', '1805'])
  assert.equal(onDisk(ctx.ledgerPath).gapCount, 1, 'one backlog, counted once')
  await ctx.reader.checkNow()
  assert.equal(client.calls.at(-1).sinceId, '1805'); assert.equal(client.calls.at(-1).untilId, undefined)
  assert.equal(ctx.launch.calls.length, 6)
})

test('an auth failure (a refused grant) backs off instead of re-sending every minute', async () => {
  const timers = fakeTimers()
  const client = fakeClient()
  const ctx = await setup({ client, timers })
  client.fail = new XClientError('auth', { reason: 'x_renewal_rejected' })
  ctx.reader.start()
  await timers.fire()
  assert.equal(ctx.reader.status().lastErrorKind, 'auth')
  assert.equal(timers.next().ms, 300000)
  assert.equal(ctx.reader.wake(), false)
  await ctx.reader.stop()
})

test('a reply under a live launched build is held as a follow-up, never a second mission', async () => {
  const live = new Set(['m-1900'])
  const client = fakeClient({ posts: [trigger('1900', BUILD)] })
  const ctx = await setup({ client, missionLive: id => live.has(id) })
  await ctx.reader.checkNow()
  const reply = (id, text) => trigger(id, text, { referenced_tweets: [{ type: 'replied_to', id: '1900' }],
    display_text_range: [0, cpLen(`@spriite ${text}`)] })
  client.posts = [trigger('1900', BUILD), reply('1901', 'also add dark mode'), reply('1902', 'lol')]
  await ctx.reader.checkNow()
  assert.deepEqual(ctx.launch.calls.map(c => c.postId), ['1900'])
  assert.equal(receiptOf(ctx.ledgerPath, '1901').status, 'held')
  assert.match(receiptOf(ctx.ledgerPath, '1901').reason, /follow-up/)
  assert.equal(receiptOf(ctx.ledgerPath, '1902').status, 'clarify')
  // Under a finished mission a reply is a request of its own, as on the phone.
  live.clear()
  client.posts = [reply('1903', 'build a recipe app with search')]
  await ctx.reader.checkNow()
  assert.deepEqual(ctx.launch.calls.map(c => c.postId), ['1900', '1903'])
})

test('a word naming one of the owner\'s repositories is asked about, never routed to the default', async () => {
  const repos = ['owner/habit-log', 'owner/designated']
  const posts = [trigger('2000', 'add dark mode to habit-log'), trigger('2001', 'add dark mode to designated'),
    trigger('2002', 'build a recipe app with search')]
  const ctx = await setup({ client: fakeClient({ posts }), bind: { defaultRepository: DEFAULT_REPO }, repositories: () => repos })
  await ctx.reader.checkNow()
  assert.equal(receiptOf(ctx.ledgerPath, '2000').status, 'held')
  assert.match(receiptOf(ctx.ledgerPath, '2000').reason, /^Is habit-log a new repository or an existing one\?/)
  const dest = Object.fromEntries(ctx.launch.calls.map(c => [c.postId, c.destination]))
  assert.deepEqual(dest['2001'], { kind: 'existing', repository: DEFAULT_REPO }, 'the named default is the default')
  assert.deepEqual(dest['2002'], { kind: 'existing', repository: DEFAULT_REPO })
  const unreadable = await setup({ client: fakeClient({ posts: [trigger('2003', BUILD)] }), bind: { defaultRepository: DEFAULT_REPO },
    repositories: () => null })
  await unreadable.reader.checkNow()
  assert.match(receiptOf(unreadable.ledgerPath, '2003').reason, /could not be read/)
  assert.equal(unreadable.launch.calls.length, 0)
})

test('host receipt copy never promises a phone action that does not exist', async () => {
  const ctx = await setup({ client: fakeClient({ posts: [
    trigger('2100', 'cancel the build'), trigger('2101', 'status'),
    trigger('2102', BUILD, { created_at: new Date(NOW - 25 * 3600000).toISOString() }),
  ] }), clock: { t: NOW - 48 * 3600000 } })
  await ctx.reader.checkNow()
  for (const r of onDisk(ctx.ledgerPath).receipts) {
    assert.doesNotMatch(r.reason, /Confirm on the phone|Choose a destination|need your OK|answered on the phone|review on phone/, r.reason)
  }
  assert.doesNotMatch(X_LAUNCH_UNKNOWN_REASON, /review on phone/)
})

let passed = 0
for (const { name, fn } of tests) {
  try { await fn(); passed++; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL: ${name}`); console.error(error); process.exitCode = 1 }
}
console.log(`Host X reader checks: ${passed}/${tests.length} passed; fake X client and launch, no X API call or real credential.`)
