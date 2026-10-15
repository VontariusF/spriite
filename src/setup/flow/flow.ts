/**
 * The first-run setup flow (boards Main, Pair, Paired, Repo, Ready and the
 * undrawn Move receiver composed from Pair). Plain DOM, `sf-` classes over
 * the C1 tokens, every string from ./copy.
 *
 * Paths:
 *   Welcome › Pair › Paired › Repo › Ready        (paired)
 *   Welcome › Repo (key-only variant) › Ready      (key only, builds in Factory cloud)
 *   Welcome › Move receiver › Ready                (moved from another phone)
 *   Settings context: Pair › Paired › onDone       (pair a different computer)
 *
 * Setup completes when the owner taps "Finish setup" on Repo (or a move
 * lands).
 */
import { factoryComputers, FactoryError } from '../../factory/fapi'
import { githubRepos, type GitHubAuth, type GitHubHostAccess, type GitHubRepo } from '../../factory/github'
import type { KeyVault } from '../../voice/keys'
import type { PrefsVault } from '../../state/prefs'
import type { PairingBundle, PairingClient, RepoMode, RunOn, SetupPath } from '../../pair/types'
import { COPY, PAIR_FAILURE, TRANSFER_FAILURE } from './copy'
import { createCodeEntry, type CodeEntry } from './code-entry'
import { attr, button, el, ensureSetupStyles, sprite, stepHeader } from './dom'
import { iconEl, type IconName } from './icons'
import { createRepoPicker } from './repo'

export type SetupEntry = 'welcome' | 'pair' | 'key_only' | 'move_receive'
export type SetupScreenId = 'welcome' | 'pair' | 'paired' | 'repo' | 'ready' | 'move_receive'

/** The outcome of a Ready extra, shown on Ready (undrawn state). */
export interface ExtraNote { text: string; tone: 'ok' | 'err' }

export interface SetupFlowDeps {
  keys: KeyVault
  prefs: PrefsVault
  pairing: PairingClient
  /** Default: githubRepos. */
  github?: { repos(auth: GitHubAuth): Promise<GitHubRepo[]> }
  /** The paired host's GitHub (HOST-GITHUB-PLAN): the repo list prefers it. */
  githubHost?: GitHubHostAccess | null
  /** Default: a factoryComputers call with the key. */
  testFactoryKey?: (key: string) => Promise<{ ok: true } | { ok: false; message: string }>
  /** 'settings': Pair › Paired › onDone (no Repo/Ready). */
  context?: 'first_run' | 'settings'
  entry?: SetupEntry
  /**
   * Ready's optional extras. The promise settles when the owner is back on
   * Ready (the key sheet closed, the sign-in started); a returned note is
   * the outcome shown on Ready under the extras.
   */
  onExtra(kind: 'voice' | 'x' | 'cursor'): void | ExtraNote | Promise<void | ExtraNote>
  /**
   * What the last save-and-test proved about an extra's key: a key the
   * service rejected is not "Added" (Ready offers Check key instead).
   */
  extraHealth?(kind: 'voice' | 'cursor'): 'off' | 'saved' | 'ok' | 'failed' | 'no_computer'
  /** After every vault write (hot-apply). */
  onSaved(): void
  /** Ready's "Open Spriite", or the end of a settings-context flow. */
  onDone(): void
}

export interface SetupFlowHandle {
  readonly screen: SetupScreenId
  show(entry: SetupEntry): void
  destroy(): void
}

/** Default key check: listing the account's computers proves the key works. */
export async function defaultTestFactoryKey(key: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await factoryComputers(key)
    return { ok: true }
  } catch (e) {
    if (e instanceof FactoryError && e.kind === 'auth') return { ok: false, message: COPY.repo.keyRejected }
    const msg = e instanceof Error && e.message ? e.message : 'Factory didn’t answer'
    return { ok: false, message: `${msg}. Try again.` }
  }
}

type RepoPath = 'paired' | 'key_only'

/** Camera QR scanning, when the platform has it (BarcodeDetector + getUserMedia). */
interface Detector { detect(src: unknown): Promise<Array<{ rawValue?: string }>> }
type DetectorCtor = new (opts: { formats: string[] }) => Detector

function scannerAvailable(): boolean {
  const g = globalThis as { BarcodeDetector?: unknown; navigator?: { mediaDevices?: { getUserMedia?: unknown } } }
  return typeof g.BarcodeDetector === 'function' && typeof g.navigator?.mediaDevices?.getUserMedia === 'function'
}

interface Scanner { stop(): void }

/** Open the rear camera inline and read one QR code; null when it cannot start. */
function startScanner(host: HTMLElement, onText: (text: string) => void, onFail: () => void): Scanner {
  const g = globalThis as unknown as {
    BarcodeDetector: DetectorCtor
    navigator: { mediaDevices: { getUserMedia(c: unknown): Promise<{ getTracks(): Array<{ stop(): void }> }> } }
  }
  let stopped = false
  let stream: { getTracks(): Array<{ stop(): void }> } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const video = el('video', '')
  attr(video, { playsinline: 'true', muted: 'true', autoplay: 'true', 'aria-label': COPY.pair.scan })
  host.replaceChildren(video)
  host.hidden = false
  const stop = (): void => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    for (const t of stream?.getTracks() ?? []) t.stop()
    stream = null
    host.replaceChildren()
    host.hidden = true
  }
  let detector: Detector
  try {
    detector = new g.BarcodeDetector({ formats: ['qr_code'] })
  } catch {
    stop()
    onFail()
    return { stop }
  }
  g.navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then(async (s) => {
    if (stopped) {
      for (const t of s.getTracks()) t.stop()
      return
    }
    stream = s
    ;(video as unknown as { srcObject: unknown }).srcObject = s
    try { await video.play() } catch { /* autoplay attribute covers it */ }
    const look = async (): Promise<void> => {
      if (stopped) return
      try {
        const found = await detector.detect(video)
        const raw = found.find((f) => typeof f.rawValue === 'string' && f.rawValue)?.rawValue
        if (raw) {
          stop()
          onText(raw)
          return
        }
      } catch { /* a frame that is not ready yet */ }
      timer = setTimeout(() => void look(), 250)
    }
    void look()
  }, () => {
    stop()
    onFail()
  })
  return { stop }
}

export function mountSetupFlow(root: HTMLElement, deps: SetupFlowDeps): SetupFlowHandle {
  ensureSetupStyles()
  const context = deps.context ?? 'first_run'
  const github = deps.github ?? { repos: githubRepos }
  const testKey = deps.testFactoryKey ?? defaultTestFactoryKey
  const shell = el('div', 'sf-root')
  root.replaceChildren(shell)

  let screen: SetupScreenId = 'welcome'
  let destroyed = false
  let teardown: Array<() => void> = []
  let history: SetupScreenId[] = []
  let bundle: PairingBundle | null = null
  let repoPath: RepoPath = 'paired'

  const saved = (): void => {
    try { deps.onSaved() } catch { /* the host's hot-apply must not break setup */ }
  }

  const clear = (): void => {
    for (const fn of teardown) {
      try { fn() } catch { /* teardown is best effort */ }
    }
    teardown = []
  }

  const mount = (id: SetupScreenId, node: HTMLElement): void => {
    screen = id
    shell.replaceChildren(node)
    try { (globalThis as { scrollTo?: (x: number, y: number) => void }).scrollTo?.(0, 0) } catch { /* no window */ }
  }

  /** Forward navigation remembers where Back returns to. */
  const go = (id: SetupScreenId, opts: { push?: boolean } = {}): void => {
    if (destroyed) return
    if (opts.push !== false && screen !== id) history.push(screen)
    clear()
    render(id)
  }
  const back = (): void => {
    if (destroyed) return
    const prev = history.pop()
    if (prev === undefined) {
      if (context === 'settings') {
        clear()
        deps.onDone()
        return
      }
      clear()
      render('welcome')
      return
    }
    clear()
    render(prev)
  }

  const hostLabel = (): string | null => bundle?.host.label || deps.prefs.pairedHost?.label || null
  /** Pairing found the computer's Spriite host (its address came over). */
  const hostLinked = (): boolean => Boolean(bundle ? bundle.host.brokerUrl : deps.prefs.pairedHost?.brokerUrl)

  const withSprite = (pose: Parameters<typeof sprite>[0], px: number): HTMLElement => {
    const s = sprite(pose, px)
    teardown.push(() => s.destroy())
    return s.el
  }

  // ---- Welcome (Main.dc.html) ----
  const renderWelcome = (): HTMLElement => {
    const W = COPY.welcome
    const option = (
      cls: string, tile: string, icon: IconName, title: Node, desc: string, onClick: () => void, id: string,
    ): HTMLButtonElement => button(cls, [
      el('div', tile, [iconEl(icon)]),
      el('div', 'sf-option-body', [title, el('span', 'sf-option-desc', [desc])]),
    ], onClick, { 'data-action': id })
    return el('div', 'sf-screen sf-screen--welcome', [
      el('div', 'sf-top', [
        el('div', 'sf-brand', [W.brand]),
      ]),
      el('div', 'sf-hero', [el('div', 'sf-circle sf-circle--168', [withSprite('idle', 4)])]),
      el('div', 'sf-copy', [
        el('h1', 'sf-h1 sf-h1--30', [W.title]),
        el('p', 'sf-lead sf-lead--16', [W.lead]),
      ]),
      el('div', 'sf-options', [
        option('sf-option sf-option--best', 'sf-icontile sf-icontile--accent', 'computer',
          el('div', 'sf-option-title-row', [
            el('span', 'sf-option-title', [W.pairTitle]),
            el('span', 'sf-badge', [W.pairBadge]),
          ]), W.pairDesc, () => go('pair'), 'pair'),
        option('sf-option', 'sf-icontile sf-icontile--factory', 'key',
          el('span', 'sf-option-title', [W.keyTitle]), W.keyDesc, () => {
            repoPath = 'key_only'
            go('repo')
          }, 'key_only'),
        option('sf-option', 'sf-icontile sf-icontile--cursor', 'phones',
          el('span', 'sf-option-title', [W.moveTitle]), W.moveDesc, () => go('move_receive'), 'move'),
      ]),
      el('div', 'sf-foot-note', [iconEl('lock'), el('span', '', [W.lock])]),
    ])
  }

  // ---- Shared code-entry screen (Pair.dc.html; the Move receiver reuses it) ----
  interface CodeScreenSpec {
    id: 'pair' | 'move_receive'
    step: 0 | 1
    title: string
    lead: string
    preamble: HTMLElement[]
    codeLabel: string
    entry: CodeEntry
    listening: string
    listeningSub: string
    connect: string
    incomplete: string
    secondary: HTMLElement | null
    /** Claim with the normalized code; resolves to an error message or null on success. */
    claim(code: string, signal: AbortSignal, qrSecret: string | null): Promise<string | null>
    /** A scanned QR's text -> code + secret, or a message when it is not ours. */
    fromQr(text: string): { code: string; secret: string | null } | string
  }

  const renderCodeScreen = (spec: CodeScreenSpec): HTMLElement => {
    const P = COPY.pair
    let busy = false
    let qrSecret: string | null = null
    let ctrl: AbortController | null = null
    let scanner: Scanner | null = null
    const error = el('p', 'sf-error')
    error.hidden = true
    attr(error, { role: 'alert', 'aria-live': 'polite' })
    const note = el('p', 'sf-note')
    note.hidden = true
    const scanHost = el('div', 'sf-scan')
    scanHost.hidden = true
    const setError = (msg: string): void => {
      error.textContent = msg
      error.hidden = msg === ''
    }
    const setNote = (msg: string): void => {
      note.textContent = msg
      note.hidden = msg === ''
    }
    const connectBtn = button('sf-primary', [spec.connect], () => void connect(), { 'data-action': 'connect' })
    const setBusy = (on: boolean): void => {
      busy = on
      connectBtn.disabled = on
      connectBtn.setAttribute('aria-busy', String(on))
      connectBtn.textContent = on ? P.connecting : spec.connect
      spec.entry.setDisabled(on)
    }
    const connect = async (): Promise<void> => {
      if (busy) return
      const code = spec.entry.code()
      if (!code) {
        setError(spec.incomplete)
        return
      }
      setError('')
      setBusy(true)
      ctrl = new AbortController()
      const mine = ctrl
      let message: string | null
      try {
        message = await spec.claim(code, mine.signal, qrSecret)
      } catch {
        message = spec.id === 'pair' ? PAIR_FAILURE.unreachable : TRANSFER_FAILURE.unreachable
      }
      if (destroyed || mine.signal.aborted || screen !== spec.id) return
      ctrl = null
      setBusy(false)
      if (message !== null) setError(message)
    }
    const scanBtn = button('sf-outline-btn', [iconEl('scan'), P.scan], () => {
      if (scanner) {
        scanner.stop()
        scanner = null
        scanBtn.replaceChildren(iconEl('scan'), P.scan)
        return
      }
      setNote('')
      if (!scannerAvailable()) {
        setNote(P.scanUnavailable)
        return
      }
      scanBtn.replaceChildren(iconEl('scan'), P.scanStop)
      scanner = startScanner(scanHost, (text) => {
        scanner = null
        scanBtn.replaceChildren(iconEl('scan'), P.scan)
        const got = spec.fromQr(text)
        if (typeof got === 'string') {
          setNote(got)
          return
        }
        qrSecret = got.secret
        if (spec.entry.fill(got.code)) void connect()
      }, () => {
        scanner = null
        scanBtn.replaceChildren(iconEl('scan'), P.scan)
        setNote(P.scanFailed)
      })
    }, { 'data-action': 'scan' })
    teardown.push(() => {
      ctrl?.abort()
      ctrl = null
      scanner?.stop()
      scanner = null
    })
    spec.entry.onSubmit(() => void connect())
    const firstId = spec.entry.inputs[0]?.getAttribute('id') ?? ''
    return el('div', 'sf-screen sf-screen--pair', [
      stepHeader(spec.step, back),
      el('div', 'sf-copy', [
        el('h1', 'sf-h1 sf-h1--28', [spec.title]),
        el('p', 'sf-lead sf-lead--15', [spec.lead]),
      ]),
      ...spec.preamble,
      el('div', 'sf-codecard', [
        attr(el('label', 'sf-label15', [spec.codeLabel]), { for: firstId }),
        spec.entry.el,
        error,
        scanBtn,
        scanHost,
        note,
      ]),
      el('div', 'sf-listen', [
        withSprite('listening', 2),
        el('div', 'sf-listen-text', [
          el('span', 'sf-listen-title', [spec.listening]),
          el('span', 'sf-listen-sub', [spec.listeningSub]),
        ]),
      ]),
      el('div', 'sf-actions sf-actions--10', [connectBtn, spec.secondary]),
    ])
  }

  // ---- Pair (Pair.dc.html) ----
  const renderPair = (): HTMLElement => {
    const P = COPY.pair
    const cmdText = el('span', 'sf-cmd-text', [P.command])
    const copyBtn = button('sf-cmd-copy', [iconEl('copy'), P.copy], () => {
      const done = (): void => {
        copyBtn.replaceChildren(iconEl('copy'), P.copied)
        const t = setTimeout(() => copyBtn.replaceChildren(iconEl('copy'), P.copy), 2000)
        ;(t as unknown as { unref?: () => void }).unref?.()
        teardown.push(() => clearTimeout(t))
      }
      const selectText = (): void => {
        try {
          const sel = globalThis.getSelection?.()
          const range = document.createRange?.()
          if (sel && range) {
            range.selectNodeContents(cmdText)
            sel.removeAllRanges()
            sel.addRange(range)
          }
        } catch { /* selection is a courtesy */ }
      }
      const clip = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } })
        .navigator?.clipboard
      if (clip?.writeText) clip.writeText(P.command).then(done, selectText)
      else selectText()
    }, { 'data-action': 'copy' })
    const entry = createCodeEntry({
      idPrefix: 'code',
      slots: [1, 2, 3, 4, 5, 6].map((n) => ({ kind: 'char' as const, max: 1, dashAfter: n === 3, label: `Code character ${n}` })),
      normalize: (t) => {
        const c = deps.pairing.normalizePairCode(t)
        return c && c.length === 6 ? c : null
      },
      split: (code) => code.split(''),
      join: (vals) => vals.join(''),
    })
    return renderCodeScreen({
      id: 'pair',
      step: 1,
      title: P.title,
      lead: P.lead,
      preamble: [
        el('div', 'sf-cmd', [cmdText, copyBtn]),
        el('div', 'sf-hint', [
          el('span', '', [P.noNode]),
          attr(el('a', '', [P.installer], { href: P.installerUrl }), { target: '_blank', rel: 'noopener noreferrer' }),
        ]),
      ],
      codeLabel: P.codeLabel,
      entry,
      listening: P.listening,
      listeningSub: P.listeningSub,
      connect: P.connect,
      incomplete: P.incomplete,
      secondary: button('sf-secondary', [P.keyOnly], () => {
        repoPath = 'key_only'
        go('repo')
      }, { 'data-action': 'key_only' }),
      claim: async (code, signal, qrSecret) => {
        const out = await deps.pairing.claimPairing(code, { signal, qrSecret })
        if (out.ok === false) return PAIR_FAILURE[out.reason] ?? PAIR_FAILURE.invalid
        bundle = out.bundle
        go('paired')
        return null
      },
      fromQr: (text) => {
        const parsed = deps.pairing.parsePairQr(text)
        const code = parsed ? deps.pairing.normalizePairCode(parsed.code) : null
        return parsed && code ? { code, secret: parsed.secret } : P.scanNotPair
      },
    })
  }

  // ---- Move receiver (undrawn; composed from Pair) ----
  const renderReceive = (): HTMLElement => {
    const R = COPY.receive
    const entry = createCodeEntry({
      idPrefix: 'move',
      slots: [
        { kind: 'word', max: 6, dashAfter: true, label: 'Code word 1' },
        { kind: 'num', max: 2, dashAfter: true, label: 'Code number' },
        { kind: 'word', max: 6, label: 'Code word 2' },
      ],
      normalize: (t) => deps.pairing.normalizeTransferCode(t),
      split: (code) => code.split('-'),
      join: (vals) => vals.join('-'),
    })
    return renderCodeScreen({
      id: 'move_receive',
      step: 0,
      title: R.title,
      lead: R.lead,
      preamble: [],
      codeLabel: R.codeLabel,
      entry,
      listening: R.listening,
      listeningSub: R.listeningSub,
      connect: R.connect,
      incomplete: R.incomplete,
      secondary: null,
      claim: async (code, signal, qrSecret) => {
        const out = await deps.pairing.receiveTransfer(code, { signal, qrSecret })
        if (out.ok === false) return TRANSFER_FAILURE[out.reason] ?? TRANSFER_FAILURE.invalid
        const applied = await deps.pairing.applyMoveBundle(out.bundle)
        saved()
        if (!applied.ok && applied.applied.length === 0) return R.applyFailed
        await deps.prefs.setSetupPath('moved')
        await deps.prefs.setSetupCompleted(Date.now())
        saved()
        history = []
        go('ready', { push: false })
        return null
      },
      fromQr: (text) => {
        // The client's own parser first (the QR it offers); the local reader
        // covers a typed code and older QR shapes.
        const parsed = deps.pairing.parseTransferQr?.(text) ?? null
        if (parsed) return { code: parsed.code, secret: parsed.secret }
        const code = deps.pairing.normalizeTransferCode(text) ?? qrTransferCode(text, deps.pairing)
        return code ? { code, secret: qrTransferSecret(text) } : R.scanNotMove
      },
    })
  }

  // ---- Paired (Paired.dc.html) ----
  const renderPaired = (): HTMLElement => {
    const P = COPY.paired
    const b = bundle
    if (!b) return renderPair()
    const label = b.host.label || 'your computer'
    const rows = reviewRows(b)
    // Builds run on the computer only through its Droid computer: without
    // one the choice is not offered (it would change labels, not routing).
    const canHost = Boolean(b.factory.computerId)
    let runOn: RunOn = canHost ? 'host' : 'cloud'
    let busy = false
    const error = attr(el('p', 'sf-error'), { role: 'alert' })
    error.hidden = true
    const opt = (value: RunOn, title: string, sub: string): HTMLButtonElement =>
      button('sf-runon-opt', [el('span', '', [title]), el('span', 'sf-runon-sub', [sub])], () => {
        if (value === 'host' && !canHost) return
        runOn = value
        paint()
      }, { role: 'radio', 'data-value': value })
    const host = opt('host', P.runHost(label), canHost ? P.runHostSub : P.runHostNone)
    if (!canHost) {
      host.disabled = true
      host.setAttribute('aria-disabled', 'true')
    }
    const cloud = opt('cloud', P.runCloud, P.runCloudSub(label))
    const paint = (): void => {
      host.setAttribute('aria-checked', String(runOn === 'host'))
      cloud.setAttribute('aria-checked', String(runOn === 'cloud'))
    }
    paint()
    const confirm = button('sf-primary', [P.confirm], async () => {
      if (busy) return
      busy = true
      confirm.disabled = true
      confirm.setAttribute('aria-busy', 'true')
      confirm.textContent = P.saving
      error.hidden = true
      let result: { ok: boolean; applied: string[]; failed: string[] }
      try {
        result = await deps.pairing.applyPairingBundle(b, { runOn })
      } catch {
        result = { ok: false, applied: [], failed: ['all'] }
      }
      if (destroyed || screen !== 'paired') return
      saved()
      busy = false
      confirm.disabled = false
      confirm.setAttribute('aria-busy', 'false')
      confirm.textContent = P.confirm
      if (!result.ok && result.applied.length === 0) {
        error.textContent = P.saveFailed
        error.hidden = false
        return
      }
      if (context === 'settings') {
        clear()
        deps.onDone()
        return
      }
      repoPath = 'paired'
      go('repo')
    }, { 'data-action': 'confirm' })
    return el('div', 'sf-screen sf-screen--paired', [
      stepHeader(2, back),
      el('div', 'sf-paired-head', [
        el('div', 'sf-circle sf-circle--72', [withSprite('celebrate', 2)]),
        el('div', 'sf-paired-title', [
          el('h1', 'sf-h1 sf-h1--26', [P.title(label)]),
          el('span', 'sf-sub14', [P.sub]),
        ]),
      ]),
      el('div', 'sf-list sf-list--18', rows.map((r) => el('div', 'sf-review-row', [
        el('div', `sf-mono-tile sf-tint--${r.tint}`, [r.mono]),
        el('div', 'sf-row-body', [
          el('span', 'sf-row-name', [r.name]),
          el('span', 'sf-row-detail', [r.detail]),
        ]),
        r.ok
          ? el('span', 'sf-found', [iconEl('check'), P.found])
          : el('span', 'sf-later', [P.later]),
      ]))),
      el('div', 'sf-runon', [
        el('span', 'sf-label15', [P.runTitle]),
        attr(el('div', 'sf-runon-grid', [host, cloud]), { role: 'radiogroup', 'aria-label': P.runGroup }),
      ]),
      el('div', 'sf-actions sf-actions--6', [
        error,
        confirm,
        el('span', 'sf-footnote', [P.footnote]),
      ]),
    ])
  }

  // ---- Repo (Repo.dc.html, both variants) ----
  const renderRepo = (): HTMLElement => {
    const R = COPY.repo
    const keyOnly = repoPath === 'key_only'
    const needsKey = keyOnly || !deps.keys.factory
    let busy = false
    const initialMode: RepoMode = deps.prefs.setupCompletedAt > 0 ? deps.keys.repoMode : 'per_idea'
    const picker = createRepoPicker({
      githubToken: () => deps.keys.github,
      githubHost: deps.githubHost ?? null,
      github,
      initialMode,
      initialUrl: deps.keys.repoUrl,
      onChange: () => setError(''),
    })
    teardown.push(() => picker.destroy())
    const error = attr(el('p', 'sf-error'), { role: 'alert' })
    error.hidden = true
    const setError = (msg: string): void => {
      error.textContent = msg
      error.hidden = msg === ''
    }
    const keyInput = el('input', 'sf-input')
    attr(keyInput, {
      id: 'fkey', type: 'password', placeholder: R.keyPlaceholder, autocomplete: 'off',
      autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
    })
    keyInput.value = ''
    const finish = button('sf-primary', [R.finish], () => void doFinish(), { 'data-action': 'finish' })
    const paintFinish = (): void => {
      finish.disabled = busy || (needsKey && keyInput.value.trim() === '')
    }
    keyInput.addEventListener('input', () => {
      setError('')
      paintFinish()
    })
    const paste = button('sf-paste', [R.paste], () => {
      const clip = (globalThis as { navigator?: { clipboard?: { readText?: () => Promise<string> } } }).navigator?.clipboard
      if (!clip?.readText) {
        keyInput.focus()
        return
      }
      clip.readText().then((t) => {
        if (destroyed) return
        keyInput.value = String(t ?? '').trim()
        setError('')
        paintFinish()
      }, () => keyInput.focus())
    }, { 'data-action': 'paste' })
    const keyBlock = needsKey ? el('div', 'sf-keyblock', [
      attr(el('label', 'sf-label15', [R.keyLabel]), { for: 'fkey' }),
      el('div', 'sf-keyrow', [keyInput, paste]),
      attr(el('a', 'sf-keylink', [R.keyLink], { href: R.keyUrl }), { target: '_blank', rel: 'noopener noreferrer' }),
    ]) : null

    const doFinish = async (): Promise<void> => {
      if (busy) return
      const key = keyInput.value.trim()
      if (needsKey && !key) return
      if (picker.mode() === 'one' && !picker.url()) {
        setError(R.pickRepo)
        return
      }
      busy = true
      paintFinish()
      finish.setAttribute('aria-busy', 'true')
      finish.textContent = needsKey ? R.finishing : R.finish
      setError('')
      const stop = (msg: string): void => {
        busy = false
        finish.setAttribute('aria-busy', 'false')
        finish.textContent = R.finish
        paintFinish()
        setError(msg)
      }
      if (needsKey) {
        let check: { ok: true } | { ok: false; message: string }
        try {
          check = await testKey(key)
        } catch {
          check = { ok: false, message: R.keyRejected }
        }
        if (destroyed || screen !== 'repo') return
        if (check.ok === false) {
          stop(check.message || R.keyRejected)
          return
        }
        if (!(await deps.keys.setFactory(key))) {
          stop(R.saveFailed)
          return
        }
        saved()
        if (keyOnly) {
          await deps.prefs.setRunOn('cloud')
          await deps.prefs.setSetupPath('key_only' satisfies SetupPath)
          saved()
        }
      }
      const mode = picker.mode()
      const url = picker.url()
      await deps.keys.setRepoMode(mode)
      if (mode === 'one' && url) await deps.keys.setRepoUrl(url)
      saved()
      const done = await deps.prefs.setSetupCompleted(Date.now())
      if (destroyed || screen !== 'repo') return
      if (!done) {
        stop(R.saveFailed)
        return
      }
      saved()
      history = []
      go('ready', { push: false })
    }
    paintFinish()

    return el('div', 'sf-screen sf-screen--repo', [
      stepHeader(3, back),
      keyBlock,
      el('div', 'sf-copy', [
        el('h1', 'sf-h1 sf-h1--28', [R.title]),
        el('p', 'sf-lead sf-lead--15', [R.lead]),
      ]),
      picker.radios,
      picker.search,
      el('div', 'sf-actions sf-actions--6', [error, finish]),
    ])
  }

  // ---- Ready (Ready.dc.html) ----
  const renderReady = (): HTMLElement => {
    const R = COPY.ready
    const label = hostLabel()
    const extras: Array<{ kind: 'voice' | 'x' | 'cursor'; name: string; detail: string; cta: string; done: () => boolean; doneText: string }> = [
      { kind: 'voice', name: R.voice, detail: R.voiceDesc, cta: R.addKey, done: () => deps.keys.elevenLabs !== '', doneText: R.added },
      // "Sign-in opens on <computer>" only when that computer's host link
      // came over (the sign-in runs there); otherwise "your computer".
      { kind: 'x', name: R.x, detail: R.xDesc(hostLinked() ? label : null), cta: R.connect, done: () => deps.keys.x !== '' || deps.prefs.xHostReader, doneText: R.connected },
      { kind: 'cursor', name: R.cursor, detail: R.cursorDesc, cta: R.addKey, done: () => deps.keys.cursor !== '', doneText: R.added },
    ]
    const list = el('div', 'sf-list sf-list--16')
    const note = attr(el('p', 'sf-note'), { role: 'status', 'aria-live': 'polite' })
    note.hidden = true
    const showNote = (n: void | ExtraNote): void => {
      if (!n || !n.text) return
      note.textContent = n.text
      note.className = n.tone === 'err' ? 'sf-error' : 'sf-note'
      note.hidden = false
    }
    const rejected = (kind: 'voice' | 'x' | 'cursor'): boolean =>
      kind !== 'x' && deps.extraHealth?.(kind) === 'failed'
    const paint = (): void => {
      list.replaceChildren(...extras.map((x) => el('div', 'sf-extra-row', [
        el('div', 'sf-row-body', [
          el('span', 'sf-row-name', [x.name]),
          el('span', 'sf-row-detail', [x.detail]),
        ]),
        x.done() && !rejected(x.kind)
          ? attr(el('span', 'sf-found', [iconEl('check'), x.doneText]), { 'data-extra': x.kind })
          : button('sf-extra-cta', [x.done() ? R.checkKey : x.cta], () => {
            let ret: void | ExtraNote | Promise<void | ExtraNote>
            try { ret = deps.onExtra(x.kind) } catch { ret = undefined }
            Promise.resolve(ret).then((n) => {
              if (destroyed || screen !== 'ready') return
              paint()
              showNote(n)
            }, () => {
              if (!destroyed && screen === 'ready') paint()
            })
          }, { 'data-extra': x.kind }),
      ])))
    }
    paint()
    const onFocus = (): void => { if (!destroyed && screen === 'ready') paint() }
    const win = globalThis as { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void }
    win.addEventListener?.('focus', onFocus)
    teardown.push(() => win.removeEventListener?.('focus', onFocus))
    return el('div', 'sf-screen sf-screen--ready', [
      el('div', 'sf-ready-top', [
        el('div', 'sf-circle sf-circle--176', [withSprite('celebrate', 4)]),
        el('div', 'sf-copy', [
          el('h1', 'sf-h1 sf-h1--30', [R.title]),
          el('p', 'sf-lead sf-lead--16', [R.lead]),
        ]),
      ]),
      el('div', 'sf-extras', [el('span', 'sf-eyebrow', [R.extras]), list, note]),
      el('div', 'sf-actions sf-actions--6', [
        button('sf-primary', [R.open], () => {
          clear()
          deps.onDone()
        }, { 'data-action': 'open' }),
      ]),
    ])
  }

  const render = (id: SetupScreenId): void => {
    const node = id === 'welcome' ? renderWelcome()
      : id === 'pair' ? renderPair()
        : id === 'paired' ? (bundle ? renderPaired() : renderPair())
          : id === 'repo' ? renderRepo()
            : id === 'ready' ? renderReady()
              : renderReceive()
    const shown: SetupScreenId = id === 'paired' && !bundle ? 'pair' : id
    mount(shown, node)
  }

  const show = (entry: SetupEntry): void => {
    if (destroyed) return
    clear()
    history = []
    if (entry === 'key_only') {
      repoPath = 'key_only'
      render('repo')
    } else if (entry === 'pair') render('pair')
    else if (entry === 'move_receive') render('move_receive')
    else render('welcome')
  }

  show(deps.entry ?? (context === 'settings' ? 'pair' : 'welcome'))

  return {
    get screen() { return screen },
    show,
    destroy: () => {
      if (destroyed) return
      clear()
      destroyed = true
      root.replaceChildren()
    },
  }
}

/** The six Paired review rows, honest about what the bundle carried. */
export interface ReviewRow { mono: string; tint: 'factory' | 'accent' | 'text' | 'amber'; name: string; detail: string; ok: boolean }

export function reviewRows(b: PairingBundle): ReviewRow[] {
  const R = COPY.rows
  const label = b.host.label || 'your computer'
  const hostOk = b.host.via !== 'none' && Boolean(b.host.brokerUrl) && Boolean(b.broker.bearerToken)
  return [
    { mono: 'F', tint: 'factory', name: R.factory, ok: Boolean(b.factory.apiKey),
      detail: b.factory.apiKey ? R.factoryOk(label) : R.factoryMissing },
    { mono: 'D', tint: 'factory', name: R.computer, ok: Boolean(b.factory.computerId),
      detail: b.factory.computerId ? R.computerOk(b.factory.computerName || label, b.factory.computerOnline) : R.computerMissing },
    { mono: 'S', tint: 'accent', name: R.host, ok: hostOk,
      detail: !hostOk ? R.hostMissing : b.host.via === 'tailscale' ? R.hostTailscale : R.hostHttps },
    { mono: 'G', tint: 'text', name: R.github, ok: Boolean(b.github.token),
      detail: b.github.token ? R.githubOk(b.github.repoCount) : R.githubMissing },
    { mono: 'V', tint: 'amber', name: R.voice, ok: Boolean(b.voice.elevenLabsKey),
      detail: b.voice.elevenLabsKey ? R.voiceOk : R.voiceMissing },
    { mono: 'X', tint: 'text', name: R.x, ok: Boolean(b.x.accessToken && b.x.refreshToken && b.x.clientId),
      detail: b.x.accessToken && b.x.refreshToken && b.x.clientId ? R.xOk : R.xLater },
  ]
}

/** A transfer QR (`spriite:move?c=<code>&s=<secret>&r=<relay>`) carries the code plus a secret. */
function qrTransferCode(text: string, pairing: PairingClient): string | null {
  try {
    const url = new URL(text)
    const c = url.searchParams.get('c') ?? url.searchParams.get('code') ?? url.hash.replace(/^#/, '').split('&').find((p) => p.startsWith('code='))?.slice(5)
    return c ? pairing.normalizeTransferCode(decodeURIComponent(c)) : null
  } catch {
    try {
      const obj = JSON.parse(text) as { code?: unknown }
      return typeof obj.code === 'string' ? pairing.normalizeTransferCode(obj.code) : null
    } catch {
      return null
    }
  }
}

function qrTransferSecret(text: string): string | null {
  try {
    const url = new URL(text)
    const fromQuery = url.searchParams.get('secret') ?? url.searchParams.get('s')
    if (fromQuery) return fromQuery
    const frag = url.hash.replace(/^#/, '').split('&').find((p) => p.startsWith('secret=') || p.startsWith('s='))
    return frag ? decodeURIComponent(frag.split('=')[1] ?? '') || null : null
  } catch {
    try {
      const obj = JSON.parse(text) as { secret?: unknown }
      return typeof obj.secret === 'string' ? obj.secret : null
    } catch {
      return null
    }
  }
}
