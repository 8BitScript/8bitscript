---
"@8bitscript/pet": patch
---

PET text is drawn for the character set the machine booted into, and nothing changes that set.

The PET's character-set bit is one register for the whole screen, and it is retroactive: it chooses the ROM the video hardware reads *now*, so flipping it re-renders every cell already on screen, BASIC's included. `text.8bs` used to select the mixed-case text set before each run of text, which meant a program left the machine in a mode its owner never chose — the 3032 and 4032 boot into upper-case/graphics and came back to a lower-case `ready.` prompt.

Which set a model boots into is a fixed fact about it, so it is one now: `video.bootsInTextMode`, true for the business-keyboard editor ROMs (the 8032) and false for the 2001, 3032 and 4032. `asciiToScreenCode` folds on it and addresses whichever set is already live, so nothing writes `$E84C` and there is nothing to restore. Verified on all three models: each shows readable text above a BASIC prompt still in its own boot mode.

What this means for a program: on a machine that boots into the graphics set — every model here but the 8032 — that set holds one case of the alphabet, so `text.print("Hello")` draws `HELLO`. That is what a PET in its power-on set has always looked like. An 8032 boots into the text set and keeps real mixed case.

Programs also get slightly smaller, since no character-set write means no save/restore around them: the `hello-world` example is 103 bytes, against 116 with one.
