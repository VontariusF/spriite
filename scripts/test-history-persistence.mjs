import nodeAssert from 'node:assert/strict'
import { FeedVault, FEED_KEEP } from '../src/state/feed.ts'
import { ProjectsVault } from '../src/state/projects.ts'

let checks = 0
const report = (check) => (...args) => {
  check(...args)
  checks++
  console.log('  PASS:', args[2] ?? 'saved history persistence invariant holds')
}
const assert = Object.assign(report(nodeAssert), {
  equal: report(nodeAssert.equal),
  deepEqual: report(nodeAssert.deepEqual),
})
const feedKey = 'spriite.feed.v1'
const projectKey = 'spriite.projects.v1'
const row = (at) => ({ at, label: 'Activity', text: `Entry ${at}` })
const snap = (goal, phase = 'building') => ({ goal, phase, faultKind: null, sessionId: null })
const project = (goal, updatedAt = 1) => ({ goal, status: 'building', updatedAt, snapshot: snap(goal) })
function gateway(seed = new Map()) {
  return {
    storage: seed, outage: false, ack: true, sets: 0, beforeRead: null, beforeWrite: null,
    async call(op) {
      return op({
        getLocalStorage: async (k) => {
          await this.beforeRead?.()
          return this.outage ? null : this.storage.get(k) ?? ''
        },
        setLocalStorage: async (k, v) => {
          this.sets++
          await this.beforeWrite?.()
          if (this.ack === true) this.storage.set(k, v)
          return this.ack
        },
      })
    },
  }
}
const seed = () => new Map([
  [feedKey, JSON.stringify({ v: 1, entries: [row(1)] })],
  [projectKey, JSON.stringify({ v: 1, projects: [project('old')] })],
])
const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

// Repeated read failures are not permission to overwrite unseen records.
{
  const gw = gateway(seed())
  const old = new Map(gw.storage)
  gw.outage = true
  const feed = new FeedVault(gw)
  const projects = new ProjectsVault(gw)
  await feed.load()
  await projects.load()
  projects.saveActive(snap('new'))
  for (let i = 0; i < 3; i++) {
    assert.equal(await feed.save([row(2)]), false)
    await projects.flush()
  }
  assert.equal(gw.sets, 0)
  assert.deepEqual(gw.storage, old)
  gw.outage = false
  assert.equal(await feed.save([row(2)]), true)
  await projects.flush() // no additional saveActive: failed work must survive
  assert.deepEqual(feed.restore(), [row(2), row(1)])
  assert.deepEqual(projects.list().map((p) => p.goal), ['new', 'old'])
}

for (const ack of [false, null]) {
  const gw = gateway(seed())
  gw.outage = true
  const feed = new FeedVault(gw)
  const projects = new ProjectsVault(gw)
  await feed.load()
  await projects.load()
  gw.outage = false
  gw.ack = ack
  assert.equal(await feed.save([row(2)]), false)
  projects.saveActive(snap('new'))
  await projects.flush()
  assert.deepEqual(feed.restore(), [], 'unacknowledged write does not adopt the candidate')
  assert.deepEqual(projects.list(), [], 'unacknowledged projects stay unadopted')
  gw.ack = true
  gw.outage = true
  const sets = gw.sets
  assert.equal(await feed.save([row(3), row(2)]), false)
  await projects.flush()
  assert.equal(gw.sets, sets, 'failed merge write never resolves the unknown-read guard')
  gw.outage = false
  assert.equal(await feed.save([row(3), row(2)]), true)
  await projects.flush()
  assert.deepEqual(feed.restore(), [row(3), row(2), row(1)])
  assert.deepEqual(projects.list().map((p) => p.goal), ['new', 'old'])
}

// Whole save operations, not just individual bridge calls, must be ordered.
{
  const gw = gateway(seed())
  gw.outage = true
  const feed = new FeedVault(gw)
  await feed.load()
  gw.outage = false
  const gate = deferred()
  const entered = deferred()
  let first = true
  gw.beforeRead = async () => {
    if (first) { first = false; entered.resolve(); await gate.promise }
  }
  const one = feed.save([row(2)])
  await entered.promise
  const two = feed.save([row(3), row(2)])
  gate.resolve()
  assert.deepEqual(await Promise.all([one, two]), [true, true])
  assert.deepEqual(feed.restore(), [row(3), row(2), row(1)])
}

// A failed older snapshot must not replace newer work arriving during await.
for (const fail of ['read', 'write']) {
  const gw = gateway(seed())
  gw.outage = true
  const projects = new ProjectsVault(gw)
  await projects.load()
  projects.saveActive(snap('new', 'building'))
  const gate = deferred()
  const entered = deferred()
  const hook = async () => { entered.resolve(); await gate.promise }
  if (fail === 'read') gw.beforeRead = hook
  else { gw.outage = false; gw.ack = false; gw.beforeWrite = hook }
  const one = projects.flush()
  await entered.promise
  projects.saveActive(snap('new', 'review'))
  projects.saveActive(snap('another'))
  const two = projects.flush()
  gate.resolve()
  await Promise.all([one, two])
  gw.beforeRead = null
  gw.beforeWrite = null
  gw.outage = false
  gw.ack = true
  await projects.flush()
  assert.equal(projects.snapshotFor('new')?.phase, 'review')
  assert(projects.snapshotFor('another'))
  assert(projects.snapshotFor('old'))
}

// Known-state writes also follow acknowledgments and snapshot call-time input.
{
  const gw = gateway(seed())
  const feed = new FeedVault(gw)
  const projects = new ProjectsVault(gw)
  await feed.load()
  await projects.load()
  gw.ack = false
  await feed.save([row(2)])
  projects.saveActive(snap('new'))
  await projects.flush()
  assert.deepEqual(feed.restore(), [row(1)])
  assert.deepEqual(projects.list().map((p) => p.goal), ['old'])
  gw.ack = true
  const input = [row(2)]
  const saved = feed.save(input)
  input[0].text = 'Mutated after save'
  await saved
  assert.deepEqual(feed.restore(), [row(2)])
  await projects.flush()
  assert(projects.snapshotFor('new'))
}

for (const raw of ['', '{broken', JSON.stringify({ v: 2 }), JSON.stringify({ v: 1, entries: 'bad', projects: 'bad' })]) {
  const gw = gateway(new Map([[feedKey, raw], [projectKey, raw]]))
  const feed = new FeedVault(gw)
  const projects = new ProjectsVault(gw)
  await feed.load()
  await projects.load()
  assert.deepEqual(feed.restore(), [])
  assert.deepEqual(projects.list(), [])
  assert.equal(await feed.save([row(1)]), true)
  projects.saveActive(snap('valid'))
  await projects.flush()
  assert.equal(projects.list().length, 1)
  // The same shaped absence is safe after an unknown boot read recovers;
  // unlike a null transport result, it permits writing a fresh record.
  const retryGw = gateway(new Map([[feedKey, raw], [projectKey, raw]]))
  retryGw.outage = true
  const retryFeed = new FeedVault(retryGw)
  const retryProjects = new ProjectsVault(retryGw)
  await retryFeed.load()
  await retryProjects.load()
  retryGw.outage = false
  assert.equal(await retryFeed.save([row(1)]), true)
  retryProjects.saveActive(snap('valid'))
  await retryProjects.flush()
  assert.equal(retryProjects.list().length, 1)
}
{
  const invalid = [null, {}, { at: '1', label: 'x', text: 'x' }, { at: Infinity, label: 'x', text: 'x' }]
  const badProjects = [null, {}, { ...project('bad'), snapshot: [] }, { ...project('bad2'), updatedAt: '1' }]
  const gw = gateway(new Map([
    [feedKey, JSON.stringify({ v: 1, entries: [...invalid, ...Array.from({ length: 40 }, (_, i) => row(40 - i))] })],
    [projectKey, JSON.stringify({ v: 1, projects: [...badProjects, ...Array.from({ length: 12 }, (_, i) => project(`p${i}`, 12 - i))] })],
  ]))
  const feed = new FeedVault(gw)
  const projects = new ProjectsVault(gw)
  await feed.load()
  await projects.load()
  assert.equal(feed.restore().length, FEED_KEEP)
  assert.equal(projects.list().length, 8)
  assert.equal(projects.snapshotFor('bad'), null)
  projects.saveActive(snap('latest'))
  await projects.flush()
  assert.equal(projects.list().length, 8)
  assert.equal(projects.list()[0].goal, 'latest')
}
console.log(`All ${checks} history persistence checks passed.`)
