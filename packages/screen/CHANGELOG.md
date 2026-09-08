# @8bitscript/screen

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
