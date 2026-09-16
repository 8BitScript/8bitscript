---
"@8bitscript/cli": minor
"8bitscript-lang": minor
---

`8bitscript.config.ts` learns its own shape, and a project can build more
than one program.

- `import { defineConfig } from '@8bitscript/cli'` types the config
  (`src/index.d.ts`; `schemas/config.json` is the same shape as a JSON
  schema). A plain `export default { … }` is still a config.
- `programs: { main: { entry }, format: { entry, targets?, requires? } }`
  — each its own build from its own `.8bs` entry, the key its output stem
  (`dist/format-c64-ntsc.prg`, `dist/web/format/`). `entry: 'src/main.8bs'`
  still works and means `programs: { main: { entry } }` with the entry's
  filename as the stem, so no existing `dist/` name moves. An `.8bx` entry
  is refused by name: a program starts from `.8bs`. `--program <name>` on
  `8bs build` and `8bs run`; `--release` builds every program for the
  targets it lists; `8bs targets` lists them and `--json` carries them;
  the last-run file records which program ran.
- `images: { name: { target, format, boot, files } }` — disk images over
  the programs, validated by every build and named by `--release`, which
  says plainly that it does not write them yet.
- `bx: { strict }` is accepted, for the 8BX lint that lands with the
  grammar.
- The editor's project reader understands a `programs` block, so "the"
  program is `main`'s entry and the others are listed beside it.
