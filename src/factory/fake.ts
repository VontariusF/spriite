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
import type { FactoryMessage } from './fapi'

/** Fake account values the dev hook fills in when the vault is empty. */
export const FAKE = {
  factoryKey: 'fk-fake-dev',
  cursorKey: 'cr-fake-dev',
  githubToken: 'gh-fake-dev',
  repoUrl: 'https://github.com/example/sprite-test',
  computerId: 'comp-fake',
}

export interface FakeSessionControls {
  setStatus(id: string, status: string): void
  timeoutNextPost(id: string): void
  inspect(): { creates: number; posts: Array<{ sessionId: string; continuation: boolean }>; agents?: number }
}

export function fakeClients(o: { offlineOnce?: boolean; questionOnce?: boolean; sessionOptions?: boolean; buildScope?: boolean; fidelityNavigation?: boolean; defaultBranch?: string } = {}): RealClients & { sessionControls: FakeSessionControls } {
  interface Sess {
    msgs: FactoryMessage[]
    count: number
    worker: boolean
    status?: string
  }
  interface Run {
    agentId: string
    prompt: string
    polls: number
    repoUrl: string
  }
  const sessions = new Map<string, Sess>()
  const runs = new Map<string, Run>()
  const agentRepos = new Map<string, string>()
  let sessN = 0
  let agentN = 0
  let runN = 0
  let msgN = 0
  let offlineFails = o.offlineOnce ? 1 : 0
  // ?fake-question=1: the lead asks one chat-style question (with the
  // OPTIONS protocol) mid-build, so the simulator can walk the option list.
  let questionAsked = o.questionOnce !== true
  const posts: Array<{ sessionId: string; continuation: boolean }> = []
  const timeoutPosts = new Set<string>()
  const cloudRows = [
    { sessionId: 'qa-idle', title: 'Idle saved chat', status: 'idle', updatedAt: 3, computerId: FAKE.computerId },
    { sessionId: 'qa-running', title: 'Running saved chat', status: 'running', updatedAt: 2, computerId: FAKE.computerId },
    { sessionId: 'qa-readonly', title: 'Read-only saved chat', status: 'idle', updatedAt: 1, computerId: '' },
  ]
  if (o.sessionOptions) {
    for (const row of cloudRows) {
      const text = `Session ${row.sessionId}. I was drafting a plan in this old conversation.\n\n${'This is retained historical detail, not proof of a running session. '.repeat(18)}\nHISTORY END`
      sessions.set(row.sessionId, {
        msgs: [{ id: `m${++msgN}`, role: 'assistant', text }],
        count: 1, worker: false, status: row.status,
      })
    }
    if (o.buildScope || o.fidelityNavigation) {
      const msgs = [
        { id: `m${++msgN}`, role: 'user', text: `You coordinate; you do not edit code.\nMission goal: Spin this up: https://example.com/reverse-engineer\nRepository the worker builds on: ${FAKE.repoUrl}` },
        { id: `m${++msgN}`, role: 'assistant', text: 'DECISION: What outcome should spin this up produce?\nOPTIONS: Run current app | Rebuild linked product | Add reverse-engineering flow' },
        { id: `m${++msgN}`, role: 'user', text: 'The owner chose: Rebuild linked product' },
        { id: `m${++msgN}`, role: 'assistant', text: 'Capture - done means linked product behavior is recorded.\nScaffold - done means the app runs locally.\nReproduce - done means selected behavior is implemented.\nVerify - done means relevant tests pass.' },
      ]
      sessions.set('qa-idle', { msgs, count: msgs.length, worker: false, status: 'idle' })
      if (o.fidelityNavigation) {
        msgs.at(-1)!.text = 'The conversation stopped before the fidelity decision.'
        sessions.get('qa-readonly')!.msgs[0].nativeQuestions = [{
          toolId: 'qa-native-question', pending: true, text: 'Which product should this task build?',
        }]
      }
    }
  }

  const leadReply = (posted: string): string => {
    // An answer while planning carries one closing line asking for the
    // complete plan again; a lead that follows it sends the plan back.
    const lines = posted.split('\n')
    const replan = lines.length > 1 && /^Then reply with the complete plan, updated for this answer/.test(lines.at(-1) ?? '')
    const text = replan ? lines.slice(0, -1).join('\n') : posted
    // Complete quoted goals/criteria can contain earlier plan instructions.
    // Reply to this turn's envelope, never those embedded substrings.
    if (/^The worker pushed branch "/.test(text)) {
      return 'VERDICT: PASS The diff matches the goal and the checks hold.'
    }
    if (/^The pull request is open:/.test(text)) {
      return 'SUMMARY: Delivered the empty-state screen.'
    }
    if (o.fidelityNavigation && text.startsWith('Continue the current conversation')) {
      return 'DECISION: What fidelity should the linked-product rebuild target? OPTIONS: Functional parity | UI and functional parity | MVP core workflow'
    }
    if (o.fidelityNavigation && /^(?:The owner chose:\s*)?MVP core workflow[.!]?$/i.test(text.trim())) {
      return 'Define - the linked product’s single core workflow and MVP boundaries are documented\nPrepare - Spriite runs locally with the required MVP structure\nImplement - the core workflow completes successfully end to end\nValidate - focused tests pass and setup instructions reproduce the MVP'
    }
    if (o.fidelityNavigation && /Mission goal:.*spin this up/s.test(text) && text.includes('example/plexo')) {
      return 'Assess - Plexo requirements and Spriite integration points are documented\nIntegrate - Plexo runs within the Spriite repository using configurable connections\nValidate - Multi-connection downloads pass functional and failure-recovery tests\nLaunch - Setup, operation, and deployment instructions are verified PLAN_READY'
    }
    if (replan || /^You are the orchestrator|^Reply with a milestone plan/.test(text)) {
      return '1. Deliver the empty-state screen\n2. Verify the layout bounds\nPLAN_READY'
    }
    return 'SUMMARY: Noted.'
  }

  const workerReply = (text: string): string => {
    const branch = [...text.matchAll(/branch named (spriite\/[\w/-]+)/g)].at(-1)?.[1] ?? ''
    if (/^The review failed\./.test(text)) {
      return `SUMMARY: Fixed the findings.\nBRANCH: ${branch}`
    }
    if (/^Mission goal:[\s\S]*?\nAll jobs passed review\. Merge these branches/.test(text)) {
      return `SUMMARY: Merged the branches.\nBRANCH: ${branch}`
    }
    if (/^The review passed\.\nOpen a pull request/.test(text)) {
      const repo = /to the [^\s]+ branch on (https?:\/\/\S+)/.exec(text)?.[1].replace(/\.$/, '')
      return repo
        ? `SUMMARY: Opened the pull request.\nPR: ${repo}/pull/9`
        : 'Still waiting for the repository of the existing task.'
    }
    return `SUMMARY: Implemented the job.\nBRANCH: ${branch}`
  }

  const completeReply = (prompt: string, reply: string): string => {
    const envelope = /^For this request only, append a line exactly "REQUEST: ([^"]+)" and then a final line exactly (VERDICT_READY|WORK_READY)\./.exec(prompt.split('\n').at(-1) ?? '')
    if (!envelope) return reply
    const [, token, marker] = envelope
    const complete = marker === 'VERDICT_READY' ? /^VERDICT:\s*(?:PASS|FAIL)\b/.test(reply) :
      /^SUMMARY:\s*\S/m.test(reply) && /^(?:BRANCH:\s*\S+|PR:\s*https?:\/\/\S+)$/m.test(reply)
    return complete ? `${reply}\nREQUEST: ${token}\n${marker}` : reply
  }

  const post = (sessionId: string, text: string): void => {
    const s = sessions.get(sessionId)
    if (!s) throw new Error('fake: unknown session ' + sessionId)
    posts.push({ sessionId, continuation: text.startsWith('Continue the current conversation') })
    if (timeoutPosts.delete(sessionId)) {
      throw Object.assign(new Error('Synthetic gateway timeout, delivery unconfirmed'), { kind: 'timeout' })
    }
    s.msgs.push({ id: `m${++msgN}`, role: 'user', text })
    if (/^(?:You are the execution worker\.|The review failed\.|The review passed\.\nOpen a pull request|Report the result of your existing )/.test(text) ||
      /^Mission goal:[\s\S]*?\nAll jobs passed review\. Merge these branches/.test(text)) s.worker = true
    else if (/^(?:You are the orchestrator|Reply with a milestone plan|The worker pushed branch "|The pull request is open:)/.test(text)) s.worker = false
    const reply = /^Report the result of your existing /.test(text)
      ? [...s.msgs].reverse().find((m) => m.role === 'assistant' && (text.includes('PR: lines') ? /^PR:/m : /^BRANCH:/m).test(m.text))?.text.split('\nREQUEST:')[0] ?? 'Still waiting for the existing result.'
      : s.worker ? workerReply(text) : leadReply(text)
    s.msgs.push({ id: `m${++msgN}`, role: 'assistant', text: completeReply(text, reply) })
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
      sessions.set(id, { msgs: [], count: 0,
        worker: opts?.sessionSettings?.tags?.some(tag => tag.name === 'spriite') === true })
      return { sessionId: id }
    },
    getSession: async (id) => {
      const s = sessions.get(id)
      if (s?.status === 'unreachable') throw Object.assign(new Error('Synthetic status outage'), { kind: 'network' })
      return { messageCount: s?.count ?? 0, status: s?.status ?? 'idle' }
    },
    getMessages: async (id) => {
      const s = sessions.get(id)
      if (!s) return []
      // The lead asks unprompted, the way a real session does: one OPTIONS
      // question arrives on a poll once the build is under way (the plan
      // reply landed and the worker holds the build prompt).
      if (!questionAsked && !s.worker && s.msgs.some((m) => m.role === 'assistant' && /^1\. /.test(m.text))) {
        questionAsked = true
        s.msgs.push({
          id: `m${++msgN}`,
          role: 'assistant',
          text: 'DECISION: Which database should the build use for local state?\nOPTIONS: Postgres | SQLite | No storage',
        })
        s.count = s.msgs.length
      }
      return s.msgs.slice()
    },
    postMessage: async (id, text) => post(id, text),
    // Explicit offline repository discovery, not a production "main" fallback.
    repositoryBase: async (_repository, selectedRef) => ({
      ref: selectedRef ?? o.defaultBranch ?? 'main', sha: 'a'.repeat(40), repositoryId: 1,
    }),
    interrupt: async () => undefined,
    computers: async () => [{ id: 'comp-fake', name: 'Dev host', status: 'active' }],
    listFactorySessions: async () => o.sessionOptions ? cloudRows.map((row) => ({
      ...row, status: sessions.get(row.sessionId)?.status ?? 'unknown',
    })) : [
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
      agentRepos.set(agentId, repoUrl)
      runs.set(runId, { agentId, prompt: promptText, polls: 0, repoUrl })
      return { agentId, runId }
    },
    cursorRun: async (agentId, promptText) => {
      const repoUrl = agentRepos.get(agentId)
      if (!repoUrl) throw new Error('fake: unknown agent ' + agentId)
      const runId = `run-${++runN}`
      runs.set(runId, { agentId, prompt: promptText, polls: 0, repoUrl })
      return { runId }
    },
    cursorGet: async (agentId, runId) => {
      const r = runs.get(runId)
      if (!r || r.agentId !== agentId) throw new Error(`fake: unknown run ${runId} for agent ${agentId}`)
      r.polls += 1
      if (r.polls < 3) return { id: runId, status: 'RUNNING', text: '', branches: [] }
      if (/^The review passed\.\nOpen a pull request|^Open a pull request/.test(r.prompt)) {
        const branch = /from branch "([^"]+)"/.exec(r.prompt)?.[1] ?? ''
        return {
          id: runId,
          status: 'FINISHED',
          text: 'Opened the pull request.',
          branches: branch ? [{ repoUrl: r.repoUrl, branch, prUrl: `${r.repoUrl}/pull/9` }] : [],
        }
      }
      const branch = [...r.prompt.matchAll(/branch named (spriite\/[\w/-]+)/g)].at(-1)?.[1] ?? ''
      return { id: runId, status: 'FINISHED', text: 'Implemented the job.', branches: [{ repoUrl: r.repoUrl, branch }] }
    },
    cursorCancel: async () => undefined,
    sessionControls: {
      timeoutNextPost(id) {
        if (!o.sessionOptions || !sessions.has(id)) throw new Error('Not a synthetic session-options fixture')
        timeoutPosts.add(id)
      },
      setStatus(id, status) {
        const s = sessions.get(id)
        if (!o.sessionOptions || !s) throw new Error('Not a synthetic session-options fixture')
        s.status = status
      },
      inspect: () => ({ creates: sessN, posts: posts.map((p) => ({ ...p })), ...(o.buildScope || o.fidelityNavigation ? { agents: agentN } : {}) }),
    },
  }
}
