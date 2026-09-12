---
title: Controllers, across nine machines
nav_order: 80
---

# Controllers, across nine machines

Design direction for 8BitScript's controller layer, written against what the
repository already does rather than from first principles. The short version:
the portable abstraction and the capability model both already exist. What is
missing is *width* — named buttons beyond a single fire — and the tooling to
get a real controller into an emulator.

## What already exists

Two things, and it is worth being precise about them because the obvious
design proposal reinvents both.

**A normalized input namespace.** `@8bitscript/input` resolves per target the
same way `@8bitscript/text` does, and every one of the nine machines
implements it:

```
input.begin()          once, before the loop
input.poll()           once a frame, after waitFrame()
input.left()  input.right()  input.up()  input.down()
input.confirm()  input.cancel()
```

Those are edge-detected, not levels — `poll()` takes a snapshot and the
readers answer "pressed since the last poll". 2048 is written against exactly
this and runs unmodified on all nine machines, reading a CIA on the C64, a VIA
on the VIC-20, PIA1's keyboard matrix on the PET, and the pad shift register
on the NES. The abstraction is real and it is load-bearing.

**A capability model that folds at build time.** Every machine's catalog sheet
carries these, and `#fact(...)` resolves them to constants during compilation:

| machine | `input.joysticks` | `input.pads` | `input.keyboard` |
|---|---|---|---|
| PET | 0 | 0 | yes |
| VIC-20 | 1 | 0 | yes |
| C64 | 2 | 0 | yes |
| C128 | 2 | 0 | yes |
| Atari 8-bit | 2 | 0 | yes |
| MEGA65 | 2 | 0 | yes |
| NES | 0 | 2 | no (Famicom: yes, with the keyboard fitted) |
| Commander X16 | 0 | 2 | yes |
| web | 0 | 0 | yes |

This already encodes the ladder: `joysticks` counts Commodore/Atari one-button
ports, `pads` counts console-style controllers. The machine sheet says which
kind it has and how many, before a line of code is generated.

So capability detection does not need a runtime `controller.has("x")`. The
pattern the repo already uses is better:

```
const HAS_MOUSE: bool = #fact(input.mouse);
```

`@8bitscript/c64/pointer` does this, and the comment beside it explains the
payoff: on a stock C64 the fact is false, so `HAS_MOUSE` is a constant, the
`if` is `if (false)`, and the arrow's 63 bytes of shape data are deleted before
the machine ever sees them. A runtime `has()` cannot do that. **Capability
questions should be asked at compile time wherever the answer is a fact about
the machine**, and only at run time where the answer genuinely is not — whether
something is *plugged in* is a run-time question, which is why `input.mouse`
and `input.paddles` are tagged `run` while `input.joysticks` and `input.pads`
are tagged `build`.

## What is actually missing

**Named buttons.** `confirm`/`cancel` is a two-button vocabulary. It is exactly
right for a VIC-20 and visibly thin for an NES, let alone an X16. The widening
is the real work: `a b x y l r start select`, with each machine exposing the
subset it has, and the compiler deleting the rest.

This is where the ladder earns its keep. The same source asks for `a`; a VIC-20
build turns that into the one fire line on its single port, an NES build into
bit 0 of the pad's shift register, an X16 build into its SNES-style pad. A
program that asks for `x` on a VIC-20 should get a compile-time answer, not a
silent false — the repo's standing rule is that anything a machine cannot do is
**refused by name**.

**Analog.** Worth having in the model even though only the web target can use
it today, and worth deriving digital directions from it so an analog stick
drives a VIC-20 program that has no idea analog exists. That is a projection,
and projections belong in the machine's input package, not in application code.

**Two ports, addressed portably.** Six of the nine machines have two. The
abstraction needs to name player 2 without naming a CIA register.

## Per-machine notes, from bringing them up

Things learned while getting these machines running that bear directly on
controller work:

- **PET** has no joystick ports at all (`input.joysticks: 0`). Joystick support
  was an aftermarket user-port affair. If it is ever added it belongs as a
  catalog option — a hardware profile choice, exactly like the PET's existing
  `model`/`ram`/`speaker`/`drive` axes — so the sheet keeps telling the truth.
- **NES vs Famicom** is a real distinction and the catalog now carries it. An
  American NES has no keyboard — none was ever released, though a US
  keyboard and Data Recorder were planned — so stock `nes` declares
  `input.keyboard: false`, and any design that quietly assumes a keyboard
  fallback breaks there. The **Japanese Famicom did**: Nintendo sold the
  Family BASIC Keyboard (HVC-007) in 1984, a 72-key matrix on the expansion
  port, scanned by driving `$4016` and reading `$4017`, with a Data Recorder
  (HVC-008) for cassette storage beside it. Family BASIC turned the machine
  into a small home computer, which makes the Famicom considerably more
  interesting for non-game software than the NES is.

  This is a hardware axis, not a second machine, so it is an option value:
  `--hardware expansion=familykeyboard` sets `input.keyboard: true`, passes
  `--input3 familykeyboard` to fceux (which lists `familykeyboard` among its
  famicom expansion devices), and contributes a `familykeyboard` tag a
  `.familykeyboard.8bs` variant file can key off. The fact and the emulator
  flag move together, which is the whole point of the catalog: a program
  asking `#fact(input.keyboard)` gets the truth for the machine it is
  actually being built for.

  What is *not* there yet is the driver. `packages/nes/src/` has `pad.8bs`
  and no `keyboard.8bs`; reading the HVC-007 matrix is the work that makes
  the fact mean something.
- **C128** reads CIA1 for input, and its text package maps colour RAM over
  `$DC00`-`$DFFF` when it needs the 80-column screen's high cells. Getting that
  wrong made `poll()` read the keyboard matrix *through colour RAM* and invent
  keypresses — a phantom LEFT that moved the board in 2048 before anyone
  touched a control. Controller code on this machine is close to a hardware
  window that other code moves.
- **CX16 has no joystick ports — its two ports are SNES-style pads**, which
  is why its sheet reads `joysticks: 0, pads: 2`. The confusion is worth
  naming because the machine invites it: the KERNAL's own API for reading
  those pads is called **`joystick_get` (`$FF56`)**, so X16 documentation says
  "joystick" while meaning a pad. This machine is precisely why counting
  `joysticks` and `pads` separately is right rather than pedantic — one number
  would have to lie about either the VIC-20 or the X16. (The repo's own sheet
  also flags *to verify: some boards carry 4* pad ports, so the count may yet
  change; the model does not.)

  **The X16 does not read them yet.** `packages/cx16/src/input.8bs` says so
  in as many words: the pads and the keyboard both need `asm6502` blocks that
  care about what the KERNAL expects to still be true when they are called,
  so `left()`/`right()`/`confirm()`/`cancel()` return false and a program
  still links. That is an honest stub, not a hidden gap — but it means 2048
  draws on the X16 and cannot be played on it. Wiring `joystick_get` is the
  single highest-value piece of input work outstanding.

  Its mouse *is* wired, through KERNAL calls inside opaque `asm6502` blocks —
  which is why the compiler cannot see them, and why the X16's zero-page
  budget has to stay conservative about the KERNAL's scratch.
- **web** reports `joysticks: 0, pads: 0`, which is wrong in spirit: it is the
  one target that can see a whole modern gamepad. Its sheet should say so once
  the model is widened, or the facts will mislead exactly the target with the
  most to offer.

## The rule that matters

Translation goes **machine → normalized**, never the other way. The public API
should never grow `c64Joystick()` / `nesController()` / `x16Gamepad()`.
Machine-specific surfaces already exist for people doing hardware work —
`@8bitscript/c64/joystick`, `@8bitscript/atari8/joystick`, `@8bitscript/nes/pad`
— and that is where they belong. Ordinary programs ask `input`.

## Development standard

The reference controller is an **8BitDo SN30 Pro in X-input mode** (power on
with **X + START**), which presents as an Xbox 360-style pad: D-pad, four face
buttons, two sticks, shoulders, triggers, Start/Select, stick clicks. It is a
superset of every target here, which is what makes it useful — the same
physical device exercises the thinnest projection and the widest one.

X-input is the development *backend*, not part of the language. Nothing in
`@8bitscript/input` should know the name.

The other three modes are worth knowing for testing, not for daily use:
**B + START** D-input/Android, **A + START** macOS, **Y + START** Switch Pro.

The canonical test program is the `joystick` example: an on-screen map of the
controls that lights each one as it is pressed. It should be part of bringing
up every new target, for the same reason screenshots already are — three real
miscompiles in this project were caught by looking at the screen and by nothing
else.
