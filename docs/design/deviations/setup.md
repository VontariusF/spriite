# Setup package: recorded deviations

Boards: Main, Pair, Paired, Repo (paired and key-only), Ready, Move, SetupCompare (Proposed).
Code: `src/setup/flow/**`. Tests: `scripts/test-setup-flow.mjs`.

| Board | Difference | Reason |
|---|---|---|
| Main, Pair, Paired, Repo, Ready, Move | Screens are fluid width and fill the viewport height (`min-height: 100dvh`) instead of the fixed 390x844 / 390x900 artboards; paddings, gaps and every inner size are the board's. | Phones differ in size; at 390 px wide the layout is the board's. |
| Main, Pair, Paired, Repo, Ready | Navigation links drawn as `<a href="...dc.html">` are `<button>` elements with the same box, font and colour. | In-app navigation, not page links; the external links (Node.js installer, Factory API keys) stay `<a>`. |
| Pair | "No Node?" opens `https://nodejs.org/en/download`; the board's link is `#`. | The board has no target; this is the official Node.js download page. |
| Pair | Copy shows "Copied" for 2 s after a successful clipboard write; without the Clipboard API the command text is selected instead. | Undrawn state; the platform may refuse clipboard writes. |
| Pair | Each pairing failure shows a short message in `--sp-danger` (13 px) directly under the code boxes: not_found, expired, used, wrong_code, unreachable, cancelled, invalid. An incomplete code shows "Type all six characters of the code." | Undrawn state. |
| Pair | While a claim is pending, Connect reads "Connecting…", is disabled and the code boxes are disabled; Back aborts the claim. | Undrawn busy state. |
| Pair | "Scan the QR code instead" opens the camera inline (BarcodeDetector + getUserMedia) only where both exist; otherwise it shows the muted note "Scanning isn’t available on this phone. Type the code instead." | The Even app webview and several mobile browsers have no BarcodeDetector; the camera cannot be read without it. |
| Pair | Code boxes accept a pasted or autofilled whole code (spread across the boxes) and use the mono face at weight 600 as drawn. | Behaviour the board implies; no visual change. |
| Paired | Rows for anything missing read "Later" with an honest detail: "No Factory login found", "No Droid computer found", "No host link found", "No GitHub CLI login found", "No ElevenLabs key found". A found ElevenLabs key reads "ElevenLabs key from your computer" with Found. An offline computer reads "<name> · offline". GitHub with an unknown count reads "From the GitHub CLI"; one repo reads "1 repo". | The board draws one combination of found/missing. |
| Paired | "Looks right" reads "Saving…" while the bundle is applied; if nothing could be saved, a danger line "Some keys didn’t save. Try again, or change them later in Settings." appears above the button. | Undrawn states. |
| Paired | In the Settings context ("Pair a different computer") the step bar still reads 2 of 3 and "Looks right" returns to Settings. | The plan fixes this flow (Pair › Paired › Settings); no separate board. |
| Repo | Paired path whose bundle carried no Factory key shows the key-only "Factory API key" block too (builds keep the chosen run-on). | Setup cannot finish without a Factory key; reuses the drawn key-only block. |
| Repo | The chosen repo row shows an accent check in place of the chevron (`aria-pressed`). | Undrawn selected state. |
| Repo | List states: "Loading your repos…", "Couldn’t load your repos. Paste a GitHub link instead.", "No repo matches. Paste a GitHub link to use any repo."; a pasted link row's meta is "GitHub link"; a saved repo not in the list shows "Current choice". With no GitHub token and nothing typed the list card is hidden. At most 6 rows show until the search narrows them. | Undrawn states; the board draws three rows. |
| Repo | Row meta ages are today / this week / this month / last month / N months ago. | The board shows three of these; "this month" covers 7-29 days honestly. |
| Repo | Finish setup is disabled (45% opacity) only while the key-only field is empty; while the key is checked it reads "Checking…"; a rejected key shows the message in `--sp-danger` above the button and stays. | Undrawn states. |
| Repo | A valid pasted GitHub link selects itself (mode "One repo I choose", the row's accent check) so Finish saves it without another tap. "One repo I choose" with no repo chosen does not finish: "Pick a repo from the list or paste a GitHub link." shows in `--sp-danger` above the button. | Undrawn states (spec behaviour 3: pasting any GitHub URL works); finishing with no repo would save a mode with nothing to build in. |
| Ready | A configured extra (ElevenLabs key, X connected or host reader on, Cursor key) shows an accent check with "Added" / "Connected" instead of its button. | Undrawn state for returning from an extra. |
| Ready | With no paired host the X detail reads "Tag your Spriite account. Sign-in opens on your computer." | The board names the paired host; key-only and moved setups may have none. |
| Ready | "Add key" opens that key's sheet above the setup flow (z 40 over the flow's 30); closing it returns to Ready, which repaints (Added). "Connect" shows the X sign-in outcome as one 13 px line under the extras (`--sp-muted`, or `--sp-danger` when it failed). | Undrawn states: the board draws only the buttons, and the outcome must be visible where the owner tapped. |
| Move | The QR is drawn from `pairing.qrMatrix(offer.qrText)` as an SVG in `--sp-accent-ink` inside the 200 px `#EAF5EC` tile with a 12 px quiet zone. | Replaces the board's "[QR CODE]" placeholder. |
| Move | States: "Making a code…" while the offer is created; at zero the amber line becomes "This code expired." in `--sp-danger` with a "Make a new code" outline button; a failed offer shows its reason the same way (code reads "— · — · —"); a finished move reads "Moved. The new phone has everything." in accent. | Undrawn states. |
| Move | With no paired host the first line reads "Every key and the link to your computer". | The board names the paired host. |
| Move (receiver) | Undrawn screen composed from Pair: back button without a step bar, heading "Move from another phone", lead "On the old phone, open Settings › Move to another phone. It shows a code.", the Pair code card with three boxes (word · 2 digits · word, dashes between), Scan button, listening row "Listening for your other phone…", and Connect. Success goes straight to Ready. | The plan fixes this as "undrawn screen composed from Pair". |

## Integration requests

All resolved at integration: `PairingClient` gained `parseTransferQr(text)` and the Move receiver uses it first (its own reader stays as the fallback for typed codes); the phone mounts the flow inside the `.sp` root.

## Review screen: X row can read Found

The Review board shows X requests as Later. When the host has the owner's X app
client id and token pair saved (`secrets/x-pair.json` in the broker home),
`spriite pair` carries them in the encrypted bundle, the phone stores them, and
the row reads "X app and token from your computer". The host copy is removed
after a successful pair, because X rotates the pair on every renewal. The
ElevenLabs key is also read from `secrets/elevenlabs-api-key` when
`ELEVENLABS_API_KEY` is not set.
