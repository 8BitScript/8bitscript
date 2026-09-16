---
title: Compiler
nav_order: 40
---

# Compiler

The `@8bitscript/compiler` package is the single implementation behind
`8bs check`, `8bs build`, and the language server. Every layer is a pure
function over the previous one's output (plus source text for spans); only
the linker touches the filesystem.

## Pipeline

| Layer | Input | Output |
| --- | --- | --- |
| lexer | source text (`.8bs` or `.8bx`) | tokens and lexical diagnostics; in `.8bx`, tag/children/expression modes give element syntax its own tokens |
| parser | tokens | AST and syntax diagnostics |
| fold | AST | the same tree, with `#name(...)` calls resolved |
| binder | AST | symbols, scopes, binding diagnostics |
| checker | AST | type/range/component diagnostics |
| 8BX elaboration | AST with BX nodes | core AST: a component is a function (two, around its `<slot />`), an element is a call to it; `state` is a template global per field, cloned per instance by the linker (no BX in backends) |
| IR / backends | AST | the image, once a backend emits one |

Two source kinds share this pipeline:

| Extension | Kind | Grammar |
| --- | --- | --- |
| `.8bs` | 8BitScript | core language |
| `.8bx` | 8BitX | core language + 8BX elements and components |

## Editor and CLI contract

`analyze()` never throws. Diagnostics use stable `8BS` codes; spans come
from tokens, not recomputed from file text.

Import resolution is optional in `analyze()` (enabled for `8bs check` and
`file:` documents in the language server) because it is the only part that
reads the module graph on disk.

`link()` reads every module in the graph as far as its own symbols
first, binds each import that names an exported component to that
component, then finishes each module — element checks, elaboration,
folding, checking, lowering — and links the IR. Backends receive
optimized IR; they do not parse 8BX. A component call whose arguments are
all compile-time values is inlined by the linker's optimizer, so a static
composition costs what hand-written calls would.
