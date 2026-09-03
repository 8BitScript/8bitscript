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

Setup is complete. Return to the [setup overview](index.md) for the guide's
contents, or to the [documentation index](../index.md).
