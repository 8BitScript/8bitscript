---
"8bitscript-lang": patch
---

The launcher Run button no longer stays on the previous machine while a named system is still being applied.

`loadTargets` is a CLI spawn on first load, so two posts could overlap, and applying a named system writes the name before the machine. The label now takes the machine from that named system, drops a superseded post, and does not paint mid-`set()`.
