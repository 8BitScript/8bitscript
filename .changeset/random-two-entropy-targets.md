---
"@8bitscript/random": patch
---

Correct the header of `@8bitscript/random`'s default generator: it still
described the Atari 8-bit as "the one target that does have hardware entropy
behind its own import today," which stopped being true when
`@8bitscript/c64/random` (SID voice 3's noise oscillator) landed. There are
two, and the header now names both alongside POKEY's counter.

Comments only — no change to the generator, its constants, or its output on
any target. `packages/random/README.md` already listed both correctly; this
brings the source header into line with it.
