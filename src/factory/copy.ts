/**
 * All HUD copy in one place (spec §6.2 budgets: one thought per screen,
 * 12-24 words, concrete 1-2 word labels, no code, percentages only in status).
 */
import type { SceneAction } from '../scenes/types'

const A = (id: string, label: string, kind: SceneAction['kind']): SceneAction => ({
  id,
  label,
  kind,
})

/** "1 build", "3 builds": a count with its noun. */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** The sections a scoped chat build appends to the owner's request (build-intent.ts, real.ts prompts). */
const SCOPE_SECTIONS = /\s*\b(?:Owner clarifications(?: \([^)]*\))?:|Previous planning context, quoted for reference only)[\s\S]*$/i

/** Leading request verbs a build title drops ('Add a checkout flow' -> 'checkout flow'). */
const TITLE_VERBS = /^(?:please\s+)?(?:add|build|make|create|fix|implement|write|ship|design|set up|start|update|improve|refactor|deliver)\s+/i
const TITLE_ARTICLE = /^(?:a|an|the|some|my|our)\s+/i
const TITLE_TAIL = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'in', 'on', 'with', 'and', 'or', 'from', 'into', 'at', 'by'])

/**
 * A build's short title for the HUD context line (HudRun: 'CHECKOUT FLOW'):
 * the goal without its request verb and article, its first words, without
 * a dangling preposition or trailing punctuation. The renderer uppercases it
 * and fits it beside the detail.
 */
export function buildTitle(goal: string, maxWords = 4): string {
  // The owner's request is the goal's first line. A scoped chat build
  // appends its scope below it ('Owner clarifications:', quoted planning
  // context); those sections never name the build.
  // The runtime keeps a command on one line, so the sections are cut by
  // their own headings too (build-intent.ts writes them).
  const first = String(goal ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  const raw = first.replace(SCOPE_SECTIONS, '').replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  // A link is not a title: drop it ('Spin this up: https://…' -> 'Spin this
  // up'); a goal that is only a link is named by its last path segment.
  const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi
  const text = raw.replace(URL_RE, ' ').replace(/\s+/g, ' ').replace(/[\s:;,.-]+$/, '').trim()
  const flat = text || linkName(raw)
  if (!flat) return ''
  const stripped = flat.replace(TITLE_VERBS, '').replace(TITLE_ARTICLE, '') || flat
  // The thing being built, not the rest of the request ('the empty-state
  // screen and have another agent check it' -> 'empty-state screen').
  const core = stripped.split(/\s+(?:and|then)\s+|\s+-\s+|[,;]\s*/i)[0]?.trim() || stripped
  const words = core.split(' ').filter(Boolean).slice(0, maxWords)
  while (words.length > 1 && TITLE_TAIL.has(words[words.length - 1].toLowerCase().replace(/[.,;:!?]+$/, ''))) words.pop()
  return words.join(' ').replace(/[.,;:!?]+$/, '')
}

/** A link's readable name: its last path segment, else its host ('reverse-engineer' -> 'reverse engineer'). */
function linkName(text: string): string {
  const link = /\b(?:https?:\/\/|www\.)\S+/i.exec(text)?.[0] ?? ''
  try {
    const url = new URL(link.startsWith('www.') ? `https://${link}` : link)
    const segment = url.pathname.split('/').filter(Boolean).at(-1) ?? ''
    return decodeURIComponent(segment || url.hostname.replace(/^www\./, '')).replace(/[-_]+/g, ' ').replace(/\.[a-z0-9]+$/i, '').trim()
  } catch {
    return ''
  }
}

/** Sentence-case a title for running text ('checkout flow' -> 'Checkout flow'). */
export function sentenceTitle(title: string): string {
  const t = String(title ?? '').trim()
  return t ? t[0].toUpperCase() + t.slice(1) : t
}

/**
 * A Spriite build's name on lists and headers (Home, Builds, Mission:
 * 'Checkout flow'): the HUD title in sentence case, never the raw goal.
 */
export function buildName(goal: string): string {
  return sentenceTitle(buildTitle(goal)) || String(goal ?? '').replace(/\s+/g, ' ').trim()
}

export const COPY = {
  /**
   * Glasses HUD copy from the redesign boards (docs/design/redesign/Hud*.dc.html).
   * Context labels are uppercase as drawn; details keep their own case.
   */
  hud: {
    // HudIdle
    idleTitle: 'Ready when you are.',
    idleHint: 'Hold to talk, or swipe for builds.',
    idleActions: [A('talk', 'Talk', 'local_capture'), A('builds', 'Builds', 'read_only'), A('needs_you', 'Needs you', 'command')],
    /** Idle without anything waiting on the owner: no Needs you action. */
    idleActionsCalm: [A('talk', 'Talk', 'local_capture'), A('builds', 'Builds', 'read_only')],
    /** Context detail: '3 builds · 1 needs you' (the second half only when one does). */
    buildsDetail: (builds: number, needing: number): string =>
      [count(builds, 'build', 'builds'), needing > 0 ? `${needing} ${needing === 1 ? 'needs' : 'need'} you` : '']
        .filter(Boolean).join(' · '),
    // HudAsk
    leadAsks: 'LEAD ASKS',
    workerAsks: 'WORKER ASKS',
    spriiteAsks: 'SPRIITE ASKS',
    sayElse: 'Say something else',
    askFooter: 'Swipe to choose · tap to send · also on your phone',
    /** Footer on the other glasses lists (builds, milestones, evidence). */
    listFooter: 'Swipe to choose · tap to open',
    /** Footer on lists whose rows open nothing (milestones, evidence): a tap closes. */
    readFooter: 'Swipe to scroll · tap to close',
    // HudRun
    runStatus: (checks: number, agents: number): string =>
      `${count(checks, 'check', 'checks')} passed · ${count(agents, 'agent', 'agents')}`,
    runActions: [A('pause', 'Pause', 'command'), A('send_message', 'Message', 'local_capture'), A('milestones', 'Milestones', 'read_only')],
    /**
     * Context detail on a build card: 'BUILDING · 2 OF 4'. `done` is the
     * number of milestones done (HudRun pairs 'BUILDING · 2 OF 4' with
     * "Milestones: 2 done, 1 in review, 1 to go"); in review does not count.
     */
    phaseDetail: (word: string, done: number, of: number): string =>
      of > 0 ? `${word} · ${Math.min(Math.max(done, 0), of)} OF ${of}` : word,
    phaseWords: {
      planning: 'PLANNING',
      building: 'BUILDING',
      review: 'CHECKING',
      repair: 'FIXING',
      pr: 'OPENING PR',
      paused: 'PAUSED',
      decision: 'NEEDS YOU',
      final: 'DONE',
    } as Record<string, string>,
    // HudDone
    done: (title: string): string => `${sentenceTitle(title) || 'Your build'} is ready for you to review.`,
    doneStatus: 'All checks passed · pull request open',
    doneDetail: 'DONE',
    doneActions: [A('chat', 'Read summary', 'read_only'), A('restart', 'Next idea', 'command'), A('show_evidence', 'Evidence', 'read_only')],
  },
  micError: {
    utterance: 'The microphone did not start. Nothing was recorded.',
    status: 'Mic failed · nothing recorded',
    actions: [A('retry_talk', 'Retry', 'local_capture'), A('cancel_talk', 'Cancel', 'command')],
  },
  transcribing: {
    utterance: 'Transcribing what you said...',
    status: 'No voice key · nothing transcribed',
    actions: [] as SceneAction[],
  },
  connectionLost: {
    utterance: 'The glasses are disconnected.\nSpriite will wait for them.',
    status: 'Waiting for glasses',
    actions: [] as SceneAction[],
  },
  transcribingLive: {
    utterance: 'Finishing what you said...',
    status: 'Voice · ElevenLabs',
    actions: [] as SceneAction[],
  },
  voice: {
    heardPrefix: 'I heard: ',
    cantActYet: 'I cannot act on that yet.',
    nothingHeard: 'I did not catch anything. Nothing was sent.',
    nothingRunning: 'Nothing is running yet.',
    nothingToPause: 'Nothing is running to pause.',
    nothingToResume: 'Nothing is paused.',
    // Controls on a build you only watch: Spriite does not run it.
    watchNoControl: 'Spriite only watches this build, so it cannot resume or restart it. Back leaves the watch.',
    watchNoPause: 'Spriite only watches this build and cannot pause it. Back leaves the watch.',
    watchOnlyHeard: 'This build cannot take messages; Spriite only watches it. Start a new build with what you said?',
    watchOnlyHeardStatus: 'Watch only · nothing sent',
    noChoice: 'There is no choice waiting.',
    nothingToExplain: 'There is nothing to explain yet.',
    notSaved: 'That request was not saved, so nothing started. Try again.',
    finishedRecord: 'That build already finished. Its record is kept.',
    confirmUseIt: 'Confirm? Spriite sends your yes to this build.',
    confirmRestart: 'Restart? Progress resets and you return home.',
    // The durable runtime cancels the mission but keeps its record, so the
    // plain "progress resets" wording would understate what is preserved.
    confirmRestartDurable: 'Restart? This build stops; its record stays on your home.',
    heardStatus: 'Voice · nothing done',
    confirmStatus: 'Voice · confirm to act',
    heardActions: [A('talk_again', 'Talk', 'local_capture'), A('cancel_talk', 'Back', 'command')],
    confirmActions: [A('voice_confirm', 'Confirm', 'command'), A('voice_cancel', 'Cancel', 'command')],
    errors: {
      auth: 'ElevenLabs rejected your voice key. Check it on your phone.',
      quota: 'ElevenLabs hit a usage or rate limit. Try again soon.',
      network: 'I could not reach the voice service. Nothing was sent.',
      service: 'The voice service failed. Nothing was sent.',
    },
    errorStatus: 'Voice failed · nothing sent',
    errorActions: [A('retry_talk', 'Retry', 'local_capture'), A('cancel_talk', 'Cancel', 'command')],
  },
  /** Real orchestrator copy (connected accounts; every card is live). */
  real: {
    context: 'SPRIITE',
    // Home: projects list first; connect prompts only when a piece is missing.
    needFactory: 'Connect Factory on your phone to run builds.',
    needFactoryStatus: 'Connect Factory',
    needFactoryActions: [A('connect_factory', 'Connect', 'command'), A('talk', 'Talk', 'local_capture')],
    needRepo: 'Pick a repository on your phone, or start this build in a new one.',
    needRepoStatus: 'Pick repository',
    needRepoActions: [A('connect_repo', 'Pick on phone', 'command'), A('new_repo', 'New repo', 'command'), A('talk', 'Talk', 'local_capture')],
    needComputer: 'Factory needs a computer to run builds. Open the Factory app or run droid on a computer, or add a cloud computer, then try again.',
    needComputerStatus: 'Connect computer',
    needComputerActions: [A('connect_factory', 'Connect', 'command'), A('retry_start', 'Retry', 'command'), A('talk', 'Talk', 'local_capture')],
    // Only when neither the paired host nor a phone token provides GitHub
    // (HOST-GITHUB-PLAN selection case 3).
    needGithub: 'Spriite needs GitHub to create the repository. Pair with your computer (it uses its GitHub sign-in), or add a GitHub token in Settings.',
    needGithubStatus: 'Connect GitHub',
    needGithubActions: [A('connect_github', 'Connect', 'command'), A('talk', 'Talk', 'local_capture')],
    creatingRepo: 'Creating a new repository on GitHub, then planning the build.',
    creatingRepoStatus: 'GitHub · creating',
    // A New repo tap that cannot run says why: the press shadow alone read as
    // the button being dead (the owner's report).
    newRepoNoGoal: 'Say what to build first, then tap New repo.',
    newRepoLive: 'This build already has its repository. Start a new build from the home to use a new one.',
    newRepoBusy: 'Spriite is finishing the last step. Tap New repo again in a moment.',
    newRepoStill: (name: string): string => `Still creating ${name} on GitHub. Planning starts when it is ready.`,
    newRepoBlockedStatus: 'New repo · not started',
    // The durable runtime saves a request before it starts anything.
    savingRequest: 'Saving your request so it survives a relaunch. The build starts next.',
    savingRequestStatus: 'Saving · one moment',
    // A mission action the runtime gated: the card says why it did not run.
    actionStopping: 'This build is stopping, so nothing new starts on it.',
    actionPausing: 'This build is already pausing.',
    actionGone: 'That build is no longer running here.',
    actionNotRunStatus: 'Not started',
    needVoiceActions: [A('connect_voice', 'Connect', 'command'), A('talk', 'Talk', 'local_capture')],
    projectsTitle: 'Builds',
    newBuildItem: 'New build',
    statusWords: {
      planning: 'planning',
      building: 'building',
      review: 'in review',
      repair: 'fixing',
      pr: 'opening PR',
      final: 'done',
      fault: 'stopped',
      // A confirmed pause is the owner's own act: the row says the control
      // state, not the phase the mission froze in (spec §7).
      paused: 'paused',
      // A mission blocked on the owner (a question, a repository, a credential)
      // reads as needing an answer, not as still planning (spec §16, §17).
      decision: 'needs you',
      ready: 'plan ready',
      // A held native intent the owner resolved on the phone: it never ran.
      promoted: 'approved as new job',
      dismissed: 'dismissed',
      // A completed native job's broker delivery; only merged is delivered.
      pr_open: 'PR open',
      merged: 'merged',
      not_merged: 'not merged',
      delivery_held: 'delivery held',
      unknown: 'activity unconfirmed',
      // Cloud rows (Factory sessions, Cursor agents) map onto the same words.
      // An idle session or agent has no turn running: it is not "waiting" on
      // anything, and a pending one is starting, not planning.
      idle: 'idle',
      pending: 'queued',
      running: 'building',
      ACTIVE: 'building',
      IDLE: 'idle',
      // Cursor run states (a watched cloud build).
      RUNNING: 'building',
      FINISHED: 'done',
      ERROR: 'stopped',
      CANCELLED: 'stopped',
      EXPIRED: 'stopped',
    } as Record<string, string>,
    // Cloud-row source tags (which account a build row comes from).
    factoryTag: 'Factory',
    cursorTag: 'Cursor',
    goalList: {
      title: 'What should we build?',
      items: ['Talk to Spriite'],
    },
    needsVoiceKey: 'To speak your goals, add an ElevenLabs key on your phone.',
    transcriptStatus: (sec: number): string => `Live transcript · captured ${sec}s`,
    transcriptActions: [A('start_planning', 'Start planning', 'command'), A('new_repo', 'New repo', 'command'), A('change_goal', 'Change', 'command')],
    planRunning: 'Factory reports this session is running. The completed plan has not arrived yet.',
    planIdle: 'Factory reports this session is idle. No plan arrived. Choose Continue or Send message.',
    /** The idle planning card when Continue cannot be offered: only Send message is named. */
    planIdleMessage: 'Factory reports this session is idle. No plan arrived. Send message to ask for it.',
    /** Your answer or message changed the plan: the Lead's revised plan is awaited. */
    planUpdating: 'The Lead is updating the plan with your answer. Start build comes back when it arrives.',
    planUnknown: 'No completed plan yet. Current Factory activity is unconfirmed.',
    sessionQueued: 'Factory has queued the request. It is not running yet.',
    sessionIdle: 'The session is idle. This step is unfinished. Continue sends a request to this chat.',
    sessionUnknown: 'A result is still awaited. Current session activity is unconfirmed.',
    activityStatus: {
      running: 'Session running',
      pending: 'Request queued',
      idle: 'Session idle',
      unknown: 'Activity unconfirmed',
    },
    planDraftingActions: [A('send_message', 'Send message', 'local_capture'), A('status', 'Status', 'read_only'), A('chat', 'History', 'read_only')],
    inactiveActions: [A('continue_session', 'Continue', 'command'), A('send_message', 'Send message', 'local_capture'), A('chat', 'History', 'read_only')],
    scopeAvailable: 'A plan is available for review. Review scope, then explicitly Start build.',
    scopeAvailableActions: [A('review_chat_build', 'Review build', 'read_only'), A('send_message', 'Send message', 'local_capture'), A('chat', 'History', 'read_only')],
    chatBuildReview: (repository: string) => `Build this scope in ${repository}? Review the full scope in History first.`,
    chatBuildReviewStatus: 'Execution needs your confirmation',
    chatBuildActions: [A('confirm_chat_build', 'Start build', 'command'), A('chat', 'History', 'read_only'), A('back', 'Cancel', 'command')],
    chatBuildAlreadyOwned: 'This build already has an execution controller. Open its status or question; nothing was sent.',
    chatBuildNoIdle: 'Wait for confirmed idle before starting execution from this chat. Nothing was sent.',
    chatBuildMissing: 'No complete goal, repository, and plan could be recovered. Open Factory or submit an exact new goal. Nothing was sent.',
    chatBuildReadFailed: 'Could not read the build scope. Nothing was sent and no build started. Open Factory or try again later.',
    chatBuildChanged: 'The chat activity or scope changed. Review it again before starting execution. No build started.',
    chatBuildVerifyFailed: 'Could not confirm the chat scope. Nothing was sent and no build started. Try again later.',
    chatBuildRuntimeRequired: 'This watched chat needs managed execution. Enable the durable runtime or submit an exact new goal. No build started.',
    continueMessage: 'Continue the current conversation from where it stopped, using the requested reply format. Keep the agreed scope and permissions. If blocked, tell me what you need.',
    messageNotSent: 'This session cannot take your message right now. Nothing was sent.',
    planRefresh: 'This saved plan needs a refresh before building. Tap Refresh plan to continue.',
    planRefreshStatus: 'Planning update needed',
    planRefreshActions: [A('retry', 'Refresh plan', 'command'), A('status', 'Status', 'read_only')],
    planReady: 'The plan is ready. No work is verified yet. Start build sends it to a worker.',
    planReadySplit: (n: number): string =>
      `The plan is ready for ${n} workers. No implementation is verified yet.`,
    planActions: [A('begin', 'Start build', 'command'), A('send_message', 'Send message', 'local_capture'), A('milestones', 'Milestones', 'read_only')],
    startDecision: 'Start the build? It uses Factory credits, and Cursor credits if connected.',
    building: 'The worker request was sent. No completed result has arrived yet.',
    workerQueued: 'The worker request is waiting to be sent. No work is verified yet.',
    workerActivity: 'Factory worker activity was observed. No completed result has arrived yet.',
    /** Status line of the card that confirms a steer reached the session. */
    steeredStatusNote: 'Sent to Factory',
    messageUnconfirmedStatus: 'Delivery unconfirmed',
    deliveryUnknown: 'Delivery is unconfirmed. I will check this chat, not resend. Read History or check it in Factory, then Resolve.',
    deliveryUnknownActions: [A('chat', 'History', 'read_only'), A('open_factory', 'Open Factory', 'read_only'), A('resolve_delivery', 'Resolve', 'read_only')],
    deliveryResolve: 'Seen this request in Factory? Mark only if checked. Stop waiting clears local queued requests; the original may still arrive.',
    deliveryResolveActions: [A('delivery_seen', 'Seen in Factory', 'read_only'), A('delivery_release', 'Stop waiting', 'read_only'), A('back', 'Back', 'command')],
    messageReadFailed: 'I could not check this chat before sending. Nothing was sent. Check History and try when the chat is readable.',
    messageReadFailedActions: [A('status', 'Status', 'read_only'), A('chat', 'History', 'read_only'), A('back', 'Back', 'command')],
    /** A lead reply card: read the whole conversation, or leave the card. */
    repliedActions: [A('chat', 'History', 'read_only'), A('back', 'Back', 'command')],
    /** Status line of a reply card: who actually spoke (Lead, Watched build). */
    repliedStatus: (who: string): string => `${who} replied`,
    buildingSplit: (n: number): string =>
      `Requests were sent to ${n} workers. Waiting for the remaining results.`,
    pushedForReview: 'The worker pushed a branch. Factory is reviewing the diff now.',
    reviewStatusNote: 'Factory reviewing',
    buildingStatusNote: 'Awaiting worker result',
    buildingStatusNoteSplit: (n: number): string => `${n} results awaited`,
    repairStatusNote: 'worker fixing',
    prStatusNote: 'worker opening PR',
    integrationStage: 'All jobs passed review. I asked one worker to merge the branches.',
    integrationStatusNote: 'merging branches',
    prAsk: 'The review passed. Open the pull request?',
    verified: 'The review passed. This step is verified.',
    verdictFail: 'The review failed. I sent the reasons back to the worker.',
    prStage: 'The review passed. I asked the worker to open the pull request.',
    prReady: 'The verified pull request is ready.',
    workerFailed: 'The worker stopped early. How should I proceed?',
    workerNoBranch: 'The worker finished without pushing a branch. How should I proceed?',
    workerNoPr: 'The worker finished without opening a pull request. How should I proceed?',
    paused: 'I paused the orchestrator. The worker keeps running in the background.',
    /** Paused before any worker started: nothing keeps running. */
    pausedNoWorker: 'I paused this build. Nothing else is running. Resume to carry on.',
    pausedActions: [A('resume', 'Resume', 'command'), A('talk', 'Talk', 'local_capture')],
    // HudRun: Pause, Message, Milestones.
    runningActions: [A('pause', 'Pause', 'command'), A('send_message', 'Message', 'local_capture'), A('milestones', 'Milestones', 'read_only')],
    // Watching a cloud build picked from the home list (not driven by us).
    attachActions: [A('explain', 'Explain', 'read_only'), A('send_message', 'Send message', 'local_capture'), A('back', 'Back', 'command')],
    // A watch-only build (Cursor, or a Factory session with no computer)
    // cannot take messages, so Talk is not offered at all.
    attachWatchOnlyActions: [A('explain', 'Explain', 'read_only'), A('back', 'Back', 'command')],
    factoryWatchOnlyActions: [A('open_factory', 'Open Factory', 'read_only'), A('explain', 'Explain', 'read_only'), A('back', 'Back', 'command')],
    factoryWatchOnlyHelp: 'Read this session here. To continue or send a message, open Factory on your phone.',
    nativeQuestionHelp: 'Factory needs its native popup. The exact phone link is ready. Use Builds to switch tasks. No answer was sent.',
    factoryWatchOnlyHelpActions: [A('open_factory', 'Open on phone', 'read_only'), A('chat', 'History', 'read_only'), A('show_builds', 'Builds', 'read_only')],
    attachWatching: 'watching',
    attachWatchOnly: 'watch only',
    /** Explain on a watched build: what it is, and what it last said. */
    attachExplain: (source: string, title: string, reply: string): string =>
      `${source} build: ${title}. ${reply ? `Latest: ${reply}` : 'No replies yet.'}`,
    /** Explain status line: status, freshness, and what the owner can do. */
    attachExplainStatus: (word: string, age: string, steerable: boolean): string =>
      [word, age ? `updated ${age} ago` : '', steerable ? 'Talk sends to it' : 'watch only'].filter(Boolean).join(' · '),
    // Pause on a watched build is an interrupt of someone else's run: asked
    // first, never implied by a voice word alone.
    watchPauseAsk: 'Stop this build\'s current turn? It is a build from your account, not one Spriite runs.',
    watchPauseStatus: 'Pause · confirm first',
    watchPauseActions: [A('confirm_watch_pause', 'Stop turn', 'command'), A('back', 'Cancel', 'command')],
    watchPaused: 'I asked Factory to stop this build\'s current turn. Talk to it to say what to do next.',
    watchPausedStatus: 'Interrupt sent',
    // Status checks for the watched build keep failing: the last known
    // status is no longer current, so it is not shown as if it were.
    attachUnknown: 'status unknown, retrying',
    // Home title when the cloud list refresh fails (rows are as of `age`).
    projectsStale: (age: string): string => `Builds · as of ${age}`,
    projectsCloudDown: 'Builds · cloud unreachable',
    attachSendFailed: 'That session could not take your message. Its activity has not been confirmed.',
    beatActions: [A('explain', 'Explain', 'read_only'), A('talk', 'Talk', 'local_capture')],
    // A fault card always offers Retry: it clears the failure and re-runs the
    // exact step that failed (poll faults just resume polling), so a fixed
    // key or a back-online computer continues the live mission.
    failActions: [A('retry', 'Retry', 'command'), A('talk', 'Talk', 'local_capture'), A('restart', 'Restart', 'command')],
    /** The same card on a paused build: Resume first (a retry would only be held). */
    failPausedActions: [A('resume', 'Resume', 'command'), A('talk', 'Talk', 'local_capture'), A('restart', 'Restart', 'command')],
    // A worker stopped without delivering: no retry exists (its run is gone),
    // so the card offers steering the lead or starting over.
    stoppedActions: [A('talk', 'Talk', 'local_capture'), A('restart', 'Restart', 'command')],
    // HudDone: Read summary, Next idea, Evidence.
    finalActions: [A('chat', 'Read summary', 'read_only'), A('restart', 'Next idea', 'command'), A('show_evidence', 'Evidence', 'read_only')],
    decisionActions: [A('use_it', 'Confirm', 'command'), A('talk', 'Talk', 'local_capture')],
    /** Last row of a question's option list: any answer, spoken. */
    speakAnswer: 'Say something else',
    // The gate's own button must confirm the gate (use_it does); an action
    // id that re-arms the gate would make the card unconfirmable on glasses.
    gateActions: [A('use_it', 'Start build', 'command'), A('talk', 'Talk', 'local_capture')],
    prGateActions: [A('open_pr', 'Open PR', 'command'), A('talk', 'Talk', 'local_capture')],
    // A refused gate ends the mission: these cards say what that means (the
    // build never started, nothing was spent) instead of leaving a plan card
    // whose start was declined (the owner's report).
    startDeclined: 'You declined the build. It did not start, and no credits were spent.',
    prDeclined: 'You declined the pull request. The build stops; its record is kept.',
    declineStatus: 'Declined · nothing started',
    declineActions: [A('talk', 'Talk', 'local_capture')],
    // The durable runtime failed to boot: honest state, never a silent
    // fallback that reads as a working run.
    runtimeBootFailed: 'The durable runtime did not start. Builds still run, but none will survive a relaunch.',
    runtimeBootFailedStatus: 'Runtime · not started',
    planDetailTitle: (n: number): string => (n > 0 ? `Plan · ${count(n, 'milestone', 'milestones')}` : 'Plan · milestones'),
    plannedWord: 'planned',
    noMilestones: 'No milestones yet',
    /** Evidence rows pointing at the card's own actions (HudDone: Read summary). */
    evidenceSummaryRow: 'Lead summary · see Read summary',
    evidenceReplyRow: 'Lead reply · see History',
    evidenceTitle: 'Evidence · live run',
    statusAnswers: {
      plan: 'The plan is still awaited. That does not confirm active work.',
      building: 'A worker result is still awaited. Sent does not mean completed.',
      review: 'Factory is reviewing the change.',
      repair: 'The worker is fixing the review findings.',
      pr: 'The worker is opening the pull request.',
      final: 'The verified pull request is ready.',
      attach: 'I am watching a build from your account.',
    } as Record<string, string>,
    errors: {
      timeout: 'The Factory request timed out. The session may still be active. Check its chat before retrying.',
      auth: 'One of your accounts rejected its key. Check your keys on the phone.',
      forbidden: 'Factory sessions are not enabled on this account yet.',
      billing: 'Your Factory account needs billing or credits. Nothing was changed.',
      quota: 'A service hit a usage or rate limit. Nothing was changed.',
      network: 'A service was unreachable. Nothing was changed.',
      offline: 'Your computer is offline. Open the Factory app on it and turn on Remote Access, then retry.',
      permission: 'The GitHub token is missing permission for that. Nothing was changed.',
      exists: 'That repository name is taken. Try again with a new name.',
      // The runtime's own refusals (the durable companion): not provider faults.
      capacity: 'All worker slots are busy. Your build waits in line.',
      policy: 'Your policy settings stopped this action. Check them on the phone.',
      paused: 'This step is paused. Resume to continue it.',
      storage: 'The mission log could not be saved. Nothing was sent.',
      terminal: 'This mission has ended. Nothing was started.',
      service: 'A service failed. Nothing was changed.',
    },
    errorStatus: 'Service failed · nothing changed',
    offlineStatus: 'Computer offline · check Factory app',
  },
  listening: {
    // HudListen: 'You said' over the live transcript in curly quotes.
    heardLabel: 'You said',
    /** Before any words arrive: the prompt line, and an empty transcript. */
    prompt: 'Say what we should build.',
    promptMessage: 'Say your message.',
    quote: (text: string): string => `“${text}”`,
    actions: ['Tap to send', 'Double-tap to cancel'] as readonly string[],
    // Legacy strings (older surfaces and the copy budget list).
    hint: 'Say what we should build.\nTap to finish.',
    hintLive: 'Listening. Pause when done,\nor tap to finish.',
    note: 'No voice key · add one on your phone',
    noteLive: 'Voice: ElevenLabs · double-tap cancels',
    poseNote: 'NO VOICE KEY',
    contextLive: 'LISTENING',
  },
}
