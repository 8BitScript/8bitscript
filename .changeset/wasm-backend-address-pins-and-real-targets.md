---
"@8bitscript/compiler": minor
"@8bitscript/cli": minor
---

The wasm backend lowers an `@address(...)`-pinned scalar, and `8bs build --target <machine> --web` can compile a real machine's own package through it, not just the synthetic `web` target.

An `@address`-pinned scalar (a real hardware register, like the PET's `viaPeripheralControl`) used to be refused unconditionally, array or not — the whole `@address` case was one refusal, "not lowered yet." A pinned scalar now gets exactly what a pinned array already gets: a fixed byte (or two) in linear memory a host can read or write directly, with no chip behind it, lowered at both a bare read (its value, not its address — the opposite of an array's pointer decay) and an assignment. A pinned *array* is still refused; nothing needed one yet to prove this against.

That single gap was the only thing standing between "the web target's own reimplementation of a machine's screen" and "the machine's own package, actually compiled through the wasm backend." `compile()`'s wasm branch used to fire only for the literal target name `'web'`; a program's imports were already resolved against whichever real machine it was built for (`link()`'s own `machine: target`), so the branch only needed widening, not rewriting. Verified against the PET: `hello-world`'s real `@8bitscript/pet/text` — the same file a native PET build uses, `viaPeripheralControl` write included — now compiles and runs through the wasm backend, and its screen RAM comes out byte-for-byte the PET's own documented screen-code table for "Hello World!".

Not every machine's modules are wasm-shaped yet: the VIC-20's `text.releaseCursor()` still reaches an `asm6502` block (real 6502 machine code, which nothing here executes), and building it through `--web` is refused by name rather than silently producing something wrong. Porting a module past that wall is real, per-module work this changeset does not attempt.
