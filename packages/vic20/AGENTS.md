# Writing Commodore VIC-20 support for 8BitScript

> **This release builds this machine.** `8bs build` and `8bs run` produce
> a program while `vic20` is listed in `RELEASE_MACHINES`
> (`packages/compiler/src/resolver`). The package stays the guide for
> extending it; other roadmap ids are out of `RELEASE_MACHINES` until the
> narrow release widens again (see root [`AGENTS.md`](../../AGENTS.md)).

This file is for anyone — human or agent — touching `packages/vic20`,
this package's hardware catalog (`package.json`, `"8bitscript".hardware`:
`ram`, `port1`), `packages/compiler/src/mos`'s `FRAME_SYNC.vic20`,
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
> screen, color RAM and program all move when RAM is added. Sixteen colors
> exist but only eight of them can be a border or a character; sound is
> three square waves and a noise source behind one volume; there are no
> sprites, no bitmap, no raster interrupt and no vertical-blank flag. Model
> it as a small, relocating text grid with a raster counter to poll — never
> as "a C64 with fewer columns".**

The machine's variety is in *RAM expansion*, and that one axis moves the
program's load address, the screen matrix, the color RAM and the top of
memory together: the `ram` option's five values are the five
configurations VICE's `-memory` flag accepts (`none/3k/8k/16k/24k`), not a choice
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
  rewrite the register. `BorderColor` has the first eight colors and
  `BackgroundColor` all sixteen — two namespaces because the chip draws that
  line, not a preference. `screen.blank()` writes the space screen code to
  `Video.CELL_COUNT` (506) cells at `Video.SCREEN`.
- `text.putChar(cell, code)` takes ASCII, converts to a screen code
  (`A`–`Z` → 1–26, 32–63 unchanged), writes `Video.SCREEN + cell`, and
  before every run of text stores `Video.MEMORY_POINTER_UPPERCASE` in
  `$9005` — the value that names both this hardware's screen base and the
  upper-case ROM. `putColor`/`place` write the low three bits of the color
  to `Video.COLOR + cell` (bit 3 would make the cell multicolor).
  `text.COLUMNS` is 22 and `text.CELL_COUNT` 506 whatever RAM is fitted. Writes
  happen at any time; there is no vertical-blank queue and none is needed.
- **Hardware** (the catalog in `package.json`): `ram` — `none` (default),
  `3k`, `8k`, `16k`, `24k` — exactly the five values `xvic
  -memory` takes (`none/3k/8k/16k/24k`); presets `unexpanded`, `3k`, `8k`,
  `16k`, `24k` keep the old `--profile` names. A value sets the link (its
  `build.defsym`, `__memory_expansion=N`), the geometry file the package
  reads through its tag (`geometry.8bs` for none and 3k — screen `$1E00`,
  color `$9600`, `$9005 = $F0`; `geometry.vic20.expanded.8bs` for 8k, 16k
  and 24k, which all carry the tag `expanded` — screen `$1000`, color
  `$9400`, `$9005 = $C0`; `packages/compiler/test/vic20-profiles.test.mjs`
  holds the tags and the two files to this), the `-memory` flag `8bs run
  vic20` passes so the emulated RAM matches the link, and a `memory.ram`
  fact. A non-default value is in the output name
  (`main-vic20-8k-ntsc.prg`). `port1` — `joystick` (default), `none`,
  `paddles` (`-controlport1device`). There is no `mouse1351` and no
  `drive`: `xvic` accepts both, but this repository has no 1351 driver for
  the VIC-20 (the 1351 here is *to verify* on hardware, below) and nothing
  anywhere saves yet, so each set a fact — `input.mouse`, `storage.kib` —
  that no code could act on. They return with their drivers.
- `FRAME_SYNC.vic20` (`packages/compiler/src/mos`) is a *level* driver on the
  VIC's raster counter: `$9004` holds bits 8–1 of the line and changes every
  second line, the top half of the frame is `$9004 < 64`, and `$9004 >= 140`
  is a line only PAL has (NTSC tops out around 130). NTSC is 261 × 65
  cycles at 14318181/14 Hz, PAL 312 × 71 at 4433618/4 Hz. **A program
  that calls `waitFrame()` runs with interrupts off from start-up**, as on
  the C64 and the PET: `mos/index.ts` emits an `SEI` ahead of the global
  initializers and `waitframe.ts`'s `rasterSetup()` another before its
  region probe (the VIC-20 is not a `keepsInterrupts` machine), so the
  jiffy clock, the KERNAL's keyboard scan and the cursor stop. (This file
  said the opposite until 2026-09-29; the `SEI`s are in every listing.) A
  program that never calls `waitFrame()` keeps the KERNAL's IRQ.
  `FRAME_SYNC.vic20.frameHook` is `vic20RasterFrame`: the routine every
  `waitFrame()` shares `JSR`s it after each frame edge — see "Raster
  splits" below.
- **Raster splits** (`src/rasterline.8bs`, behind `@8bitscript/raster`):
  `Slot.BORDER`, `Slot.BACKGROUND` and `Slot.CHARSET` at any picture line,
  both regions,
  every line landed whole and still from frame to frame, a list built once
  and `enable()`d kept every frame, `setValue` live without a commit.
  `#fact(video.raster)` is true and so is `raster.CHARSET` (0 the
  upper-case/graphics ROM set, 1 the mixed-case one — the PET's meaning).
  `Slot.SCROLL_X` is refused and `raster.FINE_SCROLL` is false. The VIC raises no interrupt, so
  `waitFrame()` applies the list — the section "Raster splits" below is
  the mechanism, the measurements and what they cost.
  **On the wasm build** (`8bs run vic20 --web`) the hook's machine code is never
  lowered: `src/rasterline.vic20.web.8bs` writes the page's picture-line list
  instead, the same portable surface with each entry applied at its line
  exactly. The page reads the border and background from `$900F`
  (and the live character set from `$9005`) as the chip does. `8bs conform vic20 --program bands` holds the
  band lines to xvic's (every band starts on the same line); what it does not
  model is in `emulator.wasm.limits` in `package.json`, and
  `packages/compiler/test/vic20-web-twin.test.mjs` holds the twin to the native
  file's names.
- `8bs run vic20` launches `xvic -model vic20ntsc` (or `-model vic20pal`
  with `--pal`) `-memory <ram> -controlport1device <n> -autostartprgmode 1`; `--screenshot`
  goes through `-limitcycles`/`-exitscreenshot` at the region's real clock
  (`VICE_CLOCK_HZ.vic20`, 1022727/1108405) with a default of 14 000 000
  cycles — nearly three times the C64's, observed and not explained.
- `packages/studio/src/main.8bs` reads Studio's tier from this build's
  facts, and the `ram` option decides it: unexpanded (3583 bytes) and 3K
  (6655) are under Studio's 8192-byte editing budget and get the
  read-only **viewer** tier; 8K, 16K and 24K get the **basic** tier —
  characters and music edit, sprites view, since `video.sprites` is 0.
  The VIC-20 is the one machine where fitting hardware changes what
  Studio is. Every Studio string is kept under 22 columns for this
  machine.
- No hazard entry: no primary source read here documents a VIC-20 write
  that damages hardware.

There is no sound, no input (keyboard, joystick, paddles or the port's
1351), no custom character set, no multicolor, no 8×16 mode, no
screen-geometry control, no cartridge output, no `.d64`/`.tap` output and
no runtime RAM detection — for the VIC-20 or, mostly, for any machine. The
rules below are what to hold that work to when it comes.

## Facts verified here

Cite these freely; each was read in the source named, or seen on screen
under xvic (VICE 3.10, Homebrew) from a probe (pre-0.2.0)
and read through `-exitscreenshot`. VICE *source* facts
were read in the project's trunk on SourceForge (`vice/src/vic20/`,
`vice/src/joyport/`), which is a newer revision than the installed binary.

| Fact | Where |
| ---- | ----- |
| Load address and usable RAM follow the expansion fitted: 0 → `$1001`, length `$DFF` (to `$1DFF`, 3583 bytes); 3 → `$0401`, length `$19FF` (to `$1DFF`, 6655); 8/16/24 → `$1201`, length `N×1024 + $DFF` (to `$3FFF`, `$5FFF`, `$7FFF`: 11775, 19967, 28159). Zero page `$00`–`$8F` is BASIC's. A static `__stack = 0x8000` in an old link map is not what runs (next row). | VIC-20 link map (measured pre-0.2.0) |
| The soft stack is set at run time from the KERNAL, not from the link script: start-up (pre-0.2.0) calls `init-stack-memtop` (`sec / jsr MEMTOP / stx __rc0 / sty __rc1`), so the stack top is MEMSIZ — `$1E00` unexpanded, `$4000` with 8K, seen in `$00/$01` at `main()`. (The C128 uses the static `__stack` instead.) | `init-stack-memtop` disassembly (pre-0.2.0); probe screenshots |
| A CHROUT of PETSCII 14 (`a9 0e 20 d2 ff` = `lda #$0e / jsr $FFD2`) would flip the machine to lower-case before `main` (`$9005 = $F2` on a probe that did). 8BitScript does not emit that. | `xxd` of a probe `.prg` (pre-0.2.0); probe screenshot |
| Boot state per `-memory` (NTSC, `-model vic20ntsc`): `$9000/$9001 = $05/$19` (PAL: `$0C/$26`); `$9002 = $96` on `none` and `3k` (22 columns, screen address bit 9 set) and `$16` on `8k`/`24k`; `$9005` = `$F2`/`$C2` (would be `$F0`/`$C0` in upper case); `$9003 = $AE`/`$2E` (23 rows, bit 0 clear = 8×8); `$900E = $00`; `$900F = $1B` (white background, cyan border, normal video); BASIC start `$2B/$2C` = `$1001` / `$0401` (3k) / `$1201`; MEMSIZ `$37/$38` = `$1E00` / `$1E00` / `$4000` / `$8000`. So screen/color is `$1E00`/`$9600` on none and 3k, `$1000`/`$9400` from 8K up — the package's geometry files. | probe screenshots `vic-none/3k/8k/24k/pal.png` |
| VIA1 (`$9110`) port A at boot `$7E`, DDRA `$80`; VIA2 (`$9120`) port B `$F7`, DDRB `$FF` (all eight keyboard columns are outputs), DDRA `$00` (rows inputs). VIA2 Timer 1 latch `$4289` = 17033 cycles with ACR `$40` and IER `$C0` (NTSC KERNAL; the PAL KERNAL's value was not measured): the KERNAL IRQ is a free-running ~60.04 Hz timer, **not** locked to the 261 × 65 = 16965-cycle NTSC frame. | probe screenshot `vic2-none.png` |
| `$9003` bit 0 selects 16-line character cells: VICE sets `char_height` 16 and the chargen fetch indexes `b * char_height`, so with the ROM charset each screen code shows two ROM glyphs stacked. Seen on screen. | `vic-mem.c` (`new_char_height = (value & 0x1) ? 16 : 8`), `vic-cycle.c` `VIC_FETCH_CHARGEN`; `vic-tall.png` |
| The VIC has a 14-bit address space and its A13 is inverted against the CPU's A15: `msb = ~((addr & 0x2000) << 2) & 0x8000`. VIC addresses `$2000`–`$3FFF` are CPU `$0000`–`$1FFF`; `$0000`–`$1FFF` are CPU `$8000`–`$9FFF`. Screen fetch address = `$9005` bits 4–7 `<< 10` + `$9002` bit 7 `<< 9` + cell; character fetch = `$9005` bits 0–3 `<< 10` + code × height + line. The VIC reads RAM only at CPU `$0000`–`$03FF` and `$1000`–`$1FFF`, the character ROM at `$8000`–`$8FFF`, and color from `$9400 + (addr & $3FF)`. | `vic-cycle.c` `vic_cycle_fix_addr`, `vic_cycle_do_fetch`, `VIC_FETCH_MATRIX` |
| Multicolor (color-RAM bit 3 set): pixel pairs, 4 double-width pixels per row, `00` background, `01` border, `10` the cell's color (low three bits), `11` auxiliary (`$900E` bits 4–7). Standard cells: bit set = the cell's color, clear = background; `$900F` bit 3 clear inverts every non-multicolor cell. | `vic-draw.c` `init_drawing_tables`, `c[0..3]` in `draw_std_text` |
| Sound: four channels at `$900A`–`$900D`, bit 7 enable, bits 0–6 a 7-bit divisor `a = (~reg) & 127` (0 → 128), each stepping its 8-bit shift register every `a << 4`, `<< 3`, `<< 2`, `<< 1` cycles (bass, alto, soprano, noise); the three voices rotate-and-invert (a square wave), the fourth clocks a 16-bit LFSR with taps 3, 12, 14, 15. `$900E` bits 0–3 is the one volume. That is Φ2 / (256 · (255 − v)) for bass, /128, /64, /32 for noise — the 6561 datasheet's formulas. Nothing is readable back. | `vic20sound.c` `vic_sound_clock`, `vic_sound_store`; `6561.txt` (cbmeeks transcription, the FRAME_SYNC reference) |
| Joystick: VIA1 port A bit 2 up, 3 down, 4 left, 5 fire (bits 0/1/7 are the serial bus, 6 tape sense); **right is VIA2 port B bit 7**, a keyboard-column output line. Light pen is VIA1 CA1. The machine has one control port (`JOYPORT_1`, with pot and light-pen lines); paddles read through the VIC's `$9008`/`$9009`. | `vic20via1.c` (port A comment), `vic20via2.c` (`store_prb`: "port b bit 7 - joystick pin 4 (right)"), `vic20.c` joyport table, `_vic.h` `analog_x/y` |
| Keyboard: VIA2 port B selects columns (output), port A reads rows against the selected columns (`read_pra` masks with `oldpb`). | `vic20via2.c` |
| VICE timing: NTSC 65 cycles × 261 lines at 1022727 Hz (first line 32 cycles, last 33 — "32 + 260×65 + 33"); PAL 71 × 312 at 1108405 Hz. NTSC interlace (`$9000` bit 7) gives 263/262-line fields; PAL ignores the bit. | `vic20.h`, `vic-mem.c` `vic_read_rasterline`, `vic-cycle.c` |
| `xvic -model`: `vic20`/`vic20pal`/`pal` (PAL, KERNAL rev 7), `vic20ntsc`/`ntsc` (NTSC, rev 6), `vic21` (NTSC with blocks 1+2 — the "SuperVIC"), `vic1001` (Japanese ROMs). `-memory` takes `none/3k/8k/16k/24k/all`, block numbers `0/1/2/3/5` or addresses `04/20/40/60/a0`: 3k = block 0 (`$0400`–`$0FFF`), 8k = block 1 (`$2000`), 16k = 1+2, 24k = 1+2+3 (to `$7FFF`), all adds block 5 (`$A000`–`$BFFF`). | `vic20model.c`, `vic20-cmdline-options.c`, `vic20mem.c` (the block map) |
| xvic control-port devices include Joystick (1), Paddles (2), Mouse (1351) (3), Light Pen variants (11–16), Koala Pad (10); `-fs8 <dir>` mounts a host directory as device 8, `-8 <image>` a disk image, `-autostartprgmode 1` injects a `.prg`; cartridge ROMs: `-cart2/-cart4/-cart6` (4/8/16K at `$2000/$4000/$6000`), `-cartA` (`$A000`), `-cartB` (`$B000`), `-cartgeneric`, `-cartcrt`, `-cartmega`, `-cartfe` (Final Expansion), `-ultimem`, `-cartfp` (Vic Flash Plugin), `-cartbb`, `-cartse` (Super Expander). The 1351 driver says it works on xvic's native port. | `xvic -help`, `mouse_1351.c` |
| A VIC-20 program is a `.prg` with a BASIC `SYS` line; there is no cartridge link for this target. The native backend refuses to build. | BASIC header; VICE autostart |
| VIC-20 headers name the chips: VIC at `$9000` (`struct __vic`: `leftborder`, `upperborder`, `charsperline`, `linecount`, `rasterline`, `addr`, light-pen `strobe_x/y`, `analog_x/y`, `voice1..3`, `noise`, `volume_color`, `bg_border_color`), VIA1 `$9110`, VIA2 `$9120`, `COLOR_RAM` `$9600`; its `COLOR_*` table marks 8–15 "only the background and multi-color characters can have these colors". | VIC-20 Programmer's Reference Guide; `_vic.h` / `_6522.h` |
| The catalog's stock fact sheet (`"8bitscript".hardware.facts`, read by `Video.*` and the rest of `@8bitscript/system`): grid 22×23 of 8×8, 16 colors, 2 per cell (its own foreground, the shared background), 256 RAM glyphs, 2×2 PETSCII blocks, no bitmap, one layer, coarse scroll only, no sprites; 4 voices (three tones and noise), one shared volume, no envelope, filter, samples or random source; keyboard, one joystick port, no pads; disk to save to; 3583 bytes on the unexpanded machine (the `ram` values change it), nothing banked. A mouse or paddles is a `port1` value's fact. | `src/geometry.8bs`; the sound and `link.ld` rows above; `6561.txt` (the sound channels) and the research notes below for the rest; `package.json` (read) |

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
`$90FF` — *to verify*); `$9110`/`$9120` the VIAs; `$9400`–`$97FF` color
RAM (1K of 4-bit nybbles, `$9400` used with expansion, `$9600` without);
`$9800`–`$9BFF` I/O2 and `$9C00`–`$9FFF` I/O3 (expansion; VICE's `-io2ram`/
`-io3ram`); `$A000`–`$BFFF` block 5 (autostart cartridge — a ROM here with
`A0CBM` at `$A004` boots instead of BASIC); `$C000` BASIC ROM; `$E000`
KERNAL. Unpopulated blocks read as open bus.

**Why the screen moves.** BASIC needs one contiguous run of RAM. With no
expansion or 3K, the KERNAL keeps the screen at `$1E00` and BASIC from
`$1001` (`$0401` with 3K, since block 0 joins the internal RAM). With 8K or
more the expansion starts at `$2000`, so the KERNAL moves the screen to
`$1000` and BASIC to `$1201`, and the color RAM follows (`$9002` bit 7,
which is both the screen's address bit 9 and the color RAM half). The
package's geometry files encode exactly this; the rule that a program
must never probe it at run time is in "Rules" below.

**VIC registers** (PRG, 6561.txt): `$9000` bits 0–6 horizontal origin
(in 4-pixel units), bit 7 interlace (NTSC only); `$9001` vertical origin
(2-line units); `$9002` bits 0–6 columns, bit 7 screen A9; `$9003` bit 0
8×16, bits 1–6 rows, bit 7 raster bit 0; `$9004` raster bits 8–1; `$9005`
memory pointer; `$9006`/`$9007` light pen; `$9008`/`$9009` paddles;
`$900A`–`$900D` sound; `$900E` volume + auxiliary; `$900F` color. Columns
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
color RAM at `$9000`–`$9C00` (garbage), `8`–`B` RAM `$0000`–`$0C00`, `C`–
`F` RAM `$1000`–`$1C00`. So a **RAM character set lives in `$1000`–`$1FFF`**
— the same 4K the screen and the program occupy — or in the 1K at
`$0000` that the KERNAL is using; the classic layout puts 64 custom
characters at `$1C00` under the screen at `$1E00`, which costs the
unexpanded program the top 512 bytes of its 3583. Expansion RAM is
invisible to the VIC — **including the 3K block at `$0400`–`$0FFF`**,
which sits on the expansion bus like the 8K blocks (VICE fetches from
`$0000`–`$03FF`, `$1000`–`$1FFF`, the character ROM and color RAM, and
treats `$0400`–`$0FFF` as unconnected unless the VFLI hardware hack is
on): no charset, no screen there, ever. The 3K profile buys program
space, not picture space.

**Color.** Sixteen colors, fixed: 0 black, 1 white, 2 red, 3 cyan, 4
purple, 5 green, 6 blue, 7 yellow, 8 orange, 9 light orange, 10 pink, 11
light cyan, 12 light purple, 13 light green, 14 light blue, 15 light
yellow. A border is 0–7; a character's color is 0–7 (color RAM bits 0–2,
bit 3 = multicolor for that cell); background and auxiliary are 0–15. The
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
  with 3K; `$1000` from 8K up, and color RAM moves with it. The package's
  geometry twins exist because this changed a real program.
- **"Custom characters go in expansion RAM"** or **"put the charset at
  `$2000`"**. The VIC cannot read `$2000`–`$7FFF`, and it cannot read the
  3K block at `$0400` either. A RAM charset lives in the internal 4K at
  `$1000`, where the program is.
- **"Sixteen colors."** Sixteen for background and auxiliary; eight for a
  border or a character. The C64's `Color` table is the wrong shape here.
- **"Joystick on one VIA"**: four directions and fire are VIA1 port A,
  *right* is VIA2 port B bit 7 — a keyboard-column output the KERNAL's IRQ
  is driving every jiffy.
- **"The jiffy IRQ is the frame."** 17033 cycles (the NTSC KERNAL's;
  PAL not measured) against a 16965-cycle NTSC frame: it drifts a frame
  every ~4 seconds. Sync to `$9004`, never to the KERNAL's counter.
- **"3583 bytes free"** is BASIC's figure and the unexpanded program region
  exactly (`$1001`–`$1DFF`); "5K" is the RAM total. Neither is available
  for both code and a charset at once.
- **"1 MHz."** 1.023 MHz NTSC, 1.108 MHz PAL — the PAL VIC-20 is the one
  Commodore machine faster in PAL than NTSC, and every sound and timing
  figure differs by 8%.

## Rules for this target

### RAM is hardware, and it moves the screen

- The `ram` option is the whole set: five values, named as the community
  and `xvic -memory` name them. A value fixes the load address and region
  (link script), the screen and color base and the `$9005` value (the
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
  cartridge, which this target has no link for. If cartridge output
  arrives it is a new option (media), not a RAM size.
- The VIC's data — screen, color, a RAM charset — lives only where the
  VIC can see it: the internal `$0000`–`$03FF` and `$1000`–`$1FFF`, and
  the ROM; not the 3K block, not the 8K blocks. The linker owns `$1001`
  (or `$0401`, or `$1201`) upward and nothing checks for an overlap, so a RAM charset
  is a *reservation* the package must make (shrink the region, or place it
  at `$1C00`–`$1DFF` under the unexpanded screen and give up 512 bytes),
  never a program's free choice of address. `@8bitscript/graphics` learned
  this the hard way: it took `$1400` as a free choice, which is inside the
  program on both memory maps, and every VIC-20 program carrying an object
  overwrote its own code and warm-started the KERNAL. It draws with the
  ROM's sixteen quadrant blocks now — no charset, so no reservation — and a
  future pixel-accurate one must make the reservation before it writes a byte.

### The picture is one register set, and the colors are asymmetric

- `$900F` is border (3 bits), inversion, and background (4 bits) in one
  byte; `$900E` is volume (4 bits) and auxiliary color (4 bits) in one
  byte. Read, mask, write — a sound API and a color API share a register
  and must not store literals over each other.
- Keep the three color widths distinct in any API: `BorderColor` (8),
  `TextColor` (8, the color-RAM nybble's low bits), `BackgroundColor`
  (16). A portable color name that is not in the first eight (orange,
  the light shades) exists here only as a background or auxiliary color;
  a portable capability must say so rather than clamp silently.
- Color RAM bit 3 is the per-cell multicolor switch, and `text.putColor`
  masks it off on purpose. A multicolor API owns that bit per cell and
  the auxiliary color globally; mixing the two per cell is the hardware's
  one gift here (4 colors in a 4×8 cell), and the double-width pixels are
  the price.
- 8×16 cells (`$9003` bit 0) halve the row count for the same pixel height
  and double every character's data; a "tall" mode is a whole-screen mode
  change (rows, charset layout, `CELL_COUNT`), never a per-row option.
- Columns, rows and origin are programmable, and a bigger picture is a
  real technique here (more cells, a window into the border), but it is
  region-dependent and the visible limit is unverified. Any geometry
  change is a `Video`-level decision with `CELL_COUNT` following it, not a
  register a program pokes.
- Writes to screen and color RAM are visible immediately and never cause
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

- The KERNAL IRQ is alive in a VIC-20 program that never calls
  `waitFrame()`, and its keyboard scan drives VIA2 port B every jiffy (a
  `waitFrame()` program has it off from start-up — above). A program
  that reads the keyboard itself must select columns and read rows under `sei`, or read
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
  timer is not it. A raster effect is a polling loop run from
  `waitFrame()`'s frame hook, with interrupts already off — never a loop
  a program writes itself, and never a delay counted from one sync at the
  top of the frame (both were tried; "Raster splits" says what went
  wrong).
- The two regions differ in line count, cycles per line *and* CPU clock;
  `FRAME_SYNC.vic20` carries both and probes at run time. A sound table or
  a timing constant that assumes one region is wrong by 8% on the other.

### Models are not profiles

- One `.prg` runs on every VIC-20 board and every `xvic -model`; the
  differences (PAL/NTSC VIC, KERNAL revision, the Japanese character ROM)
  are runtime facts. `--pal` is the emulator's region, not a build option.
  The `vic21` model is a 16K NTSC machine and is what `--hardware ram=16k`
  on NTSC already builds for.

## Graphics (`@8bitscript/graphics`)

A `.8bg` object is drawn as the ROM's quadrant-block characters, and the
picture is reduced to them while the program is built, not on the machine.
`packages/vic20/media/index.cjs` takes each animation frame and cuts it
onto a grid of pseudo-pixels two to a cell in each direction: one cell
across (or down) for a source of 8 pixels or fewer, two for anything
larger, scaled down to fit — the PET's reduction, which it reads the same
way. A pseudo-pixel is lit if any opaque dark pixel of the source falls in
it. The result is one screen code per cell per frame, `QUAD` in that file
(the sixteen patterns, read off this machine's own character ROM under
xvic, the same codes `packages/graphics/src/index.vic20.8bs` drew with
before). A picture with fewer than four ink pixels becomes the single glyph
`$51` instead, and either choice is reported as `8BS2111`.

`packages/graphics/src/index.vic20.8bs` is then only a drawing loop:

- **Where.** x and y are stage pixels and the object is at the cell they
  fall in (`x >> 3`, `y >> 3`), so the smallest move that shows is one cell.
- **Clipping.** Cells past column 21 or row 22 are not written. On 8K and up
  the screen ends at `$11F9` and the program starts at `$1201`: an object
  at the bottom-right corner, unclipped, reaches `$1210`, a store into the
  program, which is the same kind of bug as the RAM charset's. (The first
  bytes there are the BASIC stub, already run by then, so the test reads the
  right edge, where the wrap onto the next row shows, as well.)
- **Moving and hiding.** An object that moves, or is hidden, has the cells it
  was drawn in blanked (screen code 32, color RAM white) before every object
  on the screen is drawn again, later slots on top. It does not put back what
  was there: text printed where an object stands is gone once the object
  moves, and a program prints where objects are not. The color goes back to
  white (`INK`) because color RAM is the object's too: an unreset cell would
  show a character stored there with `text.putChar` — which writes no color —
  in the object's ink. Every update redraws every placed object, so one a
  program printed over comes back.
- **Frames.** An object with more than one frame steps every `every`
  updates, in the order its `animation` names the frames, and starts over
  after the last. The first 8 frames are kept; a longer animation is cut and
  says so. `setFrame` shows from the next `update()` and clamps (a frame
  past the last is the last) and starts the update count again; `animate`
  pauses or resumes the stepping object by object.
- **Color.** `color(slot, c)` sets the color RAM value the object's cells are
  drawn with, from the next `update()`. Color RAM bit 3 is the multicolor
  switch, so `c` is masked to three bits (8–15 wrap, as `text.putColor`
  does); an unmasked `color(slot, 9)` made the cells multicolor garbage
  until 2026-10-04.
- **Limits.** Eight objects (`MAX`, like the other targets), and 64 bytes of
  codes among all of them (`POOL`): sixteen frames of a 2×2 object, or any
  mix. The last byte is usable; an object that would pass it is not drawn,
  every call on it does nothing, and the objects that fit are not touched. A
  media module sees one sprite at a time, so the build cannot add them up:
  each sprite's `8BS2111` note says what it takes ("taking 12 of the 64 pool
  bytes every object shares"), and the sum is the program's to keep under 64.
  Both arrays are in the program image, so they count in `memory.program`,
  not in the variables.
- **Slots.** The compiler numbers sprites across the whole build, not per
  `.8bg` file. It used to start each file at 0, so `mark.8bg` and
  `player.8bg` in `examples/media-walk` shared slot 0 and the second
  placement moved the first.

Measured with `8bs build vic20 --size` on `packages/examples/media-walk`
(2026-10-04): 2515 bytes of program and 48 of variables, unexpanded and 8K
alike. It was 2493 and 48 before `color` was masked and blanking reset color
RAM (22 bytes for the two), 2455 and 49 before the portable contract, and
2383 and 41 before that, when it held a 256-byte table and a runtime
reduction of every object. The all-operations probe in
`packages/graphics/test/vic20-ops.test.mjs` is 1710 bytes of program and
44 of variables, on both layouts, and that test fails if it passes 1800. A
draw's cost in cycles is not measured: update is one pass over the placed
objects, a few dozen stores each.

Verified two ways. Under xvic (`test/graphics.test.mjs` and
`test/graphics-ops.test.mjs`, NTSC, unexpanded and 8K): an 8×8 object takes
one cell and leaves its neighbours' text intact; a faint picture is one
glyph; objects from two `.8bg` files are both there; a moved object leaves
no trail; objects placed at the bottom-right corner and along the right edge
do not wrap onto the next row or reach the program; an animation alternates
its two frames every four updates and blanks the cells the frame leaves;
`hide` empties the object's cells and `place` brings it back; a paused
object holds the frame `setFrame` gave it while another plays on; `color`
tints one object, 9 is white and not multicolor, and a letter stored where an
object stood is white; two eight-frame objects fill the pool exactly and a
third is not drawn; an object is the same in both halves of a
`Slot.CHARSET` split. And without an emulator
(`packages/graphics/test/vic20-ops.test.mjs`, which CI runs): the twin
imported into a web-target program, whose wasm runs in node, copies the
VIC-20's screen and color RAM after each step, so every cell the twin wrote
is read back exactly on both memory maps — and each of ten deliberate
breakages of the twin (unmasked color, color RAM left behind, the pool a
byte over or short, no clipping, no clamp, no pause, no blank on hide, no
slot guard) fails its check. Not verified: PAL (the cells do not move with
the region), the 3K and 16K/24K layouts, and real hardware.

Two traps for whoever adds an operation. The wasm run reads the twin's
tables from the web build's memory (about `$2100`) to prove an out-of-range
slot touches none of them; an index past an array lands in the next array and
nothing on the screen shows it. And a capture's `--frames` counts the
start-up: a program acts after its own n-th `waitFrame()` about `n + 190`
frames into the capture (`BOOT_FRAMES` in `test/gfx.mjs`, measured by printing
one mark per ten frames).

## Raster splits

`src/rasterline.8bs` is the VIC-20 behind `@8bitscript/raster`, and the
one rasterline file whose machine has no interrupt to apply a list with.
Everything here was measured under xvic (VICE 3.10) from
`test/raster-probe.8bs` and scratch probes on 2026-09-29, both regions;
none of it has been checked on a real VIC-20. Read it before changing a
cycle in `vic20RasterFrame`.

### Who applies the list

`FRAME_SYNC.vic20.frameHook` names `vic20RasterFrame`, and the routine
every `waitFrame()` call shares (`waitFrameRoutine` in
`packages/compiler/src/mos/startup/waitframe.ts`) `JSR`s it right after
its raster wait sees the frame wrap — the same seam the NES's
`nesVerticalBlank` uses, opened to *level* machines for this. The hook
busy-waits down the frame, writes `$900F` at each planned line, and
returns; `waitFrame()` then counts the frame as before. So the portable
contract holds as on the C64: build once and `enable()`, and the list
shows every frame; rebuild, and `commit()`.

Nothing in a program calls the hook, so the pruner could not see it.
`linker/reachability.mjs`'s `pruneUnreachable(ir, { frameHook })` keeps
it when, and only when, a function the program reaches shares a global
with it (`frameHookWanted`) — the hook reads `planCount`, and only
`commit()` writes it. A program that imports `@8bitscript/raster` and
never commits, or whose raster branch a `#fact` folded away, carries
none of it: byte-identical to a program without the import
(`packages/compiler/test/mos-vic20-raster.test.ts`). The build's
"inlined away" guard (`mos/index.ts`) fires only for a hook the program
calls or still feeds.

What that costs a program — **expose it, never hide it**:

- **The frame is the hook's until the last planned line.** From the top
  of the frame to the last entry's line the CPU is inside the hook; the
  program's own work gets what is left. Last entry at picture line 140 on
  NTSC is raster 190: about 70 lines, ~4,600 cycles of the frame's
  16,965. At line 183, ~28 lines, ~1,800 cycles. Put splits high.
- **A frame `waitFrame()` does not wait on gets no splits**, or late ones:
  a program still working when the frame wraps catches the wrap late
  (the raster wait's half-frame window), and every line already passed
  is written at once. A program that runs below frame rate shows the
  last value written for the frames it misses.
- **PAL at 60 logical frames a second** (`frameRate`'s default) earns
  1.2 logical frames per 50 Hz edge, so every sixth `waitFrame()` returns
  without waiting — no edge, so no hook — and the program runs two
  logical frames in one hardware frame's remainder. The picture is still
  right only if both fit before the wrap; a program that overruns shows
  one flat frame in six. A PAL program that uses splits wants
  `frameRate: 50`, or half the remainder above as its budget. NTSC is the
  reassuring half: 60 against 60.28 Hz, a call now and then waits two
  edges, and the hook runs on both.
- **No `waitFrame()`, no splits.** Nothing else calls the hook.
- **Bytes** (`8bs build vic20 --size`, NTSC, 2026-10-03, with
  `Slot.CHARSET`): the hook is 217 (166 before it); `commit()` with the
  plan builder inlined ~489 (~415); `at()` 112 (106); `bits()` 42 (20);
  the region probe 51. `examples/fancy` on the 8K build is 3811 (3654
  before `Slot.CHARSET`, which it does not use; 2803 without raster at
  all) and 74 bytes of RAM (71). The list (48 bytes), which planned line
  each entry went to (16) and the plan (5 × 16) sit in the cassette
  buffer, `$033C`–`$03CB`, not in the program image.

### Landing on the line: what the VIC-20 does

- **`$9004` is raster bits 8–1; `$9003` bit 7 is bit 0.** Polling `$9004`
  alone lands anywhere in a two-line window. The hook polls `$9004`
  (`lda / cmp / bcc`) to reach the line pair before the one it syncs on,
  then waits for `$9003` bit 7 to *change* into that line (`bit $9003 /
  bpl` for an odd line, then `bmi` for an even one): a 7-cycle loop,
  which is all the jitter left. Both paths reach the stores in the same
  number of cycles (11).
- **Every cycle of a line is on screen.** xvic's capture is 520 px wide
  on NTSC and 568 on PAL — 65 and 71 cycles at 8 px a cycle — so there is
  no blanking a write can hide in. A store is invisible only where its
  slot does not show: a BORDER change while the beam is in the picture, a
  BACKGROUND change while it is in the border. So each planned line is
  **two stores**: the border half inside the picture of the line above
  the target, the background half in the border between that line and
  the target. Result: the target line is the first whole line in the new
  colors, on both slots. The one visible trace is the line above's
  *right* border, already the new border color — no store position
  avoids that for a border split.
- **The counter ticks at a different point of the line on each region.**
  Measured with one store 12 cycles after the `$9003` edge: NTSC it
  landed at x 274–322 of the captured row *before* the new line's (cycles
  34–40), PAL at x 50–98 of the new line's own row (cycles 6–12). So the
  edge into raster line R is seen about cycle 22 of the row R − 1 on NTSC
  and about cycle −6 of row R (= 65 of row R − 1) on PAL. That is why the
  delays are per region, and why one set of delays cannot serve both.
- **Geometry of the capture.** Raster line L is PNG row L − 28 on both
  regions. Picture line 0 is raster line `$9001` × 2: 50 NTSC (`$19`), 76
  PAL (`$26`), read by `commit()` rather than assumed — so picture line P
  is row P + 22 (NTSC) or P + 48 (PAL). The picture spans x 40–391 (NTSC)
  or 96–447 (PAL); the border is the rest of the row.

### The windows, and the delays chosen in them

Syncing on the edge of the line before the target (T − 1), with the
7-cycle jitter already allowed for, a store `d` cycles after the edge is
invisible when:

| | Border store (in row T − 1's picture) | Background store (in the border after it) |
| --- | --- | --- |
| NTSC | d in 48–85 | d in 92–106 |
| PAL | d in 18–55 | d in 62–82 |

The hook's cycle count after the edge is `22 + P1` to the first store and
`11 + P2` more to the second; P1 and P2 are the padding. Chosen:

| | P1 | P2 | first store | second store | margin (low / high) |
| --- | --- | --- | --- | --- | --- |
| NTSC | 36 | 27 | 58 | 96 | 10 / 27, 4 / 10 |
| PAL | 14 | 25 | 36 | 72 | 18 / 19, 10 / 10 |

NTSC's background store is the tightest: 4 cycles early and it splits the
line above (the mutation test below). The padding is a `jsr` into a run
of twelve `nop`s ending in `rts` (`jsr` + `rts` is 12 cycles, each `nop`
entered 2 more) plus a `bit $00` for an odd count — **never a loop**: a
taken branch that crosses a page costs a cycle more, and where the linker
puts the hook changes with every program. There is no taken branch
between the edge and either store (the odd path leaves by `jmp`). The
hook has one copy per region, chosen once a frame before any waiting;
`commit()` probes the region once (`$9004 >= 140`, the frame runtime's
own PAL test, 26,624 cycles — over a PAL frame) and caches it.

### `Slot.CHARSET`: the third store

`$9005` bits 0–3 are the character base and bits 4–7 the screen's, so
an entry's value is stored as the whole byte: `Video.MEMORY_POINTER_UPPERCASE`
(value 0, the upper-case/graphics ROM at `$8000`) or `_LOWERCASE` (1, the
mixed-case ROM at `$8800`) — the geometry file's constants, so the
screen nybble is the build's own (`$F` unexpanded and 3K, `$C` from 8K)
and nothing reads it. RAM character sets are not a value: the VIC can
only see one in `$1000`–`$1FFF`, a reservation no package makes yet.

- **Where it lands.** The byte is loaded into Y at the start of the
  second padding (`ldy $03bc,x`, page 3, 4 cycles, taken out of the
  padding so P2 is unchanged) and stored with `sty $9005` straight after
  the background store: **100 cycles after the edge on NTSC, 76 on
  PAL**. The colour stores did not move a cycle.
- **The window, measured** with `test/raster-charset-probe.8bs`
  (eight entries mid-row, every picture line compared with a whole-screen
  capture in each set, two frames) by moving the store in 2-cycle steps:
  NTSC whole from 89 to 104 (88 and earlier split the line above, 106 and
  later the target), PAL 60 to 82 (58 / 84). Chosen 100 and 76: margins
  11 / 4 on NTSC — the same 4 as the background store's own low side —
  and 16 / 6 on PAL. A character-set split is invisible exactly where a
  background split is, in the border between the lines: the VIC fetches
  the character with the cell, so the high side is a cycle or two
  earlier than the background's 106.
- **The frame starts in the last entry's set.** The hook writes the
  carried value (`charsetTop`) to `$9005` before it waits for anything,
  so the lines above the first entry show the last entry's set however
  the program left `$9005` — and `@8bitscript/text` selects the
  mixed-case set before every run it prints. What the hook cannot undo:
  a print *below* the last planned line, in the same frame, switches the
  rest of that frame to mixed case. A program that prints there keeps its
  last CHARSET entry at 1.
- **A list with no CHARSET entry still makes the third store**, of
  `$9005`'s own byte: the hook copies it into the plan once a frame
  before waiting (a 16-iteration loop at most, inside time it spends
  waiting anyway), so the timed code has no branch and a colours-only
  program's `$9005` is never changed. (`test/raster-probe.8bs` is that
  case.)
- **Tail time.** The `sty` is 4 more cycles a planned line after the last
  store; the next planned line's `$9003` poll still starts before its edge
  (at most two lines on, 130 cycles NTSC), so the two-line rule stands —
  the colour probe's line-61 entry still lands at 62.

### Rules the plan follows

- **Two lines apart, or it is moved.** A planned line keeps the hook
  about a line and a half (the second store is 96 cycles after the edge
  on NTSC), so an entry one line below the previous one's would miss its
  edge. `commit()` plans it two lines below instead, where it lands
  exactly (the probe's line-61 entry shows at 62). Entries on the *same*
  line merge into one planned line — BORDER and BACKGROUND share `$900F`.
  An entry the rule pushes past the picture (184 lines), and every one
  after it, is not planned.
- **Whole bytes, never read-modify-write.** `commit()` works out both
  stores' bytes: each slot the list sets carried from the entry that last
  set it, the lines above the first entry taking the last one's value
  (the frame wraps, as on the C64). Bits the list sets no entry for — a
  slot it never names, and bit 3, inverted video — are 0 in the plan and
  come from `$900F` through the hook's `base`, read once a frame. (The
  cassette buffer holds whatever was there; an earlier draft masked
  bytes in place and would have forced bit 3 on.)
- **`setValue` rewrites the plan's bytes** from the list without a
  commit, as long as the list has not changed since the last one.
- **Nothing is computed in the hook** but the one `$900F` read, and
  `$9005`'s once-a-frame copy or top-of-frame write (above), both before
  any waiting. The picture-to-raster sum, the pair to poll for, the
  parity, the merge, the carry and all three bytes are `commit()`'s —
  the root file's rule.

### What was tried and why it failed

- **A cycle-counted delay from one sync at the frame top.** Every entry
  after the first counted lines of 65 or 71 cycles from one `$9004`
  poll. It drifted by each entry's call overhead (splits 3–5 lines low),
  and syncing after `waitFrame()` had already returned in the top half
  waited out a whole extra frame, so the splits showed on every second
  frame only (period 2, found by scanning eight consecutive captures).
- **Counting `$9004` values as lines.** `$9004` is half the line; a
  delay fed the halved number landed every split at half its line.
- **`sei`/`cli` around the busy-wait.** Under `waitFrame()` interrupts
  are already off; the `cli` turned the KERNAL's IRQ back on for the
  rest of the program.
- **One store per planned line.** Lands in the picture on NTSC (a
  background split shows a jittering partial line above it) and in the
  left border on PAL (a border split does). Hence two.
- **Delay loops (`dey / bne`).** Correct until the loop straddles a page.

### Troubleshooting

- **No splits at all**: is the hook linked? `8bs build vic20 --size`
  lists `vic20RasterFrame`, and `--debug`'s listing shows `JSR` right
  after `LDA $9004 / CMP #$40 / BCS` (the wait's returning half). If it is
  missing, the program does not reach `commit()`/`enable()` — or the
  pruner's rule changed.
- **Splits on every other frame**: something waits a frame inside the
  hook. Capture consecutive frames (`--frames 822`, `823`, ...) and scan
  a column; a period-2 pattern is a lost frame, not jitter.
- **A split a line or two low**: two entries closer than two lines, or the
  hook reached its edge late (more work before the first poll). Compare
  with the two-line rule before touching the timing.
- **A partial line above a split, moving between frames**: a store left
  its window. Re-measure the edge with one store (the NTSC 274–322 / PAL
  50–98 experiment above), redo the windows, and re-run the test.
- **Tools**: `test/raster.test.mjs` is the gate; it reads rows and whole
  runs of pixels with `pixelAt` from `packages/cli/src/png.mjs`. The
  mutation that proved it bites: NTSC's second `jsr sled+6` changed to
  `sled+12` (12 cycles early) fails at picture line 59.

## The wasm build: text, both ROM sets, reverse video

The wasm build is the primary way to run a VIC-20 program (`8bs run vic20 --web`, the
editor's Editor tab; `docs/project/wasm-primary.md`), and `8bs conform vic20`
measures it against xvic: 0 cells differ in structure on all three probes (`grid`,
`charset`, `charset-text`; `test/conform.test.mjs`); the `grid` probe's colour row
differs in 6 cells in colour only (the page's palette is not xvic's: backlog item 5).

- **The page boots in the upper-case and graphics set** (`$8000`, low nybble of
  `$9005` = 0) — `text.8bs` stores `MEMORY_POINTER_UPPERCASE` there itself — and
  follows the low nybble to the lower/upper-case set (`$8800`, nybble 2). The page
  reads `$9005` each frame (`REAL_MACHINE_LAYOUT.vic20.charsetSwitch`). Nybbles 1 and 3
  name the ROM's reversed copies, which the tables hold as codes 128–255, so they draw
  as their neighbour; 4 and up read the chip's own registers and are not modelled.
- **Reverse video is a screen code's bit 7**, the glyph inverted — the ROM's reversed
  copies are exactly the inversion (`packages/cli/scripts/font-roms.mjs` checks it).
  The ink is the cell's colour RAM nybble, as before.
- The tables come from VICE's `chargen-901460-03.bin` (SHA-256 pinned in the
  generator): the text set was read from it earlier, the upper-case set is generated.
- The quadrant-block objects `@8bitscript/graphics` places draw on the wasm page now
  (`examples/media-walk`), because the codes they use are drawn.

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
packages/vic20/src/text.8bs             @8bitscript/vic20/text: ASCII → screen code, color nybble masked to 3 bits, 22 × 23
packages/vic20/src/rasterline.8bs       @8bitscript/vic20/rasterline (behind @8bitscript/raster): the list, commit()'s plan in the cassette buffer ($033C-$03CB), vic20RasterFrame — the frame hook, two timed copies (NTSC, PAL)
packages/vic20/test/raster-probe.8bs    the probe: a list built once, both slots, an adjacent entry, a merged line, setValue after fifty frames, a frame counter
packages/vic20/test/raster-charset-probe.8bs   eight CHARSET entries mid-row on screen code 66 (a different glyph on all eight lines in the two sets), two merged with BORDER
packages/vic20/media/index.cjs          the `.8bg` and `.8ba` lowering: pictures reduced to quadrant-block screen codes at build time (each sprite's 8BS2111 note says its share of the 64-byte `POOL`, which the twin repeats), songs to VIC register events
packages/graphics/src/index.vic20.8bs   @8bitscript/graphics' drawing loop: codes in a pool, clipped to the screen, blank-then-draw on a move
packages/vic20/test/graphics.test.mjs   under xvic: cells by position, 8x8 vs 16x16, a glyph, two modules, no trail, the corner, an animation
packages/vic20/test/graphics-ops.test.mjs   under xvic: hide, setFrame/animate, color (wrap, ink left behind), the pool, an object across a Slot.CHARSET split
packages/vic20/test/gfx.mjs             the graphics tests' shared reads: capture geometry, quadrant masks, ink colors, BOOT_FRAMES
packages/graphics/test/vic20-ops.test.mjs   the twin run cell by cell under wasm (CI), with its breakages, and the 6502 build's size
packages/vic20/test/capture.mjs         the tests' shared helpers: run the CLI, decode a capture
packages/vic20/test/raster.test.mjs     links the probes; under xvic, NTSC and PAL (and NTSC 8K for CHARSET), two consecutive frames each, every split on its line and whole
packages/compiler/src/mos/index.ts     FRAME_SYNC.vic20 ($9004 poll; frameHook vic20RasterFrame); the SEI a waitFrame() program starts with
packages/compiler/src/mos/startup/waitframe.ts   rasterWait, and waitFrameRoutine's JSR to the frame hook after it
packages/compiler/src/linker/reachability.mjs    pruneUnreachable's frameHook rule and frameHookWanted: the hook is kept only when the program feeds it
packages/compiler/test/mos-vic20-raster.test.ts  the hook's JSR, the rooting rule, byte-identity when nothing feeds it
packages/cli/src/run.mjs                VICE_MODEL_ARGS.vic20 (-model vic20ntsc/vic20pal); the catalog's -memory and port flags appended
packages/cli/src/screenshot.mjs         VICE_CLOCK_HZ.vic20, the 14 000 000-cycle default
packages/compiler/test/vic20-profiles.test.mjs   every ram value draws at its geometry; 8k/16k/24k share the expanded tag and one file
packages/studio/src/main.8bs            Studio's tier from the facts: viewer unexpanded/3k, basic at 8k and up (memory.ram vs EDIT_BYTES)
docs/setup/vice.md                      installing xvic; the ram option's table
docs/roadmap.md                         Phase 1: the original hardware target
VIC-20 Programmer's Reference Guide    memory map, VIC at $9000, VIA1/VIA2
vice/src/vic20/ (SourceForge trunk)     vic-cycle.c (the 14-bit address fix-up), vic-draw.c (multicolor order), vic20sound.c, vic20via1.c/vic20via2.c, vic20model.c, vic20-cmdline-options.c
```
