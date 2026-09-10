# Working on the compiler

This file is for anyone — human or agent — changing `@8bitscript/compiler`.
Read the root [`AGENTS.md`](../../AGENTS.md) first; its two rules apply
here without exception, and the second one is this package's job:

> **If the compiler can do it, the compiler does it.**

A byte of RAM or program space that a program spends working something
out at run time, when the answer was knowable while it was being
compiled, is a byte this package wasted.

Layer-specific rules live next to the layer. The lexer's are
[`src/lexer/AGENTS.md`](src/lexer/AGENTS.md). If you are adding a
keyword, a literal form, a `#name`, or a diagnostic the scanner emits,
start there.

## What this package is

The compiler is the single source of truth for what the language is:
lexer, parser, fold, checker, IR, linker, and the native 6502 and
WebAssembly backends. `8bs check` / `8bs build` / `8bs run` call it;
the language server forwards its diagnostics, hover, and completion;
the VS Code extension colors names this package owns.

It is not the only place the language is *described*. The root
`AGENTS.md` section "Changing a core part of the language" is the
checklist for a change that touches a builtin, keyword, type, literal
form, or diagnostic — docs, IntelliSense, the language server, the
editor grammar and snippets, and any per-target `AGENTS.md` that the
change affects. Those copies do not update themselves.

## The pipeline

Text goes through the layers in order. Each layer is a pure function
over what the previous one returned, plus the source text for spans.
None of them talk to the filesystem; the linker is the first thing that
does.

| Layer | Input | Output |
| --- | --- | --- |
| lexer | source text | tokens and lexical diagnostics |
| parser | tokens | AST and syntax diagnostics |
| fold | AST | the same tree, with `#name(...)` calls resolved |
| checker | AST | type/range diagnostics |
| IR / backends | AST | the image, once a backend emits one |

The linker still returns every function and global an import declares.
Each backend's `build()` then runs `optimizeReachable` (prune, fold
constant `if`s and compile-time calls, prune) before lowering, so a
`#fact` branch and a print of a string literal cost the unused side /
the conversion loop nothing. `checkHardwareHazards` still sees the
unpruned IR from `link()`.

Two properties every front-end layer shares, because an editor runs
them on every keystroke:

- **Never throw.** Half-typed source is the normal input. Record a
  diagnostic, recover, keep going. A file with ten mistakes yields ten
  diagnostics and a partial tree, not one diagnostic and nothing.
- **Spans come from the tokens.** A diagnostic's `start` and `length`
  are a token's (or a slice the lexer already marked). Do not
  recompute a position by scanning the file again.

## The lexer, in brief

The lexer is a hand-written scanner in `src/lexer/index.mjs`. That is
the right approach for this language and this is not a candidate for a
generator. It classifies keywords and type names, matches operators by
maximal munch against a real list, treats `#name` and `@name` as single
tokens, swallows `asm6502` bodies whole, and splits a template into one
token with field spans the parser re-lexes.

The details — `%` vs binary, why a newline always ends a string, why
comments have to be skipped when looking back, how `asm6502` counts
braces — are in [`src/lexer/AGENTS.md`](src/lexer/AGENTS.md). Do not
duplicate them here; they go stale the first time the scanner changes.

## Names and `#`

A `const` is `UPPER_SNAKE`; a variable starts with a lower-case letter.
The checker enforces both (`8BS1034`). A construct the compiler
resolves is spelled a literal, a `const`, or `#name(...)`. Everything
else runs on the machine. A new compile-time function is a `#name`; a
new runtime builtin is not. The lexer is what makes that spelling a
token rather than punctuation plus an identifier — see the lexer's
file for the token kinds.

## Tests

`packages/compiler/test/` is the suite, run with `pnpm test` from this
package. Most cases are bugs that actually shipped, kept so they cannot
ship twice. A front-end fix that does not land its reproduction in the
same change is a fix that can ship twice.
