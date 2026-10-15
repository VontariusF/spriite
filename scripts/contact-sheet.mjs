/**
 * Sprite contact sheet (dev tool). Renders every frame of the twelve poses
 * (src/sprite/frames.ts, drawn by draw.ts from Sprite.dc.html) to a PNG grid
 * for visual review: one row per pose, its frames left to right. The
 * ts-resolve loader lets Node load the extensionless TypeScript sources.
 *
 * Usage: node scripts/contact-sheet.mjs [out.png]  ->  shots/sprite-frames.png
 */
import './ts-resolve.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.argv[2] ? resolve(process.argv[2]) : resolve(ROOT, 'shots/sprite-frames.png')

const { POSE_NAMES, ANIMS, framePixels } = await import(
  pathToFileURL(resolve(ROOT, 'src/sprite/frames.ts')).href
)

// ------------------------------------------------------------------ PNG (8-bit grayscale)

const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c
}
function crc32(buf) {
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function png(width, height, gray) {
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0 // filter type: none
    gray.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ------------------------------------------------------------------ sheet

const SIZE = 64 // frame container size in px
const SCALE = 3
const PAD = 14
const COLS = Math.max(...POSE_NAMES.map((p) => ANIMS[p].steps.length))
const CELL = SIZE * SCALE
// One row per pose; empty cells pad shorter poses.
const CELLS = POSE_NAMES.flatMap((pose) =>
  Array.from({ length: COLS }, (_, i) => {
    const step = ANIMS[pose].steps[i]
    return step ? { name: step.frame, label: `${step.frame} ${step.holdMs}ms` } : null
  }),
)
const ROWS = POSE_NAMES.length
const W = COLS * (CELL + PAD) + PAD
const H = ROWS * (CELL + PAD) + PAD
const img = Buffer.alloc(W * H).fill(0)
const px = (x, y, v) => {
  if (x >= 0 && y >= 0 && x < W && y < H) img[y * W + x] = v
}

CELLS.forEach((cell, idx) => {
  if (!cell) return
  const { name } = cell
  const ox = PAD + (idx % COLS) * (CELL + PAD)
  const oy = PAD + Math.floor(idx / COLS) * (CELL + PAD)
  for (let i = 0; i < CELL + 2; i++) {
    px(ox - 1 + i, oy - 1, 60)
    px(ox - 1 + i, oy + CELL, 60)
  }
  for (let i = 0; i < CELL + 2; i++) {
    px(ox - 1, oy - 1 + i, 60)
    px(ox + CELL, oy - 1 + i, 60)
  }
  const data = framePixels(name)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const v = data[y * SIZE + x]
      if (!v) continue
      const g = v * 17 // as on the glasses: 0 = off, 15 = brightest
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) px(ox + x * SCALE + dx, oy + y * SCALE + dy, g)
      }
    }
  }
})

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, png(W, H, img))

console.log(`Contact sheet: ${OUT} (${W}x${H}, ${CELLS.filter(Boolean).length} frames)`)
console.log(`Grid (one row per pose, ${COLS} per row):`)
CELLS.forEach((c, idx) => {
  if (!c) return
  const { label } = c
  const cell = `r${Math.floor(idx / COLS) + 1}c${(idx % COLS) + 1}`
  console.log(`  [${String(idx).padStart(2, '0')}] ${label.padEnd(20)} ${cell}`)
})
console.log('Pose scripts (key = static-mode frame):')
for (const [pose, anim] of Object.entries(ANIMS)) {
  const seq = anim.steps.map((s) => `${s.frame}${s.holdMs ? `:${s.holdMs}ms` : ''}`).join(' -> ')
  console.log(`  ${pose.padEnd(13)} key=${anim.key.padEnd(13)} ${anim.loop ? 'loop' : 'once'}  ${seq}`)
}
