# Spriite — VPS Archive Mirror Specification

Version 0.1 (draft for build kickoff) · 8 October 2026 · Owner: the repository owner

Status: implementation proposal grounded in the current repository (`main` at `6ba4a4b`). Nothing below is claimed to exist yet. This document amends [`PERSISTENT-COMPANION-SPEC.md`](PERSISTENT-COMPANION-SPEC.md) §2 ("canonical entity and mission records stay on the chosen personal host"): the owner's VPS is named as the chosen archive host. The phone remains the execution host and the source of truth.

## 1. Product contract

Sessions, their history, and tags (X mention receipts) are recorded on the phone first, as they are today. A mirror on the owner's VPS keeps a durable copy that no lost, reset, or replaced phone can take away. When a fresh phone arrives, the owner can restore the archive and every session's record — title, status, chat history, feed, and tags — comes back.

The archive never runs the mission system. It holds records; it does not dispatch work, hold credentials, or serve the live HUD. If the VPS is unreachable, nothing on the phone or glasses changes behavior except a pending-sync indicator.

Example:

1. A mission finishes on the phone; its chat tail and final status are already durable there (`src/runtime/supervisor.ts` engine snapshots, `src/state/feed.ts`).
2. Within the sync cadence, the phone upserts that mission's record to the VPS archive.
3. The phone is lost. A new phone installs Spriite, the owner enters the device key in Setup, and chooses Restore from archive.
4. Every session returns with its history, finished ones included; the Activity feed and tag receipts return; the X binding does not (its token is a credential, §5).

## 2. Requirements and boundaries

### Required

- One-way mirror: the phone is the single writer; the archive accepts upserts and answers restore requests, nothing else.
- Idempotent upserts keyed by mission id and monotonic `updated_at`; replays and re-sends are harmless.
- The mission system never blocks on the archive: sync runs after the durable phone write, off the critical path.
- Offline-safe: failed syncs queue on the phone in a bounded outbox and retry with backoff; the UI shows pending/failed state honestly.
- Restore is explicit and owner-initiated; it rebuilds phone records from the archive without inventing events (the same §22 honesty rule: no manufactured "while away" accounts).
- Device authentication: one key per phone, generated on the phone, stored only in the phone vault, entered once in Setup.
- Parameterized SQL only; body size caps; rate limits; no CORS beyond the packed app origin; the relay stays read-only for everything except the two archive routes (§6).
- Secrets never leave the phone: no X tokens, Factory or Cursor keys, GitHub tokens, or the device key's relay-side value in any payload or log.
- The caps that exist for phone storage (`FEED_KEEP` 30, builds 9 rows / 8 runtime missions, engine chat tail 40) stay on the phone; the archive holds unbounded history and serves restore pages.

### Outside this release

- The VPS as an execution host, scheduler, or provider of live reads to the HUD or mission engine.
- Multi-user or shared access; one owner, one or more of the owner's phones.
- Moving X intake, credentials, or provider keys onto the VPS.
- Public or third-party storage (no hosted DBs; the VPS is the owner's own machine).
- Automatic restore (restore is always a deliberate owner action).

## 3. What exists and what must change

Grounded against `main` at `6ba4a4b`.

| Area | Current implementation | Required change |
|---|---|---|
| Phone durability | Vaults `spriite.prefs.v1` / `spriite.keys.v1` / `spriite.feed.v1` via the SDK storage bridge (`src/state/prefs.ts`, `src/voice/keys.ts`, `src/state/feed.ts`); per-mission engine snapshots incl. a 40-entry chat tail (`src/factory/real.ts`, restored via `engineSnapshotFor` in `src/runtime/supervisor.ts` and `chatLogFor` in `src/runtime/app-engine.ts`) | A snapshot assembler that flattens vaults + mission store + receipts into the sync payload; unchanged write paths |
| Archive store | None | SQLite on the VPS (primary, §4) with the schema in §7; Postgres container variant optional, identical schema |
| Transport | The relay (`relay/worker.js`, `relay/node.mjs`) forwards four X read lookups plus exactly one OAuth POST route; everything else 405s | Two authenticated archive routes: `POST /spriite/sync` (upsert batch) and `POST /spriite/archive` (restore page request); no other route or method added |
| Phone UI | Setup checklist and optional steps pattern (`src/setup/panel.ts`), Now tab badges, persistent feed | An Archive step (optional) with device key, pending/failed sync state, and Restore from archive with its own confirmation |
| Flags | `src/state/flags.ts` pattern (default off, prerequisite chain, next-launch effect) | `archive_mirror`, default off, no prerequisite, hot-applied like `x_owner_intake`'s toggle |
| Docs | PERSISTENT-COMPANION-SPEC §2 names the personal host | Amendment naming the VPS as the archive host (this document, §1) |

## 4. Storage: SQLite on the VPS

SQLite is the primary choice: single writer (one relay route), low write volume (mission events), zero daemon, and backup is a file copy that folds into the VPS's existing backup practice. WAL mode; nightly `VACUUM INTO` or filesystem-level backup; no watchdog needed (nothing runs between requests).

The Postgres variant (a dedicated small container beside whatever databases you already run on that machine, never sharing them) is allowed with the identical schema (§7) for owners who want SQL-level query access; the build defaults to SQLite.

The database file and its backups are owner-only on the VPS filesystem. The relay process is the only local client.

## 5. Credentials and threat model

- The phone generates a device key (random, ≥ 32 bytes, base64url) shown once in Setup with a copy affordance; it lives in the phone vault (`spriite.keys.v1` slot alongside the existing pattern) and is sent as `Authorization: Bearer` on archive routes only.
- The relay holds the expected key hash in its environment (`SPRIITE_ARCHIVE_KEY_HASH`); it never stores the key itself, and rejects unknown bearers with 401 and a rate limit. The rate window persists in the archive's own database, keyed by that hash (§7 `meta`), so a relay restart cannot reset the count; a window the relay cannot read fails closed with 503, never letting a request through uncounted.
- Archive payloads carry mission content only: titles, goals, statuses, chat text, feed entries, X receipt metadata. They never carry provider credentials or X tokens (those are separate vault fields and are excluded at the assembler, not by filtering downstream).
- The two archive routes are the only non-read routes on the relay beyond the existing single OAuth token route; the method/path matrix stays 405/404 for everything else, exactly as `relay/worker.js` enforces today, and the existing source-grep test that counts write routes is extended to expect exactly three.
- The relay logs status and path only, never headers or bodies, matching the OAuth route's rule.

## 6. Sync protocol

- Trigger: after a durable phone write (mission event, chat entry, feed append, receipt change), debounced to one batch every 30 seconds, plus on app background and Setup's "Sync now".
- Payload: changed records since the last acknowledged batch cursor (mission id + `updated_at`), plus a bounded outbox (200 entries) for retries; each record is a full row upsert (idempotent).
- Response: acknowledged cursor; the phone stores it in the vault. Failures keep the outbox and retry with backoff (5 min, doubling, cap 1 h); the Archive step shows pending/failed counts honestly.
- Restore: `POST /spriite/archive` with a page cursor returns records newest-first (missions, chat, feed, receipts, vault-except-secrets); the phone rebuilds them through the existing restore paths (`engineSnapshotFor`-shaped validation, entry-by-entry, same as the engine's snapshot guards). Restore overwrites nothing newer on the phone: records merge by `updated_at`, last-write-wins, and the owner confirms before the first merge.

## 7. Schema (SQLite primary; identical names for Postgres)

```sql
CREATE TABLE missions (
  mission_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,           -- terminal phase word or live word
  repo TEXT,
  origin TEXT NOT NULL,          -- 'phone' | 'x'
  created_at INTEGER NOT NULL,   -- ms epoch
  updated_at INTEGER NOT NULL
);
CREATE TABLE chat (
  mission_id TEXT NOT NULL REFERENCES missions(mission_id),
  seq INTEGER NOT NULL,          -- per-mission monotonic
  who TEXT NOT NULL,             -- 'you' | 'spriite'
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (mission_id, seq)
);
CREATE TABLE feed (
  at INTEGER NOT NULL,
  label TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (at, label, text)  -- same dedupe rule as the phone feed
);
CREATE TABLE tags (              -- X mention receipts
  dedupe_key TEXT PRIMARY KEY,
  logical_post_id TEXT NOT NULL, -- the post's stable id (first of its edit history)
  revision_id TEXT NOT NULL,     -- the newest revision this receipt was evaluated against
  via TEXT NOT NULL,             -- 'catch_up' | 'stream' | 'import': how it arrived
  status TEXT NOT NULL,          -- the receipt's status word (X_RECEIPT_STATUSES)
  instruction TEXT,
  repository TEXT,
  mission_id TEXT,
  received_at INTEGER NOT NULL,
  deleted_at INTEGER,           -- when the post was deleted on X; NULL while it is live
  proposed_revision_id TEXT     -- an edit observed after dispatch; recorded, never applied
);
CREATE TABLE snapshots (         -- opaque engine state, restore-only
  mission_id TEXT PRIMARY KEY REFERENCES missions(mission_id),
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE meta (              -- the relay's own bookkeeping, never phone records
  bucket TEXT PRIMARY KEY,       -- the configured key hash: one rate window per relay
  window_start INTEGER NOT NULL, -- ms epoch, when the current window opened
  hits INTEGER NOT NULL          -- archive requests counted inside the window
);
-- one index per restore page order (§6), so keyset paging never table-scans;
-- feed needs none of its own: its primary key already is its page ordering
CREATE INDEX missions_page ON missions (updated_at, mission_id);
CREATE INDEX chat_page ON chat (at, mission_id, seq);
CREATE INDEX tags_page ON tags (received_at, dedupe_key);
CREATE INDEX snapshots_page ON snapshots (updated_at, mission_id);
```

Unbounded on the VPS side; the phone keeps its caps (§2). Chat rows carry the full durable tail the phone kept (today 40 entries per mission at write time); earlier entries are simply whatever the phone recorded.

The tags table carries what a receipt IS: its dedupe key, the post's own logical and revision ids, the arrival path, the status word, the instruction, and where it went — plus the two facts a post's later life adds, `deleted_at` and `proposed_revision_id`, both nullable so a row written before those columns existed still restores as a live post. Restore rebuilds receipts from exactly those columns, so the ids and the arrival path come back as the phone recorded them — never placeholder values — and a deleted post restores deleted, an edit-after-dispatch restores with its proposed revision, never as facts the archive silently dropped. `meta` holds the relay's rate window: one row keyed by the configured key hash (the hash the relay already holds in its environment, never the key), read and written in one transaction per archive request, so a relay restart cannot reset the count and two processes over one file cannot race it. A window the relay cannot read fails closed with 503 rather than let a request through uncounted.

A deployed archive file gains the two late columns by guarded migration at relay startup (`relay/archive.mjs` `ensureTagColumns`): each is checked against `PRAGMA table_info(tags)` and added with `ALTER TABLE` only when missing, so a fresh file gets them from the schema and a live file migrates exactly once, in place, with no data rewritten.

## 8. Qualification gate (before the flag ships on)

1. Unit: payload assembly excludes every credential field; upsert idempotency; outbox retry/backoff; restore merge by `updated_at`; unknown-id restore returns empty, no crash.
2. Relay: method/path matrix — archive routes authenticated (401 without key, 429 over rate, 503 when the relay cannot read its own rate state: fail closed), everything else still 405/404; no headers or bodies in logs; write-route count exactly three in the source grep.
3. Round trip on the VPS: sync a finished and an active mission, wipe the phone storage, restore on a fresh mount, assert histories, feed, and tags return byte-identical and secrets do not exist in the archive file.
4. Offline: VPS unreachable → missions, HUD, and glasses unaffected; pending state visible; reconnect drains the outbox.
5. Live gate against the deployed relay, recorded in `docs/QUALIFICATION.md` like the X §27 gate.

## 9. Rollout

`archive_mirror` flag default off; Archive step appears in Setup when the flag is on; the sync job and routes deploy with the relay; the PERSISTENT-COMPANION-SPEC amendment ships with this document. The build order: relay routes + SQLite → phone assembler + outbox → Setup step + restore → tests → qualification.
