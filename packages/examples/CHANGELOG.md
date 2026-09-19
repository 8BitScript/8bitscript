# @8bitscript/examples

## 0.17.0

### Patch Changes

- @8bitscript/input@0.17.0
  - @8bitscript/pet@0.17.0
  - @8bitscript/raster@0.17.0
  - @8bitscript/screen@0.17.0
  - @8bitscript/system@0.17.0
  - @8bitscript/text@0.17.0
  - @8bitscript/web@0.17.0

## 0.16.0

### Patch Changes

- @8bitscript/input@0.16.0
  - @8bitscript/raster@0.16.0
  - @8bitscript/screen@0.16.0
  - @8bitscript/text@0.16.0
  - @8bitscript/pet@0.16.0
  - @8bitscript/system@0.16.0
  - @8bitscript/web@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [758765d]
  - @8bitscript/input@0.15.0
  - @8bitscript/pet@0.15.0
  - @8bitscript/web@0.15.0
  - @8bitscript/raster@0.15.0
  - @8bitscript/screen@0.15.0
  - @8bitscript/text@0.15.0
  - @8bitscript/system@0.15.0

## 0.14.0

### Patch Changes

- @8bitscript/input@0.14.0
  - @8bitscript/pet@0.14.0
  - @8bitscript/raster@0.14.0
  - @8bitscript/screen@0.14.0
  - @8bitscript/system@0.14.0
  - @8bitscript/text@0.14.0
  - @8bitscript/web@0.14.0

## 0.13.1

### Patch Changes

- @8bitscript/input@0.13.1
  - @8bitscript/pet@0.13.1
  - @8bitscript/raster@0.13.1
  - @8bitscript/screen@0.13.1
  - @8bitscript/system@0.13.1
  - @8bitscript/text@0.13.1
  - @8bitscript/web@0.13.1

## 0.13.0

### Patch Changes

- @8bitscript/input@0.13.0
  - @8bitscript/pet@0.13.0
  - @8bitscript/raster@0.13.0
  - @8bitscript/screen@0.13.0
  - @8bitscript/system@0.13.0
  - @8bitscript/text@0.13.0
  - @8bitscript/web@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [922ec1f]
  - @8bitscript/web@0.12.0
  - @8bitscript/input@0.12.0
  - @8bitscript/raster@0.12.0
  - @8bitscript/screen@0.12.0
  - @8bitscript/text@0.12.0
  - @8bitscript/pet@0.12.0
  - @8bitscript/system@0.12.0

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
- 9ad0106: A program starts from a `.8bs` file. `8bs build` refuses an `.8bx` entry
  by name — an `.8bx` declares composition, and a program reaches its
  components by importing them and calling them: `Hello();` is `<Hello />`
  the way `.8bs` can spell it, and is checked as any call is. `hello-bx`
  is split accordingly: `src/hello-bx.8bs` is the program, `src/Hello.8bx`
  the component, and its PET build is still byte-identical to
  `hello-world`'s.

### Patch Changes

- @8bitscript/input@0.11.0
  - @8bitscript/pet@0.11.0
  - @8bitscript/raster@0.11.0
  - @8bitscript/screen@0.11.0
  - @8bitscript/system@0.11.0
  - @8bitscript/text@0.11.0
  - @8bitscript/web@0.11.0

## 0.10.2

### Patch Changes

- 2288987: `@8bitscript/text`'s portable surface gets a new `releaseCursor()`:
  `text.print()`/`screen.blank()` write straight into screen memory on
  every Commodore target, which the KERNAL's own cursor tracking never
  sees, so `READY.` used to print wherever the boot/LOAD/RUN echo had left
  the cursor — a different number of blank lines on every machine, with no
  relation to what the program actually drew.
  
  VIC-20, C128 and MEGA65 now call KERNAL PLOT ($FFF0) to park the cursor
  explicitly, giving a consistent, deterministic one blank line between a
  program's last output and `READY.` (measured under xvic/x128/xmega65).
  PET, C64 and CX16 stay honest no-ops for now — PET's ROM predates PLOT
  and a direct zero-page poke didn't move `READY.` in testing; C64 banks
  the KERNAL out permanently so main() never really returns to it; CX16's
  text grid is inset from the KERNAL's own screen coordinates and is
  already correct by accident, which a naive PLOT call risked breaking.
  Atari 8-bit, NES and the web target were already honest no-ops, since
  none of them return to a BASIC prompt.
  
  `packages/examples/hello-world`'s entry file is renamed from `main.8bs`
  to `hello-world.8bs` (and calls `text.releaseCursor()` after printing),
  matching the project's own name rather than the generic default.
- Updated dependencies [2288987]
  - @8bitscript/pet@0.10.2
  - @8bitscript/web@0.10.2
  - @8bitscript/input@0.10.2
  - @8bitscript/raster@0.10.2
  - @8bitscript/screen@0.10.2
  - @8bitscript/text@0.10.2
  - @8bitscript/system@0.10.2

## 0.10.1

### Patch Changes

- Updated dependencies [ce9054a]
  - @8bitscript/raster@0.10.1
  - @8bitscript/input@0.10.1
  - @8bitscript/pet@0.10.1
  - @8bitscript/screen@0.10.1
  - @8bitscript/system@0.10.1
  - @8bitscript/text@0.10.1
  - @8bitscript/web@0.10.1

## 0.10.0

### Patch Changes

- Updated dependencies [19b943d]
  - @8bitscript/raster@0.10.0
  - @8bitscript/input@0.10.0
  - @8bitscript/pet@0.10.0
  - @8bitscript/screen@0.10.0
  - @8bitscript/system@0.10.0
  - @8bitscript/text@0.10.0
  - @8bitscript/web@0.10.0

## 0.9.1

### Patch Changes

- @8bitscript/input@0.9.1
  - @8bitscript/pet@0.9.1
  - @8bitscript/screen@0.9.1
  - @8bitscript/system@0.9.1
  - @8bitscript/text@0.9.1
  - @8bitscript/web@0.9.1

## 0.9.0

### Patch Changes

- @8bitscript/input@0.9.0
  - @8bitscript/pet@0.9.0
  - @8bitscript/screen@0.9.0
  - @8bitscript/system@0.9.0
  - @8bitscript/text@0.9.0
  - @8bitscript/web@0.9.0

## 0.8.0

### Patch Changes

- @8bitscript/input@0.8.0
  - @8bitscript/pet@0.8.0
  - @8bitscript/screen@0.8.0
  - @8bitscript/system@0.8.0
  - @8bitscript/text@0.8.0
  - @8bitscript/web@0.8.0

## 0.7.1

### Patch Changes

- @8bitscript/input@0.7.1
  - @8bitscript/screen@0.7.1
  - @8bitscript/text@0.7.1
  - @8bitscript/pet@0.7.1
  - @8bitscript/system@0.7.1
  - @8bitscript/web@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [ea88a5d]
- Updated dependencies [e6c4938]
  - @8bitscript/web@0.7.0
  - @8bitscript/text@0.7.0
  - @8bitscript/screen@0.7.0
  - @8bitscript/pet@0.7.0
  - @8bitscript/input@0.7.0
  - @8bitscript/system@0.7.0

## 0.6.2

### Patch Changes

- Updated dependencies [8e3a326]
  - @8bitscript/web@0.6.2
  - @8bitscript/input@0.6.2
  - @8bitscript/screen@0.6.2
  - @8bitscript/text@0.6.2
  - @8bitscript/pet@0.6.2
  - @8bitscript/system@0.6.2

## 0.6.1

### Patch Changes

- @8bitscript/input@0.6.1
  - @8bitscript/pet@0.6.1
  - @8bitscript/screen@0.6.1
  - @8bitscript/system@0.6.1
  - @8bitscript/text@0.6.1
  - @8bitscript/web@0.6.1

## 0.6.0

### Patch Changes

- 188cd63: `joystick`, the controller test app, ships as the second example: an on-screen map of everything `@8bitscript/input` exposes, lit as it is pressed, so a human can see at a glance whether input works on a machine in front of them.
  
  Six lamps — UP, DOWN, LEFT, RIGHT, CONFIRM, CANCEL — a **SEEN** counter of every press the program has ever been handed, a **FRAME** counter that separates a frozen program from an idle one, and a **KEY/JOY/PAD** line reporting `#fact(input.keyboard)`, `#fact(input.joysticks)` and `#fact(input.pads)` so a dark map can be read as "nothing was pressed" rather than confused with "this layer does not read what this machine has".
  
  A lamp is a **press that was seen, not a control that is held**, and the screen says so. `@8bitscript/input` is edge-triggered by design and offers no level query for directions or buttons (`pointer()` is the only level-triggered call on the surface), so the app latches each edge for 15 frames and draws that as a flash. Holding a direction flashes the lamp once, which is exactly what the API reported.
  
  The highlight is `text.setReverse`, never colour: the PET, the Atari 8-bit and the NES have no per-cell colour at all. Built and screenshotted on all nine targets, plus the PET 8032's 80-column profile. Program bytes, stock hardware, 2026-09-12: pet 2298 (of 3071 on a 4K 2001), vic20 2414 (of 3583 unexpanded), c128 2412, mega65 2436, c64 2571, atari8 2633, cx16 3258, nes 40976 (fixed ROM), web 117 bytes of constant data.
  
  Two things the idle screenshots found, neither fixed here because both are outside this package:
  
  - **The MEGA65 counts one CONFIRM that nobody pressed**, at start-up, once — measured at 300, 600, 1200 and 2400 frames under xmega65. `confirm()` there is RETURN *or* joystick-2 fire, so which one it was decides the fix; a scratch build read CIA1 on the first frame, before `input.poll()`, and found RETURN down (`002`) and the stick clear (`000`), where the identical probe on a C64 and a C128 — same CIA, same addresses, same autostart — read `000`/`000` with SEEN at `00000`. Every layer starts its edge detector with an empty previous-frame snapshot, so anything already held at the first `poll()` reads as a press that just began: the emulator's `RUN` here, a player holding fire as the program loads on real hardware. `begin()` priming the snapshot with one read would close it for every machine at once.
  - **On the Commander X16 a cell printed in reverse cannot be printed back to normal.** `@8bitscript/cx16/text` implements reverse as a swap of VERA's attribute nibbles, and its non-reverse path deliberately keeps the cell's existing background nibble so a print does not undo `screen.setBackground` — but a reverse print has already written the text colour into that nibble. A reverse-video spinner left its whole track lit behind it as one solid bar (x16emu, 2026-09-12); it was replaced by the frame counter. `@8bitscript/ui/menubar` un-inverts a deselected item the same way and looks likely to have the same problem.
  
  What the surface could not express, as design input for widening it: no level query at all (`pointer()` is the only level-triggered call, so a controller map cannot show a control as *held*); `confirm()` is an OR of A-or-START on the NES and RETURN-or-fire on the Commodores, so the app cannot say "A works, START does not"; `SELECT` is unreachable; a direction cannot be traced to the cursor keys rather than the stick; and every layer reads one joystick port where the facts declare two.
  
  `packages/examples/test/examples.test.mjs` now drives both examples from the manifest and links each for all nine targets — the loop was seven, predating the Atari 8-bit and NES native backends.
- Updated dependencies [188cd63]
- Updated dependencies [188cd63]
- Updated dependencies [6e1056b]
- Updated dependencies [b390ef3]
  - @8bitscript/pet@0.6.0
  - @8bitscript/web@0.6.0
  - @8bitscript/input@0.6.0
  - @8bitscript/screen@0.6.0
  - @8bitscript/text@0.6.0
  - @8bitscript/system@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [5754df7]
  - @8bitscript/pet@0.5.0
  - @8bitscript/screen@0.5.0
  - @8bitscript/text@0.5.0
  - @8bitscript/web@0.5.0

## 0.4.1

### Patch Changes

- @8bitscript/pet@0.4.1
  - @8bitscript/screen@0.4.1
  - @8bitscript/text@0.4.1
  - @8bitscript/web@0.4.1

## 0.4.0

### Patch Changes

- @8bitscript/pet@0.4.0
  - @8bitscript/screen@0.4.0
  - @8bitscript/text@0.4.0
  - @8bitscript/web@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [001c7e7]
  - @8bitscript/web@0.3.0
  - @8bitscript/screen@0.3.0
  - @8bitscript/text@0.3.0
  - @8bitscript/pet@0.3.0

## 0.2.6

### Patch Changes

- @8bitscript/pet@0.2.6
  - @8bitscript/screen@0.2.6
  - @8bitscript/text@0.2.6
  - @8bitscript/web@0.2.6

## 0.2.5

### Patch Changes

- @8bitscript/pet@0.2.5
  - @8bitscript/screen@0.2.5
  - @8bitscript/text@0.2.5
  - @8bitscript/web@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies [7e28950]
  - @8bitscript/pet@0.2.4
  - @8bitscript/screen@0.2.4
  - @8bitscript/text@0.2.4
  - @8bitscript/web@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [d58bf12]
  - @8bitscript/pet@0.2.3
  - @8bitscript/screen@0.2.3
  - @8bitscript/text@0.2.3
  - @8bitscript/web@0.2.3

## 0.2.2

### Patch Changes

- @8bitscript/pet@0.2.2
  - @8bitscript/screen@0.2.2
  - @8bitscript/text@0.2.2
  - @8bitscript/web@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [b48b19b]
  - @8bitscript/pet@0.2.1
  - @8bitscript/screen@0.2.1
  - @8bitscript/text@0.2.1
  - @8bitscript/web@0.2.1

## 0.2.0

### Minor Changes

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
  - @8bitscript/pet@0.2.0
  - @8bitscript/screen@0.2.0
  - @8bitscript/text@0.2.0
  - @8bitscript/web@0.2.0
