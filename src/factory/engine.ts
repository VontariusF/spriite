/**
 * The engine surface the app drives (spec §11): the real orchestrator
 * (RealOrchestrator, connected accounts) or the durable runtime adapter over
 * it (RuntimeEngine). Both emit the same validated EngineViews and implement
 * the same input surface, so the HUD never knows which one is behind it.
 */
import type { ChatWho } from '../domain/speaker'
import type { EngineView } from './view'
import type { RealSnapshot } from './real'
import type { MissionPresentation, NativeAnswer, NativeIntent, NativeSnapshot } from '../native/protocol'
import type { SubmitReceipt } from '../runtime/supervisor'

export interface FactoryEngine {
  boot(): void
  tick(now?: number): void
  get currentView(): EngineView
  snapshot(): RealSnapshot | NativeSnapshot
  /** Native snapshots remain native, never synthetic legacy state. */
  nativeSnapshot?(): NativeSnapshot | null
  presentation?(): MissionPresentation | null
  /** True = confirmed transport delivery, never request resolution. */
  answerNative?(answer: NativeAnswer): Promise<boolean>
  submitNativeIntent?(intent: NativeIntent): Promise<SubmitReceipt>
  restore(snap: unknown): void
  handleAction(id: string): void
  back(): 'exit' | 'handled'
  /** Returns 'talk' when the user chose voice capture on the goal list. */
  chooseGoalList(index: number): 'talk' | 'done'
  /**
   * Pick a row of a pending question's option list. Returns 'talk' when the
   * row was the speak-another-answer entry; 'done' when an option answered
   * the lead or there was no list to pick from.
   */
  chooseDecisionList(index: number): 'talk' | 'done'
  chooseList(index: number): void
  /** Voice capture finished (tap, release, or the 30s bounded cap). */
  transcriptGoal(sec: number): void
  /** Real spoken goal (live STT). */
  voiceGoal(text: string, sec: number): void
  /**
   * Mid-mission free speech. True when the engine acted on it (the real
   * orchestrator turns it into a session message); false leaves the caller
   * to answer with the heard card.
   */
  steer(text: string): boolean
  /**
   * Free text from the phone (typed, not spoken): answers a pending decision,
   * starts a goal, or steers the live mission. Returns where the text went;
   * 'none' means the engine had nothing to take it (the caller shows a hint).
   */
  say(text: string): 'goal' | 'steer' | 'decision' | 'none'
  /**
   * Typed goal that should build in a brand-new repository (the phone's
   * "Start in a new repository" row). `name` is the repository name the owner
   * typed, or '' to derive it from the goal. Returns where the text went,
   * like say().
   */
  sayNewRepo(text: string, name: string): 'goal' | 'steer' | 'none'
  /** True when this engine can start a goal in a brand-new repository. */
  canStartNewRepo(): boolean
  /**
   * The merged builds list for the phone's companion view. A Spriite row
   * names its mission when one exists, so the phone can reach a finished
   * mission's kept record; cloud rows have no mission here.
   */
  listBuilds(): Array<{ title: string; note: string; kind: 'local' | 'factory' | 'cursor'; missionId?: string }>
  /** Open a build row (resume/watch). False when a mission owns the engine. */
  openBuild(index: number): boolean
  talkStatus(): void
  pauseToggle(): void
  reset(): void
  /** Navigate to Builds without cancelling work or answering a question. */
  showHome?(): void
  acceptsGoal(): boolean
  canPause(): boolean
  canResume(): boolean
  canExplain(): boolean
  get hasPendingDecision(): boolean
  /** A native Factory question must be answered in Factory, not by text POST. */
  nativeQuestionLink?(): string | null
  /** Exact selected Factory chat for read-only handoff or delivery review. */
  factorySessionLink?(): string | null
  /** Blocks another message while a dispatch acknowledgment is unresolved. */
  readonly hasUnconfirmedDelivery?: boolean
  /**
   * The session's chat log, oldest first: the goal, the lead's questions and
   * replies, and the owner's answers. Empty when nothing has been said.
   */
  chatLog(): Array<{ who: ChatWho; text: string; at: number }>
  /** Missions waiting on the owner's answer that the HUD is not showing. */
  pendingAsks(): Array<{ missionId: string; title: string }>
  /** Bring a mission's cards to the HUD. False when it has no live actor. */
  showMission(missionId: string): boolean
  /** True when switching to another build from the builds list is allowed. */
  canOpenBuilds(): boolean
  /** A build from the account is on screen in watch mode (not run by Spriite). */
  watching(): boolean
  /** The watched build cannot take messages (spoken words must not reach it). */
  watchOnly(): boolean
}

export type AnyEngineSnapshot = RealSnapshot | NativeSnapshot
