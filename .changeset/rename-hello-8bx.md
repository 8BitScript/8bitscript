---
"@8bitscript/examples": patch
---

Renamed the `hello-bx` example to `hello-8bx`, matching the actual name of the language feature it demonstrates (8BX, not "BX"). The manifest title changes from "Hello, BX" to "Hello, 8BX" to match; the entry file itself stays `hbx.8bs`, already shortened for CBM DOS's 16-character limit.

Also removed `src/hello-bx.8bs`, a stray byte-identical duplicate of `hbx.8bs` left behind and still tracked since that earlier rename — dead code, never referenced by `8bitscript.config.ts`.
