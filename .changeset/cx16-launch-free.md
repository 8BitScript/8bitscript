---
"@8bitscript/cx16": patch
"@8bitscript/cli": patch
---

`8bs run cx16` starts x16emu with your mouse free again (no `-capture`): the pointer can leave the window for the editor, and ⇧⌘M (Ctrl+M on Linux/Windows) captures it when tracking has to be exact — a click never does, so the launch says so once. Uncaptured tracking drifts a little; in use it is good enough, and the free pointer is worth more.
