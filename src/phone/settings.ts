/**
 * Settings (docs/design/redesign/Settings.dc.html): Connections with live
 * health, How builds run, Your setup, and Advanced. Every row opens a sheet
 * hosting the existing per-account form from src/setup/panel.ts (Save and
 * test, Remove, masked hints), the X panel (host sign-in first), the repo
 * chooser, the archive panel, or a full-screen flow (Move, Pair).
 */
import type { KeyVault } from '../voice/keys'
import type { PrefsVault } from '../state/prefs'
import type { XConnection } from '../intake/connection'
import type { ArchiveClient } from '../state/archive'
import type { NativeCapabilities, NativeLaunchProfile } from '../native/protocol'
import type { HostXSignInState, PairingClient } from '../pair/types'
import { FLAG_LABELS, FLAG_NAMES, type FlagName } from '../state/flags'
import { factoryComputers } from '../factory/fapi'
import { mountSetupPanel, type AccountHealth, type SetupHandle } from '../setup/panel'
import type { GitHubHost } from '../factory/github-host'
import type { mountMoveScreen, mountRepoChooser, mountSetupFlow } from '../setup/flow/index'
import { createSheet, type Sheet } from './sheet'
import { icon } from './icons'

export type SettingsSheetId =
  | 'factory' | 'host' | 'github' | 'voice' | 'x' | 'cursor'
  | 'where' | 'workers' | 'pr' | 'models' | 'archive'

/** The three Advanced sections, labelled exactly as the board draws them. */
export const ADVANCED_LABELS = [
  'Factory-native details (models per job, tools, acceptance checks)',
  'Relay and host addresses',
  'Durable runtime and developer flags',
] as const

export interface SettingsContext {
  keys: KeyVault
  prefs: PrefsVault
  pairing: PairingClient
  xConnection?: XConnection | null
  archive?: ArchiveClient | null
  nativeCapabilities?: (profile: NativeLaunchProfile) => NativeCapabilities | null
  onSaved: () => void
  /** Where sheets mount (inside the phone root, after the screens). */
  sheetHost: HTMLElement
  /** Where full-screen flows mount (Move, Pair a different computer). */
  fullHost: HTMLElement
  /** The Factory-native launch form (mountNativePhone's launch root). */
  nativeLaunch: HTMLElement
  /** The activity log card (feed), shown under the developer flags. */
  activityLog: HTMLElement
  repoChooser: typeof mountRepoChooser
  moveScreen: typeof mountMoveScreen
  setupFlow: typeof mountSetupFlow
  /** The setup panel's readiness count (the old Setup badge). */
  onReadiness?: (missing: number) => void
  /** The paired host's GitHub sign-in (HOST-GITHUB-PLAN); absent, the token alone. */
  githubHost?: GitHubHost | null
}

export interface SettingsHandle {
  readonly el: HTMLElement
  readonly setup: SetupHandle
  /** Redraw values and health from what is known now (no network). */
  refresh(): void
  /** Re-test what can be tested (Factory key, host sign-in); throttled. */
  checkHealth(force?: boolean): void
  /**
   * Open one sheet. `over: 'flow'` stacks it above the setup flow (Ready's
   * optional extras); `onClose` runs once when that sheet closes.
   */
  open(id: SettingsSheetId, opts?: { over?: 'flow'; onClose?: () => void }): void
  /** Expand Advanced and the named section. */
  openAdvanced(section: 0 | 1 | 2): void
  closeAll(): void
  refreshPrefs(): void
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props)
  for (const c of children) node.append(c)
  return node
}

/** `owner/name` from a GitHub URL; anything else as given. */
export const repoLabel = (url: string | undefined): string => {
  const raw = String(url ?? '').trim()
  const m = /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(raw)
  return m ? m[1] : raw
}

/** What the next build freezes, in one line (the old Options row). */
export function optionsSummary(p: PrefsVault): string {
  const model = (m: string) => m || 'account model'
  const effort = (e: string) => (e ? ` (${e})` : '')
  const parts = [
    p.interactionMode === 'spec' ? 'Plan first' : p.interactionMode === 'auto' ? 'Normal mode' : 'Factory default mode',
    `lead ${model(p.leadModel)}${effort(p.leadReasoningEffort)}`,
    `workers ${model(p.workerModel)}${effort(p.workerReasoningEffort)}`,
  ]
  const tools = p.workerEnabledTools.length + p.workerDisabledTools.length + p.workerRestrictTools.length
  if (p.workerInstructions) parts.push('your instructions')
  if (tools > 0) parts.push(`${tools} tool${tools === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

/** The Models row's value: "Factory default" until a model is chosen. */
export function modelsValue(p: PrefsVault): string {
  const parts = [
    p.leadModel ? `Lead ${p.leadModel}` : '',
    p.workerModel ? `Workers ${p.workerModel}` : '',
    p.interactionMode === 'spec' && p.specModel ? `Plan ${p.specModel}` : '',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : 'Factory default'
}

type StateTone = 'ok' | 'off' | 'err'
interface Health { state: string; tone: StateTone }

const accountState = (h: AccountHealth, okWord: string, failWord: string): Health =>
  h === 'off' ? { state: 'Off', tone: 'off' }
    : h === 'failed' ? { state: failWord, tone: 'err' }
      : h === 'no_computer' ? { state: 'No computer', tone: 'err' }
        // Saved but never tested on this visit: honest, not "Working".
        : h === 'saved' ? { state: 'Saved', tone: 'off' }
          : { state: okWord, tone: 'ok' }

export function mountSettings(root: HTMLElement, ctx: SettingsContext): SettingsHandle {
  const { keys, prefs } = ctx
  const hostLabel = (): string | null => prefs.pairedHost?.label?.trim() || null
  /** The paired computer's name only when pairing found its Spriite host: X sign-in runs there, nowhere else. */
  const linkedHostLabel = (): string | null => (prefs.pairedHost?.brokerUrl ? hostLabel() : null)

  // The existing per-account forms, built as sheet bodies (panel.ts 'sheets').
  const panelHost = el('div')
  const sheetsById = new Map<SettingsSheetId, Sheet>()
  let refreshAll = (): void => {}
  const githubHost = ctx.githubHost ?? null
  /** The host's label while it provides GitHub (as last known; no network). */
  const githubThrough = (): string | null => githubHost?.known() === true ? githubHost.label() : null
  const setup = mountSetupPanel(panelHost, keys, prefs, {
    layout: 'sheets',
    githubHost,
    onSaved: () => ctx.onSaved(),
    xConnection: ctx.xConnection,
    archive: ctx.archive ?? null,
    hostXSignIn: ctx.pairing.hostXSignIn,
    // The X sheet's "Sign in on <computer>": only a linked host can run it.
    hostLabel: linkedHostLabel,
    onReadiness: (n) => ctx.onReadiness?.(n),
    onChange: () => refreshAll(),
    onOpenRuntime: () => {
      closeAll()
      openAdvanced(2)
    },
  })

  // A sheet opened over the setup flow: its close hands the owner back to Ready.
  let pendingClose: { id: SettingsSheetId; run: () => void } | null = null
  const sheetClosed = (id: SettingsSheetId): void => {
    const s = sheetsById.get(id)
    s?.el.classList.remove('ph-overlay--over-flow')
    if (pendingClose?.id !== id) return
    const run = pendingClose.run
    pendingClose = null
    run()
  }
  const sheet = (id: SettingsSheetId, label: string, content: HTMLElement[], onOpen?: () => void): Sheet => {
    const s = createSheet(ctx.sheetHost, { id: `ph-sheet-${id}`, label, onOpen, onClose: () => sheetClosed(id) })
    s.body.append(...content)
    sheetsById.set(id, s)
    return s
  }
  const closeAll = (): void => { for (const s of sheetsById.values()) s.close() }
  const open = (id: SettingsSheetId, opts?: { over?: 'flow'; onClose?: () => void }): void => {
    closeAll()
    const s = sheetsById.get(id)
    if (!s) {
      opts?.onClose?.()
      return
    }
    if (opts?.over === 'flow') s.el.classList.add('ph-overlay--over-flow')
    if (opts?.onClose) pendingClose = { id, run: opts.onClose }
    s.open()
  }

  // --------------------------------------------------------- health
  let factoryLive: { key: string; result: 'ok' | 'failed' | 'no_computer'; at: number } | null = null
  let factoryChecking = false
  let xSignIn: HostXSignInState | null = null
  let lastCheck = 0

  const factoryHealth = (): Health => {
    const h = setup.health().factory
    if (h === 'off') return { state: 'Off', tone: 'off' }
    if (h !== 'saved') return accountState(h, 'Working', 'Check key')
    if (factoryLive && factoryLive.key === keys.factory) {
      return factoryLive.result === 'ok' ? { state: 'Working', tone: 'ok' }
        : factoryLive.result === 'no_computer' ? { state: 'No computer', tone: 'err' }
          : { state: 'Not working', tone: 'err' }
    }
    return { state: factoryChecking ? 'Checking' : 'Saved', tone: 'off' }
  }
  const hostHealth = (): Health => {
    if (!prefs.pairedHost) return factoryHealth().tone === 'ok' ? { state: 'Working', tone: 'ok' } : { state: 'Off', tone: 'off' }
    const profile = prefs.nativeLaunchProfile
    if (!profile.brokerUrl || !keys.nativeBrokerFor(profile.brokerUrl)) return { state: 'Not linked', tone: 'err' }
    if (!ctx.nativeCapabilities) return { state: 'Paired', tone: 'off' }
    const caps = ctx.nativeCapabilities(profile)
    return caps ? { state: 'Online', tone: 'ok' } : { state: 'Checking', tone: 'off' }
  }
  const xHealth = (): Health => {
    if (xSignIn?.state === 'connected') return { state: 'Working', tone: 'ok' }
    if (xSignIn?.state === 'pending') return { state: 'Signing in', tone: 'off' }
    if (xSignIn?.state === 'failed') return { state: 'Failed', tone: 'err' }
    if (ctx.xConnection?.active || prefs.xHostReader) return { state: 'Working', tone: 'ok' }
    return { state: 'Off', tone: 'off' }
  }
  const voiceHealth = (): Health => {
    const h = setup.health().voice
    if (h !== 'off' && !prefs.spokenReplies) return { state: 'Off', tone: 'off' }
    return accountState(h, 'Working', 'Check key')
  }

  const checkHealth = (force = false): void => {
    const now = Date.now()
    if (!force && now - lastCheck < 60_000) return
    lastCheck = now
    const key = keys.factory
    if (key && setup.health().factory === 'saved' && !factoryChecking) {
      factoryChecking = true
      void factoryComputers(key).then((computers) => {
        factoryLive = { key, result: computers.some((c) => c.status === 'active') ? 'ok' : 'no_computer', at: Date.now() }
      }, () => {
        factoryLive = { key, result: 'failed', at: Date.now() }
      }).finally(() => {
        // The sheet's pill tells the same story as the row.
        if (factoryLive?.key === keys.factory) setup.noteLive('factory', factoryLive.result)
        factoryChecking = false
        refreshAll()
      })
    }
    if (ctx.pairing.hostXSignIn.available()) {
      void ctx.pairing.hostXSignIn.status().then((s) => { xSignIn = s; refreshAll() }, () => {})
    }
    refreshAll()
  }

  // ---------------------------------------------------- connections
  const stateNode = (): HTMLSpanElement => el('span', { className: 'ph-state' }, [el('i'), el('span')])
  const setState = (node: HTMLSpanElement, h: Health): void => {
    node.className = `ph-state ${h.tone}`
    ;(node.children[1] as HTMLElement).textContent = h.state
  }
  interface ConnRow { id: SettingsSheetId; mono: () => string; tint: string; name: () => string; detail: () => string; health: () => Health }
  const conns: ConnRow[] = [
    { id: 'factory', mono: () => 'F', tint: 'var(--sp-factory)', name: () => 'Factory', detail: () => 'Account and Droid computer', health: factoryHealth },
    {
      id: 'host', mono: () => (hostLabel() ?? 'Factory cloud').charAt(0).toUpperCase(), tint: 'var(--sp-accent)',
      name: () => hostLabel() ?? 'Factory cloud',
      detail: () => prefs.pairedHost ? (prefs.runOn === 'host' ? 'Builds run here' : 'Factory cloud') : 'Builds run in Factory’s cloud',
      health: hostHealth,
    },
    // The host's own sign-in carries GitHub when it provides it; the board has
    // no such state (docs/design/deviations/phone.md).
    {
      id: 'github', mono: () => 'G', tint: 'var(--sp-text)', name: () => 'GitHub',
      detail: () => { const through = githubThrough(); return through ? `Through ${through}` : 'Can create and push repos' },
      health: () => githubThrough() ? { state: 'Working', tone: 'ok' } : accountState(setup.health().github, 'Working', 'Check token'),
    },
    { id: 'voice', mono: () => 'V', tint: 'var(--sp-amber)', name: () => 'Spoken replies', detail: () => 'ElevenLabs', health: voiceHealth },
    { id: 'x', mono: () => 'X', tint: 'var(--sp-text)', name: () => 'X requests', detail: () => `Read on ${hostLabel() ?? 'this phone'}`, health: xHealth },
    { id: 'cursor', mono: () => 'C', tint: 'var(--sp-cursor)', name: () => 'Cursor', detail: () => 'Extra workers', health: () => accountState(setup.health().cursor, 'Working', 'Check key') },
  ]
  const connRows = conns.map((c) => {
    const mono = el('span', { className: 'ph-mono' })
    mono.style.color = c.tint
    const name = el('span', { className: 'ph-conn-name' })
    const detail = el('span', { className: 'ph-conn-detail' })
    const state = stateNode()
    const row = el('button', { className: 'ph-conn', type: 'button', id: `ph-conn-${c.id}` }, [
      mono, el('span', { className: 'ph-conn-text' }, [name, detail]), state,
    ])
    row.onclick = () => open(c.id)
    return { c, row, mono, name, detail, state }
  })

  // --------------------------------------------------- how builds run
  interface PrefRow { id: SettingsSheetId; name: string; value: () => string }
  const prefRowsDef: PrefRow[] = [
    { id: 'where', name: 'Where builds go', value: () => keys.repoMode === 'per_idea' ? 'New repo per idea' : keys.repoUrl ? repoLabel(keys.repoUrl) : 'Not chosen' },
    { id: 'workers', name: 'Workers for big tasks', value: () => `Up to ${prefs.jobs}` },
    { id: 'pr', name: 'Pull requests', value: () => prefs.askBeforePr ? 'Ask me first' : 'Open automatically' },
    { id: 'models', name: 'Models', value: () => modelsValue(prefs) },
  ]
  const prefRows = prefRowsDef.map((p) => {
    const value = el('span')
    const row = el('button', { className: 'ph-pref', type: 'button', id: `ph-pref-${p.id}` }, [
      el('span', { className: 'ph-pref-name', textContent: p.name }),
      el('span', { className: 'ph-pref-value' }, [value, icon('chevron')]),
    ])
    row.onclick = () => open(p.id)
    return { p, row, value }
  })

  // ------------------------------------------------------- your setup
  const moveRow = el('button', { className: 'ph-setup-row', type: 'button', id: 'ph-setup-move' }, [
    el('span', { className: 'ph-setup-text' }, [
      el('span', { className: 'ph-conn-name', textContent: 'Move to another phone' }),
      el('span', { className: 'ph-conn-detail', textContent: 'Keys, defaults and build history, one code' }),
    ]),
    icon('chevronMuted'),
  ])
  const backup = el('input', { type: 'checkbox', id: 'backup' })
  backup.setAttribute('aria-label', 'Back up build history')
  const backupText = el('button', { className: 'ph-setup-text', type: 'button', id: 'ph-setup-backup' }, [
    el('span', { className: 'ph-conn-name', textContent: 'Back up build history' }),
    el('span', { className: 'ph-conn-detail', textContent: 'Encrypted, to your relay' }),
  ])
  const backupRow = el('div', { className: 'ph-setup-row' }, [backupText, backup])
  const pairRow = el('button', { className: 'ph-setup-row', type: 'button', id: 'ph-setup-pair' }, [
    el('span', { className: 'ph-setup-text' }, [
      el('span', { className: 'ph-conn-name', textContent: 'Pair a different computer' }),
      el('span', { className: 'ph-conn-detail', textContent: 'Run npx spriite pair there' }),
    ]),
    icon('chevronMuted'),
  ])
  let backupWriting = false
  backup.onchange = async () => {
    const on = backup.checked
    backupWriting = true
    const ok = await prefs.setFlag('archive_mirror', on)
    backupWriting = false
    ctx.onSaved()
    setup.refreshPrefs()
    if (!ok) backup.checked = prefs.flags.archive_mirror
    refreshAll()
  }
  backupText.onclick = () => open('archive')

  // Full-screen flows (Move, Pair) mount over everything and leave on Back/Done.
  let full: { destroy(): void } | null = null
  const closeFull = (): void => {
    full?.destroy()
    full = null
    ctx.fullHost.replaceChildren()
    ctx.fullHost.hidden = true
    refreshAll()
  }
  const openFull = (mount: (host: HTMLElement) => { destroy(): void }): void => {
    closeAll()
    if (full) closeFull()
    const host = el('div', { className: 'sp-flow' })
    ctx.fullHost.replaceChildren(host)
    ctx.fullHost.hidden = false
    try {
      full = mount(host)
    } catch {
      closeFull()
    }
  }
  moveRow.onclick = () => openFull((host) => ctx.moveScreen(host, {
    pairing: ctx.pairing, hostLabel, onBack: closeFull,
  }))
  const openPair = (): void => openFull((host) => ctx.setupFlow(host, {
    keys, prefs, pairing: ctx.pairing, context: 'settings', entry: 'pair', githubHost,
    onExtra: () => {}, onSaved: () => { ctx.onSaved(); setup.refreshPrefs() },
    onDone: closeFull,
  }))
  pairRow.onclick = openPair

  // --------------------------------------------------------- advanced
  const relayBase = ((import.meta as { env?: { VITE_SPRIITE_RELAY?: string } }).env?.VITE_SPRIITE_RELAY ?? '').replace(/\/+$/, '')
  const addresses = el('div', { className: 'stack', id: 'ph-addresses' })
  const kv = (label: string, value: string): HTMLElement =>
    el('div', { className: 'ph-kv' }, [el('b', { textContent: label }), el('span', { textContent: value || 'Not set' })])
  const renderAddresses = (): void => {
    const profile = prefs.nativeLaunchProfile
    const host = prefs.pairedHost
    addresses.replaceChildren(
      kv('Relay', relayBase || 'Not set in this build'),
      kv('Pairing relay', relayBase ? `${relayBase}/pair/v1` : '/api/pair/v1 (dev server)'),
      kv('Broker URL', profile.brokerUrl || host?.brokerUrl || ''),
      kv('Owner id', profile.ownerId || host?.ownerId || ''),
      kv('Machine id', profile.machineId || host?.machineId || ''),
      kv('Paired computer', host ? `${host.label} · ${host.os === 'macos' ? 'macOS' : 'Linux'} · ${host.via === 'none' ? 'no host link' : host.via}` : 'None'),
    )
  }
  const flagStatus = el('p', { className: 'msg muted', role: 'status' })
  const flagBoxes = new Map<FlagName, HTMLInputElement>()
  const flagRows = FLAG_NAMES.filter((n) => n !== 'persistent_runtime_v2').map((name) => {
    const box = el('input', { type: 'checkbox', id: `ph-flag-${name}` })
    flagBoxes.set(name, box)
    box.onchange = async () => {
      const ok = await prefs.setFlag(name, box.checked)
      flagStatus.className = `msg ${ok ? 'ok' : 'err'}`
      flagStatus.textContent = ok ? 'Saved.' : 'The change could not be saved on this phone. Try again.'
      ctx.onSaved()
      setup.refreshPrefs()
      refreshAll()
    }
    return el('div', { className: 'stack' }, [
      el('label', { className: 'check' }, [box, FLAG_LABELS[name].title]),
      el('p', { className: 'small muted', textContent: FLAG_LABELS[name].note }),
    ])
  })
  const reduceMotion = el('input', { type: 'checkbox', id: 'ph-reduce-motion' })
  reduceMotion.onchange = async () => {
    const ok = await prefs.setReduceMotion(reduceMotion.checked)
    flagStatus.className = `msg ${ok ? 'ok' : 'err'}`
    flagStatus.textContent = ok ? 'Saved.' : 'The change could not be saved on this phone. Try again.'
    ctx.onSaved()
    refreshAll()
  }
  const advSection = (label: string, content: HTMLElement[]): HTMLDetailsElement =>
    el('details', { className: 'ph-adv-section' }, [
      el('summary', { textContent: label }),
      el('div', { className: 'ph-adv-content' }, content),
    ])
  const advSections = [
    advSection(ADVANCED_LABELS[0], [ctx.nativeLaunch]),
    advSection(ADVANCED_LABELS[1], [addresses]),
    advSection(ADVANCED_LABELS[2], [
      setup.prefsParts.runtime,
      ...flagRows,
      el('label', { className: 'check' }, [reduceMotion, 'Reduce motion']),
      flagStatus,
      ctx.activityLog,
    ]),
  ]
  const advanced = el('details', { className: 'ph-advanced', id: 'ph-advanced' }, [
    el('summary', { textContent: 'Advanced' }),
    el('div', { className: 'ph-adv-body' }, advSections),
  ])
  const openAdvanced = (section: 0 | 1 | 2): void => {
    advanced.open = true
    advSections[section].open = true
    advSections[section].scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }

  // ------------------------------------------------------------ sheets
  const hostSheetBody = el('div', { className: 'stack' })
  const runHost = el('input', { type: 'radio', name: 'ph-run-on', value: 'host', id: 'ph-run-host' })
  const runCloud = el('input', { type: 'radio', name: 'ph-run-on', value: 'cloud', id: 'ph-run-cloud' })
  const runStatus = el('p', { className: 'msg muted', role: 'status' })
  const setRunOn = async (where: 'host' | 'cloud'): Promise<void> => {
    const ok = await prefs.setRunOn(where)
    runStatus.className = `msg ${ok ? 'ok' : 'err'}`
    runStatus.textContent = ok
      ? where === 'host' ? `New builds run on ${hostLabel() ?? 'your computer'}.` : 'New builds run in Factory’s cloud.'
      : 'The change could not be saved on this phone. Try again.'
    ctx.onSaved()
    refreshAll()
  }
  runHost.onchange = () => { if (runHost.checked) void setRunOn('host') }
  runCloud.onchange = () => { if (runCloud.checked) void setRunOn('cloud') }
  const hostPair = el('button', { className: 'btn secondary', type: 'button', textContent: 'Pair a different computer' })
  hostPair.onclick = openPair
  const renderHostSheet = (): void => {
    const host = prefs.pairedHost
    runHost.checked = Boolean(host) && prefs.runOn === 'host'
    runCloud.checked = !runHost.checked
    runHost.disabled = !host
    hostSheetBody.replaceChildren(
      el('div', { className: 'ph-sheet-head' }, [
        el('h2', { className: 'ph-sheet-title', textContent: host?.label ?? 'Factory cloud' }),
        el('span', { className: 'ph-sheet-role', textContent: host ? 'Your paired computer' : 'No computer is paired. Builds run in Factory’s cloud.' }),
      ]),
      ...(host ? [
        kv('Computer', `${host.label} · ${host.os === 'macos' ? 'macOS' : 'Linux'}`),
        kv('Reached through', host.via === 'tailscale' ? 'Tailscale' : host.via === 'https' ? 'HTTPS' : 'Not reachable from the phone'),
        kv('Paired', host.pairedAt > 0 ? new Date(host.pairedAt).toLocaleDateString() : ''),
      ] : []),
      el('b', { className: 'small', textContent: 'Where builds run' }),
      el('label', { className: 'check' }, [runHost, host ? `On ${host.label}` : 'On a paired computer']),
      el('label', { className: 'check' }, [runCloud, 'In Factory’s cloud']),
      runStatus,
      hostPair,
    )
  }
  const optionsLine = el('p', { className: 'small muted', id: 'new-build-options' })
  const renderOptionsLine = (): void => {
    optionsLine.replaceChildren(
      el('span', { className: 'eyebrow', textContent: 'Options' }),
      el('span', { textContent: ` ${optionsSummary(prefs)}. ` }),
      el('span', { textContent: 'Saved here. A build keeps what it started with.' }),
    )
  }
  const voiceToggle = el('input', { type: 'checkbox', id: 'ph-spoken-replies' })
  const voiceStatus = el('p', { className: 'msg muted', role: 'status' })
  voiceToggle.onchange = async () => {
    const ok = await prefs.setSpokenReplies(voiceToggle.checked)
    voiceStatus.className = `msg ${ok ? 'ok' : 'err'}`
    voiceStatus.textContent = ok
      ? voiceToggle.checked ? 'Replies are read aloud on this phone when an ElevenLabs key is saved.' : 'Replies stay silent.'
      : 'The change could not be saved on this phone. Try again.'
    ctx.onSaved()
    refreshAll()
  }
  const whereHost = el('div', { className: 'stack' })
  let chooser: { refresh(): void; destroy(): void } | null = null
  const whereBody = el('section', { className: 'ph-sheet-body stack', id: 'sec-where' }, [
    el('div', { className: 'ph-sheet-head' }, [
      el('h2', { className: 'ph-sheet-title', textContent: 'Where builds go' }),
      el('span', { className: 'ph-sheet-role', textContent: 'A new private repo per idea, or one repo for everything.' }),
    ]),
    whereHost,
  ])

  sheet('factory', 'Factory', [setup.sections.factory])
  sheet('host', 'Computer', [hostSheetBody], renderHostSheet)
  sheet('github', 'GitHub', [setup.sections.github])
  /** Controls a sheet adds to a panel section go under its head (title, role, pill), never above it. */
  const afterHead = (section: HTMLElement, nodes: HTMLElement[]): HTMLElement => {
    const ref = (section.children[1] as HTMLElement | undefined) ?? null
    for (const node of nodes) section.insertBefore(node, ref)
    return section
  }
  sheet('voice', 'Spoken replies', [
    afterHead(setup.sections.voice, [el('label', { className: 'check' }, [voiceToggle, 'Read replies aloud']), voiceStatus]),
  ])
  sheet('x', 'X requests', [setup.sections.x])
  sheet('cursor', 'Cursor', [setup.sections.cursor])
  sheet('where', 'Where builds go', [whereBody], () => {
    if (chooser === null) {
      try {
        chooser = ctx.repoChooser(whereHost, {
          keys, prefs, githubHost,
          onSaved: () => { ctx.onSaved(); refreshAll() },
          onChange: () => refreshAll(),
        })
      } catch {
        chooser = null
        whereHost.replaceChildren(el('p', { className: 'msg err', textContent: 'The repository chooser could not open. Try again.' }))
      }
    } else chooser.refresh()
  })
  sheet('workers', 'Workers for big tasks', [setup.prefsParts.workers])
  sheet('pr', 'Pull requests', [setup.prefsParts.pullRequests])
  sheet('models', 'Models', [afterHead(setup.prefsParts.models, [optionsLine])])
  sheet('archive', 'Back up build history', [setup.sections.archive])

  // ------------------------------------------------------------- layout
  const section = (title: string, body: HTMLElement): HTMLElement =>
    el('div', { className: 'ph-section' }, [el('h2', { className: 'ph-label', textContent: title }), body])
  root.append(
    el('h1', { className: 'ph-title', textContent: 'Settings' }),
    section('Connections', el('div', { className: 'ph-rows' }, connRows.map((r) => r.row))),
    section('How builds run', el('div', { className: 'ph-rows' }, prefRows.map((r) => r.row))),
    section('Your setup', el('div', { className: 'ph-rows' }, [moveRow, backupRow, pairRow])),
    advanced,
  )

  refreshAll = (): void => {
    for (const r of connRows) {
      r.mono.textContent = r.c.mono()
      r.name.textContent = r.c.name()
      r.detail.textContent = r.c.detail()
      setState(r.state, r.c.health())
    }
    for (const r of prefRows) r.value.textContent = r.p.value()
    if (!backupWriting) backup.checked = prefs.flags.archive_mirror
    for (const [name, box] of flagBoxes) box.checked = prefs.flags[name]
    reduceMotion.checked = prefs.reduceMotion
    voiceToggle.checked = prefs.spokenReplies
    renderAddresses()
    renderOptionsLine()
    if (sheetsById.get('host')?.isOpen) renderHostSheet()
  }
  refreshAll()
  // A host probe that settles differently redraws the GitHub row.
  githubHost?.onChange(() => refreshAll())
  if (githubHost?.known() === null) void githubHost.check()

  return {
    el: root,
    setup,
    refresh: () => refreshAll(),
    checkHealth,
    open,
    openAdvanced,
    closeAll,
    refreshPrefs: () => {
      setup.refreshPrefs()
      refreshAll()
    },
  }
}
