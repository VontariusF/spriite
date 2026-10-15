# Spriite redesign: build plan

Source of truth: `docs/design/REDESIGN-SPEC.md` and the boards in `docs/design/redesign/*.dc.html`.

Note (0.3.2): the labeled demo (`src/factory/demo.ts`, "Try the demo", "Restart demo") was removed
after this plan was carried out; its mentions below are kept as the historical plan.
The build matches the boards exactly (layout, copy, colours, type, spacing, radii, states, flows).
Where a board and older code, tests or docs disagree, the board wins. A deviation is allowed only
where the hardware or platform makes the board impossible, and every deviation is recorded.

This plan splits the work into five packages that are built **in parallel in one working tree**
on branch `redesign/v2`. Every file has exactly one owner. Packages never edit each other's
files; they meet only at the contracts below.

## Ground rules for every package

- Never push, never switch branches, never touch files outside the repository. No commits unless
  the orchestrator asks.
- No personal names, hostnames, tailnet names or home paths in code, docs, fixtures or tests. Use
  placeholders: machine `studio`, repos `your-org/shop-site`, broker `https://broker.example.com`,
  relay `https://relay.example.com`, owner `owner-example`, paths `~/…` or `<SPRIITE_HOME>`.
- Keep existing behaviour working: Missions 2.0 native execution, X intake routing (X builds never
  land in the Spriite repo unless designated), trusted-host policy, holds, outbox, archive.
- Tests that assert old UI copy or layout are updated to the new design. Never delete a test just
  to make it pass. New behaviour gets new labeled `PASS:`/`FAIL:` assertions (the format
  `scripts/qualify.mjs` counts).
- Files that no package owns are frozen. If you believe a frozen file must change, do not edit it:
  add an "Integration requests" section to your deviations file describing the exact change.
- Deviations: each package records its own in `docs/design/deviations/<package-id>.md` as a table
  `| Board | Difference | Reason |`. `REDESIGN-SPEC.md` is owned by no package; the integration step
  copies every row into its "Recorded deviations" table.
- Build against the contracts, not against another package's progress. Your targeted tests inject
  fakes for anything another package provides, so they pass whatever state the other packages are
  in. Full typecheck and full qualification run at integration.
- Provider-first scaffolding: in your first step, create the contract files you provide (exact
  exports and types below, with working minimal implementations) so the other packages' imports
  resolve early. Then build the real thing behind them.

Commands:

- Typecheck: `npx tsc --noEmit -p .`
- One suite: `node --import ./scripts/ts-resolve.mjs scripts/<suite>.mjs`
- Full qualification: `PATH=~/.npm/_npx/ad6c181e5b604bdb/node_modules/.bin:$PATH node scripts/qualify.mjs`
- Copy budgets: `node scripts/measure-copy.mjs`

## Packages

| Id | Package | Boards |
|---|---|---|
| `phone` | Phone shell, design tokens and fonts, bottom tabs, Home, Builds, Mission, Ask, Settings (incl. Advanced, connection sheets, restyled legacy panels) | Home, Mission, Ask, Settings |
| `setup` | First-run setup flow: Welcome, Pair, Paired, Repo (paired, key-only, paste URL), Ready; Move sender and receiver screens; reusable repo chooser | Main, Pair, Paired, Repo, Ready, Move, SetupCompare |
| `pairing` | `spriite` bin (`npx spriite pair`), PAKE-encrypted pairing and move bundles, relay mailbox, phone pairing client, vault fields, setup-completion predicate, host-run X PKCE sign-in, installer, package/qualify registration, setup docs | Pair, Paired, Move, Ready (X), SetupCompare |
| `sprite` | The Spriite character: exact port of `drawFrame`/`POSES`, 12 poses, glasses timing, animator, resolver, phone DOM sprite | Sprite, MotionLab |
| `hud` | Glasses HUD layouts and copy, scene contract, segmented bar, scene producers (demo/real/app-engine/main), per-idea repo default in the engines, spoken replies, copy budgets | HudIdle, HudListen, HudRun, HudAsk, HudDone, MotionLab |

### Owned files

`phone`
: `src/phone/**`, `src/setup/panel.ts`, `src/setup/x-panel.ts`, `src/setup/archive-panel.ts`,
  `public/fonts/**`, `index.html`, `scripts/lib/phone-dom.mjs`, `scripts/test-phone-redesign.mjs`,
  `scripts/test-app-engine.mjs`, `scripts/test-settings.mjs`, `scripts/test-phone-fixes.mjs`,
  `scripts/test-native-ui.mjs`, `scripts/test-native-admission-ui.mjs`, `scripts/test-team-ui.mjs`,
  `scripts/test-host-x-phone.mjs`, `scripts/test-followups.mjs`, `scripts/test-x-intake.mjs`,
  `docs/design/deviations/phone.md`

`setup`
: `src/setup/flow/**`, `scripts/test-setup-flow.mjs`, `scripts/lib/setup-dom.mjs`,
  `docs/design/deviations/setup.md`

`pairing`
: `cli/**`, `broker/server.mjs`, `broker/x-signin.mjs`, `broker/x-signin.d.mts`,
  `broker/pair-protocol.mjs`, `broker/pair-protocol.d.mts`, `broker/package.json`,
  `broker/README.md`, `relay/**`, `src/pair/**`, `src/state/prefs.ts`, `src/voice/keys.ts`,
  `src/state/setup-state.ts`, `scripts/install-native-broker.sh`, `package.json`,
  `package-lock.json`, `vite.config.ts`, `scripts/qualify.mjs`, `scripts/test-pairing.mjs`,
  `scripts/test-transfer.mjs`, `scripts/test-host-x-signin.mjs`, `scripts/test-host-x-launch.mjs`,
  `scripts/test-native-broker.mjs`, `scripts/test-portable-installer.mjs`,
  `scripts/test-portable-broker.mjs`, `scripts/test-archive-fixes.mjs`, `README.md`,
  `docs/SETUP.md`, `docs/NATIVE-BROKER-SETUP.md`, `docs/design/PAIRING-PROTOCOL.md`,
  `docs/design/deviations/pairing.md`

`sprite`
: `src/sprite/**`, `scripts/test-sprite.mjs`, `scripts/sprite-fixtures.mjs`,
  `scripts/contact-sheet.mjs`, `scripts/fixtures/sprite-poses.json`, `shots/sprite-poses.png`,
  `docs/design/deviations/sprite.md`

`hud`
: `src/render/**`, `src/scenes/**`, `src/factory/copy.ts`, `src/factory/demo.ts`,
  `src/factory/real.ts`, `src/runtime/app-engine.ts`, `src/main.ts`, `src/voice/speak.ts`,
  `scripts/measure-copy.mjs`, `scripts/test-hud-redesign.mjs`, `scripts/test-hud-fixes.mjs`,
  `scripts/test-response-reading.mjs`, `scripts/real-engine-test.mjs`,
  `scripts/test-execution-boundary.mjs`, `scripts/walkthrough.mjs`, `scripts/walkthrough-real.mjs`,
  `scripts/walkthrough-runtime.mjs`, `scripts/walkthrough-session-options.mjs`,
  `scripts/walkthrough-native.mjs`, `docs/design/deviations/hud.md`

Everything else (for example `src/runtime/mission.ts`, `src/runtime/supervisor.ts`, `src/intake/**`,
`src/native/**`, `src/state/archive.ts`, `src/state/feed.ts`, `src/factory/github.ts`,
`src/factory/fapi.ts`, `broker/broker.mjs`, `broker/x-*.mjs` other than `x-signin`) is frozen.

## Contracts

### C1. Design tokens and fonts (provider: `phone`)

`src/phone/tokens.ts` exports `TOKENS_CSS: string` and `FONT_CSS: string`. `mountPhoneApp`
injects both once. The custom properties are declared on `.sp` (the phone root every screen,
including the setup flow, renders inside):

| Variable | Value | Variable | Value |
|---|---|---|---|
| `--sp-ground` | `#07110A` | `--sp-amber` | `#F2B740` |
| `--sp-surface` | `#0D1A11` | `--sp-amber-ground` | `#1E1705` |
| `--sp-raised` | `#13241A` | `--sp-amber-ink` | `#2A1C00` |
| `--sp-selected` | `#0F2215` | `--sp-amber-line` | `#6B5320` |
| `--sp-line` | `#1F3326` | `--sp-amber-soft` | `#FBE8C0` |
| `--sp-line-strong` | `#24452F` | `--sp-amber-muted` | `#D9C7A0` |
| `--sp-text` | `#EAF5EC` | `--sp-factory` | `#7DBEFF` |
| `--sp-muted` | `#9AB1A0` | `--sp-cursor` | `#BDA4FF` |
| `--sp-body-soft` | `#D4E3D7` | `--sp-danger` | `#FF8A7A` |
| `--sp-accent` | `#5CE57D` | `--sp-nav` | `#0A150D` |
| `--sp-accent-hover` | `#8BF0A2` | `--sp-placeholder` | `#7F9785` |
| `--sp-accent-ink` | `#04210E` | `--sp-radio-off` | `#5A7562` |
| `--sp-step-off` | `#2E4A37` | `--sp-dash` | `#3C5A45` |
| `--sp-scrim` | `#030805` | `--sp-done-dot` | `#5A7562` |
| `--sp-glass` | `#000000` | `--sp-glass-title` | `#B8FFC8` |
| `--sp-glass-body` | `#8FE6A3` | `--sp-glass-label` | `#6FCF86` |
| `--sp-glass-bar-off` | `#1A3322` | | |

Font stacks: `--sp-font-display: 'Bricolage Grotesque', Georgia, serif`,
`--sp-font-ui: 'Instrument Sans', 'Helvetica Neue', Helvetica, sans-serif`,
`--sp-font-mono: 'JetBrains Mono', Menlo, monospace`.

Fonts are bundled files, never loaded from Google at runtime. They live in `public/fonts/` with
these exact names (latin subset, woff2, OFL; obtain them from the upstream OFL releases, for
example the `@fontsource/*` packages unpacked into a scratch directory, and copy the files in; do
not add a dependency):

```
public/fonts/bricolage-grotesque-latin-600-normal.woff2
public/fonts/bricolage-grotesque-latin-700-normal.woff2
public/fonts/instrument-sans-latin-400-normal.woff2
public/fonts/instrument-sans-latin-500-normal.woff2
public/fonts/instrument-sans-latin-600-normal.woff2
public/fonts/instrument-sans-latin-700-normal.woff2
public/fonts/jetbrains-mono-latin-500-normal.woff2
public/fonts/jetbrains-mono-latin-600-normal.woff2
public/fonts/OFL-bricolage-grotesque.txt
public/fonts/OFL-instrument-sans.txt
public/fonts/OFL-jetbrains-mono.txt
```

`FONT_CSS` references them as `${import.meta.env.BASE_URL}fonts/<file>` with `font-display: swap`.
CSS class prefixes: phone shell `ph-`, setup flow `sf-`, phone sprite `spr-`. The legacy classes
(`.card`, `.btn`, `.row`, `.pill`, `.msg`, …) stay and are restyled by `phone` to the tokens.

### C2. Sprite poses and APIs (provider: `sprite`)

`src/sprite/poses.ts` (no runtime imports, erasable syntax):

```ts
export const POSE_NAMES = ['idle','listening','talking','thinking','building','delegating',
  'checking','asking','celebrate','blocked','paused','offline'] as const
export type PoseName = (typeof POSE_NAMES)[number]
export const LEGACY_POSE_NAMES = ['waiting','planning','repair','accepted','disconnected',
  'switching','receiving','researching','reconciling','briefing'] as const
export type LegacyPoseName = (typeof LEGACY_POSE_NAMES)[number]
/** Every name a Scene/EngineView may carry: the 12 drawn poses plus legacy semantic tags. */
export const SCENE_POSE_NAMES: readonly (PoseName | LegacyPoseName)[]
export type ScenePose = PoseName | LegacyPoseName
export const LEGACY_POSE_MAP: Record<LegacyPoseName, PoseName>
export function toPose(p: ScenePose | string): PoseName   // unknown -> 'idle'
export const POSE_META: Record<PoseName, { name: string; when: string; frames: number }>  // MotionLab text verbatim
```

`LEGACY_POSE_MAP` (from the MotionLab moments): `waiting→building`, `planning→thinking`,
`researching→thinking`, `repair→blocked`, `accepted→celebrate`, `disconnected→offline`,
`switching→idle`, `receiving→talking`, `reconciling→checking`, `briefing→talking`.
(`idle`, `listening`, `checking`, `asking`, `delegating`, `blocked`, `paused` keep their names.)
`POSE_META[...].name` uses the MotionLab names: `thinking` is "Planning", `celebrate` is
"Celebrating".

`src/sprite/draw.ts`: `export interface PoseFrame` (the board's frame fields: `d`, `eyes`, `lift`,
`look`, `tilt`, `squash`, `leaf`, `mouth`, `waves`, `orbit`, `chips`, `minis`, `lens`, `qmark`,
`confetti`, `cloud`, `zz`, `bars`, `dim`), `export const POSES: Record<PoseName, readonly PoseFrame[]>`,
`export function drawFrame(f: PoseFrame): number[]` (1024 cells, `-1` transparent, else 0-15; a
verbatim port of the board), `export const GLASSES_MIN_HOLD_MS = 1000`,
`export function holdMs(f: PoseFrame, speed: 'preview' | 'glasses'): number`,
`export function shade(level: number): string` (`level 0 → '#000000'`, else
`hsl(134, 92%, ${(3 + v * 4.4).toFixed(1)}%)`).

`src/sprite/frames.ts` keeps its public names for the renderer: `GRID = 32`, `SCALE = 2`,
`SIZE = 64`, `POSE_NAMES`/`PoseName` (re-exported from poses.ts, now the 12), `type Lift = 0`,
`type FrameName` (one name per pose frame, form `${pose}.${index}`), `FRAME_NAMES`, `ANIMS`,
`framePixels(name: FrameName, lift?: Lift): number[]` (4096 levels, each grid cell doubled,
transparent → 0). There is no separate hover cycle any more: lift is part of each frame.

`src/sprite/animator.ts` keeps `class SpriteAnimator` with `constructor(show: ShowFrame)`,
`setPose(pose: ScenePose, opts?: { force?: boolean })` (normalizes with `toPose`), `setStatic`,
`toggleStatic`, `setReduceMotion`, `setSurfaceAttached`, `invalidate`, `stop`, getters
`currentPose: PoseName`, `currentFrame: FrameName`, `isStatic`, `isReduceMotion`, and the
transport rules (one transfer in flight, newest frame only, wall-clock deadlines, no send while
detached). On the glasses every frame holds `max(d, 1000)` ms.

`src/sprite/resolve.ts` keeps `resolvePose(inputs: PoseInputs): PoseDecision` and
`activityPoseFor(focused): PoseName`, returning the 12 names. `PoseInputs` gains optional
`speaking?: boolean` (a spoken reply is playing). Priority: link down → `offline`; capturing →
`listening`; speaking → `talking`; decision → `asking`; blocked/owner-critical → `blocked`;
transient (`receiving` → `talking`, `switching` → `idle`); status unknown → `checking`; briefing →
`talking`; focused activity; else `idle`. Phase map: `received→talking`, `gathering_context→thinking`,
`planning→thinking`, `ready→delegating`, `building→building`, `reviewing→checking`,
`repairing→blocked`, `integrating→building`, `awaiting_decision→asking`, `completed→celebrate`,
`failed→blocked`, `cancelled→idle`; control `paused→paused`, `pause_requested`/`cancel_requested →
building`.

`src/sprite/dom.ts` (the phone's `<dc-import name="Sprite">`):

```ts
export interface SpriteViewOptions { pose: ScenePose; px?: number /* default 4 */;
  speed?: 'preview' | 'glasses' /* default 'preview' */; frame?: number /* >= 0 pins */; label?: string }
export interface SpriteView { readonly el: HTMLElement; setPose(p: ScenePose): void;
  setSpeed(s: 'preview' | 'glasses'): void; destroy(): void }
export function createSpriteView(opts: SpriteViewOptions): SpriteView
```

`el` is a `div` with `role="img"`, `aria-label="Spriite, <pose>"`, size `32*px` square, class
`spr`, holding a `canvas` drawn cell by cell. Without `canvas.getContext` (the Node DOM shim) it
draws nothing and never throws. Timers call `unref()` when available so test processes exit;
`prefers-reduced-motion` pins frame 0.

### C3. Scene contract additions (provider: `hud`)

In `src/scenes/types.ts`: `SpritePose = ScenePose` and `SPRITE_POSES = SCENE_POSE_NAMES` (legacy
names stay valid so stored records and fixtures still validate; the renderer draws `toPose(...)`).
`SceneProgress` gains optional `milestones?: MilestoneMark[]` with
`export type MilestoneMark = 'done' | 'review' | 'todo'`. `Scene` gains optional
`contextDetail?: string` (the right half of the context line, for example `BUILDING · 2 OF 4`).
All additions are optional; existing producers and fixtures stay valid. `EngineView` keeps its
shape. When `milestones` is absent, HUD and phone derive segments from the weights.

### C4. Vault fields and setup completion (provider: `pairing`)

Shared types live in `src/pair/types.ts` (types only, no runtime code):

```ts
export type RunOn = 'host' | 'cloud'
export type RepoMode = 'per_idea' | 'one'
export type SetupPath = 'paired' | 'key_only' | 'moved'
export interface PairedHost { label: string; machineId: string; ownerId: string;
  brokerUrl: string; via: 'tailscale' | 'https' | 'none'; os: 'linux' | 'macos'; pairedAt: number }
```

`KeyVault` (`src/voice/keys.ts`, storage key `spriite.keys.v1` unchanged) adds:
`get repoMode(): RepoMode` (stored value, default `'one'`), `setRepoMode(mode): Promise<boolean>`,
`exportForTransfer(): Record<string, string>`, `importFromTransfer(rec): Promise<boolean>`.
`realSetupWorks(keys: { factory: string; repoUrl: string; repoMode?: RepoMode })` becomes
`factory && (repoUrl || repoMode === 'per_idea')` (an object without `repoMode` behaves as before).

`PrefsVault` (`src/state/prefs.ts`, storage key `spriite.prefs.v1` unchanged, new fields validated
on load like the others) adds: `get setupCompletedAt(): number` (0 = never),
`setSetupCompleted(at: number): Promise<boolean>`, `get runOn(): RunOn` (stored, default
`pairedHost ? 'host' : 'cloud'`), `setRunOn`, `get pairedHost(): PairedHost | null`,
`setPairedHost(h: PairedHost | null)`, `get setupPath(): SetupPath | ''`, `setSetupPath`,
`get spokenReplies(): boolean` (default true), `setSpokenReplies(on)`,
`exportForTransfer(): Record<string, unknown>`, `importFromTransfer(rec): Promise<boolean>`.
"Back up build history" stays the existing `archive_mirror` flag.

`src/state/setup-state.ts` (no runtime imports beyond `realSetupWorks`):
`export function isSetupComplete(keys: { factory: string; repoUrl: string; repoMode?: RepoMode },
prefs: { setupCompletedAt: number }): boolean` = `prefs.setupCompletedAt > 0 || realSetupWorks(keys)`
(existing installs with a working setup never see Welcome again).

Setup is complete when the owner taps **Finish setup** on Repo (`setup` calls
`prefs.setSetupCompleted(Date.now())`); Ready shows once after that. Try the demo does not complete
setup.

### C5. Pairing client (provider: `pairing`, consumers: `setup`, `phone`)

`src/pair/types.ts` also declares:

```ts
export interface PairingBundle { v: 1; kind: 'pair'; createdAt: number
  host: { label: string; machineId: string; ownerId: string; brokerUrl: string;
          via: 'tailscale' | 'https' | 'none'; os: 'linux' | 'macos'; online: boolean }
  factory: { apiKey: string | null; computerId: string | null; computerName: string | null; computerOnline: boolean }
  github: { token: string | null; login: string | null; repoCount: number | null }
  broker: { bearerToken: string | null }
  voice: { elevenLabsKey: string | null }
  x: { hostSignIn: boolean }
  native: { brokerUrl: string; ownerId: string; machineId: string; cwd: string; baseRef: string } | null }
export type PairFailure = 'not_found' | 'expired' | 'used' | 'wrong_code' | 'unreachable' | 'cancelled' | 'invalid'
export type PairOutcome = { ok: true; bundle: PairingBundle } | { ok: false; reason: PairFailure }
export interface MoveBundle { v: 1; kind: 'move'; createdAt: number; keys: Record<string, string>;
  prefs: Record<string, unknown>; feed: Array<{ at: number; label: string; text: string }>;
  history: unknown | null; summary: { hostLabel: string | null; buildCount: number; keyCount: number } }
export type TransferFailure = PairFailure | 'too_large'
export interface TransferOffer { code: string; display: string; qrText: string; expiresAt: number;
  done: Promise<{ ok: true } | { ok: false; reason: TransferFailure }>; cancel(): void }
export type TransferOfferResult = { ok: true; offer: TransferOffer } | { ok: false; reason: TransferFailure }
export type TransferReceiveOutcome = { ok: true; bundle: MoveBundle } | { ok: false; reason: TransferFailure }
export interface ApplyResult { ok: boolean; applied: string[]; failed: string[] }
export type HostXSignInState = { state: 'idle' } | { state: 'pending'; startedAt: number }
  | { state: 'connected'; handle: string | null } | { state: 'failed'; reason: string }
  | { state: 'unavailable'; reason: string }
export interface PairingClient {
  normalizePairCode(input: string): string | null      // 'k7q-2mf ' -> 'K7Q2MF'
  formatPairCode(code: string): string                  // 'K7Q2MF' -> 'K7Q-2MF'
  parsePairQr(text: string): { code: string; secret: string | null } | null
  claimPairing(code: string, opts?: { signal?: AbortSignal; qrSecret?: string | null }): Promise<PairOutcome>
  applyPairingBundle(bundle: PairingBundle, opts: { runOn: RunOn }): Promise<ApplyResult>
  normalizeTransferCode(input: string): string | null  // 'wren 41 oak' -> 'WREN-41-OAK'
  formatTransferCode(code: string): string              // -> 'WREN · 41 · OAK'
  offerTransfer(opts?: { signal?: AbortSignal }): Promise<TransferOfferResult>
  receiveTransfer(code: string, opts?: { signal?: AbortSignal; qrSecret?: string | null }): Promise<TransferReceiveOutcome>
  applyMoveBundle(bundle: MoveBundle): Promise<ApplyResult>
  qrMatrix(text: string): boolean[][]                    // true = dark module
  hostXSignIn: { available(): boolean; start(opts?: { clientId?: string }): Promise<HostXSignInState>;
                 status(): Promise<HostXSignInState> }
}
```

`src/pair/client.ts` exports `createPairingClient(deps: { keys: KeyVault; prefs: PrefsVault;
feed: FeedVault; relayBase?: string; fetchImpl?: typeof fetch; now?: () => number }): PairingClient`.
Relay base: `VITE_SPRIITE_RELAY` + `/pair/v1` in builds, `/api/pair/v1` in dev.
`applyPairingBundle` writes: Factory key, `computerId` (only when `runOn === 'host'`), GitHub
token, broker bearer bound to the canonical broker URL (`setNativeBroker`), ElevenLabs key when
present, `pairedHost`, `runOn`, `setupPath = 'paired'`, and prefills empty fields of
`nativeLaunchProfile` from `bundle.native`. It never overwrites a non-empty native profile field.
Every write goes through the existing vault setters; it returns which items were applied.

### C6. Setup flow API (provider: `setup`, consumer: `phone`)

`src/setup/flow/index.ts`:

```ts
export type SetupEntry = 'welcome' | 'pair' | 'key_only' | 'move_receive'
export type SetupScreenId = 'welcome' | 'pair' | 'paired' | 'repo' | 'ready' | 'move_receive'
export interface SetupFlowDeps {
  keys: KeyVault; prefs: PrefsVault; pairing: PairingClient
  github?: { repos(token: string): Promise<GitHubRepo[]> }      // default: githubRepos
  testFactoryKey?: (key: string) => Promise<{ ok: true } | { ok: false; message: string }>  // default: factoryComputers
  context?: 'first_run' | 'settings'   // 'settings': Pair -> Paired -> done (no Repo/Ready)
  entry?: SetupEntry
  onExtra(kind: 'voice' | 'x' | 'cursor'): void | Promise<void>   // Ready's buttons
  onTryDemo(): void
  onSaved(): void                       // after every vault write (hot-apply)
  onDone(): void                        // Ready's "Open Spriite", or end of a settings-context flow
}
export interface SetupFlowHandle { readonly screen: SetupScreenId; show(entry: SetupEntry): void; destroy(): void }
export function mountSetupFlow(root: HTMLElement, deps: SetupFlowDeps): SetupFlowHandle
export interface RepoChooserDeps { keys: KeyVault; prefs: PrefsVault;
  github?: SetupFlowDeps['github']; onSaved(): void; onChange?(mode: RepoMode, repoUrl: string): void }
export function mountRepoChooser(root: HTMLElement, deps: RepoChooserDeps): { refresh(): void; destroy(): void }
export interface MoveScreenDeps { pairing: PairingClient; hostLabel: () => string | null; onBack(): void }
export function mountMoveScreen(root: HTMLElement, deps: MoveScreenDeps): { destroy(): void }
```

### C7. Host X sign-in (provider: `pairing`)

Broker routes (bearer-authenticated, added to the CORS route regex in `broker/server.mjs`):
`POST /v1/native/x/signin` body `{ clientId?: string }` starts an OAuth 2.0 PKCE flow on the host
(opens the system browser on the paired computer, loopback redirect, token exchange on the host,
credential stored through the existing `x-credential` store, host reader resumes when enabled);
`GET /v1/native/x/signin` returns the state. Responses map onto `HostXSignInState`. The phone
never asks for token JSON; existing phone-held credentials keep their handoff path.

### C8. Engine and HUD behaviour (provider: `hud`)

- `keys.repoMode === 'per_idea'` and a goal that names no repository: the new mission starts with
  `newRepository: true` (name derived from the goal by the existing path), in both the durable
  runtime (`src/runtime/app-engine.ts`) and the legacy engine (`src/factory/real.ts`). X routing is
  unchanged.
- Spoken replies: `src/voice/speak.ts` exports `speakReply(text: string, key: string,
  opts?: { signal?: AbortSignal }): Promise<boolean>` (ElevenLabs TTS, played on the phone);
  `main.ts` calls it for reply cards when `prefs.spokenReplies` and an ElevenLabs key exist, and
  passes `speaking: true` to the pose resolver while it plays.
- `mountPhoneApp(root, deps: PhoneDeps): PhoneHandle` keeps every existing member; new members are
  optional and exist for test injection: `pairing?: PairingClient` (default
  `createPairingClient({ keys, prefs, feed })`), `setupFlow?: typeof mountSetupFlow`,
  `moveScreen?: typeof mountMoveScreen`, `repoChooser?: typeof mountRepoChooser`.
  `setXPanelHostBridge`/`XPanelHostBridge` keep their shape; `mountXPanel` options gain optional
  `hostXSignIn?: PairingClient['hostXSignIn']`. `main.ts` (owned by `hud`) needs no change for the
  phone to adopt the setup flow: the gating lives inside `mountPhoneApp`.
- HUD action ids added by `hud` for the idle card: `builds` (opens the builds list on the glasses)
  and `needs_you` (focuses the first build that is asking). `main.ts` routes both.

### C9. Test registration (provider: `pairing`)

`package.json` gains these scripts and `scripts/qualify.mjs` registers each in `SUITES`
(qualification refuses unregistered `test:` scripts):

| Script | File | Owner |
|---|---|---|
| `test:phone-redesign` | `scripts/test-phone-redesign.mjs` | phone |
| `test:setup-flow` | `scripts/test-setup-flow.mjs` | setup |
| `test:pairing` | `scripts/test-pairing.mjs` | pairing |
| `test:transfer` | `scripts/test-transfer.mjs` | pairing |
| `test:host-x-signin` | `scripts/test-host-x-signin.mjs` | pairing |
| `test:hud-redesign` | `scripts/test-hud-redesign.mjs` | hud |

All run as `node --import ./scripts/ts-resolve.mjs scripts/<file>`. In `qualify.mjs` the §25.24-26
row's word `seventeen` becomes `twelve poses` (the `sprite` suite prints a passing label containing
"twelve poses"), and the open gap "all seventeen poses" becomes "all twelve poses".

### C10. Relay invariants (provider: `pairing`)

The pairing mailbox routes live in `relay/pair.mjs`, dispatched from `worker.js` and `node.mjs`
before the bridge. `worker.js` keeps exactly one entry in `WRITE_ROUTES` and `archive.mjs` exactly
two (a source-count assertion in `test-x-intake.mjs` checks this). The mailbox stores only
ciphertext and public PAKE messages, at most 10 minutes, one claim per code.

## Sequencing

1. Scaffolding (first step of each package, minutes): `pairing` writes `src/pair/types.ts`,
   `src/state/setup-state.ts`, the new vault getters/setters, and a `createPairingClient` that
   returns `unreachable` everywhere; `sprite` writes `poses.ts`, `draw.ts` (the full port is short)
   and `dom.ts`; `hud` switches `scenes/types.ts` to `ScenePose`/`SCENE_POSE_NAMES` and adds the
   optional fields; `setup` writes `flow/index.ts` with the three mount functions; `phone` writes
   `tokens.ts` and the font files.
2. Parallel build of each package against the contracts, with its own tests green.
3. Integration (orchestrator): merge `docs/design/deviations/*.md` rows into the
   `REDESIGN-SPEC.md` table, run `npx tsc --noEmit -p .`, `node scripts/measure-copy.mjs`,
   `npm run build`, full qualification, then a visual pass of each board against the built page
   (simulator or browser at 390 px width) and the HUD at 576x288.

## Interpretations fixed by this plan

These are decisions about behaviour the boards imply but do not draw. They are not deviations.

- Builds tab: the full builds list (Home's Builds card, all rows, with source filter chips in the
  Home chip style); a row opens Mission.
- Activity log: no card on Home. The feed stays durable and archived; it is shown under Settings ›
  Advanced › "Durable runtime and developer flags".
- Settings rows open sheets that host the existing per-account forms (Factory, GitHub, ElevenLabs,
  Cursor), the X panel (host sign-in first), the archive panel (Back up build history), and
  Advanced holds the Factory-native form (prefilled from pairing), relay/host addresses, flags.
- Ask sheet "Let me decide later" closes the sheet and leaves the question open.
- Move receiver (Welcome › Move from another phone) is undrawn; it reuses the Pair board's layout
  and code-entry pattern for the three-part code. Record it in `setup`'s deviations as "undrawn
  screen composed from Pair".
- Pairing from Settings ("Pair a different computer") runs Pair → Paired and returns to Settings.
- Demo scenes keep their "(DEMO)" context label (honesty invariant); the HUD boards show real mode.
- `celebrate` plays once and settles on its last frame ("then it settles"); the board's preview
  loops only to demonstrate.
