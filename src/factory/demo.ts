/**
 * Demo factory engine — the labeled-simulation stand-in for the cloud factory
 * (spec §17.2 phase E1: "Interactive local story ... with labeled simulated
 * data"). It plays the conversation-gateway / hud-projection roles locally:
 * it owns mission state, computes verified progress deterministically from
 * milestone weights, and emits validated scenes. The HUD never computes
 * progress and never advances progress without an acceptance event.
 *
 * Story beats (spec §8 example): contracts 10 + fixtures 25 = 35% accepted
 * before focus; ui milestone 20 under review -> repair -> accepted (55%);
 * decision; lead switch to Factory; regression invalidates ui (back to 35%);
 * re-accept (55%); verification 25 accepted (80%); PR 20 accepted (100%).
 */
import { composeStatus } from '../scenes/compose'
import type { Scene, SceneProgress, SpritePose } from '../scenes/types'
import { COPY, DEMO_GOAL, type ExplainSource, type UnderReviewSource } from './copy'

export type Phase =
  | 'meet'
  | 'setup1'
  | 'setup2'
  | 'goal'
  | 'transcript'
  | 'plan'
  | 'running'
  | 'decision'
  | 'final'

export type MilestoneStatus = 'pending' | 'submitted' | 'repair' | 'accepted'

export interface MilestoneState {
  id: UnderReviewSource | 'contracts' | 'fixtures'
  label: string
  weight: number
  status: MilestoneStatus
  worker: 'Cursor' | 'Factory'
  criteria: string[]
}

export type EngineView =
  | { type: 'scene'; scene: Scene }
  | {
      type: 'selection'
      purpose: 'goal' | 'plan_detail' | 'evidence' | 'projects'
      contextLabel: string
      title: string
      items: string[]
      pose: SpritePose
    }

interface Overlay {
  kind: 'plan_detail' | 'decision_detail' | 'explain' | 'evidence'
  explainSource?: ExplainSource
}

interface TransientState {
  scene: Scene
  until: number
  followup: string | null
}

interface Beat {
  label: string
  at: number
}

const MS = (s: number) => s * 1000

function initialMilestones(): MilestoneState[] {
  return [
    {
      id: 'contracts', label: 'Contracts', weight: 10, status: 'accepted',
      worker: 'Cursor', criteria: ['Agent contracts'],
    },
    {
      id: 'fixtures', label: 'Fixtures', weight: 25, status: 'accepted',
      worker: 'Factory', criteria: ['Engine fixtures'],
    },
    {
      id: 'ui', label: 'Empty-state screen', weight: 20, status: 'pending',
      worker: 'Factory', criteria: ['Empty results render', 'Failed requests retry', 'Layout bounds hold'],
    },
    {
      id: 'verify', label: 'Verification', weight: 25, status: 'pending',
      worker: 'Cursor', criteria: ['End-to-end checks'],
    },
    {
      id: 'pr', label: 'Verified PR', weight: 20, status: 'pending',
      worker: 'Cursor', criteria: ['PR checks passed'],
    },
  ]
}

export interface EngineSnapshot {
  v: 1
  phase: Phase
  overlayKind: Overlay['kind'] | null
  explainSource: ExplainSource | null
  goalText: string
  goalSource: 'talk' | 'list' | 'voice'
  capturedSec: number
  lead: 'Cursor' | 'Factory'
  planRevision: number
  decisionPending: boolean
  paused: boolean
  milestones: MilestoneState[]
  nextBeatLabel: string | null
  seq: number
}

export class DemoFactory {
  private phase: Phase = 'meet'
  private overlay: Overlay | null = null
  private transient: TransientState | null = null
  private pendingBeat: Beat | null = null
  private paused = false
  private decisionPending = false
  private lead: 'Cursor' | 'Factory' = 'Cursor'
  private planRevision = 1
  private goalText = ''
  private goalSource: 'talk' | 'list' | 'voice' = 'list'
  private capturedSec = 0
  private milestones = initialMilestones()
  private seq = 0
  private lastView: EngineView | null = null
  private readonly emitView: (view: EngineView) => void

  constructor(emitView: (view: EngineView) => void) {
    this.emitView = emitView
  }

  // ---------------------------------------------------------------- progress

  /** Progress is computed from milestone weights only (spec §8 formula). */
  private progress(): SceneProgress {
    const accepted = this.milestones
      .filter((m) => m.status === 'accepted')
      .reduce((n, m) => n + m.weight, 0)
    const pending = this.milestones
      .filter((m) => m.status === 'submitted')
      .reduce((n, m) => n + m.weight, 0)
    const total = this.milestones.reduce((n, m) => n + m.weight, 0)
    return { acceptedWeight: accepted, pendingReviewWeight: pending, totalWeight: total, planRevision: this.planRevision }
  }

  private missionActive(): boolean {
    return ['plan', 'running', 'decision', 'final'].includes(this.phase)
  }

  private contextLabel(): string {
    return this.missionActive() ? COPY.contextProduct : COPY.contextSprite
  }

  // ----------------------------------------------------------------- scenes

  private scene(kind: Scene['kind'], o: {
    pose: SpritePose
    utterance: string
    status?: string
    statusNote?: string
    progress?: SceneProgress | null
    actions?: Scene['actions']
    evidence?: string[]
    transientMs?: number
  }): Scene {
    const progress = o.progress !== undefined ? o.progress : this.missionActive() ? this.progress() : null
    return {
      schemaVersion: 1,
      sceneId: `${kind}_${this.seq + 1}`,
      sceneRevision: this.seq + 1,
      missionId: this.missionActive() ? 'mission_empty_state' : null,
      stateSequence: this.seq + 1,
      kind,
      spritePose: o.pose,
      contextLabel: this.contextLabel(),
      utterance: o.utterance,
      status: o.status ?? composeStatus(progress, o.statusNote ?? ''),
      progress,
      actions: o.actions ?? [],
      evidenceIds: o.evidence ?? [],
      generatedAt: new Date().toISOString(),
      demo: true,
      transientMs: o.transientMs ?? 0,
    }
  }

  private baseView(): EngineView {
    switch (this.phase) {
      case 'meet':
        return { type: 'scene', scene: this.scene('meet', { pose: 'idle', utterance: COPY.meet.utterance, actions: COPY.meet.actions, progress: null }) }
      case 'setup1':
        return { type: 'scene', scene: this.scene('setup_notice', { pose: 'idle', utterance: COPY.setupNotice.utterance, actions: COPY.setupNotice.actions, progress: null }) }
      case 'setup2':
        return { type: 'scene', scene: this.scene('setup_connections', { pose: 'checking', utterance: COPY.setupConnections.utterance, actions: COPY.setupConnections.actions, progress: null }) }
      case 'goal':
        return { type: 'selection', purpose: 'goal', contextLabel: this.contextLabel(), title: COPY.goalList.title, items: COPY.goalList.items, pose: 'idle' }
      case 'transcript': {
        const status =
          this.goalSource === 'voice'
            ? `Live transcript | captured ${this.capturedSec}s`
            : this.goalSource === 'talk'
              ? `Demo transcript | captured ${this.capturedSec}s`
              : 'Demo transcript | picked from list'
        return {
          type: 'scene',
          scene: this.scene('transcript', {
            pose: 'waiting', utterance: this.goalText, status, progress: null,
            actions: [
              { id: 'start_planning', label: 'Start planning', kind: 'command' },
              { id: 'change_goal', label: 'Change', kind: 'command' },
            ],
          }),
        }
      }
      case 'plan':
        return {
          type: 'scene',
          scene: this.scene('plan', {
            pose: 'planning', utterance: COPY.plan.utterance,
            statusNote: COPY.plan.statusNote, actions: COPY.plan.actions,
          }),
        }
      case 'running': {
        if (this.paused) {
          return { type: 'scene', scene: this.scene('paused', { pose: 'idle', utterance: COPY.paused.utterance, actions: COPY.paused.actions }) }
        }
        return {
          type: 'scene',
          scene: this.scene('running', { pose: 'planning', utterance: COPY.running.utterance, actions: COPY.running.actions }),
        }
      }
      case 'decision':
        return {
          type: 'scene',
          scene: this.scene('decision', {
            pose: 'asking', utterance: COPY.decision.utterance,
            statusNote: COPY.decision.statusNote, actions: COPY.decision.actions,
            evidence: ['decision_range_1'],
          }),
        }
      case 'final':
        return {
          type: 'scene',
          scene: this.scene('final', {
            pose: 'accepted', utterance: COPY.final.utterance,
            actions: COPY.final.actions, evidence: ['review_pr_1', 'validation_pr_1'],
          }),
        }
    }
  }

  private overlayView(): EngineView {
    switch (this.overlay?.kind) {
      case 'plan_detail':
        return { type: 'selection', purpose: 'plan_detail', contextLabel: this.contextLabel(), title: COPY.planDetail.title, items: COPY.planDetail.items, pose: 'planning' }
      case 'evidence':
        return { type: 'selection', purpose: 'evidence', contextLabel: this.contextLabel(), title: COPY.evidence.title, items: COPY.evidence.items, pose: 'accepted' }
      case 'decision_detail':
        return {
          type: 'scene',
          scene: this.scene('decision_detail', {
            pose: 'asking', utterance: COPY.decisionDetail.utterance,
            actions: COPY.decisionDetail.actions, evidence: ['decision_range_1'],
          }),
        }
      case 'explain':
        return {
          type: 'scene',
          scene: this.scene('explain', {
            pose: 'checking',
            utterance: COPY.explain[this.overlay.explainSource ?? 'under_review'],
            actions: [{ id: 'back', label: 'Back', kind: 'command' }],
            evidence: ['review_note_1'],
          }),
        }
      default:
        return this.baseView()
    }
  }

  private computeView(): EngineView {
    if (this.transient) return { type: 'scene', scene: this.transient.scene }
    if (this.overlay) return this.overlayView()
    return this.baseView()
  }

  private emit(view: EngineView): void {
    this.seq += 1
    this.lastView = view
    if (view.type === 'scene') {
      const p = view.scene.progress
      console.log(
        `[scene] kind=${view.scene.kind} seq=${view.scene.stateSequence} rev=${view.scene.sceneRevision} pose=${view.scene.spritePose}` +
          (p ? ` accepted=${p.acceptedWeight} pending=${p.pendingReviewWeight} total=${p.totalWeight}` : ' accepted=none'),
      )
    } else {
      console.log(`[scene] kind=selection seq=${this.seq} items=${view.items.length}`)
    }
    this.emitView(view)
  }

  private emitCurrent(): void {
    this.emit(this.computeView())
  }

  private emitTransientScene(scene: Scene, ms: number, followup: string | null): void {
    this.transient = { scene, until: Date.now() + ms, followup }
    this.emit({ type: 'scene', scene })
  }

  // ------------------------------------------------------------------ beats

  private scheduleBeat(delayMs: number, label: string): void {
    this.pendingBeat = { label, at: Date.now() + delayMs }
  }

  private runBeat(label: string): void {
    switch (label) {
      case 'ui_submit': {
        this.setStatus('ui', 'submitted')
        this.emit(this.underReviewScene('ui'))
        this.scheduleBeat(MS(5), 'ui_review_fail')
        return
      }
      case 'ui_review_fail': {
        this.setStatus('ui', 'repair')
        this.emit(this.repairScene())
        this.scheduleBeat(MS(5), 'ui_resubmit')
        return
      }
      case 'ui_resubmit': {
        this.setStatus('ui', 'submitted')
        this.emit(this.underReviewScene('ui'))
        this.scheduleBeat(MS(4), 'ui_accept')
        return
      }
      case 'ui_accept': {
        this.setStatus('ui', 'accepted')
        this.emitTransientScene(this.acceptedScene('ui'), MS(6), 'decision_raise')
        return
      }
      case 'decision_raise': {
        this.decisionPending = true
        this.phase = 'decision'
        this.emitCurrent()
        return
      }
      case 'verify_submit': {
        this.setStatus('verify', 'submitted')
        this.emit(this.underReviewScene('verify'))
        this.scheduleBeat(MS(5), 'regress')
        return
      }
      case 'regress': {
        // A later change broke an accepted criterion: acceptance is invalidated
        // and verified progress decreases, with a visible explanation (G25).
        this.setStatus('ui', 'repair')
        this.emitTransientScene(this.regressionScene(), MS(6), 'ui_resubmit2')
        return
      }
      case 'ui_resubmit2': {
        this.setStatus('ui', 'submitted')
        this.emit(this.underReviewScene('ui'))
        this.scheduleBeat(MS(4), 'ui_reaccept')
        return
      }
      case 'ui_reaccept': {
        this.setStatus('ui', 'accepted')
        this.emitTransientScene(this.acceptedScene('ui'), MS(4.5), 'verify_accept')
        return
      }
      case 'verify_accept': {
        this.setStatus('verify', 'accepted')
        this.emitTransientScene(this.acceptedScene('verify'), MS(6), 'pr_submit')
        return
      }
      case 'pr_submit': {
        this.setStatus('pr', 'submitted')
        this.emit(this.underReviewScene('pr'))
        this.scheduleBeat(MS(4), 'pr_accept')
        return
      }
      case 'pr_accept': {
        this.setStatus('pr', 'accepted')
        this.phase = 'final'
        this.emitCurrent()
        return
      }
      default:
        console.warn('[engine] unknown beat', label)
    }
  }

  /** Called on a slow tick. Transient display expiry is honored even while paused. */
  tick(now = Date.now()): void {
    if (this.transient && now >= this.transient.until) {
      this.dismissTransientInternal()
    }
    if (!this.paused && this.pendingBeat && now >= this.pendingBeat.at) {
      const { label } = this.pendingBeat
      this.pendingBeat = null
      this.runBeat(label)
    }
  }

  private dismissTransientInternal(): void {
    const t = this.transient
    this.transient = null
    if (t?.followup) {
      this.scheduleBeat(0, t.followup)
    } else {
      this.emitCurrent()
    }
  }

  private setStatus(id: string, status: MilestoneStatus): void {
    const m = this.milestones.find((x) => x.id === id)
    if (m) m.status = status
  }

  // ------------------------------------------------------------- beat scenes

  private underReviewScene(src: UnderReviewSource): EngineView {
    return {
      type: 'scene',
      scene: this.scene('under_review', {
        pose: 'checking', utterance: COPY.underReview(src),
        actions: COPY.beatActions, evidence: [`review_${src}_1`],
      }),
    }
  }

  private repairScene(): EngineView {
    return {
      type: 'scene',
      scene: this.scene('repair', {
        pose: 'repair', utterance: COPY.repair.utterance,
        actions: COPY.repair.actions, evidence: ['review_ui_1'],
      }),
    }
  }

  private regressionScene(): Scene {
    return this.scene('regression', {
      pose: 'repair', utterance: COPY.regression.utterance,
      actions: COPY.regression.actions, evidence: ['verify_1', 'ui_regress_1'],
    })
  }

  private acceptedScene(src: UnderReviewSource): Scene {
    return this.scene('accepted', {
      pose: 'accepted', utterance: COPY.accepted(src),
      actions: COPY.beatActions, evidence: [`review_${src}_2`, `validation_${src}_2`],
    })
  }

  // ---------------------------------------------------------------- actions

  handleAction(id: string): void {
    switch (id) {
      case 'setup':
        this.phase = 'setup1'
        break
      case 'continue':
        this.phase = 'setup2'
        break
      case 'choose_goal':
        this.phase = 'goal'
        break
      case 'change_goal':
        this.phase = 'goal'
        break
      case 'start_planning':
        this.phase = 'plan'
        this.milestones = initialMilestones()
        this.planRevision = 1
        this.lead = 'Cursor'
        break
      case 'start':
        this.phase = 'running'
        this.paused = false
        this.scheduleBeat(MS(4), 'ui_submit')
        break
      case 'milestones':
        this.overlay = { kind: 'plan_detail' }
        break
      case 'use_it':
        if (!this.decisionPending) return
        this.decisionPending = false
        this.overlay = null
        this.lead = 'Factory' // epoch switch: new lead, workers continue
        this.emitTransientScene(
          this.scene('switching', { pose: 'switching', utterance: COPY.switching.utterance, actions: COPY.switching.actions }),
          MS(3.5),
          'verify_submit',
        )
        return
      case 'explain': {
        if (this.phase === 'decision') {
          this.overlay = { kind: 'decision_detail' }
        } else if (this.transient) {
          // Detail requested during a brief card: the card expires underneath
          // (the overlay takes display priority), and the story keeps moving.
          this.overlay = { kind: 'explain', explainSource: this.transientExplainSource() }
        } else {
          this.overlay = { kind: 'explain', explainSource: this.baseExplainSource() }
        }
        break
      }
      case 'back':
        if (this.overlay) {
          this.overlay = null
          break
        }
        if (this.transient) {
          this.dismissTransientInternal()
          return
        }
        return // plain Back at a base card is handled by the back gesture path
      case 'pause':
        this.pauseToggle()
        return
      case 'resume':
        this.pauseToggle()
        return
      case 'show_evidence':
        this.overlay = { kind: 'evidence' }
        break
      case 'restart':
        this.reset()
        return
      default:
        console.warn('[engine] unknown action', id)
        return
    }
    this.emitCurrent()
  }

  private transientExplainSource(): ExplainSource {
    const kind = this.transient?.scene.kind
    if (kind === 'regression') return 'regression'
    if (kind === 'accepted') return 'accepted'
    return 'under_review'
  }

  private baseExplainSource(): ExplainSource {
    // The most recent review-ish display state drives the explanation.
    const recent = this.milestones.find((m) => m.status === 'repair')
    if (recent) return 'repair'
    const submitted = this.milestones.find((m) => m.status === 'submitted')
    if (submitted) return 'under_review'
    return 'accepted'
  }

  pauseToggle(): void {
    if (this.phase !== 'running') {
      console.warn('[engine] pause is only available while work runs')
      return
    }
    this.paused = !this.paused
    this.emitCurrent()
  }

  // --------------------------------------------------------------- selection

  /** Returns 'talk' when the user chose voice capture on the goal list. */
  chooseGoalList(index: number): 'talk' | 'done' {
    if (index === 0) return 'talk'
    this.goalText = DEMO_GOAL
    this.goalSource = 'list'
    this.capturedSec = 0
    this.phase = 'transcript'
    this.emitCurrent()
    return 'done'
  }

  chooseList(index: number): void {
    if (this.overlay?.kind === 'plan_detail' || this.overlay?.kind === 'evidence') {
      this.overlay = null
      this.emitCurrent()
      return
    }
    console.warn('[engine] list selection in unexpected context', index)
  }

  /** Back gesture. Returns 'exit' when at a root card (system exit confirm). */
  back(): 'exit' | 'handled' {
    if (this.overlay) {
      this.overlay = null
      this.emitCurrent()
      return 'handled'
    }
    if (this.transient) {
      this.dismissTransientInternal()
      return 'handled'
    }
    switch (this.phase) {
      case 'setup2':
        this.phase = 'setup1'
        break
      case 'setup1':
        this.phase = 'meet'
        break
      case 'goal':
        this.phase = 'setup2'
        break
      case 'transcript':
        this.phase = 'goal'
        break
      case 'plan':
        this.phase = 'transcript'
        break
      case 'decision':
        // A blocking decision persists; it never resolves via timeout or back.
        this.emitCurrent()
        return 'handled'
      default:
        return 'exit' // meet, running, final: root cards
    }
    this.emitCurrent()
    return 'handled'
  }

  // ------------------------------------------------------------------- talk

  /** A fresh goal can still steer the mission until work starts. */
  acceptsGoal(): boolean {
    return ['meet', 'setup1', 'setup2', 'goal', 'transcript', 'plan'].includes(this.phase)
  }

  canPause(): boolean {
    return this.phase === 'running' && !this.paused
  }

  canResume(): boolean {
    return this.phase === 'running' && this.paused
  }

  /** True once mission content exists that "explain" can talk about. */
  canExplain(): boolean {
    return this.missionActive()
  }

  get hasPendingDecision(): boolean {
    return this.decisionPending
  }

  /** Voice capture finished (tap, release, or the 30s bounded cap). */
  transcriptGoal(sec: number): void {
    if (this.acceptsGoal()) {
      this.goalText = DEMO_GOAL
      this.goalSource = 'talk'
      this.capturedSec = sec
      this.phase = 'transcript'
      this.emitCurrent()
      return
    }
    // Talking mid-flight asks for status (spec §10.1 "Status" intent).
    this.talkStatus()
  }

  /** Real spoken goal (live STT). The simulated factory runs on real text. */
  voiceGoal(text: string, sec: number): void {
    if (!this.acceptsGoal()) {
      // Mid-flight free speech is a status request (spec §10.1).
      this.talkStatus()
      return
    }
    this.goalText = text
    this.goalSource = 'voice'
    this.capturedSec = sec
    this.phase = 'transcript'
    this.emitCurrent()
  }

  /** The simulation cannot act on free speech mid-flight. */
  steer(_text: string): boolean {
    return false
  }

  /** Typed text from the phone: the labeled demo takes goals, else a hint. */
  say(text: string): 'goal' | 'steer' | 'decision' | 'none' {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) return 'none'
    if (this.decisionPending) return 'none' // demo decisions answer with Use it
    if (this.acceptsGoal()) {
      this.voiceGoal(clean, 0)
      return 'goal'
    }
    return 'none' // mid-flight free speech is a status request, not input
  }

  /** The labeled demo drives no cloud builds; the phone shows none. */
  listBuilds(): Array<{ title: string; note: string; kind: 'local' | 'factory' | 'cursor' }> {
    return []
  }

  /** The demo owns its story; build rows never open from the phone. */
  openBuild(_index: number): boolean {
    return false
  }

  talkStatus(): void {
    const acceptedCount = this.milestones.filter((m) => m.status === 'accepted').length
    const done = this.milestones.every((m) => m.status === 'accepted')
    const scene = this.scene('status_answer', {
      pose: done ? 'accepted' : 'waiting',
      utterance: done
        ? COPY.statusAnswer.done
        : this.decisionPending
          ? COPY.statusAnswer.choice
          : COPY.statusAnswer.moving,
      statusNote: this.decisionPending
        ? COPY.decision.statusNote
        : `${acceptedCount} of ${this.milestones.length} steps done`,
      actions: [{ id: 'back', label: 'Back', kind: 'command' }],
      evidence: this.decisionPending ? ['decision_range_1'] : ['status_snapshot_1'],
    })
    this.emitTransientScene(scene, MS(6), null)
  }

  // ------------------------------------------------------------ persistence

  snapshot(): EngineSnapshot {
    return {
      v: 1,
      phase: this.phase,
      overlayKind: this.overlay?.kind ?? null,
      explainSource: this.overlay?.explainSource ?? null,
      goalText: this.goalText,
      goalSource: this.goalSource,
      capturedSec: this.capturedSec,
      lead: this.lead,
      planRevision: this.planRevision,
      decisionPending: this.decisionPending,
      paused: this.paused,
      milestones: this.milestones,
      nextBeatLabel: this.pendingBeat?.label ?? null,
      seq: this.seq,
    }
  }

  restore(snap: EngineSnapshot): void {
    if (snap?.v !== 1) return
    this.phase = snap.phase
    this.goalText = snap.goalText
    this.goalSource = snap.goalSource
    this.capturedSec = snap.capturedSec
    this.lead = snap.lead
    this.planRevision = snap.planRevision
    this.decisionPending = snap.decisionPending
    this.paused = snap.paused
    this.milestones = Array.isArray(snap.milestones) && snap.milestones.length === 5 ? snap.milestones : initialMilestones()
    this.seq = snap.seq
    // Catch-up lands on the base card: no stale transients or overlays replay.
    this.transient = null
    this.overlay = null
    if (this.phase === 'running' && snap.nextBeatLabel) {
      this.scheduleBeat(MS(2), snap.nextBeatLabel)
    }
  }

  reset(): void {
    this.phase = 'meet'
    this.overlay = null
    this.transient = null
    this.pendingBeat = null
    this.paused = false
    this.decisionPending = false
    this.lead = 'Cursor'
    this.planRevision = 1
    this.goalText = ''
    this.goalSource = 'list'
    this.capturedSec = 0
    this.milestones = initialMilestones()
    this.emitCurrent()
  }

  boot(): void {
    this.emitCurrent()
  }

  get currentView(): EngineView {
    return this.lastView ?? this.computeView()
  }

  get isPaused(): boolean {
    return this.paused
  }

  get leadProvider(): string {
    return this.lead
  }
}
