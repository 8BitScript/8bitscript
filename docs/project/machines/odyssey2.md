---
title: Magnavox Odyssey² / Philips Videopac
nav_order: 51
---

# Writing Odyssey² / Videopac support for 8BitScript

This file is for anyone — human or agent — touching `packages/odyssey2`
and the 8048 backend. One target covers the Magnavox Odyssey², the
Philips Odyssey², and the Videopac G7000.

> **An Intel 8048 and one custom chip, the 8244/8245, that draws the
> picture and makes the sound.** There is no second CPU in the console.
> The chess module's NSC800 is a cartridge, not this target.

## What exists today

An 8048 backend and `packages/odyssey2`. External VDC access is
`MOVX` after selecting the chip. Emulator: MAME `odyssey2`.

## Facts verified here

| Fact | Where |
| ---- | ----- |
| CPU: Intel 8048, 5.37 MHz NTSC / 5.91 MHz PAL. 64 bytes inside the CPU, 128 bytes outside, 1024 bytes of ROM inside the CPU. | Wikipedia technical section, 2026-09-22 |
| Picture and sound: Intel 8244 (NTSC) or 8245 (PAL). | Same |
| VDC selected with P13 low, P14 high, then `MOVX`. Registers `$00–$FF`, mirrored `$Ax`/`$Bx`. | [Daniel Boris, Odyssey 2 Technical Specs](https://atarihq.com/danb/files/o2doc.pdf) |
| VDCSTAT `$A1`: bit 0 HBLANK, bit 1 strobe, bit 2 sound empty, bit 3 VBLANK pulse, bit 6 external overlap, bit 7 character overlap. Bits 3 and 7 clear on read. | Boris spec; [kevtris timing](http://blog.kevtris.org/blogfiles/odyssey2_timing.txt) |
| VDC control `$A0`. Grid `$C0–$C8`, `$D0–$D8`, `$E0–$E9`. Four single characters, quads, four sprites. Change objects in VBLANK. | Boris spec |
| HBLANK and VBLANK are OR'd onto 8048 T1. BIOS copies a RAM table into VDC registers at VSYNC when `iram_irqctrl` bit 7 is set. | [G7000 BIOS notes](https://www.videopac.nl/g7kbios.pdf); kevtris |
| Emulator: MAME `odyssey2` or O2EM. BIOS is user-supplied; doctor WARNs. | Catalog |

## The sixteen questions

CPU, RAM, VDC register file, input (keyboard + two sticks), no save,
frame = VDCSTAT bit 3 / T1, image is a ROM the 8048 maps from `$0400`.
Sprites are four 8×8 objects plus characters and a background grid —
not a NES nametable.

## Where things live

```
packages/compiler/src/i8048/        the backend
packages/odyssey2/                  catalog + stubs
docs/setup/odyssey2.md
```
