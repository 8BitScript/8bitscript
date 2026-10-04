---
"8bitscript-lang": minor
"@8bitscript/cli": minor
"@8bitscript/cx16": minor
"@8bitscript/graphics": minor
"@8bitscript/compiler": patch
"@8bitscript/studio": patch
---

Studio opens in the editor's WebAssembly tab, on our own backend, and it renders there.

- **VS Code:** **Open Studio** (the Studio row, the 🚀, **Launch Studio**, **Open Studio in a Tab**) runs `8bs run cx16 --web` in an editor tab: our compiler to wasm and our own model of the X16, not a full-screen native window and not the vendored x16emu. The native emulator is its own labelled button beside the row (**Open Studio in the Native Emulator**, `8bitscript.openStudioNative`), and the vendored x16emu in a tab is **Open Studio in x16emu (in a Tab)** (`8bitscript.openStudioX16emu`). Every old command id still works. The WebAssembly build is the primary way to run a program, which is what `8bitscript.preferWebPreview` already defaulted to; the tab's Editor runtime is the default for a program with no history.
- **cx16 wasm model:** the colours are VERA's own default palette (blue is `#0000aa`, as x16emu draws it; the C64's `#40318d` was wrong), and a `.8bg` picture is drawn at all — as one 8x8 glyph in the new redefinable glyph table, because the wasm model has no VERA sprites. Studio's mark now shows. `wasm.limits` for the X16 in `8bs targets --json` says what the model still leaves out (VERA layers and sprites, sound, the mouse, the raster list).
- **Compiler:** a `--web` build of a machine whose package names `"wasmMedia"` lowers pictures with that module (the X16 names the web's).
