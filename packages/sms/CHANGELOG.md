# @8bitscript/sms

## 0.23.0

### Minor Changes

- 499c62d: Land the remaining roadmap machines: MOS packages (Plus/4 through Atari 7800), SM83/Z80/6809/8048/F8 backends, `port.read`/`port.write`, and catalog-driven emulators. Hello-world compiles for every `RELEASE_MACHINES` id; `8bs run plus4` is VICE; the other remaining machines are deferred pending emulator setup. `--screenshot` still captures on those machines (VICE, MAME `-str`, openMSX Tcl, or macOS window capture); a missing emulator or ROM set fails the capture. New ids use RetroArch-style shorts (`gb`, `gbc`, `pce`, `spectrum`); Atari consoles stay `atari2600`, `atari5200`, `atari7800`; `gamegear` stays.
