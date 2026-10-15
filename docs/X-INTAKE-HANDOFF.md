# X intake — what is left, and what only you can do

Owner-only X intake (spec §11, §21) is implemented, unit-tested, and wired to
phone setup and the durable runtime. **Its flag stays off by default.** This page is the complete
handoff: what exists, what is missing, and the account work that only you can
do. Nothing here writes to X content, ever.

The short version:

- The read path, authorization rules, dedupe, context capture, and receipts are
  done (`src/intake/x.ts`, `src/intake/x-transport.ts`, with regression coverage in
  `npm run test:x`).
- The relay forwards the four read-only X lookups, plus one fixed POST that
  renews the owner's own token pair.
- Wired: host sign-in (the paired computer runs X's PKCE flow and keeps the
  token; the phone never asks for token JSON), the bind/check UI, automatic
  token renewal, and the two private surfaces (a "needs you" list and
  "Import X link").
- Missing evidence: a test against your real X account (the §27 gate). That is
  the one item that needs your credentials and cannot be done from a test.

## 1. What you need to provide

**Your own X developer app, its OAuth client id, and one X OAuth 2.0 user
access token for your own account, plus the refresh token X issued with
it.** Spriite ships no X app of its own and reads your own posts; it never
acts as you. Sign-in on the paired computer obtains the pair (with
`offline.access`, so it can be renewed); the computer stores both tokens.

| Item | Value |
|---|---|
| Token type | OAuth 2.0 **user-context** access token (not an app-only bearer token) |
| Required scopes | `tweet.read`, `users.read`, `offline.access` (`offline.access` is what makes renewal possible) |
| Used as | `Authorization: Bearer <token>` on four GET lookups |
| Renewal | one `POST /2/oauth2/token` (form-encoded, public PKCE client, no secret) when a refresh token is stored |
| Where it lives | Stored on the phone only, in the key vault (`src/voice/keys.ts`). Never on the glasses or in logs. The relay forwards the bearer header to X but must not persist or log it. |

An app-only bearer token will fail at bind time: `/2/users/me` proves the token
belongs to *you*, and that is what makes the numeric owner id "verified"
(`XIntake.bind`, `src/intake/x.ts`). A handle is only a label; only numeric ids
authorize.

You also need the **Spriite account handle** (the X account people mention to
start work). You can point it at your own account if that is how you want to
address it, but it must be a different account than your personal one — binding
refuses `same_account`.

**If your X account is protected:** X does not deliver protected-account posts
to this kind of intake. Binding still succeeds, but intake stays disabled and
the setup screen says so (`protected_unsupported`). That is a documented
capability gate, not a bug.

### Register your own X app (bring your own)

Spriite names no one's app by default: every owner registers their own in the
[X developer portal](https://developer.x.com/) and saves its client id in
Settings › Connections › X (`src/state/prefs.ts`, the `X app client id` field). Registration values
are yours, so this table records only what to configure:

| Item | What to register / paste |
|---|---|
| Project | Any project; Pay Per Use covers the low read volume Spriite needs. Watch the credit balance — `$0.00` answers `402 credits depleted`, which the transport and setup UI report as a specific quota error. |
| App name | Yours; X shows it to you only |
| Permissions / client type | **Read** / **Native App** (a public PKCE client, no secret) |
| OAuth client id (public) | Copy it into **Settings › Connections › X → X app client id** (or `SPRIITE_X_CLIENT_ID` on the computer). Renewal names your app and no other: with no client id saved, the renewal path fails closed with the honest missing-config error. |
| Callback URL | `http://127.0.0.1:8765/callback` (X requires one; Spriite never opens it) |
| Website | Any page you control; your repository URL works |
| Scopes | `tweet.read users.read offline.access` (`offline.access` is what makes renewal possible) |
| Access-token lifetime | X's default (2 hours) is fine; renewal handles expiry |

No numeric id is ever typed: **Save and verify** proves yours live with
`/2/users/me`, and that check is what makes the owner id "verified"
(`XIntake.bind`, `src/intake/x.ts`). The Spriite account id is resolved the
same way, by handle, at bind time. Neither a console account id nor any
pasted number is runtime authorization evidence.

**Credential handling:** keep the token JSON X issues somewhere safe outside
the repository — never in source, docs, environment files, or build assets.
`.gitignore` excludes `Spriite-X-Token*.json` as a guard, not as a substitute
for safe storage. The phone no longer takes a pasted token: sign in on the
paired computer instead. Because the pair carries the refresh token, Spriite
can renew it even if its access token has already expired, provided your app's
client id is saved.

**Renewal is implemented, and it is narrow.** When a refresh token is stored,
Spriite renews the owner's own token pair itself: one form-encoded `POST` to
the single fixed endpoint `/2/oauth2/token` through the same relay origin, no
client secret (a native PKCE client has none). The transport attempts this
exactly once, on a `401` from a read, and retries that read once with the new
access token. X **rotates** the refresh token on every renewal and kills the
old pair, so the rotated pair is written back to the key vault before the
retry uses it; an unpersisted rotation would brick the credential. The renewal
never changes the credential generation, so the verified binding stays
authorized. Without a refresh token (`Auto-refresh off`), renew credentials
outside Spriite and reconnect on the phone.

Two rules survive that exception and must keep holding:

- **No write to X content, ever.** The relay still forwards only the four
  reads; the one allowed `POST` has a fixed destination and a pass-through
  body. That is OAuth renewal, not a general write proxy — do not add a
  second non-GET route.
- **Never embed a refresh token in a build.** It belongs only in the phone's
  key vault.

## 2. What is already built (do not rebuild)

- **Read-only against posts, by construction.** The only request primitive
  for content is `get()` (`src/intake/x-transport.ts`). There is no code path
  that can post, reply, like, or repost, and no X write credential is
  accepted. The single non-GET call is OAuth renewal to one fixed endpoint
  (`refreshXToken`). `npm run test:x` greps the source to assert both.
- **The relay route.** `relay/worker.js` forwards four lookups, plus exactly
  one renewal endpoint; every other method on those paths is
  `405 read-only route`, and every other path is `404 not relayed`:

  | Route | X API call |
  |---|---|
  | `GET /x/2/users/me` | proves the token is yours |
  | `GET /x/2/users/by/username/:handle` | resolves the Spriite account id |
  | `GET /x/2/users/:id/tweets` | catch-up over your own posts |
  | `GET /x/2/tweets/:id` | revalidate / import one post |
  | `POST /x/2/oauth2/token` | renews the token pair (body passed through) |

  The renewal route is POST-only, and `POST` to any other `/x` path is still
  refused: `POST /x/2/tweets` is `404`, `POST /x/2/tweets/:id` is `405`. There
  is no general write proxy to extend.

  No `app.json` change is needed: installed builds reach X through the relay
  origin, which `npm run pack` already whitelists. Dev builds use the Vite
  proxy (`/api/x`).

- **Authorization rules** (`authorizeTrigger`): your numeric id **and** an
  explicit mention *entity* carrying the Spriite numeric id, inside the visible
  text range. A copied handle in a quoted post or a screenshot is context,
  never a trigger. Reposts are ignored.
- **Dedupe and edits.** Key `x:<owner-id>:<logical-post-id>`; edit-history ids
  collapse into one command. A delete does not cancel anything; an edit after
  dispatch is recorded as a proposed change, never a silent rewrite.
- **Catch-up and gaps.** Polling from a persisted checkpoint with a 10-minute
  overlap; posts beyond one check's reach are declared as a delivery gap, and
  `importLink()` is the manual fallback. Streaming is treated as a hint only:
  every streamed post is re-fetched before it is trusted.
- **Private receipts.** Holds, clarifications, and status answers are private:
  they belong on the phone and in return briefings. `X_LIMITATIONS`
  (`src/intake/x.ts`) is the honest copy to surface in setup.

## 3. Phone wiring and how to connect

The wiring is complete around the tested core; none of it relaxes the
authorization rules. **Only tweets authored by the API-verified owner's numeric
id with an explicit, visible Spriite mention entity can become requests.**
Other people's tags, quoted mentions, screenshot text, and reposts cannot
start work. Spriite never replies publicly on X.

1. On the phone, open **Settings › Advanced** and turn on the durable runtime
   (beta), then relaunch Spriite. Runtime authority is acquired only at boot.
2. Open **Settings › Connections › X**. Enter the X account handle people will
   mention (your Spriite account, separate from your personal one) and your
   X app's OAuth client id, then tap **Sign in on <computer>**. The sign-in
   runs on the paired computer (PKCE with a loopback redirect on
   `http://127.0.0.1:47823/x/callback`); the computer keeps the token pair and
   reads X itself. The phone never asks for token JSON.
3. A phone that already held a pair from an earlier version keeps it in
   `KeyVault.x` / `KeyVault.xRefresh`, plus an opaque credential-generation
   reference separately from mission state. **Save and verify** proves the
   owner with `/2/users/me`; failed verification or an interrupted token
   rotation cannot reuse an old binding. Renewal writes the rotated pair back in
   place under the same generation. Key writes are serialized; failed writes
   leave the previous saved values intact. **Read X on my Factory host** hands
   that pair over (or, after a host sign-in, sends only the reader settings).
4. Keep **X requests** off until the live checks below pass. Once enabled with
   durable runtime authority, automatic checks run roughly once a minute while
   the phone is foregrounded. Failed checks back off to five minutes. **Check now**
   is the explicit retry. No background-delivery promise is made.
5. **Needs you** lists holds and clarifications. Select a GitHub repository URL
   and **Recheck and confirm**, or **Dismiss**. Confirmation re-fetches the post
   and runs owner/mention validation again. X control requests still require the
   mission's own controls; confirmation does not execute them.
6. **Import X link** revalidates one post and uses the same owner-only pipeline.
   Private recent receipts and delivery gaps stay in this phone step, never on
   the glasses. Imports and confirmations require verified, enabled intake.
7. Turning **X requests** off applies live and prevents new submissions even
   during an in-flight read. **Disconnect X** clears the token pair and the
   binding.
   Neither action cancels a mission already created from an accepted request.

`src/intake/connection.ts` owns the serialized connection/check/import queue.
The app builds it only after successful durable runtime boot, using that
Supervisor's store and command pipeline. No token file is bundled or imported
automatically.

## 4. The live gate that needs your account (§27)

This is the evidence the spec requires before unattended intake is turned on.
It cannot be run from a test because it needs your real token and posts.

1. Deploy the relay (`relay/README.md`) and confirm the X routes:

   ```bash
   curl -i -X POST https://<your-relay>/x/2/users/me   # -> 405 read-only route
   curl -i https://<your-relay>/x/2/users/me           # -> 401 (no token), CORS header present
   curl -i -X POST https://<your-relay>/x/2/tweets     # -> 404, no write route
   curl -i -X GET  https://<your-relay>/x/2/oauth2/token  # -> 405, the renewal route is POST only
   ```

2. Sign in on the paired computer from the phone (Settings › Connections › X). Confirm:
   - the owner numeric id and the Spriite id are stored (`x_binding_changed`);
   - the panel shows **Auto-refresh on**, and after the 2-hour access-token
     lifetime elapses a check still succeeds — the pair rotated in the vault
     without a re-paste (relay access log shows one `POST /x/2/oauth2/token`);
   - a protected account lands on `protected_unsupported`, not a crash;
   - the health line says "never checked", never "no requests", before the
     first check.
3. Post a trigger from your own account that mentions the Spriite handle, then
   run one check. Confirm:
   - it becomes **one** mission (durable receipt before the checkpoint moves);
   - re-delivering the same post (or the stream hint) resolves to the same
     receipt — no second mission;
   - a request older than 24 hours is **held** for confirmation, not launched;
   - an edit after dispatch is a proposed change, not a rewrite.
4. Adversarial pass on the real account: a non-owner mention, a quote of your
   post with the handle in the quoted text, and a screenshot-style post with no
   mention entity must all be **refused and counted**, with nothing stored.
5. Confirm **no content write calls**: watch the relay access log (or add
   temporary request logging) and verify every X request is a `GET` to one of
   the four lookup paths, plus at most the one `POST /x/2/oauth2/token` for
   renewal. `npm run test:x` already proves the code path; this proves the live
   route.
6. Record the results in `docs/QUALIFICATION.md` (the §25.30/§25.31/§27 rows)
   and only then flip `x_owner_intake` on.

## 5. Known limitations to keep visible

Copied from `X_LIMITATIONS` — surface these in setup, do not bury them:

- Spriite reads your own recent posts on each check; live streaming is not
  qualified, so a request arrives on the next check.
- Posts beyond one check's reach are reported as a delivery gap; use Import X
  link for anything missed.
- Protected accounts are not supported.
- Links in a post are recorded, not opened.
- Spriite never posts, replies, likes, or reposts. Every answer stays private.

## 6. Files

| Path | Role |
|---|---|
| `src/intake/x.ts` | Binding, authorization, checkpoints, dedupe, receipts, health |
| `src/intake/x-transport.ts` | X API v2 client (the four GETs + one-renewal OAuth token POST) |
| `src/context/gather.ts` | Bounded request-context capture for a trigger |
| `relay/worker.js` | The read-only `/x` relay route |
| `scripts/test-x-intake.mjs` | Core and phone-wiring regression suite (`npm run test:x`) |
| `src/intake/connection.ts` | Credential-generation gate, serialized operations, foreground polling |
| `src/setup/x-panel.ts` | Spriite handle, X app client id, token paste, health, flag, private holds/receipts/gaps, manual import |
| `src/state/flags.ts` | `x_owner_intake` (off; requires `persistent_runtime_v2`) |
