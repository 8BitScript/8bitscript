---
title: Roadmap
nav_order: 2
---

# Roadmap

This page is the order in which 8BitScript takes on target machines, and why
that order. It is a plan, not a status report: for what compiles today, see
[the compiler](compiler.md). The only targets that exist right now are `web`,
`vic20`, and `c64`.

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

Once that interface is stable, adding another machine that LLVM-MOS already
supports should be a matter of writing a platform package, not touching the
compiler. See [How a phase is judged](#how-a-phase-is-judged).

## Phase 1: the founding three

Targets: `web`, `vic20`, `c64`. This is 8BitScript 0.1.

The VIC-20 is the original hardware target. The C64 is close enough to it,
CPU-wise, that adding it forces the compiler to separate *the language* from
*the VIC-20's hardware* without throwing anything radically different at it.
Both run in VICE, as `xvic` and `x64sc`, sharing one emulator infrastructure
and one monitor for debugging. LLVM-MOS already provides `mos-vic20-clang` and
`mos-c64-clang`.

**Native reference machine: C64.** When native 8BitScript development tools
are written, this is where they live first. Conceptually:

- a character editor
- a tile and map editor
- a sprite editor
- a sound editor
- a memory inspector

The web versions of these can be much fancier. The native C64 versions are
dogfooding: real programs, written in 8BitScript, that have to work on the
hardware.

## Phase 2: the Commodore family

Add: `pet`, `c128`. That makes `web`, `vic20`, `pet`, `c64`, `c128`.

LLVM-MOS provides first-class VIC-20, PET, C64 and C128 targets, and VICE
covers all four. Neither the emulator stack nor the CPU family changes, which
is what makes this phase cheap.

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

`atari8` covers the Atari 400, 800, XL, XE and XEGS-style environments.
LLVM-MOS supports Atari 8-bit DOS executables plus standard, XEGS and MegaCart
cartridge formats. Its NES support already includes several mapper targets,
among them NROM, UNROM, MMC1 and MMC3.

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
same shape `--profile` already gives `atari8`, `vic20`, and `c64` in
`packages/backend-6502`, just not yet extended to `nes`, which is hardcoded
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
`@8bitscript/screen` (`screen.setColors(border, background)` and the shared
colour names) and `@8bitscript/text` (`text.putChar`/`putColor`/`showDigit`
and `CellCount`, one flat cell index for now). Each is a machine-keyed
manifest delegating to the target package's own implementation —
`@8bitscript/nes/screen`, `@8bitscript/c64/text` — so the per-machine code
stays in the machine's package, beside the registers it is built on, and
`@8bitscript/nes` itself is the raw hardware underneath. `input` and
`sprites` follow the same shape when they arrive.

## Phase 4: the super-6502 machines

Add: `commander-x16`, `mega65`.

These are modern machines built in the classic 8-bit style, and LLVM-MOS
supports both directly. The Commander X16 is especially attractive: a 65C02,
modern storage, and substantially richer graphics and audio hardware. cc65 also
has a mature X16 target with dedicated hardware access, graphics, joystick,
mouse and extended-memory support, which is a useful reference.

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

These machines are attractive but less frictionless on the LLVM-MOS path than
the earlier phases. cc65 officially supports the Apple II, BBC Micro, C16,
Plus/4 and Oric Atmos, among many others.

The Apple II is here rather than in Phase 2 or 3 for a technical reason, not a
philosophical one. As of September 2026, the LLVM-MOS SDK's Apple II ProDOS
target is an open pull request under active development, not part of its
supported-platform list. The options are to wait for that target to mature,
contribute to it, write our own platform layer, or eventually support a second
native backend such as cc65. None of that needs to complicate 8BitScript 0.1.

## Phase 6: specialist consoles

Add: `atari5200`, `lynx`, `pcengine`, `supervision`.

LLVM-MOS has explicit targets for all four. Each stretches the language in a
new direction:

- **Atari 5200.** Familiar 6502 and Atari heritage.
- **Lynx.** A 65SC02-style CPU with considerably more specialised graphics
  hardware.
- **PC Engine / TurboGrafx-16.** The HuC6280, another 6502-family descendant,
  but significantly more sophisticated. LLVM-MOS supports both the standard
  PC Engine and PC Engine CD targets.

The PC Engine in particular is a test of whether the backend architecture
scales.

## Phase 7: the Atari 2600

Add: `atari2600`.

LLVM-MOS already supports it, and it is deliberately left late. Not because the
CPU is hard: the 6507 is a close 6502 relative. Because the machine is
gloriously deranged. Its programming model stresses:

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

Either one requires a genuinely new backend:

```
8BitScript IR
    |
    +-- MOS backend
    |     +-- LLVM-MOS
    |
    +-- Z80 / Game Boy backend
```

This is exactly why LLVM-MOS concepts must not leak into the language's IR.
The IR belongs to 8BitScript. LLVM-MOS is one backend.

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

The native development tools are part of the roadmap, not a side project. Each
new reference machine gets the tools ported and enhanced:

```
C64
 |
 v
native development tools v1
 |
C128
 |
 v
port and enhance the tools
 |
Commander X16
 |
 v
port and enhance the tools
 |
MEGA65
 |
 v
the deluxe edition
```

This gives every phase something real to build. The tools become increasingly
demanding real-world test suites for 8BitScript, and the small games prove the
portable game APIs. That feedback loop is what the project needs, and it beats
six months of staring at compiler unit tests.
