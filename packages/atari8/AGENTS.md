# Writing Atari 8-bit support for 8BitScript

> **Parked in 0.2.0.** This machine is not a build target in the current
> release: `8bs build` refuses it until its native backend lands
> (`RELEASE_MACHINES` in `packages/compiler/src/resolver`). The package
> stays in the workspace, its sources still link, and everything below is
> still the guide for when it returns. The 0.2.0 work is the PET and the
> web; see the "Hello, PET" roadmap.

This file is for anyone — human or agent — touching `packages/atari8`,
this package's hardware catalog (`package.json`, `"8bitscript".hardware`:
`model`, `media`, `mouse`, `mouseport`, `stereo`), `packages/compiler/src/mos`'s `atari8` entries
(`FRAME_SYNC.atari8`), `packages/cli`'s atari800 handling
(`atari800CleanDisplayConfig()`,
`atari8Screenshot()`),
`docs/setup/atari8.md`, or the Atari rows of `docs/roadmap.md`
and `packages/studio/AGENTS.md`. Read the root
[`AGENTS.md`](../../AGENTS.md) first; the rules there apply to every target
and are not repeated. [`packages/nes/AGENTS.md`](../nes/AGENTS.md),
[`packages/cx16/AGENTS.md`](../cx16/AGENTS.md),
[`packages/pet/AGENTS.md`](../pet/AGENTS.md) and
[`packages/c64/AGENTS.md`](../c64/AGENTS.md) are the contrasts: almost
nothing, a great deal behind ports, only RAM and a character ROM, and one
video chip reading one bank. The Atari is a fifth case —

> **The Atari 8-bit has no screen. ANTIC is a DMA processor that runs a
> *program* — the display list — out of the same RAM the 6502 uses, and
> hands each scanline's bytes to GTIA, which colors them from nine color
> registers and overlays four 8-bit-wide players and four 2-bit
> missiles that are full-height vertical strips, not movable blocks. Text,
> tiles and bitmaps are all just ANTIC modes. The OS supplies one display
> list (40×24 text) and, every vertical blank, copies its own shadow
> registers over the hardware. Model it as "a display list, color
> registers, player/missile strips, and an OS in the loop until the program
> takes the machine over" — never as "a C64 with a different color
> table".**

The machine's variety runs on three axes, and the catalog now keeps all
three apart: the *model* (400/800 with 8–48K and four joystick ports;
1200XL, 800XL and 65XE with 64K; 130XE with 64K more behind PORTB; XEGS, a
65XE in a console case), the *media* (a DOS-loaded `.xex`, an 8/16K
standard cartridge, a 32–512K XEGS cartridge, a 16–512K MegaCart/SIC!
cartridge), and the *region* (NTSC 262 lines / PAL 312 lines, with
different palettes for the same GTIA byte). A program built for one point
in that space does not necessarily load, fit, or look the same on the
others. Model and media are genuinely independent — a standard cartridge
runs on an 800XL as happily as on an XEGS console — which is why they are
two options and not one, and the rule below says what belongs on each.

## What exists today

Do not describe more than this as working:

- `packages/atari8/src/index.8bs` exports sixteen registers, all `@address`:
  GTIA's `borderColor` (`$D01A`, COLBK), `backgroundColor` (`$D018`,
  COLPF2) and `textColor` (`$D017`, COLPF1 — only its luminance nybble
  shows in the text mode), the OS **shadow** of each (`$02C8` COLOR4,
  `$02C6` COLOR2, `$02C5` COLOR1), and `cursorInhibit` (`$02F0`, CRSINH).
  The file's own comment records why the shadows exist: the OS's
  vertical-blank routine copies `$02C4-$02C8` over `$D016-$D01A` every
  frame, so a hardware-only color write lasts one frame (seen on screen
  by this project when a color-cycling demo first ran). The
  other nine are what the input and sound layers below are built on:
  `attract` (`$4D`), `chShadow` (`$02FC`, CH), `consolRead` and
  `consolWrite` (both `$D01F`), `kbcode` (`$D209` read), `skstat` (`$D20F`
  read), `audctl` (`$D208`), `randomRegister` (`$D20A`) and `palRegister`
  (`$D014`). Three of those addresses are one register read and a
  different one written — CONSOL, KBCODE/STIMER, SKSTAT/SKCTL — so each
  direction has its own name and a layer cannot pick the wrong one.
- `src/screen.8bs` (`@8bitscript/atari8/screen`, behind
  `@8bitscript/screen`): `setColors`/`setBorder`/`setBackground` write
  shadow then hardware, force COLPF1 to `$0E` so text stays readable, and
  set CRSINH; `blank()` writes internal code 0 to 960 cells starting at
  wherever SAVMSC (`$58/$59`) points. The eight color names are raw GTIA
  bytes (hue in the high nybble, even luminance in the low); `KEEP` is 255,
  which on this machine is a real color (hue 15 at maximum luminance)
  given up for the sentinel.
- `src/text.8bs` (`@8bitscript/atari8/text`, behind `@8bitscript/text`):
  `CELL_COUNT` 960, `COLUMNS` 40; `putChar` takes ASCII, converts to
  ANTIC's internal code (`$00-$1F` → +64, `$20-$5F` → −32, else unchanged)
  and writes `SAVMSC + cell`; `print`/`printNumber` read SAVMSC once per
  run (`prepare()`) and inhibit the cursor; `setReverse` sets bit 7 of the
  internal code; `putColor` and `setColor` are
  empty because GR.0 has no per-cell color — a call to either is deleted
  before lowering. `printNumber` is the
  subtraction routine, not a divide.
- `src/joystick.8bs` (`@8bitscript/atari8/joystick`): `scan()` once a
  frame into a snapshot, then `bits`/`up`/`down`/`left`/`right`/`fire`, and
  `Joystick.PORT_1`-`PORT_4`. It reads the OS shadows STICK0-3
  (`$0278`) and STRIG0-3 (`$0284`), not PORTA/TRIG, because the OS VBI is
  alive under every build this toolchain makes; the direction bits are
  inverted once, here. `Joystick.PORTS` is `#fact(input.joysticks)`, so the
  scan loop is two iterations on an XL/XE build and four on a 400/800 one —
  a program never reads PORTB and calls the memory-control bits a joystick.
  `scan()` also zeroes ATRACT every frame, which is the whole fix for
  attract mode in a joystick-only game.
- `src/console.8bs` (`@8bitscript/atari8/console`): `scan()`/`pressed()`/
  `bits()` over CONSOL's three keys (START, SELECT, OPTION, active low,
  read from the hardware so they work with or without the OS), plus
  `click()` and `speaker()` for the console speaker on the same address's
  bit 3. Not a voice — there is no frequency and no volume.
- `src/keyboard.8bs` + `src/keys.8bs` (`@8bitscript/atari8/keyboard`,
  `/keys`): `scan()` takes CH (`$02FC`) and hands `$FF` back, the
  documented way to consume a key, and reads SKSTAT for "still held" and
  "SHIFT down"; `pressed`/`key`/`code`/`down`/`shift`/`control`/`clear`,
  and `raw()` for KBCODE when the OS has been switched off. **It cannot
  answer chords** — POKEY reports one key and one held bit, so "are these
  two keys both down" is not a question this machine answers, and the file
  says so rather than offering a `pressed()` that lies. `keys.8bs` is
  *generated* from the Atari OS KBCODE table (61 codes) and a test rechecks
  it against that table.
- `src/pokey.8bs` (`@8bitscript/atari8/pokey`): four voices,
  `reset`/`setVolume`/`setDistortion`/`setDivider`/`play`/`silence`, the
  six `Distortion.*` settings, `Audctl.*` bits, and `Note`/`frequencyOf`/
  `setRegion`/`detectRegion` shaped exactly like `@8bitscript/c64/sid`. The
  AUDF tables are computed from POKEY's clock (machine clock ÷ 28) and
  clamp octaves 0-2 to 255, because the 8-bit divider on the 64 kHz clock
  does not reach below about 125 Hz — a stated limit, not a rounding.
- `src/random.8bs` (`@8bitscript/atari8/random`): `byte()`/`word()` over
  RANDOM (`$D20A`). Its own import, never folded into `./pokey`, per the
  root rule on hardware entropy.
- **Hardware** (the catalog in `package.json`): `model` — `800xl`
  (default), `65xe`, `130xe`, `1200xl`, `800`, `400` and `xegs` (the
  *console*) are run-only: each carries an atari800 model flag and its own
  facts (`input.joysticks` 4 on the 400 and 800, `memory.banked` on the
  130XE with `detect: @8bitscript/atari8/banks`), no `build` block at all,
  so every model links a byte-identical program and none of them appears in
  an output filename. `media` is the axis that changes the build:
  `xex` (default), `cart8`/`cart16`, `xegs32`-`xegs512`
  and `mega16`-`mega512`. Each cartridge value carries
  `build.output: rom`, its `__cart_rom_size` defsym, the matching atari800
  `-cart-type` in its `load`, and the facts a cartridge changes
  (`memory.ram` 6400, `storage.save` false); being the value that changes
  the build, it is the one in the output name
  (`main-atari8-xegs256-ntsc.rom`, `main-atari8-cart8-ntsc.rom`; a `.xex`
  is `main-atari8-<region>.xex`). A preset per model keeps `--profile
  130xe` working, and `--profile xegs` is now one value on each axis
  (`model: xegs, media: xegs256`), which is what it always meant.
  `mouse` (labeled *Pointing device*) — `none`, `st`, `amiga`, `trak`,
  `paddles`, `touch`, `koala`, `pen`, `gun`, `joy`, one per atari800 `-mouse`
  kind, and the fact each sets follows what the device is actually wired to:
  a mouse or Trak-Ball is quadrature on a joystick port's direction bits
  (`input.mouse`), paddles, a Touch Tablet and a Koala Pad are analogue on
  POKEY's POT lines (`input.paddles`), and a light pen or gun is ANTIC's
  PENH/PENV, which the fact sheet has no key for, so those set neither.
  `mouseport` — `1`-`4` (`-mouseport`), every value `tag: null` because it
  never changes the build and a file twin named `.atari8.2.8bs` would mean
  nothing. `stereo` — `off`/`on` (`-stereo`).
- `FRAME_SYNC.atari8` is a *level* driver polling ANTIC's VCOUNT
  (`$D40B < 64` for the top half, `>= 140` as the PAL probe), NTSC
  `262 × 114 / 1789790`, PAL `312 × 114 / 1773447`. It has no `presync`:
  a built program contains **no `sei`** (checked in the linked ELF), so
  the OS's VBI keeps running — its jiffy clock, keyboard, joystick shadows
  and color-shadow copy all stay alive under an 8BitScript program.
- `8bs run atari8` launches `atari800` with a copy of `~/.atari800.cfg`
  whose CRT-shader knobs are zeroed, the model's flag from the catalog
  (`-atari` for 800 and 400, `-xl` for 800xl and 65xe, `-xe` for 130xe,
  `-xegs`), `-ntsc`/`-pal`, a 3× window of the "tv" area, and `-run
  <file.xex>` — or, for `xegs`, the value's own `load`: `-cart <file.rom>
  -cart-type 23`, because a raw 256 KiB image matches eight of atari800's
  cartridge types and without the type it stopped at its "Select
  Cartridge Type" menu (verified below; fixed the day this file was
  written, in `run.mjs` and `screenshot.mjs` both). `8bs run atari8
  --screenshot` (macOS window capture, wall-clock `--frames` at a nominal
  60 Hz) takes the same flags.
- `8bs doctor` checks that both drivers and `atari800` exist; nothing
  checks for the OS ROMs atari800 needs (`docs/setup/atari8.md`).
- `packages/studio/AGENTS.md` lists `atari8` in Studio's full tier; nothing
  in Studio is Atari-specific yet.

There is no player/missile, no display-list, no character-set, no bitmap
and no storage API, no paddle or mouse layer, and no non-macOS screenshot
route — for this target or (mostly) for any machine. The four video layers
are blocked on one unsettled question, not on effort: see "A hardware
buffer needs an address the program can name" below, and settle that before
starting any of them. The rules below are what to hold that work to when it
comes.

## Facts verified here

Cite these freely; each was read in the source named or seen on screen
under atari800 7.1.2 (the Homebrew build, with the XL OS and OS-B ROM files
named in `~/.atari800.cfg` and atari800's bundled Altirra replacement ROMs
for anything else), not recalled. Rows citing **Altirra
HRM** were read in the Altirra Hardware Reference Manual (2026-01-02
edition, Avery Lee) — the one source here written against the silicon
rather than against Atari's 1981 documentation, and the one to trust when
it and an Atari manual disagree, because it says which it is contradicting
and why.

| Fact | Where |
| ---- | ----- |
| A `.xex` starts `FF FF`, then a segment `02E0-02E1` holding `_start` (RUNAD), then the main segment loaded at `$2000` up to `__data_end - 1`. The link script's RAM region is `$2000-$BFFF` (`LENGTH = 0xa000`), chosen against a MEMLO survey (DOS 2.0S/2.5/XE 1.0 `$1CFC`, SpartaDOS X 4.49 `$1DBA`; DOS 1.0 `$2A08` and SpartaDOS 1.1 are *not* supported). Its comment: RAM "can go higher to `$C000`" if BASIC is disabled, minus 993 bytes for the OS's text screen and display list, plus the C stack. | DOS `.xex` map (measured pre-0.2.0); `xxd` of a built `.xex` (`ff ff e0 02 e1 02 00 20 00 20 31 23`) |
| Imaginary registers are `$80-$9F`; the program's zero-page variables start at `$A0` (`ticks` in the borders build). | DOS link map (`__rc0 = $80`, `__rc31 = $9F`, measured pre-0.2.0) |
| DOS start-up (pre-0.2.0): `_start` sets the soft stack pointer `__rc0/1` to `MEMTOP ($02E5/$02E6) + 1`, calls `main`, then `exit` → `_Exit`, which is `jmp ($0A)` (DOSVEC). Nothing is printed, no CIO call is made and no character set is switched before `main`. A CIO `E:` `putchar` is not part of an 8BitScript program. | DOS start-up (MEMTOP+1 stack, `jmp ($0A)` on exit); linked `.xex` (pre-0.2.0: no `jsr $E4xx`, no `sei`) |
| XEGS cartridge: an 8K *fixed* bank always at `$A000-$BFFF` and `__cart_rom_size / 8 − 1` switchable 8K banks at `$8000-$9FFF`, selected by a write to `$D500-$D5FF`; sizes 32–512K, power of two, default 256. RAM for the program is `$0700-$1FFF` ("assume at most 8 KiB of RAM"). The vector at `$BFFA` is `_start`, `0` ("inserted"), `$04` (bit 2 = boot), `_cart_init`. The default `_cart_init` is weak and writes 0 to `$D500` "because on real hardware the XEGS bank selection is random". In the file the fixed bank comes **last**: the built image has `00 A0 00 04 16 A0` at offset `$3FFFA` and zeros at `$1FFA`. `.data`/`.bss` land at `$0700`. | XEGS cartridge map; `xxd` of the built `.rom` (pre-0.2.0) |
| Standard cartridge (`media=cart8`/`cart16`): 8K at `$A000` or 16K at `$8000`, same `$BFFA` vector, same `$0700-$1FFF` RAM. MegaCart/SIC! (`media=mega16`…`mega512`): 16–512K in 16K banks mapped over `$8000-$BFFF`, bank 0 at power-up, a 20-byte tail in bank 0 that shrinks RAMTOP (`$6A`) to `$80` if needed and writes `$20` to `$D500` for SIC! carts. | cartridge maps; `tail0.s` |
| atari800 cartridge types: 8K standard = type 1 at `$A000`; 16K = 2 at `$8000`; XEGS 32/64/128/256/512K = 12/13/14/23/24 (2–6 low bits of a `$D500` write pick the `$8000` bank); switchable XEGS = 33–37 (bit 7 disables); MegaCart 16–512K = 26–31 (bit 7 disables, low bits pick a 16K bank); SIC! 128/256/512K = 54/55/56 (`$D500-$D51F`). A raw image whose size matches more than one type is `CARTRIDGE_UNKNOWN`; the SDL build then opens the **"Select Cartridge Type"** menu and inserts nothing until a key is pressed. `-cart-type <0..160>` picks explicitly. | upstream `DOC/cart.txt`, `src/cartridge.c`, `src/ui.c`, `src/atari.c`; `atari800 -help` |
| The 256 KiB XEGS build, given to `atari800 -xegs -cart` without a type, shows that menu with eight candidates (XEGS 256 KB, MegaCart 256 KB, Switchable XEGS 256 KB, SIC! 256 KB, Super Cart 256 KB 5200, XE Multicart, Double Ram-Cart, J(atari)Cart). With `-cart-type 23` or `-cart-type 36` the borders program runs (`TICK n OPTION 0`, cell 0, teal on blue). The same program on `-xl` (800xl), `-xe` (130xe) and `-atari` (800, OS-B) runs the same way; the `65xe` and `400` profiles were not launched. | on screen (window capture), this project |
| `8bs run atari8 --screenshot` passes `'-run', outFile` unconditionally; with `--profile xegs` the captured window is the XL OS's blank blue screen with a cursor — the `.rom` was never inserted. | `packages/cli/src/screenshot.mjs` `atari8Screenshot()`, on screen |
| The same GTIA bytes render differently by region under atari800: the borders program's `BackgroundColor.CYAN` (`$A8`) is teal on `-ntsc` and green on `-pal`; `BorderColor.BLUE` (`$84`) is a darker blue on PAL. Hue values vary with TV standard (NTSC vs PAL), tint, and emulator palette. | on screen; Altirra HRM ch.6 |
| ANTIC (`$D400`): DMACTL, CHACTL, DLISTL/H, HSCROL, VSCROL, PMBASE, CHBASE, WSYNC, VCOUNT (read), PENH/PENV (read), NMIEN, NMIRES/NMIST. DMACTL boots as `$22` (DMA on, normal playfield, no P/M DMA, double-line P/M); playfield widths narrow/normal/wide are 32/40/48 bytes per line; bits 2/3 enable missile/player DMA, bit 4 single-line P/M, bit 5 display-list DMA. CHACTL `$02` at boot (inverse shown as reverse video; bit 2 flips characters upside down). NMIEN: `$80` DLI, `$40` VBI, `$20` RESET. | `_antic.h` |
| ANTIC's fourteen playfield modes, their scan-line heights, byte costs, pixel counts and color sources: the full table is in "The playfield" below, read from the Altirra manual and cross-checked against `_antic.h` and De Re Atari. Modifiers OR'd into a mode byte: `$10` HSCROL, `$20` VSCROL, `$40` LMS (two address bytes follow, low first), `$80` DLI. Non-mode instructions: `$00/$10/…/$70` = 1–8 blank lines, `$01` JMP, `$41` JVB (jump and wait for vertical blank); both jumps are three bytes and both cost a scan line. | `_antic.h`; Altirra HRM §4.4-4.6 |
| A display list may not cross a 1K boundary (only the low 10 bits of DLISTL/H increment); screen data wraps at a 4K boundary *within a scan line*, which an LMS cannot repair. A display list is valid over scan lines 8-248, 240 lines maximum — **the same on PAL**, whose extra 50 lines are all blank. | Altirra HRM §4.6 |
| Character sets: 1K, 128 glyphs, 1K-aligned for ANTIC modes `$2`-`$5`; 512 bytes, 64 glyphs, 512-aligned for `$6`/`$7`. CHBASE gives address bits 10-15 (from its bits 2-7) or 9-15 (bits 1-7); the unused bit is latched and comes back if the other kind of mode starts. PMBASE has the same shape: 1K-aligned for two-line P/M, 2K for one-line, bit 2 ignored but latched. | Altirra HRM §4.4, §4.13 |
| P/M area layout: eight sections of 128 bytes (two-line) or 256 (one-line); the **first three are unused by the hardware** and free for the program; missiles at `+$180`/`+$300`, players 0-3 at `+$200`/`+$400` and each section onwards. The strip index is the frame's vertical scan counter, so in one-line mode byte *n* is scan line *n*, and only 8-247 are ever fetched. | Altirra HRM §4.13; atari800 `antic.c` `pmg_dma()` |
| P/M sizes are `%00` ×1, `%01` ×2, `%11` ×4 and `%10` ×1 again — the shift state machine is `state' = (state + 1) AND size`. SIZEM packs all four missiles two bits each, missile 0 in bits 0-1. | Altirra HRM §6.5; atari800 `gtia.c` `PM_Width[4] = {1, 2, 1, 4}` |
| A color register ignores bit 0: 16 hues × 8 luminances = **128** distinct colors, not 256. The 256 figure is reachable only in GTIA mode 9, which bypasses the registers. | Altirra HRM §6.3 |
| POKEY's linked (16-bit) timers: AUDCTL bit 4 links 1+2, bit 3 links 3+4, the low channel's AUDF is the low byte — and the **high** channel (2 or 4) carries the combined period and is the one enabled for audio, the low one normally muted. Period is `(N+1)×28` on the 64 kHz clock, `(N+1)×114` on 15 kHz, `N+7` cycles on 1.79 MHz. | Altirra HRM §5.3 "Linked timers" |
| POKEY's mixed output saturates: it is near-linear only while the summed volume of *actively outputting* channels is ≤ 15; the rest of the 16-60 range adds only about double the amplitude. A channel stuck at a constant 1 with non-zero volume distorts everything else; a channel stuck at 0 costs nothing whatever its volume. | Altirra HRM §5.3 "Volume control" |
| With the high-pass filter off, channels 1 and 2 are digitally **inverted** relative to 3 and 4, so two identical pure tones on channels 1 and 2 add while the same on channels 1 and 3 cancel. Volume-only channels are exempt and always add. | Altirra HRM §5.3 "High-pass filter" |
| GTIA (`$D000`) writes: HPOSP0-3, HPOSM0-3, SIZEP0-3, SIZEM (0 = 1 color clock per pixel, 1 = 2, 3 = 4), GRAFP0-3, GRAFM (shape bytes used when P/M DMA is off), COLPM0-3, COLPF0-3, COLBK, PRIOR, VDELAY, GRACTL (bit 0 missiles, 1 players, 2 latch triggers), HITCLR, CONSOL. Reads: M0PF-M3PF, P0PF-P3PF, M0PL-M3PL, P0PL-P3PL (16 collision registers), TRIG0-3 (0 = pressed), PAL (`$D014`; header `1` PAL / `$E` NTSC, atari800 returns `$01`/`$0F`), CONSOL (bits 0/1/2 = START/SELECT/OPTION, active low). A color byte is `hue << 4 | lum << 1`. PRIOR: `$01/$02/$04/$08` pick one of four player/playfield orderings (set exactly one — none means players and playfields mix, more than one turns overlaps black), `$10` makes the four missiles a fifth player in COLPF3, `$20` ORs the colors of overlapping **P0+P1, P2+P3, M0+M1 and M2+M3 only**, `$40/$80/$C0` = GTIA modes 9/10/11 (pixels 2 color clocks wide, 80 per normal line: 16 luminances of COLBK's hue; 9 colors from COLPM0-3 + COLPF0-3 + COLBK; 16 hues at COLBK's luminance). | `_gtia.h`, upstream `gtia.c` |
| P/M DMA costs ANTIC 4 cycles per line for players plus 1 for missiles; CONSOL bit 3 drives the console speaker (`GTIA_speaker = !(byte & 0x08)`); GRACTL bit 2 clear re-arms the TRIG latches; HITCLR zeroes all 16 collision registers. | upstream `antic.c`, `gtia.c` |
| POKEY (`$D200`) writes: AUDF1-4, AUDC1-4, AUDCTL, STIMER, SKREST, POTGO, SEROUT, IRQEN, SKCTL. AUDC high bits pick the distortion: `$00` 5+17-bit poly, `$20` 5-bit, `$40` 5+4-bit, `$80` 17-bit, `$A0` pure tone, `$C0` 4-bit poly; `$10` = volume-only (the sample-playback bit); low nybble = volume. AUDCTL: `$01` 15 kHz base instead of 64 kHz, `$02`/`$04` high-pass 2-by-4 / 1-by-2, `$08` join 3+4 and `$10` join 1+2 into 16-bit channels, `$20`/`$40` clock 3 / 1 at 1.79 MHz, `$80` 9-bit instead of 17-bit poly (also changes RANDOM). IRQEN: timers 1/2/4, serial ×3, `$40` other key, `$80` BREAK. SKCTL: `$01` debounce, `$02` keyboard scan, `$04` fast pot scan, `$08` two-tone, `$80` force break. Reads: POT0-7, ALLPOT, KBCODE, RANDOM, SERIN, IRQST, SKSTAT (bit 2 last key still pressed, bit 3 SHIFT down, bit 5 keyboard overrun). | `_pokey.h` |
| atari800's RANDOM is a 17-bit (or 9-bit) poly-counter table indexed by a scanline counter plus the current cycle; its pot scan counts up over a frame (`pot_scanline` 0→228, `POTGO` restarts it; SKCTL bit 2 makes reads immediate). | upstream `pokey.c` |
| PIA (`$D300`): PORTA, PORTB, PACTL, PBCTL. Bit 2 of PxCTL selects data (1) or direction register (0). On the 400/800 PORTB is joystick ports 3 and 4; on XL/XE PORTB is memory control and `pia.c` returns it as such, never as sticks. PORTB bits: `$01` OS ROM in, `$02` BASIC ROM in, `$04/$08` 1200XL LEDs, `$80` self-test ROM at `$5000`; on the XE `$0C` picks one of four 16K banks, `$10` = CPU sees the bank at `$4000-$7FFF`, `$20` = ANTIC sees it. atari800: 128K bank = `((byte & 0x0c) >> 2) + 1`; 320K/576K/1088K reuse bits 1, 5–7. PACTL bit 3 is the cassette motor, PBCTL bit 3 the SIO command line. | Altirra HRM; atari800 `memory.c`, `pia.c` |
| OS locations: SAVMSC `$58`, RAMTOP `$6A`, RTCLOK `$12-$14`, ATRACT `$4D`, VDSLST `$0200`, VVBLKI `$0222`, VVBLKD `$0224`, SDMCTL `$022F`, SDLSTL/H `$0230/1`, GPRIOR `$026F`, PADDL0-7 `$0270`, STICK0-3 `$0278`, PTRIG0-7 `$027C`, STRIG0-3 `$0284`, PCOLR0-3 `$02C0`, COLOR0-4 `$02C4-$02C8`, RUNAD `$02E0`, INITAD `$02E2`, MEMTOP `$02E5`, MEMLO `$02E7`, CRSINH `$02F0`, CHACT `$02F3`, CHBAS `$02F4`, CH `$02FC`. Vectors: KEYBDV `$E420`, CIOV `$E456`, SIOV `$E459`, SETVBV `$E45C`, SYSVBV `$E45F`, XITVBV `$E462`. | `_atarios.h`, `asminc/atari.inc` |
| Timing in atari800: 114 CPU cycles per scanline (`ANTIC_LINE_C`), `STA WSYNC` resumes at cycle 106, 9 refresh cycles per line (`ANTIC_DMAR`), NMIST set at cycle 6 and the NMI taken at 12; NTSC 262 lines, PAL 312; FPS `59.9227434` / `49.8607597`; lines 8–247 are on screen and the VBI (`NMIST = $5F`) fires at line 248; VCOUNT is `ypos >> 1`. (So a frame is 29868 / 35568 cycles, and the constants imply a CPU clock of ~1789772.5 Hz NTSC / ~1773447 Hz PAL; the backend's 1789790 is the usually-quoted nominal figure — cite whichever you mean.) | upstream `antic.h`, `antic.c`, `atari.h` |
| The emulated CPU implements the unofficial 6502 opcodes (ASO/SLO, RLA, LAX, DCM/DCP, INS/ISC …) and the `JMP (addr)` page-wrap bug (a `CPU65C02` build define only removes the bug emulation). | upstream `cpu.c` |
| `atari800 -help` (7.1.2): models `-atari -1200 -xl -xe -320xe -rambo -576xe -1088xe -xegs -5200`; `-pal/-ntsc`; `-run <file>` (COM/EXE/XEX/BAS/LST); `-cart <file>` + `-cart-type <num>` (0..160), `-cart2`; `-H1..-H4 <path>` host directories as `H1:`–`H4:`, `-Hpath`, `-hreadonly/-hreadwrite` (needs the OS patch; `-nopatchall` kills `H:`); `-tape/-boottape`; `-mouse off|pad|touch|koala|pen|gun|amiga|st|trak|joy`, `-mouseport 1-4`, `-cx85`, `-multijoy`; `-stereo` (two POKEYs); `-xep80/-af80/-bit3` 80-column boards; `-record/-playback` input; `-screenshots <pattern>` is only a filename pattern for the hotkey — there is no exit-and-screenshot flag; `-monitor`, `-bpc`, `-label-file`. With no Atari 5200 ROM configured, `-5200` boots on atari800's bundled Altirra 5200 kernel (seen); the same fallback for the XL/XE OS (`-xl-rev altirra`) is listed in `-help` but this host has the real XL ROM, so it is *to verify*. | `atari800 -help`; on screen (5200) |
| Under `8bs run` the emulated 800XL, 130XE and 800 show the borders program at cell 0 in the top-left of the playfield, inside a border whose color is COLBK; the OS text screen sits below 24 blank lines and inside a normal-width (40-byte) playfield. | on screen |
| The catalog's stock fact sheet: grid 40×24 of 8×8 (ANTIC mode 2), 128 colors (GTIA's 16 hues × 8 luminances — a color register ignores bit 0; the 256 this row used to claim is GTIA mode 9 only), 2 per cell (one hue, two luminances), 128 glyphs per charset, no full block set (`video.blockWidth`/`Height` 0: ATASCII's control-graphics range is not a quarter-block set), bitmap, one layer with fine scroll; 4 players as the sprites (missiles are not counted), 4 per line, 8 pixels wide and as tall as the display (192 lines of per-line data), one color each; POKEY's 4 voices with a volume each, noise distortions, volume-only samples, no envelope or filter, `RANDOM` as a random source; keyboard, two ports on the XL/XE models, no pads; disk under DOS; 40960 bytes (`$2000`–`$BFFF`), nothing banked until `model=130xe`, no mouse until a `mouse` value. | `src/text.8bs`; the `.xex`/`link.ld`, ANTIC, GTIA and POKEY rows above; `package.json` (read) |
| `@8bitscript/atari8/banks` — `banks.kib()`: a marker in base RAM at `$4000`, then a marker of its own into each of the four banks bits 2–3 name (bit 4 clear so only the CPU sees them, bit 5 left alone so ANTIC keeps drawing base RAM, bits 0/1/7 left alone so the OS ROM, BASIC and self-test stay put), then base RAM read again. Still its own marker means the writes went elsewhere and the machine has extended RAM; the last bank's marker means there was only ever one RAM. Each bank is then read back so a mirror is not counted. atari800's `MEMORY_HandlePORTB` computes the 128 KiB bank as `((byte & 0x0c) >> 2) + 1` and runs the same code to no effect on a 64 KiB machine, which is what makes this work. Under atari800 the probe printed 64 KiB for `model=130xe` and 0 for `800xl`, `65xe` and `800` — including the 800, where PORTB is joystick ports 3 and 4 and the writes are harmless. Cost: `test/banks-probe.8bs` is 682 bytes of program with the probe and 531 with the answer written in — 151 bytes. | `src/banks.8bs`; atari800 `src/memory.c` (fetched 2026-09-05); four screenshots (ran); `test/banks.test.mjs` |
| The `.xex` link script's RAM region is a **literal** `ORIGIN = 0x2000, LENGTH = 0xa000` — there is no `PROVIDE` and no symbol to override, unlike the VIC-20's `__memory_expansion` or the PET's `__ram_size`. So a `400` or `800` value **cannot** cap the linked RAM with a `--defsym`, and the catalog does not pretend to: those values change the emulator's model and the joystick-port fact only. Capping RAM for a 16K 400 needs a link script this project supplies, which nothing does yet. | DOS `.xex` map (read, pre-0.2.0) |
| `atari8-cart-std/lib/link.ld` has **no** `PROVIDE(__cart_rom_size)` — only `ASSERT(__cart_rom_size == 8 \|\| __cart_rom_size == 16, ...)`. The standard-cartridge driver therefore cannot link at all without the defsym, where the XEGS (`PROVIDE(... = 256)`) and MegaCart (`= 512`) scripts have defaults. Every cartridge value in the catalog passes it explicitly for that reason. | the three cartridge `link.ld`s (read) |
| All fourteen `media` values link the borders example and produce exactly the size their name claims: `.xex` 830 bytes; `cart8` 8192; `cart16` 16384; `xegs32/64/128/256/512` 32768/65536/131072/262144/524288; `mega16`…`mega512` 16384…524288. `cart8`, `cart16`, `xegs256` and `mega128` were each launched and photographed running the program (teal playfield, blue border, `TICK n OPTION 0`) — so both newly-wired drivers work, not just the XEGS one. | `8bs build --target atari8 --hardware media=<v>` for all fourteen; four window captures (ran) |
| SKSTAT's keyboard bits are **active low**, settled on screen rather than from the header: with nothing pressed, `test/layers-probe.8bs` prints `SKSTAT 255`, so bit 2 (last key still held) and bit 3 (SHIFT held) are 1 when idle and 0 when true. POKEY names them last-key-pressed / SHIFT-pressed and states no polarity. In the same capture every input reads idle — `STICK 00000`, `CONSOL 000`, `KEY 255`, `HELD 0` — so no layer inverts a sense the wrong way. | `test/layers-probe.8bs` on screen (ran) |
| The Atari's own joystick masks are bit for bit the C64's: `JOY_UP_MASK` `$01`, `JOY_DOWN_MASK` `$02`, `JOY_LEFT_MASK` `$04`, `JOY_RIGHT_MASK` `$08`, `JOY_BTN_1_MASK` `$10`. That is why `@8bitscript/atari8/joystick` can export the same `Joystick.*` values as the C64 layer without either machine being fudged. | Atari OS / joystick masks (confirmed against the machine) |
| The KBCODE table is the Atari OS's: 61 codes, all under `$40`, with SHIFT `$40` and CTRL `$80` as masks OR-ed on and none `$FF`. `src/keys.8bs` is generated from that table and `test/layers.test.mjs` rechecks every value against it. | Atari OS KBCODE; `test/layers.test.mjs` (ran) |
| `#fact(input.joysticks)` really folds per model, end to end: the same `test/layers-probe.8bs` prints `PORTS 2` on a stock 800XL build and `PORTS 4` on `--hardware model=800`, and the IR for the two builds differs in the scan loop's bound. So the catalog's new per-model facts reach generated code, not just `8bs targets`. | two window captures (ran); `test/layers.test.mjs` |
| POKEY's clock is the machine clock ÷ 28 — 63921 Hz NTSC, 63337 Hz PAL from the nominal figures `FRAME_SYNC.atari8` uses — and an 8-bit AUDF on it reaches about 125 Hz at 255. So octaves 0-2 of the standard note numbering are **not playable** on the default clock (the tables clamp them to 255) and the top octave is coarse: NTSC A6 lands at 1775.6 Hz against 1760, about 15 cents sharp. Computed here from `clock / (2 * (AUDF + 1))`, the standard published relation — *to verify* on screen against a tone before anything depends on exact cents. | `src/pokey.8bs` (the tables are generated, not transcribed) |
| An ST/Amiga mouse or a Trak-Ball **is** the joystick as far as the port is concerned: atari800 signals its movement as quadrature on PORTA's direction bits, so a `joystick.scan()` of that port returns mouse motion. Shown here rather than reasoned about — `test/layers-probe.8bs` paints its border green only when every input reads idle, and under `--hardware mouse=st` it comes up **red** while `mouse=paddles` and `mouse=koala,mouseport=4` stay green, because paddles and a Koala Pad are on POKEY's POT lines and leave the stick bits alone. Put the two in different ports (`mouseport`), or do not scan the pointer's port as a stick. | three window captures (ran) |
| The layers cost what they say: `test/layers-probe.8bs`, which imports all six, is 1328 bytes of program and 11 bytes of RAM — screen, text, joystick, console, keyboard, POKEY and RANDOM together. A program that imports none of them links none of it. | `8bs run atari8` build line (ran) |

## The playfield: fourteen modes, and a display list that runs them

Everything in this section and the next was read in the **Altirra Hardware
Reference Manual** (2026-01-02 edition, Avery Lee) — chapter 4 for ANTIC,
chapter 6 for GTIA — and cross-checked against atari800's `antic.c`/`gtia.c`. Where that manual and an
older Atari document disagree, the disagreement is named rather than
smoothed over; it is the only source consulted here written against the
silicon rather than against the 1981 documentation. **None of this is
implemented** — it is the reference the four blocked video layers get
built from, once "A hardware buffer needs an address the program can name"
below is settled.

### The fourteen modes

Widths are the three DMACTL settings, which share a center: narrow is 128
color clocks, normal 160, wide 192 — of which only 178 are visible, ANTIC
clipping 12 color clocks off the left and horizontal blank taking two off
the right. A color clock is half a machine cycle, so a 228-color-clock
scan line is the familiar 114 cycles. "Across" and the byte counts below
are at **normal** width.

| ANTIC | GR. | Kind | Scan lines | Bytes/line N/n/W | Across | Colors | Where the color comes from |
| ----- | --- | ---- | ---------- | ---------------- | ------ | ------- | --------------------------- |
| `$2` | 0 | char | 8 | 32 / 40 / 48 | 40 chars | 1 hue, 2 lum | hi-res: the whole playfield is COLPF2's *hue*, and a 1 bit substitutes COLPF1's *luminance*. Bit 7 of the code is an attribute (inverse/blank) via CHACTL, not a ninth glyph bit |
| `$3` | — | char | 10 | 32 / 40 / 48 | 40 chars | 1 hue, 2 lum | as `$2`. Codes `$60-$7F` display glyph rows 2-9 instead of 0-7 — that is where descenders come from, and their glyph data must be stored **out of order**, because rows 2-7 appear above rows 0-1. No OS support |
| `$4` | 12 | char | 8 | 32 / 40 / 48 | 40 chars, 4 px each | **5** | bit pairs across a 4×8 glyph: 00 = COLBK, 01/10/11 = COLPF0/1/2 — *unless* bit 7 of the character code is set, when 11 gives COLPF3 instead. That bit is what makes it five colors, not four |
| `$5` | 13 | char | 16 | 32 / 40 / 48 | 40 chars, 4 px each | 5 | as `$4` with every scan line doubled. Character *data* is still fetched on every line, so it costs what `$4` costs |
| `$6` | 1 | char | 8 | 16 / 20 / 24 | 20 chars | 5 | **64 glyphs only**: the code's top two bits pick COLPF0-3 for that character's 1 bits; 0 bits are always COLBK. One color per character, chosen from four |
| `$7` | 2 | char | 16 | 16 / 20 / 24 | 20 chars | 5 | as `$6`, scan lines doubled, character data re-fetched every line |
| `$8` | 3 | map | 8 | 8 / 10 / 12 | 40 px | 4 | bit pairs: 00 = COLBK, 01/10/11 = COLPF0/1/2. Each pixel is 4 color clocks wide |
| `$9` | 4 | map | 4 | 8 / 10 / 12 | 80 px | 2 | one bit: COLBK or COLPF0 |
| `$A` | 5 | map | 4 | 16 / 20 / 24 | 80 px | 4 | bit pairs, as `$8` |
| `$B` | 6 | map | 2 | 16 / 20 / 24 | 160 px | 2 | one bit, as `$9` |
| `$C` | 14 | map | 1 | 16 / 20 / 24 | 160 px | 2 | one bit, as `$9` |
| `$D` | 7 | map | 2 | 32 / 40 / 48 | 160 px | 4 | bit pairs, as `$8` |
| `$E` | 15 | map | 1 | 32 / 40 / 48 | 160 px | 4 | bit pairs, as `$8` |
| `$F` | 8 | map | 1 | 32 / 40 / 48 | 320 px | 1 hue, 2 lum | hi-res, exactly as `$2` but straight from bitmap data. The base for the three GTIA modes |

Bit 7 of every playfield and glyph byte is the **leftmost** pixel, and in
the multicolor modes a bit pair is ordered as in a CPU integer, so PF1 in
the second pixel of a byte is `xx10xxxx`.

Full-screen cost, derived from the table for the OS's 192 scan lines at
normal width: modes `$2` and `$4` 960 bytes, `$3` 760 (19 mode lines — ten
scan lines does not divide 192), `$5` and `$6` 480, `$7` and `$8` 240,
`$9` 480, `$A` 960, `$B` 1920, `$C` and `$D` 3840, `$E` and `$F` 7680.

**192 is the OS's convention, not the machine's.** A display list is valid
from scan line 8 to 248 — 240 lines — and ANTIC suspends one that runs
long at 248 and resumes at line 8 of the next frame. That range is **the
same on PAL**: PAL's extra 50 lines are all blank, so a PAL build gets a
slower frame rate and no more picture.

The GR. column is the *OS's* numbering, and GR.12-15 exist only in the
XL/XE OS — a 400/800 cannot ask for them by number. The ANTIC modes
themselves are the same silicon on every model, so a program that builds
its own display list has all fourteen everywhere, and should never route
through a GRAPHICS call to get them.

Three things a portable layer has to know, none of them obvious:

- **`$4`/`$5` are the four-color *character* modes, and they are five
  colors.** A color-per-cell text surface on this machine means picking
  mode `$4` at build time. It is the closest thing the Atari has to the
  C64's color RAM, and it is not close: the color varies per *pixel pair
  inside the glyph*, and the fifth color is a per-character attribute
  bit, so "set cell 40 to red" is not an operation this hardware has.
- **`$6`/`$7` do give one color per character** — the top two bits of the
  code — at the cost of half the columns and three quarters of the
  character set. A 20-column colored text mode is a real option for a
  menu or a HUD, and costs 480 bytes.
- **Modes `$3`, `$5` and `$7` are the expensive ones.** ANTIC's 48-byte
  line buffer holds character *names* only, so a double-height character
  mode re-fetches glyph data on every scan line and buys nothing back.

### The display list

The display list is a program of one- and three-byte instructions, one per
mode line, that ANTIC fetches through DLISTL/DLISTH and executes until a
jump sends it elsewhere. ANTIC does not remember where the list started:
it must loop with a JVB (`$41`) or be restarted by the CPU.

- Instruction byte: bits 0-3 the mode (`$0` blank, `$1` jump, `$2`-`$F` a
  mode line), bit 4 HSCROL, bit 5 VSCROL, bit 6 LMS, bit 7 DLI. In a blank
  instruction bits 4-6 are the count, so `$00`, `$10` … `$70` are 1-8
  blank scan lines.
- **A display list may not cross a 1K boundary.** DLISTL/DLISTH is a
  6-bit and a 10-bit field, and only the low 10 bits increment, so a list
  running off the top of a 1K block wraps to the bottom of the *same*
  block — in the middle of a three-byte instruction, if that is where it
  lands. Jump instructions are exempt and can target anything. This is a
  layout constraint on the buffer, and it is why a display-list layer
  cannot simply allocate an array.
- **Screen memory wraps at 4K within a scan line, and LMS cannot fix it.**
  An LMS reloads the memory-scan counter at the *start* of a mode line
  only; if a scan line crosses a 4K boundary it wraps to the bottom of
  that 4K block mid-line. The OS's answer is to offset the whole screen
  buffer so the 4K boundary falls exactly between two lines. Any mode
  needing more than 4K — `$E` and `$F` at 7680 bytes — must do the same,
  and needs at least one mid-screen LMS as well.
- Writing DLISTL/DLISTH is live: the next fetch uses the new value.
  Doing it mid-frame risks ANTIC executing arbitrary memory as a display
  list, and a stray `$C1` there sets a DLI on every scan line until
  vertical blank. Change the pointer with display-list DMA off or during
  vertical blank, and never one byte at a time.
- A mode line that runs past scan line 248 is **truncated**, and if it
  carried a DLI that interrupt never fires, because its last scan line
  never happens. A display list that overruns is therefore not just too
  tall — it silently loses the handler at the bottom of the screen.

### Scrolling, and what it costs

- **HSCROL** (`$D404`, 0-15 color clocks) shifts the lines whose
  instruction carries bit 4. It is not free: enabling it **steps the fetch
  width up one level** — a narrow line fetches a normal line's bytes, a
  normal line fetches a wide line's — so the data must be laid out at the
  wider pitch, and the extra DMA cycles come out of the CPU. Wide lines do
  not step up. A hi-res mode can only be scrolled in *pairs* of pixels,
  because HSCROL has color-clock precision and a hi-res pixel is half of
  one.
- **VSCROL** (`$D405`) sets the *starting* scan line of the first mode
  line whose instruction carries bit 5, and the *ending* scan line of the
  first mode line after the region, where the bit goes back to 0. Three
  scrolled mode-`$2` lines therefore occupy `(8 − VSCROL) + 8 +
  (VSCROL + 1)` = 17 scan lines, not 24. A vertically scrolled region is a
  pair of half-height lines with whole ones between them, and a layer that
  does not model that will lose a row.
- A **DLI** (bit 7) fires at the beginning of the mode line's **last**
  scan line, which is why a handler changes what the *next* line looks
  like. ANTIC pulls NMI at cycle 8; the earliest a handler can run is
  cycle 17, and going through the OS's `VDSLST` dispatch costs 11 cycles
  more. NMIST bit 7 is the DLI flag and bit 6 the VBI flag, and the two
  are mutually exclusive — a handler tests bit 7, then bit 5 for RESET,
  and assumes VBI otherwise. A DLI can also be **polled** on NMIST rather
  than taken as an interrupt, which is worth remembering on a machine
  whose OS owns the NMI vector.

### Character sets

Resolved, and no longer a lead: **modes `$2`-`$5` use a 1K set of 128
glyphs aligned to 1K; modes `$6`/`$7` use a 512-byte set of 64 glyphs
aligned to 512 bytes.** CHBASE (`$D409`) supplies address bits 10-15 from
its bits 2-7 in the 1K modes, and bits 9-15 from its bits 1-7 in the
512-byte modes. Bit 1 is therefore ignored by the 1K modes but still
latched, and becomes live if a 512-byte mode starts without CHBASE being
rewritten — the same trap PMBASE has. A change to CHBASE takes effect two
cycles later. The low three bits of a glyph address are the row, so each
glyph is 8 contiguous bytes, top row first.

CHACTL (`$D401`) bit 1 shows codes with bit 7 set as inverse video, bit 0
blanks them — so *blinking* is software toggling bit 0 — and both together
give inverted spaces. Those two bits work **only in modes `$2`/`$3`**; in
`$4`-`$7` bit 7 means something else or nothing. Bit 2, vertical
reflection, flips every character upside down in *all* character modes,
and makes nonsense of mode `$3`'s descenders.

### The three GTIA modes

Setting PRIOR bits 6-7 to something other than `00` reinterprets the
playfield as two-color-clock pixels of four bits each — 80 pixels across
at normal width, 40 bytes a line, 7680 bytes for 192 lines: the same
memory as mode `$F`, because it *is* mode `$F` underneath.

| PRIOR[7:6] | GR. | What a 4-bit pixel means |
| ---------- | --- | ------------------------ |
| `$40` | 9 | 16 **luminances** of COLBK's hue. The one place the machine reaches 256 distinct colors, because it bypasses the color registers and their ignored low bit. COLBK's luminance is normally 0 — it is OR'd into the pixel value and eats shades otherwise |
| `$80` | 10 | 9 colors, and **not** a linear map: `0000`-`0011` are COLPM0-3, `x100`-`x111` are COLPF0-3, `10xx` is COLBK. The player registers are shared with the actual players |
| `$C0` | 11 | 16 **hues** at COLBK's luminance, except pixel value `0000`, which is forced to luminance 0. COLBK's hue is normally 0 for the same OR'ing reason |

- **They only work properly over the hi-res modes `$2`, `$3` and `$F`** —
  which does include the two *character* modes, so a 9- or 16-color
  **tiled** playfield is available and is not an OS mode. Over a low-res
  mode the ANx bus encoding differs and pixel values go missing (mode
  `$E` yields only 9 of the 16).
- Mode 10 is displayed one color clock late, pushing the right border of
  a narrow or normal playfield out by one; its border regions render as
  player 0 rather than background, so missiles and players 1-3 are
  normally invisible in the border.
- Only **even** HSCROL values scroll a GTIA mode correctly: GTIA pairs
  bits relative to horizontal blank and knows nothing of ANTIC's scroll
  offset, so an odd value re-pairs the bits instead of shifting them.
- **A CTIA machine has no GTIA modes at all** — PRIOR bits 6-7 are
  ignored and the screen shows plain mode `$F`. The difference in
  playfield-collision behavior is the documented way to tell the two
  chips apart at run time.
- On PAL, alternating mode 9 and mode 11 lines blends chroma across scan
  lines into a pseudo-256-color display — a PAL-only artefact. On a
  SECAM FGTIA, mode 9 loses its lowest luminance bit entirely.

## Players and missiles: eight objects, and none of them is a sprite

Four **players**, 8 bits wide, and four **missiles**, 2 bits wide. Every
one of them is a **full-height vertical strip**: the object exists on
every scan line of the frame, and the byte at offset *n* in its strip is
what shows on scan line *n*. That single sentence is the whole model, and
everything below follows from it.

### There is no vertical position register

Horizontal position is one write. Vertical position is **moving the bytes
inside the strip** — there is no Y register anywhere in ANTIC or GTIA, and
re-pointing PMBASE cannot substitute for one because of its alignment
rules. The only hardware assist is VDELAY, worth exactly one scan line and
only in two-line resolution.

This inverts every intuition a C64 or NES programmer has. On those
machines a sprite is a small object with an (x, y) and the scarce resource
is *sprites per scan line*. Here every object is on every line already, so
"objects per line" is a constant **4** (plus a fifth built from the
missiles), and the scarce resource is **vertical RAM movement**: a
16-pixel-tall shape moved down one pixel is a 16-byte memmove, per object,
per frame.

### The memory layout

PMBASE (`$D407`) names the area, and the alignment depends on the
resolution chosen by DMACTL bit 4:

| DMACTL bit 4 | Resolution | Alignment | Section size | Missiles | P0 | P1 | P2 | P3 |
| ------------ | ---------- | --------- | ------------ | -------- | -- | -- | -- | -- |
| 0 | two-line (each byte shown on 2 scan lines) | **1K** | 128 B | `+$180` | `+$200` | `+$280` | `+$300` | `+$380` |
| 1 | one-line (a byte per scan line) | **2K** | 256 B | `+$300` | `+$400` | `+$500` | `+$600` | `+$700` |

- PMBASE supplies address bits 10-15 from its bits 2-7 in two-line mode,
  and bits 11-15 from its bits 3-7 in one-line mode — where **bit 2 is
  ignored but still latched**, and becomes live again if the program
  switches back to two-line without rewriting PMBASE. CHBASE has the same
  trap.
- The **first three sections are unused by the hardware** — 384 bytes in
  two-line mode, 768 in one-line — and are free for the program. On a
  machine with a 40K budget that is not a rounding error, and any P/M
  layer should hand them back.
- The strip index is ANTIC's vertical scan counter, which counts from the
  top of the *frame*, not the top of the picture. Displayable lines are
  8-247, so in one-line mode **byte *n* is scan line *n***, and the first
  and last 8 bytes of every section are never fetched at all. In two-line
  mode the index is the counter shifted right one, so byte *n* covers scan
  lines *2n* and *2n+1*.
- The OS's 24-line text screen starts at scan line 32, so a player byte
  aligned with the top of that playfield is byte 32 (one-line) or 16
  (two-line).

### Position and size

- HPOSP0-3 (`$D000-$D003`) and HPOSM0-3 (`$D004-$D007`) hold the object's
  **left edge in color clocks**. A scan line is 228 color clocks; the
  visible window is `$22-$DD`, the center is the `$7F`/`$80` boundary. A
  normal-width playfield occupies `$30-$CF`, narrow `$40-$BF`, wide
  `$2C-$DD` — so **an object can be positioned outside even a wide
  playfield**, in `$22-$2B`, and still be seen.
- Size is two bits per object: `%00` one color clock per bit, `%01` two,
  `%11` four — and `%10` behaves as single width, because the shift state
  machine is literally `state' = (state + 1) AND size`. atari800 encodes
  the same thing as `PM_Width[4] = {1, 2, 1, 4}`. Objects grow to the
  **right**, since only the left edge is positioned.
- SIZEP0-3 are one register each; SIZEM (`$D00C`) packs all four missiles
  into one byte, two bits each, missile 0 in bits 0-1 up to missile 3 in
  bits 6-7.
- One player bit at normal size is **one color clock** — the same width
  as a pixel in the 160-across modes (`$B`-`$E`), and twice the width of a
  hi-res pixel in mode `$2`/`$F`. So a player is exactly as coarse as a
  four-color bitmap and half the resolution of the text mode it sits on.
  "Low resolution" is accurate, and it is a fixed property: there is no
  high-resolution player.
- The shift registers run continuously, across horizontal and vertical
  blank. An object placed partly off-screen is **clipped, not wrapped**
  (unlike the 2600's TIA). Moving HPOS mid-line can make an object appear
  twice, or not at all — the comparator only triggers on the left edge.

### Feeding the strips

Two routes, and a runtime must pick one and say which:

- **ANTIC DMA** from PMBASE. Both sides must agree: DMACTL bit 2
  (missiles) and bit 3 (players) tell ANTIC to fetch — and bit 3 turns
  missile fetching on as well — while GRACTL (`$D01D`) bits 0 and 1 tell
  GTIA to accept. The two mismatches fail differently, and neither fails
  quietly: **GRACTL on with DMACTL off** loads the players with whatever
  the CPU happened to have on the bus during cycles 2-5, and if ANTIC's
  P/M DMA is off entirely, GTIA mistakes the first halted cycle of
  horizontal blank for the missile fetch and reads a *display-list
  instruction* as missile data. **GRACTL off** simply leaves the graphics
  registers holding their last value.
- **The CPU writing GRAFP0-3 (`$D00D-$D010`) and GRAFM (`$D011`)** with
  DMA off, per scan line, which is the 2600-style racing-the-beam route
  De Re Atari / Altirra compare to the 2600. Because the registers hold their last
  value, one write can also be left standing deliberately — GTIA reuses
  the pattern on every scan line, so a vertical bar costs no RAM and no
  DMA at all. It is also why an *abandoned* player becomes a full-height
  stripe down the screen.

DMA costs 1 ANTIC cycle per scan line for the missiles (cycle 0) and 4 for
the players (cycles 2-5), and — correcting the original Atari Hardware
Manual — **two-line resolution costs exactly the same as one-line**; the
resolution bit changes addressing only, never timing. DMACTL's P/M enable
bits must be written at least 2 cycles before the scan-line boundary to
take effect on that line.

VDELAY (`$D01C`, one bit per object: missiles in bits 0-3, players in bits
4-7) does not delay anything. It **suppresses the DMA load on even scan
lines**. In two-line resolution that shifts the object down exactly one
line, which is the whole point; in one-line resolution it merely halves
the object's vertical resolution. It has no effect on CPU writes to the
GRAF registers.

### Color, and the two ways to get more of it

One color register per player — COLPM0-3 (`$D012-$D015`) — and a missile
takes its own player's color. There are exactly two hardware routes past
"one color per object", and the user-facing folklore compresses both:

- **PRIOR bit 4, the fifth player.** All four missiles switch to COLPF3
  and take PF3's priority. They keep independent positions and sizes —
  nothing groups them — so using them as one 8-bit object means moving
  four registers in step yourself. It does not change collisions at all,
  and each missile still reports its own. A program can also take the
  color change alone and leave the missiles scattered.
- **PRIOR bit 5, multi-color players.** The pairs that blend are
  **P0+P1, P2+P3, M0+M1 and M2+M3 — and only those**. Where a blended pair
  overlaps, the output is the bitwise OR of the two color registers, so
  the third color is chosen by picking register values whose OR is the
  color wanted, not by setting it. Overlapping any *other* pair (P0 and
  P2, say) produces **black**, not a blend. This is the mechanism behind
  "overlay two sprites for a multicolored sprite", and it is a two-object
  pairing, not a free-for-all.

Priority itself is PRIOR bits 0-3, and exactly one of them should be set:

| PRIOR[3:0] | Top to bottom |
| ---------- | ------------- |
| `0001` | P0 P1 P2 P3 · PF0 PF1 PF2 PF3 · BAK |
| `0010` | P0 P1 · PF0 PF1 PF2 PF3 · P2 P3 · BAK |
| `0100` | PF0 PF1 PF2 PF3 · P0 P1 P2 P3 · BAK |
| `1000` | PF0 PF1 · P0 P1 P2 P3 · PF2 PF3 · BAK |

With **no** bit set, the cross-disable logic switches off and PF0/PF1 mix
with P0/P1 and PF2/PF3 with P2/P3, ORing their colors. With **more than
one** bit set, the logic disables more than it enables and many overlaps
output **black — including over the background**. A layer that exposes
priority must therefore take one of four values, not a bit mask.

### Collisions are hardware, and they are cheap

Sixteen read-only registers at `$D000-$D00F` — the same addresses the
HPOS, SIZE and GRAF registers occupy for *writing* — four significant bits
each, 60 meaningful bits in total:

- `$D000-$D003` M0PF-M3PF, `$D004-$D007` P0PF-P3PF — each missile and
  player against playfields PF0-PF3.
- `$D008-$D00B` M0PL-M3PL — each missile against all four players.
- `$D00C-$D00F` P0PL-P3PL — player against player; the self-collision bit
  is always 0, and a collision sets a bit in *both* registers, so three
  overlapping players report six bits.

What the hardware will not tell you:

- **Nothing collides with the background.** Only PF0-PF3 register, so an
  object over COLBK reads as clear.
- **There is no missile-to-missile collision at all.**
- In the hi-res modes (`$2`, `$3`, `$F`) a 1 bit counts as PF2 and the two
  pixels of a color clock are OR'd together; 0 bits register nothing,
  even though they are drawn in a visible color.
- GTIA modes 9 and 11 register **no** playfield collisions; mode 10
  registers them for its PF-coded pixels only.
- Detection happens where the beam is, so a collision is only true once
  that line has been drawn: **read the registers after the display and
  before HITCLR**, which in practice means at the top of the vertical
  blank. Color registers play no part — two objects in the same color
  still collide, which is how invisible trigger objects are built.

Writing HITCLR (`$D01E`) clears all sixteen at once.

## From the sources, not verified here

Each of these comes from the document named and is a lead to confirm the
first time code depends on it.

**`storage.kib` is 86 on the stock sheet.** A single-density Atari DOS 2
floppy is 720 sectors of 128 bytes; the boot sectors, the VTOC and the
directory take 13 of them, leaving 707 free sectors that hold 125 bytes of
payload each — 88375 bytes, 86 KiB rounded down. Every cartridge `media` value says 0 instead —
there is nowhere to write. The figure is **recalled, not measured in this
project**: the Commodore drives' capacities were taken by formatting an
image with `c1541` and reading the free blocks back, and no equivalent was
run here. *To verify* by booting DOS 2.0S under atari800 and reading the
free-sector count off the directory.

**Which HPOS values are visible.** *Resolved* — the visible window is
`$22-$DD` of a 228-color-clock line, and a normal-width playfield is
`$30-$CF`. See "Position and size" above. atari800's `$22`/`$BE` clipping
is its own internal geometry and is not the number to hardcode.

**Character-set and P/M alignment.** *Resolved* — 1K/512-byte character
sets and 1K/2K P/M areas, with the ignored-but-latched low bits named, in
"Character sets" and "The memory layout" above. What is still open is
where the ROM character set lives: `$E000-$E3FF` on the XL OS is the usual
claim and is *to verify*.

**Per-mode DMA cost.** *Mostly resolved.* Playfield fetches come in three
rates — one per 2 cycles for modes `$2`-`$5`/`$D`-`$F`, one per 4 for
`$6`/`$7`/`$A`-`$C`, one per 8 for `$8`/`$9` — loading 8/16/32 bytes
narrow, 10/20/40 normal, 12/24/48 wide, which is where the table above
comes from. The display-list fetch is 1 cycle (3 for an LMS or a jump) on
the first scan line of a mode line, memory refresh is 9 cycles a line, and
the whole line is 114. The published end-to-end figures are that the CPU
gets **92%** of the machine with the screen off and **64%** under a
standard mode-`$2` display; the equivalent figure for a mode `$F` bitmap
is *not* published, and the arithmetic suggests it is slightly *better*
than mode `$2` — mode `$2` re-fetches 40 bytes of glyph data on all eight
of its scan lines, while a mode `$F` line fetches its 40 bytes once. Worth
measuring rather than assuming, and worth remembering that a narrow
playfield is a real speed-up.

**Attract mode.** ATRACT (`$4D`) counts up in the VBI and after roughly
nine minutes without a key the OS starts cycling the colors through
COLRSH/DRKMSK; a joystick-only game must zero ATRACT each frame. The
duration is *to verify*; the flag's existence is in `_atarios.h`.

**Keyboard codes.** *Resolved* — the table is the Atari OS KBCODE set and is
now a verified row above; `src/keys.8bs` is generated from it. What remains
unverified is the *auto-repeat*: the OS's VBI repeats a held key into CH
after a delay, so `keyboard.key()` fires again on its own. The delay and
rate are in the OS manual and are *to verify* before a menu depends on
them.

**Model RAM.** 400 = 8K (16K later), 800 = up to 48K, 1200XL/800XL/65XE =
64K, 130XE = 128K: from the machines' own manuals, *to verify*. What
atari800's `-atari` sets `MEMORY_ram_size` to is also *to verify*
(`-5200` sets 16, `-xegs` 64 — read in `atari.c`).

**Standard cartridge start sequence.** The `$BFFC` byte and `$BFFD` flags
(bit 7 diag, bit 2 boot after init, bit 0 disk boot) are the OS manual's;
a typical cartridge writes `0, $04`. *To verify* what the OS does with bit 0 clear.

**ST mouse / trackball / paddles.** atari800 feeds the ST and Amiga
mouse as quadrature codes on the stick bits of PORTA and the trackball as
direction/toggle bits (`input.c`), i.e. the program decodes movement itself
at a high poll rate; paddles are POT0-7 (0–228, `INPUT_mouse_pot_min = 1`,
`_max = 228`) with the buttons on stick bits; the light pen is PENH/PENV
with offsets `42`/`2`. The hardware protocols behind those codes are *to
verify* in the ST/Trak-Ball documentation.

## Corrections to what the repository says

- **`docs/setup/atari8.md`**: the old "XEGS, which loads as a cartridge
  instead (`-cart <file.rom>`)" launch stopped at atari800's "Select
  Cartridge Type" menu. Fixed: every cartridge value in the catalog now
  carries its own `-cart-type`, and the page has been rewritten around the
  `model` × `media` split with a table of all fourteen media values.
- **`packages/cli/src/screenshot.mjs`** used to hardcode `-run`; it now
  takes the catalog's `load` for the value, as `run.mjs` does. Fixed.
- An earlier setup page said a profile only changes which start-up
  runs and which atari800 model `8bs run` launches. The *media* axis — not
  the model — changes the load address, the RAM budget (6400 bytes, not
  40960), the image size and whether the program can save at all.
- **`packages/compiler/src/mos`'s `FRAME_SYNC.atari8` comment** says the
  Atari clocks could not be re-derived. atari800's own constants give
  `59.9227434 × 262 × 114 = 1789772.5` and `49.8607597 × 312 × 114 =
  1773447`; the NTSC figure differs from the backend's 1789790 by ten
  parts per million. Either is fine for pacing; cite the one you mean.
- **`packages/atari8/src/screen.8bs`** says its color names are "not
  visually verified under atari800". They are now — on NTSC, `BLUE`
  border and `CYAN` background read as their names; on PAL the same
  `CYAN` byte is green. Keep the names, but never describe a GTIA byte as
  a color without saying which region.
- **`package.json`'s `video.palette` said 256.** It is **128**: GTIA
  ignores bit 0 of every write to a color register, so the palette is 16
  hues × 8 luminances. The 256 figure is real but belongs to GTIA mode 9
  alone, which bypasses the registers and feeds pixel data straight to the
  luminance output — and a SECAM FGTIA cannot even do that. Changed to
  128. The fact's own definition is "colors the display can show at
  once", and 128 is defensible for this machine only because a DLI can
  rewrite the registers every scan line; **without** per-scanline work the
  honest number is 9 — COLPM0-3, COLPF0-3 and COLBK — or 16 in GTIA modes
  9 and 11. No code reads this fact today; when something does, that gap
  is what it will have to reckon with.
- **The old ANTIC-modes row called mode `$4` a four-color mode.** It is
  five: bit 7 of a character code swaps COLPF3 in for COLPF2. Same row
  described modes `$6`/`$7` as "2-color-per-character", which understates
  them — the character code's top two bits choose among COLPF0-3, so the
  mode has five colors and each character picks one. Both fixed in the
  new table.

## What people say about this machine, and what is actually true

These are the claims this project has actually been told about the Atari,
by people who know the machine. Each is close enough to be worth repeating
and wrong enough to build the wrong API from, so each is answered here
with the correction rather than filed away as folklore. Do not "fix" one
of these back to its popular form.

- **"There are 8 sprites."** Four players and four missiles — 8 *objects*,
  not 8 of one thing. Players are 8 bits wide, missiles 2, and a missile
  is not a small player: it has no color register of its own, and the
  four of them share one shape register and one size register.
- **"Sprites span the full height of the screen."** True, and it is the
  defining fact. See "Players and missiles" above: it makes objects-per-
  scan-line a constant 4 rather than a budget, and it turns vertical
  movement into a memory operation.
- **"You can only move them left and right; to move up and down you change
  the pixel definition in RAM."** Exactly right, and there is no way
  around it — no Y register, and PMBASE's alignment rules rule out
  re-pointing it as a cheap substitute. The single exception is VDELAY,
  worth one scan line in two-line resolution.
- **"They're low resolution and monochrome."** Right on both counts, and
  worth being precise about: one bit is one color clock — as coarse as a
  160-wide bitmap pixel, twice as coarse as a mode `$2`/`$F` pixel — and
  one color register covers the whole object. SIZEP can widen a bit to
  two or four color clocks, but nothing makes it narrower.
- **"Players are 8px wide, missiles 2px."** 8 *bits* and 2 *bits*. At
  default size those are 8 and 2 color clocks; at quadruple size the same
  player is 32 color clocks wide, a fifth of a normal playfield, still
  8 pixels of shape.
- **"Or combine missiles with players."** The real mechanism is PRIOR bit
  4: all four missiles turn COLPF3 and become a "fifth player". They are
  not joined — each keeps its own position and size, and moving them as
  one object is four register writes you make yourself.
- **"You can overlay more than one sprite to get multicolored sprites."**
  Real, but restricted, and this is the correction that most changes an
  API: PRIOR bit 5 blends **only** P0+P1, P2+P3, M0+M1 and M2+M3. The
  third color is the bitwise **OR** of the two color registers — you
  choose it by choosing register values, not by setting it. Overlap any
  other pair and the result is **black**. So "a multicolored sprite" is a
  *specific pair* of players spending two of your four objects, and a
  program can afford at most two of them.
- **"4-channel audio, square or noise."** Four channels, yes. But "square
  or noise" is three settings out of six: a channel is a divide-by-N
  counter feeding either a plain square wave, one of three polynomial
  noise generators, or a square/noise gated by the 5-bit polynomial, which
  is where the machine's characteristic rough tones come from. Two of the
  eight encodings are duplicates.
- **"Also PCM audio."** Volume-only mode, AUDC bit 4: the channel's output
  is forced high and only the 4-bit volume nybble is heard, so the CPU
  writes samples one at a time. 4 bits per sample, no DMA anywhere in the
  chip, and the timing has to come from a POKEY timer IRQ or a counted
  loop. It is a real capability that costs the whole CPU.
- **"You can combine two 8-bit channels into a 16-bit channel."** True —
  AUDCTL bit 4 links 1+2, bit 3 links 3+4, low channel's AUDF is the low
  byte. The part that is easy to get backwards: it is the **high** channel
  (2 or 4) that carries the combined period and is the one to enable for
  audio, and the low channel is normally muted. Linking is worth doing
  with the 1.79 MHz clock, which is the only combination that buys real
  pitch resolution rather than just a lower floor.

## Rules for this target

### Model, media and region are three axes, not one option

- **The split is done; keep it.** `model` decides the atari800 flag, the
  joystick-port count and the model's own facts, and carries **no** `build`
  block — every model links the same program. `media` decides the driver,
  `__cart_rom_size`, the load address, the `load` flags and the persistence
  story. Region is a separate flag already. A new machine goes on `model`, a
  new cartridge board on `media`, and nothing goes on both. Give a cartridge
  value its `__cart_rom_size` defsym and the matching atari800 `-cart-type`
  in the same entry — a raw cartridge image has no header and the emulator
  cannot guess its type; the std script has no default for the size at all.
- A `.xex` links every model identically (verified). That is honest for 64K
  machines, and on a 16K 400 it is a program that will not fit — but the
  `.xex` link script's RAM region is a literal with no symbol to override
  (verified above), so a `400` value **cannot** cap it with a defsym the way
  the PET's `__ram_size` does. Capping it means this project supplying its
  own link script. Until then, do not claim `--profile 400` builds a program
  a real 400 can run; it picks the emulator's model and the four-port fact,
  and that is all it does.
- Never probe RAMTOP, PORTB or the OS revision at run time to learn what
  the build is for. Width, RAM, ports and medium are properties of the
  build.
- atari800's bigger machines — `-320xe`, `-rambo`, `-576xe`, `-1088xe` —
  are deliberately **not** `model` values yet. Their extra RAM is reached
  through PORTB bits that `banks.kib()` does not read (atari800 reuses bits
  1 and 5-7 for them), so a `320xe` value carrying `memory.bankedKib: 256`
  and pointing `detect` at the current probe would state a number the probe
  answers 64 to. Extend the probe first, then add the values — a `detect`
  that under-reports is worse than no value at all.

### The OS is in the loop until the program takes the machine over

- Every color goes to the shadow *and* the hardware register while the
  OS VBI is alive, as `screen.8bs` does; the same is true of DMACTL
  (SDMCTL), the display list pointer (SDLSTL/H), CHBASE (CHBAS), CHACTL
  (CHACT), PRIOR (GPRIOR) and the P/M colors (PCOLR0-3). A hardware-only
  write is a one-frame write.
- `sei` does not stop the VBI or a DLI: both are NMIs. Taking over means
  either hooking VVBLKI/VVBLKD through SETVBV (and returning through
  SYSVBV/XITVBV) or clearing NMIEN's VBI bit — and once NMIEN is cleared
  the OS jiffy clock, keyboard, joystick shadows and attract-mode
  handling are all gone, so the program owns them.
- Screen memory is wherever SAVMSC says, the display list wherever SDLSTL
  says, and both sit in the 993 bytes the OS keeps just below RAMTOP.
  MEMTOP is the soft stack's base (start-up, verified pre-0.2.0). A program that puts
  its own display list, screen or P/M area at the top of RAM must lower
  RAMTOP/MEMTOP *and* re-derive the stack, or the two collide.
- Interrupt-time code (a DLI, a custom VBI) must save and restore what it
  touches, and a DLI has roughly a scanline to work in: do the register
  writes right after `STA WSYNC` so they land in horizontal blank.

### Video is a display list, and text is one of its modes

- The 40×24 text grid is the OS's choice, not the machine's. A portable
  text surface is a mode-2 line set with a known SAVMSC; anything wider
  (mode 6/7 double-width text, mode 4/5 four-color characters, mixed
  mode lines, narrow/wide playfield) is a different display list that the
  package owns and describes.
- There is no color RAM. Color granularity is per *playfield register*
  (five registers for the whole screen), per *scanline* through a DLI, or
  per *character* only in the 20-column modes (top two bits of the code
  pick the register) and the five-color character modes `$4`/`$5` (bit
  pairs inside the glyph, plus COLPF3 via bit 7 of the code).
  `text.putColor` stays inert in mode `$2`; a color-per-cell intent on
  this machine means choosing mode `$4` or `$6`/`$7` at build time, not
  faking it — and only `$6`/`$7` give a color *per cell* rather than per
  pixel-pair. The full table is in "The playfield" above; read it before
  designing any of this.
- The character set is a 1K table on a 1K boundary named by CHBASE (512
  bytes on a 512-byte boundary in the 20-column modes): redefinable
  glyphs, tiles, and pseudo-pixels are all the same thing here. The ROM set's `$00-$1F`
  (ATASCII `$20-$3F`) holds punctuation and digits; the line/corner glyphs are in
  the ATASCII control range (`atari.h`: `CH_ULCORNER = $11`, `CH_HLINE =
  $12`, `CH_VLINE = $7C`). Bit 7 of a screen byte inverts the glyph in
  hardware (CHACTL bit 1), so reverse video is free.
- Bitmaps are modes `$8`-`$F`: 320×192 in one color + luminance (`$F`),
  or 160×192 in four colors from COLPF0-2 + COLBK (`$E`), 7680 bytes each
  at full height; GTIA modes 9/10/11 trade to 80 pixels across for 16
  luminances, 9 colors, or 16 hues. Each is a mode line the display list
  names, and they mix with text lines on the same screen. Both 7680-byte
  modes cross a 4K boundary, which the screen buffer must be *positioned*
  to survive — see the display-list rules above; this is a placement
  problem before it is an API problem.
- Hardware fine scroll is two registers (HSCROL 0–15 color clocks, VSCROL
  0–15 lines) applied to the display-list lines that carry the `$10`/`$20`
  bits, with LMS on each line to move the coarse position; the hardware
  scrolls the *playfield*, never the P/M strips. One layer, no priority
  between backgrounds: there is only one background. Budget for the two
  costs named in "Scrolling" above — enabling HSCROL widens the fetch by
  one step, so the data has to be laid out at the wider pitch and the CPU
  pays the DMA; and a vertically scrolled region's first and last mode
  lines are short, so its height is not a multiple of the mode's.
- Screen RAM can be written at any time (ANTIC reads it by DMA; there is
  no snow and no vblank-only window), so the NES's write queue does not
  belong here. The only reason to time a write is tearing, and `waitFrame()`
  already provides that edge.
- The border is COLBK and the playfield width (DMACTL bits 0–1) decides
  how much of it shows; a wide playfield shows none. `screen.setBorder`
  is real here, unlike the X16.

### A hardware buffer needs an address the program can name

This is the one thing blocking the character-set, display-list,
player/missile and bitmap layers, and it is a language question, not an
Atari one. Settle it before starting any of the four; all four have the
same shape.

ANTIC fetches from addresses a *register* names — CHBASE for the character
set, SDLSTL/H for the display list, PMBASE for the player/missile area, an
LMS operand for screen memory — and every one of those is alignment-
constrained. The constraints are now exact, and they are worse than
"aligned": a character set is 1K on a 1K boundary or 512 bytes on a 512
boundary; a P/M area is 1K- or 2K-aligned depending on a DMACTL bit the
program may change later; a display list must not *cross* a 1K boundary,
which is a placement rule rather than an alignment one; and a screen
buffer bigger than 4K must be positioned so that no single scan line
straddles the 4K boundary. So the program has to be able to tell ANTIC
where its buffer is — and, for two of the four, to constrain where the
buffer *ends up* rather than merely learn it. And it cannot:

- 8BitScript has no address-of operator. `memory.read`/`memory.write` are
  the whole memory surface (`packages/compiler/src/ir`, `memoryIntrinsic`),
  and a `let` or `const` array is placed by the linker with no way for the
  program to learn or constrain where it landed. So a linker-allocated
  array cannot be a buffer ANTIC reads.
- The C64 never had to answer this, which is why no precedent exists: its
  hardware buffers go at fixed addresses under I/O and ROM, where the
  linker never allocates anything. The Atari has no such region — the
  program owns `$2000-$BFFF` and the linker fills it from the bottom while
  the soft stack grows down from MEMTOP (about `$9C00`).

Two honest routes, and a third that is not:

1. **A fixed `@address` buffer in the middle of the region**, with the
   collision budget stated and checked. This is exactly what
   `src/banks.8bs` already does at `$4000`, hazard note and all: it is safe
   while `.data`/`.bss` end below the buffer and the stack does not reach
   down to it, and the linked image's symbol map is how that is checked
   (`test/banks.test.mjs` has the check to copy). Cheapest, and it works
   today; the cost is that the budget is a promise the compiler does not
   enforce, and a big enough program breaks it silently.
2. **Lower RAMTOP/MEMTOP and use the space above**, the way real Atari
   programs do — page-aligned by construction and safe from the linker,
   but start-up sets the soft stack from MEMTOP *before* `main` runs
   (verified pre-0.2.0: `init-stack.S`), so lowering it in `main` does not move the
   stack, and the program must re-derive it. That is a runtime change, not
   a package change.
3. **Not** an array plus a runtime alignment scan. Allocating 2K and using
   the 1K-aligned half inside it sounds clever and is unimplementable
   without the address-of operator route (1) needs anyway — there is
   nothing to align.

Route 1 is the recommendation, because it needs nothing new and the
package already has the precedent and the test for it. Whichever is
chosen, write the budget into this file with the numbers, and add the
symbol-map check to the layer's own test — a buffer that collides with the
stack is a bug that only appears in a big program, months later.

### Players and missiles are strips, not sprites

The reference is "Players and missiles" above — layout, offsets, sizes,
priority and collisions, all verified. These are the rules an API built on
it has to keep.

- Four players, 8 bits wide (one color clock each at size 0, two or four
  with SIZEP), and four 2-bit missiles, each a **full-height vertical
  strip** at one HPOS: a player's byte at row *y* is what shows on row
  *y*, so vertical movement is moving bytes inside the strip (or the whole
  strip's data), horizontal movement is one register write. The constraint
  shape is the *opposite* of the NES and C64: every strip is on every
  line, so "how many sprites per line" is 4 (+1 fifth player from the
  missiles), and more objects means re-positioning a strip mid-frame from
  a DLI.
- Two ways to feed the strips: ANTIC DMA from PMBASE (DMACTL bits 2–3,
  GRACTL bits 0–1; single- or double-line resolution) or the CPU writing
  GRAFP0-3/GRAFM per scanline with DMA off — the "racing the beam" style
  Altirra / De Re Atari compare to the 2600. A runtime picks one and
  says so.
- Color is one register per player (COLPM0-3); missiles borrow their
  player's color unless PRIOR bit 4 makes them a fifth player in COLPF3.
  PRIOR bit 5 gives a third color where P0/P1 or P2/P3 overlap — and
  **only** those pairs, the third color being the OR of the two
  registers, with any other overlap turning black. An API that offers
  "multicolor sprites" must therefore allocate them in pairs and pick
  register values by their OR; there is no third color to set.
- Priority is one of four values, not a bit mask: setting no PRIOR bit
  makes playfields and players mix, and setting two makes overlaps black.
- Collisions are hardware, 16 registers, latched until HITCLR: read them
  once per frame after the display, then clear. Nothing collides with the
  background, and missiles never collide with each other, so a capability
  that promises "did these two things touch" has to say which pairs the
  hardware can actually answer for. VDELAY shifts a *two-line* object down
  one scanline; in one-line resolution the same bit just halves the
  object's vertical resolution.
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
- Six distortions, eight encodings: `$60` duplicates `$20` and `$E0`
  duplicates `$A0`, because bit 6 picks the noise generator and is
  meaningless once bit 5 has selected a square wave. An enum should have
  six names and emit the canonical byte.
- In a 16-bit pair it is the **high** channel (2 or 4) that carries the
  period and gets enabled for audio; the low one is normally silent. Get
  this backwards and you hear the low timer's own period instead — it
  keeps underflowing every 256 ticks — so the result is a wrong pitch
  rather than silence, which is exactly the sort of bug that survives a
  test.
- POKEY's mixer saturates above a summed volume of 15 across actively
  sounding channels. A four-voice API that lets every voice sit at 15 is
  not louder, it is compressed and distorted — and a voice left at a
  constant 1 with non-zero volume distorts the others while making no
  sound of its own. Silence a voice by clearing its *output*, not just by
  trusting volume 0.
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
packages/atari8/src/screen.8bs          @8bitscript/atari8/screen: shadow-then-hardware colors, blank() over 960 cells at SAVMSC, GTIA-byte color names, KEEP = 255
packages/atari8/src/text.8bs            @8bitscript/atari8/text: ASCII → internal code, SAVMSC read per run, empty putColor/setColor, CELL_COUNT 960 / COLUMNS 40
packages/atari8/src/joystick.8bs        @8bitscript/atari8/joystick: STICK/STRIG shadows, ports from #fact(input.joysticks), ATRACT zeroed each scan
packages/atari8/src/console.8bs         @8bitscript/atari8/console: CONSOL's three keys (read) and the speaker (write), one address twice
packages/atari8/src/keyboard.8bs        @8bitscript/atari8/keyboard: CH consumed per frame, SKSTAT for held/SHIFT, no chords on this machine
packages/atari8/src/keys.8bs            @8bitscript/atari8/keys: the 61 KBCODE values, GENERATED from the Atari OS table — regenerate, do not hand-edit
packages/atari8/src/pokey.8bs           @8bitscript/atari8/pokey: 4 voices, 6 distortions, AUDF tables computed from the ÷28 clock, sid.8bs's shape
packages/atari8/src/random.8bs          @8bitscript/atari8/random: RANDOM ($D20A), its own import on purpose
packages/atari8/src/banks.8bs           @8bitscript/atari8/banks: the 130XE probe, and the precedent for a fixed @address buffer
packages/atari8/test/layers-probe.8bs   every input layer on one screen: the polarity check, and what settled SKSTAT
packages/atari8/test/layers.test.mjs    links the probe, rechecks keys.8bs against the KBCODE table, checks the port-count fold, runs it under atari800
packages/atari8/package.json            "8bitscript".hardware: model (run flags + facts only), media (driver/defsym/output/load), mouse, stereo; a preset per model
packages/compiler/src/mos/index.ts     FRAME_SYNC.atari8 (VCOUNT poll, no sei; the backend refuses to build); outputExtension()
packages/cli/src/run.mjs                atari800CleanDisplayConfig() (per-process cfg copy), the launch: the catalog's flags, then -run or the value's load
packages/cli/src/screenshot.mjs         atari8Screenshot(): one window at a time, macOS capture, the same flags
packages/cli/src/mac-window-capture.mjs findWindowIdForPid()/captureWindow(), the capture route for any atari800 launch
packages/cli/src/doctor.mjs             the atari800 install plan
packages/cli/test/emulator-smoke.test.mjs   atari800 -xl -ntsc -run boots a real build
docs/setup/atari8.md                    installing atari800, the ROM caveat, the model → flag list
docs/setup/verify.md                    why atari8's screenshot is the one OS-level capture
Altirra HRM / atari.inc                 chip bases, PORTB bits, OS vectors (DOSVEC, MEMTOP, KBCODE)
DOS .xex map (pre-0.2.0)                $2000 load, MEMLO survey, FF FF header
XEGS / standard / MegaCart maps         fixed $A000 + 8K banks at $8000, $BFFA, RAM $0700-$1FFF; cart8/cart16; mega16..mega512
Atari OS / DOS manuals                 start-up (MEMTOP stack, DOSVEC exit), cartridge vectors at $BFFA
github.com/atari800/atari800 src/, DOC/cart.txt           antic.c/antic.h/atari.h (timing), gtia.c, pokey.c, pia.c, memory.c (PORTB), cartridge.c/ui.c (types, the menu), input.c (controllers)
Altirra Hardware Reference Manual (Avery Lee, virtualdub.org)  ch.4 ANTIC (modes, display list, scrolling, P/M DMA), ch.5 POKEY, ch.6 CTIA/GTIA (P/M, collisions, priority, GTIA modes, color); the source for "The playfield" and "Players and missiles" above
atariarchives.org/dere/                 De Re Atari, ch.2 ANTIC and ch.4 P/M — the classic account; its glossary contradicts its own chapter 4 on P/M alignment, and chapter 4 is the one that is right
```
