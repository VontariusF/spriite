# Phone package: recorded deviations

Boards: `Home.dc.html`, `Mission.dc.html`, `Ask.dc.html`, `Settings.dc.html` (and `Main.dc.html`, which
the phone mounts through the setup package's flow). Everything drawn on these boards is built as drawn:
copy, order, colours (tokens from `src/phone/tokens.ts`), type (Bricolage Grotesque, Instrument Sans,
JetBrains Mono, bundled in `public/fonts`), spacing, radii and states. The rows below are the only places
the build differs, each because the board does not draw the state, the engine does not carry the data,
or an existing safety rule needs a control the board does not show.

| Board | Difference | Reason |
|---|---|---|
| Home | The glasses pill has two undrawn states: "Glasses off" and "Checking glasses", in the same pill shape with muted colours (`--sp-muted` text, `--sp-surface` ground, `--sp-radio-off` dot). | The board draws only "Glasses on"; the glasses link is hardware state that can be down or unknown. |
| Home | When the build that is asking is not the one on the glasses and its engine does not say what the question offers (the legacy one-build engine), Needs you shows its question with one amber "Answer" button (it brings the build in and opens the Ask sheet with every option). Under the durable runtime the card is exactly as drawn for any build (first two answers + See all options). | Only the durable runtime's `pendingAsks()` carries each question's options; the other engines expose an unfocused build's question text only. |
| Home | Held X posts, uncertain X follow-ups and held native requests appear as rows inside the Needs you card with their existing controls (Build it, New repo, Not now, Resend (may duplicate), Dismiss, Review). | The board draws one question; these items keep their exact confirm and dismiss rules, which need their own controls. |
| Home | The mirror hides Open build and Pause while the glasses show the home list, the goal list or an idle card with no build, shows "Resume" when the build is paused, and "Needs attention" on a failed build. | Undrawn states. |
| Home | "Start something new" shows a one-line help only in undrawn states: the one-build legacy engine, and New repo with no GitHub at all (no phone token and no paired host signed in to GitHub). The status line under it reports the outcome of every phone action. | The board's default state has no help line and the build matches it; these states must not promise a build that cannot start. |
| Home | The old "Repository name (optional)" field is gone: a goal sent with New repo on gets a repository named from the goal through the existing path. New repo is on by default when "New repo per idea" is chosen; otherwise it turns off after one use. | The board draws only the chip. |
| Home | The Home tab shows an amber count badge when items wait and Home is not on screen. | Undrawn; replaces the old Now-tab badge so waiting work stays visible from Builds and Settings. |
| Builds (undrawn) | The full builds list in the Home builds-card style with source filter chips (All N, Spriite N, Factory N, Cursor N) in the Home chip style, an empty state, and the resume/watch hint. | No board; composed from Home as the plan's interpretation fixes. |
| Mission | "More actions" opens an inline menu with the glasses' actions for this card (Continue, Send message, Open PR, Open Factory, Retry, ...) and "Answer in Factory" when Factory asks a native question. | Undrawn; every action the glasses offer stays reachable on the phone. |
| Mission | With no milestones in the engine's snapshot, the timeline shows one current step (the card's label and status). Done and next steps show the milestone's status ("Checks passed", "In review", "Being fixed", "Not started"); the current step shows the build's live status. | The engines carry milestone labels and statuses, not the board's sample detail copy ("you approved at 2:10"). Nothing is invented. |
| Mission | "Who's working" lists the Lead, each worker from the snapshot's jobs and the reviewer; it is hidden when the snapshot has no jobs and no session (a watched cloud build). Worker names read "Worker" or "Worker · Cursor" with the job label as what it is doing. | The engines expose jobs, not per-worker role names ("Worker · API"). |
| Mission | The Lead row reads the board's "Planning" (accent) while a build runs; undrawn Lead states are "Asking" (a question is open), "Reviewing", "Paused" and "Done". Its doing line is the Lead's own activity from the card and the jobs ("Splitting the work across 2 workers", "Writing the plan", "Waiting for your answer"), never the build status the timeline already shows. | The engines carry the build's state and jobs, not a written per-Lead activity line like the board's "Splitting the payment work". |
| Mission | A help line above the message bar in undrawn states (native request open, delivery unconfirmed, a question waiting, no build open). The pause button keeps its icon and reads "Resume build" when paused. | Undrawn states; the bar must say why it is disabled. |
| Mission | A finished build opened from Builds shows in history mode: title, "Finished · session history", and Latest only (no bar, no actions). | Undrawn; a finished build has no live actor. |
| Mission | Native Factory requests (exact-request answers) render on the Mission page in the Ask sheet's type and radio-row styling, keeping every control, id and rule of `src/phone/native.ts`. | Native questions carry per-question radio, checkbox and text answers with exact option ids; the Ask sheet's single radio group cannot hold them without changing the exact-request rules. |
| Ask | The explanation paragraph shows only when the engine carries one (none do today), option hints are empty, and the first option starts selected. The label names the asker ("Lead asks", or "Worker asks" for a worker question). | The engines carry the question and options only, not "Recommended by the Lead" or an explanation. |
| Ask | Tapping the scrim or the handle closes the sheet without answering. | The board draws the handle only; a sheet must be dismissible. |
| Settings | Connection states beyond the drawn Working / Online / Off: "Saved", "Checking", "Paired", "Signing in" (muted), and failures in `--sp-danger`: "Check key", "Check token", "No computer", "Not working", "Not linked", "Failed". With no paired computer the host row reads "Factory cloud" / "Builds run in Factory's cloud". | Real health from the existing tests (Factory computers, broker capabilities, X sign-in); the board draws only the healthy and off states. |
| Settings | Pull requests reads "Open automatically" when not asking first; Models lists the chosen models ("Lead …  · Workers …") once any is set. | Undrawn values of the same rows. |
| Settings | "Back up build history": the checkbox toggles the archive mirror flag; tapping the row's text opens the archive sheet (device key, sync, restore). | The board draws a checkbox row; the archive's own controls need a sheet. |
| Settings | The three Advanced labels open as collapsible sub-sections: the Factory-native form (prefilled from pairing), the relay and host addresses, and the durable runtime switch, the other flags, Reduce motion and the activity log. | The board draws the three labels as lines; their content is undrawn. |
| Settings | Each connection sheet keeps the panel's own state pill ("Required", "Connected", "Check key", ...) under the sheet title. | The sheets host the existing forms (Save and test, Remove, masked hints); their pills are those forms' own feedback. |
| Settings › GitHub | When the paired host's `gh` is signed in to GitHub, the GitHub row reads "Through <host label>" and Working, and the sheet says the phone needs no token (a saved token stays as the fallback). With no such host the row is the board's "Can create and push repos" with the token's health. | The board has no host-provided GitHub state; GitHub calls run on the host through the broker (docs/design/HOST-GITHUB-PLAN.md). |
| Settings › X | The sheet leads with "Sign in on <computer>" and its status; there is no token box. A credential this phone already held from before keeps Save and verify, Disconnect X and the host handoff and stop controls. | REDESIGN-SPEC §6 (the phone never asks for token JSON); existing phone-held credentials keep their handoff path (C7). |
| Home, Settings | The Settings tab icon is the Home board's gear when Settings is not the current tab and the Settings board's icon when it is. | The two boards draw different Settings icons; each board is matched where it applies. |
| All | Bricolage Grotesque ships as the static 600/700 latin files (default optical size) instead of the board's variable `opsz 12..96` Google Fonts request. | Fonts are bundled files, never loaded from Google at runtime (C1); the OFL static files are the bundled source. |

## Integration requests

All resolved at integration:

1. `src/runtime/app-engine.ts`: `pendingAsks()` rows carry `options` (the decision's answers without the speak row); Home's Needs you draws the first two and See all options for a build that is not on the glasses, and a tap sends exactly that answer after bringing the build in.
2. `src/main.ts`: the dev-only `fake-phone` hooks click `#ph-tab-home`, `#ph-tab-builds` and `#ph-tab-settings` (`now`/`setup` stay as aliases).
3. Walkthroughs drive the HUD and capture the phone through `fake-phone`, so they need no selector change; a stale comment in `walkthrough-real.mjs` was updated.

## Sheets: a visible Close, swipe down and Back

The Ask board draws a sheet with only its handle. On a phone that was not a
usable way out: the handle scrolled away once the keyboard opened, and the
scrim strip above a 92vh sheet was too small to tap. Every sheet now pins a top
bar (handle + a "Close" text button, `.ph-sheet-close`) above its content. A
swipe down on that bar, or Android Back, also closes it, and the sheet leaves
at least 56 px of scrim to tap. Closing never needs a save.

## Mission chat scrolls with the page

The chat used to be its own scroll box (`max-height: min(62vh, 600px)`) inside
the scrolling page. On phones it stuck before its end and the sticky message
bar covered its last lines. It now flows in the page, which is the one
scroller. New rows are appended in place instead of the whole chat being
rebuilt, and the view follows a reader at the end to the start of the newest
message.
