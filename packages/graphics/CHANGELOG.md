# @8bitscript/graphics

## 0.23.2

### Patch Changes

- 5a21549: Fix VIC-20 programs destroying themselves when they carry a graphics object.
  
  `@8bitscript/graphics`'s VIC-20 implementation wrote its glyphs into a RAM character set at `$1400`. That address is inside the program: a `.prg` loads at `$1001` on the unexpanded machine and `$1201` on an expanded one, so anything big enough to reach `$1400` — hello-world is 1922 bytes, which reaches it either way — had its own code overwritten as the glyphs went down. Measured under xvic, the fourth glyph byte turned a `LDA $1451,Y` into `LDA $7E00,Y`; execution fell through the data that followed into a `BRK`, and the KERNAL warm-started, which is why the greeting vanished and a bare `READY.` came back on a cleared screen.
  
  `packages/vic20/AGENTS.md` had already written down the rule this broke: the linker owns memory from the load address upward and nothing checks for an overlap, so a RAM charset is a reservation the package must make, never a free choice of address.
  
  Two further things were wrong with the same code. Nothing ever pointed the VIC at that character set — `$9005` was only ever set to the ROM font at `$8000` — so the glyphs were written somewhere the video chip does not read; and `writeGlyph` ignored its own `slot`, so all eight objects shared one set of four characters.
  
  An object is now drawn with the ROM's sixteen quadrant-block characters, the way `@8bitscript/pet` draws one: each of its four cells becomes the block that describes that corner of its bitmap, so a 16×16 object renders at 4×4 pseudo-pixels. That costs no RAM, needs no character set and no reservation, and it is the first time the object has actually been visible on this machine. The block codes were measured against the VIC-20's own character ROM rather than inherited from the PET's table.
- Updated dependencies [4376f27]
- Updated dependencies [5a21549]
  - @8bitscript/pet@0.23.2
  - @8bitscript/vic20@0.23.2
  - @8bitscript/sprites@0.23.2
  - @8bitscript/c64@0.23.2
  - @8bitscript/cx16@0.23.2
  - @8bitscript/nes@0.23.2
  - @8bitscript/system@0.23.2

## 0.23.1

### Patch Changes

- @8bitscript/c64@0.23.1
  - @8bitscript/cx16@0.23.1
  - @8bitscript/nes@0.23.1
  - @8bitscript/pet@0.23.1
  - @8bitscript/sprites@0.23.1
  - @8bitscript/system@0.23.1
  - @8bitscript/vic20@0.23.1

## 0.23.0

### Minor Changes

- 499c62d: Add a portable graphics and audio slice: `.8bg` / `.8ba` front ends, PNG and WAV/FLAC host tools, machine-owned lowering on C64, NES, PET, and Atari 8-bit with a glyph/no-driver fallback everywhere else, and a dogfood example that builds for every machine.

### Patch Changes

- 7232d3f: Widen VIC-20 zero-page to the owned budget when a linked program calls `screen.blank()`, so title screens and media clears link without overrunning the polite KERNAL window.
- Updated dependencies [499c62d]
- Updated dependencies [499c62d]
- Updated dependencies [499c62d]
  - @8bitscript/pet@0.23.0
  - @8bitscript/c64@0.23.0
  - @8bitscript/vic20@0.23.0
  - @8bitscript/cx16@0.23.0
  - @8bitscript/nes@0.23.0
  - @8bitscript/system@0.23.0
  - @8bitscript/sprites@0.23.0
