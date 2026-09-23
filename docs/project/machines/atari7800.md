---
title: Atari 7800
nav_order: 21
---

# Writing Atari 7800 support for 8BitScript

This file is for anyone — human or agent — adding the `atari7800`
target (roadmap phase 6). Nothing here builds. Read
[`docs/roadmap.md`](../../roadmap.md) and the root `AGENTS.md` first.
[`packages/atari8/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/atari8/AGENTS.md)
is the nearest 6502 package; the 7800 does not share that video chip.

> **A 6502 instruction set, and a graphics chip no package speaks yet.
> MARIA is the whole of the new work. TIA sound is the 2600's audio
> chip sitting beside it.**

The reach sheet already measured this machine
(`packages/cli/data/reach.json`, id `atari7800`) and, until this note,
left it `unplanned`. The roadmap now puts it in phase 6. The `cpu`
string on that row, written 2026-09-20, reads: SALLY (custom 6502C) at
1.79 MHz NTSC / 1.77 MHz PAL; MARIA graphics; TIA sound, with POKEY or
YM2151 optional in the cartridge; 4 KB RAM. This note does not re-verify
that string. Years on the same row cite
[Wikipedia's Atari 7800 article](https://en.wikipedia.org/wiki/Atari_7800).

MARIA's registers live in Atari's
[`BASE78/MARIA.S`](https://github.com/OpenSourcedGames/Atari-7800/blob/master/BASE78/MARIA.S).
They have not been read into this note. Sprite width, the line-RAM
budget, the holey DMA, and the difference between a 160-pixel and a
320-pixel mode are *to verify* against that file and the Maria
specification before a package is written.

## What exists today

Nothing in this repository. No `packages/atari7800`, no profile, no
`8bs run`, no setup page.

## The sixteen questions

CPU class is the sentence above. Memory and banking, the display's
native unit, the text grid, modes and color, layers, sprites,
pseudo-pixels, audio, input, storage, timing, hardware variants, the
emulator, and the traps are not researched here. The reach row has
audience figures; it is not a hardware note.

## Where things live

```
docs/roadmap.md                          Phase 6: why a 6502C with MARIA is its own target
packages/cli/data/reach.json             atari7800: the 2026-09-20 audience row, now status roadmap
BASE78/MARIA.S                           the register file to read before any package
```
