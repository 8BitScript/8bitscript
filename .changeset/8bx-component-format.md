---
"@8bitscript/compiler": minor
"@8bitscript/cli": minor
"@8bitscript/language-server": minor
"@8bitscript/ui": minor
"@8bitscript/examples": minor
"8bitscript-lang": minor
---

8BX (`.8bx`): a `component` declaration that elaborates to a plain call
before any backend sees it, so a declarative element (`<Foo bar={baz} />`)
costs exactly what writing `foo(baz)` by hand would cost — measured
byte-identical on the PET in the new `hello-bx` example (108 bytes, same as
`hello-world`).

The front end grows a binder (`packages/compiler/src/binder`) that resolves
symbols and scopes ahead of the checker, and a `bx/` pass
(`check.mjs`, `elaborate.mjs`, `parse.mjs`) that parses element syntax at
statement boundaries — `<`, `<<` and the rest of the operator grammar are
unchanged in either source kind — checks it, then elaborates it into the
core AST the checker, folder and every backend already understand.
`analyze()`, `link()` and the language server all run binding and BX
elaboration before folding and checking, for both `.8bs` and `.8bx` files.

Also: a conditional expression (`cond ? a : b`) lowers to real branching
IR and MOS instruction selection, editor support for `.8bx` (grammar,
language registration, activation), and `docs/compiler.md`, which replaces
the `8bx` design-direction doc with a description of the pipeline as
built.

Not in this release: array-typed component props, and no backend beyond
mos/wasm has been asked to prove elaboration is free — only the PET and
web are measured.
