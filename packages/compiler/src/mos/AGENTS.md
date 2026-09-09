# The 6502 backend's calling convention

This file is for anyone touching `packages/compiler/src/mos` — specifically
function calls. Read [`packages/compiler/AGENTS.md`](../../AGENTS.md) and the
root [`AGENTS.md`](../../../../AGENTS.md) first. Milestone 7 on the "Hello,
PET" roadmap (the compiler's own working doc) is what settled everything
below; this file is that decision, written down once rather than re-derived
per PR.

## The convention

> **Every parameter, and every local, gets a fixed zero-page slot the
> callee owns. There is no register-argument special case. A function's
> 8-bit return value comes back in `A`. No recursion.**

The roadmap originally sketched "first 8-bit argument in `A`, the rest in
zero-page slots." That does not survive contact with the code this backend
actually has to compile: `place(cell: usmallint, code: utinyint)` and
`putChar(cell: usmallint, code: utinyint)` — the PET text package's own
functions, real code, not a hypothetical — both take a **16-bit first
argument**, and `A` is eight bits. A register special case that only fires
when the first parameter happens to be exactly one byte wide would help a
minority of real calls (`asciiToScreenCode`, `toScreen`, `patternIndex` do
have an 8-bit first/only parameter; `place`, `putChar`, `locate`,
`setVramAddress`, `fillRun`, `transfer` do not) and adds real complexity —
conditional codegen at every call site, and an argument-evaluation-order
interaction once a later argument's own evaluation needs the accumulator.
All-zp, uniformly, is the simpler answer and the one the evidence actually
points to.

**Parameters are not locals, and their addresses are call-site-visible
before any function's body is lowered.** A caller storing an argument into
a callee's parameter slot needs to know that slot's address, but nothing
about how many locals or expression temporaries the callee's *body* will
turn out to need — that is only known after lowering it, and lowering it
might itself contain calls to functions whose own addresses aren't known
yet either. Splitting these into two passes removes the ordering problem
entirely:

1. **Parameter pass** (`mos/index.ts`, before any lowering): walk
   `ir.functions` once, assigning each function's own parameters one
   contiguous zp byte apiece, in declaration order — sized only from
   `fn.params.length`, which needs no lowering to know. This produces a
   `Map<name, FunctionSite>` (`label`, `paramAddresses`, `returnType`)
   naming every function's calling interface before a single instruction is
   selected.
2. **Body pass**: lower every function in `ir.functions`, each against a
   **fresh `LocalAllocator`** whose origin starts wherever the previous
   function's own locals/temporaries region ended — every function's
   locals and expression temporaries live in a region no other function's
   ever touches. A parameter is bound into the callee's own symbol table at
   the very start of its `Lowerer`, at its pre-assigned fixed address,
   exactly the way a `local` statement binds a name — the only difference
   is a parameter's address comes from pass 1, not `this.locals.alloc()`.

A call site (`callSite()` in `lower/index.ts`) evaluates each argument
left-to-right (the milestone 6 decision this backend already holds itself
to) and stores it straight into the callee's corresponding parameter
address, then emits `JSR` to the callee's label. The callee's own `return`
— bare or with a value — jumps to its own `exitLabel`, exactly as a bare
`return` already did before this milestone; a function's own top-level
`lower()` result is wrapped in `[label(fn), ...program, RTS]` by
`mos/index.ts` (the entry function instead gets `[prologue, ...program,
epilogue]`, unchanged from milestone 1). Nothing about `if`/`while`/`for`/
`break`/`continue` changes: `return <value>` differs from a bare `return`
only by evaluating the value into `A` first — the existing "every
value-producing rule leaves its result in the accumulator" rule already
puts it exactly where the caller expects it back.

## Why no cross-function zp reuse (yet)

Every function's parameters and locals get their **own**, never-shared zp
bytes — not just non-overlapping with a function's *own* live range, which
`LocalAllocator`'s LIFO scheme already guarantees, but non-overlapping
across every *other* function too. This is the naive, obviously-correct
choice this project's own root `AGENTS.md` calls for first ("tree-walk
codegen with zero-page temporaries first... a real allocator waits until
measured size is what stops a program fitting"), not a claim that it's the
final design. A call-graph-aware allocator that lets two functions which
can never be simultaneously on the call stack share the same bytes would
raise the real function-count ceiling on a 114-byte budget — worth building
once a real program's byte count says this is what's actually stopping it
from fitting, not before.

**Why this is even safe: no recursion, enforced, not assumed.** Reusing a
fixed physical zp address across nested calls is only sound if a function's
own frame is never live twice at once on the call stack — i.e., the call
graph is a DAG. `mos/index.ts` walks `ir.functions`' own call graph and
refuses to build, naming the cycle, if any function (transitively) calls
itself. This is not a hypothetical hardening — without it, a recursive
function would silently miscompile: the inner call's `STA` into a parameter
slot would clobber the outer call's own copy of the same slot mid-flight,
producing a wrong answer with no diagnostic at all, the exact failure mode
this project's `AGENTS.md` files exist to rule out by name.

## What's still out of scope after milestone 7

- **Array parameters.** Refused by name; nothing on the PET's own critical
  path calls a function with one yet, and array *storage* itself is still
  milestone 9's problem for anything beyond a `const`.
- **Dead-function elimination.** Every function in the linked `ir.functions`
  gets lowered and placed, called or not — a known-conservative choice
  (spends zp and program bytes on unreachable code) worth revisiting once a
  real program's size says it matters, not before.

## Milestone 8: 16-bit values

`place`/`putChar`'s own `cell: usmallint` parameter was exactly why
milestone 7's own gate wasn't the real `text.putChar` — this milestone is
what closes that gap. A `usmallint` (or `smallint`) is a zp pair
(`address`, `address + 1`, little-endian); 16-bit parameters, locals,
assignment, `+`/`-`, and unsigned ordering/equality comparisons are all
lowered, and a `memoryWrite` whose address is no longer a compile-time
literal — a real computed address — lowers to `STA (zp),Y`. 16-bit
**return values** stay refused by name; nothing on the PET's own critical
path returns one yet (`place`/`putChar` are both `void`), so widening
`callSite()`'s single-byte "return comes back in A" assumption waits until
something actually needs it.

**Why a second path (`expr16()`) instead of widening `expr()` itself.**
Every existing 8-bit rule leaves its result in the accumulator — a real
register, one byte wide. A 16-bit value has nowhere in a register to live,
so either every rule gets rewritten to return a location descriptor (`{kind:
'A'} | {kind: 'zpPair', address}`), or a new, narrower path handles exactly
the 2-byte case and everything already built for 1 byte stays untouched.
The second is less code, touches nothing already tested and
screenshot-verified, and matches how this backend already grew —
`callSite()` (milestone 7) didn't rewrite `expr()` either, it slotted
alongside it. `expr16()` leaves its result at a zero-page address it
*returns*: a `ref` returns an existing binding's own address unchanged (no
copy for a plain read); a `const` or a `binop` allocates a fresh zp-pair
temp, fills it, and returns that. `binop16` allocates its result pair
*before* taking the mark that guards its operands' own temporaries — the
operands may themselves recurse into `expr16()`/`binop16` and allocate (and
release) further temps above that mark, but the result has to outlive the
call that produced it, so it can't be something a `release()` inside that
same call would free. Every caller that might see either width —
`memoryWrite`'s address, a comparison's operands — checks
`storageBytes(node.type)` itself and picks `expr()` or `expr16()`; there is
no auto-dispatch inside `expr()`.

**Widening at a 16-bit boundary: `exprTo16()`.** A call argument, a
`local`'s initializer, and a plain `assign`'s value are different from the
callers above: they have a *declared* 16-bit destination (a parameter, a
local's own type, an existing binding's type) that the *source* expression
doesn't have to match already. Checked directly against real code while
building this milestone's own gate: `place(5, 24)` — cell `5`, an entirely
ordinary literal — failed to build, because nothing in the front end
widens a narrower value to match a wider declared target (verified against
`ir/index.mjs`: a call argument's own IR node keeps whatever
`narrowestIntegerType()` gave it, with no coercion node inserted, and
that's true of a `local`'s initializer and a plain assignment's
right-hand side too). Refusing that would make the single most ordinary
call in this whole exercise — `text.putChar(0, 65)` — fail to build.
`exprTo16()` is the fix: it accepts either width, and for a narrower
**unsigned** source, evaluates it through `expr()` and zero-extends into a
fresh zp pair (`STA` the value, `LDA #0`/`STA` the high byte) — exact for
every unsigned type this backend lowers, since a `utinyint`'s whole range
already fits inside a `usmallint`. A narrower **signed** source is refused
by name instead: sign-extension replicates the sign bit into the high byte
rather than clearing it, a different instruction sequence, and nothing on
the PET's own critical path needs one yet. `bool` is refused the same way
— the checker should already rule out assigning a bool to a `usmallint`
before this backend ever sees it, so this is a defensive refusal, not a
construct expected to actually occur. These three callers use
`exprTo16()`; `memoryWrite`'s address and a comparison's operands still use
plain `expr16()` and stay exact-width-or-refuse (see the comparison
paragraph below) — a computed address or a comparison operand isn't a
"destination" a narrower source could sensibly widen into.

**16-bit `+`/`-`.** The standard multi-byte 6502 idiom: one `CLC`/`SEC`,
then `ADC`/`SBC` low byte, then `ADC`/`SBC` high byte — the carry (or
borrow) chains from the low half into the high half by construction,
because `CLC`/`SEC` only runs once. Comparisons reuse the exact same
`ORDER_BRANCH_IF_TRUE` branch-selection table the 8-bit path already has:
`LDA right; CMP left; LDA right+1; SBC left+1` sets the same C/Z flags a
16-bit `right - left` subtraction would, `CMP`'s own carry becoming
`SBC`'s borrow-in directly — so the table built for the 8-bit case (whose
own header comment already documents "CMP's flags end up describing
`right - left`, not `left - right`") applies unchanged at 16 bits too. A
mixed-width comparison (one side 8-bit, the other 16) is refused by name,
not zero-extended — nothing on the PET's own critical path needs one yet,
and silently widening the narrower side is a guess about which representation
(zero-extend? sign-extend, once signed 16-bit values exist?) the language
should pick, not this backend's call to make alone.

**A computed `memoryWrite`.** The address evaluates through `expr16()`
into a zp pointer pair *before* the value evaluates — so the value's own
temporaries, allocated afterward from wherever the allocator's cursor
already sits, can never land inside the pointer's own two bytes — then `Y`
is forced to `0` and the store goes through `STA (zp),Y`. `Y` is scratch
this store owns outright: nothing else in this backend reads or holds `Y`
live across a `JSR`, and nothing should start doing so without updating
this note — the same "state a register lives in" discipline the calling
convention above already holds `A` to.

**Gate, reframed again.** The roadmap's own milestone 8 box says "the PET
`text.putChar` compiles unchanged and prints at cell 999." It doesn't,
yet — not for a 16-bit reason. `@8bitscript/pet/text` also declares `const
DIGIT_PLACES: array<usmallint, 5>` at module scope (for `printNumber()`),
array globals aren't allocated yet (milestone 9's job), and importing the
module pulls in every one of its globals regardless of which function is
actually called — so even the already-shipped `hello-world` example
(`text.print`, nowhere near `printNumber`) fails to build on the PET
**today, unmodified, on trunk**, before this milestone touched anything.
Same move as milestones 3, 6, and 7: the gate is `place()`, reproduced
byte-for-byte from the real `text.8bs` source (minus the `toScreen()` call
— already fully exercised by milestone 7's own call-convention gate,
nothing about it is 16-bit), called with `cell = 999` — past the 8-bit
boundary, landing at the PET's very last screen cell (row 24, column 39 on
the 2001's 40-column profile) if the 16-bit index is real, and nowhere
useful if it silently wrapped to an 8-bit one. Run for real (`8bs build
--target pet --hardware model=2001` then `8bs run pet --hardware
model=2001 --screenshot`, no `--frames` override — the default cycle
budget, not a guessed one): the character lands exactly there. A second,
differential run (`a: usmallint = 511; b: usmallint = 300; place(a + b,
...)`) checks the low-byte-carry path specifically: the correct sum (811)
and the sum a dropped carry would produce (555) land at visibly different
cells, and the character lands at 811's. Neither screenshot is committed
(no earlier milestone's is either).
