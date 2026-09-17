---
title: "Standard packages"
nav_order: 7
---

# Standard packages

## §6.1 Which package does what

| Package | Provides |
| --- | --- |
| `@8bitscript/screen` | Border and background colour, the same eight colour names on every target. |
| `@8bitscript/text` | The character grid — ASCII in, one cell at a time, identical on every target. |
| `@8bitscript/input` | Four directions, confirm, cancel, and a pointer where the machine has one. |
| `@8bitscript/random` | Deterministic, explicitly-seeded generators: a 16-bit LCG at the bare import, a precomputed table at `./table`. Hardware entropy lives behind its own machine-specific import. |
| `@8bitscript/raster` | Per-scanline effects named by what they do (a border split, a wobble) rather than which register to hit. `#fact(video.raster)` says whether this machine has a real implementation at all — the C64 and the web do today. |
| `@8bitscript/system` | One name per machine, for `#system()` ([§1.9](core.md#19-branch-on-the-machine-at-compile-time)). |
| `@8bitscript/ui` | Retained widgets built on the portable APIs — the menu bar ([§2.3](composition.md#23-accept-children-with-slot)) is the first dogfood target. |
| `@8bitscript/pet` · `vic20` · `c64` · `c128` · `atari8` · `nes` · `cx16` · `mega65` · `web` | The hardware underneath the portable APIs, one package per target — the compiler's own resolver picks the right one per build. |
