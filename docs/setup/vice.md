---
title: VICE
nav_order: 4
---

# VICE

VICE is the emulator 8BitScript targets for development. One suite covers every
Commodore machine that matters here: `xvic` emulates the VIC-20 and `x64sc`
emulates the C64, so a single install serves both the primary target and the
second one. Installing two unrelated emulators to cover two machines would mean
two sets of quirks, two configuration formats, and two things to keep working.

VICE also has the debugging story this project needs. It ships a built-in
monitor — breakpoints, memory inspection, single-stepping, disassembly — usable
from the emulator window without any extra tooling. More importantly, it exposes
that monitor over a socket, as both a text remote monitor and a structured
binary monitor. That is a protocol an external program can drive, which is what
makes an integrated debugging experience possible: an `8bs debug vic20` command
and the editor extension will attach to it rather than reimplementing a 6502
debugger. Both of those are **planned and not yet implemented**; the emulator's
capability is what makes them worth planning.

## macOS

Install VICE 3.10 through Homebrew:

```bash
brew install vice
```

The formula is bottled for both Apple Silicon and Intel, so this is a download
rather than a build on either machine.

Alternatively, the VICE project publishes its own macOS builds on
[the official VICE site](https://vice-emu.sourceforge.io/). Those are worth
reaching for if you need a specific version, or a build newer than whatever
Homebrew currently carries. Either route is fine; do not install both.

## Linux

On Debian and Ubuntu, install from the system package manager:

```bash
sudo apt update
sudo apt install vice
```

On Arch and Manjaro, VICE is in the official repositories at the pinned
version, ROMs included:

```bash
sudo pacman -S vice
```

Read the ROM caveat below before assuming this worked — on Debian and its
derivatives, a clean install is not the same thing as a working emulator.

Alternatively, if you already use Linuxbrew, the same formula as macOS is
available:

```bash
brew install vice
```

> **Debian's `vice` package ships without the Commodore ROM images.**
>
> The KERNAL, BASIC, and character-generator ROMs are copyrighted Commodore
> code, and Debian's licensing policy keeps them out of the archive. The package
> therefore installs cleanly, puts `xvic` and `x64sc` on your `PATH`, and
> reports a version perfectly happily — and then fails the moment you try to
> boot a machine. What you see is a blank or black window that never reaches the
> READY prompt, or an error on launch naming a ROM file it could not load.
> Nothing about the install output hints at this.
>
> The fix is to supply the ROMs yourself, from the VICE project's own
> distribution or from another machine's install, and place them where VICE
> looks for its data files — typically `/usr/lib/vice` or `~/.local/share/vice`,
> depending on how the package was built. `xvic -help` and the launch error both
> name the search path VICE is actually using.

That failure mode is the reason `8bs doctor` is not satisfied by checking that
the `xvic` binary exists. A binary that exists, runs, and prints a version can
still be completely unable to boot a VIC-20, so the doctor launches the emulator
for a bounded number of emulated cycles and confirms it reaches a working
machine; anything less would report success on a setup that cannot run a single
build.

## Verify

Confirm both emulators are installed:

```bash
xvic --version
x64sc --version
```

Both should report VICE 3.10.

Then confirm the VIC-20 emulator can genuinely boot, which the version check
does not tell you:

```bash
xvic
```

A working install opens a window showing the VIC-20 startup screen and a
`READY.` prompt with a blinking cursor. Close the window once you have seen it.
If the window is blank, never reaches `READY.`, or the launch prints a ROM
error, see the ROM caveat above.

## On cc65

cc65 is intentionally not part of this toolchain, as noted in the
[setup overview](index.md). Running two independent 6502 toolchains would double
the number of things that can break — two sets of build failures, two sets of
platform quirks — and would not make a single additional program possible. All
6502 code generation goes through LLVM-MOS.

## Next

With the compiler and the emulator both installed, confirm the whole toolchain
responds: [Verify your setup](verify.md).
