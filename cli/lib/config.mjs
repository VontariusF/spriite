/**
 * The host's saved `spriite` settings: only the relay URL (no secret). One
 * JSON file, mode 0600, under the user's config dir:
 *   Linux  $XDG_CONFIG_HOME/spriite/host.json (default ~/.config/spriite/host.json)
 *   macOS  ~/Library/Application Support/Spriite/host.json
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function configPath({ env, os, home }) {
  if (os === 'linux') return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'spriite', 'host.json')
  return join(home, 'Library/Application Support/Spriite/host.json')
}

/** https (or loopback http for a local relay), no credentials, query or fragment. */
export function relayUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const u = new URL(raw.trim())
    if (u.username || u.password || u.search || u.hash) return null
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) return null
    return u.href.replace(/\/+$/, '')
  } catch { return null }
}

export function readConfig(path, readFile = p => readFileSync(p, 'utf8')) {
  try {
    const v = JSON.parse(readFile(path))
    return v && typeof v === 'object' && v.v === 1 ? v : null
  } catch { return null }
}

export function writeConfig(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify({ v: 1, ...value }, null, 2) + '\n', { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, path)
}

/** --relay, then SPRIITE_RELAY, then the saved config; null when none is usable. */
export function chooseRelay({ flag, env, saved }) {
  for (const candidate of [flag, env.SPRIITE_RELAY, saved?.relay]) {
    const url = relayUrl(candidate)
    if (url) return url
  }
  return null
}
