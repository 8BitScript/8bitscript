---
"@8bitscript/compiler": patch
"@8bitscript/language-server": patch
"8bitscript-lang": patch
---

The editor knows `#package(...)`: hovering it explains the fields it reads
and the diagnostics it refuses with, completion after `#` offers it next to
`#frames`, `#system` and `#fact`, and a `#package` snippet expands to the
`const VERSION: string = #package("version")` a title screen wants.
