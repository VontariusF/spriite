/**
 * Native delivery defaults and the honest wording of broker delivery.
 * Only a merged PR is ever described as delivered.
 */
import type { NativeDeliveryDefaults, NativeDeliveryState, NativeIntent, NativePolicy, NativeSnapshot, NativeUsage } from './protocol'

export const NO_NATIVE_DELIVERY: NativeDeliveryDefaults = Object.freeze({
  createPrivateRepositories: false, pushBranch: false, openPr: false, mergeAfterChecks: false,
})

/** Merge requires a PR, and a PR requires a pushed branch. */
export function normalizeDeliveryDefaults(value: unknown): NativeDeliveryDefaults {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const pushBranch = raw.pushBranch === true
  const openPr = pushBranch && raw.openPr === true
  return {
    createPrivateRepositories: raw.createPrivateRepositories === true,
    pushBranch, openPr, mergeAfterChecks: openPr && raw.mergeAfterChecks === true,
  }
}

/**
 * Apply one toggle and keep the chain consistent: turning a later step on
 * turns its prerequisites on; turning a prerequisite off turns later steps off.
 */
export function toggleDeliveryDefault(current: NativeDeliveryDefaults, key: keyof NativeDeliveryDefaults,
  on: boolean): NativeDeliveryDefaults {
  const next = { ...normalizeDeliveryDefaults(current), [key]: on }
  if (on && key === 'mergeAfterChecks') { next.openPr = true; next.pushBranch = true }
  if (on && key === 'openPr') next.pushBranch = true
  if (!on && key === 'pushBranch') { next.openPr = false; next.mergeAfterChecks = false }
  if (!on && key === 'openPr') next.mergeAfterChecks = false
  return normalizeDeliveryDefaults(next)
}

/** Policy flags for one job. Repository creation applies only to a new private, empty destination. */
export function deliveryPolicyFlags(defaults: NativeDeliveryDefaults, destination?: NativeIntent['destination']):
  Pick<NativePolicy, 'allowCreateRepository' | 'allowPush' | 'allowPr' | 'allowMerge' | 'allowDeploy'> {
  const d = normalizeDeliveryDefaults(defaults)
  return {
    allowCreateRepository: d.createPrivateRepositories && destination?.kind === 'new_repository' &&
      destination.visibility === 'private' && destination.initialization === 'empty',
    allowPush: d.pushBranch, allowPr: d.openPr, allowMerge: d.mergeAfterChecks, allowDeploy: false,
  }
}

export const validGithubAccount = (v: string): boolean =>
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(v)
/** GitHub's repository-name alphabet; `.`/`..` and a `.git` suffix are refused. */
export const validRepositoryName = (v: string): boolean =>
  /^[A-Za-z0-9._-]{1,100}$/.test(v) && !/^\.{1,2}$/.test(v) && !/\.git$/i.test(v)

/**
 * The repository name a post states explicitly ("new repo called habit-log",
 * "new private repository named `habit-log`"). Never invented from the goal.
 */
export function newRepositoryNameFrom(instruction: string): string | null {
  const name = '[`"\'“‘]?([A-Za-z0-9._-]+?)[`"\'”’]?(?=[\\s,;:!?)]|\\.(?:\\s|$)|$)'
  for (const pattern of [
    new RegExp(`\\bnew (?:private )?repo(?:sitory)?\\s+(?:called|named)\\s+${name}`, 'i'),
    new RegExp(`\\b(?:called|named)\\s+${name}\\s+(?:in|as)\\s+a\\s+new (?:private )?repo(?:sitory)?\\b`, 'i'),
    new RegExp(`\\bnew (?:private )?repo(?:sitory)?:\\s*${name}`, 'i'),
  ]) {
    const m = pattern.exec(instruction)
    if (m && validRepositoryName(m[1])) return m[1]
  }
  return null
}

const NAME_STOPWORDS = new Set(['a', 'an', 'the', 'me', 'my', 'us', 'our', 'for', 'to', 'of', 'and', 'with', 'that', 'this',
  'please', 'build', 'make', 'create', 'add', 'write', 'can', 'you', 'could', 'would', 'should', 'i', 'want', 'need', 'new',
  'repo', 'repository', 'spriite', 'in', 'on', 'it', 'some', 'simple', 'small', 'quick'])

/**
 * A repository name for a request that named none: a few content words from
 * the post plus a stable suffix from the post id, so the same post always
 * maps to the same repository and two posts never collide.
 */
export function derivedRepositoryName(instruction: string, postId: string): string {
  const words = instruction.toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ').replace(/[@#]\w+/g, ' ')
    .split(/[^a-z0-9]+/).filter(w => w.length > 1 && !NAME_STOPWORDS.has(w)).slice(0, 4)
  const suffix = (postId.replace(/[^0-9A-Za-z]/g, '').slice(-10) || '0').toLowerCase()
  // Truncate the words, never the suffix: the suffix is what keeps two posts apart.
  const stem = (words.join('-') || 'x-build').slice(0, 100 - suffix.length - 1).replace(/-+$/, '')
  const name = `${stem || 'x-build'}-${suffix}`
  return validRepositoryName(name) ? name : `x-build-${suffix}`
}

export const deliveryBranch = (missionId: string): string => `spriite/${missionId || '<mission id>'}`

/** "This job will: …" for the review screen. */
export function deliverySummary(policy: Pick<NativePolicy, 'allowCreateRepository' | 'allowPush' | 'allowPr' | 'allowMerge'>,
  missionId: string, destination?: NativeIntent['destination']): string {
  const steps: string[] = []
  if (policy.allowCreateRepository && destination) steps.push(`create the private repository ${destination.account}/${destination.name}`)
  if (policy.allowPush) steps.push(`push branch ${deliveryBranch(missionId)}`)
  if (policy.allowPr) steps.push('open a PR')
  if (policy.allowMerge) steps.push('merge after checks pass')
  if (!policy.allowPush) steps.push('keep work as a local commit')
  return `This job will: ${steps.join(', ')}. It never deploys.`
}

const lowerFirst = (s: string) => s ? s[0].toLowerCase() + s.slice(1) : s

/** One honest line for phone and glasses. */
export function deliveryLine(d: NativeDeliveryState): string {
  const checks = d.checks && d.checks.total > 0 ? `checks ${d.checks.passed}/${d.checks.total}` : 'checks pending'
  const reason = d.reason?.replace(/\s+/g, ' ').trim().replace(/\.+$/, '') ?? ''
  switch (d.step) {
    case 'held': return `Delivery held: ${reason || 'reason not reported'}`
    case 'pushed': return 'Branch pushed · no PR yet'
    case 'pr_open':
    case 'checks_pending': return `PR open · ${checks}`
    case 'checks_failed': return 'Not merged: checks failed'
    case 'merged': return 'Merged'
    case 'not_merged': return reason ? `Not merged: ${lowerFirst(reason)}` : 'Not merged'
  }
}

/** A delivery claim must follow completion and stay inside the job's frozen policy. */
export function deliveryWithinPolicy(s: { state: string; delivery?: NativeDeliveryState },
  intent: { policy: Pick<NativePolicy, 'allowPush' | 'allowPr' | 'allowMerge'> }): boolean {
  const d = s.delivery
  if (!d) return true
  if (s.state !== 'completed') return false
  const p = intent.policy
  if ((d.prUrl || d.prNumber) && (!p.allowPush || !p.allowPr)) return false
  if (d.step === 'held' || d.step === 'not_merged') return true
  if (!p.allowPush) return false
  if (d.step === 'pushed') return true
  if (!p.allowPr) return false
  return d.step !== 'merged' || p.allowMerge
}

/**
 * The delivery to show an owner. Anything outside the job's frozen policy (or
 * reported when no decodable policy exists) is downgraded to "no delivery",
 * so it can never be rendered as delivered.
 */
export function displayDelivery(s: { state: string; delivery?: NativeDeliveryState },
  policy: Pick<NativePolicy, 'allowPush' | 'allowPr' | 'allowMerge'> | null | undefined): NativeDeliveryState | undefined {
  return s.delivery && policy && deliveryWithinPolicy(s, { policy }) ? s.delivery : undefined
}

/** Apply to live observations AND restored projections before any presentation. */
export function constrainNativeDelivery(s: NativeSnapshot, policy: NativePolicy | null | undefined): NativeSnapshot {
  if (!s.delivery || (policy && deliveryWithinPolicy(s, { policy }))) return s
  const { delivery: _, ...safe } = s
  return { ...safe, diagnostics: [...new Set([...(s.diagnostics ?? []), 'delivery_outside_policy'])] }
}

/**
 * Fail-fast validation of a promoted/approved intent's delivery policy against
 * the destination and the current delivery defaults. Returns the rejection
 * reason, or null when the policy is exactly what the phone draft would build.
 */
export function deliveryPolicyProblem(
  policy: Pick<NativePolicy, 'allowCreateRepository' | 'allowPush' | 'allowPr' | 'allowMerge' | 'allowDeploy'>,
  destination: NativeIntent['destination'] | undefined,
  defaults: NativeDeliveryDefaults,
): string | null {
  if (policy.allowDeploy) return 'Native jobs never deploy'
  if (policy.allowMerge && !policy.allowPr) return 'Merging requires opening a PR'
  if (policy.allowPr && !policy.allowPush) return 'Opening a PR requires pushing a branch'
  if (destination?.kind === 'new_repository' &&
    (destination.visibility !== 'private' || destination.initialization !== 'empty' || destination.sourceUrl ||
      !validGithubAccount(destination.account) || !validRepositoryName(destination.name))) {
    return 'A new repository must have a valid private, empty destination without a clone/fork source'
  }
  if (destination?.kind === 'new_repository' && !policy.allowCreateRepository) {
    return 'A new repository requires approved private repository creation'
  }
  const d = normalizeDeliveryDefaults(defaults)
  if (policy.allowPush && !d.pushBranch) return 'Pushing is off in delivery defaults'
  if (policy.allowPr && !d.openPr) return 'Opening PRs is off in delivery defaults'
  if (policy.allowMerge && !d.mergeAfterChecks) return 'Merging is off in delivery defaults'
  if (policy.allowCreateRepository) {
    if (!d.createPrivateRepositories) return 'Repository creation is off in delivery defaults'
    if (destination?.kind !== 'new_repository') return 'Repository creation needs a new-repository destination'
    if (destination.visibility !== 'private' || destination.initialization !== 'empty') {
      return 'A new repository must be private and empty'
    }
    if (!validGithubAccount(destination.account) || !validRepositoryName(destination.name)) {
      return 'A valid GitHub account and repository name are required'
    }
  }
  const expected = deliveryPolicyFlags(d, destination)
  if (Object.keys(expected).some(key => policy[key as keyof typeof expected] !== expected[key as keyof typeof expected])) {
    return 'Delivery defaults changed or do not match the reviewed policy; inspect again'
  }
  return null
}

/** The same explicit model/tool and mandatory-validation contract as phone review. */
export function reviewedNativeSettingsProblem(settings: NativeIntent['settings']): string | null {
  const models = ['modelId', 'reasoningEffort', 'workerModel', 'workerReasoningEffort',
    'validationWorkerModel', 'validationWorkerReasoningEffort']
  const keys = [...models, 'restrictToolIds', 'skipScrutiny', 'skipUserTesting']
  const tools = settings.restrictToolIds
  if (Object.keys(settings).length !== keys.length || Object.keys(settings).some(k => !keys.includes(k)) ||
    models.some(k => typeof settings[k] !== 'string' || !(settings[k] as string).trim()) ||
    settings.skipScrutiny !== false || settings.skipUserTesting !== false ||
    !Array.isArray(tools) || !tools.length || tools.length > 128 || new Set(tools).size !== tools.length ||
    tools.some(t => t.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(t) ||
      ['__proto__', 'constructor', 'prototype'].includes(t))) {
    return 'Explicit reviewed models, tool IDs and mandatory validation settings are required'
  }
  return null
}

export const deliveryDelivered = (d: NativeDeliveryState | undefined): boolean => d?.step === 'merged'

export function usageLine(u: NativeUsage): string {
  if (u.state === 'pending') return 'Usage: available tomorrow'
  if (u.state === 'available' && typeof u.credits === 'number') return `Usage: ${u.credits} credits`
  return 'Usage unavailable'
}
