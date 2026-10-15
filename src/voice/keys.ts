/**
 * User-supplied service keys and connection choices (bring-your-own-key).
 * Stored in the Even app's SDK storage on the user's phone, separate from
 * mission state so a mission snapshot, log line, or scene can never carry a
 * key. Keys are never logged.
 */
import type { BridgeGateway } from '../bridge/bridge'
import { canonicalBrokerUrl } from '../native/decode'
import type { RepoMode } from '../pair/types'

const KEY = 'spriite.keys.v1'

/** The credentials a working setup is made of: a Factory key plus the
 *  repository the workers build on. Cursor and GitHub are optional. */
export interface SetupCredentials {
  factory: string
  repoUrl: string
  /** 'per_idea': every build gets a new private repository named from the
   *  request, so no repository needs choosing first. Absent behaves as 'one'. */
  repoMode?: RepoMode
}

/** The repository modes a stored record may carry (C4). */
export const REPO_MODES: readonly RepoMode[] = ['per_idea', 'one']

/**
 * The one credential truth (the owner's rule): a Factory key plus a build
 * repository (or a new repository per idea) is a working setup.
 *
 * No runtime imports and erasable-only syntax so Node test scripts load it.
 */
export function realSetupWorks(keys: SetupCredentials): boolean {
  return Boolean(keys.factory && (keys.repoUrl || keys.repoMode === 'per_idea'))
}

/**
 * The key fields "Move to another phone" carries. The X pair is not among
 * them: X rotates the refresh token on every renewal, so a pair copied to a
 * second phone would kill the first one's (or the host reader's) grant. X is
 * connected again from the paired computer (host sign-in) instead.
 */
const TRANSFER_FIELDS = [
  'nativeBroker', 'nativeBrokerUrl', 'elevenLabs', 'factory', 'cursor', 'github', 'repoUrl', 'computerId', 'repoMode',
] as const

interface StoredKeys {
  v: 1
  /** Authenticated native broker credential. Never part of prefs or archives. */
  nativeBroker?: string
  /** Credential scope is committed atomically with its token, not inferred from prefs. */
  nativeBrokerUrl?: string
  /** ElevenLabs: live speech-to-text. */
  elevenLabs?: string
  /** Factory: the orchestrator runs in the user's account (Sessions API). */
  factory?: string
  /** Cursor: the build worker (Cloud Agents API). */
  cursor?: string
  /** GitHub: the repository source (picked or created on the phone). */
  github?: string
  /** X OAuth user access token (Authorization: Bearer). */
  x?: string
  /** X OAuth refresh token, stored with the access token it rotates. X rotates
   * the whole pair on every refresh, so both always move together. */
  xRefresh?: string
  /** Opaque identity for the credential generation, not the token itself. */
  xCredentialRef?: string
  /** Repository the workers build on (chosen on the phone). */
  repoUrl?: string
  /** Droid Computer the orchestrator session runs on, when the user has one. */
  computerId?: string
  /** Where builds go: a new private repository per idea, or the one in repoUrl. */
  repoMode?: RepoMode
}

export class KeyVault {
  private keys: StoredKeys = { v: 1 }
  private readonly gateway: BridgeGateway
  private writes: Promise<unknown> = Promise.resolve()
  /**
   * True while the boot read never answered: the SDK returns '' for a
   * missing key, so a null from the gateway is a transport failure, not
   * absence (the same contract the mission store's KV adapter enforces).
   * Until a read answers, the record in memory may be a subset of what
   * storage holds, and a commit must merge with the stored record before it
   * overwrites it — otherwise the owner's next save would wipe every
   * credential the failed read never saw.
   */
  private unknownRead = false

  constructor(gateway: BridgeGateway) {
    this.gateway = gateway
  }

  get elevenLabs(): string {
    return this.keys.elevenLabs ?? ''
  }

  get factory(): string {
    return this.keys.factory ?? ''
  }

  get nativeBroker(): string {
    return this.keys.nativeBroker ?? ''
  }

  get nativeBrokerHint(): string {
    return this.nativeBroker ? '••••' : ''
  }

  nativeBrokerFor(brokerUrl: string): string {
    const canonical = canonicalBrokerUrl(brokerUrl)
    return canonical && canonical === this.keys.nativeBrokerUrl ? this.nativeBroker : ''
  }

  setNativeBroker(credential: string, brokerUrl?: string): Promise<boolean> {
    const token = credential.trim()
    const canonical = brokerUrl ? canonicalBrokerUrl(brokerUrl) : null
    if (token && brokerUrl !== undefined && !canonical) return Promise.resolve(false)
    return this.commit((keys) => ({
      ...keys, nativeBroker: token || undefined,
      nativeBrokerUrl: token && canonical ? canonical : undefined,
    }))
  }

  clearNativeBroker(): Promise<boolean> {
    return this.setNativeBroker('')
  }

  get cursor(): string {
    return this.keys.cursor ?? ''
  }

  get github(): string {
    return this.keys.github ?? ''
  }

  get x(): string {
    return this.keys.x ?? ''
  }

  get xRefresh(): string {
    return this.keys.xRefresh ?? ''
  }

  get xCredentialRef(): string {
    return this.keys.xCredentialRef ?? ''
  }

  get xHint(): string {
    return this.x ? '••••' : ''
  }

  /**
   * Rotate the reference even when retrying the same token: failed binding
   * must never leave a previous identity authorized with this credential.
   * The refresh token is written in the same record, so a bare access token
   * (no refresh token) also means "stop auto-refreshing" — a stale refresh
   * token from another account must never survive a credential change.
   */
  setX(token: string, refreshToken = ''): Promise<boolean> {
    return this.commit((keys) => ({
      ...keys,
      x: token.trim() || undefined,
      xRefresh: token.trim() ? refreshToken.trim() || undefined : undefined,
      xCredentialRef: token.trim() ? crypto.randomUUID() : undefined,
    }))
  }

  /**
   * Persist a pair X rotated during a refresh, in place. The credential
   * generation is deliberately left alone: the binding was verified against
   * this same OAuth identity, and a rotation must not orphan it.
   */
  setXRotation(accessToken: string, refreshToken: string): Promise<boolean> {
    return this.commit((keys) => ({
      ...keys,
      x: accessToken.trim() || undefined,
      xRefresh: refreshToken.trim() || undefined,
    }))
  }

  clearX(): Promise<boolean> {
    return this.setX('')
  }

  /**
   * Drop only the refresh token, after the host verified a handoff of the
   * pair: X rotates on every renewal, so a copy left here could renew and
   * kill the host's. The access token and its generation stay (they expire
   * on their own, and the binding stays readable); renewal here is over.
   */
  clearXRefresh(): Promise<boolean> {
    return this.commit((keys) => ({ ...keys, xRefresh: undefined }))
  }

  get repoUrl(): string {
    return this.keys.repoUrl ?? ''
  }

  get computerId(): string {
    return this.keys.computerId ?? ''
  }

  /** Where builds go (default 'one': the repository in repoUrl). */
  get repoMode(): RepoMode {
    return this.keys.repoMode ?? 'one'
  }

  setRepoMode(mode: RepoMode): Promise<boolean> {
    if (!REPO_MODES.includes(mode)) return Promise.resolve(false)
    return this.commit((keys) => ({ ...keys, repoMode: mode }))
  }

  /**
   * The keys a move carries, as plain strings (absent fields are left out).
   * Never logged; it only ever travels inside the PAKE-encrypted envelope.
   */
  exportForTransfer(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const field of TRANSFER_FIELDS) {
      const value = this.keys[field]
      if (typeof value === 'string' && value !== '') out[field] = value
    }
    return out
  }

  /**
   * Adopt the keys another phone moved here, through the same restore
   * validation a load applies: a wrong-typed or unknown field is absence, a
   * broker token keeps its scope only with a canonical broker URL. Fields the
   * record does not carry are left as they are. One write.
   */
  importFromTransfer(rec: Record<string, string>): Promise<boolean> {
    if (!rec || typeof rec !== 'object') return Promise.resolve(false)
    const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
    const incoming: Partial<StoredKeys> = {}
    for (const field of TRANSFER_FIELDS) {
      if (field === 'repoMode' || field === 'nativeBrokerUrl' || field === 'nativeBroker') continue
      const value = str((rec as Record<string, unknown>)[field])
      if (value !== undefined) incoming[field] = value
    }
    const mode = (rec as Record<string, unknown>).repoMode
    if (REPO_MODES.includes(mode as RepoMode)) incoming.repoMode = mode as RepoMode
    const token = str((rec as Record<string, unknown>).nativeBroker)
    const scope = canonicalBrokerUrl(str((rec as Record<string, unknown>).nativeBrokerUrl) ?? '')
    if (token && scope) { incoming.nativeBroker = token; incoming.nativeBrokerUrl = scope }
    if (Object.keys(incoming).length === 0) return Promise.resolve(false)
    return this.commit((keys) => ({ ...keys, ...incoming, v: 1 }))
  }

  /** "sk_...ab12" style hint for the setup screen; never the whole key. */
  private hint(k: string): string {
    if (!k) return ''
    return k.length <= 8 ? '••••' : `${k.slice(0, 3)}••••${k.slice(-4)}`
  }

  get elevenLabsHint(): string {
    return this.hint(this.elevenLabs)
  }

  get factoryHint(): string {
    return this.hint(this.factory)
  }

  get cursorHint(): string {
    return this.hint(this.cursor)
  }

  get githubHint(): string {
    return this.hint(this.github)
  }

  /** True when real orchestration can run: the shared setup predicate
   *  (see realSetupWorks). Factory plays orchestrator and, without a Cursor
   *  key, worker too; Cursor and GitHub are optional. */
  get orchestratorReady(): boolean {
    return realSetupWorks(this)
  }

  async load(): Promise<void> {
    const raw = await this.gateway.call((b) => b.getLocalStorage(KEY), 'getKeys')
    if (raw === null) {
      // A transport failure is not a missing key: retry once (the same
      // discipline the KV adapter applies), and only an answer may load.
      const retry = await this.gateway.call((b) => b.getLocalStorage(KEY), 'getKeysRetry')
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
   * load — a wrong-typed field is absence, never a value the masked hints
   * would slice (a non-string credential crashes the Setup render) or the
   * engine would hand to a provider.
   */
  private take(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as StoredKeys
      if (parsed?.v !== 1) return
      const str = (v: unknown): string | undefined =>
        typeof v === 'string' && v !== '' ? v : undefined
      this.keys = {
        v: 1,
        nativeBroker: str(parsed.nativeBroker),
        nativeBrokerUrl: canonicalBrokerUrl(str(parsed.nativeBrokerUrl) ?? '') ?? undefined,
        elevenLabs: str(parsed.elevenLabs),
        factory: str(parsed.factory),
        cursor: str(parsed.cursor),
        github: str(parsed.github),
        x: str(parsed.x),
        xRefresh: str(parsed.xRefresh),
        xCredentialRef: str(parsed.xCredentialRef),
        repoUrl: str(parsed.repoUrl),
        computerId: str(parsed.computerId),
        repoMode: REPO_MODES.includes(parsed.repoMode as RepoMode) ? parsed.repoMode : undefined,
      }
    } catch {
      console.warn('[keys] stored keys unreadable; ignoring')
    }
  }

  async setElevenLabs(key: string): Promise<boolean> {
    return this.commit((keys) => ({ ...keys, elevenLabs: key.trim() || undefined }))
  }

  async setFactory(key: string): Promise<boolean> {
    return this.commit((keys) => ({ ...keys, factory: key.trim() || undefined }))
  }

  async setCursor(key: string): Promise<boolean> {
    return this.commit((keys) => ({ ...keys, cursor: key.trim() || undefined }))
  }

  async setGithub(token: string): Promise<boolean> {
    // Switching GitHub accounts invalidates the saved repository choice.
    return this.commit((keys) => ({
      ...keys,
      github: token.trim() || undefined,
      repoUrl: keys.github && keys.github !== token.trim() ? undefined : keys.repoUrl,
    }))
  }

  async setRepoUrl(repoUrl: string): Promise<boolean> {
    return this.commit((keys) => ({ ...keys, repoUrl: repoUrl.trim() || undefined }))
  }

  async setComputerId(computerId: string): Promise<boolean> {
    return this.commit((keys) => ({ ...keys, computerId: computerId.trim() || undefined }))
  }

  async clearElevenLabs(): Promise<boolean> {
    return this.setElevenLabs('')
  }

  async clearFactory(): Promise<boolean> {
    return this.setComputerIdWithFactory('', '')
  }

  async clearCursor(): Promise<boolean> {
    return this.setCursor('')
  }

  async clearGithub(): Promise<boolean> {
    // Removing GitHub removes the repository choice with it.
    return this.commit((keys) => ({ ...keys, github: undefined, repoUrl: undefined }))
  }

  private async setComputerIdWithFactory(computerId: string, factory: string): Promise<boolean> {
    return this.commit((keys) => ({ ...keys, computerId: computerId || undefined, factory: factory || undefined }))
  }

  private async commit(update: (keys: StoredKeys) => StoredKeys): Promise<boolean> {
    const run = this.writes.then(async () => {
      // The boot read never answered: re-read before overwriting, and build
      // the next record on what storage actually holds. Without this, the
      // first successful save after a boot blip would persist only its own
      // change and quietly wipe every other stored credential. A second null
      // is not permission to write: it means storage still holds a record
      // this boot never saw, and a record built from the subset in memory
      // would erase the owner's saved X token pair (and every other key) in
      // one write. The save fails instead and the caller reports it; the
      // stored truth stands until a read answers.
      if (this.unknownRead) {
        const stored = await this.gateway.call((b) => b.getLocalStorage(KEY), 'getKeysMerge')
        if (stored === null) return false
        if (stored !== '') this.take(stored)
        this.unknownRead = false
      }
      const next = update(this.keys)
      const ok = await this.gateway.call(
        (b) => b.setLocalStorage(KEY, JSON.stringify(next)),
        'setKeys',
      )
      if (ok !== true) return false
      this.keys = next
      return true
    })
    this.writes = run.catch(() => undefined)
    return run
  }
}
