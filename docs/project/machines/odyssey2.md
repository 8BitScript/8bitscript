---
title: Magnavox Odyssey² / Philips Videopac
nav_order: 51
---

# Writing Odyssey² / Videopac support for 8BitScript

This file is for anyone — human or agent — adding the `odyssey2` target
(roadmap phase 10). Nothing here builds. The same console was sold as
the Magnavox Odyssey², the Philips Odyssey², and the Philips Videopac
G7000. One target covers those names. Read
[`docs/roadmap.md`](../../roadmap.md) first.

> **An Intel 8048 microcontroller and one custom chip, the 8244, that
> draws the picture and makes the sound. There is no second CPU in the
> console.**

## What exists today

Nothing. There is no 8048 backend, no `packages/odyssey2`, no emulator
flag, and no setup command.

## Facts read for this note

Wikipedia's
[Magnavox Odyssey²](https://en.wikipedia.org/wiki/Magnavox_Odyssey_2)
article, fetched 2026-09-22. Secondary; the Intel 8048 and 8244 data
sheets are the sources to read next, and every register-level claim is
*to verify* against them.

| Fact | Where |
| ---- | ----- |
| CPU: Intel 8048 8-bit microcontroller, listed at 5.37 MHz NTSC / 5.91 MHz PAL. | Wikipedia technical section |
| RAM: 64 bytes inside the CPU, 128 bytes outside it. 1024 bytes of ROM inside the CPU. | Wikipedia infobox and technical section |
| Picture and sound: one Intel 8244 (NTSC) or 8245 (PAL). | Wikipedia technical section |
| The C7010 chess module carries its own NSC800 and its own memory. | Wikipedia, chess-module note |

The chess module is a cartridge with a different processor. It is not
the `odyssey2` CPU and it is not a second target. Whether a program
built for the 8048 can see that module at all is *to verify*.

## The sixteen questions

The CPU class and the RAM sizes above are the part this note actually
read. The 8244's sprite model, the keyboard matrix, the joysticks, the
frame timing, the cartridge map, and an emulator with a headless
screenshot are not researched.

## Where things live

```
docs/roadmap.md                     Phase 10: an 8048 backend with one machine on it
```
