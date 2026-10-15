# Host-side X reader: plan (2026-10-14)

## Problem

X posts are read only while the Spriite app is open on the phone
(`src/intake/connection.ts` `tick()` requires foreground). A tagged post made while
Spriite is closed starts nothing. The native broker already runs as a per-user service on your Factory host
(always on with lingering under systemd on Linux; while you are logged in and the
machine is awake under a LaunchAgent on macOS), so it should read X and launch
Missions 2.0 itself.

## Constraints

- **One owner of the X credential.** X rotates the refresh token on every renewal
  and kills the old pair. Phone and Factory host cannot both renew. When the host reader is on,
  the phone hands its live pair to the broker once, then clears its own refresh token
  and stops polling X.
- **Same trust rules as the phone.** Only the owner's numeric X id. Only a real
  mention entity inside the visible text range (not reply auto-mentions). No reposts.
  The 24-hour window applies. X stays read-only: no writes, ever.
- **Destination rule.** Use the repository named in the post, else the repository
  designated for X, else a new private repository named from the post. Never the
  Spriite repository by implication.
- **Launch only through broker admission.** Holds stay holds: a held request is
  recorded with its reason, never retried in a loop. Trusted host only.
- **Durability.** The checkpoint advances only after a durable receipt. Dedupe is
  keyed by the logical post id (first edit-history id). A crash replays without
  launching twice.

## Components (new files unless noted)

| Module | Responsibility |
|---|---|
| `broker/x-rules.mjs` | Pure port of `src/intake/x.ts` rules: `authorizeTrigger(post, binding)`, `classifyIntent`, `repositoryFrom`, `destinationRepositoryFrom`, `newRepositoryNameFrom`, `derivedRepositoryName`, `logicalPostId`, `instructionOf(post, binding)` (visible text minus the Spriite mention). A parity test runs the same cases against the src versions. |
| `broker/x-credential.mjs` | 0600 credential file `{accessToken, refreshToken, expiresAt, clientId, ownerId}`. `current()`, `renew()`: one `POST https://api.x.com/2/oauth2/token` (refresh grant, public PKCE client id), with the rotated pair persisted atomically (write temp, fsync, rename) BEFORE it is used. A lost renewal response quarantines the refresh token (`rotation_lost`) instead of retrying blindly. Never logged. |
| `broker/x-client.mjs` | Read-only X v2 client over `fetch`, with a 30 s timeout, one renewal on 401 then retry once, and error kinds `auth \| forbidden \| quota \| credits \| not_found \| network \| service`. It calls only `GET /2/users/me`, `GET /2/users/:id/tweets` (since_id, max_results 100, expansions and fields as in `x-transport.ts`), and `GET /2/tweets/:id`. |
| `broker/x-reader.mjs` | Poll loop. Every 60 s, 5 min backoff on quota/credits, `wake()` for immediate reads. File ledger `x-reader.json` (0600) holding `{binding, checkpoint:{lastSeenPostId,lastSuccessAt}, receipts[] (bounded 512), rejectedCount}`. Per post: authorize → dedupe → classify → window → route → `launch(request)` → receipt `{dedupeKey, logicalPostId, revisionId, status: submitted\|held\|clarify\|ignored\|duplicate, reason, missionId?, repository?, at}`. The checkpoint advances only past durably receipted posts. Launch is injected. |
| `broker/x-launch.mjs` | Turns a routed request into a native intent from the host template (`{settings, acceptanceCriteria, restrictions}`) and delivery defaults, the same shape as `src/native/x-auto.ts`. It runs `broker.inspectAdmission` → requires `launchEligible && !holds.length` → `broker.prepare` with both consents (the owner's own verified post is the consent). Returns `{status:'submitted', missionId}` or `{status:'held', reason}`. Uses host-managed workspaces. |
| `broker/server.mjs`, `broker/broker.mjs` (edit) | Routes, bearer-authenticated: `GET /v1/native/jobs?ownerId=` (list job ids + states, so the phone can adopt host-launched missions), `POST /v1/native/x/handoff` (`{accessToken, refreshToken, clientId, spriiteHandle, defaultRepository?, template, delivery}` → verify via `/2/users/me`, persist credential and config, start the reader), `GET /v1/native/x/status` (health and the last 50 receipts, no secrets), `POST /v1/native/x/stop` (stop the reader, hand nothing back). `startFromEnv` starts the reader when `SPRIITE_NATIVE_X_READER=1` and a credential exists. |
| `src/` (edit) | Setup → X requests gets "Read X on my Factory host", which posts the handoff (live pair + saved X template + designated default repo) to the profile's broker. On success the phone clears its X refresh token and stops its own polling. Status shows host health and receipts. The runtime adopts host-launched jobs from `GET /v1/native/jobs` as native missions observed through the broker, so the phone and glasses show them. |

## Build order (factory)

1. Parallel: `x-rules` (+ parity test), `x-credential` + `x-client` (+ fake-fetch tests).
2. Parallel: `x-reader` (+ ledger and crash tests), `x-launch` + broker routes and wiring (+ HTTP tests).
3. Phone: handoff UI, polling deferral, job adoption (+ DOM/runtime tests).
4. Adversarial review: security (credential, auth), durability (crash/dedupe/rotation), end-to-end parity with phone intake. Then fixes.
5. Integration: full qualification, deploy, live read of the owner's account (read-only), release.

## Out of scope

Streaming/webhooks (polling only); writing to X; multi-owner.
