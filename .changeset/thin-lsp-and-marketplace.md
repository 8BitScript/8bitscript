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

The editor talks to `8bs lsp` with a thin stdio client instead of
`vscode-languageclient`, so the VSIX is tens of kilobytes. Marketplace
publish no longer uses vsce's 180-second gallery timeout.
