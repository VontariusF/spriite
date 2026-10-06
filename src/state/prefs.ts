/**
 * User preferences for the real engine (phone-side choices, not secrets):
 * which service runs the worker role, how large tasks split across
 * parallel workers, and whether the HUD asks before the worker opens the
 * pull request. Stored in the Even app's SDK storage next to (but
 * separate from) keys and mission state. Never logged.
 */
import type { BridgeGateway } from '../bridge/bridge'

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

interface StoredPrefs {
  v: 1
  worker?: WorkerPref
  /** Workers that split a large task (1 = one at a time, 2-4 = parallel). */
  jobs?: number
  /** Ask on the HUD before the worker opens the pull request. */
  askBeforePr?: boolean
}

export class PrefsVault {
  private prefs: StoredPrefs = { v: 1 }
  private readonly gateway: BridgeGateway

  constructor(gateway: BridgeGateway) {
    this.gateway = gateway
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

  async load(): Promise<void> {
    const raw = await this.gateway.call((b) => b.getLocalStorage(KEY), 'getPrefs')
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as StoredPrefs
      if (parsed?.v === 1) this.prefs = { v: 1, ...parsed }
    } catch {
      console.warn('[prefs] stored preferences unreadable; ignoring')
    }
  }

  async setWorker(worker: WorkerPref): Promise<boolean> {
    this.prefs = { ...this.prefs, worker }
    return this.save()
  }

  async setJobs(jobs: number): Promise<boolean> {
    const n = Math.round(jobs)
    this.prefs = { ...this.prefs, jobs: n >= 1 && n <= 4 ? n : 1 }
    return this.save()
  }

  async setAskBeforePr(ask: boolean): Promise<boolean> {
    this.prefs = { ...this.prefs, askBeforePr: ask }
    return this.save()
  }

  private async save(): Promise<boolean> {
    const ok = await this.gateway.call(
      (b) => b.setLocalStorage(KEY, JSON.stringify(this.prefs)),
      'setPrefs',
    )
    return ok === true
  }
}
