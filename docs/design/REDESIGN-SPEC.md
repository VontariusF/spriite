# Spriite redesign: build spec

The mockups in `docs/design/redesign/` are the source of truth for the phone companion, the
glasses HUD and the Spriite character. The build matches them exactly: layout, copy, colours,
type, spacing, radii, states and flows. Where a mockup and older code or docs disagree, the
mockup wins. A deviation is allowed only where the hardware or platform makes the mockup
impossible; each one is listed in "Recorded deviations" below with the reason.

Each `*.dc.html` file is plain HTML with inline styles and a small `renderVals()` script; open it
in a browser or read the markup for exact values. `canvas.json` lists every board.

## Boards and where each lands

| Board | Screen | Lands in |
|---|---|---|
| `Main.dc.html` | Welcome: pair / key only / move from another phone | phone, first run |
| `Pair.dc.html` | Run `npx spriite pair`, type the 6-character code or scan QR, step 1 of 3 | phone setup |
| `Paired.dc.html` | Review what came over; choose where builds run (computer or Factory cloud), step 2 of 3 | phone setup |
| `Repo.dc.html` | Where builds go: new private repo per idea (default) or one repo; search or paste a GitHub URL; key-only variant shows the Factory key field; step 3 of 3 | phone setup |
| `Ready.dc.html` | Ready; optional extras: spoken replies, X, Cursor | phone setup |
| `Home.dc.html` | Glasses mirror, Needs you, Start something new, Builds; bottom tabs Home / Builds / Settings | phone main |
| `Mission.dc.html` | Build detail: milestone timeline, who's working, latest messages, message bar with talk and pause | phone |
| `Ask.dc.html` | Question sheet with radio options, Say it, Send answer | phone |
| `Settings.dc.html` | Connections with health, How builds run, Your setup (move, backup, pair another computer), Advanced (Factory-native details, relay and host, durable runtime and developer flags) | phone |
| `Move.dc.html` | Transfer code + QR, expiry, what moves | phone |
| `HudIdle/Listen/Run/Ask/Done.dc.html` | Glasses scenes, drawn at 2x (divide every coordinate and size by 2 for the 576x288 display) | `src/render`, `src/scenes`, `src/factory/copy.ts` |
| `Sprite.dc.html` | The character renderer: `POSES` table and `drawFrame()` produce the exact 32x32, 0-15 level frames | `src/sprite/frames.ts`, `animator.ts`, `resolve.ts` |
| `MotionLab.dc.html` | Pose names, the moments each pose is shown, frame counts and timings | sprite triggers |
| `SetupCompare.dc.html` | Rationale; its "Proposed" column is the product contract for setup | docs |

## Design tokens (phone)

Ground `#07110A`, surface `#0D1A11`, raised `#13241A`, selected surface `#0F2215`, line `#1F3326`,
strong line `#24452F`, text `#EAF5EC`, muted `#9AB1A0`, accent `#5CE57D`, accent ink `#04210E`,
needs-you amber `#F2B740` on `#1E1705`, Factory `#7DBEFF`, Cursor `#BDA4FF`, danger `#FF8A7A`.
Type: Bricolage Grotesque 600/700 for display, Instrument Sans 400-600 for UI, JetBrains Mono 500
for codes and commands. The fonts are bundled into the package as files, not loaded from Google
at runtime. Radii are 10/12/14/16/18/20/24 as drawn. Touch targets are at least 44 px.

## Glasses HUD

Divide the boards by 2. The canvas is 576x288. Context line at y 14, sprite 64x64 at (24, 68),
main text at x 112, width 440. Segmented milestone bar (done solid, in review dotted, remaining
dim). The actions row shows one focused action with a border; the other actions are dimmed. The
colours map to text levels: `#B8FFC8` = 4, `#9DFFB0` border, `#5BC874` = 3, `#3A8A4E` = 2.

## Spriite character

Port `drawFrame()` and `POSES` from `Sprite.dc.html` exactly. Output levels 0-15 into the
existing 64x64 image container, with each pixel doubled. Pose ids: idle, listening, talking,
thinking (named Planning), building, delegating, checking, asking, celebrate, blocked, paused,
offline. At glasses speed each frame shows for at least 1000 ms. Spriite has no crosses or
plus shapes anywhere: a stem and leaf sprout from its head (`leaf`: on, burst with a second
leaf, dim drooping, off as a closed bud) and confetti falls as short diagonal flecks. Map the engine and mission
states onto these poses using the moments each pose is shown in `MotionLab.dc.html`.

## Behaviour the mockups require

1. **Pairing (`npx spriite pair`).**
   - A `spriite` bin runs on the Factory host. It installs or starts the native broker and
     discovers what it can:
     - the Factory key from the droid login or `FACTORY_API_KEY`,
     - the Droid computer id,
     - the GitHub token from `gh auth token`,
     - the private host URL,
     - the bearer token,
     - the owner and machine.
   - It prints a 6-character code (shown as `K7Q-2MF`) and a QR code.
   - The phone sends the code; the bundle comes over end-to-end encrypted through the relay. The
     relay never sees plaintext.
   - The bundle cannot be decrypted offline by guessing the code: use a PAKE (for example SPAKE2
     or CPace), or have the code carry only a rendezvous id while the key travels in the QR or
     is confirmed on the host.
   - The code works once and expires after 10 minutes.
   - The Review screen shows what was found; anything missing is marked "Later".
2. **Key-only path.** The same flow without the computer: Factory key on the repo step, builds
   run in Factory's cloud.
3. **Repository step never blocked.**
   - The default is a new private repo per idea, named from the request.
   - Pasting any GitHub URL works without a GitHub or Cursor key.
4. **One home screen.** The Now and Setup tabs are replaced by Home / Builds / Settings. The
   Factory-native form moves to Settings › Advanced, and its fields are prefilled from pairing.
5. **Move to another phone.** A one-time code plus QR that expires in 10 minutes. It moves keys,
   host link, defaults and history, encrypted with the code (same anti-offline-guessing rule).
   The new phone's Welcome › "Move from another phone" accepts it.
6. **X connect.** Sign-in opens on the paired computer (the host runs the PKCE flow). The phone
   never asks for token JSON.
7. **Spoken replies** use the ElevenLabs key; Paste-in is the only phone-typed secret left, and
   it is optional.
8. **Existing behaviour stays.** Missions 2.0 native execution, X intake routing (X builds never
   land in the Spriite repo unless designated), trusted-host policy, holds, outbox, archive and
   every test in `scripts/qualify.mjs` keep working. Tests that assert old UI copy or layout are
   updated to the new design, never deleted to make them pass.

## Recorded deviations

Each row is a place where the build differs from a board, with the reason. The per-package
sources (with interpretations and integration notes) are in `docs/design/deviations/`.

| Package | Board | Difference | Reason |
|---|---|---|---|
| setup | Main, Pair, Paired, Repo, Ready, Move | Screens are fluid width and fill the viewport height (`min-height: 100dvh`) instead of the fixed 390x844 / 390x900 artboards; paddings, gaps and every inner size are the board's. | Phones differ in size; at 390 px wide the layout is the board's. |
| setup | Main, Pair, Paired, Repo, Ready | Navigation links drawn as `<a href="...dc.html">` are `<button>` elements with the same box, font and colour. | In-app navigation, not page links; the external links (Node.js installer, Factory API keys) stay `<a>`. |
| setup | Pair | "No Node?" opens `https://nodejs.org/en/download`; the board's link is `#`. | The board has no target; this is the official Node.js download page. |
| setup | Pair | Copy shows "Copied" for 2 s after a successful clipboard write; without the Clipboard API the command text is selected instead. | Undrawn state; the platform may refuse clipboard writes. |
| setup | Pair | Each pairing failure shows a short message in `--sp-danger` (13 px) directly under the code boxes: not_found, expired, used, wrong_code, unreachable, cancelled, invalid. An incomplete code shows "Type all six characters of the code." | Undrawn state. |
| setup | Pair | While a claim is pending, Connect reads "Connecting…", is disabled and the code boxes are disabled; Back aborts the claim. | Undrawn busy state. |
| setup | Pair | "Scan the QR code instead" opens the camera inline (BarcodeDetector + getUserMedia) only where both exist; otherwise it shows the muted note "Scanning isn’t available on this phone. Type the code instead." | The Even app webview and several mobile browsers have no BarcodeDetector; the camera cannot be read without it. |
| setup | Pair | Code boxes accept a pasted or autofilled whole code (spread across the boxes) and use the mono face at weight 600 as drawn. | Behaviour the board implies; no visual change. |
| setup | Paired | Rows for anything missing read "Later" with an honest detail: "No Factory login found", "No Droid computer found", "No host link found", "No GitHub CLI login found", "No ElevenLabs key found". A found ElevenLabs key reads "ElevenLabs key from your computer" with Found. An offline computer reads "<name> · offline". GitHub with an unknown count reads "From the GitHub CLI"; one repo reads "1 repo". | The board draws one combination of found/missing. |
| setup | Paired | "Looks right" reads "Saving…" while the bundle is applied; if nothing could be saved, a danger line "Some keys didn’t save. Try again, or change them later in Settings." appears above the button. | Undrawn states. |
| setup | Paired | In the Settings context ("Pair a different computer") the step bar still reads 2 of 3 and "Looks right" returns to Settings. | The plan fixes this flow (Pair › Paired › Settings); no separate board. |
| setup | Repo | Paired path whose bundle carried no Factory key shows the key-only "Factory API key" block too (builds keep the chosen run-on). | Setup cannot finish without a Factory key; reuses the drawn key-only block. |
| setup | Repo | The chosen repo row shows an accent check in place of the chevron (`aria-pressed`). | Undrawn selected state. |
| setup | Repo | List states: "Loading your repos…", "Couldn’t load your repos. Paste a GitHub link instead.", "No repo matches. Paste a GitHub link to use any repo."; a pasted link row's meta is "GitHub link"; a saved repo not in the list shows "Current choice". With no GitHub token and nothing typed the list card is hidden. At most 6 rows show until the search narrows them. | Undrawn states; the board draws three rows. |
| setup | Repo | Row meta ages are today / this week / this month / last month / N months ago. | The board shows three of these; "this month" covers 7-29 days honestly. |
| setup | Repo | Finish setup is disabled (45% opacity) only while the key-only field is empty; while the key is checked it reads "Checking…"; a rejected key shows the message in `--sp-danger` above the button and stays. | Undrawn states. |
| setup | Repo | A valid pasted GitHub link selects itself (mode "One repo I choose", the row's accent check) so Finish saves it without another tap. "One repo I choose" with no repo chosen does not finish: "Pick a repo from the list or paste a GitHub link." shows in `--sp-danger` above the button. | Undrawn states (spec behaviour 3: pasting any GitHub URL works); finishing with no repo would save a mode with nothing to build in. |
| setup | Ready | A configured extra (ElevenLabs key, X connected or host reader on, Cursor key) shows an accent check with "Added" / "Connected" instead of its button. | Undrawn state for returning from an extra. |
| setup | Ready | With no paired host the X detail reads "Tag your Spriite account. Sign-in opens on your computer." | The board names the paired host; key-only and moved setups may have none. |
| setup | Ready | "Add key" opens that key's sheet above the setup flow (z 40 over the flow's 30); closing it returns to Ready, which repaints (Added). "Connect" shows the X sign-in outcome as one 13 px line under the extras (`--sp-muted`, or `--sp-danger` when it failed). | Undrawn states: the board draws only the buttons, and the outcome must be visible where the owner tapped. |
| setup | Move | The QR is drawn from `pairing.qrMatrix(offer.qrText)` as an SVG in `--sp-accent-ink` inside the 200 px `#EAF5EC` tile with a 12 px quiet zone. | Replaces the board's "[QR CODE]" placeholder. |
| setup | Move | States: "Making a code…" while the offer is created; at zero the amber line becomes "This code expired." in `--sp-danger` with a "Make a new code" outline button; a failed offer shows its reason the same way (code reads "— · — · —"); a finished move reads "Moved. The new phone has everything." in accent. | Undrawn states. |
| setup | Move | With no paired host the first line reads "Every key and the link to your computer". | The board names the paired host. |
| setup | Move | A code longer than the board's 15 characters (words run to six letters, e.g. "QUARTZ · 64 · FOAM") steps its 26 px size down in proportion so it stays on one line. | The 390 px phone leaves the code about 296 px; a 20-character code at 26 px mono with 0.08em tracking needs about 350 px. |
| setup | Move (receiver) | Undrawn screen composed from Pair: back button without a step bar, heading "Move from another phone", lead "On the old phone, open Settings › Move to another phone. It shows a code.", the Pair code card with three boxes (word · 2 digits · word, dashes between), Scan button, listening row "Listening for your other phone…", and Connect. Success goes straight to Ready. | The plan fixes this as "undrawn screen composed from Pair". |
| phone | Home | The glasses pill has two undrawn states: "Glasses off" and "Checking glasses", in the same pill shape with muted colours (`--sp-muted` text, `--sp-surface` ground, `--sp-radio-off` dot). | The board draws only "Glasses on"; the glasses link is hardware state that can be down or unknown. |
| phone | Home | When the build that is asking is not the one on the glasses and its engine does not say what the question offers (the legacy one-build engine), Needs you shows its question with one amber "Answer" button (it brings the build in and opens the Ask sheet with every option). Under the durable runtime the card is exactly as drawn for any build (first two answers + See all options). | Only the durable runtime's `pendingAsks()` carries each question's options; the other engines expose an unfocused build's question text only. |
| phone | Home | Held X posts, uncertain X follow-ups and held native requests appear as rows inside the Needs you card with their existing controls (Build it, New repo, Not now, Resend (may duplicate), Dismiss, Review). | The board draws one question; these items keep their exact confirm and dismiss rules, which need their own controls. |
| phone | Home | The mirror hides Open build and Pause while the glasses show the home list, the goal list or an idle card with no build, shows "Resume" when the build is paused, and "Needs attention" on a failed build. | Undrawn states. |
| phone | Home | "Start something new" shows a one-line help only in undrawn states: the one-build legacy engine, and New repo without a GitHub token. The status line under it reports the outcome of every phone action. | The board's default state has no help line and the build matches it; these states must not promise a build that cannot start. |
| phone | Home | The old "Repository name (optional)" field is gone: a goal sent with New repo on gets a repository named from the goal through the existing path. New repo is on by default when "New repo per idea" is chosen; otherwise it turns off after one use. | The board draws only the chip. |
| phone | Home | The Home tab shows an amber count badge when items wait and Home is not on screen. | Undrawn; replaces the old Now-tab badge so waiting work stays visible from Builds and Settings. |
| phone | Builds (undrawn) | The full builds list in the Home builds-card style with source filter chips (All N, Spriite N, Factory N, Cursor N) in the Home chip style, an empty state, and the resume/watch hint. | No board; composed from Home as the plan's interpretation fixes. |
| phone | Mission | "More actions" opens an inline menu with the glasses' actions for this card (Continue, Send message, Open PR, Open Factory, Retry, ...) and "Answer in Factory" when Factory asks a native question. | Undrawn; every action the glasses offer stays reachable on the phone. |
| phone | Mission | With no milestones in the engine's snapshot, the timeline shows one current step (the card's label and status). Done and next steps show the milestone's status ("Checks passed", "In review", "Being fixed", "Not started"); the current step shows the build's live status. | The engines carry milestone labels and statuses, not the board's sample detail copy ("you approved at 2:10"). Nothing is invented. |
| phone | Mission | "Who's working" lists the Lead, each worker from the snapshot's jobs and the reviewer; it is hidden when the snapshot has no jobs and no session (a watched cloud build). Worker names read "Worker" or "Worker · Cursor" with the job label as what it is doing. | The engines expose jobs, not per-worker role names ("Worker · API"). |
| phone | Mission | The Lead row reads the board's "Planning" (accent) while a build runs; undrawn Lead states are "Asking" (a question is open), "Reviewing", "Paused" and "Done". Its doing line is the Lead's own activity from the card and the jobs ("Splitting the work across 2 workers", "Writing the plan", "Waiting for your answer"), never the build status the timeline already shows. | The engines carry the build's state and jobs, not a written per-Lead activity line like the board's "Splitting the payment work". |
| phone | Mission | A help line above the message bar in undrawn states (native request open, delivery unconfirmed, a question waiting, no build open). The pause button keeps its icon and reads "Resume build" when paused. | Undrawn states; the bar must say why it is disabled. |
| phone | Mission | A finished build opened from Builds shows in history mode: title, "Finished · session history", and Latest only (no bar, no actions). | Undrawn; a finished build has no live actor. |
| phone | Mission | Native Factory requests (exact-request answers) render on the Mission page in the Ask sheet's type and radio-row styling, keeping every control, id and rule of `src/phone/native.ts`. | Native questions carry per-question radio, checkbox and text answers with exact option ids; the Ask sheet's single radio group cannot hold them without changing the exact-request rules. |
| phone | Ask | The explanation paragraph shows only when the engine carries one (none do today), option hints are empty, and the first option starts selected. The label names the asker ("Lead asks", or "Worker asks" for a worker question). | The engines carry the question and options only, not "Recommended by the Lead" or an explanation. |
| phone | Ask | Tapping the scrim or the handle closes the sheet without answering. | The board draws the handle only; a sheet must be dismissible. |
| phone | Settings | Connection states beyond the drawn Working / Online / Off: "Saved", "Checking", "Paired", "Signing in" (muted), and failures in `--sp-danger`: "Check key", "Check token", "No computer", "Not working", "Not linked", "Failed". With no paired computer the host row reads "Factory cloud" / "Builds run in Factory's cloud". | Real health from the existing tests (Factory computers, broker capabilities, X sign-in); the board draws only the healthy and off states. |
| phone | Settings | Pull requests reads "Open automatically" when not asking first; Models lists the chosen models ("Lead …  · Workers …") once any is set. | Undrawn values of the same rows. |
| phone | Settings | "Back up build history": the checkbox toggles the archive mirror flag; tapping the row's text opens the archive sheet (device key, sync, restore). | The board draws a checkbox row; the archive's own controls need a sheet. |
| phone | Settings | The three Advanced labels open as collapsible sub-sections: the Factory-native form (prefilled from pairing), the relay and host addresses, and the durable runtime switch, the other flags, Reduce motion and the activity log. | The board draws the three labels as lines; their content is undrawn. |
| phone | Settings | Each connection sheet keeps the panel's own state pill ("Required", "Connected", "Check key", ...) under the sheet title. | The sheets host the existing forms (Save and test, Remove, masked hints); their pills are those forms' own feedback. |
| phone | Settings › X | The sheet leads with "Sign in on <computer>" and its status; there is no token box. A credential this phone already held from before keeps Save and verify, Disconnect X and the host handoff and stop controls. | REDESIGN-SPEC §6 (the phone never asks for token JSON); existing phone-held credentials keep their handoff path (C7). |
| phone | Home, Settings | The Settings tab icon is the Home board's gear when Settings is not the current tab and the Settings board's icon when it is. | The two boards draw different Settings icons; each board is matched where it applies. |
| phone | All | Bricolage Grotesque ships as the static 600/700 latin files (default optical size) instead of the board's variable `opsz 12..96` Google Fonts request. | Fonts are bundled files, never loaded from Google at runtime (C1); the OFL static files are the bundled source. |
| pairing | SetupCompare (Proposed, step 2), Pair, Settings ("Run npx spriite pair there") | Until the `spriite` npm package is published, the command is `npm run pair` from a checkout of the repository (`npm run pair -- --relay <relay URL>`). README, `docs/SETUP.md` and `docs/NATIVE-BROKER-SETUP.md` say so next to `npx spriite pair`. The package itself (`cli/`) is complete and packs the broker and installer (`npm pack` in `cli/`). | Publishing to the npm registry needs the owner's npm account; a build cannot do it. |
| pairing | SetupCompare (Proposed, step 1) | "From Even Hub" is documented as: upload your own build to your own Even Hub project; there is no shared store listing yet. | The Even app reaches only the exact addresses packed into a build, and each owner runs their own relay, so builds are per owner. |
| pairing | Pair ("Get the installer for macOS, Linux or Windows") | There is no standalone, Node-free installer, and the Spriite host (native broker) runs on Linux and macOS only. `spriite pair` refuses Windows with the reason. | The broker runs as a systemd user service or a LaunchAgent and drives droid's POSIX sandbox; Windows has neither. A Node-free installer would need a separately built and signed binary per OS. |
| pairing | Move ("Every key and the link to studio") | Every key and the host link move except an X token pair held on the old phone. The new phone connects X again from the computer (host sign-in). | X rotates the refresh token on every renewal: a pair copied to a second phone would end the first phone's (or the host reader's) grant. |
| pairing | Move ("Build history and chats") | The activity feed and the archive mirror's device key always move (the new phone restores its records from the relay archive); full build records move only when the phone shell passes a history port to `createPairingClient`. History that would push the envelope past the relay's 1 MB mailbox cap is dropped first; if the rest still does not fit, the move fails with `too_large`. | The mission store (frozen) exposes no export of its records; the relay mailbox holds at most 1 MB per message. |
| pairing | Ready ("Build from X posts … Sign-in opens on studio") | The owner registers their own X app once: an OAuth 2.0 client id (in Settings or `SPRIITE_X_CLIENT_ID` on the computer) and the callback URL `http://127.0.0.1:47823/x/callback`. | X issues OAuth clients per developer app; Spriite ships no shared X app (bring your own app), and X only redirects to registered callback URLs. |
| hud | HudIdle, HudListen, HudRun, HudAsk, HudDone | All glasses text uses the firmware font at its one size and weight, not Instrument Sans 600/400 at 24/16/15/13 px (1x). The context line is not letter-spaced (0.1em) | Text containers render only the firmware's built-in font; the SDK has no font family, size, weight or letter-spacing property. Positions and container sizes follow the boards; line pitch is the firmware's 28 px |
| hud | HudIdle, HudListen, HudRun, HudAsk, HudDone | The context line's right half is right-aligned by padding with spaces inside one 528 px container, so its right edge can sit up to one space (5 px) short of x 552 | Text containers have no right alignment, and a second container sized to the detail would need a page rebuild every time the detail changes (the listening timer changes every second) |
| hud | HudIdle, HudListen, HudRun, HudDone | The focused action's bordered box is as wide as the widest label in that card's action set (the label centred in it with spaces), not as wide as the focused label | A container's size and border are fixed until the page is rebuilt; sizing the box per focused label would rebuild (flicker) on every swipe. The box keeps the board's border, radius, padding at the widest label and its 22 px gap |
| hud | HudIdle, HudListen, HudRun, HudDone, HudAsk | Moving focus turns the actions (and the question's options) like a carousel: the focused one is always drawn first, in the bordered slot where the boards draw it, and the others follow in order | Brightness and border are per container and cannot change without a rebuild; keeping the focused item in a fixed bordered container makes a ring tick a flicker-free text upgrade. Every board's default state is drawn exactly |
| hud | HudRun, HudDone | The milestone bar is sent as two 220x20 image containers (x 112 and x 332, y 200), with the 8 px segments in rows 0-7; segment colours are image levels 15 (done, #9DFFB0), dotted 15/0 (review) and 3 (remaining, #12301A) | An image container is at most 288 px wide and at least 20 px tall; images are 4-bit greyscale, the display's own green sets the hue |
| hud | HudListen | The capture bar is sent the same way (two 220x20 containers at y 206, the 3 px bar in rows 0-2); only the half whose fill changed is re-sent each second | Same image container limits; halving the per-second image traffic keeps the sprite and the bar inside the BLE budget |
| hud | HudListen | Before any words arrive the line above the transcript shows the prompt ("Say what we should build.") and the transcript is empty; "You said" replaces it with the first words | The board draws only the state with words; the capture page is shown the moment the microphone starts (G05), before any transcript exists |
| hud | HudAsk | The question page shows the focused option and the next three; longer lists turn through the same four rows | The question, four 28 px option rows and the footer fill the 288 px screen; containers cannot scroll in place |
| hud | HudAsk | A question longer than two lines (a gate's three- or four-line question) moves the option rows down one 28 px line per extra line and shows that many fewer rows under the focused option | The firmware's 28 px line pitch: the board's two-line question slot (y 54-110) cannot hold a longer question, and containers cannot scroll in place |
| hud | HudRun | A four-line utterance starts at y 54 instead of y 66 so its status line still clears the bar at y 200 | The firmware's 28 px line pitch is taller than the board's type; the boards draw one-line utterances |
| hud | HudRun, Home | "N OF M" (and the phone's "Milestone N of M") counts the milestones done, so before the first one is done it reads "0 OF M" / "Milestone 0 of M". | Undrawn state; the boards draw 2 done of 4 as "2 OF 4", and an in-review milestone does not move the count. |
| hud | HudRun, HudDone, HudAsk (Factory Missions, native) | A Factory Mission card keeps Factory's own report: the subline is the provider tally ("running · 2/4 done", "PR open · checks 2/3", "Last known · reconciling") instead of "<n> checks passed · <n> agents"; the utterance stays "Factory reports …" and the Done line is "Factory reports completion …" instead of "<Title> is ready for you to review."; a feature Factory reports complete is drawn dotted until the outcome is verified (artifact evidence verified, or merged after checks) and only then solid; Message is not offered (‹ [Pause] Milestones ›, with Builds when nothing else applies). Context line, bar position, DONE detail and the Done actions are the boards'. | The Factory native API (Missions 2.0) reports features and checks as unverified provider claims, exposes no agent count, and accepts only exact request answers, never ordinary messages; "checks passed", "ready for you to review" and Message cannot be shown truthfully on that platform. |
| hud | HudIdle | The idle card is drawn from the engine's home list (the count of builds and of builds waiting on the owner); "Needs you" is offered only while a build is asking | The board draws the state with one build asking; an action that could do nothing is not offered |
| hud | HudIdle, HudRun, HudDone, HudAsk | Text levels: #B8FFC8 is firmware brightness 4, #5BC874 is 3, #3A8A4E is 2; the focused border (#9DFFB0) is border level 15 | Text containers take a brightness 0-4 and borders a grey level 0-15, not colours |
| hud | MotionLab (spoken replies) | A spoken reply plays only while the phone app is in the foreground and the WebView allows audio playback; where it does not (no `Audio`/blob URL support or autoplay refused) nothing plays and the sprite keeps the card's pose | Audio plays through the phone WebView (`src/voice/speak.ts`); the glasses have no speaker API in the SDK |
| sprite | Sprite.dc.html | On the glasses, transparent cells (-1) and ink cells (0) are both sent as level 0 | The glasses image container is 4-bit greyscale with no alpha. Level 0 is "off" (black), which is what the board shows for both on its black ground, so the frames look the same |
| sprite | Sprite.dc.html | On the glasses, levels 1-15 are sent as raw grey levels, not as the board's `hsl(134, 92%, …)` colours | The display's own green phosphor sets the hue. The phone sprite (`src/sprite/dom.ts`) uses the board's `shade()` exactly |

Integration changes to frozen files, recorded for review:

- `src/state/archive.ts`: `ArchiveClient` gained a read-only `deviceKey` getter so "Move to another phone" can carry the archive device key (end-to-end encrypted, never shown).
