---
"@8bitscript/graphics": patch
"@8bitscript/vic20": patch
---

Fix VIC-20 programs destroying themselves when they carry a graphics object.

`@8bitscript/graphics`'s VIC-20 implementation wrote its glyphs into a RAM character set at `$1400`. That address is inside the program: a `.prg` loads at `$1001` on the unexpanded machine and `$1201` on an expanded one, so anything big enough to reach `$1400` — hello-world is 1922 bytes, which reaches it either way — had its own code overwritten as the glyphs went down. Measured under xvic, the fourth glyph byte turned a `LDA $1451,Y` into `LDA $7E00,Y`; execution fell through the data that followed into a `BRK`, and the KERNAL warm-started, which is why the greeting vanished and a bare `READY.` came back on a cleared screen.

`packages/vic20/AGENTS.md` had already written down the rule this broke: the linker owns memory from the load address upward and nothing checks for an overlap, so a RAM charset is a reservation the package must make, never a free choice of address.

Two further things were wrong with the same code. Nothing ever pointed the VIC at that character set — `$9005` was only ever set to the ROM font at `$8000` — so the glyphs were written somewhere the video chip does not read; and `writeGlyph` ignored its own `slot`, so all eight objects shared one set of four characters.

An object is now drawn with the ROM's sixteen quadrant-block characters, the way `@8bitscript/pet` draws one: each of its four cells becomes the block that describes that corner of its bitmap, so a 16×16 object renders at 4×4 pseudo-pixels. That costs no RAM, needs no character set and no reservation, and it is the first time the object has actually been visible on this machine. The block codes were measured against the VIC-20's own character ROM rather than inherited from the PET's table.
