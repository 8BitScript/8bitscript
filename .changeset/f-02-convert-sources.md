---
"@8bitscript/apple2": patch
"@8bitscript/atari2600": patch
"@8bitscript/atari5200": patch
"@8bitscript/atari7800": patch
"@8bitscript/atari8": patch
"@8bitscript/audio": patch
"@8bitscript/bbc": patch
"@8bitscript/c128": patch
"@8bitscript/c64": patch
"@8bitscript/channelf": patch
"@8bitscript/cli": patch
"@8bitscript/coco": patch
"@8bitscript/coleco": patch
"@8bitscript/compiler": patch
"@8bitscript/cpc": patch
"@8bitscript/cx16": patch
"@8bitscript/examples": patch
"@8bitscript/gamegear": patch
"@8bitscript/gb": patch
"@8bitscript/gbc": patch
"@8bitscript/graphics": patch
"@8bitscript/i18n": patch
"@8bitscript/lynx": patch
"@8bitscript/mega65": patch
"@8bitscript/msx": patch
"@8bitscript/nes": patch
"@8bitscript/odyssey2": patch
"@8bitscript/oric": patch
"@8bitscript/pce": patch
"@8bitscript/pet": patch
"@8bitscript/plus4": patch
"@8bitscript/random": patch
"@8bitscript/sg1000": patch
"@8bitscript/sms": patch
"@8bitscript/spectrum": patch
"@8bitscript/sprites": patch
"@8bitscript/studio": patch
"@8bitscript/supervision": patch
"@8bitscript/system": patch
"@8bitscript/timeline": patch
"@8bitscript/ui": patch
"@8bitscript/vectrex": patch
"@8bitscript/vic20": patch
"@8bitscript/web": patch
---

Every .8bs and .8bx source in the packages is converted to the new Rust-style syntax by `8bs migrate`, and each `8bitscript.config.8bs` is renamed to `8bitscript.config.ts`. The c64 character ROM generator now writes the new const array form.
