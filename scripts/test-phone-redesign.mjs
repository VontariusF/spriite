/**
 * The phone redesign (docs/design/REDESIGN-SPEC.md; boards Home, Mission,
 * Ask, Settings, Main in docs/design/redesign/): first-run gating, the
 * Home / Builds / Settings tabs, every Home section's copy and order, Needs
 * you, the Builds tab, Mission, the Ask sheet, Settings rows, values, sheets
 * and Advanced, the design tokens and the bundled fonts.
 *
 * Mounts the real phone page (src/phone/app.ts) over the Node DOM shim with
 * fakes for the setup package's screens and the pairing client.
 *
 * Usage: node --import ./scripts/ts-resolve.mjs scripts/test-phone-redesign.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountPhoneApp } from '../src/phone/app.ts'
import { TOKENS, TOKENS_CSS, FONT_CSS, FONT_FILES } from '../src/phone/tokens.ts'
import { ADVANCED_LABELS } from '../src/phone/settings.ts'
import { THEME_CSS } from '../src/phone/theme.ts'
import { milestoneMarks, milestoneLine, buildState, agentRows } from '../src/phone/view-model.ts'
import { hostSignInText } from '../src/setup/x-panel.ts'
import { KeyVault } from '../src/voice/keys.ts'
import { PrefsVault } from '../src/state/prefs.ts'
import { FeedVault } from '../src/state/feed.ts'
import { allNodes, control, labelOf, makeElement, phoneDom, phoneFakes, textOf } from './lib/phone-dom.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
let failures = 0
let passes = 0
const check = (ok, label) => {
  if (ok) { passes++; console.log(`PASS: ${label}`) } else { failures++; console.log(`FAIL: ${label}`) }
}
const section = (name) => console.log(`\n-- ${name}`)
console.log('== Phone redesign (Home, Builds, Mission, Ask, Settings) ==')

const byId = (root, id) => allNodes(root, (n) => n.id === id)[0] ?? null
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1)) }

function gateway(store = new Map()) {
  return {
    store,
    call: (fn) => fn({
      getLocalStorage: async (k) => store.get(k) ?? '',
      setLocalStorage: async (k, v) => { store.set(k, v); return true },
    }),
  }
}

/** A stub engine with every surface the phone reads; tests mutate its fields. */
function stubEngine(over = {}) {
  const e = {
    hasPendingDecision: false,
    hasUnconfirmedDelivery: false,
    currentView: null,
    snap: { real: true, goal: '', sessionId: null, jobs: [], milestones: [], missionRepo: '' },
    builds: [],
    log: [],
    asks: [],
    calls: [],
    paused: false,
    canPausing: true,
    acceptsGoal: () => true,
    canStartNewRepo: () => true,
    watchOnly: () => false,
    say: (text) => { e.calls.push(['say', text]); return 'goal' },
    sayNewRepo: (text, name) => { e.calls.push(['sayNewRepo', text, name]); return 'goal' },
    snapshot: () => e.snap,
    listBuilds: () => e.builds,
    canOpenBuilds: () => true,
    openBuild: (i) => { e.calls.push(['openBuild', i]); return true },
    pendingAsks: () => e.asks,
    chatLog: () => e.log,
    showMission: () => false,
    canPause: () => e.canPausing && !e.paused,
    canResume: () => e.paused,
    chooseDecisionList: (i) => { e.calls.push(['choose', i]); return 'done' },
    chooseList: () => {},
    ...over,
  }
  return e
}

const scene = (over = {}) => ({
  type: 'scene',
  scene: {
    schemaVersion: 1, sceneId: 'redesign', sceneRevision: 1, missionId: 'm1', stateSequence: 1,
    kind: 'running', spritePose: 'building', contextLabel: 'SPRIITE',
    utterance: 'Two workers are wiring the cart API.', status: 'Building now · 2 workers',
    progress: { acceptedWeight: 50, pendingReviewWeight: 25, totalWeight: 100, planRevision: 1, milestones: ['done', 'done', 'review', 'todo'] },
    actions: [{ id: 'send_message', label: 'Send message', kind: 'local_capture' }, { id: 'pause', label: 'Pause', kind: 'command' }],
    evidenceIds: [], generatedAt: '', transientMs: 0,
    ...over,
  },
})

async function mount({ engine = stubEngine(), setup = 'complete', fakes = phoneFakes(), keysInit, prefsInit, extra = {} } = {}) {
  phoneDom()
  globalThis.window.dispatchEvent = (ev) => { for (const fn of globalThis.window.listeners[ev.type] ?? []) fn(ev) }
  const gw = gateway()
  const keys = new KeyVault(gw)
  const prefs = new PrefsVault(gw)
  const feed = new FeedVault(gw)
  await keys.load(); await prefs.load(); await feed.load()
  if (setup === 'complete') await prefs.setSetupCompleted(1760000000000)
  if (setup === 'legacy') { await keys.setFactory('fk-legacy'); await keys.setRepoUrl('https://github.com/your-org/shop-site') }
  await keysInit?.(keys)
  await prefsInit?.(prefs)
  const actions = []
  const root = makeElement('div')
  const handle = mountPhoneApp(root, {
    ...fakes, keys, prefs, feed, engine: () => engine,
    runAction: (a) => actions.push(a), onSaved: () => {}, ...extra,
  })
  return { root, handle, engine, keys, prefs, fakes, actions }
}

// ------------------------------------------------------------ tokens/fonts
section('design tokens and bundled fonts (contract C1)')
{
  const expected = {
    '--sp-ground': '#07110A', '--sp-surface': '#0D1A11', '--sp-raised': '#13241A', '--sp-selected': '#0F2215',
    '--sp-line': '#1F3326', '--sp-line-strong': '#24452F', '--sp-text': '#EAF5EC', '--sp-muted': '#9AB1A0',
    '--sp-body-soft': '#D4E3D7', '--sp-accent': '#5CE57D', '--sp-accent-hover': '#8BF0A2', '--sp-accent-ink': '#04210E',
    '--sp-amber': '#F2B740', '--sp-amber-ground': '#1E1705', '--sp-amber-ink': '#2A1C00', '--sp-amber-line': '#6B5320',
    '--sp-amber-soft': '#FBE8C0', '--sp-amber-muted': '#D9C7A0', '--sp-factory': '#7DBEFF', '--sp-cursor': '#BDA4FF',
    '--sp-danger': '#FF8A7A', '--sp-nav': '#0A150D', '--sp-placeholder': '#7F9785', '--sp-radio-off': '#5A7562',
    '--sp-done-dot': '#5A7562', '--sp-step-off': '#2E4A37', '--sp-dash': '#3C5A45', '--sp-scrim': '#030805',
    '--sp-glass': '#000000', '--sp-glass-title': '#B8FFC8', '--sp-glass-body': '#8FE6A3', '--sp-glass-label': '#6FCF86',
    '--sp-glass-bar-off': '#1A3322',
    '--sp-font-display': "'Bricolage Grotesque', Georgia, serif",
    '--sp-font-ui': "'Instrument Sans', 'Helvetica Neue', Helvetica, sans-serif",
    '--sp-font-mono': "'JetBrains Mono', Menlo, monospace",
  }
  check(Object.entries(expected).every(([k, v]) => TOKENS_CSS.includes(`${k}: ${v};`)), 'TOKENS_CSS declares every C1 variable with its exact value')
  check(/^\s*\.sp \{/.test(TOKENS_CSS), 'the tokens are declared on .sp')
  check(Object.keys(TOKENS).length === Object.keys(expected).length, 'no token beyond the contract')
  const names = [
    'bricolage-grotesque-latin-600-normal.woff2', 'bricolage-grotesque-latin-700-normal.woff2',
    'instrument-sans-latin-400-normal.woff2', 'instrument-sans-latin-500-normal.woff2',
    'instrument-sans-latin-600-normal.woff2', 'instrument-sans-latin-700-normal.woff2',
    'jetbrains-mono-latin-500-normal.woff2', 'jetbrains-mono-latin-600-normal.woff2',
    'OFL-bricolage-grotesque.txt', 'OFL-instrument-sans.txt', 'OFL-jetbrains-mono.txt',
  ]
  check(names.every((n) => existsSync(join(ROOT, 'public/fonts', n)) && statSync(join(ROOT, 'public/fonts', n)).size > 1000),
    'every C1 font file and OFL text is bundled in public/fonts')
  check(names.filter((n) => n.endsWith('.woff2')).every((n) => readFileSync(join(ROOT, 'public/fonts', n)).subarray(0, 4).toString('latin1') === 'wOF2'),
    'the bundled fonts are real WOFF2 files')
  check(FONT_FILES.every((f) => FONT_CSS.includes(`fonts/${f.file}`)) && /font-display: swap/.test(FONT_CSS),
    'FONT_CSS references each bundled file with font-display swap')
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)])
  const offenders = [...walk(join(ROOT, 'src')), join(ROOT, 'index.html')]
    .filter((f) => /\.(ts|tsx|js|mjs|css|html)$/.test(f) && readFileSync(f, 'utf8').includes('fonts.googleapis'))
  check(offenders.length === 0, 'no Google Fonts URL anywhere in src or index.html')
  check(readFileSync(join(ROOT, 'index.html'), 'utf8').includes('<meta name="theme-color" content="#07110A" />'), 'index.html theme-color is the ground #07110A')
}

// ------------------------------------------------------------------ gating
section('first run: the setup flow until setup is complete')
{
  const fresh = await mount({ setup: 'none' })
  check(fresh.fakes.calls.setupFlow.length === 1 && fresh.fakes.calls.setupFlow[0].entry === 'welcome' &&
    fresh.fakes.calls.setupFlow[0].context === 'first_run', 'a fresh install mounts the injected setup flow at Welcome')
  check(byId(fresh.root, 'ph-setup')?.hidden === false && byId(fresh.root, 'fake-setupFlow') !== null, 'the setup flow covers the app full screen')
  const deps = fresh.fakes.calls.setupFlow[0]
  let voiceBack = false
  const voiceDone = Promise.resolve(deps.onExtra('voice')).then(() => { voiceBack = true })
  const voiceSheet = byId(fresh.root, 'ph-sheet-voice')
  check(voiceSheet?.hidden === false, 'Ready > spoken replies opens the voice key sheet over the flow')
  check(voiceSheet.classList.contains('ph-overlay--over-flow') && /\.ph-overlay\.ph-overlay--over-flow \{ z-index: 40; \}/.test(THEME_CSS) &&
    /\.ph-fullscreen \{ position: fixed; inset: 0; z-index: 30;/.test(THEME_CSS),
    'the extra’s sheet stacks above the setup flow (z 40 over the flow’s 30)')
  await Promise.resolve()
  check(voiceBack === false, 'onExtra stays pending while the key sheet is open')
  voiceSheet.children[0].children[0].children[1].onclick()
  await voiceDone
  check(voiceBack === true && voiceSheet.hidden === true && !voiceSheet.classList.contains('ph-overlay--over-flow'),
    'closing the key sheet hands the owner back to Ready')
  await fresh.prefs.setXClientId('client-example')
  const xNote = await deps.onExtra('x')
  check(fresh.fakes.calls.signIn.length === 1 && fresh.fakes.calls.signIn[0].clientId === 'client-example',
    'Ready > X starts the host sign-in with the saved client id')
  check(xNote && typeof xNote.text === 'string' && xNote.text.length > 0 && (xNote.tone === 'ok' || xNote.tone === 'err'),
    'Ready > X returns its outcome for the Ready screen (the Home note is behind the flow)')

  const done = await mount({ setup: 'none' })
  done.fakes.calls.setupFlow[0].onDone()
  check(byId(done.root, 'ph-setup')?.hidden === true && byId(done.root, 'ph-home')?.hidden === false, 'the flow’s onDone lands on Home')

  const complete = await mount({ setup: 'complete' })
  check(complete.fakes.calls.setupFlow.length === 0 && byId(complete.root, 'ph-setup')?.hidden === true, 'a completed setup goes straight to Home')
  const legacy = await mount({ setup: 'legacy' })
  check(legacy.fakes.calls.setupFlow.length === 0, 'an existing install with a Factory key and a repository never sees Welcome')
}

// ------------------------------------------------------------------- tabs
section('Home / Builds / Settings bottom nav (Home.dc.html, Settings.dc.html)')
{
  const m = await mount()
  const nav = allNodes(m.root, (n) => n.tagName === 'NAV')[0]
  check(nav?.['aria-label'] === 'Main' && nav.className === 'ph-nav', 'one nav labelled Main replaces the Now/Setup tabs')
  check(nav.children.map((a) => textOf(a)).join('|') === 'Home|Builds|Settings', 'the nav reads Home, Builds, Settings in order')
  check(!allNodes(m.root, (n) => n.className === 'segs' || textOf(n) === 'Now').length, 'no Now or Setup segmented tab remains')
  check(byId(m.root, 'ph-tab-home')['aria-current'] === 'page' && byId(m.root, 'ph-tab-builds')['aria-current'] === undefined,
    'Home is the current page at start (aria-current=page)')
  byId(m.root, 'ph-tab-settings').onclick()
  check(byId(m.root, 'ph-tab-settings')['aria-current'] === 'page' && byId(m.root, 'ph-tab-home')['aria-current'] === undefined &&
    byId(m.root, 'ph-settings').hidden === false && byId(m.root, 'ph-home').hidden === true, 'tapping Settings shows Settings and moves aria-current')
  const settingsIcon = byId(m.root, 'ph-tab-settings').children[0].innerHTML
  check(settingsIcon.includes('M12 2v3M12 19v3'), 'the current Settings tab draws the Settings board’s icon')
  byId(m.root, 'ph-tab-builds').onclick()
  check(byId(m.root, 'ph-builds').hidden === false && byId(m.root, 'ph-tab-settings').children[0].innerHTML.includes('M19.4 15a1.7'),
    'Builds shows the Builds tab; Settings returns to the Home board’s gear')
}

// ------------------------------------------------------------------- home
section('Home: header, mirror, Needs you, Start something new, Builds (Home.dc.html)')
{
  const e = stubEngine()
  e.builds = [
    { title: 'Checkout flow', note: 'Spriite: building · 3 agents · milestone 2 of 4', kind: 'local', missionId: 'm1' },
    { title: 'Onboarding emails', note: 'Spriite: waiting for your answer', kind: 'local', missionId: 'm2' },
    { title: 'Pricing page copy', note: 'Factory: watching · started in Factory', kind: 'factory' },
    { title: 'Landing page', note: 'Cursor: done · pull request ready', kind: 'cursor' },
    { title: 'Fifth build', note: 'Spriite: building', kind: 'local', missionId: 'm5' },
  ]
  const m = await mount({ engine: e })
  e.snap = { ...e.snap, goal: 'Checkout flow', sessionId: 's1' }
  m.handle.notify(scene())
  const home = byId(m.root, 'ph-home')
  const order = home.children.map((n) => n.id || n.className)
  check(order.join(',') === 'ph-head,ph-mirror,ph-needs,ph-compose,ph-voice-drafts,ph-section', 'Home sections are in the board’s order')
  check(textOf(home.children[0].children[0]) === 'Spriite' && home.children[0].children[0].className === 'ph-brand', 'the header names Spriite in the display face')
  check(textOf(byId(m.root, 'ph-glasses')) === 'Checking glasses', 'the glasses pill starts as Checking glasses')
  m.handle.setGlasses(true)
  check(textOf(byId(m.root, 'ph-glasses')) === 'Glasses on' && byId(m.root, 'ph-glasses').className === 'ph-glasses on', 'a linked pair reads Glasses on in the accent pill')
  m.handle.setGlasses(false)
  check(textOf(byId(m.root, 'ph-glasses')) === 'Glasses off' && byId(m.root, 'ph-glasses').className === 'ph-glasses', 'no link reads Glasses off in the muted pill')
  check(textOf(byId(m.root, 'ph-mirror')).startsWith('On your glasses'), 'the black mirror is labelled On your glasses')
  check(textOf(byId(m.root, 'ph-mirror-meta')) === 'Milestone 2 of 4', 'the mirror names the milestone from the scene’s marks (done, done, review, todo is 2 of 4 as drawn)')
  check(textOf(byId(m.root, 'ph-mirror-title')) === 'Checkout flow' && textOf(byId(m.root, 'ph-mirror-body')) === 'Two workers are wiring the cart API.',
    'the mirror shows the build’s title and Spriite’s line')
  const segs = byId(m.root, 'ph-mirror-bar').children.map((n) => n.className)
  check(segs.join(',') === 'ph-seg done,ph-seg done,ph-seg review,ph-seg', 'the 4-segment bar draws done solid, review dotted, todo dim')
  check(byId(m.root, 'ph-mirror-bar')['aria-label'] === 'Progress: 2 milestones done, 1 in review, 1 to go', 'the bar is described the way the board describes it')
  check(textOf(byId(m.root, 'ph-open-build')) === 'Open build' && textOf(byId(m.root, 'ph-mirror-pause')) === 'Pause', 'the mirror offers Open build and Pause')
  byId(m.root, 'ph-mirror-pause').onclick()
  check(m.actions.at(-1)?.id === 'pause', 'Pause runs through the app’s action router')
  e.paused = true
  m.handle.notify(scene({ sceneRevision: 2, kind: 'paused' }))
  check(textOf(byId(m.root, 'ph-mirror-pause')) === 'Resume', 'a paused build offers Resume')
  byId(m.root, 'ph-mirror-pause').onclick()
  check(m.actions.at(-1)?.id === 'resume', 'Resume runs through the app’s action router')
  e.paused = false
  check(byId(m.root, 'ph-needs').hidden === true, 'Needs you is hidden when nothing waits')
  const compose = byId(m.root, 'ph-compose')
  check(textOf(compose.children[0]) === 'Start something new' && compose.children[1].tagName === 'TEXTAREA' &&
    compose.children[1].rows === 3 && compose.children[1].placeholder === 'Add a guest checkout to the shop site…',
  'the composer is Start something new with the board’s 3-row box and placeholder')
  check(textOf(byId(m.root, 'ph-new-repo')) === 'New repo' && textOf(byId(m.root, 'ph-models-chip')) === 'Factory default models',
    'the chips read New repo and Factory default models')
  check(labelOf(byId(m.root, 'ph-home-talk')) === 'Talk' && labelOf(byId(m.root, 'ph-home-send')) === 'Send', 'round Talk and Send buttons carry their labels')
  check(byId(m.root, 'ph-new-repo')['aria-pressed'] === 'false', 'New repo starts off when one repository is the default')
  byId(m.root, 'ph-home-talk').onclick()
  check(m.actions.at(-1)?.id === 'talk' && m.actions.at(-1)?.kind === 'local_capture', 'Talk starts the glasses capture')
  byId(m.root, 'ask').value = 'Add a guest checkout to the shop site'
  byId(m.root, 'ph-home-send').onclick()
  check(e.calls.some((c) => c[0] === 'say' && c[1] === 'Add a guest checkout to the shop site'), 'Send starts the goal through the engine')
  byId(m.root, 'ph-new-repo').onclick()
  byId(m.root, 'ask').value = 'A fresh idea'
  byId(m.root, 'ph-home-send').onclick()
  check(e.calls.some((c) => c[0] === 'sayNewRepo' && c[1] === 'A fresh idea' && c[2] === ''), 'with New repo on the goal takes the existing new-repo path')
  byId(m.root, 'ph-models-chip').onclick()
  check(byId(m.root, 'ph-settings').hidden === false && byId(m.root, 'ph-sheet-models').hidden === false, 'the models chip opens the Models sheet')
  byId(m.root, 'ph-tab-home').onclick()
  const builds = byId(m.root, 'ph-home-builds').children
  check(builds.length === 4, 'Home shows the first four builds (See all has the rest)')
  const dots = builds.map((b) => b.children[0].style.background)
  check(dots.join(',') === 'var(--sp-accent),var(--sp-amber),var(--sp-factory),var(--sp-done-dot)', 'row dots: building, waiting, watching, done')
  check(builds.map((b) => textOf(b.children[2])).join(',') === 'Spriite,Spriite,Factory,Cursor' &&
    builds.map((b) => b.children[2].className).join(',') === 'ph-src local,ph-src local,ph-src factory,ph-src cursor',
  'source pills: Spriite, Factory, Cursor in their colours')
  check(textOf(builds[0].children[1].children[0]) === 'Checkout flow' && textOf(builds[0].children[1].children[1]) === 'Building · 3 agents · milestone 2 of 4',
    'a row shows the name over its status')
  const head = allNodes(byId(m.root, 'ph-home'), (n) => n.className === 'ph-section-head')[0]
  check(textOf(head.children[0]) === 'Builds' && head.children[0].tagName === 'H2' && textOf(head.children[1]) === 'See all', 'Builds h2 with See all')
  head.children[1].onclick()
  check(byId(m.root, 'ph-builds').hidden === false, 'See all opens the Builds tab')
  check(milestoneLine(milestoneMarks({ acceptedWeight: 0, pendingReviewWeight: 0, totalWeight: 0, planRevision: 1 }, {})) === '',
    'a zero-weight plan draws no milestone line')
  check(milestoneLine(['done', 'done', 'review', 'todo']) === 'Milestone 2 of 4' && milestoneLine(['done', 'review', 'review', 'todo']) === 'Milestone 1 of 4' &&
    milestoneLine(['done', 'done', 'done', 'done']) === 'Milestone 4 of 4', 'the milestone count is the milestones done; in review does not move it (Home.dc.html)')
  check(buildState({ note: 'Spriite: building', kind: 'local', missionId: 'm2' }, new Set(['m2'])) === 'waiting', 'an asking build shows the waiting dot')
}

// -------------------------------------------------------------- needs you
section('Needs you and the Ask sheet (Home.dc.html, Ask.dc.html)')
{
  const e = stubEngine()
  e.hasPendingDecision = true
  e.snap = { ...e.snap, goal: 'Onboarding emails', decisionText: 'Send the welcome email right away, or after the user verifies?' }
  e.log = [{ who: 'lead', text: 'Send the welcome email right away, or after the user verifies?', at: Date.now() - 3 * 60_000 }]
  const m = await mount({ engine: e })
  const view = { type: 'selection', purpose: 'decision', contextLabel: 'SPRIITE', title: 'Pick one', items: ['After verifying', 'Right away', 'Say another answer'], pose: 'asking' }
  e.currentView = view
  m.handle.notify(view)
  check(byId(m.root, 'ph-needs').hidden === false, 'Needs you shows the waiting question')
  check(textOf(byId(m.root, 'ph-needs')).startsWith('Needs you'), 'the amber card is labelled Needs you')
  check(textOf(byId(m.root, 'ph-needs-q')) === 'Send the welcome email right away, or after the user verifies?', 'the card asks the Lead’s question')
  check(textOf(byId(m.root, 'ph-needs-meta')) === 'Onboarding emails · Lead', 'the meta names the build and the Lead')
  const opts = byId(m.root, 'ph-needs-options').children
  check(opts.length === 2 && textOf(opts[0]) === 'After verifying' && opts[0].className === 'ph-amber-btn solid' &&
    textOf(opts[1]) === 'Right away' && opts[1].className === 'ph-amber-btn outline', 'the first two options are the amber primary and outlined buttons')
  check(textOf(byId(m.root, 'ph-needs-all')) === 'See all options', 'See all options is offered')
  byId(m.root, 'ph-needs-all').onclick()
  const sheet = byId(m.root, 'ph-ask-sheet')
  check(sheet.hidden === false, 'See all options opens the Ask sheet')
  const radios = allNodes(sheet, (n) => n.role === 'radio')
  check(radios.map((r) => textOf(r.children[1].children[0])).join('|') === 'After verifying|Right away|Let me decide later', 'the sheet lists every option, then Let me decide later')
  check(radios[0]['aria-checked'] === 'true' && radios[1]['aria-checked'] === 'false', 'the first option starts selected')
  check(textOf(radios[2].children[1].children[1]) === 'The Lead keeps building around it', 'Let me decide later says the Lead keeps building')
  check(textOf(sheet).includes('Lead asks') && textOf(sheet).includes('Onboarding emails · 3 min ago'), 'the sheet names Lead asks and the build with its age')
  check(textOf(sheet).includes('The same question is on your glasses. Answer either place.'), 'the footnote says the glasses show it too')
  check(control(sheet, 'Say it') !== null && control(sheet, 'Send answer') !== null, 'Say it and Send answer are offered')
  radios[2].onclick()
  control(byId(m.root, 'ph-ask-sheet'), 'Send answer').onclick()
  check(byId(m.root, 'ph-ask-sheet').hidden === true && !e.calls.some((c) => c[0] === 'choose'), 'Let me decide later closes the sheet and answers nothing')
  check(byId(m.root, 'ph-needs').hidden === false, 'the question stays open in Needs you')
  byId(m.root, 'ph-needs-all').onclick()
  allNodes(byId(m.root, 'ph-ask-sheet'), (n) => n.role === 'radio')[1].onclick()
  control(byId(m.root, 'ph-ask-sheet'), 'Send answer').onclick()
  check(e.calls.some((c) => c[0] === 'choose' && c[1] === 1), 'Send answer sends the chosen option through the decision list')
  opts[0].onclick()
  check(e.calls.filter((c) => c[0] === 'choose').at(-1)?.[1] === 0, 'the card’s primary button answers with the first option')
  byId(m.root, 'ph-needs-all').onclick()
  control(byId(m.root, 'ph-ask-sheet'), 'Say it').onclick()
  check(m.actions.at(-1)?.id === 'talk', 'Say it starts a spoken answer')

  // Another build is asking while the glasses show this one (the board's case).
  const other = stubEngine()
  other.builds = [{ title: 'Onboarding emails', note: 'Spriite: waiting for your answer', kind: 'local', missionId: 'm2' }]
  other.asks = [{ missionId: 'm2', title: 'Send the welcome email right away, or after the user verifies?' }]
  const shown = []
  other.showMission = (id) => { shown.push(id); return true }
  const o = await mount({ engine: other })
  o.handle.notify(scene())
  check(textOf(byId(o.root, 'ph-needs-meta')) === 'Onboarding emails · Lead' &&
    textOf(byId(o.root, 'ph-needs-q')) === 'Send the welcome email right away, or after the user verifies?',
  'another build’s question shows with its build name and the Lead')
  byId(o.root, 'ph-needs-options').children[0].onclick()
  check(shown.join() === 'm2', 'its Answer brings the asking build in')

  // The runtime also says what that build's question offers: Home draws its
  // first two answers and See all options exactly as on the board.
  const asking = stubEngine()
  asking.builds = [{ title: 'Onboarding emails', note: 'Spriite: waiting for your answer', kind: 'local', missionId: 'm2' }]
  asking.asks = [{ missionId: 'm2', title: 'Send the welcome email right away?', options: ['Right away', 'After they verify', 'Skip it'] }]
  const askView = { type: 'selection', purpose: 'decision', contextLabel: 'LEAD ASKS', title: 'Send the welcome email right away?',
    items: ['Right away', 'After they verify', 'Skip it', 'Say something else'], pose: 'asking' }
  let a2 = null
  asking.showMission = (id) => {
    asking.hasPendingDecision = true
    asking.currentView = askView
    asking.asks = [{ missionId: id, title: askView.title, options: askView.items.slice(0, -1) }]
    a2.handle.notify(askView)
    return true
  }
  a2 = await mount({ engine: asking })
  a2.handle.notify(scene())
  const drawn = byId(a2.root, 'ph-needs-options').children.map((n) => textOf(n))
  check(drawn.join('|') === 'Right away|After they verify' && byId(a2.root, 'ph-needs-all').hidden === false,
    'a build not on the glasses shows its first two answers and See all options, as Home.dc.html draws it')
  byId(a2.root, 'ph-needs-options').children[1].onclick()
  check(asking.calls.filter((c) => c[0] === 'choose').at(-1)?.[1] === 1,
    'tapping an answer brings the build in and sends exactly that answer')

  const held = await mount({ extra: { heldNativeIntents: () => [{ missionId: 'held-1', origin: 'x', goal: 'Build the estate page', references: [], repository: '', createdAt: '2026-10-01' }] } })
  held.handle.notify(scene())
  check(byId(held.root, 'ph-needs').hidden === false && textOf(byId(held.root, 'ph-needs')).includes('Build the estate page'), 'a held native intent surfaces in Needs you')
  control(byId(held.root, 'ph-needs'), 'Review').onclick()
  check(byId(held.root, 'ph-settings').hidden === false && byId(held.root, 'ph-advanced').open === true, 'its Review opens the exact native form under Settings › Advanced')
}

// ------------------------------------------------------------------ builds
section('Builds tab (undrawn: the Home list in full with source filters)')
{
  const e = stubEngine()
  e.builds = [
    { title: 'A', note: 'Spriite: building', kind: 'local', missionId: 'a' },
    { title: 'B', note: 'Factory: watching', kind: 'factory' },
    { title: 'C', note: 'Cursor: done', kind: 'cursor' },
  ]
  const m = await mount({ engine: e })
  m.handle.notify(scene())
  byId(m.root, 'ph-tab-builds').onclick()
  const chips = byId(m.root, 'ph-build-filters').children.map((c) => textOf(c))
  check(chips.join('|') === 'All 3|Spriite 1|Factory 1|Cursor 1', 'source filter chips count each source')
  check(byId(m.root, 'ph-build-filters').children[0].className.includes('ph-chip') && byId(m.root, 'ph-build-filters').children[0].className.includes('on'), 'the chips use the Home chip style, All on')
  byId(m.root, 'ph-build-filters').children[2].onclick()
  check(byId(m.root, 'ph-builds-list').children.length === 1 && textOf(byId(m.root, 'ph-builds-list')).includes('B'), 'a chip filters the list')
  let opened = 0
  e.openBuild = () => { opened++; m.handle.notify(scene({ sceneRevision: 9 })); return true }
  byId(m.root, 'ph-build-filters').children[0].onclick()
  byId(m.root, 'ph-builds-list').children[0].onclick()
  check(opened === 1 && byId(m.root, 'ph-mission').hidden === false, 'a row opens the build’s Mission page')
}

// ----------------------------------------------------------------- mission
section('Mission (Mission.dc.html)')
{
  check(/:where\(\.sp\) :where\(input\[type=text\], input\[type=password\], input\[type=url\], input:not\(\[type\]\), select, textarea\) \{/.test(THEME_CSS) &&
    !/\.sp input\[type=text\]/.test(THEME_CSS),
  'the theme’s default input rule has zero specificity, so component inputs (code boxes, Repo search, message bar) keep the board’s values')
  check(/\.sp \.ph-msgbar input \{ flex: 1; min-width: 0; min-height: 46px; padding: 0 14px; border-radius: 23px; border: 1px solid var\(--sp-line-strong\);\s*background: var\(--sp-ground\); color: var\(--sp-text\); font: 16px var\(--sp-font-ui\); \}/.test(THEME_CSS),
    'the message bar input is the board’s 46 px pill (radius 23, padding 0 14px, #24452F on #07110A)')
  check(/\.sp \.ph-sheet-content\.ph-ask \{ gap: 16px; \}/.test(THEME_CSS), 'the Ask sheet body spaces its parts 16 px apart (Ask.dc.html)')
  const e = stubEngine({ acceptsGoal: () => false })
  e.snap = {
    real: true, goal: 'Checkout flow', sessionId: 's1', missionRepo: 'https://github.com/your-org/shop-site',
    milestones: [
      { id: 'plan', label: 'Plan agreed', weight: 20, status: 'accepted' },
      { id: 'j0', label: 'Cart and totals', weight: 30, status: 'accepted' },
      { id: 'j1', label: 'Payment step', weight: 30, status: 'pending' },
      { id: 'j2', label: 'Order emails and pull request', weight: 20, status: 'pending' },
    ],
    jobs: [
      { label: 'Stripe checkout session route', mode: 'session', stage: 'build', state: 'building' },
      { label: 'Payment form and errors', mode: 'session', stage: 'build', state: 'building' },
    ],
  }
  e.log = [
    { who: 'lead', text: 'Cart totals are in and 6 checks pass. Starting the payment step next.', at: Date.now() - 2 * 60_000 },
    { who: 'you', text: 'Use Stripe test mode for now.', at: Date.now() - 60_000 },
  ]
  const m = await mount({
    engine: e,
    prefsInit: async (prefs) => {
      await prefs.setPairedHost({ label: 'studio', machineId: 'machine-example', ownerId: 'owner-example', brokerUrl: 'https://broker.example.com', via: 'tailscale', os: 'macos', pairedAt: 1760000000000 })
      await prefs.setRunOn('host')
    },
  })
  m.handle.notify(scene({ spritePose: 'delegating' }))
  byId(m.root, 'ph-open-build').onclick()
  const page = byId(m.root, 'ph-mission')
  check(page.hidden === false && allNodes(m.root, (n) => n.tagName === 'NAV')[0].hidden === true, 'Open build shows Mission; its message bar replaces the nav')
  check(control(page, 'Back to home') !== null && control(page, 'More actions') !== null, 'back (44px) and More actions controls')
  check(allNodes(page, (n) => n.className === 'ph-sprite-box').length === 1, 'the 72px black sprite box')
  check(textOf(byId(m.root, 'ph-mission-title')) === 'Checkout flow' && byId(m.root, 'ph-mission-title').tagName === 'H1', 'the title in the display face')
  check(textOf(byId(m.root, 'ph-mission-where')) === 'your-org/shop-site · on studio', 'the repo and where it runs: "your-org/shop-site · on studio"')
  const steps = byId(m.root, 'ph-timeline').children
  check(steps.map((s) => s.className).join(',') === 'ph-step done,ph-step done,ph-step now,ph-step next last', 'the timeline marks done, now and next')
  check(textOf(steps[2]).includes('Payment step') && textOf(steps[2]).includes('Building now · 2 workers'), 'the current step carries the build’s status')
  const agents = byId(m.root, 'ph-agents').children.map((a) => textOf(a.children[1].children[0]) + ':' + textOf(a.children[2]))
  check(agents.join('|') === 'Lead:Planning|Worker:Coding|Worker:Coding|Reviewer:Waiting', 'Who’s working lists the Lead (Planning, as drawn), each worker and the reviewer')
  const leadRow = byId(m.root, 'ph-agents').children[0]
  check(textOf(leadRow.children[1].children[1]) === 'Splitting the work across 2 workers' && !textOf(leadRow).includes('Building now'),
    'the Lead’s doing line says what the Lead is doing, not the build status')
  check(leadRow.children[2].style.color === 'var(--sp-accent)', 'the Lead’s Planning state is in the accent')
  check(textOf(page).includes('Who’s working') && textOf(page).includes('Latest'), 'the section labels match the board')
  const bubbles = byId(m.root, 'ph-latest').children
  check(bubbles[0].className === 'bubble lead' && textOf(bubbles[0].children[0]) === 'Lead · 2 min ago', 'the Lead’s bubble sits left with "Lead · 2 min ago"')
  check(bubbles[1].className === 'bubble you' && textOf(bubbles[1]).includes('Use Stripe test mode for now.'), 'the owner’s bubble sits right')
  check(byId(m.root, 'msg').placeholder === 'Message the Lead…' && control(page, 'Talk') !== null && control(page, 'Pause build') !== null,
    'the message bar: Message the Lead…, Talk, Pause')
  byId(m.root, 'msg').value = 'Use test mode'
  for (const fn of byId(m.root, 'msg').listeners.keydown) fn({ key: 'Enter' })
  check(e.calls.some((c) => c[0] === 'say' && c[1] === 'Use test mode'), 'the bar sends through the existing steer/answer path')
  check(byId(m.root, 'ph-actions').hidden === true, 'the build’s own actions wait behind More actions')
  control(page, 'More actions').onclick()
  check(byId(m.root, 'ph-actions').hidden === false && control(byId(m.root, 'ph-actions'), 'Send message') !== null, 'More actions shows the build’s actions')
  control(page, 'Back to home').onclick()
  check(byId(m.root, 'ph-home').hidden === false, 'back returns to Home')
}

// ---------------------------------------------------------------- settings
section('Settings (Settings.dc.html)')
{
  const m = await mount({
    keysInit: async (keys) => { await keys.setRepoMode('per_idea') },
    prefsInit: async (prefs) => {
      await prefs.setPairedHost({ label: 'studio', machineId: 'machine-example', ownerId: 'owner-example', brokerUrl: 'https://broker.example.com', via: 'tailscale', os: 'linux', pairedAt: 1760000000000 })
      await prefs.setRunOn('host')
      await prefs.setJobs(3)
      await prefs.setAskBeforePr(true)
    },
  })
  byId(m.root, 'ph-tab-settings').onclick()
  const pane = byId(m.root, 'ph-settings')
  check(textOf(pane.children[0]) === 'Settings' && pane.children[0].tagName === 'H1', 'the page title is Settings')
  check(pane.children.slice(1, 4).map((s) => textOf(s.children[0])).join('|') === 'Connections|How builds run|Your setup', 'the three drawn sections, in order')
  const conns = ['factory', 'host', 'github', 'voice', 'x', 'cursor'].map((id) => byId(m.root, `ph-conn-${id}`))
  const names = conns.map((c) => `${textOf(c.children[1].children[0])}/${textOf(c.children[1].children[1])}`)
  check(names.join('|') === 'Factory/Account and Droid computer|studio/Builds run here|GitHub/Can create and push repos|Spoken replies/ElevenLabs|X requests/Read on studio|Cursor/Extra workers',
    'Connections rows: names and details exactly as drawn, the host named by pairing')
  check(conns.map((c) => textOf(c.children[0])).join('') === 'FSGVXC', 'each row’s monogram')
  check(textOf(conns[0].children[2]) === 'Off' && textOf(conns[5].children[2]) === 'Off', 'an unconnected account reads Off')
  check(textOf(conns[1].children[2]) === 'Not linked' && conns[1].children[2].className === 'ph-state err', 'a paired host with no broker link reads a failure in danger')
  const prefs = ['where', 'workers', 'pr', 'models'].map((id) => byId(m.root, `ph-pref-${id}`))
  check(prefs.map((p) => `${textOf(p.children[0])}=${textOf(p.children[1])}`).join('|') ===
    'Where builds go=New repo per idea|Workers for big tasks=Up to 3|Pull requests=Ask me first|Models=Factory default', 'How builds run rows and values')
  check(['ph-setup-move', 'ph-setup-backup', 'ph-setup-pair'].map((id) => textOf(byId(m.root, id).children[0]) || textOf(byId(m.root, id))).join('|')
    .includes('Move to another phone') && textOf(pane).includes('Keys, defaults and build history, one code') &&
    textOf(pane).includes('Back up build history') && textOf(pane).includes('Encrypted, to your relay') &&
    textOf(pane).includes('Pair a different computer') && textOf(pane).includes('Run npx spriite pair there'), 'Your setup rows and their details')
  const adv = byId(m.root, 'ph-advanced')
  check(textOf(adv.children[0]) === 'Advanced' && adv.children[1].children.map((d) => textOf(d.children[0])).join('|') === ADVANCED_LABELS.join('|') &&
    ADVANCED_LABELS.join('|') === 'Factory-native details (models per job, tools, acceptance checks)|Relay and host addresses|Durable runtime and developer flags',
  'Advanced holds exactly the three drawn sections')
  check(byId(adv, 'native-launch') !== null && byId(m.root, 'native-brokerUrl').value === 'https://broker.example.com' &&
    byId(m.root, 'native-ownerId').value === 'owner-example' && byId(m.root, 'native-machineId').value === 'machine-example',
  'the Factory-native form lives under Advanced, prefilled from pairing')
  check(allNodes(m.root, (n) => n.id === 'native-launch').length === 1, 'the Factory-native form appears nowhere else')
  check(textOf(adv).includes('https://broker.example.com') && textOf(adv).includes('owner-example') && textOf(adv).includes('Machine id'), 'Relay and host addresses lists broker, owner and machine')
  check(allNodes(adv, (n) => n.className === 'feed').length === 1 && textOf(adv).includes('Reduce motion') && textOf(adv).includes('Return briefings'),
    'developer flags: the flag toggles, reduce motion and the activity log')
  for (const [row, sheetId] of [['ph-conn-factory', 'ph-sheet-factory'], ['ph-conn-github', 'ph-sheet-github'], ['ph-conn-voice', 'ph-sheet-voice'],
    ['ph-conn-cursor', 'ph-sheet-cursor'], ['ph-conn-host', 'ph-sheet-host'], ['ph-pref-workers', 'ph-sheet-workers'],
    ['ph-pref-pr', 'ph-sheet-pr'], ['ph-pref-models', 'ph-sheet-models'], ['ph-setup-backup', 'ph-sheet-archive']]) {
    byId(m.root, row).onclick()
    check(byId(m.root, sheetId).hidden === false && allNodes(m.root, (n) => n.className === 'ph-overlay' && n.hidden === false).length === 1,
      `${row} opens its sheet (one sheet at a time)`)
  }
  check(control(byId(m.root, 'ph-sheet-factory'), 'Save and test') !== null && control(byId(m.root, 'ph-sheet-factory'), 'Remove') !== null,
    'the Factory sheet hosts the existing Save and test / Remove form')
  byId(m.root, 'ph-conn-x').onclick()
  const x = byId(m.root, 'ph-sheet-x')
  check(x.hidden === false && textOf(byId(x, 'x-host-signin')) === 'Sign in on studio', 'the X sheet leads with Sign in on studio')
  check(allNodes(x, (n) => n.tagName === 'INPUT' && (n.type === 'password' || /token/i.test(String(n.placeholder ?? '')))).length === 0,
    'the X sheet never asks for token JSON')
  check(control(x, 'Read X on my Factory host') !== null, 'the phone-held credential keeps its handoff control')
  byId(m.root, 'ph-pref-where').onclick()
  check(m.fakes.calls.repoChooser.length === 1 && byId(m.root, 'ph-sheet-where').hidden === false, 'Where builds go opens the repo chooser in its sheet')
  byId(m.root, 'ph-setup-move').onclick()
  check(m.fakes.calls.moveScreen.length === 1 && m.fakes.calls.moveScreen[0].hostLabel() === 'studio', 'Move to another phone opens the Move screen full screen')
  m.fakes.calls.moveScreen[0].onBack()
  byId(m.root, 'ph-setup-pair').onclick()
  check(m.fakes.calls.setupFlow.length === 1 && m.fakes.calls.setupFlow[0].context === 'settings' && m.fakes.calls.setupFlow[0].entry === 'pair',
    'Pair a different computer runs the setup flow in the settings context at Pair')
  m.fakes.calls.setupFlow[0].onDone()
  const backup = byId(m.root, 'backup')
  check(backup.type === 'checkbox' && backup.checked === false, 'Back up build history is a checkbox bound to the archive flag (off)')
  backup.checked = true
  await backup.onchange()
  check(m.prefs.flags.archive_mirror === true, 'ticking it turns the archive mirror on')

  const connected = await mount({ setup: 'complete', keysInit: async (keys) => { await keys.setFactory('fk-example') } })
  globalThis.window.dispatchEvent({ type: 'spriite-connect', detail: 'factory' })
  check(byId(connected.root, 'ph-settings').hidden === false && byId(connected.root, 'ph-sheet-factory').hidden === false,
    'a glasses connect prompt opens the matching Settings sheet')
  const firstRun = await mount({ setup: 'none' })
  firstRun.fakes.calls.setupFlow[0].onDone()
  await firstRun.prefs.setSetupCompleted(0)
  globalThis.window.dispatchEvent({ type: 'spriite-connect', detail: 'repo' })
  check(firstRun.fakes.calls.setupFlow.length === 2, 'with setup incomplete a connect prompt opens the setup flow')
}

section('redesign test round 1: phone findings')
{
  // (fake-phone-blocked-by-setup-flow) A dev fake run's keys count as setup.
  const fake = await mount({ setup: 'none', extra: { setupSatisfied: () => true } })
  check(fake.fakes.calls.setupFlow.length === 0 && byId(fake.root, 'ph-home')?.hidden === false,
    'a fake run that supplies its keys shows Home, not Welcome')
  // With setup incomplete the flow covers the app, and a card does not lift it.
  const covered = await mount({ setup: 'none' })
  covered.handle.notify(scene())
  check(covered.fakes.calls.setupFlow.length === 1 && byId(covered.root, 'ph-setup')?.hidden === false,
    'with setup incomplete the setup flow stays over the app')
  check(covered.fakes.calls.setupFlow.length === 1 && byId(covered.root, 'ph-tabs')?.inert !== false,
    'the flow keeps the app behind it out of reach')
  // (newrepo-chip-desync) The chip follows the saved repo mode.
  const chip = await mount({ keysInit: async (keys) => { await keys.setRepoMode('per_idea') } })
  const repoChip = byId(chip.root, 'ph-new-repo')
  check(repoChip['aria-pressed'] === 'true' || repoChip.getAttribute?.('aria-pressed') === 'true', 'New repo starts on for new repo per idea')
  await chip.keys.setRepoMode('one')
  chip.handle.refreshPrefs()
  check(repoChip['aria-pressed'] === 'false' || repoChip.getAttribute?.('aria-pressed') === 'false', 'switching to one repo turns the chip off')
  // (health-unverified-working) A saved, untested key is Saved, not Working.
  const health = await mount({ keysInit: async (keys) => { await keys.setCursor('key_qa_fake_000') } })
  byId(health.root, 'ph-tab-settings').onclick()
  check(textOf(byId(health.root, 'ph-conn-cursor').children[2]) === 'Saved', 'an untested Cursor key reads Saved')
  // (overlay-a11y) A sheet is modal: the page behind is inert while it is open.
  byId(health.root, 'ph-conn-cursor').onclick()
  const sheet = byId(health.root, 'ph-sheet-cursor')
  const shell = sheet.parentNode?.parentNode ?? null
  const behind = shell ? shell.children.filter((c) => c !== sheet.parentNode) : []
  check(sheet.hidden === false && behind.length > 0 && behind.every((c) => c.inert === true), 'an open sheet makes the page behind it inert')
  const topBar = sheet.children[0].children[0]
  const closeBtn = topBar.children[1]
  check(topBar.className === 'ph-sheet-top' && closeBtn.className === 'ph-sheet-close' && textOf(closeBtn) === 'Close',
    'every sheet has a visible Close beside the handle, so it closes without saving')
  closeBtn.onclick()
  check(sheet.hidden === true && behind.every((c) => c.inert === false), 'closing the sheet restores the page')
  byId(health.root, 'ph-conn-cursor').onclick()
  topBar.children[0].onclick()
  check(sheet.hidden === true, 'the handle still closes the sheet')
  check(/\.ph-sheet-top \{ position: sticky;/.test(THEME_CSS) && /max-height: calc\(100dvh/.test(THEME_CSS),
    'the Close bar stays pinned and the sheet leaves a strip of scrim to tap')
  check(!/\.ph-bubbles \{[^}]*overflow-y/.test(THEME_CSS) && !/\.ph-bubbles \{[^}]*max-height/.test(THEME_CSS),
    'the chat is not a scroll box inside the scrolling page (a long chat reaches its end)')
  check(/\.ph-handle \{ width: 64px; height: 44px;/.test(THEME_CSS), 'the sheet handle is a 44 px tall close target')
  // (ready-x-raw-reason) No raw reason codes.
  const why = hostSignInText({ state: 'unavailable', reason: 'not_paired' }, 'your computer')
  check(!/not_paired|\(/.test(why) && /host/.test(why), 'X sign-in unavailability is a plain sentence')
  // (done-build-pause / mission-title-card-label) Finished and watched builds.
  check(agentRows({ real: true, phase: 'attach', sessionId: 's', jobs: [] }, 'x', 'Planning').length === 0, 'a watched build shows nobody working')
  const doneRows = agentRows({ real: true, phase: 'final', sessionId: 's', jobs: [{ state: 'accepted', label: 'A' }] }, 'Wrapped up', 'Done')
  check(doneRows.at(-1).name === 'Reviewer' && doneRows.at(-1).state === 'Done', 'the reviewer is done on a finished build')
}

await settle()
console.log(failures === 0 ? `\nAll ${passes} phone redesign checks passed.` : `\n${failures} phone redesign check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
