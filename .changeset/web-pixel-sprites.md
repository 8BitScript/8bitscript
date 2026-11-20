---
'@8bitscript/web': minor
'@8bitscript/graphics': minor
'@8bitscript/cx16': patch
'@8bitscript/cli': patch
---

A `.8bg` picture on the web is now a 4bpp pixel sprite the page draws, in its own colours, instead of one 8x8 glyph in a single ink. The build sizes it: the new web options `sprites` (0, 8, 16, 32, 64 or 128 slots, default 16) and `spriteMemory` (0 to 32 KiB of shared frame memory, default 16) set `video.sprites` and `video.spriteKib`, and `8bs build --hardware sprites=32,spriteMemory=24` picks them. Sprites are up to 64x64 with 15 colours, move a pixel at a time, restore what they cover and are transparent. A picture past the last slot, or frames past the pool, are cut and named with `8BS2111`. `8bs build --target cx16 --web` draws pictures the same way with 128 slots and a 32 KiB pool; native cx16 is unchanged at 8 VERA sprites.
