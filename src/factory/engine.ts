/**
 * The engine surface the app drives (spec §11): the labeled demo simulation
 * (DemoFactory) or the real orchestrator (RealOrchestrator, connected
 * accounts). Both emit the same validated EngineViews and implement the same
 * input surface, so the HUD never knows which one is behind it.
 */
import type { EngineSnapshot, EngineView } from './demo'
import type { RealSnapshot } from './real'

export interface FactoryEngine {
  boot(): void
  tick(now?: number): void
  get currentView(): EngineView
  snapshot(): EngineSnapshot | RealSnapshot
  restore(snap: unknown): void
  handleAction(id: string): void
  back(): 'exit' | 'handled'
  /** Returns 'talk' when the user chose voice capture on the goal list. */
  chooseGoalList(index: number): 'talk' | 'done'
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
  /** The merged builds list for the phone's companion view. */
  listBuilds(): Array<{ title: string; note: string; kind: 'local' | 'factory' | 'cursor' }>
  /** Open a build row (resume/watch). False when a mission owns the engine. */
  openBuild(index: number): boolean
  talkStatus(): void
  pauseToggle(): void
  reset(): void
  acceptsGoal(): boolean
  canPause(): boolean
  canResume(): boolean
  canExplain(): boolean
  get hasPendingDecision(): boolean
}

export type AnyEngineSnapshot = EngineSnapshot | RealSnapshot
