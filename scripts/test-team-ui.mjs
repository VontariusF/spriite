import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { mountPhoneApp } from '../src/phone/app.ts'
import { RealOrchestrator } from '../src/factory/real.ts'
import { fakeClients, FAKE } from '../src/factory/fake.ts'
import { COPY } from '../src/factory/copy.ts'
import { sendVoiceMessage, voiceTargetOf, VoiceTurnGuard } from '../src/voice/turn.ts'
import { KeyVault } from '../src/voice/keys.ts'
import { PrefsVault } from '../src/state/prefs.ts'
import { FeedVault } from '../src/state/feed.ts'
import { phoneDom, makeElement, phoneFakes } from './lib/phone-dom.mjs'

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
// Execute the actual production functions, without booting SDK/network code.
function productionFunction(start, end, context) {
  const source = main.slice(main.indexOf(start), main.indexOf(end, main.indexOf(start)))
  const sandbox = vm.createContext(context)
  vm.runInContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, sandbox)
  return sandbox
}
const nodes = node => [node, ...(node.children ?? []).flatMap(nodes)]
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
let passed = 0
let failed = 0
async function test(label, run) {
  try { await run(); passed++; console.log(`PASS: ${label}`) }
  catch (error) { failed++; console.error(`FAIL: ${label}\n${error.stack}`) }
}

async function mount(options = {}) {
  phoneDom()
  const element = tag => {
    const node = makeElement(tag)
    node.querySelector = () => nodes(node).find(n => n.tagName === 'A' && n.href) ?? null
    node.focus = () => { document.activeElement = node }
    return node
  }
  document.createElement = element
  window.dispatchEvent = event => {
    for (const listener of window.listeners[event.type] ?? []) listener(event)
  }
  const root = element('div')
  const memory = new Map()
  const gateway = { call: async op => op({
    getLocalStorage: async key => memory.get(key) ?? '',
    setLocalStorage: async (key, value) => { memory.set(key, value); return true },
  }) }
  const keys = new KeyVault(gateway)
  const prefs = new PrefsVault(gateway)
  const feed = new FeedVault(gateway)
  await keys.load(); await prefs.load(); await feed.load()
  const provider = fakeClients({ sessionOptions: true, ...options })
  let handle
  const engine = new RealOrchestrator(view => handle?.notify(view), { ...FAKE, clients: provider })
  engine.enableManagedWatchBuildHandoff()
  handle = mountPhoneApp(root, { ...phoneFakes(), keys, prefs, feed, engine: () => engine, runAction: () => {}, onSaved: () => {} })
  engine.boot(); engine.tick(); await settle()
  const open = async title => {
    assert.equal(engine.openBuild(engine.listBuilds().findIndex(row => row.title === title)), true)
    engine.tick(); await settle()
  }
  const input = () => nodes(root).find(n => n.tagName === 'INPUT' && n.enterKeyHint === 'send')
  const button = label => nodes(root).find(n => n.tagName === 'BUTTON' && n.textContent === label)
  const outcome = () => nodes(root).find(n => n.role === 'status').textContent
  // The Mission message bar has no Send button (Mission.dc.html): the
  // keyboard's send key is how a message goes.
  const send = () => { for (const fn of input().listeners.keydown ?? []) fn({ key: 'Enter' }) }
  return { root, engine, provider, handle, open, input, button, outcome, send }
}

await test('refused dictation remains whole, target-bound and never replays', async () => {
  const page = await mount()
  await page.open('Idle saved chat')
  const target = voiceTargetOf(page.engine, page.engine.snapshot())
  page.input().value = 'Existing typed draft'
  page.provider.sessionControls.timeoutNextPost('qa-idle')
  const transcript = `Keep SQLite and do not deploy.\n${'Full untruncated dictated detail. '.repeat(90)}END OF UNSENT DICTATION`
  const scenes = []
  const guard = new VoiceTurnGuard()
  const turn = guard.begin(target)
  const scribe = { error: null, finish: async () => {
    // The phone's POST becomes uncertain while this actual capture settles.
    page.engine.handleAction('continue_session'); await settle()
    return transcript
  } }
  const route = productionFunction('async function onTalkFinished(', '\nasync function cancelTalk(', {
    engine: page.engine, phone: page.handle, sendVoiceMessage, COPY,
    voiceTurns: guard, voiceTurn: turn, messageVoiceTurn: turn, scribe,
    liveVoice: true, settlingScribe: null, store: { uiMode: 'listening' },
    voiceTarget: () => voiceTargetOf(page.engine, page.engine.snapshot()),
    presentEngineView: async () => {}, transcribingScene: () => ({ utterance: 'Transcribing' }),
    voiceHeardScene: utterance => ({ utterance }),
    presentLocalScene: async scene => scenes.push(scene),
  })
  await route.onTalkFinished(12, 'tap')
  assert.equal(page.engine.hasUnconfirmedDelivery, true)
  assert.equal(voiceTargetOf(page.engine, page.engine.snapshot()).mission, target.mission)
  assert.equal(route.store.uiMode, 'scene')
  assert.ok(nodes(page.root).some(n => n.tagName === 'TEXTAREA' && n.value === transcript),
    'the phone must retain the full transcript, not only a generic refusal')
  assert.equal(page.input().value, 'Existing typed draft')
  assert.equal(page.provider.sessionControls.inspect().posts.length, 1)
  assert.equal(page.button('Copy to composer').disabled, true)
  await page.open('Running saved chat')
  assert.equal(page.button('Copy to composer').disabled, true, 'draft cannot migrate to another chat')
  await page.open('Idle saved chat')
  assert.equal(page.engine.hasUnconfirmedDelivery, true)
  page.engine.handleAction('resolve_delivery'); page.engine.handleAction('delivery_release')
  page.handle.notify(page.engine.currentView)
  assert.equal(page.button('Copy to composer').disabled, true, 'existing typed text must not be overwritten')
  page.input().value = ''
  page.handle.notify(page.engine.currentView)
  assert.equal(page.button('Copy to composer').disabled, false)
  page.button('Copy to composer').click()
  assert.equal(page.input().value, transcript)
  assert.equal(page.provider.sessionControls.inspect().posts.length, 1, 'copying is not sending')
  assert.ok(nodes(page.root).some(n => n.tagName === 'TEXTAREA' && n.value === transcript))
  assert.equal(scenes.length, 2)
})

for (const hold of [false, true]) {
  await test(`${hold ? 'delivery hold' : 'read-only'} handoff focuses the rendered connected anchor`, async () => {
    const page = await mount()
    await page.open(hold ? 'Idle saved chat' : 'Read-only saved chat')
    if (hold) {
      page.provider.sessionControls.timeoutNextPost('qa-idle')
      page.engine.handleAction('continue_session'); await settle()
    }
    const action = productionFunction('function runAction(', '\n/** Scroll the phone panel', {
      engine: page.engine, window, CustomEvent: class { constructor(type) { this.type = type } },
    })
    action.runAction({ id: 'open_factory', kind: 'read_only', label: 'Open Factory' })
    assert.equal(document.activeElement?.href, `https://app.factory.ai/sessions/${hold ? 'qa-idle' : 'qa-readonly'}`)
    assert.ok(nodes(page.root).includes(document.activeElement), 'focus must survive liveCard replacement')
    assert.equal(page.engine.hasUnconfirmedDelivery, hold)
    assert.equal(page.provider.sessionControls.inspect().posts.length, hold ? 1 : 0)
  })
}

await test('typed Continue with scope reports local review, not delivery', async () => {
  const page = await mount({ buildScope: true })
  await page.open('Idle saved chat')
  assert.equal(page.engine.canReviewChatBuild(), true)
  page.input().value = 'Continue'
  page.send(); await settle()
  assert.ok(page.engine.snapshot().buildDraft)
  assert.equal(page.provider.sessionControls.inspect().posts.length, 0)
  assert.match(page.outcome(), /^Build request handled locally\./)
})

await test('typed Continue without scope retains ordinary message feedback', async () => {
  const page = await mount()
  await page.open('Idle saved chat')
  page.input().value = 'Continue'
  page.send(); await settle()
  assert.equal(page.provider.sessionControls.inspect().posts.length, 1)
  assert.match(page.outcome(), /^Sent\./)
})

await test('native questions retain refused dictation without answering or copying', async () => {
  const page = await mount({ fidelityNavigation: true })
  await page.open('Read-only saved chat')
  assert.ok(page.engine.nativeQuestionLink())
  const route = productionFunction('async function routeVoice(', '\nasync function cancelTalk(', {
    engine: page.engine, phone: page.handle, sendVoiceMessage, COPY,
    voiceHeardScene: utterance => ({ utterance }), presentLocalScene: async () => {},
  })
  await route.routeVoice(3, 'Use Postgres, not SQLite.', true)
  assert.equal(page.button('Copy to composer').disabled, true)
  page.button('Copy to composer').click()
  assert.equal(page.input().value, '')
  assert.ok(page.engine.nativeQuestionLink())
  assert.equal(page.provider.sessionControls.inspect().posts.length, 0)
  const count = nodes(page.root).filter(n => n.tagName === 'TEXTAREA' && n.readOnly).length
  await route.routeVoice(0, '   ', true)
  assert.equal(nodes(page.root).filter(n => n.tagName === 'TEXTAREA' && n.readOnly).length, count)
})

console.log(`Team UI: ${passed} passed, ${failed} failed (scenario groups)`)
if (failed) process.exitCode = 1
