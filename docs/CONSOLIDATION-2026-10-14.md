# Consolidation and Missions 2.0 (droid 0.238): 2026-10-14

> **Historical record (2026-10-14).** This documents a past run on the original developer's single macOS host and may name tools, paths or states that have since changed. For current setup see [NATIVE-BROKER-SETUP.md](NATIVE-BROKER-SETUP.md) and [SETUP.md](SETUP.md).

Branch `consolidate/mission-v2`. What changed, why, and what is still owner-gated.

## Repositories

- The private development repositories were already ancestors of local `main`;
  the uncommitted local tree (native broker, Mission v2, held X intents) is now committed.
- The public repository is an older scrubbed release with unrelated history. Its three
  `spriite/mission_*/job-1` branches hold an unrelated "Plexo" downloader built by X-triggered
  missions inside the Spriite repository (the routing bug below). They were deleted on
  2026-10-14 after a local backup bundle was made.

## Factory changed Missions 2.0 (droid 0.238)

Observed live in two scratch-repository runs (`/tmp/spriite-canary/evidence/raw-mission-238*.jsonl`):
`interactionMode: "mission"` alone no longer enters a Mission; the session tag
`{ name: "mission-v2" }` at `initialize_session` does (the daemon fills in
`{ kind: "orchestrator", missionId }`). There is no plan approval, no checks, no snapshot
notification and no `~/.factory/missionsV2` record; workers are agents
(`SpawnAgent`/`SendMessage`/`ListAgents`) whose reports arrive as root user messages carrying
`sender: { kind: "agent", sessionId }`. The broker's new `v2-agents` dialect handles this
(see NATIVE-MISSION-V2-DESIGN.md); 0.227 behavior is unchanged.

## Owner decisions implemented

- **Trusted host** (`SPRIITE_NATIVE_TRUSTED_HOST=1`, broker/README.md): lifts the structural
  launch holds as accepted risks; policy, consent and delivery checks stay.
- **X auto-launch** (phone: Factory-native → X requests): a held X request the broker admits
  with no holds launches through the same preview → consent → promotion path as the phone's
  Approve button, once per request.
- **Destination rule**: an X build never lands in an existing repository it did not name.
  The X default is only a repository designated for X (Setup → X requests); otherwise the
  build gets a new repository named from the post (`derivedRepositoryName`).

## Fixes

| Area | Defect | Fix |
|---|---|---|
| X intake | Unnamed posts built in the app's selected repository (`keys.repoUrl`) | Designated `xDefaultRepository` only; else a new repository |
| Phone/Setup | Confirm buttons pre-filled the app repository, overriding the rule | Prefill from the post, choices or designated default only |
| Cloud path | Retrying a create whose answer was lost made `name-2` | Adopt the uncertain create via `findRepo`; dated fallback can't collide |
| Cloud path | Every 3 s poll re-read the whole conversation (up to 20 pages) | Incremental reads against a cached complete history |
| Cloud path | Queued lead posts retried every 400 ms during outages | Exponential backoff to 30 s on the timed path |
| Outbox | Any HTTP 4xx counted as "never created" (duplicate sessions on 408/409) | Only side-effect-free 4xx are definite rejections |
| Relay | Disallowed browser origins were forwarded and failed silently | 403 naming the origin; nothing forwarded |
| App | Tick loop kept rendering after teardown | Cleared on cleanup |
| Pack | The native broker origin was never whitelisted, so the phone could not reach it | `SPRIITE_NATIVE_BROKER` packed into the whitelist |
| Broker | v2-agents could never complete when the orchestrator didn't re-list agents | Attributed agent reports finish agents; agent-less orchestrators complete once settled |

Not changed on purpose: creation-time worker reservation (spec §25.8 arrival-order fairness),
native answer controls after an uncertain send (re-enabling risks a duplicate answer), and
native pause/cancel during broker gaps (needs a product decision).

## Owner steps (blocked for the agent by the permission classifier)

1. `scripts/install-native-broker.sh` on your Factory host (`deploy-native-broker.sh`
   now runs it): installs the per-user service (systemd --user on Linux, a
   LaunchAgent on macOS) with trusted host on, installs the SDK, writes 0600 key
   files and offers `tailscale serve` (tailnet only). See docs/NATIVE-BROKER-SETUP.md.
2. `npm run canary:native-v2-agents` — live end-to-end run through the production composition.
3. Pack with `SPRIITE_NATIVE_BROKER=<serve URL>`; in Setup enter the broker URL and token,
   save X settings, tick "Run my X requests automatically".

## Known gap

X is read only while the phone app is in the foreground (src/intake/connection.ts `tick`).
Missions start from tagged posts promptly only while Spriite is open; a host-side X reader
on the broker is the next step for unattended operation.

## Full-repository bug sweep

Sixteen read-only hunters covered every source file, one per subsystem slice. Each
finding went to two independent skeptics (correctness, and refute-by-reproduction), and a
completeness critic then looked across subsystems. 46 findings, 31 survived verification,
plus 1 from the critic. All 32 are fixed, each with a regression test, in eight new
`test:*-fixes` suites and the existing native suites. Highlights:

- Broker ledger: events (8192), attention (256) and history (512) were hard-capped and
  never pruned, which stopped the broker or a mission permanently. They are now bounded
  windows or retirement that keep every validator invariant.
- Reasoning-heavy native missions were fenced, because size bounds ran before encrypted
  reasoning blobs were stripped.
- Cloud orchestrator: `restore()`/`reset()` left lead polling stalled. A retried Cursor
  spawn duplicated the agent. A bad PR URL stuck the job. Failed verdicts stalled the
  review queue.
- Cursor client had no request timeout. Native missions leaked legacy scheduler capacity.
  Unauthenticated callers could exhaust the owner's archive rate window. The relay buffered
  unbounded bodies.
- UI: "Connected / Ready to build" was shown with no Droid Computer. Slow actions were
  falsely disabled. The chat reader opened on the oldest message. Clipped text could break
  emoji.

Qualification after the sweep: 4570 labeled checks, 0 failed.

## Live end-to-end (2026-10-14)

Through the installed broker over its tailnet-only HTTPS URL (the phone's route),
trusted host on, against a private scratch repository
(local commit only), three consecutive runs completed: admission (no holds) →
host clone → per-job droid 0.238 daemon → tagged Missions 2.0 session → agent spawned
→ feature completed → mission `completed`, a real commit, `npm test` 2/2.

Getting there fixed six live-only defects:
- droid 0.238's whole-process sandbox fails its own self-check on this macOS
  (`unix_socket_not_blocked`), so trusted-host jobs now run unsandboxed (owner decision).
- 0.238 hides every daemon method until the connection authenticates, so the adapter now
  authenticates once per connection, and the send guard admits only that exact handshake.
- In trusted mode the launch was recorded against a missing qualification hash.
- Launches were revoked because droid never echoes worker settings.
- Droid-internal `__…`-id messages fenced the job.
- The daemon was revoked before the closing summary could be read.

Still open: droid's read API exposes no authoritative list of open requests, so
observations stay `pending_request_reconciliation_required`. Missions run and complete,
but answering a mid-mission question from the phone stays held. Treating reads as
complete without that list would make open questions read as resolved, so it was not done.
