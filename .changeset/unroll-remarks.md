---
"@8bitscript/compiler": minor
"@8bitscript/cli": minor
"@8bitscript/language-server": patch
---

`8bs build --remarks` returns and prints what the linker's optimizer actually did — today, every `@unroll`, as a `remark` severity diagnostic (`8BS9001`) naming the loop's unroll count. Off by default: a build that never asks for it is unchanged, and a remark is never counted as a problem or printed unless asked for.
