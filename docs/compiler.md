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
 lexer  ->  parser  ->  AST  ->  fold  ->  binder  ->  checker  ->  IR
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

## What 8bitscript resolves, and what runs on the machine

The target toolchains never see a line of 8bitscript: LLVM-MOS gets
generated C, asc gets generated AssemblyScript, and both are a one-to-one
translation of the IR, not of the source. Every construct goes through the
pipeline above. The generated code looks like the source only because the
language is small and the backends are deliberately boring.

A construct is resolved by 8bitscript, before any target tool runs, when
and only when it is spelled one of three ways:

- **A literal.** A number, a `"string"`, or a backtick template. Numbers
  and strings become data; a template becomes the print calls it lays out
  (see below). None of these exist as such on the target.
- **`const`.** A compile-time constant, inlined wherever it is read —
  neither `BorderColor.BLUE` nor a top-level `const LIMIT: utinyint = 4`
  exists on the target, and assigning to one is `8BS1031`. An exported
  const inlines in its importers the same way. Because it *is* a value by
  the time anything else looks, a const goes wherever a literal goes: it
  names an address (`@address(BORDER_REGISTER)`), initialises a global, and
  gets the same range check against the type it is used at. Its own
  initialiser is a literal, another const, or a name only the linker can
  see — `const HIGHLIGHT: utinyint = TextColor.YELLOW`, or an imported
  const — which the linker fills in before anything reads it. A `const`
  *array* — `const TABLE: array<utinyint, 3> = [1, 2, 3]` — and a `const`
  *string* — `const LABEL: string = "READY"` — are resolved the same way
  (every element is a compile-time value, `TABLE.length` is a number), but
  they are not inlined: `TABLE[i]` with a runtime `i` needs an address, so
  the data is placed in the program, read-only, never in RAM.
- **A parameter default.** `function blank(border: utinyint =
  BorderColor.BLACK, ...)`: the default is a literal or a const, and a
  call that leaves the argument off gets it filled in before any target
  tool runs — the machine always sees a complete call. The argument count
  is checked against the parameters (`8BS1035`).
- **`#name(...)`.** A function the compiler evaluates: `#frames(0.5,
  seconds)` becomes `30` in the generated code, and `#system()` becomes
  the number of the machine being built for (`2` on a C64), to compare
  with the names `@8bitscript/system` exports. A `#name` the compiler
  doesn't know, or a `#frames` or `#system` that isn't called, is
  `8BS1030`; `#system` with arguments is `8BS1036`.

Everything else runs on the machine: loops, assignments, arithmetic on
variables, every plain `name(...)` call including `waitFrame()` and
`memory.read()`, and the print calls a template expands into. The rule is
a property of the spelling — a reader never needs the list of compile-time
constructs to know which side of the line a piece of code is on. In
`text.print(0, \`TICK ${ticks % 10:1}\`)`, the template literal is
compile-time layout, and the `print` and `printNumber` it becomes, with
`ticks % 10` inside, run on the target every time the line executes. The
compiler either resolves a `#`/literal/`const` construct fully or reports
that it couldn't; it never silently moves half of one to runtime.

The one pass between the parser and the checker today is the *fold*
(`packages/compiler/src/fold`): it rewrites every `#frames(...)` call — the
compile-time duration builtin, `#frames(0.5, seconds)` — into a plain integer
literal holding how many frames that much time takes at the project's
`frameRate` (`8bs.config.ts`, default 60), using exact integer arithmetic,
and every `#system()` call into the number of the machine the build is
for (the fold's `SYSTEMS` table; `@8bitscript/system` names the same
numbers, so `if (#system() == System.NES)` is a comparison of two
constants). `8bs check` and the editor analyse files rather than builds,
so with no machine in hand `#system()` folds to a placeholder and is
valid-but-target-dependent, the same answer a `.<machine>.8bs` import gets
— see [systems](systems.md).
The function is named for what comes out, a frame count, and its required
second argument names the unit the literal is written in; `seconds` is the
only unit so far. Nothing is reserved: `#frames` is its own token, so a
program may declare a `frames` of its own, and the unit word only means the
unit in that argument slot, so `seconds` is free too. Folding
first is what lets the checker's ordinary range rule catch
`#frames(100, seconds)` overflowing a `utinyint` with no special case. The
tutorial (see [tutorial.md](tutorial.md)) shows the builtin in a program;
hovering `frames`, or the `seconds` inside its call, in an editor gives the
same description.

Strings are constant program data. A literal — `"TICK"` — lowers to a slot
in a per-module string table (`ir.strings`, length-prefixed bytes, at most
255 of them, holding only the portable character set the checker enforces:
space, `0`-`9`, `A`-`Z`, `! , - . : ?`); the linker merges the tables and
each backend emits them in its own spelling (a `static const` table the
6502 toolchain puts in read-only data; a data segment at 0xE000 on the
web, above the screen buffer). A `string` is a parameter type — `s.length`
and `s[i]` — a `const LABEL: string = "..."` names one, and `let name:
string<8>` is text that changes: 8 characters of RAM behind a length byte,
the shape a literal has, so it goes wherever a `string` goes. `name =
"..."` or `name = other` copies at runtime, cut to the capacity (a literal
or a const that does not fit is `8BS1027` at compile time); there is no
concatenation. A backtick string with `${...}` fields is a *template*, and
`text.print(cell, \`TICK ${ticks % 10:1}\`)` is laid out at compile time
into `print(cell, "TICK ")` and `printNumber(cell + 5, ticks % 10, 1)`
calls on that namespace — a protocol any namespace exporting those two
functions gets, not a builtin — with each piece's cell computed from the
text before it and a field's width from its `:width` or its expression's
type. Nothing formats at runtime.

Generating C for the 6502 rather than emitting assembly directly is a
deliberate hand-off: LLVM-MOS already does register allocation, zero-page
allocation, and instruction selection better than a first-generation backend
would, and that leaves the effort here on the language.

What the backend does not hand off is where each byte lives. Every global
names its section: a `const` array or a string is `.rodata` (read in
place, never RAM), a `let` array with values is `.data` (loaded where it
lives on a disk or tape image; on a cartridge, a `.rodata` twin that
`main()` copies), a zero array is `.noinit` RAM that `main()` zeroes, and
a scalar is `.zp.noinit` — zero page while a 48-byte budget lasts, then
`.noinit` — with `main()` storing its starting value. So no variable is
left for the SDK's start-up code to copy or zero, and the `memcpy`,
`memset`, and the routines that call them — about 130 bytes before
`main()` — are never linked. (Without `-fno-builtin`, LLVM would turn
`main()`'s zeroing loops back into the `memset` they replace.) The
`waitFrame()` accumulator is sixteen bits for the same reason: the best
`p/q` with `p + q <= 65535` sits within about 1e-9 of the true ratio at
60Hz — under a hundredth of a frame a day — and a 16-bit add and compare
is a quarter of the code of a 32-bit one. A rate the 16-bit form cannot
hold within a frame a day (none below about 1000) falls back to the exact
32-bit pair; the PET, which measures its own ratio at startup, keeps 32
bits. A machine may also name a *frame hook* (`FRAME_SYNC.nes.frameHook`):
a function the runtime calls right after every hardware frame edge, when
the linked program defines it. The NES package uses it to deliver its
queued screen writes at the start of vertical blank — the only time the
PPU accepts them — so a program prints whenever it likes (a HUD bigger
than the queue's 128 bytes waits for the next blank); a program that
links no such function pays nothing.

## Where it actually is

| Layer | State |
| ----- | ----- |
| Diagnostics | **Implemented.** One record shape, one source of truth |
| Lexer | **Implemented.** Tokens with offsets; reports lexical errors |
| Parser / AST | **Implemented.** Recovers from errors; every node carries its span |
| Checker | **Implemented** for the rules one file can answer: literal ranges, the reserved builtin, portable string text, template layout, assignment to a const, the spelling of a const and a variable |
| Resolver | **Implemented.** Checks imports against the package contract |
| IR + lowering | **Implemented** for the milestone subset; anything else errors |
| Linker | **Implemented.** Loads the import graph, binds names across modules, merges IR |
| 6502 backend | **Implemented.** IR → generated C → LLVM-MOS → `.prg` |
| Web backend | **Implemented.** IR → generated AssemblyScript → asc → `.wasm` |
| Binder | Not started |

The compiled subset runs on both targets: globals with machine integer
types, `array<T, N>` (`let` in RAM, `const` as data, `@address` over
hardware), `string<N>` variables and `string` consts, local variables
(block-scoped), functions with scalar parameters and return values, calls,
assignment and arithmetic, `if`/`while`/`for`, `@address` hardware globals,
`asm6502` blocks, namespaces, templates — and imports, which the linker
resolves across modules. **Lowering is exhaustive-with-error**: a construct
without a compilation rule fails with a diagnostic naming it — a `ptr<T>`,
a local array, an array passed as an argument, member access that is not a
namespace — never by silently dropping code. `8BS3001` is that diagnostic;
a program using any of it does not build.

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

`analyze()` — what both call — runs the whole front end *including lowering*,
so "this construct is not compilable yet" (`8BS3001`) is something you see
as you type rather than at the end of a build, and so is the argument count
of a call to one of the file's own functions (`8BS1035`). A clean `8bs check` on a file
therefore means the file itself would build; what it cannot answer alone is
anything that needs the other modules — a name that resolves to nothing, an
import that exports no such thing, the entry module's one-export rule — and
those come from [the linker](#the-linker) when a build runs. A rule that can
be answered from one file's syntax tree belongs in the checker or in
lowering, never saved for the build.

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
| `8BS1009` | Decimal literal (`0.5`) used anywhere other than as `#frames(...)`'s first argument |
| `8BS1101` | Syntax error — expected one thing, found another |
| `8BS1021` | Integer literal out of range for its type |
| `8BS1022` | `#frames(...)` argument shape is wrong — not one integer/decimal literal plus the unit it is measured in (the unit is required: `#frames(30)` is this) |
| `8BS1023` | `#frames(...)` rounds to zero frames at the project's `frameRate` |
| `8BS1024` | `#frames(...)` is not exact at the project's `frameRate` — rounded (warning) |
| `8BS1025` | `#frames(...)`'s second argument is not a unit it knows (`seconds` is the only one) |
| `8BS1026` | String or template text outside the portable character set (space, `0`-`9`, `A`-`Z`, `! , - . : ?`) |
| `8BS1027` | String longer than 255 characters, or a literal or const that does not fit the `string<N>` it is assigned to |
| `8BS1028` | Template string anywhere other than the second argument of a namespace's `print(cell, ...)` |
| `8BS1029` | Template field the compiler cannot lay out: no `:width` and no visible type, a signed or 32-bit value, or a width outside 1..255 |
| `8BS1030` | `#name` is not a function the compiler evaluates (`#frames` and `#system` are the two), or one of them was not called |
| `8BS1031` | Assignment to a `const` — a compile-time constant with no storage on the target — or to an element of a `const` array |
| `8BS1032` | Literal index at or past an array's length (`a[4]` on an `array<T, 4>`) |
| `8BS1033` | Array initialiser with other than exactly N elements |
| `8BS1034` | A `const` not written `UPPER_SNAKE`, or a variable not starting with a lower-case letter |
| `8BS1035` | A call with more arguments than the function has parameters, or fewer than those without a default |
| `8BS1036` | `#system()` called with arguments — it takes none |
| `8BS2001` | Cannot find package |
| `8BS2002` | Package is not an 8BitScript package |
| `8BS2003` | Package declares an entry that does not exist |
| `8BS2004` | Cannot find a relative module |
| `8BS2005` | Imported name is not exported by the module it names |
| `8BS2006` | Imported name collides with another binding in the module |
| `8BS2007` | Reference to a name that resolves to nothing |
| `8BS2008` | Package declares a native source file that does not exist |
| `8BS2009` | Declaration or import named after the reserved runtime builtin (`waitFrame`) |
| `8BS2010` | Entry module must export exactly one parameterless function — the program |
| `8BS2011` | Package does not export the requested subpath |
| `8BS3001` | Valid construct the compiler cannot lower yet |
| `8BS3002` | Construct not available on the requested target |
| `8BS3003` | Write the requested target documents as able to damage the machine — the PET's "killer poke" (`$E842` with bit 5 set); allowed only as a compile-time value with the bit clear |

Module resolution landed in the 2000s before a binder exists because it needs
no symbol knowledge — only the filesystem. Type errors still wait on the
binder.

Two of the 3000s depend on the machine being built for — `8BS3002` for a
file or entry with no version for it, and `8BS3003` for a write it refuses —
and so are reported by the linker at `8bs build`, which knows the target.
`8bs check` and the editor analyse a file without one, and never show them;
see [the linker](#the-linker) for what `8BS3003` checks.

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

A `.8bs` path — a relative import's, or a package's string entry — resolves
to its **system-specific version** when the build's machine has one:
`./player.8bs` is `player.nes.8bs` on the NES if that file exists beside it,
and `player.8bs` otherwise — and `geometry.pet.8032.8bs` for a PET build
with `--profile 8032`, the profile's name after the machine's, before the
machine's own `geometry.pet.8bs`. A file that exists only in
machine-specific versions is `8BS3002` for a machine (or a profile) that
has none. The rule, and what `8bs check` does with no machine in hand, is
in [the package model](packages.md#system-specific-files).

A bare specifier with a **subpath** — `@8bitscript/c64/screen` — resolves
through the package's `"8bitscript".exports` map, a `./screen` key naming a
file inside the package; the exported file follows the system-specific
filename rule too, and the package's native sources ride along with it. A
subpath the map has no key for is `8BS2011`; a key whose file does not exist
is `8BS2003`, like a missing entry. This is how each target package offers
its `screen` and `text` implementations beside the registers they are built
on, and how `@8bitscript/screen`'s machine-keyed entry reaches them — see
[the package model](packages.md#package-subpaths).

One case is deliberately **not** diagnosed, because the package model does
not specify it: a relative import without a `.8bs` extension. It is not
guessed at, and not reported.

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

Once every body is rewritten, the linker checks the program against the
target's **hardware hazards** — writes the machine's own documentation says
can destroy hardware, not merely crash a program (`8BS3003`). The table has
one entry: on the PET, `$E842` (the 6522 VIA's data-direction register B)
with bit 5 set makes the vertical-retrace input an output, and on the
12-inch CRTC models that line also drives the monitor's vertical sync — the
"killer poke", `POKE 59458,62`. The rule is as narrow as the hazard: a
`memory.write`, an assignment to an `@address` global there, or an element
store into an `@address` array spanning it is refused when the value is a
compile-time constant with bit 5 set or a runtime value, and allowed when
it is a compile-time constant with the bit clear (`$1E`, the register's
normal value). Reads are never refused. The check runs in the linker, not
the checker, because it needs the machine and every const already inlined —
`memory.write(VIA_DDRB, FAST)` with both names imported is the same write
as the literal — and because the bar for adding an entry is the target's
documentation, kept beside its package (`packages/pet/AGENTS.md`). The
table itself is `packages/compiler/src/linker/hazards.mjs`.

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
[the package model](packages.md); `@8bitscript/screen` and `@8bitscript/text`
are the working examples — each branch of theirs delegates to a target
package's subpath. The same `8BS3002` covers the filename form of the idea — a
`player.8bs` that exists only as `player.nes.8bs` and `player.c64.8bs`,
built for a third machine.

A package can also ship **native sources**: an `"8bitscript".native` list of
files that are not 8BitScript but belong in the build — hand-written 6502
assembly, or data no `.8bs` construct can express yet. The resolver turns
each into an absolute path (a listed file that does not exist is `8BS2008`,
reported at resolution time like a missing entry), the linker collects them
across the module graph, once each, onto `ir.nativeSources`, and the 6502
backend passes them to the LLVM-MOS driver after the generated C, untouched.
The web backend ignores them. `@8bitscript/nes` is the working example: its
`native/6502/font.s` is the 8 KiB CHR-ROM character set the NES has no ROM
of its own for, placed in the SDK's `.chr_rom` linker section so it lands in
the `.nes` image's CHR bank — see the package's `src/index.8bs` for why.

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

## The spelling says which side a name is on

Every `const` is `UPPER_SNAKE` — `OPTION_COUNT`, `BorderColor.BLUE`,
`text.CELL_COUNT` — and every variable starts with a lower-case letter.
The checker enforces it (`8BS1034`, naming the spelling to use), so a
reader of `if (option == LIMIT)` knows `LIMIT` is resolved by 8bitscript
and `option` is storage on the machine, without finding either
declaration. Namespaces and types stay `PascalCase`, functions and
parameters `camelCase`.

## What a build reports

Under `built <file>`, `8bs build` prints one line about memory:

```
memory: 3 bytes of RAM for variables, 771 bytes of program (code and data)
```

On a 6502 target the numbers are measured from the linked program (the
SDK's `llvm-size` over the ELF the linker leaves beside the output), so a
variable LLVM dropped for being unread is not counted, and the few bytes
LLVM spills to zero page for its own use are; a `const` array or a string
is program, never RAM. On the web they
are what the source declares, since asc's data segment is the whole story
there. The machine's limit is the toolchain's own: the SDK's linker script
knows each machine's RAM, and a program that does not fit does not build —
the build says how many bytes over it is, in the machine's terms, before
the linker's text. The web target's limit is on static data: arrays,
`string<N>` variables, and string constants share the 8192 bytes from
0xE000 to the end of its one 64KB page, and a program past that does not
build either, with the same kind of message.

## The first milestone: achieved

The milestone was never "implement TypeScript"; it was that this program
compiles and runs:

```
let x: u8 = 10;

export function main(): void {
    x = x + 1;
}
```

It does, on both targets: each backend's own tests build exactly this
program (`packages/backend-6502/test` and `packages/backend-web/test`), and
its `main()` returns at once and draws nothing — it exists to prove the
pipeline, not to show a picture.

On the web target the u8 genuinely wraps — the web backend's own test calls
`main()` 251 times and finds `x` at 5, because 261 wrapped at 256. The `.prg` targets the **unexpanded VIC-20**:
load address `$1001` and 3583 bytes of usable RAM, the machine as it was sold.
The SDK's own default is a 24K-expanded machine, so the backend pins the
linker's `__memory_expansion` symbol to 0 — fitting the small machine first is
the point, and expanded configurations can become an option when a program
actually needs one. `examples/proof-of-concept/borders` is the visible
version: one source file whose `while` loop cycles the border colour through
`screen.setColors()`, imported from `@8bitscript/screen` — which resolves per
target to `@8bitscript/vic20/screen` or `@8bitscript/c64/screen` — so it is
also the first program through the linker, and the first through a
target-conditional entry.

The generated C and AssemblyScript are written next to each output in `dist/`,
so what the compiler did is never a mystery.

Function parameters, return values, and calls used as expressions compile now
too — a function can take scalar (integer/bool) parameters and return a
scalar value, and `f() + g()` lowers exactly the way `f(); g();` always did.
Arrays, local variables, `for` loops, and string variables compile too:
`examples/proof-of-concept/borders` keeps its colour pairs in two `const` arrays, and the
text packages print with a `for` over a local. Features still arrive one slice at a
time: the binder that unlocks real type checking is next. Each slice
extends the lowering; the exhaustive-with-error rule means a feature is
either compilable or clearly reported, with no third state.

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
`screen.setColors(...)` or `BorderColor.BLUE` without any runtime
representation at all. It compiles away entirely: a function member lowers to
an ordinary function under a mangled name (`screen_setColors`), and a const
member is never storage — it is inlined as a plain number wherever it is
used. `screen.setColors(...)` costs exactly what calling a plain function by
that name would. A const member takes the same initialisers a module-level
`const` does: a literal, or a const — the module's own, another namespace's
member, or an import — which the linker resolves, range-checks against the
member's own type, and inlines; a cycle through the consts a member names
is reported, not looped on. That is what lets a package keep its geometry
in one small file (`namespace Video { const COLUMNS: utinyint = 40; }`)
and its surface read it (`namespace text { const COLUMNS: utinyint =
Video.COLUMNS; }`), so a system-specific version of the small file changes
the surface without a copy of it.

```
import { vicColor } from "./index.8bs";

export namespace screen {
    function setColors(border: u8, background: u8): void {
        vicColor = (8 | (border & 7)) | (background << 4);
    }
}

export namespace BorderColor {
    const BLUE: utinyint = 6;
}
```

`@8bitscript/vic20/screen` is the first real one — that listing is it, less
the comments. `screen.setColors` packs both colours into the VIC's one
colour register ($900F — bits 0-2 border, bit 3 normal video, bits 4-7
background), imported from `@8bitscript/vic20` as the named register it is,
and `BorderColor`/`BackgroundColor` name the VIC-20's own colour numbers. Two
namespaces, not one shared `Color`, because the border field is only 3 bits
wide — the hardware draws that line, not an API preference. A namespace
member must be `const` or a function: state lives in the module around it,
which is why colours are a call, not two variables and an apply.

This is the whole point of the layering: a program can stop at whichever
level it needs.

```
screen.setColors(BorderColor.BLUE, BackgroundColor.BLACK); // friendly — usual code
vicColor = 8 | 6;                                    // the named register
memory.write(0x900F, 14);                            // literal POKE translation
asm6502 { ... }                                      // the machine itself
```

None of these layers removes the one beneath it, and the compiler does not
know any of `screen`, `BorderColor`, `vicColor`, or $900F itself —
`namespace`, `@address`, and `memory.read`/`write` are the primitives;
everything hardware-specific is `@8bitscript/vic20` being an ordinary
8BitScript library, not a special case the compiler was taught about.

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
