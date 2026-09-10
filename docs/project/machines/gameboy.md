---
title: Game Boy / Game Boy Color
nav_order: 40
---

# Writing Game Boy / Game Boy Color support for 8BitScript

This file is for anyone — human or agent — touching a future
`packages/gameboy`, the first non-6502 backend the roadmap's Phase 8 asks
for (`docs/roadmap.md`: "Add: `gameboy`, then `z80`"), the `gameboy` rows
of `docs/roadmap.md`, or the emulator/toolchain setup that backend will
need. Read the root [`AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/AGENTS.md) first; the rules there
apply to every target and are not repeated.
[`packages/nes/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/nes/AGENTS.md) is the closest existing
contrast — the Game Boy is a tile-and-object machine like the NES, with a
mapper axis like the NES — and the differences are exactly the ones that
make "port the NES package" the wrong plan. The Game Boy is a fourth case:

> **The Game Boy is a tile machine whose CPU is *not* a 6502 and not a Z80
> either: an 8080-shaped core with no I/O instructions, whose "ports" are
> memory at `$FF00`, whose video memory is locked for most of every
> scanline, whose sprite limit is ten *per line by Y*, and whose color,
> RAM, VRAM and speed all double on the Color model. Model it as tiles +
> two 32×32 maps + 40 objects behind a per-scanline access schedule, with
> the cartridge — not the console — deciding how much ROM, RAM and
> persistence exist.**

The machine's variety is in two axes that must stay separate: the *model*
(DMG, MGB, SGB, CGB, AGB — header byte `$0143` says whether a program is
DMG-only, CGB-enhanced or CGB-only) and the *cartridge* (header `$0147`:
ROM-only, MBC1/2/3/5, with or without RAM, battery, RTC, rumble). A
program built for one point in that grid does not run — or does not save —
on the others.

## What exists today

Nothing. There is no `packages/gameboy`, no SM83 backend, no IR lowering
other than `packages/backend-6502` (which emits C and drives
`mos-*-clang`), and no `gameboy` profile, emulator flag or setup command.
`ls ~/.local/opt/llvm-mos/bin` lists only `mos-*` drivers for 6502-family
platforms — there is no LLVM-MOS route to this CPU at all. None of RGBDS,
GBDK-2020, SDCC, z88dk, SameBoy, mGBA, Mesen2, BGB or MAME is installed
on this machine (`which` finds none of them). The roadmap places the
target in Phase 8, after every 65xx machine, precisely so that the IR is
proven free of LLVM-MOS assumptions before a second lowering is written.

The rules below are what to hold that work to when it comes; don't write
docs implying any of it exists.

## Facts verified here

Cite these freely; each was read in the source named — the Pan Docs
Markdown sources (`gbdev/pandocs`, `src/*.md`) fetched raw, or the
emulator/toolchain source or manual named — not recalled.

| Fact | Where |
| ---- | ----- |
| CPU: "8-bit 8080-like Sharp CPU (speculated to be a SM83 core)"; master clock 4.194304 MHz, system clock ¼ of it; CGB up to 8.388608 MHz; SGB1 clock derived from the SNES, SGB2 same as handhelds; DMG units run 50–70 ppm slow. | `Specifications.md` |
| WRAM 8 KiB (CGB 32 KiB = 4 + 7×4); VRAM 8 KiB (CGB 2×8); 160×144; objects 8×8/8×16, max 40 per screen, **10 per line**; palettes DMG BG 1×4, OBJ 2×3; CGB BG 8×4, OBJ 8×3, 32768 colors; H-sync 9.198 kHz, V-sync 59.73 Hz; 4 sound channels, stereo. | `Specifications.md` |
| Memory map: `0000–3FFF` ROM bank 00; `4000–7FFF` ROM bank 01–NN via mapper; `8000–9FFF` VRAM (CGB bank 0/1); `A000–BFFF` external RAM; `C000–CFFF` WRAM; `D000–DFFF` WRAM (CGB bank 1–7); `E000–FDFF` echo (prohibited); `FE00–FE9F` OAM; `FEA0–FEFF` unusable; `FF00–FF7F` I/O; `FF80–FFFE` HRAM; `FFFF` IE. Vectors: RST `$00–$38`, interrupts `$40/$48/$50/$58/$60`; header `$0100–$014F`. | `Memory_Map.md` |
| No IN/OUT: "I/O ports are accessed directly by normal LD instructions, or by new LD (FF00+n) opcodes". No IX/IY, no DD/FD/ED prefixes, no EXX/EX, no sign/parity flags; adds `LDI/LDD`, `SWAP`, `STOP`, `RETI`, `ADD SP,dd`, `LD HL,SP+dd`; "approximately as fast as a 4 MHz Z80"; all instruction times are multiples of 4 cycles; unused opcodes lock the CPU. | `CPU_Comparison_with_Z80.md` |
| Tiles 8×8, 2 bpp, 16 B; 384 per bank (768 CGB) in three 128-tile blocks; objects always use `$8000` addressing; BG/Window use `$8000` (unsigned) or `$8800` (signed, base `$9000`) by LCDC.4; block 1 (`$8800–$8FFF`, ids 128–255) is shared. | `Tile_Data.md` |
| Two 32×32 maps at `$9800` and `$9C00`; either serves BG or Window; CGB attribute map in bank 1 (bit 7 priority, 6 Y flip, 5 X flip, 3 bank, 2–0 palette). BG scrolls by SCX/SCY and wraps; the Window is not scrollable, sits at (WX−7, WY), has its own line counter; on DMG LCDC.5 needs LCDC.0. | `Tile_Maps.md`, `Scrolling.md` |
| OAM: 40 entries × 4 bytes (Y+16, X+8, tile, attributes: 7 priority, 6 Y flip, 5 X flip, 4 DMG palette, 3 CGB bank, 2–0 CGB palette). Selection during OAM scan is by Y only, first 10 in OAM order; "an off-screen value (X=0 or X>=168) hides the object, but the object still contributes to the limit of ten objects per scanline"; hide with Y=0 or Y≥160. Drawing priority: DMG smaller X first then OAM order; CGB OAM order only. OAM writable only in HBlank/VBlank; recommended route is a WRAM buffer + OAM DMA. | `OAM.md` |
| OAM DMA: write source high byte to `$FF46`; 160 bytes in 160 M-cycles (640 dots); on DMG the CPU may access only HRAM during it. | `OAM_DMA_Transfer.md` (WebFetch) |
| PPU modes per line: 2 = OAM scan 80 dots (VRAM open), 3 = drawing 172–289 dots (nothing open), 0 = HBlank remainder (VRAM, OAM, CGB palettes open), 1 = VBlank 4560 dots = 10 lines; 154 lines per frame, 144 visible; a frame is ~16.74 ms, 0.45 % slower than 60 Hz; blocked writes are ignored, blocked reads return `$FF`. Mode 3 penalties: SCX%8, +6 for the Window, 6–11 per object. | `Rendering.md`, `Accessing_VRAM_and_OAM.md` (WebFetch) |
| LCDC `$FF40`: 7 LCD on, 6 Window map, 5 Window on, 4 BG/Win tile data area, 3 BG map, 2 OBJ size, 1 OBJ on, 0 BG/Win enable (DMG) / master priority (CGB). "Stopping LCD operation … may be performed during VBlank ONLY … may damage the hardware". LCDC is never locked and may be changed mid-scanline (status-bar trick: toggle LCDC.1). | `LCDC.md` |
| STAT `$FF41`: mode bits, LYC=LY, four interrupt selects; LY `$FF44` 0–153 (144–153 = VBlank); LYC `$FF45`. | `STAT.md` (WebFetch) |
| DMG palettes: BGP `$FF47` (2 bits per index, 0 white … 3 black), OBP0/1 `$FF48/49` (index 0 transparent). CGB: 8 BG + 8 OBJ palettes, RGB555 little-endian in two 64-byte CRAMs via BCPS/BCPD `$FF68/69`, OCPS/OCPD `$FF6A/6B`; boot ROM initializes BG palettes white; GBA renders CGB colors darker (`GBA ≈ GBC×3/4 + $08`). | `Palettes.md` |
| CGB: A = `$11` at boot (B bit 0 set = GBA); KEY1 `$FF4D` + `stop` switches speed — CPU, timers, serial and OAM DMA double, PPU/HDMA/APU do not; VBK `$FF4F` bit 0; SVBK `$FF70` bits 0–2 (0 → bank 1); HDMA `$FF51–$FF55` general-purpose (halts CPU) or HBlank (16 B per HBlank) — "allows for a transfer of 2280 bytes during VBlank, which is up to 142.5 tiles"; OPRI `$FF6C`; IR `$FF56`; header `$0143` `$80` (dual) / `$C0` (CGB only). | `CGB_Registers.md` |
| APU: CH1 pulse + sweep, CH2 pulse, CH3 wave (user-supplied), CH4 noise LFSR; envelopes on 1/2/4 ticked at 64 Hz; length timers at 256 Hz (64 or 256 steps); per-channel stereo mix and master volume; VIN cartridge input; APU timing unaffected by double speed. | `Audio.md` |
| MBCs live in the cartridge, declared at `$0147`; only MBC5 is guaranteed for double speed; MBC3 = 2 MB (128 banks) + 32 KiB (4 banks) + RTC (`$08–$0C` select, latch); MBC5 = ROM banks `$000–$1FF`, RAM 8/32/128 KiB (`$00–$0F`), rumble on RAM-bank bit 3, "writing 0 will indeed give bank 0". | `MBCs.md`, `MBC3.md`, `MBC5.md` |
| Header: `$0147` cartridge type (`$00` ROM ONLY … `$03` MBC1+RAM+BATTERY … `$10` MBC3+TIMER+RAM+BATTERY … `$1B` MBC5+RAM+BATTERY, `$1E` MBC5+RUMBLE+RAM+BATTERY, `$FE` HuC3, `$FF` HuC1+RAM+BATTERY); `$0148` ROM size `$00`=32 KiB … `$08`=8 MiB; `$0149` RAM size `$00` none, `$02` 8 KiB, `$03` 32 KiB, `$04` 128 KiB, `$05` 64 KiB; `$0146` SGB = `$03`; header checksum `$014D` over `$0134–$014C`. | `The_Cartridge_Header.md` (WebFetch) |
| Boot ROM hands over with SP = `$FFFE` on every model. | `Power_Up_Sequence.md` |
| CH3 output level NR32 `$FF1C` bits 6–5: mute / 100 % / 50 % / 25 % (shift the 4-bit samples). | `Audio_Registers.md` |
| MBC1: "max 2MByte ROM and/or 32 KiB RAM" — default wiring 512 KiB ROM + 32 KiB RAM (four 8 KiB banks), the 1 MiB+ wiring gives 2 MiB ROM with 8 KiB RAM; registers default to `$00`, ROM bank `$00` reads as `$01`. | `MBC1.md` |
| Joypad `$FF00`: bit 5 selects buttons, bit 4 selects D-pad, low nibble read-only, pressed = 0, `$30` written → `$F` read; programs read several times to debounce; joypad interrupt `$60`. | `Joypad_Input.md` |
| Interrupts: IME write-only, off at start, `ei` delayed one instruction; IE `$FFFF`/IF `$FF0F` bits VBlank, LCD, Timer, Serial, Joypad (priority in that order); dispatch takes 5 M-cycles. | `Interrupts.md` |
| Timers: DIV `$FF04` 16384 Hz; TAC rates 4096/262144/65536/16384 Hz; TIMA overflow reloads TMA and interrupts. | `Timer_and_Divider_Registers.md` (WebFetch) |
| SameBoy builds `cocoa`, `sdl`, `libretro`, `ios`, `lib`, `bootroms`, **`tester`** targets; SDL usage `sameboy_sdl [--fullscreen\|-f] [--nogl] [--stop-debugger\|-s] [--model <model>] <rom>` with models `auto dmg-b dmg sgb-ntsc sgb-pal sgb2 sgb mgb cgb-0 … cgb-e cgb agb-a agb gbp-a gbp`. | SameBoy `README.md`, `SDL/main.c` (WebFetch) |
| SameBoy Tester: `--dmg`, `--sgb`, `--cgb`, `--tga`, `--start` (auto-press Start/A), `--length seconds` (default 40), `--boot path`, `--sav` (write battery file), `--jobs n`; writes `<rom>.bmp` (or `.tga`) and `<rom>.log`; runs 60×length frames. | SameBoy `Tester/main.c` (WebFetch) |
| mGBA CLI: `-b bios`, `-c cheats`, `-C OPTION=VALUE`, `-d` debugger, `-g` gdb, `-l loglevel`, `-t savestate`, `-p patch`, `-s N` = **frameskip**, `-f` fullscreen, `--scale`; no screenshot, frame-limit or `--script` option. Scripting: `emu:screenshot(filename)`, `emu:runFrame()`, `callbacks:add("frame", …)` exist, loaded from the Qt *Tools → Scripting* menu. | mGBA `src/feature/commandline.c`, `docs/scripting.html` (WebFetch) |
| Mesen2: `ConsoleType {Snes, Gameboy, Nes, PcEngine, Sms, Gba, Ws}`; `GameboyModel {AutoFavorGbc, AutoFavorSgb, AutoFavorGb, Gameboy, GameboyColor, SuperGameboy}`; CLI `--testRunner` ("runs a Lua script in headless mode"), `--doNotSaveSettings`, `--fullscreen`, `--loadLastSession`, `--recordMovie`, `--noVideo/--noAudio/--noInput`, `--gameBoy.*` etc. overrides; Lua `takeScreenshot` returns the video decoder's bytes. | Mesen2 `SettingTypes.h`, `CommandLineHelper.cs`, `LuaApi.cpp` (WebFetch) |
| MAME machine names `gameboy`, `gbcolor`, `gbpocket`; `-str N` "will write a screenshot to the system's snapshot directory" at exit; `-video none`, `-sound none`, `-nothrottle`, `-cart`. | MAME `src/mame/mame.lst` (read raw), `commandline-all.html` (WebFetch) |
| RGBDS = `rgbasm`, `rgblink`, `rgbfix`, `rgbgfx`; the manual's ISA name is "gbz80"; sections `ROM0` `$0000–$3FFF` (or `–$7FFF` tiny mode), `ROMX` `$4000–$7FFF` banked, `VRAM` bank 0/1, `SRAM` `$A000–$BFFF` banked, `WRAM0` `$C000–$CFFF` (or `–$DFFF` WRAM0 mode), `WRAMX` `$D000–$DFFF` bank 1–7, `OAM`, `HRAM` `$FF80–$FFFE`; `rgbfix -C`/`-c` (CGB only/compatible), `-m <mbc name>` (e.g. `MBC5+RAM+BATTERY`, `TPP1 1.0`), `-r ramsize`, `-p pad`, `-t title`, `-v` (fix logo + checksums), `-j`, `-s`. | RGBDS `README.md`, `man/rgbasm.5`, `man/rgbfix.1` (WebFetch) |
| GBDK-2020 wraps a patched SDCC; platforms Game Boy/Color, Analogue Pocket, Mega Duck, SMS, Game Gear, NES, MSX-DOS (partial); `lcc -m<port>:<plat>` with `-msm83:gb`, `-msm83:ap`, `-msm83:duck`, `-mz80:sms`, `-mz80:gg`, `-mz80:msxdos`, `-mmos6502:nes`; header via `-Wl-yt` (cart type), `-Wl-yo` (ROM banks), `-Wl-ya` (RAM banks), `-Wm-yc` (CGB), `-Wm-ys` (SGB), `-Wm-yn` (name); `#pragma bank`, `-autobank`; caveat "VRAM … should only be written to when the STATF_B_BUSY bit of STAT_REG is off". | GBDK-2020 `README.md`, `docs_supported_consoles.html`, `docs_toolchain_settings.html` (WebFetch) |
| SDCC 4.6.0 (June 2026) targets include `z80 z180 r2k … sm83 tlcs90 ez80 z80n r800 … mos6502 mos65c02 huc6280`; option `-m<port>`, "e.g. -mz80". | sdcc.sourceforge.net, `SDCCmain.c` (WebFetch) |
| z88dk supports the 8080/Z80 family "including … gbz80"; `+gb` target uses the GBDK library. | z88dk `README.md`, wiki *Platform* (WebFetch) |
| No `mos-*` driver for SM83 or Z80; no SDCC/z88dk/RGBDS/GBDK or Game Boy emulator installed. | `ls ~/.local/opt/llvm-mos/bin`, `which` sweep |

## From the sources, not verified here

- **BGB** is Windows-only (runs under Wine); its debugger and
  screenshot facilities were not checked.
- Mesen2's `takeScreenshot` format (PNG?) and whether `--testRunner`
  writes it to disk without a display were not run.
- MAME: whether `-str` still writes a snapshot under `-video none` was
  not tested; the docs describe each option separately.
- SDCC's `-msm83` was `-mgbz80` in older releases; the rename version is
  *to verify*.
- The exact SGB border/palette command packets, the CGB "PGB" mode, and
  MBC1's multicart modes were skimmed, not read.

## Rules for this target

### The CPU is neither a 6502 nor a Z80

- Every device is a byte at `$FF00–$FF7F`; the language's `@address`
  spelling covers it. This is the one machine in Phase 8 that does *not*
  need an I/O-port intrinsic — the Z80 family does (see
  `z80-family.md`). Write registers as addresses, and keep that fact out
  of the shared IR: the Z80 lowering will need `in`/`out` where this one
  needs `ld`.
- Only 127 bytes of HRAM are fast (`ldh`) and only HRAM is reachable
  during OAM DMA; the OAM-DMA wait loop and the hottest zero-page-style
  variables belong there. Treat HRAM as the SM83's "zero page", but it is
  127 bytes, not 256 — and the boot ROM leaves SP at `$FFFE`, the top
  of HRAM, so a program that wants HRAM for variables moves the stack
  to WRAM first.
- No hardware multiply or divide (same rule as the root `AGENTS.md`);
  16-bit arithmetic is cut down and IX/IY-style indexed addressing does
  not exist — `HL` with `ldi`/`ldd` is the streaming idiom.
- Interrupts are off at start and `ei` is late by one instruction;
  `halt` is the frame wait (with the `halt` bug when IME is off *to
  verify*). Dispatch pushes PC only: handlers save what they use.

### Memory is three kinds, and the cartridge decides two of them

- ROM0, WRAM bank 0, HRAM and I/O are plain addresses. ROMX
  (`$4000–$7FFF`), SRAM (`$A000–$BFFF`) and CGB WRAMX (`$D000–$DFFF`) are
  (bank, offset) pairs: the same root rule as the C128/X16 banked
  windows, with the twist that the ROM bank register is *written into the
  ROM address space* (MBC-specific ranges) and the RAM bank register is
  too. The linker owns bank placement (RGBDS `ROMX` sections, GBDK
  `#pragma bank`/`-autobank`); a program never computes a bank.
- The mapper is a **profile**, exactly like `ATARI8_PROFILES`/NES
  mappers in `packages/backend-6502`: `rom-only` (32 KiB, no RAM, the
  NROM of this machine), `mbc1`, `mbc3` (+RTC), `mbc5` (+rumble), each
  with RAM 0/8/32/128 KiB and battery or not. Persistence exists only when
  the profile says `+BATTERY`; MBC3's clock only with `+TIMER`. Header
  bytes `$0147/$0148/$0149` are outputs of the profile, never hand-edited.
- CGB WRAM banks 1–7 are extra RAM, not more of the same RAM: a DMG build
  has 8 KiB and a CGB-only build 32 KiB, and a dual build must not touch
  SVBK before checking A = `$11` at boot.

### Video is a schedule, not a memory

- VRAM and OAM are open only in Mode 0 (HBlank), Mode 1 (VBlank), and —
  for VRAM only — Mode 2. Writes outside those windows are silently
  dropped and reads return `$FF`. Every VRAM/OAM write path goes through
  the runtime's vblank queue (the NES package's rule applies here in
  full), through OAM DMA from a WRAM shadow, or runs with the LCD off
  during load. The budget is 10 lines ≈ 1140 M-cycles per frame in
  VBlank plus the HBlank slivers; CGB HDMA moves 2280 bytes per VBlank
  with the CPU stalled for the transfer but no store instructions to
  write (general-purpose DMA halts the program until done; HBlank DMA
  halts it 16 bytes at a time).
- Turning the LCD off (LCDC.7) is allowed only inside VBlank — Pan Docs
  says otherwise "may damage the hardware". The compiler should refuse a
  compile-time write of LCDC with bit 7 clear outside a known-VBlank
  context the way `8BS3003` refuses the PET's killer poke, if a hazard
  entry is ever added; until then the runtime's own LCD-off helper must
  wait for LY ≥ 144.
- Tiles are the only pixels. A text capability is a font of 8×8 tiles
  plus a map write; `text.COLUMNS` is 20 (visible) on a 32-wide map, and
  the map is where the NES-style "flat cell index" needs a stride of 32,
  not 20. The Window is the natural status bar (it cannot scroll and its
  X is offset by 7).
- Palettes: DMG has one BG palette (4 shades) and two OBJ palettes
  (3 + transparent); CGB has 8 + 8 of RGB555, chosen per tile through the
  bank-1 attribute map. A portable "color" is therefore a palette
  *index* per tile, never an RGB value — and a DMG build has exactly four
  of them.
- The BG addressing mode (LCDC.4) changes which tile index 0 means; pick
  one per build (`$8000` unsigned is the simplest) and let the asset
  pipeline number tiles for it.

### Sprites are ten per line, chosen by Y

- 40 objects, but the constraint is **10 per scanline selected by Y
  alone** in OAM order. A hidden object with X = 0 still consumes a slot
  on every line its Y covers; hide by Y (`0` or `≥160`). The tooling
  should count objects per Y-band the way the NES tooling should count
  per line, and metasprites (8×16 pairs) count double vertically.
- Priority between objects is by X on DMG and by OAM order on CGB — code
  that relies on overlap order behaves differently per model; sort OAM
  explicitly.
- There is no collision hardware. Software collision only.
- Objects always index tiles from `$8000` and share block 1 with the
  background; an asset pipeline must budget 256 object tiles against
  the background's 256.

### Audio is four fixed instruments

- CH1/CH2 pulse (four duties, CH1 has a sweep), CH3 a 32-sample 4-bit
  wave you upload, CH4 LFSR noise. Envelopes are hardware (64 Hz ticks)
  on 1, 2 and 4 only; there is no filter. A note-level API maps onto four
  named voices with fixed roles — never "four voices" as if
  interchangeable, and never SID-style waveform selection.
- The wave channel is the PCM route (and the reason for the CGB0
  boot-ROM wave-RAM caveat); CH3 volume has only four steps.
- Hardware entropy: none. Deterministic PRNG only, per the root rule.

### Input is one register

- Eight buttons behind `$FF00` in two selectable nibbles, active low,
  read several times to settle. There is no keyboard, mouse, paddle or
  second controller (SGB exposes up to four SNES pads through the same
  register — a profile capability, not a Game Boy fact).

### Timing

- 59.73 Hz, always; no PAL/NTSC axis (SGB1 is 2.4 % fast — its APU pitch
  shifts too). `frameRate` defaults of 60 fit with the same ratio logic
  the 6502 backend uses; the frame edge is the VBlank interrupt (`$40`) or
  LY ≥ 144.
- CGB double speed doubles CPU work per frame but not VBlank length in
  dots: the VRAM budget stays 10 lines.

### Emulator and toolchain

- Headless verification route today: **SameBoy Tester** —
  `sameboy_tester --cgb --length 2 --sav main.gbc` writes `main.bmp`,
  and `--dmg`/`--sgb` pick the model. That is the equivalent of this
  project's `-limitcycles -exitscreenshot` under VICE; wrap it the way
  `8bs run --screenshot` wraps the others (BMP → PNG conversion needed).
  Mesen2's `--testRunner` + Lua is the second candidate and also covers
  SMS/GG. mGBA has no CLI capture. Pin the emulator revision with any
  measurement, as `packages/cx16/AGENTS.md` does.
- Toolchain: two shapes fit the existing compiler.
  1. Keep "emit C": drive GBDK-2020's `lcc -msm83:gb` (SDCC underneath),
     with header flags from the profile (`-Wl-yt`, `-Wl-yo`, `-Wl-ya`,
     `-Wm-yc`) and `-autobank`. Cheapest; the C runtime and bank
     pragmas are GBDK's.
  2. A second IR lowering emitting SM83 assembly for RGBDS
     (`rgbasm` → `rgblink` → `rgbfix -v -m MBC5+RAM+BATTERY -r 3 -c`),
     with sections typed `ROM0/ROMX/WRAM0/WRAMX/HRAM/SRAM/VRAM`. More
     work, no C in the loop, and the section types map cleanly onto the
     language's "which side" rule.
  Either way `docs/roadmap.md`'s promise holds only if nothing SM83- or
  LLVM-specific leaks into the IR; the frame prologue, `waitFrame()`
  driver and hazard table need per-backend entries, not per-target hacks.

## Where things live

```
(nothing yet)
docs/roadmap.md                          Phase 8: "gameboy, then z80"; the two-backend diagram
packages/backend-6502/src/index.mjs      the only backend: emits C, drives mos-*-clang — the shape a second backend must mirror
packages/nes/AGENTS.md                   the closest existing target: tile/nametable video, vblank queue, mapper profiles
gbdev/pandocs src/*.md                   the primary reference every hardware fact above was read in
LIJI32/SameBoy Tester/main.c             the headless screenshot tool and its flags
gbdev/rgbds man/rgbasm.5, rgbfix.1        section types and header flags for a direct-assembly backend
gbdk-2020 docs                           lcc -msm83:gb and the header/bank flags for an emit-C backend
```
