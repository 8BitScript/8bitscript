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
  What is on trunk differs from the spec in ways the spec's PRs 4–8 are
  meant to close, and the differences are facts about today's code, not
  the design:
  - element syntax is scanned from the raw text at a statement's `<`
    (`src/bx/parse.mjs`) rather than by a lexer mode (§13–§16), so a
    diagnostic inside a `{…}` attribute carries the substring's offset;
  - a prop is substituted by name into the component body (§104 asks for
    a temporary when it is used more than once);
  - children elaborate before the component's body, and there is no
    `<slot />` (§33) — which is why `@8bitscript/ui`'s `menubar.8bx`
    needs a `MenuBarEnd` component;
  - a component imported from another module is not yet recognised as
    one (§9–§11: this is what the semantic program model is for);
  - `component` is a keyword in `.8bs` too (§129 keeps `.8bs`
    unchanged);
  - `?:` lowers on the 6502 backend and not yet on the web (§99).
- **The program entry rule is decided but not yet enforced.** The spec
  says a program starts from `.8bs` and reaches its components by
  importing them (§4.3, §4.5); `hello-bx`'s entry is `src/hello-bx.8bx`
  with `main()` inside, because calling a component from `.8bs` (§4.5)
  needs the cross-module binding above. `programs.*.entry` in the config,
  being new, is `.8bs` only; `entry` accepts `.8bx` until §4.5 lands.
- **The config knows its shape.** `defineConfig` from `@8bitscript/cli`,
  `programs` for several programs in one project, `images` for the disk
  images that will package them, `bx.strict` for the lint that lands with
  the purity rule — see [Project config](../config.md). Spec §4.6–§4.8.

## The rules already decided

These are the spec's, restated here because each one is enforced (or
reserved) by code on trunk; the spec has the reasoning.

| Rule | Where | Spec |
| --- | --- | --- |
| `.8bs` is code, `.8bx` is composition. `asm6502` never appears in `.8bx`; machine code lives in `.8bs` and is imported. Ordinary declarations in `.8bx` are a lint (`bx.strict`). | not yet; `bx.strict` accepted now | §2.6 |
| The program entry is always `.8bs`. A package's `"8bitscript".entry` may be `.8bx` — that is an import, not a program. | `programs.*.entry` only (`packages/cli/src/programs.mjs`); `entry` waits on §4.5 | §4.3 |
| `.8bs` reaches a component as a positional call: `App();`, `Player(20, 40);` — the same elaboration `<Player x={20} y={40} />` gets. No children across the boundary. | not yet — needs cross-module component binding | §4.5 |
| Several programs per project; the key is the output stem; `entry` is sugar for `programs.main` with the filename stem kept. | `packages/cli/src/programs.mjs` | §4.6 |
| A cartridge is hardware (a catalog `media` option); a disk image is a container over built programs, declared in `images`. | Atari catalog `media`; `programs.mjs` `resolveImages` | §4.7 |
| Fluid web — layout to the viewport at run time, as a distinct web build variant that costs the other eight machines nothing — is in the first milestone. | not yet | §74, §129 |

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
