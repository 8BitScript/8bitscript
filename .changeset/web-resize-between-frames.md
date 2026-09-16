---
"@8bitscript/cli": patch
---

On the web's resizable host, a window resize now re-grids the program
between frames: the page holds the measurement and applies it right
before releasing the next `waitFrame()`, once the program is waiting for
it — so `Video.columns()` never changes between two reads inside one
frame, and a program that redraws each frame simply follows the next
one. A program with no frame clock is re-gridded at once, as before.
