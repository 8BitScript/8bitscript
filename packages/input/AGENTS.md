# Writing an input layer

This file is for anyone — human or agent — adding or changing a machine's
`input` layer. Read the root [`AGENTS.md`](../../AGENTS.md) first; its rules
apply here without exception, and two of them decide almost everything in
this package:

> **8BitScript should abstract concepts, but expose constraints.**

> **If the compiler can do it, the compiler does it.**

## What this package is

`@8bitscript/input` is a **capability package**, which in this repository
means it has no source at all. `package.json`'s `"8bitscript".entry` maps
each target to that machine's own layer:

```
"c64":  "@8bitscript/c64/input",
"nes":  "@8bitscript/nes/input",
```

— exactly the way `@8bitscript/text` and `@8bitscript/screen` work. A
program writes `import { input } from "@8bitscript/input"` and gets one of
nine files. There is nothing portable to share, because input *is* the
machine: a keyboard matrix, a shift register, an analogue counter and a
KERNAL call have nothing in common below the surface this package defines.

## The surface, and why it is this small

Ten calls, the same ten on every machine:

| Call | What it answers |
| --- | --- |
| `begin()` | Once, at start-up, before the first `poll()` |
| `poll()` | Once a frame, right after `waitFrame()`, and never twice |
| `left()` `right()` `up()` `down()` | A direction, on the frame its press began |
| `confirm()` `cancel()` | The two decisions every interface needs |
| `pointer()` | Whether a pointer is really there, this frame |
| `pointerCell()` | Where it is, as a flat cell index |
| `pointerButton()` | Its main button, on the frame its press began |

Four things about that surface are decisions:

- **Everything is edge-triggered.** `right()` is true on the one frame the
  press begins and false while it is held. A menu wants "did they just
  press right", not "is right down" — a level-triggered answer races a
  highlight across a bar in a third of a second. Each layer keeps `held`,
  `before` and `began`, and `began` is `held & (before ^ 0xFF)`; the
  language has no `~`, which is why the XOR.
- **`poll()` exactly once a frame** follows from that. Poll twice and every
  press is seen once and then swallowed by the second call. It is the one
  rule a program using this package has to hold to, and every layer's
  header repeats it.
- **The pointer is in cells, not pixels.** A flat cell index is the unit
  `text.print()` takes and the unit a component hit-tests against
  (`menubar.point()`), so nothing in between has to know a machine's cell
  size. Layers that read an analogue counter scale and clamp it themselves.
  **Drawing the pointer is a different package.**
  [`@8bitscript/pointer`](../pointer/AGENTS.md) is the visible half: this
  surface says where the pointer is, and that one draws the arrow the user
  aims with, in whatever resolution the machine really has — the C64's
  arrow moves a pixel at a time while `pointerCell()` stays a cell. A
  layer here never draws anything.
- **There is no key-by-key surface here, and there must not be.** "Is `A`
  down" is a different question on a matrix, on a one-code-at-a-time
  register, and behind a PS/2 queue. A program that wants keys wants
  `@8bitscript/c64/keyboard` with `@8bitscript/c64/keys`, and is a C64
  program from then on. This package is for what an *interface* needs.

## A layer that cannot answer still has to compile

**Every one of the nine `entry` targets must exist.** Studio and any other
portable program links `@8bitscript/input`, so a missing layer is not a
degraded program, it is a program that does not build for that machine.

So a machine with nothing wired up yet ships a layer that returns false to
everything — and **says so in its header, in detail**. `@8bitscript/web/input`
used to be the model of that; it now reads a snapshot byte the page writes
into shared memory (arrows, Enter, Escape) and still returns false for the
pointer. `@8bitscript/cx16/input` used to be the same shape; it now answers the pointer through the KERNAL
(`$FF68` mouse_config, `$FF71` mouse_scan, `$FF6B` mouse_get) and still
returns false for directions, confirm and cancel — GETIN and joystick_get
are the next calls, not a gap the file hides. Measured on Studio, the X16
pointer costs **318 bytes of program and 5 of RAM** (1253 B without the
layer, 1571 with it); the unanswered half still costs zero
([`packages/ui/AGENTS.md`](../ui/AGENTS.md) has the table). **A capability a
machine cannot honour should cost that machine nothing**, and a layer of
honest constants achieves that where a missing file would not compile and a
half-working one would mislead.

What is never acceptable is a header that implies more than the code does.
`input.mouse` is true by default on the X16 because the *hardware* has a
mouse, and `pointer()` is that fact — the KERNAL has no 1351-style probe.
Keyboard and pads stay false until someone writes those calls. Those are
different statements and the header makes both.

## Facts decide what is compiled; probes decide what is true

This is the two-stage shape the fact sheet exists for, and an input layer is
where it shows most clearly.

- **`#fact(input.mouse)` is a `run` fact.** It means *this build may use a
  mouse* — false on a stock C64, true for `--hardware port1=mouse1351`. A
  layer reads it into a `const` (`HAS_MOUSE`) and wraps every line of
  pointer handling in `if (HAS_MOUSE)`. On a stock build that is `if
  (false)`: the code is not reached, not referenced, and not linked.
  Measured on the menubar example: a **C64** mouse costs 490 bytes of
  program and 17 of RAM (1517 B stock against 2007 B with
  `--hardware port1=mouse1351`), and a **C128** mouse 462 bytes and 8 of
  RAM (1377 against 1839). A build that did not ask for one pays none of
  it.
- **Whether a mouse is actually plugged in is not knowable while
  compiling**, and folding that away would be a wrong program, not an
  optimisation — on a machine with a probe. `pointer()` answers it every
  frame from that probe. The X16's KERNAL has none, so `pointer()` is the
  `input.mouse` fact; a board whose SMC reports `BAT_FAIL` will still say
  present. That case has not been seen under x16emu.
- **A probe is read once a frame, in `poll()`, and kept.** This is not a
  saving, it is correctness: a live input register read twice in one frame
  is read at two different moments and can give two different answers.
  `@8bitscript/c64/mouse`'s `present()` re-read the SID's continuously
  running converter, so `pointer()` said *no pointer* in the same frame
  that a read a few instructions later found one, and the arrow drawn from
  one answer flickered against the cell hit-tested from the other. Read
  it in `poll()`, keep it, and let everything in the frame share it.

A global initialiser must be a literal or a const (`8BS3001`), so
`const X: bool = !#fact(...)` does not compile. Write the negation at the
use site — `if (!COLOR_PER_CELL)` — which folds the same way.

## Verify it, or say you did not

The root rule — *verify hardware facts before writing them into comments or
docs* — is sharp here, because **`--screenshot` cannot press a key.** It
builds a program and captures a frame; it cannot push a joystick, type, or
move a mouse. So a layer's claims about button order, matrix codes or
counter direction cannot be confirmed the way a screen layout can.

The standard this package holds to:

- **State the source.** `@8bitscript/vic20/input` cites VICE's
  `vic20via1.c` and `vic20via2.c` for its port bits, which
  [`packages/vic20/AGENTS.md`](../vic20/AGENTS.md) records.
- **Where it is unverified, write that in the header** rather than writing
  a confident sentence. `@8bitscript/nes/pad` says the button order is the
  documented one and not a measured one, and asks whoever runs it under
  FCEUX with a pad to replace the paragraph with what they saw.
  `@8bitscript/c64/input` used to mark the mouse's Y-axis as unverified;
  it is inverted in `@8bitscript/c64/mouse` now, after a run under x64sc
  showed the arrow moving up when the mouse moved down.
- **Do not guess a key matrix.** The VIC-20's keyboard is *not* wired up,
  and the reason is written down: this repository has no table of that
  machine's key codes checked the way `@8bitscript/c64/keys` was checked
  key for key against VICE's own keymap. A recalled matrix that is wrong in
  two places is worse than a documented gap.

## What each machine has, as of 2026-09-07

| Machine | Directions | Pointer | Gap worth closing |
| --- | --- | --- | --- |
| C64 | cursor keys + SHIFT, joystick 2 | **1351 in port 1** | — |
| C128 | as the C64's | **1351 in port 1** | the second matrix on `$D02F`: four real cursor keys, and **ALT** |
| MEGA65 | as the C64's | none (no catalog options yet) | its extended keyboard: cursor keys, **ALT**, HELP |
| PET | cursor keys + SHIFT | none — no control ports exist | — |
| Atari 8-bit | CTRL + `+` `*` `-` `=`, joystick 1 | none | the catalog offers ST, Amiga and trak-ball mice; each is a quadrature driver nobody has written |
| NES | D-pad, A/START, B | none | confirm the pad on real input |
| VIC-20 | joystick only | none | a verified `keys.8bs`, then a `keyboard.8bs` |
| X16 | **nothing** | **KERNAL mouse** | GETIN (`$FFE4`) and joystick_get (`$FF56`); **ALT** |
| web | arrow keys, Enter, Escape | nothing | a pointer in the same snapshot byte |

**Three machines have an ALT key** — the C128, the MEGA65 and the X16 — and
none of them reads it yet. That is the prerequisite for `ALT`+letter menu
accelerators, and it is a per-machine job in each of those three packages,
not something this surface can offer until at least one of them can answer.

## Adding a layer

1. Write `packages/<machine>/src/input.8bs` with all ten calls, whatever it
   can answer, and a header that says what it reads and what it does not.
2. Add `"./input": "./src/input.8bs"` to that package's
   `"8bitscript".exports`.
3. Add the target to this package's `"8bitscript".entry` and its
   `dependencies`.
4. Build something that uses it for **every** target, not just yours —
   `examples/menubar` is the one to use, and
   `packages/ui/test/ui.test.mjs` links the whole menu bar surface for all
   nine.
5. Re-measure the input column in
   [`packages/ui/AGENTS.md`](../ui/AGENTS.md) and update it in the same
   commit.
