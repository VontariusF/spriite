/**
 * HUD renderer (spec §11.3, §11.5). Converts validated views into SDK
 * containers: the first page is created exactly once; later layout changes
 * rebuild; same-layout updates are flicker-free in-place text upgrades. One
 * serialized image queue with per-container coalescing sends the progress bar
 * (id 4) before sprite frames (id 5); sprite frames travel on the gateway's
 * low-priority lane so motion can never delay text or progress. The renderer
 * draws what the scene says — it never computes progress or invents copy. A
 * text-only fallback always remains usable.
 */
import {
  CreateStartUpPageContainer,
  ImageRawDataUpdate,
  RebuildPageContainer,
  TextContainerUpgrade,
  validateEvenHubPageContainer,
} from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'
import type { BridgeGateway } from '../bridge/bridge'
import type { EngineView } from '../factory/demo'
import type { Scene, SceneAction, SpritePose } from '../scenes/types'
import { SpriteAnimator } from '../sprite/animator'
import { framePixels, type FrameName, type Lift } from '../sprite/frames'
import {
  CT,
  type Layout,
  type LayoutName,
  conversationLayout,
  listeningLayout,
  selectionLayout,
} from './layout'
import { progressPixels, progressSignature } from './progress'

const ACTION_GAP = '   '
const BLANK_BAR: number[] = new Array<number>(256 * 20).fill(0)

/** Result of ensureLayout: same layout updated in place, full page (re)sent, or failed. */
type EnsureStatus = 'same' | 'rebuilt' | 'fail'

export function buildActionsText(actions: SceneAction[], focusIdx: number): string {
  if (actions.length === 0) return ''
  const parts = actions.map((a, i) => (i === focusIdx ? `> ${a.label}` : a.label))
  const joined = parts.join(ACTION_GAP)
  if (getTextWidth(joined) <= 528) return joined
  // Fallback: focused action only — never clip a label mid-word.
  const only = `> ${actions[focusIdx].label}`
  return getTextWidth(only) <= 528 ? only : '> More'
}

export class Renderer {
  private started = false
  private layoutName: LayoutName | null = null
  private texts = new Map<number, string>()
  private frameSent: string | null = null
  private barSigSent = ''
  private hasBar = false
  private includeMenu = true
  private queuedImages = new Map<number, { name: string; data: number[] }>()
  private pumping = false
  private pumpPromise: Promise<void> = Promise.resolve()
  private readonly gateway: BridgeGateway
  /** Owns sprite timing; draws through showFrame on the low-priority lane. */
  private readonly animator = new SpriteAnimator((frame, lift) => this.showFrame(frame, lift))

  constructor(gateway: BridgeGateway) {
    this.gateway = gateway
  }

  /** Present an engine view (scene or selection). */
  async present(view: EngineView, focusIdx: number): Promise<void> {
    const layout = this.layoutFor(view, focusIdx)
    const status = await this.ensureLayout(layout)
    if (status === 'fail') return
    const pose: SpritePose = view.type === 'scene' ? view.scene.spritePose : view.pose
    if (view.type === 'scene') this.syncImages(view.scene) // bar first (id 4 < 5)
    // force after a page (re)send: the fresh image containers are blank.
    this.animator.setPose(pose, { force: status === 'rebuilt' })
  }

  /** Local capture layout — only entered after the mic actually started. */
  async presentListening(
    pose: SpritePose,
    hint: string,
    timerText: string,
    noteText: string,
    contextLabel = 'LISTENING (DEMO)',
  ): Promise<void> {
    const layout = listeningLayout({
      contextLabel,
      hint,
      timerText,
      noteText,
    })
    const status = await this.ensureLayout(layout)
    if (status === 'fail') return
    this.animator.setPose(pose, { force: status === 'rebuilt' })
  }

  /** Flicker-free focus change (spec §6.1: exactly one focused action). */
  async updateActions(scene: Scene, focusIdx: number): Promise<void> {
    if (this.layoutName !== 'conversation') return
    await this.setText(CT.actions.id, CT.actions.name, buildActionsText(scene.actions, focusIdx))
  }

  /** Capture timer line — at most one upgrade per second, never per frame. */
  async updateCaptureTimer(timerText: string): Promise<void> {
    if (this.layoutName !== 'listening') return
    await this.setText(CT.timer.id, CT.timer.name, timerText)
  }

  /** Live STT caption on the hint line (already throttled and fitted). */
  async updateListeningHint(text: string): Promise<void> {
    if (this.layoutName !== 'listening') return
    await this.setText(CT.hint.id, CT.hint.name, text)
  }

  /**
   * Toggle sprite static mode (context menu). In static mode each pose shows
   * only its key frame: no timers, no repeated image traffic.
   */
  toggleSpriteMotion(): boolean {
    return this.animator.toggleStatic()
  }

  /** Next present() re-sends the full page (the host may have wiped it). */
  invalidatePage(): void {
    this.layoutName = null
  }

  /** Halt sprite animation; nothing further is queued (app teardown). */
  stop(): void {
    this.animator.stop()
  }

  private layoutFor(view: EngineView, focusIdx: number): Layout {
    if (view.type === 'scene') {
      return conversationLayout({
        contextLabel: view.scene.contextLabel,
        utterance: view.scene.utterance,
        status: view.scene.status,
        actionsText: buildActionsText(view.scene.actions, focusIdx),
        hasProgress: view.scene.progress !== null,
      })
    }
    return selectionLayout({ contextLabel: view.contextLabel, title: view.title, items: view.items })
  }

  /**
   * Make `layout` the live page. The first send uses the one-shot startup
   * call; if the host already holds a startup page (e.g. the WebView
   * reloaded), fall back to a rebuild. Same-layout updates diff text in place.
   */
  private async ensureLayout(layout: Layout): Promise<EnsureStatus> {
    if (this.started && this.layoutName === layout.name) {
      this.hasBar = layout.hasProgress
      await this.diffText(layout)
      return 'same'
    }
    let ok = false
    if (!this.started) {
      ok = await this.sendPage(layout, 'create')
      if (!ok) {
        console.warn('[render] startup create rejected; host page may already exist, rebuilding')
        ok = await this.sendPage(layout, 'rebuild')
      }
      this.started = ok
    } else {
      ok = await this.sendPage(layout, 'rebuild')
    }
    if (!ok) return 'fail'
    this.adoptLayout(layout)
    return 'rebuilt'
  }

  private async sendPage(layout: Layout, mode: 'create' | 'rebuild'): Promise<boolean> {
    const trySend = async (withMenu: boolean): Promise<boolean> => {
      const p = layout.payload
      const payload = {
        containerTotalNum: p.containerTotalNum,
        textObject: p.textObject,
        listObject: p.listObject,
        imageObject: p.imageObject,
        ...(withMenu ? { menuObject: p.menuObject } : {}),
      }
      const check = validateEvenHubPageContainer(payload)
      if (check.valid !== true) {
        console.warn('[render] page validation failed:', check.code, check.message)
        return false
      }
      if (mode === 'create') {
        const res = await this.gateway.call((b) =>
          b.createStartUpPageContainer(new CreateStartUpPageContainer(payload)),
        `create:${layout.name}`)
        return res === 0
      }
      const res = await this.gateway.call((b) =>
        b.rebuildPageContainer(new RebuildPageContainer(payload)),
      `rebuild:${layout.name}`)
      return res === true
    }

    let ok = await trySend(this.includeMenu)
    if (ok !== true && this.includeMenu) {
      // The contextual menu is version-gated (spec §5.4). Drop it only if a
      // menu-less page then succeeds, so an unrelated failure keeps the menu (G30).
      ok = await trySend(false)
      if (ok === true) {
        this.includeMenu = false
        console.warn('[render] page rejected with menu, accepted without; menu disabled (G30)')
      }
    }
    if (ok !== true) {
      console.error('[render] page send failed:', layout.name, mode)
      return false
    }
    return true
  }

  /** After a successful page send: remember layout facts; images resend. */
  private adoptLayout(layout: Layout): void {
    this.layoutName = layout.name
    this.hasBar = layout.hasProgress
    this.texts.clear()
    for (const t of layout.payload.textObject ?? []) {
      this.texts.set(t.containerID ?? 0, t.content ?? '')
    }
    for (const l of layout.payload.listObject ?? []) {
      this.texts.set(l.containerID ?? 0, (l.itemContainer?.itemName ?? []).join('\n'))
    }
    // Everything queued before the page send belonged to the previous page.
    this.queuedImages.clear()
    this.frameSent = null
    this.barSigSent = ''
  }

  private async diffText(layout: Layout): Promise<void> {
    for (const t of layout.payload.textObject ?? []) {
      await this.setText(t.containerID ?? 0, t.containerName ?? '', t.content ?? '')
    }
  }

  private async setText(id: number, name: string, content: string): Promise<void> {
    if (this.texts.get(id) === content) return
    this.texts.set(id, content)
    if (content.length > 2000) return // upgrade limit; the validator keeps us far below
    await this.gateway.call((b) =>
      b.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: id,
          containerName: name,
          content,
          contentOffset: 0,
          contentLength: 0,
        }),
      ),
      `text:${name}`,
    )
  }

  /** Queue the progress bar image when its composed signature changed. */
  private syncImages(scene: Scene): void {
    if (!scene.progress || !this.hasBar) {
      // Same-layout cards keep the bar container; blank it so a card without
      // progress never shows a stale bar ('' = container known blank).
      if (this.barSigSent !== '' && this.layoutName === 'conversation') {
        this.barSigSent = ''
        this.queuedImages.set(CT.bar.id, { name: CT.bar.name, data: BLANK_BAR })
        void this.pumpImages()
      }
      return
    }
    const sig = progressSignature(scene.progress)
    if (sig === this.barSigSent) return
    this.barSigSent = sig
    this.queuedImages.set(CT.bar.id, { name: CT.bar.name, data: progressPixels(scene.progress) })
    void this.pumpImages()
  }

  /**
   * Show one sprite frame. Deduplicated per frame; resolves once the frame
   * has been sent (or superseded by a newer frame for the same container), so
   * the animator never queues two frames at once.
   */
  private async showFrame(frame: FrameName, lift: Lift): Promise<void> {
    const key = `${frame}@${lift}`
    if (this.frameSent === key) return
    this.frameSent = key
    this.queuedImages.set(CT.sprite.id, { name: CT.sprite.name, data: framePixels(frame, lift) })
    await this.pumpImages()
  }

  /**
   * Serialized image pump (spec §11.5): strictly one updateImageRawData in
   * flight; superseded frames are coalesced away; lowest container id first
   * (bar 4 before sprite 5: important state before decorative motion). All
   * image traffic uses the low-priority bridge lane. Callers await the same
   * in-flight drain, so an awaited item is always sent (or replaced) before
   * the returned promise resolves.
   */
  private pumpImages(): Promise<void> {
    if (this.pumping) return this.pumpPromise
    this.pumping = true
    this.pumpPromise = this.runPump()
    return this.pumpPromise
  }

  private async runPump(): Promise<void> {
    try {
      while (this.queuedImages.size > 0) {
        const id = Math.min(...this.queuedImages.keys())
        const item = this.queuedImages.get(id)
        this.queuedImages.delete(id)
        if (!item) continue
        const ok = await this.gateway.call(
          (b) =>
            b.updateImageRawData(
              new ImageRawDataUpdate({
                containerID: id,
                containerName: item.name,
                imageData: item.data,
              }),
            ),
          `image:${item.name}`,
          5000,
          'lo',
        )
        if (ok !== 'success') {
          console.warn('[render] image update rejected:', id, ok, `${item.data.length} px`)
        }
      }
    } finally {
      this.pumping = false
    }
  }
}
