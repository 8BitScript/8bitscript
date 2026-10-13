---
"8bitscript-lang": patch
---

The launcher's three runtime buttons are now **Preview** (the WebAssembly build in an editor tab, formerly "Editor"), **Browser**, and **Emulate** (the real emulator, formerly "Native"), and each says under its name where it will open: the editor you are in (Cursor, VS Code, …), your default browser (read from the system's https handler on macOS, Windows and Linux, and left blank when it cannot be told), and the machine's emulator executable (`x64sc`, `xvic`, `x16emu`, …). The buttons are now tiles — icon, name, where — and Preview has a window icon. The messages that name the runtimes follow. Command ids and the `runtime` values in `tasks.json` (`editor`, `browser`, `native`) are unchanged, so nothing saved or bound stops working.
