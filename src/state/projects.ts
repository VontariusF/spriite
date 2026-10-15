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
  private pending = new Map<string, RealSnapshot>()
  private writes: Promise<unknown> = Promise.resolve()
  private readonly gateway: BridgeGateway
  /**
   * True while the boot read never answered: the SDK returns '' for a
   * missing key, so a null from the gateway is a transport failure, not
   * absence. Until a read answers, the list in memory may be a subset of
   * what storage holds, and a flush must adopt the stored list before it
   * upserts — otherwise the first save after a boot blip would drop every
   * project the failed read never saw.
   */
  private unknownRead = false

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
    this.pending.delete(snap.goal)
    this.pending.set(snap.goal, snap)
    while (this.pending.size > MAX_PROJECTS) this.pending.delete(this.pending.keys().next().value!)
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, SAVE_DEBOUNCE_MS)
  }

  /** Push the pending save out now (background/exit; never loses a state). */
  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const run = this.writes.then(async () => {
      const batch = this.pending
      if (batch.size === 0) return
      this.pending = new Map()
      let saved = false
      try {
        // A second null keeps the read unknown and permits no write.
        let base = this.stored
        if (this.unknownRead) {
          const stored = await this.gateway.call((b) => b.getLocalStorage(KEY), 'getProjectsMerge')
          if (stored === null) return
          base = this.decode(stored)
        }
        let rows = base.projects
        for (const snap of batch.values()) {
          const status = projectStatusOf(snap)
          if (!status || !snap.goal) continue
          rows = [{ goal: snap.goal, status, updatedAt: Date.now(), snapshot: snap },
            ...rows.filter((p) => p.goal !== snap.goal)].slice(0, MAX_PROJECTS)
        }
        const next: StoredProjects = { v: 1, projects: rows }
        const ok = await this.gateway.call((b) => b.setLocalStorage(KEY, JSON.stringify(next)), 'setProjects')
        if (ok !== true) return
        this.stored = next
        this.unknownRead = false
        saved = true
      } catch {
        console.warn('[projects] save failed')
      } finally {
        if (!saved) {
          // Retain failed work without replacing newer snapshots received while
          // the bridge was awaited. Another explicit flush/debounce retries;
          // a persistent outage never arms an automatic retry loop.
          const retry = new Map(batch)
          for (const [goal, snap] of this.pending) {
            retry.delete(goal)
            retry.set(goal, snap)
          }
          while (retry.size > MAX_PROJECTS) retry.delete(retry.keys().next().value!)
          this.pending = retry
        }
      }
    })
    this.writes = run.catch(() => undefined)
    return run
  }

  async load(): Promise<void> {
    const raw = await this.gateway.call((b) => b.getLocalStorage(KEY), 'getProjects')
    if (raw === null) {
      // A transport failure is not a missing key: retry once, and only an
      // answer may load.
      const retry = await this.gateway.call((b) => b.getLocalStorage(KEY), 'getProjectsRetry')
      if (retry === null) {
        this.unknownRead = true
        return
      }
      this.unknownRead = false
      this.take(retry)
      return
    }
    this.unknownRead = false
    if (raw === '') return
    this.take(raw)
  }

  /** Adopt a stored list, whatever entries in it are shaped. */
  private take(raw: string): void {
    this.stored = this.decode(raw)
  }

  private decode(raw: string): StoredProjects {
    if (raw === '') return { v: 1, projects: [] }
    try {
      const parsed = JSON.parse(raw) as StoredProjects
      if (parsed?.v === 1 && Array.isArray(parsed.projects)) {
        const goals = new Set<string>()
        const projects = parsed.projects
          .filter((p) => p && typeof p.goal === 'string' && p.goal !== '' &&
            typeof p.updatedAt === 'number' && Number.isFinite(p.updatedAt) &&
            ['planning', 'building', 'review', 'repair', 'pr', 'final', 'fault'].includes(p.status) &&
            p.snapshot && typeof p.snapshot === 'object' && !Array.isArray(p.snapshot) &&
            p.snapshot.goal === p.goal)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .filter((p) => {
            if (goals.has(p.goal)) return false
            goals.add(p.goal)
            return true
          })
          .slice(0, MAX_PROJECTS)
        return { v: 1, projects }
      }
    } catch {
      console.warn('[projects] stored list unreadable; ignoring')
    }
    return { v: 1, projects: [] }
  }
}
