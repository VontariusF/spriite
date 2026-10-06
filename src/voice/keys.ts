/**
 * User-supplied service keys and connection choices (bring-your-own-key).
 * Stored in the Even app's SDK storage on the user's phone, separate from
 * mission state so a mission snapshot, log line, or scene can never carry a
 * key. Keys are never logged.
 */
import type { BridgeGateway } from '../bridge/bridge'

const KEY = 'spriite.keys.v1'

interface StoredKeys {
  v: 1
  /** ElevenLabs: live speech-to-text. */
  elevenLabs?: string
  /** Factory: the orchestrator runs in the user's account (Sessions API). */
  factory?: string
  /** Cursor: the build worker (Cloud Agents API). */
  cursor?: string
  /** GitHub: the repository source (picked or created on the phone). */
  github?: string
  /** Repository the workers build on (chosen on the phone). */
  repoUrl?: string
  /** Droid Computer the orchestrator session runs on, when the user has one. */
  computerId?: string
}

export class KeyVault {
  private keys: StoredKeys = { v: 1 }
  private readonly gateway: BridgeGateway

  constructor(gateway: BridgeGateway) {
    this.gateway = gateway
  }

  get elevenLabs(): string {
    return this.keys.elevenLabs ?? ''
  }

  get factory(): string {
    return this.keys.factory ?? ''
  }

  get cursor(): string {
    return this.keys.cursor ?? ''
  }

  get github(): string {
    return this.keys.github ?? ''
  }

  get repoUrl(): string {
    return this.keys.repoUrl ?? ''
  }

  get computerId(): string {
    return this.keys.computerId ?? ''
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

  /** True when real orchestration can run. Factory plays orchestrator and,
   *  without a Cursor key, worker too; Cursor and GitHub are optional. */
  get orchestratorReady(): boolean {
    return Boolean(this.factory && this.repoUrl)
  }

  async load(): Promise<void> {
    const raw = await this.gateway.call((b) => b.getLocalStorage(KEY), 'getKeys')
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as StoredKeys
      if (parsed?.v === 1) this.keys = { v: 1, ...parsed }
    } catch {
      console.warn('[keys] stored keys unreadable; ignoring')
    }
  }

  async setElevenLabs(key: string): Promise<boolean> {
    this.keys = { ...this.keys, elevenLabs: key.trim() || undefined }
    return this.save()
  }

  async setFactory(key: string): Promise<boolean> {
    this.keys = { ...this.keys, factory: key.trim() || undefined }
    return this.save()
  }

  async setCursor(key: string): Promise<boolean> {
    this.keys = { ...this.keys, cursor: key.trim() || undefined }
    return this.save()
  }

  async setGithub(token: string): Promise<boolean> {
    // Switching GitHub accounts invalidates the saved repository choice.
    const repoUrl = this.github && this.github !== token.trim() ? undefined : this.keys.repoUrl
    this.keys = { ...this.keys, github: token.trim() || undefined, repoUrl }
    return this.save()
  }

  async setRepoUrl(repoUrl: string): Promise<boolean> {
    this.keys = { ...this.keys, repoUrl: repoUrl.trim() || undefined }
    return this.save()
  }

  async setComputerId(computerId: string): Promise<boolean> {
    this.keys = { ...this.keys, computerId: computerId.trim() || undefined }
    return this.save()
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
    this.keys = { ...this.keys, github: undefined, repoUrl: undefined }
    return this.save()
  }

  private async setComputerIdWithFactory(computerId: string, factory: string): Promise<boolean> {
    this.keys = { ...this.keys, computerId: computerId || undefined, factory: factory || undefined }
    return this.save()
  }

  private async save(): Promise<boolean> {
    const ok = await this.gateway.call(
      (b) => b.setLocalStorage(KEY, JSON.stringify(this.keys)),
      'setKeys',
    )
    return ok === true
  }
}
