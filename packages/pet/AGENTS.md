# Writing Commodore PET support for 8BitScript

This file is for anyone — human or agent — touching `packages/pet`,
`packages/backend-6502`'s `pet` entries (`PET_PROFILES`,
`FRAME_SYNC.pet`), `packages/cli`'s `xpet` handling (`PET_MODEL_ARGS`,
`PET_CLOCK_HZ`), the `pet` row of the linker's hardware-hazard table, or
the PET rows of `docs/roadmap.md` and
`packages/studio/AGENTS.md`. Read the root [`AGENTS.md`](../../AGENTS.md)
first; the rules there apply to every target and are not repeated.
[`packages/nes/AGENTS.md`](../nes/AGENTS.md) and
[`packages/cx16/AGENTS.md`](../cx16/AGENTS.md) are the two contrasts: the
NES has almost nothing and forces abstraction; the X16 has a great deal
behind windows and ports. The PET is a third case —

> **The PET has *only* a CPU, RAM, a character ROM, and three I/O chips.
> There is no video chip to program (on most models), no colour, no sound
> chip, no sprites, no bitmap, and no joystick port. Everything the program
> shows is a byte in screen RAM naming one of 128 fixed glyphs, possibly
> inverted. Model it as a memory-mapped 40×25 (or 80×25) grid of glyph
> indexes with a keyboard matrix, a 1 MHz clock, and one square-wave line —
> never as "a C64 without colour".**

The machine's variety is in *models*, not features: RAM size (4K–32K, with
64K/128K only via banking that the SDK's link script refuses), screen width
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
  inert**: the PET has no colour hardware and no border. `screen.blank()`
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
  `geometry.pet.8032.8bs` twin (80 and 2000) a build with `--profile
  8032` reads instead — the profile-level file rule in
  `docs/packages.md`, and the reason namespace consts may now be
  initialised from another module's const. `screen.blank()` clears
  `Video.CELL_COUNT` cells the same way. `locate()` is not needed here:
  the screen is a flat array and cell arithmetic is the address.
- **Profiles** (`PET_PROFILES` in `packages/backend-6502`): `3032`
  (default), `3008`, `3016`, `4016`, `4032`, `8032` — the PET's own model
  numbers, which are also what `xpet -model` takes. A profile sets the
  RAM the program is linked for (`-Wl,--defsym=__ram_size=8|16|32`: the
  SDK's `pet/lib/link.ld` asserts `8 <= __ram_size <= 32`, "8x96 and
  SuperPETs are not supported by this target", places the program at
  `$0401` behind a BASIC `SYS` stub so the `.prg` autostarts with `RUN`,
  and puts the stack at the top of RAM — `$2000` on a 3008, `$8000` on a
  32K machine), the screen width the package draws to (80 for the 8032,
  through the geometry twin), and the model `8bs run pet` launches. A
  non-default profile appears in the output name (`main-pet-8032.prg`).
- `FRAME_SYNC.pet` (`packages/backend-6502`) is the only *edge* driver
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
- `8bs run pet` launches `xpet -model <profile>` and nothing about a
  region: the PET has no `--pal` (`PET_MODEL_ARGS` in `packages/cli`; the
  flag prints a note and changes nothing). VICE runs the no-CRTC 3xxx at
  its hardcoded ~60.1 Hz and the CRTC models (4016, 4032, 8032) with their
  50 Hz editor ROMs, because the 60 Hz editors it ships make it refuse
  autostart; the program measures whichever it gets. `--screenshot`
  converts `--frames` to cycles with `PET_CLOCK_HZ = 1_000_000` and the
  profile's nominal rate (`PET_PROFILE_FPS`).
- `8BS3003` (the linker's hardware-hazard check) refuses a write to
  `$E842` on the PET unless it is a compile-time value with bit 5 clear —
  see "Hazards" below.
- **Keyboard**, PET-only, the layer a portable `@8bitscript/input` will
  sit on: `@8bitscript/pet/keyboard` (`src/keyboard.8bs`) reads all ten
  matrix rows into a snapshot once a frame — `keyboard.scan()` right after
  `waitFrame()` — and answers `keyboard.pressed(key)` / `keyboard.row(n)`
  from it; `@8bitscript/pet/keys` (`src/keys.8bs`) names every key as
  `Key.X = row * 8 + column` for the graphics matrix, with
  `keys.pet.8032.8bs` the business matrix the 8032 profile reads instead.
  PIA1's two ports are exported from `src/index.8bs` (`pia1PortA` `$E810`,
  `pia1PortB` `$E812`). No buffer, no PETSCII: "is this key down now".
- `packages/studio/src/main.8bs` starts Studio's basic tier on the PET
  (`System.CURRENT == System.PET`: character editing, "rudimentary
  playback" once sound exists).

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
| Program load address `$0401`; usable RAM `$0401` to `__ram_size` KiB; stack grows down from the top of RAM; `__ram_size` must be 8, 16 or 32 — the link script asserts against 96K/128K machines. | `$LLVM_MOS_HOME/mos-platform/pet/lib/link.ld` |
| The `.prg` starts with a one-line BASIC program whose `SYS` jumps to `_start`, so `RUN` after `LOAD` starts it. | `pet/lib/basic-header.o`, `commodore/lib/commodore.ld` |
| PIA1 `$E810`, PIA2 `$E820`, VIA `$E840`, CRTC `$E880` (data at `$E881`); the SDK models the CRTC as a **6545** (`_6545.h`, "all models from 40xx and above"), and a 6551 ACIA at `$EFF0` as SuperPET-only. | `pet/include/pet.h` |
| LLVM-MOS's Commodore libc *would* switch the PET to the **lower-case** set before `main()`: `char-conv.c`'s `.init.250` section does `lda #$0e / jsr $FFD2` (PETSCII 14 through the KERNAL's CHROUT), and the linker's speculative libcall pass drags that object into every build (`--why-extract`: abort → fputs → stdio-minimal → `__to_ascii`). `packages/backend-6502` now defines the object's two weak symbols itself so it is never linked (`commodoreCharsetGuard()`); a built PET program makes no CHROUT call and starts in whatever set the ROM booted. Consequence: libc's own stdio (an `asm6502` block calling `__putchar`/`printf`) would print unconverted ASCII — off the map here by design. | `llvm-objdump -d dist/main-pet.prg.elf`, before and after |
| `xpet -model 3032` boots BASIC 2 in upper-case/graphics mode; `4032` boots BASIC 4 in upper-case; `8032` boots BASIC 4 in lower-case text mode (its business editor ROM's choice). All three report `31743 BYTES FREE`. | boot screenshots via `-limitcycles -exitscreenshot` |
| A 40-column build's text appears at the top-left of an 8032's 80-column screen: screen RAM is `$8000` on the 80-column machine too. | borders `.prg` on `-model 8032` |
| VICE's PET models: 2001, 3008, 3016, 3032, 3032B, 4016, 4032, 4032B, 8032, 8096, 8296, SuperPET. RAM sizes 4/8/16/32/96/128; `-videosize 0/40/80` (0 = from ROM); CRTC "all models from 40xx and above"; `-screen2001` mirrors the 1K screen through `$8FFF` ("otherwise mirrors, if any, only go up to `$87FF`"); `-eoiblank` is a "Model-2001-only quirk"; `CB2Lowpass` filters the emulated CB2 sound; `-petdww` (30xx) and `-pethre` (8296) are hi-res *add-on boards*; Colour PET (`$8800` colour RAM) and `-sidcart` are third-party extensions. | VICE 3.10 manual §7.7, `xpet -help` |
| ROM sets: 3032 = kernal-2 + edit-2-**n** (graphics keyboard) + characters-2 (901447-10) + basic-2; 4032 = kernal-4 + edit-4-40-n-50Hz + characters-2 + basic-4; 8032 = kernal-4 + edit-4-80-**b**-50Hz + characters-2 + basic-4; 2001 = kernal-1 + edit-1-n + characters-1 (901447-**08**) + basic-1. | `/opt/homebrew/share/vice/PET/*.vrs` |
| Measured frame period under VICE's 4032 (PAL): ~19992 cycles, 50.02 Hz. | `FRAME_SYNC.pet` comment (this project's earlier measurement) |

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
`$F000–$FFFF` KERNAL. Zero page `$0002–$008D` is BASIC's and the SDK
reuses it for its imaginary registers; `$0200–$03FF` is OS workspace;
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
entirely. **The SDK's PET link script cannot target either today.**

**Model detection** (PETdoc.txt, lemon64): BASIC-era programs print a
character on row 1 and peek `$8000+40` vs `$8000+80` to learn the width;
nothing in ROM is a reliable model ID across BASIC 1/2/4. Treat width as
a build-time profile (below), not a runtime probe.

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
- **"Motorola 6845 CRTC"**: it is a MOS 6545 (the SDK header and VICE both
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
  starts in whichever set the ROM left — the SDK's own switch to lower-case
  is kept out of the link (verified above), and `text.8bs` selects the
  graphics set before every run of text regardless. A lesson from writing
  this file: that SDK switch is a KERNAL call, and a search of the SDK
  archives for a `$E84C` write "proved" it did not exist. Check the linked
  binary, not the pieces.

## Rules for this target

### Models are profiles, and width is not derivable from RAM

- `PET_PROFILES` (`packages/backend-6502`) is a profile per model number,
  and a profile fixes **RAM size** (`__ram_size` 8/16/32 — the link
  script's whole range), **screen width** (40 or 80 — `text.COLUMNS`,
  `text.CELL_COUNT`, `screen.blank()`'s extent, through the geometry
  file's profile twin — and which xpet model `8bs run` picks) and
  **keyboard matrix** (graphics on 3xxx/4xxx, business on the 8032:
  `keys.8bs` and its `keys.pet.8032.8bs` twin). All three are
  compile-time, the way Studio's tier is; a program must never probe the
  screen width at run time. `cell = y * text.COLUMNS + x` with a
  40-column constant on an 80-column screen is not "narrow" — row 1 lands
  in the middle of row 0. New per-profile facts go the same way: a
  profile's version of one small file (`x.pet.8032.8bs`), read through a
  namespace const, never a copy of a surface.
- 96K/128K is not a RAM size, it is a banking model, and the SDK refuses
  it. If it ever arrives it follows the root rule for banked machines: a
  (block, offset) pair is not a pointer — and it is not a `PET_PROFILES`
  entry until the link script and the language can hold it.
- The 60 Hz BASIC 4 editor ROMs break VICE autostart; that is an emulator
  fact, not a hardware one, and it is why the 4xxx/8xxx profiles run at
  50 Hz here and the default is the 3032. A 60 Hz CRTC PET needs another
  launch route (a disk image, or `-limitcycles` plus the monitor); the
  program itself would not care, since it measures the period.

### The screen is the only output, and it is bytes

- Everything visible is a screen code at `$8000 + cell`; the portable
  surfaces already treat it that way. A future block/pattern helper draws
  by writing glyph indexes — `$60–$7F` and `$40–$5F` are the shape set —
  never by pretending there are pixels. If a shape is not in ROM it is
  not drawable; document the chart, don't emulate around it.
- **Reverse video is free** (bit 7) and the portable surface has no way to
  ask for it. It is the PET's only "colour" and the obvious meaning for a
  PET implementation of any future per-cell emphasis/colour intent —
  better than `putColor` doing nothing. Keep it a screen-code property, not
  a separate register.
- The character set is **one global bit** (PCR bit 1) for the whole
  screen: the program cannot mix upper/lower-case text with the full
  graphics set. `text.8bs` selects graphics before each run because some
  ROMs boot in text mode; anything that wants lower-case must own that bit
  deliberately and knows it loses half the graphics.
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
packages/pet/src/geometry.pet.8032.8bs   the 8032 profile's version (80, 25, 2000), chosen by --profile
packages/pet/src/screen.8bs          @8bitscript/pet/screen: inert colours, blank() over Video.CELL_COUNT cells at $8000
packages/pet/src/text.8bs            @8bitscript/pet/text: ASCII → screen code, direct writes, COLUMNS/CELL_COUNT from Video
packages/pet/src/keyboard.8bs        @8bitscript/pet/keyboard: scan() snapshot of the ten rows, pressed(key), row(n)
packages/pet/src/keys.8bs            @8bitscript/pet/keys: Key.X = row * 8 + column, graphics keyboard
packages/pet/src/keys.pet.8032.8bs   the 8032 profile's version: the business keyboard
packages/pet/package.json            "8bitscript".exports names the four subpaths
packages/compiler/test/pet-keys.test.mjs   both tables well formed, shared names, VICE .vkm cross-check, profile picks the table
packages/backend-6502/src/index.mjs  PET_PROFILES (__ram_size per model), FRAME_SYNC.pet (CB1 retrace, T2 calibration), commodoreCharsetGuard()
packages/compiler/src/linker/hazards.mjs   8BS3003: the $E842 killer-poke rule
packages/cli/src/run.mjs             PET_MODEL_ARGS (xpet -model <profile>), PET_PROFILE_FPS, why no --pal and no 60 Hz editors
packages/cli/src/screenshot.mjs      PET_CLOCK_HZ, --frames → cycles at the profile's rate
packages/studio/src/main.8bs         Studio's entry; the PET branch picks the basic tier
docs/setup/vice.md                   installing xpet with the other VICE emulators
docs/roadmap.md                      Phase 2: why the PET is in the target list
$LLVM_MOS_HOME/mos-platform/pet/     link.ld (__ram_size range, $0401), pet.h (chip bases), _6522.h/_pia.h/_6545.h
/opt/homebrew/share/vice/PET/        ROM images and the *.vrs sets each xpet model loads
```
