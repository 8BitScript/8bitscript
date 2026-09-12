---
"@8bitscript/compiler": minor
"@8bitscript/cli": minor
"@8bitscript/cx16": patch
"@8bitscript/mega65": patch
---

The Commander X16 builds and runs. The MEGA65 builds.

Four things the backend gained, all of them machine-independent and all of them wanted by these two rather than invented for them:

- **`x / 2^k` is a shift and `x % 2^k` is a mask.** The 6502 has no divide, so `/` was refused by name — but a power-of-two divisor is not really a divide. The X16 package is written in those terms throughout (`memory.read(0x9F35) / 128`, `low / 256`, `attr / 16`, `cell % 256`), which is how a program reads best. Unsigned only: `>>` floors where `/` truncates, so the two disagree on negatives.
- **16-bit `&`, `|` and `^`.** A byte at a time, which is all a bitwise operation ever is — no carry between the halves.
- **Narrowing at every 8-bit boundary**, not just at a local or an assignment: a `memory.write` value, an 8-bit call argument and an array element all take the low byte of a wider expression now, which is what narrowing has always meant.
- **`waitFrame()` for both.** The MEGA65's VIC-IV answers `$D011`/`$D012` like the C64's VIC-II, so it is the same raster poll. The X16 is a third shape: VERA raises a VSYNC bit in its ISR and acknowledging it is writing it back — an edge like the PET's, but needing no calibration, because the X16's frame is exactly 1/60s everywhere. At the default frame rate one VSYNC is exactly one logical frame and the accumulator never carries.

The X16 also needed a start-up its package had documented and the native backend had never emitted: `CHR$(15)` through CHROUT, which switches the screen editor into ISO mode. `@8bitscript/cx16/text` writes ASCII straight to VERA — the tile index *is* the character code there — and without the switch the machine is in PETSCII and every letter draws as a graphic. Two instructions, on the one machine that needs them.

**Measured under x16emu: hello-world is 1370 bytes and prints `Hello World!` over a working `READY.`**

The MEGA65 is **not** un-parked. Its hello-world (251 bytes) and 2048 (3615 bytes) both build, but Xemu shows a one-time onboarding screen that waits for a keypress before it will run anything, so nothing has been seen on screen yet — and un-parking is what switches a machine's emulator tests on. It joins the list when a screenshot can prove it.

2048 does not fit the X16 yet: its deepest call chain wants more zero page than the 94 bytes `$22`-`$7F` the X16 documents as the user's, and taking any of the KERNAL's `$80`+ would need research this workspace does not have.
