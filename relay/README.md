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

## Deploy (Cloudflare Worker)

This is the recommended setup: free, always on, HTTPS by default, and
nothing to keep running yourself. You need a free Cloudflare account.

```bash
cd relay
npx wrangler login         # first time only; opens Cloudflare in your browser
npx wrangler deploy        # prints https://spriite-relay.<you>.workers.dev
```

The printed URL is your relay. The free tier allows 100,000 requests a
day. Spriite polls active sessions every 3 to 5 seconds, so an hour of
active work uses roughly 2,000 requests with one worker and up to about
6,000 with four in parallel.

## Other hosts (advanced)

`worker.js` exports a standard `fetch(request, env)` handler, so it also
runs on other platforms that support Web-standard handlers (Deno Deploy,
Bun, Vercel Edge, Netlify Edge) with little or no change.

You can also run it with Node 18+ (no dependencies) on a machine you keep
online, behind an HTTPS tunnel you control:

```bash
PORT=8787 npm run relay    # listens on 127.0.0.1 only
cloudflared tunnel --url http://127.0.0.1:8787   # or a Tailscale Funnel
```

Installed apps need HTTPS, so use the tunnel's `https://` address. If the
machine sleeps or goes offline, Factory and Cursor calls fail until it's
back.

To keep the relay off the public internet entirely, serve it only on your
Tailscale network (no Funnel) and keep Tailscale connected on your phone:

```bash
tailscale serve --bg --https=443 --set-path /spriite-relay http://127.0.0.1:8787
# relay URL: https://<machine>.<tailnet>.ts.net/spriite-relay
```

Only devices on your tailnet can reach it, and nothing about it resolves in
public DNS. The trade-off: Spriite can't reach Factory or Cursor while the
phone is off the tailnet.

## Check it

```bash
curl https://<your-relay>/health                     # -> spriite relay ok
curl -i https://<your-relay>/factory/api/v0/computers  # -> 401 with access-control-allow-origin
```

A 401 is the expected answer without a key. It proves the request reached
Factory and came back readable by a browser.

## Build Spriite against it

```bash
cp .env.example .env.production.local   # then set VITE_SPRIITE_RELAY and SPRIITE_PACKAGE_ID
npm run pack
```

`npm run pack` bakes the relay URL into the build and swaps the direct
Factory and Cursor entries in the packed network allowlist for your relay's
origin. The source `app.json` isn't edited, and `.env.production.local` is
git-ignored. A relay mounted under a path (for example
`https://example.com/spriite-relay`) works too.

The Even app enforces that allowlist on the phone and accepts exact
origins only, so a build reaches exactly one relay: yours. Moving the relay
means packing and uploading again.

## Options

| Variable | Default | Purpose |
|---|---|---|
| `ALLOWED_ORIGINS` | `*` | Comma-separated origins allowed to read relayed responses. The glasses host decides the app's origin, so `*` is the safe default. |
| `PORT` (Node only) | `8787` | Listen port. |
| `HOST` (Node only) | `127.0.0.1` | Listen address. Keep it local and expose it through a tunnel. |

For Cloudflare, set `ALLOWED_ORIGINS` under `[vars]` in `wrangler.toml`.
