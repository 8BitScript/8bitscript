---
title: Atari 2600
nav_order: 30
---

# Writing Atari 2600 support for 8BitScript

This file is for anyone — human or agent — adding the `atari2600` target
(roadmap phase 7, "the language's torture test"): a `packages/atari2600`,
its rows in `packages/backend-6502` (`DRIVER`, `outputExtension()`,
`FRAME_SYNC` — which cannot exist in its present shape here), a Stella
launch in `packages/cli/src/run.mjs`, `doctor.mjs`'s `CLANG_DRIVERS`, a
`docs/setup/atari2600.md`, and the 2600 row of `docs/roadmap.md`. Read the
root `AGENTS.md` first (paths in this note are relative to the repository
root); the rules there apply to every target and are not repeated.
`packages/nes/AGENTS.md` is the nearest contrast — a machine with almost nothing — and this one has
less: the NES at least has a nametable. The 2600 is the case the whole
"don't assume a framebuffer" rule was written for —

> **The 2600 has no display memory of any kind. TIA holds one scanline's
> worth of state — a 20-bit playfield pattern, two 8-bit player bitmaps,
> two missiles, a ball, four colour registers — and the CPU rewrites those
> registers on every one of the 192 visible lines, 76 cycles each, while
> the beam draws them. Everything else is small: 128 bytes of RAM shared
> with the stack, 4K of ROM without a mapper, a 6507 with 13 address lines
> and no interrupt pins. Model it as "a per-scanline register kernel with a
> 128-byte state budget and a cycle budget per line", never as a screen.**

Its variety is entirely in the cartridge: 2K/4K plain ROM, or one of some
sixty bank-switching schemes (Stella's list) of which LLVM-MOS ships two
drivers — `atari2600-4k` and the TigerVision `3E` mapper with banked ROM
and banked cartridge RAM — and in the region (NTSC 262 lines / PAL 312 /
SECAM). Whether a program fits is decided by cycles per line first and
bytes second.

## What exists today

Nothing in this repository. There is no `packages/atari2600`, no backend
entry, no `--target atari2600` (the string appears in
`packages/compiler/test/compiler.test.mjs` only as a stand-in for "an
unknown target"), no Stella integration, and no docs beyond the roadmap
row. What this note verified is the layer underneath:

- The LLVM-MOS SDK installed here ships `mos-atari2600-4k-clang`,
  `mos-atari2600-3e-clang` and a `mos-atari2600-common-clang`, with
  headers (`_tia.h`, `_riot.h`, `atari2600.h`, `atari2600_constants.h`,
  `vcslib.h`, the `mapper*.h` family), a crt0, a frame-loop helper and one
  example. The SDK's `examples/atari2600/demo_vcslib.c` builds here to a
  4096-byte image with the 4k driver and an 8192-byte image with the 3E
  driver.
- **Nothing was run.** No 2600 emulator is installed on this host; Stella
  7.0c is one `brew install stella` away (checked with `brew info`) but
  was not installed for this note, so every on-screen claim below is
  absent and every timing claim comes from documents.

## Facts verified here

Cite these freely; each was read in the source named, not recalled.
`$SDK` is `~/.local/opt/llvm-mos`.

| Fact | Where |
| ---- | ----- |
| The only writeable region is zero page: `vcs.ld` declares `zp : ORIGIN = __rc31 + 1` with `__rc0 = 0x80`, so the SDK's imaginary registers take `$80-$9F` and C variables get **`$A0-$FF` (96 bytes)**, which is also where the hardware stack lives. `c_writeable` is `zp`. `-mlto-zp=112`. | `$SDK/mos-platform/atari2600-common/lib/vcs.ld`, `$SDK/bin/mos-atari2600-common.cfg` |
| The CPU is targeted as `-mcpu=mos6502x` — a 6502 *with* the unofficial opcodes enabled — and `-D__ATARI2600__`. | `mos-atari2600-common.cfg` |
| crt0: `cld`; then `ldx #0 / txa / dex / txs / pha / bne` — 256 pushes of zero walking `S` from `$FF` down and back to `$FF`, which the source's own comment describes as clearing "the whole memory (128 bytes) including BSS" *and* "TIA registers" and setting the stack to `$ff` (the pushes land in page 1, which the 6507 mirrors onto RAM and TIA); then `jmp main` ("to save 2 bytes of stack"). No interrupt vectors are used. | upstream `crt0.S`; `llvm-objdump` of the built demo (`cld / ldx #0 / txa / dex / txs / pha / bne / jmp main`) |
| 4K target: ROM `perm` at `$F000`, `__cart_rom_size` 4 (or 2), the vector block at `$F000 + size − 4` holds `_start` twice ("we don't really need NMI on the 2600" — RESET and IRQ both point at `_start`; NMI is not written). `.text` at `$F000`, `.zp.bss` at `$A0`. | `$SDK/mos-platform/atari2600-4k/lib/link.ld`, `llvm-readelf` of the built demo |
| 3E target: ROM 6–32K in 2K steps, up to fifteen 2K banks `rom0..rom14` switched into `$F000-$F7FF`, a fixed 2K `perm` at `$F800-$FFFF` (vectors at `$FFFC`); cartridge RAM up to 255K in 1K banks read at `$1000-$13FF` and **written at `$1400-$17FF`** (separate read and write windows). A ROM bank is selected by `sta $3F`, a RAM bank by `sta $3E`; `.init.055` does `sta $3f` with A = 0 so bank 0 is in before `main`. `mapper.h`: `MAPPER_BANKED_ROM_SIZE 0x800`, `MAPPER_XRAM_SIZE 0x400`, `bank_select()`, `ram_select()`, `banked_call_rom()`, `banked_call_ram()`, `xram_read()/xram_write()`, `DECLARE_XRAM_VARIABLE()` (declares a `_read` and a `_write` twin). `MAPPER_CART_ROM_KB(n)` in a source file sets the image size. | `$SDK/mos-platform/atari2600-3e/lib/link.ld`, `include/mapper.h`, `init_mapper_3e.o` disassembly, upstream `mapper_3e.c`, `mapper_xram_single.h` |
| TIA is at `$0000` as a struct of write/read unions: writes VSYNC, VBLANK, WSYNC, RSYNC, NUSIZ0/1, COLUP0/1, COLUPF, COLUBK, CTRLPF, REFP0/1, PF0/1/2, RESP0/1, RESM0/1, RESBL, AUDC0/1, AUDF0/1, AUDV0/1, GRP0/1, ENAM0/1, ENABL, HMP0/1, HMM0/1, HMBL, VDELP0/1, VDELBL, RESMP0/1, HMOVE, HMCLR, CXCLR; reads CXM0P … CXPPMM (8 collision registers) and INPT0-5. RIOT is at `$0280`: SWCHA, SWACNT, SWCHB, SWBCNT, INTIM, TIMINT, then TIM1T, TIM8T, TIM64T, T1024T at `$0294-$0297`. | `_tia.h`, `_riot.h`, `atari2600.h` |
| Constants the SDK encodes: NUSIZ `ONE_COPY … QUAD_SIZE` (0–7) and missile/ball sizes 1/2/4/8 (`MSBL_SIZE1..8`); CTRLPF `PF_REFLECT` 1, `PF_SCORE` 2, `PF_PRIORITY` 4; REFP `REFLECT` 8; HMOVE values `HMOVE_L7 = $70 … HMOVE_R8 = $80`; VBLANK `DUMP_PORTS $80`, `ENABLE_LATCHES $40`, `DISABLE_TIA 2`; VSYNC `START_VERT_SYNC 2`; SWCHA joystick bits (P0 in the high nybble: right `$80`, left `$40`, down `$20`, up `$10`, active low; P1 in the low nybble); SWCHB `RESET 1`, `SELECT 2`, `BW 8`, difficulty `$40/$80`; fire = INPT4/INPT5 bit 7 (0 = pressed). | `atari2600_constants.h`, `vcslib.h` |
| The SDK's frame loop: `kernel_1()` — VSYNC on, `WSYNC`, VSYNC off, start the vertical-blank timer, and a `brk` if RESET is held; `kernel_2()` — wait for INTIM = 0, `VBLANK = ENABLE_TIA`, start the picture timer; `kernel_3()` — wait, `VBLANK = DISABLE_TIA`, start the overscan timer; `kernel_4()` — wait for INTIM = 0. Timer values: `_CYCLES(lines) = lines × 76 − 13`, `_TIM64(cycles)`; NTSC 37 / 194 / 32 lines (vblank / picture / overscan), PAL 45 / 250 / 36 (`#ifdef PAL`). So a "frame" is a fixed timing skeleton the program fills, not a signal the program waits for. | `vcslib.h`, upstream `frameloop.c` |
| `set_horiz_pos(obj, x)`: `sta WSYNC`, divide *x* by 15 by repeated subtraction, `eor #7`, shift into the high nybble, `sta HMP0,x` then `sta RESP0,x`; `apply_hmove()` is `sta WSYNC / sta HMOVE`. The whole horizontal-positioning problem is that a coarse position is *when* you strobe RESPx during the line and a fine one is a −8…+7 nudge applied at the next HMOVE. | `vcslib.S`, `vcslib.h` |
| Building: the SDK demo compiles with `mos-atari2600-4k-clang -Os` to a 4096-byte `.bin` and with `mos-atari2600-3e-clang -Os` (with `MAPPER_CART_ROM_KB(8)`) to 8192 bytes; `.text` for the 4K build starts at `$F000`, `.zp.bss` at `$A0`. | built here |
| Stella's bankswitch enum (what `-bs`/`-type` accepts): `AUTO, 03E0, 0840, 0FA0, 2IN1…128IN1, 2K, 3E, 3EX, 3EP, 3F, 4A50, 4K, 4KSC, AR, BF, BFSC, BUS, CDF, CM, CTY, CV, DEVC, DF, DFSC, DPC, DPCP, E0, E7, EF, EFF, EFSC, ELF, F0, F4, F4SC, F6, F6SC, F8, F8SC, FA, FA2, FC, FE, GL, JANE, MDM, MVC, SB, TVBOY, UA, UASW, WD, WDSW, WF8, X07`; descriptions such as "F8 (8K Atari)", "F4 (32K Atari)", "E0 (8K Parker Bros)", "AR (Supercharger)"; file extensions (`a26`, `bin`, `rom`, or a scheme name) force a scheme. | upstream `src/emucore/Bankswitch.hxx` |
| Stella's command line (7.x): `-format <ntsc|pal|secam|…>`, `-lc`/`-rc <controller>` (left/right), `-bs`/`-type <scheme>`, `-audio.enabled <1|0>`, `-snapsavedir <path>`, `-snapname <int|rom>`, `-ssinterval <seconds>` (continuous snapshots), `-holdreset`, `-holdselect`, `-debug`, `-break <address>`, `-fullscreen`, `-palette`, `-tv.filter`, `-plr.ramrandom`, `-exitlauncher`; snapshots also on the F12 hotkey. No "run N frames and exit" option appears in the usage text. | upstream `src/emucore/Settings.cxx`, `docs/index.html` |
| Homebrew has `stella` 7.0c (bottled), not installed here. | `brew info stella` |

## From the sources, not verified here

The *Stella Programmer's Guide* (Steve Wright, Atari, 1979 — the TIA
reference; read in the alienbill.com HTML transcription) is the source for
the hardware numbers below. They are the industry's numbers, but nothing
here was measured or seen on an emulator: treat each as a lead to confirm
under Stella when a runtime depends on it.

**The frame.** 262 lines per NTSC frame: 3 lines of VSYNC, 37 of
vertical blank, 192 of picture, 30 of overscan — all produced by the
program; the TV only knows what the program strobes. A line is 228 colour
clocks (3.58 MHz), 68 of horizontal blank and 160 visible; the CPU clock
is one third of the colour clock, so **76 CPU cycles per line** and
`STA WSYNC` halts the CPU until the next line starts. PAL is 312 lines
(the SDK's 45/250/36 split); the CPU clock differs slightly (*to verify*).

**Playfield.** 20 bits per half-line from PF0 (4 bits, reversed), PF1 and
PF2, each bit 4 colour clocks wide; the right half repeats or, with
CTRLPF bit 0, reflects the left — so a full-width "pixel" grid is 40 × 192
with every row needing the CPU to rewrite PF0-2 (twice per line for an
asymmetric playfield). CTRLPF bit 1 (score mode) colours the halves with
COLUP0/COLUP1; bit 2 puts the playfield above the players.

**Objects.** Two players 8 bits wide (GRP0/1), reflectable (REFPx), with
NUSIZx giving 1/2/3 copies at three spacings or double/quad width; two
missiles and one ball 1 clock wide, stretchable to 1/2/4/8 (NUSIZx bits
4–5, CTRLPF bits 4–5); one horizontal position each set by strobing
RESxx and a −8…+7 nudge in HMxx applied by HMOVE (which also blanks the
left 8 clocks of that line — the "HMOVE comb", *to verify*); VDELPx/VDELBL
delay a write by one line for two-line kernels. Vertical position does
not exist: an object appears on the lines where its graphics register is
non-zero.

**Colour.** COLUP0, COLUP1, COLUPF, COLUBK: 4 hue bits × 3 luminance bits
(bit 0 unused) = 128 colours NTSC; PAL and SECAM palettes differ (SECAM
has 8 colours, *to verify*). Colour is per *object* per *line*: change
the register mid-line and the change lands mid-line.

**RAM and timers.** 128 bytes of RIOT RAM at `$80-$FF`, mirrored (the
6507's 13 address lines make `$0000-$1FFF` the whole space; TIA, RIOT and
the 4K ROM repeat through it, *to verify* the exact mirrors). INTIM counts
down from TIM1T/TIM8T/TIM64T/T1024T at 1/8/64/1024 cycles per tick — the
only clock the program has, and the SDK's frame loop is built on it.

**Input.** SWCHA: two joysticks, 4 bits each, active low (SWACNT sets the
direction, all input by default); SWCHB: RESET, SELECT, colour/B&W and
the two difficulty switches, active low; INPT4/INPT5 bit 7 = fire, latched
if VBLANK bit 6 is set; INPT0-3 are the paddle pots, read by dumping the
capacitors with VBLANK bit 7 and counting lines until the bit flips;
keyboard controllers and driving controllers reuse SWCHA/INPT lines
(*to verify* the protocols).

**Audio.** Two channels: AUDCx 4 bits choosing a tone/noise generator,
AUDFx 5 bits dividing a ~30 kHz clock, AUDVx 4 bits of volume; no
envelopes, no filter, no sample mode beyond the CPU writing AUDV per line.
No hardware random source (the poly counters are not readable; *to
verify*).

**Bank-switching sizes.** Beyond what the SDK links (2K/4K plain, 3E),
the common Atari schemes are F8 = 8K, F6 = 16K, F4 = 32K (each a pair of
strobe addresses in `$1FF8-$1FFF`), with `SC` variants adding 128 bytes
of "Superchip" RAM; E0/E7/FA/3F/DPC are other vendors' — all *to verify*
before any becomes a profile.

## Rules for this target

### There is no screen, so there is no `screen` and `text` is a kernel

- `@8bitscript/screen`'s "blank the screen, set border and background"
  has a meaning (COLUBK for the frame's lines, VBLANK on/off) but
  `@8bitscript/text`'s "put a glyph in a cell" does not: there are no
  cells and no glyphs. Text on the 2600 is one of two software
  constructions, both per-line register rewrites: **playfield blocks**
  (a 40 × 192 grid of 4-clock pixels, symmetric unless PF0-2 are
  rewritten mid-line — enough for big block letters) or **player
  bitmaps** (8-pixel columns of glyph rows fed into GRP0/GRP1 line by
  line, with NUSIZ copies and VDEL to widen a line — the "six-digit score"
  kernels of the era, *to verify* the exact 48-pixel technique). Either
  is a *display kernel* the package writes and owns, with a documented
  line and cycle budget, not a `putChar`.
- A portable program that imports `@8bitscript/text` does not compile
  for this target, by design — the way `sprites` does not exist on the
  PET. What the 2600 package exports is a kernel builder: "this many
  lines of this shape, with these registers changing at these lines".

### The frame is the program's, and cycles are the currency

- No vblank interrupt, no raster register, no `waitFrame()` polling
  anything: the frame is produced by the program's own VSYNC/VBLANK
  strobes and RIOT timers (the SDK's `kernel_1..4` are the honest shape).
  A 2600 `FRAME_SYNC` is a *frame skeleton the compiler emits around the
  program's per-frame work*, and the logical-frame accumulator in
  `packages/backend-6502` still applies on top: at 60 Hz NTSC / 50 Hz PAL
  it decides how many game ticks run per hardware frame.
- The only budget that matters inside the picture is **76 cycles per
  line, minus the writes the line needs**; vertical blank (37 lines ≈
  2800 cycles) and overscan (30 lines ≈ 2280) are where game logic runs.
  The backend must let a program see its generated assembly and cycle
  counts per line (roadmap: "inspection of the generated assembly"), and
  an `@address` write to WSYNC is an intrinsic with timing semantics, not
  a store.
- `sei`/`cli` are meaningless (no interrupt sources); `brk` is what the
  SDK uses to halt.

### 128 bytes is the whole state, and the stack is inside it

- Variables, the soft stack, the hardware stack and any temporary all
  live in `$A0-$FF` after the SDK's 32 imaginary registers; a program's
  RAM line is the truth here more than anywhere. Zero-page-only codegen,
  no heap, no string buffers, `const` tables in ROM, and a diagnostic
  when locals cannot fit — this is the target the root file's "prefer
  compact semantic storage" rule was written for.
- 3E cartridge RAM is real, banked, and split into read and write
  windows (`$1000` vs `$1400`): a (bank, offset) pair with two addresses.
  Never present it as memory a pointer can reach.

### Input is switches, and paddles cost lines

- SWCHA/SWCHB/INPT4-5 are direct reads at any time; `@8bitscript/input`
  maps to them trivially (two sticks, fire, console switches).
- Paddles are a capacitor race: dump with VBLANK bit 7, then poll INPT0-3
  every scanline of the picture and record the line where each flips —
  the read *is* part of the display kernel and costs cycles on every
  line. A paddle capability is a kernel option, not a poll.

### Storage: none

- No cartridge RAM survives power-off in the schemes the SDK links;
  persistence is `none`. (Third-party carts with flash/EEPROM exist and
  are *to verify*; they would be a media profile.)

### Emulator

- Stella, `brew install stella` (7.0c). Launch `stella -format ntsc
  -bs 4K <file.bin>` (or `-bs 3E`); force the scheme rather than rely on
  autodetection for a raw image, as with atari800's `-cart-type`.
  Headless capture: `-snapsavedir` + `-ssinterval` exists but no
  run-N-frames-and-exit flag was found in the usage text — the route is
  *to verify* (the debugger's `-break` plus its scripting is a candidate).
  Nothing here has been seen on screen.

## Where things live

```
(no package yet)
$SDK/mos-platform/atari2600-common/include/_tia.h, _riot.h, atari2600.h    the register structs at $0000 and $0280
$SDK/mos-platform/atari2600-common/include/atari2600_constants.h, vcslib.h  NUSIZ/CTRLPF/HMOVE/SWCHx bit names, kernel_1..4, the timer macros, set_horiz_pos
$SDK/mos-platform/atari2600-common/lib/vcs.ld, crt0.o                       zp $A0-$FF as the only RAM, the clear loop, jmp main
$SDK/mos-platform/atari2600-4k/lib/link.ld                                  ROM at $F000, 2K/4K, RESET+IRQ vectors = _start
$SDK/mos-platform/atari2600-3e/lib/link.ld, include/mapper.h, init_mapper_3e.o   2K ROM banks at $F000, perm at $F800, 1K RAM banks read $1000 / write $1400, sta $3F / sta $3E
$SDK/bin/mos-atari2600-*.cfg                                                -mcpu=mos6502x, -mlto-zp=112, -D__ATARI2600__ and the mapper defines
$SDK/examples/atari2600/demo_vcslib.c                                       the SDK's own example (builds here: 4096 / 8192 bytes)
github.com/llvm-mos/llvm-mos-sdk mos-platform/atari2600-common/frameloop.c, vcslib.S, crt0.S; atari2600-3e/mapper_3e.c   the sources behind the objects above
github.com/stella-emu/stella src/emucore/Bankswitch.hxx, Settings.cxx      the scheme list and the command line
Stella Programmer's Guide (Wright, 1979)                                    the TIA reference every unverified number above cites
```
