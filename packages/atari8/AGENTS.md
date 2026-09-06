# Writing Atari 8-bit support for 8BitScript

This file is for anyone — human or agent — touching `packages/atari8`,
`packages/backend-6502`'s `atari8` entries (`ATARI8_PROFILES`,
`driverFor()`, `outputExtension()`, `FRAME_SYNC.atari8`), `packages/cli`'s
atari800 handling (`ATARI8_MODEL_ARG`, `atari800CleanDisplayConfig()`,
`atari8Screenshot()`, the `CLANG_DRIVERS` rows in `doctor.mjs`),
`docs/setup/atari8.md`, or the Atari rows of `docs/roadmap.md`,
`docs/setup/llvm-mos.md` and `packages/studio/AGENTS.md`. Read the root
[`AGENTS.md`](../../AGENTS.md) first; the rules there apply to every target
and are not repeated. [`packages/nes/AGENTS.md`](../nes/AGENTS.md),
[`packages/cx16/AGENTS.md`](../cx16/AGENTS.md),
[`packages/pet/AGENTS.md`](../pet/AGENTS.md) and
[`packages/c64/AGENTS.md`](../c64/AGENTS.md) are the contrasts: almost
nothing, a great deal behind ports, only RAM and a character ROM, and one
video chip reading one bank. The Atari is a fifth case —

> **The Atari 8-bit has no screen. ANTIC is a DMA processor that runs a
> *program* — the display list — out of the same RAM the 6502 uses, and
> hands each scanline's bytes to GTIA, which colours them from nine colour
> registers and overlays four 8-pixel-wide players and four 2-pixel
> missiles that are full-height vertical strips, not movable blocks. Text,
> tiles and bitmaps are all just ANTIC modes. The OS supplies one display
> list (40×24 text) and, every vertical blank, copies its own shadow
> registers over the hardware. Model it as "a display list, colour
> registers, player/missile strips, and an OS in the loop until the program
> takes the machine over" — never as "a C64 with a different colour
> table".**

The machine's variety runs on three axes that this repo's single
`--profile` flag currently folds into one: the *model* (400/800 with 8–48K
and four joystick ports; 800XL/65XE with 64K; 130XE with 64K more behind
PORTB; XEGS, a 65XE in a console case), the *media* (a DOS-loaded `.xex`,
an 8/16K standard cartridge, a 32–512K XEGS cartridge, a 16–512K
MegaCart/SIC! cartridge), and the *region* (NTSC 262 lines / PAL 312 lines,
with different palettes for the same GTIA byte). A program built for one
point in that space does not necessarily load, fit, or look the same on
the others.

## What exists today

Do not describe more than this as working:

- `packages/atari8/src/index.8bs` exports seven registers, all `@address`:
  GTIA's `borderColor` (`$D01A`, COLBK), `backgroundColor` (`$D018`,
  COLPF2) and `textColor` (`$D017`, COLPF1 — only its luminance nybble
  shows in the text mode), the OS **shadow** of each (`$02C8` COLOR4,
  `$02C6` COLOR2, `$02C5` COLOR1), and `cursorInhibit` (`$02F0`, CRSINH).
  The file's own comment records why the shadows exist: the OS's
  vertical-blank routine copies `$02C4-$02C8` over `$D016-$D01A` every
  frame, so a hardware-only colour write lasts one frame (seen on screen
  by this project when `examples/proof-of-concept/borders` first ran).
- `src/screen.8bs` (`@8bitscript/atari8/screen`, behind
  `@8bitscript/screen`): `setColors`/`setBorder`/`setBackground` write
  shadow then hardware, force COLPF1 to `$0E` so text stays readable, and
  set CRSINH; `blank()` writes internal code 0 to 960 cells starting at
  wherever SAVMSC (`$58/$59`) points. The eight colour names are raw GTIA
  bytes (hue in the high nybble, even luminance in the low); `KEEP` is 255,
  which on this machine is a real colour (hue 15 at maximum luminance)
  given up for the sentinel.
- `src/text.8bs` (`@8bitscript/atari8/text`, behind `@8bitscript/text`):
  `CELL_COUNT` 960, `COLUMNS` 40; `putChar` takes ASCII, converts to
  ANTIC's internal code (`$00-$1F` → +64, `$20-$5F` → −32, else unchanged)
  and writes `SAVMSC + cell`; `print`/`printNumber` read SAVMSC once per
  run (`prepare()`) and inhibit the cursor; `putColor` and `setColor` are
  inert because GR.0 has no per-cell colour. `printNumber` is the
  subtraction routine, not a divide.
- **Profiles** (`ATARI8_PROFILES`): `800xl` (default), `65xe`, `130xe`,
  `800`, `400` → `mos-atari8-dos-clang`, a `.xex`; `xegs` →
  `mos-atari8-cart-xegs-clang`, a `.rom`. `MACHINE_FLAGS.atari8` is empty
  and no `--defsym` is passed, so the five `.xex` profiles produce
  byte-identical programs (checked here for `800xl`, `130xe` and `800`:
  818 bytes of program each; `65xe` and `400` follow from the empty flag
  table, not from a build) and only change which atari800 model flag
  `8bs run` uses. The XEGS
  build takes the SDK's default `__cart_rom_size = 256` and is a 262144-byte
  image. Output names are `main-atari8-<profile>-<region>.xex|rom`.
- `FRAME_SYNC.atari8` is a *level* driver polling ANTIC's VCOUNT
  (`$D40B < 64` for the top half, `>= 140` as the PAL probe), NTSC
  `262 × 114 / 1789790`, PAL `312 × 114 / 1773447`. It has no `presync`:
  a built program contains **no `sei`** (checked in the linked ELF), so
  the OS's VBI keeps running — its jiffy clock, keyboard, joystick shadows
  and colour-shadow copy all stay alive under an 8BitScript program.
- `8bs run atari8` launches `atari800` with a copy of `~/.atari800.cfg`
  whose CRT-shader knobs are zeroed, the model flag (`-atari` for 800 and
  400, `-xl` for 800xl and 65xe, `-xe` for 130xe, `-xegs`), `-ntsc`/`-pal`,
  a 3× window of the "tv" area, and `-run <file.xex>` — or, for `xegs`,
  `-cart <file.rom>`. **That XEGS launch does not run the program** (see
  the verified table: atari800 stops at its "Select Cartridge Type" menu
  because a raw 256 KiB image matches eight cartridge types and `run.mjs`
  passes no `-cart-type`). `8bs run atari8 --screenshot` (macOS window
  capture, wall-clock `--frames` at a nominal 60 Hz) passes `-run` for
  *every* profile, so for `xegs` it hands the `.rom` to the executable
  loader and captures a blank OS screen. Neither file is changed by this
  note; both are listed under "Corrections".
- `8bs doctor` checks that both drivers and `atari800` exist; nothing
  checks for the OS ROMs atari800 needs (`docs/setup/atari8.md`).
- `packages/studio/AGENTS.md` lists `atari8` in Studio's full tier; nothing
  in Studio is Atari-specific yet.

There is no sound, no input, no player/missile, no display-list, no
character-set, no banking (130XE) and no storage API, no standard-cartridge
or MegaCart profile, no `-cart-type` plumbing, and no non-macOS screenshot
route — for this target or (mostly) for any machine. The rules below are
what to hold that work to when it comes.

## Facts verified here

Cite these freely; each was read in the source named or seen on screen
under atari800 7.1.2 (the Homebrew build, with the XL OS and OS-B ROM files
named in `~/.atari800.cfg` and atari800's bundled Altirra replacement ROMs
for anything else), not recalled. `$SDK` is `~/.local/opt/llvm-mos`.

| Fact | Where |
| ---- | ----- |
| A `.xex` starts `FF FF`, then a segment `02E0-02E1` holding `_start` (RUNAD), then the main segment loaded at `$2000` up to `__data_end - 1`. The link script's RAM region is `$2000-$BFFF` (`LENGTH = 0xa000`), chosen against a MEMLO survey (DOS 2.0S/2.5/XE 1.0 `$1CFC`, SpartaDOS X 4.49 `$1DBA`; DOS 1.0 `$2A08` and SpartaDOS 1.1 are *not* supported). Its comment: RAM "can go higher to `$C000`" if BASIC is disabled, minus 993 bytes for the OS's text screen and display list, plus the C stack. | `$SDK/mos-platform/atari8-dos/lib/link.ld`; `xxd` of a built `.xex` (`ff ff e0 02 e1 02 00 20 00 20 31 23`) |
| Imaginary registers are `$80-$9F`; the program's zero-page variables start at `$A0` (`ticks` in the borders build). | `link.ld` (`__rc0 = 0x80`, `__rc31 == 0x9f`), `llvm-objdump` of the ELF |
| DOS crt0: `_start` sets the soft stack pointer `__rc0/1` to `MEMTOP ($02E5/$02E6) + 1`, calls `main`, then `exit` → `_Exit`, which is `jmp ($0A)` (DOSVEC). Nothing is printed, no CIO call is made and no character set is switched before `main`. The SDK's own `putchar` would go through CIO's `E:` handler; 8BitScript never links it. | `init-stack.S`, `_Exit.c`, `putchar.c` (upstream `mos-platform/atari8-*`), `llvm-objdump` of the linked `.xex.elf` (no `jsr $E4xx`, no `sei`) |
| XEGS cartridge: an 8K *fixed* bank always at `$A000-$BFFF` and `__cart_rom_size / 8 − 1` switchable 8K banks at `$8000-$9FFF`, selected by a write to `$D500-$D5FF`; sizes 32–512K, power of two, default 256. RAM for the program is `$0700-$1FFF` ("assume at most 8 KiB of RAM"). The vector at `$BFFA` is `_start`, `0` ("inserted"), `$04` (bit 2 = boot), `_cart_init`. The default `_cart_init` is weak and writes 0 to `$D500` "because on real hardware the XEGS bank selection is random". In the file the fixed bank comes **last**: the built image has `00 A0 00 04 16 A0` at offset `$3FFFA` and zeros at `$1FFA`. `.data`/`.bss` land at `$0700`. | `atari8-cart-xegs/lib/link.ld`, upstream `syms.s`, `xxd`/`llvm-readelf` of the built `.rom` |
| Standard cartridge (`mos-atari8-cart-std-clang`, not wired up here): 8K at `$A000` or 16K at `$8000`, same `$BFFA` vector, same `$0700-$1FFF` RAM. MegaCart/SIC! (`mos-atari8-cart-megacart-clang`, not wired up): 16–512K in 16K banks mapped over `$8000-$BFFF`, bank 0 at power-up, a 20-byte tail in bank 0 that shrinks RAMTOP (`$6A`) to `$80` if needed and writes `$20` to `$D500` for SIC! carts. | `atari8-cart-std/lib/link.ld`, `atari8-cart-megacart/lib/link.ld`, `tail0.s` |
| atari800 cartridge types: 8K standard = type 1 at `$A000`; 16K = 2 at `$8000`; XEGS 32/64/128/256/512K = 12/13/14/23/24 (2–6 low bits of a `$D500` write pick the `$8000` bank); switchable XEGS = 33–37 (bit 7 disables); MegaCart 16–512K = 26–31 (bit 7 disables, low bits pick a 16K bank); SIC! 128/256/512K = 54/55/56 (`$D500-$D51F`). A raw image whose size matches more than one type is `CARTRIDGE_UNKNOWN`; the SDL build then opens the **"Select Cartridge Type"** menu and inserts nothing until a key is pressed. `-cart-type <0..160>` picks explicitly. | upstream `DOC/cart.txt`, `src/cartridge.c`, `src/ui.c`, `src/atari.c`; `atari800 -help` |
| The 256 KiB XEGS build, given to `atari800 -xegs -cart` without a type, shows that menu with eight candidates (XEGS 256 KB, MegaCart 256 KB, Switchable XEGS 256 KB, SIC! 256 KB, Super Cart 256 KB 5200, XE Multicart, Double Ram-Cart, J(atari)Cart). With `-cart-type 23` or `-cart-type 36` the borders program runs (`TICK n OPTION 0`, cell 0, teal on blue). The same program on `-xl` (800xl), `-xe` (130xe) and `-atari` (800, OS-B) runs the same way; the `65xe` and `400` profiles were not launched. | on screen (window capture), this project |
| `8bs run atari8 --screenshot` passes `'-run', outFile` unconditionally; with `--profile xegs` the captured window is the XL OS's blank blue screen with a cursor — the `.rom` was never inserted. | `packages/cli/src/screenshot.mjs` `atari8Screenshot()`, on screen |
| The same GTIA bytes render differently by region under atari800: the borders program's `BackgroundColor.CYAN` (`$A8`) is teal on `-ntsc` and green on `-pal`; `BorderColor.BLUE` (`$84`) is a darker blue on PAL. The SDK header says as much: hue values "can vary depending on TV standard (NTSC vs PAL), tint potentiometer settings, TV tint settings, emulator palette, etc." | on screen; `atari8-common/include/_gtia.h` |
| ANTIC (`$D400`): DMACTL, CHACTL, DLISTL/H, HSCROL, VSCROL, PMBASE, CHBASE, WSYNC, VCOUNT (read), PENH/PENV (read), NMIEN, NMIRES/NMIST. DMACTL boots as `$22` (DMA on, normal playfield, no P/M DMA, double-line P/M); playfield widths narrow/normal/wide are 32/40/48 bytes per line; bits 2/3 enable missile/player DMA, bit 4 single-line P/M, bit 5 display-list DMA. CHACTL `$02` at boot (inverse shown as reverse video; bit 2 flips characters upside down). NMIEN: `$80` DLI, `$40` VBI, `$20` RESET. | `_antic.h` |
| ANTIC modes (bytes are the mode number in a display-list instruction): **2** 40 chars × 8 lines, 1 colour + luminance (GR.0); **3** 40 × 10 (descenders; no OS support); **4** 40 × 8, 4 colours per char pair-of-bits (GR.12); **5** 40 × 16 (GR.13); **6** 20 × 8, 2-colour-per-character (GR.1); **7** 20 × 16 (GR.2); bitmap **8** 40 px × 8, 4 colours (GR.3); **9** 80 × 4, 2 col (GR.4); **10** 80 × 4, 4 col (GR.5); **11** 160 × 2, 2 col (GR.6); **12** 160 × 1, 2 col (GR.14); **13** 160 × 2, 4 col (GR.7); **14** 160 × 1, 4 col (GR.15); **15** 320 × 1, 1 colour + luminance (GR.8; GR.9/10/11 are this mode plus GTIA's PRIOR bits). Modifiers OR'd in: `$10` HSCROL, `$20` VSCROL, `$40` LMS (two address bytes follow), `$80` DLI. Non-mode instructions: `$00/$10/…/$70` = 1–8 blank lines, `$01` JMP, `$41` JVB (jump and wait for vertical blank). | `_antic.h` |
| GTIA (`$D000`) writes: HPOSP0-3, HPOSM0-3, SIZEP0-3, SIZEM (0 = 1 colour clock per pixel, 1 = 2, 3 = 4), GRAFP0-3, GRAFM (shape bytes used when P/M DMA is off), COLPM0-3, COLPF0-3, COLBK, PRIOR, VDELAY, GRACTL (bit 0 missiles, 1 players, 2 latch triggers), HITCLR, CONSOL. Reads: M0PF-M3PF, P0PF-P3PF, M0PL-M3PL, P0PL-P3PL (16 collision registers), TRIG0-3 (0 = pressed), PAL (`$D014`; header `1` PAL / `$E` NTSC, atari800 returns `$01`/`$0F`), CONSOL (bits 0/1/2 = START/SELECT/OPTION, active low). A colour byte is `hue << 4 | lum << 1`. PRIOR: `$01/$02/$04/$08` pick one of four player/playfield orderings, `$10` makes the four missiles a fifth player in COLPF3, `$20` ORs overlapping players' colours, `$40/$80/$C0` = GTIA modes 9/10/11 (pixels 2 colour clocks wide, 80 per normal line: 16 luminances of COLBK's hue; 9 colours from COLPM0-3 + COLPF0-3 + COLBK; 16 hues at COLBK's luminance). | `_gtia.h`, upstream `gtia.c` |
| P/M DMA costs ANTIC 4 cycles per line for players plus 1 for missiles; CONSOL bit 3 drives the console speaker (`GTIA_speaker = !(byte & 0x08)`); GRACTL bit 2 clear re-arms the TRIG latches; HITCLR zeroes all 16 collision registers. | upstream `antic.c`, `gtia.c` |
| POKEY (`$D200`) writes: AUDF1-4, AUDC1-4, AUDCTL, STIMER, SKREST, POTGO, SEROUT, IRQEN, SKCTL. AUDC high bits pick the distortion: `$00` 5+17-bit poly, `$20` 5-bit, `$40` 5+4-bit, `$80` 17-bit, `$A0` pure tone, `$C0` 4-bit poly; `$10` = volume-only (the sample-playback bit); low nybble = volume. AUDCTL: `$01` 15 kHz base instead of 64 kHz, `$02`/`$04` high-pass 2-by-4 / 1-by-2, `$08` join 3+4 and `$10` join 1+2 into 16-bit channels, `$20`/`$40` clock 3 / 1 at 1.79 MHz, `$80` 9-bit instead of 17-bit poly (also changes RANDOM). IRQEN: timers 1/2/4, serial ×3, `$40` other key, `$80` BREAK. SKCTL: `$01` debounce, `$02` keyboard scan, `$04` fast pot scan, `$08` two-tone, `$80` force break. Reads: POT0-7, ALLPOT, KBCODE, RANDOM, SERIN, IRQST, SKSTAT (bit 2 last key still pressed, bit 3 SHIFT down, bit 5 keyboard overrun). | `_pokey.h` |
| atari800's RANDOM is a 17-bit (or 9-bit) poly-counter table indexed by a scanline counter plus the current cycle; its pot scan counts up over a frame (`pot_scanline` 0→228, `POTGO` restarts it; SKCTL bit 2 makes reads immediate). | upstream `pokey.c` |
| PIA (`$D300`): PORTA, PORTB, PACTL, PBCTL. Bit 2 of PxCTL selects data (1) or direction register (0). On the 400/800 PORTB is joystick ports 3 and 4; on XL/XE PORTB is memory control and `pia.c` returns it as such, never as sticks. PORTB bits: `$01` OS ROM in, `$02` BASIC ROM in, `$04/$08` 1200XL LEDs, `$80` self-test ROM at `$5000`; on the XE `$0C` picks one of four 16K banks, `$10` = CPU sees the bank at `$4000-$7FFF`, `$20` = ANTIC sees it. atari800: 128K bank = `((byte & 0x0c) >> 2) + 1`; 320K/576K/1088K reuse bits 1, 5–7. PACTL bit 3 is the cassette motor, PBCTL bit 3 the SIO command line. | `_pia.h`, `atari.h` (SDK), upstream `memory.c`, `pia.c` |
| OS locations: SAVMSC `$58`, RAMTOP `$6A`, RTCLOK `$12-$14`, ATRACT `$4D`, VDSLST `$0200`, VVBLKI `$0222`, VVBLKD `$0224`, SDMCTL `$022F`, SDLSTL/H `$0230/1`, GPRIOR `$026F`, PADDL0-7 `$0270`, STICK0-3 `$0278`, PTRIG0-7 `$027C`, STRIG0-3 `$0284`, PCOLR0-3 `$02C0`, COLOR0-4 `$02C4-$02C8`, RUNAD `$02E0`, INITAD `$02E2`, MEMTOP `$02E5`, MEMLO `$02E7`, CRSINH `$02F0`, CHACT `$02F3`, CHBAS `$02F4`, CH `$02FC`. Vectors: KEYBDV `$E420`, CIOV `$E456`, SIOV `$E459`, SETVBV `$E45C`, SYSVBV `$E45F`, XITVBV `$E462`. | `_atarios.h`, `asminc/atari.inc` |
| Timing in atari800: 114 CPU cycles per scanline (`ANTIC_LINE_C`), `STA WSYNC` resumes at cycle 106, 9 refresh cycles per line (`ANTIC_DMAR`), NMIST set at cycle 6 and the NMI taken at 12; NTSC 262 lines, PAL 312; FPS `59.9227434` / `49.8607597`; lines 8–247 are on screen and the VBI (`NMIST = $5F`) fires at line 248; VCOUNT is `ypos >> 1`. (So a frame is 29868 / 35568 cycles, and the constants imply a CPU clock of ~1789772.5 Hz NTSC / ~1773447 Hz PAL; the backend's 1789790 is the usually-quoted nominal figure — cite whichever you mean.) | upstream `antic.h`, `antic.c`, `atari.h` |
| The emulated CPU implements the unofficial 6502 opcodes (ASO/SLO, RLA, LAX, DCM/DCP, INS/ISC …) and the `JMP (addr)` page-wrap bug (a `CPU65C02` build define only removes the bug emulation). | upstream `cpu.c` |
| `atari800 -help` (7.1.2): models `-atari -1200 -xl -xe -320xe -rambo -576xe -1088xe -xegs -5200`; `-pal/-ntsc`; `-run <file>` (COM/EXE/XEX/BAS/LST); `-cart <file>` + `-cart-type <num>` (0..160), `-cart2`; `-H1..-H4 <path>` host directories as `H1:`–`H4:`, `-Hpath`, `-hreadonly/-hreadwrite` (needs the OS patch; `-nopatchall` kills `H:`); `-tape/-boottape`; `-mouse off|pad|touch|koala|pen|gun|amiga|st|trak|joy`, `-mouseport 1-4`, `-cx85`, `-multijoy`; `-stereo` (two POKEYs); `-xep80/-af80/-bit3` 80-column boards; `-record/-playback` input; `-screenshots <pattern>` is only a filename pattern for the hotkey — there is no exit-and-screenshot flag; `-monitor`, `-bpc`, `-label-file`. With no Atari 5200 ROM configured, `-5200` boots on atari800's bundled Altirra 5200 kernel (seen); the same fallback for the XL/XE OS (`-xl-rev altirra`) is listed in `-help` but this host has the real XL ROM, so it is *to verify*. | `atari800 -help`; on screen (5200) |
| Under `8bs run` the emulated 800XL, 130XE and 800 show the borders program at cell 0 in the top-left of the playfield, inside a border whose colour is COLBK; the OS text screen sits below 24 blank lines and inside a normal-width (40-byte) playfield. | on screen |

## From the sources, not verified here

Each of these comes from the document named and is a lead to confirm the
first time code depends on it.

**Which HPOS values are visible.** The registers are 8-bit; atari800's
`gtia.c` maps `HPOS − $20` onto its pixel-pair scanline with clipping at
`$22`/`$BE`, which is the emulator's internal geometry, not the documented
`$30-$CF` for a normal-width playfield. *To verify* against the hardware
manual before a P/M API hardcodes an offset.

**Character-set alignment.** CHBASE holds the high byte of the set's
address; the OS's 40-column sets are 1K (128 glyphs × 8 bytes) and the
20-column modes use 512-byte sets. Whether ANTIC ignores the low bits of
CHBASE below 1K/512 bytes is the usual claim; *to verify*. Same for PMBASE
(2K for single-line, 1K for double-line P/M). The ROM set lives at
`$E000-$E3FF` on the XL OS (*to verify*).

**Per-mode DMA cost.** atari800 has per-mode `load_cycles`/`font_cycles`
tables for narrow/normal/wide; the values were not extracted. The usual
figures (mode 2 normal width ≈ 40 screen + 40 font + 9 refresh cycles on
the first line of each row) are *to verify*.

**Attract mode.** ATRACT (`$4D`) counts up in the VBI and after roughly
nine minutes without a key the OS starts cycling the colours through
COLRSH/DRKMSK; a joystick-only game must zero ATRACT each frame. The
duration is *to verify*; the flag's existence is in `_atarios.h`.

**Keyboard codes.** KBCODE's values (row/column encoding, SHIFT/CTRL in
bits 6/7) and the OS's CH shadow are documented in the OS manual; the table
is *to verify* before a `keys.8bs` is written.

**Model RAM.** 400 = 8K (16K later), 800 = up to 48K, 1200XL/800XL/65XE =
64K, 130XE = 128K: from the machines' own manuals, *to verify*. What
atari800's `-atari` sets `MEMORY_ram_size` to is also *to verify*
(`-5200` sets 16, `-xegs` 64 — read in `atari.c`).

**Standard cartridge start sequence.** The `$BFFC` byte and `$BFFD` flags
(bit 7 diag, bit 2 boot after init, bit 0 disk boot) are the OS manual's;
the SDK writes `0, $04`. *To verify* what the OS does with bit 0 clear.

**ST mouse / trackball / paddles.** atari800 feeds the ST and Amiga
mouse as quadrature codes on the stick bits of PORTA and the trackball as
direction/toggle bits (`input.c`), i.e. the program decodes movement itself
at a high poll rate; paddles are POT0-7 (0–228, `INPUT_mouse_pot_min = 1`,
`_max = 228`) with the buttons on stick bits; the light pen is PENH/PENV
with offsets `42`/`2`. The hardware protocols behind those codes are *to
verify* in the ST/Trak-Ball documentation.

## Corrections to what the repository says

- **`docs/setup/atari8.md`** and `packages/cli/src/run.mjs`: "XEGS, which
  loads as a cartridge instead (`-cart <file.rom>`)". As wired, that launch
  stops at atari800's "Select Cartridge Type" menu (verified above). The
  fix is one flag — `-cart-type 23` for a 256K XEGS image, or the matching
  type for whatever `__cart_rom_size` the backend passes once it passes
  one — not a different emulator. Not changed by this note.
- **`packages/cli/src/screenshot.mjs`**: `atari8Screenshot()` hardcodes
  `-run`; for the `xegs` profile it must mirror `run.mjs`'s `-cart` (and
  the `-cart-type`). Not changed by this note.
- **`docs/setup/llvm-mos.md`**: "a profile only changes which of the two
  drivers above runs, and which atari800 machine model `8bs run`
  launches" — also true, but the XEGS driver changes the *load address*
  (`$A000` fixed bank, RAM at `$0700`), the *RAM budget* (6.25K, not 40K)
  and the *image size* (256 KiB by default). Say so wherever the XEGS
  profile is described.
- **`packages/backend-6502`'s `FRAME_SYNC.atari8` comment** says the
  Atari clocks could not be re-derived. atari800's own constants give
  `59.9227434 × 262 × 114 = 1789772.5` and `49.8607597 × 312 × 114 =
  1773447`; the NTSC figure differs from the backend's 1789790 by ten
  parts per million. Either is fine for pacing; cite the one you mean.
- **`packages/atari8/src/screen.8bs`** says its colour names are "not
  visually verified under atari800". They are now — on NTSC, `BLUE`
  border and `CYAN` background read as their names; on PAL the same
  `CYAN` byte is green. Keep the names, but never describe a GTIA byte as
  a colour without saying which region.

## Rules for this target

### Model, media and region are three axes, not one profile

- `ATARI8_PROFILES` mixes a model (`800xl`) with a medium (`xegs`). When
  the next profile arrives (a standard 8K/16K cartridge, a MegaCart, a
  130XE build that uses its extra RAM), split the axes the way the root
  file asks: the model decides the atari800 flag, the joystick-port count
  and the RAM ceiling; the medium decides the driver, `__cart_rom_size`,
  the load address and the persistence story; the region is already a
  separate flag. Pass `__cart_rom_size` explicitly and the matching
  atari800 `-cart-type` in the same change — a raw cartridge image has no
  header and the emulator cannot guess its type.
- A `.xex` profile links every model identically (verified). That is
  honest for 64K machines; on a 16K 400 the `$2000-$BFFF` region does not
  exist, so a `400` profile that means anything must cap the RAM region
  (a `--defsym`, the way the PET's `__ram_size` does) rather than only
  choosing the emulator flag.
- Never probe RAMTOP, PORTB or the OS revision at run time to learn what
  the build is for. Width, RAM, ports and medium are properties of the
  build.

### The OS is in the loop until the program takes the machine over

- Every colour goes to the shadow *and* the hardware register while the
  OS VBI is alive, as `screen.8bs` does; the same is true of DMACTL
  (SDMCTL), the display list pointer (SDLSTL/H), CHBASE (CHBAS), CHACTL
  (CHACT), PRIOR (GPRIOR) and the P/M colours (PCOLR0-3). A hardware-only
  write is a one-frame write.
- `sei` does not stop the VBI or a DLI: both are NMIs. Taking over means
  either hooking VVBLKI/VVBLKD through SETVBV (and returning through
  SYSVBV/XITVBV) or clearing NMIEN's VBI bit — and once NMIEN is cleared
  the OS jiffy clock, keyboard, joystick shadows and attract-mode
  handling are all gone, so the program owns them.
- Screen memory is wherever SAVMSC says, the display list wherever SDLSTL
  says, and both sit in the 993 bytes the OS keeps just below RAMTOP.
  MEMTOP is the soft stack's base (crt0, verified). A program that puts
  its own display list, screen or P/M area at the top of RAM must lower
  RAMTOP/MEMTOP *and* re-derive the stack, or the two collide.
- Interrupt-time code (a DLI, a custom VBI) must save and restore what it
  touches, and a DLI has roughly a scanline to work in: do the register
  writes right after `STA WSYNC` so they land in horizontal blank.

### Video is a display list, and text is one of its modes

- The 40×24 text grid is the OS's choice, not the machine's. A portable
  text surface is a mode-2 line set with a known SAVMSC; anything wider
  (mode 6/7 double-width text, mode 4/5 four-colour characters, mixed
  mode lines, narrow/wide playfield) is a different display list that the
  package owns and describes.
- There is no colour RAM. Colour granularity is per *playfield register*
  (five registers for the whole screen), per *scanline* through a DLI, or
  per *character* only in the 20-column modes (top two bits of the code
  pick the register) and the four-colour character modes (bit pairs in the
  glyph). `text.putColor` stays inert in mode 2; a colour-per-cell intent
  on this machine means choosing mode 4 or mode 6/7 at build time, not
  faking it.
- The character set is a 1K table anywhere in RAM named by CHBASE
  (alignment *to verify* above): redefinable glyphs, tiles, and
  pseudo-pixels are all the same thing here. The ROM set's `$00-$1F`
  (ATASCII `$20-$3F`) holds punctuation and digits; the line/corner glyphs are in
  the ATASCII control range (`atari.h`: `CH_ULCORNER = $11`, `CH_HLINE =
  $12`, `CH_VLINE = $7C`). Bit 7 of a screen byte inverts the glyph in
  hardware (CHACTL bit 1), so reverse video is free.
- Bitmaps are modes 8–15: 320×192 in one colour + luminance (mode 15), or
  160×192 in four colours from COLPF0-2 + COLBK (mode 14), 7680 bytes each
  at full height; GTIA modes 9/10/11 trade to 80 pixels across for 16
  luminances, 9 colours, or 16 hues. Each is a mode line the display list
  names, and they mix with text lines on the same screen.
- Hardware fine scroll is two registers (HSCROL 0–15 colour clocks, VSCROL
  0–15 lines) applied to the display-list lines that carry the `$10`/`$20`
  bits, with LMS on each line to move the coarse position; the hardware
  scrolls the *playfield*, never the P/M strips. One layer, no priority
  between backgrounds: there is only one background.
- Screen RAM can be written at any time (ANTIC reads it by DMA; there is
  no snow and no vblank-only window), so the NES's write queue does not
  belong here. The only reason to time a write is tearing, and `waitFrame()`
  already provides that edge.
- The border is COLBK and the playfield width (DMACTL bits 0–1) decides
  how much of it shows; a wide playfield shows none. `screen.setBorder`
  is real here, unlike the X16.

### Players and missiles are strips, not sprites

- Four players, 8 pixels wide at size 0 (16 or 32 with SIZEP), and four
  2-pixel missiles, each a **full-height vertical strip** at one HPOS: a
  player's byte at row *y* is what shows on row *y*, so vertical movement
  is moving bytes inside the strip (or the whole strip's data), horizontal
  movement is one register write. The constraint shape is the *opposite*
  of the NES and C64: every strip is on every line, so "how many sprites
  per line" is 4 (+1 fifth player from the missiles), and more objects
  means re-positioning a strip mid-frame from a DLI.
- Two ways to feed the strips: ANTIC DMA from PMBASE (DMACTL bits 2–3,
  GRACTL bits 0–1; single- or double-line resolution) or the CPU writing
  GRAFP0-3/GRAFM per scanline with DMA off — the "racing the beam" style
  the SDK header itself compares to the 2600. A runtime picks one and
  says so.
- Colour is one register per player (COLPM0-3); missiles borrow their
  player's colour unless PRIOR bit 4 makes them a fifth player in COLPF3.
  PRIOR bit 5 gives a third colour where players 0/1 or 2/3 overlap.
- Collisions are hardware, 16 registers, latched until HITCLR: read them
  once per frame after the display, then clear. VDELAY shifts a
  double-line object down one scanline.
- A portable `sprites` capability on this machine is honest at four
  8-wide objects with hardware collision, or wider/more with a
  DLI-driven multiplexer the package documents — never "eight sprites".

### Sound is POKEY

- Four 8-bit channels, or two 16-bit pairs (AUDCTL bits 3/4), each with
  volume and one of six distortions; no envelope generator (envelopes are
  software in the VBI), no filter beyond the two high-pass links, no
  waveform choice beyond square and the polynomial noises. Channel 1 and
  3 can run at 1.79 MHz for high-resolution pitch. Sample playback is
  volume-only mode (AUDC bit 4) driven by the CPU or a POKEY timer IRQ.
- RANDOM (`$D20A`) is hardware entropy: behind an explicit, separate
  import, never the deterministic PRNG's seed by default (root rule).
- A second POKEY (atari800 `-stereo`) is an add-on. Never assume it from
  `machine == atari8`.
- The console speaker (CONSOL bit 3) is a click line, not a voice.

### Input is PIA, GTIA and POKEY together — and the OS reads them for you

- Joysticks: PORTA holds two sticks (4 bits each, active low), TRIG0/1
  the buttons; on the 400/800 PORTB and TRIG2/3 are ports 3 and 4 — a
  *model* fact, so a program may only count on two. While the OS VBI is
  alive, STICK0-3/STRIG0-3 are refreshed every frame and are the cheaper
  read; a program that has cleared NMIEN reads PORTA/TRIGx itself. On an
  XL/XE, PORTB is memory control: never poke it for a stick.
- Paddles are POT0-7 (0–228 over one frame's scan, or immediate with
  SKCTL bit 2) with the triggers on stick bits; the OS shadows are
  PADDL0-7/PTRIG0-7.
- The keyboard is scanned by POKEY (SKCTL bit 1): a key arrives as KBCODE
  plus an IRQ, and the OS leaves the last code in CH (`$02FC`, `$FF` =
  none). SKSTAT reports SHIFT and "a key is still down" without an IRQ.
  There is no matrix to read directly; a `keys.8bs` for this machine is a
  KBCODE table (*to verify* above).
- Mouse means an ST/Amiga mouse or a Trak-Ball on a joystick port,
  decoded in software from the stick bits at a high poll rate, or a
  touch tablet/Koala pad on the pot lines; atari800's `-mouse st|amiga|trak|
  pad|touch|koala|pen|gun` emulates each on `-mouseport`. Console keys
  (START/SELECT/OPTION) are CONSOL bits 0–2, active low; HELP exists only
  on the 1200XL and later (*to verify*).

### Storage is the medium, and persistence is not a given

- A `.xex` is loaded by a DOS from `D:` (SIO disk), and `D:`/`H:`/`C:` are
  what CIO offers a program for saving. atari800's `H:` is a host
  directory (`-H1 <path>`, `-hreadwrite`; it depends on the OS patch, so
  `-nopatchall` removes it). A cartridge has no writable storage of its
  own; the 130XE's extra RAM is volatile. Persistence is therefore a
  property of the *media profile* — `.xex` under a DOS: yes, through CIO;
  cartridge: only if the program also talks to a drive.
- The XEGS/MegaCart bank register is a write to `$D500-$D5FF`, and a
  (bank, offset) pair into `$8000-$9FFF` is not a pointer. Same for the
  130XE's PORTB banks at `$4000-$7FFF`, with the extra twist that CPU and
  ANTIC can see different banks there (bits 4 and 5), so a display list
  can show data the program cannot address.

### Hazards

- None that damage hardware. Clearing PORTB bit 0 (OS ROM) or bit 7
  (self-test) with the OS alive, or clearing bit 1 under a running
  BASIC, crashes the machine rather than harming it; a runtime that
  touches PORTB preserves bits 0, 1 and 7 and changes only the bank bits.
  Nothing here earns an `8BS3003`-style diagnostic.
- `STA WSYNC` halts the CPU to the end of the line; in an interrupt
  handler that is the point, in mainline code it is a stall.

### Verify before you write it down

The root file's COLBK/COLPF2 rule came from this package. `8bs run atari8
--screenshot <file.png>` works on macOS for every `.xex` profile (window
capture, Screen Recording permission); for a cartridge, or an explicit
`-cart-type`, launch `atari800` yourself and capture its window the same
way — a ten-line script importing `findWindowIdForPid`/`captureWindow`
from `packages/cli/src/mac-window-capture.mjs` is how the XEGS and 5200
rows above were checked. Move a row from "from the sources" to "verified
here" when you do.

## Where things live

```
packages/atari8/src/index.8bs           target package: COLBK/COLPF2/COLPF1 ($D01A/$D018/$D017), their OS shadows ($02C8/$02C6/$02C5), CRSINH ($02F0)
packages/atari8/src/screen.8bs          @8bitscript/atari8/screen: shadow-then-hardware colours, blank() over 960 cells at SAVMSC, GTIA-byte colour names, KEEP = 255
packages/atari8/src/text.8bs            @8bitscript/atari8/text: ASCII → internal code, SAVMSC read per run, inert putColor, CELL_COUNT 960 / COLUMNS 40
packages/backend-6502/src/index.mjs     ATARI8_PROFILES, driverFor() (dos vs cart-xegs), outputExtension() (.xex/.rom), FRAME_SYNC.atari8 (VCOUNT poll, no sei)
packages/cli/src/run.mjs                ATARI8_MODEL_ARG, atari800CleanDisplayConfig(), the -run/-cart launch (no -cart-type: see Corrections)
packages/cli/src/screenshot.mjs         atari8Screenshot(): macOS window capture, always -run (see Corrections)
packages/cli/src/mac-window-capture.mjs findWindowIdForPid()/captureWindow(), the capture route for any atari800 launch
packages/cli/src/doctor.mjs             CLANG_DRIVERS rows for both Atari drivers; the atari800 install plan
packages/cli/test/emulator-smoke.test.mjs   atari800 -xl -ntsc -run boots a real build
docs/setup/atari8.md                    installing atari800, the ROM caveat, the profile → flag table
docs/setup/llvm-mos.md                  the two Atari drivers and the profile list
docs/setup/verify.md                    why atari8's screenshot is the one OS-level capture
examples/proof-of-concept/borders/src/main.8bs   the program every screenshot above shows
$SDK/mos-platform/atari8-common/        _antic.h, _gtia.h, _pokey.h, _pia.h, _atarios.h, atari.h (chip bases, PORTB bits), asminc/atari.inc (OS vectors)
$SDK/mos-platform/atari8-dos/lib/link.ld        the .xex format, $2000, the MEMLO survey
$SDK/mos-platform/atari8-cart-xegs/lib/link.ld  fixed $A000 + 8K banks at $8000, $BFFA vector, RAM $0700-$1FFF
$SDK/mos-platform/atari8-cart-std/lib/link.ld   8K/16K standard cartridge (not wired up)
$SDK/mos-platform/atari8-cart-megacart/lib/     MegaCart/SIC! (not wired up), tail0.o
github.com/llvm-mos/llvm-mos-sdk mos-platform/atari8-*/   the crt0 sources (init-stack.S, _Exit.c, syms.s, tail0.s, putchar.c)
github.com/atari800/atari800 src/, DOC/cart.txt           antic.c/antic.h/atari.h (timing), gtia.c, pokey.c, pia.c, memory.c (PORTB), cartridge.c/ui.c (types, the menu), input.c (controllers)
```
