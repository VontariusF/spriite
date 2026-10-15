/** Offline development fixture. Imported only behind import.meta.env.DEV.
 * It never creates a session, repository, branch, SDK process or network call. */
import type {
  NativeAttention, NativeBrokerClient, NativeCapabilities, NativeCommand,
  NativeCommandReceipt, NativeDeliveryState, NativeFeature, NativeIntent, NativePolicy, NativeSnapshot,
} from '../native/protocol'

const CAPS: NativeCapabilities = {
  protocolVersion: 1, qualificationId: 'offline-fixture-only',
  transportVersion: 'fixture-not-provider', qualified: true, launch: true,
  rootAttention: true, childAttention: true, recoverAttention: true,
  pause: false, resume: false, cancel: false,
}
const option = (id: string, label: string, value = id) => ({ id, label, value })
const copy = <T>(v: T): T => structuredClone(v)

/**
 * `v1`: proposal → separate start → root permission + child questionnaire.
 * `v2`: Factory Mission v2 as the broker projects it: recommend permission →
 * plan proposal whose approval also starts the run (no start request) →
 * worker progress and check evaluations (one unmet, later met) → completed.
 */
export type NativeFixtureDialect = 'v1' | 'v2'
/** Simulator selection: `?fake-native=v2`; any other value keeps v1. */
export function nativeFixtureDialectFromLocation(): NativeFixtureDialect {
  const search = (globalThis as { location?: { search?: string } }).location?.search ?? ''
  return new URLSearchParams(search).get('fake-native') === 'v2' ? 'v2' : 'v1'
}

const V2_CHECKS: NativeFeature[] = [
  { id: 'badge-renders', milestone: 'build', status: 'pending',
    description: 'The status badge renders on the fixture dashboard.',
    expectedBehavior: ['Open the fixture page and see one badge per build.'] },
  { id: 'tests-pass', milestone: 'quality', status: 'pending',
    description: 'The fixture unit tests pass.', expectedBehavior: ['Run the fixture test command.'] },
  { id: 'docs-updated', milestone: 'quality', status: 'pending',
    description: 'The README documents the badge.', expectedBehavior: [] },
]
const V2_PLAN = [
  'OFFLINE FIXTURE PLAN. This exercises Spriite projections, not Factory execution.',
  'Goal: add a build status badge to the fixture dashboard without changing any other page.',
  'Approach: one worker adds the badge component, wires it into the dashboard header, and updates the tests. ' +
    'A second worker pass fixes anything the first check evaluation reports as unmet. The orchestrator ' +
    'evaluates every check after each worker finishes and records the outcome.',
  ...Array.from({ length: 6 }, (_, i) => `Step ${i + 1}: ${[
    'Read the dashboard header and the existing status types.',
    'Add a badge component with pending, running, passed and failed variants.',
    'Render the badge for each build row in the dashboard header.',
    'Add unit tests for every badge variant and the empty state.',
    'Document the badge and its colours in the README.',
    'Run the full fixture test command and record the evidence.',
  ][i]}`),
  'Validation strategy: every check below is evaluated by the orchestrator from recorded evidence. ' +
    'An unmet check sends work back to a worker; the Mission completes only when every check is met or waived.',
  'Checks:',
  ...V2_CHECKS.map(c => `- [${c.milestone}] ${c.id}: ${c.description}${c.expectedBehavior[0] ? ` How: ${c.expectedBehavior[0]}` : ''}`),
].join('\n\n')
/** Observations a v2 auto-advancing stage stays visible, so a capture can land on it. */
const V2_DWELL = 4
const FIXTURE_HEAD = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c'
/**
 * Fake broker delivery after completion, only within the job's policy:
 * v1 opens a PR, checks pass 1/3 → 2/3 → 3/3, then merged; v2 pushes and
 * stops at not_merged because the fixture repository has no checks.
 */
type DeliveryStep = Omit<NativeDeliveryState, 'branch' | 'headSha' | 'updatedAt'>
const PR = { prUrl: 'https://github.com/example/fixture/pull/7', prNumber: 7 }
const V1_DELIVERY: DeliveryStep[] = [
  { step: 'pr_open', ...PR, checks: { total: 3, passed: 1, failed: 0, pending: 2 } },
  { step: 'checks_pending', ...PR, checks: { total: 3, passed: 2, failed: 0, pending: 1 } },
  { step: 'merged', ...PR, checks: { total: 3, passed: 3, failed: 0, pending: 0 } },
]
const V2_DELIVERY: DeliveryStep[] = [
  { step: 'pushed' },
  { step: 'pr_open', ...PR, checks: { total: 0, passed: 0, failed: 0, pending: 0 } },
  { step: 'not_merged', ...PR, checks: { total: 0, passed: 0, failed: 0, pending: 0 }, reason: 'No checks configured' },
]

export function nativeFixtureClient(dialect: NativeFixtureDialect = nativeFixtureDialectFromLocation()): NativeBrokerClient {
  const jobs = new Map<string, NativeSnapshot>()
  const pending = new Map<string, NativeCommand[]>()
  const v2Stage = new Map<string, { stage: number; dwell: number }>()
  const policies = new Map<string, NativePolicy>()
  const delivery = new Map<string, { stage: number; dwell: number }>()
  const advanceDelivery = (job: NativeSnapshot): void => {
    const policy = policies.get(job.missionId)
    if (job.state !== 'completed' || !policy?.allowPush || !policy.allowPr) return
    const run = delivery.get(job.missionId) ?? { stage: 0, dwell: V2_DWELL - 1 }
    delivery.set(job.missionId, run)
    if (++run.dwell < V2_DWELL) return
    run.dwell = 0
    const steps = dialect === 'v2' ? V2_DELIVERY : V1_DELIVERY
    const step = steps[run.stage]
    if (!step || (step.step === 'merged' && !policy.allowMerge)) return
    run.stage++
    job.brokerSeq++
    job.delivery = { ...copy(step), branch: `spriite/${job.missionId}`, headSha: FIXTURE_HEAD, updatedAt: new Date().toISOString() }
    if (run.stage === steps.length) job.usage = dialect === 'v2' ? { state: 'unavailable' } : { state: 'pending' }
  }
  const requireJob = (missionId: string, ownerId: string): NativeSnapshot => {
    const job = jobs.get(missionId)
    if (!job || job.ownerId !== ownerId) throw new Error('Offline fixture owner mismatch')
    return job
  }
  const request = (job: NativeSnapshot, kind: NativeAttention['kind'], child = false): NativeAttention => ({
    attentionId: `fixture-${kind}-${job.brokerSeq}`, requestId: `rpc-${kind}-${job.brokerSeq}`,
    sessionId: child ? 'fixture-child' : 'fixture-root', machineId: 'fixture-machine',
    toolUseIds: [`tool-${kind}-${job.brokerSeq}`], associatedSessionIds: ['fixture-root'],
    revision: 1, payloadHash: `payload-${kind}-${job.brokerSeq}`,
    kind, state: 'open', openedAt: new Date().toISOString(), resolvedAt: null,
    title: kind === 'proposal' ? 'Review the offline native plan'
      : kind === 'start' ? 'Start the offline native run'
      : kind === 'permission' ? 'Permission: read repository status' : 'Worker questionnaire',
    details: kind === 'permission' ? 'Medium risk fixture only: git status. No command is executed.'
      : 'OFFLINE FIXTURE. This exercises Spriite projections, not Factory execution.',
    options: kind === 'ask_user' ? [] : [
      option('once', 'Allow this request once', 'proceed_once'), option('cancel', 'Cancel'),
    ],
    questions: kind !== 'ask_user' ? [] : [{
      index: 0, topic: 'Storage', question: 'Which local storage should the fixture use?',
      multiSelect: false, options: [option('sqlite', 'SQLite'), option('files', 'Files')],
    }, {
      index: 1, topic: 'Checks', question: 'Which checks should be included?',
      multiSelect: true, options: [option('unit', 'Unit tests'), option('ui', 'UI checks')],
    }],
  })
  const v2Request = (job: NativeSnapshot, which: 'recommend' | 'plan'): NativeAttention => ({
    attentionId: `fixture-${which}-${job.brokerSeq}`, requestId: `rpc-${which}-${job.brokerSeq}`,
    sessionId: 'fixture-root', machineId: 'fixture-machine',
    toolUseIds: [`tool-${which}-${job.brokerSeq}`], associatedSessionIds: ['fixture-root'],
    revision: 1, payloadHash: `payload-${which}-${job.brokerSeq}`,
    state: 'open', openedAt: new Date().toISOString(), resolvedAt: null, questions: [],
    ...(which === 'recommend' ? {
      kind: 'permission', title: 'Plan as a Factory Mission',
      details: 'OFFLINE FIXTURE. This change touches several files and needs tests, so planning it as a Mission ' +
        'with explicit checks is recommended. No command is executed.',
      options: [option('proceed_once', 'Start Mission planning'), option('cancel', 'Continue normally')],
    } : {
      kind: 'proposal', title: 'Offline fixture: build status badge', details: V2_PLAN,
      options: [option('proceed_once', 'Approve Mission'), option('cancel', 'Request changes')],
    }),
  })
  const progress = (job: NativeSnapshot, text: string): void => {
    job.history.push({ id: `fixture-progress-${job.brokerSeq}-${job.history.length}`, who: 'factory',
      text, at: new Date().toISOString() })
  }
  const evaluate = (job: NativeSnapshot, outcomes: Record<string, NativeFeature['status']>): void => {
    job.features = job.features.map(f => outcomes[f.id] ? { ...f, status: outcomes[f.id] } : f)
    progress(job, `Checks evaluated: ${Object.entries(outcomes)
      .map(([id, status]) => `${id} ${status === 'completed' ? 'met' : status}`).join('; ')}.`)
  }
  const V2_STAGES: Array<(job: NativeSnapshot) => void> = [
    job => progress(job, 'Worker fixture-worker-1 started: add the status badge and its tests.'),
    job => {
      progress(job, 'Worker fixture-worker-1 finished.')
      evaluate(job, { 'badge-renders': 'completed', 'tests-pass': 'unmet' })
    },
    job => progress(job, 'Worker fixture-worker-2 started: fix the unmet tests-pass check.'),
    job => {
      progress(job, 'Worker fixture-worker-2 finished.')
      evaluate(job, { 'tests-pass': 'completed', 'docs-updated': 'completed' })
    },
    job => {
      job.state = 'completed'
      progress(job, 'Factory turn completed; every check is met.')
      job.finalization = { state: 'incomplete', summary: 'Offline fixture finished. No code or artifact was produced.',
        reason: 'Provider execution and artifact evidence were not exercised.', evidence: [] }
    },
  ]
  const advanceV2 = (job: NativeSnapshot): void => {
    const run = v2Stage.get(job.missionId)
    if (!run || job.state === 'completed' || job.attention.some(a => a.state !== 'resolved')) return
    if (++run.dwell < V2_DWELL) return
    run.dwell = 0
    const step = V2_STAGES[run.stage++]
    if (!step) return
    job.brokerSeq++
    step(job)
  }
  const settleV2 = (job: NativeSnapshot, attention: NativeAttention, command: NativeCommand): void => {
    const declined = command.answer?.selectedOption === 'cancel'
    if (attention.kind === 'permission') {
      if (declined) {
        job.state = 'held'
        job.holdReason = 'Offline request declined; no execution was performed.'
        return
      }
      job.state = 'awaiting_input'
      job.attention.push(v2Request(job, 'plan'))
    } else if (declined) {
      job.state = 'awaiting_input'
      job.attention.push(v2Request(job, 'plan'))
    } else {
      // v2 approval is also the start: no separate start request follows.
      job.state = 'running'
      job.features = copy(V2_CHECKS)
      v2Stage.set(job.missionId, { stage: 0, dwell: V2_DWELL - 1 })
      advanceV2(job)
    }
  }
  const settle = (job: NativeSnapshot, command: NativeCommand): void => {
    const attention = job.attention.find(a => a.attentionId === command.answer?.attentionId)
    if (!attention) return
    attention.state = 'resolved'
    attention.resolvedAt = new Date().toISOString()
    job.brokerSeq++
    if (dialect === 'v2') { settleV2(job, attention, command); return }
    if (command.answer?.selectedOption === 'cancel' || command.answer?.cancelled) {
      job.state = 'held'
      job.holdReason = 'Offline request declined; no execution was performed.'
      return
    }
    if (attention.kind === 'proposal') {
      job.state = 'initializing'
      job.attention.push(request(job, 'start'))
    } else if (attention.kind === 'start') {
      job.state = 'running'
      job.attention.push(request(job, 'permission'), request(job, 'ask_user', true))
    } else if (!job.attention.some(a => a.state !== 'resolved')) {
      job.state = 'completed'
      job.features = [{ id: 'fixture-feature', description: 'Offline fixture feature',
        status: 'completed', expectedBehavior: ['Only projection behavior is exercised'] }]
      job.finalization = { state: 'incomplete', summary: 'Offline fixture finished. No code or artifact was produced.',
        reason: 'Provider execution and artifact evidence were not exercised.', evidence: [] }
    }
  }
  return {
    capabilities: async () => copy(CAPS),
    async prepare(intent: NativeIntent) {
      const existing = jobs.get(intent.missionId)
      if (existing) return copy(requireJob(intent.missionId, intent.ownerId))
      const approved = intent.scopeApproved && intent.highAutonomyApproved
      const job: NativeSnapshot = {
        protocolVersion: 1, backend: 'factory_native',
        missionId: intent.missionId, ownerId: intent.ownerId, scopeRevision: intent.scopeRevision,
        brokerSeq: 1, state: !approved ? 'held' : dialect === 'v2' ? 'awaiting_input' : 'planning', control: 'running',
        binding: { sessionId: 'fixture-root', machineId: 'fixture-machine',
          cwd: '/tmp/offline-native-fixture', repository: intent.workspace.repository,
          baseRef: intent.workspace.baseRef, baseSha: null },
        capabilities: copy(CAPS), attention: [], features: [],
        history: [{ id: 'fixture-owner-goal', who: 'owner', text: intent.goal, at: new Date().toISOString() }],
        commands: [], lastObservedAt: new Date().toISOString(), completeness: 'complete',
        holdReason: approved ? null : 'Offline fixture requires explicit scope and High-autonomy consent.',
        finalization: null,
      }
      if (approved) job.attention.push(dialect === 'v2' ? v2Request(job, 'recommend') : request(job, 'proposal'))
      jobs.set(job.missionId, job)
      policies.set(job.missionId, copy(intent.policy))
      return copy(job)
    },
    async observe(missionId, ownerId) {
      const job = requireJob(missionId, ownerId)
      const commands = pending.get(missionId)
      if (commands) {
        pending.delete(missionId)
        for (const command of commands) settle(job, command)
      } else if (job.state === 'completed') advanceDelivery(job)
      else if (dialect === 'v2') advanceV2(job)
      job.lastObservedAt = new Date().toISOString()
      return copy(job)
    },
    async command(command) {
      const job = requireJob(command.missionId, command.ownerId)
      const duplicate = job.commands.find(c => c.commandId === command.commandId)
      if (duplicate) return copy(duplicate)
      let reason: string | null = null
      const a = command.answer
      const attention = job.attention.find(row => row.attentionId === a?.attentionId)
      if (command.expectedBrokerSeq !== job.brokerSeq || command.expectedScopeRevision !== job.scopeRevision) reason = 'Stale offline fixture view'
      else if (command.kind !== 'answer') reason = 'Offline fixture only supports exact attention responses'
      else if (!a || !attention || attention.state !== 'open' ||
        a.requestId !== attention.requestId || a.sessionId !== attention.sessionId ||
        a.machineId !== attention.machineId || a.revision !== attention.revision ||
        a.payloadHash !== attention.payloadHash) reason = 'Offline fixture request binding mismatch'
      else if (attention.kind !== 'ask_user' && !attention.options.some(o => o.value === a.selectedOption)) reason = 'Outcome was not offered'
      else if (attention.kind === 'ask_user' && !a.cancelled && (
        a.answers?.length !== attention.questions.length ||
        new Set(a.answers?.map(row => row.index)).size !== attention.questions.length ||
        !attention.questions.every(q => a.answers?.some(row => {
          if (row.index !== q.index) return false
          if (!q.multiSelect) return q.options.some(o => o.value === row.answer)
          try {
            const values: unknown = JSON.parse(row.answer)
            return Array.isArray(values) && values.length > 0 &&
              new Set(values).size === values.length &&
              values.every(value => typeof value === 'string' && q.options.some(o => o.value === value))
          } catch { return false }
        }))
      )) reason = 'Offline fixture requires every questionnaire answer'
      const receipt: NativeCommandReceipt = { commandId: command.commandId, state: reason ? 'rejected' : 'confirmed', reason }
      job.commands.push(receipt)
      if (!reason) {
        attention.state = 'answer_unknown'
        pending.set(job.missionId, [...pending.get(job.missionId) ?? [], copy(command)])
      }
      return copy(receipt)
    },
  }
}
