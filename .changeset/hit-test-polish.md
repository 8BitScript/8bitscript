---
---

Tighten the graphics hit tests under x16emu and x64sc: the answers are parsed strictly, a timeout is reported as one, and the emulator's process group is stopped with SIGTERM before SIGKILL. No shipped code changes.
