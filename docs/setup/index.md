---
title: Setup
nav_order: 1
---

# Setup

This guide gets a machine ready to build 8BitScript for both the web and the
VIC-20. Work through the pages in order; the last one checks that everything is
wired up correctly.

## Supported hosts

macOS and Linux are the only supported hosts at present. Windows is not
supported — WSL may work, but it is untested and unsupported.

## Dependencies

| Dependency    | Version  | Purpose                                                        |
| ------------- | -------- | -------------------------------------------------------------- |
| Node.js       | 26       | Runs the compiler, the tooling, and the web build              |
| pnpm          | 12       | Package manager and workspace runner for the repository        |
| LLVM-MOS SDK  | current  | Compiles and links the 6502 backend output into a `.prg`       |
| VICE          | 3.10     | Emulates the VIC-20 for running and debugging Commodore builds |

Check what you already have:

```bash
node --version
pnpm --version
```

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
3. [VICE](vice.md) — install VICE 3.10, point it at the VIC-20 ROMs, and verify
   the emulator starts.
4. [Verify](verify.md) — confirm the host and retro toolchains are both working.
