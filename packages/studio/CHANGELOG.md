# @8bitscript/studio

## 0.1.3

### Patch Changes

- 7547105: The VS Code extension now ships a Marketplace icon (the pixel-8 mark from
  the favicon, on the same purple/cream palette) instead of using the
  Marketplace's generic default.
- Updated dependencies [7547105]
  - @8bitscript/input@0.1.3
  - @8bitscript/pointer@0.1.3
  - @8bitscript/screen@0.1.3
  - @8bitscript/system@0.1.3
  - @8bitscript/text@0.1.3
  - @8bitscript/ui@0.1.3

## 0.1.2

### Patch Changes

- b9aea09: The editor talks to `8bs lsp` with a thin stdio client instead of
  `vscode-languageclient`, so the VSIX is tens of kilobytes. Marketplace
  publish no longer uses vsce's 180-second gallery timeout.
- Updated dependencies [b9aea09]
  - @8bitscript/input@0.1.2
  - @8bitscript/pointer@0.1.2
  - @8bitscript/screen@0.1.2
  - @8bitscript/system@0.1.2
  - @8bitscript/text@0.1.2
  - @8bitscript/ui@0.1.2

## 0.1.1

### Patch Changes

- d56d494: Added a "How it compares" section to the root README, docs/about, and
  the VS Code extension's README, positioning 8BitScript against BASIC,
  hand-written assembly, and C with measured compiled-size numbers.
- Updated dependencies [d56d494]
  - @8bitscript/input@0.1.1
  - @8bitscript/pointer@0.1.1
  - @8bitscript/screen@0.1.1
  - @8bitscript/system@0.1.1
  - @8bitscript/text@0.1.1
  - @8bitscript/ui@0.1.1
