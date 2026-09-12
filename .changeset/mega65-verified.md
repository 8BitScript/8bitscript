---
"@8bitscript/compiler": minor
"@8bitscript/cli": minor
"@8bitscript/mega65": patch
---

The MEGA65 builds, runs and is no longer parked — and two bugs in its package are fixed.

Getting it on screen at all took cracking Xemu's onboarding screen, which waits for a keypress and so hung every headless run. The cause is upstream: Hyppo reads its config sector from absolute LBA 1 of the SD image, while Xemu only ever writes one at syspart+1, so the onboarding-complete byte was never set. Writing a valid config sector at LBA 1 of `mega65.img` — `$0E = $80` being the byte that matters — makes `xmega65 -headless -besure -prgmode 65 -prg … -screenshot …` work. That is emulator state, not repo state, and it is recorded here because the next person will hit it too.

What that revealed, neither of which any build could have shown:

- **Lower case drew as graphics.** `text.8bs` mapped only 64-95 and pinned `$D018` to the upper-case set, so lower-case ASCII passed straight through into the graphics range: hello-world drew `H`, four blobs, ` W`, four more blobs, `!`. It now selects the mixed-case set (`$26`, measured: screen codes `08 05 0C 0C 0F` render as `hello`, `48 45 4C 4C 4F` as `HELLO`) and maps `97`-`122` down by 96, which is what every other Commodore in this workspace does and what `packages/pet/src/text.8bs` argues at length. This reverses a deliberate choice recorded in that file — that `TICK` should read as `TICK` the way it does on the NES and the X16 — because a text package that silently changes the text is answering a different question than the one it was asked.
- **Colour RAM was left mapped over the CIAs.** `prepare()` set CRAM2K (`$D030` bit 0) so the 80-column screen's cells 1024-1999 could be coloured, and never cleared it — leaving colour RAM in front of `$DC00`-`$DFFF`, where the CIAs are. `@8bitscript/mega65/input`'s `poll()` then scanned the keyboard matrix through colour cells and invented key presses out of whatever the screen held: in 2048 a phantom LEFT slid the board and spawned a third tile before the player touched anything. Its writes went astray too, landing in colour cells 1024-1027. Every text entry point now hands the CIAs back. The file's own note — "the frame runtime polls `$D012`, not a CIA, so nothing here misses them" — had overlooked `poll()` in the same package.

Measured under xmega65: hello-world **256 bytes**, printing `Hello World!`; 2048 **3645 bytes**, drawing its board with exactly the two starting tiles its own generator predicts, at the indices the C64 build puts them.
