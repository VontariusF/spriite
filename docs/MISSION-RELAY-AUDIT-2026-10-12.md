# Mission, intent, and question-relay audit

> **Historical record (2026-10-12).** This documents a past run on the original developer's single macOS host and may name tools, paths or states that have since changed. For current setup see [NATIVE-BROKER-SETUP.md](NATIVE-BROKER-SETUP.md) and [SETUP.md](SETUP.md).

- Date: 2026-10-12
- Baseline: Private 0.2.26; HEAD `a8cf7c4`, with the existing dirty working tree.

## Outcome

The failure is architectural, not just a missing popup. Spriite currently owns
an ad hoc execution orchestrator while observing only part of the provider's
conversation and control state. Intent, native approvals, repository identity,
remote delivery, and verified results are not represented consistently across
the entry surfaces.

Three independent reviewers mapped:

1. Questions, permissions, provider messages, and presentation.
2. Input intent, context, repository routing, and voice ownership.
3. Launches, dispatch receipts, review evidence, controls, and recovery.

The register below contains 36 distinct issues or capability gaps after
deduplication. These are **not 36 live-reproduced failures**. Evidence labels
distinguish live observation, focused reproductions, static source traces, and
provider contracts still needing validation.

This work changes no production code or live task. The deeper companion map is
`docs/NATIVE-MISSION-INTEGRATION-MAP-2026-10-12.md`. No live answer, approval,
retry, Mission launch, repository creation, deployment, upload, commit, or push
was performed.

## Confirmed incident

The actual Factory browser chat was read and its popup visually inspected.

- Session: `94c1ad49-9c44-46bd-ada6-03b280169d3e`.
- The request referenced Plexo, but the initial coordinator prompt selected
  the configured existing Spriite repository.
- The owner chose local execution. That choice did not change the repository.
- The plan then described integration into Spriite.
- The coordinator subsequently **claimed** a Cursor worker had pushed a branch.
  This investigation has not verified that branch, its commits, or a PR.
- The current popup requests a medium-risk clone of that branch into a temporary
  review directory. It is a native permission request, not an ordinary message
  question. It was unanswered at inspection; this investigation did not answer
  it or recheck live state during the subsequent team audit.
- The session's child-list response was empty. Child attention discovery alone
  therefore cannot reveal this root-session popup.
- The browser capture is `.screenshots/worker-question-factory-browser.png`.

The repository behavior follows the current saved-default routing. It is not
evidence of repository corruption. It is wrong for the owner's intended
standalone/new-repository task, and the system did not resolve that ambiguity
before authorizing work.

## Can Factory Missions be launched through an API?

### What is supported

| Surface | Verified capability | Important boundary |
| --- | --- | --- |
| Public REST | `POST /api/v0/sessions` accepts `computerId`, `cwd`, and `sessionSettings`; the interaction-mode enum includes `mission` and `agi`. Sessions can be messaged, inspected, interrupted, and their children listed. | Schema acceptance is not proof that a complete Mission can be planned, approved, started, answered, and recovered with these endpoints. Session access is organization-gated. |
| Child-session REST | `GET /api/v0/sessions/{id}/children?includeAttention=true` describes child permission or AskUser attention. | It does not expose this incident's root permission payload, offered outcomes, or an answer operation. |
| TypeScript SDK | Persistent sessions, streaming, asynchronous native handlers, interruption, resume, daemon/subprocess integration. Static inspection of published `@factory/droid-sdk@0.9.1` additionally confirms Mission mode, proposal/start confirmation payloads, six Mission notification families, snapshots and restored pending-request schemas. | The basic guide describes a smaller surface. `unstable.missions` only exposes readiness operations, not lifecycle CRUD. Proposal/start are native permission responses; their actual offered outcomes, runtime enforcement and durable recovery remain unproven. |
| Headless CLI | `droid exec --mission` is documented and present in the installed CLI's help. Worker and validator model settings are supported. | Mission execution requires High autonomy, or the unsafe permission bypass. One-shot execution is not a substitute for interactive question handling. |
| Raw JSON-RPC | A documented integration path exposes session initialization, turns, notifications, permission requests, and AskUser requests. | Versioned initialization/settings and the Mission-specific lifecycle must be proven. Installed help warns that CLI flags do not configure JSON-RPC sessions. |

The published OpenAPI contains no dedicated Mission launch/approval endpoint
and no native permission/AskUser answer endpoint. This does **not** prove that
Factory lacks internal APIs. It means they are not established public contracts
for this integration.

**Answer:** native Missions can be launched programmatically through the
documented CLI. A backend can expose that capability through an owned API.
The published TypeScript SDK also exposes Mission-mode initialization and the
typed native approval/observation path. It does not expose a dedicated
`startMission()` lifecycle method. The public REST schema accepts Mission mode,
but a REST-only, fully interactive integration has not been established here. Do not ship
`interactionMode: "mission"` as if it alone solved the launch and approval flow.

### Recommended direction

Use a persistent, authenticated execution broker around supported Factory
transports. Make Spriite a thin companion for intent, approval, questions,
navigation, and evidence-labelled status. Prefer Factory-native Missions for
multi-step execution **after the capability gate below passes**.

The SDK is a promising solution to the current popup problem because it has
actual native question and permission handlers, including typed Mission
proposal/start confirmations. Use a request-aware, version-matched transport,
not a guessed Mission CRUD endpoint or a single mode flag. The deeper map
records fire-and-forget responses, optimistic prompt clearing, in-memory answer
buffers and automatic inactive-session reload. None proves durable acceptance
or safe restart. Prove those behaviors before enabling execution.

Do not launch a Mission on this task as an experiment, convert its existing
session, or silently replace the chosen Cursor/Factory backend. Do not raise
autonomy to hide an approval problem. Do not use `--skip-permissions-unsafe`.

Sources checked on 2026-10-12:

- [Public OpenAPI](https://docs.factory.com/openapi.json)
- [Sessions API](https://docs.factory.com/api-reference/sessions.md)
- [TypeScript SDK](https://docs.factory.com/sdk/typescript.md)
- [Headless execution and JSON-RPC](https://docs.factory.com/droid-exec/overview.md)
- [Mission configuration](https://docs.factory.com/missions/reference.md)
- [Mission overview](https://docs.factory.com/missions/overview.md)
- Installed `droid exec --help`, inspection only.
- Published official `@factory/droid-sdk@0.9.1`, static declaration and bundled
  implementation inspection only. Exact provenance/contracts are in the
  companion integration map; no installation or package execution.

## Current architecture

```text
X / phone text / glasses voice / Send message / watched-chat review
  -> input parsing and bounded context
  -> repository/default routing and durable command
  -> Supervisor admission and frozen mission config
  -> MissionActor
  -> optional repository create
  -> ordinary Factory coordinator session
  -> numbered PLAN_READY protocol and local approval
  -> Factory worker sessions or Cursor agents/runs
  -> branch claim
  -> ordinary Factory reviewer and token-framed verdict
  -> repair / integration prompts
  -> optional PR gate and PR claim
  -> final scene and summary
```

Separate projections and ledgers:

- RuntimeEngine selects views and presents questions; selection is not authority.
- MissionStore and Outbox persist commands and resource-launch outcomes.
- WatchReceiptStore holds watched-session message uncertainty independently.
- Factory messages provide text and AskUser extraction, not a complete control
  stream. Task children are not discovered by the current clients.
- Native AskUser requires an exact Factory handoff; native permissions and spec
  approval are not modeled. Cursor has no complete blocked-question path.
- User turns, older pages, effective settings, physical workspace identity,
  reviewed commits, and artifact identities are incompletely observed.

The relay is currently a transport proxy, with separate archive routes on the
Node host. It is not an execution broker. Adding execution responsibilities
requires explicit authentication, persistence, policy, process ownership, and
deployment work, not merely broadening a proxy route.

## Issue register

Evidence: **L** live/browser confirmed; **R** reproduced with production code
and synthetic, network-stubbed inputs; **S** source-verified trigger;
**C** provider capability/contract needs confirmation. P1 means high-impact
correctness or authority failure; P2 means a narrower failure or capability gap.
No P0 finding was established.

### Input, context, and authority

| ID | Priority / evidence | Location | Failure and planned repair/test |
| --- | --- | --- | --- |
| I01 | P1 / L,S | `src/intake/x.ts:1236`; `src/runtime/supervisor.ts:457` | Reference/source, destination, and operation are conflated. Ambiguous requests adopt the saved default and auto-approve; explicit new-repository words do not set create intent, and generic holds lack New repo controls. Resolve destination and create/fork/clone/integrate intent before execution. Test the standalone Plexo request, explicit new-repo wording, source URLs, and unknown projects. |
| I02 | P1 / S | `src/main.ts:1229` | Glasses Talk on a background ask notice bypasses the router that focuses the asking mission, so speech reaches the currently focused mission or demo. Use one target-validating action route. Test two missions and a demo-owned HUD. |
| I03 | P1 / S | `src/main.ts:996` | General voice clips the canonical request to HUD lines before goal, clarification, or steering dispatch. Keep the full transcript; fit display text only. Test a trailing repository/no-deploy restriction beyond the display budget. |
| I04 | P2 / R | `src/voice/intent.ts:44` | Substantive goals containing status/progress nouns are swallowed as status commands. Use whole-utterance command grammar. Test “Build a status dashboard,” progress-feature requests, question answers, and actual status queries. |
| I05 | P1 / R | `src/context/gather.ts:326` | The whole X instruction-plus-context is truncated at 3,000 characters, losing owner restrictions and possibly the trust boundary. Preserve owner text and boundary; budget references separately or hold explicitly. Test a long owner note with a trailing destination/no-deploy restriction. |
| I06 | P2 / S | `src/context/gather.ts:220` | Hyperlinked X status URLs are skipped unless also present as quote/reply references. Capture linked post IDs and missing-essential state within bounded reads. Test readable and unavailable hyperlink-only requests. |
| I07 | P2 / S | `src/intake/x.ts:1129` | Targeted X follow-ups are dispatched before reference gathering, so quoted/linked requirements disappear. Capture attributed follow-up context without changing the parent's destination. Test normal, held, restored, and missing-context follow-ups. |
| I08 | P2 / S | `src/intake/x.ts:1082` | X status requests are labelled reported without a generated status answer or mission selection. Produce a private, freshness-labelled response or target clarification. Test zero, one, multiple, and stale missions. |
| I09 | P2 / S | `src/factory/github.ts:99` | Repository discovery stops at the first 100 entries; a named project beyond that page can fall back to the wrong default. Paginate or hold incomplete discovery. Test the target on page two and failed continuation. |
| I10 | P1 / R | `src/factory/build-intent.ts:93` | Substantive owner turns starting Continue/Resume are discarded from watched execution scope. Filter exact generated controls, not prefixes. Test a retained database/no-deploy correction overriding earlier assistant advice. |
| I11 | P1 / S | `src/factory/real.ts:4382` | Prefix-based yes/okay handling accepts conditional answers as unconditional build/PR approval. Require whole-turn approval, preserve conditions, revise scope, and reconfirm. Test yes-with-new-repo and okay-with-no-PR. |
| I12 | P2 / S | `src/main.ts:1663` | Exit cleanup does not invalidate a settling voice turn, allowing post-exit routing without a preceding background event. Tear down capture ownership and settlement together. Test exit while transcription is awaiting completion. |

### Questions, history, and observation

| ID | Priority / evidence | Location | Failure and planned repair/test |
| --- | --- | --- | --- |
| A01 | P1 / R | `src/factory/fapi.ts:386` | Live `toolUseId` results are ignored by snake-case-only completion parsing, keeping answered native questions open. Normalize both supported dialects once. Test adapter, engine closure, and restore with camelCase results. |
| A02 | P1 / L,S,C | `src/factory/fapi.ts:395` | Execute/spec attention and nested Task-worker attention lack a complete relay path. Add typed attention, exact ownership, capability-labelled Factory handoff, and child discovery. Prove root permission transport separately; child attention does not solve it. Test each attention type and owner separately. |
| A03 | P1 / R,S | `src/factory/fapi.ts:370` | Only 100 messages are fetched and pagination is discarded. Missing request/closure/goal boundaries are treated as complete history. Read bounded pages to the required boundary and expose incompleteness. Test long turns, old closure results, and unavailable boundaries without replay. |
| A04 | P1 / S | `src/factory/real.ts:4330` | X follow-ups bypass native-question checks; worker answer pre-reads do not observe newly arrived native attention. Centralize destination-specific attention barriers. Test a follow-up during AskUser and a native question arriving before an ordinary worker answer POST. |
| A05 | P1 / S | `src/factory/real.ts:4186` | Send message voice uses steer; a worker question arriving during capture can leave the transcript posted to the coordinator instead. Retain the full draft or explicitly route to its intended owner. Test the race and assert zero coordinator POSTs. |
| A06 | P2 / S,C | `src/factory/real.ts:3370` | Cursor lacks a complete blocked/question-answer state. A question-shaped finished result without a branch becomes a generic no-branch error. Validate actual status/text contracts, then preserve agent/run identity for supported answers; otherwise offer an honest provider handoff. Do not invent BLOCKED/STOPPED mappings. |
| A07 | P2 / S | `src/factory/real.ts:2140` | Plain questions answered directly in Factory remain locally pending after an ordinary reply. Track question and subsequent user/response identities. Test external answers and revisions of older question messages without inventing approval. |
| A08 | P2 / S | `src/factory/real.ts:500` | Fitted option labels are stored and sent as answer values, losing qualifiers or collapsing distinct choices. Preserve raw values/IDs separately from display labels. Test identical long prefixes and essential trailing restrictions. |
| A09 | P2 / S | `src/factory/real.ts:2146` | Watched conversation import omits provider user turns, hiding goals and external answers. Import chronological user text with stable IDs and local-send dedupe. Test priming, external answers, and navigation without duplicate rows. |
| A10 | P2 / S | `src/factory/real.ts:5193` | Nested snapshot rows are not fully decoded; null jobs or malformed queued questions can crash runtime restore. Validate and quarantine damaged records without granting authority. Test malformed jobs, options, strings, and native references through store/archive recovery. |
| A11 | P2 / S | `src/runtime/app-engine.ts:229` | Ask notification dedupe omits stable tool/session/question identity. Two identical native questions replaced in one poll can suppress the second notice. Key by request identity while retaining once-only navigation behavior. |
| A12 | P2 / S | `src/factory/fapi.ts:96` | Fetch has no deadline; a hung read/POST can retain polling or busy latches indefinitely. Bound request lifetimes, release only the owning generation, and classify timed-out invoked POSTs as uncertain. Test never-settling reads and writes. |

### Dispatch and control

| ID | Priority / evidence | Location | Failure and planned repair/test |
| --- | --- | --- | --- |
| D01 | P1 / R | `src/factory/fapi.ts:351`; `src/factory/real.ts:1754` | A 2xx/204 response without a usable message acknowledgment is classified as a retryable service failure instead of uncertainty. Preserve the durable hold after unreadable acknowledgment. Test empty/invalid success bodies across owner answers, steering, worker execution, and restart. |
| D02 | P1 / S | `src/factory/real.ts:1928` | Planning/review/summary/resume POSTs opt out of delivery protection and may be automatically replayed after acknowledgment loss. Apply receipt handling to every turn; distinguish definitely unsent from outcome unknown. Test lost acknowledgments across each coordinator request. |
| D03 | P1 / S | `src/factory/real.ts:1928` | Those coordinator POSTs also bypass the final pause/cancel/terminal barrier. A late worker result can start new review work after interruption. Apply the control barrier to all execution-causing POSTs, not just worker launches. Test delayed completion after pause/cancel. |

### Repository identity, review, and recovery

| ID | Priority / evidence | Location | Failure and planned repair/test |
| --- | --- | --- | --- |
| R01 | P1 / S | `src/runtime/outbox.ts:241` | Unknown repo-create reconciliation looks up the caller's current name, not the exact original dispatched name. Typed names and fallback suffixes can reconcile the wrong repository. Persist exact account/name/visibility and reconcile only that request. Test typed-name and suffix timeout/restart cases. |
| R02 | P1 / S | `src/factory/real.ts:914` | Changing or re-testing Setup can move existing session traffic to the new default computer. Freeze hosting identity per session; apply new defaults only to future builds. Test active sessions, worker sessions, and restore across a default change. |
| R03 | P1 / S | `src/factory/real.ts:3297` | Branch strings, a model summary, or a same-repo PR URL can be accepted without verifying repository/head/base/commit correspondence. Verify provider artifacts independently and bind review to an immutable commit. Test unrelated PRs, wrong-repo/nonexistent branches, and unchanged repair output. |
| R04 | P1 / S | `src/factory/real.ts:2554` | A fresh reviewer receives the goal/job label but not the complete approved acceptance criteria given to the worker. Review the frozen approved scope and clarifications. Test title-compliant output that violates one approved criterion. |
| R05 | P1 / S | `src/runtime/mission.ts:1506` | Restored local values can be labelled freshly observed, while unchanged successful polls do not advance freshness. Carry successful provider observation timestamps/IDs independently of local state changes. Test offline restore and repeated unchanged successful reads. |
| R06 | P1 / S | `src/factory/real.ts:1039` | Freshly retrieved Factory idle is trusted despite recorded idle responses during real tool execution. Separate reported status, observed activity, attention, and verified readiness. Test idle-with-growing-history without claiming either completion or perpetual historical activity. |
| R07 | P1 / S | `src/runtime/supervisor.ts:748` | PR completion retires the actor before a delayed required summary is observed; restart also skips it. Add delivery finalization or bounded read-only terminal observation. Test delayed summary, failed request, and restart. |
| R08 | P1 / S | `src/factory/real.ts:3856` | After successful lead creation and definite rejection of the initial plan POST, Retry calls session creation logic that returns because the lead already exists. Retry the known-unsent initial turn on the existing lead. Test create-success/POST-refusal/retry without a second session. |
| R09 | P2 / S | `src/factory/real.ts:2806` | PR instructions hard-code main even though baseRef is stored. Resolve and freeze the selected/default base and SHA; thread and verify them through execution/review/PR. Test a non-main repository. |

### Boundaries that must not be overclaimed

- A02 includes an established missing root permission surface and additional
  unsupported spec/child paths. Actual root/spec/child callback coverage still
  requires transport validation.
- A06 is a missing provider-capability path, not proof that this Cursor worker
  is currently asking a question. Its actual artifacts/status were not fetched.
- Damaged persisted state, long histories, voice races, and outage scenarios
  are source-verified triggers, not claims that the owner's live record hit them.
- Pausing/interruption acceptance is not proof all remote processes stopped.
- Existing cross-instance receipt writes are not a distributed CAS/lease.
- Current delivery ends at a PR; merging it into the default branch is not an
  implemented or implicitly authorized capability.
- An explicit workspace preflight is missing from the architectural contract.
  REST supports `cwd`, but `factoryCreateSession` currently sends only computer
  and settings. A repository in a prompt does not bind the physical checkout.
  Do not select this app's own directory merely because it is locally available.

## Target ownership model

```text
Spriite inputs and views
  -> lossless, structured owner intent
  -> explicit destination / operation / execution-location clarification
  -> durable scope revision and consequence-bound approval
  -> authenticated broker with idempotent local commands
  -> version-verified Factory transport
  -> Factory-owned planning, workers, validation, and Mission execution
  -> typed attention and evidence events
  -> Spriite phone/glasses projections and durable return briefing
```

Keep these responsibilities in Spriite/broker:

- Lossless owner intent and reference provenance.
- Source repository versus destination repository; create/fork/clone versus
  integration; local execution versus deployment. Local execution does not
  independently approve remote repository creation or publication.
- Account, repository ID, computer, workspace, base ref/SHA, provider choice,
  model settings, policy, resource limits, and execution consequences.
- Fresh owner approval bound to the current scope revision.
- Durable local command/launch/answer receipts and unresolved outcomes.
- Exact root/child/session/tool/question identities and a queue of attention.
- Safe controls, crash recovery, lifecycle ownership, and capability limits.
- Verified repository evidence and honest freshness.

Remove the local numbered-plan, branch-name completion, prose-verdict,
repair-loop, fan-out, and integration orchestration from the **new native
backend** only after native contracts are proven. Keep the legacy reader and
receipts for old tasks; do not replay or convert them.

## Prioritized implementation plan

This is a proposal. Implementation and any paid canary require authorization.

### 1. Reproduce and contain current authority failures

Cover I01–I05, I10–I12, A01, A04–A05, D01–D03 first.

- Add tests against production entry functions and actual actor/client seams.
- Preserve full owner text and raw answer values.
- Route Talk and Send message through destination-bound ownership checks.
- Treat conditional approval as a scope update, not permission to execute.
- Hold ambiguous standalone/reference requests for destination clarification.
- Normalize live tool-result dialects.
- Centralize final authority and durable delivery checks for **all** POSTs.
- Protect unreadable success acknowledgments and timed-out writes as unknown.
- Expose unsupported native attention honestly with the exact Factory handoff;
  never synthesize a native answer using a text message.

Exit: the representative scope/routing/unknown-delivery reproductions turn
green, with no additional remote dispatch in pause/cancel/restore tests.

### 2. Establish the native Mission capability gate

Before building a replacement backend:

1. Pin the CLI/SDK/protocol combination; inspect declarations and documented
   methods. Do not invent Mission RPC names from internal UI behavior.
2. Verify create-versus-Mission mode semantics, planning, completed-plan
   approval, Mission start identity, child discovery, attention payloads,
   native answers, offered permission outcomes, interruption, and recovery.
3. Prove root and child question/permission callbacks separately. SDK handlers
   must not auto-select an answer; omitted handlers decline/cancel by default.
4. Verify effective settings and actual workspace/repository binding.
5. Verify the account's Mission entitlement and High-autonomy requirement.
   An owner must explicitly approve that execution policy. Enforce publishing
   and deployment restrictions through actual policy/sandbox/credential
   boundaries, not only model instructions.
6. Start with mocked protocol fixtures. Run one bounded scratch canary only
   after approval, in a separately approved private workspace, with no unrelated
   repository access, deployment, or PR merge.
7. Exercise pending questions, broker restart, ambiguous launch/answer receipt,
   and cancellation. Native launch support without interactive/recovery support
   does not pass.

Exit: a recorded capability matrix proves the entire chosen lifecycle. If the
public native transport cannot support it, expose the exact Factory handoff
and mark native launch unavailable; do not quietly fall back to an unsafe
custom launch. Headless capability alone does not pass this gate.

### 3. Implement structured intent and workspace preflight

Cover I01, I05–I07, I09–I11, R01–R02, R09 and workspace binding.

- Persist operation, source/reference, destination, initialization method,
  execution/deployment location, and scope revision as distinct fields.
- Make New repo available for all applicable holds and input surfaces.
- Recognize explicit owner create intent without promoting external URLs to
  authority. Confirm fork/clone source separately from destination.
- Read full repository discovery, account/default branch metadata, and the
  physical checkout identity. Handle new/empty repositories explicitly.
- Persist the exact dispatched repository-create identity, including fallback
  name and visibility. Never reconcile a different name.
- Freeze existing sessions' account/computer/workspace identity independently
  of next-build Setup defaults.
- Re-plan and reconfirm destination changes. Do not move a running task.

Exit: the Plexo-style request cannot enter an integration branch by silently
adopting this application's saved repository.

### 4. Add a persistent attention and event broker

Cover A02–A09, A11–A12, I02, I07–I08, D01–D03, R05–R06.

- Add an authenticated, owner-scoped execution service, not a new arbitrary
  shell endpoint. Keep provider secrets out of events, UI state, and logs.
- Persist sequenced events and attention with request/revision, provider,
  root/child owner, session/tool identity, payload, offered choices/outcomes,
  state, and observation time.
- Drive supported native question/permission handlers from explicit user
  actions. Default to a once-only offered outcome; Always allow is a separate
  policy change, never the default.
- Keep multiple questions queued without losing background owners or full
  transcripts. Display labels are not answer values.
- Use acknowledged event cursors and bounded pagination; represent incomplete
  history instead of manufacturing boundaries or closure.
- Reconcile external answers and import provider user turns without duplicate
  locally posted text.
- Reattach runtime handlers on SDK resume and prove pending-request recovery;
  handlers are not serialized by the SDK.
- Use per-destination serialization and a lease/fencing boundary if multiple
  broker instances are allowed. Do not claim exactly-once provider execution
  when the provider does not supply a correlatable receipt.
- Keep unknown sends unresolved until independent evidence or explicit owner
  resolution. Bound reads/writes and release only the owning polling latch.
- Implement real private X status answers with target/freshness information.

Exit: root and child questions survive navigation, disconnect, restart, and
same-text replacement; every answer reaches the right live request once or
remains visibly unresolved.

### 5. Replace execution orchestration behind an explicit backend choice

Cover D02–D03, R04, R07–R08 and the native replacement of legacy orchestration.

- Add a Factory-native backend with typed planning, approval, execution,
  validation, attention, result, and terminal-finalization states.
- Bind provider launch identity durably; reconcile ambiguous launch outcomes
  without creating another Mission.
- Let Factory own worker scheduling, validation, repair, and integration where
  the capability gate proves support. Remove duplicate local loops on that path.
- Preserve approved criteria and owner restrictions through review/validation.
- Keep normal/spec sessions available for small tasks or unsupported Mission
  policies, with their own supported handlers. Do not disguise them as Missions.
- Require explicit backend/provider and autonomy consent. Do not silently
  discard an existing Cursor preference or lower-autonomy policy.
- Old tasks retain their original backend and hosting identity. Keep receipt
  resolution and read-only inspection; never auto-migrate/relaunch them.
- Repair known-unsent initial-turn retry and terminal-summary observation in
  retained legacy tasks without reintroducing unsafe replay.
- For Cursor, validate A06 first; keep unsupported blocked interactions visible
  rather than accepting them as finished work.

Exit: exactly one system owns each task's execution; the companion does not
start a second worker/reviewer loop on a native Mission.

### 6. Verify evidence, freshness, and damaged-state recovery

Cover A03, A07–A10, R03–R07, R09.

- Resolve account/repository/branch/base/head/PR identities independently.
- Bind review and delivery to immutable commits and approved acceptance criteria.
- Reject unrelated PRs, wrong-repository artifacts, nonexistent branches, and
  unchanged “fixed” results as delivery evidence.
- Distinguish provider-reported status, successful observation time, local
  transitions, verified code evidence, and pending attention.
- Preserve bounded terminal observation/finalization without granting new
  execution after completion.
- Decode all restored nested records. Quarantine damage without restoring
  approvals, launch rights, or inventing a native answer.

Exit: a branch name, FINISHED string, model PASS, restored snapshot, or freshly
retrieved idle value cannot become stronger evidence than it actually is.

### 7. Qualify, then opt in privately

- Add one regression for every accepted register item; use actual production
  routers/actors/adapters, not just copied helper expressions.
- Keep the existing 21 suites and extend their corpus with real response shapes,
  long histories, native requests, and missing acknowledgment bodies.
- Run narrow affected suites first, then `npm run qualify`,
  `npm run check:copy`, `npm run build`, and `git diff --check`.
- Run fresh simulator journeys with phone and glasses visual review, explicit
  storage health, downstream artifact checks, and zero unexplained dispatches.
- Run the separately authorized live scratch transport canary and hardware
  lifecycle tests. A mock/simulator pass is not native or hardware proof.
- Keep native backend opt-in and preserve old tasks/receipts on rollback.
- Request separate authorization for release/upload, installation, live
  recovery, or any Git publication.

## Required end-to-end journeys

1. X references a third-party product; choose new private repository, select
   local execution, approve the exact scope, and verify no Spriite branch is used.
2. Coordinator asks a native question, worker asks another, and a native
   command/spec approval follows. Switch tasks and return; each retains its owner.
3. Background ask notice Talk and Send message captures race another question.
   No transcript is clipped, lost, or sent to the wrong session.
4. Owner says yes with a restriction. Scope is revised; no build/PR is dispatched.
5. A question is answered in Factory; closure is reflected locally. An identical
   later question produces a new notice.
6. Long history crosses multiple pages; full intent and the active request
   boundary remain recoverable, or the UI states history is incomplete.
7. Provider accepts a POST but returns an empty/invalid acknowledgment; restart,
   ticks, Retry, and cancellation never duplicate it.
8. Repository creation with a typed/fallback name loses its receipt; restart
   reconciles that exact resource, never an existing different name.
9. Setup's computer/defaults change while two tasks run; their hosting identity
   and approved configuration stay unchanged.
10. Pause/cancel while a worker completes; no new review/summary execution crosses
    the control barrier. Late resources remain reconciled.
11. An unrelated PR/branch and an unchanged repair result are rejected. Review
    uses the approved criteria and exact base/head commit.
12. Final delivery has a delayed summary; it is observed across restart without
    starting new execution.
13. Damaged snapshots and hung reads recover honestly, without restoring rights.
14. Native Mission launch/answer loses its broker connection; ownership and
    unknown outcomes survive without a second Mission.

## Validation performed in this investigation

The team read production code, diffs, related callers, and tests. It did not run
live providers or modify source.

The main thread ran six focused, network-stubbed production-code cases:

| Case | Observed result |
| --- | --- |
| Substantive voice status goal | Classified as a status command, not a goal. |
| Continue-prefixed owner restriction | Review scope exists but omits the restriction. |
| Long X owner instruction with context | Trailing restriction and trust boundary are both absent. |
| CamelCase native tool completion | Answered AskUser remains pending. |
| Message pagination | Advertised additional page is not fetched; pagination is lost. |
| Empty successful POST acknowledgment | Service error falls outside the uncertainty classifier. |

The initial invariant checks returned failure because the expected invariants
are currently violated. A follow-up using a schema-valid context record
confirmed the same three intent defects. These are RED evidence, not repaired
tests. They were inline probes, not permanent regression suites.

Full qualification, new simulator runs, SDK installation, native Mission
execution, paid provider runs, hardware dictation/lifecycle testing, and release
packaging were **not** performed for this planning task. The earlier 0.2.26
qualification is not evidence that the newly identified cases pass.

## Definition of done

No new execution proceeds with an unresolved destination or lost owner
restriction. Every supported root/worker question or permission is visible and
bound to its actual request. Unsupported attention has an honest handoff.
Uncertain delivery never triggers a blind replay. Controls cover every
execution-causing turn. Repository identity, review criteria, evidence, and
freshness remain truthful through restart. Native Missions are enabled only
after the full interactive lifecycle, policy, and recovery contract is proven.
