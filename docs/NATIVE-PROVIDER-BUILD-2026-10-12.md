# Native provider implementation workstream

> **Historical record (2026-10-12).** This documents a past run on the original developer's single macOS host and may name tools, paths or states that have since changed. For current setup see [NATIVE-BROKER-SETUP.md](NATIVE-BROKER-SETUP.md) and [SETUP.md](SETUP.md).

## Authorization and baseline

The owner asked to continue with the same team, implementation, independent
review and qualification process. This work is source implementation and offline
testing. It does not authorize real Mission execution, canaries, answers/retries,
permission/autonomy changes, deployment, release/upload or Git publication.

Baseline: HEAD `a8cf7c4`, private 0.2.26, preserved dirty working tree.
The foundation passed 26 offline suites / 3,866 labeled checks and a separate
nine-check native fixture walkthrough. Those results do not qualify this new
provider work or the actual Factory SDK.

## Tracks and shared boundaries

1. **SDK lifecycle and recovery:** published low-level initialization, raw
   notification/request routing, complete observations, exact response
   correlation and restart-safe ownership. No controller buffering, automatic
   inactive load, `run()` lifecycle ownership or fabricated RPCs.
2. **Host policy and workspace:** canonical physical checkout/ref/SHA proof,
   effective High/model/validator settings, enforceable consequence/cost
   boundaries, revocation and supported controls. Prompts are not enforcement.
3. **Admission integration:** read-only preflight before scope/High approval,
   exact reviewed workspace/settings binding and race-safe phone/client wiring.
4. **Main integration and oversight:** shared contracts, durable broker/router
   wiring, independent review, regression qualification and honest reporting.

The static investigations are complete. Lifecycle, host-boundary and phone
admission implementation now have separate owners. Shared protocol, ledger,
router and main-thread edits are coordinated by the main thread.

## Concrete admission gaps

The current phone submits `settings: {}` and only a base reference, with no
immutable base SHA. That cannot satisfy the production broker's effective
settings and checkout/base proof requirements. A synthetic fixture accepting
that intent is not evidence that the production admission path works.

The new flow must establish read-only, owner/machine-bound workspace and native
settings evidence before asking the owner to approve the exact frozen scope.
Edits, expiry, credential/host changes and failed evidence must revoke consent.
Prepare must revalidate the same facts immediately before initialization.
New repository/clone/fork operations remain held unless their initialization and
consequence enforcement are actually implemented and independently qualified.

## Review and qualification requirements

- Use only methods and wire shapes present in the pinned SDK 0.9.1 public
  declarations and published implementation. Record exact evidence anchors.
- Offline tests exercise real provider adapter/decoder/policy/broker paths
  through synthetic daemon/host boundaries, not copied helper conditions.
- Durable unknown initialization/goal/answer outcomes never replay on reconnect
  or restart. A daemon cache or cleared prompt is not authoritative closure.
- Distinguish unavailable API behavior, implemented source, offline validation
  and separately unqualified live behavior.
- Root TypeScript checks alone do not establish SDK adapter type compatibility.
  Verify the optional boundary against published declarations without executing
  the downloaded SDK.
- Keep launch disabled until implemented transport and independently signed
  host qualification gates agree. No test flag or environment toggle bypass.
- Run affected regressions, then full offline suites, types/copy/build, fixture
  exclusion and relevant simulator flows. Preserve explicit provider/hardware
  gates and clean up only owned verification processes.

## Current state

SDK lifecycle/recovery and policy/workspace investigations found no complete
passive pending recovery or whole-Mission control API. High autonomy is not a
consequence boundary or hard budget. Supported source paths must retain these
holds rather than claiming the missing guarantees.

Shared host/send-permit/journal contracts and partial-section presence are
defined. The broker now has a read-only admission route and fenced provider
journal. The client/main path binds a single-use preview to the exact profile,
credential, immutable SHA, settings, reserved mission/command IDs and expiry.
The lifecycle, host-boundary and admission implementations are integrated. The
prospective phone admission and host-enforcement reviews completed with no
verified defects. The SDK broker review found two P1 defects, both fixed and
confirmed closed by the same reviewer:

- Public response schemas strip the daemon-only `sessionId`. The adapter now
  validates the response payload and then restores the exact routed session ID
  before the SDK send. It passes a type-only proof against pinned SDK 0.9.1
  declarations without importing or executing the SDK.
- Bridged provider requests in `answer_unknown` were projected as pending,
  which the observation decoder rejects, permanently fencing the provider. Only
  open requests are bridged now (`test:native-admission` regression).

The simulator rerun exposed a third issue. A webview capture stalls the
simulator host bridge for 30-45 seconds; a store write caught in that window
times out, and the store correctly refuses later writes. The native actor kept
showing its last snapshot as live and answerable and could misreport the
failed save as an observation quarantine. It now stops reading, refuses
commands, and shows `Local save failed; native updates paused` on phone and
glasses (`test:native-runtime` regression). The dev-only walkthrough pauses
scheduling during captures after queued saves settle; freshness and storage
gates are unchanged. Recovery still needs a relaunch.

Final offline qualification (`NATIVE-PROVIDER-QUALIFICATION-2026-10-13.md`,
13:40:41Z): 30 suites, 4,106 labeled checks, 0 failures. Copy budgets, type
check and production build pass (803.70 kB chunk, existing >500 kB warning);
the bundle has no fixture or probe markers. The native simulator walkthrough
passed 9/9 with eleven screenshot pairs in
`.screenshots/native-mission-provider-2026-10-13/`. No real SDK was imported
or executed and no native capability was enabled.

## Live SDK run and canary (2026-10-13)

Owner-authorized, SDK-direct. Spriite native launch stayed off; the broker
and app did not drive any of it. Workspace: private scratch repository
a private scratch repository, cloned to a temporary directory with the
remote removed, an isolated git config, an empty `gh` config and disabled SSH.

- SDK run (`@factory/droid-sdk` 0.9.1, Low autonomy): a `git push` permission
  request offered proceed_once/proceed_always/cancel; cancel was honored with
  no retry. AskUser options arrive as plain strings with 1-based indices and
  an answer must repeat the question text. A multiSelect answer sent as a JSON
  array was understood by the model, which is observation only:
  `sdk_multiselect_encoding_unqualified` stays held. `resumeSession` kept the
  same ID and context and replayed no notifications.
- Mission canary (low-level `DaemonClient` against a private loopback daemon,
  Mission/High): passed. One worker added `greet.js` and `greet.test.js` and
  committed `2f1b1bf` on `main`; `npm test` passes (1/1), no remote exists,
  pre-existing untracked files were untouched, and the GitHub repository still
  holds only the initial commit.
- Finding: this Factory release runs Missions as v2 (`mission-v2` tag). The
  approvals are `recommend_mission` then `exit_mission_planning` (carries the
  plan), not `propose_mission`/`start_mission_run`. Workers arrive as
  `child_session_available` with `subagentType: "worker"`; no
  `mission_state_changed` or `mission_worker_*` notifications were seen. Plans
  and check results live in `~/.factory/missionsV2/<session>/`. Feeding the
  captured requests to `decodeSdkEnvelope` yields `unsupported` /
  `sdk_confirmation_handoff` for both, so the broker fails closed. Supporting
  v2 needs a new proposal/start mapping and observation source before any
  launch gate can move.
- The high-level `connectToDaemon` session handlers were never invoked for
  daemon permission requests (the controller queues them internally), so the
  broker's low-level adapter choice is required, not stylistic.

Deployment: the broker runs on the owner's Factory host as a background service (a LaunchAgent on that macOS host)
`ai.spriite.native-broker` (127.0.0.1:47821, bearer token, `qualified:false`,
`launch:false`). The phone cannot reach it without an HTTPS or tunnel route,
which was not set up. Private build 0.2.27 was packed (495,726 bytes, SHA-256
`249c8836a7a40644383f6c4890ee3acac9a966ae9c561e581fce4755ddb4aeaa`) and
uploaded to Even Hub as a Private build; the portal's build details show
v0.2.27, Private, 495.7 KB and the change log.
