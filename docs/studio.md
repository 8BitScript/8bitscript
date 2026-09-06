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

The front door. Studio draws its title, its version, the tier the machine
you started it on gets, and which editors that tier opens — and says
`NO INPUT YET`, because that is true: the language has no input, sound,
sprite, or storage capability yet, and every editor is waiting on one of
them. Nothing on this page describes an editor as working.

```bash
cd packages/studio
pnpm start                     # the Commander X16
pnpm run start:pet             # the PET
8bs run nes --screenshot studio-nes.png
```

From VS Code, **8BitScript: Launch Studio** asks which system and runs the
same command; the rocket in the Projects view's title does the same.

## Tiers

Studio's reference machine is the Commander X16, and every other machine
runs the same program at the tier its hardware supports. A higher tier
opens everything a lower one does, and a file is never tied to the tier
that made it: whatever a PET saves, an X16 opens and edits.

The tier is picked from the machine's facts, not its name: no keyboard
(`Input.KEYBOARD`) is the viewer tier, no hardware sprites
(`Video.SPRITES`) the basic tier, and anything else the full tier. That
is why the web is a viewer today — its runtime has no keyboard yet — and
why a new machine lands on the right row without anyone editing Studio.

| Tier | Machines | Characters | Sprites | Music | Files |
| --- | --- | --- | --- | --- | --- |
| Full | Commander X16, MEGA65, C128, C64, Atari 8-bit | edit | edit | edit | load, save |
| Basic | VIC-20, PET | edit | view | play | load, save |
| Viewer | NES, web | view | view | view | none |

The table is the design, not a measurement; the reasoning behind each row,
and what has still to be verified on the hardware, is in
[`packages/studio/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/studio/AGENTS.md).
