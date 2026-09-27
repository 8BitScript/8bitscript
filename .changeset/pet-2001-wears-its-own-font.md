---
"8bitscript-lang": patch
---

The PET's wasm preview draws the 2001's own character ROM now, not the shared bitmap font every other machine's `--web` build uses.

The font itself is not a reimplementation: it's a pixel-for-pixel capture of real VICE actually rendering the 2001's ROM. A probe program pokes `viaPeripheralControl` to select the text (both-case) half of the character generator, then writes screen codes 0-127 straight into screen RAM; `8bs run pet --screenshot` against it, decoded cell by cell from the resulting PNG (`packages/cli/src/png.mjs`'s own `pixelAt()`, already used for screenshot tests). Sidesteps ever touching Commodore's ROM binary while still matching the real hardware exactly — there's no "close enough" here, just what the reference emulator already draws. Verified end to end: `hello-world`'s built loader now embeds this table and correctly shows the PET's own shapes for `H`, `A`, and lower-case `e` (which only exist in the ROM's text-mode half — the graphics-mode half the machine boots into shows box-drawing shapes at those same codes instead, a real distinction the probe had to account for).

The table is indexed by the PET's own screen code, not ASCII, so a 2001 build (`video.characterSetSwapped`) needs no translation function at all — `layoutForRealMachine` just names the table (`font: 'pet-2001-screencode'`) and the loader looks it up directly. Every later model (3032/4032/8032/…) has a genuinely different ROM image with no capture yet, so those keep going through the ASCII-translating `glyphIndexFn` exactly as every PET model did before this table existed — a real, stated gap, not a silently wrong 2001 shape wearing a different model's name.

The mechanism (`font8x8.mjs`'s `NAMED_FONTS`, selected by a `font` id on the layout) is built to add another machine's own captured ROM, or a different charset variant of the same machine, the same way: its own probe program, its own screenshot, its own named table — nothing about it is PET-specific past this one entry.
