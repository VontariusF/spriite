/**
 * Node runner for the Spriite relay (Node 18+, no dependencies). The
 * recommended deployment is the Cloudflare Worker (wrangler.toml); this
 * runner is for testing the relay or self-hosting it on another machine.
 *
 *   PORT=8787 ALLOWED_ORIGINS=* node relay/node.mjs
 *
 * Binds to 127.0.0.1 by default (set HOST to change it); the tunnel is the
 * only public entry point.
 *
 * Installed apps need HTTPS, so expose it through a tunnel you control
 * (for example `cloudflared tunnel` or a Tailscale Funnel) and build
 * Spriite with VITE_SPRIITE_RELAY set to that https URL.
 */
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { handle } from './worker.js'

const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '127.0.0.1'
const env = { ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? '*' }

createServer(async (req, res) => {
  try {
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v)
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    const request = new Request(`http://localhost${req.url ?? '/'}`, {
      method: req.method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? 'half' : undefined,
    })
    const response = await handle(request, env)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) Readable.fromWeb(response.body).pipe(res)
    else res.end()
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('relay error')
  }
}).listen(port, host, () => {
  console.log(`spriite relay listening on ${host}:${port}`)
})
