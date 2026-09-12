---
"@8bitscript/cli": minor
---

A program now hands the machine back in the character set it was launched in. A PET program that prints selects the text set itself (that is the set `@8bitscript/pet/text`'s encoding is written against), and nothing put it back, so a run on a machine that boots in graphics/upper-case — the 3032 and the 4032 both do — dropped its owner at a lower-case `ready.` prompt they never chose. The prologue now copies the VIA PCR to the CPU stack and the epilogue writes it back: whichever mode the machine was in is the mode it gets back, so an 8032 that booted in text is still in text afterwards. It costs eight bytes and no RAM at all, and only a program whose finished code actually stores to `$E84C` pays them.

`restoreOnExit: false` in `8bitscript.config.ts` turns it off and buys the bytes back. One thing to know before choosing: the PET's charset bit is a single global switch for the whole screen, so restoring it also re-renders whatever the program left on screen through the other ROM — a greeting still up at exit on a graphics-mode PET comes back as graphics glyphs. A program that wants both the machine back and a readable screen blanks the screen before it returns.

The `hello-world` example no longer ends in a `while (true) waitFrame()` holding loop: it prints and returns, landing back in the BASIC `SYS` that started it. Its project file is also now named `8bitscript.config.ts`, the name the toolchain has preferred since 0.4.0.
