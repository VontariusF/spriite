/**
 * Event normalizer (spec §5.3, edge cases G10-G13).
 *
 * - Audio events never become taps (G11).
 * - A click may be encoded as an omitted zero-valued enum; only a present
 *   input envelope defaults to click (G10).
 * - A double tap must never first approve the focused action: single taps are
 *   armed and confirmed only after the debounce window closes (G12).
 * - Duplicate deliveries of the same envelope are dropped (G13).
 * - Hold events are surfaced as speech_start/speech_end candidates; they never
 *   activate actions (G08/G09: tap-then-hold is the system's gesture).
 */
import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import type { AppEvent, InputSource } from './events'

export interface NormalizerOptions {
  doubleTapWindowMs: number
  dedupeMs: number
}

const DEFAULTS: NormalizerOptions = {
  doubleTapWindowMs: 350,
  dedupeMs: 60,
}

/**
 * Scroll streams are continuous input (ring rotation, swipes): the general
 * dedupe window swallows fast, legitimate rotation ticks, which reads as
 * focus skipping or dead ring input. A tight window still drops re-delivered
 * envelopes (G13, back-to-back within a few ms) without eating real ticks.
 */
const SCROLL_DEDUPE_MS = 12

export class InputNormalizer {
  private pendingSelect: ReturnType<typeof setTimeout> | null = null
  private pendingSource: InputSource = 'unknown'
  private lastSig = ''
  private lastSigAt = 0
  private readonly emit: (e: AppEvent) => void
  private readonly opts: NormalizerOptions

  constructor(emit: (e: AppEvent) => void, opts: NormalizerOptions = DEFAULTS) {
    this.emit = emit
    this.opts = opts
  }

  handle(ev: EvenHubEvent): void {
    // Microphone audio is audio, never a tap (G11).
    if (ev.audioEvent) return

    if (ev.menuItemClickEvent) {
      const itemId = ev.menuItemClickEvent.itemID ?? 0
      if (!this.dedupe(`menu:${itemId}`)) return
      this.emit({ type: 'menu_action', itemId })
      return
    }

    if (ev.textEvent) {
      const t = ev.textEvent.eventType
      if (t === OsEventTypeList.SCROLL_TOP_EVENT) {
        if (this.dedupe(`text:1`, SCROLL_DEDUPE_MS)) this.emit({ type: 'previous', source: 'unknown' })
      } else if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
        if (this.dedupe(`text:2`, SCROLL_DEDUPE_MS)) this.emit({ type: 'next', source: 'unknown' })
      }
      return
    }

    if (ev.listEvent) {
      const idx = ev.listEvent.currentSelectItemIndex ?? 0 // protobuf zero-omission
      if (!this.dedupe(`list:${ev.listEvent.containerID ?? 0}:${idx}`)) return
      this.emit({ type: 'list_select', index: idx })
      return
    }

    if (ev.sysEvent) {
      const t = ev.sysEvent.eventType ?? OsEventTypeList.CLICK_EVENT // omitted 0 = click (G10)
      const src: InputSource = ev.sysEvent.eventSource ?? 'unknown'
      switch (t) {
        case OsEventTypeList.CLICK_EVENT:
          if (this.dedupe(`sys:0:${src}`)) this.armSelect(src)
          return
        case OsEventTypeList.DOUBLE_CLICK_EVENT:
          if (!this.dedupe(`sys:3:${src}`)) return
          this.cancelSelect()
          this.emit({ type: 'back', source: src })
          return
        case OsEventTypeList.FOREGROUND_ENTER_EVENT:
          this.emit({ type: 'foreground' })
          return
        case OsEventTypeList.FOREGROUND_EXIT_EVENT:
          this.emit({ type: 'background' })
          return
        case OsEventTypeList.ABNORMAL_EXIT_EVENT:
          this.emit({ type: 'exit', abnormal: true })
          return
        case OsEventTypeList.SYSTEM_EXIT_EVENT:
          this.emit({ type: 'exit', abnormal: false })
          return
        case OsEventTypeList.LONG_PRESS_EVENT:
          if (!this.dedupe(`sys:9:${src}`)) return
          this.cancelSelect() // a sustained press supersedes a pending tap
          this.emit({ type: 'hold_start', source: src })
          return
        case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
          if (!this.dedupe(`sys:10:${src}`)) return
          this.emit({ type: 'hold_release', source: src })
          return
        default:
          return // IMU and anything else is not an input command
      }
    }
  }

  private armSelect(source: InputSource): void {
    if (this.pendingSelect) return
    this.pendingSource = source
    this.pendingSelect = setTimeout(() => {
      this.pendingSelect = null
      this.emit({ type: 'select', source: this.pendingSource })
    }, this.opts.doubleTapWindowMs)
  }

  private cancelSelect(): void {
    if (this.pendingSelect) {
      clearTimeout(this.pendingSelect)
      this.pendingSelect = null
    }
  }

  /** Drop identical re-deliveries inside the dedupe window (G13). */
  private dedupe(sig: string, windowMs = this.opts.dedupeMs): boolean {
    const now = Date.now()
    if (sig === this.lastSig && now - this.lastSigAt < windowMs) return false
    this.lastSig = sig
    this.lastSigAt = now
    return true
  }

  dispose(): void {
    this.cancelSelect()
  }
}
