/**
 * Phone design tokens and bundled fonts (contract C1, docs/design/REDESIGN-PLAN.md).
 *
 * Every value comes from the redesign boards in docs/design/redesign/. The
 * custom properties live on `.sp`, the root every phone screen renders inside
 * (the setup flow included), so a screen never hard-codes a colour the board
 * names. The fonts are files shipped in public/fonts (OFL), never loaded from
 * a font CDN at runtime.
 */

/** Variable name -> value, in the contract's order. Tests read this table. */
export const TOKENS: Readonly<Record<string, string>> = Object.freeze({
  '--sp-ground': '#07110A',
  '--sp-surface': '#0D1A11',
  '--sp-raised': '#13241A',
  '--sp-selected': '#0F2215',
  '--sp-line': '#1F3326',
  '--sp-line-strong': '#24452F',
  '--sp-text': '#EAF5EC',
  '--sp-muted': '#9AB1A0',
  '--sp-body-soft': '#D4E3D7',
  '--sp-accent': '#5CE57D',
  '--sp-accent-hover': '#8BF0A2',
  '--sp-accent-ink': '#04210E',
  '--sp-amber': '#F2B740',
  '--sp-amber-ground': '#1E1705',
  '--sp-amber-ink': '#2A1C00',
  '--sp-amber-line': '#6B5320',
  '--sp-amber-soft': '#FBE8C0',
  '--sp-amber-muted': '#D9C7A0',
  '--sp-factory': '#7DBEFF',
  '--sp-cursor': '#BDA4FF',
  '--sp-danger': '#FF8A7A',
  '--sp-nav': '#0A150D',
  '--sp-placeholder': '#7F9785',
  '--sp-radio-off': '#5A7562',
  '--sp-done-dot': '#5A7562',
  '--sp-step-off': '#2E4A37',
  '--sp-dash': '#3C5A45',
  '--sp-scrim': '#030805',
  '--sp-glass': '#000000',
  '--sp-glass-title': '#B8FFC8',
  '--sp-glass-body': '#8FE6A3',
  '--sp-glass-label': '#6FCF86',
  '--sp-glass-bar-off': '#1A3322',
  '--sp-font-display': "'Bricolage Grotesque', Georgia, serif",
  '--sp-font-ui': "'Instrument Sans', 'Helvetica Neue', Helvetica, sans-serif",
  '--sp-font-mono': "'JetBrains Mono', Menlo, monospace",
})

export const TOKENS_CSS = `
  .sp {
${Object.entries(TOKENS).map(([name, value]) => `    ${name}: ${value};`).join('\n')}
  }
`

/** The bundled font files (contract C1 names), by family and weight. */
export const FONT_FILES: ReadonlyArray<{ family: string; weight: number; file: string }> = Object.freeze([
  { family: 'Bricolage Grotesque', weight: 600, file: 'bricolage-grotesque-latin-600-normal.woff2' },
  { family: 'Bricolage Grotesque', weight: 700, file: 'bricolage-grotesque-latin-700-normal.woff2' },
  { family: 'Instrument Sans', weight: 400, file: 'instrument-sans-latin-400-normal.woff2' },
  { family: 'Instrument Sans', weight: 500, file: 'instrument-sans-latin-500-normal.woff2' },
  { family: 'Instrument Sans', weight: 600, file: 'instrument-sans-latin-600-normal.woff2' },
  { family: 'Instrument Sans', weight: 700, file: 'instrument-sans-latin-700-normal.woff2' },
  { family: 'JetBrains Mono', weight: 500, file: 'jetbrains-mono-latin-500-normal.woff2' },
  { family: 'JetBrains Mono', weight: 600, file: 'jetbrains-mono-latin-600-normal.woff2' },
])

/**
 * The app's base URL: Vite replaces import.meta.env in builds and dev; the
 * Node suites load this module without Vite, where it is undefined.
 */
const base = (): string => {
  // Written as the literal `import.meta.env` so Vite's replacement applies.
  const url = (import.meta.env?.BASE_URL as string | undefined) ?? '/'
  return url.endsWith('/') ? url : `${url}/`
}

export const FONT_CSS = FONT_FILES.map((f) => `
  @font-face {
    font-family: '${f.family}';
    font-style: normal;
    font-weight: ${f.weight};
    font-display: swap;
    src: url('${base()}fonts/${f.file}') format('woff2');
  }`).join('') + '\n'
