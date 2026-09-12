---
"@8bitscript/cli": minor
---

A program that changes the machine's character set now hands it back the way it found it. `8bitscript.config.ts` gains `restoreOnExit`, on by default: the prologue copies the PET's VIA PCR to the CPU stack and the epilogue writes it back, so a machine is returned in whichever mode it was launched in rather than a fixed one. It costs eight bytes and no RAM, and only a program whose finished code actually stores to `$E84C` pays them — which, since `@8bitscript/pet/text` no longer selects a character set at all (see that package's own note), means most programs pay nothing. `restoreOnExit: false` turns it off.

One thing it deliberately does not try to do: un-draw. The PET's character-set bit is a single switch for the whole screen and it is retroactive, so a program that means to both return the machine and leave a readable screen has to blank the screen before it returns.

The `hello-world` example no longer ends in a `while (true) waitFrame()` holding loop — it prints and returns, landing back in the BASIC `SYS` that started it. Its project file is also now named `8bitscript.config.ts`, the name the toolchain has preferred since 0.4.0.
