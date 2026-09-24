---
title: Game Boy Color
---

# Game Boy Color

`8bs run gbc` builds a `.gbc` and launches `sameboy`.
The emulator is optional: `8bs doctor` WARNs when it is missing.

**Deferred pending emulator setup.** Hello-world compiles. `8bs run` builds the image and prints the catalog's `emulator.deferred` reason rather than claiming a launch.


Homebrew has no formula; the cask installs SameBoy.app. There is no
Debian package. Arch/Manjaro get it from the AUR.

```
# macOS
brew install --cask sameboy

# Arch/Manjaro AUR
pamac build --no-confirm sameboy
```

MAME ROM sets and console BIOS files are not redistributable.
Doctor never downloads them. A missing BIOS is a warning, not a failed doctor.
