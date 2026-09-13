---
"8bitscript-lang": patch
---

A first Atari 8-bit run from the editor loads a disk `.xex`, not an 8K cartridge.

The launcher's "nothing chosen" fallback picks the smallest `memory.ram` on a **RAM-size** option — every value of it states that fact, the way the PET's `ram` and the VIC-20's memory do. An Atari cartridge value publishes 6400 because that is the RAM window a cart gets, a different program shape the native backend cannot build. Treating that number as "the tightest fit of the same machine" made a first `8bs run atari8` pass `--hardware media=cart8` and die. Pick Media → 8K cartridge on purpose and the compiler still refuses it by name.
