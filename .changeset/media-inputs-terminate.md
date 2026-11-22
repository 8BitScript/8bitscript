---
'@8bitscript/compiler': patch
'@8bitscript/graphics-tools': patch
'@8bitscript/audio-tools': patch
---

Three media inputs that made the toolchain loop forever now finish. `sliceFrames` with a frame width or height of 0 returns no frames, a WAV with zero channels throws "WAV has zero channels", and an `order { 5 }` list in a song stops at the first token that is not a name and reports it.
