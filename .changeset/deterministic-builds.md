---
"@8bitscript/compiler": patch
---

Make builds deterministic across directory order and repeated builds in one process: variant names in a diagnostic are listed in a fixed order, and generated label names restart with each build.
