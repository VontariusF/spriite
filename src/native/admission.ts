import type {
  NativeAdmissionDraft, NativeAdmissionPreview, NativeBrokerClient, NativeDeliveryDefaults, NativeIntent, NativeLaunchProfile,
} from './protocol'
import { canonicalBrokerUrl, decodeNativeAdmissionPreview, decodeNativeProfile } from './decode'
import { canonicalNativeJson, nativeFingerprint } from './fingerprint'
import { allocateNativeWorkspace, nativeWorkspaceMatchesProfile } from './workspace'

export type NativeAdmissionRequest = Omit<NativeAdmissionDraft, 'missionId' | 'commandId'> & { brokerUrl: string }
type ApprovedRequest = Omit<NativeIntent, 'missionId' | 'commandId'> & {
  brokerUrl: string; admission?: NativeAdmissionPreview
}
interface AdmissionOptions {
  profile(): NativeLaunchProfile
  deliveryDefaults?(): NativeDeliveryDefaults
  credential(url: string): string
  client(url: string): NativeBrokerClient
  mint(kind: 'mission' | 'command'): string
  now?: () => number
}
/** Volatile pre-consent evidence only. Never restores or retries execution authority. */
export class NativeAdmissionCoordinator {
  private generation = 0
  private retained: {
    profile: string; deliveryDefaults: string; credential: string; url: string; preview: NativeAdmissionPreview; intent: NativeAdmissionDraft
  } | null = null
  private readonly options: AdmissionOptions
  constructor(options: AdmissionOptions) { this.options = options }
  invalidate(): void { this.generation++; this.retained = null }
  private now(): number { return (this.options.now ?? Date.now)() }
  private identity(request: NativeAdmissionRequest | ApprovedRequest, missionId?: string): { url: string; profile: string; deliveryDefaults: string; credential: string } {
    const profile = this.options.profile()
    const decoded = decodeNativeProfile(profile)
    const url = canonicalBrokerUrl(request.brokerUrl)
    const credential = url ? this.options.credential(url) : ''
    const cwdMatches = decoded && (missionId
      ? nativeWorkspaceMatchesProfile(decoded, request.workspace, missionId)
      : request.workspace.cwd === (decoded.workspaceMode === 'host_managed' ? decoded.hostRoot : decoded.cwd))
    if (!decoded || !cwdMatches || !url || url !== canonicalBrokerUrl(profile.brokerUrl) || !credential ||
      request.ownerId !== profile.ownerId || request.workspace.machineId !== profile.machineId ||
      request.workspace.baseRef !== profile.baseRef) {
      throw new Error('Exact saved broker profile or credential is unavailable')
    }
    return { url, credential, profile: canonicalNativeJson(profile),
      deliveryDefaults: canonicalNativeJson(this.options.deliveryDefaults?.() ?? null) }
  }
  async inspect(request: NativeAdmissionRequest): Promise<NativeAdmissionPreview> {
    this.invalidate()
    const generation = this.generation
    const identity = this.identity(request)
    const { brokerUrl: _, ...body } = request
    const draft: NativeAdmissionDraft = JSON.parse(JSON.stringify({
      ...body, missionId: this.options.mint('mission'), commandId: this.options.mint('command'),
    }))
    const allocated = allocateNativeWorkspace(this.options.profile(), draft.missionId, draft.workspace, draft.destination)
    if (!allocated) throw new Error('Invalid host-managed allocation or destination')
    draft.workspace = allocated
    const client = this.options.client(identity.url)
    if (!client.inspectAdmission) throw new Error('Read-only native admission is unavailable')
    // Keep the allocation/hash authority private even if a client callback
    // mutates its own input while constructing the response.
    const result = await client.inspectAdmission(structuredClone(draft))
    const preview = decodeNativeAdmissionPreview(result)
    if (!preview || preview.draftHash !== await nativeFingerprint(draft) ||
      preview.ownerId !== draft.ownerId || preview.missionId !== draft.missionId ||
      ['machineId', 'cwd', 'repository', 'baseRef'].some(k =>
        preview.workspace[k as keyof typeof preview.workspace] !== draft.workspace[k as keyof typeof draft.workspace]) ||
      (draft.workspace.baseSha && draft.workspace.baseSha !== preview.workspace.baseSha) ||
      canonicalNativeJson(preview.prospectiveSettings) !== canonicalNativeJson(draft.settings) ||
      Date.parse(preview.observedAt) > this.now() + 5000 || Date.parse(preview.expiresAt) <= this.now() ||
      Date.parse(preview.expiresAt) - Date.parse(preview.observedAt) > 60000) {
      throw new Error('Native admission evidence does not match this draft')
    }
    const after = this.identity(request)
    if (generation !== this.generation || canonicalNativeJson(after) !== canonicalNativeJson(identity)) {
      throw new Error('Native admission identity changed')
    }
    this.retained = { ...identity, preview, intent: {
      ...draft, workspace: preview.workspace, settings: preview.prospectiveSettings,
    } }
    return JSON.parse(JSON.stringify(preview))
  }
  /** Consume once before durable submission. Edits cannot reuse a prior reviewed scope. */
  take(request: ApprovedRequest): NativeIntent | null {
    const retained = this.retained
    this.invalidate()
    if (!retained || !request.scopeApproved || !request.highAutonomyApproved ||
      !retained.preview.launchEligible || retained.preview.holds.length ||
      Date.parse(retained.preview.expiresAt) <= this.now() ||
      canonicalNativeJson(request.admission) !== canonicalNativeJson(retained.preview)) return null
    let identity
    try { identity = this.identity(request, retained.intent.missionId) } catch { return null }
    if (identity.url !== retained.url || identity.profile !== retained.profile ||
      identity.deliveryDefaults !== retained.deliveryDefaults || identity.credential !== retained.credential) return null
    const { brokerUrl: _, admission: __, scopeApproved: ___, highAutonomyApproved: ____, ...body } = request
    const draft = { ...body, missionId: retained.intent.missionId, commandId: retained.intent.commandId }
    if (canonicalNativeJson(draft) !== canonicalNativeJson(retained.intent)) return null
    return { ...retained.intent, scopeApproved: true, highAutonomyApproved: true }
  }
}
