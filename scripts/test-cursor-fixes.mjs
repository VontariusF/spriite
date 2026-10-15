// Regression tests for the Cursor HTTP client (src/factory/cursor.ts).
// Run: node --import ./scripts/ts-resolve.mjs scripts/test-cursor-fixes.mjs
import assert from 'node:assert/strict'
import { CursorError, getCursorRun, createCursorRun, cursorMe } from '../src/factory/cursor.ts'

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`PASS: ${name}`)
  } catch (e) {
    failed++
    console.log(`FAIL: ${name}\n  ${e?.stack ?? e}`)
  }
}

const realFetch = globalThis.fetch
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const DEADLINE_MS = 30_000

/** Shrink only the client's 30s request deadline so the test runs fast. */
function withFastDeadline(fn) {
  globalThis.setTimeout = (cb, ms, ...rest) => realSetTimeout(cb, ms === DEADLINE_MS ? 20 : ms, ...rest)
  return Promise.resolve().then(fn).finally(() => {
    globalThis.setTimeout = realSetTimeout
    globalThis.fetch = realFetch
  })
}

/** A connection that is accepted but never answers; resolves only on abort. */
function hangingFetch(seen) {
  return (_url, init) => new Promise((_, reject) => {
    seen.signal = init?.signal
    init?.signal?.addEventListener('abort', () => {
      seen.aborted = true
      reject(new DOMException('aborted', 'AbortError'))
    })
  })
}

/** Settle within a real 2s guard, or report the hang. */
function guard(promise) {
  let t
  return Promise.race([
    promise.then((v) => ({ v }), (e) => ({ e })),
    new Promise((resolve) => { t = realSetTimeout(() => resolve({ hung: true }), 2_000) }),
  ]).finally(() => realClearTimeout(t))
}

await test('a hung run poll rejects as a retryable network fault and aborts the fetch', () =>
  withFastDeadline(async () => {
    const seen = {}
    globalThis.fetch = hangingFetch(seen)
    const out = await guard(getCursorRun('k', 'agent-1', 'run-1'))
    assert.ok(!out.hung, 'getCursorRun must not hang forever on a silent connection')
    assert.ok(out.e instanceof CursorError, 'rejects with CursorError')
    assert.equal(out.e.kind, 'network', "kind 'network' keeps the poll retryable (and a launch unknown)")
    assert.match(out.e.message, /deadline/i)
    assert.ok(seen.signal, 'fetch receives an abort signal')
    assert.equal(seen.aborted, true, 'the hung request is aborted, not leaked')
  }))

await test('a hung launch (POST) also hits the deadline instead of hanging', () =>
  withFastDeadline(async () => {
    const seen = {}
    globalThis.fetch = hangingFetch(seen)
    const out = await guard(createCursorRun('k', 'agent-1', { promptText: 'fix it' }))
    assert.ok(!out.hung, 'createCursorRun must not hang forever')
    assert.ok(out.e instanceof CursorError)
    assert.equal(out.e.kind, 'network')
    assert.equal(seen.aborted, true)
  }))

await test('a body that never finishes streaming is bounded too', () =>
  withFastDeadline(async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })
    const out = await guard(cursorMe('k'))
    assert.ok(!out.hung)
    assert.equal(out.e?.kind, 'network')
  }))

await test('a prompt answer still succeeds and clears its deadline timer', async () => {
  const timers = new Set()
  globalThis.setTimeout = (cb, ms, ...rest) => {
    const id = realSetTimeout(cb, ms, ...rest)
    if (ms === DEADLINE_MS) timers.add(id)
    return id
  }
  globalThis.clearTimeout = (id) => { timers.delete(id); realClearTimeout(id) }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'run-1', status: 'FINISHED' }) })
  try {
    const run = await getCursorRun('k', 'agent-1', 'run-1')
    assert.equal(run.status, 'FINISHED')
    assert.equal(timers.size, 0, 'deadline timer is cleared once the call settles')
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    globalThis.fetch = realFetch
  }
})

await test('HTTP status classification is unchanged behind the deadline', async () => {
  try {
    for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [429, 'quota'], [500, 'service']]) {
      globalThis.fetch = async () => ({ ok: false, status, json: async () => null })
      await assert.rejects(getCursorRun('k', 'a', 'r'), (e) => e instanceof CursorError && e.kind === kind)
    }
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    await assert.rejects(getCursorRun('k', 'a', 'r'), (e) => e instanceof CursorError && e.kind === 'network')
  } finally {
    globalThis.fetch = realFetch
  }
})

console.log(`Cursor fixes: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
