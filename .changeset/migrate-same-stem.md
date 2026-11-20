---
'@8bitscript/cli': patch
---

`8bs migrate` keeps the string path (`use "./menubar.8bs"::menubar;`) for an import whose module stem exists under more than one source extension, because `use self::menubar::...` is ambiguous there (8BS2217).
