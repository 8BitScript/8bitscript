---
"8bitscript-lang": patch
---

Run and Build from the side bar use a real `node`, not Cursor's Electron helper.

A `.mjs` toolchain used to launch as `process.execPath`, which inside the
editor is the Plugin Helper. A task terminal is not `ELECTRON_RUN_AS_NODE`,
so that helper started as a GUI and died on `--system` / `--checkout`.
