---
title: Machines on the roadmap
nav_order: 90
---

# Machines on the roadmap

Research notes that the packages were written from. Each page answers
the same sixteen questions the target packages' `AGENTS.md` files
answer — CPU, memory and banking, the display's native unit,
the text grid, modes and color, layers, sprites, pseudo-pixels, audio,
input, storage, timing, hardware variants, emulator, backend status, and
the traps — so that a systems matrix can
compare a machine that exists with one that does not, row for row.

These notes predate 0.2.0 and cite LLVM-MOS platform support; under the
native backend the question is a CPU-variant row plus a crt0 and file
writer per machine.

These pages are research that the packages were written from. Where a
page proposes an `<X>_PROFILES` table in a backend, read it as the
machine package's `"8bitscript".hardware` catalog — options and values
with what each changes, resolved by `packages/cli/src/hardware.mjs`.
A claim read in a primary source names the source, and a claim the
author could not confirm is marked *to verify*.

The machines measured on 2026-09-20 have a row in
[`../reach.md`](../reach.md) — units sold, community activity, routes
to a user and the formats each route takes. Ids on that sheet and in
`RELEASE_MACHINES` use RetroArch-style shorts where a product name is
a trademark (`gb`, `gbc`, `pce`, `spectrum`). Atari consoles keep the
full ids (`atari2600`, `atari5200`, `atari7800`).

The order, and the rule for what belongs on it, is
[`../../roadmap.md`](../../roadmap.md). The list there is closed: a
further machine needs a constraint none of these already forces.

| Phase | Machine | Page |
| ----- | ------- | ---- |
| 5 | Apple II family | [apple2.md](apple2.md) |
| 5 | Commodore Plus/4, C16, C116 | [plus4.md](plus4.md) |
| 5 | BBC Micro | [bbc-micro.md](bbc-micro.md) |
| 5 | Oric-1 / Atmos | [oric.md](oric.md) |
| 6 | Atari 5200 | [atari5200.md](atari5200.md) |
| 6 | Atari 7800 | [atari7800.md](atari7800.md) |
| 6 | Atari Lynx | [lynx.md](lynx.md) |
| 6 | PC Engine / TurboGrafx-16 | [pce.md](pce.md) |
| 6 | Watara Supervision | [supervision.md](supervision.md) |
| 7 | Atari 2600 | [atari2600.md](atari2600.md) |
| 8 | Game Boy | [gb.md](gb.md) |
| 8 | Game Boy Color | [gb.md](gb.md#game-boy-color) |
| 8 | The Z80 family: Master System, Game Gear, SG-1000, ZX Spectrum, MSX1, Amstrad CPC, ColecoVision | [z80-family.md](z80-family.md) |
| 9 | TRS-80 Color Computer and Vectrex (6809) | [6809.md](6809.md) |
| 10 | Magnavox Odyssey² / Philips Videopac | [odyssey2.md](odyssey2.md) |
| 10 | Fairchild Channel F | [channelf.md](channelf.md) |
