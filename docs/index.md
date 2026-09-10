---
title: 8BitScript
nav_order: 0
---

# 8BitScript

8BitScript is a statically compiled, TypeScript-flavored language for
classic 8-bit computers and the web.

**The PET and the web both build, run, and render for real.** Version 0.2.0
replaces the external toolchains (LLVM-MOS for the 6502 machines, `asc` for
the web) with 8BitScript's own code generators, assembler, linker, and file
writers, and both backends that ship in this release now emit: `8bs build`
and `8bs run` work end to end for `pet` and `web`.

**0.2.0 targets the Commodore PET and the web only.** The other seven
machine packages (`vic20`, `c64`, `c128`, `atari8`, `nes`, `cx16`, `mega65`)
stay in the workspace exactly as they are — sources, tests, `AGENTS.md`,
all still there — marked parked and refused by name (`RELEASE_MACHINES` in
the compiler's resolver). They return one at a time, in the phase order
below, in a later release.

## Phase plan

8BitScript takes on machines in phases, each one forcing the language to
survive a hardware constraint the previous phase didn't have. Nine machine
packages exist today, covering phases 1 through 4:

| Phase | Machines | Package(s) |
| ----- | -------- | ---------- |
| 1 | Web, VIC-20, C64 | `web` `vic20` `c64` |
| 2 | Commodore PET, C128 | `pet` `c128` |
| 3 | Atari 8-bit, NES | `atari8` `nes` |
| 4 | Commander X16, MEGA65 | `cx16` `mega65` |

0.2.0 brought the PET forward ahead of the rest of Phase 1 so the native
backend proved itself on one screen-is-plain-RAM machine before the
video-chip machines arrive. Five more phases are named but have no
package yet — their hardware research is [Machines on the
roadmap](project/machines/index.md), phases 5 through 8.

The documentation that used to live here described the old pipeline. It has
been removed rather than rewritten against a plan. Each page returns when
the code it describes exists.

## The working document

The roadmap that got the first program — `Hello World!` on a Commodore
PET, and again in a browser — actually booting, and the interim reference
for every `8bs` command, is the working document titled **Hello, PET**:

<https://claude.ai/code/artifact/ada33539-fa98-46a7-a9a1-36532c8a2164>

The architecture behind it is the plan titled **Bare Metal**:

<https://claude.ai/code/artifact/98aec519-9820-497c-9556-c02d4f94c478>

## What works today

| Command | Status |
| ------- | ------ |
| `8bs check <files...>` | works: reports diagnostics from the front end |
| `8bs targets [--json]` | works: lists every target and its hardware catalog |
| `8bs doctor` | works: checks Node, pnpm, git, and the emulators; no compiler check |
| `8bs setup <mega65\|cx16>` | works: builds an emulator and installs a ROM |
| `8bs lsp` | works: the language server on stdio |
| `8bs build --target <t>` | works for `pet` and `web`, real output; the seven parked machines are refused by name |
| `8bs run <t>` | works for `pet` and `web`, boots the real build in an emulator or a browser tab; same refusal as `build` for the rest |
| `8bs dev` | planned |

## Still on this site

[Machines on the roadmap](project/machines/index.md) — hardware research
notes for the phase 5 through 8 machines, the ones the phase plan above
names but no package exists for yet. They describe hardware, not the
toolchain, and are unchanged by the rewrite.
