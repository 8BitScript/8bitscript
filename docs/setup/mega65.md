---
title: MEGA65
nav_order: 25
---

# MEGA65

`8bs setup mega65` builds Xemu's MEGA65 core (`xmega65`) from source
and installs it under `/opt/xemu`. The official MEGA65 ROM is **not**
redistributable. Setup never downloads it. You supply a 920413 ROM
(`--rom ~/Downloads/MEGA65.ROM`); doctor WARNs when the file is missing
and FAILs only when a present file is the wrong size or hash.

```
8bs setup mega65 --rom ~/Downloads/MEGA65.ROM
```

## Host packages

macOS (Homebrew):

```
brew install sdl2 wget git
```

Arch / Manjaro:

```
sudo pacman -S --needed base-devel git pkgconf sdl2-compat gtk3 readline msitools
```

Ubuntu / Debian:

```
sudo apt-get install -y build-essential git pkg-config libsdl2-dev libgtk-3-dev libreadline-dev wget msitools
```

`--c64-forever` (Linux) extracts a base ROM from a C64 Forever MSI you
already have, then applies the official 920413 patch with `romdiff`.
That is optional. `--rom` is the ordinary path.
