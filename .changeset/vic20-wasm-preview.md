---
"8bitscript-lang": minor
---

The VIC-20's own wasm preview works now — `hello-world` and `hello-bx` both render "Hello World!" correctly instead of a blank screen, the same blank-screen bug PET's own preview had before `layoutForRealMachine` existed.

Two separate walls, both closed:

**The asm6502 wall.** `text.releaseCursor()`'s KERNAL PLOT call (`asm6502 { jsr $FFF0 }`) has nothing to lower to on a backend with no 6502 behind it, and the wasm backend correctly refused it outright. Split into its own module (`cursor.8bs`) so only it, not all of `text.8bs`, needs a `.web` twin — `cursor.vic20.web.8bs` is a true no-op, not a workaround for one that failed: a wasm build never returns to a BASIC prompt, so `releaseCursor()`'s entire purpose (positioning the KERNAL editor's cursor for BASIC's *next* PRINT) has no "next PRINT" to matter to on this target, ever. Picking that twin up needed a small addition to `build.mjs`: a real machine's own `--web` build now adds `web` as an extra tag *only* for the linker's twin resolution — never into `hardware.tags`/`buildValues`, so the artifact's name and label are unaffected — the same twin mechanism a hardware tag like `keys.pet.business.8bs` already uses, reused here for a backend distinction instead of a hardware one.

**The blank-screen wall.** `layoutForRealMachine` had no `vic20` entry at all, so its wasm preview painted from the synthetic offset `agreementFor()` computes from grid size — the exact bug PET's own preview had before that function existed. VIC-20 needed more than a fixed address, too: its screen genuinely moves with its own RAM (unexpanded keeps the KERNAL's stock $1E00/$9600; 8K and up relocates to $1000/$9400, so BASIC RAM stays one contiguous run above it), read here from the same `expanded` tag `packages/vic20/src/geometry.8bs`'s own twin already resolves on. Unlike the PET, the VIC-20 has real per-cell color RAM, not a "one past the screen" fiction — `colorPerCell: true`, its own real address, not a formula.

No captured character ROM yet — the VIC-20's own wasm preview draws the shared generic font for now, the same honest, stated gap a later PET model without its own captured ROM has. `chargen-901460-03.bin`'s mixed-case block is a genuinely different chip from either PET ROM already captured; a future session's own probe-and-capture, the same recipe already used twice, is how it gets its own authentic font.
