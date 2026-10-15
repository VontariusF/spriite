/**
 * Run against an isolated simulator URL with ?fake=1&fake-session-options=1
 * &fresh=1&flags=persistent_runtime_v2&fake-phone=now. No real provider calls.
 * The dev-only probe drives the real phone DOM; /api/input drives glasses.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const timeoutOnly = process.argv.includes('--timeout-only')
const buildOnly = process.argv.includes('--build-only')
const fidelityOnly = process.argv.includes('--fidelity-only')
const navigationOnly = process.argv.includes('--navigation-x-only')
const controlsDir = resolve(root, '.screenshots/session-options')
const shotsArg = process.argv.indexOf('--shots')
const shots = resolve(root, shotsArg >= 0 ? process.argv[shotsArg + 1] : fidelityOnly ? '.screenshots/fidelity-flow' : navigationOnly ? '.screenshots/navigation-x' : buildOnly ? '.screenshots/build-handoff' : timeoutOnly ? '.screenshots/delivery-timeout' : '.screenshots/session-options')
const base = `http://127.0.0.1:${process.argv[2] ?? '9914'}`
mkdirSync(shots, { recursive: true })
mkdirSync(controlsDir, { recursive: true })
let sequence = Date.now()
let lastId = 0
const logs = []
const results = new Map()
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function pull() {
  const res = await fetch(`${base}/api/console${lastId ? `?since_id=${lastId}` : ''}`, { signal: AbortSignal.timeout(5000) })
  for (const entry of (await res.json()).entries) {
    lastId = Math.max(lastId, entry.id)
    logs.push(entry)
    if (entry.message.startsWith('[session-options] {')) {
      const value = JSON.parse(entry.message.slice('[session-options] '.length))
      results.set(value.sequence, value)
    }
  }
}
async function wait(run, timeout = 20000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const result = await run()
    if (result) return result
    await sleep(350)
  }
  throw new Error('Timed out waiting for simulator state')
}
let lastUiMode = null
/**
 * The desktop simulator can stop running the page's timers while its window
 * is hidden and nothing reaches the bridge (a static card, commands only
 * through the file): the probe then never reads the next command. A ring
 * release with no hold in progress is a no-op in the app outside capture
 * (main.ts 'hold_release') and wakes the page. Never sent while listening,
 * where a release would end the capture.
 */
async function wake() {
  await fetch(`${base}/api/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'long_press_release' }) }).catch(() => {})
}
async function command(action, extra = {}) {
  const number = ++sequence
  writeFileSync(resolve(controlsDir, 'control.json'), JSON.stringify({ sequence: number, action, ...extra }))
  // WKWebView snapshotting can delay observation of the dev command file.
  // Require the exact acknowledgment, without treating a capture as success.
  const started = Date.now()
  let wakes = 0
  const result = await wait(async () => {
    await pull()
    const acked = results.get(number)
    if (!acked && lastUiMode !== 'listening' && Date.now() - started > 5000 * (wakes + 1)) {
      wakes++
      await wake()
    }
    return acked
  }, 75000)
  if (result.uiMode) lastUiMode = result.uiMode
  assert.equal(result.ok, true, result.error)
  return result
}
async function state(predicate, timeout = 25000) {
  return wait(async () => {
    const result = await command('inspect')
    return predicate(result) ? result : null
  }, timeout)
}
async function input(action) {
  const res = await fetch(`${base}/api/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
  assert.equal((await res.json()).ok, true)
  await sleep(500)
}
/** HudIdle: the glasses' home is the idle card; its Builds action (one swipe) opens the rows. */
async function openBuilds() {
  await input('down')
  await input('click')
}
async function historyPage(action, target) {
  // Native text containers scroll internally before emitting their boundary
  // event. Drive the real gesture until that event advances the app's page.
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await command('inspect')
    if (result.history.page === target) return result
    assert.ok(action === 'up' ? result.history.page > target : result.history.page < target,
      'History did not skip the target page')
    await input(action)
  }
  throw new Error(`History did not reach page ${target}`)
}
async function screenshot(name, views = ['glasses', 'webview']) {
  for (const view of views) {
    const res = await fetch(`${base}/api/screenshot/${view}`, { signal: AbortSignal.timeout(15000) })
    assert.equal(res.ok, true)
    writeFileSync(resolve(shots, `${name}-${view}.png`), Buffer.from(await res.arrayBuffer()))
  }
}
let checks = 0
function check(ok, label) {
  assert.ok(ok, label)
  checks++
  console.log(`PASS: ${label}`)
}
async function timeoutWalkthrough() {
  let current = await state(s => s.scene.kind === 'selection' && s.scene.items?.length === 4)
  check(current.provider.creates === 0 && current.provider.posts.length === 0, 'timeout fixture starts without launching work')
  await openBuilds()
  await input('click')
  current = await state(s => s.sessionId === 'qa-idle' && s.scene.actions.some(a => a.id === 'continue_session'))
  check(current.provider.posts.length === 0, 'opening the timeout chat is inert')
  // Seed an older identical, acknowledged Continue. It must not confirm
  // the second request when that request loses its acknowledgment.
  await command('continue')
  await state(s => s.provider.posts.length === 1)
  await input('double_click')
  await state(s => s.scene.actions.some(a => a.id === 'continue_session'))
  await command('timeout_next_post', { sessionId: 'qa-idle' })
  await command('continue')
  current = await state(s => s.deliveryUnconfirmed && s.scene.status.includes('Delivery unconfirmed'))
  check(current.provider.posts.length === 2 && current.provider.creates === 0, 'a lost acknowledgment does not create another session or worker')
  check(current.factoryLink === 'https://app.factory.ai/sessions/qa-idle' && current.composerBlocked,
    'phone holds new sends and links to the exact uncertain chat')
  check(!current.scene.actions.some(a => a.id === 'continue_session') && !current.scene.status.includes('failed'),
    'glasses show unconfirmed delivery rather than session failure or another Continue')
  await screenshot('delivery-unconfirmed')
  await sleep(6500)
  current = await command('inspect')
  check(current.deliveryUnconfirmed && current.provider.posts.length === 2,
    'continued reads do not resend or use the older identical turn as receipt')
  await command('open', { value: 'Running saved chat' })
  current = await state(s => s.sessionId === 'qa-running' && !s.deliveryUnconfirmed)
  check(!current.factoryLink && !current.composerBlocked, 'another selected chat does not inherit the uncertainty or Factory link')
  await command('open', { value: 'Idle saved chat' })
  current = await state(s => s.sessionId === 'qa-idle' && s.deliveryUnconfirmed)
  check(current.provider.posts.length === 2 && current.composerBlocked, 'returning restores uncertainty without retrying the message')
  await input('click') // History is the first uncertainty action.
  await state(s => s.history.open)
  await screenshot('delivery-history')
  check((await command('inspect')).provider.posts.length === 2, 'History remains available without another POST')
  await input('double_click')
  await command('open', { value: 'Resolve' }) // Real phone DOM action.
  current = await state(s => s.scene.utterance.startsWith('Seen this request in Factory'))
  check(current.deliveryUnconfirmed, 'Resolve requires a separate explicit owner receipt')
  await screenshot('delivery-resolve')
  await input('click') // First glasses action: Seen in Factory.
  current = await state(s => !s.deliveryUnconfirmed && s.scene.actions.some(a => a.id === 'continue_session'))
  check(current.provider.posts.length === 2 && current.provider.creates === 0 && !current.composerBlocked,
    'explicit owner receipt clears the local hold without resending or approving implementation')
  await screenshot('delivery-resolved')
  await command('timeout_next_post', { sessionId: 'qa-idle' })
  await command('continue')
  await state(s => s.deliveryUnconfirmed)
  await command('open', { value: 'Resolve' })
  current = await command('open', { value: 'Stop waiting' })
  check(!current.deliveryUnconfirmed && current.provider.posts.length === 3,
    'owner can release an unresolved hold without falsely marking it received')
  await sleep(6500)
  current = await command('inspect')
  check(current.provider.posts.length === 3 && current.provider.creates === 0,
    'releasing a hold neither retries the request nor starts implementation')
  await screenshot('delivery-released')
  return current
}
async function buildWalkthrough() {
  let current = await state(s => s.scene.kind === 'selection' && s.scene.items?.length === 4)
  check(current.provider.creates === 0 && current.provider.posts.length === 0, 'handoff fixture starts with no work')
  await openBuilds()
  await input('click')
  current = await state(s => s.sessionId === 'qa-idle' && s.scene.status.includes('idle'))
  check(current.provider.creates === 0 && !current.buildDraft, 'opening the planning-only source does not adopt it')
  await command('message')
  await command('send', { value: 'Build it' })
  current = await state(s => s.buildDraft && s.scene.actions.some(a => a.id === 'confirm_chat_build'))
  check(current.provider.creates === 0 && current.provider.posts.length === 0, 'phone build request is a review, not another planning message')
  check(current.phoneOutcome.startsWith('Build request handled locally.'), 'phone feedback does not falsely claim a planning message was sent')
  check(current.scopeInHistory, 'full chosen outcome and done-means scope are visible in phone history')
  await screenshot('scope-review')
  await input('double_click')
  current = await state(s => !s.scene.actions.some(a => a.id === 'confirm_chat_build'))
  check(current.provider.creates === 0 && current.provider.posts.length === 0, 'glasses Cancel grants no execution authority')
  await command('voice_build', { value: 'Start the build' })
  current = await state(s => s.scene.actions.some(a => a.id === 'confirm_chat_build'))
  check(current.provider.creates === 0 && current.provider.posts.length === 0, 'synthetic general voice routes into scope review, not another plan')
  await input('double_click')
  await state(s => !s.scene.actions.some(a => a.id === 'confirm_chat_build'))
  await command('voice_message', { value: 'Build it' })
  current = await state(s => s.scene.actions.some(a => a.id === 'confirm_chat_build'))
  check(current.provider.creates === 0 && current.provider.posts.length === 0, 'synthetic Send message voice routes into the same scope review')
  await state(s => s.scene.actions.some(a => a.id === 'confirm_chat_build'))
  await input('click') // Native glasses primary action: explicitly Start build.
  current = await state(s => s.launchedWorkers === 1 && s.sessionId !== 'qa-idle')
  check(current.provider.creates + (current.provider.agents ?? 0) === 2, 'glasses confirmation creates one coordinator and one execution worker using the selected provider')
  check(current.ownsSelectedOutcome && current.approvedPlanCount === 4, 'managed worker retains the selected outcome and all four criteria')
  check(current.provider.posts.every(p => p.sessionId !== 'qa-idle'), 'original planning-only chat never receives Build or Continue')
  // The webview capture uses html2canvas and can stall SDK callbacks past
  // their storage deadline. Observe the native framebuffer now; capture
  // the phone only once launch receipts have settled below.
  await screenshot('execution-started', ['glasses'])
  const count = current.provider.creates + (current.provider.agents ?? 0)
  await state(s => s.buildTitles.includes('Idle saved chat'))
  await command('open', { value: 'Idle saved chat' })
  await state(s => s.sessionId === 'qa-idle')
  await command('message')
  await command('send', { value: 'Build it' })
  current = await state(s => s.sessionId !== 'qa-idle' && s.workerCount === 1)
  check(current.provider.creates + (current.provider.agents ?? 0) === count, 'repeating Build from the original chat reuses the saved controller')
  current = await state(s => (s.phase === 'final' && s.prReady && s.unresolvedDispatchCount === 0) || s.pendingPrApproval || s.scene.kind === 'factory_error', 120000)
  check(current.scene.kind !== 'factory_error', 'post-review dispatch remains durably recorded without a storage fault')
  check(current.phase === 'final' || current.pendingPrApproval, 'synthetic execution progresses through review to delivery or the PR gate')
  check(current.durability === 'ok' && current.unresolvedDispatchCount === 0, 'downstream launch receipts are durably confirmed')
  // html2canvas can block WKWebView. Capture after dispatch settles, not
  // while the provider wrapper is committing an in-flight launch.
  await screenshot('existing-controller')
  return current
}
async function fidelityWalkthrough() {
  await state(s => s.scene.kind === 'selection' && s.scene.items?.length === 4)
  await openBuilds()
  await input('click')
  let current = await state(s => s.sessionId === 'qa-idle' && s.scene.actions.some(a => a.id === 'continue_session'))
  check(current.provider.creates === 0, 'opening the stopped conversation is inert')
  await input('click')
  current = await state(s => s.scene.kind === 'selection' && s.scene.items?.includes('MVP core workflow'))
  check(current.provider.posts.length === 1 && current.provider.posts[0].continuation,
    'one explicit Continue surfaces the exact fidelity decision')
  await screenshot('fidelity-question', ['glasses'])
  await input('down'); await input('down'); await input('click')
  current = await state(s => s.scene.actions?.some(a => a.id === 'review_chat_build'))
  check(current.provider.creates === 0 && current.provider.posts.length === 2,
    'choosing MVP fidelity exposes Review build without granting execution')
  await input('click')
  current = await state(s => s.buildDraft && s.mvpScope)
  check(current.provider.posts.length === 2 && current.scene.actions.some(a => a.id === 'confirm_chat_build'),
    'native Review build retains the exact MVP scope and does not request another plan')
  await screenshot('mvp-scope-review')
  await input('double_click')
  await state(s => !s.buildDraft && s.scene.actions?.some(a => a.id === 'review_chat_build'))
  await command('voice_build', { value: 'Continue' })
  current = await state(s => s.buildDraft)
  check(current.provider.posts.length === 2, 'general voice Continue reviews available scope instead of resuming a planning loop')
  await input('double_click')
  await state(s => !s.buildDraft)
  await command('voice_message', { value: 'continue' })
  current = await state(s => s.buildDraft)
  check(current.provider.posts.length === 2, 'Send message Continue reaches the same local scope review')
  await input('click')
  current = await state(s => s.launchedWorkers === 1 && s.mvpScope)
  check(current.approvedPlanCount === 4 && current.provider.creates + current.provider.agents === 2,
    'explicit Start build launches one scoped execution worker and its coordinator')
  check(current.provider.posts.filter(p => p.sessionId === 'qa-idle').length === 2,
    'the original planning chat receives only Continue and the owner fidelity answer')
  await screenshot('mvp-worker', ['glasses'])
  current = await state(s => (s.phase === 'final' && s.prReady && s.unresolvedDispatchCount === 0) || s.scene.kind === 'factory_error', 120000)
  check(current.phase === 'final' && current.durability === 'ok', 'the MVP worker progresses through review to synthetic PR delivery')
  await screenshot('mvp-delivered')
  return current
}
async function navigationWalkthrough() {
  await state(s => s.scene.kind === 'selection' && s.scene.items?.length === 4)
  await command('open', { value: 'Read-only saved chat' })
  let current = await state(s => s.nativeQuestion && s.scene.actions?.some(a => a.id === 'show_builds'))
  check(current.scene.actions.map(a => a.label).join(',') === 'Read,Open on phone,Builds',
    'native Factory question exposes reading, phone handoff, and real Builds navigation')
  check(current.factoryLink?.endsWith('/qa-readonly'), 'the phone link targets this exact native question')
  await input('down'); await input('click')
  current = await state(s => s.factoryLinkFocused)
  check(current.nativeQuestion && current.provider.posts.length === 0, 'glasses Open on phone focuses the clickable link without answering or sending')
  await screenshot('native-phone-handoff')
  await command('background_x')
  current = await state(s => s.nativeQuestion && s.buildTitles.some(t => /^spin this up/i.test(t)))
  check(current.provider.creates === 1 && current.launchedWorkers === 0,
    'a source-approved X task gets its own planning coordinator without stealing or answering the open question')
  await input('double_click') // dismiss the phone-handoff notice if still present
  if ((await command('inspect')).scene.kind !== 'selection') await input('double_click')
  current = await state(s => s.scene.kind === 'selection' && s.scene.items?.length === 5)
  check(!current.nativeQuestion, 'native Back reaches Builds while the original question remains pending remotely')
  const title = current.buildTitles.find(t => /^spin this up/i.test(t))
  await command('open', { value: title })
  current = await state(s => s.plexoScope && s.scene.actions?.some(a => a.id === 'review_chat_build'))
  check(current.awaiting === 'plan' && current.launchedWorkers === 0 && current.destinationRetained,
    'the exact X reply stays unapproved and reviewable; Plexo reference does not replace the configured repository')
  await input('click')
  current = await state(s => s.buildDraft)
  check(current.provider.creates === 1 && current.provider.agents === 0, 'reviewing the X scope starts no worker')
  await input('click')
  current = await state(s => s.launchedWorkers === 1 && s.hudKind === 'running')
  check(current.provider.creates === 1 && current.provider.agents === 1, 'confirming the owned X scope reuses its coordinator and launches one worker')
  await input('double_click')
  await state(s => s.scene.kind === 'selection')
  await command('open', { value: 'Read-only saved chat' })
  current = await state(s => s.nativeQuestion)
  check(current.factoryLink?.endsWith('/qa-readonly') && current.provider.posts.every(p => p.sessionId !== 'qa-readonly'),
    'returning restores the unanswered native question without an answer, resend, or cancellation')
  await input('down'); await input('down'); await input('click') // Builds, not Read
  await state(s => s.scene.kind === 'selection')
  await command('open', { value: title })
  current = await state(s => (s.phase === 'final' && s.prReady && s.unresolvedDispatchCount === 0) || s.scene.kind === 'factory_error', 120000)
  check(current.phase === 'final' && current.durability === 'ok', 'the independently selected X task delivers a synthetic PR while navigation preserves both task owners')
  await screenshot('x-delivered')
  return current
}
try {
  await wait(async () => { await pull(); return logs.some(e => e.message.includes('probe ready')) })
  let current
  if (fidelityOnly) current = await fidelityWalkthrough()
  else if (navigationOnly) current = await navigationWalkthrough()
  else if (buildOnly) current = await buildWalkthrough()
  else if (timeoutOnly) current = await timeoutWalkthrough()
  else {
  const home = await state(s => s.scene.kind === 'selection' && s.scene.items?.length === 4)
  check(home.provider.creates === 0 && home.provider.posts.length === 0, 'home lists synthetic chats without launching work')
  await openBuilds()
  await input('click')
  current = await state(s => s.sessionId === 'qa-idle' && s.scene.status.includes('idle') && s.chatHasEnd)
  check(current.scene.actions.map(a => a.label).join(',') === 'Continue,Send message,History', 'glasses opening idle chat offers explicit next steps')
  check(current.scene.utterance.startsWith('Last reply:') && current.phoneHasEnd, 'phone retains full historical reply while glasses label the preview')
  check(current.provider.creates === 0 && current.provider.posts.length === 0, 'opening idle chat sends no message')
  check(current.chatContexts.join(',') === 'qa-idle' && !current.phoneHeader.includes('Working'),
    'idle phone header is neutral and context belongs to the selected chat')
  await screenshot('idle-options')
  await input('click') // first action: Continue
  current = await state(s => s.provider.posts.length === 1)
  check(current.provider.posts[0].sessionId === 'qa-idle' && current.provider.posts[0].continuation, 'glasses Continue requests the selected existing chat')
  check(current.provider.creates === 0, 'Continue creates no session or worker')
  await screenshot('continue-sent')
  // The chat answers Continue with a reply card; let it land, then dismiss
  // it, so the phone's Send message is pressed on the settled session card.
  await state(s => s.scene.kind === 'status_answer' && /replied/.test(s.scene.status))
  await input('double_click') // dismiss the transient
  await state(s => s.scene.kind === 'running' && s.scene.actions.some(a => a.id === 'continue_session') && s.scene.actions.some(a => a.id === 'send_message'))
  current = await command('message')
  check(current.composerFocused && current.provider.posts.length === 1, 'phone Send message focuses composition without microphone or posting')
  await screenshot('phone-composer')
  await command('send', { value: 'Synthetic phone message: keep the scope unchanged.' })
  current = await state(s => s.provider.posts.length === 2)
  check(current.provider.posts[1].sessionId === 'qa-idle' && !current.provider.posts[1].continuation, 'phone Send posts the typed message to the selected chat')
  // The chat answers the message with a reply card (History, Back). Let it
  // land before pressing on: a reply arriving between the swipe and the
  // press would take the press (History, not Send message).
  await state(s => s.scene.kind === 'status_answer' && /replied/.test(s.scene.status))
  await input('double_click')
  await state(s => s.scene.kind === 'running' && s.scene.actions.some(a => a.id === 'continue_session'))
  await input('down')
  await input('click') // Send message on glasses
  current = await state(s => s.uiMode === 'listening' || s.hudKind === 'mic_error')
  const microphoneAvailable = current.uiMode === 'listening'
  check(current.provider.posts.length === 2, microphoneAvailable
    ? 'glasses Send message opens capture without posting'
    : 'glasses Send message reports microphone failure without posting')
  if (!microphoneAvailable) console.log('LIMITATION: simulator CoreAudio capture unavailable; live dictation is not qualified')
  await screenshot(microphoneAvailable ? 'glasses-message-capture' : 'glasses-message-mic-error')
  await input('double_click') // cancel without recording a dictated message
  current = await state(s => s.uiMode === 'scene')
  check(current.provider.posts.length === 2, 'dismissed glasses message attempt sends nothing')
  // Reopening is inert and resets the action focus.
  await command('open', { value: 'Idle saved chat' })
  await state(s => s.scene.kind === 'running')
  await input('down')
  await input('down')
  await input('click') // History
  current = await state(s => s.history.open)
  check(current.history.contextLabel !== '', 'History keeps the selected real-session label')
  await screenshot('history')
  current = await historyPage('up', 0)
  await screenshot('history-first-page')
  const historyBodies = [current.history.body]
  for (let i = 1; i < current.history.count; i++) {
    const page = await historyPage('down', i)
    historyBodies.push(page.history.body)
    if (page.history.body.includes('HISTORY END')) await screenshot('history-tail')
  }
  check(historyBodies.join('').includes('HISTORY END'), 'glasses History pages through the complete retained reply')
  check((await command('inspect')).provider.posts.length === 2, 'History reads without sending a request')
  await input('double_click')
  await command('open', { value: 'Running saved chat' })
  current = await state(s => s.sessionId === 'qa-running' && s.scene.status.includes('building'))
  current = await state(s => s.chatContexts.join(',') === 'qa-running')
  check(current.chatContexts.join(',') === 'qa-running', 'switching chats replaces history with the selected running chat')
  check(!current.scene.actions.some(a => a.id === 'continue_session') && current.scene.actions.some(a => a.id === 'send_message'), 'active chat offers messaging, not duplicate continuation')
  await screenshot('active-options')
  await command('status', { sessionId: 'qa-running', value: 'pending' })
  await state(s => s.scene.status.includes('queued'))
  await screenshot('queued-options')
  await command('status', { sessionId: 'qa-running', value: 'unreachable' })
  current = await state(s => /unknown|unconfirmed/.test(s.scene.status)) // COPY.real.status.unknown: 'activity unconfirmed'
  check(current.scene.pose === 'reconciling' && !current.scene.actions.some(a => a.id === 'continue_session'), 'failed checks show unknown activity without Continue')
  await screenshot('unknown-options')
  await command('status', { sessionId: 'qa-running', value: 'idle' })
  current = await state(s => s.scene.status.includes('idle') && s.scene.actions.some(a => a.id === 'continue_session'))
  check(current.scene.pose === 'idle', 'recovered idle state offers continuation again')
  await command('open', { value: 'Read-only saved chat' })
  current = await state(s => s.sessionId === 'qa-readonly' && s.factoryLink)
  current = await state(s => s.chatContexts.join(',') === 'qa-readonly' && s.factoryLink)
  check(current.chatHasEnd && current.phoneHasEnd && !current.phoneHeader.includes('Working'),
    'read-only chat loads its own full history on the phone')
  check(current.factoryLink === 'https://app.factory.ai/sessions/qa-readonly', 'read-only phone link points to the selected Factory chat')
  check(current.scene.actions.some(a => a.id === 'open_factory') && !current.scene.actions.some(a => ['continue_session', 'send_message'].includes(a.id)), 'read-only chat offers Factory handoff instead of ineffective controls')
  await screenshot('readonly-options')
  await input('click')
  current = await state(s => s.scene.utterance.includes('continue or send a message'))
  check(current.factoryLink.endsWith('/qa-readonly') && current.provider.posts.length === 2, 'glasses handoff explains the phone link without sending or navigating')
  check(current.scene.utterance.startsWith('Read this session here.'), 'read-only help distinguishes reading context from sending')
  await screenshot('readonly-help')
  }
  await pull()
  if (buildOnly || fidelityOnly || navigationOnly) {
    const handledFaults = logs.filter(e => /\[engine\].* fault|\[outbox\].*intent not acknowledged|\[store\].*write (failed|threw)/.test(e.message))
    check(handledFaults.length === 0 && Array.from(results.values()).every(s =>
      s.scene?.kind !== 'factory_error' && s.durability !== 'broken'),
    'simulator records no handled provider or storage faults')
  }
  const errors = logs.filter(e => e.message.includes('[uncaught]') || e.message.includes('[unhandledrejection]') || e.message.includes('[sprite] init failed'))
  check(errors.length === 0, 'simulator has no uncaught application errors')
  writeFileSync(resolve(shots, 'evidence.json'), JSON.stringify({ mode: fidelityOnly ? 'fidelity-flow' : navigationOnly ? 'navigation-x' : buildOnly ? 'build-handoff' : timeoutOnly ? 'delivery-timeout' : 'session-options', checks, current, logs }, null, 2))
  console.log(`${fidelityOnly ? 'FIDELITY FLOW' : navigationOnly ? 'NAVIGATION X' : buildOnly ? 'BUILD HANDOFF' : timeoutOnly ? 'DELIVERY TIMEOUT' : 'SESSION OPTIONS'} WALKTHROUGH PASSED: ${checks} checks`)
} catch (error) {
  await pull().catch(() => {})
  writeFileSync(resolve(shots, 'failed-evidence.json'), JSON.stringify({ error: String(error), logs }, null, 2))
  console.error(`SESSION OPTIONS WALKTHROUGH FAILED: ${error.stack}`)
  process.exitCode = 1
}
