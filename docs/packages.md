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
from its whole import graph — `examples/border` imports its colour API from
`@8bitscript/machine`, which resolves per target to `@8bitscript/vic20` or
`@8bitscript/c64`, through exactly this model. What crosses a module boundary
is still bounded by the milestone subset (globals and parameterless function
calls), and the namespace-style surfaces sketched below (`screen.putChar`,
`vic`) wait on declaration syntax.

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
pnpm add @8bitscript/core @8bitscript/vic20
```

And a source file imports from those packages by name:

```
import { screen, input } from "@8bitscript/core";
import { vic } from "@8bitscript/vic20";

let x: u8 = 10;

export function update(): void {
    if (input.left()) {
        x--;
    }

    screen.putChar(x, 10, 65);
}
```

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
      +-- @8bitscript/core
      |         `-- node_modules/@8bitscript/core/src/index.8bs
      |
      `-- @8bitscript/vic20
                `-- node_modules/@8bitscript/vic20/src/index.8bs
```

## Target-conditional entries

`8bitscript.entry` can also be an object keyed by machine, which is how a
package provides a different implementation per target:

```json
{
  "name": "@8bitscript/machine",
  "8bitscript": {
    "entry": {
      "vic20": "@8bitscript/vic20",
      "c64": "@8bitscript/c64",
      "web": "@8bitscript/web"
    }
  }
}
```

Each branch is either a relative path into the package — a package shipping
per-machine source files — or a bare specifier delegating to another package,
resolved from the delegating package's own directory so its own dependencies
serve it. When the compiler builds for a machine, that machine's branch is
the module the import resolves to; a machine the object has no branch for is
`8BS3002` — the package genuinely has nothing for that target. `8bs check`
and the editor analyse files rather than builds, so with no machine in hand
they validate every branch instead, and a broken branch is reported before
anyone builds for it.

`@8bitscript/machine` (shown above) is exactly this and nothing more: no
source of its own, just the machine-keyed delegation. All three target
packages export the same surface — `border`, `background`, `applyColors()`,
and `screen.showDigit()` — so a program that imports it works on whichever
machine it is built for.
`examples/border`'s `vic20` and `c64` builds share one source file this way.
This is the first slice of target-conditional code: whole-module today,
per-declaration once that syntax is designed.

### A project's own entry can be target-conditional too

A package's `8bitscript.entry` picks a different *import* per target; a
project's own `8bs.config.ts` can pick a different *entry point* per target
the same way, keyed identically:

```ts
export default {
  entry: { default: 'src/main.8bs', web: 'src/main.web.8bs' },
  targets: ['vic20', 'c64', 'web'],
};
```

`default` covers any target not named explicitly. This exists for the case a
target-conditional import can't paper over: when a target's execution model
itself differs, not just the hardware underneath it. `web` is exactly that —
a browser calls a program back once per frame instead of handing it the
whole machine forever the way a VIC-20 or a C64 does — so `examples/border`
uses this to give `web` its own entry file, `main.web.8bs`, shaped for that
contract instead of `main.8bs`'s `while (true)`. See
[docs/learn/step1-main-loop.md](learn/step1-main-loop.md#why-this-step-does-not-build-for-the-web)
for the reasoning, and `main.web.8bs`'s own header comment for what the
per-frame contract (`main()` sets up once, `frame()` is the per-frame
callback) looks like from inside the program.

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

## Which packages you install

Only two kinds of package are meant for you:

| Package | Role |
| ------- | ---- |
| `@8bitscript/cli` | The `8bs` command. A dev dependency |
| `@8bitscript/core` | The portable standard library |
| `@8bitscript/vic20`, `@8bitscript/c64`, `@8bitscript/web` | Target support, one per machine |
| `@8bitscript/machine` | The machine underneath, whichever it is: resolves per target to a target package |

The compiler, the language server, and the backends are internal:
`@8bitscript/compiler`, `@8bitscript/language-server`,
`@8bitscript/backend-web`, and `@8bitscript/backend-6502`. `@8bitscript/cli` depends on them and pulls them in;
you never name them in your own `package.json`. Keeping that
boundary means the internals can be reorganised without every project having to
follow along.

Later targets — other 6502-family machines — arrive as further target packages
alongside `vic20` and `c64`, with nothing else about a project changing.

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
    "@8bitscript/core": "workspace:*",
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
does not compile, because its calls and member access wait on the binder.
[`examples/border`](https://github.com/8BitScript/8bitscript/tree/trunk/examples/border)
is the example that goes end to end today: it imports hardware registers from
`@8bitscript/vic20` and `@8bitscript/c64` and runs on both machines.

## Does npm actually allow this?

Yes. This was verified against the real registry rather than assumed, because
"npm might not accept a custom language's files" is a reasonable worry and a bad
one to discover late.

**npm does not look inside a package.** A package is a tarball. Nothing
validates that its contents are executable by Node, and nothing requires a
`main` field at all. Two long-standing packages make the point: `normalize.css`
publishes with `main` pointing at a `.css` file, and every `@types/*` package
ships only type declarations that Node never runs.

What was actually checked, using `@8bitscript/core` as it stands in this
repository:

| Check | Result |
| ----- | ------ |
| `pnpm pack` | Produced a tarball containing `package.json`, `src/index.8bs`, and `LICENSE` |
| Custom manifest field | `"8bitscript": { "entry": "./src/index.8bs" }` survived verbatim |
| Install from that tarball into an unrelated project | Resolved; `node_modules/@8bitscript/core/src/index.8bs` present and readable |
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

Nothing is published at `@8bitscript/core` today — that much is confirmed. What
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
