import { nativeCaptureKey } from './action-ownership'
import type { NativeSnapshot } from '../native/protocol'

export interface VoiceTarget {
  engine: object
  mission: string | null
  /** Exact pending request/scope ownership, distinct from progress churn. */
  request?: string | null
}

/** Preserve the literal transcript. The engine owns any build-scope review;
 * this capture layer never parses commands or starts a new goal. */
export function sendVoiceMessage(engine: { steer(text: string): boolean }, text: string): boolean {
  const message = text.trim()
  return message !== '' && engine.steer(message)
}

/** Stable execution identity, not a rendered card or progress revision.
 * Runtime actors have mission ids. Legacy builds and lobby watches instead
 * carry their provider identity in the snapshot; home has neither.
 * Structured encoding avoids collisions between goal text and remote ids. */
export function voiceTargetOf(engine: object, snapshot: unknown, missionId?: string | null): VoiceTarget {
  const s = snapshot as {
    buildDraft?: { requestId?: string } | null
    decisionPending?: boolean
    decisionText?: string
    decisionOptions?: string[]
    leadQuestionRequest?: string | null
    nativeQuestion?: unknown
    goal?: string
    repoUrl?: string
    missionRepo?: string
    sessionId?: string | null
    attach?: {
      source?: string
      sessionId?: string | null
      agentId?: string | null
      runId?: string | null
    } | null
  } | null
  const native = (engine as { nativeSnapshot?: () =>
    Pick<NativeSnapshot, 'missionId' | 'ownerId' | 'scopeRevision' | 'attention'> | null
  }).nativeSnapshot?.()
  if (native) return {
    engine, mission: JSON.stringify(['native', native.ownerId, native.missionId]),
    request: nativeCaptureKey(null, native),
  }
  const request = s?.decisionPending
    ? JSON.stringify([s.leadQuestionRequest, s.nativeQuestion, s.decisionText, s.decisionOptions]) : null
  if (s?.buildDraft?.requestId && !s.decisionPending) {
    return { engine, mission: JSON.stringify(['build_review', missionId ?? s.sessionId, s.buildDraft.requestId]) }
  }
  if (missionId != null) return { engine, mission: JSON.stringify(['mission', missionId]), request }
  let mission: string | null = null
  if (s?.attach) {
    const a = s.attach
    mission = JSON.stringify(['watch', a.source, a.sessionId ?? null, a.agentId ?? null, a.runId ?? null])
  } else if (s?.sessionId) {
    mission = JSON.stringify(['build', s.sessionId])
  } else if (s?.goal) {
    mission = JSON.stringify(['goal', s.goal, s.missionRepo || s.repoUrl || ''])
  }
  return { engine, mission, request }
}

/** Capture ownership spans microphone startup, listening, and settlement.
 * Invalidation releases UI ownership synchronously, before any awaited
 * teardown; an old completion cannot release a newer capture. */
export class VoiceTurnGuard {
  private generation = 0
  private active = false
  private target: VoiceTarget | undefined
  private readonly onInvalidate: () => void

  constructor(onInvalidate: () => void = () => {}) {
    this.onInvalidate = onInvalidate
  }

  get captureTarget(): VoiceTarget | undefined {
    return this.target
  }

  begin(target?: VoiceTarget): number {
    this.invalidate()
    this.active = true
    this.target = target
    return ++this.generation
  }

  invalidate(): void {
    this.generation++
    const owned = this.active
    this.active = false
    this.target = undefined
    if (owned) this.onInvalidate()
  }

  /** Back/exit invalidates ownership before microphone teardown is awaited. */
  exit(): void {
    this.invalidate()
  }

  reconcile(target: VoiceTarget): boolean {
    if (!this.active || !this.target ||
      (this.target.engine === target.engine && this.target.mission === target.mission &&
        (this.target.request ?? null) === (target.request ?? null))) return false
    this.invalidate()
    return true
  }

  complete(turn: number): boolean {
    if (!this.isCurrent(turn)) return false
    this.active = false
    this.target = undefined
    return true
  }

  isCurrent(turn: number): boolean {
    return this.active && turn === this.generation
  }
}
