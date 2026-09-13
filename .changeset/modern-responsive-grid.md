---
"@8bitscript/cli": minor
"@8bitscript/web": minor
"@8bitscript/text": minor
"@8bitscript/screen": minor
"@8bitscript/atari8": minor
"@8bitscript/c128": minor
"@8bitscript/c64": minor
"@8bitscript/cx16": minor
"@8bitscript/mega65": minor
"@8bitscript/nes": minor
"@8bitscript/pet": minor
"@8bitscript/vic20": minor
---

A grid that follows the window, on the web target's Modern host only.

Modern is 8BitScript's own invention — no chip to be faithful to, so the grid
was always a decision — and it now changes shape while a program runs: 48×27
in a landscape window, 27×48 in a portrait one, 42×31 at 4:3, from one .wasm
and without restarting the program. Every machine skin is untouched: a C64 is
40×25 because a C64 is 40×25.

Two new pieces of portable API, both of which fold to constants on a machine
whose grid cannot change — a PET 2001 image built against them is byte-for-byte
identical to one written the old way:

  - `text.columns()` / `text.rows()` — the live grid
  - `screen.RESIZABLE` / `screen.resized()` — whether it can change, and
    whether it just did

(`text.fill()`, which a derived layout also needs, ships separately.)

Two bugs found while building it, both in the web target:

  - `screen.blank()` left the color bytes alone. Reverse video rides in bit 7
    of the color byte here, and the host paints a reverse cell as a solid
    block whatever the character is — so a "blank" screen kept every reverse
    block that had been on it.
  - `Video.cells()` multiplied two `utinyint`s. On a 27×48 grid that product
    is 1296, which does not fit, so `blank()` cleared 16 cells instead of all
    of them.
