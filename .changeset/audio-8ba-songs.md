---
"@8bitscript/audio": minor
"@8bitscript/compiler": minor
"@8bitscript/c64": minor
"@8bitscript/vic20": minor
"@8bitscript/pet": minor
"@8bitscript/cx16": minor
"@8bitscript/web": minor
"8bitscript-lang": patch
---

A `.8ba` song is now a sound effect you can write, and play: `instrument` takes `volume` (0..15) and `decay` (frames), a `song` takes `loop false` (a one-shot), and a row takes `length` (rows the note sounds) and `volume`. `audio.play(song)` plays it once and leaves the voice silent; `audio.music(song)` repeats one that loops; `audio.busy()` says whether anything is sounding; `audio.silence()` stops a song as well as a tone. Every sample and song in a program has its own handle (the linker counts across files; before, two files each bound to slot 0), held in one 255-byte bank shared by the C64, VIC-20, PET, X16 and web drivers (`8BS2216` when a program binds more). The web gets a song player, and the editor grammar and snippets know the new fields.
