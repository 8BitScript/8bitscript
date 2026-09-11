# @8bitscript/compiler

## 0.2.3

### Patch Changes

- d58bf12: `text.setColor` on a machine with no per-cell color is now an empty
  function, and the compiler deletes the call — so a program that colors
  its text pays the PET, Atari 8-bit, and NES nothing, without wrapping the
  call in `Video.COLOR_PER_CELL`.

## 0.2.2

### Patch Changes

- ee330ca: Everything a real game needed: 2048 now builds, runs, and plays on both
  0.2 targets, and the language features it forced are in.
  
  - **Mutable arrays and `string<N>` buffers have storage on both
    backends.** On the PET a `let` array's bytes ride inside the program
    image — a loaded `.prg` is RAM, so the load is the initializer — and on
    the web they get a linear-memory home (zero by default, a data segment
    when initialized). `storeIndex` writes 1-byte elements on both;
    `stringCopy` and 2-byte const-array element reads land on the web.
  - **The 6502 backend lowers `*`, `%`, `&`, `|`, `^`, and constant-amount
    `<<`/`>>`** — multiply via one shared shift-and-add routine (emitted,
    with its six zero-page cells, only when a runtime `*` survives the
    optimizer), `%` as the classic CMP/BCC/SBC subtraction loop, and the
    optimizer now folds all of these between constants and strength-reduces
    a constant multiplier (power of two, or two set bits over a ref) into
    shifts before any backend runs.
  - **16-bit return values.** A 16-bit-returning function writes a fixed
    zero-page pair of its own; the call site copies it out immediately.
  - **Zero-page frames.** Parameters, return slots, and locals now overlay
    by call depth (recursion-free by construction): two functions never
    live at once share the same bytes, and calls nested in a call's later
    arguments count as live extensions. A `waitFrame()` program — which
    owns the machine outright, interrupts off from its first store — now
    claims the whole $02-$FF budget; a program that returns to BASIC keeps
    the polite $8E-$FF one.
  - **Two real codegen bugs fixed.** 16-bit comparisons read the Z flag off
    a CMP/SBC chain where only the carry is meaningful — `34 >= 100` came
    back "equal" and printNumber's digit loop subtracted forever; equality
    now compares byte-by-byte and orderings read only the carry. And the
    optimizer inlined no-parameter void calls whose bodies contain
    `return`, which then returned from the *caller* — 2048's spawnTile
    silently ended main() from inside resetGame(). A body with a return
    anywhere now stays a real call.
  - **The linker types cross-module reads.** A ref to an imported global,
    an imported array's element read, and a call to an imported function
    all reach the backends with real types, so the 6502's 8-vs-16-bit
    split never meets a typeless node.

## 0.2.1

### Patch Changes

- b48b19b: Hello-world on the PET was 835 bytes of program and 49 of zero page because
  the compiler still emitted both `#fact` branches of asciiToScreenCode, a
  runtime ASCII conversion and string loop for `text.print(0, "Hello World!")`,
  JSRs into PET `blank`'s empty color stubs, a 16-bit STA (zp),Y screen fill,
  a 12-byte waitFrame scratch window, an unrolled 32-bit frameRate multiply
  (211 bytes of setup), and zp for helpers the program never reaches. Fold
  constant `if`s and never-assigned globals after pruning dead writers, turn a
  literal print into stores of already-converted screen codes, skip the string
  table entry those stores no longer need, inline a single-site void call
  whose parameters are unused, lower a constant fill loop to STA abs,X, and
  multiply waitFrame's measured elapsed with a Russian-peasant loop that
  reuses the accumulator — measured on the same example: 331 program bytes /
  8 zp. The per-frame waitFrame routine is unchanged; the print and fill are
  fewer cycles as well as fewer bytes. `--size` still names the inlined
  `text_print` / `screen_blank` bodies and splits wait-frame setup from the
  per-frame routine, so the report does not collapse into one `main` bucket.
- 09ae45f: Hover and completion now cover a named import's own namespace, not just
  built-in syntax: hovering `screen.blank(...)` shows its signature and doc
  comment, and typing `screen.bl` after `import { screen } from
  "@8bitscript/screen"` offers `blank` in the completion list. This reads the
  module the import actually resolves to — for a machine-conditional package
  such as `@8bitscript/screen`, one release target's version (noted in the
  hover text), since no single machine is known while editing.
- 152a9f2: Resolved SonarQube findings in `editors/vscode/src/projects.cjs` (an
  explicit sort compare function, a `.map()` callback no longer passed
  a function with its own second parameter directly, two regexes with
  quadratic worst-case behavior replaced with plain string methods, and
  a hand-rolled scanner's loop rewritten so its own cursor isn't a
  reassigned `for` variable) and `packages/compiler/src/mos/asm/relax.ts`
  (`Number.parseInt` instead of the global). No behavior change.

## 0.2.0

### Minor Changes

- 7e4c24e: Bare Metal: external code-generation toolchains are removed. 8BitScript now carries its own 6502 and WebAssembly backends in `@8bitscript/compiler` (`mos` and `wasm`), which do not yet build any target. The catalog key `build.driver` is renamed `build.startup`. `examples/` is removed.
- 75d5f27: `8bs build --target <t> --size` prints a per-function breakdown of the
  built program under the existing memory line — every function that
  survived reachability pruning, plus each backend's own fixed-cost
  buckets (the wait-frame runtime, the BASIC stub, a wasm module's own
  section framing), largest first, each with its own share of the total.
  Opt-in: without the flag, `8bs build` prints exactly what it always
  has.
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

- 3827a1c: Lexer lookbehind for `%` vs binary skips comments and treats `true`/`false` as operands; strings no longer continue across a newline after `\`; `asm6502` brace matching skips assembly comments. Document the scanner's rules in `packages/compiler/src/lexer/AGENTS.md`.
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
