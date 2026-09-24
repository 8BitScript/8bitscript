---
title: Apple II
---

# Apple II

`8bs run apple2` builds a `.bin` and launches `mame`.
The emulator is optional: `8bs doctor` WARNs when it is missing.

**Deferred pending emulator setup.** Hello-world compiles. `8bs run` builds the image and prints the catalog's `emulator.deferred` reason rather than claiming a launch.


```
brew install mame
sudo apt-get install -y mame
sudo pacman -S mame
```

MAME ROM sets and console BIOS files are not redistributable.
Doctor never downloads them. A missing BIOS is a warning, not a failed doctor.
