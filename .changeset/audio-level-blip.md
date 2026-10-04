---
"@8bitscript/audio": minor
"@8bitscript/cx16": minor
"@8bitscript/web": minor
---

`audio.setLevel(level)` sets the volume every tone plays at (0 silent to `audio.LEVEL_MAX`: 15 on the C64, VIC-20, X16 and web, 1 on the PET's one-bit speaker, 0 with no driver), and `audio.blip(note, frames)` is a plucked tone that dies away by itself: a SID envelope with no sustain, a volume walked down a frame at a time on the VIC-I, the PSG and the web. `tone` and `blip` now drop the SID gate first, so a note started on top of another retriggers. `psg.setVolume` and the web voice's `setLevel` / `volume` are the pieces underneath.
