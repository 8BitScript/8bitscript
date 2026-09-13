---
"@8bitscript/web": patch
"@8bitscript/cli": patch
---

The web target gets a screen of its own, and machine skins beside it.

Its stock grid was 40×25 — the C64's, inherited because every other machine had one and the web had to say something. Nothing on the web is 40×25. The default is now **48×27 cells of 8×8: 384×216, exactly 16:9**, so a browser canvas scales to it without pillarboxing.

The old shapes did not go away, they became choices. `--hardware machine=<hifi|pet-2001|c64|vic20>` picks the skin the wasm build is compiled for, with `c64`, `pet-2001` and `vic20` also available as presets:

| machine | grid | palette | notes |
| --- | --- | --- | --- |
| `hifi` (default) | 48×27 | 16 | 16:9, per-cell color |
| `pet-2001` | 40×25 | 2 | green phosphor, swapped character set |
| `c64` | 40×25 | 16 | per-cell color |
| `vic20` | 22×23 | 16 | per-cell color |

Each skin is a geometry twin next to `geometry.8bs` — `geometry.web.c64.8bs` and friends — resolved by the same system-specific-file mechanism every machine package already uses. So `text.COLUMNS`, `text.CELL_COUNT`, and the offsets the host and the program agree on fold to that skin's constants at build time; nothing probes the grid at runtime.

A tagged build writes `program-<tag>.wasm` beside a `program.json` layout sidecar carrying grid, palette and aspect, which the web loader reads to size the canvas instead of assuming one shape. `8bs screenshot` reads the same layout, so a skinned build screenshots at its own grid rather than the default one.
