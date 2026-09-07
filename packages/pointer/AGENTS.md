# Writing a pointer layer

This file is for anyone — human or agent — adding or changing a machine's
`pointer` layer. Read the root [`AGENTS.md`](../../AGENTS.md) first, then
[`packages/input/AGENTS.md`](../input/AGENTS.md), which this package is the
other half of. Two rules from the root file decide almost everything here:

> **8BitScript should abstract concepts, but expose constraints.**

> **If the compiler can do it, the compiler does it.**

## What this package is, and why it is not `input`

`@8bitscript/pointer` is a **capability package**: it has no source at all,
and `package.json`'s `"8bitscript".entry` maps each target to that
machine's own layer, exactly the way `@8bitscript/input` and
`@8bitscript/text` do.

It answers one question — **what does the user see while they aim?** —
and `@8bitscript/input` answers the other: where the pointer is, and
whether its button went down. They are two packages rather than one for
the same reason `text` and `input` are two packages: **reading and drawing
are different jobs, and a machine can do either without the other.** The
X16 has a mouse pointer in its own firmware and an input layer that cannot
read a key; the NES has 64 sprites and nothing to move one with. Folding
the arrow into `input` would make every one of those honest positions
impossible to state.

## The surface

Four calls and one const, the same on every machine:

| Call | What it does |
| --- | --- |
| `DRAWS` | **A const**: does this machine draw an arrow at all? |
| `begin()` | Once, at start-up, after `input.begin()` |
| `setColor(c)` | The arrow's colour, in the same numbers `text.setColor` takes |
| `update()` | Once a frame, after `input.poll()` |
| `hide()` | Off the screen until the next `update()` |

Three things about that surface are decisions:

- **`DRAWS` is a compile-time constant, not a run-time question.** Whether
  a machine *can* draw an arrow is a property of the build, so a program
  lays itself out around the answer and the branch it does not take costs
  nothing. It is not the same question as `input.pointer()`, which is
  whether a mouse is really plugged in *this frame* — on the C64 `DRAWS`
  is `#fact(input.mouse)` and `input.pointer()` is a probe, and a build
  can have the first true and the second false all session.
- **`poll()` then `update()`, once each a frame.** This is `input`'s
  ordering rule extended by one call, and it is the whole contract between
  the two packages: `input.poll()` advances the machine's pointer state and
  `pointer.update()` draws whatever it advanced to. A program that never
  polls gets an arrow that never moves.
- **`update()` takes no arguments**, and reads the machine's own pointer
  state rather than a cell handed in. `input.pointerCell()` is in *cells*
  by design — it is the unit a component hit-tests against — and a cursor
  that moved eight pixels at a time would be the character-cell cursor a
  sprite exists to avoid. So each layer reaches for whatever resolution its
  machine really has, and the two stay consistent because they come from
  one reading (see below).

## A layer that cannot draw still has to compile

**Every one of the nine `entry` targets must exist.** Studio and
`examples/pointer` link `@8bitscript/pointer`, so a missing layer is not a
program without a cursor, it is a program that does not build for that
machine.

So a machine with nothing to draw with ships a layer whose `DRAWS` is
`false` and whose four functions are empty — and **says why in its header,
in detail, and distinguishes a missing driver from missing hardware.**
Those are different statements and the headers make both:

- **Missing hardware**, and no code will fix it: the **PET** has no control
  ports at all, and the **VIC-20** has no sprites.
- **Missing driver**, on hardware that is sitting right there: the
  **C128** and the **MEGA65** have the VIC-II's eight sprites and control
  ports, and neither package has a sprites layer; the **X16** has 128 VERA
  sprites *and a pointer in its own KERNAL* and cannot reach either without
  `asm6502`; the **Atari 8-bit** has players and missiles and three mouse
  values in its catalog, and no quadrature driver.
- **A decision nobody has made**: the **web**, where the user is already
  looking at the browser's cursor, so "draw a pointer" means either hiding
  that one or never drawing at all.

It costs those machines nothing. `DRAWS` is a const and every body is
empty, so `if (pointer.DRAWS)` folds away and LLVM deletes the calls —
`packages/pointer/test/pointer.test.mjs` asserts every layer's functions
are bodiless in the IR on a machine with no pointer.

## The bug this package was written against, and the rule it produced

The C64 layer was written, the sprite was enabled, its shape block and
position were correct — `ENABLE 001`, `POINTER 254`, `POS X 024 Y 050`,
read off the screen by `packages/c64/test/pointer-probe.8bs` — and no
arrow appeared. The cause was not in this package:

**`@8bitscript/c64/mouse`'s `present()` re-read the SID's pot registers
every time it was asked.** The converter runs continuously, so two reads
in one frame are two different moments, and they disagreed: in the same
frame, `input.pointer()` said *no pointer* and a read a few instructions
later said there was one. `input.poll()` therefore refused to update the
cell while `pointer.update()` showed the sprite, or the reverse — and on
the frame the screenshot caught, `update()` had hidden it.

The fix was to read the pots **once** in `mouse.poll()` and answer both
questions from that one reading, which is what the file's own header always
said the discipline was. The rule for any layer here:

> **A pointer's position and its presence must come from one reading a
> frame.** Two reads of a live input register are two answers, and an
> interface built on both flickers.

The same caution applies to anything else a layer polls: read it in
`poll()`, keep it, and let `update()` draw what was kept.

## Verify it in pixels, or you have not verified it

The root rule — *verify hardware facts before writing them down* — has a
sharp edge here, because **`--screenshot` cannot move a mouse.** It can
still prove almost everything, and the way it does is worth copying: a
1351 reads its zero on both axes until it is moved, so **a fitted build
puts the arrow in the top-left corner of the screen and a build with the
mouse taken out puts nothing there.** That is a difference a headless run
can see, and `pointer.test.mjs` asserts it by counting white pixels in the
two blank rows `examples/pointer` keeps clear for the purpose — 58 with a
mouse, 0 without.

What a screenshot cannot answer, and what needs a human at the machine:

- **Movement** — that host motion reaches the emulated device and moves the
  arrow the way the hand moves. Confirmed for the C64 under x64sc.
- **The Y axis direction** — verified under x64sc (Studio, 2026-09-07):
  a 1351's Y counter runs opposite the screen, so `@8bitscript/c64/mouse`
  inverts the *delta* and leaves the rest position at the top-left.
- **Whether the emulator is even feeding the device.** VICE needs
  `-mouse` — its mouse *grab* — as well as `-controlport1device 3`, or the
  mouse is fitted and never moves. The C64, C128 and VIC-20 catalogs pass
  both together for exactly that reason.

## What each machine has, as of 2026-09-06

| Machine | Draws | With what | Gap worth closing |
| --- | --- | --- | --- |
| C64 | **yes**, on a build with a 1351 | sprite 0, shape block 254 | — |
| C128 | no | — | a `./sprites` layer over a `./geometry`; then this is the C64's file |
| MEGA65 | no | — | control-port options in the catalog, then a sprites layer |
| X16 | no | — | the KERNAL's own pointer (`$FF68` mouse_config), after the input layer's three calls |
| Atari 8-bit | no | — | a quadrature driver for the ST/Amiga/trak values already in the catalog |
| NES | no | — | nothing a pad should drive; a Famicom mouse is not in the catalog |
| VIC-20 | no | — | no sprites: a cell cursor is a different feature |
| PET | no | — | no control ports; nothing to close |
| web | no | — | decide whether to hide the browser's cursor |

## Adding a layer

1. Write `packages/<machine>/src/pointer.8bs` with `DRAWS` and the four
   calls, and a header that says what it draws with and what it does not.
2. Add `"./pointer": "./src/pointer.8bs"` to that package's
   `"8bitscript".exports`.
3. Add the target to this package's `"8bitscript".entry` and its
   `dependencies`.
4. Run `packages/pointer/test/pointer.test.mjs`: it links
   `examples/pointer` for all nine and checks the surface is the same
   everywhere. Add a pixel assertion for your machine's emulator if it
   draws anything.
5. **Measure it, in bytes, and write the number down.** The C64's arrow is
   182 bytes of program and 1 of RAM on top of the input layer's mouse;
   a mouse and its arrow together take Studio from 1523 bytes and 28 of
   RAM to 2208 and 47. The other eight targets build to the byte they
   built to before the package existed, which is the whole claim about
   what an empty layer costs.
