---
"@8bitscript/cx16": patch
---

X16 `locate()` and reverse video keep working past the first 32 rows.

`high * 28` and `row * 76` were eight-bit multiplies, so every cell from
2560 up (row 33 of the 76-wide grid) landed in the wrong column — 2048's
"ARROWS TO MOVE" printed as "AR" at the right edge and "ROWS TO MOVE" on
the left. Both factors are widened first, the same way the NES widens
`row` before `* 32`. Reverse video onto an already-reversed cell also
kept the fill colour as the glyph colour; and when DATA1 was sitting on
the character byte, `attr / 16` was the ASCII high nibble — 2048's '2'
printed cyan on a white tile. Reverse is now fill-with-currentColor and
a black glyph, which does not read that port.
