/**
 * Copy budget checker (dev tool). Verifies every HUD string against the
 * redesigned HUD containers (docs/design/redesign/Hud*.dc.html at 1x, see
 * src/render/layout.ts) using the pretext firmware-font model, and flags any
 * codepoint the font model reports as missing.
 *
 * Containers: context line 528 (label left, detail right, at least 10 px
 * apart), main text 440 x 4 lines, subline 440 x 1, action labels inside the
 * bordered box (160), the actions row 528 (box + 22 px gaps + ‹ › hints),
 * listening transcript 440 x 3 (curly quotes included), the question 440 x 2,
 * options 515 x 1, footer 528 x 1.
 *
 * Usage: node scripts/measure-copy.mjs
 */
import { getAdvW, getTextWidth, measureTextWrap, pxTruncate } from '@evenrealities/pretext'

const U = {
  utterance: { w: 440, lines: 4 },
  status: { w: 440, lines: 1 },
  context: { w: 528, lines: 1 },
  action: { w: 160, lines: 1 },
  listItem: { w: 500, lines: 1 },
  hint: { w: 440, lines: 2 },
  // The chat-history page (x 24, 528 wide; the body container is 168px).
  historyTitle: { w: 440, lines: 1 },
  historyFooter: { w: 528, lines: 1 },
  historyBody: { w: 528, lines: 6 },
  // The selection page's title container (x 112, 440 wide, 54px = 2 lines).
  selectionTitle: { w: 440, lines: 2 },
  // Redesign containers (HudIdle/Listen/Run/Ask/Done at 1x).
  contextDetail: { w: 240, lines: 1 },
  transcript: { w: 440, lines: 3 },
  question: { w: 440, lines: 2 },
  option: { w: 515, lines: 1 },
  footer: { w: 528, lines: 1 },
  listenLabel: { w: 440, lines: 1 },
}

const CONTEXTS = [
  'SPRIITE',
  'NO VOICE KEY',
  'LISTENING (LIVE)',
  // Redesign context labels (uppercase as drawn).
  'LISTENING',
  'LEAD ASKS',
  'WORKER ASKS',
  'SPRIITE ASKS',
  'CHECKOUT FLOW',
]
// Right halves of the context line (HudIdle, HudListen, HudRun, HudDone, HudAsk).
const CONTEXT_DETAILS = [
  '3 builds · 1 needs you',
  '9 builds · 9 need you',
  '1 build',
  '0:07 of 0:30',
  '0:30 of 0:30',
  'BUILDING · 2 OF 4',
  'OPENING PR · 16 OF 16',
  'CHECKING · 4 OF 5',
  'FIXING · 3 OF 5',
  'PLANNING · 1 OF 5',
  'PAUSED · 3 OF 5',
  'DONE',
  'ONBOARDING EMAILS',
]
// Every label + detail pair a card composes (the renderer fits a long build
// title; these are the drawn and worst fixed cases).
const CONTEXT_LINES = [
  ['SPRIITE', '9 builds · 9 need you'],
  ['LISTENING', '0:30 of 0:30'],
  ['NO VOICE KEY', '0:30 of 0:30'],
  ['CHECKOUT FLOW', 'BUILDING · 2 OF 4'],
  ['CHECKOUT FLOW', 'DONE'],
  ['LEAD ASKS', 'ONBOARDING EMAILS'],
  // The widest title the engine passes (260 px, see HUD_TITLE_W in real.ts).
  [pxTruncate('ADD THE EMPTY-STATE SCREEN AND VERIFY IT', 260), 'OPENING PR · 16 OF 16'],
]
const UTTERANCES = [
  // Redesign HUD copy (HudIdle, HudRun, HudDone).
  'Ready when you are.',
  'Two workers are wiring the payment step.',
  'Checkout flow is ready for you to review.',
  'Add the empty-state screen and is ready for you to review.',
  'Your build is ready for you to review.',
  'That request was not saved, so nothing started. Try again.',
  'That build already finished. Its record is kept.',
  'The microphone did not start. Nothing was recorded.',
  'Transcribing what you said...',
  // Voice (live STT) cards
  'Finishing what you said...',
  'I did not catch anything. Nothing was sent.',
  'Nothing is running yet.',
  'Nothing is running to pause.',
  'Nothing is paused.',
  'There is no choice waiting.',
  'There is nothing to explain yet.',
  'Confirm? Spriite sends your yes to this build.',
  'Restart? Progress resets and you return home.',
  'I cannot act on that yet.',
  'I heard: Add the empty-state screen. I cannot act on that yet.',
  'ElevenLabs rejected your voice key. Check it on your phone.',
  'ElevenLabs hit a usage or rate limit. Try again soon.',
  'I could not reach the voice service. Nothing was sent.',
  'The voice service failed. Nothing was sent.',
  // The durable runtime cancels the mission but keeps its record.
  'Restart? This build stops; its record stays on your home.',
  // Real orchestrator (connected accounts) cards; the worker is a Cursor
  // cloud agent or a second Factory session, so copy stays worker-neutral.
  'Connect Factory on your phone to run builds.',
  'Pick a repository on your phone, or start this build in a new one.',
  'Spriite needs GitHub to create the repository. Pair with your computer (it uses its GitHub sign-in), or add a GitHub token in Settings.',
  'Creating a new repository on GitHub, then planning the build.',
  'Factory needs a computer to run builds. Open the Factory app or run droid on a computer, or add a cloud computer, then try again.',
  'To speak your goals, add an ElevenLabs key on your phone.',
  'Factory reports this session is running. The completed plan has not arrived yet.',
  'Factory reports this session is idle. No plan arrived. Choose Continue or Send message.',
  'No completed plan yet. Current Factory activity is unconfirmed.',
  'Factory has queued the request. It is not running yet.',
  'The session is idle. This step is unfinished. Continue sends a request to this chat.',
  'A result is still awaited. Current session activity is unconfirmed.',
  'Delivery is unconfirmed. I will check this chat, not resend. Read History or check it in Factory, then Resolve.',
  'Seen this request in Factory? Mark only if checked. Stop waiting clears local queued requests; the original may still arrive.',
  'Build this scope in example/spriite? Review the full scope in History first.',
  'A plan is available for review. Review scope, then explicitly Start build.',
  'Factory needs its native popup. The exact phone link is ready. Use Builds to switch tasks. No answer was sent.',
  'This build already has an execution controller. Open its status or question; nothing was sent.',
  'Wait for confirmed idle before starting execution from this chat. Nothing was sent.',
  'No complete goal, repository, and plan could be recovered. Open Factory or submit an exact new goal. Nothing was sent.',
  'Could not read the build scope. Nothing was sent and no build started. Open Factory or try again later.',
  'The chat activity or scope changed. Review it again before starting execution. No build started.',
  'Could not confirm the chat scope. Nothing was sent and no build started. Try again later.',
  'This watched chat needs managed execution. Enable the durable runtime or submit an exact new goal. No build started.',
  'The Factory request timed out. The session may still be active. Check its chat before retrying.',
  'I could not check this chat before sending. Nothing was sent. Check History and try when the chat is readable.',
  'This session cannot take your message right now. Nothing was sent.',
  'Read this session here. To continue or send a message, open Factory on your phone.',
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
  'That session could not take your message. Its activity has not been confirmed.',
  'The plan is still awaited. That does not confirm active work.',
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
  'All jobs passed review. I asked one worker to merge the branches.',
  'The review passed. Open the pull request?',
  // A refused gate ends the mission: these cards say what that means.
  'You declined the build. It did not start, and no credits were spent.',
  'You declined the pull request. The build stops; its record is kept.',
  // The durable runtime failed to boot (honest state, never a silent fallback).
  'The durable runtime did not start. Builds still run, but none will survive a relaunch.',
  // The durable runtime's own refusals (not provider faults) also reach the HUD.
  'All worker slots are busy. Your build waits in line.',
  'Your policy settings stopped this action. Check them on the phone.',
  'This step is paused. Resume to continue it.',
  'The mission log could not be saved. Nothing was sent.',
  'This mission has ended. Nothing was started.',
  // X intake notices (one card per held post / started request).
  'An X post that mentions Spriite is waiting for your OK. Confirm it on the phone.',
  '10 X posts are waiting for your OK. Confirm them on the phone.',
  // Session settings live on the phone, not the glasses: the setup panel
  // states what a save reaches (the next build), so the copy budget covers it.
  'A build freezes its settings the moment it starts, so a change here applies to your next build. Clearing a value uses your account default.',
  'Saved. Your next build uses these settings.',
  // Native delivery (terminal utterances; worst cases).
  'Factory reports completion. PR open · checks 10/10. Not delivered.',
  'Factory reports completion. Branch pushed · no PR yet. Not delivered.',
  'Factory reports completion. Not merged: checks failed. Not delivered.',
  'Factory reports completion. Not merged: no checks configured. Not delivered.',
  'Factory reports completion. Delivered: PR #99999 merged after checks passed.',
  'Factory reports completion. Delivery held: Base branch moved since the job started. Not delivered.',
]
const STATUSES = [
  // Redesign sublines (HudIdle, HudRun, HudDone).
  'Hold to talk, or swipe for builds.',
  '6 checks passed · 3 agents',
  '1 check passed · 2 agents',
  '16 checks passed · 5 agents',
  'All checks passed · pull request open',
  '35% verified',
  '35% verified | 20% in review',
  '35% verified | 25% in review',
  '35% verified | 45% in review',
  '55% verified',
  '55% verified | 25% in review',
  '80% verified',
  '80% verified | 20% in review',
  '100% verified',
  'Live transcript | captured 30s',
  'Mic failed | nothing recorded',
  'No voice key | nothing transcribed',
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
  '0% verified | Session running',
  '0% verified | Session idle',
  '0% verified | Request queued',
  '0% verified | Activity unconfirmed',
  '0% verified | Delivery unconfirmed',
  '35% verified | 45% in review | Activity unconfirmed',
  '0% verified | Sent to Factory',
  '85% verified | 15% in review | Sent to Factory',
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
  'Factory: idle',
  'Factory: starting',
  'Factory: building',
  'Factory: done',
  'Cursor: idle',
  'Cursor: starting',
  'Cursor: building',
  'Cursor: done',
  'Cursor: stopped',
  'Factory: building | watch only',
  'Factory: watching | watch only',
  'Cursor: building | watch only',
  'Cursor: stopped | watch only',
  'Factory: status unknown, retrying | watch only',
  'Cursor: status unknown, retrying | watch only',
  // Home titles when the cloud list is not current (one line in the 440px title)
  'Projects | as of 59m ago',
  'Projects | cloud builds unreachable',
  // Declined-gate card and the runtime boot-failure card (worst composed cases)
  'Declined | nothing started',
  'Runtime | not started',
  // Autonomy applied (voice) + question option list statuses
  'Autonomy | applied',
  // Ask and X notice statuses (local cards)
  'Answer needed',
  'X request held',
  'X request running',
  // Native delivery status lines (only Merged is delivered).
  'PR open · checks 10/10',
  'PR open · checks pending',
  'Branch pushed · no PR yet',
  'Merged',
  'Not merged: checks failed',
  'Not merged: no checks configured',
  'Delivery held: Base branch moved',
]
const ACTIONS = [
  // Redesign actions (HudIdle, HudRun, HudDone; HudListen's are below).
  'Builds', 'Needs you', 'Message', 'Read summary', 'Next idea', 'Evidence',
  'Set up my factory', 'Continue', 'Choose a goal', 'Start planning', 'Change',
  'Start', 'Milestones', 'Talk', 'Send message', 'Open Factory', 'Resolve', 'Seen in Factory', 'Stop waiting', 'Check session', 'Pause', 'Resume', 'Use it', 'Explain', 'Back', 'Status',
  'Show evidence', 'Restart', 'Retry', 'Cancel', 'Confirm',
  'Start build', 'Review build', 'Builds', 'Open on phone', 'Open PR', 'Connect', 'Pick on phone', 'New repo', 'History',
]
const LIST_ITEMS = [
  'Talk to Spriite',
  'Say what we should build.',
  'No voice key | add one on your phone',
  'Voice: ElevenLabs | double-tap cancels',
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
  // Evidence rows the live engine composes from provider ids and branches.
  'Lead session 00000000',
  'Job: session 00000000',
  'Job: agent 00000000',
  'Job: branch cursor/add-the-empty-state',
  // Question option list (options are fitted by the engine; this is the
  // fixed last row every option list carries: HudAsk "Say something else")
  'Say something else',
  'After they verify',
  'Right away',
  // Projects home (list title, rows, new-build entry)
  'Projects',
  'New build',
  'Add the empty-state screen | building',
  'Deliver the empty-state screen | opening PR',
  'Deliver the empty-state screen | paused',
  'Add the empty-state screen and verify it... | in review',
  // Cloud builds (merged home rows; the engine truncates the title until
  // the row fits one line, so these are the fitted worst cases)
  'Fix the login flake | Factory: idle 23h',
  'Add the empty-state screen and... | Factory: starting',
  'Add the empty-state screen... | Factory: stopped 23h',
  'Add the empty-state screen and... | Cursor: idle 30d',
  'Add the empty-state screen and... | Cursor: building',
  'Add the empty-state screen and verify... | Cursor: done',
  // Native delivery evidence rows and home words.
  'Usage: available tomorrow',
  'Usage: 12345 credits',
  'Usage unavailable',
  'PR: https://github.com/owner/repo/pull/7',
  'Deliver the empty-state screen | PR open',
  'Deliver the empty-state screen | not merged',
  'Deliver the empty-state screen | delivery held',
  'Deliver the empty-state screen | merged',
]
// HudListen and HudAsk lines.
const LISTEN_LABELS = ['You said', 'Say what we should build.', 'Say your message.']
const TRANSCRIPTS = [
  '“add a guest checkout to the shop site”',
  '“...add a guest checkout to the shop site and make sure the payment step retries when the card is declined, then email me”',
]
const QUESTIONS = ['When should the welcome email go out?']
const FOOTERS = ['Swipe to choose · tap to send · also on your phone', 'Swipe to choose · tap to open']
const LISTEN_ACTIONS = ['Tap to send', 'Double-tap to cancel']
const MULTI = [
  'Say what we should build.\nTap to finish.',
  'Listening. Pause when done,\nor tap to finish.',
  'The glasses are disconnected.\nSpriite will wait for them.',
]
// Selection page titles (the engine's fixed titles; the question list's title
// is fitted by the engine to this same 440x2 budget).
const SELECTION_TITLES = [
  'What should we build?',
  'Plan | 5 milestones',
  'Evidence | checks passed',
  'Projects',
  'New build',
  'Plan | milestones',
  'Evidence | live run',
  'Projects | as of 59m ago',
  'Projects | cloud builds unreachable',
]

function wrappedLines(text, maxWidth) {
  // Counted exactly like the firmware renders it: '\n' breaks a line and a
  // blank line still occupies a rendered line (same rule as the scene
  // validator's fitsWrappedLines, so the tool and the app cannot disagree).
  if (!text) return 0
  return measureTextWrap(text, maxWidth).lineCount
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
for (const t of SELECTION_TITLES) check('selectionTitle', t, U.selectionTitle)
for (const t of CONTEXT_DETAILS) check('contextDetail', t, U.contextDetail)
for (const t of LISTEN_LABELS) check('listenLabel', t, U.listenLabel)
for (const t of TRANSCRIPTS) check('transcript', t, U.transcript)
for (const t of QUESTIONS) check('question', t, U.question)
for (const t of FOOTERS) check('footer', t, U.footer)
for (const t of LISTEN_ACTIONS) check('action', t, { w: 528, lines: 1 })
for (const [label, detail] of CONTEXT_LINES) {
  const w = getTextWidth(label) + 10 + getTextWidth(detail)
  if (w > U.context.w) failures.push(`context line ${w}px > ${U.context.w}px :: ${JSON.stringify(`${label} · ${detail}`)}`)
}

// The chat-history page (its title, footer, and empty body are fixed strings).
check('historyTitle', 'Chat history', U.historyTitle)
check('historyFooter', 'Chat 12/120 - press to close', U.historyFooter)
check(
  'historyBody',
  'Nothing said yet. Say a goal, or answer a question, and the conversation lands here.',
  U.historyBody,
)

// Glyph coverage: any codepoint the font model reports as zero-width.
// ('\n' is an intentional line break handled by the renderer, not a glyph.)
const all = [
  ...UTTERANCES, ...STATUSES, ...CONTEXTS, ...ACTIONS, ...LIST_ITEMS, ...MULTI, ...SELECTION_TITLES,
  ...CONTEXT_DETAILS, ...LISTEN_LABELS, ...TRANSCRIPTS, ...QUESTIONS, ...FOOTERS, ...LISTEN_ACTIONS, '‹›',
].join('')
const missing = [...new Set([...all])].filter((ch) => ch !== '\n' && getAdvW(ch.codePointAt(0)) <= 0)
if (missing.length > 0) failures.push(`glyphs reported missing by the font model: ${missing.join(' ')}`)

// Joined action lines (renderer composition).
const lines = [
  '> Set up my factory',
  '> Continue   Choose a goal',
  '> Review build   Send message   History',
  '> Read   Open on phone   Builds',
  '> Start planning   Change',
  '> Start   Milestones',
  '> Talk   Pause',
  '> Explain   Talk',
  '> Use it   Explain',
  '> Show evidence   Restart',
  '> Resume   Talk',
  '> Retry   Cancel',
  '> Talk   Back',
  '> Confirm   Cancel',
  '> Start build   Milestones',
  '> Talk   Restart',
  '> Confirm   Talk',
  '> Pick on phone   Talk',
  '> Explain   Talk   Back',
  // Real-engine cards with the new affordances (retry, new repository).
  '> Pick on phone   New repo   Talk',
  '> Start planning   New repo   Change',
  '> Retry   Talk   Restart',
  '> Connect   Retry   Talk',
  '> Connect   Talk',
  '> Start build   Talk',
  // A lead-reply card offers reading the conversation.
  '> History   Back',
  '> History',
]
for (const t of lines) {
  const w = getTextWidth(t)
  if (w > 528) failures.push(`actions line ${w}px > 528px :: ${JSON.stringify(t)}`)
}

// Redesigned actions rows (src/render/layout.ts actionRow): the bordered box
// is the widest label + 24 (11 px inner padding each side + border), then
// 22 px gaps to each dimmed label, with ‹ › hints on the Run card.
const ROW_SETS = [
  [['Talk', 'Builds', 'Needs you'], false],
  [['Tap to send', 'Double-tap to cancel'], false],
  [['Pause', 'Message', 'Milestones'], true],
  [['Read summary', 'Next idea', 'Evidence'], false],
  [['Show evidence', 'Restart'], false],
  [['Review build', 'Send message', 'History'], false],
  [['Read', 'Open on phone', 'Builds'], false],
  [['Explain', 'Send message', 'Back'], true],
  [['Retry', 'Talk', 'Restart'], false],
  [['Pick on phone', 'New repo', 'Talk'], false],
  [['Start planning', 'New repo', 'Change'], false],
  [['Open Factory', 'Explain', 'Back'], true],
  [['Seen in Factory', 'Stop waiting', 'Back'], false],
]
const gapW = 22
for (const [labels, hints] of ROW_SETS) {
  const widest = Math.max(...labels.map((l) => getTextWidth(l)))
  // The widest focus is the worst case: the box carries the widest label,
  // the rest carries the others.
  for (let f = 0; f < labels.length; f++) {
    const others = labels.filter((_, i) => i !== f)
    const w = (hints ? getTextWidth('‹') + gapW : 0) + widest + 24 + gapW +
      others.reduce((n, l) => n + getTextWidth(l), 0) + gapW * (others.length - 1) +
      (hints ? gapW + getTextWidth('›') : 0)
    if (w > 528) failures.push(`actions row ${w}px > 528px :: ${JSON.stringify(labels)} focus ${f}`)
  }
}

if (failures.length > 0) {
  console.error(`COPY BUDGET FAILURES (${failures.length}):`)
  for (const f of failures) console.error(' -', f)
  process.exit(1)
}
console.log('Copy budgets OK: all strings fit; no missing glyphs reported.')
