---
"@8bitscript/cli": patch
"8bitscript-lang": patch
---

The PET Preview tab was blank, and said "Building Studio" while doing it. Both were the same category of mistake: code written for one machine, reused unchanged for another.

The blank screen: `layoutFromHardware()` computes where a program's screen data lives from grid size alone (`charBase = 2`-ish), because the *synthetic* web target's own `.8bs` source was written to match that math. `packages/pet/src/text.8bs` — the real, native-build file the previous change got compiling through the wasm backend — was written against the PET's actual hardware instead, and writes its screen at `$8000`. The host was painting from byte 2; the program's text sat 32KB further on. A new `layoutForRealMachine(target, hardware)` gives a real machine's own wasm build its real screen address, its real palette (PET's green phosphor, already sitting unused in `web-layout.mjs`), and — since PET's own screen codes are not the same numbers the shared bitmap font indexes by — a small inverse of `text.8bs`'s own `asciiToScreenCode()`, evaluated host-side. Verified against the actual served bundle: `program.json`'s `charBase` is now `32768`, and decoding memory through the new `glyphIndexFn` reads "Hello World! " byte for byte.

The wrong "Studio": the Preview tab reuses Studio's own webview page and script (`studio.js`) — reasonably, since the mechanism really is generic — but that script's status line, its Rebuild/Start button, and its empty-state text all said "Studio" unconditionally. `window.__8bsTitle`, set alongside the mouse-visibility flag from the same per-target `TARGET_LABELS`, gives every one of those strings the machine's own name instead; Studio's own tab passes nothing and reads exactly as it always has.

vic20 and c64 have no real-machine layout entry yet — they get `layoutFromHardware`'s old geometry-only fallback, same as before this fix, not a newly-wrong PET-shaped guess. They're still separately blocked on their own `asm6502` walls.
