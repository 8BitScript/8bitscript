---
"@8bitscript/c64": patch
---

Correct two things the C64's package said that were no longer true.

The description still read "Parked in 0.2.0: not a build target until its native backend lands." The C64 is in `RELEASE_MACHINES` (`packages/compiler/src/resolver/index.mjs`), which is the list `8bs build` and `8bs run` will actually produce a program for, and every example in this repo names `c64` among its targets. The four machines whose descriptions still say it — `atari8`, `c128`, `mega65`, `nes` — really are parked, and keep theirs.

The `ram` option was labelled "RAM Expansion Unit", which names one occupant of a slot that has several. A C64 has a single cartridge port, and Commodore's REU is only one of the banked-RAM cartridges that go in it: GeoRAM, RamCart and RamLink are others, each with its own VICE flag (`-georam`, `-ramcart`, `-ramlink`) and its own way of being addressed. The axis is "what RAM expansion is fitted", so the option key `ram` was right and only the label was too narrow; it is now "RAM expansion". The values are unchanged and still all REUs, so no build, profile or `--hardware ram=…` spelling moves.

The `drive` option is gone. Its four values (1541, 1571, 1581, none) moved `storage.save` and `storage.kib` — what a program may assume it can save — while passing VICE nothing at all, so choosing a 1581 changed a number on the fact sheet and left the emulated machine exactly as it was. That was deliberate rather than an oversight (`packages/cli/test/hardware.test.mjs` said so out loud: "on the C64, a drive is not linked in and is not an emulator flag at all"), but it promised a capacity no program could reach: nothing in this repo saves anything yet — no package calls the KERNAL's `SETLFS`/`SETNAM`/`SAVE`, and no `.8bs` surface offers saving — so the axis graded builds against a medium that was never attached.

`packages/c64/AGENTS.md` already described the catalog as "the REU, the SID, and what is in each control port", and its "Where things live" table already listed `ram (REU), sid, port1, port2`. The drive had been added without either being updated; the package now matches its own documentation again.

The stock sheet is unchanged — `storage.save: true`, `storage.kib: 164` — because a C64 with a 1541 is the machine as sold and that is the assumption a program is entitled to make. What is gone is the *choice*: `--hardware drive=1581` on a C64 is now an unknown value, named with the options that do exist. The PET keeps its own drive axis, which is real: it passes `-drive8type` per value and VICE attaches the drive. The C64's comes back the same way when there is a save API to make it mean something. `c128` and `vic20` still carry the same facts-only drive axis this removes, and are the same decision waiting to be made.

Nothing here changes a build, a tag, or a linked image.
