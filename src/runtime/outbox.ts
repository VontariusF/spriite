/**
 * Durable dispatch outbox (spec §8/§13): every remote LAUNCH goes through
 * here. The rule the whole runtime rests on: persist the dispatch intent
 * first, then make the remote call, then commit the outcome. A crash can
 * therefore never leave a remote launch that durable state knows nothing
 * about, and recovery never blindly retries a launch it cannot verify.
 *
 * Per attempt the lifecycle is:
 *
 *   prepared -> sending -> confirmed | rejected | unknown
 *
 *  - `prepared`: intent durably recorded, call not started. A crash here is
 *    safe — recovery marks the attempt rejected (retryable, no launch).
 *  - `sending`: the call is in flight. A crash here is UNKNOWN — the launch
 *    may have landed, and neither Factory nor Cursor offers an idempotency
 *    key (§27 capability gate). A retry is BLOCKED with DispatchUnknownError;
 *    the mission surfaces the condition instead of double-launching.
 *  - `confirmed`: the provider answered; remoteIds recorded. Retries never
 *    re-call the provider for a launch the record already holds (below).
 *  - `rejected`: the provider definitely answered no, or the client was
 *    definitively offline — a fresh attempt is safe.
 *
 * Reuse rules (the part that makes crash recovery not duplicate work):
 *  - Session-like launches (factory.session, cursor.agent) reuse by CLAIM:
 *    a confirmed record whose remote id the engine's live snapshot does not
 *    know about is handed back instead of creating a second session. This
 *    closes the crash window between the confirm commit and the engine's
 *    (debounced) snapshot save: the re-spawned job re-adopts its session
 *    (§25.28 "reconcile the same run without launching a duplicate").
 *  - Request-addressed launches (cursor.run, github.repo) reuse by exact
 *    request hash: an identical re-send returns the recorded result.
 *  - Any unresolved attempt (sending/unknown) blocks further launches of
 *    that kind for the mission until reconciled — the engine spawns jobs
 *    sequentially, so one unknown attempt is always the head of the queue.
 *    A `github.repo` attempt is reconciled by NAME instead of staying blocked
 *    forever: the repository either exists (the create landed; adopt it) or
 *    it does not (the create never landed; retry is safe). Without that, one
 *    timeout during a "New repo" start was a permanent dead end.
 *
 * The outbox wraps the engine's clients seam, so existing engine paths
 * (spawn, fix, integration, PR, retry) become durable without engine
 * surgery. Steering `postMessage` traffic and `interrupt` calls stay
 * direct: messages are re-sendable, and cancellation is a fire-and-forget
 * request whose honest handling lives in the mission actor.
 */
import { mintId, nowIso } from '../domain/ids'
import type { DispatchRecord, ProviderKind, SpriiteState } from '../domain/types'
import { sha256Hex, type CommitResult, type Mutation } from '../state/mission-store'
import type { RealClients } from '../factory/real'

const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000

/**
 * The launch kinds the outbox guards. The lead conversation ('factory.session')
 * and Factory-mode worker sessions ('factory.worker_session') are separate
 * kinds on purpose: the runtime's capacity gate (spec §14) exempts the lead
 * but must hold worker spawns, and both go through the same clients call.
 */
export type LaunchKind = 'factory.session' | 'factory.worker_session' | 'cursor.agent' | 'cursor.run' | 'github.repo'

const SESSION_LIKE: readonly LaunchKind[] = ['factory.session', 'factory.worker_session', 'cursor.agent']

/** Thrown when a launch cannot be retried because its outcome is unknown. */
export class DispatchUnknownError extends Error {
  readonly actionId: string
  readonly requestKey: string
  constructor(actionId: string, requestKey: string, cause?: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : ''
    super(`launch outcome unknown (action ${actionId}); reconcile before retrying${detail}`)
    this.name = 'DispatchUnknownError'
    this.actionId = actionId
    this.requestKey = requestKey
  }
}

/**
 * Thrown when the dispatch intent could not be made durable, so the remote
 * launch was never attempted. Nothing is recorded as in flight and nothing
 * goes out: calling the provider after an unacknowledged write is exactly the
 * blind duplicate this outbox exists to prevent (spec §8, §24).
 */
export class DispatchNotDurableError extends Error {
  readonly kind = 'storage'
  constructor(reason: string) {
    super(`dispatch intent could not be recorded (${reason}); no launch was attempted`)
    this.name = 'DispatchNotDurableError'
  }
}

export interface OutboxDeps {
  /** The supervisor's store commit; all records move through it. */
  commit(mutation: Mutation<SpriiteState>): Promise<CommitResult>
  /** The current durable state (read-only), for pre-flight reconciliation. */
  state(): SpriiteState
  /** Boot epoch number; recovered in-flight records carry the epoch that died. */
  epoch: number
  /** Transport timeout after which a launch becomes unknown. */
  launchTimeoutMs?: number
}

interface PrepareOutcome {
  actionId: string
  /** The dispatch's request key (prefix + attempt index). */
  requestKey: string
  /** True when a confirmed dispatch was reused (no provider call made). */
  reused: boolean
  remoteIds: string[]
}

/** Extension carried in the same durable envelope; never reconstructed from Setup. */
interface RepositoryRequest {
  account: string | null
  name: string
  isPrivate: boolean
}
type RepositoryDispatch = DispatchRecord & { repositoryRequest?: RepositoryRequest }

export class Outbox {
  private readonly commit: (mutation: Mutation<SpriiteState>) => Promise<CommitResult>
  private readonly stateOf: () => SpriiteState
  private readonly epoch: number
  private readonly launchTimeoutMs: number

  constructor(deps: OutboxDeps) {
    this.commit = deps.commit
    this.stateOf = deps.state
    this.epoch = deps.epoch
    this.launchTimeoutMs = deps.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS
  }

  private static keyPrefix(missionId: string, kind: LaunchKind): string {
    return `m:${missionId}:${kind}:`
  }

  private static attemptsFor(state: SpriiteState, missionId: string, kind: LaunchKind): DispatchRecord[] {
    const prefix = Outbox.keyPrefix(missionId, kind)
    return state.outbox
      .filter((d) => d.requestKey.startsWith(prefix))
      .sort((a, b) => a.attempts - b.attempts)
  }

  /**
   * Persist the intent to launch (state 'prepared'), or resolve an existing
   * attempt without re-calling the provider:
   *  - claim-based reuse for session-like kinds (unclaimed confirmed records),
   *  - hash-based reuse for request-addressed kinds,
   *  - a block (throw) whenever an attempt of this kind is unresolved.
   * `claimed` accumulates remote ids this wrap instance has handed out; the
   * engine's live snapshot contributes the rest of the claim set.
   */
  async prepare(
    kind: LaunchKind,
    provider: ProviderKind,
    missionId: string,
    requestHash: string,
    claimed: Set<string>,
    repositoryRequest?: RepositoryRequest,
  ): Promise<PrepareOutcome | null> {
    let resolved: PrepareOutcome | null = null
    let created: DispatchRecord | null = null
    const res = await this.commit((state) => {
      const prior = Outbox.attemptsFor(state, missionId, kind)
      const last = prior[prior.length - 1]

      // Unresolved in-flight attempt: the launch may have landed.
      if (last !== undefined && (last.state === 'sending' || last.state === 'unknown')) {
        throw new DispatchUnknownError(last.actionId, last.requestKey)
      }

      // Session-like reuse: the oldest confirmed record the engine does not
      // know about (and this epoch has not already handed out).
      if (SESSION_LIKE.includes(kind)) {
        const unclaimed = prior.find((d) => d.state === 'confirmed' && (d.remoteIds[0] ?? '') !== '' && !claimed.has(d.remoteIds[0]))
        if (unclaimed !== undefined) {
          const id = unclaimed.remoteIds[0]
          claimed.add(id)
          resolved = {
            actionId: unclaimed.actionId,
            requestKey: unclaimed.requestKey,
            reused: true,
            remoteIds: [...unclaimed.remoteIds],
          }
          return null
        }
      } else if (last !== undefined && last.state === 'confirmed' && last.requestHash === requestHash) {
        // Request-addressed reuse: the same request re-sent.
        resolved = { actionId: last.actionId, requestKey: last.requestKey, reused: true, remoteIds: [...last.remoteIds] }
        return null
      }

      const requestKey = `${Outbox.keyPrefix(missionId, kind)}${prior.length}`
      const record: DispatchRecord = {
        schemaVersion: 2,
        actionId: mintId('act'),
        missionId,
        runtimeEpoch: this.epoch,
        provider,
        requestKey,
        requestHash,
        state: 'prepared',
        attempts: prior.length + 1,
        remoteIds: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
        ...(repositoryRequest ? { repositoryRequest: { ...repositoryRequest } } : {}),
      }
      created = record
      return {
        state: { ...state, outbox: [...state.outbox, record] },
        events: [],
      }
    })
    if (resolved !== null) return resolved
    if (res.ok === false) {
      console.warn(`[outbox] ${kind} intent not acknowledged: ${res.reason}`)
      return null
    }
    return created !== null
      ? { actionId: created.actionId, requestKey: created.requestKey, reused: false, remoteIds: [] }
      : null
  }

  /** The intent is now in flight. Crash here => unknown outcome. */
  async markSending(actionId: string): Promise<CommitResult> {
    return this.mutate(actionId, (d) => ({ ...d, state: 'sending', updatedAt: nowIso() }))
  }

  /**
   * Resolve an unresolved `github.repo` attempt before a new one is prepared,
   * by asking the provider whether the repository the create named exists.
   *
   *  - exists  -> the earlier attempt landed: confirm it with its URL, so the
   *               normal reuse path adopts that repository (never a second
   *               create, never a `-2` duplicate).
   *  - absent  -> not proof that a timed-out request cannot still complete;
   *               keep the exact attempt unknown.
   *  - lookup failed, or no lookup seam -> leave it unresolved (the mission
   *               keeps its honest block rather than risking a duplicate).
   */
  private async reconcileRepoCreate(
    missionId: string,
    clients: RealClients,
  ): Promise<{ url: string } | null> {
    const prior = Outbox.attemptsFor(this.stateOf(), missionId, 'github.repo')
    const last = prior[prior.length - 1]
    if (last === undefined || (last.state !== 'sending' && last.state !== 'unknown')) return null
    const request = (last as RepositoryDispatch).repositoryRequest
    // Older hashes cannot reveal which typed name or fallback suffix was
    // dispatched. Never substitute the name supplied by the current caller.
    if (!request || typeof request.name !== 'string' || !request.name ||
      typeof request.isPrivate !== 'boolean' ||
      (request.account !== null && typeof request.account !== 'string') || clients.findRepo === undefined) return null
    const name = request.name
    let found: { url: string } | null
    try {
      found = await clients.findRepo(name, request.account ?? undefined, request.isPrivate)
    } catch (e) {
      console.warn(`[outbox] repository create ${last.actionId} stays unresolved: lookup failed (${(e as Error).message})`)
      return null
    }
    if (found === null) {
      console.log(`[outbox] repository ${name} is not observed; the dispatched create remains unknown`)
      return null
    }
    console.log(`[outbox] repository ${name} already exists; adopting the earlier create`)
    await this.recordOutcome(() => this.confirm(last.actionId, [found.url]), last.actionId, 'confirm')
    return found
  }

  async confirm(actionId: string, remoteIds: string[]): Promise<CommitResult> {
    return this.mutate(actionId, (d) => ({ ...d, state: 'confirmed', remoteIds, updatedAt: nowIso() }))
  }

  async reject(actionId: string): Promise<CommitResult> {
    return this.mutate(actionId, (d) => ({ ...d, state: 'rejected', updatedAt: nowIso() }))
  }

  async markUnknown(actionId: string): Promise<CommitResult> {
    return this.mutate(actionId, (d) => ({ ...d, state: 'unknown', updatedAt: nowIso() }))
  }

  /**
   * Apply one record transition durably, returning the commit result: a
   * caller must be able to tell an acknowledged write from an attempted one
   * (spec §8: "Do not report accepted on a best-effort debounced write").
   */
  private async mutate(
    actionId: string,
    apply: (d: DispatchRecord) => DispatchRecord,
  ): Promise<CommitResult> {
    return this.commit((state) => {
      const idx = state.outbox.findIndex((d) => d.actionId === actionId)
      if (idx === -1) return null
      const next = [...state.outbox]
      next[idx] = apply(next[idx])
      return { state: { ...state, outbox: next }, events: [] }
    })
  }

  /**
   * Recovery scan (spec §8 recovery order step 3), run at boot inside one
   * commit:
   *  - 'prepared' -> 'rejected': the call never started; retry is safe.
   *  - 'sending'  -> 'unknown': the launch may have landed; retry blocked
   *    until reconciled, and surfaced as a warning.
   */
  async recoverInFlight(): Promise<string[]> {
    const warnings: string[] = []
    await this.commit((state) => {
      const touched = state.outbox.filter((d) => d.state === 'prepared' || d.state === 'sending')
      if (touched.length === 0) return null
      const next = state.outbox.map((d) => {
        if (d.state === 'prepared') return { ...d, state: 'rejected' as const, updatedAt: nowIso() }
        if (d.state === 'sending') return { ...d, state: 'unknown' as const, updatedAt: nowIso() }
        return d
      })
      for (const d of touched) {
        if (d.state === 'sending') {
          warnings.push(
            `launch outcome unknown for mission ${d.missionId} (${d.provider} ${d.requestKey}); retry blocked until reconciled`,
          )
        }
      }
      return { state: { ...state, outbox: next }, events: [] }
    })
    return warnings
  }

  /**
   * Wrap a clients seam so the engine's launch calls become durable
   * dispatches. `knownRemoteIds` reports the remote ids the engine's live
   * state already owns (from its snapshot) — those count as claimed.
   * `beforeLaunch` gates before preparation and again synchronously after
   * durable writes, immediately before dispatch (pause, cancel, terminal
   * control). A final refusal rejects the known-unlaunched attempt rather
   * than claiming an uncertain provider outcome.
   */
  wrapClients(
    clients: RealClients,
    missionId: string,
    knownRemoteIds: () => Set<string>,
    beforeLaunch?: (kind: LaunchKind | 'factory.worker_execution') => void,
  ): RealClients {
    const outbox = this
    const claimed = new Set<string>()
    /**
     * The claim ledger for this mission: remote ids already handed back TO
     * THIS wrap (accumulated across launches) plus the ids the engine's live
     * snapshot already owns. The returned set is the ledger itself, so a
     * reuse that claims an id is remembered for the next launch.
     */
    const claimedWithSnapshot = () => {
      for (const id of knownRemoteIds()) claimed.add(id)
      return claimed
    }
    return {
      ...clients,
      async postMessage(sessionId, text, computerId) {
        // The coordinator is capacity-exempt, not control/policy/terminal
        // exempt. This synchronous final gate covers every conversation turn.
        beforeLaunch?.('factory.session')
        return clients.postMessage(sessionId, text, computerId)
      },
      async postWorkerExecution(sessionId, text, stage, computerId) {
        // This is execution, not ordinary conversation or a result refresh.
        // No await separates the final authority check from the provider call.
        // It keeps the existing message retry semantics, not launch outbox
        // semantics: a refusal occurs before dispatch and creates no attempt.
        beforeLaunch?.('factory.worker_execution')
        if (clients.postWorkerExecution) {
          return clients.postWorkerExecution(sessionId, text, stage, computerId)
        }
        return clients.postMessage(sessionId, text, computerId)
      },
      async createSession(opts) {
        beforeLaunch?.('factory.session')
        return outbox.launch(
          'factory.session',
          'factory',
          missionId,
          JSON.stringify(opts ?? {}),
          () => clients.createSession(opts),
          (created) => [created.sessionId],
          (remoteIds) => ({ sessionId: remoteIds[0] ?? '' }),
          claimedWithSnapshot(),
          beforeLaunch,
        )
      },
      async createWorkerSession(opts) {
        // Factory-mode worker sessions are a distinct LAUNCH kind even though
        // the wire call is the same: the runtime's capacity gate must hold
        // worker spawns (spec §14) while the lead conversation stays exempt.
        beforeLaunch?.('factory.worker_session')
        return outbox.launch(
          'factory.worker_session',
          'factory',
          missionId,
          JSON.stringify(opts ?? {}),
          () => (clients.createWorkerSession ?? clients.createSession).call(clients, opts),
          (created) => [created.sessionId],
          (remoteIds) => ({ sessionId: remoteIds[0] ?? '' }),
          claimedWithSnapshot(),
          beforeLaunch,
        )
      },
      async cursorAgent(promptText, repoUrl) {
        beforeLaunch?.('cursor.agent')
        return outbox.launch(
          'cursor.agent',
          'cursor',
          missionId,
          JSON.stringify({ promptText, repoUrl }),
          () => clients.cursorAgent(promptText, repoUrl),
          (created) => (created.runId ? [created.agentId, created.runId] : [created.agentId]),
          (remoteIds) => ({ agentId: remoteIds[0] ?? '', runId: remoteIds[1] ?? null }),
          claimedWithSnapshot(),
          beforeLaunch,
        )
      },
      async cursorRun(agentId, promptText) {
        beforeLaunch?.('cursor.run')
        return outbox.launch(
          'cursor.run',
          'cursor',
          missionId,
          JSON.stringify({ agentId, promptText }),
          () => clients.cursorRun(agentId, promptText),
          (run) => [run.runId],
          (remoteIds) => ({ runId: remoteIds[0] ?? '' }),
          claimedWithSnapshot(),
          beforeLaunch,
        )
      },
      async createRepo(name, isPrivate) {
        beforeLaunch?.('github.repo')
        const last = Outbox.attemptsFor(outbox.stateOf(), missionId, 'github.repo').at(-1)
        if (last?.state === 'confirmed' && last.remoteIds[0]) return { url: last.remoteIds[0] }
        // A repository create is request-addressed by NAME, so an attempt
        // whose outcome was never observed can be reconciled instead of
        // blocking the mission forever: if the repository now exists, that
        // attempt landed and is adopted; if it does not, the attempt never
        // landed and is safe to retry. Without this, one timeout or a process
        // death during the create left "New repo" permanently dead — every
        // Retry re-faulted on the same unresolved dispatch.
        const reconciled = await outbox.reconcileRepoCreate(missionId, clients)
        if (reconciled) return reconciled
        const account = clients.repoAccount ? await clients.repoAccount() : null
        return outbox.launch(
          'github.repo',
          'x',
          missionId,
          JSON.stringify({ name, isPrivate }),
          () => clients.createRepo(name, isPrivate),
          (created) => [created.url],
          (remoteIds) => ({ url: remoteIds[0] ?? '' }),
          claimedWithSnapshot(),
          beforeLaunch,
          { account, name, isPrivate },
        )
      },
    }
  }

  /**
   * One durable launch: prepare (reuse / block) -> mark sending -> call with
   * a transport timeout -> confirm | reject | mark unknown. Errors rethrow
   * so the engine's existing fault + Retry flow keeps working; only the
   * outcome bookkeeping is added.
   */
  private async launch<R>(
    kind: LaunchKind,
    provider: ProviderKind,
    missionId: string,
    request: string,
    call: () => Promise<R>,
    toIds: (result: R) => string[],
    fromIds: (remoteIds: string[]) => R,
    claimed: Set<string>,
    beforeLaunch?: (kind: LaunchKind) => void,
    repositoryRequest?: RepositoryRequest,
  ): Promise<R> {
    const requestHash = await sha256Hex(request)
    const prepared = await this.prepare(kind, provider, missionId, requestHash, claimed, repositoryRequest)
    if (prepared === null) throw new DispatchNotDurableError('intent commit was not acknowledged')
    if (prepared.reused) {
      console.log(`[outbox] reusing confirmed dispatch ${prepared.actionId} (${kind})`)
      return fromIds(prepared.remoteIds)
    }
    const { actionId } = prepared
    // The in-flight intent must be DURABLE before the call goes out: if this
    // write is not acknowledged, the launch is not attempted at all (an
    // unrecorded launch is the one recovery cannot reason about).
    let timer: ReturnType<typeof setTimeout> | undefined
    let providerCalled = false
    try {
      const marked = await this.markSending(actionId)
      if (marked.ok === false) throw new DispatchNotDurableError(marked.reason)
      // Authority can change during hashing or either durable write. This
      // callback is synchronous: no await may separate it from native dispatch.
      beforeLaunch?.(kind)
      providerCalled = true
      const result = await Promise.race([
        call(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('launch transport timeout')), this.launchTimeoutMs)
        }),
      ])
      // The launch already happened, so the result is returned either way; an
      // unacknowledged confirm leaves the record 'sending' and the next boot
      // recovers it as unknown (conservative, never as "safe to retry").
      await this.recordOutcome(() => this.confirm(actionId, toIds(result)), actionId, 'confirm')
      return result
    } catch (e) {
      if (!providerCalled) {
        // The local sending marker is not evidence of a remote call. A failed
        // final gate (or sending write) is known-unlaunched and safe to retry.
        await this.recordOutcome(() => this.reject(actionId), actionId, 'reject unlaunched')
        throw e
      }
      if (e instanceof DispatchUnknownError) throw e
      if (e instanceof DispatchNotDurableError) throw e
      if (isDefiniteRejection(e)) {
        await this.recordOutcome(() => this.reject(actionId), actionId, 'reject')
      } else {
        // Transport timeout or unclassified failure: the launch may have
        // landed upstream. Unknown, not rejected (spec §8). The rethrow is
        // the DispatchUnknownError, NOT the original error, because the
        // engine classifies kind 'network' failures as retryable blips —
        // a launch whose outcome is unknown must surface as a fault, not
        // vanish into the next poll.
        await this.recordOutcome(() => this.markUnknown(actionId), actionId, 'unknown')
        throw new DispatchUnknownError(actionId, prepared.requestKey, e)
      }
      throw e
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Record a launch outcome without pretending it is durable when it is not.
   * After a provider call, an unacknowledged outcome may recover as UNKNOWN.
   * A rejected final gate made no provider call: failed cleanup must not
   * claim otherwise, or pretend its rejection is durable.
   */
  private async recordOutcome(
    write: () => Promise<CommitResult>,
    actionId: string,
    outcome: string,
  ): Promise<void> {
    const result = await write()
    if (result.ok === false) {
      const recovery = outcome === 'reject unlaunched'
        ? 'no provider call was made; cleanup is not durable'
        : 'recovery will treat it as unknown'
      console.warn(
        `[outbox] ${outcome} for ${actionId} was not acknowledged (${result.reason}); ${recovery}`,
      )
    }
  }
}

/**
 * Definite rejections: the provider (or the local client) answered, so the
 * launch never happened and a fresh attempt is safe. Anything else — a lost
 * response, a 5xx the backend may have acted on, an unclassified error — is
 * UNKNOWN, because the request may have landed.
 *
 * The classification follows what the provider adapters actually throw
 * (src/factory/fapi.ts, src/factory/cursor.ts):
 *  - auth/billing/quota/forbidden/permission: an explicit refusal.
 *  - exists: the resource already exists, nothing was created.
 *  - offline: Factory answered 503 that the computer daemon is unreachable.
 *  - service with an `HTTP 4xx` message: the request was rejected outright.
 *  - network (no response reached us), service with `HTTP 5xx` or a
 *    malformed-body message ("returned no session id"), and anything
 *    unclassified: unknown.
 */
function isDefiniteRejection(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  if (!('kind' in e)) return false
  const kind = String((e as { kind: unknown }).kind)
  if (['auth', 'billing', 'quota', 'forbidden', 'permission', 'exists', 'offline'].includes(kind)) {
    return true
  }
  // Only 4xx statuses that guarantee nothing was created are definite; a
  // 408/409/425/429-style answer may follow a server-side create.
  if (kind === 'service') return /HTTP (?:400|401|403|404|405|410|411|413|414|415|422)\b/.test(e.message)
  return false
}
