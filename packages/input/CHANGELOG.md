# @8bitscript/input

## 0.1.3

### Patch Changes

- 7547105: The VS Code extension now ships a Marketplace icon (the pixel-8 mark from
  the favicon, on the same purple/cream palette) instead of using the
  Marketplace's generic default.
- 47eaff5: Pin the workspace's `packageManager` to pnpm 12.3.4 (up from 12.1.0) and
  recommend the `8bitscript.8bitscript-lang` VS Code extension in this
  repo's `.vscode/extensions.json`. The VS Code extension also gains a
  Marketplace icon (the pixel-8 mark, on the same purple/cream palette as
  `docs/assets/favicon.svg`) instead of falling back to the generic default.
- Updated dependencies [7547105]
- Updated dependencies [47eaff5]
  - @8bitscript/atari8@0.1.3
  - @8bitscript/c64@0.1.3
  - @8bitscript/c128@0.1.3
  - @8bitscript/cx16@0.1.3
  - @8bitscript/mega65@0.1.3
  - @8bitscript/nes@0.1.3
  - @8bitscript/pet@0.1.3
  - @8bitscript/vic20@0.1.3
  - @8bitscript/web@0.1.3

## 0.1.2

### Patch Changes

- b9aea09: The editor talks to `8bs lsp` with a thin stdio client instead of
  `vscode-languageclient`, so the VSIX is tens of kilobytes. Marketplace
  publish no longer uses vsce's 180-second gallery timeout.
- Updated dependencies [b9aea09]
  - @8bitscript/atari8@0.1.2
  - @8bitscript/c64@0.1.2
  - @8bitscript/c128@0.1.2
  - @8bitscript/cx16@0.1.2
  - @8bitscript/mega65@0.1.2
  - @8bitscript/nes@0.1.2
  - @8bitscript/pet@0.1.2
  - @8bitscript/vic20@0.1.2
  - @8bitscript/web@0.1.2

## 0.1.1

### Patch Changes

- d56d494: Added a "How it compares" section to the root README, docs/about, and
  the VS Code extension's README, positioning 8BitScript against BASIC,
  hand-written assembly, and C with measured compiled-size numbers.
- Updated dependencies [d56d494]
  - @8bitscript/atari8@0.1.1
  - @8bitscript/c64@0.1.1
  - @8bitscript/c128@0.1.1
  - @8bitscript/cx16@0.1.1
  - @8bitscript/mega65@0.1.1
  - @8bitscript/nes@0.1.1
  - @8bitscript/pet@0.1.1
  - @8bitscript/vic20@0.1.1
  - @8bitscript/web@0.1.1
