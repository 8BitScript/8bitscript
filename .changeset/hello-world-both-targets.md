---
"@8bitscript/atari8": minor
"@8bitscript/c64": minor
"@8bitscript/c128": minor
"@8bitscript/cli": minor
"@8bitscript/compiler": minor
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

The `mos` and `wasm` backends in `@8bitscript/compiler` now emit for
real. `8bs build` and `8bs run` work end to end for both 0.2.0 targets:
`packages/examples/hello-world`, unmodified, builds, runs, and renders
its own mixed-case "Hello World!" correctly on a real Commodore PET
(checked against the `xpet` emulator) and in a real browser (checked
against a real `--screenshot` run and the browser runtime's own
generated page script). The `wasm` backend gained `&`, `|`, `^`, `<<`,
and unsigned `>>` as real lowered operators (wasm's native
`i32.and`/`i32.or`/`i32.xor`/`i32.shl`/`i32.shr_u`), needed once
`@8bitscript/web/screen`'s own color masking (`value & 15`) became the
first real caller. The web target's own text rendering (both the real
browser canvas and the `--screenshot` bitmap font) now covers lower
case too, matching what the checker's portable character set and the
PET's own `asciiToScreenCode` have allowed all along — it previously
covered upper case only, silently drawing every lower-case letter as a
blank cell.
