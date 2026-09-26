---
"@8bitscript/examples": patch
---

Take the shared media out of `hello-world` and `hello-bx`, which had no frame to drive it.

Both kinds needed one. `audio.play()` arms a voice and it is `audio.update()`, counted down over the following eight frames, that releases it again — so a program calling `update()` once before returning to BASIC left the voice gated on, and the machine went on sounding it after the program had ended. On the C64 that is a held noise waveform, which is what `chime`'s declared `fallback { synth noise }` resolves to on every machine in this release, since none of them play a PCM sample. `graphics.place()` is the same shape: on every machine but the VIC-20 it records where an object goes and leaves the drawing to the next update, which for these two never came — so `mark` cost its whole sprite pipeline and drew nothing.

Measured, that was most of the program. `hello-world` on the release PET goes 1944 → **108** bytes, on the C64 2230 → **393**, on the VIC-20 1999 → **188**. The greeting was always the only thing on screen; now it is the only thing in the binary.

`generate-shared-assets.mjs` writes `mark.*` and `chime.*` into the four examples with a `waitFrame()` loop — `fancy`, `swarm`, `joystick`, `media-walk` — and into neither of these two. The 8BX zero-cost gate still compares `hello-bx` against `hello-world` byte for byte; they remain the same program written two ways, which is why the media had to leave both together.
