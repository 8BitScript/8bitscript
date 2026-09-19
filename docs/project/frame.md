---
title: The frame, across nine machines
nav_order: 81
---

# The frame, across nine machines

Design direction for what a program can make the picture do *during* a
frame — a status bar that does not scroll with the playfield, colour that
changes down the screen, more moving objects than the chip has sprites,
objects leaving the playfield whole, a scripted sequence of such things —
written against what the repository already does. These are the
techniques the demoscene worked out chip by chip over forty years, and
this document's job is to make them **standard features with portable
names**, each one saying honestly, per machine, what it does and what it
costs. The word for them here is *frame-time effects*; the other word is
not used, because every one of them is a documented property of a chip.

The short version: a frame is a **plan built between frames and handed
over whole** — a list of writes at lines, a table of object registers, a
row of keyframes — never code that runs at a line. Each thing a plan can
say is an *intent* with a portable package, a fact that says how this
machine answers it, and a written degradation for machines that cannot.

## What already exists

- **`@8bitscript/raster`** — *what the picture does at a picture line*:
  `Slot.BORDER`, `BACKGROUND`, `SCROLL_X`; `at(line, slot, value)`,
  `setValue(entry, value)`, `enable()`. Real on the C64 (an IRQ-driven
  write list in `native/6502/raster.s`) and the web; an honest zero-cost
  stub on the other seven behind `#fact(video.raster)`. `examples/fancy`
  is the pattern: build once, rewrite values per frame, fold away
  elsewhere.
- **The C64 list's mechanics** (`packages/c64/AGENTS.md`, "Three things
  the VIC-II does that its manual does not say"): two list pages with an
  atomic `commit()`, the pass ending at line 255, entries applied late
  rather than dropped, a per-page **frame table** of the eight sprites'
  registers written by the handler at the pass end, `insert()` for
  out-of-order entries. And three machine-only layers on it:
  `@8bitscript/c64/border` (the vertical border opened for sprites),
  `@8bitscript/c64/idle` (the idle-graphics byte), and
  `@8bitscript/c64/multiplex` (24 virtual sprites from eight).
- **Facts** (`packages/compiler/src/fold/facts.mjs`): every catalog states
  `video.raster`, `video.sprites`, `video.spritesPerLine`, ... as the
  worst case that matters; `#fact()` folds, and `@8bitscript/system`
  names each one. A capability a machine cannot honour ships a layer of
  honest constants so the program links and the fold removes the cost
  (`packages/input/AGENTS.md`).
- **`.8bx` composition**: components elaborate to calls at compile time,
  `state` is a static instance's storage, `{#fact(...) ? <A /> : <B />}`
  drops the arm that cannot run. The 8BX spec already names
  `<RasterKernel><SpriteMultiplexer /><CopperBars /></RasterKernel>` as a
  legitimate composition.
- **The frame hook**: the backend `JSR`s a function named by
  `FRAME_SYNC.<machine>.frameHook` at the start of vertical blank (the
  NES's `nesVerticalBlank()`), the one seam where code runs at a frame
  edge on every machine that needs it.
- **The pre-rewrite design** (`docs/systems.md`, deleted at `d0cee5d`,
  still in git): `@8bitscript/sprites` — "a moving object is a concept on
  the PET even though a sprite is not, so `sprites` exists there, drawn by
  rewriting cells, and the number that comes with it says how many can
  share a row before the machine cannot keep up" — with `sprites.COUNT`,
  `PER_ROW`, `WIDTH`, `HEIGHT`, `COLORS`. This document takes that up.

## The one idea: a frame is a plan

Every machine here paints top to bottom, once a frame, and offers some
way — or no way — to change something while it does:

| Machine | The "at a line" mechanism | Objects are | Colour per line |
| --- | --- | --- | --- |
| C64 / C128 (VIC-II) | raster IRQ → a write list; an entry lands at the end of its line | 8 live register sets, reusable down the frame | `$D020`/`$D021` per line: free |
| MEGA65 (VIC-IV) | the same, plus a fine raster and a per-row rewrite buffer (RRB) | the 8, up to 64 px wide; RRB "pixies" unlimited | palette registers, any time |
| VIC-20 (VIC-I) | no raster IRQ; a VIA timer synchronised to `$9004` once | none — redefined characters | `$900F` per line: free (constant-length lines) |
| PET | a 50/60 Hz retrace IRQ; nothing inside the frame | none — PETSCII cells | none |
| Atari 8-bit | the display list *is* a per-line plan; a DLI at any mode line, `WSYNC` aligns to blanking | 4 players + 4 missiles as live per-line registers | 9 colour registers per DLI: the archetype |
| NES | no scanline IRQ in the chip: sprite-0 hit (one, polled) or a mapper's counter (MMC3 at dot 260) | 64 OAM entries, **per-frame data**, 8 per line chosen by the PPU | emphasis/greyscale bits only; palette is vblank-only |
| X16 (VERA) | a line IRQ; changes show 1–2 lines later | 128 sprites in a per-line cycle budget (~46 small ones) | palette in VRAM, any time |
| web | the renderer applies the list at paint time | none yet | free |

So the same intent — "eight objects and eight more below them" — is a
per-line register rewrite on the C64 and the Atari, an OAM ordering per
frame on the NES, a budget check on the X16, and a cell redraw on the
PET. The framework does not pretend otherwise. It says:

> **An intent is portable. Its mechanism is the machine's. Its cost and
> its limit are constants the program can fold on. And when a machine
> cannot answer, the degradation is written down and costs nothing.**

Three rules follow, all of which the existing raster list already obeys:

1. **Data, not code, at a line.** 8bitscript has no function values, and
   the mechanisms differ too much for "run this at line N" to mean one
   thing. A plan is a list (`raster`), a table (`sprites`' frame table),
   a set of keyframes (`timeline`). Machine packages ship the assembly
   that applies them.
2. **Built between frames, handed over whole.** A plan takes tens of
   lines to build; the handler must never read half of one. Double
   buffering with an atomic commit is the C64's answer; the X16's line
   IRQ, the Atari's display-list rewrite in the VBI, the NES's OAM DMA
   all want the same shape.
3. **The strictest machine sets the portable number.** One entry per two
   lines, 24 lines between reuses of a hardware object, 63 entries: the
   program follows the tightest machine it targets (`fancy` records why).

## The vocabulary

Each is a portable package resolving per machine (`"8bitscript".entry`
map), with a machine-only layer underneath that stays importable, and
its limits as namespace consts a program folds on. Names describe the
picture, not the trick. Every table below marks what **ships** against
what is only **designed**; the repo's bar is that nothing is described
as working until a test says so.

### `@8bitscript/raster` — lines *(exists; grows)*

What the picture does at a picture line. Adds `commit()` (a no-op where
the list is single-buffered or absent), `STRIDE` (bytes per entry, the
number `fancy` probes for today), and `insert()`. Later slots only where
three or more machines can honour them: `CHARSET` (C64 `$D018`, Atari
`CHBASE`, X16 tile base, MEGA65) and `SCROLL_Y`.

### `@8bitscript/sprites` — objects *(new; was `actors` until 2026-09-19 — the C64 twin is sprites, and the point is that the portable surface hands out more of them than the chip has)*

N visual objects with a position, a shape and a colour, moved by index,
and — because the two are one decision on every machine that has it —
whether they may leave the playfield:

```
sprites.begin(count)                 // how many this program uses, ≤ sprites.MAX
sprites.place(n, x, y)               // x, y: usmallint — stage pixels, below
sprites.setShape(n, shape)           // a shape the machine layer defined
sprites.setColor(n, color)
sprites.hide(n)
sprites.extend(on)                   // objects may draw above and below the playfield
sprites.update()                     // after waitFrame(): build and hand over the frame's plan
sprites.plan()                       // the same, inside a program's own raster.clear() … commit()
sprites.MAX, sprites.PER_LINE, sprites.WIDTH, sprites.HEIGHT, sprites.STEP_X, sprites.STEP_Y, sprites.RESTORES, sprites.EXTENDS
sprites.ORIGIN_X, sprites.ORIGIN_Y    // the playfield's top-left, in stage pixels
sprites.left(), right(), top(), bottom()   // where a sprite's top-left can be and still show — moves with extend()
```

**Coordinates are stage pixels, never negative.** The stage is the whole
area an object could ever occupy, and its origin is the top-left of
*that*, not of the playfield. On the C64 this is exactly the sprite
coordinate space every C64 programmer already knows (`ORIGIN_X` 24,
`ORIGIN_Y` 50, `y` fits a byte, `x` has its ninth bit); on a cell machine
the stage is the playfield (`ORIGIN_X` = `ORIGIN_Y` = 0) and a pixel
position is the cell at `x >> 3, y >> 3`. A program that means "the
playfield's top-left" writes `sprites.ORIGIN_X + x` and the constant
folds. This is what keeps every position unsigned: `smallint` positions
would put a signed compare in the multiplexer's sort and emit loops for
nothing. Without `extend`, a sprite placed outside the playfield is
simply hidden by the border — the same as the C64 sprite layer today.

**Two ways to own the frame's list, never both.** `sprites.update()` is
self-contained: it opens the raster list (`raster.clear()`), plans
(objects, and the border entries when `extend` is on), and commits. A
program that also wants entries of its own — a colour band, a split —
opens and commits the list itself and calls `sprites.plan()` inside the
bracket. The C64 package hit this "two owners" problem once
(`multiplex` vs. direct `$D000` writes) and answered it with the frame
table; the portable surface answers it once, here, in prose the twins
follow. On a cell machine `plan()` is the redraw and `update()` is the
same call; there is no list to bracket.

**Consts, not facts.** `sprites.MAX >= 20` on a namespace `const` folds
away completely — measured 2026-09-19: a program with a guarded 278-byte
branch builds to the same 411 bytes as one without it. `video.sprites`
already says pixel-vs-cell, `video.spritesPerLine` the per-line limit
where sprites exist. So no new facts, no compiler table row, no nine
catalog edits: the numbers are package consts and the optimizer does the
rest. Per machine:

| Machine | Mechanism | MAX / per line | Positioned by | Status |
| --- | --- | --- | --- | --- |
| C64 | `@8bitscript/c64/multiplex` (objects) + `@8bitscript/c64/border` (extend), one thin twin | 24 / 8 | pixel | **shipped** |
| PET | **quadrant objects**: a 4×4 pseudo-pixel shape as 2×2–3×3 of the sixteen block codes, at 4-px steps, restoring what it covered from `$8000` — the twin `index.pet.8bs`; ~2,600 cycles a sprite redrawn, five moving a 60 Hz frame | 8 / columns | 4 px | **shipped** |
| VIC-20, web | **cells**: a glyph redrawn at a cell over `@8bitscript/text`, portable, in the package itself | 16 / columns | cell | **shipped** |
| C128, MEGA65, Atari 8-bit, X16 | cells, until each machine's own layer exists (below) | 16 / columns | cell | **shipped as cells** |
| NES | cells — through the 48-byte vblank queue `text.putChar` uses (~12 cells a frame): sixteen movers tear there | 16 / columns | cell | **shipped as cells, over budget** |
| C128, MEGA65 | a layer of their own on the C64's model (`video.raster` is false on both today; MEGA65 sprites are 24 px, or 64 px mono, or 16 px in 16 colours, one shared height) | 24 / 8 | pixel | designed |
| Atari 8-bit | players re-targeted per band from DLIs (HPOSPx/COLPMx/SIZEPx are live); X in colour clocks, Y a strip index | 4 per band / 4 (+1 missiles) | 2 px | designed |
| NES | OAM built per frame, order rotated by a `const` permutation when a line is oversubscribed (flicker) | 64 entries: 16 of 16×16 / 8 | pixel | designed |
| X16 | VERA sprite attributes per frame, within the per-line cycle budget | 128 / 46 at 8 px, 4 bpp | pixel | designed |

The corrections in the rows above (the NES queue, the X16's two numbers,
the Atari's units, the MEGA65's sizes, the C128/MEGA65 layers being new)
came from the 2026-09-19 research recorded in [sprites.md](sprites.md),
which is the sprites package's own design note from here on.

The cell layer is the degradation every machine can fall to, and it is
written once, portably: it is not a stub. Its rules, stated because no
portable screen read exists so a cell sprite cannot restore what it
covered: a sprite is one cell (`WIDTH` = `HEIGHT` = `STEP_X` = `STEP_Y` = 8, `RESTORES` false);
`update()` erases each moved sprite's last cell with the background glyph
(`sprites.setBackground(code)`, space by default) and redraws every
sprite, so text under a sprite is lost and a program keeps its text off
the sprite rows or redraws it; colour goes through `text.putColor` where
`#fact(video.colorPerCell)` says it exists and is dropped where it does
not; `extend()` is a no-op, `EXTENDS` false, `top()`/`bottom()` the
playfield's. (Extents are functions, not consts: a namespace const
cannot hold an expression, and on the C64 they follow `extend()`.) A
program that reads `sprites.STEP_X` can move by the step that shows where it must, and one that reads `sprites.RESTORES` knows whether text survives under a sprite.

### `@8bitscript/timeline` — keyframes *(new, all machines, pure)*

A demoscene part is *deliberate*: at frame 120 the logo drops, at 300
the bars start. There are no function values and no array parameters
in the language, so the package cannot receive a program's cue table,
and copying a `const` table into package RAM at start-up is run-time
work the root `AGENTS.md` forbids. So the timeline is a frame counter
with predicates, and the cues are the program's own `if`s against
literals — which is what a demo's part table is anyway:

```
timeline.start()                    // frame 0 is now
timeline.frame()                    // frames since start, usmallint
timeline.at(f)                      // true on exactly that frame
timeline.after(f)                   // true from that frame on
timeline.between(a, b)              // true on a ≤ frame < b
timeline.every(n)                   // true once every n frames
```

Pure code, identical on nine machines. In `.8bx` the cue *is* the
conditional the language already has — `{timeline.at(120) && <Logo />}`
— not a wrapper component: a slotted component runs its children
unconditionally between its two halves, so `<At frame={120}>…</At>`
could not gate anything and is not offered. This is the thing that
makes a showcase a *sequence* rather than a loop.

**`stage`** is not a package. Extents live in `sprites` because their
only consumer is a sprite's position; the name is kept for `bands`
later, when a region of the picture has its own colour, scroll and
character set.

### Later, in this order

- **`@8bitscript/bands`** — vertical regions with their own colour,
  scroll and character set: a status bar that does not scroll. C64: a
  handful of raster entries (`$D018`, `$D016`, `$D011` at the band's
  line); Atari: display-list rows with `LMS` and a DLI; NES: sprite-0 or
  MMC3 → the `$2006/$2005/$2005/$2006` sequence in hblank; X16: a line
  IRQ or, for free, the second layer; MEGA65: `SCRNPTR`/`LINESTEP`.
  Degradation: the strip is text rows that the program does not scroll —
  no split needed on a machine with no scroll register.
- **`@8bitscript/palette`** — colour cycling and gradients: free where
  palette registers exist (X16, MEGA65, Atari's 9 registers per DLI),
  per-line `$D021` on the C64, vblank-only on the NES, none on the PET.
- **`@8bitscript/layers`** — parallax: X16's two layers; C64 charset
  switches per band; NES CHR banks per band; Atari `LMS` per row.

## The catalogue

Verdict key, per technique and machine — the field the framework
consumes:

- **L** — a *list* entry: an IRQ-at-line write of one register with one
  value; tolerates the 0–7 cycle interrupt jitter because the write lands
  in blanking or the border. What `@8bitscript/raster` carries.
- **H** — a small *handler* with a loose window (tens of cycles): a
  multiplexer's per-object burst, a 4-write NES scroll split.
- **C** — *cycle-exact*: a stable raster and counted code. Not offered
  by this framework on any machine; the machine package may document it.
- **—** — not available; the degradation applies.

### Intent × machine (the nine that build)

Status: rows marked ● ship today through a package (`raster` and, on the
C64, `multiplex`/`border`); everything else is the mechanism the machine
offers, verified against its documentation, not yet wrapped.

| Intent | C64 | VIC-20 | C128 | Atari 8-bit | NES | X16 | MEGA65 | PET | web |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ● Status bar / split | **L** `$D018`+`$D016`+`$D011` at the line (8-line steps; FLD for finer) | **L** VIA timer → `$9005` | **L** as C64 (VDC: frame only) | **L** display list `LMS` (+DLI for colour) | **H** sprite-0 (one) or MMC3 IRQ → 4 writes in hblank | **L** line IRQ → map base / scroll, armed 1–2 lines early | **L** raster IRQ → `SCRNPTR`; or RRB per row, no IRQ | — text rows | **L** list |
| ● Colour bands / raster bars | **L** `$D020`/`$D021` per line | **L** `$900F` per line | **L** as C64 | **L** DLI + `WSYNC` → `COLBK`/`COLPFx` | **—** (emphasis/greyscale bits **L**; palette needs forced blank) | **L** palette in VRAM | **L** palette registers | — | **L** |
| ● Per-line horizontal shift (wobble, parallax) | **L** `$D016` in the left border; pre-shifted charsets via `$D018` for wider | **H** `$9000` origin, 4-px steps, sync-sensitive | **L** as C64 | **L** DLI → `HSCROL` (after `WSYNC` + 2 NOPs) | **L** one `$2005` write per band (~4 px seam) | **L** `Lx_HSCROLL` per band | **L** as C64; RRB `GOTOX` per row | — | **L** |
| ● (C64, cells) More objects tha sprites | **H** multiplexer: Y/X/pointer/colour rewrites ≥21 lines apart | **H** cells (character redefinition) | **H** as C64 | **H** players re-positioned per DLI band | **H** OAM order rotated per frame (flicker); no per-line reuse | **H** attributes per frame within the cycle budget; reuse at a line IRQ lands 1–2 lines later | **H** as C64 at 40 MHz; RRB pixies | **H** cells | **H** cells |
| ● (C64) Objects outside the window | **L** RSEL clear in 248–250: top and bottom open; sides **C** | **L** no trick: enlarge the window (`$9000`–`$9003`) | **L** as C64 | **L** 240-line display list | — fixed 256×240 | **L** `DC_VSTART/VSTOP` | **L** border-position registers | — | — |
| Vertical stretch / line distance | **L** FLD: `$D011` every ~6 lines, YSCROLL ≠ line & 7 | — | **L** as C64 | **L** blank lines / `VSCROL` per DLI | — | — | **L** as C64 | — | — |
| Palette cycling | **H** colour RAM rewrite (a cell at a time) | **L** `$900E`/`$900F` | as C64 | **L** colour registers | **L** in vblank (≤160 bytes) | **L** any time | **L** any time | — | — |
| Frame timeline | pure code, every machine | | | | | | | | |

### The techniques, per machine, with their windows

**C64 (VIC-II).** The list handler's write lands 58–64 cycles into its
line — the right border — so "from line L" is an entry at L−1
(`packages/c64/AGENTS.md`). Free per line: 63 cycles, minus ~43 on a bad
line (one in eight), minus 2 per active sprite. Verified there: the
opened vertical border (RSEL clear in 248–250; both borders open, sides
stay), the idle byte (`$3FFF` of the bank = `$FFFF`, the IRQ vector's
page — moved to page zero so it is 0; `$F9FF` with ECM for a pattern),
sprite reuse (Y before cycle 55 of the line, 21 lines after the previous
use). From Bauer §3.14 and codebase64, *not* offered here: FLI (a
`$D011` write in cycles ≥14 of every line and `$D018` every line, ~20
cycles left), linecrunch (a bad line negated before cycle 14), VSP (a
bad line created in cycles 15–53: shifts the screen by the write's cycle
— and can corrupt DRAM on some boards: "Safe VSP", Åkesson), sprite
crunch (`$D017` in one exact cycle), side borders (CSEL in cycle 56 of
every line). Offered as **L**: FLD (`$D011` with `YSCROLL = (line+7)&7`,
every few lines), Y-stretch (`$D017` off/on inside a line, cycles
16–55: **H**), `$D018` charset per band, tech-tech (`$D016` per line in
the border). The one boxed rule for any `$D011` entry: never make
`YSCROLL == RASTER & 7` inside cycles 15–53 of a window line.

**VIC-20 (VIC-I).** No raster IRQ, no bad lines, constant 65/71-cycle
lines: a VIA timer synchronised once to `$9004` (latch = lines × cycles)
is a list engine thereafter (Mäkelä's `stable.txt`; Denial's NOP-slide
sync for jitter). Characters and colours are fetched every line, so
`$9005` (screen/charset), `$900E`/`$900F` take effect on the next line.
The window is registers (`$9000`–`$9003`: origin in 4-px/2-line steps,
columns, rows, 8×16 chars): "outside the window" is just a bigger
window (27×33 PAL, 24×28 NTSC). No sprites: cells, or a two-character
soft sprite.

**C128.** The VIC-IIe is the VIC-II; `$D030` bit 0 gives 2 MHz — usable
as two list entries, on at the lower border, off at the upper — and
everything cycle-exact must run at 1 MHz. The VDC (80 columns) has no
line hook at all: `R12/R13` and `R24/R25` are sampled at the end of the
display window, so it scrolls and recolours per *frame*; it has a
blitter (`R30` triggers copy/fill while the CPU runs on). Two monitors,
not a split.

**Atari 8-bit (ANTIC/GTIA).** The display list is the plan: `LMS` on any
mode line, blank lines, `JVB`, 240 lines max, `HSCROL`/`VSCROL` per
region. A DLI raises NMI at cycle 8 of the mode line's last scan line;
the handler runs from cycle ~28–44; `STA WSYNC` halts to cycle 105, and
17–26 cycles of hblank take 4–6 stores — "no simple options for the
programmer who needs to change more than three color registers in a
single DLI" (De Re Atari). `HSCROL`/`DMACTL` want cycle ≥ 96–111 (two
NOPs after `WSYNC`); `VSCROL` by cycle 0. Players and missiles are live
per-line registers — `HPOSPx`, `COLPMx`, `SIZEPx`, `GRAFPx` — so a band's
DLI re-targets them: multiplexing is the normal way to use them. Free
per line: 24 (first line of a text row) to 104 cycles. Mid-line colour
changes: cycle-exact, DMA-dependent; not offered.

**NES (PPU).** 113.7 CPU cycles a line, hblank ≈ 28 of them; vblank
≈ 2273 cycles less 513 for OAM DMA — ~160 bytes of nametable/palette
writes plus the OAM copy. Mid-frame-safe: `$2001` emphasis/greyscale
(immediate), `$2000` pattern-table bits, a `$2005` X write before dot
~252, the full `$2006/$2005/$2005/$2006` split with its last two writes
in hblank, mapper registers (CHR banks even mid-line). Not: `$2007`,
OAM, palette (except the forced-blank backdrop hack that also blanks the
line). Splits need a source: sprite-0 hit (one per frame, polled) or a
mapper IRQ (MMC3: A12-based, fires at dot 260, needs the pattern-table
layout to oscillate once a line; MMC5: a true line compare; VRC/FME-7:
cycle counters). Sprites: 64 in OAM, 8 per line chosen by the PPU,
lower index in front; OAM unwritable during rendering — reuse is
impossible, ordering per frame (rotate on oversubscribed lines) is the
technique. The mapper is a hardware axis the catalog will need before
`bands` can be real here.

**X16 (VERA).** A line IRQ (`IRQLINE`), changes visible 1–2 lines later
because VERA renders a line ahead. Per line: layer scroll, map/tile
base, border colour, scale, and the palette (VRAM `$1:FA00`). Sprites:
128, a per-line budget of 798 cycles (13–147 per sprite by size), so
"per line" is a count the package states for a size (46 at 8 px 4 bpp)
and the CPU's own VRAM traffic eats into it. Reuse at a line IRQ works
with the line offset.

**MEGA65 (VIC-IV).** Everything the C64 list does, plus a physical raster
compare (`$D079`), palette registers (`$D100`+), border and text-position
registers (`$D048`–`$D05E`: opening the border is a register), a screen
base anywhere in 28-bit RAM (`SCRNPTR`, `LINESTEP` — "VSP is unnecessary
on the MEGA65, because you can set the screen RAM address to any
location"), the RRB (`GOTOX` per row: parallax and soft sprites with no
IRQ), DMAgic, and a 40 MHz CPU. Cycle-exact VIC-II tricks are "highly
unlikely to work correctly" there — and unnecessary.

**PET (6545 CRTC or none).** The retrace IRQ and a pollable blank bit;
the CRTC's `R1/R6` (displayed columns/rows), `R12/R13` (start address —
a second screen page on a 4032; the 8296's CRTC sees `$8000–$9FFF`), all
per frame, "with extreme caution" (refresh depends on it). No per-line
mechanism, no colour, no character redefinition in the sources read.
Cells.

**web.** The renderer applies the raster list at paint time: idealized,
"proves semantics, never fit". Sprites are cells until the web target has
a sprite table.

## Degradation ladders

What the framework does when a machine cannot answer — written once so
every twin agrees:

| Intent | Full | Then | Then | Floor |
| --- | --- | --- | --- | --- |
| Objects | sprites, reused down the frame (C64, MEGA65, C128, Atari) | sprites per frame, order rotated (NES, X16) | cells over `text` (VIC-20, PET, web) | `sprites.MAX` = 0 never happens: cells run anywhere text does |
| Split / status bar | a list entry at the line | a display list row / a line IRQ | a mapper IRQ or sprite-0 | text rows the program does not scroll |
| Colour per line | a list entry | palette per frame | emphasis bits per band | one colour |
| Extents | border opened / window enlarged | display list overscan | — | sprites clip at the window; `sprites.extend()` is a no-op and `sprites.EXTENDS` false |
| Horizontal shift | per line | per band | per frame | none; the program shifts cells |
| Timeline | pure code | | | pure code |

## What the plan does not promise

- **Anything cycle-exact.** Side borders, FLI, linecrunch, VSP, sprite
  crunch, mid-line colour changes on any chip. A machine package may
  document them (the C64's does); the portable surface does not name
  them.
- **Identical numbers.** `sprites.MAX` is 24 on the C64 and 16 in cells;
  a program that needs 20 tests the const and the branch folds.
- **Sub-line timing.** An entry at line L shows from L+1 on the C64,
  from L+1 or L+2 on the X16, on line L's hblank on the Atari; the
  portable rule is "from the next line", and a program that needs the
  exact line writes the machine's own layer.

## Phase 5–8 machines: what each intent becomes

The eleven machines after the nine — Apple II, Plus/4 (C16, C116), BBC
Micro, Oric (Phase 5); Atari 5200, Lynx, PC Engine, Supervision (Phase
6); Atari 2600 (Phase 7); Game Boy, the Z80 family (Phase 8) — do not
build yet, and this framework must not paint them in. Each is placed
here against the same intents so that when its package arrives the
degradation is already written, and so the portable surface is not
shaped by an assumption one of them breaks. Sources are the machine
pages in `docs/project/machines/` plus the primary documents they cite;
where a page says *to verify*, so does this table.

Two tiers join the verdict key for these machines:

- **K** — *kernel*: the program *is* the per-line code (Atari 2600).
  The raster list is not a run-time table but the **input to a kernel
  generator**: each `(line, register, value)` becomes a store placed
  in the straight-line code for that scanline between `STA WSYNC`s,
  values that change per frame are RAM bytes the kernel loads, and a
  line whose mandatory stores plus list stores exceed 76 cycles is a
  compile-time diagnostic — the analogue of `raster.at` returning
  false. `raster.commit()` is meaningless there; the plan is fixed at
  build time and only its *values* change.
- **F** — *free*: the intent needs no timing at all because the chip
  carries it in data (Atari's display list, the Oric's per-line paper
  attribute, the Game Boy's Window, the SMS's row/column locks).

### Intent × machine (the eleven to come)

Z80 column: **Sp** Spectrum, **M1** MSX1, **M2** MSX2/2+, **SMS** Master
System/Game Gear, **CPC** Amstrad, **CV** ColecoVision. "→" is the
degradation.

| Intent | Apple II | Plus/4 | BBC Micro | Oric | Atari 5200 | Lynx | PC Engine | Supervision | Atari 2600 | Game Boy | Z80 family |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Split / status bar | → `$C053` mixed: four fixed text rows | **L** `$FF12/13/14`, `$FF06` at line | **H** vsync + T1 IRQ; CRTC rupture (8-line rows) | → hires + three fixed text rows | **F** display-list mode/`LMS` per mode line | → drawn; no split exists | **L** RCR IRQ (line+64) → BXR/BYR (lands +1) | → drawn rows | **K** kernel shape changes at line N | **F** Window WX/WY; or LYC IRQ → SCX/SCY | SMS **F** R#0 locks / line IRQ; M2 **L** R#19 + R#23; CPC **C** rupture; Sp/M1/CV → fixed rows |
| Colour bands | → none: no colour registers | **L** `$FF15–$FF19` | **H**/**C** `&FE21` timed from vsync + T1 | **F** paper attribute at line start | **L** DLI + `WSYNC` → COLBK/COLPFx | **L** HBL timer IRQ → palette `$FDA0` | **L** RCR IRQ → VCE `$000`/`$100` | → drawn grey bands | **K** `STA COLUBK` per line | **L** LYC/HBlank IRQ → BGP; CGB CRAM HBlank-only | SMS **L** line IRQ → CRAM (SMS2 drops writes) or R#7; M2 **L** palette; Sp/CPC **C**; M1/CV → backdrop only |
| Per-line horizontal shift | → redraw | **L** `$FF07` XSCROLL, CSEL kept | → per-row R12/R13 via rupture, coarse | → redraw (6-px bytes) | **L** HSCROL per mode line in a DLI | → Suzy tilt/stretch on the blit; or redraw | **L** RCR IRQ → BXR (latched per line) | → whole-frame window `$2002` | **K** PF0–2 / RESP + HMOVE per line | **L** LYC/HBlank IRQ → SCX (low 3 bits latch at line start) | SMS **L** R#8; M2+ **L** R#26/27; CPC → per-row coarse; Sp/M1/CV → none |
| More objects tha sprites | → cells (no sprites) | → cells (no sprites) | → cells / mode 7 sixels | → cells, attribute cost | **H** DLI rewrites HPOSPx per mode line; Y is a memmove | unlimited: Suzy blits, budget is pixels | 64 SATB, 16/line → tiles/flicker (SATB DMA is vblank-only) | → cells via DMA | **K** 2P + 2M + ball reused per line | **H** HBlank OAM rewrite, 10/line by Y → tiles | SMS **H** line IRQ SAT-Y rewrite (SAT re-parsed each line); M1/CV 4/line → flicker; Sp/CPC → cells |
| Objects outside the window | → cannot; IIgs `$C034` colour only | `$FF19` per line **L**; RSEL/CSEL open *to verify* | CRTC R1/R6 overscan costs RAM; no border colour | → fixed black border | **L** DMACTL wide (48 B); 240 lines | none: the LCD is the buffer | window registers; VCE `$100` border | none: 160×160 | **K** the line count is the program's | none: 160×144 | CPC **C** CRTC overscan + pen 16; SMS 224/240 + R#7; Sp colour only; M1/CV backdrop only |
| Palette cycling | → redraw | `$FF15–19` **F**; cells = 1K attribute rewrite | **F** `&FE21` remap any time | → rewrite ink/paper bytes | **L** 9 registers in the VBI | **F** 16 of 4096 | **F** VCE 512 entries | → 4 greys, redraw | **K** free per line | **F** BGP/OBP; CGB CRAM in VBlank | M2/SMS/GG/CPC **F**; Sp/M1/CV → attribute/backdrop rewrite |
| Frame timeline | IIe poll `$C019`; IIc VBL IRQ; II+ counted loop or mouse card | raster IRQ line 0 / poll `$FF1C/1D` | OSBYTE `&13` / CA1 IRQ | VIA T1 free-running; vsync hack opt-in | VBI NMI / VCOUNT | timer 2 VBL IRQ; rate program-set | VDC vblank IRQ | NMI 61 Hz, *not* the LCD's 50.8 Hz | the program strobes VSYNC/VBLANK; RIOT timers | VBlank IRQ `$40` | Sp/M1/M2 INT; CV NMI; SMS frame IRQ; CPC 300 Hz INT + VSYNC bit |

### What this does to the portable surface

- **`sprites` holds.** Six of the eleven have no sprites at all (Apple
  II, Plus/4, BBC, Oric, Supervision, Spectrum/CPC): the cell layer is
  their whole answer, and it is written once. The Lynx inverts the
  problem — no per-line limit, a per-frame *pixel* budget — so
  `sprites.MAX` is large and `PER_LINE` is not the constraint; the
  consts say so and a program folds on them. The 2600's five objects
  reused per line are a kernel matter and arrive with that package.
- **`raster` holds, with two amendments.** On the PC Engine, the Game
  Boy and the MSX2 an entry is a port *sequence* (index then data, or a
  write that must land in blanking) — the machine layer packs it, the
  portable `(line, slot, value)` shape does not change; the PC Engine's
  BYR-lands-at-+1 and the Game Boy's LYC-at-N−1 are the same "from the
  next line" rule already stated. On the 2600 the list becomes a
  compiler input; `commit()` is a no-op and `at()` past the cycle
  budget fails at build time.
- **`sprites.extend()` stays a flag.** Nothing among the eleven opens a
  border the way the VIC-II does; the closest are overscan modes that
  cost RAM (BBC, CPC) and a wider fetch (5200). `EXTENDS` is false on
  all eleven until a package proves otherwise.
- **`timeline` is untouched** — it is a counter — but three machines
  make "a frame" a decision, not a fact: the Lynx sets its own rate,
  the Supervision's NMI is unrelated to its LCD, the Oric cannot see
  vsync at all. `timeline.frame()` counts calls to `waitFrame()`,
  whatever that machine's `FRAME_SYNC` decided a frame is.

### Three corrections the sources forced

1. **SMS sprites can be multiplexed within a frame** — "on each
   scanline, the VDP parses the SAT" — so a line IRQ plus a SAT-Y
   rewrite is a mechanism, not a degradation. The Z80 page's flat "no
   reuse" is the one to amend when that package is written.
2. **The Atari 5200 page's `NMIEN = 0` fix silences DLIs too.**
   Per-line effects there need `NMIEN = $80` (DLI on, VBI off) and the
   BIOS RAM NMI vector, whose address the page marks *to verify*.
3. **The Lynx has a per-line hook.** Timer 0 is an HBL interrupt and the
   palette is rewritable per line: colour bands are **L** there, even
   with no raster compare — the handler counts lines itself.

The Amstrad CPC cells stand on secondary sources only, as
`z80-family.md` already warns; every CPC verdict inherits that flag.

## What shipped, and what it measured

All of the list below is in the tree as of 2026-09-19, every item
verified by a test under `node --test` — links on all nine, screenshots
under VICE on the C64, the PET and the VIC-20:

1. `@8bitscript/sprites` — `packages/sprites`: the portable cell layer
   (`src/index.8bs`) and the C64 twin (`src/index.c64.8bs`) over
   `multiplex` and `border`, the surface as written above with the
   extents as functions. Sixteen cell sprites cost about half a VIC-20
   frame a frame after three measured cuts (redraw only what changed,
   count sprites per row so the "another sprite in the cell I leave"
   scan runs only where it can matter, build a cell number from folded
   shifts). The probe shows 22 sprites on the C64, two in the opened
   border, whole to their last row.
2. `@8bitscript/timeline` — `packages/timeline`, pure, 12 tests, its
   predicates read back from a PET screenshot.
3. `@8bitscript/raster` grew `commit()`, `insert()` and `STRIDE` on all
   nine twins; `examples/fancy` dropped its stride probe;
   `portable-contract.test.mjs` records `insert`'s line width beside
   `at`'s.
4. `examples/swarm` — one `main`, nine targets, a `.8bx` scene that
   reads like a part list; sizes and timings in
   `packages/examples/README.md`. PET 2247 of 3071, VIC-20 2209 of 3583,
   C64 4870.
5. Two C64 handler findings, both fixed and documented in
   `packages/c64/AGENTS.md`: the frame table is now written at line 0
   (a sprite reused into the opened lower border drew its last rows with
   the next frame's X), and a border left closed must keep its `$D011`
   restore entry.

**The budget finding.** `multiplex.update()` costs ~16,000 cycles a
frame for sixteen sprites under the compiler's generic 6502 code —
~1,300 a reused sprite for forty-odd statements — against an NTSC
frame's 17,095, so the C64 runs the swarm at two hardware frames an
iteration. The handler is cheap; the plan-building is not. This is the
same class of finding as `text.print` (~4,000 cycles for nine
characters) and it decided the next step: the multiplexer's update in
native assembly with its tables at fixed addresses — rule 1 above,
taken to its conclusion — done the same day (`native/6502/multiplex.s`,
page $06; ~9,500 cycles for sixteen with the VIC's own steal inside,
and the swarm at one hardware frame an iteration on the C64,
[sprites.md](sprites.md) has the numbers). The cell layers' redraws are
the same lever, not yet pulled. Two compiler
bugs found on the way are in the report: a callee with a local inlined
inside an expression and then inlined again leaves its renamed local
unplaced (`'edge_2' resolves to nothing` — and again as
`'bottomEdge_2'` when a callee with a local was inlined into a function
that inlines another such callee; the sprites twins keep their extents'
scratch in a module variable for it), and the assembler's branch-range
refusal is handled by relaxation as designed. One hazard that is not a
bug but bit three probes in a day: a product of two literals, `22 * 40`,
folds at eight bits like any other binop at its operands' width, so
`text.print(22 * 40, ...)` prints at cell 112 — nothing in the language
docs warns that a literal product wraps; write the cell number.

## What was planned to ship first, and how it shows

Tightest constraint outward — the cell layer and the two small budgets
are where the surprises live; the C64 code is already verified:

1. `@8bitscript/sprites`, cells first: the portable layer over
   `@8bitscript/text`, built and sized on the unexpanded VIC-20 (3583)
   and the stock PET (3071) before anything else, because
   `examples.test.mjs` links every example on all nine and pins those
   two numbers.
2. The C64 twin: a thin wrapper over `multiplex` and `border`, with
   `update()`/`plan()` and `extend()` as written above.
3. `@8bitscript/timeline` — pure.
4. `@8bitscript/raster` grows `commit()`, `STRIDE` and `insert()` on
   all nine twins (and `fancy` stops probing the stride);
   `portable-contract.test.mjs` is what says the twins still agree.
5. `examples/swarm` — twenty sprites bouncing, off the top and bottom
   on a C64, in cells on a PET — one `main.8bs`, nine targets, sizes
   measured and written down, screenshots on the C64, the PET and the
   VIC-20 (all VICE, one `--screenshot` path). Then a `.8bx`
   composition of the same, cued by `timeline`. The examples manifest
   test pins the example names; `swarm` joins the list.
6. Wiring nobody sees but everything needs: `packages/sprites` and
   `packages/timeline` manifests (entry maps; relative paths for the
   portable layers, `workspace:*` deps), the examples package's
   dependencies, `pnpm install` for the symlinks, a changeset.
