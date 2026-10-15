# Qualification

[Back to the README](../README.md) · [Spec](PERSISTENT-COMPANION-SPEC.md) · [Development](DEVELOPMENT.md)

What has actually been proven about the persistent companion, what has not,
and how to reproduce it. A green suite run is not device qualification
(spec §25), so the hardware gates are listed here in full and marked as open.

```bash
npm run qualify                       # every suite, ~10s
npm run qualify -- --sim              # + the simulator walkthroughs (start the sims first)
npm run qualify -- --sim --out /tmp/qualification-run.md   # keep the dated report
```

Start the simulators before `--sim`: `npm run sim` (:9898), `npm run sim:offline`
(:9899), `npm run sim:runtime` (:9903). The harness skips any walkthrough whose
port does not answer and says so. Attach a report to the release you ship;
regenerate it after the final commit so its revision matches.

`scripts/qualify.mjs` runs every suite and, with `--sim`, the three
walkthroughs; it prints a dated report with the environment, per-suite
results, the §24 and §25 coverage maps, the hardware gates, the rollback
evidence, and the open gaps. It fails when a suite or walkthrough fails. The
§24 and §25 rows are machine-checked against passing assertion labels only:
each names candidate keywords and reports "no matching assertion" when none
appear, so a row cannot report coverage it does not have. Rows that still come
back unverified are the honest gaps below.

## Automated evidence

Assertion counts are as of the latest dated `qualify` report; the harness is
authoritative and prints the live numbers.

| Suite | Covers | Assertions |
|---|---|---|
| `npm run test:store` | Durable commit layer, crash boundaries, single writer, event window, retention, v1 migration idempotence | 83 |
| `npm run test:runtime` | Command pipeline, independent missions, fair capacity, pause and cancel honesty, the dispatch crash matrix (auth/quota/offline/network), decisions, migration, epochs | 182 |
| `npm run test:briefing` | Return briefings, coverage ledger, cross-surface acknowledgement, freshness honesty, phone inbox | 186 |
| `npm run test:sprite` | Seventeen poses, static mode, pose resolver, coalescing animator, reduced motion | 65 |
| `npm run test:x` | Owner-only intake, binding gates, spoof matrix, dedupe and edits, 24-hour window, catch-up gaps, zero write calls; phone credential rotation, polling gates, imports, confirmations, disconnect | 167 |
| `npm run test:real` | Real orchestrator: plan, split, review, gates, faults, home rows, cloud watch, worker-session dedup | 144 |
| `npm run test:app-engine` | The app's engine surface over the durable Supervisor: durable command, focus, home list, relaunch, restore refusal, the phone flag switch, adapter honesty, and the launch/rollback matrix | 94 |

Simulator walkthroughs (all three drive the real UI through the automation API):

X phone wiring was also exercised in the browser on October 7, 2026, using
the real setup panel, key vault, connection controller and Supervisor with
in-memory storage, synthetic X responses and fake workers. Save/verify with
intake off, enable, import, private repository hold, confirmation, and live
disable passed. One mission was created; the token field was cleared, no token
appeared in rendered text, and every intercepted X call was a GET. This is
browser evidence, not a live X account or device qualification. The plain
desktop bridge did not support writes, so its failed-save UI was observed
before the in-memory fixture was used.

| Walkthrough | Scope |
|---|---|
| `npm run walk:real -- 9899 offline` (`sim:offline`) | Flags off: offline fault, retry, plan, build gate, pause/resume, review, PR gate, evidence, restart, home rows, cloud watch, goal list, mic failure path |
| `npm run walk:runtime` (`sim:runtime` on :9903) | `persistent_runtime_v2` on: the goal saves as a durable command, the mission actor owns every card, back-to-home while the mission keeps working off screen, reopening shows a card that moved on, Restart keeps the record, and the lobby's own paths still work |

## Spec §24 — failure behavior

Each row names the suite whose assertions cover the required response. The
keyword check in `scripts/qualify.mjs` matches only passing assertion labels, so
a row counts as verified only when a passing assertion names that area; read the
suite's own labels for the detail.

| Failure | Covered by |
|---|---|
| Storage write fails | `test:store` (commit reported not-ok, no trace left), `test:briefing` (an ack that failed storage is never success) |
| Crash after command commit | `test:runtime` (receipt committed before dispatch; recovery replays the same command once), `test:x` (redelivery recovers the same mission) |
| Crash during launch | `test:runtime` (unresolved dispatch blocks retry until the provider is inspected) |
| Duplicate X event | `test:x`, `test:runtime` (one receipt, one mission) |
| Missed stream interval | `test:x` (delivery gap recorded), `test:briefing` (gap card settles on its own ack) |
| Non-owner trigger | `test:x` (spoof, quote, screenshot, non-owner reply, injected instructions) |
| Missing context | `test:x` (essential context becomes a decision; no invented sources) |
| Ambiguous repository | `test:x`, `test:real` (held for product selection, never guessed) |
| Expired provider credential | `test:runtime`, `test:real`, `test:x` (block only the affected work) |
| Rate limit | `test:runtime` (a 429/quota refusal is a definite rejection: the queued intent is retained and the retry is allowed) |
| Malformed review | `test:real`, `test:runtime` (verdict rejected, submission stays pending review) |
| Commit changes after review | **not verified.** No suite asserts that a review whose base SHA changed is invalidated; the structured-review rule (spec §15) is not implemented. Listed in the open gaps. |
| Pause during dispatch | `test:runtime` (settle known/unknown launch, suppress what follows) |
| Cancel unsupported or unconfirmed | `test:runtime`, `test:sprite` (the card states the limit; never claims the run stopped) |
| Restart with changed defaults | `test:runtime` (frozen mission configuration restored, current preferences do not rewrite it) |
| Two runtimes attempt ownership | `test:runtime` (a second boot is refused), `test:app-engine` (a failed boot resumes nothing) |
| Glasses disappear mid-briefing | `test:briefing` (coverage stays eligible), `test:sprite` (disconnect pose and static equivalents) |
| New event during briefing | `test:briefing` (kept outside the fixed target, delivered next) |
| Animation send is slow | `test:sprite` (one frame in flight, newest pending wins, cancelled generations stop) |
| Relay success but display not seen | `test:briefing`, `test:store` (transport success is never read acknowledgement) |
| Unrelated account sessions | `test:real` (observed as watchable rows, never adopted or cancelled silently), `test:x` |
| Retention limit reached | `test:store` (compaction bounded, active missions never evicted) |

## Spec §25.1-26 — acceptance tests

| Item | Suite |
|---|---|
| §25.1 distinct mission IDs, duplicate events resolve to one command | `test:runtime`, `test:store` |
| §25.2 more than eight active missions survive save/reload without eviction | `test:store` (12 missions survive; the home row cap is a view limit, not a store limit) |
| §25.3 crash boundaries around receipt, dispatch, remote success, result commit, cursor update | `test:runtime` |
| §25.4 provider cursors never advance beyond durably applied observations | `test:x` (a checkpoint never advances past an unsaved request), `test:store` |
| §25.5 paused missions stay paused after restart | `test:runtime`, `test:store` |
| §25.6 changed preferences still restore an existing mission | `test:runtime` |
| §25.7 view choice changes no scheduling eligibility | `test:runtime`, `test:app-engine`, `walk:runtime` (mission progresses while another card owns the HUD) |
| §25.8 fair capacity scheduling | `test:runtime` |
| §25.9 stale plan revision rejected | `test:runtime` (a stale decision revision cannot approve a changed plan; the review-SHA half is an open gap) |
| §25.10 narrower policy blocks now-disallowed actions for old missions | `test:runtime` |
| §25.11-18 owner X mention, spoof resistance, dedupe, deletes, catch-up window, decisions, redirects, setup visibility | `test:x` |
| §25.19-23 return briefing without replay, disconnect eligibility, cross-surface ack, next-brief events, freshness honesty | `test:briefing` |
| §25.24-26 poses and static equivalents, priority states, transport coalescing, reduced motion | `test:sprite` |
| §26 rollback retains records and resumes nothing | `test:app-engine` (launch matrix), `test:store` (migration guard) |

## Hardware gates — open

These have not been run. They need a real phone and glasses, and they are the
reason unattended X intake stays disabled (`x_owner_intake` off by default).

| Gate | Method |
|---|---|
| §25.27 8-hour locked/backgrounded run with glasses disconnected | Safe test mission per OS; record runtime behavior, battery, reconnect timing, missed intake |
| §25.28 force-quit and reboot during a worker run | Kill mid-build, restart, verify one run reconciled with no duplicate dispatch |
| §25.29 airplane mode, relay and provider outages | Toggle each; verify scoped recovery and truthful freshness |
| §25.30 owner X build while glasses are absent | Live owner account; verify the private return briefing |
| §25.31 zero X write calls | Covered by `test:x` against the scripted transport; repeat with request logging on a live account |
| §25.32 display fit, green contrast, gestures, serial image delivery, explicit acknowledgement | Real G2 hardware |
| §27 storage commit truth | Large envelope, force-quit mid-cycle, restart, verify the newest valid envelope is adopted |
| §27 one-runtime lifecycle ownership | Drive the host protocol (headless re-entry, double `__restoreState`); assert a single writer |
| §27 continuous operation on the mobile matrix | Long soak with intake enabled |
| §27 X entitlement and reconnect coverage | Live account: bind, reconnect, entitlement limits |
| §27 secure credential storage | Device review of where provider keys live and how they are cleared |
| §27 provider unknown-launch resolution | Force a launch whose answer never arrives; verify the unresolved dispatch path |
| §27 cancellation semantics per provider | Cancel a Factory and a Cursor run; verify what the card claims |
| §27 streamed transport behavior | Measure HUD image delivery on the BLE link under load |

The desktop simulator keeps no storage across process launches, so
cross-launch durability is covered by an in-process reload of the runtime
walkthrough — the app reboots from its checkpoint with its missions, and the
runtime records line reports what it recovered — plus the store's crash
matrix. On-device restart behavior stays a §27 gate.

## Phase 6 wiring — what the flags gate

Flags resolve from stored phone preferences plus a dev-only `?flags=` override
(`?flags=persistent_runtime_v2,-return_briefings`). `persistent_runtime_v2`
defaults on (a stored "off" wins); the others default off (spec §26: intake requires the durable runtime, so `x_owner_intake` and
`return_briefings` cannot be enabled without it).

| Flag | State |
|---|---|
| `persistent_runtime_v2` | Wired. The app boots the durable runtime, the lobby turns a spoken or typed goal into a durable command, a mission actor owns the cards, the home lists runtime missions, and the legacy engine stops resuming anything once durable records exist. |
| `return_briefings` | Implemented and unit-tested (`test:briefing`), not wired to the app surfaces yet. |
| `sprite_states_v2` | Implemented and unit-tested (`test:sprite`), not wired past the existing renderer yet. |
| `x_owner_intake` | Wired to phone connection, private receipts/holds/gaps, manual import, and foreground polling through the durable Supervisor. Default off; unattended intake is not qualified until §27 passes. Connection instructions and the live test are in [X-INTAKE-HANDOFF.md](X-INTAKE-HANDOFF.md). |

## Rollback (§26)

- Flag off, or a failed runtime boot, keeps the app usable on the legacy
  engine while the durable records are retained: the launch plan in
  `src/runtime/boot-plan.ts` refuses to resume a saved legacy snapshot and
  hides the migrated vault, and `test:app-engine` covers the whole matrix.
- While the runtime holds authority it never writes the legacy
  `sprite.factory.v1` snapshot. That snapshot is the migration's input, so
  writing one would make the next boot import the runtime's own in-flight
  mission as a second record.
- The v1 migration skips any record whose lead session the durable state
  already owns, so a stale v1 snapshot (from any writer) can never split one
  provider session across two missions (`test:store`).

## Open gaps and carried risks

- **Spec §15 structured review validation is not implemented.** A review whose
  base SHA changed is not detected, so the §24 "commit changes after review"
  row is unverified and only the plan-revision half of §25.9 is covered.
- No live X credential test: intake runs against the scripted transport; the
  relay route is verified read-only for content (plus its one OAuth renewal
  POST) by unit tests.
- X token renewal is unit-tested against a rotating token endpoint, but no
  live refresh against X has run yet: rotation, revocation, and
  `offline.access` behavior still need the §27 live pass.
- Client/server clock skew between phone and relay is not exercised.
- The Phase 4 hardware display test (all seventeen poses on real glasses) is
  outstanding.
- The desktop simulator keeps no storage across process launches, so
  cross-launch durability is covered by an in-process reload of the runtime
  walkthrough plus the store crash matrix; on-device restart stays a §27 gate.
- Briefings and the sprite resolver are implemented and unit-tested but not
  wired to the app UI; their flags stay off.
- Unattended X intake stays disabled until the §27 gates pass.
- A phone save now reaches every live mission actor (credentials, computer id,
  and an unassigned repository), but the runtime-actor `configure` path is only
  unit-tested, not exercised on device.
- The relay-failure/outage response (airplane mode, provider outage) is a §27
  device gate; only the fault classification is unit-tested.
