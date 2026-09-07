---
title: A mouse pointer
description: An arrow the user can see, drawn with whatever the machine has to draw one with — and an honest word on the eight machines that have nothing.
---

# A mouse pointer

The same program on all nine targets. It asks
[`@8bitscript/input`](../../packages/input/AGENTS.md) where the pointer is
and [`@8bitscript/pointer`](../../packages/pointer/AGENTS.md) to draw an
arrow there, and prints what it is being told: whether a pointer is really
answering, which cell it is over, and how many times its button has been
pressed.

```bash
pnpm start          # the C64, with a 1351 in port 1
pnpm run start:pet  # a machine with no pointer at all
```

`8bs run c64` needs no flags because **this project fits its own
hardware**: `8bs.config.ts` uses the object form of `targets` and asks for
`port1: mouse1351` on the C64 and the C128. That is the project's stock for
those machines, so it goes under any profile and under `--hardware` —
`8bs run c64 --hardware port1=none` is the same program on a machine with
no mouse, which is the comparison the test makes.

## What each machine makes of it

Only the **C64** draws anything today. It has a 1351 driver and eight
hardware sprites, so the arrow is sprite 0 moving a pixel at a time, and
the program prints `POINTER 1` with the cell under the tip.

The other eight print `NO ARROW ON THIS MACHINE`, and the reasons are not
the same reason — some are hardware, some are a driver nobody has written.
[`packages/pointer/AGENTS.md`](../../packages/pointer/AGENTS.md) has the
table and each layer's header has the detail. The line worth repeating
here: a machine that cannot draw a cursor still links this program and
still pays nothing for the layer, because `pointer.DRAWS` is a constant
and the branch folds away.

## Two things this example is really for

**The blank top two rows are deliberate.** A 1351 reads its zero on both
axes until it is moved, so the arrow starts in the top-left corner of the
screen. `packages/pointer/test/pointer.test.mjs` proves the arrow is drawn
by counting white pixels up there in a build with a mouse and in one
without — 58 against 0 — which is how a headless screenshot can check a
cursor without anyone moving a mouse.

**`poll()` then `update()`, once each a frame.** That is the whole contract
between the two packages, and it is the one rule a program using them has
to hold to. `input.poll()` advances the machine's pointer state;
`pointer.update()` draws whatever it advanced to. Poll twice and every
button press is seen once and then swallowed; never poll and the arrow
never moves.

## The mouse grab

VICE takes your host pointer as soon as the window opens, because a
device in a control port that the emulator has not grabbed the pointer for
never moves — so `mouse1351` passes `-mouse` as well as
`-controlport1device 3`. **Command+M gives the pointer back** (`Alt+M` off
macOS). See [the VICE setup notes](../../docs/setup/vice.md).
