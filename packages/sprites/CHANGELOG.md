# @8bitscript/sprites

## 0.23.2

### Patch Changes

- @8bitscript/screen@0.23.2
  - @8bitscript/text@0.23.2
  - @8bitscript/c64@0.23.2
  - @8bitscript/system@0.23.2

## 0.23.1

### Patch Changes

- @8bitscript/c64@0.23.1
  - @8bitscript/screen@0.23.1
  - @8bitscript/system@0.23.1
  - @8bitscript/text@0.23.1

## 0.23.0

### Patch Changes

- Updated dependencies [499c62d]
- Updated dependencies [499c62d]
- Updated dependencies [499c62d]
  - @8bitscript/c64@0.23.0
  - @8bitscript/system@0.23.0
  - @8bitscript/screen@0.23.0
  - @8bitscript/text@0.23.0

## 0.22.1

### Patch Changes

- @8bitscript/c64@0.22.1
  - @8bitscript/screen@0.22.1
  - @8bitscript/system@0.22.1
  - @8bitscript/text@0.22.1

## 0.22.0

### Patch Changes

- @8bitscript/screen@0.22.0
  - @8bitscript/text@0.22.0
  - @8bitscript/c64@0.22.0
  - @8bitscript/system@0.22.0

## 0.21.0

### Patch Changes

- @8bitscript/screen@0.21.0
  - @8bitscript/text@0.21.0
  - @8bitscript/c64@0.21.0
  - @8bitscript/system@0.21.0

## 0.20.0

### Patch Changes

- @8bitscript/screen@0.20.0
  - @8bitscript/text@0.20.0
  - @8bitscript/c64@0.20.0
  - @8bitscript/system@0.20.0

## 0.19.1

### Patch Changes

- 0a6a4ab: `@8bitscript/sprites` and `@8bitscript/timeline` join the fixed version group in `.changeset/config.json`, so every package moves to the same version together. Both were new in 0.18.0 and were left out of the group; the 0.18.0 changeset happened to name them, so they matched, and the next version bump that did not — 0.19.0 — left them at 0.18.1 and 0.18.0, which `scripts/release.mjs` refused before publishing anything ("sprites is 0.18.1, expected 0.19.0"). 0.19.0 was never published; this release is the first with the baseline.
- @8bitscript/c64@0.19.1
  - @8bitscript/screen@0.19.1
  - @8bitscript/system@0.19.1
  - @8bitscript/text@0.19.1

## 0.18.1

### Patch Changes

- @8bitscript/c64@0.19.0
  - @8bitscript/screen@0.19.0
  - @8bitscript/system@0.19.0
  - @8bitscript/text@0.19.0

## 0.18.0

### Minor Changes

- 63b1906: The frame, across nine machines (docs/project/frame.md): `@8bitscript/sprites` — moving objects on every target, hardware sprites reused down the frame on the C64 (up to twenty-four, and through the opened border with `extend(true)`), quadrant-block objects on the PET (eight, at 4-pixel steps, merging with block graphics and restoring what they cover from the screen — `defineShape` in the PET twin), a glyph per sprite on the character grid elsewhere; positions are sixteen bits both ways, and the consts a program folds on are `MAX`, `PER_LINE`, `WIDTH`, `HEIGHT`, `STEP_X`, `STEP_Y`, `RESTORES`, `EXTENDS` (docs/project/sprites.md); `@8bitscript/timeline` — frame-counted cues, pure; `@8bitscript/raster` grows `commit()`, `insert()` and `STRIDE` on all nine twins. `examples/swarm` shows them as one program with a `.8bx` scene. The C64's raster handler now writes the frame table at line 0 rather than 255 (a sprite reused into the opened lower border drew its last rows with the next frame's X); `@8bitscript/c64/raster` gains `setFrameSprite`, `setFrameHeader`, `spriteEntries`, `lastEntryLine` and `shareBuild`/`takeBuild`; and `@8bitscript/c64/multiplex`'s `update()` is native assembly (`native/6502/multiplex.s`, its tables in page $06) — ~9,500 cycles a frame for sixteen sprites where the compiled body was ~16,000, so the swarm runs at one hardware frame an iteration on the C64.

### Patch Changes

- Updated dependencies [aa3fd8e]
- Updated dependencies [63b1906]
- Updated dependencies [63b1906]
  - @8bitscript/c64@0.18.0
  - @8bitscript/screen@0.18.0
  - @8bitscript/text@0.18.0
  - @8bitscript/system@0.18.0
