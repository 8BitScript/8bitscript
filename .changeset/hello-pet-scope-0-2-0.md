---
"@8bitscript/atari8": minor
"@8bitscript/compiler": minor
"@8bitscript/c64": minor
"@8bitscript/c128": minor
"@8bitscript/cli": minor
"@8bitscript/cx16": minor
"@8bitscript/examples": minor
"@8bitscript/input": minor
"@8bitscript/language-server": minor
"@8bitscript/mega65": minor
"@8bitscript/nes": minor
"@8bitscript/pet": minor
"@8bitscript/pointer": minor
"@8bitscript/random": minor
"@8bitscript/screen": minor
"@8bitscript/studio": minor
"@8bitscript/system": minor
"@8bitscript/text": minor
"@8bitscript/ui": minor
"@8bitscript/vic20": minor
"@8bitscript/web": minor
"8bitscript-lang": minor
---

0.2.0 is scoped to the Commodore PET and the web. `8bs build` and `8bs
run` now refuse the other seven machines (vic20, c64, c128, atari8,
nes, cx16, mega65) by name; their packages are unchanged and stay in
the workspace, parked until their native backends land after 0.2.0.

`@8bitscript/examples` is new: `hello-raw` and `hello`, the two
programs the PET backend is built against, shipped with the CLI the
way Studio is. The VS Code extension lists them by default and reads
them from the package's own manifest rather than a fixed directory;
it also now recognizes bun's lockfile alongside pnpm, npm, and yarn.
