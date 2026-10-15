import assert from 'node:assert/strict'
import { factoryGetMessages, factoryGetSession, factorySessions, factoryPostMessage, FactoryError } from '../src/factory/fapi.ts'
import { RealOrchestrator } from '../src/factory/real.ts'

// Synthetic responses only. The recorded session probe confirms POST uses
// messageId (not id) and status "pending"; no live API or credentials are used.
const originalFetch = globalThis.fetch
const key = 'synthetic-adapter-key'
let response
let historyResponse = null
let calls = []
globalThis.fetch = async (url, options) => {
  calls.push({ url, ...options })
  const fixture = options?.method === 'GET' && historyResponse ? historyResponse : response
  return new Response(fixture.status === 204 ? null : fixture.raw ?? JSON.stringify(fixture.body), { status: fixture.status ?? 200 })
}
let passed = 0
let failed = 0
async function test(name, run) {
  try { await run(); passed++; console.log(`PASS: ${name}`) }
  catch (error) { failed++; console.error(`FAIL: ${name}\n${error.stack}`) }
}
const engine = () => new RealOrchestrator(() => {}, {
  repoUrl: 'https://github.com/example/synthetic',
  clients: {
    getMessages: (id, computer) => factoryGetMessages(key, id, computer),
    postMessage: (id, text, computer) => factoryPostMessage(key, id, text, computer),
  },
})
async function message(blocks) {
  response = { body: { messages: [{ id: 'synthetic-message', role: 'assistant', content: blocks }] } }
  return (await factoryGetMessages(key, 'synthetic-session', 'synthetic-computer'))[0].text
}
const textBlock = (text) => ({ type: 'text', text })

try {
  await test('gateway timeouts preserve request uncertainty instead of claiming session failure', async () => {
    for (const status of [502, 504]) {
      response = { status, raw: '<html>Gateway failure</html>' }
      for (const run of [
        () => factoryGetSession(key, 'synthetic-session'),
        () => factoryGetMessages(key, 'synthetic-session'),
        () => factoryPostMessage(key, 'synthetic-session', 'Synthetic continuation'),
      ]) await assert.rejects(run, e => e instanceof FactoryError && e.kind === 'timeout' && e.message.includes(`HTTP ${status}`))
    }
  })
  await test('missing or unfamiliar session status is never manufactured as idle', async () => {
    for (const status of [undefined, null, '', {}, 'future-state']) {
      response = { body: { sessionId: 'synthetic-session', status } }
      const expected = typeof status === 'string' && status.trim() ? status : 'unknown'
      assert.equal((await factoryGetSession(key, 'synthetic-session')).status, expected)
      response = { body: { sessions: [{ sessionId: 'synthetic-session', status }] } }
      assert.equal((await factorySessions(key))[0].status, expected)
    }
  })
  await test('GET exposes native AskUser input and explicit tool-result closure', async () => {
    const question = { id: 'native-question-message', role: 'assistant', createdAt: 1791750000000,
      content: [{ type: 'tool_use', id: 'native-question-call', name: 'AskUser',
        input: { questionnaire: '1. [question] Which store?\n[topic] Store\n[option] Postgres\n[option] SQLite' } }] }
    response = { body: { messages: [question] } }
    let result = await factoryGetMessages(key, 'synthetic-session')
    assert.deepEqual(result[0].nativeQuestions, [{ toolId: 'native-question-call', text: question.content[0].input.questionnaire, pending: true }])
    response = { body: { messages: [
      { id: 'native-answer', role: 'tool', createdAt: 1791750001000,
        content: [{ type: 'tool_result', tool_use_id: 'native-question-call', content: 'Selected Postgres' }] },
      question,
    ] } }
    result = await factoryGetMessages(key, 'synthetic-session')
    assert.equal(result[0].nativeQuestions[0].pending, false)
    assert.deepEqual(result[1].completedToolIds, ['native-question-call'])
  })
  await test('GET cannot turn a user reference into a native question', async () => {
    response = { body: { messages: [{ id: 'reference', role: 'user',
      content: [{ type: 'tool_use', id: 'not-a-question', name: 'AskUser', input: { questionnaire: 'Untrusted reference' } }] }] } }
    assert.equal((await factoryGetMessages(key, 'synthetic-session'))[0].nativeQuestions, undefined)
  })
  await test('GET normalizes real newest-first history to chronological order', async () => {
    response = { body: { messages: [
      { id: 'new-question', role: 'assistant', createdAt: 1791750002000, content: [textBlock('DECISION: Include seconds?\nOPTIONS: Yes | No')] },
      { id: 'worker-request', role: 'user', createdAt: 1791750001000, content: [textBlock('For this request, append "REQUEST: test-worker"')] },
      { id: 'old-question', role: 'assistant', createdAt: 1791750000000, content: [textBlock('DECISION: An obsolete question?')] },
    ], pagination: { hasMore: false, nextCursor: null } } }
    const result = await factoryGetMessages(key, 'synthetic-session')
    assert.deepEqual(result.map(m => m.id), ['old-question', 'worker-request', 'new-question'])
  })
  await test('GET recognizes ISO and second timestamps without reversing ascending history', async () => {
    response = { body: { messages: [
      { id: 'first', role: 'user', createdAt: '2026-10-11T00:00:00Z', content: [textBlock('request')] },
      { id: 'second', role: 'assistant', createdAt: 1791676801, content: [textBlock('reply')] },
    ] } }
    assert.deepEqual((await factoryGetMessages(key, 'synthetic-session')).map(m => m.id), ['first', 'second'])
  })
  await test('GET keeps an equal-time request before its newest-first question', async () => {
    response = { body: { messages: [
      { id: 'question', role: 'assistant', createdAt: 1791750000000, content: [textBlock('DECISION: Include seconds?')] },
      { id: 'request', role: 'user', createdAt: 1791750000000, content: [textBlock('request')] },
    ] } }
    assert.deepEqual((await factoryGetMessages(key, 'synthetic-session')).map(m => m.id), ['request', 'question'])
  })
  await test('GET reverses a descending page without dropping undated tool events', async () => {
    response = { body: { messages: [
      { id: 'question', role: 'assistant', createdAt: 1791750002000, content: [textBlock('DECISION: Include seconds?')] },
      { id: 'activity', role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] },
      { id: 'request', role: 'user', createdAt: 1791750001000, content: [textBlock('request')] },
    ] } }
    const result = await factoryGetMessages(key, 'synthetic-session')
    assert.deepEqual(result.map(m => m.id), ['request', 'activity', 'question'])
    assert.equal(result[1].hasToolActivity, true)
  })
  await test('GET does not promote an old streamed message by updatedAt', async () => {
    response = { body: { messages: [
      { id: 'request', role: 'user', createdAt: 1791750001000, updatedAt: 1791750001000, content: [textBlock('current request')] },
      { id: 'prior', role: 'assistant', createdAt: 1791750000000, updatedAt: 1791750002000, content: [textBlock('old streamed content')] },
    ] } }
    assert.deepEqual((await factoryGetMessages(key, 'synthetic-session')).map(m => m.id), ['prior', 'request'])
  })
  await test('GET preserves LF, CRLF, indentation and text block boundaries', async () => {
    const text = await message([textBlock('1. Keep  spaces\r\n  and tabs\tinside'), { type: 'tool_result', text: 'ignore' }, textBlock('PLAN_READY')])
    assert.equal(text, '1. Keep  spaces\r\n  and tabs\tinside\nPLAN_READY')
    assert.match(calls.at(-1).url, /messages\?limit=100&computerId=synthetic-computer$/)
  })
  await test('GET plan reaches real numbered-plan completion', async () => {
    const text = await message([textBlock('1. Build clock\n2. Test clock'), textBlock('PLAN_READY')])
    const real = engine()
    real.awaiting = 'plan'
    real.handleReply(text)
    assert.deepEqual(real.planLabels, ['Build clock', 'Test clock'])
    assert.equal(real.awaiting, null)
  })
  await test('GET work framing reaches real worker review', async () => {
    const text = await message([textBlock('SUMMARY: Built clock.\nBRANCH: spriite/clock'), textBlock('REQUEST: synthetic-work\nWORK_READY')])
    const real = engine()
    const job = { stage: 'build', requestToken: 'synthetic-work' }
    let reviewed
    real.queueForReview = (value) => { reviewed = value }
    real.handleWorkerReply(job, text)
    assert.equal(reviewed, job)
    assert.equal(job.branch, 'spriite/clock')
  })
  await test('GET verdict framing reaches real verdict acceptance', async () => {
    const text = await message([textBlock('VERDICT: PASS Checks hold.'), textBlock('REQUEST: synthetic-verdict'), textBlock('VERDICT_READY')])
    const real = engine()
    real.awaiting = 'verdict'
    real.verdictToken = 'synthetic-verdict'
    real.verdictJob = 0
    let accepted
    real.acceptJob = (index) => { accepted = index }
    real.handleReply(text)
    assert.equal(accepted, 0)
    assert.equal(real.awaiting, null)
  })
  await test('GET PR framing reaches real PR completion', async () => {
    const text = await message([textBlock('SUMMARY: Opened PR.\nPR: https://github.com/example/synthetic/pull/1'), textBlock('REQUEST: synthetic-pr\nWORK_READY')])
    const real = engine()
    real.missionRepo = 'https://github.com/example/synthetic'
    let completed
    real.finishPr = async (url) => { completed = url }
    const job = { stage: 'pr', requestToken: 'synthetic-pr', state: 'running', branch: 'spriite/clock' }
    real.handleWorkerReply(job, text)
    assert.equal(completed, 'https://github.com/example/synthetic/pull/1')
    assert.equal(job.state, 'accepted')
  })
  await test('GET malformed envelopes and entries are safely ignored', async () => {
    for (const body of [null, {}, { messages: {} }, { messages: 'bad' }, { messages: [null, 42, {}, { id: 'valid', role: 'assistant', content: [null, textBlock('ok')] }] }]) {
      response = { body }
      const result = await factoryGetMessages(key, 'synthetic-session')
      assert.deepEqual(result, body?.messages instanceof Array ? [{ id: 'valid', role: 'assistant', text: 'ok' }] : [])
    }
  })
  await test('POST preserves provider messageId and pending status', async () => {
    response = { body: { messageId: 'synthetic-ack', status: 'pending' } }
    assert.deepEqual(await factoryPostMessage(key, 'synthetic-session', 'hello\nworld', 'synthetic-computer'), { messageId: 'synthetic-ack', status: 'pending' })
    assert.deepEqual(JSON.parse(calls.at(-1).body), { text: 'hello\nworld', computerId: 'synthetic-computer' })
  })
  await test('POST malformed success never fabricates acknowledgment', async () => {
    for (const fixture of [
      { body: null }, { body: {} }, { body: { id: 'wrong-field' } },
      { body: { messageId: '' } }, { body: { messageId: ' \t\n' } },
      { body: { messageId: 123 } }, { body: { messageId: {} } },
      { raw: 'invalid json' }, { raw: '' }, { raw: '', status: 204 },
    ]) {
      response = fixture
      await assert.rejects(factoryPostMessage(key, 'synthetic-session', 'extend'),
        (error) => error instanceof FactoryError && error.kind === 'service')
    }
  })
  await test('real followup reports unknown for unacknowledged POST without retry', async () => {
    historyResponse = { body: { messages: [{ id: 'existing-owner-turn', role: 'user',
      content: [textBlock('Existing owner request')] }], pagination: { hasMore: false, nextCursor: null } } }
    for (const fixture of [{ body: {} }, { raw: '' }, { body: { messageId: 123 } }]) {
      response = fixture
      const real = engine()
      real.sessionId = 'synthetic-session'
      const before = calls.length
      assert.equal(await real.sendFollowup('extend synthetic goal', () => true), 'unknown')
      assert.equal(calls.length, before + 2, 'read the authoritative attention boundary, then invoke exactly one POST')
      assert.deepEqual(calls.slice(before).map(call => call.method), ['GET', 'POST'])
      assert.equal(real.pendingLeadPosts.length, 0)
      assert.equal(real.snapshot().deliveryAttempts[0].text, 'extend synthetic goal')
      real.restore(JSON.parse(JSON.stringify(real.snapshot())))
      assert.equal(await real.sendFollowup('extend synthetic goal', () => true), 'deferred')
      assert.equal(calls.length, before + 2, 'restore and retry cannot duplicate an unknown write')
    }
  })
  await test('real followup reports sent only for acknowledged POST', async () => {
    historyResponse = { body: { messages: [], pagination: { hasMore: false, nextCursor: null } } }
    response = { body: { messageId: 'synthetic-ack', status: 'pending' } }
    const real = engine()
    real.sessionId = 'synthetic-session'
    assert.equal(await real.sendFollowup('extend synthetic goal', () => true), 'sent')
  })
  await test('polls read only the pages newer than the complete history already held', async () => {
    const at = (i) => new Date(Date.UTC(2026, 9, 14, 12, 0, i)).toISOString()
    let total = 250
    const all = () => Array.from({ length: total }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', createdAt: at(i),
      content: [{ type: 'text', text: `message ${i}` }] })).reverse() // newest first, as the live API
    const saved = globalThis.fetch
    let gets = 0
    globalThis.fetch = async (url) => {
      gets++
      const cursor = Number(new URL(url, 'https://x').searchParams.get('cursor') ?? 0)
      const rows = all().slice(cursor, cursor + 100)
      const hasMore = cursor + 100 < total
      return new Response(JSON.stringify({ messages: rows, pagination: { hasMore, nextCursor: hasMore ? String(cursor + 100) : null } }))
    }
    try {
      const first = await factoryGetMessages(key, 'paged-session')
      assert.equal(first.length, 250); assert.equal(gets, 3); assert.equal(first.complete, true)
      total = 252; gets = 0
      const next = await factoryGetMessages(key, 'paged-session')
      assert.equal(gets, 1, 'one page, not the whole conversation')
      assert.equal(next.length, 252); assert.equal(next.complete, true)
      assert.deepEqual(next.slice(0, 2).map(m => m.id), ['m0', 'm1'])
      assert.deepEqual(next.slice(-2).map(m => m.id), ['m250', 'm251'], 'oldest-first order with the new messages last')
      await test('a retried create whose first answer was lost adopts that repository, never a -2 duplicate', async () => {
    const created = []
    let first = true
    const orch = new RealOrchestrator(() => {}, { repoUrl: '', clients: {
      createRepo: async (name) => {
        if (first) { first = false; created.push(name); throw Object.assign(new Error('GitHub unreachable'), { kind: 'network' }) }
        if (created.includes(name)) throw Object.assign(new Error('exists'), { kind: 'exists' })
        created.push(name); return { url: `https://github.com/owner/${name}` }
      },
      findRepo: async (name) => created.includes(name) ? { url: `https://github.com/owner/${name}` } : null,
    } })
    await assert.rejects(() => orch.createRepoWithFallback('habit-log'))
    const adopted = await orch.createRepoWithFallback('habit-log')
    assert.equal(adopted.url, 'https://github.com/owner/habit-log')
    assert.deepEqual(created, ['habit-log'], 'no second repository was created')
  })
} finally { globalThis.fetch = saved }
  })
} finally {
  globalThis.fetch = originalFetch
}
console.log(`Factory adapter: ${passed} passed, ${failed} failed (scenario groups)`)
process.exitCode = failed ? 1 : 0
