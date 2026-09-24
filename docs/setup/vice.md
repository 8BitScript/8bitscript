---
title: VICE
nav_order: 21
---

# VICE

VICE is one package and five binaries: `xvic` (VIC-20), `x64sc` (C64),
`xpet` (PET), `x128` (C128), `xplus4` (Plus/4, C16, C116). The project
expects VICE 3.10 or newer.

```
brew install vice
sudo apt-get install -y vice
sudo pacman -S vice
```

`8bs doctor` then boots `xvic` for a bounded number of cycles. A version
string is not enough: a VICE build without Commodore ROM images prints
its version and still cannot start a machine.

## Debian / Ubuntu ROMs

Debian's `vice` package is often shipped **without** the Commodore ROM
images (copyright). `xvic` is then on PATH and still fails the boot
check — that is a broken install, not "optional." Obtain the ROMs the
VICE project documents (`vice-roms`, or a full upstream build), put them
where VICE looks (`/usr/lib/vice` or `~/.local/share/vice`), and re-run
`8bs doctor`. This project never downloads those ROMs.
