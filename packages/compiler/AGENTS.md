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

## Source kinds

Two file extensions name 8BitScript source: `.8bs` and `.8bx`. What a
path is — which kind, its stem, whether it is source at all — is asked in
one place, `src/source/index.mjs` (`sourceKindOf`, `stripSourceExtension`,
`isSourceFile`, `SOURCE_EXTENSIONS`), and nowhere else hard-codes an
extension. The resolver's twin rule preserves the kind it was given
(`App.8bx` on the PET is `App.pet.8bx`, never `.8bs`); an `.8bx` file can
be imported, be a package's entry, and carry machine and hardware twins.
One lexer and one parser serve both; `.8bx` adds the `component`
declaration and element syntax, which the lexer tokenizes in its own
modes (`src/lexer/AGENTS.md`, "the 8BX modes") and the parser reads
token by token (`parseBxElement` in `src/parser/index.mjs`) — only when
the source kind says so. Spans are tokens' spans, everywhere.

**A component is a function; an element is a call.** `src/bx/elaborate.mjs`
turns `component Name(props) { … }` into a function of that name in the
module that declares it (marked `component: true` in the IR) and
`<Name a={x} />` into `Name(x);` where the element stood. That is what
makes a component hygienic (its body resolves names in its own module),
evaluate-once (an attribute is an argument), and importable (`export
component` is an exported function the linker binds like any other). The
linker's inliner (`src/linker/optimize.mjs`) then inlines a component
call whose arguments are all compile-time values, so a static composition
costs what the hand-written calls would — `hello-bx` is byte-identical to
`hello-world` on the PET, and `packages/cli/test/hello-bx.test.mjs` says
so. A component fed a run-time value stays a call.

**State is storage per static instance** (spec §36–§37, §62, §103).
`state f: T = v;` at the top of a component body becomes one module-level
*template* global, `__bx_Name__f`, that the body reads and writes. The
element's call carries an `instance` tag, and the linker
(`specializeInstances`, on the linked program, after every name is its
output name) clones the function per instance — `Name__i1`, `Name__i2` —
each pointed at its own copies of the globals, `__bx_Name__f__i1`, …,
then drops the template. A stateless component that contains a stateful
one is cloned per site too, so two `<Pair />` holding a `<Tally />` are
four tallies; the halves of a slotted component share one tag; a plain
call from `.8bs` is an instance per call site. `bx/check.mjs`
`checkState` holds `state` to the top of a component body, typed, once
per name, unshadowed (`8BS2022`). `--size` lists every instance's bytes
(`ir.instances`, `stateReportLines`). **Methods** (§39) — `function` at
the top of a component body — are hoisted to `Name__method`, read the
same template globals, and are instanced *with* the enclosing instance
(the linker keeps the parent's id for a call to a method of the same
`owner`), so `damage(5)` in one `<Player />` touches that player's
health. A method sees state, not props (`8BS2025`). Nothing outside a
component can call a method: a static instance has no name to call it
on (§131, refs). Not yet: arrays of state, pools.

**Composition is conditional the ordinary way** (spec §48–§50, §94).
`{cond ? <A /> : <B />}` and `{cond && <A />}` between tags are an `if`
with a composition in each arm (`bx/elaborate.mjs` `compositionOf`);
`return (<…/>)` in a component composes where it stands. A compile-time
`cond` — `Video.SPRITES > 0` — is a constant `if`, and the optimizer drops
the arm that cannot run, component and all: `menubar-bx.test.mjs` builds
both arms for the PET and measures that the sprite arm costs it nothing.
An element anywhere a value is expected (`let x = <A />`, `f(<A />)`, an
attribute) is `8BS2024`; a `{…}` child that is not a composition
(`{score}`) is `8BS2023` — a value between tags is a later milestone
(§20).

**Children go where `<slot />` is.** A slotted component is also split
at the slot into `Name__open` and `Name__close`, and
`<Name a={x}><A /></Name>` is `Name__open(x); A(); Name__close(x);` —
the children run once, in place (§105); an argument both halves read is
hoisted into a `__bx_` local at the call site when it could do anything,
so it runs once (§104). `bx/check.mjs` `checkSlots` holds the slot to the
shape the split can honour: one, at the top level of the body, no local
across it (`8BS2019`). A bar of items written as elements is
byte-identical to the hand-written begin/item/end on the PET and the
C64 — `packages/cli/test/menubar-bx.test.mjs`, the spec's §69 gate.

**`.8bs` is code, `.8bx` is composition** (spec §2.6; `src/bx/check.mjs`
`checkFileRole`). `asm6502` is refused in an `.8bx` file (`8BS2020`):
machine code lives in a `.8bs` function the component imports. A
top-level function that composes nothing, or a top-level `let`, in an
`.8bx` is a warning (`8BS2021`) that a project may switch off with
`bx: { strict: false }`; component methods and `state`, and anything
inside `{…}`, are never looked at. A warning reports and rides along — the
linker and `8bs build` gate on errors only.

**Imports are bound before any module is finished.** `link()` reads the
whole graph — tokens, AST, own symbols — before elaborating any module,
so an Import symbol can point at the exported symbol it names in
another file (`binder/index.mjs` `bindImports`: `target` for any kind,
`component` when it is one). `analyze()` does the same one import deep
when it may read imports; without that, an imported name used as an
element is valid but unknown, and nothing is reported. A program starts
from `.8bs` and reaches its components by importing them (spec §4.3,
§4.5); `8bs build` refuses an `.8bx` entry.

**IntelliSense has two layers** (`src/intellisense/`). `index.mjs`
answers for the built-ins token-level, independent of any program;
`symbols.mjs` answers for the program's own names from the binder — it
tokenizes, parses and binds the buffer, binds its imports one level deep,
and finds the scope at the cursor through the binder's `scopeOf` side
table (node → scope; the AST itself stays a tree). Hover renders a
symbol from its declaration's source and the doc comment tightly above
it (or after it on its own line); `getDefinition` is its file and name
range; completion in `.8bx` knows a tag from the lexer's own tag tokens
(`bxPosition`): components after `<`, the open element after `</`, a
component's remaining props inside its tag. The language server is
protocol glue over these three calls.

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
constant `if`s and compile-time calls, prune — then fold and prune once
more, so a helper whose other callers folded away is inlined into the
one left) before lowering, so a `#fact` branch, a print of a string
literal, and a call to an empty void function (`text.setColor` on the
PET) cost the unused side / the conversion loop / the no-op nothing.
The inliner's size measure counts a call's arguments as code, not as
one node each — each is a load and a store at every copy — so a body
that only passes values along stays the one function it was written
as. The exception is a *forwarder*: a body that is exactly one call
passing the function's own parameters through (each at most once, in
any order, literals allowed) is that call at every site, run-time
arguments and all — the site's argument stores go to the callee's slots
instead of the forwarder's, so nothing is duplicated and the wrapper's
`jsr`/`rts` and copies are gone (`component Tile(r, c, e) { drawTile(r,
c, e); }` was +36 bytes on the PET 2001 and VIC-20 before, 2048 #49; a
`return random.range(bound);` delegate +8). A global passed through, a
parameter used twice, an expression around the call, or a second
statement (2048's `f(); return;` idiom) is not a forwarder and keeps
the function. `packages/compiler/test/forwarding-inline.test.mjs` is
the byte-identity gate.

**A function with one live call site is written into it** (rule 9 in
`optimize.mjs`), whatever its size and whatever its arguments: the
body replaces the call, the argument stores, the frame and the `rts`,
so the program can only get smaller. A run-time argument that is a
read of the caller's own local or parameter (zero page, as the
parameter's slot was) or an array is the argument itself; a read of a
global — an absolute load, one byte more at every use — or any
expression becomes a local holding it, the store the call already
made; a parameter the body assigns, or whose own variable the body (or
anything it calls) writes, is copied too. The callee's names are made
fresh first, so nothing in the caller is shadowed and no argument is
read after a parameter of its name took its place; a body whose free
names — its globals — a caller's own local would capture stays a call.
A non-void callee whose only `return` is its last statement is hoisted
ahead of the statement that used its value when the rest of that
statement is constants and reads of names the callee never writes;
`let r = f(x)` returning one of f's own locals keeps that local as `r`.
A local the inlining pasted in and then made constant is the constant
(`propagateConstLocals`); one the program wrote where it stands is
left alone — it may exist to shadow, or to be refused by name. A site
count is taken with forwarders written out (`siteCount`: a forwarder's
sites are the callee's), and a body already written into its one caller
stands in for that copy until the caller's finished body is stored.
Not inlined: a void body with a `return` anywhere (the `f(); return;`
idiom keeps a call, as under rule 6), a non-void body with an early
return, `asm6502` (its text may name the function's own frame), a
string parameter with no literal to bind, and a site inside an
unrolled string copy or a forwarder's body. 2048 #51's `paintTile` +
`stampValue` + `Tile` were +56 bytes on every 6502 and +84 on the PET
2001 against the one-body `drawTile`; `test/single-caller-inline.test.mjs`
holds the split to the one body's size, on the PET and on the web.

**Bodies are optimized callees-first** (`bottomUpOrder`), so the size
that decides whether a body is pasted at several sites (rule 6) is the
size it has once its own callees are inlined into it, not the size it
was written at. 2048 #52's parameterless `Board`, small as written,
went into `main` three times carrying the whole inlined `ScoreBar`
(+393 bytes on the PET 2001); measured finished, it is one function.

One cost these two rules can add is zero page, not program: a callee's
locals used to live in a frame that sibling callees' frames overlaid,
and once written into the caller they are the caller's frame, under
every deeper chain (2048's animated builds: −90 to −117 bytes of
program, +9 of zero page on the C64, C128, Atari and MEGA65; the
VIC-20 and PET, where zero page is the tighter budget, went down).
Placing a callee's frame after the caller's *live* locals at the site,
rather than after its high-water mark, is the backend change that
would recover it. `checkHardwareHazards` still sees the unpruned IR
from `link()`.

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

## Publishing: the backends are TypeScript here, JavaScript on npm

`./mos` and `./wasm` are `.ts`, run in the workspace via Node's type
stripping. That mechanism is refused under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so the published package
cannot ship them as-is — every 0.2.x release before 0.2.5 did, and every
npm consumer's `8bs build` crashed on import. prepack
(`tsc -p tsconfig.publish.json`, `--noCheck`: the main tsconfig already
typechecks) emits stripped `.js` beside each `.ts` with relative `.ts`
specifiers rewritten to `.js`, and `publishConfig.exports` points the
published manifest at those. The emitted `.js` is gitignored; everything
handwritten in `src/` is `.mjs`, so `.js` there is always generated.
`test/published-package.test.mjs` packs the real tarball and imports the
backends out of it, so this cannot regress silently.
