---
"@8bitscript/vic20": minor
"@8bitscript/compiler": minor
"@8bitscript/c64": minor
"@8bitscript/web": minor
---

The VIC-20 answers `#fact(video.raster)`: `@8bitscript/raster`'s `Slot.BORDER` and `Slot.BACKGROUND` split at any picture line, on NTSC and PAL, each split landing on its exact line and whole — the line above entirely in the old colors, the target entirely in the new — and still from frame to frame. The VIC raises no interrupt, so the frame runtime applies the list: `FRAME_SYNC.vic20.frameHook` names `vic20RasterFrame`, which `waitFrame()` calls after every frame edge. It re-syncs on `$9004` and the `$9003` bit-7 edge before every planned line and writes `$900F` twice — the border half inside the picture of the line above, the background half in the border after it — with per-region delays measured under xvic and no taken branch between the edge and either store. `commit()` works everything else out ahead of time (picture line to raster line through `$9001`, the pair to poll, the parity, same-line merging, both stores' bytes), and the list and plan live in the cassette buffer. A list built once and `enable()`d shows every frame; `setValue` is live without a commit. Entries closer than two lines are planned two lines apart; `Slot.SCROLL_X` is refused. What it costs is written down in `packages/vic20/AGENTS.md` ("Raster splits"): the frame belongs to the hook until the last planned line, and the layer is about 850 bytes (`examples/fancy` on the 8K build, 2803 → 3654).

The pruner keeps a machine's frame hook — which no program calls — when, and only when, a reachable function shares a global with it (`pruneUnreachable(ir, { frameHook })`, `frameHookWanted`), so a program that imports `@8bitscript/raster` and never commits a list, or whose raster branch a `#fact` folds away, is byte-identical to one without it. Frame hooks now work on level-kind machines as well as edge-kind ones.

Every rasterline layer gains `raster.FINE_SCROLL` — whether `Slot.SCROLL_X` entries are taken (true on the C64 and the web, false on the VIC-20 and in every stub) — so a wobble can fold away where only splits exist. `examples/fancy` uses it: the VIC-20 shows the colour bands without the wobble. `packages/vic20/AGENTS.md` also corrects a stale claim: a VIC-20 program that calls `waitFrame()` runs with interrupts off from start-up.
