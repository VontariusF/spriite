/**
 * App state + persistence (spec §12). Durable state lives in the SDK's
 * companion-app storage (browser storage is unreliable here); writes are
 * debounced on the shared BLE link and flushed on background/exit.
 *
 * The host's headless-WebView migration protocol is implemented directly via
 * window.__getStateSnapshot / window.__restoreState (this SDK build does not
 * export the register helpers; the protocol is the same one the host calls).
 */
import type { AnyEngineSnapshot } from '../factory/engine'
import type { BridgeGateway } from '../bridge/bridge'

const KEY = 'sprite.factory.v1'
const SAVE_DEBOUNCE_MS = 1500

export type UiMode = 'scene' | 'listening' | 'transcribing'

export interface AppSnapshot {
  v: 1
  engine: AnyEngineSnapshot | null
  focusIdx: number
  uiMode: UiMode
  savedAt: number
}

export class AppStore {
  engineSnapshot: AnyEngineSnapshot | null = null
  focusIdx = 0
  uiMode: UiMode = 'scene'
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private loaded = false
  /**
   * True while the boot read never answered: the SDK returns '' for a
   * missing key, so a null from the gateway is a transport failure, not
   * absence. A snapshot written now would replace a stored state this boot
   * never saw with one built without it, so the write fails closed until a
   * read answers (the next boot's read).
   */
  private unknownRead = false
  private readonly gateway: BridgeGateway

  constructor(gateway: BridgeGateway) {
    this.gateway = gateway
  }

  toSnapshot(): AppSnapshot {
    return {
      v: 1,
      engine: this.engineSnapshot,
      focusIdx: this.focusIdx,
      uiMode: this.uiMode,
      savedAt: Date.now(),
    }
  }

  applySnapshot(s: AppSnapshot | null | undefined): void {
    if (!s || s.v !== 1) return
    this.engineSnapshot = s.engine ?? null
    this.focusIdx = typeof s.focusIdx === 'number' && s.focusIdx >= 0 ? s.focusIdx : 0
    // A capture session never auto-resumes (spec §10.2).
    this.uiMode = 'scene'
  }

  scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, SAVE_DEBOUNCE_MS)
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.loaded || this.unknownRead) return
    await this.gateway.call((b) => b.setLocalStorage(KEY, JSON.stringify(this.toSnapshot())), 'setStorage')
  }

  async load(): Promise<void> {
    const raw = await this.gateway.call((b) => b.getLocalStorage(KEY), 'getStorage')
    if (raw === null) {
      // A transport failure is not a missing key: retry once, and only an
      // answer may load — or mark the boot read unknown, which keeps every
      // later write from overwriting the state it never saw.
      const retry = await this.gateway.call((b) => b.getLocalStorage(KEY), 'getStorageRetry')
      if (retry === null) {
        this.unknownRead = true
        return
      }
      this.unknownRead = false
      this.loaded = true
      if (retry === '') return
      this.take(retry)
      return
    }
    this.unknownRead = false
    this.loaded = true
    if (raw === '') return
    this.take(raw)
  }

  /** Adopt a stored snapshot, discarding an unreadable one. */
  private take(raw: string): void {
    try {
      this.applySnapshot(JSON.parse(raw) as AppSnapshot)
    } catch (e) {
      console.warn('[store] discarding bad snapshot:', e)
    }
  }
}

/** Register the host background-state protocol at module init time. */
export function registerBackgroundState(store: AppStore): void {
  const w = window as unknown as Record<string, unknown>
  w.__getStateSnapshot = (): string => JSON.stringify(store.toSnapshot())
  w.__restoreState = (raw: unknown): void => {
    try {
      const snap = typeof raw === 'string' ? (JSON.parse(raw) as AppSnapshot) : (raw as AppSnapshot)
      store.applySnapshot(snap)
      console.log('[store] background state restored')
    } catch (e) {
      console.warn('[store] background restore failed:', e)
    }
  }
}
