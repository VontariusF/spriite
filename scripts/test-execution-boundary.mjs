import assert from 'node:assert/strict'
import { validateScene } from '../src/scenes/validate.ts'
import { COPY } from '../src/factory/copy.ts'
const { RealOrchestrator } = await import(process.env.SPRIITE_EXECUTION_ENGINE ?? '../src/factory/real.ts')

// The production liveClients -> fapi -> fetch path, not fakeClients.
// All HTTP responses are synthetic. No credentials, network, or real work.
const originalFetch = globalThis.fetch
let passed = 0
let failed = 0
async function test(name, run) {
  try { await run(); passed++; console.log(`PASS: ${name}`) }
  catch (error) { failed++; console.error(`FAIL: ${name}\n${error.stack}`) }
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)) }

function harness({ jobs = 1, newestFirst = true } = {}) {
  const sessions = new Map()
  const creates = []
  const posts = []
  const statuses = new Map()
  const readErrors = new Map()
  const statusHttpErrors = new Map()
  const messageHttpErrors = new Map()
  const postHttpErrors = new Map()
  // Independently observed GitHub resources; model messages cannot create them.
  const baseSha = 'b'.repeat(40)
  const branches = new Map([['main', baseSha]])
  const pulls = new Map()
  const publishBranch = (branch, sha = 'a'.repeat(40)) => { branches.set(branch, sha); return sha }
  const publishPull = (number, branch) => {
    assert.ok(branches.has(branch), 'publish only an independently recorded branch')
    pulls.set(number, { state: 'open',
      head: { ref: branch, sha: branches.get(branch), repo: { full_name: 'example/fixture' } },
      base: { ref: 'main', sha: baseSha, repo: { full_name: 'example/fixture' } } })
  }
  let sequence = 0
  let nextPostGate = null
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.origin === 'https://api.github.com') {
      assert.equal(init.method, 'GET', 'artifact verification must never write GitHub')
      const path = decodeURIComponent(url.pathname)
      if (path === '/repos/example/fixture') return Response.json({ id: 9001, full_name: 'example/fixture', default_branch: 'main' })
      if (path.startsWith('/repos/example/fixture/branches/')) {
        const ref = path.slice('/repos/example/fixture/branches/'.length)
        return branches.has(ref) ? Response.json({ commit: { sha: branches.get(ref) } }) : new Response(null, { status: 404 })
      }
      if (path.startsWith('/repos/example/fixture/compare/')) {
        const [base, head] = path.split('/').at(-1).split('...')
        assert.equal(base, baseSha)
        assert.ok([...branches.values()].includes(head))
        return Response.json({ status: 'ahead', ahead_by: 1,
          files: [{ filename: 'clock.ts' }], merge_base_commit: { sha: baseSha } })
      }
      const pull = /^\/repos\/example\/fixture\/pulls\/(\d+)$/.exec(path)
      assert.ok(pull, `Unexpected GitHub read: ${path}`)
      return pulls.has(Number(pull[1])) ? Response.json(pulls.get(Number(pull[1]))) : new Response(null, { status: 404 })
    }
    assert.equal(url.origin, 'https://api.factory.ai')
    const body = init.body ? JSON.parse(init.body) : null
    const path = url.pathname
    if (path === '/api/v0/computers') return Response.json({ computers: [{ id: 'fixture-computer', status: 'active' }] })
    if (path === '/api/v0/sessions' && init.method === 'POST') {
      const id = `fixture-session-${creates.length}`
      creates.push(body)
      sessions.set(id, [])
      return Response.json({ sessionId: id }, { status: 201 })
    }
    const match = /^\/api\/v0\/sessions\/([^/]+)(\/messages)?$/.exec(path)
    assert.ok(match, `Unexpected endpoint: ${path}`)
    const id = match[1]
    const messages = sessions.get(id)
    assert.ok(messages)
    if (!match[2]) {
      if (statusHttpErrors.has(id)) return new Response('Gateway timeout', { status: statusHttpErrors.get(id) })
      if (readErrors.has(id)) throw readErrors.get(id)
      return Response.json({ sessionId: id, status: statuses.has(id) ? statuses.get(id) : 'idle', messageCount: messages.length })
    }
    if (init.method === 'POST') {
      posts.push({ id, text: body.text })
      if (postHttpErrors.get(id)?.accepted !== false) {
        messages.push({ id: `message-${++sequence}`, role: 'user', createdAt: 1791750000000 + sequence, content: [{ type: 'text', text: body.text }] })
      }
      if (postHttpErrors.has(id)) return new Response('Gateway timeout', { status: postHttpErrors.get(id).status })
      const gate = nextPostGate
      nextPostGate = null
      if (gate) await gate
      return Response.json({ messageId: `ack-${sequence}`, status: 'pending' })
    }
    if (messageHttpErrors.has(id)) return new Response('Gateway timeout', { status: messageHttpErrors.get(id) })
    return Response.json({ messages: newestFirst ? [...messages].reverse() : messages, pagination: { hasMore: false, nextCursor: null } })
  }
  const engine = new RealOrchestrator(() => {}, {
    factoryKey: 'synthetic-key',
    repoUrl: 'https://github.com/example/fixture',
    computerId: 'fixture-computer',
    workerPref: 'factory',
    jobs,
    askBeforePr: true,
    settings: { interactionMode: 'spec', leadAutonomyLevel: 'low' },
  })
  const rawReply = (id, content, role = 'assistant') => sessions.get(id).push({
    id: `message-${++sequence}`, role, createdAt: 1791750000000 + sequence, content,
  })
  const reply = (id, text) => rawReply(id, [{ type: 'text', text }])
  async function plan() {
    engine.voiceGoal('Implement a clock with a unit test', 3)
    engine.handleAction('start_planning')
    await settle()
    assert.equal(creates.length, 1)
    reply(engine.snapshot().sessionId, '1. Implement clock\n2. Test clock\nPLAN_READY')
    await engine.pollLead()
    assert.equal(engine.snapshot().planLabels.length, 2)
  }
  async function begin() {
    engine.handleAction('begin')
    assert.equal(engine.snapshot().decisionGate, true)
    engine.handleAction('use_it')
    await settle()
    assert.equal(creates.length, jobs + 1, 'confirmation actually creates the requested workers')
    assert.equal(posts.filter((p) => p.id === engine.snapshot().jobs[0].sessionId).length, 1)
  }
  function holdNextPost() {
    let release
    nextPostGate = new Promise((resolve) => { release = resolve })
    return release
  }
  return { engine, creates, posts, sessions, statuses, readErrors, statusHttpErrors, messageHttpErrors, postHttpErrors,
    reply, rawReply, plan, begin, holdNextPost, publishBranch, publishPull, baseSha }
}

async function unfinishedPlan(h) {
  await h.plan()
  // This fixture really is unfinished upstream, not a complete canonical
  // plan hidden only by a stale local snapshot. The latter should be reviewed.
  h.sessions.get(h.engine.snapshot().sessionId).pop()
  const snapshot = h.engine.snapshot()
  Object.assign(snapshot, { phase: 'plan', awaiting: 'plan', planLabels: [], activityStatus: 'running' })
  h.engine.restore(snapshot)
  h.engine.boot()
  return snapshot.sessionId
}

try {
  await test('the exact X plan with an inline marker is reviewed, never auto-approved, and launches one owned worker', async () => {
    const h = harness()
    h.engine.voiceGoal('spin this up\nContext captured from X. Reference only: https://github.com/example/plexo/ (not opened).', 3)
    h.engine.handleAction('start_planning')
    await settle()
    const sid = h.engine.snapshot().sessionId
    const plan = [
      'Assess - Plexo requirements and Spriite integration points are documented',
      'Integrate - Plexo runs within the Spriite repository using configurable connections',
      'Validate - Multi-connection downloads pass functional and failure-recovery tests',
      'Launch - Setup, operation, and deployment instructions are verified PLAN_READY',
    ].join('\n')
    h.reply(sid, plan)
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().awaiting, 'plan')
    assert.equal(h.engine.snapshot().planLabels.length, 0, 'misplaced marker cannot complete the automatic plan protocol')
    assert.ok(h.engine.currentView.scene.actions.some(a => a.id === 'review_chat_build'))
    const before = h.posts.length
    h.engine.handleAction('review_chat_build')
    await settle()
    assert.equal(h.creates.length, 1)
    assert.equal(h.posts.length, before, 'review performs no planning refresh or execution POST')
    assert.equal(h.engine.snapshot().buildDraft.plan.length, 4)
    assert.ok(!h.engine.snapshot().buildDraft.plan.at(-1).includes('PLAN_READY'))
    h.engine.handleAction('confirm_chat_build')
    await settle()
    assert.equal(h.creates.length, 2, 'owned coordinator is reused and only one worker is created')
    assert.match(h.posts.at(-1).text, /execution worker/)
    assert.match(h.posts.at(-1).text, /example\/plexo/)
    assert.match(h.posts.at(-1).text, /https:\/\/github.com\/example\/fixture/)
    assert.match(h.posts.at(-1).text, /Multi-connection downloads pass functional and failure-recovery tests/)
    assert.match(h.posts.at(-1).text, /Implement it/)
  })
  await test('a managed markerless plan executes only after explicit scope review, without another planning message', async () => {
    const h = harness()
    const sid = await unfinishedPlan(h)
    const plan = 'Capture - done means clock behavior is recorded.\nImplement - done means the clock runs.\nVerify - done means the unit test passes.'
    h.reply(sid, plan)
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().planLabels.length, 0, 'markerless output still cannot auto-complete the plan protocol')
    h.engine.handleAction('begin')
    await settle()
    assert.equal(h.creates.length, 1)
    const before = h.posts.length
    assert.equal(h.engine.say('Build it'), 'steer')
    await settle()
    assert.ok(h.engine.currentView.scene.actions.some(a => a.id === 'confirm_chat_build'))
    assert.equal(h.posts.length, before, 'scope review is not another Continue/plan request')
    assert.deepEqual(validateScene(h.engine.currentView.scene, 'engine'), [])
    h.engine.handleAction('confirm_chat_build')
    h.engine.handleAction('confirm_chat_build')
    await settle()
    assert.equal(h.creates.length, 2, 'existing lead is reused and one execution worker is created')
    const worker = h.engine.snapshot().jobs[0]
    assert.ok(worker.sessionId)
    assert.match(h.posts.at(-1).text, /execution worker/)
    assert.ok(h.posts.at(-1).text.includes(plan))
    assert.equal(h.posts.filter(p => p.id === sid).length, before, 'the planning-only lead was not told to build')
    const snapshot = JSON.parse(JSON.stringify(h.engine.snapshot()))
    h.engine.restore(snapshot)
    assert.deepEqual(h.engine.snapshot().approvedPlan, plan.split('\n'), 'approved criteria survive owned execution restore')
    h.engine.handleAction('confirm_chat_build')
    await settle()
    assert.equal(h.creates.length, 2, 'stale confirmation cannot duplicate a restored worker')
  })
  await test('an idle existing chat offers Continue and Send message without sending on open', async () => {
    const h = harness()
    const id = await unfinishedPlan(h)
    await h.engine.pollLead()
    const actions = h.engine.currentView.scene.actions
    assert.deepEqual(actions.map(a => a.label), ['Continue', 'Send message', 'History'])
    assert.deepEqual(validateScene(h.engine.currentView.scene, 'engine'), [])
    assert.equal(h.posts.length, 1)
    h.engine.handleAction('continue_session')
    h.engine.handleAction('continue_session')
    await settle()
    assert.equal(h.posts.length, 2, 'a double tap sends one continuation request')
    assert.equal(h.posts.at(-1).id, id)
    assert.match(h.posts.at(-1).text, /Continue/)
    assert.equal(h.engine.snapshot().awaiting, 'plan', 'continuation keeps the existing result protocol')
    assert.equal(h.creates.length, 1, 'Continue reuses the chat, not a new session')
    assert.equal(h.creates[0].sessionSettings.autonomyLevel, 'low')
    assert.equal(h.engine.progress().acceptedWeight, 0)
  })
  await test('Continue is unavailable while active, queued, unknown, paused, or awaiting an answer', async () => {
    const h = harness()
    const id = await unfinishedPlan(h)
    for (const status of ['running', 'pending', null]) {
      h.statuses.set(id, status)
      await h.engine.pollLead()
      assert.ok(h.engine.currentView.scene.actions.some(a => a.label === 'Send message'))
      assert.ok(!h.engine.currentView.scene.actions.some(a => a.id === 'continue_session'))
      h.engine.handleAction('continue_session')
      await settle()
      assert.equal(h.posts.length, 1, 'a stale continuation action cannot start another turn')
    }
    h.statuses.set(id, 'idle')
    await h.engine.pollLead()
    h.engine.paused = true
    h.engine.handleAction('continue_session')
    h.engine.paused = false
    h.engine.decisionPending = true
    h.engine.handleAction('continue_session')
    await settle()
    assert.equal(h.posts.length, 1, 'Continue never bypasses a pause or answers a question')
  })
  await test('an unacknowledged Continue request is labelled unconfirmed rather than sent', async () => {
    const h = harness()
    await unfinishedPlan(h)
    await h.engine.pollLead()
    h.engine.clients.postMessage = async () => { throw Object.assign(new Error('Synthetic lost acknowledgement'), { kind: 'network' }) }
    h.engine.handleAction('continue_session')
    await settle()
    assert.equal(h.engine.snapshot().pendingLeadPosts.length, 0)
    assert.ok(h.engine.snapshot().pendingLeadDelivery)
    assert.match(h.engine.currentView.scene.status, /Delivery unconfirmed/i)
    assert.doesNotMatch(h.engine.currentView.scene.status, /Sent to Factory/)
  })
  await test('504 status or history reads keep observing instead of faulting a live chat', async () => {
    for (const slot of ['statusHttpErrors', 'messageHttpErrors']) {
      const h = harness()
      const id = await unfinishedPlan(h)
      await h.engine.pollLead()
      h[slot].set(id, 504)
      await h.engine.pollLead()
      assert.equal(h.engine.snapshot().faultKind, null)
      assert.match(h.engine.currentView.scene.status, /unconfirmed/i)
      h[slot].clear()
      h.reply(id, '1. Scope - confirm requirements\n2. Build - implement behavior\n3. Validate - tests pass\nPLAN_READY')
      await h.engine.pollLead()
      assert.equal(h.engine.snapshot().awaiting, null)
      assert.equal(h.engine.snapshot().jobs.length, 0)
      assert.equal(h.posts.length, 1)
    }
  })
  await test('a delivered Continue with 504 is reconciled by new user-message evidence without resending', async () => {
    const h = harness()
    const id = await unfinishedPlan(h)
    await h.engine.pollLead()
    h.postHttpErrors.set(id, { status: 504, accepted: true })
    h.engine.handleAction('continue_session')
    await settle()
    assert.equal(h.engine.snapshot().faultKind, null)
    assert.ok(h.engine.snapshot().pendingLeadDelivery)
    assert.match(h.engine.currentView.scene.status, /Delivery unconfirmed/)
    assert.deepEqual(validateScene(h.engine.currentView.scene, 'engine'), [])
    h.engine.handleAction('continue_session')
    h.engine.handleAction('retry')
    await settle()
    assert.equal(h.posts.length, 2)
    h.reply(id, '1. Scope - confirm requirements\n2. Build - implement behavior\n3. Validate - tests pass\nPLAN_READY')
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().pendingLeadDelivery, null)
    assert.equal(h.engine.snapshot().awaiting, null)
    assert.equal(h.engine.snapshot().jobs.length, 0)
    assert.equal(h.engine.progress().acceptedWeight, 0)
    h.engine.tick(h.engine.nowMs + 3000)
    await settle()
    assert.equal(h.posts.length, 2)
  })
  await test('unconfirmed Continue survives restore and cannot use an older identical message as receipt', async () => {
    const h = harness()
    const id = await unfinishedPlan(h)
    const text = 'Continue the current conversation from where it stopped, using the requested reply format. Keep the agreed scope and permissions. If blocked, tell me what you need.'
    h.rawReply(id, [{ type: 'text', text }], 'user')
    await h.engine.pollLead()
    h.postHttpErrors.set(id, { status: 504, accepted: false })
    h.engine.handleAction('continue_session')
    await settle()
    const saved = h.engine.snapshot()
    assert.ok(saved.pendingLeadDelivery)
    h.engine.restore(saved)
    h.engine.boot()
    await h.engine.pollLead()
    assert.ok(h.engine.snapshot().pendingLeadDelivery)
    assert.equal(h.engine.followupReady, false)
    assert.ok(h.engine.factorySessionLink().endsWith(`/sessions/${id}`))
    h.engine.tick(h.engine.nowMs + 10000)
    await settle()
    h.engine.handleAction('continue_session')
    h.engine.handleAction('retry')
    await settle()
    assert.equal(h.posts.length, 2)
    assert.equal(h.engine.snapshot().jobs.length, 0)
  })
  await test('Continue refreshes only a managed legacy plan and still requires build approval', async () => {
    const h = harness()
    const id = await unfinishedPlan(h)
    const saved = h.engine.snapshot()
    saved.planProtocol = 'legacy'
    h.engine.restore(saved)
    await h.engine.pollLead()
    assert.ok(h.engine.currentView.scene.actions.some(a => a.id === 'continue_session'),
      'a confirmed-idle managed legacy chat exposes Continue on the actual card')
    h.engine.handleAction('continue_session')
    await settle()
    assert.equal(h.posts.at(-1).id, id)
    assert.match(h.posts.at(-1).text, /final line exactly PLAN_READY/)
    assert.equal(h.engine.snapshot().planProtocol, 'marker-v1')
    h.reply(id, 'Scope - confirm requirements\nBuild - implement behavior\nValidate - tests pass')
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().awaiting, 'plan')
    h.reply(id, '1. Scope - confirm requirements\n2. Build - implement behavior\n3. Validate - tests pass\nPLAN_READY')
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().awaiting, null)
    assert.equal(h.creates.length, 1)
    h.engine.handleAction('begin')
    assert.equal(h.engine.snapshot().decisionGate, true)
    assert.equal(h.creates.length, 1)
  })
  await test('old 504 fault snapshots recover reads without replaying an unconfirmed Continue', async () => {
    for (const retry of [null, 'steer']) {
      const h = harness()
      const id = await unfinishedPlan(h)
      const saved = h.engine.snapshot()
      Object.assign(saved, { faultKind: 'service', faultSource: 'factory', faultDetail: 'Factory HTTP 504',
        faultRetry: retry, lastSteer: 'Synthetic old continuation' })
      h.engine.restore(saved)
      h.engine.boot()
      assert.equal(h.engine.snapshot().faultKind, null)
      await h.engine.pollLead()
      if (retry === 'steer') {
        assert.ok(h.engine.snapshot().pendingLeadDelivery)
        h.engine.handleAction('delivery_seen')
        assert.ok(h.engine.snapshot().pendingLeadDelivery, 'a stale acknowledgment button cannot bypass Resolve')
        h.engine.handleAction('resolve_delivery')
        h.engine.handleAction('delivery_seen')
        assert.equal(h.engine.snapshot().pendingLeadDelivery, null)
        assert.ok(h.engine.chatLog().some(e => e.who === 'you' && e.text.includes('marked this request received')))
      }
      h.engine.tick(h.engine.nowMs + 10000)
      await settle()
      assert.equal(h.posts.length, 1, 'no resumed POST or worker launch')
      assert.equal(h.engine.snapshot().jobs.length, 0)
    }
  })
  await test('restored delivery uncertainty stays conservative with missing evidence and excludes other sessions', async () => {
    const h = harness()
    const id = await unfinishedPlan(h)
    h.rawReply(id, [{ type: 'text', text: COPY.real.continueMessage }], 'user')
    const saved = h.engine.snapshot()
    saved.pendingLeadDelivery = { sessionId: id, text: COPY.real.continueMessage, beforeMessageIds: [17] }
    h.engine.restore(saved)
    assert.equal(h.engine.snapshot().pendingLeadDelivery.beforeMessageIds, null)
    await h.engine.pollLead()
    assert.ok(h.engine.snapshot().pendingLeadDelivery, 'invalid baseline cannot turn an old message into delivery evidence')
    const ready = h.engine.snapshot()
    Object.assign(ready, { awaiting: null, planLabels: ['Scope', 'Build'], paused: true })
    h.engine.restore(ready)
    h.engine.handleAction('resume')
    assert.equal(h.engine.snapshot().paused, false, 'unpausing local control does not resend an unknown request')
    assert.equal(h.engine.beginApproved(), false, 'direct build approval cannot bypass unresolved delivery')
    h.engine.handleAction('begin')
    ready.paused = false
    ready.decisionPending = true
    ready.decisionGate = false
    ready.decisionJob = null
    ready.decisionText = 'Synthetic lead question'
    ready.decisionOptions = ['Keep the scope', 'Clarify']
    h.engine.restore(ready)
    assert.equal(h.engine.say('Keep the scope'), 'none', 'a lead answer cannot bypass the unresolved delivery')
    h.engine.chooseDecisionList(0)
    await settle()
    assert.equal(h.engine.snapshot().decisionPending, true, 'no question is falsely acknowledged')
    assert.equal(h.engine.snapshot().jobs.length, 0)
    saved.pendingLeadDelivery.sessionId = 'a-different-chat'
    h.engine.restore(saved)
    assert.equal(h.engine.snapshot().pendingLeadDelivery, null, 'foreign uncertainty cannot block this session')
    assert.equal(h.posts.length, 1)
  })
  await test('the dispatch baseline includes an older identical Continue arriving since the last poll', async () => {
    const h = harness()
    const id = await unfinishedPlan(h)
    await h.engine.pollLead()
    h.rawReply(id, [{ type: 'text', text: COPY.real.continueMessage }], 'user')
    h.postHttpErrors.set(id, { status: 504, accepted: false })
    h.engine.handleAction('continue_session')
    await settle()
    assert.equal(h.posts.length, 2, 'the owner continuation was actually dispatched')
    assert.ok(h.engine.snapshot().pendingLeadDelivery, 'the lost acknowledgment was held before polling')
    assert.ok(h.engine.currentView.scene.actions.some(a => a.id === 'open_factory'),
      'uncertainty exposes the Factory handoff immediately, without an eight-second note')
    assert.ok(h.engine.snapshot().pendingLeadDelivery.beforeMessageIds.includes(h.sessions.get(id).at(-1).id),
      'the newly observed older message belongs to the pre-dispatch baseline')
    await h.engine.pollLead()
    assert.ok(h.engine.snapshot().pendingLeadDelivery, 'a late older matching ID is baseline evidence, not a receipt')
    assert.equal(h.posts.length, 2)
    assert.equal(h.engine.snapshot().pendingLeadPosts.length, 0)
  })
  await test('a failed pre-send read sends nothing and does not upgrade the legacy protocol', async () => {
    const h = harness()
    const id = await unfinishedPlan(h)
    const saved = h.engine.snapshot()
    saved.planProtocol = 'legacy'
    h.engine.restore(saved)
    await h.engine.pollLead()
    h.messageHttpErrors.set(id, 504)
    h.engine.handleAction('continue_session')
    await settle()
    assert.equal(h.posts.length, 1)
    assert.equal(h.engine.snapshot().pendingLeadDelivery, null)
    assert.equal(h.engine.snapshot().planProtocol, 'legacy')
    assert.equal(h.engine.snapshot().faultKind, null)
    assert.ok(h.engine.currentView.scene.utterance.includes('Nothing was sent'))
  })
  await test('ordinary session messages also hold a lost acknowledgment instead of replaying', async () => {
    const h = harness()
    const id = await unfinishedPlan(h)
    const fetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const response = await fetch(input, init)
      if (init?.method === 'POST') throw new TypeError('Synthetic acknowledgment lost')
      return response
    }
    assert.equal(h.engine.steer('Synthetic literal session message'), true)
    await settle()
    assert.ok(h.engine.snapshot().pendingLeadDelivery)
    assert.equal(h.engine.snapshot().pendingLeadPosts.length, 0)
    h.engine.tick(h.engine.nowMs + 10000)
    await settle()
    assert.equal(h.posts.length, 2)
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().pendingLeadDelivery, null)
    assert.equal(h.engine.snapshot().sessionId, id)
  })
  await test('owner can release an unresolved hold without claiming receipt or triggering queued work', async () => {
    const h = harness()
    const id = await unfinishedPlan(h)
    const saved = h.engine.snapshot()
    Object.assign(saved, {
      pendingLeadDelivery: { sessionId: id, text: 'Synthetic request', beforeMessageIds: null },
      pendingLeadPosts: [{ text: 'Synthetic later turn', awaiting: 'steer', soft: true, protectDelivery: true }],
      queuedStart: 'build',
    })
    h.engine.restore(saved)
    h.engine.handleAction('delivery_release')
    assert.ok(h.engine.snapshot().pendingLeadDelivery, 'release requires the Resolve menu, not a stale button')
    h.engine.handleAction('resolve_delivery')
    h.engine.handleAction('delivery_release')
    assert.equal(h.engine.snapshot().pendingLeadDelivery, null)
    assert.equal(h.engine.snapshot().queuedStart, null)
    assert.equal(h.engine.snapshot().pendingLeadPosts.length, 0)
    h.engine.tick(h.engine.nowMs + 10000)
    await settle()
    assert.equal(h.posts.length, 1)
    assert.equal(h.creates.length, 1)
    assert.ok(h.engine.chatLog().some(e => e.who === 'you' && e.text.includes('may still arrive')))
  })
  await test('a native question arriving during the pre-send read blocks Continue without losing its identity', async () => {
    const h = harness()
    const id = await unfinishedPlan(h)
    await h.engine.pollLead()
    h.rawReply(id, [{ type: 'tool_use', id: 'pre-send-native', name: 'AskUser',
      input: { questionnaire: '1. [question] Which platform?\n[topic] Platform\n[option] Web\n[option] CLI' } }])
    h.engine.handleAction('continue_session')
    await settle()
    assert.equal(h.posts.length, 1, 'a newly discovered native question must be answered in Factory, not by Continue')
    assert.equal(h.engine.snapshot().nativeQuestion?.toolId, 'pre-send-native')
    assert.ok(h.engine.nativeQuestionLink().endsWith(`/sessions/${id}`))
    assert.equal(h.engine.snapshot().pendingLeadDelivery, null, 'nothing was dispatched to be uncertain about')
  })
  await test('late continuation acknowledgement or retry cannot cross into another selected chat', async () => {
    for (const fail of [false, true]) {
      const h = harness()
      const id = await unfinishedPlan(h)
      await h.engine.pollLead()
      let release
      const gate = new Promise(resolve => { release = resolve })
      const post = h.engine.clients.postMessage
      h.engine.clients.postMessage = async (...args) => {
        assert.equal(args[0], id)
        await gate
        if (fail) throw Object.assign(new Error('Synthetic lost acknowledgement'), { kind: 'network' })
        return post(...args)
      }
      h.engine.handleAction('continue_session')
      h.engine.detach()
      h.engine.attachFactoryRow({ sessionId: 'another-chat', title: 'Another chat', status: 'idle', computerId: 'fixture-computer', updatedAt: 0 })
      release()
      await settle()
      assert.doesNotMatch(h.engine.currentView.scene.status, /Sent to Factory|Delivery unconfirmed/)
      assert.equal(h.engine.snapshot().pendingLeadPosts.length, 0, 'no retry is queued to the newly selected chat')
      assert.ok(!h.engine.chatLog().some(e => e.who === 'you' && e.text.startsWith('Continue the current conversation')))
    }
  })
  await test('watched idle chats continue the selected chat while watch-only chats refuse', async () => {
    const h = harness()
    await h.plan()
    const id = h.engine.snapshot().sessionId
    const saved = h.engine.snapshot()
    Object.assign(saved, { phase: 'attach', awaiting: null, attach: { source: 'factory', title: 'Old chat',
      sessionId: id, agentId: null, runId: null, runStatus: 'idle', computerId: 'fixture-computer' } })
    h.engine.restore(saved)
    await h.engine.pollLead()
    assert.ok(h.engine.currentView.scene.actions.some(a => a.id === 'continue_session'))
    h.engine.handleAction('continue_session')
    await settle()
    assert.equal(h.posts.at(-1).id, id)
    h.engine.transient = null
    h.engine.attach.computerId = null
    h.engine.boot()
    assert.ok(!h.engine.currentView.scene.actions.some(a => ['continue_session', 'send_message'].includes(a.id)))
    assert.ok(h.engine.currentView.scene.actions.some(a => a.id === 'open_factory'))
    assert.ok(h.engine.factorySessionLink().endsWith(`/sessions/${id}`))
    h.engine.handleAction('open_factory')
    assert.match(h.engine.currentView.scene.utterance, /continue or send a message/)
    assert.deepEqual(validateScene(h.engine.currentView.scene, 'engine'), [])
    const sent = h.posts.length
    h.engine.handleAction('continue_session')
    await settle()
    assert.equal(h.posts.length, sent)
  })
  await test('opening an inactive saved chat checks status without claiming to draft or launching work', async () => {
    const h = harness()
    const id = await unfinishedPlan(h)
    const saved = h.engine.snapshot()
    h.engine.reset()
    h.engine.projectsSource = {
      list: () => [{ goal: saved.goal, status: 'planning', sessionId: id }],
      snapshotFor: () => saved,
    }
    h.engine.chooseList(0)
    assert.match(h.engine.currentView.scene.status, /unconfirmed|checking/i)
    assert.doesNotMatch(h.engine.currentView.scene.utterance, /is drafting|takes a minute/)
    await h.engine.pollLead()
    assert.match(h.engine.currentView.scene.utterance, /idle/i)
    assert.match(h.engine.currentView.scene.status, /idle/i)
    assert.equal(h.engine.currentView.scene.spritePose, 'idle')
    h.engine.handleAction('status')
    assert.match(h.engine.currentView.scene.utterance, /idle/i)
    assert.equal(h.creates.length, 1)
    assert.equal(h.posts.length, 1, 'opening and checking never resend the planning request')
  })
  await test('session activity follows running, queued, idle and missing status, not the saved phase', async () => {
    const h = harness()
    const id = await unfinishedPlan(h)
    for (const [status, expected] of [['running', 'running'], ['pending', 'queued'], ['idle', 'idle'], [null, 'unconfirmed'], ['future-state', 'unconfirmed'], ['running', 'running']]) {
      h.statuses.set(id, status)
      await h.engine.pollLead()
      assert.match(h.engine.currentView.scene.status, new RegExp(expected, 'i'))
      assert.deepEqual(validateScene(h.engine.currentView.scene, 'engine'), [], 'each state fits the glasses scene contract')
      assert.equal(h.engine.snapshot().activityStatus, expected === 'queued' ? 'pending' : expected === 'unconfirmed' ? 'unknown' : expected)
    }
    const saved = h.engine.snapshot()
    h.engine.restore(saved)
    h.engine.boot()
    assert.match(h.engine.currentView.scene.status, /unconfirmed/i, 'persisted active metadata is not current evidence')
    assert.equal(h.posts.length, 1)
  })
  await test('an open Status card cannot mask a newer idle observation', async () => {
    const h = harness()
    const id = await unfinishedPlan(h)
    h.statuses.set(id, 'running')
    await h.engine.pollLead()
    h.engine.handleAction('status')
    assert.match(h.engine.currentView.scene.status, /running/i)
    h.statuses.set(id, 'idle')
    await h.engine.pollLead()
    assert.match(h.engine.currentView.scene.status, /idle/i)
    assert.equal(h.posts.length, 1)
  })
  await test('a completed plan remains ready rather than being described as awaited', async () => {
    const h = harness()
    await h.plan()
    h.engine.handleAction('status')
    assert.match(h.engine.currentView.scene.status, /plan ready/i)
    assert.doesNotMatch(h.engine.currentView.scene.utterance, /awaited|drafting/)
  })
  await test('failed checks and expired observations stop presenting a running session as current', async () => {
    const h = harness()
    const id = await unfinishedPlan(h)
    h.statuses.set(id, 'running')
    await h.engine.pollLead()
    h.readErrors.set(id, new Error('synthetic read failure'))
    await h.engine.pollLead()
    assert.match(h.engine.currentView.scene.status, /unconfirmed/i)
    h.readErrors.delete(id)
    await h.engine.pollLead()
    assert.match(h.engine.currentView.scene.status, /running/i)
    h.engine.pollingLead = true // a hung request must not keep old activity alive
    h.engine.tick(h.engine.nowMs + 10000)
    assert.match(h.engine.currentView.scene.status, /unconfirmed/i)
    assert.equal(h.posts.length, 1)
  })
  await test('idle watched replies are labelled as historical rather than current execution', async () => {
    const h = harness()
    await h.plan()
    const id = h.engine.snapshot().sessionId
    h.reply(id, 'I am drafting the plan now.')
    const saved = h.engine.snapshot()
    Object.assign(saved, { phase: 'attach', awaiting: null, attach: { source: 'factory', title: 'Old chat',
      sessionId: id, agentId: null, runId: null, runStatus: 'running', computerId: 'fixture-computer' } })
    h.engine.restore(saved)
    h.engine.boot()
    assert.match(h.engine.currentView.scene.status, /unconfirmed/i)
    await h.engine.pollLead()
    assert.match(h.engine.currentView.scene.status, /idle/i)
    assert.match(h.engine.currentView.scene.utterance, /Last reply:/)
    assert.equal(h.engine.currentView.scene.spritePose, 'idle')
    assert.equal(h.posts.length, 1)
  })
  await test('an idle worker is visible without treating it as completed or retrying automatically', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    await h.engine.pollJob(h.engine.jobs[0])
    assert.match(h.engine.currentView.scene.status, /idle/i)
    assert.equal(h.engine.currentView.scene.spritePose, 'idle')
    assert.equal(h.engine.snapshot().activityStatus, 'idle')
    assert.equal(h.engine.progress().acceptedWeight, 0)
    assert.equal(h.posts.length, 2)
    await h.engine.runJobPrompt(h.engine.jobs[0], 'An explicitly requested next turn', h.engine.generation)
    h.engine.boot()
    assert.match(h.engine.currentView.scene.status, /unconfirmed/i, 'a new request invalidates the previous idle observation')
  })
  await test('a running worker cannot make an idle reviewer look active', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    h.statuses.set(h.engine.jobs[0].sessionId, 'running')
    await h.engine.pollJob(h.engine.jobs[0])
    h.engine.phase = 'review'
    await h.engine.pollLead()
    h.engine.boot()
    assert.match(h.engine.currentView.scene.status, /idle/i)
    assert.doesNotMatch(h.engine.currentView.scene.utterance, /reviewing.*now/i)
  })
  await test('a watched session drops stale activity and recovers without restarting it', async () => {
    const h = harness()
    await h.plan()
    const id = h.engine.snapshot().sessionId
    const saved = h.engine.snapshot()
    Object.assign(saved, { phase: 'attach', awaiting: null, attach: { source: 'factory', title: 'Old chat',
      sessionId: id, agentId: null, runId: null, runStatus: 'running', computerId: 'fixture-computer' } })
    h.engine.restore(saved)
    h.statuses.set(id, 'running')
    await h.engine.pollLead()
    h.engine.pollingLead = true
    h.engine.tick(h.engine.nowMs + 25000)
    assert.match(h.engine.currentView.scene.status, /unconfirmed/i)
    assert.equal(h.engine.currentView.scene.spritePose, 'reconciling')
    h.engine.pollingLead = false
    h.statuses.set(id, null)
    await h.engine.pollLead()
    assert.match(h.engine.currentView.scene.status, /unconfirmed/i)
    assert.equal(h.engine.currentView.scene.spritePose, 'reconciling')
    h.statuses.set(id, 'idle')
    await h.engine.pollLead()
    assert.match(h.engine.currentView.scene.status, /idle/i)
    assert.equal(h.posts.length, 1)
  })
  await test('a late check from the previous chat cannot mark the newly opened chat running', async () => {
    const h = harness()
    await h.plan()
    let release
    h.engine.clients.getSession = () => new Promise((resolve) => { release = resolve })
    const checking = h.engine.pollLead()
    h.engine.detach()
    h.engine.attachFactoryRow({ sessionId: 'another-chat', title: 'Inactive chat', status: 'idle', computerId: 'fixture-computer', updatedAt: 0 })
    release({ messageCount: 0, status: 'running' })
    await checking
    assert.match(h.engine.currentView.scene.status, /idle/i)
    assert.equal(h.posts.length, 1)
  })
  await test('switching saved chats loads only selected context and retains local unsent history on return', async () => {
    const h = harness()
    for (const id of ['context-a', 'context-b']) {
      h.sessions.set(id, [])
      h.reply(id, `History for ${id}. HISTORY END`)
    }
    const open = id => {
      h.engine.leaveWatch()
      h.engine.attachFactoryRow({ sessionId: id, title: id, status: 'idle', computerId: 'fixture-computer', updatedAt: 0 })
    }
    open('context-a')
    await h.engine.pollLead()
    assert.ok(h.engine.chatLog().some(e => e.text.includes('History for context-a')))
    h.engine.chat('you', 'Local unconfirmed message for context-a')
    open('context-b')
    assert.ok(!h.engine.chatLog().some(e => e.text.includes('context-a')), 'old context disappears before the new fetch')
    await h.engine.pollLead()
    assert.ok(h.engine.chatLog().some(e => e.text.includes('History for context-b')))
    assert.ok(!h.engine.chatLog().some(e => e.text.includes('context-a')))
    open('context-a')
    await h.engine.pollLead()
    assert.ok(h.engine.chatLog().some(e => e.text.includes('Local unconfirmed message for context-a')))
    assert.ok(!h.engine.chatLog().some(e => e.text.includes('context-b')))
    assert.equal(h.creates.length, 0)
    assert.equal(h.posts.length, 0)
    h.engine.leaveWatch()
    h.engine.attachCursorRow({ agentId: 'other-agent', runId: null, title: 'Cursor context', status: 'IDLE', updatedAt: 0 })
    assert.equal(h.engine.chatLog().length, 0, 'Cursor selection never carries Factory context')
  })
  await test('a pending history read cannot block the next chat or reappear after returning to the first chat', async () => {
    const h = harness()
    for (const id of ['slow-chat', 'next-chat']) {
      h.sessions.set(id, [])
      h.reply(id, `Selected history: ${id}`)
    }
    const open = id => {
      h.engine.leaveWatch()
      h.engine.attachFactoryRow({ sessionId: id, title: id, status: 'idle', computerId: 'fixture-computer', updatedAt: 0 })
    }
    const getMessages = h.engine.clients.getMessages
    let release
    h.engine.clients.getMessages = (id, computer) => id === 'slow-chat'
      ? new Promise(resolve => { release = resolve })
      : getMessages(id, computer)
    open('slow-chat')
    const prior = h.engine.pollLead()
    await settle()
    open('next-chat')
    await h.engine.pollLead()
    assert.ok(h.engine.chatLog().some(e => e.text.includes('Selected history: next-chat')),
      'new context loads without waiting for the old request')
    open('slow-chat')
    h.engine.clients.getMessages = getMessages
    await h.engine.pollLead()
    release([{ id: 'stale-result', role: 'assistant', text: 'Stale prior selection context' }])
    await prior
    assert.ok(h.engine.chatLog().some(e => e.text.includes('Selected history: slow-chat')))
    assert.ok(!h.engine.chatLog().some(e => e.text.includes('Stale prior selection context')))
    assert.equal(h.posts.length, 0)
  })
  await test('a restored idle Cursor watch without a run recovers from fresh agent metadata', async () => {
    const h = harness()
    const saved = h.engine.snapshot()
    Object.assign(saved, { phase: 'attach', attach: { source: 'cursor', title: 'Idle agent',
      sessionId: null, agentId: 'idle-agent', runId: null, runStatus: 'ACTIVE' } })
    h.engine.restore(saved)
    h.engine.clients.listCursorAgents = async () => [{ agentId: 'idle-agent', status: 'IDLE', latestRunId: null }]
    await h.engine.checkAttachLatestRun()
    h.engine.boot()
    assert.match(h.engine.currentView.scene.status, /idle/i)
    assert.equal(h.engine.currentView.scene.spritePose, 'idle')
    assert.equal(h.posts.length, 0)
  })
  await test('native worker questions arrive but never pretend text POST answers them', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    const id = h.engine.jobs[0].sessionId
    h.rawReply(id, [{ type: 'tool_use', id: 'native-question-call', name: 'AskUser',
      input: { questionnaire: `1. [question] Which store?\n[topic] Store\n[option] Postgres\n[option] SQLite\n${'Full context. '.repeat(50)}\nQUESTION END` } }])
    await h.engine.pollJob(h.engine.jobs[0])
    assert.equal(h.engine.hasPendingDecision, true)
    assert.match(h.engine.currentView.scene.status, /Answer in Factory/)
    assert.ok(h.engine.chatLog().some(e => e.text.includes('QUESTION END')))
    assert.ok(h.engine.nativeQuestionLink().endsWith(`/sessions/${id}`))
    const count = h.posts.length
    assert.equal(h.engine.say('Postgres'), 'none')
    h.engine.handleAction('use_it')
    assert.equal(h.posts.length, count, 'native answers are not sent as ineffective steering')
    assert.equal(h.engine.hasPendingDecision, true)
    const snapshot = JSON.parse(JSON.stringify(h.engine.snapshot()))
    h.engine.restore(snapshot)
    assert.equal(h.engine.hasPendingDecision, true)
    assert.ok(h.engine.nativeQuestionLink().endsWith(`/sessions/${id}`))
    h.rawReply(id, [{ type: 'tool_result', tool_use_id: 'native-question-call', content: 'Selected Postgres' }], 'tool')
    await h.engine.pollJob(h.engine.jobs[0])
    assert.equal(h.engine.hasPendingDecision, false, 'only the matching tool result closes the question')
    assert.equal(h.engine.nativeQuestionLink(), null)
  })
  await test('a native lead question appears without an assistant text block', async () => {
    const h = harness()
    await h.plan()
    const id = h.engine.snapshot().sessionId
    h.rawReply(id, [{ type: 'tool_use', id: 'lead-native-call', name: 'AskUser', input: { questionnaire: '1. [question] Which platform?\n[topic] Platform\n[option] Web\n[option] CLI' } }])
    await h.engine.pollLead()
    assert.equal(h.engine.hasPendingDecision, true)
    assert.match(h.engine.currentView.scene.status, /Answer in Factory/)
    assert.equal(h.engine.progress().acceptedWeight, 0)
  })
  await test('ordinary worker replies are kept in full without granting completion', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    const text = `Repository inspection is underway.\n\n${'A readable implementation detail. '.repeat(40)}\nEND OF REPLY`
    h.reply(h.engine.jobs[0].sessionId, text)
    await h.engine.pollJob(h.engine.jobs[0])
    assert.ok(h.engine.chatLog().some(e => e.who === 'worker' && e.text.includes('END OF REPLY')))
    assert.equal(h.engine.progress().acceptedWeight, 0)
    assert.equal(h.engine.jobs[0].state, 'building')
    assert.equal(h.posts.length, 2)
  })
  await test('watch priming seeds the full latest response and fingerprints streamed revisions', async () => {
    const h = harness()
    await h.plan()
    const id = h.engine.snapshot().sessionId
    const initial = `First paragraph.\n\n${'Useful detail. '.repeat(50)}\nOLD END`
    h.reply(id, initial)
    const message = h.sessions.get(id).at(-1)
    const snapshot = h.engine.snapshot()
    snapshot.phase = 'attach'
    snapshot.awaiting = null
    snapshot.attach = { source: 'factory', title: 'A watched build', sessionId: id, agentId: null, runId: null,
      runStatus: 'idle', computerId: 'fixture-computer' }
    h.engine.restore(snapshot)
    await h.engine.pollLead()
    assert.ok(h.engine.chatLog().some(e => e.text.includes('OLD END')))
    message.content = [{ type: 'text', text: initial.replace('OLD END', 'NEW END') }]
    await h.engine.pollLead()
    assert.ok(h.engine.chatLog().some(e => e.text.includes('NEW END')), 'same-count edits are delivered on the next poll')
    assert.equal(h.posts.length, 1, 'watching does not send anything')
  })
  await test('a generated plan is not verified implementation progress', async () => {
    const h = harness()
    await h.plan()
    assert.equal(h.engine.progress().acceptedWeight, 0)
    await h.begin()
    assert.equal(h.engine.progress().acceptedWeight, 0, 'request acknowledgment is not completed work')
  })
  await test('approved Factory worker receives executable mode without escalating chosen autonomy', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    assert.equal(h.creates[0].sessionSettings.interactionMode, 'spec')
    assert.equal(h.creates[1].sessionSettings.interactionMode, 'auto')
    assert.equal(h.creates[1].sessionSettings.autonomyLevel, 'low')
  })
  await test('a worker question surfaces and its answer reaches that worker, not the lead', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    const job = h.engine.jobs[0]
    h.reply(job.sessionId, 'DECISION: Which clock format?\nOPTIONS: Twelve hour | Twenty four hour')
    await h.engine.pollJob(job)
    assert.equal(h.engine.snapshot().decisionPending, true)
    assert.equal(h.engine.snapshot().decisionJob, 0)
    const leadPosts = h.posts.filter((p) => p.id === h.engine.snapshot().sessionId).length
    h.engine.chooseDecisionList(1)
    await settle()
    assert.equal(h.posts.at(-1).id, job.sessionId)
    assert.ok(h.posts.at(-1).text.includes('Twenty four hour'))
    assert.ok(h.posts.at(-1).text.includes(job.requestToken), 'answer preserves the awaited result protocol')
    assert.equal(h.posts.filter((p) => p.id === h.engine.snapshot().sessionId).length, leadPosts)
    assert.equal(h.creates.length, 2, 'answer does not create a replacement worker')
    assert.equal(h.engine.progress().acceptedWeight, 0)
  })
  await test('a restored worker question retains its answer destination', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    const job = h.engine.jobs[0]
    h.reply(job.sessionId, 'DECISION: Include seconds?\nOPTIONS: Yes | No')
    await h.engine.pollJob(job)
    const snapshot = JSON.parse(JSON.stringify(h.engine.snapshot()))
    h.engine.restore(snapshot)
    assert.equal(h.engine.snapshot().decisionJob, 0)
    h.engine.handleAction('use_it')
    await settle()
    assert.equal(h.posts.at(-1).id, job.sessionId)
    assert.equal(h.creates.length, 2)
  })
  await test('a completed refreshed plan retires its superseded lead question', async () => {
    const h = harness()
    await h.plan()
    h.engine.awaiting = 'plan'
    h.engine.handleReply('DECISION: Should I use the updated scope?\nOPTIONS: Yes | No')
    assert.equal(h.engine.snapshot().decisionPending, true)
    h.engine.handleReply('1. Implement updated clock\n2. Test updated clock\nPLAN_READY')
    assert.equal(h.engine.snapshot().decisionPending, false)
    assert.equal(h.engine.progress().acceptedWeight, 0)
    await h.begin()
  })
  await test('upgrading an old snapshot re-observes a previously swallowed worker question', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    const job = h.engine.jobs[0]
    h.reply(job.sessionId, 'DECISION: Include seconds?\nOPTIONS: Yes | No')
    await h.engine.pollJob(job)
    const snapshot = JSON.parse(JSON.stringify(h.engine.snapshot()))
    delete snapshot.workerQuestionsRouted
    delete snapshot.decisionJob
    delete snapshot.jobs[0].question
    snapshot.decisionPending = false
    h.engine.restore(snapshot)
    await h.engine.pollJob(h.engine.jobs[0])
    assert.equal(h.engine.snapshot().decisionPending, true)
    assert.equal(h.engine.snapshot().decisionJob, 0)
    h.engine.handleAction('use_it')
    await settle()
    assert.equal(h.posts.at(-1).id, job.sessionId)
    assert.equal(h.creates.length, 2)
  })
  await test('worker tool activity is observed but never counted as verified completion', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    const job = h.engine.jobs[0]
    h.statuses.set(job.sessionId, 'running')
    h.sessions.get(job.sessionId).push({
      id: 'tool-activity', role: 'assistant', createdAt: 1791750000000 + 100,
      content: [{ type: 'tool_use', name: 'ApplyPatch', input: { patch: 'synthetic' } }],
    })
    await h.engine.pollJob(job)
    assert.equal(h.engine.snapshot().jobs[0].executionObserved, true)
    assert.equal(h.engine.progress().acceptedWeight, 0)
    assert.ok(h.engine.currentView.scene.utterance.includes('activity was observed'))
    h.statuses.set(job.sessionId, 'idle')
    await h.engine.pollJob(job)
    assert.match(h.engine.currentView.scene.status, /idle/i, 'old tools cannot keep the worker labelled active')
  })
  await test('an unrelated lead follow-up cannot silently dismiss a blocked worker question', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    const job = h.engine.jobs[0]
    h.reply(job.sessionId, 'DECISION: Include seconds?\nOPTIONS: Yes | No')
    await h.engine.pollJob(job)
    assert.equal(await h.engine.sendFollowup('Also add a title', () => true), 'sent')
    assert.equal(h.posts.at(-1).id, h.engine.snapshot().sessionId)
    assert.equal(h.engine.snapshot().decisionPending, true)
    assert.equal(h.engine.snapshot().decisionJob, 0)
  })
  await test('a changed worker question replaces the displayed question instead of keeping the old one', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    const job = h.engine.jobs[0]
    h.reply(job.sessionId, 'DECISION: Include seconds?\nOPTIONS: Yes | No')
    await h.engine.pollJob(job)
    h.reply(job.sessionId, 'DECISION: Choose a clock format?\nOPTIONS: Twelve hour | Twenty four hour')
    await h.engine.pollJob(job)
    assert.ok(h.engine.snapshot().decisionText.includes('clock format'))
    h.engine.chooseDecisionList(1)
    await settle()
    assert.ok(h.posts.at(-1).text.includes('Twenty four hour'))
    assert.equal(h.posts.at(-1).id, job.sessionId)
  })
  await test('old saved plan weights do not reintroduce fictitious verified progress', async () => {
    const h = harness()
    await h.plan()
    // A started build's weights (a ready plan counts its own lines instead).
    await h.begin()
    const snapshot = JSON.parse(JSON.stringify(h.engine.snapshot()))
    snapshot.milestones[0].status = 'accepted'
    snapshot.milestones[0].weight = 20
    h.engine.restore(snapshot)
    assert.equal(h.engine.progress().acceptedWeight, 0)
    h.engine.milestones[1].status = 'submitted'
    assert.equal(h.engine.progress().acceptedWeight, 0)
    assert.equal(h.engine.progress().pendingReviewWeight, 81)
    h.engine.milestones[1].status = 'accepted'
    assert.equal(h.engine.progress().acceptedWeight, 81)
  })
  await test('parallel worker questions survive restore and each answer reaches its own session', async () => {
    const h = harness({ jobs: 2 })
    await h.plan()
    await h.begin()
    const [first, second] = h.engine.jobs
    h.reply(first.sessionId, 'DECISION: First clock format?\nOPTIONS: Twelve hour | Twenty four hour')
    h.reply(second.sessionId, 'DECISION: Second test format?\nOPTIONS: Simple | Detailed')
    await h.engine.pollJob(first)
    await h.engine.pollJob(second)
    const snapshot = JSON.parse(JSON.stringify(h.engine.snapshot()))
    assert.equal(snapshot.jobs.filter((job) => job.question).length, 2)
    h.engine.restore(snapshot)
    h.engine.chooseDecisionList(0)
    await settle()
    assert.equal(h.posts.at(-1).id, first.sessionId)
    assert.equal(h.engine.snapshot().decisionJob, 1)
    assert.ok(h.engine.snapshot().decisionText.includes('Second'))
    h.engine.chooseDecisionList(1)
    await settle()
    assert.equal(h.posts.at(-1).id, second.sessionId)
    assert.equal(h.engine.snapshot().decisionPending, false)
    assert.equal(h.creates.length, 3)
    assert.equal(h.engine.progress().acceptedWeight, 0)
  })
  await test('a question naming an older worker request cannot reopen its decision', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    const job = h.engine.jobs[0]
    h.reply(job.sessionId, 'DECISION: Old question?\nOPTIONS: Yes | No\nREQUEST: prior-request')
    await h.engine.pollJob(job)
    assert.equal(h.engine.snapshot().decisionPending, false)
  })
  await test('upgrade recovery ignores questions that precede the current worker request', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    const job = h.engine.jobs[0]
    h.sessions.get(job.sessionId).unshift({
      id: 'old-question', role: 'assistant', createdAt: 1791749999999,
      content: [{ type: 'text', text: 'DECISION: Obsolete question?\nOPTIONS: Yes | No' }],
    })
    const snapshot = JSON.parse(JSON.stringify(h.engine.snapshot()))
    snapshot.jobs[0].seenIds.push('old-question')
    delete snapshot.workerQuestionsRouted
    h.engine.restore(snapshot)
    await h.engine.pollJob(h.engine.jobs[0])
    assert.equal(h.engine.snapshot().decisionPending, false)
    h.reply(job.sessionId, 'DECISION: Current question?\nOPTIONS: Yes | No')
    await h.engine.pollJob(h.engine.jobs[0])
    assert.ok(h.engine.snapshot().decisionText.includes('Current'))
  })
  await test('a completed current worker result retires a question it superseded', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    const job = h.engine.jobs[0]
    h.reply(job.sessionId, 'DECISION: Include seconds?\nOPTIONS: Yes | No')
    await h.engine.pollJob(job)
    assert.equal(h.engine.snapshot().decisionPending, true)
    h.publishBranch('spriite/fixture/job-1')
    h.reply(job.sessionId, `SUMMARY: Clock and tests implemented.\nBRANCH: spriite/fixture/job-1\nREQUEST: ${job.requestToken}\nWORK_READY`)
    await h.engine.pollJob(job)
    assert.equal(h.engine.snapshot().decisionPending, false)
    assert.equal(h.engine.snapshot().jobs[0].question, null)
    assert.equal(h.engine.progress().acceptedWeight, 0)
  })
  await test('a new question arriving before an answer acknowledgment retains its worker destination', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    const job = h.engine.jobs[0]
    h.reply(job.sessionId, 'DECISION: Include seconds?\nOPTIONS: Yes | No')
    await h.engine.pollJob(job)
    const release = h.holdNextPost()
    h.engine.chooseDecisionList(0)
    await settle()
    h.reply(job.sessionId, 'DECISION: Clock format?\nOPTIONS: Twelve hour | Twenty four hour')
    await h.engine.pollJob(job)
    const before = h.posts.length
    h.engine.chooseDecisionList(0)
    await settle()
    assert.equal(h.posts.length, before, 'a busy tap cannot dispatch a second answer')
    release()
    await settle()
    assert.equal(h.engine.snapshot().decisionPending, true)
    assert.equal(h.engine.snapshot().decisionJob, 0)
    h.engine.chooseDecisionList(1)
    await settle()
    assert.equal(h.posts.at(-1).id, job.sessionId)
    assert.ok(h.posts.at(-1).text.includes('Twenty four hour'))
  })
  await test('a queued reviewer question survives restore and surfaces after the worker answer', async () => {
    const h = harness({ jobs: 2 })
    await h.plan()
    await h.begin()
    const [first, second] = h.engine.jobs
    h.publishBranch('spriite/fixture/job-1')
    h.reply(first.sessionId, `SUMMARY: Implemented clock.\nBRANCH: spriite/fixture/job-1\nREQUEST: ${first.requestToken}\nWORK_READY`)
    await h.engine.pollJob(first)
    await settle()
    h.reply(second.sessionId, 'DECISION: Include seconds?\nOPTIONS: Yes | No')
    await h.engine.pollJob(second)
    const lead = h.engine.snapshot().sessionId
    h.reply(lead, `DECISION: Review test scope?\nOPTIONS: Unit only | Unit and integration\nREQUEST: ${h.engine.snapshot().verdictToken}`)
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().decisionJob, 1)
    h.engine.restore(JSON.parse(JSON.stringify(h.engine.snapshot())))
    h.engine.chooseDecisionList(0)
    await settle()
    assert.equal(h.posts.at(-1).id, second.sessionId)
    assert.ok(h.engine.snapshot().decisionText.includes('Review test scope'))
    assert.equal(h.engine.snapshot().decisionJob, null)
    h.engine.chooseDecisionList(1)
    await settle()
    assert.equal(h.posts.at(-1).id, lead)
  })
  await test('a PR-stage worker answer still requests a PR result, not a branch result', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    const job = h.engine.jobs[0]
    job.stage = 'pr'
    job.branch = 'spriite/fixture/job-1'
    job.headSha = h.publishBranch(job.branch)
    job.baseSha = h.baseSha
    h.reply(job.sessionId, 'DECISION: PR title?\nOPTIONS: Short | Detailed')
    await h.engine.pollJob(job)
    h.engine.chooseDecisionList(0)
    await settle()
    assert.ok(h.posts.at(-1).text.includes('PR: <'))
    assert.ok(!h.posts.at(-1).text.includes('BRANCH: <'))
    h.publishPull(1, job.branch)
    h.reply(job.sessionId, `SUMMARY: PR opened.\nPR: https://github.com/example/fixture/pull/1\nREQUEST: ${job.requestToken}\nWORK_READY`)
    await h.engine.pollJob(job)
    await settle()
    assert.equal(h.engine.snapshot().phase, 'final')
  })
  await test('a completed verdict retires its lead question and surfaces a queued worker question', async () => {
    const h = harness({ jobs: 2 })
    await h.plan()
    await h.begin()
    const first = h.engine.jobs[0]
    h.publishBranch('spriite/fixture/job-1')
    h.reply(first.sessionId, `SUMMARY: Clock implemented.\nBRANCH: spriite/fixture/job-1\nREQUEST: ${first.requestToken}\nWORK_READY`)
    await h.engine.pollJob(first)
    await settle()
    const lead = h.engine.snapshot().sessionId
    h.reply(lead, `DECISION: Review test scope?\nOPTIONS: Unit only | Unit and integration\nREQUEST: ${h.engine.snapshot().verdictToken}`)
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().decisionPending, true)
    h.reply(h.engine.jobs[1].sessionId, 'DECISION: Include seconds?\nOPTIONS: Yes | No')
    await h.engine.pollJob(h.engine.jobs[1])
    assert.equal(h.engine.snapshot().decisionJob, null)
    h.reply(lead, `VERDICT: PASS Diff reviewed.\nREQUEST: ${h.engine.snapshot().verdictToken}\nVERDICT_READY`)
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().decisionPending, true)
    assert.equal(h.engine.snapshot().decisionJob, 1)
    assert.ok(h.engine.snapshot().decisionText.includes('seconds'))
  })
  await test('an ordinary lead follow-up cannot strand a queued worker question', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    const job = h.engine.jobs[0]
    const lead = h.engine.snapshot().sessionId
    h.reply(lead, 'DECISION: Preferred title?\nOPTIONS: Short | Detailed')
    await h.engine.pollLead()
    h.reply(job.sessionId, 'DECISION: Include seconds?\nOPTIONS: Yes | No')
    await h.engine.pollJob(job)
    assert.equal(h.engine.snapshot().decisionJob, null)
    assert.equal(await h.engine.sendFollowup('Use the title Clock', () => true), 'sent')
    assert.equal(h.posts.at(-1).id, lead)
    assert.equal(h.engine.snapshot().decisionPending, true)
    assert.equal(h.engine.snapshot().decisionJob, 0)
  })
  await test('a correlated worker question does not leak its request token into the options', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    const job = h.engine.jobs[0]
    h.reply(job.sessionId, `DECISION: Include seconds?\nOPTIONS: Yes | No\nREQUEST: ${job.requestToken}`)
    await h.engine.pollJob(job)
    assert.deepEqual(h.engine.snapshot().decisionOptions, ['Yes', 'No'])
  })
  await test('upgrade recovers a question consumed by the 0.2.21 ordering filter', async () => {
    const h = harness()
    await h.plan()
    await h.begin()
    const job = h.engine.jobs[0]
    const question = 'DECISION: Include seconds?\nOPTIONS: Yes | No'
    h.reply(job.sessionId, question)
    const message = h.sessions.get(job.sessionId).at(-1)
    const snapshot = JSON.parse(JSON.stringify(h.engine.snapshot()))
    snapshot.workerQuestionsRouted = true
    delete snapshot.workerChronologyFixed
    snapshot.jobs[0].seenIds = [`text:${JSON.stringify(message.id)}:${JSON.stringify(question)}`]
    h.engine.restore(snapshot)
    await h.engine.pollJob(h.engine.jobs[0])
    assert.equal(h.engine.snapshot().decisionPending, true)
    assert.equal(h.engine.snapshot().decisionJob, 0)
    assert.equal(h.creates.length, 2, 'recovery does not restart the worker')
    assert.equal(h.posts.length, 2, 'recovery does not answer or resend anything')
  })
  await test('production worker gateway uncertainty holds execution across ticks and restore', async () => {
    for (const accepted of [false, true]) {
      const h = harness()
      await h.plan()
      h.postHttpErrors.set('fixture-session-1', { status: 504, accepted })
      await h.begin()
      assert.ok(h.engine.hasUnconfirmedDelivery)
      assert.equal(h.engine.snapshot().jobs[0].pendingPrompt, null)
      h.engine.restore(JSON.parse(JSON.stringify(h.engine.snapshot())))
      h.engine.boot()
      assert.ok(h.engine.hasUnconfirmedDelivery, 'saved execution is held before fresh receipt observation')
      h.engine.tick(h.engine.nowMs + 3000)
      await settle()
      assert.equal(h.posts.length, 2, 'the received or unreceived instruction is never guessed unsent')
      assert.equal(h.engine.hasUnconfirmedDelivery, !accepted)
      assert.equal(h.creates.length, 2)
    }
  })
  await test('production lead decision gateway uncertainty holds the explicit choice', async () => {
    const h = harness()
    const sid = await unfinishedPlan(h)
    h.reply(sid, 'DECISION: Which platform?\nOPTIONS: Web | CLI')
    await h.engine.pollLead()
    h.postHttpErrors.set(sid, { status: 504, accepted: false })
    assert.equal(h.engine.say('CLI'), 'decision')
    await settle()
    assert.ok(h.engine.hasUnconfirmedDelivery)
    h.engine.restore(JSON.parse(JSON.stringify(h.engine.snapshot())))
    h.engine.tick(h.engine.nowMs + 3000)
    await settle()
    assert.ok(h.engine.hasUnconfirmedDelivery)
    assert.equal(h.posts.length, 2)
    assert.equal(h.creates.length, 1)
  })
} finally {
  globalThis.fetch = originalFetch
}
console.log(`Execution boundary: ${passed} passed, ${failed} failed (scenario groups)`)
if (failed) process.exitCode = 1
