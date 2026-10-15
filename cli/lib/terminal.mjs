/**
 * Terminal output for `spriite pair`: the code in large block letters, the QR
 * code in half blocks, the expiry, and the Found / Later summary. Pure string
 * builders, so the tests read exactly what the owner sees.
 */

// 5x5 glyphs for the Crockford alphabet and the separator.
const GLYPHS = {
  0: ['01110', '10011', '10101', '11001', '01110'], 1: ['00100', '01100', '00100', '00100', '01110'],
  2: ['11110', '00001', '01110', '10000', '11111'], 3: ['11110', '00001', '00110', '00001', '11110'],
  4: ['10010', '10010', '11111', '00010', '00010'], 5: ['11111', '10000', '11110', '00001', '11110'],
  6: ['01110', '10000', '11110', '10001', '01110'], 7: ['11111', '00010', '00100', '01000', '01000'],
  8: ['01110', '10001', '01110', '10001', '01110'], 9: ['01110', '10001', '01111', '00001', '01110'],
  A: ['01110', '10001', '11111', '10001', '10001'], B: ['11110', '10001', '11110', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '01111'], D: ['11110', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '11110', '10000', '11111'], F: ['11111', '10000', '11110', '10000', '10000'],
  G: ['01111', '10000', '10011', '10001', '01111'], H: ['10001', '10001', '11111', '10001', '10001'],
  J: ['00111', '00001', '00001', '10001', '01110'], K: ['10010', '10100', '11000', '10100', '10010'],
  M: ['10001', '11011', '10101', '10001', '10001'], N: ['10001', '11001', '10101', '10011', '10001'],
  P: ['11110', '10001', '11110', '10000', '10000'], Q: ['01110', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '11110', '10010', '10001'], S: ['01111', '10000', '01110', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100'], V: ['10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10101', '11011', '10001'], X: ['10001', '01010', '00100', '01010', '10001'],
  Y: ['10001', '01010', '00100', '00100', '00100'], Z: ['11111', '00010', '00100', '01000', '11111'],
  '-': ['00000', '00000', '01110', '00000', '00000'],
}

/** 'K7Q-2MF' in 5-row block letters (one column gap between glyphs). */
export function bigCode(display) {
  const rows = ['', '', '', '', '']
  for (const ch of String(display)) {
    const g = GLYPHS[ch.toUpperCase()]
    if (!g) continue
    g.forEach((bits, i) => { rows[i] += [...bits].map(b => (b === '1' ? '█' : ' ')).join('') + '  ' })
  }
  return rows.map(r => `  ${r.trimEnd()}`).join('\n')
}

/**
 * The QR in half blocks with a 4-module quiet zone. ANSI colours fix dark on
 * light whatever the terminal theme; without colour the modules are drawn
 * light-on-dark (most phone cameras read either).
 */
export function terminalQr(matrix, { color = true } = {}) {
  const n = matrix.length, q = 4
  const dark = (x, y) => x >= 0 && y >= 0 && x < n && y < n && matrix[y][x]
  const lines = []
  for (let y = -q; y < n + q; y += 2) {
    let line = ''
    for (let x = -q; x < n + q; x++) {
      const top = dark(x, y), bottom = dark(x, y + 1)
      if (color) line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
      else line += !top && !bottom ? '█' : !top ? '▀' : !bottom ? '▄' : ' '
    }
    lines.push(color ? `  \x1b[30;47m${line}\x1b[0m` : `  ${line}`)
  }
  return lines.join('\n')
}

export function minutesLeft(expiresAt, now = Date.now()) {
  const s = Math.max(0, Math.round((expiresAt - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function summaryTable(rows) {
  const w = Math.max(...rows.map(r => r.name.length))
  return rows.map(r => `  ${(r.found ? 'Found' : 'Later').padEnd(6)} ${r.name.padEnd(w)}  ${r.detail}`).join('\n')
}

export const HELP = `spriite: pair Spriite on your phone with this Factory computer

Usage:
  npx spriite pair [--relay URL] [--dry-run] [--no-install]
  npx spriite help

pair      Install or start the Spriite host (the native broker), find your
          Factory key, Droid computer, GitHub CLI sign-in and host link, then
          show a 6-character code and a QR code. Type the code in Spriite on
          your phone. It works once and expires after 10 minutes.

Options:
  --relay URL    Your Spriite relay (else SPRIITE_RELAY, else the saved config;
                 asked once and saved, mode 0600).
  --dry-run      Print the plan with every secret redacted. Changes nothing.
  --no-install   Use an existing broker install only; never install one.

Environment (all optional):
  FACTORY_API_KEY      Factory key (else the broker's key file, else droid's login)
  MODELS               First install only: JSON array of Factory model ids
  ELEVENLABS_API_KEY   Sent along for spoken replies
  SPRIITE_BROKER_URL   Your https broker URL when it is not served by Tailscale
  SPRIITE_HOME         Broker base dir (same as the installer)
`
