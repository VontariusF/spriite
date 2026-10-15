/**
 * HUD redesign tests (docs/design/redesign/Hud*.dc.html, MotionLab.dc.html).
 *
 * The boards are drawn at 2x; every expectation here is the board's value
 * divided by two on the 576x288 canvas. Covers:
 *  - each board's layout payload: container positions and sizes, text
 *    levels, the focused action's border, the dimmed rest, the Run card's
 *    swipe hints, the Ask options list and footer, the listening page;
 *  - the segmented milestone bar pixels (done solid, review dotted, todo
 *    dim) and the capture bar, in their two 220 px halves;
 *  - renderer behaviour: bar halves before the sprite, in-place focus and
 *    option moves, the listening timer, the speaking pose override;
 *  - the board copy and its budgets;
 *  - legacy and new pose names validating and drawing through toPose;
 *  - the per-idea repository default and spoken replies (C8).
 *
 * Usage: node --import ./scripts/ts-resolve.mjs scripts/test-hud-redesign.mjs
 */
import { validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext'
import {
  CT,
  G,
  actionRow,
  composeContextLine,
  conversationLayout,
  listeningLayout,
  optionRows,
  selectionLayout,
} from '../src/render/layout.ts'
import {
  HALF_H,
  HALF_W,
  SEG_W,
  captureBarPixels,
  captureFraction,
  milestoneMarks,
  segmentBarPixels,
  segmentSpan,
  splitHalves,
} from '../src/render/progress.ts'
import { Renderer, sceneHasSwipeHints, selectionFooter } from '../src/render/renderer.ts'
import { COPY, buildTitle } from '../src/factory/copy.ts'
import { validateScene, BUDGETS } from '../src/scenes/validate.ts'
import { SPRITE_POSES } from '../src/scenes/types.ts'
import { LEGACY_POSE_NAMES, POSE_NAMES, toPose } from '../src/sprite/poses.ts'
import { framePixels } from '../src/sprite/frames.ts'
import { resolvePose } from '../src/sprite/resolve.ts'
import { speakReply, spokenText } from '../src/voice/speak.ts'
import { RuntimeEngine, perIdeaRouting } from '../src/runtime/app-engine.ts'
import { RealOrchestrator } from '../src/factory/real.ts'
import { InputNormalizer } from '../src/input/normalize.ts'
import { OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { TestKV, makeClients, makeRuntime, settleAll, REPO, SETTINGS } from './lib/runtime-fake.mjs'

let failures = 0
function assert(ok, label) {
  if (ok) console.log('  PASS:', label)
  else {
    failures++
    console.log('  FAIL:', label)
  }
}

const tick = (ms = 6) => new Promise((r) => setTimeout(r, ms))
const textOf = (layout, id) => layout.payload.textObject.find((t) => t.containerID === id)
const imageOf = (layout, id) => layout.payload.imageObject.find((t) => t.containerID === id)
const at = (c, x, y, w, h) => c !== undefined && c.xPosition === x && c.yPosition === y && (w === undefined || c.width === w) && (h === undefined || c.height === h)
const payloadOf = (l) => ({
  containerTotalNum: l.payload.containerTotalNum,
  textObject: l.payload.textObject,
  imageObject: l.payload.imageObject,
  menuObject: l.payload.menuObject,
})
const withinBudget = (l) => {
  const texts = l.payload.textObject.length
  const images = l.payload.imageObject.length
  return l.payload.containerTotalNum === texts + images && texts <= 8 && images <= 4 &&
    texts + images <= 12 && l.payload.imageObject.every((i) => i.width >= 20 && i.width <= 288 && i.height >= 20 && i.height <= 144) &&
    l.payload.textObject.filter((t) => t.isEventCapture === 1).length === 1 &&
    validateEvenHubPageContainer(payloadOf(l)).valid === true
}
const rightAligned = (line, detail) => line.endsWith(detail) && getTextWidth(line) <= 528 && getTextWidth(line) >= 528 - getTextWidth(' ') - 1

const act = (id, label, kind = 'command') => ({ id, label, kind })
const scene = (over = {}) => ({
  schemaVersion: 1, sceneId: 's1', sceneRevision: 1, missionId: null, stateSequence: 1,
  kind: 'meet', spritePose: 'idle', contextLabel: 'SPRIITE', utterance: 'Ready when you are.',
  status: 'Hold to talk, or swipe for builds.', progress: null,
  actions: [act('talk', 'Talk', 'local_capture'), act('builds', 'Builds', 'read_only'), act('needs_you', 'Needs you')],
  evidenceIds: [], generatedAt: '2026-01-01T00:00:00.000Z', transientMs: 0,
  contextDetail: '3 builds · 1 needs you',
  ...over,
})
const RUN_PROGRESS = { acceptedWeight: 50, pendingReviewWeight: 25, totalWeight: 100, planRevision: 1, milestones: ['done', 'done', 'review', 'todo'] }

// ------------------------------------------------------------ 1. HudIdle
{
  console.log('HudIdle: context line, sprite, text, actions')
  const s = scene()
  const l = conversationLayout({
    contextLabel: s.contextLabel, contextDetail: s.contextDetail, utterance: s.utterance, status: s.status,
    actions: s.actions.map((a) => a.label), focusIdx: 0, hints: sceneHasSwipeHints(s), hasProgress: false,
  })
  const ctx = textOf(l, CT.ctx.id)
  assert(at(ctx, 24, 14, 528, 28) && ctx.textColor === 3, 'context line at (24, 14), 528 wide, level 3 (#5BC874)')
  assert(ctx.content.startsWith('SPRIITE') && rightAligned(ctx.content, '3 builds · 1 needs you'),
    'SPRIITE on the left, "3 builds · 1 needs you" right-aligned on the same line')
  assert(at(imageOf(l, CT.sprite.id), 24, 68, 64, 64), 'sprite 64x64 at (24, 68)')
  const say = textOf(l, CT.say.id)
  assert(at(say, 112, 70, 440) && say.textColor === 4 && say.content === 'Ready when you are.', 'title at (112, 70), 440 wide, level 4 (#B8FFC8)')
  const status = textOf(l, CT.status.id)
  assert(at(status, 112, 70 + 28 + 7, 440) && status.textColor === 3 && status.content === 'Hold to talk, or swipe for builds.',
    'subline 7 px under the title, level 3')
  const box = textOf(l, CT.actions.id)
  assert(at(box, 24, 235, undefined, 36) && box.borderWidth === 1 && box.borderColor === 15 && box.borderRadius === 5 && box.textColor === 4,
    'the focused action sits in a bordered box at (24, 235), 36 high, border #9DFFB0, radius 5, level 4')
  assert(box.content.trim() === 'Talk' && box.isEventCapture === 1, 'Talk is focused (the box holds the input)')
  const rest = textOf(l, CT.rest.id)
  assert(rest.textColor === 2 && /^Builds\s+Needs you$/.test(rest.content) && rest.xPosition === box.xPosition + box.width + 22 - 3,
    'Builds and Needs you follow 22 px after the box, dimmed to level 2 (#3A8A4E)')
  assert(textOf(l, CT.prev.id).content === '', 'the idle card draws no swipe hints')
  assert(withinBudget(l), 'the idle page stays inside the container budgets and passes SDK validation')
}

// --------------------------------------------------------- 2. HudListen
{
  console.log('HudListen: label, transcript, capture bar, actions')
  const l = listeningLayout({
    contextLabel: 'LISTENING', timerText: '0:07 of 0:30', noteText: 'You said',
    hint: '“add a guest checkout to the shop site”', actions: COPY.listening.actions,
  })
  const ctx = textOf(l, CT.ctx.id)
  assert(ctx.content.startsWith('LISTENING') && rightAligned(ctx.content, '0:07 of 0:30'), 'LISTENING left, the timer "0:07 of 0:30" right')
  const note = textOf(l, CT.note.id)
  assert(at(note, 112, 66, 440) && note.textColor === 3 && note.content === 'You said', '"You said" at (112, 66), level 3')
  const hint = textOf(l, CT.hint.id)
  assert(at(hint, 112, 94, 440) && hint.textColor === 4 && hint.content === '“add a guest checkout to the shop site”',
    'the transcript under it in curly quotes, level 4')
  assert(at(imageOf(l, CT.bar.id), 112, 206, 220, 20) && at(imageOf(l, CT.bar2.id), 332, 206, 220, 20),
    'the capture bar spans x 112-552 at y 206 in two 220 px halves')
  assert(at(imageOf(l, CT.sprite.id), 24, 68, 64, 64), 'sprite at (24, 68)')
  assert(textOf(l, CT.actions.id).content.trim() === 'Tap to send' && textOf(l, CT.actions.id).borderWidth === 1 &&
    textOf(l, CT.rest.id).content === 'Double-tap to cancel' && textOf(l, CT.rest.id).textColor === 2,
    '[Tap to send] focused and bordered, Double-tap to cancel dimmed')
  assert(withinBudget(l), 'the listening page stays inside the budgets and passes SDK validation')

  const px = captureBarPixels(captureFraction('0:07 of 0:30'))
  const filled = Math.round(SEG_W * 7 / 30)
  assert(px[1 * SEG_W + filled - 1] === 15 && px[1 * SEG_W + filled] === 3, 'the elapsed share (7 of 30 s) is solid over the dim track')
  assert(px[3 * SEG_W + 10] === 0 && px[0] === 0, 'the capture bar is 3 px high with rounded ends')
  assert(captureFraction('0:30 of 0:30') === 1 && captureFraction('nonsense') === 0, 'the timer parses to the elapsed share')
}

// ------------------------------------------------------------ 3. HudRun
{
  console.log('HudRun: build title, phase detail, segmented bar, swipe hints')
  const s = scene({
    kind: 'running', spritePose: 'building', contextLabel: 'CHECKOUT FLOW', contextDetail: 'BUILDING · 2 OF 4',
    utterance: 'Two workers are wiring the payment step.', status: '6 checks passed · 3 agents', progress: RUN_PROGRESS,
    actions: COPY.real.runningActions,
  })
  assert(sceneHasSwipeHints(s), 'a Run card draws the ‹ › swipe hints')
  const l = conversationLayout({
    contextLabel: s.contextLabel, contextDetail: s.contextDetail, utterance: s.utterance, status: s.status,
    actions: s.actions.map((a) => a.label), focusIdx: 0, hints: true, hasProgress: true,
  })
  const ctx = textOf(l, CT.ctx.id)
  assert(ctx.content.startsWith('CHECKOUT FLOW') && rightAligned(ctx.content, 'BUILDING · 2 OF 4'), 'CHECKOUT FLOW left, BUILDING · 2 OF 4 right')
  assert(at(textOf(l, CT.say.id), 112, 66, 440) && at(textOf(l, CT.status.id), 112, 66 + 28 + 6, 440),
    'utterance at (112, 66), the status 6 px under it')
  assert(at(imageOf(l, CT.bar.id), 112, 200, 220, 20) && at(imageOf(l, CT.bar2.id), 332, 200, 220, 20),
    'the milestone bar sits at x 112, y 200, 440 wide (two halves)')
  const prev = textOf(l, CT.prev.id)
  const box = textOf(l, CT.actions.id)
  const rest = textOf(l, CT.rest.id)
  assert(prev.content === '‹' && prev.textColor === 2 && box.content.trim() === 'Pause' && box.xPosition === 24 + getTextWidth('‹') + 22,
    '‹ dimmed, then the bordered Pause 22 px after it')
  assert(/^Message\s+Milestones\s+›$/.test(rest.content), 'Message and Milestones dimmed, then ›')
  assert(withinBudget(l), 'the Run page stays inside the budgets and passes SDK validation')
  // A four-line utterance moves up so the status clears the bar.
  const long = 'Two workers are wiring the payment step while a third agent checks the refund screen and the reviewer reruns the earlier milestone before the pull request opens.'
  const lines = measureTextWrap(long, 440).lineCount
  const l4 = conversationLayout({ contextLabel: 'X', utterance: long, status: 's', actions: ['Pause'], hasProgress: true })
  const st = textOf(l4, CT.status.id)
  assert(lines === 4 && st.yPosition + st.height <= 200 && textOf(l4, CT.say.id).yPosition > 42,
    'a four-line utterance moves up: its status line still clears the bar at y 200')
}

// ---------------------------------------------------- 4. segmented bar
{
  console.log('Milestone bar pixels: done solid, review dotted, todo dim')
  const full = segmentBarPixels(['done', 'done', 'review', 'todo'])
  const px = (x, y) => full[y * SEG_W + x]
  const spans = [0, 1, 2, 3].map((i) => segmentSpan(i, 4))
  const w = (440 - 18) / 4
  assert(spans.every(([s, e]) => Math.abs(e - s - w) <= 1) && spans[1][0] - spans[0][1] >= 5 && spans[1][0] - spans[0][1] <= 7,
    'four segments of (440 - 3 x 6) / 4 px with 6 px gaps')
  assert(px(spans[0][0] + 3, 4) === 15 && px(spans[1][0] + 3, 4) === 15, 'done segments are solid (#9DFFB0, level 15)')
  const r = spans[2][0]
  assert(px(r + 1, 3) === 15 && px(r + 4, 3) === 15 && px(r + 5, 3) === 0 && px(r + 8, 3) === 0 && px(r + 9, 3) === 15,
    'the in-review segment is dotted: 5 on, 4 off (10/8 at 2x)')
  assert(px(spans[3][0] + 3, 4) === 3, 'the remaining segment is dim (#12301A, level 3)')
  assert(px(spans[0][1] + 2, 4) === 0, 'the gaps stay dark')
  assert(px(spans[0][0], 0) === 0 && px(spans[0][0] + 1, 0) === 15, 'corners are rounded (radius 2 at 2x)')
  assert(px(10, 8) === 0 && px(10, 7) !== 0, 'segments are 8 px high (rows 0-7 of the 20 px container)')
  const [left, right] = splitHalves(full)
  assert(left.length === HALF_W * HALF_H && right.length === HALF_W * HALF_H, 'each half is exactly its 220x20 container')
  assert(left[4 * HALF_W + spans[0][0] + 3] === 15 && right[4 * HALF_W + spans[3][0] + 3 - HALF_W] === 3, 'the halves split the bar at x 220')
  const done = segmentBarPixels(milestoneMarks({ acceptedWeight: 100, pendingReviewWeight: 0, totalWeight: 100, planRevision: 1 }))
  assert([0, 1, 2, 3].every((i) => { const [s, e] = segmentSpan(i, 4); return done[4 * SEG_W + Math.floor((s + e) / 2)] === 15 }),
    'HudDone: all four segments solid')
  // Without marks the segments come from the weights.
  const derived = milestoneMarks({ acceptedWeight: 50, pendingReviewWeight: 25, totalWeight: 100, planRevision: 1 })
  assert(derived.join(',') === 'done,done,review,todo', 'without marks, the weights derive done/review/todo quarters')
  assert(milestoneMarks({ acceptedWeight: 0, pendingReviewWeight: 0, totalWeight: 0, planRevision: 1 }).every((m) => m === 'todo'),
    'a zero-weight plan derives four remaining segments, never NaN')
  assert(milestoneMarks({ ...RUN_PROGRESS, milestones: ['done', 'review', 'todo', 'todo', 'todo'] }).length === 5, 'producer marks set the segment count')
}

// ------------------------------------------------------------ 5. HudAsk
{
  console.log('HudAsk: who asks, question, options, footer')
  const items = ['After they verify', 'Right away', COPY.real.speakAnswer]
  const l = selectionLayout({
    contextLabel: COPY.hud.leadAsks, contextDetail: 'ONBOARDING EMAILS', title: 'When should the welcome email go out?',
    items, focusIdx: 0, footer: selectionFooter('decision'),
  })
  const ctx = textOf(l, CT.ctx.id)
  assert(ctx.content.startsWith('LEAD ASKS') && rightAligned(ctx.content, 'ONBOARDING EMAILS'), 'LEAD ASKS left, the build title right')
  assert(at(imageOf(l, CT.sprite.id), 24, 52, 64, 64), 'sprite at (24, 52)')
  const q = textOf(l, CT.say.id)
  assert(at(q, 112, 54, 440) && q.textColor === 4 && q.content === 'When should the welcome email go out?', 'the question at (112, 54), level 4')
  const focus = textOf(l, CT.list.id)
  assert(at(focus, 24, 132, 528, 36) && focus.borderWidth === 1 && focus.borderColor === 15 && focus.textColor === 4 &&
    focus.content.trim() === 'After they verify' && focus.isEventCapture === 1,
    'the focused option is bordered at (24, 132), 528 wide, level 4')
  const rest = textOf(l, CT.rest.id)
  assert(rest.yPosition === 132 + 36 + 3 && rest.textColor === 3 && rest.content === 'Right away\nSay something else' &&
    rest.xPosition === 24 + 1 + 3 + getTextWidth(' '),
    'the other options follow under it at level 3, aligned with the focused text')
  const foot = textOf(l, CT.note.id)
  assert(at(foot, 24, 256, 528) && foot.textColor === 2 && foot.content === 'Swipe to choose · tap to send · also on your phone',
    'the footer at (24, 256), level 2')
  assert(withinBudget(l), 'the Ask page stays inside the budgets and passes SDK validation')
  const moved = optionRows(items, 1)
  assert(moved.focus.trim() === 'Right away' && moved.rest === 'Say something else\nAfter they verify', 'a swipe turns the options through the bordered slot')
  assert(selectionFooter('projects') === COPY.hud.listFooter, 'other glasses lists carry their own footer')
}

// ----------------------------------------------------------- 6. HudDone
{
  console.log('HudDone: DONE, ready to review, all milestones done')
  const s = scene({
    kind: 'final', spritePose: 'celebrate', contextLabel: 'CHECKOUT FLOW', contextDetail: COPY.hud.doneDetail,
    utterance: COPY.hud.done('checkout flow'), status: COPY.hud.doneStatus,
    progress: { acceptedWeight: 100, pendingReviewWeight: 0, totalWeight: 100, planRevision: 1, milestones: ['done', 'done', 'done', 'done'] },
    actions: COPY.real.finalActions, evidenceIds: ['e1'],
  })
  assert(!sceneHasSwipeHints(s), 'the Done card draws no swipe hints')
  const l = conversationLayout({
    contextLabel: s.contextLabel, contextDetail: s.contextDetail, utterance: s.utterance, status: s.status,
    actions: s.actions.map((a) => a.label), focusIdx: 0, hints: false, hasProgress: true,
  })
  assert(rightAligned(textOf(l, CT.ctx.id).content, 'DONE'), 'CHECKOUT FLOW · DONE')
  assert(textOf(l, CT.say.id).content === 'Checkout flow is ready for you to review.' && textOf(l, CT.status.id).content === 'All checks passed · pull request open',
    'Checkout flow is ready for you to review. / All checks passed · pull request open')
  assert(textOf(l, CT.actions.id).content.trim() === 'Read summary' && /^Next idea\s+Evidence$/.test(textOf(l, CT.rest.id).content),
    '[Read summary] Next idea Evidence')
  assert(validateScene(s, 'engine').length === 0, 'the Done scene validates')
}

// ----------------------------------------------------------- 7. renderer
{
  console.log('Renderer: bar halves first, in-place focus, listening timer, speaking pose')
  const fakeBridge = () => {
    const log = []
    const impl = {
      createStartUpPageContainer: async (p) => { log.push(['create', p]); return 0 },
      rebuildPageContainer: async (p) => { log.push(['rebuild', p]); return true },
      textContainerUpgrade: async (p) => { log.push(['text', p]); return true },
      updateImageRawData: async (p) => { log.push(['image', p]); return 'success' },
    }
    return { log, impl, gateway: { call: (op) => op(impl) } }
  }
  const drain = async () => { await tick(); await tick() }
  const f = fakeBridge()
  const r = new Renderer(f.gateway)
  r.setReduceMotion(true)
  const run = scene({ kind: 'running', spritePose: 'waiting', contextLabel: 'CHECKOUT FLOW', contextDetail: 'BUILDING · 2 OF 4',
    status: '6 checks passed · 3 agents', progress: RUN_PROGRESS, actions: COPY.real.runningActions })
  await r.present({ type: 'scene', scene: run }, 0)
  await drain()
  const imgs = f.log.filter((l) => l[0] === 'image').map((l) => l[1].containerID)
  assert(imgs.slice(0, 3).join(',') === '4,11,5', 'the bar halves (4, 11) are sent before the sprite (5)')
  const sprite = f.log.find((l) => l[0] === 'image' && l[1].containerID === 5)[1].imageData
  assert(sprite.join(',') === framePixels('building.0').join(','), 'a legacy pose ("waiting") draws its MotionLab pose (building) through toPose')
  const n0 = f.log.length
  await r.updateActions(run, 1)
  const texts = f.log.slice(n0).filter((l) => l[0] === 'text')
  assert(f.log.slice(n0).every((l) => l[0] === 'text') && texts.some((t) => t[1].containerID === 6 && t[1].content.trim() === 'Message') &&
    texts.some((t) => t[1].containerID === 12 && /^Milestones\s+Pause\s+›$/.test(t[1].content)),
    'a ring tick turns the actions in place: Message into the box, the rest after it')
  // Speaking: the sprite talks while a reply plays, then returns.
  r.setPoseOverride(resolvePose({ linkDown: false, capturing: false, speaking: true, decisionPending: false, blocked: false,
    ownerCritical: false, transient: null, statusUnknown: false, briefingPending: false, activity: 'building', unrelatedBlocked: false }).pose)
  await drain()
  const last5 = () => f.log.filter((l) => l[0] === 'image' && l[1].containerID === 5).at(-1)[1].imageData.join(',')
  assert(last5() === framePixels('talking.0').join(','), 'speaking -> talking: the sprite talks while a spoken reply plays')
  r.setPoseOverride(null)
  await drain()
  assert(last5() === framePixels('building.0').join(','), 'when the reply ends the card pose returns')
  // Listening: the timer redraws the context line and only the changed half of the capture bar.
  await r.presentListening('listening', '', '0:00 of 0:30', 'Say what we should build.', 'LISTENING', COPY.listening.actions)
  await drain()
  const m = f.log.length
  await r.updateCaptureTimer('0:07 of 0:30')
  await drain()
  const after = f.log.slice(m)
  assert(after.some((l) => l[0] === 'text' && l[1].containerID === 1 && rightAligned(l[1].content, '0:07 of 0:30')),
    'the capture timer redraws the context line detail in place')
  assert(after.filter((l) => l[0] === 'image').map((l) => l[1].containerID).join(',') === '4',
    'only the capture-bar half that changed is sent')
  await r.updateListeningHint('“add a guest checkout”', COPY.listening.heardLabel)
  assert(f.log.slice(m).some((l) => l[0] === 'text' && l[1].containerID === 10 && l[1].content === 'You said') &&
    f.log.slice(m).some((l) => l[0] === 'text' && l[1].containerID === 8 && l[1].content === '“add a guest checkout”'),
    'the first words switch the label to "You said" over the quoted transcript')
  // The question page turns in place.
  await r.present({ type: 'selection', purpose: 'decision', contextLabel: 'LEAD ASKS', contextDetail: 'ONBOARDING EMAILS',
    title: 'When should the welcome email go out?', items: ['After they verify', 'Right away', 'Say something else'], pose: 'asking' }, 0)
  await drain()
  const k = f.log.length
  await r.updateSelectionRows(['After they verify', 'Right away', 'Say something else'], 2)
  assert(f.log.slice(k).every((l) => l[0] === 'text') && f.log.slice(k).some((l) => l[1].containerID === 7 && l[1].content.trim() === 'Say something else'),
    'a ring tick on the question is an in-place upgrade of the bordered option')
  r.stop()
}

// --------------------------------------------------------------- 8. copy
{
  console.log('Board copy and budgets')
  assert(COPY.hud.idleTitle === 'Ready when you are.' && COPY.hud.idleHint === 'Hold to talk, or swipe for builds.', 'HudIdle copy')
  assert(COPY.hud.idleActions.map((a) => a.label).join(',') === 'Talk,Builds,Needs you' &&
    COPY.hud.idleActions.map((a) => a.id).join(',') === 'talk,builds,needs_you', 'HudIdle actions Talk, Builds (builds), Needs you (needs_you)')
  assert(COPY.hud.buildsDetail(3, 1) === '3 builds · 1 needs you' && COPY.hud.buildsDetail(1, 0) === '1 build' &&
    COPY.hud.buildsDetail(4, 2) === '4 builds · 2 need you', 'the idle context detail counts builds and who needs you')
  assert(COPY.listening.heardLabel === 'You said' && COPY.listening.quote('x') === '“x”' &&
    COPY.listening.actions.join(',') === 'Tap to send,Double-tap to cancel' && COPY.listening.contextLive === 'LISTENING', 'HudListen copy')
  assert(COPY.hud.runStatus(6, 3) === '6 checks passed · 3 agents' && COPY.hud.runStatus(1, 1) === '1 check passed · 1 agent', 'HudRun status line')
  assert(COPY.real.runningActions.map((a) => a.label).join(',') === 'Pause,Message,Milestones', 'HudRun actions Pause, Message, Milestones')
  assert(COPY.hud.phaseDetail('BUILDING', 2, 4) === 'BUILDING · 2 OF 4', 'HudRun context detail')
  assert(COPY.real.speakAnswer === 'Say something else' && COPY.hud.askFooter === 'Swipe to choose · tap to send · also on your phone' &&
    COPY.hud.leadAsks === 'LEAD ASKS', 'HudAsk copy')
  assert(COPY.hud.done(buildTitle('Add a checkout flow to the shop')) === 'Checkout flow is ready for you to review.' &&
    COPY.hud.doneStatus === 'All checks passed · pull request open' &&
    COPY.real.finalActions.map((a) => a.label).join(',') === 'Read summary,Next idea,Evidence', 'HudDone copy')
  assert(buildTitle('add a guest checkout to the shop site').toUpperCase() === 'GUEST CHECKOUT' &&
    buildTitle('Add a checkout flow to the shop').toUpperCase() === 'CHECKOUT FLOW', 'a build title is the goal without its verb and article')
  const fits = (t, b) => measureTextWrap(t, b.width).lineCount <= b.lines
  assert([COPY.hud.idleTitle, COPY.hud.done('checkout flow'), 'Two workers are wiring the payment step.'].every((t) => fits(t, BUDGETS.utterance)) &&
    [COPY.hud.idleHint, COPY.hud.runStatus(16, 5), COPY.hud.doneStatus].every((t) => fits(t, BUDGETS.status)) &&
    fits('When should the welcome email go out?', BUDGETS.question) && fits(COPY.hud.askFooter, BUDGETS.footer) &&
    fits('“add a guest checkout to the shop site”', BUDGETS.transcript),
  'every board string fits its container budget')
  const rows = [['Talk', 'Builds', 'Needs you', false], ['Pause', 'Message', 'Milestones', true], ['Read summary', 'Next idea', 'Evidence', false]]
  assert(rows.every(([a, b, c, h]) => [0, 1, 2].every((f) => {
    const row = actionRow([a, b, c], f, h)
    return row.rest.split(/\s{2,}/).filter((x) => x !== '›').length === 2
  })), 'every board actions row keeps all three labels on screen at every focus')
  assert(composeContextLine('lead asks', 'ONBOARDING EMAILS').startsWith('LEAD ASKS'), 'context labels are drawn uppercase')
}

// -------------------------------------------------------------- 9. poses
{
  console.log('Poses: twelve drawn, legacy names valid, toPose')
  const base = scene()
  assert(POSE_NAMES.length === 12 && POSE_NAMES.every((p) => SPRITE_POSES.includes(p)), 'the twelve MotionLab poses are valid scene poses')
  assert(LEGACY_POSE_NAMES.every((p) => SPRITE_POSES.includes(p)), 'legacy pose names stay valid for stored records and fixtures')
  assert([...POSE_NAMES, ...LEGACY_POSE_NAMES].every((p) => validateScene({ ...base, spritePose: p }, 'engine').length === 0),
    'every pose name, new or legacy, validates on a scene')
  assert(validateScene({ ...base, spritePose: 'dancing' }, 'engine').some((i) => i.field === 'spritePose'), 'an unknown pose is still refused')
  assert(toPose('waiting') === 'building' && toPose('accepted') === 'celebrate' && toPose('repair') === 'blocked', 'legacy names draw their MotionLab pose')
  assert(validateScene({ ...base, progress: { ...RUN_PROGRESS, milestones: ['done', 'nope'] } }, 'engine').some((i) => i.field === 'progress.milestones'),
    'a bad milestone mark is refused')
}

// ----------------------------------------------------- 10. per-idea repos
{
  console.log('Per-idea repositories (C8)')
  assert(JSON.stringify(perIdeaRouting('per_idea', 'add a guest checkout to the shop site', 'glasses_voice')) === '{"newRepository":true}',
    'per_idea: a goal naming no repository starts in a new one')
  assert(perIdeaRouting('per_idea', `fix the footer in ${REPO}`, 'phone_text')?.repository === REPO, 'per_idea: a goal naming a repository builds there')
  assert(perIdeaRouting('one', 'add a guest checkout', 'glasses_voice') === null && perIdeaRouting(undefined, 'x', 'phone_text') === null,
    "repoMode 'one' (or unset) changes nothing")
  assert(perIdeaRouting('per_idea', 'add a guest checkout', 'x') === null, 'X requests keep their own routing')

  for (const mode of ['per_idea', 'one']) {
    const kv = new TestKV()
    const clients = makeClients()
    const ctx = makeRuntime(kv, clients)
    const inputs = []
    const submit = ctx.supervisor.submitCommand.bind(ctx.supervisor)
    ctx.supervisor.submitCommand = (input) => { inputs.push(input); return submit(input) }
    const engine = new RuntimeEngine({
      supervisor: ctx.supervisor,
      makeLobby: (emit, projects) => new RealOrchestrator(emit, {
        factoryKey: SETTINGS.factoryKey, githubToken: SETTINGS.githubToken, repoUrl: REPO, computerId: SETTINGS.computerId,
        workerPref: 'factory', jobs: 1, askBeforePr: false, clients, projects,
      }),
      emit: () => {},
      notice: () => {},
      copy: { notSaved: 'not saved', finishedRecord: 'finished' },
      repoMode: () => mode,
    })
    await ctx.supervisor.boot()
    engine.boot()
    engine.voiceGoal('Add a guest checkout to the shop site', 5)
    await tick(20)
    engine.handleAction('start_planning')
    await settleAll(ctx)
    await tick(20)
    const m = ctx.supervisor.missions[0]
    if (mode === 'per_idea') {
      assert(inputs[0]?.newRepository === true && m?.config.newRepository === true && m?.config.repository === '',
        'durable runtime, per_idea: the new mission records newRepository and freezes no default repository')
    } else {
      assert(inputs[0]?.newRepository === undefined && m?.config.repository === REPO,
        "durable runtime, 'one': the mission freezes the configured repository as before")
    }
    ctx.supervisor.stop?.()
  }
}

// ---------------------------------------------------- 11. spoken replies
{
  console.log('Spoken replies (C8)')
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }), { status: 200 })
  }
  let played = 0
  const player = { play: async (_src, signal) => { played++; return !signal.aborted } }
  const ok = await speakReply('The lead says the payment step is wired.', 'el-key', { fetchImpl, player })
  assert(ok === true && played === 1, 'a reply is fetched as speech and played on the phone')
  const req = calls[0]
  assert(req.url.startsWith('https://api.elevenlabs.io/v1/text-to-speech/') && req.init.headers['xi-api-key'] === 'el-key' &&
    JSON.parse(req.init.body).text === 'The lead says the payment step is wired.', 'the request goes to ElevenLabs with the owner key, nowhere else')
  assert((await speakReply('Hello', '', { fetchImpl, player })) === false && calls.length === 1, 'no key: nothing is requested or played')
  const ctrl = new AbortController()
  ctrl.abort()
  assert((await speakReply('Hello', 'el-key', { fetchImpl, player, signal: ctrl.signal })) === false, 'an aborted reply never plays')
  assert((await speakReply('Hello', 'el-key', { fetchImpl, player: null })) === false, 'a WebView that cannot play audio speaks nothing')
  const refused = async () => new Response('no', { status: 401 })
  assert((await speakReply('Hello', 'el-key', { fetchImpl: refused, player })) === false, 'a refused key answers false, never throws')
  assert(spokenText('a '.repeat(2000)).length <= 903, 'a long reply is cut before it is sent')
  assert(resolvePose({ linkDown: false, capturing: false, speaking: true, decisionPending: true, blocked: false, ownerCritical: false,
    transient: null, statusUnknown: false, briefingPending: false, activity: 'building', unrelatedBlocked: false }).pose === 'talking',
  'speaking -> talking outranks the card pose')
}


// ------------------------------------------- 9. redesign test round 1 fixes
{
  console.log('Round 1: HudAsk decision cards, stale action rows, exit request, tap-then-swipe')
  const fakeBridge = (textDelay = 0) => {
    const log = []
    const impl = {
      createStartUpPageContainer: async (p) => { log.push(['create', p]); return 0 },
      rebuildPageContainer: async (p) => { log.push(['rebuild', p]); return true },
      textContainerUpgrade: async (p) => { if (textDelay) await new Promise((r) => setTimeout(r, textDelay)); log.push(['text', p]); return true },
      updateImageRawData: async (p) => { log.push(['image', p]); return 'success' },
    }
    return { log, impl, gateway: { call: (op) => op(impl) } }
  }
  const drain = async () => { for (let i = 0; i < 4; i++) await tick() }
  // (gate-not-hudask-layout) A gate is the HudAsk board, not a Run card.
  const f = fakeBridge()
  const r = new Renderer(f.gateway)
  r.setReduceMotion(true)
  const gate = scene({ kind: 'decision', spritePose: 'asking', contextLabel: COPY.hud.spriiteAsks, contextDetail: 'CHECKOUT FLOW',
    utterance: COPY.real.startDecision, status: '0% verified · 1 choice needed', progress: RUN_PROGRESS, actions: COPY.real.gateActions })
  await r.present({ type: 'scene', scene: gate }, 0)
  await drain()
  const page = f.log.find((l) => l[0] === 'create')[1]
  const t = (id) => page.textObject.find((o) => o.containerID === id)
  assert(t(CT.say.id).content === COPY.real.startDecision && t(CT.say.id).yPosition === G.ask.questionY, 'the gate question sits at the HudAsk question slot (y 54)')
  assert(t(CT.list.id).content.trim() === 'Start build' && t(CT.list.id).yPosition === G.ask.optionY && t(CT.list.id).borderWidth === 1,
    'the focused option is the bordered row at y 132')
  assert(t(CT.rest.id).content === 'Talk' && t(CT.note.id).content === COPY.hud.askFooter, 'the other option and the HudAsk footer follow')
  assert(!page.textObject.some((o) => o.containerID === CT.status.id) && !(page.imageObject ?? []).some((o) => o.containerID === CT.bar.id),
    'no status line and no bar on the question page')
  const n0 = f.log.length
  await r.updateActions(gate, 1)
  assert(f.log.slice(n0).some((l) => l[0] === 'text' && l[1].containerID === CT.list.id && l[1].content.trim() === 'Talk'),
    'a ring tick turns the gate options in place')
  // (stale-action-row-after-burst) A write still in flight is not mistaken
  // for what the host holds: the newer row is always sent after it.
  const g = fakeBridge(5)
  const r2 = new Renderer(g.gateway)
  r2.setReduceMotion(true)
  const runA = scene({ kind: 'running', actions: COPY.real.runningActions, progress: RUN_PROGRESS })
  await r2.present({ type: 'scene', scene: runA }, 0)
  await new Promise((res) => setTimeout(res, 40))
  const stale = r2.updateActions(runA, 1) // 'Message' in flight
  const fresh = r2.updateActions(runA, 0) // back to 'Pause' (what the host held before)
  await Promise.all([stale, fresh])
  const boxes = g.log.filter((l) => l[0] === 'text' && l[1].containerID === CT.actions.id).map((l) => l[1].content.trim())
  assert(boxes.at(-1) === 'Pause', 'the last action-box write is the live focus, not a superseded one')
  // (root-shutdown-keeps-pumping) After the exit request nothing is sent until a present.
  const h = fakeBridge()
  const r3 = new Renderer(h.gateway)
  await r3.present({ type: 'scene', scene: runA }, 0)
  await drain()
  r3.markPageGone()
  const before = h.log.length
  await new Promise((res) => setTimeout(res, 1300))
  assert(h.log.slice(before).every((l) => l[0] !== 'image'), 'no sprite frames are sent into a page the host took down')
  await r3.present({ type: 'scene', scene: runA }, 0)
  await drain()
  assert(h.log.slice(before).some((l) => l[0] === 'rebuild'), 'the next present re-sends the whole page')
  r3.stop()
  // (tap-then-swipe-selects-wrong-item) The tap confirms before the swipe moves focus.
  const events = []
  const norm = new InputNormalizer((e) => events.push(e.type), { doubleTapWindowMs: 350, dedupeMs: 60 })
  norm.handle({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT, eventSource: 1 } })
  norm.handle({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
  assert(events.join(',') === 'select,next', 'a swipe inside the tap window confirms the tap first, then moves focus')
  norm.handle({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT, eventSource: 1 } })
  await new Promise((res) => setTimeout(res, 70))
  norm.handle({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT, eventSource: 1 } })
  assert(events.join(',') === 'select,next,back', 'a double tap is still Back, never a select')
  norm.dispose()
  // (status-separator-pipe) The boards' middle dot everywhere the HUD composes a line.
  const lines = [COPY.real.offlineStatus, COPY.real.errorStatus, COPY.real.transcriptStatus(10), COPY.micError.status, COPY.real.planDetailTitle(2), COPY.real.evidenceTitle]
  assert(lines.every((l) => !l.includes('|') && l.includes(' · ')), 'status lines and list titles use " · ", never " | "')
  assert(COPY.real.projectsTitle === 'Builds', 'the glasses builds list is called Builds')
}

console.log(failures === 0 ? '\nAll HUD redesign tests passed.' : `\n${failures} HUD redesign test(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
