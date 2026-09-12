---
"8bitscript-lang": patch
---

The VS Code extension now recognizes `8bitscript.config.ts` alongside the older `8bs.config.ts`, catching up with the CLI's rename: the extension activates and the launcher discovers a project under either name (a directory with both is one project, under the new name — the same precedence as the CLI's loader), and the file watcher, examples directory, shipped apps, task resolution, and the Open 8bitscript.config.ts command all follow whichever config the project has.
