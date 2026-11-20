---
'@8bitscript/cli': patch
'@8bitscript/compiler': patch
---

A web build whose sprite region, or whose own data, would run past 64 KiB now stops with a message saying how many bytes it needs, instead of producing a page that reads the wrong memory.
