# @8bitscript/graphics

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
