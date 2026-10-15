// Regression tests for verified RealOrchestrator defects (src/factory/real.ts):
// a lead poll stuck across reset()/restore(), a retried Cursor spawn that
// orphaned its first agent, a PR-stage reply with an invalid URL that left
// a silent 'building' card, out-of-range review indices on restore, and a
// FAIL verdict that did not re-pump the review queue.
// Run: node --import ./scripts/ts-resolve.mjs scripts/test-real-fixes.mjs
import assert from 'node:assert/strict'
import { RealOrchestrator } from '../src/factory/real.ts'
import { COPY, buildTitle, buildName } from '../src/factory/copy.ts'
import { fakeClients } from '../src/factory/fake.ts'
import { hudReply, chatReply, ownerWords, PLAN_AGAIN_LINE } from '../src/factory/response.ts'
import { validateScene } from '../src/scenes/validate.ts'

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

/** A promise the test settles by hand (an in-flight network read). */
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function makeEngine(clients = {}, deps = {}) {
  return new RealOrchestrator(() => {}, { repoUrl: 'https://github.com/example/sprite-test', clients, ...deps })
}

function job(over = {}) {
  return {
    label: 'job', mode: 'session', stage: 'build', agentId: null, runId: null, runStatus: '',
    sessionId: null, seenIds: [], count: 0, lastCount: 0, awaiting: null, branch: '',
    state: 'building', weight: 0, nextPoll: 0, polling: false, pendingPrompt: null, question: null,
    ...over,
  }
}

/** Start a lead poll that hangs on getSession, run `interrupt`, then settle it. */
async function pollAcross(interrupt) {
  const pending = deferred()
  const engine = makeEngine({
    getSession: () => pending.promise,
    getMessages: async () => [],
    interrupt: async () => {},
  })
  engine.sessionId = 'lead-1'
  const poll = engine.pollLead()
  assert.equal(engine.pollingLead, true, 'the poll is in flight')
  interrupt(engine)
  pending.resolve({ status: 'idle', messageCount: 0 })
  await poll
  return engine
}

await test('reset() during an in-flight lead poll does not leave pollingLead stuck', async () => {
  const engine = await pollAcross((e) => e.reset())
  assert.equal(engine.pollingLead, false, 'the next mission on this engine can poll its lead')
})

await test('restore() during an in-flight lead poll does not leave pollingLead stuck', async () => {
  const snap = makeEngine().snapshot()
  const engine = await pollAcross((e) => e.restore({ ...snap, sessionId: 'lead-2' }))
  assert.equal(engine.sessionId, 'lead-2', 'the restored lead is tracked')
  assert.equal(engine.pollingLead, false, 'the restored lead is polled again')
})

await test('a retried Cursor spawn reuses the agent instead of orphaning it', async () => {
  let agentCalls = 0
  let runCalls = 0
  const engine = makeEngine({
    cursorAgent: async () => { agentCalls++; return { agentId: `agent-${agentCalls}`, runId: null } },
    cursorRun: async (agentId) => {
      runCalls++
      if (runCalls === 1) throw Object.assign(new Error('Cursor HTTP 500'), { kind: 'service' })
      return { runId: `run-for-${agentId}` }
    },
  })
  engine.requireExecutionBase = async () => {}
  const j = job({ mode: 'cursor' })
  engine.jobs = [j]
  await assert.rejects(engine.spawnJob(j, 'build it', engine.generation))
  assert.equal(j.agentId, 'agent-1')
  assert.equal(j.runId, null)
  await engine.spawnJob(j, 'build it', engine.generation) // the owner's Retry
  assert.equal(agentCalls, 1, 'no second agent is created')
  assert.equal(j.agentId, 'agent-1', 'the first agent stays tracked (and cancellable)')
  assert.equal(j.runId, 'run-for-agent-1')
  assert.equal(j.runStatus, 'RUNNING')
})

await test('a PR-stage reply with an invalid PR URL stops the job with the repair issue', async () => {
  const engine = makeEngine()
  engine.protocolReady = () => true
  const j = job({ stage: 'pr', branch: 'feature/x', requestToken: 'tok' })
  engine.jobs = [j]
  engine.handleWorkerReply(j, 'SUMMARY: opened it\nPR: https://github.com/someone/else/pull/3', false)
  assert.equal(j.state, 'stopped', 'the job no longer presents as building')
  assert.equal(engine.workerIssue, COPY.real.workerNoPr, 'the owner gets the repair card')
  assert.equal(engine.prUrl, '', 'the rejected URL is not accepted')
  assert.ok(!String(engine.failReason).includes('someone/else'), 'the rejected payload is not retained')
})

await test('restore() drops review indices that name no restored job', async () => {
  const base = makeEngine().snapshot()
  const engine = makeEngine()
  engine.restore({
    ...base, phase: 'review', sessionId: 'lead-1',
    jobs: [job({ state: 'queued', branch: 'b0' })],
    reviewQueue: [0, 7], verdictJob: 5, verdictToken: 'stale-token',
  })
  assert.equal(engine.jobs.length, 1)
  assert.equal(engine.verdictJob, null, 'an out-of-range verdictJob does not block the queue')
  assert.equal(engine.verdictToken, null, 'no orphan verdict token can accept a missing job')
  assert.deepEqual(engine.reviewQueue, [0], 'out-of-range queue entries are dropped')

  const ok = makeEngine()
  ok.restore({ ...base, phase: 'review', sessionId: 'lead-1',
    jobs: [job({ state: 'review', branch: 'b0' })], reviewQueue: [], verdictJob: 0, verdictToken: 'live' })
  assert.equal(ok.verdictJob, 0, 'an in-range verdictJob is kept')
  assert.equal(ok.verdictToken, 'live')
})

await test('a FAIL verdict frees the lead for the next queued review', async () => {
  const engine = makeEngine()
  const posted = []
  engine.startFixRun = async () => {}
  engine.postVerdictRequest = async (j) => { posted.push(j) }
  const a = job({ label: 'A', state: 'review', branch: 'a' })
  const b = job({ label: 'B', state: 'queued', branch: 'b' })
  engine.jobs = [a, b]
  engine.sessionId = 'lead-1'
  engine.verdictJob = null // the verdict handler cleared it before failJob
  engine.reviewQueue = [1]
  engine.failJob(0, 'VERDICT: FAIL tests are red')
  assert.equal(a.state, 'repair')
  assert.equal(engine.verdictJob, 1, 'B is reviewed without waiting on A\'s repair')
  assert.equal(b.state, 'review')
  assert.deepEqual(posted, [b])
})


// ---------------------------------------- redesign test round 1 (sim findings)

async function drive(engine, until, maxMs = 120000) {
  const start = engine.nowMs || Date.now()
  for (let t = 0; t <= maxMs; t += 500) {
    engine.tick(start + t)
    await new Promise((r) => setTimeout(r, 0))
    if (until(engine)) return true
  }
  return false
}
const scene = (e) => e.currentView.type === 'scene' ? e.currentView.scene : null
const hasAction = (e, id) => scene(e)?.actions.some((a) => a.id === id) === true

function questionEngine(goal = 'Deliver the empty-state screen', questionOnce = true) {
  const clients = fakeClients({ questionOnce })
  const engine = new RealOrchestrator(() => {}, {
    factoryKey: 'fk-test', cursorKey: 'cr-test', repoUrl: 'https://github.com/example/sprite-test',
    computerId: 'comp-fake', workerPref: 'factory', jobs: 1, askBeforePr: true, clients,
  })
  engine.boot()
  engine.say(goal)
  return { engine, clients }
}

await test('answering the Lead while the plan is ready never strands Start build (question-answer-dead-start-build)', async () => {
  const { engine, clients } = questionEngine()
  engine.handleAction('start_planning')
  assert.ok(await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.purpose === 'decision'), 'the Lead asks while planning')
  assert.equal(engine.chooseDecisionList(1), 'done')
  await new Promise((r) => setTimeout(r, 0))
  const posted = (await clients.getMessages('sess-1')).filter((m) => m.role === 'user').at(-1)
  assert.ok(posted.text.startsWith('The owner chose: SQLite\n') && posted.text.endsWith(PLAN_AGAIN_LINE), 'the answer asks for the complete plan again')
  // Until the revised plan lands the card offers no dead Start build.
  assert.ok(!hasAction(engine, 'begin') || engine.snapshot().awaiting !== 'plan', 'no Start build while the revised plan is awaited')
  assert.ok(await drive(engine, (e) => scene(e)?.kind === 'plan' && hasAction(e, 'begin')), 'the revised plan offers Start build')
  engine.handleAction('begin')
  assert.equal(scene(engine)?.kind, 'decision', 'Start build arms the build gate after the answer')
  assert.equal(scene(engine)?.utterance, COPY.real.startDecision)
})

await test('a bare acknowledgment while a revised plan is awaited keeps the card actionable', async () => {
  const { engine } = questionEngine('Deliver the empty-state screen', false)
  engine.handleAction('start_planning')
  assert.ok(await drive(engine, (e) => scene(e)?.kind === 'plan' && hasAction(e, 'begin')))
  engine.ownerTurn('Use SQLite', true) // the answer made the shown plan stale
  engine.emitCurrent()
  const card = scene(engine)
  assert.equal(card.kind, 'plan')
  assert.ok(!card.actions.some((a) => a.id === 'begin'), 'the stale plan is not startable')
  assert.ok(card.actions.some((a) => a.id === 'send_message'), 'Send message stays offered')
})

await test('lead replies on the HUD drop protocol markers (protocol-prefix-on-hud)', async () => {
  assert.equal(hudReply('SUMMARY: Noted.'), 'Noted.')
  assert.equal(hudReply('SUMMARY: Implemented the job.\nBRANCH: spriite/x/y'), 'Implemented the job.')
  assert.equal(hudReply('VERDICT: PASS The diff matches.'), 'Review passed. The diff matches.')
  assert.equal(hudReply('DECISION: Which database?\nOPTIONS: Postgres | SQLite'), 'Which database?')
  assert.equal(hudReply('1. A\n2. B\nPLAN_READY'), '1. A 2. B')
  const engine = makeEngine({})
  engine.phase = 'building'
  engine.sessionId = 'lead-1'
  engine.emitLeadNote('SUMMARY: Noted.')
  assert.equal(scene(engine).utterance, 'Noted.')
})

await test('the chat shows owner words and readable replies, never the orchestrator brief (internal-prompt-in-history)', async () => {
  assert.equal(ownerWords(`The owner chose: SQLite\n${PLAN_AGAIN_LINE}`), 'SQLite')
  assert.equal(chatReply('SUMMARY: Noted.'), 'Noted.')
  assert.equal(chatReply('DECISION: Which?\nOPTIONS: A | B | C'), 'Which?\nOptions: A, B, C')
  const { engine } = questionEngine()
  engine.handleAction('start_planning')
  assert.ok(await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.purpose === 'decision'))
  const log = engine.chatLog()
  assert.ok(!log.some((e) => /You are the orchestrator|PLAN_READY|^OPTIONS:/m.test(e.text)), 'no protocol scaffolding in the chat')
  assert.ok(log.some((e) => e.who === 'you' && e.text === 'Deliver the empty-state screen'), 'the goal stays')
})

await test('a long build title still shows the build gate (long-title-decision-rejected)', async () => {
  const { engine } = questionEngine('Build a responsive marketing landing page for Acme Corporation with pricing tiers, testimonials, an FAQ accordion and a newsletter signup form wired to Mailchimp')
  engine.handleAction('start_planning')
  assert.ok(await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.purpose === 'decision'))
  engine.chooseDecisionList(0)
  assert.ok(await drive(engine, (e) => scene(e)?.kind === 'plan' && hasAction(e, 'begin')))
  engine.handleAction('begin')
  const gate = scene(engine)
  assert.equal(gate.kind, 'decision')
  assert.deepEqual(validateScene(gate, 'engine'), [], 'the gate passes validation')
})

await test('build titles drop links and trailing clauses (build-title-raw-goal)', async () => {
  assert.equal(buildTitle('Spin this up: https://example.com/reverse-engineer'), 'Spin this up')
  assert.equal(buildTitle('https://example.com/reverse-engineer'), 'reverse engineer')
  assert.equal(buildTitle('Add the empty-state screen and have another agent check it.'), 'empty-state screen')
})

await test('the plan card, milestones list and bar agree (milestones-list-mismatch)', async () => {
  const { engine } = questionEngine()
  engine.handleAction('start_planning')
  assert.ok(await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.purpose === 'decision'))
  engine.chooseDecisionList(0)
  assert.ok(await drive(engine, (e) => scene(e)?.kind === 'plan' && hasAction(e, 'begin')))
  const card = scene(engine)
  assert.equal(card.progress.milestones.length, 2)
  assert.match(card.status, /2 milestones/)
  assert.match(card.contextDetail, /0 OF 2/)
  engine.handleAction('milestones')
  const list = engine.currentView
  assert.equal(list.type, 'selection')
  assert.deepEqual(list.items, ['Deliver the empty-state screen · planned', 'Verify the layout bounds · planned'])
})

await test('poses follow MotionLab while planning and under review (planning-pose-wrong)', async () => {
  const engine = makeEngine({})
  engine.phase = 'plan'
  engine.sessionId = 'lead-1'
  engine.awaiting = 'plan'
  engine.activity.set('lead-1', { status: 'running', checkedAt: engine.nowMs })
  assert.equal(engine.waitingActivity(true).pose, 'planning', 'the Lead planning is Planning (thinking)')
  assert.equal(engine.waitingActivity(false, 'review').pose, 'checking', 'the review is Checking')
})

await test('a finished build cannot be paused (done-build-pause)', async () => {
  const engine = makeEngine({ interrupt: async () => {} })
  engine.phase = 'final'
  engine.sessionId = 'lead-1'
  assert.equal(engine.canPause(), false)
  engine.pauseToggle()
  assert.equal(engine.snapshot().paused, false)
})

await test('a paused build with a failure offers Resume, and pausing before work says so', async () => {
  const engine = makeEngine({ interrupt: async () => {} })
  engine.phase = 'plan'
  engine.sessionId = 'lead-1'
  engine.planLabels = ['A']
  engine.pauseToggle()
  assert.equal(scene(engine).utterance, COPY.real.pausedNoWorker, 'no worker is claimed before Start build')
  engine.faultKind = 'service'
  assert.equal(scene(engine).actions[0].id, 'resume', 'the failure card resumes first')
})

await test('evidence points only at the Done card actions (evidence-row-points-to-missing-explain)', async () => {
  const engine = makeEngine({})
  engine.phase = 'final'
  engine.sessionId = 'lead-1'
  engine.lastReply = 'Delivered.'
  assert.ok(engine.evidenceItems().includes(COPY.real.evidenceSummaryRow))
  assert.ok(!engine.evidenceItems().some((i) => /Explain/.test(i)))
})

// ---------------------------------------- redesign test round 2 (sim findings)

await test('a review held during a pause is sent on Resume, never shown as the owner (paused-review-prompt-shown-as-owner)', async () => {
  const { engine, clients } = questionEngine('Pause run', false)
  engine.handleAction('start_planning')
  assert.ok(await drive(engine, (e) => scene(e)?.kind === 'plan' && hasAction(e, 'begin')), 'the plan is ready')
  engine.handleAction('begin')
  engine.handleAction('use_it')
  assert.ok(await drive(engine, (e) => e.jobs.length > 0 && e.jobs.every((j) => j.sessionId)), 'the worker runs')
  engine.pauseToggle()
  assert.equal(engine.snapshot().paused, true)
  assert.ok(await drive(engine, (e) => e.snapshot().pendingLeadPosts.length > 0), 'the review request is held while paused')
  const leadPosts = async () => (await clients.getMessages('sess-1')).filter((m) => m.role === 'user').map((m) => m.text)
  const before = await leadPosts()
  assert.ok(!before.some((t) => t.startsWith('The worker pushed branch')), 'nothing is sent while paused')
  const owned = () => engine.chatLog().filter((c) => c.who === 'you').map((c) => c.text)
  assert.ok(!owned().some((t) => /worker pushed branch|VERDICT_READY|REQUEST:/.test(t)), 'the review prompt is not an owner bubble')
  assert.ok(!engine.chatLog().some((c) => /Draft retained/.test(c.text)), 'no "Draft retained" note for a turn that will be sent')
  engine.pauseToggle()
  assert.equal(engine.snapshot().paused, false)
  assert.ok(await drive(engine, (e) => scene(e)?.kind === 'final' || hasAction(e, 'open_pr')), 'the review passes after Resume')
  const after = await leadPosts()
  assert.ok(after.some((t) => t.startsWith('The worker pushed branch')), 'the held review is sent after Resume')
  assert.ok(!after.includes('Continue.'), 'the held turn resumes the lead; no stray Continue.')
  assert.ok(!engine.chatLog().some((c) => c.who === 'lead' && c.text === 'Noted.'), 'no stray lead note from a Continue.')
  assert.ok(!owned().some((t) => /worker pushed branch|VERDICT_READY|REQUEST:/.test(t)), 'History never shows the review prompt as the owner')
})

await test('a job spanning several plan lines is one Milestones row with its status (milestone-row-multiline-label)', async () => {
  const { engine } = questionEngine('Deliver the empty-state screen', false)
  engine.handleAction('start_planning')
  assert.ok(await drive(engine, (e) => scene(e)?.kind === 'plan' && hasAction(e, 'begin')))
  engine.handleAction('begin')
  engine.handleAction('use_it')
  assert.ok(await drive(engine, (e) => e.jobs.length > 0 && e.jobs.every((j) => j.sessionId)), 'the worker runs')
  assert.equal(engine.jobs.length, 1, 'one worker covers both plan lines')
  assert.equal(engine.jobs[0].label, 'Deliver the empty-state screen\nVerify the layout bounds', 'the worker prompt keeps every line')
  engine.overlay = 'plan_detail'
  engine.emitCurrent()
  const list = engine.currentView
  assert.equal(list.type, 'selection')
  for (const row of list.items) {
    assert.ok(!row.includes('\n'), `one line: ${JSON.stringify(row)}`)
    assert.match(row, / · (pending|in review|building|planned|checks passed|being fixed|[a-z ]+)$/i, `the status shows: ${row}`)
  }
  assert.ok(list.items[0].startsWith('Deliver the empty-state screen, Verify'), list.items[0])
  assert.equal(list.items.at(-1).split(' · ')[0], 'PR')
  assert.equal(engine.snapshot().milestones.find((m) => m.id === 'job_0').label, 'Deliver the empty-state screen, Verify the layout bounds')
})

await test('a scoped chat build is titled by its request, on the HUD and the phone rows (build-title-raw-goal)', async () => {
  const scoped = 'Spin this up: https://example.com/reverse-engineer\nOwner clarifications:\nThe owner chose: Rebuild linked product\nMVP core workflow\nPrevious planning context, quoted for reference only. Owner clarifications and the approved criteria take precedence:\n> Capture - done means linked product behavior is recorded.'
  assert.equal(buildTitle(scoped), 'Spin this up', 'the clarifications never reach the title')
  assert.equal(buildName(scoped), 'Spin this up')
  // The durable runtime stores the command on one line.
  assert.equal(buildTitle(scoped.replace(/\s+/g, ' ')), 'Spin this up', 'a one-line scoped goal is cut at its sections')
  assert.equal(buildName('Add a checkout flow'), 'Checkout flow', 'the boards name a build like the HUD title')
  assert.equal(buildName('https://example.com/reverse-engineer'), 'Reverse engineer')
  const engine = makeEngine({})
  engine.projectsSource = { list: () => [{ id: 'm1', goal: scoped.replace(/\s+/g, ' '), status: 'building', sessionId: 's1' }] }
  const row = engine.listBuilds().find((r) => r.kind === 'local')
  assert.equal(row.title, 'Spin this up', 'the Builds row names the build, not the raw goal')
  engine.goal = scoped
  engine.phase = 'building'
  engine.sessionId = 'lead-1'
  assert.equal(engine.hudTitle(), 'SPIN THIS UP')
})

console.log(`Real engine fixes: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
