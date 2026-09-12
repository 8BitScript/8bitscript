---
"@8bitscript/examples": patch
---

`joystick`, the controller test app, ships as the second example: an on-screen map of everything `@8bitscript/input` exposes, lit as it is pressed, so a human can see at a glance whether input works on a machine in front of them.

Six lamps — UP, DOWN, LEFT, RIGHT, CONFIRM, CANCEL — a **SEEN** counter of every press the program has ever been handed, a **FRAME** counter that separates a frozen program from an idle one, and a **KEY/JOY/PAD** line reporting `#fact(input.keyboard)`, `#fact(input.joysticks)` and `#fact(input.pads)` so a dark map can be read as "nothing was pressed" rather than confused with "this layer does not read what this machine has".

A lamp is a **press that was seen, not a control that is held**, and the screen says so. `@8bitscript/input` is edge-triggered by design and offers no level query for directions or buttons (`pointer()` is the only level-triggered call on the surface), so the app latches each edge for 15 frames and draws that as a flash. Holding a direction flashes the lamp once, which is exactly what the API reported.

The highlight is `text.setReverse`, never colour: the PET, the Atari 8-bit and the NES have no per-cell colour at all. Built and screenshotted on all nine targets, plus the PET 8032's 80-column profile. Program bytes, stock hardware, 2026-09-12: pet 2298 (of 3071 on a 4K 2001), vic20 2414 (of 3583 unexpanded), c128 2412, mega65 2436, c64 2571, atari8 2633, cx16 3258, nes 40976 (fixed ROM), web 117 bytes of constant data.

Two things the idle screenshots found, neither fixed here because both are outside this package:

- **The MEGA65 counts one CONFIRM that nobody pressed**, at start-up, once — measured at 300, 600, 1200 and 2400 frames under xmega65. `confirm()` there is RETURN *or* joystick-2 fire, so which one it was decides the fix; a scratch build read CIA1 on the first frame, before `input.poll()`, and found RETURN down (`002`) and the stick clear (`000`), where the identical probe on a C64 and a C128 — same CIA, same addresses, same autostart — read `000`/`000` with SEEN at `00000`. Every layer starts its edge detector with an empty previous-frame snapshot, so anything already held at the first `poll()` reads as a press that just began: the emulator's `RUN` here, a player holding fire as the program loads on real hardware. `begin()` priming the snapshot with one read would close it for every machine at once.
- **On the Commander X16 a cell printed in reverse cannot be printed back to normal.** `@8bitscript/cx16/text` implements reverse as a swap of VERA's attribute nibbles, and its non-reverse path deliberately keeps the cell's existing background nibble so a print does not undo `screen.setBackground` — but a reverse print has already written the text colour into that nibble. A reverse-video spinner left its whole track lit behind it as one solid bar (x16emu, 2026-09-12); it was replaced by the frame counter. `@8bitscript/ui/menubar` un-inverts a deselected item the same way and looks likely to have the same problem.

What the surface could not express, as design input for widening it: no level query at all (`pointer()` is the only level-triggered call, so a controller map cannot show a control as *held*); `confirm()` is an OR of A-or-START on the NES and RETURN-or-fire on the Commodores, so the app cannot say "A works, START does not"; `SELECT` is unreachable; a direction cannot be traced to the cursor keys rather than the stick; and every layer reads one joystick port where the facts declare two.

`packages/examples/test/examples.test.mjs` now drives both examples from the manifest and links each for all nine targets — the loop was seven, predating the Atari 8-bit and NES native backends.
