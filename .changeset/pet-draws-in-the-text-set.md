---
"@8bitscript/pet": patch
"@8bitscript/compiler": patch
"@8bitscript/cli": patch
---

PET text is now drawn in the machine's text character set, so a string reaches the screen as it was written — and nothing puts the old set back on the way out.

`"Hello World"` is `Hello World`, not `HELLO WORLD`. The PET's graphics set holds exactly one case of the alphabet, so a text package that encodes for it silently flattens mixed-case text to capitals — answering a different question than the one the caller asked. The text set holds both cases, so `@8bitscript/pet/text` draws in that one and selects it first on the models that boot elsewhere. The 8032's editor ROM already boots into it, so `#fact(video.bootsInTextMode)` folds the write away there and no `$E84C` store reaches the binary at all.

`video.characterSetSwapped` matters again as a result: the original 2001's 901447-08 ROM arranges the text set's two cases the other way round from every later model's (upper case stays at 1-26, lower case moves to 65-90 — verified glyph by glyph against the ROM, where code 8 is `H` and not `h`). A build for the 2001 gets that mapping; a build for anything else gets the other.

**`restoreOnExit` is removed**, along with the `usesCharacterSet` scan and the `LDA $E84C`/`PHA` … `PLA`/`STA $E84C` pair it drove. Restoring the character set could never work: the bit is retroactive — it selects the ROM the video hardware reads for every cell already on screen — so writing the old value back re-rendered the text the program had just drawn, through the very set it switched away from in order to draw it. Measured on a 3032, `Hello World!` came back as `|ELLO OORLD!` above a correct prompt. A program now exits in the set it selected, which is the only state where what it drew still reads as what it wrote. A project that still sets `restoreOnExit` is told the option is retired rather than having it quietly ignored.

Measured under xpet on all three models: the 8032 shows `Hello World!` over its own `ready.` and spends nothing; the 2001 shows `Hello World!` over an upper-case `READY.`, because its ROM's two sets agree on codes 1-26 where BASIC's prompt is drawn; a 3032 shows `Hello World!` over a lower-case `ready.`, which is the whole of what this costs. hello-world is 108 bytes on a 3032, against 116 when the restore was still being paid for.
