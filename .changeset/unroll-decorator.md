---
"@8bitscript/compiler": minor
---

A program can mark a `for` loop `@unroll` to fully unroll it — paying code size for the cycles a 6502-family branch back to the top of the loop costs every iteration, past the automatic string-copy unroll's small cap. Refused, with a clear diagnostic (`8BS3006`), when the loop is not a plain counted one, when its bound folds to something other than a small positive number (`UNROLL_DECORATOR_MAX`, 4096), or when its body breaks or continues — a jump that has nowhere to go once the loop is gone.

Also fixes a latent bug in the `.8bx` component-composition pass (`elaborateBx`): it rebuilt `if`/`while`/`for`/block statements from scratch and silently dropped any decorator on them. Nothing exercised this before, since `@address` only ever sits on a top-level declaration; `@unroll` is the first decorator meant for a loop.
