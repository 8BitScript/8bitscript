# @8bitscript/audio-tools

## 0.26.1

### Patch Changes

- 8283c8a: Three media inputs that made the toolchain loop forever now finish. `sliceFrames` with a frame width or height of 0 returns no frames, a WAV with zero channels throws "WAV has zero channels", and an `order { 5 }` list in a song stops at the first token that is not a name and reports it.

## 0.23.1

### Patch Changes

- 6a26f13: Spawn ffmpeg, target emulators, and the system browser opener by absolute path, and verify Studio webview message origins in the listener.

## 0.23.0

### Minor Changes

- 499c62d: Add a portable graphics and audio slice: `.8bg` / `.8ba` front ends, PNG and WAV/FLAC host tools, machine-owned lowering on C64, NES, PET, and Atari 8-bit with a glyph/no-driver fallback everywhere else, and a dogfood example that builds for every machine.
