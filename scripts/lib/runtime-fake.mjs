/**
 * Shared scripted-provider test harness for the durable runtime suites
 * (test-runtime.mjs, test-briefing.mjs).
 *
 * In-memory KV whose map survives a "crash" (rebuild the store over the same
 * TestKV and you get the previous generation's world), a provider that
 * plays the full plan → review → milestone → PR script per prompt text, and
 * a supervisor factory over a virtual clock. No network, no bridge, no
 * simulator.
 */
import { sha256Hex } from '../../src/state/mission-store.ts'
import { createRuntimeStore } from '../../src/state/runtime-store.ts'
import { Supervisor } from '../../src/runtime/supervisor.ts'

export const REPO = 'https://github.com/example/sprite-test'

export const sleep = () => new Promise((r) => setTimeout(r, 0))

/**
 * Provider work runs outside the actor's commit chain (the engine awaits its
 * own promises), so a test that asserts on outbox state has to let those
 * macrotasks finish before reading.
 */
export async function quiesce(turns = 12) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 1))
}

export async function settleAll(ctx) {
  await ctx.supervisor.flush()
  await quiesce()
  await ctx.supervisor.flush()
}

/** In-memory KV with failure injection; the same map survives a "crash". */
export class TestKV {
  constructor(map = new Map()) {
    this.map = map
    this.failNextSets = 0
  }

  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null
  }

  async set(key, value) {
    if (this.failNextSets > 0) {
      this.failNextSets--
      return false
    }
    this.map.set(key, value)
    return true
  }
}

/**
 * The production store wiring, including the briefing hold-back: events
 * above the owner's coverage watermark are never compacted away (spec §9).
 */
export function newStore(kv, opts = {}) {
  return createRuntimeStore(kv, opts)
}

/**
 * Scripted provider: the lead plans, reviews, and summarises; a Factory
 * worker session reports a branch and then a PR. Counters are what the tests
 * assert against, because "how many sessions did we create" is the question
 * that matters for every crash case.
 */
export function makeClients(opts = {}) {
  const sessions = new Map()
  const runs = new Map()
  const counts = {
    createSession: 0,
    getSession: 0,
    postMessage: 0,
    interrupt: 0,
    cursorAgent: 0,
    cursorRun: 0,
    cursorGet: 0,
    cursorCancel: 0,
    createRepo: 0,
    findRepo: 0,
  }
  let sessN = 0
  let agentN = 0
  let runN = 0
  let msgN = 0
  /**
   * Every createRepo the scripted provider actually landed, in order. This
   * array IS the model of GitHub's own durable state, so a relaunch test
   * must pass ONE array (`opts.repos`) to every generation's clients: the
   * repository a dead process created upstream outlives that process, and a
   * fresh clients instance with an empty registry would model a GitHub that
   * forgot it.
   */
  const createdRepos = opts.repos ?? []
  /** Every createSession/createWorkerSession body's settings, in order. */
  const createdSettings = []
  let planQuestionAsked = false
  let transportFailUsed = 0
  const interruptResolvers = []

  const leadReply = (text) => {
    if (/grouping the goal into jobs/.test(text)) return '1. Job one\n2. Job two\nPLAN_READY'
    if (/Reply with a milestone plan/.test(text)) {
      if (opts.planQuestion && !planQuestionAsked) {
        planQuestionAsked = true
        return opts.planQuestion
      }
      return '1. Deliver the empty-state screen - done means the layout is verified\n2. Verify the bounds - done means the checks pass\nPLAN_READY'
    }
    if (planQuestionAsked && /^The owner chose:/.test(text)) {
      return '1. Deliver the empty-state screen - done means the layout is verified\n2. Verify the bounds - done means the checks pass\nPLAN_READY'
    }
    if (/VERDICT: PASS or VERDICT: FAIL/.test(text)) return 'VERDICT: PASS The diff matches the goal.'
    if (/Reply with SUMMARY: one sentence/.test(text)) return 'SUMMARY: Delivered the empty-state screen.'
    return 'SUMMARY: Noted.'
  }

  const workerReply = (text) => {
    const branch = /branch named (spriite\/[\w/-]+)/.exec(text)?.[1] ?? ''
    if (/Fix the findings/.test(text)) return `SUMMARY: Fixed the findings.\nBRANCH: ${branch}`
    if (/Merge these branches/.test(text)) return `SUMMARY: Merged the branches.\nBRANCH: ${branch}`
    if (/Open a pull request/.test(text)) {
      return `SUMMARY: Opened the pull request.\nPR: ${REPO}/pull/9`
    }
    return `SUMMARY: Implemented the job.\nBRANCH: ${branch}`
  }

  /**
   * Role by PROMPT, not by session order: the lead is asked for plans,
   * verdicts, and summaries; workers are asked for branches, fixes, merges,
   * and PRs. A second mission's lead session is a lead no matter how many
   * sessions came before it (per-mission typing, not a global counter).
   */
  const isLeadPrompt = (text) =>
    !/^You are the execution worker\./.test(text) &&
    /grouping the goal into jobs|milestone plan|VERDICT: PASS or VERDICT: FAIL|SUMMARY: one sentence|^The owner chose:/.test(text)

  const completeReply = (prompt, reply) => {
    const token = /"REQUEST: ([^"]+)"/.exec(prompt)?.[1]
    const marker = /final line exactly (VERDICT_READY|WORK_READY)/.exec(prompt)?.[1]
    return token && marker ? `${reply}\nREQUEST: ${token}\n${marker}` : reply
  }

  const post = (sessionId, text) => {
    const s = sessions.get(sessionId)
    if (!s) throw new Error(`scripted provider: unknown session ${sessionId}`)
    s.msgs.push({ id: `m${++msgN}`, role: 'user', text })
    const reply = /^Report the result of your existing /.test(text)
      ? [...s.msgs].reverse().find((m) => m.role === 'assistant' && (text.includes('PR: lines') ? /^PR:/m : /^BRANCH:/m).test(m.text))?.text.split('\nREQUEST:')[0] ?? 'Still waiting for the existing result.'
      : isLeadPrompt(text) ? leadReply(text) : workerReply(text)
    s.msgs.push({ id: `m${++msgN}`, role: 'assistant', text: completeReply(text, reply) })
    s.count = s.msgs.length
  }

  return {
    counts,
    sessions,
    /** The sessionSettings body of every session created, in order. */
    createdSettings: () => createdSettings,
    createSession: async (createOpts = {}) => {
      counts.createSession += 1
      if (opts.transportFailCreateSession === true && transportFailUsed === 0) {
        // The launch may have landed upstream and the answer never arrived:
        // no `kind`, so the runtime must treat the outcome as unknown.
        transportFailUsed += 1
        throw new Error('fetch failed (no response)')
      }
      if (Array.isArray(opts.createSessionFailures) && opts.createSessionFailures.length > 0) {
        // Realistic provider rejections: every error the fapi/cursor adapters
        // throw carries a `kind`; classification must match those, not a guess.
        throw opts.createSessionFailures.shift()
      }
      const id = `sess-${++sessN}`
      sessions.set(id, { msgs: [], count: 0 })
      createdSettings.push(createOpts?.sessionSettings ?? null)
      return { sessionId: id }
    },
    getSession: async (id) => {
      counts.getSession += 1
      if (Array.isArray(opts.getSessionFailures) && opts.getSessionFailures.length > 0) {
        // A live-observation failure: the session exists, the CHECK failed.
        // Kinded errors mirror the adapters' classifications.
        throw opts.getSessionFailures.shift()
      }
      return { messageCount: sessions.get(id)?.count ?? 0, status: 'idle' }
    },
    getMessages: async (id) => {
      const s = sessions.get(id)
      if (!s) throw new Error(`scripted provider: unknown session ${id}`)
      return s.msgs.slice()
    },
    postMessage: async (id, text) => {
      counts.postMessage += 1
      post(id, text)
    },
    interrupt: async (id) => {
      counts.interrupt += 1
      if (opts.interruptGate === true) {
        // A provider that never answers: the cancellation request hangs until
        // the test resolves it (a mission can outlive its own cancellation).
        await new Promise((resolve) => interruptResolvers.push(resolve))
      }
      if (opts.interruptFails === true) throw new Error('interrupt refused')
      void id
    },
    computers: async () => [{ id: 'comp-1', name: 'Test Mac', status: 'active' }],
    listFactorySessions: async () => [],
    listCursorAgents: async () => [],
    createRepo: async (name, isPrivate) => {
      counts.createRepo += 1
      // `hangRepoCreateAfterLanding` models the response being lost after
      // GitHub actually created the repository: the create landed upstream,
      // the caller never saw it.
      if (opts.hangRepoCreateAfterLanding === true) {
        createdRepos.push({ name, isPrivate })
        await new Promise(() => {})
      }
      // A create that never answers models the process dying mid-create: the
      // mission is durable, the repository is not.
      if (opts.hangRepoCreate === true) await new Promise(() => {})
      createdRepos.push({ name, isPrivate })
      return { url: `https://github.com/example/${name}` }
    },
    /** GitHub's own view: does a repository with this name exist yet? */
    findRepo: async (name) => {
      counts.findRepo += 1
      if (opts.repoLookupFails === true) throw new Error('GitHub unreachable')
      return createdRepos.some((r) => r.name === name) ? { url: `https://github.com/example/${name}` } : null
    },
    cursorAgent: async (promptText, repoUrl) => {
      counts.cursorAgent += 1
      const agentId = `agent-${++agentN}`
      const runId = `run-${++runN}`
      runs.set(runId, { prompt: promptText, polls: 0, repoUrl })
      return { agentId, runId }
    },
    cursorRun: async (_agentId, promptText) => {
      counts.cursorRun += 1
      const runId = `run-${++runN}`
      runs.set(runId, { prompt: promptText, polls: 0, repoUrl: REPO })
      return { runId }
    },
    cursorGet: async (_agentId, runId) => {
      counts.cursorGet += 1
      const r = runs.get(runId)
      if (!r) throw new Error(`scripted provider: unknown run ${runId}`)
      r.polls += 1
      if (r.polls < 3) return { id: runId, status: 'RUNNING', text: '', branches: [] }
      if (/Open a pull request/.test(r.prompt)) {
        return {
          id: runId,
          status: 'FINISHED',
          text: 'Opened the pull request.',
          branches: [{ repoUrl: r.repoUrl, branch: 'spriite/job-1', prUrl: `${REPO}/pull/9` }],
        }
      }
      const branch = /branch named (spriite\/[\w/-]+)/.exec(r.prompt)?.[1] ?? ''
      return { id: runId, status: 'FINISHED', text: 'Implemented the job.', branches: [{ repoUrl: r.repoUrl, branch }] }
    },
    cursorCancel: async () => {
      counts.cursorCancel += 1
    },
    /** Resolvers for hanging interrupt requests (opts.interruptGate). */
    releaseInterrupts() {
      for (const resolve of interruptResolvers.splice(0)) resolve()
    },
    /** The repositories createRepo was asked for (name + privacy). */
    repoCreated: () => createdRepos,
  }
}

export const SETTINGS = {
  factoryKey: 'fk-test',
  cursorKey: 'cr-test',
  githubToken: 'gh-test',
  computerId: 'comp-1',
  workerPref: 'factory',
  jobs: 1,
  askBeforePr: false,
  model: '',
  reasoningEffort: '',
  autonomyLevel: '',
  repository: REPO,
  baseRef: 'main',
}

/** One supervisor over a shared KV; `clock` drives the virtual time. */
/** The store the runtime is wired to; a suite may narrow the event window
 *  (`eventWindow`/`maxEventWindow`) to exercise compaction and the gap. */
export function makeRuntime(kv, clients, opts = {}) {
  const views = []
  const clock = { now: 0 }
  const supervisor = new Supervisor({
    store: newStore(kv, { eventWindow: opts.eventWindow, maxEventWindow: opts.maxEventWindow }),
    kv,
    clients,
    settings: () => ({ ...SETTINGS, ...(opts.settings ?? {}) }),
    policy: opts.policy,
    maxConcurrentWorkers: opts.capacity ?? 4,
    emitView: (missionId, view) => views.push({ missionId, view }),
    now: () => clock.now,
    snapshotDebounceMs: opts.snapshotDebounceMs ?? 1500,
  })
  return { supervisor, views, clock }
}

export function cmd(text, dedupeKey) {
  return { text, source: 'phone_text', sourceEventId: `evt-${dedupeKey}`, dedupeKey }
}

export function mission(ctx, id) {
  return ctx.supervisor.missions.find((m) => m.missionId === id)
}

export function snapshotOf(ctx, id) {
  return ctx.supervisor.actor(id)?.snapshot ?? null
}

/** Tick until the predicate holds (or the virtual budget runs out). */
export async function drive(ctx, until, maxMs = 60000, step = 500) {
  const start = ctx.clock.now
  for (let t = start; t <= start + maxMs; t += step) {
    ctx.clock.now = t
    ctx.supervisor.tick(t)
    await sleep()
    if (until()) {
      await ctx.supervisor.flush()
      return true
    }
  }
  await ctx.supervisor.flush()
  return false
}

/** Tick a fixed span without asserting anything. */
export async function settle(ctx, ms = 6000, step = 500) {
  await drive(ctx, () => false, ms, step)
}

/**
 * Simulate the crash window between "the provider confirmed the launch" and
 * "the engine snapshot became durable": the newest checkpoint is rewritten
 * without engineSnapshots, keeping it valid (checksum recomputed exactly as
 * the store does).
 */
export async function forgetEngineSnapshots(kv) {
  let best = null
  for (const slot of ['a', 'b']) {
    const manifest = await kv.get(`spriite.runtime.v2.slot.${slot}.m`)
    if (manifest === null) continue
    const m = JSON.parse(manifest)
    if (m.chunks !== 1) throw new Error(`test helper expects a single-chunk envelope, got ${m.chunks}`)
    const raw = await kv.get(`spriite.runtime.v2.slot.${slot}.0`)
    const env = JSON.parse(raw)
    if (best === null || env.seq > best.env.seq) best = { slot, env }
  }
  if (best === null) throw new Error('test helper found no checkpoint')
  delete best.env.state.engineSnapshots
  const checksum = best.env.checksum
  delete best.env.checksum
  best.env.checksum = await sha256Hex(JSON.stringify(best.env))
  void checksum
  await kv.set(`spriite.runtime.v2.slot.${best.slot}.0`, JSON.stringify(best.env))
}

export function eventsOf(ctx, type) {
  return ctx.supervisor.missionStore.events.filter((e) => e.type === type)
}

/** A simple pass/fail tally for suites that don't need sections. */
export function makeTally() {
  let failures = 0
  const assert = (ok, label) => {
    if (ok) console.log('  PASS:', label)
    else {
      failures++
      console.log('  FAIL:', label)
    }
  }
  return { assert, failures: () => failures }
}
