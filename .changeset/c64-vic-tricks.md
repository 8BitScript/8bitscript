---
"@8bitscript/c64": minor
"@8bitscript/compiler": minor
---

C64: the VIC-II's opened border, idle graphics and sprite multiplexing, on a reworked raster list.

- `@8bitscript/c64/border`: `border.top()`/`bottom()` add the `$D011` entries that open the upper and lower border for sprites (RSEL cleared at 249 after the VIC's line-247 comparison, restored at 47 + YSCROLL), with `setShort()` for a 24-row base.
- `@8bitscript/c64/idle`: the ghost byte. In VIC bank 3 the idle-graphics byte `$3FFF` is `$FFFF`, the IRQ vector's high byte, and the raster handler's page used to draw as stripes in the gap a YSCROLL other than 3 opens; `raster.s` now routes the IRQ through a trampoline at `$FD` (the compiler's C64 zero-page budget ends there), so `$FFFF` is 0 and idle graphics are transparent in every program. `idle.setPattern()` writes the ECM byte `$F9FF` (block 231's pad byte) for a chosen pattern in an opened border, and `raster.at(line, idle.PATTERN, bits)` changes it per line.
- `@8bitscript/c64/multiplex`: up to 24 virtual sprites from the eight — sorted by Y each frame, the eight topmost through the list's frame table, the rest as list entries at the earliest line each hardware sprite is free.
- `@8bitscript/c64/raster`: the list is double-buffered (`commit()`; `enable()` commits), takes out-of-order entries (`insert()`), carries a frame table of sprite registers the handler writes at the end of every pass (`setFrameByte()`, `Frame.*`), ends its pass at line 255 whatever the last entry's line, and applies a late entry at once instead of losing the frame. `setValue()`/`addressOf()` work on the live list. The REU probe byte moved from `$033C` to `$03FF`.
