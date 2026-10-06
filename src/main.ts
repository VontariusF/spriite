/**
 * Spriite — software factory for Even G2 + R1 (demo build).
 *
 * Wiring: bridge gateway -> input normalizer -> mode router -> demo factory
 * engine -> scene validation -> HUD renderer. Cloud roles (conversation
 * gateway, hud projection, mission state) run locally as a labeled simulation
 * (spec §17.2 phase E1); the cloud factory itself is a separate workstream.
 * Voice is real when the user saves an ElevenLabs key on the phone: glasses
 * PCM streams to Scribe realtime, partials caption the listening card, and
 * the settled phrase routes through a small command grammar. Without a key,
 * Talk plays the labeled demo transcript.
 *
 * Invariants honored here:
 * - createStartUpPageContainer is called exactly once (first view).
 * - Progress numbers come only from the scene's progress object.
 * - Listening shows only after the microphone actually started (G05).
 * - A blocking decision persists; no timer ever answers it (spec §8).
 * - Closing the app never cancels the mission; only Stop/Restart does (§12).
 * - Root double-tap uses the system exit confirmation (§5.1).
 * - Voice keys live only in the phone's SDK storage; never in a scene, a
 *   log, or on the glasses.
 * - A consequential voice command runs only after its readback card (§8).
 */
import type { DeviceStatus, EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { BridgeGateway } from './bridge/bridge'
import { TalkController, type TalkFinishReason } from './audio/talk'
import { COPY } from './factory/copy'
import { DemoFactory, type EngineView } from './factory/demo'
import type { FactoryEngine } from './factory/engine'
import { RealOrchestrator, type RealClients, type RealSnapshot } from './factory/real'
import type { AppEvent } from './input/events'
import { parseUtterance, sanitizeSpoken, VOICE_KEYTERMS, type VoiceCommand } from './voice/intent'
import { InputNormalizer } from './input/normalize'
import { Renderer } from './render/renderer'
import type { Scene, SceneAction, SpritePose } from './scenes/types'
import { BUDGETS, fitsWrappedLines, validateScene } from './scenes/validate'
import { AppStore, registerBackgroundState } from './state/store'
import { PrefsVault } from './state/prefs'
import { ProjectsVault } from './state/projects'
import { mountPhoneApp, type PhoneHandle } from './phone/app'
import { KeyVault } from './voice/keys'
import { mintToken, ScribeError, ScribeSession, type ScribeErrorKind } from './voice/scribe'

const gateway = new BridgeGateway()
const store = new AppStore(gateway)
const keys = new KeyVault(gateway)
const prefs = new PrefsVault(gateway)
const projects = new ProjectsVault(gateway)
// Spriite always boots the real engine; its home shows recent projects and
// connects from inside the app. The labeled demo is an explicit opt-in
// ("run the demo") and never the default; its engine is built on demand.
let realEngine: RealOrchestrator | null = null
let demoEngine: FactoryEngine | null = null
let engine: FactoryEngine // init() assigns the real engine before boot
const renderer = new Renderer(gateway)
const talk = new TalkController(gateway, {
  onTimer: (text) => void renderer.updateCaptureTimer(text),
  onFinish: (sec, reason) => void onTalkFinished(sec, reason),
  // Raw PCM also feeds the live STT session when one is running.
  onPcm: (pcm) => scribe?.push(pcm),
})
const normalizer = new InputNormalizer(handleAppEvent)

/** Commands consequential enough to park behind a readback card. */
type ConfirmCommand = Extract<VoiceCommand, 'use_it' | 'restart'>

type Displayed =
  | { type: 'scene'; scene: Scene; origin: 'engine' | 'local' }
  | { type: 'selection'; purpose: 'goal' | 'plan_detail' | 'evidence' | 'projects' }
  | null

let displayed: Displayed = null
let lastValidScene: Scene | null = null
let unsubEvents: (() => void) | null = null
let unsubDevice: (() => void) | null = null
let unsubLaunch: (() => void) | null = null
let localSeq = 0
let cleanedUp = false
// null until the first device-status report; the HUD shows the connection
// notice only on an observed drop, never a guessed one.
let glassesConnected: boolean | null = null
// Live voice (bring-your-own-key ElevenLabs Scribe). `scribe` is the session
// for the capture in flight; `liveVoice` says this turn is real STT, not the
// labeled demo script. `pendingVoice` parks a consequential command behind
// its readback card; nothing runs without the confirm (spec §8).
let scribe: ScribeSession | null = null
let liveVoice = false
let pendingVoice: ConfirmCommand | null = null
let lastHintAt = 0
let lastHintText = ''
// Phone companion (full viewership + control of the live engine).
let phone: PhoneHandle | null = null

// Background-state registration happens at module init, before any state
// mutation (see background-state skill rules).
registerBackgroundState(store)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ------------------------------------------------------------- engine output

let lastFocusKey = ''

function viewFocusKey(view: EngineView): string {
  return view.type === 'scene'
    ? `scene:${view.scene.kind}:${view.scene.actions.map((a) => a.id).join(',')}`
    : `list:${view.purpose}:${view.items.join('\n')}`
}

function onEngineView(view: EngineView): void {
  const snap = engine.snapshot()
  store.engineSnapshot = snap
  store.scheduleSave()
  // Recent-projects history: real missions only (the demo never lands here).
  if (engine === realEngine) projects.saveActive(snap as RealSnapshot)
  phone?.notify(view) // the phone companion mirrors every card
  // A fresh card focuses its primary action. The engine also re-emits the
  // same card (polls, status ticks); resetting focus then would move the
  // highlight under the user's finger and fire the wrong action on tap.
  const key = viewFocusKey(view)
  if (key !== lastFocusKey) store.focusIdx = 0
  lastFocusKey = key
  if (store.uiMode !== 'scene') return // a local capture owns the display
  void presentEngineView(view)
}

async function presentEngineView(view: EngineView): Promise<void> {
  if (glassesConnected === false) return // the connection notice owns the HUD (G36)
  // Leaving a local card: its focus index means nothing on the engine card.
  if (displayed?.type === 'scene' && displayed.origin === 'local') store.focusIdx = 0
  if (view.type === 'scene') {
    const issues = validateScene(view.scene, 'engine')
    if (issues.length > 0) {
      // A scene that fails validation never reaches the renderer (G39).
      console.error('[scene] rejected by validator:', issues)
      if (lastValidScene) {
        displayed = { type: 'scene', scene: lastValidScene, origin: 'engine' }
        await renderer.present({ type: 'scene', scene: lastValidScene }, store.focusIdx)
      }
      return
    }
    lastValidScene = view.scene
    displayed = { type: 'scene', scene: view.scene, origin: 'engine' }
  } else {
    displayed = { type: 'selection', purpose: view.purpose }
  }
  try {
    await renderer.present(view, store.focusIdx)
  } catch (e) {
    console.error('[render] present failed:', e)
  }
}

// -------------------------------------------------------------- local scenes

interface LocalSceneSpec {
  kind: Scene['kind']
  pose: SpritePose
  utterance: string
  status: string
  actions: SceneAction[]
}

/** Local cards are observed device truth: no mission, no progress (spec §11.2). */
function buildLocalScene(o: LocalSceneSpec): Scene {
  localSeq += 1
  return {
    schemaVersion: 1,
    sceneId: `${o.kind}_local_${localSeq}`,
    sceneRevision: localSeq,
    missionId: null,
    stateSequence: localSeq,
    kind: o.kind,
    spritePose: o.pose,
    contextLabel: COPY.contextSprite,
    utterance: o.utterance,
    status: o.status,
    progress: null,
    actions: o.actions,
    evidenceIds: [],
    generatedAt: new Date().toISOString(),
    demo: true,
    transientMs: 0,
  }
}

function micErrorScene(): Scene {
  return buildLocalScene({
    kind: 'mic_error', pose: 'repair',
    utterance: COPY.micError.utterance, status: COPY.micError.status, actions: COPY.micError.actions,
  })
}

function transcribingScene(live: boolean): Scene {
  const src = live ? COPY.transcribingLive : COPY.transcribing
  return buildLocalScene({
    kind: 'transcribing', pose: 'waiting', utterance: src.utterance, status: src.status, actions: src.actions,
  })
}

function connectionLostScene(): Scene {
  return buildLocalScene({
    kind: 'connection_lost', pose: 'disconnected',
    utterance: COPY.connectionLost.utterance, status: COPY.connectionLost.status, actions: COPY.connectionLost.actions,
  })
}

/** Free speech the engine cannot act on, quoted with what was heard. */
function voiceHeardScene(utterance: string): Scene {
  return buildLocalScene({
    kind: 'voice_heard', pose: 'waiting', utterance, status: COPY.voice.heardStatus, actions: COPY.voice.heardActions,
  })
}

/** Readback for a consequential command; only the confirm action runs it (§8). */
function voiceConfirmScene(command: ConfirmCommand): Scene {
  return buildLocalScene({
    kind: 'voice_confirm', pose: 'asking',
    utterance: command === 'use_it' ? COPY.voice.confirmUseIt : COPY.voice.confirmRestart,
    status: COPY.voice.confirmStatus, actions: COPY.voice.confirmActions,
  })
}

function voiceErrorScene(kind: ScribeErrorKind): Scene {
  return buildLocalScene({
    kind: 'voice_error', pose: 'repair',
    utterance: COPY.voice.errors[kind], status: COPY.voice.errorStatus, actions: COPY.voice.errorActions,
  })
}

/** Longest form of `text` that still fits `maxLines` wrapped lines. */
function fitLines(text: string, maxLines: number): string {
  if (fitsWrappedLines(text, BUDGETS.utterance.width, maxLines)) return text
  const words = text.split(' ')
  while (words.length > 1) {
    words.pop()
    const shortened = `${words.join(' ')}...`
    if (fitsWrappedLines(shortened, BUDGETS.utterance.width, maxLines)) return shortened
  }
  return text
}

/**
 * The "I heard ..." card: quoted speech plus the verdict, squeezed into the
 * utterance budget. Overlong speech falls back to the verdict alone.
 */
function heardUtterance(text: string): string {
  const w = BUDGETS.utterance.width
  const lines = BUDGETS.utterance.lines
  const said = text.replace(/[.?!]+$/, '')
  const full = `${COPY.voice.heardPrefix}${said}. ${COPY.voice.cantActYet}`
  if (fitsWrappedLines(full, w, lines)) return full
  const clipped = fitLines(`${said}.`, 2)
  if (clipped !== `${said}.`) {
    const squeezed = `${COPY.voice.heardPrefix}${clipped} ${COPY.voice.cantActYet}`
    if (fitsWrappedLines(squeezed, w, lines)) return squeezed
  }
  return COPY.voice.cantActYet
}

async function presentLocalScene(scene: Scene): Promise<void> {
  const issues = validateScene(scene, 'local')
  if (issues.length > 0) {
    console.error('[scene] local scene rejected:', issues)
    return
  }
  console.log(`[scene] kind=${scene.kind} seq=${scene.stateSequence} rev=${scene.sceneRevision} local=1`)
  displayed = { type: 'scene', scene, origin: 'local' }
  store.focusIdx = 0
  try {
    await renderer.present({ type: 'scene', scene }, 0)
  } catch (e) {
    console.error('[render] local present failed:', e)
  }
}

// ---------------------------------------------------------------- talk flow

async function startTalk(): Promise<void> {
  if (store.uiMode !== 'scene') return
  const key = keys.elevenLabs
  let session: ScribeSession | null = null
  if (key) {
    // The session exists before the mic opens so no chunk is lost; audio
    // pushed while the token and socket are still setting up is buffered.
    const s = new ScribeSession({
      onPartial: (full) => onVoicePartial(full),
      onCommit: (_seg, full) => void onVoiceCommitted(s, full),
      onError: (e) => void onVoiceError(s, e),
    })
    session = s
  }
  // Confirm the microphone started before showing Listening (G05, §10.2).
  const ok = await talk.start()
  if (!ok) {
    session?.abort()
    await presentLocalScene(micErrorScene())
    return
  }
  liveVoice = session !== null
  scribe = session
  store.uiMode = 'listening' // owns input while the session is still opening
  if (session) {
    console.log('[voice] live capture: ElevenLabs Scribe')
    try {
      await session.start(() => mintToken(key), { keyterms: VOICE_KEYTERMS, languageCode: 'en' })
    } catch (e) {
      // The turn cannot transcribe: stop the mic, say so, keep nothing.
      session.abort()
      scribe = null
      liveVoice = false
      const kind: ScribeErrorKind = e instanceof ScribeError ? e.kind : 'service'
      if (talk.isActive) {
        await talk.finish('lifecycle')
        store.uiMode = 'scene'
        await presentLocalScene(voiceErrorScene(kind))
      }
      return
    }
  }
  lastHintAt = 0
  lastHintText = ''
  if (store.uiMode !== 'listening' || !talk.isActive) return // the turn already ended
  await renderer.presentListening(
    'listening',
    liveVoice ? COPY.listening.hintLive : COPY.listening.hint,
    '0:00 of 0:30',
    liveVoice ? COPY.listening.noteLive : COPY.listening.note,
    liveVoice ? COPY.listening.contextLive : COPY.listening.poseNote,
  )
}

/** Partial caption on the hint line: sanitized, fitted to two lines, throttled. */
function onVoicePartial(fullText: string): void {
  const now = Date.now()
  if (now - lastHintAt < 500) return
  lastHintAt = now
  const clean = sanitizeSpoken(fullText.replace(/\s+/g, ' ').trim())
  const text = clean ? fitLines(clean, 2) : COPY.listening.hintLive
  if (text === lastHintText) return
  lastHintText = text
  void renderer.updateListeningHint(text)
}

/**
 * The recognizer settled a phrase (voice-activity silence). A bare wake
 * phrase ("Hey Spriite" alone) keeps the turn open; a phrase with content
 * ends it. The wearer can always tap to finish sooner.
 */
function onVoiceCommitted(s: ScribeSession, fullText: string): void {
  if (scribe !== s || !talk.isActive) return
  if (!parseUtterance(fullText).body) return
  void talk.finish('silence')
}

/** The realtime session failed mid-capture: stop, keep nothing, explain. */
async function onVoiceError(s: ScribeSession, e: ScribeError): Promise<void> {
  if (scribe !== s) return
  scribe = null
  liveVoice = false
  if (talk.isActive) await talk.finish('lifecycle')
  // During the settle (transcribing) the finish path owns the display and
  // reports s.error; here we only own the still-listening case.
  if (store.uiMode === 'listening') {
    store.uiMode = 'scene'
    await presentLocalScene(voiceErrorScene(e.kind))
  }
}

async function onTalkFinished(sec: number, reason: TalkFinishReason): Promise<void> {
  if (reason !== 'tap' && reason !== 'release' && reason !== 'timeout' && reason !== 'silence') return
  if (store.uiMode !== 'listening') return
  const s = scribe
  const live = liveVoice && s !== null
  store.uiMode = 'transcribing'
  await presentLocalScene(transcribingScene(live))
  if (!live || !s) {
    // No key: the labeled demo transcript plays back (spec §17.2 phase E1).
    await sleep(1600)
    store.uiMode = 'scene'
    if (reason === 'timeout') {
      console.warn('[talk] hit the 30s cap; transcript proceeds from the bounded draft (G06)')
    }
    engine.transcriptGoal(sec)
    return
  }
  // Live turn: settle the transcript, then route the utterance.
  scribe = null
  liveVoice = false
  let text = ''
  try {
    text = await s.finish()
  } catch (e) {
    console.warn('[voice] settle failed:', e)
  }
  const failure = s.error
  store.uiMode = 'scene'
  if (failure) {
    await presentLocalScene(voiceErrorScene(failure.kind))
    return
  }
  if (reason === 'timeout') {
    console.warn('[talk] hit the 30s cap; transcript settles from what was heard (G06)')
  }
  await routeVoice(sec, text)
}

/** Map a settled utterance onto commands, confirmations, or a real goal. */
async function routeVoice(sec: number, text: string): Promise<void> {
  const parsed = parseUtterance(text)
  if (!parsed.body) {
    await presentLocalScene(voiceHeardScene(COPY.voice.nothingHeard))
    return
  }
  const command = parsed.command
  if (command === null) {
    const goal = fitLines(sanitizeSpoken(parsed.body), BUDGETS.utterance.lines)
    if (engine.acceptsGoal()) {
      engine.voiceGoal(goal, sec) // emits the transcript card
      return
    }
    if (engine.steer(goal)) return // the real orchestrator took the message
    await presentLocalScene(voiceHeardScene(heardUtterance(goal)))
    return
  }
  switch (command) {
    case 'cancel':
      pendingVoice = null // "never mind" also drops any parked command
      await presentEngineView(engine.currentView)
      return
    case 'pause':
      if (engine.canPause()) {
        engine.pauseToggle() // emits the paused card
        return
      }
      await presentLocalScene(voiceHeardScene(COPY.voice.nothingToPause))
      return
    case 'resume':
      if (engine.canResume()) {
        engine.pauseToggle() // emits the running card
        return
      }
      await presentLocalScene(voiceHeardScene(COPY.voice.nothingToResume))
      return
    case 'status':
      if (engine.canExplain()) {
        engine.talkStatus() // emits the status answer
        return
      }
      await presentLocalScene(voiceHeardScene(COPY.voice.nothingRunning))
      return
    case 'explain':
      if (engine.canExplain()) {
        engine.handleAction('explain') // emits the explain card
        return
      }
      await presentLocalScene(voiceHeardScene(COPY.voice.nothingToExplain))
      return
    case 'use_it':
      if (!engine.hasPendingDecision) {
        await presentLocalScene(voiceHeardScene(COPY.voice.noChoice))
        return
      }
      pendingVoice = 'use_it'
      await presentLocalScene(voiceConfirmScene('use_it'))
      return
    case 'restart':
      pendingVoice = 'restart'
      await presentLocalScene(voiceConfirmScene('restart'))
      return
    case 'demo':
      if (engine === demoEngine) {
        await presentLocalScene(voiceHeardScene(COPY.voice.alreadyDemo))
        return
      }
      enterDemo() // emits the demo's first card
      return
  }
}

async function cancelTalk(): Promise<void> {
  if (scribe) {
    scribe.abort()
    scribe = null
    liveVoice = false
  }
  await talk.finish('cancel')
  if (store.uiMode !== 'scene') {
    store.uiMode = 'scene'
    await presentEngineView(engine.currentView)
  }
}

// ------------------------------------------------------------- input routing

function handleAppEvent(e: AppEvent): void {
  switch (e.type) {
    case 'foreground':
      void onForeground()
      return
    case 'background':
      void onBackground()
      return
    case 'exit':
      void cleanup(e.abnormal)
      return
  }

  if (store.uiMode === 'listening') {
    switch (e.type) {
      case 'select':
        void talk.finish('tap')
        return
      case 'back':
        void cancelTalk()
        return
      case 'hold_start':
        return // capture continues (spec §5.1)
      case 'hold_release':
        void talk.finish('release')
        return
      default:
        return // scrolls and stray events are no-ops during capture
    }
  }

  if (store.uiMode === 'transcribing') return

  switch (e.type) {
    case 'next':
      moveFocus(1)
      return
    case 'previous':
      moveFocus(-1)
      return
    case 'select':
      void activateFocused()
      return
    case 'back':
      void handleBack()
      return
    case 'list_select':
      handleListSelect(e.index)
      return
    case 'menu_action':
      handleMenu(e.itemId)
      return
    case 'hold_start':
      // Version-gated enhancement (spec §5.2): hold-to-speak, tap path always
      // available. A hold never activates an action (G08).
      if (displayed?.type === 'scene') void startTalk()
      return
    case 'hold_release':
      return // release during scene mode: no capture was running
  }
}

function moveFocus(dir: number): void {
  if (displayed?.type !== 'scene') return
  const actions = displayed.scene.actions
  if (actions.length === 0) return
  store.focusIdx = (store.focusIdx + dir + actions.length) % actions.length
  void renderer.updateActions(displayed.scene, store.focusIdx)
}

async function activateFocused(): Promise<void> {
  if (displayed?.type !== 'scene') return
  const { scene, origin } = displayed
  const action = scene.actions[store.focusIdx] ?? scene.actions[0]
  if (!action) return
  if (origin === 'local') {
    if (action.kind === 'local_capture') {
      await startTalk()
      return
    }
    if (action.id === 'cancel_talk' || action.id === 'voice_cancel') {
      pendingVoice = null
      await presentEngineView(engine.currentView)
      return
    }
    if (action.id === 'voice_confirm' && pendingVoice) {
      const command = pendingVoice
      pendingVoice = null
      if (command === 'use_it') engine.handleAction('use_it')
      else resetOrExitDemo()
      return
    }
    return
  }
  runAction(action)
}

/**
 * One action router for glasses and phone: connect prompts open the phone
 * section, Talk starts the capture, the demo opt-in swaps engines, restart
 * exits the demo (or resets the mission), and everything else goes to the
 * engine.
 */
function runAction(action: SceneAction): void {
  switch (action.kind) {
    case 'local_capture':
      void startTalk()
      return
    case 'system':
      void gateway.call((b) => b.shutDownPageContainer(1), 'shutdown')
      return
    case 'command':
    case 'read_only':
      // App-level actions never reach the engine: connect prompts open the
      // matching section on the phone; demo swaps the engine; restart in the
      // demo exits it (in the real engine it resets the mission).
      if (action.id === 'connect_factory') return focusSetupSection('factory')
      if (action.id === 'connect_repo') return focusSetupSection('repo')
      if (action.id === 'connect_github') return focusSetupSection('github')
      if (action.id === 'connect_voice') return focusSetupSection('voice')
      if (action.id === 'demo') return enterDemo()
      if (action.id === 'restart') return resetOrExitDemo()
      engine.handleAction(action.id)
      return
  }
}

/** Scroll the phone panel to a section and flash it (connect prompts). */
function focusSetupSection(section: 'factory' | 'repo' | 'github' | 'voice'): void {
  window.dispatchEvent(new CustomEvent('spriite-connect', { detail: section }))
}

/** The labeled demo is an explicit opt-in; its engine is built on demand. */
function enterDemo(): void {
  if (engine === demoEngine) return
  demoEngine = new DemoFactory(onEngineView)
  engine = demoEngine
  engine.boot()
}

/**
 * Restart in demo mode returns to the real home; in real mode it resets the
 * mission (the projects home always stays one action away).
 */
function resetOrExitDemo(): void {
  if (demoEngine && engine === demoEngine) {
    demoEngine = null
    engine = realEngine ?? engine
    engine.boot() // back to the projects home
    return
  }
  engine.reset()
}

async function handleBack(): Promise<void> {
  if (displayed?.type === 'scene' && displayed.origin === 'local') {
    // While the glasses are gone there is nothing to go back to.
    if (displayed.scene.kind === 'connection_lost' && glassesConnected === false) return
    pendingVoice = null // back from a readback card cancels the parked command
    await presentEngineView(engine.currentView)
    return
  }
  const r = engine.back()
  if (r === 'exit') {
    // Root double-tap: system exit confirmation (spec §5.1, G31).
    await gateway.call((b) => b.shutDownPageContainer(1), 'shutdown')
  }
}

function handleListSelect(index: number): void {
  if (displayed?.type !== 'selection') return
  if (displayed.purpose === 'goal') {
    const r = engine.chooseGoalList(index)
    if (r === 'talk') void startTalk()
    return
  }
  engine.chooseList(index)
}

function handleMenu(itemId: number): void {
  switch (itemId) {
    case 1:
      void startTalk()
      return
    case 2:
      engine.pauseToggle()
      return
    case 3:
      resetOrExitDemo() // in demo: back to the real home; else reset the mission
      return
    case 4: {
      // Static mode: each pose holds its key frame (motion-sensitive users,
      // and no repeated image traffic on the BLE link).
      const staticNow = renderer.toggleSpriteMotion()
      console.log(`[sprite] sprite motion: ${staticNow ? 'static' : 'animated'}`)
      return
    }
    default:
      console.warn('[menu] unknown item', itemId)
  }
}

// ------------------------------------------------------------- device link

function onDeviceStatus(st: DeviceStatus): void {
  const connected = st.isConnected()
  const was = glassesConnected
  glassesConnected = connected
  phone?.setGlasses(connected)
  if (was === connected) return
  if (connected) {
    void onGlassesReconnected()
  } else {
    void onGlassesLost()
  }
}

async function onGlassesLost(): Promise<void> {
  // The glasses microphone dies with the link: stop capture, never auto-resume.
  if (scribe) {
    scribe.abort()
    scribe = null
    liveVoice = false
  }
  if (talk.isActive) {
    await talk.finish('lifecycle')
    if (store.uiMode === 'listening') store.uiMode = 'scene'
  }
  if (store.uiMode === 'transcribing') return // the brief local card wins
  // Explicit connection text with the static disconnected pose. On a hard
  // drop this render cannot land; it becomes visible on soft drops and the
  // notice state still steers input routing until reconnect.
  await presentLocalScene(connectionLostScene())
}

async function onGlassesReconnected(): Promise<void> {
  if (store.uiMode === 'listening' || store.uiMode === 'transcribing') return
  if (store.uiMode !== 'scene') return
  // The host page may be stale or wiped: re-send it whole, pose included.
  renderer.invalidatePage()
  await presentEngineView(engine.currentView)
}

// ---------------------------------------------------------------- lifecycle

async function onForeground(): Promise<void> {
  // Re-render whatever the wearer should see now; capture never auto-resumes.
  // The host may have dropped our page while backgrounded, so re-send it whole.
  renderer.invalidatePage()
  if (displayed?.type === 'scene' && displayed.origin === 'local') {
    if (displayed.scene.kind === 'transcribing') {
      await presentEngineView(engine.currentView)
      return
    }
    await presentLocalScene(displayed.scene)
    return
  }
  await presentEngineView(engine.currentView)
}

async function onBackground(): Promise<void> {
  if (scribe) {
    scribe.abort()
    scribe = null
    liveVoice = false
  }
  if (talk.isActive) {
    // Stop the mic on background; never resume it automatically (§10.2, G36).
    await talk.finish('lifecycle')
    store.uiMode = 'scene'
    await presentEngineView(engine.currentView)
  }
  await store.flush()
  await projects.flush() // the projects home survives the background too
}

async function cleanup(_abnormal: boolean): Promise<void> {
  if (cleanedUp) return
  cleanedUp = true
  renderer.stop() // animation never queues another frame during teardown
  if (scribe) {
    scribe.abort()
    scribe = null
  }
  if (talk.isActive) await talk.finish('lifecycle')
  normalizer.dispose()
  unsubEvents?.()
  unsubDevice?.()
  unsubLaunch?.()
  await store.flush()
  await projects.flush()
  console.log('[sprite] cleaned up')
}

function onHubEvent(ev: EvenHubEvent): void {
  const pcm = ev.audioEvent?.audioPcm
  if (pcm) talk.onAudio(pcm) // feeds the live STT session too, when one runs
  normalizer.handle(ev)
}

// -------------------------------------------------------------------- boot

async function init(): Promise<void> {
  const bridge = await gateway.init()

  unsubLaunch = bridge.onLaunchSource((src) => console.log('[sprite] launch source:', src))
  unsubDevice = bridge.onDeviceStatusChanged((st) => {
    console.log('[sprite] device:', st.connectType, `battery ${st.batteryLevel ?? '?'}%`)
    onDeviceStatus(st)
  })

  // `?fresh=1` (dev/test only) starts from a clean story; saves still happen.
  const params = new URLSearchParams(window.location.search)
  const fresh = params.has('fresh')
  await store.load()
  await keys.load()
  await prefs.load()
  await projects.load()

  // Dev-only scripted mode (?fake=1): walks every real-engine card in the
  // simulator with no keys, no network, and no credits. The module loads
  // behind import.meta.env.DEV, so production builds never include it.
  // Companions: fake-norepo (block on the repository), fake-nogithub (the
  // new-repo path asks for a token), fake-offline (the first session create
  // answers 503), fake-askpr (gate before the PR), fake-goal=<text> (boot
  // straight to the transcript card), fake-phone=now (open the phone's Now
  // tab for webview captures).
  let fakeDeps: {
    factoryKey?: string
    cursorKey?: string
    githubToken?: string
    repoUrl?: string
    computerId?: string
    askBeforePr?: boolean
    clients?: RealClients
  } = {}
  let fakeGoal = ''
  if (import.meta.env.DEV && params.has('fake')) {
    const { fakeClients, FAKE } = await import('./factory/fake')
    fakeDeps = {
      factoryKey: keys.factory || FAKE.factoryKey,
      cursorKey: keys.cursor || FAKE.cursorKey,
      githubToken: params.has('fake-nogithub') ? '' : keys.github || FAKE.githubToken,
      repoUrl: params.has('fake-norepo') ? '' : keys.repoUrl || FAKE.repoUrl,
      computerId: keys.computerId || FAKE.computerId,
      askBeforePr: params.has('fake-askpr') ? true : undefined,
      clients: fakeClients({ offlineOnce: params.has('fake-offline') }),
    }
    fakeGoal = params.get('fake-goal') ?? ''
    console.log('[engine] fake mode (dev only): scripted API, no network, no credits')
  }

  // The real engine always runs; a missing piece becomes an in-app prompt
  // (never a gate). Its home shows recent projects and connects from within.
  realEngine = new RealOrchestrator(onEngineView, {
    factoryKey: keys.factory,
    cursorKey: keys.cursor,
    githubToken: keys.github,
    repoUrl: keys.repoUrl,
    computerId: keys.computerId,
    workerPref: prefs.worker,
    jobs: prefs.jobs,
    askBeforePr: prefs.askBeforePr,
    projects: {
      list: () => projects.list(),
      snapshotFor: (goal) => projects.snapshotFor(goal),
    },
    ...fakeDeps,
  })
  engine = realEngine
  if (fresh) {
    store.engineSnapshot = null
    console.log('[sprite] fresh start requested; ignoring saved state')
  } else {
    // An in-flight mission resumes where it left off (closing never cancels
    // it); finished missions stay in the projects home instead.
    const saved = store.engineSnapshot as RealSnapshot | null
    if (saved && saved.real === true && saved.goal && saved.phase !== 'final') {
      engine.restore(saved)
      console.log('[sprite] resumed in-flight mission:', saved.phase)
    }
  }

  // Phone screen: the companion (live mirror, typed lines, builds, feed,
  // keys, preferences). Keys stay on the phone; the glasses never see them.
  // Saves hot-apply through configure(): no reload, cards refresh in place.
  phone = mountPhoneApp(document.getElementById('app') ?? document.body, {
    keys,
    prefs,
    engine: () => engine,
    runAction,
    onSaved: () => realEngine?.configure({
      factoryKey: keys.factory,
      cursorKey: keys.cursor,
      githubToken: keys.github,
      repoUrl: keys.repoUrl,
      computerId: keys.computerId,
      workerPref: prefs.worker,
      jobs: prefs.jobs,
      askBeforePr: prefs.askBeforePr,
    }),
  })
  // Dev-only: scripted walkthroughs can capture the phone's Now tab.
  if (import.meta.env.DEV && params.get('fake-phone') === 'now') {
    document.querySelector<HTMLButtonElement>('.sp header .segs .seg')?.click()
  }

  unsubEvents = bridge.onEvenHubEvent(onHubEvent)

  if (fakeGoal) realEngine.voiceGoal(fakeGoal, 10) // boot straight to the transcript card
  engine.boot() // emits the first view; renderer creates the startup page

  setInterval(() => engine.tick(), 400)

  window.addEventListener('beforeunload', () => void cleanup(false))

  console.log('[sprite] APP_READY')
  const missing = !keys.factory ? 'Factory' : !keys.repoUrl ? 'the repository' : ''
  console.log(
    `[engine] real orchestrator${missing ? ` | connect ${missing} on the phone to run builds` : ' | live runs spend your Factory credits (Cursor too, if connected)'}`,
  )
  console.log('[engine] the labeled demo is an explicit opt-in: say "run the demo"')
  console.log(`[voice] ${keys.elevenLabs ? 'live STT armed' : 'no key; Talk uses the labeled demo transcript'}`)
}

void init().catch((e) => console.error('[sprite] init failed:', e))
