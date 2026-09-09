---
title: Compile-time layout
nav_order: 93
---

# Compile-time layout — design

Status: **design, not built.** This note specifies compiler work and the
measurements that justify it. Nothing here compiles today.

## Why

The repository's `AGENTS.md`, under *"The rule that decides where work
happens"*: if the compiler can do it, the compiler does it. The menu bar in
[`@8bitscript/ui`](../packages.md) is the case that made the rule explicit,
because it can be measured three ways. The same picture on a C64 — blank the
screen, draw ` FILE -EDIT- VIEW  HELP`, loop — verified pixel-identical in
VICE:

| Built as | Bytes |
| --- | --- |
| Hand-written C, layout precomputed into a 24-byte table | 178 |
| `@8bitscript/ui/menubar`, layout computed at run time | 809 |
| The same bar with its layout precomputed *by hand* in 8BitScript | 455 |

The third row is the point. It is a real program — one `const string` holding
the bar with its padding already in it, a `const array` of where each item
starts, another of how long each is, and a marker drawn over the highlighted
one — and it draws the identical picture for **354 bytes less** than the
component. It costs 9 bytes more than four bare `text.print` calls that do no
layout at all. **The layout is not what is expensive. Doing the layout on a
6502 is what is expensive.**

The third row is a real program, and this is all of it — the layout is
precomputed by hand exactly as a compiler would precompute it. Build it with
`8bs build --target c64` beside a project that depends on `@8bitscript/screen`
and `@8bitscript/text`:

```
import { screen, BorderColor, BackgroundColor } from "@8bitscript/screen";
import { text, TextColor } from "@8bitscript/text";

const BAR: string = " FILE  EDIT  VIEW  HELP ";
const STARTS: array<utinyint, 4> = [1, 7, 13, 19];
const LENS: array<utinyint, 4> = [4, 4, 4, 4];
const MARK: string = "-";

let highlighted: utinyint = 1;

function draw(at: usmallint): void {
    text.setColor(TextColor.WHITE);
    text.print(at, BAR);

    let s: utinyint = STARTS[highlighted];
    let n: utinyint = LENS[highlighted];
    text.setColor(TextColor.YELLOW);
    text.print(at + s - 1, MARK);
    text.print(at + s + n, MARK);
    for (let i: utinyint = 0; i < n; i++) {
        text.putColor(at + s + i, TextColor.YELLOW);
    }
}

export function main(): void {
    screen.blank(BorderColor.BLUE, BackgroundColor.BLACK);
    draw(0);
    while (true) {
    }
}
```

`const` arrays are data in the program image and never in RAM, and a `const
string` is a slot in the string table — so the three tables above cost their
bytes once and nothing at run time. The whole of `draw()` inlines into
`main()`, which comes to 141 bytes; there is no equivalent of the
component's 314-byte `item()` at all, because there is no layout left to do.

## What is knowable while compiling

Given `FILE`, `EDIT`, `VIEW`, `HELP` and a padding of 1, every one of these
is decided before the machine runs:

- the bar's full text, padding included — one string, printed with one call
- where each item's label starts, and how long it is
- how many items there are
- which letter is each item's keyboard shortcut
- whether the whole thing fits the target's `text.COLUMNS` — a
  **compile-time diagnostic** rather than a run-time `clipped()` flag

Only two things are not: which item is highlighted, and what the user just
pressed or clicked.

## The shape

Follow the **template** precedent rather than inventing a second mechanism.
`text.print(cell, \`TICK ${ticks:1}\`)` is already laid out during
compilation into `print`/`printNumber` calls with each cell computed from
the text before it — "a protocol any namespace exporting those two
functions gets, not a builtin" ([the compiler](../compiler.md)). A menu bar
of literal labels is the same class of problem: a backtick argument the
compiler reads, lays out, and lowers into data plus a small call.

```
menubar.define(`FILE|EDIT|VIEW|HELP`);   // laid out at compile time
menubar.draw(0);                          // one print, plus the highlight
if (menubar.chose(0)) { openFileMenu(); }
```

`define` lowers to constants — the bar string, a starts table, a lengths
table, a shortcut table — and `draw` to one `text.print` of the whole bar
plus the marker over the highlighted item.

This depended on **array parameters** — a generated table has to be able to
reach a runtime function inside a package — and those now compile: an array
is passed by name, as the address of its first element, with its length
folded into the callee from the type
([the compiler](../compiler.md#array-parameters)). That was the blocker, and
it is gone; what remains is the layout protocol itself.

## What it buys interactivity

The tables are not only a size trick — they are exactly what a menu that
responds to anything needs, and they cost nothing to carry because they are
data in the program image:

- **Arrow keys / d-pad.** Move an index, redraw. The count is a constant, so
  wrapping is a comparison against a literal.
- **A mouse or a light pen.** A click at column `x` finds its item by
  walking the starts table — a handful of bytes, no arithmetic over strings.
- **`ALT`+letter shortcuts**, the way the old PC menu bars worked. The
  shortcut letter per item is decided while compiling, so matching a
  keypress is a scan of a table of four bytes. Which letter, and whether it
  is underlined or highlighted, is a layout decision and therefore a
  compile-time one.
- **Sub-menus** hang off the same idea: a pull-down is another laid-out
  block of text with its own starts table, and its position under the bar is
  known once the bar is laid out.

None of it can be built before there is an input capability —
`packages/studio/AGENTS.md` lists that first among what Studio waits for —
and none of it changes this design: the
run-time part of a menu is an index and a redraw.

## The other compile-time win in the same area

`text.print` converts each character from ASCII to the machine's screen code
**as it draws**, every time, on every target that needs a conversion. The
build knows which machine it is for, so the string could be stored already
converted and `print` could become a copy. That is a saving in every program
that prints anything, not just this one.

The wrinkle to solve first: a `string` parameter exposes `s[i]` as an ASCII
character, so storing converted bytes changes what a program reads back.
Either the conversion applies only to strings the linker can prove are never
indexed, or `s[i]` converts on read (moving the cost rather than removing
it), or the language says plainly that `s[i]` is the target's code and not
ASCII. Unresolved, and worth resolving — it is the same rule as everything
above.

## How to check any of this

Build, then read the backend's own size report (`memory.program` and
`memory.variables` from `build()`). Until that report exists, no new
size claim can be made; the numbers already in this note stay as the
reference.

A size claim in this repository without a measurement is not a size claim.

## A second, larger finding: the VIC bank is a compile-time decision too

Not layout, but the same rule, and worth more bytes than the menu bar's.

`@8bitscript/c64` puts the picture in **VIC bank 3**, screen at `$E000`, with
the character ROM's 4K **copied into RAM at start-up** — because in banks 1
and 3 the VIC has no character-ROM window, so a copy is the only way to have
a character set at all. The reason for bank 3 is good and is set out at the
top of `packages/c64/src/geometry.8bs`: the backend links a program into
`$0801-$CFFF` and decides where every byte goes, so nothing the VIC needs can
be promised a place inside that region, and `$D000-$FFFF` is the only RAM the
linker never touches. Sprite shapes (7104 bytes) and a redefinable character
set (4K) have nowhere else to live.

**But a program that only prints text needs none of that.** The default
screen at `$0400` sits *below* the link region, so the linker cannot touch it
either, and in bank 0 the VIC sees the character ROM directly — no copy, no
bank switch. Measured on a C64, the four-label program from the table above:

| | Bytes |
| --- | --- |
| Bank 3, screen `$E000`, character ROM copied (today) | 469 |
| Bank 0, screen `$0400`, ROM character set | **348** |

**121 bytes, 26%, off every C64 program that does not redefine a character,
place a sprite, or enter bitmap mode** — and with it a 4096-iteration copy
loop at start-up. Verified: the bank-0 build draws the identical picture in
VICE. (Both rows were measured together, before the screen-clear rewrite in
`packages/c64/src/screen.8bs` took 23 bytes off every C64 program; that
saving is independent of this one, and the same program is 446 bytes today.
Re-measure both sides if the number matters to a decision.)

The choice is knowable while compiling. **The linker already knows the whole
module graph**, so it knows whether `@8bitscript/c64/charset`,
`/sprites` or `/bitmap` is in the program. A build that imports none of them
can have bank 0 and the ROM character set; a build that imports any of them
needs bank 3 exactly as today. Nothing about a program's source changes.

What makes this bigger than it looks: the same question exists on every
machine whose video hardware has a cheap default and an expensive general
layout. It is the largest single saving found anywhere in this repository so
far, and it is not a micro-optimisation — it is one build-time decision.

Not implemented. It touches `packages/c64`'s geometry, which
`/charset`, `/sprites`, `/bitmap`, `/scroll` and `/raster` are all written
against, so it wants doing deliberately and with those layers' tests in view
— not folded into an unrelated change.
