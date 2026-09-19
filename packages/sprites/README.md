# @8bitscript/sprites

Moving objects for 8BitScript programs, on every target — VIC-20, C64,
PET, C128, Atari 8-bit, NES, Commander X16, MEGA65, and web. A sprite is
a position, a shape and a colour, moved by index and drawn once a frame;
what one *is* depends on the machine, and the program does not have to
know:

- **C64** — a hardware sprite, reused down the frame by
  `@8bitscript/c64/multiplex` (its update native assembly, ~9,500 cycles
  a frame for sixteen) so that up to twenty-four can show, and through
  the top and bottom border when the program opens it
  (`@8bitscript/c64/border`). The twin `src/index.c64.8bs`.
- **PET** — a quadrant-block object: a 4 × 4 pseudo-pixel shape drawn
  as two to three cells each way of the ROM's sixteen 2 × 2 block
  characters, moving in 4-pixel steps, merging with block graphics and
  restoring what it covered — text included — from the screen at
  `$8000`. Eight of them; the twin `src/index.pet.8bs`.
- **the other seven** — a glyph redrawn at a cell over `@8bitscript/text`:
  the portable cell layer, `src/index.8bs`, written once.

```bash
pnpm add @8bitscript/sprites
```

```
import { sprites } from "@8bitscript/sprites";

sprites.begin(12);                                  // this program moves twelve, ≤ sprites.MAX
sprites.setShape(0, shape);                          // a sprite block on the C64, an ASCII code elsewhere
sprites.place(0, sprites.ORIGIN_X + 40, sprites.ORIGIN_Y + 80);
// each frame, after waitFrame():
sprites.update();
```

| Call | What it does |
| --- | --- |
| `begin(count)` | How many sprites this program moves; every sprite starts hidden |
| `place(n, x, y)` | Sprite `n` at stage pixel (`x` and `y` both usmallint) — see below |
| `setShape(n, shape)` | The shape the machine layer understands: a sprite block on the C64, a `defineShape` index on the PET, an ASCII code in cells |
| `setColor(n, color)` | Its colour, where the machine has one per cell or sprite |
| `hide(n)` | Not drawn until placed again |
| `extend(on)` | Objects may draw above and below the playfield — the C64's border opens; a no-op elsewhere |
| `update()` | The frame's plan, built and handed over whole; returns how many sprites draw |
| `plan()` | The same, inside a program's own `raster.clear()` … `raster.commit()` bracket |
| `dropped()` | Sprites the last `update()` could not show |
| `setBackground(code)` | What a cell sprite leaves behind (a space by default); nothing on the C64 |
| `left()` `right()` `top()` `bottom()` | Where a sprite's top-left can be and still show — moves with `extend()` on the C64 |

And consts a program folds on: `MAX` (24 on the C64, 8 on the PET, 16
in cells), `PER_LINE`, `WIDTH`, `HEIGHT`, `STEP_X`/`STEP_Y` (the
smallest move that shows: 1, 4 and 8), `RESTORES` (whether what a
sprite covers survives it: true on the C64 and the PET), `EXTENDS`,
`ORIGIN_X`, `ORIGIN_Y`. `if (sprites.MAX >= 20)` costs nothing when it
is false. The two limits are different kinds of number — `MAX` is what
the layer holds, `PER_LINE` what one scanline shows of this layer's
object size — and neither is a frame budget: each twin's header says
what its update costs, measured.

## Coordinates are stage pixels, never negative

The stage is the whole area an object could ever occupy, and its origin
is the top-left of *that*. On the C64 it is the sprite coordinate space
(`ORIGIN_X` 24, `ORIGIN_Y` 50 is the playfield's top-left); on a cell
machine the stage is the playfield (`ORIGIN_X` = `ORIGIN_Y` = 0) and a
position is the cell at `x >> 3, y >> 3` (on the PET the pseudo-pixel at
`x >> 2, y >> 2`). Both are sixteen bits: a byte `y` was the C64
register's width, not the grid's. A program that means "the playfield's
top-left" adds the origin, and the constant folds. Without `extend()`, a
sprite outside the playfield is simply hidden by the border.

## One owner of the frame's list

`update()` is self-contained: on the C64 it opens the raster list, plans
(the sprites, and the border entries when `extend` is on) and commits —
installing the handler on its first call. A program that also wants
entries of its own opens and commits the list itself and calls `plan()`
inside that bracket, and calls `raster.enable()` once itself. Never both.
On a cell machine the two are the same call.

## The PET's quadrant objects

`defineShape(shape, row0, row1, row2, row3)` — the PET twin's own call,
kept in a program's `shapes.pet.8bs` twin — takes four nibbles (bit 3 the
left pixel; `6, 9, 9, 6` is a ring) and works out the cell patterns the
shape makes at its four parities once, so the frame's loop reads a
pattern, merges it with the block code under it, and writes one code.
Seven shapes; shape 0 is a solid block unless defined. `setColor` does
nothing (no colour), `setBackground` nothing (the screen is restored).
Cost, measured on a 3032 under xpet: ~2,600 cycles a sprite erased and
redrawn, so five moving sprites fit a 60 Hz frame with room for the
program, eight all moving take two; a sprite that neither moved nor
touches one that did costs a few compares. The stock 2001's 4K holds the
probe (2662 bytes) but not the swarm example, whose PET is the 3032.

## The cell layer's rules

There is no portable screen read, so a cell sprite cannot restore what it
covered: `update()` erases a moved or hidden sprite's previous cell with
the background glyph and redraws the sprites that changed; when a mover
leaves a cell another sprite still stands in, that cell is kept and the
other sprite is redrawn. Text under a sprite is lost. Colour goes through
`text.putColor` where `Video.COLOR_PER_CELL` says the machine has it.
Sixteen sprites cost about half a VIC-20 frame a frame, measured. On the
NES the cells go through `text.putChar`'s 48-byte vblank queue — about
twelve cells a frame — so sixteen movers overflow it and tear there; the
NES's own layer (OAM built per frame) is designed, not built. The design
and its budgets are in [docs/project/frame.md](../../docs/project/frame.md)
and [docs/project/sprites.md](../../docs/project/sprites.md), the
working example in [`examples/swarm`](../examples/swarm).
