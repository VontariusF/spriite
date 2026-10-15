# Development

[Back to the README](../README.md) · [Contributing](../CONTRIBUTING.md) · [X intake handoff](X-INTAKE-HANDOFF.md)

```bash
npm run dev            # dev server with the Factory and Cursor proxy
npm run sim            # Even G2 simulator, automation API on :9898
npm run test:real      # real engine against fake workers (plan, split, review, PR); no credits spent
npm run test:store     # durable store: crash recovery, single writer, event window, migration
npm run test:runtime   # supervisor, mission actors, scheduler, outbox (no network)
npm run test:briefing  # return briefings, coverage receipts, phone inbox projection
npm run test:sprite    # 17-pose vocabulary, snapshot fixtures, pose resolver, animator transport rules
npm run test:x         # owner X intake: binding gates, spoof matrix, dedupe/edits/deletes, 24h window, catch-up gaps
npm run test:settings  # Factory session settings: create body, lead/worker/advanced prefs, frozen per build, setup panel
npm run test:voice-turn # capture ownership, focus changes, and late transcript/error races
npm run test:history   # saved builds/activity: read outages, write acknowledgments, and concurrent saves
npm run test:followups # targeted X delivery: crash recovery, send claims, ambiguity, resend/dismiss
npm run test:dev-fake  # actual simulator provider: token protocols, repositories, branches, and reload detection
npm run test:factory-adapter # actual HTTP adapter: protocol newlines and honest acknowledgments
npm run test:execution-boundary # production clients with synthetic HTTP: dispatch, worker answers, and truthful progress
npm run test:response-reading # full replies, Unicode/long tokens, six-line pages, latest-reply opening
npm run test:live-x-probe # offline checks of the opt-in read-only probe, no credentials/network
npm run test:app-engine # the app's engine surface over the durable runtime: durable command, focus, home list, relaunch, launch/rollback matrix
node scripts/sprite-fixtures.mjs  # regenerate scripts/fixtures/sprite-poses.json + shots/sprite-poses.png after a frame change
npm run sim:offline    # legacy engine (?flags=-persistent_runtime_v2) against a fake Factory whose computer is offline (also sim:blocked, sim:newrepo)
npm run sim:runtime    # simulator with the durable runtime on (?flags=persistent_runtime_v2), automation API on :9903
npm run walk:real -- 9899 offline   # drives that variant end to end, saves shots/r-*
npm run walk:runtime   # drives the durable runtime path (port 9903), saves shots/rt-*
npm run qualify        # every suite + coverage map; --sim also runs the three walkthroughs
npm run check:copy     # every glasses string fits its pixel budget
npm run pack           # copy check + build + .ehpk (needs your relay; see SETUP.md step 3)
npm run relay          # run the relay with Node (for testing it, or for self-hosting)
```

An explicit live X probe uses the production transport without its refresh hook:

```sh
npm run check:x-live -- /absolute/private/x-token.json OWNER_ID MENTION_HANDLE
```

It makes at most four GETs, caps the timeline at five posts from the last day,
and stops on authentication/credit failures or an owner mismatch. It does not
dispatch builds, alter the token file, renew tokens, or print tokens/post text.
This checks the direct API, not a deployed relay. Use an owner-only JSON file
outside the repository; never put a token value in a shell argument.

Add `?fresh=1` to the dev URL to ignore saved state.

### Feature flags

Five release flags live in `src/state/flags.ts`. `persistent_runtime_v2` defaults
on; the rest default off. They resolve
from the phone's stored preferences plus a dev-only `?flags=` override
(`?flags=persistent_runtime_v2,-return_briefings`). `return_briefings` and
`x_owner_intake` require `persistent_runtime_v2`; asking for them alone gets
them turned off, because intake and briefings need the durable receipt path.

`persistent_runtime_v2` is wired: the launch plan in
`src/runtime/boot-plan.ts` decides whether the durable runtime or the legacy
engine runs, and a phone that has durable records never hands them back to the
legacy engine as a resume source. It is on unless the owner turns it off with
the "Durable runtime (beta)" switch in the phone's Setup preferences (a stored
choice wins over the default); a change takes effect on the next launch, because switching the engine under a live mission would leave two
orchestrators claiming the same provider work. The remaining flags gate optional
behavior; UI wiring does not establish live or hardware qualification.
What has and has not been proven is in
[QUALIFICATION.md](QUALIFICATION.md); the X wiring checklist and the live test
are in [X-INTAKE-HANDOFF.md](X-INTAKE-HANDOFF.md).

### Layout

| Path | Role |
|---|---|
| `src/factory/engine.ts` | The engine interface both engines implement |
| `src/factory/real.ts` | Real engine: lead-session protocol (plan, VERDICT, DECISION, SUMMARY), workers, milestones, steering, cloud builds |
| `src/factory/view.ts` | The view type every engine emits (scene or selection list) |
| `src/factory/fapi.ts`, `cursor.ts`, `github.ts` | Factory, Cursor, and GitHub API clients |
| `src/factory/copy.ts` | Every string shown on the glasses |
| `src/scenes/` | Device-neutral scene contract and validation |
| `src/probe/` | Storage capability probe (phase 0 evidence, `?probe=storage`) |
| `src/domain/` | Schema-v2 durable model: missions, events, decisions, briefings, command envelopes |
| `src/runtime/` | Durable runtime: supervisor, mission actors, dispatch outbox, scheduler, the app adapter (`app-engine.ts`), and the launch/rollback plan (`boot-plan.ts`) |
| `src/briefing/` | Return briefings (§16): builder, meaning rules, coverage receipts |
| `src/intake/` | Owner-only X intake (§11): read-only X API client with one-renewal OAuth token refresh, trigger authorization, dedupe, routing, checkpoint catch-up |
| `src/context/` | Bounded request-context capture (§12): thread and quote artifacts with provenance, hashes, and trust labels |
| `src/state/mission-store.ts` | Crash-consistent commit layer over the companion-app KV |
| `src/voice/` | ElevenLabs realtime transcription, wake phrase and command grammar, key vault |
| `src/state/` | Preferences, recent missions, background snapshots |
| `src/phone/`, `src/setup/` | Phone companion: Now and Setup tabs, shared theme, inbox projection |
| `src/sprite/` | The pixel companion: layered frames, a coalescing animator (one transfer in flight, reduce motion), and the pure pose resolver |
| `src/bridge/`, `src/render/`, `src/input/`, `src/audio/` | Device adapter (Even Hub today) |
| `relay/` | Your relay: a Cloudflare Worker (default) that also runs under Node |
| `scripts/` | Packer, copy budget checker, sprite contact sheet, simulator walkthrough, engine and X intake tests |


## Porting to another device

The mission engine, scene contract, and phone companion stay shared. Replace the adapter in `src/bridge/`, `src/render/`, `src/input/`, and `src/audio/talk.ts`. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the adapter contract and checks.

