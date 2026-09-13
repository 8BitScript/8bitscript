---
"@8bitscript/atari8": minor
"@8bitscript/c128": minor
"@8bitscript/c64": minor
"@8bitscript/cx16": minor
"@8bitscript/mega65": minor
"@8bitscript/nes": minor
"@8bitscript/pet": minor
"@8bitscript/vic20": minor
"@8bitscript/web": minor
---

`text.fill(cell, count, code)` — the run `print()` cannot write.

`print()` takes a string, and a string is a constant: its width is decided
when the program is compiled. That is fine for every layout whose shape is
known at build time, which until now was all of them.

A layout that responds to the screen it is on does not know its widths until
it runs, and "a row of N blanks" stops being expressible — you would need one
string constant per width the thing might ever have.

`fill()` is what `print()` would be if a string of that width could be built
at run time: same current colour, same reverse bit, same cells. Each machine's
copy follows that machine's own `print()` — `place()` where there is one, and
the VERA/PPU address walk on the X16 and NES, where the next row is not the
next address.
