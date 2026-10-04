---
"@8bitscript/pet": minor
"@8bitscript/graphics": minor
"@8bitscript/compiler": patch
---

`@8bitscript/graphics` animates on the PET: every frame a `.8bg` animation names becomes its own quadrant-block shape, defined once before `main()`, and `graphics.update()` steps through them at the animation's `every`, as on the C64. The sprite layer's seven shapes are one budget for the whole program, counted across `.8bg` files; the build warns (`8BS2111`) when a picture is cut short or finds none left, and the program shows exactly that. A picture too faint to survive the downsample is now a small centre block rather than a stray solid block, and a picture with transparent pixels takes its shape from them (white pixel art on a clear background is a white shape, as on the C64) instead of losing every bright pixel.

Two compiler fixes that were not PET-only: two `.8bg` files that each held one sprite both claimed slot 0, so one drew as the other (`graphics.place` of the second picture showed the first); slots are now numbered across the whole program. And the media bind functions run in declaration order, not reversed.
