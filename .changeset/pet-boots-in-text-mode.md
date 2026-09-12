---
"@8bitscript/pet": patch
---

PET text is now drawn for the character set the machine booted into, and no program changes that set any more.

The character-set bit is one register for the whole screen, and it is retroactive: it chooses the ROM the video hardware reads *now*, so flipping it re-renders every cell already drawn, BASIC's included. `text.8bs` used to select the text set before each run of text, which meant a program could either leave the machine switched — handing the owner of a 3032 a lower-case `ready.` prompt they never chose — or put it back at exit and turn the text it had just drawn into graphics glyphs. On the 2001, which already exited correctly, putting it back was a pure regression.

Which set the ROM boots into is a per-model constant, so it is a fact now — `video.bootsInTextMode`, true for the business-keyboard editor ROMs (the 8032 here), false for the 2001, 3032 and 4032 — and `asciiToScreenCode` simply addresses whichever set is already live. Measured on all three: each shows a readable greeting above a BASIC prompt still in its own boot mode. A machine that boots into the graphics set has one case of the alphabet, so text draws in capitals there, which is what a PET in its power-on set has always looked like; an 8032 keeps real mixed case.

Nothing writes `$E84C`, so the `restoreOnExit` save/restore never triggers and hello-world got smaller — 103 bytes, against 108 before any of this and 116 with the restore. `restoreOnExit` stays on by default for a program that pokes `viaPeripheralControl` itself.
