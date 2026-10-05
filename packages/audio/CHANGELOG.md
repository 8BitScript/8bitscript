# @8bitscript/audio

## 0.25.0

### Minor Changes

- 179c3f6: `audio.setLevel(level)` sets the volume every tone plays at (0 silent to `audio.LEVEL_MAX`: 15 on the C64, VIC-20, X16 and web, 1 on the PET's one-bit speaker, 0 with no driver), and `audio.blip(note, frames)` is a plucked tone that dies away by itself: a SID envelope with no sustain, a volume walked down a frame at a time on the VIC-I, the PSG and the web. `tone` and `blip` now drop the SID gate first, so a note started on top of another retriggers. `psg.setVolume` and the web voice's `setLevel` / `volume` are the pieces underneath.
- a45bd03: `audio.tone(note, frames)`, `audio.silence()`, and the constants `audio.NOTE_LOW` / `audio.NOTE_HIGH`: one portable tone for a game's bleeps, on the C64 (SID), VIC-20, PET (the VIA's CB2 wave), Commander X16 (VERA PSG) and the web (one Web Audio oscillator). A note is the `.8ba` index (C0 = 0, A4 = 57), a note outside a machine's range moves by whole octaves, and `frames` counts calls of `audio.update()`.
  
  Fixes: the X16's PSG played nothing (the volume byte carried no channel-enable bits, and the pitch fell as the note rose); the PET and VIC-20 pitch tables were about two octaves off the notes they were indexed by. All four are now measured headlessly: SID A4 440.0 Hz from the register dump, VIC-20 443.5 Hz, PET 441.0 Hz and X16 439.9 Hz from recorded WAVs.
  
  The web host gains four tone registers after the glyph table (`AUDIO_BASE`: 9032 on the Modern host) that the page plays through one oscillator; `audio.voices` is 1 on the web. A real browser tab was not available, so the sound itself is not heard: the register writes, the mapping and the page's oscillator driving are tested.

### Patch Changes

- Updated dependencies [179c3f6]
- Updated dependencies [a45bd03]
- Updated dependencies [0e0e928]
- Updated dependencies [29fff5f]
- Updated dependencies [4f425e1]
- Updated dependencies [ecb49c6]
- Updated dependencies [4f425e1]
- Updated dependencies [4a646ff]
- Updated dependencies [584b12c]
- Updated dependencies [b4bd7cd]
- Updated dependencies [8927961]
- Updated dependencies [40d5e91]
- Updated dependencies [7a866bc]
- Updated dependencies [88b2396]
- Updated dependencies [5065779]
- Updated dependencies [8d65b3a]
- Updated dependencies [52e8dee]
- Updated dependencies [17e8aac]
- Updated dependencies [2c79182]
- Updated dependencies [9dfc8ce]
- Updated dependencies [b591243]
- Updated dependencies [55bd004]
- Updated dependencies [b2cb568]
- Updated dependencies [6e1ca7a]
- Updated dependencies [af466c0]
- Updated dependencies [cad9700]
  - @8bitscript/cx16@0.25.0
  - @8bitscript/web@0.25.0
  - @8bitscript/c64@0.25.0
  - @8bitscript/pet@0.25.0
  - @8bitscript/atari8@0.25.0
  - @8bitscript/nes@0.25.0
  - @8bitscript/vic20@0.25.0
  - @8bitscript/system@0.25.0

## 0.23.2

### Patch Changes

- Updated dependencies [e80d067]
- Updated dependencies [daac931]
- Updated dependencies [0ff97c3]
- Updated dependencies [3824070]
- Updated dependencies [e80d067]
- Updated dependencies [4376f27]
- Updated dependencies [8a309f5]
- Updated dependencies [5a21549]
- Updated dependencies [e80d067]
- Updated dependencies [a988417]
  - @8bitscript/c64@0.24.0
  - @8bitscript/pet@0.24.0
  - @8bitscript/vic20@0.24.0
  - @8bitscript/cx16@0.24.0
  - @8bitscript/atari8@0.24.0
  - @8bitscript/nes@0.24.0
  - @8bitscript/system@0.24.0

## 0.23.1

### Patch Changes

- @8bitscript/atari8@0.23.1
  - @8bitscript/c64@0.23.1
  - @8bitscript/cx16@0.23.1
  - @8bitscript/nes@0.23.1
  - @8bitscript/pet@0.23.1
  - @8bitscript/system@0.23.1
  - @8bitscript/vic20@0.23.1

## 0.23.0

### Minor Changes

- 499c62d: Add a portable graphics and audio slice: `.8bg` / `.8ba` front ends, PNG and WAV/FLAC host tools, machine-owned lowering on C64, NES, PET, and Atari 8-bit with a glyph/no-driver fallback everywhere else, and a dogfood example that builds for every machine.

### Patch Changes

- Updated dependencies [499c62d]
- Updated dependencies [499c62d]
- Updated dependencies [499c62d]
  - @8bitscript/pet@0.23.0
  - @8bitscript/c64@0.23.0
  - @8bitscript/vic20@0.23.0
  - @8bitscript/cx16@0.23.0
  - @8bitscript/nes@0.23.0
  - @8bitscript/atari8@0.23.0
  - @8bitscript/system@0.23.0
