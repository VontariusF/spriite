/**
 * Phone wiring around owner-only intake. One queue owns credential changes,
 * checks and imports, so an in-flight check cannot change accounts halfway.
 * A persisted credential generation must match the verified binding.
 *
 * Token renewal is the one place the phone talks to X about a credential:
 * a 401 on a read earns exactly one renewal (inside the transport), and the
 * rotated pair is written back in place, so the verified generation — and the
 * authority it carries — survives the rotation.
 */
import type { KeyVault } from '../voice/keys'
import type { Supervisor } from '../runtime/supervisor'
import type { XFollowup, XIntakeReceipt } from '../domain/types'
import type { GitHubIntakeReader } from '../context/gather'
import { XIntake, type BindResult, type BindFailure, type IngestResult, type XIntakeHealth, type XRefreshState, type PollResult } from './x'
import {
  createXTransport,
  parseXTokenPaste,
  refreshXToken,
  XTransportError,
  type XRefreshHook,
  type XTokenPair,
  type XTransport,
} from './x-transport'

/**
 * Check errors that, with a refresh token stored, can only follow a renewal
 * that did not recover the credential (every 401 earns one renewal first).
 * These are the transport's own fixed messages, never provider text.
 */
const RENEWAL_FAILURES = new Set([
  'X rejected the token',
  'X rotated the token but this phone could not save it',
  'No X app client id is saved in Setup',
])

const X_STEADY_MS = 60_000
const X_BURST_MS = 15_000
const X_BURST_WINDOW_MS = 3 * 60_000
const X_BACKOFF_MS = 5 * 60_000

export interface XConnectionDeps {
  keys: KeyVault
  supervisor: Supervisor
  enabled: () => boolean
  foreground: () => boolean
  repository: () => string
  /** The X app client id saved in Setup; empty means renewal fails closed. */
  clientId?: () => string
  /** Reads through the owner's own GitHub token; null while none is saved. */
  github?: () => GitHubIntakeReader | null
  /** Test seam: builds the read client for a token, renewal hook included. */
  transport?: (token: string, refresh: XRefreshHook) => XTransport
  now?: () => number
}

/**
 * Store a pasted credential in the vault: the save half of connect(). The
 * vault is a plain storage write, so it needs neither the durable runtime nor
 * a transport — which is what lets the setup panel keep a paste even on a
 * launch that built no X connection to verify it. connect() stores before it
 * verifies for the same reason: a relay that is down costs the owner a
 * re-verify, never another copy of the token JSON from X.
 *
 * A paste is the whole token JSON X issued (so the refresh token is stored
 * with the access token) or a bare access token, and a paste that claims to
 * be the JSON but does not parse is refused before anything is stored, so it
 * can neither save garbage nor destroy a saved credential. A refresh-only
 * paste is half a credential: it is minted through the same OAuth exchange
 * connect() uses, and with no X app client id that fails closed before any
 * request. X rotates the pair on that exchange, so a mint whose pair could
 * not be persisted is rotation_lost: the pasted refresh token is spent and
 * only a fresh token JSON from X can work.
 */
export async function storeXPaste(
  keys: KeyVault,
  clientId: string,
  typed: string,
  /**
   * The exchange that mints a refresh-only paste into a pair. connect() hands
   * its own so a failed renewal still lands in the health state it reports;
   * every other caller gets the same OAuth route it uses.
   */
  renew: (refreshToken: string) => Promise<{ pair: XTokenPair } | { kind: XTransportError['kind'] }> =
    // The same contract connect()'s own renewal has: a failure is returned as
    // its kind (never the provider's message, which can echo credential
    // material), so the panel reads a reason and never a thrown error.
    async (refreshToken) => {
      try {
        return { pair: await refreshXToken({ refreshToken, clientId: clientId.trim() }) }
      } catch (err) {
        return { kind: err instanceof XTransportError ? err.kind : 'service' }
      }
    },
): Promise<{ ok: true } | BindFailure> {
  const text = typed.trim()
  if (text === '') return { ok: false, reason: 'no_credential' }
  const parsed = parseXTokenPaste(text)
  if (!parsed.ok) return { ok: false, reason: 'bad_paste' }
  if (parsed.pair.accessToken === '') {
    // X always issues an access token beside a refresh token, so this paste
    // is half a credential: mint the pair before storing it. With no client
    // id there is no app to renew against — fail closed before any request,
    // with the missing configuration as the reason.
    if (!clientId.trim()) return { ok: false, reason: 'no_client_id' }
    const minted = await renew(parsed.pair.refreshToken)
    if ('kind' in minted) return { ok: false, reason: `x_${minted.kind}` }
    if (!(await keys.setX(minted.pair.accessToken, minted.pair.refreshToken))) {
      // X rotated the pair during the mint: the pasted refresh token is spent
      // and the minted one exists only in this call's memory. A plain storage
      // line ("try again") would hand the owner a dead token to retry with, so
      // this is its own reason — the only way forward is a fresh token JSON
      // from X.
      return { ok: false, reason: 'rotation_lost' }
    }
    return { ok: true }
  }
  // Replacing both fields at once is also how a bare access token stops a
  // stale refresh token from an earlier credential surviving.
  return (await keys.setX(parsed.pair.accessToken, parsed.pair.refreshToken))
    ? { ok: true }
    : { ok: false, reason: 'storage' }}

export class XConnection {
  private readonly deps: XConnectionDeps
  private readonly intake: XIntake
  /** The renewal wiring handed to every transport this connection builds. */
  private readonly refreshHook: XRefreshHook
  private chain: Promise<unknown> = Promise.resolve()
  private busy = false
  private followupView: readonly XFollowup[] | undefined
  private nextCheck = 0
  /** Until this time, checks run on the short burst cadence. */
  private burstUntil = 0
  /** The last renewal's outcome; the vault, not this field, holds the truth
   * about whether a refresh token is stored. In memory only: a failed
   * renewal also lands in the durable last-error a check records. 'pasted'
   * means a new pair was saved this launch and has not been renewed yet, so
   * an earlier credential's durable error says nothing about it. */
  private lastRefresh: 'ok' | 'failed' | 'pasted' | null = null
  private readonly listeners = new Set<() => void>()

  constructor(deps: XConnectionDeps) {
    this.deps = deps
    this.refreshHook = {
      token: () => this.deps.keys.xRefresh,
      persist: (pair: XTokenPair) => this.deps.keys.setXRotation(pair.accessToken, pair.refreshToken),
      outcome: (result) => { this.lastRefresh = result },
    }
    deps.supervisor.setXFollowupGate(() => this.allowed())
    this.intake = new XIntake({
      store: deps.supervisor.missionStore,
      runtime: {
        get missions() { return deps.supervisor.missions },
        submitCommand: (input) => this.allowed()
          ? deps.supervisor.submitCommand(input)
          : Promise.resolve({ commandId: input.commandId ?? '', receipt: 'rejected', reason: 'X intake is off' }),
        submitXFollowup: (r, owner) => this.allowed() ? deps.supervisor.submitXFollowup(r, owner)
          : Promise.resolve({ status: 'failed' }),
        resolveXFollowup: (key, action, attempt) => (action === 'dismiss' || this.allowed())
          ? deps.supervisor.resolveXFollowup(key, action, attempt) : Promise.resolve(false),
        nativeExecution: () => deps.supervisor.nativeExecution(),
        nativeCreatesPrivateRepositories: () => deps.supervisor.nativeCreatesPrivateRepositories?.() ?? false,
        nativeRepositoryAccount: () => deps.supervisor.nativeRepositoryAccount?.() ?? null,
      },
      transport: () => this.transport(),
      github: () => this.deps.github?.() ?? null,
      now: deps.now,
    })
  }

  /** The read client for the stored credential, with renewal armed only when
   * a refresh token is actually stored. */
  private transport(): XTransport | null {
    const token = this.deps.keys.x
    if (!token) return null
    const make = this.deps.transport ??
      ((t: string, refresh: XRefreshHook) =>
        createXTransport({ token: t, refresh, clientId: this.deps.clientId?.() }))
    return make(token, this.refreshHook)
  }

  /**
   * One renewal through the same OAuth route the transport uses. Returns the
   * minted pair, or the failure's kind (never the provider's message: it can
   * echo credential material). The kind keeps a renewal that never reached X
   * (the relay is unreachable) from being reported as X rejecting the token.
   */
  private async renew(refreshToken: string): Promise<{ pair: XTokenPair } | { kind: XTransportError['kind'] }> {
    try {
      const pair = await refreshXToken({ refreshToken, clientId: this.deps.clientId?.() })
      this.lastRefresh = 'ok'
      return { pair }
    } catch (err) {
      this.lastRefresh = 'failed'
      return { kind: err instanceof XTransportError ? err.kind : 'service' }
    }
  }

  private allowed(): boolean {
    const { keys } = this.deps
    const binding = this.intake.state.binding
    return this.deps.enabled() && Boolean(keys.x && keys.xCredentialRef) &&
      binding?.credentialRef === keys.xCredentialRef &&
      binding.enabled && !binding.protectedOwner
  }

  get active(): boolean { return this.allowed() }

  health(): XIntakeHealth {
    const h = this.intake.health()
    const owner = this.intake.state.binding?.ownerXUserId
    // Historical receipts from another owner remain durable but not actionable.
    h.needsOwner = h.needsOwner.filter((r) => r.dedupeKey.startsWith(`x:${owner}:`))
    h.recent = h.recent.filter((r) => r.dedupeKey.startsWith(`x:${owner}:`))
    const verified = Boolean(this.deps.keys.x) &&
      this.intake.state.binding?.credentialRef === this.deps.keys.xCredentialRef
    // Renewal is a fact about what the vault holds plus the last attempt,
    // not about the binding: a pair saved before a failed verification (the
    // relay was down, X refused the token) still exists, so it reads as
    // 'armed' — saved, renewal waiting on verification — never as "no
    // refresh token". 'on' still requires the verified generation, and a
    // failed renewal is 'failed' on either side of verification.
    // lastRefresh is in memory only; after a relaunch the durable last-check
    // error is the remaining evidence that renewal did not recover the token.
    const renewalFailed = this.lastRefresh === 'failed' ||
      (this.lastRefresh === null && verified && h.lastError !== null && RENEWAL_FAILURES.has(h.lastError))
    const refresh: XRefreshState = !this.deps.keys.xRefresh
      ? 'off'
      : renewalFailed
        ? 'failed'
        : verified
          ? 'on'
          : 'armed'
    if (!verified) {
      return {
        ...h, refresh, state: 'unbound',
        // A token that was saved but never verified is a distinct state, not
        // "nothing here": the owner must see that the save held.
        summary: this.deps.keys.x
          ? 'A token is saved but not verified yet. Save and verify to check it against X.'
          : 'Connect and verify a current X user token.',
        needsOwner: [], recent: [],
      }
    }
    if (!this.deps.enabled() && h.state !== 'protected_unsupported') {
      return { ...h, refresh, state: 'disabled', summary: 'X intake is off. Enable X requests after the live checks.' }
    }
    return { ...h, refresh }
  }

  /**
   * Accepted requests, newest first (each is already a durable mission).
   * Owner-scoped like health(): a receipt from another owner is history, not
   * something to announce.
   */
  submitted(): XIntakeReceipt[] {
    return this.ownedSubmitted().filter((r) => !this.isNativeHeld(r))
  }

  /**
   * Accepted requests saved as held native intents, newest first. Nothing
   * started for these: an X post never approves native scope.
   */
  nativeHeld(): XIntakeReceipt[] {
    return this.ownedSubmitted().filter((r) => this.isNativeHeld(r))
  }

  private ownedSubmitted(): XIntakeReceipt[] {
    const owner = this.intake.state.binding?.ownerXUserId
    return this.intake.state.receipts
      .filter((r) => r.status === 'submitted' && r.dedupeKey.startsWith(`x:${owner}:`))
      .slice(-10)
      .reverse()
  }

  private isNativeHeld(r: XIntakeReceipt): boolean {
    const m = r.missionId === undefined ? undefined : this.deps.supervisor.missions.find((x) => x.missionId === r.missionId)
    return m?.config.executionBackend === 'factory_native'
  }

  /**
   * Replies that steered a live mission (status 'extended'), newest first:
   * a held reply the owner confirmed later resolves as a steer on the
   * parent, with no card of its own — the board announces it once from
   * here, the same way submitted() feeds the started card.
   */
  extended(): XIntakeReceipt[] {
    const owner = this.intake.state.binding?.ownerXUserId
    return this.intake.state.receipts
      .filter((r) => r.status === 'extended' && r.dedupeKey.startsWith(`x:${owner}:`))
      .slice(-10)
      .reverse()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  refresh(): void { for (const listener of this.listeners) listener() }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      this.busy = true
      try { return await fn() }
      finally { this.busy = false; this.refresh() }
    })
    this.chain = run.catch(() => undefined)
    return run
  }

  /**
   * Save and verify. The paste may be the whole token JSON X issued (so the
   * refresh token is stored with the access token) or a bare access token. An
   * empty paste re-verifies what is already saved. A paste that claims to be
   * the token JSON but does not parse — clipped by the phone keyboard, quotes
   * rewritten, half the copy — is refused before anything is stored, so it
   * can neither save garbage nor destroy a saved credential. A paste with
   * only the refresh token is half a credential: it is renewed first, and
   * verification then runs on the minted access token — and with no X app
   * client id saved that fails closed, before any request. A pasted access
   * token that has already expired is renewed the same way, by the transport,
   * during verification itself — so the bind still succeeds on the minted
   * token. The pair is stored before verification, so a failure that happens
   * after the save (the relay is down, X refuses the token) keeps the
   * credential and the health line says so.
   */
  connect(token: string, spriiteHandle: string): Promise<BindResult> {
    return this.serial(async () => {
      if (!/^@?[A-Za-z0-9_]{1,15}$/.test(spriiteHandle.trim())) return { ok: false, reason: 'x_not_found' }
      const typed = token.trim()
      if (typed !== '') {
        // The paste is stored before verification (see storeXPaste), so a
        // failure after the save keeps the credential and the health line
        // says so.
        const stored = await storeXPaste(this.deps.keys, this.deps.clientId?.() ?? '', typed, (r) => this.renew(r))
        if (stored.ok === false) return stored
        // A pasted pair has had no renewal attempt against the credential it
        // replaces, so the previous credential's failure must not be reported
        // against it. A refresh-only paste was minted just above; 'pasted'
        // and 'ok' read the same in health, so this downgrades nothing.
        this.lastRefresh = 'pasted'
      } else {
        // No paste: re-verify what the vault holds. Both fields are written
        // back on purpose (KeyVault.setX re-mints the generation), so a bind
        // that then fails can never leave a previous identity authorized with
        // this credential.
        const access = this.deps.keys.x
        const refresh = this.deps.keys.xRefresh
        if (!access && !refresh) return { ok: false, reason: 'no_credential' }
        if (!access) {
          // A stored refresh token with no access token is half a credential
          // exactly like a refresh-only paste: mint the pair first, and with
          // no client id there is no app to renew against.
          if (!(this.deps.clientId?.() ?? '').trim()) return { ok: false, reason: 'no_client_id' }
          const minted = await this.renew(refresh)
          if ('kind' in minted) return { ok: false, reason: `x_${minted.kind}` }
          if (!(await this.deps.keys.setX(minted.pair.accessToken, minted.pair.refreshToken))) {
            return { ok: false, reason: 'rotation_lost' }
          }
        } else if (!(await this.deps.keys.setX(access, refresh))) {
          return { ok: false, reason: 'storage' }
        }
      }
      const result = await this.intake.bind({
        spriiteHandle: spriiteHandle.trim(),
        credentialRef: this.deps.keys.xCredentialRef,
        defaultRepository: this.deps.repository() || undefined,
      })
      this.nextCheck = 0
      return result
    })
  }

  disconnect(): Promise<boolean> {
    return this.serial(async () => {
      // Clear the credential first. Even a failed unbind then cannot authorize.
      if (!(await this.deps.keys.clearX())) return false
      this.lastRefresh = null
      return this.intake.unbind()
    })
  }

  check(): Promise<string> {
    return this.serial(async () => {
      if (!this.allowed()) return 'X intake is off or its token is not verified.'
      const repository = this.deps.repository() || null
      if ((this.intake.state.binding?.defaultRepository ?? null) !== repository &&
          !(await this.intake.setDefaultRepository(repository))) {
        return 'The repository choice could not be saved; X was not checked.'
      }
      const result = await this.intake.poll()
      this.nextCheck = this.clock() + this.delayAfter(result)
      return this.health().summary
    })
  }

  private clock(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * The wait before the next scheduled check. While the owner has just come
   * back to the app (the burst), a post they made moments ago should land in
   * seconds; otherwise once a minute. Only quota and credit failures earn the
   * long backoff: hammering a rate limit makes it worse, but a dropped
   * network is usually back within the minute.
   */
  private delayAfter(result: PollResult): number {
    if (!result.ok && (result.errorKind === 'quota' || result.errorKind === 'credits')) return X_BACKOFF_MS
    if (!result.ok) return X_STEADY_MS
    return this.clock() < this.burstUntil ? X_BURST_MS : X_STEADY_MS
  }

  /** No timer queue builds up while offline or a slow request is in flight. */
  tick(): void {
    // Delivery completes outside the intake's serial action. Update the open
    // private receipt panel on the normal beat, without another X API read.
    const followups = this.deps.supervisor.missionStore.current.xFollowups
    if (followups !== this.followupView) {
      this.followupView = followups
      this.refresh()
    }
    if (this.busy || !this.deps.foreground() || !this.allowed()) return
    const now = this.clock()
    if (now < this.nextCheck) return
    this.nextCheck = now + X_STEADY_MS
    void this.check().catch(() => {
      this.nextCheck = now + X_STEADY_MS
    })
  }

  /**
   * The owner returned to the app: check now, then keep a short cadence for
   * a few minutes, since that is when a fresh post is most likely waiting.
   */
  wake(): void {
    const now = this.clock()
    this.burstUntil = now + X_BURST_WINDOW_MS
    // A quota backoff stands: waking the app must not hammer a rate limit.
    if (this.nextCheck - now > X_STEADY_MS) return
    this.nextCheck = 0
    this.tick()
  }

  importLink(link: string): Promise<IngestResult> {
    return this.serial(async () => {
      if (!this.allowed()) return { status: 'ignored', reason: 'Enable verified X intake first.' }
      const repository = this.deps.repository() || null
      if ((this.intake.state.binding?.defaultRepository ?? null) !== repository &&
          !(await this.intake.setDefaultRepository(repository))) {
        return { status: 'failed', reason: 'The repository choice could not be saved.' }
      }
      return this.intake.importLink(link)
    })
  }

  confirm(dedupeKey: string, choice: { repository?: string; newRepository?: boolean } = {}): Promise<IngestResult> {
    return this.serial(async () => {
      if (!this.allowed()) return { status: 'ignored', reason: 'Enable verified X intake first.' }
      const own = this.health().needsOwner.some((r) => r.dedupeKey === dedupeKey)
      if (!own) return { status: 'ignored', reason: 'Nothing is waiting for this owner.' }
      const repository = choice.repository?.trim() ?? ''
      if (choice.newRepository === true) return this.intake.confirmHeld(dedupeKey, { newRepository: true })
      if (repository && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(repository)) {
        return { status: 'ignored', reason: 'Choose a GitHub repository URL.' }
      }
      return this.intake.confirmHeld(dedupeKey, { repository: repository || undefined })
    })
  }

  resendFollowup(dedupeKey: string, attempt: number): Promise<boolean> {
    return this.serial(async () => {
      if (!this.allowed() || !this.health().needsOwner.some((r) => r.dedupeKey === dedupeKey && r.followupDelivery === 'unknown')) return false
      return this.intake.resendFollowup(dedupeKey, attempt)
    })
  }

  dismiss(dedupeKey: string): Promise<boolean> {
    return this.serial(async () => {
      if (!this.health().needsOwner.some((r) => r.dedupeKey === dedupeKey)) return false
      return this.intake.dismissHeld(dedupeKey)
    })
  }
}
