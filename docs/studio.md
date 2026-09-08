---
title: Studio
nav_order: 6
---

# Studio

**8BitScript Studio** is the asset editor that ships with the toolchain and
runs on the machines themselves: a character editor, a sprite editor, a
music tracker, and the file handling that brings what you make there back
into your project. It is written in 8BitScript, built by the same compiler
as your program, and started by the same `8bs run <target>`.

It ships as `@8bitscript/studio`, a dependency of `@8bitscript/cli`, so
installing the toolchain installs it, and its version is the toolchain's.
It is the first of the **apps** — programs that come with the toolchain
rather than being written against it; [the package model](packages.md#apps)
says how a package declares itself one.

## What runs today

The front door. Studio draws a menu bar across the top row, then its title,
its version, the tier the machine you started it on gets, which editors that
tier opens, and what is driving it — `INPUT KEYS` on the computers and the
web, `INPUT PAD` on the NES, each folded from the
machine's own facts while compiling.

**The bar moves.** `@8bitscript/input` exists now, so left and right step
the highlight between Studio's icon and its FILE menu under whatever the
machine has: a C64's cursor keys, an NES D-pad, an Atari joystick, a 1351
mouse in a port on the C64 or the C128, the X16's KERNAL mouse. The bar
starts deselected, the way a menu bar does before anyone has touched it.
On a build with a pointer, a click on the bar selects the item under it.

Everything behind the door is still waiting. Studio has no sound, sprite or
storage capability to build an editor on, and nothing on this page
describes an editor as working.

The bar is `@8bitscript/ui/menubar` — the first component Studio takes from
[the shared component library](packages.md#which-packages-you-install)
rather than drawing itself. It is Studio's mark and the FILE menu, and that
is the whole bar for now. Nothing behind FILE opens yet: there is still no
sound, sprite or storage capability to build an editor on.

```bash
cd packages/studio
pnpm start                     # the Commander X16
pnpm run start:pet             # the PET
8bs run nes --screenshot studio-nes.png
```

From VS Code, **8BitScript: Launch Studio** asks which system and runs the
same command; the rocket in the side bar's title does the same.

## Tiers

Studio's reference machine is the Commander X16, and every other machine
runs the same program at the tier its hardware supports. A higher tier
opens everything a lower one does, and a file is never tied to the tier
that made it: whatever a PET saves, an X16 opens and edits.

The tier is picked from the machine's facts, not its name, in two steps.
First, can this build edit at all? It needs a keyboard (`Input.KEYBOARD`)
and room to hold an editor and the playback that keeps running while you
use it (`Memory.RAM`, against Studio's 8 KB editing budget). Then, how
much has anything to edit? A redefinable character set (`Video.GLYPHS`),
hardware sprites (`Video.SPRITES`) and more than one voice
(`Audio.VOICES`) — all three is the full editor, some of them the basic
one, none of them a viewer. A new machine lands on the right row without
anyone editing Studio.

| Tier | Machines | Characters | Sprites | Music | Files |
| --- | --- | --- | --- | --- | --- |
| Full | Commander X16, MEGA65, C128, C64, Atari 8-bit | edit | edit | edit | load, save |
| Basic | VIC-20 with 8K or more | edit | view | edit | load, save |
| Viewer | PET, VIC-20 (stock, 3K), NES, web | view | view | play¹ | load² |

¹ where there is a voice: the PET's square wave and the NES's APU play; the
web has no sound yet and only views. ² where there is storage: every PET
and every VIC-20 loads; the NES on a plain cartridge and the web have
nowhere to load from.

The viewer tier is read-only — view, play, load, never edit or save — and
the four machines on it are there for different reasons. The NES has no
keyboard. The web now reads keys, and is a viewer because it has nothing
to edit. The stock
VIC-20 has a keyboard and not the room: **a RAM expansion lifts it**, and
`8bs run vic20 --profile 8k` is Studio with editors on. The PET has both
the keyboard and, on a 3032, 31743 bytes — more than the VIC-20 that
edits — and is a viewer for what the machine is: its font is in ROM, it
has no sprites, and its one voice has no volume. No expansion lifts the
PET.

The table is the design, not a measurement; the reasoning behind each row,
and what has still to be verified on the hardware, is in
[`packages/studio/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/studio/AGENTS.md).
