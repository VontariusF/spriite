/**
 * All demo copy in one place (spec §6.2 budgets: one thought per screen,
 * 12-24 words, concrete 1-2 word labels, no code, percentages only in status).
 */
import type { SceneAction } from '../scenes/types'

const A = (id: string, label: string, kind: SceneAction['kind']): SceneAction => ({
  id,
  label,
  kind,
})

/** The scripted demo goal (spec §17.3 first real demonstration, step 3). */
export const DEMO_GOAL = 'Add the empty-state screen and have another agent check it.'

export type UnderReviewSource = 'ui' | 'verify' | 'pr'
export type ExplainSource = 'under_review' | 'repair' | 'accepted' | 'regression'

export const COPY = {
  contextSprite: 'SPRIITE (DEMO)',
  contextProduct: 'FUTARCHISTS (DEMO)',
  meet: {
    utterance: 'Hi. What should we build?',
    actions: [A('setup', 'Set up my factory', 'command')],
  },
  setupNotice: {
    utterance: 'This build runs a simulated factory. Every step and number is labeled demo.',
    actions: [A('continue', 'Continue', 'command')],
  },
  setupConnections: {
    utterance: 'Demo connections are ready. GitHub, Cursor, and Factory are simulated here.',
    actions: [A('choose_goal', 'Choose a goal', 'command')],
  },
  goalList: {
    title: 'What should we build?',
    items: ['Talk to Spriite', 'Empty-state screen (demo)'],
  },
  plan: {
    utterance: 'Cursor leads, Factory builds, and I check each step.',
    statusNote: '2 steps done earlier',
    actions: [A('start', 'Start', 'command'), A('milestones', 'Milestones', 'read_only')],
  },
  planDetail: {
    title: 'Plan | 5 milestones',
    items: [
      'Contracts 10 | done',
      'Fixtures 25 | done',
      'Empty-state screen 20',
      'Verification 25',
      'Verified PR 20',
    ],
  },
  running: {
    utterance: 'The build is moving. Two steps passed earlier today.',
    actions: [A('talk', 'Talk', 'local_capture'), A('pause', 'Pause', 'command')],
  },
  underReview: (src: UnderReviewSource): string =>
    src === 'ui'
      ? 'The agent finished this step. I am checking it.'
      : src === 'verify'
        ? 'The verification run finished. I am checking it.'
        : 'The pull request is in. I am checking it.',
  repair: {
    utterance: 'The empty state failed one check. I sent it back for a fix.',
    actions: [A('explain', 'Explain', 'read_only'), A('talk', 'Talk', 'local_capture')],
  },
  accepted: (src: UnderReviewSource): string =>
    src === 'ui'
      ? 'The screen passed my checks.'
      : 'The verification passed my checks.',
  regression: {
    utterance: 'A later change broke one check. It is being fixed again.',
    actions: [A('explain', 'Explain', 'read_only'), A('talk', 'Talk', 'local_capture')],
  },
  decision: {
    utterance: 'Historical data is incomplete. Use the verified period?',
    statusNote: '1 choice needed',
    actions: [A('use_it', 'Use it', 'command'), A('explain', 'Explain', 'read_only')],
  },
  decisionDetail: {
    utterance: 'The feed has gaps before October. I can only verify the recent period.',
    actions: [A('use_it', 'Use it', 'command'), A('back', 'Back', 'command')],
  },
  switching: {
    utterance: 'Factory will lead from here. The workers can continue.',
    actions: [A('talk', 'Talk', 'local_capture')],
  },
  final: {
    utterance: 'The verified PR is ready.',
    actions: [
      A('show_evidence', 'Show evidence', 'read_only'),
      A('restart', 'Restart demo', 'command'),
    ],
  },
  evidence: {
    title: 'Evidence | checks passed',
    items: [
      '● Empty results render',
      '● Failed requests retry',
      '● Layout bounds hold',
      '● Engine fixtures green',
      '● PR checks passed',
    ],
  },
  paused: {
    utterance: 'New work is paused. One agent is finishing its step.',
    actions: [A('resume', 'Resume', 'command'), A('talk', 'Talk', 'local_capture')],
  },
  statusAnswer: {
    moving: 'Everything is on track.',
    choice: 'I still need one choice.',
    done: 'The verified PR is ready.',
  },
  explain: {
    under_review: 'I check empty results, failed requests, and layout bounds.',
    repair: 'Empty results render, but failed requests skip the retry path.',
    accepted: 'Empty results and failed requests both behave correctly.',
    regression: 'The screen check broke again during verification.',
  } as Record<ExplainSource, string>,
  micError: {
    utterance: 'The microphone did not start. Nothing was recorded.',
    status: 'Mic failed | demo',
    actions: [A('retry_talk', 'Retry', 'local_capture'), A('cancel_talk', 'Cancel', 'command')],
  },
  transcribing: {
    utterance: 'Transcribing what you said...',
    status: 'Demo | scripted transcript',
    actions: [] as SceneAction[],
  },
  connectionLost: {
    utterance: 'The glasses are disconnected.\nSpriite will wait for them.',
    status: 'Waiting for glasses',
    actions: [] as SceneAction[],
  },
  transcribingLive: {
    utterance: 'Finishing what you said...',
    status: 'Voice | ElevenLabs',
    actions: [] as SceneAction[],
  },
  voice: {
    heardPrefix: 'I heard: ',
    cantActYet: 'I cannot act on that yet.',
    nothingHeard: 'I did not catch anything. Nothing was sent.',
    nothingRunning: 'Nothing is running yet.',
    nothingToPause: 'Nothing is running to pause.',
    nothingToResume: 'Nothing is paused.',
    noChoice: 'There is no choice waiting.',
    nothingToExplain: 'There is nothing to explain yet.',
    alreadyDemo: 'The demo is already running.',
    confirmUseIt: 'Use the verified period?',
    confirmRestart: 'Restart? Progress resets and you return home.',
    heardStatus: 'Voice | nothing done',
    confirmStatus: 'Voice | confirm to act',
    heardActions: [A('talk_again', 'Talk', 'local_capture'), A('cancel_talk', 'Back', 'command')],
    confirmActions: [A('voice_confirm', 'Confirm', 'command'), A('voice_cancel', 'Cancel', 'command')],
    errors: {
      auth: 'ElevenLabs rejected your voice key. Check it on your phone.',
      quota: 'ElevenLabs hit a usage or rate limit. Try again soon.',
      network: 'I could not reach the voice service. Nothing was sent.',
      service: 'The voice service failed. Nothing was sent.',
    },
    errorStatus: 'Voice failed | nothing sent',
    errorActions: [A('retry_talk', 'Retry', 'local_capture'), A('cancel_talk', 'Cancel', 'command')],
  },
  /** Real orchestrator copy (connected accounts; every card is live). */
  real: {
    context: 'SPRIITE',
    // Home: projects list first; connect prompts only when a piece is missing.
    needFactory: 'Connect Factory on your phone to run real builds, or say "run the demo" to watch a simulated one.',
    needFactoryStatus: 'Connect Factory',
    needFactoryActions: [A('connect_factory', 'Connect', 'command'), A('demo', 'Demo', 'command'), A('talk', 'Talk', 'local_capture')],
    needRepo: 'Pick a repository on your phone, then tell me what to build.',
    needRepoStatus: 'Pick repository',
    needRepoActions: [A('connect_repo', 'Pick on phone', 'command'), A('talk', 'Talk', 'local_capture')],
    needComputer: 'Factory needs a computer to run builds. Open the Factory app on your Mac or add a cloud computer, then try again.',
    needComputerStatus: 'Connect computer',
    needComputerActions: [A('connect_factory', 'Connect', 'command'), A('talk', 'Talk', 'local_capture')],
    needVoiceActions: [A('connect_voice', 'Connect', 'command'), A('talk', 'Talk', 'local_capture')],
    projectsTitle: 'Projects',
    newBuildItem: 'New build',
    statusWords: {
      planning: 'planning',
      building: 'building',
      review: 'in review',
      repair: 'fixing',
      pr: 'opening PR',
      final: 'done',
      fault: 'stopped',
      // Cloud rows (Factory sessions, Cursor agents) map onto the same words.
      idle: 'waiting',
      pending: 'planning',
      running: 'building',
      ACTIVE: 'building',
      IDLE: 'waiting',
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
    transcriptStatus: (sec: number): string => `Live transcript | captured ${sec}s`,
    transcriptActions: [A('start_planning', 'Start planning', 'command'), A('change_goal', 'Change', 'command')],
    planDrafting: 'Factory is drafting the plan. This takes a minute.',
    planDraftingActions: [A('talk', 'Talk', 'local_capture')],
    planReady: 'The plan is ready. A worker builds it, and Factory verifies each step.',
    planReadySplit: (n: number): string =>
      `The plan is ready. ${n} workers split the jobs, and Factory verifies each one.`,
    planActions: [A('begin', 'Start build', 'command'), A('milestones', 'Milestones', 'read_only')],
    startDecision: 'Start the build? It uses Factory credits, and Cursor credits if connected.',
    building: 'The worker is building the change. I will verify each step.',
    buildingSplit: (n: number): string =>
      `${n} workers are building in parallel. I verify each job as it lands.`,
    pushedForReview: 'The worker pushed a branch. Factory is reviewing the diff now.',
    reviewStatusNote: 'Factory reviewing',
    buildingStatusNote: 'worker building',
    buildingStatusNoteSplit: (n: number): string => `${n} jobs building`,
    repairStatusNote: 'worker fixing',
    prStatusNote: 'worker opening PR',
    integrationStage: 'All jobs passed review. One worker is merging the branches.',
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
    pausedActions: [A('resume', 'Resume', 'command'), A('talk', 'Talk', 'local_capture')],
    runningActions: [A('talk', 'Talk', 'local_capture'), A('pause', 'Pause', 'command')],
    // Watching a cloud build picked from the home list (not driven by us).
    attachActions: [A('explain', 'Explain', 'read_only'), A('talk', 'Talk', 'local_capture'), A('back', 'Back', 'command')],
    attachWatching: 'watching',
    attachWatchOnly: 'watch only',
    attachSendFailed: 'That build could not take your message. It is still running.',
    beatActions: [A('explain', 'Explain', 'read_only'), A('talk', 'Talk', 'local_capture')],
    failActions: [A('talk', 'Talk', 'local_capture'), A('restart', 'Restart', 'command')],
    finalActions: [A('show_evidence', 'Show evidence', 'read_only'), A('restart', 'Restart', 'command')],
    decisionActions: [A('use_it', 'Confirm', 'command'), A('talk', 'Talk', 'local_capture')],
    gateActions: [A('begin', 'Start build', 'command'), A('talk', 'Talk', 'local_capture')],
    prGateActions: [A('open_pr', 'Open PR', 'command'), A('talk', 'Talk', 'local_capture')],
    planDetailTitle: 'Plan | milestones',
    evidenceTitle: 'Evidence | live run',
    statusAnswers: {
      plan: 'Factory is planning the build.',
      building: 'The worker is building the change.',
      review: 'Factory is reviewing the change.',
      repair: 'The worker is fixing the review findings.',
      pr: 'The worker is opening the pull request.',
      final: 'The verified pull request is ready.',
      attach: 'I am watching a build from your account.',
    } as Record<string, string>,
    errors: {
      auth: 'One of your accounts rejected its key. Check your keys on the phone.',
      forbidden: 'Factory sessions are not enabled on this account yet.',
      billing: 'Your Factory account needs billing or credits. Nothing was changed.',
      quota: 'A service hit a usage or rate limit. Nothing was changed.',
      network: 'A service was unreachable. Nothing was changed.',
      service: 'A service failed. Nothing was changed.',
    },
    errorStatus: 'Service failed | nothing changed',
  },
  listening: {
    hint: 'Say what we should build.\nTap to finish.',
    hintLive: 'Listening. Pause when done,\nor tap to finish.',
    note: 'Demo capture | double-tap cancels',
    noteLive: 'Voice: ElevenLabs | double-tap cancels',
    poseNote: 'LISTENING (DEMO)',
    contextLive: 'LISTENING (LIVE)',
  },
  beatActions: [A('explain', 'Explain', 'read_only'), A('talk', 'Talk', 'local_capture')],
}
