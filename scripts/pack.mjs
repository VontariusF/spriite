/**
 * Pack the built app into an .ehpk, stamping the relay origin into the
 * network whitelist when VITE_SPRIITE_RELAY is set (process env or a Vite
 * .env file). The source app.json is never rewritten.
 *
 * With a relay, api.factory.ai and api.cursor.com leave the whitelist (the
 * build only reaches them through the relay). Without one, the manifest is
 * packed as-is and installed builds cannot reach Factory or Cursor.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { loadEnv } from 'vite'

const DIRECT = ['https://api.factory.ai', 'https://api.cursor.com']
const out = process.argv[2] ?? 'spriite.ehpk'
const env = loadEnv('production', process.cwd(), 'VITE_')
const raw = (process.env.VITE_SPRIITE_RELAY ?? env.VITE_SPRIITE_RELAY ?? '').trim()

const manifest = JSON.parse(readFileSync('app.json', 'utf8'))
let manifestPath = 'app.json'

if (raw) {
  let origin
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || u.search || u.hash) throw new Error()
    origin = u.origin
  } catch {
    console.error(`VITE_SPRIITE_RELAY must be an https URL with no query (got "${raw}")`)
    process.exit(1)
  }
  const net = manifest.permissions.find((p) => p.name === 'network')
  net.whitelist = [...net.whitelist.filter((o) => !DIRECT.includes(o)), origin]
  mkdirSync('.pack', { recursive: true })
  manifestPath = '.pack/app.json'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`relay: ${origin} (Factory and Cursor go through it)`)
} else {
  console.warn('relay: none. Installed builds cannot reach Factory or Cursor (no CORS). Set VITE_SPRIITE_RELAY; see relay/README.md.')
}

execFileSync('npx', ['evenhub', 'pack', manifestPath, 'dist', '-o', out], { stdio: 'inherit' })
