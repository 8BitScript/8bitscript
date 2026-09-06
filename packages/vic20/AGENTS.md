# Writing Commodore VIC-20 support for 8BitScript

This file is for anyone — human or agent — touching `packages/vic20`,
this package's hardware catalog (`package.json`, `"8bitscript".hardware`:
`ram`, `port1`), `packages/backend-6502`'s `FRAME_SYNC.vic20`,
`packages/cli`'s `xvic` handling (`VICE_MODEL_ARGS.vic20`, the `--screenshot`
cycle counts), or the VIC-20 rows of `docs/roadmap.md`, `docs/setup/vice.md`
and `packages/studio/AGENTS.md`. Read the root [`AGENTS.md`](../../AGENTS.md)
first; the rules there apply to every target and are not repeated.
[`packages/c64/AGENTS.md`](../c64/AGENTS.md) is the closest relative and the
most dangerous one to reason from: the two machines share a CPU, a KERNAL
lineage, a `.prg` format and an emulator suite, and almost nothing about
their video, sound, memory or input. [`packages/pet/AGENTS.md`](../pet/AGENTS.md)
is the useful contrast on memory: the PET's RAM changes where the *stack*
is; the VIC-20's changes where the *screen* is —

> **The VIC-20 is a 22×23 character grid drawn by a chip that can only see
> the 5K of internal RAM and the ROM at `$8000` — never the expansion, not
> even the 3K block — on a machine whose
> screen, colour RAM and program all move when RAM is added. Sixteen colours
> exist but only eight of them can be a border or a character; sound is
> three square waves and a noise source behind one volume; there are no
> sprites, no bitmap, no raster interrupt and no vertical-blank flag. Model
> it as a small, relocating text grid with a raster counter to poll — never
> as "a C64 with fewer columns".**

The machine's variety is in *RAM expansion*, and that one axis moves the
program's load address, the screen matrix, the colour RAM and the top of
memory together: the `ram` option's five values are the five
configurations the SDK's link script and VICE both accept, not a choice
this project made.

## What exists today

Do not describe more than this as working:

- `packages/vic20/src/index.8bs` exports two registers: `vicColor`
  (`$900F`: bits 4–7 background, bit 3 normal/inverted video, bits 0–2
  border) and `memoryPointer` (`$9005`: bits 4–7 the screen base, bits 0–3
  the character base). They are the only hardware the two portable
  surfaces need: `src/screen.8bs` (behind `@8bitscript/screen`, as
  `@8bitscript/vic20/screen`) and `src/text.8bs` (behind
  `@8bitscript/text`).
- `screen.setColors(border, background)` is one write of `$900F`, border
  masked to 3 bits, bit 3 held at 1; `setBorder`/`setBackground` mask and
  rewrite the register. `BorderColor` has the first eight colours and
  `BackgroundColor` all sixteen — two namespaces because the chip draws that
  line, not a preference. `screen.blank()` writes the space screen code to
  `Video.CELL_COUNT` (506) cells at `Video.SCREEN`.
- `text.putChar(cell, code)` takes ASCII, converts to a screen code
  (`A`–`Z` → 1–26, 32–63 unchanged), writes `Video.SCREEN + cell`, and
  before every run of text stores `Video.MEMORY_POINTER_UPPERCASE` in
  `$9005` — the value that names both this hardware's screen base and the
  upper-case ROM. `putColor`/`place` write the low three bits of the colour
  to `Video.COLOR + cell` (bit 3 would make the cell multicolour).
  `text.COLUMNS` is 22 and `text.CELL_COUNT` 506 whatever RAM is fitted. Writes
  happen at any time; there is no vertical-blank queue and none is needed.
- **Hardware** (the catalog in `package.json`): `ram` — `none` (default),
  `3k`, `8k`, `16k`, `24k` — exactly the five `__memory_expansion` values
  the SDK's `vic20/lib/link.ld` asserts on, and exactly what `xvic
  -memory` takes (`none/3k/8k/16k/24k`); presets `unexpanded`, `3k`, `8k`,
  `16k`, `24k` keep the old `--profile` names. A value sets the link (its
  `build.defsym`, `__memory_expansion=N`), the geometry file the package
  reads through its tag (`geometry.8bs` for none and 3k — screen `$1E00`,
  colour `$9600`, `$9005 = $F0`; `geometry.vic20.expanded.8bs` for 8k, 16k
  and 24k, which all carry the tag `expanded` — screen `$1000`, colour
  `$9400`, `$9005 = $C0`; `packages/compiler/test/vic20-profiles.test.mjs`
  holds the tags and the two files to this), the `-memory` flag `8bs run
  vic20` passes so the emulated RAM matches the link, and a `memory.ram`
  fact. A non-default value is in the output name
  (`main-vic20-8k-ntsc.prg`). `port1` — `joystick` (default), `none`,
  `paddles`, `mouse1351` (`-controlport1device`; the 1351 on a VIC-20 is
  *to verify* on hardware, below).
- `FRAME_SYNC.vic20` (`packages/backend-6502`) is a *level* driver on the
  VIC's raster counter: `$9004` holds bits 8–1 of the line and changes every
  second line, the top half of the frame is `$9004 < 64`, and `$9004 >= 140`
  is a line only PAL has (NTSC tops out around 130). NTSC is 261 × 65
  cycles at 14318181/14 Hz, PAL 312 × 71 at 4433618/4 Hz. There is **no
  `presync`**: unlike the C64 and the PET, a VIC-20 program keeps the
  KERNAL's IRQ alive — the jiffy clock, the keyboard scan and the cursor
  all keep running under a program that calls `waitFrame()`.
- `8bs run vic20` launches `xvic -model vic20ntsc` (or `-model vic20pal`
  with `--pal`) `-memory <ram> -controlport1device <n> -autostartprgmode 1`; `--screenshot`
  goes through `-limitcycles`/`-exitscreenshot` at the region's real clock
  (`VICE_CLOCK_HZ.vic20`, 1022727/1108405) with a default of 14 000 000
  cycles — nearly three times the C64's, observed and not explained.
- `packages/studio/src/main.8bs` starts Studio's basic tier when
  `#system() == System.VIC20` (character editing, rudimentary
  playback once sound exists); every Studio string is kept under 22
  columns for this machine.
- No hazard entry: no primary source read here documents a VIC-20 write
  that damages hardware.

There is no sound, no input (keyboard, joystick, paddles or the port's
1351), no custom character set, no multicolour, no 8×16 mode, no
screen-geometry control, no cartridge output, no `.d64`/`.tap` output and
no runtime RAM detection — for the VIC-20 or, mostly, for any machine. The
rules below are what to hold that work to when it comes.

## Facts verified here

Cite these freely; each was read in the source named, or seen on screen
under xvic (VICE 3.10, Homebrew) from a probe built with the installed
`mos-vic20-clang` and read through `-exitscreenshot`. VICE *source* facts
were read in the project's trunk on SourceForge (`vice/src/vic20/`,
`vice/src/joyport/`), which is a newer revision than the installed binary.

| Fact | Where |
| ---- | ----- |
| The SDK's link script accepts `__memory_expansion` 0, 3, 8, 16, 24 only (`ASSERT`), defaults to 24, and lays the program out as: 0 → `$1001`, length `$DFF` (to `$1DFF`, 3583 bytes); 3 → `$0401`, length `$19FF` (to `$1DFF`, 6655); 8/16/24 → `$1201`, length `N×1024 + $DFF` (to `$3FFF`, `$5FFF`, `$7FFF`: 11775, 19967, 28159). Zero page `$00`–`$8F` is BASIC's and the imaginary registers start at `$00` (`__basic_zp_start = 0`). `__stack = 0x8000` is written there but is not what runs (next row). | `$LLVM_MOS_HOME/mos-platform/vic20/lib/link.ld`, `commodore/lib/commodore.ld` |
| The soft stack is set at run time from the KERNAL, not from the link script: vic20's crt0 links `init-stack-memtop` (`sec / jsr MEMTOP / stx __rc0 / sty __rc1`), so the stack top is MEMSIZ — `$1E00` unexpanded, `$4000` with 8K, seen in `$00/$01` at `main()`. (The C128's crt0 uses the static `__stack` instead.) | `vic20/lib/libcrt0.a` → `init-stack-memtop.S.obj`, `llvm-objdump`; probe screenshots |
| A plain SDK build prints PETSCII 14 before `main()`: the `.prg` contains `a9 0e 20 d2 ff` (`lda #$0e / jsr $FFD2`), and the probe's text came up in lower case with `$9005 = $F2`. `commodoreCharsetGuard()` in `packages/backend-6502` is what keeps that out of an 8bitscript build. | `xxd` of the probe `.prg`; probe screenshot |
| Boot state per `-memory` (NTSC, `-model vic20ntsc`): `$9000/$9001 = $05/$19` (PAL: `$0C/$26`); `$9002 = $96` on `none` and `3k` (22 columns, screen address bit 9 set) and `$16` on `8k`/`24k`; `$9005` = `$F2`/`$C2` (would be `$F0`/`$C0` in upper case); `$9003 = $AE`/`$2E` (23 rows, bit 0 clear = 8×8); `$900E = $00`; `$900F = $1B` (white background, cyan border, normal video); BASIC start `$2B/$2C` = `$1001` / `$0401` (3k) / `$1201`; MEMSIZ `$37/$38` = `$1E00` / `$1E00` / `$4000` / `$8000`. So screen/colour is `$1E00`/`$9600` on none and 3k, `$1000`/`$9400` from 8K up — the package's geometry files. | probe screenshots `vic-none/3k/8k/24k/pal.png` |
| VIA1 (`$9110`) port A at boot `$7E`, DDRA `$80`; VIA2 (`$9120`) port B `$F7`, DDRB `$FF` (all eight keyboard columns are outputs), DDRA `$00` (rows inputs). VIA2 Timer 1 latch `$4289` = 17033 cycles with ACR `$40` and IER `$C0` (NTSC KERNAL; the PAL KERNAL's value was not measured): the KERNAL IRQ is a free-running ~60.04 Hz timer, **not** locked to the 261 × 65 = 16965-cycle NTSC frame. | probe screenshot `vic2-none.png` |
| `$9003` bit 0 selects 16-line character cells: VICE sets `char_height` 16 and the chargen fetch indexes `b * char_height`, so with the ROM charset each screen code shows two ROM glyphs stacked. Seen on screen. | `vic-mem.c` (`new_char_height = (value & 0x1) ? 16 : 8`), `vic-cycle.c` `VIC_FETCH_CHARGEN`; `vic-tall.png` |
| The VIC has a 14-bit address space and its A13 is inverted against the CPU's A15: `msb = ~((addr & 0x2000) << 2) & 0x8000`. VIC addresses `$2000`–`$3FFF` are CPU `$0000`–`$1FFF`; `$0000`–`$1FFF` are CPU `$8000`–`$9FFF`. Screen fetch address = `$9005` bits 4–7 `<< 10` + `$9002` bit 7 `<< 9` + cell; character fetch = `$9005` bits 0–3 `<< 10` + code × height + line. The VIC reads RAM only at CPU `$0000`–`$03FF` and `$1000`–`$1FFF`, the character ROM at `$8000`–`$8FFF`, and colour from `$9400 + (addr & $3FF)`. | `vic-cycle.c` `vic_cycle_fix_addr`, `vic_cycle_do_fetch`, `VIC_FETCH_MATRIX` |
| Multicolour (colour-RAM bit 3 set): pixel pairs, 4 double-width pixels per row, `00` background, `01` border, `10` the cell's colour (low three bits), `11` auxiliary (`$900E` bits 4–7). Standard cells: bit set = the cell's colour, clear = background; `$900F` bit 3 clear inverts every non-multicolour cell. | `vic-draw.c` `init_drawing_tables`, `c[0..3]` in `draw_std_text` |
| Sound: four channels at `$900A`–`$900D`, bit 7 enable, bits 0–6 a 7-bit divisor `a = (~reg) & 127` (0 → 128), each stepping its 8-bit shift register every `a << 4`, `<< 3`, `<< 2`, `<< 1` cycles (bass, alto, soprano, noise); the three voices rotate-and-invert (a square wave), the fourth clocks a 16-bit LFSR with taps 3, 12, 14, 15. `$900E` bits 0–3 is the one volume. That is Φ2 / (256 · (255 − v)) for bass, /128, /64, /32 for noise — the 6561 datasheet's formulas. Nothing is readable back. | `vic20sound.c` `vic_sound_clock`, `vic_sound_store`; `6561.txt` (cbmeeks transcription, the FRAME_SYNC reference) |
| Joystick: VIA1 port A bit 2 up, 3 down, 4 left, 5 fire (bits 0/1/7 are the serial bus, 6 tape sense); **right is VIA2 port B bit 7**, a keyboard-column output line. Light pen is VIA1 CA1. The machine has one control port (`JOYPORT_1`, with pot and light-pen lines); paddles read through the VIC's `$9008`/`$9009`. | `vic20via1.c` (port A comment), `vic20via2.c` (`store_prb`: "port b bit 7 - joystick pin 4 (right)"), `vic20.c` joyport table, `_vic.h` `analog_x/y` |
| Keyboard: VIA2 port B selects columns (output), port A reads rows against the selected columns (`read_pra` masks with `oldpb`). | `vic20via2.c` |
| VICE timing: NTSC 65 cycles × 261 lines at 1022727 Hz (first line 32 cycles, last 33 — "32 + 260×65 + 33"); PAL 71 × 312 at 1108405 Hz. NTSC interlace (`$9000` bit 7) gives 263/262-line fields; PAL ignores the bit. | `vic20.h`, `vic-mem.c` `vic_read_rasterline`, `vic-cycle.c` |
| `xvic -model`: `vic20`/`vic20pal`/`pal` (PAL, KERNAL rev 7), `vic20ntsc`/`ntsc` (NTSC, rev 6), `vic21` (NTSC with blocks 1+2 — the "SuperVIC"), `vic1001` (Japanese ROMs). `-memory` takes `none/3k/8k/16k/24k/all`, block numbers `0/1/2/3/5` or addresses `04/20/40/60/a0`: 3k = block 0 (`$0400`–`$0FFF`), 8k = block 1 (`$2000`), 16k = 1+2, 24k = 1+2+3 (to `$7FFF`), all adds block 5 (`$A000`–`$BFFF`). | `vic20model.c`, `vic20-cmdline-options.c`, `vic20mem.c` (the block map) |
| xvic control-port devices include Joystick (1), Paddles (2), Mouse (1351) (3), Light Pen variants (11–16), Koala Pad (10); `-fs8 <dir>` mounts a host directory as device 8, `-8 <image>` a disk image, `-autostartprgmode 1` injects a `.prg`; cartridge ROMs: `-cart2/-cart4/-cart6` (4/8/16K at `$2000/$4000/$6000`), `-cartA` (`$A000`), `-cartB` (`$B000`), `-cartgeneric`, `-cartcrt`, `-cartmega`, `-cartfe` (Final Expansion), `-ultimem`, `-cartfp` (Vic Flash Plugin), `-cartbb`, `-cartse` (Super Expander). The 1351 driver says it works on xvic's native port. | `xvic -help`, `mouse_1351.c` |
| The SDK has one VIC-20 driver, `mos-vic20-clang`, and it produces a `.prg` with a BASIC `SYS` line (`basic-header.o`); there is no cartridge link script for the VIC-20. | `ls $LLVM_MOS_HOME/bin`, `vic20/lib/`, `commodore.ld` |
| `vic20.h` (the SDK) names the chips: VIC at `$9000` (`struct __vic`: `leftborder`, `upperborder`, `charsperline`, `linecount`, `rasterline`, `addr`, light-pen `strobe_x/y`, `analog_x/y`, `voice1..3`, `noise`, `volume_color`, `bg_border_color`), VIA1 `$9110`, VIA2 `$9120`, `COLOR_RAM` `$9600`; its `COLOR_*` table marks 8–15 "only the background and multi-color characters can have these colors". | `vic20/include/vic20.h`, `_vic.h`, `_6522.h` |

## From the sources, not verified here

Leads to confirm the first time code depends on them. The 6561 datasheet
transcription FRAME_SYNC already cites (`cbmeeks/VIC-20/6561.txt`) and
the *VIC-20 Programmer's Reference Guide* are the primary references;
VICE's `vic20mem.c` for the block map.

**Memory map.** `$0000`–`$03FF` RAM (zero page, stack, KERNAL/BASIC
workspace; `$0200` the input buffer, `$0314`/`$0316`/`$0318` the
IRQ/BRK/NMI vectors); `$0400`–`$0FFF` the 3K expansion (block 0 — empty on
an unexpanded machine); `$1000`–`$1FFF` the internal 4K (screen at `$1E00`
or `$1000`, BASIC/program from `$1001` or `$1201`); `$2000`–`$7FFF` blocks
1–3 (8K each, expansion RAM or cartridge ROM); `$8000`–`$8FFF` character
ROM (upper-case/graphics at `$8000`, reversed at `$8400`, lower-case at
`$8800`, reversed at `$8C00`); `$9000`–`$900F` the VIC (mirrored through
`$90FF` — *to verify*); `$9110`/`$9120` the VIAs; `$9400`–`$97FF` colour
RAM (1K of 4-bit nybbles, `$9400` used with expansion, `$9600` without);
`$9800`–`$9BFF` I/O2 and `$9C00`–`$9FFF` I/O3 (expansion; VICE's `-io2ram`/
`-io3ram`); `$A000`–`$BFFF` block 5 (autostart cartridge — a ROM here with
`A0CBM` at `$A004` boots instead of BASIC); `$C000` BASIC ROM; `$E000`
KERNAL. Unpopulated blocks read as open bus.

**Why the screen moves.** BASIC needs one contiguous run of RAM. With no
expansion or 3K, the KERNAL keeps the screen at `$1E00` and BASIC from
`$1001` (`$0401` with 3K, since block 0 joins the internal RAM). With 8K or
more the expansion starts at `$2000`, so the KERNAL moves the screen to
`$1000` and BASIC to `$1201`, and the colour RAM follows (`$9002` bit 7,
which is both the screen's address bit 9 and the colour RAM half). The
package's geometry files encode exactly this; the rule that a program
must never probe it at run time is in "Rules" below.

**VIC registers** (PRG, 6561.txt): `$9000` bits 0–6 horizontal origin
(in 4-pixel units), bit 7 interlace (NTSC only); `$9001` vertical origin
(2-line units); `$9002` bits 0–6 columns, bit 7 screen A9; `$9003` bit 0
8×16, bits 1–6 rows, bit 7 raster bit 0; `$9004` raster bits 8–1; `$9005`
memory pointer; `$9006`/`$9007` light pen; `$9008`/`$9009` paddles;
`$900A`–`$900D` sound; `$900E` volume + auxiliary; `$900F` colour. Columns
and rows are programmable and the origin can be moved into the border;
how far the picture can grow before it leaves the visible area differs by
region and by VICE's `-VICborders` mode — *to verify* (the 6561.txt table
and common practice put the usable maximum around 27–28 columns on NTSC
and 31 on PAL, and the columns register's own maximum is what VICE clamps
to `max_text_cols`).

**The `$9005` table.** Bits 4–7 (screen): `$F` → `$1C00` + A9 (`$1E00`
with `$9002` bit 7), `$C` → `$1000`, `$D` → `$1400`, `$E` → `$1800`; `8`–
`B` → `$0000`–`$0C00`; `0`–`7` → `$8000`–`$9C00` (ROM — never a screen).
Bits 0–3 (characters, 1K steps): `0` upper-case ROM `$8000`, `1` its
reverse, `2` lower-case ROM `$8800`, `3` its reverse, `4`–`7` the I/O and
colour RAM at `$9000`–`$9C00` (garbage), `8`–`B` RAM `$0000`–`$0C00`, `C`–
`F` RAM `$1000`–`$1C00`. So a **RAM character set lives in `$1000`–`$1FFF`**
— the same 4K the screen and the program occupy — or in the 1K at
`$0000` that the KERNAL is using; the classic layout puts 64 custom
characters at `$1C00` under the screen at `$1E00`, which costs the
unexpanded program the top 512 bytes of its 3583. Expansion RAM is
invisible to the VIC — **including the 3K block at `$0400`–`$0FFF`**,
which sits on the expansion bus like the 8K blocks (VICE fetches from
`$0000`–`$03FF`, `$1000`–`$1FFF`, the character ROM and colour RAM, and
treats `$0400`–`$0FFF` as unconnected unless the VFLI hardware hack is
on): no charset, no screen there, ever. The 3K profile buys program
space, not picture space.

**Colour.** Sixteen colours, fixed: 0 black, 1 white, 2 red, 3 cyan, 4
purple, 5 green, 6 blue, 7 yellow, 8 orange, 9 light orange, 10 pink, 11
light cyan, 12 light purple, 13 light green, 14 light blue, 15 light
yellow. A border is 0–7; a character's colour is 0–7 (colour RAM bits 0–2,
bit 3 = multicolour for that cell); background and auxiliary are 0–15. The
PRG's `POKE 36879` values are `background × 16 + 8 + border`.

**Interrupts and timing.** The VIC has no interrupt output at all: no
raster interrupt, no vertical-blank flag, only the readable line counter.
The IRQ line is the VIAs' (the KERNAL's is VIA2 T1, verified above); NMI
is VIA1 (RESTORE). `$9004` moves every second line and is the only way a
program can find the frame — which is what `FRAME_SYNC.vic20` does.
Cycle stealing: the VIC never halts the CPU; the CPU has every cycle of
every line (the VIC fetches on the other clock phase) — *to verify*.

**Character ROM.** 256 glyphs per 4K set, 8 bytes each: `$00`–`$3F` `@A–Z[£]↑←`
space, punctuation, digits; `$40`–`$7F` graphics (lines, corners, quarter
blocks); `$80`–`$FF` the same reversed (a real ROM copy, unlike the PET's
hardware inversion). The lower-case set swaps `$40`–`$5F` for lower case
and keeps most graphics. The PETSCII quarter blocks give a 2×2 pseudo-pixel
grid per cell (44×46 over the screen); with a RAM charset a cell is 8×8
or 8×16 pixels of the program's own choosing.

**Sound ranges.** With the divisors above at NTSC's 1022727 Hz: bass
≈ 31–4000 Hz, alto ≈ 63–8000, soprano ≈ 125–16000; the three voices'
ranges overlap by an octave each. There are no envelopes, no filter, no
sample playback (a volume-register trick is possible — *to verify*), no
frequency finer than 7 bits, and the noise source is not readable: the
machine has **no hardware entropy** worth the name (VIA timers and the
raster line are the fallback).

**Storage.** `.prg` through the KERNAL LOAD (IEC serial: 1540/1541 disk
drives, device 8+; Datasette device 1 on its own port); cartridges in
block 5 (8K autostart) or blocks 1–3 (needs a loader or `SYS`); modern
flash cartridges (Final Expansion, UltiMem, Vic Flash Plugin, Mega-Cart)
bank RAM/ROM into the blocks through their own registers in I/O2/I/O3.

**The 1351 on the VIC-20.** The port has the same nine pins as the C64's,
the pot lines go to the VIC's paddle registers, and VICE's 1351 model
declares itself usable on xvic — so a 1351 in proportional mode should
work with the same reading discipline as the C64's (`$9008`/`$9009` in
place of the SID's `$D419`/`$D41A`). No hardware or period software was
checked — *to verify*.

## Misreadings a C64 programmer brings here

There were no research notes behind this file — it was written from the
sources in the table above — but the C64 file's readers arrive with C64
facts, and these are the ones that are wrong on this machine:

- **"The screen is at `$1E00`"** without qualification. Only unexpanded and
  with 3K; `$1000` from 8K up, and colour RAM moves with it. The package's
  geometry twins exist because this changed a real program.
- **"Custom characters go in expansion RAM"** or **"put the charset at
  `$2000`"**. The VIC cannot read `$2000`–`$7FFF`, and it cannot read the
  3K block at `$0400` either. A RAM charset lives in the internal 4K at
  `$1000`, where the program is.
- **"Sixteen colours."** Sixteen for background and auxiliary; eight for a
  border or a character. The C64's `Color` table is the wrong shape here.
- **"Joystick on one VIA"**: four directions and fire are VIA1 port A,
  *right* is VIA2 port B bit 7 — a keyboard-column output the KERNAL's IRQ
  is driving every jiffy.
- **"The jiffy IRQ is the frame."** 17033 cycles (the NTSC KERNAL's;
  PAL not measured) against a 16965-cycle NTSC frame: it drifts a frame
  every ~4 seconds. Sync to `$9004`, never to the KERNAL's counter.
- **"3583 bytes free"** is BASIC's figure and the unexpanded SDK region
  exactly (`$1001`–`$1DFF`); "5K" is the RAM total. Neither is available
  for both code and a charset at once.
- **"1 MHz."** 1.023 MHz NTSC, 1.108 MHz PAL — the PAL VIC-20 is the one
  Commodore machine faster in PAL than NTSC, and every sound and timing
  figure differs by 8%.

## Rules for this target

### RAM is hardware, and it moves the screen

- The `ram` option is the whole set: five values, named as the community
  and `xvic -memory` name them. A value fixes the load address and region
  (link script), the screen and colour base and the `$9005` value (the
  geometry file's tag twin), and the emulator flag. All three come from
  one catalog entry; a program never probes `$9002` or `$37/$38` at run
  time to find its screen. A build for one RAM on a machine of another
  draws nowhere (`geometry.8bs` documents the exact failure).
- The 8k, 16k and 24k values share the tag `expanded`, because a tag
  names exactly what a file differs on — whether there is 8K or more —
  and one `geometry.vic20.expanded.8bs` serves all three. New per-value
  facts go the same way: a tag's version of one small file, read through
  a namespace const, never a copy of a surface — or, for a number, a
  `facts` entry on the value.
- Block 5 (`$A000`) and `all` are not `ram` values: a program there is a
  cartridge, which the SDK has no link script for. If cartridge output
  arrives it is a new option (media), not a RAM size.
- The VIC's data — screen, colour, a RAM charset — lives only where the
  VIC can see it: the internal `$0000`–`$03FF` and `$1000`–`$1FFF`, and
  the ROM; not the 3K block, not the 8K blocks. The linker owns `$1001`
  (or `$0401`, or `$1201`) upward and nothing checks for an overlap, so a RAM charset
  is a *reservation* the package must make (shrink the region, or place it
  at `$1C00`–`$1DFF` under the unexpanded screen and give up 512 bytes),
  never a program's free choice of address.

### The picture is one register set, and the colours are asymmetric

- `$900F` is border (3 bits), inversion, and background (4 bits) in one
  byte; `$900E` is volume (4 bits) and auxiliary colour (4 bits) in one
  byte. Read, mask, write — a sound API and a colour API share a register
  and must not store literals over each other.
- Keep the three colour widths distinct in any API: `BorderColor` (8),
  `TextColor` (8, the colour-RAM nybble's low bits), `BackgroundColor`
  (16). A portable colour name that is not in the first eight (orange,
  the light shades) exists here only as a background or auxiliary colour;
  a portable capability must say so rather than clamp silently.
- Colour RAM bit 3 is the per-cell multicolour switch, and `text.putColor`
  masks it off on purpose. A multicolour API owns that bit per cell and
  the auxiliary colour globally; mixing the two per cell is the hardware's
  one gift here (4 colours in a 4×8 cell), and the double-width pixels are
  the price.
- 8×16 cells (`$9003` bit 0) halve the row count for the same pixel height
  and double every character's data; a "tall" mode is a whole-screen mode
  change (rows, charset layout, `CELL_COUNT`), never a per-row option.
- Columns, rows and origin are programmable, and a bigger picture is a
  real technique here (more cells, a window into the border), but it is
  region-dependent and the visible limit is unverified. Any geometry
  change is a `Video`-level decision with `CELL_COUNT` following it, not a
  register a program pokes.
- Writes to screen and colour RAM are visible immediately and never cause
  snow; there is no vertical-blank window to wait for. The only reason to
  sync is tearing, and `waitFrame()` already gives that edge.

### No sprites, no bitmap: everything is characters

- There are no hardware sprites and no bitmap mode. A moving object is a
  RAM character set redrawn per frame (software sprites), and a "bitmap"
  is the whole charset used as pixels: 256 × 8 bytes covers 16 × 16 cells,
  i.e. 128×128 pixels of the 176×184 screen (more with 8×16 cells, which
  give 256 × 16 = 4K — the entire internal RAM). Budget in cells, not
  frames: at ~1 MHz a full 506-cell rewrite is a good fraction of a frame.
- Software collision is the only collision. Keep it in the portable layer;
  nothing here helps.

### Sound is three squares and a noise behind one volume

- Four channels, one 7-bit divisor and an enable bit each, one 4-bit
  volume, nothing readable. A note-level API maps to three voices whose
  ranges overlap by one octave, with no envelope — volume is global, so
  "fading one voice" is not a thing this chip does. Frequency resolution
  is coarse (7 bits per octave-range), so a note table is per region
  (the PAL clock is 8% faster) and rounds; document the error.
- Hardware entropy: none. The deterministic PRNG stays deterministic; the
  raster line or a VIA timer is the only seed source, and it goes behind
  the explicitly optional import the root file asks for.

### Input shares chips with the KERNAL

- The KERNAL IRQ is alive in every VIC-20 build (no `presync`), and its
  keyboard scan drives VIA2 port B every jiffy. A program that reads the
  keyboard itself must select columns and read rows under `sei`, or read
  the KERNAL's own buffer; a program that reads joystick RIGHT must flip
  VIA2 DDRB bit 7 to input around the read and put it back, again under
  `sei`, because the KERNAL scan will write it. The C64's "port 2 is the
  player's port" has no counterpart: there is one port.
- Fire and the four directions are one VIA1 read; right is a separate
  VIA2 read with a direction-register dance. A joystick snapshot is two
  reads and a restore, once a frame, right after `waitFrame()`, and every
  question is answered from the snapshot.
- Paddles and the 1351's proportional mode read through `$9008`/`$9009`;
  the light pen through VIA1 CA1 and `$9006`/`$9007`. Treat all three as
  optional hardware behind a capability, never assumed from
  `machine == vic20`.

### The frame is a counter to poll

- `$9004` is the frame: half-line resolution, no interrupt, and the KERNAL
  timer is not it. A raster effect (colour split, border tricks) is a
  polling loop, and it competes with the KERNAL's IRQ for cycles; either
  `sei` around it or accept jitter.
- The two regions differ in line count, cycles per line *and* CPU clock;
  `FRAME_SYNC.vic20` carries both and probes at run time. A sound table or
  a timing constant that assumes one region is wrong by 8% on the other.

### Models are not profiles

- One `.prg` runs on every VIC-20 board and every `xvic -model`; the
  differences (PAL/NTSC VIC, KERNAL revision, the Japanese character ROM)
  are runtime facts. `--pal` is the emulator's region, not a build option.
  The `vic21` model is a 16K NTSC machine and is what `--hardware ram=16k`
  on NTSC already builds for.

## Seeing the screen without a human at xvic

`8bs run vic20 --screenshot <file.png>` builds and captures through VICE's
`-limitcycles`/`-exitscreenshot` (see
[`docs/setup/verify.md`](../../docs/setup/verify.md#screenshots)); add
`--profile 8k` and `--pal` as needed. To look at another configuration,
launch `xvic -model vic20pal -memory 24k -autostartprgmode 1 -limitcycles
9000000 -exitscreenshot out.png -autostart dist/main-vic20-24k-pal.prg`
yourself — that is how the boot-state rows above were read, from a C probe
that prints the registers as hex into screen RAM at whatever base `$9005`
and `$9002` named.

## Where things live

```
packages/vic20/src/index.8bs            target package: vicColor ($900F), memoryPointer ($9005)
packages/vic20/src/geometry.8bs         Video.SCREEN/COLOR/MEMORY_POINTER_UPPERCASE/COLUMNS/ROWS/CELL_COUNT for unexpanded and 3k
packages/vic20/src/geometry.vic20.expanded.8bs    the `expanded` tag's version ($1000/$9400/$C0), for 8k, 16k and 24k alike
packages/vic20/package.json             "8bitscript".hardware: ram (defsym, -memory, the expanded tag, memory.ram), port1; presets
packages/vic20/src/screen.8bs           @8bitscript/vic20/screen: one packed register, BorderColor (8) and BackgroundColor (16)
packages/vic20/src/text.8bs             @8bitscript/vic20/text: ASCII → screen code, colour nybble masked to 3 bits, 22 × 23
packages/backend-6502/src/index.mjs     STOCK_DEFSYM.vic20 (unexpanded when nothing is fitted), FRAME_SYNC.vic20 ($9004 poll, no presync), commodoreCharsetGuard()
packages/cli/src/run.mjs                VICE_MODEL_ARGS.vic20 (-model vic20ntsc/vic20pal); the catalog's -memory and port flags appended
packages/cli/src/screenshot.mjs         VICE_CLOCK_HZ.vic20, the 14 000 000-cycle default
packages/compiler/test/vic20-profiles.test.mjs   every ram value draws at its geometry; 8k/16k/24k share the expanded tag and one file
packages/studio/src/main.8bs            Studio's basic tier when #system() == System.VIC20
docs/setup/vice.md                      installing xvic; the ram option's table
docs/roadmap.md                         Phase 1: the original hardware target
$LLVM_MOS_HOME/mos-platform/vic20/      link.ld (__memory_expansion, the three regions), vic20.h/_vic.h/_6522.h, libcrt0.a (init-stack-memtop)
vice/src/vic20/ (SourceForge trunk)     vic-cycle.c (the 14-bit address fix-up), vic-draw.c (multicolour order), vic20sound.c, vic20via1.c/vic20via2.c, vic20model.c, vic20-cmdline-options.c
```
