---
"@8bitscript/cx16": minor
"@8bitscript/cli": minor
---

The Commander X16's wasm build draws the portable raster list (`Slot.BORDER`,
`BACKGROUND`, `SCROLL_X` and `CHARSET` at their picture lines, a list that takes
effect on `commit()` or `enable()` as the VERA handler's does), so `examples/fancy`
builds and draws for `8bs build --target cx16 --web`. `raster.frame()` is real there:
the page adds one to a byte of the program's memory (the X16's layout only; program
data starts one byte higher) each time it releases a frame, and the headless host does
the same, so it counts video frames however many `waitFrame()`s a loop pass takes.
The page also reads a gamepad on every wasm target (D-pad or left stick, A/START to
confirm, B/SELECT to cancel) into the same input byte as the keys, so the X16's wasm
`Input.CONFIRM_LABELS` is the native build's `RETURN OR START`. The mouse is still not
carried to the program (`input.pointer()` is false), and `emulator.wasm.limits` says
what else differs from VERA.
