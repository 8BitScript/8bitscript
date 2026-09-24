---
"@8bitscript/cli": minor
"@8bitscript/compiler": minor
"@8bitscript/examples": minor
"@8bitscript/studio": minor
"@8bitscript/pet": minor
"@8bitscript/c64": minor
"@8bitscript/vic20": minor
"@8bitscript/cx16": minor
"@8bitscript/web": minor
"@8bitscript/language-server": minor
"8bitscript-lang": minor
---

Narrow `RELEASE_MACHINES` to five targets — `pet`, `vic20`, `c64`, `cx16`, and `web` — so `8bs build` and `8bs run`, examples, Studio, and the editor launcher focus on a polished slice. Every other id stays in `MACHINES` for twins, facts, and `8bs check`; hello-world still compiles. Restoring the original nine and the remaining roadmap machines to `RELEASE_MACHINES` is planned in a follow-up (see `.changeset/remaining-systems.md` for the wider emulator and package work).
