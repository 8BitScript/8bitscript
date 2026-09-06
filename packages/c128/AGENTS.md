# Writing Commodore 128 support for 8BitScript

This file is for anyone — human or agent — touching `packages/c128`,
`packages/backend-6502`'s `c128` entries (`DRIVER.c128`,
`FRAME_SYNC.c128`), `packages/cli`'s `x128` handling
(`VICE_EMULATOR_ARGS.c128`'s `-hidevdcwindow`, `VICE_MODEL_ARGS.c128`,
`-exitscreenshotvicii` in `screenshot.mjs`), or the C128 rows of
`docs/roadmap.md`, `docs/setup/vice.md` and `packages/studio/AGENTS.md`.
Read the root [`AGENTS.md`](../../AGENTS.md) first; the rules there apply
to every target and are not repeated. [`packages/c64/AGENTS.md`](../c64/AGENTS.md)
is the necessary companion: everything the C128's VIC-IIe, SID and CIAs do
is written there and is true here at the same addresses, and this file
does not repeat it. [`packages/cx16/AGENTS.md`](../cx16/AGENTS.md) is the
contrast for the rest of the machine: the X16 hides its video RAM behind a
port and its extra RAM behind a bank window, and so does the C128 —

> **The C128 is two computers sharing a case and one of them is a C64. In
> native mode it is an 8502 looking at 128K (or 256K) of RAM through one
> 64K window that an MMU rearranges, with a second, independent display
> chip — the 80-column VDC — whose 16K or 64K of RAM is reachable only
> through a two-byte port, plus the C64's VIC-IIe, SID and CIAs at the
> C64's addresses. A `$1C01` program for native mode does not run in C64
> mode and a `$0801` C64 program does not run in native mode. Model it as
> a banked C64 with a second screen behind a port — never as "a C64 with
> more RAM", and never as one screen.**

There are no hardware profiles yet. The axes that will become them are
real: 128K versus the 256K modification (`x128 -c128fullbanks`), a 16K
versus 64K VDC (`-VDC16KB`/`-VDC64KB`, the flat C128/C128D versus the
C128DCR), and — the big one — which screen a program is for.

## What exists today

Do not describe more than this as working:

- `packages/c128/src/index.8bs` exports four registers: `borderColor`
  (`$D020`), `backgroundColor` (`$D021`), `memoryPointer` (`$D018`) and
  `memoryPointerShadow` (`$0A2C`, VM1 — the KERNAL's shadow of `$D018`,
  which its screen-editor IRQ copies back over the register every
  interrupt in text mode; verified below).
- `src/screen.8bs` (behind `@8bitscript/screen`, as
  `@8bitscript/c128/screen`) and `src/text.8bs` (behind `@8bitscript/text`)
  are the portable surfaces, and both are hard-wired to the KERNAL's
  40-column screen: screen RAM `$0400` (40 × 25, 1000 cells), colour RAM
  `$D800`, both colour registers sixteen colours in the C64's numbering.
  `text.putChar` takes ASCII, converts to a screen code, writes `$0400 +
  cell` at any time, and before every run of text writes `$14` to the
  shadow and then the register — the shadow first, or the IRQ undoes it.
  There is no geometry file: nothing here moves with a profile yet.
- `FRAME_SYNC.c128` (`packages/backend-6502`) is the C64's level driver
  verbatim (`$D012` and `$D011` bit 7, the same NTSC 263 × 65 and PAL
  312 × 63 figures at the same clocks), on the strength of the SDK's
  `c128.h` mapping the VIC-IIe with the C64's `__vic2` struct — and
  **without the C64's `presync`**: a C128 program keeps the KERNAL's IRQ
  alive. The jiffy clock, the keyboard scan and the `$0A2C` copy all run
  under a program that calls `waitFrame()`; that is why the shadow write
  exists and why nothing here has needed `sei`.
- `8bs run c128` launches `x128 -model ntsc` (or `-model pal`)
  `-autostartprgmode 1 -hidevdcwindow`; `--screenshot` goes through
  `-limitcycles`/`-exitscreenshotvicii`, because plain `-exitscreenshot`
  captures the VDC's display and this target draws on the VIC-IIe's.
- `packages/studio/src/main.8bs` starts Studio's full tier on the C128 —
  the default, with no branch of its own (only the NES, VIC-20 and PET
  are demoted); the roadmap's "80-column UI, bigger maps" is the plan,
  not the state.

The C64's hardware subpaths — `sprites`, `keyboard`/`keys`, `joystick`,
`sid`, `video` — **do not exist for the C128**, although every register
they use is at the same address here. Nothing reaches the VDC, the MMU,
bank 1, the 2 MHz clock, the extended keyboard, the 1351, or C64 mode.
There is no banked-memory model in the language, no far pointer, no
second-screen capability and no profile — for the C128 or any machine.
The rules below are what to hold that work to.

## Facts verified here

Cite these freely; each was read in the source named, or seen on screen
under x128 (VICE 3.10, Homebrew) from a probe built with the installed
`mos-c128-clang` and read through `-exitscreenshotvicii`/`-exitscreenshot`.
VICE *source* facts were read in the project's trunk on SourceForge
(`vice/src/c128/`, `vice/src/vdc/`, `vice/src/vicii/`, `vice/src/joyport/`),
a newer revision than the installed binary.

| Fact | Where |
| ---- | ----- |
| The SDK links a C128 program into `ram` at `$1C01`, length `$A3FF` (to `$BFFF`, 41983 bytes), `__stack = 0xC000` (the C stack grows down from `$C000`, under the KERNAL ROM — the crt0's `__do_init_stack` is `lda #$00 / sta $0a / lda #$c0 / sta $0b`, static, unlike the VIC-20's MEMTOP call), imaginary registers from `$0A` (`__basic_zp_start = 0x000A`; `$02`–`$09` are the KERNAL's JMPFAR/JSRFAR parameters and left alone), zero page to `$8F` BASIC's. A `.prg` starts with a BASIC `SYS` line at `$1C01`. | `$LLVM_MOS_HOME/mos-platform/c128/lib/link.ld`, `commodore/lib/commodore.ld`, `llvm-objdump` of a linked build, `llvm-nm` (`__stack` = `0000c000`, `__rc0` = `0a`) |
| `init-mmu.o` (`INPUT` by link.ld, `.init.010`, the first thing `_start` does) saves `$FF00` to `__mmusave` and writes `$0E`: I/O in (bit 0 = 0), BASIC-lo ROM out (bit 1 = 1 → RAM at `$4000`–`$7FFF`), mid ROM out (bits 2–3 = 11 → RAM at `$8000`–`$BFFF`), KERNAL/chargen in (bits 4–5 = 00 at `$C000`–`$FFFF`), **RAM bank 0** (bits 6–7 = 00). `.fini.990` restores it. So the program, its data, its stack and the VIC's screen all live in bank 0; bank 1 is untouched and unreachable without changing `$FF00`. | `c128/lib/init-mmu.o` disassembly; the SDK's `init-mmu.S` ("map $4000-$BFFF to RAM, $C000-$FFFF to KERNAL/chargen"), `c128.inc` `MMU_CFG_RAM0_KERNAL = %00001110` |
| A plain SDK build prints PETSCII 14 before `main()` (`lda #$0e / jsr $FFD2` between `__do_zero_bss` and `main`) and the probe's text came up in lower case with `$D018` reading `$17` and `$0A2C` `$16`. `commodoreCharsetGuard()` keeps that out of an 8bitscript build. | `llvm-objdump -d` of the linked probe; probe screenshot |
| Boot state in native 40-column mode (`-model ntsc`, after `init-mmu`): `$FF00 = $0E`; `$D505 = $B7` (bit 0 = 8502, bit 6 clear = C128 mode, bit 7 set = 40/80 key up = 40 columns; `$D7 = $00`); `$D506 = $04` (1K common RAM at the bottom, VIC bank 0); page pointers `$D507/8 = $00/$F0`, `$D509/A = $01/$F0` (the high nybble reads as 1s); `$D50B = $20` (two 64K banks); `$D030 = $FC` (1 MHz; upper bits read as 1s); `$D02F = $F8`; `$00/$01 = $2F/$73`; `$D018 = $17`/`$0A2C = $16` (lower case, see above); `$0A03 = $00` (NTSC); `$D011 = $1B`, `$D016 = $C8`, `$DD00 = $C7` (VIC bank 0); `$0A2D = $78` (VM2, the KERNAL's bitmap layout: matrix `$1C00`, bitmap `$2000`). | probe screenshot `c128-probe-vic.png` |
| `$01` bits 0 and 1 on the C128 are **not** LORAM/HIRAM: bit 0 picks which 1K half of the 2K colour RAM the CPU sees at `$D800`, bit 1 which half the VIC sees (`mem_color_ram_cpu`/`mem_color_ram_vicii`, `&mem_color_ram[0x400]` when clear). Both were set (`$73`) at boot, so CPU and VIC share half 0. Banking is the MMU's, not the port's. | `c128mem.c` lines 542–558; probe |
| The MMU (`$D500`–`$D50B`, with `$FF00`–`$FF04` mirrors of registers 0–4 that stay visible in every configuration): CR bit 0 I/O, bit 1 BASIC-lo, bits 2–3 mid, bits 4–5 high, bits 6–7 RAM bank; MCR (`$D505`) bit 0 Z80/8502, bit 3 fast serial direction, bits 4–5 GAME/EXROM, bit 6 C64 mode (a 0→1 write switches), bit 7 the 40/80 key; RCR (`$D506`) bits 0–1 common size (VICE: 1K when 0, else `2048 << n` — 4K/8K/16K), bit 2 bottom, bit 3 top, bits 6–7 the VIC's RAM bank; `$D507`–`$D50A` page-0/page-1 relocation (latched, high byte commits on the low write); version `$D50B` reads `$20` ("always return 0x20 unless someone confirms 0x40"), even with `-c128fullbanks`. | `c128mmu.c` (`mmu_is_in_shared_ram`, `mmu_update_page01_pointers`, `mmu_is_c64config`, case 11) |
| **The `$D018` shadow is real**: writing `$D018 = $14` alone read back `$15` and the screen went back to lower case before the screenshot; writing `$0A2C = $14` then `$D018 = $14` held upper case. (`$D018` bit 0 is unused and reads as 1 on every VIC-II, so `$14` reads `$15`.) | probe screenshots `c128p-noshadow.png`, `c128p-shadow.png` |
| `$D030` bit 0 is the VIC-IIe's clock bit: writing 1 read back `$FD`, VICE sets `vicii.fastmode` and then steals no bad-line cycles (`vicii-fetch.c`: `if ((vicii.fastmode == 0) && …) dma_maincpu_steal_cycles`). **VICE 3.10 kept drawing a perfect 40-column picture in fast mode**; on a C64 `$D02F`/`$D030` are "(unused)" and read `$FF`. The SDK's `fast()` is `VIC.clock = 1` and its header says "This will disable video when in 40 column mode" — what the hardware's picture does at 2 MHz is *not* provable in this emulator (see below). | `vicii-mem.c` `d030_store`/`d02f_store`, `vicii-fetch.c`; probe `c128p-fast.png`; `c128/include/c128.h`, llvm-mos-sdk `c128.c` |
| `$D02F` is the VIC-IIe's extended-keyboard register: the low three bits drive three more column lines (`cia1_set_extended_keyboard_rows_mask`) for the numeric keypad and the extra keys; reads back `\| $F8`. | `vicii-mem.c` `d02f_store` |
| The VDC is two ports: `$D600` write = register select (0–37), read = status (bit 7 ready, bit 6 light pen, bit 5 "VBLANK" — set while the display is *disabled, i.e. in the top or bottom border*, "nothing to do with vertical retrace … despite the name & what documentation says", bits 0–2 the revision); `$D601` = the selected register. Register 31 reads or writes VDC RAM at the address in R18/R19 and increments it; R30 fills (or copies, R24 bit 7) a block through R32/R33. Reads of R31 and writes of R18/19/31 make the chip busy (43 cycles in the active area, 4 in the border, in VICE's model) — wait for bit 7. | `vdc-mem.c` (`vdc_store`, `vdc_read`, `vdc_perform_fillcopy`) |
| VDC state at boot (VICE NTSC C128, 40-column mode): status `$81` (ready, revision 1); R0 `$7E`, R1 `$50` (80 columns), R2 `$66`, R3 `$49`, R4 `$20`, R5 `$E0`, R6 `$19` (25 rows), R7 `$1D`, R9 `$E7` (8 lines per row), R12/13 `$0000` (screen), R20/21 `$0800` (attributes), R22 `$78` (8-pixel cells), R23 `$E8`, R24 `$20`, R25 `$47` (attributes on, text mode, hscroll 7), R26 `$F0` (foreground 15 on background 0), R27 `$00`, R28 `$2F` (characters at `$2000`; bit 4 clear — and it stays `$2F` under `-VDC64KB`: VICE's own FIXME says the bit "does *not* show how much ram is installed"). Five bytes written through R31 from `$0000` left R18/19 at `$0005`; the attribute bytes at `$0800` read `$07`, and **"HELLO" appeared on the VDC display while the KERNAL was in 40-column mode** — both screens are live at once, each with its own character set (the VDC's copy is in its own RAM at `$2000`; the VIC's is the ROM/`$D000` window). | probe screenshots `c128-probe-vic.png`, `c128-probe-vdc.png`, `c128-64k-vic.png` |
| VDC constants VICE builds on: 16 MHz dot clock, no sprites (`VDC_NUM_SPRITES 0`), 16 colours, 64 register slots of which 38 (0–37) are decoded (`regmask[38]`, `update_reg < 38`), attribute bits `$10` flash, `$20` underline, `$40` reverse, `$80` alternate character set (bits 0–3 the colour), 16 or 32 bytes per character, text/bitmap/idle modes (R25 bit 7 bitmap, bit 6 attributes on, bit 5 semi-graphics, bit 4 double-pixel "unsupported"), address mask `$3FFF` (16K) or `$FFFF` (`-VDC64KB`); "the VDC produces exact PAL & NTSC line frequency of 64us & 63.5us respectively with default kernal values" — its frame is its own, driven by R0–R9, not the VIC's. The 16K/64K difference is real chips (4416 vs 4464) and VICE maps addresses between the two layouts either way. | `vdctypes.h`, `vdc.c`, `vdc-resources.c`, `vdc-mem.c` (`vdc_16k_to_64k_map`) |
| x128 models: `c128` (flat: 6581, old CIA, VDC rev 1, 16K), `c128d` (same with a 1571), `c128dcr` (8580, new CIA, VDC rev 2, 64K, 1571CR), each PAL or NTSC; `-model` takes `c128`/`c128dcr`/`pal`/`ntsc`. Flags: `-40col`/`-80col` (the 40/80 key), `-go64` (C64 mode on reset), `-kernal64`/`-basic64`, `-c128fullbanks` (banks 2 and 3), `-VDC16KB`/`-VDC64KB`, `-VDCRevision 0..2`, `-machinetype 0..7` (keyboard/KERNAL nationality), `-controlport1device`/`-controlport2device` (1 Joystick, 2 Paddles, 3 Mouse (1351), 4 NEOS, 5 Amiga, 11–16 light pens on port 1, 10 Koala Pad, …), `-mouse` (host grab), `-fs8 <dir>`, `-8 <image>`, `-drive8type` (1541/1571/1581/…), `-reu`/`-reusize`, `-georam`, `-hidevdcwindow`, `-exitscreenshotvicii`. Timing: NTSC 65 × 263 at 1022730 Hz, PAL 63 × 312 at 985248. | `x128 -help`, `c128model.c`, `c128.h` |
| The 1351: movement on the pot lines (`(delta & 0x7f) + 0x40` — bits 1–6, read by the SID's `$D419`/`$D41A`), right button on UP, left button on FIRE; VICE's driver lists x128's native ports. The SmartMouse and Micromys are the same protocol with extras. | `mouse_1351.c` (port table, `mouse_get_1351_x`, `mouse_1351_button_*`) |
| The SDK's `c128.h`: VIC `$D000` (the C64's `__vic2`), SID `$D400`, VDC `$D600` (`ctrl`, `data`), CIA1 `$DC00`, CIA2 `$DD00`, `COLOR_RAM` `$D800`; `videomode(VIDEOMODE_40x25 / 80x25)` compares `$D7` and calls the KERNAL's SWAPPER; `c64mode()` is noreturn (KERNAL C64MODE); `fast()`/`slow()`/`isfast()` are `$D030` bit 0. `c128.inc` adds `PALFLAG $0A03`, `VM2 $0A2D`, `MODE $D7`, `MMU_CR $FF00` with the six `MMU_CFG_*` values, `VDC_INDEX/DATA`, `FETCH $02A2`/`STASH $02AF` (the KERNAL's cross-bank read/write stubs). | `c128/include/c128.h`, `c128/asminc/c128.inc`, llvm-mos-sdk `mos-platform/c128/c128.c` |
| The catalog's stock fact sheet, for the native 40-column mode this target boots into: the C64's grid, colours, glyphs, blocks, bitmap, scroll and 8 sprites; the SID's 3 voices as on the C64; keyboard, two ports; disk; 41983 bytes (`$1C01`–`$BFFF`), and bank 1's 64 KiB as banked RAM this build may use (`memory.banked`, `memory.bankedKib` 64; the `ram=256k` value makes that 192). The VDC's 80 columns are not on the sheet until an 80-column text package exists. | `src/text.8bs`; the `link.ld` and MMU rows above; `package.json` (read) |

## From the sources, not verified here

Leads to confirm the first time code depends on them. The *Commodore 128
Programmer's Reference Guide* and the 8563 datasheet are the primary
references; Bauer's VIC-II text (cited in the C64 file) for the VIC-IIe's
C64 half.

**Memory map, native mode, bank 0 as the SDK leaves it.** `$0000`–`$00FF`
zero page (`$00`/`$01` the 8502 port, `$02`–`$09` JMPFAR/JSRFAR, `$0A`–`$8F`
BASIC — the SDK's registers); `$0100` stack; `$0200`–`$03FF` KERNAL/BASIC
workspace (vectors at `$0314`…, the `$02A2`/`$02AF` cross-bank stubs at
`$02A2`–`$02FD`); `$0400`–`$07FF` the 40-column screen; `$0800`–`$09FF`
BASIC input/tape buffers; `$0A00`–`$0BFF` KERNAL variables (`$0A03` PAL
flag, `$0A2C`/`$0A2D` the VIC shadows); `$0C00`–`$0DFF` RS-232 buffers;
`$0E00`–`$0FFF` sprite definitions (the KERNAL's sprite area — 8 shapes);
`$1000`–`$11FF` function-key definitions; `$1200`–`$12FF` BASIC/DOS
variables (`$1210`/`$1212` MEMSIZ-like pointers); `$1300`–`$1BFF` unused
(free for machine code, the traditional home); `$1C00`–`$3FFF` BASIC
text (or, with BASIC's `GRAPHIC 1`, matrix at `$1C00` and bitmap at
`$2000`–`$3FFF`, and BASIC text moves to `$4000`); `$4000`–`$BFFF` BASIC
ROM (RAM underneath — what the SDK maps); `$C000`–`$FFFF` KERNAL ROM,
with I/O at `$D000`–`$DFFF` (VIC `$D000`, SID `$D400`, MMU `$D500`, VDC
`$D600`, colour RAM `$D800`, CIA1 `$DC00`, CIA2 `$DD00`, I/O1/2 `$DE00`/
`$DF00`) and the character ROM under it when bit 0 of `$FF00` is set — the
KERNAL's own routines bank it in through the MMU to read glyphs. **Common
RAM** (`$D506`): the low 1K (default) is always bank 0's, whatever bank the
CPU has selected, so zero page and the stack are shared. Bank 1 is BASIC's
variable/string bank; nothing in the ROM needs it for a machine-code
program, which makes it the obvious place for 64K of program data —
behind the MMU.

**Bank switching.** `$FF00`–`$FF04`: `$FF00` is the CR; writing `$FF01`–
`$FF04` loads the CR from the four preconfiguration registers `$D501`–
`$D504` (any value — it is the address that matters), which is how the
KERNAL's `JSRFAR`/`FETCH`/`STASH` switch quickly. The VIC's bank
(`$D506` bits 6–7) is independent of the CPU's: the VIC can display bank
1 while the CPU runs in bank 0 (with the `$DD00` 16K window on top of
that). The 256K modification adds banks 2–3 (`-c128fullbanks`; CR bits
6–7 both used); the standard machine wraps them to 0–1.

**The VDC (8563 / 8568).** Registers (all *to verify* against the PRG
beyond the boot readings above): R0–R7 horizontal/vertical totals and
sync (the KERNAL's values give 80 × 25 at 8 × 8, ~60/50 Hz); R8 interlace
(`%01` interlace sync, `%11` interlace sync-and-video — 640×400 or
80 × 50 text — with a real-hardware flicker); R9 lines per character row
(0–31); R10/R11 cursor; R12/R13 display start; R14/R15 cursor address;
R16/R17 light pen; R18/R19 update address; R20/R21 attribute start;
R22 character width (high nybble total, low displayed); R23 displayed
character height; R24 vertical smooth scroll (bits 0–4), blink rate (5),
reverse screen (6), copy/fill select (7); R25 horizontal smooth scroll
(0–3), double pixel (4), semi-graphics (5), attributes enable (6), bitmap
(7); R26 foreground (high nybble)/background colour when attributes are
off, and the background in text mode; R27 address increment per row (a
virtual screen wider than 80); R28 character base (bits 5–7, 8K steps —
`$2000` is `$20`) and RAM type (bit 4); R29 underline row; R30 word count;
R31 data; R32/R33 block copy source; R34/R35 display enable begin/end;
R36 refresh (DRAM cycles per line — 5 is normal; lower steals fewer
cycles). RAM layout as the KERNAL leaves it: `$0000`–`$07FF` screen,
`$0800`–`$0FFF` attributes, `$2000`–`$3FFF` characters (two sets of 256 ×
16 bytes: upper/graphics then lower; only the first 8 of 16 bytes of each
are shown at 8 lines per row — R9 + 1 lines are; at R9 ≥ 15 all 16, and
`bytes_per_char` becomes 32 above that). Colours are RGBI, one nybble:
bit 3 R, bit 2 G, bit 1 B, bit 0 intensity — 0 black, 1 dark grey, 2
blue, 3 light blue, 4 green, 5 light green, 6 cyan, 7 light cyan (the
`$07` attribute above did show as cyan), 8 red, 9 light red, 10 purple,
11 light purple, 12 brown/dark yellow, 13 yellow, 14 light grey, 15
white — a different order and a different set from the VIC's sixteen.
Text mode: 80 × 25 (or anything R1/R6 allow — 100 columns is VICE's
`MAX_TEXTCOLS`), one attribute byte per cell (colour + flash/underline/
reverse/alternate set), background from R26, 8 × 8 cells of 8 × 16 data.
Bitmap mode: 640 × 200 (R1 × 8 by R6 × (R9 + 1)), one bit per pixel,
16000 bytes; with attributes on, each 8 × (R9 + 1) cell takes its
foreground (low nybble) and background (high nybble) from the attribute
byte — the nybble order in bitmap mode is *to verify*; with attributes
off the whole picture is R26's two colours. 640 × 400 needs interlace
and 32000 bytes — 64K VDC only in practice. There is no hardware
scrolling beyond R24/R25's smooth scroll plus moving R12/R13 (which is
a whole-screen scroll, cheap), no sprites, no raster interrupt, no
collision, and every byte goes through R31 one at a time (or R30's
fill/copy for runs). The VDC's frame and the VIC's are unrelated
clocks; a program that draws on both waits on each separately (the VDC:
status bit 5, the border, not vsync).

**2 MHz.** `$D030` bit 0 doubles the 8502's clock; in 40-column mode the
VIC-IIe cannot fetch at that rate and the picture is corrupt (BASIC's
`FAST` blanks the VIC through `$D011` DEN for exactly this reason; `SLOW`
restores). The VDC is unaffected — 80-column programs run at 2 MHz as a
matter of course. Doing 2 MHz work inside the VIC's vertical border and
dropping back before the display starts is the known trick for 40-column
programs; it needs the raster and is *to verify* cycle-for-cycle. VICE
emulates the speed, not the corruption (verified above). Also at 2 MHz:
the SID's timing is unchanged (it has its own clock line), CIA timers
count 1 MHz cycles — *to verify*; and the undocumented `ANE` opcode uses
`$EE` instead of `$FF` as its magic constant (VICE models it).

**C64 mode.** Holding C= at reset, `GO 64`, `$D505` bit 6, or the KERNAL's
`C64MODE` (`$FF4D`) reconfigures the MMU to the C64 map (`mmu_config64`),
loads the C64 KERNAL/BASIC (`-kernal64`/`-basic64` in VICE), and the
machine is a C64 with three tells: `$D02F`/`$D030` still exist (the
VIC-IIe's, "visible in 64 mode" per `c128.inc`), the MMU is gone (`$D500`
reads `$FF`), and the 8502's `$01` bits 0–2 are LORAM/HIRAM/CHAREN again.
A `mos-c64-clang` build runs there; a `mos-c128-clang` build does not (it
loads at `$1C01` with a native-mode `SYS` line, and BASIC 2 starts at
`$0801`). The reverse holds too. There is no way back to native mode
except reset.

**Keyboard.** The C64's 8 × 8 matrix through CIA1 plus three more
columns through `$D02F` (K0–K2: the keypad, HELP, LINE FEED, ESC, TAB,
ALT, NO SCROLL, the cursor keys); CAPS LOCK is `$01` bit 6 (a level, not
a matrix key — "on the international version, A8 of the chargen comes
from the c64/c128 mode, not from the status of the DIN/ASCII (capslock)
key" per VICE); 40/80 DISPLAY is `$D505` bit 7, read-only.

**Storage.** IEC serial as the C64's, plus the 1571's fast serial (CIA1's
SDR clocked by the MMU's fast-serial bit — burst mode, ~10× faster) and
the 1581. VICE: `-8 image.d64/.d71/.d81`, `-fs8 <dir>`, `-drive8type`.
The C128D/DCR have a built-in 1571. REU (1700/1750) and GeoRAM as on the
C64, through `$DF00`/`$DE00`; the REU's DMA sees whichever RAM the MMU
has mapped — *to verify* how it interacts with `$FF00`. Cartridges: the
C64 port, with C128 "function ROMs" as an internal/external option
(`MMU_CFG_IFROM`/`EFROM`).

**Sound.** The SID (6581 in the flat C128, 8580 in the DCR) exactly as
the C64 file describes it, at `$D400`; its paddle inputs are the 1351's
lines. Nothing else.

**Z80.** An 8-bit Z80 at 4 MHz (effectively ~2) that boots first and
hands over to the 8502, present for CP/M only. Off the map for this
project; `$D505` bit 0 is the only place it shows.

## Misreadings a C64 programmer brings here

There were no research notes behind this file — it was written from the
sources in the table above — but everyone arrives here knowing the C64,
and these are the C64 facts that are wrong on this machine:

- **"The C128 has 128K the program can use."** The SDK gives a program
  bank 0, `$1C01`–`$BFFF`, ~41K — *less* than the C64's 51K, because the
  KERNAL stays in and BASIC's low RAM is reserved. The other 64K is a
  bank switch away and the language cannot express it yet.
- **"`$01` banks the ROMs as on the C64."** Not in native mode: the MMU
  does, and `$01` bits 0–1 pick colour-RAM halves. Writing a C64 `$01`
  value here changes which colour RAM the VIC shows.
- **"80 columns is a mode of the same screen."** It is a second chip with
  its own RAM, palette, character set, attribute model and frame clock.
  `@8bitscript/screen` and `/text` are the VIC's; the VDC will be this
  package's own export.
- **"Set `$D018` to change the character set."** Set `$0A2C` first; the
  KERNAL's IRQ is alive here and writes the shadow back.
- **"FAST doubles everything."** It doubles the CPU, breaks the 40-column
  picture on hardware, and leaves the VDC, SID and CIAs on their own
  clocks. VICE will not show the breakage.
- **"Sprites are at `$0E00`"** is the KERNAL's convention for BASIC's
  `SPRITE` commands; a program that owns the VIC bank chooses its own,
  and the C64 file's bank-3 layout does not apply either: the KERNAL ROM
  is *in* at `$C000`–`$FFFF` here and the VIC's bank 3 (`$C000`) shows
  RAM under it to the VIC but is not where the SDK's program can put data
  without banking the ROM out per access.

## Rules for this target

### Two screens, and the portable one is the VIC's

- `@8bitscript/screen` and `@8bitscript/text` are the 40-column VIC-IIe
  picture, at the KERNAL's `$0400`/`$D800`, and stay so: that is the one
  picture every Commodore target has. The VDC is this package's own
  export (`@8bitscript/c128/vdc`, when it comes), with its own text
  surface (80 × 25, an attribute byte per cell, RGBI colours, an
  alternate-set bit), never a `text.COLUMNS = 80` profile of the VIC's
  surface — the two do not share memory, colours or a frame.
- Every VDC access is register-select, wait-for-ready, data. Write it
  once (`select(r)`, `write(r, v)`, `read(r)`, `setAddress(a)`, then a
  stream through R31 using the auto-increment and R30's fill for runs)
  and let nothing else touch `$D600`/`$D601`. R18/R19 and the selected
  register are shared mutable state, like VERA's ports on the X16. The
  KERNAL's screen editor drives the VDC when 80 columns is the active
  screen, and the probe saw the KERNAL leave the VDC alone in 40-column
  mode (HELLO survived); whether its IRQ ever touches `$D600` in
  40-column mode (cursor blink, the 40/80 key) is *to verify* — until
  then a program that takes the VDC over either keeps the editor out
  (never call SWAPPER/CHROUT) or lets it own the chip.
- Waiting on the VDC's status bit 5 waits for the *border*, not for
  vertical sync; a frame-exact VDC effect needs a different scheme
  (light-pen latch, or counting from the border edge) — design it, don't
  assume the bit.
- The VDC's 16K/64K is a profile axis when a bitmap or an interlaced mode
  wants more than 16K; text at 80 × 25 fits in the smallest chip and a
  program must not assume more without a profile saying so. R28 bit 4
  does not tell it (verified); a probe writes past `$3FFF` and reads back.

### The MMU is global state and the program lives in bank 0

- `$FF00 = $0E` from `_start` to `exit`; the SDK restores the KERNAL's
  value on return. Nothing in a program changes `$FF00` casually: a far
  reference is a (bank, address) pair the language does not have yet, and
  when it does, a far read is `$FF00` (or the `$FF01`–`$FF04` preconfigs),
  the access, `$FF00` back — under `sei` if the KERNAL IRQ could land in
  between with the ROM banked out (the KERNAL's own `FETCH`/`STASH` stubs
  at `$02A2`/`$02AF` are the reference implementation, and live in common
  RAM for the reason). Bank 1 is the data bank; the common 1K makes zero
  page and the stack visible from both.
- The VIC's bank (`$D506` bits 6–7) and the CPU's are separate: putting
  the picture in bank 1 and the program in bank 0 is a legitimate layout,
  and it is a decision `Video` makes once, in writing — the C64 file's
  rule about who owns which RAM applies with a second dimension.
- `$01` is read, masked, written; bits 0–1 are colour-RAM selection and a
  C64 constant (`$35`, `$36`, `$37`) is meaningless here.
- `$D500`–`$D50B` are reachable only with I/O in; `$FF00`–`$FF04` always.
  Write the mirrors.

### The KERNAL IRQ is alive here

- Unlike the C64 and the PET, a C128 build does not `sei`: the keyboard
  scan, jiffy clock, `$0A2C`/`$0A2D` copies and the cursor all run. Any
  register the KERNAL shadows (`$D018`, and the VIC control registers in
  graphic modes — *to verify* which) is written shadow-first. A future
  raster or sprite layer that needs the IRQ gone takes the C64 file's
  route (`presync: sei`) deliberately and then owns the keyboard too;
  until then, input can come from the KERNAL's buffer as well as the
  matrix.
- With the IRQ alive, CIA1's ports are the KERNAL's between scans; a
  keyboard or joystick snapshot reads them under `sei` (or reads the
  KERNAL's buffer) — the C64's snapshot discipline plus the interrupt
  it lacks there.

### The C64 half is the C64's

- VIC-IIe registers, sprites (8, 24 × 21, per-line limit 8), SID, CIAs,
  colour RAM, the `$DD00` 16K window, bad lines: every rule in
  `packages/c64/AGENTS.md` holds, at the same addresses. When the C64's
  `sprites`/`sid`/`keyboard`/`joystick` layers are made available here
  they are *this package's* exports over the same registers — not a
  shared implementation, because the frame prologue, the IRQ state, the
  VIC bank and the memory map differ. `$D02F` adds three keyboard
  columns; `$D030` adds the clock bit; nothing else is new.
- The character ROM is under the I/O area only through the MMU (`$FF00`
  bit 0), not `$01`. A RAM charset for the VIC goes in bank 0 RAM the
  VIC can reach (its `$DD00` window over the `$D506` bank), and the
  linker owns `$1C01`–`$BFFF`: reserve, as the C64 file reserves bank 3.

### 2 MHz is a mode, not a speed-up

- `$D030` bit 0 belongs to a capability (`fast()`/`slow()` with the
  vertical-border trick, or "80-column program" as a profile), never to
  a program's own poke. The hardware breaks the 40-column picture; the
  emulator does not show it; so a `--screenshot` proves nothing about it.
  Any 2 MHz code is written against the sources and checked on hardware
  or a cycle-exact emulator before it is called working.

### Native mode is the target, and C64 mode is a different target

- `mos-c128-clang` output runs only in native mode; `8bs run c128` never
  passes `-go64`. A program that wants C64 mode is a `c64` build and runs
  under `x64sc` (or `x128 -go64` by hand). `c64mode()` exists in the SDK
  and is noreturn; do not wrap it.
- The VIC-IIe's `$D02F`/`$D030` are visible in C64 mode; a `c64` build
  must never write `$D030` bit 0 "because it is unused on the C64" — on
  a C128 in C64 mode it switches to 2 MHz and corrupts the picture.

### Profiles, when they come

- RAM (128K/256K), VDC RAM (16K/64K), and the board (flat/D/DCR: 6581 vs
  8580, VDC revision, built-in 1571) are the real axes; `x128 -model`
  and `-c128fullbanks`/`-VDC64KB` name them. Region is runtime (the frame
  driver probes it; `$0A03` says what the KERNAL found). Screen (VIC vs
  VDC) is not a profile: a program imports what it uses.

## Seeing the screen without a human at x128

`8bs run c128 --screenshot <file.png>` builds and captures the VIC-IIe's
display through `-limitcycles`/`-exitscreenshotvicii` (see
[`docs/setup/verify.md`](../../docs/setup/verify.md#screenshots)). The
VDC's display is `-exitscreenshot`: `x128 -model ntsc -autostartprgmode
1 -limitcycles 9000000 -autostart dist/main-c128.prg -exitscreenshotvicii
vic.png -exitscreenshot vdc.png` writes both, which is how the "HELLO on
the VDC in 40-column mode" row above was checked; `-80col` boots with the
80-column screen active. The probe that produced the boot-state rows is
a C program printing registers as hex into `$0400` — cheap to redo when
a fact here is doubted.

## Where things live

```
packages/c128/src/index.8bs             target package: borderColor ($D020), backgroundColor ($D021), memoryPointer ($D018), memoryPointerShadow ($0A2C)
packages/c128/src/screen.8bs            @8bitscript/c128/screen: sixteen colours in both registers, blank() over 1000 cells at $0400
packages/c128/src/text.8bs              @8bitscript/c128/text: ASCII → screen code, shadow-then-register, 40 × 25 at $0400/$D800
packages/backend-6502/src/index.mjs     DRIVER.c128 (mos-c128-clang), FRAME_SYNC.c128 (the C64's level driver, no presync), commodoreCharsetGuard()
packages/cli/src/run.mjs                VICE_EMULATOR_ARGS.c128 (-hidevdcwindow), VICE_MODEL_ARGS.c128 (-model ntsc/pal)
packages/cli/src/screenshot.mjs         -exitscreenshotvicii, VICE_CLOCK_HZ.c128
packages/c64/AGENTS.md                  the VIC-IIe/SID/CIA half of this machine, and the rules for it
packages/studio/src/main.8bs            Studio's full tier — the default, the C128 has no branch of its own
docs/setup/vice.md                      installing x128 with the other VICE emulators
docs/roadmap.md                         Phase 2: "the first real test of the memory model"; the C128 as Studio's second reference machine
$LLVM_MOS_HOME/mos-platform/c128/       link.ld ($1C01–$BFFF, __stack $C000), init-mmu.o ($FF00 = $0E), c128.h/_vdc.h/_vic2.h/_sid.h/_6526.h, asminc/c128.inc (MMU_CFG_*, VDC_*, shadows)
vice/src/c128/ (SourceForge trunk)      c128mmu.c (the MMU), c128mem.c ($01 and colour RAM), c128model.c, c128.h (timing)
vice/src/vdc/                           vdc-mem.c (the port, status bits, fill/copy), vdctypes.h (attributes, sizes), vdc.c (its own frame), vdc-resources.c (16K/64K)
vice/src/vicii/vicii-mem.c              d02f_store, d030_store (the VIC-IIe's two extra registers)
```
