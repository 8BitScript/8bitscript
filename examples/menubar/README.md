# menubar

A menu bar you can drive, across the top of every target, from one source
file, using [`@8bitscript/ui/menubar`](../../packages/ui) and
[`@8bitscript/input`](../../packages/input). An icon and one menu, starting
deselected; left and right move the highlight under whatever the machine
has — cursor keys, a joystick, an NES D-pad, or a 1351 mouse.

```bash
pnpm start              # C64
pnpm run start:nes      # the D-pad — this is the one the pad was written for
pnpm run start:web      # browser
```

Every target has a `start:<target>` script (`vic20`, `c64`, `pet`, `c128`,
`atari8`, `nes`, `cx16`, `mega65`, `web`); `build` and `build:<target>`
compile to `dist/` without opening the emulator.
`8bs run <target> --screenshot <file.png>` captures one frame instead of
opening a window.

## What it shows

`src/main.8bs` names no machine. It draws the bar with four calls —

```
menubar.begin(0, text.COLUMNS);
menubar.icon();
menubar.item("FILE");
menubar.end();
```

— and reads input with one more:

```
input.poll();
if (input.right()) { menubar.next(); }
if (input.left())  { menubar.previous(); }
```

The same file puts the same bar on all nine machines and moves it under
nine different pieces of hardware. What differs is what each machine can
*say*, and the three lines under the bar are the program asking it:

| Line | What it reads |
| --- | --- |
| `ITEM` | Which item is highlighted, or `NONE` — a bar starts deselected |
| `MARK` | `INVERT`: reverse video on every machine |
| `MOUSE` | `NO`, or `LOOKING`/`FOUND` on a build fitted with one |

## The highlight is reverse video

The selected item is inverted on every machine — a filled bar of the item
colour, letters punched out, padding included. That is `text.setReverse`,
and each machine's text package decides how invert reaches the screen: a
ROM copy at ASCII+128 on the Commodores and the NES, swapped attribute
nibbles on the X16, colour bit 7 on the web.

`video.colorPerCell` is still a real split (the PET, the Atari 8-bit and
the NES cannot give one cell its own colour) but the bar does not use it
for this. Invert does not need per-cell colour.

Note that `video.cellColors` — which is 2 on all nine, PET included — does
not answer the per-cell-colour question, and that is why
`video.colorPerCell` exists. A PET cell does hold two colours. They are
just not a program's to set.

## The mouse is a build decision *and* a run-time answer

This is the two-stage shape the fact sheet is built around, and a C64 shows
both halves of it:

```bash
8bs build --target c64                              # 1517 bytes, 28 B of RAM
8bs build --target c64 --hardware port1=mouse1351   # 2007 bytes, 45 B of RAM
```

**490 bytes of program and 17 bytes of RAM** is what a mouse costs, and a
build that did not ask for one pays none of it — `#fact(input.mouse)` is
false, so the pointer code is not reached, not referenced, and not linked.
The `MOUSE` line reads `NO` there, and the branch that would have printed
anything else is gone.

Ask for the mouse and the code is compiled in — but whether a 1351 is
really plugged in is still not something the build can know, so
`input.pointer()` answers it every frame from
[`@8bitscript/c64/mouse`](../../packages/c64/src/mouse.8bs)'s probe. That is
what `LOOKING` versus `FOUND` is: the build may use a mouse, and this frame
either sees one or does not.

Hover works where the pointer does: the bar is told where the pointer is
with `menubar.point(cell)`, each item works out whether it is the one under
it, and the *program* decides that hovering should move the highlight. The
component never reads input.

## What drives it on each machine

| Machine | Moves the highlight | Notes |
| --- | --- | --- |
| C64 | cursor keys (SHIFT for left/up), joystick 2, 1351 in port 1 | the one machine with all three |
| C128, MEGA65 | cursor keys, joystick 2 | the C64's matrix at the C64's addresses |
| PET | cursor keys | no control ports at all — the machine predates them |
| Atari 8-bit | CTRL + `+` `*` `-` `=`, joystick 1 | no arrow keys; those four are what an Atari uses |
| NES | the D-pad on controller 1 | A or START confirms, B cancels |
| VIC-20 | joystick only | right is on a keyboard-column line; see below |
| X16 | the KERNAL mouse | keyboard and pads are still KERNAL calls this layer does not make |
| web | nothing yet | the runtime does not listen |

Two of those are worth reading the source for. The **VIC-20** splits one
joystick across two chips — up, down, left and fire on VIA1, and *right* on
VIA2 port B bit 7, which is otherwise a keyboard column output, so reading
it means turning that one bit around and putting it back. The **X16** has
the most input hardware of the nine: its mouse is a KERNAL service
(`$FF68` / `$FF71` / `$FF6B`) and that half of the layer now answers; GETIN
and joystick_get are the next calls, not a gap the file hides.

## Why the bar fits everywhere now

An earlier version of this example drew four items — `FILE EDIT VIEW HELP`
— which needed 24 cells and did not fit the VIC-20's 22, and the example
existed partly to show that clipping worked. An icon and one menu is 11
cells and fits every machine including the VIC-20 and the NES's 28.

Clipping is still there and still tested (`menubar.clipped()`, and
`packages/ui/test/menubar-probe.8bs` links the whole surface for all nine);
it is just no longer what this example is about. What it is about now is
that one source file reads nine different input devices and draws the
highlight two different ways, and never names a machine to do either.

## Where the pieces come from

`@8bitscript/ui` is the component library and `@8bitscript/ui/menubar` is
one component in it, built on `@8bitscript/text` and nothing
machine-specific. `@8bitscript/input` is a capability package: it has no
source of its own at all, just a map from each target to that machine's
`input` layer, the same way `@8bitscript/text` works. See
[`packages/ui/README.md`](../../packages/ui/README.md) for the bar's full
surface and [`packages/ui/AGENTS.md`](../../packages/ui/AGENTS.md) for what
the character grid gives you on each machine.
