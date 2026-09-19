# @8bitscript/ui

## 0.17.0

### Patch Changes

- @8bitscript/text@0.17.0

## 0.16.0

### Patch Changes

- 592197a: Atari 8-bit builds can opt into ANTIC 6 (`textmode=gr1`): 20 columns and four playfield colors per character, so `text.setColor` is real instead of an empty stub. Stock GR.0 is unchanged.
- @8bitscript/text@0.16.0

## 0.15.0

### Patch Changes

- @8bitscript/text@0.15.0

## 0.14.0

### Patch Changes

- @8bitscript/text@0.14.0

## 0.13.1

### Patch Changes

- @8bitscript/text@0.13.1

## 0.13.0

### Patch Changes

- @8bitscript/text@0.13.0

## 0.12.0

### Patch Changes

- @8bitscript/text@0.12.0

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
- b96ef5f: 8BX components cross module boundaries, and cost nothing when their
  props are compile-time.
  
  A `component` is now elaborated to a function of the same name in the
  module that declares it, and an element to a call to it — so a body
  resolves names where it was written, an attribute expression runs once
  however often the body reads the prop, and `export component` is an
  ordinary exported function that `import { MenuBar } from "./menubar.8bx"`
  binds like any other. `link()` reads the whole module graph before
  elaborating any module, so an imported component's signature is known
  where it is used; `analyze()` does the same one import deep. The linker's
  inliner inlines a component call whose arguments are all compile-time
  values, so `hello-bx` still builds byte-identical to `hello-world` on
  the PET (tested), and a component fed a run-time value stays a call.
  
  `export component` parses. `component` is a keyword in `.8bx` only:
  `let component: u8` in a `.8bs` file compiles as it always did.
  `@8bitscript/ui`'s `menubar.8bx` exports its three components.
- 47cf362: 8BX components place their children with `<slot />`. A slotted component
  is elaborated into two functions around the slot, and
  `<Window x={1}><A /><B /></Window>` into `Window__open(1); A(); B();
  Window__close(1);` — the children run once, in place; an argument both
  halves read is hoisted into a local when it could do anything, so it
  runs once; and the halves cross modules like any other exported
  function. The slot must be one, at the top level of the body, with no
  local read across it (`8BS2019` otherwise). A `children` parameter still
  means the component accepts text children.
  
  `@8bitscript/ui/menubar-bx` is the wrapper as it was meant to be:
  `<MenuBar row={0} width={40}><MenuItem label="FILE" /></MenuBar>`, with
  `MenuBarEnd` gone. Written as elements, a bar builds byte-identical to
  the hand-written begin/item/end calls on the PET and the C64 — measured
  in `packages/cli/test/menubar-bx.test.mjs`.

### Patch Changes

- 785b966: `menubar.8bx` imports the menu bar it wraps by file (`./menubar.8bs`),
  not by the package's own name — a package cannot depend on itself, and
  the package's test said so.
- @8bitscript/text@0.11.0

## 0.10.2

### Patch Changes

- @8bitscript/text@0.10.2

## 0.10.1

### Patch Changes

- @8bitscript/text@0.10.1

## 0.10.0

### Patch Changes

- @8bitscript/text@0.10.0

## 0.9.1

### Patch Changes

- @8bitscript/text@0.9.1

## 0.9.0

### Patch Changes

- @8bitscript/text@0.9.0

## 0.8.0

### Patch Changes

- @8bitscript/text@0.8.0

## 0.7.1

### Patch Changes

- @8bitscript/text@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [ea88a5d]
  - @8bitscript/text@0.7.0

## 0.6.2

### Patch Changes

- @8bitscript/text@0.6.2

## 0.6.1

### Patch Changes

- @8bitscript/text@0.6.1

## 0.6.0

### Patch Changes

- @8bitscript/text@0.6.0

## 0.5.0

### Patch Changes

- @8bitscript/text@0.5.0

## 0.4.1

### Patch Changes

- @8bitscript/text@0.4.1

## 0.4.0

### Patch Changes

- @8bitscript/text@0.4.0

## 0.3.0

### Patch Changes

- @8bitscript/text@0.3.0

## 0.2.6

### Patch Changes

- @8bitscript/text@0.2.6

## 0.2.5

### Patch Changes

- @8bitscript/text@0.2.5

## 0.2.4

### Patch Changes

- @8bitscript/text@0.2.4

## 0.2.3

### Patch Changes

- @8bitscript/text@0.2.3

## 0.2.2

### Patch Changes

- @8bitscript/text@0.2.2

## 0.2.1

### Patch Changes

- @8bitscript/text@0.2.1

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
- Updated dependencies [d7c558f]
- Updated dependencies [16e92f4]
- Updated dependencies [a4aa759]
- Updated dependencies [57c262f]
  - @8bitscript/text@0.2.0

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
  - @8bitscript/text@0.1.3

## 0.1.2

### Patch Changes

- b9aea09: The editor talks to `8bs lsp` with a thin stdio client instead of
  `vscode-languageclient`, so the VSIX is tens of kilobytes. Marketplace
  publish no longer uses vsce's 180-second gallery timeout.
- Updated dependencies [b9aea09]
  - @8bitscript/text@0.1.2

## 0.1.1

### Patch Changes

- d56d494: Added a "How it compares" section to the root README, docs/about, and
  the VS Code extension's README, positioning 8BitScript against BASIC,
  hand-written assembly, and C with measured compiled-size numbers.
- Updated dependencies [d56d494]
  - @8bitscript/text@0.1.1
