---
"@8bitscript/c64": minor
"@8bitscript/compiler": minor
---

C64: `text.print`, `text.printNumber` and `text.fill` in native code, and an `asm6502` block may name its own frame.

- `@8bitscript/c64/text`: the three run routines are `native/6502/text.s` now, one linked section each. Measured with CIA 2 timer A around one call (`test/text-timing-probe.8bs`): a nine-character `print` 1,908 → 498 cycles, a five-digit `printNumber` 2,944 → 1,265, a forty-cell `fill` 8,078 → 1,110 — a HUD line was a fifth of an NTSC frame under the compiler's generic code, with a `place()` call and two more inside it for every cell. `text.putChar`/`putColor` are unchanged; `fill` now calls `prepare()` first like the other two (the picture set up, the mixed-case set selected in text mode), where before it wrote without. The routines read their arguments from page `$07` (the KERNAL's dead screen, beside the raster list's `$04`/`$05` and the multiplexer's `$06`).
- Compiler: an `asm6502` operand that names one of the function's own parameters or locals is that slot's zero-page address — `lda cell`, `ldx cell+1`, `lda (s),y`, `lda #<cell` — in the zero-page form of the instruction; any other symbol is still a linker label, and `jsr`/`jmp`/a branch to a frame name is refused. The optimizer counts a name written in a block's text as a read, so a parameter only the block uses is still passed. This is what lets a package hand a string parameter's pointer to native code.
