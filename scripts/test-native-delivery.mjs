/**
 * Offline: fake GitHub/Git runners plus a synthetic-object real-Git regression.
 * The real Git fixture uses read-only commands, intercepted remote operations,
 * and dummy credentials; no account configuration or network is used.
 */
import assert from 'node:assert/strict'
import { BrokerError } from '../broker/validation.mjs'
import { createNativeDelivery, createProductionRunner, projectDeliveryState, secretsInDiff, REASONS, DELIVERY_PR_FOOTER } from '../broker/native-delivery.mjs'
import { testTrustedGitBoundary } from './native-delivery-git-fixtures.mjs'

const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), OTHER = 'c'.repeat(40)
const TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const REPO = 'owner/project'
const prepareGitCheckout = async workTree => ({ gitDir: '/tmp/offline-trusted-delivery-git', workTree })

function world(overrides = {}) {
  return {
    dirty: false, head: HEAD, ancestor: true, remote: new Map(), prs: [], checks: [], noChecksReported: false,
    repos: new Map([[REPO, { id: 'R_fixture_reviewed', visibility: 'PRIVATE', isEmpty: false }]]),
    failNext: new Set(), timeoutNext: new Set(), mergeMovesHead: false, pushFails: false, diff: '',
    ...overrides,
  }
}
const ok = (stdout = '') => ({ status: 0, stdout, stderr: `token ${TOKEN}` })
function runners(w) {
  const calls = []
  const take = key => {
    if (w.timeoutNext.has(key)) { w.timeoutNext.delete(key); return { status: null, stdout: '', stderr: '' } }
    if (w.failNext.has(key)) { w.failNext.delete(key); return { status: 2, stdout: TOKEN, stderr: TOKEN } }
    return null
  }
  const git = async (args, opts) => {
    assert.equal(opts.gitEnvironment.GIT_WORK_TREE, opts.cwd)
    assert.equal(opts.gitEnvironment.GIT_DIR, '/tmp/offline-trusted-delivery-git')
    assert.equal(opts.gitEnvironment.GIT_CONFIG_GLOBAL, '/dev/null')
    assert.equal(opts.gitEnvironment.GIT_CONFIG_COUNT, '0')
    calls.push({ bin: 'git', args, opts })
    const credIdx = args.indexOf('ls-remote') >= 0 ? args.indexOf('ls-remote') : args.indexOf('push')
    const cmd = credIdx >= 0 ? args[credIdx] : args[0]
    const forced = take(cmd); if (forced) return forced
    if (cmd === 'status') return ok(w.dirty ? ' M file.txt\n' : '')
    if (cmd === 'rev-parse') return ok(`${w.head}\n`)
    if (cmd === 'merge-base') return { status: w.ancestor ? 0 : 1, stdout: '', stderr: '' }
    if (cmd === 'rev-list') return ok(`${HEAD}\n`)
    if (cmd === 'cat-file') return ok(args[1] === '-t' ? 'blob\n' : w.historyContent ?? 'safe history\n')
    if (cmd === 'diff') {
      assert.deepEqual(args.slice(0, 3), ['diff', '--no-color', '--no-ext-diff'])
      assert.equal(args[3], `${BASE}..${w.head}`)
      return ok(w.diff)
    }
    if (cmd === 'ls-remote') {
      const ref = args.at(-1)
      return ok(w.remote.has(ref) ? `${w.remote.get(ref)}\t${ref}\n` : '')
    }
    if (cmd === 'push') {
      if (w.pushFails) return { status: 1, stdout: '', stderr: TOKEN }
      const [, dst] = args.at(-1).split(':')
      w.remote.set(dst, w.head)
      return ok(`To https://x-access-token:${TOKEN}@github.com/${REPO}.git\n`)
    }
    return { status: 128, stdout: '', stderr: '' }
  }
  const gh = async (args, opts) => {
    calls.push({ bin: 'gh', args, opts })
    const key = `${args[0]} ${args[1]}`
    const forced = take(key); if (forced) return forced
    if (key === 'repo view') {
      const repo = w.repos.get(args[2])
      return repo ? ok(JSON.stringify(repo)) : { status: 1, stdout: '', stderr: `GraphQL: Could not resolve to a Repository with the name '${args[2]}'.` }
    }
    if (key === 'repo create') { w.repos.set(args[2], { id: 'R_fixture_created', visibility: 'PRIVATE', isEmpty: true }); return ok(`https://github.com/${args[2]}`) }
    if (key === 'pr list') {
      const head = args[args.indexOf('--head') + 1]
      return ok(JSON.stringify(w.prs.filter(pr => pr.head === head).map(({ number, url, state, headRefOid, baseRefName = 'main' }) => ({
        number, url, state, headRefOid, headRefName: head, baseRefName,
      }))))
    }
    if (key === 'pr create') {
      const head = args[args.indexOf('--head') + 1]
      const number = w.prs.length + 7
      w.prs.push({ number, url: `https://github.com/${REPO}/pull/${number}`, state: 'OPEN', head, headRefOid: w.remote.get(`refs/heads/${head}`) })
      return ok(`https://github.com/${REPO}/pull/${number}\n`)
    }
    const pr = w.prs.find(p => String(p.number) === args[2])
    if (key === 'pr checks') {
      if (w.noChecksReported) return { status: 1, stdout: '', stderr: `no checks reported on the '${pr.head}' branch` }
      const list = typeof w.checks === 'function' ? w.checks() : w.checks
      const status = list.some(c => c.bucket === 'fail') ? 1 : list.some(c => c.bucket === 'pending') ? 8 : 0
      return { status, stdout: JSON.stringify(list), stderr: '' }
    }
    if (key === 'pr view') return ok(JSON.stringify({ number: pr.number, url: pr.url, headRefName: pr.head,
      baseRefName: pr.baseRefName ?? 'main', headRefOid: pr.headRefOid, state: pr.state, mergeable: 'MERGEABLE' }))
    if (key === 'pr merge') {
      const sha = args[args.indexOf('--match-head-commit') + 1]
      if (w.mergeMovesHead) { pr.headRefOid = OTHER; return { status: 1, stdout: '', stderr: 'head moved' } }
      if (sha !== pr.headRefOid) return { status: 1, stdout: '', stderr: '' }
      pr.state = 'MERGED'
      return ok('')
    }
    return { status: 1, stdout: '', stderr: '' }
  }
  return { gh, git, calls }
}

let tick = 0
const now = () => new Date(Date.parse('2026-10-13T12:00:00.000Z') + (tick++) * 1000).toISOString()
function make(w, extra = {}) {
  const r = runners(w)
  const sleeps = []
  const delivery = createNativeDelivery({ gh: r.gh, git: r.git, now, sleep: ms => { sleeps.push(ms) },
    prepareGitCheckout, verifyPushSafety: () => true, pollAttempts: 3, pollIntervalMs: 10, ...extra })
  return { ...r, delivery, sleeps }
}
const input = (policy = { allowPush: true, allowPr: true, allowMerge: true }, extra = {}) => ({
  missionId: 'm-123', workDir: '/tmp/job/work', repository: REPO, baseRef: 'refs/heads/main', baseSha: BASE,
  policy, title: 'Fix things', body: 'Summary.',
  repositoryIdentity: { repositoryId: 'R_fixture_reviewed', visibility: 'PRIVATE' }, ...extra,
})
const pass = n => Array.from({ length: n }, (_, i) => ({ name: `c${i}`, state: 'SUCCESS', bucket: 'pass' }))

function invariants(calls, state) {
  for (const { bin, args } of calls) {
    assert.ok(!args.some(a => /^--force/.test(a) || a === '-f' || a.startsWith('+')), 'no force push')
    if (bin === 'git') {
      assert.ok(!['config', 'remote', 'credential'].includes(args.find(a => !a.startsWith('-') && !a.startsWith('credential.helper'))), 'no config writes')
      if (args.includes('push')) {
        assert.equal(args.at(-1), `${HEAD}:refs/heads/spriite/m-123`)
        assert.ok(!args.includes('--no-verify'))
        assert.ok(args.includes('credential.helper=!gh auth git-credential'))
        assert.equal(args.at(-2), `https://github.com/${REPO}.git`)
      }
      assert.ok(!args.some(a => a.includes('@github.com')), 'no userinfo in remote')
    }
    assert.ok(!(bin === 'gh' && args[0] === 'pr' && args[1] === 'merge' && !args.includes('--match-head-commit')))
  }
  if (state) {
    const text = JSON.stringify(state)
    assert.ok(!text.includes(TOKEN) && !/gh[pousr]_[A-Za-z0-9]{20,}/.test(text), 'no token in state')
    assert.ok(Object.isFrozen(state))
    assert.ok(Number.isFinite(Date.parse(state.updatedAt)))
  }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('happy path pushes, opens PR, waits checks and squash merges', async () => {
  const w = world({ checks: pass(2) })
  const t = make(w)
  const s = await t.delivery.deliver(input())
  assert.equal(s.step, 'merged'); assert.equal(s.branch, 'spriite/m-123'); assert.equal(s.headSha, HEAD)
  assert.equal(s.prNumber, 7); assert.deepEqual(s.checks, { total: 2, passed: 2, failed: 0, pending: 0 })
  const create = t.calls.find(c => c.args[1] === 'create')
  assert.equal(create.args[create.args.indexOf('--base') + 1], 'main')
  assert.ok(create.args[create.args.indexOf('--body') + 1].endsWith(DELIVERY_PR_FOOTER))
  const merge = t.calls.find(c => c.args[1] === 'merge')
  assert.deepEqual(merge.args.slice(-3), ['--squash', '--match-head-commit', HEAD])
  assert.ok(t.calls.every(c => c.opts.timeoutMs > 0))
  invariants(t.calls, s)
  const p = projectDeliveryState(s)
  assert.deepEqual(Object.keys(p).sort(), ['branch', 'checks', 'headSha', 'prNumber', 'prUrl', 'step', 'updatedAt'])
  const again = await t.delivery.resume(s)
  assert.equal(again.step, 'merged')
})

test('zero checks gives not_merged No checks configured', async () => {
  for (const variant of [{ checks: [] }, { noChecksReported: true }]) {
    const t = make(world(variant))
    const s = await t.delivery.deliver(input())
    assert.equal(s.step, 'not_merged'); assert.equal(s.reason, 'No checks configured')
    assert.ok(!t.calls.some(c => c.args[1] === 'merge'))
    invariants(t.calls, s)
  }
})

test('failing checks never merge', async () => {
  const t = make(world({ checks: [...pass(1), { name: 'x', state: 'FAILURE', bucket: 'fail' }] }))
  const s = await t.delivery.deliver(input())
  assert.equal(s.step, 'checks_failed'); assert.equal(s.checks.failed, 1)
  assert.ok(!t.calls.some(c => c.args[1] === 'merge'))
  invariants(t.calls, s)
})

test('skipping checks are not passing and do not merge', async () => {
  const t = make(world({ checks: [...pass(1), { name: 's', state: 'SKIPPED', bucket: 'skipping' }] }))
  const s = await t.delivery.deliver(input())
  assert.equal(s.step, 'not_merged'); assert.equal(s.reason, REASONS.checksSkipped)
})

test('pending checks exhaust the poll budget then pass across resume', async () => {
  const w = world({ checks: [{ name: 'c', state: 'IN_PROGRESS', bucket: 'pending' }] })
  const t = make(w)
  const s = await t.delivery.deliver(input())
  assert.equal(s.step, 'checks_pending'); assert.equal(s.checks.pending, 1)
  assert.deepEqual(t.sleeps, [10, 10])
  const persisted = JSON.parse(JSON.stringify(s))
  w.checks = pass(1)
  const t2 = { ...runners(w) }
  const d2 = createNativeDelivery({ gh: t2.gh, git: t2.git, now, sleep: () => {}, prepareGitCheckout })
  const r = await d2.resume(persisted)
  assert.equal(r.step, 'merged')
  assert.ok(!t2.calls.some(c => c.args.includes('push') || c.args[1] === 'create'), 'no repeat push/create')
  invariants(t2.calls, r)
})

test('pending then pass within one poll budget', async () => {
  let n = 0
  const t = make(world({ checks: () => (n++ < 1 ? [{ name: 'c', bucket: 'pending' }] : pass(1)) }))
  const s = await t.delivery.deliver(input())
  assert.equal(s.step, 'merged'); assert.deepEqual(t.sleeps, [10])
})

test('head moved before merge is not merged', async () => {
  const w = world({ checks: pass(1) })
  const t = make(w, { pollAttempts: 1 })
  w.checks = () => { w.prs[0].headRefOid = OTHER; return pass(1) }
  const s = await t.delivery.deliver(input())
  assert.equal(s.step, 'not_merged'); assert.equal(s.reason, REASONS.headMoved)
  assert.ok(!t.calls.some(c => c.args[1] === 'merge'))
})

test('head moved during merge is reported, not guessed', async () => {
  const t = make(world({ checks: pass(1), mergeMovesHead: true }))
  const s = await t.delivery.deliver(input())
  assert.equal(s.step, 'not_merged'); assert.equal(s.reason, REASONS.headMoved)
})

test('existing open PR for branch is reused', async () => {
  const w = world({ checks: pass(1) })
  w.remote.set('refs/heads/spriite/m-123', HEAD)
  w.prs.push({ number: 3, url: `https://github.com/${REPO}/pull/3`, state: 'OPEN', head: 'spriite/m-123', headRefOid: HEAD })
  const t = make(w)
  const s = await t.delivery.deliver(input())
  assert.equal(s.step, 'merged'); assert.equal(s.prNumber, 3)
  assert.ok(!t.calls.some(c => c.args[1] === 'create' || c.args.includes('push')))
})

test('extra PRs from the delivery branch narrow to the recorded PR or base, ambiguity fails closed', async () => {
  const foreign = number => ({ number, url: `https://github.com/${REPO}/pull/${number}`, state: 'OPEN',
    head: 'spriite/m-123', headRefOid: OTHER, baseRefName: 'release' })
  // A second PR against another base appears while ours waits on checks.
  const w = world({ checks: [{ name: 'c', bucket: 'pending' }] })
  const pending = await make(w).delivery.deliver(input())
  assert.equal(pending.step, 'checks_pending')
  w.prs.push(foreign(40)); w.checks = pass(1)
  const t = make(w)
  const merged = await t.delivery.resume(JSON.parse(JSON.stringify(pending)))
  assert.equal(merged.step, 'merged'); assert.equal(merged.prNumber, pending.prNumber)
  assert.ok(!t.calls.some(c => c.args.includes('push') || c.args[1] === 'create'))
  invariants(t.calls, merged)

  // Before any PR is recorded, an exact open PR is still found beside a foreign PR to another base.
  const w2 = world({ checks: pass(1) })
  w2.remote.set('refs/heads/spriite/m-123', HEAD)
  w2.prs.push(foreign(41), { number: 3, url: `https://github.com/${REPO}/pull/3`, state: 'OPEN', head: 'spriite/m-123', headRefOid: HEAD })
  const t2 = make(w2)
  const fresh = await t2.delivery.deliver(input())
  assert.equal(fresh.step, 'merged', fresh.reason); assert.equal(fresh.prNumber, 3)
  assert.ok(!t2.calls.some(c => c.args.includes('push') || c.args[1] === 'create'))

  // Two candidates against our own base remain ambiguous: hold, never push or merge.
  const w3 = world({ checks: pass(1) })
  w3.prs.push({ ...foreign(42), baseRefName: 'main' }, { ...foreign(43), baseRefName: 'main' })
  const t3 = make(w3)
  const ambiguous = await t3.delivery.deliver(input())
  assert.equal(ambiguous.step, 'held')
  assert.ok(!t3.calls.some(c => c.args.includes('push') || ['create', 'merge'].includes(c.args[1])))

  // A recorded PR number that no longer appears fails closed instead of opening a new PR.
  const w4 = world({ checks: [{ name: 'c', bucket: 'pending' }] })
  const recorded = await make(w4).delivery.deliver(input())
  w4.prs = [foreign(44), foreign(45)]
  const t4 = make(w4)
  const lost = await t4.delivery.resume(JSON.parse(JSON.stringify(recorded)))
  assert.equal(lost.step, 'pr_open')
  assert.ok(!t4.calls.some(c => c.args.includes('push') || ['create', 'merge'].includes(c.args[1])))
})

test('already pushed branch at same sha is not pushed again', async () => {
  const w = world({ checks: pass(1) })
  w.remote.set('refs/heads/spriite/m-123', HEAD)
  const t = make(w)
  const s = await t.delivery.deliver(input())
  assert.equal(s.step, 'merged')
  assert.ok(!t.calls.some(c => c.args.includes('push')))
})

test('remote branch at different sha holds without force', async () => {
  const w = world()
  w.remote.set('refs/heads/spriite/m-123', OTHER)
  const t = make(w)
  const s = await t.delivery.deliver(input())
  assert.equal(s.step, 'held'); assert.equal(s.reason, REASONS.remoteDiverged)
  assert.ok(!t.calls.some(c => c.args.includes('push')))
})

test('no commits, dirty tree and non-descendant hold', async () => {
  for (const [w, reason] of [[world({ head: BASE }), 'No commits to deliver'], [world({ dirty: true }), REASONS.dirty], [world({ ancestor: false }), REASONS.notDescendant]]) {
    const t = make(w)
    const s = await t.delivery.deliver(input())
    assert.equal(s.step, 'held'); assert.equal(s.reason, reason)
    assert.ok(!t.calls.some(c => c.bin === 'gh' || c.args.includes('push') || c.args.includes('ls-remote')))
    invariants(t.calls, s)
  }
})

test('policy flag combinations', async () => {
  let t = make(world())
  let s = await t.delivery.deliver(input({ allowPush: false, allowPr: false, allowMerge: false }))
  assert.equal(s.step, 'held'); assert.equal(s.reason, 'Delivery not allowed by policy')
  assert.ok(!t.calls.some(c => c.bin === 'gh' || c.args.includes('push')))

  t = make(world())
  s = await t.delivery.deliver(input({ allowPush: true, allowPr: false, allowMerge: false }))
  assert.equal(s.step, 'pushed'); assert.ok(!t.calls.some(c => c.bin === 'gh' && c.args[0] === 'pr'))
  const r = await t.delivery.resume(s)
  assert.equal(r.step, 'pushed'); assert.equal(t.calls.filter(c => c.args.includes('push')).length, 1)

  t = make(world({ checks: pass(1) }))
  s = await t.delivery.deliver(input({ allowPush: true, allowPr: true, allowMerge: false }))
  assert.equal(s.step, 'pr_open'); assert.equal(s.reason, REASONS.mergeNotAllowed)
  assert.ok(!t.calls.some(c => c.args[1] === 'merge'))

  for (const bad of [{ allowPush: false, allowPr: true, allowMerge: false }, { allowPush: true, allowPr: false, allowMerge: true }, { allowPush: true, allowPr: true }, { allowPush: 'yes', allowPr: false, allowMerge: false }]) {
    await assert.rejects(make(world()).delivery.deliver(input(bad)), BrokerError)
  }
})

test('input validation', async () => {
  const d = make(world()).delivery
  for (const extra of [{ missionId: '../x' }, { missionId: 'a:b' }, { repository: 'owner' }, { repository: 'o/../x' }, { baseSha: 'abc' },
    { workDir: 'rel' }, { baseRef: 'refs/tags/v1' }, { baseRef: 'spriite/x' }, { title: 'a\nb' }]) {
    await assert.rejects(d.deliver(input(undefined, extra)), BrokerError)
  }
})

test('timeouts and failures leave resumable states', async () => {
  const w = world({ checks: pass(1) })
  w.timeoutNext.add('push')
  const t = make(w)
  let s = await t.delivery.deliver(input())
  assert.equal(s.step, 'held'); assert.match(s.reason, /resume/)
  w.failNext.add('pr create')
  s = await t.delivery.resume(JSON.parse(JSON.stringify(s)))
  assert.equal(s.step, 'pushed'); assert.match(s.reason, /pull request creation/)
  w.timeoutNext.add('pr checks')
  s = await t.delivery.resume(JSON.parse(JSON.stringify(s)))
  assert.equal(s.step, 'checks_pending'); assert.ok(s.prNumber)
  w.timeoutNext.add('pr view')
  s = await t.delivery.resume(JSON.parse(JSON.stringify(s)))
  assert.equal(s.step, 'pr_open'); assert.match(s.reason, /merge/)
  s = await t.delivery.resume(JSON.parse(JSON.stringify(s)))
  assert.equal(s.step, 'merged')
  assert.equal(w.prs.length, 1)
  assert.equal(t.calls.filter(c => c.args.includes('push')).length, 2)
  invariants(t.calls, s)
  const gitFail = make(world({ pushFails: true }))
  const g = await gitFail.delivery.deliver(input())
  assert.equal(g.step, 'held'); invariants(gitFail.calls, g)
  const thrower = createNativeDelivery({ gh: async () => { throw new Error(TOKEN) }, git: async () => { throw new Error(TOKEN) }, now, sleep: () => {} })
  const th = await thrower.deliver(input())
  assert.equal(th.step, 'held'); assert.ok(!JSON.stringify(th).includes(TOKEN))
})

const diffWith = (added, file = 'src/app.js') =>
  `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,3 @@\n const x = 1\n${added.map(line => `+${line}`).join('\n')}\n const y = 2\n`

test('secret in an added line holds and never pushes', async () => {
  for (const secret of ['sk-liveABCDEFGHIJKLMNOPQRSTUV', `ghp_${'T'.repeat(36)}`, `github_pat_${'P'.repeat(30)}`]) {
    const w = world({ diff: diffWith([`const key = "${secret}"`]) })
    const t = make(w)
    const s = await t.delivery.deliver(input())
    assert.equal(s.step, 'held')
    assert.equal(s.reason, 'Credential-shaped content in delivered history')
    assert.ok(!t.calls.some(c => c.bin === 'gh' || c.args.includes('push') || c.args.includes('ls-remote')))
    const text = JSON.stringify(s)
    assert.ok(!text.includes(secret) && !/gh[pousr]_[A-Za-z0-9]{20,}/.test(text) && !/github_pat_/.test(text))
    // resume re-runs the gate deterministically
    const r = await t.delivery.resume(JSON.parse(JSON.stringify(s)))
    assert.equal(r.step, 'held'); assert.equal(r.reason, s.reason)
    invariants(t.calls, s)
  }
})

test('secret-like text in context or removed lines does not block', async () => {
  const secret = `ghp_${'C'.repeat(36)}`
  let w = world({ diff: `diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1,3 +1,3 @@\n const token = "${secret}"\n-const old = "sk-${'O'.repeat(24)}"\n+const fresh = 1\n` })
  let t = make(w)
  let s = await t.delivery.deliver(input({ allowPush: true, allowPr: false, allowMerge: false }))
  assert.equal(s.step, 'pushed')
  // base64-ish blobs and deleted files are not flagged
  w = world({ diff: `diff --git a/data.bin b/data.bin\n--- a/data.bin\n+++ b/data.bin\n@@ -0,0 +1 @@\n+QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\ndiff --git a/old.pem b/old.pem\ndeleted file mode 100644\n--- a/old.pem\n+++ /dev/null\n@@ -1 +0,0 @@\n-----BEGIN PRIVATE KEY-----\n` })
  t = make(w)
  s = await t.delivery.deliver(input({ allowPush: true, allowPr: false, allowMerge: false }))
  assert.equal(s.step, 'pushed')
})

test('secretsInDiff unit coverage', () => {
  assert.deepEqual(secretsInDiff(undefined), [])
  assert.deepEqual(secretsInDiff('no diff'), [])
  assert.deepEqual(secretsInDiff(diffWith([`api_key = "fk-${'F'.repeat(24)}"`], 'a.txt')), ['a.txt'])
  const many = Array.from({ length: 12 }, (_, i) => diffWith([`k = "AKIA${'A'.repeat(16)}"`], `f${i}.txt`)).join('')
  assert.equal(secretsInDiff(many).length, 10)
})

test('resume after merge with branch deleted reports merged', async () => {
  const w = world({ checks: pass(1) })
  const t = make(w)
  const s = await t.delivery.deliver(input())
  w.remote.clear()
  const pending = { ...JSON.parse(JSON.stringify(s)), step: 'checks_pending' }
  assert.equal((await t.delivery.resume(pending)).step, 'merged')
  await assert.rejects(t.delivery.resume({ ...pending, branch: 'main' }), BrokerError)
  await assert.rejects(t.delivery.resume({ ...pending, extra: 1 }), BrokerError)
})

test('createPrivateRepository validates names and refuses existing public or non-empty', async () => {
  const w = world()
  const t = make(w)
  const created = await t.delivery.createPrivateRepository({ account: 'owner', name: 'fresh-repo' })
  assert.deepEqual(created, { repositoryUrl: 'https://github.com/owner/fresh-repo', created: true })
  assert.deepEqual(t.calls.find(c => c.args[1] === 'create').args, ['repo', 'create', 'owner/fresh-repo', '--private'])
  const reused = await t.delivery.createPrivateRepository({ account: 'owner', name: 'fresh-repo' })
  assert.equal(reused.created, false)
  w.repos.set('owner/public', { visibility: 'PUBLIC', isEmpty: true })
  w.repos.set('owner/full', { visibility: 'PRIVATE', isEmpty: false })
  for (const name of ['public', 'full']) {
    await assert.rejects(t.delivery.createPrivateRepository({ account: 'owner', name }), e => e.code === 'native_delivery_repository_exists')
  }
  for (const bad of [{ account: 'owner', name: '..' }, { account: 'owner', name: 'a b' }, { account: 'owner', name: 'x.git' }, { account: '-o', name: 'x' },
    { account: 'o/o', name: 'x' }, { account: 'owner', name: '--public' }, { account: 'owner', name: 'x', visibility: 'public' }]) {
    await assert.rejects(t.delivery.createPrivateRepository(bad), BrokerError)
  }
  w.timeoutNext.add('repo view')
  await assert.rejects(t.delivery.createPrivateRepository({ account: 'owner', name: 'later' }), e => e.code === 'native_delivery_repository_unavailable')
  assert.equal(t.calls.filter(c => c.args[1] === 'create').length, 1)
})

test('production runner uses no shell, bounded env and timeout', async () => {
  let seen
  const port = (bin, args, opts, cb) => { seen = { bin, args, opts }; cb(null, 'out', '') }
  const run = createProductionRunner('/usr/bin/gh', { execFilePort: port, env: { PATH: '/bin', HOME: '/h', GH_TOKEN: 't', SECRET: 'x', SSH_AUTH_SOCK: 's' } })
  const r = await run(['pr', 'list'], { cwd: '/tmp', timeoutMs: 5 })
  assert.deepEqual(r, { status: 0, stdout: 'out', stderr: '' })
  assert.equal(seen.opts.shell, false); assert.equal(seen.opts.timeout, 5)
  assert.ok(!('SECRET' in seen.opts.env) && !('SSH_AUTH_SOCK' in seen.opts.env)); assert.equal(seen.opts.env.GIT_TERMINAL_PROMPT, '0')
  const killed = createProductionRunner('/usr/bin/gh', { execFilePort: (b, a, o, cb) => cb(Object.assign(new Error('t'), { killed: true }), TOKEN, TOKEN) })
  assert.deepEqual(await killed(['x'], { timeoutMs: 5 }), { status: null, stdout: '', stderr: '' })
  assert.throws(() => createProductionRunner('gh'), BrokerError)
})

function journalFixture(kind, phase) {
  const records = new Map()
  let checkpoint, triggered = false
  const journal = {
    identity: { ownerId: 'owner', machineId: 'machine', missionId: 'm-123', scopeHash: 'd'.repeat(64),
      policyHash: 'e'.repeat(64), baseRef: 'main', baseSha: BASE },
    read: id => structuredClone(records.get(id) ?? null),
    list: () => [...records.values()].map(row => structuredClone(row)),
    save: (row, state) => {
      const hit = !triggered && row.identity.kind === kind &&
        (phase === 'pre-save' || phase === 'before-effect' ? row.state === 'intent' : row.state === 'confirmed')
      if (hit) triggered = true
      if (hit && ['pre-save', 'after-effect'].includes(phase)) throw new Error('simulated crash')
      records.set(row.effectId, structuredClone(row))
      if (state) checkpoint = structuredClone(state)
      if (hit) throw new Error('simulated crash after durable save')
    },
  }
  return { journal, records, get checkpoint() { return checkpoint } }
}

for (const kind of ['create_repository', 'initial_seed_push', 'branch_push', 'pr_create', 'pr_merge']) {
  for (const phase of ['pre-save', 'before-effect', 'after-effect', 'after-receipt']) {
    test(`durable crash matrix ${kind} ${phase}`, async () => {
      const w = world({ checks: pass(1), ...(['create_repository', 'initial_seed_push'].includes(kind) ? { repos: new Map() } : {}) }),
        j = journalFixture(kind, phase), context = { journal: j.journal }
      let t = make(w)
      const create = () => t.delivery.createPrivateRepository({ account: 'owner', name: 'project' }, context)
      const seed = () => t.delivery.pushInitialSeed({ missionId: 'm-123', workDir: '/tmp/job/work',
        repository: REPO, baseRef: 'main', baseSha: BASE }, context)
      if (kind === 'initial_seed_push') await create()
      let result
      if (kind === 'create_repository') { try { result = await create() } catch {} }
      else if (kind === 'initial_seed_push') { w.head = BASE; try { result = await seed() } catch {} }
      else result = await t.delivery.deliver(input(), context)
      const countEffects = calls => calls.filter(c => c.args.includes('push') || ['repo create', 'pr create', 'pr merge'].includes(c.args.slice(0, 2).join(' '))).length
      const beforeCount = countEffects(t.calls)
      const priorRecords = [...j.records.values()].filter(row => row.identity.kind === kind)
      if (phase === 'pre-save') assert.equal(priorRecords.length, 0)
      else assert.equal(priorRecords[0].state, phase === 'after-receipt' ? 'confirmed' : 'intent')
      const oldCalls = t.calls
      t = make(w)
      if (kind === 'create_repository') { try { result = await create() } catch { result = null } }
      else if (kind === 'initial_seed_push') { try { result = await seed() } catch { result = null } }
      else result = j.checkpoint ? await t.delivery.resume(j.checkpoint, context) : await t.delivery.deliver(input(), context)
      const targetDispatch = c => kind === 'create_repository' ? c.args.slice(0, 2).join(' ') === 'repo create' :
        kind === 'pr_create' ? c.args.slice(0, 2).join(' ') === 'pr create' :
        kind === 'pr_merge' ? c.args.slice(0, 2).join(' ') === 'pr merge' : c.args.includes('push')
      if (phase !== 'pre-save') assert.equal(t.calls.filter(targetDispatch).length, 0, 'ambiguous intent never replayed')
      if (phase === 'before-effect' || (kind === 'create_repository' && phase === 'after-effect')) {
        if (['create_repository', 'initial_seed_push'].includes(kind)) assert.equal(result, null)
        else assert.notEqual(result.step, 'merged')
      } else {
        if (['create_repository', 'initial_seed_push'].includes(kind)) assert.ok(result)
        else assert.equal(result.step, 'merged')
      }
      assert.ok(beforeCount >= 0 && oldCalls.length > 0)
      assert.ok(!JSON.stringify(j.journal.list()).includes(TOKEN))
    })
  }
}

test('read-only reconciliation failure never repeats ambiguous effect', async () => {
  const w = world({ checks: pass(1) }), j = journalFixture('branch_push', 'after-effect')
  const t = make(w)
  await t.delivery.deliver(input(), { journal: j.journal })
  const resume = make(w)
  w.timeoutNext.add('ls-remote')
  const held = await resume.delivery.resume(j.checkpoint, { journal: j.journal })
  assert.notEqual(held.step, 'merged')
  assert.ok(!resume.calls.some(c => c.args.includes('push') || ['create', 'merge'].includes(c.args[1])))
})

test('committed then removed credentials, binary blobs and secret filenames are held without disclosure', async () => {
  const secret = `ghp_${'Q'.repeat(36)}`
  for (const historyContent of [`intermediate commit ${secret}`, `100644 blob ${HEAD}\t${secret}.txt`, 'binary\0content', 'invalid\uFFFDtext']) {
    const t = make(world({ historyContent }))
    const s = await t.delivery.deliver(input())
    assert.equal(s.step, 'held')
    assert.ok(!JSON.stringify(s).includes(secret))
    assert.ok(!t.calls.some(c => c.args.includes('push') || c.bin === 'gh'))
  }
})

test('foreign and wrong-head merged records are not delivery evidence', async () => {
  for (const extra of [{ url: 'https://github.com/foreign/repo/pull/3' }, { headRefOid: OTHER }, { baseRefName: 'other' }]) {
    const w = world({ prs: [{ number: 3, url: `https://github.com/${REPO}/pull/3`, state: 'MERGED',
      head: 'spriite/m-123', headRefOid: HEAD, ...extra }] })
    const t = make(w)
    assert.equal((await t.delivery.deliver(input())).step, 'not_merged')
    assert.ok(!t.calls.some(c => c.args.includes('push') || c.args[1] === 'merge'))
  }
})

test('adopted empty repository cannot be implicitly seeded', async () => {
  const w = world({ repos: new Map([[REPO, { visibility: 'PRIVATE', isEmpty: true }]]) })
  const t = make(w), j = journalFixture()
  assert.equal((await t.delivery.createPrivateRepository({ account: 'owner', name: 'project' }, { journal: j.journal })).created, false)
  await assert.rejects(t.delivery.pushInitialSeed({ missionId: 'm-123', repository: REPO,
    workDir: '/tmp/job/work', baseRef: 'main', baseSha: BASE }, { journal: j.journal }),
  e => e.code === 'native_delivery_seed_not_created')
  assert.ok(!t.calls.some(c => c.args.includes('push')))
})

test('unsafe hook gate prevents external push without bypassing hooks', async () => {
  const t = make(world(), { verifyPushSafety: () => false })
  assert.equal((await t.delivery.deliver(input())).step, 'held')
  assert.ok(!t.calls.some(c => c.args.includes('push') || c.args.includes('--no-verify')))
})

test('lost runner responses reconcile exact evidence without redispatch or output disclosure', async () => {
  for (const kind of ['create_repository', 'branch_push', 'pr_create', 'pr_merge']) {
    const w = world({ checks: pass(1), ...(kind === 'create_repository' ? { repos: new Map() } : {}) }), r = runners(w), j = journalFixture()
    const lose = async (runner, args, opts) => {
      const result = await runner(args, opts)
      const target = kind === 'branch_push' ? args.includes('push') :
        args.slice(0, 2).join(' ') === { create_repository: 'repo create', pr_create: 'pr create', pr_merge: 'pr merge' }[kind]
      return target ? { status: null, stdout: TOKEN, stderr: TOKEN } : result
    }
    const d = createNativeDelivery({ gh: (args, opts) => lose(r.gh, args, opts),
      git: (args, opts) => lose(r.git, args, opts), now, sleep: () => {}, verifyPushSafety: () => true, prepareGitCheckout })
    if (kind === 'create_repository') {
      await assert.rejects(d.createPrivateRepository({ account: 'owner', name: 'project' }, { journal: j.journal }),
        error => error.code === 'native_delivery_repository_creation_unknown')
      await assert.rejects(d.createPrivateRepository({ account: 'owner', name: 'project' }, { journal: j.journal }))
      assert.equal(r.calls.filter(c => c.args.slice(0, 2).join(' ') === 'repo create').length, 1)
    } else {
      assert.equal((await d.deliver(input(), { journal: j.journal })).step, 'merged')
      assert.equal(j.journal.list().find(row => row.identity.kind === kind).state, 'confirmed')
    }
    assert.ok(!JSON.stringify(j.journal.list()).includes(TOKEN))
  }
})

test('history read timeouts and configured hooks fail closed before push', async () => {
  for (const operation of ['rev-list', 'cat-file']) {
    const w = world(); w.timeoutNext.add(operation)
    const t = make(w)
    assert.equal((await t.delivery.deliver(input())).step, 'held')
    assert.ok(!t.calls.some(c => c.args.includes('push')))
  }
  const w = world(), r = runners(w)
  const d = createNativeDelivery({ gh: r.gh, git: r.git, now, sleep: () => {},
    prepareGitCheckout: async () => { throw new Error('configured hook rejected before Git') } })
  assert.equal((await d.deliver(input())).step, 'held')
  assert.ok(!r.calls.some(c => c.args.includes('push') || c.args.includes('--no-verify')))
})

test('same-name replacement repository is never treated as the durably created repository', async () => {
  const w = world({ repos: new Map() }), t = make(w), j = journalFixture(), context = { journal: j.journal }
  await t.delivery.createPrivateRepository({ account: 'owner', name: 'project' }, context)
  w.repos.set(REPO, { id: 'R_foreign_replacement', visibility: 'PRIVATE', isEmpty: true })
  await assert.rejects(t.delivery.createPrivateRepository({ account: 'owner', name: 'project' }, context),
    error => error.code === 'native_delivery_repository_unverified')
  await assert.rejects(t.delivery.pushInitialSeed({ missionId: 'm-123', repository: REPO,
    workDir: '/tmp/job/work', baseRef: 'main', baseSha: BASE }, context),
  error => error.code === 'native_delivery_repository_unverified')
  assert.ok(!t.calls.some(c => c.args.includes('push')))
})

for (const kind of ['branch_push', 'pr_create', 'pr_merge']) {
  test(`repository replacement across durable ${kind} intent never dispatches against the replacement`, async () => {
    const w = world({ checks: pass(1) }), j = journalFixture(), save = j.journal.save
    j.journal.save = (row, checkpoint) => {
      save(row, checkpoint)
      if (row.identity.kind === kind && row.state === 'intent')
        w.repos.set(REPO, { id: 'R_public_replacement', visibility: 'PUBLIC', isEmpty: true })
    }
    const t = make(w), state = await t.delivery.deliver(input(), { journal: j.journal })
    assert.equal(state.step, 'held')
    assert.equal(state.reason, 'Repository identity or visibility cannot be verified')
    const dispatch = c => kind === 'branch_push' ? c.args.includes('push') :
      c.args.slice(0, 2).join(' ') === (kind === 'pr_create' ? 'pr create' : 'pr merge')
    assert.equal(t.calls.filter(dispatch).length, 0)
    const restarted = make(w)
    const resumed = await restarted.delivery.resume(j.checkpoint, { journal: j.journal })
    assert.equal(resumed.step, 'held')
    assert.ok(!restarted.calls.some(c => c.args.includes('push') || ['create', 'merge'].includes(c.args[1])))
  })
}

test('created repository identity remains private through the completed mission and delivery', async () => {
  const w = world({ repos: new Map() }), j = journalFixture(), context = { journal: j.journal }, t = make(w)
  await t.delivery.createPrivateRepository({ account: 'owner', name: 'project' }, context)
  w.head = BASE
  await t.delivery.pushInitialSeed({ missionId: 'm-123', repository: REPO, workDir: '/tmp/job/work', baseRef: 'main', baseSha: BASE }, context)
  w.head = HEAD; w.repos.set(REPO, { id: 'R_replacement', visibility: 'PUBLIC', isEmpty: true })
  const before = t.calls.length
  assert.equal((await t.delivery.deliver(input(undefined, { repositoryIdentity: undefined }), context)).step, 'held')
  assert.ok(!t.calls.slice(before).some(c => c.args.includes('push') || ['create', 'merge'].includes(c.args[1])))
})

test('repository read failure, absent reviewed identity and visibility-only replacement fail closed', async () => {
  for (const mode of ['read-failure', 'missing-identity', 'visibility-moved']) {
    const w = world()
    if (mode === 'read-failure') w.timeoutNext.add('repo view')
    if (mode === 'visibility-moved') w.repos.get(REPO).visibility = 'PUBLIC'
    const t = make(w)
    const state = await t.delivery.deliver(input(undefined, mode === 'missing-identity' ? { repositoryIdentity: undefined } : {}))
    assert.equal(state.step, 'held')
    assert.ok(!t.calls.some(c => c.args.includes('push') || ['create', 'merge'].includes(c.args[1])))
  }
})

test('merged PR evidence from a same-slug repository replacement is never accepted', async () => {
  const w = world({ checks: pass(1) }), t = make(w)
  const merged = await t.delivery.deliver(input())
  w.repos.set(REPO, { id: 'R_public_replacement', visibility: 'PUBLIC', isEmpty: false })
  assert.equal((await make(w).delivery.resume(merged)).step, 'held')
})

test('real Git ignores malicious local and ambient configuration before its first checkout operation', testTrustedGitBoundary)

let failed = 0
for (const { name, fn } of tests) {
  try { await fn(); console.log(`PASS: ${name}`) } catch (error) { failed++; console.log(`FAIL: ${name}`); console.log(error) }
}
console.log(`${tests.length - failed}/${tests.length} native delivery tests passed`)
if (failed) process.exit(1)
