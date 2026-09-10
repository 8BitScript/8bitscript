---
"@8bitscript/compiler": patch
"@8bitscript/pet": patch
"@8bitscript/cli": patch
---

Hello-world on the PET was 835 bytes of program and 49 of zero page because
the compiler still emitted both `#fact` branches of asciiToScreenCode, a
runtime ASCII conversion and string loop for `text.print(0, "Hello World!")`,
JSRs into PET `blank`'s empty color stubs, a 16-bit STA (zp),Y screen fill,
a 12-byte waitFrame scratch window, an unrolled 32-bit frameRate multiply
(211 bytes of setup), and zp for helpers the program never reaches. Fold
constant `if`s and never-assigned globals after pruning dead writers, turn a
literal print into stores of already-converted screen codes, skip the string
table entry those stores no longer need, inline a single-site void call
whose parameters are unused, lower a constant fill loop to STA abs,X, and
multiply waitFrame's measured elapsed with a Russian-peasant loop that
reuses the accumulator — measured on the same example: 331 program bytes /
8 zp. The per-frame waitFrame routine is unchanged; the print and fill are
fewer cycles as well as fewer bytes. `--size` still names the inlined
`text_print` / `screen_blank` bodies and splits wait-frame setup from the
per-frame routine, so the report does not collapse into one `main` bucket.
