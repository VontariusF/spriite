# Native broker (private, fail-closed)

Each person runs their own broker on **their own Factory host**: the machine
where Factory's `droid` is installed and signed in, and where this broker runs
beside it. That can be a Linux server or VPS, a home server, or a macOS machine. Windows
is not supported (the broker relies on POSIX permissions, signals and paths).
Nothing here assumes a particular user, home path, account or network; every
path comes from configuration or from that host's `PATH`. To install it on any
Factory host, see [Install on any Factory host](../docs/NATIVE-BROKER-SETUP.md).

Independent Node 22+ package. Nothing in `src/`, the relay, or the glasses bundle
imports this package or the optional execution SDK. The wire DTOs are exactly
`../src/native/protocol.ts`; broker operation names are **not Factory RPCs**.


## Pairing and host X sign-in

`npx spriite pair` (the `cli/` package; `npm run pair` from a checkout until it is published)
installs or starts this broker through `scripts/install-native-broker.sh --non-interactive
--summary`, then sends its URL, bearer token, owner and machine ids to the phone inside a
PAKE-encrypted bundle (`pair-protocol.mjs`, CPace over ristretto255; see
[`docs/design/PAIRING-PROTOCOL.md`](../docs/design/PAIRING-PROTOCOL.md)). The broker itself never
imports the pairing code.

`x-signin.mjs` runs X's OAuth 2.0 PKCE flow on this host: `POST /v1/native/x/signin`
(`{ clientId? }`, else `SPRIITE_X_CLIENT_ID`) opens the system browser (`open` / `xdg-open`) with an
S256 challenge and a state, the redirect lands on `http://127.0.0.1:47823/x/callback`
(`SPRIITE_X_SIGNIN_PORT`), and the token exchange happens here. `GET /v1/native/x/signin` reports
`idle | pending | connected | failed | unavailable`, never a token. With an enabled reader
configuration the pair goes to the existing `x-credential.json` store and the reader resumes on
it; otherwise it is held in memory only, and the phone's next `POST /v1/native/x/handoff` without
tokens (its reader settings) completes the handoff with it. Both routes need the bearer and are in
the CORS preflight list.
## Status and launch gate

The durable broker/router/store and injected-transport seams work offline.
**No live Native Mission is qualified or launched by default.** The standalone
server defaults to `unavailableTransport`: all capabilities are false and
approved intents remain durably held. `SPRIITE_NATIVE_ENABLE_HOST=1` selects the
explicit host composition, NOT launch qualification or execution authority.

`native-host.mjs` is the real host boundary: it provisions a never-reused job
root under `<host root>/jobs/<missionId>` (mode 0700; the host root is
`SPRIITE_NATIVE_HOST_ROOT`, which the installer sets to `<broker dir>/host`; the
library default is `~/.spriite-native`, and the host key and evidence live there
too), clones with the
broker's credentials and strips them, starts a dedicated `droid daemon` per job
under whole-process sandbox settings (writes allowed only in the job work tree,
owner secrets and the host key/evidence/API key denied, no network domains),
live-probes containment, and signs physical-workspace/verified-revocation
evidence with the host ed25519 key. **Credential isolation is not proven:**
the daemon's `FACTORY_API_KEY` can be read by agent code and a sensitive-path
denylist does not protect arbitrary owner files. Admission retains
`native_credential_isolation_unproven`, and the host refuses to issue a lease
covering that dimension. The delivery diff secret gate is defense-in-depth,
not isolation evidence. A broker opened with `host` plus a verified
`loadHostQualification` record lifts only the live-qualification and lease
holds; everything else stays held exactly as before. Without a host, any
delivery consequence stays refused with `native_delivery_unavailable`.

`sdk-adapter.ts` is an optional, explicitly lazy, version-checked
`@factory/droid-sdk@0.9.1` boundary. Its methods use the published low-level
`DaemonClient.inspectMissionReadiness`, `onMessage`, `sendPermissionResponse` and
`sendAskUserResponse`; response types derive from those method signatures, with
the published `RequestPermissionResultSchema` / `AskUserResultSchema`.
It does not connect/authenticate, initialize sessions, invoke `run`, use
`DaemonSessionController`, load/reload sessions, buffer answers, or replay them.
No SDK is needed by the offline tests. No SDK installation was performed.

The optional adapter truthfully advertises launch, authoritative read/recovery,
attention, pause, resume, and cancellation as **unavailable**. Typed response
sends alone cannot qualify request recovery or a Mission lifecycle.
Readiness is not a proposal/start approval; `unstable.missions` provides readiness
only. Native proposal and start are separate pending permission requests.

Admission requires all of:

- A host-provisioned Ed25519-signed manifest and host-supplied public key.
  Exact owner, machine, transport version, issuance/expiry, every gate in
  `QUALIFICATION_GATES`, signed evidence SHA-256s and bounded evidence files.
  The manifest is never an HTTP input. No production manifest/key is shipped.
- Implemented transport support, including root/child attention and recovery.
  A signed manifest cannot make missing adapter behavior work. Whole-Mission
  pause/resume/cancel remain false in this implementation.
- Frozen full intent with separate explicit scope and High-autonomy consent,
  exact selected machine/cwd/repository/base SHA, explicit existing destination,
  orchestrator/worker/validator settings, and enabled validation.
- Read-only preflight evidence matching the exact workspace, scope hash, policy
  hash and effective settings; available High autonomy, destination verification,
  readiness and effective policy. An intent-level budget additionally requires
  actual budget enforcement (`budgetEnforced: true`); without an intent budget
  the provider must report honestly (`budgetEnforced: false`,
  `usageReporting: 'next_day_unenforced'`). A model prompt is not policy
  enforcement. **Owner decision: the host does not cap spend.** Budgeted
  intents therefore remain held (`native_budget_enforcement_unavailable`);
  usage is reported next day from Factory Analytics, never enforced live.

Consequence intents remain mediated: new repositories must be private and
empty (`native_new_repository_must_be_private`). `NATIVE_NEW_REPOSITORY_BASE`
is a prospective placeholder only, never signed physical-workspace proof.
New/adopted empty repositories hold with
`native_new_repository_initialization_unqualified` before creation, clone,
commit or push. A predetermined seed commit cannot be produced using arbitrary
configured owner identity without changing that identity; no identity override
or implicit initialization of an adopted repository is performed.
Push/PR/merge run after completion and read-only
finalization, performed by the broker outside the sandbox; the agent never
holds GitHub credentials. Delivery persists a resumable `DeliveryState`;
terminal steps are `checks_failed`, `merged`, `not_merged`; policy/security
`held` states are final, but explicit interrupted/resumable `held` states retry
with complete validated input, a persisted 30-second cooldown, and at most eight
attempts. Exhaustion remains visible as owner-recovery-required. Policy-limited
`pushed`/`pr_open` states are final as well. Clone,
fork, non-empty initialization and deploy remain refused
(`native_provisioning_or_publication_unavailable`,
`native_deploy_unavailable`). Without a host, all of the above stays held. No
silent saved repository, publication, deployment, shell, or SDK RPC HTTP route
exists.

Offline fixtures generate ephemeral signing keys and synthetic transports
labelled `offline-fixture/v1`; their evidence explicitly says **not live
qualification**. Fixture flags are not production qualification.

## Exports and host startup

`index.mjs` / `index.d.ts` export:

- `NativeBroker`, `unavailableTransport`
- `FileStore`, `recoverDeadWriter`
- `createRouter`, `startBrokerServer`, `startFromEnv`
- `BrokerError`
- `NATIVE_RESPONSE_MAX_BYTES` (1,048,576), `NATIVE_MAX_OUTSTANDING_READS` (8)
- `loadQualification`, `unavailableCapabilities`, `QUALIFICATION_GATES`
- `loadHostQualification`, `verifyHostQualification`, `isHostQualificationFor`,
  `HOST_QUALIFICATION_CHECKS`, `publicKeySha256`
- `createNativeHost`, `createHostRoutedTransport`, `createNativeUsageClient`,
  `loadOrCreateHostKey`, `NATIVE_HOST_ROOT`, `NATIVE_HOST_DIMENSIONS`,
  `NATIVE_NEW_REPOSITORY_BASE`

`NativeBroker.open({directory, ownerId, machineId, bearerToken?, transport?,
qualificationPath?, qualificationPublicKey?, host?, delivery?, usage?,
deploymentDigest?, hostQualification?, hostQualificationPath?,
hostQualificationPublicKey?, timeoutMs?, now?})` opens the store.
`prepare`, `observe`, `command`, `capabilities` implement `NativeBrokerClient`.
`project` is a last-known local read; `readEvents(ownerId, after, limit)` is an
owner-scoped internal event feed (not an extra public HTTP route).
`ingestObservation` and `ingestNotification` are trusted adapter boundaries,
never public mutation routes. `startObservationLoop({intervalMs:5000})` owns
bounded read-only polling independently of clients; `close()` fences callbacks
and closes storage. Production server shutdown uses `await shutdown()` to revoke
host daemons before closing storage.

Host configuration for `node broker/server.mjs` (run from the repository root
on your Factory host):

| Environment | Requirement/default |
| --- | --- |
| `SPRIITE_NATIVE_OWNER_ID` | Required configured owner |
| `SPRIITE_NATIVE_MACHINE_ID` | Required selected machine |
| `SPRIITE_NATIVE_STORE_DIR` | Required absolute canonical physical path on a local filesystem |
| `SPRIITE_NATIVE_BEARER_TOKEN` | Required host-only token, >=32 bytes, token-safe characters |
| `SPRIITE_NATIVE_HOST` | `127.0.0.1`; only literal `127.0.0.1` or `::1` accepted |
| `SPRIITE_NATIVE_PORT` | `0` (OS-selected loopback port), never implicitly production port |
| `SPRIITE_NATIVE_ENABLE_HOST` | Only `1` opts into `host-production.mjs`; absent/default stays read-only |
| `SPRIITE_NATIVE_HOST_ROOT` | Required absolute private host root when opted in |
| `SPRIITE_NATIVE_DEPLOYMENT_DIGEST` | Required audited deployment SHA-256 when opted in |
| `SPRIITE_NATIVE_FACTORY_KEY_FILE` | Required absolute protected API-key file when opted in |
| `SPRIITE_NATIVE_EXTENSION_TOKEN_FILE` | Required absolute protected initialization-token file when opted in |
| `SPRIITE_NATIVE_DROID_PATH` | Absolute `droid` executable; default: first `droid` on the broker's `PATH` |
| `SPRIITE_NATIVE_ALLOWED_MODEL_IDS`, `SPRIITE_NATIVE_ALLOWED_TOOL_IDS` | Required nonempty JSON string arrays when opted in |
| `SPRIITE_NATIVE_GH_PATH`, `SPRIITE_NATIVE_GIT_PATH` | Absolute `gh` / `git`; default: first match on the broker's `PATH`; runners are constructed, not invoked at startup |
| `SPRIITE_NATIVE_QUALIFICATION_PATH`, `SPRIITE_NATIVE_HOST_QUALIFICATION_PATH` | Optional genuine signed qualification records; cannot qualify missing controls |
| `SPRIITE_NATIVE_TRUSTED_HOST` | Only `1` (with `ENABLE_HOST=1`) turns on the owner-trusted host mode below; absent/default keeps every hold |
| `SPRIITE_NATIVE_ALLOWED_ORIGINS` | Comma-separated exact browser origins allowed by CORS, `null`, or `*` for any origin; empty allows none. The installer writes `*`, because the Even app's WebView origin is host-defined and the bearer token is the auth gate. Each refused origin is logged once to stderr |
| `SPRIITE_NATIVE_RECOVER_DEAD_WRITER` | `0` turns off the startup release of a store lock left by an exited broker process on this host (default on) |

### Tool resolution and daemon PATH

With `SPRIITE_NATIVE_ENABLE_HOST=1`, `droid`, `gh` and `git` are each taken from
their `SPRIITE_NATIVE_*_PATH` override when set, otherwise from the first
absolute directory on the broker's own `PATH` that holds an executable of that
name (`resolveHostTool` in `host-production.mjs`; relative `PATH` entries are
ignored). A tool that can't be found refuses startup with
`native_host_binary_missing:<tool>` (for example `native_host_binary_missing:gh`),
which the server prints. A service manager (systemd, launchd) usually starts
with a minimal `PATH`, so either set the overrides or give the service a `PATH`
that includes where `droid` was installed (often `~/.local/bin`).

The deployment digest binds each tool's resolved real path and SHA-256, so an
upgraded or different `droid`/`gh`/`git` needs a new digest. The daemon gets
its own `PATH`, never the broker's: the resolved tool directories and the
directory of the broker's own Node (so Missions can run `node`, `npm` and `npx`
when Node comes from nvm, fnm, volta or asdf) first, then
`/opt/homebrew/bin` and `/home/linuxbrew/.linuxbrew/bin` only if they exist,
then `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` (`composeDaemonPath`).

### Platform notes (Linux and macOS)

- **Paths must be canonical.** The store, host root and secret files are
  refused when their real path differs from the configured one. On macOS use
  `/private/var/...` rather than `/var/...`; on Linux avoid symlinked homes or
  mounts. Temporary checkouts use the real path of `os.tmpdir()`, never a
  hardcoded `/tmp`.
- **Local filesystem only.** Durable writes fsync files and their directory;
  the store, host root and secrets must live on a local filesystem (ext4, xfs,
  btrfs, APFS). Network filesystems are unsupported.
- **Ownership and modes.** Secret files must be owned by the broker's user,
  mode `0600`, single-link and not symlinks (`O_NOFOLLOW`); the store and host
  root must be private (`0700`). Run the broker as the user that owns these
  files and runs `droid`.
- **Process checks.** Restart recovery identifies an orphaned daemon by its
  exact command line, read from `/proc/<pid>/cmdline` on Linux and `ps`
  elsewhere. A `droid` started through a wrapper (for example `node droid.js`)
  never matches and stays held as unverified, which is fail-closed. Each daemon
  is spawned as its own process-group leader, and revocation signals the group
  (SIGTERM, SIGKILL if needed, then a final SIGKILL to the group), so a worker's
  background processes are stopped with the job. A descendant that starts a new
  session (`setsid`) leaves the group, so process-tree revocation stays unproven
  (a hold outside trusted-host mode, an accepted risk inside it).
- **Node version.** The production composition imports `sdk-adapter.ts`, which
  needs Node's default type stripping (22.18+, 23.6+ or 24+); older Node refuses
  startup with `native_node_version_unsupported`.
- **Sandbox.** Without trusted host, droid's whole-process sandbox must start
  and pass the containment probe, which also needs `curl` on the daemon `PATH`
  (a host without it fails the probe). droid 0.238's sandbox refused to start
  on macOS; on Linux it may work. Owner-trusted host mode runs `droid`
  unsandboxed on every platform.
- **Store lock.** Dead-writer recovery compares the lock's hostname, so a
  container whose hostname changes on each start needs a stable hostname.
- **Executables.** droid, gh and git must not be writable by other accounts.
  World-writable is refused; group-writable is accepted only for a file the
  broker's user owns in its own primary group (droid installed under umask 002).

Set the token through the host's protected environment, not a client ledger or
source file. The opt-in composition uses the pinned lazy `sdk-adapter.ts`,
one non-reconnecting loopback websocket per job, and the host-routed provider.
SDK absence/version mismatch fails closed. Construction never starts a daemon,
GitHub call or model turn, and default startup does not import the SDK.
This implementation does not expose a port during tests except ephemeral
loopback listeners. It does not implement remote deployment.

Every data route requires `Authorization: Bearer <host token>`. Body/query
`ownerId` must equal the configured owner; command path must equal `missionId`:

```
GET  /v1/native/capabilities
POST /v1/native/jobs                              NativeIntent -> NativeSnapshot
GET  /v1/native/jobs/:missionId?ownerId=...         -> NativeSnapshot
POST /v1/native/jobs/:missionId/commands           NativeCommand -> NativeCommandReceipt
```

No CORS is allowed by default. `createRouter` / `startBrokerServer` can accept
explicit `allowedOrigins` (or `'*'`); all actual requests still require bearer
auth.
Errors return only bounded `{error: safe_code}`, never SDK exception bodies,
prompts, transport credentials, or stacks.

## Durable authority and limits

The store commits an entire checksum-validated transactional image using an
exclusive temporary file, file fsync, atomic rename and directory fsync.
Intent/command/request/event changes commit together **before** invocation.
An exclusive lifetime `.writer` lock holds PID, host and random fencing token;
durable epochs fence callbacks across reopen. There is no timeout lock stealing.
Do not use this local filesystem design as a distributed multi-host lease.

Unclean restart refuses the dead writer's lock until explicit
`recoverDeadWriter({directory,expectedToken})` proves the same-host PID is absent
and the exact operator-inspected token still owns the lock. Recovery is guarded
against simultaneous acquisition/recovery. Live/unknown/remote PIDs are refused.
This is a host-only operation; no HTTP unlock exists. `startFromEnv` runs the
same check once at startup (`recoverStaleWriterLock` in `server.mjs`): it reads
the token from the lock itself and releases it only when the recorded host is
this host and the PID is gone, so a service restarts after an OOM kill or power
loss instead of failing with `writer_locked` forever.

Corrupt checksum/nested records, missing initialized ledger, mismatched owner,
symlinked paths and ambiguous writes refuse/fence execution, not reconstruct
grants from cached booleans. An invoked record becomes unknown on restart.
Prepared records are retained but **never replayed**. Dedupe IDs cannot prove
provider exactly-once. Late valid launch resources are attached even after
timeout or requested cancellation; uncertainty and requested stop remain.

An answer is bound to exact mission/owner/machine/session/request/revision/raw
payload hash, frozen scope/policy, current epoch and a fresh authoritative
pending set. Root/child permission views dedupe while retaining associations;
AskUser ownership is never inferred from permission associations.
All questions/values are retained. Missing canonical/custom-answer rules hold,
and a whole questionnaire is required. Restricted multi-select values use a
canonical JSON-array string in the transport-neutral fixture contract; native
SDK encoding/custom-answer semantics still require qualification.

`sent` only records unknown/pending resolution; it never closes attention.
Only complete authoritative matching pending boundaries can resolve a request.
Disappearance does not establish which actor/outcome answered it; proposal
acceptance additionally needs exact correlated provider outcome evidence.
Local answer delivery remains unknown after externally observed request closure
until an independently correlated receipt resolves it. It is never replayed.
Edited specs, permanent permissions, autonomy/session-changing outcomes and
scope-changing owner turns are unavailable with protocol v1.

Features/progress are replacement arrays. Worker completion is only a reported
exit, not validation or accepted work. Heartbeats do not refresh state.
Failed reads preserve the last successful observation; restart resets
completeness and pending reconciliation without pretending cache is fresh.
Requested pause/cancel and observed paused/terminal states fence **every**
execution send, including SDK-adapter guards. Unsupported control means local
requested stop plus explicit Factory handoff, not proof workers stopped.

Completed enters persisted read-only finalization, bounded by 60 seconds and
eight attempts. Provider summary/artifact claims are retained, but evidence is
unverified and final delivery remains incomplete without independent
artifact/criteria verification. No post-terminal summary turn/reviewer occurs.

Hard bounds (no lossy safety-record compaction):

- Input 128 KiB; normalized observation 256 KiB; response 1 MiB.
- Snapshot growth admission 1,044,480 bytes; persisted snapshot ceiling
  1,046,528 bytes, reserving safety-hold and live-capability response space.
- Ledger 8 MiB; 128 jobs; 512 commands/history rows/features per job.
- 256 attention/worker rows; 512 progress rows; 8,192 events.
- Event reads <=200; provider operations default 5 seconds, max 30 seconds.
- 32 active HTTP requests, 64 connections, 8 real outstanding provider reads
  shared by HTTP and service polling, including reads whose callers timed out.
- Pending/state action freshness budget 30 seconds.

Capacity exhaustion refuses new writes before execution. Active authority,
unknown outcomes and dedupe tombstones are never silently dropped. Host
retention/backups and independently qualified artifact verification remain
deployment gates.

Read timeout does not release the provider reservation. Repeated callers reuse
the bounded result of that same pending read; new jobs are held when all eight
real read slots are occupied. The slot is released only after the raw promise
and bounded result settle. Late rejections are consumed, late successful reads
are ignored, and only a subsequent fresh read can restore authority.

The store validates every persisted projection before writing. If an observation
or notification would exhaust the readable projection budget, its entire
candidate transaction is rejected; no resolved-history compaction or raw-value
clipping occurs. A separate reserved-space transaction persists
`completeness: 'gap'` and `holdReason: 'projection_capacity_exceeded'`, clears
pending reconciliation authority, and retains all previously admitted request
identities, raw payloads, states and ownership. The rejected observation hash
and source are recorded, not partially imported. Unadmitted requests require
fresh bounded reconciliation or Factory handoff, never an inferred answer.
The hold survives restart and failed reads; owner GETs remain within the shared
response limit. Repeated overflow does not append unbounded gap records.
An existing held snapshot does not prevent unrelated jobs from being updated.

## Host enforcer details

Containment probes run as one `droid exec --settings <probe settings> --cwd
<work> --auto low` with the daemon's exact HOME, environment and sandbox
settings plus a probe-only `UserPromptSubmit` hook. Hooks run inside the
sandbox, and the hook script exits 2 to block the prompt, so **no model turn is
expected**; if the hook block ever failed, a short low-autonomy model turn could
occur before the probe times out. The probe proves work-tree writes succeed,
owner-home writes are denied, and github.com is unreachable from inside the
sandbox; the signed result is written under the work tree's `.git` and removed
by the host. Any probe failure refuses the lease
(`native_containment_probe_failed`).

Leases require a running daemon, passed probes for the current revocation
generation, verified credential isolation (currently **unproven/held**), and carry `budget: {enforcement:
'none'}` — the honest non-enforcement marker `validateEnforcementLease`
requires for budget-free intents. `renewLeases()` extends host-side expiry
only while the daemon lives; `revoke` sends SIGTERM, escalates to SIGKILL
after 5 seconds, waits for verified exit, bumps the generation and voids every
lease and permit. Unverified termination fails closed and produces no success
evidence. Consumed permits are deleted rather than retained forever.
Send permits are single-use and expire within 5 seconds.

Read-only host admission clones/inspects existing repositories locally without
starting a daemon or acquiring launch authority. New-repository inspection does
not provision any checkout or create/push anything; its base is explicitly
prospective. Both paths use the actual provider admission implementation and
return all unqualified settings/High/child-pending/recovery/credential holds.
Preview hashes, immutable base, settings and workspace identity remain exact.
The app must mint a mission ID before resolving the exact host work path
`<root>/jobs/<missionId>/work`; its current static saved-profile cwd contract
does not automatically generate that path. That app integration is still needed
before general host-mode admission is usable through normal phone settings.

All preparation failures, SDK ingestion faults and terminal completion revoke
the host daemon regardless of push policy. Failed preparation records retain a
created repository URL without deleting it. Owner cancellation remains an
unsupported Factory handoff, not a fabricated cancellation acknowledgement.
On restart, starting/running or unverified-orphan jobs persist a
`recovery_required` state with “Broker restarted; mission must be re-prepared”.
The host signals an orphan only after matching its complete persisted command
(job-specific settings, port and original parent), verifies exit, and never
replays initialization/owner turns or signs a dirty checkout as a pristine base.
Reused/unverifiable PIDs remain held. Re-preparation needs a new mission identity.

Usage reporting (`createNativeUsageClient`) queries the Factory Analytics
`top_sessions` API after the next UTC day boundary and sums credits for the
job's root and worker session ids. It is informational, never a budget; 401/403
(non-Enterprise) reports `unavailable`, transient failures stay `pending`.

Delivery (`native-delivery.mjs`) is broker-performed with owner credentials
after the daemon is stopped and the read-only finalization completes. The
broker resumes any started, non-terminal delivery on restart; failures persist
a `held` state with the reason instead of guessing. Active/recovery-required
jobs do not automatically deliver after restart. Delivery state is persisted at
returned boundaries; per-step crash journaling inside delivery remains an
additional qualification requirement.

## Offline checks and remaining protocol needs

From the repository root, run
`node --import ./scripts/ts-resolve.mjs scripts/test-native-broker.mjs`,
`node --import ./scripts/ts-resolve.mjs scripts/test-native-host.mjs` and
`node --import ./scripts/ts-resolve.mjs scripts/test-portable-broker.mjs`.
Fixtures use isolated temporary stores and actual router/store code, including
real subprocess death after invocation. No SDK import, live credentials,
browser, native session or network mutation occurs.

Future shared-protocol work (not changed by this package): revisioned
follow-up scope/policy grants and expiry; complete raw/custom-question rules;
edited proposal content; exact native acceptance outcome/proposal identity;
provider freshness/gap detail and read-only artifact verification receipts.
Actual initialization, immutable repository/physical-workspace proof, managed
High policy/cost boundaries, root/child recovery, replay containment, full
pending snapshots, and stop semantics all need separately authorized runtime
qualification before enabling Native Mission launch.


## Owner-trusted host mode

`SPRIITE_NATIVE_TRUSTED_HOST=1` is the owner's explicit decision to run native
Missions on their own Factory host without a signed host qualification. It lifts the
structural holds (`native_credential_isolation_unproven`,
`native_daemon_authentication_unqualified`, `native_process_tree_revocation_unproven`,
`live_sdk_qualification`, `native_enforcement_lease_unavailable`,
`sdk_high_autonomy_unobserved`, `sdk_mission_settings_unconfirmed`,
`native_child_attention`, `passive_authoritative_pending_recovery`, and the two
prospective new-repository holds; see `TRUSTED_HOST_ACCEPTED_RISKS` in
`sdk-provider.mjs`) and reports capabilities as qualified with
`qualificationId: owner-trusted-host:<digest prefix>`.

Accepted risks, in plain terms: agent code in a job can read the daemon's
`FACTORY_API_KEY` (as it can when you run `droid` yourself), process-tree
revocation is best effort, and a broker restart re-prepares rather than
recovering an open request. Still enforced: per-intent scope and High-autonomy
consent, policy-compile holds (destination, consequence dependencies,
restrictions, no budgets), model/tool allowlists, and delivery dependencies
(merge needs PR needs push). Child (agent) requests remain owner handoffs.
