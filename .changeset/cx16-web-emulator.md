---
"@8bitscript/cli": minor
"@8bitscript/studio": patch
---

`8bs run cx16 --web` runs the program in the browser's x16emu: the WebAssembly build X16Community ships with each release, pinned (r49) by URL and SHA-256, downloaded into the user's cache on first use — no Emscripten, no sudo — and served from loopback with the freshly built `.prg`. The page passes the emulator the same flags as the native window (the catalog's `run.x16emu`, the controller's, `-prg … -run`), so a program behaves the same in a tab as in a window. In the tab the mouse is the browser's Pointer Lock: a click on the screen takes it, Esc gives it back. `--no-open` and `--port` apply; the URL lands in `dist/.8bs-last-cx16.json` for the editor's Running machines tree. Studio gains `pnpm start:cx16-web`.
