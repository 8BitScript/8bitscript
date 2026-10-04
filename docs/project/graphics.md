---
title: Portable graphics
nav_order: 88
---

# Portable graphics

A thin slice: one PNG-backed sprite with an animation, compiled through a
`.8bg` file into target-native data. This is a new asset layer, not a
replacement for [`@8bitscript/sprites`](sprites.md),
[`@8bitscript/screen`](../language/packages.md), or
[`@8bitscript/text`](../language/packages.md). A program still calls
`text.print` and `sprites.place` for hand-written work. `.8bg` is how a
PNG becomes data those primitives (or a machine's own player) can use.

The source of truth is the media file. The bytes in the image are still
`const` data. Resource names (`sprite player`) are asset ids, not
`UPPER_SNAKE` consts; `8BS1034` does not apply to names elaborated from
`.8bg`.

## What a file looks like

```8bg
sprite player {
  source "./player.png"
  size 16x16
  transparent auto
  animation walk {
    frames 0, 1, 2, 3
    every 8
  }
}
```

`every 8` is a frame count, stable on a machine whose build is both PAL
and NTSC. The program imports the logical id:

```8bs
import { player } from "./player.8bg";
import { graphics } from "@8bitscript/graphics";

graphics.place(player, x, y);
graphics.update();
```

`graphics.update()` once a frame advances the animation and draws. Same
shape as `sprites.update()`.

Host decode lives in `@8bitscript/graphics-tools` (PNG, no Aseprite, GIF,
or SVG). The compiler never shells out. Lowering belongs to the machine:
C64, NES, PET, Atari 8-bit, and VIC-20 each export a `"8bitscript".media` module.
Every other machine uses the glyph path `@8bitscript/sprites` already has,
with `8BS2111` naming the adaptation.

## How the four stress machines differ

| Machine | What the PNG becomes |
| --- | --- |
| C64 | 24×21 VIC-II sprite bytes (16×16 is padded). Extra colours are quantized (`8BS2110`). |
| NES | CHR tiles from `$E0` and an OAM sprite. |
| PET | A 4×4 quadrant-block object, or a single glyph if the picture cannot survive that (`8BS2111` either way). |
| Atari 8-bit | A software glyph; frames collapsed (`8BS2111`). Player/missile shapes are a later slice. |
| VIC-20 | Quadrant-block characters from the ROM, worked out at build time: one cell for a source of 8 pixels or fewer, 2×2 cells for anything larger (scaled down), one screen code a cell a frame, the animation's frames (the first 8) stepping every `every` updates; a picture with almost no ink becomes one glyph (`8BS2111` either way). Moving an object blanks the cells it left; cells off the screen are not drawn. |
| Commander X16 | The glyph path, quantized to 8×8 cells (`8BS2111`). |
| every other machine | The same glyph path, quantized to that machine's cell size. |

Unused `target` blocks are not in this slice. A NES build does not
contain VIC-II sprite data.

## Diagnostics (`8BS21xx`)

| Code | Means |
| --- | --- |
| 8BS2101 | Graphics syntax error |
| 8BS2102 | Unexpected character |
| 8BS2103 | Unterminated string |
| 8BS2104 | Missing or unreadable PNG |
| 8BS2105 | PNG smaller than `size` |
| 8BS2106 | Unknown field |
| 8BS2107 | Duplicate resource name |
| 8BS2108 | Missing required field (`source`, `size`, `frames`) |
| 8BS2109 | Size outside 1×1..64×64 |
| 8BS2110 | More colours than the sprite can hold (warning; extra colours quantized) |
| 8BS2111 | Adapted: software glyph, colours dropped, or frames collapsed |

## What it costs

`packages/examples/media-walk`, `memory.program` then RAM
(`8bs build <target> --size`, 2026-09-24). The stock PET 2001's 4K is
too small (the program ends 284 bytes past `$1000`); the measured PET is
the 32K 3032 with a user-port speaker so the VIA song actually plays.

| Machine | Program | Variables |
| --- | --- | --- |
| PET 3032 + speaker | 3493 | 46 |
| C64 | 4276 | 45 |
| VIC-20 8K | 2455 | 49 |
| Commander X16 | 2918 | 58 |

The VIC-20 row was measured again on 2026-10-03, after its twin changed: it
was 2383 and 41 on the same example before, and the 256-byte glyph table it
then kept is gone. The example's arrays count in the program figure (they are
zero-filled bytes in the image), not in the variables one. The unexpanded
machine builds the same program at the same size.

Later: tiles, tilemaps, fonts, vectors, raster blocks, Aseprite. The GIR
has empty slots (`tiles`, `fonts`) so those land without reshaping the IR.
