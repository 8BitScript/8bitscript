---
"@8bitscript/color": minor
"@8bitscript/c64": minor
"@8bitscript/pet": patch
"@8bitscript/vic20": patch
"@8bitscript/cx16": patch
"@8bitscript/web": patch
"@8bitscript/compiler": minor
---

A new portable package, `@8bitscript/color`, for the C64 demoscene's "more than 16 colours" trick: `color.blend(slot, a, b)` alternates a border or background color between two palette indices once a frame, riding on `@8bitscript/raster`'s own list, so a CRT's phosphor persistence blends them into a shade neither shows alone. Real on the C64; an honest, documented no-op on the PET (no color chip), the VIC-20 (the technique is unconfirmed on real hardware, not disproven — left unimplemented rather than assumed), the CX16 (VERA's 256-entry software palette makes the trick unnecessary — define the color directly instead), and the web (no CRT persistence to exploit, so alternating a color there would be visible flicker, not a blend). Gated by a new build-time fact, `#fact(video.colorBlend)`, filled in across every machine catalog (true only for the C64).
