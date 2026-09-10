---
title: PC Engine / TurboGrafx-16
nav_order: 22
---

# Writing PC Engine / TurboGrafx-16 support for 8BitScript

This file is for anyone — human or agent — who will create
`packages/pcengine` (the roadmap's name; LLVM-MOS's is `pce`), add it to
`packages/backend-6502` (`PCE_PROFILES`, `FRAME_SYNC.pce`, driver and
linker flags), teach `packages/cli/src/run.mjs` an emulator for it, or
write `docs/setup/pcengine.md`. None of those exist; the PC Engine is a
Phase 6 roadmap machine and the one `docs/roadmap.md` calls "a test of
whether the backend architecture scales". Read the root
[`AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/AGENTS.md) first; the rules there apply to every
target and are not repeated. [`packages/nes/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/nes/AGENTS.md)
is the nearest relative — a tile/nametable/sprite console behind a VRAM
port with a cartridge that is a family of profiles — and
[`packages/cx16/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/cx16/AGENTS.md) the nearest in *shape*:
big VRAM behind an indirect port, a bank window, a firmware API on one
media type. The PC Engine is —

> **A NES-shaped console with an X16-sized video chip and a CPU that is
> not a 6502: the HuC6280 maps 2 MB of physical space through eight 8K
> pages, runs at 7.16 MHz, has block-move and `st0/st1/st2` VDC-port
> instructions and a 6-voice wavetable PSG on the die, and *only 8K of
> RAM* on a HuCard. The VDC has 64 KB of VRAM behind an index/data port,
> one 8×8-tile background of up to 128×64 tiles, and 64 sprites of 16×16
> to 32×64 with a hard limit of 16 per scanline; the VCE holds 512
> 9-bit colors as 16 background + 16 sprite palettes of 16. Model the
> media — HuCard, CD-ROM², Super CD-ROM², Arcade Card, SuperGrafx — as
> profiles that change RAM from 8K to 2 MB and video from one VDC to two;
> never as one machine.**

## What exists today

Do not describe more than this as working:

- Nothing in this repository. No `packages/pcengine`, no profiles, no
  frame driver, no `8bs run`, no setup page, and no PC Engine emulator
  installed here (`which mednafen mame mesen` fail). Nothing below was
  seen on screen.
- LLVM-MOS ships `mos-pce-clang` (HuCard: an empty `main()` links to an
  8192-byte `.pce` ROM plus `.elf`), `mos-pce-cd-clang` (a CD-ROM²
  program linked against the System Card BIOS; the output is an ELF
  whose `.text` is at `$4000`, which `pce-mkcd` accepts as the disc's
  *initial program* — `pce-mkcd out.iso prog.elf` parses it, then stops
  with "Could not locate 'ipl.bin' file!", and the boot-sector `ipl.bin`
  that `--ipl` wants is not anywhere under `~/.local/opt/llvm-mos` — so
  the CD flow was *not* completed here), and
  `mos-pce-common-clang` (the shared headers/libc). Every "verified"
  row below is from those headers, link scripts, `crt0.o`, or
  `llvm-objdump` of the linked test programs.

## Facts verified here

Cite these freely; each was read in the file named.

| Fact | Where |
| ---- | ----- |
| `-mcpu=moshuc6280`, `-D__PCE__`; HuCard adds `-mlto-zp=224` and `-fpost-link-tool=llvm-mlb` (emits a Mesen `.mlb` label file beside the ROM); CD adds `-D__PCE_CD__`, `-mlto-zp=188`, `-Wl,--emit-relocs`, `-Wl,--unresolved-symbols=ignore-all` (BIOS symbols resolve at load). | `~/.local/opt/llvm-mos/bin/mos-pce.cfg`, `mos-pce-cd.cfg`, `mos-pce-common.cfg` |
| Clock constants: colorburst = 315 MHz/88 = 3.579545 MHz; `PCE_SYSTEM_FREQ` = ×6 = 21.477 MHz; `PCE_CPU_FREQ` = ×2 = **7.159 MHz**; `PCE_TIMER_FREQ` = CPU/1024 = 6991 Hz. | `mos-platform/pce-common/include/pce/system.h` |
| Start-up (`_early_start`, 35 bytes at `$FFD3`, asserted by the link script): `sei`, **`csh`** (high-speed mode — the CPU boots slow), MPR0 ← `$FF` (I/O page at `$0000`–`$1FFF`), stack `$FF`, MPR1 ← `$F8` (RAM at `$2000`–`$3FFF`), MPR2–6 ← link-computed start banks (0 in an 8K build), `jmp _start`. Then `.init.50`: `$07` → `$1402` (**all three IRQ sources masked**), `__pce_vdc_init` (CR ← 0, BXR/BYR ← 0, all 512 VCE palette entries ← 0), `__pce_psg_init` (6 channels: volume 0, control 0, noise 0, LFO 0). So at `main()` the display is *off* and black, interrupts are off. | `mos-platform/pce/lib/crt0.o` (objdump), `llvm-objdump -d p.pce.elf` |
| Vectors at `$FFF6`: IRQ2 (`irq_ext`), IRQ1 (`irq_vdc`), timer (`irq_timer`), NMI, reset (`_early_start`). Default handlers ack by reading VDC status `$0000` / `$1403`. Hook sections `.irq_vdc`, `.irq_timer`, `.irq_ext` (KEEP'd, init-priority sorted). | `pce/lib/link.ld`, `rom-sections.ld`, objdump |
| Memory the C code gets on a HuCard: zero page is **physical `$2000`–`$20FF`** (bank `$F8`; `__rc0 = 0xf82000`), stack page `$2100`, C RAM `$2200`–`$3FFF` (`ram ORIGIN = 0xf82200, LENGTH = __ram_bank_size - 0x200`), soft stack from `$2000 + __ram_bank_size`. `__ram_bank_size` defaults to `$2000` (8K); `PCE_SGX_RAM(n)` raises it (SuperGrafx: "up to 24KB with all SuperGrafx RAM fixed"). ROM bank 0 at `$E000`; fixed ROM may extend down through MPR6..2 (`__rom_bank0_size` up to 48K); 128 banks × 8K = **1 MB** maximum (`__rom_size`). | `pce/lib/link.ld`, `pce-common/lib/pce-imag-regs.ld`, `pce/lib/_rom-banked-sections.ld`, `pce/include/pce/config.h` |
| I/O page layout: VDC `$0000` (status/index `$0000`, data `$0002`/`$0003`), VCE `$0400` (control), `$0402` color index, `$0404` color data; PSG `$0800`–`$0809`; timer `$0C00`/`$0C01`; joypad `$1000`; IRQ control `$1402`, status/ack `$1403`; CD unit `$1800`–`$180F` (SCSI, BRAM unlock `$1807`, ADPCM `$1808`–`$180E`, fader `$180F`); Super System Card `$18C5`–`$18C7`; Arcade Card `$1A00`–`$1AFF` (ID `$1AFF` = `$51`); SuperGrafx VDC2 `$0010`, VPC `$0008`–`$000F`. | `pce-common/include/pce/hardware.h` |
| VDC registers: 0 MAWR, 1 MARR, 2 VWR/VRR, 5 CR (IRQ enables, sprite/BG enable, VRAM auto-increment 1/32/64/128), 6 RCR, 7 BXR, 8 BYR, 9 MWR (VRAM/sprite cycle slots, **BG size 32/64/128 × 32/64**), 10–14 HSR/HDR/VPR/VDW/VCR, 15 DCR, 16–18 SOUR/DESR/LENR, 19 SATB. Status: collide `$01`, **overflow `$02`**, scanline `$04`, SATB DMA done `$08`, DMA done `$10`, **vblank `$20`**. | `hardware.h` |
| Sprite attribute word: palette bits 3–0, FG/BG priority bit 7, width 16/32 bit 8, height 16/32/64 bits 13–12, flip X bit 11, flip Y bit 15; SATB entry = `{y, x, pattern, attr}` (4 words). | `pce-common/include/pce/vdc.h` |
| VCE: control bits pixel clock 5/7/10 MHz, field even (262 lines)/odd (263), color burst off; `VCE_COLOR(r,g,b) = b | r<<3 | g<<6` (3-3-3, **GRB** bit order); `VCE_COLOR_INDEX(palette, color) = palette<<4 + color`. | `hardware.h`, `vce.h` |
| The SDK's 256×240 recipe (`pce_vdc_set_resolution(256, 240, 0)`): VCE control ← 0, HSR ← `$0202`, HDR ← `$041F` (HDW = 32 tiles − 1 = `$1F`, HDE `$04`), MWR bits for the width, VPR ← `$0F02`, VDW ← `$00EF` (240 − 1), VCR ← `$000C`. | `llvm-objdump -d p.pce.elf` (main) |
| Joypad protocol as linked: `pce_joypad_read` writes SEL (`$01`), delay, reads, writes SEL|CLR (`$03`), delay, reads (multitap reset), then `pce_joypad_next`: SEL=1, four `sxy` delays, read → high nibble (directions); SEL=0, delay, read low nibble (Run/Select/II/I); returns the two nibbles combined **without inversion** — the header says "buttons currently pressed" with `KEY_LEFT $80 … KEY_1 $01`; whether a set bit means pressed on hardware (active-low port) is *to verify* against the SDK's `joypad.c`. `$1000` bit 6 = COUNTRY (clear = Japan), bit 7 = ADDON (clear = CD unit attached). | objdump, `pce/joypad.h`, `hardware.h` |
| PSG per channel (select `$0800`): `$0802/3` 12-bit frequency, `$0804` control (on `$80`, **DDA `$40`**, volume), `$0805` L/R volume nibbles, `$0806` waveform sample (32 writes fill the table), `$0807` noise (on `$80`, freq), `$0808/9` LFO freq/control. | `hardware.h` |
| `pce_memop` = self-modifying block-move stub: opcodes TII `$73`, TDD `$C3`, TIN `$D3`, TAI `$E3`, TIA `$F3`, patched into RAM at `__rc3..__rc10` then called — hence the "contiguous `__rc3`–`__rc10`" linker assertion. `pce_vdc_copy_to_vram` uses TIA into the VDC data port. | `pce/memory.h`, `pce-imag-regs.ld`, objdump |
| CD-ROM² link: `pce-cd/lib/link.ld` = `ipl.ld`; `mos-pce-cd-clang` emits one ELF (no raw image) that `pce-mkcd <iso> <elf>` takes as the initial program and refuses a non-ELF ("Cannot turn \"e.c\" into an initial program!"); it then needs `--ipl ipl.bin` (first sector), absent from this install. Code loads to **`$4000`** (bank 128 = `$80`, `ram_bank128` at `$4000`), C RAM from `$22D0` (or `$2616` with the BIOS PSG driver, `$2649` with its graphics driver) to `$4000`, ZP ends at `$20EC`/`$20E6`/`$20DC`; CD RAM = banks 128–135 (**64 KB**), Super CD = banks 104–135 (**256 KB**, `binary-scd.ld`, `c_writeable = ram_bank104`). ~90 `pce_cdb_*` BIOS calls (CD read/seek/play, ADPCM, VDC helpers, `pce_cdb_wait_vblank`, mul/div/sqrt, BRAM `pce_cdb_ram_query`, palette). | `pce-cd/lib/*.ld`, `pce-cd/include/pce/cd/bios.h` |
| SuperGrafx: `pce_sgx_detect()` toggles bits `$C0` of VPC `$0009` and reads back; VPC window priority modes (default order "SP2 BG → BG2 → SP2 FG → SP1 BG → BG1 → SP1 FG"); `pce_sgx_vdc_set(1|2)` retargets the VDC helpers. | `hardware.h`, `vdc.h`, objdump |

## From the sources, not verified here

Sources: the HuC6270 CMOS VDC manual (archive.org text), Mednafen's `pce`
/`pce_fast` docs, patpend.net's VDC notes, the copetti.org architecture
article, Wikipedia (HuC6270, HuC6280), and Mesen2's sources/docs.

**CPU.** HuC6280 = 65C02 core + MMU (8 MPRs, 8K pages, 21-bit / 2 MB
physical), two speeds (1.79 / 7.16 MHz, `csl`/`csh`), on-die PSG, timer,
8-bit I/O port, interrupt controller; instructions beyond the 65C02:
`tam`/`tma` (MPR set/get), `st0/st1/st2` (write VDC index/data directly),
`tii/tdd/tin/tia/tai` block moves, `sxy/sax/say`, `cla/clx/cly`,
`csh/csl`, `set`, `bsr`, `tst`. Zero page and stack are physical
`$2000`/`$2100` (MPR1 = `$F8`) — the C RAM row above. Bank numbers: `$00`–
`$7F` HuCard (1 MB), `$80`–`$87` CD RAM, `$68`–`$7F` Super CD RAM, `$F7`
BRAM (2 KB backup, unlock at `$1807`) *(bank to verify)*, `$F8` (–`$FB` on
SGX) work RAM, `$FF` I/O. HuCards above 1 MB use a mapper (Street
Fighter II') *(to verify)*.

**VDC.** VRAM 64 KB = 32K 16-bit words, addresses `$0000`–`$7FFF` (the
manual says "64K words … for sprites" in one note; Wikipedia says the
VDC can address 128 KB with the upper half mirroring — a *units
conflict*, see below). One background layer of 8×8 4-bpp tiles (four
planes), BAT of 32/64/128 × 32/64 entries, each entry = palette (4 bits)
+ tile index (12 bits); BXR/BYR scroll in pixels, changeable per line
from the RCR interrupt (RCR = line + 64). Sprites: 64 SATB entries, 16×16
base with CGX/CGY doubling to 32 wide and 32/64 tall, origin offset x+32
/ y+64, 4 bpp with 16 sprite palettes, FG/BG priority against the tiles,
**16 per scanline** (manual note 6; the overflow flag fires "when more
than 17" per patpend/manual). A per-line *pixel* figure (32-wide sprites
counting double, "256 pixels") is common lore — *to verify*. SATB lives
in VRAM and is copied to the VDC's internal table by the VRAM→SATB DMA
(register 19, optionally every vblank via DCR); VRAM→VRAM DMA and that
copy happen during vblank. Widths 256/320/512 by dot clock 5/7/10 MHz;
heights 224/240; 262/263 lines NTSC — ~59.94 Hz *(to verify)*; there is
no PAL machine (the French model is NTSC at 50 Hz? *to verify*).

**VCE.** 512 entries × 9-bit GRB: `$000`–`$0FF` the 16 background
palettes, `$100`–`$1FF` the 16 sprite palettes. Color 0 of every sprite
palette is transparent; **the overscan/border color is `$100`** (sprite
palette 0 color 0 — the SDK's own `color-cycle.c` cycles index `0x100`
to color the empty screen) and background palette entry `$000` is the BG
layer's color 0 *(the exact rule for which of `$000`/`$100` shows through
a transparent tile pixel: to verify)*.

**PSG.** 6 channels; each plays a 32-sample 5-bit wavetable at a 12-bit
frequency with 4-bit volume plus L/R nibbles; channels 5–6 can switch to
noise; channel 2 can be the LFO for channel 1; DDA mode writes the DAC
directly (5-bit, PCM by CPU or timer IRQ). No envelopes, no filter, no
entropy register.

**CD-ROM² / Super CD / Arcade Card.** The System Card (`syscard3.pce` in
Mednafen; Mesen loads "Super CD-ROM System" firmware) is the OS: it boots
the disc's IPL, provides the BIOS calls, and owns ZP/RAM below the
addresses in the table. CD-ROM²: 64 KB program RAM + 64 KB ADPCM RAM +
2 KB BRAM; Super CD: 256 KB; Arcade Card: +2 MB through four port pages
(registers verified). ADPCM is 4-bit at 2–16 kHz *(to verify)* played by
the CD unit, CD-DA by the drive; both mixed by the fader (`$180F`).

**SuperGrafx.** Two VDCs (VDC1 `$0000`, VDC2 `$0010`) each with 64 KB
VRAM, combined by the VPC (`$0008`–`$000F`) with two priority windows;
32 KB work RAM. Five games; Mednafen `pce.forcesgx`, Mesen by `.sgx`
extension or CRC.

**Input.** 2-button pad (I, II, Select, Run + D-pad) read as two nibbles
via SEL; 6-button pads (Avenue Pad 6) return a second pair on alternate
SEL cycles *(to verify)*; multitap up to 5 pads (`pce_joypad_next`;
Mednafen `input.port1`–`port5`); PC Engine Mouse exists and both Mednafen
modules emulate it (`port1` = `mouse`). No keyboard.

**Emulators.**
- *Mesen2* (`SourMesen/Mesen2` — archived June 2026; active fork
  `nesdev-org/MesenCE` *(check which the project pins)*): PC Engine,
  SuperGrafx, CD (`.cue`), Arcade Card (`cardRamSize = 0x30000` in
  `PceConsole.cpp`). **Headless route:** `--testRunner` runs a Lua
  script with the ROM at max speed with no window (`--novideo --noaudio
  --noinput`), `.lua` files are positional arguments,
  `emu.takeScreenshot()` returns a PNG as a Lua string ("not saved to the
  disk" — write it with Lua `io`), `emu.addEventCallback(fn,
  eventType.endFrame)` counts frames, `emu.stop(exitCode)` ends the run;
  `emu.read(addr, memType)` reaches `pceVideoRam`, `pcePaletteRam`,
  `pceSpriteRam`, `pceWorkRam`, `pceCdromRam`, `pceArcadeCardRam`, the
  VDC2 variants. `--doNotSaveSettings` keeps a scripted run from
  changing the user's config. LLVM-MOS's `llvm-mlb` post-link tool emits
  the label file Mesen's debugger reads.
- *Mednafen* `pce` (accurate) and `pce_fast`: HuCard and CD (needs
  `syscard3.pce`; `pce.cdbios`), `pce.forcesgx`, `pce.arcadecard`
  (default on), `pce.slstart`=4 / `pce.slend`=235 (**it crops 8 lines of
  240 by default**), `pce.h_overscan`, `pce_fast.nospritelimit`,
  `pce_fast.input.port1..5` = gamepad|mouse. Screenshot = F9; no
  documented headless route.
- *MAME* has `pce`/`tg16`/`sgx` drivers *(to verify)*; the `-str` snapshot
  route applies if used.
- Host filesystem: none. The CD `.cue`/ISO is the only "media" route.

## Conflicts between sources

- **VRAM units.** "64 KB", "32K words", "64K words", "128 KB addressable,
  upper half mirrors": the physical VRAM is 64 KB and VDC addresses are
  16-bit *word* addresses `$0000`–`$7FFF`; bit 15 mirrors. Write "32K
  words = 64 KB" and *to verify* before relying on the mirror.
- **Sprite limit.** 16 per line (manual) vs the overflow flag's "more than
  17"; and the width accounting is unstated. Budget 16 sprite *slots*
  per line, treat 32-wide as two *until verified*.
- **Joypad polarity.** Header "pressed" vs no inversion in the linked
  code. Verify on an emulator before writing `input`.
- **Frame rate.** 262/263-line fields are in the VCE control bits; 59.94
  Hz is the NTSC assumption, not a measured number.

## Rules for this target

### Memory: a bank is part of every address

- A pointer is meaningful only with the MPR that maps it. C RAM
  (`$2200`–`$3FFF` on a HuCard) is the *only* always-mapped writable
  window; ROM banks appear through MPR2–6 and the LLVM-MOS
  `PCE_ROM_BANK_AT(id, offset)` + `pce_rom_bank<id>_call()` pattern
  (push MPR, map, call, pop). Represent far data as (bank, offset) and
  make the compiler emit the `tma/tam` pairs; never let a user pointer
  cross a page boundary into another bank.
- 8K of RAM (7.5K usable) is the HuCard budget — VIC-20 class, with
  X16-class video. Level data stays in ROM and streams through the VDC
  port; the CD profiles (64K/256K/2 MB) are the ones with room, and a
  program says `>= 64K` the way the X16 note says `>= 512K`.
- Keep MPR0/MPR1 (`$FF`, `$F8`) fixed forever; the SDK's ZP/stack/I/O
  assumptions depend on them.
- The CD profiles *share RAM with the System Card* (its ZP up to `$20EC`,
  its workspace to `$22D0`+). A CD build's RAM map is not the HuCard's,
  and enabling the BIOS PSG/graphics drivers costs more of it.

### VDC: everything through one index/data port, in words

- VRAM is indirect (MAWR/MARR + VWR/VRR, or `st0/st1/st2`), 16-bit, with
  auto-increment 1/32/64/128 — the same discipline as VERA: set the
  address once and stream. Tile data, the BAT, and the SATB all live
  there; allocate VRAM at build time (BAT at `$0000` in the SDK's
  convention *to verify*, SATB at `$7F00` in the test program).
- Text: no text mode. `text.print` = BAT entries naming font tiles in
  a 32/40/64-column BAT (256/320/512 wide) × 28/30 rows, written through
  the port — during vblank or not (VDC writes outside vblank are allowed
  but steal display cycles; snow is not a PCE problem *to verify*).
  `text.COLUMNS` is a property of the width profile. Mednafen crops to
  lines 4–235 by default: keep row 0 and row 29 out of anything that
  must be seen.
- `screen.setBorder()` = VCE `$100`; `setBackground()` = BG palette 0
  color 0 (`$000`) *(rule to verify)*. Both are real registers.
- Vblank is where SATB DMA and VRAM→VRAM DMA run; the SATB the program
  edits is in VRAM and reaches the hardware one frame later — the NES's
  OAM-DMA shape exactly.

### Sprites: 64 entries, 16 per line, in VRAM

- The per-scanline budget is 16 sprite *slots* (verify width accounting),
  not 64. Reuse the NES tooling's per-line counter; metasprites of 32×64
  parts eat the line budget fast.
- Sprite priority vs background is per sprite (bit 7); between sprites,
  lower SATB index wins *(to verify)*. Sprite color 0 is transparent.
- Collision: the VDC flags sprite-0 overlap only *(to verify: "collide"
  status bit semantics)*; software AABB is the portable primitive.

### Audio, input, timing

- Six wavetable voices: a portable note API gets *timbre* (a 32-sample
  table) as a first-class thing here; envelopes are software on the
  timer IRQ (6991 Hz base). DDA = PCM by CPU write; the CD unit's ADPCM is
  a profile capability. No hardware entropy: seed from input timing.
- Poll the pad once per frame after `waitFrame()` through the SEL/CLR
  protocol; multitap needs CLR then N `next` reads in order.
- `waitFrame()` = VDC vblank IRQ (IRQ1) or poll status `$0000` bit 5 —
  reading the status register *acks* the interrupt, so a poller under
  `sei` and the default `irq_vdc` handler must not both read it. 59.94 Hz
  nominal; `frameRate` divides that like the NTSC drivers.

### Profiles

`PCE_PROFILES`: `hucard` (default; ROM 8K–1 MB, RAM 8K, no persistence),
`sgx` (two VDCs, 32K RAM), `cd` (System Card 3, 64K, BRAM 2K), `scd`
(256K), `acd` (Arcade Card, +2 MB), each with `ntsc` only. Persistence:
`hucard` none (Tennokoe/Backup Booster BRAM peripherals *to verify*),
CD profiles BRAM 2 KB. Video region: none. Output name carries the
profile.

## Where things live

```
~/.local/opt/llvm-mos/bin/mos-pce-clang            HuCard driver: .pce ROM (8K-1 MB), llvm-mlb label file
~/.local/opt/llvm-mos/bin/mos-pce-cd-clang         CD-ROM² program linked against the System Card, loads at $4000
~/.local/opt/llvm-mos/bin/pce-mkcd                 ISO builder (needs an --ipl first sector the SDK does not ship)
~/.local/opt/llvm-mos/mos-platform/pce-common/include/pce/hardware.h   the whole I/O page: VDC, VCE, PSG, timer, pad, IRQ, CD, Arcade Card, SGX
~/.local/opt/llvm-mos/mos-platform/pce-common/include/pce/{vdc,vce,psg,joypad,memory,system,bank,config}.h   libpce API
~/.local/opt/llvm-mos/mos-platform/pce/lib/link.ld + _rom-banked-sections.ld   MPR start banks, 128 ROM banks, RAM $2200-$3FFF
~/.local/opt/llvm-mos/mos-platform/pce-cd/lib/{ipl,cd-memory,binary-cd,binary-scd}.ld   CD/SCD RAM banks, BIOS-shared RAM
~/.local/opt/llvm-mos/mos-platform/pce-cd/include/pce/cd/bios.h        pce_cdb_* System Card calls
~/.local/opt/llvm-mos/examples/pce/color-cycle.c   the SDK's vblank-IRQ + VCE $100 example
packages/pcengine/                                 (future) target package: VDC port helpers, screen/text over the BAT
packages/backend-6502/src/index.mjs                (future) PCE_PROFILES, FRAME_SYNC.pce (VDC status bit 5 under sei)
packages/cli/src/run.mjs                           (future) Mesen --testRunner <rom> <script.lua> --novideo --noaudio
docs/roadmap.md                                    Phase 6: "a test of whether the backend architecture scales"
```
