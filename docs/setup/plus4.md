---
title: Commodore Plus/4
---

# Commodore Plus/4

`8bs run plus4` builds a `.prg` and launches `xplus4`.
The emulator is optional: `8bs doctor` WARNs when it is missing.

```
brew install vice
sudo apt-get install -y vice
sudo pacman -S vice
```

MAME ROM sets and console BIOS files are not redistributable.
Doctor never downloads them. A missing BIOS is a warning, not a failed doctor.
