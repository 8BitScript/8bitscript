# Writing MEGA65 support for 8BitScript

> **Parked in 0.2.0.** This machine is not a build target in the current
> release: `8bs build` refuses it until its native backend lands
> (`RELEASE_MACHINES` in `packages/compiler/src/resolver`). The package
> stays in the workspace, its sources still link, and everything below is
> still the guide for when it returns. The 0.2.0 work is the PET and the
> web; see the "Hello, PET" roadmap.

This file is for anyone — human or agent — touching `packages/mega65`,
`packages/compiler/src/mos`'s `mega65` entries (`FRAME_SYNC.mega65`,
`COMMODORE_KERNAL_MACHINES`), `packages/cli`'s `xmega65` handling
(`run.mjs`, `screenshot.mjs`, `setup/mega65.mjs`, `setup/mega65-rom.mjs`,
`setup/xemu.mjs`), `docs/setup/mega65.md`, or the MEGA65 rows of
`docs/roadmap.md` and `packages/studio/AGENTS.md`. Read the root
[`AGENTS.md`](../../AGENTS.md) first; the rules there apply to every
target and are not repeated. [`packages/cx16/AGENTS.md`](../cx16/AGENTS.md)
is the closest relative — a great deal of hardware behind windows, ports
and firmware — and [`packages/c64/AGENTS.md`](../c64/AGENTS.md) is the
machine this one is usually, and wrongly, described as. The MEGA65 is a
fourth case —

> **The MEGA65 is not "a C64 on faster silicon". A program built with this
> target runs in MEGA65 mode: a 45GS02 at 40.5 MHz, interrupts off, with
> the VIC-IV's own registers live at `$D000`, an 80-column screen at
> `$0800`, 384 KB of chip RAM of which the CPU sees 64 KB at a time, and a
> DMA controller and 28-bit addressing for the rest. The C64's registers
> are there too — as a compatibility *view*, not the machine's state.
> Model it as a wide, fast, banked character machine with eight enhanced
> sprites, four SIDs, and a firmware (Hyppo) for the SD card; never as the
> C64 the register names suggest.**

The machine's variety is small on the hardware side (board revisions R1–R6
differ in attic RAM, RTC and SDRAM, not in the programming model) and
large on the *mode* side: the same silicon runs in C64 mode (`$0801`, 1 MHz,
40 columns, VIC-II I/O personality) or MEGA65 mode (`$2001`, 40.5 MHz, 80
columns, VIC-IV personality), and PAL/NTSC and 40/80 columns are *register
bits*, not variants. Both modes are verified below; this target builds
only the second.

## What exists today

Do not describe more than this as working:

- `packages/mega65/src/index.8bs` exports three VIC-II-compatible
  registers: `borderColor` (`$D020`), `backgroundColor` (`$D021`) and
  `memoryPointer` (`$D018`). Its comments say the target "boots into" the
  VIC-II view and that 40 MHz and the VIC-IV modes are "outside what this
  target reaches for". **That is not what happens** — see the verified
  table: the program runs at 40.5 MHz with the VIC-IV I/O personality
  live; only the *register subset the package touches* is VIC-II-shaped.
- `src/screen.8bs` (behind `@8bitscript/screen`) masks both colours to 4
  bits and `blank()` writes 1000 spaces from `$0800`. In MEGA65 mode
  `$D020`/`$D021` take **8-bit** palette indexes (`_vic4.h`
  `VIC4_BORDERCOL_MASK = 0b11111111`); the mask keeps the eight shared
  names on the C64 colours (palette entries 0–15 are the C64 set,
  `mega65.h` `COLOR_*`), which is correct, but 1000 cells is **half the
  screen** (see next item).
- `src/text.8bs` (behind `@8bitscript/text`) has `COLUMNS = 40` and
  `CELL_COUNT = 1000`, writes `$0800 + cell` and `$D800 + cell`, and
  selects the upper-case set with `$D018 = $24` before each run. **The
  screen it draws on is 80 columns wide** (`$D031 = $E0`, H640 set;
  `LINESTEP` 80; `CHRCOUNT` 80 — measured, below). So cell 40 lands at
  row 0 column 40, cell 80 at row 1 column 0, cell 960 at row 12; only
  cell 0 — the borders HUD — is where the package thinks it is, which is
  why nothing has looked wrong so far. The package's "verified on screen"
  note verified cell 0. The fix is a package decision, not a runtime
  probe: either draw for 80×25 (`COLUMNS` 80, `CELL_COUNT` 2000, and a
  colour path that reaches cells ≥ 1024 — see "Colour RAM" below) or put
  the VIC-IV into 40 columns first (clear `$D031` bit 7 with hot
  registers on; the ROM restores nothing, so `_fini` would have to). Both
  are open; neither is done.
- `waitFrame()` (`FRAME_SYNC.mega65` in `packages/compiler/src/mos`) reuses
  the C64 entry verbatim — a level poll of `$D012`/`$D011` bit 7 for the
  top half of the frame, with `palProbe` (raster ≥ 288) choosing the
  PAL/NTSC ratio at start-up. **Measured working** under xmega65 in both
  regions: 50 hardware frames per 60 logical on PAL, 59 on NTSC. The
  ratio it uses is the C64's (50.12 / 59.83 Hz) where xemu's MEGA65 frame
  is exactly 50.000 / 59.94 Hz — the logical clock runs ~0.25 % slow on
  PAL (~9 s an hour) and ~0.19 % fast on NTSC (~7 s an hour) — see
  "Corrections".
- `8bs run mega65` launches `xmega65 -prg <file> -videostd 0|1` and
  `--screenshot` adds `-besure -screenshot <png>`, waits `--frames` at a
  nominal 60 fps, then SIGTERMs (Xemu writes the PNG on that path —
  `screenshot.mjs`). The `run.mjs` docstring and `docs/setup/mega65.md`
  call `-prg` "best-effort, unconfirmed". **It is confirmed**: Xemu
  detects the `$2001` load address, waits for `READY.`, injects the
  bytes and types `RUN` (its log: `INJECT: prepare for C65 mode, BASIC
  (RUNable) program, $2001 load address`); a `$0801` build does the same
  in C64 mode.
- `8bs setup mega65` builds Xemu's MEGA65 core from source and installs
  the user's own ROM; the pair every fact below was read against is xemu
  `40dfef0d` (2026-01-29, `xmega65 -h` banner), Hyppo `HEAD,20250618.10`
  (built into that xemu), and ROM **920413** (the only release
  `setup`/`doctor` verify — `docs/setup/mega65.md`). The ROM is not
  redistributable; the licensing caveat there stands.
- There is no `--profile` for the MEGA65 (no C64-mode profile, no
  40/80-column profile, no attic-RAM profile); no far pointer, DMA, VIC-IV
  mode, sprite, SID, audio-DMA, keyboard, joystick, mouse or SD-card API —
  for this machine or any other. The rules below are what to hold that
  work to.

## Facts verified here

Cite these freely; each was read in the source named or seen on screen
under xmega65 (xemu `40dfef0d`, ROM 920413), not recalled.

| Fact | Where |
| ---- | ----- |
| After `RUN` the program is in **MEGA65 mode with the VIC-IV I/O personality**: `$D054` reads `64` (`$40`: VFAST set, CHR16/FCLRLO/FCLRHI clear), `$D031` reads `224` (`$E0`: H640 + FAST + ATTR), `$D05D` reads `192` (HOTREG + RST_DELEN), `$D018` reads `36`, `$D016` `201`. Those are VIC-IV registers answering as themselves — in the VIC-II personality `$D031`/`$D054`/`$D058` would be mirrors of `$D011`/`$D014`/`$D018` (`$D018` reads 36, `$D058` reads 80). | probe program's screenshot under `8bs run mega65 --screenshot` (`regs-ntsc.png`), read back through `memory.read` |
| **80 columns × 25 rows at `$0800`**: `LINESTEP` (`$D058/59`) = 80/0, `CHRCOUNT` (`$D05E`) = 80, `SCRNPTR` (`$D060–63`) = `$00 $08 $00 $00`, `COLPTR` (`$D064/65`) = 0, `DISP_ROWS` (`$D07B`) reads 24 with 25 rows visible, `CHRXSCL` 120, `CHRYSCL` 1. Text printed at cell 40 appears on row 0 column 40; cell 960 on row 12. | same probe; `shot-ntsc.png` |
| **The CPU runs at full speed**: a `while (raster < 200 && n < 65000) n++` loop counted 9371 iterations over ~200 raster lines (≈12 600 ~1 MHz cycles) — impossible below tens of MHz. Xemu's fast clock is 40.50 MHz. | `shot-ntsc.png`; xemu boot log `SPEED: fast clock is set to 40.50MHz` |
| `$00` reads `47` (`$2F`) and `$01` reads `62` (`$3E`) during the program — bit 6 of `$01` clear — and the CPU is still fast: the speed came from the ROM's `$D054` VFAST, not from the port. `$D030` reads `68` (`$44`). | probe; start-up bytes below (pre-0.2.0) |
| `$D629` (model ID) reads `3` = MEGA65 R3, xemu's `-model` default. `$D06F` reads `128` under `-videostd 1` (NTSC) and `0` under `-videostd 0` (PAL). | probe (`regs-ntsc.png`, `regs-pal.png`); `xmega65 -h`; Book model table |
| **Logical rasters**: the 9-bit `$D012`/`$D011.7` counter reaches **262 on NTSC, 311 on PAL** (263 / 312 lines), so the C64 `palProbe` (≥ 288) and top-half thresholds hold. `$D7FA` advances once per hardware frame: **59 per 60 `waitFrame()` on NTSC, 50 on PAL**. | `pace-ntsc.png`, `pace-pal.png` |
| Xemu's frame model: PAL `PAL_FRAME_TIME 20000` µs, `PHYSICAL_RASTERS_PAL 624`, visible 576; NTSC `NTSC_FRAME_TIME 16683.35` µs, `PHYSICAL_RASTERS_NTSC 526`, visible 480; line rate 31250 / 31468.5 Hz; logical raster = physical ÷ 2. | xemu `targets/mega65/vic4.h` (WebFetch, verbatim constants); boot log `frame time is 16683usec, max raster is 526, visible area height is 480` |
| Xemu's memory: **384K fast (chip) RAM, 8192K attic, 32K colour RAM, 8K font RAM**; 4 SIDs at 1 000 000 SID cycles/s and one OPL3; audio out 44 100 Hz. | xemu boot log (`MEM: memory decoder initialized …`, `AUDIO: reset for 4 SIDs … and 1 OPL3 chip`) |
| The `.prg` loads at `$2001` behind a BASIC `SYS 8215` line; usable RAM `$2001–$CFFF` (`LENGTH = 0xafff`); soft stack top `$D000`. The script's own map: `$1.0000–$1.1FFF` CBM DOS, `$2000–$9FFF` free, `$A000–$BFFF` BASIC ROM "but we switch to ram", `$C000–$CFFF` free, `$D000` I/O, `$E000` KERNAL. | `xxd dist/main-mega65-ntsc.prg` (pre-0.2.0: `01 20` header, `9e 20 38 32 31 35` = `SYS 8215`, and `_start` is `$2017` = 8215) |
| `.init.010` is **`sei; ldx #$2F; stx $00; ldx #$3E; stx $01; ldx #$44; stx $D030`** and `.fini.990` is `ldx #$3F; stx $01; ldx #$64; stx $D030; cli`. So `$D030` = `$44` for the program (CRAM2K 0, PAL-RAM 1, no C65 ROM at `$8000/$A000/$C000/$E000`, CROM9 1), the ROM's own state is `$64` (ROMC set — C65 ROM at `$C000`), and **IRQs are disabled from `_start` until exit**. The C64 target's start-up has no `sei` and no `$D030` write. | disassembly of start-up (pre-0.2.0); `dist/main-mega65-ntsc.prg` |
| A CHROUT of PETSCII 14 (`lda #$0e; jsr $ffd2`) would flip the machine to lower-case before `main`; 8BitScript does not emit that. | disassembly of a linked build vs a libc start-up (pre-0.2.0) |
| The 45GS02 has `stz`, `bra`, `inw` (65C02/65CE02-family opcodes the C64 never has); the same borders program was 775 bytes here vs 1034 on the C64 (pre-0.2.0). No `q`-register or `[zp],Z` instruction appeared in any build examined. The native backend refuses to build. | mnemonic tallies of both images (pre-0.2.0); `packages/compiler/src/mos/index.ts` `CPU.mega65` |
| `mega65.h` maps `VICII` (a `__vic2`) and `VICIV` (a `__vic4`, `0x80` bytes) both at `$D000`, `PALETTE` at `$D100` (red/green/blue ×256), `SID1–4` at `$D400/$D420/$D440/$D460`, `SIDMODE` `$D63C`, `HYPERVISOR` `$D640` (64 traps), `ETHERNET` `$D6E0`, `DMA` `$D700` (`DMAgicController`, `0x60` bytes incl. 4 audio channels at `+0x20`), `MATHBUSY` `$D70F`, `MATH` `$D768` (32×32 multiply, divide, 64-bit `MULTOUT`), `CIA1/2` `$DC00/$DD00`, `DEFAULT_SCREEN` `$0800`; colours 0–15 are the C64's, 16–31 named extras. | MEGA65 Book / iomap.txt / `_vic4.h` register map |
| `_dmagic.h`: DMA commands copy/fill (mix, swap "unimplemented"); addressing linear/modulo/hold/XYmod; bank-field flags HOLD 16, MODULO 32, DIRECTION 64, IO 128; enhanced options `$0A`/`$0B` (F018A 11-byte / F018B 12-byte list), `$80`/`$81` source/dest address bits 20–27, `$85` dest skip; audio channel struct: enable, 24-bit base, 24-bit freq, 16-bit top, volume, current, timer; `$D711` AUDEN bit 7. `dma.hpp` builds a fill/copy job and triggers it by writing `$D703`, `$D702`, `$D701`, then `$D705`. | `_dmagic.h`, `dma.hpp` |
| Audio DMA uses a 24-bit frequency field — `freq = 0x001a88` for an 11 822 Hz 8-bit signed sample, enable/8-bit/loop flags together. | MEGA65 Book DMA appendix; iomap.txt |
| **A `c64`-target `.prg` autoloads in C64 mode** under `xmega65 -prg`: the borders C64 build shows its 40-column HUD, red border / purple background. Xemu picks the mode from the load address (`-prgmode 64/65` overrides). | `c64mode.png`; xemu log `INJECT: prepare for C64 mode, … $0801 load address`; `xmega65 -h` |
| `xmega65` flags this project relies on or should know: `-prg`, `-prgmode`, `-videostd 0/1/-1`, `-screenshot <png>` ("on exit"; SIGTERM reaches it), `-besure`, `-model <id>`, `-fastclock <MHz>`, `-sidmask`, `-8`/`-9 <d81>`, `-sdimg`, `-virtsd` (a *directory* as the FAT32 card), `-hdosdir`, `-go64`, `-autoload`, `-fullborders`, `-showscanlines`, `-nosound`, `-dumpscreen <file>` (ASCII screen on exit), `-dumpmem`, `-headless`, `-sleepless`, `-prgexit`, `-lockvideostd`, `-allowmousegrab`. Xemu's config lives in `~/.xemu-lgb` (`mega65-default.cfg`, `mega65.img` 4 GB SD image, `hdos/`). | `xmega65 -h`; `ls ~/.xemu-lgb` |
| SID stereo assignment: `$D400` "right SID #1", `$D420` "right SID #2", `$D440` "left SID #1", `$D460` "left SID #2"; `$D63C.0-3` SIDMODE 0 = 6581, 1 = 8580; `$D41B` OSC3 random; `$D419/$D41A` paddles. | `mega65-core/iomap.txt` (curl, master, 2026-09-05) |
| Audio DMA: four channels at `$D720/$D730/$D740/$D750` (+0 flags: bits 0–1 sample bits 11 = 16, 10 = 8, 01/00 = upper/lower nybble; bit 3 stop, 4 sine, 5 signed, 6 loop, 7 enable; +1..3 base, +4..6 frequency, +7..8 top, +9 volume, +A..C current, +D..F timer); `$D71C–$D71F` per-channel right/left volume; `$D711.7` AUDEN, `.4` NOMIX, `.3` PWM/PDM; `$D6F4/$D6F5` audio mixer select/data; `$D6F8–$D6FB` 16-bit left/right digital out. | `iomap.txt` |
| Keyboard: CIA1 `$DC00/$DC01` C64-style matrix; column 8 via `$D607.1`/`$D608`; **direct matrix `$D614` (write column 0–8) / `$D613` (row bits, 0 = pressed)**; **typing queue `$D610` ASCII (`$00` = empty), `$D619` PETSCII, `$D611` modifiers, `$D60A.7` queue-not-empty; writing either dequeues**; `$D615–$D617` virtual keys; `$D612` JOYSWAP (bit 5), PS/2 joystick emulation, physical/virtual enables; `$D60F.5` REALHW = 0 under Xemu. The keyboard has a diode per key (no ghosting). | `iomap.txt`; Book `appendix-keyboard.tex` |
| Mouse/paddles: `$D620–$D623` read the four pot lines "without having to fiddle with SID/CIA settings"; `$D61B` bits 0–3 enable/assume **Amiga-mouse (1351 emulation)** per joystick port. Xemu emulates a 1351 through the SID pot registers when `-allowmousegrab`/grab is on, else pots read `$FF`. | `iomap.txt`; xemu `input_devices.c` (WebFetch) |
| Storage: `$D080–$D08F` F011 floppy controller (drive 0 internal 3.5", 1 second on cable); `$D680–$D68F` SD controller (sector address, buffer select, disk-image control, F011 image address on card); Hyppo traps at `$D640` with the function in A then `CLV`: `getversion $00`, `getdefaultdrive $02`, `getcurrentdrive $04`, `selectdrive $06`, `chdir $0C`, `opendir $12`, `readdir $14`, `closedir $16`, `openfile $18`, `readfile $1A`, `writefile $1C`, `closefile $20`, `closeall $22`, `rmfile $26`, `setname $2E`, `findfirst $30`, `findnext $32`, `findfile $34`, `loadfile $36`, `geterrorcode $38`, `setup_transfer_area $3A`, `cdrootdir $3C`, `loadfile_attic $3E`, `attach $4A` (D81 to the virtual F011); `mkdir/mkfile/rename/seekfile/fstat/filedate` "Not implemented". | `iomap.txt`; Book `appendix-hypervisor-calls.tex` |
| VIC-IV frame: "HDTV 576p 50Hz (PAL) and 480p 60Hz (NTSC) video modes"; PAL 63 cycles/raster, 312 logical rasters; NTSC 65 and 263; "exactly the same number of ~1MHz CPU cycles as on the VIC-II"; 27 MHz pixel clock, 720×576 / 720×480 visible, 640×400 usable inside the VIC-II/III border; a VGA 640×480 compatibility mode (`$D06F.6`) "runs at 63Hz"; `$D06F.7` is PALNTSC and is writable. No bad lines natively; `$D710.0` enables a 40-cycle bad-line emulation "ignored if the processor is running at full speed". The Book's table says **626** physical PAL rasters where xemu says 624 — treat the count as *to verify*. | Book `appendix-viciv-registers.tex` §Frame Timing |
| Text/colour engine: `SCRNPTR $D060–$D063` (28-bit screen base), `CHARPTR $D068–$D06A`, `COLPTR $D064/65` (offset into colour RAM), `LINESTEP $D058/59`, `CHRCOUNT $D05E`, `CHRXSCL/CHRYSCL $D05A/$D05B`, `DISP_ROWS $D07B`, `TEXTXPOS/TEXTYPOS $D04C–$D04F`, borders `$D048–$D04B`, `SDBDRWD $D05C/5D`; `$D054.0` CHR16 (two screen bytes per character), `.1/.2` full-colour for char numbers ≤/>`$FF`, `.4` sprite H640, `.7` alpha; `$D05D.7` HOTREG. **FCM: 64 bytes per character, "each pixel … from the 256 colours of either the primary or alternate palette"**, address = 64 × char number regardless of `CHARPTR`, pixel `$FF` takes the colour-RAM colour; NCM: 4 bits per pixel, 16 px wide; SEAM (16-bit screen + 16-bit colour RAM per cell): 8 192 unique characters, GOTOX / raster-rewrite buffer ("hardware-generated pseudo-sprites … limited only by the raster time"), flips, Y offset, row mask; alpha blending needs `$D054.7` + CHR16 + FCM. BOLD+REVERSE together select the alternate palette. | `_vic4.h`; `iomap.txt`; Book VIC-IV appendix |
| Palette: **four banks of 256 entries**, `$D070` bits 1–0 alternate-palette bank, 3–2 sprite bank, 5–4 text/bitmap bank, 7–6 which bank is mapped at `$D100–$D3FF`; the appendix says "23-bit colour depth (versus the VIC-III's 12-bit)", iomap says the `$D100/$D200/$D300` bytes are "red/green/blue palette values (reversed nybl order)". | `_vic4.h` masks; `iomap.txt`; Book VIC-IV appendix §Features |
| Sprites: 8; VIC-II control unchanged; **64 px wide** with `SPRX64EN $D057` (16 px in 16-colour mode, "six pixels" without it); height 21 or a **shared** `SPRHGHT $D056` 0–255 per `SPRHGTEN $D055`; **16-colour mode `SPR16EN $D06B`** = 15 colours + transparent from the sprite palette bank at `sprite × 16 + nibble` (+128 with bitplane-modify); tile mode repeats a sprite "until the end of the raster line"; `SPRENV400 $D076` per-sprite vertical resolution, `$D054.4` horizontal; alpha `$D074/$D075`; pointers relocatable (`SPRPTRADR $D06C–$D06E`, 16-byte aligned) and 16-bit (`SPRPTR16`, image = 64 × pointer, "anywhere in the first 4MB"); "the VIC-IV uses ring-buffer for each sprites data … a sprite can be displayed multiple times per raster line, thus potentially allowing for horizontal multiplexing". There is **no 256-colour sprite mode**. | Book VIC-IV appendix §Sprites; `iomap.txt` |
| Memory map (Book): 28-bit space; chip RAM `$000002–$05FFFF` "Fast chip RAM (40MHz)"; the ROM is **128 KB of that RAM at `$20000–$3FFFF`** (banks 2–3, write-protected; `$3E000` C65 KERNAL, `$32000` C65 BASIC, `$2E000` C64 KERNAL, `$2A000` C64 BASIC, `$20000` DOS); colour RAM `$FF80000–$FF87FFF` (32 KB); I/O `$FFD0000–$FFD3FFF` (four personalities); Hypervisor `$FFF8000` (16 KB); attic `$8000000–$87FFFFF` (8 MB, "all models apart from Nexys, presently"; "about ten times slower than accessing Chip RAM"; "cannot be used directly by the VIC chip for graphics data, nor … for audio sample playback"); cartridge/slow bus `$4000000–$7FFFFFF`. "The MAP register overrides all other banking mechanisms"; MAP moves 8 KB blocks by a 12-bit offset ×`$100`, the megabyte byte via a first MAP with `$0F` in X/Z; `[$zp],Z`, the "Base-Page Quad Indirect Z-Indexed Addressing Mode", "accesses a 28-bit address stored as four bytes on the base page" "without 16-bit address translation". `$D030` bits 3/4/5/7 map C65 ROM at `$8000/$A000/$C000/$E000`, bit 0 CRAM2K maps colour RAM's second KB at `$DC00–$DFFF`. DMA "40MB [fill] or copying 20MB per second"; "the processor stops trying to execute instructions until the DMA job has completed" (audio DMA keeps stealing cycles). | Book `appendix-memorymap.tex`, `memory.tex`, `appendix-dmagic.tex` (WebFetch); `_vic3.h` masks |
| Model IDs (`$D629`): `$01` R1, `$02` R2, `$03` R3, `$04` R4, `$05–$0F` R5–R15, `$21` MEGAphone R1, `$40` Nexys4 PSRAM, `$41` Nexys4DDR, `$42` Nexys4DDR + widget, `$FD` QMTECH Wukong A100T, `$FE` VHDL simulation. R4 "added a 64MiB SDRAM in addition to the 8MiB HyperRAM"; R2+ desktops have an RTC with NVRAM; R6 "electrically identical to R5". | Book `appendix-target-specific.tex` (WebFetch) |
| CPU speed (Book): "~1MHz, ~2MHz, ~3.5MHz and 40MHz"; slow modes keep 6502 cycle counts per instruction but "timing may be incorrect by up to 7 micro-seconds"; at 40 MHz "branches … require fewer" cycles and `LDA/LDX/LDY/LDZ` "one additional cycle"; the hypervisor "always operates at full speed (40MHz)". `$D031.6` FAST (3.5 MHz), `$D054.6` VFAST ("48MHz" in iomap's stale text); the Book's RTC example says "If you first POKE0,65 to set the CPU to full speed" — `$01` bit 6 (the bit `POKE 0,65` sets in the *DDR*) is the recalled "force fast" bit, *to verify* below. | Book `appendix-45gs02-registers.tex`, `appendix-target-specific.tex`; `iomap.txt` |
| The catalog's stock fact sheet, for the MEGA65 mode this target runs in: grid 80×25 of 8×8, 256 palette entries, 2 colours per cell in the text mode used, 256 glyphs, 2×2 PETSCII blocks, bitmap, one layer with fine scroll; 8 sprites and 8 per line, up to 64 wide and 255 tall, 15 colours; 4 SIDs' 12 voices + 4 DMA audio channels = 16, ADSR, filter, noise, samples by DMA, a volume per voice, oscillator 3 as a random source; keyboard, two ports, no pads or mouse on the stock sheet; the SD card to save to; 45055 bytes (`$2001`–`$CFFF`), and the 384 KiB of chip RAM beyond the 64 KiB window as 320 KiB banked. | `src/text.8bs`; the `link.ld`, memory and SID rows above; the VIC-IV sprite and audio notes below; `package.json` (read) |

## From the sources, not verified here

Leads, each to confirm the first time code depends on it:

- **OPL3.** Xemu emulates "1 OPL3 chip" and `_vic4.h`/`iomap.txt` carry
  no OPL register; the address (folklore says `$D0FE/$D0FF` in the C65
  personality) is *to verify* against mega65-core.
- **Audio-DMA sample rate.** The 24-bit frequency field's formula is not
  in any source read here. `0x001A88` is the constant for an
  11 822 Hz sample; derive it from that and *measure* before
  publishing a "hertz" API.
- **`$00`/`$01` bit 6 vs `$D054.6`.** The Book's `POKE0,65` ("to set the
  CPU to full speed") writes bit 6 of the *DDR*; the port-bit semantics
  ("force fast") are recalled, not read. Under xemu the program was fast
  with `$00 = $2F`, `$01 = $3E` (both bit 6 clear) and VFAST set. Which
  wins on hardware is *to verify*.
- **Extended-attribute nibble.** With `$D031.5` ATTR set (it is, at boot)
  colour RAM's upper nibble is blink/reverse/bold/underline; the bit
  assignment (recalled: 4 blink, 5 reverse, 6 bold, 7 underline) is *to
  verify*. `text.8bs` masks to 4 bits, so it is safe today.
- **Palette entry layout.** "23-bit" (appendix) versus "reversed nybl
  order" bytes (iomap): read `PALETTE.red[n]` back before assuming either.
- **Physical PAL raster count**: 626 (Book table) vs 624 (xemu).
- **What runs at 1 MHz.** Whether the KERNAL's IRQ handler, `CHROUT`, and
  the C64-mode ROM pin the speed, and what `GO64` leaves in `$D054`.
- **The VIC-IV interrupt sources.** `$D019/$D01A` are the VIC-II's;
  `$D07A.6` EXTIRQS "additional IRQ sources, e.g., raster X position" and
  `$D079/$D07A` physical-raster compare exist; no vertical-blank *flag*
  register was found — the raster counter and `$D7FA` are the frame edge.
- Real hardware timing, throughout: every measurement above is xemu's
  model at `40dfef0d`.

## Corrections to the repository's own text

The package, the backend and the setup docs describe this target as the
C64 view on faster silicon. The measurements say otherwise; fix the words
when the code is next touched (this file does not edit them):

- **`index.8bs` used to say "boots into exactly that view … the 40MHz
  CPU mode, its enhanced VIC-IV video modes, and its expanded memory are
  outside what this target reaches for".** Fixed the same day: the program
  *is* in 40 MHz mode with the VIC-IV personality selected; the package
  merely writes VIC-II-numbered registers. `$D018 = $24` works because
  hot registers re-derive `SCRNPTR`/`CHARPTR` from it — a VIC-IV
  mechanism (`$D05D.7`), not a C64 one.
- **`text.8bs`/`screen.8bs` used to draw for 40 columns, 1000 cells.**
  Fixed the same day: `COLUMNS` is 80, `CELL_COUNT` 2000, `blank()`
  clears 2000 cells, and `prepare()`/`putColor()` set `$D030`'s CRAM2K
  bit (`VicIIIControl.COLOR_RAM_2K`, `$45`) so cells 1024–1999's colour
  lands in colour RAM, not the CIAs. Studio's front door and the borders
  example were re-screenshotted under xmega65 after the change.
- **`FRAME_SYNC.mega65` comment: "boots into that C64-compatible view and
  clock, so this reuses the C64 entry verbatim".** The polling works (the
  VIC-IV keeps a VIC-II-style 263/312-line raster counter), but the
  *period* is the MEGA65's: xemu runs exactly 50.000 Hz PAL (20 000 µs)
  and 59.94 Hz NTSC (16 683.35 µs), against the C64 pair's 50.12 / 59.83.
  A `{ num: 1, den: 50 }` / `{ num: 1001, den: 60000 }` entry would be
  exact under xemu; hardware *to verify*.
- **`run.mjs` docstring and `docs/setup/mega65.md`: `-prg` "best-effort",
  "not independently confirmed", "same registers, same colours, same
  numbers as the C64".** `-prg` is confirmed (both modes); the numbers are
  not the C64's (80 columns, 8-bit colour registers, 40 MHz).
- **`docs/roadmap.md`** lists the MEGA65 under "powerful 65xx systems"
  with no further description; when its row grows, the thesis above is
  the summary, not "C64-compatible".

## Rules for this target

### Mode is the first axis, and the linker chooses it

- This target's `link.ld` is MEGA65 mode (`$2001`, `SYS`, C65 ROM
  unmapped, `$A000–$CFFF` RAM, stack `$D000`). A C64-mode program is the
  **`c64` target** run under `xmega65` — verified — not a MEGA65 build
  with a flag. If C64 mode ever becomes a MEGA65 profile it is a
  *startup* choice (`c64`, `$0801`) plus `-prgmode 64`, not a
  runtime `GO64`.
- PAL/NTSC (`$D06F.7`) and 40/80 columns (`$D031.7`) are register bits
  the program can set; `--pal` here only chooses xemu's `-videostd` and
  the frame ratio. Neither is a hardware variant, and neither should
  become a `--profile`. Board revisions (`$D629`) change attic RAM, RTC,
  SDRAM — capabilities to probe (`REALHW`, `$D629`), not machine names.
- Interrupts are off for the whole program (`.init.010`'s `sei`). Nothing
  in a package may rely on the KERNAL's IRQ (jiffy clock, keyboard scan,
  cursor); raster IRQs need the program to own the vector — `$0314` while
  the KERNAL is mapped at `$E000`, `$FFFE` only with it unmapped, *to
  verify* for the C65 KERNAL — *and* `cli`.

### Memory: 64 KB is a window, not the machine

- Fixed RAM is `$2001–$CFFF`; everything else is behind MAP, `$D030`,
  `$01`, DMA, or a 32-bit pointer. A 28-bit address is a different kind
  of thing from a pointer: represent it as such (the root rule), never
  as a bare 16-bit value plus a "bank" the caller must remember.
- Prefer **DMA** for anything bulk (clear, copy, fill, chip RAM ↔ chip
  RAM): it runs at 40 MB/s, halts the CPU, and takes 28-bit addresses in
  one job. Prefer `[zp],Z` for a single far byte. Keep MAP for code and
  data that must be *executed* or indexed in place, and restore it before
  any KERNAL or Hyppo call.
- The ROM lives in RAM (`$20000–$3FFFF`, write-protected). A program that
  needs none of it can, per the Book, reclaim it — but Hyppo, `_fini`'s
  `$D030 = $64`, and `RUN STOP/RESTORE` all assume it is there. Don't.
- Attic RAM is slow and invisible to the VIC-IV and audio DMA: assets go
  through chip RAM. Never assume attic exists (Nexys boards).

### Screen: 80 columns, 8-bit colours, hot registers

- Decide the geometry in the package and set it; don't inherit the
  ROM's. Whichever width `text.8bs` draws for, `COLUMNS`, `CELL_COUNT`,
  `screen.blank()` and the colour path must agree, and the profile-file
  rule (`geometry.<machine>.<profile>.8bs`) is the place for a 40/80
  choice if one is ever exposed — not a runtime read of `LINESTEP`.
- `$D020/$D021` are 8-bit here. The shared eight names stay on 0–15;
  a MEGA65-only colour surface can expose all 256 (and the four banks).
- Hot registers are on: a write to `$D011/$D016/$D018/$D031` recomputes
  borders, `SCRNPTR`, `CHARPTR`, `CHRCOUNT`. Either keep using them (the
  C64 idiom) or clear HOTREG and program the VIC-IV registers directly —
  never mix, or a stray `$D018` write undoes a `SCRNPTR`.
- **Colour RAM**: `$D800–$DBFF` is cells 0–1023. Cells 1024–1999 of an
  80-column screen are at `$DC00–$DFCF` **only while `$D030.0` CRAM2K is
  set** — and the build clears it, so those addresses are CIA1/CIA2. A
  `putColor` past cell 1023 written the current way pokes the CIAs
  (keyboard columns, VIC bank, serial bus). Reach the 32 KB colour RAM
  through `$FF80000` (DMA or `[zp],Z`), or toggle CRAM2K around the
  write and back before any CIA read.
- Screen RAM can be written at any time: the VIC-IV has its own bus, no
  bad lines, no snow. The only reason to sync is tearing, and
  `waitFrame()` already gives the edge. At 40 MHz the vertical border
  (~112 PAL / ~63 NTSC logical lines × 63/65 cycles × 40.5) is hundreds
  of thousands of cycles — the NES's vblank budget does not transfer.

### Sprites and the VIC-IV modes

- Eight sprites, all eight on any line, plus ring-buffer horizontal
  re-use. The real budget is width × colour depth per line (64 px mono,
  16 px 16-colour), not a count — describe intent and let the package
  pick mono/multicolour/16-colour and the palette bank.
- `SPRHGHT` is one value for every sprite that opts in: a metasprite
  system must group by height or pad with transparency.
- FCM needs 64 bytes per glyph and SEAM (16-bit cells) to address more
  than 256 of them; a full 80×25 FCM screen of unique characters is a
  128 KB framebuffer. Deduplicate at build time; prefer NCM (half the
  bytes, 16 px wide) where 16 colours per cell suffice.
- The RRB/GOTOX is a per-scanline reposition of the character stream:
  layers, parallax and soft sprites — but "limited only by the raster
  time", which is not documented as a number. Measure on xemu *and*
  hardware before promising a layer count.
- Bitplane mode is VIC-III's and stays limited to the first 128 KB; the
  Book itself recommends FCM/NCM over it. Avoid.

### Audio: four SIDs, four DACs, one mixer

- Four SIDs are two stereo pairs (`$D400/$D420` right, `$D440/$D460`
  left), each a full 3-voice SID with filter; 6581/8580 curves per chip
  via `$D63C`. A portable `8bit:sound` voice maps to one SID voice;
  stereo placement is a MEGA65-only property. `$D41B` of any SID is the
  entropy source — behind the explicitly optional import, per the root
  rule.
- Sample playback is the audio-DMA channels (`$D720+`), not SID volume
  tricks: base/top/current 24-bit addresses in chip RAM, loop, volume,
  8/16-bit signed/unsigned. Everything passes the mixer (`$D6F4/$D6F5`)
  unless NOMIX. The rate constant is *to verify* (above).
- OPL3 exists (xemu) but is undocumented here; treat it as an optional
  capability with no API until its registers are read from mega65-core.

### Input: three keyboard interfaces, pick one per program

- `$D610` (ASCII queue, `$00` = empty, write to pop) is the right
  interface for text UIs — it works with interrupts off and needs no
  matrix table. `$D614/$D613` (column 0–8 select, row bits) is the
  "is this key down" interface for games; the C64 CIA path is only for
  code shared with the C64 target. Don't mix the queue and the matrix in
  one frame's logic without saying which is authoritative.
- Joysticks are CIA1 ports as on the C64 (`$DC00/$DC01` low bits, with
  `$D612.5` able to swap them). Mouse: 1351 through the pots — read
  `$D620–$D623` rather than re-programming the SID/CIA — and Amiga-mouse
  emulation is a `$D61B` switch, not a different API.

### Storage: the SD card is a firmware, not a disk

- Files live on a FAT32 SD card behind Hyppo traps (`setname`,
  `findfile`, `loadfile`/`loadfile_attic`, `openfile`/`readfile`/
  `closefile`; `writefile` for writes). Loads land at a 28-bit address
  given in X/Y/Z. Each trap is `LDA #fn : STA $D640 : CLV` and must run
  with the hypervisor able to take over (interrupts off is fine).
- D81 images are the floppy route (`attach`, then the F011 at `$D080` or
  the KERNAL); Xemu mounts `-8 file.d81` externally and `-virtsd <dir>`
  turns a host directory into the card. Persistence is therefore a real
  capability here on every model — but a *media* capability (card, D81,
  RTC NVRAM on R2+), never assumed from `machine == mega65`.

### Testing

- Pin xemu commit + Hyppo + ROM in any comment that records a
  measurement (`xmega65 -h` prints the first; the boot log the others).
- `8bs run mega65 --screenshot <png> --frames <n>` is the headless path
  (wall-clock frames at 60; ~8 s of boot before `RUN`). `-dumpscreen`
  (ASCII) and `-dumpmem` are cheaper assertions than PNGs for tests.
- Every number above is xemu's model. Before a rule depends on cycle
  timing (DMA, RRB, audio DMA, 40 MHz I/O wait states), run it on a
  board.

## Where things live

```
packages/mega65/src/index.8bs            target package: borderColor ($D020), backgroundColor ($D021), memoryPointer ($D018)
packages/mega65/src/screen.8bs           @8bitscript/mega65/screen: setColors/blank/setBorder/setBackground (4-bit mask, 1000 cells — see above)
packages/mega65/src/text.8bs             @8bitscript/mega65/text: print/printNumber/setColor/setReverse/putChar/putColor, COLUMNS 80 / CELL_COUNT 2000
packages/compiler/src/mos/index.ts      FRAME_SYNC.mega65 (C64 entry reused; the backend refuses to build)
packages/cli/src/run.mjs                 8bs run mega65: xmega65 -prg <file> -videostd 0|1
packages/cli/src/screenshot.mjs          --screenshot: -besure -screenshot <png>, wall-clock --frames at 60, SIGTERM
packages/cli/src/setup/mega65.mjs        8bs setup mega65: compiler check, deps, Xemu build/install, ROM install/link
packages/cli/src/setup/mega65-rom.mjs    the --c64-forever/--rom-patch ROM generation flow (romdiff + 920413 patch)
packages/cli/src/setup/xemu.mjs          building/installing xmega65, ~/.xemu-lgb layout
docs/setup/mega65.md                     install, ROM licensing caveat, doctor, run
mega65-core iomap.txt / MEGA65 Book     VIC-IV, DMA, SID, Hyppo; load at $2001, $D030 start-up
xemu 40dfef0d / Hyppo HEAD,20250618.10 / ROM 920413   the emulator, firmware and ROM every measurement above was made against
mega65-core iomap.txt, mega65-user-guide (master, 2026-09-05)   the register map and the Book chapters cited above
```
