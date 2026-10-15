/**
 * Private phone-only X setup and receipt surface. Never projects to the HUD.
 *
 * Connecting X runs on the paired computer (contract C7): "Sign in on
 * <host>" starts the host's OAuth PKCE flow, the token stays on the host,
 * and the phone never asks for token JSON. A credential this phone already
 * holds from before keeps its verify, handoff and stop controls.
 */
import type { XConnection } from '../intake/connection'
import type { HostXSignInState, PairingClient } from '../pair/types'
import { destinationRepositoryFrom, X_LIMITATIONS, type BindResult } from '../intake/x'
import type { KeyVault } from '../voice/keys'
import type { PrefsVault } from '../state/prefs'
import type { NativeHostClient, NativeXHandoff, NativeXHostCheckpoint, NativeXHostStatus } from '../native/protocol'
import { createNativeBrokerClient, NativeBrokerError } from '../native/client'
import { canonicalBrokerUrl } from '../native/decode'
import { validGithubAccount } from '../native/delivery'
import { githubIntakeSource, type GitHubHostAccess } from '../factory/github'

/**
 * What the handoff needs from the running app beyond the vaults: the runtime
 * mode, and the phone intake's checkpoint (adopted when the phone takes X
 * back). main.ts registers it once the runtime exists; tests pass it as deps.
 */
export interface XPanelHostBridge {
  /** True only while new requests run as native missions (the Factory host launches only those). */
  nativeExecution?: () => boolean
  /** Move the phone's X checkpoint forward to the Factory host's; false when it could not be saved. */
  adoptCheckpoint?: (ownerXUserId: string, checkpoint: NativeXHostCheckpoint) => Promise<boolean>
  /** The owner's repository full names, read through their GitHub token; null when none is saved. */
  repositories?: () => Promise<string[]> | null
}
let registeredBridge: XPanelHostBridge = {}
export function setXPanelHostBridge(bridge: XPanelHostBridge): void { registeredBridge = bridge }
/** At most this many repository names travel in a handoff (the broker's bound). */
const HANDOFF_REPOSITORIES = 500
const HANDOFF_SEEN_POSTS = 100
/** The account of a configured https://github.com/<account>/<name> repository (Supervisor.nativeRepositoryAccount). */
const accountOf = (url: string): string | null => {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/[^/]+?\/?$/.exec(url.trim())
  return m && validGithubAccount(m[1]) ? m[1] : null
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

/**
 * The save-and-verify result line names the exact reason it ended the way it
 * did — the owner debugs their own relay, credits, client id and paste on a
 * phone, so a bare reason code or a silent nothing is not an answer. What
 * survived is stated by the save itself: the pair is stored before
 * verification, so a network failure keeps the credential (the hint,
 * auto-refresh and health lines below say what is in the vault).
 */
const connectFailureText = (
  r: Extract<BindResult, { ok: false }>,
  /** saved: this attempt wrote a credential (a refresh-only paste that fails
   * at renewal writes nothing, so its copy must not claim a save). */
  state: { clientId: string; refreshStored: boolean; saved: boolean },
): string => {
  switch (r.reason) {
    case 'bad_paste':
      return 'The saved X credential could not be read. Sign in on your computer again. Anything already saved was left as it was.'
    case 'no_client_id':
      return 'No X app client id saved. Add yours below, then save and verify again \u2014 a refresh token alone cannot be exchanged without your app.'
    case 'x_network':
      return state.saved
        ? 'Can\u2019t reach the relay \u2014 is the VPN on? Nothing could be verified; once the phone can reach the relay, save and verify again.'
        : 'Can\u2019t reach the relay \u2014 is the VPN on? Nothing was saved; once the phone can reach the relay, save and verify again.'
    case 'x_auth':
      return !state.clientId && state.refreshStored
        ? 'No X app client id saved in Setup \u2014 X rejected the token and renewal cannot run without your app. Add yours below, then save and verify again.'
        : state.refreshStored
          ? 'X rejected the token and the saved refresh token could not renew it. Sign in on your computer again, then verify.'
          : 'X rejected the token. Sign in on your computer again, then verify.'
    case 'x_credits':
      return state.saved
        ? 'X returned 402 \u2014 add credits in the X console. The token is saved on this phone; verify again once the project has credits.'
        : 'X returned 402 \u2014 add credits in the X console. Nothing was saved; verify again once the project has credits.'
    case 'x_quota':
      return state.saved
        ? 'Saved, but X has reached a rate or usage limit. Wait a moment, then verify again.'
        : 'X has reached a rate or usage limit, and nothing was saved. Wait a moment, then verify again.'
    case 'x_forbidden':
      return 'X refused this token\u2019s request for the account\u2019s access level. Check the app\u2019s Read access and the token\u2019s scopes, then verify again.'
    case 'x_not_found':
      return 'X could not find that Spriite handle. Check the handle, then save and verify again.'
    case 'x_service':
      return 'X returned an unexpected response. Wait a moment, then save and verify again.'
    case 'no_credential':
      return 'No X token is saved on this phone. Sign in on your computer instead: the computer keeps the token and reads X.'
    case 'rotation_lost':
      return 'X already rotated the token during renewal, and this phone could not save the new pair. The saved refresh token is dead and the new pair is lost — nothing from that credential can work again. Sign in on your computer again.'
    case 'same_account':
      return 'Use a separate Spriite account, not your personal account.'
    case 'storage':
      return 'The connection could not be saved. Try again.'
    default: {
      // Exhaustiveness: any future reason must name itself above.
      const unreachable: never = r.reason
      return `X was not verified (${String(unreachable)}). Intake cannot use this credential.`
    }
  }
}

/**
 * Handoff refusals the broker answers before it stores anything: the pair
 * never left the phone's ownership, so the phone may keep reading X. Every
 * other failure may follow a stored credential and is settled by a status
 * read before the phone takes X back.
 */
const handoffRefusedBeforeStore = (e: unknown): boolean =>
  e instanceof NativeBrokerError && ((e.code !== null && (/^(x_handoff_|invalid_)/.test(e.code) ||
    e.code === 'secret_material_refused' || e.code === 'x_reader_unavailable')) ||
    e.status === 401 || e.status === 403 || e.status === 404)

const handoffFailureText = (e: unknown): string => {
  const code = e instanceof NativeBrokerError ? e.code : null
  switch (code) {
    case 'x_reader_unavailable':
      return 'The Factory host\u2019s broker has the X reader off. Start it with SPRIITE_NATIVE_X_READER=1, then try again.'
    case 'x_handoff_rejected':
      return 'X refused this token on the Factory host. Sign in on your computer again.'
    case 'x_handoff_handle_is_owner':
      return 'The Spriite handle is your own X account. Use a separate Spriite account, then try again.'
    case 'x_handoff_template_invalid':
      return 'The Factory host refused the saved X launch settings. Save them again in Factory-native \u2192 X requests, then try again.'
    case 'x_handoff_delivery_invalid':
      return 'The Factory host refused the saved delivery defaults. Save them again, then try again.'
    case 'x_handoff_repository_invalid':
      return 'The Factory host refused the default repository. Use https://github.com/you/repo or leave it empty.'
    case 'x_handoff_network': case 'x_handoff_service':
      return 'The Factory host could not reach X to verify the token. Check its connection, then try again.'
    case 'x_handoff_quota': case 'x_handoff_credits':
      return 'X refused the Factory host\u2019s check for quota or credits. Wait, or add credits in the X console, then try again.'
    default:
      return `The Factory host refused the handoff (${code ?? (e instanceof NativeBrokerError && e.status ? `HTTP ${e.status}` : 'no answer')}).`
  }
}

/** The host is verifiably reading X for this handle with a stored credential. */
const hostReading = (s: NativeXHostStatus, handle: string): boolean =>
  s.enabled && s.running && s.credential !== null && s.reader !== null && s.reader !== 'withheld' &&
  (s.spriiteHandle ?? '').toLowerCase() === handle.toLowerCase()

/** One line per receipt; never post text (the host does not project any). */
const hostReceiptText = (r: NonNullable<Exclude<NativeXHostStatus['reader'], 'withheld'>>['receipts'][number]): string => {
  const where = r.repository ?? (r.newRepository ? `new repository ${r.newRepository}` : '')
  return `${r.status}${where ? ` \u2192 ${where}` : ''}${r.reason ? ` (${r.reason})` : ''}` +
    (r.proposedRevisionId ? ' \u2022 Edited after launch; the mission was not changed.' : '')
}

export interface XPanelOptions {
  connection: XConnection | null
  keys: KeyVault
  prefs: PrefsVault
  onSaved: () => void
  /** Opens the Build preferences card on the durable runtime toggle. */
  onOpenRuntimePrefs: () => void
  /** The host routes for the profile's broker (tests inject; default HTTP). */
  hostClient?: (brokerUrl: string) => Pick<NativeHostClient, 'xHandoff' | 'xStatus' | 'xStop'>
  /** Overrides the registered bridge (tests). */
  hostBridge?: XPanelHostBridge
  /** Host-run X sign-in (contract C7): the connect path. Absent: no paired computer here. */
  hostXSignIn?: PairingClient['hostXSignIn']
  /** The paired computer's name for "Sign in on <host>"; null or absent reads "your computer". */
  hostLabel?: () => string | null
  /** The paired host's GitHub: the repository listing prefers it over the token. */
  githubHost?: GitHubHostAccess | null
}

/**
 * Why a host X sign-in could not run, in plain words (never the raw reason
 * code). `host` is the linked computer's name, or "your computer".
 */
export const xSignInUnavailableText = (reason: string, host: string): string => {
  switch (reason) {
    case 'not_paired':
      return 'X sign-in runs on your computer through the Spriite host, and no host is linked to this phone. Pair a computer with the host installed, then connect X.'
    case 'host_unreachable':
      return `${host[0].toUpperCase()}${host.slice(1)} could not be reached. Check that it is on and online, then try again.`
    default:
      return `X sign-in is not set up on ${host} yet. Update the Spriite host there, then try again.`
  }
}

/** What a host sign-in state says on the phone. */
export const hostSignInText = (s: HostXSignInState, host: string): string => {
  switch (s.state) {
    case 'idle': return ''
    case 'pending': return `Finish signing in to X in the browser that opened on ${host}. This updates when it is done.`
    case 'connected': return `Connected${s.handle ? ` as @${s.handle.replace(/^@+/, '')}` : ''}. ${host} keeps the token and reads X; this phone never holds it.`
    case 'failed': return s.reason === 'unauthorized'
      ? `${host[0].toUpperCase()}${host.slice(1)} did not accept this phone. Pair it again, then try again.`
      : `Sign-in on ${host} did not finish. Nothing was saved; try again.`
    case 'unavailable': return xSignInUnavailableText(s.reason, host)
  }
}

export function mountXPanel(
  root: HTMLElement,
  deps: XPanelOptions,
): () => void {
  const { connection, keys, prefs } = deps
  const bridge = (): XPanelHostBridge => deps.hostBridge ?? registeredBridge
  // The credential is read per request and only while the profile still
  // names the same broker: a Setup change never sends this token elsewhere.
  const hostClient = deps.hostClient ?? ((brokerUrl: string) => createNativeBrokerClient({
    brokerUrl,
    credential: () => canonicalBrokerUrl(prefs.nativeLaunchProfile.brokerUrl) === brokerUrl
      ? keys.nativeBrokerFor(brokerUrl) : '',
  }))
  const hostBroker = (): string | null => {
    // A partial vault (a stubbed panel) reads as no broker, never a crash.
    const url = canonicalBrokerUrl(prefs.nativeLaunchProfile?.brokerUrl ?? '')
    return url && keys.nativeBrokerFor?.(url) ? url : null
  }
  const primary = el('p')
  // Host sign-in leads: the computer runs X's PKCE flow and keeps the token.
  const hostName = (): string => deps.hostLabel?.()?.trim() || 'your computer'
  const signIn = el('button', { className: 'btn', id: 'x-host-signin' })
  // Announced politely; the panel's own result line stays its one status role.
  const signInStatus = el('p', { className: 'msg muted', id: 'x-host-signin-status' })
  signInStatus.setAttribute('aria-live', 'polite')
  let signInState: HostXSignInState = { state: 'idle' }
  let hostControlsReady = false
  let signInPoll: ReturnType<typeof setTimeout> | null = null
  const renderSignIn = () => {
    const available = deps.hostXSignIn?.available() === true
    signIn.textContent = signInState.state === 'connected' ? `Sign in on ${hostName()} again` : `Sign in on ${hostName()}`
    signIn.disabled = !available || signInState.state === 'pending'
    signInStatus.textContent = !deps.hostXSignIn || (!available && signInState.state === 'idle')
      ? `Pair a computer first: X sign-in opens in its browser and the token stays there.`
      : hostSignInText(signInState, hostName())
    signInStatus.className = `msg ${signInState.state === 'connected' ? 'ok' : signInState.state === 'failed' ? 'err' : 'muted'}`
    // The host controls read the sign-in too (a token-less handoff); they
    // exist only once the panel finished mounting.
    if (hostControlsReady) renderHost()
  }
  const pollSignIn = () => {
    if (signInPoll !== null) clearTimeout(signInPoll)
    signInPoll = null
    if (signInState.state !== 'pending' || !deps.hostXSignIn) return
    const timer = setTimeout(async () => {
      signInPoll = null
      try { signInState = await deps.hostXSignIn!.status() } catch { signInState = { state: 'failed', reason: 'no answer' } }
      renderSignIn()
      if (signInState.state === 'connected') deps.onSaved()
      pollSignIn()
    }, 2000)
    ;(timer as { unref?: () => void }).unref?.()
    signInPoll = timer
  }
  signIn.onclick = async () => {
    if (!deps.hostXSignIn || signInState.state === 'pending') return
    signInState = { state: 'pending', startedAt: Date.now() }
    renderSignIn()
    try {
      signInState = await deps.hostXSignIn.start({ clientId: prefs.xClientId || undefined })
    } catch {
      signInState = { state: 'failed', reason: 'no answer' }
    }
    renderSignIn()
    if (signInState.state === 'connected') deps.onSaved()
    pollSignIn()
  }
  // The current state, once: a sign-in finished earlier shows as connected.
  if (deps.hostXSignIn?.available()) {
    void deps.hostXSignIn.status().then((s) => { signInState = s; renderSignIn(); pollSignIn() }, () => {})
  }
  // The handle is prefilled from storage, never only from a live connection:
  // with the durable runtime off (or waiting for its relaunch) no connection
  // is built, and a field that renders empty made the owner re-type a handle
  // that was already saved. The binding stays authoritative while one is
  // bound; the stored pref is what a connectionless launch can still show.
  const handle = el('input', {
    value: connection?.health().spriiteHandle ?? prefs.xSpriiteHandle,
    placeholder: 'Your Spriite account handle',
    spellcheck: false,
  })
  handle.setAttribute('aria-label', 'Spriite account handle')
  const clientId = el('input', { value: prefs.xClientId, placeholder: 'Your X app OAuth client id', autocomplete: 'off', spellcheck: false })
  clientId.setAttribute('aria-label', 'X app OAuth client id')
  const xRepo = el('input', { value: prefs.xDefaultRepository, placeholder: 'https://github.com/you/repo (optional)', autocomplete: 'off', spellcheck: false })
  xRepo.setAttribute('aria-label', 'Default repository for X builds')
  const connect = el('button', { className: 'btn', textContent: 'Save and verify' })
  const remove = el('button', { className: 'btn danger', textContent: 'Disconnect X' })
  const enabled = el('input', { type: 'checkbox', checked: prefs.flags.x_owner_intake })
  const check = el('button', { className: 'btn', textContent: 'Check now' })
  const health = el('p', { className: 'msg muted' })
  const runtimeNote = el('p', { className: 'small muted' })
  const runtimeOpen = el('button', { className: 'btn secondary', textContent: 'Open the Durable runtime switch' })
  const result = el('p', { className: 'msg muted', role: 'status' })
  const hint = el('p', { className: 'small muted' })
  const autoRefresh = el('p', { className: 'small muted' })
  const link = el('input', { type: 'url', placeholder: 'https://x.com/owner/status/…' })
  link.setAttribute('aria-label', 'Import X post link')
  const importButton = el('button', { className: 'btn', textContent: 'Import X link' })
  const needs = el('div', { className: 'stack' })
  const recent = el('div', { className: 'stack' })
  const gaps = el('div', { className: 'stack' })
  const hostOn = el('button', { className: 'btn', textContent: 'Read X on my Factory host' })
  const hostOff = el('button', { className: 'btn secondary', textContent: 'Read X on this phone again' })
  const hostCheck = el('button', { className: 'btn secondary', textContent: 'Refresh host status' })
  const hostNote = el('p', { className: 'small muted' })
  const hostHealth = el('p', { className: 'msg muted' })
  const hostReceipts = el('div', { className: 'stack' })
  let hostStatus: NativeXHostStatus | null = null
  const repositoryDrafts = new Map<string, string>()
  let needsSignature = ''
  let working = false

  runtimeOpen.onclick = () => deps.onOpenRuntimePrefs()

  const refresh = () => {
    const h = connection?.health()
    // the mechanism leads: a tag is how a request arrives, so the step opens
    // with it and keeps the handle in step with the field and the binding.
    const tag = (h?.spriiteHandle ?? handle.value).trim().replace(/^@+/, '')
    // The "while Spriite is open" promise is only true while intake is live:
    // with the runtime off or the requests switch off, the same tag is a
    // promise about the next launch, never about this one.
    primary.textContent = tag
      ? connection?.active
        ? `Tag @${tag} on X under any post. While Spriite is open it picks the mention up on its next check and starts a session. No link to paste.`
        : `Tag @${tag} on X under any post. Once X requests are running, Spriite picks the mention up on its next check and starts a session. No link to paste.`
      : 'Add the X account handle people will mention — a Spriite account, separate from your personal one. A tag starts a session; no link to paste.'
    if (tag && prefs.xHostReader) {
      primary.textContent = `Tag @${tag} on X under any post. Your Factory host reads X every minute, even while Spriite is closed, and starts the build itself.`
    }
    renderHost()
    // While the Factory host owns the pair the phone's own summary ("X intake is off")
    // is not the truth about X: the Factory host's status below stands in for it.
    health.hidden = !h || prefs.xHostReader
    health.textContent = h
      ? `${h.ownerHandle ? `@${h.ownerHandle} → @${h.spriiteHandle}. ` : ''}${h.summary}`
      : ''
    // An empty write-only box reads as "nothing is saved", which is exactly
    // how a saved credential came to look lost. The placeholder states the
    // saved fact and the one deliberate action that replaces it; the token
    // itself is never rendered.
    renderSignIn()
    // the runtime gate replaces a dead end: the step links to the switch it
    // needs, and once the flag is stored it says what the relaunch brings.
    const runtimeOff = !prefs.flags.persistent_runtime_v2
    runtimeNote.hidden = Boolean(connection) && !runtimeOff
    runtimeOpen.hidden = runtimeNote.hidden || !runtimeOff
    runtimeNote.textContent = runtimeOff
      ? 'X requests need the Durable runtime (beta), which is off. Turn it on in Build preferences; it takes effect on the next launch.'
      : 'Durable runtime is on for next launch. Relaunch Spriite to connect X.'
    // The saved state is unmistakable and never the token: what is stored,
    // where it is stored, and the one action that updates it.
    const stored = keys.xHint
      ? [
        'Saved on this phone: an X access token',
        keys.xRefresh ? 'with its refresh token' : 'but no refresh token (renewal is up to you)',
        tag ? `the handle @${tag}` : 'no handle yet',
        prefs.xClientId ? 'your X app client id' : 'no X app client id yet',
      ].join(', ')
      : 'Nothing is saved on this phone: no X token is stored here. Sign in on your computer to connect X.'
    hint.textContent = stored + (keys.xHint ? '. Tap Save and verify to check it, or sign in on your computer to move X there.' : '')
    // the renewal state is a fact about the stored pair, so it is shown even
    // when the connection could not be built this launch. A stored refresh
    // token with no client id is honest about what is missing: renewal
    // cannot run without the owner's own X app to name.
    const noClientId = !prefs.xClientId
    // With no connection this launch the vault is the only fact left, and a
    // stored pair is never misread as "no refresh token" — the nonsense
    // "saved fine but it says auto refresh is off" stops here.
    const renewal = h ? h.refresh : null
    autoRefresh.textContent =
      renewal === 'on' ? (noClientId
        ? 'Auto-refresh is armed, but no X app client id is saved: add yours below so Spriite can renew this token.'
        : 'Auto-refresh on: Spriite renews this token itself while it is open.')
      : renewal === 'armed' ? (noClientId
        ? 'Auto-refresh on (token saved, not verified yet), but no X app client id is saved: add yours below, then save and verify again.'
        : 'Auto-refresh on (token saved, not verified yet): Spriite renews the token once verification succeeds.')
      : renewal === 'failed' ? (noClientId
        ? 'Auto-refresh failed: no X app client id is saved. Add yours below, then save and verify again.'
        : 'Auto-refresh failed: Spriite could not renew this token, or could not save the renewal. Sign in on your computer again.')
      : keys.xRefresh ? (noClientId
        ? 'A refresh token is saved, but no X app client id is: add yours below so renewal can run after the relaunch.'
        : 'Auto-refresh on: a refresh token is saved on this phone. Renewal resumes when the Durable runtime is on \u2014 relaunch Spriite to connect X.')
        : 'Auto-refresh off: no refresh token is saved, so an expired access token must be renewed outside Spriite.'
    // never gated on the runtime or the connection: an X action brings the
    // runtime flag along (ensureRuntime), so the control stays usable and
    // follows the stored preference on every re-render. Not while a write is
    // in the air, though: the box shows the choice the owner just made, and
    // a failed write is where it rolls back honestly.
    if (!working) enabled.checked = prefs.flags.x_owner_intake
    enabled.disabled = working
    connect.disabled = working
    remove.disabled = working
    check.disabled = importButton.disabled = working || !connection?.active
    remove.hidden = !keys.xHint
    const signature = JSON.stringify([h?.needsOwner, working, connection?.active, prefs.xDefaultRepository])
    if (signature !== needsSignature) {
      needsSignature = signature
      needs.replaceChildren(
        el('b', { textContent: 'Needs you' }),
        ...(h?.needsOwner ?? []).map((receipt) => {
          // The intake's own routing order (src/intake/x.ts): the receipt's
          // recorded repository, then the post's own words, then the
          // configured default the binding carries — the prefill shows the
          // repository confirming would actually route to, never a bare
          // default that overrules the owner's own post.
          const repository = el('input', {
            value:
              repositoryDrafts.get(receipt.dedupeKey) ??
              receipt.repository ??
              destinationRepositoryFrom(receipt.instruction) ??
              receipt.repositoryChoices?.[0] ??
              prefs.xDefaultRepository,
            placeholder: 'https://github.com/owner/repository',
          })
          repository.setAttribute('aria-label', 'Repository for held X request')
          repository.oninput = () => repositoryDrafts.set(receipt.dedupeKey, repository.value)
          const followupUnknown = receipt.followupDelivery === 'unknown'
          repository.hidden = followupUnknown
          const confirm = el('button', { className: 'btn', textContent: followupUnknown ? 'Resend (may duplicate)' : 'Recheck and confirm', disabled: working || !connection?.active })
          const dismiss = el('button', { className: 'btn danger', textContent: 'Dismiss', disabled: working })
          confirm.onclick = () => void run(async () => {
            if (followupUnknown) return await connection!.resendFollowup(receipt.dedupeKey, receipt.followupAttempt ?? 0)
              ? 'Saved to resend to the same build.' : 'The delivery changed; check its receipt before trying again.'
            const r = await connection!.confirm(receipt.dedupeKey, { repository: repository.value.trim() || undefined })
            return `${r.status}${r.reason ? `: ${r.reason}` : ''}`
          })
          dismiss.onclick = () => void run(async () =>
            await connection!.dismiss(receipt.dedupeKey) ? 'Dismissed.' : 'Could not save the dismissal.',
          )
          const buttons = [confirm, dismiss]
          if (receipt.projectName !== undefined) {
            const fresh = el('button', { className: 'btn secondary', textContent: 'New repository', disabled: working || !connection?.active })
            fresh.onclick = () => void run(async () => {
              const r = await connection!.confirm(receipt.dedupeKey, { newRepository: true })
              return `${r.status}${r.reason ? `: ${r.reason}` : ''}`
            })
            buttons.splice(1, 0, fresh)
          }
          return el('div', { className: 'sub' }, [
            el('p', { textContent: receipt.instruction }),
            el('p', { className: 'small muted', textContent: receipt.reason ?? receipt.status }),
            repository,
            el('div', { className: 'btns grow' }, buttons),
          ])
        }),
        ...(!h?.needsOwner.length ? [el('p', { className: 'small muted', textContent: 'No held requests.' })] : []),
      )
      for (const key of repositoryDrafts.keys()) {
        if (!h?.needsOwner.some((r) => r.dedupeKey === key)) repositoryDrafts.delete(key)
      }
    }
    recent.replaceChildren(
      el('b', { textContent: 'Recent private receipts' }),
      ...(h?.recent ?? []).map((r) => el('p', {
        className: 'small muted',
        textContent: `${r.status}: ${r.instruction}${r.reason ? ` (${r.reason})` : ''}` +
          (r.proposedRevisionId ? ' • Edited after dispatch; the mission was not changed.' : ''),
      })),
    )
    gaps.replaceChildren(...(h?.gaps ?? []).map((g) => el('p', {
      className: 'msg err',
      textContent: `Delivery gap ${g.from} to ${g.to}: ${g.reason}. Import a missed X link.`,
    })))
  }

  function renderHost() {
    const broker = hostBroker()
    hostOn.hidden = prefs.xHostReader
    hostOff.hidden = hostCheck.hidden = !prefs.xHostReader
    hostOn.disabled = hostOff.disabled = hostCheck.disabled = working
    hostNote.textContent = prefs.xHostReader
      ? 'Your Factory host holds the X token and reads X; this phone no longer checks or renews it. To read X here again, the Factory host stops and erases its copy: the Factory host never hands a token back, so connect again by signing in on your computer.'
      : broker && signInState.state === 'connected' && !(keys.x && keys.xRefresh)
        ? 'Your computer signed in to X and holds the token. Send it the reader settings so tagged posts start builds while Spriite is closed.'
      : broker
        ? 'Hand this phone\u2019s X token to your Factory host\u2019s broker so tagged posts start builds while Spriite is closed. The phone then stops reading X and drops its refresh token: only one side may renew it.'
        : 'Reading X on your Factory host needs the Factory-native broker URL, owner and credential saved in Setup first.'
    const s = prefs.xHostReader ? hostStatus : null
    const reader = s?.reader && s.reader !== 'withheld' ? s.reader : null
    hostHealth.hidden = !s
    hostHealth.textContent = !s ? ''
      : !s.running ? `The Factory host is not reading X${s.lastError ? ` (${s.lastError})` : ''}. Tap Read X on this phone again, or restart the Factory host\u2019s broker.`
        : s.reader === 'withheld' ? 'The Factory host is reading X, but withheld its status as unreadable.'
          : `The Factory host reads X as @${s.spriiteHandle ?? '?'}.` +
            (reader?.lastSuccessAt ? ` Last read ${reader.lastSuccessAt}.` : ' No read finished yet.') +
            (reader?.lastError ? ` Last error: ${reader.lastError}.` : '') +
            (reader?.gapCount ? ` X had more posts than one read ${reader.gapCount} time(s); the Factory host read the rest on its next checks.` : '')
    hostReceipts.replaceChildren(...(reader ? [
      el('b', { textContent: 'Receipts from your Factory host' }),
      ...(reader.receipts.length ? reader.receipts.map((r) => el('p', { className: 'small muted', textContent: hostReceiptText(r) }))
        : [el('p', { className: 'small muted', textContent: 'No X requests read on the Factory host yet.' })]),
    ] : []))
  }
  const loadHostStatus = async (): Promise<NativeXHostStatus | null> => {
    const broker = hostBroker()
    if (!broker) return null
    try { hostStatus = await hostClient(broker).xStatus() } catch { hostStatus = null }
    return hostStatus
  }
  /**
   * Stop the Factory host and take X back: the phone resumes only once the Factory host
   * confirms it stopped, and only after adopting the Factory host's checkpoint, so a
   * post the Factory host already launched is never read and launched here again.
   * Returns null on success, else the reason the phone stays paused.
   */
  const stopHost = async (): Promise<string | null> => {
    const broker = hostBroker()
    if (!broker) return 'The Factory-native broker is not saved in Setup, so the Factory host cannot be told to stop. Phone reading stays off.'
    let status: NativeXHostStatus
    try { status = await hostClient(broker).xStop() } catch (error) {
      // A broker with no X reader at all reads nothing: the phone may take over.
      if (!(error instanceof NativeBrokerError && error.code === 'x_reader_unavailable')) {
        return 'The Factory host could not be told to stop. Phone reading stays off, so two readers never renew one token; try again once the Factory host is reachable.'
      }
      hostStatus = null
      return (await prefs.setXHostReader(false)) ? null : 'This phone could not save the change. Try again.'
    }
    hostStatus = status
    if (status.running || status.enabled) return 'The Factory host did not confirm it stopped. Phone reading stays off; try again.'
    if (status.checkpoint && status.ownerXUserId) {
      const adopt = bridge().adoptCheckpoint
      if (!adopt || !(await adopt(status.ownerXUserId, status.checkpoint))) {
        return 'The Factory host stopped, but this phone could not record where the Factory host stopped reading, so it stays paused rather than read those posts twice. Try again.'
      }
    }
    if (!(await prefs.setXHostReader(false))) return 'The Factory host stopped, but this phone could not save the change. Try again.'
    hostStatus = null
    return null
  }

  const run = async (action: () => Promise<string>) => {
    if (working) {
      // One X action at a time; a second tap is told so, never silently
      // dropped (the buttons are disabled meanwhile, but a stray tap must
      // still answer).
      result.textContent = 'Still finishing the last request \u2014 one moment.'
      return
    }
    working = true
    refresh()
    result.textContent = 'Working…'
    try { result.textContent = await action() }
    catch { result.textContent = 'X could not complete this action. Check the connection and try again.' }
    finally { working = false; refresh(); deps.onSaved() }
  }
  // x_owner_intake is dropped while the durable runtime is off (flags.ts), so
  // an X action turns the runtime on through the same write the Build
  // preferences toggle uses. Flags are read at boot: it lands next launch.
  const ensureRuntime = (): Promise<boolean> =>
    prefs.flags.persistent_runtime_v2 ? Promise.resolve(true) : prefs.setFlag('persistent_runtime_v2', true)
  connect.onclick = () => void run(async () => {
    // Two owners of one rotating pair kill each other's token: the Factory host stops
    // first, and only then may this phone verify a fresh paste.
    if (prefs.xHostReader) return 'Your Factory host reads X now. Tap Read X on this phone again first, then save and verify.'
    // Checked before the token field is consumed: a malformed handle never
    // reaches X, so the paste must not be lost to it. The handle is required
    // for the same reason — sending the owner away to type one (or to
    // relaunch) with the paste already cleared is what forced a second copy
    // of the same token JSON out of X, every time.
    const spriite = handle.value.trim()
    if (spriite && !/^@?[A-Za-z0-9_]{1,15}$/.test(spriite)) {
      return 'That is not an X handle: use 1 to 15 letters, digits or underscores, like @YourSpriite. Nothing was saved.'
    }
    if (!spriite) {
      return 'Add the Spriite account handle people will mention, then save and verify again.'
    }
    // The handle is a label the owner will keep, and it is not a secret: store
    // what the owner typed before anything can use it, exactly like the client
    // id, so the next launch prefills the field from storage instead of
    // reading as lost. The verified binding stays the authority while bound.
    if (!(await prefs.setXSpriiteHandle(spriite))) {
      return 'The Spriite handle could not be saved. Try again.'
    }
    // The client id is a registration fact, not a secret: store what the
    // owner typed before anything can use it, even if the connect below
    // fails. An empty save clears it, matching every other pref here.
    if (!(await prefs.setXClientId(clientId.value))) {
      return 'The X app client id could not be saved. Try again.'
    }
    const repoTyped = xRepo.value.trim()
    if (!(await prefs.setXDefaultRepository(repoTyped))) {
      return 'The X default repository could not be saved. Try again.'
    }
    if (repoTyped && !prefs.xDefaultRepository) {
      return 'The X default repository must look like https://github.com/you/repo. It was cleared; posts that name no repository get a new one.'
    }
    if (!(await ensureRuntime())) return 'The change could not be saved on this phone. Try again.'
    // The phone never takes token JSON (contract C7): this verifies the
    // credential already saved on this phone, if any. Connecting is the
    // host sign-in above.
    if (!connection) {
      return keys.xHint
        ? 'A token is already saved on this phone. Relaunch Spriite to connect X, then tap Save and verify to check it against X.'
        : 'Saved. Durable runtime is on for next launch. To connect X, sign in on your computer.'
    }
    const typed = ''
    const generation = keys.xCredentialRef
    const r = await connection.connect(typed, spriite)
    if (r.ok === true) {
      // The binding resolved the handle against X, so that resolved form is
      // the stored prefill from here on — the owner's typing was only a guess
      // at the exact handle until X confirmed it.
      await prefs.setXSpriiteHandle(r.binding.spriiteHandle)
      return r.binding.protectedOwner
        ? 'Verified, but protected accounts are unsupported.'
        : connection!.active ? 'Verified. X requests are enabled.' : 'Verified. X intake stays off until you enable X requests.'
    }
    // The reason the owner can act on, not a code: the client id was saved at
    // the top of this handler, so the inference below reads this attempt.
    // Every credential write mints a new generation, so an unchanged one
    // means this attempt stored nothing.
    return connectFailureText(r, {
      clientId: prefs.xClientId,
      refreshStored: keys.xRefresh !== '',
      // The phone never takes a new paste: whether a credential is on this
      // phone is the fact the copy reports.
      saved: keys.x !== '' || keys.xCredentialRef !== generation,
    })
  })
  // Without a connection this launch (durable runtime off) the vault still
  // holds the token, and removing it must not wait for a relaunch. With no
  // credential the stored binding cannot authorize anything. The handle and
  // the client id stay stored: like the client id, the handle is the owner's
  // own label, not a secret, and keeping it is what makes reconnecting one
  // paste instead of a full re-setup.
  remove.onclick = () => void run(async () => {
    // Disconnecting here while the Factory host reads would leave the Factory host reading.
    if (prefs.xHostReader) {
      const stopped = await stopHost()
      if (stopped) return `Nothing was disconnected: your Factory host still reads X. ${stopped}`
    }
    return (connection ? await connection.disconnect() : await keys.clearX())
      ? 'Disconnected.'
      : 'Disconnect could not be fully saved. Check the connection.'
  })
  enabled.onchange = () => {
    const on = enabled.checked
    void run(async () => {
      if (on && !(await ensureRuntime())) return 'The change could not be saved on this phone. Try again.'
      const ok = await prefs.setFlag('x_owner_intake', on)
      // Apply the kill switch before any queued operation can launch.
      deps.onSaved()
      connection?.refresh()
      if (!ok) return 'The setting could not be saved.'
      // The Factory host reads X on its own: off is only off once the Factory host confirms it stopped.
      if (!on && prefs.xHostReader) {
        const stopped = await stopHost()
        return stopped ? `X requests are off on this phone, but your Factory host may still be reading X. ${stopped}` : 'X requests off. Your Factory host stopped reading X.'
      }
      if (on && !connection) {
        return 'Saved. Durable runtime is on for next launch; relaunch Spriite to activate X requests.'
      }
      return on ? 'X requests enabled. Checks run while the phone is in the foreground.' : 'X requests off.'
    })
  }
  // The handoff: the live pair, the X settings and the delivery defaults go
  // to the profile's broker once. Phone reading pauses first (a renewal here
  // mid-handoff would kill the pair the Factory host just stored), and the refresh
  // token is dropped only after the Factory host verifiably reads X with it.
  hostOn.onclick = () => void run(async () => {
    const broker = hostBroker()
    if (!broker) return 'Save the Factory-native broker URL, owner and credential in Setup first.'
    const spriite = (connection?.health().spriiteHandle ?? prefs.xSpriiteHandle).trim().replace(/^@+/, '')
    if (!/^[A-Za-z0-9_]{1,15}$/.test(spriite)) return 'Save the Spriite handle above first.'
    // After a host sign-in the computer already holds the pair: the phone
    // sends only its reader settings and the broker joins the pair it holds
    // (C7), so a token never travels to the phone and back.
    const signedInOnHost = signInState.state === 'connected'
    const phonePair = Boolean(keys.x && keys.xRefresh)
    if (!phonePair && !signedInOnHost) return 'This phone holds no X token with a refresh token to hand over. Sign in on your computer first: the reader settings then go to it and it reads X there directly.'
    // A host sign-in already told the computer which X app renews the pair.
    if (phonePair && !prefs.xClientId) return 'Save your X app client id above first: the Factory host renews with it.'
    const auto = prefs.nativeXAuto
    if (!auto.template) return 'Save the X launch settings in Factory-native \u2192 X requests first: the Factory host launches with them.'
    // The Factory host launches every tagged build with no review, so it takes over
    // only what the phone itself would run on its own: native and automatic.
    if (!auto.enabled) return 'Turn on running X requests automatically in Factory-native \u2192 X requests first: the Factory host launches each tagged build without asking.'
    if (bridge().nativeExecution?.() !== true) return 'The Factory host launches Factory-native missions only. Switch new builds to Factory-native first.'
    const repositoryAccount = accountOf(keys.repoUrl ?? '') ?? accountOf(prefs.xDefaultRepository)
    if (!repositoryAccount) return 'Save your GitHub repository in Setup (or an X default repository) first: new repositories from X are created under that account.'
    // The owner's repositories, so a word naming one is asked about on the
    // Factory host too; an unreadable list is not "none".
    let repositories: string[] | undefined
    // Whether the paired host provides GitHub is settled first, so a host
    // that does lists here and one that does not reads as no listing.
    if (!keys.github && deps.githubHost?.known() === null) await deps.githubHost.check().catch(() => false)
    const listing = bridge().repositories?.() ?? githubIntakeSource(() => keys.github ?? '', deps.githubHost)?.repos().then(r => r.map(x => x.fullName)) ?? null
    if (listing) {
      try { repositories = [...new Set((await listing).filter(n => /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(n)))].slice(0, HANDOFF_REPOSITORIES) } catch {
        return 'Your GitHub repositories could not be read, so nothing was sent. Check the GitHub token, then try again.'
      }
    }
    if (!(await prefs.setXHostReader(true))) return 'The change could not be saved on this phone. Nothing was sent.'
    deps.onSaved()
    // The pause gates new checks only: one already running may still renew.
    // A check queued now runs after it and answers at once (reading is off),
    // so once it returns no renewal is in the air.
    if (connection && phonePair) await connection.check().catch(() => '')
    // Read after the drain: the pair sent is the one no phone check can rotate.
    // Without a phone-held pair nothing token-shaped is sent at all.
    const pair = phonePair ? { accessToken: keys.x, refreshToken: keys.xRefresh } : null
    // Where the phone's own reading ended: the Factory host starts there, and what the
    // phone already handled is never launched again on the Factory host.
    const h = connection?.health()
    const seenPostIds = [...new Set([...(h?.recent ?? []), ...(h?.needsOwner ?? [])]
      .map(r => r.dedupeKey.split(':')[2]).filter((id): id is string => typeof id === 'string' && /^\d{1,20}$/.test(id)))]
      .slice(0, HANDOFF_SEEN_POSTS)
    const client = hostClient(broker)
    let status: NativeXHostStatus | null = null
    try {
      // The token-less body is what the broker's host sign-in branch takes
      // (broker/server.mjs); the frozen wire type still names the pair.
      status = await client.xHandoff({
        ...(pair ?? {}), clientId: prefs.xClientId, spriiteHandle: spriite, template: auto.template,
        delivery: prefs.nativeDeliveryDefaults, repositoryAccount,
        ...(prefs.xDefaultRepository ? { defaultRepository: prefs.xDefaultRepository } : {}),
        ...(h?.lastSuccessAt ? { startAt: h.lastSuccessAt } : {}),
        ...(seenPostIds.length ? { seenPostIds } : {}),
        ...(repositories ? { repositories } : {}),
      } as NativeXHandoff)
    } catch (error) {
      if (handoffRefusedBeforeStore(error)) {
        await prefs.setXHostReader(false)
        return `${handoffFailureText(error)} This phone keeps reading X.`
      }
      // The Factory host may hold the pair: its own status settles it.
      status = await loadHostStatus()
      if (!status) {
        return 'The Factory host did not confirm the handoff and its status cannot be read. This phone keeps its token but stays paused, so two readers never renew it. Refresh the host status, or tap Read X on this phone again.'
      }
    }
    hostStatus = status
    if (!hostReading(status, spriite)) {
      // An answer that does not show the Factory host reading is not a handoff: the
      // Factory host stops (so a restart never resumes it) before the phone resumes.
      try { hostStatus = await client.xStop() } catch {
        return 'The Factory host answered but is not reading X, and could not be told to stop. This phone stays paused; tap Read X on this phone again once the Factory host is reachable.'
      }
      await prefs.setXHostReader(false)
      return `The Factory host did not start reading X${status.lastError ? ` (${status.lastError})` : ''}. This phone keeps reading X.`
    }
    if (pair === null) {
      return `Your Factory host reads X as @${status.spriiteHandle}. It signed in itself and keeps the token; this phone never held it.`
    }
    if (keys.xRefresh !== pair.refreshToken) {
      // A renewal already in the air when the pause landed rotated the pair:
      // the Factory host holds a dead copy. It stops; the phone keeps the live one.
      try { hostStatus = await client.xStop() } catch {
        return 'This phone renewed the token during the handoff, so the Factory host\u2019s copy is dead, and the Factory host could not be told to stop. Phone reading stays paused; tap Read X on this phone again.'
      }
      await prefs.setXHostReader(false)
      return 'This phone renewed the token during the handoff, so the Factory host stopped. Tap Read X on my Factory host again.'
    }
    if (!(await keys.clearXRefresh())) {
      return 'Your Factory host reads X now, but this phone could not drop its refresh token. Phone reading stays off; tap Read X on my Factory host again to retry.'
    }
    return `Your Factory host reads X as @${status.spriiteHandle}. This phone stopped reading X and dropped its refresh token.`
  })
  hostOff.onclick = () => void run(async () => {
    const stopped = await stopHost()
    if (stopped) return stopped
    return 'The Factory host stopped reading X and erased its copy of the token: X rotated it there, so it cannot come back. To connect X again, sign in on your computer.'
  })
  hostCheck.onclick = () => void run(async () =>
    await loadHostStatus() ? 'Host status refreshed.' : 'The Factory host\u2019s status could not be read. Check the broker connection.')
  check.onclick = () => void run(() => connection!.check())
  importButton.onclick = () => void run(async () => {
    const r = await connection!.importLink(link.value.trim())
    if (r.status !== 'failed' && r.status !== 'ignored' && r.status !== 'rejected') link.value = ''
    return `${r.status}${r.reason ? `: ${r.reason}` : ''}`
  })
  // the primary copy leads with the real mechanism; the paste-in import is a
  // framed fallback for what pickup misses, co-equal with nothing.
  handle.oninput = refresh
  root.append(
    primary,
    el('div', { className: 'stack' }, [signIn, signInStatus]),
    el('p', { className: 'small muted', textContent: 'Bring your own X app: create one in the X developer console (a Native App with Read access, a public PKCE client) and copy its OAuth client id here. Sign-in runs on your paired computer: X opens in its browser, the read-only token (tweet.read, users.read, offline.access) stays there, and the computer renews it itself. This phone never asks for a token.' }),
    el('label', { className: 'field' }, ['Spriite handle', handle]),
    el('label', { className: 'field' }, ['X app client id', clientId]),
    el('label', { className: 'field' }, ['Default repository for X builds', xRepo]),
    el('p', { className: 'small muted', textContent: 'Optional. A post that names no repository builds here. Leave empty and each such post gets a new repository of its own; an X build never uses the repository selected in the app.' }),
    el('div', { className: 'btns grow' }, [connect, remove]),
    hint,
    autoRefresh,
    health,
    el('div', { className: 'sub' }, [
      el('div', { className: 'eyebrow', textContent: 'On your Factory host' }),
      hostNote,
      el('div', { className: 'btns grow' }, [hostOn, hostOff, hostCheck]),
      hostHealth,
      hostReceipts,
    ]),
    runtimeNote,
    runtimeOpen,
    el('label', { className: 'check' }, [enabled, 'X requests (beta, off by default)']),
    el('p', { className: 'small muted', textContent: 'Enable only after the live checks in docs/X-INTAKE-HANDOFF.md pass. Your own mentions can start real builds and spend worker credits.' }),
    check,
    result, gaps,
    el('div', { className: 'sub' }, [
      el('div', { className: 'eyebrow', textContent: 'Missed a post?' }),
      el('p', { className: 'small muted', textContent: 'If pickup misses something, like a post past one check\u2019s reach or a delivery gap above, paste its link and Spriite imports it now.' }),
      link,
      importButton,
    ]),
    needs, recent,
    el('ul', { className: 'small muted' }, X_LIMITATIONS.map((text) => el('li', { textContent: text }))),
  )
  connection?.subscribe(refresh)
  hostControlsReady = true
  refresh()
  // The Factory host's receipts stand in for the phone's own while it reads X there.
  if (prefs.xHostReader) void loadHostStatus().then(refresh)
  // the panel calls this whenever preferences change: the runtime flag gates
  // this step, and without a live connection there is nothing to listen to.
  return refresh
}
