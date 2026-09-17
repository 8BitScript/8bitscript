---
title: "Project & CLI"
nav_order: 5
---

# Project & CLI

## §4.1 Write a project config

An 8BitScript project is a directory with an `8bitscript.config.ts` (the older `8bs.config.ts` still works). `defineConfig` just returns what it's given — it exists so an editor can type the object.

```ts
import { defineConfig } from '@8bitscript/cli';

export default defineConfig({
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
});
```

| Key | Meaning |
| --- | --- |
| `entry` | The single `.8bs` file a build starts from. An `.8bx` here is refused by name ([§3](boundary.md)). Sugar for `programs.main` — see [§4.2](#42-build-several-programs-in-one-project). |
| `programs` | Several programs in one project, each its own build. Cannot be given together with `entry`. [§4.2](#42-build-several-programs-in-one-project). |
| `images` | Disk images over built programs. Checked every build, written by a later release. [§4.3](#43-package-a-cartridge-or-a-disk-image). |
| `bx` | `{ strict: false }` turns off the `8BS2021` ordinary-code lint ([§2.7](composition.md#27-the-purity-rule-whats-refused-and-linted-in-8bx)). The hard rules stay regardless. |
| `frameRate` | Logical frames per second for `waitFrame()` / `#frames(...)`. Default 60. |
| `targets` | Machines this project builds for — a name array, or an object with per-machine `hardware`, `profiles`, `release`. |
| `systems` | Advertised named machines, `{ target, profile?, hardware?, region? }`. [§4.4](#44-name-a-system-for-a-teammate). |
| `requires` | Fact floors (`memory.ram`, `storage.save`, …) — a system or build that can't meet them is refused, and told by how much. |

## §4.2 Build several programs in one project

A desktop and its utilities, on one disk — each program is its own build from its own `.8bs` entry:

```ts
programs: {
  main:   { entry: 'src/main.8bs' },
  format: { entry: 'src/tools/format.8bs', targets: ['c64', 'c128'], requires: { 'memory.ram': 32768 } },
  copy:   { entry: 'src/tools/copy.8bs',   targets: ['c64', 'c128'] },
},
```

- The key is the output stem: `format` builds to `dist/format-c64-ntsc.prg`.
- A program's `targets` is a subset of the project's; its `requires` may only raise the project's floor, never lower it.
- Shared code compiles into each program separately — a package two programs use is in both binaries.
- Twin files ([§1.7](core.md#17-override-one-file-per-machine-twin-files)) apply per entry.

Reach one with `8bs build --target c64 --program format` or `8bs run c64 --program format`. Without `--program`, it's `main`, or the only one there is.

## §4.3 Package a cartridge or a disk image

These are two different build steps, kept apart on purpose:

|  | Changes program bytes? | Where it's configured |
| --- | --- | --- |
| **Cartridge** | Yes — it's hardware: start-up code, load address, the facts the program folds on. | A `media` option in the machine's own hardware catalog (e.g. Atari `xex` / `cart8` / `cart16`), selected with `--hardware media=…` or a `release` entry. |
| **Disk image** | No — it's a container, written after `--release` builds the programs it holds. | `images` in the config, referencing programs by name. |

```ts
images: {
  'geos-tools': {
    target: 'c64',
    format: 'd64',          // d64 | d71 | d81 on Commodores, atr on the Atari
    boot:   'main',         // written first: what LOAD "*",8,1 loads
    files: [
      { program: 'main',   name: 'GEOS TOOLS' },   // on-disk name, 16 chars at most
      { program: 'format', name: 'FORMAT' },
      { path: 'assets/font.bin', name: 'FONT' },   // a plain file
    ],
  },
},
```

Every file gets an on-disk name distinct from its host filename — CBM DOS holds sixteen bytes and truncates the rest silently. This release validates and names every image it would write; the writer itself (`c1541` for the Commodore formats) ships in a later release.

## §4.4 Name a system for a teammate

A system is `{ target, profile?, hardware?, region? }`, reached everywhere by `--system 'Name'` on `8bs run`, `8bs build`, and `8bs boot`. Three layers, first name wins:

| Layer | File | Committed? |
| --- | --- | --- |
| Advertised | `systems` in the config | Yes — what the project tells everyone to run |
| Project-personal | `.8bitscript/systems.json` | No — gitignored, this clone only |
| User | `~/.config/8bitscript/systems.json` | Outside the repo — this machine |

## §4.5 The CLI commands

| Command | Does |
| --- | --- |
| `8bs check <files…>` | Front-end diagnostics only, no build. Real example from 2048: `8bs check src/2048.8bs src/game.8bs src/Screen.8bx` |
| `8bs build --target <t>` | Real output for that machine. `--profile <name>` a catalog preset; `--hardware opt=value,…` single options on top; `--size` prints the byte breakdown ([§7.2](examples.md#72-2048s-screen8bx-byte-for-byte)); `--program <name>` for a multi-program project ([§4.2](#42-build-several-programs-in-one-project)). |
| `8bs run <t>` | Builds and boots in the real emulator (or a browser tab for `web`). `--screenshot <file.png> --frames <n>` for a headless capture instead of an interactive window. |
| `8bs targets [--json]` | Lists every target and its hardware catalog; `--json` is what the editor reads. |
| `8bs boot <t>` | Opens the target's own emulator fitted with `--profile`/`--hardware`/`--pal` exactly as `8bs run` would, but loads nothing: the stock machine booting to its own prompt. For checking a hardware combination boots before spending a build on it. Refused for `web`, which has no emulator without a program. |
| `8bs doctor` | Checks Node, pnpm, git, and the emulators are in place. |
| `8bs setup <mega65\|cx16>` | Builds that machine's emulator and installs a ROM. |
| `8bs controller` | Finds the pad plugged into this machine and writes down what its buttons are called. |
| `8bs lsp` | The language server, on stdio. |

## §4.6 Point a project at a local checkout

Never rewrite a consumer's `package.json` to `link:`/`file:` — point the tool at the monorepo instead, so the app's published versions stay exactly as committed in git:

```bash
8bs run pet --checkout /path/to/8bitscript
```

Or set `EIGHTBITSCRIPT_CHECKOUT`, or add `.8bitscript/toolchain.json`: `{ "checkout": "../8bitscript" }`. A tree counts as a checkout once it has a `pnpm-workspace.yaml` listing `packages/*` and `packages/cli/bin/8bs.mjs`.
