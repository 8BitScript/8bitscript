---
"8bitscript-lang": patch
---

The launcher's three runtime buttons are now **Run** (the WebAssembly build in an editor tab, formerly "Editor"), **Browser** (unchanged) and **Emulator** (the real emulator, formerly "Native"). The messages that name them follow. The command ids and the `runtime` values in `tasks.json` (`editor`, `browser`, `native`) are unchanged, so nothing saved or bound stops working.
