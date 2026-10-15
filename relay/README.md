# Spriite relay

Smart-glasses apps run as web pages inside the glasses' phone app, so every
network call they make follows browser rules (CORS). `api.factory.ai`,
`api.cursor.com`, and `api.x.com` only accept browser requests from their
own websites, and the glasses' network allowlist (for Even Hub, the
`app.json` whitelist) is a permission check, not a way around CORS. The
relay closes that gap: it forwards Spriite's requests to those three APIs
and adds the CORS headers on the way back.

You host it yourself, so your keys never pass through anyone else's server.

## What it does and doesn't do

- Forwards `/factory/...` to `https://api.factory.ai/...`, `/cursor/...` to
  `https://api.cursor.com/...`, and `/x/...` to `https://api.x.com/...`,
  and nothing else.
- Only on their API paths: `/api/v0/` for Factory, `/v0/` and `/v1/` for
  Cursor, and for X exactly the four owner-intake lookups (`/2/users/me`,
  `/2/users/by/username/:handle`, `/2/users/:id/tweets`, `/2/tweets/:id`)
  plus the one OAuth token endpoint (`/2/oauth2/token`).
  Any other path gets a 404.
- The `/x` route is read-only for content: any method other than GET or HEAD
  gets a 405, except the single fixed `POST /2/oauth2/token`, which renews
  the owner's own token pair (body passed through, POST only). The relay has
  no general write proxy and can never post, reply, like, or repost on X.
  Nothing X-specific is configured here: each owner registers their own X
  app (docs/X-INTAKE-HANDOFF.md) and its OAuth client id travels in that
  passed-through renewal body, configured on the phone in Setup.
- Passes only the `Authorization`, `Content-Type`, and `Accept` headers.
  No cookies, no origin, no referrer.
- Follows no redirects and refuses bodies over 1 MB.
- The bridge stores nothing and logs nothing. Two parts hold data: the
  pairing mailbox (below) holds short-lived ciphertext it cannot read, and
  the Node runner's archive routes store exactly the mission records the
  archive spec defines, logging `status + path` only.

Your keys do pass through it in transit, which is why you should run it
somewhere you control.

## Pairing mailbox (`/pair/v1/*`)

`npx spriite pair` and "Move to another phone" meet here (`pair.mjs`). The
mailbox holds, per one-time code, only: the public slot (the first two
characters of `K7Q-2MF`, or the first word of `WREN · 41 · OAK`), a random
session id, public CPace shares, key-confirmation tags and AES-256-GCM
ciphertext. It never sees a code, a key or a bundle in the clear, and what
it holds cannot be used to test guessed codes offline
([`docs/design/PAIRING-PROTOCOL.md`](../docs/design/PAIRING-PROTOCOL.md)).

- `POST /pair/v1/open | claim | put | poll | get | close`, JSON bodies;
  capability tokens ride in bodies, never in URLs.
- Every session is gone 10 minutes after it opened (an expired one answers
  "expired" from a bare tombstone for one more minute, then is swept).
  Closing drops the ciphertext at once.
- One open session per slot (a second open gets 409 and the host picks a new
  code), one claim per session, one message per side, a claim rate limit per
  client (10 a minute), bodies up to 1 MB.
- On Cloudflare it lives in one Durable Object (`PairMailbox`, bound as
  `PAIR_MAILBOX` in `wrangler.toml`, SQLite-backed so it runs on the free
  plan), which makes "one claim per code" strongly consistent. `npx wrangler
  deploy` creates it from the migration in `wrangler.toml`. A worker deployed
  without the binding answers the mailbox with 503 rather than a memory one.
- The Node runner keeps it in memory with a sweep every 30 seconds. Behind a
  tunnel every caller shares one address, so the claim limit is then global.
- Same CORS policy as the bridge; nothing is logged.

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

You can also run it with Node (no dependencies) on a machine you keep
online, behind an HTTPS tunnel you control:

```bash
PORT=8787 npm run relay    # listens on 127.0.0.1 only
cloudflared tunnel --url http://127.0.0.1:8787   # or a Tailscale Funnel
```

Installed apps need HTTPS, so use the tunnel's `https://` address. If the
machine sleeps or goes offline, Factory and Cursor calls fail until it's
back. The runner needs Node 22+ when the archive mirror is configured, since
the archive uses `node:sqlite`.

## Archive mirror (Node runner only)

The VPS archive mirror ([docs/VPS-ARCHIVE-SPEC.md](../docs/VPS-ARCHIVE-SPEC.md))
adds two routes, and only to the Node runner: the Cloudflare Worker cannot
host SQLite, so it answers `/spriite/...` with its usual 404 and its
read-only contract stays exactly as documented above. Deploy the Worker and
never run the runner, and the archive simply does not exist for you.

- `POST /spriite/sync` upserts a batch and answers
  `{"v": 1, "cursor": "<max updated_at in the batch>"}`. The body is the
  client's versioned envelope: `{"v": 1, "cursor": "<last ack>", "records":
  [...]}` — one flat array where every row carries its `kind` (`mission`,
  `chat`, `feed`, `tag`, `snapshot`) plus that table's column names (spec
  §7). Rows upsert in full, `missions` and `snapshots` never move backwards
  in `updated_at`, so replays and out-of-order retries are harmless. A batch
  is all-or-nothing: a row that does not fit, or a chat or snapshot row whose
  mission is not in the archive yet, refuses the whole batch with 400 and
  stores nothing. The batch cursor the phone sends is informational — records
  are full rows, so the relay never needs a delta.
- `POST /spriite/archive` answers one newest-first page:
  `{"v": 1, "records": [...], "cursor": "<next page>"}`, where the empty
  cursor means no more pages. Send `{"v": 1, "cursor": ""}` (or no body) to
  ask for the first page. An empty archive or an unknown cursor answers
  `{records: [], cursor: ""}` — restore never errors. Rows come back re-tagged
  with their `kind`, keyed and ordered exactly as they were sent, so a record
  that round trips is byte-identical.
- Records carry mission content only. The schema is the whole boundary: no
  column exists for anything else, so a credential-shaped field in a payload
  has nowhere to land. Credentials are excluded on the phone, before the
  payload is even built (spec §5).
- The relay holds only the sha-256 of the device key, never the key. Archive
  requests are logged as `status + path` and nothing else — no method, no
  headers, no bodies.

Both routes want `Authorization: Bearer <device key>`. Without it, or with
the wrong key: 401. Over `SPRIITE_ARCHIVE_RATE` requests a minute: 429. Over
1 MB: 413. A batch that carries no `updated_at` at all (empty, or chat, feed,
and tag rows only) acknowledges the empty cursor, which the phone reads as
"keep your watermark": an ack is a floor, never an assignment.

The device key is generated on the phone and shown once in Setup. The relay
never needs the key itself, only its hash:

```bash
printf %s "$SPRIITE_ARCHIVE_KEY" | shasum -a 256    # macOS; sha256sum on linux
# export the hex digest as SPRIITE_ARCHIVE_KEY_HASH
```

Storage is one SQLite file in WAL mode — no daemon, no new dependencies —
created `0600` with its journal so only the owner's account can read it.
Backup is a file copy: `sqlite3 "$SPRIITE_ARCHIVE_DB" "VACUUM INTO 'backup.db'"`
nightly, or copy the file while the relay is quiet. The relay process is the
only local client, and nothing runs between requests.

The rate window is stored in that same SQLite file (its `meta` table), not
in memory, so restarting the relay does not reset the count: over
`SPRIITE_ARCHIVE_RATE` requests a minute answers 429 after a restart just
the same. If the relay cannot read or write its own rate state (a broken
disk, usually), the archive routes fail closed with 503 rather than let a
request through uncounted.

Node prints one `ExperimentalWarning: node:sqlite is an experimental
feature` line when the relay starts, because `node:sqlite` is still flagged
experimental in Node 22+. The code does not suppress it — warnings exist to
be read. If the one line bothers you, start the relay with
`node --no-warnings relay/node.mjs` (in a systemd unit, that is the
`ExecStart` line); that silences every process warning, not just this one,
so it is your call to make, not the app's.

To keep the relay off the public internet entirely, serve it only on your
Tailscale network (no Funnel) and keep Tailscale connected on your phone:

```bash
tailscale serve --bg --https=443 --set-path /spriite-relay http://127.0.0.1:8787
# relay URL: https://<machine>.<tailnet>.ts.net/spriite-relay
```

Only devices on your tailnet can reach it, and nothing about it resolves in
public DNS. The trade-off: Spriite can't reach Factory or Cursor while the
phone is off the tailnet.

The relay is separate from the optional native broker, which runs Factory
Missions on your Factory host. Both can share one machine: the broker uses its
own loopback port (47821) and, with Tailscale, its own HTTPS port (47822). See
[`docs/NATIVE-BROKER-SETUP.md`](../docs/NATIVE-BROKER-SETUP.md).

## Check it

```bash
curl https://<your-relay>/health                     # -> spriite relay ok
curl -i https://<your-relay>/factory/api/v0/computers  # -> 401 with access-control-allow-origin
curl -i -X POST https://<your-relay>/x/2/users/me    # -> 405 read-only route
curl -i -X POST https://<your-relay>/x/2/tweets      # -> 404 not relayed
curl -i -X GET https://<your-relay>/x/2/oauth2/token # -> 405 oauth token route is POST only
```

A 401 is the expected answer without a key. It proves the request reached
Factory and came back readable by a browser. The two X checks prove the relay
refuses to write content on X while still carrying the one fixed OAuth renewal
route.

On the Node runner with the archive configured, the same checks plus:

```bash
curl -i -X POST https://<your-node-relay>/spriite/sync        # -> 401 without the device key
curl -i -X POST https://<your-worker>/spriite/sync            # -> 404: the worker hosts no archive
```

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
| `SPRIITE_ARCHIVE_KEY_HASH` | unset | Hex sha-256 of the phone's base64url device key. Only the hash is stored, never the key. Unset means no known bearer, so every archive request fails closed with 401. |
| `SPRIITE_ARCHIVE_DB` | `relay/spriite-archive.db` | Path to the archive's SQLite file. Created with the schema from spec §7, in WAL mode, `0600` alongside its journal. |
| `SPRIITE_ARCHIVE_RATE` | `60` | Archive requests per minute allowed. The count lives in the archive's SQLite file (one row per configured key hash), so a relay restart does not reset the window. Above it: 429. One owner syncing every 30 seconds never comes close. |
| `PORT` (Node only) | `8787` | Listen port. |
| `HOST` (Node only) | `127.0.0.1` | Listen address. Keep it local and expose it through a tunnel. |

For Cloudflare, set `ALLOWED_ORIGINS` under `[vars]` in `wrangler.toml`.
The three `SPRIITE_ARCHIVE_*` variables are Node-runner only: the Worker
has no SQLite, so it answers the archive paths with its usual 404.
