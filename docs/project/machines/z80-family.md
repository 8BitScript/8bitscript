---
title: The Z80 family
nav_order: 41
---

# Writing Z80-family support for 8BitScript

This file is for anyone — human or agent — touching the future `z80`
backend the roadmap's Phase 8 asks for, or any of the five machines it
opens up: ZX Spectrum (48K/128K), MSX (1 and 2), Sega Master System and
Game Gear, Amstrad CPC, and ColecoVision. Read the root
[`AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/AGENTS.md) first; the rules there apply to every
target and are not repeated. `gameboy.md` (same directory) covers the
other Phase 8 CPU; the Game Boy is *not* a Z80 and is deliberately kept
out of this note. Each machine here also has its own compact
`<machine>.schema.md` beside this file — spectrum, msx, sms, cpc,
colecovision — from which the capability matrix is built; this note is
the comparison and the rules.

> **Five machines share one CPU and almost nothing else. Two are
> framebuffers with no sprites (Spectrum: 1 bpp + color clash; CPC:
> packed pixels + CRTC), three are TMS9918-descended tile-and-sprite
> machines (MSX, ColecoVision, SMS/GG) that differ in sprites per line
> (4 / 4 / 8), color depth (1 / 1 / 4 bpp per sprite) and whether a
> scroll register exists (V9938 vertical only / none / both). Model the
> CPU once, the address space per machine (flat, paged, slotted, or
> configured), and the video five times.**

The one thing every Z80 machine forces on the *language* is I/O: the
Spectrum's ULA, the MSX's VDP and PSG, the SMS VDP, the CPC's Gate Array
and PPI, and the ColecoVision's everything are reached with `IN`/`OUT`,
not memory. `@address` cannot spell a port. That is the first design
question a Z80 backend raises — before any of the five video chips.

## What exists today

Nothing. There is no Z80 backend, no `packages/spectrum|msx|sms|cpc|
colecovision`, no profile, run flag or setup command, and the compiler
has one lowering (`packages/backend-6502`, which emits C for
`mos-*-clang`). `ls ~/.local/opt/llvm-mos/bin` shows only 6502-family
drivers. Neither SDCC, z88dk, GBDK-2020 nor any of Fuse, openMSX, Mesen2,
Emulicious, Caprice32, ColEm or MAME is installed here (`which` finds
none). The rules below are what to hold that work to when it comes.

## Facts verified here

Cite these freely; each was read in the source named — fetched raw and
read in full or grepped, except where "(WebFetch)" marks a summarised
fetch whose quoted strings are what is relied on — not recalled.

| Fact | Where |
| ---- | ----- |
| **Spectrum 48K**: Z80 at exactly 3.5 MHz; ROM `$0000–$3FFF`, bitmap `$4000–$57FF` (6144 B), attributes `$5800–$5AFF` (768 B); attribute = INK bits 0–2, PAPER 3–5, BRIGHT 6, FLASH 7 (swap every 16 frames); port `$FE` out: bits 0–2 border, 3 MIC, 4 EAR/speaker; in: keyboard 8 half-rows × 5 keys selected by a zero in the high address byte (`$FEFE` Shift–V … ), pressed = 0, ">2 keys may not decode uniquely", bit 6 EAR; frame = (64+192+56)×224 = 69888 T = 50.08 Hz; first screen byte 14336 T after `/INT`; line = 128 T screen + 24 right border + 48 retrace + 24 left border; `$4000–$7FFF` contended (0–6 T delays) only while the picture is drawn; joystick beats keyboard on a shared port; floating bus returns screen bytes ~60 % of the frame. | WoS *48K Reference* |
| **Spectrum 128K/+2**: 3.54690 MHz, 228 T/line, 311 lines, 70908 T, 50.01 Hz; port `$7FFD` bits 0–2 RAM bank at `$C000`, bit 3 shadow screen (bank 7), bit 4 ROM, bit 5 lock "until the computer is reset"; write-only, copy at `$5B5C`; `$4000` always bank 5, `$8000` always bank 2; banks 1, 3, 5, 7 contended; AY-3-8912 via `OUT ($FFFD)` select, `IN ($FFFD)`, `OUT ($BFFD)` data. **+2A/+3**: port `$1FFD` (copy at `$5B67`) bit 0 special mode with four all-RAM layouts, bit 2 ROM high bit (4 ROMs), bit 3 disk motor; banks 4–7 contended; first pixel at 14364 T. | WoS *128K Reference* |
| **MSX**: CPU "Z80A or equivalent (clock 3.579545 MHz ±1 %)"; MSX1 RAM 8 K+, VRAM 16 K, TMS9918; MSX2 RAM 64 K+, VRAM 64 K or 128 K, V9938, RTC, 2 joysticks; screen modes Table 1.3 (TEXT1 40×24, TEXT2 80×24, MULTICOLOR 64×48, G1 32×24, G2 256×192, G3, G4 256×212, G5 512×212 4 col, G6 512×212, G7 256×212 256 col; sprite modes 1/2); "each 64K space is called a slot, which consists of four 16K areas called pages"; TMS9918: 16 colors max, 1 color per sprite, no palette; V9938: 512-color palette, 16 per sprite. | MSX2 Technical Handbook ch. 1 Tables 1.1–1.3, ch. 4 §1–3 |
| **V9938**: VRAM access via port 0 with auto-increment after a two-byte address on port 1 (bit 6 write flag) and R#14 for the 17-bit page; **sprite mode 1** (G1, G2, MC): 32 sprites, "up to 4 sprites … on a single horizontal line", collision S#0 bit 5, 5th-sprite flag bit 6 + number; **sprite mode 2** (G3–G7): 8 per line, color per line, CC-bit OR mixing, 9th-sprite flag, collision coordinates S#3–S#5; sizes 8×8/16×16 (R#1 SI), MAG; R#23 vertical display offset; R#19 line interrupt (S#1 FH); R#9 NT = PAL 313 / NTSC 262 lines, IL interlace; S#0 F flag "when S#0 is read, this flag is reset"; per-mode characteristics blocks (TEXT1 6×8, 2 colors; G2 768 patterns 16 K; G4 32 K; G6/G7 need 128 K). | V9938 MSX-VIDEO Technical Data Book (map.grauw.nl) |
| MSX I/O: VDP `$98–$9B`; PSG `$A0–$A2` (registers 14/15 = joystick I/O ports); PPI `$A8` slot select, `$A9` keyboard columns, `$AA` row select/cassette, `$AB`; RTC `$B4/$B5`; MSX-MUSIC YM2413 `$7C/$7D`; memory mapper `$FC–$FF` ("up to 256 segments" into four 16 K pages). Keyboard: 11 rows × 8 columns, row to `$AA` bits 0–3, columns from `$A9`, pressed = 0, or BIOS `SNSMAT $0141` / NEWKEY `$FBE5–$FBEF`; PSG reg 14 bit 6 = JIS/ANSI. BIOS: `CHGMOD $005F`, `WRTVDP $0047`, `RDVRM $004A`, `WRTVRM $004D`, `SETRD $0050`, `SETWRT $0053`, `FILVRM $0056`, `LDIRMV $0059`, `LDIRVM $005C`, `CHPUT $00A2`, `GTSTCK $00D5`, `GTTRIG $00D8`, `GTPAD $00DB`, `GICINI $0090`, `WRTPSG $0093`, `RDPSG $0096`, `INITXT/INIT32/INIGRP/INIMLT $006C–$0075`. | MSX Assembly Page: I/O ports, key matrix, BIOS list (WebFetch) |
| **SMS/GG VDP** (315-5124 SMS1, 315-5246 SMS2, 315-5378 GG): ports `$BE` data / `$BF` control, `$7E` V counter, `$7F` H counter + PSG; two-byte command word with a first/second-byte flag "cleared when the control port is read, and when the data port is read or written"; status bits INT/OVR/COL cleared by reading `$BF`; CRAM 32 × `--BBGGRR` (64 colors) / GG mode 32 words `----BBBBGGGGRRRR` (4096) written latch-even/odd; mode table (mode 4, 224/240-line on SMS2/GG only; "invalid text mode"); R#0–R#0A functions incl. R#0 bit 6 lock rows 0–1, bit 7 lock columns 24–31, bit 5 mask column 0, bit 3 sprite shift −8, bit 4 line IRQ; R#1 bit 6 display, bit 5 frame IRQ, bit 1 8×16, bit 0 zoom; R#7 backdrop from the sprite palette; patterns 8×8 × 4 planes = 32 B, 512 patterns; name table 32×28 words `---pcvhnnnnnnnnn`; X scroll fine bits fill 1–7 px with backdrop; Y scroll latched until end of active display, wraps at 224; SAT 256 B (64 Y, 64 X/n), Y+1, `$D0` terminator in 192-line mode, 8-entry line buffer, overflow bit 6, collision bit 5, SMS1 zoom bug; NTSC 262 / PAL 313 lines with border-line counts; frame IRQ on line `$C1/$E1/$F1`; line counter R#0A reload/decrement rules; **CRAM writes during active display sometimes lost on SMS2**; GG in SMS mode shows "roughly 192 lines" shrunk with LCD artefacts, GG = NTSC SMS2 timing. | Charles MacDonald, *SMS VDP documentation* 2002-11-12 |
| SMS memory: `$0000–$BFFF` cartridge, `$C000–$DFFF` RAM, `$E000–$FFFF` mirror; Sega mapper: `$0000–$03FF` unpaged, `$FFFD/$FFFE/$FFFF` slots 0/1/2, `$FFFC` bit 3 RAM in slot 2, bit 2 RAM bank, bit 4 RAM at `$C000`, bit 7 ROM-write; 3–6 significant bank bits (128 KiB–1 MiB); Codemasters, Korean, MSX/Nemesis, Janggun mappers; "Smaller games (typically 32KB …) do not need a mapper". Pads: `$DC` (A up/down/left/right/TL/TR, B up/down), `$DD` (B left/right/TL/TR, Reset bit 4, CONT bit 5, TH A/B bits 6/7), `$3F` TR/TH direction+level (absent on Mark III, ignored on Japanese SMS → region detection); GG: `$DC/$DD` mirrors only at `$C0/$C1`. SN76489: latch/data protocol, 3 tone (10-bit) + noise (bit 2 white/periodic, rates /16 /32 /64 or tone 2), 4-bit attenuation, 3579545 Hz NTSC / 3546893 Hz PAL clock ÷16, PCM tricks; GG stereo port `$06` (bits 0–3 right, 4–7 left, headphones only). YM2413 (OPLL): Mark III FM Sound Unit / Japanese SMS, 9 channels or 6 + 5 rhythm, 16 instruments (1 user); detection = write/read port `$F2` 7 times; GG region = port `$00` bit 6 (0 = Japanese), `$00` also carries the Start button. | SMS Power!: *Memory Map*, *Mappers*, *Peripheral Ports*, *SN76489*, *YM2413*, *FM Chip Detection*, *Region Detection*, *Game Gear Stereo* |
| **ColecoVision**: Z80A 3.58 MHz; `$0000–$1FFF` BIOS, `$2000–$5FFF` expansion, `$6000–$7FFF` "SRAM (1K)", `$8000–$FFFF` cartridge; header `$8000` `AA55`/`55AA`, vectors, `$8021` NMI jump ("Vertical Blanking Interrupt from video chip"); I/O `$80–$9F` W keypad mode, `$A0–$BF` VDP, `$C0–$DF` W joystick mode, `$E0–$FF` W sound / R controllers (`$FC`/`$FF`, A1 selects); stick bits 0–3 L/D/R/U, bit 6 button, keypad 4-bit codes; SN76489AN register/data words, noise modes, f = 3579545/(32n). | `CV-Tech.txt` |
| openMSX ships `ColecoVision.xml`, `ColecoVision_SGM.xml`, `Sega_SG-1000.xml`, Spectravideo SVI-3x8 configs; `ColecoVision.xml`: `TMS9928A`, RAM `size=0x2000` at `0x6000`, PSG I/O `$E0` ×`$20` out, controller ports `$80`/`$C0` out and `$E0` in, `has_keypad`. | GitHub contents API for `share/machines`, `ColecoVision.xml` (WebFetch) |
| openMSX: `-machine <name>` (`C-BIOS_MSX1`, `C-BIOS_MSX2`, `C-BIOS_MSX2+` built in, default MSX2+), `-cart`/`-carta`, `-romtype`, `-diska <dir>` = "use a directory on your host computer's file system as a disk image", `-ext fmpac`, `-script`, `-command`, `-control stdio`; console `screenshot [-raw] [-prefix] [-with-osd] [-no-sprites]` (PNG), `after time <s> <cmd>`, `exit`, `set renderer none`, `set throttle off`. | openMSX `doc/manual/user.html`, `commands.html` (WebFetch) |
| Fuse: `--machine 16\|48\|48_ntsc\|128\|plus2\|plus2a\|plus3\|2048\|2068\|ts2068\|pentagon\|pentagon512\|pentagon1024\|scorpion\|se`, `--snapshot`, `--tape`, `--auto-load`, `--fastload`, `--playback`/`--record` (RZX), `--movie-start file` (FMF), `--plus3disk`, `--no-sound`, `--speed`, `--debugger-command`; screenshots only via the GUI (*Save Screen as PNG/SCR/MLT*); `fmfconv` converts FMF to PPM/SCR/PNG/AVI, `-C` selects frames, `-o` output. | Fuse `man/fuse.1`, fuse-utils `man/fmfconv.1` (WebFetch + grep) |
| Mesen2: `ConsoleType {Snes, Gameboy, Nes, PcEngine, Sms, Gba, Ws}`; `SmsRevision {Compatibility, Sms1, Sms2}`; `ConsoleRegion {Auto, Ntsc, Pal, Dendy, NtscJapan}`; CLI `--testRunner` (headless Lua), `--noVideo/--noAudio/--noInput`, `--sms.*`, and a `--cv.*` override prefix; Lua `takeScreenshot` returns decoder bytes. | Mesen2 `SettingTypes.h`, `CommandLineHelper.cs`, `LuaApi.cpp` (WebFetch) |
| Emulicious: Java; Game Boy/Color, Master System, Game Gear, MSX; debugger with VS Code extension; no CLI documented. | emulicious.net (WebFetch) |
| Caprice32: files `.dsk/.ipf/.cdt/.voc/.cpr/.sna/.zip`; `-a/--autocmd`, `-c cfg`, `-i/--inject` (default offset `0x6000`), `-O system.model=3`; **F3** screenshot to `sdump_dir`, Shift+F3 snapshot; `cap32.cfg [system] model 0=CPC464 1=CPC664 2=CPC6128 3=CPC6128+`, `ram_size` (128 default, ≥128 forced for model ≥2), `speed=4`, `jumpers`; Gate Array decode `(port.h & 0xC0) == 0x40`, function 0 pen (`val & 0x10` → border pen 16), 1 ink `val & 0x1F` into 32 colors, 2 mode `val & 3` + bit 2 lower ROM + bit 3 upper ROM + bit 4 "delay Z80 interrupt … reset GA scanline counter", 3 RAM configs 0–3 = `{0,1,2,3} {0,1,2,7} {4,5,6,7} {0,3,2,7}`; CRTC `&BCxx` select / `&BDxx` write / `&BFxx` read, reset R0=`$3F`, R2=`$2E`, R3=`$8E`; `MAXlate` address = `(j & 0x7FE) | ((j & 0x6000) << 1)` \| scr_base; PPI port B = tape \| printer \| `jumpers & 0x7F` \| VSYNC bit 0, port C low = keyboard line; keyboard matrix entries joystick 0 `0x90–0x95`, joystick 1 `0x60–0x65`, cursor `0x00/0x01/0x02/0x10`, Return `0x22`, Space `0x57`; ASIC: 16 sprites 16×16 4 bpp, X −256…+767, Y −256…+255, zoom 1/2/4, `asic_colors[32]` 12-bit, `hscroll` 0–15, `vscroll` 0–7, raster interrupt line, split screen, 3 DMA channels, 16-byte unlock sequence. \| Caprice32 `README.md`, `doc/man.html`, `cap32.cfg`, `src/cap32.cpp`, `crtc.cpp`, `keyboard.cpp`, `asic.cpp` (WebFetch) |
| ColEm: `-pal/-ntsc`, `-adam/-cv`, `-sgm/-nosgm`, `-nosound`, `-diska/-tapea` (ADAM), `-home`, `-skip`; screenshots "require -DGIFLIB … [F10]"; emulates SGM, AY8910, 24c08/24c256 EEPROM. | ColEm manual (WebFetch) |
| MAME machine names: `spectrum`, `spec128`, `specpl2a`, `specpls3`; `cpc464`, `cpc664`, `cpc6128`, `cpc464p`, `cpc6128p`, `gx4000`; `sms`, `sms1`, `smspal`, `smsj`, `gamegear`, `sg1000`, `sc3000`; `coleco`, `colecop`; MSX per model (`nms8250`, `fsa1gt`, `hbf1`, `expert10`, …); `-str N` writes a snapshot at exit; `-video none`, `-sound none`, `-nothrottle`; media `-cart`, `-cass`, `-flop1`; `spectrum.cpp`: Z80 = X1/4 = 3.5 MHz, 448×312 raster, 50.08 Hz, 69888 cycles/frame, `kempjoy` expansion default. | MAME `mame.lst` (read raw), `commandline-all.html`, `usingmame.html`, `sinclair/spectrum.cpp` (WebFetch) |
| SDCC 4.6.0 `-m` ports include `z80 z180 r2k… sm83 tlcs90 ez80 z80n r800`; z88dk targets `+zx` (subtypes tap/sna/plus3/rom/if2/dot/bin/wav), `+msx` (rom/rom2/disk/msxdos/msxdos2/bin/wav), `+sms` (default `.sms`, `-subtype=gamegear` `.gg`; classic/newlib/sdcc clibs), `+cpc` (default/dsk/wav/fastwav/noint; native maths), `+coleco` (32 KiB ROM at `$8000`, `-subtype=adam\|bit90`), `+gb` (GBDK lib); GBDK-2020 `-mz80:sms`, `-mz80:gg`, `-mz80:msxdos` (partial). | `SDCCmain.c`, z88dk `lib/config/*.cfg` and wiki, GBDK docs (WebFetch) |
| No Z80 driver in LLVM-MOS; nothing from this family's toolchain or emulator list installed. | `ls ~/.local/opt/llvm-mos/bin`, `which` sweep |

## Where the sources disagree, or were out of reach

- **Amstrad CPC has no primary documentation in this note.** cpcwiki.eu
  sits behind a Cloudflare challenge, cpctech.cpc-live.com is a parked
  domain, grimware.org returned nothing. What is written about the CPC
  comes from Caprice32's *model* of the machine (quoted above) and from
  Wikipedia; every CPC fact not in that table — pixel bit interleaving
  per mode, the 27-color palette values, the 64 µs/312-line frame, the
  300 Hz interrupt period, the firmware jumpblock, the PPI/PSG handshake,
  the disk controller ports — is *to verify* against the Amstrad firmware
  guide (SOFT 968) when it can be fetched.
- **ColecoVision RAM.** `CV-Tech.txt` says "6000-7FFF = SRAM (1K)" — one
  kilobyte, mirrored through the 8 KiB decode block; openMSX's
  `ColecoVision.xml` declares `size=0x2000` at `0x6000`. Treat the
  hardware as 1 KiB mirrored (the CV-Tech reading) and the emulator
  config as generous until a schematic says otherwise; a program must not
  assume the mirrors are distinct bytes.
- **Game Gear LCD window.** The 160×144 window's offset inside the
  256×192 field (recalled as (48, 24)) and how GG mode vs SMS mode is
  selected were on SMS Power pages that 404'd; *to verify*. Port `$00`
  (Start + region bit 6) and stereo port `$06` are verified.
- **Mesen2 and ColecoVision.** `CommandLineHelper.cs` parses a `--cv.*`
  override prefix but `ConsoleType` has no ColecoVision member; whether a
  current build runs Coleco ROMs is *to verify*. Do not list Mesen2 as a
  Coleco emulator yet.
- **MAME `-str` with `-video none`**: each is documented; whether the
  exit snapshot is written with no video system was not run.
- **Spectrum Kempston** bit layout on port `$1F`, the bitmap's interleaved
  row-address formula, the ROM's block-graphics codes and Fuse's mouse
  emulation flags: *to verify* (the 48K reference confirms only that the
  joystick wins on shared ports).
- **MSX**: TMS9918 VRAM-access spacing during the active picture, the
  secondary-slot register at `$FFFF`, `H.TIMI`'s address, megaROM mapper
  layouts, the V9958 horizontal-scroll registers and MSX2+ MSX-MUSIC
  standardisation: *to verify*. C-BIOS's limits (cartridge-only, no
  BASIC, no disk) are recalled, not read.
- **SMS**: Pause = NMI, the Z80 cycles per scanline, and whether GG's CPU
  is 3.58 MHz (MacDonald's doc implies the same VDP clock family;
  Wikipedia's GG page says 3.5 MHz): *to verify*.
- **Wikipedia-only numbers** (model lists, release years, SMS RAM/VRAM,
  Plus-range specs, MSX generation RAM sizes): secondary; *to verify*
  before they reach a package.

## The five machines side by side

| | Spectrum 48K / 128K | MSX1 / MSX2 | SMS / Game Gear | Amstrad CPC | ColecoVision |
| --- | --- | --- | --- | --- | --- |
| Clock | 3.5 / 3.5469 MHz, contended | 3.579545 MHz | 3.58 (NTSC) / 3.55 (PAL) MHz | 4 MHz (GA wait states) | 3.58 MHz |
| RAM | 16/48 K flat; 128 K = 8 banks, one at `$C000` via `$7FFD` | 8–64 K / 64 K+; slots × pages + mapper | 8 K + cart RAM; 3 × 16 K ROM slots via `$FFFD–$FFFF` | 64 K / 128 K in 4 configurations; ROMs shadow reads | **1 K** (SGM 32 K); 32 K cart |
| Video unit | 1-bpp bitmap + 8×8 attribute cells | TMS9918 tables / V9938 tables + bitmaps | Mode 4 tiles 4 bpp, 32×28 map | packed-pixel bitmap via 6845 | TMS9928 tables |
| Text grid | 32×24 (8×8), big border | 40×24 (6×8), 32×24 (8×8); 80×24 MSX2 | 32×24 (8×8); GG sees 20×18 | 40×25 / 20×25 / 80×25 | 32×24 (8×8) |
| Color | 15 colors, 2 per cell | 15 fixed / 512-palette 16 | 64-palette 32 (2×16) / 4096 | 27-palette 16/4/2 per pixel | 15 fixed |
| Scroll | none | V9938 vertical only | X and Y, latched Y, lockable bars | CRTC start address (char steps) | none |
| Sprites | none | 32; **4/line** 1-color (mode 1) — 8/line, per-line color (V9938 mode 2) | 64; **8/line**, 15 colors, collision + overflow flags | none (Plus: 16 ASIC) | 32; **4/line** 1-color |
| Sound | beeper / AY-3-8912 | AY-3-8910 (+FM/SCC options) | SN76489 (+YM2413 Japan; GG stereo) | AY-3-8912 (+Plus DMA) | SN76489 (+SGM AY) |
| Input | 8×5 key matrix on `$FE`; Kempston/Sinclair sticks | 11×8 matrix via PPI; 2 sticks via PSG; mouse | 2 pads `$DC/$DD`; GG Start `$00` | 10×8 matrix via PPI/PSG; sticks in matrix | 2 stick+keypad `$FC/$FF`, mode `$80/$C0` |
| Frame | 50.08 / 50.01 Hz, ULA INT | 60 / 50 Hz, VDP INT via BIOS hook | 60 / 50 Hz, VDP INT + line INT | 50 Hz, **300 Hz INT**, VSYNC on PPI | 60 / 50 Hz, **NMI** |
| Persistence | none (tape/+3 disk) | disk, cart SRAM, RTC | cart battery SRAM | none (tape/disk/cart) | none |
| Headless capture | Fuse `--movie-start` + `fmfconv`; MAME | openMSX `screenshot -raw` | Mesen2 `--testRunner`; MAME | Caprice32 F3 only; MAME | openMSX; MAME |

## Rules for this family

### One CPU, one lowering — and one new language question

- A Z80 lowering is a second IR back end, the way `docs/roadmap.md`
  draws it: the IR must already be free of LLVM-MOS shape (no zero-page
  assumption, no `mos-*` link-script names, no 6502 imaginary
  registers). The Z80 has 16-bit register pairs, IX/IY indexing, `ldir`
  block moves and `in`/`out` — code that is fast on a 6502 (zero-page
  tables, self-modifying loops) is not the idiom here, and the reverse.
- **Ports are a new kind of address.** Every one of these machines
  programs its hardware with `IN`/`OUT` (Spectrum `$FE`/`$7FFD`/`$FFFD`;
  MSX `$98–$9B`, `$A0–$AB`, `$FC–$FF`; SMS `$BE/$BF`, `$7F`, `$DC/$DD`,
  `$3F`; CPC `&7Fxx`, `&BCxx`, `&F4xx` decoded on the *high* byte; Coleco
  `$80/$C0/$FC/$FF/$BE/$BF/$FF`). The language has `@address` for
  memory-mapped registers and nothing for a port. Decide the spelling
  before the backend (a `@port` or an `io` capability), keep it out of
  the IR's memory model, and let the Game Boy — which has no ports —
  simply not import it.
- Two toolchain shapes, as for the Game Boy: keep "emit C" and drive
  SDCC (`-mz80`) through z88dk's `zcc +zx|+msx|+sms|+cpc|+coleco` (which
  owns crt0, output formats — `.tap`, `.rom`, `.sms`/`.gg`, `.dsk` — and
  the machine libraries) or GBDK-2020 (`-mz80:sms`, `-mz80:gg`); or emit
  Z80 assembly directly for `z80asm`/appmake. The first is the cheaper
  proof; the second is where the 8-bit-specific register allocation and
  the port intrinsic actually pay off. Neither is installed; `8bs setup`
  will have to fetch them.

### Four address spaces, not one

- **Flat** (Spectrum 48K, ColecoVision): everything is a pointer, and
  the only rule is *where* it is — Spectrum code above `$8000` to dodge
  contention; Coleco inside 1 KiB.
- **Paged** (Spectrum 128K, SMS): one window (`$C000` / slot 2) whose
  content is a write-only register's business. The root rule applies:
  (bank, offset) is not a pointer. The Spectrum's `$7FFD` bit 5 turns the
  register off for good; the SMS's `$FFFC–$FFFF` overlap the RAM mirror
  so their last value can be read back.
- **Slotted** (MSX): a byte is (primary slot, secondary slot, mapper
  segment, offset) — three levels before the address. Only a build that
  fixes the machine's slot layout (or asks the BIOS at start-up, the
  X16-`MEMTOP` way) can turn that into a pointer. This is the reason an
  MSX package will read its RAM location from a profile file, never
  probe it, exactly as `packages/pet` reads its width.
- **Configured** (CPC 6128): the Gate Array selects one of eight *named
  layouts* of 16 KiB banks, not a bank number; configuration 2 replaces
  all four pages including the stack's. The ROM overlays for reads only.
  Model a configuration as an enum the linker knows, never as arithmetic.

### Video five ways

- **Spectrum**: the only true framebuffer in the family, and a
  two-colors-per-cell one. A portable text/tile capability is a font
  blit plus an attribute write; a sprite capability is software with an
  attribute budget (a moving object recolors every cell it touches).
  The 128K's shadow screen is the one double buffer. Never queue VRAM
  writes for a vblank — there is no lock; sync to `/INT` for tearing
  only.
- **CPC**: also a framebuffer, with no attribute clash but with packed,
  interleaved pixels (2/4/8 per byte by mode) and a CRTC-shaped address
  (rows `&800` apart). Sprites are software and masked. Hardware scroll
  exists but in character steps. The Plus range's ASIC sprites, palette
  and soft scroll are a **profile**, not "the CPC".
- **MSX1 / ColecoVision**: TMS9918 tables — the NES-shaped model
  (patterns, name table, sprite attributes) with 4 single-color sprites
  per line and, on the Coleco, no scroll register at all. The vblank
  queue rule from `packages/nes` applies to VRAM *bandwidth* (port
  spacing on the TMS9918, *figure to verify*), not to a hard lock.
  SCREEN 2's "bitmap" is 768 patterns with 2 colors per 8×1 row — a
  tile mode wearing a bitmap coat.
- **MSX2 (V9938)**: the same tables plus real bitmap modes with a
  512-color palette, vertical scroll, page flipping, block-copy commands
  and 8 multicolored sprites per line. Treat MSX1 and MSX2 as two
  targets sharing a package, the way `vic20`'s memory twins work, not as
  one target with feature flags.
- **SMS/GG**: the richest tile machine here — 4 bpp tiles, per-tile flip
  and priority, both scroll registers with lockable status-bar zones, a
  line interrupt, 8 sprites per line with hardware collision and
  overflow flags. Its constraint is the two-byte VDP command: an
  interrupt between the bytes corrupts the address, so VDP access is
  atomic or interrupt-free by construction. **Game Gear is an SMS
  profile with a 160×144 viewport and a 12-bit palette** — every HUD and
  text surface must fit the window.

### Sprites: 0 / 4 / 8 per line

- "32 sprites" (MSX, Coleco) and "64 sprites" (SMS) are attribute-table
  sizes; the constraints are 4 or 8 per scanline, 1 color (TMS9918) or
  15 (SMS) per sprite, and the terminator conventions (`Y = $D0`). The
  tooling counts per line, as for the NES; Spectrum and CPC report zero
  and a software substitute.
- Collision flags (TMS9918 S#0 bit 5, SMS status bit 5) say *that* two
  sprites overlapped, never which — software collision remains the
  portable primitive.

### Audio: a PSG, mostly

- Three of the five (128K Spectrum, MSX, CPC) carry an AY-3-891x: 3
  square voices, 1 noise, one shared envelope, 4-bit volume, no filter.
  Two (SMS/GG, Coleco) carry an SN76489: 3 square voices, 1 noise, 4-bit
  attenuation, no envelope. A note-level capability maps onto "3 tone +
  1 noise" everywhere except the 48K Spectrum, whose beeper is a
  CPU-timed 1-bit line — the PET's CB2 case again. FM (YM2413 on the
  Japanese SMS / MSX-MUSIC), SCC, the CPC Plus DMA and the Coleco SGM's
  AY are optional hardware behind a profile or a probe (`$F2` detection
  on the SMS), never assumed from the machine name. No machine here has
  a hardware entropy source.

### Input: matrices you scan, pads you read

- Spectrum, MSX and CPC keyboards are matrices read a row at a time
  (through `$FE`, the PPI, or the PPI-plus-PSG) with ghosting beyond two
  keys — the PET's snapshot-once-per-frame rule transfers directly.
  Joysticks on the Spectrum and CPC are *keys* in that matrix (Kempston
  excepted); on the MSX they hang off the PSG's I/O registers; on the
  SMS and Coleco they are dedicated ports with active-low bits. The
  Coleco's keypad arrives diode-encoded as a 4-bit code, and its two
  reading modes are selected by writing to `$80`/`$C0`. Only the MSX has
  a standard mouse.

### Timing and the frame edge

- 50 Hz (Spectrum, CPC, PAL MSX/SMS/Coleco) and 60 Hz (NTSC MSX/SMS/GG/
  Coleco) coexist inside the family; the backend's frame-ratio logic
  already handles that. What differs is the *edge*: a maskable `/INT`
  once a frame (Spectrum, MSX via the BIOS hook, SMS via the VDP flag
  cleared by reading `$BF`), an **NMI** once a frame (ColecoVision —
  unmaskable, so VDP access must be guarded), or **six interrupts a
  frame** (CPC's 300 Hz Gate Array counter, with VSYNC readable on PPI
  port B). `waitFrame()` needs a driver per machine, as `FRAME_SYNC` has
  per 6502 target.

### Emulators and verification

- Verified headless-screenshot routes: **openMSX** for MSX *and*
  ColecoVision (`-script` with `screenshot -raw`, `after time`, `exit`,
  `renderer none`; `-diska <dir>` is also the only host-directory mount
  in the family); **SameBoy**-style tester does not exist here, but
  **Mesen2 `--testRunner`** + Lua covers SMS/GG (and Game Boy); **Fuse**
  records an FMF movie that `fmfconv` turns into PNG frames; **MAME**
  covers every machine with `-str N` (snapshot on exit) and per-model
  names. Caprice32 (F3) and ColEm (F10 + GIFLIB) are interactive only.
  Wrap whichever route a target gets in `8bs run --screenshot` and
  record the emulator revision beside every measurement.

## Where things live

```
(nothing yet)
docs/roadmap.md                                  Phase 8: "gameboy, then z80"; the second-backend diagram
packages/backend-6502/src/index.mjs              the only lowering today; FRAME_SYNC per target is the shape the Z80 frame drivers mirror
packages/pet/AGENTS.md, packages/nes/AGENTS.md   the profile-file rule and the vblank-queue rule these machines reuse
tmp/research/{spectrum,msx,sms,cpc,colecovision}.schema.md   one 16-row schema per machine, for the capability matrix
tmp/research/gameboy.md, gameboy.schema.md       the other Phase 8 CPU
```
