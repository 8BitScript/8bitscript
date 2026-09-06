---
title: Oric-1 / Atmos
nav_order: 13
---

# Writing Oric-1 / Atmos support for 8BitScript

This file is for anyone — human or agent — touching a future
`packages/oric`, an `ORIC_PROFILES` entry in `packages/backend-6502`, a
`FRAME_SYNC.oric` driver, an Oricutron entry in `packages/cli/src/run.mjs`,
or the Oric rows of `docs/roadmap.md` (Phase 5) and
`packages/studio/AGENTS.md`. Read the root `AGENTS.md` first; the rules
there apply to every target and are not repeated. `packages/pet/AGENTS.md`
is the nearest contrast: one CPU, RAM, a ROM, a 6522 VIA and a keyboard
matrix — plus, here, an ULA that draws colour from *serial attributes*
inside the screen bytes and an AY sound chip hung off the VIA —

> **The Oric is a 1 MHz 6502 with a video ULA that reads screen memory
> like Teletext: a byte with bits 6 and 5 clear is not a character but an
> attribute (ink, paper, charset/height/blink, or the video mode itself)
> that occupies its cell, shows as paper, and applies to the rest of the
> line. There are 8 colours, 40×28 text cells of 6×8 pixels, a 240×200
> hires bitmap with the same attribute rule per 6-pixel byte, an
> AY-3-8912 reached through the VIA, a keyboard matrix scanned through
> the same VIA and AY, and no vertical-sync signal the CPU can see. Model
> it as a 40-column serial-attribute display with a 6-pixel byte, never
> as "a Spectrum" or "a PET with colour".**

The family's variety is in *models and add-ons*: Oric-1 (ROM 1.0) versus
Atmos (ROM 1.1, better keyboard), 16K versus 48K RAM, whether a Microdisc
(WD1793 at `$0310`, overlay RAM under the ROM) or Jasmin (WD1773 at `$03F4`)
disc system is fitted, the Telestrat (64K, second VIA, ACIA, cartridge
ROMs, built-in joystick ports), and the joystick interfaces (IJK, PASE/Altai).

## What exists today

Do not describe more than this as working:

- There is no `packages/oric`, no `ORIC_PROFILES`, no `FRAME_SYNC.oric`,
  no emulator entry in `packages/cli`, and no `docs/setup/oric.md`.
- **No LLVM-MOS platform exists for the Oric**, installed or upstream
  (`~/.local/opt/llvm-mos/mos-platform/` and upstream `main` both lack it;
  the SDK README does not list it; issue #322 is the only trace).
- Oricutron is not installed (`oricutron` not on PATH; no Homebrew formula
  found); MAME (`oric1`, `orica`, `telstrat` drivers) is a Homebrew
  formula, not installed.
- cc65 has an `atmos` target (`atmos.h`, `atmos.inc`, `atmos.cfg`,
  `atmos-240-200-2.tgi`, `atmos-228-200-3.tgi`, `atmos-ijk.joy`,
  `atmos-pase.joy`, `atmos-acia.ser`) and a `telestrat` target — the
  reference for the memory layout, tape format and joystick/keyboard
  code. It "is not Oric-1 compatible" and has no disk I/O.

The rules below are what to hold that work to when it comes.

## Facts verified here

Cite these freely; each was read in the source named, not recalled.
Nothing in this file was seen on screen — no Oric emulator is installed.

| Fact | Where |
| ---- | ----- |
| Memory map (BASIC, text mode): `$0000` zero page (`$00-$0B`, `$BB-$BC`, `$F3-$F9` unused by BASIC), `$0100` stack, `$0200` page 2, `$0300-$03FF` I/O, `$0400-$04FF` Sedoric code, `$0500-$B3FF` BASIC program RAM, `$A000-$BFDF` HIRES screen, `$B400-$B4FF` spare, `$B500-$B7FF` standard character set, `$B800-$B8FF` spare, `$B900-$BB7F` alternate character set, **`$BB80-$BF3F` TEXT screen**, `$BF40-$BF67` spare, `$BF68-$BFDF` TEXT bottom screen (the 3 lines under hires), `$BFE0-$BFFF` spare, `$C000-$FFFF` ROM / overlay RAM. | Defence Force wiki `oric:software:memory_maps` |
| I/O page 3: `$0300-$030F` internal 6522 VIA; `$0310-$0313` Microdisc WD1793 (+ `$0314-$031B` its registers); `$0310`/`$0320` DK'tronics joystick ports; `$031C-$031F` internal 6551 ACIA (Telestrat); `$0320-$032F` second VIA (Telestrat) / RS232 extension (Atmos); `$0360-$0371` ICM7170 RTC; `$03E0-$03E1` lightpen; `$03F4-$03FF` Jasmin WD1773. CPU vectors `$FFFA/$FFFC/$FFFE`. | same page |
| ULA attribute decoding: a screen byte with bits 6 and 5 both clear (`(c & 0x60) == 0`) is a serial attribute; it is rendered as an empty block in the current colours (inverted if bit 7) and then decoded by `attr & 0x18`: `0x00` ink = bits 0-2; `0x08` text attributes bits 0-2 (bit 0 alternate charset, bit 1 double height — the row's scanline becomes `(y>>1)&7`, bit 2 blink); `0x10` paper = bits 0-2; `0x18` video mode bits 0-2 (bit 2 hires, bit 1 60 Hz/50 Hz, the emulator's `vid_freq`), switching the screen base and charset base at once. Line start resets ink 7, paper 0, no text attributes. Power-up default is attribute `$1A` (text, 50 Hz). Non-attribute bytes: in text mode bits 0-6 index the 8-byte glyph, in hires bits 0-5 are six pixels; bit 7 inverts either. | Oricutron `ula.c` `ula_decode_attr`, `ula_raster_default`, `ula_powerup_default`, render loop |
| Oricutron's frame model: 64 CPU cycles per raster line; PAL 312 lines (308 + 4 vsync; "T1 period 19966"), NTSC 264 (260 + 4; "T1 period 16894"); 224 visible lines centred; vsync as seen on VIA CB1 is a 260 µs negative pulse 12 µs after the RGB vsync. `--vsynchack` wires that pulse to CB1. | Oricutron `ula.c` frame timing block |
| Keyboard: 8×8 matrix; column selected through AY register `$0E` (port A) with a 0 bit (`$FE…$7F`), row through VIA port B bits 0-2, result on VIA port B bit 3. Row contents (column order as the wiki lists them; some rows have an empty column the text scrape did not preserve — rebuild a `Key` table from the wiki page itself, not from this cell): row 7: 8 L 0 / RShift RET =; row 6: Y H G E AltGr A S W; row 5: U I O P Funct DEL ] [; row 4: Space , . Up LShift Left Down Right; row 3: K 9 ; - # \ '; row 2: M 6 B 4 LCtrl Z 2 C; row 1: J T R F ESC Q D; row 0: 7 N 5 V RCtrl 1 X 3. Funct is Atmos/Telestrat only; AltGr, # and RCtrl exist only under the Euphoric emulator. | Defence Force wiki `oric:hardware:oric_keyboard` |
| VIA ↔ AY wiring: port A carries the AY data bus; CA2 drives BC1 and CB2 drives BDIR (Oricutron: `via_main_w_ca2ext` → `ay_set_bc1`, `w_cb2ext` → `ay_set_bdir`; the Telestrat's second VIA has CA2 not connected and CB2 to MIDI); port B bit 6 = tape motor (`orb & ddrb & 0x40`); joystick masks are rebuilt on port writes. AY-3-8912 at 1 MHz; 16 registers: three 12-bit tone periods, 5-bit noise, mixer R7, volumes R8-R10 with envelope bit, envelope period R11/R12 and shape R13, R14 port A (keyboard). | Oricutron `via.c`; Defence Force wiki `oric:hardware:sound` (WebFetch summary) |
| cc65 `atmos.cfg`: 24-byte tape header (`TAPEHDR`, `$1F` bytes incl. the sacrificial one), BASIC stub at `$0501` (13 bytes) then code, RAM end `$9800` (`$B400` with `-D __GRAB__=1`, which takes the hires area), zero page `$E2-$FB` (26 bytes), 2K stack, `__AUTORUN__=$C7` to auto-run, `__PROGFLAG__` `$00` BASIC / `$80` machine code. `atmos.inc`: 40×28 screen, `SCREEN := $BB80`, `KEYBUF := $02DF` (bit 7 = new key), `MODEKEY := $0209`, `CAPSLOCK $020C`, `STATUS $026A`, `BACKGRND/FOREGRND $026B/$026C`, `IRQVec $0245`, `PARAM1-3 $02E1-$02E6`; ROM entries `TEXT $EC21`, `HIRES $EC33`, `CURSET $F0C8`, `DRAW $F110`, `CHAR $F12D`, `POINT $F1C8`, `PAPER $F204`, `INK $F210`, sound effects `PING $FA9F`, `SHOOT $FAB5`, `EXPLODE $FACB`, `ZAP $FAE1`, `TICK $FB14`, `TOCK $FB2A`. crt0 clears STATUS bit 5 to "unprotect screen columns 0 and 1 (where each line's color codes would sit)". | cc65 `cfg/atmos.cfg`, `asminc/atmos.inc`, `libsrc/atmos/crt0.s`, `doc/atmos.html` |
| cc65 `waitvsync` "requires VSync hack": spins while VIA port A (no handshake, `$030F`) bit 4 is set. `kbhit`/`cgetc` read `KEYBUF` bit 7 from the ROM IRQ's buffer and `MODEKEY == $A5` for Funct. TGI: `atmos-240-200-2` (default, 2 colours) and `atmos-228-200-3` (228×200, "two colors from eight" + XOR, 6×8 system font — the 12 pixels lost are presumably two attribute cells per line, *to verify*); joystick drivers: IJK (select left/right with VIA port A bits 7/6 as outputs, read 5 bits back; printer strobe forced output) and PASE (port A bits 7/6 select, read inverted); masks UP `$10`, DOWN `$08`, LEFT `$01`, RIGHT `$02`, FIRE `$20`. Colours `COLOR_BLACK 0 … WHITE 7` in the order black, red, green, yellow, blue, magenta, cyan, white. `atmos_load/atmos_save` are tape; no disk I/O; no mouse. | cc65 `libsrc/atmos/waitvsync.s`, `kbhit.s`, `cgetc.s`, `tgi/atmos-228-200-3.s`, `joy/atmos-ijk.s`, `joy/atmos-pase.s`, `include/atmos.h`, `doc/atmos.html` |
| Wikipedia: Oric-1 (1982) 6502A at 1 MHz, 16K or 48K (48K boards carry 64K, top 16K under the ROM; the disc unit can page the ROM out to use it), 16K ROM, HCS 10017 ULA, AY-3-8912, 40×28 text with 80 user-definable characters and serial attributes that "take up one character position" and last to end of line or the next attribute, a parallel inverse attribute per cell, "a fixed black border", 240×200 hires plus 3 text lines, tape at 300/2400 baud, Centronics printer port, PAL UHF and RGB out; Atmos (1984) = ROM 1.1 + keyboard; Stratos/Telestrat 64K. | Wikipedia *Oric (computer)* |
| Oricutron (ReadMe 1.2): `-m oric1 | o16k | atmos | telestrat | pravetz`, `-d disk.dsk`, `-t tape.tap` (`.tap`, `.ort`, `.wav`), `-k microdisc | jasmin | bd500 | pravetz`, `-s symbols`, `-f/-w`, `-R soft|opengl`, `-b` debugger, `-r` breakpoints, `--turbotape`, `--lightpen`, `--vsynchack on|off`, `--scanlines`, `--serial none|loopback|modem|com`; keys F1 menu, F2 monitor, F3 NMI reset, F4 hard reset, F6 warp, F7 save disks, F9 save tape, F10 AVI capture, **PrtSc save screen as BMP**; monitor has `ns/nl` snapshots, breakpoints, symbols; a CH376 (USB/SD FAT32 chip) emulation reads the host `usbdrive/` folder; ports for Windows, macOS, Linux, Amiga, BeOS; "Video: 100% done, VIA 95%, AY 99%, Tape 99%, Disk 90%". | `pete-gordon/oricutron` `ReadMe.txt` |
| MAME drivers `oric1`, `orica` (Atmos), `telstrat` exist. | MAME `mame.lst` |

## From the sources, not verified here

Each is a lead to confirm the first time code depends on it.

- **Hires charset addresses**: in hires mode the ULA takes the standard
  and alternate charsets from `$9800` and `$9C00` (the text-mode ones are
  `$B400`/`$B800` in most docs; the wiki lists the used parts `$B500` and
  `$B900`) — *to verify*; Oricutron switches `vid_ch_base` with the mode
  (`vidbases[1]` vs `[3]`), which confirms the *mechanism*.
- The exact attribute values a program should use: ink 0-7, text
  attributes 8-15 (8 = standard/single/steady), paper 16-23, mode 24-31
  (`26` text 50 Hz per Oricutron's power-up `$1A`, `30` hires 50 Hz, `24`
  and `28` their 60 Hz twins if bit 1 means 60 Hz) — the *groups* are
  verified from the emulator; Oricutron reads bit 1 set as 50 Hz (`vid_freq = vid_mode & 2`, PAL schedule when set) — hardware sense still *to verify* against
  the ULA documentation (Oricutron names it `vid_freq` and picks the 312-
  line schedule when it is set).
- **ROM IRQ**: the ROM programs VIA T1 as a 100 Hz free-running timer
  (10000 cycles) and scans the keyboard in the IRQ — *to verify* (the
  emulator's "T1 period 19966/16894" comments describe the frame, not the
  ROM's setting).
- Visible geometry: 40×28 text cells × 6×8 pixels = 240×224 (Oricutron
  shows 224 visible lines), hires 200 lines + 3 text rows (24 lines) —
  consistent, *to verify* on hardware.
- 16K machines: `$0500-$3FFF` user RAM with the screen at `$BB80`
  mirrored (*to verify* how the 16K board decodes the screen).
- Microdisc overlay RAM (`$C000-$FFFF` becomes RAM with the ROM disabled
  by a register at `$0314`) and Sedoric's use of `$0400` — *to verify*.
- The AY's port A is also the printer data bus on the Oric; writing R14
  while printing conflicts — *to verify*.
- Oricutron's macOS build today (the ReadMe is from 2014; the GitHub
  repository is active) and whether any newer version adds a headless
  or screenshot flag — *to verify*. `Phosphoric` (a cycle-accurate
  Oric emulator with "MJPEG/AVI capture" and "deterministic record/replay")
  surfaced in search results and was not examined.

## Corrections to the brief

- The sound chip is the **AY-3-8912** (the one-port variant; pin count *to verify*), not the
  8910; the register map is the same and port A is the keyboard column
  select (Wikipedia, Defence Force wiki, cc65).
- "40×28 text" is right; add that the cell is 6 pixels wide, so "40
  columns" is 240 pixels and a hires byte is one text cell wide.
- "8 colours" is right, but an attribute changes *ink or paper*, one at a
  time, and each change costs a cell; two attributes (ink and paper) cost
  two cells. A line can show any colours but only through those cells.

## Rules for this target

### Models are profiles

- `ORIC_PROFILES` should carry `oric1-16k`, `oric1-48k`, `atmos` (ROM 1.1
  — different ROM entry points and zero page use; cc65's `atmos.inc` is
  "BASIC 1.1 addresses"), `telestrat`, and the media axis `tape`,
  `microdisc`, `jasmin` (each moves what is usable above `$9800` and whether
  the ROM can be paged out). The Oricutron `-m` names are the community's.
- Video frequency (50/60 Hz) is set by the program through an attribute,
  not by the machine; treat it as a build property that the package writes
  once, and pace `waitFrame()` from it.

### The screen is bytes with attributes in them

- Text cell (x, y) is `$BB80 + y*40 + x`; hires byte (x/6, y) is
  `$A000 + y*40 + x/6`, six pixels, bit 6 must be set (or the byte is an
  attribute), bit 7 inverts. Writes may happen at any time.
- **An attribute eats a cell.** The portable text surface must reserve
  the cells it spends: the cheapest honest model is "column 0 = ink,
  column 1 = paper" per line (cc65's crt0 unprotects exactly those two
  columns; BASIC keeps them) and a 38-column text area. A richer model
  lets a program place attributes anywhere and pays a cell each time —
  expose that as the Oric's own extension, not as `putColor`.
- `putColor(cell, colour)` for one cell is impossible without spending a
  neighbouring cell; a per-cell colour intent maps to "inverse video"
  (bit 7, free) or to a two-cell ink change. Document which.
- There is no border colour (fixed black), no background register:
  `setBorder()` is inert; `setBackground()` is a paper attribute at the
  start of every line (28 cells, or 200 + 3 lines in hires).
- Double height, blink and the alternate charset are attributes too, and
  the alternate set (80 user glyphs) plus the redefinable standard set
  (all of it is RAM at `$B400`/`$B800`) are the "pseudo-pixel" surface:
  a redefined 6×8 glyph gives a 6×8 pseudo-pixel grid per cell.
- No hardware scroll, no sprites, no collision: software all round. The
  6-pixel byte makes horizontal software scrolling awkward; design
  around cell moves.

### Sound is an AY behind a VIA

- Every AY register write is: data to VIA port A, then BC1/BDIR pulses
  through CA2/CB2 via the PCR — cc65 and the ROM do it; a package must own
  the sequence and never leave CA2/CB2 in a state that breaks the keyboard
  scan (which uses the same path for R14).
- Three square-wave voices, one noise generator mixed into any of them,
  one hardware envelope, 4-bit volumes: a note-level API has three voices
  with volume and one shared envelope. The ROM's `PING/SHOOT/EXPLODE/ZAP`
  are convenience presets, not a capability.
- No hardware entropy; VIA T2 or the frame counter is the seed.

### Input is the matrix through the AY

- Select a column by writing AY R14 (through the VIA), select a row on VIA
  port B bits 0-2, read port B bit 3. Snapshot once per frame, after the
  frame wait, the way `@8bitscript/pet/keyboard` does; the ROM IRQ scans
  the same matrix and shares the VIA, so scan under `sei` or with the ROM
  IRQ replaced.
- The ROM's own buffer (`$02DF`, bit 7 ready) is the "typed character"
  surface and is only alive while the ROM IRQ runs.
- Joysticks are third-party interfaces (IJK, PASE/Altai on the expansion
  bus, DK'tronics at `$0310/$0320`, Telestrat's own ports on its second
  VIA): capability by profile, read through VIA port A with the select
  sequences cc65's drivers show. No mouse; a lightpen at `$03E0` exists
  as an add-on.

### Frame timing

- **The CPU cannot see vsync on a stock Oric.** The frame runtime has
  three choices: (a) the VSync hack (Oricutron `--vsynchack`, cc65's
  `waitvsync`: CB1 low pulse, VIA port A bit 4 — hardware needs a wire),
  (b) a VIA timer paced to the frame (T1 at 19966/16894 cycles per
  Oricutron's model, ~20000/16667 by clock) — free-running, never
  re-synchronised, so tearing is a matter of luck, or (c) count from the
  ROM's 100 Hz tick. `FRAME_SYNC.oric` should be (b) with the period a
  profile constant and no pretence of tear-free updates, and (a) as an
  opt-in for emulators and modified machines.
- 64 cycles per line, 312 lines PAL per the emulator: 19968 cycles per
  frame, so a frame is ~20 ms of a 1 MHz CPU — the same budget as a PET.

### LLVM-MOS

- No platform exists. A custom `PARENT common` platform (template:
  `mos-platform/eater/lib/link.ld`) would emit a `.tap` (24-byte header,
  load `$0501` behind a BASIC `CALL` stub, `__AUTORUN__=$C7`, one padding
  byte — cc65's `atmos.cfg` is the format reference), keep zero page to
  `$E2-$FB` unless the ROM is abandoned, put RAM top at `$9800` (or
  `$B400` when hires is unused, `$A000`-`$BFFF` being screen/charsets),
  and route stdio through the ROM's `PRINT` (`$F77C`) or its own writes at
  `$BB80`. A disc profile (Sedoric/Microdisc) changes the load format and
  frees the overlay RAM.
- The alternative is cc65's `atmos`/`telestrat` targets, whose crt0 and
  drivers are cited above.

## Emulator

- **Likely project choice: Oricutron** — the community's emulator, models
  every machine and disc controller (`-m`, `-k`, `-d`, `-t`), has a
  monitor with symbols, breakpoints and snapshots, `--vsynchack` to prove
  a vsync-based frame driver, AVI capture (F10) and a screenshot key
  (PrtSc → BMP). What it lacks in the documentation read: a headless or
  exit-screenshot flag and a plain host-directory mount (the CH376
  emulation maps `usbdrive/` but needs the Oric-side CH376 software).
  Build for macOS exists in the credits; current status *to verify*.
- **MAME** (`oric1`, `orica`, `telstrat`) is the headless candidate
  (`-str`, `-video none`, `-cass f.tap`? — *media flags to verify*, Lua
  `video:snapshot()`).
- Tape images (`.tap`) are the universal interchange; `.dsk` for
  Microdisc/Jasmin; a host-file route is a conversion step, not a mount.

## Traps for someone who knows the C64

1. **Colour is a byte in the row, not a cell attribute.** Change ink and
   you lose the cell you wrote it in; it shows as paper. Two changes cost
   two cells. Nothing is per-cell but inverse.
2. **A screen byte with bits 6 and 5 clear is a command.** Writing a
   character code below `$20` or a hires byte without bit 6 set does not
   draw — it re-colours the line, or worse, switches to hires.
3. **Six pixels per byte, 40 bytes per line.** Not 8; 240 across, and
   a text cell is 6 wide.
4. **No vsync for the CPU.** `waitFrame()` is a timer unless the machine
   is modified or the emulator hack is on.
5. **The keyboard is behind the sound chip.** Column select is AY R14
   through VIA port A with the BC1/BDIR handshake; a wrong PCR kills both
   sound and keys.
6. **Two ROMs, two machines.** Oric-1 and Atmos differ in ROM entry
   points and zero page; cc65 supports only the Atmos.
