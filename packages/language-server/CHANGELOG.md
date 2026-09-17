# @8bitscript/language-server

## 0.13.0

### Patch Changes

- 82f0cda: Hover, completion and Go to Definition on a hardware API (`@8bitscript/screen`,
  `text`, `input`, `raster`) show the API every machine agrees on, read from all
  nine machine modules at once, instead of one machine's implementation with
  "shown as implemented for the pet target — another target's version may
  differ" under it. What differs between machines is said, and only when it
  does: which machines have a member the others lack (and that yours is one of
  them, when the file is a machine's twin or the project has one target), whose
  signature disagrees with the portable one, and whose doc is being shown when
  each machine documents a member in its own words. Completion annotates a
  machine-specific member with its machines; Go to Definition opens the module
  for your file's or project's machine, else the first that has the member. A
  new compiler test fails the workspace when two machines give a portable member
  different signatures (one known case is recorded: `raster.at`'s `line` width).
- Updated dependencies [ceda09a]
  - @8bitscript/compiler@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [a0f9493]
- Updated dependencies [3d33043]
- Updated dependencies [6597363]
  - @8bitscript/compiler@0.12.0

## 0.11.0

### Minor Changes

- 660b8c0: 8BX (`.8bx`): a `component` declaration that elaborates to a plain call
  before any backend sees it, so a declarative element (`<Foo bar={baz} />`)
  costs exactly what writing `foo(baz)` by hand would cost — measured
  byte-identical on the PET in the new `hello-bx` example (108 bytes, same as
  `hello-world`).
  
  The front end grows a binder (`packages/compiler/src/binder`) that resolves
  symbols and scopes ahead of the checker, and a `bx/` pass
  (`check.mjs`, `elaborate.mjs`, `parse.mjs`) that parses element syntax at
  statement boundaries — `<`, `<<` and the rest of the operator grammar are
  unchanged in either source kind — checks it, then elaborates it into the
  core AST the checker, folder and every backend already understand.
  `analyze()`, `link()` and the language server all run binding and BX
  elaboration before folding and checking, for both `.8bs` and `.8bx` files.
  
  Also: a conditional expression (`cond ? a : b`) lowers to real branching
  IR and MOS instruction selection, editor support for `.8bx` (grammar,
  language registration, activation), and `docs/compiler.md`, which replaces
  the `8bx` design-direction doc with a description of the pipeline as
  built.
  
  Not in this release: array-typed component props, and no backend beyond
  mos/wasm has been asked to prove elaboration is free — only the PET and
  web are measured.
- 1de8025: IntelliSense for a program's own names, from the binder (8BX spec PR 15).
  Hover on a component, function, variable, const, parameter or `state`
  field shows its declaration and the doc comment above it, following an
  import to the file it comes from — a component called from `.8bs`
  (`MenuBar();`) is the same component as `<MenuBar />`. Completion offers
  the names visible from the cursor; in `.8bx`, `<` offers the components
  in scope and `slot`, a component's tag offers the props it still needs
  (as snippets), and `</` closes the innermost open element. New
  `getDefinition` in the compiler and `textDocument/definition` in the
  language server: Go to Definition lands on the declaration, in this file
  or another. Hover and completion now lex an `.8bx` buffer as one.

### Patch Changes

- Updated dependencies [660b8c0]
- Updated dependencies [4a594eb]
- Updated dependencies [b96ef5f]
- Updated dependencies [8309efa]
- Updated dependencies [548f29b]
- Updated dependencies [fb4cf62]
- Updated dependencies [47cf362]
- Updated dependencies [d1ab357]
- Updated dependencies [bd9a32a]
- Updated dependencies [1de8025]
- Updated dependencies [44b31ef]
  - @8bitscript/compiler@0.11.0

## 0.10.2

### Patch Changes

- Updated dependencies [74f2785]
  - @8bitscript/compiler@0.10.2

## 0.10.1

### Patch Changes

- @8bitscript/compiler@0.10.1

## 0.10.0

### Patch Changes

- @8bitscript/compiler@0.10.0

## 0.9.1

### Patch Changes

- @8bitscript/compiler@0.9.1

## 0.9.0

### Patch Changes

- @8bitscript/compiler@0.9.0

## 0.8.0

### Minor Changes

- 2026d01: Named systems live in three layers — advertised in 8bitscript.config.ts, this clone's .8bitscript/systems.json, and ~/.config/8bitscript/systems.json — and `8bs run --system` / `build` / `boot` resolve through that merge. `--checkout` (or EIGHTBITSCRIPT_CHECKOUT / toolchain.json) points a consumer at a local 8BitScript tree without rewriting its package.json. The editor's side bar has one Update/Install for that tree (workspace repo, or a clone under the extension's global storage) plus named-system quick launch; Configure System and Show Project are editor tabs.

### Patch Changes

- Updated dependencies [2026d01]
  - @8bitscript/compiler@0.8.0

## 0.7.1

### Patch Changes

- Updated dependencies [3b75885]
  - @8bitscript/compiler@0.7.1

## 0.7.0

### Patch Changes

- @8bitscript/compiler@0.7.0

## 0.6.2

### Patch Changes

- @8bitscript/compiler@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies [f278212]
  - @8bitscript/compiler@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [05764ff]
- Updated dependencies [57ccce1]
- Updated dependencies [fc0af15]
- Updated dependencies [cc04ede]
- Updated dependencies [c7fea69]
- Updated dependencies [188cd63]
- Updated dependencies [57ccce1]
- Updated dependencies [57ccce1]
- Updated dependencies [6e1056b]
- Updated dependencies [57ccce1]
- Updated dependencies [57ccce1]
- Updated dependencies [b390ef3]
  - @8bitscript/compiler@0.6.0

## 0.5.0

### Patch Changes

- @8bitscript/compiler@0.5.0

## 0.4.1

### Patch Changes

- @8bitscript/compiler@0.4.1

## 0.4.0

### Patch Changes

- @8bitscript/compiler@0.4.0

## 0.3.0

### Patch Changes

- @8bitscript/compiler@0.3.0

## 0.2.6

### Patch Changes

- @8bitscript/compiler@0.2.6

## 0.2.5

### Patch Changes

- Updated dependencies [0be3354]
  - @8bitscript/compiler@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies [c143dbe]
  - @8bitscript/compiler@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [d58bf12]
  - @8bitscript/compiler@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [ee330ca]
  - @8bitscript/compiler@0.2.2

## 0.2.1

### Patch Changes

- 09ae45f: Hover and completion now cover a named import's own namespace, not just
  built-in syntax: hovering `screen.blank(...)` shows its signature and doc
  comment, and typing `screen.bl` after `import { screen } from
  "@8bitscript/screen"` offers `blank` in the completion list. This reads the
  module the import actually resolves to — for a machine-conditional package
  such as `@8bitscript/screen`, one release target's version (noted in the
  hover text), since no single machine is known while editing.
- Updated dependencies [b48b19b]
- Updated dependencies [09ae45f]
- Updated dependencies [152a9f2]
  - @8bitscript/compiler@0.2.1

## 0.2.0

### Minor Changes

- 7e4c24e: Bare Metal: external code-generation toolchains are removed. 8BitScript now carries its own 6502 and WebAssembly backends in `@8bitscript/compiler` (`mos` and `wasm`), which do not yet build any target. The catalog key `build.driver` is renamed `build.startup`. `examples/` is removed.
- d7c558f: 0.2.0 is scoped to the Commodore PET and the web. `8bs build` and `8bs
  run` now refuse the other seven machines (vic20, c64, c128, atari8,
  nes, cx16, mega65) by name; their packages are unchanged and stay in
  the workspace, parked until their native backends land after 0.2.0.
  
  `@8bitscript/examples` is new: `hello-world`, the program both
  backends are built against, shipped with the CLI the way Studio is.
  The VS Code extension lists it by default and reads it from the
  package's own manifest rather than a fixed directory; it also now
  recognizes bun's lockfile alongside pnpm, npm, and yarn.
- 16e92f4: The `mos` and `wasm` backends in `@8bitscript/compiler` now emit for
  real. `8bs build` and `8bs run` work end to end for both 0.2.0 targets:
  `packages/examples/hello-world`, unmodified, builds, runs, and renders
  its own mixed-case "Hello World!" correctly on a real Commodore PET
  (checked against the `xpet` emulator) and in a real browser (checked
  against a real `--screenshot` run and the browser runtime's own
  generated page script). The `wasm` backend gained `&`, `|`, `^`, `<<`,
  and unsigned `>>` as real lowered operators (wasm's native
  `i32.and`/`i32.or`/`i32.xor`/`i32.shl`/`i32.shr_u`), needed once
  `@8bitscript/web/screen`'s own color masking (`value & 15`) became the
  first real caller. The web target's own text rendering (both the real
  browser canvas and the `--screenshot` bitmap font) now covers lower
  case too, matching what the checker's portable character set and the
  PET's own `asciiToScreenCode` have allowed all along — it previously
  covered upper case only, silently drawing every lower-case letter as a
  blank cell.
- a4aa759: Both native backends (`mos` and `wasm`) now compile only what a
  program's entry can actually reach, instead of every function and
  global an import brings along whether it's called or not. Measured on
  the real, unmodified `hello-world` example: the PET build shrank from
  1132 to 835 bytes of program (26% smaller, plus 101 to 49 bytes of
  RAM), and the web build's `.wasm` shrank from 614 to 408 bytes (34%
  smaller) — one `@8bitscript/text` import used to pull in `putChar`,
  `putColor`, `setColor`, `setReverse`, and `printNumber`'s whole
  decimal-digit loop alongside the `print()` a program actually calls.
  No language, API, or output behavior changed — only what nothing ever
  uses is gone.

### Patch Changes

- 57c262f: Normalized spelling in comments, docs, and user-facing strings
  (package descriptions, editor hover/grammar text, diagnostic prose) to
  match the spelling the code's own identifiers already use — `color`
  not `colour`, `behavior` not `behaviour`, `initialize`/`optimize`/
  `recognize` rather than `-ise`, and a handful of one-off words. No
  behavior, API, or identifier changed; this is text only. The `GREY`
  constant (`BorderColor.GREY`, `BackgroundColor.GREY`) and its prose
  mentions are left alone — that one's a real public API surface, a
  separate decision from a text-only pass like this.
- Updated dependencies [7e4c24e]
- Updated dependencies [75d5f27]
- Updated dependencies [d7c558f]
- Updated dependencies [16e92f4]
- Updated dependencies [3827a1c]
- Updated dependencies [a4aa759]
- Updated dependencies [57c262f]
  - @8bitscript/compiler@0.2.0

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
  - @8bitscript/compiler@0.1.3

## 0.1.2

### Patch Changes

- b9aea09: The editor talks to `8bs lsp` with a thin stdio client instead of
  `vscode-languageclient`, so the VSIX is tens of kilobytes. Marketplace
  publish no longer uses vsce's 180-second gallery timeout.
- Updated dependencies [b9aea09]
  - @8bitscript/compiler@0.1.2

## 0.1.1

### Patch Changes

- d56d494: Added a "How it compares" section to the root README, docs/about, and
  the VS Code extension's README, positioning 8BitScript against BASIC,
  hand-written assembly, and C with measured compiled-size numbers.
- Updated dependencies [d56d494]
  - @8bitscript/compiler@0.1.1
