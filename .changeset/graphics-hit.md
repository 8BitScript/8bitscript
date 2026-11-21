---
"@8bitscript/graphics": minor
"@8bitscript/compiler": minor
---

Add `graphics::hit(a, b)` and `graphics::hitAny(a)`, a sprite hit check that gives the same answer on every machine. Each sprite has one box, worked out when the picture is compiled from the pixels that are not clear, and two sprites hit when their boxes overlap at the positions the last `place` gave them.
