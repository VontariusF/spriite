/**
 * Real-engine fake-pipeline test (dev tool). Drives the full real pipeline
 * (plan -> parallel workers -> review verdicts -> fix loop -> integration
 * -> PR -> final) against fake service clients injected through the
 * engine's client seam, with synthetic time and deterministic replies.
 * No network, no keys, no credits; the HUD contract is asserted the same
 * way the simulator walkthroughs assert theirs.
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
import { matchCommand, parseUtterance } from '../src/voice/intent.ts'
import { OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { composeGoal } from '../src/context/gather.ts'
import { validateScene } from '../src/scenes/validate.ts'

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
  pullNumber = 9,
  verdictFailBranches = [],
  cloudSessions = [],
  cloudAgents = [],
  computers = [{ id: 'comp-1', name: 'Studio Mac', status: 'active' }],
  rejectPostSessions = [],
  repoTakenNames = [],
  // Fault injections: the Nth createSession call throws instead.
  offlineCreateSessionOnce = false,
  failCreateSessionAtCall = 0,
  // Scripted conversation: the plan request first asks planQuestion (the
  // answer's reply carries the numbered plan), or with planChatter first
  // chats (the re-request carries the numbered plan); a steer naming a
  // database asks steerQuestion mid-build.
  planQuestion = '',
  planChatter = false,
  steerQuestion = '',
  // Network blips: the Nth postMessage call (1-based, across all sessions)
  // loses acknowledgment. No automatic replay is permitted; deliverAttempt
  // can reveal delayed backend acceptance for read-only reconciliation.
  blipPosts = [],
  // Real failures: the Nth postMessage call throws kind:'service' instead.
  // Unlike a blip these are not retryable on their own — they must fault.
  serviceFailPosts = [],
  // Launch blips: the Nth createSession / cursorAgent / cursorRun / createRepo
  // call throws kind:'network' instead of launching. A launch has no durable
  // record in the raw engine, so these must surface as a fault card with a
  // Retry, never park the mission with nothing pending.
  blipCreateSessionAt = 0,
  blipCursorAgentAt = 0,
  blipCursorRunAt = 0,
  blipCursorRunOn = '', // blip the first cursorRun whose prompt matches this text
  blipCreateRepoAt = 0,
} = {}) {
  const sessions = new Map() // id -> { msgs: [], count, status }
  const runs = new Map() // runId -> { agentId, prompt, polls }
  let sessN = 0
  let agentN = 0
  let runN = 0
  let msgN = 0
  let createCalls = 0
  let postN = 0
  let agentCalls = 0
  let runCalls = 0
  let repoCalls = 0
  let blipRunOnFired = false
  const runPrompts = [] // prompt per cursorRun call, in order
  const blipErr = () => Object.assign(new Error('Factory unreachable'), { kind: 'network' })
  let planAsked = false
  let planAnswered = false
  let planChattered = false
  let offlineFails = offlineCreateSessionOnce ? 1 : 0
  const repoCreates = [] // { name, isPrivate } per createRepo call
  const agentRepos = [] // repoUrl per cursor agent create
  const agentRepository = new Map()
  const verdictFails = new Map() // branch -> times failed
  const createdWith = [] // computerId per createSession call, in order
  const createdSettings = [] // sessionSettings per createSession call, in order
  const updatedWith = [] // { id, sessionSettings, computerId } per updateSession call (a spy: the engine must never PATCH)
  const postedWith = [] // { id, computerId } per postMessage call
  const attemptedPosts = []
  const repositoryArtifacts = new Map()
  let commitNumber = 1
  let repositoryNumber = 100
  const repositoryKey = url => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password) throw new Error('Invalid fixture repository')
    return `https://github.com${parsed.pathname.replace(/\.git$/i, '').toLowerCase()}`
  }
  const artifactsFor = (url) => {
    url = repositoryKey(url)
    if (!repositoryArtifacts.has(url)) repositoryArtifacts.set(url, {
      id: ++repositoryNumber, defaultBranch: 'main', baseSha: 'b'.repeat(40), branches: new Map(), pulls: new Map(),
    })
    return repositoryArtifacts.get(url)
  }
  const readArtifacts = url => {
    const resource = repositoryArtifacts.get(repositoryKey(url))
    if (!resource) throw Object.assign(new Error('GitHub HTTP 404 (repository not observed)'), { kind: 'service' })
    return resource
  }
  artifactsFor(REPO)
  const writeArtifact = (url, branch, pr = false, number = pullNumber) => {
    const resource = readArtifacts(url)
    if (!branch) throw new Error('Synthetic worker cannot publish an unnamed artifact')
    if (pr) {
      if (!resource.branches.has(branch)) throw new Error('Synthetic PR has no published branch')
      resource.pulls.set(number, { branch, headSha: resource.branches.get(branch), baseRef: resource.defaultBranch, baseSha: resource.baseSha })
    } else resource.branches.set(branch, (++commitNumber).toString(16).padStart(40, '0'))
  }

  // Cloud rows predate this engine: Factory sessions carry their history and
  // a live status; Cursor agents carry their latest run.
  for (const c of cloudSessions) {
    sessions.set(c.sessionId, {
      msgs: c.msgs ?? [{ id: `m-cloud-${c.sessionId}`, role: 'assistant', text: c.title }],
      count: c.msgs?.length ?? 1,
      status: c.status ?? 'idle',
      computer: c.computerId ?? null,
    })
  }
  for (const a of cloudAgents) {
    if (a.latestRunId) runs.set(a.latestRunId, { agentId: a.agentId, prompt: 'cloud watch', polls: 0, repoUrl: REPO })
  }

  const leadReply = (text) => {
    // Dispatch from the current turn's envelope, not substrings embedded in
    // complete approved criteria or quoted earlier owner clarifications.
    if (/final line exactly VERDICT_READY/.test(text)) {
      const branch = /^The worker pushed branch "([^"]+)"/.exec(text)?.[1] ?? ''
      if (verdictFailBranches.some((b) => b === branch || b.split('/').at(-1) === branch.split('/').at(-1)) && !verdictFails.has(branch)) {
        verdictFails.set(branch, 1)
        return 'VERDICT: FAIL The empty state renders but the retry path skips failed requests.'
      }
      return 'VERDICT: PASS The diff matches the goal and the checks hold.'
    }
    if (/^The pull request is open:/.test(text)) return 'SUMMARY: Delivered the empty-state screen.'
    if (/^You are the orchestrator|^Reply with a milestone plan/.test(text)) {
      if (planQuestion && !planAsked) {
        planAsked = true
        return planQuestion
      }
      if (planChatter && !planChattered) {
        planChattered = true
        return 'Let me look at the repository first.'
      }
      return '1. Add the empty-state screen\n2. Wire the retry path\n3. Check the layout bounds\nPLAN_READY'
    }
    if (steerQuestion && /database/i.test(text)) return steerQuestion
    if (planQuestion && planAsked && !planAnswered) {
      planAnswered = true
      return '1. Add the empty-state screen\n2. Wire the retry path\n3. Check the layout bounds\nPLAN_READY'
    }
    return 'SUMMARY: Noted.'
  }

  const workerReply = (text) => {
    const branch = /branch named (spriite\/[\w/-]+)/.exec(text)?.[1]
    if (/Fix the findings/.test(text)) {
      return `SUMMARY: Fixed the findings on ${branch}.\nBRANCH: ${branch}`
    }
    if (/Merge these branches/.test(text)) {
      return `SUMMARY: Merged the branches.\nBRANCH: ${branch}`
    }
    if (/Open a pull request/.test(text)) {
      const repo = /to the [^\n]+ branch on (https:\/\/\S+)\./.exec(text)?.[1] ?? REPO
      return `SUMMARY: Opened the pull request.\nPR: ${repo}/pull/${pullNumber}`
    }
    return `SUMMARY: Implemented the job on ${branch}.\nBRANCH: ${branch}`
  }

  // The API finds a computer-hosted session only on its own computer: a
  // call that names no computer (or a different one) answers 404. A local
  // session has no computer; naming one hides it the same way.
  const hidden404 = (id, computerId) => {
    const s = sessions.get(id)
    if (!s) return false
    if (s.computer == null) return computerId != null && computerId !== ''
    return computerId !== s.computer
  }
  const session404 = () => {
    const e = new Error('Factory HTTP 404 (session does not exist)')
    e.kind = 'service'
    return e
  }

  const completeReply = (prompt, reply) => {
    const token = /"REQUEST: ([^"]+)"/.exec(prompt)?.[1]
    const marker = /final line exactly (VERDICT_READY|WORK_READY)/.exec(prompt)?.[1]
    return token && marker ? `${reply}\nREQUEST: ${token}\n${marker}` : reply
  }

  const post = (sessionId, text) => {
    const s = sessions.get(sessionId)
    if (!s) throw new Error('unknown session ' + sessionId)
    s.msgs.push({ id: `m${++msgN}`, role: 'user', text })
    // The reply follows the message protocol, not the session ordinal: after
    // a reset the next lead is the second session created in these clients.
    const isWorker = s.worker === true
    if (isWorker) s.repoUrl = /^Implement it on the repository (https:\/\/\S+)\.$/m.exec(text)?.[1] ?? s.repoUrl
    const reply = /^Report the result of your existing /.test(text)
      ? [...s.msgs].reverse().find((m) => m.role === 'assistant' && /^SUMMARY:/m.test(m.text) && (text.includes('PR: lines') ? /^PR:/m : /^BRANCH:/m).test(m.text))?.text.split('\nREQUEST:')[0] ?? 'Still waiting for the existing result.'
      : isWorker ? workerReply(text) : leadReply(text)
    if (isWorker && !/^Report the result of your existing /.test(text)) {
      const prBranch = /from branch "([^"]+)"/.exec(text)?.[1]
      const branch = /^BRANCH:\s*(\S+)/m.exec(reply)?.[1]
      if (prBranch) writeArtifact(s.repoUrl, prBranch, true)
      else if (branch) writeArtifact(s.repoUrl, branch)
    }
    s.msgs.push({ id: `m${++msgN}`, role: 'assistant', text: completeReply(text, reply) })
    s.count = s.msgs.length
  }

  return {
    leadSessionCount: () => sessN,
    agentCount: () => agentN,
    /** computerId per createSession call, in order (assert the resolution). */
    createdComputers: () => createdWith.slice(),
    /** sessionSettings per createSession call, in order (assert threading). */
    createdSettings: () => createdSettings.slice(),
    /** { id, sessionSettings, computerId } per live-settings PATCH. */
    updatedSettings: () => updatedWith.slice(),
    computers: async () => computers.map((c) => ({ ...c })),
    /** Names handed to createRepo, in order (with the private flag). */
    repoCreated: () => repoCreates.slice(),
    /** Prompt per cursorRun call, in order (assert the merge prompt's branches). */
    cursorRunPrompts: () => runPrompts.slice(),
    /** The messages a session holds, in order (assert the lead's turn order). */
    msgsOf: (id) => sessions.get(id)?.msgs.map((m) => m.text) ?? [],
    /** Repository per Cursor agent create (workers build on the mission repo). */
    agentRepos: () => agentRepos.slice(),
    createRepo: async (name, isPrivate) => {
      repoCalls += 1
      if (blipCreateRepoAt === repoCalls) throw blipErr()
      if (repoTakenNames.includes(name)) {
        const e = new Error('GitHub HTTP 422')
        e.kind = 'exists'
        throw e
      }
      repoCreates.push({ name, isPrivate })
      artifactsFor(`https://github.com/example/${name}`)
      return { url: `https://github.com/example/${name}` }
    },
    createSession: async (opts) => {
      createCalls += 1
      if (blipCreateSessionAt === createCalls) throw blipErr()
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
      createdWith.push(opts?.computerId ?? '')
      createdSettings.push(opts?.sessionSettings ?? null)
      sessions.set(id, { msgs: [], count: 0, status: 'idle', computer: opts?.computerId || null,
        worker: opts?.sessionSettings?.tags?.some(tag => tag.name === 'spriite') === true, repoUrl: REPO })
      return { sessionId: id }
    },
    updateSession: async (id, sessionSettings, computerId) => {
      if (hidden404(id, computerId)) throw session404()
      updatedWith.push({ id, sessionSettings, computerId: computerId ?? '' })
    },
    getSession: async (id, computerId) => {
      if (hidden404(id, computerId)) throw session404()
      const s = sessions.get(id)
      return { messageCount: s?.count ?? 0, status: s?.status ?? 'idle' }
    },
    getMessages: async (id, computerId) => {
      if (hidden404(id, computerId)) throw session404()
      return sessions.get(id)?.msgs.slice() ?? []
    },
    postedComputers: () => postedWith.slice(),
    postCount: () => postN,
    attemptedPosts: () => attemptedPosts.map(p => ({ ...p })),
    publishBranch: (branch, repository = REPO) => writeArtifact(repository, branch),
    publishPr: (branch, number = 9, repository = REPO) => writeArtifact(repository, branch, true, number),
    deliverAttempt: (number) => {
      const attempt = attemptedPosts[number - 1]
      if (!attempt || attempt.delivered) throw new Error('Only an undelivered original attempt may settle')
      post(attempt.id, attempt.text)
      attempt.delivered = true
    },
    repositoryBase: async (repository, selectedRef) => {
      const resource = readArtifacts(`https://github.com/${repository}`)
      const ref = selectedRef ?? resource.defaultBranch
      if (ref !== resource.defaultBranch) throw Object.assign(new Error('GitHub HTTP 404 (base not found)'), { kind: 'service' })
      return { ref, sha: resource.baseSha, repositoryId: resource.id }
    },
    branchEvidence: async (repository, branch, baseRef) => {
      const resource = readArtifacts(`https://github.com/${repository}`)
      if (baseRef !== resource.defaultBranch || !resource.branches.has(branch)) throw Object.assign(new Error('GitHub HTTP 404 (branch not observed)'), { kind: 'service' })
      return { headSha: resource.branches.get(branch), baseSha: resource.baseSha }
    },
    pullEvidence: async (repository, number, branch, baseRef, headSha, approvedBaseSha) => {
      const resource = readArtifacts(`https://github.com/${repository}`)
      const pull = resource.pulls.get(number)
      if (!pull || pull.branch !== branch || pull.baseRef !== baseRef || pull.headSha !== headSha ||
        pull.baseSha !== resource.baseSha || (approvedBaseSha !== undefined && pull.baseSha !== approvedBaseSha)) {
        throw new Error('PR does not match independently recorded repository/base/head')
      }
    },
    postMessage: async (id, text, computerId) => {
      if (hidden404(id, computerId)) throw session404()
      postedWith.push({ id, computerId: computerId ?? '' })
      if (rejectPostSessions.includes(id)) {
        const e = new Error('Factory HTTP 400 (Bad Request: session is not connected to a computer)')
        e.kind = 'service'
        throw e
      }
      postN += 1
      attemptedPosts.push({ id, text, computerId, delivered: false })
      if (serviceFailPosts.includes(postN)) {
        // A real failure (the API refused the request): not a blip.
        const e = new Error('Factory HTTP 400 (request refused before execution)')
        e.kind = 'service'
        throw e
      }
      if (blipPosts.includes(postN)) {
        // A network blip: the response is lost; the request may or may not
        // have landed. The engine must hold until independent evidence arrives.
        const e = new Error('Factory unreachable')
        e.kind = 'network'
        throw e
      }
      post(id, text)
      attemptedPosts.at(-1).delivered = true
    },
    interrupt: async () => {},
    listFactorySessions: async () => cloudSessions.map(({ msgs, ...card }) => ({ ...card })),
    listCursorAgents: async () => cloudAgents.map((a) => ({ ...a })),
    cursorAgent: async (promptText, repoUrl) => {
      agentCalls += 1
      if (blipCursorAgentAt === agentCalls) throw blipErr()
      const agentId = `agent-${++agentN}`
      const runId = `run-${++runN}`
      agentRepos.push(repoUrl)
      agentRepository.set(agentId, repoUrl)
      runs.set(runId, { agentId, prompt: promptText, polls: 0, repoUrl })
      return { agentId, runId }
    },
    cursorRun: async (agentId, promptText) => {
      runCalls += 1
      runPrompts.push(promptText)
      if (blipCursorRunOn !== '' && !blipRunOnFired && promptText.includes(blipCursorRunOn)) {
        blipRunOnFired = true
        throw blipErr()
      }
      if (blipCursorRunAt === runCalls) throw blipErr()
      const runId = `run-${++runN}`
      runs.set(runId, { agentId, prompt: promptText, polls: 0, repoUrl: agentRepository.get(agentId) ?? REPO })
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
        const branch = /from branch "([^"]+)"/.exec(prompt)?.[1]
        if (!r.published) { writeArtifact(r.repoUrl, branch, true); r.published = true }
        return {
          id: runId, status: 'FINISHED', text: 'Opened the pull request.',
          branches: [{ repoUrl: r.repoUrl, branch: /from branch "([^"]+)"/.exec(prompt)?.[1], prUrl: `${r.repoUrl}/pull/${pullNumber}` }],
        }
      }
      const branch = /branch named (spriite\/[\w/-]+)/.exec(prompt)?.[1] ?? ''
      if (branch && !r.published) { writeArtifact(r.repoUrl, branch); r.published = true }
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
  // Subsequent drives must not move synthetic time backwards: otherwise a
  // retained nextPoll silently prevents later acknowledgment reconciliation.
  const start = engine.nowMs
  for (let t = 0; t <= maxMs; t += 500) {
    engine.tick(start + t)
    await new Promise((r) => setTimeout(r, 0))
    if (until(engine)) return true
  }
  return false
}

async function bindFrozenMission(engine) {
  engine.missionRepo = REPO
  await engine.resolveComputer()
  if (!await engine.freezeRepositoryBase(false)) throw new Error('Fixture base preflight did not settle')
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
  assert(events.some((v) => v.kind === 'running' && v.utterance.includes('Requests were sent to 3 workers')), 'parallel build card reports 3 requests, not unobserved execution')
  assert(clients.agentCount() === 2, 'mix spawned 2 Cursor agents and 1 Factory session')

  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final'), 'reached final card')
  assert(events.some((v) => v.kind === 'under_review'), 'branch went under review')
  assert(events.some((v) => v.kind === 'running' && v.utterance.includes('merge the branches')), 'integration request card shown without assuming it is executing')
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
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running' && e.currentView.scene.utterance.includes('The worker request was sent')), 'single worker request acknowledged; completion still awaited')
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
  assert(home.items.length === 2 && home.items[0].startsWith('Empty-state screen') && home.items[1] === 'New build', 'home lists the project (named as the HUD titles it) plus New build')
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

// ------------------ setup gate: the real engine owns every card
// A working setup (Factory key + repository): boot lands on the projects
// home, a real failure shows the honest failure card (Retry/Talk/Restart),
// and restart from anywhere lands on the real home. Without credentials the
// first-run home asks to connect Factory.

{
  const events = []
  const engine = new RealOrchestrator(record(events), { ...deps({}), clients: makeClients() })
  engine.boot()
  const home = engine.currentView
  assert(
    home.type === 'selection' && home.purpose === 'projects' && home.items.at(-1) === 'New build',
    'with credentials: boot lands on the projects home',
  )

  const clients = makeClients({ offlineCreateSessionOnce: true })
  const failEvents = []
  const failer = new RealOrchestrator(record(failEvents), { ...deps({ workerPref: 'factory', jobs: 1 }), clients })
  failer.boot()
  failer.voiceGoal('Deliver the empty-state screen', 30)
  failer.handleAction('start_planning')
  assert(
    await drive(failer, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'factory_error'),
    'a real failure shows the honest fault card',
  )
  const fault = failer.currentView.scene
  assert(fault.actions.some((a) => a.id === 'retry'), 'the failure card offers Retry')
  failer.reset()
  const back = failer.currentView
  assert(
    back.type === 'selection' && back.purpose === 'projects',
    'restart from a failure lands on the real home',
  )

  const bare = new RealOrchestrator(record([]), { ...deps({ factoryKey: '', repoUrl: '' }), clients: makeClients() })
  bare.boot()
  const prompt = bare.currentView.scene
  assert(
    prompt.actions.some((a) => a.id === 'connect_factory') && prompt.actions.every((a) => ['connect_factory', 'talk'].includes(a.id)),
    'without credentials: the connect prompt offers Connect and Talk only',
  )
}

// -------------------- cloud builds home: merge, dedup, watch, attach

{
  // A mission's OWN worker session (a remote id its row owns) must never show
  // as a foreign cloud build the owner could adopt or steer (spec §4). The
  // projects source names every owned remote id; the home dedups all of them.
  const clients = makeClients({
    cloudSessions: [
      { sessionId: 'worker-1', title: 'Job one worker', status: 'running', updatedAt: 90 },
      { sessionId: 'sess-x', title: 'Someone else build', status: 'running', updatedAt: 20 },
    ],
    cloudAgents: [{ agentId: 'agent-own', name: 'Our own cursor agent', status: 'ACTIVE', latestRunId: 'run-own', updatedAt: 80 }],
  })
  const events = []
  const engine = new RealOrchestrator(record(events), {
    ...deps({ workerPref: 'mix', jobs: 3, askBeforePr: false }),
    clients,
    projects: {
      list: () => [
        { goal: 'Our durable mission', status: 'building', updatedAt: 95, sessionId: 'lead-1', ownedRemoteIds: ['lead-1', 'worker-1', 'agent-own', 'run-own'] },
      ],
      snapshotFor: () => null,
    },
  })
  engine.boot()
  // The local row, the one genuinely foreign cloud build, and New build: our
  // own worker session and Cursor agent are deduped away.
  assert(
    await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.items.length === 3),
    'the home dedups a mission’s own worker sessions and agents, leaving only foreign rows',
  )
  const home = engine.currentView
  assert(home.items[0].startsWith('Durable mission'), 'the durable mission keeps its own row (its build name)')
  assert(home.items[1].includes('Someone else build'), 'a genuinely foreign cloud build still lists')
  assert(home.items[2] === 'New build', 'New build stays the last row')
}

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
  assert(home.items[0].startsWith('Empty-state screen') && !home.items[0].includes('Factory'), 'locally-tracked mission keeps its row; its cloud twin dedups away')
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
  await new Promise((r) => setTimeout(r, 0)) // the post resolves, then the card
  let wsv = engine.currentView
  assert(wsv.type === 'scene' && wsv.scene.kind === 'status_answer' && wsv.scene.utterance.includes('Ship it when the checks pass') && wsv.scene.status.includes('Sent to Factory'), 'a watched-build steer confirms on the glasses')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.status === 'Watched build replied' && e.currentView.scene.utterance.includes('Noted')), 'a watched session reply surfaces as a card labeled as the watched build')
  // The reply card is transient: it yields back to the watch card, and one
  // more back leaves the watch for the home (matching engine back rules).
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running' && e.currentView.scene.status === 'Factory: building'), 'the reply card yields back to the watch card')
  assert(engine.back() === 'handled', 'back leaves the watch card for the home')

  // Watching a Cursor cloud build: run status goes live, then the finished
  // summary shows on the card.
  assert(await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.items.length === 4), 'home rows return after the watch')
  engine.chooseList(2)
  v = engine.currentView
  assert(v.type === 'scene' && v.scene.status === 'Cursor: building · watch only', 'the Cursor watch card opens with the agent status')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.status === 'Cursor: done · watch only' && e.currentView.scene.utterance.includes('Cloud build finished the settings screen.')), 'the Cursor run finish surfaces its summary')
  assert(engine.back() === 'handled', 'back leaves the Cursor watch card for the home')

  // New build stays reachable: the last row opens the goal list.
  engine.chooseList(3)
  assert(engine.currentView.type === 'selection' && engine.currentView.purpose === 'goal', 'New build still opens the goal list')
}

// ------------- activity truth: labels, ages, staleness, unknown, newer runs

{
  const { epochMs } = await import('../src/factory/fapi.ts')
  const ms = Date.UTC(2026, 9, 7, 12)
  assert(epochMs(ms) === ms, 'epoch ms pass through')
  assert(epochMs(ms / 1000) === ms, 'epoch seconds become ms (rows sort with Cursor ISO times)')
  assert(epochMs(new Date(ms).toISOString()) === ms, 'ISO timestamps parse')
  assert(epochMs(undefined) === 0 && epochMs(42) === 0 && epochMs('soon') === 0, 'unknown timestamps are 0, never a fake age')
}

{
  const BASE = Date.UTC(2026, 9, 7, 12) // real epoch ms, so row ages apply
  const H = 3600_000
  const blip = () => Object.assign(new Error('Factory unreachable'), { kind: 'network' })
  const driveAt = async (engine, from, until, maxMs = 120000) => {
    for (let t = from; t <= from + maxMs; t += 500) {
      engine.tick(t)
      await new Promise((r) => setTimeout(r, 0))
      if (until(engine)) return t
    }
    return -1
  }
  const cloudSessions = [
    {
      sessionId: 'sess-live', title: 'Fix the login flake', status: 'running', updatedAt: BASE - 5 * H, computerId: 'comp-1',
      msgs: [{ id: 'm-l1', role: 'assistant', text: 'Fixing the login flake now.' }],
    },
    { sessionId: 'sess-old', title: 'Tidy the docs', status: 'idle', updatedAt: BASE - 3 * H },
    { sessionId: 'sess-new', title: 'Queue the export', status: 'pending', updatedAt: BASE - 2 * H },
  ]
  const cloudAgents = [
    { agentId: 'agent-old', name: 'Add the settings screen', status: 'IDLE', latestRunId: 'run-old', updatedAt: BASE - 48 * H },
  ]
  const clients = makeClients({ cloudSessions, cloudAgents })
  const engine = new RealOrchestrator(() => {}, { ...deps({ workerPref: 'mix', jobs: 1, askBeforePr: false }), clients })
  engine.boot()
  let t = await driveAt(engine, BASE, (e) => e.currentView.type === 'selection' && e.currentView.items.length === 5)
  assert(t >= 0, 'activity home lists four cloud rows plus New build')
  let items = engine.currentView.items
  const row = (title) => items.find((i) => i.includes(title)) ?? ''
  assert(row('Fix the login flake').endsWith('Factory: building'), 'a running session reads building, with no age')
  assert(row('Tidy the docs').endsWith('Factory: idle 3h'), 'an idle session reads idle with its age, not waiting')
  assert(row('Queue the export').endsWith('Factory: queued'), 'a pending session reads queued, not running')
  assert(row('Add the settings screen').endsWith('Cursor: idle 2d'), 'an idle Cursor agent reads idle with its age')
  assert(engine.currentView.title === 'Builds', 'a current cloud list keeps the plain title')

  // A failed refresh keeps the rows but the title says how old they are.
  const listFactory = clients.listFactorySessions
  clients.listFactorySessions = async () => { throw blip() }
  t = await driveAt(engine, t, (e) => e.currentView.title.startsWith('Builds · as of'))
  assert(t >= 0 && engine.currentView.items.length === 5, 'a failed refresh marks the rows stale and keeps them')
  clients.listFactorySessions = listFactory
  t = await driveAt(engine, t, (e) => e.currentView.title === 'Builds')
  assert(t >= 0, 'the next good refresh clears the stale title')

  // Leaving a watch refreshes the home at once, not a full cadence later.
  engine.chooseList(items.indexOf(row('Fix the login flake')))
  t = await driveAt(engine, t, (e) => e.currentView.type === 'scene' && e.currentView.scene.status === 'Factory: building')
  assert(t >= 0, 'the Factory watch card shows building')
  assert(engine.currentView.scene.spritePose === 'waiting', 'a building watch shows the working pose')

  // Status checks that keep failing stop showing the last status as current.
  const getSession = clients.getSession
  clients.getSession = async () => { throw blip() }
  t = await driveAt(engine, t, (e) => e.currentView.type === 'scene' && e.currentView.scene.status === 'Factory: status unknown, retrying')
  assert(t >= 0, 'repeated failed checks say the status is unknown')
  assert(engine.currentView.scene.spritePose === 'reconciling', 'an unknown status shows the reconciling pose')
  clients.getSession = getSession
  t = await driveAt(engine, t, (e) => e.currentView.type === 'scene' && e.currentView.scene.status === 'Factory: building')
  assert(t >= 0, 'a good check restores the live status')

  cloudSessions[0].status = 'idle'
  assert(engine.back() === 'handled', 'back leaves the watch')
  engine.tick(t + 500)
  await new Promise((r) => setTimeout(r, 0))
  items = engine.currentView.items
  assert(engine.currentView.type === 'selection' && row('Fix the login flake').includes('Factory: idle'), 'returning home refreshes the rows on the next tick')

  // A finished Cursor run is not the agent's last word: a newer run shows.
  engine.chooseList(items.indexOf(row('Add the settings screen')))
  t = await driveAt(engine, t + 500, (e) => e.currentView.type === 'scene' && e.currentView.scene.status === 'Cursor: done · watch only')
  assert(t >= 0 && engine.currentView.scene.spritePose === 'idle', 'the finished run reads done with the idle pose')
  const cursorGet = clients.cursorGet
  clients.cursorGet = async (agentId, runId) =>
    runId === 'run-next' ? { id: runId, status: 'RUNNING', text: '', branches: [] } : cursorGet(agentId, runId)
  cloudAgents[0].latestRunId = 'run-next'
  cloudAgents[0].status = 'ACTIVE'
  t = await driveAt(engine, t, (e) => e.currentView.type === 'scene' && e.currentView.scene.status === 'Cursor: building · watch only')
  assert(t >= 0, 'a newer run on the watched agent shows as building')
  assert(!engine.currentView.scene.utterance.includes('Cloud build finished'), 'the old run summary is not shown for the new run')
  engine.back()
}

// ------------------- snapshot-attach round trip across a restart

{
  const clients = makeClients({
    cloudSessions: [
      {
        sessionId: 'sess-9', title: 'Fix the login flake', status: 'running', updatedAt: 40,
        computerId: 'comp-1',
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
  engine.configure({ model: 'claude-opus-4-5' })
  await new Promise((r) => setTimeout(r, 0))
  assert(clients.updatedSettings().length === 0, 'changing defaults while watching a cloud build does not alter its session')
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
  assert(clients.postedComputers().every((p) => p.computerId === 'comp-live'), 'session messages name the resolved computer')
  assert((await clients.getMessages('sess-1', 'comp-live')).length > 0, 'a read naming the session computer works')
  let read404 = false
  try { await clients.getMessages('sess-1') } catch { read404 = true }
  assert(read404, 'a read without the computer id gets the API 404')

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
  assert(builds.length === 1 && builds[0].kind === 'local' && builds[0].title === 'Empty-state screen', 'listBuilds mirrors the home rows for the phone (the build name, not the raw goal)')
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
  assert(v.type === 'scene' && v.scene.status === 'Factory: building · watch only', 'the local watch card says watch only')
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
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.status === 'Service failed · Factory HTTP 400'), 'a refused message shows its code on a card')
  const posted = clients.postedComputers().find((p) => p.id === 'sess-remote')
  assert(posted?.computerId === 'comp-1', 'the message names the session computer')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running' && e.currentView.scene.status === 'Factory: building'), 'the refusal yields back to the watch; no permanent fault')
  assert(engine.steer('Try again') === true, 'the watch still takes messages after a refusal')
}

// The watch card's own controls (owner decisions, 0.2.17): Back leaves the
// watch, Talk is only offered where words can land, Explain says what the
// build is and what the owner can do, Pause on someone else's run asks
// first, and Restart never interrupts a build Spriite does not run.
{
  console.log('Watch card controls: Back, Talk, Explain, Pause, Restart')
  const clients = makeClients({
    cloudSessions: [
      {
        sessionId: 'sess-remote', title: 'Fix the login flake', status: 'running', updatedAt: 1000, computerId: 'comp-1',
        msgs: [{ id: 'm-r1', role: 'assistant', text: 'Fixing the login flake now.' }],
      },
      { sessionId: 'sess-local', title: 'Local app session', status: 'running', updatedAt: 900, msgs: [] },
    ],
    cloudAgents: [{ agentId: 'agent-w', name: 'Add the settings screen', status: 'ACTIVE', latestRunId: 'run-w', updatedAt: 800 }],
  })
  const interrupted = []
  clients.interrupt = async (id) => { interrupted.push(id) }
  const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1 }), clients })
  engine.boot()
  assert(await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.items.length === 4), 'watch controls: three cloud rows plus New build')
  const rowOf = (title) => engine.currentView.items.findIndex((i) => i.includes(title))
  const ids = () => engine.currentView.scene.actions.map((a) => a.id)

  // Steerable Factory watch: Explain, Talk, Back.
  engine.chooseList(rowOf('Fix the login flake'))
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.utterance.includes('Fixing the login flake now.')), 'steerable watch primes')
  assert(ids().join(',') === 'explain,send_message,back', 'an active steerable watch offers Explain, Send message, Back')

  // Explain says the source, title, latest reply, status, and the control boundary.
  engine.tick(61000)
  await new Promise((r) => setTimeout(r, 0)) // wait for a fresh status check, not old cached activity
  engine.handleAction('explain')
  let v = engine.currentView
  assert(v.type === 'scene' && v.scene.kind === 'explain', 'Explain opens its card')
  assert(v.scene.utterance.includes('Factory build') && v.scene.utterance.includes('Fix the login flake') && v.scene.utterance.includes('Fixing the login flake now.'), 'Explain names the source, title, and latest reply')
  assert(!v.scene.utterance.includes('I am watching a build from your account'), 'Explain is never the generic sentence')
  assert(v.scene.status.includes('building') && v.scene.status.includes('Talk sends to it') && /updated \d+[smhd] ago/.test(v.scene.status), 'Explain status names status, freshness, and that Talk sends to it')
  assert(validateScene(v.scene, 'engine').length === 0, 'the Explain card validates')
  engine.handleAction('back')
  assert(engine.currentView.type === 'scene' && engine.currentView.scene.kind === 'running', 'Explain Back returns to the watch card')

  // Pause on a watched build asks first; Back cancels; Confirm interrupts once.
  assert(engine.canPause() === true, 'a steerable watch can be paused (with confirmation)')
  engine.pauseToggle()
  v = engine.currentView
  assert(v.type === 'scene' && v.scene.utterance.includes('current turn') && v.scene.actions.some((a) => a.id === 'confirm_watch_pause'), 'Pause on a watch shows a confirmation first')
  assert(interrupted.length === 0, 'nothing is interrupted before Confirm')
  engine.handleAction('back')
  assert(engine.currentView.type === 'scene' && engine.currentView.scene.kind === 'running' && interrupted.length === 0, 'Cancel leaves the watched build untouched')
  engine.pauseToggle()
  engine.handleAction('confirm_watch_pause')
  await new Promise((r) => setTimeout(r, 0))
  assert(interrupted.length === 1 && interrupted[0] === 'sess-remote', 'Confirm interrupts the watched session once')
  assert(engine.currentView.type === 'scene' && engine.currentView.scene.utterance.includes('stop this build'), 'the interrupt is confirmed on a card')
  assert(engine.canResume() === false, 'Resume never acts on a watched build')

  // Restart while watching never interrupts the watched session.
  engine.handleAction('back') // clear the confirmation card
  assert(engine.watching() === true, 'the engine reports the watch')
  engine.reset()
  assert(interrupted.length === 1, 'Restart while watching interrupts nothing')
  assert(await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.purpose === 'projects'), 'Restart from a watch lands home')

  // The on-card Back leaves the watch (same as the double-tap).
  engine.chooseList(rowOf('Fix the login flake'))
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running'), 'watch reopens')
  engine.handleAction('back')
  assert(engine.currentView.type === 'selection' && engine.currentView.purpose === 'projects', 'the on-card Back leaves the watch for the home')
  assert(engine.watching() === false, 'nothing is watched after Back')

  // Watch-only Factory session: no Talk, no Pause, Explain says watch only.
  assert(await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.items.length === 4), 'home rows back')
  engine.chooseList(rowOf('Local app session'))
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running'), 'local watch opens')
  assert(ids().join(',') === 'open_factory,explain,back', 'a watch-only Factory chat offers an honest Factory handoff, not ineffective messaging')
  assert(engine.watchOnly() === true, 'the engine reports a watch-only build')
  assert(engine.canPause() === false, 'a watch-only build cannot be paused')
  engine.handleAction('explain')
  v = engine.currentView
  assert(v.scene.utterance.includes('No replies yet.') && v.scene.status.includes('watch only'), 'Explain on a reply-less watch-only build says so')
  engine.back()
  engine.back()

  // Cursor watch: no Talk, no Pause.
  assert(await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.items.length === 4), 'home rows back again')
  engine.chooseList(rowOf('Add the settings screen'))
  assert(ids().join(',') === 'explain,back' && engine.canPause() === false && engine.watchOnly() === true, 'a Cursor watch is watch-only with no Pause')
  engine.handleAction('explain')
  assert(engine.currentView.scene.utterance.includes('Cursor build'), 'Explain names Cursor as the source')
}

{
  console.log('Switching builds: a row opens from the watch, the transcript, and the goal list')
  const clients = makeClients({
    cloudSessions: [
      {
        sessionId: 'sess-remote', title: 'Fix the login flake', status: 'running', updatedAt: 1000, computerId: 'comp-1',
        msgs: [{ id: 'm-r1', role: 'assistant', text: 'Fixing the login flake now.' }],
      },
      { sessionId: 'sess-local', title: 'Local app session', status: 'running', updatedAt: 900, msgs: [] },
    ],
    cloudAgents: [{ agentId: 'agent-w', name: 'Add the settings screen', status: 'ACTIVE', latestRunId: 'run-w', updatedAt: 800 }],
  })
  const interrupted = []
  clients.interrupt = async (id) => { interrupted.push(id) }
  const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1 }), clients })
  engine.boot()
  assert(await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.items.length === 4), 'switching: three cloud rows on the home')
  const rowOf = (title) => engine.listBuilds().findIndex((b) => b.title.includes(title))
  const watchingTitle = (title) => engine.watching() && engine.snapshot().attach?.title.includes(title)

  // Watch -> another watch, no Back first. The first build is not touched.
  engine.chooseList(rowOf('Fix the login flake'))
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running'), 'switching: steerable watch opens')
  assert(engine.canOpenBuilds() === true, 'a steerable watch never blocks opening another build')
  assert(engine.openBuild(rowOf('Local app session')) === true, 'openBuild from a steerable watch opens the other row')
  assert(watchingTitle('Local app session'), 'the second build is now watched')
  assert(interrupted.length === 0, 'switching away from a watch interrupts nothing')

  // Watch with Explain open -> a Cursor row.
  engine.handleAction('explain')
  assert(engine.canOpenBuilds() === true && engine.openBuild(rowOf('Add the settings screen')) === true, 'openBuild works over the Explain card')
  assert(watchingTitle('Add the settings screen') && engine.currentView.scene.kind !== 'explain', 'the Cursor build shows, not the old Explain')

  // Transcript card (a held goal) -> a watch.
  engine.voiceGoal('Deliver the empty-state screen', 4)
  assert(engine.snapshot().phase === 'transcript', 'a spoken goal sits on the transcript card')
  assert(engine.canOpenBuilds() === true && engine.openBuild(rowOf('Fix the login flake')) === true, 'openBuild works from the transcript card')
  assert(watchingTitle('Fix the login flake'), 'the transcript card gave way to the watch')
  engine.back()
  assert(engine.currentView.type === 'selection' && engine.currentView.purpose === 'projects', 'Back from that watch lands home')
  assert(engine.acceptsGoal() && engine.snapshot().goal === '', 'the abandoned goal does not linger behind the home')

  // Goal list -> a watch.
  engine.chooseList(engine.listBuilds().length)
  assert(engine.snapshot().phase === 'goal', 'the goal list is open')
  assert(engine.openBuild(rowOf('Local app session')) === true && watchingTitle('Local app session'), 'openBuild works from the goal list')

  // Out-of-range rows open nothing and say false.
  assert(engine.openBuild(99) === false && watchingTitle('Local app session'), 'a stale index opens nothing')
}

// A watched cloud build shows the row's own title until a reply lands, and a
// provider title is owner-uncontrolled text: one with a percentage (or a
// mission goal the projects row carried) must be fitted like every other
// provider-derived utterance, or the watch card fails validation and is
// swallowed by the G39 fallback while the build keeps watching in the dark.
{
  console.log('Watch cards: a provider title with a percentage still validates')
  const clients = makeClients({
    cloudSessions: [
      {
        sessionId: 'sess-pct',
        title: 'Cut login flakiness 50%',
        status: 'running',
        updatedAt: 60,
        computerId: 'comp-1',
        msgs: [],
      },
    ],
  })
  const engine = new RealOrchestrator(record([]), {
    ...deps({ repoUrl: REPO, workerPref: 'factory', jobs: 1 }),
    clients,
  })
  engine.boot()
  assert(
    await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.items.some((r) => r.includes('50 percent'))),
    'the home row lists the sanitized session title',
  )
  const rows = engine.currentView.items
  engine.chooseList(rows.findIndex((r) => r.includes('50 percent')))
  assert(
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.utterance.includes('50 percent')),
    'the watch card shows the sanitized title',
  )
  const watch = engine.currentView
  assert(
    watch.type === 'scene' && watch.scene.utterance === 'Cut login flakiness 50 percent' && validateScene(watch.scene, 'engine').length === 0,
    'a watch card with a percentage title passes validation: the watch never runs dark',
  )
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
  const leadMsgs = await clients.getMessages('sess-1', 'comp-1')
  assert(leadMsgs.some((m) => m.text.includes('Repository the worker builds on: https://github.com/example/build-a-landing-page-for-acme')), 'the plan request names the new repository')

  // The mission repo is frozen: a mid-mission repo save never moves the run.
  engine.handleAction('begin')
  engine.handleAction('use_it')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running'), 'the new-repo mission builds')
  engine.configure({ repoUrl: REPO }) // a panel save picks a different repo
  const snap = JSON.parse(JSON.stringify(engine.snapshot()))
  assert(snap.missionRepo === 'https://github.com/example/build-a-landing-page-for-acme', 'the snapshot carries the mission repository')
  assert(snap.missionComputerId === 'comp-1', 'the snapshot carries the mission computer')
  const events2 = []
  const engine2 = new RealOrchestrator(record(events2), {
    ...deps({ repoUrl: REPO, workerPref: 'factory', jobs: 1, askBeforePr: false }),
    clients,
  })
  engine2.restore(snap)
  assert(engine2.snapshot().missionRepo === 'https://github.com/example/build-a-landing-page-for-acme', 'restore keeps the frozen mission repository')
  assert(engine2.snapshot().missionComputerId === 'comp-1', 'restore keeps the mission computer')
  assert(await drive(engine2, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final'), 'the restored mission finishes')
  const msgs = await clients.getMessages('sess-1', 'comp-1')
  assert(msgs.some((m) => m.text.includes('on https://github.com/example/build-a-landing-page-for-acme.')), 'the verdict request still names the mission repository')

  // A finished session remains in the snapshot for its history, but a new
  // phone goal replaces that terminal mission instead of steering into it.
  const finishedSnapshot = JSON.parse(JSON.stringify(engine2.snapshot()))
  const oldSessionMessageCount = (await clients.getMessages('sess-1', 'comp-1')).length
  const finishedSessionCount = clients.leadSessionCount()
  const freshGoal = new RealOrchestrator(record([]), {
    ...deps({ repoUrl: REPO, workerPref: 'factory', jobs: 1, askBeforePr: false }),
    clients,
  })
  freshGoal.restore(finishedSnapshot)
  assert(freshGoal.acceptsGoal(), 'the finished mission accepts a fresh goal')
  assert(freshGoal.say('Build a fresh help page') === 'goal', 'a typed goal replaces the finished mission')
  assert(
    await drive(freshGoal, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')),
    'the fresh goal plans in a newly created session',
  )
  assert(
    clients.leadSessionCount() === finishedSessionCount + 1,
    'the new goal created a session instead of reusing the finished one',
  )
  assert(
    (await clients.getMessages('sess-1', 'comp-1')).length === oldSessionMessageCount,
    'the fresh goal never posts into the finished session',
  )

  // The New repo variant has the same rule: it clears the finished session
  // and creates a separate private repository before planning.
  const freshRepo = new RealOrchestrator(record([]), {
    ...deps({ repoUrl: REPO, githubToken: 'gh-test', workerPref: 'factory', jobs: 1, askBeforePr: false }),
    clients,
  })
  freshRepo.restore(finishedSnapshot)
  assert(freshRepo.sayNewRepo('Build a private support site', 'private-support') === 'goal',
    'New repo replaces a finished session instead of steering')
  assert(
    await drive(freshRepo, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')),
    'the new-repo goal plans after the repository is created',
  )
  assert(
    clients.repoCreated().some((r) => r.name === 'private-support') &&
      clients.leadSessionCount() === finishedSessionCount + 2,
    'New repo uses its own repository and a new lead session',
  )
  assert(
    (await clients.getMessages('sess-1', 'comp-1')).length === oldSessionMessageCount,
    'New repo never posts into the finished session',
  )

  // Older snapshots (no missionRepo field) fall back to their saved repo.
  const legacy = JSON.parse(JSON.stringify(snap))
  delete legacy.missionRepo
  delete legacy.missionComputerId
  const engine3 = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients: makeClients() })
  engine3.restore(legacy)
  assert(engine3.snapshot().missionRepo === REPO, 'a legacy snapshot restores its repository from the old field')
  assert(engine3.snapshot().missionComputerId === null, 'a legacy snapshot restores without a resolved computer')
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
  // Every New repo tap changes the card (owner decision, 0.2.17): the
  // creating card holds for as long as the create is pending, a second tap
  // says it is still creating, and a tap that cannot run says why.
  console.log('New-repo taps: never a silent no-op')
  const clients = makeClients()
  let release = null
  const createRepo = clients.createRepo
  clients.createRepo = (name, isPrivate) =>
    new Promise((resolve, reject) => {
      release = () => createRepo(name, isPrivate).then(resolve, reject)
    })
  const engine = new RealOrchestrator(record([]), {
    ...deps({ repoUrl: '', githubToken: 'gh-test', workerPref: 'factory', jobs: 1 }),
    clients,
  })
  engine.boot()
  engine.handleAction('new_repo')
  let v = engine.currentView
  assert(v.type === 'scene' && v.scene.utterance.includes('Say what to build first'), 'New repo with no goal says to say the goal first')
  engine.handleAction('back')
  engine.voiceGoal('Build a recipe box', 10)
  engine.handleAction('new_repo')
  v = engine.currentView
  assert(v.type === 'scene' && v.scene.utterance.includes('Creating a new repository'), 'New repo shows the creating card at once')
  for (let t = 0; t <= 40000; t += 500) engine.tick(t)
  await new Promise((r) => setTimeout(r, 0))
  v = engine.currentView
  assert(v.type === 'scene' && v.scene.utterance.includes('Creating a new repository'), 'the creating card holds past 20 seconds while the create is pending')
  assert(!v.scene.actions.some((a) => a.id === 'new_repo'), 'the creating card offers no second New repo')
  engine.handleAction('new_repo') // a stale tap (the phone, or a mirrored card)
  v = engine.currentView
  assert(v.type === 'scene' && v.scene.utterance.includes('Still creating build-a-recipe-box'), 'a tap while creating says it is still creating')
  assert(clients.repoCreated().length === 0, 'the second tap started no second create')
  release()
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'the mission plans once the create lands')
  assert(clients.repoCreated().length === 1, 'exactly one repository was created')
  engine.handleAction('new_repo')
  v = engine.currentView
  assert(v.type === 'scene' && v.scene.utterance.includes('already has its repository'), 'New repo on a live build says it already has its repository')
  assert(clients.repoCreated().length === 1, 'no repository is created for a live build')
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
  assert(v.scene.status === 'Computer offline · check Factory app', 'the status line points at the machine, not a code')
  assert(v.scene.spritePose === 'offline', 'a dropped computer link draws Offline (MotionLab), not Blocked')
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
  const clients = makeClients({ planChatter: true })
  const engine = new RealOrchestrator(record([]), {
    ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }),
    clients,
  })
  engine.boot()
  engine.say('Deliver the empty-state screen')
  // A sent request is not proof that Factory is running.
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.status.includes('Activity unconfirmed')), 'the pending plan does not claim unconfirmed activity')
  let dv = engine.currentView
  assert(dv.type === 'scene' && dv.scene.actions.some((a) => a.id === 'status'), 'the drafting card offers a Status action')
  engine.handleAction('status')
  let stv = engine.currentView
  assert(stv.type === 'scene' && stv.scene.kind === 'status_answer' && stv.scene.status.includes('Activity unconfirmed'), 'the Status action uses the same current evidence')
  // Chatter back first: shown on a card, never mistaken for the plan.
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.status.includes('Lead replied') && e.currentView.scene.speaker === 'lead' && e.currentView.scene.utterance.includes('look at the repository')), 'chatter during planning comes back on a card labeled as the lead')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && /Session idle|Activity unconfirmed/.test(e.currentView.scene.status)), 'chatter never completes the plan or proves current activity')
  // A steer during drafting confirms on the glasses it reached the session.
  await new Promise((r) => setTimeout(r, 0)) // the session create and plan post settle
  assert(engine.steer('Keep the plan small') === true, 'a steer during drafting is taken')
  await new Promise((r) => setTimeout(r, 0)) // the post resolves, then the card
  let scv = engine.currentView
  assert(scv.type === 'scene' && scv.scene.kind === 'status_answer' && scv.scene.utterance.includes('Keep the plan small') && scv.scene.status.includes('Sent to Factory'), 'the steer confirms on the glasses')
  // The numbered plan (a re-request) still completes it.
  assert(engine.steer('Reply with a milestone plan') === true, 'a follow-up steer re-requests the plan')
  await new Promise((r) => setTimeout(r, 0))
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'the mission plans')
  engine.handleAction('begin')
  engine.handleAction('use_it')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running'), 'the mission builds')
  engine.voiceGoal('Also add a dark mode toggle', 6)
  await new Promise((r) => setTimeout(r, 0)) // the steer posts, then confirms
  let msv = engine.currentView
  assert(msv.type === 'scene' && msv.scene.kind === 'status_answer' && msv.scene.utterance.includes('Also add a dark mode toggle') && msv.scene.status.includes('Sent to Factory'), 'a spoken mid-mission goal confirms on the glasses')
  const msgs = await clients.getMessages('sess-1', 'comp-1')
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
  console.log('Lead questions: asked on the glasses, answered by voice')
  const clients = makeClients({ planQuestion: 'Should the empty state cover the retry path too?' })
  const engine = new RealOrchestrator(record([]), {
    ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }),
    clients,
  })
  engine.boot()
  engine.say('Deliver the empty-state screen')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'decision' && e.currentView.scene.utterance.includes('retry path too?')), 'a lead question during planning becomes a decision card')
  const qv = engine.currentView
  assert(qv.type === 'scene' && qv.scene.actions.some((a) => a.id === 'use_it' && a.label === 'Confirm') && qv.scene.actions.some((a) => a.id === 'talk'), 'the question card offers Confirm and Talk')
  assert(engine.steer('Yes, cover the retry path too') === true, 'the spoken answer steers the lead')
  await new Promise((r) => setTimeout(r, 0)) // the post resolves, then the card
  const av = engine.currentView
  assert(av.type === 'scene' && av.scene.utterance.includes('Yes, cover the retry path too') && av.scene.status.includes('Sent to Factory'), 'the answer confirms on the glasses')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')), 'the plan lands after the answer')
  engine.handleAction('begin')
  engine.handleAction('use_it')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running'), 'the mission builds after the Q&A')
}

{
  console.log('Mid-build questions render the chat-style option list')
  const clients = makeClients({ steerQuestion: 'Which database should I use, Postgres or SQLite?' })
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
  engine.say('Store the notes in a database') // a typed steer asks about the database
  assert(
    await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.purpose === 'decision'),
    'a question with alternatives becomes the option list',
  )
  const qv = engine.currentView
  assert(
    qv.type === 'selection' && qv.items.length === 3 && qv.items[0] === 'Postgres' && qv.items[1] === 'SQLite',
    'the alternatives are the rows',
  )
  assert(qv.type === 'selection' && qv.items[2] === 'Say something else', 'the last row opens Talk for any answer (HudAsk: Say something else)')
  assert(qv.type === 'selection' && qv.title.includes('database'), 'the question rides the list title')
  // An option tap answers: the choice is posted to the lead at once.
  assert(engine.chooseDecisionList(1) === 'done', 'an option tap answers the question')
  await new Promise((r) => setTimeout(r, 0)) // the answer post resolves, then the card
  const answered = await clients.getMessages('sess-1', 'comp-1')
  assert(answered.some((m) => m.role === 'user' && m.text === 'The owner chose: SQLite'), 'the chosen option is posted to the lead')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final'), 'the mission finishes after the choice')
  // The session chat log carries the whole exchange: the owner's choice and
  // the lead's question both appear, so History can re-read them later.
  const log = engine.chatLog()
  // The chat shows the owner's own words, not the answer envelope.
  assert(log.some((e) => e.who === 'you' && e.text === 'SQLite'), "the chat log carries the owner's choice")
  assert(log.some((e) => e.who === 'lead' && /database/i.test(e.text)), "the chat log carries the lead's question, labeled as the lead")
}

{
  console.log('Speak-another-answer opens Talk without posting')
  const clients = makeClients({ steerQuestion: 'Which database should I use, Postgres or SQLite?' })
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
  engine.say('Store the notes in a database')
  assert(
    await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.purpose === 'decision'),
    'the option list is up',
  )
  assert(engine.chooseDecisionList(2) === 'talk', 'the speak row reports Talk (main.ts opens the capture)')
  const posted = await clients.getMessages('sess-1', 'comp-1')
  assert(!posted.some((m) => m.role === 'user' && m.text.startsWith('The owner chose')), 'the speak row posts nothing by itself')
  // The spoken alternative then steers the lead like any mid-mission answer:
  // the steer confirms on the glasses (transient), then the build continues
  // to its finish — the question never stalls it.
  assert(engine.steer('Use SQLite everywhere') === true, 'the spoken alternative steers the lead')
  await new Promise((r) => setTimeout(r, 0))
  assert(
    await drive(
      engine,
      (e) => e.currentView.type === 'scene' && (e.currentView.scene.kind === 'running' || e.currentView.scene.kind === 'final'),
    ),
    'the build continues after the spoken answer',
  )
}

{
  console.log('DECISION + OPTIONS protocol parses, persists, and restores')
  const clients = makeClients({
    planQuestion: 'DECISION: Which database?\nOPTIONS: Postgres | SQLite | Skip storage',
  })
  const engine = new RealOrchestrator(record([]), {
    ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }),
    clients,
  })
  engine.boot()
  engine.say('Deliver the empty-state screen')
  assert(
    await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.purpose === 'decision'),
    'a DECISION + OPTIONS reply becomes the option list',
  )
  const qv = engine.currentView
  assert(
    qv.type === 'selection' &&
      qv.items.length === 4 &&
      qv.items[0] === 'Postgres' &&
      qv.items[1] === 'SQLite' &&
      qv.items[2] === 'Skip storage',
    'the protocol options are the rows',
  )
  assert(qv.type === 'selection' && qv.title.includes('Which database?'), 'the DECISION question is the list title')
  // A snapshot taken mid-question restores onto a fresh engine with the list.
  const snap = engine.snapshot()
  assert(Array.isArray(snap.decisionOptions) && snap.decisionOptions.length === 3, 'the snapshot carries the options')
  const restored = new RealOrchestrator(record([]), {
    ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }),
    clients,
  })
  restored.restore(snap)
  const rv = restored.currentView
  assert(
    rv.type === 'selection' && rv.purpose === 'decision' && rv.items.length === 4 && rv.items[3] === 'Say something else',
    'a restored snapshot shows the option list again',
  )
  // Answer by row: the plan lands after the answer (the re-request replays).
  assert(engine.chooseDecisionList(0) === 'done', 'an option tap answers during planning')
  await new Promise((r) => setTimeout(r, 0))
  const msgs = await clients.getMessages('sess-1', 'comp-1')
  assert(msgs.some((m) => m.role === 'user' && m.text.split('\n')[0] === 'The owner chose: Postgres'), 'the choice reaches the lead')
  // Answered while planning: the same post asks the Lead for the complete
  // plan again, so Start build returns with a plan instead of waiting on one.
  assert(msgs.some((m) => m.role === 'user' && m.text.startsWith('The owner chose: Postgres\n') && m.text.endsWith('then a final line exactly PLAN_READY.')),
    'a planning answer asks the Lead for the complete plan again')
  assert(
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')),
    'the plan lands after the answer',
  )
}

{
  console.log('Question options preserve numeric labels')
  const clients = makeClients({
    planQuestion: 'DECISION: How long should the build wait?\nOPTIONS: 30 seconds | 1 minute | 2.5 GB | - Defer',
  })
  const engine = new RealOrchestrator(record([]), {
    ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }),
    clients,
  })
  engine.boot()
  engine.say('Deliver the empty-state screen')
  assert(
    await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.purpose === 'decision'),
    'the numeric options are shown',
  )
  const view = engine.currentView
  assert(
    view.type === 'selection' &&
      view.items[0] === '30 seconds' &&
      view.items[1] === '1 minute' &&
      view.items[2] === '2.5 GB' &&
      view.items[3] === 'Defer',
    'option parsing strips list markers without deleting digits from labels',
  )
}

{
  console.log('Declining the start gate ends the mission; a new goal starts fresh')
  const clients = makeClients({})
  const engine = new RealOrchestrator(record([]), {
    ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: true }),
    clients,
  })
  engine.boot()
  engine.say('Deliver the empty-state screen')
  assert(
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')),
    'the mission plans',
  )
  engine.handleAction('begin')
  assert(
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'decision' && e.currentView.scene.utterance.includes('Start the build?')),
    'the start gate arms before spending credits',
  )
  const went = engine.say('no')
  const after = engine.snapshot()
  assert(went === 'decision', 'the typed decline is taken as the gate answer')
  assert(
    after.decisionPending === false && after.sessionId === null && after.goal === '' && after.phase === 'meet',
    'the refusal ends the mission: no session held, nothing parked at the plan',
  )
  let v = engine.currentView
  assert(
    v.type === 'scene' && v.scene.kind === 'status_answer' && v.scene.utterance.includes('You declined the build'),
    'the refusal shows a visible decline card (the honest state, never silence)',
  )
  assert(v.type === 'scene' && v.scene.status.includes('Declined'), 'the decline card status says nothing started')
  assert(engine.acceptsGoal() === true, 'after the refusal the engine takes fresh goals again')
  // The new spoken goal (routeVoice -> voiceGoal): the transcript card, never
  // a silent steer into the dead lead session.
  engine.voiceGoal('Build a landing page for Acme', 8)
  v = engine.currentView
  assert(
    v.type === 'scene' && v.scene.kind === 'transcript' && v.scene.utterance.includes('landing page'),
    'a new spoken goal lands on the transcript card, not behind the decline note',
  )
  const sess1 = await clients.getMessages('sess-1', 'comp-1')
  assert(
    !sess1.some((m) => m.role === 'user' && /landing page/.test(m.text)),
    'the new goal never steers the dead lead session',
  )
  // The new typed goal pushes a fresh session to the cloud.
  const leadBefore = clients.leadSessionCount()
  engine.say('Ship the settings page')
  assert(
    await drive(engine, (e) => clients.leadSessionCount() === leadBefore + 1),
    'a new goal after the refusal pushes a new session to the cloud',
  )
  assert(
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan'),
    'the fresh goal plans on its own session',
  )
}

{
  console.log('Declining the PR gate ends the mission the same way')
  const clients = makeClients({})
  const engine = new RealOrchestrator(record([]), {
    ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: true }),
    clients,
  })
  engine.boot()
  engine.say('Deliver the empty-state screen')
  assert(
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')),
    'the mission plans',
  )
  engine.handleAction('begin')
  engine.handleAction('use_it')
  assert(
    await drive(engine, (e) => e.hasPendingDecision && e.currentView.type === 'scene' && e.currentView.scene.kind === 'decision' && e.currentView.scene.utterance.includes('Open the pull request?')),
    'the PR gate arms before opening',
  )
  const went = engine.say('not yet')
  const after = engine.snapshot()
  assert(went === 'decision', 'the PR refusal is taken as the gate answer')
  assert(
    after.decisionPending === false && after.sessionId === null && after.phase === 'meet',
    'the PR refusal ends the mission instead of parking it at the PR stage',
  )
  let v = engine.currentView
  assert(
    v.type === 'scene' && v.scene.kind === 'status_answer' && v.scene.utterance.includes('You declined the pull request'),
    'the PR refusal shows its own decline card',
  )
  assert(engine.acceptsGoal() === true, 'a new goal after the PR refusal starts fresh')
}

{
  console.log('Spoken words at a pending question answer it — never a silent steer past it')
  const clients = makeClients({})
  const engine = new RealOrchestrator(record([]), {
    ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: true }),
    clients,
  })
  engine.boot()
  engine.say('Deliver the empty-state screen')
  assert(
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')),
    'the mission plans',
  )
  engine.handleAction('begin')
  assert(
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'decision'),
    'the start gate arms',
  )
  // main.ts routeVoice: a pending decision owns free speech (engine.say), so
  // the spoken words answer or refuse the gate; a steer past it would wipe
  // the question silently while its card never moved.
  assert(engine.hasPendingDecision === true, 'the gate holds the turn')
  const where = engine.say('no') // the spoken refusal, as routeVoice routes it
  assert(where === 'decision' && engine.snapshot().decisionPending === false, 'the spoken refusal ends the gate honestly')
  const sess1 = await clients.getMessages('sess-1', 'comp-1')
  assert(
    !sess1.some((m) => m.role === 'user' && (m.text === 'no' || m.text === 'No')),
    'the spoken refusal never posts to the lead as a stray message',
  )
  // A spoken answer at a NON-gate question reaches the lead as the answer
  // (the question is answered, not swallowed by a steer).
  const qc = makeClients({ planQuestion: 'DECISION: Which database?\nOPTIONS: Postgres | SQLite' })
  const qe = new RealOrchestrator(record([]), {
    ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }),
    clients: qc,
  })
  qe.boot()
  qe.say('Deliver the empty-state screen')
  assert(
    await drive(qe, (e) => e.currentView.type === 'selection' && e.currentView.purpose === 'decision'),
    'the mid-plan question renders the option list',
  )
  assert(qe.hasPendingDecision === true, 'the question holds the turn')
  const answered = qe.say('Use SQLite either way')
  assert(answered === 'decision', 'the spoken words answer the question')
  await new Promise((r) => setTimeout(r, 0)) // fresh receipt baseline precedes dispatch
  const qmsgs = await qc.getMessages('sess-1', 'comp-1')
  assert(
    qmsgs.some((m) => m.role === 'user' && m.text.split('\n')[0] === 'Use SQLite either way'),
    'the spoken answer reaches the lead as the answer',
  )
  assert(
    await drive(qe, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')),
    'the plan lands after the spoken answer',
  )
}


{
  console.log('Session settings: lead and worker bodies, frozen for the build')
  const clients = makeClients()
  const engine = new RealOrchestrator(record([]), {
    ...deps({
      workerPref: 'factory',
      jobs: 1,
      askBeforePr: false,
      missionId: 'mission-settings-1',
      settings: {
        interactionMode: 'spec',
        specModeModel: 'claude-opus-4-5',
        specModeReasoningEffort: 'xhigh',
        leadModel: 'claude-opus-4-5',
        leadReasoningEffort: 'high',
        leadAutonomyLevel: 'medium',
        workerModel: 'claude-sonnet-4-5',
        workerReasoningEffort: 'low',
        workerInstructions: 'Follow the repo conventions.',
        workerEnabledToolIds: ['Read', 'ApplyPatch'],
        workerDisabledToolIds: ['Execute'],
      },
    }),
    clients,
  })
  engine.boot()
  engine.say('Deliver the empty-state screen')
  assert(
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')),
    'the mission plans',
  )
  const created = clients.createdSettings()
  assert(
    created.length === 1 &&
      created[0].model === 'claude-opus-4-5' &&
      created[0].reasoningEffort === 'high' &&
      created[0].autonomyLevel === 'medium' &&
      created[0].interactionMode === 'spec' &&
      created[0].specModeModel === 'claude-opus-4-5' &&
      created[0].specModeReasoningEffort === 'xhigh',
    'the lead session is created with the lead settings and the chosen mode',
  )
  assert(created[0].systemPrompt === undefined, 'the lead keeps Factory\'s own prompt: the HUD reads its replies')
  engine.handleAction('begin')
  engine.handleAction('use_it')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running'), 'the mission builds')
  const worker = clients.createdSettings()[1]
  assert(
    clients.createdSettings().length === 2 &&
      worker.model === 'claude-sonnet-4-5' &&
      worker.reasoningEffort === 'low' &&
      worker.systemPrompt.type === 'preset' &&
      worker.systemPrompt.preset === 'droid' &&
      worker.systemPrompt.append === 'Follow the repo conventions.' &&
      worker.enabledToolIds.join(',') === 'Read,ApplyPatch' &&
      worker.disabledToolIds.join(',') === 'Execute',
    'the worker session gets its own model, the appended instructions and the tool policy',
  )
  assert(
    worker.tags.length === 1 && worker.tags[0].name === 'spriite' && worker.tags[0].metadata.missionId === 'mission-settings-1',
    'the worker session is tagged with the mission it belongs to',
  )
  // A phone save mid-build: the engine never PATCHes a live session, and the
  // settings it was started with stand (the API cannot carry the instructions
  // or the tool policy anyway, and Factory never reports settings back).
  engine.configure({ settings: { leadModel: 'claude-sonnet-4-5' } })
  await new Promise((r) => setTimeout(r, 0))
  assert(clients.updatedSettings().length === 0, 'a save mid-build PATCHes nothing: the build keeps its settings')
  assert(clients.createdSettings().length === 2, 'a settings change creates no new session')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final'), 'the mission still finishes')
}

{
  console.log('Session settings: account defaults stay clean')
  const clients = makeClients()
  const engine = new RealOrchestrator(record([]), {
    ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }),
    clients,
  })
  engine.boot()
  engine.say('Deliver the empty-state screen')
  assert(
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')),
    'the mission plans',
  )
  assert(
    clients.createdSettings().length === 1 && Object.keys(clients.createdSettings()[0]).length === 0,
    'default prefs create the lead session with no settings block at all',
  )
  engine.handleAction('begin')
  engine.handleAction('use_it')
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running'), 'the mission builds')
  const worker = clients.createdSettings()[1]
  assert(
    Object.keys(worker).length === 2 && worker.interactionMode === 'auto' && worker.tags[0].name === 'spriite',
    'the approved worker carries auto mode and its build tag, without escalating autonomy',
  )
  engine.configure({ settings: { leadModel: 'claude-sonnet-4-5' } }) // a save mid-build
  await new Promise((r) => setTimeout(r, 0))
  assert(clients.updatedSettings().length === 0, 'a settings save mid-build reaches no live session')
  assert(clients.createdSettings().length === 2, 'and creates none either')
}

{
  console.log('Voice: the autonomy command is gone')
  assert(parseUtterance('Hey Spriite, set autonomy to full').command === null, '"set autonomy to full" is free text now')
  assert(parseUtterance('Spriite, full autonomy').command === null, '"full autonomy" is free text now')
  assert(matchCommand('autonomy high') === null, '"autonomy high" matches nothing')
  assert(matchCommand('high autonomy') === null, '"high autonomy" matches nothing')
  assert(matchCommand('max autonomy') === null, '"max autonomy" matches nothing')
  assert(matchCommand('set autonomy to ask every step') === null, '"set autonomy to ask every step" matches nothing')
  assert(matchCommand('turn the autonomy level to medium') === null, '"turn the autonomy level to medium" matches nothing')
  assert(matchCommand('Spriite, ask me first') === null, '"ask me first" alone stays free text')
  assert(matchCommand('high') === null, 'a bare level word stays free text')
  assert(matchCommand('add an autonomy settings screen') === null, 'a goal mentioning autonomy stays free text')
  assert(matchCommand('build me a website') === null, 'a goal parses no command')
  assert(parseUtterance('Hey Spriite, pause the build').command === 'pause', 'the other voice commands still parse')
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

// ------------- glasses list: refreshed rows reach the HUD, unchanged rows do not

{
  const { Renderer } = await import('../src/render/renderer.ts')
  const sent = { create: 0, rebuild: 0, text: 0, textContents: [] }
  const bridge = {
    createStartUpPageContainer: async () => { sent.create += 1; return 0 },
    rebuildPageContainer: async () => { sent.rebuild += 1; return true },
    textContainerUpgrade: async (payload) => {
      sent.text += 1
      sent.textContents.push({ containerID: payload.containerID, content: payload.content })
      return true
    },
    updateImageRawData: async () => 0,
  }
  const renderer = new Renderer({ call: async (op) => op(bridge) })
  renderer.setReduceMotion(true)
  const home = (title, items) => ({ type: 'selection', purpose: 'projects', contextLabel: 'SPRIITE', title, items, pose: 'idle' })
  await renderer.present(home('Projects', ['Fix the login flake | Factory: building', 'New build']), 0)
  assert(sent.create === 1 && sent.rebuild === 0, 'the first home list creates the page')
  await renderer.present(home('Projects', ['Fix the login flake | Factory: building', 'New build']), 0)
  assert(sent.rebuild === 0, 'an unchanged home list is not re-sent (the highlight stays put)')
  await renderer.present(home('Projects | as of 2m ago', ['Fix the login flake | Factory: building', 'New build']), 0)
  assert(sent.rebuild === 0 && sent.text === 1, 'a title-only change upgrades the text in place')
  const fresh = ['Fix the login flake | Factory: idle', 'New build']
  await renderer.present(home('Projects', fresh), 0)
  assert(
    sent.rebuild === 0 && sent.textContents.some((t) => t.containerID === 7 && t.content.includes('idle')),
    'changed rows upgrade the rows text in place (no page re-send, no flicker)',
  )
  assert(JSON.stringify(renderer.shownListItems()) === JSON.stringify(fresh), 'the renderer reports the rows the glasses now show')
  // One ring tick, one row: the cursor move is an in-place text upgrade.
  sent.textContents.length = 0
  await renderer.updateSelectionRows(fresh, 1)
  assert(
    sent.textContents.some((t) => t.containerID === 7 && t.content.trim() === 'New build') &&
      sent.textContents.some((t) => t.containerID === 12 && t.content.includes('Fix the login flake')),
    'a row cursor move turns the focused row into the bordered slot in place (HudAsk carousel)',
  )
  const plan = {
    schemaVersion: 1, sceneId: 'plan-1', sceneRevision: 1, missionId: 'mission-1',
    stateSequence: 1, kind: 'plan', spritePose: 'idle', contextLabel: 'SPRIITE',
    utterance: 'The plan is ready.', status: '', progress: null, actions: [],
    evidenceIds: [], generatedAt: new Date().toISOString(), transientMs: 0,
  }
  await renderer.present({ type: 'scene', scene: plan }, 0)
  sent.textContents.length = 0
  await renderer.present({
    type: 'selection', purpose: 'decision', contextLabel: 'SPRIITE',
    title: 'Which database should the build use for local state?',
    items: ['Postgres', 'SQLite', 'No storage', 'Say something else'],
    pose: 'asking',
  }, 0)
  assert(
    sent.textContents.some((t) => t.containerID === 2 && t.content === 'Which database should the build use for local state?'),
    'a rebuilt selection upgrades the reused title container with the new question',
  )
  assert(
    JSON.stringify(renderer.shownSelection()) === JSON.stringify({
      title: 'Which database should the build use for local state?',
      items: ['Postgres', 'SQLite', 'No storage', 'Say something else'],
    }),
    'the renderer exposes the exact selection page currently shown',
  )
  renderer.stop()
}

// -------- acknowledgment loss: hold, then reconcile the original turn only
{
  console.log('Acknowledgment recovery: plan, worker, and verdict turns are held and reconciled without replay')

  // The plan request loses its acknowledgment. A delayed provider user turn
  // resolves the hold; absent evidence and time alone never authorize replay.
  {
    const clients = makeClients({ blipPosts: [1] })
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Add the empty-state screen', 5)
    engine.handleAction('start_planning')
    assert(engine.snapshot().faultKind === null, 'a blip on the plan request is not a fault')
    assert(engine.snapshot().planLabels.length === 0, 'an unknown request does not fabricate a plan')
    assert(await drive(engine, e => e.hasUnconfirmedDelivery, 20000), 'lost plan acknowledgment creates a visible hold')
    const original = clients.attemptedPosts()[0].text
    assert(engine.snapshot().deliveryAttempts[0].text === original, 'the entire original planning turn remains durable')
    await drive(engine, () => false, 20000)
    assert(clients.postCount() === 1 && engine.hasUnconfirmedDelivery, 'ticks never duplicate an unconfirmed planning turn')
    clients.deliverAttempt(1)
    assert(await drive(engine, (e) => e.snapshot().planLabels.length > 0, 20000), 'authoritative observation of the original accepted turn resolves planning')
    assert(clients.postCount() === 1, 'reconciliation sends no second planning POST')
    assert(engine.snapshot().awaiting === null, 'the plan reply was parsed, not awaited again')
  }

  // The worker's build POST blips: receipt is uncertain, never auto-replayed.
  {
    const clients = makeClients({ blipPosts: [2] })
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Add the empty-state screen', 5)
    engine.handleAction('start_planning')
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready'), 20000)
    engine.handleAction('begin')
    engine.handleAction('use_it')
    assert(await drive(engine, (e) => e.hasUnconfirmedDelivery, 20000), 'a blipped worker POST presents a delivery hold')
    const sent = clients.postCount()
    await drive(engine, () => false, 10000)
    assert(clients.postCount() === sent && engine.snapshot().jobs[0].pendingPrompt === null,
      'uncertain execution is not an unsent prompt and never replays on ticks')
    assert(engine.snapshot().faultKind === null, 'the blip never became a fault')
  }

  // The reviewer turn has the same durability rule as implementation.
  {
    const clients = makeClients({ blipPosts: [3] })
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Add the empty-state screen', 5)
    engine.handleAction('start_planning')
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready'), 20000)
    engine.handleAction('begin')
    engine.handleAction('use_it')
    assert(await drive(engine, e => e.hasUnconfirmedDelivery && e.snapshot().awaiting === 'verdict', 60000), 'the uncertain review turn remains held')
    const review = clients.attemptedPosts()[2].text
    await drive(engine, () => false, 20000)
    assert(clients.postCount() === 3 && engine.hasUnconfirmedDelivery, 'an unknown review turn cannot be replayed')
    assert(engine.snapshot().deliveryAttempts[0].text === review, 'the full reviewer request and approved criteria survive the hold')
    clients.deliverAttempt(3)
    assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final', 60000), 'read-only reconciliation resumes review and finishes the delivery')
    assert(clients.attemptedPosts().filter(p => p.text === review).length === 1, 'the reviewer received exactly one invocation of this request')
    assert(engine.snapshot().faultKind === null, 'the blip never became a fault')
  }

  // Restart preserves uncertainty and exact owner text, not a retry grant.
  {
    const clients = makeClients({ blipPosts: [1] })
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Add the empty-state screen', 5)
    engine.handleAction('start_planning')
    assert(await drive(engine, e => e.hasUnconfirmedDelivery, 20000), 'the initial plan acknowledgment is unknown before restart')
    const snap = JSON.parse(JSON.stringify(engine.snapshot()))
    assert(snap.pendingLeadPosts.length === 0 && snap.deliveryAttempts.length === 1, 'an invoked unknown is durable uncertainty, never an unsent queue item')
    assert(snap.deliveryAttempts[0].text === clients.attemptedPosts()[0].text, 'restart preserves the exact original plan request')
    const engine2 = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine2.restore(snap)
    engine2.boot()
    await drive(engine2, () => false, 20000)
    assert(engine2.hasUnconfirmedDelivery && clients.postCount() === 1, 'restore and repeated ticks cannot resend the unknown turn')
    clients.deliverAttempt(1)
    assert(await drive(engine2, (e) => e.snapshot().planLabels.length > 0, 20000), 'the restored engine observes the original provider acceptance and completes the plan')
    assert(clients.postCount() === 1, 'restart reconciliation creates no duplicate provider write')
  }
}

// -------- gates survive steering; a stopped worker and a logged question
//          survive a restore; the ask key never duplicates a question
{
  console.log('Gates, stopped workers, and chat honesty across a restore')

  // A newer owner turn retires approval of the old scope.
  {
    const clients = makeClients()
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Add the empty-state screen', 5)
    engine.handleAction('start_planning')
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready'), 20000)
    engine.handleAction('begin')
    assert(engine.hasPendingDecision, 'the start gate is pending')
    const where = engine.say('Should we keep the existing design tokens?')
    assert(where === 'steer', 'free words at a gate steer the lead')
    assert(!engine.hasPendingDecision && !engine.snapshot().decisionGate,
      'a newer owner turn retires the old build gate')
    engine.handleAction('use_it')
    await new Promise((r) => setTimeout(r, 0))
    assert(engine.snapshot().jobs.length === 0, 'a stale confirmation launches nothing')
    engine.steer('Reply with a milestone plan')
    assert(await drive(engine, (e) => e.snapshot().planLabels.length > 0, 20000), 'the revised scope produces a new plan')
    engine.handleAction('begin')
    engine.handleAction('use_it')
    assert(await drive(engine, (e) => (e.snapshot().jobs[0]?.state ?? '') === 'building', 20000),
      'fresh approval launches the revised plan')
  }

  // A stopped worker's issue card rides the snapshot: without it a restore
  // shows a dead job as a plain building card nobody can answer.
  {
    const clients = makeClients()
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    const snap = {
      ...engine.snapshot(),
      phase: 'building',
      goal: 'Add the empty-state screen',
      sessionId: 'sess-lead',
      planLabels: ['Add the empty-state screen'],
      jobs: [{
        label: 'Add the empty-state screen', mode: 'session', stage: 'build',
        agentId: null, runId: null, runStatus: '', sessionId: 'sess-worker',
        seenIds: [], count: 0, lastCount: 0, awaiting: 'build', branch: '',
        state: 'stopped', weight: 65, pendingPrompt: null,
      }],
      workerIssue: 'The worker finished without pushing a branch. How should I proceed?',
    }
    engine.restore(snap)
    engine.boot()
    const view = engine.currentView
    assert(
      view.type === 'scene' && view.scene.kind === 'repair' &&
        view.scene.utterance === 'The worker finished without pushing a branch. How should I proceed?' &&
        view.scene.actions.some((a) => a.id === 'restart'),
      'a restored stopped worker shows its honest issue card with the actions that can answer it',
    )
  }

  // A pending question already in the chat log is not logged twice on boot.
  {
    const clients = makeClients()
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    const question = 'Start the build now?'
    // The owner steered after the question was asked, so the question is in
    // the log but is not its last entry (the pre-fix restore logged it again,
    // showing the same question twice, out of order).
    const snap = {
      ...engine.snapshot(),
      phase: 'plan',
      goal: 'Add the empty-state screen',
      sessionId: 'sess-lead',
      planLabels: ['Add the empty-state screen'],
      decisionPending: true,
      decisionGate: true,
      decisionKind: 'build',
      decisionText: question,
      chat: [
        { who: 'you', text: 'Add the empty-state screen', at: 1000 },
        { who: 'spriite', text: question, at: 2000 },
        { who: 'you', text: 'Use the dark theme tokens.', at: 3000 },
      ],
    }
    engine.restore(snap)
    engine.boot()
    const logged = engine.chatLog().filter((c) => c.text === question)
    assert(logged.length === 1, `a restored pending question logs once, not ${logged.length} times`)
    assert(engine.hasPendingDecision, 'the restored gate is still pending')
    // And answering it logs the owner's confirmation exactly once.
    engine.handleAction('use_it')
    assert(!engine.hasPendingDecision, 'the restored gate answers')
    assert(engine.chatLog().filter((c) => c.text === 'Yes, start the build.').length === 1, 'the answer logs once')
    assert(engine.chatLog().filter((c) => c.text === question).length === 1, 'answering does not re-log the question')
  }

  // An in-flight newer owner turn cannot queue approval of the old plan.
  {
    const clients = makeClients()
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Add the empty-state screen', 5)
    engine.handleAction('start_planning')
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready'), 20000)
    engine.handleAction('begin')
    // The owner changed scope while the old gate was displayed.
    const where = engine.say('Keep the design tokens?')
    assert(where === 'steer', 'free words steer')
    engine.handleAction('use_it')
    assert(engine.snapshot().queuedStart === null, 'new scope does not queue stale approval while busy')
    await drive(engine, () => false, 10000)
    assert(engine.snapshot().jobs.length === 0, 'the old gate cannot launch after the newer turn settles')
  }
}

// -------- chat seq: one identity per line, assigned at birth, kept by the
//          capped tails, every snapshot, and every restore — the archive
//          keys its chat rows on (mission_id, seq), so a rebind rewrites
//          history on the relay
{
  console.log('Chat seq: a stable identity across the sliding tail and restores')

  // A real mission: every line is born with the next seq, in arrival order,
  // and the snapshot carries the counter past the tail it holds.
  {
    const clients = makeClients({ steerQuestion: 'Which database should I use, Postgres or SQLite?' })
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    engine.say('Deliver the empty-state screen')
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready'), 20000)
    engine.handleAction('begin')
    engine.handleAction('use_it')
    assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running', 20000), 'the mission builds')
    engine.say('Store the notes in a database')
    assert(await drive(engine, (e) => e.currentView.type === 'selection' && e.currentView.purpose === 'decision', 20000), 'the lead asks its question mid-build')
    const born = engine.chatLog()
    assert(born.length >= 3, 'the exchange is in the log')
    assert(born.every((e, i) => e.seq === i), 'every line is born with the next seq, in arrival order')
    const snap = engine.snapshot()
    assert(
      snap.chat.every((e, i) => e.seq === born[i].seq) && snap.chatSeq === born.length,
      'the snapshot tail carries each line under its own seq, and the counter rides past it',
    )
    const engine2 = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine2.restore(snap)
    const kept = engine2.chatLog()
    assert(
      kept.length === born.length && kept.every((e, i) => e.seq === born[i].seq && e.text === born[i].text && e.at === born[i].at),
      'a restored mission keeps every line under the seq it was born with',
    )
    engine2.handleAction('use_it')
    const answered = engine2.chatLog()
    assert(
      answered[answered.length - 1].seq === snap.chatSeq,
      'the first line after a restore takes the counter the snapshot carried — a seq is never reused for a different line',
    )
  }

  // The sliding tail: the caps (60 in memory, 40 in the snapshot) drop the
  // oldest lines, and the survivors keep their seqs — a position-based seq
  // would renumber them, which is the rebind the archive must never see.
  {
    const clients = makeClients()
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    const lines = Array.from({ length: 100 }, (_, i) => ({
      who: i % 2 === 0 ? 'you' : 'spriite', text: `line ${i}`, at: i, seq: i,
    }))
    engine.restore({
      ...engine.snapshot(),
      phase: 'plan',
      goal: 'Add the empty-state screen',
      sessionId: 'sess-lead',
      chat: lines,
      chatSeq: 100,
    })
    const kept = engine.chatLog()
    assert(
      kept.length === 60 && kept[0].seq === 40 && kept[kept.length - 1].seq === 99,
      'the in-memory cap keeps the newest 60 lines under their own seqs, never renumbered',
    )
    const resnap = engine.snapshot()
    assert(
      resnap.chat.length === 40 && resnap.chat[0].seq === 60 && resnap.chatSeq === 100,
      'the snapshot tail slides past 40 without rebinding, and the counter rides past what the tail still holds',
    )
    const engine2 = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine2.restore(resnap)
    const again = engine2.chatLog()
    assert(
      again.length === resnap.chat.length && again.every((e, i) => e.seq === resnap.chat[i].seq && e.text === resnap.chat[i].text),
      'a clean restore of the slid tail: every line still under its own seq',
    )
    engine2.handleAction('use_it') // no pending decision: logs nothing, starts nothing
    assert(engine2.chatLog().length === again.length, 'use_it with no pending decision changes no line')
  }

  // A pre-seq snapshot is an older format: its lines still display, minted
  // fresh seqs in arrival order (the order the old index-based writer already
  // mirrored), and the next line continues past them.
  {
    const clients = makeClients()
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    const question = 'Start the build now?'
    engine.restore({
      ...engine.snapshot(),
      phase: 'plan',
      goal: 'Add the empty-state screen',
      sessionId: 'sess-lead',
      planLabels: ['Add the empty-state screen'],
      decisionPending: true,
      decisionGate: true,
      decisionKind: 'build',
      decisionText: question,
      chat: [
        { who: 'you', text: 'Add the empty-state screen', at: 1000 },
        { who: 'spriite', text: question, at: 2000 },
        { who: 'you', text: 'Use the dark theme tokens.', at: 3000 },
      ],
    })
    const minted = engine.chatLog()
    assert(
      minted.length === 3 && minted.every((e, i) => e.seq === i),
      'pre-seq lines are an older format: the restore keeps them and mints seqs in arrival order',
    )
    engine.handleAction('use_it')
    const answered = engine.chatLog()
    assert(
      answered[answered.length - 1].seq === 3 && answered[answered.length - 1].text === 'Yes, start the build.',
      'the first line after a legacy restore continues past the minted seqs',
    )
    const resnap = engine.snapshot()
    assert(
      resnap.chat.every((e, i) => e.seq === i) && resnap.chatSeq === 4,
      'the minted identity is durable too: the next snapshot carries the same seqs and the counter past them',
    )
  }
}

// --------------------- X-shaped goals: the composed request fits the HUD
// An X-origin mission's goal is the COMPOSED request (src/context/gather.ts):
// the owner's instruction first, then the captured context under an explicit
// trust boundary — multi-line and up to 3000 chars. The transcript card is
// that mission's first card (Show on the x_notice opens it), so its utterance
// must fit the scene budget exactly like every provider-derived line already
// does — otherwise validateScene rejects the card, the Show opens nothing,
// and the mission runs dark behind a card that never presented.
{
  const clients = makeClients()
  const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
  engine.boot()
  const instruction = 'Build the portfolio site'
  const quoted = {
    artifactId: 'ctx_quoted',
    kind: 'x_post',
    role: 'quoted_post',
    sourceId: '1758000001',
    authorId: '1758000009',
    authorIsOwner: false,
    retrievedAt: '2026-10-08T01:00:00.000Z',
    contentHash: null,
    completeness: 'complete',
    method: 'x_api_v2',
    text:
      'The portfolio must show the estate archive, the access mechanisms, and the infrastructure map. ' +
      'Use the existing navigation, keep the contact section, and reuse the footer from the main site. ' +
      'The owner wants a dark theme, motion-safe animations, and a short bio on the landing page. ' +
      'The gallery should link each project to its repository and show the latest deployed preview.',
  }
  const goal = composeGoal(instruction, [quoted])
  assert(
    goal.startsWith(instruction) && goal.includes('\n\n') && goal.length > 600,
    'the composed goal leads with the instruction and carries the captured context under the trust boundary',
  )
  engine.voiceGoal(goal, 0)
  const v = engine.currentView
  assert(v.type === 'scene' && v.scene.kind === 'transcript', 'the composed X goal lands on the transcript card')
  assert(
    validateScene(v.scene, 'engine').length === 0,
    'the composed goal\'s card passes scene validation: the X mission presents instead of running dark',
  )
  assert(
    v.scene.utterance.startsWith('Build the portfolio site'),
    'the card leads with the owner\'s own instruction, the one line the trust boundary names',
  )
  const log = engine.chatLog()
  assert(
    log.length === 1 && log[0].who === 'you' && log[0].text === goal,
    'the chat log keeps the whole composed goal and context; only the card uses a four-line preview',
  )

  // A spoken goal carrying a percentage validates too: percentages belong in
  // status, and the card must never be rejected for the owner's own words.
  engine.voiceGoal('Cover 50% of the estate archive page', 0)
  const v2 = engine.currentView
  assert(
    v2.type === 'scene' && v2.scene.kind === 'transcript' && validateScene(v2.scene, 'engine').length === 0,
    'a goal with a percentage still presents: the utterance is fitted, never a rejected card',
  )

  // A single unbreakable token (a pasted URL, a branch name) is the one shape
  // the word-shrinking loop cannot fit: without the pixel-cut fallback the
  // raw token fails validation and the transcript card — the mission's only
  // first card — is swallowed by the G39 fallback while the phase advanced.
  const url = `https://example.com/branches/${'a'.repeat(400)}`
  engine.voiceGoal(url, 0)
  const v3 = engine.currentView
  assert(v3.type === 'scene' && v3.scene.kind === 'transcript', 'a one-token goal lands on the transcript card')
  assert(
    v3.type === 'scene' && validateScene(v3.scene, 'engine').length === 0,
    'a one-token goal validates: the pixel-cut fallback keeps the card presentable',
  )
  assert(
    v3.type === 'scene' && v3.scene.utterance.length < url.length && v3.scene.utterance.endsWith('...'),
    'the one-token goal is honestly truncated to the budget, never passed through raw',
  )
}

// -------- launch blips fault, never park (the silent-park family)
//
// A launch (createSession, worker spawn, cursor run, repo create) has no
// durable record in the raw engine: unlike a post, nothing re-sends it. A
// blip that was swallowed left the mission on a drafting/building/creating
// card with nothing pending and nothing to retry — a zombie the owner can
// only reset away. These must surface as a fault card whose Retry re-runs
// the launch.
{
  console.log('Launch blips: a blipped createSession faults the planning start, and Retry recovers it')

  {
    const clients = makeClients({ blipCreateSessionAt: 1 })
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Add the empty-state screen', 5)
    engine.handleAction('start_planning')
    await new Promise((r) => setTimeout(r, 0))
    const snap = engine.snapshot()
    assert(snap.faultKind === 'network', 'a createSession blip is a fault card, never a silent park on the drafting card')
    assert(snap.faultRetry === 'plan', 'the fault card retries the planning start')
    assert(snap.sessionId === null, 'no half-open session was recorded for the blipped create')
    engine.handleAction('retry')
    assert(
      await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready'), 20000),
      'the Retry re-ran the launch and the plan landed',
    )
  }

  console.log('Launch blips: a blipped worker spawn faults the build, and Retry resumes without duplicating live workers')

  {
    const clients = makeClients({ blipCursorAgentAt: 1 })
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'cursor', jobs: 2, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Add the empty-state screen', 5)
    engine.handleAction('start_planning')
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready'), 20000)
    engine.handleAction('begin')
    engine.handleAction('use_it')
    await new Promise((r) => setTimeout(r, 0))
    const snap = engine.snapshot()
    assert(snap.faultKind === 'network', 'a blipped cursor spawn is a fault card, never a building card with an unspawned job')
    assert(snap.faultRetry === 'build', 'the fault card retries the spawn')
    engine.handleAction('retry')
    assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final', 60000), 'the Retry re-ran the spawn and the mission finished')
    assert(clients.agentCount() === 2, 'the spawn ran exactly once per job (the blipped attempt created nothing)')
  }

  console.log('Launch blips: a blipped fix run faults the repair step, and Retry re-runs it')

  {
    const clients = makeClients({ verdictFailBranches: ['spriite/job-1'], blipCursorRunOn: 'Fix the findings' })
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'cursor', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Add the empty-state screen', 5)
    engine.handleAction('start_planning')
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready'), 20000)
    engine.handleAction('begin')
    engine.handleAction('use_it')
    assert(await drive(engine, (e) => e.snapshot().faultKind === 'network', 60000), 'the blipped fix run surfaced as a fault')
    const snap = engine.snapshot()
    assert(snap.faultRetry === 'fix', 'the fault card retries the fix run')
    assert(snap.faultRetryIndex === 0, 'the fix retry names the job it belongs to')
    engine.handleAction('retry')
    assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final', 60000), 'the Retry re-ran the fix and the mission finished')
  }

  console.log('Launch blips: a blipped PR run faults right after the verified card, and Retry opens the PR')

  {
    const clients = makeClients({ blipCursorRunOn: 'Open a pull request' })
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'cursor', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Add the empty-state screen', 5)
    engine.handleAction('start_planning')
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready'), 20000)
    engine.handleAction('begin')
    engine.handleAction('use_it')
    assert(await drive(engine, (e) => e.snapshot().faultKind === 'network', 60000), 'the blipped PR run surfaced as a fault')
    assert(engine.snapshot().faultRetry === 'pr', 'the fault card retries the PR stage')
    engine.handleAction('retry')
    assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final', 60000), 'the Retry re-ran the PR run and the mission finished')
  }

  console.log('Launch blips: a blipped repository create faults the new-repo start, and Retry re-creates it')

  {
    const clients = makeClients({ blipCreateRepoAt: 1 })
    const engine = new RealOrchestrator(record([]), { ...deps({ repoUrl: '', githubToken: 'gh-test', workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Build a landing page for Acme!', 12)
    engine.handleAction('start_planning') // blocked: no repository chosen
    engine.handleAction('new_repo') // from the prompt card
    await new Promise((r) => setTimeout(r, 0))
    const snap = engine.snapshot()
    assert(snap.faultKind === 'network', 'a blipped repo create is a fault card, never a creating card that expires onto nothing')
    assert(snap.faultRetry === 'repo', 'the fault card retries the create')
    assert(clients.repoCreated().length === 0, 'the blipped attempt created no repository')
    engine.handleAction('retry')
    assert(
      await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready'), 20000),
      'the Retry re-created the repository and the plan landed',
    )
    assert(clients.repoCreated().length === 1, 'exactly one repository was created')
  }
}

// -------- stale async: a continuation from before a reset/restore is inert
//
// reset() and restore() change what this engine object is mid-flight: a poll
// or create that was already awaiting belongs to the mission that ended.
// Writing its result onto the fresh engine corrupted counts, armed awaiting
// on a mission that never asked, or faulted a dead session onto a live card.
{
  console.log('A poll that resolves after a reset writes nothing onto the fresh engine')

  {
    const clients = makeClients()
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Add the empty-state screen', 5)
    engine.handleAction('start_planning')
    await new Promise((r) => setTimeout(r, 0)) // the plan request landed
    const realGetSession = clients.getSession
    let release = null
    clients.getSession = () => new Promise((res) => { release = res })
    engine.tick(0) // the lead poll hangs on the delayed response
    await new Promise((r) => setTimeout(r, 0))
    assert(release !== null, 'the lead poll is in flight')
    engine.reset()
    release({ messageCount: 2, status: 'idle' }) // the dead session answers late
    await new Promise((r) => setTimeout(r, 5))
    engine.tick(500)
    await new Promise((r) => setTimeout(r, 0))
    const snap = engine.snapshot()
    assert(snap.messageCount === 0, 'the stale poll wrote no counts onto the fresh engine')
    assert(snap.phase === 'meet' && snap.planLabels.length === 0, 'the stale poll opened no plan onto the fresh engine')
    assert(snap.faultKind === null, 'the stale poll faulted nothing onto the fresh engine')
    clients.getSession = realGetSession
  }

  console.log('A poll that resolves after a restore never poisons the restored mission')

  {
    // A donor mission mid-build: what the owner restores onto the engine.
    const donorClients = makeClients()
    const donor = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients: donorClients })
    donor.boot()
    donor.voiceGoal('Ship the retry path', 5)
    donor.handleAction('start_planning')
    assert(
      await drive(donor, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready'), 20000),
      'the donor mission reached its plan',
    )
    donor.handleAction('begin')
    donor.handleAction('use_it')
    await new Promise((r) => setTimeout(r, 0)) // the spawn landed; the worker builds
    const donorSnap = JSON.parse(JSON.stringify(donor.snapshot()))
    assert(donorSnap.phase === 'building' && donorSnap.jobs.length === 1, 'the donor is a mid-build mission')

    const clients = makeClients()
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Add the empty-state screen', 5)
    engine.handleAction('start_planning')
    await new Promise((r) => setTimeout(r, 0))
    const realGetSession = clients.getSession
    let release = null
    clients.getSession = () => new Promise((res) => { release = res })
    engine.tick(0)
    await new Promise((r) => setTimeout(r, 0))
    assert(release !== null, 'the lead poll is in flight')
    engine.restore(donorSnap) // the owner picks another vault row onto this engine
    release({ messageCount: 999, status: 'idle' }) // the dead mission's session answers late
    await new Promise((r) => setTimeout(r, 5))
    const snap = engine.snapshot()
    assert(snap.messageCount === donorSnap.messageCount, 'the restored mission keeps its own message count (a stale poll writes nothing)')
    assert(snap.phase === 'building', 'the restored mission keeps its own phase')
    assert(snap.faultKind === null, 'the stale poll faulted nothing onto the restored mission')
    clients.getSession = realGetSession
  }
}

// -------- restore fidelity: the fields a restart must never lose
{
  console.log('Restore keeps the scene counter: a restored mission never replays an old identity')

  {
    const clients = makeClients()
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Add the empty-state screen', 5)
    engine.handleAction('start_planning')
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready'), 20000)
    const before = engine.snapshot().seq
    assert(before > 0, 'the live mission advanced the scene counter')
    const snap = JSON.parse(JSON.stringify(engine.snapshot()))
    const engine2 = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine2.restore(snap)
    assert(engine2.snapshot().seq === before, 'restore keeps the counter the surfaces already saw (no replayed ids)')
  }

  console.log('A paused mission restores paused, and resume is the only thing that clears it')

  {
    const clients = makeClients()
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Add the empty-state screen', 5)
    engine.handleAction('start_planning')
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready'), 20000)
    engine.handleAction('pause')
    assert(engine.snapshot().paused === true, 'the pause is durable pending state in the snapshot')
    const snap = JSON.parse(JSON.stringify(engine.snapshot()))
    const engine2 = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine2.restore(snap)
    assert(engine2.snapshot().paused === true, "a restored mission keeps the owner's pause (never silently resumes)")
    engine2.handleAction('pause') // the pause action on a paused engine is resume
    assert(engine2.snapshot().paused === false, 'resume clears the pause')
    await new Promise((r) => setTimeout(r, 5))
    assert(clients.msgsOf('sess-1').some((m) => m === 'Continue.'), 'the resumed lead was told to continue')
  }

  console.log('The integration step merges the SAME branches on retry, across a fault and a restart')

  {
    const clients = makeClients({ blipCursorRunOn: 'Merge these branches' })
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'cursor', jobs: 2, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Add the empty-state screen', 5)
    engine.handleAction('start_planning')
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready'), 20000)
    engine.handleAction('begin')
    engine.handleAction('use_it')
    assert(await drive(engine, (e) => e.snapshot().faultKind === 'network', 60000), 'the blipped merge surfaced as a fault')
    const faultSnap = JSON.parse(JSON.stringify(engine.snapshot()))
    assert((faultSnap.integrationBranches ?? []).length === 2, "the merge's branch list is durable pending state")
    assert(faultSnap.faultRetry === 'integration', 'the fault card retries the merge')
    // The retry must merge the same branches: job 1's branch was consumed as
    // the merge base, so recomputing the list from the jobs would merge one
    // branch short — a silent half-merge.
    engine.handleAction('retry')
    assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final', 60000), 'the retried merge finished the mission')
    const merges = clients.cursorRunPrompts().filter((p) => p.includes('Merge these branches'))
    assert(merges.length === 2, 'the merge ran twice (once blipped, once retried)')
    assert(
      merges.every((p) => faultSnap.integrationBranches.every((branch) => p.includes(branch))),
      'both merges name every branch, including the base the first attempt consumed',
    )
    // And the same list survives a restart mid-merge.
    const engine2 = new RealOrchestrator(record([]), { ...deps({ workerPref: 'cursor', jobs: 2, askBeforePr: false }), clients })
    engine2.restore(faultSnap)
    assert((engine2.snapshot().integrationBranches ?? []).length === 2, 'the branch list survives the snapshot round-trip')
    engine2.handleAction('retry')
    assert(await drive(engine2, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final', 60000), 'the restored mission retried the merge with the same branches')
  }

  console.log('A corrupt snapshot is quarantined without guessing execution authority')

  {
    const clients = makeClients()
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Add the empty-state screen', 5)
    engine.handleAction('start_planning')
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready'), 20000)
    engine.handleAction('begin')
    engine.handleAction('use_it')
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running')
    const snap = JSON.parse(JSON.stringify(engine.snapshot()))
    // Every corruption is one bad row the vault could hold after a partial
    // write: the restore must hold, never guess a resumable execution state.
    snap.phase = 'weird_phase'
    snap.jobs[0].state = 'bogus_state'
    snap.jobs[0].count = 'not-a-number'
    snap.jobs[0].awaiting = 'weird'
    snap.verdictJob = 'x'
    snap.faultRetry = 'nope'
    snap.faultRetryIndex = -3
    snap.milestones = [{ id: '', label: 5, weight: -1, status: 'weird' }]
    snap.planLabels = [null, 42, 'Keep me']
    snap.reviewQueue = ['a', -1]
    snap.paused = 'yes'
    const engine2 = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine2.restore(snap)
    const out = engine2.snapshot()
    assert(out.phase === 'plan' && out.faultKind === 'storage' && out.quarantined === true,
      'damaged phase/job authority becomes an explicit quarantined hold')
    assert(engine2.currentView?.type === 'scene', 'the corrupted restore still renders a card')
    assert(out.jobs[0].state === 'stopped' && out.jobs[0].sessionId === snap.jobs[0].sessionId,
      'the exact worker identity remains inspectable without restoring execution authority')
    assert(out.jobs[0].count === 0, 'a corrupt count restores as zero')
    assert(out.jobs[0].awaiting === null, 'an unknown awaiting word is dropped')
    assert(out.verdictJob === null, 'a corrupt verdict pointer is dropped')
    assert(out.faultRetry === null, 'an unknown retry word is dropped')
    assert(out.faultRetryIndex === null, 'a negative retry index is dropped')
    assert(out.planLabels.length === 0 && out.approvedPlan.length === 0, 'mixed damaged planning data grants no approval')
    assert(out.reviewQueue.length === 0, 'a corrupt review queue is dropped, never half-Numbered')
    assert(out.paused === true && out.queuedStart === null, 'uncertain control state holds rather than silently unpausing')
    assert(Array.isArray(out.milestones) && out.milestones.length >= 2, 'a corrupt milestone row falls back to the initial ladder')
    const beforeWrites = clients.postCount()
    engine2.boot()
    engine2.handleAction('retry')
    engine2.handleAction('resume')
    await drive(engine2, () => false, 10000)
    assert(clients.postCount() === beforeWrites && engine2.snapshot().quarantined,
      'Retry, Resume, and polling cannot bypass the quarantine or send a provider turn')
    assert(engine2.snapshot().goal === snap.goal, 'the full valid owner goal is preserved for explicit recovery')
  }
}

// -------- queued lead turns: one conversation, one order, no lost words
{
  console.log('Queued lead turns re-send one at a time, in order; a real failure keeps the rest pending')

  {
    const clients = makeClients({ serviceFailPosts: [1] })
    const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
    engine.boot()
    engine.voiceGoal('Add the empty-state screen', 5)
    // Durable receipt-v1 state records genuinely unsent turns before any
    // invocation. Do not mislabel an invoked network loss as this queue.
    const lead = await clients.createSession({ computerId: 'comp-1' })
    const base = await clients.repositoryBase('example/sprite-test')
    engine.restore({ ...engine.snapshot(), phase: 'plan', sessionId: lead.sessionId, missionRepo: REPO,
      missionComputerId: 'comp-1', baseRef: base.ref, baseSha: base.sha, baseRepositoryId: base.repositoryId,
      awaiting: 'plan', planLabels: [], ownerClarifications: ['Also wire the retry path'] })
    const originalPlan = engine.planRequest()
    engine.queueLeadPost(originalPlan, 'plan', false, true)
    assert(engine.snapshot().pendingLeadPosts.length === 1, 'the known-unsent planning turn is queued')
    engine.queueLeadPost('Also wire the retry path', 'plan', true, true)
    const snap = engine.snapshot()
    assert(snap.pendingLeadPosts.length === 2, 'the later known-unsent owner turn remains ordered behind planning')
    assert(
      snap.pendingLeadPosts[0].awaiting === 'plan' && snap.pendingLeadPosts[1].awaiting === 'plan' &&
        snap.pendingLeadPosts[1].protectDelivery === true,
      'the queue keeps the order the owner spoke',
    )
    // The tick dispatches: the head gets an explicit HTTP 400 refusal, which must
    // stop the queue (the steer is a later turn of a conversation whose
    // earlier turn failed) while keeping every unsent turn pending.
    await drive(engine, (e) => e.snapshot().faultKind === 'service', 20000)
    const faulted = engine.snapshot()
    assert(faulted.pendingLeadPosts.length === 2 && faulted.deliveryAttempts.length === 0,
      'a definite refusal retains both full unsent turns, without manufacturing an unknown receipt')
    assert(!clients.msgsOf('sess-1').some((m) => /Also wire the retry path/.test(m)), 'the steer did not go out while the plan turn had failed')
    engine.handleAction('retry')
    assert(
      await drive(engine, (e) => e.snapshot().faultKind === null && e.snapshot().pendingLeadPosts.length === 0, 20000),
      'the Retry re-ran the queue and both turns landed',
    )
    const msgs = clients.msgsOf('sess-1')
    const planAt = msgs.findIndex((m) => /milestone plan/.test(m))
    const steerAt = msgs.findIndex((m) => /Also wire the retry path/.test(m))
    assert(planAt >= 0 && steerAt > planAt, 'the planning turn was accepted before the later owner turn, never transposed')
    assert(clients.attemptedPosts().filter(p => p.text === originalPlan && p.delivered).length === 1,
      'the definitely refused head was later accepted exactly once')
    assert(msgs.filter((m) => /Also wire the retry path/.test(m)).length === 1, 'the steer went out exactly once (Retry never double-sends a queued turn)')
    assert(engine.snapshot().awaiting === 'plan' && engine.snapshot().planLabels.length === 0,
      'the plan preceding the newer clarification cannot restore readiness')
    const drainedPosts = clients.postCount()
    await drive(engine, () => false, 10000)
    assert(clients.postCount() === drainedPosts, 'draining the queue never duplicates an acknowledged turn')
  }
}

// Streaming service messages keep their IDs and counts while text grows.
{
  const clients = makeClients()
  const backendFactoryPost = clients.postMessage
  const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1 }), clients, missionId: 'mission-regression' })
  await bindFrozenMission(engine)
  const leadId = (await clients.createSession({ computerId: 'comp-1' })).sessionId
  engine.sessionId = leadId
  engine.phase = 'plan'
  engine.awaiting = 'plan'
  let text = ''
  let failFetch = true
  let reads = 0
  let workerTurn = ''
  let workerId = ''
  clients.getSession = async id => ({ id, messageCount: 1, status: 'idle', computer: { id: 'comp-1' } })
  clients.getMessages = async id => {
    reads++
    if (failFetch) { failFetch = false; throw Object.assign(new Error('blip'), { kind: 'network' }) }
    return [...(id === workerId && workerTurn ? [{ id: 'accepted-worker-turn', role: 'user', text: workerTurn }] : []),
      { id: 'stream', role: 'assistant', text }]
  }
  await engine.pollLead()
  assert(reads === 1 && engine.awaiting === 'plan' && engine.planLabels.length === 0, 'failed message fetch does not advance or consume a reply')
  await engine.pollLead()
  assert(reads === 2, 'the next cadence retries messages even when the reported count is unchanged')
  text = '1. Scope - retain requirements'
  await engine.pollLead()
  assert(engine.awaiting === 'plan' && engine.planLabels.length === 0, 'first streamed numbered line remains provisional')
  assert(!engine.beginApproved() && engine.jobs.length === 0, 'provisional plan cannot launch approved build')
  const pendingSnapshot = JSON.parse(JSON.stringify(engine.snapshot()))
  const pendingRestore = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1 }), clients })
  pendingRestore.restore(pendingSnapshot)
  assert(!pendingRestore.beginApproved(), 'restored provisional plan cannot launch build')
  assert(pendingRestore.snapshot().planProtocol === 'marker-v1', 'marker protocol survives provisional snapshot')
  let migrationPosts = 0
  const refreshPosts = []
  let policyBlocksRefresh = false
  clients.postMessage = async (id, prompt) => {
    if (policyBlocksRefresh) throw Object.assign(new Error('Policy blocks launch before invocation'), { kind: 'policy', notDispatched: true })
    migrationPosts++
    refreshPosts.push({ id, prompt })
  }
  const legacyPending = JSON.parse(JSON.stringify(pendingSnapshot))
  delete legacyPending.planProtocol
  legacyPending.planLabels = ['Scope - retain requirements']
  const legacy = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1 }), clients })
  legacy.restore(legacyPending)
  await legacy.pollLead()
  assert(!legacy.beginApproved() && legacy.snapshot().planProtocol === 'legacy', 'legacy awaited plans require explicit completion, not provisional labels')
  assert(migrationPosts === 0, 'legacy awaited restore never silently re-sends plan request')
  assert(legacy.currentView.type === 'scene' && legacy.currentView.scene.kind !== 'plan_ready' &&
    legacy.currentView.scene.actions.some((a) => a.id === 'continue_session'),
    'confirmed-idle legacy awaited plan offers Continue without crediting provisional labels as ready')
  assert(!JSON.stringify(legacy.currentView).includes('PLAN_READY'), 'owner recovery never requires technical marker instructions')
  legacy.paused = true
  legacy.handleAction('retry')
  await new Promise((r) => setTimeout(r, 0))
  assert(migrationPosts === 0, 'paused legacy plan cannot refresh')
  legacy.paused = false
  policyBlocksRefresh = true
  legacy.handleAction('retry')
  await new Promise((r) => setTimeout(r, 0))
  assert(migrationPosts === 0 && legacy.snapshot().planProtocol === 'legacy', 'policy refusal keeps refresh available without sending')
  policyBlocksRefresh = false
  legacy.handleAction('retry')
  legacy.handleAction('retry')
  await new Promise((r) => setTimeout(r, 0))
  assert(migrationPosts === 1 && refreshPosts[0].id === leadId && refreshPosts[0].prompt.includes('PLAN_READY'), 'refresh taps send one marker-protocol request on existing lead session')
  assert(legacy.jobs.length === 0, 'refresh never creates duplicate workers')
  text = '1. Scope - retain requirements\n2. Setup - install wiring\n3. Build - implement feature\n4. Validate - run tests'
  await engine.pollLead()
  assert(engine.awaiting === 'plan' && engine.planLabels.length === 0, 'full numbered text still waits for explicit terminator')
  text += '\nPLAN_READY'
  await engine.pollLead()
  assert(engine.planLabels.length === 4, 'empty assistant message grows into plan at unchanged count')
  assert(engine.planLabels[0]?.includes('retain requirements'), 'plan retains completion requirements')
  await pendingRestore.pollLead()
  assert(pendingRestore.planLabels.length === 4 && pendingRestore.awaiting === null, 'restored provisional stream accepts complete same-ID marker reply')
  await legacy.pollLead()
  assert(legacy.planLabels.length === 4 && legacy.awaiting === null, 'refreshed legacy plan accepts full marked completion')
  const legacyReady = JSON.parse(JSON.stringify(engine.snapshot()))
  delete legacyReady.planProtocol
  const readyRestore = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1 }), clients })
  readyRestore.restore(legacyReady)
  assert(readyRestore.planLabels.length === 4 && readyRestore.awaiting === null, 'older already-ready snapshots retain approved plan evidence')
  engine.awaiting = 'verdict'
  await engine.pollLead()
  assert(engine.awaiting === 'verdict', 'unchanged plan text is not replayed as the next awaited reply')
  const seenSnapshot = JSON.parse(JSON.stringify(engine.snapshot()))
  const restored = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1 }), clients })
  restored.restore(seenSnapshot)
  await restored.pollLead()
  assert(restored.awaiting === 'verdict', 'text fingerprints survive snapshot restore without duplicate handling')
  engine.awaiting = null
  engine.jobCount = 1
  const job = engine.createJobs()[0]
  assert(job.label.includes('Validate - run tests'), 'single worker receives entire plan')
  assert(engine.jobBuildPrompt(job, 0, 1).includes('mission-regression'), 'worker branch is mission-specific')
  assert(engine.jobBuildPrompt(job, 0, 1).includes('Validate - run tests'), 'complete streamed plan reaches worker prompt')
  engine.jobCount = 2
  assert(engine.createJobs().map((j) => j.label).join('\n').includes('Validate - run tests'), 'multiple workers cover every plan requirement')
  job.sessionId = (await clients.createSession({ computerId: 'comp-1', sessionSettings: { tags: [{ name: 'spriite', value: 'worker' }] } })).sessionId
  engine.jobs = [job]
  engine.sessionId = null // do not dispatch reviews in this isolated test
  workerId = job.sessionId
  workerTurn = engine.workerRequest(job, engine.jobBuildPrompt(job, 0, 1))
  await backendFactoryPost(workerId, workerTurn, 'comp-1')
  text = ''
  failFetch = true
  await engine.pollJob(job)
  assert(job.lastCount === 0, 'worker message fetch failure does not consume count')
  await engine.pollJob(job)
  text = 'Looking at the repository.'
  await engine.pollJob(job)
  assert(job.state === 'building', 'progress reply does not stop worker')
  await engine.pollJob(job)
  assert(job.seenIds.length === 1, 'repeated worker progress uses one bounded fingerprint per ID')
  text = `SUMMARY: implemented\nBRANCH: spriite/mission-regression/job-1\nREQUEST: ${job.requestToken}\nWORK_READY`
  await engine.pollJob(job)
  assert(job.state === 'queued', 'same-ID grown structured completion queues review')
  await engine.pollJob(job)
  assert(engine.reviewQueue.length === 1, 'completed worker queues review exactly once')
  engine.awaiting = 'verdict'
  engine.handleReply('Reviewing the diff.')
  assert(engine.awaiting === 'verdict', 'review progress does not become failed verdict')
  assert(reads <= 17 && migrationPosts === 1, 'bounded polling plus mandatory send pre-read never spins or blindly resends prompts')
}

// Request-aware streaming regressions: no network and constant message counts.
{
  const clients = makeClients({ pullNumber: 123 })
  const e = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 2 }), clients })
  await bindFrozenMission(e)
  e.sessionId = (await clients.createSession({ computerId: 'comp-1' })).sessionId
  e.missionRepo = REPO
  e.planLabels = ['A', 'B']
  e.jobs = e.createJobs()
  for (const j of e.jobs) { j.branch = 'spriite/test/' + j.label; j.state = 'queued'; clients.publishBranch(j.branch) }
  e.reviewQueue = [0, 1]
  e.dequeueNextReview()
  await new Promise((r) => setTimeout(r, 0))
  const tokenA = e.snapshot().verdictToken
  const reply = (token, value) => `VERDICT: ${value}\nREQUEST: ${token}\nVERDICT_READY`
  let verdictText = `VERDICT: PASS\nREQUEST: ${tokenA}`
  clients.getSession = async () => ({ messageCount: 2 })
  clients.getMessages = async () => [{ id: 'verdict-A', role: 'assistant', text: verdictText }]
  await e.pollLead()
  assert(e.jobs[0].state === 'review', 'verdict prefix is provisional without final marker')
  verdictText = reply(tokenA, 'PASS')
  await e.pollLead()
  await new Promise((r) => setTimeout(r, 0))
  assert(e.jobs[0].state === 'accepted' && e.jobs[1].state === 'review', 'completed A verdict starts B review')
  verdictText = reply(tokenA, 'PASS More streamed reasons.')
  await e.pollLead()
  assert(e.jobs[1].state === 'review', 'grown A verdict cannot accept B')
  const restored = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 2 }), clients })
  restored.restore(JSON.parse(JSON.stringify(e.snapshot())))
  assert(restored.snapshot().verdictToken === e.snapshot().verdictToken && !!e.snapshot().verdictToken, 'verdict request token persists through restore')

  const w = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1 }), clients })
  await bindFrozenMission(w)
  w.planLabels = ['Build']
  w.jobs = w.createJobs()
  const j = w.jobs[0]
  const prompt = w.jobBuildPrompt(j, 0, 1)
  const buildBranch = w.missionBranch('job-1')
  await w.spawnJob(j, prompt, w.generation)
  let text = ''
  clients.getSession = async () => ({ messageCount: 2 })
  clients.getMessages = async id => [
    ...clients.attemptedPosts().filter(p => p.id === id && p.delivered).map((p, index) =>
      ({ id: `accepted-turn-${index}`, role: 'user', text: p.text })),
    { id: 'growing', role: 'assistant', text },
  ]
  const token = w.snapshot().jobs[0].requestToken
  text = `SUMMARY: implemented\nBRANCH: spriite/test/job-\nREQUEST: ${token}`
  await w.pollJob(j)
  assert(j.state === 'building', 'partial structured branch remains provisional at constant count')
  text = `SUMMARY: implemented\nBRANCH: ${buildBranch}\nREQUEST: ${token}\nWORK_READY`
  await w.pollJob(j)
  assert(j.state === 'queued' && j.branch === buildBranch, 'final branch token queues one review for the independently published branch')
  j.stage = 'integration'
  const integrationPrompt = w.integrationPrompt(j, [j.branch])
  const integrationBranch = w.missionBranch('integration')
  await w.runJobPrompt(j, integrationPrompt, w.generation)
  const integrationToken = w.snapshot().jobs[0].requestToken
  text += ' '
  await w.pollJob(j)
  assert(j.state === 'building' && w.reviewQueue.length === 1, 'late build branch cannot complete integration or duplicate review')
  text = `SUMMARY: merged\nBRANCH: ${integrationBranch}\nREQUEST: ${integrationToken}\nWORK_READY`
  await w.pollJob(j)
  await w.pollJob(j)
  assert(j.branch === integrationBranch && w.reviewQueue.length === 2, 'integration final queues exactly one new review')
  j.stage = 'pr'
  await w.runJobPrompt(j, w.prPrompt(j), w.generation)
  const prToken = w.snapshot().jobs[0].requestToken
  text += ' '
  await w.pollJob(j)
  assert(j.state === 'building', 'late previous-stage worker reply is ignored')
  text = `SUMMARY: opened\nPR: ${REPO}/pull/1\nREQUEST: ${prToken}`
  await w.pollJob(j)
  assert(j.state === 'building' && !w.prUrl, 'partial PR token cannot finish mission')
  const pending = JSON.parse(JSON.stringify(w.snapshot()))
  const wr = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory' }), clients })
  wr.restore(pending)
  assert(wr.snapshot().jobs[0].requestToken === prToken && !!prToken, 'worker request token persists mid-stage')
  let finishes = 0
  const originalFinish = wr.finishPr.bind(wr)
  wr.finishPr = async (...args) => { finishes++; await originalFinish(...args) }
  text = `SUMMARY: opened\nPR: ${REPO}/pull/123\nREQUEST: ${prToken}\nWORK_READY`
  await wr.pollJob(wr.jobs[0])
  await wr.pollJob(wr.jobs[0])
  await new Promise(resolve => setTimeout(resolve, 0))
  assert(finishes === 1 && wr.prUrl.endsWith('/123'), 'restored worker finishes correct PR once')
  const old = JSON.parse(JSON.stringify(pending))
  delete old.jobs[0].requestToken
  const migration = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory' }), clients })
  const refreshPosts = []
  clients.postMessage = async (id, prompt) => { refreshPosts.push({ id, prompt }) }
  migration.restore(old)
  migration.retryPendingPrompts()
  assert(refreshPosts.length === 0, 'older pending work is not blindly resent on restore')
  migration.paused = true
  migration.handleAction('retry')
  await new Promise((r) => setTimeout(r, 0))
  assert(refreshPosts.length === 0, 'paused legacy result refresh cannot post')
  migration.paused = false
  assert(migration.computeView().scene?.actions.some((a) => a.id === 'retry'), 'older pending worker offers owner result refresh')
  migration.handleAction('retry')
  await new Promise((r) => setTimeout(r, 0))
  assert(refreshPosts.length === 1 && refreshPosts[0].id === old.jobs[0].sessionId && refreshPosts[0].prompt.includes('Do not repeat work'), 'owner refresh queries same worker without relaunch or duplicate PR')
  migration.handleAction('retry')
  assert(refreshPosts.length === 1, 'repeated refresh does not duplicate result request')
  const completed = JSON.parse(JSON.stringify(wr.snapshot()))
  delete completed.jobs[0].requestToken
  migration.restore(completed)
  assert(!migration.needsResponseRefresh() && migration.prUrl.endsWith('/123'), 'older completed PR evidence remains completed')
  const oldReview = JSON.parse(JSON.stringify(e.snapshot()))
  delete oldReview.verdictToken
  const leadMigration = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 2 }), clients })
  leadMigration.restore(oldReview)
  const beforeRefresh = refreshPosts.length
  leadMigration.retryPendingPrompts()
  assert(refreshPosts.length === beforeRefresh && leadMigration.needsResponseRefresh(), 'legacy verdict waits for owner refresh')
  leadMigration.handleAction('retry')
  await new Promise((r) => setTimeout(r, 0))
  assert(refreshPosts.length === beforeRefresh + 1 && refreshPosts.at(-1).id === oldReview.sessionId && !!leadMigration.snapshot().verdictToken, 'legacy review refreshes in existing lead with a persisted token')
  leadMigration.handleReply(reply(tokenA, 'PASS'))
  assert(leadMigration.jobs[1].state === 'review', 'old verdict cannot satisfy refreshed legacy review')


}

{
  const clients = makeClients()
  const sent = []
  let release
  const backendPost = clients.postMessage
  clients.postMessage = async (id, text, computer) => {
    sent.push(text)
    await new Promise((resolve) => { release = resolve })
    await backendPost(id, text, computer)
  }
  const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory' }), clients })
  await bindFrozenMission(engine)
  engine.sessionId = (await clients.createSession({ computerId: 'comp-1' })).sessionId
  engine.phase = 'building'
  assert(engine.steer('First follow-up'), 'the first ordinary follow-up starts sending')
  assert(engine.say('Keep this second follow-up') === 'none', 'busy typed input is not falsely acknowledged as sent')
  assert(!engine.steer('Third follow-up'), 'busy voice steering reports that it did not send')
  await new Promise((resolve) => setTimeout(resolve, 0)) // fresh receipt-baseline read completes before POST
  assert(sent.length === 1, 'busy ordinary follow-ups never silently count as additional sends')
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert(engine.say('Keep this second follow-up') === 'steer', 'the kept typed input can be retried after the first send settles')
  await new Promise((resolve) => setTimeout(resolve, 0))
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert(sent.length === 2 && sent[1] === 'Keep this second follow-up', 'the retried input actually reaches the lead once')
}

// PR delivery evidence must belong to this repository and (for Cursor) the
// already-reviewed branch on the SAME result entry.
{
  const invalid = [
    'https://example.com/example/sprite-test/pull/9',
    `${REPO}/issues/9`,
    'https://github.com/another/repository/pull/9',
    `${REPO}/pull/0`,
    'https://private-user:private-password@github.com/example/sprite-test/pull/9',
  ]
  for (const url of invalid) {
    const e = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory' }), clients: makeClients() })
    e.missionRepo = REPO
    e.jobs = e.createJobs()
    const j = e.jobs[0]
    j.stage = 'pr'
    j.branch = 'spriite/reviewed'
    j.requestToken = 'pr-validation'
    e.handleWorkerReply(j, `SUMMARY: opened\nPR: ${url}\nREQUEST: pr-validation\nWORK_READY`)
    assert(!e.prUrl && e.phase !== 'final' && j.state !== 'accepted', `session rejects invalid PR evidence: ${url.replace(/private-user:private-password@/, '[userinfo]@')}`)
    assert(!JSON.stringify(e.snapshot()).includes('private-password'), 'rejected PR credentials never enter the snapshot')
  }
  const cursorCases = [
    [{ repoUrl: REPO, branch: 'spriite/reviewed' }, { repoUrl: REPO, branch: 'spriite/other', prUrl: `${REPO}/pull/9` }],
    [{ repoUrl: REPO, branch: 'spriite/other', prUrl: `${REPO}/pull/9` }],
    [{ repoUrl: REPO, prUrl: `${REPO}/pull/9` }],
    [{ repoUrl: 'https://github.com/another/repository', branch: 'spriite/reviewed', prUrl: `${REPO}/pull/9` }],
    [{ repoUrl: 'https://private-user:private-password@github.com/example/sprite-test', branch: 'spriite/reviewed', prUrl: `${REPO}/pull/9` }],
    ...invalid.map((prUrl) => [{ repoUrl: REPO, branch: 'spriite/reviewed', prUrl }]),
  ]
  for (const branches of cursorCases) {
    const e = new RealOrchestrator(record([]), { ...deps({ workerPref: 'cursor' }), clients: makeClients() })
    e.missionRepo = REPO
    e.jobs = e.createJobs()
    const j = e.jobs[0]
    j.stage = 'pr'
    j.branch = 'spriite/reviewed'
    await e.handleRunDone(j, { id: 'pr-run', status: 'FINISHED', text: '', branches }, e.generation)
    assert(!e.prUrl && e.phase !== 'final' && j.state !== 'accepted', 'Cursor rejects unrelated, split-entry, or malformed PR evidence')
    assert(j.branch === 'spriite/reviewed', 'invalid Cursor PR evidence cannot replace the reviewed branch')
    assert(!JSON.stringify(e.snapshot()).includes('private-password'), 'invalid Cursor URL credentials are never persisted')
  }
  for (const mode of ['session', 'cursor']) {
    const clients = makeClients()
    const e = new RealOrchestrator(record([]), { ...deps({ workerPref: mode === 'session' ? 'factory' : 'cursor' }), clients })
    await bindFrozenMission(e)
    e.missionRepo = REPO + '.git'
    e.jobs = e.createJobs()
    const j = e.jobs[0]
    j.stage = 'pr'
    j.branch = 'spriite/reviewed'
    clients.publishBranch(j.branch)
    const evidence = await clients.branchEvidence('example/sprite-test', j.branch, e.baseRef)
    j.headSha = evidence.headSha
    j.baseSha = evidence.baseSha
    clients.publishPr(j.branch)
    j.requestToken = 'valid-pr'
    const url = 'https://github.com/EXAMPLE/SPRITE-TEST/pull/9/?diff=split#discussion'
    if (mode === 'session') e.handleWorkerReply(j, `SUMMARY: opened\nPR: ${url}\nREQUEST: valid-pr\nWORK_READY`)
    else await e.handleRunDone(j, { id: 'pr-run', status: 'FINISHED', text: '', branches: [
      { repoUrl: 'https://github.com/EXAMPLE/SPRITE-TEST.git', branch: 'spriite/reviewed', prUrl: url },
    ] }, e.generation)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert(e.prUrl === url && e.phase === 'final', `${mode} accepts legitimate case-insensitive repository PR URLs`)
  }
}

{
  const clients = makeClients()
  const create = clients.createSession
  let creates = 0
  clients.createSession = async (opts) => { creates++; return create(opts) }
  const stages = []
  let allowed = false
  clients.postWorkerExecution = async (id, text, stage, computer) => {
    stages.push(stage)
    if (!allowed) throw Object.assign(new Error('worker execution refused'), { kind: 'policy' })
    return clients.postMessage(id, text, computer)
  }
  const e = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory' }), clients })
  await bindFrozenMission(e)
  e.jobs = e.createJobs()
  const j = e.jobs[0]
  let rejected = false
  try { await e.spawnJob(j, e.jobBuildPrompt(j, 0, 1), e.generation) } catch { rejected = true }
  assert(rejected && stages[0] === 'build', 'the first Factory instruction crosses the classified build seam')
  const pending = j.pendingPrompt
  const token = j.requestToken
  assert(creates === 1 && !!j.sessionId && !!pending, 'an unposted build retains its created worker and exact request')
  allowed = true
  e.retryPendingPrompts()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert(stages.join(',') === 'build,build' && !j.pendingPrompt && j.requestToken === token,
    'queued build recovery crosses the same seam without regenerating its request token')
  e.retryPendingPrompts()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert(creates === 1 && stages.length === 2, 'build recovery never recreates the worker or repeats its instruction')
}

{
  // C8 per-idea repositories: a goal that names no repository starts in a
  // new private one (the New repo path); with the mode 'one' nothing changes.
  console.log('Per-idea repositories: a plain goal starts in its own new repository')
  const clients = makeClients()
  const engine = new RealOrchestrator(record([]), {
    ...deps({ githubToken: 'gh-test', workerPref: 'factory', jobs: 1, askBeforePr: false }),
    repoMode: 'per_idea',
    clients,
  })
  engine.boot()
  engine.voiceGoal('Add a guest checkout to the shop site', 8)
  engine.handleAction('start_planning')
  assert(
    await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready')),
    'per_idea: Start planning on a plain goal plans in a new repository',
  )
  const created = clients.repoCreated()
  assert(created.length === 1 && created[0].isPrivate === true && /guest-checkout/.test(created[0].name),
    'per_idea: the new repository is private and named from the request')
  assert(engine.snapshot().missionRepo !== REPO && engine.snapshot().missionRepo.endsWith(created[0].name),
    'per_idea: the configured default repository is not adopted')

  const named = makeClients()
  const e2 = new RealOrchestrator(record([]), {
    ...deps({ githubToken: 'gh-test', workerPref: 'factory', jobs: 1, askBeforePr: false }),
    repoMode: 'per_idea',
    clients: named,
  })
  e2.boot()
  e2.voiceGoal(`Fix the footer in ${REPO}`, 8)
  e2.handleAction('start_planning')
  await drive(e2, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan')
  assert(named.repoCreated().length === 0 && e2.snapshot().missionRepo === REPO,
    'per_idea: a goal that names a repository builds there, no new repository')

  const one = makeClients()
  const e3 = new RealOrchestrator(record([]), {
    ...deps({ githubToken: 'gh-test', workerPref: 'factory', jobs: 1, askBeforePr: false }),
    repoMode: 'one',
    clients: one,
  })
  e3.boot()
  e3.voiceGoal('Add a guest checkout to the shop site', 8)
  e3.handleAction('start_planning')
  await drive(e3, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan')
  assert(one.repoCreated().length === 0 && e3.snapshot().missionRepo === REPO,
    "repoMode 'one': the configured repository is used exactly as before")
}

{
  // HudRun / HudDone on the live engine: the context line, the milestone
  // marks, the Run actions, and the Done card.
  console.log('HUD redesign: Run and Done cards on the live engine')
  const clients = makeClients()
  const engine = new RealOrchestrator(record([]), { ...deps({ workerPref: 'factory', jobs: 1, askBeforePr: false }), clients })
  engine.boot()
  engine.voiceGoal('Add a checkout flow to the shop', 8)
  engine.handleAction('start_planning')
  await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'plan' && e.currentView.scene.utterance.includes('The plan is ready'))
  const plan = engine.currentView.scene
  assert(plan.contextLabel === 'CHECKOUT FLOW' && /^PLANNING · 0 OF \d+$/.test(plan.contextDetail ?? ''),
    'a mission card names the build on the left and the phase with the milestones done on the right')
  assert(Array.isArray(plan.progress?.milestones) && plan.progress.milestones.every((m) => m === 'todo'),
    'the plan card carries one todo mark per milestone')
  assert(validateScene(plan, 'engine').length === 0, 'the redesigned plan card validates')
  engine.handleAction('begin')
  engine.handleAction('use_it')
  const sawRun = await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'running' &&
    e.currentView.scene.actions.map((a) => a.label).join(',') === 'Pause,Message,Milestones')
  assert(sawRun, 'the Run card offers Pause, Message, Milestones')
  {
    // HudRun's own state: 2 done, 1 in review, 1 to go reads BUILDING · 2 OF 4.
    const saved = engine.milestones
    engine.milestones = [
      { id: 'plan', label: 'Plan', weight: 20, status: 'accepted' },
      { id: 'job_0', label: 'Cart', weight: 20, status: 'accepted' },
      { id: 'job_1', label: 'Totals', weight: 20, status: 'accepted' },
      { id: 'job_2', label: 'Payment', weight: 20, status: 'submitted' },
      { id: 'pr', label: 'PR', weight: 20, status: 'pending' },
    ]
    const savedPhase = engine.phase
    const savedPaused = engine.paused
    engine.phase = 'building'
    engine.paused = false
    assert(engine.hudContextDetail('running') === 'BUILDING · 2 OF 4',
      'the engine’s context detail for 2 done, 1 in review, 1 to go is BUILDING · 2 OF 4 (HudRun)')
    engine.milestones = saved
    engine.phase = savedPhase
    engine.paused = savedPaused
  }
  assert(await drive(engine, (e) => e.currentView.type === 'scene' && e.currentView.scene.kind === 'final'), 'the mission reaches Done')
  const done = engine.currentView.scene
  assert(done.utterance === 'Checkout flow is ready for you to review.' && done.status === 'All checks passed · pull request open',
    'the Done card says the build is ready to review and that the checks passed with a pull request open')
  assert(done.contextDetail === 'DONE' && done.progress?.milestones?.every((m) => m === 'done'), 'the Done card reads DONE with every milestone done')
  assert(done.actions.map((a) => `${a.id}:${a.label}`).join(',') === 'chat:Read summary,restart:Next idea,show_evidence:Evidence',
    'the Done card offers Read summary, Next idea, Evidence')
  assert(done.spritePose === 'celebrate', 'the build landing celebrates (MotionLab)')
  assert(validateScene(done, 'engine').length === 0, 'the Done card validates')
}

if (failures > 0) {
  console.log(`REAL ENGINE TEST FAILED: ${failures} failures`)
  process.exit(1)
}
console.log('REAL ENGINE TEST PASSED: plan, 3 mixed workers, reviews, repair loop, integration, PR gate, projects home, resume, live configure, cloud builds home, watch + attach, computer resolve + prompt, phone surface (say, listBuilds, openBuild), new-repo missions, blocked-start resume, fault Retry, mid-spawn resume, mid-mission steering, blip recovery, launch blips fault never park, stale-async inert after reset/restore, gate honesty, restore fidelity (seq, paused, integration branches, corrupt rows), ordered queued lead turns')
