---
"@8bitscript/random": minor
---

`@8bitscript/random/entropy`: one import that is the machine's own
entropy source where it has one and the seeded generator everywhere
else. `entropy.begin()` claims SID voice 3 on the C64 (and is nothing
elsewhere), `entropy.tick()` steps the software generator once a frame
(and is nothing on hardware), `entropy.next()` and `entropy.range(bound)`
read the oscillator on the C64, POKEY's `RANDOM` on the Atari 8-bit, and
the 16-bit LCG on the other seven. The resolver's twin rule picks the file
— `src/entropy.c64.8bs` and `src/entropy.atari8.8bs` beside the portable
`src/entropy.8bs` — so a program opts in with the import and never names
a machine. The bare `@8bitscript/random` is unchanged: deterministic,
seeded, replayable, as the root AGENTS.md rule requires.

Extracted from 2048, whose three `rng.8bs` twins this replaces; all nine
of its builds are byte-identical before and after (2763 on the 4K PET
2001, 3490 on the unexpanded VIC-20, 4599 on the C64, 3720 on the Atari
8-bit). `range()` computes its own modulo rather than forwarding, which
measured +8 bytes a target the other way; a test keeps it so.
