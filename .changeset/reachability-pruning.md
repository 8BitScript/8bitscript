---
"@8bitscript/compiler": minor
"@8bitscript/atari8": minor
"@8bitscript/c64": minor
"@8bitscript/c128": minor
"@8bitscript/cli": minor
"@8bitscript/cx16": minor
"@8bitscript/examples": minor
"@8bitscript/input": minor
"@8bitscript/language-server": minor
"@8bitscript/mega65": minor
"@8bitscript/nes": minor
"@8bitscript/pet": minor
"@8bitscript/pointer": minor
"@8bitscript/random": minor
"@8bitscript/screen": minor
"@8bitscript/studio": minor
"@8bitscript/system": minor
"@8bitscript/text": minor
"@8bitscript/ui": minor
"@8bitscript/vic20": minor
"@8bitscript/web": minor
"8bitscript-lang": minor
---

Both native backends (`mos` and `wasm`) now compile only what a
program's entry can actually reach, instead of every function and
global an import brings along whether it's called or not. Measured on
the real, unmodified `hello-world` example: the PET build shrank from
1132 to 835 bytes of program (26% smaller, plus 101 to 49 bytes of
RAM), and the web build's `.wasm` shrank from 614 to 408 bytes (34%
smaller) — one `@8bitscript/text` import used to pull in `putChar`,
`putColor`, `setColor`, `setReverse`, and `printNumber`'s whole
decimal-digit loop alongside the `print()` a program actually calls.
No language, API, or output behavior changed — only what nothing ever
uses is gone.
