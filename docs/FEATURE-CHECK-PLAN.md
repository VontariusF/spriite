# Main-feature check and fix plan

> **Historical record (2026-10-11).** This documents a past run on the original developer's single macOS host and may name tools, paths or states that have since changed. For current setup see [NATIVE-BROKER-SETUP.md](NATIVE-BROKER-SETUP.md) and [SETUP.md](SETUP.md).

Date: 2026-10-11. Working tree only; no release authorized.

## Round 1: establish failures

All eight existing suites passed, 2,358 assertions. Read-only feature audits
identified cases the baseline did not exercise:

1. Growing verdict text can approve a different job; partial worker output
   can hand off an unfinished branch name or PR URL.
2. Legacy cold startup passes saved session settings under the wrong
   constructor property.
3. Voice input can change owners during capture, or leave the UI stuck after
   a focus change during settlement.
4. X follow-up receipts can be recorded before the instruction is delivered;
   busy steering and process exits can lose accepted instructions.
5. Archive restore can discard deletion/edit facts at equal receipt times,
   and replace a post's publication time with its receipt time.
6. The qualification runner omits the settings suite. A report-coverage
   assertion failed against its seven-suite output.
7. Repeated SDK read failures let history saves overwrite earlier builds
   and activity that the app never loaded. Both losses were reproduced
   with a failing-read, successful-write fake storage adapter.
8. Ordinary typed/voice steering could report acceptance while a busy engine
   discarded it. Two new regression checks reproduced the false acknowledgment.

## Implementation tracks

- **Build worker:** correlate requests and completed replies; require final
  markers for verdicts and session-worker stages. Persist protocol state,
  prevent replay into later stages, and keep older pending runs recoverable.
- **Startup/voice worker:** apply saved settings on cold legacy startup;
  freeze capture ownership at start, cancel on ownership changes, and reject
  stale continuations without clearing a newer capture. Then protect feed
  and project history against unknown reads, failed writes, and overlapping
  pending saves.
- **X/archive worker:** merge monotonic receipt facts, preserve publication
  timestamps compatibly, and test restored held-request confirmation.
  Then add durable targeted follow-up delivery once shared build files are
  free. Recover pending sends; hold ambiguous sends for owner resolution,
  never blindly replay them.
- **Main thread:** include every main-feature suite in qualification,
  integrate reports, coordinate non-overlapping writes, and run final checks.

Each fix starts with a failing regression test. Light-tier workers may not
publish, commit, use credentials, run paid probes, or change shared files
outside their assigned scope.

## Round 2: review the fixes

Cross-review the changed behavior, including constant-count streamed text,
late previous-stage replies, pause/cancel/policy gates, capture-owner changes,
archive migration/idempotence, and crash boundaries around follow-up receipt,
send claims, provider acknowledgment, and local acknowledgment persistence.

## Round 3: combined validation

Run all suites through qualification, type checks, copy budgets, production
build, and diff checks. Exercise available fake-client simulator flows.
Record actual outcomes and failures; do not treat simulated PR delivery as a
live repository change.

Live X, physical G2 behavior, OS lifecycle ownership, and paid provider
execution remain separate gates. Do not publish without owner authorization.

## Progress

- Streaming result regressions: eight failing checks reproduced, then fixed.
  Real-engine coverage reached 523 passing assertions.
- Legacy settings and capture ownership fixes passed their targeted checks.
  Registered the new 104-check voice suite with qualification.
- Archive fixes passed X (539), app-engine (552), store (95), and type checks.
  Publication timestamps remain optional for compatibility with old relays.
- Saved-history outage protection passed 65 new checks, including concurrent
  snapshots and repeated failures, plus the existing app-engine/store suites.
- Cross-review found a remaining legacy/watch capture identity gap. It is now
  fixed, with 213 passing voice checks. Independent review found no additional
  defects in the completed build-result protocols, startup settings, or archive
  changes.
- Durable X follow-up recovery is implemented. Pending instructions survive
  restart; send claims and acknowledgments are durable. Ambiguous outcomes
  require explicit owner resend/dismiss, on Setup and Now, rather than blind
  replay. The ledger is capped at 2,000 entries and fails visibly at the cap.
- Ordinary busy steering now reports that it did not send, so the phone keeps
  typed input for retry. Six steering regression checks pass, including retry
  after the first send settles.

## Final results

- All 12 registered suites passed qualification: 2,715 reported checks, zero
  failures. The follow-up and dev-fake suites report scenario groups; their
  internal assertions also passed.
- Type checking, copy budgets, production build, and diff checks passed.
  The existing Vite bundle-size warning remains.
- The first simulator run failed after a development reload restarted the app
  during review. The walkthrough now detects repeated runtime boots instead
  of reporting a misleading cascade. Actual dev-fake regressions also fixed
  incorrect integration branch and custom-repository PR evidence.
- A fresh, stable simulator rerun passed: offline recovery, planning,
  milestones, worker start, pause/resume, home/reopen while execution continues,
  review, PR gate, final/evidence, kept history, and new-build navigation.
  It recorded 36 scene transitions. The simulator microphone was unavailable;
  the microphone failure path passed, not live audio capture.
- Captures: `<audit-shots>/feature-round3-stable-20261011`.
  The earlier failing-run captures were preserved separately.
- No live X calls, paid provider runs, physical G2 tests, commits, or publishing.
  Simulated PR evidence is not a change to a real repository. Hardware and
  live-provider qualification remain outstanding.

## Deeper pass, October 11

The earlier 12-suite/2,715-check result is the baseline, not validation of the
changes below. Three read-only light-tier audits identified ten concrete bugs;
four light-tier implementation workers received separate write scopes.

| Defect | Fix plan and regression |
| --- | --- |
| Real Factory adapter flattens protocol newlines | Preserve line structure; test actual HTTP content blocks through real plan/work/review/PR parsing. |
| Malformed Factory POST acknowledgments look sent | Require a nonblank message ID; test uncertain delivery without blind retry. |
| Factory repair/integration/PR posts bypass launch gates | Classify execution posts and enforce policy/control/capacity at dispatch; test restriction changes and recovery. |
| Unrelated or credential-bearing PR URLs finish builds | Check GitHub PR shape, repository, and branch association; reject bad evidence before persistence. |
| Dismissed pending X follow-ups can still send | Atomically cancel the pending ledger and receipt with claim/attempt checks; test resume and send-claim races. |
| Importing an old edit can launch removed instructions | Resolve the latest revision before authorization; test changed, unmentioned, and unavailable latest revisions. |
| Stalled OAuth renewal blocks connection actions | Bound exchange/body reads; quarantine ambiguous rotation without automatic replay; test queued disconnect. |
| A paused build starves unrelated follow-ups | Preserve FIFO per mission while scanning past ineligible targets; test independent progress. |
| Accepted corrupt checkpoints crash runtime restoration | Validate restoration-consumed mission config/nested values; test rejected commits and older-checkpoint recovery. |
| Delayed submission overrides newer navigation | Preserve submission but guard focus/reset by selection generation; test deferred Home/Open/lifecycle handoffs. |

Independent cross-review found three further defects:

- A policy/control/capacity change during an awaited launch commit could still
  allow the provider call. Recheck at dispatch and classify refusal as safely
  unlaunched, not an ambiguous provider result.
- Initial and queued Factory build prompts still bypassed the new execution
  seam. Gate them too, including restored retries, without double-reserving
  an already-admitted worker.
- A mission's unknown/sending follow-up was omitted from head selection on
  subsequent drains. Hold later instructions for that mission until owner
  resolution or acknowledgment, while other missions continue.

The first combined qualification found one adapter-fixture mismatch: its
direct PR-parser test omitted the frozen mission repository and reviewed
branch required by the new evidence gate. The fixture was corrected, not the
production validation. Final combined results follow after dispatch/FIFO fixes.

### Live X check

The owner initially authorized current-token reads only, then authorized one
renewal after the access-token probe failed.
The local credential JSON was read in memory by `scripts/check-x-live.mjs`;
neither tokens nor post bodies were printed or committed.

- The production X transport made one direct API GET: `/2/users/me`.
- X returned **401**, classified as `auth`. The probe stopped before any
  account lookup, timeline, or single-post request.
- One subsequent OAuth POST returned **400**, classified as `auth`. It was
  not retried; no new token pair was saved and the credential file was unchanged.
- No X post/write, build submission, or confirmed credential rotation.
- This does not establish current credits, post visibility, deployed relay
  parity, mention-account ID, or successful OAuth renewal. A valid access
  token pair is needed for further live qualification.
- The X connector connect action was offered for independent account reads;
  it is separate from validating this app's own OAuth client.

### Settled deeper-pass results

- Thirteen verified defects were fixed, using four light-tier workers and
  independent cross-review. The last dispatch check is synchronous, after
  durable awaits, immediately before provider invocation. Initial/queued/
  restored Factory build instructions use the same guarded execution seam.
- All **14 registered suites passed**, with **3,201 reported checks** and zero
  failures. Some suites count scenario groups rather than individual assertions.
- One intermediate integrated run had an X assertion failure. Four isolated
  rechecks and the settled full qualification passed. Qualification now prints
  failed labels instead of hiding the diagnostics.
- Type checking, copy budgets, production build, and diff checks passed.
  The existing bundle-size warning remains (619.90 kB minified).
- The stable fake-provider simulator walkthrough passed **36 scene transitions**,
  including offline retry, plan/milestones, launch gate, pause/resume,
  home/reopening while work continues, review/PR gate, final evidence, retained
  records, and new-build navigation.
- Captures were saved separately in
  `<audit-shots>/deeper-stable-20261011`.
  Simulator audio capture was unavailable; only its failure path was verified.
- Successful live X authorization, renewal, deployed relay parity, actual
  provider execution, physical G2/lifecycle qualification, and structured
  SHA-review validation remain outstanding. This is not a release qualification.
- No real PR or X post was created. No token was printed or committed, no
  credential file changed, and nothing was committed or published.

### Release 0.2.20

- Version bumped to **0.2.20** in `app.json`, `package.json`, and
  `package-lock.json`. `npm run pack` stamped a 446.8 KB `spriite.ehpk` with
  the owner's relay origin in the network allowlist and package id
  `com.spriite.app`. No dev/fake seams are present in the packed build.
- Uploaded to the Even Hub developer portal as a **Private** build of the
  Spriite project on October 11, with a change log describing the hardening.
  Portal confirmation captured at
  `<audit-shots>/release-0.2.20-portal-20261011.png`.
- The self-hosted relay was not redeployed. Its changes are optional and
  backward compatible; redeploying `relay/` adds the `posted_at` archive
  timestamps the app already falls back from gracefully.
- The owner subsequently authorized commit `7e794c4`. It was not pushed.

## Post-0.2.20 execution incident

The owner reported Refresh → Start build → Confirm leaving the build with a
decision, while the app claimed 20% verified progress without implementation.
The approval was in Spriite, not a Factory-native approval dialog. The exact
failed phone snapshot/provider session has not been confirmed.

### Verified defects and fixes

- Planning counted as 20% verified implementation. Exclude the plan from
  progress, including restored older plan weights and spoken status counts.
  Request acknowledgment and observed tool activity remain 0% verified work.
- Factory workers omitted interaction mode and autonomy. Explicitly create
  approved workers in Auto, preserving the owner's selected autonomy instead
  of raising permissions. This removes an inherited-mode risk, but does not
  prove which setting the original failing session actually used.
- Worker questions were ignored or answered through the lead. Persist the
  asking worker and question, answer that existing session with the same
  request token, and queue simultaneous questions without creating extra workers.
- A newer worker question arriving before an answer POST acknowledgment lost
  its destination. Preserve the newer decision and pending prompt when the
  older send finishes; busy taps cannot dispatch another answer.
- Snapshot serialization initially omitted the new per-worker fields.
  Persist both questions and activity. On upgrade, re-observe previously
  swallowed questions, ignoring messages before the current request and
  questions carrying an older request token. Completed correlated results
  retire questions they supersede.
- Durable questions could retain obsolete options, gates, origin, or plan
  revision. Bind identity to the question, options, gate, worker session,
  request token, and stage. Reject stale phone input before ticks, process
  revision before creating decisions, and reject stale queued observations.
- An immediate question handoff recorded a real prior answer as merely closed.
  Attribute it only to its previous identity; the next question inherits no
  answer. Worker-answer controls now say Confirm answer, not Start the build.
- Final light-tier review found dropped reviewer questions, the wrong
  branch-only response format for PR-worker answers, and lost answer history
  on legacy records without question identity. Queue/persist reviewer questions,
  retain the PR-stage format, and bind legacy attribution to the specific
  still-current record before the input clears it.
- Drain queued worker questions when a lead answer, follow-up, or review
  clears the displayed question. Correlated verdicts retire their own questions,
  not unrelated untagged questions. Teach blocked replies to include the
  request token and remove protocol metadata from the displayed options.
- Include the accepted plan labels in decision identity. An identical question
  on a revised plan cannot credit one owner answer to both plan revisions.

### Validation and real execution evidence

- The initial five production-client HTTP regressions failed against the
  released engine and passed with the fixes. This is a synthetic HTTP boundary
  using production clients and parsers, not the dev fake or live execution.
- The registered boundary suite now contains 20 scenario groups, including
  upgrade recovery, parallel questions, stale tokens, activity without
  completion, superseded questions, delayed acknowledgment, reviewer queues,
  PR-worker answers, and clean correlated option text.
- All **15 registered suites passed**, with **3,252 reported checks**, zero
  failures. Copy budgets, TypeScript, production build, and diff checks passed.
  The existing bundle warning remains, 627.88 kB minified.
- Intermediate failures included obsolete copy/settings expectations and
  invalid fixtures (computer ID, result marker, and empty branch). Those were
  corrected without weakening production parsing. An intermediate X held-reply
  assertion failure did not reproduce in the settled run; metadata-only
  diagnostics remain. Its intermittent cause is not established.
- Combined validation also caught over-broad retirement of unrelated lead
  questions. Restrict verdict retirement to explicitly correlated questions;
  the existing mid-build question and history tests pass without weaker
  expectations.
- With owner permission, a paid isolated Factory check used the production
  engine/client dispatch in a new scratch repository. Only the worker's
  delivery instruction was changed to local-only work, with no push or PR.
  Haiku 4.5, low reasoning effort, and medium autonomy produced `add.py` and
  `test_add.py`. The independent function check and both generated Python unit
  tests passed. The probe observed real tool use, not only HTTP acknowledgment.
- Only the two probe sessions were interrupted afterward. The scratch
  repository has no remotes. The owner's original build was not restarted.

### Remaining limits

This proves real local file/test execution, not recovery of the owner's
specific build, the durable phone approval path on hardware, or end-to-end
push/review/PR delivery. Factory-native tool/spec approvals are not modeled by
the client and may still require Factory, especially at lower autonomy.
Structured SHA/diff review, successful live X authorization, and physical
G2/microphone/lifecycle qualification remain outstanding.

The fixes were local at qualification. The owner subsequently authorized the
private upload below, without restarting the original build or committing.

### Release 0.2.21

- Bumped `app.json`, `package.json`, and the root lockfile versions to 0.2.21.
  `npm run pack` passed copy budgets, TypeScript, Vite, and manifest packaging.
  The bundle-size warning remains.
- Artifact: `spriite.ehpk`, **448,908 bytes**, package `com.spriite.app`,
  SDK 0.0.16, minimum Even app 2.2.10. The packed allowlist and bundle retain
  the configured relay; this is not a demo-only package.
- SHA-256:
  `fd9320d73cf56746d16c585824b0f061855016be573466ecd3ec2998ceb102ed`.
- Uploaded through the authenticated Even Hub portal to **Spriite**. Both the
  private-build list and Build details confirmed **v0.2.21**, **Private**,
  **448.9 KB**, with the scoped execution-fix change log.
- No testing-group/store promotion, relay redeploy, commit, push, PR, or X
  post. No existing build restart. Source changes remain uncommitted.
- Uploading is not installation or confirmation that the owner's particular
  build has recovered. The execution limitations above still apply.

### Post-upload receive and readability fixes

- Confirmed defects: newest-first API history broke worker request boundaries;
  ordinary worker replies were ignored without a completion marker; watch
  priming omitted conversation history; chat entries were clipped to 240
  characters; native `AskUser` input was not observed.
- The adapter now orders turns by creation time, not streamed edit time.
  A snapshot marker lets old building workers re-observe discarded messages
  without starting another worker or replaying an answer.
- Full sanitized replies and paragraphs enter the phone chat and saved
  history. Same-count streamed edits are observed on the polling cadence.
  Reply visibility does not grant progress or completion credit.
- Native `AskUser` questions persist with their tool/session identity and
  close on matching observed tool results. Phone handoff opens Factory.
  Text, voice, menu, and durable approval paths cannot synthesize a native
  answer or record one as answered.
- Glasses history opens at the beginning of the latest incoming entry.
  Six-line, pixel-bounded pages preserve long tokens and Unicode instead
  of discarding their tails. Repeated views of the same question do not
  interrupt reading. Phone bubbles preserve paragraphs and word wrapping;
  unchanged polling views retain scrolling, and new replies open at their
  beginning when the owner was following the conversation.
- Validation: 16 suites, **3,272 passing checks**, zero failures. Includes
  production-adapter synthetic native-question/closure/restore checks,
  durable native approval rejection, and lossless pagination checks.
  Copy budgets, TypeScript, production build, and whitespace check pass.
  The production bundle still emits the size warning.
- Isolated fake-provider simulator screenshots confirm the ordinary
  question appears legibly on both phone and glasses. This is not native
  popup or physical G2 qualification. Owned validation processes stopped.
- Limits: the dismissed popup and the owner's correct live chat were not
  recovered. Native approvals other than `AskUser` are not modeled; native
  answering still requires Factory. Message fetch remains limited to the
  latest 100 messages; chat retention is bounded to 60 entries / 64 KB.
  Very old request anchors and replies beyond those bounds need further work.
- At qualification, no new package, upload, commit, push, live-session answer, restart,
  interruption, settings change, or relay deployment. Uploaded private
  0.2.21 does **not** contain these post-upload fixes.

### Release 0.2.22

- Owner authorized uploading the receive/readability fixes as a private build.
  Synchronized manifest, package, and root lockfile versions to 0.2.22.
- `npm run pack` passed copy budgets, TypeScript, Vite, and packaging.
  The bundle-size warning remains. Production relay configuration unchanged.
- Artifact: `spriite.ehpk`, **450,741 bytes**, `com.spriite.app`,
  SDK 0.0.16, minimum Even app 2.2.10.
- SHA-256:
  `134fc1b4d235ae144b7b46d9ca7e95a8adf4da7ace071cdae6963549d58a6598`.
- Uploaded through the authenticated portal. Independent project reload and
  Build details confirmed **v0.2.22**, **Private**, **450.7 KB**, and the
  saved receive/readability change log.
- No testing-group/store promotion, commit, push, relay deployment, or
  live-session restart/answer/interruption. Source remains uncommitted.
- Upload does not install the update or prove recovery of the owner's
  dismissed popup. The native-answering and retention limits above remain.

### Existing-chat activity clarity, local follow-up

- Reproduced the owner's false drafting report through opening a saved local
  planning chat. The saved phase and awaited reply were being treated as
  evidence of current Factory activity.
- Pending scenes now distinguish provider-reported running, queued (not
  running yet), idle with an unfinished result, and activity unconfirmed.
  Phone and glasses use the same scene. Idle scenes offer Talk and History;
  opening a chat, reading history, or checking status never sends a new request.
- Provider observations expire, clear on failed checks and new requests, and
  are not restored as live evidence. A running worker cannot make an idle
  reviewer appear active. Status cards yield to newer observations.
  Ready plans, owner questions, confirmed pauses, faults, and verified
  completion remain distinct from session activity.
- Watched responses are labelled `Last reply`, not presented as current work.
  Restored watches require a fresh status read. Unknown metadata stays unknown;
  a late read from the previous chat cannot change the newly opened chat.
- Validation: **16 suites, 3,296 passing checks, zero failures**. Production
  adapter regressions use synthetic HTTP responses, with no credentials,
  network, paid work, or live-session changes. Phone DOM checks cover all four
  activity states. Copy budgets, TypeScript, production build, and whitespace
  checks pass. The existing bundle-size warning remains (638.12 KB minified).
- Simulator walkthroughs and physical G2 verification were not run for this
  follow-up. These changes are local and uncommitted; the uploaded private
  **0.2.22** artifact does not contain them. No new package/upload or live
  restart, answer, interruption, settings change, or relay deployment.
- After the private 0.2.22 upload, the owner authorized committing and pushing
  its source changes. The proposed Herdr integration specification was then
  retained byte-for-byte in a local-only stash and removed from remote `main`
  by `a8cf7c4`. Earlier remote history is unchanged, not purged.

### Explicit next steps for existing sessions

- Confirmed-idle, message-capable chats offer **Continue**, **Send message**,
  and **History**. Continue sends one request to the existing conversation;
  it does not create a session/worker, change frozen settings, approve a
  build, or answer a native question. Active, queued, unchecked, paused,
  faulted, terminal, or question-blocked chats do not accept stale Continue
  actions. Durable control and current policy remain authoritative.
- Send message focuses the phone's text composer without starting a
  microphone or posting. On glasses it starts owner-selected message
  capture. Dictated command words are sent as message text, not interpreted
  as pause/restart/approval commands or new goals. Existing capture ownership
  guards still reject completion after navigation.
- Watch-only Factory chats offer **Open Factory**, linking to that exact
  session on the phone. Glasses explain that continuation and messaging
  must happen there. Unsupported Cursor watches remain read-only.
- A lost continuation acknowledgment says **Delivery unconfirmed**, not
  Sent to Factory. Late acknowledgments and queued retries cannot follow
  selection into another chat or append the old message to its history.
- Validation: **16 suites, 3,333 passing checks, zero failures**. Includes
  production-adapter continuation/double-tap/refusal/handoff regressions,
  phone composition and read-only links, durable policy/control refusals,
  and literal voice-message routing. Copy budgets, TypeScript, production
  build, and whitespace checks pass. The bundle-size warning remains.
- No simulator walkthrough or physical G2 testing for this follow-up.
  All work remains local and uncommitted. No new private package/upload,
  live-session continuation/restart/message, relay deployment, or Git push.
  The existing Herdr stash and remote current-tree removal are unchanged.

### Simulator qualification before private 0.2.23

- Owner required simulator testing before uploading. Ran an isolated
  persistent-runtime simulator on loopback against three synthetic saved
  chats, with no provider credentials, paid work, or live-session mutations.
  A dev-only command-file driver clicks the real phone DOM controls; glasses
  gestures use the simulator API. Fixture and driver are excluded from the
  production bundle.
- Final walkthrough: **24 passing checks**, no uncaught application errors.
  Verified inert opening, idle Continue/Send message/History, exact-session
  continuation without a new session, phone composer focus without capture,
  typed Send, active/queued/unknown/recovered-idle states, complete History
  paging through `HISTORY END`, and exact read-only Factory handoff.
- Visual review caught an incorrect History `DEMO` label and a phone
  `Working` header on idle/unknown sessions. History now preserves the
  selected context label; the phone header says `Session activity`.
  Read-only help explicitly permits reading here and distinguishes the
  provider's restriction on sending.
- Follow-up context investigation reproduced mixed histories across saved
  chats and a pending old history read blocking the next selection. Selected
  history is now isolated by session/agent. Selection changes invalidate old
  reads and acknowledgments, including returning to the original chat before
  an old request settles. No new request is sent just to read context.
  Up to eight recent watch tails are cached in memory during navigation;
  other provider history is fetched again on selection.
- Distinct synthetic context markers proved that the phone and glasses load
  the selected chat, including the deliberately read-only case. Regressions
  for context isolation, local-history return, blocked reads, and the phone
  header went red before their fixes and pass afterward.
- Initial automation timed out after captures and assumed one gesture per
  History page. Final automation waits for the exact command acknowledgment
  and scrolls to native text boundaries before asserting a page change.
  Failed attempts were not counted as passing evidence.
- Full qualification: **16 suites, 3,338 passing checks, zero failures**.
  Copy budgets, TypeScript, production build, and whitespace checks pass.
  The existing bundle-size warning remains (642.35 KB minified).
- Simulator CoreAudio capture failed. Its explicit microphone-error and
  no-send paths passed; actual live dictation remains unqualified. No
  physical G2, native-popup recovery, or original incident chat qualification
  is claimed. Other standard simulator walkthroughs were not rerun.
- Manifest, package, and lockfile synchronized to **0.2.23**. Copy checks,
  production build, and the packaging CLI passed after the simulator run.
  `spriite-0.2.23.ehpk`: **451,212 bytes**, `com.spriite.app`, SDK 0.0.16,
  minimum Even app 2.2.10. The existing production relay is unchanged.
  Generic ZIP inspection was not applicable to the CLI's `.ehpk` format.
- SHA-256:
  `babc4917950ff54771b56fe29c70f1ee1bf73b02d298b46e784d6199a742078a`.
- Owner authorized finishing the private upload after signing in to the
  newly opened portal page. Submitted as **Private**. Independent project
  reload and Build details verified **v0.2.23**, **Private**, **451.2 KB**,
  and the saved 384-character change log.
- No Git commit/push, testing-group/store promotion, relay deployment, or
  live-session restart/answer occurred. Source remains uncommitted. The
  Herdr stash remains local-only. Upload does not install the new build
  on the owner's phone or glasses.

### Local-only gateway timeout and legacy Continue repair

- Owner authorized local fixes and tests only. Synthetic HTTP regressions
  first reproduced 502/504 being labeled a terminal service failure, polling
  stopping, and lost Continue acknowledgments entering the resend queue.
  No live session was inspected, retried, messaged, or restarted.
- Factory 502/504 now retain their HTTP code as a timeout error. Lead and
  worker reads invalidate stale activity and continue observing instead of
  declaring the session failed. Restored old 502/504 polling/steering faults
  reopen reads; an old uncertain steering request is held, never replayed.
  The existing explicit computer-offline 503 behavior remains unchanged.
- Continue and ordinary session messages capture a fresh pre-dispatch
  message-ID baseline. A lost network acknowledgment or gateway/server 5xx
  outcome holds the request durably, blocks duplicate Continue/Retry/message
  delivery and new build admission, and keeps read-only observation working.
  Genuinely unsent queued turns retain their order; a failed queue head no
  longer lets later turns overtake it.
- Automatic receipt reconciliation requires a newly observed matching user
  message ID. An older identical turn, assistant reply, or idle status is
  not acknowledgment. Restore preserves uncertainty; missing/invalid
  correlation evidence requires owner review, and another selected chat
  cannot inherit the hold or its Factory link.
- The phone disables new sends and offers the exact Factory session link.
  Glasses offer History, Open Factory, and Resolve immediately. Resolve
  separates an explicit owner receipt from Stop waiting, which clears local
  queued requests without claiming receipt, retrying, approving a build,
  interrupting Factory work, or promising the original cannot still arrive.
  Owner resolutions remain in the local chat.
- Only an awaited, managed legacy plan upgrades its response protocol on
  Continue. The request retains the original goal, repository, and frozen
  permissions/settings and asks for a numbered plan with final completion
  marker. Opening a watch never adopts it. Markerless plans remain awaited;
  a completed plan still requires the existing build approval.
- A failed pre-send history read sends nothing and preserves the legacy
  protocol. A last-minute native AskUser discovered in that read blocks the
  POST and keeps its exact question identity and Factory answer link.
  Pause/control, native-question, policy, and terminal priorities remain.
- Full final automated qualification: **16 suites, 3,354 passing checks,
  zero failures**. Copy budgets, TypeScript, production build, and whitespace
  checks pass. The existing bundle warning remains: **651.28 KB minified**.
  The synthetic provider and probe are excluded from production.
- Isolated loopback simulator walkthrough: **14 passing checks**, no uncaught
  application errors. Real phone DOM controls and glasses gestures exercised
  uncertain delivery, continued reads without replay, older identical-turn
  exclusion, exact Factory handoff, disabled composition, cross-chat
  isolation/return, History, explicit receipt, and release without resend or
  worker creation. Phone captures and alpha-composited glasses captures were
  visually reviewed. Evidence is under `.screenshots/delivery-timeout/`.
- The first simulator attempt failed after three checks: a transient
  sent-message notice hid the Factory link and Resolve controls. The fix
  bypasses that notice for uncertain delivery; only the clean rerun counts
  as passing evidence. The final native pre-send guard is qualified by
  automated regression, not a physical popup or simulator-native popup.
- No physical G2, microphone/dictation, real gateway, or original incident
  session recovery is claimed. Other simulator walkthroughs were not rerun.
  Only owned simulator/development-server processes were stopped.
- No version bump, packaging, upload, Git commit/push, relay deployment,
  store/testing-group promotion, or live-session mutation. The released
  private 0.2.23 artifact retains its recorded SHA-256; these repairs remain
  local and uncommitted. The Herdr stash is untouched.

### Authorized private 0.2.24 upload

- Owner authorized uploading the locally qualified repairs. Manifest,
  package, and lockfile versions are synchronized to **0.2.24**.
  Package identity, SDK minimum, permissions, and production relay are
  unchanged.
- Copy checks, TypeScript/production build, manifest validation, and the
  official packaging CLI passed. Behavioral qualification remains the
  **16 suites / 3,354 checks** and **14 simulator checks** recorded above;
  the release preparation changed version metadata only.
- Artifact: `spriite-0.2.24.ehpk`, **454,408 bytes**, `com.spriite.app`,
  minimum Even app **2.2.10**, SDK **0.0.16**. SHA-256:
  `3d29a6af3b0e006854bba94fc5e6900ae22e2d7f77e6fb6d23925701a7a162e3`.
  Packed whitelist retains `https://<owner relay host>`.
- Uploaded to the existing Spriite project as **Private**. A fresh project
  reload and Build details independently verified **v0.2.24**, **Private**,
  **454.4 KB**, and the saved **439-character** changelog. Portal evidence:
  `.screenshots/delivery-timeout/private-0.2.24-portal.png`.
- No store/testing-group promotion, relay deployment, live-session retry,
  device installation/restart, Git commit, or push. The desktop-owned
  browser remains open. Source remains uncommitted; the Herdr stash and
  released 0.2.23 artifact are unchanged. Live-session recovery, dictation,
  and physical G2 qualification remain unverified.

### Local watched-chat scope-to-execution handoff

- Reproduced the planning loop on a watched, planning-only Factory chat.
  Phone text, general glasses voice, and glasses Send message now recognize
  the same narrow whole-utterance build request. Ordinary messages remain
  literal. A markerless complete plan is a candidate for owner review, not
  an automatic `PLAN_READY` or execution grant.
- The review includes the original goal, selected outcome, repository,
  quoted prior context, and complete done-means criteria. Confirmation
  requires a fresh idle read with unchanged scope and selection. Native
  questions, delivery uncertainty, navigation, policy, pause, capacity, and
  failed durable saves retain their existing safety boundaries.
- A foreign watch creates a durably approved managed execution with a
  non-editing coordinator and one worker using the selected provider and
  frozen settings. Owned chats recover their controller. Repeating the
  build request uses the saved source-session association, not another
  worker. Restored review drafts and external inputs cannot grant approval.
- Automated qualification: **16 suites / 3,445 passing assertions**.
  Execution-boundary coverage includes **55 scenario groups**. Copy checks,
  TypeScript, production build, and whitespace checks passed. Production
  bundle: **666.08 KB**, with the existing >500 KB warning. Dev fixture and
  probe markers are absent from the production bundle.
- The first nominal 13-check simulator pass was rejected after visual
  review exposed a handled storage fault. Stronger checks later reproduced
  an eight-second bridge KV-write timeout after a render timeout during an
  in-flight WebView capture. The broken store correctly refused the next
  Cursor dispatch; no launch was attempted. Outbox diagnostics now include
  the commit rejection reason without request content or credentials.
- The walkthrough separates html2canvas phone captures from in-flight
  dispatch saves, observes the native framebuffer at worker start, and
  waits through review to synthetic PR evidence and confirmed receipts.
  The final clean run passed **17 checks**, with healthy storage, zero
  unresolved dispatches, no handled provider/storage faults, and no uncaught
  errors. Phone captures and the alpha-correct glasses contact sheet were
  visually reviewed. Evidence is in `.screenshots/build-handoff/`, including
  preserved rejected runs. This does not claim that general SDK/bridge
  unavailability is repaired or that physical G2 execution is qualified.
- Voice input here uses synthetic transcripts through the actual router,
  not microphone/dictation. Providers, review verdicts, and PR delivery are
  synthetic. No live original-session recovery or native-popup interaction
  is claimed. Other simulator walkthroughs were not rerun.
- No version bump, packaging/upload, Git commit/push, relay change, store
  promotion, or live-session send. Released private 0.2.23 and 0.2.24
  artifacts retain their recorded SHA-256 values; the Herdr stash is
  untouched. Only owned test processes are stopped.

### Authorized private 0.2.25 upload

- Owner authorized uploading the qualified local handoff changes. Manifest,
  package, and lockfile versions are synchronized to **0.2.25**. Package
  identity, SDK minimum, permissions, and production relay are unchanged.
- Manifest validation, copy budgets, TypeScript/production build, and the
  official packaging CLI passed. Behavioral evidence remains the **16
  suites / 3,445 assertions** and **17 synthetic simulator checks** above;
  release preparation changed version metadata only.
- Artifact: `spriite-0.2.25.ehpk`, **458,408 bytes**, `com.spriite.app`,
  minimum Even app **2.2.10**, SDK **0.0.16**. SHA-256:
  `208c4a6a94e008bee5d49f88e704926a7135314167bfde5f66f7d845c8789d96`.
  Packed whitelist retains `https://<owner relay host>`.
- Uploaded to the existing Spriite project as **Private**. A fresh project
  reload and Build details independently verified **v0.2.25**, **Private**,
  **458.4 KB**, and the saved **454-character** changelog. Portal evidence:
  `.screenshots/build-handoff/private-0.2.25-portal.png`.
- No promotion, live-session send/retry, relay deployment, device install
  or restart, Git commit, or push. The desktop-owned portal browser remains
  open. Released 0.2.23/0.2.24 checksums and the Herdr stash are unchanged.
  Bridge-unavailability, physical G2, dictation, native-popup, and original
  live-session recovery limits remain as documented above.

### Local MVP fidelity, malformed X plan, and native-question navigation repair

- Reproduced the owner's complete Continue → fidelity question → **MVP core
  workflow** → ordinary Define/Prepare/Implement/Validate reply, rather
  than testing only a final-plan snapshot. Eleven failing regressions
  preceded the repair. Complete ordinary milestone descriptions now offer
  **Review build**. A later owner turn invalidates the older plan; a stale
  Continue action reviews current scope instead of sending another
  planning request. Phone text, general glasses voice, and glasses Send
  message retain the same explicit-review/confirmation boundary.
- The exact unnumbered Assess/Integrate/Validate/Launch X reply with inline
  `PLAN_READY` is reviewable, not automatically approved. Inline-marker
  normalization is confined to scope candidates; strict automatic
  readiness remains unchanged. The Plexo URL remains reference material,
  never a replacement for the frozen destination repository.
- Native question cards expose **Read / Open on phone / Builds**. The
  phone action focuses the exact clickable Factory session link without
  opening or answering the popup. Back and Builds leave the question view
  without cancelling work, answering, or discarding an unresolved
  delivery hold. Returning re-observes the pending Factory question.
  Managed tasks retain their controller when another task is selected.
  The lobby also preserves an unsubmitted held goal.
- Full automated qualification: **16 suites / 3,471 passing assertions,
  zero failures**, including **56 execution-boundary scenario groups**.
  Copy budgets, TypeScript/production build, script syntax, whitespace,
  and dev-fixture/probe exclusion checks pass. The existing >500 KB bundle
  warning remains: **670.48 KB** minified.
- Two fresh isolated simulator runs passed:
  - **11 fidelity-flow checks**: native Continue and fidelity selection;
    inert review; cancel/review through general voice and Send message;
    exact owner clarifications; one owned coordinator plus one worker;
    synthetic review/PR delivery with zero unresolved dispatches.
  - **12 native-navigation/X checks**: exact phone link and focus; X
    admission while the original native question remains selected;
    native Back; selecting the independently admitted X task; inert
    malformed-plan review; confirmation reusing its existing coordinator;
    one worker; task switching and preserved unanswered question; final
    synthetic PR delivery.
- Both runs finish with healthy storage, no handled provider/storage
  faults, and no uncaught application errors. Phone captures and
  alpha-composited glasses captures were visually reviewed. Evidence:
  `.screenshots/fidelity-flow/evidence.json`,
  `.screenshots/navigation-x/evidence.json`, and
  `.screenshots/mvp-native-x-contact.png`.
  An initial navigation run failed because the test matched a lower-case
  title against the app's capitalized title. Its evidence is preserved as
  `title-case-fixture-failed-evidence.json`; only the fresh clean rerun
  counts as passing.
- X simulator admission calls the real local supervisor with a synthetic
  source-approved X command. It does not poll X or exercise a live tag.
  Providers, question records, verdicts, and PRs are synthetic. Voice uses
  injected transcripts through the actual router, not a microphone.
  Native touch gestures and phone DOM controls are real simulator inputs.
  No physical G2, real Factory popup interaction, live dictation, original
  incident-session recovery, external Plexo access, or general SDK/bridge
  availability qualification is claimed. Other simulator walkthroughs
  were not rerun.
- These changes are **local and unshipped**. Private **0.2.25 does not
  contain this repair**. No version bump, packaging/upload, live-session
  send, relay change, Git commit/push, or promotion. Released
  0.2.23/0.2.24/0.2.25 artifacts retain their recorded SHA-256 values.
  The Herdr stash and desktop-owned portal browser remain untouched.
  Only owned simulator/development-server processes are stopped.

### Team-led local scope, delivery, cancellation, and UI bug hunt

- Owner requested an independent team investigation and local repairs.
  Three reviewers found eight additional reproducible bugs: stale canonical
  scope after owner restrictions; approval racing a newer owner turn;
  ambiguous decision/worker POST replay; losing an in-flight watched POST
  on navigation; discarded refused dictation; detached Factory-link focus;
  false “Sent” feedback for local Continue review; and cancellation missing
  a late-confirmed worker. Each workstream added failing regressions before
  its fixes.
- New owner turns invalidate readiness and approval drafts. Fresh execution
  context retains owner restrictions. Approval rejects superseded history
  reads. Decision answers and Factory worker instructions now use
  per-session receipt baselines and uncertainty holds, including restore
  and navigation. Neither ticks nor Retry blindly repeat an ambiguous POST.
  Later genuinely unsent coordinator turns remain queued.
- The managed actor awaits an acknowledged receipt-state checkpoint before
  protected transport. Four integration checks cover actual decision and
  worker POSTs, failed storage, and pause during the save. Disabling the
  barrier in the synthetic fixture reproduces both persistence failures.
  An old retry regression wrongly expected a network-ambiguous instruction
  to replay; it now tests an explicit pre-transport refusal and current
  policy before recovery instead.
- Runtime lobby and legacy watches recover independent receipt state from
  `spriite.watch-receipts.v1`. Serial acknowledged writes retain attempts
  while another mission is selected; persisted tombstones prevent stale
  SDK/UI snapshots from resurrecting resolved holds. Unknown reads/writes
  block sends. Damaged identifiable entries remain holds; unidentifiable
  corruption cannot be bypassed with the receipt-resolution controls.
  This state restores no approval, worker settings, or task ownership.
- Receipt-store bounds: 128 session entries including tombstones,
  2,000,000 JSON characters, 160,000 message characters, and 2,000 baseline
  IDs. There is no silent eviction. Failed clear persistence may
  conservatively restore a hold. This is an acknowledged-write barrier,
  not a cross-instance CAS/lease guarantee.
- Cancellation reconciles live identities and confirmed outbox receipts,
  including late Cursor agents, Factory workers, and Factory leads.
  Capacity remains held through outstanding launch/cleanup requests; late
  leads cannot submit a new planning POST after cancellation. Confirmation
  states accepted requests or partial/manual cleanup, never proof that all
  remote work stopped.
- Refused dictation remains complete in a separate target-bound phone
  draft. Copying is explicit, does not send, cannot overwrite typed text,
  and cannot bypass holds or native questions. Drafts survive navigation
  during the current visit, not reloads; the UI states that limit.
  Factory handoff focuses the link after rendering, and local scope-review
  feedback no longer claims delivery.
- Integration also repaired once-only background-question notifications:
  leaving a focused question notifies immediately; refocusing and status
  updates do not reset the notification history; pending banner entries
  remain available.
- Final qualification: **21 suites / 3,554 passing checks, zero failures**.
  New standalone team suites report scenario groups, counted by their
  passing labels. Coverage includes **12 scope/delivery groups**, **6 UI
  groups**, **38 cancellation checks**, **4 managed-persistence checks**,
  **16 watch-store groups**, and **58 execution-boundary groups**.
  Copy, TypeScript/production build, script syntax, whitespace, and
  production dev-fixture exclusion checks pass. The existing >500 KB
  warning remains: **685.15 KB** minified.
- Fresh post-integration simulator runs: **11 fidelity-to-worker checks**,
  **12 native-question/navigation/X checks**, and **14 uncertain-delivery
  checks**, **37 total**. Execution runs reach synthetic PR delivery with
  healthy storage and zero unresolved dispatches, without handled
  provider/storage faults. The timeout scenario deliberately injects an
  acknowledgment loss and verifies no replay, exact-session isolation,
  return, History, explicit receipt, and release. All runs have no uncaught
  application errors. Phone and alpha-correct glasses captures were
  visually reviewed.
- New evidence preserves the earlier walkthroughs:
  `.screenshots/team-fidelity/evidence.json`,
  `.screenshots/team-navigation-x/evidence.json`,
  `.screenshots/team-delivery-timeout/evidence.json`, and
  `.screenshots/team-qualified-glasses.png`.
  The simulator does not prove cross-process SDK durability; reload,
  corruption, mutation races, and checkpoint boundaries use synthetic KV
  tests. Cancellation and refused-dictation checks are automated production
  function/actor tests, not physical microphone/provider tests.
- No live provider/X sends, real popup answering, original incident
  recovery, physical G2, live dictation, cross-instance lease, or long
  background-soak qualification is claimed. Other simulator walkthroughs
  remain skipped. General SDK/bridge availability is not claimed repaired.
- Changes remain **local and unshipped**, version **0.2.25** unchanged.
  No packaging/upload, commit/push, promotion, relay modification, or
  device restart. Released 0.2.23/0.2.24/0.2.25 checksums are unchanged.
  The Herdr stash and portal browser remain untouched. All owned test
  simulator/server processes were stopped.

### Authorized private 0.2.26 upload

- Owner authorized uploading the qualified MVP/navigation and team-led
  repairs. Manifest, package, and lockfile versions are synchronized to
  **0.2.26**. Package identity, SDK/app minimums, permissions, and relay
  remain unchanged.
- Manifest/version validation, copy checks, TypeScript/production build,
  official packaging CLI, production fixture exclusion, and whitespace
  checks pass. Behavioral evidence remains the **21 suites / 3,554 checks**
  and **37 fresh simulator checks** above; release preparation changed
  version metadata only. The existing bundle-size warning remains.
- Artifact: `spriite-0.2.26.ehpk`, **463,297 bytes**, `com.spriite.app`,
  minimum Even app **2.2.10**, SDK **0.0.16**. SHA-256:
  `d8b14bcaa992282d93646b0218e1de7c2e1dc62a1e0e14e4e544d6af71217682`.
  The CLI's packed manifest retains
  `https://<owner relay host>`. The artifact header identifies
  an EHPK container; no ZIP-based manifest extraction is claimed.
- Submitted to the existing Spriite project as **Private**. Independent
  project reload and Build details verified **v0.2.26**, **Private**,
  **463.3 KB**, and the complete saved **473-character** changelog. Portal
  evidence: `.screenshots/team-navigation-x/private-0.2.26-portal.png`.
- No testing-group/store promotion, relay deployment, live-session
  send/retry, device installation/restart, Git commit, or push. The
  desktop-owned portal browser remains open. Earlier released artifacts
  and the Herdr stash remain unchanged. Device/live-provider recovery and
  cross-instance receipt-locking limits remain as documented above.
