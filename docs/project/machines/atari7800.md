---
title: Atari 7800
nav_order: 21
---

# Writing Atari 7800 support for 8BitScript

This file is for anyone — human or agent — touching `packages/atari7800`.
Read the root `AGENTS.md` first. The 7800 is a SALLY 6502 plus MARIA —
not the Atari 8-bit's ANTIC, and not the 2600's TIA picture.

> **MARIA draws from a Display List List, not a framebuffer.** Sprites
> are display-list objects packed into a 160- or 320-pixel line buffer.
> TIA sits beside it for sound (and optionally POKEY / YM2151 on the cart).

## What exists today

`packages/atari7800` builds a `.a78`/ROM image through the MOS backend.
`8bs run atari7800` launches MAME `a7800` when it is installed.
MARIA display-list construction is not a portable `text` grid yet —
the package's screen/text layers write a linear stub so Studio links.

## Facts verified here

| Fact | Where |
| ---- | ----- |
| MARIA registers occupy `$20–$3F`. MSTAT `$28` is read-only; bit 7 is VBLANK. VBLANK ends and DMA begins at raster 16. | [7800 Software Guide](https://atarihq.com/danb/files/7800%20Software%20Guide.pdf); [78map.txt](https://www.atarihq.com/danb/files/78map.txt) |
| DPPH `$2C` and DPPL `$30` are write-only pointers to the Display List List. CTRL `$3C` is write-only: color-kill, DMA mode, character width, border, Kangaroo (no transparency), read mode (160×2/4 vs 320A–D). DMA-off is the power-up state. Test DMA modes must not be used (they can damage hardware). | Same Software Guide / 78map.txt |
| CHARBASE `$34`, OFFSET `$38`. A DLL entry is three bytes: DLI/holey-DMA flags + OFFSET, then the Display List address. OFFSET+1 is the zone height. | [7800vid.txt](https://www.atarihq.com/danb/files/7800vid.txt); 8bitdev Software Guide |
| SALLY 6502C at 1.79 MHz NTSC / 1.77 MHz PAL. 4 KB RAM. TIA audio at the usual 2600 ports. | Reach sheet; Software Guide TIA overview |
| Emulator: MAME `a7800`. ROM sets are not redistributable. | MAME driver name |

## The sixteen questions

1. **CPU** — SALLY (6502C). MOS backend, decimal mode on.
2. **Memory** — 4 KB RAM. Cartridge ROM at `$8000` (32K image). No banking in the stock catalog.
3. **Display unit** — MARIA line buffer, 160 or 320 pixels wide, not a character cell.
4. **Text grid** — none on the chip. The portable layer pretends 20×12 so Studio links.
5. **Modes / color** — CTRL read-mode bits pick 160×2, 160×4, 320A–D. Palettes are MARIA color registers.
6. **Layers** — one MARIA picture plus TIA (unused for graphics here).
7. **Sprites** — display-list objects, not a fixed sprite count. Line-RAM budget is the real limit.
8. **Pseudo-pixels** — none.
9. **Audio** — TIA two voices; POKEY / YM2151 optional on the cart (not in the stock catalog).
10. **Input** — two joystick ports, no keyboard. Studio is a viewer.
11. **Storage** — cartridge only. `storage.save` is false.
12. **Timing** — poll MSTAT `$28` bit 7. `waitFrame()` uses that flag.
13. **Variants** — NTSC/PAL. Region is an emulator flag, not a separate target.
14. **Emulator** — MAME `a7800`. Optional. Doctor WARNs when missing.
15. **Image** — 32K cart with 6502 vectors at the top.
16. **Traps** — do not enable MARIA test DMA modes. Do not treat MARIA as ANTIC or TIA.

## Where things live

```
packages/atari7800/                 the package
packages/compiler/src/mos/          SALLY is a 6502
docs/setup/atari7800.md             emulator install
```
