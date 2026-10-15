import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { RealOrchestrator } from '../src/factory/real.ts'

let passed = 0
let failed = 0
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)) }
async function test(name, run) {
  try { await run(); passed++; console.log(`PASS: ${name}`) }
  catch (error) { failed++; console.error(`FAIL: ${name}\n${error.stack}`) }
}
class KV {
  value = null
  failRead = false
  failSave = false
  release = null
  suspended = false
  async get() { if (this.failRead) throw new Error('Unknown read'); return this.value }
  async set(_key, value) {
    if (this.suspended) await new Promise(resolve => { this.release = resolve })
    if (this.failSave) return false
    this.value = value
    return true
  }
}
async function boot(kv, options = {}) {
  const { createWatchReceiptDependencies } = await import('../src/factory/watch-receipts.ts')
  const deps = await createWatchReceiptDependencies(kv)
  const history = options.history ?? new Map([['lead', []], ['other', []]])
  const posts = []
  const clients = {
    getSession: async () => ({ status: 'idle', messageCount: 0 }),
    getMessages: async id => history.get(id) ?? [],
    postMessage: async (id, text) => {
      posts.push({ id, text, saved: kv.value })
      if (options.accepted) history.get(id).push({ id: 'new-receipt', role: 'user', text })
      if (options.pending) return new Promise(() => {})
      if (options.uncertain) throw Object.assign(new Error('Lost ack'), { kind: 'network' })
    },
    interrupt: async () => {},
    listFactorySessions: async () => [],
    listCursorAgents: async () => [],
  }
  const engine = new RealOrchestrator(() => {}, { factoryKey: 'synthetic', clients, ...deps })
  const open = async id => {
    engine.leaveWatch()
    engine.attachFactoryRow({ sessionId: id, title: id, status: 'idle', computerId: 'comp', updatedAt: 0 })
    await engine.pollLead()
  }
  await open('lead')
  return { engine, posts, open, history }
}

await test('a detached POST awaits acknowledged independent receipt storage', async () => {
  const kv = new KV()
  const h = await boot(kv, { pending: true })
  kv.suspended = true
  h.engine.handleAction('continue_session')
  await settle()
  assert.ok(kv.release)
  assert.equal(h.posts.length, 0)
  kv.suspended = false
  kv.release()
  await settle()
  assert.equal(h.posts.length, 1)
  assert.equal(JSON.parse(h.posts[0].saved).records[0].attempt.text, h.posts[0].text)
  const reloaded = await boot(kv)
  reloaded.engine.handleAction('continue_session')
  await settle()
  assert.ok(reloaded.engine.hasUnconfirmedDelivery)
  assert.equal(reloaded.posts.length, 0, 'reload before the ack cannot replay')
})
await test('unknown delivery survives unrelated views and process reload', async () => {
  const kv = new KV()
  const h = await boot(kv, { uncertain: true })
  h.engine.handleAction('continue_session')
  await settle()
  await h.open('other')
  assert.equal(h.engine.hasUnconfirmedDelivery, false)
  h.engine.reset()
  const next = await boot(kv)
  next.engine.handleAction('continue_session')
  await settle()
  assert.equal(next.posts.length, 0)
  assert.ok(next.engine.hasUnconfirmedDelivery)
})
await test('unknown reads block detached sends without writing absence', async () => {
  const kv = new KV()
  kv.failRead = true
  const h = await boot(kv)
  h.engine.handleAction('continue_session')
  await settle()
  assert.equal(h.posts.length, 0)
  assert.equal(kv.value, null)
  assert.ok(h.engine.hasUnconfirmedDelivery)
})
await test('unacknowledged writes block detached sends', async () => {
  const kv = new KV()
  const h = await boot(kv)
  kv.failSave = true
  h.engine.handleAction('continue_session')
  await settle()
  assert.equal(h.posts.length, 0)
})
await test('receipt evidence persists a tombstone that defeats stale app snapshots', async () => {
  const kv = new KV()
  const h = await boot(kv, { uncertain: true, accepted: true })
  h.engine.handleAction('continue_session')
  await settle()
  const stale = h.engine.snapshot()
  await h.engine.pollLead()
  await settle()
  assert.equal(h.engine.hasUnconfirmedDelivery, false)
  const next = await boot(kv, { history: h.history })
  next.engine.restore(stale)
  assert.equal(next.engine.hasUnconfirmedDelivery, false)
})
await test('explicit owner resolution persists across process reload', async () => {
  const kv = new KV()
  const h = await boot(kv, { uncertain: true })
  h.engine.handleAction('continue_session')
  await settle()
  h.engine.handleAction('resolve_delivery')
  h.engine.handleAction('delivery_seen')
  await settle()
  const next = await boot(kv)
  assert.equal(next.engine.hasUnconfirmedDelivery, false)
})
await test('failed clear persistence conservatively recovers the saved hold', async () => {
  const kv = new KV()
  const h = await boot(kv, { uncertain: true })
  h.engine.handleAction('continue_session')
  await settle()
  kv.failSave = true
  h.engine.handleAction('resolve_delivery')
  h.engine.handleAction('delivery_release')
  await settle()
  kv.failSave = false
  const next = await boot(kv)
  assert.ok(next.engine.hasUnconfirmedDelivery)
})
await test('damaged known-session legacy data remains an explicit hold', async () => {
  const kv = new KV()
  kv.value = JSON.stringify({ deliveryAttempts: [{ sessionId: 'lead', text: null }] })
  const h = await boot(kv)
  h.engine.handleAction('continue_session')
  await settle()
  assert.ok(h.engine.hasUnconfirmedDelivery)
  assert.equal(h.posts.length, 0)
})
await test('unidentifiable corruption is a non-resolvable storage hold', async () => {
  const kv = new KV()
  kv.value = '{"broken'
  const h = await boot(kv)
  h.engine.handleAction('resolve_delivery')
  h.engine.handleAction('delivery_seen')
  h.engine.handleAction('continue_session')
  await settle()
  assert.ok(h.engine.hasUnconfirmedDelivery)
  assert.equal(h.posts.length, 0)
  assert.equal(kv.value, '{"broken')
})
await test('owner resolution during the storage await cancels a not-yet-dispatched POST', async () => {
  for (const action of ['delivery_seen', 'delivery_release']) {
    const kv = new KV()
    const h = await boot(kv)
    kv.suspended = true
    h.engine.handleAction('continue_session')
    await settle()
    assert.ok(kv.release)
    h.engine.handleAction('resolve_delivery')
    h.engine.handleAction(action)
    kv.suspended = false
    kv.release()
    await settle()
    assert.equal(h.posts.length, 0)
    const next = await boot(kv)
    assert.equal(next.engine.hasUnconfirmedDelivery, false)
  }
})
await test('runtime lobby and legacy production constructors both install independent storage', async () => {
  const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
  assert.ok((source.match(/await createWatchReceiptDependencies\(/g) ?? []).length >= 2)
  assert.match(source, /makeLobby:[\s\S]*?\.\.\.watchReceiptDeps/)
  assert.match(source, /const legacy = new RealOrchestrator[\s\S]*?\.\.\.legacyReceiptDeps/)
})

await test('legacy gateway-failure migration cannot be erased by an empty receipt ledger', async () => {
  const kv = new KV()
  const h = await boot(kv)
  h.engine.restore({ ...h.engine.snapshot(), deliveryAttempts: [], pendingLeadDelivery: null,
    faultSource: 'factory', faultKind: 'service', faultDetail: 'Factory HTTP 504 (unknown)',
    faultRetry: 'steer', lastSteer: 'Prior owner request' })
  assert.ok(h.engine.hasUnconfirmedDelivery)
  await settle()
  const next = await boot(kv)
  assert.ok(next.engine.hasUnconfirmedDelivery)
  assert.equal(next.posts.length, 0)
})

await test('a root runtime snapshot focused on a managed actor cannot lose lobby receipts', async () => {
  const { RuntimeEngine } = await import('../src/runtime/app-engine.ts')
  const { TestKV, makeClients, makeRuntime, cmd } = await import('./lib/runtime-fake.mjs')
  const kv = new KV()
  const h = await boot(kv, { uncertain: true })
  const ctx = makeRuntime(new TestKV(), makeClients())
  await ctx.supervisor.boot()
  const receipt = await ctx.supervisor.submitCommand({ ...cmd('A separate managed mission', 'watch-focus'), startApproved: true })
  const root = new RuntimeEngine({
    supervisor: ctx.supervisor, makeLobby: () => h.engine, emit: () => {}, notice: () => {},
    copy: { notSaved: 'Not saved', finishedRecord: 'Finished record' },
  })
  h.engine.handleAction('continue_session')
  await settle()
  assert.ok(root.showMission(receipt.missionId))
  assert.equal(root.snapshot().deliveryAttempts.length, 0, 'the SDK-facing root snapshot contains the actor, not the watch hold')
  const next = await boot(kv)
  assert.ok(next.engine.hasUnconfirmedDelivery, 'independent storage recovers the unseen lobby receipt')
  assert.equal(next.posts.length, 0)
})

await test('oversized, duplicate and unknown-version ledgers fail closed without eviction', async () => {
  for (const raw of [
    'x'.repeat(2_000_001),
    JSON.stringify({ version: 2, records: [] }),
    JSON.stringify({ version: 1, records: Array.from({ length: 129 }, (_, n) => ({ sessionId: `session-${n}`, attempt: null })) }),
    JSON.stringify({ version: 1, records: [{ sessionId: 'lead', attempt: null }, { sessionId: 'lead', attempt: null }] }),
  ]) {
    const kv = new KV()
    kv.value = raw
    const h = await boot(kv)
    h.engine.handleAction('continue_session')
    await settle()
    assert.equal(h.posts.length, 0)
    assert.ok(h.engine.hasUnconfirmedDelivery)
    assert.equal(kv.value, raw)
  }
})
await test('receipt boot imports neither approval nor execution ownership or settings', async () => {
  const kv = new KV()
  kv.value = JSON.stringify({ version: 1,
    records: [{ sessionId: 'lead', attempt: { sessionId: 'lead', text: 'Prior request', beforeMessageIds: null } }],
    phase: 'building', approvedPlan: ['Unauthorized work', 'Skip confirmation'],
    jobs: [{ sessionId: 'unauthorized-worker' }], workerPref: 'cursor', missionSettings: { model: 'other' },
  })
  const h = await boot(kv)
  const snapshot = h.engine.snapshot()
  assert.equal(snapshot.phase, 'attach')
  assert.equal(snapshot.jobs.length, 0)
  assert.deepEqual(snapshot.approvedPlan, [])
  assert.deepEqual(snapshot.planLabels, [])
  assert.ok(h.engine.hasUnconfirmedDelivery)
  assert.equal(h.posts.length, 0)
})

await test('a damaged cross-session receipt cannot be cleared by unrelated message evidence', async () => {
  const kv = new KV()
  kv.value = JSON.stringify({ version: 1, records: [{
    sessionId: 'lead', attempt: { sessionId: 'other', text: 'Other session request', beforeMessageIds: [] },
  }] })
  const h = await boot(kv, { history: new Map([['lead', [{ id: 'new', role: 'user', text: 'Other session request' }]], ['other', []]]) })
  assert.ok(h.engine.hasUnconfirmedDelivery)
  assert.equal(h.posts.length, 0)
})

console.log(`Watch receipt storage: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
