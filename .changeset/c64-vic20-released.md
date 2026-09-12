---
"@8bitscript/compiler": minor
"@8bitscript/cli": minor
---

The C64 and the VIC-20 build and run. 2048 plays on both.

`RELEASE_MACHINES` is `pet, c64, vic20, web`. What it took, beyond the groundwork in the changes before this one:

**`waitFrame()` on a raster.** The PET has a retrace flag and no documented crystal, so it measures its own frame at start-up. Every other Commodore here has the opposite pair of facts: no flag, but a raster counter readable as a plain byte and a frame that is an exact fraction of a known crystal. So the accumulator, its denominator and the whole compare/subtract body are shared, and only two things differ per machine — how a hardware frame is waited for (the raster leaving the top half of the frame and coming back to it, never a narrow at-line-0 window, for the reason `FRAME_SYNC` records at length) and how the per-frame credit is arrived at. PAL or NTSC cannot be a build flag, since one `.prg` runs on both, so it is probed once at start-up by watching for a line only one region ever reaches.

**`string<N>` buffers.** A buffer's name is its address, the way a literal's is — it lives in the data section, not zero page — so it can be passed to `text.print` and assigned into. `stringCopy` is the assignment: the length byte and then that many characters, through two pointers.

**Narrowing assignment.** `let offset: utinyint = (cellWidth - width) >> 1` is ordinary code — the subtraction is 16-bit because one side is, and the answer is kept in a byte. Narrowing takes the low byte, which is what it has always meant, instead of the statement being refused for a width the program never asked anything unusual of.

**A 16-bit array index goes through a pointer.** Y is eight bits, so `screenRam[cell]` with a cell past 255 cannot be indexed with it. Truncating collapsed 1000 cells into the first 256 — on a 40-column screen, the whole display crammed into its top six rows, which is exactly what a C64 2048 drew before this. The address is computed instead, as a computed `memory.write` address already was.

Measured under x64sc and xvic, through the real CLI:

| | hello-world | 2048 |
|---|---|---|
| C64 | 424 bytes | 3747 bytes |
| VIC-20 | 232 bytes | 3116 bytes, inside an unexpanded 3583 |

The PET is unchanged at 108/108/127 bytes, and its 2048 got *smaller* — 2440 to 2413 — from the index-offset fold.
