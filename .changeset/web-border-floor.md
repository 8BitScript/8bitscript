---
"@8bitscript/cli": patch
---

The web target never draws a zero border again, however small the screen.

`borderFor()` dropped the border to nothing below 2x scale, which is every
phone in either orientation. The reasoning was sound as far as it went — the
border is decoration, and 48 of every 432 horizontal pixels is canvas spent on
nothing — but it treated the border as *only* decoration.

It is also a channel. `screen.setBorder()` is how a program says something
about the whole screen at once, and the border is the one part of the picture
still visible when something is drawn over the middle of it: 2048 turns it red
on game over. At zero that said nothing at all, on exactly the devices most
people play on.

The floor is 3 picture pixels — 3 of 216 rows, under 3% of the height across
both edges, and unmistakable when the colour changes.
