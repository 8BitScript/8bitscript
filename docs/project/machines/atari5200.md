---
title: Atari 5200
nav_order: 20
---

# Writing Atari 5200 support for 8BitScript

This file is for anyone — human or agent — adding the `atari5200` target
(roadmap phase 6): a `packages/atari5200`, its rows in
`packages/backend-6502` (`DRIVER`, `outputExtension()`, `FRAME_SYNC`),
`packages/cli/src/run.mjs`, `doctor.mjs`'s `CLANG_DRIVERS`, a
`docs/setup/atari5200.md`, and the 5200 row of `docs/roadmap.md`. Read
the root `AGENTS.md` first (paths in this note are relative to the
repository root); the rules there apply to every target and are not
repeated. Read `packages/atari8/AGENTS.md` second:
the chips are the same three, and most of that file applies here with the
addresses changed. The 5200 is the atari8 case with the computer removed —

> **The 5200 is an Atari 400 with the OS, the keyboard, the PIA, the
> serial bus and most of the RAM taken out and the chips moved: 16K of RAM
> at `$0000-$3FFF`, the cartridge over `$4000-$BFFF`, GTIA at `$C000`,
> ANTIC at `$D400`, POKEY at `$E800`, and a 2K BIOS at `$F800`. The BIOS
> is still in the loop the way the computer's OS is — its vertical-blank
> routine puts its own colour values back into GTIA every frame until the
> program clears NMIEN (seen here) or writes the BIOS's shadows (addresses
> *to verify*) — but nothing scans a keyboard: the only inputs are
> analogue sticks on POKEY's pot lines, a 12-key keypad on POKEY's
> keyboard scanner, and fire buttons on GTIA's triggers. Model it as "the
> atari8 chip layer with different base addresses, a much smaller OS
> layer, and an analogue input layer" — so that the ANTIC/GTIA/POKEY code
> is shared with `packages/atari8` and only the addresses, the start-up
> and the input differ.**

Its variety is small: the cartridge size (32K plain, or a 64–512K
"Super Cart" bank-switched by *reads* of `$BFC0-$BFFF`), whether the
console has four controller ports or two (*to verify* — the linker and
emulator sources read here do not distinguish the models), and nothing
else. There is no PAL 5200 in any source read here (*to verify*).

## What exists today

Nothing. There is no `packages/atari5200`, no backend entry, no
`--target atari5200`, nothing in `run.mjs`, and nothing in the docs beyond
the roadmap row. What this note verified is the layer underneath:

- The LLVM-MOS SDK installed here ships `mos-atari5200-supercart-clang`
  with a linker script and a crt0 and **no headers of its own** — the
  `include/` directory the driver's `.cfg` points at does not exist, so a
  5200 program either includes `atari8-common`'s `_antic.h`/`_gtia.h`/
  `_pokey.h` with its own base addresses or declares the registers itself.
- A 32K cartridge written for this note (a C loop writing COLBK at
  `$C01A` after polling VCOUNT at `$D40B`, with COLPF2 set once) links to
  a 32768-byte image and runs under `atari800 -5200 -cart-type 4 -cart
  <file>`: the bundled Altirra 5200 kernel prints the cartridge's title
  from the linker's tail bytes ("LLVM-MOS COMPILED") and jumps to
  `_start`. With NMIEN untouched, only the *lower half* of the playfield
  (from the line of the write to the end of the frame) took the program's
  COLBK and the one-shot COLPF2 never showed; with NMIEN cleared first the
  whole screen took COLBK and the text rows took COLPF2. Without
  `-cart-type` atari800 stops at its "Select Cartridge Type" menu (14
  candidates for a 32K raw image).
- `atari800 7.1.2` boots a 5200 with no Atari ROM file configured: it
  falls back to its bundled Altirra 5200 kernel (`-5200-rev altirra`).

## Facts verified here

Cite these freely; each was read in the source named or seen on screen
under atari800 7.1.2, not recalled. `$SDK` is `~/.local/opt/llvm-mos`.

| Fact | Where |
| ---- | ----- |
| Link script: `__cart_rom_size` default 512, must be a power of two from 32 to 512 (32 = "a normal 32 KiB cartridge", 128–512 = "a Super Cart"). Banks are 32K, mapped over `$4000-$BFFF`; a common `.fixed` region is emitted as a *prefix of every bank* (`FULL(fixed, 0, size) FULL(bankN, size)`), so code in `.fixed` is reachable whichever bank is in. `c_readonly` is `fixed`. | `$SDK/mos-platform/atari5200-supercart/lib/link.ld` |
| RAM for the program: `$0300-$3BFF` ("memory from 0x300 to 0x3c00 is usable in this current implementation"); the stack is `PROVIDE(__stack = 0x3c00)` and crt0 sets the soft stack pointer to it. Imaginary registers `$80-$9F`; zero-page variables from `$A0`; `-mlto-zp=96`; `-D__ATARI5200__`. | `link.ld`, `$SDK/bin/mos-atari5200-supercart.cfg`, `llvm-objdump` of the built probe (`lda #0 / sta $80 / lda #$3c / sta $81 / jsr main`) |
| The last bank is shortened by 64 bytes for a *tail* at `$BFC0-$BFFF`: `$BFC0-$BFCF` are the bank-switch read addresses ("reserve some space for bank-switch-reads"), 24 unused bytes, then 24 bytes of metadata — a 20-character ATASCII title at `$BFE8` (the SDK writes "LLVM-MOS COMPILED", with the first word shifted into the colour-rotating character range), the two year digits at `$BFFC/$BFFD` (`$FF` at `$BFFD` marks a diagnostic cartridge; the SDK encodes 2024 as "C4"), and `_start` at `$BFFE`. | `link.ld`; `xxd` of the built image at `$7FC0` |
| crt0 for the 5200 links `common-init-stack`, `common-copy-data`, `common-zero-bss`, `common-exit-loop`: stack from `__stack`, `.data` copied from ROM, `.bss` zeroed, and `exit` spins forever (`jmp` to self). Nothing is printed and no display list is built. | `$SDK/mos-platform/atari5200-supercart/lib/libcrt0.a` (member list), upstream `CMakeLists.txt`, `llvm-objdump` of the probe's `exit` |
| atari800's 5200 memory map: RAM `$0000-$3FFF`, ROM `$4000-$FFFF`, GTIA at `$C000-$CFFF` (16 pages of mirrors), ANTIC at `$D400-$D4FF`, POKEY at `$E800-$EFFF` (8 pages), the 2K BIOS at `$F800`. No PIA is mapped and `pia.c` has no 5200 case. `-5200` sets `MEMORY_ram_size = 16` and no BASIC. | upstream `src/memory.c`, `src/pia.c`, `src/atari.c` |
| atari800 5200 cartridge types: 4 = 32K at `$4000-$BFFF`; 16 = 16K at `$8000-$BFFF`; 6 = 16K "two chip" (8K in each half); 19 = 8K mirrored at `$8000` and `$A000`; 20 = 4K mirrored four times; 7/159 = 40K Bounty Bob (4K banks at `$4000`/`$5000` switched by reads of `$4FF6-$4FF9`/`$5FF6-$5FF9`); Super Cart 64/128/256/512K switched by reads in `$BFC0-$BFFF` (`$BFCx`, `$BFDx`, `$BFEx`, `$BFFx` set different state bits) and copying `bank × $8000` over `$4000-$BFFF`. `-cart-type` picks one; a raw 32K image opens the type menu (seen: "Standard 32 KB 5200 cartridge" first of 14). | upstream `DOC/cart.txt`, `src/cartridge.c`; on screen |
| Controllers in atari800: port *i* is analogue on POT `2i` (x) and `2i+1` (y), with `INPUT_joy_5200_min = 6`, `center = 114`, `max = 220`; the fire buttons are TRIG0-3; the second (top) button is delivered as the "shift" bit — SKSTAT bit 3 — with an IRQ if enabled; the keypad arrives as POKEY keyboard codes through KBCODE: START `$39`, PAUSE `$31`, RESET `$29`, `0` `$25`, `1` `$3F`, `2` `$3D`, `3` `$3B`, `4` `$37`, `5` `$35`, `6` `$33`, `7` `$2F`, `8` `$2D`, `9` `$2B`, `#` `$23`, `*` `$27`. | upstream `src/input.c`, `src/akey.h` |
| GTIA's CONSOL does not carry the computer's START/SELECT/OPTION and cassette behaviour on the 5200 (`gtia.c` guards those on `machine_type != 5200`). | upstream `src/gtia.c` |
| ANTIC, GTIA and POKEY register layouts, the display-list instruction set, the P/M registers, AUDC/AUDCTL and the pot/keyboard registers are the ones in `packages/atari8/AGENTS.md`'s verified table; only the base addresses differ (`$C000` GTIA, `$E800` POKEY, `$D400` ANTIC unchanged). The probe's `VCOUNT` poll at `$D40B` and COLBK write at `$C01A` behaved as on the computer. | `$SDK/mos-platform/atari8-common/include/*.h`; on screen |
| The Altirra 5200 kernel that atari800 boots shows "Altirra 5200 ROM Kernel / Now playing:" and then the cartridge title from `$BFE8` before jumping to `$BFFE`; it leaves a display list up (the text stayed on screen while the probe recoloured the playfield), so a program that never builds its own inherits the kernel's, exactly as a `.xex` inherits the OS's. | on screen |
| The kernel's vertical-blank NMI restores GTIA colour registers every frame: the probe's COLBK write (made just after VCOUNT passed 64, ≈ scanline 128) coloured only the lower half of the playfield and its single COLPF2 write never appeared; the same probe with `NMIEN ($D40E) = 0` before the loop coloured the whole playfield and the text rows' background. So the 5200 has OS shadows too — at addresses not read here (*to verify*) — and clearing NMIEN is the verified way to take the registers over. | on screen, two builds of the probe |

## From the sources, not verified here

Each is a lead to confirm the first time code depends on it.

**Video timing.** The 5200 is an NTSC-only console and its ANTIC/GTIA are
the computer's chips, so 262 lines × 114 cycles, the VBI at line 248 and
`VCOUNT = line >> 1` should carry over from `packages/atari8/AGENTS.md`;
whether atari800 accepts `-5200 -pal` and what it does is *to verify*.

**The BIOS.** The 2K ROM at `$F800` handles the interrupt vectors (NMI
for VBI/DLI, IRQ for POKEY) and dispatches through RAM vectors; the
Atari 5200 OS's vector and shadow addresses are *not* the computer OS's
(`$0200` and up) and *to verify* from the 5200 OS listing before any
`FRAME_SYNC`/interrupt code assumes them. The kernel here is Altirra's
replacement, not Atari's — differences are *to verify* too.

**Analogue sticks.** The real controllers are potentiometers with no
centre detent; POKEY reads them over one frame's scan (0–228) unless
SKCTL bit 2 forces the fast scan, so a program restarts the scan with
POTGO every frame and applies a dead zone around ~114. The 6/114/220
figures are atari800's model of the range, not a measurement of a
controller.

**Keypad codes.** The `$39`/`$31`/… codes above are atari800's
`AKEY_5200_*` values, i.e. what its emulated POKEY presents in KBCODE;
that they match the hardware matrix is *to verify* against the 5200 OS
listing. A second POKEY keyboard IRQ per port (the 5200 multiplexes four
controllers onto one POKEY through the console's own select lines) is
*to verify*.

**Four ports vs two.** The original console has four controller
sockets, the later revision two; atari800 models POT pairs for four
ports. Which model an `atari5200` profile means is *to verify* and is a
profile axis, not a runtime probe.

**Super Cart bank numbers.** The `-cart-type` numbers for the 5200 Super
Cart sizes (64/128/256/512K) were not read; the raw-image menu will show
them. The `$BFCx`/`$BFDx`/`$BFEx`/`$BFFx` state-bit mapping in
`cartridge.c` is the emulator's and matches the SDK's tail reservation
but was not cross-checked against a hardware description.

## Rules for this target

### Share the chip layer with atari8; do not copy it

- ANTIC, GTIA and POKEY are the same registers at different bases. The
  package model already has the mechanism: a `registers.8bs` in the
  shared code with an `atari5200`-specific twin (`registers.atari5200.8bs`,
  `docs/packages.md`'s system-specific file rule) holding `$C000`/`$E800`
  instead of `$D000`/`$D200`. Display-list, P/M, colour and sound code
  written against those names then serves both machines; anything that
  hardcodes `$D01A` is atari8-only by accident.
- The BIOS has a VBI and colour shadows of its own (verified above),
  at addresses this note did not read. Until they are, `screen.setColors()`
  on this machine either clears NMIEN first (verified to work, and the
  program then owns VCOUNT-polled timing anyway) or writes the BIOS's
  shadows (*to verify*); a hardware-only colour write lasts until the next
  vertical blank, exactly as on the computer.

### The program owns the display from the first instruction

- The BIOS leaves whatever display list it used for its title; a program
  must build its own (in the `$0300-$3BFF` RAM, below the stack at
  `$3C00`) and point DLISTL/H at it, set DMACTL, and set CHBASE at a
  character set *in the cartridge* (ROM is readable by ANTIC; the OS ROM
  charset the computer has at `$E000` is not there). A text surface here
  is therefore "a display list the package builds plus a 1K charset the
  package ships", with the 40×24 cells in RAM the package chooses — not a
  SAVMSC read.
- Interrupts go through the BIOS's RAM vectors, whose addresses are *to
  verify*; until then a frame runtime polls VCOUNT exactly as
  `FRAME_SYNC.atari8` does (verified working) and clears NMIEN so the
  BIOS's VBI stops rewriting the colour registers (verified).

### Input is analogue and there is no keyboard

- `@8bitscript/input`'s "joystick" here is a pot pair with a dead zone
  around centre and a POTGO restart every frame; the "buttons" are
  TRIG0-3 plus the top button through SKSTAT bit 3. A digital
  up/down/left/right is a threshold the package applies, and the
  thresholds are a documented choice.
- The keypad is twelve keys plus START/PAUSE/RESET, arriving as KBCODE
  values; there is no text entry. A portable "keyboard" capability is
  absent on this machine by design, the way `sprites` is absent on the
  PET; a `keys.8bs` names the keypad and nothing else.

### Storage is the cartridge, and there is none

- No disk, tape, serial bus or battery RAM: persistence is `none` for
  every 5200 profile. A high score lives until power-off.
- The Super Cart's bank is chosen by a *read* of `$BFC0-$BFFF`, and code
  in `.fixed` is the only code that is present in every bank; the same
  (bank, offset) discipline as the XEGS applies, with the twist that a
  bank switch happens on a load instruction, so an accidental read of the
  tail area switches banks.

### Emulator

- `atari800 -5200 -ntsc -cart-type 4 -cart <file>` for a 32K image, the
  Super Cart type number for larger ones; **never** a bare `-cart` — the
  size is ambiguous and the emulator waits at a menu. Screenshots use the
  same macOS window capture as atari8 (`mac-window-capture.mjs`); `--frames`
  is wall-clock at 60 Hz there.
- No Atari 5200 ROM file is needed on this host: atari800 7.1.2 falls
  back to its bundled Altirra kernel, and that is the kernel every fact
  above was seen under. Record the kernel with any measurement.

## Where things live

```
(no package yet)
$SDK/mos-platform/atari5200-supercart/lib/link.ld   32K banks over $4000-$BFFF, .fixed prefix, RAM $0300-$3BFF, stack $3C00, the $BFC0 tail
$SDK/mos-platform/atari5200-supercart/lib/libcrt0.a init-stack (__stack), copy-data, zero-bss, exit-loop
$SDK/bin/mos-atari5200-supercart.cfg                -mlto-zp=96, -D__ATARI5200__, an include dir that does not exist
$SDK/mos-platform/atari8-common/include/            the chip headers a 5200 program would reuse with its own bases
github.com/atari800/atari800 src/memory.c, pia.c    the 5200 map (RAM 16K, GTIA $C000, ANTIC $D400, POKEY $E800, BIOS $F800, no PIA)
github.com/atari800/atari800 src/input.c, akey.h    pot pairs per port, 6/114/220, keypad codes, top button as SKSTAT bit 3
github.com/atari800/atari800 src/cartridge.c, DOC/cart.txt   the 5200 cartridge types and the Super Cart $BFC0-$BFFF switching
packages/atari8/AGENTS.md                            the chip-level facts this note does not repeat
```
