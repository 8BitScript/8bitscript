---
title: Project config
nav_order: 3
---

# Project config

An 8BitScript project is a directory with an `8bitscript.config.ts` (or
the older `8bs.config.ts`). Node 26 loads it as a module. The CLI and
the editor read the same file.

```ts
export default {
  entry: 'src/main.8bs',
  frameRate: 60,
  targets: {
    pet: { hardware: { model: '4032', ram: '32' } },
    web: {},
  },
  systems: {
    'PET 2001 (8K)': { target: 'pet', profile: '2001', hardware: { ram: '8' } },
  },
  requires: { 'memory.ram': 8192 },
};
```

## Keys

| Key | Meaning |
| --- | --- |
| `entry` | The source file a build starts from. A `.<machine>.8bs` twin beside it is used on that machine. An object `{ default, nes }` still works. |
| `frameRate` | Logical frames per second for `waitFrame()` and `#frames(...)`. Positive integer. Default 60. Not `--pal`. |
| `targets` | Machines this project builds for: an array of names, or an object. Per machine: `hardware` (default options), `profiles` (named option sets `--profile` accepts), `release` (what `8bs build --release` builds). |
| `systems` | Advertised named machines. Each value is `{ target, profile?, hardware?, region? }`. A name cannot be a machine id (`pet`, `c64`, …). The whole team sees these; they are source. |
| `requires` | Fact floors (`memory.ram`, `storage.save`, …). A system or a build that cannot meet them is refused with what would. |

`restoreOnExit` is retired. If the file still sets it, the CLI says so
and ignores it.

## Named systems, three places

A system is always `{ target, profile?, hardware?, region? }`. `--system
'PET 2001 (8K)'` on `8bs run`, `8bs build`, and `8bs boot` resolves the
name, then becomes the existing `--profile` / `--hardware` / `--pal`
path. CLI flags sit on top.

| Layer | File | Git | Who it is for |
| --- | --- | --- | --- |
| Advertised | `systems` in this config | committed | What the project tells everyone to run |
| Project-personal | `.8bitscript/systems.json` | gitignored | This clone only |
| User | `~/.config/8bitscript/systems.json` | outside the repo | This machine; shown only when the project's `targets` include that system's `target` |

First name wins: project, then user, then advertised. `8bs targets --json`
tags each row with `origin`. The JSON files are `{ "systems": { … } }`;
the schema is `packages/cli/schemas/systems.json`.

## A local 8BitScript checkout

Do not rewrite a consumer `package.json` to `link:` or `file:`. Point the
tool at the monorepo instead:

```
8bs run pet --checkout /path/to/8bitscript
```

or `EIGHTBITSCRIPT_CHECKOUT`, or `.8bitscript/toolchain.json`:

```json
{ "checkout": "../8bitscript" }
```

A tree counts as a checkout when it has `pnpm-workspace.yaml` listing
`packages/*` and `packages/cli/bin/8bs.mjs`. `@8bitscript/*` then resolve
from that tree's `packages/` before `node_modules`. The app's published
versions stay in git. Schema: `packages/cli/schemas/toolchain.json`.

The editor's side bar has one **Update** / **Install** for that tree: the
open workspace if it is this repo, otherwise a clone it keeps under the
extension's global storage (`…/checkout`). Opening the repo always uses
the workspace copy. The clone is not `--checkout` on a consumer until
**Use local 8BitScript**; it is how Studio and the examples are found
when the only project open is something like 2048.
