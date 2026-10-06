/**
 * Copy budget checker (dev tool). Verifies every HUD string against the
 * conversation-layout budgets using the pretext firmware-font model, and
 * flags any codepoint the font model reports as missing.
 *
 * Usage: node scripts/measure-copy.mjs
 */
import { getAdvW, getTextWidth, measureTextWrap } from '@evenrealities/pretext'

const U = {
  utterance: { w: 440, lines: 4 },
  status: { w: 440, lines: 1 },
  context: { w: 528, lines: 1 },
  action: { w: 160, lines: 1 },
  listItem: { w: 500, lines: 1 },
  hint: { w: 440, lines: 2 },
}

const CONTEXTS = [
  'SPRIITE (DEMO)',
  'SPRIITE',
  'FUTARCHISTS (DEMO)',
  'LISTENING (DEMO)',
  'LISTENING (LIVE)',
]
const UTTERANCES = [
  'Hi. What should we build?',
  'This build runs a simulated factory. Every step and number is labeled demo.',
  'Demo connections are ready. GitHub, Cursor, and Factory are simulated here.',
  'Add the empty-state screen and have another agent check it.',
  'Cursor leads, Factory builds, and I check each step.',
  'The build is moving. Two steps passed earlier today.',
  'The agent finished this step. I am checking it.',
  'The verification run finished. I am checking it.',
  'The pull request is in. I am checking it.',
  'The empty state failed one check. I sent it back for a fix.',
  'The screen passed my checks.',
  'The verification passed my checks.',
  'A later change broke one check. It is being fixed again.',
  'Historical data is incomplete. Use the verified period?',
  'The feed has gaps before October. I can only verify the recent period.',
  'Factory will lead from here. The workers can continue.',
  'The verified PR is ready.',
  'New work is paused. One agent is finishing its step.',
  'Everything is on track.',
  'I still need one choice.',
  'The microphone did not start. Nothing was recorded.',
  'Transcribing what you said...',
  'I check empty results, failed requests, and layout bounds.',
  'Empty results render, but failed requests skip the retry path.',
  'Empty results and failed requests both behave correctly.',
  'The screen check broke again during verification.',
  // Voice (live STT) cards
  'Finishing what you said...',
  'I did not catch anything. Nothing was sent.',
  'Nothing is running yet.',
  'Nothing is running to pause.',
  'Nothing is paused.',
  'There is no choice waiting.',
  'There is nothing to explain yet.',
  'Use the verified period?',
  'Restart? Progress resets and you return home.',
  'The demo is already running.',
  'I cannot act on that yet.',
  'I heard: Add the empty-state screen. I cannot act on that yet.',
  'ElevenLabs rejected your voice key. Check it on your phone.',
  'ElevenLabs hit a usage or rate limit. Try again soon.',
  'I could not reach the voice service. Nothing was sent.',
  'The voice service failed. Nothing was sent.',
  // Real orchestrator (connected accounts) cards; the worker is a Cursor
  // cloud agent or a second Factory session, so copy stays worker-neutral.
  'Connect Factory on your phone to run real builds, or say "run the demo" to watch a simulated one.',
  'Pick a repository on your phone, or start this build in a new one.',
  'To start this build in a new repository, add a GitHub token on your phone.',
  'Creating a new repository on GitHub, then planning the build.',
  'Factory needs a computer to run builds. Open the Factory app on your Mac or add a cloud computer, then try again.',
  'To speak your goals, add an ElevenLabs key on your phone.',
  'Factory is drafting the plan. This takes a minute.',
  'The plan is ready. A worker builds it, and Factory verifies each step.',
  'Start the build? It uses Factory credits, and Cursor credits if connected.',
  'The worker is building the change. I will verify each step.',
  'The worker pushed a branch. Factory is reviewing the diff now.',
  'The review passed. This step is verified.',
  'The review failed. I sent the reasons back to the worker.',
  'The review passed. I asked the worker to open the pull request.',
  'The verified pull request is ready.',
  'The worker stopped early. How should I proceed?',
  'The worker finished without pushing a branch. How should I proceed?',
  'The worker finished without opening a pull request. How should I proceed?',
  'I paused the orchestrator. The worker keeps running in the background.',
  'One of your accounts rejected its key. Check your keys on the phone.',
  'Factory sessions are not enabled on this account yet.',
  'A service hit a usage or rate limit. Nothing was changed.',
  'A service was unreachable. Nothing was changed.',
  'Your computer is offline. Open the Factory app on it and turn on Remote Access, then retry.',
  'The GitHub token is missing permission for that. Nothing was changed.',
  'That repository name is taken. Try again with a new name.',
  'A service failed. Nothing was changed.',
  'Your Factory account needs billing or credits. Nothing was changed.',
  'That build could not take your message. It is still running.',
  'Factory is planning the build.',
  'The worker is building the change.',
  'Factory is reviewing the change.',
  'The worker is fixing the review findings.',
  'The worker is opening the pull request.',
  // Attach (watching a cloud build picked from the home list)
  'I am watching a build from your account.',
  'Cloud build finished the settings screen.',
  // Parallel workers (large-task split preference)
  'The plan is ready. 2 workers split the jobs, and Factory verifies each one.',
  'The plan is ready. 3 workers split the jobs, and Factory verifies each one.',
  'The plan is ready. 4 workers split the jobs, and Factory verifies each one.',
  '2 workers are building in parallel. I verify each job as it lands.',
  '3 workers are building in parallel. I verify each job as it lands.',
  '4 workers are building in parallel. I verify each job as it lands.',
  'All jobs passed review. One worker is merging the branches.',
  'The review passed. Open the pull request?',
]
const STATUSES = [
  '35% verified',
  '35% verified | 20% in review',
  '35% verified | 25% in review',
  '35% verified | 45% in review',
  '55% verified',
  '55% verified | 25% in review',
  '80% verified',
  '80% verified | 20% in review',
  '100% verified',
  '35% verified | 2 steps done earlier',
  '35% verified | 1 choice needed',
  'Demo transcript | captured 30s',
  'Demo transcript | picked from list',
  'Live transcript | captured 30s',
  'Mic failed | demo',
  'Demo | scripted transcript',
  'Voice | ElevenLabs',
  'Voice | nothing done',
  'Voice | confirm to act',
  'Voice | key needed',
  'Voice failed | nothing sent',
  'Waiting for glasses',
  '0:07 of 0:30',
  '0:30 of 0:30',
  'Connect Factory',
  'Pick repository',
  'Connect computer',
  'Connect GitHub',
  'GitHub | creating',
  'Computer offline | check Factory app',
  // Real orchestrator composed statuses (worst cases)
  '0% verified | Factory planning',
  '20% verified | 5 milestones',
  '20% verified | 1 choice needed',
  '20% verified | worker building',
  '20% verified | Worker stopped',
  '20% verified | 65% in review | Factory reviewing',
  '20% verified | 65% in review | worker fixing',
  '20% verified | 3 jobs building',
  '20% verified | 22% in review | Factory reviewing',
  '85% verified | 15% in review | merging branches',
  '85% verified | 15% in review | worker opening PR',
  '100% verified',
  '100% verified | 4 of 4 steps verified',
  '85% verified | Spriite replied',
  'Service failed | nothing changed',
  'Service failed | Factory HTTP 400',
  'Service failed | Cursor HTTP 500',
  'Service failed | Factory HTTP 402',
  'Service failed | WWWWWWWWWWWWWWWW...',
  // Attach (watch card) composed statuses
  'Factory: waiting',
  'Factory: planning',
  'Factory: building',
  'Factory: done',
  'Cursor: waiting',
  'Cursor: planning',
  'Cursor: building',
  'Cursor: done',
  'Cursor: stopped',
  'Factory: building | watch only',
  'Factory: watching | watch only',
  'Cursor: building | watch only',
  'Cursor: stopped | watch only',
]
const ACTIONS = [
  'Set up my factory', 'Continue', 'Choose a goal', 'Start planning', 'Change',
  'Start', 'Milestones', 'Talk', 'Pause', 'Resume', 'Use it', 'Explain', 'Back',
  'Show evidence', 'Restart demo', 'Restart', 'Retry', 'Cancel', 'Confirm',
  'Start build', 'Open PR', 'Connect', 'Pick on phone', 'New repo', 'Demo',
]
const LIST_ITEMS = [
  'Talk to Spriite',
  'Empty-state screen (demo)',
  'Contracts 10 | done',
  'Fixtures 25 | done',
  'Empty-state screen 20',
  'Verification 25',
  'Verified PR 20',
  '● Empty results render',
  '● Failed requests retry',
  '● Layout bounds hold',
  '● Engine fixtures green',
  '● PR checks passed',
  'Say what we should build.',
  'Demo capture | double-tap cancels',
  'Voice: ElevenLabs | double-tap cancels',
  'Plan | 5 milestones',
  'Evidence | checks passed',
  'What should we build?',
  // Real orchestrator list items
  'Plan | done',
  'Build | building',
  'Build | in review',
  'Verify | in review',
  'PR | pending',
  'Session 00000000',
  'Worker session 00000000',
  'Run 00000000',
  'Branch cursor/add-the-empty-state',
  'PR #123',
  'Reply saved | see Explain',
  'Nothing recorded yet',
  // Projects home (list title, rows, new-build entry)
  'Projects',
  'New build',
  'Add the empty-state screen | building',
  'Deliver the empty-state screen | opening PR',
  'Add the empty-state screen and verify it... | in review',
  // Cloud builds (merged home rows; the engine truncates the title until
  // the row fits one line, so these are the fitted worst cases)
  'Fix the login flake | Factory: waiting',
  'Add the empty-state screen and... | Factory: planning',
  'Add the empty-state screen and... | Cursor: building',
  'Add the empty-state screen and verify... | Cursor: done',
]
const MULTI = [
  'Say what we should build.\nTap to finish.',
  'Listening. Pause when done,\nor tap to finish.',
  'The glasses are disconnected.\nSpriite will wait for them.',
]

function wrappedLines(text, maxWidth) {
  return text.split('\n').reduce((n, part) => n + (part ? measureTextWrap(part, maxWidth).lineCount : 0), 0)
}

const failures = []
function check(name, text, budget) {
  const lines = wrappedLines(text, budget.w)
  const width = getTextWidth(text.replace(/\n/g, ' '))
  if (lines > budget.lines) failures.push(`${name}: ${lines} lines > ${budget.lines} @${budget.w}px :: ${JSON.stringify(text)}`)
  if (lines === 1 && width > budget.w) failures.push(`${name}: ${width}px > ${budget.w}px :: ${JSON.stringify(text)}`)
}

for (const t of UTTERANCES) check('utterance', t, U.utterance)
for (const t of STATUSES) check('status', t, U.status)
for (const t of CONTEXTS) check('context', t, U.context)
for (const t of ACTIONS) check('action', t, U.action)
for (const t of LIST_ITEMS) check('listItem', t, U.listItem)
for (const t of MULTI) check('hint', t, U.hint)

// Glyph coverage: any codepoint the font model reports as zero-width.
// ('\n' is an intentional line break handled by the renderer, not a glyph.)
const all = [...UTTERANCES, ...STATUSES, ...CONTEXTS, ...ACTIONS, ...LIST_ITEMS, ...MULTI].join('')
const missing = [...new Set([...all])].filter((ch) => ch !== '\n' && getAdvW(ch.codePointAt(0)) <= 0)
if (missing.length > 0) failures.push(`glyphs reported missing by the font model: ${missing.join(' ')}`)

// Joined action lines (renderer composition).
const lines = [
  '> Set up my factory',
  '> Continue   Choose a goal',
  '> Start planning   Change',
  '> Start   Milestones',
  '> Talk   Pause',
  '> Explain   Talk',
  '> Use it   Explain',
  '> Show evidence   Restart demo',
  '> Resume   Talk',
  '> Retry   Cancel',
  '> Talk   Back',
  '> Confirm   Cancel',
  '> Start build   Milestones',
  '> Talk   Restart',
  '> Confirm   Talk',
  '> Connect   Demo   Talk',
  '> Pick on phone   Talk',
  '> Explain   Talk   Back',
  // Real-engine cards with the new affordances (retry, new repository).
  '> Pick on phone   New repo   Talk',
  '> Start planning   New repo   Change',
  '> Retry   Talk   Restart',
  '> Connect   Retry   Talk',
  '> Connect   Talk',
  '> Start build   Talk',
]
for (const t of lines) {
  const w = getTextWidth(t)
  if (w > 528) failures.push(`actions line ${w}px > 528px :: ${JSON.stringify(t)}`)
}

if (failures.length > 0) {
  console.error(`COPY BUDGET FAILURES (${failures.length}):`)
  for (const f of failures) console.error(' -', f)
  process.exit(1)
}
console.log('Copy budgets OK: all strings fit; no missing glyphs reported.')
