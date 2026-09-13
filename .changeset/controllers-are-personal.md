---
"@8bitscript/cli": patch
"8bitscript-lang": patch
---

Controller profiles live in `~/.config/8bitscript/`, not the project. An 8BitDo at one desk is not a `systems` block.

Gamepad API button numbers are not written into VICE `.vjm` files — they are the browser's indices, not SDL's, and `!CLEAR` plus those numbers is how a working pad went dead the moment a profile appeared. FCEUX `--input1 gamepad` (the help text) is not what UpdateInput() matches — that is `GamePad.0`; lowercase `gamepad` is SI_NONE, an empty NES port, and it persists into `~/.fceux/fceux.cfg`.
