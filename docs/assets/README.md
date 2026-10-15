# README artwork

Every image here comes from the redesign mockups in
[`docs/design/redesign/`](../design/redesign/), the design source of truth the app is built and
tested against. They are mockups with an illustrative mission and example names, not captures of a
live build or lens recordings. Hardware and brand names belong to their respective owners.

| Asset | What it shows | Boards |
|---|---|---|
| `spriite-hero.png` | README banner: the Building HUD | `HudRun.dc.html` |
| `spriite-setup.png` | The five setup screens | `Main`, `Pair`, `Paired`, `Repo`, `Ready` |
| `spriite-phone.png` | The phone companion | `Home`, `Mission`, `Ask`, `Settings` |
| `spriite-hud.png` | Five glasses screens, shown at 2× | `HudIdle`, `HudListen`, `HudRun`, `HudAsk`, `HudDone` |
| `spriite-poses.png` | The twelve character poses | `MotionLab.dc.html` |
| `spriite-workers.png`, `spriite-workers.svg` | Diagram of the connected provider roles | (diagram) |

HUD boards are drawn at 2× on a black ground. On the glasses the display is 576 × 288, green, and
transparent where the board is black; brightness, font rendering and optical placement vary on
hardware.

The app logo is `public/spriite-logo.png` (1024 × 1024), and `public/favicon.png` is its 64 × 64
WebView favicon. Both ship in the built app; the full-size PNG also suits the Even Hub listing's
logo upload.

## Rebuild

Render each board at its canvas size (see `docs/design/redesign/canvas.json`) at 2× in a browser
with the design runtime, then lay the boards out on the `#07110A` ground with the captions above.
The pixel character in every board is the same renderer as `src/sprite/draw.ts`.

## References

- [Even G2 hardware](https://www.evenrealities.com/smart-glasses)
- [Display documentation](https://hub.evenrealities.com/docs/build/display)
- [Design guidelines](https://hub.evenrealities.com/docs/build/design-guidelines)
