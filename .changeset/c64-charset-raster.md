---
"@8bitscript/c64": minor
---

The C64 answers the portable raster surface's `Slot.CHARSET`: `raster.at(line, Slot.CHARSET, 1)` switches the picture to the lower/upper-case character set from that line, and `0` switches it back to the upper-case/graphics set. This is `$D018` bit 1; the screen pointer is kept. `raster.CHARSET` is now `true` on the C64, and the slot is refused over a bitmap.
