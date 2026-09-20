# @8bitscript/compiler

## 0.20.0

No changes in this release.

## 0.19.1

No changes in this release.

## 0.19.0

### Minor Changes

- dcb09eb: `baseline` in 8bitscript.config.ts: the system a program is designed on — the build every fact the program tests is true on, where `requires` is the floor every build clears (docs/project/baseline.md, docs/config.md). A machine's name (`'c64'`, under the project's own hardware for it), a name from `systems`, or a system's shape. `8bs build` and `8bs run` with no target build it; `8bs targets` names it ("This program is designed on"), and `--json` carries it with its resolved sheet; `8bs build --release` prints, after every artifact, how it stands to the baseline — `the baseline`, `level with the baseline (c64)`, or `short of the baseline (c64): video.palette 2 of 16, video.raster, memory.ram 3071 of 51199`. Only the facts the program's own files test are counted: the linker records every `#fact(key)` a project file spells and every `Video.*`/`Memory.*`/… const it reads from `@8bitscript/system` (`factsTested` on `link()`'s result; a package's own fact reads are the package's business), and `shortOfBaseline(baseline, facts)` in the compiler is the comparison. A baseline below the program's `requires` is refused as a config mistake. The builds that are not the baseline are called builds — the note says why not ports, tiers or editions.
  
  Also: `8bs build --release --checkout <dir>` honours the checkout. It returned into the release before the flag was read, so every artifact came from node_modules and nothing said so.

## 0.18.0

### Minor Changes

- aa3fd8e: C64: `text.print`, `text.printNumber` and `text.fill` in native code, and an `asm6502` block may name its own frame.
  
  - `@8bitscript/c64/text`: the three run routines are `native/6502/text.s` now, one linked section each. Measured with CIA 2 timer A around one call (`test/text-timing-probe.8bs`): a nine-character `print` 1,908 → 498 cycles, a five-digit `printNumber` 2,944 → 1,265, a forty-cell `fill` 8,078 → 1,110 — a HUD line was a fifth of an NTSC frame under the compiler's generic code, with a `place()` call and two more inside it for every cell. `text.putChar`/`putColor` are unchanged; `fill` now calls `prepare()` first like the other two (the picture set up, the mixed-case set selected in text mode), where before it wrote without. The routines read their arguments from page `$07` (the KERNAL's dead screen, beside the raster list's `$04`/`$05` and the multiplexer's `$06`).
  - Compiler: an `asm6502` operand that names one of the function's own parameters or locals is that slot's zero-page address — `lda cell`, `ldx cell+1`, `lda (s),y`, `lda #<cell` — in the zero-page form of the instruction; any other symbol is still a linker label, and `jsr`/`jmp`/a branch to a frame name is refused. The optimizer counts a name written in a block's text as a read, so a parameter only the block uses is still passed. This is what lets a package hand a string parameter's pointer to native code.
- 63b1906: C64: the VIC-II's opened border, idle graphics and sprite multiplexing, on a reworked raster list.
  
  - `@8bitscript/c64/border`: `border.top()`/`bottom()` add the `$D011` entries that open the upper and lower border for sprites (RSEL cleared at 249 after the VIC's line-247 comparison, restored at 47 + YSCROLL), with `setShort()` for a 24-row base.
  - `@8bitscript/c64/idle`: the ghost byte. In VIC bank 3 the idle-graphics byte `$3FFF` is `$FFFF`, the IRQ vector's high byte, and the raster handler's page used to draw as stripes in the gap a YSCROLL other than 3 opens; `raster.s` now routes the IRQ through a trampoline at `$FD` (the compiler's C64 zero-page budget ends there), so `$FFFF` is 0 and idle graphics are transparent in every program. `idle.setPattern()` writes the ECM byte `$F9FF` (block 231's pad byte) for a chosen pattern in an opened border, and `raster.at(line, idle.PATTERN, bits)` changes it per line.
  - `@8bitscript/c64/multiplex`: up to 24 virtual sprites from the eight — sorted by Y each frame, the eight topmost through the list's frame table, the rest as list entries at the earliest line each hardware sprite is free.
  - `@8bitscript/c64/raster`: the list is double-buffered (`commit()`; `enable()` commits), takes out-of-order entries (`insert()`), carries a frame table of sprite registers the handler writes at the end of every pass (`setFrameByte()`, `Frame.*`), ends its pass at line 255 whatever the last entry's line, and applies a late entry at once instead of losing the frame. `setValue()`/`addressOf()` work on the live list. The REU probe byte moved from `$033C` to `$03FF`.

## 0.17.0

No changes in this release.

## 0.16.0

### Patch Changes

- 592197a: Atari 8-bit builds can opt into ANTIC 6 (`textmode=gr1`): 20 columns and four playfield colors per character, so `text.setColor` is real instead of an empty stub. Stock GR.0 is unchanged.

## 0.15.0

### Minor Changes

- 758765d: Add project message catalogs (`src/i18n/<locale>.8bs`, imported as `@8bitscript/i18n/catalog`), compile-time `i18n.format`, Latin transliteration into the portable set, and `Input.CONFIRM_LABEL` on each machine's input layer. One locale still means one binary; projects without catalogs are unchanged.
- ae09eab: Add project `imports` in `8bitscript.config.ts` so specifiers like `@lib/game/rules.8bs` map to directories under the project. Wired through `8bs build`, `8bs check`, and the language server.
- 5d6dc92: Native builds can now retain source provenance through lowering, assembly, and branch relaxation, and `8bs build --debug` writes a human-readable `.lst` listing and a versioned `.8bs.debug.json` debug map alongside the artifact. The VS Code extension adds "8BitScript: View Generated Assembly", which opens the generated instructions for the file beside the editor and navigates back to source on selection. Off by default; release builds are unaffected.

### Patch Changes

- f063fcf: Cleared every open SonarCloud finding that was failing trunk's quality gate after 0.14.x:
  
  - Two MINOR code smells (`javascript:S7737`, object-literal default parameters) in the IntelliSense module's `hoverAt()`/`completionsAt()` — both now default to one shared, frozen `NO_MACHINE` constant instead of a fresh literal.
  - Three CRITICAL reliability bugs (`javascript:S2871`, sorting strings with no explicit compare function) in `discoverCatalogLocales()` (cli and compiler) and the i18n module's dead `schemaKeys()` helper. The two `discoverCatalogLocales()` sorts now use the same explicit ordinal comparator `packages/compiler/src/mos/debug.ts` already established for this exact reason — this order feeds build output and must not depend on the host's locale, so `localeCompare` (Sonar's own default suggestion) would have been the wrong fix. `schemaKeys()` was unused since the PR that added it and is deleted rather than patched.
  
  Also fixes a real bug found while resolving the object-literal defaults above: hover and completion for an imported namespace's member (`screen.blank`) inside a template string's `${...}` field (`` `Score: ${screen.blank()}` ``) silently answered nothing. The recursive re-lex that handles a template field's own contents was passing its small, freshly re-lexed token slice to the import-resolution lookup too, which needs the *whole* file's tokens to find the original `import` statement — a handful of tokens with no `import` in them can never resolve one. Both `hoverAt()` and `completionsAt()` now carry the outer file's token stream through the recursion (`outerTokens`) separately from the token slice used to find the cursor's own position, and use whichever one each job actually needs.

## 0.14.0

No changes in this release.

## 0.13.1

### Patch Changes

- 3094830: The editor knows `#package(...)`: hovering it explains the fields it reads
  and the diagnostics it refuses with, completion after `#` offers it next to
  `#frames`, `#system` and `#fact`, and a `#package` snippet expands to the
  `const VERSION: string = #package("version")` a title screen wants.

## 0.13.0

### Patch Changes

- ceda09a: SonarCloud's quality gate on trunk was failing on Reliability of New Code
  (C, needs A): super-linear regexes, a thenable-looking IR `then` field,
  always-false `===` checks, a loop that could only run once, and a handful
  of related smells. The regexes are now ordinary scans, the IR field is
  named where it stands with the same NOSONAR the rest of the compiler
  already uses, and the rest of the findings are the same behaviour without
  the pattern the gate was scoring.

## 0.12.0

### Patch Changes

- a0f9493: A forwarder costs nothing. A function or component whose body is exactly
  one call passing its own parameters through — `component Tile(row, col,
  exponent) { drawTile(row, col, exponent); }`, `function range(bound) {
  return random.range(bound); }` — is now that call at every site, run-time
  arguments and all, in any parameter order, across an import boundary. The
  site already loads and stores each argument into a parameter slot;
  pointing those stores at the callee's slots instead is free, and the
  forwarder's own copies and its `jsr`/`rts` are gone. This is what spec
  §30 and §64 promise an element costs, and it did not hold before: 2048's
  `<Tile row col exponent />` and `<Hud />` wrappers were +36 bytes on the
  PET 2001 and the unexpanded VIC-20 (2048 #49), the same across a module
  boundary +53 (2048 #45), and a one-line `range()` delegate +8 on five
  targets — all three are now byte-identical to the hand-written calls
  (2048 with all three in: PET 2001 2807 → 2763, VIC-20 3534 → 3490).
  
  Not a forwarder, and unchanged: a global passed through (each copy would
  load it again), a parameter used twice, an expression around the call, a
  body of two statements — so `f(); return;`, the idiom that keeps a
  helper a real call, still does. A literal the forwarder adds is inlined
  while the copies cost less than the parameter stores the sites stop
  making; a forwarder that reorders or drops a parameter keeps the call
  when the argument has a side effect. Examples unchanged (hello-world
  108, hello-bx 108, fancy 1007, joystick 2305 on the PET).
- 3d33043: An imported integer `const` now carries its declared type into IR. A
  reference to a module's own const is inlined by lowering with the type it
  was declared with; a reference to an *imported* one survives to the linker,
  which inlined it as `{ kind: 'const', value }` with no type — so the MOS
  backend refused it wherever a type is needed to widen or size a value:
  `text.fill(R, 4, 32)` with `export const R: usmallint = 5;` in another
  module failed with "'const': no type on this IR node", and
  `let n: usmallint = R + a;` with "'binop'". Only a `bool` const, or an
  integer one that happened to fold before the backend looked, got through;
  the same const declared in the using module always built. The linker now
  keeps the declared type beside every const value it may inline, its own and
  its imports', and the PET image for the cross-module spelling is
  byte-identical to the same-module one.
- 6597363: A function with one live call site is written into it — whatever its
  size, whatever its arguments. The body replaces the call, the argument
  stores, the frame and the `rts`, so the program can only get smaller:
  a read of the caller's own local is the read itself, a global or an
  expression is a local holding it (the store the call already made),
  and a non-void callee whose only `return` ends it is hoisted ahead of
  the statement that used its value. 2048's tile split into two lib
  primitives and an element (`paintTile` + `stampValue` + `Tile`, #51)
  was +56 bytes on every 6502 and +84 on the PET 2001 against the
  one-body `drawTile`; it is now the same size, on the PET and on the
  web.
  
  Bodies are optimized callees-first, so the size that decides whether a
  small body is pasted at several sites is the size it has with its own
  callees in it. 2048's parameterless `Board`, small as written, went
  into `main` three times carrying the whole inlined `ScoreBar` (+393
  bytes on the PET, #52); measured finished, it is one function.
  
  2048 (#53) on every native target: PET 2001 2759 → 2687, VIC-20
  3486 → 3400, C64 4595 → 4495, C128 3684 → 3594, Atari 8-bit 3716 →
  3599, X16 4429 → 4317, MEGA65 3659 → 3569 bytes of program; the NES
  image is its fixed size. Zero page moves by −7 to +9 (a callee's locals
  that a sibling's frame used to overlay are the caller's now). Examples:
  hello-world 108 and hello-bx 108 unchanged, fancy 1007 → 999, joystick
  2305 → 2273.
  
  Still a call: a void body with a `return` anywhere (the `f(); return;`
  idiom), a non-void body with an early return, `asm6502`, and a body
  whose free names a caller's own local would capture.

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
- 4a594eb: 8BX composition is conditional the ordinary way: `{cond ? <A /> : <B />}`
  and `{cond && <A />}` between tags, and `return (<…/>)` in a component
  body, elaborate to an `if` with a composition in each arm. A compile-time
  test — `Video.SPRITES > 0` — is a constant `if`, and the arm that cannot
  run leaves the program, component and all: on a machine without sprites
  the sprite arm costs nothing (measured). An element where a value is
  expected is refused (`8BS2024`), and a `{…}` child that is not a
  composition is, for now, too (`8BS2023`).
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
- 8309efa: 8BX element syntax is tokenized by the lexer, in tag, children and
  expression modes, and read by the parser token by token — no more
  re-scanning source text at a `<`. Every span is a token's, so a
  diagnostic inside a `{…}` attribute or child points into the file
  (and reaches the editor with the right range), `<` opens a tag only where
  no value sits before it (`a < b`, `array<u8, 4>` and `x << 2` are what
  they were; `if (x) <Foo />;` works), raw text between tags is one token
  in which `don't`, `//` and `>` are just text, and a half-typed tag ends
  with one diagnostic and a parser that keeps going. Text children are
  normalized the JSX way, once, in the parser. `<Studio.Window />` names
  parse; an element parses where a value is expected (a `?:` arm), for
  its spans. The VS Code grammar colors `component`, tags, attributes and
  embedded expressions in `.8bx`.
- 548f29b: 8BX components have methods: a `function` at the top of a component body
  works on the instance's own state and is instanced with it — `damage(5)`
  inside one `<Player />` touches that player's health and nobody else's —
  and inlines away like the rest when its arguments are compile-time. A
  method sees state, not props: naming a prop in one is `8BS2025`, with the
  fix (pass it as an argument). Nothing outside the component can call a
  method yet, since a static instance has no name to call it on.
- fb4cf62: `.8bs` is code, `.8bx` is composition. `asm6502` is refused in an `.8bx`
  file (`8BS2020`): machine code lives in a `.8bs` function the component
  imports. A top-level function that composes nothing, or a top-level
  `let`, in an `.8bx` is a warning (`8BS2021`) that `bx: { strict: false }`
  in `8bitscript.config.ts` switches off; component methods and state, and
  anything inside `{…}`, are never linted.
  
  A warning now reports and rides along: the linker and `8bs build` stop
  for errors only, where before any diagnostic — an inexact `#frames()`
  duration included — stopped a build.
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
- d1ab357: 8BX components keep state. `state count: utinyint = 0;` at the top of a
  component body is storage per static instance: every element — and every
  call from `.8bs` — is an instance with its own copy of the function and
  its own globals, laid out at compile time and named after the instance
  (`__bx_Counter__count__i1`), the template dropped, and a stateless
  component that contains a stateful one instanced per site too, so two
  `<Pair />` holding a `<Tally />` are four tallies. The two halves of a
  slotted component share one instance. Nothing is allocated at run time;
  `8bs build --size` lists every instance and the bytes of state it holds.
  `state` belongs at the top of a component body, typed, once per name,
  unshadowed (`8BS2022`); the initializer is a literal or a const, as for
  any global. Component methods and arrays of state are later.
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

- bd9a32a: The inliner weighs a call's arguments as the code they are — a load and a
  store at every copy — so a small body that only passes values along stays
  one function instead of being written out at every site (2048's board:
  54 bytes pasted three times where the call and its body cost 31). And
  `optimizeReachable` folds and prunes twice: a helper whose other callers
  fold away (the animated move, on a machine without the RAM for it) is
  now inlined into the one caller left. Every example builds to the same
  bytes as before.
- 44b31ef: `cond ? a : b` lowers on the web backend too (an `if … else … end` that
  leaves one value; only the taken arm runs), so both backends know the
  whole core language the same way. A `?:` whose test is known at compile
  time — `#fact(...) ? a : b` — is the taken arm, and the other is gone.

## 0.10.2

### Patch Changes

- 74f2785: A C64 program that draws once and ends now keeps what it drew.
  
  `setupVideo()` banks the KERNAL out and puts the picture at `$E000`, so `RTS` from `main()` snapped VIC back to `$0400` and hello-world showed stock `READY.` The C64 image now `endsByHalting` (`JMP` to itself, 3 bytes), the same flag Atari already uses. A PET or VIC-20 still returns to BASIC.

## 0.10.1

No changes in this release.

## 0.10.0

No changes in this release.

## 0.9.1

No changes in this release.

## 0.9.0

No changes in this release.

## 0.8.0

### Minor Changes

- 2026d01: Named systems live in three layers — advertised in 8bitscript.config.ts, this clone's .8bitscript/systems.json, and ~/.config/8bitscript/systems.json — and `8bs run --system` / `build` / `boot` resolve through that merge. `--checkout` (or EIGHTBITSCRIPT_CHECKOUT / toolchain.json) points a consumer at a local 8BitScript tree without rewriting its package.json. The editor's side bar has one Update/Install for that tree (workspace repo, or a clone under the extension's global storage) plus named-system quick launch; Configure System and Show Project are editor tabs.

## 0.7.1

### Patch Changes

- 3b75885: 6502: narrowing a 16-bit value to 8 bits now reads only the byte that
  survives, instead of building a 16-bit temporary and discarding half of it.
  
  `expr8()` evaluated any 16-bit expression into a temporary pair and then took
  its low byte, so the two ordinary ways of splitting a 16-bit value both paid
  for both halves when only one was ever read:
  
  - `x >> 8` (and any whole-byte shift) is now one load of the high half.
    `shift16()` already knew a whole-byte shift is a move rather than eight
    LSRs, but it still had to leave both halves behind because its caller might
    want them; the narrowing says nobody does. Shifts of 9-15 keep the leftover
    bits as `LSR A`; 16 or more is the constant 0.
  - `x & C`, `x | C` and `x ^ C` have no carry between the halves, so narrowed
    they are the low bytes alone. A mask that cannot change the answer
    (`& 0xFF`, `| 0`, `^ 0`) emits no instruction at all.
  
  `return` was spelling the same narrowing out a second time inline rather than
  calling `expr8()`, so returned expressions missed all of it. It now calls
  `expr8()`, which removes the duplication and picks up both fast paths.
  
  Measured at 0.6.2: `hi = value >> 8` as a statement of its own drops from 19
  bytes to 3, and 2048 loses 16 bytes on every 6502 target with no source change
  (44 on the Commander X16, which has more such sites) — the 4K PET 2001 build
  goes 2587 to 2571.
  
  Note for anyone comparing hardware-entropy against software-PRNG byte counts:
  this makes `@8bitscript/random`'s own `next()` 16 bytes cheaper (65 to 49), so
  measurements taken before it understate the software generator.

## 0.7.0

No changes in this release.

## 0.6.2

No changes in this release.

## 0.6.1

### Patch Changes

- f278212: A body more than one place calls is no longer written out once per call site.
  
  Inlining a void call removes the call, which is a win only while the body is smaller than the call it replaces — on the 6502 that is 3 bytes at each site plus one RTS. Past a few bytes, every extra call site pays the whole body again.
  
  A parameterless function never reached that question. The linker's guards reject on *parameters*, so a no-argument void helper was inlined everywhere it appeared, at any size. `@8bitscript/input`'s `poll()` is 117 IR nodes — 182 bytes on the PET — and 2048 reaches it from four places: once from `begin()`, which primes the edge detector, and once per direction read in the game loop. The game carried four copies.
  
  Bodies of eight IR nodes or fewer (about thirteen bytes, where a duplicated body and the call it replaces cost roughly the same) still inline at as many sites as they like. Only a body bigger than that, reached from more than one place, now stays a call. A single call site still inlines at any size — nothing is duplicated, so there is nothing to weigh.
  
  2048, measured across every target it builds for:
  
  | target | before | after | saved |
  | --- | --- | --- | --- |
  | PET 2001 (4K) | 2624 | 2420 | 204 (7.8%) |
  | PET 4032 (32K) | 2931 | 2510 | 421 (14.4%) |
  | VIC-20 | 3388 | 3123 | 265 (7.8%) |
  | C64 | 4018 | 3477 | 541 (13.5%) |
  | C128 | 3849 | 3318 | 531 (13.8%) |
  | Atari 8-bit | 4206 | 3488 | 718 (17.1%) |
  | Commander X16 | 4404 | 3907 | 497 (11.3%) |
  | MEGA65 | 3869 | 3382 | 487 (12.6%) |
  | web (wasm) | 3891 | 2745 | 1146 (29.5%) |
  | NES | 40976 | 40976 | 0 — the `.nes` is 16 + 32768 PRG + 8192 CHR, a fixed ROM layout that code size does not move |
  
  The joystick example drops 204 bytes on the PET and 264 on the C64. Hello World is byte-for-byte identical on every machine: nothing it calls is both large and called twice.
  
  The 4K PET is where this is load-bearing. `8bitscript.config.ts` in 2048 records 2440 bytes from when that build was fitted; 0.6.0 had drifted to 2624 as `begin()` started priming the edge detector and the PET's text package began selecting a character set. It is now 2420, under the original figure, with 651 bytes of headroom below `$0FFF` rather than 447.

## 0.6.0

### Minor Changes

- fc0af15: The C128 builds and runs, and the editor offers every machine that does.
  
  The C128 is the C64 again in almost every respect that matters here, which is why it went quickly: the same VIC-II registers and the same frame as an exact fraction of the same crystal (`FRAME_SYNC` already recorded the two entries identically), a screen at `$0400` written through a computed address, and a character ROM whose mixed-case set holds lower case at 1-26 and upper case at 65-90 — measured against `chargen-390059-01.bin`, where code 8 is `h` and code 72 is `H`, with only 105 and 122 differing across the block-graphics range, exactly as on every other Commodore here.
  
  Three things are its own. Its `.prg` loads at `$1C01` and its RAM ends at `$C000` — 41983 bytes, which is what `packages/c128/AGENTS.md` has always recorded, and the catalog's new build symbols reproduce that number exactly. Its zero page starts at `$0A`: `$00`/`$01` are the 8502's port and `$02`-`$09` are the KERNAL's JMPFAR/JSRFAR parameters, so those nine bytes stay the machine's — which is not a new decision, but the one this project's own pre-0.2.0 C128 link map already made. And its text package now selects the mixed-case set, which on this machine means agreeing with the ROM rather than overriding it: the C128 boots that way.
  
  Measured under x128: hello-world is **225 bytes** and returns to a working `ready.` prompt; 2048 is **3583 bytes** and draws its board.
  
  `@8bitscript/c128/text` also gets the fix its siblings got: it mapped only 64-95 and left lower case at 97-122, which in the upper-case set are graphics symbols.
  
  The VS Code extension offers `pet`, `c64`, `vic20`, `c128` and `web` — its task-definition enum, its system setting, and the launcher's own list. What each machine *offers* was never listed there and still is not: every option, value and preset comes from `8bs targets --json`, so the C64's REU sizes and the VIC-20's RAM expansions arrived on their own the moment those machines were on the list.
- c7fea69: The C64 and the VIC-20 build and run. 2048 plays on both.
  
  `RELEASE_MACHINES` is `pet, c64, vic20, web`. What it took, beyond the groundwork in the changes before this one:
  
  **`waitFrame()` on a raster.** The PET has a retrace flag and no documented crystal, so it measures its own frame at start-up. Every other Commodore here has the opposite pair of facts: no flag, but a raster counter readable as a plain byte and a frame that is an exact fraction of a known crystal. So the accumulator, its denominator and the whole compare/subtract body are shared, and only two things differ per machine — how a hardware frame is waited for (the raster leaving the top half of the frame and coming back to it, never a narrow at-line-0 window, for the reason `FRAME_SYNC` records at length) and how the per-frame credit is arrived at. PAL or NTSC cannot be a build flag, since one `.prg` runs on both, so it is probed once at start-up by watching for a line only one region ever reaches.
  
  **`string<N>` buffers.** A buffer's name is its address, the way a literal's is — it lives in the data section, not zero page — so it can be passed to `text.print` and assigned into. `stringCopy` is the assignment: the length byte and then that many characters, through two pointers.
  
  **Narrowing assignment.** `let offset: utinyint = (cellWidth - width) >> 1` is ordinary code — the subtraction is 16-bit because one side is, and the answer is kept in a byte. Narrowing takes the low byte, which is what it has always meant, instead of the statement being refused for a width the program never asked anything unusual of.
  
  **A 16-bit array index goes through a pointer.** Y is eight bits, so `screenRam[cell]` with a cell past 255 cannot be indexed with it. Truncating collapsed 1000 cells into the first 256 — on a 40-column screen, the whole display crammed into its top six rows, which is exactly what a C64 2048 drew before this. The address is computed instead, as a computed `memory.write` address already was.
  
  Measured under x64sc and xvic, through the real CLI:
  
  | | hello-world | 2048 |
  |---|---|---|
  | C64 | 424 bytes | 3747 bytes |
  | VIC-20 | 232 bytes | 3116 bytes, inside an unexpanded 3583 |
  
  The PET is unchanged at 108/108/127 bytes, and its 2048 got *smaller* — 2440 to 2413 — from the index-offset fold.
- 188cd63: Each machine's hardware catalog now says what a controller **carries**, not just how many ports it has — and a controller's *kind* is derived from that list rather than written down beside it.
  
  `input.joysticks: 2` and `input.pads: 2` count ports. They cannot be projected onto a real control list, because two machines with two pad ports each can take entirely different pads: the NES's eight bits and the X16's twelve are both "2". So the editor's Controller Setup panel kept two tables of its own — what each kind of device carries, and which pad each machine takes — and its own comment said it should not have to. Those tables are gone.
  
  **The new fact is `input.controls`**: the logical controls, in 8BitScript's own names, that the controller on this machine's ports actually carries.
  
  | machine | declares | derived kind |
  |---|---|---|
  | PET | — | none |
  | VIC-20 | `up down left right a` | `atari-stick` |
  | C64 | `up down left right a` | `atari-stick` |
  | C128 | `up down left right a` | `atari-stick` |
  | Atari 8-bit | `up down left right a` | `atari-stick` |
  | MEGA65 | `up down left right a` | `atari-stick` |
  | NES | `a b select start up down left right` | `nes-pad` |
  | Commander X16 | `up down left right a b x y l r start select` | `snes-pad` |
  | web | — | none |
  
  Every row is the repository's own research, not recall. `packages/c64/src/joystick.8bs` declares `Joystick.UP`/`DOWN`/`LEFT`/`RIGHT`/`FIRE` — five switches shorting to ground, the whole of the nine-pin Atari standard; `packages/vic20/AGENTS.md` traces the VIC-20's same five lines across two VIAs (right is VIA2 port B bit 7, a keyboard-column line); `packages/atari8/AGENTS.md` records that the Atari's own masks are bit for bit the C64's with `JOY_BTN_1_MASK` the only button, which is why `@8bitscript/atari8/joystick` can export the same values without either machine being fudged; `packages/c128/AGENTS.md` and `packages/mega65/AGENTS.md` both say CIA1 as the C64's. `packages/nes/src/pad.8bs` names the shift register's fixed order — A, B, SELECT, START, UP, DOWN, LEFT, RIGHT — and the catalog lists them in that order for that reason. The one button on a stick is `a` rather than `b`: it is the only button the machine has, and `a` is the one control every wider shape has in common.
  
  **The X16 is the machine this branch could not fully establish.** `packages/cx16/AGENTS.md` settles that it has two SNES pad ports (and that the KERNAL's reader for them is confusingly called `joystick_get`, `$FF56`). The twelve controls are the SNES pad's own set. What this repository does *not* carry is the bit layout `joystick_get` returns, and nothing here invents one — `packages/cx16/src/input.8bs` is still an honest stub that reads neither the pads nor the keyboard. The catalog says what the ports hold; it does not yet say what order the bits arrive in.
  
  **A kind is derived, never declared.** Nothing in a catalog spells `nes-pad`. `CONTROLLER_KINDS` in `packages/compiler/src/fold/facts.mjs` names four shapes and the exact set of controls each one is — `atari-stick` (5), `nes-pad` (8), `snes-pad` (12), `xbox-style` (all 18) — and `controllerKind(controls)` matches a machine's list against them. A name stored beside the shape it names is two statements that can disagree, and the one that can be checked would lose to the one that cannot. It also means a machine added tomorrow whose controller happens to be an Atari stick is recognised as one without a line of code changing at either end, which is the point. Matching is exact set equality rather than a subset ladder: a two-button stick clears the bar for `a` and `b` and is still not an NES pad, and a shape that matches nothing is `null` rather than the nearest guess.
  
  `xbox-style` is in the table and no machine carries it. It is the shape of the *host* pad this project develops against — the 8BitDo SN30 Pro in X-input mode that `docs/project/input.md` names as the development standard — and it is the superset the other three are projected out of, so naming it costs nothing and leaves the ladder complete.
  
  **Where it lives in a catalog matters.** The Commodores declare it on the `joystick` *value* of `port1`/`port2`, because on those machines what is in the port is a choice: `--hardware port1=none,port2=none` really does resolve to no controls, and the panel says so instead of drawing five controls onto an empty port. It is deliberately *absent* from `none`, `paddles` and `mouse1351` rather than empty on them — option values merge in catalog order, so a `[]` on port 2's `none` would erase the stick port 1 really has. Paddles and a 1351 already have their own facts. The machines whose pads have no option behind them — the Atari, the MEGA65, the NES, the X16 — declare it at machine level, and the PET and the web target declare nothing, out loud.
  
  **`input.controls` is the first fact that is a list**, which needed two things of the compiler. `factProblems` now checks that a catalog's list is an array of real control names and says which one is wrong, because a typo there is a control that silently never projects. And `#fact(input.controls)` is refused by name: there is no literal to fold a list into, and folding one would have handed the IR an array where an integer goes — a miscompile rather than an error. It is `program: false` for the same reason, so it is off `@8bitscript/system` and off a program's sheet; the editor and `8bs targets --json` read it, a program asks its input layer.
  
  The eighteen control names now have an owner. They were spelled out in three places — the compiler had none, the CLI's `controllers.mjs` and the editor's panel had one each. `LOGICAL_CONTROLS` in the compiler is the list a catalog is validated against, and the other two copies are held equal to it by tests: the CLI's directly, the editor's through the same import its own test makes, because the extension has no dependencies at all and can only ever see this as JSON.
  
  **What the editor deleted.** `DEVICE_CONTROLS` and `PAD_KINDS` in `editors/vscode/src/controllerProfile.cjs`. `project()` reads `input.controls` off the resolved fact sheet it was already being handed, and derives the kind from the shapes the toolchain publishes on the `input.controls` fact's own description — which is where a table that is the *vocabulary* belongs, rather than on any one machine's sheet. A toolchain too old to publish the shapes still gets the right controls, only without a name for them; a machine with ports and nothing said about what is in them gets a sentence rather than an invented pad.
- 57ccce1: The Commander X16 builds and runs. The MEGA65 builds.
  
  Four things the backend gained, all of them machine-independent and all of them wanted by these two rather than invented for them:
  
  - **`x / 2^k` is a shift and `x % 2^k` is a mask.** The 6502 has no divide, so `/` was refused by name — but a power-of-two divisor is not really a divide. The X16 package is written in those terms throughout (`memory.read(0x9F35) / 128`, `low / 256`, `attr / 16`, `cell % 256`), which is how a program reads best. Unsigned only: `>>` floors where `/` truncates, so the two disagree on negatives.
  - **16-bit `&`, `|` and `^`.** A byte at a time, which is all a bitwise operation ever is — no carry between the halves.
  - **Narrowing at every 8-bit boundary**, not just at a local or an assignment: a `memory.write` value, an 8-bit call argument and an array element all take the low byte of a wider expression now, which is what narrowing has always meant.
  - **`waitFrame()` for both.** The MEGA65's VIC-IV answers `$D011`/`$D012` like the C64's VIC-II, so it is the same raster poll. The X16 is a third shape: VERA raises a VSYNC bit in its ISR and acknowledging it is writing it back — an edge like the PET's, but needing no calibration, because the X16's frame is exactly 1/60s everywhere. At the default frame rate one VSYNC is exactly one logical frame and the accumulator never carries.
  
  The X16 also needed a start-up its package had documented and the native backend had never emitted: `CHR$(15)` through CHROUT, which switches the screen editor into ISO mode. `@8bitscript/cx16/text` writes ASCII straight to VERA — the tile index *is* the character code there — and without the switch the machine is in PETSCII and every letter draws as a graphic. Two instructions, on the one machine that needs them.
  
  **Measured under x16emu: hello-world is 1370 bytes and prints `Hello World!` over a working `READY.`**
  
  The MEGA65 is **not** un-parked. Its hello-world (251 bytes) and 2048 (3615 bytes) both build, but Xemu shows a one-time onboarding screen that waits for a keypress before it will run anything, so nothing has been seen on screen yet — and un-parking is what switches a machine's emulator tests on. It joins the list when a screenshot can prove it.
  
  2048 does not fit the X16 yet: its deepest call chain wants more zero page than the 94 bytes `$22`-`$7F` the X16 documents as the user's, and taking any of the KERNAL's `$80`+ would need research this workspace does not have.
- 57ccce1: Every machine the toolchain knows now builds and runs. `RELEASE_MACHINES` is the whole list.
  
  The NES and the Atari 8-bit join, each brought up against its own emulator — `Hello World!` and 2048 seen on screen under `fceux` and `atari800`. Neither fits the shape every machine before them shared (a `.prg` with a BASIC stub that `SYS`es in and `RTS`es back), which is what `mos/image.ts` exists for: a NES program is a ROM started by a reset vector, an Atari program is a segmented `.xex` the DOS loader jumps through.
  
  **The X16's zero page widens from 94 bytes to 181**, and 2048 fits it. The evidence is the ROM's own ld65 configuration rather than the docs' summary table: `cfg/x16.cfginc` declares ZPKERNAL at `$80`, ZPDOS at `$91`, ZPAUDIO at `$A7`, ZPMATH at `$A9` and ZPBASIC at `$D4`, and `cfg/kernal-x16.cfgtpl` loads every one of the KERNAL bank's four zero-page segments into ZPKERNAL while no other bank declares zero page at all — so no KERNAL routine can reach `$A9`-`$FF`, whatever it is asked to do. That range is the Math library's and BASIC's, and the reference manual releases both to machine code outright. A program that never hands BASIC back takes it; one that does keeps the polite `$22`-`$7F`.
  
  `$02`-`$21` stays out under both, though 2048 would fit inside the old ceiling if it were taken: those are `r0`-`r15`, the KERNAL API's caller-supplied 16-bit argument registers, demonstrably written through `extapi`, and "does this program call such a routine" is not a fact readable off the finished instruction stream the way `usesWaitFrame` is — the calls sit inside opaque `asm6502` blocks.
  
  A zero-page budget may now carry holes of its own, and they survive into every program. The PET's CHRGET hole is the other kind — it exists only because a returning program leaves BASIC's interpreter running — and still drops for a program that never returns.
  
  The VS Code extension offers all nine targets. What each machine *offers* is still never listed there: every option, value and preset comes from `8bs targets --json`.
- 57ccce1: The MEGA65 builds, runs and is no longer parked — and two bugs in its package are fixed.
  
  Getting it on screen at all took cracking Xemu's onboarding screen, which waits for a keypress and so hung every headless run. The cause is upstream: Hyppo reads its config sector from absolute LBA 1 of the SD image, while Xemu only ever writes one at syspart+1, so the onboarding-complete byte was never set. Writing a valid config sector at LBA 1 of `mega65.img` — `$0E = $80` being the byte that matters — makes `xmega65 -headless -besure -prgmode 65 -prg … -screenshot …` work. That is emulator state, not repo state, and it is recorded here because the next person will hit it too.
  
  What that revealed, neither of which any build could have shown:
  
  - **Lower case drew as graphics.** `text.8bs` mapped only 64-95 and pinned `$D018` to the upper-case set, so lower-case ASCII passed straight through into the graphics range: hello-world drew `H`, four blobs, ` W`, four more blobs, `!`. It now selects the mixed-case set (`$26`, measured: screen codes `08 05 0C 0C 0F` render as `hello`, `48 45 4C 4C 4F` as `HELLO`) and maps `97`-`122` down by 96, which is what every other Commodore in this workspace does and what `packages/pet/src/text.8bs` argues at length. This reverses a deliberate choice recorded in that file — that `TICK` should read as `TICK` the way it does on the NES and the X16 — because a text package that silently changes the text is answering a different question than the one it was asked.
  - **Colour RAM was left mapped over the CIAs.** `prepare()` set CRAM2K (`$D030` bit 0) so the 80-column screen's cells 1024-1999 could be coloured, and never cleared it — leaving colour RAM in front of `$DC00`-`$DFFF`, where the CIAs are. `@8bitscript/mega65/input`'s `poll()` then scanned the keyboard matrix through colour cells and invented key presses out of whatever the screen held: in 2048 a phantom LEFT slid the board and spawned a third tile before the player touched anything. Its writes went astray too, landing in colour cells 1024-1027. Every text entry point now hands the CIAs back. The file's own note — "the frame runtime polls `$D012`, not a CIA, so nothing here misses them" — had overlooked `poll()` in the same package.
  
  Measured under xmega65: hello-world **256 bytes**, printing `Hello World!`; 2048 **3645 bytes**, drawing its board with exactly the two starting tiles its own generator predicts, at the indices the C64 build puts them.

### Patch Changes

- 05764ff: `asm6502` blocks and `memory.read()` lower on the 6502 backend — the last two rules C64 hello-world was missing.
  
  An `asm6502` block reaches the backend as raw source, because nothing before it had any reason to know what assembly looks like. `mos/asm/parse.ts` reads it into ordinary `Directive`s, so the assembler, the branch relaxer and the linker cannot tell which instructions a human wrote. The syntax is the one the machine packages already use, read out of them rather than invented: implied, immediate (`$hex`, `%binary`, decimal), zero page and absolute chosen by the literal's own written width, the indexed and indirect shapes, `;` and `//` comments, named labels, and GNU-style local labels with backward and forward branches (`1:` … `bne 1b`, the c128 mouse-settle loop). A mnemonic with no zero-page form widens rather than being refused, so `jsr $84` assembles. Anything else is refused by name, with the line of the block it was on.
  
  `memory.read(addr)` is `memoryWrite`'s counterpart and takes the same two shapes: a constant address is one `LDA`, a computed one goes through a zero-page pointer with Y held at 0.
  
  The C64's polite zero-page budget widens from `$FB-$FE` to `$F7-$FE` — the four bytes BASIC and the KERNAL both leave alone, plus the four RS-232 buffer pointers, which are free until something opens a serial channel. Eight bytes, and `screen.blank()`'s own frame wants seven of them.
  
  The PET is unchanged: hello-world 108/108/127 bytes across the 2001, 3032 and 8032.
- 57ccce1: The Atari 8-bit builds natively: hello-world and 2048 both run under atari800.
  
  `packages/atari8`'s hardware sheet now carries `build.defsym.__load_address`
  `$2000` and `__ram_ceiling` `$C000`. The difference, 40960, is the
  `memory.ram` fact the catalog already published and the `LENGTH = 0xa000` the
  pre-0.2.0 link script already had — three independent statements of the same
  region. It is an over-claim by about 993 bytes at the top, where the OS's own
  text screen and display list live; that is stated in
  `packages/atari8/AGENTS.md` rather than enforced, the same way `banks.8bs`
  states its `$4000` budget.
  
  Zero page is `$80-$FF`. Every page-zero location the package records as the
  OS's is below `$80` (RTCLOK, ATRACT, SAVMSC, RAMTOP), and the pre-0.2.0 DOS
  link map already put a compiled program's registers at `$80` and its
  variables from `$A0`. Unlike every Commodore, the polite and owned budgets are
  the same 128 bytes: a program here cannot take the machine, because
  `text.8bs` and `screen.8bs` read SAVMSC on every run of text and it is the
  OS's vertical blank that copies the color shadows onto GTIA. Measured:
  hello-world spends 19 bytes, 2048 spends 98.
  
  `mos/image-atari8.ts` is the `.xex` container — a `$FFFF` marker, the RUN
  segment writing the entry address to `$02E0`/`$02E1`, then the code segment,
  in that order and with inclusive `end` addresses, reproducing byte for byte
  the `xxd` of a working build `packages/atari8/AGENTS.md` records.
  `entryIsVectored` is false, because Atari DOS really does `JSR` through
  RUNAD — but a new `MachineImage.endsByHalting` makes `main()` spin anyway,
  because the environment that regains control clears the screen and resets the
  OS color shadows (measured under atari800 7.1.2, identical with `-basic`,
  `-nobasic` and the stock config; the same program with a holding loop keeps
  its greeting up indefinitely). Three bytes, and the only state in which what
  a program drew is still what the machine is showing.
  
  `waitFrame()` polls ANTIC's VCOUNT (`$D40B`), which counts half-lines exactly
  the way the VIC-20's `$9004` does and therefore reuses its thresholds. It is
  the first machine whose frame runtime keeps interrupts **on**
  (`RasterSync.keepsInterrupts`): the OS's VBI is what this target's own
  packages depend on, and the half-frame poll window is far too wide for a
  handler to hide a wrap inside. `joystick.8bs`'s header already said a built
  Atari program contains no `sei`; now it is true.
  
  The thirteen cartridge media values are refused by name rather than wrapped
  in a `.xex` container and written out as a `.rom` nothing could load.
  
  Machine-independent: `--size`'s image-overhead line was `2 + stub.length`,
  which is exactly a `.prg`'s load-address word and BASIC stub and silently
  wrong for any other format — 10 bytes short on a `.xex`, short by the header
  and ROM padding on a `.nes`. It is now derived as the difference between the
  file and the linked code, so every target's size report sums to the real byte
  count again, which is what `SizeReportEntry` already promised.
- cc04ede: Hello World runs on the C64 and the VIC-20, and reads as `Hello World` on both.
  
  **A constant added to an index folds into the address.** `screenRam[i + 250] = 32` — the second quarter of the C64 and VIC-20 screen-clearing loops — was computing `i + 250` in an 8-bit register and indexing with the result. The sum wraps at 255, so from `i = 6` on every iteration wrote back over the first quarter and the rest of the screen was never cleared: a real miscompile, visible as a screen full of uncleared garbage. The 6502's answer is the other association, `STA base+250,Y`, which is exact for every index Y can hold and is what those loops were written in terms of all along ("four constant offsets off one 8-bit index is the shape a 6502 wants"). It is also smaller and faster: C64 hello-world went from 481 bytes to 424.
  
  **The C64 and VIC-20 text packages draw in the mixed-case character set.** They selected the upper-case/graphics set and mapped only 64-95, leaving lower case at 97-122 — which in that set are graphics symbols, so `"Hello World"` drew as `H`, a graphic, three graphics, a space, `W`… Both ROMs were measured directly (`chargen-901225-01.bin`, `chargen-901460-03.bin`): the mixed-case set holds lower case at 1-26 and upper case at its own 65-90, exactly as the PET's does, and in the 96-127 block the two sets differ only at 105 and 122, which no block-graphics code uses. This is the same decision `@8bitscript/pet` took, for the same reason: it is the only set holding both cases, so it is the only one that can draw a string as it was written.
  
  **The VIC-20's hardware sheet carries its load address and RAM ceiling**, because a RAM expansion moves both: `$1001` unexpanded, `$0401` with the 3K (which fills `$0400-$0FFF`), `$1201` with 8K and up (the screen drops to `$1000`). Each is checked against the catalog's own `memory.ram` fact. `__ram_ceiling` joins `__ram_size` as a spelling of the linker's ceiling, for machines whose usable RAM does not end on a whole number of KiB — unexpanded, the VIC-20's ends at `$1E00`, which is 7.5.
  
  **Zero-page budgets for both.** The VIC-20 keeps a real polite shape and uses it: hello-world is 232 bytes and 4 zero-page bytes, and returns to a working BASIC. The C64 has no polite shape to keep — `setupVideo()` banks the KERNAL out and keeps it out, because the screen it sets up lives at `$E000` under the KERNAL ROM, so a C64 program that draws has already taken the machine — and takes the whole page.
  
  Measured under x64sc and xvic: both show `Hello World!`. The PET is unchanged at 108/108/127 bytes.
- 6e1056b: Groundwork for the second 6502 machine: the backend stops assuming it is building for the PET.
  
  Three things that were the PET's are now the hardware sheet's or the machine's:
  
  - **The load address comes off the sheet.** It was a per-machine table in `mos/index.ts`, which the VIC-20 disproves — a RAM expansion moves BASIC's program area from `$1001` to `$1201`, so one machine has two. It is `build.defsym.__load_address` now, alongside `__ram_size`, and a catalog can carry machine-level build symbols (`"8bitscript".hardware.build`) rather than only per-option ones. A machine whose sheet lacks one is refused by name.
  - **Zero-page budgets are per machine.** `ZP_BUDGETS` pairs the polite budget (a program that returns to BASIC) with the owned one (a program that never does). The C64's polite range is nothing like the PET's: BASIC owns `$02-$8F` and the KERNAL `$90-$FF`, leaving `$FB-$FE` — four bytes, enough to print and return and nothing like enough for real state, which is the same trade the PET's own two budgets make.
  - **`@address` arrays lower.** They were refused by name; they now bind their label to the pinned address through a new `equate` directive in the assembler, so an `@address` array reaches hardware by exactly the path a data-section array reaches the program image by, and emits no bytes. This is what the C64 and VIC-20 packages are written against — `screenRam[cell] = 32` over the VIC's screen — 65 uses across the two.
  
  The PET is byte-for-byte unchanged by all of it (hello-world 108/108/127 across the 2001, 3032 and 8032; 2048 2440 bytes on a stock 4K 2001).
  
  The C64 is deliberately **not** added to `RELEASE_MACHINES` yet: a package's own emulator tests switch on from that list, so listing a machine before it can build a program runs them against one that cannot boot what they load. It joins when it builds. The next blocker is `asm6502` blocks, which reach the backend as raw text and need a 6502 assembly parser; `setupVideo()` in `@8bitscript/c64` uses them to bank the KERNAL out.
- 57ccce1: The NES builds natively: hello-world and 2048 both run under FCEUX.
  
  `mos/image-nes.ts` produces a real cartridge — an iNES header, 32 KiB of
  NROM PRG-ROM with the code at `$8000`, the 6502's reset/NMI/IRQ vectors on
  top of it, and 8 KiB of CHR-ROM. That last part has no equivalent on any
  other target: the NES has no character ROM, so the font `@8bitscript/nes`
  ships as a native source is part of the FILE, and `mos/chr-nes.ts` reads
  the data-only slice of GNU-as syntax that file is written in
  (`.macro`/`.rept`/`.byte`/`.space` and integer expressions) rather than
  expanding 512 tiles of artwork into literal bytes by hand.
  
  `packages/nes`'s hardware sheet carries `__load_address` `$8000` (where
  NROM maps PRG-ROM) and `__ram_ceiling` `$FFF9` — 32761 apart, which is the
  32 KiB PRG-ROM the catalog documents less the three vectors and the one
  `RTI` byte the two unused ones point at — plus `__bss_origin` `$0200` and
  `__bss_ceiling` `$0800`, 1536 apart, exactly the `memory.ram` fact. Zero
  page is the whole page: the 2A03 has no CPU port at `$00/$01`, there is no
  OS, and NROM has no mapper registers, so there is nobody to be polite to.
  
  `mos/startup/nes.ts` emits the reset handler: the APU's frame and DMC IRQs
  silenced, the stack pointer the 6502's reset genuinely leaves undefined,
  and the two vertical blanks the PPU needs before it accepts a write. Its
  absence is invisible in the code and total on screen — the first `.nes`
  built without it ran correctly and photographed as 256x240 pixels of
  black. `main()` ending halts rather than `RTS`ing (nothing pushed a return
  address), and on this machine the halt keeps delivering the package's
  write queue at every vertical blank, which is what lets a program that
  draws once and stops show anything. `waitFrame()` gets its NES runtime —
  PPUSTATUS bit 7, whose read is its own acknowledgement — and calls
  `FRAME_SYNC.nes`'s frame hook inside the blank; a hook the optimizer
  inlined out of existence is refused by name rather than silently dropped.
  
  Three changes here are machine-independent:
  
  - **Mutable arrays on a ROM image.** A `.prg` is copied into RAM before it
    runs, so a mutable array could always ride inside the program image and
    be initialized by the load. A cartridge cannot: a store into it does
    nothing, silently, and `@8bitscript/nes`'s own write queue is such an
    array. An image that declares `writableImage: false` now gets its
    mutable arrays bump-allocated into the RAM window its sheet names,
    cleared at start-up (a cartridge's RAM holds garbage at power-on), with
    any real initializer copied down out of the ROM — and refused by name
    when that window is missing or too small.
  - **`memory.read(addr);` as a statement** lowers. A read whose value is
    discarded looks like dead code and is the opposite: it is what resets the
    PPU's address/scroll write toggle and what acknowledges the PET's
    retrace flag. It was refused as an unlowered construct; it is now the
    load it always meant, and is never elided.
  - **`FRAME_SYNC.nes`'s NTSC ratio** read 59601 CPU cycles per two frames,
    which is 60.0585Hz. The NES's published rate is 60.0988Hz and the exact
    figure is 59561: 341 x 261 + 340.5 dots a frame (the pre-render line is a
    dot shorter on odd frames), twice, over the PPU's 3:1 ratio to the CPU.
    0.067% is invisible in a screenshot and about 58 logical frames of drift
    a day, which is the drift this accumulator exists to prevent.
  
  `@8bitscript/nes` itself gains the lowercase half of its character set —
  the font stopped at `Z`, so `Hello World!` drew as `H   W  !` — and a fix
  to `locate()`, where a `utinyint` row multiplied by 32 wrapped at eight
  bits and put every row below the eighth on the wrong one (2048's status
  line, printed at row 21, landed on row 5). Its write queue drops from 112
  bytes to 48: 112 was measured against the pre-0.2.0 toolchain's delivery
  loop, this backend's is slower, and re-measuring under FCEUX put the
  corruption edge at 56 on both a sparse and a full board.
- b390ef3: PET text is now drawn in the machine's text character set, so a string reaches the screen as it was written — and nothing puts the old set back on the way out.
  
  `"Hello World"` is `Hello World`, not `HELLO WORLD`. The PET's graphics set holds exactly one case of the alphabet, so a text package that encodes for it silently flattens mixed-case text to capitals — answering a different question than the one the caller asked. The text set holds both cases, so `@8bitscript/pet/text` draws in that one and selects it first on the models that boot elsewhere. The 8032's editor ROM already boots into it, so `#fact(video.bootsInTextMode)` folds the write away there and no `$E84C` store reaches the binary at all.
  
  `video.characterSetSwapped` matters again as a result: the original 2001's 901447-08 ROM arranges the text set's two cases the other way round from every later model's (upper case stays at 1-26, lower case moves to 65-90 — verified glyph by glyph against the ROM, where code 8 is `H` and not `h`). A build for the 2001 gets that mapping; a build for anything else gets the other.
  
  **`restoreOnExit` is removed**, along with the `usesCharacterSet` scan and the `LDA $E84C`/`PHA` … `PLA`/`STA $E84C` pair it drove. Restoring the character set could never work: the bit is retroactive — it selects the ROM the video hardware reads for every cell already on screen — so writing the old value back re-rendered the text the program had just drawn, through the very set it switched away from in order to draw it. Measured on a 3032, `Hello World!` came back as `|ELLO OORLD!` above a correct prompt. A program now exits in the set it selected, which is the only state where what it drew still reads as what it wrote. A project that still sets `restoreOnExit` is told the option is retired rather than having it quietly ignored.
  
  Measured under xpet on all three models: the 8032 shows `Hello World!` over its own `ready.` and spends nothing; the 2001 shows `Hello World!` over an upper-case `READY.`, because its ROM's two sets agree on codes 1-26 where BASIC's prompt is drawn; a 3032 shows `Hello World!` over a lower-case `ready.`, which is the whole of what this costs. hello-world is 108 bytes on a 3032, against 116 when the restore was still being paid for.

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

### Patch Changes

- 0be3354: The published package now ships runnable JavaScript for the 6502 and
  WebAssembly backends. `./mos` and `./wasm` used to export raw TypeScript,
  which Node refuses to type-strip under node_modules
  (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — so every npm consumer of a
  0.2.x compiler crashed on `8bs build` for any target. prepack now emits the
  stripped backends (`tsc -p tsconfig.publish.json`, `.ts` specifiers rewritten
  to `.js`) and the published manifest's exports point at them; the workspace
  keeps running the TypeScript directly.

## 0.2.4

### Patch Changes

- c143dbe: The 6502 backend now emits substantially smaller — and never slower —
  code, measured on the real 2048 game: 4005 bytes of program down to 2930
  (27%), which is what lets it fit a stock 4K PET 2001. The wins, each
  strictly fewer bytes *and* fewer cycles: comparisons and `+`/`-`/bitwise
  operands that are constants or plain variables are read directly by
  CMP/ADC/SBC/AND/ORA/EOR instead of bouncing through a zero-page temp;
  `x == 0`/`x != 0` branch straight off the load's own Z flag when that's
  provably sound; `i = i + 1` is INC (and `- 1` DEC); a constant loop
  condition (`while (true)`) emits no test; 16-bit constants, string-label
  addresses, and 16-bit sums store straight into their destination pair
  instead of through a temporary; array indexes that are constants or plain
  variables load Y directly; a jump to the very next address (a function's
  final `return`) is deleted; a reload of a value the accumulator provably
  still holds is deleted; and global initializers share one LDA per distinct
  value.

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
