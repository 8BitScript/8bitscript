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

The VIC-20's RAM expansion is a hardware option, `ram`, with the five
values the SDK's link script and `xvic -memory` both know; the presets
carry the same names, so `8bs build --target vic20 --profile 16k` and
`--hardware ram=16k` are the same build. Unexpanded is the default.

| `ram` | Expansion | Program loads at | Screen / colour RAM | Tag |
| ----- | --------- | ---------------- | ------------------- | --- |
| `none` | none (5K) | `$1001` | `$1E00` / `$9600` | — |
| `3k` | 3K at `$0400` | `$0401` | `$1E00` / `$9600` | `3k` |
| `8k`, `16k`, `24k` | 8K, 16K, 24K from `$2000` | `$1201` | `$1000` / `$9400` | `expanded` |

With 8K or more the KERNAL moves the screen down to `$1000` so BASIC RAM
runs unbroken from `$1200`; `@8bitscript/vic20`'s text and screen
packages follow it through one hardware version of one small file
(`geometry.vic20.expanded.8bs`, the `expanded` tag all three values
share — see [the package model](../packages.md#system-specific-files)),
so one program draws in the right place whatever is fitted. The RAM has
to match the machine it runs on; `8bs run` passes the matching `-memory`
to xvic, and the value is in the output name (`main-vic20-8k-ntsc.prg`).
The other option is `port1` (a joystick by default; paddles, or a 1351
mouse, which xvic accepts and the hardware notes mark *to verify*). `8bs
targets` lists both.

## PET models

The PET's model is a hardware option, `model`, named the way the machines
were, with a preset per model: `8bs build --target pet --profile 8032`.
The model picks the RAM the program is linked for, the screen width the
`@8bitscript/text` and `@8bitscript/screen` packages draw to (through the
`8032` tag's version of the geometry file), the keyboard matrix, and the
model `xpet` launches. `3032` is the default.

| `model` | RAM | Columns | Video | ROMs | xpet refresh |
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
bigger, and the SDK's PET link script refuses them; they are not values.
The keyboard is the model's too: `@8bitscript/pet/keys` names the keys of
the graphics matrix, and of the business matrix for the `8032` tag.
`packages/pet/AGENTS.md` has the hardware behind each column of the table.

## C64 models and the REU

The C64 is one build for every model. Unlike the PET, nothing about a
C64 model changes what the program is linked for — a breadbin C64, a C64C,
an SX-64 and a C64GS all load a `.prg` at `$0801` into the same map — so
none of the C64's hardware options changes the build; each only fits
x64sc the same thing:

| Option | Values | x64sc |
| ------ | ------ | ----- |
| `ram` | `none` (default), `reu128` … `reu16m` — also the presets `stock`, `reu512` and so on | `-reu -reusize` |
| `sid` | `6581` (default), `8580` | `-sidmodel` |
| `port1` | `none` (default), `joystick`, `paddles`, `mouse1351` | `-controlport1device` |
| `port2` | `joystick` (default), `none`, `paddles`, `mouse1351` | `-controlport2device` |

```bash
8bs run c64 --profile reu512                       # a 512K REU
8bs run c64 --hardware port1=mouse1351,sid=8580    # a 1351 in port 1, the later SID
```

**A 1351 comes with VICE's mouse grab**, because on its own
`-controlport1device 3` puts a mouse in the port and never moves it: the
emulator only translates the host pointer into the device's lines while it
has the pointer grabbed (`-mouse`, "Enable mouse grab" in `x64sc -help`).
So `mouse1351` passes both, and the emulator window takes your pointer as
soon as it opens. **Command+M gives it back** — `mouse-grab-toggle` in
VICE's own `hotkeys.vhk`, `Alt+M` on platforms other than macOS.

Region is `--pal` (x64sc's `-model c64`, a 6569 VIC-II) or the NTSC
default (`-model ntsc`, a 6567R8). To run a build on another model,
launch x64sc yourself with its `-model`:

| `-model` | Region | VIC-II | SID | CIA | Notes |
| -------- | ------ | ------ | --- | --- | ----- |
| `c64` | PAL | 6569 | 6581 | 6526 | the default `--pal` machine |
| `c64c` | PAL | 8565 | 8580 | 6526A | the later, cost-reduced board |
| `c64old` | PAL | 6569R1 | 6581 | 6526 | early PAL board, KERNAL rev 2 |
| `ntsc` | NTSC | 6567R8 | 6581 | 6526 | the default machine |
| `newntsc` | NTSC | 8562 | 8580 | 6526A | NTSC C64C |
| `oldntsc` | NTSC | 6567R56A | 6581 | 6526 | 262 lines of 64 cycles: the frame runtime's NTSC figure (263 × 65) is 1.9% off here |
| `drean` | PAL-N | 6572 | 6581 | 6526 | Argentina; 312 lines of 65 cycles (Bauer, VICE) at a clock near NTSC's (unverified) — the runtime's PAL probe sees it as PAL and its frame period is under 1% off |
| `jap` | NTSC | 6567R8 | 6581 | 6526 | Japanese KERNAL and character ROM |
| `c64gs` | PAL | 8565 | 8580 | 6526A | the cartridge console: no keyboard, boots to a cartridge prompt instead of BASIC |
| `pet64` | PAL/NTSC | 6569/6567 | 6581 | 6526 | the Educator 64: the 4064 KERNAL, a monochrome monitor |
| `ultimax` | NTSC | 6567R56A | 6581 | 6526 | the MAX Machine: 2K RAM, no KERNAL — a `.prg` cannot run there |

(VICE 3.10's `x64sc -help` and its `c64model.c` table; `-sidmodel 0/1/2`
picks 6581, 8580, or 8580 with the digi fix, `-VICIImodel` a chip
revision by itself.) `packages/c64/AGENTS.md` has what each column means
for a program.

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
