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

**The design lives in one place: the [8BX spec](https://claude.ai/artifact/TSrjouGF1HVEAUA2NeVES9)**
(142 sections, kept current as decisions are made). This page is not a
second copy of it. It says what the repository has today and how that
differs from the spec, which rules of the spec code already enforces, and
where the earlier design-direction draft that used to live here was
superseded.

## What exists today

- **`.8bx` is a source kind.** The compiler asks one module
  (`packages/compiler/src/source/index.mjs`) what a path is; the resolver's
  twin rule keeps the kind it was given (`App.8bx` on the PET is
  `App.pet.8bx`); an `.8bx` module imports, links and takes machine twins
  exactly as `.8bs` does; VS Code registers `.8bx` as `8bitextensible`
  and sends it to the same language server. Spec §5, §6, §80–§84, §141.
- **A first grammar and elaborator** (#158): `component Name(props) {…}`,
  `<Name prop={expr} />`, fragments, text children, and stateless
  elaboration to plain calls — `hello-bx` builds byte-identical to
  `hello-world` on the PET. The pipeline is in [Compiler](../compiler.md).
  What is on trunk differs from the spec in one way the spec's remaining
  PRs close, and it is a fact about today's code, not the design:
  - `@8bitscript/ui/menubar`'s `item()` stores into a 2-byte array,
    which the native backend does not write yet, so the real menu bar
    cannot be built for a 6502 by hand or as elements; the §69 gate is
    measured on a same-shaped bar until it can.
- **Element syntax is the lexer's** (§13–§16): tag, children and
  expression modes on a stack, `<` opening a tag only where no value sits
  before it, raw text as one token; the parser reads tokens, so every
  diagnostic inside `{…}` points into the file, and every half-typed tag
  recovers (§90). Text children are normalized the JSX way, once (§35).
- **A component is a function; an element is a call to it.** That gives
  hygiene, evaluate-once props (§104) and `export component` across
  modules (§9–§11) in one move; the linker's inliner makes a
  compile-time-prop element cost what the hand-written calls would (§64,
  §65). `component` is a keyword in `.8bx` only (§129).
- **State is storage per static instance** (§36–§37): `state f: T = v;`
  in a component body; each element (or `.8bs` call site) is an instance
  with its own function and its own globals, laid out at compile time,
  templates dropped, every byte in `8bs build --size` (§119).
- **Children go where `<slot />` is** (§33): a slotted component is two
  functions around its children, so they run once, in place (§105).
  `@8bitscript/ui/menubar-bx` is `<MenuBar row width><MenuItem label />…</MenuBar>`
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
  images that will package them, `bx.strict` for the lint that lands with
  the purity rule — see [Project config](../config.md). Spec §4.6–§4.8.

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
