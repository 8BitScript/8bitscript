---
title: MSX
---

# MSX

`8bs run msx` builds a `.rom` and launches `openmsx`.
The emulator is optional: `8bs doctor` WARNs when it is missing.

**Deferred pending emulator setup.** Hello-world compiles. `8bs run` builds the image and prints the catalog's `emulator.deferred` reason rather than claiming a launch.


```
brew install openmsx
sudo apt-get install -y openmsx
sudo pacman -S openmsx
```

MAME ROM sets and console BIOS files are not redistributable.
Doctor never downloads them. A missing BIOS is a warning, not a failed doctor.
