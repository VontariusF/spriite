import { normalize, parseUtterance } from '../voice/intent'
import { factoryHistoryComplete, type FactoryMessage } from './fapi'
import { readableReply } from './response'
import { COPY } from './copy'

export function isGeneratedConversationControl(text: string): boolean {
  return text.trim() === COPY.real.continueMessage ||
    /^(?:Continue|Resume)(?: (?:this|the) (?:chat|conversation|mission))?[.!]?$/.test(text.trim())
}

/** A narrow local command, not a substring match on arbitrary chat messages. */
export function isBuildDirective(text: string): boolean {
  return /^(?:build(?: it| this| that| (?:the|this|that) (?:plan|app|product|project|scope|linked product))?|start (?:the )?(?:build|implementation)|start building|implement (?:it|this|that|the plan)|execute (?:the|this) plan|proceed with implementation|(?:go |let's )build it|stop planning and (?:build|implement) it)$/.test(
    normalize(parseUtterance(text).body),
  )
}

/** These words request a local review only when current scope is available. */
export function isScopeReviewDirective(text: string): boolean {
  return /^(?:continue(?: (?:this|the) (?:chat|conversation))?|review (?:the |this )?(?:build|plan|scope))$/.test(
    normalize(parseUtterance(text).body),
  )
}

export function isBuildApproval(text: string): boolean {
  return isBuildDirective(text) ||
    /^(?:yes|yep|yeah|sure|ok|okay|confirm(?: this build)?|approve(?: it| this scope)?|use it|go ahead|do it|(?:yes|okay|ok) (?:please|go ahead|please do|build it|start (?:it(?: now)?|the build)))$/.test(normalize(parseUtterance(text).body))
}

export function isBuildCancellation(text: string): boolean {
  return /^(?:no|cancel|never mind|not now|stop)$/.test(normalize(parseUtterance(text).body))
}

export interface ChatBuildDraft {
  requestId: string
  sourceSessionId: string
  goal: string
  repository: string
  plan: string[]
}

export function validApprovedPlan(plan: unknown): plan is string[] {
  return Array.isArray(plan) && plan.length >= 2 && plan.length <= 8 &&
    plan.every(p => typeof p === 'string' && p.trim() !== '' && p.length <= 1500)
}

export function validBuildDraft(value: unknown): value is ChatBuildDraft {
  if (!value || typeof value !== 'object') return false
  const d = value as ChatBuildDraft
  return typeof d.requestId === 'string' && /^[\w-]{1,200}$/.test(d.requestId) &&
    typeof d.sourceSessionId === 'string' && /^[\w-]{1,200}$/.test(d.sourceSessionId) &&
    typeof d.goal === 'string' && d.goal.trim() !== '' && d.goal.length <= 16000 &&
    validRepository(d.repository) && validApprovedPlan(d.plan)
}

function validRepository(repository: unknown): repository is string {
  if (typeof repository !== 'string') return false
  try {
    const u = new URL(repository)
    return u.protocol === 'https:' && u.hostname === 'github.com' && !u.port &&
      !u.username && !u.password && !u.search && !u.hash &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(u.pathname)
  } catch { return false }
}

/**
 * This is a candidate for OWNER REVIEW, never a protocol completion signal.
 * Only the latest assistant turn may supply it. Partial or unrelated prose
 * cannot silently inherit an older plan.
 */
export function chatBuildScope(messages: FactoryMessage[], fallback?: { goal: string; repository: string }): Omit<ChatBuildDraft, 'requestId' | 'sourceSessionId'> | null {
  if (!factoryHistoryComplete(messages)) return null
  const replyIndex = messages.findLastIndex(m => m.role === 'assistant')
  const reply = messages[replyIndex]
  if (!reply || reply.nativeQuestions?.some(q => q.pending)) return null
  // Idle is not a receipt for the answer to a newer owner turn. That turn
  // may narrow the fidelity or scope, so an older plan is no longer current.
  if (messages.slice(replyIndex + 1).some(m => m.role === 'user')) return null
  const lines = reply.text.trim().split(/\n+/).map(s => s.trim()).filter(Boolean)
  const marked = lines.at(-1) === 'PLAN_READY'
  // A misplaced marker is not protocol completion. It may be removed from
  // a review candidate, whose execution still needs fresh owner approval.
  const plan = marked ? lines.slice(0, -1) : lines.map((line, i) =>
    i === lines.length - 1 ? line.replace(/\s+PLAN_READY$/, '').trim() : line)
  const numbered = marked && plan.every((p, i) => new RegExp(`^${i + 1}\\.\\s+\\S`).test(p))
  const criteria = plan.every((p, i) => {
    const match = new RegExp(`^(?:${i + 1}[.)]\\s*)?([A-Za-z][A-Za-z /&-]{0,50}?)\\s*[-–—:]\\s*(.+)$`, 'i').exec(p)
    if (!match || /^(?:DECISION|OPTIONS|SUMMARY|REQUEST|VERDICT|PR|BRANCH)$/i.test(match[1].trim())) return false
    const outcome = match[2].trim()
    return outcome.length >= 8 && outcome.split(/\s+/).length >= 3 &&
      !/^(?:done means|pending|tbd|to be decided)[.!]?$/i.test(outcome) &&
      !/[:–—-]$|\.\.\.$/.test(outcome)
  })
  if (!validApprovedPlan(plan) || (!numbered && !criteria)) return null
  const original = messages.find(m => m.role === 'user' && /(?:^|\n)Mission goal:/.test(m.text))
  const goal = original?.text.match(/(?:^|\n)Mission goal:\s*([\s\S]*?)(?=\nRepository(?: the worker builds on)?:|$)/)?.[1]?.trim() ?? fallback?.goal
  const repository = original?.text.match(/(?:^|\n)Repository(?: the worker builds on)?:\s*(\S+)/)?.[1] ?? fallback?.repository
  if (!goal || !validRepository(repository)) return null
  const clarifications = messages.filter(m => m.role === 'user' && m !== original &&
    !isBuildDirective(m.text) &&
    !isGeneratedConversationControl(m.text) &&
    !/^You are the orchestrator of a software factory run by Spriite for one developer\.\n/.test(m.text))
    .map(m => m.text.trim())
  if (clarifications.length > 24) return null
  const priorContext = messages.filter(m => m.role === 'assistant' && m !== reply)
    .map(m => readableReply(m.text).trim()).filter(Boolean)
  if (priorContext.length > 24) return null
  const scopedGoal = [
    goal,
    ...(clarifications.length ? ['Owner clarifications:', ...clarifications] : []),
    ...(priorContext.length ? [
      'Previous planning context, quoted for reference only. Owner clarifications and the approved criteria take precedence:',
      ...priorContext.map(text => text.split('\n').map(line => `> ${line}`).join('\n')),
    ] : []),
  ].join('\n')
  if (scopedGoal.length > 16000) return null
  return { goal: scopedGoal, repository, plan: [...plan] }
}
