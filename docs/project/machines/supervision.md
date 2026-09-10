---
title: Watara Supervision
nav_order: 23
---

# Writing Watara Supervision support for 8BitScript

This file is for anyone — human or agent — who will create
`packages/supervision`, add it to `packages/backend-6502`
(`SUPERVISION_PROFILES`, `FRAME_SYNC.supervision`, driver and linker
flags), teach `packages/cli/src/run.mjs` an emulator for it, or write
`docs/setup/supervision.md`. None of those exist; the Supervision is a
Phase 6 roadmap machine (`docs/roadmap.md`). Read the root
[`AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/AGENTS.md) first; the rules there apply to every
target and are not repeated. [`packages/pet/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/pet/AGENTS.md)
is the nearest relative in *spirit* — a machine with almost nothing,
where the whole output is bytes in one buffer — and the Lynx note
(`lynx.md`) the nearest in *shape*: a handheld with a bitmap. The
Supervision is —

> **A 65C02 at 4 MHz with 8K of work RAM, 8K of video RAM holding a
> 2-bit-per-pixel bitmap of which a 160×160 window is shown on a
> four-grey LCD, a DMA engine whose main job is copying into that VRAM,
> two hard-panned square-wave channels, one noise channel, one 4-bit
> sample DMA channel, an 8-button pad, and a 16K bank window over a
> cartridge of at most 128K. No color, no tiles, no sprites, no text
> mode, no vertical-blank flag, no persistence. Model it as a Game Boy
> without the tile engine — a Lynx without Suzy.**

The machine's variety is the cartridge size (32K flat, 64K or 128K
banked) and, in emulators, the LCD refresh/NMI behavior of the original
vs later boards *(to verify)*.

## What exists today

Do not describe more than this as working:

- Nothing in this repository. No `packages/supervision`, no profiles, no
  frame driver, no `8bs run`, no setup page, and no Supervision emulator
  installed here (`which mame mednafen` fail; Mednafen has no Supervision
  module at all — see the emulator section). Nothing below was seen on
  screen.
- LLVM-MOS ships `mos-supervision-clang`: an empty `main()` links to a
  32768-byte cartridge image (`empty.supervision`) plus `.elf`. Every
  "verified" row below is from `supervision.h`, `link.ld`, `crt0.o`, or
  `llvm-objdump` of a linked test program that calls the SDK's
  `sv_lcd_*`/`sv_dma_*`/`banked_call` helpers.

## Facts verified here

Cite these freely; each was read in the file named.

| Fact | Where |
| ---- | ----- |
| `-mcpu=mos65c02`, `-D__SUPERVISION__`, `-mlto-zp=224`. `SV_SYSTEM_CLOCK_HZ 4000000`, `SV_LCD_WIDTH/HEIGHT 160`. | `~/.local/opt/llvm-mos/bin/mos-supervision.cfg`, `mos-platform/supervision/include/supervision.h` |
| Memory: zero page from `$0020`, RAM `$0200`–`$1FFF` (8K work RAM at `$0000`), soft stack from `$2000` down; `SV_RAM $0000`, `SV_VRAM $4000`, `SV_ROM $8000` (bank window), `SV_ROM_FIXED $C000`. Cartridge: `__cart_rom_size` 32 (default), 64 or 128 KB, power of two, asserted; 32K → one flat `rom_fixed` at `$8000`–`$FFF9`; ≥64K → 16K banks `.rom_0`…`.rom_6` at `$8000` and a fixed 16K at `$C000` (`.rom_7`/`.rom_fixed`); vectors NMI/reset/IRQ at `$FFFA`. Output = the banks then the fixed bank, whole image. | `mos-platform/supervision/lib/link.ld` |
| VRAM geometry as the SDK models it: **192 × 170 pixels at 48 bytes per line** (`SV_VRAM_WIDTH 192`, `SV_VRAM_HEIGHT 170`, `SV_VRAM_PITCH 48`, `SV_VRAM_ROW(y) = $4000 + y*48`) = 8160 bytes; 2 bits per pixel; colors `SV_COLOR_WHITE 0`, `LIGHT_GREY 1`, `DARK_GREY 2`, `BLACK 3`. | `supervision.h` |
| LCD registers `$2000` width, `$2001` height, `$2002` x, `$2003` y (`struct __sv_lcd`); `sv_lcd_init()` writes 160/160/0/0; `sv_lcd_clear()` = `memset($4000, 0, 48*170)`. | `supervision.h`, objdump of `sv.bin.elf`, SDK `supervision.c` (fetched) |
| Video DMA `$2008`: CPU-side pointer (2 bytes), VRAM address (2 bytes), length (**in 16-byte units**: `length = len >> 4`), trigger (`$80` start, `$00` stop). The linked `sv_dma_to_vram($4000, $0300, 256)` writes `$2008/9 ← $0300`, `$200A/B ← $4000`, `$200C ← $10`, `$200D ← $80` then `$00`; the linked `sv_dma_from_vram($0300, $4000, 16)` writes the *same* `$200A/B ← $4000` with `$200C ← $01` — see Conflicts. | `supervision.h`, objdump, `supervision.c` |
| Audio: tone R at `$2010` and tone L at `$2014` (`divider` 16-bit, `control`: duty `$00/$10/$20/$30` = 12.5/25/50/75 %, repeat `$40`, volume low nibble; `length`); noise at `$2028` (`voldiv`: divider `$00`–`$0D` = ÷8…÷65536, volume; `length`; `control`: enable `$10`, left `$08`, right `$04`, repeat `$02`, tap 15/7 `$01/$00`); audio DMA at `$2018` (`src` pointer, `length`, `control`: bank `n<<4`, left `$08`, right `$04`, rate ÷256/512/1024/2048 `$00`–`$03`; `trigger`). | `supervision.h` |
| Joypad `$2020`: START `$80`, SELECT `$40`, A `$20`, B `$10`, UP `$08`, DOWN `$04`, LEFT `$02`, RIGHT `$01` (masks; polarity not stated in the header). Link port `$2021` data / `$2022` dir. | `supervision.h` |
| System `$2023` timer divider, `$2024` timer-IRQ ack, `$2025` audio-DMA-IRQ ack, **`$2026` control**, `$2027` IRQ status (timer `$01`, audio DMA `$02`). Control bits as the SDK reads them: NMI enable `$01`, timer IRQ enable `$02`, audio-DMA IRQ enable `$04`, **LCD enable `$08`**, timer prescaler 256/16384 `$00/$10`, **bank = bits 7–5**. `sv_lcd_enable()` links to `ora #$08`, `sv_bank_get()` to `>> 5`; the SDK shadows the write-only register in ZP (`__sys_control`). | `supervision.h`, objdump |
| crt0: `sei`, `ldx #$ff / txs`, `__early_init` = `sv_sys_control_set(0)` (**NMI off, IRQs off, LCD off, bank 0**), init stack, zero ZP bss, `jsr main`; default `irq` = `rti`; an `.nmi` section is KEEP'd between register-saving prologue/epilogue. LCD is *off* at `main()`; nothing sets the LCD size. | `mos-platform/supervision/lib/crt0.o`, objdump of `empty.supervision.elf` |
| `banked_call(bank, fn)`: shifts the bank into bits 7–5 of the shadow, writes `$2026`, calls, restores. `SV_CART_ROM_KB(kb)` sets `__cart_rom_size` from C. | `supervision.h`, objdump |

## From the sources, not verified here

Sources: GrenderG's *Supervision Reverse Engineering Notes* (a
transcription of Kevin "kevtris" Horton's `Supervision_Tech.txt`, which
did not fetch here), Wikipedia, MAME's docs and Mednafen's docs.

**CPU and memory.** 65C02 at 4 MHz (crystal), 0 wait states on work RAM;
8K WRAM `$0000`–`$1FFF`, 8K VRAM `$4000`–`$5FFF` shared with the LCD
controller, I/O `$2000`–`$202F`, bank window `$8000`–`$BFFF` (16K, bits
7–5 of `$2026`), fixed `$C000`–`$FFFF` = last 16K of ROM; carts up to
128K, most 64K. Cartridge `/WR` is unused — **no cartridge RAM, no saves**.

**LCD.** 160×160, 4 greys. The notes say **30 bytes per line** (160 px ×
2 bits) and describe the greys as two interlaced *fields* per frame —
"first field 1, second 0 = 1/3 dark" etc.; the SDK's model is 2 bits per
pixel in a 48-byte-pitch (192-pixel) VRAM line with the shown 160×160
window selected by `$2002`/`$2003`. Both can be true if the controller
reads 2 bpp and drives the panel by field-interleaving; *to verify*
which pixel/bit order the panel shows and whether the 48-byte pitch is
hardware or an SDK convention (`$2000`/`$2001` "size" registers suggest
the controller is told the line length). Pixel order: bits 1–0 = pixel
0, bits 3–2 = pixel 1 (notes). Timing (notes): 246 clocks per scanline
(40 writes × 6 + latch), 160 lines = 39,360 clocks per field, 2 fields
= 78,720 clocks per frame → **~50.8 Hz**; the LCD reads VRAM through the
DMA bus ("every 6th cycle reserved for LCD").

**Interrupts.** **NMI every 65,536 cycles = 61.04 Hz**, when enabled in
`$2026` — *not* synchronised to the LCD. Timer IRQ: 8-bit countdown at
`$2023` with a 256 or 16384 prescaler; writing 0 fires immediately.
Audio-DMA-done IRQ. There is **no vblank flag** in the register map.

**DMA.** WRAM/ROM → VRAM only (notes: "can only be used to move data
from WRAM/cartridge ROM to VRAM"), 5 bytes per 6 cycles, length × 16
bytes with 0 = 4096; trigger `$80`. The SDK header also defines
`SV_VDMA_FROM_VRAM` and `sv_dma_from_vram()` — *conflict, to verify*.

**Audio.** CH1 right only, CH2 left only (frequency = 125000/(div+1) Hz,
4 duty cycles, 16 volumes, length counter in 16.384 ms steps); noise
15/7-bit LFSR, ÷8…÷65536; sample channel: 4-bit nibbles from a bank at
÷256…÷2048 (upper nibble then lower), L/R/mono; all channels summed
and clipped at `$0F`. No envelope, no filter, no entropy register.

**Input.** One 8-button pad at `$2020` (active low per the notes). Link
port: 4-bit bidirectional, two players. No keyboard, no mouse. The
"TV Link" accessory shows the four greys as four colors on a TV.

**Emulators.**
- *MAME*: the `svision` driver (variants `svisions`, `svisionp`,
  `svisionn`, `tvlinkp` — names *to verify*; the source file could not be
  located at the paths tried). Headless: `-str N -video none -sound none
  -nothrottle` writes a snapshot at exit (MAME docs) — the headless route.
  Cartridge via `-cart file.bin` *(to verify the slot name and accepted
  extensions)*.
- *Mednafen*: **no Supervision module** (its documented system list has
  none), contrary to the brief's pairing. Do not plan on it.
- Others: Potator (the classic standalone), libretro `potator`, WasabiDS
  — none with a documented headless route *(to verify)*.
- No host-filesystem route anywhere: there is no storage to mount.

## Conflicts between sources

- **`$2026` low nibble.** SDK: NMI `$01`, timer IRQ `$02`, audio-DMA IRQ
  `$04`, LCD `$08`, prescaler `$10`, bank bits 7–5. The notes as fetched:
  NMI bit 1, IRQ bit 2, prescaler bit 3, display bit 4, bank 7–5 — the
  whole low nibble is shifted by one, not just the LCD bit (the notes may
  be numbering from 1; the transcription does not say). The linked code
  uses `$08` for the LCD; a real machine or MAME's driver decides. *To
  verify before any frame driver sets NMI/IRQ enables.*
- **DMA direction.** The header offers `SV_VDMA_TO_VRAM(a) = a | $4000`
  and `SV_VDMA_FROM_VRAM(a) = a`, and `sv_dma_from_vram()`; but any VRAM
  address already has bit 14 set, so in the linked code `to_vram` and
  `from_vram` write identical `$200A/B` values — the macros cannot encode
  a direction. That supports the notes' "WRAM/ROM → VRAM only". Treat the
  DMA as one-way until a VRAM read-back is demonstrated.
- **Bytes per line.** 30 (notes, the displayed 160 px) vs 48 (SDK, a
  192-px VRAM line with a window). Related: whether the size registers
  set the pitch.
- **Frame rate.** ~50.8 Hz LCD vs 61.04 Hz NMI: two clocks, neither is
  "the frame rate" from the CPU's point of view.

## Rules for this target

### Memory: 8K, a bank window, and a buffer you cannot see

- RAM is flat `$0200`–`$1FFF` (7.5K after ZP and stack) — VIC-20 class.
  VRAM `$4000`–`$5FFF` is CPU-addressable (the SDK's `memset` clears it
  directly), but the LCD controller shares the bus; bulk updates go
  through the DMA (5 bytes per 6 cycles, far faster than `sta (zp),y`).
- ROM above 32K is 16K pages in the `$8000` window with a fixed 16K at
  `$C000`; a program picks a cart size at build time (`__cart_rom_size`
  32/64/128) and a (bank, offset) is not a pointer. Hold code in the
  fixed bank, data in banks, and use the SDK's `banked_call` shape.
- Nothing persists. A "save" capability does not exist on this machine
  in any profile; the pad is the only input and the link port the only
  output besides the LCD and speaker.

### Video: a 2-bpp bitmap and a window

- Everything is bytes in VRAM: 4 pixels per byte, 4 greys, no color.
  `screen.setBackground()` is a fill (DMA a 16-byte pattern or `memset`);
  `setBorder()` is inert — the LCD is the whole 160×160 window.
- No text mode: `text.print` renders a font into the bitmap — 20×20
  cells at 8×8 (40 bytes per glyph row at 2 bpp) or 26×26 at 6×6; the
  package chooses and `text.COLUMNS` says which. Reverse video is free
  (invert the 2-bit value); "color" is one of four greys per pixel.
- Two scroll registers (`$2002`/`$2003`) and a VRAM wider than the LCD
  (192 vs 160 per the SDK) give a *hardware window*: coarse scrolling by
  moving the window over a larger drawing, the way the Lynx uses HOFF/
  VOFF — *if* the pitch model is right (verify first).
- Draw whenever: there is no vblank, no snow reported, but the LCD reads
  VRAM continuously, so a half-updated frame *can* be shown. The only
  tear-free technique is drawing off-screen (a second VRAM region if the
  8K allows — 160 lines × 48 = 7680 of 8192 bytes, so no full second
  buffer at 48-byte pitch) or building lines in WRAM and DMA-ing them.
  Budget in bytes DMA'd per frame, not sprites.
- Greys are field-interleaved on the real panel: a 1-pixel-tall light
  grey line flickers. Prefer 2-pixel-tall features in the mid greys
  *(from the notes; to verify on hardware)*.

### Timing: nothing is a frame

- `waitFrame()` has no vsync to wait on. The options are the **NMI
  (61.04 Hz)** and the **timer IRQ** (`$2023` at 4 MHz/256 or /16384).
  A Supervision `FRAME_SYNC` should make `frameRate` a timer or NMI
  period — the PET's measure-it approach has nothing to measure — and
  document that the LCD's ~50.8 Hz scan is unrelated: with a 60-frame
  program, some frames are shown twice and some never. Do not call the
  NMI "vblank" anywhere.
- crt0 starts with NMI *and* IRQ disabled and the LCD off; the frame
  prologue must set `$2026` deliberately (through the SDK's shadow byte —
  the register is write-only) and turn the LCD on after clearing VRAM.

### Audio, input

- Two tones are hard-panned (right-only, left-only): a portable two-voice
  note API is by construction stereo-split here; document, don't hide.
  Noise and sample DMA are the other two "voices". Envelopes are the
  length counters plus software on the timer IRQ.
- Poll `$2020` once per frame after `waitFrame()`; polarity per the
  notes is active-low — verify against MAME before writing `input`.

### Profiles

`SUPERVISION_PROFILES`: `32k` (default; flat ROM), `64k`, `128k` (banked;
the number is `__cart_rom_size`). Nothing else varies for the program;
the board revision matters only to an emulator's LCD timing.

## Where things live

```
~/.local/opt/llvm-mos/bin/mos-supervision-clang        driver: 32K/64K/128K cartridge image + .elf
~/.local/opt/llvm-mos/mos-platform/supervision/include/supervision.h   the whole register map, VRAM geometry, SDK helpers
~/.local/opt/llvm-mos/mos-platform/supervision/lib/link.ld             __cart_rom_size, bank sections, vectors
~/.local/opt/llvm-mos/mos-platform/supervision/lib/crt0.o              sei / control ← 0 / main; .nmi section
packages/supervision/                                  (future) target package: VRAM bitmap text, DMA fills
packages/backend-6502/src/index.mjs                    (future) SUPERVISION_PROFILES (__cart_rom_size), FRAME_SYNC.supervision (timer IRQ or NMI, not vsync)
packages/cli/src/run.mjs                               (future) mame svision -cart <file> -str N -video none -sound none
docs/roadmap.md                                        Phase 6: the Supervision in the target list
```
