---
"@8bitscript/c128": patch
---

C128 `input` reads the dedicated cursor keys on `$D02F`.

x128's C128-mode keymap sends host arrows to those four keys (VICE column
10), not the C64 CRSR pair. The layer still scans CIA1 for CRSR+SHIFT and
joystick 2; it now also drives K2 and or's the real arrows into the same
directions. The rest of the extra matrix (keypad, HELP, ALT) stays unread.
