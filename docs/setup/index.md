---
title: Setup
nav_order: 20
---

# Setup

Building a program never needs an emulator. Running one does. **`8bs run`
works only for `RELEASE_MACHINES`** — `pet`, `vic20`, `c64`, `cx16`, and
`web` in this release ([status page](../index.md)). `8bs doctor` still
checks the host toolchain (Node, pnpm, git) and every emulator in the
catalog below, so widening the release list later does not reshuffle these
pages. A missing emulator is a warning, not a failed doctor.
A present-but-broken install — VICE without Commodore ROMs, an `x16emu`
that cannot open `rom.bin` — is a FAIL for that target only.

The one-key install covers every emulator doctor has a trusted plan for,
plus missing host tools. `8bs doctor` prompts in a real terminal;
`8bs doctor --install` runs the plans without a keypress (the VS Code
Doctor panel uses that, because a task terminal is not a TTY). Building
still works with none of them. Uncheck ones you do not want in **Doctor:
Choose Emulators** (VS Code) or pass `--want`.

```
8bs doctor
8bs doctor --json
8bs doctor --install
8bs doctor --want vice,atari800
8bs doctor --all
```

`--want` takes installer keys (`vice`, `atari800`, `fceux`, `x16emu`,
`xmega65`, `stella`, `sameboy`, `fuse`, `openmsx`, `caprice32`, `xroar`,
`vecx`, `mednafen`, `mame`). `--all` is the default. In VS Code,
**8BitScript: Doctor: Choose Emulators** writes `8bitscript.doctorEmulators`
(`null` means all) and **Install selected** runs `--install` for that set.

Never `brew install fuse` or `apt install fuse` for the ZX Spectrum — those
are the filesystem. Fuse is `fuse-emulator-gtk` on Debian and the
`fredm-fuse` cask on macOS. Caprice32 and Vecx have no Homebrew formula.

Hosts this project supports: macOS (Homebrew), Ubuntu/Debian (`apt`),
Arch/Manjaro (`pacman`, plus AUR helpers). No Windows.

| Machine | Emulator | Install |
| ------- | -------- | ------- |
| VIC-20, C64, PET, C128, Plus/4 | VICE (`xvic`, `x64sc`, `xpet`, `x128`, `xplus4`) | [vice.md](vice.md), [plus4.md](plus4.md) |
| Atari 8-bit, Atari 5200 | `atari800` | [atari8.md](atari8.md), [atari5200.md](atari5200.md) |
| NES | FCEUX | [nes.md](nes.md) |
| Commander X16 | `x16emu` | [cx16.md](cx16.md) — `8bs setup cx16` |
| MEGA65 | `xmega65` | [mega65.md](mega65.md) — `8bs setup mega65` |
| Atari 2600 | Stella | [atari2600.md](atari2600.md) |
| GB, GBC | SameBoy | [gb.md](gb.md), [gbc.md](gbc.md) — `brew install --cask sameboy` |
| Spectrum | Fuse | [spectrum.md](spectrum.md) — never the `fuse` filesystem |
| MSX | openMSX | [msx.md](msx.md) |
| CPC | Caprice32 | [cpc.md](cpc.md) — apt/AUR; no Homebrew |
| CoCo | XRoar | [coco.md](coco.md) |
| SMS, Game Gear, PC Engine | Mednafen | [sms.md](sms.md), [gamegear.md](gamegear.md), [pce.md](pce.md) |
| Vectrex | Vecx | [vectrex.md](vectrex.md) — AUR; no Homebrew or Debian package |
| Apple II, BBC, Oric, Lynx, Atari 7800, SG-1000, Coleco, Supervision, Odyssey², Channel F | MAME | [apple2.md](apple2.md), [bbc.md](bbc.md), [oric.md](oric.md), [lynx.md](lynx.md), [atari7800.md](atari7800.md), [sg1000.md](sg1000.md), [coleco.md](coleco.md), [supervision.md](supervision.md), [odyssey2.md](odyssey2.md), [channelf.md](channelf.md) |
| Web | the browser | nothing to install |

Headless screenshots (`8bs run <target> --screenshot`) are [verify.md](verify.md).

Hello-world still compiles for every id in `MACHINES` (roadmap machines
included). Only the five `RELEASE_MACHINES` ids get an interactive
`8bs run` today. For the rest, `8bs build` refuses until the release list
widens; emulator notes below still describe what doctor installs for when
those targets return. Where a backend and emulator exist but the id is
outside `RELEASE_MACHINES`, `--screenshot` can still capture when the
host is installed — VICE, MAME `-seconds_to_run` with a ROM set, openMSX
Tcl on MSX, and macOS window capture for Stella, SameBoy, Fuse, Mednafen,
XRoar, Caprice32, and Vecx. A missing emulator or ROM set fails the
capture instead of pretending it succeeded.
