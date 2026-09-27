---
"8bitscript-lang": patch
---

Every PET model's wasm preview now draws its own real character ROM, not just the 2001's. `hello-bx`'s target defaults to `releaseTargets.pet` (model `4032`) — a non-swapped model, which until now fell back to the shared generic bitmap font while only the 2001 got its captured ROM, so its Preview tab still didn't look like a PET.

Text.8bs's own header comment already said why one more capture closes this for every remaining model at once: "every later model's text set (901447-10)" is one ROM image shared by 3008/3016/3032/4016/4032/8032 and their business-keyboard twins alike — not six different ROMs, just one, probed here on 4032 (releaseTargets.pet's own default) the identical way the 2001's was: `viaPeripheralControl` selects the text half, screen codes 0-127 go straight into screen RAM, `8bs run pet --screenshot` against it, decoded pixel by pixel from the PNG. Verified glyph by glyph against `asciiToScreenCode()`'s non-swapped assignment: code 1 draws lower-case `a`, code 65 draws upper-case `A` — the opposite of the 2001's own ROM, exactly as that function documents.

Both PET ROMs are now indexed by the PET's own screen code, so `layoutForRealMachine` never needs a glyph-index translation function for either one — `font: 'pet-2001-screencode'` or `font: 'pet-text-screencode'` is the whole answer. `glyphIndexFn` (the ASCII-translation mechanism this replaces) is gone from `web-layout.mjs` and `web-loader.mjs` entirely: nothing used it any more.
