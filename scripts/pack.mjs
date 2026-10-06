/**
 * Pack the built app into an .ehpk for your own Even Hub project.
 *
 * Spriite is bring-your-own-relay: every build is made by the person who
 * runs it, against the relay they host. The Even app enforces the network
 * whitelist before a request leaves the WebView and accepts exact origins
 * only (no wildcards), so the relay origin has to be stamped in at pack
 * time. Settings come from the process env or .env.production.local
 * (see .env.example):
 *
 * - VITE_SPRIITE_RELAY (required): your relay's https URL. Its origin
 *   replaces api.factory.ai and api.cursor.com in the packed whitelist.
 * - SPRIITE_PACKAGE_ID (optional): the package_id of your Even Hub
 *   project. Package ids are unique per developer account, so use your own.
 *
 * The source app.json is never rewritten. `--no-relay` packs a build that
 * only runs the demo (installed builds cannot reach Factory or Cursor
 * without a relay: they send no CORS headers).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { loadEnv } from 'vite'

const DIRECT = ['https://api.factory.ai', 'https://api.cursor.com']
const PACKAGE_ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/
const args = process.argv.slice(2)
const noRelay = args.includes('--no-relay')
const out = args.find((a) => !a.startsWith('--')) ?? 'spriite.ehpk'
const env = loadEnv('production', process.cwd(), ['VITE_', 'SPRIITE_'])
const setting = (name) => (process.env[name] ?? env[name] ?? '').trim()
const raw = setting('VITE_SPRIITE_RELAY')
const packageId = setting('SPRIITE_PACKAGE_ID')

function fail(lines) {
  console.error(lines.join('\n'))
  process.exit(1)
}

const manifest = JSON.parse(readFileSync('app.json', 'utf8'))

if (packageId) {
  if (!PACKAGE_ID.test(packageId)) {
    fail([
      `SPRIITE_PACKAGE_ID "${packageId}" is not a valid Even Hub package id.`,
      'Use lowercase reverse-domain form with letters and digits only, for example com.yourname.spriite.',
    ])
  }
  manifest.package_id = packageId
}

if (raw) {
  let origin
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || u.search || u.hash) throw new Error()
    origin = u.origin
  } catch {
    fail([`VITE_SPRIITE_RELAY must be an https URL with no query (got "${raw}").`])
  }
  const net = manifest.permissions.find((p) => p.name === 'network')
  net.whitelist = [...net.whitelist.filter((o) => !DIRECT.includes(o)), origin]
  console.log(`relay: ${origin} (Factory and Cursor go through it)`)
} else if (!noRelay) {
  fail([
    'No relay set. Spriite builds talk to Factory and Cursor through a relay you host,',
    'and the Even app only allows the exact origin packed into the build.',
    '',
    '  1. Deploy the relay (relay/README.md).',
    '  2. Put its URL in .env.production.local (see .env.example):',
    '       VITE_SPRIITE_RELAY=https://spriite-relay.<you>.workers.dev',
    '  3. Run npm run pack again.',
    '',
    'To pack a demo-only build anyway: npm run pack -- --no-relay',
  ])
} else {
  console.warn('relay: none (--no-relay). This build runs the demo only; Factory and Cursor are unreachable.')
}

console.log(
  packageId
    ? `package_id: ${manifest.package_id}`
    : `package_id: ${manifest.package_id} (the default; set SPRIITE_PACKAGE_ID to your own Even Hub project's id)`,
)
mkdirSync('.pack', { recursive: true })
writeFileSync('.pack/app.json', JSON.stringify(manifest, null, 2))
execFileSync('npx', ['evenhub', 'pack', '.pack/app.json', 'dist', '-o', out], { stdio: 'inherit' })
