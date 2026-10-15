/**
 * Pure projections for the phone screens (Home, Builds, Mission): what the
 * boards draw, computed from what the engine already exposes. No DOM here,
 * so the rules are testable on their own.
 */
import type { MilestoneMark, SceneProgress } from '../scenes/types'

/** A milestone as the engines' snapshots carry it (legacy and native shapes). */
export interface SnapMilestone {
  id?: string
  label: string
  status: string
  weight?: number
}

/** The milestones a snapshot carries, or null when it carries none. */
export function snapshotMilestones(snap: unknown): SnapMilestone[] | null {
  const list = (snap as { milestones?: unknown } | null)?.milestones
  if (!Array.isArray(list)) return null
  const out = list.filter((m): m is SnapMilestone =>
    m !== null && typeof m === 'object' && typeof (m as SnapMilestone).label === 'string' &&
    typeof (m as SnapMilestone).status === 'string')
  return out.length > 0 ? out : null
}

const markOf = (status: string): MilestoneMark =>
  status === 'accepted' || status === 'done' ? 'done'
    : status === 'submitted' || status === 'review' || status === 'under_review' ? 'review'
      : 'todo'

/**
 * The segmented bar's marks. The scene's own marks win; else the snapshot's
 * milestones; else the weights split into four segments (contract C3: "when
 * milestones is absent, derive segments from the weights"). Null when there
 * is nothing honest to draw (no progress, or a zero-weight plan).
 */
export function milestoneMarks(progress: SceneProgress | null | undefined, snap: unknown): MilestoneMark[] | null {
  if (!progress) return null
  const own = (progress as { milestones?: MilestoneMark[] }).milestones
  if (Array.isArray(own) && own.length > 0) return own.map((m) => (m === 'done' || m === 'review' ? m : 'todo'))
  const fromSnap = snapshotMilestones(snap)
  if (fromSnap) return fromSnap.map((m) => markOf(m.status))
  const total = Number(progress.totalWeight)
  if (!(total > 0)) return null
  const segments = 4
  const done = Math.max(0, Math.min(segments, Math.round((segments * Number(progress.acceptedWeight || 0)) / total)))
  const review = Math.max(0, Math.min(segments - done, Math.round((segments * Number(progress.pendingReviewWeight || 0)) / total)))
  return Array.from({ length: segments }, (_, i) => (i < done ? 'done' : i < done + review ? 'review' : 'todo'))
}

/**
 * "Milestone 2 of 4": N is the number of milestones done, the same count the
 * glasses' "BUILDING · N OF M" shows (Home.dc.html and HudRun.dc.html draw
 * done, done, in review, remaining as 2 of 4). An in-review milestone does
 * not move the count.
 */
export function milestoneLine(marks: MilestoneMark[] | null): string {
  if (!marks || marks.length === 0) return ''
  const done = marks.filter((m) => m === 'done').length
  return `Milestone ${done} of ${marks.length}`
}

export function marksLabel(marks: MilestoneMark[]): string {
  const done = marks.filter((m) => m === 'done').length
  const review = marks.filter((m) => m === 'review').length
  const todo = marks.length - done - review
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  return `Progress: ${plural(done, 'milestone', 'milestones')} done, ${review} in review, ${todo} to go`
}

export type BuildState = 'building' | 'waiting' | 'watching' | 'done'

/** Board dot colours (Home.dc.html builds list). */
export const BUILD_DOT: Record<BuildState, string> = {
  building: 'var(--sp-accent)',
  waiting: 'var(--sp-amber)',
  watching: 'var(--sp-factory)',
  done: 'var(--sp-done-dot)',
}

/** Which dot a builds row shows, from its own words and the asks list. */
export function buildState(
  row: { note: string; kind: 'local' | 'factory' | 'cursor'; missionId?: string },
  waitingIds: ReadonlySet<string>,
): BuildState {
  const note = row.note.toLowerCase()
  if ((row.missionId !== undefined && waitingIds.has(row.missionId)) || /waiting for your|needs you|question|asks you|your answer/.test(note)) return 'waiting'
  if (/\b(done|finished|complete|completed|merged|delivered|cancel+ed|stopped|failed|archived)\b/.test(note)) return 'done'
  if (row.kind !== 'local') return 'watching'
  return 'building'
}

/** "2 min ago" for a chat line's time; "just now" under a minute. */
export function ageOf(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - at) / 1000))
  if (!Number.isFinite(s) || s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  return `${d} d ago`
}

/** One row of "Who's working" (Mission.dc.html). */
export interface AgentRow { mono: string; name: string; doing: string; state: string; active: boolean }

interface SnapJob { label?: string; mode?: string; stage?: string; state?: string }

const JOB_STATE: Record<string, { word: string; active: boolean }> = {
  building: { word: 'Coding', active: true },
  queued: { word: 'Queued', active: false },
  review: { word: 'In review', active: true },
  repair: { word: 'Fixing', active: true },
  accepted: { word: 'Done', active: false },
  stopped: { word: 'Stopped', active: false },
}

/**
 * The Lead row's state word and what the Lead is doing, from the scene kind
 * and the snapshot's jobs (Mission.dc.html: "Planning" in the accent while a
 * build runs; the doing line is the Lead's own work, never the build status
 * that the timeline's current step already shows).
 */
export function leadActivity(kind: string | null | undefined, snap: unknown): { state: string; doing: string } {
  const s = snap as { jobs?: unknown } | null
  const jobs = s && Array.isArray(s.jobs) ? (s.jobs as SnapJob[]) : []
  const working = jobs.filter((j) => j.state === 'building' || j.state === 'repair').length
  switch (kind) {
    case 'decision':
    case 'decision_detail':
      return { state: 'Asking', doing: 'Waiting for your answer' }
    case 'plan':
      return { state: 'Planning', doing: 'Writing the plan' }
    case 'under_review':
      return { state: 'Reviewing', doing: 'Checking what the workers delivered' }
    case 'paused':
      return { state: 'Paused', doing: 'Holding until you resume' }
    case 'final':
      return { state: 'Done', doing: 'Wrapped up this build' }
    default:
      return {
        state: 'Planning',
        doing: working > 0 ? `Splitting the work across ${working} ${working === 1 ? 'worker' : 'workers'}`
          : jobs.length > 0 ? 'Lining up the next job' : 'Planning the next step',
      }
  }
}

/**
 * Lead, workers and reviewer, from what the snapshot exposes. Nothing is
 * invented: a snapshot without jobs shows the Lead alone, and no snapshot
 * (a watched build) shows nobody.
 */
export function agentRows(snap: unknown, leadDoing: string, leadState: string): AgentRow[] {
  const s = snap as { real?: boolean; jobs?: unknown; phase?: string; sessionId?: string | null } | null
  if (!s || s.real !== true) return []
  // A watched cloud build is not run by Spriite: nobody here is "working" on it.
  if (s.phase === 'attach') return []
  const jobs = Array.isArray(s.jobs) ? (s.jobs as SnapJob[]) : []
  if (jobs.length === 0 && !s.sessionId) return []
  const rows: AgentRow[] = [{ mono: 'L', name: 'Lead', doing: leadDoing || 'Planning the next step', state: leadState, active: true }]
  jobs.forEach((j, i) => {
    const st = JOB_STATE[j.state ?? ''] ?? { word: j.state ? j.state[0].toUpperCase() + j.state.slice(1) : 'Waiting', active: false }
    rows.push({
      mono: `W${i + 1}`,
      name: `Worker${j.mode === 'cursor' ? ' · Cursor' : ''}`,
      // A job spanning several plan lines names them on one line.
      doing: (j.label ?? '').split('\n').map((l) => l.trim()).filter(Boolean).join(', ') || `Job ${i + 1}`,
      state: st.word,
      active: st.active,
    })
  })
  if (jobs.length > 0) {
    const reviewing = jobs.some((j) => j.state === 'review')
    // Every job passed review (or the build is done): the reviewer is finished.
    const reviewed = s.phase === 'final' || jobs.every((j) => j.state === 'accepted')
    rows.push({
      mono: 'R', name: 'Reviewer',
      doing: reviewing ? 'Checking what the workers delivered' : reviewed ? 'Checked every job' : 'Starts when workers report',
      state: reviewing ? 'Reviewing' : reviewed ? 'Done' : 'Waiting', active: reviewing,
    })
  }
  return rows
}
