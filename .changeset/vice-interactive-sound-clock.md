---
"@8bitscript/cli": patch
---

`8bs run` keeps a muted VICE sound device open when the catalog said
`+sound` (no speaker). GTK3 with no audio clock paces from vsync alone
and stutters on Linux/Wayland; Pulse as a silent host clock does not.
Screenshots still pass `+sound -warp`.
