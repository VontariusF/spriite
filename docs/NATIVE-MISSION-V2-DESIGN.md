# Factory Mission v2 support (design contract)

Status: in progress, 2026-10-13 (droid 0.238 v2-agents added 2026-10-14). Native launch stays disabled. This contract
is shared by the broker, provider, record-reader and phone/runtime work.

## Observed protocol (droid 0.227.0, live canary + binary schemas)

SDK 0.9.1 (latest on npm) has no v2 types; the daemon sends them anyway.

Session settings carry tag `{ name: "mission-v2" }`. After plan approval the
tag gains `metadata: { planningApproved: "true", title, approvedAt }`.

Permission requests (`daemon.request_permission`, root session, one tool use):

- `recommend_mission`: details `{ type, reason }`. Options `proceed_once`
  ("Start Mission planning"-style label) and `cancel` ("Continue normally").
  Accepting creates `~/.factory/missionsV2/<rootSessionId>/` and returns
  `{ accepted, missionPath, checksPath, eventsPath }`.
- `exit_mission_planning`: details `{ type, missionPlan, validationStrategy?,
  checks: Check[], artifacts?: Artifact[], title }`. Options `proceed_once`
  ("Approve Mission") and `cancel` ("Request changes"). Approval both approves
  the plan and lets the run start in the same orchestrator turn. There is no
  `start_mission_run` step in v2.
  - `Check = { id, group, description, about?, kind?: verification|review|decision, how? }` (strict).
  - `Artifact = { id: /^[A-Za-z0-9][A-Za-z0-9._-]*$/, where, description?, identity? }` (strict).

Notifications (`daemon.session_notification`):

- `mission_v2_snapshot_changed`: `snapshot = { sessionId, title, approvedAt
  (ISO), latestEventNumber (int >= 0), planHash (sha256 hex), checksHash
  (sha256 hex), checkCounts: { total, met, unmet, waived } }` (strict). First
  emitted at approval with `latestEventNumber: 0`.
- `child_session_available`: `{ childSessionId, toolUseId, subagentType:
  "worker", description, timestamp }`. Workers are Task child sessions. The
  worker is finished when the root session receives `tool_result` with the same
  `toolUseId`. Child sessions also emit their own `droid_working_state_changed`.
- `agent_turn_completed`: `{ reason, turnId?, tokenUsage, ..., durationMs? }`.
  Observed `reason: "completed"`.
- `droid_working_state_changed`: `idle | thinking | streaming_assistant_message
  | waiting_for_tool_confirmation | executing_tool | compacting_conversation`.
- Not sent in v2: `mission_state_changed`, `mission_features_changed`,
  `mission_progress_entry`, `mission_worker_started/completed`, `propose_mission`,
  `start_mission_run`.

Durable record on the daemon host, `~/.factory/missionsV2/<rootSessionId>/`:
`mission.md` (plan; its sha256 equals `planHash`), `checks.json`
(`{ artifacts?, checks }`), `validation-strategy.md`, `events.jsonl` (one
event per line, e.g. `{ type: "checks_evaluated", data: { evaluations:
[{ checkId, outcome, summary, evidence?, artifactIdentities?, checkDefinition? }] },
eventNumber, recordedAt }`), `evidence/`.

The orchestrator in the canary used tools Read, Execute, TodoWrite, Script,
ApplyPatch, Glob, RecommendMission, ExitMissionPlanning and Task. It made the
git commit itself (through Script), not the worker.

## Mapping onto Spriite's existing checkpoint format

The phone protocol keeps its attention kinds. No new kind is added.

| v2 fact | Spriite projection |
|---|---|
| `recommend_mission` | attention `kind: 'permission'`, title "Plan as a Factory Mission", details = `reason` text, options exactly as offered |
| `exit_mission_planning` | attention `kind: 'proposal'`, title = details.title, details = plan text plus a check list, options exactly as offered; `proposalHash = hash(details)` |
| approval of that proposal | starts execution; no `start` attention will follow |
| `checks` of the approved plan | `features`: one per check, `id` = check id, `description`, `expectedBehavior` = `[how]` or `[]`, `milestone` = group |
| verified evaluations | feature status: none → `pending`, `met` → `completed`, `waived` → `cancelled`, `unmet` → `unmet` (new status value) |
| worker child sessions | `workerSessionIds`; progress entries for worker start/finish and check evaluations |
| derived state | see below |

Feature status `unmet` is the only protocol extension (broker validation and
phone decode/rendering). It must never be shown as done.

## Derived Mission state (pure function, broker-side)

Inputs: dialect, open root attention, plan approval observed, root working
state, last root `agent_turn_completed`, worker set (started/finished), latest
snapshot, verified record (or none).

- Before approval: `planning` while the root works, `awaiting_input` when a
  request is open or the root is idle.
- After approval: `running` while the root works or any worker is unfinished.
- After approval, root idle after `agent_turn_completed`, no open attention,
  all workers finished:
  - `completed` only if a verified record shows every check `met` or `waived`
    and it agrees with the latest snapshot's `checkCounts`;
  - otherwise `awaiting_input`.
- An interrupted turn maps to `paused` only if the reason value proves it.

Notification-derived state is never authoritative by itself; existing
completeness/pending-source holds stay in force.

## Dialect rules

A job's dialect is set once from the first decisive fact: `mission-v2`
settings tag or a v2 request type → `v2`; `propose_mission`,
`start_mission_run` or any v1 mission notification → `v1`. A fact from the
other dialect afterwards faults the provider (`sdk_mission_dialect_mixed`).
v1 behavior stays unchanged.

## Verified record reader

Read-only, host-local only (broker machine id equals the daemon machine id),
injected into the provider. It verifies `sha256(mission.md) === planHash`, the
checks hash against `checksHash`, that every check id in events exists, and
that `latestEventNumber` matches the last event. Any mismatch, missing file,
oversize file, symlink, or path outside the directory returns
`{ verified: false, reason }`, which leaves features/progress absent (gap).

Hash definitions (droid bundle, reproduced on the canary record):
`planHash = sha256(mission.md bytes)`, `checksHash = sha256(checks.json
utf8 text)`, `latestEventNumber = number of events`. The orchestrator may
rewrite `checks.json` after approval (artifact identities) and droid then
republishes the snapshot, so verification is always against the latest
snapshot. Check ids that differ from the approved plan's checks are a hold,
not a silent replacement. Outcomes: `met | unmet | waived`; the only event type
is `checks_evaluated`; latest evaluation per check wins.

## droid 0.238 (v2-agents)

Observed live 2026-10-14 against droid 0.238.0 (evidence trimmed into
`scripts/fixtures/mission-v2-agents/`). Missions 2.0 changed shape; the 0.227
contract above stays implemented as dialect `v2` and is unchanged.

Protocol facts:

- `interactionMode: "mission"` alone no longer enters Missions 2.0. Entry is a
  session tag: `initialize_session` accepts `tags`, and `tags: [{ name:
  "mission-v2" }]` returns `settings.tags = [{ name: "mission-v2", metadata:
  { kind: "orchestrator", missionId: <rootSessionId> } }]`. After the first turn
  droid adds `metadata.spaceId` through `settings_updated`. Tag schema:
  `{ kind: "orchestrator" | "agent", missionId }`.
- No plan approval: no `recommend_mission`, `exit_mission_planning`,
  `checks_evaluated`, `mission_v2_snapshot_changed`, and no
  `~/.factory/missionsV2/<id>/` record.
- Workers are agents driven by root tools, seen only as root `create_message`
  tool uses and root `tool_result`s: `SpawnAgent { title, prompt, target? }` →
  `{ "sessionId" }`; `ListAgents {}` → `{ "agents": [{ sessionId, title, status:
  idle | pending | running | null, waitingOn: permission | ask-user | unknown |
  null, createdAt, updatedAt }] }`; `SendMessage { sessionId, message }`;
  `InterruptAgent { sessionId }`. Agent reports arrive in the root as `user`
  messages and start the orchestrator's next turn. There is no
  `child_session_available` and no agent-session traffic on our connection.
- Root lifecycle: `droid_working_state_changed`, `agent_turn_completed
  { reason: "completed", turnId }`. Droid itself treats a completed orchestrator
  turn as Mission attention `awaiting_input`.
- Other 0.238 tools: `ProposeWorkstream` (permission-gated), `DismissHandoffItems`,
  `EndFeatureRun`.

Broker contract:

- Compiled initialize params always carry `tags: [{ name: "mission-v2" }]`
  (part of the hashed request; `outgoingDescriptor` refuses any other tag set).
  No new RPC is opened. Provider records written before this stay valid
  without `tags`.
- Tool fence: `requireMissionV2Tools` accepts either the 0.227 set
  (RecommendMission, ExitMissionPlanning, Task, Script) or the 0.238 set
  (SpawnAgent, SendMessage, ListAgents, InterruptAgent; Task/Script optional).
- Dialect adoption: a `mission-v2` tag whose metadata has `kind` is a
  `v2-agents` fact (initialize result or root `settings_updated`); it must be
  `kind: "orchestrator"` with `missionId === rootSessionId`, else
  `sdk_mission_v2_tag_mismatch` (initialize: unknown-outcome hold). A tag
  without `kind`, a v2 request type or a snapshot is `v2`; v1 facts are `v1`;
  any mix is `sdk_mission_dialect_mixed`. Metadata growth (spaceId) is ignored;
  a root `settings_updated` that carries `tags` without the orchestrator tag
  (lost, kind or missionId changed) faults `sdk_mission_v2_tag_changed`.
- Agent tracking (`missionV2Agents` in the provider record): SpawnAgent and
  ListAgents tool uses from root assistant messages are matched to their root
  `tool_result`. A spawned agent is `running` until a ListAgents result says
  otherwise; unrecognised statuses become `unknown`. Malformed or error results
  are ignored, never a fault. At most 200 agents (more blocks completion).
- Projection: one feature per agent (`id` = agent session id, `description` =
  title or `Agent <id8>`): running → `in_progress`, pending/null/unknown →
  `pending`, idle → `completed` (`in_progress` while `waitingOn` is set).
  `workerSessionIds` = agent ids. Progress rows: `agent_spawned`,
  `agent_status`, `orchestrator_turn_completed`, `mission_completed`,
  `activity_after_completion { count }`.
- Derived state: open root attention → `awaiting_input`; root not idle →
  `running`; a current `completed` orchestrator turn with the root idle, no
  open attention, at least one known agent, every agent `idle` and waiting on
  nothing, and no root activity for the settle window (default 90 s,
  `missionV2AgentsSettleMs`) → `completed`; anything else → `awaiting_input`.
  Root activity = non-idle working state, root message, root tool result or root
  request. Only a live, unfenced provider may newly derive `completed`, and it
  latches and persists it; restored providers and the broker envelope path only
  report a latched completion. Late root activity after the latch is counted as
  progress only; the job never regresses (no `terminal_state_regression`).
- No durable record exists: the record reader is never consulted and read
  diagnostics report `missionRecord: "mission_v2_agents_no_durable_record"`.
- Unknown permission types (e.g. ProposeWorkstream) stay
  `sdk_confirmation_handoff`.
- droid gating reasons map to named faults: `missions_v2_disabled`,
  `missions_v2_access_restricted`, `missions_v2_access_unavailable`,
  `mission_v2_session_not_active`, `mission_v2_legacy_mission_active` →
  `sdk_<reason>`. On initialize/goal RPC errors the step `fault` carries the
  code (the outcome stays unknown and held); on a root tool error the provider
  fences with that code.

Launch gating, holds, qualification, capability and credential isolation are
unchanged for both dialects.

## Out of scope

Child-session (worker) permission prompts stay `sdk_child_attention_unqualified`.
Follow-up owner turns after `completed` stay a terminal-regression hold.
Native launch, signed host evidence and billing interception are unchanged.
