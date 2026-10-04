---
"@8bitscript/graphics": minor
---

`@8bitscript/graphics` on the Commander X16: every call of the portable contract is now real and read off x16emu screenshots — `hide`, `place` after `hide`, `setFrame` (clamped, and while hidden), `animate` pausing one object while another steps, and `color`. `color(slot, c)` now draws the object in machine colour `c` (0–15), and a value from 16 up gives the picture its own colours back; `graphics.RECOLORS` is true on the X16. A position at or past the screen (x ≥ 640 or y ≥ 480) now switches the sprite off instead of wrapping around to the left edge, as the contract says an object off the playfield must. Cost on `media-walk`: 4002 → 4114 bytes of program; a program that uses all four calls adds 481 bytes over one that only places and updates.
