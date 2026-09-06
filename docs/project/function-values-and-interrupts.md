# Function values and interrupt handlers — design

Status: **design, not built.** This note specifies a language feature and
the decisions it needs, grounded in a survey of every file it touches
(2026-09-06). It exists so the feature can be implemented in one focused
session from a plan, not discovered file by file. Nothing here is in the
compiler yet.

## Why

8bitscript has no way to name a function as a value. A program cannot say
"run this code when the raster reaches line 100." That is why
`@8bitscript/c64/raster` is a *list of register writes* applied by an
assembly handler the package ships, not a handler a program writes: the
list can change a colour or a scroll register at a line, but it cannot run
a program's own logic there. Multiplexing more than eight sprites, a
music player ticking on a timer, a split that computes its next colour —
all want a function that runs at an interrupt.

Two features, related but separable:

1. **Interrupt handlers** — a function marked so the compiler emits it as a
   6502 interrupt routine (ends in `rti`, saves registers), and a way to
   install it at a CPU vector. This is the near-term need.
2. **First-class function values** — a function used as an ordinary value:
   function-typed variables and parameters, and calls through them. Larger,
   and not required for the raster use case. **Deferred** (see Phase 4).

## The conflict this must resolve first

Every C64 program in this repo runs with **interrupts off from the first
`waitFrame()` or the first draw** — `FRAME_SYNC.c64.presync` is `sei`, and
`setupVideo()` runs `sei` too. The reason is real: the KERNAL's own IRQ
scans the keyboard through the same CIA ports a game reads, and the frame
driver polls the raster rather than taking an interrupt. "The program owns
the machine" is the C64 target's founding invariant
(`packages/c64/AGENTS.md`).

A handler written in 8bitscript that runs at an interrupt means:

- **Interrupts are on.** The frame driver's `sei` would block it. So
  enabling a handler is not a library call a program makes freely; it
  changes the driver's contract.
- **The handler and mainline share globals with no atomicity.** 8bitscript
  globals are plain memory. An IRQ landing between the two byte-writes of a
  `u16` store leaves the handler reading half of each. Byte-wide state is
  safe; anything wider is a hazard the language does not today express.
- **The compiler owns zero page `$02`–`$8F`.** A handler that is a normal
  compiled function uses zero page for its own temporaries, and so does the
  code it interrupted. `__attribute__((interrupt))` on llvm-mos saves and
  restores what it uses, but the *soft stack* and imaginary registers are
  shared; this needs verifying under VICE, not assuming.

This is the design's center, not a footnote. **Recommendation:** the first
version supports the model where a program installs one `@interrupt`
function as the whole IRQ handler and takes over from the frame driver's
polling — an explicit, all-or-nothing opt-in — rather than pretending a
handler can be dropped into a polling program for free. `@8bitscript/c64/raster`
would grow a variant of `enable()` that installs an 8bitscript handler at
`$FFFE` instead of its shipped assembly one, and the handler does its own
`$D019` acknowledge and register work. The frame driver and a program's
own IRQ handler are then two ways to structure a program, chosen once, not
mixed.

## Syntax and types

```
// A function the compiler emits as an interrupt routine: no parameters,
// returns void, cannot be called directly, ends in rti.
@interrupt function onRaster(): void {
    interruptStatus = 0x01;        // acknowledge $D019
    borderColor = borderColor + 1;
}

// A CPU vector: two bytes holding a handler's address.
@address(0xFFFE) let irqVector: interrupt;

export function main(): void {
    irqVector = onRaster;          // store onRaster's address at $FFFE
    // ... enable the source, cli ...
}
```

- **`interrupt`** is a new type: a 16-bit value that is the address of an
  `@interrupt` function. An `interrupt`-typed global is two bytes (a
  vector). The only value assignable to it is the name of an `@interrupt`
  function. It is not arithmetic, not comparable, not printable.
- **`@interrupt`** is a decorator on a function declaration. The function
  takes no parameters, returns `void`, and may not be called by name
  (`onRaster()` is an error — the hardware calls it). It may be assigned to
  an `interrupt` variable, which is how its address is taken.
- **Web target:** `@interrupt` and the `interrupt` type are a
  `targetLimitation` refusal (`{ ok: false }`, the way `@address` scalars
  already are on web), not a diagnostic. There is no interrupt to install
  in the worker runtime.

Full function values (`let f: (x: u8) => bool`, function-typed parameters,
`f(3)` through a variable) are a **separate, later** feature (Phase 4). The
`interrupt` type is deliberately narrow so the near-term feature does not
wait on the general one.

## The three semantic decisions (from the survey)

1. **Close the silent-decorator hole first.** `ir/index.mjs`'s `function()`
   never reads `node.decorators`, so `@interrupt function f() {}` today
   compiles `f` as an ordinary function and drops the decorator with no
   error — unlike globals, arrays and locals, which reject an unknown
   decorator. Fix this regardless: an unknown decorator on a function is
   `8BS3001`, like everywhere else. This is a correct bug fix on its own and
   is Phase 0.

2. **Gate function-name-as-value on the `interrupt` type.** A function name
   in expression position already lowers to `{kind:'ref'}` and links clean
   today (it emits a bare C identifier), diagnosed only in a global
   initialiser. Do **not** open this generally. A function name is a value
   only where an `interrupt` variable is assigned it; everywhere else a
   function name as a value stays `8BS3001`. This keeps Phase 4 (general
   function values) a real, separate decision rather than something that
   leaks in early.

3. **Register the new type id before touching backends.** `interrupt` must
   be known to `resolveScalarType`, `scanDeclaredTypes` and `parameterTypes`
   in `packages/compiler/src/templates/index.mjs`, or `declares()` treats an
   `interrupt` global as an import across six IR sites and misbehaves
   silently. Give it a storage size of 2 in `storageBytes` (`types/index.mjs`),
   `C_TYPE`/`C_SIZE` (backend-6502), and the web `AS_TYPE` refusal path.

## Code generation

**6502** (`packages/backend-6502/src/index.mjs`):

- `@interrupt` function → `__attribute__((interrupt))` on the signature
  (the `section()` helper at ~:780 is the precedent for attaching
  attributes). The handler must not be `static`-and-dead: nothing *calls*
  it, so LLVM would delete it — mark it `__attribute__((used))` or give it
  external linkage, the same problem `namedInAsm` already solves for
  functions named in `asm6502`.
- `interrupt`-typed `@address` global → the existing `#define name
  (*(volatile uint16_t *)0xADDR)` form, with `C_TYPE.interrupt =
  'uint16_t'`.
- `irqVector = onRaster` → the assignment needs the right side to emit
  `(uint16_t)(uintptr_t)onRaster`, a cast a bare `{kind:'ref'}` does not
  produce. Either a new expression kind (`funcaddr`) or a flag on `ref`.
  `cName` must be applied to a function ref too, or a handler named `main`
  would emit `main` rather than `__8bs_main`.
- Ordering: globals (including the `#define` vector) are emitted before
  function prototypes, which are before bodies. A function address in a
  *global initialiser* would be emitted before the prototype and fail to
  compile; the vector is written in `main`, not at global scope, so this is
  fine — but the checker must forbid an `interrupt` global with an
  initialiser (like other `@address` globals already are).

**Web** (`packages/backend-web/src/index.mjs`): refuse via the
`targetLimitation` pattern (the `asm` case at ~:160 is the template).

## Interaction with `@8bitscript/c64/raster`

Once the feature exists, the raster package gains an install path that
points `$FFFE` at an 8bitscript `@interrupt` function instead of its
shipped assembly handler (`native/6502/raster.s`). The handler then does
its own acknowledge and register work in 8bitscript. Both stay: the
write-list handler for programs that only need register changes at lines
(no language feature required), the 8bitscript handler for programs that
need logic there. The AGENTS.md rule about windows under the I/O area
applies unchanged — a handler must not open one, or it acknowledges into
RAM and loops forever, exactly as documented.

Atomicity: the handler and mainline share globals. Until the language
expresses "read/write this without an interrupt landing in the middle,"
document that handler/mainline shared state should be one byte wide, and
that a wider value needs the mainline to guard its writes (disable the
source, write, re-enable). A `critical { ... }` block that brackets code
in `sei`/`cli` is the natural future companion to this feature; note it as
an open question, do not build it here.

## Phased implementation plan

Each phase is green on its own; the checklist in the root `AGENTS.md`
(docs, intellisense, LSP tests, VS Code plugin) applies to every phase that
adds syntax or a diagnostic.

- **Phase 0 — close the hole.** `function()` in `ir/index.mjs` rejects an
  unknown decorator (`8BS3001`). Update `functions.test.mjs`. No new syntax.
- **Phase 1 — the `interrupt` type.** Add `interrupt` to `TYPE_NAMES`
  (lexer), `resolveScalarType`/`scanDeclaredTypes`/`parameterTypes`
  (templates), `storageBytes` (types), `C_TYPE`/`C_SIZE` (6502), the web
  refusal. An `interrupt` global is a 2-byte vector; an initialiser on one
  is refused. Hover (`CONSTRUCT_DOCS.interrupt`), tmLanguage primitive rule,
  `docs/compiler.md` type table and diagnostic notes, an LSP hover test.
- **Phase 2 — `@interrupt` functions.** The decorator is recognised on a
  function (not "not compilable yet"); the function must be parameterless
  and `void`; a direct call to it is an error; it is emitted with
  `__attribute__((interrupt))` and kept live. `@interrupt` hover, snippet
  (widen the `snippets.test.mjs` wrap regex to allow an `@interrupt`
  prefix), tmLanguage already colours `@name`.
- **Phase 3 — assign a handler to a vector.** A function name is a value
  only as the right side of an assignment to an `interrupt` variable; emit
  the address cast. `raster` gains the 8bitscript-handler install path;
  verify under VICE with a probe (a handler that changes the border at a
  line, read by pixel, the `test/layers.test.mjs` pattern). Verify zero-page
  and soft-stack safety under the remote monitor before calling it done.
- **Phase 4 — general function values (separate feature, separate note).**
  Function-typed variables and parameters, `() => T` annotations, indirect
  calls, a dispatch model on the web target. Only if a real use appears;
  the interrupt vector does not need it.

## Tests to update (they pin current behaviour)

- `packages/compiler/test/functions.test.mjs`: `params` deep-equal shape
  (:35), the unsupported-parameter-type gate (:61), the "does not run
  lower()" comment (:22, already stale — `analyze` does lower).
- `packages/language-server/test/server.test.mjs`: the `ptr` "not
  compilable yet" message (:439) must keep failing — `ptr` is not this
  feature.
- `packages/compiler/test/snippets.test.mjs`: the top-level wrap regex
  (:55) needs `@interrupt` (and any new prefix) added.
- `packages/compiler/test/intellisense.test.mjs`: the "every spelling has
  hover" iteration — add `interrupt` with its `CONSTRUCT_DOCS` entry or it
  is hover-less.
- `editors/vscode/test/grammar.test.cjs`: add an `interrupt` assertion to
  the primitive-type rule.

## Open questions

1. **Frame driver coexistence.** Does a program with an 8bitscript IRQ
   handler still call `waitFrame()`? If the handler is the whole IRQ, the
   frame driver's polling loop and its `sei` need to stand down. Decide
   whether `raster.enable()` with a handler implies "no `waitFrame()`," or
   whether a handler can tick alongside polling with interrupts briefly
   enabled. This is the one question that most shapes the feature.
2. **Atomicity primitive.** A `critical { }` block (bracketed `sei`/`cli`)
   is the natural companion. Design it with, or right after, Phase 3.
3. **NMI vs IRQ.** `$FFFA` (NMI, the RESTORE key) as well as `$FFFE`? The
   package already points both at a bare `rti`. An `@interrupt` NMI handler
   is the same feature at a different vector.
4. **Other 6502 targets.** NES (`$FFFA` NMI at vblank is how it already
   works, via `frameHook` — reconcile), Atari (`sei` does not stop its OS
   VBI), X16. The `interrupt` type is 6502-general; the *install* is
   per-machine.
