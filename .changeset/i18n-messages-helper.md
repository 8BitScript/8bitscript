---
"@8bitscript/i18n": minor
"@8bitscript/compiler": minor
"@8bitscript/cli": minor
"@8bitscript/language-server": patch
"@8bitscript/input": patch
"@8bitscript/pet": patch
"@8bitscript/vic20": patch
"@8bitscript/c64": patch
"@8bitscript/c128": patch
"@8bitscript/atari8": patch
"@8bitscript/nes": patch
"@8bitscript/cx16": patch
"@8bitscript/mega65": patch
"@8bitscript/web": patch
---

Add project message catalogs (`src/i18n/<locale>.8bs`, imported as `@8bitscript/i18n/catalog`), compile-time `i18n.format`, Latin transliteration into the portable set, and `Input.CONFIRM_LABEL` on each machine's input layer. One locale still means one binary; projects without catalogs are unchanged.
