# Writing Atari 8-bit support for 8BitScript

This file is for anyone — human or agent — touching `packages/atari8`,
this package's hardware catalog (`package.json`, `"8bitscript".hardware`:
`model`, `media`, `mouse`, `mouseport`, `stereo`), `packages/backend-6502`'s `atari8` entries
(`DRIVER.atari8`, `FRAME_SYNC.atari8`), `packages/cli`'s atari800 handling
(`atari800CleanDisplayConfig()`,
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
  frame, so a hardware-only colour write lasts one frame (seen on screen
  by this project when `examples/borders` first ran). The
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
  wherever SAVMSC (`$58/$59`) points. The eight colour names are raw GTIA
  bytes (hue in the high nybble, even luminance in the low); `KEEP` is 255,
  which on this machine is a real colour (hue 15 at maximum luminance)
  given up for the sentinel.
- `src/text.8bs` (`@8bitscript/atari8/text`, behind `@8bitscript/text`):
  `CELL_COUNT` 960, `COLUMNS` 40; `putChar` takes ASCII, converts to
  ANTIC's internal code (`$00-$1F` → +64, `$20-$5F` → −32, else unchanged)
  and writes `SAVMSC + cell`; `print`/`printNumber` read SAVMSC once per
  run (`prepare()`) and inhibit the cursor; `setReverse` sets bit 7 of the
  internal code; `putColor` and `setColor` are
  inert because GR.0 has no per-cell colour. `printNumber` is the
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
  *generated* from the SDK's own `atari.h` (61 codes) and a test rechecks
  it against that header.
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
  `xex` (default, the stock `mos-atari8-dos-clang`), `cart8`/`cart16`
  (`mos-atari8-cart-std-clang`), `xegs32`-`xegs512`
  (`mos-atari8-cart-xegs-clang`) and `mega16`-`mega512`
  (`mos-atari8-cart-megacart-clang`). Each cartridge value carries
  `build.output: rom`, its `__cart_rom_size` defsym, the matching atari800
  `-cart-type` in its `load`, and the facts a cartridge changes
  (`memory.ram` 6400, `storage.save` false); being the value that changes
  the build, it is the one in the output name
  (`main-atari8-xegs256-ntsc.rom`, `main-atari8-cart8-ntsc.rom`; a `.xex`
  is `main-atari8-<region>.xex`). A preset per model keeps `--profile
  130xe` working, and `--profile xegs` is now one value on each axis
  (`model: xegs, media: xegs256`), which is what it always meant.
  `mouse` (labelled *Pointing device*) — `none`, `st`, `amiga`, `trak`,
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
  and colour-shadow copy all stay alive under an 8BitScript program.
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
for anything else), not recalled. `$SDK` is `~/.local/opt/llvm-mos`.

| Fact | Where |
| ---- | ----- |
| A `.xex` starts `FF FF`, then a segment `02E0-02E1` holding `_start` (RUNAD), then the main segment loaded at `$2000` up to `__data_end - 1`. The link script's RAM region is `$2000-$BFFF` (`LENGTH = 0xa000`), chosen against a MEMLO survey (DOS 2.0S/2.5/XE 1.0 `$1CFC`, SpartaDOS X 4.49 `$1DBA`; DOS 1.0 `$2A08` and SpartaDOS 1.1 are *not* supported). Its comment: RAM "can go higher to `$C000`" if BASIC is disabled, minus 993 bytes for the OS's text screen and display list, plus the C stack. | `$SDK/mos-platform/atari8-dos/lib/link.ld`; `xxd` of a built `.xex` (`ff ff e0 02 e1 02 00 20 00 20 31 23`) |
| Imaginary registers are `$80-$9F`; the program's zero-page variables start at `$A0` (`ticks` in the borders build). | `link.ld` (`__rc0 = 0x80`, `__rc31 == 0x9f`), `llvm-objdump` of the ELF |
| DOS crt0: `_start` sets the soft stack pointer `__rc0/1` to `MEMTOP ($02E5/$02E6) + 1`, calls `main`, then `exit` → `_Exit`, which is `jmp ($0A)` (DOSVEC). Nothing is printed, no CIO call is made and no character set is switched before `main`. The SDK's own `putchar` would go through CIO's `E:` handler; 8BitScript never links it. | `init-stack.S`, `_Exit.c`, `putchar.c` (upstream `mos-platform/atari8-*`), `llvm-objdump` of the linked `.xex.elf` (no `jsr $E4xx`, no `sei`) |
| XEGS cartridge: an 8K *fixed* bank always at `$A000-$BFFF` and `__cart_rom_size / 8 − 1` switchable 8K banks at `$8000-$9FFF`, selected by a write to `$D500-$D5FF`; sizes 32–512K, power of two, default 256. RAM for the program is `$0700-$1FFF` ("assume at most 8 KiB of RAM"). The vector at `$BFFA` is `_start`, `0` ("inserted"), `$04` (bit 2 = boot), `_cart_init`. The default `_cart_init` is weak and writes 0 to `$D500` "because on real hardware the XEGS bank selection is random". In the file the fixed bank comes **last**: the built image has `00 A0 00 04 16 A0` at offset `$3FFFA` and zeros at `$1FFA`. `.data`/`.bss` land at `$0700`. | `atari8-cart-xegs/lib/link.ld`, upstream `syms.s`, `xxd`/`llvm-readelf` of the built `.rom` |
| Standard cartridge (`mos-atari8-cart-std-clang`, now `media=cart8`/`cart16`): 8K at `$A000` or 16K at `$8000`, same `$BFFA` vector, same `$0700-$1FFF` RAM. MegaCart/SIC! (`mos-atari8-cart-megacart-clang`, now `media=mega16`…`mega512`): 16–512K in 16K banks mapped over `$8000-$BFFF`, bank 0 at power-up, a 20-byte tail in bank 0 that shrinks RAMTOP (`$6A`) to `$80` if needed and writes `$20` to `$D500` for SIC! carts. | `atari8-cart-std/lib/link.ld`, `atari8-cart-megacart/lib/link.ld`, `tail0.s` |
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
| The catalog's stock fact sheet: grid 40×24 of 8×8 (ANTIC mode 2), 256 colours (GTIA's 16 hues × 16 luminances), 2 per cell (one hue, two luminances), 128 glyphs per charset, no full block set (`video.blockWidth`/`Height` 0: ATASCII's control-graphics range is not a quarter-block set), bitmap, one layer with fine scroll; 4 players as the sprites (missiles are not counted), 4 per line, 8 pixels wide and as tall as the display (192 lines of per-line data), one colour each; POKEY's 4 voices with a volume each, noise distortions, volume-only samples, no envelope or filter, `RANDOM` as a random source; keyboard, two ports on the XL/XE models, no pads; disk under DOS; 40960 bytes (`$2000`–`$BFFF`), nothing banked until `model=130xe`, no mouse until a `mouse` value. | `src/text.8bs`; the `.xex`/`link.ld`, ANTIC, GTIA and POKEY rows above; `package.json` (read) |
| `@8bitscript/atari8/banks` — `banks.kib()`: a marker in base RAM at `$4000`, then a marker of its own into each of the four banks bits 2–3 name (bit 4 clear so only the CPU sees them, bit 5 left alone so ANTIC keeps drawing base RAM, bits 0/1/7 left alone so the OS ROM, BASIC and self-test stay put), then base RAM read again. Still its own marker means the writes went elsewhere and the machine has extended RAM; the last bank's marker means there was only ever one RAM. Each bank is then read back so a mirror is not counted. atari800's `MEMORY_HandlePORTB` computes the 128 KiB bank as `((byte & 0x0c) >> 2) + 1` and runs the same code to no effect on a 64 KiB machine, which is what makes this work. Under atari800 the probe printed 64 KiB for `model=130xe` and 0 for `800xl`, `65xe` and `800` — including the 800, where PORTB is joystick ports 3 and 4 and the writes are harmless. Cost: `test/banks-probe.8bs` is 682 bytes of program with the probe and 531 with the answer written in — 151 bytes. | `src/banks.8bs`; atari800 `src/memory.c` (fetched 2026-09-05); four screenshots (ran); `test/banks.test.mjs` |
| The `.xex` link script's RAM region is a **literal** `ORIGIN = 0x2000, LENGTH = 0xa000` — there is no `PROVIDE` and no symbol to override, unlike the VIC-20's `__memory_expansion` or the PET's `__ram_size`. So a `400` or `800` value **cannot** cap the linked RAM with a `--defsym`, and the catalog does not pretend to: those values change the emulator's model and the joystick-port fact only. Capping RAM for a 16K 400 needs a link script this project supplies, which nothing does yet. | `$SDK/mos-platform/atari8-dos/lib/link.ld` (read) |
| `atari8-cart-std/lib/link.ld` has **no** `PROVIDE(__cart_rom_size)` — only `ASSERT(__cart_rom_size == 8 \|\| __cart_rom_size == 16, ...)`. The standard-cartridge driver therefore cannot link at all without the defsym, where the XEGS (`PROVIDE(... = 256)`) and MegaCart (`= 512`) scripts have defaults. Every cartridge value in the catalog passes it explicitly for that reason. | the three cartridge `link.ld`s (read) |
| All fourteen `media` values link the borders example and produce exactly the size their name claims: `.xex` 830 bytes; `cart8` 8192; `cart16` 16384; `xegs32/64/128/256/512` 32768/65536/131072/262144/524288; `mega16`…`mega512` 16384…524288. `cart8`, `cart16`, `xegs256` and `mega128` were each launched and photographed running the program (teal playfield, blue border, `TICK n OPTION 0`) — so both newly-wired drivers work, not just the XEGS one. | `8bs build --target atari8 --hardware media=<v>` for all fourteen; four window captures (ran) |
| SKSTAT's keyboard bits are **active low**, settled on screen rather than from the header: with nothing pressed, `test/layers-probe.8bs` prints `SKSTAT 255`, so bit 2 (last key still held) and bit 3 (SHIFT held) are 1 when idle and 0 when true. The SDK's `_pokey.h` names them `SKSTAT_LASTKEY_PRESSED`/`SKSTAT_SHIFTKEY_PRESSED` and states no polarity. In the same capture every input reads idle — `STICK 00000`, `CONSOL 000`, `KEY 255`, `HELD 0` — so no layer inverts a sense the wrong way. | `test/layers-probe.8bs` on screen (ran) |
| The Atari's own joystick masks are bit for bit the C64's: `JOY_UP_MASK` `$01`, `JOY_DOWN_MASK` `$02`, `JOY_LEFT_MASK` `$04`, `JOY_RIGHT_MASK` `$08`, `JOY_BTN_1_MASK` `$10`. That is why `@8bitscript/atari8/joystick` can export the same `Joystick.*` values as the C64 layer without either machine being fudged. | `$SDK/mos-platform/atari8-common/include/atari.h` |
| The KBCODE table is in the SDK — `KEY_*` in `atari8-common/include/atari.h`, mirrored as equates in `asminc/atari.inc`: 61 codes, all under `$40`, with `KEY_SHIFT` `$40` and `KEY_CTRL` `$80` as masks OR-ed on and `KEY_NONE` `$FF`. `src/keys.8bs` is generated from that header and `test/layers.test.mjs` rechecks every value against it. (This row was "to verify" until the header was found; it is now sourced.) | `atari.h`, `asminc/atari.inc`; `test/layers.test.mjs` (ran) |
| `#fact(input.joysticks)` really folds per model, end to end: the same `test/layers-probe.8bs` prints `PORTS 2` on a stock 800XL build and `PORTS 4` on `--hardware model=800`, and the IR for the two builds differs in the scan loop's bound. So the catalog's new per-model facts reach generated code, not just `8bs targets`. | two window captures (ran); `test/layers.test.mjs` |
| POKEY's clock is the machine clock ÷ 28 — 63921 Hz NTSC, 63337 Hz PAL from the nominal figures `FRAME_SYNC.atari8` uses — and an 8-bit AUDF on it reaches about 125 Hz at 255. So octaves 0-2 of the standard note numbering are **not playable** on the default clock (the tables clamp them to 255) and the top octave is coarse: NTSC A6 lands at 1775.6 Hz against 1760, about 15 cents sharp. Computed here from `clock / (2 * (AUDF + 1))`, the standard published relation — *to verify* on screen against a tone before anything depends on exact cents. | `src/pokey.8bs` (the tables are generated, not transcribed) |
| An ST/Amiga mouse or a Trak-Ball **is** the joystick as far as the port is concerned: atari800 signals its movement as quadrature on PORTA's direction bits, so a `joystick.scan()` of that port returns mouse motion. Shown here rather than reasoned about — `test/layers-probe.8bs` paints its border green only when every input reads idle, and under `--hardware mouse=st` it comes up **red** while `mouse=paddles` and `mouse=koala,mouseport=4` stay green, because paddles and a Koala Pad are on POKEY's POT lines and leave the stick bits alone. Put the two in different ports (`mouseport`), or do not scan the pointer's port as a stick. | three window captures (ran) |
| The layers cost what they say: `test/layers-probe.8bs`, which imports all six, is 1328 bytes of program and 11 bytes of RAM — screen, text, joystick, console, keyboard, POKEY and RANDOM together. A program that imports none of them links none of it. | `8bs run atari8` build line (ran) |

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

**Keyboard codes.** *Resolved* — the table is the SDK's own `KEY_*` and is
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
the SDK writes `0, $04`. *To verify* what the OS does with bit 0 clear.

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
- **`docs/setup/llvm-mos.md`** said "a profile only changes which of the
  two drivers above runs, and which atari800 machine model `8bs run`
  launches". Fixed: the page now lists all four Atari drivers and says that
  the *media* axis — not the model — changes the load address, the RAM
  budget (6400 bytes, not 40960), the image size and whether the program
  can save at all.
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

### A hardware buffer needs an address the program can name

This is the one thing blocking the character-set, display-list,
player/missile and bitmap layers, and it is a language question, not an
Atari one. Settle it before starting any of the four; all four have the
same shape.

ANTIC fetches from addresses a *register* names — CHBASE for the character
set, SDLSTL/H for the display list, PMBASE for the player/missile area, an
LMS operand for screen memory — and every one of those is alignment-
constrained (a 1K character set, a 2K or 1K P/M area, a display list that
must not cross a 1K boundary). So the program has to be able to tell ANTIC
where its buffer is. And it cannot:

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
   down to it, and `llvm-nm` on the linked ELF is how that is checked
   (`test/banks.test.mjs` has the check to copy). Cheapest, and it works
   today; the cost is that the budget is a promise the compiler does not
   enforce, and a big enough program breaks it silently.
2. **Lower RAMTOP/MEMTOP and use the space above**, the way real Atari
   programs do — page-aligned by construction and safe from the linker,
   but the crt0 sets the soft stack from MEMTOP *before* `main` runs
   (verified: `init-stack.S`), so lowering it in `main` does not move the
   stack, and the program must re-derive it. That is a runtime change, not
   a package change.
3. **Not** an array plus a runtime alignment scan. Allocating 2K and using
   the 1K-aligned half inside it sounds clever and is unimplementable
   without the address-of operator route (1) needs anyway — there is
   nothing to align.

Route 1 is the recommendation, because it needs nothing new and the
package already has the precedent and the test for it. Whichever is
chosen, write the budget into this file with the numbers, and add the
`llvm-nm` check to the layer's own test — a buffer that collides with the
stack is a bug that only appears in a big program, months later.

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
packages/atari8/src/joystick.8bs        @8bitscript/atari8/joystick: STICK/STRIG shadows, ports from #fact(input.joysticks), ATRACT zeroed each scan
packages/atari8/src/console.8bs         @8bitscript/atari8/console: CONSOL's three keys (read) and the speaker (write), one address twice
packages/atari8/src/keyboard.8bs        @8bitscript/atari8/keyboard: CH consumed per frame, SKSTAT for held/SHIFT, no chords on this machine
packages/atari8/src/keys.8bs            @8bitscript/atari8/keys: the 61 KBCODE values, GENERATED from the SDK's atari.h — regenerate, do not hand-edit
packages/atari8/src/pokey.8bs           @8bitscript/atari8/pokey: 4 voices, 6 distortions, AUDF tables computed from the ÷28 clock, sid.8bs's shape
packages/atari8/src/random.8bs          @8bitscript/atari8/random: RANDOM ($D20A), its own import on purpose
packages/atari8/src/banks.8bs           @8bitscript/atari8/banks: the 130XE probe, and the precedent for a fixed @address buffer
packages/atari8/test/layers-probe.8bs   every input layer on one screen: the polarity check, and what settled SKSTAT
packages/atari8/test/layers.test.mjs    links the probe, rechecks keys.8bs against the SDK header, checks the port-count fold, runs it under atari800
packages/atari8/package.json            "8bitscript".hardware: model (run flags + facts only), media (driver/defsym/output/load), mouse, stereo; a preset per model
packages/backend-6502/src/index.mjs     DRIVER.atari8 (dos), driverFor()/outputExtension() reading the hardware's build block, FRAME_SYNC.atari8 (VCOUNT poll, no sei)
packages/cli/src/run.mjs                atari800CleanDisplayConfig(), the launch: the catalog's flags, then -run or the value's load
packages/cli/src/screenshot.mjs         atari8Screenshot(): macOS window capture, the same flags
packages/cli/src/mac-window-capture.mjs findWindowIdForPid()/captureWindow(), the capture route for any atari800 launch
packages/cli/src/doctor.mjs             CLANG_DRIVERS rows for all four Atari drivers (dos, cart-std, cart-xegs, cart-megacart); the atari800 install plan
packages/cli/test/emulator-smoke.test.mjs   atari800 -xl -ntsc -run boots a real build
docs/setup/atari8.md                    installing atari800, the ROM caveat, the model → flag list
docs/setup/llvm-mos.md                  the two Atari drivers and what the XEGS value changes
docs/setup/verify.md                    why atari8's screenshot is the one OS-level capture
examples/borders/src/main.8bs   the program every screenshot above shows
$SDK/mos-platform/atari8-common/        _antic.h, _gtia.h, _pokey.h, _pia.h, _atarios.h, atari.h (chip bases, PORTB bits), asminc/atari.inc (OS vectors)
$SDK/mos-platform/atari8-dos/lib/link.ld        the .xex format, $2000, the MEMLO survey
$SDK/mos-platform/atari8-cart-xegs/lib/link.ld  fixed $A000 + 8K banks at $8000, $BFFA vector, RAM $0700-$1FFF
$SDK/mos-platform/atari8-cart-std/lib/link.ld   8K/16K standard cartridge (media=cart8/cart16); ASSERTs __cart_rom_size with NO default
$SDK/mos-platform/atari8-cart-megacart/lib/     MegaCart/SIC! (media=mega16..mega512), tail0.o
github.com/llvm-mos/llvm-mos-sdk mos-platform/atari8-*/   the crt0 sources (init-stack.S, _Exit.c, syms.s, tail0.s, putchar.c)
github.com/atari800/atari800 src/, DOC/cart.txt           antic.c/antic.h/atari.h (timing), gtia.c, pokey.c, pia.c, memory.c (PORTB), cartridge.c/ui.c (types, the menu), input.c (controllers)
```
