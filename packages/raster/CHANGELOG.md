# @8bitscript/raster

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
