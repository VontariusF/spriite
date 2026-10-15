/**
 * The paired host's GitHub (docs/design/HOST-GITHUB-PLAN.md). When the
 * computer this phone paired with has `gh` signed in, every GitHub call runs
 * there through the broker's one allowlisted route, and the phone needs no
 * GitHub token. This module knows whether that is so (the broker's
 * capability, cached) and builds the host transport selectGitHub hands out.
 *
 * The broker credential is read per request and only for the paired host's
 * own URL (keys.nativeBrokerFor binds it), so a pairing change never sends
 * one host's token to another.
 */
import { canonicalBrokerUrl } from '../native/decode'
import { createNativeBrokerClient, NativeBrokerError } from '../native/client'
import type { NativeCapabilities } from '../native/protocol'
import { GitHubError, githubHostTransport, type GitHubHostAccess, type GitHubHostRequest, type GitHubTransport } from './github'

/** The broker calls this needs; the HTTP client by default, a fake in tests. */
export interface GitHubHostClient {
  capabilities(): Promise<NativeCapabilities>
  githubCall(request: GitHubHostRequest): Promise<{ status: number; body: unknown }>
}

export interface GitHubHostDeps {
  /** prefs.pairedHost: where the host's broker is and what it is called. */
  host: () => { brokerUrl: string; label: string } | null
  /** keys.nativeBrokerFor: the bearer for exactly that broker, or ''. */
  credential: (brokerUrl: string) => string
  client?: (brokerUrl: string, credential: () => string) => GitHubHostClient
  now?: () => number
  /** How long an answer holds: a yes is re-asked after this, a no sooner. */
  ttlMs?: number
  missTtlMs?: number
}

export interface GitHubHost extends GitHubHostAccess {
  /** The host's GitHub account, when it provides GitHub. */
  login(): string | null
  /** Forget the answer (the host signed out, or stopped answering). */
  invalidate(): void
  /** Called when a probe settles to a different answer. */
  onChange(listener: () => void): () => void
}

/** A broker failure as the GitHub error kinds the phone already maps. */
function hostError(e: unknown, write: boolean): GitHubError {
  if (e instanceof GitHubError) return e
  const code = e instanceof NativeBrokerError ? e.code : null
  const status = e instanceof NativeBrokerError ? e.status : null
  if (code === 'github_call_refused') return new GitHubError('permission', 'The paired host does not make that GitHub call')
  if (code === 'github_call_busy') return new GitHubError('quota', 'The paired host is busy with other GitHub calls')
  // gh confirmed it is signed out, so nothing reached GitHub. A gh that could
  // not reach GitHub (github_unreachable) falls through to 'network' below, so
  // a create that may have landed stays outcome unconfirmed.
  if (code === 'github_unavailable') return new GitHubError('auth', 'The paired host is not signed in to GitHub')
  if (code === 'github_response_too_large') return new GitHubError('service', 'GitHub answered more than the host relays')
  if (status === 401 || status === 403) return new GitHubError('auth', 'The paired host did not accept this phone')
  return new GitHubError('network', write
    ? 'The paired host could not complete the GitHub call (outcome unconfirmed)'
    : 'The paired host could not reach GitHub')
}

export function createGitHubHost(deps: GitHubHostDeps): GitHubHost {
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? 60_000
  const missTtlMs = deps.missTtlMs ?? 15_000
  const clientFor = deps.client ?? ((brokerUrl, credential) => createNativeBrokerClient({ brokerUrl, credential }))
  const listeners = new Set<() => void>()
  let cache: { identity: string; available: boolean; login: string | null; at: number } | null = null
  let probe: { identity: string; done: Promise<boolean> } | null = null

  /** The paired broker and its bearer right now, or null when unpaired/unlinked. */
  const target = (): { brokerUrl: string; label: string; identity: string } | null => {
    const host = deps.host()
    const brokerUrl = host ? canonicalBrokerUrl(host.brokerUrl) : null
    if (!host || !brokerUrl) return null
    const credential = deps.credential(brokerUrl)
    if (!credential) return null
    return { brokerUrl, label: host.label, identity: `${brokerUrl}\n${credential}` }
  }
  const bound = (brokerUrl: string, identity: string): GitHubHostClient =>
    clientFor(brokerUrl, () => target()?.identity === identity ? deps.credential(brokerUrl) : '')
  const settle = (identity: string, available: boolean, login: string | null): boolean => {
    const changed = cache?.identity !== identity || cache.available !== available
    cache = { identity, available, login, at: now() }
    if (changed) for (const fn of listeners) { try { fn() } catch { /* a listener never breaks the probe */ } }
    return available
  }
  const fresh = (identity: string): boolean =>
    cache !== null && cache.identity === identity && now() - cache.at < (cache.available ? ttlMs : missTtlMs)

  const host: GitHubHost = {
    known() {
      const t = target()
      if (!t) return false
      if (fresh(t.identity)) return cache!.available
      // Past its TTL nothing else re-asks on its own (gates and copy only read
      // this), so the read starts the re-check and onChange redraws when it
      // settles. A stale yes holds until then: only a settled no or
      // invalidate() takes the host away.
      void host.check()
      return cache?.identity === t.identity && cache.available ? true : null
    },
    check() {
      const t = target()
      if (!t) return Promise.resolve(false)
      if (fresh(t.identity)) return Promise.resolve(cache!.available)
      if (probe?.identity === t.identity) return probe.done
      const done = bound(t.brokerUrl, t.identity).capabilities().then(
        (c) => settle(t.identity, c.github?.available === true && c.github.login !== null, c.github?.login ?? null),
        () => settle(t.identity, false, null),
      ).finally(() => { if (probe?.done === done) probe = null })
      probe = { identity: t.identity, done }
      return done
    },
    transport(): GitHubTransport | null {
      const t = target()
      if (!t) return null
      const client = bound(t.brokerUrl, t.identity)
      return githubHostTransport(async (request) => {
        let reply: { status: number; body: unknown }
        try {
          reply = await client.githubCall(request)
        } catch (e) {
          const err = hostError(e, request.method === 'POST')
          // Signed out, unreachable or refusing this phone: ask again next
          // time, so selection can fall back to the phone's token.
          if (err.kind === 'auth' || err.kind === 'network') host.invalidate()
          throw err
        }
        if (reply.status === 401) host.invalidate()
        return reply
      })
    },
    label() {
      return target()?.label.trim() || null
    },
    login() {
      const t = target()
      return t && cache?.identity === t.identity && cache.available ? cache.login : null
    },
    invalidate() {
      cache = null
    },
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return host
}
