---
"@8bitscript/cx16": patch
---

X16 `input` reads Enter, arrows, and the SNES pads.

`waitFrame()` holds `sei`, so the KERNAL IRQ never scans the keyboard or
the pads. `poll()` now calls `joystick_scan`, `kbd_scan` and `joystick_get`
in that IRQ's order: joy0 is the keyboard joystick (Enter is START), joy1
and joy2 are the two catalog pads. 2048's title screen can leave.
