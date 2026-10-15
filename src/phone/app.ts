/**
 * Phone companion (the plugin page in the Even app). Not a settings screen:
 * full viewership of, and access to, everything we work on. The screens
 * follow docs/design/redesign/ exactly (REDESIGN-SPEC.md):
 *
 * - HOME (Home.dc.html): the "On your glasses" mirror, the amber "Needs you"
 *   card, "Start something new", and the first builds.
 * - BUILDS (undrawn; the Home list in full with source filter chips).
 * - SETTINGS (Settings.dc.html): connections with health, how builds run,
 *   your setup, and Advanced (settings.ts).
 * - MISSION (Mission.dc.html): one build in detail, with its message bar.
 * - ASK (Ask.dc.html): the question sheet.
 *
 * A fresh install opens the setup flow (src/setup/flow) instead; an install
 * whose setup works goes straight to Home.
 *
 * Spriite stays aware of everything done here: the phone page hosts the
 * engine, so every tap and typed line runs through the same orchestrator
 * the glasses drive, and each engine card lands in the activity log.
 */
import { SPEAKER_LABEL, type ChatWho } from '../domain/speaker'
import { COPY, buildName } from '../factory/copy'
import { isBuildDirective, isBuildApproval, isBuildCancellation, isScopeReviewDirective } from '../factory/build-intent'
import type { EngineView } from '../factory/view'
import type { FactoryEngine } from '../factory/engine'
import { RealOrchestrator } from '../factory/real'
import { selectGitHubNow } from '../factory/github'
import type { GitHubHost } from '../factory/github-host'
import { RuntimeEngine } from '../runtime/app-engine'
import type { SceneAction, SceneKind } from '../scenes/types'
import type { KeyVault } from '../voice/keys'
import type { PrefsVault } from '../state/prefs'
import { FEED_KEEP, type FeedEntry, type FeedVault } from '../state/feed'
import { isSetupComplete } from '../state/setup-state'
import { createPairingClient } from '../pair/client'
import type { PairingClient } from '../pair/types'
import {
  mountMoveScreen as defaultMoveScreen,
  mountRepoChooser as defaultRepoChooser,
  mountSetupFlow as defaultSetupFlow,
  type SetupFlowHandle,
} from '../setup/flow/index'
import { createSpriteView, type SpriteView } from '../sprite/dom'
import type { ScenePose } from '../sprite/poses'
import { THEME_CSS } from './theme'
import { FONT_CSS, TOKENS_CSS } from './tokens'
import { icon, ICONS } from './icons'
import { createSheet } from './sheet'
import { hostSignInText } from '../setup/x-panel'
import { mountSettings, modelsValue, repoLabel, type SettingsSheetId } from './settings'
import { ageOf, agentRows, BUILD_DOT, buildState, leadActivity, marksLabel, milestoneLine, milestoneMarks, snapshotMilestones } from './view-model'
import type { XConnection } from '../intake/connection'
import type { ArchiveClient } from '../state/archive'
import { classifyIntent, destinationRepositoryFrom } from '../intake/x'
import { voiceTargetOf, type VoiceTarget } from '../voice/turn'
import { mountNativePhone, type NativePhoneDeps } from './native'
export type { NativeLaunchRequest, NativeLaunchOutcome } from './native'

type Tab = 'home' | 'builds' | 'settings'
type Screen = Tab | 'mission'
type BuildFilter = 'all' | 'local' | 'factory' | 'cursor'
type Tone = 'ok' | 'err' | 'muted'

/** Friendly card labels for the live mirror + activity log. */
// Every scene kind has a label, so a card never reads as its raw kind id
// (the mirror's title falls back to it when no build is named).
const SCENE_LABEL: Record<SceneKind, string> = {
  meet: 'Spriite',
  setup_notice: 'Setup needed',
  setup_connections: 'Setup needed',
  decision_detail: 'Question for you',
  switching: 'Switching builds',
  mic_error: 'Microphone',
  transcribing: 'Listening',
  connection_lost: 'Connection lost',
  voice_heard: 'You said',
  voice_confirm: 'You said',
  voice_error: 'Voice',
  ask_notice: 'Needs you',
  x_notice: 'From X',
  transcript: 'New goal',
  plan: 'Plan',
  // This scene also represents idle, queued, and unconfirmed sessions.
  // Its status line, not the saved scene kind, names current activity.
  running: 'Session activity',
  under_review: 'In review',
  repair: 'Fixing',
  factory_error: 'Something failed',
  final: 'Done',
  paused: 'Paused',
  decision: 'Question for you',
  explain: 'Explanation',
  status_answer: 'Spriite replied',
  accepted: 'Verified',
  regression: 'Regression',
}

/**
 * Why a mirror control turned itself off. "So far": a slow engine step can
 * still answer, and the control turns back on when it does.
 */
const DEAD_ACTION_NOTE =
  'has nothing to do on this card so far, so it is turned off here. It turns back on if an answer arrives later.'

const SOURCE_LABEL: Record<'local' | 'factory' | 'cursor', string> = {
  local: 'Spriite',
  factory: 'Factory',
  cursor: 'Cursor',
}

/** How many builds the Home card shows before "See all" (the board draws four). */
const HOME_BUILDS = 4

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props)
  for (const c of children) node.append(c)
  return node
}

/** "Factory: building" -> "Building": the source pill already names the account. */
const rowNote = (note: string): string => {
  const word = note.replace(/^(Factory|Cursor|Spriite):\s*/, '')
  return word.charAt(0).toUpperCase() + word.slice(1)
}

const clock = (t: number): string => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Reading-position-aware auto-scroll for the card lists after their rows
 * re-render: the newest lands at `end`, and the view follows it only when
 * the owner was already reading there — never yanked off older rows. Under
 * a DOM shim without layout every number reads 0, so the pair degrades to a
 * harmless no-op.
 */
const nearEnd = (box: HTMLElement, end: 'top' | 'bottom'): boolean => {
  const top = Number(box.scrollTop) || 0
  if (end === 'top') return top <= 24
  return top + (Number(box.clientHeight) || 0) >= (Number(box.scrollHeight) || 0) - 24
}

/** The page itself is near its end (the Mission chat scrolls with the page). */
const pageNearEnd = (): boolean => {
  if (typeof document === 'undefined') return true
  const se = (document.scrollingElement ?? document.documentElement) as HTMLElement | null
  if (!se) return true
  const view = typeof window !== 'undefined' ? Number(window.innerHeight) || 0 : 0
  return (Number(se.scrollTop) || 0) + view >= (Number(se.scrollHeight) || 0) - 160
}

/**
 * Show only what changed: rows equal to what is already there stay in place
 * (a streamed reply no longer rebuilds the chat and stops a scroll in motion).
 */
const patchRows = (box: HTMLElement, next: Node[]): void => {
  const have = Array.from(box.children ?? []) as HTMLElement[]
  // Without a real DOM (the test shim) rebuild, as before.
  if (have.some((n) => typeof n.replaceWith !== 'function' || typeof n.remove !== 'function')) {
    box.replaceChildren(...next)
    return
  }
  const sig = (n: Node): string => {
    const e = n as Partial<HTMLElement>
    return `${e.className ?? ''}\u0000${e.innerHTML ?? n.textContent ?? ''}`
  }
  next.forEach((node, i) => {
    const old = have[i]
    if (!old) box.append(node)
    else if (sig(old) !== sig(node)) old.replaceWith(node)
  })
  for (let i = next.length; i < have.length; i++) have[i].remove()
}

/** Bring the newest bubble into view at its start (a long reply opens at its beginning). */
const showNewest = (box: HTMLElement): void => {
  const last = box.lastElementChild as HTMLElement | null
  if (last && typeof last.scrollIntoView === 'function') last.scrollIntoView({ block: 'start' })
}

/** Snap `end` into view: the newest row rides into sight. */
const snapEnd = (box: HTMLElement, end: 'top' | 'bottom'): void => {
  box.scrollTop = end === 'top' ? 0 : box.scrollHeight
}

export interface PhoneHandle {
  /** Keep refused dictation whole and target-bound; recovery never sends it. */
  retainVoiceDraft(text: string, originalTarget?: VoiceTarget): void
  /** The engine showed a new card; mirror it and log it. */
  notify(view: EngineView): void
  /** A build the HUD is not on (or a held X post) needs the owner. */
  notifyAsk(missionId: string, title: string): void
  /**
   * An X request was accepted and became a mission: say so and refresh, or
   * the row waits for the lobby's next cloud poll to appear at all.
   */
  notifyXStarted(goal: string): void
  /**
   * An X reply steered a running build: the steer is logged and the build's
   * own row refreshes — a reply that lands silently is a message the owner
   * cannot tell arrived.
   */
  notifyXExtended(goal: string): void
  /** An X request saved as a held native intent: nothing started. */
  notifyXHeld(goal: string): void
  /**
   * Entries an archive restore brought back, unioned into the live feed:
   * the record is the source of truth, and the page should show it without
   * waiting for a reload.
   */
  applyRestoredFeed(entries: FeedEntry[]): void
  /** Refresh setup preferences changed by a voice command. */
  refreshPrefs(): void
  /** Glasses link state for the header pill. */
  setGlasses(connected: boolean | null): void
  /**
   * A later outcome of something the phone already sent (the durable runtime
   * saves a goal after the tap returns). A request that did not save puts the
   * typed goal back, so the earlier "Got it" is corrected, never left standing.
   */
  notice(text: string): void
}

/**
 * Mount the phone companion. The engine accessor is read live; runAction is
 * the app's action router (connect prompts, Talk capture, restart, engine
 * actions), so phone
 * buttons behave exactly like the focused action on the glasses.
 */
export interface PhoneDeps {
    keys: KeyVault
    prefs: PrefsVault
    /** The activity log's durable copy: restored before the first render. */
    feed: FeedVault
    engine: () => FactoryEngine
    runAction: (action: SceneAction) => void
    onSaved: () => void
    xConnection?: XConnection | null
    /** The durable runtime's asks, even while another engine owns the HUD. */
    pendingAsks?: () => Array<{ missionId: string; title: string; options?: string[]; who?: ChatWho }>
    /**
     * Any mission's durable session history, live or finished: the runtime's
     * store is the record a finished build leaves (absent under the legacy
     * engine, which keeps no per-mission log).
     */
    chatLogFor?: (missionId: string) => {
      title: string | null
      name?: string | null
      log: Array<{ who: ChatWho; text: string; at: number }>
    } | null
    /**
     * Where a Needs-you row's Show routes. Defaults to the live engine, but
     * the banner reads the durable runtime's asks, so the runtime engine must
     * take the tap.
     */
    showMission?: (missionId: string) => boolean
    /** The VPS archive mirror (Settings > Back up build history); null without the runtime. */
    archive?: ArchiveClient | null
    /** Fired after a feed append landed in storage: the mirror's debounce. */
    onFeedAppend?: () => void
    onNativeLaunch?: NativePhoneDeps['onNativeLaunch']
    onNativeAdmission?: NativePhoneDeps['onNativeAdmission']
    nativeCapabilities?: NativePhoneDeps['nativeCapabilities']
    heldNativeIntents?: NativePhoneDeps['heldNativeIntents']
    onPromoteHeld?: NativePhoneDeps['onPromoteHeld']
    onDismissHeld?: NativePhoneDeps['onDismissHeld']
    /** Pairing and transfer (contract C5); default createPairingClient({ keys, prefs, feed, archive }). */
    pairing?: PairingClient
    /** Test seams for the setup package's screens (contract C6). */
    setupFlow?: typeof defaultSetupFlow
    /**
     * Dev-only scripted runs (?fake=1) inject a fake Factory key into the
     * engine, never the vault: setup counts as done there, so the phone
     * shows Home and the build instead of covering it with Welcome.
     */
    setupSatisfied?: () => boolean
    moveScreen?: typeof defaultMoveScreen
    repoChooser?: typeof defaultRepoChooser
    /** The paired host's GitHub sign-in (HOST-GITHUB-PLAN); absent, the token alone. */
    githubHost?: GitHubHost | null
}

/** Read an optional engine member without trusting a partial engine (test stubs). */
const has = <T>(fn: (() => T) | undefined, fallback: T): T => {
  try {
    return typeof fn === 'function' ? fn() : fallback
  } catch {
    return fallback
  }
}

/** The document head the phone styles went into (once per page). */
let stylesHead: unknown = null

export function mountPhoneApp(
  root: HTMLElement,
  deps: PhoneDeps,
): PhoneHandle {
  // Tokens, bundled fonts and the theme, once per page.
  if (stylesHead !== document.head) {
    const style = el('style')
    style.textContent = FONT_CSS + TOKENS_CSS + THEME_CSS
    document.head.append(style)
    stylesHead = document.head
  }

  // The archive mirror's device key moves with "Move to another phone" (the
  // ArchiveClient satisfies ArchiveKeyPort), so the new phone can restore its
  // build records from the relay archive.
  const pairing = deps.pairing ?? createPairingClient({
    keys: deps.keys, prefs: deps.prefs, feed: deps.feed,
    ...(deps.archive ? { archive: deps.archive } : {}),
  })
  const setupFlow = deps.setupFlow ?? defaultSetupFlow
  const moveScreen = deps.moveScreen ?? defaultMoveScreen
  const repoChooser = deps.repoChooser ?? defaultRepoChooser

  // What the previous visit recorded (spec §1): the feed starts as it was
  // left, entries rendered exactly as logged — never summarized or invented.
  const feed: FeedEntry[] = [...deps.feed.restore()]
  let filter: BuildFilter = 'all'
  let lastView: EngineView | null = null
  /** The last goal a composer handed off, until its outcome is known. */
  let lastSent: { text: string; newRepo: boolean; home: boolean } | null = null
  /**
   * Mirror actions that changed nothing, keyed by the card they sat on and
   * the engine state they were judged against: an engine that moves after
   * the verdict (a slow network step landing on an identical card) revokes it.
   */
  let deadActions: { card: string; state: string; ids: Set<string> } = { card: '', state: '', ids: new Set() }
  /** Everything the owner can read on a card: a tap that leaves it equal did nothing. */
  const cardSignature = (view: EngineView | null): string =>
    view === null
      ? ''
      : view.type === 'scene'
        ? JSON.stringify([view.scene.kind, view.scene.utterance, view.scene.status, view.scene.actions.map((a) => a.id)])
        : JSON.stringify([view.purpose, view.title, view.items])
  /**
   * The engine's own state, beyond the card: a queued start, a recorded
   * delivery attempt, or an unconfirmed send moves it even while the card
   * stays the same. An unreadable snapshot never matches (fail closed: an
   * action is never called dead on state that could not be compared).
   */
  let unreadableState = 0
  const engineState = (): string => {
    try {
      const engine = deps.engine()
      return JSON.stringify([engine.hasUnconfirmedDelivery === true, engine.hasPendingDecision, engine.snapshot()])
    } catch {
      unreadableState += 1
      return `unreadable:${unreadableState}`
    }
  }
  /** The finished build whose kept history Mission shows (history mode). */
  let historyMission: { missionId: string; title: string | null } | null = null

  /** First-run setup is finished (or a dev fake run supplies its keys). */
  const setupDone = (): boolean => deps.setupSatisfied?.() === true || isSetupComplete(deps.keys, deps.prefs)

  /**
   * One activity entry, kept under the cap both ends agree on, and written
   * through: a reload must still show what happened, so the write follows
   * every append (a failed one keeps the in-memory row; the feed is a log,
   * never a reason for the page to die).
   */
  const logFeed = (label: string, text: string): void => {
    feed.unshift({ at: Date.now(), label, text })
    if (feed.length > FEED_KEEP) feed.length = FEED_KEEP
    void deps.feed.save([...feed])
    // The durable append is the mirror's trigger (VPS-ARCHIVE-SPEC §6).
    deps.onFeedAppend?.()
  }

  // ============================================================ shell

  const screens = el('main', { className: 'ph-screens' })
  const paneHome = el('section', { className: 'ph-screen ph-home', id: 'ph-home' })
  const paneBuilds = el('section', { className: 'ph-screen ph-builds', id: 'ph-builds' })
  const paneSettings = el('section', { className: 'ph-screen ph-settings', id: 'ph-settings' })
  const paneMission = el('section', { className: 'ph-screen ph-mission', id: 'ph-mission' })
  screens.append(paneHome, paneBuilds, paneSettings, paneMission)

  // Bottom nav, exactly as Home.dc.html and Settings.dc.html draw it.
  const navBadge = el('span', { className: 'ph-dotbadge' })
  navBadge.hidden = true
  const navItem = (tab: Tab, label: string, ico: HTMLElement): HTMLAnchorElement => {
    const a = el('a', { className: 'ph-tab', href: `#${tab}`, id: `ph-tab-${tab}` }, [ico, label])
    a.onclick = (ev?: Event) => {
      ev?.preventDefault?.()
      show(tab)
    }
    return a
  }
  const settingsIcon = icon('settings')
  const tabHome = navItem('home', 'Home', icon('home'))
  tabHome.append(navBadge)
  const tabBuilds = navItem('builds', 'Builds', icon('builds'))
  const tabSettings = navItem('settings', 'Settings', settingsIcon)
  const nav = el('nav', { className: 'ph-nav' }, [tabHome, tabBuilds, tabSettings])
  nav.setAttribute('aria-label', 'Main')

  const sheetHost = el('div', { className: 'ph-sheets' })
  const fullHost = el('div', { className: 'ph-fullscreen' })
  fullHost.hidden = true
  const setupHost = el('div', { className: 'ph-fullscreen ph-setup', id: 'ph-setup' })
  setupHost.hidden = true

  let screen: Screen = 'home'
  let lastTab: Tab = 'home'
  const show = (next: Screen): void => {
    screen = next
    if (next !== 'mission') lastTab = next
    paneHome.hidden = next !== 'home'
    paneBuilds.hidden = next !== 'builds'
    paneSettings.hidden = next !== 'settings'
    paneMission.hidden = next !== 'mission'
    nav.hidden = next === 'mission'
    for (const [tab, a] of [['home', tabHome], ['builds', tabBuilds], ['settings', tabSettings]] as const) {
      if (tab === next) a.setAttribute('aria-current', 'page')
      else a.removeAttribute('aria-current')
    }
    // The Settings board draws its own tab icon when it is the current tab.
    settingsIcon.innerHTML = next === 'settings' ? ICONS.settingsActive : ICONS.settings
    if (next === 'settings') settings.checkHealth()
    if (next === 'mission') renderMission()
    if (next === 'builds') renderBuilds()
    window.scrollTo({ top: 0 })
  }

  // ============================================================= home

  const glassesDot = el('i')
  const glassesText = el('span', { textContent: 'Checking glasses' })
  const glassesPill = el('span', { className: 'ph-glasses', id: 'ph-glasses' }, [glassesDot, glassesText])
  const homeHead = el('div', { className: 'ph-head' }, [
    el('div', { className: 'ph-brand', textContent: 'Spriite' }),
    glassesPill,
  ])

  // ------------------------------------------------ On your glasses mirror
  const spriteFor = (pose: ScenePose, px: number): SpriteView | null => {
    try {
      return createSpriteView({ pose, px })
    } catch {
      return null
    }
  }
  const mirrorSprite = spriteFor('idle', 2)
  const mirrorMeta = el('span', { className: 'ph-glass-meta', id: 'ph-mirror-meta' })
  const mirrorTitle = el('span', { className: 'ph-glass-title', id: 'ph-mirror-title' })
  const mirrorBody = el('span', { className: 'ph-glass-body', id: 'ph-mirror-body' })
  const mirrorSegs = el('div', { className: 'ph-segs', id: 'ph-mirror-bar' })
  mirrorSegs.setAttribute('role', 'img')
  const openBuildBtn = el('button', { className: 'ph-glass-btn solid', type: 'button', textContent: 'Open build', id: 'ph-open-build' })
  const pauseBtn = el('button', { className: 'ph-glass-btn outline', type: 'button', textContent: 'Pause', id: 'ph-mirror-pause' })
  const mirrorButtons = el('div', { className: 'ph-pair' }, [openBuildBtn, pauseBtn])
  const mirror = el('section', { className: 'ph-mirror', id: 'ph-mirror' }, [
    el('div', { className: 'ph-mirror-top' }, [
      el('span', { className: 'ph-glass-label', textContent: 'On your glasses' }),
      mirrorMeta,
    ]),
    el('div', { className: 'ph-mirror-main' }, [
      ...(mirrorSprite ? [mirrorSprite.el] : []),
      el('div', { className: 'ph-mirror-text' }, [mirrorTitle, mirrorBody]),
    ]),
    mirrorSegs,
    mirrorButtons,
  ])
  openBuildBtn.onclick = () => {
    historyMission = null
    show('mission')
  }
  /** Pause or resume through the app's router, exactly like the glasses action. */
  const pauseResume = (): void => {
    const engine = deps.engine()
    const resume = has(engine.canResume?.bind(engine), false)
    deps.runAction(resume
      ? { id: 'resume', label: 'Resume', kind: 'command' }
      : { id: 'pause', label: 'Pause', kind: 'command' })
    renderPause()
  }
  pauseBtn.onclick = pauseResume

  // ------------------------------------------------------------ Needs you
  const needsMeta = el('span', { className: 'ph-needs-meta', id: 'ph-needs-meta' })
  const needsQuestion = el('span', { className: 'ph-needs-q', id: 'ph-needs-q' })
  const needsOptions = el('div', { className: 'ph-needs-opts', id: 'ph-needs-options' })
  const needsAll = el('button', { className: 'ph-needs-link', type: 'button', textContent: 'See all options', id: 'ph-needs-all' })
  // Every other thing waiting (more asks, held X posts, held native requests)
  // keeps its existing row and its exact confirm and dismiss rules.
  const needsRows = el('div', { className: 'rows', id: 'ph-needs-rows' })
  const needsCard = el('section', { className: 'ph-needs', id: 'ph-needs' }, [
    el('div', { className: 'ph-needs-top' }, [
      el('span', { className: 'ph-needs-label', textContent: 'Needs you' }),
      needsMeta,
    ]),
    needsQuestion,
    needsOptions,
    needsAll,
    needsRows,
  ])
  needsCard.hidden = true

  // --------------------------------------------------- Start something new
  const homeInput = el('textarea', {
    id: 'ask', rows: 3, placeholder: 'Add a guest checkout to the shop site…', spellcheck: true,
  })
  homeInput.enterKeyHint = 'send'
  const newRepoChip = el('button', { className: 'ph-chip', type: 'button', id: 'ph-new-repo' }, [icon('plus'), 'New repo'])
  const modelsChip = el('button', { className: 'ph-chip', type: 'button', id: 'ph-models-chip' })
  const homeTalk = el('button', { className: 'ph-round', type: 'button', id: 'ph-home-talk' }, [icon('mic')])
  homeTalk.setAttribute('aria-label', 'Talk')
  const homeSend = el('button', { className: 'ph-round go', type: 'button', id: 'ph-home-send' }, [icon('send')])
  homeSend.setAttribute('aria-label', 'Send')
  // A goal starts in a brand-new repository (named from the goal through the
  // existing path) when the chip is on; on by default with "New repo per idea".
  let newRepoOn = deps.keys.repoMode === 'per_idea'
  /** The repo mode the chip last followed: a change in setup or Settings resets it. */
  let chipMode = deps.keys.repoMode
  const setNewRepo = (on: boolean): void => {
    newRepoOn = on
    newRepoChip.classList.toggle('on', on)
    newRepoChip.setAttribute('aria-pressed', on ? 'true' : 'false')
  }
  setNewRepo(newRepoOn)
  const syncNewRepoMode = (): void => {
    if (deps.keys.repoMode === chipMode) return
    chipMode = deps.keys.repoMode
    setNewRepo(chipMode === 'per_idea')
  }
  newRepoChip.onclick = () => {
    if (deps.keys.repoMode === 'per_idea' && newRepoOn) {
      // Per idea, every goal gets its own repository: there is no one repo to
      // fall back on, so the chip stays on instead of promising otherwise.
      setNote('New repo per idea is on: every goal gets its own repository. To build in one repository, choose "One repo I choose" in Settings › Where builds go.')
      return
    }
    setNewRepo(!newRepoOn)
    renderComposer()
  }
  modelsChip.onclick = () => {
    show('settings')
    settings.open('models')
  }
  homeTalk.onclick = () => deps.runAction({ id: 'talk', label: 'Talk', kind: 'local_capture' })
  const homeHelp = el('p', { className: 'ph-hint', id: 'ph-home-help' })
  // The outcome line for every phone action (send, confirm, open): announced,
  // the same convention the X panel's result line uses.
  const sayNote = el('p', { className: 'msg muted', role: 'status', id: 'ph-note' })
  const composeCard = el('section', { className: 'ph-card ph-compose', id: 'ph-compose' }, [
    el('label', { htmlFor: 'ask', textContent: 'Start something new' }),
    homeInput,
    el('div', { className: 'ph-compose-row' }, [newRepoChip, modelsChip, el('div', { className: 'ph-spacer' }), homeTalk, homeSend]),
    homeHelp,
    sayNote,
  ])

  // ------------------------------------------------------- voice drafts
  // Separate from the composers: refused dictation must not overwrite a
  // typed draft, move to another chat, or answer a newly arrived question.
  const voiceDrafts: Array<{ text: string; target: VoiceTarget; title: string }> = []
  const voiceDraftCard = el('section', { className: 'card stack', id: 'ph-voice-drafts' })
  voiceDraftCard.hidden = true

  // ------------------------------------------------------------- builds
  const homeBuilds = el('div', { className: 'ph-card ph-list', id: 'ph-home-builds' })
  const seeAll = el('button', { className: 'ph-see-all', type: 'button', textContent: 'See all' })
  seeAll.onclick = () => show('builds')
  const homeBuildsSection = el('section', { className: 'ph-section' }, [
    el('div', { className: 'ph-section-head' }, [el('h2', { className: 'ph-h2', textContent: 'Builds' }), seeAll]),
    homeBuilds,
  ])

  paneHome.append(homeHead, mirror, needsCard, composeCard, voiceDraftCard, homeBuildsSection)

  // ============================================================= builds tab
  const filterBar = el('div', { className: 'ph-filters filters', id: 'ph-build-filters' })
  const buildsList = el('div', { className: 'ph-card ph-list', id: 'ph-builds-list' })
  const buildsHint = el('p', { className: 'ph-hint', id: 'ph-builds-hint' })
  paneBuilds.append(
    el('h1', { className: 'ph-title', textContent: 'Builds' }),
    filterBar,
    buildsList,
    buildsHint,
  )

  // ============================================================ mission
  const backBtn = el('button', { className: 'ph-icon-btn ph-back', type: 'button' }, [icon('back')])
  backBtn.setAttribute('aria-label', 'Back to home')
  backBtn.onclick = () => {
    menuOpen = false
    renderMenu()
    show(lastTab === 'builds' ? 'builds' : 'home')
  }
  const moreBtn = el('button', { className: 'ph-icon-btn', type: 'button', id: 'ph-more' }, [icon('more')])
  moreBtn.setAttribute('aria-label', 'More actions')
  moreBtn.setAttribute('aria-expanded', 'false')
  let menuOpen = false
  // The build's own actions (the glasses' action row), behind More actions.
  const menu = el('div', { className: 'ph-menu', id: 'ph-actions' })
  const menuActions = el('div', { className: 'btns', id: 'ph-menu-actions' })
  const factoryAnswer = el('a', { className: 'btn secondary', textContent: 'Answer in Factory', target: '_blank', rel: 'noopener noreferrer' })
  menu.append(menuActions, factoryAnswer)
  const renderMenu = (): void => {
    menu.hidden = !menuOpen
    moreBtn.setAttribute('aria-expanded', menuOpen ? 'true' : 'false')
  }
  moreBtn.onclick = () => {
    menuOpen = !menuOpen
    renderMenu()
  }
  renderMenu()
  const missionSprite = spriteFor('idle', 2)
  const missionTitle = el('h1', { id: 'ph-mission-title' })
  const missionWhere = el('span', { className: 'ph-mission-where', id: 'ph-mission-where' })
  const missionFault = el('div', { className: 'callout err', id: 'ph-mission-fault' })
  missionFault.hidden = true
  const timeline = el('div', { className: 'ph-timeline', id: 'ph-timeline' })
  const listRows = el('div', { className: 'ph-group rows', id: 'ph-mission-list' })
  const agentsGroup = el('div', { className: 'ph-group', id: 'ph-agents' })
  const agentsSection = el('div', { className: 'ph-section' }, [
    el('h2', { className: 'ph-label', textContent: 'Who’s working' }), agentsGroup,
  ])
  const nativeAttentionCard = el('section')
  const chatRows = el('div', { className: 'ph-bubbles', id: 'ph-latest' })
  let sessionRenderKey = ''
  const latestSection = el('div', { className: 'ph-section', id: 'ph-latest-section' }, [
    el('h2', { className: 'ph-label', textContent: 'Latest' }), chatRows,
  ])
  const missionInput = el('input', {
    id: 'msg', type: 'text', placeholder: 'Message the Lead…', autocomplete: 'off', spellcheck: true,
  })
  missionInput.enterKeyHint = 'send'
  const missionTalk = el('button', { className: 'ph-round', type: 'button', id: 'ph-mission-talk' }, [icon('mic')])
  missionTalk.setAttribute('aria-label', 'Talk')
  missionTalk.onclick = () => deps.runAction({ id: 'talk', label: 'Talk', kind: 'local_capture' })
  const missionPause = el('button', { className: 'ph-round raised', type: 'button', id: 'ph-mission-pause' }, [icon('pause')])
  missionPause.setAttribute('aria-label', 'Pause build')
  missionPause.onclick = pauseResume
  const missionHelp = el('p', { className: 'ph-hint', id: 'ph-mission-help' })
  const missionNote = el('p', { className: 'msg muted', id: 'ph-mission-note' })
  missionNote.setAttribute('aria-live', 'polite')
  const msgBar = el('div', { className: 'ph-msgbar', id: 'ph-msgbar' }, [
    missionHelp,
    missionNote,
    el('div', { className: 'ph-msgbar-row' }, [
      el('label', { className: 'ph-sr', htmlFor: 'msg', textContent: 'Message the Lead' }),
      missionInput, missionTalk, missionPause,
    ]),
  ])
  paneMission.append(
    el('div', { className: 'ph-mission-top' }, [backBtn, moreBtn]),
    menu,
    el('div', { className: 'ph-mission-id' }, [
      el('div', { className: 'ph-sprite-box' }, missionSprite ? [missionSprite.el] : []),
      el('div', { className: 'ph-mission-name' }, [missionTitle, missionWhere]),
    ]),
    missionFault,
    timeline,
    listRows,
    agentsSection,
    nativeAttentionCard,
    latestSection,
    msgBar,
  )

  // One outcome line, shown on Home and on the Mission bar.
  const setNote = (text: string, tone: Tone = 'muted'): void => {
    for (const n of [sayNote, missionNote]) {
      n.className = `msg ${tone}`
      n.textContent = text
    }
  }

  // ======================================================= activity log
  const feedList = el('ul', { className: 'feed' })
  const feedCount = el('span', { className: 'pill' })
  const logCard = el('details', { className: 'card log' }, [
    el('summary', {}, [el('span', { className: 'eyebrow', textContent: 'Activity' }), feedCount]),
    feedList,
  ])

  // ================================================ native + settings
  const nativeLaunchCard = el('section')
  const nativePhone = mountNativePhone(nativeLaunchCard, nativeAttentionCard, deps)

  const settings = mountSettings(paneSettings, {
    keys: deps.keys,
    prefs: deps.prefs,
    pairing,
    xConnection: deps.xConnection,
    archive: deps.archive ?? null,
    nativeCapabilities: deps.nativeCapabilities,
    onSaved: () => {
      deps.onSaved()
      renderComposer()
    },
    sheetHost,
    fullHost,
    nativeLaunch: nativeLaunchCard,
    activityLog: logCard,
    repoChooser,
    moveScreen,
    setupFlow,
    githubHost: deps.githubHost ?? null,
  })
  // The host's GitHub answer can retire (or bring back) the composer's help line.
  deps.githubHost?.onChange(() => renderComposer())

  // ============================================================ Ask sheet
  const askSheet = createSheet(sheetHost, { id: 'ph-ask-sheet', label: 'Lead asks a question' })
  const askSpriteBox = el('div')
  const askLabel = el('span', { className: 'ph-ask-label', textContent: 'Lead asks' })
  const askMeta = el('span', { className: 'ph-ask-meta' })
  const askQuestion = el('h1')
  const askExplain = el('p')
  const askRadios = el('div', { className: 'ph-radios', role: 'radiogroup' })
  askRadios.setAttribute('aria-label', 'Answer')
  const askSay = el('button', { className: 'ph-say', type: 'button' }, [icon('micSmall'), 'Say it'])
  const askSend = el('button', { className: 'ph-send', type: 'button', textContent: 'Send answer' })
  askSheet.body.append(
    el('div', { className: 'ph-ask-who' }, [askSpriteBox, el('div', { className: 'ph-ask-who-text' }, [askLabel, askMeta])]),
    el('div', { className: 'ph-ask-q' }, [askQuestion, askExplain]),
    askRadios,
    el('div', { className: 'ph-ask-actions' }, [askSay, askSend]),
    el('span', { className: 'ph-foot', textContent: 'The same question is on your glasses. Answer either place.' }),
  )
  askSheet.body.className = 'ph-sheet-content stack ph-ask'
  const askSprite = spriteFor('asking', 2)
  if (askSprite) askSpriteBox.append(askSprite.el)
  let askChoice = 0
  let askOptions: AnswerOption[] = []

  // ============================================================== root
  const shell = el('div', { className: 'sp' }, [screens, nav, sheetHost, fullHost, setupHost])
  root.replaceChildren(shell)

  // ===================================================== live mirror

  const kindLabelFor = (view: EngineView): string =>
    view.type === 'scene'
      ? SCENE_LABEL[view.scene.kind as SceneKind] ?? view.scene.kind.replace(/_/g, ' ')
      : view.purpose === 'projects' ? 'Home'
      : view.purpose === 'goal' ? 'New build'
      : view.purpose === 'decision' ? 'Question for you'
      : view.purpose === 'plan_detail' ? 'Milestones'
      : 'Evidence'

  /**
   * The activity label names who is behind the card, then what it is
   * ("Lead · Question for you", "Worker · Session activity").
   */
  const labelFor = (view: EngineView): string => {
    const kind = kindLabelFor(view)
    if (view.type !== 'scene') {
      // An option list is always a question from the lead (gates are scenes).
      return view.purpose === 'decision' ? `${SPEAKER_LABEL.lead} · ${kind}` : kind
    }
    const who = view.scene.speaker
    if (who === undefined) return kind
    if (view.scene.kind === 'status_answer') {
      return who === 'spriite' ? `${SPEAKER_LABEL.spriite} · Note` : `${SPEAKER_LABEL[who]} · Reply`
    }
    return `${SPEAKER_LABEL[who]} · ${kind}`
  }

  /**
   * Actions whose effect is not a new engine card: a glasses capture, the
   * glasses' own history page, the Settings tab. Their outcome shows elsewhere.
   */
  const effectElsewhere = (a: SceneAction): boolean =>
    a.kind === 'local_capture' || a.kind === 'system' || a.id === 'chat' || a.id.startsWith('connect_')

  /** Run one card action, with the dead-tap verdict the old mirror had. */
  const runCardAction = (a: SceneAction, button: HTMLButtonElement | null): void => {
    if (a.id === 'send_message') {
      renderComposer()
      const engine = deps.engine()
      if (missionInput.disabled || engine.acceptsGoal() || has(engine.watchOnly?.bind(engine), false)) {
        setNote('This session cannot take a message here right now. Nothing was sent.')
        return
      }
      if (!missionInput.value.trim()) typedTarget = typedIdentity()
      renderComposer()
      historyMission = null
      if (screen !== 'mission') show('mission')
      missionInput.focus()
      setNote('Type a message to this selected session, then send it. Nothing is sent until you do.')
      return
    }
    const before = cardSignature(lastView)
    const beforeState = engineState()
    deps.runAction(a)
    if (effectElsewhere(a)) return
    // The engine answers a tap with a card (sometimes after a network
    // step). A tap that leaves the card and the engine's state exactly as
    // they were did nothing, so the button is turned off and the owner is
    // told, never left pressing a control that looks live. A tap the engine
    // took (a queued start, a send still unconfirmed) is still working,
    // never called dead; a verdict the engine later contradicts is revoked.
    setTimeout(() => {
      if (cardSignature(lastView) !== before) return
      const now = engineState()
      if (now !== beforeState || deps.engine().hasUnconfirmedDelivery === true) return
      deadActions.state = now
      deadActions.ids.add(a.id)
      if (button) {
        button.disabled = true
        button.style.opacity = '0.45'
      }
      setNote(`${a.label} ${DEAD_ACTION_NOTE}`)
      renderMirrorButtons()
    }, 2500)
  }

  const actionButtons = (actions: SceneAction[]): HTMLElement[] => {
    const card = cardSignature(lastView)
    if (deadActions.card !== card) deadActions = { card, state: '', ids: new Set() }
    else if (deadActions.ids.size > 0 && engineState() !== deadActions.state) {
      // The engine moved after the verdict: the tap may have been a slow
      // step answering on the same card. Turn the controls back on and take
      // back the note that said they did nothing.
      deadActions = { card, state: '', ids: new Set() }
      if (sayNote.textContent.includes(DEAD_ACTION_NOTE)) setNote('')
    }
    return actions.map((a, i) => {
      const factoryLink = a.id === 'open_factory' ? has(deps.engine().factorySessionLink?.bind(deps.engine()), null) : null
      if (factoryLink) {
        return el('a', {
          className: `btn ${i === 0 ? '' : 'secondary'}`, textContent: a.label,
          href: factoryLink, target: '_blank', rel: 'noopener noreferrer',
        })
      }
      const b = el('button', { className: `btn ${i === 0 ? '' : 'secondary'}`, textContent: a.label })
      if (deadActions.ids.has(a.id)) {
        b.disabled = true
        b.style.opacity = '0.45'
      }
      b.onclick = () => runCardAction(a, b)
      return b
    })
  }

  /** The mirror's Pause/Resume and Mission's pause button follow the engine. */
  const renderPause = (): void => {
    const engine = deps.engine()
    const canResume = has(engine.canResume?.bind(engine), false)
    const canPause = has(engine.canPause?.bind(engine), false)
    pauseBtn.textContent = canResume ? 'Resume' : 'Pause'
    pauseBtn.hidden = !canResume && !canPause
    missionPause.disabled = !canResume && !canPause
    missionPause.setAttribute('aria-label', canResume ? 'Resume build' : 'Pause build')
  }
  /**
   * Open build and Pause appear only while a build is on the glasses: not on
   * the home list, the goal list, or an idle/setup card with no mission.
   */
  const IDLE_CARD_KINDS: readonly string[] = ['meet', 'setup_notice', 'setup_connections', 'transcript']
  const renderMirrorButtons = (): void => {
    const view = lastView
    const onBuild = view !== null
      && !(view.type === 'selection' && (view.purpose === 'projects' || view.purpose === 'goal'))
      && !(view.type === 'scene' && view.scene.missionId == null && IDLE_CARD_KINDS.includes(view.scene.kind))
    openBuildBtn.hidden = !onBuild
    renderPause()
    if (!onBuild) pauseBtn.hidden = true
    mirrorButtons.hidden = openBuildBtn.hidden && pauseBtn.hidden
  }

  const renderSegments = (marks: ReturnType<typeof milestoneMarks>): void => {
    if (!marks) {
      mirrorSegs.hidden = true
      mirrorSegs.replaceChildren()
      return
    }
    mirrorSegs.hidden = false
    mirrorSegs.style.gridTemplateColumns = `repeat(${marks.length}, minmax(0, 1fr))`
    mirrorSegs.setAttribute('aria-label', marksLabel(marks))
    mirrorSegs.replaceChildren(...marks.map((m) => el('div', { className: `ph-seg ${m === 'todo' ? '' : m}`.trim() })))
  }

  /**
   * The build on screen by name (Mission.dc.html 'Checkout flow'): its kept
   * goal, a watched build's own title; with no build, the
   * app's name. Never the activity label ('You · New goal').
   */
  const buildTitle = (view: EngineView): string => {
    const engine = deps.engine()
    const named = sessionTitleOf(engine)
    if (named) return named
    if (view.type === 'selection' && view.purpose === 'projects') return 'Home'
    let snap: unknown = null
    try { snap = engine.snapshot() } catch { snap = null }
    const watched = (snap as { phase?: string; attach?: { title?: unknown } | null } | null)
    if (watched?.phase === 'attach' && typeof watched.attach?.title === 'string' && watched.attach.title.trim()) {
      return watched.attach.title.trim()
    }
    return 'Spriite'
  }

  const renderMirror = (view: EngineView): void => {
    const engine = deps.engine()
    let snap: unknown = null
    try { snap = engine.snapshot() } catch { snap = null }
    const pose = view.type === 'scene' ? view.scene.spritePose : view.pose
    mirrorSprite?.setPose(pose)
    if (view.type === 'scene') {
      const s = view.scene
      const marks = milestoneMarks(s.progress, snap)
      const fault = snap && typeof (snap as { faultDetail?: unknown }).faultDetail === 'string'
        ? (snap as { faultDetail: string }).faultDetail : ''
      const failed = s.kind === 'factory_error' || Boolean(fault)
      mirrorMeta.textContent = failed ? 'Needs attention' : milestoneLine(marks)
      mirrorTitle.textContent = buildTitle(view)
      mirrorBody.textContent = s.utterance
      renderSegments(marks)
    } else if (view.purpose === 'projects') {
      const n = view.items.length - 1
      mirrorMeta.textContent = ''
      mirrorTitle.textContent = 'Home'
      mirrorBody.textContent = n > 0
        ? 'Pick a build below to open it, or tell me what to build next.'
        : 'Tell me what to build, and I will start a Factory build for it.'
      renderSegments(null)
    } else {
      mirrorMeta.textContent = ''
      mirrorTitle.textContent = buildTitle(view)
      mirrorBody.textContent = view.title
      renderSegments(null)
    }
    renderMirrorButtons()
  }

  // ============================================================ mission

  const runWhere = (): string => {
    const host = deps.prefs.pairedHost
    return host && deps.prefs.runOn === 'host' ? `on ${host.label}` : 'Factory cloud'
  }

  /** The frozen repository the mission planned against; never the saved default it has not adopted. */
  const missionRepo = (snap: unknown): string => {
    if (!snap || typeof snap !== 'object') return ''
    const s = snap as { backend?: string; binding?: { repository?: string } | null; missionRepo?: string }
    return repoLabel(s.backend === 'factory_native' ? s.binding?.repository : s.missionRepo)
  }

  const step = (state: 'done' | 'now' | 'next', title: string, detail: string, last: boolean): HTMLElement =>
    el('div', { className: `ph-step ${state}${last ? ' last' : ''}` }, [
      el('div', { className: 'ph-step-rail' }, [
        el('span', { className: 'ph-step-ring', textContent: state === 'done' ? '✓' : '' }),
        el('span', { className: 'ph-step-line' }),
      ]),
      el('div', { className: 'ph-step-text' }, [
        el('span', { className: 'ph-step-title', textContent: title }),
        ...(detail ? [el('span', { className: 'ph-step-detail', textContent: detail })] : []),
      ]),
    ])

  const statusWord = (status: string): string =>
    status === 'accepted' ? 'Checks passed'
      : status === 'submitted' ? 'In review'
        : status === 'repair' ? 'Being fixed'
          : 'Not started'

  const renderTimeline = (view: EngineView, snap: unknown): void => {
    const steps: HTMLElement[] = []
    const scene = view.type === 'scene' ? view.scene : null
    const nowDetail = view.type === 'scene' ? (view.scene.status || view.scene.utterance) : view.title
    const milestones = snapshotMilestones(snap)
    if (milestones && scene?.progress) {
      const firstOpen = milestones.findIndex((m) => m.status !== 'accepted')
      milestones.forEach((m, i) => {
        const state = m.status === 'accepted' ? 'done' : i === firstOpen ? 'now' : 'next'
        steps.push(step(state, m.label, state === 'now' ? nowDetail : statusWord(m.status), i === milestones.length - 1))
      })
    } else if (scene) {
      // No milestones yet: one current step, the card the glasses show.
      steps.push(step('now', labelFor(view), scene.status || '', true))
    }
    timeline.replaceChildren(...steps)
    timeline.hidden = steps.length === 0
  }

  const renderList = (view: EngineView): void => {
    // Other lists (new-goal options, milestones, evidence): tappable here.
    if (view.type !== 'selection' || view.purpose === 'projects') {
      listRows.replaceChildren()
      listRows.hidden = true
      return
    }
    const engine = deps.engine()
    const purpose = view.purpose
    const rows = view.items.map((item, i) => {
      const b = el('button', { className: 'row' }, [
        el('div', { className: 't' }, [el('b', { textContent: item })]),
        el('span', { className: 'chev', textContent: '›' }),
      ])
      b.onclick = () => {
        const current = engine.currentView
        if (!sameSelection(current, view)) {
          render(current)
          return
        }
        if (purpose === 'goal') {
          deps.runAction({ id: 'talk', label: 'Talk', kind: 'local_capture' })
          return
        }
        if (purpose === 'decision') {
          const where = engine.chooseDecisionList(i)
          if (where === 'talk') deps.runAction({ id: 'talk', label: 'Talk', kind: 'local_capture' })
          return
        }
        engine.chooseList(i)
      }
      return b
    })
    listRows.replaceChildren(el('p', { className: 'ph-hint', textContent: view.title }), ...rows)
    listRows.hidden = false
  }

  const renderAgents = (view: EngineView, snap: unknown): void => {
    const scene = view.type === 'scene' ? view.scene : null
    const lead = leadActivity(scene?.kind, snap)
    const rows = agentRows(snap, lead.doing, lead.state)
    agentsGroup.replaceChildren(...rows.map((a) => {
      const mono = el('span', { className: 'ph-mono', textContent: a.mono })
      const stateEl = el('span', { className: 'ph-agent-state', textContent: a.state })
      const tint = a.active ? 'var(--sp-accent)' : 'var(--sp-muted)'
      mono.style.color = tint
      stateEl.style.color = tint
      return el('div', { className: 'ph-agent' }, [
        mono,
        el('span', { className: 'ph-agent-text' }, [
          el('span', { className: 'ph-agent-name', textContent: a.name }),
          el('span', { className: 'ph-agent-doing', textContent: a.doing }),
        ]),
        stateEl,
      ])
    }))
    agentsSection.hidden = rows.length === 0
  }

  /** Chat bubbles: the Lead (and workers) left with a "<who> · <age>" header, the owner right. */
  const chatBubbles = (log: Array<{ who: ChatWho; text: string; at: number }>): HTMLElement[] =>
    log.map((e) =>
      el('div', { className: `bubble ${e.who}` }, [
        el('b', { textContent: `${SPEAKER_LABEL[e.who] ?? 'Spriite'} · ${ageOf(e.at)}` }),
        e.text,
      ]),
    )

  /** Whose log the session holds, when a record can name them. */
  const sessionTitleOf = (engine: FactoryEngine): string | null => {
    if (engine instanceof RuntimeEngine) {
      const focused = engine.focusedMissionId
      if (focused === null) return null
      const record = engine.chatLogFor(focused)
      return record.name ?? (record.title ? buildName(record.title) : null)
    }
    // A Spriite build is named as the HUD titles it ('Checkout flow'), never
    // by its raw goal (a link, a scoped goal's clarifications).
    if (engine instanceof RealOrchestrator) {
      const goal = engine.snapshot().goal
      return goal !== '' ? buildName(goal) : null
    }
    // Any other engine names its build through the same snapshot field.
    try {
      const goal = (engine.snapshot() as { goal?: unknown }).goal
      return typeof goal === 'string' && goal.trim() !== '' ? buildName(goal) : null
    } catch {
      return null
    }
  }

  const renderSession = (): void => {
    const engine = deps.engine()
    const nativeLink = has(engine.nativeQuestionLink?.bind(engine), null)
    factoryAnswer.hidden = !nativeLink
    if (nativeLink) factoryAnswer.href = nativeLink
    else factoryAnswer.removeAttribute('href')
    if (historyMission !== null) return renderHistory()
    const title = sessionTitleOf(engine)
    const log = has(engine.chatLog?.bind(engine), [] as Array<{ who: ChatWho; text: string; at: number }>)
    const renderKey = JSON.stringify([title, nativeLink, log])
    if (renderKey === sessionRenderKey) return
    sessionRenderKey = renderKey
    const before = chatRows.children?.length ?? 0
    const wasEnd = pageNearEnd()
    patchRows(chatRows, chatBubbles(log))
    latestSection.hidden = log.length === 0
    // Follow only a reader already at the end, and only when something new came in.
    if (wasEnd && (chatRows.children?.length ?? 0) !== before) showNewest(chatRows)
  }

  /** The kept history the owner asked for by tapping a finished build's row. */
  const renderHistory = (): void => {
    if (historyMission === null) return
    const record = deps.chatLogFor ? deps.chatLogFor(historyMission.missionId) : null
    const log = record?.log ?? []
    missionTitle.textContent = record?.name ?? (record?.title ? buildName(record.title) : null) ?? historyMission.title ?? 'A finished build'
    missionWhere.textContent = 'Finished · session history'
    timeline.hidden = true
    listRows.hidden = true
    agentsSection.hidden = true
    missionFault.hidden = true
    menu.hidden = true
    moreBtn.hidden = true
    msgBar.hidden = true
    missionSprite?.setPose('idle')
    sessionRenderKey = ''
    const wasEnd = pageNearEnd()
    chatRows.replaceChildren(
      ...(log.length > 0
        ? chatBubbles(log)
        : [el('p', { className: 'empty', textContent: 'Nothing was said in this session.' })]),
    )
    latestSection.hidden = false
    if (wasEnd) showNewest(chatRows)
  }

  const renderMission = (): void => {
    if (historyMission !== null) {
      renderSession()
      return
    }
    moreBtn.hidden = false
    msgBar.hidden = false
    renderMenu()
    const view = lastView ?? has(() => deps.engine().currentView, null as EngineView | null)
    if (view === null) return
    const engine = deps.engine()
    let snap: unknown = null
    try { snap = engine.snapshot() } catch { snap = null }
    missionSprite?.setPose(view.type === 'scene' ? view.scene.spritePose : view.pose)
    missionTitle.textContent = buildTitle(view)
    missionWhere.textContent = [missionRepo(snap), runWhere()].filter(Boolean).join(' · ')
    const fault = snap && typeof (snap as { faultDetail?: unknown }).faultDetail === 'string'
      ? (snap as { faultDetail: string }).faultDetail : ''
    missionFault.hidden = !fault
    missionFault.replaceChildren(...(fault ? [el('b', { textContent: 'Why it failed' }), fault] : []))
    renderTimeline(view, snap)
    renderList(view)
    renderAgents(view, snap)
    menuActions.replaceChildren(...(view.type === 'scene' ? actionButtons(view.scene.actions) : []))
    renderSession()
    renderPause()
  }

  // ========================================================= composers

  // Canonical typed ownership is frozen when typing begins. A navigation or
  // arriving question cannot quietly convert a draft into another answer.
  let typedTarget: { engine: FactoryEngine; key: string } | null = null
  const typedIdentity = (): { engine: FactoryEngine; key: string } => {
    const engine = deps.engine()
    const snap = engine.snapshot()
    const target = voiceTargetOf(engine, snap, engine instanceof RuntimeEngine ? engine.focusedMissionId : null)
    const question = 'decisionText' in snap ? snap.decisionText : ''
    const options = 'decisionOptions' in snap ? snap.decisionOptions : []
    const request = 'nativeSnapshot' in engine
      ? (engine as ReturnType<NativePhoneDeps['engine']>).nativeSnapshot?.() : null
    return { engine, key: JSON.stringify([target.mission, target.request, engine.hasPendingDecision,
      question, options, request?.missionId, request?.scopeRevision,
      request?.attention.filter(a => a.state !== 'resolved').map(a => [a.attentionId, a.revision, a.payloadHash])]) }
  }
  missionInput.addEventListener('input', () => {
    if (!missionInput.value) typedTarget = null
    else typedTarget ??= typedIdentity()
  })

  const selectedVoiceTarget = (): VoiceTarget => {
    const current = deps.engine()
    return voiceTargetOf(current, current.snapshot(),
      current instanceof RuntimeEngine ? current.focusedMissionId : null)
  }
  const canCopyVoiceDraft = (target: VoiceTarget): boolean => {
    const current = selectedVoiceTarget()
    const engine = deps.engine()
    return current.engine === target.engine && current.mission === target.mission &&
      (current.request ?? null) === (target.request ?? null) &&
      !engine.hasUnconfirmedDelivery && !engine.hasPendingDecision &&
      !has(engine.nativeQuestionLink?.bind(engine), null) && !has(engine.watchOnly?.bind(engine), false) &&
      !engine.acceptsGoal() && missionInput.value === ''
  }
  const renderVoiceDrafts = (): void => {
    voiceDraftCard.hidden = voiceDrafts.length === 0
    voiceDraftCard.replaceChildren(...voiceDrafts.map(draft => {
      const text = el('textarea', { value: draft.text, readOnly: true, rows: 6 })
      const copy = el('button', {
        className: 'btn secondary', textContent: 'Copy to composer',
        disabled: !canCopyVoiceDraft(draft.target),
      })
      copy.onclick = () => {
        // Recheck at click time: a held delivery, new question, or focus
        // change never turns this local recovery control into permission.
        if (!canCopyVoiceDraft(draft.target)) return
        missionInput.value = draft.text
        typedTarget = typedIdentity()
        renderComposer()
        historyMission = null
        show('mission')
        missionInput.focus()
        setNote('Unsent voice draft copied. Review it, then send it if you still want to.')
      }
      return el('div', { className: 'stack' }, [
        el('div', { className: 'eyebrow', textContent: 'Unsent voice message' }),
        el('p', { className: 'small muted', textContent: `${draft.title}. Kept for this visit; nothing will be sent automatically. Return to its session with an empty message bar to copy it.` }),
        text, copy,
      ])
    }))
  }
  missionInput.addEventListener('input', renderVoiceDrafts)

  const renderComposer = (): void => {
    syncNewRepoMode()
    const engine = deps.engine()
    const nativeLink = has(engine.nativeQuestionLink?.bind(engine), null)
    const nativeSnapshot = has((engine as ReturnType<NativePhoneDeps['engine']>).nativeSnapshot?.bind(engine), null)
    const nativePending = nativeSnapshot?.attention.some(a => a.state !== 'resolved') === true
    const deliveryPending = engine.hasUnconfirmedDelivery === true
    // ---- Mission bar: messages the selected session (steer or answer).
    missionInput.disabled = nativeLink !== null || nativePending || deliveryPending
    if (nativeSnapshot && (nativeLink || nativePending)) {
      missionHelp.textContent = 'Full questions and offered native outcomes are above. Ordinary text, yes, proceed or Use it cannot grant native permission. Your existing draft is kept.'
    } else if (nativeLink) {
      missionHelp.textContent = 'Factory uses a native popup for this question. Read it here, then use Answer in Factory under More actions. A text message here would not answer that popup.'
    } else if (deliveryPending) {
      missionHelp.textContent = 'Delivery is unconfirmed. Check the Factory chat before sending another message. Use Resolve after you have checked; nothing will be resent.'
    } else if (engine.hasPendingDecision) {
      missionHelp.textContent = 'Spriite is waiting on your answer. Yes or no works, or reply in your own words.'
    } else if (engine.acceptsGoal()) {
      missionHelp.textContent = 'No build is open here. Start one from Home.'
    } else {
      // The board's ordinary state: the bar alone, no help line.
      missionHelp.textContent = ''
    }
    // ---- Home composer: starts something new.
    // New-repo starts are the engine's own capability (the real orchestrator
    // and the durable runtime both create repositories).
    const newRepoOffered = !deliveryPending && has(engine.canStartNewRepo?.bind(engine), false) &&
      (engine instanceof RuntimeEngine || !engine.hasPendingDecision)
    newRepoChip.disabled = !newRepoOffered
    modelsChip.textContent = modelsValue(deps.prefs) === 'Factory default' ? 'Factory default models' : modelsValue(deps.prefs)
    if (newRepoOn && newRepoOffered && selectGitHubNow(deps.githubHost, deps.keys.github) === null) {
      // Only the missing piece is said: with GitHub through the paired host
      // or a token the board's composer carries no help line.
      homeHelp.textContent = COPY.real.needGithub
    } else if (!engine.acceptsGoal() && !(engine instanceof RuntimeEngine)) {
      homeHelp.textContent = 'One build runs at a time here. Turn on New repo to start it somewhere new; Spriite offers to stop the current build first.'
    } else {
      homeHelp.textContent = ''
    }
    renderVoiceDrafts()
  }

  // ----------------------------------------------------------- sending

  /** The legacy engine runs one build: say so, and offer the one honest way through. */
  const offerStopAndStart = (): void => {
    const stop = el('button', { className: 'btn small', textContent: 'Stop it and start the new repository' })
    stop.onclick = () => {
      deps.runAction({ id: 'restart', label: 'Restart', kind: 'command' })
      sendHome()
    }
    sayNote.className = 'msg err'
    sayNote.replaceChildren(
      el('span', { textContent: 'A build is still running in its repository. Stop it first to start a new one. ' }),
      stop,
    )
    missionNote.className = 'msg err'
    missionNote.textContent = 'A build is still running in its repository. Stop it first to start a new one.'
  }

  /** "Start something new": always a new build, never a message to the open one. */
  const sendHome = (): void => {
    const text = homeInput.value.trim()
    if (!text) return
    let engine = deps.engine()
    // The durable runtime runs builds side by side: a new build starts from
    // the home, and the one on screen keeps running there.
    if (!engine.acceptsGoal() && engine instanceof RuntimeEngine) engine.showHome?.()
    engine = deps.engine()
    const asNewRepo = newRepoOn && !newRepoChip.disabled && has(engine.canStartNewRepo?.bind(engine), false)
    if (!asNewRepo && !engine.acceptsGoal()) {
      if (!(engine instanceof RuntimeEngine) && !engine.hasPendingDecision) {
        setNote('One build runs at a time here. Turn on New repo to start this goal somewhere new, or open the current build to message it.', 'err')
      } else {
        setNote('Spriite is waiting on an answer first. Answer it in Needs you, then start the new build.', 'err')
      }
      return
    }
    const went = asNewRepo ? engine.sayNewRepo(text, '') : engine.say(text)
    // Nothing was taken (busy, or the engine cannot act): keep the text so the
    // owner does not lose it to a cleared box (spec §10: no false success).
    if (went === 'none') {
      homeInput.value = text
      if (asNewRepo && !(engine instanceof RuntimeEngine) && !engine.acceptsGoal() && !engine.hasPendingDecision) {
        offerStopAndStart()
      } else {
        setNote('Spriite cannot take a message right now. Try again in a moment.', 'err')
      }
      render(lastView)
      return
    }
    lastSent = { text, newRepo: asNewRepo, home: true }
    homeInput.value = ''
    // One goal, one repository: unless new repos are the saved default, the
    // chip never fires twice by accident.
    if (asNewRepo && deps.keys.repoMode !== 'per_idea') setNewRepo(false)
    if (went === 'goal' && asNewRepo) {
      const snap = engine.snapshot()
      const blocked = 'blockedStart' in snap ? snap.blockedStart : null
      setNote(blocked === 'github'
        ? COPY.real.needGithub
        : 'Got it. Spriite is creating a new repository for this goal, then planning.', blocked === 'github' ? 'err' : 'ok')
    } else {
      setNote(went === 'goal' ? 'Got it. Spriite is starting a Factory build to plan this.'
        : went === 'decision' ? 'Answer sent.'
          : 'Sent. The reply will show on your glasses and in the build.', 'ok')
    }
    render(lastView)
  }
  homeSend.onclick = sendHome
  homeInput.addEventListener('keydown', (ev) => {
    const k = ev as KeyboardEvent
    if (k.key === 'Enter' && !k.shiftKey) {
      k.preventDefault?.()
      sendHome()
    }
  })

  /** The Mission bar: the existing steer/answer path, with frozen typed ownership. */
  const sendMessage = (): void => {
    const text = missionInput.value.trim()
    if (!text) return
    const engine = deps.engine()
    const currentTarget = typedIdentity()
    const nativeSnapshot = has((engine as ReturnType<NativePhoneDeps['engine']>).nativeSnapshot?.bind(engine), null)
    if ((typedTarget && (typedTarget.engine !== engine || typedTarget.key !== currentTarget.key)) ||
      has(engine.nativeQuestionLink?.bind(engine), null) || engine.hasUnconfirmedDelivery ||
      nativeSnapshot?.attention.some(a => a.state !== 'resolved')) {
      setNote('Draft kept. The selected session/question changed or cannot accept ordinary messages. Return to the original target; nothing was sent.', 'err')
      return
    }
    const before = engine.snapshot()
    const beforeView = engine.currentView
    const scopeReview = beforeView?.type === 'scene' && beforeView.scene.actions.some(a => a.id === 'confirm_chat_build')
    const availableScope = (engine instanceof RealOrchestrator && engine.canReviewChatBuild()) ||
      (beforeView?.type === 'scene' && beforeView.scene.actions.some(a => a.id === 'review_chat_build'))
    const localBuildTurn = 'real' in before && before.real &&
      ((scopeReview && (isBuildApproval(text) || isBuildCancellation(text))) ||
        (isScopeReviewDirective(text) && (availableScope || scopeReview)) ||
        (isBuildDirective(text) && 'sessionId' in before && before.sessionId !== null &&
          (!engine.hasPendingDecision || before.decisionGate)))
    const went = engine.say(text)
    if (went === 'none') {
      missionInput.value = text
      setNote('Spriite cannot take a message right now. Try again in a moment.', 'err')
      render(lastView)
      return
    }
    lastSent = { text, newRepo: false, home: false }
    missionInput.value = ''
    typedTarget = null
    setNote(
      localBuildTurn ? 'Build request handled locally. Check the build card for its next step.'
        : went === 'goal' ? 'Got it. Spriite is starting a Factory build to plan this.'
          : went === 'decision' ? 'Answer sent.'
            : 'Sent. The reply will show on your glasses and in Latest.', 'ok')
    render(lastView)
  }
  missionInput.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') sendMessage()
  })

  // ============================================================ builds

  const waitingIds = (): Set<string> => {
    const asks = deps.pendingAsks ? deps.pendingAsks() : has(deps.engine().pendingAsks?.bind(deps.engine()), [])
    return new Set(asks.map((a) => a.missionId))
  }

  type BuildRow = ReturnType<FactoryEngine['listBuilds']>[number]
  const buildRow = (b: BuildRow, openable: boolean, waiting: Set<string>): HTMLButtonElement => {
    const dot = el('span', { className: 'ph-build-dot' })
    dot.style.background = BUILD_DOT[buildState(b, waiting)]
    const btn = el('button', { className: 'ph-build', type: 'button' }, [
      dot,
      el('span', { className: 'ph-build-text' }, [
        el('span', { className: 'ph-build-name', textContent: b.title }),
        el('span', { className: 'ph-build-status', textContent: rowNote(b.note) }),
      ]),
      el('span', { className: `ph-src ${b.kind}`, textContent: SOURCE_LABEL[b.kind] }),
    ])
    btn.disabled = !openable
    btn.onclick = () => openBuildRow(b)
    return btn
  }

  const openBuildRow = (b: BuildRow): void => {
    const engine = deps.engine()
    // The engine's list can change between this render and the tap (a cloud
    // poll reorders rows after the 2-second beat drew them), so the tapped
    // row is re-resolved at click time: an index captured at render could
    // open whichever build slid into its place. No row found means the build
    // left the list — say that, never open a different one.
    const current = engine.listBuilds()
    const idx = current.findIndex(
      (row) => row.title === b.title && row.note === b.note && row.kind === b.kind && row.missionId === b.missionId,
    )
    if (idx === -1) {
      renderBuilds()
      setNote('That build is no longer in the list. It just refreshed.')
      return
    }
    // openBuild can answer true while nothing opened anywhere: a finished
    // runtime mission has no live actor, so no card is emitted. A view the
    // engine emits during the call is the only proof an open happened.
    const before = lastView
    if (!engine.openBuild(idx)) {
      setNote('Finish or leave the current build first. Back on the glasses leaves it.', 'err')
      return
    }
    if (lastView === before) {
      // The row's mission is named and its record is kept, so show the
      // history it left. A record that carries nothing is no record: an
      // empty history would claim one nobody kept.
      const missionId = b.missionId
      const record = missionId !== undefined && deps.chatLogFor ? deps.chatLogFor(missionId) : null
      if (record !== null && missionId !== undefined && (record.title !== null || (record.log?.length ?? 0) > 0)) {
        historyMission = { missionId, title: b.title }
        show('mission')
        setNote('That build already finished. Its session history is open.')
        return
      }
      setNote(COPY.voice.finishedRecord)
      return
    }
    historyMission = null
    setNote(`Opened "${b.title}" on your glasses.`, 'ok')
    show('mission')
  }

  const renderBuilds = (): void => {
    const engine = deps.engine()
    const builds = has(engine.listBuilds?.bind(engine), [] as BuildRow[])
    const counts = { all: builds.length, local: 0, factory: 0, cursor: 0 }
    for (const b of builds) counts[b.kind]++
    if (filter !== 'all' && counts[filter] === 0) filter = 'all'
    const openable = has(engine.canOpenBuilds?.bind(engine), true)
    const waiting = waitingIds()

    filterBar.replaceChildren(
      ...(['all', 'local', 'factory', 'cursor'] as const)
        .filter((f) => f === 'all' || counts[f] > 0)
        .map((f) => {
          const b = el('button', {
            className: `ph-chip filter${filter === f ? ' on' : ''}`, type: 'button',
            textContent: `${f === 'all' ? 'All' : SOURCE_LABEL[f]} ${counts[f]}`,
          })
          b.setAttribute('aria-pressed', filter === f ? 'true' : 'false')
          b.onclick = () => {
            filter = f
            renderBuilds()
          }
          return b
        }),
    )
    filterBar.hidden = builds.length === 0

    const empty = (): HTMLElement[] =>
      [el('p', { className: 'empty', textContent: 'No builds yet. Your Spriite, Factory, and Cursor builds will show up here.' })]
    const shown = builds.filter((b) => filter === 'all' || b.kind === filter)
    buildsList.replaceChildren(...(shown.length > 0 ? shown.map((b) => buildRow(b, openable, waiting)) : empty()))
    homeBuilds.replaceChildren(...(builds.length > 0
      ? builds.slice(0, HOME_BUILDS).map((b) => buildRow(b, openable, waiting))
      : empty()))
    seeAll.hidden = builds.length === 0
    buildsHint.textContent = !openable && builds.length > 0
        ? 'A build is open on your glasses. Leave it to open another.'
        : 'Spriite builds resume where they left off. Factory and Cursor builds open in watch mode.'
  }

  // ========================================================= needs you

  /** One answer the Needs you card and the Ask sheet can send. */
  interface AnswerOption { label: string; send: () => void }

  const sameSelection = (current: EngineView, view: EngineView): boolean =>
    current.type === 'selection' && view.type === 'selection' &&
    current.purpose === view.purpose && current.title === view.title &&
    current.items.length === view.items.length &&
    current.items.every((row, index) => row === view.items[index])

  /** The focused build's open question, with the answers it offers. */
  const focusedQuestion = (): { title: string; question: string; options: AnswerOption[]; who: string; at: number | null } | null => {
    const engine = deps.engine()
    const view = lastView
    // A question's own card, or its detail card (Explain on a question):
    // the question still waits, so Needs you still shows it.
    const isAsk = (v: EngineView | null): boolean =>
      v?.type === 'scene' && (v.scene.kind === 'decision' || v.scene.kind === 'decision_detail')
    if (view === null || !engine.hasPendingDecision) {
      if (!isAsk(view)) return null
    }
    let snap: unknown = null
    try { snap = engine.snapshot() } catch { snap = null }
    const text = (snap as { decisionText?: string } | null)?.decisionText ?? ''
    const log = has(engine.chatLog?.bind(engine), [] as Array<{ who: ChatWho; text: string; at: number }>)
    const asked = [...log].reverse().find((e) => e.who !== 'you')
    const title = sessionTitleOf(engine) ?? 'This build'
    if (view?.type === 'selection' && view.purpose === 'decision') {
      // The last row is "speak another answer": Say it covers it.
      const items = view.items.slice(0, -1)
      return {
        title, question: text || view.title, who: SPEAKER_LABEL.lead, at: asked?.at ?? null,
        options: items.map((label, i) => ({
          label,
          send: () => {
            const current = engine.currentView
            if (!sameSelection(current, view)) {
              render(current)
              setNote('The question changed before your answer was sent. Nothing was sent.', 'err')
              return
            }
            engine.chooseDecisionList(i)
            setNote('Answer sent.', 'ok')
          },
        })),
      }
    }
    if (view?.type === 'scene' && isAsk(view)) {
      const s = view.scene
      const actions = s.actions.filter((a) => a.kind === 'command' && a.id !== 'back')
      return {
        title, question: s.utterance || text,
        who: s.speaker ? SPEAKER_LABEL[s.speaker] : SPEAKER_LABEL.lead, at: asked?.at ?? null,
        options: actions.map((a) => ({ label: a.label, send: () => {
          runCardAction(a, null)
          setNote('Answer sent.', 'ok')
        } })),
      }
    }
    return null
  }

  /** One X action in flight at a time; a failure is reported, never dropped. */
  let xWorking = false
  const xRun = async (working: string, action: () => Promise<string | { text: string; ok: boolean }>): Promise<void> => {
    if (xWorking) {
      // One action at a time; a second tap is told so, never silently
      // ignored (a stranded tap reads as a dead button).
      setNote('Still finishing the last X request — one moment.')
      return
    }
    xWorking = true
    setNote(`${working}...`)
    renderNeeds()
    try {
      const outcome = await action()
      setNote(typeof outcome === 'string' ? outcome : outcome.text, typeof outcome === 'string' || outcome.ok ? 'ok' : 'err')
    } catch {
      setNote('X could not complete this. Check the connection and try again.', 'err')
    } finally {
      xWorking = false
      renderNeeds()
    }
  }

  const openAsk = (): void => {
    const q = focusedQuestion()
    if (q === null) return
    askOptions = q.options
    askChoice = 0
    askLabel.textContent = `${q.who} asks`
    laterHint = q.who === SPEAKER_LABEL.spriite ? 'Nothing moves until you answer' : 'The Lead keeps building around it'
    askSheet.el.querySelector?.('[role="dialog"]')?.setAttribute('aria-label', `${q.who} asks a question`)
    askMeta.textContent = `${q.title} · ${q.at !== null ? ageOf(q.at) : 'just now'}`
    askQuestion.textContent = q.question
    askExplain.hidden = true
    renderAskRadios()
    askSheet.open()
  }
  /** "Let me decide later" is always the last choice: it closes and leaves the question open. */
  const LATER = -1
  /**
   * Its hint (Ask.dc.html: the Lead keeps building around a Lead question).
   * Spriite's own gates hold the build until answered: nothing builds around them.
   */
  let laterHint = 'The Lead keeps building around it'
  const renderAskRadios = (): void => {
    const rows: Array<{ index: number; label: string; hint: string }> = [
      ...askOptions.map((o, i) => ({ index: i, label: o.label, hint: '' })),
      { index: LATER, label: 'Let me decide later', hint: laterHint },
    ]
    askRadios.replaceChildren(...rows.map((r) => {
      const on = askChoice === r.index
      const b = el('button', { className: 'ph-radio', type: 'button' }, [
        el('span', { className: 'ph-radio-ring' }, [el('i')]),
        el('span', { className: 'ph-radio-text' }, [
          el('span', { className: 'ph-radio-label', textContent: r.label }),
          el('span', { className: 'ph-radio-hint', textContent: r.hint }),
        ]),
      ])
      b.setAttribute('role', 'radio')
      b.setAttribute('aria-checked', on ? 'true' : 'false')
      b.onclick = () => {
        askChoice = r.index
        renderAskRadios()
      }
      return b
    }))
  }
  askSend.onclick = () => {
    if (askChoice === LATER || askOptions[askChoice] === undefined) {
      askSheet.close()
      setNote('Left open. The question stays on your glasses and in Needs you.')
      return
    }
    const option = askOptions[askChoice]
    askSheet.close()
    option.send()
    // An option's own send reports any failure; reaching here it went out.
    if (!sayNote.textContent || sayNote.textContent.startsWith('Left open.')) setNote('Answer sent.', 'ok')
  }
  askSay.onclick = () => {
    askSheet.close()
    deps.runAction({ id: 'talk', label: 'Talk', kind: 'local_capture' })
  }
  /** See all options for a build not on the glasses brings it in first. */
  let seeAllFor: (() => void) | null = null
  needsAll.onclick = () => (seeAllFor ?? openAsk)()

  /** Missions asking a question, held X posts, and held native requests. */
  const renderNeeds = (): void => {
    seeAllFor = null
    const engine = deps.engine()
    // The Needs-you Show follows the same engine its banner reads from.
    const showMission = deps.showMission ?? ((missionId: string) => engine.showMission(missionId))
    const rows: HTMLElement[] = []
    let head: { meta: string; question: string; options: AnswerOption[]; all: boolean } | null = null
    let waiting = 0

    const focused = focusedQuestion()
    if (focused !== null) {
      waiting++
      head = { meta: `${focused.title} · ${focused.who}`, question: focused.question, options: focused.options.slice(0, 2), all: true }
    }
    // A native request on the focused build: its exact controls live on the build's page.
    const native = has((engine as ReturnType<NativePhoneDeps['engine']>).nativeSnapshot?.bind(engine), null)
    const openNative = native?.attention.filter((a) => a.state !== 'resolved') ?? []
    if (openNative.length > 0) {
      waiting++
      const first = openNative[0]
      const review: AnswerOption = { label: 'Review request', send: () => { historyMission = null; show('mission') } }
      if (head === null) head = { meta: `${sessionTitleOf(engine) ?? 'This build'} · Factory`, question: `${first.kind}: ${first.title}`, options: [review], all: false }
      else rows.push(rowWith(`${first.kind}: ${first.title}`, 'A Factory request on this build. Its exact answer controls are on the build.', 'Review request', review.send))
    }
    // The banner reads the durable runtime's asks: a waiting build must
    // never hide behind whatever the HUD shows.
    const asks = deps.pendingAsks ? deps.pendingAsks() : has(engine.pendingAsks?.bind(engine), [])
    for (const ask of asks) {
      // The focused build's own question is already the card's head.
      if (focused !== null && ask.title === focused.question) continue
      waiting++
      const showIt = (): boolean => {
        if (!showMission(ask.missionId)) {
          setNote('That build has no live records here. It will surface on the home list.', 'err')
          return false
        }
        setNote('Opened the asking build. Answer it here or on your glasses.', 'ok')
        return true
      }
      const asker = SPEAKER_LABEL[ask.who ?? 'lead'] ?? SPEAKER_LABEL.lead
      // The ask's title is its question; the build is named by its row.
      const build = has(engine.listBuilds?.bind(engine), [] as BuildRow[]).find((b) => b.missionId === ask.missionId)?.title ?? 'A build'
      if (head === null) {
        // Bring the asking build in; its options then open in the Ask sheet.
        const answer = () => {
          if (!showIt()) return
          if (focusedQuestion() !== null) openAsk()
        }
        const offered = 'options' in ask && Array.isArray(ask.options) ? ask.options : []
        if (offered.length === 0) {
          // The engine did not say what this question offers: one Answer
          // that brings the build in and opens every option in the Ask sheet.
          head = { meta: `${build} · ${asker}`, question: ask.title, options: [{ label: 'Answer', send: answer }], all: false }
          continue
        }
        // As Home.dc.html draws it: the first two answers and See all options.
        // A tap brings the build in first; the answer goes only to the exact
        // question it was drawn for (same answers in the same order).
        const pick = (label: string, index: number) => () => {
          if (!showIt()) return
          const q = focusedQuestion()
          const same = q !== null && q.options.length === offered.length &&
            q.options.every((o, k) => o.label === offered[k])
          if (!same || q.options[index]?.label !== label) {
            if (q !== null) openAsk()
            setNote('The question changed before your answer was sent. Nothing was sent; choose again.', 'err')
            return
          }
          q.options[index].send()
          // The answer went out: the note says so, not "opened the build".
          setNote('Answer sent.', 'ok')
        }
        head = {
          meta: `${build} · ${asker}`, question: ask.title,
          options: offered.slice(0, 2).map((label, i) => ({ label, send: pick(label, i) })),
          all: true,
        }
        seeAllFor = answer
        continue
      }
      const b = el('button', { className: 'row' }, [
        el('div', { className: 't' }, [
          el('b', { textContent: build }),
          el('span', { textContent: ask.title }),
        ]),
        el('span', { className: 'chev', textContent: '›' }),
      ])
      b.onclick = showIt
      rows.push(b)
    }
    waiting += renderXRows(rows)
    // Held native intents: reviewed and approved only in the exact native
    // form (Settings > Advanced > Factory-native details).
    const held = deps.heldNativeIntents?.() ?? []
    for (const h of held) {
      waiting++
      rows.push(rowWith(h.goal, `${h.origin === 'x' ? 'From X' : 'Saved request'} · held. Nothing runs until you review and approve it.`, 'Review', () => {
        show('settings')
        settings.openAdvanced(0)
      }))
    }

    needsMeta.textContent = head?.meta ?? (rows.length > 0 ? 'Waiting for your OK' : '')
    needsQuestion.textContent = head?.question ?? ''
    needsQuestion.hidden = head === null
    needsOptions.replaceChildren(...(head?.options ?? []).map((o, i) => {
      const b = el('button', { className: `ph-amber-btn ${i === 0 ? 'solid' : 'outline'}`, type: 'button', textContent: o.label })
      b.onclick = () => o.send()
      return b
    }))
    needsOptions.className = `ph-needs-opts${(head?.options.length ?? 0) === 1 ? ' one' : ''}`
    needsOptions.hidden = (head?.options.length ?? 0) === 0
    needsAll.hidden = !(head?.all === true)
    const wasEnd = nearEnd(needsRows, 'bottom')
    needsRows.replaceChildren(...rows)
    needsRows.hidden = rows.length === 0
    needsCard.hidden = head === null && rows.length === 0
    if (wasEnd) snapEnd(needsRows, 'bottom')
    navBadge.textContent = waiting > 0 ? String(waiting) : ''
    navBadge.hidden = waiting === 0 || screen === 'home'
  }

  const rowWith = (title: string, detail: string, action: string, run: () => void): HTMLElement => {
    const b = el('button', { className: 'btn small', textContent: action })
    b.onclick = run
    return el('div', { className: 'row stack' }, [
      el('div', { className: 't' }, [el('b', { textContent: title }), el('span', { textContent: detail })]),
      el('div', { className: 'btns' }, [b]),
    ])
  }

  /** Held X posts, each with its existing confirm and dismiss rules. Returns how many wait. */
  const renderXRows = (parts: HTMLElement[]): number => {
    let waiting = 0
    const connection = deps.xConnection ?? null
    const x = connection?.health() ?? null
    if (connection === null || x === null || x.needsOwner.length === 0) return 0
    for (const r of x.needsOwner) {
      if (r.followupDelivery === 'unknown') {
        // Capture the displayed attempt, not a mutable receipt's next one.
        // These words already target a build; repository/build controls
        // cannot safely resolve an uncertain delivery.
        const key = r.dedupeKey
        const attempt = r.followupAttempt ?? 0
        const resend = el('button', {
          className: 'btn small', textContent: 'Resend (may duplicate)',
          disabled: xWorking || !connection.active,
        })
        const dismiss = el('button', {
          className: 'btn small secondary', textContent: 'Dismiss', disabled: xWorking,
        })
        resend.onclick = () => {
          if (!connection.active) return
          void xRun('Saving resend', async () => {
            const saved = await connection.resendFollowup(key, attempt)
            return saved
              ? { text: 'Saved for the same build; waiting to send.', ok: true }
              : { text: 'Delivery changed or resend could not be saved. Check the receipt before trying again.', ok: false }
          })
        }
        dismiss.onclick = () => void xRun('Dismissing', async () => {
          const saved = await connection.dismiss(key)
          return { text: saved ? 'Dismissed.' : 'Could not save the dismissal.', ok: saved }
        })
        waiting++
        parts.push(el('div', { className: 'row stack' }, [
          el('div', { className: 't' }, [
            el('b', { textContent: r.instruction || 'A follow-up for this build' }),
            el('span', { textContent: r.reason ?? 'Delivery could not be confirmed. Resending may add it twice.' }),
          ]),
          el('div', { className: 'btns' }, [resend, dismiss]),
        ]))
        continue
      }
      // A control post can never be confirmed from here (confirm always
      // re-holds it), so it is informational: no Build it button.
      if (classifyIntent(r.instruction) === 'control') {
        parts.push(
          el('div', { className: 'row' }, [
            el('div', { className: 't' }, [
              el('b', { textContent: r.instruction }),
              el('span', { textContent: 'Controls stay on Spriite: pause or restart the build from its own card.' }),
            ]),
          ]),
        )
        continue
      }
      const no = el('button', { className: 'btn small secondary', textContent: 'Not now', disabled: xWorking })
      no.onclick = () =>
        void xRun('Dismissing', async () =>
          (await connection.dismiss(r.dedupeKey)) ? 'Dismissed.' : 'Could not save the dismissal.',
        )
      const title = r.instruction || 'A post that points at another post'
      const started = (res: { status: string; reason?: string }): string =>
        res.status === 'submitted'
          // Native-mode receipts are saved but held; their reason says so.
          ? res.reason ?? 'Started. The build is in the Builds list.'
          : res.status === 'extended'
            ? 'Added to the running build it replied to.'
            : `Not started (${res.status}${res.reason ? `: ${res.reason}` : ''}).`
      if (r.projectName !== undefined) {
        // A named project: the owner picks an existing repository that
        // matched the name, or a fresh one named after the project.
        waiting++
        const picks = (r.repositoryChoices ?? []).map((url) => {
          const b = el('button', { className: 'btn small', textContent: url.replace(/^https:\/\/github\.com\//, ''), disabled: xWorking })
          b.onclick = () => void xRun('Starting', async () => started(await connection.confirm(r.dedupeKey, { repository: url })))
          return b
        })
        const fresh = el('button', { className: 'btn small', textContent: 'New repo', disabled: xWorking })
        fresh.onclick = () => void xRun('Starting', async () => started(await connection.confirm(r.dedupeKey, { newRepository: true })))
        parts.push(
          el('div', { className: 'row stack' }, [
            el('div', { className: 't' }, [
              el('b', { textContent: title }),
              el('span', { textContent: r.reason ?? `Is ${r.projectName || 'this'} a new repository or one you have?` }),
            ]),
            el('div', { className: 'btns' }, [...picks, fresh, no]),
          ]),
        )
        continue
      }
      const ok = el('button', { className: 'btn small', textContent: 'Build it', disabled: xWorking })
      waiting++
      // The same repository the intake would route to: the post's own, the
      // repository designated for X, or none — then the build gets a new
      // repository of its own. Never the repository selected in the app.
      const repository = r.repository ?? destinationRepositoryFrom(r.instruction) ?? (deps.prefs.xDefaultRepository || undefined)
      ok.onclick = () =>
        void xRun('Confirming', async () => started(await connection.confirm(r.dedupeKey, { repository })))
      parts.push(
        el('div', { className: 'row' }, [
          el('div', { className: 't' }, [
            el('b', { textContent: title }),
            el('span', {
              textContent: repository
                ? `Builds in ${repository.replace(/^https:\/\/github\.com\//, '')}`
                // This row confirms with the one repository it shows — it
                // cannot ask for one, so the label must say where one is
                // chosen, never promise a question that never comes.
                : 'Builds in a new repository of its own (the post names none).',
            }),
          ]),
          el('div', { className: 'btns' }, [ok, no]),
        ]),
      )
    }
    return waiting
  }

  // ================================================================ feed

  const renderFeed = (): void => {
    // The pill counts what renders: every kept entry is drawn (FEED_KEEP
    // caps both ends), and an empty log says so instead of showing nothing.
    feedCount.textContent = String(feed.length)
    const wasTop = nearEnd(feedList, 'top')
    feedList.replaceChildren(
      ...(feed.length > 0
        ? feed.map((e) =>
            el('li', {}, [
              el('time', { textContent: clock(e.at) }),
              el('div', { className: 'w' }, [
                el('b', { textContent: e.label }),
                el('span', { textContent: e.text }),
              ]),
            ]),
          )
        : [el('li', { className: 'w' }, [el('span', { textContent: 'Cards land here as they happen.' })])]),
    )
    if (wasTop) snapEnd(feedList, 'top')
  }

  // ============================================================== render

  const render = (view: EngineView | null): void => {
    if (view !== null) {
      renderMirror(view)
      if (screen === 'mission' || historyMission === null) renderMission()
    }
    renderComposer()
  }

  // ======================================================== first run

  /**
   * First run (contract C4/C6): until setup is complete, the setup flow
   * covers the app; Finish setup on Repo completes it.
   */
  let flow: SetupFlowHandle | null = null
  /** What the open flow made inert, so closing it restores exactly that. */
  let flowInert: HTMLElement[] = []
  const closeFlow = (): void => {
    flow?.destroy()
    flow = null
    setupHost.replaceChildren()
    setupHost.hidden = true
    for (const node of flowInert) node.inert = false
    flowInert = []
  }
  const openFlow = (entry: 'welcome' | 'pair' | 'key_only' | 'move_receive' = 'welcome'): void => {
    if (flow) {
      flow.show(entry)
      return
    }
    const host = el('div', { className: 'sp-flow' })
    setupHost.replaceChildren(host)
    setupHost.hidden = false
    // The flow covers the app: the screens and tabs behind it leave the tab
    // order and the accessibility tree (sheets opened over the flow stay live).
    for (const node of [screens, nav, fullHost]) {
      if (!node.inert) {
        node.inert = true
        flowInert.push(node)
      }
    }
    try {
      flow = setupFlow(host, {
        keys: deps.keys,
        prefs: deps.prefs,
        pairing,
        githubHost: deps.githubHost ?? null,
        context: 'first_run',
        entry,
        onExtra: async (kind) => {
          if (kind === 'x') {
            // The outcome shows on Ready (the Home note is behind the flow).
            const state = await pairing.hostXSignIn.start({ clientId: deps.prefs.xClientId || undefined }).catch(
              () => ({ state: 'failed', reason: 'no answer' }) as const)
            // Plain words for every outcome, never a raw reason code.
            const text = state.state === 'idle' ? '' : hostSignInText(state, 'your computer')
            return { text, tone: state.state === 'failed' || state.state === 'unavailable' ? 'err' : 'ok' }
          }
          // Spoken replies and Cursor take a key: their sheet opens above the
          // flow, and Ready comes back (repainted) when it closes.
          await new Promise<void>((resolve) => {
            settings.open(kind === 'voice' ? 'voice' : 'cursor', { over: 'flow', onClose: resolve })
          })
          return undefined
        },
        extraHealth: (kind) => settings.setup.health()[kind],
        onSaved: () => {
          deps.onSaved()
          settings.refreshPrefs()
          renderComposer()
        },
        onDone: () => {
          closeFlow()
          settings.refreshPrefs()
          renderComposer()
          show('home')
        },
      })
    } catch {
      // The phone never dies on a setup screen: Home stays reachable.
      closeFlow()
    }
  }

  // The glasses' connect prompts open the matching Settings sheet, or the
  // setup flow while setup is not complete.
  window.addEventListener('spriite-connect', (ev) => {
    const detail = (ev as CustomEvent<string> | undefined)?.detail
    if (!setupDone()) {
      openFlow(detail === 'factory' ? 'key_only' : 'welcome')
      return
    }
    const sheetFor: Record<string, SettingsSheetId> = { factory: 'factory', repo: 'where', github: 'github', voice: 'voice' }
    show('settings')
    if (detail !== undefined && sheetFor[detail]) settings.open(sheetFor[detail])
  })

  // Glasses cannot render Factory's native popup. Bring its exact clickable
  // phone link into view without opening it or answering on the owner's behalf.
  window.addEventListener('spriite-open-factory', () => {
    historyMission = null
    show('mission')
    menuOpen = true
    renderMenu()
    renderSession()
    const link = has(deps.engine().nativeQuestionLink?.bind(deps.engine()), null)
      ? factoryAnswer : (menu.querySelector?.<HTMLAnchorElement>('a[href]') ?? null)
    if (link) {
      link.scrollIntoView({ block: 'center', behavior: 'smooth' })
      link.focus()
    }
  })

  // ============================================================ startup

  renderFeed()
  render(null)
  renderBuilds()
  renderNeeds()
  show('home')
  if (!setupDone()) openFlow('welcome')

  /**
   * Only the focused mission's cards reach notify(): an unfocused mission's
   * phase change, a cloud row, or a held X post's state moves without
   * emitting anything the phone could mirror. Re-read them on a slow beat
   * while the page is visible: the projections are existing engine and
   * connection reads, never a new backend or a second scheduler.
   */
  window.setInterval(() => {
    if (document.visibilityState !== 'visible') return
    renderBuilds()
    renderNeeds()
    // Pause/Resume follow the durable control state, which can land after
    // the last card (a pause commit): re-read it on the same beat.
    renderMirrorButtons()
    nativePhone.refresh()
    if (screen === 'settings') settings.refresh()
  }, 2000)

  // ============================================================= handle

  return {
    retainVoiceDraft(text: string, originalTarget?: VoiceTarget): void {
      if (!text.trim()) return
      voiceDrafts.push({
        text, target: originalTarget ?? selectedVoiceTarget(),
        title: originalTarget ? `Captured target ${originalTarget.mission ?? 'home'}`
          : sessionTitleOf(deps.engine()) ?? 'Selected session',
      })
      renderVoiceDrafts()
      setNote('Nothing was sent. The full dictated message is kept in Unsent voice message below.')
    },
    refreshPrefs(): void {
      settings.refreshPrefs()
      renderComposer()
      nativePhone.refresh()
    },
    notify(view: EngineView): void {
      lastView = view
      render(view)
      const label = labelFor(view)
      const text =
        view.type === 'scene'
          ? view.scene.utterance
          : `${view.title} (${view.items.length} items)`
      const last = feed[0]
      if (!last || last.label !== label || last.text !== text) logFeed(label, text)
      renderFeed()
      renderBuilds()
      renderNeeds()
      renderSession()
      nativePhone.refresh()
    },
    notifyAsk(missionId: string, _title: string): void {
      // 'x' is a held post (rendered from the X connection's own health);
      // anything else is a mission asking the owner.
      void missionId
      renderNeeds()
    },
    notifyXStarted(goal: string): void {
      // The mission has no card of its own yet: log it, say it, and refresh
      // the lists. The log row dedupes the same way notify() does.
      const last = feed[0]
      if (last === undefined || last.label !== 'X request' || last.text !== goal) logFeed('X request', goal)
      setNote(`X request started: ${goal}. It is in the Builds list.`, 'ok')
      renderFeed()
      renderBuilds()
      renderNeeds()
      renderSession()
    },
    notifyXHeld(goal: string): void {
      const last = feed[0]
      if (last === undefined || last.label !== 'X request held' || last.text !== goal) logFeed('X request held', goal)
      setNote(`X request held: ${goal}. Review it on your phone.`, 'ok')
      renderFeed()
      renderBuilds()
      renderNeeds()
      renderSession()
    },
    notifyXExtended(goal: string): void {
      const last = feed[0]
      if (last === undefined || last.label !== 'X reply' || last.text !== goal) logFeed('X reply', goal)
      setNote(`X reply added to its build: ${goal}.`, 'ok')
      renderFeed()
      renderBuilds()
      renderNeeds()
      renderSession()
    },
    applyRestoredFeed(entries: FeedEntry[]): void {
      // A restore's feed rows arrive already validated and unioned against
      // the vault; the page unions them into the live list the same way.
      const byKey = new Map(feed.map((e) => [`${e.at}\u0000${e.label}\u0000${e.text}`, e]))
      for (const e of entries) byKey.set(`${e.at}\u0000${e.label}\u0000${e.text}`, e)
      const next = [...byKey.values()].sort((a, b) => b.at - a.at).slice(0, FEED_KEEP)
      if (next.length === feed.length && next.every((e, i) => e === feed[i])) return
      feed.length = 0
      feed.push(...next)
      renderFeed()
    },
    setGlasses(connected: boolean | null): void {
      glassesPill.className = `ph-glasses${connected === true ? ' on' : ''}`
      glassesText.textContent =
        connected === null ? 'Checking glasses' : connected ? 'Glasses on' : 'Glasses off'
    },
    notice(text: string): void {
      const notSaved = text === COPY.voice.notSaved
      if (notSaved && lastSent !== null) {
        if (lastSent.home && homeInput.value.trim() === '') {
          homeInput.value = lastSent.text
          if (lastSent.newRepo) setNewRepo(true)
        } else if (!lastSent.home && missionInput.value.trim() === '') {
          missionInput.value = lastSent.text
        }
        renderComposer()
      }
      lastSent = null
      setNote(text, notSaved ? 'err' : 'muted')
      logFeed('Spriite', text)
      renderFeed()
    },
  }
}
