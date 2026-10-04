---
"@8bitscript/c64": minor
"@8bitscript/graphics": minor
---

`@8bitscript/graphics` on the C64 now holds up to 24 sprites (it silently ignored everything past the eighth), colours each from its PNG, and says when an animation is too long. A `.8bg` sprite takes the VIC-II colour nearest its PNG's most common opaque colour instead of white; an animation longer than 4 frames is cut to 4 with `8BS2111` (it used to overrun the next sprite's shape blocks and truncate the byte index, corrupting the picture). The multiplexer counts only the highest slot a program declared. Past X = 255 a position must be a `usmallint` sum; the C64 notes say why.
