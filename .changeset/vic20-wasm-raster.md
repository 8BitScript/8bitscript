---
'@8bitscript/vic20': minor
'@8bitscript/cli': minor
---

The VIC-20's portable raster list now builds and runs on its wasm build. `examples/fancy`
and any program that imports `@8bitscript/raster` build with `8bs build --target vic20
--web` (they failed on the frame hook's machine code), and the page applies each
`BORDER`, `BACKGROUND` and `CHARSET` entry at its picture line. The page also reads the
VIC-20's border, background and character set from `$900F` and `$9005`, as the chip does,
and has both of its character sets, so a program that never prints boots in the upper-case
set and `Slot.CHARSET` works. New: `8bs conform vic20 --program bands` compares where each
band starts against xvic (every band starts on the same line); the text-grid conformance
fell from 166 to 112 differing cells.
