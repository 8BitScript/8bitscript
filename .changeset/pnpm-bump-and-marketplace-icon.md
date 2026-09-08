---
"@8bitscript/atari8": patch
"@8bitscript/backend-6502": patch
"@8bitscript/backend-web": patch
"@8bitscript/c64": patch
"@8bitscript/c128": patch
"@8bitscript/cli": patch
"@8bitscript/compiler": patch
"@8bitscript/cx16": patch
"@8bitscript/input": patch
"@8bitscript/language-server": patch
"@8bitscript/mega65": patch
"@8bitscript/nes": patch
"@8bitscript/pet": patch
"@8bitscript/pointer": patch
"@8bitscript/random": patch
"@8bitscript/screen": patch
"@8bitscript/studio": patch
"@8bitscript/system": patch
"@8bitscript/text": patch
"@8bitscript/ui": patch
"@8bitscript/vic20": patch
"@8bitscript/web": patch
"8bitscript-lang": patch
---

Pin the workspace's `packageManager` to pnpm 12.3.4 (up from 12.1.0) and
recommend the `8bitscript.8bitscript-lang` VS Code extension in this
repo's `.vscode/extensions.json`. The VS Code extension also gains a
Marketplace icon (the pixel-8 mark, on the same purple/cream palette as
`docs/assets/favicon.svg`) instead of falling back to the generic default.
