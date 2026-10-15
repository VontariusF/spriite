/**
 * Host-side launch of a routed X request as a native Factory Mission.
 *
 * The intent is the one the phone builds for an automatic X launch
 * (src/native/x-auto.ts xAutoAdmissionRequest) with the host-managed checkout
 * allocated the way the phone's admission coordinator allocates it. It goes
 * through exactly the broker's own path: the read-only admission preview, which
 * must be launch-eligible with no holds, then prepare with both consents. The
 * owner's own verified post is the consent; nothing here widens what the broker
 * accepts. Every refusal is returned as a hold with its reason, never retried.
 */
import { BrokerError, fail, hash, id, str } from './validation.mjs'
import { nativeConsequences, validateFullGitRef } from './native-policy.mjs'
import { NATIVE_NEW_REPOSITORY_BASE } from './native-host.mjs'
import { validGithubAccount, validRepositoryName } from './x-rules.mjs'

const SETTING_NAMES = ['modelId', 'reasoningEffort', 'workerModel', 'workerReasoningEffort',
  'validationWorkerModel', 'validationWorkerReasoningEffort']
const DELIVERY_KEYS = ['createPrivateRepositories', 'pushBranch', 'openPr', 'mergeAfterChecks']
const TOOL_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const text = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max
const lines = v => Array.isArray(v) && v.length <= 64 && v.every(x => text(x, 4096)) ? v.map(x => x.trim()) : null
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

/** The saved X template, or null when any field would not pass the phone's own draft checks. */
export function xLaunchTemplate(raw) {
  if (!plain(raw) || Object.keys(raw).some(k => !['settings', 'acceptanceCriteria', 'restrictions'].includes(k))) return null
  const s = raw.settings
  if (!plain(s) || SETTING_NAMES.some(k => !text(s[k], 256))) return null
  const tools = s.restrictToolIds
  if (!Array.isArray(tools) || !tools.length || tools.length > 128 || new Set(tools).size !== tools.length ||
    tools.some(t => typeof t !== 'string' || !TOOL_ID.test(t))) return null
  if (Object.keys(s).some(k => ![...SETTING_NAMES, 'restrictToolIds', 'skipScrutiny', 'skipUserTesting'].includes(k)) ||
    (s.skipScrutiny !== undefined && s.skipScrutiny !== false) ||
    (s.skipUserTesting !== undefined && s.skipUserTesting !== false)) return null
  const criteria = lines(raw.acceptanceCriteria), restrictions = lines(raw.restrictions ?? [])
  if (!criteria || !criteria.length || !restrictions) return null
  return {
    settings: { ...Object.fromEntries(SETTING_NAMES.map(k => [k, s[k].trim()])),
      restrictToolIds: [...tools], skipScrutiny: false, skipUserTesting: false },
    acceptanceCriteria: criteria, restrictions,
  }
}

/** Delivery defaults with the phone's chain rule: a later step never stands without its prerequisite. */
export function xLaunchDelivery(raw) {
  if (!plain(raw) || Object.keys(raw).some(k => !DELIVERY_KEYS.includes(k)) ||
    DELIVERY_KEYS.some(k => typeof raw[k] !== 'boolean')) return null
  const pushBranch = raw.pushBranch, openPr = pushBranch && raw.openPr
  return { createPrivateRepositories: raw.createPrivateRepositories, pushBranch, openPr,
    mergeAfterChecks: openPr && raw.mergeAfterChecks }
}

/** Same spelling rule as the phone's host root: absolute, canonical, never `/`. */
function hostRootOf(value) {
  str(value, 1800)
  if (!value.startsWith('/') || value === '/' || /[\x00-\x1f\x7f\\]/.test(value) || value !== value.trim() ||
      value.split('/').slice(1).some(part => part === '' || part === '.' || part === '..')) fail('x_launch_host_root_invalid', 503)
  return value
}

// Deterministic per logical post: a crash between prepare and the reader's
// receipt replays onto the same broker job instead of launching a second one.
const defaultMint = (kind, request) => `x-${kind}-${hash(['spriite_x_launch', kind, request.dedupeKey]).slice(0, 32)}`

function requestProblem(r) {
  if (!plain(r)) return 'shape'
  if (typeof r.goal !== 'string' || !r.goal.trim() || r.goal.length > 32768) return 'goal'
  if (!Array.isArray(r.references) || r.references.length > 128 ||
      r.references.some(x => typeof x !== 'string' || !x || x.length > 8192)) return 'references'
  const d = r.destination
  if (!plain(d) || !['existing', 'new_repository'].includes(d.kind) ||
      typeof d.account !== 'string' || !validGithubAccount(d.account) ||
      typeof d.name !== 'string' || !validRepositoryName(d.name)) return 'destination'
  if (typeof r.logicalPostId !== 'string' || !/^\d{1,20}$/.test(r.logicalPostId)) return 'post'
  if (typeof r.dedupeKey !== 'string' || !r.dedupeKey || r.dedupeKey.length > 256) return 'dedupe'
  return null
}

const REPO = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/

/**
 * The reader hands over `{instruction, postUrl, destination: {kind:'existing',
 * repository} | {kind:'new_repository', name}, ...}`; a routed request may also
 * arrive as `{goal, references, destination: {kind, account, name}}`. Both
 * become the routed shape. A new repository lives under the owner's account.
 */
function routed(r, account) {
  if (!plain(r) || typeof r.instruction !== 'string') return r
  const d = r.destination
  let destination = null
  if (plain(d) && d.kind === 'existing' && typeof d.repository === 'string') {
    const m = REPO.exec(d.repository)
    if (m) destination = { kind: 'existing', account: m[1], name: m[2] }
  } else if (plain(d) && d.kind === 'new_repository' && account !== null) {
    destination = { kind: 'new_repository', account, name: d.name }
  }
  return { goal: r.instruction, references: typeof r.postUrl === 'string' && r.postUrl ? [r.postUrl] : [],
    destination, logicalPostId: r.logicalPostId, dedupeKey: r.dedupeKey }
}

const codeOf = error => error instanceof BrokerError && /^[a-z0-9_]{1,128}$/.test(error.code) ? error.code : 'broker_unavailable'

/**
 * `launch(request)` → `{status:'submitted', missionId}` | `{status:'held', reason}`.
 * It never throws for a request; a broken configuration fails at creation.
 */
export function createXLauncher({
  broker, ownerId, machineId, hostRoot, baseRef = 'refs/heads/main', template, delivery,
  newRepositoryAccount = null, mint = defaultMint,
}) {
  if (!broker || typeof broker.inspectAdmission !== 'function' || typeof broker.prepare !== 'function') fail('x_launch_broker_required', 503)
  id(ownerId); id(machineId); hostRootOf(hostRoot); validateFullGitRef(baseRef)
  const saved = xLaunchTemplate(template), defaults = xLaunchDelivery(delivery)
  if (!saved) fail('x_launch_template_invalid', 503)
  if (!defaults) fail('x_launch_delivery_invalid', 503)
  if (typeof mint !== 'function') fail('x_launch_mint_invalid', 503)
  if (newRepositoryAccount !== null && (typeof newRepositoryAccount !== 'string' || !validGithubAccount(newRepositoryAccount))) {
    fail('x_launch_account_invalid', 503)
  }
  const held = reason => ({ status: 'held', reason })

  /** The broker's verdict on one prepared job, read from its projection. */
  function outcomeOf(snapshot, missionId, commandId) {
    const receipt = Array.isArray(snapshot?.commands) ? snapshot.commands.find(row => row?.commandId === commandId) : null
    // A confirmed launch stays `held` with authoritative_observation_required
    // until the first observation; the Mission exists and the phone adopts it.
    if (snapshot?.missionId === missionId && receipt?.state === 'confirmed') return { status: 'submitted', missionId }
    const why = snapshot?.holdReason || receipt?.reason || `launch_${receipt?.state ?? 'unconfirmed'}`
    return held(`The broker did not launch this request: ${why}`)
  }

  function draftFor(request, missionId, commandId) {
    const d = request.destination
    const destination = { kind: d.kind, account: d.account, name: d.name, visibility: 'private', initialization: 'empty' }
    const fresh = d.kind === 'new_repository'
    const policy = {
      autonomy: 'high', allowCreateRepository: defaults.createPrivateRepositories && fresh,
      allowPush: defaults.pushBranch, allowPr: defaults.openPr, allowMerge: defaults.mergeAfterChecks, allowDeploy: false,
    }
    return {
      protocolVersion: 1, missionId, ownerId, commandId, goal: request.goal, scopeRevision: 1, operation: 'implement',
      // Host-managed allocation: <host root>/jobs/<mission id>/work. A managed new
      // repository is named account/name and starts from the local seed's base.
      workspace: { machineId, cwd: `${hostRoot}/jobs/${missionId}/work`,
        repository: fresh ? `${d.account}/${d.name}` : `https://github.com/${d.account}/${d.name}`,
        baseRef: fresh ? NATIVE_NEW_REPOSITORY_BASE.baseRef : baseRef },
      destination, references: [...request.references],
      acceptanceCriteria: [...saved.acceptanceCriteria], restrictions: [...saved.restrictions],
      policy, settings: structuredClone(saved.settings),
    }
  }

  return async function launch(input) {
    if (plain(input) && plain(input.destination) && input.destination.kind === 'new_repository' &&
        typeof input.instruction === 'string' && newRepositoryAccount === null) {
      return held('No GitHub account is designated for new repositories; name a repository in the post or designate one for X.')
    }
    const request = routed(input, newRepositoryAccount)
    const problem = requestProblem(request)
    if (problem) return held(`The X request cannot become a native intent (${problem}).`)
    if (request.destination.kind === 'new_repository' && !(defaults.createPrivateRepositories && defaults.pushBranch)) {
      return held('A new repository needs both "create private repositories" and "push branch" in the X delivery settings.')
    }
    let missionId, commandId
    try { missionId = mint('mission', request); commandId = mint('command', request) } catch { return held('Mission identity could not be minted.') }
    if (typeof missionId !== 'string' || !MISSION_ID.test(missionId) || typeof commandId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(commandId)) return held('Mission identity could not be minted.')
    const draft = draftFor(request, missionId, commandId)
    if (broker.host?.workDirFor && broker.host.workDirFor(missionId) !== draft.workspace.cwd) {
      return held('The host root does not match the broker host; host-managed allocation refused.')
    }
    try { nativeConsequences({ ...draft, scopeApproved: true, highAutonomyApproved: true }) } catch (error) {
      return held(`The X delivery settings cannot launch this request: ${codeOf(error)}`)
    }
    let preview
    try { preview = await broker.inspectAdmission(structuredClone(draft)) } catch (error) {
      const code = codeOf(error)
      // A replay after a crash: the job exists already, so report what it became.
      if (code === 'admission_identity_already_prepared' && typeof broker.project === 'function') {
        try { return outcomeOf(broker.project(missionId, ownerId), missionId, commandId) } catch (e) {
          return held(`The broker could not report the prior launch: ${codeOf(e)}`)
        }
      }
      return held(`The broker could not preview this request: ${code}`)
    }
    if (!preview || preview.launchEligible !== true || !Array.isArray(preview.holds) || preview.holds.length) {
      const holds = Array.isArray(preview?.holds) ? preview.holds.filter(h => typeof h === 'string') : []
      return held(`The broker holds this request: ${holds.join('; ') || 'not launch-eligible'}`)
    }
    let snapshot
    try {
      snapshot = await broker.prepare({
        ...draft, workspace: preview.workspace, settings: preview.prospectiveSettings,
        scopeApproved: true, highAutonomyApproved: true,
      })
    } catch (error) { return held(`The broker could not prepare this request: ${codeOf(error)}`) }
    return outcomeOf(snapshot, missionId, commandId)
  }
}
