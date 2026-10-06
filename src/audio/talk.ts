/**
 * Bounded tap-to-talk capture (spec §10.2). The microphone is opened through
 * the SDK and closed on tap, release, timeout, cancel, or lifecycle exit.
 * A capture session never resumes automatically after a disconnect; the
 * 30-second cap bounds a lost release event (G06). Nothing here transcribes:
 * the transcript is demo-scripted and labeled.
 */
import { AudioInputSource } from '@evenrealities/even_hub_sdk'
import type { BridgeGateway } from '../bridge/bridge'

/** 'silence' = the speech service settled a phrase (VAD), ending the turn. */
export type TalkFinishReason = 'tap' | 'release' | 'timeout' | 'silence' | 'cancel' | 'lifecycle'

export interface TalkHooks {
  onTimer: (text: string) => void
  onFinish: (sec: number, reason: TalkFinishReason) => void
  onPcm?: (pcm: Uint8Array) => void
}

export const MAX_CAPTURE_MS = 30_000
const BYTES_PER_SEC = 32_000 // 16 kHz, signed 16-bit, mono
const CAP_SEC = Math.floor(MAX_CAPTURE_MS / 1000)

export class TalkController {
  private active = false
  private startedAt = 0
  private chunkBytes = 0
  private capTimer: ReturnType<typeof setTimeout> | null = null
  private lastTimerSec = -1
  private readonly gateway: BridgeGateway
  private readonly hooks: TalkHooks

  constructor(gateway: BridgeGateway, hooks: TalkHooks) {
    this.gateway = gateway
    this.hooks = hooks
  }

  get isActive(): boolean {
    return this.active
  }

  /** Returns true only when the microphone actually started (G05). */
  async start(): Promise<boolean> {
    if (this.active) return true
    const ok = await this.gateway.call((b) => b.audioControl(true, AudioInputSource.Glasses), 'audioOpen')
    if (ok !== true) {
      console.warn('[talk] microphone start failed')
      return false
    }
    this.active = true
    this.startedAt = Date.now()
    this.chunkBytes = 0
    this.lastTimerSec = -1
    this.hooks.onTimer(this.timerText(0))
    this.capTimer = setTimeout(() => void this.finish('timeout'), MAX_CAPTURE_MS)
    console.log('[talk] capture started')
    return true
  }

  /** PCM from the glasses; forwarded to the speech sink while capturing. */
  onAudio(pcm: Uint8Array): void {
    if (!this.active) return
    this.hooks.onPcm?.(pcm)
    this.chunkBytes += pcm.byteLength
    const sec = this.elapsedSec()
    if (sec !== this.lastTimerSec) {
      this.lastTimerSec = sec
      this.hooks.onTimer(this.timerText(sec))
    }
  }

  async finish(reason: TalkFinishReason): Promise<void> {
    if (!this.active) return
    this.active = false
    if (this.capTimer) {
      clearTimeout(this.capTimer)
      this.capTimer = null
    }
    const sec = this.elapsedSec()
    await this.gateway.call((b) => b.audioControl(false), 'audioClose')
    console.log('[talk] capture ended:', reason, `${sec}s`, `${this.chunkBytes} bytes`)
    if (reason === 'cancel' || reason === 'lifecycle') return
    this.hooks.onFinish(sec, reason)
  }

  private elapsedSec(): number {
    const byChunks = Math.round(this.chunkBytes / BYTES_PER_SEC)
    const byWall = Math.round((Date.now() - this.startedAt) / 1000)
    return Math.max(1, byChunks > 0 ? byChunks : byWall)
  }

  private timerText(sec: number): string {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${String(s).padStart(2, '0')} of 0:${CAP_SEC}`
  }
}
