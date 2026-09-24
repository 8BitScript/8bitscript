---
title: Amstrad CPC
---

# Amstrad CPC

`8bs run cpc` builds a `.bin` and launches `cap32`.
The emulator is optional: `8bs doctor` WARNs when it is missing.

**Deferred pending emulator setup.** Hello-world compiles. `8bs run` builds the image and prints the catalog's `emulator.deferred` reason rather than claiming a launch.


There is no Homebrew formula (not `cap32`, not `caprice32`). Debian's
package is `caprice32`; it provides the `cap32` binary.

```
# Debian/Ubuntu
sudo apt-get install -y caprice32

# Arch/Manjaro AUR
pamac build --no-confirm caprice32
```

MAME ROM sets and console BIOS files are not redistributable.
Doctor never downloads them. A missing BIOS is a warning, not a failed doctor.
