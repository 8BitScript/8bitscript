# Writing NES support for 8BitScript

This file is for anyone — human or agent — touching `packages/nes`,
`packages/backend-6502`'s `nes` entries, `docs/setup/nes.md`, or the NES rows
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
  inside that frame through PPUADDR/PPUDATA and resets the scroll;
  `putColor` is a documented no-op (attribute-table granularity); text is
  white (`$3F01 = $30`).
- `packages/nes/native/6502/font.s` is the CHR-ROM character set — the NES
  has no character ROM, so the package ships one, laid out so tile index ==
  ASCII (space, digits, A-Z, `! , - . : ?`; tile `$80` is the solid frame
  tile). It reaches the `.nes` image through the package's
  `"8bitscript".native` list — the resolver/linker/backend plumbing in
  `docs/packages.md` — into the SDK's `.chr_rom` linker section.
- `packages/backend-6502` hardcodes the NES driver to `mos-nes-nrom-clang` —
  NROM, the plainest cartridge shape: 32K PRG-ROM, 8K CHR-ROM, no bank
  switching. LLVM-MOS also ships `unrom`/`mmc1`/`mmc3`/`cnrom`/`gtrom`/
  `action53`/`unrom-512` drivers; none of them are wired up.
- Timing is NTSC-only (`FRAME_SYNC.nes` in `packages/backend-6502`); PAL NES
  is not supported. FCEUX's default NTSC view hides the top and bottom 8
  lines (rows 0 and 29), which is why the frame is two tiles thick.
  `examples/borders` puts its readout at row 2, column 2 — the first cell
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
  frame-critical code — and check the generated C/assembly before
  hand-optimizing, since LLVM-MOS already does loop and zero-page
  optimization.
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

- **Cartridge/mapper is a target *profile*, not a language concept, and not
  something `nes` alone determines.** This project already has the right
  shape for that: `ATARI8_PROFILES`, `VIC20_PROFILES`, and `C64_PROFILES` in
  `packages/backend-6502/src/index.mjs` each let one machine resolve to
  several build configurations via `--profile`. NES doesn't have this yet —
  `DRIVER.nes` is a single hardcoded string. Adding mapper selection means
  following that existing pattern (an `NES_PROFILES` set, a default of
  `'nrom'`, a `driverFor()` branch), not inventing a new mechanism.
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
- **The PPU warm-up is already handled — don't add a second one.** NESdev's
  guidance is to wait two vblanks after reset before touching the PPU. The
  SDK's NROM start-up does exactly that before `main()` (`__early_init` and
  `__late_init` in `mos-platform/nes-nrom/lib/crt0.o`, confirmed by
  disassembly, see `index.8bs`'s header). An earlier revision of this file
  and of `index.8bs` called it a gap; it never was. If you're tempted to
  add a wait to the frame driver, disassemble the crt0 first.
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
packages/nes/src/screen.8bs          @8bitscript/nes/screen: screen.setColors(), the drawn frame, colour names
packages/nes/src/text.8bs            @8bitscript/nes/text: text.putChar/putColor/showDigit, CellCount 728
packages/nes/native/6502/font.s      the CHR-ROM character set (tile index == ASCII)
packages/nes/package.json            "8bitscript".exports names the two subpaths; .native lists the font
packages/backend-6502/src/index.mjs  driver selection (DRIVER.nes), NTSC frame timing, nativeSources
packages/compiler/src/resolver/      "8bitscript".native → absolute paths (8BS2008 if missing)
packages/compiler/test/nes-screen.test.mjs   the package and the native plumbing, end to end
examples/borders/src/main.8bs        the working program (every target): readout, draw-then-setColors ordering
docs/setup/nes.md                    install/run FCEUX, 8bs run nes, what the picture shows
docs/roadmap.md                      Phase 3: why NES is here, the capability-system rationale
```
