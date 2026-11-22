# @8bitscript/cpc

## 0.26.1

### Patch Changes

- c4a7477: Every .8bs and .8bx source in the packages is converted to the new Rust-style syntax by `8bs migrate`, and each `8bitscript.config.8bs` is renamed to `8bitscript.config.ts`. The c64 character ROM generator now writes the new const array form.
- 302c8d2: Every hardware catalog now declares video.spriteKib, the KiB of the shared pool sprite pictures are drawn from (32 on the Commander X16, 0 where there is none), and the system package exposes it as Video::SPRITE_KIB. Nothing reads it yet.

## 0.25.0

### Minor Changes

- 5065779: `raster.frame()` and `raster.FRAME_COUNTER`: a count of video frames since `enable()`, wrapping at 256, so a raster effect can step once per frame however long the game loop takes. It counts on the C64 (the handler's line-0 pass) and the X16 (the end of each pass over the planned lines): 6 and 8 more bytes in a program that uses the raster list. Every other rasterline file answers `FRAME_COUNTER` false and `frame()` 0 — the VIC-20 and the PET run no interrupt, and the web host runs one logical frame per `waitFrame()` and never skips one — at no cost to a program that does not call it.

## 0.23.0

### Minor Changes

- 499c62d: Land the remaining roadmap machines: MOS packages (Plus/4 through Atari 7800), SM83/Z80/6809/8048/F8 backends, `port.read`/`port.write`, and catalog-driven emulators. Hello-world compiles for every `RELEASE_MACHINES` id; `8bs run plus4` is VICE; the other remaining machines are deferred pending emulator setup. `--screenshot` still captures on those machines (VICE, MAME `-str`, openMSX Tcl, or macOS window capture); a missing emulator or ROM set fails the capture. New ids use RetroArch-style shorts (`gb`, `gbc`, `pce`, `spectrum`); Atari consoles stay `atari2600`, `atari5200`, `atari7800`; `gamegear` stays.
