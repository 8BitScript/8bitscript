---
title: Fairchild Channel F
nav_order: 52
---

# Writing Channel F support for 8BitScript

This file is for anyone — human or agent — adding the `channelf` target
(roadmap phase 10). Nothing here builds. Read
[`docs/roadmap.md`](../../roadmap.md) first.

> **A Fairchild F8, which is an 8-bit CPU, and 64 bytes of scratchpad
> RAM inside that CPU. The picture is a write-only framebuffer. There
> is no second CPU family hiding in the console.**

## What exists today

Nothing. There is no F8 backend, no `packages/channelf`, no emulator
flag, and no setup command.

## Facts read for this note

Wikipedia's
[Fairchild Channel F](https://en.wikipedia.org/wiki/Fairchild_Channel_F)
article, fetched 2026-09-22. Secondary; a Fairchild F8 datasheet is the
source to read next.

| Fact | Where |
| ---- | ----- |
| CPU: Fairchild F8, called 8-bit on the article's specification list, at 1.7897725 MHz NTSC (colorburst / 2). PAL speeds are listed separately. | Wikipedia technical section |
| The CPU contains 64 bytes of scratchpad RAM. A working F8 needs the CPU plus program-storage chips; the Channel F has one CPU and two of those. | Wikipedia, F8 section |
| The framebuffer is described as write-only, 128×64, with about 104×60 of that visible, one background color per line and three plot colors. | Wikipedia, same section |

The System II is the same CPU in a later case. It is not a separate
target. How its memory map differs is *to verify*.

## The sixteen questions

The CPU class and the scratchpad size are the part this note actually
read. The F8 instruction set, the port map, controller encoding, sound,
cartridge banking, frame timing, and an emulator with a headless
screenshot are not researched.

## Where things live

```
docs/roadmap.md                     Phase 10: an F8 backend with one machine on it
```
