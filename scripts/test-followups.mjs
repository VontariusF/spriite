import assert from 'node:assert/strict'
import { TestKV, makeClients, makeRuntime, cmd, quiesce } from './lib/runtime-fake.mjs'
import { RealOrchestrator } from '../src/factory/real.ts'
import { XIntake } from '../src/intake/x.ts'
import { XConnection } from '../src/intake/connection.ts'
import { mountXPanel } from '../src/setup/x-panel.ts'
import { phoneDom, makeElement } from './lib/phone-dom.mjs'
const OWNER = '1111111111111111111'
const receipt = (key, target) => ({ dedupeKey: `x:${OWNER}:${key}`, logicalPostId: key, revisionId: key, conversationId: null, status: 'held_confirm', instruction: `add feature ${key}`, postedAt: new Date(0).toISOString(), receivedAt: new Date(1).toISOString(), via: 'stream', missionId: target })
async function setup(kv = new TestKV(), runtimeOptions = {}) {
  const ctx = makeRuntime(kv, makeClients(), runtimeOptions)
  await ctx.supervisor.boot()
  const s = ctx.supervisor
  const created = await s.submitCommand(cmd('Build a clock', 'initial'))
  await s.flush()
  await quiesce()
  await s.flush()
  const id = created.missionId
  if (!s.missionStore.current.xIntake) await s.missionStore.commit((state) => ({ state: { ...state, xIntake: { binding: { ownerXUserId: OWNER, ownerHandle: 'owner', spriiteXUserId: '222', spriiteHandle: 'Spriite', verifiedAt: new Date(0).toISOString(), verification: 'users_me', credentialRef: 'test', enabled: true, protectedOwner: false }, lastCheckedAt: null, lastSuccessAt: null, lastError: null, lastReceivedAt: null, lastReceivedPostId: null, receipts: [], gaps: [], rejectedCount: 0 } }, events: [] }))
  const gate = { on: false }
  s.setXFollowupGate(() => gate.on)
  const calls = []
  const actor = { ready: true, get followupReady() { return this.ready }, sendFollowup: async (text, allowed) => { if (!actor.ready || !allowed()) return 'deferred'; calls.push(text); return 'sent' }, flush: async () => {}, tick: () => {}, snapshot: { jobs: [] } }
  s.actors.set(id, actor)
  return { ctx, s, kv, gate, calls, actor, id }
}
const e = await setup()
const r = receipt('101', e.id)
assert.equal((await e.s.submitXFollowup(r, OWNER)).status, 'saved')
assert.equal(e.s.missionStore.current.xFollowups[0].state, 'pending')
assert.equal(e.s.missionStore.current.xIntake.receipts[0].followupDelivery, 'pending')
assert.equal(e.calls.length, 0)
await e.s.missionStore.reload()
assert.equal((await e.s.submitXFollowup({ ...r, instruction: 'different words' }, OWNER)).status, 'duplicate')
assert.equal(e.s.missionStore.current.xFollowups[0].instruction, r.instruction)
e.gate.on = true
await e.s.drainXFollowups()
assert.deepEqual(e.calls, [r.instruction])
assert.equal(e.s.missionStore.current.xFollowups[0].state, 'sent')
assert.equal(e.s.missionStore.current.xIntake.receipts[0].status, 'extended')
assert.equal(e.s.missions.length, 1)
console.log('PASS: atomic saved queue survives reload and idempotently targets original mission')

async function change(e, mutation) {
  const result = await e.s.missionStore.commit((state) => ({ state: mutation(state), events: [] }))
  assert.equal(result.ok, true)
}
const ledger = (e) => e.s.missionStore.current.xFollowups ?? []
{
  const old = await setup()
  const r = receipt('201', old.id)
  await old.s.submitXFollowup(r, OWNER)
  await old.s.drainXFollowups()
  const resumed = await setup(old.kv)
  assert.equal(ledger(resumed)[0].state, 'pending')
  assert.equal((await resumed.s.submitXFollowup(r, OWNER)).status, 'duplicate')
  resumed.gate.on = true
  await resumed.s.drainXFollowups()
  assert.deepEqual(resumed.calls, [r.instruction])
  assert.equal(resumed.s.missions.length, 1)
  console.log('PASS: restart after pending receipt commit recovers without a second mission or delivery')
}
{
  const e = await setup()
  const first = receipt('301', e.id), second = receipt('302', e.id)
  let release, started
  const hasStarted = new Promise((r) => { started = r })
  e.actor.sendFollowup = async (text, allowed) => {
    if (!allowed()) return 'deferred'
    e.calls.push(text)
    if (text === first.instruction) { started(); await new Promise((r) => { release = r }) }
    return 'sent'
  }
  e.gate.on = true
  await e.s.submitXFollowup(first, OWNER)
  await hasStarted
  await e.s.submitXFollowup(second, OWNER)
  assert.equal(ledger(e)[0].state, 'sending')
  assert.equal(ledger(e)[1].state, 'pending')
  assert.deepEqual(e.calls, [first.instruction])
  release()
  await e.s.drainXFollowups()
  assert.deepEqual(e.calls, [first.instruction, second.instruction])
  assert.deepEqual(ledger(e).map((f) => f.state), ['sent', 'sent'])
  console.log('PASS: two accepted extensions during blocked delivery drain FIFO exactly once')
}
{
  const e = await setup()
  await e.s.submitXFollowup(receipt('401', e.id), OWNER)
  await e.s.drainXFollowups()
  e.gate.on = true
  e.kv.failNextSets = 1
  await e.s.drainXFollowups()
  assert.equal(e.calls.length, 0)
  await e.s.missionStore.reload()
  assert.equal(ledger(e)[0].state, 'pending')
  await e.s.drainXFollowups()
  assert.equal(e.calls.length, 1)
  console.log('PASS: failed sending claim makes zero remote calls and remains recoverable')
}
for (const failure of ['transport', 'ack']) {
  const e = await setup()
  const r = receipt(failure === 'transport' ? '501' : '502', e.id)
  await e.s.submitXFollowup(r, OWNER)
  await e.s.drainXFollowups()
  e.actor.sendFollowup = async (text) => {
    e.calls.push(text)
    if (failure === 'transport') throw new Error('response lost')
    e.kv.failNextSets = 1
    return 'sent'
  }
  e.gate.on = true
  await e.s.drainXFollowups()
  assert.equal(e.calls.length, 1)
  const restarted = await setup(e.kv)
  restarted.gate.on = true
  await restarted.s.drainXFollowups()
  assert.equal(ledger(restarted)[0].state, 'unknown')
  assert.equal(restarted.calls.length, 0)
  assert.equal((await restarted.s.submitXFollowup(r, OWNER)).status, 'duplicate')
  assert.equal(await restarted.s.resolveXFollowup(r.dedupeKey, 'resend', 0), true)
  assert.equal(await restarted.s.resolveXFollowup(r.dedupeKey, 'resend', 0), false)
  await restarted.s.drainXFollowups()
  assert.equal(restarted.calls.length, 1)
  assert.equal(ledger(restarted)[0].attempt, 1)
  console.log(`PASS: ${failure} ambiguity survives restart without blind replay; explicit resend is attempt-idempotent`)
}
{
  const e = await setup()
  await e.s.submitXFollowup(receipt('601', e.id), OWNER)
  await e.s.drainXFollowups()
  await change(e, (s) => ({ ...s, xFollowups: s.xFollowups.map((f) => ({ ...f, state: 'sending' })) }))
  const resumed = await setup(e.kv)
  resumed.gate.on = true
  assert.equal(await resumed.s.resolveXFollowup(ledger(resumed)[0].dedupeKey, 'dismiss', 0), true)
  await resumed.s.drainXFollowups()
  assert.equal(resumed.calls.length, 0)
  assert.equal(ledger(resumed)[0].state, 'dismissed')
  assert.equal(resumed.s.missionStore.current.xIntake.receipts[0].status, 'dismissed')
  console.log('PASS: crash after claim is unknown; owner dismissal never sends')
}
{
  const e = await setup()
  const r = receipt('701', e.id)
  await e.s.submitXFollowup(r, OWNER)
  await e.s.drainXFollowups()
  e.gate.on = true
  e.actor.ready = false
  await e.s.drainXFollowups()
  assert.equal(e.calls.length, 0)
  e.actor.ready = true
  await change(e, (s) => ({ ...s, missions: s.missions.map((m) => ({ ...m, control: 'paused' })) }))
  await e.s.drainXFollowups()
  assert.equal(ledger(e)[0].state, 'pending')
  assert.equal(e.calls.length, 0)
  await change(e, (s) => ({ ...s, missions: s.missions.map((m) => ({ ...m, control: 'running' })) }))
  e.gate.on = false
  await e.s.drainXFollowups()
  assert.equal(e.calls.length, 0)
  e.gate.on = true
  await e.s.drainXFollowups()
  assert.equal(e.calls.length, 1)
  console.log('PASS: busy, pause and X off defer without delivery acknowledgment')
}
{
  const e = await setup()
  const r = receipt('801', e.id)
  await e.s.submitXFollowup(r, OWNER)
  await e.s.drainXFollowups()
  await change(e, (s) => ({ ...s, missions: s.missions.map((m) => ({ ...m, phase: 'completed' })) }))
  e.gate.on = true
  await e.s.drainXFollowups()
  assert.equal(e.calls.length, 0)
  assert.equal(ledger(e)[0].state, 'unknown')
  console.log('PASS: terminal target requires resolution instead of delivery')
}
{
  const e = await setup()
  const r = { ...receipt('901', e.id), status: 'extended' }
  await change(e, (s) => ({ ...s, xIntake: { ...s.xIntake, receipts: [r] } }))
  e.gate.on = true
  await e.s.drainXFollowups()
  assert.equal(ledger(e)[0].state, 'unknown')
  assert.equal(e.calls.length, 0)
  assert.equal(e.s.missionStore.current.xIntake.receipts[0].followupDelivery, 'unknown')
  console.log('PASS: archive extension without local delivery ledger holds for owner resolution')
}
{
  const e = await setup()
  await e.s.submitXFollowup(receipt('1001', e.id), OWNER)
  await e.s.drainXFollowups()
  const commit = e.s.missionStore.commit.bind(e.s.missionStore)
  e.s.missionStore.commit = async (mutation) => {
    const result = await commit(mutation)
    if (ledger(e)[0]?.state === 'sending') e.gate.on = false
    return result
  }
  e.gate.on = true
  await e.s.drainXFollowups()
  assert.equal(e.calls.length, 0)
  assert.equal(ledger(e)[0].state, 'pending')
  console.log('PASS: X off after durable claim but before request restores definite deferral to pending')
}
{
  const e = await setup()
  await e.s.submitXFollowup(receipt('1101', e.id), OWNER)
  await e.s.drainXFollowups()
  await change(e, (s) => ({ ...s, xIntake: { ...s.xIntake, binding: { ...s.xIntake.binding, ownerXUserId: '999' } } }))
  e.gate.on = true
  await e.s.drainXFollowups()
  assert.equal(e.calls.length, 0)
  assert.equal(ledger(e)[0].state, 'unknown')
  console.log('PASS: a changed source owner cannot dispatch the old owner instruction')
}
{
  const engine = new RealOrchestrator(() => {}, { clients: makeClients() })
  assert.equal(await engine.sendFollowup('no lead', () => true), 'deferred')
  engine.sessionId = 'test-lead'
  engine.clients.getMessages = async () => []
  engine.busy = true
  assert.equal(await engine.sendFollowup('first', () => true), 'deferred')
  engine.busy = false
  let release
  const calls = []
  engine.clients.postMessage = async (id, text) => { calls.push(text); await new Promise((r) => { release = r }) }
  const sent = engine.sendFollowup('first', () => true)
  assert.equal(await engine.sendFollowup('second', () => true), 'deferred')
  // The native-attention pre-read is asynchronous. Keep the second call
  // deferred while waiting for the first dispatch to reach the fixture.
  for (let i = 0; i < 20 && calls.length === 0; i++) await new Promise(r => setTimeout(r, 1))
  assert.deepEqual(calls, ['first'])
  release()
  assert.equal(await sent, 'sent')
  assert.equal(engine.lastSteer, '')
  engine.clients.postMessage = async () => { throw new Error('response lost') }
  assert.equal(await engine.sendFollowup('ambiguous', () => true), 'unknown')
  assert.deepEqual(engine.pendingLeadPosts, [])
  assert.equal(await engine.sendFollowup('off', () => false), 'deferred')
  console.log('PASS: real steering seam awaits provider result, defers busy/off, and never queues ambiguous transport replay')
}
{
  const e = await setup()
  const r = { ...receipt('1201', e.id), status: 'extended' }
  await change(e, (s) => ({ ...s, xIntake: { ...s.xIntake, receipts: [r] } }))
  const intake = new XIntake({ store: e.s.missionStore, runtime: e.s, transport: () => null })
  const unknown = intake.health().needsOwner[0]
  assert.equal(unknown.followupDelivery, 'unknown')
  assert.equal((await intake.confirmHeld(r.dedupeKey)).status, 'held_confirm')
  assert.equal(e.calls.length, 0)
  phoneDom()
  const root = makeElement('div')
  const clicks = []
  const connection = { active: true, health: () => ({ ...intake.health(), refresh: 'on' }),
    subscribe: () => () => {}, resendFollowup: async (key, attempt) => { clicks.push([key, attempt]); return true },
    dismiss: async () => true }
  mountXPanel(root, { connection, keys: { xHint: '', xRefresh: '', repoUrl: '' },
    prefs: { flags: { persistent_runtime_v2: true, x_owner_intake: true }, xSpriiteHandle: '', xClientId: '' },
    onSaved: () => {}, onOpenRuntimePrefs: () => {} })
  const all = (node) => [node, ...(node.children ?? []).flatMap(all)]
  const button = all(root).find((node) => node.textContent === 'Resend (may duplicate)' && node.tagName === 'BUTTON')
  assert.ok(button)
  assert.ok(all(root).find((node) => node.textContent === 'Dismiss' && node.tagName === 'BUTTON'))
  const repo = all(root).find((node) => node.placeholder === 'https://github.com/owner/repository')
  assert.equal(repo.hidden, true)
  button.click()
  await quiesce()
  assert.deepEqual(clicks, [[r.dedupeKey, 0]])
  console.log('PASS: archive gap surfaces explicit resend/dismiss, not generic confirmation or repository commands')
}
{
  const policy = { revision: 'test', allowLaunch: true, allowedRepositories: null }
  const e = await setup(new TestKV(), { policy: () => policy })
  const frozen = JSON.stringify(e.s.missions[0].config)
  await e.s.submitXFollowup(receipt('1301', e.id), OWNER)
  await e.s.drainXFollowups()
  e.gate.on = true
  policy.allowLaunch = false
  await e.s.drainXFollowups()
  assert.equal(e.calls.length, 0)
  policy.allowLaunch = true
  policy.allowedRepositories = []
  await e.s.drainXFollowups()
  assert.equal(e.calls.length, 0)
  policy.allowedRepositories = null
  await e.s.drainXFollowups()
  assert.equal(e.calls.length, 1)
  assert.equal(JSON.stringify(e.s.missions[0].config), frozen)
  console.log('PASS: live policy gates delivery without changing frozen build configuration')
}
{
  const e = await setup()
  const r = receipt('1401', e.id)
  await e.s.submitXFollowup(r, OWNER)
  await e.s.drainXFollowups()
  await change(e, (s) => ({ ...s, xFollowups: s.xFollowups.map((f) => ({ ...f, state: 'unknown' })) }))
  assert.equal(await e.s.resolveXFollowup(r.dedupeKey, 'resend', 0), false)
  assert.equal(await e.s.resolveXFollowup(r.dedupeKey, 'dismiss', 0), true)
  assert.equal(e.calls.length, 0)
  console.log('PASS: X off suppresses resend but still permits safe owner dismissal')
}
{
  const e = await setup()
  await e.s.submitXFollowup(receipt('1501', e.id), OWNER)
  await e.s.drainXFollowups()
  const connection = new XConnection({ supervisor: e.s,
    keys: { x: 'synthetic', xCredentialRef: 'test', xRefresh: '' },
    enabled: () => false, foreground: () => false, repository: () => '' })
  let updates = 0
  connection.subscribe(() => { updates++ })
  connection.tick()
  assert.equal(updates, 1)
  await change(e, (s) => ({ ...s, xFollowups: s.xFollowups.map((f) => ({ ...f, state: 'unknown' })) }))
  connection.tick()
  assert.equal(updates, 2)
  connection.tick()
  assert.equal(updates, 2)
  assert.equal(e.calls.length, 0)
  console.log('PASS: asynchronous delivery changes refresh private receipt UI without a network check')
}
let regressionFailures = 0
const regression = async (name, test) => {
  try { await test(); console.log(`PASS: ${name}`) }
  catch (err) { regressionFailures++; console.log(`FAIL: ${name}: ${err.message}`) }
}
await regression('pending dismissal atomically survives resume and stale attempt', async () => {
  const e = await setup()
  const r = receipt('1601', e.id)
  await e.s.submitXFollowup(r, OWNER)
  await e.s.drainXFollowups()
  await change(e, (s) => ({ ...s, missions: s.missions.map((m) => ({ ...m, control: 'paused' })) }))
  const intake = new XIntake({ store: e.s.missionStore, runtime: e.s, transport: () => null })
  assert.equal(await e.s.resolveXFollowup(r.dedupeKey, 'dismiss', 9), false)
  assert.equal(await intake.dismissHeld(r.dedupeKey), true)
  await e.s.missionStore.reload()
  await change(e, (s) => ({ ...s, missions: s.missions.map((m) => ({ ...m, control: 'running' })) }))
  e.gate.on = true
  await e.s.drainXFollowups()
  assert.equal(e.calls.length, 0)
  assert.equal(ledger(e)[0].state, 'dismissed')
  assert.equal(intake.state.receipts[0].status, 'dismissed')
})
await regression('dismissal losing the claim race cannot report cancellation', async () => {
  const e = await setup()
  const r = receipt('1602', e.id)
  await e.s.submitXFollowup(r, OWNER)
  await e.s.drainXFollowups()
  const intake = new XIntake({ store: e.s.missionStore, runtime: e.s, transport: () => null })
  let unblock
  intake.chain = new Promise((resolve) => { unblock = resolve })
  const pendingDismiss = intake.dismissHeld(r.dedupeKey)
  let release, started
  const ready = new Promise((resolve) => { started = resolve })
  e.actor.sendFollowup = async (text) => {
    e.calls.push(text); started()
    await new Promise((resolve) => { release = resolve })
    return 'sent'
  }
  e.gate.on = true
  const drain = e.s.drainXFollowups()
  await ready
  try {
    // Pending state/attempt observed before the delivery claim.
    unblock()
    const dismissed = await Promise.race([pendingDismiss,
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 80))])
    assert.equal(dismissed, false)
    assert.equal(ledger(e)[0].state, 'sending')
    assert.equal(await intake.dismissHeld(r.dedupeKey), false)
  } finally { release(); await drain }
  assert.equal(ledger(e)[0].state, 'sent')
  assert.equal(e.calls.length, 1)
})
await regression('paused A does not block B and each mission retains FIFO', async () => {
  const e = await setup()
  const b = await e.s.submitCommand(cmd('Build another clock', 'second-mission'))
  await e.s.flush(); await quiesce(); await e.s.flush()
  e.s.actors.set(b.missionId, e.actor)
  await change(e, (s) => ({ ...s, missions: s.missions.map((m) => m.missionId === e.id ? { ...m, control: 'paused' } : m) }))
  const rows = [receipt('1701', e.id), receipt('1702', b.missionId), receipt('1703', e.id), receipt('1704', b.missionId)]
  for (const row of rows) await e.s.submitXFollowup(row, OWNER)
  await e.s.drainXFollowups()
  e.gate.on = true
  await Promise.all([e.s.drainXFollowups(), e.s.drainXFollowups()])
  assert.deepEqual(e.calls, [rows[1].instruction, rows[3].instruction])
  await change(e, (s) => ({ ...s, missions: s.missions.map((m) => ({ ...m, control: 'running' })) }))
  await e.s.drainXFollowups()
  assert.deepEqual(e.calls, [rows[1].instruction, rows[3].instruction, rows[0].instruction, rows[2].instruction])
})
for (const mode of ['live-loss', 'live-ack-loss', 'restored-unknown', 'restored-sending']) {
  for (const resolution of ['resend', 'dismiss']) {
    await regression(`${mode}: unresolved A head blocks later A across drains until ${resolution}, not B`, async () => {
      let e = await setup()
      const b = await e.s.submitCommand(cmd('Build a second FIFO clock', `fifo-${mode}-${resolution}`))
      await e.s.flush(); await quiesce(); await e.s.flush()
      e.s.actors.set(b.missionId, e.actor)
      const rows = [receipt('1801', e.id), receipt('1802', e.id), receipt('1803', b.missionId)]
      for (const row of rows) await e.s.submitXFollowup(row, OWNER)
      await e.s.drainXFollowups()
      if (mode.startsWith('live-')) {
        e.actor.sendFollowup = async (text, allowed) => {
          if (!allowed()) return 'deferred'
          e.calls.push(text)
          if (mode === 'live-ack-loss' && text === rows[0].instruction) {
            e.kv.failNextSets = 1
            return 'sent'
          }
          return text === rows[0].instruction ? 'unknown' : 'sent'
        }
      } else {
        await change(e, (s) => ({ ...s, xFollowups: s.xFollowups.map((f, i) =>
          i === 0 ? { ...f, state: mode === 'restored-sending' ? 'sending' : 'unknown' } : f) }))
        e = await setup(e.kv)
        e.s.actors.set(b.missionId, e.actor)
      }
      e.gate.on = true
      await Promise.all([e.s.drainXFollowups(), e.s.drainXFollowups()])
      for (let pass = 0; pass < 3; pass++) await e.s.drainXFollowups()
      await e.s.missionStore.reload()
      await e.s.drainXFollowups()
      const before = mode.startsWith('live-') ? [rows[0].instruction, rows[2].instruction] : [rows[2].instruction]
      assert.deepEqual(e.calls, before)
      assert.deepEqual(ledger(e).map((f) => f.state), ['unknown', 'pending', 'sent'])
      // A stale attempt must neither unblock A nor authorize a resend.
      assert.equal(await e.s.resolveXFollowup(rows[0].dedupeKey, resolution, 99), false)
      await e.s.drainXFollowups()
      assert.deepEqual(e.calls, before)
      e.actor.sendFollowup = async (text, allowed) => {
        if (!allowed()) return 'deferred'
        e.calls.push(text); return 'sent'
      }
      assert.equal(await e.s.resolveXFollowup(rows[0].dedupeKey, resolution, 0), true)
      await e.s.drainXFollowups()
      assert.equal(await e.s.resolveXFollowup(rows[0].dedupeKey, resolution, 0), false)
      await e.s.drainXFollowups()
      assert.deepEqual(e.calls, [...before, ...(resolution === 'resend' ? [rows[0].instruction] : []), rows[1].instruction])
      assert.deepEqual(ledger(e).map((f) => f.state), [resolution === 'resend' ? 'sent' : 'dismissed', 'sent', 'sent'])
      assert.equal(e.calls.filter((text) => text === rows[2].instruction).length, 1)
    })
  }
}
await regression('definite deferral retains A head across passes while B continues', async () => {
  const e = await setup()
  const b = await e.s.submitCommand(cmd('Build a deferral clock', 'fifo-deferred'))
  await e.s.flush(); await quiesce(); await e.s.flush()
  e.s.actors.set(b.missionId, e.actor)
  const rows = [receipt('1901', e.id), receipt('1902', e.id), receipt('1903', b.missionId)]
  for (const row of rows) await e.s.submitXFollowup(row, OWNER)
  await e.s.drainXFollowups()
  let deferred = true
  e.actor.sendFollowup = async (text, allowed) => {
    if (!allowed() || (deferred && text === rows[0].instruction)) return 'deferred'
    e.calls.push(text); return 'sent'
  }
  e.gate.on = true
  for (let pass = 0; pass < 3; pass++) await e.s.drainXFollowups()
  assert.deepEqual(e.calls, [rows[2].instruction])
  assert.deepEqual(ledger(e).map((f) => f.state), ['pending', 'pending', 'sent'])
  deferred = false
  await Promise.all([e.s.drainXFollowups(), e.s.drainXFollowups()])
  assert.deepEqual(e.calls, [rows[2].instruction, rows[0].instruction, rows[1].instruction])
  assert.deepEqual(ledger(e).map((f) => f.state), ['sent', 'sent', 'sent'])
})
console.log(regressionFailures ? `${regressionFailures} follow-up regressions FAILED.` : 'All follow-up tests passed.')
if (regressionFailures) process.exitCode = 1
