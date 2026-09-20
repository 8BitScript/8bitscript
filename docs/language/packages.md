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
| `@8bitscript/i18n` | What the build's locale is like, at compile time: `Locale.DECIMAL` and `Locale.GROUP` as one file per locale inside the package, picked by `--locale`; a grouped number printed with them at `./number`; line padding at `./messages`; the project's message catalogs at `./catalog` (`src/i18n/<locale>.8bs`, folded and transliterated). |
| `@8bitscript/raster` | Per-scanline effects named by what they do (a border split, a wobble) rather than which register to hit; a list built between frames and handed over whole with `commit()`, `insert()` for an entry out of order, `STRIDE` for the bytes an entry takes. `#fact(video.raster)` says whether this machine has a real implementation at all — the C64 and the web do today. |
| `@8bitscript/sprites` | Moving objects — a position, a shape and a colour each, moved by index and drawn once a frame: hardware sprites reused down the frame on the C64 (twenty-four from eight, and through the opened border with `extend(true)`), quadrant-block objects at 4-pixel steps that restore what they cover on the PET, a glyph redrawn at a cell over `text` on every other machine. The limits are consts (`sprites.MAX`, `PER_LINE`, `STEP_X`, `RESTORES`, `EXTENDS`) a program folds on. The design is [docs/project/frame.md](../project/frame.md) and [docs/project/sprites.md](../project/sprites.md). |
| `@8bitscript/timeline` | Frame-counted cues — `at(f)`, `after(f)`, `between(a, b)`, `every(n)` over a counter the program ticks once a frame — the same pure code everywhere, so a showcase is a sequence rather than a loop. |
| `@8bitscript/system` | One name per machine, for `#system()` ([§1.9](core.md#19-branch-on-the-machine-at-compile-time)). |
| `@8bitscript/ui` | Interface components built on the portable APIs, one subpath each: `@8bitscript/ui/menubar` (the bar, [§2.3](composition.md#23-accept-children-with-slot)) and `@8bitscript/ui/menu` (the drop-down under an item). Immediate mode; no component reads input. |
| `@8bitscript/pet` · `vic20` · `c64` · `c128` · `atari8` · `nes` · `cx16` · `mega65` · `web` | The hardware underneath the portable APIs, one package per target — the compiler's own resolver picks the right one per build. |
