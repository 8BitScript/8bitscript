---
"@8bitscript/vic20": minor
"@8bitscript/graphics": minor
"@8bitscript/compiler": patch
---

`@8bitscript/graphics` on the VIC-20 now honours what a `.8bg` says. The picture is reduced to the ROM's quadrant-block screen codes while the program is built (`packages/vic20/media`), so the machine keeps one byte per cell per frame instead of a 256-byte table and a reduction of its own. An 8×8 sprite is one cell (it used to be four, three of them blank, which erased the text beside it); a larger one is 2×2 cells; an `animation` now steps through its frames (the first 8) every `every` updates (only the first was ever shown); and a picture with almost no ink is one glyph (it used to draw `$51` and three `@`).

Moving an object blanks the cells it left, so there is no trail. Cells past the screen's edge are not drawn, where before an object at the right edge wrapped onto the next row and one at the bottom-right corner on an 8K machine reached `$1210`, inside the program. Text printed under an object is not restored when it moves (documented in `packages/vic20/AGENTS.md`).

The compiler numbered a sprite from 0 within its own `.8bg` file, so two files shared slot 0 on every target — `mark` and `player` in `examples/media-walk` were one object. Sprites are numbered across the whole build now.
