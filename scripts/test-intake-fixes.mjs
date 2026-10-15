/**
 * Regression tests for three intake fixes:
 *  1. A steering reply refused because X intake was switched off mid-read is
 *     'off' (no health error), not a failed save.
 *  2. Context gathering follows links only from the owner's post and its
 *     direct references, never out of a post fetched as a link target.
 *  3. A derived repository name always keeps its post-id suffix.
 *
 * Usage: node --import ./scripts/ts-resolve.mjs scripts/test-intake-fixes.mjs
 */
import assert from 'node:assert/strict'
import { TestKV, makeClients, makeRuntime, REPO, drive } from './lib/runtime-fake.mjs'
import { XIntake } from '../src/intake/x.ts'
import { gatherContext } from '../src/context/gather.ts'
import { derivedRepositoryName, validRepositoryName } from '../src/native/delivery.ts'

let failures = 0
const test = async (name, fn) => {
  try { await fn(); console.log(`PASS: ${name}`) }
  catch (err) { failures++; console.log(`FAIL: ${name}: ${err.message}`) }
}

const OWNER = '1111111111111111111'
const SPRIITE = '2222222222222222222'
const NOW = Date.parse('2026-10-07T12:00:00.000Z')
let nextId = 2090000000000000000n
const newId = () => String(++nextId)

function mkPost({ text, replyTo, at = NOW - 3600_000, id = newId(), conversationId }) {
  const i = text.indexOf('@Spriite')
  return {
    id, text, author_id: OWNER, created_at: new Date(at).toISOString(),
    conversation_id: conversationId ?? id, edit_history_tweet_ids: [id],
    entities: { mentions: i < 0 ? [] : [{ start: i, end: i + 8, username: 'Spriite', id: SPRIITE }], urls: [] },
    ...(replyTo ? { referenced_tweets: [{ type: 'replied_to', id: replyTo }] } : {}),
    display_text_range: [0, text.length],
  }
}

function fakeX() {
  const posts = new Map()
  return {
    posts,
    add(p) { posts.set(p.id, p); return p },
    me: async () => ({ id: OWNER, username: 'owner', protected: false }),
    userByUsername: async () => ({ id: SPRIITE, username: 'Spriite' }),
    ownerPosts: async (userId, startTime, _token, sinceId) => ({
      posts: [...posts.values()].filter((p) => p.author_id === userId && p.created_at >= startTime &&
        (sinceId == null || BigInt(p.id) > BigInt(sinceId))),
      includes: {}, nextToken: null,
    }),
    post: async (id) => (posts.has(id) ? { post: posts.get(id), includes: {} } : null),
  }
}

/** A running mission from an owner post, and an intake whose follow-up seam the test controls. */
async function setupSteer(followup) {
  const ctx = makeRuntime(new TestKV(), makeClients(), {})
  await ctx.supervisor.boot()
  const x = fakeX()
  const clock = { now: NOW - 48 * 3600_000 }
  const s = ctx.supervisor
  let intake
  const runtime = {
    get missions() { return s.missions },
    submitCommand: (input) => s.submitCommand(input),
    submitXFollowup: (r, owner) => followup({ s, intake, r, owner }),
    resolveXFollowup: (k, a, n) => s.resolveXFollowup(k, a, n),
  }
  intake = new XIntake({ store: s.missionStore, runtime, transport: () => x, now: () => clock.now })
  const b = await intake.bind({ spriiteHandle: '@Spriite', credentialRef: 'x.owner', defaultRepository: REPO })
  if (!b.ok) throw new Error(`bind failed: ${b.reason}`)
  clock.now = NOW
  s.setXFollowupGate(() => intake.state.binding?.enabled === true)
  const first = await intake.ingestPost(x.add(mkPost({ text: '@Spriite build a weather widget' })), {}, 'stream')
  assert.equal(first.status, 'submitted')
  await drive(ctx, () => ['building', 'awaiting_decision'].includes(s.missions[0]?.phase), 30000)
  const firstReceipt = intake.state.receipts[0]
  const reply = x.add(mkPost({ text: '@Spriite also add a 5-day forecast', replyTo: firstReceipt.revisionId,
    conversationId: firstReceipt.revisionId }))
  return { ctx, s, x, intake, reply }
}

await test('a steering reply refused by the connection kill switch is off, not a failed check', async () => {
  // The connection gate's refusal, named the way submitCommand's is.
  const env = await setupSteer(async () => ({ status: 'failed', reason: 'X intake is off' }))
  const r = await env.intake.poll()
  const out = r.outcomes.find((o) => o.status !== 'duplicate' && o.status !== 'ignored')
  assert.equal(out?.status, 'off')
  assert.equal(r.errorKind, undefined)
  assert.equal(env.intake.state.lastError, null, 'no health error for the owner’s own switch')
})

await test('a steering reply whose binding was switched off under the read is off, not a failed save', async () => {
  // The owner turns intake off while the reply is being saved: the supervisor's
  // own binding check refuses it with a plain failure.
  const env = await setupSteer(async ({ s, intake, r, owner }) => {
    await intake.setEnabled(false)
    return s.submitXFollowup(r, owner)
  })
  const res = await env.intake.ingestPost(env.reply, {}, 'catch_up')
  assert.equal(res.status, 'off')
})

await test('a genuine follow-up save failure is still reported as failed', async () => {
  const env = await setupSteer(async () => ({ status: 'failed' }))
  const r = await env.intake.poll()
  assert.equal(r.errorKind, 'storage')
  assert.ok(env.intake.state.lastError, 'a real failure is still recorded')
})

await test('links are followed from direct references only, never from a linked post', async () => {
  const p = (id, text) => ({ id, text, author_id: OWNER, entities: { urls: [] } })
  const owner = p('100', '@Spriite build this https://x.com/someone/status/300')
  const table = new Map([
    ['300', p('300', 'see https://x.com/other/status/400 and https://github.com/a/b')],
    ['400', p('400', 'two hops away')],
  ])
  const fetched = []
  const transport = { post: async (id) => { fetched.push(id); return table.has(id) ? { post: table.get(id), includes: {} } : null } }
  const githubCalls = []
  const github = {
    repos: async () => [], readme: async (n) => { githubCalls.push(n); return 'readme' },
    issue: async () => null, pull: async () => null,
  }
  const out = await gatherContext({ post: owner, includes: {}, ownerId: OWNER, instruction: 'build this',
    transport, method: 'x_api_v2', github,
    budget: { maxParentHops: 5, maxPosts: 20, maxLinks: 3, maxTextPerPost: 4000 } })
  assert.deepEqual(fetched, ['300'], 'only the owner’s direct link is fetched')
  assert.deepEqual(githubCalls, [], 'a GitHub link inside a linked post is not opened')
  assert.ok(!out.artifacts.some((a) => a.sourceId === '400'), 'no two-hop post in the context')
})

await test('a derived repository name always keeps its post-id suffix', () => {
  const long = '@Spriite build ' + 'z'.repeat(120) + ' alpha'
  const a = derivedRepositoryName(long, '1845000000000000001')
  const b = derivedRepositoryName(long, '1845000000000000999')
  assert.notEqual(a, b, 'two posts never collide')
  assert.ok(a.endsWith('-0000000001') && b.endsWith('-0000000999'), `suffix kept (${a.slice(-20)})`)
  assert.ok(a.length <= 100 && validRepositoryName(a) && validRepositoryName(b))
  // Partial-truncation range: joined words of 90-99 chars.
  const mid = '@Spriite build ' + 'q'.repeat(94)
  const c = derivedRepositoryName(mid, '1845000000000000001')
  const d = derivedRepositoryName(mid, '1845000000000000002')
  assert.notEqual(c, d)
  assert.ok(c.endsWith('-0000000001') && c.length <= 100)
  assert.equal(derivedRepositoryName('@Spriite build a dark mode toggle', '1844000000000000001'), 'dark-mode-toggle-0000000001',
    'short names are unchanged')
})

console.log(failures ? `${failures} intake fix test(s) FAILED.` : 'All intake fix tests passed.')
if (failures) process.exitCode = 1
