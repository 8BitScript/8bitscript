---
"@8bitscript/cx16": minor
"@8bitscript/cli": minor
---

The Commander X16's wasm build can read input and draw a raster list. Portable
input (the keyboard's arrows, Enter and Escape, and now a gamepad's D-pad or left
stick, A/START and B/SELECT on every wasm target) and the portable raster list
(`Slot.BORDER`, `BACKGROUND`, `SCROLL_X` and `CHARSET` at their picture lines, a list that
takes effect on `commit()` or `enable()` as the VERA handler's does) used to be
machine code, so `examples/joystick`, `examples/fancy` and the Vegas Nights lobby did
not build for `8bs build --target cx16 --web`; they do now. `raster.frame()` is real
there: the page adds one to a byte of the program's memory (the X16's layout only; program
data starts one byte higher) each time it releases a frame, and the headless host does the
same, so it counts video frames however many `waitFrame()`s a loop pass takes. The mouse is
still not carried to the program (`input.pointer()` is false), and
`emulator.wasm.limits` says what else differs from VERA.
