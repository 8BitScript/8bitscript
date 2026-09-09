# Writing NES support for 8BitScript

This file is for anyone — human or agent — touching `packages/nes`,
`packages/compiler/src/mos`'s `nes` entries, `docs/setup/nes.md`, or the NES rows
of `docs/roadmap.md`. Read the root [`AGENTS.md`](../../AGENTS.md) first; the
rules there ("abstract concepts, expose constraints") apply to every target
and are not repeated here.

## What exists today

Do not describe more than this as working:

- `packages/nes/src/index.8bs` exports the PPU port protocol —
  `setVramAddress()` and `resetScroll()` — that the package's two portable
  surfaces are built on: `src/screen.8bs` (behind `@8bitscript/screen`, as
  `@8bitscript/nes/screen`) and `src/text.8bs` (behind `@8bitscript/text`).
  `screen.setColors(border, background)`'s background writes PPU palette
  RAM `$3F00`, the universal backdrop. Its border is real but *drawn*: the
  NES has no border register (the picture fills the frame edge to edge), so
  the first `setColors()` lays a two-tile-thick ring of a solid tile around
  the nametable and `border` is that tile's colour (`$3F02`).
  `text.putChar(cell, code)` writes an ASCII code into the 28×26 grid
  inside that frame — into the package's write queue, which `waitFrame()`
  delivers through PPUADDR/PPUDATA at the start of vertical blank and then
  resets the scroll (`nesVerticalBlank()` in `index.8bs`, called by the
  backend's frame runtime via `FRAME_SYNC.nes.frameHook`); a program
  prints whenever it likes and never sees the blank's budget. The queue
  holds 112 bytes; delivery costs 15 cycles a byte, plus a header per run
  that the byte cost alone does not price in. That distinction is worth
  keeping straight: a HUD of a few wide rows is nearly all data bytes, but
  a grid of many narrow fields (`packages/2048`'s 4-character tile cells,
  three `text.print()` runs per tile) pays a run header on almost every
  write. QUEUE_SIZE was 128 — "about four 28-column rows," a number sized
  against the wide-row case, empties in about 2000 of the blank's 2273
  cycles — until 2048's 16-tile board (~19 runs to fill one queue) proved
  by measurement that a full 128-byte queue of small runs delivers a few
  cycles past the blank, corrupting whichever tile was mid-flight when
  rendering resumed under it (FCEUX, `8bs run nes --screenshot`,
  2026-09-07: 128 corrupted two tiles; 120 and under, light or full board,
  did not; 124 did again). 112 was fixed as comfortably under that
  observed failure band rather than at its edge, since neither this
  project's cycle estimates nor FCEUX's timing are trusted to the single
  cycle this boundary lives at. A future program with smaller or more
  numerous runs than 2048's could still find a new floor — measure with
  `--screenshot` before assuming 112 holds for it. When the queue fills
  before the frame is over the package waits for the next blank,
  delivers, and carries on — a bigger HUD costs frames, never the
  picture. Delivering mid-frame would corrupt it: PPUADDR is the PPU's
  own fetch position while it draws.
  `locate()` finds a cell's row in eight-bit shifts and two corrections
  (`q = cell / 4`, `q / 8 + q / 64`, then take off sevens) because a
  16-bit divide was a 248-byte routine under the pre-0.2.0 toolchain,
  a counted-subtraction loop became one, and `x * 147` called a 300-cycle
  `__mulhi3` — the
  vertical blank is about 2270 cycles, and a HUD that overruns it writes
  into whatever the PPU is fetching; `print`/`printNumber` locate once and
  let PPUDATA's auto-increment carry the run, locating again only at a row
  wrap; each run goes into the queue, and delivery is the cheap part.
  `putColor` is a documented no-op (attribute-table granularity); text is
  white (`$3F01 = $30`).
- `packages/nes/native/6502/font.s` is the CHR-ROM character set — the NES
  has no character ROM, so the package ships one, laid out so tile index ==
  ASCII (space, digits, A-Z, `! , - . : ?`; tile `$80` is the solid frame
  tile). It reaches the `.nes` image through the package's
  `"8bitscript".native` list — the resolver/linker/backend plumbing in
  `docs/packages.md`. The native backend does not yet place that CHR in
  a `.nes` image. Reverse
  video of the portable set is the same tiles at ASCII+128 ($A0-$DF);
  tile $80 stays the solid frame.
- The NES catalog's `mapper` value is `nrom` (`build.startup: nrom`) —
  NROM, the plainest cartridge shape: 32K PRG-ROM, 8K CHR-ROM, no bank
  switching. Other mapper startups (`unrom`/`mmc1`/`mmc3`/`cnrom`/`gtrom`/
  `action53`/`unrom-512`) are not wired up. The native backend refuses to
  build.
- Timing is NTSC-only (`FRAME_SYNC.nes` in `packages/compiler/src/mos`); PAL NES
  is not supported. FCEUX's default NTSC view hides the top and bottom 8
  lines (rows 0 and 29), which is why the frame is two tiles thick.
  The colour-cycling demo that first ran here put its readout at row 2,
  column 2 — the first cell
  inside the frame, matching the cell-0 position every other target uses.
- `docs/setup/nes.md` covers installing and running FCEUX, the emulator
  `8bs run nes` targets.

There is no tile/pattern *asset pipeline* (the font is hand-laid assembly,
not converted art), no sprite API, no scrolling API, no mapper selection, no
persistence, and no PRNG library yet — for any machine, not just this one.
If you're implementing one of these, the rules below are what to hold it
to; if you're just writing docs or comments, don't imply it already exists.

Two PPU rules `index.8bs` documents, `screen.8bs`/`text.8bs` already
honour, and any extension must keep: VRAM is free to write only while
rendering is off (before the first `screen.setColors()`) or during
vertical blank (right after `waitFrame()`
returns, which on the NES is vblank start) — never from setup code that
runs after rendering is on, and never late in a frame's work; and every
PPUADDR/PPUDATA sequence must end with a scroll reset
(`$2000 = 0`, `$2005 = 0` twice), or the next frame draws from wherever the
address register was left.

**The catalog's stock fact sheet** (`"8bitscript".hardware.facts` in
`package.json`, what `Video.*` and the rest of `@8bitscript/system` fold
to): grid 28×26 of 8×8 (the nametable's 32×30 less the inset `text`
draws inside), 25 colours at once (four background and four sprite
palettes of three, plus the backdrop), 3 per cell (a 16×16 attribute
block's palette), no redefinable glyphs on NROM's CHR-ROM, no block
glyphs, no bitmap, one layer (two nametables) with fine scroll; 64
sprites, **8 per line**, 8×16, 3 colours; APU: two pulses, triangle,
noise and DMC = 5 voices, hardware envelopes, samples on the DMC, a
volume per pulse and noise, no filter or random source; no keyboard, two
pad ports; nothing to save to on NROM (the `mapper` value's fact); 1536
bytes of RAM for the program (`$0200`–`$07FF`, beside
the zero page), nothing banked. Sources: `src/text.8bs`, the PPU and APU
tables below (read). The native backend refuses to build.

## How the NES actually works (verify before you cite it)

The PPU is not a framebuffer device. It assembles the picture every frame
from a handful of small structured pieces, and the size of each piece is a
hardware fact worth having memorized before writing NES-facing API or docs:

| Piece | Fact |
| ----- | ---- |
| Display | 256×240 pixels. NTSC TVs typically overscan the top/bottom ~8 rows each, so treat ~224 rows as the safe vertical area. |
| Background tile | 8×8 pixels, 2 bits/pixel, 16 bytes of pattern data (8 bytes per bitplane). |
| Nametable | 32×30 = 960 tile-index entries — one screen's worth of background. |
| Attribute table | 64 bytes per nametable, each byte covering a 4×4-tile (32×32px) block and choosing 1 of 4 background palettes for it. This is the "attribute clash" constraint: palette choice is much coarser than per-tile. |
| Pattern space | Two 4K pattern tables (8K total addressable by the PPU at once) of 256 tiles each — background and sprites can each use either table. What's actually *in* pattern space (ROM, fixed, bank-switched, RAM) depends on the mapper, not on the PPU. |
| Sprites (OAM) | 64 entries, 4 bytes each (Y, tile index, attributes, X) — the familiar "4 bytes per sprite" figure. |
| **Sprite-per-scanline limit** | Only **8** of those 64 entries can be drawn on any single scanline. This is the constraint that actually breaks games, not the 64 total — four hardware sprites forming one large metasprite already spend half a scanline's budget. |
| Palette RAM | 32 bytes at PPU address `$3F00`–`$3F1F`, reached indirectly through `PPUADDR`/`PPUDATA` (`$2006`/`$2007`) the way `screen.setColors()` already does — the CPU cannot address it directly. |

Facts to actively correct if you see them stated otherwise:

- **"6502 only adds, subtracts, and shifts."** It also loads/stores,
  compares, increments/decrements, rotates, branches, and does stack and
  logical (`AND`/`ORA`/`EOR`) operations. The real constraint worth writing
  down is narrower: **no hardware multiply or divide**, so those deserve
  special treatment (shifts, lookup tables, strength reduction) in
  frame-critical code — and check the generated code before
  hand-optimizing, when a backend exists to emit it.
- **"8.8 fixed point gives 1/16-pixel motion."** Ordinary unsigned 8.8 has
  8 fractional bits, i.e. **1/256** resolution. 1/16-pixel steps are what you
  get if you *choose* to only use multiples of 16 in the fractional byte —
  that's a design choice, not what 8.8 means. Also note: an 8.8 value only
  covers 0–255 in its integer part, which is not enough for a scrolling
  world's absolute position — a wider integer part (16.8, say) is usually
  what's wanted for world coordinates, with 8.8 reserved for
  velocity/subpixel deltas.
- **"NES cartridges are read-only, so persistence = password screens."**
  Program ROM being read-only doesn't mean every NES cartridge is. Battery-
  backed SRAM (MMC1/MMC3 boards) and the Famicom Disk System both existed.
  Persistence is a capability a mapper/media profile either has or doesn't —
  don't bake "the NES can't save" into the language or its docs.
- **"NES graphics live in two fixed 8K blobs forever."** The pattern-address
  space the PPU sees is fixed; what's mapped into it is a cartridge/mapper
  question (fixed CHR-ROM on NROM, bank-switched CHR-ROM or writable CHR-RAM
  on others).

## Rules for this target

- **Cartridge/mapper is a hardware *option*, not a language concept, and
  not something `nes` alone determines.** This project already has the
  shape for that: every machine package's `"8bitscript".hardware` catalog
  (`packages/cli/src/hardware.mjs` resolves it; `8bs targets` lists it).
  The NES's catalog has one option, `mapper`, with one value, `nrom`,
  carrying `build.startup: nrom` and `storage.save: false`.
  Adding a mapper is adding a value there — its startup shape
  (`mmc1` and the rest), whether the font's `.chr_rom`
  section still lands (unverified for any but NROM), its battery-SRAM
  fact — not a table in the backend.
- **Budget sprites per scanline, not just per frame.** Any future sprite/
  metasprite API or asset tooling must be able to answer "how many hardware
  sprites does this scene need on its worst scanline," not only "how many
  hardware sprites does this scene use in total." A metasprite compiler
  should report both, the way the roadmap's capability system is meant to
  surface hardware limits at build time rather than as an emulator surprise.
- **Rendering should stay command/state-oriented, never
  `screen.setPixel(x, y, color)`-shaped.** The useful high-level operations
  look like `background.setTile(x, y, tile)`, `sprites.place(id, x, y,
  frame)`, `scroll.set(x, y)` — game logic updates a shadow representation,
  and a frame-time commit step transfers changes to the PPU at a safe point
  (vblank). Raw PPU access (as `screen.setColors()` already does) stays available
  underneath for anyone who wants it; the portable layer should never be the
  *only* way in.
- **The PPU warm-up is two vblanks after reset** (NESdev). A working NROM
  start-up does that before `main()` (`__early_init` and `__late_init`,
  confirmed by disassembly pre-0.2.0; see `index.8bs`'s header). The native
  backend does not emit that start-up yet. Don't add a second wait in the
  package, and don't describe the warm-up as already handled by a backend.
- **Don't turn an NES number into a generic "8-bit" rule.** "8 sprites"
  means something completely different on NES (8 *of 64* selectable per
  scanline) than on C64 (8 hardware movable-object blocks, full stop — see
  `packages/c64/src/index.8bs` when it grows sprite support). A shared
  capability API (`8bit:sprites`, per `docs/roadmap.md`) must describe
  *intent* ("place this visual object here"), never promise identical
  underlying hardware.
- **Verify hardware facts before writing them into comments or docs — don't
  transcribe them from memory.** This is already this codebase's norm:
  `packages/atari8/src/index.8bs`'s COLBK/COLPF2 comment says outright that
  it was "verified on screen under atari800, not inferred," because an
  earlier version had it backwards. NESdev's own wiki (nesdev.org) is the
  right primary source for anything not already covered above; a lecture
  slide or blog post is not.
- **Don't promote single-game trivia (a specific game's exact collision
  algorithm, PRNG, or ROM byte counts) into an engineering rule or a
  compiler diagnostic.** These make good motivating anecdotes in prose, not
  facts the compiler or the standard library should encode — they describe
  one game's implementation, not a hardware constraint every NES program
  shares.

## Seeing the screen without a human at FCEUX

`8bs run nes --screenshot <file.png>` builds and captures a PNG through a
small FCEUX Lua script (`emu.frameadvance()` in a loop, then
`gui.savescreenshotas()`) instead of opening an interactive window — see
[`docs/setup/verify.md`](../../docs/setup/verify.md#screenshots) for
`--frames` (it means exact emulated frames here, not wall-clock time) and
the other eight targets' own mechanisms.

## Where things live

```
packages/nes/src/index.8bs           target package: the PPU port protocol (setVramAddress, resetScroll)
packages/nes/src/screen.8bs          @8bitscript/nes/screen: screen.blank()/setBorder()/setBackground()/setColors(), the drawn frame, colour names
packages/nes/src/text.8bs            @8bitscript/nes/text: text.print/printNumber/setColor/setReverse/putChar/putColor, CELL_COUNT 728, COLUMNS 28, TextColor (inert)
packages/nes/native/6502/font.s      the CHR-ROM character set (tile index == ASCII; reverse at ASCII+128)
packages/nes/package.json            "8bitscript".exports names the two subpaths; .native lists the font
packages/compiler/src/mos/index.ts   FRAME_SYNC.nes (NTSC frame timing; the backend refuses to build)
packages/compiler/src/resolver/      "8bitscript".native → absolute paths (8BS2008 if missing)
packages/compiler/test/nes-screen.test.mjs   the package and the native plumbing, end to end
docs/setup/nes.md                    install/run FCEUX, 8bs run nes, what the picture shows
docs/roadmap.md                      Phase 3: why NES is here, the capability-system rationale
```
