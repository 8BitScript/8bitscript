---
title: The compiler
nav_order: 3
---

# The compiler

8BitScript is compiled, not interpreted. `8bs build --target vic20` produces a
`.prg` containing real 6502 machine code; nothing of 8BitScript is present on
the machine at run time. The compiler itself is an ordinary Node program.

This page is the build plan and the current state of it. Most of the pipeline
does not exist yet, and this page says plainly which parts do.

## The pipeline

```
main.8bs
   |
   v
 lexer  ->  parser  ->  AST  ->  binder  ->  checker  ->  IR
                                                          |
                        +---------------------------------+
                        |                                 |
                        v                                 v
                   web backend                     6502 backend
                        |                                 |
                        v                                 v
             generated AssemblyScript              generated C
                        |                                 |
                        v                                 v
                       asc                mos-vic20-clang / mos-c64-clang
                        |                                 |
                        v                                 v
                     .wasm                              .prg
```

The order matters. Lowering to an IR before either backend means the two
targets share a front end and a set of optimisations, rather than each
re-deriving the language from the AST.

Generating C for the 6502 rather than emitting assembly directly is a
deliberate hand-off: LLVM-MOS already does register allocation, zero-page
allocation, and instruction selection better than a first-generation backend
would, and that leaves the effort here on the language.

## Where it actually is

| Layer | State |
| ----- | ----- |
| Diagnostics | **Implemented.** One record shape, one source of truth |
| Lexer | **Implemented.** Tokens with offsets; reports lexical errors |
| Parser / AST | **Implemented.** Recovers from errors; every node carries its span |
| Checker | **One rule implemented** — integer literal range, now on the AST |
| Resolver | **Implemented.** Checks imports against the package contract |
| IR + lowering | **Implemented** for the milestone subset; anything else errors |
| 6502 backend | **Implemented.** IR → generated C → LLVM-MOS → `.prg` |
| Web backend | **Implemented.** IR → generated AssemblyScript → asc → `.wasm` |
| Binder | Not started |

The milestone subset compiles and runs on both targets: globals with machine
integer types, functions without parameters, assignment and arithmetic,
`if`/`while`, `@address` hardware globals, and `asm6502` blocks. **Lowering is
exhaustive-with-error**: a construct without a compilation rule fails with a
diagnostic naming it — imports, calls, locals — never by silently dropping
code. `8BS3001` is that diagnostic; a program using any of it does not build.

## Diagnostics first

Every diagnostic is one record, produced in one place:

```
{ code, message, file, start, length, severity }
```

`@8bitscript/compiler` produces them. `8bs check` prints them. The language
server publishes them. No layer re-implements a rule, so the terminal, the
editor, and CI cannot disagree about whether a file is valid.

That is why this came before the parser: a language you are still designing is
far easier to work on when mistakes are visible immediately.

```bash
$ 8bs check src/main.8bs
src/main.8bs:3:17
error 8BS1021: 300 does not fit in u8 (0..255)

1 problem(s) found.
```

The same rule, the same code, and the same message reach the editor through
[the language server](language-server.md).

### Codes

Codes are stable identifiers, so they can be searched for and suppressed later.

| Range | Meaning |
| ----- | ------- |
| `8BS1xxx` | Lexical and syntax problems — findable without resolving names |
| `8BS2xxx` | Resolution and type errors |

Implemented today:

| Code | Meaning |
| ---- | ------- |
| `8BS1002` | Unterminated string literal |
| `8BS1003` | Unexpected character |
| `8BS1004` | Unmatched bracket |
| `8BS1005` | Unclosed bracket |
| `8BS1006` | Unterminated block comment |
| `8BS1007` | Unterminated `asm6502` block |
| `8BS1008` | Invalid number literal |
| `8BS1101` | Syntax error — expected one thing, found another |
| `8BS1021` | Integer literal out of range for its type |
| `8BS2001` | Cannot find package |
| `8BS2002` | Package is not an 8BitScript package |
| `8BS2003` | Package declares an entry that does not exist |
| `8BS2004` | Cannot find a relative module |
| `8BS3001` | Valid construct the compiler cannot lower yet |
| `8BS3002` | Construct not available on the requested target |

Module resolution landed in the 2000s before a binder exists because it needs
no symbol knowledge — only the filesystem. Type errors still wait on the
binder.

## Import resolution

The `8BS2xxx` codes implement the contract in
[the package model](packages.md). Given

```
import { vic } from "@8bitscript/vic20";
```

the resolver walks `node_modules` upward from the importing file, reads the
package's `package.json`, and requires an `"8bitscript".entry` field naming a
file that exists. Each failure has its own code, so "you did not install it"
and "you installed something that is not an 8BitScript package" never look the
same.

This is the only layer that touches the filesystem. The lexer and checker are
pure functions over text, which keeps them trivially testable and means a
broken dependency on disk can never make them fail. It is opt-in for that
reason: `analyze(text, file, { resolveImports: true })`, enabled by `8bs check`
and by the language server for saved files, and left off for an unsaved buffer
that has no path to resolve against.

Two cases are deliberately **not** diagnosed, because the package model does
not specify them: a bare specifier with a subpath (`@scope/name/thing`), and a
relative import without a `.8bs` extension. Neither is guessed at, and neither
is reported.

Resolution currently re-reads manifests on every analysis. At this scale that
is free; it wants a cache once projects have real dependency graphs.

## The checker rule that exists

```
let score: u8 = 300;
```

reports `8BS1021: 300 does not fit in u8 (0..255)`.

It runs on the AST, so it finds declarations anywhere — inside a function body,
inside a `for` initialiser, on an exported declaration — rather than only at the
one shape a token scan could recognise. It began as a token-level stand-in and
moved when the parser landed; the code, the message, and the span did not
change, because a rule finding a better home should not look different to the
person reading the error.

It is still narrow on purpose: the initialiser has to be a literal, optionally
negated. `let x: u8 = 200 + 100` is not folded, because constant folding needs a
binder that knows what names refer to.

The ranges it knows are the machine integer types:

| Type | Range |
| ---- | ----- |
| `u8` | 0..255 |
| `u16` | 0..65535 |
| `i8` | -128..127 |
| `i16` | -32768..32767 |

`u24`/`i24` and `u32`/`i32` are also recognised.

## The parser

Recursive descent, producing the tree the design called for:

```
let x: u8 = 10;
```

```
VariableDeclaration
  name: x
  type: u8
  initializer:
    IntegerLiteral: 10
```

Every node carries the same `start`/`length` span a diagnostic uses. That is
what lets a checker error land on the exact characters that caused it without
anything downstream re-deriving a position.

**Error recovery is the design centre, not a bolt-on.** The parser never throws:
an editor parses on every keystroke, so half-typed source is the normal input.
On an error it records a diagnostic, synchronises to the next statement
boundary, and continues. A file with four mistakes produces four diagnostics and
a usable partial tree — and the checker still runs over what parsed, so a range
error below a syntax error is still reported.

What it parses is exactly what the language has specified: imports,
`let`/`const` with annotations, functions, blocks, `if`/`else`, `while`, `for`,
`return`, `break`/`continue`, assignment and update operators, calls, member
access, indexing, decorators, type constructors (`ptr<T>`, `array<T, N>`,
`volatile<T>`), and `asm6502` blocks. `switch` and `case` are lexed as keywords
but have **no parse rule** — writing one is an honest syntax error rather than a
silent guess at syntax nobody has decided on.

### Assembly is not 8BitScript

The body of an `asm6502 { ... }` block is taken by the lexer as one opaque
token and handed to the backend untouched. Tokenising it as 8BitScript would be
simply wrong: `lda #$06` would report `#` as an unexpected character.

## The first milestone: achieved

The milestone was never "implement TypeScript"; it was that this program
compiles and runs:

```
let x: u8 = 10;

export function main(): void {
    x = x + 1;
}
```

It does, on both targets. `examples/counter` is that program verbatim:

```bash
cd examples/counter
pnpm web        # builds the .wasm, calls main(), prints x = 11
pnpm vic20      # builds the .prg and opens it in VICE
```

(`examples/border` is started with `pnpm start`.)

On the web target the u8 genuinely wraps — 251 calls to `main()` leave `x` at
5, because 261 wrapped at 256. The `.prg` targets the **unexpanded VIC-20**:
load address `$1001` and 3583 bytes of usable RAM, the machine as it was sold.
The SDK's own default is a 24K-expanded machine, so the backend pins the
linker's `__memory_expansion` symbol to 0 — fitting the small machine first is
the point, and expanded configurations can become an option when a program
actually needs one. `examples/border` is the visible
version: an `@address(0x900F)` hardware global incremented in a `while` loop,
which cycles the VIC-20's border and background colours faster than the raster
beam draws them.

The generated C and AssemblyScript are written next to each output in `dist/`,
so what the compiler did is never a mystery.

Features arrive one slice at a time from here: local variables, function
parameters and calls, then the binder that unlocks imports and real type
checking. Each slice extends the lowering; the exhaustive-with-error rule means
a feature is either compilable or clearly reported, with no third state.

## Hardware access is not an afterthought

The escape hatches are part of the language, and they are planned early rather
than bolted on once the abstractions have hardened:

```
@address(0x900F)
let vicColor: volatile<u8>;

asm6502 {
    lda #$06
    sta $900f
}
```

A language for these machines that cannot reach the machine has missed the
point. The editor grammar already highlights this syntax.

## Package layout

The dependency direction is one-way, and it is the important part:

```
                @8bitscript/compiler
                   ^            ^
                  /              \
                 /                \
    @8bitscript/cli      @8bitscript/language-server
                                    ^
                                    |
                             editors/vscode
```

Never the reverse. The compiler knows nothing about any editor, and nothing
about the CLI. That is what allows one checker to serve the terminal, CI, and
every editor at once.
