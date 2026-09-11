---
"@8bitscript/compiler": patch
"@8bitscript/pet": patch
"@8bitscript/atari8": patch
"@8bitscript/nes": patch
---

`text.setColor` on a machine with no per-cell color is now an empty
function, and the compiler deletes the call — so a program that colors
its text pays the PET, Atari 8-bit, and NES nothing, without wrapping the
call in `Video.COLOR_PER_CELL`.
