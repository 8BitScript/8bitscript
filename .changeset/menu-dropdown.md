---
"@8bitscript/ui": minor
"@8bitscript/studio": minor
---

`@8bitscript/ui/menu`: the drop-down — one column of entries under a bar item, the same immediate-mode contract as the bar (`begin`/`item`/`end`, `next`/`previous`/`select`/`deselect`, `point`/`pointed`), rows drawn edge to edge with the lit one inverted, and `clear()` to take it off the screen; `menubar.itemAt(i)` says where to put it. Studio uses both: its bar is the mark, FILE and the three editors (one EDIT menu on 22 columns), its menus open under keys, a stick, a pad or a mouse, and every entry opens a screen that shows what the machine has for that editor — the characters screen drawing the portable character set — and says plainly that nothing edits, plays or loads yet. Studio names the X16 as its baseline and a mouse as its primary input, builds for all nine machines again (the 8K VIC-20 and the 32K PET as its defaults; a stock VIC-20 and a 4K PET cannot hold the desk), and its tests build every target and drive the desk on the web build.
