---
"@8bitscript/cli": minor
"@8bitscript/compiler": minor
---

`baseline` in 8bitscript.config.ts: the system a program is designed on — the build every fact the program tests is true on, where `requires` is the floor every build clears (docs/project/baseline.md, docs/config.md). A machine's name (`'c64'`, under the project's own hardware for it), a name from `systems`, or a system's shape. `8bs build` and `8bs run` with no target build it; `8bs targets` names it ("This program is designed on"), and `--json` carries it with its resolved sheet; `8bs build --release` prints, after every artifact, how it stands to the baseline — `the baseline`, `level with the baseline (c64)`, or `short of the baseline (c64): video.palette 2 of 16, video.raster, memory.ram 3071 of 51199`. Only the facts the program's own files test are counted: the linker records every `#fact(key)` a project file spells and every `Video.*`/`Memory.*`/… const it reads from `@8bitscript/system` (`factsTested` on `link()`'s result; a package's own fact reads are the package's business), and `shortOfBaseline(baseline, facts)` in the compiler is the comparison. A baseline below the program's `requires` is refused as a config mistake. The builds that are not the baseline are called builds — the note says why not ports, tiers or editions.

Also: `8bs build --release --checkout <dir>` honours the checkout. It returned into the release before the flag was read, so every artifact came from node_modules and nothing said so.
