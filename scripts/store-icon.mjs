/**
 * Even Hub store icon (dev tool). The portal wants a 24x24 monochrome PNG.
 * The 32x32 sprite cannot be downscaled into that without mush, so the
 * character (flame body, two eye holes, bolt) is redrawn here at native size.
 *
 * Portal rules, enforced server-side and reported as "invalid icon pixel: x, y"
 * at the first offending pixel in scan order:
 * - background pixels are fully transparent;
 * - drawn pixels are opaque #f4f4f4, the color the portal's own draw tool
 *   exports (pure black and pure white are both rejected);
 * - drawn pixels come in 2x2 blocks aligned to even coordinates, so the art
 *   is effectively a 12x12 grid shown at 2x.
 *
 * Usage: node scripts/store-icon.mjs  ->  docs/assets/store-icon-24.png
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pngRgba } from './lib/png.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, 'docs/assets/store-icon-24.png')
const GRID = 12
const SCALE = 2
const N = GRID * SCALE
const INK = 0xf4

const ART = [
  '...#......##',
  '..###....##.',
  '..####..####',
  '.######..##.',
  '.#######.#..',
  '.##.#.##....',
  '.##.#.##....',
  '.#######....',
  '.#######....',
  '..#####.....',
  '...###......',
  '....#.......',
]

if (ART.length !== GRID || ART.some((row) => row.length !== GRID)) {
  throw new Error(`store icon art must be ${GRID}x${GRID}`)
}

const rgba = Buffer.alloc(N * N * 4)
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    if (ART[Math.floor(y / SCALE)][Math.floor(x / SCALE)] !== '#') continue
    const o = (y * N + x) * 4
    rgba[o] = rgba[o + 1] = rgba[o + 2] = INK
    rgba[o + 3] = 255
  }
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, pngRgba(N, N, rgba))
console.log(`wrote ${OUT}`)
