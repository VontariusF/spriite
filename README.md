# Spriite

**Run your AI software factory from the glasses you're already wearing.**

Spriite is a voice-first companion for people who build software with AI
coding agents. You say what you want built. Spriite plans it, hands the work
to agents in your own Factory and Cursor accounts, checks every step, and
asks you before anything costs money or opens a pull request. All of it
shows on a heads-up display, so you can start, watch, steer, and approve
work without sitting at a desk.

![Plan](shots/07-plan.png) ![Running](shots/09-running.png) ![Under review](shots/11-under-review.png)

## Who it's for

- **Solo builders and small teams** who already use AI agents and want to
  keep work moving while they're away from the keyboard: walking, in a
  meeting, at the whiteboard.
- **Anyone who wants an honest progress report.** Spriite only counts work
  that a reviewer has accepted. A step under review shows as pending, and a
  regression takes its credit back, visibly.
- **People who want to own their stack.** Spriite has no backend and no
  account of its own. You bring your keys, and you host the one small relay
  it needs.

## What a mission looks like

1. **Say the goal.** Tap Talk: "Add dark mode to the settings page."
2. **Review the plan.** A Factory lead session drafts numbered milestones
   with weights. Nothing runs yet.
3. **Approve the spend.** Spriite tells you the build uses your Factory (and
   Cursor) credits, and waits for a yes.
4. **Workers build.** One worker, or up to four in parallel on separate
   branches: Cursor cloud agents, Factory sessions on your own computer, or
   a mix.
5. **Every branch gets reviewed.** The lead session reviews each one and
   returns a verdict. Failures go back to that worker as a fix run.
6. **Integrate and ship.** Accepted branches merge into one integration
   branch, the lead reviews it once more, and a pull request opens (or asks
   you first, if you prefer).

You can steer at any point ("use the existing color tokens"), pause, ask
for status, or walk away. Closing the app never cancels a mission; it
resumes on the next launch.

The home screen also lists the cloud builds already running in your
accounts (Factory sessions and Cursor agents), so you can watch them live
and steer the ones that accept messages.

A labeled **demo mode** ("run the demo") plays the whole story against a
simulated factory, so you can try Spriite with no accounts and no cost.

## What you need

| Piece | Required? | What it does |
|---|---|---|
| [Factory](https://app.factory.ai/settings/api-keys) API key | Required | The lead session plans, reviews, and asks you questions. Without Cursor, Factory sessions also do the building on your computer. |
| A GitHub repository | Required | Where the work lands. Picked from a list on your phone; nobody types URLs. |
| [ElevenLabs](https://elevenlabs.io/app/settings/api-keys) API key | Recommended | Live speech-to-text. Create it with speech-to-text access only and a spending cap. |
| [Cursor](https://cursor.com/dashboard/api) API key | Optional | Cursor cloud agents as workers, in parallel with your machine. |
| [GitHub](https://github.com/settings/tokens) token | Optional | Instant repository list and "create a new repository". Use a fine-grained token with an expiry. |
| A relay you host | Required for installed builds | Lets the app reach Factory and Cursor. See below. |
| HUD smart glasses | Required | Today: Even Realities G2 (optionally with the R1 ring). See [Supported glasses](#supported-glasses). |

## Set it up

### 1. Get the code

```bash
git clone <this repository> spriite && cd spriite
npm install
```

### 2. Deploy your relay

Glasses apps like this run as web pages inside the glasses' phone app.
Factory and Cursor don't accept requests from web pages they don't own
(they send no CORS headers), so Spriite needs a tiny relay that forwards
your requests and adds those headers. It's under 150 lines in
[`relay/`](relay/), stores nothing, logs nothing, and only talks to
`api.factory.ai` and `api.cursor.com`.

Because you run it, your keys never pass through anyone else's server.

**Cloudflare Worker** (free tier, about two minutes):

```bash
cd relay
npx wrangler deploy        # prints https://spriite-relay.<you>.workers.dev
curl https://spriite-relay.<you>.workers.dev/health   # -> spriite relay ok
```

**Or your own machine**, behind an HTTPS tunnel you control:

```bash
npm run relay              # listens on :8787
tailscale funnel 8787      # or: cloudflared tunnel --url http://localhost:8787
```

Details and options are in [`relay/README.md`](relay/README.md).

### 3. Build Spriite against your relay

```bash
echo 'VITE_SPRIITE_RELAY=https://spriite-relay.<you>.workers.dev' > .env.production.local
npm run pack               # -> spriite.ehpk, with your relay in the network whitelist
```

The relay address is baked into your build and added to the app's network
allowlist. `app.json` itself is never edited.

### 4. Install it on your glasses

For Even Realities G2: upload `spriite.ehpk` to your project in the
[Even Hub developer portal](https://hub.evenrealities.com/hub).

- **Private build** (Private builds tab): install from the phone app under
  Me → Apps → Private builds. Quickest way to check it boots, but it only
  survives backgrounding briefly.
- **Beta build** (move the build to Test and add yourself to a beta group):
  the same install path a store app uses, and it keeps running with your
  phone locked. Use this for daily use.

### 5. Connect your accounts

Open Spriite's page in the phone app and go to **Setup**. A checklist walks
you through Factory, repository, voice, Cursor, and GitHub. Each key is
proven with one lightweight call when you save it, then stored only on your
phone. Saves apply to the glasses immediately.

### 6. Start a mission

On the glasses, pick **New build** and tap Talk, or type a goal in the
phone's **Tell Spriite** box.

### Try it without a relay

For development, the dev server proxies Factory and Cursor itself, so no
relay is needed:

```bash
npm run dev                                   # http://localhost:5173
npx evenhub qr --url http://<your-lan-ip>:5173   # scan with the glasses' phone app
```

The phone and the dev machine must share a network (a private overlay
network such as Tailscale also works). This mode stops when the phone
locks, so use a relay build for real use.

## Using it

**Glasses (temple touchpad or ring):** swipe to move between actions, tap to
choose, double-tap to go back (at the home screen, double-tap opens the
system exit dialog). Tap Talk to speak, tap again to finish (30 s cap).

**Voice:** "Hey Spriite" wakes it. Pause, resume, status, explain, and
cancel act right away. Consequential commands ("use it", "restart") show a
readback card and only run after you confirm. Anything else before work
starts becomes the goal; during work it steers the lead session.

**Phone:** **Now** mirrors the glasses: the live mission card with every
action, the Tell Spriite box, your builds (filter by Spriite, Factory, or
Cursor), and an activity log. **Setup** holds keys, repository, and build
preferences (which service runs workers, how many in parallel, and whether
to open pull requests automatically or ask first).

**When something fails,** Spriite says which service failed and why, on the
glasses (`Service failed | Factory HTTP 401`) and in full on the phone.
Nothing is acted on after a failure.

## Supported glasses

Spriite is built for the class of HUD glasses that most current devices
share: a small monochrome display (around 576x288), touch or ring input
with tap, double-tap, and swipe, a microphone, and an app that runs on the
paired phone and draws text, lists, and small images on the lenses.

The design follows that shape: short status lines with fixed pixel
budgets, one focused action list per screen, a 64x64 sprite, and no color.

| Device | Status |
|---|---|
| Even Realities G2 + R1 ring | Supported (Even Hub SDK 0.0.16) |
| Other HUD glasses | Port by adding a device adapter (see below) |

The mission engine, the scene contract, and the phone companion don't
depend on any device. The device-specific parts are small and separate:
`src/bridge/` (host SDK calls), `src/render/` (draws a scene as containers),
`src/input/` (turns device events into actions), and `src/audio/talk.ts`
(microphone capture). A port replaces those four and keeps everything
else. Contributions welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```bash
npm run dev            # dev server with the Factory and Cursor proxy
npm run sim            # Even G2 simulator, automation API on :9898
npm run walkthrough    # drives the demo story in the simulator, saves shots/
npm run test:real      # real engine against fake workers (plan, split, review, PR); no credits spent
npm run check:copy     # every glasses string fits its pixel budget
npm run pack           # copy check + build + .ehpk
npm run relay          # run the relay locally
```

Add `?fresh=1` to the dev URL to ignore saved state.

### Layout

| Path | Role |
|---|---|
| `src/factory/engine.ts` | The engine interface both engines implement |
| `src/factory/real.ts` | Real engine: lead-session protocol (plan, VERDICT, DECISION, SUMMARY), workers, milestones, steering, cloud builds |
| `src/factory/demo.ts` | Labeled demo engine |
| `src/factory/fapi.ts`, `cursor.ts`, `github.ts` | Factory, Cursor, and GitHub API clients |
| `src/factory/copy.ts` | Every string shown on the glasses |
| `src/scenes/` | Device-neutral scene contract and validation |
| `src/voice/` | ElevenLabs realtime transcription, wake phrase and command grammar, key vault |
| `src/state/` | Preferences, recent missions, background snapshots |
| `src/phone/`, `src/setup/` | Phone companion: Now and Setup tabs, shared theme |
| `src/sprite/` | The pixel companion: layered frames and a sparse animator |
| `src/bridge/`, `src/render/`, `src/input/`, `src/audio/` | Device adapter (Even Hub today) |
| `relay/` | Self-hosted relay (Cloudflare Worker or Node) |
| `scripts/` | Packer, copy budget checker, sprite contact sheet, simulator walkthrough, engine test |

## Status

Spriite runs today as a self-built app with your own relay. It isn't in a
glasses app store yet: a store build would send every user's Factory and
Cursor traffic through one shared relay, so that waits until those APIs
accept browser requests directly, or until a relay-free transport lands.

## Privacy, security, contributing

- [PRIVACY.md](PRIVACY.md): what each service receives and what stays on
  your phone.
- [SECURITY.md](SECURITY.md): reporting vulnerabilities and how keys are
  handled.
- [CONTRIBUTING.md](CONTRIBUTING.md): setup, checks, and porting to other
  glasses.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
