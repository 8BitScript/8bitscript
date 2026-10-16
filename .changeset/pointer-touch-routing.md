---
"@8bitscript/cli": minor
"@8bitscript/web": minor
"@8bitscript/c64": minor
"@8bitscript/cx16": minor
---

The browser page now carries a real pointer, and a gesture means one thing.

**A mouse drag no longer moves tiles.** The page used to turn every pointer-up into a swipe or a confirm whatever the device. It now routes by `pointerType` and by whether the build has a mouse (`pointerRoute()` in `web-layout.mjs`): a machine with none (PET, VIC-20, the web skins) translates a touch to arrows (swipe) or confirm (tap) and ignores a mouse drag; a machine with one (X16, the C64 with `port1=mouse1351`, the Modern web host) gets a real pointer — position in the picture's pixels, left and right buttons — where a mouse is a mouse, a tap is a click and a swipe is still arrows, never both for one gesture.

**The pointer block** is six bytes at the very end of the agreement (after the frame counter), present only on a build whose `input.mouse` fact is true, so no existing offset moves. `input.pointer()`, `pointerCell()` and `pointerButton()` read it on the Modern web host and in the X16 and C64 `.web` input twins; the browser's own cursor is the arrow and `pointer.DRAWS` stays false on every wasm build (`pointer.cx16.web.8bs`, `pointer.c64.web.8bs`). Measured on 2048: the PET build is unchanged at 3326 bytes.
