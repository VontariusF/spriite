/**
 * Adoption of host-launched native jobs. The Factory host's X reader launches
 * Missions 2.0 through broker admission while the phone may be closed; the
 * phone learns of them only from `GET /v1/native/jobs` and then observes each
 * one through its own route, like any job it prepared itself. Nothing here
 * prepares, commands or approves: adoption is a read and a local record.
 */
import type { NativeHostClient, NativeLaunchProfile, NativeSnapshot } from './protocol'
import { canonicalBrokerUrl } from './decode'

/** The host reader's deterministic mission ids (broker/x-launch.mjs default mint). */
export const HOST_MISSION_ID = /^x-mission-[0-9a-f]{32}$/
/** Lists are cheap, but one a minute is plenty beside the 60 s X read. */
export const ADOPT_INTERVAL_MS = 30000
/** Bounded reads per pass, so a long backlog never stalls the app tick. */
const ADOPT_MAX_READS = 8

export interface HostJobAdopterDeps {
  profile: () => NativeLaunchProfile
  credential: (brokerUrl: string) => string
  client: (brokerUrl: string) => Pick<NativeHostClient, 'listJobs' | 'observe'>
  /** True when the runtime already holds a mission with this id. */
  known: (missionId: string) => boolean
  adopt: (snapshot: NativeSnapshot) => Promise<{ receipt: 'saved' | 'duplicate' | 'rejected'; missionId?: string }>
  enabled: () => boolean
  now?: () => number
  intervalMs?: number
}

export interface AdoptPass {
  adopted: string[]
  /** Listed host jobs left for a later pass (unbound yet, unreadable, or refused). */
  deferred: string[]
}

export class HostJobAdopter {
  private readonly deps: HostJobAdopterDeps
  private readonly now: () => number
  private nextAt = 0
  private running: Promise<AdoptPass> | null = null

  constructor(deps: HostJobAdopterDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  /** Runs a pass when one is due; never throws and never overlaps itself. */
  tick(): Promise<AdoptPass | null> {
    if (this.running || this.now() < this.nextAt) return Promise.resolve(null)
    this.nextAt = this.now() + (this.deps.intervalMs ?? ADOPT_INTERVAL_MS)
    return this.pass()
  }

  /** One pass now (also the test seam). */
  pass(): Promise<AdoptPass> {
    if (this.running) return this.running
    const run = this.adoptOnce().catch((): AdoptPass => ({ adopted: [], deferred: [] }))
    this.running = run
    return run.finally(() => { this.running = null })
  }

  private async adoptOnce(): Promise<AdoptPass> {
    const out: AdoptPass = { adopted: [], deferred: [] }
    const profile = this.deps.profile()
    const brokerUrl = canonicalBrokerUrl(profile.brokerUrl)
    if (!this.deps.enabled() || !brokerUrl || !profile.ownerId || !this.deps.credential(brokerUrl)) return out
    const identity = JSON.stringify(profile)
    const client = this.deps.client(brokerUrl)
    const jobs = await client.listJobs(profile.ownerId)
    // Every bound host job is shown, held ones included: a launch whose
    // receipt was lost is held by the broker yet may be running on the Factory host.
    // Only a job the broker never bound has no session to observe (an older
    // broker without `bound` is read, and its binding checked below).
    const candidates = jobs.filter(j => HOST_MISSION_ID.test(j.missionId) && j.bound !== false &&
      !this.deps.known(j.missionId))
    for (const job of candidates.slice(0, ADOPT_MAX_READS)) {
      let snapshot: NativeSnapshot
      try { snapshot = await client.observe(job.missionId, profile.ownerId) } catch { out.deferred.push(job.missionId); continue }
      // The profile may change while a read is in the air: a job is only
      // adopted under the exact profile (and owner) it was listed for.
      if (JSON.stringify(this.deps.profile()) !== identity || snapshot.missionId !== job.missionId ||
        snapshot.ownerId !== profile.ownerId || !snapshot.binding || this.deps.known(job.missionId)) {
        out.deferred.push(job.missionId)
        continue
      }
      const receipt = await this.deps.adopt(snapshot)
      if (receipt.receipt === 'saved') out.adopted.push(job.missionId)
      else if (receipt.receipt !== 'duplicate') out.deferred.push(job.missionId)
    }
    out.deferred.push(...candidates.slice(ADOPT_MAX_READS).map(j => j.missionId))
    return out
  }
}
