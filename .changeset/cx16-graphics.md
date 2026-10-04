---
"@8bitscript/graphics": minor
"@8bitscript/cx16": minor
---

`@8bitscript/graphics` now works on the Commander X16. A `.8bg` sprite becomes a VERA hardware sprite with its own 15-colour palette, any legal size up to 64×64, and real animation frames. The old driver wrote four attribute bytes per sprite where VERA reads eight and never set a depth, so nothing was ever drawn; the media lowering also packed the picture as four 8×8 tiles and used the default palette's colours 1–3 instead of the picture's. `graphics.place(0, 0)` lands on the same pixel as text cell (0, 0) after `screen.blank()`. The probe and the screenshot test are in `packages/cx16/test/graphics.test.mjs`.
