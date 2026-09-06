---
title: Apple II
nav_order: 10
---

# Writing Apple II support for 8BitScript

This file is for anyone — human or agent — touching a future
`packages/apple2`, an `APPLE2_PROFILES` entry in `packages/backend-6502`,
a `FRAME_SYNC.apple2` driver, an Apple II emulator entry in
`packages/cli/src/run.mjs`, or the Apple II rows of `docs/roadmap.md`
(Phase 5) and `packages/studio/AGENTS.md`. Read the root `AGENTS.md`
first; the rules there apply to every target and are not repeated.
`packages/pet/AGENTS.md` is the closest existing contrast: like the PET,
the Apple II has no video chip to program and no sound chip; unlike the
PET it has a bitmap, sixteen (artifact) colours, and an operating system
that expects to own memory —

> **The Apple II is a 1 MHz 6502 with soft switches instead of registers:
> a text page and a hires page whose rows are interleaved, whose colours
> are an NTSC artifact of pixel position, and whose "screen holes" belong
> to firmware; a keyboard that latches one key; a speaker that is a
> toggle; and no sprites, no scroll, no vblank flag on the II/II+. Model it
> as a 40×24 text grid plus a 280×192 bitmap with position-dependent
> colour, under ProDOS, and let every extra — 80 columns, aux memory,
> double hires, MouseText, Mockingboard, mouse card, 65C02 — be a profile
> or an optional capability.**

The family's variety is in *models and cards*: II/II+ (6502, 48K + 16K
language card, no vblank flag), IIe (64K + 64K aux via the Extended
80-Column card, double modes, MouseText on the enhanced 65C02 model), IIc
(65C02, 128K built in, ports not slots, mouse and VBL interrupt through the
IOU), IIgs (65C816 in 8-bit emulation, Ensoniq, its own video), and the
cards that turn "an Apple II" into a different machine: Mockingboard
(AY-3-8910s), AppleMouse II, Super Serial, Disk II, hard disk controller.

## What exists today

Do not describe more than this as working:

- There is no `packages/apple2`, no `APPLE2_PROFILES`, no
  `FRAME_SYNC.apple2`, no emulator entry in `packages/cli`, and no
  `docs/setup/apple2.md`.
- **The installed LLVM-MOS SDK has no Apple II platform.**
  `~/.local/opt/llvm-mos/mos-platform/` (clang 24.0.0git, llvm-mos
  `77a0dd93`) lists no `apple2`, and there is no `mos-apple2-clang` in
  `~/.local/opt/llvm-mos/bin/`.
- **Upstream has one now.** llvm-mos-sdk PR #444, "[apple2] Add new Apple
  II ProDOS target", **merged 2026-09-02**; `mos-platform/apple2/` is in
  `main` (`CMakeLists.txt`, `README.md`, `link.ld`, `crt0.S`, `_Exit.S`,
  `apple2.h`, `apple2.inc`, `clang.cfg`, `getchar.c`, `putchar.c`,
  `monitor.S`) and the SDK README lists "Apple II / IIe — ProDOS 8 SYS —
  `mos-apple2-clang`". A newer SDK than the one installed is needed to use
  it. What it gives is described under "LLVM-MOS" below; what it does not
  give is hires, aux memory or 80 columns (its README says so).
- No Apple II emulator is installed (`applewin`, `mame`, `microm8` are not
  on PATH; MAME is a Homebrew formula, 0.289).
- cc65 has mature `apple2` and `apple2enh` targets (`apple2.h`,
  `apple2enh.h`, `apple2_filetype.h`, `apple2.inc`, `apple2.cfg` and the
  `-hgr`, `-system`, `-overlay`, `-asm` variants, `a2.hi.tgi`, `a2.lo.tgi`,
  `a2.stdjoy.joy`, `a2.stdmou.mou`, `a2.ssc.ser`, `a2.auxmem.emd`) — the
  reference for soft-switch names, the ProDOS conventions and a working
  vblank/paddle/model-detection implementation.

The rules below are what to hold that work to when it comes.

## Facts verified here

Cite these freely; each was read in the source named, not recalled. Nothing
in this file was seen on screen — no Apple II emulator is installed.

| Fact | Where |
| ---- | ----- |
| Upstream `link.ld`: imaginary registers `__rc0..__rc31` at `$00-$1F` ("ProDOS and its disk drivers use `$3a-$4e`, but leave `$00-$1f` available to system programs"); compiler zero page `$60-$FF` (`zp : ORIGIN = 0x60, LENGTH = 0xa0`); one region `ram : ORIGIN = 0x2000, LENGTH = 0x8f00` ("the largest system program the ProDOS 8 Technical Reference permits is `$8f00` bytes"); `.sys_entry` must be a 3-byte `JMP` at exactly `$2000`; soft stack `__stack = 0xbf00` growing down through `$AF00-$BEFF`; `OUTPUT_FORMAT { TRIM(ram) }`; `clang.cfg` = `-D__APPLE2__ -mlto-zp=160`. | `llvm-mos-sdk` `main`, `mos-platform/apple2/link.ld`, `clang.cfg` |
| Upstream `crt0.S`: resets the hardware stack, marks `$2000-$BEFF` used in ProDOS's system bitmap (`$BF58+4..`), writes `PRODOS_SYSTEM_VERSION` (`$BFFD`) = 0, calls `SETKBD` (`$FE89`) and `SETVID` (`$FE93`) "the firmware equivalents of IN#0 and PR#0", and installs a reset vector at `$03F2` with the power-up byte `$03F4 = high byte EOR $A5`. `_Exit` invalidates the power-up byte and calls the ProDOS MLI (`$BF00`) `QUIT` (`$65`) with a 7-byte parameter table. Console I/O is Monitor ROM `RDKEY` (`$FD0C`) / `COUT` (`$FDED`). Machine ID is read from `$BF98`. | `mos-platform/apple2/crt0.S`, `_Exit.S`, `apple2.inc`, `apple2.h` |
| Upstream README: "produces ProDOS 8 system-program (`SYS`, file type `$ff`) binaries. ProDOS loads them at `$2000`; copy the linked output to a ProDOS volume with a filename ending in `.SYSTEM`… targets a 64 KiB Apple II running ProDOS and uses the Monitor ROM for 40-column text input and output. It is also suitable for an Apple IIe in 40-column mode. It does not use hi-res graphics or auxiliary memory." Tested "in MAME under ProDOS 8". `platform(apple2 COMPLETE HOSTED PARENT common)`. | `mos-platform/apple2/README.md`, `CMakeLists.txt`, PR #444 |
| Memory map: `$0000-$00FF` zero page, `$0100` stack, `$0200-$02FF` GETLN buffer, `$0300-$03CF` free, `$03D0-$03FF` DOS/ProDOS/interrupt vectors, `$0400-$07FF` text page 1 + peripheral screen holes, `$0800-$0BFF` text page 2, `$2000-$3FFF` hires page 1, `$4000-$5FFF` hires page 2, ProDOS: `$9600-$99FF` BASIC.SYSTEM buffers, `$9A00-$BEFF` "currently running SYS file", `$BF00-$BFFF` ProDOS global page; `$C000-$C0FF` soft switches, `$C100-$C7FF` slot ROMs, `$C800-$CFFF` expansion ROM of the selected card; `$D000-$FFFF` ROM (Applesoft `$D000-$F7FF`, Monitor `$F800`), bank-switched RAM under it: two banks at `$D000-$DFFF`, one at `$E000-$FFFF` (language card). | kreativekorp `a2info/memorymap.shtml` |
| Screen holes: the 8 bytes after every 120-byte group of three rows in the text page (`$0478-$047F`, `$04F8-$04FF`, `$0578`, `$05F8`, `$0678`, `$06F8`, `$0778`, `$07F8`, one byte per slot `n`) belong to firmware: `$0478` = slot of the card owning `$C800`; 80-column card cursor position at `$0578+n`/`$05F8+n`; mouse card X/Y at `$0478+n`/`$04F8+n`/`$0578+n`/`$05F8+n`, status `$0778+n`, mode `$07F8+n`. ProDOS refuses to load a file straight into `$0400-$07FF` for this reason. | kreativekorp `screenholes.shtml`; Wikipedia *Apple II graphics* |
| Soft switches (read/write behaviour per model): `$C000` KBD (read: last key + 128) / 80STOREOFF (write), `$C001` 80STOREON, `$C002-$C005` RDMAIN/RDCARD/WRMAIN/WRCARD aux memory (IIe/IIc/IIgs), `$C006/7` slot vs internal `$Cx00` ROM, `$C008/9` main/aux zero page+stack, `$C00C/D` 40/80 columns, `$C00E/F` primary/alternate character set (MouseText), `$C010` keyboard strobe, `$C011-$C01F` status reads (RDLCBNK2, RDLCRAM, RDRAMRD, RDRAMWRT, RDCXROM, RDALTZP, RDC3ROM, RD80STORE, **`$C019` RDVBL "E:1=drawing G:0=drawing"**, RDTEXT, RDMIXED, RDPAGE2, RDHIRES, RDALTCHAR, RD80VID), `$C020` cassette out, **`$C030` SPKR toggle**, `$C040` game strobe, `$C050/1` graphics/text, `$C052/3` full/mixed, `$C054/5` page 1/2 (page 2 = aux display memory when 80STORE is on), `$C056/7` lores/hires, `$C058-$C05F` annunciators 0-3 (`$C05E/F` = DHIRES on/off in 80-column mode), `$C060` cassette in, `$C061/2/3` buttons 0/1/2 (Open Apple, Solid Apple, shift on IIe), `$C064-$C067` paddles 0-3 (bit 7 read), `$C070` paddle trigger, `$C080-$C08F` language card bank/read/write selects, `$C090-$C0FF` slot 1-7 I/O. IIc-only: `$C019` RSTVBL, `$C041` RDVBLMSK, `$C05A/B` DISVBL/ENVBL, `$C07E/F` IOUDIS, `$C066/7` mouse X/Y, `$C063` mouse button. IIgs-only: `$C034` border colour, `$C022` text/background colour, `$C029` NEWVIDEO, `$C036` speed. | kreativekorp `iomemory.shtml`; cc65 `asminc/apple2.inc` (same names) |
| Hires byte layout: 40 bytes per line, 7 pixels per byte (bits 0-6, bit 0 leftmost on screen), bit 7 = colour group ("0 = Black, White, Magenta, or Green; 1 = Black, White, Orange, or Blue"); a colour is a pixel pair on the NTSC colour-burst axis, so 01/10 pairs give the four hues and 11 gives white; pairs that straddle bytes with different group bits give "weird colours". Only odd-X pixels can be green/orange and only even-X purple/blue; two adjacent lit pixels are white. Pages at `$2000` and `$4000`; the "64:1 interleave factor" gives the Venetian-blind load; holes exist in hires too. | kreativekorp `stdhires.shtml`; Wikipedia *Apple II graphics* |
| Lores is the text page (`$400-$7FF`) with two 4-bit pixels per byte, one above the other, 40×48 (40×40 mixed), 16 colours of which 5 and 10 are the same grey; three text rows per 128-byte block plus 8 hole bytes. Double lores is 80×48 (IIe with 80-column card: `PR#3`, `POKE 49246,0` = `$C05E`, `GR`). Double hires is 560×192, 16 colours, from aux memory, enabled by annunciator 3 with 80-column video on. IIe Revision B motherboards were needed for the double modes. | Wikipedia *Apple II graphics* |
| cc65 vblank: II/II+ have no VBL flag — `waitvsync` "silently fail[s]" unless `machinetype` says IIe; IIe: wait `RDVBLBAR` bit 7 set then clear; **IIgs is inverted** (wait clear then set); IIc: `IOUDISOFF`, `ENVBL`, hit `PTRIG` to reset the VBL flag, poll `RDVBLBAR`, restore. Frame length used to detect PAL/NTSC: **17030 cycles NTSC, 20280 cycles PAL** (`get_tv.s`). | cc65 `libsrc/apple2/waitvsync.s`, `get_tv.s` |
| cc65 model detection is Apple II Miscellaneous TechNote #7: `$FE1F` with carry set (IIgs returns C clear), then ROM bytes `$FBB3`, `$FB1E`, `$FBC0`, `$FBDD`, `$FBBF`; codes `APPLE_II 0x10`, `IIPLUS 0x11`, `IIE 0x30`, `IIEENH 0x31`, `IIC 0x40`, `IIGS 0x80`. | cc65 `libsrc/apple2/get_ostype.s`, `include/apple2.h` |
| cc65 joystick: two analog joysticks are four paddles read as a timed loop after `PTRIG` (`$C070`), both axes sampled in the same 7-cycle loop up to a threshold, buttons at `BUTN0/1` (`$C061/2`); the IIc has one joystick; the IIgs is slowed to 1 MHz first (`CYAREG` bit 7). Masks `JOY_UP 0x10, DOWN 0x20, LEFT 0x04, RIGHT 0x08, BTN_1 0x40, BTN_2 0x80`. | cc65 `libsrc/apple2/joy/a2.stdjoy.s`, `include/apple2.h` |
| cc65 layout: default program `$0803-$95FF` ("35.5 KB"), stack at HIMEM `$9600`, language-card segment at `$D400` size `$C00` "behind quit code"; `apple2-system.cfg` loads at `$2000` up to `$BEFF`; `apple2-hgr.cfg` reserves a hires page (`-S $4000` or `$6000`); AppleSingle header by default; `_filetype`/`_auxtype` set the ProDOS type; no colour text (`textcolor()` etc. are no-ops); DOS 3.3 has no file I/O and no interruptors; `a2.stdmou.mou` = AppleMouse II card, bounding box `[0..279, 0..191]`, text-mode callbacks only on `apple2enh`; `a2.auxmem.emd` = 47.5 KB of aux RAM as extended memory; `a2.ssc.ser` = Super Serial Card; `apple2enh` "requires a 65C02 or 65816" and adds MouseText line drawing; `beep()` calls Monitor `BELL` (`$FF3A`) with ROM banked in via `$C082`, then `$C080` back. | cc65 `doc/apple2.html`, `doc/apple2enh.html`, `cfg/apple2.cfg`, `libsrc/apple2/beep.s` |
| Zero page and vectors used by the firmware: `$20-$25` text window and cursor (`WNDLFT/WNDWDTH/WNDTOP/WNDBTM/CH/CV`), `$28/$29` BASL/BASH (text base of the current row), `$32` INVFLG, `$4E/$4F` RNDL/RNDH (Monitor random counter), `$73` HIMEM; `$03D0` DOS warm start, `$03F0` BRK, `$03F2` SOFTEV, `$03F4` PWREDUP; 80-column cursor at `$057B`/`$05FB`. | cc65 `asminc/apple2.inc` |
| IIe: 6502 at 1.023 MHz, 65C02 on the Enhanced IIe; 64K, 128K with the Extended 80-Column Text Card; 40/80 columns × 24 lines; lores 40×48/16, hires 280×192/6, double variants; MouseText on the enhanced model; auxiliary slot; DE-9 joystick connector. | Wikipedia *Apple IIe* |
| Emulators: AppleWin is Windows-only (its README: "Apple II emulator for Windows"; ports: Linux `audetto/AppleWin`, macOS `sh95014/AppleWin`); models `-model apple2|apple2p|apple2jp|apple2e|apple2ee`; media `-d1/-d2` (Disk II slot 6), `-h1/-h2` (HDC slot 7), `-s5d1`, `-s7h1..8`; `-aux empty|std80|ext80|rw3`, `-r <banks>` RamWorks; `-conf <ini>`, `-load-state`, `-clock-multiplier`, `-f/-full-screen`, Mockingboard/Phasor sockets `-s<N> socket0/1=ssi263`; no IIc/IIgs support. No screenshot or headless flag was found in the portion of `CommandLine.html` read (first ~7 KB). | AppleWin `README.md`, `help/CommandLine.html` |
| `audetto/AppleWin` frontends: `sa2` (SDL2 + ImGui, `--no-imgui` for plain SDL2), `applen` (ncurses), `qapple` (Qt), `ra2` (libretro); options seen: `--fixed-speed`, `--timer`, `--audio-buffer`, `--no-squaring`, `--nat`, `-r "key=value"` registry overrides; a macOS section exists (delete-key mapping); config in `~/.config/applewin/applewin.yaml`. | `audetto/AppleWin` `README.md`, `source/frontends/sdl/README.md` |
| MAME drivers exist: `apple2`, `apple2p`, `apple2e`, `apple2ee`, `apple2c`, `apple2gs`. MAME's Lua `video:snapshot()` "saves snapshot files according to the current configuration"; `-seconds_to_run/-str`, `-video none`, `-sound none`, `-nothrottle`, `-flop1/-flop2`, `-hard1`, `-snapname`, `-snapsize` are documented options. | MAME `src/mame/mame.lst`; `docs.mamedev.org` command line and `luascript/ref-core.html` |

## From the sources, not verified here

Each is a lead to confirm the first time code depends on it.

- **Text-page row addresses** (*to verify* against the Apple IIe Technical
  Reference): base of row `r` (0-23) = `$0400 + (r mod 8) × $80 + (r div 8)
  × $28`; the 8-byte holes are the last 8 bytes of each 128-byte block. The
  Monitor computes it (`BASCALC`, `$FBC1`, result in `BASL/BASH`). Hires
  line `y` (0-191) = `$2000 + (y mod 8) × $400 + ((y div 8) mod 8) × $80 +
  (y div 64) × $28` (page 2: `$4000`). What *is* verified above: 128-byte
  blocks hold three rows plus a hole; 40 bytes per hires line; the
  "64:1 interleave"; `$2000`/`$4000`.
- 65 cycles per scan line and 262 lines per NTSC frame (17030 cycles, from
  cc65's constant) and 312 lines PAL (20280): the totals are cc65's, the
  per-line figure is *to verify*.
- The exact NTSC hires hue names per pixel parity and group bit (Apple's
  "violet/purple" vs "magenta" naming) — kreativekorp itself calls its
  colour tables inconsistent; treat hires colour as 6 nominal colours with
  position rules, never as a palette index.
- Mockingboard: two 6522 VIAs at `$Cn00`/`$Cn80` driving two AY-3-8910s,
  usually slot 4 — *to verify* against the Mockingboard docs; AppleWin's
  README only confirms it emulates "Mockingboard, Phasor and SAM" and the
  SSI263 speech sockets.
- AppleMouse II card protocol (firmware entry points in `$Cn00`, screen
  holes above) and the IIc's IOU mouse registers — *to verify* against
  the card manual; cc65's driver is the working reference.
- ProDOS MLI call numbers other than `QUIT $65` (`OPEN $C8`, `READ $CA`,
  `WRITE $CB`, `CLOSE $CC`, `GET_TIME $82`) — *to verify* against the
  ProDOS 8 Technical Reference (kreativekorp `mlicalls.shtml` exists and
  was not read).
- `microM8` (Paleotronic): Go-based, builds for Windows/macOS/Linux, has
  Mockingboard/mouse/Disk II/SmartPort emulation per its page; whether it
  has a command line or screenshot route is *to verify*.
- `sh95014/AppleWin` (macOS): a port of the Windows code; its README is
  the upstream README, so its command-line coverage is *to verify*.
- MAME `-autoboot_script` for driving `video:snapshot()` after N frames is
  *to verify*; the Lua API exists, the end-to-end headless run was not
  tried. MAME needs the Apple II ROM set (`apple2e.zip` etc.).
- The IIgs: 65C816 at 2.8 MHz, Ensoniq DOC, Super Hi-Res `$C029`
  NEWVIDEO — outside this note except as "8-bit mode is a IIe with a
  border register (`$C034`) and inverted VBL sense".

## Corrections to the roadmap and the brief

- **`docs/roadmap.md` (Phase 5) is out of date**: "As of September 2026,
  the LLVM-MOS SDK's Apple II ProDOS target is an open pull request …
  not part of its supported-platform list." PR #444 merged on 2 September
  2026 and the README lists `mos-apple2-clang`. The correct statement is:
  upstream has a minimal ProDOS 8 SYS target (40-column text via the
  Monitor, no hires, no aux memory) and **the SDK installed here predates
  it**. This file does not edit the roadmap; whoever does should.
- The brief lists "IIgs in 8-bit mode" as one machine with the IIe/IIc;
  the VBL sense, the `$C034` border register and the speed register make it
  a distinct profile, not the same build.

## Rules for this target

### Models and cards are profiles and capabilities

- An `APPLE2_PROFILES` table needs at least: `iiplus` (6502, no VBL flag,
  40 columns, hires colour only), `iie` (64K, `$C019` VBL), `iie-128k`
  (Extended 80-Column card: aux memory, 80 columns, double lores/hires),
  `iie-enhanced` (65C02, MouseText), `iic` (65C02, 128K, IOU VBL and mouse),
  `iigs` (inverted VBL, border register). The LLVM-MOS platform today
  builds the common denominator; the profile decides which extras the
  package may touch.
- Cards are capabilities, never assumed: Mockingboard (audio), AppleMouse
  (mouse), Disk II / HDC (storage via ProDOS), SSC. `machine == apple2`
  says nothing about any of them; detect the card by its `$Cn00` signature
  bytes at run time or declare it in the profile.
- Region (NTSC/PAL) is measurable at start-up (cc65 does: count 92-cycle
  loops between VBL edges, 17030 vs 20280) and matters for colour: PAL
  machines lose artifact colour unless a colour card is fitted (Wikipedia).

### Memory

- Under ProDOS a SYS program owns `$2000-$BEFF` and nothing else without
  asking: `$0000-$1FFF` has the zero page (ProDOS uses `$3A-$4E`), the
  stack, the input buffer, the vectors, **both text pages and the holes**;
  `$BF00-$BFFF` is ProDOS; `$C000-$CFFF` is I/O; `$D000-$FFFF` is ROM or
  language-card RAM, and ProDOS lives in the language card. The LLVM-MOS
  link script's single `ram` region at `$2000` **overlaps both hires pages**
  (`$2000-$5FFF`): a hires build needs its own link script that starts the
  image at `$4000` or `$6000` (cc65's `-hgr` convention) or reserves a page
  by sections, and that is a profile, not a runtime choice.
- Never write into the screen holes; they are the 80-column, mouse and
  serial firmware's state. A text package that clears `$0400-$07FF` with a
  plain fill breaks the mouse card.
- Aux memory (`$C002-$C005`, `$C008/9`, `$C054/5` with 80STORE) is banking
  with a twist: reads and writes are selected independently and the zero
  page/stack can be swapped too. It is the root rule for banked machines
  in its most confusing form; keep it inside one owner (a "double hires"
  or "aux RAM" module) and never let generated code hold an aux pointer as
  a bare address.
- The language card (`$C080-$C08F`) is where ProDOS is; a program that
  wants the `$D000-$FFFF` RAM must read the ProDOS docs on what it may
  take (cc65 uses `$D400-$DFFF` of bank 2, "behind quit code").

### The screen

- Text is a 40×24 grid of bytes on page 1 (`$0400`) with an interleaved
  row table; a `locate()` here is a 24-entry base table, not a multiply.
  Character codes (*to verify*): bit 7 set = normal on the II/II+ (bit 7 clear = inverse
  / flashing); the IIe's alternate set (`$C00F`) gives normal/inverse
  lower case and MouseText. There is no colour in text mode on any model
  but the IIgs. Text writes may happen at any time (no snow).
- 80 columns interleaves main and aux memory column by column through
  the 80STORE/PAGE2 switches, and needs the 80-column firmware or your
  own routine; make it a profile (`iie-128k`) and a separate text package
  file, never a runtime probe.
- Hires colour is positional: a pixel's hue depends on its X parity and
  the byte's bit 7, and adjacent lit pixels merge to white. A portable
  "draw a coloured pixel" must be expressed as *pairs* at even X with a
  chosen group bit (effective 140×192 in colour, 280×192 mono), and the
  package must own the rule "don't put green next to blue in one byte".
  Do not model this as a 6-colour palette.
- Lores (40×48 blocks, 16 colours) is the honest "pseudo-pixel" surface:
  two nibbles per text-page byte, no artifacts to reason about, and it
  shares the text page. Double lores/hires are IIe-128K capabilities.
- Two pages exist for both text and hires; page flipping is `$C054/5`.
  Use it for tear-free animation; there is no hardware scroll at all.
- The mixed switch (`$C053`) gives four text rows under graphics; that is
  the only "layering" the hardware has.

### Sound is a click

- `$C030` toggles the speaker cone; a tone is a timed loop of reads. Any
  sound the program makes costs the whole CPU while it plays, and the
  ROM `BELL` is the same trick. A note-level API on the base profile is
  "one voice, blocking, no volume" — say that and stop; queued music is a
  Mockingboard capability (AY-3-8910 × 2 with envelopes and noise), which
  is optional hardware and a card slot.
- No hardware entropy source; cc65 seeds from keypress timing. The
  Monitor's `RNDL/RNDH` counter (`$4E/$4F`) is a keyboard-loop counter,
  fine as a seed, not as a generator.

### Input is a latch

- `$C000` bit 7 = a key is waiting, bits 0-6 = its ASCII; reading `$C010`
  clears it. **One key at a time**: there is no matrix to scan, so
  chords and "is this key down now" do not exist beyond the two Apple keys
  (`$C061/2`) and, on the IIe, Shift (`$C063`). A portable `input` must
  say so; an action game uses the Apple keys, the buttons, or the paddles.
- Paddles/joystick are analogue: trigger `$C070`, then time how long
  `$C064-$C067` bit 7 stays set (cc65 loops to a threshold; the ~2.8 ms worst case is *to verify*). A read
  costs a frame's worth of CPU if you wait for the slowest paddle; read
  both axes in one loop as cc65 does, once per frame.
- Mouse is a card (or IIc firmware): capability, not assumption.

### Frame timing

- `FRAME_SYNC.apple2` has three shapes and one absence: IIe polls `$C019`
  (set while drawing), IIgs polls it inverted, IIc has to enable VBL
  interrupts through the IOU and clear the flag with `PTRIG`, and the
  II/II+ have **no flag** — there a frame is a counted loop (17030 or
  20280 cycles) or a paddle-timer trick. Make the profile choose; never
  detect at run time in the frame prologue. Measure PAL/NTSC once at
  start-up the way cc65's `get_tv` does if the build allows both.
- Vblank on NTSC is roughly 70 of 262 lines (*to verify*); the Apple II
  has no snow, so the only reason to wait is tearing and page flips.

### LLVM-MOS

- Upstream `mos-apple2-clang` (not installed here) links a ProDOS SYS file:
  entry `JMP` at `$2000`, image and soft stack in `$2000-$BEFF`, zero page
  `$60-$FF` for the compiler and `$00-$1F` for the imaginary registers,
  Monitor `COUT`/`RDKEY` for stdio, `QUIT` on exit, Control-Reset routed to
  `_Exit`. It is `PARENT common`, so its libc is the generic one (no
  Commodore `CHR$(14)` trap). It has no hires, aux, 80-column or interrupt
  support: those are this project's to add as sections and profiles.
- Until the installed SDK is updated, nothing here builds. The alternative
  backend is cc65 (`apple2`, `apple2enh`), whose linker configs and drivers
  are the working references cited above.

## Emulator

- **Likely project choice: MAME** (`apple2e`/`apple2ee`/`apple2c`/`apple2gs`)
  because it runs on macOS from Homebrew, has every model including the IIc
  and IIgs, and has a scripted screenshot (`video:snapshot()` from Lua,
  `-str` to bound a run, `-video none`/`-sound none`); it is also what the
  upstream platform was tested in. Disk: `-flop1 file.dsk/.po/.2mg`, hard
  disk `-hard1`. Host-directory access: none native — build a ProDOS
  volume image (e.g. with `cadius` or `AppleCommander`, *to verify*).
- **AppleWin** is the reference emulator (Mockingboard, mouse, RamWorks,
  NTSC/RGB video, debugger) but Windows-only; on macOS use `audetto`'s
  `sa2`/`applen` or `sh95014`'s port. No screenshot/headless flag was found
  for any of them in the docs read.
- **microM8** is a third option with a macOS build; command-line and
  screenshot routes *to verify*.

## Traps for someone who knows the C64

1. **No sprites, no scroll, no colour RAM, no video registers.** Every
   pixel is a byte the program writes, through a switch bank that is
   toggled by *accessing* an address (reads and writes both do it).
2. **Hires colour is where the pixel is, not what you wrote.** Even X is
   purple/blue, odd X is green/orange, neighbours merge to white, and
   bit 7 of the byte flips the hue for all seven pixels in it.
3. **Rows are interleaved and the gaps are not yours.** `row * 40` is
   wrong on both the text page and the hires page, and the 8 bytes after
   each 3-row group are firmware state.
4. **The keyboard holds one key.** There is no matrix; "up and fire at
   once" needs the Apple keys or a joystick, and the joystick is a
   stopwatch.
5. **No vblank on the II/II+, inverted on the IIgs, gated on the IIc.**
   `FRAME_SYNC` is per profile.
6. **The program lives at `$2000`, which is hires page 1.** A ProDOS SYS
   file and the graphics screen fight over the same memory unless the link
   script moves one of them.
