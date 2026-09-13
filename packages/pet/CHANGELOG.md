# @8bitscript/pet

## 0.6.0

### Patch Changes

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
- 188cd63: `input.begin()` primes the edge detector, so a control already held when a program starts is no longer reported as a fresh press.
  
  Every machine's input layer keeps `before` (what was held at the previous poll) and reports an edge as "held now, not held before". `before` started at zero, so on the very first `poll()` anything already down looked like it had just been pressed — on all nine machines, since they all share the shape.
  
  Found by the new `joystick` example, which counts every press it is handed: on the MEGA65 it read `SEEN 00001` at start-up with nothing touched, at every frame count from 300 to 2400, while the C64, C128 and VIC-20 read `00000`. A scratch probe reading CIA1 directly on the first frame showed why — RETURN down (`$02`), stick clear — so it was a real key, really held, really reported as a press nobody made. `begin()` now takes one poll, so the program's first poll compares against reality.
  
  It costs about 210 bytes per program, because `poll()` gains a second call site and stops being inlined into the loop. 2048 on a stock 4K PET goes from 2413 to 2624 bytes against ~3071 available, and the joystick example fits every machine including the unexpanded VIC-20. Measured after the fix on the MEGA65: `SEEN 00000`, with the frame counter still running.
- 6e1056b: Groundwork for the second 6502 machine: the backend stops assuming it is building for the PET.
  
  Three things that were the PET's are now the hardware sheet's or the machine's:
  
  - **The load address comes off the sheet.** It was a per-machine table in `mos/index.ts`, which the VIC-20 disproves — a RAM expansion moves BASIC's program area from `$1001` to `$1201`, so one machine has two. It is `build.defsym.__load_address` now, alongside `__ram_size`, and a catalog can carry machine-level build symbols (`"8bitscript".hardware.build`) rather than only per-option ones. A machine whose sheet lacks one is refused by name.
  - **Zero-page budgets are per machine.** `ZP_BUDGETS` pairs the polite budget (a program that returns to BASIC) with the owned one (a program that never does). The C64's polite range is nothing like the PET's: BASIC owns `$02-$8F` and the KERNAL `$90-$FF`, leaving `$FB-$FE` — four bytes, enough to print and return and nothing like enough for real state, which is the same trade the PET's own two budgets make.
  - **`@address` arrays lower.** They were refused by name; they now bind their label to the pinned address through a new `equate` directive in the assembler, so an `@address` array reaches hardware by exactly the path a data-section array reaches the program image by, and emits no bytes. This is what the C64 and VIC-20 packages are written against — `screenRam[cell] = 32` over the VIC's screen — 65 uses across the two.
  
  The PET is byte-for-byte unchanged by all of it (hello-world 108/108/127 across the 2001, 3032 and 8032; 2048 2440 bytes on a stock 4K 2001).
  
  The C64 is deliberately **not** added to `RELEASE_MACHINES` yet: a package's own emulator tests switch on from that list, so listing a machine before it can build a program runs them against one that cannot boot what they load. It joins when it builds. The next blocker is `asm6502` blocks, which reach the backend as raw text and need a 6502 assembly parser; `setupVideo()` in `@8bitscript/c64` uses them to bank the KERNAL out.
- b390ef3: PET text is now drawn in the machine's text character set, so a string reaches the screen as it was written — and nothing puts the old set back on the way out.
  
  `"Hello World"` is `Hello World`, not `HELLO WORLD`. The PET's graphics set holds exactly one case of the alphabet, so a text package that encodes for it silently flattens mixed-case text to capitals — answering a different question than the one the caller asked. The text set holds both cases, so `@8bitscript/pet/text` draws in that one and selects it first on the models that boot elsewhere. The 8032's editor ROM already boots into it, so `#fact(video.bootsInTextMode)` folds the write away there and no `$E84C` store reaches the binary at all.
  
  `video.characterSetSwapped` matters again as a result: the original 2001's 901447-08 ROM arranges the text set's two cases the other way round from every later model's (upper case stays at 1-26, lower case moves to 65-90 — verified glyph by glyph against the ROM, where code 8 is `H` and not `h`). A build for the 2001 gets that mapping; a build for anything else gets the other.
  
  **`restoreOnExit` is removed**, along with the `usesCharacterSet` scan and the `LDA $E84C`/`PHA` … `PLA`/`STA $E84C` pair it drove. Restoring the character set could never work: the bit is retroactive — it selects the ROM the video hardware reads for every cell already on screen — so writing the old value back re-rendered the text the program had just drawn, through the very set it switched away from in order to draw it. Measured on a 3032, `Hello World!` came back as `|ELLO OORLD!` above a correct prompt. A program now exits in the set it selected, which is the only state where what it drew still reads as what it wrote. A project that still sets `restoreOnExit` is told the option is retired rather than having it quietly ignored.
  
  Measured under xpet on all three models: the 8032 shows `Hello World!` over its own `ready.` and spends nothing; the 2001 shows `Hello World!` over an upper-case `READY.`, because its ROM's two sets agree on codes 1-26 where BASIC's prompt is drawn; a 3032 shows `Hello World!` over a lower-case `ready.`, which is the whole of what this costs. hello-world is 108 bytes on a 3032, against 116 when the restore was still being paid for.

## 0.5.0

### Patch Changes

- 5754df7: PET text is drawn for the character set the machine booted into, and nothing changes that set.
  
  The PET's character-set bit is one register for the whole screen, and it is retroactive: it chooses the ROM the video hardware reads *now*, so flipping it re-renders every cell already on screen, BASIC's included. `text.8bs` used to select the mixed-case text set before each run of text, which meant a program left the machine in a mode its owner never chose — the 3032 and 4032 boot into upper-case/graphics and came back to a lower-case `ready.` prompt.
  
  Which set a model boots into is a fixed fact about it, so it is one now: `video.bootsInTextMode`, true for the business-keyboard editor ROMs (the 8032) and false for the 2001, 3032 and 4032. `asciiToScreenCode` folds on it and addresses whichever set is already live, so nothing writes `$E84C` and there is nothing to restore. Verified on all three models: each shows readable text above a BASIC prompt still in its own boot mode.
  
  What this means for a program: on a machine that boots into the graphics set — every model here but the 8032 — that set holds one case of the alphabet, so `text.print("Hello")` draws `HELLO`. That is what a PET in its power-on set has always looked like. An 8032 boots into the text set and keeps real mixed case.
  
  Programs also get slightly smaller, since no character-set write means no save/restore around them: the `hello-world` example is 103 bytes, against 116 with one.

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

### Patch Changes

- 7e28950: The PET input layer no longer turns a release of SHIFT into a phantom
  RIGHT/DOWN press. Edges are now detected on the physical cursor keys,
  with SHIFT sampled only to decide what a cursor key's own edge means —
  before this, the edge was detected on the shift-composed direction bit,
  and since nobody releases SHIFT and the cursor key on the same frame,
  every left/up release left a frame of bare cursor key that read as a
  brand-new right/down press (measured in 2048 under xpet: each LEFT move
  was chased by a phantom RIGHT that slid the board straight back, which
  players experienced as "my keypress did nothing").

## 0.2.3

### Patch Changes

- d58bf12: `text.setColor` on a machine with no per-cell color is now an empty
  function, and the compiler deletes the call — so a program that colors
  its text pays the PET, Atari 8-bit, and NES nothing, without wrapping the
  call in `Video.COLOR_PER_CELL`.

## 0.2.2

No changes in this release.

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
