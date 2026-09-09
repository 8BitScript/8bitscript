---
title: Setup
nav_order: 1
---

# Setup

This guide gets a machine ready to *run* 8BitScript on its full target list
once the native backends emit: the web, VIC-20, C64, PET, C128, Atari 8-bit,
NES, Commander X16, and MEGA65. Setup is emulators only — there is no
external 6502 SDK. Until 0.2.0, `8bs build` refuses every target even when
every row below is installed. Work through the pages in order; the last one
checks that the emulators are wired up correctly. If only some of those
targets matter to you, `8bs doctor`
(covered on the [Verify](verify.md) page) reports readiness per target, so
skipping an emulator you don't need yet is fine — the rest of the toolchain
doesn't depend on it.

## Supported hosts

macOS and Linux are the only supported hosts at present. Windows is not
supported — WSL may work, but it is untested and unsupported.

## Dependencies

| Dependency    | Version  | Purpose                                                          |
| ------------- | -------- | ----------------------------------------------------------------- |
| Node.js       | 26       | Runs the compiler, the tooling, and the web build                 |
| pnpm          | 12       | Package manager and workspace runner for the repository           |
| VICE          | 3.10     | Emulates the VIC-20, C64, PET, and C128                           |
| atari800      | any      | Emulates the Atari 8-bit family                                   |
| FCEUX         | any      | Emulates the NES                                                  |
| x16emu        | any      | Emulates the Commander X16 (`8bs setup cx16` builds it + its ROM) |
| Xemu          | any      | Emulates the MEGA65, via `xmega65` (`8bs setup mega65` builds it) |

Check what you already have:

```bash
node --version
pnpm --version
```

Or run `8bs doctor` once the CLI is installed — it checks every row in this
table against what each target actually needs, and offers to install
whatever's missing that it knows how to (see [Verify](verify.md)).

### On cc65

cc65 is deliberately **not** part of the toolchain. 6502 code generation is
the compiler's own backend; installing cc65 to compile 8BitScript programs is
unnecessary and its tools are never invoked for that.

## Pages in this guide

The guide is organized into the following pages:

1. [Host toolchain](host-toolchain.md) — install Node 26 and pnpm 12, and
   verify both respond on the command line.
2. [VICE](vice.md) — install VICE 3.10 for the VIC-20/C64/PET/C128 targets,
   point it at the ROMs, and verify the emulators start.
3. [Atari 8-bit](atari8.md) — install atari800.
4. [NES](nes.md) — install FCEUX.
5. [Commander X16](cx16.md) — `8bs setup cx16` builds x16emu and a matching ROM from source.
6. [MEGA65](mega65.md) — `8bs setup mega65 --rom <path>` builds Xemu from
   source and installs your MEGA65 ROM (macOS and Arch/Manjaro).
7. [Verify](verify.md) — confirm the host toolchain and emulators are both working.
