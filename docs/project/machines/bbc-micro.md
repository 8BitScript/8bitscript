---
title: BBC Micro
nav_order: 12
---

# Writing BBC Micro support for 8BitScript

This file is for anyone — human or agent — touching a future
`packages/bbc-micro`, a `BBC_PROFILES` entry in `packages/backend-6502`,
a `FRAME_SYNC.bbc` driver, a BBC emulator entry in
`packages/cli/src/run.mjs`, or the BBC rows of `docs/roadmap.md` (Phase 5)
and `packages/studio/AGENTS.md`. Read the root `AGENTS.md` first; the rules
there apply to every target and are not repeated. `packages/cx16/AGENTS.md`
is the nearest contrast: a machine whose firmware is the API, where the
right move is usually to call the OS rather than the chip —

> **The BBC Micro is a 2 MHz 6502 with an operating system that expects to
> be used: OSWRCH, OSBYTE, OSWORD and the VDU stream are the portable way
> to draw, sound, read keys and wait for a frame, and they keep a program
> honest across Model B, B+, Master and a Tube second processor. Underneath
> is a 6845 CRTC and a Video ULA producing eight modes that trade text
> width, pixels and colors against 1K to 20K of the program's own RAM, a
> Teletext chip for the cheap mode, an SN76489 for sound, and 16 K sideways
> ROM/RAM slots. Model it as "a mode is a memory budget and a color
> depth", never as "a C64 with a bitmap".**

The family's variety is in *models*: Model A (16K) and B (32K) with
paged ROM slots, B+ 64K/128K (20K shadow screen RAM, 12K private RAM,
sideways RAM), Master 128 (65C02-class CPU, 128K, shadow RAM, HAZEL/ANDY
private RAM, four sideways RAM slots, 1770 disc, RTC/CMOS), Master
Compact, the disc controller (8271 vs 1770) and the Tube (a second
processor that runs the program while the host becomes an I/O processor).

## What exists today

Do not describe more than this as working:

- There is no `packages/bbc-micro`, no `BBC_PROFILES`, no `FRAME_SYNC.bbc`,
  no emulator entry in `packages/cli`, and no `docs/setup/bbc-micro.md`.
- **No LLVM-MOS platform exists for the BBC**, installed or upstream
  (`~/.local/opt/llvm-mos/mos-platform/` and upstream `main` both lack any
  `bbc`/`acorn` directory; the SDK README does not list it; issue #322
  "Import @davidgiven's support for new targets" is the only trace).
- **cc65 has no C runtime for the BBC either**: there is no `bbc.h` and no
  `bbc.html`; what exists is an assembler-level target (`cfg/bbc.cfg`,
  the `__BBC__` symbol in the `ca65` docs).
- No BBC emulator is installed (`b-em`, `beebem`, `mame` are not on PATH;
  MAME is a Homebrew formula, 0.289).

The rules below are what to hold that work to when it comes.

## Facts verified here

Cite these freely; each was read in the source named, not recalled.
Nothing in this file was seen on screen — no BBC emulator is installed.

| Fact | Where |
| ---- | ----- |
| Screen modes (Model B addresses; ULA control byte in parentheses): **0** 80×32 text, 640×256, 1 bpp, 20480 bytes `&3000-&7FFF` (`&9C`); **1** 40×32, 320×256, 2 bpp, 20480 bytes `&3000` (`&D8`); **2** 20×32, 160×256, 4 bpp (8 steady + 8 flashing), 20480 bytes `&3000` (`&F4`); **3** 80×25 text only, 8×10 cells with 2 blank lines, 16384 allocated / 16000 on screen `&4000-&7FFF` (`&9C`); **4** 40×32, 320×256, 1 bpp, 10240 bytes `&5800` (`&88`); **5** 20×32, 160×256, 2 bpp, 10240 bytes `&5800` (`&C4`); **6** 40×25 text only, 8×10 cells, 8192 allocated / 8000 on screen `&6000` (`&88`); **7** 40×25 Teletext, 1024 allocated / 1000 on screen `&7C00-&7FFF` (`&4B`). Cells are 8×8, user definable (VDU 23), pixels 1:2 tall in modes 0/3, 2:1 wide in 2/5. Default palettes: 2-color modes black/white; 4-color black/red/yellow/white; mode 2 logical = physical 0-15. CRTC register tables are in MOS 1.20 at `&C46E..&C4A9`. | BeebWiki `MODE_0` … `MODE_7` |
| Master 128 mode table (Acorn literature): modes 0-7 as above with "8 shadow modes providing the same displays without affecting user memory"; the Master has "64KB main RAM, 64KB sideways RAM consisting of four 16K pages", 128KB ROM (35K MOS, BASIC 4, Edit, View, ViewSheet, ADFS, 1770 DFS), 65C102 at 2 MHz, two cartridge slots (ROM numbers 0-3), Econet, RS-423, 1 MHz bus, Tube internal and external, RTC. | BeebWiki `Master_128` |
| Mode 7: SAA5050 driven by ASCII-variant bytes in memory; text color and graphics are switched "line-by-line, using control codes that occupy a character cell"; interlace forced on, rows 20 scanlines deep; the MOS's graphics calls, `COLOUR` and VDU 19 do nothing in mode 7; graphics codes need bit 7 set although the chip is 7-bit; the display is one cell right of mode 6; 24 bytes of the 1K are off screen and not usable; hardware scrolling wraps `&7FFF` → `&7C00`. Infobox: 40×25, "78 × 75 (block graphics, user generated)", 12×20 pixel characters interpolated from a 6×10 matrix. | BeebWiki `MODE_7` |
| Teletext control codes: `&81-&87` alpha colors red…white, `&88/&89` flash on/off, `&8C/&8D` normal/double height, `&91-&97` graphics colors, `&98` conceal, `&99/&9A` contiguous/separated graphics, `&9C` black background, `&9D` new background, `&9E/&9F` hold/release graphics; `*` state at line start: white text, flash off, normal height, continuous graphics, black background, release. After a graphics color, `%xx1xxxxx` bytes are sixels with bits 0,1 / 2,3 / 4,6 as the 2×3 blocks; `%xx0xxxxx` stay text. Control characters display as spaces unless held. `#`, `_`, `£` are stored as `&5F`, `&60`, `&23`. Double height: the lower row of a pair shows nothing that is not also double height. | mdfs.net `Info/Comp/Teletext/Controls` |
| Video ULA: control `&FE20` (RAM copy `&248`) — bits 7-5 cursor segments, bit 4 clock 1/2 MHz, bits 3-2 columns (10/20/40/80), bit 1 Teletext, bit 0 flash; palette `&FE21` (RAM copy `&249`) — high nibble = logical color, low nibble = physical color, 16 entries; physical 0-7 steady, 8-15 flashing; bit 3 blue, 1 green, 0 red, 2 flash, values inverted before output. Both write-only. `&FE22/&FE23` are the Video NuLA extension's border and 24-bit palette registers, not stock hardware. | BeebWiki `Video_ULA`; mdfs.net `Hardware/SHEILAddrs` |
| SHEILA (`&FE00-&FEFF`): `&FE00/01` 6845 CRTC address/data; `&FE08/09` 6850 ACIA; `&FE10` serial ULA; `&FE18` station ID (B) / ADC (Master); `&FE20/21` Video ULA; `&FE24-&FE2B` Master drive control + 1770; `&FE30` ROMSEL; `&FE34` ACCCON (B+/Master); `&FE40-&FE4F` System VIA; `&FE60-&FE6F` User VIA (port B = user port, port A = printer); `&FE80` 8271 (B) or 1770 (B/B+ with the later board); `&FEA0` 6854 ADLC Econet; `&FEC0` ADC (B/B+); `&FEE0` Tube. FRED `&FC00` and JIM `&FD00` are the 1 MHz bus pages. | mdfs.net `Hardware/SHEILAddrs`, `AllMem` |
| Paged ("sideways") ROM: a 16K window `&8000-&BFFF`, one of 16 slots selected through ROMSEL `&FE30` with a RAM copy at `&F4`; the MOS manages it and has a service-call API; B+ 128K and Master 128 have 64K of sideways RAM (Master: slots 4-7); B+ shadow RAM is 20K at `&3000-&7FFF` with a 12K private block that appears at `&8000-&AFFF` when a value above 127 is written to ROMSEL. | BeebWiki `Paged_ROM`, `Sideways_RAM` (stub), `Shadow_RAM`; WebFetch summary of `Sideways_ROM` |
| MOS calls: OSWRCH `&FFEE` (vector `&020E`) writes one byte to the VDU stream — VDU 19 palette, VDU 22 mode, VDU 23 user-defined characters and CRTC/ULA pokes, VDU 31 TAB x,y; OSBYTE `&FFF4` (A = call, X, Y): `&13` "wait for vertical retrace — returns after the next VSync interrupt a few microseconds after the start of a display field", `&80` ADVAL (0 = buttons + last channel, 1-4 analogue channels, 7-9 mouse, negative = buffer status), `&81` INKEY (positive XY = centisecond timeout; Y=`&FF`, X=`&80-&FF` = scan one key, returns `&FFFF` if down; X=0 = host type), `&00` host OS type (1 = BBC OS 1.20, 2 = B+, 3 = Master 128, 5 = Compact); OSWORD `&FFF1` `&07` SOUND (channel, volume/envelope, pitch, duration as four 16-bit words) and `&08` ENVELOPE; OSRDCH `&FFE0`, OSCLI `&FFF7`. | BeebWiki `OSWRCH`, `OSBYTE`, `OSBYTE_&13`, `OSBYTE_&80`, `OSBYTE_&81`, `OSWORD_&07`; mdfs.net `Osbyte00` |
| Keyboard: 10×8 matrix, 73 keys (Master: 13×8, 92 keys), on the slow bus through the System VIA; every key but CTRL and SHIFT raises an interrupt that makes the MOS scan; ECMA-23 bit-paired layout. INKEY negative numbers are the portable key scan. | BeebWiki `Keyboard`; mdfs.net `Hardware/Keyboard` (layout) |
| Sound: SN76489, "4 channels, mono": 3 tone + 1 noise; optional TMS5220 speech. Analogue port: DA15, four 8/12-bit channels on a µPD7002, twin joysticks with fire buttons, light pen. CPU 2 MHz 6502; Master 65C102/65C12. Model B+ 64K = 32K + 20K shadow + 12K sideways; B+128 adds 4 × 16K sideways RAM. 8271 (early) vs 1770 (later, different addresses, incompatible). The BBC's own documentation discourages direct hardware access in favour of OS calls — that is what makes programs Tube-portable. | Wikipedia *BBC Micro* |
| Tube: "a hardware and software protocol designed by Acorn to allow a second (client or parasite) processor to communicate with a main (host) processor"; second processors include 6502/6512, Z80, 32016, ARM, 80x86, 65816 and others; the host acts as the I/O processor and proxies the MOS API. | mdfs.net `Software/Tube` |
| cc65's BBC support is `bbc.cfg` only: zero page `&70-&8F` (32 bytes), program at `&0E00`, size `&7200` minus a 2K stack (i.e. up to `&8000`), no headers, no library; `ca65` defines `__BBC__` for `-t bbc`. No `bbc.h`, no `bbc.html` in the docs index. | cc65 `cfg/bbc.cfg`, `include/` listing, `doc/index.html`, `doc/ca65.html` |
| b-em: models by number (`-mN`) from `b-em.cfg`: 00 BBC A w/OS 0.1, 01 B w/OS 0.1, 02 A, 03 B w/8271, 04 B w/8271+SWRAM, 05 B w/1770, 06 B US, 07 B German, 08 B+ 64K, 09 B+ 128K, 10 Master 128, 11 Master 512, 12 Master Turbo, 13 Master Compact, 14 ARM Evaluation System, 15 Master 128 w/MOS 3.5; each with `fdc=`, `65c02=`, `tube=`, `romsetup=` (`swram`, `bp128`, `master`, `compact`). Command line: `-mx`, `-tx` (tube), `-disc f.ssd` (drives 0/2), `-disc1`, `-autoboot`, `-tape f.uef`, `-fasttape`, `-printfile`. Features: cycle-accurate video, 8271 and 1770 FDCs, `.ssd/.dsd/.adf/.adl/.img/.fdi`, `.uef/.csw`, sideways RAM, joystick, AMX mouse, SCSI/IDE, Music 5000, BeebSID, **VDFS** (host directory as an ADFS-like filing system through `roms/general/vdfs.rom` and the Disc menu), snapshots, debugger. Needs Allegro 5.2; documented for Linux and Windows; screenshot via the File menu only. | `stardot/b-em` `README.md`, `b-em.cfg`, `src/main.c` usage text, `docs/vdfs.html` |
| BeebEm (Windows): "This version of BeebEm will not compile on Unix systems"; models B, Integra-B, B+, Master 128; `-Model`, `-Disc1`, `-Disc2`, `-Tube`, `-Tape`, `-Data`, `-NoAutoBoot`, `-FullScreen`, `-Debug`. jsbeeb: browser, B and Master 128, `disc1`/`autoboot`/`model`/`tape` URL parameters, no headless mode documented. | `stardot/beebem-windows` README (WebFetch); `mattgodbolt/jsbeeb` README (WebFetch) |
| MAME drivers `bbcb`, `bbcb_us`, `bbcbp`, `bbcm` exist; Lua `video:snapshot()` "saves snapshot files according to the current configuration"; `-str`, `-video none`, `-sound none`, `-nothrottle`, `-flop1`, `-cass` are documented. | MAME `mame.lst`; docs.mamedev.org |

## From the sources, not verified here

Each is a lead to confirm the first time code depends on it.

- **Bitmap cell layout** (*to verify* against the Advanced User Guide):
  screen memory is arranged in 8-byte character cells, one byte per
  scanline of the cell, cells left to right then row by row, so byte
  address = base + (row × columns + column) × 8 + scanline; in 2 bpp and
  4 bpp modes the bits of a byte are interleaved across pixels (2 bpp:
  pixel n = bits 7-n and 3-n; 4 bpp: bits 7,5,3,1 and 6,4,2,0). The MOS
  computes it; a `locate()` will need the formula.
- **Hardware scrolling**: CRTC R12/R13 set the start address in 8-byte
  units; the MOS wraps within the mode's block by wiring CRTC MA12 through
  the System VIA's IC32 latch bits 4-5 (*to verify*). The MODE pages
  confirm the wrap addresses (`&7FFF` → `&3000`/`&4000`/`&5800`/`&6000`/
  `&7C00`).
- **System VIA / IC32 addressable latch** bits: 0 sound write enable, 1
  speech RS, 2 speech WS, 3 keyboard write enable, 4-5 screen base
  (hardware-scroll wrap), 6 caps LED, 7 shift LED; keyboard scanning
  through port A with bit 3 low; the SN76489 written through port A with
  bit 0 low; CA1 = 50 Hz vertical sync interrupt, T1 = 100 Hz centisecond
  timer — *to verify* against the Advanced User Guide or b-em's `via.c`.
- **SN76489 detail**: 4 MHz clock on the BBC, 10-bit tone periods, 4-bit
  attenuation, noise from three fixed rates or channel 3 — *to verify*
  (BeebWiki has no page at `SN76489`).
- **ACCCON (`&FE34`) bit meanings** on the B+ and the Master (shadow
  select, HAZEL/ANDY mapping, TST, IFJ, ITU) — *to verify*; BeebWiki's
  `Sideways_RAM` page is a stub that defers to "NAUG p160".
- **PAGE and HIMEM**: `&0E00` on a cassette Model B, `&1900` with DFS,
  `&0E00` again on the Master (workspace in HAZEL) — `bbc.cfg`'s `&0E00`
  origin is the cassette/Master value; *to verify* per filing system.
- **Zero page for the user**: `&70-&8F` (cc65 `bbc.cfg` uses exactly this
  range); the MOS reserves the rest and the current language ROM owns
  `&00-&6F` — *to verify* which bytes the MOS itself guarantees.
- Mode 7 text is *40×25* on the Model B; the Master literature above says
  "40x24 Teletext" (its table) — the BeebWiki mode page says 25 rows and
  1000 bytes on screen; take 25 and treat the Master table as a typo until
  checked.
- Frame rate 50 Hz, 312 lines interlaced, vblank of ~2 ms — *to verify*;
  OSBYTE `&13` is the verified way to wait. The vsync IRQ arrives on
  System VIA CA1 (*to verify*), which a program with interrupts off could
  poll through the VIA's IFR bit 1.
- The Tube 6502 second processor's memory map (64K flat, MOS proxied) and
  its 3 MHz clock — *to verify*.

## Corrections to the brief and the roadmap

- The roadmap says "cc65 officially supports the … BBC Micro". It does
  not, beyond an assembler config; there is no BBC C library in cc65 and
  no doc page. The realistic backends are a custom LLVM-MOS platform
  (below) or BeebAsm-style assembly for the runtime pieces.
- The brief's "32K RAM with sideways ROM/RAM banks" is the Model B; the
  Model A is 16K and the B+ and Master change the map. "BBC Micro" is a
  family; profile it.
- The brief's "Mode 7 Teletext (SAA5050 sixel graphics)" is right; note
  that the *MOS* draws nothing in mode 7 — the program writes control
  bytes and sixels itself, through OSWRCH or directly at `&7C00`.

## Rules for this target

### Models are profiles, and a mode is a memory budget

- `BBC_PROFILES` needs at least `b` (32K, 8271 or 1770 disc as a
  sub-axis, cassette PAGE `&0E00` / DFS `&1900`), `b-swram` (sideways RAM
  fitted), `bplus` (shadow RAM, 12K private), `master` (65C02-class
  opcodes allowed, shadow RAM, sideways RAM 4-7, 1770, MOS 3.20/3.50), and
  `tube-6502` (the program runs on the second processor with a flat 64K
  and only the MOS API). b-em's model list is the community's naming.
- The mode is a *build* property and a memory ceiling: mode 7 costs 1K,
  modes 4-6 8-10K, modes 0-3 16-20K of the 32K, from the top down. A
  program that picks mode 2 on a Model B has ~9K left below `&3000` with
  DFS loaded. Studio's tier on this machine is decided by that number.
- 65C02 opcodes are a Master/Tube-only luxury; the Model B is an NMOS
  6502. `-mcpu` follows the profile.

### The MOS is the portable surface

- Draw text with OSWRCH (VDU 31 to position, then bytes), set palette
  with VDU 19, define characters with VDU 23, change mode with VDU 22,
  wait a frame with OSBYTE `&13`, scan keys with OSBYTE `&81` negative
  INKEY, read joysticks with OSBYTE `&80`, make sound with OSWORD 7. That
  set works on every model and across the Tube; a program that pokes
  `&FE20` does not run on a second processor at all.
- Direct hardware (screen memory writes, palette pokes, VIA polling)
  is the *fast* path and is host-only; make it a separate subpath
  (`@8bitscript/bbc-micro/raw`) with the Tube profile refusing it, the
  way the C64 package separates KERNAL from chips.
- Never hardcode PAGE, HIMEM or the screen base: the MOS tells you
  (OSBYTE `&83`, `&84`; the mode tables above give the base per mode on
  the B, but shadow modes on B+/Master leave the same addresses free).

### The screen

- Modes 0-6 are bitmaps in cell-major order with a logical → physical
  palette; text is drawn by the MOS from a definable 8×8 font. "Color
  per cell" does not exist: color granularity is the pixel, at 1, 2 or
  4 bits, and the palette maps logical colors to 8 hues + 8 flashing.
  A per-cell color API is a software convention here (draw the glyph in
  a logical color), not an attribute byte.
- Mode 7 is the character-cell mode and the only one with per-line
  attributes: a color or graphics change costs a cell, sixels are
  2×3 per cell (78×75 effective), and the `*` defaults reset at each
  line. It is also the only 40×25 mode with color for 1K; the tier for
  "text and block graphics" is mode 7, and the trap is the cell the
  control code eats.
- There is no border color on a stock machine. The overscan is black
  (or the physical color of the ULA's off-screen state); `&FE22` is a
  NuLA extension. `screen.setBorder()` is inert; `setBackground()` is a
  palette write of logical color 0.
- Hardware scroll exists (CRTC R12/R13 with the IC32 wrap) but is coarse
  (8-byte units) and the MOS uses it for text scrolling; treat fine
  scrolling as software.
- No sprites. Software sprites in the bitmap, or mode 7 sixel blocks.

### Sound is three tones and a noise

- OSWORD 7 with the MOS's queued channels (four buffers, envelopes via
  OSWORD 8) is the portable voice API: three tone channels + one noise,
  volume -15..0 (BBC BASIC's range, *to verify* at the OSWORD level), software envelopes. That maps well onto a note-level
  API and is Tube-safe.
- Direct SN76489 writes go through the System VIA and IC32 and need
  the sound-write-enable dance; keep them under the raw subpath.
- No hardware entropy; the MOS centisecond clock and vsync count are the
  seeds.

### Input

- Keys: OSBYTE `&81` with a negative INKEY number is "is this key down
  now" and supports chords; it is the layer a portable `input` sits on.
  Direct matrix scanning (System VIA port A, IC32 bit 3) exists and is
  what games do to escape the MOS's interrupt cost — raw subpath.
- Joysticks are analogue through the ADC (OSBYTE `&80` channels 1-4,
  buttons in the low byte of channel 0) and slow (conversion time per
  channel); read once per frame. Digital "switched" joysticks on the
  user port exist as third-party hardware.
- Mouse: AMX (user port) is the common one; capability, not assumption.

### Frame timing

- `FRAME_SYNC.bbc` should be OSBYTE `&13` on the portable path (it
  returns right after the vsync IRQ, so the whole vblank is available
  after it) and a VIA IFR poll on the raw path if interrupts are off.
  50 Hz only; there is no NTSC BBC. Vblank length is *to verify* before a
  budget is written down.

### Memory

- Sideways ROM/RAM is the bank window: `&8000-&BFFF`, selected by ROMSEL
  with the `&F4` copy the MOS relies on — always write both, in the order
  the MOS does. Code in a sideways bank is ROM-image shaped (service
  entry, language entry, header) and is a build format of its own; a
  program that *uses* sideways RAM as data must save/restore `&F4`.
- B+/Master shadow RAM means the screen may not be at the address the
  mode table says; read the MOS, and remember shadow modes are `MODE
  128+n`.
- Master private RAM (HAZEL `&C000-&DFFF`, ANDY `&8000-&8FFF`) is the
  MOS's; ACCCON is not a user register.

### LLVM-MOS

- No platform exists. The shape of one is `mos-platform/eater/lib/link.ld`
  in the installed SDK (a `PARENT common` platform: `__rc0`, `imag-regs.ld`,
  `MEMORY { zp; ram }`, `REGION_ALIAS`, `INCLUDE c.ld`, `__stack`) plus the
  apple2 PR's pattern for a hosted OS (entry stub, stdio through the OS
  call, exit through the OS). A `bbc` platform would load at PAGE
  (`&0E00`/`&1900` per profile, or `&0800` on a Tube 6502), keep zero page
  to `&70-&8F` (or negotiate more with the language), write stdio through
  OSWRCH/OSRDCH, and emit a plain binary loaded with `*LOAD`/`*RUN` (or a
  `!BOOT` on a `.ssd`). A Tube profile is the same binary at a different
  origin with the raw subpath refused.
- The alternative is not cc65 (no BBC library) but BeebAsm/vasm for
  hand-written runtime pieces.

## Emulator

- **Likely project choice: b-em** for accuracy and its host filesystem
  (VDFS: point it at a directory and the guest sees it as an ADFS-like
  filing system — the only host-FS route among the four), with `-m10` for
  Master 128, `-m03`/`-m05` for a Model B, `-disc f.ssd -autoboot` to run
  a `!BOOT`. Caveats: built on Allegro 5, documented for Linux/Windows
  (macOS is not mentioned), and screenshots are menu-only — no headless
  route was found.
- **MAME** (`bbcb`, `bbcbp`, `bbcm`) is the headless candidate: `-str`,
  `-video none`, `-sound none`, `-flop1 f.ssd`, `-cass f.uef`, and Lua
  `video:snapshot()` from an `-autoboot_script` (*end-to-end to verify*);
  it needs the Acorn ROM set.
- **BeebEm** is Windows-only; **jsbeeb** is the browser reference and has
  no headless mode.

## Traps for someone who knows the C64

1. **The OS is the API.** Poking `&FE20` or `&3000` works on a Model B
   and fails on a Tube second processor; OSWRCH/OSBYTE work everywhere.
   Pick the raw path deliberately.
2. **A mode costs RAM the program would otherwise have.** Mode 2 eats
   20K of 32K; mode 7 costs 1K. There is no "video RAM" apart from the
   program's.
3. **Color is per pixel through a palette, not per cell — except in
   mode 7, where a color change eats a cell.** Neither is a C64
   attribute byte.
4. **No sprites, no border register, no fine scroll worth using.**
5. **Sideways banks are ROM-image shaped and the MOS owns the bank
   select** (`&FE30` *and* `&F4`). 128K is 32K plus banks, on some
   models only.
6. **The keyboard is behind the OS and its interrupt.** INKEY negative
   numbers, not a `$DC00` matrix; direct scanning is a documented but
   raw technique.
