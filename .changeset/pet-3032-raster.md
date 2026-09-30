---
"@8bitscript/pet": minor
"@8bitscript/compiler": minor
"@8bitscript/examples": patch
---

The PET's `3032` model tag (`--hardware model=3032`) now answers `#fact(video.raster)`: `@8bitscript/raster`'s `Slot.CHARSET` splits the picture between the character ROM's graphics and text halves at a chosen picture line, verified under VICE at true cycle-scanline accuracy and stable frame to frame. The PET has no raster interrupt and no readable scanline counter, so every entry is cycle-counted from the single vertical-retrace edge `waitFrame()` already waits on, applied by a new frame hook (`FRAME_SYNC.pet.frameHook`, `EdgeSyncCalibrated` gains the field the level-kind machines already had) that `commit()` precomputes a division-free delay plan for — the 6502 backend has no hardware divide, so the cycle-to-loop-count decomposition is repeated subtraction, computed once, never in the per-frame hook. Every other PET model, including the default (2001) and the release target (4032), still answers false; extending this to the CRTC boards (4032, 8032) is follow-on work with its own timing to measure. See `packages/pet/AGENTS.md`, "Raster: character-set switching," for the mechanism and the numbers.

`examples/fancy` — the raster *colour* showpiece — now distinguishes "no raster" from "raster, but not the colour kind this demo draws with": a machine that answers `video.raster` without answering `raster.COLORS` (the PET) shows a third caption rather than silently linking dead `BORDER`/`BACKGROUND` calls that always return false.
