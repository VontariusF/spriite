# Native Mission source implementation

> **Historical record (2026-10-12).** This documents a past run on the original developer's single macOS host and may name tools, paths or states that have since changed. For current setup see [NATIVE-BROKER-SETUP.md](NATIVE-BROKER-SETUP.md) and [SETUP.md](SETUP.md).

## Status

The companion/runtime/broker foundation is implemented for offline use.
**Real Factory-native launch is disabled and the provider path is not complete.**
The optional SDK boundary does not initialize sessions, recover authoritative
pending requests, or enforce effective High-autonomy policy and cost boundaries.
Those need implementation before separately authorized provider qualification.
A simulator pass cannot enable them.

Version remains **0.2.26**. No release, upload, installation, live Mission,
live answer/retry, repository publication, deployment, or Git publication was
performed. Existing tasks and worktree changes were retained.

## Implemented boundary

- Independent native actor and neutral projections, separate from the legacy
  coordinator and Cursor. No automatic conversion or execution of old records.
- Explicit per-job scope, destination, machine/workspace, High consent and
  separate consequence grants. References and “local only” are not destinations.
- Authenticated owner-scoped HTTP broker, fenced single-writer durable store,
  pre-invocation receipts, exact request ownership and no unknown-outcome replay.
- Exact root/child attention with full questionnaires, raw options, replacement
  request identity, external resolution and honest unsupported handoffs.
- Phone credential binding to the exact canonical broker URL. Saving another
  profile cannot send the old broker's credential to the new host.
- Target-bound typed/voice drafts, render-before-capture and settlement/exit
  invalidation. Display budgets do not truncate canonical owner restrictions.
- Native history/archive restore is observe-only. Credentials are excluded.
- State-driven return briefings, simultaneous attention, exact child links and
  replacement-request invalidation.
- Read-only finalization and conservative completion copy. Provider summaries,
  worker exits and transport acknowledgments are not verified delivery.
- Bounded stalled reads and readable projection limits. Overflow holds without
  discarding admitted request identities or silently clipping raw values.

The broker defaults to unavailable transport. Admission additionally requires
implemented transport support and a host-provisioned signed qualification
manifest. Neither a boolean flag nor a client-supplied document enables it.
See `broker/README.md` for the exact boundaries and service setup.

## Retained paths and issue disposition

The 36-item register remains in `MISSION-RELAY-AUDIT-2026-10-12.md`; its native
disposition is in `NATIVE-MISSION-INTEGRATION-MAP-2026-10-12.md`.
The mapping is **30 retain/fix, 4 native-retired, 2 verify**, not a claim that all
36 issues are independently qualified.

Retained changes cover supported native/tool completion dialects, bounded
complete history, final dispatch barriers, unknown acknowledgments, frozen
hosting identity, exact repository-creation recovery, full owner criteria,
independent GitHub repository/base/head/PR evidence and actual default-branch
discovery. Native retirement does not remove protection from retained callers.
Legacy provider verdicts still are not full structured criteria/evidence review.

**A02 remains unqualified:** actual root/child Execute/spec/proposal/start and
AskUser transport, durable recovery and policy containment.
**A06 remains an honest Cursor handoff:** no invented blocked-answer RPC.
Revisioned native follow-ups, edited proposals, custom-answer semantics,
whole-Mission controls, repository initialization and verified native artifacts
also remain unavailable or incomplete.

## Oversight and validation

Four implementation tracks and independent broker, runtime, phone/input and
retained-path reviews were used. Main integration validates findings before
repair. Offline tests do not install or execute the optional Factory SDK.
The root TypeScript check covers the app, not a build against an installed SDK
and its optional Node dependencies. The SDK shim remains a static contract
boundary, not a qualified provider implementation.

Final integrated qualification passed **26/26 suites, 3,866 labeled checks,
zero failures**. Counts include grouped cases/journeys, not an instrumented
total of every underlying assertion. The dated suite report is
`NATIVE-MISSION-QUALIFICATION-2026-10-12.md`; its UTC timestamp falls on October
13 while this report uses the October 12 local work date.

The native suites include **41 broker checks, 36 runtime journeys, 106 UI/intent
checks, 52 retained regression groups and 37 ownership checks**. All four final
retained-review findings were repaired and checked through actual callers:

- Failed prerequisite reads preserve exact known-unsent FIFO turns and tokens.
- Follow-ups share coordinator serialization and cannot overwrite an unknown
  receipt with a later acknowledged turn.
- Durable `requiresFreshApproval` revokes source approval after base/scope
  changes. Refresh and restart do not reapply `startApproved`.
- Durable `initialPlanTurn` distinguishes unsent, unknown and accepted initial
  requests. Ambiguous old planning faults migrate to read-only unknown holds,
  never Retry permission.

The delivery test's intermittent blank-versus-idle observation comparison was
normalized only for those equivalent read-only states. All authority fields and
other run statuses remain compared. Three repeats passed; deliberately removing
the persistence barrier still failed as expected. Earlier suite and simulator
failures were repaired before the final results reported here.

The fresh simulator walkthrough passed **9/9 checks**. Five distinct glasses
views and four phone views were visually reviewed, including both questionnaire
questions, all single/multi-select choices, the send control, exact owning
session links and conservative terminal copy. Eight screenshot pairs and
`evidence.json` are in `.screenshots/native-mission/`. The final console had
one app-ready signal, one runtime boot and no uncaught exceptions, unhandled
rejections, failed fetches or bridge timeouts.

The simulator walkthrough is explicitly an offline fixture. It checks separate
proposal/start requests, simultaneous root permission and child questionnaire,
full raw choices, no invented progress and incomplete-artifact terminal copy.
Capture waits for a subsequent authoritative fixture read because screenshot
work can delay simulator bridge callbacks. Old control files are not replayed
across fixture processes.

App TypeScript, copy budgets, whitespace and production build checks passed.
Production assets contained no native fixture/probe markers. The build still
warns about a chunk over 500 kB (791.35 kB, gzip 226.05 kB).
The optional SDK dependency/build, actual provider execution and real hardware
were not exercised.
The demo, legacy-offline and legacy-runtime simulator walkthroughs were not
rerun in this qualification; the native walkthrough ran separately from the
suite harness. Owned simulator and isolated Vite processes were stopped.

## Remaining enablement gates

1. Implement version-compatible SDK initialization and physical checkout/base
   discovery, with immutable workspace/approval binding.
2. Implement authoritative observation, root/child request recovery and exact
   response/outcome correlation without buffered replay or implicit self-resume.
3. Establish enforceable High tool/consequence policy, model/validator settings
   and actual budget boundaries, not prompt-only restrictions.
4. Implement and qualify each supported control and native artifact verification
   independently; unsupported controls keep their explicit handoff.
5. Separately authorize an isolated scratch provider canary and real-device
   lifecycle/dictation/storage/display qualification.
6. Request separate authorization for any release, upload, installation,
   remote deployment or Git publication.
