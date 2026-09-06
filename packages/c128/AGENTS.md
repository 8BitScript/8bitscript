# Writing Commodore 128 support for 8BitScript

This file is for anyone — human or agent — touching `packages/c128` (its
`package.json` holds the [hardware catalog](#the-catalog); a new `detect`
in it must also be added to the inventory `packages/cli/test/hardware.test.mjs`
pins, or that test fails),
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

The machine's variants are in the catalog now — `"8bitscript".hardware` in
this package's `package.json`, eight options and six presets, described
under [The catalog](#the-catalog) below. The axis that is *not* there, and
is the big one, is which screen a program is for: that is still "a program
imports what it uses", and the reasons are in
[Two screens](#two-screens-and-the-portable-one-is-the-vics).

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
- `src/vdc.8bs` (`@8bitscript/c128/vdc`) is the 80-column chip's access
  layer and nothing more: `select`/`write`/`read` (select, poll bit 7,
  transfer), `status`/`revision`/`displayOff` over the status byte,
  `setAddress`/`put`/`get` over R18/R19/R31, and `ramKib()`, the probe the
  catalog's `vdc` option names in `detect`. It draws nothing — there is no
  80-column text surface yet. R30's block fill and R24 bit 7's block copy
  are deliberately *not* wrapped (see the rules below).
- `src/vdc80.8bs` (`@8bitscript/c128/vdc80`) is text on the 80-column
  screen: `blank`, `putChar`, `putColor`, `setColor`, `setBackground`,
  `print`, `printNumber`, `COLUMNS`/`ROWS`/`CELL_COUNT`, and `Vdc80Color`'s
  sixteen RGBI names. It adopts the KERNAL's VDC RAM layout (matrix
  `$0000`, attributes `$0800`, character sets `$2000`) rather than setting
  up its own, which is why a program can draw here without taking the
  screen over first. **It is not `@8bitscript/text`** — that stays the
  40-column VIC-IIe picture — but it deliberately has the same shape, so
  that pointing the portable surface here later stays a decision rather
  than a rewrite. It touches no register itself; everything goes through
  `./vdc`.
- `src/sid.8bs` (`@8bitscript/c128/sid`) is the SID, voice by voice —
  the same surface `@8bitscript/c64/sid` offers, over the same registers
  at the same addresses, as this package's own export. `src/index.8bs`
  gained what it stands on: `sidRegisters` (`$D400`), `paddleX`/`paddleY`
  (`$D419`/`$D41A`, which are also a 1351's movement lines),
  `voice3Oscillator`/`voice3Envelope` (`$D41B`/`$D41C`), and `palFlag`
  (`$0A03`) with `Region` and `detectRegion()`.
- `src/banks.8bs` (`@8bitscript/c128/banks`) is `banks.kib()`, the
  256 KiB probe, described in the table below.
- The hardware catalog in `package.json`: `ram`, `vdc`, `vdcrev`, `sid`,
  `cia`, `expansion`, `port1`, `port2`, and the presets `c128`, `c128d`,
  `c128dcr`, `vdc64`, `ram256`, `loaded`. See [The catalog](#the-catalog).
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

The C64's other hardware subpaths — `sprites`, `keyboard`/`keys`,
`joystick`, `video`, `raster`, `bitmap`, `charset`, `scroll`, `mouse`,
`reu` — **do not exist for the C128** (`sid` now does), although every
register they use is at the same address here. Nothing reaches bank 1, the
2 MHz clock, the extended keyboard, the 1351, the REU or C64 mode; the VDC
has text but no bitmap and no scrolling. There is no banked-memory model in
the language and no far pointer — for the C128 or any machine.
[What is left to build](#what-is-left-to-build-and-what-differs-here) is
the map of that work; the rules below are what to hold it to.

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
| `@8bitscript/c128/banks` — `banks.kib()`: 64 on every C128, 192 with the 256 KiB modification. Selecting a bank changes the whole address space, instruction fetch included, so the probe first widens common RAM to 16 KiB (`$D506 = $07`, `$0000`–`$3FFF`) — which covers every program this toolchain builds, since the linker starts them at `$1C01` — writes a marker to `$8000` in bank 0, selects bank 2 through the `$FF00` mirror's top two bits, writes a different marker, comes back and reads bank 0's byte. On a 128 KiB machine banks 2 and 3 are 0 and 1 again, so the marker is gone. The KERNAL's interrupt runs throughout and is safe because its vectors, workspace and the stack are all inside the widened area. Disassembled and checked: between the two `$FF00` writes the code does `ldy #$c3`, `sty $8000`, `ldy $10` — an immediate, the probe's own byte, and one zero-page read, no soft stack (the soft stack is near `$BFFF`, outside common RAM, and `test/banks.test.mjs` asserts this on the built binary). Under x128 the probe printed 64 KiB stock and 192 with `ram=256k`. Cost: 639 bytes of program with the probe and 574 with the answer written in — 65 bytes. | `src/banks.8bs`; `llvm-objdump` of the linked build (ran); two screenshots (ran); `test/banks.test.mjs` |

| **R28 bit 4 is a control, not a report.** It says which *kind* of DRAM the chip is wired to — clear for the 4416s of a 16 KiB VDC, set for the 4464s of a 64 KiB one — and it picks how the address is multiplexed onto them. With it clear a 64 KiB VDC reaches only its first 16 KiB. Verified the hard way: a probe that wrote past `$3FFF` without touching R28 reported 16 KiB on a C128DCR, which has 64. This is why the boot reading of `$2F` under `-VDC64KB` (the row above) says nothing about the RAM fitted — the bit was simply never set. | probe screenshots (ran, both ways); `vdc.c` `vdc_ram_store`/`vdc_ram_read` |
| **A 16 KiB VDC in 64 KiB addressing loses A8 and A15** — and this is from Commodore, not inferred. The PRG prints the chip's DRAM row/column multiplex for both RAM types (`R28(4) 8563 RAM TYPE (4416/4164)`), and the 4416 row shows the column line that would carry A15 carrying **A8 a second time**. VICE's `vdc_64k_to_16k_map` is the same function (keep `$00FF`, slide `$7E00` down one). So `ramKib()` probes `$A000`/`$A100` — differing only in A8, one byte on a 16 KiB chip, two on a 64 KiB one — and those two fold onto `$1000`, the KERNAL's unused gap, so no byte of the 80-column display is ever written. **The widely circulated `$0000` versus `$4000` test is wrong**: A14 is not a bit a 16 KiB chip loses in this mode, and cc65's own VDC driver has the same defect (it probes pages `$02` and `$42`). That is the reported failure where a routine passes under emulation and misreports on real hardware. | *C128 PRG*, R28(4) mux table; `vice/src/vdc/vdc-mem.c` (read); [Lemon64](https://www.lemon64.com/forum/viewtopic.php?t=86461); `src/vdc.8bs`; `test/vdc.test.mjs` (ran, 16 KiB and 64 KiB) |
| **The KERNAL's interrupt never touches `$D600`/`$D601`, in either screen mode** — on US ROMs. The editor's IRQ scans the keyboard and calls `blink`, and `blink` opens with `bit mode / bmi` so it returns immediately in 80-column mode (the VDC blinks its own cursor in hardware) and otherwise only writes VIC screen and colour RAM. Commodore's own editor source is the citation. **The exception is a national ROM**: the German `318077-01` redirects `scnkey` through a DIN patch containing an ungated `JSR $CE0C` (the charset upload into VDC RAM), reachable from the interrupt — though only on a CAPS-LOCK/translation change, not every frame. This is what the probe's surviving `HELLO` was evidence of, now with a mechanism. | `mist64/cbmsrc` `EDITOR_C128/ed1.src`, `ed3.src`; disassembly of `318020-03`/`-05` and `318077-01` |
| The KERNAL's own VDC primitives are at **`$CDCC` (write: `X` = register, `A` = data)** and **`$CDDA` (read: `X` = register)**, with `$CDCF`/`$CDDD` entering below the register-select to move the *next sequential* byte — the fast path for bulk VDC RAM. Both poll the ready bit. They are **not** in any jump table (only `CINT $FF81`, `SWAPPER $FF5F` and `DLCHR $FF62` are vectored), so their addresses are unofficial — but they are byte-identical across US `318020-03`, `-05` and German `318077-01`. The PRG itself has readers POKE private copies rather than call them, which is the precedent this package follows by owning the sequence in `vdc.8bs`. | `mist64/cbmsrc` `EDITOR_C128/routines.src`; PRG |
| **The KERNAL does not poll the ready bit for setup registers**: its init writer is a bare `STY $D600 / STA $D601`. The poll is required for R18, R19 and R31 — the registers that touch VDC RAM — and the PRG says exactly those three. `vdc.8bs` polls on every access anyway, which is correct and a little slower than it needs to be. | PRG "PROGRAMMING THE 80-COLUMN (8563) CHIP"; `KERNAL_C128_06/init.src` |
| **Block fill and block copy do not take the same count.** The PRG: after the initial write of data to R31, "one write cycle will follow", so **R30 must be one less** than the number of bytes to fill — while the block-copy description carries no such note and R30 is the exact count. VICE reproduces the asymmetry. (`R30 = 0` meaning 256 is in VICE and ACME but *not* in the PRG.) This is the off-by-one the fill wrapper was left out for. | PRG R24(7)/R30 and R32/R33; `vdc-mem.c` |
| **The VDC's revisions split 0 versus 1-and-2, not 8563 versus 8568**, and the split breaks the *static* display, not just scrolling. The PRG: the difference between the 8563 R7A and later revisions "is in the horizontal smooth scroll feature… Even if this feature is not utilized, the correct value must be placed into this register for a normal 80-column display." Unscrolled means `R25(3-0) = 0` on an R7A and `R25(3-0) = R22(7-4)` on everything after — `$40` versus `$47` with the KERNAL's `R22 = $78`. Get it wrong and one edge of the picture is broken. The C128 KERNAL does exactly this at boot: write the table, read `$D600 & $07`, and patch `R25` to `$47` if non-zero. **The 8568 behaves as R8/R9 here** — the DCR's KERNAL is byte-identical to the flat machine's at the probe and the table. No equivalent difference exists for R24, the *vertical* smooth scroll. | PRG; `mist64/cbmsrc` `KERNAL_C128_06/init.src` (`vdctbl`/`vdcpat`) |
| Status `$D600` bits 2-0 are the revision, masked with `$07`: **0 = 8563 R7A, 1 = 8563 R8/R9, 2 = 8568** — the catalog's `vdcrev` values in that order. The PRG gives 0 and 1 with their R25 values in a table; the value 2 for the 8568 is consistent across VICE, ACME and other tools but has no primary hardware measurement. **R37 (sync polarity) exists only on the 8568** but is not a usable chip probe under VICE, which lets it read back on every revision. | PRG; `mist64/cbmsrc` `sysdoc.src`; `vdc/vdc.h` |
| **Both displays are live at once, from 8bitscript code**: the probe writes `HELLO` into 80-column screen RAM at VDC `$0000` through `setAddress`/`put` while the KERNAL is still driving the 40-column screen, and `-exitscreenshotvicii` and `-exitscreenshot` capture the two pictures side by side. The 40-column text and the 80-column text are both there. | `test/vdc-probe.8bs`, `test/vdc.test.mjs` (ran) |
| A **C128DCR** reports VDC revision **2** in the status byte's low three bits and 64 KiB from the probe; a flat C128 reports revision 1 and 16 KiB. And the catalog's `c128dcr` preset — `-VDC64KB -VDCRevision 2 -sidmodel 1 -ciamodel 1` — produces the same two readings as `x128 -model c128dcr`, which is what lets the board be a preset over component flags instead of a `-model` that would clobber `-model ntsc\|pal`. | probe screenshots (ran): `-model c128dcr` and `--profile c128dcr` |
| Hardware `run` flags are appended **after** `VICE_MODEL_ARGS` (`packages/cli/src/run.mjs`: emulator args, model args, then `hardware.run[emulator]`, then the file). So a catalog value that emitted `-model c128dcr` would override the region VICE was just given. No C128 option emits `-model`. | `packages/cli/src/run.mjs` (read) |
| A `.8bs` identifier that is a **C keyword breaks the build**, with the error pointing at generated C rather than at the source: a parameter named `register` produced `static void vdc_write(uint8_t register, …)` and `error: expected expression`. `packages/backend-6502` does not rename identifiers, and no diagnostic catches it. Renamed to `index` (the SDK's own `VDC_INDEX`/`VDC_DATA` spelling); the general problem is unfixed. | clang output during this work |
| `x128` has **no `-extfunc`** — it was replaced in VICE 3.7 by a C128 cartridge system (`-cartfrom`, `-cartgmod128`, `-cartmd128`, `-cartws128`, `-cartpartner128`, `-cartcomal128`); the internal socket is still `-intfunc <0-3>` (None/ROM/RAM/RTC) with `-intfrom <image>`. Also present and unused by this target: `-40col`/`-80col`, `-go64`, `-kernal64`/`-basic64`, `-machinetype 0..7` (0 International, 1 Finnish, 2 French, 3 German, 4 Italian, 5 Norwegian, 6 Swedish, 7 Swiss — VICE ships **no** national ROM images, so these fail without them), `-ciamodel 0\|1`, `-sidmodel 0\|1\|2` (2 is 8580 + digiboost), `-reu`/`-reusize 128..16384`, `-georam`/`-georamsize`, `-ramcart`, `-dqbb`, `-ramlink`, `-drive8type`, and the `-VDC*` display filters. | `x128 -help` (this machine's VICE 3.10); VICE trunk `c128/cart/c128cart.c`, `c128/functionrom.c` |
| **`x128`'s resource defaults are a DCR, and only `-model` saves us**: `c128-resources.c` defaults `BoardType` to C128D and the CIAs to 6526A, and `vdc-resources.c` defaults `VDC64KB` 1 and `VDCRevision` 2. `8bs run c128` always passes `-model ntsc\|pal`, which selects the *flat* machine (old CIA, 6581, VDC revision 1, 16K) — confirmed by the probe reading revision 1 and 16 KiB. Anyone driving `x128` by hand without `-model` is testing a different machine from the one the catalog describes. | VICE `c128/c128-resources.c`, `vdc/vdc-resources.c`, `c128/c128model.c`; probe (ran) |
| `-model` takes only `c128`, `c128dcr`, `pal`, `ntsc`. **The plastic C128D has no command-line name at all** (only VICE's GUI offers it), which is a second reason the boards are presets here rather than a `-model` option. VICE's own model table: flat and plastic-D are both old CIA / 6581 / VDC rev 1 / 16K, and only the DCR is new CIA / 8580 / rev 2 / 64K — which is exactly what the `c128dcr` preset spells out. | `c128model.c` |

| **The block fill's count rule is now checked both ways, not just read.** A fill one byte short per run would leave part of a pre-fill on screen; a fill one byte long would spill into `$07D0`, the unused gap between the matrix and the attributes, where nothing shows — so the probe puts a sentinel there and reads back both it and the last cell (`$07CF`). With `R30 = count - 1` the last cell holds the fill and the sentinel survives. `vdc80.blank()` clears 2000 cells as 8 fills instead of 2000 writes. | `test/vdc80-probe.8bs`, `test/vdc80.test.mjs` (ran) |
| **`$0A03` is the region, and it is a byte rather than a measurement.** The KERNAL works out PAL or NTSC at boot and leaves the answer there — `$00` for NTSC, non-zero for PAL, checked both ways under `-model ntsc` and `-model pal`. So `detectRegion()` on this machine is one read, where `@8bitscript/c64`'s watches two whole frames of the raster for the same answer. It matters most to the SID: a note's frequency register is `f * 2^24 / clock`, and the two clocks differ by 3.8 percent — two thirds of a semitone. The probe printed A4 as `7218` on NTSC and `7493` on PAL, which are the two tables' entries. | `c128.inc` (`PALFLAG`); `test/sid-probe.8bs`, `test/sid.test.mjs` (ran, both regions) |
| **The SID answers when asked**, which is as close as a screenshot gets to hearing it: with voice 3 set to noise, `$D41B` read three different values on three frames, and `$D41C` was above zero after the gate — the chip is clocked, the writes landed, and the envelope generator is running. Checked on both regions. | `test/sid.test.mjs` (ran) |
| The note tables are the C64 package's, and that is only right because the two machines run the same clocks (PAL 985248 Hz, NTSC 1022727). Rather than trust the carry-over, all 168 entries are recomputed from `round(440 * 2^((n - 57)/12) * 2^24 / clock)` and compared, and each is checked to fit the 16-bit register. | `test/sid.test.mjs` (ran) |
| `pixelAt` (`packages/cli/src/png.mjs`) **re-parses and inflates the whole PNG on every call**, so scanning a screenshot region pixel by pixel costs one full decode per pixel — a 55,000-pixel scan took 90 seconds, against 4 with the same region sampled every 4th pixel. Any screenshot test that looks at an area rather than a point should sample, or the helper should learn to decode once. | measured while writing `test/vdc80.test.mjs` |

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
KERNAL's `JSRFAR`/`FETCH`/`STASH` switch quickly. **BASIC 7 leaves
standing values in them** — `$D501` = `$3F` (bank 0), `$D502` = `$7F`
(bank 1), `$D503` = `$01` (bank 14), `$D504` = `$41` — and depends on
them, so a program that changes one and returns to BASIC has broken it.
The KERNAL's own reset sets all four to `$00`. The VIC's bank (`$D506`
bits 6–7) is independent of the CPU's: the VIC can display bank 1 while
the CPU runs in bank 0 (with the `$DD00` 16K window on top of that). The
256K modification adds banks 2–3 (`-c128fullbanks`; CR bits 6–7 both
used); the standard machine wraps them to 0–1.

**Common RAM sizes** (`$D506` bits 1–0): `00` 1K, `01` 4K, `10` 8K, `11`
16K; bits 3–2 place it — `00` none, `01` bottom, `10` top, `11` both. The
KERNAL's setting is `%0100` — 1K at the bottom — and both the OS and BASIC
depend on it existing: turning it off crashes BASIC, and an interrupt
taken while bank 1 is selected with no common area crashes the KERNAL.
(`banks.kib()`'s `$07` is 16K at the bottom, and is put back.)

**The sixteen `BANK` numbers** BASIC 7 uses are a KERNAL table at `$F7F0`
mapping each to a CR value — `$3F $7F $BF $FF $16 $56 $96 $D6 $2A $6A $AA
$EA $06 $0A $01 $00` for banks 0–15. Bank 15 (`$00`) is the familiar
KERNAL + BASIC + I/O; bank 0 (`$3F`) is flat RAM 0; bank 1 (`$7F`) flat
RAM 1; bank 14 (`$01`) swaps I/O for the character ROM. `GETCFG` (`$FF6B`)
is the KERNAL's own lookup into that table, and is the right way to spell
a configuration rather than hard-coding one. (*Mapping the C128* misprints
bank 13; the ROM says `$0A`.)

**The cross-bank stubs, and what they cost.** `FETCH` (`$02A2`), `STASH`
(`$02AF`), `CMPARE` (`$02BE`), `JSRFAR` (`$02CD`) and `JMPFAR` (`$02E3`)
are copied into common RAM at reset. The jump-table entries are `INDFET`
`$FF74` (A = the address of a zero-page pointer, X = bank, Y = offset),
`INDSTA` `$FF77` and `INDCMP` `$FF7A`; `JSRFAR`/`JMPFAR` take the bank in
`$02`, the target high byte in `$03` and low in `$04` (that order), and
pass A/X/Y/P through `$05`–`$08`. **The cost is the point**: roughly 47
cycles for `INDFET` to read one byte against 5 for a plain `LDA (zp),Y`,
and 130-odd for a far call. A far *block* move must never go through them
per byte — bank in, copy the run, bank out, or use the REU. `JSRFAR`
also returns with the MMU left in bank 15.

**Page 0/1 relocation** (`$D507`–`$D50A`) is a *swap*, not a move: point
page 0 at `$1300` and `$0002`–`$00FF` and `$1302`–`$13FF` exchange places
(`$00`/`$01` never move). Two traps: the block byte (`$D508`/`$D50A`)
only takes effect on the next write to the page byte, so write the block
first; and while a bottom common area is enabled — which is the KERNAL's
default — the block byte is ignored and zero page is always block 0's.
Little real software uses any of this.

**The VDC (8563 / 8568).** Registers — the ones this file has since
checked against the PRG have their own rows in the verified table above
(R25's revision split, R28 bit 4 and the address fold, the fill and copy
counts, the bitmap attribute nybbles); the rest of this list is still
read-from-sources rather than exercised: R0–R7 horizontal/vertical totals and
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
**foreground from the low nybble and background from the high nybble** —
confirmed in the PRG ("Bits 3-0 are foreground R, G, B and I… Bits 7-4
are background"), and note that this is **the opposite way round from
R26**, whose high nybble is the foreground. Three byte layouts that must
not be confused: a *text* attribute is ALT/RVS/UL/FLASH in the high
nybble and the foreground colour in the low; a *bitmap* attribute is
background high, foreground low; R26 is foreground high, background low.
Within a nybble the order is R, G, B with **intensity in the low bit**.
With attributes off the whole picture is R26's two colours.

640 × 400 needs interlace and 32000 bytes — 64K VDC only in practice;
640 × 480 (38400 bytes) and 80 × 50 text are both real and documented,
and 640 × 200 *with* attributes already needs 18000 bytes and so a 64K
chip. Interlace is R8 bits 1-0: `01` sync only, `11` sync-and-video (the
one that doubles vertical density, and needs R3/R5 even). The practical
limits are the monitor's ~15.6-15.75 kHz line rate — so leave R0 alone
— and DRAM bandwidth: the known fix for corrupt characters in dense
modes is lowering **R36**, the refresh-cycles-per-line count, from 5 to 3,
not stretching the line.

There is no hardware scrolling beyond R24/R25's smooth scroll plus moving
R12/R13 (a whole-screen scroll, cheap), no sprites, **no raster interrupt
and no register that reports the current scanline**, no collision, and
every byte goes through R31 one at a time (or R30's fill/copy for runs).
The VDC's frame and the VIC's are driven by *different crystals* — 16 MHz
for the VDC, the 8701 for the VIC — and are not locked, so a VIC raster
interrupt cannot schedule VDC-frame-accurate work. What real programs do
instead is edge-detect status bit 5 (three checks, since the beam may
already be in the border when the first one runs) and then calibrate a
CIA timer against it; measured that way, a PAL VDC line is 63.05 CPU
cycles. The light-pen latch (R16/R17) does latch a position, but only to
character-row and column granularity, and no published code drives it
from software — one developer tried and fell back to CIA calibration.

**2 MHz.** `$D030` bit 0 doubles the 8502's clock. The mechanism is that
the VIC-IIe is held off the bus (AEC high) and does nothing but DRAM
refresh, so in 40-column mode the picture becomes the CPU's own bus
traffic rendered as video — *Mapping the C128*'s "a colorful pattern of
rapidly flashing squares", and deterministic enough that demos have drawn
pictures with it by choosing their opcodes. **The VDC is unaffected**, so
80-column programs run at 2 MHz as a matter of course.

Most of what was listed here as *to verify* is now sourced, and the
answers matter:

- **No bad lines at 2 MHz.** The VIC never takes the bus, so it steals no
  cycles — which also means the border trick's payoff is smaller than it
  looks, since the border has no bad lines to save in the first place.
- **Every I/O device stays on the 1 MHz clock**, including *the CIA
  timers*: the C128 PRG is explicit that "all timer operations remain
  unchanged", and the VIC stretches the 2 MHz clock on each I/O access to
  keep the two in step. So a CIA-timed routine does not change speed, and
  I/O accesses cost the same wall-clock time either way — the speed-up
  applies to RAM-only code. The SID is named in the same list.
- **The border trick's real numbers**: switch to 2 MHz at raster **251**,
  back to 1 MHz at raster **50** (the same on PAL and NTSC — the window is
  `$D011` geometry, not timing). It breaks split-screen modes. Measured
  gain on a BASIC benchmark: **18% NTSC, 26% PAL** — not the "like a
  1.5 MHz machine" of folklore.
- **BASIC's `FAST` really does blank the screen first**: `$D011 AND #$6F`
  (clearing DEN) *then* `$D030 = 1`; `SLOW` reverses the order. Read out
  of the ROM disassembly, not inferred.
- **The KERNAL forces 1 MHz for serial and tape** itself, saving `$D030`
  in `$0A37` and `$D015` in `$0A38`, because those routines are software
  timing loops. Bit 7 of `$0A3A` opts out. The 1571's *fast* serial is CIA
  hardware and not a timing loop, so it is not subject to this — though
  the KERNAL slows down for it anyway.
- `$D030` **bit 1** is a separate thing worth knowing about: it advances
  the VIC's internal line counter every cycle it is set, which is how
  demos skip border lines. Bits 2-7 are unconnected and read 1, so the
  register always reads `$FC` or more.

Still true and still worth repeating: VICE emulates the speed but not the
picture corruption (verified above), so **a `--screenshot` proves nothing
about 40-column code at 2 MHz**. Also at 2 MHz, the undocumented `ANE`
opcode uses `$EE` instead of `$FF` as its magic constant (VICE models it).

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
The C128D/DCR have a built-in 1571. Cartridges: the C64 port, with C128
"function ROMs" as an internal/external option (`MMU_CFG_IFROM`/`EFROM`)
— CR bits 3–2 select what is at `$8000`–`$BFFF` and bits 5–4 what is at
`$C000`–`$FFFF`, `01` internal and `10` external in each. The internal
socket is U36 on every board, empty from the factory, taking a 16K or 32K
EPROM; a ROM there autostarts if `$8007`–`$8009` reads `CBM` and the ID
byte at `$8006` is 1. In VICE that is `-intfrom <image>` **and**
`-intfunc 1` (`2` is RAM, `3` an RTC); **`-extfunc` no longer exists** —
it was replaced in VICE 3.7 by a C128 cartridge system (`-cartfrom`, and
named cartridges `-cartgmod128`, `-cartmd128`, `-cartws128`,
`-cartpartner128`, `-cartcomal128`).

**The REU, and the trap in it.** 1700 (128K) and 1750 (512K) were the
C128's; the 1764 (256K) was sold for the C64. `$DF00` bit 4 distinguishes
64K from 256K DRAM chips; `$DF06` decodes only three bits, so a stock REC
addresses 512 KiB and the larger units latch the upper bits *without*
carrying into them — a >512K REU is not one flat space. Two things a
C128 REU layer must get right, and both were open questions here:

- **The RAM block a transfer touches comes from `$D506` bits 6–7 — the
  VIC/DMA bank — not from `$FF00` bits 6–7.** It is the same AEC
  mechanism that gives the VIC its bank. So transferring into bank 1
  means moving the *display's* bank too, and the two decisions are not
  separable. The ROM/I-O overlay, meanwhile, still follows the current
  CR: a DMA write to a ROM-mapped page lands in the RAM under it, and a
  DMA over `$D000`–`$DFFF` with I/O banked in hits real registers.
- **A write to `$FF00` fires an armed transfer.** `$DF01` bit 4 clear
  arms it, and the next `$FF00` store both switches the MMU and starts
  the DMA — the KERNAL's `$03F0` stub is exactly that, and it is why the
  trigger address is the one register visible in every configuration.
  Anything writing `$FF00` (`banks.kib()` does) is writing the REU's
  trigger too; harmless while nothing has armed it, and a hazard the
  moment an REU layer exists.
- The KERNAL's `DMA_CALL` (`$FF50`) differs between ROM revisions — the
  1986 ROM sets `$D506` for you, the earlier one forced I/O in and
  corrupted registers. Set the bank yourself and pass your own config.
  BASIC's `STASH`/`FETCH`/`SWAP` reach only REU banks 0–15, and the PRG
  requires them to run at 1 MHz. One unconfirmed report says a transfer
  in 2 MHz mode can leave the CPU fetching a wrong opcode.

GeoRAM as on the C64, through `$DE00`.

**Sound.** The SID (6581 in the flat C128, 8580 in the DCR) exactly as
the C64 file describes it, at `$D400`; its paddle inputs are the 1351's
lines. Nothing else — no C128 ever shipped a second sound chip.

**The boards.** Three that shipped: the flat wedge C128 (PCB 310379), the
plastic-cased C128D (the same board plus a 1571 controller), and the
metal C128DCR (PCB 250477), which integrated the drive controller and
brought the 8568 VDC with 64K, the 8580 SID and a 1986 ROM revision. A
cost-reduced flat "C128CR" exists only as an engineering sample. The
chips are *not* cleanly split by model in practice: late flat machines
shipped 8580s, and sources disagree about the plastic D's SID and VDC RAM
— which is the honest reason the catalog exposes `sid`, `vdc`, `vdcrev`
and `cia` as separate options and offers the boards as presets over them,
rather than pretending a model name determines the chips.

The **64 KiB VDC upgrade** on a flat machine is a straight swap of the two
4416 (16K × 4) DRAMs for 4464 (64K × 4) — pin-compatible, no jumpers or
cuts — which is why it is a run-time question rather than a build one.
Very little software ever required it (GEOS 128 notably does not).

The **256 KiB modification** is a much bigger thing: a second 8722 MMU,
some glue logic, and sixteen DRAMs piggybacked on the existing sixteen. It
was never a success — its author knew of four modified C128s in 1999 — and
essentially nothing supports it. `banks.kib()` finding it is a curiosity,
not a capability to design around; and the reason it must probe rather
than read `$D50B` is that the version register reads `$20` either way.

**Z80.** An 8-bit Z80 at 4 MHz (effectively ~2) that boots first and
hands over to the 8502, present for CP/M only. Off the map for this
project; `$D505` bit 0 is the only place it shows.

## Misreadings a C64 programmer brings here

This file was written from the sources in the table above, not from
research notes; a set of notes did arrive later, and the errors in them
are recorded [below](#misreadings-in-the-research-notes). But everyone
arrives here knowing the C64, and these are the C64 facts that are wrong
on this machine:

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

## Misreadings in the research notes

A survey of the eight-bit machines was written for this project and its
C128 section is wrong in ways worth naming, because they are the errors a
confident secondary source makes about this machine. Every one of them is
contradicted by a row in the tables above. The PET and C64 files carry the
same kind of section for the same reason: a lecture note or a blog
recollection is a lead to verify, never a citation.

- **"There is a special register (`$FFFD`) for selecting which 16 KB of
  ROM appears at `$C000`."** No. Banking is the MMU's: `$D500`-`$D50B`,
  with `$FF00`-`$FF04` the mirrors that stay visible in every
  configuration. `$FFFD` is the top half of the 6502 reset vector.
- **"`$00`/`$01` bits control RAM vs ROM as in the C64, plus the special
  register."** No. In native mode `$01` bits 0-1 pick which half of the
  2 KiB colour RAM the CPU and the VIC each see. A C64 `$35`/`$36`/`$37`
  written here changes the colour RAM, not the memory map.
- **"Only one chip drives the monitor at a time."** No — both drive their
  own outputs simultaneously, and this session's probe put text on both at
  once from one program. The 40/80 key (`$D505` bit 7) says which one the
  *KERNAL's screen editor* is talking to, not which one is on.
- **"The VDC is officially text-only but supports 640×200 bitmap via
  hidden registers."** There is nothing hidden about it: R25 bit 7 is the
  bitmap bit, documented, one of 38 decoded registers. The example
  assembly in the notes selects a register index twice and then writes
  R10, the cursor register — it does not enable bitmap mode.
- **"The VDC's palette is 16 colours plus 16 intensities."** It is 16
  RGBI colours, one nybble: bit 3 red, bit 2 green, bit 1 blue, bit 0
  intensity. Sixteen in total, in a different order from the VIC's.
- **"There is no native audio in 80-column mode."** The SID is on its own
  clock and does not know or care which display is being used.
- **"Some C128DCR machines had an extra SN76489-like chip."** No C128
  ever shipped with one. The DCR's audio difference is the 8580 SID.
- **"Access to VDC registers is very slow — hundreds of µs."** Tens of
  cycles, not hundreds of microseconds: VICE models the busy period as 43
  cycles in the active area and 4 in the border. Slow enough that a
  full-screen redraw is a real cost and R30's fill exists for it; not
  slow enough for the number in the notes.
- **"C128: 128 KB banked, VDC has 16 KB VRAM"** in the summary table,
  against **"41983 bytes"** in this package's own catalog. Both are true
  and they answer different questions. What a program is *linked to use*
  is ~41 KiB of bank 0 — less than the C64's 51 KiB, because the KERNAL
  stays in and BASIC's low RAM is reserved.

The notes' non-C128 claims were not checked here and should not be trusted
on the strength of this section either.

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
  screen. Its *interrupt* does not, in either mode — verified in
  Commodore's own editor source (see the table above), which is what makes
  a program that owns the VDC while the KERNAL runs the 40-column screen
  safe rather than lucky. A program that takes the VDC over still keeps
  the editor out of it by never calling SWAPPER or CHROUT for that screen;
  and the one known exception is a *national* ROM (the German one reaches
  the charset upload from the keyboard scan), so a program that must work
  on every machine should not assume its VDC RAM is untouched forever.
- Waiting on the VDC's status bit 5 waits for the *border*, not for
  vertical sync; a frame-exact VDC effect needs a different scheme
  (light-pen latch, or counting from the border edge) — design it, don't
  assume the bit.
- The VDC's 16K/64K is the catalog's `vdc` option, and one binary serves
  both: `vdc.ramKib()` finds it. Text at 80 × 25 fits in the smallest chip;
  a bitmap or an interlaced mode may not, and a program must ask rather
  than assume. **R28 bit 4 is a control, not a report** — a 64 KiB VDC
  addresses only its first 16 KiB until the bit is set, so anything that
  wants the upper 48 KiB sets it and keeps it set, and anything that
  restores it (as `ramKib()` does) has given the extra RAM back.
- The block fill (R30) and block copy (R24 bit 7) are the chip's answer to
  how slow a byte at a time is, and the off-by-one that kept them
  unwrapped is now settled: **a fill takes `R30` = one *less* than the
  number of bytes** (the write to R31 that sets the value is itself the
  first), while **a copy takes the exact count**. They are worth having —
  a measured break-even against a plain byte loop is about seven bytes —
  and when they are written they go in `vdc.8bs` beside `put()`, with the
  two different counts spelled out, not shared.
- **Set R25's low nybble from R22, never to a constant.** An 8563 R7A
  (revision 0) wants `R25(3-0) = 0` and every later chip wants
  `R25(3-0) = R22(7-4)`; the wrong one breaks an edge of the *static*
  80-column picture, not just scrolling. Read `$D600 & $07` and branch, as
  the KERNAL does at boot. Any code here that programs the display — an
  80-column text surface, a bitmap mode — owns this.

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

## The catalog

`"8bitscript".hardware` in `package.json`. Eight options; the first five
say what the machine *is*, the last three what is plugged into it.

| Option | Values (default first) | What it changes |
| ------ | ---------------------- | --------------- |
| `ram` | `128k`, `256k` | The MMU's banks. `-c128fullbanks`; `memory.bankedKib` 64 → 192; found at run time by `@8bitscript/c128/banks` |
| `vdc` | `16k`, `64k` | `-VDC16KB`/`-VDC64KB`; found at run time by `@8bitscript/c128/vdc` |
| `vdcrev` | `8563`, `8563r7a`, `8568` | `-VDCRevision 1/0/2`. Readable at run time (`$D600 & $07`) — and code that programs the display **must** read it, because R25's low nybble differs (see the rules) |
| `sid` | `6581`, `8580` | `-sidmodel 0/1`, as the C64 catalog spells it |
| `cia` | `6526`, `8521` | `-ciamodel 0/1` |
| `expansion` | `none`, `reu128` … `reu16m` | `-reu -reusize N`. No facts — see below |
| `port1` | `none`, `joystick`, `paddles`, `mouse1351` | `-controlport1device`; `input.mouse`/`input.paddles` |
| `port2` | `joystick`, `none`, `paddles`, `mouse1351` | the same, port 2 |

Presets: `c128` and `c128d` (the flat machine and the plastic one with
the built-in 1571 — the same to a program, and both spelled out rather
than left implicit, because people will ask for them by name), `c128dcr`
(the cost-reduced board: 64 KiB VDC, 8568, 8580, 8521), `vdc64` (a flat
machine with the common 64 KiB VDC upgrade), `ram256`, and `loaded`
(everything at once, for seeing what a program does with room).

Four things about the shape of it worth keeping:

- **The board is a preset, not an option.** `x128 -model` takes
  `c128`/`c128dcr` *and* `pal`/`ntsc` on the same flag, and the CLI already
  spends it on the region (`VICE_MODEL_ARGS.c128`), appending hardware
  flags after it. An option that emitted `-model c128dcr` would silently
  turn a `--pal` build into an NTSC one. So the DCR is assembled from
  `-VDC64KB -VDCRevision 2 -sidmodel 1 -ciamodel 1`, which is verified to
  give the same machine (table above).
- **A run-time-detected value carries no tag.** `vdc=64k`, `ram=256k`,
  each `vdcrev`, `sid=8580`, `cia=8521` and every REU size are `tag: null`:
  one binary serves them all, so none of them may pull in a
  `*.c128.<tag>.8bs` file twin, which would mean a *different build*. Only
  `port1`/`port2` still carry their names as tags, as on the C64.
- **`expansion` sets no facts, and that is a gap, not an oversight.** The
  sheet has one banked-RAM number, `memory.bankedKib`, and on this machine
  it is already spent on the MMU's banks — the RAM every C128 build can
  reach with no cartridge in the port. An REU is a second, independent
  pool. Setting `memory.bankedKib` to `64 + N` would then be wrong for
  anyone who also chose `ram=256k`, and letting the later option win would
  make the number depend on the order the catalog happens to list its
  options in. So it stays the MMU's, and the REU's capacity has nowhere on
  the sheet to go. See [What the fact sheet cannot
  say](#what-the-fact-sheet-cannot-say-yet).
- **Region is not in the catalog.** It is run-time: the frame driver
  probes it, and `$0A03` records what the KERNAL found.

Mapped but deliberately not shipped, with the reason:

- **`-machinetype 0..7`** (International, Finnish, French, German,
  Italian, Norwegian, Swedish, Swiss) is a real variant axis — a different
  KERNAL, keyboard and character ROM. Shipping it would make `8bs run`
  depend on ROM images a VICE install may not have, to change nothing a
  program can see today. When a keyboard layer exists, revisit it.
- **`-intfunc 2`** puts 32 KiB of *RAM* in the internal function-ROM
  socket, in the MMU's mid window — genuinely more memory, with no image
  file needed. It needs MMU code before it means anything.
- **`-drive8type`, `-georam`, `-ramcart`, `-dqbb`, `-ramlink`** are real
  and none of them changes a fact, a file, or a capability today.
- **`-go64`** is not an axis of this target at all: see [Native mode is
  the target](#native-mode-is-the-target-and-c64-mode-is-a-different-target).

## What is left to build, and what differs here

The C64 package is the map, and every layer on it has a C128 counterpart
that is *not* the same code. What differs, and roughly in what order:

| Layer | What it is here | What differs from the C64 |
| ----- | --------------- | ------------------------- |
| `sid` | **built** (`./sid`) | the registers are the C64's exactly. What differs is around them: the region comes from `$0A03` rather than the raster, 2 MHz mode leaves the pitch alone (the chip has its own 1 MHz source), and the live KERNAL interrupt does not touch it. The catalog's `sid` option is the model, which changes the filter's character and not the map |
| `joystick`, `keyboard`/`keys` | CIA1 as the C64's | **the KERNAL IRQ is alive** and owns CIA1 between scans, so a matrix snapshot reads under `sei` — or reads the KERNAL's own buffer, which the C64 has no equivalent of. `$D02F` adds three more columns (keypad, HELP, ESC, TAB, ALT, NO SCROLL, the cursor keys), which the C64 file knows nothing about |
| `mouse` | 1351 on the SID's pot lines | identical protocol; the catalog already fits one |
| `charset`, `bitmap`, `scroll`, `sprites` | VIC-IIe, C64 registers | **who owns which RAM is a two-dimensional question here**: the VIC's bank is `$D506` bits 6-7 (the MMU's), not just `$DD00`, and the C64 file's bank-3 layout does not carry over — the KERNAL ROM is *in* at `$C000`-`$FFFF`. The KERNAL shadows `$D018` (`$0A2C`) and the bitmap layout (`$0A2D`); which control registers it shadows in graphic modes is *to verify* before any of these are written |
| `raster` | VIC-IIe raster IRQ | the C64's layer takes the machine over with `sei`; here that means taking the keyboard, the jiffy clock and the shadow copies over too. A deliberate decision, not a detail |
| `vdc80` text | **built** (`./vdc80`) | 80 × 25, an attribute byte per cell, RGBI colours, the KERNAL's layout adopted. What is *not* built: a bitmap mode (640 × 200, and 18000 bytes with attributes so a 64 KiB chip), R24/R25 smooth scroll, R12/R13 whole-screen scroll, block *copy*, a character set of the program's own in VDC RAM, and the 80 × 50 / interlaced modes |
| `reu` | `$DF00`, as the C64's | the DMA's RAM bank is `$D506` bits 6-7 — the *VIC's* bank — so a transfer into bank 1 moves the display's bank with it; and a write to `$FF00` fires an armed transfer, which every MMU access here also is |
| far memory / bank 1 | the MMU | there is no language for it yet on any target. The C128 is where the question is forced |
| 2 MHz | `$D030` bit 0 | a mode, not a speed-up — see the rule below |

The 80-column text surface is now built, which was the first of the two
things worth doing before the rest. The second still stands: a decision
about **far memory**, because bank 1 is 64 KiB sitting unused behind a
register the language cannot express, and this machine is where that
question is forced. `sid` is now built too, so after far memory the cheapest wins are a VDC
bitmap mode and the input layers (`joystick`, `keyboard`), which are where
the live KERNAL interrupt first actually costs something.

**The open question the surface was built to make answerable:** whether a
build can ever point `@8bitscript/screen`/`text` at the VDC — a `display`
option with a file twin, the way the PET's `8032` model makes a build 80
columns wide. `vdc80` deliberately mirrors the portable shape so that this
stays a decision. Two things it needs first: something to say on the fact
sheet (`video.columns` would have to become 80, and `video.sprites` 0,
for such a build), and CLI plumbing, since `-exitscreenshotvicii` and
`-hidevdcwindow` are wired per-target in `packages/cli` rather than read
from the hardware.

## What the fact sheet cannot say yet

`FACTS` (`packages/compiler/src/fold/facts.mjs`) is the compiler's, shared
by all nine machines, and changing it is the core-change checklist in the
root `AGENTS.md` — docs, IntelliSense, language-server tests, the VS Code
extension. So this is a proposal, not a change. Three things this machine
can be and the sheet has no way to say:

- **A second display.** Every key on the sheet is singular —
  `video.columns` is *the* grid. The C128 has two grids at once, of
  different widths, colours and frame clocks, and so (differently) does
  the X16 with its layers. Any key added for this has to mean something on
  the other eight machines, which is the hard part and the reason it is
  not being invented here.
- **Display RAM that is not the CPU's.** `video.*` says nothing about the
  16 or 64 KiB the VDC draws from — memory a program must budget and
  cannot address. The NES's CHR and the X16's VERA RAM are the same shape
  of fact.
- **A second pool of banked RAM.** As above: `memory.bankedKib` is one
  number, and this machine has the MMU's banks *and*, optionally, an REU.
  A `memory.expansionKib` alongside it would let the `expansion` option
  say what it fits — and would let the C64's REU sizes stop occupying
  `memory.bankedKib`, which on that machine works only because it has
  nothing else to put there.

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
packages/c128/package.json              the hardware catalog: ram, vdc, vdcrev, sid, cia, expansion, port1, port2; presets c128/c128d/c128dcr/vdc64/ram256/loaded
packages/c128/src/index.8bs             target package: borderColor ($D020), backgroundColor ($D021), memoryPointer ($D018), memoryPointerShadow ($0A2C)
packages/c128/src/vdc.8bs               @8bitscript/c128/vdc: the $D600/$D601 access layer, block fill, and ramKib(), the 16/64 KiB probe
packages/c128/src/vdc80.8bs             @8bitscript/c128/vdc80: text on the 80-column screen (not @8bitscript/text, which stays the VIC's 40)
packages/c128/src/sid.8bs               @8bitscript/c128/sid: the SID's three voices, and the note tables for both clocks
packages/c128/src/banks.8bs             @8bitscript/c128/banks: banks.kib(), the 256 KiB probe
packages/c128/test/vdc.test.mjs         the VDC probe on both chips, and the 80-column screen drawn while the KERNAL runs the 40-column one
packages/c128/test/vdc80.test.mjs       the 80-column text surface, and the block fill's count checked in both directions
packages/c128/test/sid.test.mjs         the SID answering on both regions, and every note table entry against the formula
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
