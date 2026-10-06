/**
 * Dev-only scripted API clients (?fake=1 in main.ts). They let the simulator
 * walk every real-engine card end to end with zero keys, zero network, and
 * zero credits: the lead session plans, reviews, and answers; the worker
 * (a Cursor agent, matching the default "auto" preference) pushes a branch
 * and opens the pull request.
 *
 * This module is only ever dynamically imported behind import.meta.env.DEV,
 * so production builds exclude it, and it never calls a real service. The
 * scripted replies follow the same strict protocol the engine parses.
 */
import type { RealClients } from './real'

/** Fake account values the dev hook fills in when the vault is empty. */
export const FAKE = {
  factoryKey: 'fk-fake-dev',
  cursorKey: 'cr-fake-dev',
  githubToken: 'gh-fake-dev',
  repoUrl: 'https://github.com/example/sprite-test',
  computerId: 'comp-fake',
}

export function fakeClients(o: { offlineOnce?: boolean } = {}): RealClients {
  interface Sess {
    msgs: Array<{ id: string; role: string; text: string }>
    count: number
    worker: boolean
  }
  interface Run {
    prompt: string
    polls: number
    repoUrl: string
  }
  const sessions = new Map<string, Sess>()
  const runs = new Map<string, Run>()
  let sessN = 0
  let agentN = 0
  let runN = 0
  let msgN = 0
  let offlineFails = o.offlineOnce ? 1 : 0

  const leadReply = (text: string): string => {
    if (/Reply with a milestone plan|grouping the goal into jobs/.test(text)) {
      return '1. Deliver the empty-state screen\n2. Verify the layout bounds'
    }
    if (/VERDICT: PASS or VERDICT: FAIL/.test(text)) {
      return 'VERDICT: PASS The diff matches the goal and the checks hold.'
    }
    if (/Reply with SUMMARY: one sentence/.test(text)) {
      return 'SUMMARY: Delivered the empty-state screen.'
    }
    return 'SUMMARY: Noted.'
  }

  const workerReply = (text: string): string => {
    const branch = /branch named (spriite\/job-\d+)/.exec(text)?.[1] ?? 'spriite/job-1'
    if (/Fix the findings/.test(text)) {
      return `SUMMARY: Fixed the findings.\nBRANCH: ${branch}`
    }
    if (/Merge these branches/.test(text)) {
      return 'SUMMARY: Merged the branches.\nBRANCH: spriite/integration'
    }
    if (/Open a pull request/.test(text)) {
      return 'SUMMARY: Opened the pull request.\nPR: https://github.com/example/sprite-test/pull/9'
    }
    return `SUMMARY: Implemented the job.\nBRANCH: ${branch}`
  }

  const post = (sessionId: string, text: string): void => {
    const s = sessions.get(sessionId)
    if (!s) throw new Error('fake: unknown session ' + sessionId)
    s.msgs.push({ id: `m${++msgN}`, role: 'user', text })
    const reply = s.worker ? workerReply(text) : leadReply(text)
    s.msgs.push({ id: `m${++msgN}`, role: 'assistant', text: reply })
    s.count = s.msgs.length
  }

  return {
    createSession: async (opts) => {
      if (offlineFails > 0) {
        offlineFails -= 1
        // What Factory answers when the mission's computer daemon is down.
        const e = new Error('Factory could not reach the computer (failed to connect to computer daemon)')
        ;(e as Error & { kind: string }).kind = 'offline'
        throw e
      }
      const id = `sess-${++sessN}`
      sessions.set(id, { msgs: [], count: 0, worker: sessN > 1 })
      void opts
      return { sessionId: id }
    },
    getSession: async (id) => ({ messageCount: sessions.get(id)?.count ?? 0, status: 'idle' }),
    getMessages: async (id) => sessions.get(id)?.msgs.slice() ?? [],
    postMessage: async (id, text) => post(id, text),
    interrupt: async () => undefined,
    computers: async () => [{ id: 'comp-fake', name: 'Dev Mac', status: 'active' }],
    listFactorySessions: async () => [
      {
        sessionId: 'sess-fake-cloud',
        title: 'Fix the login flake (cloud build)',
        status: 'running',
        updatedAt: 1, // oldest: local missions list first on the home

        computerId: 'comp-fake',
      },
    ],
    listCursorAgents: async () => [],
    createRepo: async (name, isPrivate) => {
      void isPrivate
      return { url: `https://github.com/example/${name}` }
    },
    cursorAgent: async (promptText, repoUrl) => {
      const agentId = `agent-${++agentN}`
      const runId = `run-${++runN}`
      runs.set(runId, { prompt: promptText, polls: 0, repoUrl })
      return { agentId, runId }
    },
    cursorRun: async (_agentId, promptText) => {
      const runId = `run-${++runN}`
      runs.set(runId, { prompt: promptText, polls: 0, repoUrl: FAKE.repoUrl })
      return { runId }
    },
    cursorGet: async (agentId, runId) => {
      const r = runs.get(runId)
      if (!r) throw new Error('fake: unknown run ' + runId)
      r.polls += 1
      if (r.polls < 3) return { id: runId, status: 'RUNNING', text: '', branches: [] }
      if (/Open a pull request/.test(r.prompt)) {
        return {
          id: runId,
          status: 'FINISHED',
          text: 'Opened the pull request.',
          branches: [{ repoUrl: r.repoUrl, branch: 'spriite/job-1', prUrl: `${FAKE.repoUrl}/pull/9` }],
        }
      }
      const branch = /branch named (spriite\/job-\d+)/.exec(r.prompt)?.[1] ?? 'spriite/job-1'
      void agentId
      return { id: runId, status: 'FINISHED', text: 'Implemented the job.', branches: [{ repoUrl: r.repoUrl, branch }] }
    },
    cursorCancel: async () => undefined,
  }
}
