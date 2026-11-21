# @8bitscript/graphics-tools

## 0.27.0

### Minor Changes

- 3077a55: The 4bpp sprite packing (legal sizes, the 12-bit palette and the linear frames) the cx16 and web media lowerings share now lives once in `@8bitscript/graphics-tools/sprite-pack`. The cx16 output is byte for byte unchanged.

## 0.23.0

### Minor Changes

- 499c62d: Add a portable graphics and audio slice: `.8bg` / `.8ba` front ends, PNG and WAV/FLAC host tools, machine-owned lowering on C64, NES, PET, and Atari 8-bit with a glyph/no-driver fallback everywhere else, and a dogfood example that builds for every machine.
