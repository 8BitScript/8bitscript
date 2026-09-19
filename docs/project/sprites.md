---
title: Sprites, across nine machines
nav_order: 83
---

# Sprites, across nine machines

*Design note, 2026-09-19. The companion to [frame.md](frame.md): that
document is the frame — a plan built between frames and handed over
whole; this one is the objects that move in it. `@8bitscript/sprites`
was called `actors` for a day; it is called sprites because the C64 twin
*is* sprites, and because the point of the portable surface is that it
hands out more of them than the chip has — and means the same thing on a
machine with no sprite hardware at all.*

Research behind it, all read on 2026-09-19 from primary sources: the
nine machine packages' `AGENTS.md`; Bauer's VIC-II text; the nesdev
wiki; the VERA Programmer's Reference; the MEGA65 Book's VIC-IV
appendix and `viciv.vhdl`; the VIC-20 PRG; Cadaver's rants, Åkesson's
Field Sort and MISC, the codebase64 multiplexers (Fungus, THCM, Piper),
Braybrook's Morpheus diary, popmilo's measurements; PETSCII Robots' PET,
C64, VIC-20 and X16 sources; VIC-SSS, LBM8, Vixel, the Denial threads;
8bit-Unity, Oscar64, KickC, cc65, Millfork, NESlib/nesdoug, Prog8,
tat.multi-sprites, Mad Pascal. Figures marked *(estimate)* are
instruction-table arithmetic, not measurements; anything marked *to
verify* has not been seen on a screen.

## What every machine has, and what it can be made to have

Two limits on every machine, and they are different kinds of number:

| Machine | Hardware objects | Per line | Beyond the limit | Without hardware | Position unit |
| --- | --- | --- | --- | --- | --- |
| C64 | 8 register sets, 24×21 (12×21 in 3 colours) | 8 | **reuse down the frame**: a sprite is free 21 lines after its last Y; 1–5 list entries per reuse; the 63-entry list holds ~12 full reuses or ~27 moves — 20–35 objects | charset objects (bullets: ~60–200 cycles each), bitmap bobs (~3,000 per 24×21, *estimate*) | sprite coordinates; playfield at (24, 50) |
| C128 | the VIC-IIe's 8; the VDC none | 8 | as the C64 once a C128 raster list exists (`video.raster` is false there today); 2 MHz in the vertical border | as the C64 | as the C64 |
| MEGA65 | 8; 24 px, or 64 px mono, or 16 px in 16 colours; height 21 or one shared `SPRHGHT` | 8 | the C64 reuse (the VHDL re-triggers on Y match; undocumented), RRB `GOTOX` pseudo-sprites "limited only by raster time" | FCM/NCM characters | C64 space plus 10th X/Y bits |
| Atari 8-bit | 4 players + 4 missiles: full-height **strips**, 8 clocks wide, one colour, hardware collision | 4 (+1 from the missiles) | **band re-targeting**: HPOS/COLPM/SIZEP rewritten per band from a DLI (~3 stores in hblank); shapes pre-placed in the strips | charset (128 glyphs, five-colour modes 4/5) | X in **colour clocks** (2 px); Y is a **strip byte index** — there is no Y register |
| NES | 64 OAM entries, 8×8 or 8×16, 3 colours | 8 | **order per frame**: OAM rebuilt each frame, a `const` permutation rotates which objects come first (flicker, not dropout); no mid-frame reuse — OAM is vblank-only (DMA 513 cycles of a ~2,273-cycle blank) | nametable tiles — through the same vblank, a 48-byte queue (~12 cells a frame) | pixels; Y is top − 1; hide at Y ≥ `$EF` |
| X16 | 128 descriptors, 8–64 px, 15 or 255 colours | a **798-cycle budget**: 46 at 8 px/4 bpp … 5 at 64 px/8 bpp | size and depth; index order is drop order; attributes may be rewritten at a line IRQ (1–2 lines late) | two tile layers | 10-bit, wraps at 1024; hide = Z 0 |
| VIC-20 | none | — | — | **charset objects**: 2×2 glyphs per 8×8 shape at pixel positions (32 bytes a frame each), 64 spare glyphs unexpanded; the screen is RAM, so the background is restorable | cells; pixels with a charset twin |
| PET | none | — | — | **quadrant objects**: the 16 PETSCII 2×2 codes give 80×50 pseudo-pixels; an 8×8 shape at 2:1 is 2×2 cells, moving in 4-px steps; the screen at `$8000` is readable, so quadrant cells merge and restore | cells; pseudo-pixels |
| web | none | — | — | cells; quadrant codes 128–143 | cells |

Shipped PET action games — PETSCII Robots included, its source read —
move objects by whole cells (3×3-character tiles with a per-character
transparency code) and erase by redrawing the map. Quadrant-resolution
*plotting* is documented (masswerk's PET-Globe, Van Wagner's 80×50
library); a quadrant *sprite* at 4-px steps was not found in any
shipped game. Offering it goes past what the scene shipped; this
document says so rather than implying a precedent.

## The decisions

### 1. Two limits, two consts, stated for a size

`sprites.MAX` is how many objects the layer holds; `sprites.PER_LINE`
is what one scanline can show *of the object size the layer draws*. On
the X16 that is 128 and "46 at 8 px, 4 bpp"; on the NES 64 hardware
entries make 16 objects of 16×16 in 8×16 mode, 4 of them per line; on
the C64 24 (a package number: the list could carry 20–35) and 8. Cells
have no per-line limit that matters — their limit is cells written per
frame. `dropped()` stays: no other framework in the survey reports what
it failed to show.

### 2. An object is not a hardware sprite

The portable object sizes are **8×8 and 16×16**; 24×21 is the C64's
shape and only the C64's. What one object costs:

| Object | C64 | X16 | NES | Atari | VIC-20 (charset) | PET (quadrant) |
| --- | --- | --- | --- | --- | --- | --- |
| 8×8 | 1 sprite | 1 descriptor | 1 entry | 1 player | 4 glyphs (pixel-positioned) | 2×2 cells at 2:1, up to 3×3 straddled |
| 16×16 | 1 sprite | 1 descriptor | 4 entries (2 in 8×16), 2 of the 8 per line | 2 players | 9 glyphs | 4×4 cells, up to 5×5 |

`WIDTH`/`HEIGHT` therefore mean "the object size this layer promises":
per machine, and on the PET the same shape is physically twice the size
(a 4-px pseudo-pixel). Anchor stays the top-left; a program that wants
centres adds `WIDTH / 2` — 8bit-Unity anchors at the centre instead,
and pays with per-machine scaling arithmetic at run time.

### 3. A shape is a 1-bpp `const` bitmap, converted at build time

Every machine consumes a 1-bpp bitmap cheaply if the conversion is done
before the program runs: a 63-byte block (C64), 16-byte CHR tiles into
the ROM image (NES, where it is the *only* way on NROM), strip bytes
(Atari), a 4-bpp VRAM image (X16), glyph bytes (VIC-20), `QUAD` codes
per parity (PET: 9–18 bytes a parity, 36–72 a frame, *estimate*).

The language cannot do this itself — no array parameters, no expression
in a namespace const — so the mechanism is a **generator**: `8bs shapes
<bitmap>` emitting `shapes.8bs` and its machine twins, exactly the
twin-file pattern `examples/swarm/src/shapes.8bs` /
`shapes.c64.8bs` uses by hand today. Until it exists, the hand-written
twin is the documented interim, and `setShape(n, shape)` takes the
twin's handle (a block, a glyph, a tile index).

### 4. Positions: stage pixels, never negative — and `y` is 16 bits

Stage pixels stay (frame.md): the stage's own top-left, `ORIGIN_X/Y`
the playfield's, no signed compare in any inner loop. `y` widens to
`usmallint`: a byte was the C64 register's width, not the grid's, and
it left the X16's 56 rows and the web's 64 unreachable. `STEP_X` joins
the consts (1 on sprite machines, 2 for Atari colour clocks and VIC-20
multicolour, 4 for PET quadrants, 8 for glyph cells) so a program moves
by the step it can see.

### 5. Erase and restore: `RESTORES`, and save-under where the screen can be read

The PET (`$8000`), VIC-20, C64/C128, Atari, MEGA65 and X16 can read what
an object covers; the NES cannot cheaply and the web cannot at all.
Where it can, the layer keeps a save-under buffer per object and
**restores every dirty object before drawing any** — which retires, on
those machines, the cell layer's "another sprite in the cell I am
leaving" scan and its per-row count (the portable cell layer, where
`RESTORES` is false, still carries them). `sprites.RESTORES` folds to
true or false;
`setBackground()` stays as the fallback where it is false, and text
under a sprite is lost only there.

### 6. Beyond the limit is three mechanisms; the surface names only the outcome

Reuse down the frame (C64, C128, MEGA65), order per frame (NES: a
`const` permutation table with the player pinned first, as nesdoug does;
X16: index order under the budget), band re-targeting (Atari). A fourth
tier on every machine with a charset is **character objects** for
bullets and fragments — the production pattern on the C64 (Armalyte,
Turrican, EFNY: sprites for bodies, characters for bullets, "no limit"
but the charset). A `pin(n)` / priority hint is later.

### 7. Cost is the plan, and the plan is native

The C64's `multiplex.update()` was ~16,000 cycles for 16 sprites in the
compiler's generic code; the research estimated hand assembly with
tables at page-aligned fixed addresses at ~3,300 (Cadaver's persistent
insertion sort at 26 cycles per in-order element, an unrolled frame
table, emission through `raster.spriteEntries`'s layout) and ~5,850 for
24. Built and measured the same day: ~9,500 for 16 in a window that also
holds the VIC's bad lines, the sprites' DMA and the handler's dozen
interrupts (~40% of it); the routine itself is nearer 6,500 — the
estimate was for the routine alone, and the steal is the frame's
regardless. Past 24 the list's
63 slots run out before cycles do; 32 needs a compact two-slot reuse
entry in the handler (~65 cycles, 8 bytes per reuse) — designed, not
built. The same rule reaches the cell twins: a PET quadrant object
measured ~2,600 cycles erased and redrawn in compiled code — ~130 a
cell in the inner loop, the rest the walk and its bookkeeping — against
the ~250–550 hand-written *(estimate)*.

## Corrections to frame.md's sprite table, from the research

- **NES**: the cell layer is not free there. `text.putChar` is a queued
  PPU run through a 48-byte vblank queue (~12 cells a frame): sixteen
  moving glyphs overflow every frame and tear. Written into the
  package README the same day.
- **X16**: `MAX` 128, `PER_LINE` 46 *for 8 px / 4 bpp* — the table
  conflated the two.
- **Atari**: "~16 per frame" had no source (a tutorial demo runs 12
  bands × 4); X is colour clocks, Y a strip index with no register.
- **MEGA65**: 64 px is mono only; 16-colour sprites are 16 px;
  `SPRHGHT` is one shared value — the catalog's 64/255/15 triple cannot
  hold at once.
- **C128, MEGA65**: "the C64 layer ported" is a new layer (`video.raster`
  false on both, different IRQ ownership and bank rules), not a port.
- **Y-stretch** on the C64 is list-friendly at 2-line granularity (two
  `$D017` entries, *to verify* in x64sc); frame.md marks it H.

## To verify in x64sc before it is written as fact

1. `LANDING` with eight active sprites and a bad line: five entries may
   land at +5 lines, not +4.
2. PAL raster low-byte wrap: a hardware sprite whose last Y is ≤ 42
   redraws at 257 + Y in an opened lower border — this can reach the
   twin's `top()` of 30; probe under `--pal` before promising 30–240.
3. The two-entry `$D017` coarse stretch.
4. Whether a flicker-alternation drop policy looks acceptable on the C64
   (no source documents one).

## What ships in which order

1. `y` as `usmallint`, `STEP_X`, `RESTORES` on the surface.
2. The PET quadrant twin (`index.pet.8bs`): shipped, `MAX` 8 from the
   VIA-timer measurement (~2,600 cycles a sprite erased and redrawn;
   five moving fit a 60 Hz frame; eight all moving take two), the
   frame's work done on the set of movers and whatever they touch, and
   a walk through two standing sprites over text verified pixel-exact
   under xpet. The swarm's PET is the 3032 from here: the twin's tables
   (252 bytes of shape patterns, 72 of save-under) put the example past
   the 2001's 4K.
3. Native `multiplex.update`: shipped as `native/6502/multiplex.s`, the
   tables in page $06, the same steps and drops as the 8BitScript body
   it replaced (the x64sc sprite and multiplex probes passed unchanged).
   ~9,500 cycles for sixteen where the compiled body was ~16,000 — with
   ~40% of that window the VIC's and the handler's own steal, not the
   routine — and the swarm at sixteen at one hardware frame an
   iteration (98% of frames; the rest are recolour frames a hair over).
   Twenty to twenty-four is the list's 63 slots and the frame's
   remaining ~2,000 cycles, not verified at rate; the compact reuse
   entry stays designed.
4. Designed, not built: the shape generator; NES, X16, Atari and VIC-20
   charset twins; C128 and MEGA65 layers; priority/pin; the compact
   reuse entry.
