/**
 * Automatic launch of held X requests as native Factory Missions.
 *
 * The owner opts in once (Setup → Factory-native → "Run my X requests
 * automatically") and saves the settings an X job runs with. A held intent
 * whose origin is X then goes through exactly the path the phone uses: the
 * broker's read-only admission preview, which must be launch-eligible with no
 * holds, then consent and promotion. The owner's own verified post is the
 * consent; nothing here widens what the broker or the supervisor accept.
 */
import type {
  HeldNativeIntent, NativeAdmissionPreview, NativeDeliveryDefaults, NativeIntent, NativeLaunchProfile,
} from './protocol'
import type { NativeAdmissionRequest } from './admission'
import { deliveryPolicyFlags } from './delivery'
import { decodeNativeProfile } from './decode'

/** The settings an automatically launched X job runs with. */
export interface NativeXAutoTemplate {
  settings: Record<string, string | boolean | string[]>
  acceptanceCriteria: string[]
  restrictions: string[]
}

export interface NativeXAutoPrefs {
  enabled: boolean
  template: NativeXAutoTemplate | null
}

const SETTING_NAMES = ['modelId', 'reasoningEffort', 'workerModel', 'workerReasoningEffort',
  'validationWorkerModel', 'validationWorkerReasoningEffort'] as const
const TOOL_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max
const lines = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length <= 64 && v.every(x => text(x, 4096)) ? v.map(x => (x as string).trim()) : null

/** A stored template, or null when any field would not pass the phone's own draft checks. */
export function decodeNativeXAutoTemplate(raw: unknown): NativeXAutoTemplate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const s = r.settings as Record<string, unknown> | undefined
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null
  if (SETTING_NAMES.some(k => !text(s[k], 256))) return null
  const tools = s.restrictToolIds
  if (!Array.isArray(tools) || !tools.length || tools.length > 128 || new Set(tools).size !== tools.length ||
    tools.some(t => typeof t !== 'string' || !TOOL_ID.test(t))) return null
  const criteria = lines(r.acceptanceCriteria), restrictions = lines(r.restrictions ?? [])
  if (!criteria || !criteria.length || !restrictions) return null
  return {
    settings: { ...Object.fromEntries(SETTING_NAMES.map(k => [k, (s[k] as string).trim()])),
      restrictToolIds: [...tools as string[]], skipScrutiny: false, skipUserTesting: false },
    acceptanceCriteria: criteria, restrictions,
  }
}

const REPO = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/

/**
 * The admission request the phone would build when the owner reviews this
 * held intent with the saved X template — the held goal byte-for-byte, every
 * held reference, the held destination. Null when it cannot be built.
 */
export function xAutoAdmissionRequest(held: HeldNativeIntent, rawProfile: NativeLaunchProfile,
  defaults: NativeDeliveryDefaults, template: NativeXAutoTemplate): NativeAdmissionRequest | null {
  const p = decodeNativeProfile(rawProfile)
  if (!p || !p.brokerUrl || !p.ownerId || !p.machineId || !p.baseRef) return null
  if (p.workspaceMode !== 'host_managed' && !p.cwd.startsWith('/')) return null
  let destination: NonNullable<NativeIntent['destination']>
  if (held.destination?.kind === 'new_repository') {
    if (!defaults.createPrivateRepositories) return null
    destination = { kind: 'new_repository', account: held.destination.account, name: held.destination.name,
      visibility: 'private', initialization: 'empty' }
  } else {
    const repo = REPO.exec(held.repository)
    if (!repo) return null
    destination = { kind: 'existing', account: repo[1], name: repo[2], visibility: 'private', initialization: 'empty' }
  }
  return {
    protocolVersion: 1, brokerUrl: p.brokerUrl, ownerId: p.ownerId, scopeRevision: 1,
    goal: held.goal, operation: 'implement',
    workspace: { machineId: p.machineId, cwd: p.workspaceMode === 'host_managed' ? p.hostRoot! : p.cwd,
      repository: `https://github.com/${destination.account}/${destination.name}`, baseRef: p.baseRef },
    destination,
    references: [...held.references],
    acceptanceCriteria: [...template.acceptanceCriteria],
    restrictions: [...template.restrictions],
    policy: { autonomy: 'high', ...deliveryPolicyFlags(defaults, destination) },
    settings: JSON.parse(JSON.stringify(template.settings)),
  }
}

export type XAutoOutcome =
  | { missionId: string; status: 'launched'; newMissionId: string }
  | { missionId: string; status: 'held'; reason: string }

export interface XAutoLauncherDeps {
  prefs(): NativeXAutoPrefs
  profile(): NativeLaunchProfile
  deliveryDefaults(): NativeDeliveryDefaults
  held(): HeldNativeIntent[]
  inspect(request: NativeAdmissionRequest): Promise<NativeAdmissionPreview>
  /** Consent + promotion through the same path as the phone's Approve button. */
  promote(heldMissionId: string, request: NativeAdmissionRequest & {
    admission: NativeAdmissionPreview; scopeApproved: true; highAutonomyApproved: true
  }): Promise<{ status: 'saved' | 'held' | 'failed'; reason?: string; missionId?: string }>
  onOutcome?(outcome: XAutoOutcome): void
}

/**
 * Tries each held X intent once per launch of the app. A refusal (holds,
 * expired preview, broker unreachable) leaves the intent held and visible on
 * the phone with the reason; it is never retried in a loop.
 */
export class XAutoLauncher {
  private readonly attempted = new Map<string, string>()
  private running = false
  private readonly deps: XAutoLauncherDeps
  constructor(deps: XAutoLauncherDeps) { this.deps = deps }

  /** Why the last attempt for a held intent did not launch, if it was tried. */
  reasonFor(missionId: string): string | undefined { return this.attempted.get(missionId) }

  async tick(): Promise<XAutoOutcome[]> {
    if (this.running) return []
    const prefs = this.deps.prefs()
    if (!prefs.enabled || !prefs.template) return []
    this.running = true
    const out: XAutoOutcome[] = []
    try {
      for (const held of this.deps.held()) {
        if (held.origin !== 'x' || this.attempted.has(held.missionId)) continue
        const outcome = await this.attempt(held, prefs.template)
        this.attempted.set(held.missionId, outcome.status === 'held' ? outcome.reason : 'launched')
        out.push(outcome)
        this.deps.onOutcome?.(outcome)
      }
    } finally { this.running = false }
    return out
  }

  private async attempt(held: HeldNativeIntent, template: NativeXAutoTemplate): Promise<XAutoOutcome> {
    const hold = (reason: string): XAutoOutcome => ({ missionId: held.missionId, status: 'held', reason })
    const request = xAutoAdmissionRequest(held, this.deps.profile(), this.deps.deliveryDefaults(), template)
    if (!request) return hold('The saved native profile, delivery defaults or destination cannot launch this X request automatically.')
    let preview: NativeAdmissionPreview
    try { preview = await this.deps.inspect(request) } catch (e) {
      return hold(`The broker could not preview this request: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!preview.launchEligible || preview.holds.length) {
      return hold(`The broker holds this request: ${preview.holds.join('; ') || 'not launch-eligible'}`)
    }
    const approved = { ...request, workspace: preview.workspace, settings: preview.prospectiveSettings,
      admission: preview, scopeApproved: true as const, highAutonomyApproved: true as const }
    let result
    try { result = await this.deps.promote(held.missionId, approved) } catch (e) {
      return hold(`Approval could not be saved: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (result.status === 'failed' || !result.missionId) return hold(result.reason ?? 'Approval was not saved.')
    return { missionId: held.missionId, status: 'launched', newMissionId: result.missionId }
  }
}
