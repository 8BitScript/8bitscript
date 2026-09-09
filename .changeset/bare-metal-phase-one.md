---
"@8bitscript/atari8": minor
"@8bitscript/c64": minor
"@8bitscript/c128": minor
"@8bitscript/cli": minor
"@8bitscript/compiler": minor
"@8bitscript/cx16": minor
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

Bare Metal: external code-generation toolchains are removed. 8BitScript now carries its own 6502 and WebAssembly backends in `@8bitscript/compiler` (`mos` and `wasm`), which do not yet build any target. The catalog key `build.driver` is renamed `build.startup`. `examples/` is removed.
