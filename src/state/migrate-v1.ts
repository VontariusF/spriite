/**
 * One-time migration from the v1 persistence (spec §22) into the v2 mission
 * store. Runs on the first v2 boot:
 *
 *  - imports the active engine snapshot (`sprite.factory.v1`) and the
 *    projects vault (`spriite.projects.v1`) as ID-keyed missions in their
 *    last-known state, preserving provider session/agent/run references;
 *  - freezes each mission's configuration from its snapshot; a missing
 *    repository or config is held for a private recovery choice
 *    (`policyRevision: 'v1-recovery-required'`), never silently defaulted;
 *  - leaves every v1 record intact until the migration is verified;
 *  - is idempotent: the state's migratedFromV1 marker guards re-runs.
 *
 * Honesty rules (spec §22): v1 never recorded pause intent or a real event
 * journal, so imported missions are `running` but marked `stale`; the first
 * briefing after migration says "restored, checking runs" rather than
 * fabricating history. Goal-keyed entries that v1 already overwrote cannot
 * be reconstructed; every surviving entry becomes its own mission with a
 * distinct stable ID. v1 message-seen markers are not portable —
 * reconciliation re-primes session history as seen.
 */
import { draftEvent, type EventDraft } from '../domain/events'
import { mintId, nowIso } from '../domain/ids'
import type { Mission, MissionConfig, MissionPhase, ProviderRun, SpriiteState } from '../domain/types'
import type { KVBackend, MissionStore } from './mission-store'

const V1_APP_KEY = 'sprite.factory.v1'
const V1_PROJECTS_KEY = 'spriite.projects.v1'
/** Imported missions with no recoverable repository wait for their owner. */
export const V1_RECOVERY_REQUIRED = 'v1-recovery-required'

export interface MigrationOutcome {
  migrated: boolean
  missionCount: number
  runCount: number
  warnings: string[]
  error?: 'rejected' | 'broken' | 'storage'
}

// --- v1 record shapes (defensive structural reads; v1 is frozen history) ---

interface V1Job {
  label?: string
  mode?: string
  agentId?: string | null
  runId?: string | null
  sessionId?: string | null
  branch?: string
  state?: string
}

interface V1RealSnapshot {
  real?: boolean
  phase?: string
  goal?: string
  sessionId?: string | null
  repoUrl?: string
  missionRepo?: string
  workerPref?: string
  jobCount?: number
  askBeforePr?: boolean
  jobs?: V1Job[]
  decisionPending?: boolean
  /** v1 recorded a service fault on this mission (auth/billing/network/...). */
  faultKind?: string | null
}

interface V1StoredProject {
  goal?: string
  status?: string
  updatedAt?: number
  snapshot?: V1RealSnapshot | null
}

function phaseFromSnapshot(snap: V1RealSnapshot | null): MissionPhase {
  switch (snap?.phase) {
    case 'plan':
      return 'planning'
    case 'building':
      return 'building'
    case 'review':
      return 'reviewing'
    case 'repair':
      return 'repairing'
    case 'pr':
      return 'integrating'
    case 'final':
      return 'completed'
    case 'transcript':
    case 'meet':
    case 'goal':
      return 'received'
    default:
      return 'building'
  }
}

function phaseFromStatus(status?: string): MissionPhase {
  switch (status) {
    case 'planning':
      return 'planning'
    case 'review':
      return 'reviewing'
    case 'repair':
      return 'repairing'
    case 'pr':
      return 'integrating'
    case 'final':
      return 'completed'
    default:
      return 'building'
  }
}

/** Frozen per-mission config (spec §7): 'auto'/'mix' record both providers
 *  honestly; a missing repository holds the mission for recovery. */
function v1Config(snap: V1RealSnapshot | null): MissionConfig {
  const repository = String(snap?.missionRepo || snap?.repoUrl || '').trim()
  const pref = snap?.workerPref
  const workerProviders: Array<'factory' | 'cursor'> =
    pref === 'cursor' ? ['cursor'] : pref === 'factory' ? ['factory'] : ['cursor', 'factory']
  const jobs = typeof snap?.jobCount === 'number' && snap.jobCount >= 1 ? Math.round(snap.jobCount) : 1
  return {
    executionBackend: 'legacy',
    leadProvider: 'factory',
    workerProviders,
    maxConcurrentWorkers: jobs,
    repository,
    baseRef: 'main',
    policyRevision: repository ? 'v1' : V1_RECOVERY_REQUIRED,
    // The engine preference is carried separately from the provider list so a
    // restored mission rebuilds the SAME worker setup (an 'auto' snapshot is
    // not the same thing as an explicit 'mix').
    workerPreference: pref === 'cursor' || pref === 'factory' || pref === 'mix' ? pref : 'auto',
  }
}

/** Preserve provider session/agent/run references as first-class runs. */
function v1Runs(snap: V1RealSnapshot, missionId: string, runs: Record<string, ProviderRun>): void {
  if (snap.sessionId) {
    const runId = mintId('run')
    runs[runId] = {
      schemaVersion: 2,
      runId,
      missionId,
      provider: 'factory',
      role: 'lead',
      accountId: null,
      sessionOrAgentId: snap.sessionId,
      remoteRunId: null,
      branch: '',
      baseSha: '',
      currentSha: '',
      observedState: 'migrated-v1',
      lastObservedAt: null,
    }
  }
  for (const j of snap.jobs ?? []) {
    const provider = j?.mode === 'cursor' ? 'cursor' : 'factory'
    const sessionOrAgentId = provider === 'cursor' ? (j.agentId ?? null) : (j.sessionId ?? null)
    if (!sessionOrAgentId && !j.runId) continue
    const runId = mintId('run')
    runs[runId] = {
      schemaVersion: 2,
      runId,
      missionId,
      provider,
      role: 'worker',
      accountId: null,
      sessionOrAgentId,
      remoteRunId: j.runId ?? null,
      branch: String(j.branch ?? ''),
      baseSha: '',
      currentSha: '',
      observedState: String(j.state ?? 'migrated-v1'),
      lastObservedAt: null,
    }
  }
}

/**
 * Run the migration. No-op when the marker is already set or no v1 data
 * exists. Everything lands in ONE commit envelope: the import is atomic —
 * either the v2 world sees the whole v1 history as missions, or nothing.
 */
export async function migrateV1(kv: KVBackend, store: MissionStore<SpriiteState>): Promise<MigrationOutcome> {
  // Load before migrating: the marker, seq and entityId must come from the
  // durable state, not from an unloaded instance's initial memory (a commit
  // on an unloaded store would auto-load inside the mutation anyway, but the
  // marker check and event entity would already have read the wrong state).
  await store.load()
  const state = store.current
  if (state.migratedFromV1) {
    return { migrated: false, missionCount: 0, runCount: 0, warnings: [] }
  }
  const [appRaw, projectsRaw] = await Promise.all([kv.get(V1_APP_KEY), kv.get(V1_PROJECTS_KEY)])
  if (appRaw === null && projectsRaw === null) {
    return { migrated: false, missionCount: 0, runCount: 0, warnings: [] }
  }

  const warnings: string[] = []
  let active: V1RealSnapshot | null = null
  if (appRaw !== null) {
    try {
      const parsed = JSON.parse(appRaw) as { v?: number; engine?: V1RealSnapshot | null }
      if (parsed?.engine && parsed.engine.real === true) active = parsed.engine
    } catch {
      warnings.push('v1 active snapshot unreadable; not imported')
    }
  }
  let projects: V1StoredProject[] = []
  if (projectsRaw !== null) {
    try {
      const parsed = JSON.parse(projectsRaw) as { v?: number; projects?: V1StoredProject[] }
      if (Array.isArray(parsed?.projects)) projects = parsed.projects
    } catch {
      warnings.push('v1 projects vault unreadable; not imported')
    }
  }

  const entityId = state.entity.entityId
  const missions: Mission[] = []
  const runs: Record<string, ProviderRun> = {}
  const engineSnapshots: Record<string, unknown> = {}
  const events: EventDraft[] = []
  const seenGoals = new Set<string>()
  /**
   * Provider sessions the durable state already owns. A v1 snapshot that
   * carries one of these is the SAME work, not a second mission: importing it
   * would put two missions on one lead session (spec §22). This is the check
   * that keeps the migration from re-importing a mission the runtime is
   * already running when a stale v1 snapshot (any writer) reappears.
   */
  const ownedLeadSessions = new Set(
    Object.values(state.runs)
      .filter((r) => r.role === 'lead' && typeof r.sessionOrAgentId === 'string' && r.sessionOrAgentId !== '')
      .map((r) => r.sessionOrAgentId as string),
  )

  const buildMission = (goal: string, snap: V1RealSnapshot | null, status?: string): Mission | null => {
    if (snap && ('backend' in snap || 'nativeCacheVersion' in snap || 'nativeArchiveVersion' in snap)) {
      warnings.push('skipped native/unknown ownership in v1 history; never converted to legacy')
      return null
    }
    if (snap !== null && typeof snap.sessionId === 'string' && ownedLeadSessions.has(snap.sessionId)) {
      // No goal text: warnings reach the console (spec §21 allows IDs, timings,
      // and state transitions, never owner content).
      warnings.push('skipped a v1 record: the durable runtime already owns its lead session')
      return null
    }
    const missionId = mintId('mission')
    const createdAt = nowIso()
    // A faulted v1 mission (status 'fault', or a snapshot carrying faultKind)
    // imports as failed: presenting it as live would be dishonest about
    // work that stopped (spec §3 baseline defect, §22 honesty rules).
    const faulted = status === 'fault' || Boolean(snap?.faultKind)
    const phase = faulted ? 'failed' : snap ? phaseFromSnapshot(snap) : phaseFromStatus(status)
    const config = v1Config(snap)
    const mission: Mission = {
      schemaVersion: 2,
      missionId,
      entityId,
      productId: 'imported',
      originatingCommandId: 'v1-import',
      title: goal,
      goal,
      phase,
      control: 'running',
      freshness: 'stale',
      planRevision: 1,
      config,
      activeRunIds: [],
      decisionIds: [],
      lastAppliedSeq: 0,
      lastObservedAt: null,
      createdAt,
      updatedAt: createdAt,
    }
    if (snap) {
      v1Runs(snap, missionId, runs)
      mission.activeRunIds = Object.values(runs)
        .filter((r) => r.missionId === missionId)
        .map((r) => r.runId)
    }
    if (config.policyRevision === V1_RECOVERY_REQUIRED) {
      warnings.push(`mission ${missionId} has no recoverable repository; held for recovery choice`)
    }
    if (snap?.decisionPending) {
      warnings.push(`mission ${missionId} had a pending v1 question; it is re-asked on reconciliation`)
    }
    missions.push(mission)
    seenGoals.add(goal)
    // The mission's last-known engine working state travels with it, so the
    // owning actor can restore the engine mid-mission (spec §22 "import
    // current snapshots as last-known state").
    engineSnapshots[missionId] = snap
    events.push(
      draftEvent(
        'mission_migrated_from_v1',
        {
          goal,
          v1Phase: snap?.phase ?? status ?? null,
          v1SessionId: snap?.sessionId ?? null,
          configRecoveryRequired: config.policyRevision === V1_RECOVERY_REQUIRED,
        },
        { entityId, missionId },
      ),
    )
    return mission
  }

  // 1. Project vault entries: each surviving entry is its own mission with
  //    a distinct stable ID (v1's goal keys could collide; v2 IDs cannot).
  for (const p of projects) {
    if (!p || typeof p.goal !== 'string' || p.goal.trim() === '') {
      warnings.push('skipped an unreadable v1 project entry')
      continue
    }
    const snap = p.snapshot && p.snapshot.real === true ? p.snapshot : null
    buildMission(p.goal.trim(), snap, p.status)
  }

  // 2. The active engine snapshot: the same mission as its vault copy when
  //    the goal matches (one identity, one record); its own mission when it
  //    never reached the vault.
  if (active) {
    if (active.phase === 'attach') {
      warnings.push('v1 was watching an external cloud build; a watch is not a mission and was not imported')
    } else if (typeof active.goal === 'string' && active.goal.trim() !== '') {
      const goal = active.goal.trim()
      if (!seenGoals.has(goal)) {
        buildMission(goal, active)
      } else {
        const existing = missions.find((m) => m.goal === goal)
        const alreadyHasThisLead =
          existing !== undefined &&
          Object.values(runs).some(
            (r) =>
              r.role === 'lead' &&
              r.missionId === existing.missionId &&
              r.sessionOrAgentId === active.sessionId,
          )
        // The vault copy and the live snapshot saved on separate debounces:
        // graft the live lead session reference whenever it is not already
        // captured, so reconciliation can still reach it (spec §22).
        if (existing && active.sessionId && !alreadyHasThisLead) {
          const runId = mintId('run')
          runs[runId] = {
            schemaVersion: 2,
            runId,
            missionId: existing.missionId,
            provider: 'factory',
            role: 'lead',
            accountId: null,
            sessionOrAgentId: active.sessionId,
            remoteRunId: null,
            branch: '',
            baseSha: '',
            currentSha: '',
            observedState: 'migrated-v1',
            lastObservedAt: null,
          }
          existing.activeRunIds.push(runId)
          // The live snapshot is fresher than the vault copy (they saved on
          // separate debounces); it wins as the engine working state.
          engineSnapshots[existing.missionId] = active
          // The mission id, never the goal: these warnings reach the console
          // and spec §21 allows IDs and state transitions, not owner content.
          warnings.push(
            `mission ${existing.missionId}: vault copy diverged from the live snapshot; preserved the live lead session`,
          )
        }
      }
    }
  }

  if (missions.length === 0) {
    // Nothing importable existed; still mark the migration done so it can
    // never run again, and record why.
    const result = await store.commit((s) => ({
      state: { ...s, migratedFromV1: true },
      events: [draftEvent('runtime_migration_completed', { missions: 0, warnings: warnings.length }, { entityId })],
    }))
    if (result.ok === false) return { migrated: false, missionCount: 0, runCount: 0, warnings, error: result.reason }
    return { migrated: true, missionCount: 0, runCount: 0, warnings }
  }

  events.push(
    draftEvent('runtime_migration_completed', { missions: missions.length, warnings: warnings.length }, { entityId }),
  )

  const result = await store.commit((s) => {
    if (s.migratedFromV1) return null // double-run guard inside the commit too
    return {
      state: {
        ...s,
        missions: [...s.missions, ...missions],
        runs: { ...s.runs, ...runs },
        engineSnapshots: { ...(s.engineSnapshots ?? {}), ...engineSnapshots },
        migratedFromV1: true,
      },
      events,
    }
  })
  if (result.ok === false) return { migrated: false, missionCount: 0, runCount: 0, warnings, error: result.reason }
  return { migrated: true, missionCount: missions.length, runCount: Object.keys(runs).length, warnings }
}
