# @8bitscript/raster

## 0.19.1

### Patch Changes

- @8bitscript/atari8@0.19.1
  - @8bitscript/c128@0.19.1
  - @8bitscript/c64@0.19.1
  - @8bitscript/cx16@0.19.1
  - @8bitscript/mega65@0.19.1
  - @8bitscript/nes@0.19.1
  - @8bitscript/pet@0.19.1
  - @8bitscript/vic20@0.19.1
  - @8bitscript/web@0.19.1

## 0.19.0

### Patch Changes

- @8bitscript/atari8@0.19.0
  - @8bitscript/c128@0.19.0
  - @8bitscript/c64@0.19.0
  - @8bitscript/cx16@0.19.0
  - @8bitscript/mega65@0.19.0
  - @8bitscript/nes@0.19.0
  - @8bitscript/pet@0.19.0
  - @8bitscript/vic20@0.19.0
  - @8bitscript/web@0.19.0

## 0.18.0

### Minor Changes

- 63b1906: The frame, across nine machines (docs/project/frame.md): `@8bitscript/sprites` — moving objects on every target, hardware sprites reused down the frame on the C64 (up to twenty-four, and through the opened border with `extend(true)`), quadrant-block objects on the PET (eight, at 4-pixel steps, merging with block graphics and restoring what they cover from the screen — `defineShape` in the PET twin), a glyph per sprite on the character grid elsewhere; positions are sixteen bits both ways, and the consts a program folds on are `MAX`, `PER_LINE`, `WIDTH`, `HEIGHT`, `STEP_X`, `STEP_Y`, `RESTORES`, `EXTENDS` (docs/project/sprites.md); `@8bitscript/timeline` — frame-counted cues, pure; `@8bitscript/raster` grows `commit()`, `insert()` and `STRIDE` on all nine twins. `examples/swarm` shows them as one program with a `.8bx` scene. The C64's raster handler now writes the frame table at line 0 rather than 255 (a sprite reused into the opened lower border drew its last rows with the next frame's X); `@8bitscript/c64/raster` gains `setFrameSprite`, `setFrameHeader`, `spriteEntries`, `lastEntryLine` and `shareBuild`/`takeBuild`; and `@8bitscript/c64/multiplex`'s `update()` is native assembly (`native/6502/multiplex.s`, its tables in page $06) — ~9,500 cycles a frame for sixteen sprites where the compiled body was ~16,000, so the swarm runs at one hardware frame an iteration on the C64.

### Patch Changes

- Updated dependencies [aa3fd8e]
- Updated dependencies [63b1906]
- Updated dependencies [63b1906]
  - @8bitscript/c64@0.18.0
  - @8bitscript/vic20@0.18.0
  - @8bitscript/pet@0.18.0
  - @8bitscript/c128@0.18.0
  - @8bitscript/atari8@0.18.0
  - @8bitscript/nes@0.18.0
  - @8bitscript/cx16@0.18.0
  - @8bitscript/mega65@0.18.0
  - @8bitscript/web@0.18.0

## 0.17.0

### Patch Changes

- @8bitscript/atari8@0.17.0
  - @8bitscript/c128@0.17.0
  - @8bitscript/c64@0.17.0
  - @8bitscript/cx16@0.17.0
  - @8bitscript/mega65@0.17.0
  - @8bitscript/nes@0.17.0
  - @8bitscript/pet@0.17.0
  - @8bitscript/vic20@0.17.0
  - @8bitscript/web@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [592197a]
- Updated dependencies [46e9791]
  - @8bitscript/atari8@0.16.0
  - @8bitscript/mega65@0.16.0
  - @8bitscript/c128@0.16.0
  - @8bitscript/c64@0.16.0
  - @8bitscript/cx16@0.16.0
  - @8bitscript/nes@0.16.0
  - @8bitscript/pet@0.16.0
  - @8bitscript/vic20@0.16.0
  - @8bitscript/web@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [758765d]
  - @8bitscript/pet@0.15.0
  - @8bitscript/vic20@0.15.0
  - @8bitscript/c64@0.15.0
  - @8bitscript/c128@0.15.0
  - @8bitscript/atari8@0.15.0
  - @8bitscript/nes@0.15.0
  - @8bitscript/cx16@0.15.0
  - @8bitscript/mega65@0.15.0
  - @8bitscript/web@0.15.0

## 0.14.0

### Patch Changes

- @8bitscript/atari8@0.14.0
  - @8bitscript/c128@0.14.0
  - @8bitscript/c64@0.14.0
  - @8bitscript/cx16@0.14.0
  - @8bitscript/mega65@0.14.0
  - @8bitscript/nes@0.14.0
  - @8bitscript/pet@0.14.0
  - @8bitscript/vic20@0.14.0
  - @8bitscript/web@0.14.0

## 0.13.1

### Patch Changes

- @8bitscript/atari8@0.13.1
  - @8bitscript/c128@0.13.1
  - @8bitscript/c64@0.13.1
  - @8bitscript/cx16@0.13.1
  - @8bitscript/mega65@0.13.1
  - @8bitscript/nes@0.13.1
  - @8bitscript/pet@0.13.1
  - @8bitscript/vic20@0.13.1
  - @8bitscript/web@0.13.1

## 0.13.0

### Patch Changes

- @8bitscript/atari8@0.13.0
  - @8bitscript/c128@0.13.0
  - @8bitscript/c64@0.13.0
  - @8bitscript/cx16@0.13.0
  - @8bitscript/mega65@0.13.0
  - @8bitscript/nes@0.13.0
  - @8bitscript/pet@0.13.0
  - @8bitscript/vic20@0.13.0
  - @8bitscript/web@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [922ec1f]
  - @8bitscript/web@0.12.0
  - @8bitscript/atari8@0.12.0
  - @8bitscript/c128@0.12.0
  - @8bitscript/c64@0.12.0
  - @8bitscript/cx16@0.12.0
  - @8bitscript/mega65@0.12.0
  - @8bitscript/nes@0.12.0
  - @8bitscript/pet@0.12.0
  - @8bitscript/vic20@0.12.0

## 0.11.0

### Patch Changes

- @8bitscript/atari8@0.11.0
  - @8bitscript/c128@0.11.0
  - @8bitscript/c64@0.11.0
  - @8bitscript/cx16@0.11.0
  - @8bitscript/mega65@0.11.0
  - @8bitscript/nes@0.11.0
  - @8bitscript/pet@0.11.0
  - @8bitscript/vic20@0.11.0
  - @8bitscript/web@0.11.0

## 0.10.2

### Patch Changes

- Updated dependencies [2288987]
  - @8bitscript/pet@0.10.2
  - @8bitscript/vic20@0.10.2
  - @8bitscript/c64@0.10.2
  - @8bitscript/c128@0.10.2
  - @8bitscript/cx16@0.10.2
  - @8bitscript/mega65@0.10.2
  - @8bitscript/atari8@0.10.2
  - @8bitscript/nes@0.10.2
  - @8bitscript/web@0.10.2

## 0.10.1

### Patch Changes

- ce9054a: Fix `@8bitscript/raster`'s published dependencies: `0.10.0` shipped with
  its `dependencies` still reading the literal `workspace:*` protocol
  string instead of a resolved version, because its first-ever publish
  went through the manual bootstrap in `.github/AGENTS.md` ("A brand-new
  package's first publish") using plain `npm publish` — which doesn't
  understand pnpm's workspace protocol and doesn't rewrite it. Any
  consumer outside this workspace hard-failed resolving
  `@8bitscript/atari8@workspace:*` and the rest.
  
  `0.10.1` republishes with real versions. `release.mjs` now refuses to
  publish any package whose dependencies still carry a `workspace:`
  specifier, and the AGENTS.md recovery doc now says `pnpm publish`, not
  `npm publish`, for exactly this reason.
- @8bitscript/atari8@0.10.1
  - @8bitscript/c128@0.10.1
  - @8bitscript/c64@0.10.1
  - @8bitscript/cx16@0.10.1
  - @8bitscript/mega65@0.10.1
  - @8bitscript/nes@0.10.1
  - @8bitscript/pet@0.10.1
  - @8bitscript/vic20@0.10.1
  - @8bitscript/web@0.10.1

## 0.10.0

### Minor Changes

- 19b943d: New package: `@8bitscript/raster` — per-scanline raster effects as a
  portable surface, named by what the picture does at a line rather than by
  which register to write.
  
  A program builds a list once with `raster.at(line, slot, value)` — a
  border split, a background band, a horizontal wobble via `Slot.SCROLL_X` —
  rewrites only an entry's value bytes per frame with
  `raster.setValue(offset, value)`, and turns the whole list on and off with
  `raster.enable()` / `raster.disable()`. Two machines have a real
  implementation: the C64 (a raster interrupt driving the write list) and
  the web (the renderer applies the list at paint time). The other seven
  answer `#fact(video.raster)` with false and get an honest no-op behind the
  same surface, so a guarded effect folds away to nothing instead of
  shipping inert bytes.
  
  `packages/examples/fancy` is the showpiece: a title wobbling on a sine
  wave inside a pair of colour bands, with the fold measured exact on the
  machines that can't answer.
  
  Not in this release: no `raster.apply()`, no `8BS3005` deadline
  diagnostic, no per-frame web capture, and no new skins.
  
  ---
  
  Note for whoever runs the release: `@8bitscript/raster` has never been on
  npm, so `scripts/release.mjs` will publish it first, in isolation, and npm
  Trusted Publishing has no trust relationship to attach to a package that
  has never existed. If that first publish fails: `npm login` as an
  `@8bitscript` org member with publish rights, `git pull` to the version
  being released, `cd packages/raster && npm publish --access public`, then
  re-dispatch `gh workflow run release.yml --ref trunk` — `alreadyOnNpm()`
  skips it and the batch continues. See ".github/AGENTS.md", "A brand-new
  package's first publish".

### Patch Changes

- @8bitscript/atari8@0.10.0
  - @8bitscript/c128@0.10.0
  - @8bitscript/c64@0.10.0
  - @8bitscript/cx16@0.10.0
  - @8bitscript/mega65@0.10.0
  - @8bitscript/nes@0.10.0
  - @8bitscript/pet@0.10.0
  - @8bitscript/vic20@0.10.0
  - @8bitscript/web@0.10.0
