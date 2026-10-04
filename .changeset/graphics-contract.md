---
"@8bitscript/graphics": minor
"@8bitscript/compiler": patch
"@8bitscript/examples": patch
"@8bitscript/studio": patch
"@8bitscript/c64": patch
"@8bitscript/cli": patch
---

`@8bitscript/graphics` is now one contract across machines. Every twin — the PET, VIC-20, C64, X16, web and NES ones, and the generic glyph path every other machine uses — answers the same ten constants (`graphics.MAX`, `FRAMES`, `WIDTH`, `HEIGHT`, `COLORS`, `RECOLORS`, `STEP_X`, `STEP_Y`, `RESTORES`, `TRANSPARENT`) with the value that machine honestly has, so a program can fold on what it can do, and exports the same calls: `place`, `update`, and new `hide`, `setFrame`, `animate` and `color`. A call a machine cannot honour is a documented no-op (`color` on the PET, the X16 and the NES, where `RECOLORS` is false); `docs/project/graphics.md` has the per-machine table, and `packages/compiler/test/graphics-contract.test.mjs` builds a probe that reads every constant and calls every operation on all thirty-two targets.

The one behaviour change: `graphics.place` takes **playfield pixels** on every machine, so `place(slot, 0, 0)` lands on text cell (0, 0). The C64 twin now adds the sprite layer's origin (24, 50) itself, so a program no longer writes `sprites.ORIGIN_X +` in front of its positions (the bundled examples, Studio and the C64 probe did; they don't now). A program that already adds the origin by hand on the C64 draws 24 pixels right and 50 down of where it did.

The generic glyph path now plays animations: the default lowering keeps up to four animation steps as one glyph each (it collapsed an animation to its first frame, with `8BS2111`), and `graphics.update()` steps through them at the animation's `every`, as the web twin already did.
