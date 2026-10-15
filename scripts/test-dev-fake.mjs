import assert from 'node:assert/strict'
import { fakeClients, FAKE } from '../src/factory/fake.ts'
import { RealOrchestrator } from '../src/factory/real.ts'
import { runtimeBootGuard } from './walkthrough-runtime.mjs'

const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Unexpected network in offline dev-fake qualification') }
let scenarios = 0

{
  const provider = fakeClients({ sessionOptions: true })
  const rows = await provider.listFactorySessions()
  assert.equal(rows.length, 3)
  assert.equal((await provider.getSession('qa-idle')).status, 'idle')
  assert.equal((await provider.getSession('qa-running')).status, 'running')
  assert.equal(rows.find(r => r.sessionId === 'qa-readonly').computerId, '')
  assert.ok((await provider.getMessages('qa-idle'))[0].text.includes('HISTORY END'))
  assert.equal(provider.sessionControls.inspect().creates, 0)
  await provider.postMessage('qa-idle', 'Continue the current conversation.')
  assert.deepEqual(provider.sessionControls.inspect().posts, [{ sessionId: 'qa-idle', continuation: true }])
  const beforeTimeout = await provider.getMessages('qa-idle')
  provider.sessionControls.timeoutNextPost('qa-idle')
  await assert.rejects(provider.postMessage('qa-idle', 'Continue the current conversation.'), e => e.kind === 'timeout')
  assert.deepEqual(await provider.getMessages('qa-idle'), beforeTimeout, 'synthetic timeout never fabricates delivery evidence')
  provider.sessionControls.setStatus('qa-idle', 'unknown')
  assert.equal((await provider.getSession('qa-idle')).status, 'unknown')
  provider.sessionControls.setStatus('qa-idle', 'unreachable')
  await assert.rejects(provider.getSession('qa-idle'), e => e.kind === 'network')
  scenarios++
  console.log('PASS: dev session-options fixture uses synthetic sessions, history, continuation and status outages')
}

// Exercise the exact dev provider, not a second hand-written fake.
for (const [workerPref, jobs] of [['auto', 1], ['factory', 1], ['factory', 2]]) {
  const repo = jobs > 1 ? 'https://github.com/example/dev-integration-repository' : FAKE.repoUrl
  const provider = fakeClients({ offlineOnce: true })
  const posts = []
  const clients = { ...provider, postMessage: async (id, text, computer) => {
    posts.push({ id, text })
    return provider.postMessage(id, text, computer)
  } }
  const e = new RealOrchestrator(() => {}, {
    ...FAKE, repoUrl: repo, workerPref, jobs, askBeforePr: true, clients,
    missionId: `dev-test-${workerPref}-${jobs}`,
  })
  e.boot()
  e.voiceGoal('Deliver the empty-state screen', 10)
  await e.startPlanning()
  assert.equal(e.snapshot().faultKind, 'offline')
  e.handleAction('retry')
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0))
  await e.pollLead()
  assert.equal(e.snapshot().planLabels.length, 2)
  await e.startBuild()
  e.pauseToggle()
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0))
  e.pauseToggle()
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 20; i++) {
    for (const j of e.jobs) await e.pollJob(j)
    await new Promise((r) => setTimeout(r, 0))
    await e.pollLead()
  }
  if (!e.snapshot().decisionPending) {
    console.log(JSON.stringify({ workerPref, snapshot: e.snapshot(), posts,
      leadMessages: await provider.getMessages(e.snapshot().sessionId) }, null, 2))
  }
  assert.equal(e.snapshot().decisionKind, 'pr', `${workerPref}: review reaches PR gate`)
  assert.equal(e.snapshot().decisionPending, true, `${workerPref}: PR waits for owner`)
  assert.equal(e.snapshot().jobs[0].branch,
    `spriite/dev-test-${workerPref}-${jobs}/${jobs > 1 ? 'integration' : 'job-1'}`)
  const verdict = posts.find((p) => p.text.includes('VERDICT_READY'))
  assert.ok(verdict, 'real engine requested a correlated verdict')
  const token = /"REQUEST: ([^"]+)"/.exec(verdict.text)?.[1]
  assert.ok((await provider.getMessages(verdict.id)).some((m) =>
    m.role === 'assistant' && m.text.endsWith(`REQUEST: ${token}\nVERDICT_READY`)))
  e.handleAction('open_pr')
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 20; i++) {
    for (const j of e.jobs) await e.pollJob(j)
    await e.pollLead()
    await new Promise((r) => setTimeout(r, 0))
  }
  assert.equal(e.snapshot().phase, 'final', `${workerPref}: owner approval reaches final`)
  assert.equal(e.snapshot().prUrl, `${repo}/pull/9`)
  assert.equal(posts.filter((p) => p.text.startsWith('The review passed.')).length,
    workerPref === 'factory' ? 1 : 0, 'only one Factory PR request is sent')
  for (const p of posts.filter((p) => /final line exactly (VERDICT_READY|WORK_READY)/.test(p.text))) {
    const request = /"REQUEST: ([^"]+)"/.exec(p.text)?.[1]
    const marker = /final line exactly (\w+)/.exec(p.text)?.[1]
    assert.ok(request && marker)
    assert.ok((await provider.getMessages(p.id)).some((m) =>
      m.role === 'assistant' && m.text.endsWith(`REQUEST: ${request}\n${marker}`)),
    'each actual engine request gets its own correctly correlated final response')
  }
  scenarios++
  console.log(`PASS: dev fake ${workerPref}/${jobs} offline/retry/plan/build/pause/resume/review/integration/PR`)
}

// Discover the provider's actual offline default, or honor an explicit ref.
// Literal historical control phrases/tokens must not change session roles,
// choose the wrong reply, or satisfy this turn's completion correlation.
for (const baseRef of [undefined, 'release/v2']) {
  const provider = fakeClients({ defaultBranch: 'develop' })
  assert.deepEqual(await provider.repositoryBase('example/sprite-test'),
    { ref: 'develop', sha: 'a'.repeat(40), repositoryId: 1 })
  assert.deepEqual(await provider.repositoryBase('example/sprite-test', 'release/v2'),
    { ref: 'release/v2', sha: 'a'.repeat(40), repositoryId: 1 })
  const posts = []
  const clients = { ...provider, postMessage: async (id, text, computer) => {
    posts.push({ id, text })
    return provider.postMessage(id, text, computer)
  } }
  const expected = baseRef ?? 'develop'
  const e = new RealOrchestrator(() => {}, {
    ...FAKE, baseRef, workerPref: 'factory', jobs: 1, askBeforePr: true, clients,
    missionId: `dev-ref-${baseRef ? 'explicit' : 'default'}`,
  })
  e.voiceGoal('Preserve literal examples: Open a pull request, Reply with a milestone plan, branch named spriite/stale/job-9, and "REQUEST: quoted-old-request".', 2)
  await e.startPlanning()
  await e.pollLead()
  assert.equal(e.snapshot().planLabels.length, 2, 'quoted worker instructions do not turn the lead into a worker')
  assert.equal(e.snapshot().baseRef, expected)
  assert.equal(e.snapshot().baseSelection, baseRef ? 'explicit' : 'default')
  assert.equal(e.snapshot().baseSha, 'a'.repeat(40))
  assert.ok(posts[0].text.includes(`Selected base: ${expected}`), 'discovered/selected ref is frozen before planning POST')
  e.approvedPlan = [...e.planLabels, 'Preserve the text "Reply with a milestone plan" as an example, not a new control request.']
  await e.startBuild()
  for (let i = 0; i < 12; i++) {
    for (const job of e.jobs) await e.pollJob(job)
    await new Promise(resolve => setTimeout(resolve, 0))
    await e.pollLead()
  }
  assert.equal(e.snapshot().decisionKind, 'pr')
  assert.equal(e.snapshot().decisionPending, true, 'quoted PR instruction cannot bypass owner PR confirmation')
  assert.equal(e.snapshot().jobs[0].branch, `spriite/dev-ref-${baseRef ? 'explicit' : 'default'}/job-1`,
    'quoted stale branch is not the actual worker branch')
  e.handleAction('open_pr')
  for (let i = 0; i < 12; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
    for (const job of e.jobs) await e.pollJob(job)
    await e.pollLead()
  }
  assert.equal(e.snapshot().phase, 'final')
  assert.equal(e.snapshot().prUrl, `${FAKE.repoUrl}/pull/9`)
  const pr = posts.filter(p => p.text.startsWith('The review passed.'))
  assert.equal(pr.length, 1, 'one owner confirmation produces exactly one PR request')
  assert.ok(pr[0].text.includes(`to the ${expected} branch on ${FAKE.repoUrl}.`))
  for (const request of posts) {
    const envelope = /^For this request only, append a line exactly "REQUEST: ([^"]+)" and then a final line exactly (VERDICT_READY|WORK_READY)\./.exec(request.text.split('\n').at(-1) ?? '')
    if (!envelope) continue
    assert.ok((await provider.getMessages(request.id)).some(m => m.role === 'assistant' &&
      m.text.endsWith(`REQUEST: ${envelope[1]}\n${envelope[2]}`)),
    'current request envelope, not quoted old token or plan criteria, determines the strict response')
  }
  scenarios++
  console.log(`PASS: dev fake ${baseRef ? 'explicit release/v2' : 'discovered develop'} base and quoted-control correlation`)
}

// Follow-up PR evidence must name the requested branch/repository, not a
// canned job-1 result that makes integration look correct accidentally.
{
  const provider = fakeClients()
  const repo = 'https://github.com/example/another-dev-repository'
  const branch = 'spriite/another-mission/integration'
  const { agentId } = await provider.cursorAgent(`Push a new branch named ${branch}.`, repo)
  const { runId } = await provider.cursorRun(agentId,
    `Open a pull request from branch "${branch}" to the main branch on ${repo}.`)
  let result
  for (let i = 0; i < 3; i++) result = await provider.cursorGet(agentId, runId)
  assert.equal(result.status, 'FINISHED')
  assert.equal(result.branches[0].branch, branch, 'PR evidence preserves requested integration branch')
  assert.equal(result.branches[0].repoUrl, repo, 'follow-up run preserves agent repository')
  assert.equal(result.branches[0].prUrl, `${repo}/pull/9`)
  const unrelated = await provider.cursorAgent('Push a new branch named spriite/unrelated/job-1.',
    'https://github.com/example/unrelated-dev-repository')
  await assert.rejects(provider.cursorGet(unrelated.agentId, runId), /unknown run .* for agent/,
    'a run cannot be reassociated with another agent/repository')
  scenarios++
  console.log('PASS: dev Cursor follow-up preserves exact branch, repository, and agent/run association')
}

{
  const provider = fakeClients()
  const model = new RealOrchestrator(() => {}, {
    ...FAKE, workerPref: 'factory', missionId: 'repair-mission', clients: provider,
  })
  model.planLabels = ['Repair']
  const job = model.createJobs()[0]
  const { sessionId } = await provider.createSession({})
  const build = model.workerRequest(job, model.jobBuildPrompt(job, 1, 2))
  await provider.postMessage(sessionId, build)
  job.branch = 'spriite/repair-mission/job-2'
  job.stage = 'fix'
  model.failReason = 'The retry path needs repair.'
  const buildToken = job.requestToken
  const fix = model.workerRequest(job, model.jobFixPrompt(job))
  assert.notEqual(job.requestToken, buildToken, 'repair uses a new request token')
  await provider.postMessage(sessionId, fix)
  const response = (await provider.getMessages(sessionId)).at(-1).text
  assert.match(response, /^BRANCH: spriite\/repair-mission\/job-2$/m)
  assert.ok(response.endsWith(`REQUEST: ${job.requestToken}\nWORK_READY`),
    'repair follows the actual engine protocol and branch rather than job-1 defaults')
  await assert.rejects(provider.cursorRun('unknown-agent', 'Open a pull request.'),
    /unknown agent/, 'unknown agents cannot invent successful follow-up work')
  const empty = await provider.createSession({})
  job.stage = 'build'
  const report = model.workerRequest(job, model.resultQueryBody(job))
  await provider.postMessage(empty.sessionId, report)
  assert.equal((await provider.getMessages(empty.sessionId)).at(-1).text, 'Still waiting for the existing result.',
    'an absent existing result produces progress, not a fabricated completion marker')
  scenarios++
  console.log('PASS: dev repair/result-query fixtures use strict tokens, actual branches, and honest pending results')
}

{
  const observe = runtimeBootGuard()
  assert.doesNotThrow(() => observe({ id: 1, message: '[engine] fake mode' }))
  assert.doesNotThrow(() => observe({ id: 2, message: '[runtime] boot epoch=1 origin=fresh' }))
  assert.doesNotThrow(() => observe({ id: 3, message: '[scene] kind=under_review' }))
  assert.throws(() => observe({ id: 4, message: '[runtime] boot epoch=1 origin=fresh' }),
    /App rebooted.*fresh isolated simulator/, 'walkthrough refuses to merge two fresh boots')
  scenarios++
  console.log('PASS: dev walkthrough refuses stale fresh-boot association')
}
globalThis.fetch = originalFetch
console.log(`DEV FAKE TESTS PASSED: ${scenarios} scenario groups, 0 failures`)
