---
title: Tandy Color Computer
---

# Tandy Color Computer

`8bs run coco` builds a `.bin` and launches `xroar`.
The emulator is optional: `8bs doctor` WARNs when it is missing.

**Deferred pending emulator setup.** Hello-world compiles. `8bs run` builds the image and prints the catalog's `emulator.deferred` reason rather than claiming a launch.


```
brew install xroar
sudo apt-get install -y xroar
sudo pacman -S xroar
```

MAME ROM sets and console BIOS files are not redistributable.
Doctor never downloads them. A missing BIOS is a warning, not a failed doctor.
