---
"@8bitscript/audio": minor
"@8bitscript/cx16": patch
"@8bitscript/web": minor
"@8bitscript/cli": minor
---

`audio.tone(note, frames)`, `audio.silence()`, and the constants `audio.NOTE_LOW` / `audio.NOTE_HIGH`: one portable tone for a game's bleeps, on the C64 (SID), VIC-20, PET (the VIA's CB2 wave), Commander X16 (VERA PSG) and the web (one Web Audio oscillator). A note is the `.8ba` index (C0 = 0, A4 = 57), a note outside a machine's range moves by whole octaves, and `frames` counts calls of `audio.update()`.

Fixes: the X16's PSG played nothing (the volume byte carried no channel-enable bits, and the pitch fell as the note rose); the PET and VIC-20 pitch tables were about two octaves off the notes they were indexed by. All four are now measured headlessly: SID A4 440.0 Hz from the register dump, VIC-20 443.5 Hz, PET 441.0 Hz and X16 439.9 Hz from recorded WAVs.

The web host gains four tone registers after the glyph table (`AUDIO_BASE`: 9032 on the Modern host) that the page plays through one oscillator; `audio.voices` is 1 on the web. A real browser tab was not available, so the sound itself is not heard: the register writes, the mapping and the page's oscillator driving are tested.
