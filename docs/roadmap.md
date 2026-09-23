---
title: Roadmap
nav_order: 1
---

# Roadmap

This page is the order in which 8BitScript takes on target machines, and
why. It is a plan. What compiles today is [the home page](index.md):
release 0.11.0 builds for nine targets — `pet`, `vic20`, `c64`, `c128`,
`cx16`, `mega65`, `atari8`, `nes`, and `web`.

Phases are not releases. They are the order the work happens in. Phases
1–4 are the nine machines that build. Phases 5–10 have no package, no
image, and no `8bs run`.

## The phases at a glance

| Phase | Targets | State |
| ----- | ------- | ----- |
| 1 | `web`, `vic20`, `c64` | builds |
| 2 | `pet`, `c128` | builds |
| 3 | `atari8`, `nes` | builds |
| 4 | `cx16`, `mega65` | builds |
| 5 | `apple2`, `plus4`, `bbc`, `oric` | not built |
| 6 | `atari5200`, `atari7800`, `lynx`, `pcengine`, `supervision` | not built |
| 7 | `atari2600` | not built |
| 8 | `gameboy`, `gameboycolor`, then the Z80 machines | not built |
| 9 | `coco`, `vectrex` | not built |
| 10 | `odyssey2`, `channelf` | not built |

The Z80 machines in phase 8 are `sms`, `gamegear`, `sg1000`,
`zxspectrum`, `msx` (MSX1), `cpc`, and `coleco`. Research for everything
that does not build yet is under
[machines on the roadmap](project/machines/index.md).

## What counts as a target

8BitScript targets a machine whose processor architecture is 8-bit.
The generation a console was sold in, and the word on the box, do not
decide it.

The PC Engine / TurboGrafx-16 stays in phase 6. Its HuC6280 is a 65C02
core with an MMU and a handful of extra instructions
([pcengine.md](project/machines/pcengine.md)). That is an 8-bit CPU
with a wider address space. Adding it is a variant of the MOS backend.
Those extra instructions are not lowered today.

The Intellivision is not a target. Its GI CP1610 has eight 16-bit
registers (R0–R7, R7 the program counter), 16-bit addresses, 10-bit
instruction words, and a sign flag taken from bit 15 of the result
([CP1610](https://wiki.intellivision.us/index.php/CP1610), read
2026-09-22). A 16-bit operand is two 8-bit memory accesses when the
double-byte flag is set; the registers and the ALU width are still 16
bits. That is a different backend, and it is outside this list.

The machines in the table are the list. Another platform is added only
when it brings a constraint none of these already forces — a new kind
of hardware limit, not another member of a family already named.

## Phase 1: the founding three

`web`, `vic20`, `c64`. These build.

The VIC-20 is the original hardware target. The C64 is close enough,
CPU-wise, that adding it separated the language from the VIC-20's
hardware. An unexpanded VIC-20 has a little over 5K; a C64 has 64K of
the same RAM the video chip reads. Both run in VICE. See
[`packages/vic20/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/vic20/AGENTS.md)
and
[`packages/c64/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/c64/AGENTS.md).

## Phase 2: the Commodore family

`pet`, `c128`. These build.

The PET is the least console-like machine in the list. Text, utilities,
and menus have to be natural in the language, or 8BitScript is only a
game language. The C128 is banked memory, the 8502, and an 80-column
display behind a two-byte port — the first real test of the memory
model. See
[`packages/pet/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/pet/AGENTS.md)
and
[`packages/c128/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/c128/AGENTS.md).

## Phase 3: prove it is not CommodoreScript

`atari8`, `nes`. These build.

ANTIC, GTIA, and POKEY are not a VIC-II, and the NES PPU is not either.
The NES limit that matters is eight sprites on one scanline, not the
sixty-four entries in OAM, and the cartridge mapper is a hardware
option. See
[`packages/atari8/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/atari8/AGENTS.md)
and
[`packages/nes/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/nes/AGENTS.md).

## Phase 4: the super-6502 machines

`cx16`, `mega65`. These build.

The Commander X16 is a 65C02 whose graphics, RAM, and storage sit behind
windows, ports, and firmware. The MEGA65 is a C64 in name only: 40.5
MHz, 80 columns, 384K, four SIDs. See
[`packages/cx16/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/cx16/AGENTS.md)
and
[`packages/mega65/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/mega65/AGENTS.md).

## Phase 5: broaden classic 6502 coverage

Add: `apple2`, `plus4` (also the C16 and C116), `bbc`, `oric`.

These four do not share a video chip, an I/O family, or a memory map
with each other or with anything already in the toolchain. An Apple II
is soft-switches and hires pages; a Plus/4 is a TED; a BBC Micro is a
6845; an Oric is a 6502 with its own ULA. Each needs a CPU-variant row,
a start-up stub, and a file writer. The research is in
[machines on the roadmap](project/machines/index.md). None of it builds.

## Phase 6: specialist consoles

Add: `atari5200`, `atari7800`, `lynx`, `pcengine`, `supervision`.

Each is still a 6502-family CPU, with video and I/O that share no
family with the machines already supported:

- **Atari 5200.** The 400's chips, no keyboard, a different cartridge
  map.
- **Atari 7800.** A 6502 instruction set, and MARIA, which no current
  package speaks. MARIA is the reason the 7800 is its own target. The
  reach sheet had it as unplanned; it is phase 6 now. See
  [atari7800.md](project/machines/atari7800.md).
- **Lynx.** A 65SC02-style CPU and a handheld display.
- **PC Engine / TurboGrafx-16.** The HuC6280, a 65C02 with block moves
  and VDC-port instructions. HuCard and CD-ROM² are different images.
  This is a test of whether the backend architecture scales.
- **Watara Supervision.** A handheld 6502 with its own LCD.

## Phase 7: the Atari 2600

Add: `atari2600`.

The 6507 is a close relative of the 6502. The machine is the torture
test: cycle-exact kernels, 128 bytes of RAM, and a picture that exists
only because the program writes it one scanline at a time. If a serious
2600 game can be written in 8BitScript without fighting the language,
the language has kept its promise.

## Phase 8: the SM83 and the Z80

Add `gameboy` and `gameboycolor` first, then one Z80 backend for seven
machines.

`gameboycolor` is its own target. Double speed, the second VRAM bank,
banked WRAM, and the Color palettes are facts of that machine. They are
not a hardware option on `gameboy`. Both targets share one SM83
lowering. See [gameboy.md](project/machines/gameboy.md).

The Z80 machines, one CPU and several video chips:

| Targets | What they share |
| ------- | --------------- |
| `sms`, `gamegear` | The Sega VDP. The Game Gear is a Master System with a smaller window, a Start button, and stereo. These two share the most implementation of anything in the phase. |
| `sg1000`, `msx`, `coleco` | A TMS9918-family VDP. `msx` is MSX1. MSX2's V9938 is a different video chip and is not a further target. The SG-1000 is not a Master System. |
| `zxspectrum` | A bitmap and an attribute grid. No sprites. |
| `cpc` | A packed-pixel bitmap on a 6845. No sprites on the original Gate Array. |

See [z80-family.md](project/machines/z80-family.md). The Game Boy is not
in that file: the SM83 has no `IN`/`OUT`.

```
8BitScript IR
    |
    +-- MOS backend (the 6502 family, including phase 6)
    |
    +-- SM83 backend (gameboy, gameboycolor)
    |
    +-- Z80 backend (the seven machines above)
```

## Phase 9: the 6809

Add: `coco`, `vectrex`.

One new CPU backend, then two machines that share almost nothing past
the CPU. The Color Computer is a raster computer (6847 on the CoCo 1
and 2, GIME on the CoCo 3). The Vectrex draws vectors on its own
monitor. The 6809 is an 8-bit data path with 16-bit index registers —
the same class of machine as the 6502 — which is why this phase is in
and the Intellivision is not. See
[6809.md](project/machines/6809.md).

```
8BitScript IR
    |
    +-- 6809 backend (coco, vectrex)
```

## Phase 10: two CPUs with no family

Add: `odyssey2`, `channelf`.

These two do not share a CPU with each other or with anything above.

- **Odyssey² / Videopac** (`odyssey2`). An Intel 8048 microcontroller
  and an Intel 8244 (8245 on PAL) for picture and sound. See
  [odyssey2.md](project/machines/odyssey2.md).
- **Channel F** (`channelf`). A Fairchild F8, with 64 bytes of
  scratchpad RAM in the CPU. See
  [channelf.md](project/machines/channelf.md).

Each one is its own backend. They are last because nothing earlier
amortizes that cost.

## How a phase is judged

The metric is how much code it takes to add another machine of a CPU
the compiler already lowers.

A new 6502 machine should be a package — hardware catalog, start-up,
screen, input, a file writer — and then `8bs run` for that target
works. It should not be a change to half the compiler. A new CPU is the
exception, and phases 8, 9, and 10 are that exception: one backend, then
every machine that backend unlocks.

## Studio

Studio's reference machine is the Commander X16. The tiers, and what
each editor still has to prove, are in
[`packages/studio/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/studio/AGENTS.md).
