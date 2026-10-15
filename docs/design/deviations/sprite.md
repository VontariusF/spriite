# Sprite package: recorded deviations

| Board | Difference | Reason |
|---|---|---|
| Sprite.dc.html | On the glasses, transparent cells (-1) and ink cells (0) are both sent as level 0 | The glasses image container is 4-bit greyscale with no alpha. Level 0 is "off" (black), which is what the board shows for both on its black ground, so the frames look the same |
| Sprite.dc.html | On the glasses, levels 1-15 are sent as raw grey levels, not as the board's `hsl(134, 92%, …)` colours | The display's own green phosphor sets the hue. The phone sprite (`src/sprite/dom.ts`) uses the board's `shade()` exactly |

## Integration requests

None.
