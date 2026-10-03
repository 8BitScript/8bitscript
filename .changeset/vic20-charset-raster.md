---
"@8bitscript/vic20": minor
---

`@8bitscript/raster` on the VIC-20 now answers `Slot.CHARSET`: `raster.CHARSET` is true, and an entry switches `$9005` between the upper-case/graphics ROM set (0) and the mixed-case set (1) at any picture line, mid-row included, keeping the build's own screen base. The store lands in the border between the two lines on both regions (measured windows in `packages/vic20/AGENTS.md`), the colour splits' timing is unchanged, and a list without CHARSET entries never changes `$9005`.
