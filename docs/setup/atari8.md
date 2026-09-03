---
title: Atari 8-bit
nav_order: 5
---

# Atari 8-bit

[atari800](https://github.com/atari800/atari800) is the emulator 8BitScript
targets for the Atari 8-bit family — the 400/800/XL/XE/XEGS lineage `8bs
build --target atari8` compiles for (see [LLVM-MOS](llvm-mos.md) for the
profile list). One binary covers every profile: `--model` picks the machine,
not a separate install.

## macOS

```bash
brew install atari800
```

## Linux

On Debian and Ubuntu:

```bash
sudo apt update
sudo apt install atari800
```

On Arch and Manjaro:

```bash
sudo pacman -S atari800
```

Or, on any Linux with Linuxbrew:

```bash
brew install atari800
```

## ROMs

Like the VICE ROM caveat on the [VICE](vice.md) page, atari800 needs the
Atari OS ROMs to actually boot a machine — Atari BASIC, the 400/800 OS, and
the XL/XE OS are copyrighted Atari code, so most packages install the
emulator without them. On first run, atari800 scans its working
directory for ROM images and writes a config file once it finds (or fails to
find) them; if it can't, it starts anyway but stays at a black screen instead
of booting. Get the ROMs from your own hardware or a legitimate archive, and
consult `atari800 -help` for the exact filenames and search paths it expects.

## Verify

```bash
atari800 --version
```

`8bs doctor` checks that `atari800` exists on `PATH`; it does not (yet)
attempt to verify a real boot the way the VIC-20 check on the VICE page does.

## Run

```bash
8bs run atari8                      # 800XL, NTSC
8bs run atari8 --profile 130xe --pal
```

`8bs run` maps each profile to atari800's own machine-model flag — verified
against atari800's `DOC/USAGE`: `-atari` for 800/400, `-xl` for 800XL and
65XE (electrically and OS-compatible, so they share a flag), `-xe` for
130XE, `-xegs` for XEGS — plus `-run <file.xex>` for every profile except
XEGS, which loads as a cartridge instead (`-cart <file.rom>`).

## Next

[NES](nes.md).
