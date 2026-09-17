---
title: "8BX: composition for 8BitScript"
nav_order: 85
---

# 8BX: composition for 8BitScript

`.8bx` is 8BitScript's declarative composition syntax — what TSX is to
TypeScript, without a DOM, a framebuffer, or the idea that a "component"
is a web widget. An `.8bx` file is an 8BitScript source file plus
JSX-like element expressions; a component may describe an interface, a
game, a raster kernel, an audio system, a file system, or nothing visible
at all.

Three documents, three jobs:

- **[The 8BX specification](../spec/8bx.md)** is the design — 142
  sections, the rules and the reasoning, kept as it was written and
  amended. Everything on this page cites it as `§N`.
- **[The manual](../language/composition.md)** is how to use what the
  compiler has: element syntax, components, `<slot />`, conditional
  composition, state, methods, the purity rule, and
  [the `.8bs` ↔ `.8bx` boundary](../language/boundary.md).
- **This page** is the ledger between them: which parts of the spec are on
  trunk, as which changes; which rules code enforces; and where the code
  and the spec still differ.

## The spec's PR sequence, as landed

Spec §135 lays 8BX out as a sequence of independently green PRs. This is
where each one went. Everything through PR 15 is in 0.11.0.

| Spec PR | What | Landed as |
| --- | --- | --- |
| PR 0 | `defineConfig`, the config schema, `programs`, `images`, `bx.strict` (§4.6–§4.8) | #160, docs in #161 |
| PR 1 | Source kinds: `.8bx` known to the resolver, linker, CLI and editor; twins keep their extension (§5, §6) | #159 |
| PR 3–8 | A component is a function in its own module and an element is a call to it; the inliner folds compile-time props; the two-pass link graph; the entry must be `.8bs` and reaches a component as `Hello();` (§4.3, §4.5); `<slot />` as open/close halves; the menu bar wrapper, byte-identical on the PET, C64 and web (§69) | #165, #166, #167 |
| PR 4–5 | Lexer modes (tag / children / expression) and a token parser; `<` opens a tag only where no operand precedes it (§13–§18) | #168 |
| PR 11 | `cond ? a : b` on the WebAssembly backend, folded when the test is known | #169 |
| PR 2 | Purity: `asm6502` refused in `.8bx` (`8BS2020`), the ordinary-code lint (`8BS2021`), and a warning no longer stops a build (§2.6) | #170 |
| PR 9b | Fluid web: canvas and layout pass, `Video.columns()` live, a resize applied between frames (§74) | #171 |
| PR 12 | Component `state`, storage per static instance, the `--size` state table (§36–§37) | #172 |
| PR 11b | Conditional composition: `{c ? <A /> : <B />}`, `{c && <A />}`, `return (<…/>)`; a dead arm costs the PET nothing (§48–§50) | #173 |
| PR 12b | Component methods, instanced with their component (§39) | #174 |
| PR 13 | The dogfood ladder's first real program: 2048's `Screen.8bx` over `game.8bs`, byte-identical on the 4K PET 2001 and the unexpanded VIC-20, 60 bytes smaller on every build that animates (§127) | 2048 #46 |
| — | Findings fed back from PR 13: the inliner weighs call arguments; reachability folds again after pruning | #175 |
| — | The `.8bx` grammar colours elements with children, fragments and `{…}` composition | #176 |
| PR 15 | IntelliSense from the binder: hover on the program's own names, completion, go-to-definition; in `.8bx`, components after `<`, props as snippets, `</` closing the open element (§86–§87) | #177 |
| PR 14 | Structs (§55, §61) | not started — its seven design decisions are open |

## What exists today

Read against the source: `packages/compiler`, `packages/cli`,
`editors/vscode`, the machine catalogs, and the example configs.

- **`.8bx` is a source kind.** The compiler asks one module
  (`packages/compiler/src/source/index.mjs`) what a path is; the resolver's
  twin rule keeps the kind it was given (`App.8bx` on the PET is
  `App.pet.8bx`); an `.8bx` module imports, links and takes machine twins
  exactly as `.8bs` does; VS Code registers `.8bx` as `8bitextensible`
  and sends it to the same language server. Spec §5, §6, §80–§84, §141.
- **Element syntax is the lexer's** (§13–§16): tag, children and
  expression modes on a stack, `<` opening a tag only where no value sits
  before it, raw text as one token; the parser reads tokens, so every
  diagnostic inside `{…}` points into the file, and every half-typed tag
  recovers (§90). Text children are normalized the JSX way, once (§35).
- **A component is a function; an element is a call to it.** That gives
  hygiene, evaluate-once props (§104) and `export component` across
  modules (§9–§11) in one move; the linker's inliner makes a
  compile-time-prop element cost what the hand-written calls would (§64,
  §65). `component` is a keyword in `.8bx` only (§129). The pipeline is
  in [Compiler](../compiler.md).
- **State is storage per static instance** (§36–§37): `state f: T = v;`
  in a component body; each element (or `.8bs` call site) is an instance
  with its own function and its own globals, laid out at compile time,
  templates dropped, every byte in `8bs build --size` (§119).
- **Methods** (§39): functions at the top of a component body work on
  the instance's own state and are instanced with it; a method sees
  state, not props (`8BS2025`).
- **Composition is conditional the ordinary way** (§48–§50):
  `{cond ? <A /> : <B />}`, `{cond && <A />}`, `return (<…/>)`; a
  compile-time test drops the arm that cannot run, component and all,
  which is capability-responsive design (§49, §78) — measured on the PET.
- **Children go where `<slot />` is** (§33): a slotted component is two
  functions around its children, so they run once, in place (§105).
  `@8bitscript/ui/menubar` is `<MenuBar row width><MenuItem label />…</MenuBar>`
  and builds byte-identical to the hand-written calls (§69, measured on
  PET and C64).
- **A program starts from `.8bs`, and calls its components.** `8bs build`
  refuses an `.8bx` entry by name (§4.3); a component is reached from
  `.8bs` as an ordinary positional call — `Hello();` is `<Hello />` the
  way `.8bs` can spell it (§4.5) — and checked as any call is. `hello-bx`
  is the model: `src/hello-bx.8bs` is the program, `src/Hello.8bx` the
  component, and the PET build is byte-identical to `hello-world`'s.
- **The config knows its shape.** `defineConfig` from `@8bitscript/cli`,
  `programs` for several programs in one project, `images` for the disk
  images that will package them, `bx.strict` for the purity lint — see
  [Project config](../config.md). Spec §4.6–§4.8.
- **The editor knows the program's names** (§86–§87): hover, completion
  and go-to-definition come from the binder; inside `.8bx`, `<` completes
  components, a component's props complete as a snippet, and `</` closes
  the element that is open.

## The rules already decided

These are the spec's, restated here because each one is enforced (or
reserved) by code on trunk; the spec has the reasoning.

| Rule | Where | Spec |
| --- | --- | --- |
| `.8bs` is code, `.8bx` is composition. `asm6502` never appears in `.8bx`; machine code lives in `.8bs` and is imported. Ordinary declarations in `.8bx` are a lint (`bx.strict`). | `8BS2020` (error), `8BS2021` (warning) in `bx/check.mjs` | §2.6 |
| The program entry is always `.8bs`. A package's `"8bitscript".entry` may be `.8bx` — that is an import, not a program. | `packages/cli/src/build.mjs` `checkEntryKind`; `programs.mjs` | §4.3 |
| `.8bs` reaches a component as a positional call: `App();`, `Player(20, 40);` — the same elaboration `<Player x={20} y={40} />` gets. No children across the boundary. | a component is a function; the call is the element (`bx/elaborate.mjs`) | §4.5 |
| Several programs per project; the key is the output stem; `entry` is sugar for `programs.main` with the filename stem kept. | `packages/cli/src/programs.mjs` | §4.6 |
| A cartridge is hardware (a catalog `media` option); a disk image is a container over built programs, declared in `images`. | Atari catalog `media`; `programs.mjs` `resolveImages` | §4.7 |
| Fluid web — layout to the viewport at run time, costing the other eight machines nothing — is in the first milestone. | the web's Modern host (`machine=hifi`, the default): `Video.columns()`/`rows()` are the live grid, `Video.COLUMNS` the grid a program starts with; a resize applies between frames (`web-loader.mjs`) | §74, §129 |

## Where the code and the spec differ

Facts about today's code, not the design. Each is either a spec PR still
ahead or a wording the spec should catch up to.

- **A run-time prop through a wrapper still costs a function.** A
  component whose body only forwards its props to one call
  (`component Tile(row, col, e) { drawTile(row, col, e); }`) is free when
  every prop is a compile-time value, and costs one real function per
  wrapper when one is not — measured at +36 bytes on the 4K PET 2001 and
  the unexpanded VIC-20 in 2048 #49, and the reason 2048 calls `Tiles()`
  rather than wrapping each tile. §30 and §64 promise that a component
  costs what the call would; a forwarding-inline rule in the linker's
  optimizer is what closes the gap. The manual lists it under
  [Not yet available](../language/not-yet.md).
- **There is no "children required".** Spec §4.5 says a `.8bs` call to a
  component whose slot is required is `8BS22xx: children required`. The
  compiler has no required slot: a slotted component is also kept as one
  plain function with the slot elided, and the `.8bs` call form is that
  function (`bx/elaborate.mjs`). The spec's sentence should say so.
- **Not built**: named slots (§34), `{value}` expression children beyond
  elements and conditionals (§20), array-typed props, spread props (§53),
  repetition (§51–§52), refs (§131), structs and struct-backed state
  (PR 14, §55, §61), dynamic instances (§63). The manual keeps the list
  in one place.
- **The checker does not width-check call arguments** (§92): a `u16`
  passed where a `u8` is declared is not yet refused at the call.
- **The 6502 backend refuses 2-byte array element stores**, so the real
  `@8bitscript/ui` menu bar (`item()` stores into a 2-byte array) cannot
  be built natively yet; the §69 gate is measured on a same-shaped bar
  until it can.
- **The editor's shipped extension predates `.8bx`.** From a checkout,
  `pnpm --filter 8bitscript-lang run link-local` and Reload Window; in a
  consumer project, *Use local 8BitScript* makes the language server the
  checkout's.

## What this page used to say, and where it went

The design-direction draft that was here before (#155) is superseded by
the spec. Its content survives as follows:

- *Components compile away* and *`state` is one static variable* — spec
  §26, §29–§30, §36–§37.
- *`<Show>`/`<Fallback>` are `#fact(...)`* — §12, §49, §78, §113.
- *Two responsive tiers*: the compile-time tier is §78–§79; the fluid web
  tier is §74, and it is in milestone 1 rather than deferred.
- *Where this sits in the compiler* — §11, §28, §139.
- *Open questions*: the grammar is §13–§18; the first components are
  §68 (the menu bar); how far `state` goes is §36–§37 and §61; the fluid
  web architecture is the open half of §74; "front end vs. pre-pass
  transform" is closed by §2.1 — a front end, never a preprocessor.
