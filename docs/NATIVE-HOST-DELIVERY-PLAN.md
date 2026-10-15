# Native host boundary, private repositories and delivery: plan

Owner decisions (2026-10-13):
- Delivery: push a branch, open a PR, merge only after checks pass.
- New repositories: private only.
- Consent: settings defaults, shown read-only in the review screen.
- Build and qualify the real host boundary now.
- Budget: no hard limit (Factory exposes no live per-job usage). Show next-day usage.

## Implementation status after review

The architecture below is the target, not evidence of production qualification.
Native launch remains disabled. Redeployed workers fixed the app and host/broker
review findings and integrated the explicit managed-workspace profile contract.
Managed profiles use `workspaceMode: 'host_managed'` and a separate `hostRoot`.
After minting a mission ID, admission binds exactly
`<hostRoot>/jobs/<missionId>/work`. Existing static profiles retain their saved cwd.

Final combined offline qualification: 35 suites passed, 4,468 labeled checks, zero
failures. Managed-workspace and real local-seed suites are registered in the
qualification runner. TypeScript, copy budgets and production build pass; the
build retains the existing bundle-size warning.
Simulator walkthroughs were skipped in this combined run; the earlier delivery
fixture walkthrough passed 14 checks before these review fixes. No new simulator,
hardware or live host qualification is implied.

Checks include broker 75, host 27, provider 111, delivery 56, admission 15 and
managed-workspace 9 groups. The real local-seed test passes with configured
author/committer unchanged. Injected-port checks do not establish live
containment; all independent review findings were fixed before the combined run.

Remaining qualification gates include credential isolation (the daemon still
receives its Factory API key), effective worker/validator settings, supported
daemon authentication, child-attention recovery, descendant-process revocation,
and genuine live qualification. Recorded earlier fake-boundary canaries show
High autonomy, but they do not qualify the production host.

New-repository admission now constructs a local seed using configured Git
identity unchanged and binds its actual SHA into review. Approved preparation
journals private repository creation and seed publication before daemon startup.
Adoption is refused. No remote repository was created or pushed in these tests.

Real dummy-secret Seatbelt probes denied synthetic-owner read/write, symlink
escape and loopback access, but the inherited dummy credential was readable in
both child and grandchild environments. A restrictive whole-filesystem prototype
aborted. No credential-isolation lease or host qualification was signed. A
supported trusted-inference/keyless execution separation is required; moving the
same credential-bearing process into a VM alone does not fix this failure.

A live scratch-repository qualification run has not been performed or authorized.
Do not lift launch holds based on signed configuration, offline tests, or the
earlier fake-boundary canary.

### Production completion work

The owner requested proceeding toward production use with workers. Two separate
tracks have implemented the following:

- Host/provider: enforceable credential and filesystem isolation; truthful SDK
  effective-settings, High-autonomy and child-attention recovery evidence;
  configured-identity local repository seed bound into admission.
- Delivery/broker: durable pre-dispatch and post-dispatch effect journaling,
  unknown-outcome reconciliation, and credential scanning across all delivered
  commits rather than only the final diff.

Neither track may enable launch by deleting unresolved holds. Real probe results,
live qualification, and explicit activation scope are required before production
use. A passing offline crash matrix alone is not a live delivery qualification.

Delivery track result: 56 delivery tests and 75 broker tests pass. Durable effect
intents and receipts cover repository creation, initial seed push, delivery push,
PR creation and merge. Unknown outcomes do not automatically replay. Delivered
commit history, trees and blobs are scanned with bounded, fail-closed handling.
Hook bypass flags have been removed.

The broker passes `broker.deliveryContext(missionId)` unchanged into creation
and seed delivery calls after obtaining
`host.privateRepositoryInitializationInput(missionId)`. Production preparation
requires confirmed creation and seed receipts before daemon startup.

Independent review fixes: delivery Git operations use private bounded metadata
snapshots excluding worker configuration, includes, hooks, alternates and
executable helpers. Repository ID and visibility are checked before later
effects and reconciliation. Shared credential filtering rejects fine-grained
GitHub tokens before persistence or projection. Production host Git uses the
validated executable, not owner PATH.

Repository read-before-write checks are not atomic repository-ID authorization;
appropriately scoped credentials are still required. Existing delivery jobs
without scoped reviewed repository identity remain held. These controls do not
solve the separate inherited Factory-credential isolation failure.

Owner follow-up decision: keep native launch blocked and pursue
provider-supported isolation, not a fallback to the existing build path.
`docs/NATIVE-PROVIDER-ISOLATION-FEASIBILITY.md` records the credential data flow,
supported keyless BYOK limits, exact provider capability questions, and an
unsent Factory support-request draft. No credential-free successful-auth
diagnostic executor has been obtained. A live rejection using a dummy key would
not prove isolation after successful authentication.

## Architecture

```
phone ──> broker (127.0.0.1) ──> host enforcer ──> dedicated sandboxed droid daemon (per job)
                │                      │
                │                      └─ signs evidence (ed25519 host key, ~/.spriite-native/host-key)
                └─> delivery (outside sandbox, owner's gh login): create private repo,
                    push branch, open PR, wait checks, merge
```

The agent never holds GitHub credentials and has no network route to GitHub. Every
outside-world consequence is performed by the broker's delivery module after the
Mission completes, within the job's frozen policy.

## Components and ownership

### 1. Host enforcer: `broker/native-host.mjs` (worker H)

Implements the boundary port required by `requireNativeBoundary`:
`verifyWorkspace`, `acquireLease`, `authorizeSend`, `assertAndConsumePermit`, `revoke`.

- **Job root:** `~/.spriite-native/jobs/<missionId>/` with `work/` (checkout) and `home/`
  (daemon HOME). Mode 0700. Never reused.
- **Provisioning:** existing repo: `git clone` with the owner's credentials *by the broker*,
  checkout `baseRef`, record `baseSha`, then strip credentials from the clone's config
  (no credential helper, remote URL without userinfo). New repo: local admission
  seed first; only approved preparation journals remote creation and seed push.
- **Dedicated daemon:** spawned with a scrubbed environment (`PATH`, `HOME=<job>/home`,
  `LANG`, `FACTORY_API_KEY` only) and `--host 127.0.0.1 --port <ephemeral> --parent-pid`.
  `<job>/home/.factory/settings.json` sets
  `sandbox: { enabled: true, mode: 'whole-process', filesystem: { allowWrite: [<work>], denyRead: [owner home secrets] }, network: { allowedDomains: [] } }`.
  If the daemon refuses to start (sandbox unavailable), the job holds.
- **Evidence:** signed manifests (existing `createNativeEvidenceAuthority` format) with one
  artifact per dimension, each artifact a JSON fact file whose digest is in the manifest:
  - `physical_workspace`: realpath, git toplevel, HEAD sha, remote URL without credentials.
  - `filesystem_containment`, `bounded_checkout_writes`: settings file digest plus a *live
    probe* run through the dedicated daemon's sandbox: write inside `work/` succeeds, write
    to the owner's home fails.
  - `credential_isolation`: env key list of the daemon process, absence of gh/ssh/git
    credentials under `home/`, clone config has no helper.
  - `consequence_mediation`: network allowlist empty (live probe: `github.com` refused from
    inside the sandbox); delivery is broker-only.
  - `root_worker_validator_coverage`: whole-process mode, so workers and validators run
    inside the same sandboxed process tree.
  - `ongoing_revocation`: daemon pid and the revoke path (SIGTERM, then SIGKILL; lease
    generation bump).
  - `usage_reporting` (replaces billing dimensions): next-day usage is queried per job, labeled
    as not enforced.
- **Leases and permits:** leases ≤ 5 min, renewed while the job runs; permits ≤ 5 s, single
  use, bound to frame hash (existing validators).

### 2. Policy change: `broker/native-policy.mjs` (worker H)

- Replace `complete_inference_billing` and `atomic_budget_reservation` with
  `usage_reporting`. Budget becomes optional; when absent, the lease's budget block is
  `{ enforcement: 'none' }`. Record this in docs as an owner decision.
- Allow `allowCreateRepository` (only with `destination.kind: 'new_repository'`,
  `visibility: 'private'`, `initialization: 'empty'`), `allowPush`, `allowPr`, `allowMerge`.
  `allowDeploy`, `clone` and `fork` stay refused. `allowMerge` requires `allowPr` requires
  `allowPush`.
- New required dimension `delivery_mediation` whenever any consequence flag is set.

### 3. Delivery: `broker/native-delivery.mjs` (worker D)

```js
export function createNativeDelivery({ gh, git, now, sleep }) // gh/git are injected runners
// returns:
//   createPrivateRepository({ account, name }) -> { repositoryUrl, created: true }
//   deliver({ missionId, workDir, repository, baseRef, baseSha, policy, title, body })
//     -> DeliveryState (persisted by the caller after every step)
//   resume(state) -> DeliveryState   // idempotent continuation after restart
```

`DeliveryState` (also the phone projection, see section 5):

```ts
{ step: 'held' | 'pushed' | 'pr_open' | 'checks_pending' | 'checks_failed' | 'merged' | 'not_merged',
  branch: string, headSha: string, prUrl?: string, prNumber?: number,
  checks?: { total: number, passed: number, failed: number, pending: number },
  reason?: string, updatedAt: string }
```

- Branch `spriite/<missionId>`; push only that branch; never force-push; never touch the
  base branch directly.
- Delivers only commits that descend from `baseSha` with a clean tree; otherwise `held`.
- PR body states it was produced by a Factory Mission started from Spriite.
- Merge only if `allowMerge`, all checks completed and passing, and **at least one check
  exists**; zero checks → `not_merged` with reason "No checks configured". Merge method:
  squash. Re-verify head sha before merging.
- Every gh/git call has a timeout; failures leave a resumable state, never a guess.

### 4. Broker integration (worker H)

- Admission: when the host enforcer and evidence authority are configured, the
  `native_enforcement_lease_unavailable`/`live_sdk_qualification` holds are lifted only by a
  passing host qualification record (`broker/qualification.mjs`), produced by the live
  canary, bound to deployment digest and host key.
- After the provider observes `completed` with finalization, the broker runs delivery and
  persists `DeliveryState` in the job record, exposed in observe responses as `delivery`.
- Usage: the next day, the broker queries `/api/v1/analytics/cost/me/query?queryKey=top_sessions`
  for the job's session ids; exposed as `usage: { state: 'pending' | 'available' | 'unavailable', credits?: number }`.
  403 (non-Enterprise) → `unavailable`.

### 5. App: settings defaults, review display, X new-repo, delivery display (worker A)

- Settings (phone): "Native delivery defaults": Create private repositories, Push branch,
  Open PR, Merge after checks pass. Stored in prefs; dependencies enforced (merge ⇒ PR ⇒ push).
- Review screen: these defaults appear read-only in the summary ("This job will: push branch
  spriite/…, open a PR, merge after checks pass"). Changing them is done in settings and
  revokes the current admission.
- Native intents built from settings carry the matching policy flags; X/generic held intents
  pick up current defaults at review time (still requiring both consents).
- X new-repository posts in native mode: allowed when "Create private repositories" is on;
  destination `{ kind: 'new_repository', visibility: 'private', initialization: 'empty' }`.
  Otherwise keep the clear refusal.
- Projection: `NativeSnapshot.delivery?: DeliveryState` and `usage?`. Phone and glasses show
  delivery honestly: "PR open, checks 2/3", "Merged", "Not merged: checks failed",
  "Not merged: no checks configured". Merged is the only state described as delivered.

## Qualification

- Offline: unit suites for host (fake spawn/fs), delivery (fake gh/git incl. restart
  resume, zero checks, failing checks, head moved), policy, app.
- Live host canary (scratch private repo on the owner's account, created and deleted
  by the canary with explicit permission):
  1. Containment probes pass/fail as expected inside the dedicated daemon.
  2. Full Mission → branch pushed → PR → checks (scratch repo gets a trivial passing workflow) → merged.
  3. Revocation mid-run stops the daemon.
  Evidence signed and stored; qualification record written only if all pass.

## Out of scope

Deploy, clone/fork, public repositories, hard budget caps.
