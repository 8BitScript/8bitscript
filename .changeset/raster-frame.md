---
"@8bitscript/apple2": minor
"@8bitscript/atari2600": minor
"@8bitscript/atari5200": minor
"@8bitscript/atari7800": minor
"@8bitscript/atari8": minor
"@8bitscript/bbc": minor
"@8bitscript/c128": minor
"@8bitscript/c64": minor
"@8bitscript/channelf": minor
"@8bitscript/coco": minor
"@8bitscript/coleco": minor
"@8bitscript/cpc": minor
"@8bitscript/cx16": minor
"@8bitscript/gamegear": minor
"@8bitscript/gb": minor
"@8bitscript/gbc": minor
"@8bitscript/lynx": minor
"@8bitscript/mega65": minor
"@8bitscript/msx": minor
"@8bitscript/nes": minor
"@8bitscript/odyssey2": minor
"@8bitscript/oric": minor
"@8bitscript/pce": minor
"@8bitscript/pet": minor
"@8bitscript/plus4": minor
"@8bitscript/raster": minor
"@8bitscript/sg1000": minor
"@8bitscript/sms": minor
"@8bitscript/spectrum": minor
"@8bitscript/supervision": minor
"@8bitscript/vectrex": minor
"@8bitscript/vic20": minor
"@8bitscript/web": minor
---

`raster.frame()` and `raster.FRAME_COUNTER`: a count of video frames since `enable()`, wrapping at 256, so a raster effect can step once per frame however long the game loop takes. It counts on the C64 (the handler's line-0 pass) and the X16 (the end of each pass over the planned lines): 6 and 8 more bytes in a program that uses the raster list. Every other rasterline file answers `FRAME_COUNTER` false and `frame()` 0 — the VIC-20 and the PET run no interrupt, and the web host runs one logical frame per `waitFrame()` and never skips one — at no cost to a program that does not call it.
