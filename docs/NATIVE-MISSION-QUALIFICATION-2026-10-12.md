# Spriite qualification run — 2026-10-13T02:14:49Z

> **Historical record (2026-10-12).** This documents a past run on the original developer's single macOS host and may name tools, paths or states that have since changed. For current setup see [NATIVE-BROKER-SETUP.md](NATIVE-BROKER-SETUP.md) and [SETUP.md](SETUP.md).

- Revision: `a8cf7c4` on `main` (working tree dirty)
- Host: darwin 25.6.0 arm64, node v22.23.1
- Versions: spriite 0.2.26, Even Hub SDK ^0.0.16, simulator ^0.9.5
- Totals: 3866 labeled checks passed, 0 failed, 0 suite/walkthrough failures
- Counts are passing labels (including grouped broker cases and runtime journeys), not an instrumented count of every underlying assertion.

## Suites

| Suite | Covers | Labeled checks | Failures | Result |
|---|---|---|---|---|
| `test:store` | MissionStore, journal, v1 migration | 181 | 0 | pass |
| `test:runtime` | Supervisor, actors, scheduler, outbox, crash matrix | 585 | 0 | pass |
| `test:briefing` | Briefings, coverage ledger, phone inbox, honesty | 186 | 0 | pass |
| `test:sprite` | Poses, resolver, static mode, coalesced renderer | 183 | 0 | pass |
| `test:x` | Owner X intake, transport, context, receipts | 554 | 0 | pass |
| `test:real` | Real orchestrator, home rows, gates, faults | 592 | 0 | pass |
| `test:app-engine` | App adapter over the durable runtime + launch plan | 732 | 0 | pass |
| `test:settings` | Saved session settings, freezing, API bodies, and phone controls | 82 | 0 | pass |
| `test:voice-turn` | Capture ownership, focus changes, settlement, and stale callbacks | 232 | 0 | pass |
| `test:history` | Saved build/activity history, storage outages, acknowledgments, and concurrency | 65 | 0 | pass |
| `test:followups` | Durable X follow-ups: crash boundaries, FIFO, ambiguity, and owner resolution | 29 | 0 | pass |
| `test:dev-fake` | Actual dev-provider protocols, failure recovery, branches, and walkthrough reload detection | 9 | 0 | pass |
| `test:factory-adapter` | Real Factory HTTP adapter: protocol framing and delivery acknowledgment | 19 | 0 | pass |
| `test:execution-boundary` | Production client dispatch, worker questions, upgrade recovery, and evidence-only progress | 58 | 0 | pass |
| `test:team-real` | Fresh owner scope, approval races, and uncertain decision/worker delivery | 12 | 0 | pass |
| `test:team-ui` | Unsent voice recovery, local scope feedback, and connected Factory handoff focus | 6 | 0 | pass |
| `test:team-cancellation` | Late worker launch cancellation and capacity retention | 38 | 0 | pass |
| `test:team-delivery-runtime` | Acknowledged managed receipt state before decision and execution messages | 4 | 0 | pass |
| `test:team-watch-store` | Independent watch receipts, reload recovery, persistence races, and corruption holds | 16 | 0 | pass |
| `test:response-reading` | Full response text, pixel-bounded pagination, Unicode, and latest-reply reading | 4 | 0 | pass |
| `test:native-broker` | Durable native broker, authority, exact attention ownership and recovery | 41 | 0 | pass |
| `test:native-runtime` | Independent native actor, neutral projections, binding and restore | 36 | 0 | pass |
| `test:native-ui` | Native phone consent/question flows and lossless owner intent | 106 | 0 | pass |
| `test:native-retained` | Retained execution authority, provider observation and delivery repairs | 52 | 0 | pass |
| `test:native-ownership` | Target-bound capture, rendered focus and literal voice drafts | 37 | 0 | pass |
| `test:live-x-probe` | Offline safety checks for the opt-in read-only live X probe | 7 | 0 | pass |

## Simulator walkthroughs

| Walkthrough | Scope | Labeled checks | Failures | Result |
|---|---|---|---|---|
| — | walkthroughs were not requested (run with `--sim`) | — | — | not run |

## Spec §24 failure behavior — coverage

| Failure | Evidence | Verified |
|---|---|---|
| Storage write fails | `store`, `briefing` | yes ('never success') |
| Crash after command commit | `runtime`, `x` | yes ('resumes at boot') |
| Crash during launch | `runtime` | yes ('recorded unknown') |
| Duplicate X event | `x`, `runtime` | yes ('three deliveries, one mission') |
| Missed stream interval | `x`, `briefing` | yes ('declared as a delivery gap') |
| Non-owner trigger | `x` | yes ('the non-owner trigger is counted') |
| Missing context | `x` | yes ('asks privately') |
| Ambiguous repository | `x`, `real` | yes ('no repository guess') |
| Expired provider credential | `runtime`, `real`, `x` | yes ('kind "auth" is recorded rejected') |
| Rate limit | `runtime`, `real`, `x` | yes ('rate limit') |
| Malformed review | `real`, `runtime` | yes ('failed verdict') |
| Commit changes after review | `store`, `real`, `runtime` | no matching assertion |
| Pause during dispatch | `runtime` | yes ('queued mission pauses') |
| Cancel unsupported or unconfirmed | `runtime`, `sprite` | yes ('never claims all work stopped') |
| Restart with changed defaults | `runtime` | yes ('changed global preferences') |
| Two runtimes attempt ownership | `runtime`, `app-engine` | yes ('each boot takes a new runtime epoch') |
| Glasses disappear mid-briefing | `briefing`, `sprite` | yes ('coalesce onto the same pending briefing') |
| New event during briefing | `briefing` | yes ('later events stay unseen') |
| Animation send is slow | `sprite` | yes ('held back, not queued') |
| Relay success but display not seen | `briefing` | yes ('separately from acknowledgement') |
| Unrelated account sessions | `real`, `x` | yes ('cloud home lists the session') |
| Retention limit reached | `store` | yes ('the ceiling bounds the held window') |

## Spec §25.1-26 acceptance tests — coverage

| Item | Suites | Result |
|---|---|---|
| §25.1 distinct mission IDs, duplicate events resolve to one command | `runtime`, `store` | pass ('distinct mission IDs') |
| §25.2 more than eight active missions survive save/reload without eviction | `store` | pass ('12 missions survive save/reload') |
| §25.3 crash boundaries around receipt, dispatch, result, cursor | `runtime` | pass ('previous epoch recovers as') |
| §25.4 provider cursors never advance past durably applied work | `x`, `store` | pass ('checkpoint did not advance past the unsaved request') |
| §25.5 paused missions stay paused after restart | `runtime`, `store` | pass ('paused mission stays paused after reload') |
| §25.6 changed preferences still restore an existing mission | `runtime` | pass ('changed global preferences') |
| §25.7 view choice changes no scheduling eligibility | `runtime` | pass ('without being selected') |
| §25.8 fair capacity scheduling | `runtime` | pass ('arrival order (FIFO)') |
| §25.9 stale plan revision rejected | `runtime` | pass ('stale decision revision cannot approve') |
| §25.10 narrower policy blocks now-disallowed actions for old missions | `runtime` | pass ('narrowed policy prevents the launch') |
| §25.11-18 owner X mention, spoof resistance, dedupe, deletes, catch-up, decisions, redirects | `x` | pass ('three deliveries, one mission') |
| §25.19-23 return briefing, coverage, disconnect eligibility, freshness honesty | `briefing` | pass ('collapses to ONE card') |
| §25.24-26 poses and static equivalents, coalescing, reduced motion | `sprite` | pass ('seventeen') |
| §26 rollback retains records and resumes nothing | `app-engine`, `store` | pass ('legacy engine never resumes them') |

## Hardware gates (§25.27-32, §27) — not qualified

These require a real phone and glasses. They are listed so a green suite run is never read as device qualification (spec §25).

| Gate | Method |
|---|---|
| §25.27 8-hour locked/backgrounded run, glasses disconnected | Safe test mission on each supported OS; record runtime behavior, battery, reconnect timing, missed intake |
| §25.28 force-quit and reboot during a worker run | On device: kill the app mid-build, restart, verify one run reconciled with no duplicate dispatch |
| §25.29 airplane mode / relay / provider outage | On device: toggle each, verify scoped recovery and truthful freshness labels |
| §25.30 owner X build while glasses are absent | On device with a live owner X account; verify private return briefing |
| §25.31 zero X write calls | Unit-tested (test:x); confirm again against a live account with request logging |
| §25.32 display fit, contrast, gestures, image delivery, acknowledgement | Real G2 hardware: readable green contrast, gesture access, serial image delivery |
| §27 SDK storage commit truth | Write a large envelope, force-quit mid-cycle, restart, verify the newest valid envelope is adopted |
| §27 one-runtime lifecycle ownership | Drive the host protocol (headless re-entry, double __restoreState) and assert a single writer |
| §27 continuous operation on the mobile matrix | Long-running device soak with intake enabled |
| §27 X entitlement and reconnect coverage | Live owner X account: bind with the token JSON, let the 2-hour access token expire, verify a check renews and persists the rotated pair, then check reconnect and entitlement limits |
| §27 secure credential storage | Device review of where provider keys live and how they are cleared |
| §27 provider unknown-launch resolution | Force a launch whose answer never arrives on device; verify the unresolved dispatch path |
| §27 cancellation semantics per provider | On device: cancel a Factory and a Cursor run; verify what the card claims |
| §27 streamed transport behavior | On device: measure HUD image delivery on the BLE link under load |

## Rollback (§26)

- `planBoot` matrix (flag on/off x boot ok/failed x durable records x fresh) passes in `test:app-engine`.
- Flag off with durable records: the legacy engine resumes nothing and hides the migrated vault.
- The runtime never writes the legacy `sprite.factory.v1` snapshot while it holds authority, and the v1 migration skips a record whose lead session the durable state already owns (`test:store`).

## Open gaps and carried risks

- Factory-native execution is opt-in and disabled. SDK session initialization, authoritative observation/recovery and effective High policy/budget enforcement remain unimplemented in the optional adapter. These require provider implementation followed by a separately authorized canary; offline qualification cannot enable native execution.
- Successful live X qualification is outstanding: the restricted direct-API probe failed authentication; owner binding, entitlement, post visibility, and deployed relay parity remain unverified (see FEATURE-CHECK-PLAN.md).
- One authorized live refresh was rejected by X; successful renewal, rotation, revocation, and offline.access behavior still need the §27 live pass.
- Client/server clock skew between phone and relay is not exercised.
- Phase 4 hardware display test (all seventeen poses on real glasses) is outstanding.
- The desktop simulator keeps no storage across process launches, so cross-launch durability is covered by an in-process reload of the runtime walkthrough plus the store crash matrix; on-device restart behavior stays a §27 gate.
- App-UI wiring is exercised by app-engine tests; unit and simulator evidence does not qualify live X, device lifecycle, or physical display behavior.
- Unattended X intake stays disabled until the §27 gates pass.
- Full spec §15 structured criteria/evidence review validation remains unimplemented. The retained path now independently checks repository/base/head identity and invalidates moved-base approvals, but these guards do not make a provider VERDICT an independently verified structured review.
- A save on the phone now reaches every live mission actor (credentials, computer id, and an unassigned repository), but the runtime-actor configure path is only unit-tested, not exercised on device.

## Verdict

Automated qualification passes: 3866 labeled checks, no failures. Device qualification (§25.27-32) has not been run and unattended X intake stays disabled.
- 1 §24/§25 row(s) found no matching assertion in their named suites; treat those responses as unverified.
