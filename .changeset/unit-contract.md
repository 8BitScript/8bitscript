---
"@8bitscript/compiler": minor
"@8bitscript/cli": minor
"@8bitscript/pet": minor
"@8bitscript/vic20": minor
"@8bitscript/c64": minor
"@8bitscript/cx16": minor
"@8bitscript/web": minor
"8bitscript-lang": minor
---

A program is now a unit an editor can run on its own, with its own settings. Three pieces make the contract:

**`#define("NAME", default)`** is a value the build is handed — a seed, a flag, a starting amount — with the default written where it is read, so a plain build, `8bs check` and the editor never lack one. `8bs run c64 --program slot5x5 --define SEED=42 --define FORCE_BONUS=true` (repeatable) replaces it for one build, and a `define: { SEED: 42 }` under a program in `8bitscript.config.8bs` does so on every build of it; the command line wins over the config, the config over the default. It folds to a literal, so a different value is a different build and a program that reads none is byte-identical (15 example builds on pet, c64, vic20, cx16 and web measured the same). The name is in capitals; the default is a whole number, `true`/`false`, or a string (`8BS1047`); a value of the wrong kind is `8BS1048`; one name with two defaults in one program is `8BS1049`. A `--define` for a name the program never reads is an error naming the nearest name it does read, and a config `define` nothing reads is a warning. `8bs check` takes `--define` too, and a build records what its defines came to in `dist/.8bs-last-<target>.json`. Hover, completion, a `#define` snippet and the docs are updated.

**`8bs project [--json]`** describes the project with the CLI's own loader instead of a regular expression over the config: its programs — with the new display keys `title`, `description` and `group`, the machines each builds for, and the `#define` names each reads with the defaults found in its source by the compiler — its targets, locales and named systems, and anything wrong with them as `problems` rather than a failure. Exit 0 when described, 1 when a config exists and will not load. The shape is in `docs/project/units.md`.

**`8bs targets --json` says how each machine can be run**: a `runtime` object with `native` (the emulator and whether it is installed), `wasm` (the machine's own package through the wasm backend, in a page), `wasmEmulator` (cx16's real x16emu as WebAssembly) and `boot` (the bare machine), each with `available` and, when not, a `reason`. The wasm claim is declared by each machine package (`emulator.wasm`) and held to the truth by a test that builds every one: the PET, VIC-20, X16 and web build through the wasm backend; the C64 does not yet (the wasm backend does not lower an array pinned at a fixed address, `screenRam`). An editor no longer needs a hand-kept list of which machines can preview in a page.

`8bs run`'s usage now documents `--web`, `--x16emu`, `--locale` and `--define`.
