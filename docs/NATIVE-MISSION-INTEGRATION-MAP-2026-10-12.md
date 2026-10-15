# Factory-native Missions with Spriite companion projections

> **Historical record (2026-10-12).** This documents a past run on the original developer's single macOS host and may name tools, paths or states that have since changed. For current setup see [NATIVE-BROKER-SETUP.md](NATIVE-BROKER-SETUP.md) and [SETUP.md](SETUP.md).

- Date: 2026-10-12.
- Baseline: private 0.2.26, HEAD `a8cf7c4`, existing dirty working tree.
- Status: architecture and static protocol map, **not an implementation**.
- Companion register: `docs/MISSION-RELAY-AUDIT-2026-10-12.md`.

Subsequent offline source work and qualification are recorded in
`docs/NATIVE-MISSION-IMPLEMENTATION-2026-10-12.md` and
`docs/NATIVE-MISSION-QUALIFICATION-2026-10-12.md`. This map remains the design
record. The actual native provider path remains incomplete and disabled.

## 1. Decision and boundaries

Use Factory-native Missions as the proposed execution owner for newly opted-in,
eligible Spriite jobs. Keep Spriite's current checkpoint, question, status,
history, task-switching, and phone/glasses format as projections of that work.

This is not “set interactionMode to mission in the current coordinator.”
Introduce an independent native actor and a persistent broker. The native actor
must never invoke the legacy planning, worker, reviewer, repair, integration,
or PR loops. There must be exactly one execution owner for each task.

The native route is conditional on the full interactive capability gate below.
Programmatic types and static implementation establish a promising transport,
not a successful live lifecycle or recovery guarantee.

No live Mission, question answer, approval, retry, repository creation, SDK
installation, permission change, deployment, release, commit, or push was
performed for this map. The inspection downloaded the official SDK tarball
with scripts disabled and read selected declarations/implementation as data.

### Keep, replace, and add

| Layer | Decision |
| --- | --- |
| Owner input, X intake, context, drafts | Keep; fix lossless intent and destination authority. |
| Spriite scenes, sprite, phone, history, navigation | Keep the format; replace legacy snapshot dependencies with neutral projections. |
| Decisions and background question notices | Keep the interaction; add exact native request ownership and multiple pending requests. |
| Checkpoints and return briefings | Keep the journal/coverage design; connect production surfaces and distinguish observation from approval. |
| Numbered plans, PLAN_READY, prose review verdicts | Do not use on the native path. |
| Spriite worker scheduling, repair and integration loops | Do not use on the native path. Factory owns these. |
| Delivery uncertainty and controls | Keep the safety principles; implement broker-owned command/answer ledgers and native reconciliation. |
| Native execution transport | Add a version-pinned adapter around typed Factory interfaces. |
| Legacy and Cursor tasks | Preserve their backend, hosting, receipts, and supported controls. Do not convert or relaunch. |

### Product promise

“Spriite starts the approved Factory Mission, keeps you informed, and routes
each supported question to its exact owner.”

Do not promise every job uses Missions. Small tasks, unsupported policies,
unproven transports, and existing Cursor preferences require an explicit,
accurately labelled alternative or a hold. Mission execution's High-autonomy
requirement is a material policy change, not an implementation detail.

## 2. Evidence levels

- **Live:** the original Factory browser popup and transcript, previously read.
  That task's state has not been rechecked for this mapping.
- **Static SDK:** official `@factory/droid-sdk@0.9.1` declarations and bundled
  implementation inspected without importing or executing the package.
- **Source:** current Spriite code and retained independent team maps.
- **Proposed:** all application records, actor contracts, broker endpoints,
  lifecycle states, event names, and migrations in this document unless
  explicitly marked as a Factory contract.
- **Unproven:** effective runtime compatibility, account entitlement,
  interactive worker coverage, durable request recovery, and live outcomes.

SDK artifact provenance:

- Package: `@factory/droid-sdk`, version `0.9.1`, Node requirement `>=18`.
- Tarball SHA1: `19c04e85d6cc10274cbb4c3c8cab530a9ec2f8f2`.
- Artifact: `/tmp/spriite-native-sdk-map.uVTDq2/factory-droid-sdk-0.9.1.tgz`.
- Source package: `https://github.com/Factory-AI/droid-sdk-typescript.git`.
- Declarations: `package/dist/index-C06W9tbN.d.ts`, 147,691 lines.
- Implementation: `package/dist/chunk-TWSTJMV7.mjs` and `package/dist/node.mjs`.
- These temporary paths are inspection evidence, not production dependencies.

The previously read public SDK guide describes a smaller high-level API.
The actual published package exports Mission mode, proposal/start confirmation
types, native Mission notifications, and daemon-facing resources. The guide's
omissions must not be mistaken for an absent package capability.

## 3. Current execution and presentation coupling

```text
input -> Supervisor.submit -> Supervisor.spawn
      -> MissionActor -> RealOrchestrator
      -> ordinary coordinator -> worker(s) -> reviewer -> repair/integration
      -> EngineView / RealSnapshot
      -> RuntimeEngine -> phone and glasses

MissionActor checkpoint -> MissionStore journal and domain records
                       -> inbox / briefing builders / archive
```

Source boundaries that prevent a flag-only conversion:

1. `src/runtime/supervisor.ts:1178` constructs `MissionActor` for every task.
2. `src/runtime/mission.ts:306` constructs the legacy engine; starts and restores
   are coupled to its planning and worker machinery.
3. `src/factory/real.ts:2440-3459` owns the legacy orchestration phases.
4. `src/runtime/app-engine.ts:136` and its other view helpers depend on
   `RealSnapshot`. Native state cannot safely be disguised as that snapshot.
5. `src/runtime/mission.ts:1218` answers only the legacy proceed decision and
   explicitly rejects native questions. Returning “answered” for more option
   strings would not implement native routing, acknowledgment, or recovery.
6. `src/briefing/build.ts:117` reads PR/summary fields from opaque engine
   snapshots. Briefings need a neutral evidence and finalization source.
7. `src/state/archive.ts:1221` and `:1321` reconstruct legacy-shaped missions,
   including `main`/real-v assumptions. Native archive ownership must be explicit.
8. `src/runtime/boot-plan.ts:39` reasons about legacy restore exclusions.
   Native startup must attach and reconcile, not replay a stored start.

## 4. Target topology and ownership

```text
X / phone / glasses
  -> lossless CommandEnvelope + attributed reference context
  -> structured scope, destination and workspace preflight
  -> consequence-bound approval
  -> authenticated persistent execution broker
       -> durable intent, commands, attention and event journal
       -> one fenced execution owner per native task
       -> version-pinned Factory adapter
            -> native planning and proposal
            -> native run-start confirmation
            -> Factory worker / validator / orchestration
       <- state, features, progress, heartbeats and exact requests
  <- backend-neutral MissionPresentation
  -> current Spriite scenes / inbox / history / checkpoints / briefings
```

### Ownership table

| Owner | Canonical responsibilities | Must not do |
| --- | --- | --- |
| Spriite client | Capture drafts, navigation, local voice lifecycle, render receipt, cached projections, explicit owner actions. | Host execution in a phone lifecycle, fabricate closure, or replay a start on restore. |
| Broker | Scope/approval ledger, provider binding, execution lease, command outcomes, attention, durable event cursor, policy checks, observation/reconciliation. | Claim provider exactly-once from local dedupe or interpret model prose as authority. |
| Factory | Native planning, worker scheduling, validation, runner recovery within its supported lifecycle. | Be assumed to enforce Spriite-only restrictions without actual policy/credential boundaries. |
| Evidence observer | Read-only artifact verification and terminal collection. | Launch a replacement reviewer, repair, publish, merge or deploy. |

The existing relay is a proxy/archive service, not this broker. A broker needs
explicit authentication, owner/account scoping, persistent storage, process
ownership, bounded operations, and deployment approval. Do not add an arbitrary
shell endpoint or expose a daemon socket publicly.

A local-computer job may use a persistent service on that selected computer.
Factory-hosted jobs require a proven supported connection to their selected
computer. Neither may silently run in Spriite's checkout because it is nearby.
Phone disconnect must not dispose the provider connection or active handlers.

## 5. Input, workspace, and consequence contract

Proposed `ExecutionIntent` separates:

| Field group | Required information |
| --- | --- |
| Owner | Owner/account, full canonical words, source event, target task, dedupe key. |
| References | Product/source repository/URL, attribution, trust boundary, required versus optional context, missing context. |
| Operation | New implementation, integrate, clone/adapt, fork, inspect, or other explicit operation. |
| Destination | Existing immutable repository ID, or exact proposed account/name/visibility for creation. |
| Workspace | Computer/daemon identity, resolved cwd, physical checkout identity, selected branch/base and SHA, isolation mode. |
| Execution | Backend/provider consent, requested models/effort, effective settings, tools, autonomy and policy revision. |
| Consequences | Repository creation, remote publication/PR, deployment, merge, resource/cost limits. Each is separate authority. |
| Scope | Canonical goal, acceptance criteria, restrictions, exclusions, `scopeRevision` and content hash. |

Preflight:

1. Preserve full owner text. Fit only presentation; budget reference context
   separately. An essential missing boundary becomes a hold.
2. Resolve operation and destination. A third-party source URL is evidence,
   never authority to use that repository or the saved Spriite repository.
3. “Local only” selects execution location, not destination, repository creation,
   source-control publication, or permission to deploy.
4. Resolve repository account/ID/default branch with bounded complete discovery.
   Record the exact dispatched create name, including generated suffixes.
5. Resolve and verify physical cwd/checkout/base. Handle empty/new repositories,
   dirty user work, initialization, worktree lifecycle and cleanup separately.
6. Verify supported Mission settings, enterprise policy, readiness and budget.
   Show requested versus effective settings when they differ or are unknown.
7. Present a scope/consequence approval. Any substantive correction changes
   the scope revision and invalidates older approval, even if prefixed “yes,”
   “continue,” or “resume.”
8. Complete native planning. Bind the native proposal and start request to the
   current scope and consequences; local approval is not a native response.

An existing `startApproved` boolean from X is not sufficient native run approval.
Do not inherit High autonomy, a native proposal approval, or publishing authority
from it. Persist explicit grants and their exact scope/policy revision.

If native workers require High, either obtain that informed consent with real
restrictions enforced or keep the job held/use an explicitly chosen supported
ordinary-session backend. Never use `--skip-permissions-unsafe`.

## 6. Broker command and observation contracts

The following names are proposed **Spriite broker operations, not Factory RPCs**:

- `prepareNativeJob(intent)` returns a durable task/intent receipt, not “running.”
- `observeNativeJob(binding)` returns fresh observed state plus completeness.
- `submitOwnerTurn(binding, draft, expectedScopeRevision)` preserves the draft
  if the destination cannot accept it.
- `respondAttention(action)` binds the response to the actual native request.
- `requestControl(binding, action, expectedControlRevision)` records and
  reconciles pause/resume/end, without promising a stronger provider operation.
- `readEvents(afterBrokerSeq, limit)` exposes an owner-scoped sequenced feed.
- `acknowledgeProjection(cursor)` records consumption only after client commit.

### Proposed durable records

| Record | Essential fields and meaning |
| --- | --- |
| `ExecutionBinding` | Discriminated backend, owner/account, computer/daemon, immutable root session, provider Mission identity if separately available, resolved cwd/repository/base, protocol/version, creation command and exact outcome. |
| `ScopeRevision` | Full goal/criteria/restrictions/context references, destination/workspace, hash, author turn, revision. |
| `ApprovalGrant` | Owner, scope hash/revision, policy/settings revision, consequence set, native request/proposal binding, time/expiry; no generic yes boolean. |
| `NativeCommandRecord` | Command ID, owner, binding, request kind/hash, expected revisions, lease epoch, prepared/invoked/outcome, provider receipt and reconciliation evidence. |
| `AttentionRecord` | Local ID plus provider request/tool/session/machine identities, type, exact questions/options/confirmation payload, revision/hash, associated sessions, observed/open/resolved/uncertain state. |
| `AnswerDeliveryRecord` | Exact action and raw answer, request hash/revision, invocation and transport result, later resolution evidence; distinct from question closure. |
| `ObservationRecord` | Source, successful read/notification receipt, provider time if present, broker observed time/seq, state hash and completeness. |
| `MilestoneObservation` | Native feature/milestone identity, provider-reported status/success/validation, scope association, artifact/commit evidence, verification and invalidation. |
| `CheckpointObservation` | Material delta, native/broker/local refs, attention/control/freshness, projection receipt; not approval or accepted work. |
| `EvidenceRecord` | Repository ID, artifact kind/location, base/head SHA, verification source/time and exact criteria/report association. |
| `FinalizationRecord` | Native terminal observation, pending evidence/summary collection, read-only retry/deadline, observed delivery, explicit missing evidence. |

Device cache references broker records; it is not a second execution ledger.
Broker intent, command preparation, events and ownership updates must commit
atomically in its store before execution-affecting transport calls.

### Ordering and revision domains

Keep these separate:

- Owner scope revision/hash.
- Provider proposal revision/hash, when available; otherwise broker-derived
  version of the exact observed payload, labelled as such.
- Attention revision and raw payload hash.
- Control revision and lease/fencing epoch.
- Native progress identity/order, only if actually supplied.
- Broker committed sequence.
- Spriite local journal sequence.
- Briefing fixed target and covered event IDs.
- Git base/head SHA.

No SDK notification timestamp, local render sequence, or same text establishes
a globally unique provider event ID. Where there is no provider cursor, use a
broker sequence and state reconciliation. Report gaps; do not manufacture replay.

### Command outcome safety

```text
prepared -> invoked -> provider-confirmed
                    -> definitely-rejected
                    -> outcome-unknown -> reconciliation / explicit resolution
```

The local command ID deduplicates owner retries. It cannot prove a timed-out
provider call was not executed. Persist invocation before calling; persist
receipt after. If the broker loses contact between these points, hold.

Malformed success bodies, empty acknowledgments, response loss and write
timeouts are not automatically “safe to retry.” Confirmation of transport
delivery is not confirmation of native execution or attention closure.

Use a transactional per-binding lease and fencing epoch for concurrent broker
instances. Never execute with a stale lease. Fencing cannot recall an already
invoked provider operation; recovery must reconcile it.

Late resources from a launch concurrent with cancellation remain attached and
tracked. Do not release capacity or claim cancellation while their outcome is
unresolved. Keep reads, handoff and owner-visible uncertainty available.

## 7. Native lifecycle projected into Spriite

Factory's published Mission state enum is:

`planning`, `awaiting_input`, `initializing`, `running`, `paused`,
`orchestrator_turn`, `completed`.

It is not the current Spriite legacy phase machine. Proposed native local phases:

```text
intent_hold -> preflight -> planning -> proposal_pending
            -> initializing -> start_pending -> executing
            -> finalizing -> terminal
```

`validating` is an observed substate, not inferred from every worker completion.
Control, attention, freshness, delivery uncertainty, and execution outcome are
orthogonal. Add a versioned neutral phase model rather than inserting native
states into a legacy loop that starts workers.

| Observed native fact | Companion meaning |
| --- | --- |
| Planning | Planning; no build approval implied. |
| Awaiting input | Native agent awaits input; not proof of a specific question, finished plan, or readiness. |
| Proposal request | Plan review tied to the exact proposal and current owner scope. |
| Initializing | Native setup after proposal acceptance; not “workers running.” |
| Start request | Separate exact run-start decision, including offered native outcomes. |
| Running | Native runner reported active; attention and freshness still apply. |
| Paused | Native paused, possibly by user, billing, retry budget or scope growth. Display cause if supplied. |
| Orchestrator turn | Native orchestrator has control. Do not send legacy review/repair prompts. |
| Feature completed | Provider reports completion; inspect success/partial/failure and validation evidence. |
| Completed | Native reports all features done. Start read-only finalization, not PR/merge/deploy. |
| Connection gap | Last-known state; no implicit pause, completion, or restart. |

Published pause reasons include unrecoverable usage 402, feature retry-limit
exhaustion and scope-growth limit. “Resume” after such a pause can authorize new
attempts/costs. Surface cause and consequences instead of automatic resume.

Do not claim a native cancelled/failed state merely because the enum has no
such value. Local cancellation requires a proven stop/end contract and
reconciled workers; a failed read is connectivity, not execution failure.

## 8. Attention and owner-action routing

### Attention is not just a single decision string

Support a durable queue per task:

- Native AskUser with all questions and multi-select semantics.
- Command/tool permission.
- Native proposal/spec approval.
- Native run-start confirmation.
- Native pause/failure requiring owner action.
- Unsupported native attention with an exact Factory handoff.
- Scope/policy/destination clarification owned by Spriite.

One task can have multiple requests, including root and children. A permission
can be associated with several sessions. Deduplicate its canonical provider
identity while retaining every association and the owning machine. Do not fan
out answers merely because the same permission appeared in two views.

AskUser ownership must not be inferred from permission associations. Request
types have different routing and recovery semantics.

### Proposed action binding

```text
ActionBinding:
  ownerId, missionId, backend, bindingId
  attentionId, providerRequestId, owningMachineId, sessionId, toolUseIds
  expectedAttentionRevision, expectedPayloadHash
  questionIndex, rawOptionId/value or canonical answer
  expectedScopeRevision, expectedPolicyRevision
  localActionId, surfaceId
```

The display action ID resolves to this durable binding. A generic action label
such as `proceed`, `use_it`, or `talk` is not native authority.

Before sending, under the broker's serialized binding boundary:

1. Authenticate owner and verify destination/machine/session.
2. Verify exact request remains pending with matching payload/revision.
3. Verify scope, policy, control, expiry, consequence and offered outcome.
4. Persist the response command and raw payload.
5. Invoke the correct typed native response.
6. Record transport outcome without closing on optimistic UI feedback.
7. Observe matching native resolution or explicitly retain uncertainty.

A separate acknowledgement that the phone displayed the request is never
an answer. Opening history, switching tasks, dismissing a notice and briefing
acknowledgment do not answer anything.

### Full questionnaire fidelity

Persist raw question text, topic, index, multi-select flag, option labels and
raw values, selected values, and custom-answer rules. Fitted HUD labels remain
display-only. Two options with the same prefix must remain distinguishable.

Use the phone for full questionnaires, command details, plan review and
consequence-heavy confirmations. A glasses answer is supported only when it
can unambiguously bind the complete response. Otherwise offer Read/Open,
not a guessed single-choice response.

“Always allow” is a separate permission-policy grant. Never select it by default
or translate “yes” into it. Show only actual offered native outcomes.

### Voice, X and external answers

- Capture ownership includes mission/attention/revision and navigation/voice
  generation. Switching or exiting invalidates settlement.
- Background Talk first renders and focuses the requesting task, then captures.
- A question arriving during Send message cannot retarget the transcript.
  Retain the draft and ask for explicit rerouting when the destination changes.
- Ordinary owner messages cannot serve as native approval RPCs.
- X follow-ups pass the same broker barriers and preserve attributed context.
  No public X reply is implied by this design.
- An answer made directly in Factory resolves local attention only from native
  resolution or authoritative matching state, not from question disappearance
  in an incomplete history page.
- Identical replacement questions produce distinct notices by request identity.

## 9. Preserve the current format without false meaning

| Existing surface | Native projection | Required change |
| --- | --- | --- |
| Transcript and voice confirmation | Full canonical owner draft with fitted preview. | Capture/target revisions; never dispatch the fitted preview. |
| Plan / Read / Build | Native proposal details and explicit run-start gate. | Separate read, local scope grant, proposal acceptance and start confirmation. |
| Running | Native worker/feature/activity summary and last observation. | No “working” claim from stale heartbeat or historic messages. |
| Under review | Observed native validator activity. | Do not create Spriite reviewer sessions. |
| Repair / regression | Observed native rework/invalidated validation. | Do not send legacy repair prompts. |
| Decision / detail | Active request plus queue count and correct owner. | Request-bound actions and raw questionnaire data. |
| Accepted | Verified criterion/validation result. | Native feature completion alone is insufficient. |
| Paused / controls | Requested versus confirmed control with cause. | Backend-specific supported semantics. |
| Final | Native outcome plus verified artifacts and evidence limits. | No implied PR, publish, merge or deployment. |
| History | Chronological native/user/local material with identities. | Import user turns, request events, external resolution and gaps. |
| Background notice | One notice per newly observed request. | Request identity, target focus and suppression/read states separate. |
| Inbox / return briefing | Material native changes and unresolved requests. | Neutral records, new meaning mappings and production wiring. |

Current scenes allow at most three actions and four content lines through their
validators. Keep those budgets. Additional requests and details remain durable;
show counts and an explicit phone continuation rather than dropping them.

`SceneProgress` currently means accepted, un-invalidated reviewed weights
(`src/scenes/types.ts:72`). Do not fill it with “completed native features” or
elapsed time. Start with `progress: null` and truthful feature counts in text.
Enable weighted percentages only after native validation can be bound to a
frozen plan revision and accepted milestone evidence. Dynamic added/cancelled
features require a new denominator/revision, not silent percentage jumps.

Introduce proposed `MissionPresentation` for phase/control/freshness/attention,
activity, native feature counts, evidence, history and finalization. Implement
legacy and native adapters. Do not synthesize a fake `RealSnapshot`.

## 10. Checkpoint, delivery, reading, and briefing semantics

The companion format is reusable, but these are separate facts:

1. Native event observed.
2. Broker durably committed the event.
3. Client durably consumed it and emitted a domain checkpoint.
4. Renderer accepted a scene.
5. Surface transport reported delivery.
6. Owner explicitly acknowledged a briefing account.
7. Owner answered a request or accepted a specific validated outcome.

Neither steps 4–6 prove the owner read every item. None approves step 7.

### Material checkpoint triggers

- Exact proposal/start decision opened, changed, or resolved.
- Question/permission opened, externally resolved, expired or became uncertain.
- Meaningful native pause, failed worker/retry budget, billing or policy block.
- Scope/features materially changed.
- Validation evidence accepted/invalidated, with its source and commit.
- Pause/cancel requested versus confirmed.
- Completion observed, final evidence collected, or collection incomplete.
- Connectivity/history gap that changes confidence or required owner action.

Heartbeats and transient token/tool updates refresh liveness/activity when
appropriate, but are not automatically material briefing news.

`src/briefing/meaning.ts` treats unknown event types as noise. Add explicit
native meanings or emit semantically correct existing domain events. In
particular, native feature completion must not emit `milestone_accepted`
without validation evidence. Answer sent must not emit native request closed.

### Return briefing wiring is not already complete

The briefing builder, coverage ledger and Supervisor APIs exist. The team found
no production callers wiring `getBriefing`, `acknowledgeBriefing`, or
`cardsForSurface` into the current UI. Add that wiring deliberately; do not
claim the existing notification feed already supplies durable return briefings.

The glasses show three cards; the phone can show all. Acknowledging an
owner-wide account may settle a considered range beyond the three visible
cards. Show omissions and full-account access, or use explicit per-card/
mission coverage. Do not call a three-card transport receipt “all changes read.”

Keep fixed target sequences, exact covered event IDs, sparse mission coverage,
compaction-gap disclosure and unresolved attention reappearance. Briefing
acknowledgment does not clear the needs-you queue or change native authority.

## 11. Freshness, artifacts, and terminal finalization

Track separately:

- Provider-reported state and source time.
- Last successfully observed state, even if unchanged.
- Heartbeat observation and freshness budget.
- Failed/latest attempted observation.
- Local checkpoint and render time.
- Verified repository/artifact observations.

Restored cache is last-known until a successful new observation. A fresh
connection flag is not a fresh state read. A fresh idle report is not verified
completion, especially given the earlier recorded idle-during-execution behavior.

Bind artifact evidence to immutable repository ID, base/head SHA, branch,
native feature/scope revision and validation report. Verify PR owner/repo/base/
head/commit independently where applicable. A model's branch/PR assertion,
FINISHED string, PASS prose or same-repository URL is not delivery evidence.

Native terminal state enters bounded **read-only** finalization. Observe native
summary, validation reports, artifacts and outstanding workers/requests.
Persist finalization across restart; keep observation capacity until its
deadline or explicit incomplete result. Do not start a new summary-producing
turn, reviewer, PR or repair after cancellation/terminal status.

Delivery states distinguish “native completed,” “evidence verified,” “summary
not yet observed,” and “evidence collection incomplete.” Completion does not
authorize push, PR, merge, release or deployment.

## 12. Recovery, migration, retention and rollback

### Recovery

1. Decode all nested records; quarantine damage without reconstructing grants.
2. Acquire a current execution lease before any control/answer/turn.
3. Reattach to the original binding/computer/cwd. Defaults apply only to new jobs.
4. Reinstall handlers before accepting events/requests.
5. Obtain supported authoritative snapshot/pending-request state; identify gaps.
6. Reconcile invoked-unknown commands and externally resolved requests.
7. Rebuild projections; never replay queued legacy/native starts.
8. Resume execution only via a fresh supported owner-authorized control.

Pending in-memory handler promises are not durable provider requests. A persisted
Spriite attention record does not establish that its old RPC ID is still valid.
If the request cannot be recovered authoritatively, retain the draft and show
the exact supported Factory handoff/uncertainty. Do not resend an old response.

### Migration

Add a versioned backend discriminator, native bindings and neutral projections.
Migrate old records to **legacy ownership only** when that is established.
Unknown or damaged ownership is quarantined, not treated as native.

Do not migrate `approvedPlan`, `startApproved`, saved decision strings or a
watched chat into native proposal/start authority. A handoff to a new native job
requires an explicit new scope/backend/policy approval and unique launch.

Archive/import must preserve backend, binding/computer/account, scope and
approval provenance, attention/answer outcomes, cursors, evidence and finalization.
No default-main reconstruction, credential export or automatic execution on
import. Archived request IDs are history, not resurrected response handles.

### Retention and rollback

Never compact an active binding, open request, unknown command, finalization
record or dedupe tombstone still required for safety. Expose journal/history
gaps after bounded compaction. Broker retention is not the old watched receipt
store's 128-entry limit; size and recovery limits need independent qualification.

Rollback disables new native admissions, not observation/control of old native
tasks. Preserve the compatible broker/reader until they settle. Keep the legacy
reader and uncertain receipts. Do not restore an old binary that reinterprets
unknown native records as fresh legacy work.

## 13. File-by-file implementation boundary

All paths below are existing edit targets unless explicitly marked proposed.

| Area | Files | Change |
| --- | --- | --- |
| Neutral domain | `src/domain/types.ts`, `state.ts`, `events.ts` | Backend discriminator, versioned native binding/attention/command/evidence/finalization projections; robust nested decode and meaning. |
| Actor contract | Proposed `src/runtime/mission-actor.ts`, `native-mission.ts`, `mission-presentation.ts` | Common presentation/control interface; independent native observation/command actor and legacy adapter. Names are proposals. |
| Actor factory | `src/runtime/supervisor.ts`, `boot-plan.ts` | Choose by immutable backend; attach/reconcile native on boot; no legacy held-action/start replay on native tasks. |
| Client projection | `src/runtime/app-engine.ts`, `src/factory/engine.ts`, `copy.ts`, `response.ts` | Neutral snapshot/view access, exact background request identity, truthful capability/status/history copy. |
| Owner input | `src/main.ts`, `src/voice/turn.ts`, `intent.ts` | Lossless canonical capture, one target-validating action route, full-utterance commands, exit invalidation. |
| Intake/context | `src/intake/x.ts`, `src/context/gather.ts`, `src/factory/build-intent.ts`, `github.ts` | Structured operation/destination, attributed follow-up context, full repository discovery, no prefix approval/filtering. |
| Native adapter | Proposed broker transport modules outside device bundle | Pin SDK/daemon/CLI; typed exact native methods, bounded reads, effective settings, notification/request normalization, no invented RPCs. |
| Broker storage | Proposed persistent broker store and service | Transactional command/event/request ledger, owner auth, leases/fencing, reconciliation, retention. Existing relay is not sufficient. |
| Scene/phone | `src/scenes/types.ts`, `validate.ts`, `src/phone/app.ts`, `inbox.ts` | Keep budgets; request-bound actions, multiple attention detail, raw answers, requested versus confirmed control. |
| Renderer | `src/render/renderer.ts`, `chat-pages.ts` | Preserve transport/read distinction, lossless paged reading, neutral history speaker/identity. |
| Briefings | `src/briefing/build.ts`, `meaning.ts`, `receipts.ts` | Native event meanings, neutral evidence/final notes, actual surface wiring, omission/coverage semantics. |
| Device state/archive | `src/state/mission-store.ts`, `runtime-store.ts`, `phone-store.ts`, `store.ts`, `archive.ts`, `migrate-v1.ts` | Versioned cached projections, native-safe import/restore/rollback, no execution authority in stale records. |
| Legacy repairs | `src/factory/fapi.ts`, `real.ts`, receipt stores, `src/runtime/outbox.ts` | Keep fixing audit defects for retained tasks. Do not reuse legacy orchestration for native execution. |
| Qualification | Existing adapter/runtime/voice/briefing/settings/execution suites and new broker/native suites | Test production seams and durable outcomes; include all register dispositions below. |

Device code must not bundle the Node execution SDK or credentials. Native
Factory backend settings must not reinterpret Cursor models/providers as native
worker choices. Keep worker versus validator model slots distinct when supported.

## 14. Disposition of all 36 audited issues

“Retain/fix” means native execution does **not** remove the defect class.
“Retire native” means the legacy operation is absent on the new route; existing
tasks still need repair. “Verify” means capability evidence is required.

| ID | Disposition | Native design obligation |
| --- | --- | --- |
| I01 | Retain/fix | Separate reference, operation, destination and execution location; full New repo clarification. |
| I02 | Retain/fix | Background Talk focuses/renders exact requesting task before capture. |
| I03 | Retain/fix | Canonical voice transcript is never HUD-clipped. |
| I04 | Retain/fix | Whole-utterance control grammar, not status/progress substrings. |
| I05 | Retain/fix | Preserve owner restrictions and trust boundary independently of reference budget. |
| I06 | Retain/fix | Gather hyperlink-only context with explicit missing-context state. |
| I07 | Retain/fix | Attributed targeted follow-up context and frozen destination. |
| I08 | Retain/fix | Real private, targeted, freshness-labelled status answer. |
| I09 | Retain/fix | Complete/bounded repository discovery, no silent default on missing page. |
| I10 | Retain/fix | Substantive Continue/Resume restrictions stay in scope. |
| I11 | Retain/fix | Conditional approval revises scope instead of approving execution/publication. |
| I12 | Retain/fix | Exit invalidates capture and settling transcript ownership. |
| A01 | Retain/fix | Normalize supported native/tool-result dialects for retained watched/legacy paths. |
| A02 | Verify | Prove root/child permission, proposal/start and AskUser transport/recovery; exact owner routing. |
| A03 | Retain/fix | Complete request/history boundaries or explicit gaps and no fabricated closure. |
| A04 | Retain/fix | All surfaces use central exact-destination attention barriers. |
| A05 | Retain/fix | Send message race retains draft; never retargets to coordinator. |
| A06 | Verify | Cursor remains separate; prove its real blocked/answer contract or offer honest handoff. |
| A07 | Retain/fix | Reconcile externally answered requests without optimistic/incomplete-history closure. |
| A08 | Retain/fix | Raw answer values separated from display fitting. |
| A09 | Retain/fix | Import provider user turns chronologically with local-send dedupe. |
| A10 | Retain/fix | Decode/quarantine malformed nested native and legacy state. |
| A11 | Retain/fix | Request-identity notification dedupe, not question text. |
| A12 | Retain/fix | Bound transport calls and owning-generation latches; invoked timeout is uncertainty. |
| D01 | Retain/fix | Empty/malformed native/broker acknowledgment retains unknown outcome. |
| D02 | Retire native | No legacy planning/review/summary/resume turn loop; protect every remaining native command. |
| D03 | Retire native | No legacy coordinator dispatch after pause/cancel; native controls still need final barriers. |
| R01 | Retain/fix | Reconcile exact original repository-create identity. |
| R02 | Retain/fix | Bind machine/account/cwd for lifetime; future Setup defaults cannot move it. |
| R03 | Retain/fix | Verify repo/base/head/commit/artifact instead of model claims. |
| R04 | Retire native | No Spriite reviewer prompt; prove native validation receives approved criteria and restrictions. |
| R05 | Retain/fix | Successful observation freshness independent of local changes/restore. |
| R06 | Retain/fix | Reported idle is not accepted completion or proven readiness. |
| R07 | Retain/fix | Persistent read-only finalization survives actor retirement/restart. |
| R08 | Retire native | No legacy initial-plan Retry path; native unknown launch must not create a duplicate. |
| R09 | Retain/fix | Freeze/verify actual base branch and SHA, never hard-code main. |

Totals: **30 retain/fix, 4 retire on native path, 2 capability verification**.
Additional integration obligations are actor separation, neutral presentation,
multi-request attention, unhooked return-briefing surfaces, honest progress,
native-safe archives and broker ownership. They are architectural gaps, not a
claim that additional live failures were reproduced.

## 15. Implementation sequence and exit gates

1. **Contain retained-layer authority defects.** Permanent production-seam
   regressions for scope loss, conditional approval, wrong target, native
   result parsing and ambiguous acknowledgment. Expose unsupported attention.
2. **Prove the selected native transport.** Static contract fixtures first;
   then separately authorized isolated canary. Full gate includes request
   recovery and controls, not merely mode selection or a worker launch.
3. **Add neutral records/presentation and versioned restore.** Legacy behavior
   remains its own adapter. Archive/rollback tests precede native admission.
4. **Build broker ledger, policy and workspace preflight.** Transactional
   durability, authentication, fencing, invoked-unknown reconciliation.
5. **Add independent native actor and request-bound UI.** Zero legacy worker/
   reviewer/repair/integration dispatch on the native route.
6. **Connect checkpoints, history, evidence and return briefings.** Native
   events receive accurate meanings and fixed coverage, with visible gaps.
7. **Qualify and opt in privately.** Native admission remains disabled for
   unproven transports/policies. Upload/install/publication require new approval.

### Required qualification journeys

| Journey | Pass condition |
| --- | --- |
| Plexo/new repository/local execution | No silent Spriite destination; exact operation, workspace and separate creation/publication consent. |
| Native proposal then run-start | Each exact request handled separately; stale scope/proposal refuses start. |
| Root permission and child permission | Correct owning machine/tool identity; associated copies produce one answer. |
| Root and child AskUser | Full multi-question/multi-select/custom data, no cross-session answer. |
| Two tasks and identical questions | Navigation safe; each replacement request gets its own notice. |
| Voice/X correction and Send message race | Full restriction/context retained; zero wrong-destination sends. |
| Direct Factory answer | Local attention closes only on matching authoritative resolution. |
| Long history and event gaps | Required boundaries recovered or declared incomplete; no inferred authority. |
| Crash before/after command invocation | No duplicate launch, response, resume or creation; unknown outcome remains held. |
| Broker/phone disconnect during attention | Provider connection/handlers survive phone absence; broker restart recovery is proven or explicitly unavailable. |
| Concurrent controllers/broker instances | Lease/fencing and revision conflicts prevent competing execution; external answers reconcile. |
| Pause, resume, worker stop and end | Actual provider semantics observed; late workers/resources remain tracked; no false cancelled confirmation. |
| Usage/retry/scope-growth pause | Cause visible; resume requires appropriate fresh authority/cost consent. |
| Scope changes during execution | Added criteria/features invalidate prior acceptance as appropriate; no stale approve. |
| Settings/default computer change | Original binding and effective settings remain stable; no Cursor preference conversion. |
| Partial/failing feature and validator | No accepted checkpoint/percentage without criteria-bound evidence. |
| Completed with delayed/missing artifacts | Read-only finalization survives restart and labels incomplete delivery. |
| Archive corruption/import/rollback | No grant or start resurrection, no main/default binding substitution. |
| Briefing with more than three cards | Omission visible; account acknowledgment never means every request answered/read. |
| Policy, cost and credential boundaries | High autonomy does not grant unauthorized publication/deployment or unrelated checkout access. |

Run narrow native/broker and retained-layer suites first, then existing
qualification, copy checks, type checks/build and whitespace validation.
Simulator phone/glasses checks prove projection behavior, not native execution
or hardware background survival. Paid/native/hardware testing needs separate
authorization and independent evidence.

## 16. Validation of this map

Performed: source and official SDK static inspection, team synthesis, issue
coverage and document consistency/path checks. No SDK runtime, native canary,
production source changes, new simulator, full qualification or hardware test
was run for this documentation-only task. Previous release qualification does
not prove this integration works or the audit defects are fixed.

The remaining provider-specific contract evidence and runtime gates are recorded
in the appendix below. An exported type is not a promise of durable provider
acknowledgment, replay, exactly-once execution, or cross-machine compatibility.

## Appendix A. Exact published SDK contract map

All line references in this appendix are relative to the extracted SDK
`package/dist/` directory identified in section 2. They are static evidence,
not methods invented for Spriite or live-provider results.

### A1. Entry points and the selected adapter boundary

| Entry point | Established surface | Integration consequence |
| --- | --- | --- |
| Package root | Public re-exports include `DaemonSessionController`, Mission schemas/types, `connectToDaemon`, and daemon resource/session types. | A typed daemon integration is available; public export does not make every resource stable. |
| Connected daemon facade | `unstable.missions.inspectReadiness(cwd)` and `acknowledgeReadinessWarning(cwd)`. | Readiness only. No Mission launch handle or lifecycle CRUD is returned. |
| Package `/node` | `createSession`, `resumeSession`, `DroidSession`, `DroidClient`, subprocess/custom transports. | Mission mode can be passed through initialization; top-level convenience options are not a complete native Mission lifecycle. |
| Low-level `DroidClient` | `setPermissionHandler(event)`, `setAskUserHandler(event)` receive the full request envelope. | Preserve `event.id` and exact request parameters before awaiting owner response. |
| Convenience create/resume handlers | Wrapper calls the supplied handler with `event.params`, not `event`. | Envelope RPC ID is not directly present in this callback wrapper. Use a request-aware boundary rather than guessing identity from text/tool labels. |
| Session notifications and stream conversion | All six Mission notification families have conversion branches. | Mission events are not categorically dropped from the stream; retain raw envelopes for fields the conversion omits. |

Choose a broker-owned **typed daemon adapter** for the native design, subject to
version/runtime qualification. Keep its interface behind Spriite's proposed
command/observation contracts. Use the SDK for transport/schema compatibility,
not as Spriite's durable authority ledger.

Do not build the native route around `unstable.missions.start()`; no such method
was found. Do not mix `droid.*` subprocess request names with `daemon.*` names:
they belong to different typed transports.

Anchors:

- Root exports: `index.d.ts:1`, runtime `index.mjs:493-498`.
- Mission readiness facade: `index-C06W9tbN.d.ts:138056-138083`,
  `chunk-TWSTJMV7.mjs:25318-25329`.
- Node options/session methods: `node.d.ts:606-710`.
- Handler wrapper: `node.mjs:3296-3304`; low-level envelope handling:
  `node.mjs:2134-2344`.
- Stream Mission conversion: `chunk-TWSTJMV7.mjs:9804-9834`.

### A2. Initialization, planning, proposal and run start

The programmatic route supported by static contracts is:

```text
initialize a session in Mission mode with verified settings/workspace
  -> submit owner goal through the supported session turn interface
  -> observe native planning and exact propose_mission permission request
  -> explicitly answer one of that request's offered outcomes
  -> observe initializing/artifacts and exact start_mission_run request
  -> explicitly answer one of that request's offered outcomes
  -> observe native Mission state/progress/workers
```

This is a contract-derived route to qualify, not a claim the entire sequence
was exercised or every runtime necessarily follows this ordering.

Exact confirmation details:

| Confirmation `type` | Required fields | Optional fields |
| --- | --- | --- |
| `propose_mission` | `proposal: string` | `title: string` |
| `start_mission_run` | `runningMissionCount: number`, `runningMissionSessionIds: string[]` | None. |

The start payload does **not** carry a proposal revision, accepted scope hash,
workspace, cost cap, or unique run ID. Spriite must bind the request to its
original session and last independently observed approved scope/proposal.
Changed or incomplete observations block answering. The running-count fields
are useful capacity evidence, not a globally locked admission guarantee.

Permission request details:

- `toolUses[]` containing `toolUse`, `confirmationType`, and `details`.
- `options[]` containing exact `label` and `ToolConfirmationOutcome value`.
- Optional `associatedSessionIds[]`.
- Daemon requests also identify execution `sessionId`; envelope `id` identifies
  the RPC response correlation.

Do not infer a fixed Mission approval list from the global outcome enum.
Returned `options[]` is the authority for available choices. `proceed_edit`
requires `editedSpecContent` in the result schema, but its global existence
does not prove it is offered for a Mission proposal.

Actual response/control contracts:

| Operation | Actual wire contract | What it does not prove |
| --- | --- | --- |
| Readiness inspection | `daemon.inspect_mission_readiness`, `{cwd}`. | An approved plan or launch. |
| Readiness warning acknowledgement | `daemon.acknowledge_mission_readiness_warning`, `{cwd}` -> `{}`. | Persisted waiver/enforcement or run identity. |
| Permission answer | JSON-RPC response correlated by request ID; execution session, selected outcome, optional comment/edited spec. | Durable answer acceptance or Mission start. |
| AskUser answer | JSON-RPC response correlated by request ID; session and canonical answers/cancelled state. | Durable closure. |
| Interrupt | `daemon.interrupt_session`, `{sessionId}` -> `{}`. | Native Mission pause/cancel/end equivalence. |
| Kill worker | `daemon.kill_worker_session`, `{sessionId, workerSessionId}` -> `{}`. | Whole-Mission cancellation or successful feature completion. |
| Close session | `daemon.close_session`, session and optional preserve-empty-draft setting. | Mission completion/cancellation. |
| Load existing session | Typed load pathway with snapshot/pending requests. | A dedicated `resumeMission` operation or authority to restart work. |

No dedicated `proposeMission`, `startMission`, `pauseMission`, `resumeMission`,
`cancelMission`, or `endMission` client lifecycle methods/RPCs were found in
the inspected bundle. Native tool identifiers are not external client methods.
Mission pause/end UX must remain capability-labelled until actual supported
semantics are proved. A handoff is preferable to falsely claiming cancellation.

Anchors: confirmation fields `index-C06W9tbN.d.ts:128869-128894`;
request/result schemas `chunk-TWSTJMV7.mjs:3475-3489`, `:3525-3537`;
readiness RPC construction `:12868-12890`; session control RPCs `:11727-11752`;
controller control effects `:17895-17954`.

### A3. Wire snapshots versus SDK stores

Mission wire snapshot:

- Required: `state`, `features[]`, `progressLog[]`, `workerSessionIds[]`.
- Optional: `updatedAt`, `title`, `workingDirectory`, `workerStates`,
  `tokenUsage`, `tokenUsageBySessionId`.
- Worker state: `startedAt`, optional `completedAt` and `exitCode`.
- Load response optionally carries `mission` and `decompSessionType`.

Feature:

- Required: `id`, `description`, `status`, `skillName`,
  `preconditions: string[]`, `expectedBehavior: string[]`.
- Optional: `fulfills`, `milestone`, `workerSessionIds`,
  deprecated nullable `currentWorkerSessionId`, `completedWorkerSessionId`.
- Status values: `pending`, `in_progress`, `completed`, `cancelled`.

| Notification | Actual fields | Ingestion rule |
| --- | --- | --- |
| `mission_state_changed` | `state`, optional `updatedAt`. | Preserve provider time separately from receipt time. |
| `mission_features_changed` | `features[]`. | Replacement array, not an additive feature event. Diff against prior complete observation. |
| `mission_progress_entry` | `progressLog[]`. | Replacement log despite singular name. Do not append the entire array on every notification. |
| `mission_heartbeat` | `timestamp`. | Liveness evidence only; controller MissionStore handler is a no-op. |
| `mission_worker_started` | `workerSessionId`. | Notification has no start time; label any locally synthesized time as receipt/derived. |
| `mission_worker_completed` | `workerSessionId`, `exitCode`. | Not feature success, validation pass, Mission completion or artifact proof. |

The SDK's client MissionStore is a **projection**, not an authoritative fresh
snapshot:

- An unset store defaults to `awaiting_input`.
- It omits wire `updatedAt` and `workingDirectory`.
- Worker identities are unioned across observations.
- Worker timestamps may be synthesized locally.
- Aggregate token usage can be calculated from per-session usage.
- Mission state stream conversion also omits `updatedAt`.

Therefore retain authoritative wire snapshots/raw notifications and explicit
completeness/provenance alongside SDK presentation stores. Do not turn an empty
store, retained worker ID or locally synthesized timestamp into a fresh provider
fact. The observed load association uses orchestrator session ID as Mission
identity in that pathway; do not invent a separate universal Mission handle.

Anchors: schemas `chunk-TWSTJMV7.mjs:2567-2581`, `:3203-3227`,
`:4105-4188`; notification effects `:15779-15844`; store projection
`:19142-19217`; load association `:17717-17753`.

### A4. Progress and evidence fields

Each progress entry has `timestamp` and a variant `type`:

| Type | Additional required fields | Optional evidence/details |
| --- | --- | --- |
| `mission_accepted` | `title` | None. |
| `mission_paused` | None. | `pauseReason`. |
| `mission_resumed` | None. | `resumeWorkerSessionId`. |
| `mission_run_started` | None. | `message`. |
| `worker_started` | `workerSessionId`, `spawnId` | `featureId`, `modelId`, `substitutedFromModelId`. |
| `worker_selected_feature` | `workerSessionId`, `featureId` | None. |
| `worker_completed` | `workerSessionId`, `featureId`, `successState`, `returnToOrchestrator`, `exitCode` | `commitId`, `repoPath`, `validatorsPassed`, `handoff`. |
| `worker_failed` | `spawnId`, `reason` | `workerSessionId`, `exitCode`, `failureReason`. |
| `worker_paused` | `workerSessionId` | `featureId`. |
| `handoff_items_dismissed` | None. | `dismissals[]`. |
| `milestone_validation_triggered` | `milestone`, `featureId` | None. |

`successState` is `success`, `partial`, or `failure`. Blank commit/repository
strings normalize to absent. Handoff contains implementation/undone work,
verification, tests and discovered issues, with optional summary/skill feedback.

These are useful inputs to companion checkpoints and evidence verification,
not a substitute for independently checking commit identity and approved
criteria. `validatorsPassed` is optional; missing is not true.
`milestone_validation_triggered` establishes a trigger, not validation acceptance.

Anchor: `chunk-TWSTJMV7.mjs:2583-2735`.

### A5. Settings, readiness, policy and cost

Mission worker configuration exposes:

`workerModel`, `workerReasoningEffort`, `validationWorkerModel`,
`validationWorkerReasoningEffort`, `skipScrutiny`, `skipUserTesting`.

Defaults additionally expose orchestrator model/effort. Loaded session
settings include resolved model/effort and `availableAutonomyLevels`.
Actual worker-start entries may report model substitution due to organization
policy. Keep requested and actual settings separate and make substitutions
visible. Do not enable validation-skipping switches just to match legacy speed.

The `/node` convenience initializer forwards its documented selected fields;
it is not a generic spread of every lower-level Mission setting. Prove the
chosen daemon initialization/update/settings path for worker/validator slots.

Readiness returns `isGitRepo`, `hasRemote`, nullable `remoteUrl`, `isEmpty`,
and optional warning with state `ok`, `no_git`, `no_remote`, `no_report`,
or `low_score`, optional level 1–5 and repository URL. Warning shape alone
does not prove launch-blocking behavior or waiver durability.

Use returned available autonomy levels under managed policy, not all enum
members. Mode `mission` is not independently a High-autonomy grant.
Unsafe-skip/auto-reject flags in schemas do not establish effective worker
policy. Verify the documented execution requirement and enforce limitations
outside the model prompt.

Token usage may include `factoryCredits`, but this is observed usage, not a
guaranteed hard budget cap. Define admission/observation limits and prove any
provider-side budget enforcement before claiming a spending ceiling.

Anchors: `chunk-TWSTJMV7.mjs:3013-3019`, `:4064-4082`, `:6904-6937`,
`:8469-8510`, `:2808-2815`; `node.mjs:3325-3365`.

### A6. Answer delivery, replay and cross-machine ownership

Critical static findings:

1. Daemon permission/AskUser responses are **fire-and-forget** transport sends,
   not correlated request/acknowledgment exchanges.
2. Controller answer methods may resolve local prompts optimistically.
3. Permission answer buffering is globally keyed by `toolUseId`; AskUser
   buffering is keyed by session/tool-call identity.
4. Load returns optional pending permission/AskUser rows with request IDs.
   Replay can bind a buffered tool answer to a newly issued RPC ID.
5. Replay checks offered permission outcomes or AskUser question indices.
   It does not establish Spriite's full scope/payload/policy grant.
6. Buffered answers live in shared **in-memory Maps**, not proven disk storage.
7. Permission answers use the owning execution session, not merely the surface
   that displayed them. A non-associated surface is warned about, not rejected
   by this controller implementation.
8. External permission dispatch fans out UI requests only; the caller must
   route the response to the owning daemon.
9. For an inactive session, controller answer handling may buffer, clear the
   prompt, and automatically attempt `loadSession` three times, with 500/1,000 ms
   retry delays. That reload is not a dedicated Mission resume operation.

Broker obligations follow directly:

- Enforce owner/machine/session association before entering SDK methods.
- Keep its own disk-backed response/uncertainty ledger.
- Observe matching provider resolution and subsequent Mission state, not
  local SDK prompt disappearance or a resolved response promise.
- Revalidate full exact payload/scope/policy when a request ID changes.
  An offered outcome or matching question index alone is insufficient.
- Do not allow SDK buffered replay or inactive-session self-resume to bypass
  pause/cancel/terminal and fresh-approval barriers.
- Qualify a low-level, broker-controlled response/load path or demonstrate
  that all implicit SDK reactivation is safely contained. If neither is
  possible, inactive-session answering is unavailable and requires a handoff.
- Never treat associated surfaces as permission to send through the wrong
  machine or duplicate the response.

Anchors: fire-and-forget `chunk-TWSTJMV7.mjs:11312-11325`, `:13030-13036`;
controller response paths `:18654-18757`; restoration `:17469-17645`;
replay `:16296-16454`; resolution cleanup `:16080-16104`; inactive-session
reload `:18572-18625`; shared buffers `:23361-23441`, `:23690-23726`;
external fan-out/ownership `:18790-18798`, `:18865-18903`.

### A7. Stream/process lifetime and schema loss

Native notifications do pass through stream conversion. However, a prompt
stream is a **turn-scoped consumer**, not the permanent Mission event journal.
Keep a broker-owned raw notification subscription and authoritative re-load/
observation strategy between turns.

`streamFromClient` interrupts an unfinished turn when its consumer stops early,
its abort signal fires or sending fails. `run()` always closes the session when
it finishes; session close clears handlers, rejects pending requests and closes
the transport. Do not use one-shot `run()` as the Mission supervisor, or attach
phone disconnect/HTTP response lifetime to the provider abort signal.

Convenience notification callbacks swallow callback exceptions; incoming
unknown/malformed events can be logged and dropped. Use explicit ingestion
health and schema-drop diagnostics so silent loss cannot be labelled current.
Retain only safe diagnostics, not secrets or raw private prompts in logs.

Absent handlers cancel/decline rather than relay. Register handlers before
initialization/load and keep their owner-wait behavior independent of client
connectivity. Pending handler promise lifetime is not provider-request durability.

Anchors: stream interruption `chunk-TWSTJMV7.mjs:10107-10199`;
one-shot close `node.mjs:4042-4056`; session close `:3654-3673`;
client handler/close `:1726-1767`; callback exception handling `:1700-1709`;
event parse/drop `:2050-2132`.

### A8. Remaining runtime gate

Static typing now establishes much more than the basic guide, but these
capabilities still require separately authorized verification:

1. Version/entitlement-compatible Mission initialization and physical workspace.
2. Actual proposal and start outcomes, enforcement, edits and fresh scope binding.
3. Root versus native worker AskUser/permission propagation.
4. Cross-machine owner response routing and authoritative pending requests.
5. Answer-resolution correlation after response loss and full broker restart.
6. Replay/self-resume containment under pause/cancel/policy changes.
7. Effective model/autonomy/tool policy, substitutions and actual cost limits.
8. Real pause/resume/end/worker-kill behavior, including late resources.
9. Snapshot completeness, event replacement/order/gaps and recovery cursors.
10. Validation/artifact/final-summary observation without extra execution.

If a gate fails, mark that capability unavailable or hand off honestly.
Do not substitute a mode flag, readiness acknowledgement, optimistic cleared
prompt, or generated textual answer for the missing provider guarantee.
