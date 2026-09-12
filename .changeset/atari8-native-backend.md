---
"@8bitscript/compiler": patch
"@8bitscript/atari8": patch
---

The Atari 8-bit builds natively: hello-world and 2048 both run under atari800.

`packages/atari8`'s hardware sheet now carries `build.defsym.__load_address`
`$2000` and `__ram_ceiling` `$C000`. The difference, 40960, is the
`memory.ram` fact the catalog already published and the `LENGTH = 0xa000` the
pre-0.2.0 link script already had — three independent statements of the same
region. It is an over-claim by about 993 bytes at the top, where the OS's own
text screen and display list live; that is stated in
`packages/atari8/AGENTS.md` rather than enforced, the same way `banks.8bs`
states its `$4000` budget.

Zero page is `$80-$FF`. Every page-zero location the package records as the
OS's is below `$80` (RTCLOK, ATRACT, SAVMSC, RAMTOP), and the pre-0.2.0 DOS
link map already put a compiled program's registers at `$80` and its
variables from `$A0`. Unlike every Commodore, the polite and owned budgets are
the same 128 bytes: a program here cannot take the machine, because
`text.8bs` and `screen.8bs` read SAVMSC on every run of text and it is the
OS's vertical blank that copies the color shadows onto GTIA. Measured:
hello-world spends 19 bytes, 2048 spends 98.

`mos/image-atari8.ts` is the `.xex` container — a `$FFFF` marker, the RUN
segment writing the entry address to `$02E0`/`$02E1`, then the code segment,
in that order and with inclusive `end` addresses, reproducing byte for byte
the `xxd` of a working build `packages/atari8/AGENTS.md` records.
`entryIsVectored` is false, because Atari DOS really does `JSR` through
RUNAD — but a new `MachineImage.endsByHalting` makes `main()` spin anyway,
because the environment that regains control clears the screen and resets the
OS color shadows (measured under atari800 7.1.2, identical with `-basic`,
`-nobasic` and the stock config; the same program with a holding loop keeps
its greeting up indefinitely). Three bytes, and the only state in which what
a program drew is still what the machine is showing.

`waitFrame()` polls ANTIC's VCOUNT (`$D40B`), which counts half-lines exactly
the way the VIC-20's `$9004` does and therefore reuses its thresholds. It is
the first machine whose frame runtime keeps interrupts **on**
(`RasterSync.keepsInterrupts`): the OS's VBI is what this target's own
packages depend on, and the half-frame poll window is far too wide for a
handler to hide a wrap inside. `joystick.8bs`'s header already said a built
Atari program contains no `sei`; now it is true.

The thirteen cartridge media values are refused by name rather than wrapped
in a `.xex` container and written out as a `.rom` nothing could load.

Machine-independent: `--size`'s image-overhead line was `2 + stub.length`,
which is exactly a `.prg`'s load-address word and BASIC stub and silently
wrong for any other format — 10 bytes short on a `.xex`, short by the header
and ROM padding on a `.nes`. It is now derived as the difference between the
file and the linked code, so every target's size report sums to the real byte
count again, which is what `SizeReportEntry` already promised.
