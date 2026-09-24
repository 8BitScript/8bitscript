---
title: Fairchild Channel F
nav_order: 52
---

# Writing Channel F support for 8BitScript

This file is for anyone — human or agent — touching `packages/channelf`
and the F8 backend.

> **A Fairchild F8 and 64 bytes of scratchpad inside the CPU.** The
> picture is a write-only 128×64 framebuffer (about 104×60 visible).
> There is no second CPU family in the console.

## What exists today

An F8 backend and `packages/channelf`. Ports use `INS`/`OUTS`.
Emulator: MAME `channelf`.

## Facts verified here

| Fact | Where |
| ---- | ----- |
| F8 at colorburst/2 = 1.79 MHz NTSC. 3850 CPU + two 3851 PSUs = 2K BIOS (Hockey/Tennis + cart helpers). 64 scratchpad bytes, no other RAM except 8K × 2-bit screen (128×64). Four palettes via pixels 125/126 per line; eight colors total. | [Sean Riddle, Channel F specs](http://seanriddle.com/chanfspecs.html) |
| Scratchpad: 0–8 general, 9–15 save W/DC0/PC1/PC0, 16–63 six ISAR-addressed 8-byte buffers. First 12 directly addressed; all 64 via 6-bit ISAR. | [F8 Guide to Programming, 1980](https://bitsavers.trailing-edge.com/components/fairchild/f8/F387X_PEP/NS334-12-0003-107_F8_Guide_to_Programming_1980.pdf) |
| CPU ports: console buttons + right controller + three lines into screen RAM. PSU ports: left controller, screen RAM, sound. Carts are typically two PSUs (2K); some 3K/4K, Schach 6K. | Riddle specs |
| I/O instructions: `IN`/`INS`, `OUT`/`OUTS`. Ports commonly 0, 1, 4, 5. | F8 User's Guide |
| System II is the same CPU in a later case — not a second target. | Wikipedia Channel F, 2026-09-22 |

## The sixteen questions

CPU and scratchpad from the F8 manual. Framebuffer is write-only, not
a text grid. Controllers are not Atari sticks. No save. Image is a
cart ROM. `port.write` / `port.read` are the language form for
`OUTS`/`INS`.

## Where things live

```
packages/compiler/src/f8/           the backend
packages/channelf/                  catalog + stubs
docs/setup/channelf.md
```
