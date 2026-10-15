import nodeAssert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { VoiceTurnGuard, voiceTargetOf, sendVoiceMessage } from '../src/voice/turn.ts'

let checks = 0
const assert = {
  equal(actual, expected, label = 'voice ownership invariant holds') {
    nodeAssert.equal(actual, expected, label)
    checks++
    console.log('  PASS:', label)
  },
  match(actual, expected) {
    nodeAssert.match(actual, expected)
    checks++
    console.log('  PASS: production uses the tested voice ownership guard')
  },
}
{
  const messages = []
  const engine = { steer: text => { messages.push(text); return true } }
  for (const text of ['continue', 'pause', 'restart', 'yes', 'Start a new build']) {
    assert.equal(sendVoiceMessage(engine, text), true, 'explicit voice messages use the session-message seam')
    assert.equal(messages.at(-1), text, 'command-shaped dictation is a message, not an app action')
  }
  assert.equal(sendVoiceMessage(engine, '   '), false, 'empty message capture posts nothing')
  assert.equal(sendVoiceMessage({ steer: () => false }, 'hello'), false, 'a refused message never falls back to a new goal')
}
const a = { engine: {}, mission: 'A' }
const b = { engine: a.engine, mission: 'B' }
const home = { engine: a.engine, mission: null }
const legacyEngine = {}
const legacyHome = { goal: '', sessionId: null, attach: null }
const savedA = { goal: 'Saved A', sessionId: 'session-a', attach: null, phase: 'building' }
const savedB = { goal: 'Saved B', sessionId: 'session-b', attach: null, phase: 'building' }
const watchA = { goal: '', attach: { source: 'factory', sessionId: 'watch-a', title: 'A' } }
const watchB = { goal: '', attach: { source: 'factory', sessionId: 'watch-b', title: 'B' } }
const cursorA = { goal: '', attach: { source: 'cursor', agentId: 'agent-a', runId: 'run-a' } }
const cursorB = { goal: '', attach: { source: 'cursor', agentId: 'agent-a', runId: 'run-b' } }
for (const phase of ['starting', 'listening', 'transcribing']) {
  for (const [before, after] of [
    [legacyHome, savedA], [savedA, savedB], [watchA, watchB],
    [cursorA, cursorB], [savedA, legacyHome],
    [savedA, { ...savedA, sessionId: 'another-session' }],
  ]) {
    let mode = phase
    const guard = new VoiceTurnGuard(() => { mode = 'scene' })
    const turn = guard.begin(voiceTargetOf(legacyEngine, before))
    assert.equal(guard.reconcile(voiceTargetOf(legacyEngine, after)), true,
      `production identity cancels legacy navigation during ${phase}`)
    assert.equal(mode, 'scene')
    const newer = guard.begin(voiceTargetOf(legacyEngine, after))
    mode = 'listening'
    assert.equal(guard.complete(turn), false, 'legacy stale completion cannot own a newer capture')
    assert.equal(guard.isCurrent(newer), true)
    assert.equal(mode, 'listening')
  }
  for (const snapshot of [savedA, watchA, cursorA]) {
    const guard = new VoiceTurnGuard()
    const turn = guard.begin(voiceTargetOf(legacyEngine, snapshot))
    assert.equal(guard.reconcile(voiceTargetOf(legacyEngine, {
      ...snapshot, phase: 'review', messageCount: 42, progress: 90,
      attach: snapshot.attach ? { ...snapshot.attach, runStatus: 'completed', title: 'Updated' } : null,
    })), false, 'same execution progress/card churn preserves capture')
    assert.equal(guard.isCurrent(turn), true)
  }
}
for (const phase of ['starting', 'listening', 'transcribing']) {
  for (const target of [b, home, { engine: {}, mission: 'A' }]) {
    let mode = phase
    let cancelled = 0
    const guard = new VoiceTurnGuard(() => { mode = 'scene'; cancelled++ })
    const turn = guard.begin(a)
    assert.equal(guard.reconcile({ ...a }), false, 'same mission cards keep capture')
    assert.equal(guard.reconcile(target), true)
    assert.equal(mode, 'scene', `${phase} cannot strand the UI`)
    assert.equal(cancelled, 1)
    assert.equal(guard.isCurrent(turn), false, 'old speech cannot route')
    const newer = guard.begin(target)
    mode = 'listening'
    assert.equal(guard.complete(turn), false, 'old success/error cannot clear a newer turn')
    assert.equal(mode, 'listening')
    assert.equal(guard.isCurrent(newer), true)
    assert.equal(guard.complete(newer), true)
    guard.invalidate()
    assert.equal(cancelled, 1, 'completed turns no longer own capture UI')
  }
}
{
  let mode = 'transcribing'
  const guard = new VoiceTurnGuard(() => { mode = 'scene' })
  const turn = guard.begin(a)
  const deferred = Promise.resolve().then(() => guard.complete(turn))
  guard.invalidate() // lifecycle/error/cancel while settlement is deferred
  assert.equal(await deferred, false)
  assert.equal(mode, 'scene')
}
for (const outcome of ['success', 'error']) {
  let mode = 'transcribing'
  let resolve
  let applied = 0
  const guard = new VoiceTurnGuard(() => { mode = 'scene' })
  const old = guard.begin(voiceTargetOf(legacyEngine, savedA))
  const settled = new Promise((r) => { resolve = r }).then(() => {
    if (!guard.complete(old)) return
    mode = 'scene'
    if (outcome === 'success') applied++
  })
  guard.reconcile(voiceTargetOf(legacyEngine, savedB))
  const newer = guard.begin(voiceTargetOf(legacyEngine, savedB))
  mode = 'listening'
  resolve()
  await settled
  assert.equal(applied, 0, 'stale settlement never applies speech')
  assert.equal(mode, 'listening', 'stale success/error never releases newer UI')
  assert.equal(guard.isCurrent(newer), true)
  guard.invalidate()
  assert.equal(mode, 'scene', 'cancellation/error releases the owning UI')
}
// Pin integration: ownership starts before the awaited open; every focused
// engine emission reconciles identity rather than cancelling same-mission ticks.
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
const turnSource = readFileSync(new URL('../src/voice/turn.ts', import.meta.url), 'utf8')
assert.match(main, /voiceTurns\.begin\(voiceTarget\(\)\)/)
assert.match(main, /function onEngineView\(view: EngineView\): void \{\s*voiceTurns\.reconcile\(voiceTarget\(\)\)/)
assert.match(main, /if \(startingTalk \|\| store\.uiMode !== 'scene'\) return/)
assert.match(main, /if \(!voiceTurns\.complete\(turn\)\) return/)
assert.match(main, /voiceTargetOf\(engine, engine\.snapshot\(\),/)
assert.match(turnSource, /nativeCaptureKey\(null, native\)/)
assert.match(main, /voiceTurns\.captureTarget/)
assert.match(main, /retainVoiceDraft\(text, originalTarget\)/)
assert.match(main, /async function cleanup[\s\S]*?voiceTurns\.exit\(\)/)
assert.match(main, /startTalk\(action\.id === 'send_message'\)/)
assert.match(main, /const messageOnly = messageVoiceTurn === turn/)
assert.match(main, /if \(messageOnly\) \{\s*if \(sendVoiceMessage\(engine, text\)\) return/)
console.log(`All ${checks} voice turn ownership checks passed.`)
