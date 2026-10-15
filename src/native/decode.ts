/**
 * Untrusted HTTP/cache/archive values enter here. Decode the entire nested
 * record, then copy only protocol fields (never credentials/unknown grants).
 */
import type {
  NativeAnswer, NativeAttention, NativeBinding, NativeCapabilities, NativeCommand,
  NativeCommandReceipt, NativeIntent, NativeLaunchProfile, NativeSnapshot, NativeAdmissionDraft, NativeAdmissionPreview,
  NativeDeliveryState, NativeUsage,
} from './protocol'
import { nativeProfileWorkspaceFields } from './workspace'

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string'
const id = (v: unknown): v is string => text(v) && v.trim() !== '' && v.length <= 4096
const seq = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const date = (v: unknown): v is string => text(v) && Number.isFinite(Date.parse(v))
const nullable = (v: unknown): v is string | null => v === null || text(v)
const one = (v: unknown, values: readonly string[]) => text(v) && values.includes(v)
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text)
const list = (v: unknown, check: (x: unknown) => boolean): v is unknown[] =>
  Array.isArray(v) && v.length <= 20000 && v.every(check)
const unique = (v: unknown[], key: (x: any) => unknown) => new Set(v.map(key)).size === v.length
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const pick = (r: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.filter(k => r[k] !== undefined).map(k => [k, copy(r[k])]))

export function canonicalBrokerUrl(raw: unknown): string | null {
  if (!id(raw)) return null
  try {
    const u = new URL(raw)
    if (u.username || u.password || u.search || u.hash) return null
    if (u.protocol !== 'https:' &&
      !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) return null
    return u.href.replace(/\/+$/, '')
  } catch { return null }
}

export function decodeNativeProfile(v: unknown): NativeLaunchProfile | null {
  if (!record(v) || canonicalBrokerUrl(v.brokerUrl) === null ||
    !['ownerId', 'machineId', 'baseRef'].every(k => id(v[k])) ||
    !(v.workspaceMode === 'host_managed' ? text(v.cwd) && v.cwd.length <= 4096 : id(v.cwd))) return null
  const workspaceFields = nativeProfileWorkspaceFields(v)
  if (!workspaceFields) return null
  return { ...pick(v, ['ownerId', 'machineId', 'cwd', 'baseRef']),
    ...workspaceFields,
    brokerUrl: canonicalBrokerUrl(v.brokerUrl)! } as NativeLaunchProfile
}

export function decodeNativeCapabilities(v: unknown): NativeCapabilities | null {
  const flags = ['qualified', 'launch', 'rootAttention', 'childAttention', 'recoverAttention', 'pause', 'resume', 'cancel']
  if (!record(v) || v.protocolVersion !== 1 || !nullable(v.qualificationId) ||
    !text(v.transportVersion) || !flags.every(k => typeof v[k] === 'boolean')) return null
  const out = pick(v, ['protocolVersion', 'qualificationId', 'transportVersion', ...flags])
  // The host's GitHub sign-in (HOST-GITHUB-PLAN): a login only, never a
  // token. A malformed block reads as absent, never as available.
  const github = v.github
  if (record(github) && typeof github.available === 'boolean' &&
    (github.login === null || (text(github.login) && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(github.login)))) {
    out.github = { available: github.available && github.login !== null, login: github.login }
  }
  return out as unknown as NativeCapabilities
}

export function decodeNativeIntent(v: unknown): NativeIntent | null {
  if (!record(v) || v.protocolVersion !== 1 ||
    !['missionId', 'ownerId', 'commandId', 'goal'].every(k => id(v[k])) ||
    !seq(v.scopeRevision) || v.scopeRevision === 0 ||
    !one(v.operation, ['implement', 'integrate', 'clone', 'fork', 'inspect']) ||
    !record(v.workspace) || !['machineId', 'cwd', 'repository', 'baseRef'].every(k => id(v.workspace![k])) ||
    (v.workspace.baseSha !== undefined && !id(v.workspace.baseSha)) ||
    !strings(v.references) || !strings(v.acceptanceCriteria) || !strings(v.restrictions) ||
    !record(v.policy) || v.policy.autonomy !== 'high' ||
    !['allowCreateRepository', 'allowPush', 'allowPr', 'allowMerge', 'allowDeploy'].every(k => typeof v.policy![k] === 'boolean') ||
    (v.policy.budget !== undefined && (!record(v.policy.budget) || !id(v.policy.budget.unit) ||
      !text(v.policy.budget.capUnits) || !/^[1-9][0-9]{0,35}$/.test(v.policy.budget.capUnits))) ||
    typeof v.scopeApproved !== 'boolean' || typeof v.highAutonomyApproved !== 'boolean' ||
    !record(v.settings) || !Object.entries(v.settings).every(([k, x]) =>
      !/token|secret|password|credential|api.?key|authorization/i.test(k) &&
      (text(x) || typeof x === 'boolean' || strings(x)))) return null
  if (v.destination !== undefined && (!record(v.destination) ||
    !one(v.destination.kind, ['existing', 'new_repository']) ||
    !id(v.destination.account) || !id(v.destination.name) ||
    !one(v.destination.visibility, ['private', 'public']) ||
    !one(v.destination.initialization, ['empty', 'scaffold', 'clone', 'fork']) ||
    (v.destination.sourceUrl !== undefined && !text(v.destination.sourceUrl)))) return null
  const out = pick(v, ['protocolVersion', 'missionId', 'ownerId', 'commandId', 'goal', 'scopeRevision',
    'operation', 'references', 'acceptanceCriteria', 'restrictions', 'scopeApproved', 'highAutonomyApproved', 'settings'])
  out.workspace = pick(v.workspace, ['machineId', 'cwd', 'repository', 'baseRef', 'baseSha'])
  out.policy = pick(v.policy, ['autonomy', 'allowCreateRepository', 'allowPush', 'allowPr', 'allowMerge', 'allowDeploy'])
  if (record(v.policy.budget)) (out.policy as Record<string, unknown>).budget = pick(v.policy.budget, ['unit', 'capUnits'])
  if (record(v.destination)) out.destination = pick(v.destination,
    ['kind', 'account', 'name', 'visibility', 'initialization', 'sourceUrl'])
  return out as unknown as NativeIntent
}

export function decodeNativeAdmissionDraft(v: unknown): NativeAdmissionDraft | null {
  if (!record(v) || Object.hasOwn(v, 'scopeApproved') || Object.hasOwn(v, 'highAutonomyApproved')) return null
  const intent = decodeNativeIntent({ ...v, scopeApproved: false, highAutonomyApproved: false })
  if (!intent) return null
  const { scopeApproved: _, highAutonomyApproved: __, ...draft } = intent
  return draft
}
export function decodeNativeAdmissionPreview(v: unknown): NativeAdmissionPreview | null {
  if (!record(v) || v.protocolVersion !== 1 || !id(v.missionId) || !id(v.ownerId) ||
    !text(v.draftHash) || !/^[a-f0-9]{64}$/.test(v.draftHash) ||
    !record(v.workspace) || !['machineId', 'cwd', 'repository', 'baseRef'].every(k => id(v.workspace![k])) ||
    !text(v.workspace.baseSha) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v.workspace.baseSha) ||
    !record(v.prospectiveSettings) || !Object.entries(v.prospectiveSettings).every(([k, x]) =>
      !/token|secret|password|credential|api.?key|authorization/i.test(k) && (text(x) || typeof x === 'boolean' || strings(x))) ||
    !date(v.observedAt) || !date(v.expiresAt) || Date.parse(v.expiresAt) <= Date.parse(v.observedAt) ||
    typeof v.launchEligible !== 'boolean' || !strings(v.holds) || v.holds.length > 32 ||
    (v.launchEligible && v.holds.length !== 0)) return null
  return {
    ...pick(v, ['protocolVersion', 'missionId', 'ownerId', 'draftHash', 'observedAt', 'expiresAt', 'launchEligible', 'holds']),
    workspace: pick(v.workspace, ['machineId', 'cwd', 'repository', 'baseRef', 'baseSha']),
    prospectiveSettings: copy(v.prospectiveSettings),
  } as unknown as NativeAdmissionPreview
}

const option = (v: unknown): boolean => record(v) && id(v.id) && text(v.label) && id(v.value)
const question = (v: unknown): boolean => record(v) && seq(v.index) && text(v.topic) &&
  text(v.question) && typeof v.multiSelect === 'boolean' && list(v.options, option) &&
  unique(v.options, x => x.id) && unique(v.options, x => x.value)
export function decodeNativeAttention(v: unknown): NativeAttention | null {
  if (!record(v) || !['attentionId', 'requestId', 'sessionId', 'machineId', 'payloadHash'].every(k => id(v[k])) ||
    !strings(v.toolUseIds) || !strings(v.associatedSessionIds) || !seq(v.revision) ||
    !one(v.kind, ['ask_user', 'permission', 'proposal', 'start', 'unsupported']) ||
    !text(v.title) || !text(v.details) || !list(v.options, option) || !unique(v.options, x => x.id) ||
    !unique(v.options, x => x.value) || !list(v.questions, question) || !unique(v.questions, x => x.index) ||
    !one(v.state, ['open', 'answer_unknown', 'resolved']) || !date(v.openedAt) ||
    !(v.resolvedAt === null || date(v.resolvedAt))) return null
  return {
    ...pick(v, ['attentionId', 'requestId', 'sessionId', 'machineId', 'toolUseIds', 'associatedSessionIds',
      'revision', 'payloadHash', 'kind', 'title', 'details', 'state', 'openedAt', 'resolvedAt']),
    options: (v.options as Record<string, unknown>[]).map(x => pick(x, ['id', 'label', 'value'])),
    questions: (v.questions as Record<string, unknown>[]).map(x => ({
      ...pick(x, ['index', 'topic', 'question', 'multiSelect']),
      options: (x.options as Record<string, unknown>[]).map(o => pick(o, ['id', 'label', 'value'])),
    })),
  } as unknown as NativeAttention
}
export function decodeNativeAnswer(v: unknown): NativeAnswer | null {
  if (!record(v) || !['attentionId', 'requestId', 'sessionId', 'machineId', 'payloadHash'].every(k => id(v[k])) ||
    !seq(v.revision) || (v.selectedOption !== undefined && !id(v.selectedOption)) ||
    (v.cancelled !== undefined && typeof v.cancelled !== 'boolean') ||
    (v.answers !== undefined && (!list(v.answers, x => record(x) && seq(x.index) && text(x.answer)) ||
      !unique(v.answers, x => x.index)))) return null
  return {
    ...pick(v, ['attentionId', 'requestId', 'sessionId', 'machineId', 'revision', 'payloadHash', 'selectedOption', 'cancelled']),
    ...(Array.isArray(v.answers) ? { answers: v.answers.map(x => pick(x, ['index', 'answer'])) } : {}),
  } as unknown as NativeAnswer
}

export function decodeNativeReceipt(v: unknown): NativeCommandReceipt | null {
  if (!record(v) || !id(v.commandId) ||
    !one(v.state, ['prepared', 'invoked', 'confirmed', 'rejected', 'unknown']) || !nullable(v.reason)) return null
  return pick(v, ['commandId', 'state', 'reason']) as unknown as NativeCommandReceipt
}
export function decodeNativeCommand(v: unknown): NativeCommand | null {
  if (!record(v) || v.protocolVersion !== 1 || !['commandId', 'missionId', 'ownerId'].every(k => id(v[k])) ||
    !seq(v.expectedScopeRevision) || !seq(v.expectedBrokerSeq) ||
    !one(v.kind, ['prepare', 'owner_turn', 'answer', 'pause', 'resume', 'cancel']) ||
    (v.text !== undefined && !text(v.text)) || (v.answer !== undefined && decodeNativeAnswer(v.answer) === null) ||
    (v.kind === 'answer' && v.answer === undefined) || (v.kind === 'owner_turn' && !id(v.text))) return null
  return { ...pick(v, ['protocolVersion', 'commandId', 'missionId', 'ownerId', 'kind', 'expectedScopeRevision',
    'expectedBrokerSeq', 'text']), ...(v.answer === undefined ? {} : { answer: decodeNativeAnswer(v.answer) }) } as unknown as NativeCommand
}
function decodeBinding(v: unknown): NativeBinding | null {
  if (!record(v) || !['sessionId', 'machineId', 'cwd', 'repository', 'baseRef'].every(k => id(v[k])) ||
    !nullable(v.baseSha)) return null
  return pick(v, ['sessionId', 'machineId', 'cwd', 'repository', 'baseRef', 'baseSha']) as unknown as NativeBinding
}
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 10000
export function decodeNativeDelivery(v: unknown): NativeDeliveryState | null {
  if (!record(v) || !one(v.step, ['held', 'pushed', 'pr_open', 'checks_pending', 'checks_failed', 'merged', 'not_merged']) ||
    !id(v.branch) || !/^spriite\/[A-Za-z0-9._-]+$/.test(v.branch) ||
    // The broker emits headSha '' for a held delivery that never pushed a head
    // (broker/validation.mjs allows the empty string); every other step needs a sha.
    !text(v.headSha) || !(v.headSha === '' ? v.step === 'held' : /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v.headSha)) ||
    !date(v.updatedAt) ||
    (v.prUrl !== undefined && (!text(v.prUrl) || !/^https:\/\/github\.com\/[^\s]+\/pull\/\d+$/.test(v.prUrl))) ||
    (v.prNumber !== undefined && (!Number.isSafeInteger(v.prNumber) || Number(v.prNumber) <= 0)) ||
    (v.reason !== undefined && (!text(v.reason) || v.reason.length > 500))) return null
  if (v.checks !== undefined) {
    const c = v.checks
    if (!record(c) || !['total', 'passed', 'failed', 'pending'].every(k => count(c[k])) ||
      (c.passed as number) + (c.failed as number) + (c.pending as number) !== c.total) return null
  }
  // A merge or open PR without its PR identity is not a delivery Spriite can describe.
  if (['pr_open', 'checks_pending', 'checks_failed', 'merged'].includes(v.step as string) &&
    (v.prUrl === undefined || v.prNumber === undefined)) return null
  const out = pick(v, ['step', 'branch', 'headSha', 'prUrl', 'prNumber', 'reason', 'updatedAt'])
  if (record(v.checks)) out.checks = pick(v.checks, ['total', 'passed', 'failed', 'pending'])
  return out as unknown as NativeDeliveryState
}
export function decodeNativeUsage(v: unknown): NativeUsage | null {
  if (!record(v) || !one(v.state, ['pending', 'available', 'unavailable'])) return null
  if (v.credits !== undefined && (typeof v.credits !== 'number' || !Number.isFinite(v.credits) || v.credits < 0)) return null
  if (v.state === 'available' && v.credits === undefined) return null
  return v.state === 'available' ? { state: 'available', credits: v.credits as number } : { state: v.state as 'pending' | 'unavailable' }
}

export function decodeNativeSnapshot(v: unknown): NativeSnapshot | null {
  if (!record(v) || v.protocolVersion !== 1 || v.backend !== 'factory_native' ||
    !id(v.missionId) || !id(v.ownerId) || !seq(v.scopeRevision) || !seq(v.brokerSeq) ||
    !one(v.state, ['held', 'planning', 'awaiting_input', 'initializing', 'running', 'paused', 'orchestrator_turn', 'completed']) ||
    !one(v.control, ['running', 'pause_requested', 'paused', 'cancel_requested', 'cancelled']) ||
    !(v.binding === null || decodeBinding(v.binding)) || !decodeNativeCapabilities(v.capabilities) ||
    !list(v.attention, x => decodeNativeAttention(x) !== null) || !unique(v.attention, x => x.attentionId) ||
    !list(v.features, x => record(x) && id(x.id) && text(x.description) &&
      one(x.status, ['pending', 'in_progress', 'completed', 'cancelled', 'unmet']) &&
      strings(x.expectedBehavior) && (x.milestone === undefined || text(x.milestone))) || !unique(v.features, x => x.id) ||
    !list(v.history, x => record(x) && id(x.id) && one(x.who, ['owner', 'factory', 'spriite']) &&
      text(x.text) && date(x.at)) || !unique(v.history, x => x.id) ||
    !list(v.commands, x => decodeNativeReceipt(x) !== null) || !unique(v.commands, x => x.commandId) ||
    !(v.lastObservedAt === null || date(v.lastObservedAt)) ||
    !one(v.completeness, ['complete', 'gap', 'unknown']) || !nullable(v.holdReason)) return null
  if (v.finalization !== null && (!record(v.finalization) ||
    !one(v.finalization.state, ['pending', 'complete', 'incomplete']) ||
    !nullable(v.finalization.summary) || !nullable(v.finalization.reason) ||
    !list(v.finalization.evidence, x => record(x) && id(x.id) && text(x.url) &&
      typeof x.verified === 'boolean' && nullable(x.commitSha)))) return null
  // Optional broker extensions: an unrecognized shape is dropped and noted,
  // never shown (and never read as delivered).
  const extra: Record<string, unknown> = {}
  const diagnostics: string[] = Array.isArray(v.diagnostics)
    ? v.diagnostics.filter((d): d is string => text(d) && /^[a-z_]{1,64}$/.test(d)).slice(0, 8) : []
  if (v.delivery !== undefined && v.delivery !== null) {
    const delivery = decodeNativeDelivery(v.delivery)
    if (delivery && delivery.branch === `spriite/${v.missionId}`) extra.delivery = delivery
    else if (!diagnostics.includes('delivery_unrecognized')) diagnostics.push('delivery_unrecognized')
  }
  if (v.usage !== undefined && v.usage !== null) {
    const usage = decodeNativeUsage(v.usage)
    if (usage) extra.usage = usage
    else if (!diagnostics.includes('usage_unrecognized')) diagnostics.push('usage_unrecognized')
  }
  if (diagnostics.length) extra.diagnostics = diagnostics
  return {
    ...pick(v, ['protocolVersion', 'backend', 'missionId', 'ownerId', 'scopeRevision', 'brokerSeq', 'state',
      'control', 'lastObservedAt', 'completeness', 'holdReason']),
    ...extra,
    binding: v.binding === null ? null : decodeBinding(v.binding),
    capabilities: decodeNativeCapabilities(v.capabilities),
    attention: v.attention.map(decodeNativeAttention),
    features: (v.features as Record<string, unknown>[]).map(x => pick(x, ['id', 'description', 'status', 'expectedBehavior', 'milestone'])),
    history: (v.history as Record<string, unknown>[]).map(x => pick(x, ['id', 'who', 'text', 'at'])),
    commands: v.commands.map(decodeNativeReceipt),
    finalization: v.finalization === null ? null : {
      ...pick(v.finalization as Record<string, unknown>, ['state', 'summary', 'reason']),
      evidence: ((v.finalization as any).evidence as Record<string, unknown>[]).map(x => pick(x, ['id', 'url', 'verified', 'commitSha'])),
    },
  } as unknown as NativeSnapshot
}

/** Device cache is an observation projection, not a second broker ledger. */
export interface NativeMissionCache {
  nativeCacheVersion: 1
  backend: 'factory_native'
  snapshot: NativeSnapshot
  pendingWrites: Array<{ command: NativeCommand; receipt: NativeCommandReceipt }>
  prepareReceipt: NativeCommandReceipt | null
  finalizationDeadline: string | null
  /** Local successful broker read, separate from broker/provider observation. */
  lastClientObservedAt: string | null
  /** Durable observation-only blockage; never a policy/workspace grant. */
  observationBlock: {
    kind: 'native_observation_unavailable' | 'native_observation_gap' | 'native_observation_quarantined'
    eventId: string
  } | null
  /** A local admission/policy hold cannot be lifted by a successful read. */
  localHoldReason: string | null
  imported: boolean
}
export function decodeNativeCache(v: unknown): NativeMissionCache | null {
  if (!record(v) || v.nativeCacheVersion !== 1 || v.backend !== 'factory_native' ||
    !decodeNativeSnapshot(v.snapshot) || !list(v.pendingWrites, x => record(x) &&
      decodeNativeCommand(x.command) !== null && decodeNativeReceipt(x.receipt) !== null &&
      (x.command as NativeCommand).commandId === (x.receipt as NativeCommandReceipt).commandId) ||
    !unique(v.pendingWrites, x => x.command.commandId) ||
    !(v.prepareReceipt === null || decodeNativeReceipt(v.prepareReceipt)) ||
    !(v.lastClientObservedAt === undefined || v.lastClientObservedAt === null || date(v.lastClientObservedAt)) ||
    !(v.localHoldReason === undefined || nullable(v.localHoldReason)) ||
    !(v.observationBlock === undefined || v.observationBlock === null ||
      (record(v.observationBlock) && id(v.observationBlock.eventId) &&
        one(v.observationBlock.kind, ['native_observation_unavailable', 'native_observation_gap', 'native_observation_quarantined']))) ||
    !(v.finalizationDeadline === null || date(v.finalizationDeadline)) || typeof v.imported !== 'boolean') return null
  const snapshot = decodeNativeSnapshot(v.snapshot)!
  if (!(v.pendingWrites as any[]).every(x => x.command.missionId === snapshot.missionId &&
    x.command.ownerId === snapshot.ownerId) ||
    (v.prepareReceipt !== null && (v.prepareReceipt as NativeCommandReceipt).commandId === '')) return null
  return {
    nativeCacheVersion: 1, backend: 'factory_native', snapshot,
    pendingWrites: (v.pendingWrites as any[]).map(x => ({ command: decodeNativeCommand(x.command)!, receipt: decodeNativeReceipt(x.receipt)! })),
    prepareReceipt: v.prepareReceipt === null ? null : decodeNativeReceipt(v.prepareReceipt),
    finalizationDeadline: v.finalizationDeadline as string | null, imported: v.imported,
    lastClientObservedAt: v.lastClientObservedAt as string | null ?? null,
    observationBlock: v.observationBlock == null ? null :
      pick(v.observationBlock as Record<string, unknown>, ['kind', 'eventId']) as NativeMissionCache['observationBlock'],
    localHoldReason: v.localHoldReason === undefined ?
      (snapshot.state === 'held' ? snapshot.holdReason : null) : v.localHoldReason as string | null,
  }
}
