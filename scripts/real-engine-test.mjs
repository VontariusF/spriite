/**
 * Real-engine fake-pipeline test (dev tool). Drives the full real pipeline
 * (plan -> parallel workers -> review verdicts -> fix loop -> integration
 * -> PR -> final) against fake service clients injected through the
 * engine's client seam, with synthetic time and deterministic replies.
 * No network, no keys, no credits; the HUD contract is asserted the same
 * way the simulator walkthrough asserts the demo path.
 *
 * Scenario A: workerPref 'mix', 3 parallel jobs (Cursor agent + Factory
 * session + Cursor agent), auto PR.
 * Scenario B: one Factory-session worker, first verdict FAILs (repair
 * loop), ask-before-PR gate.
 *
 * Usage: node scripts/real-engine-test.mjs
 */
import { RealOrchestrator } from '../src/factory/real.ts'
import { InputNormalizer } from '../src/input/normalize.ts'
import { OsEventTypeList } from '@evenrealities/even_hub_sdk'

const REPO = 'https://github.com/example/sprite-test'
let failures = 0

function assert(ok, label) {
  if (ok) console.log('  PASS:', label)
  else {
    failures++
    console.log('  FAIL:', label)
  }
}

function makeClients({
  verdictFailBranches = [],
  cloudSessions = [],
  cloudAgents = [],
  computers = [{ id: 'comp-1', name: 'Studio Mac', status: 'active' }],
  rejectPostSessions = [],
  repoTakenNames = [],
  // Fault injections: the Nth createSession call throws instead.
  offlineCreateSessionOnce = false,
  failCreateSessionAtCall = 0,
} = {}) {
  const sessions = new Map() // id -> { msgs: [], count, status }
  const runs = new Map() // runId -> { agentId, prompt, polls }
  let sessN = 0
  let agentN = 0
  let runN = 0
  let msgN = 0
  let createCalls = 0
  let offlineFails = offlineCreateSessionOnce ? 1 : 0
  const repoCreates = [] // { name, isPrivate } per createRepo call
  const agentRepos = [] // repoUrl per cursor agent create
  const verdictFails = new Map() // branch -> times failed
  const createdWith = [] // computerId per createSession call, in order
  const postedWith = [] // { id, computerId } per postMessage call

  // Cloud rows predate this engine: Factory sessions carry their history and
  // a live status; Cursor agents carry their latest run.
  for (const c of cloudSessions) {
    sessions.set(c.sessionId, {
      msgs: c.msgs ?? [{ id: `m-cloud-${c.sessionId}`, role: 'assistant', text: c.title }],
      count: c.msgs?.length ?? 1,
      worker: false,
      status: c.status ?? 'idle',
    })
  }
  for (const a of cloudAgents) {
    if (a.latestRunId) runs.set(a.latestRunId, { agentId: a.agentId, prompt: 'cloud watch', polls: 0, repoUrl: REPO })
  }

  const leadReply = (text) => {
    if (/Reply with a milestone plan|grouping the goal into jobs/.test(text)) {
      return '1. Add the empty-state screen\n2. Wire the retry path\n3. Check the layout bounds'
    }
    if (/VERDICT: PASS or VERDICT: FAIL/.test(text)) {
      const branch = /branch "([^"]+)"/.exec(text)?.[1] ?? ''
      if (verdictFailBranches.includes(branch) && !verdictFails.has(branch)) {
        verdictFails.set(branch, 1)
        return 'VERDICT: FAIL The empty state renders but the retry path skips failed requests.'
      }
      return 'VERDICT: PASS The diff matches the goal and the checks hold.'
    }
    if (/Reply with SUMMARY: one sentence/.test(text)) {
      return 'SUMMARY: Delivered the empty-state screen.'
    }
    return 'SUMMARY: Noted.'
  }

  const workerReply = (text) => {
    const branch = /branch named (spriite\/job-\d+)/.exec(text)?.[1]
    if (/Fix the findings/.test(text)) {
      return `SUMMARY: Fixed the findings on ${branch}.\nBRANCH: ${branch}`
    }
    if (/Merge these branches/.test(text)) {
      return 'SUMMARY: Merged the branches.\nBRANCH: spriite/integration'
    }
    if (/Open a pull request/.test(text)) {
      return 'SUMMARY: Opened the pull request.\nPR: https://github.com/example/sprite-test/pull/9'
    }
    return `SUMMARY: Implemented the job on ${branch}.\nBRANCH: ${branch}`
  }

  const post = (sessionId, text) => {
    const s = sessions.get(sessionId)
    if (!s) throw new Error('unknown session ' + sessionId)
    s.msgs.push({ id: `m${++msgN}`, role: 'user', text })
    const isWorker = s.worker === true
    const reply = isWorker ? workerReply(text) : leadReply(text)
    s.msgs.push({ id: `m${++msgN}`, role: 'assistant', text: reply })
    s.count = s.msgs.length
  }

  return {
    leadSessionCount: () => sessN,
    agentCount: () => agentN,
    /** computerId per createSession call, in order (assert the resolution). */
    createdComputers: () => createdWith.slice(),
    computers: async () => computers.map((c) => ({ ...c })),
    /** Names handed to createRepo, in order (with the private flag). */
    repoCreated: () => repoCreates.slice(),
    /** Repository per Cursor agent create (workers build on the mission repo). */
    agentRepos: () => agentRepos.slice(),
    createRepo: async (name, isPrivate) => {
      if (repoTakenNames.includes(name)) {
        const e = new Error('GitHub HTTP 422')
        e.kind = 'exists'
        throw e
      }
      repoCreates.push({ name, isPrivate })
      return { url: `https://github.com/example/${name}` }
    },
    createSession: async (opts) => {
      createCalls += 1
      if (offlineFails > 0) {
        offlineFails -= 1
        // What Factory answers when the mission's computer daemon is down.
        const e = new Error('Factory could not reach the computer (failed to connect to computer daemon)')
        e.kind = 'offline'
        throw e
      }
      if (createCalls === failCreateSessionAtCall) {
        const e = new Error('Factory HTTP 500 (internal)')
        e.kind = 'service'
        throw e
      }
      const id = `sess-${++sessN}`
      // The lead session is created first; later sessions are workers.
      createdWith.push(opts?.computerId ?? '')
      sessions.set(id, { msgs: [], count: 0, worker: sessN > 1, status: 'idle' })
      return { sessionId: id }
    },
    getSession: async (id) => {
      const s = sessions.get(id)
      return { messageCount: s?.count ?? 0, status: s?.status ?? 'idle' }
    },
    getMessages: async (id) => sessions.get(id)?.msgs.slice() ?? [],
    postedComputers: () => postedWith.slice(),
    postMessage: async (id, text, computerId) => {
      postedWith.push({ id, computerId: computerId ?? '' })
      if (rejectPostSessions.includes(id)) {
        const e = new Error('Factory HTTP 400 (Bad Request: session is not connected to a computer)')
        e.kind = 'service'
        throw e
      }
      post(id, text)
    },
    interrupt: async () => {},
    listFactorySessions: async () => cloudSessions.map(({ msgs, ...card }) => ({ ...card })),
    listCursorAgents: async () => cloudAgents.map((a) => ({ ...a })),
    cursorAgent: async (promptText, repoUrl) => {
      const agentId = `agent-${++agentN}`
      const runId = `run-${++runN}`
      agentRepos.push(repoUrl)
      runs.set(runId, { agentId, prompt: promptText, polls: 0, repoUrl })
      return { agentId, runId }
    },
    cursorRun: async (agentId, promptText) => {
      const runId = `run-${++runN}`
      runs.set(runId, { agentId, prompt: promptText, polls: 0, repoUrl: REPO })
      return { runId }
    },
    cursorGet: async (agentId, runId) => {
      const r = runs.get(runId)
      if (!r) throw new Error('unknown run ' + runId)
      r.polls += 1
      const prompt = r.prompt
      if (prompt === 'cloud watch') {
        // A watched cloud build: two RUNNING polls, then FINISHED with text.
        if (r.polls < 3) return { id: runId, status: 'RUNNING', text: '', branches: [] }
        return {
          id: runId, status: 'FINISHED', text: 'Cloud build finished the settings screen.',
          branches: [],
        }
      }
      if (r.polls < 3) {
        return { id: runId, status: 'RUNNING', text: '', branches: [] }
      }
      if (/Open a pull request/.test(prompt)) {
        return {
          id: runId, status: 'FINISHED', text: 'Opened the pull request.',
          branches: [{ repoUrl: r.repoUrl, branch: 'spriite/final', prUrl: `${REPO}/pull/9` }],
        }
      }
      const branch = /branch named (spriite\/job-\d+|spriite\/integration)/.exec(prompt)?.[1] ?? 'spriite/job-1'
      return {
        id: runId, status: 'FINISHED', text: 'Implemented the job.',
        branches: [{ repoUrl: r.repoUrl, branch }],
      }
    },
    cursorCancel: async () => {},
  }
}

function record(events) {
  return (view) => {
    if (view.type === 'scene') {
      const p = view.scene.progress
      events.push({
        kind: view.scene.kind,
        utterance: view.scene.utterance,
        statusNote: view.scene.status,
        accepted: p?.acceptedWeight ?? null,
        pending: p?.pendingReviewWeight ?? null,
      })
    } else {
      events.push({ kind: `selection:${view.purpose}`, items: view.items })
    }
  }
}

async function drive(engine, until, maxMs = 200000) {
  for (let t = 0; t <= maxMs; t += 500) {
    engine.tick(t)
    await new Promise((r) => setTimeout(r, 0))
    if (until(engine)) return true
  }
  return false
}

const deps = (over) => ({
  factoryKey: 'fk-test',
  cursorKey: 'cr-test',
  repoUrl: REPO,
  computerId: 'comp-1',
  ...over,
})

console.log('== Real engine fake-pipeline test ==')

// ------------------------------------------------ scenario A: 3 mixed jobs

{
  const clients = makeClients()
  const events = []
  const engine = new RealOrchestrator(record(events), {
    ...deps({ workerPref: 'mix', jobs: 3, askBeforePr: false }),
    clients,
  })
  engine.boot()
  engine.voiceGoal('Add the empty-state screen and verify it', 30)
  engine.handleAction('start_planning')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'plan ready card shown')
  assert(events.at(-1).utterance.includes('3 workers'), 'split plan names 3 workers')

  engine.handleAction('begin')
  assert(engine.hasPendingDecision, 'build gate asks before spending credits')
  engine.handleAction('use_it')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running'), 'building card shown')
  assert(events.some((v) => v.kind === 'running' && v.utterance.includes('3 workers are building in parallel')), 'parallel build card names 3 workers')
  assert(clients.agentCount() === 2, 'mix spawned 2 Cursor agents and 1 Factory session')

  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final'), 'reached final card')
  assert(events.some((v) => v.kind === 'under_review'), 'branch went under review')
  assert(events.some((v) => v.kind === 'running' && v.utterance.includes('merging the branches')), 'integration card shown')
  const final = events.find((v) => v.kind === 'final')
  assert(final && final.accepted === 100 && final.pending === 0, 'final progress is 100% verified')
  engine.handleAction('show_evidence')
  const evidence = engine.currentView
  assert(evidence.type === 'selection' && evidence.items.some((i) => i.includes('PR #9')), 'evidence lists the opened PR')

  const snap = JSON.parse(JSON.stringify(engine.snapshot()))
  const events2 = []
  const engine2 = new RealOrchestrator(record(events2), { ...deps({ workerPref: 'mix', jobs: 3, askBeforePr: false }), clients })
  engine2.restore(snap)
  assert(engine2.currentView.type === 'scene' && engine2.currentView.scene.kind === 'final', 'snapshot restores to the final card')
}

// ------------------------- scenario B: 1 session worker, fail then pass

{
  const clients = makeClients({ verdictFailBranches: ['spriite/job-1'] })
  const events = []
  const engine = new RealOrchestrator(record(events), {
    ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: true }),
    clients,
  })
  engine.boot()
  engine.voiceGoal('Deliver the empty-state screen', 30)
  engine.handleAction('start_planning')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'plan ready (single worker)')
  engine.handleAction('begin')
  engine.handleAction('use_it')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running' && e.currentView.scene.utterance.includes('The worker is building')), 'single worker builds')
  assert(clients.leadSessionCount() === 2, 'lead session + one Factory session worker')

  assert(await drive(engine, (e) => events.some((v) => v.kind === 'repair')), 'failed verdict shows the repair card')
  assert(await drive(engine, (e) => e.hasPendingDecision && e.currentView.type === 'scene' && e.currentView.scene.kind === 'decision' && e.currentView.scene.utterance.includes('Open the pull request')), 'PR gate asks before opening')
  engine.handleAction('open_pr')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final'), 'reached final after the PR gate')
  const final = events.find((v) => v.kind === 'final')
  assert(final && final.accepted === 100 && final.pending === 0, 'final progress is 100% verified after repair')
  assert(events.some((v) => v.kind === 'decision'), 'decision card appeared')
}

// --------------------------------- restore guard: other setups start fresh

{
  const clientsA = makeClients()
  const eventsA = []
  const engineA = new RealOrchestrator(record(eventsA), { ...deps({ workerPref: 'mix', jobs: 3, askBeforePr: false }), clients: clientsA })
  engineA.boot()
  engineA.voiceGoal('Add the empty-state screen', 30)
  engineA.handleAction('start_planning')
  assert(await drive(engineA, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'scenario for snapshot')
  engineA.handleAction('begin')
  engineA.handleAction('use_it')
  assert(await drive(engineA, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running'), 'building for snapshot')
  const snap = JSON.parse(JSON.stringify(engineA.snapshot()))

  const eventsB = []
  const engineB = new RealOrchestrator(record(eventsB), { ...deps({ workerPref: 'mix', jobs: 2, askBeforePr: false }), clients: makeClients() })
  engineB.restore(snap)
  assert(engineB.currentView.type === 'selection' && engineB.currentView.purpose === 'projects', 'snapshot from another job count starts fresh at the projects home')
}

// ------------------- home: projects list, resume, live configure, prompts

{
  const clientsA = makeClients()
  const eventsA = []
  const engineA = new RealOrchestrator(record(eventsA), { ...deps({ workerPref: 'mix', jobs: 3, askBeforePr: false }), clients: clientsA })
  engineA.boot()
  engineA.voiceGoal('Add the empty-state screen and verify it', 30)
  engineA.handleAction('start_planning')
  assert(await drive(engineA, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'mission for the home list plans')
  engineA.handleAction('begin')
  engineA.handleAction('use_it')
  assert(await drive(engineA, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running'), 'mission for the home list runs')
  const snap = JSON.parse(JSON.stringify(engineA.snapshot()))

  const fakeProjects = {
    list: () => [{ goal: 'Add the empty-state screen and verify it', status: 'building', updatedAt: 1 }],
    snapshotFor: (goal) => (goal === 'Add the empty-state screen and verify it' ? snap : null),
  }
  const events = []
  const engine = new RealOrchestrator(record(events), { ...deps({ workerPref: 'mix', jobs: 3, askBeforePr: false }), clients: makeClients(), projects: fakeProjects })
  engine.boot()
  const home = engine.currentView
  assert(home.type === 'selection' && home.purpose === 'projects', 'home is the projects list')
  assert(home.items.length === 2 && home.items[0].includes('empty-state') && home.items[1] === 'New build', 'home lists the project plus New build')
  engine.chooseList(0)
  assert(engine.currentView.type === 'scene' && engine.currentView.scene.kind === 'running', 'selecting the project resumes its mission')
  engine.reset() // back to the projects home
  engine.chooseList(1)
  assert(engine.currentView.type === 'selection' && engine.currentView.purpose === 'goal', 'New build opens the goal list')

  // Live configure (panel saves hot-apply; no reload): repo appears, and the
  // save itself resumes the start that was waiting on it (the reported
  // stall: the glasses kept showing the prompt after the phone pick).
  const eventsNoRepo = []
  const clientsNoRepo = makeClients()
  const engineNoRepo = new RealOrchestrator(record(eventsNoRepo), { ...deps({ repoUrl: '', workerPref: 'factory', jobs: 1 }), clients: clientsNoRepo })
  engineNoRepo.boot()
  engineNoRepo.voiceGoal('Deliver the empty-state screen', 10)
  engineNoRepo.handleAction('start_planning')
  let v = engineNoRepo.currentView
  assert(v.type === 'scene' && v.scene.kind === 'setup_notice' && v.scene.utterance.includes('Pick a repository'), 'missing repository prompts from inside the flow')
  assert(v.scene.actions.some((a) => a.id === 'connect_repo' && a.kind === 'command') && v.scene.actions.some((a) => a.id === 'new_repo'), 'the repo prompt offers phone pick and New repo')
  engineNoRepo.configure({ repoUrl: REPO }) // the phone panel save
  assert(await drive(engineNoRepo, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'the repo save resumes the waiting start (no stall, no second tap)')
  engineNoRepo.handleAction('start_planning') // pressing Start again is a no-op
  assert(clientsNoRepo.leadSessionCount() === 1, 'the resumed start created exactly one lead session')

  // No Factory key: the home is the connect prompt (setup never gates boot).
  const engineNoFactory = new RealOrchestrator(record([]), { ...deps({ factoryKey: '', repoUrl: '' }), clients: makeClients() })
  engineNoFactory.boot()
  const noFactory = engineNoFactory.currentView
  assert(noFactory.type === 'scene' && noFactory.scene.kind === 'setup_notice' && noFactory.scene.utterance.includes('Connect Factory'), 'no Factory key: home is the connect prompt')
}

// -------------------- cloud builds home: merge, dedup, watch, attach

{
  // A driven mission snapshot (its lead session is 'sess-1' in these clients).
  const clientsA = makeClients()
  const eventsA = []
  const engineA = new RealOrchestrator(record(eventsA), { ...deps({ workerPref: 'mix', jobs: 3, askBeforePr: false }), clients: clientsA })
  engineA.boot()
  engineA.voiceGoal('Add the empty-state screen and verify it', 30)
  engineA.handleAction('start_planning')
  assert(await drive(engineA, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'mission for the cloud home plans')
  engineA.handleAction('begin')
  engineA.handleAction('use_it')
  assert(await drive(engineA, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running'), 'mission for the cloud home runs')
  const snap = JSON.parse(JSON.stringify(engineA.snapshot()))
  assert(snap.sessionId === 'sess-1', 'driven mission snapshot carries the lead session id')

  // Cloud: the same mission (deduped against the local row), one more Factory
  // session, and one Cursor agent.
  const clients = makeClients({
    cloudSessions: [
      { sessionId: 'sess-1', title: 'Add the empty-state screen and verify it', status: 'running', updatedAt: 99 },
      {
        sessionId: 'sess-9', title: 'Fix the login flake', status: 'running', updatedAt: 40, computerId: 'comp-1',
        msgs: [{ id: 'm-c1', role: 'assistant', text: 'Fixing the login flake now.' }],
      },
    ],
    cloudAgents: [
      { agentId: 'agent-9', name: 'Add the settings screen', status: 'ACTIVE', latestRunId: 'run-9', updatedAt: 30 },
    ],
  })
  const events = []
  const engine = new RealOrchestrator(record(events), {
    ...deps({ workerPref: 'mix', jobs: 3, askBeforePr: false }),
    clients,
    projects: {
      list: () => [{ goal: 'Add the empty-state screen and verify it', status: 'building', updatedAt: 50, sessionId: 'sess-1' }],
      snapshotFor: (goal) => (goal === 'Add the empty-state screen and verify it' ? snap : null),
    },
  })
  engine.boot()
  assert(await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.items.length === 4), 'cloud home lists 3 rows plus New build')
  const home = engine.currentView
  assert(home.items[0].includes('empty-state') && !home.items[0].includes('Factory'), 'locally-tracked mission keeps its row; its cloud twin dedups away')
  assert(home.items[1].includes('Fix the login flake') && home.items[1].includes('Factory'), 'a Factory cloud session lists as a row')
  assert(home.items[2].includes('Add the settings screen') && home.items[2].includes('Cursor'), 'a Cursor cloud agent lists as a row')
  assert(home.items[3] === 'New build', 'New build stays the last row')

  // Watching a Factory cloud build: priming shows its latest reply, new
  // replies surface as cards, and the live status shows in the status line.
  engine.chooseList(1)
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.utterance.includes('Fixing the login flake now.')), 'attaching the Factory session primes its latest reply')
  let v = engine.currentView
  assert(v.type === 'scene' && v.scene.status === 'Factory: building', 'the watch card carries the live session status')
  assert(engine.steer('Ship it when the checks pass') === true, 'Talk steers the watched session')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.status === 'Spriite replied' && e.currentView.scene.utterance.includes('Noted')), 'a watched session reply surfaces as a card')
  // The reply card is transient: it yields back to the watch card, and one
  // more back leaves the watch for the home (matching engine back rules).
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running' && e.currentView.scene.status === 'Factory: building'), 'the reply card yields back to the watch card')
  assert(engine.back() === 'handled', 'back leaves the watch card for the home')

  // Watching a Cursor cloud build: run status goes live, then the finished
  // summary shows on the card.
  assert(await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.items.length === 4), 'home rows return after the watch')
  engine.chooseList(2)
  v = engine.currentView
  assert(v.type === 'scene' && v.scene.status === 'Cursor: building | watch only', 'the Cursor watch card opens with the agent status')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.status === 'Cursor: done | watch only' && e.currentView.scene.utterance.includes('Cloud build finished the settings screen.')), 'the Cursor run finish surfaces its summary')
  assert(engine.back() === 'handled', 'back leaves the Cursor watch card for the home')

  // New build stays reachable: the last row opens the goal list.
  engine.chooseList(3)
  assert(engine.currentView.type === 'selection' && engine.currentView.purpose === 'goal', 'New build still opens the goal list')
}

// ------------------- snapshot-attach round trip across a restart

{
  const clients = makeClients({
    cloudSessions: [
      {
        sessionId: 'sess-9', title: 'Fix the login flake', status: 'running', updatedAt: 40,
        msgs: [{ id: 'm-c1', role: 'assistant', text: 'Fixing the login flake now.' }],
      },
    ],
  })
  const events = []
  const engine = new RealOrchestrator(record(events), { ...deps({ workerPref: 'mix', jobs: 3, askBeforePr: false }), clients })
  engine.boot()
  assert(await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.items.length === 2), 'cloud home lists the session plus New build')
  engine.chooseList(0)
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.utterance.includes('Fixing the login flake now.')), 'attach for the snapshot round trip')
  const snap = JSON.parse(JSON.stringify(engine.snapshot()))
  assert(snap.phase === 'attach' && snap.attach?.source === 'factory' && snap.attach.sessionId === 'sess-9', 'the attach watch lands in the snapshot')

  const events2 = []
  const engine2 = new RealOrchestrator(record(events2), { ...deps({ workerPref: 'mix', jobs: 3, askBeforePr: false }), clients })
  engine2.restore(snap)
  assert(engine2.currentView.type === 'scene' && engine2.currentView.scene.kind === 'running', 'the attach snapshot restores onto the watch card')
  engine2.boot()
  assert(await drive(engine2, (e) => e.currentView.type === 'scene' && e.currentView.scene.utterance.includes('Fixing the login flake now.')), 'the restored watch re-primes the session history')
}

// -------------------- computers: resolve, auto-pick, stale pick, prompt

{
  // No computer saved: the account's active computer is picked and passed
  // to the session create (Factory requires one; an empty create 400s).
  const clients = makeClients({ computers: [{ id: 'comp-live', name: 'Studio Mac', status: 'active' }] })
  const engine = new RealOrchestrator(record([]), {
    ...deps({ repoUrl: REPO, computerId: '', workerPref: 'factory', jobs: 1 }),
    clients,
  })
  engine.boot()
  engine.voiceGoal('Deliver the empty-state screen', 12)
  engine.handleAction('start_planning')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'no saved computer: the mission still plans')
  assert(clients.createdComputers()[0] === 'comp-live', 'the account computer is passed to the session create')

  // A stale saved computer is replaced by a live one (the saved pick died).
  const clientsStale = makeClients({ computers: [
    { id: 'comp-new', name: 'Studio Mac', status: 'active' },
    { id: 'comp-old', name: 'Retired Mac', status: 'error' },
  ] })
  const engineStale = new RealOrchestrator(record([]), {
    ...deps({ repoUrl: REPO, computerId: 'comp-old', workerPref: 'factory', jobs: 1 }),
    clients: clientsStale,
  })
  engineStale.boot()
  engineStale.voiceGoal('Deliver the empty-state screen', 12)
  engineStale.handleAction('start_planning')
  assert(await drive(engineStale, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'stale saved computer: the mission still plans')
  assert(clientsStale.createdComputers()[0] === 'comp-new', 'a stale saved computer is replaced by the live one')

  // No computer at all: an honest prompt, never a silent 400.
  const clientsNone = makeClients({ computers: [] })
  const eventsNone = []
  const engineNone = new RealOrchestrator(record(eventsNone), {
    ...deps({ repoUrl: REPO, computerId: '', workerPref: 'factory', jobs: 1 }),
    clients: clientsNone,
  })
  engineNone.boot()
  engineNone.voiceGoal('Deliver the empty-state screen', 12)
  engineNone.handleAction('start_planning')
  // The computer check resolves the account list first (async), so the
  // prompt lands a tick later; drive to it.
  assert(await drive(engineNone, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'setup_notice' && e.currentView.scene.utterance.includes('Factory needs a computer')), 'no computer: the mission prompts to connect one')
  assert(clientsNone.createdComputers().length === 0, 'no session create without a computer')
}

// ---------------------------- phone surface: say, listBuilds, openBuild

{
  const clients = makeClients()
  const events = []
  const engine = new RealOrchestrator(record(events), {
    ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }),
    clients,
    projects: {
      list: () => [{ goal: 'Add the empty-state screen', status: 'building', updatedAt: 5, sessionId: 'sess-1' }],
      snapshotFor: () => null,
    },
  })
  engine.boot()
  // Typed goal from the phone routes like a spoken one.
  assert(engine.say('Deliver the empty-state screen') === 'goal', 'say routes a typed goal')
  // A typed goal launches planning directly (no tap needed on the glasses).
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'plan ready for the phone-surface scenario')
  engine.handleAction('begin')
  assert(engine.hasPendingDecision, 'build gate asks before spending credits')
  // A typed answer routes to the pending decision.
  assert(engine.say('Yes, start it now') === 'decision', 'say routes a typed decision answer')
  assert(!engine.hasPendingDecision, 'the typed answer clears the decision')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running'), 'the build starts from the typed answer')
  // Mid-mission typing steers the lead session.
  assert(engine.say('Prefer small commits') === 'steer', 'say routes typed steering')
  // While a mission owns the engine, build rows stay closed; the list still shows.
  assert(engine.openBuild(0) === false, 'openBuild refuses while a mission runs')
  const builds = engine.listBuilds()
  assert(builds.length === 1 && builds[0].kind === 'local' && builds[0].title.includes('empty-state'), 'listBuilds mirrors the home rows for the phone')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final'), 'mission finishes for the phone-surface scenario')
  engine.reset()
  // On the home, openBuild resumes/attaches the row the phone tapped.
  assert(engine.openBuild(0) === true, 'openBuild opens a home row')
}

{
  console.log('Watch-only builds: local sessions never get API messages')
  // sess-local runs in the Factory app (no computer): the API 400s messages
  // to it, so Spriite watches it and a new request starts a new build.
  // sess-remote is on a computer but refuses this message.
  const clients = makeClients({
    cloudSessions: [
      {
        sessionId: 'sess-local', title: 'Local app session', status: 'running', updatedAt: 50,
        msgs: [{ id: 'm-l1', role: 'assistant', text: 'Working on it locally.' }],
      },
      {
        sessionId: 'sess-remote', title: 'Remote session', status: 'running', updatedAt: 40, computerId: 'comp-1',
        msgs: [{ id: 'm-r1', role: 'assistant', text: 'Working on it remotely.' }],
      },
    ],
    rejectPostSessions: ['sess-remote'],
  })
  const engine = new RealOrchestrator(record([]), {
    ...deps({ repoUrl: REPO, workerPref: 'factory', jobs: 1 }),
    clients,
  })
  engine.boot()
  assert(await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.items.length === 3), 'both cloud sessions list')
  engine.chooseList(0)
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.utterance.includes('Working on it locally.')), 'a local session still watches')
  let v = engine.currentView
  assert(v.type === 'scene' && v.scene.status === 'Factory: building | watch only', 'the local watch card says watch only')
  assert(engine.steer('Ship it') === false, 'Talk never posts to a local session')
  assert(engine.acceptsGoal() === true, 'a watch-only card takes a new goal')
  assert(engine.say('Add a dark mode toggle') === 'goal', 'typing on a watch-only card is a new goal')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'the new goal launches a Factory build and plans')
  assert(clients.leadSessionCount() === 1 && clients.createdComputers()[0] === 'comp-1', 'the new build is created on the active computer')
  assert(!clients.postedComputers().some((p) => p.id === 'sess-local'), 'nothing was ever posted to the local session')

  engine.reset()
  assert(await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.items.length >= 3), 'home returns after the reset')
  const rows = engine.currentView.items
  engine.chooseList(rows.findIndex((r) => r.includes('Remote session')))
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.utterance.includes('Working on it remotely.')), 'a computer session watches')
  assert(engine.acceptsGoal() === false && engine.steer('Ship it') === true, 'Talk steers a computer session')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.status === 'Service failed | Factory HTTP 400'), 'a refused message shows its code on a card')
  const posted = clients.postedComputers().find((p) => p.id === 'sess-remote')
  assert(posted?.computerId === 'comp-1', 'the message names the session computer')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running' && e.currentView.scene.status === 'Factory: building'), 'the refusal yields back to the watch; no permanent fault')
  assert(engine.steer('Try again') === true, 'the watch still takes messages after a refusal')
}

// ------------------------- new-repo missions (start from scratch)

{
  console.log('New-repo missions: a goal can start in a repository that does not exist yet')
  const clients = makeClients()
  const events = []
  const engine = new RealOrchestrator(record(events), {
    ...deps({ repoUrl: '', githubToken: 'gh-test', workerPref: 'factory', jobs: 1 }),
    clients,
  })
  engine.boot()
  engine.voiceGoal('Build a landing page for Acme!', 12)
  engine.handleAction('start_planning') // blocked: no repository chosen
  engine.handleAction('new_repo') // from the prompt card
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'the new-repo mission plans')
  const created = clients.repoCreated()
  assert(created.length === 1 && created[0].name === 'build-a-landing-page-for-acme' && created[0].isPrivate === true, 'the repository name derives from the goal (private)')
  const leadMsgs = await clients.getMessages('sess-1')
  assert(leadMsgs.some((m) => m.text.includes('Repository the worker builds on: https://github.com/example/build-a-landing-page-for-acme')), 'the plan request names the new repository')

  // The mission repo is frozen: a mid-mission repo save never moves the run.
  engine.handleAction('begin')
  engine.handleAction('use_it')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running'), 'the new-repo mission builds')
  engine.configure({ repoUrl: REPO }) // a panel save picks a different repo
  const snap = JSON.parse(JSON.stringify(engine.snapshot()))
  assert(snap.missionRepo === 'https://github.com/example/build-a-landing-page-for-acme', 'the snapshot carries the mission repository')
  const events2 = []
  const engine2 = new RealOrchestrator(record(events2), {
    ...deps({ repoUrl: REPO, workerPref: 'factory', jobs: 1, askBeforePr: false }),
    clients,
  })
  engine2.restore(snap)
  assert(engine2.snapshot().missionRepo === 'https://github.com/example/build-a-landing-page-for-acme', 'restore keeps the frozen mission repository')
  assert(await drive(engine2, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final'), 'the restored mission finishes')
  const msgs = await clients.getMessages('sess-1')
  assert(msgs.some((m) => m.text.includes('on https://github.com/example/build-a-landing-page-for-acme.')), 'the verdict request still names the mission repository')

  // Older snapshots (no missionRepo field) fall back to their saved repo.
  const legacy = JSON.parse(JSON.stringify(snap))
  delete legacy.missionRepo
  const engine3 = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients: makeClients() })
  engine3.restore(legacy)
  assert(engine3.snapshot().missionRepo === REPO, 'a legacy snapshot restores its repository from the old field')
}

{
  console.log('New-repo missions: taken names step aside, and Cursor workers build on the new repo')
  const clients = makeClients({ repoTakenNames: ['build-a-portfolio-site'] })
  const engine = new RealOrchestrator(record([]), {
    ...deps({ repoUrl: '', githubToken: 'gh-test', workerPref: 'cursor', jobs: 1, askBeforePr: false }),
    clients,
  })
  engine.boot()
  engine.voiceGoal('Build a portfolio site', 10)
  engine.handleAction('new_repo') // from the transcript card directly
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'the mission plans after the name fallback')
  const created = clients.repoCreated()
  assert(created.length === 1 && created[0].name === 'build-a-portfolio-site-2', 'a taken name steps aside to -2')
  engine.handleAction('begin')
  engine.handleAction('use_it')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final'), 'the Cursor worker finishes the new-repo mission')
  assert(clients.agentRepos().every((r) => r === 'https://github.com/example/build-a-portfolio-site-2'), 'the Cursor worker builds on the new repository')
}

{
  console.log('New-repo missions: no GitHub token prompts, and the token save resumes')
  const clients = makeClients()
  const engine = new RealOrchestrator(record([]), {
    ...deps({ repoUrl: '', githubToken: '', workerPref: 'factory', jobs: 1 }),
    clients,
  })
  engine.boot()
  engine.voiceGoal('Build a docs site', 10)
  engine.handleAction('new_repo')
  let v = engine.currentView
  assert(v.type === 'scene' && v.scene.kind === 'setup_notice' && v.scene.utterance.includes('add a GitHub token'), 'new repo without a token says what is missing')
  assert(v.scene.status === 'Connect GitHub' && v.scene.actions.some((a) => a.id === 'connect_github'), 'the card points at the GitHub setup step')
  engine.configure({ githubToken: 'gh-test' }) // the panel save
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'the token save resumes the new-repo start')
  assert(clients.repoCreated().length === 1, 'the repository was created after the token arrived')
}

{
  console.log('New-repo missions: the phone can type the goal and the name')
  const clients = makeClients()
  const engine = new RealOrchestrator(record([]), {
    ...deps({ repoUrl: REPO, githubToken: 'gh-test', workerPref: 'factory', jobs: 1 }),
    clients,
  })
  engine.boot()
  assert(engine.sayNewRepo('Ship a changelog page', 'changelog-page') === 'goal', 'sayNewRepo takes a typed new-repo goal')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'the typed new-repo goal plans')
  assert(clients.repoCreated().length === 1 && clients.repoCreated()[0].name === 'changelog-page', 'a typed name wins over the derived one')
  engine.reset()
  engine.say('Fix the footer') // back to the chosen repository
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'a normal typed goal still plans')
  assert(clients.repoCreated().length === 1 && clients.leadSessionCount() === 2, 'a normal goal creates no repository, just a session')
}

// --------------------------- fault card: Retry resumes the failed step

{
  console.log('Offline computer (HTTP 503): the fault names the daemon and Retry resumes')
  const clients = makeClients({ offlineCreateSessionOnce: true })
  const events = []
  const engine = new RealOrchestrator(record(events), { ...deps({ workerPref: 'factory', jobs: 1 }), clients })
  engine.boot()
  engine.voiceGoal('Deliver the empty-state screen', 10)
  engine.handleAction('start_planning')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'factory_error'), 'the offline computer faults')
  let v = engine.currentView
  assert(v.scene.utterance.includes('Your computer is offline'), 'the fault says the computer is offline')
  assert(v.scene.status === 'Computer offline | check Factory app', 'the status line points at the machine, not a code')
  assert(v.scene.actions.some((a) => a.id === 'retry'), 'the fault card offers Retry')
  engine.handleAction('retry') // the user started the daemon and pressed Retry
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'Retry re-runs the start after the daemon comes back')
  assert(clients.leadSessionCount() === 1, 'no session was created while offline')
}

{
  console.log('Mid-spawn failure: Retry resumes only the workers that never started')
  // Two Factory-session workers; the first worker create (2nd session call) fails once.
  const clients = makeClients({ failCreateSessionAtCall: 2 })
  const events = []
  const engine = new RealOrchestrator(record(events), {
    ...deps({ workerPref: 'factory', jobs: 2, askBeforePr: false }),
    clients,
  })
  engine.boot()
  engine.voiceGoal('Deliver the empty-state screen', 10)
  engine.handleAction('start_planning')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'the mission plans before the spawn fails')
  engine.handleAction('begin')
  engine.handleAction('use_it')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'factory_error'), 'the failed worker spawn faults the build')
  assert(engine.currentView.scene.actions.some((a) => a.id === 'retry'), 'the build fault offers Retry')
  engine.handleAction('retry')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final'), 'Retry spawns the missing worker and the mission finishes')
  assert(clients.leadSessionCount() === 3, 'exactly the lead and two workers exist after the retry')
}

// ----------------------- missing computer: Retry and the save resume it

{
  console.log('Missing computer: Retry re-attempts once the daemon is online')
  const computerList = [] // the user starts the daemon mid-flow
  const clients = makeClients({ computers: computerList })
  const engine = new RealOrchestrator(record([]), {
    ...deps({ repoUrl: REPO, computerId: '', workerPref: 'factory', jobs: 1 }),
    clients,
  })
  engine.boot()
  engine.voiceGoal('Deliver the empty-state screen', 12)
  engine.handleAction('start_planning')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'setup_notice' && e.currentView.scene.utterance.includes('Factory needs a computer')), 'no computer: the mission prompts to connect one')
  assert(engine.currentView.scene.actions.some((a) => a.id === 'retry_start'), 'the prompt offers Retry')
  computerList.push({ id: 'comp-live', name: 'Studio Mac', status: 'active' })
  engine.handleAction('retry_start')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'Retry proceeds once the computer is active')
  assert(clients.createdComputers()[0] === 'comp-live', 'the session create names the active computer')

  // A panel save that changes the saved computer resumes the wait too.
  const computerList2 = []
  const clients2 = makeClients({ computers: computerList2 })
  const engine2 = new RealOrchestrator(record([]), {
    ...deps({ repoUrl: REPO, computerId: '', workerPref: 'factory', jobs: 1 }),
    clients: clients2,
  })
  engine2.boot()
  engine2.voiceGoal('Deliver the empty-state screen', 12)
  engine2.handleAction('start_planning')
  assert(await drive(engine2, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'setup_notice' && e.currentView.scene.utterance.includes('Factory needs a computer')), 'blocked again without a computer')
  computerList2.push({ id: 'comp-b', name: 'Book Mac', status: 'active' })
  engine2.configure({ computerId: 'comp-b' }) // the panel save
  assert(await drive(engine2, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'the computer save resumes the waiting start')
  assert(clients2.createdComputers()[0] === 'comp-b', 'the resumed start runs on the saved computer')
}

// --------------- mid-mission goals steer the lead; they never strand the run

{
  console.log('Mid-mission goals steer the lead session')
  const clients = makeClients()
  const engine = new RealOrchestrator(record([]), {
    ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }),
    clients,
  })
  engine.boot()
  engine.say('Deliver the empty-state screen')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'the mission plans')
  engine.handleAction('begin')
  engine.handleAction('use_it')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running'), 'the mission builds')
  engine.voiceGoal('Also add a dark mode toggle', 6)
  const msgs = await clients.getMessages('sess-1')
  assert(msgs.some((m) => m.role === 'user' && m.text === 'New goal: Also add a dark mode toggle'), 'a spoken mid-mission goal steers the lead')
  // Talk without a voice key mid-mission never fakes a transcript card.
  const before = engine.snapshot().phase
  engine.transcriptGoal(5)
  let v = engine.currentView
  assert(v.type === 'scene' && v.scene.kind === 'setup_notice' && v.scene.utterance.includes('ElevenLabs'), 'keyless Talk mid-mission says what is missing')
  assert(engine.snapshot().phase === before, 'the keyless Talk never switches the running mission to a transcript card')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final'), 'the mission still finishes')
}

{
  console.log('Ring input: fast scroll ticks all move focus')
  const realNow = Date.now
  let t = 1_000_000
  Date.now = () => t
  try {
    const out = []
    const norm = new InputNormalizer((e) => out.push(e.type))
    const tick = (type) => norm.handle({ textEvent: { eventType: type } })
    // A quick ring flick: five ticks 25 ms apart, then three back.
    for (let i = 0; i < 5; i++) { tick(OsEventTypeList.SCROLL_BOTTOM_EVENT); t += 25 }
    for (let i = 0; i < 3; i++) { tick(OsEventTypeList.SCROLL_TOP_EVENT); t += 25 }
    assert(out.filter((x) => x === 'next').length === 5, 'every fast forward tick becomes a next')
    assert(out.filter((x) => x === 'previous').length === 3, 'every fast backward tick becomes a previous')
    // The same envelope delivered twice within a few ms is still one tick.
    out.length = 0
    t += 100
    tick(OsEventTypeList.SCROLL_BOTTOM_EVENT); t += 2
    tick(OsEventTypeList.SCROLL_BOTTOM_EVENT)
    assert(out.length === 1, 'a duplicate delivery inside the tight window is dropped')
    norm.dispose()
  } finally {
    Date.now = realNow
  }
}

if (failures > 0) {
  console.log(`REAL ENGINE TEST FAILED: ${failures} failures`)
  process.exit(1)
}
console.log('REAL ENGINE TEST PASSED: plan, 3 mixed workers, reviews, repair loop, integration, PR gate, projects home, resume, live configure, cloud builds home, watch + attach, computer resolve + prompt, phone surface (say, listBuilds, openBuild), new-repo missions, blocked-start resume, fault Retry, mid-spawn resume, mid-mission steering')
