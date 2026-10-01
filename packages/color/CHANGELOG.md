# @8bitscript/color

## 0.24.0

### Minor Changes

- daac931: A new portable package, `@8bitscript/color`, for the C64 demoscene's "more than 16 colours" trick: `color.blend(slot, a, b)` alternates a border or background color between two palette indices once a frame, riding on `@8bitscript/raster`'s own list, so a CRT's phosphor persistence blends them into a shade neither shows alone. Real on the C64; an honest, documented no-op on the PET (no color chip), the VIC-20 (the technique is unconfirmed on real hardware, not disproven — left unimplemented rather than assumed), the CX16 (VERA's 256-entry software palette makes the trick unnecessary — define the color directly instead), and the web (no CRT persistence to exploit, so alternating a color there would be visible flicker, not a blend). Gated by a new build-time fact, `#fact(video.colorBlend)`, filled in across every machine catalog (true only for the C64).

### Patch Changes

- Updated dependencies [e80d067]
- Updated dependencies [daac931]
- Updated dependencies [0b694ac]
- Updated dependencies [0ff97c3]
- Updated dependencies [3824070]
- Updated dependencies [e80d067]
- Updated dependencies [4376f27]
- Updated dependencies [8a309f5]
- Updated dependencies [5a21549]
- Updated dependencies [e80d067]
- Updated dependencies [a988417]
  - @8bitscript/c64@0.24.0
  - @8bitscript/pet@0.24.0
  - @8bitscript/vic20@0.24.0
  - @8bitscript/cx16@0.24.0
  - @8bitscript/web@0.24.0
