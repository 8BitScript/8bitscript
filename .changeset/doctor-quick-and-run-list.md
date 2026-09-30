---
"@8bitscript/cli": patch
---

`8bs doctor --quick` no longer launches an emulator to probe it, so opening the VS Code sidebar stops flashing a VIC-20 window, and the extension's own doctor call actually passes `--quick`. The Run menu's system list no longer repeats a named system as a bare machine.
