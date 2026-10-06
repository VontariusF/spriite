# README artwork

The product images are AI-generated visualizations based on the official Even Realities G2 and R1 product references. They are not lens recordings or an endorsement by Even Realities, Factory, or Cursor. Hardware and brand designs belong to their respective owners.

## Files

| Asset | Source |
|---|---|
| `spriite-hero.webp` | Generated product hero using the built-in image-generation tool. |
| `spriite-product.webp` | Generated hardware/HUD detail using the built-in image-generation tool. |
| `spriite-hud.png`, `spriite-hud.svg` | Code-rendered mockups following `src/render/layout.ts` and the progress semantics in `src/render/progress.ts`. Pixel art comes directly from `src/sprite/frames.ts`. Illustrative mission, not live evidence. |
| `spriite-workers.png`, `spriite-workers.svg` | Explanatory diagram of the current connected provider roles. |

The HUD mockups use a font approximation. The dark surrounding cards are presentation frames, not opaque panels rendered on the glasses. Generated hero/detail artwork is less exact than the source-based HUD board; the app code remains authoritative.

## References

- [Even G2 hardware](https://www.evenrealities.com/smart-glasses)
- [Even HUD](https://www.evenrealities.com/hud-glasses)
- [Display documentation](https://hub.evenrealities.com/docs/build/display)
- [Design guidelines](https://hub.evenrealities.com/docs/build/design-guidelines)

## Rebuild the diagrams

From the repository root, with Node 24+ and Inkscape installed:

```bash
node docs/render-readme.mjs
inkscape docs/assets/spriite-hud.svg --export-type=png --export-filename=docs/assets/spriite-hud.png
inkscape docs/assets/spriite-workers.svg --export-type=png --export-filename=docs/assets/spriite-workers.png
```

## Hero prompt

Use case: product-mockup.
Asset type: wide GitHub README hero banner, 16:9 landscape, premium product launch art for Spriite.
Input 1 is the official Even Realities G2 product reference: preserve exactly its dark rectangular frame silhouette, clear lenses, silver hinge caps, temples and nose pads. Input 2 is the actual R1 ring: preserve brushed dark metal, shape, four square touch marks. Input 3 is the actual Spriite pixel character: keep its exact pixel flame silhouette, dark eyes, curled floating tail and lightning spark. Do not redesign any of these.
Scene: a very dark charcoal studio with restrained emerald light, clean premium hardware photography and unusually thoughtful art direction. On the RIGHT two thirds, float the G2 glasses at the referenced three-quarter angle with a small R1 ring below, well separated, no rectangular image backdrops. On the LEFT top third ample clean space for typography. Behind and above the glasses, one readable floating transparent green HUD showing the app, explicitly a wearer-view visualization rather than graphics repeated on both lenses. HUD has compact native fixed-font monochrome green text and the small actual pixel Spriite beside it.
Exact typography: large refined pale white title "Spriite" (spell S p r i i t e). Under title on 2 lines "Your software factory.\nIn your field of view." One small label "EVEN G2 + R1". 
HUD exact content: small context "SPRIITE"; beside character two lines "The worker pushed a branch.\nFactory is reviewing the diff now."; smaller status "40% verified | Factory reviewing"; a sparse horizontal bar filled 40%, remainder dim; bottom actions "Talk     Pause".
Do not let any title or body text cross glasses, ring, or HUD. Product silhouette must be beautifully readable against the dark backdrop. No people, code, terminal windows, fake charts, futuristic visor, neon tunnels, excessive bloom, extra logos or additional text. Editorial minimalism. Wide final image, crisp type, precise material light.

## Product-detail prompt

Use case: product-mockup. Asset type: second GitHub README product image for Spriite, landscape 16:9.
Use the provided three reference images faithfully. Image 1: official Even G2 three-quarter product photo; exact glasses hardware, no redesign. Image 2: official Even R1 ring cutout; exact brushed dark metal ring geometry and touch markings. Image 3: Spriite actual pixel character; exact body, eyes, lightning spark and curled tail. 
Create a stunning minimalist industrial product photograph on almost black charcoal, with large G2 glasses sitting suspended in the center-right, elegant soft light revealing their clear lenses and nosepads, R1 ring in lower-left foreground. A single floating green HUD as wearer-view visualization in the upper-left negative space. HUD is transparent without a solid panel, monochrome pale green, native compact fixed font.
HUD text precisely: small label "SPRIITE"; small pixel Spriite left of the message; message "The review passed.\nThis step is verified."; status "60% verified"; horizontal bar 60% solid green and a dim baseline for remaining scope; bottom "Explain     Talk". 
At upper-left outside HUD, small editorial label "A goal. A plan. A glance." At bottom-left outside hardware, two crisp lines "Speak to Spriite." and "Steer with a tap." 
Hard constraints: maintain readable negative space between HUD text and products. No interface repeated on both lenses, no literal screens stuck onto each lens. No face or person, no tablet or phone, no oversized science-fiction visor, no exaggerated light beams. Subtle emerald reflections, clear precision, beautifully sharp photoreal product details, no random extra words or brands. Wide polished editorial landscape, minimal premium software/hardware campaign.

