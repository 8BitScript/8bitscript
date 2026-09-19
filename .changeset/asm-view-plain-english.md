---
"8bitscript-lang": minor
---

"View Generated Assembly" now explains itself. Each run of instructions is introduced by the source line it came from (`; line 98: screen.blank(...)`, the way the `.lst` already does), and every instruction carries a plain-English comment saying what the machine does — `LDA #$06  ; A = 6`, `STA $02  ; keysBefore = A`, `JSR $0668  ; call screen_blank`, `BEQ $043C  ; if zero, loop back to $043C` — with the program's own globals and functions named in place of bare addresses wherever the debug map knows them, and never guessed where it doesn't. The per-instruction column is on by default and toggled from the assembly tab's title bar (**Toggle Plain-English Comments**, `8bitscript.assemblyView.explain`), re-rendering open tabs in place without a rebuild; a compiler-inserted instruction's reason now reads `(compiler-generated: branch-relaxation)`, matching the `.lst`.
