---
title: Project config
nav_order: 3
---

# Project config

An 8BitScript project is a directory with an `8bitscript.config.ts` (or
the older `8bs.config.ts`). Node 26 loads it as a module. The CLI and
the editor read the same file.

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

`defineConfig` returns what it is given; it exists so an editor can type
the object (`packages/cli/src/index.d.ts` is the shape, and
`packages/cli/schemas/config.json` the same shape as a JSON schema). A
plain `export default { … }` is still a config.

## Keys

| Key | Meaning |
| --- | --- |
| `entry` | The `.8bs` file a build starts from — an `.8bx` is refused by name: a program starts from `.8bs` and reaches a component by importing it and calling it (`Hello();` is `<Hello />` the way `.8bs` spells it). A `.<machine>.8bs` twin beside it is used on that machine. An object `{ default, nes }` still works. The one-program spelling of `programs`, below. |
| `programs` | Several programs in one project, each its own build from its own `.8bs` entry: `{ main: { entry }, format: { entry, targets?, requires? } }`. Cannot be given together with `entry`. See below. |
| `images` | Disk images over the programs — a `.d64` holding several of them plus data files. Checked by every build; written by a later release. See below. |
| `locale` | The locale every build is for, unless a target's `locale`, a `release` entry's `locale`, or `--locale` says otherwise. A name of two to eight lower-case letters with an optional `-region` (`de`, `pt-br`) — never a machine's name or one of its hardware tags. With one, a file's `.<locale>` twin is read where it exists (`strings.de.8bs`; `strings.pet.de.8bs` for the PET's own twin; `strings.pet.8032.de.8bs` for the 8032's), the artifact's name carries it (`2048-pet-de.prg`, `program-de.wasm`), and `#locale("de")` folds to `true`. Without one — the default — no locale's file is read, every name stays as it was, and `#locale(...)` is `false`. A locale never changes *which* machine twin is chosen; it refines it, and a machine twin with no version in the locale is used with a warning (`8BS3005`) when the plain file has one. See below. |
| `bx` | 8BX settings: `{ strict: false }` turns the ordinary-code lint in `.8bx` files off (`8BS2021`, a warning on a top-level function that composes nothing or a top-level `let`). The hard rules — no `asm6502` in `.8bx` (`8BS2020`), no `.8bx` program entry — stay. |
| `frameRate` | Logical frames per second for `waitFrame()` and `#frames(...)`. Positive integer. Default 60. Not `--pal`. |
| `targets` | Machines this project builds for: an array of names, or an object. Per machine: `hardware` (default options), `profiles` (named option sets `--profile` accepts), `release` (what `8bs build --release` builds). |
| `systems` | Advertised named machines. Each value is `{ target, profile?, hardware?, region? }`. A name cannot be a machine id (`pet`, `c64`, …). The whole team sees these; they are source. |
| `requires` | Fact floors (`memory.ram`, `storage.save`, …). A system or a build that cannot meet them is refused with what would. |
| `i18n` | Message catalogs under `catalog` (`src/i18n/<locale>.8bs` by default), imported as `@8bitscript/i18n/catalog`. `{ defaultLocale, fallbackLocale, locales, catalog, charset }`. A project without this block and without that directory is unchanged. See below. |

`restoreOnExit` is retired. If the file still sets it, the CLI says so
and ignores it.

## Several programs in one project

A project may build more than one program — a desktop and the utilities
beside it, the way GEOS ships a formatter and a copier as separate files
on the same disk. Each is its own build, from its own `.8bs` entry:

```ts
programs: {
  main:   { entry: 'src/main.8bs' },
  format: { entry: 'src/tools/format.8bs', targets: ['c64', 'c128'], requires: { 'memory.ram': 32768 } },
  copy:   { entry: 'src/tools/copy.8bs',   targets: ['c64', 'c128'] },
},
```

- **The key is the output stem.** `format` builds to
  `dist/format-c64-ntsc.prg`; on the web, to `dist/web/format/`. A project
  with one program keeps `dist/web/` flat, where every deploy so far has
  looked.
- **`entry: 'src/main.8bs'` still works**, and means exactly
  `programs: { main: { entry: 'src/main.8bs' } }` — with one difference
  kept on purpose: its stem is the entry's own filename
  (`hello-world.8bs` → `hello-world-pet.prg`), as it always was, so no
  project's `dist/` names move because a second spelling exists. `entry`
  and `programs` together is an error.
- **Every entry is a `.8bs` file.** An `.8bx` declares composition and
  is imported by the program; it is never the program (the 8BX spec's
  §4.3). `entry` and `programs.*.entry` alike refuse one by name before
  the linker runs.
- **A program's `targets` is a subset of the project's**; a drive utility
  only builds where there are drives. Its `requires` may raise a floor
  above the project's and never lower one.
- **Shared code is compiled into each program.** A package two programs
  use is in both binaries.
- **Twin files apply per entry**: `format.c64.8bs` beside `format.8bs`.

Reaching one: `8bs build --target c64 --program format`, `8bs run c64
--program format`. Without `--program` the program is `main`, or the only
one there is. `8bs build --release` builds every program for every target
it (or the project) lists, once per name in that target's `release`
array. `8bs targets` lists the programs; `8bs targets --json` carries them
as `programs` for the editor.

## One binary per locale

A 4K PET has no room for a language switch, so a locale is a build input,
not a runtime one: `strings.8bs` beside `strings.de.8bs`, and the build
picks one. The locale is the innermost twin dimension and always the last
word before the extension:

| File | Read by |
| --- | --- |
| `strings.8bs` | every build with no locale, and the fallback for the rest |
| `strings.de.8bs` | a `de` build, on machines with no `strings.<machine>.8bs` |
| `strings.pet.8bs` | the PET, in any locale it has no file for (with `8BS3005` when `strings.de.8bs` exists) |
| `strings.pet.de.8bs` | a `de` PET build |
| `strings.pet.8032.de.8bs` | a `de` PET build fitted as an 8032 |

The same rule applies to `.8bx` files. Which builds are made:

```ts
export default defineConfig({
  targets: {
    pet: { release: ['2001', {}, { locale: 'de' }, { profile: '2001', locale: 'de' }] },
    web: { locale: 'de' },                            // this target's own; the plain files stay the default elsewhere
  },
});
```

`8bs build --target pet --locale de` and `8bs run pet --locale de` build one
locale by hand. A file with one line to translate can branch instead of
splitting: `if (#locale("de")) { … } else { … }` folds at compile time, and
is `false` in every build that names no locale.

The twin rule applies inside packages too. `@8bitscript/i18n` is one file
per locale — its `Locale.DECIMAL` and `Locale.GROUP` are the build's
locale's separators, and `@8bitscript/i18n/number` prints a grouped
number with them — so a program reads one name and the build picks the
file. Message catalogs are a different seam: `src/i18n/en.8bs` beside
`src/i18n/de.8bs`, imported as `@8bitscript/i18n/catalog`. The compiler
merges the selected locale with the fallback, interpolates
`i18n.format(...)`, and transliterates Latin extras (`Ü` → `UE`) into
the portable set. One locale, one image.

```ts
export default defineConfig({
  i18n: {
    defaultLocale: 'en',
    fallbackLocale: 'en',
    locales: ['en', 'de'],
    charset: 'transliterate', // or 'strict'
  },
});
```

A project with catalogs and no nearer locale uses `defaultLocale` (`en`),
so English needs no `--locale` and keeps the artifact name it always had.
A different locale still tags the file (`2048-pet-de.prg`). A project
with neither the `i18n` block nor a catalog directory still names no
locale, and `#locale(...)` stays false. `--locale`, a `release` entry's
`locale`, `targets.<m>.locale`, and top-level `locale` still pick twins
(`index.de.8bs`).

## Images

A disk image is a container over built programs and data files, written
after `--release` builds the programs. It changes no program's bytes,
which is what separates it from a cartridge: a cartridge changes the
build (its start-up, its load address, the facts a program folds on), so
it is a hardware `media` option in the machine's catalog — the Atari's
`xex` | `cart8` | `cart16` — selected with `--hardware media=…` or a
`release` entry, and needs nothing here.

```ts
images: {
  'geos-tools': {
    target: 'c64',
    format: 'd64',          // d64 | d71 | d81 on the Commodores, atr on the Atari
    boot:   'main',         // written first: what LOAD "*",8,1 loads
    files: [
      { program: 'main',   name: 'GEOS TOOLS' },   // the on-disk name, 16 characters at most
      { program: 'format', name: 'FORMAT' },
      { path: 'assets/font.bin', name: 'FONT' },   // a plain file; type 'seq' unless said
    ],
  },
},
```

Every file has an on-disk name of its own: CBM DOS holds sixteen bytes
and truncates the rest without a word, so the host filename
(`hello-world-c64-ntsc.prg`, twenty characters) never leaks onto the
disk. An image's `target` must be one every listed program builds for;
the NES and the web have no image to write (the cartridge and the bundle
are the program).

**This release validates images and writes none.** `8bs build --release`
names each one it checked and says so, so a `dist/` never looks more
complete than it is. The writer (`c1541` for the Commodore formats, which
ships with VICE) is a later release's.

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
