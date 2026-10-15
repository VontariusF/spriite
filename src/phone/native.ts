/**
 * Phone-only native admission and exact-request answering. This module is a
 * projection/input surface, never a broker, provider transport or scheduler.
 */
import type {
  HeldNativeIntent, NativeAdmissionDraft, NativeAdmissionPreview, NativeAnswer, NativeAttention, NativeCapabilities, NativeIntent,
  NativeDeliveryDefaults, NativeLaunchProfile, NativeSnapshot,
} from '../native/protocol'
export type { HeldNativeIntent } from '../native/protocol'
import type { PrefsVault } from '../state/prefs'
import { nativeProfileOf } from '../state/prefs'
import { allocateNativeWorkspace } from '../native/workspace'
import { NATIVE_FEATURE_STATUS_WORD, nativeFeatureCounts, nativeFeatureTally } from '../native/presentation'
import { deliveryDelivered, deliveryLine, deliveryPolicyFlags, deliverySummary, toggleDeliveryDefault, usageLine } from '../native/delivery'
import type { KeyVault } from '../voice/keys'

/** Main owns unique mission/command IDs. No credential travels in this object. */
export type NativeLaunchRequest = Omit<NativeIntent, 'missionId' | 'commandId'> & {
  brokerUrl: string
  /** Main must reuse the IDs/client/credential reserved by this exact inspection. */
  admission?: NativeAdmissionPreview
}
export type NativeAdmissionRequest = Omit<NativeAdmissionDraft, 'missionId' | 'commandId'> & { brokerUrl: string }
export interface NativeLaunchOutcome {
  status: 'saved' | 'held' | 'failed'
  reason?: string
}
export interface NativePhoneEngine {
  readonly hasUnconfirmedDelivery?: boolean
  nativeSnapshot?(): NativeSnapshot | null
  answerNative?(answer: NativeAnswer): boolean | Promise<boolean>
  factorySessionLink?(): string | null
}
export interface NativePhoneDeps {
  keys: KeyVault
  prefs: PrefsVault
  engine: () => NativePhoneEngine
  /** Evidence must belong to this exact profile and current vault credential. */
  nativeCapabilities?: (profile: NativeLaunchProfile) => NativeCapabilities | null
  /** Explicit read-only inspection only; never initialize, discover models or start. */
  onNativeAdmission?: (request: NativeAdmissionRequest) => Promise<NativeAdmissionPreview>
  onNativeLaunch?: (request: NativeLaunchRequest) => NativeLaunchOutcome | Promise<NativeLaunchOutcome>
  /** Held, ungranted intents (X posts or saved requests); never owner authority. */
  heldNativeIntents?: () => HeldNativeIntent[]
  onPromoteHeld?: (heldMissionId: string, request: NativeLaunchRequest) => NativeLaunchOutcome | Promise<NativeLaunchOutcome>
  onDismissHeld?: (heldMissionId: string) => boolean | Promise<boolean>
  onSaved: () => void
}

const node = <K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
  const result = Object.assign(document.createElement(tag), props)
  result.append(...children)
  return result
}
const lines = (text: string): string[] => text.split('\n').map(s => s.trim()).filter(Boolean)
const PHONE_FEATURE_ROWS = 200
/** A v2 plan can be ~64KB; scroll it inside the card instead of stretching the page. */
const boundedBlock = <T extends HTMLElement>(element: T): T => {
  element.style.maxHeight = '60vh'
  element.style.overflowY = 'auto'
  return element
}
const qualified = (c: NativeCapabilities | null | undefined): boolean =>
  c?.protocolVersion === 1 && c.qualified && c.launch && Boolean(c.qualificationId) &&
  c.rootAttention && c.childAttention && c.recoverAttention
const settingNames = ['modelId', 'reasoningEffort', 'workerModel', 'workerReasoningEffort',
  'validationWorkerModel', 'validationWorkerReasoningEffort'] as const
const allSettingNames = [...settingNames, 'restrictToolIds', 'skipScrutiny', 'skipUserTesting'] as const
/** Deployment-defined IDs; syntactic validity is not deployment permission. */
const validToolId = (value: string): boolean =>
  value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value)
/** Detach callback-owned objects so late mutation cannot alter an approved job. */
const frozenCopy = <T>(value: T): T => {
  const copy = JSON.parse(JSON.stringify(value)) as T
  const freeze = (part: unknown): void => {
    if (part && typeof part === 'object') {
      Object.values(part).forEach(freeze)
      Object.freeze(part)
    }
  }
  freeze(copy)
  return copy
}
const requestKey = (s: NativeSnapshot, a: NativeAttention): string =>
  JSON.stringify([s.ownerId, s.missionId, s.scopeRevision, a.machineId, a.sessionId,
    a.attentionId, a.requestId, a.revision, a.payloadHash])
const canAnswer = (s: NativeSnapshot, a: NativeAttention, engine: NativePhoneEngine): boolean =>
  a.kind !== 'unsupported' && s.capabilities.protocolVersion === 1 &&
  s.capabilities.qualified && Boolean(s.capabilities.qualificationId) &&
  s.capabilities.rootAttention && Boolean(s.binding) &&
  (a.sessionId === s.binding?.sessionId || s.capabilities.childAttention) &&
  s.completeness === 'complete' && a.state === 'open' && s.control === 'running' &&
  s.state !== 'completed' && !engine.hasUnconfirmedDelivery &&
  !s.commands.some(c => ['prepared', 'invoked', 'unknown'].includes(c.state)) &&
  !s.attention.some(row => row.state === 'answer_unknown') && Boolean(engine.answerNative)

export function mountNativePhone(
  launchRoot: HTMLElement, attentionRoot: HTMLElement, deps: NativePhoneDeps,
): { refresh(): void } {
  const profileInputs = {} as Record<keyof NativeLaunchProfile, HTMLInputElement>
  const form: HTMLElement[] = []
  const field = (id: string, label: string, initial = '', multiline = false) => {
    const input = multiline
      ? node('textarea', { id, value: initial, rows: 4 })
      : node('input', { id, value: initial, type: 'text', autocomplete: 'off' })
    form.push(node('label', { className: 'stack' }, [label, input]))
    return input
  }
  const select = (id: string, label: string, values: string[]) => {
    const input = node('select', { id }, values.map(value =>
      node('option', { value, textContent: value })))
    input.value = values[0]
    form.push(node('label', { className: 'stack' }, [label, input]))
    return input
  }
  const check = (id: string, label: string) => {
    const input = node('input', { id, type: 'checkbox', checked: false })
    form.push(node('label', { className: 'check' }, [input, label]))
    return input
  }
  const availability = node('p', { id: 'native-availability', className: 'msg muted', role: 'status' })
  const heldSection = node('section', { id: 'native-held-section', className: 'stack' })
  const heldList = node('div', { id: 'native-held-list', className: 'stack' })
  heldSection.append(node('h3', { textContent: 'Held requests' }),
    node('p', { className: 'small muted', textContent:
      deps.prefs.nativeXAuto.enabled
        ? 'Held: the broker could not admit these automatically. Review and approve on this phone; request text is reference only, not permission.'
        : 'Held. Nothing runs until you review and approve on this phone. Request text is reference only, not permission.' }),
    heldList)
  const promoteBanner = node('section', { id: 'native-promote-banner', className: 'stack' })
  promoteBanner.style.display = 'none'
  const optIn = check('native-opt-in', 'Choose Factory-native for this NEW job only')
  form.push(node('p', { className: 'small muted',
    textContent: 'Legacy and Cursor jobs stay on their original backend. No conversion, default change, or X startApproved consent is inherited.' }))
  // Prefilled from pairing (REDESIGN-SPEC §4): an empty saved field takes the
  // paired computer's value; a value the owner saved is never replaced.
  const savedProfile = deps.prefs.nativeLaunchProfile
  const paired = deps.prefs.pairedHost ?? null
  const defaults: NativeLaunchProfile = {
    ...savedProfile,
    brokerUrl: savedProfile.brokerUrl || paired?.brokerUrl || '',
    // Older pairings stored the installer's "unknown" placeholder: never prefill it.
    ownerId: savedProfile.ownerId || (paired?.ownerId !== 'unknown' ? paired?.ownerId : '') || '',
    machineId: savedProfile.machineId || (paired?.machineId !== 'unknown' ? paired?.machineId : '') || '',
  }
  for (const [key, label] of [
    ['brokerUrl', 'Broker URL (no token in URL)'], ['ownerId', 'Broker owner/account ID'],
    ['machineId', 'Selected computer/machine ID'], ['cwd', 'Static mode: exact absolute workspace cwd (retained, never reinterpreted as a host root)'],
    ['baseRef', 'Selected full base ref (native host: refs/heads/branch)'],
  ] as const) profileInputs[key] = field(`native-${key}`, label, defaults[key]) as HTMLInputElement
  const workspaceMode = select('native-workspace-mode', 'Workspace allocation (explicit opt-in)', ['static', 'host_managed'])
  workspaceMode.value = defaults.workspaceMode === 'host_managed' ? 'host_managed' : 'static'
  const hostRoot = field('native-host-root', 'Host-managed mode: exact canonical host root (not a checkout)',
    defaults.hostRoot ?? '') as HTMLInputElement
  const allocationNotice = node('p', { id: 'native-allocation-notice', className: 'small muted' })
  form.push(allocationNotice)
  const credential = field('native-credential', 'Broker credential (key vault only)') as HTMLInputElement
  credential.type = 'password'
  credential.placeholder = deps.keys.nativeBroker ? 'Stored ••••; leave blank to keep' : 'Not connected'
  const save = node('button', { id: 'native-save-profile', className: 'btn secondary', textContent: 'Save future-job defaults and credential' })
  const clear = node('button', { id: 'native-clear-credential', className: 'btn secondary', textContent: 'Remove broker credential' })
  form.push(node('div', { className: 'btns' }, [save, clear]))
  form.push(node('h3', { textContent: 'Native delivery defaults' }), node('p', { className: 'small muted', textContent:
    'Applied to every new native job and shown read-only at review. Merge requires a PR, and a PR requires a pushed branch. Deployment is never allowed. Changing these revokes any inspected admission and both consents.' }))
  const deliveryChecks = {} as Record<keyof NativeDeliveryDefaults, HTMLInputElement>
  for (const [key, inputId, label] of [
    ['createPrivateRepositories', 'native-default-create', 'Create private repositories (new, empty, private only)'],
    ['pushBranch', 'native-default-push', 'Push branch spriite/<mission id>'],
    ['openPr', 'native-default-pr', 'Open a pull request'],
    ['mergeAfterChecks', 'native-default-merge', 'Merge after checks pass (squash; never with zero checks)'],
  ] as const) deliveryChecks[key] = check(inputId, label)
  const deliveryStatus = node('p', { id: 'native-default-status', className: 'small muted', role: 'status' })
  form.push(deliveryStatus)
  const goal = field('native-goal', 'Full owner goal/scope', '', true)
  const criteria = field('native-criteria', 'Acceptance criteria (one per line)', '', true)
  const restrictions = field('native-restrictions', 'Restrictions and exclusions (one per line)', '', true)
  const references = field('native-references', 'Reference URLs (evidence, never destination authority)', '', true)
  const baseSha = field('native-baseSha', 'Immutable base SHA (optional only if the host supports read-only resolution)')
  const operation = select('native-operation', 'Operation', ['implement', 'integrate', 'clone', 'fork', 'inspect'])
  const destination = select('native-destination', 'Destination', ['existing', 'new_repository'])
  const account = field('native-account', 'Exact destination GitHub account')
  const name = field('native-repository', 'Exact destination repository name (no generated suffix)')
  const visibility = select('native-visibility', 'Destination visibility', ['private', 'public'])
  const initialization = select('native-initialization', 'New-repository initialization', ['empty', 'scaffold', 'clone', 'fork'])
  const source = field('native-source', 'Clone/fork source URL (when applicable)')
  const deliverySummaryLine = node('p', { id: 'native-delivery-summary', className: 'msg' })
  form.push(deliverySummaryLine, node('p', { className: 'small muted', textContent:
    'Delivery follows your saved defaults above (read-only here). A new repository is always private and empty and needs "Create private repositories" on. The broker performs every push, PR and merge; the agent holds no GitHub credentials.' }))
  const settings = {} as Record<typeof settingNames[number], HTMLInputElement>
  for (const [key, label] of [
    ['modelId', 'Orchestrator model ID'], ['reasoningEffort', 'Orchestrator reasoning effort'],
    ['workerModel', 'Worker model ID'], ['workerReasoningEffort', 'Worker reasoning effort'],
    ['validationWorkerModel', 'Validation worker model ID'],
    ['validationWorkerReasoningEffort', 'Validation worker reasoning effort'],
  ] as const) settings[key] = field(`native-${key}`, `${label} (explicit for this job)`) as HTMLInputElement
  const tools = field('native-restrictToolIds',
    'Allowed tool IDs (explicit for this job; deployment-defined; one per line)', '', true)
  form.push(node('p', { id: 'native-validation-required', className: 'small muted', textContent:
    'Validation is mandatory: scrutiny enabled (skipScrutiny: false); user testing enabled (skipUserTesting: false). These are fixed safety constraints, not optional legacy defaults.' }),
  node('p', { className: 'small muted', textContent:
    'Enter nonempty, distinct tool IDs permitted by this deployment. A finite restrictToolIds list alone does not enforce filesystem, credential or publication boundaries; deployment qualification must prove those controls. Usage reporting is informational, not an enforced limit.' }))
  form.push(node('p', { className: 'small muted', textContent:
    'Models and efforts are per-job requests, not inherited or discovered defaults. No hard spending limit; usage reported next day when available.' }))
  const inspect = node('button', { id: 'native-inspect-admission', className: 'btn secondary',
    textContent: 'Inspect read-only admission', disabled: true })
  const review = node('section', { id: 'native-admission-preview', className: 'stack' })
  const reviewStatus = node('p', { id: 'native-admission-status', className: 'msg muted', role: 'status',
    textContent: 'No admission inspected. Inspection does not initialize or start a job.' })
  form.push(inspect, reviewStatus, review)
  const high = check('native-high-consent', 'I explicitly consent to Factory High autonomy for this scope and selected workspace')
  const scope = check('native-scope-consent', 'I approve the exact goal, criteria, restrictions, destination and consequences above')
  const destinationNotice = node('p', { id: 'native-destination-notice', className: 'msg', role: 'status' })
  destinationNotice.style.display = 'none'
  const goneNotice = node('p', { id: 'native-held-gone', className: 'msg', role: 'alert',
    textContent: 'This held request is no longer held (approved or dismissed elsewhere). Cancel review.' })
  goneNotice.style.display = 'none'
  const launch = node('button', { id: 'native-launch', className: 'btn', textContent: 'Prepare approved native job', disabled: true })
  const result = node('p', { id: 'native-launch-result', className: 'msg muted', role: 'status' })
  // Automatic X launches: the owner's own verified post is the consent, and the
  // broker's preview must still be launch-eligible with no holds.
  const xNative = node('input', { id: 'native-x-builds', type: 'checkbox', checked: deps.prefs.xBuildsNative })
  xNative.onchange = async () => {
    if (!(await deps.prefs.setXBuildsNative(xNative.checked))) { xNative.checked = deps.prefs.xBuildsNative; return }
    renderXAuto()
  }
  const xAutoOn = node('input', { id: 'native-x-auto', type: 'checkbox', checked: deps.prefs.nativeXAuto.enabled })
  const xAutoSave = node('button', { id: 'native-x-auto-save', className: 'btn secondary',
    textContent: 'Save these settings for X requests' })
  const xAutoStatus = node('p', { id: 'native-x-auto-status', className: 'small muted', role: 'status' })
  const xAutoCard = node('section', { id: 'native-x-auto-section', className: 'stack' }, [
    node('h3', { textContent: 'X requests' }),
    node('label', { className: 'check' }, [xNative, 'X builds run as Factory Missions on my Factory host (off: the cloud lead-session path)']),
    node('label', { className: 'check' }, [xAutoOn, 'Run my X requests automatically as Factory Missions']),
    node('p', { className: 'small muted', textContent:
      'A post from your own X account that the broker can admit with no holds launches with the saved models, tools, criteria and restrictions below, and your delivery defaults. Anything held stays here for you.' }),
    xAutoSave, xAutoStatus,
  ])
  const xAutoTemplate = () => ({
    settings: { ...Object.fromEntries(settingNames.map(key => [key, settings[key].value.trim()])),
      restrictToolIds: lines(tools.value), skipScrutiny: false, skipUserTesting: false },
    acceptanceCriteria: lines(criteria.value), restrictions: lines(restrictions.value),
  })
  const renderXAuto = () => {
    const x = deps.prefs.nativeXAuto
    xAutoOn.checked = x.enabled
    xAutoStatus.textContent = !deps.prefs.xBuildsNative
      ? 'X builds use the cloud path. Turn on "X builds run as Factory Missions on my Factory host" to use these settings.'
      : !x.template
      ? 'No settings saved for X requests yet: fill in models, tools and acceptance criteria above, then save.'
      : x.enabled ? 'On. Held X requests launch automatically when the broker admits them.'
        : 'Saved, but off. X requests wait here for your review.'
  }
  xAutoSave.onclick = async () => {
    const ok = await deps.prefs.setNativeXAuto(xAutoOn.checked, xAutoTemplate())
    xAutoStatus.textContent = ok ? '' : 'Not saved: every model and effort, at least one tool and one acceptance criterion are required.'
    if (ok) renderXAuto()
  }
  xAutoOn.onchange = async () => {
    if (!(await deps.prefs.setNativeXAuto(xAutoOn.checked))) xAutoStatus.textContent = 'Could not be saved. Try again.'
    else renderXAuto()
  }
  // Prefill an empty form from the saved X settings, so they are visible.
  const savedX = deps.prefs.nativeXAuto.template
  if (savedX) {
    for (const key of settingNames) if (!settings[key].value && typeof savedX.settings[key] === 'string') settings[key].value = savedX.settings[key] as string
    if (!tools.value && Array.isArray(savedX.settings.restrictToolIds)) tools.value = (savedX.settings.restrictToolIds as string[]).join('\n')
    if (!criteria.value) criteria.value = savedX.acceptanceCriteria.join('\n')
    if (!restrictions.value) restrictions.value = savedX.restrictions.join('\n')
  }
  renderXAuto()
  launchRoot.className = 'card stack'
  launchRoot.append(node('div', { className: 'eyebrow', textContent: 'Factory-native · explicit opt-in' }),
    availability, heldSection, promoteBanner, ...form, destinationNotice, goneNotice, launch, result, xAutoCard)
  let promoting: HeldNativeIntent | null = null
  let working = false
  let saved = false
  let outcomeUnknown = false
  let generation = 0
  let inspected: { preview: NativeAdmissionPreview; draft: NativeAdmissionRequest; fingerprint: string } | null = null
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let savingDefaults = 0
  const profile = (): NativeLaunchProfile => ({
    brokerUrl: profileInputs.brokerUrl.value.trim(), ownerId: profileInputs.ownerId.value.trim(),
    machineId: profileInputs.machineId.value.trim(), cwd: profileInputs.cwd.value.trim(),
    baseRef: profileInputs.baseRef.value.trim(),
    ...(workspaceMode.value === 'host_managed' ? { workspaceMode: 'host_managed' as const, hostRoot: hostRoot.value } : {}),
  })
  const capabilities = () => deps.nativeCapabilities?.(profile()) ?? null
  const draftInputs = [...Object.values(profileInputs), credential, goal, criteria, restrictions, references,
    operation, destination, account, name, visibility, initialization, source, baseSha,
    ...Object.values(settings), tools, optIn, workspaceMode, hostRoot]
  // Raw fields, not just trimmed semantic values: an edit always revokes approval.
  // Credential material stays inside this closure, never in a callback or DOM.
  const fingerprint = () => JSON.stringify([
    draftInputs.map(input => [input.value, 'checked' in input ? input.checked : null]),
    deps.prefs.nativeLaunchProfile, deps.prefs.nativeDeliveryDefaults, savingDefaults,
    deps.keys.nativeBroker, deps.keys.nativeBrokerFor(profile().brokerUrl),
  ])
  let lastFingerprint = fingerprint()
  const invalidate = (message: string) => {
    generation++
    inspected = null
    scope.checked = false
    high.checked = false
    saved = false
    clearTimeout(expiryTimer)
    review.replaceChildren()
    reviewStatus.textContent = message
    lastFingerprint = fingerprint()
  }
  const draft = (): NativeAdmissionRequest | null => {
    const p = nativeProfileOf(profile())
    const restrictToolIds = lines(tools.value)
    if (!p || !p.brokerUrl || !p.ownerId || !p.machineId || !p.baseRef ||
      (p.workspaceMode !== 'host_managed' && !p.cwd.startsWith('/')) || !goal.value.trim() ||
      !criteria.value.trim() || !/^[A-Za-z0-9-]+$/.test(account.value.trim()) ||
      !/^[A-Za-z0-9._-]+$/.test(name.value.trim()) || /^\.{1,2}$/.test(name.value.trim()) ||
      savingDefaults > 0 ||
      (destination.value === 'new_repository' && (!deps.prefs.nativeDeliveryDefaults.createPrivateRepositories ||
        visibility.value !== 'private' || initialization.value !== 'empty')) ||
      ((['clone', 'fork'].includes(operation.value) || ['clone', 'fork'].includes(initialization.value)) && !source.value.trim()) ||
      settingNames.some(key => !settings[key].value.trim()) ||
      !restrictToolIds.length || restrictToolIds.length > 128 ||
      restrictToolIds.some(value => !validToolId(value)) ||
      new Set(restrictToolIds).size !== restrictToolIds.length ||
      (baseSha.value.trim() && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseSha.value.trim()))) return null
    const target = { kind: destination.value as 'existing' | 'new_repository',
      account: account.value.trim(), name: name.value.trim(),
      visibility: visibility.value as 'private' | 'public',
      initialization: initialization.value as 'empty' | 'scaffold' | 'clone' | 'fork',
      ...(source.value.trim() ? { sourceUrl: source.value.trim() } : {}) }
    return {
      protocolVersion: 1, brokerUrl: p.brokerUrl, ownerId: p.ownerId, scopeRevision: 1,
      // A held goal is carried byte-for-byte; trimming would be scope drift.
      goal: promoting ? promoting.goal : goal.value.trim(), operation: operation.value as NativeIntent['operation'],
      // Before IDs exist, cwd explicitly carries the managed root. Main allocates
      // the checkout after minting; only that exact checkout is reviewed/approved.
      workspace: { machineId: p.machineId, cwd: p.workspaceMode === 'host_managed' ? p.hostRoot! : p.cwd,
        repository: `https://github.com/${account.value.trim()}/${name.value.trim()}`, baseRef: p.baseRef,
        // A new repository does not exist at admission: the broker previews a
        // deterministic empty base, so a fixed base SHA cannot apply to it.
        ...(target.kind === 'new_repository' ? {} : baseSha.value.trim() ? { baseSha: baseSha.value.trim() } : {}) },
      destination: target,
      references: promoting
        ? [...promoting.references, ...lines(references.value).filter(r => !promoting!.references.includes(r))]
        : lines(references.value),
      acceptanceCriteria: lines(criteria.value),
      restrictions: lines(restrictions.value),
      // No budget: the owner decided against a limit, and the host refuses budgeted intents.
      policy: { autonomy: 'high', ...deliveryPolicyFlags(deps.prefs.nativeDeliveryDefaults, target) },
      settings: { ...Object.fromEntries(settingNames.map(key => [key, settings[key].value.trim()])),
        restrictToolIds, skipScrutiny: false, skipUserTesting: false },
    }
  }
  const validPreview = (p: NativeAdmissionPreview, requested: NativeAdmissionRequest): boolean => {
    const observed = Date.parse(p?.observedAt), expires = Date.parse(p?.expiresAt)
    const requestedTools = requested.settings.restrictToolIds
    const expected = allocateNativeWorkspace(profile(), p?.missionId ?? '', requested.workspace, requested.destination)
    return p?.protocolVersion === 1 && typeof p.missionId === 'string' && Boolean(p.missionId) &&
      p.ownerId === requested.ownerId && typeof p.draftHash === 'string' && /^[a-f0-9]{64}$/.test(p.draftHash) &&
      Boolean(p.workspace) && p.workspace.machineId === requested.workspace.machineId &&
      Boolean(expected) && p.workspace.repository === expected!.repository && p.workspace.baseRef === requested.workspace.baseRef &&
      p.workspace.cwd === expected!.cwd && p.workspace.cwd.startsWith('/') &&
      typeof p.workspace.baseSha === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(p.workspace.baseSha) &&
      (!requested.workspace.baseSha || p.workspace.baseSha === requested.workspace.baseSha) &&
      Boolean(p.prospectiveSettings) && Object.keys(p.prospectiveSettings).length === allSettingNames.length &&
      settingNames.every(key => p.prospectiveSettings[key] === requested.settings[key]) &&
      p.prospectiveSettings.skipScrutiny === false && p.prospectiveSettings.skipUserTesting === false &&
      Array.isArray(p.prospectiveSettings.restrictToolIds) &&
      Array.isArray(requestedTools) &&
      p.prospectiveSettings.restrictToolIds.length === requestedTools.length &&
      p.prospectiveSettings.restrictToolIds.every((value, index) => value === requestedTools[index]) &&
      Number.isFinite(observed) && Number.isFinite(expires) && observed <= Date.now() + 5000 &&
      expires > observed && expires - observed <= 60_000 && expires > Date.now() && typeof p.launchEligible === 'boolean' &&
      Array.isArray(p.holds) && p.holds.every(hold => typeof hold === 'string') &&
      (!p.launchEligible || p.holds.length === 0)
  }
  const updateLaunch = () => {
    const managed = workspaceMode.value === 'host_managed'
    hostRoot.disabled = !managed || working
    profileInputs.cwd.disabled = managed || working
    allocationNotice.textContent = managed
      ? `Host root: ${hostRoot.value || '(enter and save explicitly)'}. Each job checkout is allocated as <host root>/jobs/<reserved mission id>/work after inspection reserves the ID; the actual checkout is shown for review. The retained static cwd is not used.`
      : 'Static workspace mode: the exact saved cwd is unchanged. Host-managed allocation is off; no host root is inferred.'
    if (fingerprint() !== lastFingerprint) invalidate('Draft/profile/credential changed. Inspect again before giving consent.')
    if (inspected && Date.parse(inspected.preview.expiresAt) <= Date.now()) {
      invalidate('Admission expired. Inspect again and give fresh scope and High consent.')
    }
    const current = deps.prefs.nativeDeliveryDefaults
    for (const key of Object.keys(deliveryChecks) as Array<keyof NativeDeliveryDefaults>) {
      if (!savingDefaults) deliveryChecks[key].checked = current[key]
      deliveryChecks[key].disabled = working
    }
    const plannedDestination = { kind: destination.value as 'existing' | 'new_repository', account: account.value.trim(),
      name: name.value.trim(), visibility: visibility.value as 'private' | 'public',
      initialization: initialization.value as 'empty' | 'scaffold' | 'clone' | 'fork' }
    const plannedPolicy = inspected?.draft.policy ?? deliveryPolicyFlags(current, plannedDestination)
    deliverySummaryLine.textContent = savingDefaults ? 'Saving delivery defaults…'
      : plannedDestination.kind === 'new_repository' && !current.createPrivateRepositories
        ? 'A new repository needs "Create private repositories" on in delivery defaults.'
        : plannedDestination.kind === 'new_repository' && (plannedDestination.visibility !== 'private' || plannedDestination.initialization !== 'empty')
          ? 'A new repository must be private and empty.'
          : deliverySummary(plannedPolicy, inspected?.preview.missionId ?? '', inspected?.draft.destination ?? plannedDestination)
    const c = capabilities()
    availability.textContent = qualified(c)
      ? `Broker qualification ${c!.qualificationId}; transport ${c!.transportVersion}. Workspace/policy preflight and Factory's own plan approval request (plus a separate start request, if Factory sends one) still required.`
      : 'Native execution unavailable: broker transport, recovery and policy are not qualified. Drafts and legacy/Cursor backends remain available.'
    const repoOf = (url: string) => url.trim().replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase()
    const destinationChanged = Boolean(promoting) &&
      repoOf(`https://github.com/${account.value.trim()}/${name.value.trim()}`) !==
        repoOf(promoting!.destination?.kind === 'new_repository'
          ? `https://github.com/${promoting!.destination.account}/${promoting!.destination.name}` : promoting!.repository)
    destinationNotice.textContent = destinationChanged
      ? `Destination changed from ${promoting!.repository || 'no held repository'}. Your consent covers the destination shown above, not the held one.` : ''
    destinationNotice.style.display = destinationChanged ? '' : 'none'
    const heldGone = Boolean(promoting) && !saved && !working &&
      !(deps.heldNativeIntents?.() ?? []).some(h => h.missionId === promoting!.missionId)
    goneNotice.style.display = heldGone ? '' : 'none'
    const eligible = Boolean(inspected?.preview.launchEligible && inspected.fingerprint === fingerprint())
    scope.disabled = high.disabled = working || saved || outcomeUnknown || !eligible
    if (!eligible) { scope.checked = false; high.checked = false }
    inspect.disabled = working || saved || outcomeUnknown || !deps.onNativeAdmission || !optIn.checked ||
      Boolean(credential.value) || !deps.keys.nativeBrokerFor(profile().brokerUrl) || !draft()
    launch.disabled = working || saved || outcomeUnknown || !qualified(c) || !deps.onNativeAdmission ||
      !(promoting ? deps.onPromoteHeld : deps.onNativeLaunch) || !eligible || Boolean(credential.value) ||
      !deps.keys.nativeBrokerFor(profile().brokerUrl) || !optIn.checked || !scope.checked || !high.checked ||
      heldGone || (destinationChanged && destinationNotice.style.display === 'none')
  }
  const revoke = () => { invalidate('Draft changed. Inspect again before giving scope and High consent.'); updateLaunch() }
  for (const key of Object.keys(deliveryChecks) as Array<keyof NativeDeliveryDefaults>) {
    deliveryChecks[key].onchange = async () => {
      if (working) { updateLaunch(); return }
      const base = Object.fromEntries((Object.keys(deliveryChecks) as Array<keyof NativeDeliveryDefaults>)
        .map(k => [k, deliveryChecks[k].checked])) as unknown as NativeDeliveryDefaults
      const next = toggleDeliveryDefault(base, key, deliveryChecks[key].checked)
      for (const k of Object.keys(deliveryChecks) as Array<keyof NativeDeliveryDefaults>) deliveryChecks[k].checked = next[k]
      savingDefaults++
      invalidate('Delivery defaults changed. Admission and both consents were revoked; inspect again.')
      updateLaunch()
      let ok = false
      try { ok = await deps.prefs.setNativeDeliveryDefaults(next) } catch { ok = false }
      savingDefaults--
      deliveryStatus.textContent = ok ? 'Delivery defaults saved for new native jobs.'
        : 'Delivery defaults were not saved; the previous defaults still apply.'
      if (ok) deps.onSaved()
      invalidate('Delivery defaults changed. Admission and both consents were revoked; inspect again.')
      updateLaunch()
    }
  }
  for (const input of draftInputs) {
    input.addEventListener('input', revoke)
    input.addEventListener('change', revoke)
  }
  for (const input of [scope, high]) input.onchange = updateLaunch
  inspect.onclick = async () => {
    updateLaunch()
    if (inspect.disabled) return
    invalidate('Inspecting read-only admission; no job is initialized or started.')
    const requested = frozenCopy(draft()!)
    const expected = fingerprint()
    const attempt = generation
    working = true
    updateLaunch()
    try {
      const response = await deps.onNativeAdmission!(requested)
      if (attempt !== generation || expected !== fingerprint()) return
      if (!validPreview(response, requested)) {
        reviewStatus.textContent = 'Admission rejected: stale/invalid preview or requested workspace/settings mismatch. Draft kept; inspect explicitly to retry.'
        return
      }
      const preview = frozenCopy(response)
      inspected = { preview, draft: requested, fingerprint: expected }
      reviewStatus.textContent = preview.launchEligible
        ? 'Read-only admission eligible. Review the resolved workspace and prospective settings, then give separate scope and High consent.'
        : 'Admission held. No launch or consent is available; draft retained.'
      review.append(node('p', { className: 'small', textContent:
        `Owner ${preview.ownerId}; reserved mission ${preview.missionId}; draft hash ${preview.draftHash}.` }),
      ...(profile().workspaceMode === 'host_managed' ? [node('p', { id: 'native-preview-allocation', className: 'bubble', textContent:
        `Explicit host-managed allocation\nHost root: ${profile().hostRoot}\nJob checkout: ${preview.workspace.cwd}\nReserved mission: ${preview.missionId}\nThis exact allocation is bound into the inspected draft hash. It is not an arbitrary broker-selected cwd.` })] : []),
      node('p', { className: 'bubble', textContent:
        `${requested.destination?.kind === 'new_repository' ? 'Prospective workspace (not provisioned)' : 'Resolved canonical workspace'}: ${preview.workspace.cwd}\nMachine: ${preview.workspace.machineId}\nRepository: ${preview.workspace.repository}\nBase ref: ${preview.workspace.baseRef}\n${requested.destination?.kind === 'new_repository' ? 'Prospective empty base SHA' : 'Immutable base SHA'}: ${preview.workspace.baseSha}` +
        (requested.destination?.kind === 'new_repository'
          ? '\nThe new private repository is created only after approval, during prepare, not admission; this prospective preview uses a deterministic empty base. Live workspace enforcement still requires prepare and qualification.'
          : '') }),
      node('p', { className: 'bubble', textContent:
        `Prospective settings (not initialized/effective settings):\n${allSettingNames.map(key => `${key}: ${Array.isArray(preview.prospectiveSettings[key]) ? JSON.stringify(preview.prospectiveSettings[key]) : preview.prospectiveSettings[key]}`).join('\n')}\nValidation mandatory: scrutiny and user testing enabled.\nNo hard spending limit; usage reported next day when available.` }),
      node('p', { id: 'native-preview-delivery', className: 'bubble', textContent:
        deliverySummary(requested.policy, preview.missionId, requested.destination) }),
      node('p', { className: 'small', textContent:
        `Observed: ${preview.observedAt}; expires: ${preview.expiresAt}. Holds: ${preview.holds.join('; ') || 'none'}.` }))
      expiryTimer = setTimeout(updateLaunch, Math.min(2_147_483_647, Date.parse(preview.expiresAt) - Date.now() + 1))
      // Node's lightweight DOM suites must not remain alive for a fixture expiry.
      ;(expiryTimer as unknown as { unref?: () => void }).unref?.()
    } catch {
      if (attempt === generation && expected === fingerprint()) {
        reviewStatus.textContent = 'Read-only admission failed. Draft kept; no automatic retry or launch.'
      }
    } finally { working = false; updateLaunch() }
  }
  save.onclick = async () => {
    if (working) return
    const clean = nativeProfileOf(profile())
    if (!clean) { result.textContent = 'Invalid non-secret profile. Use HTTPS (or localhost HTTP); no URL credentials, query or fragment.'; return }
    const credentialDraft = credential.value
    invalidate('Saving defaults/credential revokes admission and both consents.')
    working = true
    updateLaunch()
    try {
      const profileSaved = await deps.prefs.setNativeLaunchProfile(clean)
      const keySaved = credentialDraft.trim() ? await deps.keys.setNativeBroker(credentialDraft, clean.brokerUrl) : true
      if (keySaved && credential.value === credentialDraft) credential.value = ''
      credential.placeholder = deps.keys.nativeBroker ? 'Stored ••••; leave blank to keep' : 'Not connected'
      result.textContent = profileSaved && keySaved
        ? 'Defaults saved for future jobs only. This does not qualify the broker or grant launch consent.'
        : `Save incomplete: profile ${profileSaved ? 'saved' : 'not saved'}, credential ${keySaved ? 'unchanged or saved' : 'not saved'}.`
      deps.onSaved()
    } catch { result.textContent = 'Save failed. Review the retained fields; nothing was launched.' }
    finally { working = false; revoke() }
  }
  clear.onclick = async () => {
    if (working) return
    invalidate('Removing the credential revokes admission and both consents.')
    working = true
    updateLaunch()
    try {
      result.textContent = await deps.keys.clearNativeBroker() ? 'Broker credential removed.' : 'Credential removal could not be saved.'
      credential.value = ''
      credential.placeholder = deps.keys.nativeBroker ? 'Stored ••••' : 'Not connected'
      deps.onSaved()
    } catch { result.textContent = 'Credential removal could not be saved.' }
    finally { working = false; revoke() }
  }
  launch.onclick = async () => {
    updateLaunch()
    if (launch.disabled) return
    const current = inspected!
    const request: NativeLaunchRequest = frozenCopy({
      ...current.draft, workspace: current.preview.workspace, settings: current.preview.prospectiveSettings,
      admission: current.preview, scopeApproved: true, highAutonomyApproved: true,
    })
    const held = promoting
    if (held && request.goal !== held.goal) {
      result.textContent = 'Held goal changed. Nothing was sent; cancel the review and start again.'
      return
    }
    working = true
    updateLaunch()
    try {
      const outcome = held
        ? await deps.onPromoteHeld!(held.missionId, request)
        : await deps.onNativeLaunch!(request)
      if (!outcome || !['saved', 'held', 'failed'].includes(outcome.status)) throw new Error('Unknown prepare receipt')
      saved = outcome.status === 'saved' || outcome.status === 'held'
      if (held && saved) {
        heldNotes.set(held.missionId, 'Approved on this phone as a new native job (saved, not running).')
        endReview()
      }
      result.textContent = outcome.status === 'saved'
        ? 'Native intent saved, not running. Wait for broker preflight and the exact Factory plan approval request; some Factory versions also send a separate start request.'
        : `${outcome.status === 'held' ? 'Native job held' : 'Native intent not saved'}: ${outcome.reason ?? 'Review the broker status'}. Draft kept; no automatic retry.`
      if (saved) { optIn.checked = false; scope.checked = false; high.checked = false }
    } catch {
      // Invocation may have reached a durable broker despite response loss.
      saved = true
      outcomeUnknown = true
      result.textContent = 'Prepare outcome unknown. Draft kept. Check the broker before attempting another job; nothing is retried automatically.'
    } finally { working = false; updateLaunch(); renderHeld() }
  }

  type HeldRow = { element: HTMLElement; signature: string; status: HTMLParagraphElement;
    reviewButton: HTMLButtonElement; dismissButton: HTMLButtonElement; confirmBox: HTMLElement }
  const heldRows = new Map<string, HeldRow>()
  const heldNotes = new Map<string, string>()
  const heldBusy = new Set<string>()
  const heldUnknown = new Set<string>()
  const wrapped = <T extends HTMLElement>(element: T): T => {
    element.style.whiteSpace = 'pre-wrap'
    element.style.overflowWrap = 'anywhere'
    return element
  }
  const endReview = () => {
    promoting = null
    goal.readOnly = false
    promoteBanner.style.display = 'none'
    promoteBanner.replaceChildren()
    launch.textContent = 'Prepare approved native job'
  }
  const cancelReview = () => {
    if (!promoting || working) return
    endReview()
    goal.value = ''
    references.value = ''
    invalidate('Review cancelled. The held request stays held; nothing was approved.')
    result.textContent = ''
    updateLaunch()
    renderHeld()
  }
  const startReview = (held: HeldNativeIntent) => {
    if (working || outcomeUnknown) {
      result.textContent = 'Finish or resolve the current job before reviewing a held request.'
      return
    }
    const intent = frozenCopy(held)
    goal.value = intent.goal
    references.value = intent.references.join('\n')
    const repo = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(intent.repository)
    if (intent.destination?.kind === 'new_repository') {
      account.value = intent.destination.account; name.value = intent.destination.name
      destination.value = 'new_repository'; visibility.value = 'private'; initialization.value = 'empty'
    } else if (repo) { account.value = repo[1]; name.value = repo[2]; destination.value = 'existing' }
    promoting = intent
    goal.readOnly = true
    launch.textContent = 'Approve held request as native job'
    const cancel = node('button', { id: 'native-cancel-review', className: 'btn secondary', textContent: 'Cancel review' })
    cancel.onclick = cancelReview
    promoteBanner.replaceChildren(
      node('p', { className: 'eyebrow', textContent: `Promoting ${intent.missionId}` }),
      node('p', { className: 'msg', textContent:
        `${intent.origin === 'x' ? 'From X post' : 'Saved request'} — reference only, not permission. The goal is locked to the exact held text; inspect the broker and give both consents yourself.` }),
      cancel)
    promoteBanner.style.display = ''
    invalidate('Held request loaded for review. Any earlier admission and consent were revoked; inspect again.')
    result.textContent = 'Held. Nothing runs until you review and approve on this phone.'
    updateLaunch()
    renderHeld()
  }
  const dismissHeld = async (held: HeldNativeIntent, row: HeldRow) => {
    if (heldBusy.has(held.missionId) || heldUnknown.has(held.missionId) || !deps.onDismissHeld) return
    heldBusy.add(held.missionId)
    row.confirmBox.replaceChildren()
    renderHeld()
    try {
      const done = await deps.onDismissHeld(held.missionId)
      heldNotes.set(held.missionId, done
        ? 'Dismissed. This request will not run.'
        : 'Dismiss was not saved. The request is still held; nothing runs.')
    } catch {
      heldUnknown.add(held.missionId)
      heldNotes.set(held.missionId, 'Dismiss outcome unknown. Check again later; nothing is retried automatically.')
    } finally {
      heldBusy.delete(held.missionId)
      renderHeld()
    }
  }
  const buildHeldRow = (held: HeldNativeIntent): HeldRow => {
    const status = node('p', { className: 'msg muted', role: 'status' })
    const reviewButton = node('button', { className: 'btn secondary', textContent: 'Review as native job' })
    const dismissButton = node('button', { className: 'btn secondary', textContent: 'Dismiss' })
    const confirmBox = node('div', { className: 'btns' })
    const element = node('section', { className: 'stack native-held-row' }, [
      node('p', { className: 'eyebrow', textContent: held.origin === 'x' ? 'From X' : 'Saved request' }),
      wrapped(node('p', { className: 'bubble native-held-goal', textContent: held.goal })),
      wrapped(node('p', { className: 'small muted', textContent:
        `Repository: ${held.repository || 'none'}\nReferences: ${held.references.join('\n') || 'none'}\nReceived: ${held.createdAt}\nHeld mission ${held.missionId}` })),
      node('div', { className: 'btns' }, [reviewButton, dismissButton]), confirmBox, status,
    ])
    element.dataset.heldId = held.missionId
    const row: HeldRow = { element, signature: JSON.stringify(held), status, reviewButton, dismissButton, confirmBox }
    reviewButton.onclick = () => startReview(held)
    dismissButton.onclick = () => {
      if (heldBusy.has(held.missionId) || heldUnknown.has(held.missionId)) return
      const yes = node('button', { className: 'btn', textContent: 'Confirm dismiss' })
      const no = node('button', { className: 'btn secondary', textContent: 'Keep held' })
      yes.onclick = () => { void dismissHeld(held, row) }
      no.onclick = () => { confirmBox.replaceChildren() }
      confirmBox.replaceChildren(node('span', { className: 'small', textContent: 'Dismiss this held request? It will never run.' }), yes, no)
    }
    return row
  }
  const renderHeld = () => {
    const list = deps.heldNativeIntents?.() ?? []
    heldSection.style.display = deps.heldNativeIntents ? '' : 'none'
    const present = new Set(list.map(h => h.missionId))
    for (const [id, row] of heldRows) {
      // Rows with an outcome or in-flight action stay so the owner sees the honest result.
      if (!present.has(id) && !heldBusy.has(id) && !heldNotes.has(id) && promoting?.missionId !== id) {
        row.element.remove(); heldRows.delete(id)
      }
    }
    for (const held of list) {
      const existing = heldRows.get(held.missionId)
      if (existing && (existing.signature === JSON.stringify(held) || heldBusy.has(held.missionId) ||
        existing.confirmBox.childElementCount)) continue
      const row = buildHeldRow(held)
      if (existing) existing.element.replaceWith(row.element)
      heldRows.set(held.missionId, row)
    }
    const order = [...list.map(h => h.missionId), ...[...heldRows.keys()].filter(id => !present.has(id))]
    order.forEach((id, index) => {
      const element = heldRows.get(id)!.element
      if (heldList.children[index] !== element) heldList.insertBefore(element, heldList.children[index] ?? null)
    })
    for (const [id, row] of heldRows) {
      const busy = heldBusy.has(id), unknown = heldUnknown.has(id), note = heldNotes.get(id)
      const finished = !present.has(id) || note?.startsWith('Dismissed') || note?.startsWith('Approved')
      row.reviewButton.disabled = busy || unknown || Boolean(finished) || working || promoting?.missionId === id
      row.dismissButton.disabled = busy || unknown || Boolean(finished) || !deps.onDismissHeld || promoting?.missionId === id
      row.status.textContent = busy ? 'Dismissing…' : note ?? (promoting?.missionId === id
        ? 'Under review on this phone. Held; nothing runs until you approve.'
        : 'Held. Nothing runs until you review and approve on this phone.')
    }
    if (!heldRows.size) heldList.replaceChildren(node('p', { className: 'small muted', textContent: 'No held requests.' }))
    else heldList.querySelector(':scope > p')?.remove()
  }

  type AnswerDraft = { selections: Map<number, string[]>; text: Map<number, string>; selected: string | null; note: string; sending: boolean }
  const drafts = new Map<string, AnswerDraft>()
  // Feature/check reports and the observation time change on most reads;
  // each has its own node so they never rebuild request rows (which would
  // drop focus, caret and scroll inside an answer being typed).
  const header = node('div', { className: 'stack' })
  const observed = node('p', { className: 'small muted', id: 'native-observed' })
  const featureBox = node('div', { className: 'stack', id: 'native-feature-section' })
  const deliveryBox = node('p', { className: 'msg', id: 'native-delivery-state', role: 'status' })
  const renderDelivery = (s: NativeSnapshot) => {
    const parts: string[] = []
    if (s.delivery) {
      parts.push(`${deliveryLine(s.delivery)}.`, deliveryDelivered(s.delivery)
        ? 'Delivered: the broker merged this PR after its checks passed.'
        : 'Not delivered yet; only a merged PR counts as delivered.')
      if (s.delivery.prUrl) parts.push(`PR: ${s.delivery.prUrl}`)
      parts.push(s.delivery.headSha
        ? `Branch ${s.delivery.branch} at ${s.delivery.headSha.slice(0, 12)}; updated ${s.delivery.updatedAt}.`
        : `Branch ${s.delivery.branch} has no pushed head; updated ${s.delivery.updatedAt}.`)
    } else if (s.state === 'completed') parts.push('No broker delivery reported. Work is not delivered.')
    if (s.usage) parts.push(`${usageLine(s.usage)}. Reported the next day; never an enforced budget.`)
    if (s.diagnostics?.length) parts.push(`Ignored unrecognized broker data: ${s.diagnostics.join(', ')}.`)
    deliveryBox.textContent = parts.join(' ')
    deliveryBox.style.display = parts.length ? '' : 'none'
  }
  const requestBox = node('div', { className: 'stack', id: 'native-request-rows' })
  let rendered = ''
  let featuresRendered = ''
  const renderFeatures = (s: NativeSnapshot) => {
    const signature = JSON.stringify(s.features)
    if (signature === featuresRendered) return
    featuresRendered = signature
    featureBox.style.display = s.features.length ? '' : 'none'
    if (!s.features.length) { featureBox.replaceChildren(); return }
    const counts = nativeFeatureCounts(s.features)
    const list = node('ul', { id: 'native-feature-list', className: 'small' },
      s.features.slice(0, PHONE_FEATURE_ROWS).map(f => node('li', { textContent:
        `${NATIVE_FEATURE_STATUS_WORD[f.status]} · ${f.milestone ? `${f.milestone}: ` : ''}${f.description}` +
        (f.expectedBehavior.length ? ` (expected: ${f.expectedBehavior.join('; ')})` : '') })))
    if (s.features.length > PHONE_FEATURE_ROWS) list.append(node('li', { textContent:
      `${s.features.length - PHONE_FEATURE_ROWS} more not shown; open the Factory session for the full list.` }))
    featureBox.replaceChildren(node('section', { className: 'stack' }, [
      node('h3', { textContent: `Factory-reported features or checks · ${nativeFeatureTally(counts)}` }),
      node('p', { className: 'small muted', textContent: 'Provider report only; unmet, pending and cancelled/waived items are not done. Not verified acceptance.' }),
      boundedBlock(list),
    ]))
  }
  const renderAttention = () => {
    const engine = deps.engine()
    const s = engine.nativeSnapshot?.() ?? null
    attentionRoot.id = 'native-request-panel'
    attentionRoot.className = 'card stack'
    attentionRoot.style.display = s ? '' : 'none'
    if (!s) { rendered = ''; featuresRendered = ''; return }
    if (attentionRoot.children[0] !== header) attentionRoot.replaceChildren(header, deliveryBox, featureBox, requestBox)
    renderDelivery(s)
    observed.textContent =
      `Owner ${s.ownerId} · mission ${s.missionId} · scope ${s.scopeRevision}. ${s.completeness}; last observed ${s.lastObservedAt ?? 'never'}. Answer sent is not request resolved.`
    renderFeatures(s)
    const signature = JSON.stringify([s.missionId, s.ownerId, s.scopeRevision, s.attention,
      s.capabilities, s.completeness, s.binding, s.state, s.control, s.commands,
      engine.hasUnconfirmedDelivery, engine.factorySessionLink?.(), typeof engine.answerNative])
    if (signature === rendered) return
    rendered = signature
    const parts: HTMLElement[] = [
      node('div', { className: 'eyebrow', textContent: `Native requests · ${s.attention.filter(a => a.state !== 'resolved').length} pending` }),
      observed,
    ]
    const handoff = engine.factorySessionLink?.()
    if (handoff) parts.push(node('a', { className: 'btn secondary', textContent: 'Open exact owning Factory session',
      href: handoff, target: '_blank', rel: 'noopener noreferrer' }))
    else parts.push(node('p', { className: 'small muted', textContent: 'Exact Factory session link is unavailable; do not answer in another chat.' }))
    header.replaceChildren(...parts)
    const rows: HTMLElement[] = []
    // Current asks lead; retained resolved history must not bury an urgent popup.
    const attention = [...s.attention].sort((a, b) =>
      Number(a.state === 'resolved') - Number(b.state === 'resolved'))
    for (const a of attention) {
      const key = requestKey(s, a)
      const draft = drafts.get(key) ?? { selections: new Map(), text: new Map(), selected: null, note: '', sending: false }
      drafts.set(key, draft)
      const status = node('p', { className: 'msg muted', role: 'status', textContent: a.state === 'resolved'
        ? 'Resolved by authoritative native observation.' : draft.note || (a.state === 'answer_unknown'
          ? 'Answer delivery is unknown; check Factory. Do not resend.' : 'Open; no answer has been sent.') })
      const row = node('section', { className: 'stack' }, [
        node('h3', { textContent: `${a.kind}: ${a.title}` }),
        boundedBlock(node('p', { className: 'bubble', textContent: a.details })),
        node('p', { className: 'small muted', textContent:
          `Attention ${a.attentionId}; request ${a.requestId}; revision ${a.revision}; payload hash ${a.payloadHash}. Machine ${a.machineId}; session ${a.sessionId}; tool uses ${a.toolUseIds.join(', ') || 'none'}; associated sessions ${a.associatedSessionIds.join(', ') || 'none'}.` }),
      ])
      row.append(node('a', {
        className: 'btn secondary', textContent: 'Open this request’s exact Factory session',
        href: `https://app.factory.ai/sessions/${encodeURIComponent(a.sessionId)}`,
        target: '_blank', rel: 'noopener noreferrer',
      }))
      const supported = canAnswer(s, a, engine)
      const controls: HTMLInputElement[] = []
      for (const q of a.questions) {
        row.append(node('h4', { textContent: `Question ${q.index} · ${q.topic}${q.multiSelect ? ' · select multiple' : ''}` }),
          node('p', { className: 'bubble', textContent: q.question }))
        for (const option of q.options) {
          const input = node('input', { type: q.multiSelect ? 'checkbox' : 'radio',
            name: `native-${key}-${q.index}`, value: option.value, disabled: !supported,
            checked: draft.selections.get(q.index)?.includes(option.value) ?? false })
          controls.push(input)
          input.onchange = () => {
            const previous = draft.selections.get(q.index) ?? []
            draft.selections.set(q.index, q.multiSelect
              ? input.checked ? [...new Set([...previous, option.value])] : previous.filter(v => v !== option.value)
              : [option.value])
          }
          row.append(node('label', { className: 'check' }, [input, `${option.label} [id ${option.id}; raw value ${option.value}]`]))
        }
        if (!q.options.length) {
          const text = node('textarea', { rows: 3, value: draft.text.get(q.index) ?? '', disabled: !supported })
          text.addEventListener('input', () => { draft.text.set(q.index, text.value) })
          row.append(text)
        }
      }
      for (const option of a.options) {
        const editedSpec = option.value === 'proceed_edit'
        const input = node('input', { type: 'radio', name: `native-${key}-outcome`, value: option.value,
          checked: draft.selected === option.value, disabled: !supported || editedSpec })
        controls.push(input)
        input.onchange = () => { draft.selected = option.value }
        row.append(node('label', { className: 'check' }, [input,
          `${option.label} [id ${option.id}; raw value ${option.value}]${editedSpec ? ' — edited-spec content requires Factory' : ''}`]))
      }
      const submit = node('button', { className: 'btn', textContent: 'Send exact native answer',
        disabled: !supported || draft.sending || Boolean(draft.note) })
      submit.onclick = async () => {
        const current = deps.engine().nativeSnapshot?.()
        const exact = current?.attention.find(candidate => candidate.attentionId === a.attentionId)
        if (deps.engine() !== engine || !current || !exact ||
          requestKey(current, exact) !== key || exact.state !== 'open' ||
          JSON.stringify(exact) !== JSON.stringify(a) ||
          !canAnswer(current, exact, engine) || !supported || draft.sending || draft.note) {
          status.textContent = 'Request ownership/revision changed. Full draft kept; nothing sent. Use the exact Factory handoff if unavailable.'
          return
        }
        const answer: NativeAnswer = { attentionId: a.attentionId, requestId: a.requestId,
          sessionId: a.sessionId, machineId: a.machineId, revision: a.revision, payloadHash: a.payloadHash }
        if (a.kind === 'ask_user') {
          if (!a.questions.length) { status.textContent = 'Full questionnaire is unavailable; use Factory.'; return }
          const answers = a.questions.map(q => {
            const selected = draft.selections.get(q.index) ?? []
            return { index: q.index, answer: q.options.length
              ? q.multiSelect ? JSON.stringify(selected) : selected[0] ?? ''
              : draft.text.get(q.index) ?? '' }
          })
          if (answers.some((entry, i) => !entry.answer.trim() ||
            (a.questions[i].multiSelect && entry.answer === '[]'))) {
            status.textContent = 'Answer every question. Draft kept; nothing sent.'
            return
          }
          answer.answers = answers
        } else {
          if (draft.selected === 'proceed_edit' || !a.options.some(option => option.value === draft.selected)) {
            status.textContent = 'Choose an actual offered native outcome; ordinary text is not permission.'
            return
          }
          answer.selectedOption = draft.selected!
        }
        draft.sending = true
        submit.disabled = true
        for (const control of controls) control.disabled = true
        try {
          const sent = await engine.answerNative!(answer)
          draft.note = sent
            ? 'Answer sent; waiting for matching native resolution. Draft kept.'
            : 'Answer not accepted or delivery uncertain. Draft kept; check broker/Factory before retrying.'
        } catch { draft.note = 'Answer outcome unknown. Draft kept; check broker/Factory. Do not resend.' }
        finally { draft.sending = false; status.textContent = draft.note }
      }
      row.append(submit, status)
      if (!supported && a.state !== 'resolved') row.append(node('p', { className: 'small muted',
        textContent: 'This exact request cannot be answered here under the current qualified capability/completeness gate. Review full details in the owning Factory session. Custom/edited-spec outcomes unsupported by the protocol require Factory.' }))
      rows.push(row)
    }
    const activeKeys = new Set(s.attention.map(a => requestKey(s, a)))
    for (const [key, draft] of drafts) {
      if (activeKeys.has(key) || (draft.selected === null && !draft.selections.size && !draft.text.size)) continue
      rows.push(node('section', { className: 'stack' }, [
        node('h3', { textContent: 'Retained native answer draft — old target/revision' }),
        node('p', { className: 'small muted', textContent: `Binding ${key}. Never rerouted or sent automatically.` }),
        node('textarea', { rows: 4, readOnly: true, value: JSON.stringify({
          selectedOption: draft.selected, selections: [...draft.selections], text: [...draft.text],
        }, null, 2) }),
      ]))
    }
    requestBox.replaceChildren(...rows)
  }
  const refresh = () => { updateLaunch(); renderHeld(); renderAttention() }
  refresh()
  return { refresh }
}
