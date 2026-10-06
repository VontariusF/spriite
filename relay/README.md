# Spriite relay

Smart-glasses apps run as web pages inside the glasses' phone app, so every
network call they make follows browser rules (CORS). `api.factory.ai` and
`api.cursor.com` only accept browser requests from their own websites, and
the glasses' network allowlist (for Even Hub, the `app.json` whitelist) is a
permission check, not a way around CORS. The relay closes that gap: it
forwards Spriite's requests to those two APIs and adds the CORS headers on
the way back.

You host it yourself, so your keys never pass through anyone else's server.

## What it does and doesn't do

- Forwards `/factory/...` to `https://api.factory.ai/...` and `/cursor/...`
  to `https://api.cursor.com/...`, and nothing else.
- Only on their API paths: `/api/v0/` for Factory, `/v0/` and `/v1/` for
  Cursor. Any other path gets a 404.
- Passes only the `Authorization`, `Content-Type`, and `Accept` headers.
  No cookies, no origin, no referrer.
- Follows no redirects and refuses bodies over 1 MB.
- Stores nothing and logs nothing.

Your keys do pass through it in transit, which is why you should run it
somewhere you control.

## Deploy

### Option A: Cloudflare Worker (free tier)

```bash
cd relay
npx wrangler login         # first time only
npx wrangler deploy        # prints https://spriite-relay.<you>.workers.dev
```

The free tier allows 100,000 requests a day. Spriite polls active sessions
every 3 to 5 seconds, so an hour of active work uses roughly 2,000 requests
with one worker and up to about 6,000 with four in parallel.

### Option B: your own machine

```bash
npm run relay              # or: PORT=8787 node relay/node.mjs (Node 18+, no dependencies)
tailscale funnel 8787      # or: cloudflared tunnel --url http://localhost:8787
```

Installed apps need HTTPS, so use the tunnel's `https://` address. The
machine has to be awake and online whenever you use Spriite.

### Option C: anywhere else

`worker.js` exports a standard `fetch(request, env)` handler, so it runs
on any platform that supports Web-standard handlers (Deno Deploy, Bun,
Vercel Edge, Netlify Edge) with little or no change.

## Check it

```bash
curl https://<your-relay>/health                     # -> spriite relay ok
curl -i https://<your-relay>/factory/api/v0/computers  # -> 401 with access-control-allow-origin
```

A 401 is the expected answer without a key. It proves the request reached
Factory and came back readable by a browser.

## Build Spriite against it

```bash
echo 'VITE_SPRIITE_RELAY=https://<your-relay>' > .env.production.local
npm run pack
```

The value is an `https://` URL: a bare origin, or one with a path prefix if
the relay is mounted under a path (for example
`tailscale funnel --bg --set-path /spriite-relay http://127.0.0.1:8787`
gives `https://<machine>.<tailnet>.ts.net/spriite-relay`). The allowlist
entry is the origin. `npm run pack` bakes it
into the build and swaps the direct Factory and Cursor entries in the packed
network allowlist for your relay. The source `app.json` isn't edited, and
`.env.production.local` is git-ignored.

## Options

| Variable | Default | Purpose |
|---|---|---|
| `ALLOWED_ORIGINS` | `*` | Comma-separated origins allowed to read relayed responses. The glasses host decides the app's origin, so `*` is the safe default. |
| `PORT` (Node only) | `8787` | Listen port. |

For Cloudflare, set `ALLOWED_ORIGINS` under `[vars]` in `wrangler.toml`.
