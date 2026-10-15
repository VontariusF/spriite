# Mission mode over the Factory API: probe findings

> **Historical record (2026-10-11).** This documents a past run on the original developer's single macOS host and may name tools, paths or states that have since changed. For current setup see [NATIVE-BROKER-SETUP.md](NATIVE-BROKER-SETUP.md) and [SETUP.md](SETUP.md).

Probed 2026-10-11 to decide whether Spriite can offer Factory **Missions**
(plan, then Mission Control driving workers) as a session mode, by asking the
Public API for one directly.

> **Superseded for native execution.** The public HTTP API still does not run Missions, but Spriite now runs Factory Missions 2.0 natively through the broker on your Factory host; see [NATIVE-MISSION-V2-DESIGN.md](NATIVE-MISSION-V2-DESIGN.md) and [NATIVE-BROKER-SETUP.md](NATIVE-BROKER-SETUP.md).

Verdict: **no.** `interactionMode: "mission"` is accepted on create and then
ignored. Nothing in this release should offer Missions as a Spriite mode.

## What ran

- Script: `~/spriite-mission-probe/probe.mjs` (outside this repo).
- Computer: the owner's Droid Computer (id redacted).
- Repository: a private test repository, cloned locally.
- Create call: `POST /api/v0/sessions` with
  `sessionSettings: { interactionMode: "mission", autonomyLevel: "high" }` and a `cwd`.
- Task: add `tests/test_config.py` on a new branch `spriite/mission-probe`, run
  `pytest`, commit and push that branch, open no pull request.
- The script approved once, then interrupted after 8 steps or a 15 minute stall,
  with a 75 minute cap. It ran 143 seconds and hit the step interrupt.

Recorded calls: `scripts/fixtures/factory-session-probe.json`.

## Findings

### 1. `interactionMode` is accepted, then never echoed

Create answered 201. Every later `GET /api/v0/sessions/{id}` returned only
`sessionId`, `title`, `status`, `createdAt`, `updatedAt`, `computerId`,
`messageCount`, `factoryCredits`. No response ever reports the settings a
session is running with.

Spriite cannot read back what it set, so the phone has to remember the settings
it sent and show those. A settings screen can only be honest about intent, not
about what Factory adopted.

### 2. No Mission behavior appeared

There was no planning gate, no plan to approve, no child sessions
(`children: []`), and no workers. The session read the repo, wrote the file with
`ApplyPatch`, ran the suite, and updated todos — a normal session, one agent,
no fan-out.

`interactionMode: "mission"` over this endpoint is either ignored or needs a
surface the endpoint does not reach. A mission-shaped Spriite mode would be a
mode the API quietly does not honor.

### 3. `status` cannot be trusted

`status` read `idle` at every single poll while the session was plainly working:

| elapsed | messageCount | status |
| ------- | ------------ | ------ |
| 2 s     | 0            | idle   |
| 20 s    | 6            | idle   |
| 40 s    | 6            | idle   |
| 76 s    | 9            | idle   |
| 94 s    | 13           | idle   |
| 112 s   | 19           | idle   |
| 140 s   | 21           | idle   |

`POST /messages` answers `pending`, never `running`.

Any client that waits for `idle` before acting acts too early. The probe's one
approval went out at 25 s and arrived mid-work as steering — Factory replied "A
follow-up user message arrived while you were working. Treat it as steering."
This is the same failure class as the earlier "plan but no build" report, and it
is a reason Spriite must drive on `messageCount` deltas, never on `status`.

### 4. Interrupt is polite, not immediate

`POST /interrupt` returned 200 `{"status":"idle"}`, and the session produced two
more messages afterwards.

### 5. Cost

Credits went 34561 to 61957 in 143 seconds: roughly **17,400 credits to add one
test file**. The session ran `gpt-5.6-sol` at `reasoningEffort: "high"` — the
account defaults, since the probe set neither. Exposing model and reasoning
effort is therefore worth doing for cost control alone.

### 6. The task did not finish

The branch `spriite/mission-probe` existed with an untracked `tests/test_config.py`
when the interrupt landed; nothing was committed or pushed. The interrupt the
script chose (a step budget, not a stall) is what stopped it.

## What this means for Spriite

- Do not ship a Mission mode. The API ignores the field and Spriite has no way
  to confirm otherwise.
- Keep driving the HUD on message-count growth, as the runtime already does.
- A settings UI states intent, because Factory never reports back what it
  accepted.
- Model and reasoning effort are the settings with the clearest payoff: the
  default high-effort run above cost 17.4k credits for a one-file change.

## Reproducing

The probe lives outside the repo (`~/spriite-mission-probe/probe.mjs`) and needs
a Factory API key in `~/.spriite-probe.env`. It writes `out/events.jsonl` and
`out/summary.json`. Trimmed recorded responses are committed as
`scripts/fixtures/factory-session-probe.json` so tests can pin the shapes this
document describes without a live key.
