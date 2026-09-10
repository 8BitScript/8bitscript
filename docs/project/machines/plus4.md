---
title: Commodore Plus/4, C16, C116
nav_order: 11
---

# Writing Commodore Plus/4, C16 and C116 support for 8BitScript

This file is for anyone — human or agent — touching a future
`packages/plus4`, a `PLUS4_PROFILES` entry in `packages/backend-6502`, a
`FRAME_SYNC.plus4` driver, `packages/cli`'s `xplus4` handling, or the
Plus/4 rows of `docs/roadmap.md` (Phase 5) and `packages/studio/AGENTS.md`.
Read the root `AGENTS.md` first; the rules there apply to every target and
are not repeated. `packages/c64/AGENTS.md` is the useful contrast: the 264
series shares the C64's KERNAL calls, PETSCII, screen codes and IEC bus, and
nothing else that matters —

> **The Plus/4 is not a C64 with more colors. Its one chip, TED, is video,
> sound, timers, keyboard latch and ROM banking at once; it has no sprites,
> two square-wave voices, a CPU whose speed changes with what the display is
> doing, color memory that holds luminance as well as hue, a 2K screen
> block at `$0800` that is attribute-then-character, and 64K of RAM that is
> only reachable by banking the ROMs out. Model it as a memory-mapped
> 40×25 text/bitmap machine with 121 colors per cell and a bankable top
> half, never by translating VIC-II register numbers.**

The family's variety is in *models*: RAM (16K on the C16 and C116, 64K on
the Plus/4, 32K on the unreleased 232), whether the 6551 ACIA, user port
and "3-plus-1" function ROMs exist (Plus/4 only), PAL or NTSC, and the
256K/1M "Hannes"/"CSORY" expansions VICE emulates as a hack. Video, sound
and the keyboard latch are the same TED on every one of them.

## What exists today

Do not describe more than this as working:

- There is no `packages/plus4`, no `PLUS4_PROFILES`, no `FRAME_SYNC.plus4`,
  no `xplus4` entry in `packages/cli/src/run.mjs` (`VICE_EMULATOR` lists
  `xvic`, `x64sc`, `xpet`, `x128` only), and no `docs/setup/plus4.md`.
- The installed LLVM-MOS SDK (`~/.local/opt/llvm-mos`, clang 24.0.0git,
  llvm-mos `77a0dd93`) has no `plus4`, `c16` or `ted` platform under
  `mos-platform/`, and upstream `main` has none either (checked the
  `mos-platform` listing and the SDK README's platform table). The only
  upstream trace is issue #322, "Import @davidgiven's support for new
  targets", still open.
- VICE's `xplus4` **is** installed (`/opt/homebrew/bin/xplus4`, VICE 3.10,
  ROMs in `/opt/homebrew/share/vice/PLUS4/`). Nothing in the repo launches
  it.
- cc65 has mature `plus4` and `c16` targets (`plus4.h`, `c16.h`,
  `cbm264.h`, `_ted.h`, `plus4.cfg`, `c16.cfg`, `plus4-hires.cfg`,
  `ted-hi.tgi`, `plus4-stdjoy.joy`, `plus4-stdser.ser`) — the reference for
  register names, memory layout and a working banked crt0, not something
  the project builds with.

The rules below are what to hold that work to when it comes; don't write
docs implying any of it exists.

## Facts verified here

Cite these freely; each was read in the source named, or seen on screen
under `xplus4`, not recalled.

| Fact | Where |
| ---- | ----- |
| `xplus4 -model plus4` boots "COMMODORE BASIC V3.5 60671 BYTES FREE / 3-PLUS-1 ON KEY F1"; `-model c16` boots "COMMODORE BASIC V3.5 12277 BYTES FREE". Default screen at boot: a light-purple border, white background, black text. `-model c16` expands to `-ramsize 16 -functionlo "" -functionhi "" +acia`; `-model plus4ntsc` to `-ntsc -kernal kernal-318005-05.bin`. PAL exit screenshot is 384×288, NTSC 384×242. `-limitcycles N -exitscreenshot f.png +sound -warp` works headless. | `xplus4 -model plus4/c16/plus4ntsc -limitcycles 8000000 -exitscreenshot`, VICE 3.10, seen on screen and in the log |
| `xplus4` model flags: `-model c16/c16pal/c16ntsc, plus4/plus4pal/plus4ntsc, v364/cv364, c232`; `-ramsize 16/32/64`; `-memoryexphack 0 none / 1 CSORY 256KiB / 2 HANNES 256KiB / 3 HANNES 1MiB`; `-acia`, `-digiblaster`, `-sidcart` (`-sidcartaddress 0xFD40/0xFE80`), `-speech` (v364); cartridges `-cart`, `-cartcrt`, `-cartjacint`, `-cartmagic`, `-cartmulti`, `-cartspeedy`, `-c1lo/-c1hi/-c2lo/-c2hi`, `-functionlo/-functionhi`; `-fs8 <dir>` host directory as device 8; `-autostartprgmode 0/1/2`; `-drive8type` up to CMD HD; `-joydev1/2`; `-mouse`; `-pal/-ntsc`. | `xplus4 -help` |
| VICE ROM set: `kernal-318004-01.bin`, `kernal-318004-05.bin` (PAL), `kernal-318005-05.bin` (NTSC), `basic-318006-01.bin`, `3plus1-317053-01.bin`/`317054-01.bin`, `kernal-364.bin`, `c2lo-364.bin`; palettes `colodore_ted.vpl`, `yape-pal.vpl`, `yape-ntsc.vpl`; keymaps `gtk3_pos.vkm`, `gtk3_c16_pos_it.vkm`, `gtk3_c116_pos_it.vkm`. | `/opt/homebrew/share/vice/PLUS4/` |
| TED register block is `$FF00-$FF3F`: timers `$FF00-$FF05` (T1 counts down and reloads; T2/T3 run down then free-run from `$FFFF`), `$FF06` CR1 (TEST, ECM, BMM, DEN, RSEL, YSCROLL; default `$1B`), `$FF07` CR2 (RVSDIS, NTSC/PAL, TEDOFF, MCM, CSEL, XSCROLL; default `$08` PAL / `$48` NTSC), `$FF08` keyboard latch, `$FF09` IRQ flags (bit 7 IRQ, 6 T3, 4 T2, 3 T1, 1 raster; write 1s to clear), `$FF0A` IRQ enable + raster bit 8, `$FF0B` raster compare, `$FF0C/0D` cursor, `$FF0E/0F/10` voice frequencies, `$FF11` sound control, `$FF12` bitmap base (bits 5-3 = A15-A13) + charset-from-ROM bit 2 + voice 1 freq hi, `$FF13` charset base (bits 7-2 = A15-A10) + SINGLECLK bit 1 + read-only ROM/RAM bit 0, `$FF14` screen base (bits 7-3 = A15-A11, 2K granularity), `$FF15-$FF19` colors (background, color 1, 2, 3, border), `$FF1A/1B` bitmap character-row reload, `$FF1C/1D` raster line (readable **and writable**), `$FF1E` horizontal position, `$FF1F` flash counter + sub-line, `$FF3E` ROM in, `$FF3F` RAM in. Unused bits read back as 1. | plus4world Plus/4 Encyclopedia, *TED Registers* (500024); cc65 `include/_ted.h` field order; oxyron `registers_ted.html` |
| Color byte format everywhere (color registers and attribute memory): bits 0-3 chroma, bits 4-6 luma, bit 7 blink (attribute memory) / unused (registers). 121 colors = 15 chromas × 8 lumas + black (all lumas of chroma 0 are the same black). "White" is `$71`, a very light grey. | plus4world *TED Registers* palette section; cc65 `include/cbm264.h` (`CATTR_LUMA0..7 = 0x00..0x70`, `CATTR_BLINK 0x80`, `BCOLOR_*`, `COLOR_WHITE = BCOLOR_WHITE \| CATTR_LUMA7`) |
| Screen memory is one 2K block, positioned by `$FF14`: first 1K is the attribute (color+luma) memory, second 1K the character codes; the KERNAL's is `$0800` attributes and `$0C00` characters (`COLOR_RAM ((unsigned char*)0x0800)`). TED reads 40 + 40 bytes for each of the two "DMA lines" of a character row and stops the CPU while it does. | plus4world *TED Registers* "Video modes"; cc65 `cbm264.h`, `plus4.html` |
| Modes (ECM `$FF06` b6, BMM `$FF06` b5, MCM `$FF07` b4, RVSDIS `$FF07` b7): hires character 128 chars + reverse bit (default) or 256 chars (RVSDIS=1); ECM 64 chars with four background colors; multicolor character; hires bitmap 320×200; multicolor bitmap 160×200; ECM+MCM or ECM+BMM is an illegal (black) mode. In character modes bit 7 of a code inverts the glyph unless RVSDIS. | plus4world *TED Registers* "Configurations for the modes"; oxyron TED video-mode table |
| Sound: `$FF0E` + `$FF12` bits 1-0 = voice 1 (10-bit), `$FF0F` + `$FF10` bits 1-0 = voice 2; `$FF11` = bit 7 D/A mode, bit 6 voice 2 noise, bit 5 voice 2 square, bit 4 voice 1 on, bits 3-0 volume 0-8. Setting both voice-2 bits gives square. `reg = 1023 - (110840.46875 / Hz)` PAL, `1023 - (111860.78125 / Hz)` NTSC; `$3FF` is the lowest tone and `$3FE` locks the channel. | plus4world *TED Registers* `$FF0E-$FF12` |
| Clock is not one number. PAL, screen on, double clock: CPU ≈ 1,147,196 Hz; single clock forced (`$FF13` bit 1): 886,724; screen off (`$FF06` DEN=0): 1,695,665 (TED 1,773,448, 49.86 fps). NTSC: 1,052,124 / 894,886 / 1,711,274 (TED 1,789,773, 59.92 fps). TED has three schedules: CPU at double clock when it needs no memory, single clock while it fetches bitmap data, stopped on the two DMA lines per character row. Screen off gains "about 10000 clock cycles" a frame. | plus4world *CPU Speed* (500248) and *TED Registers* "Video modes" |
| Keyboard and joysticks: write a column-select value to **both** `$FD30` (6529 keyboard latch) and `$FF08` (TED, joystick latch), then read `$FF08`; a 0 bit in the answer is a pressed key. Selector bit 1 (`$FD`) reads joystick port 2, bit 2 (`$FB`) port 1: answer bits 0-3 up/down/left/right, bit 6 joy 1 fire, bit 7 joy 2 fire. Write `$FF` to the latch you are not interested in to keep keys and joysticks apart. | plus4world *Plus/4 Keyboard/Joystick Matrix* (500012); cc65 `libsrc/plus4/joy/plus4-stdjoy.s` (`sty TED_KBD / lda TED_KBD` with `#%11111011` / `#%11111101`, "and some keys — it's unavoidable") |
| ROM/RAM: any write to `$FF3E` pages the configured ROMs into `$8000-$FFFF`, any write to `$FF3F` pages RAM in; `$FDD0-$FDDF` (write to `$FDD0+n`) selects which LO ROM (`$8000-$BFFF`: BASIC, Function LO, Cart 1 LO, Cart 2 LO) and HI ROM (`$C000-$FBFF` + `$FF40-$FFFF`: KERNAL, Function HI, Cart 1 HI, Cart 2 HI) appear; `$FC00-$FCFF` is always KERNAL. Function ROMs are Plus/4 only. `$FF13` bit 0 reads back the current state. KERNAL helpers: `$FCF7` long fetch, `$FCFA` long jump; the KERNAL IRQ entry `$FCB3` and exit `$FCBE` handle re-banking via zero page `$FB`. | plus4world *ROM Banking* (500255) |
| I/O page `$FD00-$FFFF`: `$FD00-$FD0F` 6551 ACIA (Plus/4 only; cc65 `plus4.h` puts it at `0xFD00`), `$FD10` 6529B user port (Plus/4), `$FD15/$FD16` CSORY/Hannes RAM-expansion registers, `$FD30` 6529B keyboard latch, `$FD40-$FD5F` SID card (+ `$FD5E/5F` Digiblaster DAC/ADC), `$FDD0-$FDDF` ROM banking, `$FEC0-$FECF` 1551 device 9, `$FEF0-$FEFF` 1551 device 8. | plus4world *I/O Area Map* (500249); cc65 `include/plus4.h` |
| 7501/8501 on-chip port: `$0000` DDR (KERNAL sets `$0F`), `$0001` bits: 7 serial DATA in, 6 CLOCK in, 5 not implemented, 4 cassette read, 3 cassette motor (0 = on), 2 ATN out, 1 CLOCK out / cassette write, 0 DATA out. No memory-configuration bits here, unlike the 6510. | plus4world *CPU I/O Registers* (500290) |
| cc65 layout: Plus/4 programs load at `$1001` behind a BASIC stub, use `$1000-$FD00` with the ROMs banked **out**, stack at `$FCFF`; crt0 banks RAM in, installs its own `$FFFE/$FFFF` IRQ vector, and fakes an RTI frame to run the ROM handler with ROM banked in. C16 (`c16.cfg`) uses `$100D` to `$3FFF` (`$7FFF` with 32K) with ROMs banked **in**. Both crt0s print PETSCII 14 (`lda #14 / jsr $FFD2`) before `main()`. `plus4-hires.cfg` puts the bitmap at `$C000-$E000`. | cc65 `cfg/plus4.cfg`, `cfg/c16.cfg`, `libsrc/plus4/crt0.s`, `doc/plus4.html`, `doc/c16.html` |
| cc65's `waitvsync` spins until `$FF1C` bit 0 and `$FF1D` are both zero — raster line 0. `kbhit` reads the KERNAL buffer counts `$EF` (`KEY_COUNT`) and `$55D` (`FKEY_COUNT`). | cc65 `libsrc/plus4/waitvsync.s`, `kbhit.s`, `asminc/plus4.inc` |
| cc65's TED bitmap driver: luminance memory at `$0800`, chrominance at `$0C00` (luma base + `$400`), bitmap at `$C000`; asserts luma/chroma base on a 2K boundary and bitmap on an 8K boundary; sets `$FF12` bits 5-3 to the bitmap page, clears bit 2 to fetch from RAM, sets `$FF06` bit 5. In bitmap mode the attribute 1K supplies luminance and the character 1K supplies the two chroma nibbles per 8×8 block. | cc65 `libsrc/plus4/tgi/ted-hi.s` (`LBASE`, `CBASE`, `VBASE`, `INIT`) |
| Wikipedia-level model facts: 8-pin mini-DIN joystick ports (not DE-9), hardware 6551 UART on the Plus/4 up to 19,200 bit/s, C16/C116 16K, 232 (32K, no office ROMs) and V364 (keypad, speech) unreleased; C64 software-incompatible. | Wikipedia *Commodore Plus/4* |

## From the sources, not verified here

- The frame's raster-line count (312 PAL / 262 NTSC) and cycles per line
  are *to verify*: plus4world gives the CPU-frequency table above but this
  file did not read a line count. The `$FF1C/$FF1D` counter is readable, so
  a `FRAME_SYNC.plus4` can be a 'level' driver like the C64's; measure the
  period under `xplus4` before writing a constant, or measure it at start-up
  with a TED timer as `FRAME_SYNC.pet` does.
- Which chroma nibble of the character byte is the "0" pixel color versus
  the "1" pixel color in hires bitmap mode, and the bit-pair → register
  mapping in multicolor bitmap mode, are *to verify* against
  plus4world's TED page (it continues past the point read here) or the
  cc65 driver's `SETPIXEL`.
- Whether VICE's `-autostartprgmode 1` (RAM inject) starts a `$1001` PRG
  on `xplus4` the way it does on `xvic`/`x64sc` is *to verify*; the boot
  screenshots above did not autostart anything.
- Hannes/CSORY expansion register semantics (`$FD16`/`$FD15`) are *to
  verify*; VICE calls them a "memory expansion hack" and they are not part
  of any shipped machine.
- The exact `$FF07` bit 6 behavior on a real machine: plus4world says
  flipping PAL/NTSC "will not change the machine to the other video
  standard" because the crystal does not change; the CPU-speed table lists
  the four crystal/bit combinations. Treat the bit as read-mostly.

## Corrections to the brief and the roadmap

- **"121 colors (16 hues × 8 luma)"**: it is 15 chromas × 8 lumas + one
  black; the 8 lumas of chroma 0 are identical (plus4world). The number is
  right, the arithmetic is not.
- The brief's "2 voices square + noise" is right but needs the asymmetry:
  only voice 2 can be noise, and it is square *or* noise, never both.
- The roadmap says the Plus/4 is "less frictionless on the LLVM-MOS path";
  concretely there is **no** LLVM-MOS platform for it, installed or
  upstream. The route is a new platform derived from `mos-platform/commodore`
  (see "LLVM-MOS" below) or a second backend on cc65.

## Rules for this target

### Models are profiles

- A `PLUS4_PROFILES` table should carry the axes VICE's `-model` carries:
  `c16` (16K, ROMs banked in, no ACIA, no function ROMs), `plus4` (64K,
  ACIA, function ROMs), PAL/NTSC as a region flag, and `-ramsize` for a C16
  expanded to 64K. The C16 profile is the portable one: a C16 build runs on
  a Plus/4, not the reverse (cc65 says the same). Screen geometry is the
  same on all of them, so no geometry twin is needed; the RAM top, whether
  the program may bank the ROM out, and whether the ACIA exists are what
  differ.
- Do not derive the model from RAM at run time, and do not probe for the
  function ROMs. Width is not an axis here; memory ceiling and chip
  presence are.

### Memory and banking

- With ROM banked in (the only state the KERNAL and BASIC support), user
  RAM ends at `$8000` on a 64K machine. Everything above is reachable only
  by writing `$FF3F`, and while RAM is in, `$FFFE/$FFFF` are RAM too:
  install a vector there before enabling interrupts, or keep them off
  (cc65's crt0 does the former and fakes an RTI to let the ROM handler
  run). This is the root rule for banked machines: a pointer into
  `$8000-$FFFF` is only meaningful with the bank state.
- `$FF3E`/`$FF3F` are global state; `$FDD0-$FDDF` is more global state.
  Generated interrupt code that touches either must restore both.
- Reserve `$FD00-$FFFF` as I/O regardless of banking; `$FC00-$FCFF` is
  always KERNAL.
- The screen block is 2K, attributes first; `$FF14` places it on any 2K
  boundary, `$FF13` places the charset on any 1K boundary (`$FF12` bit 2
  says ROM or RAM), `$FF12` places a bitmap on any 8K boundary. Keep these
  as one "video layout" record a package owns; never let a program set one
  without the others.

### The screen

- A cell is two bytes in two different kilobytes: character at
  `$0C00 + cell`, color+luma at `$0800 + cell`. `putColor` here is real and
  richer than the C64's: the attribute byte carries hue, brightness and
  blink. A portable color name must resolve to a chroma *and* a luma
  (cc65's `COLOR_*` table is a good default mapping); expose luma as the
  Plus/4's own extension, not as a portable concept.
- The border color is `$FF19`, the background `$FF15`; both are the same
  chroma/luma byte format. `screen.setColors()` maps directly.
- There is no reverse-video bit in hardware unless RVSDIS is clear: with
  the default 128-glyph set, bit 7 of a code inverts. Enabling 256
  glyphs costs reverse video. Pick one per build and say which.
- Text and bitmap writes may happen at any time; the only reason to sync
  is tearing. But the CPU is *stopped* on DMA lines and halved during
  fetches, so per-frame budgets must be measured with the screen on. A
  "cycles per frame" constant from the C64 is wrong here twice over.
- Hardware fine scroll exists (`$FF06` YSCROLL, `$FF07` XSCROLL, 38/24
  column/row modes) and `$FF1A/1B` re-points the bitmap row counter; a
  scrolling API can use them. There is one layer and no sprites: anything
  that moves is drawn by the program.

### Sound is two voices

- Voice 1 is a square wave; voice 2 is a square wave or noise; both share
  one 4-bit volume with a maximum of 8. There are no envelopes, no
  filter, and no waveform choice. A note-level API has two voices, one
  volume, and a noise flag on the second; document that and stop.
- `$FF11` bit 7 (D/A mode) is how the Plus/4 plays samples; it is a
  CPU-driven trick, not a channel.
- The period formula differs PAL/NTSC; the region is a build property
  (profile), not something to detect.

### Input is a latch, not a matrix scan

- Write the selector to `$FD30` and `$FF08`, read `$FF08`, once per frame
  into a snapshot, the way `@8bitscript/pet/keyboard` does. The
  selector→answer table is the only keyboard table; the C64's is wrong
  here (different matrix, different chips).
- Joysticks come through the same `$FF08` read; a joystick API reads with
  `$FD30 = $FF` so keys do not alias directions. The ports are mini-DIN;
  an emulator maps them to whatever, hardware needs an adapter.
- The KERNAL IRQ scans the keyboard through the same latch every frame.
  A program that polls `$FF08` itself should do so under `sei` or with the
  KERNAL IRQ off, as cc65's driver does (`sei` … `cli`).

### Frame timing

- `$FF1C/$FF1D` is a readable raster counter: a level-style
  `FRAME_SYNC.plus4` polls it exactly as the C64's polls `$D012`, with the
  9th bit in `$FF1C` bit 0. Do not hardcode cycles per frame until measured
  under `xplus4 -model plus4` and `-model plus4ntsc`; the CPU rate depends
  on DEN and SINGLECLK and the frame rate is 49.86/59.92 Hz.
- TED's raster IRQ (`$FF0A` bit 1 + `$FF0B`) and three timers exist; the
  timers count single clocks and stop between the low and high write.

### LLVM-MOS

- No platform exists. The shape of one is already in the SDK:
  `mos-platform/commodore/lib/commodore.ld` produces a PRG with a BASIC
  `SYS` stub from `__basic_zp_start`, `basic-header.o` and a per-machine
  `link.ld` (the `pet` and `c64` platforms are the models). A `plus4`
  platform would set the load address to `$1001`, RAM top to `$8000`
  (ROM in) or `$FD00` (ROM out, with the banking prologue), and would
  inherit the Commodore libc — including `char-conv.c`'s `.init.250`
  `CHR$(14)` switch that `packages/backend-6502` already suppresses for
  the PET (`commodoreCharsetGuard()`); the same guard applies here.
- Until then the alternative is cc65 (`plus4`/`c16`), whose banked crt0 is
  the working reference for the interrupt/bank dance.

## Emulator

- **VICE `xplus4`** is the project's choice: installed, same infrastructure
  as the other Commodore targets (`-autostartprgmode 1`, `-limitcycles`,
  `-exitscreenshot`, `-warp`, `+sound`, the remote monitor), and it
  models every variant (`-model`, `-ramsize`, `-memoryexphack`, carts, SID
  card, Digiblaster, ACIA, 1551). Host filesystem: `-fs8 <dir>` (device 8
  as a directory, with P00 options). Screenshot route: exactly the PET's
  (`-limitcycles N -exitscreenshot f.png`), verified above.
- MAME has `plus4`, `plus4p`, `c16`, `c16p`, `c116`, `c232`, `v364`
  drivers (`mame.lst`); a second opinion, not the project's route.

## Traps for someone who knows the C64

1. **No sprites.** Not fewer, none. Movable objects are software.
2. **The CPU has no fixed speed.** It stops on DMA lines, halves while
   fetching, and doubles when the screen is off; a C64 cycle budget is
   wrong in both directions. Measure with the screen on.
3. **Color RAM is not a nibble at `$D800`.** It is a full byte at `$0800`
   with hue, luma and blink, and it sits *below* the character codes at
   `$0C00` in one 2K block that `$FF14` moves as a unit.
4. **The keyboard is not `$DC00/$DC01`.** Two latches (`$FD30`, `$FF08`),
   one read, joysticks mixed in unless you mask the other latch.
5. **The top 32K is ROM until you say otherwise** and once you do, the
   IRQ vector is yours. 64K free is a banking model, not a RAM size.
6. **Joystick ports are mini-DIN**; the C16's RAM is 16K; the ACIA and
   function ROMs are Plus/4 only. "Plus/4" is a family, so profile it.
