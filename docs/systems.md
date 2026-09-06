---
title: Systems
nav_order: 2
---

# Systems: one program, many machines

This page is the design for how 8BitScript tells its target machines apart,
and how a program is written once and still uses what each machine has. It
is a plan in the same sense [the roadmap](roadmap.md) is: it says what
exists, marks the rest as proposal, and gives the rules the rest has to
follow. For what compiles today, [the compiler](compiler.md) is the source
of truth.

The whole page follows from one rule, the root `AGENTS.md`'s:

> 8BitScript should abstract concepts, but expose constraints. It should
> never abstract away a hardware limit that determines whether a program
> actually works.

So a program can ask three different things about the machine it is
being built for, and the three are kept apart. In plain words: *which
machine is it*, *what are its numbers*, and *what can it do*.

| Kind | What it answers | Spelled as | Status |
| ---- | --------------- | ---------- | ------ |
| **Identity** | Which machine is this build for? | `#system() == System.C64` | exists: `#system()` in the compiler, the names in `@8bitscript/system` |
| **Facts** | How wide is the screen? How many sprites per line? Is there a mouse? | `text.COLUMNS`, `Video.SPRITES_PER_LINE`, `Input.MOUSE` | `text.COLUMNS` and `CELL_COUNT` exist; the rest is proposal |
| **Behaviour** | Draw a tile here. Play this note. Read the joystick. | `tiles.set(x, y, t)`, `sound.play(...)`, `input.left()` | `screen` and `text` exist; the rest is proposal |

A program asks *which machine* rarely, reads a *number* when it decides a
layout, and calls a *capability* for everything else. The order of
preference is the reverse of the table: a number beats a name, because
`text.COLUMNS` is still right on a machine the name has never heard of,
where "if C64 then 40 columns" is wrong on a C128 in 80-column mode.

## What exists today

- **Nine targets**, named the way `8bs build --target` accepts them:
  `vic20`, `c64`, `pet`, `c128`, `atari8`, `nes`, `cx16`, `mega65`, `web`.
- **Profiles** on four of them (`--profile`): RAM expansions on the
  VIC-20, models on the PET, REU sizes on the C64, output formats on the
  Atari. A profile is a *build*: the linker script, the load address, the
  screen's location, and which per-profile file a package reads
  (`geometry.pet.8032.8bs`) all follow from it. The NES has no profiles
  yet and is hard-wired to NROM; the X16, MEGA65, C128 and web have none.
- **Identity**: `#system()` is a compile-time builtin, like `#frames()`:
  the compiler replaces it with the number of the machine being built
  for. `@8bitscript/system` exports one `System` namespace naming those
  numbers, so `if (#system() == System.NES)` compares two constants and
  the other machines' branches fold away. Studio's `main.8bs` uses it to
  pick its tier with an ordinary `if` chain — one entry file where there
  used to be four. With no machine in hand (`8bs check`, the editor) the
  call is valid and target-dependent, like a `.<machine>.8bs` import.
- **Two capabilities**: `@8bitscript/screen` (border and background) and
  `@8bitscript/text` (a character grid, ASCII in, with `COLUMNS` and
  `CELL_COUNT` as the first facts). Each is a machine-keyed manifest
  delegating to the target package's own implementation.
- **Per-machine files** (`player.nes.8bs` beside `player.8bs`) for code
  that is genuinely different per machine, and per-profile files for a
  difference a profile makes.
- **Hardware layers** under some machines: `@8bitscript/c64/sprites`,
  `/sid`, `/keyboard`, `/joystick`, `/video`; `@8bitscript/pet/keyboard`.
  Importing one makes a program that machine's only.

Everything below the next heading that is not in this list is a proposal.

## Three axes, not one

Every question about "the hardware" is one of three, and they are answered
in three different places:

```
machine   --target c64        the chips: what the program can be written against
profile   --profile reu512    the build: RAM, media, banking, columns, mapper
region    --pal               the run: 50 or 60 Hz, which model the emulator boots
```

- The **machine** decides which packages exist and what their facts are.
- The **profile** decides the numbers that change with the hardware fitted:
  a PET is 40 or 80 columns wide, a VIC-20 has 5K or 29K, an NES cartridge
  does or does not have CHR-RAM and battery SRAM. Profiles are named the
  way that machine's community names them (`8032`, `130xe`, `mmc1`), never
  by a generic "small/medium/large".
- The **region** decides nothing about the build. `waitFrame()` runs at the
  project's logical `frameRate` on either; `--pal` only chooses which real
  machine the emulator pretends to be. A model difference that a build
  cannot select (a 6581 against an 8580 SID) is a region-like run choice,
  not a profile — see `packages/c64/AGENTS.md`, "Models are not profiles".

A fourth thing that looks like an axis is not one: **an optional
peripheral** (a mouse, a second joystick, an expansion card) is a fact a
program reads and a capability it imports, never a build. Whether a mouse
is *present* is a runtime question the input capability answers; whether
the machine *can have* one is a fact.

## Facts: what a build knows about itself

Proposal. `@8bitscript/system` grows from one namespace to a fact sheet:
each target package ships a `system.8bs` (with per-profile twins where a
profile changes a number, the way `geometry.pet.8032.8bs` does today), and
`@8bitscript/system` delegates to it by machine, exactly as `screen` and
`text` delegate. The fact sheet is consts, so every fact is a compile-time
number, and `8bs check` can validate every machine's sheet at once.

```
import { System, Video, Audio, Input, Storage, Memory } from "@8bitscript/system";
```

| Namespace | Facts | Notes |
| --------- | ----- | ----- |
| `Video` | `COLUMNS`, `ROWS` (text grid); `WIDTH`, `HEIGHT` (visible pixels); `CELL_WIDTH`, `CELL_HEIGHT`; `PALETTE` (colours the machine can show at once); `CELL_COLORS` (colours one cell may hold); `GLYPHS` (redefinable characters, 0 on the PET); `BLOCK_WIDTH`, `BLOCK_HEIGHT` (pseudo-pixels per cell from block glyphs: 2×2 on PETSCII machines, 0 where there are none); `BITMAP` (a pixel-addressable mode exists); `LAYERS`; `SCROLL` (hardware fine scroll); `SPRITES` (total); `SPRITES_PER_LINE` (the number that breaks programs); `SPRITE_WIDTH`, `SPRITE_HEIGHT`, `SPRITE_COLORS` | Every count is 0 rather than absent. `SPRITES_PER_LINE` on a machine with a cycle budget instead of a count (X16) is the worst-case count at the package's default sprite size, and the package says so. |
| `Audio` | `VOICES`; `NOISE` (a noise voice exists); `ENVELOPE` (hardware ADSR); `FILTER`; `PCM` (sample playback); `VOLUME` (per-voice volume exists — false on the PET); `ENTROPY` (a hardware random source exists) | The PET is `VOICES = 1`, `VOLUME = false`, and that is the honest sheet, not a stub. |
| `Input` | `KEYBOARD`; `JOYSTICKS` (ports); `MOUSE`; `PADDLES`; `PADS` (console controllers) | Presence of the *port*. Whether something is plugged in is the capability's runtime answer. |
| `Storage` | `LOAD`; `SAVE`; `BYTES` (persistent bytes the profile guarantees, 0 on an NROM cartridge, 32 in the X16's RTC NVRAM) | Persistence is the profile's, never the machine name's. |
| `Memory` | `RAM` (KiB the build may use); `BANKED` (RAM beyond the CPU window exists); `BANK_SIZE` | The linker enforces `RAM`; the fact is there so a program can size a buffer at compile time. |

Two rules for the sheet:

1. **A fact is never missing.** A machine without hardware sprites says
   `Video.SPRITES = 0`; a program that reads it gets a number it can branch
   on, and the branch folds away. `actors.PER_ROW` on the same machine is
   still a number — what its software actors can manage — because the
   concept exists there even though the chip does not.
2. **A fact is the worst case that matters, not the brochure figure.** The
   NES's sprite fact that decides whether a scene works is 8 per line, not
   64 per frame. The X16's is a per-line pixel budget. When the brochure
   figure is also useful it is a second const with its own name, never the
   same name meaning different things on different machines.

Studio's tier is the first customer: once the sheet exists, "full tier" is
`Video.SPRITES > 0 && Audio.VOICES >= 3 && Storage.SAVE`, not a list of
machine names, and a tenth machine gets the right tier without anyone
editing Studio.

## Behaviour: capability packages

A capability is one npm package per concept, delegating per machine to
that machine's own implementation, with the rule already in force for
`screen` and `text`: the surface is identical everywhere it exists. A
capability is named for the *concept* a program has, never for the chip
that happens to provide it, and so it exists on every machine where the
concept makes sense at all — a moving object is a concept on the PET even
though a sprite is not, so `actors` exists there, drawn by rewriting
cells, and the number that comes with it says how many can share a row
before the machine cannot keep up. Only a concept a machine genuinely
lacks (persistence on an NROM cartridge, a pointer on a machine with no
port for one) is `8BS3002` at build time, and never a stub that does
nothing. The proposed set, in the order Studio needs them:

| Package | Intent | Exists on | First facts |
| ------- | ------ | --------- | ----------- |
| `@8bitscript/screen` | border, background | all nine | — |
| `@8bitscript/text` | a cell grid of characters and a current colour | all nine | `COLUMNS`, `CELL_COUNT` |
| `@8bitscript/input` | keys, sticks, pads, and a pointer, as *intent*: `input.left()`, `input.confirm()`, `input.pointerX()` | all nine (the NES answers from the pad; a machine without a pointer answers `pointerPresent() == false`) | `Input.*` |
| `@8bitscript/canvas` | a work area of pseudo-pixels the program draws into, at a size and depth it asks for; the machine picks the unit (see [the display model](#the-display-model-units-not-pixels)) | every machine with glyphs, blocks, or a bitmap — that is all of them but the NROM NES | `canvas.MAX_WIDTH`, `MAX_HEIGHT`, `COLORS` |
| `@8bitscript/tiles` | a scrolling layer of tile indices: `tiles.set(x, y, t)`, `tiles.scroll(x, y)`, `tiles.define(t, shape)` | machines with a tile or redefinable-character layer | `Video.GLYPHS`, `Video.SCROLL` |
| `@8bitscript/actors` | moving objects: `actors.place(n, x, y)`, `setShape`, `hide`; coordinates from the visible top-left. Hardware sprites where they exist (C64, NES, X16, MEGA65), players and missiles on the Atari, the blitter on the Lynx, redrawn cells or glyphs on the PET, VIC-20, Plus/4, Apple II | all nine, and every roadmap machine | `actors.COUNT` (how many at once), `actors.PER_ROW` (how many may share a row: 8 on a C64, 8 on the NES, a handful on a PET before the frame is spent), `actors.WIDTH`, `HEIGHT`, `COLORS` |
| `@8bitscript/palette` | name the colours a program uses, once, and let each machine map them | all nine (a fixed-palette machine maps to its nearest) | `Video.PALETTE` |
| `@8bitscript/sound` | `sound.play(voice, note, instrument)`, `stop`, `volume`; an instrument is a portable parameter set each chip maps (ADSR in hardware on a SID, in software on a POKEY) | all nine, including the PET's one voice | `Audio.*` |
| `@8bitscript/storage` | `storage.save(slot, ...)`, `load`; a slot is the profile's persistent bytes | profiles with somewhere to write | `Storage.*` |
| `@8bitscript/random` | deterministic, seeded, small state | all nine | — |
| `@8bitscript/entropy` | the hardware source, explicitly | machines with one | `Audio.ENTROPY` |

Under each capability the hardware layer stays available and machine-only:
`@8bitscript/c64/sprites` is what `@8bitscript/actors` is built on for
the C64, and a C64-only program may import it directly. The capability is
never the only way in.

A capability's surface is designed on the machine that has the *least* of
it, then checked against the one that has the most. `actors` is designed
against the PET's redrawn cells and the NES's eight per line, and checked
against the X16's 128 and the Lynx's blitter; `canvas` is designed
against the PET's cells and checked against the X16's bitmap layer. The
program never says "sprite"; it says what it wants moved, and reads the
number that says how much of that this build can do.

## Branching on the machine

Three tools, from most to least preferred:

1. **A fact.** `let row: usmallint = y * text.COLUMNS + x;` is right on
   every machine and every profile, including ones that do not exist yet.
2. **A per-machine file.** When the *code* differs — a C64 preview that
   drives real sprites, an X16 one that drives VERA — `preview.c64.8bs`
   beside `preview.8bs`. The shared code imports `./preview.8bs` and never
   names a machine. This is also the only way to use a machine-only
   package from a portable program, because an import is resolved for the
   whole module: an `if` cannot hide it.
3. **The machine's name.** `if (#system() == System.NES)` for what is
   genuinely identity — which tier, which title, which help text. It is a
   compile-time constant; the other arms fold away in the generated code.

What is *not* offered, deliberately: a runtime probe. A program never asks
the machine what it is; the build already knows, and the answer would
cost bytes and cycles on every machine to find out what one file already
says.

### A `switch` for the machine (proposal)

`switch` and `case` are reserved words with no parse rule yet, so writing
one is an honest syntax error today. The statement they should become:

```
switch (#system()) {
    case System.NES: { tier = Tier.VIEWER; }
    case System.VIC20, System.PET: { tier = Tier.BASIC; }
    default: { tier = Tier.FULL; }
}
```

- Every arm is a block; there is no fall-through and no `break`.
- An arm may list several values.
- When the subject is a namespace const and every arm is a const of the
  *same* namespace, the checker knows the whole set of values: a `switch`
  without `default` must name every member of the namespace, or it is a
  diagnostic that lists the ones missing. That is the "intelligently
  figure out what needs to happen" the design wants: adding a tenth
  machine to `System` turns every non-exhaustive `switch` in every program
  into a build error that names the machine, instead of a silent wrong
  default.
- When the subject folds to a constant, the IR keeps only the chosen arm.
  The same folding should apply to an `if` whose test is two consts; today
  the IR carries `if (3 == 3)` and leaves it to the C compiler, which is
  fine on the 6502 backend and merely untidy on the web one.

It is a core change, so it lands with the whole checklist in the root
`AGENTS.md` (parser, checker, IR, both backends, hover and completion, the
language-server test, the grammar, the snippets, the docs) in one commit,
and it is not needed for anything on this page to be built: an `if` chain
on `#system()` does the same job without the exhaustiveness check.

## The display model: units, not pixels

No two of these machines put a picture together the same way, and the
portable layer must not pretend otherwise. What every machine *does* have
is some set of **display units**, and the portable capabilities are
written in terms of the unit, never the pixel:

| Unit | What it is | Machines |
| ---- | ---------- | -------- |
| **Cell** | a character position in a grid; a code (and usually a colour) per cell | every machine with a text mode: all nine, and every roadmap machine except the Lynx, the Supervision, and the Atari 2600 |
| **Glyph** | a cell whose shape the program can redefine — a tile by another name | VIC-20, C64, C128 (VIC-IIe side), Atari 8-bit, X16, MEGA65, NES (CHR-RAM profiles only); not the PET, not an NROM NES |
| **Block** | a fixed ROM glyph that shows a 2×2 (PETSCII) or 2×3 (Teletext) pattern, so a cell can present pseudo-pixels without redefining anything | PET, VIC-20, C64, C128, MEGA65, X16 (PETSCII ROM); BBC Mode 7 (sixels); the Atari's ROM has a partial set |
| **Bitmap** | a pixel-addressable mode, at whatever colour granularity the chip imposes (per 8×8 cell on a C64, per 4×8 in multicolour, per pixel on an X16 layer) | C64, C128, Atari 8-bit, X16, MEGA65; the VIC-20 only by lying to it with tall characters, which is a glyph trick, not a mode |
| **Tile layer** | a scrolling plane of indices into a pattern set, with hardware scroll | NES, X16 (two), MEGA65; the C64 and Atari fake it with a redefined charset plus fine-scroll registers |
| **Sprite** | a movable object the chip composites over the layers, with a per-line limit | C64, C128, NES, X16, MEGA65, and the Atari's four players and four missiles |

The rule that follows: **a portable drawing call names a unit and a
position, never an RGB value at a pixel.** `text.putChar(cell, code)` is
the cell unit. `tiles.set(x, y, t)` is the tile unit. `actors.place(n,
x, y)` is the moving-object unit. The one place a program draws pixels is the
canvas, and the canvas is a unit of its own:

### The canvas: pseudo-pixels the machine chooses how to show

A `canvas` is a rectangle of pseudo-pixels the program asks for by size
and colour count — "64 by 64, four colours" — and draws into with
`canvas.set(x, y, colour)`. Each machine's implementation picks the unit
that can show it and reports what it did:

| Rung | Unit used | Example |
| ---- | --------- | ------- |
| Bitmap | a bitmap mode, or a bitmap layer; one pseudo-pixel is one pixel (or a 2×1 in a multicolour mode, and the fact says so) | X16 layer 0 at 320×240 8 bpp; C64 hires 320×200 |
| Glyphs | a window of redefined characters: a 64×64 canvas is 64 glyphs of 8×8, laid out as an 8×8 block of cells; the program draws pixels, the package edits glyph bytes | VIC-20 (64 of its 256 RAM characters), Atari (a redefined charset in GR.0), NES with CHR-RAM |
| Blocks | quarter-block glyphs: one cell is 2×2 pseudo-pixels, one colour per cell where there is colour, on or off where there is not; a 40-column PET shows an 80×50 canvas, an 80-column one 160×50 | PET, and any machine's *fallback* when its glyphs are all spoken for |
| Cells | one cell per pseudo-pixel — reverse video on, reverse video off — which is the zoomed editing view every tile editor wants anyway | PET editing an 8×8 tile as an 8×8 block of cells |

The canvas facts (`canvas.MAX_WIDTH`, `MAX_HEIGHT`, `COLORS`, and which
rung the build got) let a program lay itself out for what it has. Nothing
here is a framebuffer: the PET's canvas is a routine that writes screen
codes, and it says so in its fact sheet.

### Where text lands

The nine `text` implementations already answer "where is cell 0" the same
way — the top-left corner of the area a program can see — and hide a
different answer on every machine. The numbers, from the packages (and
from `8bs run <target> --screenshot`, which is how each was checked):

| Machine | Grid | Cell | Where the grid sits | Border colour |
| ------- | ---- | ---- | ------------------- | ------------- |
| VIC-20 | 22×23 | 8×8 | screen matrix at `$1E00` (`$1000` with 8K+), inside a real border | yes, `$900F` |
| C64 | 40×25 | 8×8 | screen RAM at `$E000` in VIC bank 3, ROM charset copied under I/O, inside a real border | yes, `$D020` |
| PET | 40×25 or 80×25 (8032) | 8×8 | `$8000`, the whole display; no border, no colour | no |
| C128 | 40×25 (VIC-IIe side) | 8×8 | as the C64; the VDC's 80 columns are a second, separate display | yes |
| Atari 8-bit | 40×24 | 8×8 | ANTIC mode 2 (GR.0) screen, inside a real border; text colour is a luminance against the playfield colour | yes, COLBK |
| NES | 28×26 | 8×8 | nametable 0, inset from the 32×30 to stay inside NTSC overscan; written only while the picture is off or during vblank; no border, the "border" is the background colour | no, background only |
| X16 | 76×56 | 8×8 | VERA layer 1 text map, inset 16 px on each side so a border exists to colour | made, not native |
| MEGA65 | 80×25 | 8×8 | MEGA65 mode: VIC-IV personality, 80-column screen at `$0800`, interrupts off; colour RAM past cell 1023 only with CRAM2K set | yes, 8-bit |
| web | 40×25 | 8×8 | the runtime's cell grid; a design choice, not hardware | yes |

Three of those rows are the reason the canvas exists: the PET has no
border and no colour, the NES has no border and cannot be written while
it is drawing, the X16 has no border unless one is made. A program that
"just draws" would be wrong on all three; a program that draws units is
right on all nine.

## Studio's tile editor on every rung

The first app is the internal tile editor, and it is the test of this
page. It is designed on the X16 and runs the same source everywhere:

| Machine | UI | Work area | Live preview | Pointer |
| ------- | -- | --------- | ------------ | ------- |
| X16 | text, 76×56 | canvas on a bitmap layer, 8 bpp; zoomed tile and full tileset side by side | tiles on layer 0, sprites over it | mouse (the KERNAL's, on a VERA sprite), keyboard |
| MEGA65 | text, 80×25 | full-colour characters as the canvas | real | 1351 or Amiga mouse, keyboard |
| C128 | text, 40 columns (VIC-IIe side) | glyph window or bitmap | real sprites | 1351 mouse or keyboard |
| C64 | text, 40×25 | glyph window (a redefined charset block) or hires bitmap | real sprites, `@8bitscript/c64/sprites` under `actors` | 1351 mouse (proposal), joystick, keyboard |
| Atari 8-bit | text, 40×24 | redefined charset in GR.0, or a bitmap mode via a display list | players/missiles as sprites | ST mouse (proposal), joystick, keyboard |
| web | anything | anything | anything | mouse, keyboard |
| VIC-20 | text, 22×23 | glyph window: a tile is edited as cells, the tileset shown through redefined characters, as many as RAM allows | software actors: the glyph itself moved through the cells | keyboard, joystick |
| PET | text, 40 or 80 columns | cells: one pseudo-pixel per cell at zoom; quarter-blocks for the tileset overview | software actors in cells; monochrome | keyboard only |
| NES | text, 28×26 | none on NROM (CHR-ROM is read-only); a CHR-RAM profile gets a glyph window | real tiles and sprites | pad only — no text entry, so: the viewer |

Every row is the same program. What differs is the fact sheet it was
built against, and one per-machine `preview` file where a real hardware
preview exists.

## Sound

The same shape as video: a unit (a **voice**), facts about it, and a
capability that speaks in notes.

| Machine | Chip | Voices | Hardware envelope | Noise | Samples | Volume | Entropy |
| ------- | ---- | ------ | ----------------- | ----- | ------- | ------ | ------- |
| VIC-20 | VIC | 3 square + 1 noise | no | yes | no | one, shared | no |
| C64 | SID | 3 | ADSR | yes (a waveform) | crudely, via volume | master; per-voice via ADSR | osc 3 `$D41B` |
| PET | VIA CB2 | 1 | no | no | no | none | no |
| C128 | SID | 3 | ADSR | yes | as the C64 | as the C64 | as the C64 |
| Atari 8-bit | POKEY | 4 (or 2 at 16 bits) | no | poly distortion per voice | no | per voice, 4 bits | `RANDOM` |
| NES | APU | 2 pulse, 1 triangle, 1 noise, 1 DMC | length/sweep/decay units | yes | DMC, 1-bit delta | per pulse/noise voice | no |
| X16 | VERA PSG, YM2151, PCM | 16 PSG + 8 FM + 1 PCM | FM yes; PSG no | PSG yes | yes, FIFO | per voice | no |
| MEGA65 | 4 SIDs + DACs | 12 + 4 | ADSR | yes | yes, via DMA | per voice | as the C64 |
| web | the runtime | whatever it decides to be | — | — | — | — | — |

The portable `sound` capability is designed against the PET's one voice
with no volume and checked against the X16's twenty-five: a note-level
API (`play(voice, note, instrument)`) where an *instrument* is a portable
description (waveform family, attack, decay, sustain, release) that a
SID implements in hardware and a POKEY or PSG implements in software at
frame rate. A voice a machine lacks is `Audio.VOICES` saying so, and a
program that wants three voices on a PET reads that fact and drops to one.

## Input

The pointer is what makes the tile editor pleasant on the X16 and what
most of the machines lack, so `input` names intent, not devices:
`left()`, `right()`, `up()`, `down()`, `confirm()`, `cancel()`,
`pointerPresent()`, `pointerX()`, `pointerY()`, `pointerDown()`, and
`key(k)` on machines with a keyboard. Each machine's implementation maps
those onto what it has:

| Machine | Keyboard | Sticks / pads | Pointer |
| ------- | -------- | ------------- | ------- |
| VIC-20 | matrix, scanned | 1 port | none (a paddle pair, at most) |
| C64 | matrix, scanned (`@8bitscript/c64/keyboard`) | 2 ports (`/joystick`) | 1351 mouse in a port, proposal |
| PET | matrix, scanned once a frame (`@8bitscript/pet/keyboard`) | none | none |
| C128 | matrix, scanned | 2 ports | 1351 mouse |
| Atari 8-bit | POKEY keyboard | 2 ports (4 on the 400/800) | ST mouse or trackball in a port, proposal |
| NES | none | 2 pads | none (the Zapper is not a pointer for this purpose) |
| X16 | PS/2 through the KERNAL | SNES pads (how many the KERNAL scans: *to verify*) | PS/2 mouse, KERNAL-drawn cursor |
| MEGA65 | matrix plus the ASCII key register | 2 ports | 1351 or Amiga mouse |
| web | the browser's | the Gamepad API | the browser's |

The rule that matters for Studio: **a program with no pointer must still
work**, so every pointer action has a keyboard or pad equivalent, and the
editor's layout is chosen from `Input.MOUSE`, not from the machine's name.

## Storage

Persistence is the profile's. The capability is `save`/`load` of a slot;
the facts say whether there is anywhere to put one and how big it is. What
each target has, and how the emulator reaches the host's files (the route
"Launch in Studio" needs):

| Machine | Where a save goes | Emulator route to the host |
| ------- | ----------------- | -------------------------- |
| Commodore (VIC-20, C64, PET, C128) | a disk image via the KERNAL, or tape | VICE attaches `.d64` images; `-fs8 <dir>` mounts a host directory as drive 8 |
| Atari 8-bit | a disk image via DOS/SIO | atari800 `-H1 <dir>` mounts a host directory as `H:` |
| NES | battery SRAM on MMC1/MMC3 boards; nothing on NROM | the emulator's `.sav` beside the ROM |
| X16 | the SD card, through the KERNAL's DOS; 32 bytes of RTC NVRAM | x16emu `-fsroot <dir>` (host filesystem) or `-sdcard <image>` |
| MEGA65 | the SD card, `.d81` images through the hypervisor | xemu `-8 <image.d81>` mounts an image on drive 8; `-hdosdir <dir>` redirects the hypervisor's DOS to a host directory |
| web | the browser (a download, or IndexedDB) | the page itself |

Studio's assets are 8BitScript source (`packages/studio/AGENTS.md`,
"Files: a proposal"): a saved tile set is a `.8bs` module exporting a
`const` array, so it needs no format of its own and every machine can
place it as data. Storage is what gets it from the emulator back to the
repository.

## Project configuration

Today `8bs.config.ts` lists targets as an array and the profile is a
command-line flag. Proposal: `targets` may also be a map, and each entry
says which profiles the project supports, first one default:

```ts
export default {
  entry: 'src/main.8bs',
  frameRate: 60,
  targets: {
    cx16: {},
    c64: { profiles: ['stock', 'reu512'] },
    vic20: { profiles: ['8k', '16k', '24k'] },   // not unexpanded: the tileset needs the RAM
    pet: { profiles: ['4032', '8032'] },
    nes: { profiles: ['mmc1'] },                 // CHR-RAM and battery SRAM, once NES has profiles
    web: {},
  },
};
```

- The array form stays as shorthand for "every profile the machine has,
  default first".
- `--profile` on the command line overrides, and a profile the project
  did not list is an error naming the ones it did, the way an unlisted
  target is today.
- The map is the *whole* statement of hardware support. There is no
  separate RAM number: the profile is the RAM, the linker script enforces
  it, and the build's memory line reports it. A program that fits the 8K
  VIC-20 says so by listing `8k`, not by writing `ram: 8`.
- A per-target `run` block carries run-time choices the CLI knows by name
  (`model`, `sidModel`, `videoOutput`) and passes to the emulator — never
  raw emulator flags, so the same config drives VICE, atari800, FCEUX,
  x16emu, and xemu without knowing which.

## The editor

The VS Code extension already has System and Region dropdowns and a
Projects view; it should not have to know the nine names, and today it
does (in `projects.cjs`, while its settings schema still lists three of
them). Proposal:

- **`8bs targets --json`**: the CLI prints every target it can build, with
  its title, its profiles (id, label, what the profile changes, which is
  default), whether region applies, which emulator runs it, and whether
  `8bs doctor` finds that emulator. The extension reads this once per
  session and builds its dropdowns from it. A new machine in the CLI is a
  new row in the editor with no extension release.
- **A Profile dropdown** beside System and Region, filtered to what the
  open project's `targets` map allows, passed as `--profile` to Run,
  Build, and the screenshot task. The settings schema gains
  `8bitscript.profile`, and the System enum is generated from the same
  listing rather than hand-written.
- **A capability panel** for the selected system and profile: the fact
  sheet, read by linking a probe against `@8bitscript/system` the way
  `packages/system/test` does, so the editor shows the same numbers the
  program will fold. This is where "set the emulator up with the proper
  settings" lives: choosing a profile in the panel *is* choosing the
  emulator's RAM, model, and media, because the CLI maps one to the other
  in one place (`packages/cli/src/run.mjs`).
- **Debug launch settings** (`8bitscript.run.<target>`) for the run-time
  choices the config's `run` block names, shown as dropdowns whose values
  come from the listing.

## What a new machine needs

The metric for this design is the roadmap's: how much code does it take
to add a machine? With the layer above, a target package is a fixed set
of files, and adding a machine is writing them:

```
packages/<machine>/
  package.json          8bitscript.entry, .exports for each capability it has, .native
  AGENTS.md             the verified hardware notes, in the shape the others use
  src/
    index.8bs           the registers and ports, named
    geometry.8bs        where the screen is (plus geometry.<machine>.<profile>.8bs twins)
    system.8bs          the fact sheet (plus profile twins)
    screen.8bs          @8bitscript/screen's branch
    text.8bs            @8bitscript/text's branch
    input.8bs           and so on, one per capability the machine can honour
    canvas.8bs
    tiles.8bs
    actors.8bs
    sound.8bs
    storage.8bs
```

plus one entry per capability manifest, one `FRAME_SYNC` and one driver
entry in `packages/backend-6502`, one emulator entry in
`packages/cli/src/run.mjs`, and a `docs/setup/<machine>.md`. Nothing in
the compiler. That holds for every 6502-family machine on the
roadmap. The Z80 family and the Game Boy are the exception the roadmap
already expects (a second backend), and the research adds one thing they
force on the *language*, not just the backend: every Z80 machine reaches
its hardware through `IN`/`OUT` port instructions, which `@address` cannot
spell, so a port-mapped register needs a construct of its own before the
first Z80 target package can be written. The Game Boy, memory-mapped at
`$FF00` and up, does not. That is the whole checklist, and `docs/project/machines/`
holds the research for the machines on the roadmap in the same
sixteen-row shape, so the sheet for each is already drafted when its turn
comes.

## The machines, side by side

The table the rest of this page is written from. Existing targets are
from their package notes (`packages/<target>/AGENTS.md`), checked against
the installed toolchain and emulators; roadmap machines are from
[`docs/project/machines/`](project/machines/index.md) and carry that
directory's *to verify* marks. Counts are per line where a per-line limit
exists, because that is the number that decides whether a scene works.

### Display

"Grid" is the text grid the portable `text` draws on (or would). "Glyphs"
is whether a cell's shape can be redefined, and how many. "Blocks" is the
pseudo-pixel subdivision a fixed ROM glyph set gives one cell. "Bitmap" is
the pixel-addressable mode and its colour granularity.

| Machine | Native unit | Grid | Glyphs | Blocks | Bitmap | Layers, scroll |
| ------- | ----------- | ---- | ------ | ------ | ------ | -------------- |
| VIC-20 | cells | 22×23 | 256 in RAM, in the internal 4K only | 2×2 | none (8×16 glyphs fake one) | 1, coarse only |
| C64 | cells, bitmap | 40×25 | 256 in RAM | 2×2 | 320×200 (2 per 8×8) / 160×200 (4 per 4×8) | 1, fine 0–7 both axes |
| PET | cells | 40×25 / 80×25 | 0 | 2×2 | none | 1, none |
| C128 | cells, bitmap (VIC-IIe); cells, bitmap (VDC) | 40×25 / 80×25 | 256 (VIC); 512 of 8×16 (VDC) | 2×2 | as C64; VDC 640×200 1 bpp with per-cell fg/bg | 1 each; VDC smooth scroll |
| Atari 8-bit | display list: cells, bitmap, players | 40×24 | 128 + inverse per charset | partial (ROM CTRL range) | 320×192 (1 hue, 2 lumas) to 160×192 (4 colours), GTIA 80×192 (16) | 1, fine 0–15 both axes, per display-list line |
| NES | tiles, sprites | 28×26 (of 32×30) | 256 per pattern table; CHR-RAM profiles only | in the font | none | 1 (2 nametables), fine scroll |
| X16 | tiles, bitmap, sprites (VERA) | 76×56 (of 80×60) | VRAM tiles, thousands | 2×2 | 320×240 8 bpp per layer, 640×480 at lower depth | 2, fine scroll per layer |
| MEGA65 | cells (VIC-II/III/IV), bitmap, bitplanes, sprites | 80×25 | 8192 with 16-bit cells; FCM 256 colours per char | 2×2 | 320×200 to 640×400; FCM is a bitmap of unique chars | 1 + raster-rewrite buffer, fine scroll, per-char Y offset |
| web | cells (the runtime's) | 40×25 | 0 | 0 | none | 1, none |
| Apple II | bitmap, cells | 40×24 / 80×24 | 0 (ROM font) | 2×1 lores (16 colours) | 280×192 with positional hues (140×192 colour); double hires 560×192 | 1, none; 2 pages |
| Plus/4 | cells, bitmap (TED) | 40×25 | 256 in RAM | 2×2 | 320×200 (2 per 8×8) / 160×200 (4 per 8×8) | 1, fine 0–7 both axes |
| BBC Micro | bitmap; Teletext cells (mode 7) | 40×25 / 80×25 / 80×32 | 32 user-defined in bitmap modes; 0 in mode 7 | 2×3 sixels (mode 7) | 640×256 2 colours to 160×256 16, per pixel | 1, coarse (CRTC start address) |
| Oric | cells (RAM charset), bitmap, serial attributes | 40×28 | 176 in RAM, 6×8 | 6×8 via redefinition | 240×200, 6 px per byte, ink/paper per line segment | 1, none |
| Atari 5200 | display list, as Atari 8-bit | program's own (40×24 typical) | program's own ROM charset | as Atari 8-bit | as Atari 8-bit | as Atari 8-bit |
| Lynx | 4-bpp framebuffer, blitter | none (software font) | n/a | n/a | 160×102, 16 of 4096, palette per line | 1 (chain order), none |
| PC Engine | tiles, sprites (VDC) | none (software over the BAT: 32×28 to 64×30) | VRAM tiles, thousands, 4 bpp | n/a | none | 1 (2 on SuperGrafx), fine scroll, per line |
| Supervision | 2-bpp framebuffer | none (software) | n/a | n/a | 160×160, 4 greys | 1, window scroll |
| Atari 2600 | TIA, per scanline | none | n/a | playfield 40×192 blocks | none | 1 playfield, none |
| Game Boy | tiles, sprites | none (software: 20×18 of 8×8) | 384 tiles per VRAM bank (768 on CGB), 2 bpp | n/a | none | background + window, fine scroll; VRAM locked while drawing |
| ZX Spectrum | 1-bpp bitmap + 8×8 attribute cells | 32×24 (ROM font, software) | n/a | n/a | 256×192, 2 of 15 colours per 8×8 cell | 1, none; large settable border; 128K flips two screens |
| MSX 1 / 2 | tiles, sprites (TMS9918 / V9938) | 40×24 (TEXT 1, no sprites) or 32×24 | 256 (768 in Graphic 2), 2 colours per 8×1 row | n/a | MSX2: 256×212 at 16 colours to 256 colours, 512×212 at 4 or 16 | 1; V9938 vertical scroll only (horizontal *to verify*, V9958) |
| Master System / Game Gear | tiles, sprites (Mode 4) | none (software over the 32×28 map; GG shows 160×144 of it) | 512 patterns in VRAM (about 448 after the tables), 4 bpp | n/a | none | 1, fine scroll both axes, lockable status rows |
| Amstrad CPC | bitmap (CRTC) | 40×25 / 80×25 / 20×25 (firmware text) | n/a (firmware font) | n/a | 160×200 16 / 320×200 4 / 640×200 2, of 27 (*pixel packing to verify*) | 1, coarse (CRTC start address); Plus: soft scroll |
| ColecoVision | tiles, sprites (TMS9928A) | 32×24 (Graphic 1) or 40×24 (Text, no sprites) | 256 (768 in Graphic 2), 2 colours per 8×1 row; fixed 15 colours | n/a | none | 1, no scroll of any kind |

### Sprites

The number that matters is the per-line one. "Substitute" is what a
machine without sprites uses for a moving object.

| Machine | Sprites | Per line | Size, colours | Collision | Substitute |
| ------- | ------- | -------- | ------------- | --------- | ---------- |
| VIC-20 | 0 | — | — | software | redrawn RAM glyphs |
| C64 | 8 | 8 | 24×21 (1 colour) or 12×21 (3), ×2 stretch | hardware registers | — |
| PET | 0 | — | — | software | redrawn cells |
| C128 | 8 (VIC-IIe), 0 (VDC) | 8 | as C64 | as C64 | VDC: glyphs |
| Atari 8-bit | 4 players + 4 missiles | 4 + 4 (5 with the missile player) | 8 px wide strips, ×1/2/4, one colour each | 16 hardware registers | — |
| NES | 64 | **8** | 8×8 / 8×16, 3 colours + transparent | sprite 0 hit only | — |
| X16 | 128 | a cycle budget per line (~800 VERA cycles), so it depends on width and depth | 8 to 64 px, 4 or 8 bpp | coarse mask, once a frame | — |
| MEGA65 | 8 | 8, reusable across a line | 24×21 to 64 px wide, 1, 3, or 15 colours; shared height to 255 | VIC-II registers | — |
| web | 0 | — | — | — | — |
| Apple II | 0 | — | — | software | pre-shifted hires blits |
| Plus/4 | 0 | — | — | software | RAM glyphs or bitmap |
| BBC Micro | 0 | — | — | software | bitmap blits |
| Oric | 0 | — | — | software | redefined glyphs or hires |
| Atari 5200 | 4 + 4 | 4 + 4 | as Atari 8-bit | as Atari 8-bit | — |
| Lynx | unlimited (blitter) | none; blit time per frame | any size, 1–4 bpp, scaled, flipped | hardware collision buffer | — |
| PC Engine | 64 | **16** | 16×16 to 32×64, 15 colours + transparent | one status bit | — |
| Supervision | 0 | — | — | software | DMA blits into VRAM |
| Atari 2600 | 2 players + 2 missiles + ball | exactly those, copies free | 8 px players, 1–8 clock missiles | 15 hardware pairs | rewrite mid-frame |
| Game Boy | 40 | **10**, chosen by Y (X-hidden ones still count) | 8×8 / 8×16, 3 colours + transparent | none | — |
| ZX Spectrum | 0 | — | — | software | bitmap blits inside attribute cells |
| MSX 1 / 2 | 32 | 4 (sprite mode 1, one colour); 8 (V9938 mode 2, colour per line) | 8×8 / 16×16, ×2 | overlap flag (mode 2: coordinates) | — |
| Master System / Game Gear | 64 | **8** | 8×8 / 8×16, 15 colours + transparent | collision and overflow flags | — |
| Amstrad CPC | 0 (16 on the Plus) | — (Plus: *to verify*) | Plus: 16×16, 15 colours, zoom | software | bitmap blits |
| ColecoVision | 32 | 4, one colour | 8×8 / 16×16, ×2 | overlap flag | — |

### Sound

| Machine | Chip | Voices | Envelope | Noise | Samples | Volume | Entropy |
| ------- | ---- | ------ | -------- | ----- | ------- | ------ | ------- |
| VIC-20 | VIC 6560/6561 | 3 square + 1 noise | no | yes | no | one, shared | none |
| C64 | SID | 3 | ADSR | yes | via volume | master; ADSR per voice | osc 3 |
| PET | VIA CB2 | 1 | no | no | no | none | none |
| C128 | SID | 3 | ADSR | yes | via volume | as C64 | osc 3 |
| Atari 8-bit | POKEY | 4 (or 2 × 16-bit) | no | poly distortions | volume-only mode | per voice, 4 bits | `RANDOM` |
| NES | APU | 2 pulse, triangle, noise, DMC | length, sweep, decay units | yes | DMC 1-bit delta | per pulse and noise | none |
| X16 | VERA PSG + YM2151 + PCM | 16 + 8 + 1 | FM yes; PSG software | PSG | FIFO PCM | per voice | none |
| MEGA65 | 4 SIDs + 4 DMA channels | 12 + 4 | ADSR | yes | DMA samples | per voice | osc 3 |
| web | none yet | 0 | — | — | — | — | — |
| Apple II | speaker toggle (`$C030`); Mockingboard optional | 1 bit; 3–6 with the card | card only | card only | CPU-timed 1-bit | none | none |
| Plus/4 | TED | 2 (square; square or noise) | no | one voice | D/A bit | one, 0–8 | none |
| BBC Micro | SN76489 | 3 tone + 1 noise | software (MOS envelopes) | yes | no | per voice, 4 bits | none |
| Oric | AY-3-8912 | 3 + noise | one hardware envelope | yes | via volume | per voice | none |
| Atari 5200 | POKEY | as Atari 8-bit | no | yes | volume-only | per voice | `RANDOM` |
| Lynx | Mikey | 4 (LFSR + 8-bit DAC) | no | LFSR | DAC writes | per voice; stereo on Lynx II | none dedicated |
| PC Engine | PSG on the CPU | 6 wavetable | no | on 5–6 | DDA direct DAC | per voice + L/R | none |
| Supervision | its own | 2 tone (one left, one right) + noise + sample DMA | no | yes | 4-bit DMA | per voice | none |
| Atari 2600 | TIA | 2 | no | 16 generators | no | 4 bits | none |
| Game Boy | APU | 2 pulse, wave, noise | hardware envelopes | yes | 32-sample wave RAM | per voice, stereo pan | none |
| ZX Spectrum | beeper (48K); AY-3-8912 (128K) | 1 bit; 3 + noise | AY envelope | AY | CPU-timed 1-bit | none; per voice on AY | none |
| MSX 1 / 2 | AY-3-8910 (+ optional FM, SCC) | 3 + noise | one hardware envelope | yes | via volume | per voice | none |
| Master System / Game Gear | SN76489 (+ YM2413 on Japanese SMS) | 3 tone + 1 noise | no | yes | via volume | per voice; GG stereo | none |
| Amstrad CPC | AY-3-8912 | 3 + noise | one hardware envelope | yes | via volume | per voice | none |
| ColecoVision | SN76489 | 3 tone + 1 noise | no | yes | via volume | per voice | none |

### Input, storage, and the frame

"Pointer" is a mouse-class device the machine can take. "Save" is where a
profile can persist bytes. "Frame" is how a program waits for one.

| Machine | Keyboard | Sticks, pads | Pointer | Save | Frame |
| ------- | -------- | ------------ | ------- | ---- | ----- |
| VIC-20 | matrix (VIA) | 1 port | paddles; 1351 *to verify* | disk, tape | poll `$9004`; no vblank flag or IRQ |
| C64 | matrix (CIA) | 2 ports | 1351 in a port | disk, tape, REU (volatile) | poll `$D012` under `sei`; raster IRQ |
| PET | matrix (PIA), snapshot once a frame | none | none | disk, tape | `$E812` retrace edge |
| C128 | matrix + 3 extra columns | 2 ports | 1351 | disk (1571/1581), tape | as C64; VDC has no vsync |
| Atari 8-bit | POKEY-scanned | 2 (4 on 400/800) | ST/Amiga mouse, trackball, in a port | disk under DOS, tape | poll VCOUNT; OS VBI (an NMI, `sei` does not stop it) |
| NES | none | 2 pads | none | battery SRAM on MMC1/MMC3 profiles; none on NROM | NMI at vblank; writes only then |
| X16 | PS/2 via KERNAL | SNES pads (count *to verify*) | PS/2 mouse, KERNAL cursor | SD card via DOS; 32 bytes RTC NVRAM | VERA VSYNC bit |
| MEGA65 | matrix, direct matrix, ASCII queue | 2 ports | 1351 or Amiga mouse | SD card via Hyppo traps, floppy | poll `$D012`; frame counter `$D7FA`; interrupts are off |
| web | none yet | none yet | none yet | none yet | `Atomics.wait` on the page's clock |
| Apple II | one-key ASCII latch | 2 analogue paddle pairs | AppleMouse card; IIc built in | ProDOS files on disk images | `$C019` on IIe; none on II/II+ |
| Plus/4 | latch scan (`$FD30`/`$FF08`) | 2 mini-DIN ports | none | disk, tape | poll `$FF1C`/`$FF1D`; raster IRQ |
| BBC Micro | MOS INKEY (matrix under it) | analogue port, 2 buttons | AMX (user port) | DFS/ADFS disks, tape; Master CMOS 50 bytes | OSBYTE `&13` (vsync) |
| Oric | matrix through the AY + VIA | none built in (add-on boards) | none | tape, Microdisc/Jasmin | none visible to the CPU; VIA timer or the CB1 hack |
| Atari 5200 | none (keypad) | analogue sticks + keypad | none | none | poll VCOUNT; BIOS VBI rewrites colours unless NMIEN is cleared |
| Lynx | none | joypad + 2 options + pause | none | EEPROM on some carts *to verify*; none under BLL | timer 2 (VBL) IRQ; frame rate is program-set |
| PC Engine | none | 2-button pads, up to 5; mouse exists | PC Engine mouse | BRAM 2 KB on CD units; none on HuCard | VDC vblank IRQ; SATB DMA then |
| Supervision | none | 1 pad | none | none (`/WR` unused) | none: NMI at 61 Hz is not the LCD's 50.8 Hz |
| Atari 2600 | none | 2 sticks, paddles, driving | none | none | the program *is* the frame; RIOT timers |
| Game Boy | none | 1 pad | none | battery SRAM on MBC profiles (8–128 K), RTC on MBC3 | VBlank interrupt; 10 lines of vblank |
| ZX Spectrum | matrix via port `$FE` | Kempston (port `$1F`), Sinclair (key rows) | Kempston mouse add-on (*ports to verify*) | tape; +3 disk; 128K RAM disk (volatile) | one ULA interrupt per frame |
| MSX 1 / 2 | matrix via the PPI | 2 ports (MSX1: 1 or 2) | MSX mouse in a port (*protocol to verify*) | disk, tape, cartridge SRAM (some, *to verify*) | VDP interrupt via the BIOS hook |
| Master System / Game Gear | none | 2 ports (GG: built in) | none | cartridge SRAM via the mapper | VDP frame interrupt |
| Amstrad CPC | matrix via PPI + AY | 2 sticks on the matrix lines | AMX mouse on the joystick port (*to verify*) | disk (664/6128), tape; none on a Plus cartridge | six 300 Hz interrupts a frame; VSYNC on PPI port B |
| ColecoVision | keypad only | 2 sticks + 12-key keypads | Roller Controller (*protocol to verify*) | none (a few carts carry EEPROM) | frame interrupt is the NMI |

