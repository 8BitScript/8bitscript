---
"@8bitscript/compiler": patch
---

A C64 program that draws once and ends now keeps what it drew.

`setupVideo()` banks the KERNAL out and puts the picture at `$E000`, so `RTS` from `main()` snapped VIC back to `$0400` and hello-world showed stock `READY.` The C64 image `endsByHalting` (`JMP` to itself, 3 bytes), the same flag Atari already uses. A PET or VIC-20 still returns to BASIC.
