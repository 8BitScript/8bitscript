# Writing @8bitscript/ui

This file is for anyone — human or agent — adding a component to
`packages/ui` or changing one. Read the root [`AGENTS.md`](../../AGENTS.md)
first; its rules apply here without exception, and the one that bites
hardest is the first: **abstract concepts, expose constraints.** A component
that hides a machine's limit does not make the limit go away, it makes the
program wrong on that machine and silent about it.

## What this package is

`@8bitscript/ui` is the interface components a program builds a screen out
of: a menu bar today, and whatever a program needs after that. A component
is ordinary 8BitScript that draws through the portable capability packages
— `@8bitscript/text` for now — so it works on every target for the same
reason a program does, not because it has nine implementations.

That is the line between this package and a capability package.
`@8bitscript/text` is a capability: it has a machine-specific implementation
per target, and `@8bitscript/text`'s job is to pick the right one.
`@8bitscript/ui` has none: there is one menu bar, and it is the same code on
a PET and a Commander X16. **A component that needs a per-machine
implementation is a capability in the wrong package** — it belongs in
`packages/<machine>` with a portable package in front of it.

`test/ui.test.mjs` holds that line: it fails if a component's source
imports a machine package.

## Components are imported one at a time

`@8bitscript/ui` has no bare entry, and that is deliberate. Every component
is a subpath —

```
import { menubar } from "@8bitscript/ui/menubar";
```

— so a program links the components it names and nothing else. There is
nothing sensible for `import ... from "@8bitscript/ui"` to mean on a machine
where the whole program has 3583 bytes to live in.

Adding a component is a file in `src/` and a key in `package.json`'s
`"8bitscript".exports`.

## Immediate mode, not a widget tree

A component holds no list of what it contains. The caller runs the calls
that draw it, in order, every time:

```
menubar.begin(0, text.COLUMNS);
menubar.item("FILE");
if (menubar.item("EDIT")) { drawEditMenu(); }
menubar.end();
```

This is not a workaround for a language that has no arrays of strings yet.
It is what these machines want. A retained bar would need a list of labels,
a pointer per item, and RAM to hold them, all to redraw something the
program can redraw by running four calls again — and it would pay that RAM
on a machine that has none to spare. Nothing in a component allocates.

It is also the shape input wants, which is why `item()` already returns
whether that item is the highlighted one. The call above is written the same
way before and after the language has a keyboard.

**No component reads input**, and now that there *is* an input capability
(`@8bitscript/input`) that is a rule rather than a limitation. A component
that imported it would make every program that draws a menu bar link an
input layer, on machines where the whole program has 3583 bytes; and it
would decide, for everyone, that hovering selects and that left means
previous. So the bar offers `next()`, `previous()`, `deselect()` and
`point(cell)`, and the *program* writes

```
input.poll();
if (input.left()) { menubar.previous(); }
```

which is four bytes of policy in the one place that knows what the policy
should be. `test/ui.test.mjs` fails if a component imports a machine
package; the same reasoning keeps `@8bitscript/input` out of `src/`, and
it is not in this package's dependencies.

## What the character grid actually gives you

Every claim here was checked against each machine's `text.8bs`, and every
one of them shapes a component's design:

- **Three of the nine targets have no per-cell color.** `text.putColor`
  and `text.setColor` are deliberately empty functions on the **PET** (no
  color RAM at all), the **Atari 8-bit** (GR.0 has none), and the **NES**
  (its color lives in a 2x2-cell attribute block, which that text layer
  does not touch). The compiler deletes a call to either, so a program
  that colors its text pays those three nothing. Color is never a
  component's only way of showing state.

  **Ask `video.colorPerCell`, and ask it while compiling.** That fact
  exists for this: it is true on the six machines where a cell can be given
  its own color and false on those three, so a component picks its way of
  showing state before any target toolchain runs and compiles only that
  one. The menu bar inverts the selected item on every machine, so a
  color-only highlight is never the only way it shows state — reverse
  video is.

  Do **not** reach for `video.cellColors` to answer this. It is 2 on all
  nine, PET included, because a PET cell really does hold two colors —
  they are simply not a program's to set. That near-miss is why
  `video.colorPerCell` was added rather than reused.
- **Reverse video is a text mode, not a portable glyph.** `text.setReverse`
  inverts cells printed after it: a reverse space is a solid block in the
  cell's color, which is how a selected menu item becomes a filled bar.
  The portable character set still has no inverted copies of its own —
  invert is something each machine's text package does to the codes it
  writes. The NES ships inverted copies of $20-$5F at ASCII+128 in its font.
- **Labels are limited to the portable character set** the checker enforces
  — space, `0`-`9`, `A`-`Z`, and `! , - . : ?` — and so is any character a
  component draws itself. `test/ui.test.mjs` checks the menu bar's default
  marker against that set, because a character *code* is a number the
  checker cannot see.
- **The grid is 22 columns on a VIC-20 and 76 on a Commander X16.** A
  component is given the cells it may use and must never write past them.
  What does not fit is the caller's problem to solve and the component's
  problem to *report* — never to silently overrun.
- **A cell write is not free and not always immediate.** The NES queues
  writes and delivers them in vertical blank, 112 bytes at a time; a
  component that draws more than that in one go costs the program frames
  (never the picture — the queue waits for the next blank). Draw once
  before the loop where you can, as Studio does. Many small writes cost
  more of that budget than the same bytes as a few large ones — each run
  pays its own address header — so a component of many narrow fields
  (see `packages/nes/AGENTS.md`, 2048's tile grid) fills the queue faster
  than its byte count alone suggests.

## The menu bar

`src/menubar.8bs`. One row of items, the selected one inverted in the item
color — a filled bar of reverse video, including the padding spaces:

```
 8  FILE                 FILE inverted: a filled bar, letters punched out
```

| Call | What it does |
| --- | --- |
| `begin(at, cells)` | Open a bar at cell `at`, using `cells` cells and never one more |
| `icon()` | Draw the leftmost item as the bar's own mark; see below |
| `item(name)` | Draw the next item; returns whether it is the highlighted one |
| `end()` | Close the bar, blanking whatever is left of it |
| `select(i)` / `selected()` | Which item is highlighted; 0 is the first, `NONE` is none |
| `deselect()` | Back to nothing highlighted, which is where a bar starts |
| `next()` / `previous()` | Step the highlight, wrapping; from `NONE`, to the first or the last |
| `point(cell)` | Where a pointer is, before `begin()` |
| `pointed()` | Which item it was over during the last run, or `NONE` |
| `count()` | How many items the last run offered, drawn or not |
| `clipped()` | Whether an item had to be dropped for want of room |
| `setColors(item, highlight)` | Item color; invert uses it, `highlight` is unused |
| `setPadding(cells)` | Space either side of each label; 1 by default |
| `setMarker(s)` | Kept so the call shape stays; invert is the highlight |
| `setIcon(s)` | The character `icon()` draws; `"8"` by default |
| `NONE` | The value `selected()` and `pointed()` give when there is no item |
| `HEIGHT` | Rows a bar occupies, so a program can lay out under it |

Seven things about it that are decisions, not accidents:

- **A bar starts deselected.** `NONE` is 255 — a value no `utinyint` index
  a real bar produces can collide with — and it is what `selected()`
  answers before anyone has touched the bar. A menu bar with its first item
  lit up before the user has done anything is claiming something untrue.
- **`icon()` draws one character, and that is a limit, not a design.** A
  component may only draw from the portable character set, and `putChar`
  converts ASCII to a screen code, so there is no portable route to an
  arbitrary shape. `icon()` exists as its own call so that when a glyph
  capability arrives — a redefinable character, or a `text.putCode` escape
  hatch — it starts drawing a real mark and **no program changes**. Adding
  it as `item("8")` would have made that a breaking change later.
- **The bar hit-tests a pointer but never moves under one.** `point()` in,
  `pointed()` out; what hovering *means* is the program's to decide. See
  the immediate-mode section above for why no component reads input.

- **`begin` takes a cell and a width, not a row.** Every `text` call takes a
  flat cell index, and a bar that is told its width can sit inside something
  narrower than the screen. `begin(0, text.COLUMNS)` is the full top row.
- **Padding is the same width selected or not.** Reverse spaces fill the
  button without shifting the bar. At padding 0 there is no cell either
  side of the label and the filled ends are not drawn.
- **An item with no room is not drawn, but still takes its index** and still
  answers for the highlight. Which item is selected must not depend on how
  wide the machine's screen is.
- **The color goes on with `setColor`, and invert with `setReverse`.**
  There is no `text.getColor` to put the caller's setting back with, so a
  bar leaves the text color set to the bar's and reverse off after each
  item. A program that cares picks its color on the line after the bar.

### What it costs

Measured by building Studio's front door three ways — as it is, with the
menu bar taken out, and with input taken out — on 2026-09-06, after the
bar grew a deselected state, navigation, a pointer hit test and an icon
slot, and the Commander X16 row again on 2026-09-07 after its KERNAL mouse
landed. Studio's bar is now an icon and one menu, where the earlier table
measured four items, so these numbers replace those rather than continuing
them.

| Machine | Studio today | without the bar | the bar | without input | input |
| --- | --- | --- | --- | --- | --- |
| VIC-20 | 1097 B | 754 | **+343** | 971 | **+126** |
| C64 | 1523 B | 1157 | **+366** | 1156 | **+367** |
| PET | 1396 B | 956 | **+440** | 1174 | **+222** |
| C128 | 1395 B | 956 | **+439** | 1045 | **+350** |
| Atari 8-bit | 1456 B | 828 | **+628** | 1067 | **+389** |
| NES | 1820 B | 1277 | **+543** | 1610 | **+210** |
| Commander X16 | 1571 B | 1180 | **+391** | 1253 | **+318** |
| MEGA65 | 1292 B | 889 | **+403** | 970 | **+322** |

Re-measured 2026-09-07 after the selected item became inverted rather than
recolored: `menubar_item` is 466 bytes on a C64 and 384 on the X16
(measured from Studio's linked image, pre-0.2.0). The extra
against the 285-byte `item()` below is two padding `print`s per item — a
reverse space is the filled end of the button — plus `text.setReverse`.
`currentReverse` is one byte of BSS in every text package that implements
invert; unused `highlightColor` is stored by `setColors` and then dropped
by the linker.

Three things in that table are worth more than the totals:

- **The X16's input is the pointer**, not the keyboard. `@8bitscript/cx16/input`
  answers the KERNAL mouse (`$FF68` / `$FF71` / `$FF6B`) and still returns
  false for directions, confirm and cancel — GETIN and joystick_get are
  the next calls. Measured 2026-09-07: Studio is 1253 bytes without that
  layer and 1571 with it, **318 bytes of program and 5 of RAM**. The
  unanswered half still costs zero. The bar column grew with it (+391
  against the earlier +266) because `input.pointer()` is now live, so the
  hit-test in Studio's loop is compiled in rather than deleted.
- **The Atari 8-bit pays most for the bar** (+628). Its `text` layer is the
  one that does the most work per call, so anything that draws more
  strings costs more there; that is the machine to check when a component
  gets bigger.
- **Input is not one price.** It ranges from 126 bytes on a VIC-20
  (joystick only — no key matrix table has been verified for that machine
  yet) to 389 on an Atari 8-bit (keyboard *and* joystick), and it is 367 on
  a C64 with no mouse fitted. Fit the C64 with one and the mouse adds a
  further **490 bytes of program and 17 of RAM**, measured on the menubar
  example: 1517 B stock against 2007 B with `--hardware port1=mouse1351`.
  A build that never asked for a mouse links none of it. The X16's mouse
  is stock, so there is no "without" build to subtract — taking the layer
  out of Studio is how 318 was measured.

**Measure against the floor, not against the text.** Four labels are 27
bytes of characters, and it is tempting to conclude a bar should cost about
that. It cannot. The same picture on a C64 — blank the screen, draw
` FILE -EDIT- VIEW  HELP`, loop — as five complete programs, every one
verified pixel-identical in VICE:

| The whole program, built as | Bytes |
| --- | --- |
| Raw 6502 assembly, layout in a 24-byte table | 99 |
| Hand-written C, the same table | 178 |
| 8BitScript: four bare `text.print` calls, no layout at all | 446 |
| 8BitScript: the layout precomputed by hand, with a movable highlight | 455 |
| **8BitScript: this component** | **809** |

Read the last three rows together, because they are the whole argument.
**446 is the floor** — what an 8BitScript program costs to print four
labels at all, before any menu behavior: `text_print` (172 bytes, ASCII in,
any length, nine machines), `setupVideo` (86), and the startup the linker
adds. A component that laid its bar out at compile time would sit at 455,
**nine bytes above that floor**, and still have a highlight that moves.
This component is at 809. So the 363 bytes between them are not the price
of the feature — they are the price of working the layout out on a 6502
instead of while compiling. That is the gap
[compile-time layout](../../docs/project/compile-time-layout.md) closes, and
the reason the root [`AGENTS.md`](../../AGENTS.md) rule exists.

The two rows above the floor are worth keeping in view for a different
reason: they are what the portable layer costs. 99 bytes buys one bar, on
one machine, with the labels the programmer typed. Nothing in the 446 is
waste anyone has found — three separate attempts to cut it (emitting
assembly instead of C, pre-converting strings to screen codes, dropping
`volatile` from `@address` arrays) each turned out to be worth 2, 10 and 0
bytes respectively; see
[the compiler](../../docs/compiler.md#what-a-call-costs-on-a-6502-measured).

**The one thing to know before changing how anything here draws:
`text.print` is cheap and `text.putChar` is dear.** `print` does a machine's
per-run setup once and then walks the string. `putChar` is self-sufficient,
so every call re-runs that setup (on a C64, `jsr setupVideo` and the
character-set register), converts ASCII to a screen code, and builds a
sixteen-bit pointer into screen RAM — and the compiler inlines all of it
into wherever it was called. A routine built out of `putChar` pays that per
cell; one built out of `print` pays once per string.

**The second thing: do not hold state across a call.** Anything still live
when `item()` calls `text.print` has to survive it, and a 6502 calling
convention pays for that by pushing zero-page registers to a soft stack
on entry and popping them on exit (measured pre-0.2.0). With the bookkeeping written after the drawing — the natural
order — that prologue and epilogue was about 130 bytes and ran even on the
clipped path. Moving every measurement and every cursor update *before* the
first `print`, so only four values are still wanted by then, replaced it
with a five-byte frame built after the early returns.

Five shapes of `item()`, all measured on a C64:

| `item()` draws by | Bytes |
| --- | --- |
| runs of `putChar`: padding, marker, label, marker, padding | 743 |
| one loop over the item's cells, picking each character | 585 |
| `print` for the label, a loop for the padding | 561 |
| `print` for everything — label, marker, and the color with it | 320 |
| **the same, with all bookkeeping moved before the first call** | **285** |

Three smaller findings from the same measurements, each counter-intuitive
enough to be worth writing down rather than rediscovering:

- **A normal space shows the background whatever its color cell says**,
  on all nine. `blank()` therefore writes no color. A *reverse* space is
  a solid block in the text color — that is the filled end of a selected
  item, and it is why `item()` prints padding spaces rather than leaving
  them as blanks.
- **The blanking loop is 16 bytes**, measured by removing it — not the
  ~150 it looks like. A `text.fill(cell, count, code)` primitive in
  `@8bitscript/text` was proposed here to remove it and would have been
  nine files of work for 16 bytes. Measure before you optimize; this table
  exists so the next person does not repeat that.
- **The room check is 46 bytes.** It is not what makes a component big, and
  it is what stops a bar overrunning the row. Do not trade it away.

**The component is 354 bytes off its own ceiling, and closing that gap is a
compiler feature, not a library one.** The same bar with its layout
precomputed by hand the way a compiler could precompute it — the whole bar
as one `const string` with its padding already in it, plus `const array`
tables of where each item starts and how long it is — draws the identical
picture in **455 bytes against this component's 809**, which is nine bytes
more than four bare `text.print` calls that do no layout at all. The layout
is not what costs; doing the layout on a 6502 is. Those same tables are
exactly what a bar that answers a click, an arrow key or `ALT`+letter needs,
so this is not features traded for size. The design, the measurements and
the language feature it waits on (array parameters) are in
[compile-time layout](../../docs/project/compile-time-layout.md), and the
rule behind it is the root [`AGENTS.md`](../../AGENTS.md)'s "the rule that
decides where work happens". **Anything added to this component before then
should be shaped so that folding it into constants later is a change of
implementation, not of surface.**

To re-measure: build Studio with and without, then inspect the linked
image's symbol sizes for `menubar_item`. The native backend does not yet
emit that image. Pre-0.2.0 measurements used the linked `.prg.elf`.
Update this table in the same commit rather than deleting it — and read the
comment above the room check first, because the obvious simplification
there (widen the sum to sixteen bits) does not behave the same on both
backends today.

## Changing a component

- **Every component links for all nine targets.** `test/ui.test.mjs` links
  `test/menubar-probe.8bs` — a program that calls every function the
  component offers — for each one. A component that works on eight is a bug.
- **Show it running before you claim it works.** Studio's front door
  draws a bar, and `8bs run <target> --screenshot` is how
  each layout was checked on the machine itself (pre-0.2.0). Until the
  backends emit, link `test/menubar-probe.8bs` instead. Check the
  VIC-20 in particular: it is the machine where the bar does not fit, and
  the only one that proves clipping does what it says.
- **State what a machine cannot do rather than papering over it.** The
  section above is the pattern: check the machine's own `text.8bs`, write
  down what is empty there, and design so the component still works.
