---
"@8bitscript/compiler": patch
---

Lexer lookbehind for `%` vs binary skips comments and treats `true`/`false` as operands; strings no longer continue across a newline after `\`; `asm6502` brace matching skips assembly comments. Document the scanner's rules in `packages/compiler/src/lexer/AGENTS.md`.
