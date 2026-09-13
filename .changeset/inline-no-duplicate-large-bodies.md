---
"@8bitscript/compiler": patch
---

A body more than one place calls is no longer written out once per call site.

Inlining a void call removes the call, which is a win only while the body is smaller than the call it replaces — on the 6502 that is 3 bytes at each site plus one RTS. Past a few bytes, every extra call site pays the whole body again.

A parameterless function never reached that question. The linker's guards reject on *parameters*, so a no-argument void helper was inlined everywhere it appeared, at any size. `@8bitscript/input`'s `poll()` is 117 IR nodes — 182 bytes on the PET — and 2048 reaches it from four places: once from `begin()`, which primes the edge detector, and once per direction read in the game loop. The game carried four copies.

Bodies of eight IR nodes or fewer (about thirteen bytes, where a duplicated body and the call it replaces cost roughly the same) still inline at as many sites as they like. Only a body bigger than that, reached from more than one place, now stays a call. A single call site still inlines at any size — nothing is duplicated, so there is nothing to weigh.

2048, measured across every target it builds for:

| target | before | after | saved |
| --- | --- | --- | --- |
| PET 2001 (4K) | 2624 | 2420 | 204 (7.8%) |
| PET 4032 (32K) | 2931 | 2510 | 421 (14.4%) |
| VIC-20 | 3388 | 3123 | 265 (7.8%) |
| C64 | 4018 | 3477 | 541 (13.5%) |
| C128 | 3849 | 3318 | 531 (13.8%) |
| Atari 8-bit | 4206 | 3488 | 718 (17.1%) |
| Commander X16 | 4404 | 3907 | 497 (11.3%) |
| MEGA65 | 3869 | 3382 | 487 (12.6%) |
| web (wasm) | 3891 | 2745 | 1146 (29.5%) |
| NES | 40976 | 40976 | 0 — the `.nes` is 16 + 32768 PRG + 8192 CHR, a fixed ROM layout that code size does not move |

The joystick example drops 204 bytes on the PET and 264 on the C64. Hello World is byte-for-byte identical on every machine: nothing it calls is both large and called twice.

The 4K PET is where this is load-bearing. `8bitscript.config.ts` in 2048 records 2440 bytes from when that build was fitted; 0.6.0 had drifted to 2624 as `begin()` started priming the edge detector and the PET's text package began selecting a character set. It is now 2420, under the original figure, with 651 bytes of headroom below `$0FFF` rather than 447.
