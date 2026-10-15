/**
 * HUD renderer (spec §11.3, §11.5). Converts validated views into SDK
 * containers: the first page is created exactly once; later layout changes
 * rebuild; same-layout updates (same geometry key) are flicker-free in-place
 * text upgrades. One serialized image queue with per-container coalescing
 * sends the milestone bar halves (ids 4, 11) before sprite frames (id 5);
 * sprite frames travel on the gateway's
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
import type { EngineView } from '../factory/view'
import { COPY } from '../factory/copy'
import type { Scene, SceneAction, SpritePose } from '../scenes/types'
import { SpriteAnimator } from '../sprite/animator'
import { framePixels, type FrameName, type Lift } from '../sprite/frames'
import { toPose } from '../sprite/poses'
import {
  CT,
  type Layout,
  type LayoutName,
  type HistoryContent,
  actionRow,
  composeContextLine,
  conversationLayout,
  historyLayout,
  listeningLayout,
  optionRows,
  selectionLayout,
} from './layout'
import {
  HALF_H,
  HALF_W,
  captureBarPixels,
  captureFraction,
  milestoneMarks,
  segmentBarPixels,
  segmentSignature,
  splitHalves,
} from './progress'

const ACTION_GAP = '   '
const BLANK_HALF: number[] = new Array<number>(HALF_W * HALF_H).fill(0)

/** Image send order: the bar halves (important state) before the sprite. */
function imageRank(id: number): number {
  if (id === CT.bar.id) return 0
  if (id === CT.bar2.id) return 1
  if (id === CT.sprite.id) return 2
  return 3 + id
}

/** Scene kinds whose card is the Run board (‹ › swipe hints on the actions row). */
const RUN_KINDS: ReadonlySet<Scene['kind']> = new Set([
  'running', 'under_review', 'repair', 'accepted', 'regression', 'paused',
])

/** Does this card draw the Run board's ‹ › swipe hints? */
export function sceneHasSwipeHints(scene: Scene): boolean {
  return scene.progress !== null && RUN_KINDS.has(scene.kind) && scene.actions.length > 1
}

/** The context-line detail a scene shows (the producer's, else none). */
function sceneDetail(scene: Scene): string {
  return typeof scene.contextDetail === 'string' ? scene.contextDetail : ''
}

/** The question page's footer for a selection purpose. */
export function selectionFooter(purpose: Extract<EngineView, { type: 'selection' }>['purpose']): string {
  if (purpose === 'decision') return COPY.hud.askFooter
  // Milestones and evidence rows open nothing: a tap closes the list.
  if (purpose === 'plan_detail' || purpose === 'evidence') return COPY.hud.readFooter
  return COPY.hud.listFooter
}

/**
 * Decision cards (the build and PR gates, a question without options) are the HudAsk board: the question on top, the actions
 * as option rows, the ask footer; no bar and no status line.
 */
export function sceneIsAsk(scene: Scene): boolean {
  return scene.kind === 'decision'
}

/** Result of ensureLayout: same layout updated in place, full page (re)sent, or failed. */
type EnsureStatus = 'same' | 'rebuilt' | 'fail'

/**
 * Legacy one-line actions text ('> ' cursor), kept as the text-only
 * fallback. The HUD draws actionRow() (bordered focused box, dimmed rest).
 */
export function buildActionsText(actions: SceneAction[], focusIdx: number): string {
  if (actions.length === 0) return ''
  // Clamp like the rows window does: a stale focus index (a restored snapshot,
  // a card swap between the scroll and the draw) must never index past the end.
  const focus = Math.max(0, Math.min(actions.length - 1, focusIdx))
  const parts = actions.map((a, i) => (i === focus ? `> ${a.label}` : a.label))
  const joined = parts.join(ACTION_GAP)
  if (getTextWidth(joined) <= 528) return joined
  // Fallback: focused action only — never clip a label mid-word.
  const only = `> ${actions[focus].label}`
  return getTextWidth(only) <= 528 ? only : '> More'
}

/** Does this page define the sprite container the animator draws into? */
function pageHasSprite(layout: Layout): boolean {
  return (layout.payload.imageObject ?? []).some((c) => c.containerID === CT.sprite.id)
}

/** Does this page define the bar containers (conversation and listening do)? */
function pageHasBar(layout: Layout): boolean {
  return (layout.payload.imageObject ?? []).some((c) => c.containerID === CT.bar.id)
}

interface BarImage {
  left: number[]
  right: number[]
  sig: string
}

const BLANK_BAR_IMAGE: BarImage = { left: BLANK_HALF, right: BLANK_HALF, sig: '' }

export class Renderer {
  private started = false
  private layoutName: LayoutName | null = null
  /** Geometry key of the adopted page (same key: in-place text upgrades). */
  private layoutKey: string | null = null
  /** The listening page's context label (the timer redraws the line with it). */
  private listenLabel = ''
  /** Signature of the capture bar the surface holds, per half. */
  private captureSent: [string, string] = ['', '']
  /** The pose the live page's view asks for (drawn unless overridden). */
  private pagePose: SpritePose = 'idle'
  /** A pose that outranks the page's own (a spoken reply playing: talking). */
  private poseOverride: SpritePose | null = null
  /**
   * Page invalidation, generation-style. invalidatePage() bumps `pageGen`; a
   * present remembers the generation it set out to deliver and records it in
   * `pageGenSent` only after a full page send succeeded. A present that was
   * already in flight when the host wiped our page therefore cannot cancel
   * the invalidation when it lands — the generation it carries is stale, so
   * the next present re-sends the whole page instead of assuming the old page
   * still stands (a wiped page would otherwise stay undrawn).
   */
  private pageGen = 0
  private pageGenSent = -1
  private texts = new Map<number, string>()
  /** The newest text upgrade sent per container and not yet answered. */
  private inflightText = new Map<number, string>()
  /** Rows under the focused option on the live question page. */
  private restRows = 3
  /** The full selection the HUD last drew (the rows text is a windowed view). */
  private shown: { title: string; items: string[] } | null = null
  private frameSent: string | null = null
  /** Signature of the bar the surface is known to hold ('' = known blank). */
  private barSigSent: string | null = ''
  /**
   * The bar image the live page intends (progress or blank). The bar has no
   * animator of its own, so this is what a reattach repaints it from.
   */
  private lastBar: BarImage | null = null
  private hasBar = false
  /** The adopted page defines a sprite container (the reading page does not). */
  private hasSprite = false
  private includeMenu = true
  /** The display surface is currently attached (drives the reattach repaint). */
  private surfaceOn = true
  /** The host took the page down (exit request): nothing draws until a present. */
  private pageGone = false
  /**
   * A full page send is in flight. The host page is being replaced, so
   * targeted text updates (which guard on the last ADOPTED layout) and
   * same-layout diffs must wait: container ids are reused across layouts
   * with different meanings (hint 8 is the history body and the capture
   * hint line), and a stale write landing after the rebuild would put one
   * page's words on another page. A present that starts while another is
   * still sending waits for it first, then re-decides against the state the
   * finished send left — so it never rebuilds a page it could have diffed.
   */
  private sending = false
  /** Resolves when the in-flight page send (if any) has fully settled. */
  private sendChain: Promise<void> = Promise.resolve()
  private queuedImages = new Map<number, {
    name: string
    data: number[]
    /** Sprite dedupe key (frame@lift), to reopen on a failed transfer. */
    key?: string
    /** Bar signature the surface is believed to hold, to reopen on failure. */
    sig?: string | null
    /** Failed-transfer retry count (bounded at one). */
    attempts?: number
  }>()
  private pumping = false
  private pumpPromise: Promise<void> = Promise.resolve()
  private readonly gateway: BridgeGateway
  /** Owns sprite timing; draws through showFrame on the low-priority lane. */
  private readonly animator = new SpriteAnimator((frame, lift) => this.showFrame(frame, lift))

  constructor(gateway: BridgeGateway) {
    this.gateway = gateway
  }

  /**
   * Present an engine view (scene or selection). Resolves true when the page
   * landed; false when the host refused the page (a send that answered
   * 'fail' instead of throwing — callers that own a mode on the display,
   * like the chat reader, roll back on false instead of trusting an open
   * that never drew).
   */
  async present(view: EngineView, focusIdx: number): Promise<boolean> {
    this.animator.setStatic(false) // leave the history page's pinned frame
    const layout = this.layoutFor(view, focusIdx)
    const status = await this.ensureLayout(layout)
    if (status === 'fail') return false
    this.pageBack()
    this.shown = view.type === 'selection' ? { title: view.title, items: [...view.items] } : null
    // The renderer always draws one of the twelve poses; legacy tags map
    // through the MotionLab moments (LEGACY_POSE_MAP).
    this.pagePose = toPose(view.type === 'scene' ? view.scene.spritePose : view.pose)
    if (view.type === 'scene') this.syncImages(view.scene) // bar first (ids 4, 11 before 5)
    // force after a page (re)send: the fresh image containers are blank.
    this.animator.setPose(this.poseOverride ?? this.pagePose, { force: status === 'rebuilt' })
    return true
  }

  /** Local capture layout — only entered after the mic actually started. */
  async presentListening(
    pose: SpritePose,
    hint: string,
    timerText: string,
    noteText: string,
    contextLabel = 'LISTENING',
    actions: readonly string[] = COPY.listening.actions,
  ): Promise<boolean> {
    // Capture is not the reading page: unpin its static sprite so the
    // listening pose animates even when the page before it was the reader
    // (present() does the same for every other layout).
    this.animator.setStatic(false)
    const layout = listeningLayout({
      contextLabel,
      hint,
      timerText,
      noteText,
      actions,
    })
    const status = await this.ensureLayout(layout)
    if (status === 'fail') return false
    this.pageBack()
    this.listenLabel = contextLabel
    if (status === 'rebuilt') this.captureSent = ['', '']
    this.syncCaptureBar(timerText) // the dim track shows from the first frame
    this.pagePose = toPose(pose)
    this.animator.setPose(this.pagePose, { force: status === 'rebuilt' })
    return true
  }

  /**
   * The chat-history page (a local overlay): the ring pages the body, a
   * press closes it. No sprite or bar — the reading surface stays text-only.
   * Resolves false when the host refused the page, so the caller can roll
   * its reader-open state back instead of paging a page that never drew.
   */
  async presentHistory(h: HistoryContent): Promise<boolean> {
    // The reading page has no sprite container: pin the pose so the hover
    // loop never pumps frames to a container that is not there.
    this.animator.setStatic(true)
    const layout = historyLayout(h)
    const status = await this.ensureLayout(layout)
    if (status !== 'fail') this.pageBack()
    return status !== 'fail'
  }

  /** Flicker-free page turn on the open chat-history body. */
  async updateHistoryBody(bodyText: string, footerText: string): Promise<void> {
    if (this.sending || this.layoutName !== 'history') return
    await this.setText(CT.hint.id, CT.hint.name, bodyText)
    await this.setText(CT.note.id, CT.note.name, footerText)
  }

  /**
   * Flicker-free focus change (spec §6.1: exactly one focused action). The
   * box keeps its size for the card's label set, so a ring tick turns the
   * carousel in place: the focused label in the box, the rest after it.
   */
  async updateActions(scene: Scene, focusIdx: number): Promise<void> {
    if (sceneIsAsk(scene)) {
      // The HudAsk card's actions are its option rows.
      await this.updateSelectionRows(scene.actions.map((a) => a.label), focusIdx)
      return
    }
    if (this.sending || this.layoutName !== 'conversation') return
    const labels = scene.actions.map((a) => a.label)
    const row = actionRow(labels, focusIdx, sceneHasSwipeHints(scene) && labels.length > 0)
    await this.setText(CT.actions.id, CT.actions.name, row.box)
    if (this.sending || this.layoutName !== 'conversation') return
    await this.setText(CT.rest.id, CT.rest.name, row.rest)
  }

  /**
   * Capture timer — at most one upgrade per second, never per frame: the
   * context line's detail and the capture bar (only the half that changed).
   */
  async updateCaptureTimer(timerText: string): Promise<void> {
    if (this.sending || this.layoutName !== 'listening') return
    await this.setText(CT.ctx.id, CT.ctx.name, composeContextLine(this.listenLabel, timerText))
    if (this.sending || this.layoutName !== 'listening') return
    this.syncCaptureBar(timerText)
  }

  /**
   * Live STT caption (already throttled, fitted and quoted) and, when given,
   * the small line above it ('You said' once words arrive).
   */
  async updateListeningHint(text: string, label?: string): Promise<void> {
    if (this.sending || this.layoutName !== 'listening') return
    if (label !== undefined) {
      await this.setText(CT.note.id, CT.note.name, label)
      if (this.sending || this.layoutName !== 'listening') return
    }
    await this.setText(CT.hint.id, CT.hint.name, text)
  }

  /**
   * A pose that outranks the page's own while it holds (resolvePose with
   * speaking: a spoken reply is playing, so Spriite talks). null restores
   * the page's pose. Capture keeps listening: the override never reaches the
   * listening page.
   */
  setPoseOverride(pose: SpritePose | null): void {
    const next = pose === null ? null : toPose(pose)
    if (next === this.poseOverride) return
    this.poseOverride = next
    if (this.layoutName === 'listening' || this.layoutName === 'history') return
    this.animator.setPose(next ?? this.pagePose)
  }

  /**
   * Toggle reduce motion (context menu). Each pose holds its key frame: no
   * timers, no repeated image traffic. Returns true when motion is reduced.
   */
  toggleSpriteMotion(): boolean {
    this.animator.setReduceMotion(!this.animator.isReduceMotion)
    return this.animator.isReduceMotion
  }

  /**
   * Reduce motion (spec §18): no hover, sway, pulses, or accessory
   * alternation, while the semantic pose and all text stay as they are.
   */
  setReduceMotion(on: boolean): void {
    this.animator.setReduceMotion(on)
  }

  /**
   * The display surface attached or detached (spec §18: "stop image animation
   * when no display surface is attached"). Runtime and domain work continue.
   */
  setSurfaceAttached(on: boolean): void {
    const was = this.surfaceOn
    this.surfaceOn = on
    if (on) {
      // A surface that went away may come back blank: the repaint must not
      // be deduped against what the detached surface last held. The frame
      // dedupe reopens for the animator's own repaint; the bar has no
      // animator, so the last bar the page intended is re-sent here too —
      // otherwise a blank-returned bar reads as zero progress until the next
      // signature change.
      this.frameSent = null
      if (!was && this.lastBar) {
        this.barSigSent = this.lastBar.sig
        this.queueBar(this.lastBar)
      }
    }
    this.animator.setSurfaceAttached(on && !this.pageGone)
  }

  /**
   * The full rows of the selection page currently on the HUD (the rows text
   * is a windowed slice; a pick's index refers to these full rows, which can
   * lag the engine's newest list).
   */
  shownListItems(): string[] | null {
    return this.layoutName === 'selection' ? this.shown?.items ?? null : null
  }

  /** The exact title and full rows of the selection page on the HUD. */
  shownSelection(): { title: string; items: string[] } | null {
    return this.layoutName === 'selection' ? this.shown : null
  }

  /**
   * Flicker-free cursor move on the options (one ring tick, one row): the
   * focused option in the bordered row, the next ones under it.
   */
  async updateSelectionRows(items: string[], focusIdx: number): Promise<void> {
    if (this.sending || this.layoutName !== 'selection') return
    const rows = optionRows(items, focusIdx, this.restRows)
    await this.setText(CT.list.id, CT.list.name, rows.focus)
    if (this.sending || this.layoutName !== 'selection') return
    await this.setText(CT.rest.id, CT.rest.name, rows.rest)
  }

  /**
   * The host took our page down (the root exit request, spec §5.1): stop all
   * image traffic and forget the page. The next present re-sends it whole and
   * restarts the sprite.
   */
  markPageGone(): void {
    this.pageGone = true
    this.invalidatePage()
    this.queuedImages.clear()
    this.animator.setSurfaceAttached(false)
  }

  /** A present landed a whole page again after markPageGone(). */
  private pageBack(): void {
    if (!this.pageGone) return
    this.pageGone = false
    this.frameSent = null
    this.animator.setSurfaceAttached(this.surfaceOn)
  }

  /** Next present() re-sends the full page (the host may have wiped it). */
  invalidatePage(): void {
    this.layoutName = null
    this.layoutKey = null
    this.pageGen += 1
  }

  /** Halt sprite animation; nothing further is queued (app teardown). */
  stop(): void {
    this.animator.stop()
  }

  private layoutFor(view: EngineView, focusIdx: number): Layout {
    if (view.type === 'scene' && sceneIsAsk(view.scene)) {
      const scene = view.scene
      return selectionLayout({
        contextLabel: scene.contextLabel,
        contextDetail: sceneDetail(scene),
        title: scene.utterance,
        items: scene.actions.map((a) => a.label),
        focusIdx,
        footer: COPY.hud.askFooter,
      })
    }
    if (view.type === 'scene') {
      const scene = view.scene
      return conversationLayout({
        contextLabel: scene.contextLabel,
        contextDetail: sceneDetail(scene),
        utterance: scene.utterance,
        status: scene.status,
        actions: scene.actions.map((a) => a.label),
        focusIdx,
        hints: sceneHasSwipeHints(scene),
        hasProgress: scene.progress !== null,
      })
    }
    return selectionLayout({
      contextLabel: view.contextLabel,
      contextDetail: view.contextDetail ?? '',
      title: view.title,
      items: view.items,
      focusIdx,
      footer: selectionFooter(view.purpose),
    })
  }

  /**
   * Make `layout` the live page. The first send uses the one-shot startup
   * call; if the host already holds a startup page (e.g. the WebView
   * reloaded), fall back to a rebuild. Same-layout updates diff text in place.
   * A pending invalidation (invalidatePage) always forces a full re-send, even
   * when the layout name already matches — and so does an in-flight page send:
   * a present that starts while another is still replacing the host page must
   * not take the in-place path against a page that is about to be gone.
   */
  private async ensureLayout(layout: Layout): Promise<EnsureStatus> {
    const wantGen = this.pageGen
    // Selection rows are app-managed text now: a changed list is a text
    // upgrade, not a page rebuild, so every selection update is flicker-free.
    if (
      !this.sending && this.started && this.pageGenSent === wantGen &&
      this.layoutName === layout.name && this.layoutKey === layout.key
    ) {
      this.hasBar = layout.hasProgress
      this.hasSprite = pageHasSprite(layout)
      await this.diffText(layout)
      return 'same'
    }
    if (this.sending) {
      // Another present is still replacing the host page: wait for it, then
      // re-decide. Taking the in-place path against a page that is about to
      // be gone would strand this present's text on the next page's reused
      // container ids; sending immediately would queue a redundant rebuild
      // that the finished send may already have made unnecessary.
      await this.sendChain
      return this.ensureLayout(layout)
    }
    let ok = false
    let rebuilt = false
    let settle: () => void = () => {}
    this.sending = true
    this.sendChain = new Promise<void>((resolve) => { settle = resolve })
    try {
      if (!this.started) {
        ok = await this.sendPage(layout, 'create')
        if (!ok) {
          console.warn('[render] startup create rejected; host page may already exist, rebuilding')
          rebuilt = true
          ok = await this.sendPage(layout, 'rebuild')
        }
        this.started = ok
      } else {
        rebuilt = true
        ok = await this.sendPage(layout, 'rebuild')
      }
      if (!ok) return 'fail' // pageGenSent stays stale: the next present re-sends
      this.adoptLayout(layout)
      this.pageGenSent = wantGen // the whole page just went through
      // Rebuilds can reuse text container IDs across layouts. Upgrade the text
      // after the new page is installed so the host cannot retain the previous
      // page's title (notably the conversation -> question-list transition).
      if (rebuilt) await this.diffText(layout, true)
    } finally {
      this.sending = false
      settle()
    }
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
    this.layoutKey = layout.key
    this.restRows = layout.restRows ?? 3
    this.hasBar = layout.hasProgress
    this.hasSprite = pageHasSprite(layout)
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
    // A host may keep an image container's old pixels across a rebuild that
    // reuses its id: after a page that drew a bar, the bar state is unknown
    // (null) so the next card blanks or redraws it explicitly.
    this.barSigSent = this.barSigSent === '' ? '' : null
    this.captureSent = ['', '']
    // A fresh page's image containers are blank; that is what a reattach
    // repaints the bar from when the page defines one.
    this.lastBar = pageHasBar(layout) ? BLANK_BAR_IMAGE : null
  }

  private async diffText(layout: Layout, force = false): Promise<void> {
    for (const t of layout.payload.textObject ?? []) {
      await this.setText(t.containerID ?? 0, t.containerName ?? '', t.content ?? '', force)
    }
  }

  private async setText(id: number, name: string, content: string, force = false): Promise<void> {
    // Dedupe against what the host holds AND what is still on its way: a
    // different write still in flight for this container lands after the
    // check, so skipping here would leave that older text on screen.
    const pending = this.inflightText.get(id)
    if (!force && this.texts.get(id) === content && (pending === undefined || pending === content)) return
    if (content.length > 2000) return // upgrade limit; the validator keeps us far below
    this.inflightText.set(id, content)
    const ok = await this.gateway.call((b) =>
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
    if (this.inflightText.get(id) === content) this.inflightText.delete(id)
    // Record only what the host accepted. Recording before the send wedged the
    // dedupe on a rejected or timed-out upgrade, leaving that container stale
    // until its content happened to change; a retried duplicate upgrade is
    // harmless, so failing open is safe.
    if (ok === true) {
      this.texts.set(id, content)
      return
    }
    // A forced upgrade (right after a rebuild) was pre-recorded by
    // adoptLayout because the page send carried the same content; the host
    // never took it, so re-open that slot too — otherwise the dedupe treats
    // the never-delivered text as shown and the container keeps the previous
    // page's words until its content happens to change.
    if (force) this.texts.delete(id)
  }

  /** Queue both halves of a bar image (left id 4, right id 11). */
  private queueBar(bar: BarImage): void {
    this.queuedImages.set(CT.bar.id, { name: CT.bar.name, data: bar.left, sig: bar.sig })
    this.queuedImages.set(CT.bar2.id, { name: CT.bar2.name, data: bar.right, sig: bar.sig })
    void this.pumpImages()
  }

  /**
   * Queue the milestone bar when its marks changed (done solid, in review
   * dotted, remaining dim; from progress.milestones or the weights).
   */
  private syncImages(scene: Scene): void {
    if (!scene.progress || !this.hasBar) {
      // Same-layout cards keep the bar containers; blank them so a card
      // without progress never shows a stale bar ('' = known blank).
      if (this.barSigSent !== '' && this.layoutName === 'conversation') {
        this.barSigSent = ''
        this.lastBar = BLANK_BAR_IMAGE
        this.queueBar(BLANK_BAR_IMAGE)
      }
      return
    }
    const sig = segmentSignature(scene.progress)
    if (sig === this.barSigSent) return
    this.barSigSent = sig
    const [left, right] = splitHalves(segmentBarPixels(milestoneMarks(scene.progress)))
    const bar = { left, right, sig }
    this.lastBar = bar
    this.queueBar(bar)
  }

  /** The listening page's capture bar: only a half whose fill changed is sent. */
  private syncCaptureBar(timerText: string): void {
    if (this.layoutName !== 'listening') return
    const [left, right] = splitHalves(captureBarPixels(captureFraction(timerText)))
    const sigs: [string, string] = [left.join(''), right.join('')]
    const sig = `capture:${sigs[0].length}:${captureFraction(timerText).toFixed(3)}`
    this.lastBar = { left, right, sig }
    this.barSigSent = sig
    let queued = false
    if (sigs[0] !== this.captureSent[0]) {
      this.captureSent[0] = sigs[0]
      this.queuedImages.set(CT.bar.id, { name: CT.bar.name, data: left, sig })
      queued = true
    }
    if (sigs[1] !== this.captureSent[1]) {
      this.captureSent[1] = sigs[1]
      this.queuedImages.set(CT.bar2.id, { name: CT.bar2.name, data: right, sig })
      queued = true
    }
    if (queued) void this.pumpImages()
  }

  /**
   * Show one sprite frame. Deduplicated per frame; resolves once the frame
   * has been sent (or superseded by a newer frame for the same container), so
   * the animator never queues two frames at once.
   */
  private async showFrame(frame: FrameName, lift: Lift): Promise<void> {
    const key = `${frame}@${lift}`
    if (this.frameSent === key) return
    // No page, no sprite container: drop the frame instead of sending it into
    // the void (a reduce-motion preference applied during boot, before the
    // first present, or a reattach while the reading page — which defines no
    // image container — is up). The next present always re-pins the pose, so
    // nothing is lost: the page that has the container paints its key frame.
    if (!this.started || !this.hasSprite || this.pageGone) {
      this.frameSent = null
      return
    }
    this.frameSent = key
    this.queuedImages.set(CT.sprite.id, { name: CT.sprite.name, data: framePixels(frame, lift), key })
    await this.pumpImages()
  }

  /**
   * Serialized image pump (spec §11.5): strictly one updateImageRawData in
   * flight; superseded frames are coalesced away; the bar halves (ids 4 and
   * 11) go before the sprite (5): important state before decorative motion. All
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
      while (this.queuedImages.size > 0 && !this.pageGone) {
        let id = -1
        for (const k of this.queuedImages.keys()) if (id < 0 || imageRank(k) < imageRank(id)) id = k
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
          // A failed image update must not wedge the dedupe: reopen the slot
          // so the same bar or frame is re-sent the next time it is requested
          // (a duplicate transfer after a late-arriving success is harmless).
          if ((id === CT.bar.id || id === CT.bar2.id) && item.sig !== undefined && this.barSigSent === item.sig) {
            this.barSigSent = null
            if (this.layoutName === 'listening') this.captureSent[id === CT.bar.id ? 0 : 1] = ''
          }
          if (id === CT.sprite.id && item.key !== undefined && this.frameSent === item.key) {
            this.frameSent = null
          }
          // One bounded retry per item: a transient BLE hiccup on a card that
          // does not change again must not leave the bar stale until the next
          // card. A newer item queued meanwhile supersedes the retry, and the
          // attempt cap keeps a dead link from spinning the pump.
          if ((item.attempts ?? 0) < 1 && !this.queuedImages.has(id)) {
            this.queuedImages.set(id, { ...item, attempts: (item.attempts ?? 0) + 1 })
          }
        }
      }
    } finally {
      this.pumping = false
    }
  }
}
