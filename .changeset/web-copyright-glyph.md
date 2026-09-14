---
"@8bitscript/cli": patch
---

The web host's font gains ©, at 0xA9 — the symbol's own Unicode code point,
so a program spells what it means rather than an agreed-on private number.

The font (`packages/cli/src/font8x8.mjs`) is ours: ASCII 32-122 from Hepper's
public-domain font8x8, plus the sixteen 2×2 quadrant blocks at 128-143 this
project added. There is no reason a web build should have to write "(C)" the
way a machine with a character ROM does — none of those ROMs hold the glyph,
but we are not borrowing theirs. The gap between the blocks and 0xA9 stays
blank and costs nothing: `glyphTableLiteral()` skips every code with no ink,
so both renderers (the browser page and `--screenshot`) pick the new glyph up
with no other change.

© is outside the checker's portable character set and cannot appear in a
string literal, so a program reaches it through `putChar(169)` — the same way
"(" and ")" already are on machines whose fonts do have them.
