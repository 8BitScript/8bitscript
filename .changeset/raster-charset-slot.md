---
"@8bitscript/raster": minor
"@8bitscript/pet": patch
---

`@8bitscript/raster` names a fourth per-line intent, `Slot.CHARSET` (a machine's alternate character set), alongside two new compile-time constants every rasterline layer answers: `raster.COLORS` (whether `Slot.BORDER`/`Slot.BACKGROUND` do anything — true on the C64, VIC-20 and web, false elsewhere including the PET, which has no border or background register) and `raster.CHARSET` (whether the new slot does — false everywhere for now). No machine implements `Slot.CHARSET` yet; every rasterline layer answers it as an honest, zero-cost `false`, the same pattern `raster.FINE_SCROLL` already established.

This clears the way for a real PET implementation: `packages/pet/AGENTS.md` records verified research (under VICE, both the non-CRTC 3032 and the release-target 4032) showing the PET's character-ROM-select register splits the picture mid-frame at true cycle-scanline precision, with the line lengths and picture-start offsets measured for both boards — but the driver itself isn't built yet (it needs a division-free way to turn a cycle count into a delay loop, since the 6502 backend has no hardware divide). See that file's new "Raster: character-set switching" section for the numbers and the next steps.
