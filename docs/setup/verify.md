---
title: Verify your setup
nav_order: 9
---

# Verify your setup

This is the last page of the setup guide. Everything here is a check, not an
install — if a command fails, the fix lives on the page that installed the tool.

The project now has more targets than are worth checking by hand one at a
time — see [What each answer should look like](#what-each-answer-should-look-like)
below for the manual version of just two of them (VIC-20 and C64, the
original targets), and [This checklist is automated](#this-checklist-is-automated)
for the command that checks every target, including the newer ones.

Run the illustrative checklist in one go:

```bash
node --version
pnpm --version
git --version
xvic --version
x64sc --version
"$LLVM_MOS_HOME/bin/mos-vic20-clang" --version
"$LLVM_MOS_HOME/bin/mos-c64-clang" --version
```

Seven commands, seven answers. If every one of them prints a version, the host
toolchain and the retro toolchain are both in place.

## What each answer should look like

| Command | Expected output | If it fails |
| ------- | --------------- | ----------- |
| `node --version` | `v26.x.x` | [Host toolchain](host-toolchain.md) |
| `pnpm --version` | `12.x.x` | [Host toolchain](host-toolchain.md) |
| `git --version` | 2.30 or newer | [Host toolchain](host-toolchain.md) |
| `xvic --version` | VICE 3.10 | [VICE](vice.md) |
| `x64sc --version` | VICE 3.10 | [VICE](vice.md) |
| `"$LLVM_MOS_HOME/bin/mos-vic20-clang" --version` | A clang banner identifying an LLVM-MOS build | [LLVM-MOS SDK](llvm-mos.md) |
| `"$LLVM_MOS_HOME/bin/mos-c64-clang" --version` | A clang banner identifying an LLVM-MOS build | [LLVM-MOS SDK](llvm-mos.md) |

Two failure shapes are worth naming, because their cause is not in the error
text. If both `mos-*-clang` commands fail with "no such file or directory", the
problem is almost certainly `LLVM_MOS_HOME` rather than the SDK itself — check
`echo "$LLVM_MOS_HOME"` and `ls "$LLVM_MOS_HOME/bin"`. And a passing
`xvic --version` does not prove VICE works; on Debian and its derivatives the
emulator can report a version and still be unable to boot for want of ROMs, so
run the boot check on the [VICE](vice.md) page as well.

## This checklist is automated

`8bs doctor` runs this entire checklist for you — every version check above,
each one reported against what the project actually requires rather than left
for you to eyeball:

```bash
pnpm run doctor
```

It groups the results by target, so "ready for the web target" and "ready for
the VIC-20" are separate answers, and every failure points at the setup page
that installs the missing tool.

It also covers the check this page cannot express as a one-line command: it
launches `xvic` for a bounded number of emulated cycles and confirms it reaches
a running machine, rather than trusting that a binary which prints a version
can boot one. A ROM-less VICE — the Debian trap described on the
[VICE](vice.md) page — fails this check with the reason, not a version number.

The checklist above stays useful for fixing what the doctor finds: each row
names the page that installs the tool.

## Screenshots

An agent (or a script) working on a program often needs to see what it's
actually drawing, without a human at the keyboard and without reaching for a
general-purpose "grab my screen" tool. `8bs run <target> --screenshot
<file.png>` builds the program and captures one PNG of the result through
whichever mechanism that target's own emulator exposes for exactly this,
instead of opening an interactive window:

```bash
8bs run c64 --screenshot out.png
```

`--frames` controls how long the program runs before the capture — but it
counts a different unit on every target, because what's actually being
counted is genuinely different hardware (the same reasoning
[`AGENTS.md`](../../AGENTS.md) gives for why "8 sprites" doesn't mean one
thing across machines). Omit it for a default this project tested against
`examples/borders` until the machine's own boot sequence had clearly
cleared:

| Target(s) | Mechanism | `--frames` counts | Default |
| --------- | --------- | ------------------ | ------- |
| vic20, c64, pet, c128 | VICE's `-limitcycles` + `-exitscreenshot` (c128: `-exitscreenshotvicii`, since x128 drives a second, unused VDC display — see run.mjs) | converted to CPU cycles at the machine's real NTSC/PAL clock | a cycle count measured per machine (vic20 needs nearly 3x c64/c128's despite an identical clock — observed, not explained) |
| atari8 | atari800 has no exit-and-screenshot flag; this launches it windowed and asks **macOS** to capture that one window's real pixels (Screen Recording permission, no synthetic keystrokes) | wall-clock seconds | ~4s |
| cx16 | x16emu's `-gif` recording, read back with `ffmpeg` for a still of the last frame | wall-clock seconds | ~5s |
| mega65 | Xemu's own `-screenshot <file>` (fires on a plain `SIGTERM`, not just a clean quit) | wall-clock seconds | ~8s |
| nes | a small FCEUX Lua script: `emu.frameadvance()` in a loop, then `gui.savescreenshotas()` | exact emulated frames | 120 |
| web | Node's own WebAssembly runtime calls `frame()` directly — no emulator, no timing guesswork, the only target with a frame-exact and OS-independent capture | exact `frame()` calls | 180 |

Every mechanism above is the target's own emulator API — a version of what
[`packages/cli/test/emulator-smoke.test.mjs`](../../packages/cli/test/emulator-smoke.test.mjs)
already uses to prove a build boots, pointed at a real output file instead
of a throwaway one. **atari8 is the one exception**: atari800 has no
CLI or scriptable way this project found to trigger its own screenshot
feature (a host keypress only), so that target alone falls back to asking
the operating system to capture the window — macOS only for now, and it
needs Screen Recording permission granted to whatever process runs `8bs`
(System Settings → Privacy & Security → Screen Recording). No target here
ever needs synthetic keyboard/mouse input.

Setup is complete. Return to the [setup overview](index.md) for the guide's
contents, or to the [documentation index](../index.md).
