import { defineConfig, type Plugin, type ProxyOptions } from 'vite'

/**
 * Dev-only request log: one line per incoming request (timestamp, method,
 * URL, source address) lands in the dev-server output. Phone/simulator
 * attempts are then visible while debugging prototype-mode loading.
 */
const requestLog = (): Plugin => ({
  name: 'request-log',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const addr = req.socket.remoteAddress ?? '?'
      console.log(`[req] ${new Date().toISOString()} ${req.method ?? '?'} ${req.url ?? '?'} from ${addr}`)
      next()
    })
  },
})

/**
 * Dev-only proxy result log: status per proxied API call, plus the error body
 * (never request headers, so keys stay out of the log) for 4xx/5xx. The
 * phone's API failures are then readable from the dev-server output. The X
 * OAuth token route is the exception: its body carries a credential in both
 * directions, so only its outcome is logged.
 */
const logProxy = (label: string): ProxyOptions['configure'] => (proxy) => {
  proxy.on('proxyRes', (res, req) => {
    const status = res.statusCode ?? 0
    const tokenRoute = (req as { spriiteXTokenRoute?: boolean }).spriiteXTokenRoute === true
    if (status < 400 || tokenRoute) {
      console.log(`[api] ${label} ${status} ${req.method} ${req.url}`)
      return
    }
    const chunks: Buffer[] = []
    res.on('data', (c: Buffer) => chunks.push(c))
    res.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8').slice(0, 500)
      console.log(`[api] ${label} ${status} ${req.method} ${req.url} :: ${body}`)
    })
  })
}

/**
 * The dev proxy holds X to the same contract as the relay: GET or HEAD on the
 * four owner-intake lookups, plus exactly one POST — the OAuth token endpoint
 * that renews the owner's own token pair. Nothing else, by any method (the dev
 * server listens on the LAN, so this is not just a local convenience).
 */
const X_PATHS = [
  /^\/2\/users\/me$/,
  /^\/2\/users\/by\/username\/[A-Za-z0-9_]{1,15}$/,
  /^\/2\/users\/\d{1,20}\/tweets$/,
  /^\/2\/tweets\/\d{1,20}$/,
]
const X_OAUTH_TOKEN_PATH = /^\/2\/oauth2\/token$/
const xReadOnly = (): Plugin => ({
  name: 'x-read-only',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? ''
      if (!url.startsWith('/api/x/') && url !== '/api/x') return next()
      const path = new URL(url, 'http://dev').pathname.replace(/^\/api\/x/, '')
      if (X_OAUTH_TOKEN_PATH.test(path)) {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end('oauth token route is POST only')
        }
        // keep the credential-bearing response body out of the dev log
        ;(req as { spriiteXTokenRoute?: boolean }).spriiteXTokenRoute = true
        return next()
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        return res.end('read-only route')
      }
      if (!X_PATHS.some((re) => re.test(path))) {
        res.statusCode = 404
        return res.end('not relayed')
      }
      next()
    })
  },
})

export default defineConfig({
  plugins: [requestLog(), xReadOnly()],
  // No hmr.host pin: the HMR client follows the host the page loaded from,
  // so localhost (simulator), a LAN IP, and an overlay-network IP all keep
  // working without config edits per network.
  server: {
    host: true,
    // api.cursor.com and api.factory.ai do not grant CORS to browser origins
    // on their API paths (unlike api.elevenlabs.io / api.github.com, which
    // send allow-origin: *), so a WebView can never call them directly. In
    // prototype mode the dev server is same-origin with the app and proxies
    // these calls; installed builds go through the self-hosted relay
    // (relay/, VITE_SPRIITE_RELAY).
    proxy: {
      '/api/cursor': {
        target: 'https://api.cursor.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/cursor/, ''),
        configure: logProxy('cursor'),
      },
      // Owner X intake: the four read lookups plus the one OAuth token route
      // the transport renews with (see xReadOnly above).
      '/api/x': {
        target: 'https://api.x.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/x/, ''),
        configure: logProxy('x'),
      },
      // The pairing mailbox (relay/pair.mjs) on a local relay: `npm run relay`
      // listens on 127.0.0.1:8787; SPRIITE_DEV_RELAY points elsewhere. Bodies
      // are ciphertext and public PAKE messages only, never logged here.
      '/api/pair': {
        target: process.env.SPRIITE_DEV_RELAY ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/pair/, '/pair'),
        configure: logProxy('pair'),
      },
      '/api/factory': {
        target: 'https://api.factory.ai',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/factory/, ''),
        configure: logProxy('factory'),
      },
    },
  },
})
