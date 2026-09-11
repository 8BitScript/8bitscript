---
"@8bitscript/cli": patch
"8bitscript-lang": patch
---

The launcher's Running section is now a Running machines tree. Run and
build pass `--size`, so the per-function breakdown prints in the terminal
before the emulator starts, and the same numbers — plus live FPS on the
web — show in an expandable tree next to Stop. VICE has no live CPU
readout: its monitor pauses the machine on any command.
