---
"@8bitscript/web": minor
"@8bitscript/cli": minor
---

The web target now answers `raster.CHARSET`: `@8bitscript/raster`'s `Slot.CHARSET` switches the character set from a chosen picture line down, the same per-line slot the PET 3032 and 4032 model tags answer. Value 0 is the boot set and 1 the web's alternate set. The web has no character ROM, so the alternate set is defined by its runtime: the same glyphs with every lower-case letter drawn as its capital. That matches the mixed-case/upper-case pair every Commodore machine has. Screen memory never changes; the split decides which set draws it. Both renderers apply it identically: the browser page carries a second glyph table and picks one per row, and `--screenshot` passes the row's set to `glyphRows()`. It works on every synthetic skin (the Modern host, `pet-2001`, `c64`, `vic20`), and a real machine's captured ROM table is never remapped. Verified by a compiled `.8bs` program's headless screenshot, with capitals on exactly the band's rows on the Modern host and the `pet-2001` skin, plus the loader/compositor pixel-parity test.
