# Development

[Back to the README](../README.md) · [Contributing](../CONTRIBUTING.md)

```bash
npm run dev            # dev server with the Factory and Cursor proxy
npm run sim            # Even G2 simulator, automation API on :9898
npm run walkthrough    # drives the demo story in the simulator, saves shots/
npm run test:real      # real engine against fake workers (plan, split, review, PR); no credits spent
npm run sim:offline    # simulator against a fake Factory whose computer is offline (also sim:blocked, sim:newrepo)
npm run walk:real -- 9899 offline   # drives that variant end to end, saves shots/r-*
npm run check:copy     # every glasses string fits its pixel budget
npm run pack           # copy check + build + .ehpk (needs your relay; see SETUP.md step 3)
npm run relay          # run the relay with Node (for testing it, or for self-hosting)
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
| `relay/` | Your relay: a Cloudflare Worker (default) that also runs under Node |
| `scripts/` | Packer, copy budget checker, sprite contact sheet, simulator walkthrough, engine test |


## Porting to another device

The mission engine, scene contract, and phone companion stay shared. Replace the adapter in `src/bridge/`, `src/render/`, `src/input/`, and `src/audio/talk.ts`. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the adapter contract and checks.

