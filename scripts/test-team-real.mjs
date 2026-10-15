import assert from 'node:assert/strict'
import { RealOrchestrator } from '../src/factory/real.ts'

// Synthetic clients only: no credentials, network, or provider work.
let passed = 0
let failed = 0
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)) }
async function test(name, run) {
  try { await run(); passed++; console.log(`PASS: ${name}`) }
  catch (error) { failed++; console.error(`FAIL: ${name}\n${error.stack}`) }
}
function fixture(extra = {}) {
  let creates = 0
  let seq = 0
  const histories = new Map([['lead', [
    { id: 'initial', role: 'user', text: 'Mission goal: Build the site\nRepository the worker builds on: https://github.com/example/site' },
    { id: 'scope', role: 'assistant', text: 'Implement - the full website works offline\nVerify - all requested tests pass' },
  ]], ['other', []]])
  const posts = []
  const clients = {
    createSession: async () => {
      const sessionId = `worker-${++creates}`
      histories.set(sessionId, [])
      return { sessionId }
    },
    getSession: async id => ({ status: 'idle', messageCount: histories.get(id)?.length ?? 0 }),
    getMessages: async id => (histories.get(id) ?? []).map(m => ({ ...m })),
    postMessage: async (id, text) => {
      posts.push({ id, text })
      histories.get(id).push({ id: `user-${++seq}`, role: 'user', text })
    },
    interrupt: async () => {},
    computers: async () => [{ id: 'comp', status: 'active' }],
    listFactorySessions: async () => [],
    listCursorAgents: async () => [],
  }
  const engine = new RealOrchestrator(() => {}, {
    factoryKey: 'synthetic', repoUrl: 'https://github.com/example/site',
    computerId: 'comp', workerPref: 'factory', clients, ...extra,
  })
  engine.restore({ ...engine.snapshot(), phase: 'plan', goal: 'Build the site',
    sessionId: 'lead', missionRepo: 'https://github.com/example/site',
    missionComputerId: 'comp', awaiting: 'plan' })
  const ready = () => engine.handleReply('1. Implement full website\n2. Test full website\nPLAN_READY')
  const begin = async () => { engine.handleAction('begin'); engine.handleAction('use_it'); await settle() }
  return { engine, clients, histories, posts, ready, begin, creates: () => creates }
}

await test('new owner restrictions retire canonical readiness and reach the next worker', async () => {
  const h = fixture()
  h.ready()
  assert.ok(h.engine.steer('Only implement the landing page, not the full website'))
  await settle()
  await h.begin()
  assert.equal(h.creates(), 0, 'an older plan cannot launch after a newer owner turn')
  h.histories.get('lead').push({ id: 'updated', role: 'assistant',
    text: '1. Implement landing page\n2. Test landing page\nPLAN_READY' })
  await h.engine.pollLead()
  await h.begin()
  assert.equal(h.creates(), 1)
  assert.match(h.posts.at(-1).text, /Only implement the landing page, not the full website/)
})

await test('approval cannot consume a stale read after newer owner steering settles', async () => {
  const h = fixture()
  await h.engine.prepareChatBuild()
  const get = h.clients.getMessages
  let release
  let first = true
  h.clients.getMessages = async (...args) => {
    if (!first) return get(...args)
    first = false
    const old = await get(...args)
    return new Promise(resolve => { release = () => resolve(old) })
  }
  const confirmation = h.engine.confirmOwnedChatBuild()
  await settle()
  assert.ok(release)
  assert.ok(h.engine.steer('Only build a static mockup now'))
  await settle()
  release()
  await confirmation
  await settle()
  assert.equal(h.creates(), 0)
})

await test('lost decision acknowledgments stay held across ticks and restore', async () => {
  const h = fixture()
  h.engine.handleReply('DECISION: Which database?\nOPTIONS: SQLite | Postgres')
  h.clients.postMessage = async (id, text) => {
    h.posts.push({ id, text })
    throw Object.assign(new Error('Synthetic acknowledgement lost'), { kind: 'network' })
  }
  assert.equal(h.engine.say('SQLite'), 'decision')
  await settle()
  h.engine.tick(3000)
  await settle()
  const saved = JSON.parse(JSON.stringify(h.engine.snapshot()))
  h.engine.restore(saved)
  h.engine.boot()
  h.engine.tick(6000)
  await settle()
  assert.equal(h.posts.length, 1)
  assert.ok(h.engine.hasUnconfirmedDelivery)
})

await test('uncertain worker execution is not automatically replayed after restore', async () => {
  const h = fixture()
  h.ready()
  h.clients.postMessage = async (id, text) => {
    h.posts.push({ id, text })
    throw Object.assign(new Error('Synthetic received execution but lost response'), { kind: 'network' })
  }
  await h.begin()
  h.engine.tick(3000)
  await settle()
  h.engine.restore(JSON.parse(JSON.stringify(h.engine.snapshot())))
  h.engine.boot()
  h.engine.tick(6000)
  await settle()
  assert.equal(h.creates(), 1)
  assert.equal(h.posts.length, 1)
  assert.ok(h.engine.hasUnconfirmedDelivery)
})

await test('a watched in-flight POST remains held when returning before timeout', async () => {
  const h = fixture()
  const open = id => {
    h.engine.leaveWatch()
    h.engine.attachFactoryRow({ sessionId: id, title: id, status: 'idle',
      computerId: 'comp', updatedAt: 0 })
  }
  open('lead')
  await h.engine.pollLead()
  let reject
  h.clients.postMessage = async (id, text) => {
    h.posts.push({ id, text })
    return new Promise((_, fail) => { reject = fail })
  }
  h.engine.handleAction('continue_session')
  await settle()
  assert.ok(reject)
  open('other')
  await h.engine.pollLead()
  open('lead')
  await h.engine.pollLead()
  h.engine.handleAction('continue_session')
  await settle()
  assert.equal(h.posts.length, 1, 'returning while the acknowledgment is pending cannot send again')
  reject(Object.assign(new Error('Synthetic gateway timeout'), { kind: 'timeout' }))
  await settle()
  assert.ok(h.engine.hasUnconfirmedDelivery)
  h.engine.handleAction('continue_session')
  await settle()
  assert.equal(h.posts.length, 1)
  h.engine.restore(JSON.parse(JSON.stringify(h.engine.snapshot())))
  await h.engine.pollLead()
  assert.ok(h.engine.hasUnconfirmedDelivery)
})

await test('new worker user-message evidence reconciles without resending execution', async () => {
  const h = fixture()
  h.ready()
  const post = h.clients.postMessage
  h.clients.postMessage = async (...args) => {
    await post(...args)
    throw Object.assign(new Error('Synthetic acknowledgement lost'), { kind: 'network' })
  }
  await h.begin()
  assert.ok(h.engine.hasUnconfirmedDelivery)
  await h.engine.pollJob(h.engine.jobs[0])
  assert.equal(h.engine.hasUnconfirmedDelivery, false)
  assert.equal(h.posts.length, 1)
})

await test('execution waits for durable attempt persistence before provider dispatch', async () => {
  let release
  let snapshot
  const h = fixture({ beforeSessionDispatch: async () => {
    snapshot = JSON.parse(JSON.stringify(h.engine.snapshot()))
    await new Promise(resolve => { release = resolve })
  } })
  h.ready()
  await h.begin()
  assert.ok(release, 'the persistence seam was invoked')
  assert.equal(h.posts.length, 0)
  assert.equal(snapshot.deliveryAttempts.length, 1)
  release()
  await settle()
  assert.equal(h.posts.length, 1)
})

await test('legacy pending worker traffic restores as uncertainty, never a blind retry', async () => {
  const h = fixture()
  h.ready()
  await h.begin()
  const snapshot = JSON.parse(JSON.stringify(h.engine.snapshot()))
  delete snapshot.deliveryProtocol
  delete snapshot.deliveryAttempts
  snapshot.jobs[0].pendingPrompt = h.posts[0].text
  h.engine.restore(snapshot)
  h.engine.tick(3000)
  await settle()
  assert.equal(h.posts.length, 1)
  assert.ok(h.engine.hasUnconfirmedDelivery)
})

await test('legacy queued owner answers are held individually without replay', async () => {
  const h = fixture()
  const snapshot = JSON.parse(JSON.stringify(h.engine.snapshot()))
  delete snapshot.deliveryProtocol
  snapshot.pendingLeadPosts = [
    { text: 'Use SQLite', awaiting: 'plan', soft: false },
    { text: 'Actually use Postgres', awaiting: 'steer', soft: true },
  ]
  h.engine.restore(snapshot)
  h.engine.tick(3000)
  await settle()
  assert.equal(h.posts.length, 0)
  assert.ok(h.engine.hasUnconfirmedDelivery)
  h.engine.handleAction('delivery_delivered')
  h.engine.tick(6000)
  await settle()
  assert.equal(h.posts.length, 0)
  assert.ok(h.engine.hasUnconfirmedDelivery, 'resolving the first old attempt does not replay the second')
})

await test('failed durable persistence never reaches the execution provider', async () => {
  const h = fixture({ beforeSessionDispatch: async () => { throw new Error('Synthetic storage commit failure') } })
  h.ready()
  await h.begin()
  assert.equal(h.posts.length, 0)
  assert.equal(h.engine.hasUnconfirmedDelivery, false, 'a never-invoked provider is not an ambiguous send')
})

await test('pause during durable persistence revokes the pending execution POST', async () => {
  let release
  const h = fixture({ beforeSessionDispatch: async () => new Promise(resolve => { release = resolve }) })
  h.ready()
  await h.begin()
  assert.ok(release)
  h.engine.pauseToggle()
  release()
  await settle()
  assert.equal(h.posts.length, 0)
})

await test('dispatch checkpoints retain genuinely unsent later owner turns', async () => {
  let saved
  const h = fixture({ beforeSessionDispatch: async () => {
    saved = JSON.parse(JSON.stringify(h.engine.snapshot()))
    await new Promise(() => {})
  } })
  const snapshot = h.engine.snapshot()
  snapshot.pendingLeadPosts = [
    { text: 'Use SQLite', awaiting: 'plan', soft: false, protectDelivery: true },
    { text: 'Only support offline mode', awaiting: 'plan', soft: false, protectDelivery: true },
  ]
  h.engine.restore(snapshot)
  h.engine.tick(3000)
  await settle()
  assert.ok(saved)
  assert.equal(saved.deliveryAttempts[0].text, 'Use SQLite')
  assert.deepEqual(saved.pendingLeadPosts.map(p => p.text), ['Only support offline mode'])
})

console.log(`Team real regressions: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
