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
 * phone's API failures are then readable from the dev-server output.
 */
const logProxy = (label: string): ProxyOptions['configure'] => (proxy) => {
  proxy.on('proxyRes', (res, req) => {
    const status = res.statusCode ?? 0
    if (status < 400) {
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

export default defineConfig({
  plugins: [requestLog()],
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
      '/api/factory': {
        target: 'https://api.factory.ai',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/factory/, ''),
        configure: logProxy('factory'),
      },
    },
  },
})
