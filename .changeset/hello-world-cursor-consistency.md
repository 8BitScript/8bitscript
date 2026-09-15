---
"@8bitscript/pet": patch
"@8bitscript/vic20": patch
"@8bitscript/c64": patch
"@8bitscript/c128": patch
"@8bitscript/cx16": patch
"@8bitscript/mega65": patch
"@8bitscript/atari8": patch
"@8bitscript/nes": patch
"@8bitscript/web": patch
"@8bitscript/examples": patch
---

`@8bitscript/text`'s portable surface gets a new `releaseCursor()`:
`text.print()`/`screen.blank()` write straight into screen memory on
every Commodore target, which the KERNAL's own cursor tracking never
sees, so `READY.` used to print wherever the boot/LOAD/RUN echo had left
the cursor — a different number of blank lines on every machine, with no
relation to what the program actually drew.

VIC-20, C128 and MEGA65 now call KERNAL PLOT ($FFF0) to park the cursor
explicitly, giving a consistent, deterministic one blank line between a
program's last output and `READY.` (measured under xvic/x128/xmega65).
PET, C64 and CX16 stay honest no-ops for now — PET's ROM predates PLOT
and a direct zero-page poke didn't move `READY.` in testing; C64 banks
the KERNAL out permanently so main() never really returns to it; CX16's
text grid is inset from the KERNAL's own screen coordinates and is
already correct by accident, which a naive PLOT call risked breaking.
Atari 8-bit, NES and the web target were already honest no-ops, since
none of them return to a BASIC prompt.

`packages/examples/hello-world`'s entry file is renamed from `main.8bs`
to `hello-world.8bs` (and calls `text.releaseCursor()` after printing),
matching the project's own name rather than the generic default.
