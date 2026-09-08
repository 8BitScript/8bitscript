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

The VS Code extension resolves the `@8bitscript/cli` version behind a
project's toolchain — following a registry install, a `link:`, or a
monorepo checkout the same way it already finds the CLI package itself —
and surfaces it: in the Project dropdown's tooltip, and logged before
`8BitScript: Doctor` runs. Different projects, and different checkouts of
this repo worked on at once, can be on different toolchain versions; the
extension now shows which one it found instead of staying silent about it.
