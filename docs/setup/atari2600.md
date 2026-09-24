---
title: Atari 2600
---

# Atari 2600

`8bs run atari2600` builds a `.a26` and launches `stella`.
The emulator is optional: `8bs doctor` WARNs when it is missing.

**Deferred pending emulator setup.** Hello-world compiles. `8bs run` builds the image and prints the catalog's `emulator.deferred` reason rather than claiming a launch.


```
brew install stella
sudo apt-get install -y stella
sudo pacman -S stella
```

MAME ROM sets and console BIOS files are not redistributable.
Doctor never downloads them. A missing BIOS is a warning, not a failed doctor.
