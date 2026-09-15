---
title: "8bx: a responsive component format"
nav_order: 85
---

# 8bx: a responsive component format

Design direction for a declarative UI layer on top of 8BitScript, written
against what the repository already does rather than from first principles
— the same way [Controllers, across nine machines](input.md) is. Nothing
described here compiles yet. `.8bx` is not a package, a front end, or a
parser rule today; this page is what it should become before any of those
are written, so the shape gets agreed once rather than three times.

It also has to fit a moving foundation: 0.2.0 builds only `pet` and `web`
end to end (see [the home page](../index.md)); the other seven machine
packages exist in the workspace, parked and refused by name, and return
one phase at a time. Nothing below is a claim that a component renders on
a C64 today. It is a claim about what the same `.8bx` source should become
once C64 comes back.

## What already exists that this builds on

Four things already in the repository do most of the work a naive design
would reinvent.

**An immediate-mode component model.** `@8bitscript/ui/menubar` is the one
component that exists, and its `AGENTS.md` states the rule plainly: *"A
component holds no list of what it contains. The caller runs the calls
that draw it, in order, every time... Nothing in a component allocates."*
This is not a constraint `.8bx` works around — it is the compile target
`.8bx` has to lower into. See "Components compile away" below.

**A fact table that already answers most "responsive" questions.**
`packages/compiler/src/fold/facts.mjs` resolves `video.columns`,
`video.bitmap`, `video.sprites`, `video.layers`, `video.colorPerCell`, and
more, before any target toolchain runs, and `@8bitscript/system` gives
each one a const (`Video.COLUMNS`). A branch on a fact the machine lacks
folds to nothing — the root `AGENTS.md` measures a menu bar at 455 bytes
with its layout precomputed the way a compiler could, versus 809 for a
library that works the layout out at run time: 354 bytes is "the price of
doing the arithmetic at the wrong time," not a feature. `.8bx`'s "narrow
vs. wide" and "bitmap vs. tile"
questions are `video.columns` and `video.bitmap` questions, not a new
capability language.

**Two ways an answer differs by build, not by branch.** Where a fact is
`build`-time (fixed by the machine and hardware chosen, true for the whole
run), a program branches on it and the compiler deletes the losing arm.
Where a fact is `run`-time (a mouse plugged in, a REU present — see
[Controllers, across nine machines](input.md#what-already-exists)), the
branch compiles for real and asks at run time. Separately, where two
targets need structurally different *files*, not just different numbers,
the repo uses file-twin tags: `geometry.pet.8032.8bs` beside
`geometry.8bs`, selected by the hardware value's tag, never by a runtime
probe (root `AGENTS.md`, "machine" vs. "hardware fitted to it"). `.8bx`
needs both mechanisms, for different tiers of "responsive" — see below.

**Compile-time layout, already precedented.** A template —
`` text.print(0, `TICK ${ticks:1}`) `` — is laid out during compilation
into `print` and `printNumber` calls with every cell worked out in
advance; nothing formats at run time. A `.8bx` component tree is a bigger
version of the same move: source that describes a shape, compiled into
the calls that draw it.

## Components compile away

The tension to resolve first: `@8bitscript/ui` is explicitly not a widget
tree, and a JSX-shaped `.8bx` component reads like one. It only avoids
being one if the compiler fully unrolls it — the root rule again, *"if the
compiler can do it, the compiler does it."*

```
component MainMenu {
    state selected: utinyint = 0

    return (
        <Stack direction="vertical" gap={1}>
            <Button selected={selected == 0}>START</Button>
            <Button selected={selected == 1}>OPTIONS</Button>
        </Stack>
    )
}
```

lowers — at compile time, at every call site, not once into a shared
function a vdom walks — into the same shape a hand-written program would
write against `@8bitscript/ui/menubar` today:

```
menubar.select(selected);
menubar.begin(0, text.COLUMNS);
menubar.item("START");
menubar.item("OPTIONS");
menubar.end();
```

(A vertical stack of two selectable items is a menu bar turned sideways;
the actual lowering target for a general `<Stack>`/`<Button>` tree is a
family of calls like this, not necessarily `menubar` itself — the point is
the *shape* of the output, a straight-line run of calls with no list kept
anywhere, not this specific pair of functions.)

**`state` is not retained-tree state.** `selected: utinyint = 0` above has to
compile to one static variable, sized and placed the way any other
8BitScript global is — not an object a reconciler diffs. That keeps it on
the same footing as `nothing in a component allocates`: a `.8bx` component
can hold state, same as a hand-written `.8bs` program holds state in a
variable, but it cannot hold a *tree*.

**`<Show>`/`<Fallback>` are `#fact(...)`, not a new primitive.** The
ChatGPT conversation's `capability("sprites")` is `#fact(video.sprites)`
resolved the existing way — folded before any target toolchain runs, the
losing arm deleted, refused by name where a target genuinely cannot do it.
`.8bx` should not invent a second capability vocabulary beside the one the
compiler already owns.

## Two responsive tiers, not one

### Tier 1 — resolved at compile time, every target including web's skins

For the nine machines (parked or not) and for web's own fixed-grid skins
(`geometry.web.c64.8bs`, `geometry.web.pet-2001.8bs`, ...), "responsive"
means: the same `.8bx` source, compiled once per target, picks its layout
from that target's facts.

```
<Stack
    direction={Video.COLUMNS >= 80 ? "horizontal" : "vertical"}
>
```

reads exactly like the `HAS_MOUSE` example in
[Controllers, across nine machines](input.md#what-already-exists): a
constant on every build, an `if` that is `if (true)` or `if (false)`
before the 6502 ever sees it. A PET 8032 build and an unexpanded VIC-20
build of the same `.8bx` file produce different, fixed sequences of calls
— not a program that measures its own screen.

One caution the fact model doesn't remove: *"a branch is not a conditional
import — both arms of an `if` are compiled and linked on every machine"*
(`packages/system/src/index.8bs`). A `.8bx` layout branch has to choose
between arrangements of the same portable components on every arm, never
between a portable component and a machine-specific package — that would
break the parked machines' build the moment the branch's dead arm still
had to link. Where two targets need a structurally different *file*, not
a different arrangement, that is the file-twin tag mechanism
(`geometry.pet.8032.8bs`), not a branch — and `.8bx` should get the same
per-target-file affordance for a layout that cannot be expressed as one
source arranging itself, rather than growing its `if` arms without limit.

### Tier 2 — the web, fluid

Today `packages/web/AGENTS.md` is explicit that the web target is one more
fixed-geometry skin: *"the web target proves semantics, never fit"* — a
48×27 grid, or a C64/PET/VIC-20 skin, each its own wasm build, idealized
rendering, no simulated resize. That is a deliberate decision, not an
oversight, and it is the opposite of "twist and turn your device and get a
great experience" — and it is the piece `.8bx` is explicitly meant to add,
not defer: a real fluid mode is in scope for the format's first design,
alongside Tier 1, not behind it.

That makes this a real addition to `packages/web/AGENTS.md`, not a
reframing of what it already says: a **fourth case**, named and specified
there beside "what exists today" and "the reference target," once it is
designed rather than assumed. Two constraints shape what that design has
to satisfy:

- **The viewport is a `run` fact, not a `build` fact.** Window size isn't
  knowable at compile time the way `video.columns` is on a PET. It belongs
  in the same family as `input.mouse` and `input.paddles` — detectable,
  not foldable — which means fluid web is the one target where `.8bx`
  cannot fully honor "if the compiler can do it, the compiler does it,"
  and needs a real, small, named runtime layout step. `.8bx`'s compiler
  contract has to state that exception explicitly rather than let every
  target's docs imply it never happens.
- **The other eight targets must not pay for it.** Whatever runtime layout
  resolver a fluid web build links, a PET build must not carry a single
  byte of it. The existing pattern for that is "each value its own wasm,
  never one binary switching `#system()`" — a fluid web build is a new
  build variant of the `web` target, not a code path inside the one that
  exists today.

Naming it as a first-class tier here, rather than a later phase, is a
decision, not a hedge — it means the compile-time fact model and the
file-twin mechanism in Tier 1 have to be designed from the start to
coexist with a target whose defining fact (window size) cannot be folded,
rather than retrofitted once one exists. The open questions below name
what that design still has to answer.

## Where this sits in the compiler

`packages/compiler/src` today is lexer → parser → fold → checker → IR →
backends (`mos`, `wasm`), each a pure function over the prior layer's
output, and **one front end, hardcoded to `.8bs`** — there is no
multi-extension mechanism yet. The shape that keeps the rest of the
pipeline untouched: `.8bx` gets its own lexer/parser that lowers a
component tree into the *same* AST node shapes `.8bs` already produces
(the unrolled call sequences above), feeding into fold exactly the way a
hand-written `.8bs` file does. `fold`, `checker`, `ir`, and both backends
should not need to know `.8bx` exists.

The front-end rules already in force apply without exception: a front end
must never throw (diagnostics plus recovery, because an editor runs it
every keystroke) and spans must come from tokens, not be recomputed —
`packages/compiler/AGENTS.md` covers both.

One thing not to under-scope: per the root `AGENTS.md` (L234-287 as of
this writing), a change to a core language layer — and a new front end is
one — lands with `docs/compiler.md`, `docs/language-server.md`,
intellisense hover and its test, a language-server e2e test, VS Code
syntax/snippets/language-configuration, and the relevant
`packages/<target>/AGENTS.md`, **in the same commit**. A `.8bx` front-end
scaffold is that size of change the day it starts producing AST nodes, not
a follow-up.

## Open questions

Left open on purpose — this page is the direction, not the RFC:

- **Concrete `.8bx` grammar.** The examples above are illustrative; actual
  token/parse rules, attribute syntax, and how far it borrows from JSX
  (self-closing tags, expression braces) are unsettled.
- **Which existing components `.8bx` targets first.** `menubar` is the
  only one that exists; a `<Stack>`/`<Button>` vocabulary needs either new
  `@8bitscript/ui` components under it or a defined lowering straight to
  `@8bitscript/text` primitives.
- **How far component-local `state` can go** before it stops being "one
  static variable" and starts being a data structure the compiler can't
  size — arrays of dynamic length are the obvious edge, and the language
  doesn't have those today, so this may resolve itself, but should be
  checked against whatever `state` construct lands.
- **The fluid web architecture itself** — DOM-based reflow versus a
  canvas with its own layout pass, and whether it shares the `wasm`
  backend at all or needs a distinct one. Tier 2 above names the
  constraints, not the design.
- **Whether `.8bx` is a `packages/compiler` front end or a pre-pass CLI
  transform** that emits `.8bs` and hands it to the existing pipeline
  unmodified. The former keeps diagnostics and spans native to the
  original `.8bx` source (better editor experience); the latter is far
  less invasive to build first. Worth prototyping both before committing.
