---
"@8bitscript/compiler": patch
"@8bitscript/cli": patch
"@8bitscript/c64": patch
"@8bitscript/vic20": patch
---

Hello World runs on the C64 and the VIC-20, and reads as `Hello World` on both.

**A constant added to an index folds into the address.** `screenRam[i + 250] = 32` — the second quarter of the C64 and VIC-20 screen-clearing loops — was computing `i + 250` in an 8-bit register and indexing with the result. The sum wraps at 255, so from `i = 6` on every iteration wrote back over the first quarter and the rest of the screen was never cleared: a real miscompile, visible as a screen full of uncleared garbage. The 6502's answer is the other association, `STA base+250,Y`, which is exact for every index Y can hold and is what those loops were written in terms of all along ("four constant offsets off one 8-bit index is the shape a 6502 wants"). It is also smaller and faster: C64 hello-world went from 481 bytes to 424.

**The C64 and VIC-20 text packages draw in the mixed-case character set.** They selected the upper-case/graphics set and mapped only 64-95, leaving lower case at 97-122 — which in that set are graphics symbols, so `"Hello World"` drew as `H`, a graphic, three graphics, a space, `W`… Both ROMs were measured directly (`chargen-901225-01.bin`, `chargen-901460-03.bin`): the mixed-case set holds lower case at 1-26 and upper case at its own 65-90, exactly as the PET's does, and in the 96-127 block the two sets differ only at 105 and 122, which no block-graphics code uses. This is the same decision `@8bitscript/pet` took, for the same reason: it is the only set holding both cases, so it is the only one that can draw a string as it was written.

**The VIC-20's hardware sheet carries its load address and RAM ceiling**, because a RAM expansion moves both: `$1001` unexpanded, `$0401` with the 3K (which fills `$0400-$0FFF`), `$1201` with 8K and up (the screen drops to `$1000`). Each is checked against the catalog's own `memory.ram` fact. `__ram_ceiling` joins `__ram_size` as a spelling of the linker's ceiling, for machines whose usable RAM does not end on a whole number of KiB — unexpanded, the VIC-20's ends at `$1E00`, which is 7.5.

**Zero-page budgets for both.** The VIC-20 keeps a real polite shape and uses it: hello-world is 232 bytes and 4 zero-page bytes, and returns to a working BASIC. The C64 has no polite shape to keep — `setupVideo()` banks the KERNAL out and keeps it out, because the screen it sets up lives at `$E000` under the KERNAL ROM, so a C64 program that draws has already taken the machine — and takes the whole page.

Measured under x64sc and xvic: both show `Hello World!`. The PET is unchanged at 108/108/127 bytes.
