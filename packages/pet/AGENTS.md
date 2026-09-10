# Writing Commodore PET support for 8BitScript

This file is for anyone — human or agent — touching `packages/pet`,
this package's hardware catalog (`package.json`, `"8bitscript".hardware`:
the `model` option), `packages/compiler/src/mos`'s `FRAME_SYNC.pet`,
`packages/cli`'s `xpet` handling (`PET_REGION_NOTE`, `PET_CLOCK_HZ`), the
`pet` row of the linker's hardware-hazard table, or
the PET rows of `docs/roadmap.md` and
`packages/studio/AGENTS.md`. Read the root [`AGENTS.md`](../../AGENTS.md)
first; the rules there apply to every target and are not repeated.
[`packages/nes/AGENTS.md`](../nes/AGENTS.md) and
[`packages/cx16/AGENTS.md`](../cx16/AGENTS.md) are the two contrasts: the
NES has almost nothing and forces abstraction; the X16 has a great deal
behind windows and ports. The PET is a third case —

> **The PET has *only* a CPU, RAM, a character ROM, and three I/O chips.
> There is no video chip to program (on most models), no color, no sound
> chip, no sprites, no bitmap, and no joystick port. Everything the program
> shows is a byte in screen RAM naming one of 128 fixed glyphs, possibly
> inverted. Model it as a memory-mapped 40×25 (or 80×25) grid of glyph
> indexes with a keyboard matrix, a 1 MHz clock, and one square-wave line —
> never as "a C64 without color".**

The machine's variety is in *models*, not features: RAM size (4K–32K, with
64K/128K only via banking this target does not link), screen width
(40 or 80 columns), whether a 6545 CRTC exists, which ROM set (BASIC 1, 2
or 4) and which keyboard (graphics or business) it has, and whether it
refreshes at 50 or 60 Hz. Those axes are only loosely correlated, and a
program built for one point in that space does not run on the others.

## What exists today

Do not describe more than this as working:

- `packages/pet/src/index.8bs` exports three registers: `viaPeripheralControl`
  (`$E84C`, the 6522 VIA's PCR), whose bit 1 selects the character set:
  `$0C` upper-case/graphics, `$0E` upper/lower-case text, and PIA1's two
  ports `pia1PortA`/`pia1PortB` (`$E810`/`$E812`) for the keyboard layer
  below. The PCR is the only
  hardware the package's two portable surfaces need: `src/screen.8bs`
  (behind `@8bitscript/screen`, as `@8bitscript/pet/screen`) and
  `src/text.8bs` (behind `@8bitscript/text`).
- `screen.setColors()`, `setBorder()`, `setBackground()` and
  `text.putColor()`/`text.setColor()` all link and are all **deliberately
  inert**: the PET has no color hardware and no border. `screen.blank()`
  writes the space screen code (32) to 1000 cells from `$8000`.
- `text.putChar(cell, code)` takes ASCII, converts it to a PET screen code
  (`A`–`Z` 65–90 → 1–26; 32–63 unchanged), and writes `$8000 + cell` —
  directly, at any time, with no vertical-blank queue (see "Snow" below for
  why that is correct on every model this target builds for). Before each
  run of text the package writes `$0C` to the PCR so 1–26 render as
  capitals — necessary because the business-keyboard ROMs boot in the
  lower-case set (see the verified table below).
  `text.COLUMNS` and `text.CELL_COUNT` are `Video.COLUMNS` and
  `Video.CELL_COUNT` from `src/geometry.8bs` (40 and 1000), whose
  `geometry.pet.8032.8bs` twin (80 and 2000) a build whose hardware
  carries the `8032` tag reads instead — the hardware-tag file rule in
  `docs/packages.md`, and the reason namespace consts may now be
  initialized from another module's const. `screen.blank()` clears
  `Video.CELL_COUNT` cells the same way. `locate()` is not needed here:
  the screen is a flat array and cell arithmetic is the address.
- `src/blocks.8bs` (`@8bitscript/pet/blocks`, PET-only — no portable
  `blocks` capability exists to implement): the sixteen quadrant-block
  screen codes (`video.blockWidth`/`blockHeight` = 2 in the fact sheet) as
  `blocks.quad()`/`blocks.put()`, and a `digits` namespace built on them —
  a 2x3-cell (4x6 pseudo-pixel) tile per digit 0-9 — a classic 3x5
  dot-matrix numeral elongated to fill all 6 rows (its own row 1 repeated,
  no blank row left over), not a scoreboard size: 2 cells wide is what
  makes every leftover space, for 1 to 4 digits alike, come out even, so
  `digits.printCentered()` can center a game tile's number exactly instead
  of `text.printNumber`'s odd-leftover bias to one side, and 4 tiles of 8
  cells (4 digits x 2) plus 3 gaps is 35, fitting a 40-column screen with
  room to spare. The font has no blank row of its own on purpose: a spare
  cell above or below a digit (however a caller lays a tile out) can only
  ever sit on one side by itself, so a font with a leftover blank row of
  its own always adds to whichever side that row lands on — the first
  version of this font padded a 5-row numeral to 6 with a trailing blank
  row, and a caller centering it inside a taller tile got visibly more
  margin above the digit than below (reported directly against
  `~/Development/2048`'s PET build, 2026-09-07); the fix was fitting real
  strokes into every row so nothing but the caller's own placement decides
  the margin. `digits.draw()` for one digit, `digits.print()` for a
  zero-padded field the same shape as `text.printNumber`, and
  `digits.printCentered()` for a number that grows and shrinks (a game
  tile's value) centered in a cell-width box instead of padded to a fixed
  one. Every one of the three takes `invert`: QUAD's sixteen codes are
  closed under the bit-7 flip, so an inverted digit reads as dark ink cut
  into a solid reverse-video tile instead of a fresh glyph punching a black
  rectangle through it — the look a 2048-style board wants, and the reason
  this shipped: it is what `~/Development/2048`'s PET build now uses
  (`src/tile.pet.8bs`, that project's own system-specific twin of
  `src/tile.8bs`).
  Verified against `characters-2.901447-10.bin`: the eight ROM quadrant
  glyphs (screen codes 96-127) are byte-identical whether the PCR selects
  the graphics or text set, and their reverse-video complements (224-255)
  cover the other eight patterns, so unlike `text.8bs` this module never
  touches `viaPeripheralControl`.
- **Hardware** (the catalog in `package.json`): three independent options —
  `model`, `ram`, and `speaker` — where one bundled `model` option used to
  carry all of it (milestone-10-era rework, prompted by a direct request to
  represent real owner RAM upgrades and the real user-port speaker hack, not
  just the seven stock configurations Commodore actually sold).
  - `model` — `2001` (default), `3008`, `3016`, `4016`, `4032`, `8032` — the
    PET's own model numbers, which are also what `xpet -model` takes, with a
    preset per model so `--profile 8032` works. It fixes the **screen
    width** (80 for the 8032, through the geometry twin, and the fact
    `video.columns`), the **keyboard matrix** (graphics on 3xxx/4xxx,
    business on the 8032: `keys.8bs` and its `keys.pet.8032.8bs` twin), the
    **refresh rate fact** (`video.frameRate`, 60 for the non-CRTC boards,
    50 for the CRTC 4xxx/8xxx — `FRAME_SYNC.pet` measures the real period
    regardless, so this fact is documentation, not a build input), and
    which model `8bs run pet` launches. It carries an empty `build: {}`
    marker of its own — no `defsym`, but `video.columns`/`video.frameRate`
    are real `#fact()`-foldable values a program's own compile-time layout
    logic can read, so two builds that differ only by `model` can still
    differ in bytes, and the output filename has to account for that (see
    below) even though the linker's own RAM ceiling doesn't move.
  - `ram` — `4` (default, KiB), `8`, `16`, `32` — independent of which board
    is chosen, because it genuinely is on real hardware: "RAM expansion was
    external only" is one of this file's own corrected claims below — the
    2001-N/3xxx/4xxx boards take 32K **on board**, a real owner upgrade
    path, not a different machine. It places the program at `$0401` behind
    a BASIC `SYS` stub so the `.prg` autostarts with `RUN`, puts the stack
    at the top of RAM (`$2000` on 8K, `$8000` on 32K), and is the one option
    that sets the link script's ceiling (`build.defsym.__ram_size`, and
    `-ramsize` beside `-model` for every `xpet` launch, not just the
    2001's — 96K/128K stay out of range entirely; see "The model is the
    hardware" below).
  - `speaker` — `none` (default) or `attached`. The PET's own real sound
    hardware, however it gets there, is a single square wave on PIA1's CB2
    pin — see "Sound" below — and only the **CRTC boards (4016/4032/8032)
    have a built-in piezo speaker on it**; a 2001/3008/3016/3032 has none at
    all and needs one wired to the pin as it's exposed on the user port —
    the real "user port speaker hack." `xpet` always computes CB2's own
    audio waveform once VICE's master `-sound` is on — there is no VICE
    resource for "is a speaker physically present" — so `attached` is
    `-sound` (and `audio.voices: 1`) and `none` is `+sound` (and
    `audio.voices: 0`): what changes is whether there is anything to hear
    and whether a program compiling against `#fact(audio.voices)` should
    bother emitting CB2 tones at all, not anything about the emulated
    electrical signal itself. It carries the same kind of empty `build: {}`
    marker as `model`, for the same `#fact()`-folding reason.
  - Every catalog preset (`--profile <model>`) pins its own real stock `ram`
    (and, for the CRTC boards, `speaker: 'attached'`) alongside `model`, so
    `--profile 8032` still means exactly what it always has — 32K, business
    keyboard, its own built-in speaker — even though those are now three
    separate option choices under the hood, not one. A selection that
    differs from EVERY option's own catalog default appears in the output
    name (`main-pet-8032-32-attached.prg`); one that only differs in `ram`
    does too (`main-pet-16.prg`, e.g. a 2001 upgraded to 16K) — the name
    disambiguates by option, not by preset.
- `FRAME_SYNC.pet` (`packages/compiler/src/mos`) is the only *edge* driver
  that measures rather than assumes: PIA1's CB1 line carries vertical
  retrace, its flag is CRB bit 7 at `$E813`, and reading ORB (`$E812`)
  clears it. The driver runs under `sei` because the KERNAL's own IRQ
  handler reads `$E812` every frame (jiffy clock and keyboard scan) and
  would win the race for the flag. At start-up it times two retrace edges
  with VIA Timer 2 (`$E848`/`$E849`) and derives the frame ratio from the
  measured cycles-per-frame and the flat 1 MHz clock, so one build runs at
  the configured `frameRate` on a 50 Hz and a 60 Hz PET alike. Consequence
  worth knowing: **a program that calls `waitFrame()` anywhere runs with
  interrupts off from start-up** — the `sei` is in the frame prologue the
  backend emits for such a program — so the KERNAL keyboard scan is dead
  there and input polls PIA1 itself. A program with no `waitFrame()` gets
  no prologue and keeps the KERNAL IRQ; nothing in this package is written
  for that case.
- `8bs run pet` launches `xpet -model <model>` (the value's `run` flags)
  and nothing about a region: the PET has no `--pal` (`PET_REGION_NOTE` in
  `packages/cli`; the flag prints a note and changes nothing). VICE runs the no-CRTC 3xxx at
  its hardcoded ~60.1 Hz and the CRTC models (4016, 4032, 8032) with their
  50 Hz editor ROMs, because the 60 Hz editors it ships make it refuse
  autostart; the program measures whichever it gets. `--screenshot`
  converts `--frames` to cycles with `PET_CLOCK_HZ = 1_000_000` and the
  model's nominal rate (the value's `video.frameRate` fact).
- `8BS3003` (the linker's hardware-hazard check) refuses a write to
  `$E842` on the PET unless it is a compile-time value with bit 5 clear —
  see "Hazards" below.
- **Keyboard**, PET-only, the layer a portable `@8bitscript/input` will
  sit on: `@8bitscript/pet/keyboard` (`src/keyboard.8bs`) reads all ten
  matrix rows into a snapshot once a frame — `keyboard.scan()` right after
  `waitFrame()` — and answers `keyboard.pressed(key)` / `keyboard.row(n)`
  from it; `@8bitscript/pet/keys` (`src/keys.8bs`) names every key as
  `Key.X = row * 8 + column` for the graphics matrix, with
  `keys.pet.8032.8bs` the business matrix a build tagged `8032` reads instead.
  PIA1's two ports are exported from `src/index.8bs` (`pia1PortA` `$E810`,
  `pia1PortB` `$E812`). No buffer, no PETSCII: "is this key down now".
- `packages/studio/src/main.8bs` starts Studio's **viewer** tier on the
  PET — read-only: view a character set and a sprite, play a tune, load a
  file, never edit or save. Nothing about the PET's name says so; the
  tier is read from its facts, and the PET fails all three editor gates
  (`video.glyphs` 0, the font is this ROM; `video.sprites` 0;
  `audio.voices` 1, and one fixed-volume voice plays a tune but does not
  compose one). RAM is *not* the gate here — a 3032 has 31743 bytes, more
  than the VIC-20 that does edit — so no memory expansion lifts the PET.
  A hi-res board or a SID cartridge would, by changing those facts; see
  `packages/studio/AGENTS.md`.

There is no sound, no *portable* input (the keyboard layer above is the
PET's own; `@8bitscript/input` does not exist), no reverse-video access, no `.tap`
output, no banking model, and no model detection — for the PET or (mostly)
for any machine. The rules below are what to hold that work to when it
comes.

## Facts verified here

Cite these freely; each was read in the source named or seen on screen
under xpet, not recalled.

| Fact | Where |
| ---- | ----- |
| Scanning all ten keyboard rows (ten reads of `$E812`) right after `waitFrame()` returns loses no frames: 1000+ frame intervals timed with VIA T2 inside the program on the 3032 and the 8032, and the count of over-long intervals is identical with and without the scan (2 and 2 on the 3032 — the runtime's own double-waits for 60 logical frames on 60.1 Hz hardware — 0 and 0 on the 8032). Reading `$E812` between a retrace and the poll *would* eat that edge; the snapshot rule keeps the read where it is safe. | measured here, `scratch-lost` runs under xpet |
| Both `Key` tables match VICE's positional keyboard maps key for key (graphics: `gtk3_grus_pos.vkm`; business: `gtk3_buuk_pos.vkm`, the UK layout xpet's 8032 loads). | `/opt/homebrew/share/vice/PET/`, `packages/compiler/test/pet-keys.test.mjs` |
| Program load address `$0401`; usable RAM `$0401` to `__ram_size` KiB; stack grows down from the top of RAM; `__ram_size` must be 8, 16 or 32 — the link script asserts against 96K/128K machines. Zero page `$0002–$008D` is BASIC 2/4's; **BASIC 1 (the 2001) copies CHRGET to `$C2–$D9`** (the same 24-byte routine BASIC 2/4 puts at `$70–$87`). The native backend's zp budget is `$8E–$FF` with that BASIC 1 window left unused (`memory.chrget`, `packages/compiler/src/mos`), so a `SYS` return still has an interpreter — occupying it was `?SYNTAX ERROR IN 0` on hello-world. | PET link map (measured pre-0.2.0); BASIC 1 CHRGET at `$C2` measured against the ROM and retrocomputing.SE / *Machine Language for Beginners* Appendix G; the 2001 hello-world screenshot |
| The `.prg` starts with a one-line BASIC program whose `SYS` jumps to `_start`, so `RUN` after `LOAD` starts it. | `pet/lib/basic-header.o`, `commodore/lib/commodore.ld` |
| PIA1 `$E810`, PIA2 `$E820`, VIA `$E840`, CRTC `$E880` (data at `$E881`); the CRTC is a **6545** (all models from 40xx and above), and a 6551 ACIA at `$EFF0` is SuperPET-only. | PETdoc.txt; VICE `petmem.c` |
| A PET program starts in whatever character set the ROM booted — graphics on the 3032/4032, text on the 8032 — and `text.8bs` writes `$0C` to the VIA PCR before each run so 1–26 render as capitals. A CHROUT of PETSCII 14 (`lda #$0e / jsr $FFD2`) would flip the machine to lower-case; 8BitScript does not emit that. | probe screenshots; `src/text.8bs` |
| `xpet -model 3032` boots BASIC 2 in upper-case/graphics mode; `4032` boots BASIC 4 in upper-case; `8032` boots BASIC 4 in lower-case text mode (its business editor ROM's choice). All three report `31743 BYTES FREE`. | boot screenshots via `-limitcycles -exitscreenshot` |
| A 40-column build's text appears at the top-left of an 8032's 80-column screen: screen RAM is `$8000` on the 80-column machine too. | borders `.prg` on `-model 8032` |
| VICE's PET models: 2001, 3008, 3016, 3032, 3032B, 4016, 4032, 4032B, 8032, 8096, 8296, SuperPET. RAM sizes 4/8/16/32/96/128; `-videosize 0/40/80` (0 = from ROM); CRTC "all models from 40xx and above"; `-screen2001` mirrors the 1K screen through `$8FFF` ("otherwise mirrors, if any, only go up to `$87FF`"); `-eoiblank` is a "Model-2001-only quirk"; `CB2Lowpass` filters the emulated CB2 sound; `-petdww` (30xx) and `-pethre` (8296) are hi-res *add-on boards*; Color PET (`$8800` color RAM) and `-sidcart` are third-party extensions. | VICE 3.10 manual §7.7, `xpet -help` |
| ROM sets: 3032 = kernal-2 + edit-2-**n** (graphics keyboard) + characters-2 (901447-10) + basic-2; 4032 = kernal-4 + edit-4-40-n-50Hz + characters-2 + basic-4; 8032 = kernal-4 + edit-4-80-**b**-50Hz + characters-2 + basic-4; 2001 = kernal-1 + edit-1-n + characters-1 (901447-**08**) + basic-1. | `/opt/homebrew/share/vice/PET/*.vrs` |
| Measured frame period under VICE's 4032 (PAL): ~19992 cycles, 50.02 Hz. | `FRAME_SYNC.pet` comment (this project's earlier measurement) |
| The catalog's stock fact sheet: grid 40×25 of 8×8 (80 on the 8032, its `model` value's fact), 2 colors, 2 per cell (normal and reverse), no redefinable glyphs, 2×2 PETSCII blocks, no bitmap, one layer, no scroll, no sprites; one CB2 voice with no volume, envelope, noise, samples or random source; keyboard, no joystick or pad ports; disk; RAM per model (`memory.ram` on each `model` value, from `__ram_size`), nothing banked, no mouse or paddles. | `src/geometry.8bs`, `src/geometry.pet.8032.8bs`; the `__ram_size` and sound rows above; `package.json` (read) |
| The sixteen quadrant-block screen codes: eight ROM glyphs at 96-127 (blank, a half, one quadrant alone, or the TL+BR diagonal), byte-identical whether the ROM address's charset-select bit is 0 or 1, and their reverse-video complements at 224-255 cover the remaining eight patterns (top half, the TR+BL diagonal, and every three-quarter pattern). | a script reading `characters-2.901447-10.bin` 8 bytes/glyph, `packages/pet/src/blocks.8bs`, `packages/pet/test/blocks.test.mjs`'s xpet screenshot check |
| `xpet -drive8type` (both #8 and #9) takes exactly nine values: `0` no drive, `2031` CBM 2031, `2040` CBM 2040, `3040` CBM 3040, `4040` CBM 4040, `1001` CBM 1001 (the SFD-1001), `8050` CBM 8050, `8250` CBM 8250, `9000` CBM D9090/60 — one flag, no image format in it. Units run `-8`/`-9`/`-10`/`-11`; a dual drive's second mechanism is `-8d1` etc. Two tape ports exist (`-1`, `-2`, both "Attach \<name\> as a tape image"), matching PIA1's cassette #1 pins (above) and VIA's cassette #2 pins (below). | `xpet -help`, VICE 3.10, this host |
| Real capacity per drive, measured rather than recalled: `c1541 -format` an image of each type and read its own directory's free-block count back (a block holds 254 usable data bytes — 256 minus the 2-byte next-track/sector link). D64 (2031, 4040, and 1541 — 2031/4040 named alongside the 1541 as D64-compatible; DOS 2) 664 blocks = 164 KiB; D67 (2040, 3040 — DOS 1) 670 blocks = 166 KiB; D80 (8050) 2052 blocks = 508 KiB; D82 (8250, and the SFD-1001's own single-drive `1001` type — same double-sided 77-track geometry, cross-checked against its documented 1,066,496-byte raw image size) 4133 blocks = 1025 KiB; D90 (`9000`) 29162 blocks = 7233 KiB. The 2040 and 3040 are the same DOS 1 drive, NTSC vs PAL — the 4040 is a different, later DOS (2.0), not a third region. | `c1541 -format` (d64/d67/d80/d82/d90), VICE 3.10, this host; lib1541img/lemon64 (2031+4040 named as D64); Computing History UK (SFD-1001 image size) |
| `c1541 -format t,01 d90` (the only image format VICE's tools offer for the `9000` drive type) produces a 152-track image, 29162 blocks free — the larger D9090's geometry (7.5 MB nominal), not the smaller D9060's (5 MB). VICE has one `-drive8type` for both real products; this only establishes what the D90 *image format* is sized for, not that `xpet` itself defaults every `9000` drive to D9090 internals. | measured here (`c1541`, not `xpet`); a community report independently gives the same 29162-block count for a D9090 |
| **The SFD-1001 was Commodore's own product** (1984, made for Commodore in Asia, distributed for a time through Progressive Peripherals & Software) — not a third-party drive. It is electronically one 8250 mechanism (same DOS 2.7, same D82 geometry) in a single-drive case. | Computing History UK; The Silicon Underground; c64-wiki SFD-1001 |

## From the sources, not verified here

These come from the documents cited; each is a lead to confirm the first
time code depends on it. André Fachat's PET index
(`6502.org/users/andre/petindex/`) is the primary reference for anything
below not attributed otherwise.

**Memory map** (progmod.html, PETdoc.txt): `$0000–$7FFF` RAM (4K–32K);
`$8000–$8FFF` screen (1K, mirrored ×4 on the original 2001 board; two
images `$8000`/`$8400` on later 40-column boards; one 2K image on
80-column boards); `$9000–$AFFF` expansion ROM sockets (4K each);
`$B000–$BFFF` expansion ROM or the low 4K of BASIC 4; `$C000–$DFFF`
BASIC; `$E000–$E7FF` editor ROM; `$E800–$EFFF` I/O (only `$E810`–`$E8FF`
used — decoding is minimal, so most of `$E8xx` aliases the four chips);
`$F000–$FFFF` KERNAL. Zero page `$0002–$008D` is BASIC's;
`$0200–$03FF` is OS workspace;
the 40-column screen is `$8000–$83E7`, the 80-column screen `$8000–$87CF`.

**PIA1 `$E810–$E813`** (progmod.html): `$E810` PA0–3 keyboard row select
(a 0–9 *value*, not a bit), PA4/PA5 cassette switches, PA6 IEEE EOI in,
PA7 diagnostic sense; `$E811` CRA — CA1 cassette #1 read, CA2 = screen
blank on the original 2001 (VICE `EoiBlank`) / IEEE EOI out on later
boards; `$E812` PB0–7 keyboard columns, **active low**; `$E813` CRB — CB1
vertical retrace (the IRQ source), CB2 cassette #1 motor.

**PIA2 `$E820–$E823`**: IEEE-488 data in (PA), data out (PB), NDAC/ATN
(CRA), DAV/SRQ (CRB). The KERNAL drives IEEE-488 itself from BASIC 2 on;
BASIC 1's routines were broken (petfaq; VICE has a `-basic1` patch for it).

**VIA `$E840–$E84F`** (progmod.html, PETdoc.txt): `$E840` PB — bit 0 NDAC
in, 1 NRFD out, 2 ATN out, 3 cassette write, 4 cassette #2 motor, **5
vertical retrace in**, 6 NRFD in, 7 DAV in; `$E841`/`$E84F` PA = user
port (with/without CA2 handshake); `$E842` DDRB, normally `$1E`; `$E843`
DDRA; `$E844–$E847` Timer 1; `$E848–$E849` Timer 2 (what `FRAME_SYNC.pet`
uses as a stopwatch); `$E84A` shift register (sound); `$E84B` ACR (`$00`
at power-on); `$E84C` PCR (`$0C`/`$0E`; bits 3–1 CA2 = charset, bits 7–5
CB2); `$E84D` IFR; `$E84E` IER.

**CRTC `$E880`/`$E881`** (crtc.html): a 6545 with the usual register-select
/ data pair; the editor ROM programs it at boot (40-column: R0=49, R1=40,
R2=41, R3=15, R4=39, R9=9; 80-column: R0=63, R1=40, R2=50, R3=8, R4=32,
R9=8 — 80 columns is *two bytes per character clock at 1 MHz*, not a
faster clock). MA12 inverts the whole pixel stream; MA13 selects the
2K half of a 4K character ROM (this is how the PCR bit reaches the ROM).
Only the 4xxx "Fat 40" and 8xxx machines have one; 2001/3xxx and the
thin 4xxx use discrete timing logic.

**Video timing.** Non-CRTC 2001 board (masswerk, *Character Bitmap
Graphics on the PET 2001*): 64 cycles per scan line (40 visible + 24
blank), 200 visible lines, 16640 cycles per frame, ~60.1 Hz. VICE's 3032
is described in `packages/cli/src/run.mjs` as 264-line ~60.1 Hz — the
two descriptions do not multiply to the same count; treat neither as
exact. CRTC 40-column at 50 Hz: 20000 cycles nominal (R0+1 = 50 cycles ×
400 lines), matching the ~19992 measured. The backend measures the real
period at start-up precisely so nothing here has to be exact.

**Snow** (boards.html, RC2017 article): only **board #1**, the original
2001 with slow static screen RAM, has the CPU/video collision that puts
snow on screen when the CPU writes during the visible frame. Board #2
(3xxx / thin 4xxx) reads screen RAM in the first half of Φ2 and has no
collision; the CRTC boards use faster DRAM and have none either. That is
why the package writes screen RAM at any time and why BASIC 2+'s faster
PRINT stopped waiting for retrace.

**The "killer poke"** (poke/index.html, dfarq.homeip.net): `POKE 59458,62`
is `$E842 = $3E`, the VIA's **DDRB**, making PB5 an *output*. On non-CRTC
boards the retrace input then always reads as the output latch and PRINT
stops waiting — faster, with snow on board #1. On CRTC boards PB5 is
wired to the CRTC's VSync line that also feeds the 12" monitor; driving
it drags the sync level down (~4.7 V to ~1 V average measured) and the
monitor's vertical ramp misbehaves, which over time kills the flyback.
The rule is simply: never make VIA PB5 an output. Nothing in 8bitscript
does, and the frame driver never touches `$E842`.

**Sound** (Tynemouth *PET Sounds*, progmod.html): one square wave on the
VIA's CB2 pin from the shift register in free-running mode — `$E84B = $10`
(ACR: shift out at T2 rate), `$E848` = T2 low byte sets the shift rate,
`$E84A` = pattern (`$0F`/`$F0` lowest octave, `$33`/`$CC` one up,
`$55`/`$AA` one more; other patterns change the duty cycle). E.g. `$0F`
with T2 `$EE` ≈ 260 Hz. `$E84B = 0` silences it. It runs without the CPU
and without interrupts. The **CRTC boards (#3, #4: Fat 40, 8032, 8296)
have a built-in piezo** on CB2 (through a gate with the diagnostic pin);
2001/3xxx have no speaker at all and need one on the user port's CB2.
VICE emulates the line (`CB2Lowpass`), so `xpet` can prove a sound API.
The catalog's own `speaker` option (above) is this fact made selectable:
`attached` on a CRTC preset (built in) or chosen explicitly on a non-CRTC
one (the user-port hack); `xpet -help` has no separate "speaker present"
resource, so the option's only real levers are VICE's master `-sound`/
`+sound` and this package's own `audio.voices` fact.

**Character set** (masswerk *PETSCII Revealed*, pagetable): 128 glyphs
per set, 8 bytes each; screen-code bit 7 inverts the glyph in hardware
(reverse video costs nothing and has no ROM copy). Screen codes: `$00–$1F`
`@A–Z[\]↑←`, `$20–$3F` space, punctuation, digits, `$40–$5F` and
`$60–$7F` graphics — lines, corners, half/quarter blocks, bar-chart bars,
card suits, circles — and in the text set `$40–$5F` become lower-case
(the original 2001's 901447-08 ROM has the two cases the other way
round: shifted letters are the lower-case ones). PETSCII → screen code: `$40–$5F` →
`$00–$1F`, `$A0–$BF` → `$60–$7F`, `$C0–$DF` → `$40–$5F`, `$20–$3F`
unchanged. `text.putChar` takes ASCII and does exactly the first of those.

**Keyboard** (keyboards.html, masswerk *PET Keyboard Test*): write row
`n` (0–9) to `$E810`'s low nibble, read `$E812`, pressed = bit clear.
The **graphics** (40-column) and **business** (80-column, and 4032B) key
matrices are different tables — e.g. Stop is row 9 bit 4 on both, but
letters and digits move. The 2001 chiclet keyboard shares the graphics
matrix. Interrupts must be off during a scan if the KERNAL IRQ is alive
(it is not, once the program calls `waitFrame()` anywhere — see above).
Three simultaneous keys can ghost a fourth: there are no diodes. And
reading `$E812` clears the CB1 retrace flag the frame runtime waits on,
which is why `@8bitscript/pet/keyboard` reads the matrix exactly once a
frame, into a snapshot, right after `waitFrame()`.

**8096 / 8296 banking** (8x96.html, 8296 supplement, Tynemouth): a
write-only register at `$FFF0` — bit 7 enable expansion, bit 6 I/O
peek-through (`$E800–$EFFF` stays visible), bit 5 screen peek-through
(`$8000–$8FFF` stays visible), bit 3 selects block 2/3 for `$C000–$FFFF`,
bit 2 selects block 0/1 for `$8000–$BFFF`, bits 1/0 write-protect the
two halves. `$0000–$7FFF` is always the same RAM. Because the IRQ/NMI
vectors, the KERNAL, and the register itself all live in the banked
half, code must copy vectors into expansion RAM (or keep I/O peek-through
and never bank while an interrupt can arrive) before enabling it. BASIC
still reports 31743 bytes; only machine code sees the rest. The 8296 is
a redesigned board with 128K on it and jumpers to remove the ROMs
entirely. **Neither the 8096 nor the 8296 is a linked model today.**

**Model detection** (PETdoc.txt, lemon64): BASIC-era programs print a
character on row 1 and peek `$8000+40` vs `$8000+80` to learn the width;
nothing in ROM is a reliable model ID across BASIC 1/2/4. Treat width as
a build-time profile (below), not a runtime probe.

**Board and chip inventory** (a secondary survey pasted into this file
2026-09-09, not cross-checked against Fachat/PETdoc/VICE and not usable
for hazard decisions — confirm any part number before depending on it):
static-board 2001s used 2114 SRAM (or 6550 SRAM in some revisions) on
assembly 320008-family boards; the 2001-N/3xxx dynamic boards (320349)
used 4108/4116 DRAM; the "universal" 40/80-column board (8032029) is
what the file elsewhere calls the 4032/8032 family. ROM part numbers
cited across the line: 2316/6540 (early 2/4K BASIC and Kernal), 2332 and
2364 (later masked ROMs), with 2716/2732/27128 EPROMs on some third-party
or expansion boards. None of this changes any address already verified
above — it's provenance trivia for whoever is staring at a real board.

## Corrections to the research notes

The notes that prompted this file mix André Fachat's accurate material
with a secondary source (a "Retro Game Coders" PET page) whose memory map
is a C64/VIC-20 conflation. The following in the notes are wrong or
unverified:

- **"On 4000/8000 PETs the screen RAM moved to `$0400`."** No. Screen RAM
  is `$8000` on every PET ever made; the 80-column machines extend it to
  `$87CF`. Verified on screen here (8032 shows the 40-column build's cell 0
  at top-left) and by every primary source. `$0400` is the C64's screen.
- **"I/O at `$9000–$9FFF`"** and **"the VIA controls the keyboard matrix"**.
  I/O is `$E810–$E8FF`; `$9000–$AFFF` are ROM sockets. The keyboard is on
  **PIA1** (`$E810`/`$E812`); the VIA has the user port, retrace input,
  timers and sound.
- **"Motorola 6845 CRTC"**: it is a MOS 6545 (PETdoc and VICE both
  say 6545; the two are near-relatives, but write 6545).
- **"The video-on flag at VIA port B bit 5 (`$E840`) — BASIC halts output
  if high."** Right register, wrong sense: PB5 is the *retrace input*, and
  BASIC 1's PRINT *waits* for retrace before writing. Later ROMs don't wait.
- **"`POKE 59458,62` sets VIA DDRB … at `$E842`"** is correct; keep the
  hex, and keep it out of everything.
- **"A video disable register at `$FFD9`"** and **"detect `$906F`"**: no
  source mentions either; `$FFD9` is inside the KERNAL ROM. The real 2001
  screen-blank is PIA1 CA2 (`$E811`), removed on later boards. Do not
  propagate either address.
- **"The KERNAL has no IEEE-488 driver."** False from BASIC 2 on; the
  KERNAL's IEEE routines are what every PET disk drive used. Only BASIC 1's
  were unusable.
- **"A 4K PET reports ~7167 bytes free."** 7167 is the 8K machine's figure;
  4K reports 3071 and 32K reports 31743 (seen here).
- **"Writing VRAM outside blanking causes snow on early PETs."** Only on
  the original 2001 board. It is a model constraint, not a PET constraint,
  and the package's write-anytime text is correct for every model VICE's
  3032/4032/8032 stand for.
- **The hi-res trick** ("PECBM", "rewrite the character RAM pointers") is
  the 2022 Genesis Project demo technique masswerk documents: rewriting
  the *contents* of the current screen row every scan line, ~10 cells (80
  pixels) wide, within a 64-cycle line, on the non-CRTC 2001/2001-N only,
  and limited to pixel rows that exist in some ROM glyph. It is not a
  general bitmap mode and "PECBM" appears in no source; don't use the name.
- **"RAM expansion was external only."** The 2001-N/3xxx/4xxx boards take
  32K on board; the 8096's 64K is a daughterboard.
- **"Later PETs booted in lower-case"** would also be wrong: only the
  business-keyboard editor ROMs (8032, 4032B, 3032B) start in text mode;
  the 3032 and 4032 boot in upper-case/graphics. An 8bitscript program
  starts in whichever set the ROM left until its first `text.8bs` call —
  no CHROUT of PETSCII 14 is emitted (verified above); `text.8bs` selects
  the text set itself before every run (the graphics set, before the
  mixed-case rework this file's own "one global bit" correction above
  documents). A lesson from writing
  this file: a CHROUT of PETSCII 14 is a KERNAL call, and a search
  of start-up for a `$E84C` write "proved" it did not exist. Check the linked
  binary, not the pieces.
- **The same C64 memory map keeps coming back.** A later "PET models and
  hacks" survey (pasted into this file 2026-09-09) puts screen RAM at
  `$0400–$07FF` and I/O at `$D000–$DFFF` with BASIC/KERNAL split
  `$A000`/`$E000`-ish — that is the C64's map again, not the PET's; see
  the first correction above. Screen is `$8000`, I/O is `$E810–$E8FF`.
  Any future source that puts the PET's screen or I/O anywhere else is
  wrong by construction; don't re-derive it, just check this file.
- **That survey's VICE config example** (`-RAMSIZE`, `-CRTC`,
  `-VIDEOSIZE`, `-ROMMODULE9`, `-ROMMODULEA`) does not match real `xpet`
  flags — `Ram9`/`RamA` are VICE resources, not those CLI switches, and
  none of the others exist under those names. `xpet -help` and
  `/opt/homebrew/share/vice/PET/*.vrs` (already cited above) are the only
  authority for VICE flags; don't add flags from a paraphrase.
- **Its 8096/8296 bank-switch example** (`LDA #$01 / STA $9F01`) is
  invented. The real register is `$FFF0`, already documented in "8096 /
  8296 banking" above with every bit's meaning; that section supersedes
  any generic guess.
- **Its "unrolled fast screen clear"** (`STX $8000,X` / `STX $8400,X` /
  `STX $8800,X` / `DEX` / `BPL`, claimed to "clear 4096 bytes in one
  iteration") is wrong on its own terms: an 8-bit `X` loop with three
  stores per iteration clears 3×256 = 768 bytes over 256 iterations, not
  4096 bytes in one. The cycle-cost math already in "The screen is the
  only output" (8 cycles/byte unrolled, ~14 indexed) is the number to use.
- **"Standard PET lacks NMI"**: unverified and likely a garble of NMOS
  (the 6502 process) with NMI (the interrupt line); no PET source cited
  here makes that claim. `FRAME_SYNC.pet` uses the CB1 IRQ path (verified
  above) regardless of whether NMI exists on the expansion port.
- **A JSON "profile builder" schema** (`model`/`ramSize`/`crtc`/...) for
  driving VICE from a hypothetical VS Code extension: this project
  already has that surface — `package.json`'s `"8bitscript".hardware`
  catalog plus `8bs targets --json` (see `packages/studio/AGENTS.md` and
  the hardware-catalog rules in the root `AGENTS.md`). Extending config
  shape belongs there, not as a new parallel schema.
- **A storage-devices survey** (pasted into this file 2026-09-09, "PET Disk
  & Storage Devices") is mostly right on the model list but wrong or
  unsourced on: **"SFD-1001 … third-party 'Super Floppy' by Mikro-Partner
  (Bern)"** — it was Commodore's own drive, see the corrected row above;
  **capacities given as raw image size or a round number** ("170K",
  "500K", "1M", "5-7.5MB") rather than the DOS's actual free space, which
  this file now gives measured (see above); **no mention of VICE's `1001`
  type at all**, a real gap this file's catalog change closed (the
  catalog itself, separately, had folded 2040 and 3040 into one entry
  before this pass — not the survey's error, but fixed alongside it since
  VICE names them as two separate `-drive8type` values); **8″ drives
  (8060/8061/8062/8280)** — `xpet -help`'s `-drive8type` enum is
  exhaustive and has no 8″ entry, so don't add them as buildable options
  even as documentation; and **a years/prices/"Executive Summary" framing**
  that doesn't belong in a
  research-notes file built to be cited, not read as prose.

## Rules for this target

### The model is the hardware, and width is not derivable from RAM

- The catalog's `model` option has a value per model number, and a value
  fixes **screen width** (40 or 80 — `text.COLUMNS`, `text.CELL_COUNT`,
  `screen.blank()`'s extent, through the geometry file's tag twin — and
  which xpet model `8bs run` picks) and **keyboard matrix** (graphics on
  3xxx/4xxx, business on the 8032: `keys.8bs` and its `keys.pet.8032.8bs`
  twin). RAM size is the separate `ram` option's job now (milestone-10-era
  rework, above) — a real owner could, and on the dynamic boards did,
  upgrade RAM without changing anything about the screen or keyboard, so
  the catalog no longer ties the two together. Both are still compile-time,
  the way Studio's tier is; a program must never probe the screen width at
  run time. `cell = y * text.COLUMNS + x` with a 40-column constant on an
  80-column screen is not "narrow" — row 1 lands in the middle of row 0.
  New per-model facts go the same way: the value's tag's version of one
  small file (`x.pet.8032.8bs`), read through a namespace const, never a
  copy of a surface — or, for a number, a `facts` entry on the value.
- 96K/128K is not a RAM size, it is a banking model, and this target does not link
  it — the `ram` option's own values stop at 32, the on-board maximum for
  every model this catalog supports. If banked RAM ever arrives it follows
  the root rule for banked machines: a (block, offset) pair is not a
  pointer — and it is not a `ram` value until the link script and the
  language can hold it.
- The 60 Hz BASIC 4 editor ROMs break VICE autostart; that is an emulator
  fact, not a hardware one, and it is why the 4xxx/8xxx profiles run at
  50 Hz here. The catalog's own default `model` is the 2001 — the smallest,
  harshest real PET, not the easiest one to autostart — so a bare `8bs run
  pet` tests a program against the machine most likely to expose a real
  constraint, the same reasoning the zero-page budget and every milestone's
  own gate already use. A 60 Hz CRTC PET needs another launch route (a disk
  image, or `-limitcycles` plus the monitor); the program itself would not
  care, since it measures the period.

### The screen is the only output, and it is bytes

- Everything visible is a screen code at `$8000 + cell`; the portable
  surfaces already treat it that way. A future block/pattern helper draws
  by writing glyph indexes — `$60–$7F` and `$40–$5F` are the shape set —
  never by pretending there are pixels. If a shape is not in ROM it is
  not drawable; document the chart, don't emulate around it.
- **Reverse video is free** (bit 7) and the portable surface has no way to
  ask for it. It is the PET's only "color" and the obvious meaning for a
  PET implementation of any future per-cell emphasis/color intent —
  better than `putColor` doing nothing. Keep it a screen-code property, not
  a separate register.
- The character set is **one global bit** (PCR bit 1) for the whole
  screen — the program cannot show the graphics set's own non-letter
  symbols (hearts, lines, card suits — the ones outside `blocks.8bs`'s own
  quadrant range) at the same time as real upper/lower-case text. It
  turned out to be wrong that mixing cases costs that trade at all: the
  **text** set alone already holds both cases at once (measured against
  `characters-2.901447-10.bin` — 'A'-'Z' at screen codes 65-90, 'a'-'z' at
  1-26, `packages/pet/src/text.8bs`'s own header), so `text.8bs` now
  selects the text set, not the graphics set, every run — and gets real
  mixed-case text for free, not by "owning the bit deliberately." What it
  does still lose, in the text set, is the graphics-mode-only symbols
  outside `blocks.8bs`'s own quadrant range (verified unaffected — see
  that file's header); a program that wants those and mixed-case text on
  screen at the same instant genuinely cannot, since it is one bit for the
  whole screen either way.
- **The original 2001's own character ROM is not the same file as every
  later model's**, and gets the two cases backwards from it. VICE's own
  romset files name two different chargen ROMs (`characters-1.901447-08.bin`
  for the 2001's `rom1g`, `characters-2.901447-10.bin` for every other
  catalog model's `rom2g`/`rom2b`/`rom4g40`/`rom4b40`/`rom4b80` — confirmed
  by which `.vrs` file each `-model` name loads, `/opt/homebrew/share/vice/
  PET/*.vrs`, not assumed from the filenames alone) — measured both
  directly, not read off a datasheet: on 901447-10, the text set's screen
  code 1 is 'a' and code 65 is 'A'; on 901447-08, code 1 is *still* 'A'
  (unchanged from the graphics set) and code 65 is 'a'. Building milestone
  10's real mixed-case `hello-world` against the *default* profile (2001,
  the smallest real PET — see the CLI/AGENTS notes on why that is the
  default) is what surfaced this: the offsets that render correctly on
  every other model produced exactly this swap's own symptom on a 2001
  screenshot, upper and lower case both present but exchanged. The fix is
  `video.characterSetSwapped` (`packages/compiler/src/fold/facts.mjs`,
  `program: false` — this is `asciiToScreenCode`'s own business, not a
  program's), true only on the `2001` catalog value, `#fact()`-folded into
  `packages/pet/src/text.8bs`'s own offset choice at build time. Screenshot-
  verified on all seven catalog models, not assumed to generalize from one.
- Writes may happen at any time on every supported model (no snow, no
  queue, no blank budget). Do not import the NES's vblank queue here. The
  only reason to sync to retrace is tearing, and `waitFrame()` already
  provides that edge.
- Scrolling, sprites, and animation are software: shift the 1000 bytes, or
  redraw the cells that changed. At 1 MHz a full 1000-byte copy costs
  about half a 60 Hz frame fully unrolled (8 cycles a byte) and most of
  one as an indexed loop (about 14); budget in cells written, not frames.

### Sound is one line

- The PET's voice is the VIA shift register on CB2: a free-running square
  wave whose pitch is T2 × pattern length and whose only other parameter
  is duty cycle. A note-level API (`packages/studio/AGENTS.md`'s sound
  capability) maps onto exactly *one* voice with no volume; document that
  and stop. `$E84B`, `$E84A`, `$E848` are the whole interface.
- Whether anything is *heard* depends on the board: piezo on the CRTC
  boards, nothing on 2001/3xxx without a user-port speaker. The API is the
  same; the profile can say which.
- Never route sound through the KERNAL or timers that need IRQs — the
  program runs with interrupts off.

### Input is a matrix you scan yourself

- Poll PIA1 directly: row value to `$E810`, columns from `$E812`, active
  low. The matrix table is part of the profile (graphics vs business):
  `Key.*` from `@8bitscript/pet/keys`, never a number. Any "joystick" is
  a key mapping; there is no port. Expect ghosting beyond two
  simultaneous keys.
- **Read `$E812` once a frame, right after `waitFrame()`, into a
  snapshot** — `keyboard.scan()` — and answer every question from the
  snapshot. Reading the port clears the retrace flag the frame runtime
  polls; a read anywhere else in the frame can eat an edge and stall a
  whole frame. Anything built on this layer (a portable `input`, a key
  repeat, a text field) queries `keyboard.pressed()`/`keyboard.row()`,
  never the port. Verified frame-exact under xpet (table above).
- Keys a program can name on every PET are the ones both tables share
  (letters, `DIGIT_n`, SPACE, RETURN, STOP, cursor keys, shifts, the
  shared punctuation — `packages/compiler/test/pet-keys.test.mjs` lists
  them). A graphics-only name (`EXCLAMATION`) is a link error on the 8032,
  by design.

### Hazards

- **Never make VIA PB5 an output** (`$E842` bit 5). This is the killer
  poke. Nothing in the toolchain does, and the linker refuses a program
  that would (`8BS3003`, `packages/compiler/src/linker/hazards.mjs`): a
  `memory.write`, an `@address` assignment, or an element store at `$E842`
  is allowed only with a compile-time value whose bit 5 is clear, because
  the register's other bits have legitimate uses (cassette motor and
  write, IEEE NRFD/ATN). A runtime value there cannot be proved safe and
  is refused too. `8bs build` reports it; `8bs check` and the editor
  cannot, since they analyse a file without a machine.
- Do not touch `$E811` CA2 for "screen blanking": it is IEEE EOI on every
  board after the first.
- `$E8xx` decoding is minimal; writing an unlisted `$E8xx` address hits a
  chip. Stay on the documented four bases.

### Verify before you write it down

The COLBK/COLPF2 rule from the root file applies: the sources above
disagree with each other on frame line counts and the notes disagreed with
the sources on the memory map. `xpet -model <m> -limitcycles N
-exitscreenshot f.png` and the remote monitor are cheap; use them before
adding a number to this file, and move the row from "from the sources"
to "verified here" when you do.

## Seeing the screen without a human at xpet

`8bs run pet --screenshot <file.png>` builds and captures through VICE's
`-limitcycles`/`-exitscreenshot` (see
[`docs/setup/verify.md`](../../docs/setup/verify.md#screenshots));
`--frames` is converted at 1 MHz and the region's nominal rate. To look at
another model, launch `xpet -model 8032 -autostartprgmode 1 -limitcycles
8000000 -exitscreenshot out.png -autostart dist/main-pet.prg` yourself —
that is how the 8032 row above was checked.

## Where things live

```
packages/pet/src/index.8bs           target package: viaPeripheralControl ($E84C), the character-set bit
packages/pet/src/geometry.8bs        Video.COLUMNS/ROWS/CELL_COUNT for the 40-column PETs (40, 25, 1000)
packages/pet/src/geometry.pet.8032.8bs   the 8032 tag's version (80, 25, 2000), chosen by the model value
packages/pet/src/screen.8bs          @8bitscript/pet/screen: inert colors, blank() over Video.CELL_COUNT cells at $8000
packages/pet/src/text.8bs            @8bitscript/pet/text: ASCII → screen code, direct writes, COLUMNS/CELL_COUNT from Video
packages/pet/src/keyboard.8bs        @8bitscript/pet/keyboard: scan() snapshot of the ten rows, pressed(key), row(n)
packages/pet/src/keys.8bs            @8bitscript/pet/keys: Key.X = row * 8 + column, graphics keyboard
packages/pet/src/keys.pet.8032.8bs   the 8032 tag's version: the business keyboard
packages/pet/package.json            "8bitscript".exports names the four subpaths
packages/compiler/test/pet-keys.test.mjs   both tables well formed, shared names, VICE .vkm cross-check, profile picks the table
packages/pet/package.json            "8bitscript".hardware: model (__ram_size, -model, tag, columns and frame-rate facts), ram, speaker, drive (all nine real -drive8type values, measured storage.kib), a preset per model
packages/compiler/src/mos/index.ts  FRAME_SYNC.pet (CB1 retrace, T2 calibration; the backend refuses to build)
packages/compiler/src/linker/hazards.mjs   8BS3003: the $E842 killer-poke rule
packages/cli/src/run.mjs             PET_REGION_NOTE, why no --pal and no 60 Hz editors; the model's flags come from the catalog
packages/cli/src/screenshot.mjs      PET_CLOCK_HZ, --frames → cycles at the model's rate (the video.frameRate fact)
packages/studio/src/main.8bs         Studio's entry; the PET's facts pick the viewer tier (glyphs/sprites/voices, not RAM)
docs/setup/vice.md                   installing xpet with the other VICE emulators
docs/roadmap.md                      Phase 2: why the PET is in the target list
Fachat PET index / PETdoc.txt       chip bases ($E810 PIA1, $E820 PIA2, $E840 VIA, $E880 CRTC), $0401 load
/opt/homebrew/share/vice/PET/        ROM images and the *.vrs sets each xpet model loads
```
