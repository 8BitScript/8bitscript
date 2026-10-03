---
"@8bitscript/cx16": minor
"@8bitscript/examples": patch
---

The Commander X16 answers `@8bitscript/raster`: border, background, fine-scroll and character-set splits on VERA's line interrupt, each landing on its own picture line under x16emu, and `#fact(video.raster)` is now true on the X16. `examples/fancy` shows its colour bands and wobble there. `input.poll()` and `mouse.poll()` now restore the interrupt flag after their KERNAL calls instead of leaving interrupts off.
