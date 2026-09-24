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
