---
"@8bitscript/compiler": patch
"@8bitscript/cli": patch
---

Fixes two bugs vegas-nights found.

**An array of more than 128 two-byte elements read and wrote the wrong element.** The 6502 backend doubled the index in A (`ASL`) and handed it to Y, which drops the carry, so element 185 of an `array<usmallint, 200>` landed on element 57 (the 80-column PET 8032's marquee ring wrote its places 128 and up over places 0 and up, silently). An array of more than 128 elements now builds the byte offset in 16 bits and goes through a zero-page pointer, a constant index past element 127 folds its doubled offset into the address, and a `usmallint` index into such an array is written instead of refused. An array of 128 elements or fewer, and every byte array (up to 256 elements), keep exactly the code they had: all 30 builds of the six examples on c64, pet, vic20, cx16 and web are byte for byte the same size. The long form costs about 42 bytes of code for one read plus one write (measured on the C64), and 4 bytes of zero-page temporaries. Pinned by tests of the emitted code, and under xpet and x64sc by `packages/pet/test/array-wide.test.mjs` and `packages/c64/test/array-wide.test.mjs`.

**`8bs run --help` launched the emulator.** A `--help` or `-h` after a command was passed to the command as an unknown argument, so `8bs run pet --help` built the project and opened xpet. Every command now prints its own usage (just its own block, `build` both of its) and exits 0 before anything is built or launched; an unknown command with `--help` is still an unknown command.
