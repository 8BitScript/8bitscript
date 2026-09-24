---
title: ZX Spectrum
---

# ZX Spectrum

`8bs run spectrum` builds a `.tap` and launches `fuse`.
The emulator is optional: `8bs doctor` WARNs when it is missing.

**Deferred pending emulator setup.** Hello-world compiles. `8bs run` builds the image and prints the catalog's `emulator.deferred` reason rather than claiming a launch.


Never install a package named `fuse` — that is the filesystem (libfuse /
Fuse Studio), not the ZX emulator.

```
# Debian/Ubuntu
sudo apt-get install -y fuse-emulator-gtk

# Arch/Manjaro AUR
pamac build --no-confirm fuse-emulator

# macOS — Homebrew has no formula that puts `fuse` on PATH.
# The fredm-fuse cask installs Fuse.app (not the cask also named fuse):
brew install --cask fredm-fuse
```

MAME ROM sets and console BIOS files are not redistributable.
Doctor never downloads them. A missing BIOS is a warning, not a failed doctor.
