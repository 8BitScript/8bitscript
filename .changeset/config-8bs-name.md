---
"@8bitscript/cli": minor
"@8bitscript/language-server": minor
"@8bitscript/compiler": patch
"@8bitscript/examples": patch
"@8bitscript/web": patch
"8bitscript-lang": minor
---

`8bitscript.config.8bs` is the current name for a project's config file; `8bitscript.config.ts` (0.4.0 through 0.22.x) and `8bs.config.ts` (every project through 0.3.0) still load, in that order of preference, for a few more releases. The CLI, the language server, and the VS Code extension all find any of the three; every user-facing message, doc, and the file icon theme now name the current one, with the two older names kept wherever a message or the icon theme still needs to recognize them. The examples, Studio, and this repository's own config files use the new name; the sibling `2048` repository's was renamed the same way.
