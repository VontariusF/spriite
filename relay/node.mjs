/**
 * Node runner for the Spriite relay (no dependencies). The recommended
 * deployment is the Cloudflare Worker (wrangler.toml); this runner is for
 * testing the relay or self-hosting it on another machine.
 *
 *   PORT=8787 ALLOWED_ORIGINS=* node relay/node.mjs
 *
 * Binds to 127.0.0.1 by default (set HOST to change it); the tunnel is the
 * only public entry point.
 *
 * It is also the only host of the archive mirror (docs/VPS-ARCHIVE-SPEC.md):
 * the worker has no SQLite, so the two authenticated archive routes are
 * answered here, in front of the shared stateless bridge, and the worker's
 * read-only matrix is untouched. Node 22+ (node:sqlite).
 *
 * Installed apps need HTTPS, so expose it through a tunnel you control
 * (for example `cloudflared tunnel` or a Tailscale Funnel) and build
 * Spriite with VITE_SPRIITE_RELAY set to that https URL.
 */
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { handle } from './worker.js'
import { createPairMailbox } from './pair.mjs'
import {
  ARCHIVE_RATE_PER_MINUTE,
  createArchive,
  defaultArchiveDbPath,
} from './archive.mjs'

const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '127.0.0.1'

/** The runner's pairing mailbox: in memory, swept every 30 seconds (records live 10 minutes). */
let defaultPair = null
function runnerPair() {
  if (!defaultPair) {
    defaultPair = createPairMailbox()
    const timer = setInterval(() => { defaultPair.sweep().catch(() => {}) }, 30_000)
    timer.unref?.()
  }
  return defaultPair
}

/**
 * One request through the Node relay: the archive routes first (they exist
 * only here), then the shared bridge with its unchanged 405/404 matrix (the
 * bridge dispatches /pair/v1/* to the in-memory pairing mailbox before
 * anything is relayed). Exported so the tests drive the same code path the
 * server runs.
 */
export async function relayHandle(request, archive, env, { pair = runnerPair(), client = 'unknown' } = {}) {
  return (await archive?.handle(request, env)) ?? handle(request, env, { pair, client })
}

function toWebRequest(req) {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v)
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  return new Request(`http://localhost${req.url ?? '/'}`, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? 'half' : undefined,
  })
}

const runningAsMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (runningAsMain) {
  const env = { ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? '*' }
  const configuredRate = Number(process.env.SPRIITE_ARCHIVE_RATE ?? ARCHIVE_RATE_PER_MINUTE)
  const ratePerMinute = Number.isSafeInteger(configuredRate) && configuredRate > 0 ? configuredRate : ARCHIVE_RATE_PER_MINUTE
  const archive = createArchive({
    // the db lives beside the relay unless the deployer points elsewhere;
    // the file is created 0600 because it holds the owner's history (§4)
    dbPath: process.env.SPRIITE_ARCHIVE_DB ?? defaultArchiveDbPath(),
    // the sha-256 of the phone's base64url device key; unset means no known
    // bearer and every archive request fails closed with 401
    keyHash: process.env.SPRIITE_ARCHIVE_KEY_HASH ?? '',
    ratePerMinute,
  })
  createServer(async (req, res) => {
    try {
      const response = await relayHandle(toWebRequest(req), archive, env, { client: req.socket.remoteAddress ?? 'unknown' })
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) Readable.fromWeb(response.body).pipe(res)
      else res.end()
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('relay error')
    }
  }).listen(port, host, () => {
    console.log(`spriite relay listening on ${host}:${port}`)
    if (!process.env.SPRIITE_ARCHIVE_KEY_HASH) {
      console.log('spriite archive at the default path, but SPRIITE_ARCHIVE_KEY_HASH is unset: archive routes answer 401')
    }
  })
}
