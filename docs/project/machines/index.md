---
title: Machines on the roadmap
nav_order: 90
---

# Machines on the roadmap

Research notes for the machines [the roadmap](../../roadmap.md) names but
the toolchain does not build yet. Each page answers the same sixteen
questions the target packages' `AGENTS.md` files answer for the nine
machines that exist — CPU, memory and banking, the display's native unit,
the text grid, modes and colour, layers, sprites, pseudo-pixels, audio,
input, storage, timing, hardware variants, emulator, backend status, and
the traps — so that [the systems page](../../systems.md)'s matrix can
compare a machine that exists with one that does not, row for row.

These notes predate 0.2.0 and cite LLVM-MOS platform support; under the
native backend the question is a CPU-variant row plus a crt0 and file
writer per machine.

These pages are research, not status. They were written a few hours
before the hardware catalogs arrived, so where a page proposes an
`<X>_PROFILES` table in a backend, read it as the machine
package's `"8bitscript".hardware` catalog — options and values with what
each changes, resolved by `packages/cli/src/hardware.mjs` — which is the
one mechanism every existing target now uses (see
[systems](../../systems.md#three-axes-not-one)); the *axes* each page
identifies (a model, a medium, a mapper) are what become its options. Nothing on them compiles; a claim
read in a primary source names the source, and a claim the author could
not confirm is marked *to verify*. When a machine's turn comes, its page
becomes the first draft of `packages/<machine>/AGENTS.md`, and the
verification happens against the installed toolchain and emulator then.

| Phase | Machine | Page |
| ----- | ------- | ---- |
| 5 | Apple II family | [apple2.md](apple2.md) |
| 5 | Commodore Plus/4, C16, C116 | [plus4.md](plus4.md) |
| 5 | BBC Micro | [bbc-micro.md](bbc-micro.md) |
| 5 | Oric-1 / Atmos | [oric.md](oric.md) |
| 6 | Atari 5200 | [atari5200.md](atari5200.md) |
| 6 | Atari Lynx | [lynx.md](lynx.md) |
| 6 | PC Engine / TurboGrafx-16 | [pcengine.md](pcengine.md) |
| 6 | Watara Supervision | [supervision.md](supervision.md) |
| 7 | Atari 2600 | [atari2600.md](atari2600.md) |
| 8 | Game Boy / Game Boy Color | [gameboy.md](gameboy.md) |
| 8 | The Z80 family: ZX Spectrum, MSX, Master System / Game Gear, Amstrad CPC, ColecoVision | [z80-family.md](z80-family.md) |
