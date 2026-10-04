---
title: Screenshots
nav_order: 26
---

# Screenshots

`8bs run <target> --screenshot <file.png>` builds the program and
captures one still through that target's own emulator API. No
interactive window, no "grab my screen" tool.

`--frames` is a different unit on every machine — whatever that
emulator is counting. The default is the machine package's
`"8bitscript".emulator.defaultFrames`. Count past the machine's own
boot (BASIC banner, KERNAL autostart, NES reset), not just the frames
you want after that.

| Target | How | `--frames` counts |
| ------ | --- | ----------------- |
| vic20, c64, pet, c128, plus4 | VICE `-exitscreenshot` / `-limitcycles` | CPU cycles (default is generous-past-boot) |
| atari8, atari5200 | real window + macOS capture | frames at 60 Hz; macOS only |
| nes | FCEUX Lua `emu.frameadvance` | emulated frames |
| cx16 | `x16emu -gif` + ffmpeg last frame | frames at 60 Hz; needs `ffmpeg` |
| mega65 | Xemu `-screenshot` on exit | frames at 60 Hz |
| web | wasm host + rasterizer | `waitFrame()` calls |
| apple2, bbc, oric, lynx, atari7800, sg1000, coleco, supervision, odyssey2, channelf | MAME `-seconds_to_run` snapshot | seconds; needs the machine's ROM set |
| msx | openMSX Tcl `screenshot -raw` | frames at 60 Hz |
| atari2600, gb, gbc, sms, gamegear, pce, spectrum, cpc, coco, vectrex | real window + macOS capture | frames at 60 Hz; macOS only |

A missing emulator skips the test that would have captured it. A
present-but-broken emulator fails the capture.

## The wasm build's screenshot

`8bs run <machine> --web --screenshot <file.png>` captures the machine's **wasm
build** instead: run for `--frames` `waitFrame()` calls in Node's WebAssembly, then
painted by the same per-scanline compositor and memory map the editor's Editor tab
and the browser use. No emulator is needed, so it is how to see headlessly what a
program looks like where most people will run it. Add `--program <name>` for a
project with several programs.

## Does the wasm build look like the machine? `8bs conform`

```
8bs conform [<machine>...] [--program grid] [--frames 300] [--out dist/conform] [--strict-colour]
```

For `pet`, `vic20`, `c64` and `cx16` (the machines with both a native emulator and a
wasm build), `conform` builds a probe program twice — through the machine's
emulator and through the wasm backend — captures one frame of each and compares
them cell by cell. The `grid` probe draws four solid corner cells (they locate the
picture in each capture, whatever the emulator's border), the printable ASCII
ramp in normal and reverse video, and one cell per text colour, then holds still.

A cell whose **bitmap** differs is a *structure* difference and fails the run
(exit 1); a cell whose glyph agrees but whose **ink colour** differs by more than
`--colour-tolerance` (default 48 a channel) is a *colour* difference and warns,
unless `--strict-colour`. `<out>/grid-<machine>.diff.png` shows the native capture,
the wasm capture and the differing cells (red: structure; amber: colour). The
numbers each machine is known to get wrong are pinned in
`packages/<machine>/test/conform.test.mjs`, and
[`docs/project/wasm-primary.md`](../project/wasm-primary.md) says what they are.

It compares a settled text screen. It does not yet see sprites, bitmap or
multicolour modes, scrolling or raster timing.
