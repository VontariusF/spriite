/**
 * HUD layouts at 1x (576x288). The boards in docs/design/redesign/Hud*.dc.html
 * are drawn at 2x; every coordinate and size here is the board's divided by
 * two (REDESIGN-SPEC "Glasses HUD"):
 *
 *  - context line at y 14, x 24, 528 wide: label left, detail right-aligned;
 *  - sprite 64x64 at (24, 68) (the question page: (24, 52));
 *  - main text at x 112, 440 wide;
 *  - milestone bar x 112 y 200, 440x8 (Run/Done), capture bar y 206, 440x3;
 *  - actions row at y 235, 36 high: the focused action in a bordered box,
 *    the others dimmed after it; the Run card adds the ‹ › swipe hints;
 *  - the question page: question at y 54, options from y 132 (focused one
 *    bordered, the others level 3), footer at y 256.
 *
 * Text levels follow the boards: #B8FFC8 = 4, #9DFFB0 = border (level 15),
 * #5BC874 = 3, #3A8A4E = 2.
 *
 * Firmware facts the layouts work within: text containers take one
 * brightness, one border and one font for the whole container, and only
 * their content can change without a page rebuild. So the focused action and
 * the focused option sit in their own bordered container at a fixed slot and
 * the list turns through it (the focused item is always the first one drawn,
 * exactly where the boards draw it), which keeps a ring tick a flicker-free
 * text upgrade. Container budgets stay inside the platform ceilings: 12
 * total, 8 text, 4 image; an image container is at most 288 wide, so the
 * 440 px bars travel as two halves.
 */
import {
  ImageContainerProperty,
  ListContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk'
import { getTextWidth, measureTextWrap, pxTruncate } from '@evenrealities/pretext'
import { HALF_H, HALF_W, SEG_X, SEG_Y, CAPTURE_Y } from './progress'

export type LayoutName = 'conversation' | 'selection' | 'listening' | 'history'

/** Fixed container IDs and names (names must be <= 16 chars). */
export const CT = {
  ctx: { id: 1, name: 'ctx' },
  say: { id: 2, name: 'say' },
  status: { id: 3, name: 'status' },
  bar: { id: 4, name: 'bar' },
  sprite: { id: 5, name: 'sprite' },
  actions: { id: 6, name: 'actions' },
  list: { id: 7, name: 'list' },
  hint: { id: 8, name: 'hint' },
  timer: { id: 9, name: 'timer' },
  note: { id: 10, name: 'note' },
  bar2: { id: 11, name: 'bar2' },
  rest: { id: 12, name: 'rest' },
  prev: { id: 13, name: 'prev' },
} as const

/** Board geometry at 1x. */
export const G = {
  ctx: { x: 24, y: 14, w: 528, h: 28 },
  sprite: { x: 24, y: 68, size: 64 },
  askSprite: { x: 24, y: 52 },
  text: { x: 112, w: 440 },
  /** The firmware font's wrapped line pitch. */
  lineH: 28,
  /** Idle-style cards (no bar): main text at y 70, 7 px gap to the subline. */
  idle: { y: 70, gap: 7 },
  /** Run/Done cards (bar at y 200): main text at y 66, 6 px gap. */
  run: { y: 66, gap: 6 },
  actions: { y: 235, h: 36, x: 24, right: 552, gap: 22, padX: 11, pad: 3, border: 1, radius: 5 },
  ask: { questionY: 54, questionH: 56, optionY: 132, optionH: 36, restGap: 3, restRows: 3, footerY: 256, footerH: 28, inset: 11 },
  listen: { labelY: 66, transcriptY: 94, transcriptLines: 3 },
  /** Border level for the focused box (#9DFFB0, the brightest green). */
  borderLevel: 15,
} as const

/** Text levels (firmware brightness 0-4). */
export const LEVEL = { title: 4, body: 3, dim: 2 } as const

/** Contextual menu verbs (spec §5.4). Availability is version-gated. */
export const MENU_ITEMS = [
  new MenuItemProperty({ itemID: 1, itemName: 'Talk' }),
  new MenuItemProperty({ itemID: 2, itemName: 'Pause or resume' }),
  new MenuItemProperty({ itemID: 3, itemName: 'Restart' }),
  new MenuItemProperty({ itemID: 4, itemName: 'Spriite motion' }),
]

function menu(): MenuContainerProperty {
  return new MenuContainerProperty({ menuItems: MENU_ITEMS })
}

/** The page payload sent to createStartUpPageContainer / rebuildPageContainer. */
export interface PagePayload {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject?: ListContainerProperty[]
  imageObject: ImageContainerProperty[]
  menuObject: MenuContainerProperty
}

export interface Layout {
  name: LayoutName
  /**
   * Geometry signature. Same name and key: the live page is updated in place
   * (text upgrades only); anything else is a page rebuild.
   */
  key: string
  payload: PagePayload
  hasProgress: boolean
  /** The question page's rows under the focused option (fewer under a long question). */
  restRows?: number
}

// ------------------------------------------------------------ text helpers

const SPACE_W = Math.max(1, getTextWidth(' '))

function spaces(px: number): string {
  return ' '.repeat(Math.max(0, Math.floor(px / SPACE_W)))
}

export function wrappedLineCount(text: string, width: number): number {
  if (!text) return 0
  return measureTextWrap(text, width).lineCount
}

/**
 * One context line: the label (uppercase, as drawn) on the left, the detail
 * right-aligned in the same 528 px container. The firmware has no right
 * alignment, so the gap is filled with spaces (within one space, 5 px).
 */
export function composeContextLine(label: string, detail = '', width: number = G.ctx.w): string {
  const left = String(label ?? '').replace(/\s+/g, ' ').trim().toUpperCase()
  const right = String(detail ?? '').replace(/\s+/g, ' ').trim()
  if (!right) return getTextWidth(left) <= width ? left : pxTruncate(left, width)
  const minGap = 2 * SPACE_W
  const r = getTextWidth(right) <= width - 40 - minGap ? right : pxTruncate(right, Math.max(40, width - 40 - minGap))
  const room = width - getTextWidth(r) - minGap
  const l = getTextWidth(left) <= room ? left : pxTruncate(left, room)
  let line = `${l}${spaces(width - getTextWidth(l) - getTextWidth(r))}${r}`
  while (getTextWidth(line) > width && line.includes('  ')) line = line.replace('  ', ' ')
  return line
}

// ----------------------------------------------------------- actions row

export interface ActionRow {
  prev: string
  box: string
  rest: string
  boxX: number
  boxW: number
  restX: number
  restW: number
  bordered: boolean
}

const PREV_HINT = '‹'
const NEXT_HINT = '›'

/**
 * The actions row for a label set: the focused label centred in the bordered
 * box (sized to the widest label so focus moves never resize it), then the
 * others in carousel order, dimmed, 22 px apart; with hints, ‹ before the box
 * and › after the last label.
 */
export function actionRow(labels: readonly string[], focusIdx: number, hints = false): ActionRow {
  const a = G.actions
  const prevW = hints ? getTextWidth(PREV_HINT) + a.gap : 0
  const boxX = a.x + prevW
  if (labels.length === 0) {
    return { prev: '', box: '', rest: '', boxX: a.x, boxW: 24, restX: a.x + 48, restW: a.right - a.x - 48, bordered: false }
  }
  const n = labels.length
  const focus = Math.max(0, Math.min(n - 1, focusIdx))
  const maxBox = a.right - boxX
  const widest = Math.max(...labels.map((l) => getTextWidth(l)))
  const inner = Math.min(widest + 2 * (a.padX - a.pad), maxBox - 2 * a.border - 2 * a.pad)
  const boxW = inner + 2 * a.border + 2 * a.pad
  const label = getTextWidth(labels[focus]) <= inner ? labels[focus] : pxTruncate(labels[focus], inner)
  const lead = Math.max(0, Math.min(Math.round((inner - getTextWidth(label)) / 2 / SPACE_W), Math.floor((inner - getTextWidth(label)) / SPACE_W)))
  const box = ' '.repeat(lead) + label
  // The rest container's own padding (3) is part of the 22 px gap.
  const restX = boxX + boxW + a.gap - a.pad
  const restW = Math.max(24, a.right - restX)
  const restInner = restW - 2 * a.pad
  const gap = spaces(a.gap)
  const others: string[] = []
  for (let k = 1; k < n; k++) others.push(labels[(focus + k) % n])
  const tail = hints ? `${gap}${NEXT_HINT}` : ''
  let rest = ''
  while (others.length > 0) {
    rest = others.join(gap) + tail
    if (getTextWidth(rest) <= restInner) break
    others.pop()
    rest = ''
  }
  if (others.length === 0) rest = hints ? NEXT_HINT : ''
  return { prev: hints ? PREV_HINT : '', box, rest, boxX, boxW, restX, restW, bordered: true }
}

// ---------------------------------------------------- question/option list

const OPTION_TEXT_W = G.ctx.w - 2 * 1 - 2 * G.actions.pad - SPACE_W

/** The focused option (box) and the next options (rest), carousel order. */
export function optionRows(items: readonly string[], focusIdx: number, restRows: number = G.ask.restRows): { focus: string; rest: string } {
  if (items.length === 0) return { focus: '', rest: '' }
  const n = items.length
  const focus = Math.max(0, Math.min(n - 1, focusIdx))
  const fit = (t: string) => (getTextWidth(t) <= OPTION_TEXT_W ? t : pxTruncate(t, OPTION_TEXT_W))
  const rest: string[] = []
  for (let k = 1; k < Math.min(n, restRows + 1); k++) rest.push(fit(items[(focus + k) % n]))
  return { focus: ` ${fit(items[focus])}`, rest: rest.join('\n') }
}

// --------------------------------------------------------- shared builders

function text(o: {
  c: { id: number; name: string }
  x: number; y: number; w: number; h: number
  content: string
  level?: number
  capture?: boolean
  z: number
  border?: boolean
  pad?: number
}): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: o.x, yPosition: o.y, width: o.w, height: o.h,
    borderWidth: o.border ? G.actions.border : 0,
    ...(o.border ? { borderColor: G.borderLevel, borderRadius: G.actions.radius } : {}),
    paddingLength: o.pad ?? 0,
    containerID: o.c.id, containerName: o.c.name, zOrderIndex: o.z,
    content: o.content, isEventCapture: o.capture ? 1 : 0,
    textColor: o.level ?? LEVEL.title,
  })
}

function image(c: { id: number; name: string }, x: number, y: number, w: number, h: number, z: number): ImageContainerProperty {
  return new ImageContainerProperty({ xPosition: x, yPosition: y, width: w, height: h, containerID: c.id, containerName: c.name, zOrderIndex: z })
}

function ctxText(content: string): TextContainerProperty {
  return text({ c: CT.ctx, ...G.ctx, content, level: LEVEL.body, z: 1 })
}

function barImages(y: number, zBase: number): ImageContainerProperty[] {
  return [
    image(CT.bar, SEG_X, y, HALF_W, HALF_H, zBase),
    image(CT.bar2, SEG_X + HALF_W, y, HALF_W, HALF_H, zBase + 1),
  ]
}

function actionTexts(row: ActionRow, capture: boolean, zBase: number): TextContainerProperty[] {
  const a = G.actions
  return [
    text({ c: CT.prev, x: a.x - a.pad, y: a.y, w: 24, h: a.h, content: row.prev, level: LEVEL.dim, z: zBase, pad: a.pad }),
    text({ c: CT.actions, x: row.boxX, y: a.y, w: row.boxW, h: a.h, content: row.box, level: LEVEL.title, z: zBase + 1, border: row.bordered, pad: a.pad, capture }),
    text({ c: CT.rest, x: row.restX, y: a.y, w: row.restW, h: a.h, content: row.rest, level: LEVEL.dim, z: zBase + 2, pad: a.pad }),
  ]
}

// ------------------------------------------------------------ conversation

export interface ConversationContent {
  contextLabel: string
  /** Right half of the context line ('BUILDING · 2 OF 4', '3 builds · 1 needs you'). */
  contextDetail?: string
  utterance: string
  status: string
  /** The card's action labels and the focused index (preferred). */
  actions?: readonly string[]
  focusIdx?: number
  /** Legacy: one pre-composed action line (drawn as the focused action). */
  actionsText?: string
  /** The Run card's ‹ › swipe hints. */
  hints?: boolean
  hasProgress: boolean
}

/** Where the main text and its subline sit for an utterance of `lines` lines. */
export function conversationGeometry(lines: number, hasProgress: boolean): { sayY: number; sayH: number; statusY: number } {
  const n = Math.max(1, lines)
  const lh = G.lineH
  if (hasProgress) {
    // The subline must clear the bar at y 200: a four-line utterance moves up.
    const y = Math.min(G.run.y, SEG_Y - lh - G.run.gap - n * lh)
    return { sayY: y, sayH: n * lh, statusY: y + n * lh + G.run.gap }
  }
  return { sayY: G.idle.y, sayH: n * lh, statusY: G.idle.y + n * lh + G.idle.gap }
}

export function conversationLayout(c: ConversationContent): Layout {
  const lines = wrappedLineCount(c.utterance, G.text.w)
  const geo = conversationGeometry(lines, c.hasProgress)
  const labels = c.actions ?? (c.actionsText ? [c.actionsText] : [])
  const row = actionRow(labels, c.focusIdx ?? 0, Boolean(c.hints) && labels.length > 0)
  const key = [
    'conversation', geo.sayY, geo.sayH, row.boxX, row.boxW, row.restX, row.bordered ? 1 : 0, c.hasProgress ? 1 : 0,
  ].join(':')
  return {
    name: 'conversation',
    key,
    hasProgress: c.hasProgress,
    payload: {
      containerTotalNum: 9,
      textObject: [
        ctxText(composeContextLine(c.contextLabel, c.contextDetail)),
        text({ c: CT.say, x: G.text.x, y: geo.sayY, w: G.text.w, h: geo.sayH, content: c.utterance, level: LEVEL.title, z: 2 }),
        text({ c: CT.status, x: G.text.x, y: geo.statusY, w: G.text.w, h: G.lineH, content: c.status, level: LEVEL.body, z: 3 }),
        ...actionTexts(row, true, 7),
      ],
      imageObject: [
        ...barImages(SEG_Y, 4),
        image(CT.sprite, G.sprite.x, G.sprite.y, G.sprite.size, G.sprite.size, 6),
      ],
      menuObject: menu(),
    },
  }
}

// --------------------------------------------------------------- selection

export interface SelectionContent {
  contextLabel: string
  contextDetail?: string
  title: string
  items: string[]
  /** The row the cursor sits on (0-based). */
  focusIdx: number
  /** The fixed footer line ('Swipe to choose · tap to send · also on your phone'). */
  footer?: string
}

/** Options shown at once on the question page: the focused one plus the next three. */
export const ASK_VISIBLE_ROWS = G.ask.restRows + 1

/**
 * Legacy row-window size (the '> ' text fallback). Producers still size their
 * long lists by it (src/runtime/native-mission.ts), so it keeps its value.
 */
export const SELECTION_VISIBLE_ROWS = 5

/** The option rows' inner width (x 24, 528 wide). */
export const SELECTION_ROW_W = 528

/**
 * Legacy windowed row text ('> ' cursor): kept for the text-only fallback
 * and the old row-window tests. The HUD draws optionRows() instead.
 */
export function buildSelectionRowsText(items: string[], focusIdx: number): string {
  const LEGACY_ROWS = SELECTION_VISIBLE_ROWS
  if (items.length === 0) return ''
  const focus = Math.max(0, Math.min(items.length - 1, focusIdx))
  let start = Math.max(0, Math.min(items.length - LEGACY_ROWS, focus - 2))
  if (focus < start) start = focus
  if (focus >= start + LEGACY_ROWS) start = focus - LEGACY_ROWS + 1
  const rows: string[] = []
  for (let i = start; i < Math.min(items.length, start + LEGACY_ROWS); i++) {
    const prefix = i === focus ? '> ' : '  '
    rows.push(prefix + pxTruncate(items[i], SELECTION_ROW_W - getTextWidth(prefix)))
  }
  return rows.join('\n')
}

export function selectionLayout(s: SelectionContent): Layout {
  const q = G.ask
  // The board's question takes two lines; a longer one (a gate's four-line
  // question) pushes the options down and shows fewer rows under the focus.
  const extra = Math.min(q.restRows, Math.max(0, wrappedLineCount(s.title, G.text.w) - 2))
  const restRows = q.restRows - extra
  const optionY = q.optionY + extra * G.lineH
  const rows = optionRows(s.items, s.focusIdx, restRows)
  const restY = optionY + q.optionH + q.restGap
  const restX = G.ctx.x + 1 + G.actions.pad + getTextWidth(' ')
  return {
    name: 'selection',
    key: extra > 0 ? `selection:${extra}` : 'selection',
    hasProgress: false,
    restRows,
    payload: {
      containerTotalNum: 6,
      textObject: [
        ctxText(composeContextLine(s.contextLabel, s.contextDetail)),
        text({ c: CT.say, x: G.text.x, y: q.questionY, w: G.text.w, h: q.questionH + extra * G.lineH, content: s.title, level: LEVEL.title, z: 2 }),
        // The focused option: the bordered row at a fixed slot (first, as
        // drawn); a ring tick turns the list through it in place.
        text({ c: CT.list, x: G.ctx.x, y: optionY, w: G.ctx.w, h: q.optionH, content: rows.focus, level: LEVEL.title, z: 3, border: s.items.length > 0, pad: G.actions.pad, capture: true }),
        text({ c: CT.rest, x: restX, y: restY, w: G.ctx.x + G.ctx.w - restX, h: Math.max(1, restRows) * G.lineH, content: rows.rest, level: LEVEL.body, z: 4 }),
        text({ c: CT.note, x: G.ctx.x, y: q.footerY, w: G.ctx.w, h: q.footerH, content: s.footer ?? '', level: LEVEL.dim, z: 5 }),
      ],
      imageObject: [
        image(CT.sprite, G.askSprite.x, G.askSprite.y, G.sprite.size, G.sprite.size, 6),
      ],
      menuObject: menu(),
    },
  }
}

// --------------------------------------------------------------- listening

export interface ListeningContent {
  contextLabel: string
  /** The live transcript (already quoted), or the prompt before any words. */
  hint: string
  /** The capture timer ('0:07 of 0:30'), drawn as the context detail. */
  timerText: string
  /** The small line above the transcript ('You said'). */
  noteText: string
  /** Action labels; the first is focused ('Tap to send', 'Double-tap to cancel'). */
  actions?: readonly string[]
}

export function listeningLayout(l: ListeningContent): Layout {
  const L = G.listen
  const row = actionRow(l.actions ?? [], 0, false)
  return {
    name: 'listening',
    key: ['listening', row.boxW, row.restX, row.bordered ? 1 : 0].join(':'),
    hasProgress: false,
    payload: {
      containerTotalNum: 9,
      textObject: [
        ctxText(composeContextLine(l.contextLabel, l.timerText)),
        text({ c: CT.note, x: G.text.x, y: L.labelY, w: G.text.w, h: G.lineH, content: l.noteText, level: LEVEL.body, z: 2 }),
        text({ c: CT.hint, x: G.text.x, y: L.transcriptY, w: G.text.w, h: L.transcriptLines * G.lineH, content: l.hint, level: LEVEL.title, z: 3 }),
        ...actionTexts(row, true, 7),
      ],
      imageObject: [
        ...barImages(CAPTURE_Y, 4),
        image(CT.sprite, G.sprite.x, G.sprite.y, G.sprite.size, G.sprite.size, 6),
      ],
      menuObject: menu(),
    },
  }
}

// ----------------------------------------------------------------- history

export interface HistoryContent {
  contextLabel: string
  title: string
  bodyText: string
  footerText: string
}

/**
 * The chat-history page (undrawn; composed from the HUD boards' type and
 * spacing): full-screen paginated text the ring pages, no sprite and no bar.
 */
export function historyLayout(h: HistoryContent): Layout {
  return {
    name: 'history',
    key: 'history',
    hasProgress: false,
    payload: {
      containerTotalNum: 4,
      textObject: [
        ctxText(composeContextLine(h.contextLabel)),
        text({ c: CT.say, x: G.text.x, y: 52, w: G.text.w, h: 28, content: h.title, level: LEVEL.title, z: 2 }),
        text({ c: CT.hint, x: 24, y: 84, w: 528, h: 168, content: h.bodyText, level: LEVEL.title, z: 3, capture: true }),
        text({ c: CT.note, x: 24, y: 256, w: 528, h: 28, content: h.footerText, level: LEVEL.body, z: 4 }),
      ],
      imageObject: [],
      menuObject: menu(),
    },
  }
}
