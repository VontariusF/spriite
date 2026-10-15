/**
 * Regression tests for three archive/relay defects:
 *  1. the archive rate window was one global bucket counted before auth, so
 *     an unauthenticated client could spend it and lock the owner's sync and
 *     restore out with 429;
 *  2. the phone's restore walk took a page with no readable rows for the end
 *     of the archive, reporting a partial restore as complete;
 *  3. the bridge buffered a whole request body before checking its cap.
 * No network: the relay runs in-process over a temp sqlite file, and the
 * restore walk talks to a scripted relay.
 *
 * Usage: node --import ./scripts/ts-resolve.mjs scripts/test-archive-fixes.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handle as bridgeHandle } from '../relay/worker.js'
import { relayHandle as nodeRelayHandle } from '../relay/node.mjs'
import { createArchive } from '../relay/archive.mjs'
import { ArchiveClient, RESTORE_MAX_PAGES } from '../src/state/archive.ts'
import { FeedVault } from '../src/state/feed.ts'
import { Supervisor } from '../src/runtime/supervisor.ts'
import { TestKV, SETTINGS, makeClients, newStore, makeTally } from './lib/runtime-fake.mjs'

const { assert, failures } = makeTally()
console.log('== Archive fix regressions (rate bucket, restore walk, bridge body cap) ==')
const section = (name) => console.log(`\n-- ${name}`)

// ------------------------------------------------ 1. rate window per bearer
section('relay: an unauthenticated flood cannot spend the owner window')
{
  // fake values only: the tests need shapes, never a real key
  const KEY = 'test-device-key-0123456789abcdefghijklmnopqrstuvwxyz'
  const keyHash = createHash('sha256').update(KEY).digest('hex')
  const dir = mkdtempSync(join(tmpdir(), 'spriite-archive-fix-'))
  const env = { ALLOWED_ORIGINS: '*' }
  const auth = { authorization: `Bearer ${KEY}` }
  const call = (archive, path, body, headers = {}) =>
    nodeRelayHandle(new Request(`https://relay.test${path}`, { method: 'POST', body, headers }), archive, env)
  const emptySync = JSON.stringify({ v: 1, cursor: '', records: [] })
  try {
    const archive = createArchive({ dbPath: join(dir, 'flood.db'), keyHash, ratePerMinute: 3 })
    const flood = []
    for (let i = 0; i < 6; i++) flood.push((await call(archive, '/spriite/sync', '{}')).status)
    const wrong = await call(archive, '/spriite/sync', '{}', { authorization: 'Bearer not-the-key' })
    assert(
      flood.slice(0, 3).every((s) => s === 401) && flood.slice(3).every((s) => s === 429) && wrong.status === 429,
      'unknown bearers are still rate limited: 401 inside their window, 429 past it',
    )
    const ownerSync = await call(archive, '/spriite/sync', emptySync, auth)
    const ownerRestore = await call(archive, '/spriite/archive', JSON.stringify({ v: 1, cursor: '' }), auth)
    assert(
      ownerSync.status === 200 && ownerRestore.status === 200,
      'the owner key still syncs and restores while strangers are throttled',
    )
    const third = await call(archive, '/spriite/sync', emptySync, auth)
    const fourth = await call(archive, '/spriite/sync', emptySync, auth)
    assert(third.status === 200 && fourth.status === 429, 'the owner key keeps its own window, still capped')
    archive.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------ 2. restore walk
section('restore: a page with no readable rows is not the end of the archive')
{
  const archiveGateway = (map = new Map()) => ({
    call: async (op) =>
      op({
        getLocalStorage: async (k) => map.get(k) ?? '',
        setLocalStorage: async (k, v) => {
          map.set(k, v)
          return true
        },
      }),
  })
  const missionRow = (id, at) => ({
    kind: 'mission', mission_id: id, title: `Title ${id}`, goal: `Goal ${id}`, status: 'completed',
    repo: 'https://github.com/example/x', origin: 'phone', created_at: at - 1000, updated_at: at,
  })
  // a tag row whose status this build does not know: isArchiveRecord drops it
  const foreignTag = (n) => ({
    kind: 'tag', dedupe_key: `x:${n}:1`, logical_post_id: String(n), revision_id: '1', via: 'stream',
    status: 'some-future-status', instruction: 'Build it', repository: '', mission_id: '', received_at: 1000,
  })
  const makeClient = async (fetch) => {
    const kv = new TestKV()
    const gateway = archiveGateway()
    const feedVault = new FeedVault(gateway)
    await feedVault.load()
    let client = null
    const store = newStore(kv, { observe: (prev, next) => client?.noteState(prev, next) })
    const supervisor = new Supervisor({
      store, kv, clients: makeClients(), settings: () => ({ ...SETTINGS }),
      emitView: () => {}, now: () => 0, snapshotDebounceMs: 0,
    })
    await supervisor.boot()
    client = new ArchiveClient({
      gateway, store,
      sources: {
        missions: () => supervisor.missions,
        snapshotFor: (id) => supervisor.engineSnapshotFor(id),
        chatTailFor: (id) => supervisor.engineSnapshotFor(id)?.chat ?? [],
        feed: () => feedVault.restore(),
        receipts: () => supervisor.missionStore.current.xIntake?.receipts ?? [],
      },
      feed: feedVault, enabled: () => true, foreground: () => true,
      base: 'https://vps.test/spriite', fetch, now: () => 0, debounceMs: 60_000_000,
    })
    await client.load()
    await client.adoptDeviceKey('a'.repeat(43))
    return client
  }
  const pageResponse = (records, cursor) => ({ ok: true, status: 200, json: async () => ({ v: 1, records, cursor }) })

  // page 1: a mission; page 2: only rows this build rejects; page 3: a mission, end
  const script = [
    pageResponse([missionRow('m_new', 3000)], 'c1'),
    pageResponse([foreignTag(1), foreignTag(2)], 'c2'),
    pageResponse([missionRow('m_old', 2000)], ''),
  ]
  let calls = 0
  const client = await makeClient(async () => script[Math.min(calls++, script.length - 1)])
  const out = await client.restore()
  assert(
    out.status === 'restored' && out.pages === 3 && out.missions === 2 && out.more === false,
    'the walk pages past an unreadable page and lands the older records behind it',
  )

  // a relay that never ends and only serves unreadable rows: still bounded,
  // and the outcome says the archive held more
  let endlessCalls = 0
  const endless = await makeClient(async () => {
    endlessCalls++
    return pageResponse([foreignTag(endlessCalls)], 'always-more')
  })
  const capped = await endless.restore()
  assert(
    capped.status === 'restored' && capped.pages === RESTORE_MAX_PAGES && capped.more === true && endlessCalls === RESTORE_MAX_PAGES,
    'an unreadable endless walk stops at the cap and says the archive holds more',
  )
}

// ------------------------------------------------ 3. bridge body cap
section('bridge: an oversized body is refused while it streams')
{
  const realFetch = globalThis.fetch
  const forwarded = []
  globalThis.fetch = async (url, init) => {
    forwarded.push({ url, body: init?.body })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const chunk = new Uint8Array(1024 * 1024)
    const total = 50
    let pulled = 0
    const stream = new ReadableStream({
      pull(controller) {
        if (pulled >= total) return controller.close()
        pulled++
        controller.enqueue(chunk)
      },
    })
    const big = await bridgeHandle(
      new Request('https://relay.test/factory/api/v0/anything', { method: 'POST', body: stream, duplex: 'half' }),
    )
    assert(big.status === 413, 'a streamed body over the cap is refused 413')
    assert(pulled < 5, `the bridge stops reading once past the cap (read ${pulled} of ${total} MiB)`)

    const declared = await bridgeHandle(
      new Request('https://relay.test/factory/api/v0/anything', {
        method: 'POST', body: 'x', headers: { 'content-length': String(2_000_000) },
      }),
    )
    assert(declared.status === 413, 'a body declared over the cap is refused before it is read')

    const small = await bridgeHandle(
      new Request('https://relay.test/factory/api/v0/anything', { method: 'POST', body: '{"a":1}' }),
    )
    const sent = forwarded.at(-1)
    assert(
      small.status === 200 && forwarded.length === 1 && new TextDecoder().decode(sent.body) === '{"a":1}',
      'a body under the cap is forwarded byte for byte',
    )
  } finally {
    globalThis.fetch = realFetch
  }
}

if (failures() === 0) console.log('\nARCHIVE FIX TESTS PASSED')
else console.log(`\nARCHIVE FIX TESTS FAILED: ${failures()} failures`)
process.exit(failures() === 0 ? 0 : 1)
