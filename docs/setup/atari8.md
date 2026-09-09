---
title: Atari 8-bit
nav_order: 5
---

# Atari 8-bit

[atari800](https://github.com/atari800/atari800) is the emulator 8BitScript
targets for the Atari 8-bit family — the 400/800/XL/XE/XEGS lineage `8bs
build --target atari8` will compile for when the 6502 backend emits. Until
0.2.0 that command refuses. Which machine is the `model`
hardware option (`8bs targets` lists it, with a preset per model); one
binary covers every model, since atari800's own flag picks the machine,
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

On Arch and Manjaro, atari800 is not in the official repos — it's AUR-only.
On Manjaro, `pamac` (installed by default) builds AUR packages directly:

```bash
pamac install atari800
```

On plain Arch, or anywhere without `pamac`, use an AUR helper such as
[yay](https://github.com/Jguer/yay) or [paru](https://github.com/morganamilo/paru):

```bash
yay -S atari800
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

The Atari's variety runs on two axes in the catalog, and they are
deliberately separate options: `model` is the *machine*, `media` is how the
program is *delivered*. They are independent — a standard cartridge runs on
an 800XL as happily as on an XEGS console — and folding them together is
what the catalog used to do wrong.

`model` values carry atari800's own machine-model flag, verified against
atari800's `DOC/USAGE`: `-atari` for 800 and 400, `-1200` for the 1200XL,
`-xl` for 800XL and 65XE (electrically and OS-compatible, so they share a
flag), `-xe` for 130XE, `-xegs` for the XEGS console. Nothing on this axis
changes the build — every model links the same `.xex` — so it never appears
in the output filename. What it does change is the fact sheet: the 400 and
800 have four joystick ports where every XL and XE has two, and only the
130XE has extended RAM (found at run time by
[`@8bitscript/atari8/banks`](../packages.md)).

`media` is the axis that changes the build — the driver, the link address,
the RAM budget and the image — so its value names the output file:

| `media` | Image | Loaded as |
| ------- | ----- | --------- |
| `xex` (default) | `.xex`, program at `$2000`–`$BFFF` | `-run <file.xex>` |
| `cart8`, `cart16` | 8 KiB at `$A000` / 16 KiB at `$8000` | `-cart-type 1` / `2` |
| `xegs32` … `xegs512` | 32–512 KiB, 8 KiB banks at `$8000` + a fixed bank at `$A000` | `-cart-type 12/13/14/23/24` |
| `mega16` … `mega512` | 16–512 KiB in 16 KiB banks over `$8000`–`$BFFF` | `-cart-type 26`–`31` |

Every cartridge medium passes `__cart_rom_size` as a link symbol — the
standard-cartridge link script has no default for it and will not link
without one — and names its atari800 `-cart-type` explicitly, because a raw
cartridge image carries no header: a 256 KiB file matches eight of
atari800's types, and without the type the emulator stops at its "Select
Cartridge Type" menu instead of running anything. A cartridge also links
against a much smaller RAM window (`$0700`–`$1FFF`, 6400 bytes, against the
`.xex`'s 40960) and has no writable storage of its own, both of which are on
its fact sheet.

```bash
8bs run atari8 --hardware media=cart8            # an 8K cartridge on an 800XL
8bs run atari8 --hardware model=800,media=cart16 # ... a 16K one on an 800
8bs run atari8 --profile xegs                    # the console with a 256K XEGS cart
```

Two more axes cover what is plugged in. `mouse` is the pointing device, one
value per atari800 `-mouse` kind, and which fact it sets follows what the
device is really wired to: `st`, `amiga` and `trak` are quadrature on a
joystick port's *direction bits* (`input.mouse`); `paddles`, `touch` and
`koala` are analogue on POKEY's POT lines (`input.paddles`); `pen` and `gun`
are ANTIC's light-pen registers, which the fact sheet has no key for; `joy`
is the host mouse pretending to be a stick. `mouseport` (`1`–`4`) says which
port it is in — which matters, because a mouse or Trak-Ball in the port a
program scans as a joystick *is* that joystick, and its motion reads as
directions pushed. Put them in different ports, or do not scan the pointer's
port as a stick.

`stereo` fits a second POKEY.

## Next

[NES](nes.md).
