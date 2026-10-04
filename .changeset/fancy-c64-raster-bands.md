---
"@8bitscript/examples": patch
"@8bitscript/c64": patch
---

`examples/fancy` has its colour bands and wobble back on the C64. Its per-frame `graphics.update()` rebuilds the C64 raster list (`raster.clear()`, the plan, `raster.commit()`), which erased the list the example builds once with `raster.at()`; it has done so since the four-pillars release added the Mark sprite. On the C64 the still sprite is now published once, before the list; every other machine is unchanged (byte-identical builds). A VICE pixel test and a CI-run source-shape test pin it, and the C64 notes now say what works with a raster list and sprites together and what does not exist yet.
