---
"@8bitscript/cli": patch
---

Fixed the VIC-20 wasm preview drawing every character with square pixels — reported live as looking "more normal" than a real VIC-20's own visibly wide, stretched text. Measured from the 6560's own timing (14.31818MHz clock, 3.5 clocks per pixel, 702 clocks and 252 of 261 lines drawn per frame): a real NTSC VIC-20 draws each pixel about 5/3 (1.667) times wider than tall, cross-checked against the VIC-20 community's own long-established approximation for this exact number.

`web-loader.mjs`'s `fit()` now stretches the canvas's displayed size by this measured pixel aspect ratio, never its real pixel buffer — every offset the renderer already computes in real, square chip-pixels stays correct. Scoped to NTSC (`video.frameRate === 60`) only; PAL's 6561 runs different timing this project has not measured yet, so it keeps square pixels, an honest gap rather than a guess.
