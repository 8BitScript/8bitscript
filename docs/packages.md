---
title: The package model
nav_order: 2
---

# The package model

8BitScript projects are npm projects. You install the toolchain with pnpm, you
declare libraries as dependencies, and the compiler resolves imports out of
`node_modules`. There is no separate package manager, no vendoring step, and no
git submodules anywhere in the model.

This page began as pure design; most of it is now real. The resolver
implements the resolution contract below, and the linker compiles a program
from its whole import graph — `examples/borders` imports its screen from
`@8bitscript/screen` and its character grid from `@8bitscript/text`, each of
which resolves per target to that machine package's own implementation
(`@8bitscript/vic20/screen`, `@8bitscript/c64/text`, and so on), through
exactly this model. The namespace surfaces those packages export
(`screen.setColors`, `text.putChar`) are real; a machine's own chip-level
namespace (`vic`) still waits on declaration syntax.

## The core idea

Node never executes a `.8bs` file. It does not need to understand one.

`node_modules` is just the directory pnpm puts dependencies in. The compiler
reads it. That single split is what makes the whole ecosystem work: npm handles
**distribution** — versioning, resolution, lockfiles, scopes, caching,
publishing, dependency updates — and 8BitScript handles **compilation**.

The alternative was inventing a bespoke package manager. That is a large amount
of work to arrive somewhere worse.

## What a project looks like

```
space-program/
  src/
    main.8bs
    player.8bs
    enemies.8bs
  package.json
  pnpm-lock.yaml
  8bs.config.ts
```

You install the toolchain the way you would install any other:

```bash
pnpm add -D @8bitscript/cli
pnpm add @8bitscript/screen @8bitscript/text @8bitscript/vic20
```

And a source file imports from those packages by name — one package per
capability, so a program says exactly which parts of a machine it uses:

```
import { screen, BorderColor, BackgroundColor } from "@8bitscript/screen";
import { text } from "@8bitscript/text";
import { input } from "@8bitscript/input";   // planned — not built yet
import { vic } from "@8bitscript/vic20";     // planned — the chip itself

let x: u8 = 10;

export function update(): void {
    if (input.left()) {
        x--;
    }

    screen.setColors(BorderColor.Blue, BackgroundColor.Black);
    text.putChar(x, 10, 65);
}
```

`@8bitscript/screen` and `@8bitscript/text` exist and build (with a flat
cell index for `putChar` today, not `x, y`); `@8bitscript/input` and a
`vic` namespace are the shape the rest will take.

## How an import resolves

When the compiler sees `import { vic } from "@8bitscript/vic20"`, it walks
`node_modules` the way Node would, finds the package directory, and reads its
`package.json` — but it looks at a field of its own rather than at `main` or
`exports`:

```json
{
  "name": "@8bitscript/vic20",
  "version": "0.1.0",
  "8bitscript": {
    "entry": "./src/index.8bs"
  }
}
```

The `8bitscript.entry` field names the module the import resolves to. A package
without that field is not an 8BitScript package, and importing it is an error
the compiler reports rather than something that fails later in a strange way.

That check is implemented. `8bs check` and the editor both report `8BS2001`
when a package is not installed, `8BS2002` when it is installed but carries no
`8bitscript.entry`, and `8BS2003` when the entry it names does not exist — see
[the compiler](compiler.md#import-resolution).

Relative imports resolve against the importing file, as you would expect. A
build's module graph therefore mixes both kinds freely:

```
your main.8bs
      |
      +-- ./player.8bs
      |
      +-- @8bitscript/text
      |         `-- node_modules/@8bitscript/text/package.json   (entry keyed by machine)
      |                   `-- @8bitscript/vic20/text
      |                             `-- node_modules/@8bitscript/vic20/src/text.8bs
      |                                       `-- ./index.8bs   (the registers it is built on)
      |
      `-- @8bitscript/vic20
                `-- node_modules/@8bitscript/vic20/src/index.8bs
```

## Package subpaths

A package can offer more than its entry. `@8bitscript/vic20/screen` — a
package name followed by a subpath — resolves through the package's
`8bitscript.exports` map, whose keys are the subpaths it offers and whose
values are files inside it, the same shape Node's own `exports` field has so
nobody learns a second one:

```json
{
  "name": "@8bitscript/vic20",
  "8bitscript": {
    "entry": "./src/index.8bs",
    "exports": {
      "./screen": "./src/screen.8bs",
      "./text": "./src/text.8bs"
    }
  }
}
```

This is how a target package keeps its implementation of each portable
capability *inside its own package*, next to the registers it is built on:
`src/index.8bs` is the hardware — `vicColor`, `memoryPointer` — and
`src/screen.8bs` imports those registers with an ordinary relative import
and builds the portable `screen` namespace on them. Nothing about the
machine leaks upward, and nothing about the portable surface leaks into the
register file. A project that has declared itself VIC-20 specific may import
the subpath directly; a portable one reaches the same file through
`@8bitscript/screen` (next section).

The exported file follows the [system-specific file](#system-specific-files)
rule like any other `.8bs` path, and the package's native sources ride along
with every subpath, since it is that package's code being linked. A subpath
the map has no key for is `8BS2011` — the package is sound, it just does not
offer that — and a key naming a file the package does not ship is
`8BS2003`, like a missing entry.

## System-specific files

A `.8bs` file is portable by default: `player.8bs` is the player on every
machine. When one machine needs its own version of a file, the version is
named after the machine, beside the portable one:

```
src/
  main.8bs          every machine
  main.nes.8bs      the NES instead
  player.8bs
  player.atari8.8bs
```

`8bs build --target nes` starts from `main.nes.8bs` and, wherever anything
imports `./player.8bs`, reads `player.8bs` — the NES has no version of that
one. `--target atari8` starts from `main.8bs` and reads `player.atari8.8bs`
for the same import. Nothing names the machine-specific files: the import
still says `./player.8bs`, the config still says `src/main.8bs`, and the
filename decides. The machine names are the ones `8bs build --target`
accepts: `vic20`, `c64`, `pet`, `c128`, `atari8`, `nes`, `cx16`, `mega65`,
`web`.

The rule applies to every file in the graph, the same way. A package's
`8bitscript.entry` of `./src/index.8bs` with an `index.nes.8bs` beside it
is that package's NES version, with nothing in the manifest saying so. An
import can also name a machine's version outright — `./player.nes.8bs` —
and gets exactly that file, on every machine; that is the explicit form,
and no further suffix is looked for on it.

A file can exist *only* in machine-specific versions — `player.nes.8bs` and
`player.c64.8bs`, with no `player.8bs`. Building for a machine that has one
is fine; building for one that has none is `8BS3002`, the same code a
[target-conditional entry](#target-conditional-entries) gives for a machine
it has no branch for, because it is the same situation spelled in
filenames. `8bs check` and the editor analyse files rather than builds, so
with no machine in hand they take the portable file when it exists and
accept the import as valid-but-target-dependent when it does not, just as
they do for a conditional entry.

No example in this repository needs one yet. `examples/borders` builds
for all nine targets from one `src/main.8bs`, because the machine packages
absorb every difference it would otherwise have to spell out per machine —
the same ASCII character codes, the same colour names, the same "cell 0 is
the top-left corner inside the border" on every target. That is the
preferred shape: a per-machine file is for a difference a package cannot
absorb, not the first tool to reach for.

## Target-conditional entries

`8bitscript.entry` can also be an object keyed by machine, which is how a
package provides a different implementation per target:

```json
{
  "name": "@8bitscript/screen",
  "8bitscript": {
    "entry": {
      "vic20": "@8bitscript/vic20/screen",
      "c64": "@8bitscript/c64/screen",
      "nes": "@8bitscript/nes/screen",
      "web": "@8bitscript/web/screen"
    }
  }
}
```

Each branch is either a relative path into the package — a package shipping
per-machine source files — or a bare specifier delegating to another
package's entry or [subpath](#package-subpaths), resolved from the
delegating package's own directory so its own dependencies serve it. When
the compiler builds for a machine, that machine's branch is the module the
import resolves to; a machine the object has no branch for is `8BS3002` —
the package genuinely has nothing for that target. `8bs check` and the
editor analyse files rather than builds, so with no machine in hand they
validate every branch instead, and a broken branch is reported before anyone
builds for it.

`@8bitscript/screen` (shown above, abridged — the real one has a branch for
all nine targets) is exactly this and nothing more: no source of its own,
just the machine-keyed delegation to each target package's `./screen`.
Every target's `screen.8bs` exports the same surface — a `screen` namespace
with `setColors(border, background)`, and the eight shared colour names in
`BorderColor` and `BackgroundColor` — so a program that imports it works on
whichever machine it is built for. `@8bitscript/text` is the same shape for
the character grid (`text.putChar`/`putColor`/`showDigit`, `CellCount`).
`examples/borders` builds for all nine targets from one source file this
way. One package per capability, rather than one package for "the machine",
is deliberate: a program imports only the parts of a machine it uses, and
a capability some machines lack (sprites, say) can be a package that
simply has no branch for them — `8BS3002` at build time, not a stub. This
is the first slice of target-conditional code: whole-module today,
per-declaration once that syntax is designed.

The delegation form is what the object is for. A package that merely ships
per-machine *source files* does not need it: `"entry": "./src/index.8bs"`
with an `index.nes.8bs` beside it is the
[system-specific file](#system-specific-files) rule, and reads the same as
it does in a project.

### A project's own entry point

A project's entry point follows the system-specific file rule too, and that
is the whole story: `entry: 'src/main.8bs'` in `8bs.config.ts` (or no
config, which means the same), and a `src/main.nes.8bs` beside it if the
NES needs its own. This is for the case a target-conditional import can't
paper over: when a target's execution model itself differs, not just the
hardware underneath it — not merely which register or memory layout a name
resolves to, but the *shape* of the program itself. (A browser tab calling a
program back once per frame rather than handing it the whole machine used
to be such a case for `web`; the web runtime now hands the program its own
worker thread, and `waitFrame()` means the same thing there as on the 6502
machines, so a single file covers it — see
[docs/learn/step1-main-loop.md](learn/step1-main-loop.md#why-this-step-does-not-build-for-the-web).
`examples/borders` briefly kept per-machine versions of its entry for the
NES, Atari, and X16 too, for their screen codes and grids; those
differences now live in the machine packages, and it is one file again.)

`entry` may also be an object keyed by machine, the older spelling of the
same idea, still honoured:

```ts
export default {
  entry: { default: 'src/main.8bs', nes: 'src/console.8bs' },
  targets: ['vic20', 'c64', 'nes'],
};
```

`default` covers any target not named explicitly. Prefer the filename: it
says the same thing where the file is, and it works for every file in the
project, not only the entry.

## What a package may contain

A package is free to be any of these:

- portable 8BitScript that works on every target
- code for one target only — VIC-20, C64, the browser
- a mix of 8BitScript and hand-written 6502 assembly

Native sources ship inside the package like anything else, so a third-party
library with hand-tuned assembly is an ordinary dependency:

```
node_modules/@somebody/8bs-chipmusic/
  package.json
  src/
    index.8bs
    player.8bs
    effects.8bs
  native/
    6502/
      mixer.s
    c64/
      sid.s
```

Installed with `pnpm add @somebody/8bs-chipmusic`, imported with
`import { MusicPlayer } from "@somebody/8bs-chipmusic"`. Nothing about a
third-party package is different from a first-party one.

The native files are declared next to the entry, as an `"8bitscript".native`
list of paths relative to the package:

```json
{
  "name": "@8bitscript/nes",
  "8bitscript": {
    "entry": "./src/index.8bs",
    "native": ["./native/6502/font.s"]
  }
}
```

This is implemented. Importing the package — directly, or through a
delegating entry such as `@8bitscript/text`'s, or a subpath such as
`@8bitscript/nes/text` — brings its native files
into the build: the linker collects them once each across the module graph,
and the 6502 backend hands them to the LLVM-MOS driver after the generated
C, where a `.s` is assembled and linked like any other input. A listed file
the package does not ship is `8BS2008`, reported where the package is
imported. The web backend ignores the list, so a package that ships
assembly still resolves for `web` — only the `.8bs` half of it is used
there.

`@8bitscript/nes` is the first package to need this, and for data rather
than code: the NES has no character ROM, so a cartridge that shows text
carries its own 8×8 tile patterns, and `native/6502/font.s` is that
character set — 8 KiB placed in the SDK's `.chr_rom` linker section so it
lands in the `.nes` image's CHR bank. No `.8bs` construct can express a
block of bytes bound for a linker section yet; when one can, the font may
move, and this field stays for the assembly it was always meant for.

## Which packages you install

Only two kinds of package are meant for you:

| Package | Role |
| ------- | ---- |
| `@8bitscript/cli` | The `8bs` command. A dev dependency |
| `@8bitscript/screen`, `@8bitscript/text` | The portable standard library, one package per capability: each resolves per target to that machine package's own implementation |
| `@8bitscript/vic20`, `@8bitscript/c64`, `@8bitscript/nes`, … `@8bitscript/web` | Target support, one per machine: the hardware underneath (registers, port protocols), plus that machine's `./screen` and `./text` subpaths |

The compiler, the language server, and the backends are internal:
`@8bitscript/compiler`, `@8bitscript/language-server`,
`@8bitscript/backend-web`, and `@8bitscript/backend-6502`. `@8bitscript/cli` depends on them and pulls them in;
you never name them in your own `package.json`. Keeping that
boundary means the internals can be reorganised without every project having to
follow along.

Later targets — other 6502-family machines — arrive as further target
packages alongside the nine that exist, each adding its branch to the
capability packages it can implement, with nothing else about a project
changing. Later capabilities — `input`, `sprites` — arrive as further
portable packages of the same shape.

## Developing the toolchain itself

This repository is a pnpm workspace:

```yaml
packages:
  - packages/*
  - examples/*
```

`packages/` holds the toolchain. `examples/` holds programs that consume it,
and they depend on it with `workspace:*`:

```json
{
  "devDependencies": { "@8bitscript/cli": "workspace:*" },
  "dependencies": {
    "@8bitscript/text": "workspace:*",
    "@8bitscript/vic20": "workspace:*"
  }
}
```

`pnpm install` links those straight out of `packages/`. The example resolves
them through its own `node_modules` exactly as an installed project would, so
an example is a genuine consumer rather than a special case wired up by the
build. Nothing has to be published for this to work.

[`examples/hello-vic`](https://github.com/8BitScript/8bitscript/tree/trunk/examples/hello-vic)
is the first of them. Once the compiler exists, the development loop is:

```
edit the compiler
      |
      v
edit examples/hello-vic/src/main.8bs
      |
      v
pnpm --filter hello-vic run:vic20
      |
      v
VICE opens
```

The CLI is real now, and that loop works — though `hello-vic` itself still
does not compile, because the `input` package it imports does not exist yet.
[`examples/borders`](https://github.com/8BitScript/8bitscript/tree/trunk/examples/borders)
is the example that goes end to end today: it imports `@8bitscript/screen`
and `@8bitscript/text` and runs on all nine targets.

## Does npm actually allow this?

Yes. This was verified against the real registry rather than assumed, because
"npm might not accept a custom language's files" is a reasonable worry and a bad
one to discover late.

**npm does not look inside a package.** A package is a tarball. Nothing
validates that its contents are executable by Node, and nothing requires a
`main` field at all. Two long-standing packages make the point: `normalize.css`
publishes with `main` pointing at a `.css` file, and every `@types/*` package
ships only type declarations that Node never runs.

What was actually checked, using the first package manifest in this
repository (the since-retired `@8bitscript/core`; today's `@8bitscript/text`
has the same shape):

| Check | Result |
| ----- | ------ |
| `pnpm pack` | Produced a tarball containing `package.json`, `src/index.8bs`, and `LICENSE` |
| Custom manifest field | `"8bitscript": { "entry": "./src/index.8bs" }` survived verbatim |
| Install from that tarball into an unrelated project | Resolved; `node_modules/@8bitscript/core/src/index.8bs` was present and readable |
| `npm publish --dry-run` | Succeeded — no complaint about the missing `main`, the `.8bs` payload, or the unknown field. Only authentication was missing |

So the model holds: npm carries the bytes and the version metadata, and the
compiler is the only thing that has to understand them.

### Two things that will bite at publish time

**Scoped packages default to restricted access.** `@8bitscript/*` will not
publish publicly without it being asked for, and on a free account a restricted
publish fails outright. Rather than rely on remembering `--access public`, the
user-facing manifests set it themselves:

```json
"publishConfig": { "access": "public" }
```

**Publish with pnpm, from the workspace.** `pnpm pack` run inside the workspace
included the repository's root `LICENSE` in the tarball; `npm publish` run
against an isolated copy of the same package did not, because there was no
LICENSE beside it to find. A package published without its licence is a real
problem, so either publish through pnpm from the workspace or give each package
its own `LICENSE` file.

### Still to confirm

Nothing is published under `@8bitscript/*` today — that much is confirmed. What
cannot be checked without signing in is whether the **`8bitscript` organisation
name itself** is still claimable on npm. Confirm it by trying to create the
organisation at `npmjs.com/org/create` before depending on the scope.

## The first real consumer test

Every manifest under `packages/` is `private: true` right now. Nothing is
releasable, and that flag means an accidental `pnpm publish` refuses rather than
putting an empty package on the registry under a name we care about.

Before the first release, the check worth running is the same tarball flow used
above, but end to end from a project outside this repository:

```bash
cd packages/cli
pnpm pack
```

Then, from that other project:

```bash
pnpm add -D ../8bitscript/packages/cli/8bitscript-cli-0.0.0.tgz
```

That installs exactly the bytes an npm user would receive, which a `workspace:*`
link does not: workspace links ignore the `files` field, so a package can depend
on something that would never be published and nobody notices until release
day. Swapping that path for `@8bitscript/cli` is then the only change the
consuming project needs.

This full version is deliberately deferred. One workspace example has to build
before a second, separate project is worth maintaining.
