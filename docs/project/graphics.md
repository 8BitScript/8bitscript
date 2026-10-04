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
shape as `sprites.update()`. The rest of what a program can say, and what
each machine answers, is [the portable contract](#the-portable-contract).

Host decode lives in `@8bitscript/graphics-tools` (PNG, no Aseprite, GIF,
or SVG). The compiler never shells out. Lowering belongs to the machine:
C64, NES, PET, Atari 8-bit, and VIC-20 each export a `"8bitscript".media` module.
Every other machine uses the glyph path `@8bitscript/sprites` already has,
with `8BS2111` naming the adaptation. The web exports one too, because its
font draws only ASCII and the sixteen 2×2 block codes: the default glyph
codes (reverse space, a ball) are PETSCII and draw nothing there. It lowers
a picture to an 8×8 bitmap per animation step, which the web twin writes into
the runtime's redefinable glyph table (`@8bitscript/web/charset`).

## The portable contract

One program should run on every machine, doing as much as the machine
can and saying honestly what it cannot. So `@8bitscript/graphics` is a
**contract**: every machine's twin (`packages/graphics/src/index.<machine>.8bs`,
the generic one in `index.8bs` for the rest) answers the same ten constants
and exports the same eight calls. A machine that can do more says so in
its constants; a machine that can do less answers honestly and the call
degrades. A call never fails to link and never writes outside its own
tables, and `packages/compiler/test/graphics-contract.test.mjs` builds a
probe that reads every constant and calls every operation on all
thirty-two targets to hold that.

```8bs
import { graphics } from "@8bitscript/graphics";

graphics.place(hero, 40, 80);            // stage pixels, the same on every machine
if (graphics.RECOLORS) {                 // folds away where false: costs that machine nothing
    graphics.color(hero, 2);
}
if (graphics.FRAMES >= 4) {
    graphics.setFrame(hero, 3);
}
```

### Where a position lands

Positions are **playfield pixels**: the origin is the top-left of the
playfield, y runs down, and `graphics.place(slot, 0, 0)` lands on the same
pixel as text cell (0, 0) on every machine. The twin adds whatever its
hardware needs — the C64's sprite coordinates start at (24, 50), the X16
adds the display's `DC_VSTART` — so a program never writes
`sprites.ORIGIN_X`. (That is the one difference from `sprites.place`, the
layer underneath, which takes stage coordinates and leaves the origin to
the program. A program that mixes the two adds the origin to the second.)

A position that is not a multiple of `STEP_X`/`STEP_Y` is rounded down to
one. A position outside the playfield clips: the picture is not drawn, it
does not wrap onto the next row, and it never writes outside the machine's
own tables. On the C64 a sprite that straddles the right or bottom edge
shows the part inside the playfield (the border covers the rest), one that
starts past the playfield is not drawn, and a position past 255 is fine
until then — see [On the C64](#on-the-c64).

### The constants

Each is a compile-time value, so a guard on one costs a machine that
answers false nothing. The honest value is the degradation: a machine
does not claim a capability so as to look like another.

| Constant | Means |
| --- | --- |
| `MAX` | Objects at once. A slot at or past it is ignored. |
| `FRAMES` | Animation frames a picture of `WIDTH`×`HEIGHT` can hold; frames past it are cut at build time (`8BS2111`). |
| `WIDTH`, `HEIGHT` | Pixels of the largest picture drawn whole. |
| `COLORS` | Colours one object shows at once (1: a single ink). |
| `RECOLORS` | `color()` changes an object's colour. |
| `STEP_X`, `STEP_Y` | The smallest move that shows, in pixels. |
| `RESTORES` | What an object covered comes back when it moves or hides. |
| `TRANSPARENT` | An unlit pixel of a picture leaves what is under it showing. |

One row per machine, so a machine's own work edits its row and nothing else
(`graphics-contract.test.mjs` holds the same table; change both together):

| Machine | `MAX` | `FRAMES` | `WIDTH`×`HEIGHT` | `COLORS` | `RECOLORS` | `STEP_X`×`STEP_Y` | `RESTORES` | `TRANSPARENT` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PET | 8 | 7 (shared by every picture) | 16×16 | 1 | no | 4×4 | yes | yes (a letter underneath is replaced) |
| VIC-20 | 8 | 8 (one 64-byte pool) | 16×16 | 1 | yes | 8×8 | no | no |
| C64 | 24 (eight on one line) | 4 | 24×21 | 1 | yes | 1×1 | yes | yes |
| Commander X16 | 8 | 2 at 64×64 (32 at 16×16, 8 at 32×16) | 64×64 | 15 | yes | 1×1 | yes | yes |
| Web | 8 | 8 | 8×8 | 1 | yes | 8×8 | no | no |
| NES (parked) | 8 | 4 | 16×16 | 3 | no | 1×1 | yes | yes |
| every other machine | 8 | 4 | 8×8 | 1 | where it colours cells | 8×8 | no | no |

### The calls

| Call | Does |
| --- | --- |
| `place(slot, x, y)` | Draw the object at a playfield pixel; also shows a hidden one. |
| `hide(slot)` | Stop drawing it, until the next `place()`. |
| `setFrame(slot, n)` | Show frame `n` of its animation; a frame past the last is the last. |
| `animate(slot, on)` | Pause (`false`) or resume (`true`) its automatic stepping. |
| `color(slot, c)` | The object's colour, where `RECOLORS`; otherwise nothing. |
| `update()` | Once a frame: advance every playing animation, then draw. |

Every call that changes what is shown takes effect by the next `update()`.
There is no separate `show`: the layers underneath all define `hide` as
"not drawn until placed again", so a position-free `show` would make every
twin keep a position per slot — four bytes a slot, on top of what the sprite
layer already holds — to save a program one `place()` it can already write. A program that hides and shows an object knows where
it is and says so in `place`.

Where each machine stands on each call. *Verified* means a headless
emulator screenshot shows it; *links* means the contract test builds it and
it is the same code path as a verified call, but nothing has looked at the
screen yet — that is the next piece of work on that machine.

| Machine | `place` / `update` | `hide` | `setFrame` | `animate` | `color` |
| --- | --- | --- | --- | --- | --- |
| PET | verified | verified | verified | verified | stub (`RECOLORS` false) |
| VIC-20 | verified | verified | verified | verified | verified |
| C64 | verified (under the playfield-pixel rule) | verified | verified | verified | verified |
| Commander X16 | verified | verified | verified | verified | verified |
| Web | verified | verified | verified | verified | verified |
| NES (parked) | links | links | links | links | stub |
| every other machine | links | links | links | links | links |

The "every other machine" row is the glyph path of `index.8bs`, which is
the code the web twin copies and which has no emulator behind it here;
the web's tests (`packages/cli/test/web-graphics-ops.test.mjs`) are the
nearest evidence for it.

## How the four stress machines differ

| Machine | What the PNG becomes |
| --- | --- |
| C64 | 24×21 VIC-II sprite bytes (16×16 is padded), one colour: the palette entry nearest the PNG's most common opaque colour. Extra colours are quantized (`8BS2110`). Up to 24 sprites (eight per raster line, reused down the screen) of up to 4 frames each; a longer animation is cut to 4 (`8BS2111`). See [On the C64](#on-the-c64) for what a position, a recolour and a crowded line do. |
| NES | CHR tiles from `$E0` and an OAM sprite. |
| PET | A 4×4 quadrant-block object, one sprite-layer shape a frame of the animation — seven shapes in all, shared by every picture in the program — or a small centre block if the picture is too faint to survive the downsample (`8BS2111` either way, and again when frames are dropped or a picture finds no shape left). |
| Atari 8-bit | A software glyph; frames collapsed (`8BS2111`). Player/missile shapes are a later slice. |
| VIC-20 | Quadrant-block characters from the ROM, worked out at build time: one cell for a source of 8 pixels or fewer, 2×2 cells for anything larger (scaled down), one screen code a cell a frame, the animation's frames (the first 8) stepping every `every` updates; a picture with almost no ink becomes one glyph (`8BS2111` either way, and each sprite says how many of the 64 pool bytes it takes). Moving or hiding an object blanks the cells it left and puts their colour back to white; cells off the screen are not drawn. See [On the VIC-20](#on-the-vic-20). |
| Commander X16 | A VERA hardware sprite in its own 15-colour palette; 8, 16, 32 or 64 px a side, real animation frames (`8BS2110` over 15 colours, `8BS2111` for padding or cut frames). See [Commander X16](#commander-x16). |
| Web | One cell of real art per animation step: `packages/web/media/index.cjs` reduces each frame at build time to an 8×8 bitmap (eight row bytes, bit 0 the leftmost pixel; an 8×8 source is carried pixel for pixel, a larger one by area, a glyph pixel lit at half its source pixels or more), `packages/graphics/src/index.web.8bs` writes it into the runtime's redefinable glyph table (`@8bitscript/web/charset`, character codes 176–255) and draws it as a cell, up to eight pictures of eight steps, stepped every `every` calls to `graphics.update()`. One ink per cell (`graphics.color()` tints it); a source with more than one colour, or a larger size, or steps past eight is adapted and the build says so (`8BS2111`). A true sprite layer is a later item for the web runtime (`packages/web/AGENTS.md`). |
| every other machine | The same glyph path, quantized to that machine's cell size: one glyph per animation step, up to four (`8BS2111` names what was dropped). |

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

### On the VIC-20

Every call of the contract is verified on the VIC-20, in two ways that
cover each other: the twin's own code run cell by cell without an emulator
(`packages/graphics/test/vic20-ops.test.mjs`, which CI runs, and which fails
on each of ten deliberate breakages of the twin) and the 6502 build under
xvic by pixel (`packages/vic20/test/graphics-ops.test.mjs`), unexpanded and
with 8K.

- **`hide`** blanks the object's cells and puts their colour RAM back to
  white, at once; hiding twice, or updating while hidden, changes nothing.
  `place` shows it again, wherever it is told.
- **`setFrame`** shows from the next `update()`, and a frame past the last is
  the last. **`animate(false)`** holds the frame an object is on while the
  others play; **`animate(true)`** carries on from that frame and update count
  (`setFrame` starts the count again, so a frame it sets lasts a full `every`
  updates).
- **`color`** takes the first eight colours: a character's colour RAM bit 3
  would make its cells multicolor, so 8–15 wrap to 0–7 (`color(slot, 9)` is
  `color(slot, 1)`), the way `text.putColor` does. It shows from the next
  `update()`. The cells an object leaves are white, not left in its ink, so a
  character stored there later is not tinted.
- **The pool.** Every object's codes live in one 64-byte pool — an object
  takes frames × cells bytes, 4 for a still 16×16 picture, 32 for an
  eight-frame one — and the last byte is usable. An object that would pass it
  is not drawn, every call on it does nothing, and the others are not
  affected. The build says what each sprite takes (`8BS2111`: "taking 12 of
  the 64 pool bytes every object shares"), but one sprite at a time, so
  adding them up is the program's job; a media module cannot see the others.
- **With a raster `Slot.CHARSET` split** an object is the same object in
  either half: its quadrant blocks are in both ROM sets.

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
| PET 3032 + speaker | 3787 | 50 |
| C64 | 4692 | 46 |
| VIC-20 8K | 2515 | 48 |
| Commander X16 | 4114 | 70 |
| Web (wasm module bytes) | 1956 | 203 |

These are the figures after the portable contract landed
(2026-10-04); before it they were 3765, 4577, 2455, 3982 and 1797 bytes of
program. The difference — 22, 60, 38, 20 and 23 bytes on an example that
calls only `place()` and `update()` — is the pause flag every animation loop
now reads, the array that holds it (it counts in the program figure on
the machines whose arrays are zero-filled bytes in the image), and on the
C64 the two additions that put the playfield's origin on every `place()`.
Programs that call `setFrame`, `hide`, `animate` or `color` pay for those
on top, measured when something uses them.

The X16 row moved again on 2026-10-04 (4002 and 69 before, 4114 and 70
now), when the twin gained a guard against off-screen positions and the
palette copy `color()` restores from: `bind()` writes each palette byte
twice, and `showSprite` compares the position with the screen. A program
that places and updates one 16×16 sprite is 2025 bytes and 65 of RAM; the
same program that also calls `hide`, `setFrame`, `animate` and `color` is
2506 and 69. Of the 481 bytes, `color` is 286, `setFrame` 69, `hide` 60
and `animate` 28; a call a program never makes costs nothing.

The web row is `examples/media-walk` built with `8bs build --target web
--size`: the module's byte count, and the declared RAM for variables. It was
1610 and 235 with the default glyph path, which also drew nothing for that
example's picture; 1797 and 259 once the twin kept one block code per step
(2026-10-03); 1820 and 267 after the portable contract (2026-10-04); and
1956 and 203 now that a picture is eight row bytes a step written straight
into the glyph table (2026-10-04). The 136 bytes more are the binder calls
that carry eight bytes a step instead of one; the 64 bytes less are the
code table the twin no longer keeps — the glyph table is the runtime's own
memory, not the program's.

The VIC-20 row was measured again on 2026-10-03, after its twin changed: it
was 2383 and 41 on the same example before, and the 256-byte glyph table it
then kept is gone. The example's arrays count in the program figure (they are
zero-filled bytes in the image), not in the variables one. The unexpanded
machine builds the same program at the same size. Verifying `color` and
`hide` on 2026-10-04 found two faults and fixed them for 22 bytes (2493 to
2515, the same 48 of RAM): `color` now masks its argument to three bits, and
a blanked cell's colour RAM goes back to white.

The C64 row was measured again on 2026-10-04 once the position guard
(below) went in: 4637 → 4692 bytes of program, 46 of variables. The 55
bytes are the two 16-bit comparisons in `place()` and the "not drawn" branch
they select; nothing a program does after `place()` pays for them.

## On the C64

Everything here was read back from `x64sc` screenshots
(`packages/c64/test/graphics-ops.test.mjs`, headless, NTSC), and the part
that can run without an emulator is in CI
(`packages/graphics/test/c64-ops.test.mjs`).

**Every call is verified.** In one program of eighteen sprites (more than the
VIC-II's eight, so the multiplexer reuses hardware sprites):

- `setFrame(slot, 9)` on a four-frame picture shows frame 3, the last, and
  `animate(slot, false)` keeps it there through sixteen `update()`s; a second
  picture that is paused for four updates and then resumed has taken exactly
  the six steps twelve further updates make at `every 2` (frame 2).
- `hide(slot)` then `place` puts the picture at the second position and not the
  first; a sprite that is hidden and never placed again is absent. A sprite a
  `.8bg` declared and a program never placed is hidden too, not a ghost.
- `color(slot, c)` recolours only that sprite — one that was in the first
  eight and one the multiplexer reuses (the tenth of a staircase), each whole,
  with every other dot keeping the colour its PNG gave it.
- A call with a slot the layer does not hold (40), or one inside the range that no
  `.8bg` declared (21), changes nothing and draws nothing.

**Where a position lands.** Stage pixels, `place(slot, 0, 0)` at text cell
(0, 0), a pixel at a time. A sprite that straddles the right or bottom edge shows
the part inside the playfield (24 columns at x = 300 leave 20; 21 rows at
y = 190 leave 10) because the border covers the rest. One that *starts* past
the playfield — x of 320 or more, y of 205 or more — is not drawn, and
`place()` says so itself rather than leave it to the chip: the sprite chip's
X register is nine bits, and a stage x of 500 (chip X 524) used to set the ninth bit and
come out at X 268, in the middle of the picture; a stage y near 65535 plus the
playfield's 50-line offset wraps a 16-bit sum back to a small number, which the
closed border hides but `sprites.extend(true)` (the opened vertical border) does
not — 192 pixels of a wrapped sprite were measured at the top of the capture.
Both are in the tests, each fails without its guard.

**Eight on a line.** Twelve sprites placed on one raster line, 26 pixels
apart and right to left so that slot order and screen order disagree: exactly
eight draw, the first eight in slot order (`d0`–`d7`); `d8`–`d11` are dropped,
every frame, and the same eight show at `--frames 300` and `340`. There is no
flicker rotation, so a program that needs a ninth on a line decides which one
loses (spread them over lines, or swap which slots it places). `sprites.dropped()`
counts them.

**A raster list in the same frame.** `graphics.update()` owns the list: it clears
it at the start and commits it at the end, as `sprites.update()` does. So:

- Entries built *before* `graphics.update()` are gone — a border split at picture line 60,
  built with the portable `raster.clear()`/`raster.at()` first, did not appear.
- Entries added *after* it, with a second `raster.commit()`, edit the page the first
  commit just handed over. With two entries it was clean; with three, a stray 8 × 6
  patch of a hardware sprite's power-on colour showed at one place in two of three
  runs. The cause was not found (the entry count was 13, nowhere near the 63 the list
  holds), so this order is not offered.
- The order that is clean builds the whole frame once: `graphics.step()` (this twin's one
  addition to the contract — it advances the animations and does nothing else, so a program
  that uses it is a C64 program), `raster.clear()`, `sprites.plan()`, the program's own
  entries with `raster.insert()`, and one `raster.commit()` (`raster.enable()` the first
  frame). Measured with twelve sprites (four of them reused), a border band at picture lines
  100–149 and two more entries at 10 and 20: the band is exactly there (the left border is yellow
  on capture rows 123–173, the entry showing from the line after it), black above
  and below, and all twelve sprites whole and in place
  (`test/graphics-raster-probe.8bs`). The sprite plan's entries and the program's share the list's
  63; the plan used 13 here, one to five per reuse.

Not done on the C64: multicolour sprites (`COLORS` would be 3; the lowering keeps one
colour), expansion, priority against the background, collisions. PAL builds were not captured.

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
- **`hide`, `setFrame`, `animate`.** `hide` writes z-depth 0, which VERA
  reads as "not drawn"; `place` writes it back, at the new position.
  `setFrame` clamps past the last frame, and a frame chosen while the object
  is hidden shows when it is placed. `animate(false)` freezes one object on
  its frame while the others keep stepping. Each is read off x16emu
  screenshots pixel by pixel in `packages/cx16/test/graphics-ops.test.mjs`.
- **Off the screen.** VERA keeps ten bits of a sprite's X and Y, so a
  position of 1020 comes back in at the left edge. A position at or past
  the screen's size (640 across, 480 down) now switches the sprite off
  instead, and `place` brings it back; one that straddles the edge is cut
  by the display window, not moved. (Before this, `place(x, 1020)` drew the
  sprite four pixels in from the left — the contract says an object off the
  playfield clips and never wraps.)
- **`color(slot, c)`.** `RECOLORS` is true. A `c` from 0 to 15 draws the
  object in that machine colour — the first sixteen palette entries, which
  are the KERNAL's text colours — on every opaque pixel, so the picture
  becomes a silhouette of it, the way the C64's sprite ink does. That is
  the portable meaning. The X16 also remembers the picture: a `c` from 16
  up (`255` is the convention) gives the object its own palette back. Both
  rewrite only that object's palette block, so other objects, the text and
  the raster list are untouched; the saved copy sits at VRAM `$C000 + slot *
  32`, past the eight sprite windows and short of the KERNAL's sprite data
  at `$13000`. It was chosen over pointing the sprite at a different
  palette block (the attribute's palette offset) because a block holds
  *some other object's* colours, not "colour c", and the other machines
  cannot say that.
- **More than eight objects: not done, and why.** VERA has 128 sprites, but
  an object owns a palette block and a 4096-byte pixel window, and only
  blocks 8–15 and `$4000`–`$BFFF` are free — eight of each. Sharing a
  palette block between objects needs the build to know which pictures have
  the same palette, and the media lowering sees one `.8bg` file at a time;
  sharing windows needs it to place pictures by their real size. And the
  contract has no way to put the same picture on the screen twice (one
  `place` moves one object), which is what a 5×3 reel of eight symbols
  would want. That is a contract change — an instance call — not an X16
  twin's decision, so `MAX` stays 8.

Not done: 8 bpp, collision masks, flips and per-sprite Z. Sprites are
switched on at the first `place()`. Sprite 0 (the KERNAL mouse cursor) is
never written; no test runs the mouse and the sprites together.

Later: tiles, tilemaps, fonts, vectors, raster blocks, Aseprite. The GIR
has empty slots (`tiles`, `fonts`) so those land without reshaping the IR.
