/**
 * User preferences for the real engine (phone-side choices, not secrets):
 * which service runs the worker role, how large tasks split across
 * parallel workers, whether the HUD asks before the worker opens the
 * pull request, and the Factory session settings every new build starts
 * with. Stored in the Even app's SDK storage next to (but separate from)
 * keys and mission state. Never logged.
 */
import type { MissionSessionSettings } from '../domain/types'
import type { BridgeGateway } from '../bridge/bridge'
import { resolveFlags, type FlagName, type Flags } from './flags'
import type { NativeDeliveryDefaults, NativeLaunchProfile } from '../native/protocol'
import { normalizeDeliveryDefaults } from '../native/delivery'
import { nativeProfileWorkspaceFields } from '../native/workspace'
import { decodeNativeXAutoTemplate, type NativeXAutoPrefs, type NativeXAutoTemplate } from '../native/x-auto'
import { canonicalBrokerUrl } from '../native/decode'
import type { PairedHost, RunOn, SetupPath } from '../pair/types'

const KEY = 'spriite.prefs.v1'

/** Which service(s) run the worker role when building. */
export type WorkerPref = 'auto' | 'cursor' | 'factory' | 'mix'

export const WORKER_PREFS: { id: WorkerPref; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'cursor', label: 'Cursor cloud agent' },
  { id: 'factory', label: 'Factory session' },
  { id: 'mix', label: 'Mix both in parallel' },
]

/** Split counts for large tasks. 1 = one worker at a time. */
export const JOB_OPTIONS = [1, 2, 3, 4]

/**
 * Factory session settings the owner may default per account (empty = the
 * account's own default). Reasoning effort omits the degenerate enum values
 * ('none', 'off', 'dynamic') that would disable or confuse the lead.
 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AutonomyLevel = 'off' | 'low' | 'medium' | 'high'

/**
 * Factory's interaction modes, minus 'mission' and 'agi': a live probe showed
 * the API accepts interactionMode 'mission' and then ignores it (no plan
 * gate, no workers), so offering it would be a control that does nothing
 * (docs/MISSION-PROBE-FINDINGS.md).
 */
export type InteractionMode = 'auto' | 'spec'

export const INTERACTION_MODES: InteractionMode[] = ['auto', 'spec']
export const REASONING_EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const AUTONOMY_LEVELS: AutonomyLevel[] = ['off', 'low', 'medium', 'high']

/** Longest tool list (and instruction) a phone field may store. */
export const TOOL_LIST_MAX = 64
const INSTRUCTIONS_MAX = 500
const TOOL_ID_MAX = 64

/**
 * A typed tool list: the panel takes free text (Factory has no tool-listing
 * endpoint), so ids are separated by commas or whitespace, trimmed, and
 * de-duplicated in the order they were typed. Blank entries are dropped
 * rather than stored as a tool id Factory would reject.
 */
export function parseToolList(raw: string): string[] {
  const out: string[] = []
  for (const token of raw.split(/[\s,]+/)) {
    const id = token.trim().slice(0, TOOL_ID_MAX)
    if (id === '' || out.includes(id)) continue
    out.push(id)
    if (out.length === TOOL_LIST_MAX) break
  }
  return out
}

/** An empty typed list stores as absence, matching every other choice here. */
const listOrUndefined = (raw: string): string[] | undefined => {
  const ids = parseToolList(raw)
  return ids.length > 0 ? ids : undefined
}

interface StoredPrefs {
  v: 1
  nativeLaunchProfile?: NativeLaunchProfile
  /** What new native jobs may do after completion (merge requires PR requires push). */
  nativeDeliveryDefaults?: NativeDeliveryDefaults
  /** Launch held X requests as native jobs automatically, with these saved settings. */
  nativeXAuto?: { enabled: boolean; template?: NativeXAutoTemplate }
  worker?: WorkerPref
  /** Workers that split a large task (1 = one at a time, 2-4 = parallel). */
  jobs?: number
  /** Ask on the HUD before the worker opens the pull request. */
  askBeforePr?: boolean
  /** Hold each sprite pose still (no hover, sway, or pulses). */
  reduceMotion?: boolean
  /** Release flags (src/state/flags.ts); read once at boot. */
  flags?: Partial<Flags>
  /** How the lead session runs a goal ('auto' or 'spec'). */
  interactionMode?: InteractionMode
  /** The spec-mode model, when the owner chose spec mode. */
  specModel?: string
  specReasoningEffort?: ReasoningEffort
  /** The lead session (the orchestrator the HUD talks to). */
  leadModel?: string
  leadReasoningEffort?: ReasoningEffort
  autonomyLevel?: AutonomyLevel
  /** The worker sessions that write the code. */
  workerModel?: string
  workerReasoningEffort?: ReasoningEffort
  /** Extra instructions appended to the worker's own system prompt. */
  workerInstructions?: string
  /** Factory tool policy for worker sessions. */
  workerEnabledTools?: string[]
  workerDisabledTools?: string[]
  workerRestrictTools?: string[]
  /**
   * Pre-split records: one model and effort for every session. Read once and
   * migrated into the lead and worker fields; never written again.
   */
  model?: string
  reasoningEffort?: ReasoningEffort
  /** The owner's own X app OAuth client id (empty = renewal is impossible). */
  xClientId?: string
  /**
   * The repository the owner designated for X builds that name none (empty =
   * none: such a build gets a new repository of its own). Never the app's
   * selected repository by implication.
   */
  xDefaultRepository?: string
  /**
   * The Spriite account handle people mention on X (empty = not chosen). A
   * label, never an authority: the verified binding's numeric ids stay the
   * only authorization. This is the durable prefill, so a relaunch (or an app
   * update) never reads as "your handle was lost".
   */
  xSpriiteHandle?: string
  /**
   * True once the Factory host's broker verified a handoff of the X pair and reads X
   * itself: the phone no longer polls or renews (X rotates the pair, so only
   * one side may own it). Absent or anything but true is the phone reading.
   */
  xHostReader?: boolean
  /** X-triggered builds run as Factory Missions through the native broker. */
  xBuildsNative?: boolean
  /** When the owner tapped "Finish setup" (epoch ms); absent = never. */
  setupCompletedAt?: number
  /** Where builds run: on the paired computer or in Factory's cloud. */
  runOn?: RunOn
  /** The Factory computer this phone paired with (no secrets). */
  pairedHost?: PairedHost
  /** How setup was done: paired, key only, or moved from another phone. */
  setupPath?: SetupPath
  /** Spoken replies (ElevenLabs). Absent = on; only a literal false turns them off. */
  spokenReplies?: false
}

export const RUN_ON: readonly RunOn[] = ['host', 'cloud']
export const SETUP_PATHS: readonly SetupPath[] = ['paired', 'key_only', 'moved']
const PAIR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/

/** A paired host as stored: shaped fields only, else absence (the restore rule). */
export function pairedHostOf(value: unknown): PairedHost | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const label = typeof v.label === 'string' ? v.label.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) : ''
  // An id the computer did not report is empty (never a placeholder).
  if (!label || typeof v.machineId !== 'string' || (v.machineId !== '' && !PAIR_ID.test(v.machineId)) ||
    typeof v.ownerId !== 'string' || (v.ownerId !== '' && !PAIR_ID.test(v.ownerId))) return null
  if (v.via !== 'tailscale' && v.via !== 'https' && v.via !== 'none') return null
  if (v.os !== 'linux' && v.os !== 'macos') return null
  if (typeof v.pairedAt !== 'number' || !Number.isFinite(v.pairedAt) || v.pairedAt < 0) return null
  let brokerUrl = ''
  if (v.brokerUrl !== '' || v.via !== 'none') {
    const canonical = canonicalBrokerUrl(v.brokerUrl)
    if (!canonical) return null
    brokerUrl = canonical
  }
  return { label, machineId: v.machineId, ownerId: v.ownerId, brokerUrl, via: v.via, os: v.os, pairedAt: v.pairedAt }
}

const completedAt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined

/**
 * A handle is stored the way X resolves it: no leading @, 1-15 letters,
 * digits or underscores. The panel refuses anything else before a save, so a
 * wrong-typed value reaching a load is a corrupt record and reads as absence
 * (the same rule every other pref here follows on restore).
 */
const xHandle = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const t = v.trim().replace(/^@+/, '')
  return /^[A-Za-z0-9_]{1,15}$/.test(t) ? t : undefined
}

/** Only a literal true means the host reads X; a corrupt value is the phone reading. */
const hostReaderFlag = (v: unknown): true | undefined => v === true ? true : undefined

/** Whitelist non-secret fields; URL credentials/query fragments never persist. */
export function nativeProfileOf(value: unknown): NativeLaunchProfile | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const workspaceFields = nativeProfileWorkspaceFields(raw)
  if (!workspaceFields) return null
  const result = {} as NativeLaunchProfile
  for (const key of ['brokerUrl', 'ownerId', 'machineId', 'cwd', 'baseRef'] as const) {
    if (typeof raw[key] !== 'string' || raw[key].length > 4096) return null
    result[key] = raw[key].trim()
  }
  if (result.brokerUrl) {
    try {
      const url = new URL(result.brokerUrl)
      if (url.username || url.password || url.search || url.hash ||
        !(url.protocol === 'https:' || (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return null
    } catch { return null }
  }
  return { ...result, ...workspaceFields }
}

/** A GitHub repository URL in the one form routing compares, or absence. */
function xRepository(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const m = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/?$/.exec(v.trim())
  return m && !/\.git$/i.test(m[2]) ? `https://github.com/${m[1]}/${m[2]}` : undefined
}

/**
 * Restore validation for a stored (or moved) record: only shaped values
 * survive — a wrong-typed field is absence, never a value the engine config
 * would carry (a string '4' reads as a job count, a number as a worker
 * preference the engine must then fall back from). null = not a v1 record.
 */
function sanitizePrefs(input: unknown): StoredPrefs | null {
  const parsed = input as StoredPrefs
  if (parsed?.v !== 1) return null
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v !== '' ? v.trim().slice(0, 120) : undefined
  const text = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, INSTRUCTIONS_MAX) : undefined
  const tools = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined
    const ids = v
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim().slice(0, TOOL_ID_MAX))
      .filter((x) => x !== '')
    const unique = [...new Set(ids)].slice(0, TOOL_LIST_MAX)
    return unique.length > 0 ? unique : undefined
  }
  const effort = (v: unknown): ReasoningEffort | undefined =>
    REASONING_EFFORTS.includes(v as ReasoningEffort) ? (v as ReasoningEffort) : undefined
  const mode = (v: unknown): InteractionMode | undefined =>
    INTERACTION_MODES.includes(v as InteractionMode) ? (v as InteractionMode) : undefined
  // A record written before the lead/worker split carries one model and
  // effort for every session; it becomes both, so an owner's saved choice
  // is not silently dropped on the release that split it.
  const legacyModel = str(parsed.model)
  const legacyEffort = effort(parsed.reasoningEffort)
  return {
    v: 1,
    nativeLaunchProfile: nativeProfileOf(parsed.nativeLaunchProfile) ?? undefined,
    nativeDeliveryDefaults: parsed.nativeDeliveryDefaults === undefined
      ? undefined : normalizeDeliveryDefaults(parsed.nativeDeliveryDefaults),
    nativeXAuto: parsed.nativeXAuto && typeof parsed.nativeXAuto === 'object'
      ? { enabled: (parsed.nativeXAuto as { enabled?: unknown }).enabled === true,
        ...(decodeNativeXAutoTemplate((parsed.nativeXAuto as { template?: unknown }).template)
          ? { template: decodeNativeXAutoTemplate((parsed.nativeXAuto as { template?: unknown }).template)! } : {}) }
      : undefined,
    worker: WORKER_PREFS.some((w) => w.id === parsed.worker) ? (parsed.worker as WorkerPref) : undefined,
    jobs:
      typeof parsed.jobs === 'number' && Number.isInteger(parsed.jobs) && parsed.jobs >= 1 && parsed.jobs <= 4
        ? parsed.jobs
        : undefined,
    askBeforePr: parsed.askBeforePr === true ? true : undefined,
    reduceMotion: parsed.reduceMotion === true ? true : undefined,
    flags:
      typeof parsed.flags === 'object' && parsed.flags !== null
        ? (parsed.flags as Partial<Flags>)
        : undefined,
    interactionMode: mode(parsed.interactionMode),
    specModel: str(parsed.specModel),
    specReasoningEffort: effort(parsed.specReasoningEffort),
    leadModel: str(parsed.leadModel) ?? legacyModel,
    leadReasoningEffort: effort(parsed.leadReasoningEffort) ?? legacyEffort,
    autonomyLevel: AUTONOMY_LEVELS.includes(parsed.autonomyLevel as AutonomyLevel)
      ? (parsed.autonomyLevel as AutonomyLevel)
      : undefined,
    workerModel: str(parsed.workerModel) ?? legacyModel,
    workerReasoningEffort: effort(parsed.workerReasoningEffort) ?? legacyEffort,
    workerInstructions: text(parsed.workerInstructions),
    workerEnabledTools: tools(parsed.workerEnabledTools),
    workerDisabledTools: tools(parsed.workerDisabledTools),
    workerRestrictTools: tools(parsed.workerRestrictTools),
    xClientId: str(parsed.xClientId),
    xDefaultRepository: xRepository(parsed.xDefaultRepository),
    xSpriiteHandle: xHandle(parsed.xSpriiteHandle),
    xHostReader: hostReaderFlag(parsed.xHostReader),
    xBuildsNative: parsed.xBuildsNative === true ? true : undefined,
    setupCompletedAt: completedAt(parsed.setupCompletedAt),
    runOn: RUN_ON.includes(parsed.runOn as RunOn) ? parsed.runOn : undefined,
    pairedHost: pairedHostOf(parsed.pairedHost) ?? undefined,
    setupPath: SETUP_PATHS.includes(parsed.setupPath as SetupPath) ? parsed.setupPath : undefined,
    spokenReplies: parsed.spokenReplies === false ? false : undefined,
  }
}

export class PrefsVault {
  private prefs: StoredPrefs = { v: 1 }
  private readonly gateway: BridgeGateway
  /** One queued write at a time, like KeyVault: commits apply in order. */
  private writes: Promise<unknown> = Promise.resolve()
  /**
   * True while the boot read never answered: the SDK returns '' for a
   * missing key, so a null from the gateway is a transport failure, not
   * absence. Until a read answers, the record in memory may be a subset of
   * what storage holds, and a commit must merge with the stored record
   * before it overwrites it — otherwise the owner's next save would wipe
   * every preference and flag (the durable-runtime flag included) the
   * failed read never saw.
   */
  private unknownRead = false

  constructor(gateway: BridgeGateway) {
    this.gateway = gateway
  }

  get nativeLaunchProfile(): NativeLaunchProfile {
    return { ...(this.prefs.nativeLaunchProfile ??
      { brokerUrl: '', ownerId: '', machineId: '', cwd: '', baseRef: '' }) }
  }

  async setNativeLaunchProfile(profile: NativeLaunchProfile): Promise<boolean> {
    const clean = nativeProfileOf(profile)
    if (!clean) return false
    return this.commit((p) => ({ ...p, nativeLaunchProfile: clean }))
  }

  get nativeDeliveryDefaults(): NativeDeliveryDefaults {
    return normalizeDeliveryDefaults(this.prefs.nativeDeliveryDefaults)
  }

  async setNativeDeliveryDefaults(defaults: NativeDeliveryDefaults): Promise<boolean> {
    const clean = normalizeDeliveryDefaults(defaults)
    return this.commit((p) => ({ ...p, nativeDeliveryDefaults: clean }))
  }

  /** Off unless the owner opted in and saved a valid template. */
  get nativeXAuto(): NativeXAutoPrefs {
    const template = decodeNativeXAutoTemplate(this.prefs.nativeXAuto?.template)
    return { enabled: this.prefs.nativeXAuto?.enabled === true && template !== null, template }
  }

  async setNativeXAuto(enabled: boolean, template?: NativeXAutoTemplate | null): Promise<boolean> {
    const kept = template === undefined ? decodeNativeXAutoTemplate(this.prefs.nativeXAuto?.template)
      : template === null ? null : decodeNativeXAutoTemplate(template)
    if (template && !kept) return false
    return this.commit((p) => ({ ...p, nativeXAuto: { enabled: enabled && kept !== null, ...(kept ? { template: kept } : {}) } }))
  }

  get worker(): WorkerPref {
    return this.prefs.worker ?? 'auto'
  }

  /** 1-4; how many workers may split a large task. */
  get jobs(): number {
    const n = this.prefs.jobs ?? 1
    return n >= 1 && n <= 4 ? n : 1
  }

  get askBeforePr(): boolean {
    return this.prefs.askBeforePr === true
  }

  get reduceMotion(): boolean {
    return this.prefs.reduceMotion === true
  }

  /** How the lead session runs a goal (empty = Factory's own default). */
  get interactionMode(): '' | InteractionMode {
    return INTERACTION_MODES.includes(this.prefs.interactionMode as InteractionMode)
      ? (this.prefs.interactionMode as InteractionMode)
      : ''
  }

  /** The spec-mode model (only sent while the mode is spec). */
  get specModel(): string {
    return this.prefs.specModel ?? ''
  }

  get specReasoningEffort(): '' | ReasoningEffort {
    return REASONING_EFFORTS.includes(this.prefs.specReasoningEffort as ReasoningEffort)
      ? (this.prefs.specReasoningEffort as ReasoningEffort)
      : ''
  }

  /** The lead session's model id (empty = the account default). */
  get leadModel(): string {
    return this.prefs.leadModel ?? ''
  }

  get leadReasoningEffort(): '' | ReasoningEffort {
    return REASONING_EFFORTS.includes(this.prefs.leadReasoningEffort as ReasoningEffort)
      ? (this.prefs.leadReasoningEffort as ReasoningEffort)
      : ''
  }

  /** The worker sessions' model id (empty = the account default). */
  get workerModel(): string {
    return this.prefs.workerModel ?? ''
  }

  get workerReasoningEffort(): '' | ReasoningEffort {
    return REASONING_EFFORTS.includes(this.prefs.workerReasoningEffort as ReasoningEffort)
      ? (this.prefs.workerReasoningEffort as ReasoningEffort)
      : ''
  }

  /**
   * Extra instructions for worker sessions. Sent as the API's preset form
   * (`append`), never as a replacement: a worker that lost Droid's own system
   * prompt would lose its tool protocol with it.
   */
  get workerInstructions(): string {
    return this.prefs.workerInstructions ?? ''
  }

  get workerEnabledTools(): string[] {
    return this.prefs.workerEnabledTools ?? []
  }

  get workerDisabledTools(): string[] {
    return this.prefs.workerDisabledTools ?? []
  }

  get workerRestrictTools(): string[] {
    return this.prefs.workerRestrictTools ?? []
  }

  get autonomyLevel(): '' | AutonomyLevel {
    return AUTONOMY_LEVELS.includes(this.prefs.autonomyLevel as AutonomyLevel)
      ? (this.prefs.autonomyLevel as AutonomyLevel)
      : ''
  }

  /**
   * The session settings a build freezes when it is created (spec §7). Empty
   * choices are absent, so an untouched preference sends nothing and Factory's
   * account default stands. Spec-mode settings travel only with spec mode:
   * sending them in another mode would claim a choice the owner did not make.
   */
  get missionSettings(): MissionSessionSettings {
    const s: MissionSessionSettings = {}
    const mode = this.interactionMode
    if (mode) {
      s.interactionMode = mode
      if (mode === 'spec') {
        if (this.specModel) s.specModeModel = this.specModel
        if (this.specReasoningEffort) s.specModeReasoningEffort = this.specReasoningEffort
      }
    }
    if (this.leadModel) s.leadModel = this.leadModel
    if (this.leadReasoningEffort) s.leadReasoningEffort = this.leadReasoningEffort
    if (this.autonomyLevel) s.leadAutonomyLevel = this.autonomyLevel
    if (this.workerModel) s.workerModel = this.workerModel
    if (this.workerReasoningEffort) s.workerReasoningEffort = this.workerReasoningEffort
    if (this.workerInstructions) s.workerInstructions = this.workerInstructions
    if (this.workerEnabledTools.length > 0) s.workerEnabledToolIds = [...this.workerEnabledTools]
    if (this.workerDisabledTools.length > 0) s.workerDisabledToolIds = [...this.workerDisabledTools]
    if (this.workerRestrictTools.length > 0) s.workerRestrictToolIds = [...this.workerRestrictTools]
    return s
  }

  /**
   * The X developer app's OAuth client id the owner registered (bring your
   * own app; empty = token renewal has no app to name, so it fails closed).
   */
  get xClientId(): string {
    return this.prefs.xClientId ?? ''
  }

  /** The repository designated for X builds that name none ('' = none). */
  get xDefaultRepository(): string {
    return this.prefs.xDefaultRepository ?? ''
  }

  /**
   * The Spriite handle the owner asked people to mention (empty = not
   * chosen). The binding's verified handle is authoritative while one is
   * bound; this is what the setup panel prefills from storage when no
   * connection is built this launch, so the owner never re-types a handle
   * that is already saved.
   */
  get xSpriiteHandle(): string {
    return this.prefs.xSpriiteHandle ?? ''
  }

  /** True while the Factory host's broker owns the X credential and reads X (phone polling is off). */
  get xHostReader(): boolean {
    return this.prefs.xHostReader === true
  }

  async setXHostReader(on: boolean): Promise<boolean> {
    return this.commit((p) => ({ ...p, xHostReader: hostReaderFlag(on) }))
  }

  /** X builds run as Factory Missions on the Factory host (off = the cloud lead-session path). */
  get xBuildsNative(): boolean {
    return this.prefs.xBuildsNative === true
  }

  async setXBuildsNative(on: boolean): Promise<boolean> {
    return this.commit((p) => ({ ...p, xBuildsNative: on === true ? true : undefined }))
  }

  /** When setup was finished (epoch ms); 0 = never. */
  get setupCompletedAt(): number {
    return this.prefs.setupCompletedAt ?? 0
  }

  async setSetupCompleted(at: number): Promise<boolean> {
    return this.commit((p) => ({ ...p, setupCompletedAt: completedAt(at) }))
  }

  /** Where builds run; without a stored choice, the paired computer when there is one. */
  get runOn(): RunOn {
    return this.prefs.runOn ?? (this.prefs.pairedHost ? 'host' : 'cloud')
  }

  async setRunOn(runOn: RunOn): Promise<boolean> {
    if (!RUN_ON.includes(runOn)) return false
    return this.commit((p) => ({ ...p, runOn }))
  }

  get pairedHost(): PairedHost | null {
    return this.prefs.pairedHost ? { ...this.prefs.pairedHost } : null
  }

  /** null forgets the paired computer; a malformed host is refused (false). */
  async setPairedHost(host: PairedHost | null): Promise<boolean> {
    const clean = host === null ? undefined : pairedHostOf(host)
    if (host !== null && !clean) return false
    return this.commit((p) => ({ ...p, pairedHost: clean ?? undefined }))
  }

  get setupPath(): SetupPath | '' {
    return this.prefs.setupPath ?? ''
  }

  async setSetupPath(path: SetupPath | ''): Promise<boolean> {
    if (path !== '' && !SETUP_PATHS.includes(path)) return false
    return this.commit((p) => ({ ...p, setupPath: path === '' ? undefined : path }))
  }

  /** Spoken replies are on unless the owner turned them off. */
  get spokenReplies(): boolean {
    return this.prefs.spokenReplies !== false
  }

  async setSpokenReplies(on: boolean): Promise<boolean> {
    return this.commit((p) => ({ ...p, spokenReplies: on === false ? false : undefined }))
  }

  /**
   * Every stored preference (none are secrets) for "Move to another phone".
   * The record goes through the same restore validation on the new phone.
   */
  exportForTransfer(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(this.prefs)) {
      if (k !== 'v' && v !== undefined) out[k] = structuredClone(v)
    }
    return out
  }

  /**
   * Adopt preferences another phone moved here. Only what the restore
   * validation keeps is written (a wrong-typed field is absence, an unknown
   * one is ignored); fields the record does not carry stay as they are.
   */
  async importFromTransfer(rec: Record<string, unknown>): Promise<boolean> {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false
    const clean = sanitizePrefs({ ...rec, v: 1 })
    if (!clean) return false
    const incoming = Object.fromEntries(Object.entries(clean).filter(([k, v]) => k !== 'v' && v !== undefined))
    if (Object.keys(incoming).length === 0) return false
    return this.commit((p) => ({ ...p, ...incoming, v: 1 }))
  }

  /** The stored flags with dependency rules applied (not dev overrides). */
  get flags(): Flags {
    return resolveFlags(this.prefs.flags)
  }

  async setFlag(name: FlagName, on: boolean): Promise<boolean> {
    return this.commit((p) => ({ ...p, flags: { ...(p.flags ?? {}), [name]: on } }))
  }

  async load(): Promise<void> {
    const raw = await this.gateway.call((b) => b.getLocalStorage(KEY), 'getPrefs')
    if (raw === null) {
      // A transport failure is not a missing key: retry once, and only an
      // answer may load.
      const retry = await this.gateway.call((b) => b.getLocalStorage(KEY), 'getPrefsRetry')
      if (retry === null) {
        this.unknownRead = true
        return
      }
      this.take(retry)
      return
    }
    this.unknownRead = false
    if (raw === '') return
    this.take(raw)
  }

  /**
   * Adopt a stored record. Restore validation: only shaped values survive a
   * load — a wrong-typed field is absence, never a value the engine config
   * would carry (a string '4' reads as a job count, a number as a worker
   * preference the engine must then fall back from).
   */
  private take(raw: string): void {
    try {
      const clean = sanitizePrefs(JSON.parse(raw))
      if (clean) this.prefs = clean
    } catch {
      console.warn('[prefs] stored preferences unreadable; ignoring')
    }
  }

  async setWorker(worker: WorkerPref): Promise<boolean> {
    return this.commit((p) => ({ ...p, worker }))
  }

  async setJobs(jobs: number): Promise<boolean> {
    const n = Math.round(jobs)
    return this.commit((p) => ({ ...p, jobs: n >= 1 && n <= 4 ? n : 1 }))
  }

  async setAskBeforePr(ask: boolean): Promise<boolean> {
    return this.commit((p) => ({ ...p, askBeforePr: ask }))
  }

  async setReduceMotion(on: boolean): Promise<boolean> {
    return this.commit((p) => ({ ...p, reduceMotion: on }))
  }

  /** Empty string restores Factory's own default, as every choice here does. */
  async setInteractionMode(mode: InteractionMode | ''): Promise<boolean> {
    return this.commit((p) => ({
      ...p,
      interactionMode: INTERACTION_MODES.includes(mode as InteractionMode) ? (mode as InteractionMode) : undefined,
    }))
  }

  async setSpecModel(model: string): Promise<boolean> {
    return this.commit((p) => ({ ...p, specModel: model.trim().slice(0, 120) }))
  }

  async setSpecReasoningEffort(e: ReasoningEffort | ''): Promise<boolean> {
    return this.commit((p) => ({
      ...p,
      specReasoningEffort: REASONING_EFFORTS.includes(e as ReasoningEffort) ? (e as ReasoningEffort) : undefined,
    }))
  }

  /** The lead session's model. Empty string restores the account default. */
  async setLeadModel(model: string): Promise<boolean> {
    return this.commit((p) => ({ ...p, leadModel: model.trim().slice(0, 120) }))
  }

  async setLeadReasoningEffort(e: ReasoningEffort | ''): Promise<boolean> {
    return this.commit((p) => ({
      ...p,
      leadReasoningEffort: REASONING_EFFORTS.includes(e as ReasoningEffort) ? (e as ReasoningEffort) : undefined,
    }))
  }

  /** The worker sessions' model. Empty string restores the account default. */
  async setWorkerModel(model: string): Promise<boolean> {
    return this.commit((p) => ({ ...p, workerModel: model.trim().slice(0, 120) }))
  }

  async setWorkerReasoningEffort(e: ReasoningEffort | ''): Promise<boolean> {
    return this.commit((p) => ({
      ...p,
      workerReasoningEffort: REASONING_EFFORTS.includes(e as ReasoningEffort) ? (e as ReasoningEffort) : undefined,
    }))
  }

  /** Extra worker instructions (appended, never a replacement). */
  async setWorkerInstructions(text: string): Promise<boolean> {
    const t = text.trim().slice(0, INSTRUCTIONS_MAX)
    return this.commit((p) => ({ ...p, workerInstructions: t === '' ? undefined : t }))
  }

  /** The three tool lists, typed as free text and stored as ids. */
  async setWorkerEnabledTools(raw: string): Promise<boolean> {
    return this.commit((p) => ({ ...p, workerEnabledTools: listOrUndefined(raw) }))
  }

  async setWorkerDisabledTools(raw: string): Promise<boolean> {
    return this.commit((p) => ({ ...p, workerDisabledTools: listOrUndefined(raw) }))
  }

  async setWorkerRestrictTools(raw: string): Promise<boolean> {
    return this.commit((p) => ({ ...p, workerRestrictTools: listOrUndefined(raw) }))
  }

  async setAutonomy(level: AutonomyLevel | ''): Promise<boolean> {
    return this.commit((p) => ({
      ...p,
      autonomyLevel: AUTONOMY_LEVELS.includes(level as AutonomyLevel) ? (level as AutonomyLevel) : undefined,
    }))
  }

  /**
   * Designate the repository for X builds that name none. Only a
   * https://github.com/<owner>/<name> URL is kept; anything else clears it.
   */
  async setXDefaultRepository(url: string): Promise<boolean> {
    return this.commit((p) => ({ ...p, xDefaultRepository: xRepository(url.trim()) }))
  }

  /** The client id of the X app you registered. Empty string clears it. */
  async setXClientId(id: string): Promise<boolean> {
    return this.commit((p) => ({ ...p, xClientId: id.trim().slice(0, 120) }))
  }

  /**
   * The Spriite handle people mention. Empty string clears it. A leading @ is
   * accepted and stored stripped (the form X resolves); anything the panel's
   * own guard would refuse is stored as absence rather than a value a later
   * load would have to guess at.
   */
  async setXSpriiteHandle(handle: string): Promise<boolean> {
    return this.commit((p) => ({ ...p, xSpriiteHandle: xHandle(handle) }))
  }

  /**
   * Every save writes the whole object, so a value that failed to store must
   * not stay in memory: the next successful save would quietly persist it.
   * On failure the previous preferences stand and the caller reports it.
   *
   * Commits are serialized through one queue and each one writes the exact
   * object it built against the state the previous commit left — the same
   * pattern KeyVault uses. Without it, `save()` reading `this.prefs` when
   * the bridge op RUNS (not when the commit was made) lets two overlapping
   * commits cross-write each other's values, and a failed write's revert
   * would quietly erase a preference a concurrent commit had already
   * stored (the caller was told "saved").
   */
  private commit(update: (p: StoredPrefs) => StoredPrefs): Promise<boolean> {
    const run = this.writes.then(async () => {
      // The boot read never answered: re-read before overwriting, and build
      // the next record on what storage actually holds — or the first
      // successful save after a boot blip would quietly wipe every stored
      // preference and flag. A second null is not permission to write: it
      // means storage still holds a record this boot never saw, and a record
      // built from the subset in memory would erase it in one write — every
      // preference at once, the X requests switch and the durable runtime
      // flag included, silently de-authorizing a saved credential across the
      // relaunch. The save fails instead and the caller reports it; the
      // stored truth stands until a read answers.
      if (this.unknownRead) {
        const stored = await this.gateway.call((b) => b.getLocalStorage(KEY), 'getPrefsMerge')
        if (stored === null) return false
        if (stored !== '') this.take(stored)
        this.unknownRead = false
      }
      const next = update(this.prefs)
      const ok = await this.gateway.call(
        (b) => b.setLocalStorage(KEY, JSON.stringify(next)),
        'setPrefs',
      )
      if (ok !== true) return false
      this.prefs = next
      return true
    })
    this.writes = run.catch(() => undefined)
    return run
  }
}
