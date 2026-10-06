/**
 * Recent projects (mission history) for the Spriite home list. One entry per
 * real mission, keyed by its goal: live status plus the engine snapshot, so
 * the wearer can pick a session back up from the glasses. Durable state
 * lives in the SDK's companion-app storage, next to (never inside) keys and
 * preferences; a snapshot never carries a key.
 */
import type { BridgeGateway } from '../bridge/bridge'
import type { RealSnapshot } from '../factory/real'

const KEY = 'spriite.projects.v1'
const MAX_PROJECTS = 8
const SAVE_DEBOUNCE_MS = 2500

export type ProjectStatus = 'planning' | 'building' | 'review' | 'repair' | 'pr' | 'final' | 'fault'

export interface ProjectMeta {
  goal: string
  status: ProjectStatus
  updatedAt: number
  /** The lead Factory session behind the mission (cloud-row dedup key). */
  sessionId: string | null
}

interface StoredProject extends Omit<ProjectMeta, 'sessionId'> {
  snapshot: RealSnapshot
}

interface StoredProjects {
  v: 1
  projects: StoredProject[]
}

/** Live status for a snapshot, or null when there is no mission to persist. */
export function projectStatusOf(snap: RealSnapshot): ProjectStatus | null {
  if (snap.faultKind) return 'fault'
  switch (snap.phase) {
    case 'plan': return 'planning'
    case 'building': return 'building'
    case 'review': return 'review'
    case 'repair': return 'repair'
    case 'pr': return 'pr'
    case 'final': return 'final'
    default: return null // meet/goal/transcript: nothing durable yet
  }
}

export class ProjectsVault {
  private stored: StoredProjects = { v: 1, projects: [] }
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private pending: RealSnapshot | null = null
  private readonly gateway: BridgeGateway

  constructor(gateway: BridgeGateway) {
    this.gateway = gateway
  }

  /** Newest first; the home list shows these and nothing else. */
  list(): ProjectMeta[] {
    return this.stored.projects.map(({ goal, status, updatedAt, snapshot }) => ({
      goal,
      status,
      updatedAt,
      sessionId: snapshot?.sessionId ?? null,
    }))
  }

  /** The snapshot behind a listed project, or null when it is gone. */
  snapshotFor(goal: string): RealSnapshot | null {
    return this.stored.projects.find((p) => p.goal === goal)?.snapshot ?? null
  }

  /**
   * Persist the active mission (upsert by goal; newest first; capped). No
   * mission (status null) still prunes a finished entry's staleness away.
   * Writes are debounced off the BLE link; flush() pushes them out.
   */
  saveActive(snap: RealSnapshot): void {
    const status = projectStatusOf(snap)
    if (!status || !snap.goal) return
    this.pending = snap
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, SAVE_DEBOUNCE_MS)
  }

  /** Push the pending save out now (background/exit; never loses a state). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const snap = this.pending
    if (!snap) return
    this.pending = null
    const status = projectStatusOf(snap)
    if (!status || !snap.goal) return
    const rest = this.stored.projects.filter((p) => p.goal !== snap.goal)
    this.stored = {
      v: 1,
      projects: [{ goal: snap.goal, status, updatedAt: Date.now(), snapshot: snap }, ...rest].slice(0, MAX_PROJECTS),
    }
    try {
      await this.gateway.call((b) => b.setLocalStorage(KEY, JSON.stringify(this.stored)), 'setProjects')
    } catch (e) {
      console.warn('[projects] save failed:', e)
    }
  }

  async load(): Promise<void> {
    const raw = await this.gateway.call((b) => b.getLocalStorage(KEY), 'getProjects')
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as StoredProjects
      if (parsed?.v === 1 && Array.isArray(parsed.projects)) {
        this.stored = {
          v: 1,
          projects: parsed.projects.filter((p) => p && typeof p.goal === 'string' && p.snapshot),
        }
      }
    } catch {
      console.warn('[projects] stored list unreadable; ignoring')
    }
  }
}
