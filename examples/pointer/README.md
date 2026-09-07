---
title: A mouse pointer
description: An arrow the user can see, drawn with whatever the machine has to draw one with — and an honest word on the machines that have nothing.
---

# A mouse pointer

The same program on all nine targets. It asks
[`@8bitscript/input`](../../packages/input/AGENTS.md) where the pointer is
and [`@8bitscript/pointer`](../../packages/pointer/AGENTS.md) to draw an
arrow there, and prints what it is being told: whether a pointer is really
answering, which cell it is over, and how many times its button has been
pressed.

```bash
pnpm start             # the C64, with a 1351 in port 1
pnpm run start:cx16    # the X16, with the KERNAL's own arrow
pnpm run start:pet     # a machine with no pointer at all
```

`8bs run c64` needs no flags because **this project fits its own
hardware**: `8bs.config.ts` uses the object form of `targets` and asks for
`port1: mouse1351` on the C64 and the C128. The X16 needs none either: a
mouse is stock. That is the project's stock for those machines, so it goes
under any profile and under `--hardware` —
`8bs run c64 --hardware port1=none` is the same program on a machine with
no mouse, which is the comparison the C64 test makes.

## What each machine makes of it

The **C64**, the **C128** and the **X16** draw an arrow today. The two
Commodores have a 1351 driver and eight hardware sprites, so the arrow is
sprite 0 moving a pixel at a time, starting in the top-left corner. The
X16's firmware draws Susan Kare's arrow as VERA sprite 0 and parks it at
the centre; the program prints `POINTER 1` with the cell under the tip
on all three.

The other six print `NO ARROW ON THIS MACHINE`, and the reasons are not
the same reason — some are hardware, some are a driver nobody has written.
[`packages/pointer/AGENTS.md`](../../packages/pointer/AGENTS.md) has the
table and each layer's header has the detail. The line worth repeating
here: a machine that cannot draw a cursor still links this program and
still pays nothing for the layer, because `pointer.DRAWS` is a constant
and the branch folds away.

## Two things this example is really for

**Rest position is a machine fact.** A 1351 reads its zero on both axes
until it is moved, so the C64 and C128 arrows start in the top-left
corner — and the top two rows are left blank so `packages/pointer/test/pointer.test.mjs`
can count white pixels there (and none in the same corner of a build
with no mouse fitted). The X16 parks at the centre; after the display is
inset that sprite is on the screenshot at (335, 254), and the test counts
white pixels in that box instead. Either way, a headless screenshot can
check a cursor without anyone moving a mouse.

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
macOS). See [the VICE setup notes](../../docs/setup/vice.md). The X16's
emulator already feeds its PS/2 mouse; there is no extra flag.
