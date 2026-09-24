---
title: Vectrex
---

# Vectrex

`8bs run vectrex` builds a `.bin` and launches `vecx`.
The emulator is optional: `8bs doctor` WARNs when it is missing.

**Deferred pending emulator setup.** Hello-world compiles. `8bs run` builds the image and prints the catalog's `emulator.deferred` reason rather than claiming a launch.


There is no Homebrew formula and no Debian package. Arch/Manjaro get it
from the AUR. MAME also emulates the Vectrex (`brew install mame`) but
`8bs run vectrex` launches `vecx`.

```
# Arch/Manjaro AUR
pamac build --no-confirm vecx
```

MAME ROM sets and console BIOS files are not redistributable.
Doctor never downloads them. A missing BIOS is a warning, not a failed doctor.
