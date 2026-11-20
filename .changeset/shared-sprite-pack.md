---
'@8bitscript/graphics-tools': minor
'@8bitscript/cx16': patch
'@8bitscript/web': patch
---

The 4bpp sprite packing (legal sizes, the 12-bit palette and the linear frames) the cx16 and web media lowerings share now lives once in `@8bitscript/graphics-tools/sprite-pack`. The cx16 output is byte for byte unchanged.
