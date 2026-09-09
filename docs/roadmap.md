---
title: Roadmap
nav_order: 2
---

# Roadmap

This page is the order in which 8BitScript takes on target machines, and why
that order. It is a plan, not a status report: for what compiles today, see
[the compiler](compiler.md). Nine machine packages exist — `web`, `vic20`,
`c64`, `pet`, `c128`, `atari8`, `nes`, `cx16`, and `mega65` — with the
two portable capabilities the [package model](packages.md) describes. A
program compiles through the front end and the linker for each. **No target
produces an image until 0.2.0.** How they are told apart, and how the rest
of the machines below will be, is [the systems page](systems.md).

## 0.2.0: Bare Metal

External toolchains are gone. Two backends live in `@8bitscript/compiler`
— `mos` (`@8bitscript/compiler/mos`) for the 6502 family, C64 first, and
`wasm` (`@8bitscript/compiler/wasm`) for the browser. They exist as
modules and they refuse: nothing generates opcodes or wasm, and no target
produces an image until those backends emit. The front end through the
linker still runs. That is the whole of 0.2.0: make both backends build,
starting with the C64.

The phases below are why the nine machine packages were added in this
order. The reason was never "a third-party SDK already had a driver." It
was hardware difficulty: each phase forces the language to survive a
constraint the previous machines did not have.

## The phases at a glance

| Phase | Targets | Goal |
| ----- | ------- | ---- |
| 0 | Web + 6502 simulator | Prove the compiler |
| 1 | VIC-20 + C64 + Web | Ship a usable 8BitScript (0.1) |
| 2 | PET + C128 | The Commodore family |
| 3 | Atari 8-bit + NES | Prove real portability |
| 4 | Commander X16 + MEGA65 | Powerful 65xx systems |
| 5 | Apple II + C16/Plus/4 + BBC Micro + Oric | Broaden the classics |
| 6 | Atari 5200 + Lynx + PC Engine + Supervision | Specialist platforms |
| 7 | Atari 2600 | Torture-test low-level control |
| 8 | Game Boy + Z80 family | First non-6502 backends |

Phases are not releases. They are the order the work happens in, and they are
expected to get shorter as the compiler and platform interface settle:

```
Phase 1   ####################
Phase 2   ######
Phase 3   #########
Phase 4   ######
```

Once that interface is stable, adding another 6502-family machine should be
a platform package, a start-up stub, and a file writer — not a change to
the compiler. See [How a phase is judged](#how-a-phase-is-judged).

## Phase 1: the founding three

Targets: `web`, `vic20`, `c64`. This is 8BitScript 0.1.

The VIC-20 is the original hardware target. The C64 is close enough to it,
CPU-wise, that adding it forces the compiler to separate *the language* from
*the VIC-20's hardware* without throwing anything radically different at it.
A VIC-20 unexpanded has a little over 5K total; a C64 has 64K of the same
RAM the video chip reads. If the language were the VIC-20's hardware, the
C64 would not compile. Both run in VICE, as `xvic` and `x64sc`, sharing one
emulator infrastructure and one monitor for debugging.

**Native tools.** The native 8BitScript development tools are
[Studio](studio.md), the app that ships with the toolchain. Conceptually:

- a character editor
- a tile and map editor
- a sprite editor
- a sound editor
- a memory inspector

Their reference machine is the Commander X16, not one of these three (see
[the tool strategy](#the-tool-strategy)); the C64 gets the full editor
sized to its hardware, and an expanded VIC-20 the basic tier. The web version can
be much fancier. The native versions are dogfooding: real programs, written
in 8BitScript, that have to work on the hardware.

## Phase 2: the Commodore family

Add: `pet`, `c128`. That makes `web`, `vic20`, `pet`, `c64`, `c128`.

VICE covers all four Commodore machines. Neither the emulator stack nor the
CPU family changes, which is what makes this phase cheap — the difficulty
is the machines, not a new toolchain.

**Why the PET matters.** It is the least game-console-like machine in the
list. It forces 8BitScript to prove it is a general 8-bit programming language
rather than a game language in disguise. Programs like this have to be
natural:

```
print("HELLO");
```

and so do command-line-style utilities, data programs, and menus.

**Why the C128 matters.** It brings more memory, banked memory, the 8502, a
much richer environment, 80-column output, and C64 compatibility. It is the
first real test of the memory model.

**Native reference machine becomes: C128.** The C64 map editor gets ported to
the C128 and grows: bigger maps, more memory, an 80-column UI. The C64 version
does not go away.

## Phase 3: prove it is not CommodoreScript

Add: `atari8`, `nes`.

`atari8` covers the Atari 400, 800, 1200XL, XL, XE and XEGS-style
environments, chosen with the catalog's `model` option; a second,
independent `media` axis covers DOS executables plus standard, XEGS and
MegaCart cartridges, fourteen values in all. NES support is NROM only
today — UNROM, MMC1 and MMC3 exist as hardware, not as wired-up builds.

```
             8BitScript
                  |
       +----------+----------+
       |          |          |
       v          v          v
   Commodore    Atari       NES
```

This is the phase that shows whether the architecture works, because the
video hardware becomes radically different while the language stays the same:

| Machine | Video | Sound | Other |
| ------- | ----- | ----- | ----- |
| C64 | VIC-II | SID | CIA |
| Atari 8-bit | ANTIC, GTIA | POKEY | |
| NES | PPU | APU | sprites, nametables, mappers |

Two of those "Other" entries are traps if taken at face value. "sprites"
undersells the real constraint: the NES's 64 OAM entries only matter in
relation to the *eight* the PPU can select for a single scanline — a scene
well under 64 sprites total can still overflow if too many of them share a
row, and a metasprite built from several hardware sprites has to be budgeted
against that per-scanline limit, not the frame total. "mappers" undersells
it the other way: cartridge hardware (NROM, UNROM, MMC1, MMC3, ...) changes
how much CHR/PRG memory a program can address and how it's banked, which
makes "the NES" a family of build profiles rather than one target — the
same shape `--profile` already gives `atari8`, `vic20`, `c64`, and `pet` in
`packages/compiler/src/mos`, just not yet extended to `nes`, which is hardcoded
to the plainest cartridge shape (NROM) today. See `packages/nes/AGENTS.md`
for the full set of NES-specific rules, and the root `AGENTS.md` for how
this generalizes to every target.

**This is where the capability system matters.** Instead of pretending every
machine has `screen.sprite(...)`, the standard library is split into
capabilities, and a program imports only the ones its target provides.
Conceptually:

```
import { input } from "8bit:input";
import { text } from "8bit:text";
```

on every machine, and

```
import { sprites } from "8bit:sprites";
```

only where sprites exist. Raw hardware stays available underneath:

```
import { PPU } from "8bit:nes";
import { VICII, SID } from "8bit:c64";
```

Portable when you want it. Metal when you want it.

The first two capabilities exist, spelled as the npm packages the
[package model](packages.md) resolves rather than a `8bit:` scheme:
`@8bitscript/screen` (`screen.blank(border, background)`, `setBorder`, `setBackground`, `setColors(border, background)` and the shared
colour names) and `@8bitscript/text` (`text.print` with template strings,
`printNumber`, a current colour via `setColor` and the `TextColor` names,
`putChar`/`putColor`, a current reverse via `setReverse`, and `CELL_COUNT`/`COLUMNS` — one flat cell index,
`y * text.COLUMNS + x`). Each is a machine-keyed
manifest delegating to the target package's own implementation —
`@8bitscript/nes/screen`, `@8bitscript/c64/text` — so the per-machine code
stays in the machine's package, beside the registers it is built on, and
`@8bitscript/nes` itself is the raw hardware underneath. `input` and
`sprites` follow the same shape when they arrive.

## Phase 4: the super-6502 machines

Add: `commander-x16`, `mega65`.

These are modern machines built in the classic 8-bit style. The Commander
X16 is a 65C02 with modern storage and substantially richer graphics and
audio hardware — and nearly all of it sits behind windows, ports, and
firmware. The MEGA65 is a C64 in name only: 40.5 MHz, 80 columns, 384K,
four SIDs. Modelling either as "a fast C64" is the trap this phase exists
to refuse.

The X16 is the mirror image of the NES trap in Phase 3. Where the NES has
almost nothing and forces abstraction, the X16 has a great deal — 128 KiB
of VRAM, 128 sprites, up to 2 MB of RAM, three sound engines — and nearly
all of it sits behind an 8 KiB bank window, VERA's indirect address/data
ports, write-only registers, a firmware API, or optional expansion
hardware. Modelling it as "a fast C64" produces bugs that look impossible
(a pointer into `$A000-$BFFF` means nothing without its bank; a border
colour that never appears because the active area fills the screen).
`packages/cx16/AGENTS.md` collects those rules, each checked against the
emulator and ROM sources at the revisions `8bs setup cx16` installs.

**Native reference machine becomes: Commander X16 first, then potentially
MEGA65.** The tile editor that started on the C64 and moved to the C128 moves
again. On the X16 it can have a much nicer interface, mouse support and larger
maps, and it is still written in 8BitScript.

## Phase 5: broaden classic 6502 coverage

Add: `apple2`, `plus4` (also covering the C16 and C116), `bbc-micro`, `oric`.

These four do not share a video chip, an I/O family, or a memory map with
each other or with anything already in the toolchain. An Apple II is
soft-switches and hires pages; a Plus/4 is a TED; a BBC Micro is a 6845
and a MOS tube; an Oric is a 6502 with its own ULA. There is no shared
Commodore-shaped platform to extend. Each needs a CPU-variant row, a
start-up stub, and a file writer of its own. The research for each of the
four is in [machines on the roadmap](project/machines/index.md). None of
that needs to complicate 8BitScript 0.1.

## Phase 6: specialist consoles

Add: `atari5200`, `lynx`, `pcengine`, `supervision`.

Each stretches the language in a new direction, still on a 6502-family
CPU, with video and I/O that share no family with the machines already
supported:

- **Atari 5200.** Familiar 6502 and Atari heritage, in a console with no
  keyboard and a different cartridge map.
- **Lynx.** A 65SC02-style CPU with considerably more specialised graphics
  hardware.
- **PC Engine / TurboGrafx-16.** The HuC6280, another 6502-family descendant,
  but significantly more sophisticated — HuCard and CD-ROM² are different
  images.

The PC Engine in particular is a test of whether the backend architecture
scales.

## Phase 7: the Atari 2600

Add: `atari2600`.

It is deliberately left late. Not because the CPU is hard: the 6507 is a
close 6502 relative. Because the machine is the torture test — gloriously
deranged. Its programming model stresses:

- exact cycle timing
- inline assembly
- interrupt-free timing loops
- hardware registers
- compile-time calculations
- memory placement
- ROM banking
- tiny RAM
- inspection of the generated assembly

If somebody can write a serious Atari 2600 game in 8BitScript without fighting
the language, the project has kept its promise: 8BitScript does not put a
ceiling over native 6502 programming. Treat the 2600 as the language's torture
test.

## Phase 8: another CPU family

Add: `gameboy`, then `z80`.

Only after the 65xx architecture is solid does 8BitScript expand beyond it.
This is where it becomes truly 8-bit rather than 6502Script. Z80 opens up the
ZX Spectrum, MSX, Sega Master System, Game Gear, Amstrad CPC and ColecoVision.
The Game Boy's LR35902 is closely related to the Intel 8080 and Z80 world but
is its own beast.

Either one requires a genuinely new backend — a second CPU, not a second
file writer:

```
8BitScript IR
    |
    +-- MOS backend (8BitScript's own, in @8bitscript/compiler/mos)
    |
    +-- Z80 / Game Boy backend
```

This is exactly why 6502-only concepts must not leak into the language's
IR. The IR belongs to 8BitScript. The MOS backend is one lowering of it.

## How a phase is judged

The metric for the architecture is: **how much code does it take to add
another machine?**

If adding the PET means changing half the compiler, the design is wrong. If it
looks like this:

```
platforms/pet/
+-- platform.8bs
+-- memory.8bs
+-- screen.8bs
+-- input.8bs
+-- runtime.s
+-- target.json
```

and then `8bs run pet` works, the design is right.

## The tool strategy

The native development tools are [Studio](studio.md) — `@8bitscript/studio`,
an ordinary 8BitScript program that ships with the toolchain, at the
toolchain's version — and they are part of the roadmap, not a side project.
Studio's reference machine is the **Commander X16**: it has the most room
and a keyboard and storage out of the box, so the full editor is designed
there, and every other machine runs the same program at the tier its
hardware supports. A higher tier opens everything a lower one made.

```
Commander X16
 |
 v
Studio: the full editor
 |
 +--> MEGA65, C128, C64, Atari 8-bit: the full editor, sized to the machine
 |
 +--> VIC-20 with 8K or more: characters and music edit, sprites view
 |
 +--> PET, stock VIC-20, NES, web: the viewer — look, listen, load
```

The tiers, and what each one still has to prove on its hardware, are in
[`packages/studio/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/studio/AGENTS.md).
Each editor waits on a language capability — input first, then character
and sprite access, sound, and storage — so Studio sets the order those
arrive in. This gives every phase something real to build. The tools become increasingly
demanding real-world test suites for 8BitScript, and the small games prove the
portable game APIs. That feedback loop is what the project needs, and it beats
six months of staring at compiler unit tests.
