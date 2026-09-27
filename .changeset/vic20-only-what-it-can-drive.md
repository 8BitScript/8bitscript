---
"@8bitscript/vic20": patch
---

The VIC-20's catalog offers only hardware something in this repository can actually drive: its `mouse1351` and its `drive` are gone.

Both were the C64 drive's case over again — an option VICE accepts, a fact it moved, and no code anywhere that could act on the result.

`port1: mouse1351` set `input.mouse: true`, and `packages/vic20/src/pointer.8bs` had already written down why that was empty: "this repository has no 1351 driver for the VIC-20... there is nothing to draw and nowhere to draw it from, in that order." It is not a driver waiting to be ported, either. A 1351 on a C64 is read by the SID's pot lines; the VIC-20 has no SID, so one here would have to be read through the VIC's own analogue inputs at `$9008`/`$9009` — a different driver nobody has written or measured, and `packages/vic20/AGENTS.md` still marks the 1351 on this machine *to verify* on real hardware. The port now offers nothing, a joystick, or paddles, which is what the machine does.

`drive` moved `storage.save` and `storage.kib` and passed `xvic` nothing, exactly as the C64's did. Nothing in this repository saves anything yet — no package calls a KERNAL save, no `.8bs` surface offers one — so it graded builds against a medium that was never attached.

The stock sheet keeps `storage.save: true` and `storage.kib: 164`: a VIC-20 with a 1541 is a fair assumption for a program to make. What is gone is the choice, and the two facts that were set by nothing.

Both come back with their drivers. The comments in `input.8bs`, `pointer.8bs` and `AGENTS.md` that described the removed options now describe their absence and the reason for it.
