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
so an Import symbol can point at the exported Component it names in
another file (`binder/index.mjs` `bindImportedComponents`). `analyze()`
does the same one import deep when it may read imports; without that, an
imported name used as an element is valid but unknown, and nothing is
reported. The 8BX spec's rule is that a program
starts from `.8bs` and reaches its components by importing them; the
toolchain does not enforce that until a component can be called from
`.8bs` (spec §4.5), which is why `hello-bx`'s entry is still `.8bx`.

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
`#fact` branch, a print of a string literal, and a call to an empty
void function (`text.setColor` on the PET) cost the unused side / the
conversion loop / the no-op nothing. `checkHardwareHazards` still
sees the unpruned IR from `link()`.

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
