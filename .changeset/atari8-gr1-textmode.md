---
"@8bitscript/atari8": minor
"@8bitscript/cli": patch
"@8bitscript/compiler": patch
"@8bitscript/ui": patch
---

Atari 8-bit builds can opt into ANTIC 6 (`textmode=gr1`): 20 columns and four playfield colors per character, so `text.setColor` is real instead of an empty stub. Stock GR.0 is unchanged.
