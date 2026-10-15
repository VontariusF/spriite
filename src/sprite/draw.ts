/**
 * Spriite character renderer: a verbatim port of the `POSES` table,
 * bitmaps, `drawFrame()` and `shade()` in docs/design/redesign/Sprite.dc.html.
 * The order of every set/add, the rounding and every constant match the
 * board, so each frame is cell-for-cell identical to the mockup
 * (scripts/test-sprite.mjs evaluates the board's own source and compares).
 *
 * A frame is 32x32 cells: -1 transparent, 0 dark ink, 1-15 green levels.
 *
 * No runtime imports and erasable-only syntax, so Node scripts load it
 * directly.
 */
import type { PoseName } from './poses'

export type EyeKind = 'open' | 'blink' | 'wide' | 'up' | 'happy' | 'focus' | 'sad' | 'closed'
export type LeafKind = 'on' | 'off' | 'dim' | 'burst'
export type MouthKind = 'open' | 'line' | 'smile'

/** One frame of a pose, with the board's field names. `d` is the preview hold in ms. */
export interface PoseFrame {
  d: number
  eyes?: EyeKind
  lift?: number
  look?: number
  tilt?: number
  squash?: number
  leaf?: LeafKind
  mouth?: MouthKind
  waves?: number
  orbit?: number
  chips?: number
  minis?: number
  lens?: number
  qmark?: number
  confetti?: number
  cloud?: number
  zz?: number
  bars?: number
  dim?: number
}

export const POSES: Record<PoseName, readonly PoseFrame[]> = {
  idle: [
    { d: 1800, eyes: 'open' },
    { d: 1800, eyes: 'open', lift: 1 },
    { d: 200, eyes: 'blink', lift: 1 },
    { d: 1600, eyes: 'open', look: 1 },
  ],
  listening: [
    { d: 700, eyes: 'wide', waves: 1 },
    { d: 700, eyes: 'wide', waves: 2, lift: 1 },
    { d: 700, eyes: 'wide', waves: 3, lift: 1 },
  ],
  talking: [
    { d: 420, eyes: 'open', mouth: 'open', lift: 1 },
    { d: 420, eyes: 'open', mouth: 'line', lift: 1 },
    { d: 420, eyes: 'happy', mouth: 'open' },
  ],
  thinking: [
    { d: 900, eyes: 'up', orbit: 0, look: -1 },
    { d: 900, eyes: 'up', orbit: 1, lift: 1 },
    { d: 900, eyes: 'up', orbit: 2, look: 1 },
  ],
  building: [
    { d: 450, eyes: 'focus', squash: 1, leaf: 'burst', chips: 0 },
    { d: 450, eyes: 'focus', squash: -1, lift: 1, leaf: 'on', chips: 1 },
    { d: 450, eyes: 'focus', leaf: 'burst', chips: 2 },
  ],
  delegating: [
    { d: 800, eyes: 'open', minis: 0 },
    { d: 800, eyes: 'happy', minis: 1, lift: 1 },
    { d: 800, eyes: 'open', minis: 2 },
  ],
  checking: [
    { d: 900, eyes: 'open', look: -2, lens: -1 },
    { d: 900, eyes: 'open', look: 2, lens: 1 },
  ],
  asking: [
    { d: 1100, eyes: 'wide', tilt: 1, qmark: 0 },
    { d: 700, eyes: 'open', tilt: 1, qmark: 1, lift: 1 },
  ],
  celebrate: [
    { d: 380, eyes: 'happy', squash: 1, leaf: 'burst', confetti: 0 },
    { d: 380, eyes: 'happy', lift: 3, squash: -1, leaf: 'burst', confetti: 1, mouth: 'smile' },
    { d: 380, eyes: 'happy', lift: 2, leaf: 'on', confetti: 2, mouth: 'smile' },
    { d: 700, eyes: 'happy', leaf: 'on', mouth: 'smile' },
  ],
  blocked: [
    { d: 1200, eyes: 'sad', leaf: 'dim', cloud: 0 },
    { d: 1200, eyes: 'sad', leaf: 'dim', cloud: 1 },
  ],
  paused: [
    { d: 1500, eyes: 'closed', leaf: 'off', bars: 1 },
  ],
  offline: [
    { d: 1600, eyes: 'closed', leaf: 'off', zz: 0, dim: 0.45 },
    { d: 1600, eyes: 'closed', leaf: 'off', zz: 1, dim: 0.45 },
  ],
}

const QMARK = ['.##.', '#..#', '...#', '..#.', '.#..', '....', '.#..']
const ZED = ['###', '..#', '.#.', '#..', '###']
const CLOUD = ['..###..', '.#####.', '#######']
const CONFETTI: readonly (readonly [number, number][])[] = [
  [[-9, -6], [9, -7], [-12, -1], [11, 0]],
  [[-10, -9], [10, -10], [-13, -4], [13, -3], [0, -13]],
  [[-11, -3], [12, -5], [-6, -12], [7, -12], [14, 2]],
]
const CHIPS: readonly (readonly [number, number][])[] = [
  [[-3, -2], [3, -3]],
  [[-5, -4], [5, -1], [1, -5]],
  [[-6, -1], [4, -5]],
]
const MINI_SPOTS: readonly (readonly [number, number][])[] = [
  [[-10, 4], [10, 4]],
  [[-12, 2], [12, 2]],
  [[-13, 0], [13, 0]],
]
/** The leaf, from the stem top: [dx, dy, level]. */
const LEAF: readonly (readonly [number, number, number])[] = [
  [1, -1, 12], [2, -1, 14], [3, -1, 11],
  [2, -2, 13], [3, -2, 14], [4, -2, 12],
  [4, -3, 15],
]
const LEAF_SMALL: readonly (readonly [number, number, number])[] = [[-1, -1, 12], [-2, -2, 13], [-1, -2, 11]]
const LEAF_DROOP: readonly [number, number][] = [[1, 0], [2, 0], [2, 1], [3, 1]]

/** Draw one frame: 1024 cells, row-major, -1 transparent, else 0-15. */
export function drawFrame(f: PoseFrame): number[] {
  const g: number[] = new Array<number>(1024).fill(-1)
  const R = Math.round
  const set = (x: number, y: number, v: number): void => {
    x = R(x); y = R(y)
    if (x < 0 || x > 31 || y < 0 || y > 31) return
    g[y * 32 + x] = v
  }
  const add = (x: number, y: number, v: number): void => {
    x = R(x); y = R(y)
    if (x < 0 || x > 31 || y < 0 || y > 31) return
    const i = y * 32 + x
    if (g[i] < v) g[i] = v
  }
  const bitmap = (rows: readonly string[], x0: number, y0: number, v: number): void =>
    rows.forEach((row, ry) => row.split('').forEach((ch, rx) => { if (ch === '#') add(x0 + rx, y0 + ry, v) }))

  const lift = f.lift || 0
  const sq = f.squash || 0
  const cx = 15.5 + (f.tilt ? 0.5 : 0)
  const rx = 8.5 + sq * 0.9
  const ry = 7.5 - sq * 0.9
  const cy = 18.5 - lift + sq * 0.9
  const ty = Math.floor(cy - ry + 0.5)

  // ground shadow narrows as Spriite rises
  const sw = Math.max(3, 7.5 - lift * 1.3 + sq)
  for (let x = 0; x < 32; x++) {
    const d = Math.abs((x + 0.5 - 16) / sw)
    if (d <= 1) add(x, 29, d > 0.7 ? 2 : 3)
  }

  // body: a soft round blob lit from the top left
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const nx = (x + 0.5 - cx) / rx
    const ny = (y + 0.5 - cy) / ry
    const d = nx * nx + ny * ny
    if (d > 1) continue
    const l = 1 - Math.hypot(nx + 0.45, ny + 0.55) / 1.9
    let v = 6 + R(Math.max(0, Math.min(1, l)) * 8)
    if (d > 0.78) v = Math.min(v, 7)
    if (ny > 0.55) v = Math.min(v, 6)
    set(x, y, v)
  }
  const hx = R(cx - 4), hy = R(cy - 4)
  set(hx, hy, 15); set(hx + 1, hy, 13); set(hx, hy + 1, 12)

  // stem and leaf: a little sprout from the top of the head (no crosses)
  const ax = R(cx + 0.5)
  const leaf = f.leaf || 'on'
  const stx = ax, sty = ty - 2
  if (leaf === 'off') {
    // a closed bud
    set(ax, ty - 1, 7); set(stx, sty, 6); set(stx + 1, sty - 1, 6)
  } else if (leaf === 'dim') {
    // drooping
    set(ax, ty - 1, 7); set(stx, sty, 7)
    LEAF_DROOP.forEach(([a, b]) => add(stx + a, sty + b, 6))
  } else {
    set(ax, ty - 1, 9); set(stx, sty, 9)
    LEAF.forEach(([a, b, v]) => add(stx + a, sty + b, v))
    if (leaf === 'burst') {
      // a second leaf unfurls on the other side, with a glint off the tip
      LEAF_SMALL.forEach(([a, b, v]) => add(stx + a, sty + b, v))
      add(stx + 5, sty - 4, 9)
    }
  }

  // eyes: dark ink (level 0) punched into the body
  const look = f.look || 0
  const ey = R(cy - 0.5)
  const eyesAt: [number, number][] = [[R(cx - 4) + look, 0], [R(cx + 2) + look, 1]]
  eyesAt.forEach(([x, side]) => {
    const y = ey - (f.tilt && side === 0 ? 1 : 0)
    const ink = (a: number, b: number): void => set(x + a, y + b, 0)
    const kind = f.eyes || 'open'
    if (kind === 'open' || kind === 'up') {
      const o = kind === 'up' ? -1 : 0
      for (let a = 0; a < 2; a++) for (let b = -1; b <= 1; b++) ink(a, b + o)
      set(x, y - 1 + o, 13)
    } else if (kind === 'wide') {
      for (let a = 0; a < 2; a++) for (let b = -2; b <= 1; b++) ink(a, b)
      set(x, y - 2, 14)
    } else if (kind === 'blink' || kind === 'closed') {
      ink(0, kind === 'blink' ? 1 : 0); ink(1, kind === 'blink' ? 1 : 0)
      if (kind === 'closed') { ink(side === 0 ? -1 : 2, -1) }
    } else if (kind === 'happy') {
      const s = side === 0 ? -1 : 0
      ink(s, 0); ink(s + 1, -1); ink(s + 2, 0); ink(s, 1); ink(s + 2, 1)
    } else if (kind === 'focus') {
      for (let a = 0; a < 2; a++) for (let b = 0; b <= 1; b++) ink(a, b)
      if (side === 0) { ink(0, -2); ink(1, -1) } else { ink(1, -2); ink(0, -1) }
    } else if (kind === 'sad') {
      for (let a = 0; a < 2; a++) for (let b = 0; b <= 1; b++) ink(a, b)
      if (side === 0) { ink(1, -2); ink(0, -1) } else { ink(0, -2); ink(1, -1) }
    }
  })

  // mouth
  const mx = R(cx - 0.5), my = ey + 3
  if (f.mouth === 'smile') { set(mx - 1, my, 0); set(mx, my + 1, 0); set(mx + 1, my + 1, 0); set(mx + 2, my, 0) }
  if (f.mouth === 'open') { set(mx, my, 0); set(mx + 1, my, 0); set(mx, my + 1, 0); set(mx + 1, my + 1, 0) }
  if (f.mouth === 'line') { set(mx, my, 0); set(mx + 1, my, 0) }

  // props
  if (f.waves) {
    for (let k = 1; k <= f.waves; k++) {
      const r = 10.5 + k * 2.2
      for (let a = -36; a <= 36; a += 7) {
        const t = a * Math.PI / 180
        add(cx + r * Math.cos(t), cy + r * Math.sin(t), 14 - k * 2)
        add(cx - r * Math.cos(t), cy + r * Math.sin(t), 14 - k * 2)
      }
    }
  }
  if (f.orbit !== undefined) {
    for (let i = 0; i < 3; i++) {
      const t = (f.orbit * 40 + i * 120) * Math.PI / 180
      add(cx + 9 * Math.cos(t), ty - 2 + 2.5 * Math.sin(t), Math.sin(t) > 0 ? 14 : 7)
    }
  }
  if (f.chips !== undefined) CHIPS[f.chips].forEach(([a, b]) => add(ax + 1 + a, ty - 4 + b, 12))
  if (f.minis !== undefined) {
    const minis = f.minis
    const spots = MINI_SPOTS[minis]
    spots.forEach(([a, b]) => {
      const x0 = R(cx + a) - 1, y0 = R(cy + b) - 1
      bitmap(['.#.', '###', '###'], x0, y0, minis === 0 ? 8 : 11)
      set(x0 + 1, y0 + 1, 0)
      add(x0 + 2, y0 - 2, 14)
    })
  }
  if (f.lens) {
    const lx = cx + f.lens * 7, ly = cy + 1
    for (let a = 0; a < 360; a += 20) { const t = a * Math.PI / 180; set(lx + 3.2 * Math.cos(t), ly + 3.2 * Math.sin(t), 14) }
    set(lx + 3, ly + 3, 11); set(lx + 4, ly + 4, 11)
  }
  if (f.qmark !== undefined) bitmap(QMARK, R(cx + 7), ty - 7 - f.qmark, 15)
  if (f.confetti !== undefined) CONFETTI[f.confetti].forEach(([a, b], i) => {
    const x = cx + a, y = cy + b
    add(x, y, 15)
    // falling leaves: a short diagonal, never a cross
    if (i % 2 === 0) add(x + 1, y - 1, 9)
  })
  if (f.cloud !== undefined) {
    bitmap(CLOUD, R(cx) - 4, ty - 8, 6)
    const drops: [number, number][] = f.cloud === 0 ? [[-3, -4], [1, -3]] : [[-1, -4], [3, -3]]
    drops.forEach(([a, b]) => add(R(cx) + a, ty + b, 9))
  }
  if (f.zz !== undefined) {
    bitmap(ZED, R(cx + 5), ty - 4, 12)
    if (f.zz === 1) bitmap(ZED, R(cx + 9), ty - 9, 8)
  }
  if (f.bars) {
    for (let b = 0; b < 5; b++) { set(R(cx + 9), ty - 4 + b, 12); set(R(cx + 10), ty - 4 + b, 12); set(R(cx + 12), ty - 4 + b, 12); set(R(cx + 13), ty - 4 + b, 12) }
  }

  if (f.dim) for (let i = 0; i < 1024; i++) if (g[i] > 0) g[i] = Math.max(1, R(g[i] * f.dim))
  return g
}

/** At glasses speed every frame shows for at least this long (MotionLab: "about 1 fps"). */
export const GLASSES_MIN_HOLD_MS = 1000

/** How long a frame holds: the board's `d` in preview, at least 1000 ms on the glasses. */
export function holdMs(f: PoseFrame, speed: 'preview' | 'glasses'): number {
  return speed === 'glasses' ? Math.max(f.d, GLASSES_MIN_HOLD_MS) : f.d
}

/** The board's colour for a level: ink (0) is black, 1-15 a green ramp. */
export function shade(level: number): string {
  if (level === 0) return '#000000'
  return 'hsl(134, 92%, ' + (3 + level * 4.4).toFixed(1) + '%)'
}
