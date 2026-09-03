---
title: Setup
nav_order: 1
---

# Setup

This guide gets a machine ready to build 8BitScript for its full target list:
the web, VIC-20, C64, PET, C128, Atari 8-bit, NES, Commander X16, and MEGA65.
Work through the pages in order; the last one checks that everything is
wired up correctly. If only some of those targets matter to you, `8bs doctor`
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
| LLVM-MOS SDK  | current  | Compiles and links every 6502 target's output                     |
| VICE          | 3.10     | Emulates the VIC-20, C64, PET, and C128                           |
| atari800      | any      | Emulates the Atari 8-bit family                                   |
| FCEUX         | any      | Emulates the NES                                                  |
| x16emu        | any      | Emulates the Commander X16 (built from source — no package yet)   |
| Xemu          | any      | Emulates the MEGA65, via its `xmega65` core (built from source)   |

Check what you already have:

```bash
node --version
pnpm --version
```

Or run `8bs doctor` once the CLI is installed — it checks every row in this
table against what each target actually needs, and offers to install
whatever's missing that it knows how to (see [Verify](verify.md)).

### On cc65

cc65 is deliberately **not** part of the toolchain. All 6502 code generation
goes through LLVM-MOS, which shares an optimiser and object format with the rest
of the pipeline. Installing cc65 is unnecessary and its tools are never invoked.

## Pages in this guide

The guide is organized into the following pages:

1. [Host toolchain](host-toolchain.md) — install Node 26 and pnpm 12, and
   verify both respond on the command line.
2. [LLVM-MOS SDK](llvm-mos.md) — install the SDK and configure it for this
   project, without adding its tools to the global `PATH`.
3. [VICE](vice.md) — install VICE 3.10 for the VIC-20/C64/PET/C128 targets,
   point it at the ROMs, and verify the emulators start.
4. [Atari 8-bit](atari8.md) — install atari800.
5. [NES](nes.md) — install FCEUX.
6. [Commander X16](cx16.md) — build x16emu from source.
7. [MEGA65](mega65.md) — build Xemu from source.
8. [Verify](verify.md) — confirm the host and retro toolchains are both working.
