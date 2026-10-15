# Provider-supported native isolation: feasibility

Decision: **keep native blocked; pursue provider-supported isolation**.
This is a read-only investigation, not qualification or permission to start a
production service. No keys, owner auth files, sessions, models, account settings,
remote writes, package upgrades, or signed evidence were used/changed.

## Conclusion and single next step

**A Factory key in the daemon's startup environment is not a requirement
established by the raw-client SDK contract. But removing it does not establish
credential isolation.** The supported authentication RPC sends the credential
to the daemon, and pinned session initialization separately requires a `token`.
The daemon's subsequent credential retention and tool-process propagation are
unknown from the public client sources inspected.

Pursue one architecture: **broker-owned authenticated control/inference plane,
with all untrusted root/worker/validator tools in a provider-supported,
secret-free isolated tool plane**. The trusted daemon may receive Factory
account credentials; the tools must not. A VM/container without owner-home
mounts can host the tool plane, but putting a credential-bearing daemon and its
inheriting tools together inside a VM is not separation. Native file tools,
Execute, Task descendants, Script, hooks, and subprocesses all need coverage.
The trusted plane must not execute repo-controlled hooks/plugins outside it.

**The immediate next step is the Factory support request below**, seeking the
supported executor/authentication data-flow contract and an exact SDK/daemon
pair. Then obtain scoped permission for the model-free provider-assisted probe
below. Do not implement an arbitrary gateway or enable production in the interim.

## Sources and scope

Official documentation was fetched through the requested
<https://docs.factory.ai/llms.txt> index (redirects to `docs.factory.com`), then
the supplied pages:

- **D1:** <https://docs.factory.com/model-independence/byok.md>, “Configuration
  reference,” “Dynamic credentials with apiKeyHelper,” and “Using extraHeaders.”
- **D2:** <https://docs.factory.com/sdk/typescript.md>, “Install and authenticate,”
  “Read session state,” “Use a custom model,” “Permissions and user input,” and
  “Tool controls.”

Local source citations below use these paths:

- **S1:** `/tmp/spriite-canary/harness/node_modules/@factory/droid-sdk/dist/chunk-TWSTJMV7.mjs`
- **S2:** `/tmp/spriite-canary/harness/node_modules/@factory/droid-sdk/dist/node.mjs`
- **S3:** `/tmp/spriite-canary/harness/provider-canary.mjs`
- **S4:** `broker/sdk-provider.mjs (repo-relative)`

Package version is `0.9.1`, recorded in
`/tmp/spriite-canary/harness/node_modules/@factory/droid-sdk/package.json:2-3`.
Source-map inventory contains client protocol schemas, transports, controllers,
and Node subprocess helpers, not the installed daemon's authentication server
or Execute/Task/Script executor implementations. Those maps therefore cannot
establish server-side credential handling.

Credential-free help inspection used:

```sh
env -i PATH=/usr/bin:/bin HOME=/nonexistent \
  ~/.local/bin/droid --version
env -i PATH=/usr/bin:/bin HOME=/nonexistent \
  ~/.local/bin/droid daemon --help
```

Installed daemon: **0.227.0**. Help advertises loopback host, Unix socket, IPC,
`--droid-path` for spawning sessions, parent/liveness monitoring, and
process-only `--settings`. It advertises no keyless-account, separate tool
principal, credential-forwarding-disable, or passive pending-state option.
Help output is not proof such capabilities do not exist. No daemon was started.

## 1. Factory account authentication and credential data flow

| Finding | Evidence | Limit |
|---|---|---|
| Raw `DaemonClient` takes a transport and sends `authenticate(params)`; its authentication method does not inject an environment variable. | S1:11508-11540, 11622-11645 | Says nothing about how the server spawns or authenticates session processes. |
| `daemon.authenticate` requires an API key **or** WorkOS JWT; delegation is not a keyless alternative. | S1:4980-5007 | Both alternatives deliver a credential to the daemon. |
| `caller:'sdk'` requires SDK metadata. Authentication returns `userId` and `orgId`. | S1:4963-5015; metadata language/version schema at 2061-2064 | Metadata is routing/diagnostics, not containment. Returned identity must bind the intended provider account/org. |
| Both raw initialization and load require a `token` string. | S1:7718-7750 | Schema alone does not identify its server-side storage, lifetime, or subprocess propagation. |
| Spriite sends that token during initialization but excludes it from its durable request hash/journal. | S4:1073-1083 | Not persisting it in the broker does not prevent daemon retention. |
| The old canary supplied the same key through **three** channels: daemon startup env, authenticate RPC, and initialization token getter. | S3:54-55, 171, 290 | Its success cannot distinguish which channels were necessary. |
| Default high-level Node SDK does require a Factory key and places it in the spawned Droid process env, even when passed as an option. Default env sanitizer returns the input unchanged. | S2:518-520, 3125-3166, 3268-3294; D2 | Changing to high-level `createSession({apiKey})` is not an isolation fix. A custom transport bypasses the helper's resolver, not the server's auth requirements. |

Thus “keep the key only in the broker” is literally false if that key is sent
via authenticate: at minimum it also exists in daemon request processing.
What might be feasible is **keep credentials only in trusted processes** and
prove they never enter tool env/argv/files or become readable through trusted
process memory, inherited descriptors, parent inspection, or IPC.

Unanswered: whether RPC credentials become `FACTORY_API_KEY` in session/worker
or tool subprocesses; whether tokens are persisted in the job HOME/session
storage; how credentials reach Task/Script children; and whether the provider
supports enforcing a different tool security principal/executor boundary.
No “env scrub proves isolation” claim is justified.
The initialization schema's `z.string()` also does not establish whether the
server accepts an empty/placeholder token for BYOK. Client-side acceptance of
such a string would not prove a supported keyless account route.

## 2. Keyless custom-model gateway is not keyless Factory authentication

D1 explicitly supports HTTP `customModels` with **omitted `apiKey`** when the
endpoint uses network-level trust. Pinned custom-model schema also makes
`apiKey` optional (S1:2947-2969). This removes the **upstream model credential**
from Droid configuration if the gateway needs no bearer/header secret.

It does not document removal of Factory account authentication, Mission access
policy, or raw initialization's required token. A gateway authenticated with
secret `extraHeaders` merely moves the exposed credential. `apiKeyHelper`
returns and caches an actual token in Droid; org-managed trust prevents
repo-supplied helper commands but does not isolate the returned credential.

D2 documents `custom:<configured-model>` IDs wherever the public SDK accepts
`modelId`. Pinned root model settings are strings; worker/validator model fields
are also strings (S1:3013-3019, 4064-4075). Therefore such IDs are representable,
but **all three Mission v2 roles using the intended custom model, without
fallback, have not been observed or qualified on daemon 0.227.0**. The
documentation does not provide an exact minimum version for that full contract.

A private gateway can be an inference-plane component, not proof of the tool
boundary. Network-level trust must not let arbitrary tool code make gateway
requests or reach other hosts. Tools must have no arbitrary egress, account
credentials, owner-home access, or access to trusted process state. A broad
domain allowlist inherited by every tool is insufficient for that separation.

## 3. Controls: documentation vs pinned implementation vs observations

| Control | Supported surface / actual evidence | Remaining gap |
|---|---|---|
| Exact effective root/worker/validator settings | D2 `session.settings` is a live read-only handle updated when Droid reports changes. Pinned `SessionSettings` allows optional `missionSettings` (S1:4064-4082). | A handle/cache does not cause omitted worker/validator fields to become authoritative; role-specific complete readback is unqualified. |
| High autonomy | Recorded root initialization and settings events report High. | Not fresh evidence for this deployment/boundary or every child; retain launch hold until scoped qualification. |
| Child discovery | `child_session_available`, parent/tool attribution, and controller optimistic registration exist (S1:16252-16280). | Discovery is not complete role/settings/attention proof. Default controller hydration attaches/loads children. |
| Pending Permission and AskUser recovery | Raw load result includes optional `pendingPermissions`, `pendingAskUserRequests`, and settings (S1:4130-4154). | No confirmed passive, complete pending-state read contract. The controller may auto-reject invalid restored permissions and replay buffered answers (S1:17567-17596). |
| Passive reconnect | Raw client exposes explicit load. SDK controller describes load as a lifecycle transition and warns about resurrecting a worker to interrupt it (S1:15203-15211). | Do not use auto-load/hydration/resume/replay to claim mutation-free recovery. Any attach operation needs separate fresh owner action; answers remain separately approved. |
| Restrictive tool allowlist | Pinned raw session schema supports tool overrides; Spriite uses `restrictToolIds`. | D2 high-level public API exposes subtractive `disabledToolIds`, explicitly not a restrictive allowlist. Do not silently replace the raw guard with that API. |

Recorded settings facts, inspected without printing raw frames or credential
values:

- `/tmp/spriite-canary/v2evidence/raw-frames.jsonl`: lines **4, 148, 407**.
- `/tmp/spriite-canary/v2evidence-run2/raw-frames.jsonl`: lines **4, 27**.
- `/tmp/spriite-canary/v2evidence-run3a/raw-frames.jsonl`: lines **4, 110**.

Every listed settings result/event reports High and omits `missionSettings`.
Initialization results contain `restrictToolIds`; the listed settings events
omit that field. These canaries explicitly used a **fake host boundary**
(S3:1-6); they do not lift isolation or production holds.

No documented small upgrade that closes all gaps was verified. Ask Factory for
an exact supported SDK/daemon version pair and semantic contracts; pin it in a
separate qualification branch only after approval. Preserve restrictive tools,
exact settings, owner/org binding and non-replaying reconnect behavior.

## Provider-assisted model-free probe and prerequisites

The next probe belongs to the chosen trusted-plane/tool-plane architecture:

1. Factory supplies a supported diagnostic fixture or server-side test harness
   for successful **dummy** authentication and deterministic tool execution.
   A client-side fake success proves encoding only, not credential propagation.
2. Start the prescribed daemon with a fresh private HOME, no owner auth/profile,
   no `FACTORY_API_KEY`, no mounted owner filesystem, no actual tokens, and
   externally enforced deny-by-default egress. Observe startup independently.
3. Broker sends only dummy authenticate material with
   `{caller:'sdk', metadata:{tracing:client.getTracingMetadata(),
   sdk:{language:'typescript', version:sdk.SDK_VERSION}}}`.
   Session initialization's dummy `token` must be included and tracked as a
   separate input. An invalid dummy rejected by a real backend tests rejection,
   not the successful-auth data path.
4. Through the provider-supported **non-model diagnostic executor**, run
   root/worker/validator-associated native file, Execute, Task-descendant and
   Script probes. Assert dummy credentials are absent from tool env, argv,
   readable files/storage/descriptors and trusted-process inspection; verify
   owner sentinel read/write denial, symlink containment, egress denial and
   descendant revocation. Report only booleans and redacted path categories.
5. Observe complete settings and pending-state snapshots with role, session,
   connection and freshness binding; reconnect must send no mutation, load,
   buffered response or auto-cancel. No live Mission/inference is needed for
   this diagnostic fixture.

If Factory cannot supply that harness, do not invent an Execute/Task/Script
RPC. A real successful account-auth test requires a **new scoped permission**
and an account credential confined to the trusted plane; a subsequent model
qualification needs separate consent. VM/executor provisioning and OS security
controls also need explicit infrastructure approval. Nothing here installs them.

What can be prepared without these prerequisites: schema/wire-only dummy tests,
an auth/initialization data-flow inventory, and a redacted fixture/probe plan.
Those are not host evidence. Current launch, credential-isolation, child
attention, effective mission-settings, passive recovery and process-tree
revocation holds remain.

## Factory support request draft — not sent

> We are keeping native execution disabled while qualifying provider-supported
> isolation. Installed Droid is 0.227.0; client is @factory/droid-sdk 0.9.1
> (raw DaemonClient, restrictive tool guard, no controller replay).
>
> Your BYOK docs support HTTP custom models without apiKey, but the raw client
> requires API-key/JWT authentication and a separate initialization/load token.
> Can a daemon start with no Factory key or owner auth files and receive account
> auth only by RPC? Please specify exactly where both RPC credentials are held,
> persisted, refreshed and propagated to session workers, native tools,
> Execute, Task and Script descendants.
>
> Which supported executor/security boundary keeps these credentials exclusively
> in trusted processes, denies tool inspection of those processes, and separates
> all tool filesystem/egress access from control/inference access? A VM containing
> credential-inheriting tools, apiKeyHelper, or merely removing an env variable
> is insufficient for our policy.
>
> Please identify an exact supported SDK/daemon pair for Mission v2 custom-model
> root + worker + validator execution without fallback; authoritative readback
> of each role's model/effort/tools/validation settings; and passive complete
> Permission/AskUser recovery that neither loads a worker nor replays/cancels
> answers on reconnect. Our recorded root settings report High but omit
> missionSettings. Is keyless Factory account authentication supported separately
> from keyless upstream inference?
>
> Can you provide a model-free successful dummy-auth/tool-executor diagnostic
> fixture? Repro inputs would be a fresh HOME, no env Factory key, dummy RPC
> account credential + dummy initialization token, and sentinel-only
> env/file/process/network checks. We can provide redacted field-presence
> summaries, never real tokens, owner files or raw model/session logs.
