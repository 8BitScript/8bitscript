---
title: Atari 5200
---

# Atari 5200

`8bs run atari5200` builds a `.bin` and launches `atari800`.
The emulator is optional: `8bs doctor` WARNs when it is missing.

**Deferred pending emulator setup.** Hello-world compiles. `8bs run` builds the image and prints the catalog's `emulator.deferred` reason rather than claiming a launch.


```
brew install atari800
sudo apt-get install -y atari800
sudo pacman -S atari800
```

MAME ROM sets and console BIOS files are not redistributable.
Doctor never downloads them. A missing BIOS is a warning, not a failed doctor.
