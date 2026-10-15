/**
 * The setup boards' SVG icons, copied path for path (Main, Pair, Paired,
 * Repo, Move). Built with createElementNS from these descriptors, never
 * innerHTML, so the DOM shim the Node suites use can mount them too.
 *
 * No runtime imports and erasable-only syntax.
 */

export type IconShape = readonly [tag: 'path' | 'rect' | 'circle', attrs: Readonly<Record<string, string>>]

export interface IconDef {
  size: number
  strokeWidth: string
  /** The board leaves stroke-linejoin off the search glass. */
  join: boolean
  shapes: readonly IconShape[]
}

const icon = (size: number, shapes: IconShape[], strokeWidth = '2', join = true): IconDef =>
  ({ size, strokeWidth, join, shapes })

export const ICONS = {
  /** Main: Pair with my Factory computer. */
  computer: icon(22, [
    ['rect', { x: '3', y: '4', width: '18', height: '12', rx: '2' }],
    ['path', { d: 'M8 20h8M12 16v4' }],
  ]),
  /** Main: Use my Factory key only. */
  key: icon(22, [
    ['circle', { cx: '8', cy: '15', r: '4' }],
    ['path', { d: 'M11 12l9-9M17 6l3 3M15 8l2 2' }],
  ]),
  /** Main: Move from another phone. */
  phones: icon(22, [
    ['rect', { x: '2', y: '5', width: '8', height: '14', rx: '2' }],
    ['rect', { x: '14', y: '5', width: '8', height: '14', rx: '2' }],
    ['path', { d: 'M10 12h4M12.5 10.5L14 12l-1.5 1.5' }],
  ]),
  /** Main, Move: the encryption footnote. */
  lock: icon(18, [
    ['rect', { x: '4', y: '11', width: '16', height: '10', rx: '2' }],
    ['path', { d: 'M8 11V7a4 4 0 0 1 8 0v4' }],
  ]),
  back: icon(22, [['path', { d: 'M15 18l-6-6 6-6' }]]),
  copy: icon(16, [
    ['rect', { x: '9', y: '9', width: '12', height: '12', rx: '2' }],
    ['path', { d: 'M5 15V5a2 2 0 0 1 2-2h10' }],
  ]),
  scan: icon(18, [
    ['path', { d: 'M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M8 12h8' }],
  ]),
  check: icon(16, [['path', { d: 'M5 12l5 5L20 7' }]], '2.5'),
  search: icon(18, [
    ['circle', { cx: '11', cy: '11', r: '7' }],
    ['path', { d: 'M20 20l-4-4' }],
  ], '2', false),
  chevron: icon(18, [['path', { d: 'M9 6l6 6-6 6' }]]),
} as const satisfies Record<string, IconDef>

export type IconName = keyof typeof ICONS

const SVG_NS = 'http://www.w3.org/2000/svg'

/** One board icon as an SVG element (stroke follows CSS `color`). */
export function iconEl(name: IconName, cls?: string): SVGSVGElement {
  const def: IconDef = ICONS[name]
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  const s = String(def.size)
  svg.setAttribute('width', s)
  svg.setAttribute('height', s)
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', def.strokeWidth)
  svg.setAttribute('stroke-linecap', 'round')
  if (def.join) svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('data-icon', name)
  if (cls) svg.setAttribute('class', cls)
  for (const [tag, attrs] of def.shapes) {
    const shape = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v)
    svg.append(shape)
  }
  return svg
}

/**
 * A QR matrix (true = dark module) as one SVG path: one unit per module,
 * crisp edges, drawn in currentColor on the board's light tile.
 */
export function qrSvg(matrix: boolean[][], label: string): SVGSVGElement {
  const n = matrix.length
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  svg.setAttribute('viewBox', `0 0 ${Math.max(n, 1)} ${Math.max(n, 1)}`)
  svg.setAttribute('shape-rendering', 'crispEdges')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', label)
  let d = ''
  for (let y = 0; y < n; y++) {
    const row = matrix[y] ?? []
    for (let x = 0; x < row.length; x++) if (row[x]) d += `M${x} ${y}h1v1h-1z`
  }
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', d)
  path.setAttribute('fill', 'currentColor')
  svg.append(path)
  return svg
}
