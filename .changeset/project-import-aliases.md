---
"@8bitscript/compiler": minor
"@8bitscript/cli": minor
"@8bitscript/language-server": patch
---

Add project `imports` in `8bitscript.config.ts` so specifiers like `@lib/game/rules.8bs` map to directories under the project. Wired through `8bs build`, `8bs check`, and the language server.
