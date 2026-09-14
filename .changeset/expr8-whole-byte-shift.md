---
"@8bitscript/compiler": patch
---

6502: narrowing a 16-bit value to 8 bits now reads only the byte that
survives, instead of building a 16-bit temporary and discarding half of it.

`expr8()` evaluated any 16-bit expression into a temporary pair and then took
its low byte, so the two ordinary ways of splitting a 16-bit value both paid
for both halves when only one was ever read:

- `x >> 8` (and any whole-byte shift) is now one load of the high half.
  `shift16()` already knew a whole-byte shift is a move rather than eight
  LSRs, but it still had to leave both halves behind because its caller might
  want them; the narrowing says nobody does. Shifts of 9-15 keep the leftover
  bits as `LSR A`; 16 or more is the constant 0.
- `x & C`, `x | C` and `x ^ C` have no carry between the halves, so narrowed
  they are the low bytes alone. A mask that cannot change the answer
  (`& 0xFF`, `| 0`, `^ 0`) emits no instruction at all.

`return` was spelling the same narrowing out a second time inline rather than
calling `expr8()`, so returned expressions missed all of it. It now calls
`expr8()`, which removes the duplication and picks up both fast paths.

Measured at 0.6.2: `hi = value >> 8` as a statement of its own drops from 19
bytes to 3, and 2048 loses 16 bytes on every 6502 target with no source change
(44 on the Commander X16, which has more such sites) — the 4K PET 2001 build
goes 2587 to 2571.

Note for anyone comparing hardware-entropy against software-PRNG byte counts:
this makes `@8bitscript/random`'s own `next()` 16 bytes cheaper (65 to 49), so
measurements taken before it understate the software generator.
