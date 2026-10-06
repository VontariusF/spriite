/**
 * Sprite character: layered pixel frames and per-pose animation scripts.
 *
 * The character is composed procedurally on a 32x32 master grid (upscaled 2x
 * to the 64x64 image container) from four layers: a shaded body, eyes
 * (punched out of the body as dark holes), a thick curled tail, and a spark,
 * plus small pose accessories. The whole character floats above a ground
 * shadow; `lift` raises it 0-2 grid rows for the hover cycle, and the shadow
 * narrows as it rises. Grayscale levels 0-15; hardware maps them to green.
 *
 * Animations are deliberately sparse: image transfers to the glasses are
 * serialized and take roughly 0.5-2 s each, so every script is a handful of
 * frames with long holds, and every pose has a key frame that works alone
 * (static mode). This file has no runtime imports so dev scripts can load it
 * directly with Node.
 */

export const GRID = 32
export const SCALE = 2
export const SIZE = GRID * SCALE

export const POSE_NAMES = [
  'idle',
  'listening',
  'waiting',
  'planning',
  'checking',
  'repair',
  'accepted',
  'asking',
  'disconnected',
  'switching',
] as const
export type PoseName = (typeof POSE_NAMES)[number]

type Eyes =
  | 'open' | 'blink' | 'left' | 'right' | 'up_left' | 'up_right'
  | 'happy' | 'dot' | 'worried' | 'closed'
type SparkKind = 'none' | 'bolt' | 'bolt_small' | 'bolt_dim'
type Extra =
  | 'arcs' | 'lens' | 'lens_low' | 'question' | 'question_up'
  | 'dots1' | 'dots2' | 'dots3' | 'trail'

interface FrameSpec {
  eyes: Eyes
  spark: SparkKind
  sparkAt?: [number, number]
  extras?: Extra[]
  tilt?: boolean
  dim?: boolean
}

/** Hover heights in grid rows (1 row = 2 px on the glasses). */
export const MAX_LIFT = 2
export type Lift = 0 | 1 | 2

const BODY = 12
const BODY_SHADE = 7
const BODY_HI = 15
const BODY_DIM = 5
const BODY_DIM_SHADE = 3
const TAIL_V = 11
const SPARK = 15
const SPARK_DIM = 6
const SPARK_BEVEL = 9
const ACC = 10
const TRAIL = 5
const SHADOW = 4

/** Full flame silhouette: round bulb, tip up and to the left. Row -> inclusive x span. */
const BODY_ROWS: Record<number, [number, number]> = {
  2: [7, 7], 3: [7, 8], 4: [6, 9], 5: [6, 10], 6: [6, 12], 7: [5, 14],
  8: [4, 16], 9: [4, 18], 10: [3, 19], 11: [3, 20], 12: [3, 20], 13: [3, 20],
  14: [3, 20], 15: [3, 20], 16: [3, 20], 17: [3, 20], 18: [3, 20], 19: [3, 19],
  20: [4, 19], 21: [4, 18], 22: [5, 17], 23: [6, 16], 24: [8, 14], 25: [10, 12],
}

/** Small specular highlight on the upper-left of the bulb: reads as volume. */
const HIGHLIGHT: [number, number][] = [[7, 8], [6, 9], [5, 10], [5, 11], [6, 10]]

/** Thick curled tail (2 px wide). B is the swayed variant used at the top of a hover. */
const TAIL_A: [number, number][] = [
  [10, 26], [9, 27], [8, 28], [9, 29], [10, 29], [11, 29], [12, 28], [13, 28],
]
const TAIL_B: [number, number][] = [
  [11, 26], [10, 27], [10, 28], [11, 29], [12, 29], [13, 29], [14, 28], [15, 28],
]

const EYE_L = 8
const EYE_R = 15
const EYE_Y = 15

const QUESTION = ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..']

type Grid = number[]

function blank(): Grid {
  return new Array<number>(GRID * GRID).fill(0)
}

function set(g: Grid, x: number, y: number, v: number): void {
  if (x < 0 || y < 0 || x >= GRID || y >= GRID) return
  g[y * GRID + x] = v
}

function inBody(x: number, y: number): boolean {
  const span = BODY_ROWS[y]
  return span !== undefined && x >= span[0] && x <= span[1]
}

function drawEye(g: Grid, cx: number, kind: Eyes, side: 'l' | 'r', bodyV: number): void {
  const y = EYE_Y
  const hole = (x: number, yy: number) => set(g, x, yy, 0)
  const box = (x0: number, y0: number, w: number, h: number) => {
    for (let yy = y0; yy < y0 + h; yy++) for (let x = x0; x < x0 + w; x++) hole(x, yy)
  }
  switch (kind) {
    case 'open': box(cx - 1, y - 2, 3, 4); return
    case 'left': box(cx - 2, y - 2, 3, 4); return
    case 'right': box(cx, y - 2, 3, 4); return
    case 'up_left': box(cx - 2, y - 3, 3, 4); return
    case 'up_right': box(cx, y - 3, 3, 4); return
    case 'blink':
    case 'closed': box(cx - 1, y + 1, 3, 1); return
    case 'dot': box(cx - 1, y - 1, 2, 2); return
    case 'happy':
      // Two-pixel-thick upward arch: a confident, bright smile-eye.
      for (const [dx, ddy] of [[-2, 1], [-1, 0], [0, -1], [1, 0], [2, 1]]) {
        hole(cx + dx, y + ddy)
        hole(cx + dx, y + ddy + 1)
      }
      return
    case 'worried':
      box(cx - 1, y - 2, 3, 4)
      // Lit inner-top corner reads as a raised, worried brow.
      set(g, side === 'l' ? cx + 1 : cx - 1, y - 2, bodyV)
      return
  }
}

/**
 * The spark is a lightning bolt (energy the flame throws): a wide blade off
 * the top-right, a left step at the waist, a point at the bottom-left. Not
 * a cross, not an orb — one readable glyph at three sizes.
 */
// '#' is the lit face, '+' the shaded bevel on the trailing (left) edge, so
// the bolt reads as a solid, faceted shape instead of a flat scribble.
const BOLT = [
  '....+###',
  '...+###.',
  '..+###..',
  '.+###...',
  '+#######',
  '...+###.',
  '...+##..',
  '..+##...',
  '..+#....',
  '.+#.....',
  '.#......',
]

const BOLT_SMALL = [
  '..+##',
  '.+##.',
  '.+#..',
  '+####',
  '..+#.',
  '.+#..',
  '.#...',
  '#....',
]

function drawSpark(g: Grid, kind: SparkKind, at: [number, number]): void {
  if (kind === 'none') return
  const rows = kind === 'bolt_small' ? BOLT_SMALL : BOLT
  const face = kind === 'bolt_dim' ? SPARK_DIM : SPARK
  const bevel = kind === 'bolt_dim' ? SPARK_DIM - 2 : SPARK_BEVEL
  const [x0, y0] = at
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      if (row[dx] === '#') set(g, x0 + dx, y0 + dy, face)
      else if (row[dx] === '+') set(g, x0 + dx, y0 + dy, bevel)
    }
  })
}

function drawRing(g: Grid, cx: number, cy: number, r: number, v: number): void {
  for (let a = 0; a < 64; a++) {
    const t = (a / 64) * Math.PI * 2
    set(g, Math.round(cx + r * Math.cos(t)), Math.round(cy + r * Math.sin(t)), v)
  }
}

function drawExtra(g: Grid, e: Extra): void {
  switch (e) {
    case 'arcs':
      for (const [x, y] of [[23, 13], [24, 14], [24, 15], [24, 16], [23, 17]]) set(g, x, y, ACC)
      for (const [x, y] of [[25, 11], [26, 12], [27, 13], [27, 14], [27, 15], [27, 16], [27, 17], [26, 18], [25, 19]]) set(g, x, y, ACC)
      return
    case 'lens':
    case 'lens_low': {
      const cy = e === 'lens' ? 14 : 16
      drawRing(g, 25, cy, 3, ACC)
      for (let i = 0; i < 4; i++) {
        set(g, 27 + i, cy + 3 + i, ACC)
        set(g, 28 + i, cy + 3 + i, ACC)
      }
      return
    }
    case 'question':
    case 'question_up': {
      const y0 = e === 'question' ? 4 : 3
      QUESTION.forEach((row, dy) => {
        for (let dx = 0; dx < row.length; dx++) if (row[dx] === '#') set(g, 23 + dx, y0 + dy, SPARK)
      })
      return
    }
    case 'dots1':
    case 'dots2':
    case 'dots3': {
      const n = Number(e.slice(-1))
      for (let i = 0; i < n; i++) {
        const x = 23 + i * 3
        set(g, x, 22, ACC); set(g, x + 1, 22, ACC); set(g, x, 23, ACC); set(g, x + 1, 23, ACC)
      }
      return
    }
    case 'trail':
      for (const y of [10, 15, 20]) for (let x = 0; x <= 1; x++) set(g, x, y, TRAIL)
      return
  }
}

function compose(spec: FrameSpec, lift: Lift): Grid {
  const body = blank()
  const base = spec.dim ? BODY_DIM : BODY
  const shade = spec.dim ? BODY_DIM_SHADE : BODY_SHADE
  for (const [row, [x0, x1]] of Object.entries(BODY_ROWS)) {
    const y = Number(row)
    for (let x = x0; x <= x1; x++) {
      // Light from the upper left: a 2 px rim on the lower-right edge is shaded.
      const rim = !inBody(x + 2, y) || !inBody(x, y + 2) || !inBody(x + 1, y + 1)
      set(body, x, y, rim && y > 6 ? shade : base)
    }
  }
  if (!spec.dim) for (const [x, y] of HIGHLIGHT) set(body, x, y, BODY_HI)
  const tail = lift === MAX_LIFT ? TAIL_B : TAIL_A
  for (const [x, y] of tail) {
    set(body, x, y, spec.dim ? BODY_DIM : TAIL_V)
    set(body, x + 1, y, spec.dim ? BODY_DIM : TAIL_V)
  }
  drawEye(body, EYE_L, spec.eyes, 'l', base)
  drawEye(body, EYE_R, spec.eyes, 'r', base)

  let g = body
  if (spec.tilt) {
    // Shear the character so the top leans right: a slight, curious tilt.
    g = blank()
    for (let y = 0; y < GRID; y++) {
      const shift = Math.round((16 - y) / 8)
      for (let x = 0; x < GRID; x++) {
        const v = body[y * GRID + x]
        if (v) set(g, x + shift, y, v)
      }
    }
  }
  for (const e of spec.extras ?? []) drawExtra(g, e)
  drawSpark(g, spec.spark, spec.sparkAt ?? [24, 4])

  // Float: everything except the ground shadow rises by `lift` rows.
  const out = blank()
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const v = g[y * GRID + x]
      if (v) set(out, x, y - lift, v)
    }
  }
  // Ground shadow narrows as the sprite rises, selling the hover.
  const half = 5 - lift
  for (let x = 12 - half; x <= 11 + half; x++) set(out, x, 31, spec.dim ? 2 : SHADOW)
  return out
}

const FRAMES = {
  idle: { eyes: 'open', spark: 'bolt', sparkAt: [24, 4] },
  idle_blink: { eyes: 'blink', spark: 'bolt', sparkAt: [24, 4] },
  listen_a: { eyes: 'open', spark: 'bolt_small', sparkAt: [25, 1], extras: ['arcs'] },
  listen_b: { eyes: 'open', spark: 'bolt_small', sparkAt: [27, 1], extras: ['arcs'] },
  listen_c: { eyes: 'open', spark: 'bolt_small', sparkAt: [27, 22], extras: ['arcs'] },
  wait_1: { eyes: 'dot', spark: 'bolt_dim', sparkAt: [24, 4], extras: ['dots1'] },
  wait_2: { eyes: 'dot', spark: 'bolt_dim', sparkAt: [24, 4], extras: ['dots2'] },
  wait_3: { eyes: 'dot', spark: 'bolt_dim', sparkAt: [24, 4], extras: ['dots3'] },
  plan_a: { eyes: 'up_left', spark: 'bolt', sparkAt: [23, 3] },
  plan_b: { eyes: 'up_right', spark: 'bolt', sparkAt: [24, 9] },
  check_a: { eyes: 'right', spark: 'bolt_small', sparkAt: [21, 2], extras: ['lens'] },
  check_b: { eyes: 'open', spark: 'bolt_small', sparkAt: [21, 3], extras: ['lens_low'] },
  repair: { eyes: 'worried', spark: 'bolt_dim', sparkAt: [24, 4] },
  accept_burst: { eyes: 'happy', spark: 'bolt', sparkAt: [24, 3] },
  accept_settle: { eyes: 'happy', spark: 'bolt', sparkAt: [24, 4] },
  ask_a: { eyes: 'up_right', spark: 'bolt_small', sparkAt: [24, 13], extras: ['question'], tilt: true },
  ask_b: { eyes: 'up_right', spark: 'bolt_small', sparkAt: [24, 13], extras: ['question_up'], tilt: true },
  disconnected: { eyes: 'closed', spark: 'none', dim: true },
  switch_trail: { eyes: 'left', spark: 'bolt', sparkAt: [24, 4], extras: ['trail'] },
} satisfies Record<string, FrameSpec>

export type FrameName = keyof typeof FRAMES
export const FRAME_NAMES = Object.keys(FRAMES) as FrameName[]

export interface AnimStep {
  frame: FrameName
  holdMs: number
  /** Random extra hold so idle motion does not feel metronomic. */
  jitterMs?: number
}

export interface PoseAnim {
  /** The frame shown alone in static mode; also the first frame shown. */
  key: FrameName
  steps: AnimStep[]
  /** false = play once and stay on the last step (e.g. success settles). */
  loop: boolean
  /** false = sits on the ground (no hover); only the disconnected pose. */
  hover?: boolean
}

/**
 * Hover cycle, layered on top of every pose script: lift 0 -> 1 -> 2 -> 1.
 * Each hold is long enough that BLE transfers keep up; the text lane still
 * jumps ahead of any queued frame.
 */
export const HOVER_CYCLE: readonly Lift[] = [0, 1, 2, 1]
export const HOVER_HOLD_MS = 600

export const ANIMS: Record<PoseName, PoseAnim> = {
  idle: {
    key: 'idle', loop: true,
    steps: [{ frame: 'idle', holdMs: 4000, jitterMs: 3000 }, { frame: 'idle_blink', holdMs: 300 }],
  },
  listening: {
    key: 'listen_a', loop: true,
    steps: [
      { frame: 'listen_a', holdMs: 900 },
      { frame: 'listen_b', holdMs: 900 },
      { frame: 'listen_c', holdMs: 900 },
    ],
  },
  waiting: {
    key: 'wait_3', loop: true,
    steps: [
      { frame: 'wait_1', holdMs: 700 },
      { frame: 'wait_2', holdMs: 700 },
      { frame: 'wait_3', holdMs: 1200 },
    ],
  },
  planning: {
    key: 'plan_a', loop: true,
    steps: [{ frame: 'plan_a', holdMs: 1400 }, { frame: 'plan_b', holdMs: 1400 }],
  },
  checking: {
    key: 'check_a', loop: true,
    steps: [{ frame: 'check_a', holdMs: 1200 }, { frame: 'check_b', holdMs: 1200 }],
  },
  repair: { key: 'repair', loop: false, steps: [{ frame: 'repair', holdMs: 0 }] },
  accepted: {
    key: 'accept_settle', loop: false,
    steps: [{ frame: 'accept_burst', holdMs: 1500 }, { frame: 'accept_settle', holdMs: 0 }],
  },
  asking: {
    key: 'ask_a', loop: true,
    steps: [{ frame: 'ask_a', holdMs: 2000 }, { frame: 'ask_b', holdMs: 900 }],
  },
  disconnected: {
    key: 'disconnected', loop: false, hover: false,
    steps: [{ frame: 'disconnected', holdMs: 0 }],
  },
  switching: {
    key: 'idle', loop: false,
    steps: [{ frame: 'switch_trail', holdMs: 1200 }, { frame: 'idle', holdMs: 0 }],
  },
}

const cache = new Map<string, number[]>()

/** Raw 4-bit grayscale pixels (0-15), length SIZE*SIZE, for updateImageRawData. */
export function framePixels(name: FrameName, lift: Lift = 0): number[] {
  const key = `${name}@${lift}`
  const hit = cache.get(key)
  if (hit) return hit
  const g = compose(FRAMES[name] as FrameSpec, lift)
  const out = new Array<number>(SIZE * SIZE)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      out[y * SIZE + x] = g[Math.floor(y / SCALE) * GRID + Math.floor(x / SCALE)]
    }
  }
  cache.set(key, out)
  return out
}
