---
"@8bitscript/cli": minor
"8bitscript-lang": minor
---

A real machine's `--web` build is named for the machine, not the specific model it happened to compile for — `hello-world.pet.wasm`, never `hello-world-3032.wasm` — and `8bs build --target <machine> --web` now works standalone, not just through `8bs run`. In the extension, the plain Run command defaults to opening a machine's own `--web` build in the Preview tab, for a target that already has one.

The old naming borrowed the native build's own convention (a dash-joined hardware tag, `main-4032.wasm`), which answers a question a browser preview does not have: which specific real-hardware variant was this compiled for. That variant still decides what actually got built (RAM budget, column count — `--hardware`/`--profile` choose it exactly as before), it just isn't the file's own name. `8bs build --target pet --web` reached `compile()` with no `web` option at all until now — the CLI's own argument parser never read the flag, only `8bs run`'s did.

The extension's plain Run command used to always open a native emulator window. It now prefers a `--web` build instead, for a target that has one — the PET, today — governed by a new `8bitscript.preferWebPreview` setting (on by default) and a small allowlist in `runner.cjs` naming which targets that already holds for (`WEB_PREVIEW_READY`). VIC-20 and C64 are deliberately excluded: they still hit their own `asm6502` walls building through the wasm backend, so defaulting Run to `--web` for them would turn a working native launch into a guaranteed failure, not a preference between two things that already work — they keep launching their native emulator until their own package compiles through the wasm backend for real. Studio's own tab and Preview On… are unaffected; both already chose `--web` explicitly.
