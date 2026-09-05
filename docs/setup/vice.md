---
title: VICE
nav_order: 4
---

# VICE

VICE is the emulator 8BitScript targets for development. One suite covers
every Commodore machine that matters here: `xvic` emulates the VIC-20, `x64sc`
emulates the C64, `xpet` emulates the PET, and `x128` emulates the C128 — a
single install serves all four. Installing a separate emulator per machine
would mean a separate set of quirks, a separate configuration format, and a
separate thing to keep working, times four.

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

> **`xvic --version` (and `x64sc`/`xpet`/`x128 --version`) can crash instead
> of printing a version.**
>
> Some Homebrew bottles (confirmed on 3.9, and reproduced here on 3.10) fail
> before they get to the version banner:
>
> ```
> Error - failed to retrieve executable path, falling back to getcwd() + argv[0]
> Error - argv[0] is NULL, giving up.
> ```
>
> This is a known upstream regression
> ([vice-emu bug #2108](https://sourceforge.net/p/vice-emu/bugs/2108/)), not
> anything wrong with the install — it happens on a build that runs and boots
> machines fine. `8bs doctor` already works around it: when the binary itself
> won't report a version, it asks `brew list --versions vice` instead, and
> only warns if that comes up empty too. If you want to confirm the version by
> hand, use `brew list --versions vice` rather than `xvic --version`.

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

Confirm all four emulators are installed:

```bash
xvic --version
x64sc --version
xpet --version
x128 --version
```

All four should report VICE 3.10. On macOS, don't be alarmed if one or more
of these crash with the `argv[0] is NULL` error above instead — see the
caveat in the macOS section; `8bs doctor` (or `brew list --versions vice`)
is the reliable way to see the installed version on those builds. `8bs
doctor` runs the same four checks (plus the VIC-20 boot check below) every
time — this is worth doing by hand once, to see what a working install looks
like.

Then confirm the VIC-20 emulator can genuinely boot, which the version check
does not tell you:

```bash
xvic
```

A working install opens a window showing the VIC-20 startup screen and a
`READY.` prompt with a blinking cursor. Close the window once you have seen it.
If the window is blank, never reaches `READY.`, or the launch prints a ROM
error, see the ROM caveat above.

`8bs doctor` only automates this boot check for `xvic`; `x64sc`, `xpet`, and
`x128` get the version check above but not (yet) a scripted boot. The same
missing-ROM failure mode applies to all four — if `xpet` or `x128` behave the
way the caveat above describes, the fix is identical: supply the ROMs
yourself and place them where that binary's `-help` output says it looks.

## VIC-20 memory

The VIC-20 is one target with five RAM profiles, the expansions the SDK's
link script and `xvic -memory` both know: `8bs build --target vic20
--profile 16k`. `unexpanded` is the default.

| Profile | Expansion | Program loads at | Screen / colour RAM |
| ------- | --------- | ---------------- | ------------------- |
| `unexpanded` | none (5K) | `$1001` | `$1E00` / `$9600` |
| `3k` | 3K at `$0400` | `$0401` | `$1E00` / `$9600` |
| `8k`, `16k`, `24k` | 8K, 16K, 24K from `$2000` | `$1201` | `$1000` / `$9400` |

With 8K or more the KERNAL moves the screen down to `$1000` so BASIC RAM
runs unbroken from `$1200`; `@8bitscript/vic20`'s text and screen
packages follow it through a profile version of one small file
(`geometry.vic20.8k.8bs`, see [the package model](../packages.md#system-specific-files)),
so one program draws in the right place on every profile. The profile has
to match the machine it runs on; `8bs run` passes the matching
`-memory` to xvic, and a non-default profile is in the output name
(`main-vic20-8k-ntsc.prg`).

## PET models

The PET is one target with several hardware profiles, named the way the
machines were: `8bs build --target pet --profile 8032`. The profile picks
the RAM the program is linked for, the screen width the `@8bitscript/text`
and `@8bitscript/screen` packages draw to, and the model `xpet` launches.
`3032` is the default.

| Profile | RAM | Columns | Video | ROMs | xpet refresh |
| ------- | --- | ------- | ----- | ---- | ------------ |
| `3008`, `3016`, `3032` | 8K, 16K, 32K | 40 | no CRTC (9-inch) | BASIC 2, graphics keyboard | ~60 Hz |
| `4016`, `4032` | 16K, 32K | 40 | 6545 CRTC (12-inch) | BASIC 4, graphics keyboard | 50 Hz |
| `8032` | 32K | 80 | 6545 CRTC (12-inch) | BASIC 4, business keyboard | 50 Hz |

```bash
8bs run pet                    # a 3032: 40 columns, 32K, ~60Hz
8bs run pet --profile 8032     # the 80-column business machine
8bs run pet --profile 3008     # 8K: the smallest RAM the SDK links for
```

There is no `--pal` for the PET. Its refresh rate is the model's, not a
region's: VICE runs the CRTC models with their 50 Hz editor ROMs (the 60 Hz
editors it ships make it refuse autostart) and the no-CRTC 3xxx at its own
~60.1 Hz, and every build measures the real frame period at start-up, so
one `.prg` runs at the configured `frameRate` on either. `--pal` prints a
note and changes nothing. The 96K/128K machines (8096, 8296) are banked, not
bigger, and the SDK's PET link script refuses them; they are not profiles.
The keyboard column is the profile's too: `@8bitscript/pet/keys` names the
keys of the graphics matrix, and of the business matrix for `8032`.
`packages/pet/AGENTS.md` has the hardware behind each column of the table.

## On cc65

cc65 is intentionally not part of this toolchain, as noted in the
[setup overview](index.md). Running two independent 6502 toolchains would double
the number of things that can break — two sets of build failures, two sets of
platform quirks — and would not make a single additional program possible. All
6502 code generation goes through LLVM-MOS.

## Next

With the compiler and VICE both installed, the Commodore targets are ready.
The rest of this project's targets each need their own emulator:
[Atari 8-bit](atari8.md), [NES](nes.md), [Commander X16](cx16.md), and
[MEGA65](mega65.md) — or skip straight to
[verifying the whole toolchain](verify.md) if those targets don't matter to
you yet.
