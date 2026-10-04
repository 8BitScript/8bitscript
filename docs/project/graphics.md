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
with `8BS2111` naming the adaptation. The web exports one too, because its
font draws only ASCII and the sixteen 2×2 block codes: the default glyph
codes (reverse space, a ball) are PETSCII and draw nothing there.

## How the four stress machines differ

| Machine | What the PNG becomes |
| --- | --- |
| C64 | 24×21 VIC-II sprite bytes (16×16 is padded), one colour: the palette entry nearest the PNG's most common opaque colour. Extra colours are quantized (`8BS2110`). Up to 24 sprites (eight per raster line, reused down the screen) of up to 4 frames each; a longer animation is cut to 4 (`8BS2111`). A position past X = 255 must be a `usmallint` sum — `sprites.ORIGIN_X + 236` wraps at 8 bits. |
| NES | CHR tiles from `$E0` and an OAM sprite. |
| PET | A 4×4 quadrant-block object, one sprite-layer shape a frame of the animation — seven shapes in all, shared by every picture in the program — or a small centre block if the picture is too faint to survive the downsample (`8BS2111` either way, and again when frames are dropped or a picture finds no shape left). |
| Atari 8-bit | A software glyph; frames collapsed (`8BS2111`). Player/missile shapes are a later slice. |
| VIC-20 | Quadrant-block characters from the ROM, worked out at build time: one cell for a source of 8 pixels or fewer, 2×2 cells for anything larger (scaled down), one screen code a cell a frame, the animation's frames (the first 8) stepping every `every` updates; a picture with almost no ink becomes one glyph (`8BS2111` either way). Moving an object blanks the cells it left; cells off the screen are not drawn. |
| Commander X16 | A VERA hardware sprite in its own 15-colour palette; 8, 16, 32 or 64 px a side, real animation frames (`8BS2110` over 15 colours, `8BS2111` for padding or cut frames). See [Commander X16](#commander-x16). |
| Web | One cell as a 2×2 quadrant-block glyph (codes 128–143) per animation step, up to eight steps, stepped every `every` calls to `graphics.update()`; colours dropped (`8BS2111`). A 16×16 picture is four quadrants of 8×8 source pixels. A true sprite layer is a later item for the web runtime (`packages/web/AGENTS.md`). |
| every other machine | The same glyph path, quantized to that machine's cell size. |

### On the PET

A picture's frames are the sheet's frames its `animation` names, in that
order. The sprite layer holds seven shapes (`sprites.SHAPES`), so the
program as a whole can have seven frames: a still picture spends one,
a four-frame walk four. They are handed out in the order the `.8bg`
files are imported and the sprites declared; the build says when a
picture is cut short (`8BS2111`: "the last 1 frame dropped") or finds
none left ("not drawn"), and the program shows exactly that, nothing
quieter. All of a picture's frames are defined once, before `main()`
runs, so changing frame is one shape switch and costs the frame
nothing to speak of; the sprite layer then redraws the picture where
it stands like any other moved sprite (about 2,600 cycles on a 3032).

That redraw happens right after `waitFrame()` returns, with the beam
already on its way down the picture: a picture that changes frame
near the top of the screen can be seen part-old, part-new for that one
frame (`packages/sprites/src/index.pet.8bs`, header). A picture in the
lower half of the screen is clear of it.

What counts as the picture: if the PNG has transparent pixels, every
pixel that is not transparent (as on the C64, whatever its colour); a
fully opaque PNG has only its colours to go on, so bright pixels are
taken for paper and dark ones for ink. Each 4×4 pseudo-pixel is lit
when at least 30% of the source pixels under it are.

`graphics.update()` counts its own calls — `every 4` is four
`update()` calls, one per `waitFrame()` in the usual loop — exactly as
on the C64.

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
(`8bs build <target> --size`, 2026-09-24; the PET row re-measured
2026-10-03, after its animation landed — 3591 before the animation
driver, 3765 with it). The stock PET 2001's 4K is too small (the
program ends 284 bytes past `$1000`); the measured PET is the 32K 3032
with a user-port speaker so the VIA song actually plays.

| Machine | Program | Variables |
| --- | --- | --- |
| PET 3032 + speaker | 3765 | 50 |
| C64 (re-measured 2026-10-03) | 4577 | 46 |
| VIC-20 8K | 2455 | 49 |
| Commander X16 | 3982 | 70 |
| Web (wasm module bytes) | 1797 | 259 |

The web row is `examples/media-walk` built with `8bs build --target web
--size` on 2026-10-03: the module's byte count, and the declared RAM for
variables. It was 1610 and 235 with the default glyph path, which also drew
nothing for that example's picture; the 187 bytes are mostly the animation
stepper in `graphics.update()`.

The VIC-20 row was measured again on 2026-10-03, after its twin changed: it
was 2383 and 41 on the same example before, and the 256-byte glyph table it
then kept is gone. The example's arrays count in the program figure (they are
zero-filled bytes in the image), not in the variables one. The unexpanded
machine builds the same program at the same size.

## Commander X16

A `.8bg` sprite on the X16 is a VERA hardware sprite, not a glyph.
`packages/cx16/media/index.cjs` turns the PNG into a 32-byte palette
followed by every animation frame as a linear 4 bpp bitmap (VERA's sprite
renderer reads a bitmap row by row, left pixel in the high nibble, not
8×8 tiles), and `packages/graphics/src/index.cx16.8bs` puts them in
video memory. Measured under x16emu r50 (ROM `fbe32a60`), headless, with
`packages/cx16/test/graphics.test.mjs`:

- **Colours.** Up to 15 plus transparent, quantized to VERA's 12 bits, the
  most-used first. Each sprite owns a 16-entry block of palette entries
  128 and up (`8 + slot` is the attribute's palette offset), so it shows
  the picture's own colours rather than the default palette's, and the
  KERNAL's text colours (entries 0–127) are never touched. More than 15
  distinct colours is `8BS2110`; the rarest map to the nearest kept one.
  8 bpp sprites (255 colours) are not offered.
- **Size.** The next legal VERA size at or above `size`, padded with
  transparent pixels: `20x12` is a 32×16 sprite whose padding stays
  background. Larger than 64×64 is cut (`8BS2111`).
- **Animation.** Frames follow each other in the sprite's own 4096-byte
  window of video memory (`$4000 + slot * $1000`); `graphics.update()`
  steps the sprite's address pointer every `every` frames and writes
  nothing else. A frame count that does not fit the window is cut
  (`8BS2111`): 32 frames at 16×16, 8 at 32×16, 2 at 64×64.
- **Slots.** Eight objects (`MAX`), VERA sprites 1–8. Sprite 0 is the
  KERNAL's mouse cursor and is left alone.
- **Where it lands.** `graphics.place(x, y)` is a stage pixel: (0, 0) is the
  picture's top-left corner, the same pixel as text cell (0, 0), after
  `screen.blank()` has inset the display. A sprite's first line sits one
  line above the layers' with a nonzero `DC_VSTART`; the driver reads that
  once when sprites are switched on and adds the line back.
- **With a raster list.** `raster` entries and sprites share the screen:
  the list's line IRQ and the sprite writes both go through VERA's data
  port, which the handler saves and restores.

Not done: 8 bpp, collision masks, flips, per-sprite Z, and more than eight
objects. Sprites are switched on at the first `place()`; nothing hides
them again.

Later: tiles, tilemaps, fonts, vectors, raster blocks, Aseprite. The GIR
has empty slots (`tiles`, `fonts`) so those land without reshaping the IR.
