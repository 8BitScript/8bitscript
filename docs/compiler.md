---
title: The compiler
nav_order: 3
---

# The compiler

8BitScript is compiled, not interpreted. `8bs build --target vic20`
produces a `.prg` containing real 6502 machine code; nothing of 8BitScript is
present on the machine at run time. The compiler itself is an ordinary Node
program.

This page is the build plan and the current state of it. Most of the pipeline
does not exist yet, and this page says plainly which parts do.

## The pipeline

```
main.8bs
   |
   v
 lexer  ->  parser  ->  AST  ->  binder  ->  checker  ->  IR
                                                          |
                                                        linker
                                             (every imported module goes
                                             through the same front end;
                                             the IRs merge into one program)
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
| Linker | **Implemented.** Loads the import graph, binds names across modules, merges IR |
| 6502 backend | **Implemented.** IR → generated C → LLVM-MOS → `.prg` |
| Web backend | **Implemented.** IR → generated AssemblyScript → asc → `.wasm` |
| Binder | Not started |

The milestone subset compiles and runs on both targets: globals with machine
integer types, functions without parameters, parameterless calls in statement
position, assignment and arithmetic,
`if`/`while`, `@address` hardware globals, `asm6502` blocks — and imports,
which the linker resolves across modules. **Lowering is
exhaustive-with-error**: a construct without a compilation rule fails with a
diagnostic naming it — calls with arguments, member access, locals — never by
silently dropping
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
| `8BS2005` | Imported name is not exported by the module it names |
| `8BS2006` | Imported name collides with another binding in the module |
| `8BS2007` | Reference to a name that resolves to nothing |
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

The resolver and the linker are the only layers that touch the filesystem.
The lexer and checker are
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

## The linker

`8bs build` does not compile a file; it links a program. The linker starts at
the entry module, resolves every import to a file (the same rules as above),
runs the full front end over each module it discovers, and merges the IRs into
the one program the backends already understand. The backends did not change
for modules to arrive — linking happens entirely on the IR.

The model is the per-module namespace [the package model](packages.md)
promises: a module sees its own top-level declarations plus what it imports,
and nothing else. Because the merged program becomes one translation unit,
symbols are renamed to keep modules apart — a symbol keeps its source name
when it is free (the entry module claims first, so `main` stays `main`), and
takes a `_2`-style suffix when another module got there first. References are
rewritten module by module, which is also what makes `import { x as y }`
aliasing work. `asm6502` text is the one thing never rewritten: inline
assembly naming a symbol sees its final, possibly-suffixed name.

The linker is where names first mean something, so three diagnostics live
here: importing a name a module does not export (`8BS2005`), importing a name
already bound in the module (`8BS2006`), and referencing a name that resolves
to nothing (`8BS2007`). The last one is load-bearing rather than cosmetic:
with renaming in play, an undeclared name that slipped through could silently
capture another module's symbol, and "nothing silent" is the rule.

Two boundaries, stated as decisions. `8bs check` stays per-file — it is the
editor's view, and it reports what analysis of one file can know, so an
import of a name that does not exist surfaces at build time, not check time;
cross-module analysis joins `8bs check` when the binder exists. And the
linker does no reachability pruning — every module's globals and functions
are emitted whether used or not. Hardware registers are `#define`s and cost
nothing; pruning earns its place when packages ship more than registers.

What crosses module boundaries today is exactly what the milestone subset can
express: globals, including `@address` hardware globals, and parameterless
functions, which can be called in statement position. One consequence is
stated as a decision rather than left to be discovered: an imported global is
a writable alias — assigning to it assigns to the exporting module's global.
That is the opposite of JavaScript's read-only import bindings, and it is
deliberate: globals are the only channel for passing a value across a module
boundary until functions take parameters.

Packages can also make their entry **target-conditional**: an
`"8bitscript".entry` object keyed by machine resolves to that machine's
implementation at build time, and a machine the object has no branch for is
`8BS3002`. The mechanics and the delegation form live in
[the package model](packages.md); `@8bitscript/machine` is the working
example.

## Primitive integer types

8BitScript's integer type names are MySQL-inspired rather than
systems-programming abbreviations, because "a 3-byte integer" reads more
plainly to someone who has never seen `i24` than the abbreviation does:

| Canonical | Low-level alias | Signed | Range |
| ----------- | --- | :---: | ----- |
| `tinyint` | `i8` | yes | -128..127 |
| `utinyint` | `u8` | no | 0..255 |
| `smallint` | `i16` | yes | -32768..32767 |
| `usmallint` | `u16` | no | 0..65535 |
| `mediumint` | `i24` | yes | -8388608..8388607 |
| `umediumint` | `u24` | no | 0..16777215 |
| `int` | `i32` | yes | -2147483648..2147483647 |
| `uint` | `u32` | no | 0..4294967295 |

The name encodes storage size directly: `tinyint` is 1 byte, `smallint` is 2,
`mediumint` is 3, `int` is 4 — the same convention MySQL uses, and `u` still
means unsigned. `int`/`uint` are the 4-byte types on every target, VIC-20, C64,
or web; nothing about their size varies by architecture.

The low-level aliases (`i8`, `u8`, ...) are not a separate, smaller type
system kept around for compatibility — every stage of the compiler resolves
both spellings of a type to the same descriptor before doing anything with it,
so `let x: utinyint = 1;` and `let x: u8 = 1;` produce identical diagnostics,
IR, and generated code. `bigint`/`ubigint` are reserved for a future 8-byte
type and are not recognised yet.

All of this — the spellings, the ranges, the aliasing — comes from one
registry in `packages/compiler/src/types/index.mjs`. The lexer, the checker,
both backends, and the language server's hover/completion all read it rather
than keeping their own copy, so a type can't mean something different in one
stage than another.

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

The ranges it checks against are the [primitive integer types](#primitive-integer-types)
above, looked up by whichever spelling — canonical or alias — the programmer
actually wrote; the message keeps that spelling too, rather than rewriting it
to the canonical form.

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

(`examples/borders` is started with `pnpm start`.)

On the web target the u8 genuinely wraps — 251 calls to `main()` leave `x` at
5, because 261 wrapped at 256. The `.prg` targets the **unexpanded VIC-20**:
load address `$1001` and 3583 bytes of usable RAM, the machine as it was sold.
The SDK's own default is a 24K-expanded machine, so the backend pins the
linker's `__memory_expansion` symbol to 0 — fitting the small machine first is
the point, and expanded configurations can become an option when a program
actually needs one. `examples/borders` is the visible
version: one source file whose `while` loop cycles the border colour through
`applyColors()`, imported from `@8bitscript/machine` — which resolves per
target to `@8bitscript/vic20` or `@8bitscript/c64` — so it is also the first
program through the linker, and the first through a target-conditional entry.

The generated C and AssemblyScript are written next to each output in `dist/`,
so what the compiler did is never a mystery.

Function parameters, return values, and calls used as expressions compile now
too — a function can take scalar (integer/bool) parameters and return a
scalar value, and `f() + g()` lowers exactly the way `f(); g();` always did.
Features still arrive one slice at a time: local variables and the binder
that unlocks real type checking are next. Imports already compile — the
linker merges the module graph into one program. Each slice extends the
lowering; the exhaustive-with-error rule means a feature is either compilable
or clearly reported, with no third state.

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

### `memory.read`/`memory.write`: the escape hatch below a library

`@address` binds one *named declaration* to one *fixed* location, decided at
compile time. Sometimes what a program actually has is a *runtime* address —
translating an old POKE, or writing a library that computes where to write.
`memory.read(address)`/`memory.write(address, value)` are the primitive for
that: a compiler-owned intrinsic, recognised in lowering the same way
`asm6502`/`@address` are, not a function anything imports. An old VIC-20 BASIC
line translates directly:

```basic
POKE 36879,27
```
```
memory.write(36879, 27);
```
```basic
X = PEEK(36879)
```
```
let x: utinyint = memory.read(36879);
```

On native targets this is a `volatile` byte-pointer dereference — the address
is only known at runtime, so it might well be a hardware register, and the
compiler has no way to tell; it gets the same protection an `@address` global
gets. On the web target it addresses a 64KB buffer reserved for exactly this
(one wasm page, matching the 6502's own 16-bit address space) via
AssemblyScript's `load<u8>`/`store<u8>`. That buffer has no hardware behind
it — writing to a "register" address on the web target changes a byte in a
buffer nothing reads, which is a real target-semantics difference worth
knowing about, not a bug either target hides. Both directions are honest
about what they actually did: unlike `@address`, which the web backend
refuses outright (there is no way to fake *specific* hardware), a runtime
byte address is at least a coherent concept on both targets, even when one of
them has nothing physical to back it.

`memory.write`/`memory.read` is a **literal translation**, not the preferred
way to write new code. Once you understand what a POKE actually changes,
prefer a library that names the operation — see the next section.

### `namespace`: what a POKE becomes once you name it

`namespace Name { ... }` is how a package exposes a surface like
`screen.setBorderColor(...)` or `BorderColor.Blue` without any runtime
representation at all. It compiles away entirely: a function member lowers to
an ordinary function under a mangled name (`screen_setBorderColor`), and a
const member is never storage — it is inlined as a plain number wherever it
is used. `screen.setBorderColor(...)` costs exactly what calling a plain
function by that name would.

```
export namespace screen {
    function setBorderColor(color: utinyint): void {
        memory.write(0x900F, (memory.read(0x900F) & 0xF8) | (color & 0x07));
    }
}

export namespace BorderColor {
    const Blue: utinyint = 6;
}
```

`@8bitscript/vic20` is the first real one: `screen.setBorderColor`/
`setBackgroundColor` do a read-modify-write against the VIC's packed colour
register ($900F — bits 0-2 border, bit 3 reverse video, bits 4-7 background),
masking so that changing one field never disturbs the others, and
`BorderColor`/`BackgroundColor` name the VIC-20's own colour numbers. Two
namespaces, not one shared `Color`, because the border field is only 3 bits
wide — the hardware draws that line, not an API preference.

This is the whole point of the layering: a program can stop at whichever
level it needs.

```
screen.setBorderColor(BorderColor.Blue);        // friendly — usual code
memory.write(0x900F, 6);                        // literal POKE translation
@address(0x900F)  let register: volatile<utinyint>;  // a named register
asm6502 { ... }                                 // the machine itself
```

None of these layers removes the one beneath it, and the compiler does not
know any of `screen`, `BorderColor`, or $900F itself — `namespace` and
`memory.read`/`write` are the two primitives; everything hardware-specific is
`@8bitscript/vic20` being an ordinary 8BitScript library, not a special case
the compiler was taught about.

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
