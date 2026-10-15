/**
 * Pose snapshot fixtures for the twelve Spriite poses
 * (docs/design/redesign/Sprite.dc.html, MotionLab.dc.html).
 *
 * Writes two artifacts:
 *   scripts/fixtures/sprite-poses.json  pose -> script, holds, key frame, pixel hashes
 *   shots/sprite-poses.png              one row per pose, every frame left to right
 *
 * The JSON is committed and checked by scripts/test-sprite.mjs, so a change
 * to a pose's pixels or its script fails the suite until the fixture is
 * regenerated deliberately.
 *
 * Usage: node scripts/sprite-fixtures.mjs
 */
import './ts-resolve.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { png } from './lib/png.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const JSON_OUT = resolve(ROOT, 'scripts/fixtures/sprite-poses.json')
const PNG_OUT = resolve(ROOT, 'shots/sprite-poses.png')

const { POSE_NAMES, ANIMS, framePixels, SIZE } = await import(
  pathToFileURL(resolve(ROOT, 'src/sprite/frames.ts')).href
)
const { POSES } = await import(pathToFileURL(resolve(ROOT, 'src/sprite/draw.ts')).href)
const { POSE_META } = await import(pathToFileURL(resolve(ROOT, 'src/sprite/poses.ts')).href)

const hashPixels = (px) => createHash('sha256').update(px.join(',')).digest('hex').slice(0, 16)

const fixtures = {}
for (const pose of POSE_NAMES) {
  const anim = ANIMS[pose]
  if (!anim) throw new Error(`pose "${pose}" has no animation script`)
  fixtures[pose] = {
    name: POSE_META[pose].name,
    key: anim.key,
    loop: anim.loop,
    steps: anim.steps.map((s, i) => ({ frame: s.frame, d: POSES[pose][i].d, holdMs: s.holdMs })),
    // Static fallback: the exact pixels static mode pins (the key frame).
    staticPixels: hashPixels(framePixels(anim.key)),
    framePixels: anim.steps.map((s) => hashPixels(framePixels(s.frame))),
  }
}

mkdirSync(dirname(JSON_OUT), { recursive: true })
writeFileSync(JSON_OUT, `${JSON.stringify(fixtures, null, 2)}\n`)

// Sheet: one row per pose (POSE_NAMES order), its frames left to right.
const SCALE = 3
const PAD = 16
const COLS = Math.max(...POSE_NAMES.map((p) => ANIMS[p].steps.length))
const CELL = SIZE * SCALE
const ROWS = POSE_NAMES.length
const W = COLS * (CELL + PAD) + PAD
const H = ROWS * (CELL + PAD) + PAD
const img = Buffer.alloc(W * H).fill(0)
const px = (x, y, v) => {
  if (x >= 0 && y >= 0 && x < W && y < H) img[y * W + x] = v
}
POSE_NAMES.forEach((pose, row) => {
  ANIMS[pose].steps.forEach((s, col) => {
    const ox = PAD + col * (CELL + PAD)
    const oy = PAD + row * (CELL + PAD)
    const border = s.frame === ANIMS[pose].key ? 140 : 60
    for (let i = 0; i < CELL + 2; i++) {
      px(ox - 1 + i, oy - 1, border)
      px(ox - 1 + i, oy + CELL, border)
      px(ox - 1, oy - 1 + i, border)
      px(ox + CELL, oy - 1 + i, border)
    }
    const data = framePixels(s.frame)
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const v = data[y * SIZE + x]
        if (!v) continue
        const g = v * 17
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) px(ox + x * SCALE + dx, oy + y * SCALE + dy, g)
        }
      }
    }
  })
})
mkdirSync(dirname(PNG_OUT), { recursive: true })
writeFileSync(PNG_OUT, png(W, H, img))

console.log(`Pose fixtures: ${POSE_NAMES.length} poses -> scripts/fixtures/sprite-poses.json`)
console.log(`Pose sheet: shots/sprite-poses.png (${W}x${H}, one row per pose)`)
for (const pose of POSE_NAMES) {
  const f = fixtures[pose]
  const holds = f.steps.map((s) => s.holdMs).join('/')
  console.log(
    `  ${pose.padEnd(11)} ${f.name.padEnd(12)} ${String(f.steps.length)} frames  key=${f.key.padEnd(12)} ${f.loop ? 'loop' : 'once'}  glasses ${holds} ms  static=${f.staticPixels}`,
  )
}
