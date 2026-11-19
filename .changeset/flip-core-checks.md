---
"@8bitscript/cli": patch
"@8bitscript/compiler": patch
---

Prepare the compiler for the new syntax: the checker reports assigning to a plain `let` (8BS1031) by block scope, `findImports` reads `use` paths, and a path-form import searches the source extensions (8BS2217 when two files match).

The block-scope store scan now lives once in the compiler and `8bs migrate` imports it, so the converter and the checker cannot drift.
