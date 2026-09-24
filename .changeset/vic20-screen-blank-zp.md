---
"@8bitscript/compiler": patch
"@8bitscript/cli": patch
"@8bitscript/graphics": patch
---

Widen VIC-20 zero-page to the owned budget when a linked program calls `screen.blank()`, so title screens and media clears link without overrunning the polite KERNAL window.
