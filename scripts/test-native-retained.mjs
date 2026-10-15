import assert from 'node:assert/strict'
import {
  factoryGetMessages, factoryPostMessage, factoryHistoryComplete, FACTORY_REQUEST_TIMEOUT_MS,
} from '../src/factory/fapi.ts'
import { chatBuildScope } from '../src/factory/build-intent.ts'
import { githubRepos, githubRepositoryBase, githubBranchEvidence, githubPullEvidence } from '../src/factory/github.ts'
import { RealOrchestrator } from '../src/factory/real.ts'
import { Outbox, DispatchUnknownError } from '../src/runtime/outbox.ts'
import { WatchReceiptStore } from '../src/factory/watch-receipts.ts'
import { TestKV, makeClients as managedClients, makeRuntime, cmd, drive, settle as tickManaged, snapshotOf } from './lib/runtime-fake.mjs'

// Production adapters/orchestrator/outbox, synthetic transport only. Any
// unexpected network operation fails rather than reaching a live provider.
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Unexpected network in retained regression') }
const repo = 'https://github.com/example/retained'
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0)) }
let passed = 0
let failed = 0
async function test(name, run) {
  try { await run(); passed++; console.log(`PASS: ${name}`) }
  catch (e) { failed++; console.error(`FAIL: ${name}\n${e.stack}`) }
  finally { globalThis.fetch = async () => { throw new Error('Unexpected network in retained regression') } }
}
const textBlock = text => ({ type: 'text', text })
function harness(deps = {}) {
  let creates = 0
  let next = 0
  const posts = []
  const reads = []
  const histories = new Map([['lead', [
    { id: 'goal', role: 'user', text: `Mission goal: Build retained scope\nRepository the worker builds on: ${repo}` },
    { id: 'plan', role: 'assistant', text: '1. Implement - preserve every owner restriction\n2. Verify - all requested tests pass\nPLAN_READY' },
  ]]])
  const clients = {
    createSession: async () => { const sessionId = `created-${++creates}`; histories.set(sessionId, []); return { sessionId } },
    getSession: async id => ({ status: 'idle', messageCount: histories.get(id)?.length ?? 0 }),
    getMessages: async (id, computerId) => { reads.push({ id, computerId }); return histories.get(id) ?? [] },
    postMessage: async (id, text, computerId) => {
      posts.push({ id, text, computerId })
      histories.get(id)?.push({ id: `sent-${++next}`, role: 'user', text })
    },
    computers: async () => [{ id: 'original-computer', status: 'active' }],
    interrupt: async () => {},
    listFactorySessions: async () => [],
    listCursorAgents: async () => [],
    createRepo: async name => ({ url: `https://github.com/example/${name}` }),
    cursorAgent: async () => ({ agentId: 'cursor-agent', runId: 'cursor-run' }),
    cursorRun: async () => ({ runId: 'cursor-next-run' }),
  }
  const engine = new RealOrchestrator(() => {}, {
    factoryKey: 'synthetic', repoUrl: repo, computerId: 'original-computer', workerPref: 'factory',
    clients, ...deps,
  })
  engine.restore({ ...engine.snapshot(), phase: 'plan', sessionId: 'lead', goal: 'Build retained scope',
    missionRepo: repo, missionComputerId: 'original-computer', awaiting: null,
    planLabels: ['Implement all restrictions', 'Verify the outcome'] })
  return { engine, clients, posts, histories, reads, creates: () => creates }
}
const ask = (id = 'native-ask') => ({ id, role: 'assistant', text: '',
  nativeQuestions: [{ toolId: id, text: 'Which database?', pending: true }] })
function baseReads({ defaultBranch = 'develop', refs = { develop: 'a'.repeat(40) }, repositoryId = 42 } = {}) {
  const calls = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(input)
    assert.equal(url.origin, 'https://api.github.com')
    assert.equal(init.method, 'GET')
    calls.push(url.pathname)
    if (url.pathname === '/repos/example/retained') return Response.json({
      id: repositoryId, full_name: 'example/retained', default_branch: defaultBranch,
    })
    const prefix = '/repos/example/retained/branches/'
    assert.ok(url.pathname.startsWith(prefix), `Unexpected GitHub resource ${url.pathname}`)
    const ref = decodeURIComponent(url.pathname.slice(prefix.length))
    return refs[ref] ? Response.json({ commit: { sha: refs[ref] } }) : Response.json({ message: 'Not Found' }, { status: 404 })
  }
  return calls
}
const useBaseReads = h => { h.clients.repositoryBase = (repository, selected) => githubRepositoryBase('synthetic', repository, selected) }

try {
  await test('A01 camelCase and snake_case tool results close native requests through restore', async () => {
    for (const field of ['toolUseId', 'tool_use_id']) {
      globalThis.fetch = async () => Response.json({ messages: [
        { id: 'question', role: 'assistant', createdAt: 1000000000, content: [{ type: 'tool_use', name: 'AskUser', id: 'tool-1', input: { questionnaire: 'Which database?' } }] },
        { id: 'answer', role: 'tool', createdAt: 1000000001, content: [{ type: 'tool_result', [field]: 'tool-1' }] },
      ], pagination: { hasMore: false } })
      const messages = await factoryGetMessages('synthetic', 'lead')
      assert.equal(messages[0].nativeQuestions[0].pending, false)
      assert.deepEqual(messages[1].completedToolIds, ['tool-1'])
      const h = harness()
      h.engine.observeNativeQuestions([ask('tool-1')], 'lead')
      h.engine.restore(JSON.parse(JSON.stringify(h.engine.snapshot())))
      h.engine.observeNativeQuestions(messages, 'lead')
      assert.equal(h.engine.snapshot().decisionPending, false)
    }
  })

  await test('A03 bounded pagination reaches old question/closure and exposes unavailable continuation', async () => {
    let calls = 0
    globalThis.fetch = async input => {
      const url = new URL(input)
      calls++
      if (!url.searchParams.get('cursor')) return Response.json({
        messages: [{ id: 'closure', role: 'tool', createdAt: 1000000002, content: [{ type: 'tool_result', toolUseId: 'old-tool' }] }],
        pagination: { hasMore: true, nextCursor: 'older page' },
      })
      assert.equal(url.searchParams.get('cursor'), 'older page')
      return Response.json({ messages: [
        { id: 'initial', role: 'user', createdAt: 1000000000, content: [textBlock(`Mission goal: Build retained scope\nRepository: ${repo}`)] },
        { id: 'old', role: 'assistant', createdAt: 1000000001, content: [{ type: 'tool_use', name: 'AskUser', id: 'old-tool', input: { questionnaire: 'Which database?' } }] },
      ], pagination: { hasMore: false } })
    }
    const messages = await factoryGetMessages('synthetic', 'lead')
    assert.equal(calls, 2)
    assert.equal(factoryHistoryComplete(messages), true)
    assert.deepEqual(messages.map(m => m.id), ['initial', 'old', 'closure'])
    assert.equal(messages[1].nativeQuestions[0].pending, false)
    globalThis.fetch = async () => Response.json({ messages: [{ id: 'tail', role: 'assistant', content: [textBlock('1. Implement - every restriction is preserved\n2. Verify - all tests pass\nPLAN_READY')] }],
      pagination: { hasMore: true, nextCursor: null } })
    const partial = await factoryGetMessages('synthetic', 'lead')
    assert.equal(factoryHistoryComplete(partial), false)
    assert.equal(chatBuildScope(partial, { goal: 'Build', repository: repo }), null)
    const h = harness()
    h.clients.getMessages = async () => partial
    assert.equal(await h.engine.sendFollowup('New restriction', () => true), 'deferred')
    assert.equal(h.posts.length, 0)
  })

  await test('A03 failed continuation is incomplete, never full scope', async () => {
    let n = 0
    globalThis.fetch = async () => {
      if (++n > 1) throw new Error('Synthetic continuation unavailable')
      return Response.json({ messages: [{ id: 'tail', role: 'assistant', content: [] }],
        pagination: { hasMore: true, nextCursor: 'next' } })
    }
    assert.equal(factoryHistoryComplete(await factoryGetMessages('synthetic', 'lead')), false)
  })

  await test('A03 a missing worker request boundary never accepts WORK_READY', async () => {
    const h = harness()
    await h.engine.startBuild()
    const job = h.engine.jobs[0]
    h.histories.set(job.sessionId, [{ id: 'result-without-request', role: 'assistant',
      text: `SUMMARY: done\nBRANCH: spriite/missing\nREQUEST: ${job.requestToken}\nWORK_READY` }])
    await h.engine.pollJob(job)
    assert.equal(job.state, 'building')
    assert.equal(job.branch, '')
    assert.equal(h.posts.filter(p => /VERDICT_READY/.test(p.text)).length, 0)
  })

  await test('A12 never-settling reads and invoked POSTs expire, writes stay unknown', async () => {
    const timeout = globalThis.setTimeout
    globalThis.setTimeout = (fn, ms, ...args) => timeout(fn, ms === FACTORY_REQUEST_TIMEOUT_MS ? 5 : ms, ...args)
    try {
      globalThis.fetch = async () => new Promise(() => {})
      await assert.rejects(factoryGetMessages('synthetic', 'lead'), e => e.kind === 'timeout')
      const h = harness()
      h.clients.postMessage = async (id, text, computer) => {
        h.posts.push({ id, text, computer })
        await factoryPostMessage('synthetic', id, text, computer)
      }
      await h.engine.postLead('Request initial planning', 'plan', false)
      assert.equal(h.engine.hasUnconfirmedDelivery, true)
      h.engine.restore(JSON.parse(JSON.stringify(h.engine.snapshot())))
      h.engine.tick(5000)
      await settle()
      assert.equal(h.posts.length, 1)
      assert.equal(h.engine.pollingLead, false)
    } finally { globalThis.setTimeout = timeout }
  })

  for (const kind of ['plan', 'verdict', 'summary', 'resume']) {
    await test(`D01/D02 ${kind} successful unreadable acknowledgment is durable uncertainty`, async () => {
      for (const body of ['', 'not-json', '{}']) {
        const h = harness()
        h.clients.postMessage = async (id, text) => {
          h.posts.push({ id, text })
          globalThis.fetch = async () => new Response(body === '' ? null : body, { status: body === '' ? 204 : 200 })
          await factoryPostMessage('synthetic', id, text)
        }
        let durable
        const store = new WatchReceiptStore({
          get: async () => null,
          set: async (_key, raw) => { durable = raw; return true },
        })
        await store.load()
        const deps = store.dependencies()
        const e = new RealOrchestrator(() => {}, { factoryKey: 'synthetic', repoUrl: repo,
          computerId: 'original-computer', workerPref: 'factory', clients: h.clients, ...deps })
        e.restore({ ...h.engine.snapshot(), awaiting: null })
        await e.postLead(`Retained ${kind} request`, kind === 'resume' ? 'steer' : kind, true, false)
        assert.equal(e.hasUnconfirmedDelivery, true)
        assert.ok(JSON.parse(durable).records.some(r => r.attempt?.text === `Retained ${kind} request`))
        e.restore(JSON.parse(JSON.stringify(e.snapshot())))
        e.tick(4000)
        await settle()
        assert.equal(h.posts.length, 1)
      }
    })
  }

  await test('D01 unreadable worker acknowledgment holds execution across restart', async () => {
    const h = harness()
    h.clients.postMessage = async (id, text) => {
      h.posts.push({ id, text })
      globalThis.fetch = async () => new Response(null, { status: 204 })
      await factoryPostMessage('synthetic', id, text)
    }
    await h.engine.startBuild()
    assert.equal(h.creates(), 1)
    assert.equal(h.engine.hasUnconfirmedDelivery, true)
    h.engine.restore(JSON.parse(JSON.stringify(h.engine.snapshot())))
    h.engine.tick(5000)
    await settle()
    assert.equal(h.posts.length, 1)
  })

  await test('D03 coordinator final authority is rechecked after persistence, without dispatch', async () => {
    const h = harness()
    let allowed = true
    const state = { outbox: [] }
    const outbox = new Outbox({ epoch: 1, state: () => state, commit: async () => ({ ok: true }) })
    const clients = outbox.wrapClients(h.clients, 'retained', () => new Set(), () => {
      if (!allowed) throw Object.assign(new Error('Paused/cancelled/terminal'), { kind: 'policy' })
    })
    const e = new RealOrchestrator(() => {}, { factoryKey: 'synthetic', repoUrl: repo,
      computerId: 'original-computer', workerPref: 'factory', clients,
      beforeSessionDispatch: async () => { allowed = false } })
    e.restore(h.engine.snapshot())
    await assert.rejects(e.postLead('Review after late worker result', 'verdict', false), /Paused\/cancelled\/terminal/)
    assert.equal(h.posts.length, 0)
    assert.equal(e.hasUnconfirmedDelivery, false)
  })

  await test('D02 failed coordinator persistence sends nothing', async () => {
    const h = harness()
    const e = new RealOrchestrator(() => {}, { factoryKey: 'synthetic', repoUrl: repo,
      computerId: 'original-computer', workerPref: 'factory', clients: h.clients,
      beforeSessionDispatch: async () => { throw Object.assign(new Error('Storage unavailable'), { kind: 'storage' }) } })
    e.restore(h.engine.snapshot())
    await assert.rejects(e.postLead('Review branch', 'verdict', false), /Storage/)
    assert.equal(h.posts.length, 0)
  })

  await test('D02 concurrent coordinator turns serialize before transport and preserve the unsent tail', async () => {
    const h = harness()
    let release
    const firstRead = h.clients.getMessages
    let blocked = true
    h.clients.getMessages = async (...args) => {
      if (!blocked) return firstRead(...args)
      blocked = false
      return new Promise(resolve => { release = async () => resolve(await firstRead(...args)) })
    }
    const first = h.engine.postLead('First planning turn', 'plan', false)
    await h.engine.postLead('Second review turn', 'verdict', false)
    assert.equal(h.posts.length, 0)
    assert.deepEqual(h.engine.snapshot().pendingLeadPosts.map(p => p.text), ['First planning turn', 'Second review turn'],
      'the prerequisite-read head and its FIFO tail are both durably unsent')
    await release()
    await first
    h.engine.tick(4000)
    await settle()
    assert.deepEqual(h.posts.map(p => p.text), ['First planning turn', 'Second review turn'])
  })

  await test('D02 an invoked unclassified failure is unknown, not a retry grant', async () => {
    const h = harness()
    h.clients.postMessage = async (id, text) => {
      h.posts.push({ id, text })
      throw new Error('Synthetic outcome unavailable')
    }
    await h.engine.postLead('Initial plan turn', 'plan', false)
    assert.equal(h.engine.hasUnconfirmedDelivery, true)
    h.engine.restore(JSON.parse(JSON.stringify(h.engine.snapshot())))
    h.engine.handleAction('retry')
    h.engine.tick(4000)
    await settle()
    assert.equal(h.posts.length, 1)
  })

  await test('A04 followups re-read native attention and final owner permission', async () => {
    const h = harness()
    h.histories.get('lead').push(ask())
    assert.equal(await h.engine.sendFollowup('Do more work', () => true), 'deferred')
    assert.equal(h.posts.length, 0)
    assert.equal(h.engine.snapshot().nativeQuestion.sessionId, 'lead')
  })

  await test('A04 a newly arrived native worker question prevents an ordinary answer POST', async () => {
    const h = harness()
    await h.engine.startBuild()
    const job = h.engine.jobs[0]
    h.engine.handleWorkerReply(job, 'DECISION: Plain question?\nOPTIONS: One | Two')
    h.histories.get(job.sessionId).push(ask('worker-native'))
    const before = h.posts.length
    h.engine.chooseDecisionList(0)
    await settle()
    assert.equal(h.posts.length, before)
    assert.equal(h.engine.snapshot().nativeQuestion.sessionId, job.sessionId)
    assert.equal(h.engine.snapshot().retainedDraft.sessionId, job.sessionId)
  })

  await test('A05 Send message race retains full draft and original coordinator destination', async () => {
    const h = harness()
    await h.engine.startBuild()
    const job = h.engine.jobs[0]
    h.engine.handleWorkerReply(job, 'DECISION: Which database?\nOPTIONS: One | Two')
    const before = h.posts.length
    const draft = 'Send the full owner instruction '.repeat(80) + 'Do not deploy or open a PR.'
    assert.equal(h.engine.steer(draft), true)
    await settle()
    assert.equal(h.posts.length, before)
    assert.deepEqual(h.engine.snapshot().retainedDraft, { sessionId: 'lead', text: draft })
    h.engine.restore(JSON.parse(JSON.stringify(h.engine.snapshot())))
    assert.equal(h.engine.snapshot().retainedDraft.text, draft)
  })

  await test('A07 external plain answer closes attention without granting local approval', async () => {
    const h = harness()
    const question = { id: 'q', role: 'assistant', text: 'DECISION: Which database?\nOPTIONS: SQLite | Postgres' }
    h.histories.get('lead').push(question)
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().decisionPending, true)
    h.histories.get('lead').push({ id: 'external-user', role: 'user', text: 'SQLite; no deploy' })
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().decisionPending, false)
    assert.equal(h.creates(), 0)
    question.text += ' '
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().decisionPending, false)
    assert.equal(h.posts.length, 0)
    question.text = 'DECISION: Revised older question?\nOPTIONS: One | Two'
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().decisionPending, false)
  })

  await test('A09 watched history imports chronological provider owner turns once', async () => {
    const h = harness()
    h.histories.get('lead').push({ id: 'external-1', role: 'user', text: 'Retain my database restriction.' })
    h.engine.attachFactoryRow({ sessionId: 'lead', title: 'Watched', status: 'idle',
      computerId: 'original-computer', updatedAt: 0 })
    await h.engine.pollLead()
    const first = h.engine.snapshot().chat
    assert.equal(first.filter(m => m.who === 'you' && m.text === 'Retain my database restriction.').length, 1)
    await h.engine.pollLead()
    assert.deepEqual(h.engine.snapshot().chat, first)
    h.engine.leaveWatch()
    h.engine.attachFactoryRow({ sessionId: 'lead', title: 'Watched', status: 'idle',
      computerId: 'original-computer', updatedAt: 0 })
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().chat.filter(m => m.text === 'Retain my database restriction.').length, 1)
  })

  await test('A09 local-send echoes dedupe, but separate equal-text external owner turns retain identities', async () => {
    const h = harness()
    assert.equal(h.engine.steer('Use the existing database'), true)
    await settle()
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().chat.filter(m => m.who === 'you' && m.text === 'Use the existing database').length, 1)
    h.histories.get('lead').push({ id: 'separate-external-user', role: 'user', text: 'Use the existing database' })
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().chat.filter(m => m.who === 'you' && m.text === 'Use the existing database').length, 2)
    assert.equal(h.engine.snapshot().awaiting, 'plan')
    assert.equal(h.engine.snapshot().planLabels.length, 0)
  })

  await test('A08 raw options preserve identical long prefixes and trailing restrictions', async () => {
    const h = harness()
    const prefix = 'Use the existing database with the approved schema and all existing migrations '
    const options = [prefix + 'without deploying', prefix + 'without opening a PR']
    h.engine.handleReply(`DECISION: Which restrictions?\nOPTIONS: ${options.join(' | ')}`)
    assert.deepEqual(h.engine.snapshot().decisionOptions, options)
    assert.notEqual(h.engine.currentView.items[0], h.engine.currentView.items[1])
    h.engine.chooseDecisionList(1)
    await settle()
    // Answered while planning, the post closes by asking for the plan again.
    assert.equal(h.posts.at(-1).text.split('\n')[0], `The owner chose: ${options[1]}`)
  })

  await test('A10 nested damaged snapshots quarantine without throws or restored dispatch rights', async () => {
    for (const damage of [
      s => { s.jobs = [null] },
      s => { s.queuedLeadQuestion = { text: 'Question?', options: 42 } },
      s => { s.goal = { unexpected: true } },
      s => { s.decisionOptions = [null, {}] },
      s => { s.nativeQuestion = { toolId: null, sessionId: 'lead' } },
      s => { s.jobs = [{ label: 'Worker', question: { text: 'Question', options: ['Yes'], native: { toolId: 'tool', sessionId: 'wrong-owner' } }, sessionId: 'worker' }] },
    ]) {
      const h = harness()
      const snap = JSON.parse(JSON.stringify(h.engine.snapshot()))
      damage(snap)
      h.engine.restore(snap)
      h.engine.boot()
      h.engine.tick(4000)
      await settle()
      assert.equal(h.engine.snapshot().faultKind, 'storage')
      assert.equal(h.engine.snapshot().paused, true)
      assert.equal(h.engine.snapshot().queuedStart, null)
      assert.equal(h.engine.snapshot().approvedPlan.length, 0)
      assert.equal(h.posts.length, 0)
      assert.equal(h.creates(), 0)
    }
  })

  await test('I10 substantive Continue and Resume owner restrictions survive watched build scope', async () => {
    const messages = [
      { id: 'owner-goal', role: 'user', text: `Mission goal: Build the app\nRepository: ${repo}` },
      { id: 'assistant-advice', role: 'assistant', text: 'Use a new remote database.' },
      { id: 'owner-correction', role: 'user', text: 'Continue with the existing database; do not deploy.' },
      { id: 'owner-correction-2', role: 'user', text: 'Resume with no PR until I separately approve it.' },
      { id: 'scope', role: 'assistant', text: '1. Implement - the existing database works offline\n2. Verify - all tests pass\nPLAN_READY' },
    ]
    const h = harness()
    h.histories.set('lead', messages)
    h.engine.restore({ ...h.engine.snapshot(), awaiting: 'plan', planLabels: [] })
    await h.engine.prepareChatBuild()
    assert.match(h.engine.snapshot().buildDraft.goal, /Continue with the existing database; do not deploy/)
    assert.match(h.engine.snapshot().buildDraft.goal, /Resume with no PR/)
  })

  await test('I11 conditional build yes revises scope; conditional PR okay holds publication', async () => {
    const h = harness()
    h.engine.handleAction('begin')
    assert.equal(h.engine.say('yes, but use a new repo and do not deploy'), 'steer')
    await settle()
    assert.equal(h.creates(), 0)
    assert.equal(h.engine.snapshot().awaiting, 'plan')
    assert.match(h.posts.at(-1).text, /new repo and do not deploy/)
    const p = harness()
    p.engine.decisionPending = true
    p.engine.decisionGate = true
    p.engine.decisionKind = 'pr'
    assert.equal(p.engine.say('okay, but do not open a PR yet'), 'decision')
    await settle()
    assert.equal(p.posts.length, 0)
    assert.equal(p.engine.snapshot().paused, true)
    assert.equal(p.engine.snapshot().retainedDraft.text, 'okay, but do not open a PR yet')
  })

  await test('I09 repository discovery finds page two, and continuation failure cannot select a default', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ full_name: `example/r${i}`, html_url: `https://github.com/example/r${i}` }))
    let pages = []
    globalThis.fetch = async input => {
      const page = Number(new URL(input).searchParams.get('page'))
      pages.push(page)
      return Response.json(page === 1 ? rows : [{ full_name: 'example/target', html_url: 'https://github.com/example/target' }])
    }
    assert.ok((await githubRepos('synthetic')).some(r => r.fullName === 'example/target'))
    assert.deepEqual(pages, [1, 2])
    globalThis.fetch = async input => Number(new URL(input).searchParams.get('page')) === 1
      ? Response.json(rows) : new Response(null, { status: 500 })
    await assert.rejects(githubRepos('synthetic'))
  })

  await test('R01 exact typed/fallback repository identity survives timeout and changed caller name', async () => {
    let state = { outbox: [] }
    const commit = async mutation => {
      const result = await mutation(state)
      if (result) state = result.state
      return { ok: true }
    }
    const creates = []
    const finds = []
    const clients = {
      repoAccount: async () => 'original-account',
      createRepo: async (name, isPrivate) => {
        creates.push({ name, isPrivate })
        throw Object.assign(new Error('Synthetic accepted create, response lost'), { kind: 'network' })
      },
      findRepo: async (name, account, isPrivate) => {
        finds.push({ name, account, isPrivate })
        return { url: `https://github.com/${account}/${name}` }
      },
    }
    let outbox = new Outbox({ epoch: 1, state: () => state, commit })
    await assert.rejects(outbox.wrapClients(clients, 'mission', () => new Set()).createRepo('typed-name-2', true), DispatchUnknownError)
    state = JSON.parse(JSON.stringify(state))
    outbox = new Outbox({ epoch: 2, state: () => state, commit })
    const result = await outbox.wrapClients(clients, 'mission', () => new Set()).createRepo('current-wrong-name', false)
    assert.equal(result.url, 'https://github.com/original-account/typed-name-2')
    assert.deepEqual(finds, [{ name: 'typed-name-2', account: 'original-account', isPrivate: true }])
    assert.equal(creates.length, 1)
    const again = await outbox.wrapClients(clients, 'mission', () => new Set()).createRepo('another-name', true)
    assert.equal(again.url, result.url)
    assert.equal(creates.length, 1)
  })

  await test('R01 an old unknown hash cannot be reconciled using a new caller name', async () => {
    const state = { outbox: [{ actionId: 'old', missionId: 'm', requestKey: 'm:m:github.repo:0',
      requestHash: 'opaque-old-hash', state: 'unknown', attempts: 1, remoteIds: [] }] }
    let lookups = 0
    const outbox = new Outbox({ epoch: 2, state: () => state, commit: async mutation => { await mutation(state); return { ok: true } } })
    const wrapped = outbox.wrapClients({ findRepo: async () => { lookups++; return { url: repo } },
      createRepo: async () => { throw new Error('Must not create') } }, 'm', () => new Set())
    await assert.rejects(wrapped.createRepo('different', true), DispatchUnknownError)
    assert.equal(lookups, 0)
  })

  await test('R01 not observing a timed-out repository is not permission to replay or rename its create', async () => {
    const state = { outbox: [{ actionId: 'uncertain', missionId: 'm', requestKey: 'm:m:github.repo:0',
      requestHash: 'old-hash', state: 'unknown', attempts: 1, remoteIds: [],
      repositoryRequest: { account: 'original-account', name: 'typed-original-2', isPrivate: true } }] }
    let creates = 0
    const finds = []
    const clients = {
      repoAccount: async () => 'original-account',
      findRepo: async (...args) => { finds.push(args); return null },
      createRepo: async () => { creates++; return { url: repo } },
    }
    const outbox = new Outbox({ epoch: 2, state: () => state, commit: async mutation => { await mutation(state); return { ok: true } } })
    await assert.rejects(outbox.wrapClients(clients, 'm', () => new Set()).createRepo('new-name', false), DispatchUnknownError)
    assert.deepEqual(finds, [['typed-original-2', 'original-account', true]])
    assert.equal(creates, 0)
    assert.equal(state.outbox[0].state, 'unknown')
  })

  await test('R02 changing Setup never changes retained lead/worker computer or restored identity', async () => {
    const h = harness()
    h.engine.configure({ computerId: 'new-default' })
    await h.engine.postLead('Owner update', 'steer', true)
    await h.engine.startBuild()
    assert.ok(h.posts.every(p => p.computerId === 'original-computer'))
    const snapshot = JSON.parse(JSON.stringify(h.engine.snapshot()))
    h.engine.restore(snapshot)
    h.engine.configure({ computerId: 'yet-another-default' })
    await h.engine.pollLead()
    await h.engine.pollJob(h.engine.jobs[0])
    assert.ok(h.reads.every(r => r.computerId === 'original-computer'))
    assert.equal(h.engine.snapshot().missionComputerId, 'original-computer')
  })

  await test('R03 actual GitHub reads bind repository branch/base/head and reject unrelated PR', async () => {
    const headSha = 'a'.repeat(40)
    const baseSha = 'b'.repeat(40)
    let wrong = false
    const paths = []
    globalThis.fetch = async input => {
      const path = new URL(input).pathname
      paths.push(path)
      if (path.endsWith('/branches/develop')) return Response.json({ commit: { sha: baseSha } })
      if (path.includes('/branches/')) return Response.json({ commit: { sha: headSha } })
      if (path.includes('/compare/')) return Response.json({ status: 'ahead', ahead_by: 1,
        files: [{ filename: 'implementation.ts' }], merge_base_commit: { sha: baseSha } })
      return Response.json({ state: 'open',
        head: { ref: wrong ? 'unrelated' : 'spriite/owned', sha: headSha, repo: { full_name: 'example/retained' } },
        base: { ref: 'develop', repo: { full_name: 'example/retained' } } })
    }
    assert.deepEqual(await githubBranchEvidence('synthetic', 'example/retained', 'spriite/owned', 'develop'), { headSha, baseSha })
    await githubPullEvidence('synthetic', 'example/retained', 2, 'spriite/owned', 'develop', headSha)
    wrong = true
    await assert.rejects(githubPullEvidence('synthetic', 'example/retained', 2, 'spriite/owned', 'develop', headSha), /does not match/)
    assert.ok(paths.some(p => p.endsWith('/branches/spriite%2Fowned')))
    globalThis.fetch = async () => Response.json({ commit: { sha: baseSha } })
    await assert.rejects(githubBranchEvidence('synthetic', 'example/retained', 'unchanged', 'develop'), /changed branch/)
  })

  await test('R03 unchanged repair commit and wrong-repo Cursor branch never trigger review', async () => {
    const h = harness()
    h.clients.branchEvidence = async () => ({ headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) })
    await h.engine.startBuild()
    const job = h.engine.jobs[0]
    job.stage = 'fix'
    job.headSha = 'a'.repeat(40)
    h.engine.handleWorkerReply(job, `SUMMARY: repaired\nBRANCH: spriite/owned\nREQUEST: ${job.requestToken}\nWORK_READY`)
    await settle()
    assert.equal(job.state, 'stopped')
    assert.equal(h.posts.filter(p => /VERDICT_READY/.test(p.text)).length, 0)
    const cursor = { ...job, mode: 'cursor', state: 'building', branch: '', stage: 'build',
      agentId: 'owned-agent', runId: 'owned-run' }
    await h.engine.handleRunDone(cursor, { text: 'Claimed completion', branches: [{ branch: 'foreign', repoUrl: 'https://github.com/example/unrelated' }] }, h.engine.generation)
    assert.equal(cursor.branch, '')
    assert.equal(cursor.state, 'stopped')
  })

  await test('R04 reviewers receive the full approved criteria and restrictions, not only job label', async () => {
    const h = harness()
    h.engine.approvedPlan = ['Accept only existing PostgreSQL', 'Never deploy or publish a PR', 'All tests must pass']
    h.engine.ownerClarifications = ['Preserve the original schema and all data']
    await h.engine.startBuild()
    const job = h.engine.jobs[0]
    job.branch = 'spriite/owned'
    h.engine.queueForReview(job)
    await settle()
    const review = h.posts.findLast(p => /VERDICT_READY/.test(p.text)).text
    for (const criterion of h.engine.approvedPlan) assert.ok(review.includes(criterion))
    assert.ok(review.includes('Preserve the original schema and all data'))
  })

  await test('R06 idle with growing history is unknown for that observation, not perpetual historical activity', async () => {
    const h = harness()
    await h.engine.pollLead()
    h.histories.get('lead').push({ id: 'new-work', role: 'assistant', text: 'Executing a tool now', hasToolActivity: true })
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().activityStatus, 'unknown')
    await h.engine.pollLead()
    assert.equal(h.engine.snapshot().activityStatus, 'idle')
  })

  await test('R08 known-unsent initial planning Retry uses the existing lead only', async () => {
    const h = harness()
    h.engine.reset()
    let refuse = true
    h.clients.postMessage = async (id, text, computerId) => {
      h.posts.push({ id, text, computerId })
      if (refuse) { refuse = false; throw Object.assign(new Error('Factory refused request'), { kind: 'forbidden' }) }
    }
    h.engine.voiceGoal('Build safely', 2)
    h.engine.handleAction('start_planning')
    await settle()
    assert.equal(h.creates(), 1)
    const lead = h.engine.snapshot().sessionId
    assert.equal(h.engine.snapshot().faultRetry, 'plan')
    const refused = JSON.parse(JSON.stringify(h.engine.snapshot()))
    assert.equal(refused.initialPlanTurn.state, 'unsent')
    assert.equal(refused.initialPlanTurn.text, h.posts[0].text)
    h.engine.restore(refused)
    h.engine.handleAction('retry')
    await settle()
    assert.equal(h.creates(), 1)
    assert.equal(h.posts.length, 2)
    assert.equal(h.posts[1].id, lead)
    assert.equal(h.posts[1].text, h.posts[0].text)
    assert.equal(h.posts[1].computerId, h.posts[0].computerId)
    assert.equal(h.engine.snapshot().initialPlanTurn.state, 'accepted')
    assert.equal(h.engine.snapshot().awaiting, 'plan')
  })

  await test('R09 selected non-main base reaches reviewed evidence, PR prompt and restore', async () => {
    const h = harness({ baseRef: 'develop' })
    await h.engine.startBuild()
    const job = h.engine.jobs[0]
    job.branch = 'spriite/owned'
    assert.match(h.engine.prPrompt(job), /to the develop branch/)
    assert.match(h.engine.verdictRequest(job), /Base ref: develop/)
    h.engine.restore(JSON.parse(JSON.stringify(h.engine.snapshot())))
    assert.equal(h.engine.snapshot().baseRef, 'develop')
  })

  await test('R09 published reads resolve the real default and explicit slash ref without guessed main', async () => {
    const sha = 'a'.repeat(40)
    const release = 'b'.repeat(40)
    const calls = baseReads({ refs: { develop: sha, 'release/v2': release } })
    assert.deepEqual(await githubRepositoryBase('synthetic', 'example/retained'), { ref: 'develop', sha, repositoryId: 42 })
    assert.deepEqual(await githubRepositoryBase('synthetic', 'example/retained', 'release/v2'),
      { ref: 'release/v2', sha: release, repositoryId: 42 })
    assert.deepEqual(calls, ['/repos/example/retained', '/repos/example/retained/branches/develop',
      '/repos/example/retained', '/repos/example/retained/branches/release%2Fv2'])
    baseReads({ defaultBranch: '', refs: { main: sha } })
    await assert.rejects(githubRepositoryBase('synthetic', 'example/retained'), /no branch was guessed/)
    baseReads({ repositoryId: 0 })
    await assert.rejects(githubRepositoryBase('synthetic', 'example/retained'), /identity/)
    baseReads({ refs: { develop: 'f'.repeat(45) } })
    await assert.rejects(githubRepositoryBase('synthetic', 'example/retained'), /base commit/)
  })

  await test('R09 planning freezes default branch SHA before the first Factory write and reset clears it', async () => {
    const calls = baseReads()
    const h = harness()
    useBaseReads(h)
    h.engine.reset()
    assert.equal(h.engine.snapshot().baseRef, '')
    h.engine.voiceGoal('Use the repository default; preserve all data', 2)
    await h.engine.startPlanning()
    assert.equal(h.creates(), 1)
    assert.equal(h.posts.length, 1)
    assert.match(h.posts[0].text, /Selected base: develop/)
    assert.ok(h.posts[0].text.includes('Frozen base commit: ' + 'a'.repeat(40)))
    const frozen = JSON.parse(JSON.stringify(h.engine.snapshot()))
    assert.equal(frozen.baseSelection, 'default')
    assert.equal(frozen.baseRepositoryId, 42)
    h.engine.restore(frozen)
    assert.equal(h.engine.snapshot().baseSha, 'a'.repeat(40))
    assert.ok(!calls.some(path => path.endsWith('/main')))
    h.engine.reset()
    assert.equal(h.engine.snapshot().baseRef, '')
    assert.equal(h.engine.snapshot().baseSha, null)
    assert.equal(h.engine.snapshot().baseRepositoryId, null)
  })

  await test('R09 explicit selection survives discovery and reset without following the default', async () => {
    baseReads({ refs: { develop: 'a'.repeat(40), 'release/v2': 'b'.repeat(40) } })
    const h = harness({ baseRef: 'release/v2' })
    useBaseReads(h)
    h.engine.reset()
    h.engine.voiceGoal('Build on the selected release branch', 2)
    await h.engine.startPlanning()
    assert.equal(h.engine.snapshot().baseSelection, 'explicit')
    assert.equal(h.engine.snapshot().baseRef, 'release/v2')
    assert.equal(h.engine.snapshot().baseSha, 'b'.repeat(40))
    assert.match(h.posts[0].text, /Selected base: release\/v2/)
    h.engine.reset()
    assert.equal(h.engine.snapshot().baseRef, 'release/v2')
    assert.equal(h.engine.snapshot().baseSha, null)
  })

  await test('R09 legacy implicit main needs refreshed scope and fresh owner approval against observed default', async () => {
    baseReads()
    const h = harness({ jobs: 1 })
    useBaseReads(h)
    const legacy = { ...h.engine.snapshot(), baseRef: 'main' }
    delete legacy.baseSelection
    h.engine.restore(legacy)
    await h.engine.startBuild()
    assert.equal(h.creates(), 0)
    assert.equal(h.posts.length, 0)
    assert.equal(h.engine.snapshot().baseSelection, 'default')
    assert.equal(h.engine.snapshot().baseRef, 'develop')
    assert.deepEqual(h.engine.snapshot().approvedPlan, [])
    assert.deepEqual(h.engine.snapshot().planLabels, [])
    assert.equal(h.engine.needsPlanRefresh(), true)
    h.engine.handleAction('retry')
    await settle()
    assert.equal(h.posts.length, 1)
    assert.equal(h.posts[0].id, 'lead')
    assert.match(h.posts[0].text, /Selected base: develop/)
    h.histories.get('lead').push({ id: 'refreshed-plan', role: 'assistant',
      text: '1. Implement - retain every restriction\n2. Verify - compare against frozen develop\nPLAN_READY' })
    await h.engine.pollLead()
    assert.equal(h.creates(), 0, 'a refreshed proposal is not execution approval')
    assert.equal(h.engine.beginApproved(), false, 'an earlier implicit source approval cannot authorize the new base')
    h.engine.handleAction('begin')
    h.engine.handleAction('use_it')
    await settle()
    assert.equal(h.creates(), 1)
    assert.ok(h.posts[1].text.includes('Use frozen base commit ' + 'a'.repeat(40)))
    assert.match(h.posts[1].text, /base ref "develop"/)
  })

  await test('R09 moved approved base invalidates readiness, and unavailable reads cannot launch workers', async () => {
    baseReads({ refs: { develop: 'b'.repeat(40) } })
    const h = harness()
    useBaseReads(h)
    h.engine.restore({ ...h.engine.snapshot(), baseRef: 'develop', baseSha: 'a'.repeat(40),
      baseSelection: 'default', baseRepositoryId: 42, approvedPlan: ['Preserve all data'] })
    await h.engine.startBuild()
    assert.equal(h.creates(), 0)
    assert.equal(h.posts.length, 0)
    assert.equal(h.engine.snapshot().baseSha, 'b'.repeat(40))
    assert.deepEqual(h.engine.snapshot().planLabels, [])
    assert.deepEqual(h.engine.snapshot().approvedPlan, [])
    baseReads({ refs: {} })
    const unavailable = harness()
    useBaseReads(unavailable)
    await unavailable.engine.startBuild()
    assert.equal(unavailable.creates(), 0)
    assert.equal(unavailable.posts.length, 0)
    assert.equal(unavailable.engine.snapshot().faultSource, 'github')
    assert.equal(unavailable.engine.snapshot().baseSha, null)
  })

  await test('R09 owner scope racing base preflight cannot inherit an older execution approval', async () => {
    const h = harness()
    let resolve
    h.clients.repositoryBase = () => new Promise(r => { resolve = r })
    h.engine.restore({ ...h.engine.snapshot(), baseRef: 'develop', baseSha: 'a'.repeat(40),
      baseSelection: 'default', baseRepositoryId: 42 })
    const pending = h.engine.startBuild()
    h.engine.ownerTurn('Do not execute until the schema review is complete')
    resolve({ ref: 'develop', sha: 'a'.repeat(40), repositoryId: 42 })
    await pending
    assert.equal(h.creates(), 0)
    assert.equal(h.posts.length, 0)
    assert.ok(h.engine.snapshot().ownerClarifications.includes('Do not execute until the schema review is complete'))
  })

  await test('R09 existing worker PR dispatch holds on a moved base and cannot replay through Retry', async () => {
    baseReads()
    const h = harness({ jobs: 1 })
    useBaseReads(h)
    h.engine.restore({ ...h.engine.snapshot(), baseRef: 'develop', baseSha: 'a'.repeat(40),
      baseSelection: 'default', baseRepositoryId: 42 })
    await h.engine.startBuild()
    const job = h.engine.jobs[0]
    const originalWorker = job.sessionId
    job.branch = 'spriite/reviewed'
    job.headSha = 'c'.repeat(40)
    job.baseSha = 'a'.repeat(40)
    job.state = 'accepted'
    const before = h.posts.length
    baseReads({ refs: { develop: 'b'.repeat(40) } })
    await h.engine.startPrStage()
    assert.equal(h.posts.length, before)
    assert.equal(h.engine.snapshot().quarantined, true)
    assert.equal(h.engine.snapshot().jobs[0].sessionId, originalWorker)
    h.engine.restore(JSON.parse(JSON.stringify(h.engine.snapshot())))
    h.engine.handleAction('retry')
    h.engine.handleAction('resume')
    await settle()
    assert.equal(h.posts.length, before)
    assert.equal(h.creates(), 1)
  })

  await test('R09 malformed frozen base authority quarantines rather than restoring a grant', async () => {
    for (const damage of [{ baseSha: 'bad' }, { baseRepositoryId: 4.2 },
      { baseSelection: 'guessed' }, { baseSha: 'a'.repeat(40), baseRef: 'develop', baseRepositoryId: null }]) {
      const h = harness()
      h.engine.restore({ ...h.engine.snapshot(), ...damage })
      assert.equal(h.engine.snapshot().quarantined, true)
      assert.equal(h.engine.snapshot().faultKind, 'storage')
      assert.equal(h.engine.snapshot().decisionPending, false)
      assert.deepEqual(h.engine.snapshot().approvedPlan, [])
      h.engine.handleAction('retry')
      await h.engine.startBuild()
      assert.equal(h.creates(), 0)
      assert.equal(h.posts.length, 0)
    }
  })

  await test('R09 PR completion requires the immutable approved base SHA as well as repository and head', async () => {
    const headSha = 'c'.repeat(40)
    const baseSha = 'a'.repeat(40)
    let observed = baseSha
    globalThis.fetch = async (_input, init) => {
      assert.equal(init.method, 'GET')
      return Response.json({ state: 'open', head: { ref: 'spriite/reviewed', sha: headSha, repo: { full_name: 'example/retained' } },
        base: { ref: 'develop', sha: observed, repo: { full_name: 'example/retained' } } })
    }
    await githubPullEvidence('synthetic', 'example/retained', 7, 'spriite/reviewed', 'develop', headSha, baseSha)
    observed = 'b'.repeat(40)
    await assert.rejects(githubPullEvidence('synthetic', 'example/retained', 7, 'spriite/reviewed', 'develop', headSha, baseSha), /reviewed/)
  })

  await test('P1 reviewer prerequisite GET failure durably preserves the entire unsent review', async () => {
    for (const kind of ['network', 'forbidden']) {
      const h = harness({ jobs: 1, askBeforePr: true })
      await h.engine.startBuild()
      const job = h.engine.jobs[0]
      job.branch = 'spriite/owned'
      let fail = true
      const read = h.clients.getMessages
      h.clients.getMessages = async (...args) => {
        if (fail) throw Object.assign(new Error('Read unavailable before dispatch'), { kind })
        return read(...args)
      }
      const before = h.posts.length
      h.engine.queueForReview(job)
      await settle()
      const snap = JSON.parse(JSON.stringify(h.engine.snapshot()))
      assert.equal(h.posts.length, before)
      assert.equal(snap.pendingLeadPosts.length, 1)
      assert.match(snap.pendingLeadPosts[0].text, /VERDICT_READY/)
      assert.ok(snap.pendingLeadPosts[0].text.includes(job.label))
      h.engine.restore(snap)
      fail = false
      if (kind === 'forbidden') h.engine.handleAction('retry')
      else h.engine.retryPendingPrompts()
      await settle()
      assert.equal(h.posts.length, before + 1)
      assert.equal(h.posts.at(-1).text, snap.pendingLeadPosts[0].text)
      const token = h.engine.snapshot().verdictToken
      assert.equal(token, snap.verdictToken, 'Retry must not mint a replacement verdict token')
      h.histories.get('lead').push({ id: 'review-result', role: 'assistant',
        text: `VERDICT: PASS Verified the full criteria.\nREQUEST: ${token}\nVERDICT_READY` })
      await h.engine.pollLead()
      assert.equal(h.engine.jobs[0].state, 'accepted')
      assert.equal(h.engine.snapshot().pendingLeadPosts.length, 0)
    }
  })

  await test('P1 decision prerequisite read failure retains exact answer through restore and native attention', async () => {
    for (const input of ['answerDecision', 'steer']) {
      const h = harness()
      h.engine.handleReply('DECISION: Which database?\nOPTIONS: PostgreSQL | SQLite', false, 'ordinary-question')
      const answer = 'PostgreSQL; preserve the existing schema and every record.'
      const read = h.clients.getMessages
      h.clients.getMessages = async () => { throw Object.assign(new Error('Pre-send read failed'), { kind: 'network' }) }
      if (input === 'answerDecision') await h.engine.answerDecision(answer)
      else { assert.equal(h.engine.steer(answer), true); await settle() }
      const snap = JSON.parse(JSON.stringify(h.engine.snapshot()))
      assert.equal(snap.pendingLeadPosts[0]?.text.split('\n')[0], answer)
      assert.equal(h.posts.length, 0)
      h.engine.restore(snap)
      h.histories.get('lead').push(ask('new-native-attention'))
      h.clients.getMessages = read
      h.engine.retryPendingPrompts()
      await settle()
      assert.equal(h.posts.length, 0)
      assert.equal(h.engine.snapshot().pendingLeadPosts[0].text.split('\n')[0], answer)
      h.histories.get('lead').pop()
      h.histories.get('lead').push({ id: 'native-closure', role: 'tool', text: '', completedToolIds: ['new-native-attention'] })
      h.engine.observeNativeQuestions(h.histories.get('lead'), 'lead')
      h.engine.retryPendingPrompts()
      await settle()
      assert.equal(h.posts.length, 1)
      assert.equal(h.posts[0].text.split('\n')[0], answer)
    }
  })

  await test('P1 SDK follow-up and reviewer share the serializer; unreadable acknowledgment cannot be overwritten', async () => {
    const h = harness()
    let release
    let reads = 0
    const writes = []
    const followup = 'Preserve the complete owner follow-up; no deployment or PR without approval.'
    globalThis.fetch = async (_url, init) => {
      if (init.method === 'GET') {
        if (++reads === 1) await new Promise(r => { release = r })
        return Response.json({ messages: [], pagination: { hasMore: false } })
      }
      const text = JSON.parse(init.body).text
      writes.push(text)
      return text === followup ? Response.json({}) : Response.json({ messageId: 'confirmed-review', status: 'pending' })
    }
    h.clients.getMessages = (id, computer) => factoryGetMessages('synthetic', id, computer)
    h.clients.postMessage = (id, text, computer) => factoryPostMessage('synthetic', id, text, computer)
    const review = h.engine.postLead('Review the exact approved criteria', 'verdict', false)
    await settle()
    try {
      assert.equal(await h.engine.sendFollowup(followup, () => true), 'deferred')
      assert.equal(writes.length, 0)
    } finally { release(); await review }
    assert.equal(await h.engine.sendFollowup(followup, () => true), 'unknown')
    const unknown = h.engine.snapshot().deliveryAttempts[0]
    assert.equal(unknown.text, followup)
    await h.engine.postLead('Later reviewer turn must remain unsent', 'verdict', false)
    assert.equal(writes.length, 2)
    assert.equal(h.engine.snapshot().deliveryAttempts[0].text, followup)
    assert.equal(h.engine.snapshot().pendingLeadPosts[0].text, 'Later reviewer turn must remain unsent')
    h.engine.restore(JSON.parse(JSON.stringify(h.engine.snapshot())))
    h.engine.retryPendingPrompts()
    await settle()
    assert.equal(writes.length, 2)
    assert.equal(h.engine.hasUnconfirmedDelivery, true)
  })

  await test('P1 managed source approval cannot authorize a moved base or refreshed proposal across restart', async () => {
    let sha = 'a'.repeat(40)
    const clients = managedClients()
    const post = clients.postMessage
    const posts = []
    let firstPlan = true
    clients.repositoryBase = async (_repository, selected) => ({ ref: selected ?? 'main', sha, repositoryId: 42 })
    clients.postMessage = async (id, text, computer) => {
      posts.push(text)
      await post(id, text, computer)
      if (firstPlan && /^You are the orchestrator/.test(text)) { firstPlan = false; sha = 'b'.repeat(40) }
    }
    const kv = new TestKV()
    const ctx = makeRuntime(kv, clients)
    await ctx.supervisor.boot()
    const id = (await ctx.supervisor.submitCommand({ ...cmd('Build only the approved scope', 'changed-base'), startApproved: true })).missionId
    assert.equal(await drive(ctx, () => snapshotOf(ctx, id)?.baseSha === sha &&
      snapshotOf(ctx, id)?.planLabels.length === 0 && firstPlan === false, 20000), true)
    assert.equal(clients.counts.createSession, 1)
    ctx.supervisor.handleAction(id, 'retry')
    await drive(ctx, () => snapshotOf(ctx, id)?.planLabels.length > 0, 10000)
    await tickManaged(ctx, 6000)
    assert.equal(clients.counts.createSession, 1, 'old source grant does not authorize the new proposal')
    assert.equal(snapshotOf(ctx, id).requiresFreshApproval, true)
    await ctx.supervisor.flush()
    const restored = makeRuntime(kv, clients)
    await restored.supervisor.boot()
    await tickManaged(restored, 6000)
    assert.equal(clients.counts.createSession, 1, 'restart cannot reapply startApproved')
    assert.equal(snapshotOf(restored, id).requiresFreshApproval, true)
    restored.supervisor.handleAction(id, 'begin')
    restored.supervisor.handleAction(id, 'use_it')
    assert.equal(await drive(restored, () => clients.counts.createSession === 2, 10000), true)
    await settle()
    assert.ok(posts.find(text => /^You are the execution worker/.test(text)).includes(`Use frozen base commit ${sha}`))
  })

  await test('P1 managed scope amendments revoke source approval; older ready caches migrate without an implicit grant', async () => {
    const clients = managedClients()
    clients.repositoryBase = async (_repository, selected) => ({ ref: selected ?? 'main', sha: 'a'.repeat(40), repositoryId: 42 })
    const kv = new TestKV()
    const ctx = makeRuntime(kv, clients)
    await ctx.supervisor.boot()
    const id = (await ctx.supervisor.submitCommand({ ...cmd('Build the original scope', 'changed-scope'), startApproved: true })).missionId
    assert.equal(await drive(ctx, () => snapshotOf(ctx, id)?.planLabels.length > 0, 10000), true)
    assert.equal(clients.counts.createSession, 1)
    const restriction = 'Also preserve every existing record; never migrate or delete the database.'
    ctx.supervisor.say(id, restriction)
    await settle()
    const lead = snapshotOf(ctx, id).sessionId
    clients.sessions.get(lead).msgs.push({ id: 'amended-scope-ready', role: 'assistant',
      text: '1. Implement - preserve every existing record without database changes\n2. Verify - prove there are no migrations or deletions\nPLAN_READY' })
    await tickManaged(ctx, 6000)
    assert.equal(snapshotOf(ctx, id).requiresFreshApproval, true)
    assert.equal(clients.counts.createSession, 1)
    await ctx.supervisor.flush()
    const restored = makeRuntime(kv, clients)
    await restored.supervisor.boot()
    await tickManaged(restored, 6000)
    assert.equal(clients.counts.createSession, 1)
    assert.equal(snapshotOf(restored, id).requiresFreshApproval, true)
    restored.supervisor.handleAction(id, 'begin')
    restored.supervisor.handleAction(id, 'use_it')
    assert.equal(await drive(restored, () => clients.counts.createSession === 2, 10000), true)
    await settle()
    const worker = [...clients.sessions.values()].find(s => s.msgs.some(m => /^You are the execution worker/.test(m.text)))
    assert.ok(worker.msgs.some(m => m.role === 'user' && m.text.includes(restriction)))
    const h = harness({ jobs: 1 })
    const oldReady = JSON.parse(JSON.stringify(h.engine.snapshot()))
    delete oldReady.requiresFreshApproval
    delete oldReady.initialPlanTurn
    h.engine.restore(oldReady)
    assert.equal(h.engine.beginApproved(), false)
    assert.equal(h.creates(), 0)
    assert.equal(h.engine.snapshot().requiresFreshApproval, true)
  })

  await test('P1 first-plan unknown proof restores a missing receipt; positive exact correlation persists acceptance', async () => {
    const h = harness()
    h.engine.reset()
    h.clients.postMessage = async (id, text, computer) => {
      h.posts.push({ id, text, computer })
      throw Object.assign(new Error('Initial response lost'), { kind: 'network' })
    }
    h.engine.voiceGoal('Preserve every requested condition', 2)
    await h.engine.startPlanning()
    const unknown = JSON.parse(JSON.stringify(h.engine.snapshot()))
    assert.equal(unknown.initialPlanTurn.state, 'unknown')
    const partial = { ...unknown, pendingLeadDelivery: null, deliveryAttempts: [] }
    h.engine.restore(partial)
    assert.equal(h.engine.hasUnconfirmedDelivery, true)
    h.engine.handleAction('retry')
    await settle()
    assert.equal(h.posts.length, 1)
    h.engine.restore(unknown)
    h.histories.get(unknown.sessionId).push({ id: 'accepted-original', role: 'user', text: unknown.initialPlanTurn.text },
      { id: 'accepted-plan', role: 'assistant', text: '1. Implement - preserve every requested condition\n2. Verify - run the requested tests\nPLAN_READY' })
    h.engine.handleAction('check_delivery')
    await settle()
    assert.equal(h.engine.snapshot().initialPlanTurn.state, 'accepted')
    assert.equal(h.engine.hasUnconfirmedDelivery, false)
    h.engine.restore(JSON.parse(JSON.stringify(h.engine.snapshot())))
    assert.equal(h.engine.hasUnconfirmedDelivery, false)
    assert.equal(h.posts.length, 1)
    assert.equal(h.creates(), 1)
  })

  await test('P1 old ambiguous initial-plan faults migrate to unknown, never a Retry grant', async () => {
    for (const accepted of [false, true]) {
      const h = harness({ jobs: 1 })
      h.engine.reset()
      h.clients.postMessage = async (id, text, computer) => {
        h.posts.push({ id, text, computer })
        if (accepted) h.histories.get(id).push({ id: 'old-initial-user', role: 'user', text },
          { id: 'old-ready-plan', role: 'assistant', text: '1. Implement - preserve all records\n2. Verify - run every requested test\nPLAN_READY' })
        globalThis.fetch = async () => Response.json({})
        await factoryPostMessage('synthetic', id, text, computer)
      }
      h.engine.voiceGoal('Preserve all records', 2)
      await h.engine.startPlanning()
      const old = JSON.parse(JSON.stringify(h.engine.snapshot()))
      delete old.initialPlanTurn
      delete old.requiresFreshApproval
      old.deliveryAttempts = []
      old.pendingLeadDelivery = null
      old.pendingLeadPosts = []
      old.planLabels = []
      old.faultKind = 'service'
      old.faultSource = 'factory'
      old.faultDetail = 'Factory returned no message id from successful POST'
      old.faultRetry = 'plan'
      h.engine.restore(old)
      const before = h.posts.length
      h.engine.handleAction('retry')
      await settle()
      assert.equal(h.posts.length, before)
      assert.equal(h.creates(), 1)
      assert.equal(h.engine.hasUnconfirmedDelivery, true)
      h.engine.restore(JSON.parse(JSON.stringify(h.engine.snapshot())))
      h.engine.handleAction('check_delivery')
      await settle()
      assert.equal(h.posts.length, before)
      assert.equal(h.creates(), 1)
      assert.equal(h.engine.hasUnconfirmedDelivery, !accepted)
      assert.equal(h.engine.beginApproved(), false, 'read reconciliation never invents a build grant')
    }
  })

  await test('A06 unsupported Cursor question retains exact owner identity and honest handoff', async () => {
    const h = harness()
    const job = { mode: 'cursor', stage: 'build', branch: '', agentId: 'exact-agent', runId: 'exact-run', state: 'building' }
    await h.engine.handleRunDone(job, { status: 'FINISHED', text: 'Which database should I use?', branches: [] }, h.engine.generation)
    assert.equal(job.state, 'stopped')
    assert.match(h.engine.snapshot().workerIssue, /answer.*Cursor/i)
    assert.ok(h.engine.snapshot().chat.some(m => m.text.includes('exact-agent') && m.text.includes('exact-run')))
    assert.equal(h.posts.length, 0)
  })
} finally { globalThis.fetch = originalFetch }
console.log(`Retained execution regressions: ${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
