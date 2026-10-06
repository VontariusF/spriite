# Contributing

Thanks for helping. Spriite is a small TypeScript + Vite app for HUD smart
glasses. Even Realities G2 is the first supported device, and you don't need
hardware to work on it: the simulator and the engine test cover most
changes.

## Setup

```bash
npm install
npm run dev            # Vite on :5173 (proxies Factory and Cursor, no relay needed)
npm run sim            # Even G2 simulator with its automation API on :9898
```

## Before opening a pull request

```bash
npx tsc --noEmit       # types
npm run check:copy     # every glasses string fits its pixel budget
npm run test:real      # real engine against fake workers (no credits spent)
npm run walkthrough    # with dev + sim running: drives the demo story
npm run pack           # build + package (needs a relay; npm run pack -- --no-relay for a demo-only build)
```

All of these must pass. Keep changes focused, match the surrounding style,
and put all glasses copy in `src/factory/copy.ts` so the budget checker sees
it.

## Porting to other glasses

Most HUD glasses share the same shape: a small monochrome display, tap /
double-tap / swipe input (temple or ring), a microphone, and an app that
runs on the paired phone. Spriite keeps everything device-specific in four
places:

| Path | Replace with |
|---|---|
| `src/bridge/` | Calls into your device's host SDK (wait for the host, storage, shutdown) |
| `src/render/` | Draws a validated scene (`src/scenes/types.ts`) as your device's text, list, and image elements |
| `src/input/` | Turns your device's touch/ring events into Spriite's `AppEvent`s (`select`, `back`, `next`, `previous`, `list_select`, `hold_start`/`hold_release`, `foreground`/`background`, `exit`) |
| `src/audio/talk.ts` | Starts and stops the glasses microphone and delivers 16 kHz PCM |

The engines (`src/factory/`), scene contract (`src/scenes/`), voice
(`src/voice/`), state (`src/state/`), sprite (`src/sprite/`), and phone
companion (`src/phone/`, `src/setup/`) stay as they are. If your display is
not 576x288, update the layouts in `src/render/layout.ts` and the pixel
budgets in `scripts/measure-copy.mjs`.

## Ground rules

- Never commit keys, tokens, `.env*.local` files, or personal machine
  details (IPs, hostnames, paths).
- Glasses UI stays monochrome and short. At the root screen, double-tap
  opens the host's exit confirmation.
- A new network destination needs an allowlist entry in `app.json`, an entry
  in `PRIVACY.md`, and a CORS check. If it doesn't allow browser origins, it
  goes through the relay (`relay/worker.js`).

By contributing you agree that your contributions are licensed under the
Apache License 2.0.
