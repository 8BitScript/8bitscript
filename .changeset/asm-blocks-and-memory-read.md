---
"@8bitscript/compiler": patch
---

`asm6502` blocks and `memory.read()` lower on the 6502 backend — the last two rules C64 hello-world was missing.

An `asm6502` block reaches the backend as raw source, because nothing before it had any reason to know what assembly looks like. `mos/asm/parse.ts` reads it into ordinary `Directive`s, so the assembler, the branch relaxer and the linker cannot tell which instructions a human wrote. The syntax is the one the machine packages already use, read out of them rather than invented: implied, immediate (`$hex`, `%binary`, decimal), zero page and absolute chosen by the literal's own written width, the indexed and indirect shapes, `;` and `//` comments, named labels, and GNU-style local labels with backward and forward branches (`1:` … `bne 1b`, the c128 mouse-settle loop). A mnemonic with no zero-page form widens rather than being refused, so `jsr $84` assembles. Anything else is refused by name, with the line of the block it was on.

`memory.read(addr)` is `memoryWrite`'s counterpart and takes the same two shapes: a constant address is one `LDA`, a computed one goes through a zero-page pointer with Y held at 0.

The C64's polite zero-page budget widens from `$FB-$FE` to `$F7-$FE` — the four bytes BASIC and the KERNAL both leave alone, plus the four RS-232 buffer pointers, which are free until something opens a serial channel. Eight bytes, and `screen.blank()`'s own frame wants seven of them.

The PET is unchanged: hello-world 108/108/127 bytes across the 2001, 3032 and 8032.
