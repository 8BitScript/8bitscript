---
'@8bitscript/cli': patch
'@8bitscript/language-server': patch
'8bitscript-lang': patch
---

A project config loads from a read-only directory: when the temporary copy cannot be written, the `.ts` config is imported directly, and the error names both failures if that fails too. The old-name config warning now clears once the file is renamed, so a later regression warns again.
