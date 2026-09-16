---
"@8bitscript/ui": patch
---

`menubar.8bx` imports the menu bar it wraps by file (`./menubar.8bs`),
not by the package's own name — a package cannot depend on itself, and
the package's test said so.
