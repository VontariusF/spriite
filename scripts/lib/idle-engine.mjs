/**
 * A do-nothing FactoryEngine for phone tests: the whole engine surface with
 * inert answers and an idle card as its current view. Tests override the
 * members they exercise (snapshot, nativeSnapshot, say, ...).
 */
export class IdleEngine {
  constructor(emit = () => {}) {
    this.emit = emit
    this.view = {
      type: 'scene',
      scene: {
        schemaVersion: 1, sceneId: 'idle_test', sceneRevision: 1, missionId: null, stateSequence: 1,
        kind: 'meet', spritePose: 'idle', contextLabel: 'SPRIITE',
        utterance: 'Ready when you are.', status: 'Hold to talk, or swipe for builds.', progress: null,
        actions: [{ id: 'talk', label: 'Talk', kind: 'local_capture' }],
        evidenceIds: [], generatedAt: '2026-01-01T00:00:00.000Z', transientMs: 0,
      },
    }
  }
  boot() { this.emit(this.view) }
  tick() {}
  get currentView() { return this.view }
  snapshot() { return {} }
  restore() {}
  handleAction() {}
  back() { return 'exit' }
  chooseGoalList() { return 'done' }
  chooseDecisionList() { return 'done' }
  chooseList() {}
  transcriptGoal() {}
  voiceGoal() {}
  steer() { return false }
  say() { return 'none' }
  sayNewRepo() { return 'none' }
  canStartNewRepo() { return false }
  listBuilds() { return [] }
  openBuild() { return false }
  talkStatus() {}
  pauseToggle() {}
  reset() {}
  acceptsGoal() { return true }
  canPause() { return false }
  canResume() { return false }
  canExplain() { return false }
  get hasPendingDecision() { return false }
  chatLog() { return [] }
  pendingAsks() { return [] }
  showMission() { return false }
  canOpenBuilds() { return true }
  watching() { return false }
  watchOnly() { return false }
}
