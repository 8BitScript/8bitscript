# @8bitscript/random

## 0.19.0

### Patch Changes

- @8bitscript/atari8@0.19.0
  - @8bitscript/c64@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [aa3fd8e]
- Updated dependencies [63b1906]
- Updated dependencies [63b1906]
  - @8bitscript/c64@0.18.0
  - @8bitscript/atari8@0.18.0

## 0.17.0

### Patch Changes

- @8bitscript/atari8@0.17.0
  - @8bitscript/c64@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [592197a]
  - @8bitscript/atari8@0.16.0
  - @8bitscript/c64@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [758765d]
  - @8bitscript/c64@0.15.0
  - @8bitscript/atari8@0.15.0

## 0.14.0

### Patch Changes

- @8bitscript/atari8@0.14.0
  - @8bitscript/c64@0.14.0

## 0.13.1

### Patch Changes

- @8bitscript/atari8@0.13.1
  - @8bitscript/c64@0.13.1

## 0.13.0

### Patch Changes

- @8bitscript/atari8@0.13.0
  - @8bitscript/c64@0.13.0

## 0.12.0

### Minor Changes

- 76c0db7: `@8bitscript/random/entropy`: one import that is the machine's own
  entropy source where it has one and the seeded generator everywhere
  else. `entropy.begin()` claims SID voice 3 on the C64 (and is nothing
  elsewhere), `entropy.tick()` steps the software generator once a frame
  (and is nothing on hardware), `entropy.next()` and `entropy.range(bound)`
  read the oscillator on the C64, POKEY's `RANDOM` on the Atari 8-bit, and
  the 16-bit LCG on the other seven. The resolver's twin rule picks the file
  — `src/entropy.c64.8bs` and `src/entropy.atari8.8bs` beside the portable
  `src/entropy.8bs` — so a program opts in with the import and never names
  a machine. The bare `@8bitscript/random` is unchanged: deterministic,
  seeded, replayable, as the root AGENTS.md rule requires.
  
  Extracted from 2048, whose three `rng.8bs` twins this replaces; all nine
  of its builds are byte-identical before and after (2763 on the 4K PET
  2001, 3490 on the unexpanded VIC-20, 4599 on the C64, 3720 on the Atari
  8-bit). `range()` computes its own modulo rather than forwarding, which
  measured +8 bytes a target the other way; a test keeps it so.

### Patch Changes

- @8bitscript/atari8@0.12.0
  - @8bitscript/c64@0.12.0

## 0.11.0

No changes in this release.

## 0.10.2

No changes in this release.

## 0.10.1

No changes in this release.

## 0.10.0

No changes in this release.

## 0.9.1

No changes in this release.

## 0.9.0

No changes in this release.

## 0.8.0

No changes in this release.

## 0.7.1

### Patch Changes

- 6e96fbd: Correct the header of `@8bitscript/random`'s default generator: it still
  described the Atari 8-bit as "the one target that does have hardware entropy
  behind its own import today," which stopped being true when
  `@8bitscript/c64/random` (SID voice 3's noise oscillator) landed. There are
  two, and the header now names both alongside POKEY's counter.
  
  Comments only — no change to the generator, its constants, or its output on
  any target. `packages/random/README.md` already listed both correctly; this
  brings the source header into line with it.

## 0.7.0

No changes in this release.

## 0.6.2

No changes in this release.

## 0.6.1

No changes in this release.

## 0.6.0

No changes in this release.

## 0.5.0

No changes in this release.

## 0.4.1

No changes in this release.

## 0.4.0

No changes in this release.

## 0.3.0

No changes in this release.

## 0.2.6

No changes in this release.

## 0.2.5

No changes in this release.

## 0.2.4

No changes in this release.

## 0.2.3

No changes in this release.

## 0.2.2

No changes in this release.

## 0.2.1

No changes in this release.

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

## 0.1.2

### Patch Changes

- b9aea09: The editor talks to `8bs lsp` with a thin stdio client instead of
  `vscode-languageclient`, so the VSIX is tens of kilobytes. Marketplace
  publish no longer uses vsce's 180-second gallery timeout.

## 0.1.1

### Patch Changes

- d56d494: Added a "How it compares" section to the root README, docs/about, and
  the VS Code extension's README, positioning 8BitScript against BASIC,
  hand-written assembly, and C with measured compiled-size numbers.
