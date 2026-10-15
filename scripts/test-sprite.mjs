/**
 * Sprite tests: the Spriite character of the redesign
 * (docs/design/redesign/Sprite.dc.html and MotionLab.dc.html are the source
 * of truth).
 *
 * Covers exactness (the board's own POSES/drawFrame source is evaluated in
 * node:vm and every frame of all twelve poses is compared cell for cell with
 * src/sprite/draw.ts), the MotionLab names, moments, frame counts and holds,
 * glasses timing (every frame at least 1000 ms), legacy pose names, the
 * committed snapshot fixture, the pure pose resolver and its priority order,
 * reduce motion, the phone DOM sprite under the Node DOM shim, and the
 * transport rules: one transfer in flight, newest pending frame retained, no
 * frame history, no stale generation enqueueing after cancellation, and
 * nothing sent while no display surface is attached.
 *
 * Also covers the HUD contract modules the sprite travels with: the scene
 * validator's budgets, composed status text, progress-bar pixels, the
 * selection row window, the actions line, the input normalizer's gesture
 * rules (G10-G13), and the page lifecycle of the renderer itself over a fake
 * bridge (create-once, in-place diffs, sticky invalidation, and failed
 * transfers that never wedge the dedupe).
 *
 * Usage: npm run test:sprite
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import {
  OsEventTypeList,
  validateEvenHubPageContainer,
} from '@evenrealities/even_hub_sdk'
import { measureTextWrap } from '@evenrealities/pretext'
import {
  ANIMS,
  FRAME_NAMES,
  GRID,
  POSE_NAMES,
  SIZE,
  framePixels,
} from '../src/sprite/frames.ts'
import { GLASSES_MIN_HOLD_MS, POSES, drawFrame, holdMs, shade } from '../src/sprite/draw.ts'
import {
  LEGACY_POSE_MAP,
  LEGACY_POSE_NAMES,
  POSE_META,
  SCENE_POSE_NAMES,
  toPose,
} from '../src/sprite/poses.ts'
import { createSpriteView } from '../src/sprite/dom.ts'
import { SpriteAnimator } from '../src/sprite/animator.ts'
import { activityPoseFor, resolvePose, statusUnknownFor } from '../src/sprite/resolve.ts'
import { makeElement } from './lib/phone-dom.mjs'
import { InputNormalizer } from '../src/input/normalize.ts'
import { Renderer, buildActionsText } from '../src/render/renderer.ts'
import {
  BAR_H,
  BAR_W,
  progressPixels,
  progressSignature,
} from '../src/render/progress.ts'
import {
  SELECTION_ROW_W,
  SELECTION_VISIBLE_ROWS,
  buildSelectionRowsText,
  conversationLayout,
  optionRows,
  historyLayout,
  listeningLayout,
  selectionLayout,
} from '../src/render/layout.ts'
import { composeStatus, pendingPercent, verifiedPercent } from '../src/scenes/compose.ts'
import { validateScene } from '../src/scenes/validate.ts'

let failures = 0
function assert(ok, label) {
  if (ok) console.log('  PASS:', label)
  else {
    failures++
    console.log('  FAIL:', label)
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const FIXTURES = JSON.parse(readFileSync(resolve(HERE, 'fixtures/sprite-poses.json'), 'utf8'))
const hashPixels = (px) => createHash('sha256').update(px.join(',')).digest('hex').slice(0, 16)
const tick = (ms = 6) => new Promise((r) => setTimeout(r, ms))

/** A controllable transport: records sends and resolves them on demand. */
function fakeTransport() {
  const sent = []
  const resolvers = []
  let inFlight = 0
  let maxInFlight = 0
  const show = (frame, lift) => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    sent.push(`${frame}@${lift}`)
    return new Promise((res) => resolvers.push(() => { inFlight -= 1; res() }))
  }
  return {
    show,
    sent,
    get maxInFlight() { return maxInFlight },
    release() {
      const r = resolvers.shift()
      if (r) r()
    },
    releaseAll() {
      while (resolvers.length > 0) resolvers.shift()()
    },
  }
}

/** The data-dc-script source of a board (the part before its Component class). */
function boardScript(file) {
  const html = readFileSync(resolve(ROOT, 'docs/design/redesign', file), 'utf8')
  const open = html.indexOf('data-dc-script')
  const start = html.indexOf('>', open) + 1
  const end = html.indexOf('class Component', start)
  if (open < 0 || end < 0) throw new Error(`${file}: no dc script`)
  return { html, src: html.slice(start, end) }
}

console.log('== Sprite tests (Sprite.dc.html, MotionLab.dc.html) ==')

const SPRITE_BOARD = boardScript('Sprite.dc.html')
const BOARD = vm.runInNewContext(`${SPRITE_BOARD.src}\n;({ POSES, drawFrame, shade })`, { Math })
const MOTION = vm.runInNewContext(`${boardScript('MotionLab.dc.html').src}\n;({ META })`, {})
const BOARD_OPTIONS = (() => {
  const m = SPRITE_BOARD.html.match(/data-props='([^']*)'/)
  return JSON.parse(m[1]).pose.options
})()

// ------------------------------------------------------------ 1. vocabulary
{
  assert(
    POSE_NAMES.length === 12 &&
      BOARD_OPTIONS.length === 12 &&
      POSE_NAMES.every((p, i) => BOARD_OPTIONS[i] === p && MOTION.META[i].id === p) &&
      Object.keys(BOARD.POSES).every((p, i) => POSE_NAMES[i] === p),
    'the pose vocabulary is the boards’ twelve poses, in order (Sprite pose options, POSES table, MotionLab META)',
  )
  assert(
    FRAME_NAMES.length === POSE_NAMES.reduce((n, p) => n + BOARD.POSES[p].length, 0) &&
      POSE_NAMES.every((p) => BOARD.POSES[p].every((_, i) => FRAME_NAMES.includes(`${p}.${i}`))),
    'every pose frame has one frame name, form pose.index',
  )
}

// --------------------------------------------- 2. exactness against the board
{
  let tableOk = true
  let bad = ''
  for (const pose of POSE_NAMES) {
    const ours = POSES[pose]
    const theirs = BOARD.POSES[pose]
    if (ours.length !== theirs.length) { tableOk = false; bad = `${pose}: ${ours.length} vs ${theirs.length} frames`; continue }
    theirs.forEach((f, i) => {
      if (JSON.stringify(ours[i]) !== JSON.stringify(f)) { tableOk = false; bad = `${pose}.${i}` }
    })
  }
  assert(tableOk, `the POSES table is the board’s, field for field${tableOk ? '' : ` (${bad})`}`)

  let cellsOk = true
  let frames = 0
  for (const pose of POSE_NAMES) {
    BOARD.POSES[pose].forEach((f, i) => {
      frames += 1
      const want = BOARD.drawFrame(f)
      const got = drawFrame(POSES[pose][i])
      if (got.length !== 1024 || want.length !== 1024) { cellsOk = false; bad = `${pose}.${i}: length`; return }
      for (let k = 0; k < 1024; k++) {
        if (got[k] !== want[k]) { cellsOk = false; bad = `${pose}.${i} cell ${k % 32},${Math.floor(k / 32)}: ${got[k]} vs ${want[k]}`; return }
      }
    })
  }
  assert(
    cellsOk && frames === FRAME_NAMES.length,
    `drawFrame is cell-for-cell identical to Sprite.dc.html for all ${frames} frames of the twelve poses${cellsOk ? '' : ` (${bad})`}`,
  )
  // The board's own frames from its own table, too (guards a table typo on both sides).
  let crossOk = true
  for (const pose of POSE_NAMES) {
    BOARD.POSES[pose].forEach((f, i) => {
      if (drawFrame(f).join(',') !== BOARD.drawFrame(f).join(',')) { crossOk = false; bad = `${pose}.${i}` }
    })
  }
  assert(crossOk, 'our drawFrame on the board’s own frame objects matches the board’s drawFrame')

  let rangeOk = true
  for (const pose of POSE_NAMES) for (const f of POSES[pose]) {
    if (!drawFrame(f).every((v) => Number.isInteger(v) && v >= -1 && v <= 15)) rangeOk = false
  }
  assert(rangeOk, 'every cell is -1 (transparent) or a level 0-15')

  let shadeOk = shade(0) === '#000000'
  for (let v = 1; v <= 15; v++) if (shade(v) !== BOARD.shade(v)) shadeOk = false
  assert(shadeOk && shade(15) === 'hsl(134, 92%, 69.0%)', 'shade(): level 0 is black ink, 1-15 the board’s green ramp')

  // framePixels doubles each grid cell into the 64x64 container, transparent -> 0.
  let doubleOk = SIZE === 64 && GRID === 32
  for (const name of FRAME_NAMES) {
    const [pose, idx] = name.split('.')
    const g = drawFrame(POSES[pose][Number(idx)])
    const px = framePixels(name)
    if (px.length !== SIZE * SIZE) { doubleOk = false; break }
    for (let y = 0; y < SIZE && doubleOk; y++) for (let x = 0; x < SIZE; x++) {
      const v = g[(y >> 1) * GRID + (x >> 1)]
      if (px[y * SIZE + x] !== (v < 0 ? 0 : v)) { doubleOk = false; bad = name; break }
    }
  }
  assert(doubleOk, 'framePixels doubles every cell into 64x64 and maps transparent to 0 (off)')
  let threw = false
  try { framePixels('moonwalk.0') } catch { threw = true }
  assert(threw, 'an unknown frame name is refused, never drawn as something else')
}

// --------------------------------------------- 3. MotionLab names and timing
{
  let metaOk = true
  let bad = ''
  for (const m of MOTION.META) {
    const meta = POSE_META[m.id]
    if (!meta || meta.name !== m.name || meta.when !== m.when || meta.frames !== m.d.length) { metaOk = false; bad = m.id }
    if (POSES[m.id].map((f) => f.d).join(',') !== m.d.join(',')) { metaOk = false; bad = `${m.id} d` }
  }
  assert(metaOk, `pose names, moments and frame counts are MotionLab’s verbatim${metaOk ? '' : ` (${bad})`}`)
  const COUNTS = { idle: 4, listening: 3, talking: 3, thinking: 3, building: 3, delegating: 3, checking: 2, asking: 2, celebrate: 4, blocked: 2, paused: 1, offline: 2 }
  assert(
    POSE_NAMES.every((p) => ANIMS[p].steps.length === COUNTS[p]),
    'frame counts: idle 4, listening 3, talking 3, thinking 3, building 3, delegating 3, checking 2, asking 2, celebrate 4, blocked 2, paused 1, offline 2',
  )
  assert(POSE_META.thinking.name === 'Planning' && POSE_META.celebrate.name === 'Celebrating', 'thinking is named Planning and celebrate Celebrating')

  assert(GLASSES_MIN_HOLD_MS === 1000, 'the glasses minimum hold is 1000 ms')
  let holdsOk = true
  for (const pose of POSE_NAMES) {
    ANIMS[pose].steps.forEach((s, i) => {
      const d = MOTION.META.find((m) => m.id === pose).d[i]
      if (s.holdMs !== Math.max(d, 1000) || s.holdMs < 1000) { holdsOk = false; bad = `${pose}.${i}` }
      if (holdMs(POSES[pose][i], 'preview') !== d || holdMs(POSES[pose][i], 'glasses') !== s.holdMs) { holdsOk = false; bad = `${pose}.${i} holdMs()` }
    })
  }
  assert(holdsOk, `every glasses frame holds max(d, 1000) ms, so each shows for at least 1000 ms${holdsOk ? '' : ` (${bad})`}`)

  assert(
    POSE_NAMES.every((p) => ANIMS[p].loop),
    'every pose loops, celebrate included (Sprite.dc.html schedule() wraps every pose)',
  )
  assert(
    POSE_NAMES.every((p) => ANIMS[p].key === `${p}.0`),
    'the key frame is frame 0 for every pose (the board resets to frame 0)',
  )
}

// --------------------------------------------- 4. legacy names normalize
{
  const EXPECT = {
    waiting: 'building', planning: 'thinking', researching: 'thinking', repair: 'blocked', accepted: 'celebrate',
    disconnected: 'offline', switching: 'idle', receiving: 'talking', reconciling: 'checking', briefing: 'talking',
  }
  assert(
    LEGACY_POSE_NAMES.length === 10 && LEGACY_POSE_NAMES.every((p) => LEGACY_POSE_MAP[p] === EXPECT[p] && toPose(p) === EXPECT[p]),
    'legacy pose names map onto the twelve by their MotionLab moments',
  )
  assert(POSE_NAMES.every((p) => toPose(p) === p), 'a drawn pose normalizes to itself')
  assert(toPose('moonwalk') === 'idle' && toPose('') === 'idle' && toPose('toString') === 'idle', 'an unknown name normalizes to idle')
  assert(
    SCENE_POSE_NAMES.length === 22 && [...POSE_NAMES, ...LEGACY_POSE_NAMES].every((p) => SCENE_POSE_NAMES.includes(p)),
    'scene pose names are the twelve plus the legacy tags',
  )
}

// ------------------------------------------------- 5. snapshot fixtures match
{
  const current = {}
  for (const pose of POSE_NAMES) {
    const anim = ANIMS[pose]
    current[pose] = {
      name: POSE_META[pose].name,
      key: anim.key,
      loop: anim.loop,
      steps: anim.steps.map((s, i) => ({ frame: s.frame, d: POSES[pose][i].d, holdMs: s.holdMs })),
      staticPixels: hashPixels(framePixels(anim.key)),
      framePixels: anim.steps.map((s) => hashPixels(framePixels(s.frame))),
    }
  }
  assert(
    JSON.stringify(current) === JSON.stringify(FIXTURES),
    'every pose matches its committed snapshot fixture (regenerate with node scripts/sprite-fixtures.mjs)',
  )
  assert(Object.keys(FIXTURES).length === 12, 'the fixture file covers all twelve poses')
  const keys = POSE_NAMES.map((p) => hashPixels(framePixels(ANIMS[p].key)))
  assert(new Set(keys).size === 12, 'each of the twelve poses draws a distinct still frame')
}

// --------------------------------- 6. static fallback + reduce motion, per pose
{
  let staticOk = true
  let bad = ''
  for (const pose of POSE_NAMES) {
    const t = fakeTransport()
    const anim = new SpriteAnimator(t.show)
    // Configure while detached, then attach: exactly one frame is queued, and
    // it is the key frame the static pose is defined as.
    anim.setSurfaceAttached(false)
    anim.setStatic(true)
    anim.setPose(pose)
    anim.setSurfaceAttached(true)
    await tick()
    const expected = `${ANIMS[pose].key}@0`
    if (t.sent.length !== 1 || t.sent[0] !== expected) {
      staticOk = false
      bad = `${pose}: [${t.sent.join(' ')}] != ${expected}`
    }
    t.releaseAll()
    await tick()
    if (t.sent.length !== 1) { staticOk = false; bad = `${pose}: ${t.sent.length} frames in static mode` }
    anim.stop()
  }
  assert(staticOk, `static mode pins every pose to its key frame, once${staticOk ? '' : ` (${bad})`}`)

  let reduceOk = true
  for (const pose of POSE_NAMES) {
    const t = fakeTransport()
    const anim = new SpriteAnimator(t.show)
    anim.setSurfaceAttached(false)
    anim.setReduceMotion(true)
    anim.setPose(pose)
    anim.setSurfaceAttached(true)
    await tick()
    if (t.sent.length !== 1 || t.sent[0] !== `${ANIMS[pose].key}@0`) { reduceOk = false; bad = pose }
    t.releaseAll()
    await tick()
    anim.stop()
  }
  assert(reduceOk, `reduce motion keeps each pose’s key frame and drops the frame alternation${reduceOk ? '' : ` (${bad})`}`)

  // Reduce motion is not a pose change: the semantic pose still follows state.
  const t = fakeTransport()
  const anim = new SpriteAnimator(t.show)
  anim.setReduceMotion(true)
  anim.setPose('thinking')
  anim.setPose('blocked')
  await tick()
  assert(anim.currentPose === 'blocked', 'reduce motion still tracks the semantic pose')
  assert(anim.isReduceMotion === true, 'the reduce-motion state is observable')
  anim.setPose('repair') // legacy name for the same drawn pose
  assert(anim.currentPose === 'blocked', 'the animator normalizes legacy scene names with toPose')
  t.releaseAll()
  await tick()
  anim.stop()
}

// ------------------------------------------------------- 7. transport rules
{
  // At most one transfer in flight, newest pending frame retained, no history.
  const t = fakeTransport()
  const anim = new SpriteAnimator(t.show)
  anim.setStatic(true) // idle.0@0 in flight
  await tick()
  assert(t.sent.length === 1, 'the first frame is handed to the transport')
  anim.setPose('thinking')
  anim.setPose('checking')
  anim.setPose('blocked')
  await tick()
  assert(t.sent.length === 1 && t.maxInFlight === 1, 'a frame arriving mid-transfer is held back, not queued behind it')
  t.releaseAll()
  await tick()
  assert(
    t.sent.length === 2 && t.sent[1] === `${ANIMS.blocked.key}@0`,
    'only the NEWEST pending frame is sent: the superseded ones are dropped, never replayed',
  )
  assert(t.maxInFlight === 1, 'exactly one sprite transfer was ever in flight')
  anim.stop()

  // Glasses timing: the second frame waits for the full 1000 ms hold.
  const tg = fakeTransport()
  const animG = new SpriteAnimator(tg.show)
  animG.setPose('talking') // board d 420 ms, glasses hold 1000 ms
  await tick()
  tg.releaseAll()
  await tick(600)
  tg.releaseAll()
  const early = tg.sent.length
  await tick(600)
  tg.releaseAll()
  await tick()
  assert(
    early === 1 && tg.sent[0] === 'talking.0@0' && tg.sent[1] === 'talking.1@0',
    'on the glasses a 420 ms board frame still holds 1000 ms before the next frame',
  )
  animG.stop()

  // A stale generation never enqueues after cancellation.
  const t2 = fakeTransport()
  const anim2 = new SpriteAnimator(t2.show)
  anim2.setPose('listening') // looping, 1000 ms holds
  await tick()
  const afterFirst = t2.sent.length
  t2.releaseAll()
  anim2.stop()
  await tick(1200)
  assert(
    t2.sent.length === afterFirst,
    'a cancelled generation enqueues nothing further, even after its deadline passes',
  )

  // Nothing is sent while no display surface is attached; reattaching repaints.
  const t3 = fakeTransport()
  const anim3 = new SpriteAnimator(t3.show)
  anim3.setSurfaceAttached(false)
  anim3.setPose('building')
  anim3.invalidate()
  await tick(700)
  assert(t3.sent.length === 0, 'no sprite frame is sent while no display surface is attached')
  anim3.setSurfaceAttached(true)
  await tick()
  assert(
    t3.sent[0] === `${ANIMS.building.steps[0].frame}@0`,
    'reattaching repaints the current pose from the start of its script',
  )
  t3.releaseAll()
  await tick()
  anim3.stop()
  assert(t3.maxInFlight === 1, 'the repaint still used a single transfer')
}

// ------------------------------------------------- 7b. no replay, no throw
{
  // A forced repaint of the celebration (a loop, like every pose on the
  // board) repaints from its key frame and keeps looping.
  const t = fakeTransport()
  const anim = new SpriteAnimator(t.show)
  anim.setPose('celebrate')
  await tick()
  assert(t.sent[0] === 'celebrate.0@0', 'a genuinely new celebration plays from its first frame')
  t.releaseAll()
  await tick()
  const before = t.sent.length
  anim.setPose('celebrate', { force: true })
  await tick()
  t.releaseAll()
  await tick(1100)
  t.releaseAll()
  await tick()
  const after = t.sent.slice(before)
  assert(
    after.length >= 1 && after[0] === `${ANIMS.celebrate.key}@0` && after.every((f) => f.startsWith('celebrate.')),
    'a forced repaint redraws the celebration from its key frame and keeps looping',
  )
  const n = t.sent.length
  anim.setPose('accepted') // the legacy name for the same pose is no new event
  await tick()
  assert(t.sent.length === n, 'a legacy name for the current pose is not a new event')
  anim.stop()

  // The celebration loops like every pose: after its fourth frame it wraps to the hop.
  const tc = fakeTransport()
  const animC = new SpriteAnimator(tc.show)
  animC.setPose('celebrate')
  for (let i = 0; i < 12; i++) { await tick(600); tc.releaseAll() }
  await tick()
  assert(
    tc.sent.slice(0, 5).join(' ') === 'celebrate.0@0 celebrate.1@0 celebrate.2@0 celebrate.3@0 celebrate.0@0',
    'celebrate plays its four frames and wraps to the first (Sprite.dc.html schedule())',
  )
  animC.stop()

  // Detach and reattach mid-celebration: the settled frame, not the hop again.
  const t2 = fakeTransport()
  const anim2 = new SpriteAnimator(t2.show)
  anim2.setPose('celebrate')
  await tick()
  t2.releaseAll()
  anim2.setSurfaceAttached(false)
  const mark = t2.sent.length
  anim2.setSurfaceAttached(true)
  await tick()
  t2.releaseAll()
  await tick()
  assert(
    t2.sent.length > mark && t2.sent[mark].startsWith(`${ANIMS.celebrate.key}@`),
    'reattaching repaints the looping celebration from its key frame',
  )
  anim2.stop()

  // A transport that rejects drops that frame and keeps the pump alive.
  const sent = []
  let calls = 0
  const flaky = async (frame, lift) => {
    calls += 1
    if (calls === 1) throw new Error('link hiccup')
    sent.push(`${frame}@${lift}`)
  }
  const origWarn = console.warn
  let warned = 0
  console.warn = () => { warned += 1 }
  let unhandled = 0
  const onUnhandled = () => { unhandled += 1 }
  process.on('unhandledRejection', onUnhandled)
  const anim4 = new SpriteAnimator(flaky)
  anim4.setReduceMotion(true) // idle key frame -> rejected
  anim4.setPose('paused')
  await tick(20)
  console.warn = origWarn
  process.off('unhandledRejection', onUnhandled)
  assert(unhandled === 0 && warned === 1, 'a rejected frame transfer is caught and logged, not an unhandled rejection')
  assert(sent.includes(`${ANIMS.paused.key}@0`), 'the pump keeps sending after a rejected transfer')
  anim4.stop()
}

// ---------------------------------------------------------- 8. the resolver
{
  const base = {
    linkDown: false,
    capturing: false,
    speaking: false,
    decisionPending: false,
    blocked: false,
    ownerCritical: false,
    transient: null,
    statusUnknown: false,
    briefingPending: false,
    activity: 'building',
    unrelatedBlocked: false,
  }
  const poseOf = (over) => resolvePose({ ...base, ...over }).pose

  assert(poseOf({}) === 'building', 'focused mission activity is the fallback meaning')
  assert(poseOf({ activity: null }) === 'idle', 'with nothing focused, the sprite is idle')
  assert(poseOf({ activity: 'waiting' }) === 'building' && poseOf({ activity: 'accepted' }) === 'celebrate', 'a legacy activity name normalizes onto the twelve')
  assert(poseOf({ briefingPending: true }) === 'talking', 'a return briefing on screen shows talking')
  assert(poseOf({ statusUnknown: true }) === 'checking', 'unknown displayed status shows checking')
  assert(poseOf({ transient: 'receiving' }) === 'talking', 'a live receipt shows talking (repeating back what it heard)')
  assert(poseOf({ transient: 'switching' }) === 'idle', 'an explicit focus change shows idle')
  assert(poseOf({ blocked: true }) === 'blocked', 'a blocking condition needing attention shows blocked')
  assert(poseOf({ decisionPending: true }) === 'asking', 'an actionable decision shows asking')
  assert(poseOf({ speaking: true }) === 'talking', 'a spoken reply playing shows talking')
  const { speaking: _omit, ...noSpeaking } = base
  assert(resolvePose(noSpeaking).pose === 'building', 'speaking is optional: omitted means not speaking')
  assert(poseOf({ capturing: true }) === 'listening', 'actual microphone capture shows listening')
  assert(poseOf({ linkDown: true }) === 'offline', 'an unavailable link shows offline')

  // The priority order itself, highest first: clear the winner at each step
  // and assert the next rule takes over.
  const all = {
    linkDown: true,
    capturing: true,
    speaking: true,
    decisionPending: true,
    blocked: true,
    ownerCritical: true,
    transient: 'switching',
    statusUnknown: true,
    briefingPending: true,
    activity: 'thinking',
    unrelatedBlocked: true,
  }
  const clear = ['linkDown', 'capturing', 'speaking', 'decisionPending', 'blocked']
  const step = (n, over = {}) => {
    const off = {}
    for (const k of clear.slice(0, n)) off[k] = false
    if (n >= 5) off.ownerCritical = false
    return resolvePose({ ...all, ...off, ...over }).pose
  }
  assert(step(0) === 'offline', 'link state outranks everything')
  assert(step(1) === 'listening', 'capture outranks speech, a decision, a block, and a transient')
  assert(step(2) === 'talking', 'a spoken reply outranks a decision')
  assert(step(3) === 'asking', 'a decision outranks a block')
  assert(step(4) === 'blocked', 'a block outranks an owner-critical issue, a transient, unknown status, and the briefing')
  assert(step(5, { ownerCritical: true }) === 'blocked', 'an owner-critical issue alone shows blocked')
  assert(step(5) === 'idle', 'a live focus change outranks unknown status and the briefing')
  assert(step(5, { transient: 'receiving' }) === 'talking', 'a live receipt outranks unknown status')
  assert(step(5, { transient: null }) === 'checking', 'unknown status outranks the briefing')
  assert(step(5, { transient: null, statusUnknown: false }) === 'talking', 'the briefing outranks focused activity')
  assert(step(5, { transient: null, statusUnknown: false, briefingPending: false }) === 'thinking', 'focused activity outranks idle')
  assert(
    step(5, { transient: null, statusUnknown: false, briefingPending: false, activity: null }) === 'idle',
    'with nothing focused and nothing pending, the sprite is idle',
  )

  // Scope: an unrelated blocker is a badge, never a hijack; a global issue may interrupt.
  const unrelated = resolvePose({ ...base, activity: 'building', unrelatedBlocked: true })
  assert(unrelated.pose === 'building' && unrelated.badge === true, 'an unrelated blocker becomes a badge, not a sprite hijack')
  const globalIssue = resolvePose({ ...base, activity: 'building', ownerCritical: true, unrelatedBlocked: true })
  assert(globalIssue.pose === 'blocked', 'an owner-critical global issue may interrupt the focused sprite')
  assert(resolvePose({ ...base, unrelatedBlocked: false }).badge === false, 'no badge when every blocker is in scope')
}

// --------------------------------------------- 9. activity mapping and freshness
{
  const activity = (phase, control = 'running') => activityPoseFor({ phase, control })
  const MAP = {
    received: 'talking', gathering_context: 'thinking', planning: 'thinking', ready: 'delegating',
    building: 'building', reviewing: 'checking', repairing: 'blocked', integrating: 'building',
    awaiting_decision: 'asking', completed: 'celebrate', failed: 'blocked', cancelled: 'idle',
  }
  for (const [phase, pose] of Object.entries(MAP)) {
    assert(activity(phase) === pose, `mission phase ${phase} shows ${pose} (${POSE_META[pose].name})`)
  }
  assert(activity('building', 'paused') === 'paused', 'control outranks phase: a paused mission is resting')
  assert(
    activity('reviewing', 'cancel_requested') === 'building',
    'a cancellation still in flight is still working, never reported as cancelled',
  )
  assert(activity('reviewing', 'pause_requested') === 'building', 'a pause request is not yet a paused mission')
  assert(
    Object.keys(MAP).every((phase) => POSE_NAMES.includes(activity(phase))),
    'every mission phase maps to one of the twelve poses',
  )
  assert(statusUnknownFor('unknown') && statusUnknownFor('reconciling'), 'unknown and reconciling both mean status is not known')
  assert(!statusUnknownFor('current') && !statusUnknownFor('stale'), 'current and stale are known states (stale is labeled, not unknown)')
}

// ----------------------------------------- 10. the phone DOM sprite (shim)
{
  const saved = { document: globalThis.document, matchMedia: globalThis.matchMedia }
  const restore = () => {
    if (saved.document === undefined) delete globalThis.document
    else globalThis.document = saved.document
    if (saved.matchMedia === undefined) delete globalThis.matchMedia
    else globalThis.matchMedia = saved.matchMedia
  }
  // The shim's canvas has no getContext: nothing is drawn, nothing throws.
  globalThis.document = { createElement: makeElement }
  let view = null
  let threw = false
  try {
    view = createSpriteView({ pose: 'building' })
    view.setPose('waiting')
    view.setPose('asking')
    view.setSpeed('glasses')
  } catch {
    threw = true
  }
  assert(!threw && view !== null, 'createSpriteView is safe under the Node DOM shim (no canvas context)')
  const el = view?.el
  assert(
    el?.tagName === 'DIV' && el.className === 'spr' && el.role === 'img' && el['aria-label'] === 'Spriite, asking' &&
      el.style.width === '128px' && el.style.height === '128px' && el.children[0]?.tagName === 'CANVAS' &&
      el.children[0].width === 128,
    'the view is div.spr role=img labelled "Spriite, <pose>", 32*px square (default px 4) holding a canvas',
  )
  view?.destroy()

  // With a 2D context: every non-transparent cell is one px-square rect in the board's colour.
  const draws = []
  const makeCanvasDoc = () => ({
    createElement: (tag) => {
      const e = makeElement(tag)
      if (tag === 'canvas') {
        const ctx = {
          fillStyle: '',
          clearRect() { draws.push({ rects: [] }) },
          fillRect(x, y, w, h) { draws.at(-1).rects.push([x, y, w, h, this.fillStyle]) },
        }
        e.getContext = () => ctx
      }
      return e
    },
  })
  globalThis.document = makeCanvasDoc()
  const pinned = createSpriteView({ pose: 'offline', px: 3, frame: 9 })
  const want = BOARD.drawFrame(BOARD.POSES.offline[1])
  const rects = draws.at(-1)?.rects ?? []
  const expected = []
  for (let k = 0; k < 1024; k++) {
    if (want[k] < 0) continue
    expected.push([(k % 32) * 3, Math.floor(k / 32) * 3, 3, 3, want[k] === 0 ? '#000000' : BOARD.shade(want[k])])
  }
  assert(
    draws.length === 1 && JSON.stringify(rects) === JSON.stringify(expected),
    'the canvas is drawn cell by cell with the board’s colours (a pinned frame clamps to the last frame)',
  )
  pinned.destroy()

  // Preview speed follows d; glasses speed holds at least 1000 ms.
  draws.length = 0
  const fast = createSpriteView({ pose: 'talking' })
  const slow = createSpriteView({ pose: 'talking', speed: 'glasses' })
  await tick(600)
  const fastDraws = draws.length
  fast.destroy()
  slow.destroy()
  assert(fastDraws === 3, 'preview speed advances on the board’s d; glasses speed waits its 1000 ms hold')

  // celebrate loops (380/380/380/700 ms, then frame 0 again), as the board's renderer does.
  draws.length = 0
  const party = createSpriteView({ pose: 'celebrate' })
  await tick(1400)
  const firstPass = draws.length
  await tick(500)
  assert(firstPass === 4 && draws.length > 4, 'the phone celebration plays its four frames and keeps looping')
  party.destroy()

  // prefers-reduced-motion pins the key frame with no timer.
  globalThis.matchMedia = (q) => ({ matches: q.includes('reduce') })
  draws.length = 0
  const still = createSpriteView({ pose: 'talking' })
  await tick(500)
  assert(draws.length === 1, 'prefers-reduced-motion pins the key frame: no animation timers')
  still.destroy()
  restore()
}

// ------------------------------------------------- 7. scene validation budgets
{
  const SC = (over = {}) => ({
    schemaVersion: 1,
    sceneId: 's1',
    sceneRevision: 1,
    missionId: null,
    stateSequence: 1,
    kind: 'running',
    spritePose: 'idle',
    contextLabel: 'SPRIITE',
    utterance: 'Hi.',
    status: 'On it',
    progress: null,
    actions: [],
    evidenceIds: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
    transientMs: 0,
    ...over,
  })
  const issuesOf = (s, origin = 'engine') => validateScene(s, origin).map((i) => i.field)

  assert(issuesOf(SC()).length === 0, 'a well-formed scene passes validation')
  assert(issuesOf(SC(), 'local').length === 0, 'the same scene passes as a local card')
  assert(issuesOf(SC({ kind: 'transcribing' })).includes('kind'), 'the engine may not assert capture state: local kinds are observed, never engine-emitted')
  assert(issuesOf(SC({ schemaVersion: 2 })).includes('schemaVersion'), 'the scene schema version is pinned')
  assert(issuesOf(SC({ kind: 'nonsense' })).includes('kind'), 'an unknown kind is rejected before anything else is interpreted')
  assert(issuesOf(SC({ spritePose: 'moonwalk' })).includes('spritePose'), 'an unknown pose is rejected: a model cannot invent poses')
  assert(issuesOf(SC({ stateSequence: 0 })).includes('stateSequence'), 'stateSequence must be >= 1')
  assert(issuesOf(SC({ sceneRevision: 0 })).includes('sceneRevision'), 'sceneRevision must be >= 1')
  assert(issuesOf(SC({ contextLabel: 'A\nB' })).includes('contextLabel'), 'the context line is one line')
  assert(issuesOf(SC({ status: 'one\ntwo' })).includes('status'), 'the status line is one line')
  assert(issuesOf(SC({ utterance: 'It is 50% done' })).includes('utterance'), 'percentages belong in the composed status, never the utterance')
  assert(issuesOf(SC({ transientMs: 1000 })).includes('transientMs'), 'a transient window under 1.5s is rejected')
  assert(issuesOf(SC({ transientMs: 2000 })).length === 0, 'a 2s transient card is valid')

  // Blank lines are rendered lines. Summing per-part used to drop empty parts,
  // so a '\n\n' undercounted and an over-budget card reached the HUD clipped.
  assert(issuesOf(SC({ utterance: 'Alpha\nBeta\nGamma\nDelta' })).length === 0, 'four real lines use the whole utterance budget')
  assert(
    issuesOf(SC({ utterance: 'Alpha\n\nBeta\n\nGamma\n\nDelta' })).includes('utterance'),
    'blank lines count as rendered lines: an over-budget card is rejected, not clipped',
  )

  const act = (id, label) => ({ id, label, kind: 'command' })
  assert(issuesOf(SC({ actions: [act('a', 'Ok'), act('b', 'Fine'), act('c', 'Sure')] })).length === 0, 'three actions are allowed')
  assert(issuesOf(SC({ actions: [act('a', 'Ok'), act('b', 'Fine'), act('c', 'Sure'), act('d', 'Go')] })).includes('actions'), 'a fourth action is rejected')
  assert(issuesOf(SC({ actions: [act('a', 'Ok'), act('a', 'Fine')] })).includes('actions'), 'duplicate action ids are rejected')
  assert(issuesOf(SC({ actions: [act('', 'Ok')] })).includes('actions'), 'an empty action id is rejected')
  assert(issuesOf(SC({ actions: [act('a', 'This label is far too long')] })).includes('actions'), 'an over-long action label is rejected')

  const prog = (o) => ({ acceptedWeight: 20, pendingReviewWeight: 30, totalWeight: 100, planRevision: 1, ...o })
  assert(issuesOf(SC({ kind: 'accepted', progress: prog(), evidenceIds: ['pr_1'] })).length === 0, 'an accepted card with evidence is valid')
  assert(issuesOf(SC({ kind: 'accepted', progress: null, evidenceIds: ['pr_1'] })).includes('progress'), 'a review-claim card requires progress')
  assert(issuesOf(SC({ kind: 'accepted', progress: prog(), evidenceIds: [] })).includes('evidenceIds'), 'a review-claim card requires evidence')
  assert(issuesOf(SC({ progress: prog({ totalWeight: 0 }) })).includes('progress.totalWeight'), 'a zero plan weight is rejected')
  assert(issuesOf(SC({ progress: prog({ acceptedWeight: -1 }) })).includes('progress'), 'negative weights are rejected')
  assert(issuesOf(SC({ progress: prog({ acceptedWeight: 80, pendingReviewWeight: 30 }) })).includes('progress'), 'accepted plus pending must not exceed the plan')
  assert(issuesOf(SC({ progress: prog({ planRevision: 0 }) })).includes('progress.planRevision'), 'plan revisions start at 1')
}

// ------------------------------------------------------- 8. composed status
{
  const p = { acceptedWeight: 20, pendingReviewWeight: 30, totalWeight: 100, planRevision: 1 }
  assert(verifiedPercent(p) === 20 && pendingPercent(p) === 30, 'percentages derive from the progress object only')
  assert(verifiedPercent({ ...p, acceptedWeight: 25 }) === 25, 'the verified share tracks the accepted weight')
  assert(composeStatus(p) === '20% verified · 30% in review', 'a review in flight joins the verified share')
  assert(composeStatus({ ...p, pendingReviewWeight: 0 }) === '20% verified', 'no in-review share when nothing is pending')
  assert(composeStatus({ ...p, pendingReviewWeight: 0 }, '1 choice needed') === '20% verified · 1 choice needed', 'a note follows the numbers')
  assert(composeStatus(null, 'Waiting for glasses') === 'Waiting for glasses', 'without progress the note stands alone')
  // A zero-weight plan (no milestones landed yet) divides by zero: the HUD
  // shows an honest 0, never "NaN% verified" — the same guard the phone's
  // mirror applies (src/phone/app.ts).
  const empty = { acceptedWeight: 0, pendingReviewWeight: 0, totalWeight: 0, planRevision: 1 }
  assert(verifiedPercent(empty) === 0 && pendingPercent(empty) === 0, 'a zero-weight plan reads 0 percent, never NaN')
  assert(
    composeStatus(empty) === '0% verified' && !composeStatus(empty).includes('NaN'),
    'a zero-weight plan renders "0% verified", never "NaN% verified"',
  )
}

// ------------------------------------------------------ 9. progress bar pixels
{
  const P = (o = {}) =>
    progressPixels({ acceptedWeight: 0, pendingReviewWeight: 0, totalWeight: 100, planRevision: 1, ...o })
  const px = (img, x, y) => img[y * BAR_W + x]

  assert(P().length === BAR_W * BAR_H, 'the bar is exactly the 256x20 container it is drawn into')
  const half = P({ acceptedWeight: 50 })
  assert(px(half, 0, 0) === 15 && px(half, 127, 19) === 15, 'accepted work is solid across the full bar height')
  assert(px(half, 128, 0) === 0 && px(half, 255, 0) === 0, 'no solid pixels beyond the accepted share')
  assert(px(half, 200, 19) === 3 && px(half, 200, 18) === 3, 'remaining scope keeps a dim two-row baseline')
  assert(px(half, 200, 0) === 0, 'the remainder stays empty above the baseline')

  const dotted = P({ acceptedWeight: 50, pendingReviewWeight: 25 })
  assert(px(dotted, 150, 6) === 8 && px(dotted, 150, 13) === 8, 'pending work reads as a distinct half-height dotted band')
  assert(px(dotted, 151, 6) === 0 && px(dotted, 150, 5) === 0 && px(dotted, 150, 14) === 0, 'the pending band alternates columns and stays inside its half height')
  assert(px(dotted, 100, 6) === 15, 'the accepted share outranks the pending band it precedes')

  const over = P({ acceptedWeight: 150, pendingReviewWeight: 90 })
  assert(over.every((v) => v === 15), 'out-of-range weights clamp to a full bar, never index past it')
  const neg = P({ acceptedWeight: -5 })
  assert(px(neg, 0, 0) === 0 && px(neg, 0, 19) === 3, 'a negative accepted weight clamps to zero, not a mirrored bar')

  const sig = { acceptedWeight: 1, pendingReviewWeight: 2, totalWeight: 3, planRevision: 4 }
  assert(progressSignature(sig) === '1/2/3/4', 'the bar signature covers both weights, the plan, and the revision')
  assert(
    progressSignature({ ...sig, planRevision: 5 }) !== progressSignature(sig),
    'a new plan revision re-sends the bar even when the weights are identical',
  )
}

// --------------------------------------------------- 10. selection row window
{
  const rows = (items, focus) => buildSelectionRowsText(items, focus).split('\n')
  const items10 = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']

  let ok = true
  let bad = ''
  for (let f = 0; f < items10.length; f++) {
    const w = rows(items10, f)
    if (w.length > SELECTION_VISIBLE_ROWS) { ok = false; bad = `focus ${f}: ${w.length} rows on screen` }
    if (!w.some((r) => r === `> ${items10[f]}`)) { ok = false; bad = `focus ${f}: cursor off screen` }
  }
  assert(ok, `the window never shows more than ${SELECTION_VISIBLE_ROWS} rows and never loses the cursor${ok ? '' : ` (${bad})`}`)
  assert(rows(items10, 0)[0] === '> a' && rows(items10, 0).length === SELECTION_VISIBLE_ROWS, 'the window opens at the top row')
  assert(rows(items10, 9)[rows(items10, 9).length - 1] === '> j', 'the window ends on the last row')
  assert(rows(items10, 5)[2] === '> f', 'while the list allows it the cursor rides its middle line, so the window slides smoothly')
  assert(rows(['x', 'y'], -3)[0] === '> x', 'a negative focus index clamps to the first row')
  assert(rows(['x', 'y'], 99)[rows(['x', 'y'], 99).length - 1] === '> y', 'an oversized focus index clamps to the last row')
  assert(buildSelectionRowsText([], 0) === '', 'an empty selection draws no rows')

  // One rendered line per row, guaranteed: an over-wide item is clipped, not
  // wrapped — a wrapped row would push the window past its 164px container.
  const wide = `https://example.com/${'a'.repeat(200)}`
  const w = rows([wide, 'short row'], 0)
  assert(measureTextWrap(w[0], SELECTION_ROW_W).lineCount === 1, 'an over-wide row is clipped to one line so the window cannot spill')
  assert(w[0].startsWith('> ') && w[0].endsWith('...'), 'the clipped row keeps the cursor and says it was cut')
  assert(measureTextWrap(rows([wide, 'short row'], 1)[1], SELECTION_ROW_W).lineCount === 1, 'unfocused rows are clipped to one line too')
}

// ------------------------------------------------------- 11. the actions line
{
  const act = (id, label) => ({ id, label, kind: 'command' })
  assert(buildActionsText([], 0) === '', 'a card without actions draws no action line')
  const t = buildActionsText([act('a', 'Talk'), act('b', 'Pause'), act('c', 'Status')], 1)
  assert(t === 'Talk   > Pause   Status', 'exactly one action is focused, separated by a wide gap')
  const wide = 'W'.repeat(18)
  assert(
    buildActionsText([act('a', wide), act('b', wide), act('c', wide)], 2) === `> ${wide}`,
    'when the joined line would overflow 528px, only the focused action is shown',
  )
  assert(
    buildActionsText([act('a', 'Talk')], 5) === '> Talk',
    'a stale focus index clamps instead of throwing or losing the cursor',
  )
  assert(
    buildActionsText([act('a', 'Talk'), act('b', 'Pause')], 7) === 'Talk   > Pause',
    'the clamp keeps the drawn cursor and the picked row the same row',
  )
}

// -------------------------------------------------- 12. input gesture rules
{
  const mk = () => {
    const ev = []
    return { ev, n: new InputNormalizer((e) => ev.push(e), { doubleTapWindowMs: 12, dedupeMs: 5 }) }
  }
  const click = (src = 2) => ({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT, eventSource: src } })
  const dbl = () => ({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT, eventSource: 2 } })
  const sys = (t) => ({ sysEvent: { eventType: t, eventSource: 2 } })
  const scroll = (t) => ({ textEvent: { eventType: t } })

  // G12: a double tap never first approves the focused action.
  {
    const { ev, n } = mk()
    n.handle(click())
    await tick(25)
    assert(ev.filter((e) => e.type === 'select').length === 1, 'a single tap arms and fires exactly one select once the double-tap window closes')
  }
  {
    const { ev, n } = mk()
    n.handle(click())
    n.handle(dbl())
    await tick(25)
    assert(ev.filter((e) => e.type === 'select').length === 0 && ev.filter((e) => e.type === 'back').length === 1, 'a double tap cancels the armed select and goes back instead of approving')
  }
  // G13: duplicate envelope re-deliveries are dropped.
  {
    const { ev, n } = mk()
    n.handle(dbl())
    n.handle(dbl())
    await tick(25)
    assert(ev.filter((e) => e.type === 'back').length === 1, 'a re-delivered double tap is one back, not two')
  }
  // Scroll is continuous input: real ticks pass, re-deliveries do not.
  {
    const { ev, n } = mk()
    n.handle(scroll(OsEventTypeList.SCROLL_BOTTOM_EVENT))
    n.handle(scroll(OsEventTypeList.SCROLL_BOTTOM_EVENT))
    await tick(25)
    assert(ev.filter((e) => e.type === 'next').length === 1, 'a re-delivered scroll inside the tight window advances one row, not two')
  }
  {
    const { ev, n } = mk()
    n.handle(scroll(OsEventTypeList.SCROLL_BOTTOM_EVENT))
    await tick(20)
    n.handle(scroll(OsEventTypeList.SCROLL_TOP_EVENT))
    await tick(25)
    assert(ev.filter((e) => e.type === 'next').length === 1 && ev.filter((e) => e.type === 'previous').length === 1, 'distinct scroll directions are never deduped into each other')
  }
  // G10: an omitted zero-valued enum still means a click.
  {
    const { ev, n } = mk()
    n.handle({ sysEvent: {} })
    await tick(25)
    assert(ev.filter((e) => e.type === 'select').length === 1, 'a click envelope with the zero enum omitted still selects')
  }
  // A sustained press supersedes a pending tap (G08/G09).
  {
    const { ev, n } = mk()
    n.handle(click())
    n.handle(sys(OsEventTypeList.LONG_PRESS_EVENT))
    await tick(25)
    n.handle(sys(OsEventTypeList.LONG_PRESS_RELEASE_EVENT))
    assert(
      ev.filter((e) => e.type === 'select').length === 0 &&
        ev.filter((e) => e.type === 'hold_start').length === 1 &&
        ev.filter((e) => e.type === 'hold_release').length === 1,
      'a hold cancels the armed tap and surfaces as hold start and release, never an action',
    )
  }
  // Menus, lists, audio, and IMU.
  {
    const { ev, n } = mk()
    n.handle({ menuItemClickEvent: { itemID: 4 } })
    n.handle({ menuItemClickEvent: { itemID: 4 } })
    assert(ev.length === 1 && ev[0].type === 'menu_action' && ev[0].itemId === 4, 'a menu item click arrives once with its id')
  }
  {
    const { ev, n } = mk()
    n.handle({ listEvent: {} })
    n.handle({ listEvent: { containerID: 7, currentSelectItemIndex: 2 } })
    assert(ev.length === 2 && ev[0].type === 'list_select' && ev[0].index === 0 && ev[1].index === 2, 'a list event reports its row, defaulting the omitted index to zero')
  }
  {
    const { ev, n } = mk()
    n.handle({ audioEvent: { audioPcm: [0, 1, 2] } })
    n.handle(sys(OsEventTypeList.IMU_DATA_REPORT))
    await tick(25)
    assert(ev.length === 0, 'audio and IMU reports never become taps or commands')
  }
  {
    const { ev, n } = mk()
    n.handle(sys(OsEventTypeList.FOREGROUND_ENTER_EVENT))
    n.handle(sys(OsEventTypeList.FOREGROUND_EXIT_EVENT))
    n.handle(sys(OsEventTypeList.ABNORMAL_EXIT_EVENT))
    n.handle(sys(OsEventTypeList.SYSTEM_EXIT_EVENT))
    assert(
      ev.length === 4 && ev[0].type === 'foreground' && ev[1].type === 'background' &&
        ev[2].type === 'exit' && ev[2].abnormal === true && ev[3].type === 'exit' && ev[3].abnormal === false,
      'lifecycle events pass through unfiltered with their exit kind',
    )
  }
  {
    // G13 covers every re-delivered envelope, lifecycle included: a duplicate
    // foreground must not re-run the host's whole re-present flow.
    const { ev, n } = mk()
    n.handle(sys(OsEventTypeList.FOREGROUND_ENTER_EVENT))
    n.handle(sys(OsEventTypeList.FOREGROUND_ENTER_EVENT))
    n.handle(sys(OsEventTypeList.FOREGROUND_EXIT_EVENT))
    assert(
      ev.length === 2 && ev[0].type === 'foreground' && ev[1].type === 'background',
      'a re-delivered lifecycle envelope is dropped like any other duplicate (G13), a different one passes',
    )
  }
  {
    const { ev, n } = mk()
    n.handle(click())
    n.dispose()
    await tick(25)
    assert(ev.length === 0, 'dispose cancels a pending select so teardown never fires an action')
  }
}

// ---------------------------------------------- 13. renderer page lifecycle
{
  const drain = async () => { await tick(); await tick() }
  const fakeBridge = () => {
    const log = []
    // Every entry is [kind, payload, result], so a test can count calls a
    // page send actually accepted apart from the ones the host rejected.
    const impl = {
      createStartUpPageContainer: async (p) => { const r = 0; log.push(['create', p, r]); return r },
      rebuildPageContainer: async (p) => { const r = true; log.push(['rebuild', p, r]); return r },
      textContainerUpgrade: async (p) => { const r = true; log.push(['text', p, r]); return r },
      updateImageRawData: async (p) => { const r = 'success'; log.push(['image', p, r]); return r },
    }
    return { log, impl, gateway: { call: (op) => op(impl) } }
  }
  const act = (id, label) => ({ id, label, kind: 'command' })
  const sceneView = (over = {}) => ({
    type: 'scene',
    scene: {
      schemaVersion: 1, sceneId: 's1', sceneRevision: 1, missionId: null, stateSequence: 1,
      kind: 'running', spritePose: 'idle', contextLabel: 'SPRIITE',
      utterance: 'Hi.', status: 'On it', progress: null,
      actions: [act('talk', 'Talk'), act('pause', 'Pause')],
      evidenceIds: [], generatedAt: '2026-01-01T00:00:00.000Z', transientMs: 0,
      ...over,
    },
  })
  const selView = (over = {}) => ({
    type: 'selection', purpose: 'decision', contextLabel: 'SPRIITE',
    title: 'Use the verified period?', items: ['Yes', 'No'], pose: 'idle', ...over,
  })
  const count = (log, kind) => log.filter((l) => l[0] === kind).length
  const imagesOf = (log, id) => log.filter((l) => l[0] === 'image' && l[1].containerID === id)
  const textsOf = (log, id) => log.filter((l) => l[0] === 'text' && l[1].containerID === id)

  // 13a. create once, diff in place, rebuild on a layout change or an invalidation.
  {
    const f = fakeBridge()
    const r = new Renderer(f.gateway)
    r.setReduceMotion(true)
    await r.present(sceneView(), 0)
    await drain()
    assert(count(f.log, 'create') === 1 && count(f.log, 'rebuild') === 0, 'the first page is created exactly once and carries its text with it')
    assert(imagesOf(f.log, 5).length === 1, 'the first page also paints the sprite key frame')
    await r.present(sceneView({ utterance: 'Two.' }), 0)
    await drain()
    assert(
      count(f.log, 'create') === 1 && count(f.log, 'rebuild') === 0 && textsOf(f.log, 2).length === 1,
      'a same-layout card is one in-place text upgrade, never a second page',
    )
    await r.present(selView(), 0)
    await drain()
    assert(count(f.log, 'rebuild') === 1, 'a layout change rebuilds the page')
    r.invalidatePage()
    await r.present(selView({ items: ['Yes', 'No', 'Maybe'] }), 1)
    await drain()
    assert(count(f.log, 'rebuild') === 2, 'invalidatePage forces the next present to re-send the whole page')
    r.stop()
  }

  // 13b. an invalidation raised while a present is in flight still sticks.
  {
    const f = fakeBridge()
    let releaseCreate = null
    f.impl.createStartUpPageContainer = () => new Promise((res) => { releaseCreate = () => res(0) })
    const r = new Renderer(f.gateway)
    r.setReduceMotion(true)
    const inFlight = r.present(sceneView(), 0) // stuck inside the page create
    await drain()
    r.invalidatePage() // the host wiped our page mid-send
    releaseCreate()
    await inFlight
    await r.present(sceneView({ utterance: 'Two.' }), 0)
    await drain()
    assert(
      count(f.log, 'rebuild') === 1,
      'a present that lands after an invalidation cannot cancel it: the next present re-sends the whole page',
    )
    r.stop()
  }

  // 13c. a rejected page send stays invalid: the next present retries it whole.
  {
    const f = fakeBridge()
    const r = new Renderer(f.gateway)
    r.setReduceMotion(true)
    await r.present(sceneView(), 0)
    await drain()
    r.invalidatePage()
    f.impl.rebuildPageContainer = async (p) => { const res = false; f.log.push(['rebuild', p, res]); return res }
    await r.present(sceneView({ utterance: 'Two.' }), 0)
    await drain()
    f.impl.rebuildPageContainer = async (p) => { const res = true; f.log.push(['rebuild', p, res]); return res }
    const mark = f.log.length
    await r.present(sceneView({ utterance: 'Three.' }), 0)
    await drain()
    assert(
      f.log.slice(mark).some((l) => l[0] === 'rebuild' && l[2] === true),
      'a failed full-page send is retried whole on the next present, not downgraded to a text diff',
    )
    r.stop()
  }

  // 13d. a rejected text upgrade never wedges the text dedupe.
  {
    const f = fakeBridge()
    const r = new Renderer(f.gateway)
    r.setReduceMotion(true)
    const view = sceneView()
    await r.present(view, 0)
    await drain()
    f.impl.textContainerUpgrade = async (p) => { f.log.push(['text', p]); return false }
    await r.updateActions(view.scene, 1) // the host rejects this one
    f.impl.textContainerUpgrade = async (p) => { f.log.push(['text', p]); return true }
    const before = f.log.length
    await r.updateActions(view.scene, 1) // same content: must retry, not dedupe away
    assert(
      f.log.slice(before).some((l) => l[0] === 'text' && l[1].containerID === 6),
      'a rejected text upgrade is retried on the next update instead of leaving the row stale for the session',
    )
    r.stop()
  }

  // 13e. a rejected image update never wedges the bar or the frame dedupe.
  {
    const f = fakeBridge()
    const r = new Renderer(f.gateway)
    r.setReduceMotion(true)
    const prog = { acceptedWeight: 50, pendingReviewWeight: 0, totalWeight: 100, planRevision: 1 }
    f.impl.updateImageRawData = async (p) => { f.log.push(['image', p]); return 'sendFailed' }
    await r.present(sceneView({ progress: prog }), 0)
    await drain()
    assert(imagesOf(f.log, 4).length >= 2, 'a transient image failure retries the bar instead of leaving the progress stale')
    f.impl.updateImageRawData = async (p) => { f.log.push(['image', p]); return 'success' }
    const before = imagesOf(f.log, 4).length
    await r.present(sceneView({ progress: prog }), 0)
    await drain()
    assert(
      imagesOf(f.log, 4).length > before,
      'the failed bar signature re-opens its dedupe slot, so the same progress is re-sent on the next present',
    )
    r.stop()
  }

  // 13f. the bar blanks when a progress-less card follows a progress card.
  {
    const f = fakeBridge()
    const r = new Renderer(f.gateway)
    r.setReduceMotion(true)
    const prog = { acceptedWeight: 50, pendingReviewWeight: 0, totalWeight: 100, planRevision: 1 }
    await r.present(sceneView({ progress: prog }), 0)
    await drain()
    assert(imagesOf(f.log, 4).length === 1, 'a progress bar is drawn once per signature')
    await r.present(sceneView(), 0)
    await drain()
    const blank = imagesOf(f.log, 4)[1]
    assert(Boolean(blank) && blank[1].imageData.every((v) => v === 0), 'a card without progress blanks the bar so a stale bar never reads as live progress')
    await r.present(sceneView({ progress: prog }), 0)
    await drain()
    assert(imagesOf(f.log, 4).length === 3, 'the same progress returning after a blank bar is re-sent')
    r.stop()
  }

  // 13g. the shown-selection contract a pick resolves against.
  {
    const f = fakeBridge()
    const r = new Renderer(f.gateway)
    r.setReduceMotion(true)
    assert(r.shownSelection() === null && r.shownListItems() === null, 'before a selection page is drawn there is nothing shown to pick')
    await r.present(selView(), 0)
    await drain()
    assert(
      (r.shownListItems() ?? []).join('|') === 'Yes|No' && r.shownSelection()?.title === 'Use the verified period?',
      'the renderer remembers the exact full rows it drew, so a pick refers to the page the user saw',
    )
    await r.present(sceneView(), 0)
    await drain()
    assert(r.shownSelection() === null && r.shownListItems() === null, 'leaving the selection clears the shown rows')
    r.invalidatePage()
    assert(r.shownListItems() === null, 'an invalidated page refuses picks even before the next present')
    r.stop()
  }

  // 13h. targeted updates stay on their own layout.
  {
    const f = fakeBridge()
    const r = new Renderer(f.gateway)
    r.setReduceMotion(true)
    const view = sceneView()
    await r.present(view, 0)
    await drain()
    const n0 = f.log.length
    await r.updateSelectionRows(['a', 'b'], 1)
    await r.updateCaptureTimer('0:07 of 0:30')
    await r.updateListeningHint('word')
    await r.updateHistoryBody('body', 'footer')
    assert(f.log.length === n0, 'updates for other layouts are no-ops: no stray writes onto the wrong containers')
    await r.updateActions(view.scene, 1)
    assert(textsOf(f.log, 6).length === 1, 'the actions line updates in place on the conversation page')

    await r.presentHistory({ contextLabel: 'SPRIITE', title: 'Chat history', bodyText: 'One page.', footerText: 'Chat 1/1 - press to close' })
    await drain()
    assert(count(f.log, 'rebuild') === 1, 'the reading page replaces the conversation page with a rebuild')
    const n2 = f.log.length
    await r.updateActions(view.scene, 1)
    await r.updateSelectionRows(['a', 'b'], 1)
    assert(f.log.length === n2, 'action and row updates never write onto the reading page')
    await r.updateHistoryBody('Page two.', 'Chat 2/2 - press to close')
    assert(f.log.length > n2 && textsOf(f.log, 8).length >= 1, 'history page turns upgrade the body and footer in place')

    // The reading page defines no image container at all: a display reattach
    // while it is up must not push a sprite frame at a container that is not
    // there, and returning to the conversation page must repaint the sprite.
    const imgs = imagesOf(f.log, 5).length
    r.setSurfaceAttached(false)
    r.setSurfaceAttached(true)
    await drain()
    assert(imagesOf(f.log, 5).length === imgs, 'a reattach on the reading page sends no frame to a container the page does not define')
    await r.present(view, 0)
    await drain()
    assert(imagesOf(f.log, 5).length > imgs, 'returning from the reading page repaints the sprite')
    r.stop()
  }

  // 13i. reattaching the display repaints the pinned frame.
  {
    const f = fakeBridge()
    const r = new Renderer(f.gateway)
    r.setReduceMotion(true)
    await r.present(sceneView(), 0)
    await drain()
    const before = imagesOf(f.log, 5).length
    r.setSurfaceAttached(false)
    r.setSurfaceAttached(true)
    await drain()
    assert(imagesOf(f.log, 5).length === before + 1, 'reattaching the display repaints the pinned frame instead of deduping it away')
    r.stop()
  }

  // 13j. every layout passes the SDK page validation the renderer relies on.
  {
    const payloadOf = (l) => ({
      containerTotalNum: l.payload.containerTotalNum,
      textObject: l.payload.textObject,
      listObject: l.payload.listObject,
      imageObject: l.payload.imageObject,
      menuObject: l.payload.menuObject,
    })
    const layouts = [
      ['conversation', conversationLayout({ contextLabel: 'SPRIITE', utterance: 'Hi.', status: 'On it', actionsText: '> Talk   Pause', hasProgress: true })],
      ['selection', selectionLayout({ contextLabel: 'SPRIITE', title: 'Pick one', items: ['a', 'b', 'c'], focusIdx: 0 })],
      ['listening', listeningLayout({ contextLabel: 'LISTENING (LIVE)', hint: 'Listening. Pause when done,\nor tap to finish.', timerText: '0:07 of 0:30', noteText: 'Voice: ElevenLabs | double-tap cancels' })],
      ['history', historyLayout({ contextLabel: 'SPRIITE', title: 'Chat history', bodyText: 'One page.', footerText: 'Chat 1/1 - press to close' })],
    ]
    let ok = true
    let bad = ''
    for (const [name, l] of layouts) {
      const check = validateEvenHubPageContainer(payloadOf(l))
      if (check.valid !== true) { ok = false; bad = `${name}: ${check.code}` }
    }
    assert(ok, `every layout passes the SDK page validation before it is ever sent${ok ? '' : ` (${bad})`}`)
  }

  // 13k. a forced text upgrade the host rejects never wedges the dedupe.
  {
    const f = fakeBridge()
    const r = new Renderer(f.gateway)
    r.setReduceMotion(true)
    await r.present(sceneView(), 0)
    await drain()
    // The rebuild lands, but the forced title upgrade (id 2) is refused once —
    // a flaky BLE hop in the worst possible place (the host is one of those
    // that retains a reused container's old text across a rebuild).
    let failTitle = true
    f.impl.rebuildPageContainer = async (p) => { const res = true; f.log.push(['rebuild', p, res]); return res }
    f.impl.textContainerUpgrade = async (p) => {
      const res = p.containerID === 2 && failTitle ? false : true
      f.log.push(['text', p, res])
      return res
    }
    await r.present(selView(), 0)
    await drain()
    failTitle = false
    const before = f.log.length
    // Same layout, same title: adoption recorded the title the host never
    // took, so a failed forced upgrade must re-open that slot.
    await r.present(selView({ items: ['Yes', 'No', 'Maybe'] }), 1)
    await drain()
    assert(
      f.log.slice(before).some((l) => l[0] === 'text' && l[1].containerID === 2),
      'a rejected post-rebuild title upgrade is retried on the next present instead of deduping the title away for the session',
    )
    r.stop()
  }

  // 13l. no targeted update may land on a page that a rebuild is replacing.
  {
    const f = fakeBridge()
    const r = new Renderer(f.gateway)
    r.setReduceMotion(true)
    await r.presentListening(
      'listening', 'Listening. Pause when done,\nor tap to finish.',
      '0:07 of 0:30', 'Voice: ElevenLabs | double-tap cancels',
    )
    await drain()
    let releaseRebuild = null
    f.impl.rebuildPageContainer = (p) => {
      f.log.push(['rebuild', p, 'pending'])
      return new Promise((res) => { releaseRebuild = () => res(true) })
    }
    const pending = r.presentHistory({
      contextLabel: 'SPRIITE', title: 'Chat history',
      bodyText: 'One page.', footerText: 'Chat 1/1 - press to close',
    })
    await drain() // the rebuild is in flight; the listening layout is still current
    r.updateListeningHint('stale caption') // a caption tick for the replaced page
    r.updateCaptureTimer('0:08 of 0:30')
    releaseRebuild()
    await pending
    await drain()
    const stale = f.log.filter(
      (l) => l[0] === 'text' && (l[1].content === 'stale caption' || l[1].content === '0:08 of 0:30'),
    )
    assert(
      stale.length === 0,
      'updates issued while a page send is in flight are dropped, not written onto the page that replaces it (hint id 8 is the history body)',
    )
    r.stop()
  }

  // 13m. reattaching the display repaints the progress bar, not just the sprite.
  {
    const f = fakeBridge()
    const r = new Renderer(f.gateway)
    r.setReduceMotion(true)
    const prog = { acceptedWeight: 50, pendingReviewWeight: 0, totalWeight: 100, planRevision: 1 }
    await r.present(sceneView({ progress: prog }), 0)
    await drain()
    const before = imagesOf(f.log, 4).length
    r.setSurfaceAttached(false)
    r.setSurfaceAttached(true)
    await drain()
    assert(
      imagesOf(f.log, 4).length === before + 1,
      'reattaching repaints the progress bar: the bar dedupe reopens like the frame dedupe, so a blank-returned surface never reads as zero progress',
    )
    r.stop()
  }

  // 13n. capture unpins the reading page's static sprite.
  {
    const f = fakeBridge()
    const r = new Renderer(f.gateway) // reduce motion off: the pose must hover
    await r.presentHistory({
      contextLabel: 'SPRIITE', title: 'Chat history',
      bodyText: 'One page.', footerText: 'Chat 1/1 - press to close',
    })
    await drain()
    await r.presentListening(
      'listening', 'Listening. Pause when done,\nor tap to finish.',
      '0:07 of 0:30', 'Voice: ElevenLabs | double-tap cancels',
    )
    await drain()
    await tick(1500) // glasses frames hold 1000 ms
    const moving = new Set(
      ANIMS.listening.steps.filter((s) => s.frame !== ANIMS.listening.key).map((s) => framePixels(s.frame).join(',')),
    )
    const sent = f.log
      .filter((l) => l[0] === 'image' && l[1].containerID === 5)
      .map((l) => l[1].imageData.join(','))
    assert(
      sent.some((px) => moving.has(px)),
      'a capture page never inherits the reading page\u2019s static pin: the listening pose animates',
    )
    r.stop()
  }

  // 13o. a rejected startup create falls back to a rebuild (host code 1).
  {
    const f = fakeBridge()
    f.impl.createStartUpPageContainer = async (p) => { const r = 1; f.log.push(['create', p, r]); return r }
    const r = new Renderer(f.gateway)
    r.setReduceMotion(true)
    await r.present(sceneView(), 0)
    await drain()
    assert(
      count(f.log, 'rebuild') === 1 && imagesOf(f.log, 5).length === 1,
      'a rejected startup create (host result 1) falls back to a rebuild so the first page still lands',
    )
    assert(
      count(f.log, 'create') === 2,
      'the rejected create was retried once without its menu before the fallback (G30 keeps the menu preference until a menu-less page succeeds)',
    )
    r.stop()
  }

  // 13p. a present that starts during an in-flight page send coalesces.
  {
    const f = fakeBridge()
    const r = new Renderer(f.gateway)
    r.setReduceMotion(true)
    await r.present(sceneView(), 0)
    await drain()
    let releaseRebuild = null
    f.impl.rebuildPageContainer = (p) => {
      f.log.push(['rebuild', p, true])
      return new Promise((res) => { releaseRebuild = () => res(true) })
    }
    const first = r.present(selView(), 0) // conversation -> selection, held in flight
    await drain()
    // A newer selection arrives while the page turn is still on the wire:
    // it must wait and then diff, never queue a second full page send.
    const second = r.present(selView({ items: ['Yes', 'No', 'Maybe'] }), 1)
    releaseRebuild()
    await first
    await second
    await drain()
    assert(
      count(f.log, 'rebuild') === 1,
      'a same-layout present during an in-flight rebuild waits and then diffs in place instead of stacking a second full page send',
    )
    // HudAsk: container 7 holds the focused (bordered) option, container 12
    // the options after it (the carousel), both from layout.optionRows.
    const want = optionRows(['Yes', 'No', 'Maybe'], 1)
    const focusRows = textsOf(f.log, 7).map((l) => l[1].content)
    const restRows = textsOf(f.log, 12).map((l) => l[1].content)
    assert(
      focusRows[focusRows.length - 1] === want.focus && restRows[restRows.length - 1] === want.rest,
      'the coalesced present still lands its own newer rows after the page it waited for',
    )
    r.stop()
  }

  // 13q. present answers for itself: a page send the host refused resolves
  // false, so a caller that owns display state on it (the chat reader) can
  // roll back instead of trusting an open that never drew.
  {
    const f = fakeBridge()
    const r = new Renderer(f.gateway)
    r.setReduceMotion(true)
    assert((await r.present(sceneView(), 0)) === true, 'a landed page answers true')
    f.impl.rebuildPageContainer = async (p) => { const res = false; f.log.push(['rebuild', p, res]); return res }
    assert(
      (await r.presentHistory({
        contextLabel: 'SPRIITE', title: 'Chat history',
        bodyText: 'One page.', footerText: 'Chat 1/1 - press to close',
      })) === false,
      'a refused reading page answers false: the caller rolls the reader back instead of paging a page that never drew',
    )
    assert(
      (await r.presentListening('listening', 'Hint', '0:07 of 0:30', 'Note')) === false,
      'a refused listening page answers false too (the same honest contract)',
    )
    assert((await r.present(sceneView(), 0)) === true, 'a same-layout scene diff needs no page send and stays true')
    assert((await r.present(selView(), 0)) === false, 'a refused page turn (conversation -> selection) answers false')
    r.stop()
  }

  // 13r. stacked presents can never stack two page sends, and a refused
  // send still settles every waiter (the chain is released in finally, so
  // the pre-fix suite's stacked-send deadlock cannot come back).
  {
    const f = fakeBridge()
    let inFlight = 0
    let maxInFlight = 0
    let refused = true
    f.impl.createStartUpPageContainer = async (p) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      f.log.push(['create', p, 0])
      await tick(1)
      inFlight -= 1
      return 0
    }
    f.impl.rebuildPageContainer = async (p) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      const res = refused ? false : true
      f.log.push(['rebuild', p, res])
      await tick(1)
      inFlight -= 1
      return res
    }
    const r = new Renderer(f.gateway)
    r.setReduceMotion(true)
    const stacked = [
      r.present(sceneView(), 0),
      r.presentHistory({
        contextLabel: 'SPRIITE', title: 'Chat history',
        bodyText: 'One page.', footerText: 'Chat 1/1 - press to close',
      }),
      r.presentListening('listening', 'Hint', '0:07 of 0:30', 'Note'),
      r.present(sceneView(), 1),
    ]
    const settled = await Promise.all(stacked.map((p) => p.then(() => true, () => true)))
    assert(
      settled.every(Boolean) && maxInFlight === 1,
      'stacked presents serialize to one page send at a time and every one settles, refused or not',
    )
    refused = false
    assert(
      (await r.present(sceneView(), 0)) === true,
      'a later present still lands after refused sends: the chain never wedges',
    )
    assert(maxInFlight === 1, 'no two page sends were ever in flight at once')
    r.stop()
  }
}


// ------------------------------- holds are timed from when a frame landed
{
  // A slow transfer followed by a fast one must not shorten the slow frame's
  // time on screen (MotionLab: at least 1000 ms per frame at glasses speed).
  const landed = []
  let n = 0
  const show = (frame) => new Promise((r) => {
    const ms = n++ % 2 === 0 ? 300 : 10
    setTimeout(() => { landed.push(Date.now()); r() }, ms)
  })
  const anim = new SpriteAnimator(show)
  anim.setPose('building')
  await new Promise((r) => setTimeout(r, 4200))
  anim.stop()
  const holds = landed.slice(1).map((t, i) => t - landed[i])
  assert(holds.length >= 2 && holds.every((h) => h >= 990), `each frame stays on screen for its full hold (${holds.join(',')} ms)`)
}

console.log(failures === 0 ? '\nAll sprite tests passed.' : `\n${failures} sprite test(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
