# HUD package: recorded deviations

Boards: `HudIdle`, `HudListen`, `HudRun`, `HudAsk`, `HudDone` (drawn at 2x; built at 1x on the
576x288 canvas) and `MotionLab`. Every row below is a hardware or platform limit of the Even G2
display or the phone WebView; the build draws the closest thing the firmware allows.

| Board | Difference | Reason |
|---|---|---|
| HudIdle, HudListen, HudRun, HudAsk, HudDone | All glasses text uses the firmware font at its one size and weight, not Instrument Sans 600/400 at 24/16/15/13 px (1x). The context line is not letter-spaced (0.1em) | Text containers render only the firmware's built-in font; the SDK has no font family, size, weight or letter-spacing property. Positions and container sizes follow the boards; line pitch is the firmware's 28 px |
| HudIdle, HudListen, HudRun, HudAsk, HudDone | The context line's right half is right-aligned by padding with spaces inside one 528 px container, so its right edge can sit up to one space (5 px) short of x 552 | Text containers have no right alignment, and a second container sized to the detail would need a page rebuild every time the detail changes (the listening timer changes every second) |
| HudIdle, HudListen, HudRun, HudDone | The focused action's bordered box is as wide as the widest label in that card's action set (the label centred in it with spaces), not as wide as the focused label | A container's size and border are fixed until the page is rebuilt; sizing the box per focused label would rebuild (flicker) on every swipe. The box keeps the board's border, radius, padding at the widest label and its 22 px gap |
| HudIdle, HudListen, HudRun, HudDone, HudAsk | Moving focus turns the actions (and the question's options) like a carousel: the focused one is always drawn first, in the bordered slot where the boards draw it, and the others follow in order | Brightness and border are per container and cannot change without a rebuild; keeping the focused item in a fixed bordered container makes a ring tick a flicker-free text upgrade. Every board's default state is drawn exactly |
| HudRun, HudDone | The milestone bar is sent as two 220x20 image containers (x 112 and x 332, y 200), with the 8 px segments in rows 0-7; segment colours are image levels 15 (done, #9DFFB0), dotted 15/0 (review) and 3 (remaining, #12301A) | An image container is at most 288 px wide and at least 20 px tall; images are 4-bit greyscale, the display's own green sets the hue |
| HudListen | The capture bar is sent the same way (two 220x20 containers at y 206, the 3 px bar in rows 0-2); only the half whose fill changed is re-sent each second | Same image container limits; halving the per-second image traffic keeps the sprite and the bar inside the BLE budget |
| HudListen | Before any words arrive the line above the transcript shows the prompt ("Say what we should build.") and the transcript is empty; "You said" replaces it with the first words | The board draws only the state with words; the capture page is shown the moment the microphone starts (G05), before any transcript exists |
| HudAsk | The question page shows the focused option and the next three; longer lists turn through the same four rows | The question, four 28 px option rows and the footer fill the 288 px screen; containers cannot scroll in place |
| HudRun | A four-line utterance starts at y 54 instead of y 66 so its status line still clears the bar at y 200 | The firmware's 28 px line pitch is taller than the board's type; the boards draw one-line utterances |
| HudRun, Home | "N OF M" (and the phone's "Milestone N of M") counts the milestones done, so before the first one is done it reads "0 OF M" / "Milestone 0 of M". | Undrawn state; the boards draw 2 done of 4 as "2 OF 4", and an in-review milestone does not move the count. |
| HudRun, HudDone, HudAsk (Factory Missions, native) | A Factory Mission card keeps Factory's own report: the subline is the provider tally ("running · 2/4 done", "PR open · checks 2/3", "Last known · reconciling") instead of "<n> checks passed · <n> agents"; the utterance stays "Factory reports …" and the Done line is "Factory reports completion …" instead of "<Title> is ready for you to review."; a feature Factory reports complete is drawn dotted until the outcome is verified (artifact evidence verified, or merged after checks) and only then solid; Message is not offered (‹ [Pause] Milestones ›, with Builds when nothing else applies). Context line, bar position, DONE detail and the Done actions are the boards'. | The Factory native API (Missions 2.0) reports features and checks as unverified provider claims, exposes no agent count, and accepts only exact request answers, never ordinary messages; "checks passed", "ready for you to review" and Message cannot be shown truthfully on that platform. |
| HudIdle | The idle card is drawn from the engine's home list (the count of builds and of builds waiting on the owner); "Needs you" is offered only while a build is asking | The board draws the state with one build asking; an action that could do nothing is not offered |
| HudIdle, HudRun, HudDone, HudAsk | Text levels: #B8FFC8 is firmware brightness 4, #5BC874 is 3, #3A8A4E is 2; the focused border (#9DFFB0) is border level 15 | Text containers take a brightness 0-4 and borders a grey level 0-15, not colours |
| MotionLab (spoken replies) | A spoken reply plays only while the phone app is in the foreground and the WebView allows audio playback; where it does not (no `Audio`/blob URL support or autoplay refused) nothing plays and the sprite keeps the card's pose | Audio plays through the phone WebView (`src/voice/speak.ts`); the glasses have no speaker API in the SDK |

## Interpretations (not deviations)

- Undrawn glasses lists (Builds, Milestones, Evidence, Projects) reuse the HudAsk list layout with
  the footer "Swipe to choose · tap to open".
- The chat-history reading page is undrawn; it keeps its full-screen text layout with the boards'
  context line position.
- Talk without a voice key labels the listening card "NO VOICE KEY" (nothing is transcribed); with a
  key it reads "LISTENING" as drawn.
- A gate the app asks (start the build, open the PR) reads "SPRIITE ASKS"; a worker's question reads
  "WORKER ASKS"; the lead's reads "LEAD ASKS" as drawn.
- The Run board's status line ("6 checks passed · 3 agents") is shown once the worker's activity is
  confirmed running; before that the honest activity word stays (sent does not mean working).

## Integration requests

None. The `scripts/test-sprite.mjs` §13p assertion now compares containers 7 and 12 against `optionRows(items, 1)` from `src/render/layout.ts` (resolved at integration).
