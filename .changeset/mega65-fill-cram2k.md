---
"@8bitscript/mega65": patch
---

`text.fill` on MEGA65 now maps colour RAM over the CIAs (`prepare`/`release`) before it writes, so a fill past cell 1023 no longer pokes CIA2 and scrambles the VIC-IV charset pointer. 2048's board was the measured case: the bottom tile row landed on a CIA2 PRA mirror and every glyph drew as junk.
