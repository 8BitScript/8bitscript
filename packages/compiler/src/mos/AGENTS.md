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

## What's still out of scope this milestone

- **16-bit parameters, locals, and return values.** `place`/`putChar`'s own
  `cell: usmallint` parameter is exactly why milestone 7's own gate is
  **not** the real `text.putChar` — see the roadmap's milestone 8 box
  ("the PET `text.putChar` compiles unchanged and prints at cell 999"):
  that function only becomes buildable once 16-bit values exist at all.
  Milestone 7's own gate is a hand-written, 8-bit-only `putChar(cell:
  utinyint, code: utinyint)` restricted to row 0 — enough for HELLO WORLD,
  honest about what it proves. A function whose parameter or return type
  isn't exactly one byte (and isn't `void` for a return) is refused by
  name, the same exhaustive-with-error contract every earlier milestone
  holds to.
- **Array parameters.** Refused by name; nothing on the PET's own critical
  path calls a function with one yet, and array *storage* itself is still
  milestone 9's problem for anything beyond a `const`.
- **Dead-function elimination.** Every function in the linked `ir.functions`
  gets lowered and placed, called or not — a known-conservative choice
  (spends zp and program bytes on unreachable code) worth revisiting once a
  real program's size says it matters, not before.
