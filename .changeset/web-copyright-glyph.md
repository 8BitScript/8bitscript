---
"@8bitscript/cli": patch
"@8bitscript/nes": patch
---

© at 0xA9, on every target whose character set this project can reach.

The symbol's own Unicode/Latin-1 code point is the code, so a program spells
what it means rather than an agreed-on private number, and the three targets
that can draw it all agree on it:

- **web** — the host font (`packages/cli/src/font8x8.mjs`) is ours: ASCII
  32-122 from Hepper's public-domain font8x8, plus the sixteen 2×2 quadrant
  blocks at 128-143 this project added. The gap between the blocks and 0xA9
  stays blank and costs nothing: `glyphTableLiteral()` skips every code with
  no ink, so both renderers (the browser page and `--screenshot`) pick the
  new glyph up with no other change.
- **NES** — the CHR-ROM is ours too (`packages/nes/native/6502/font.s`), and
  now draws the same artwork at the same tile. Tile $A9 sat inside the
  reverse-video run as the reverse of `)`, and `)` has no glyph in this font
  to reverse, so what it displaced was an inverted blank. No portable
  character's reverse lands there either — the portable set maps to $A0,
  $A1, $AC-$AE, $B0-$B9, $BA, $BF, $C1-$DA and $E1-$FA.
- **Commander X16** — nothing to add. The screen runs in ISO mode, where
  VERA's tile index IS the character code, and the KERNAL's ISO-8859-15 set
  already holds © at 169. `packages/cx16/test/charset.test.mjs` reads it out
  of the installed `rom.bin` and asserts the artwork, so that is a measured
  fact rather than a code chart quoted from memory; it skips when no ROM is
  installed.

The other six targets do **not** gain the symbol, and the headers say so.
The PET, C64, VIC-20, C128, MEGA65 and Atari 8-bit draw from a character
generator this build does not replace, and none of those ROMs holds a © at
all — every chargen VICE ships, plus the Atari OS and MEGA65 ROMs, was
scanned for one. `putChar(cell, 169)` there draws whatever its ROM happens
to have at that code. They join when a redefined-charset layer exists, which
no machine has yet.

© is outside the checker's portable character set and cannot appear in a
string literal, so a program reaches it through `putChar(169)` — the same
way `(` and `)` already are on machines whose fonts do have them.
