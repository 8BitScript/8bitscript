---
"@8bitscript/pet": patch
"@8bitscript/vic20": patch
"@8bitscript/c64": patch
"@8bitscript/c128": patch
"@8bitscript/atari8": patch
"@8bitscript/nes": patch
"@8bitscript/cx16": patch
"@8bitscript/mega65": patch
"@8bitscript/web": patch
---

`input.begin()` primes the edge detector, so a control already held when a program starts is no longer reported as a fresh press.

Every machine's input layer keeps `before` (what was held at the previous poll) and reports an edge as "held now, not held before". `before` started at zero, so on the very first `poll()` anything already down looked like it had just been pressed — on all nine machines, since they all share the shape.

Found by the new `joystick` example, which counts every press it is handed: on the MEGA65 it read `SEEN 00001` at start-up with nothing touched, at every frame count from 300 to 2400, while the C64, C128 and VIC-20 read `00000`. A scratch probe reading CIA1 directly on the first frame showed why — RETURN down (`$02`), stick clear — so it was a real key, really held, really reported as a press nobody made. `begin()` now takes one poll, so the program's first poll compares against reality.

It costs about 210 bytes per program, because `poll()` gains a second call site and stops being inlined into the loop. 2048 on a stock 4K PET goes from 2413 to 2624 bytes against ~3071 available, and the joystick example fits every machine including the unexpanded VIC-20. Measured after the fix on the MEGA65: `SEEN 00000`, with the frame counter still running.
