---
"@8bitscript/compiler": patch
---

A function with one live call site is written into it — whatever its
size, whatever its arguments. The body replaces the call, the argument
stores, the frame and the `rts`, so the program can only get smaller:
a read of the caller's own local is the read itself, a global or an
expression is a local holding it (the store the call already made),
and a non-void callee whose only `return` ends it is hoisted ahead of
the statement that used its value. 2048's tile split into two lib
primitives and an element (`paintTile` + `stampValue` + `Tile`, #51)
was +56 bytes on every 6502 and +84 on the PET 2001 against the
one-body `drawTile`; it is now the same size, on the PET and on the
web.

Bodies are optimized callees-first, so the size that decides whether a
small body is pasted at several sites is the size it has with its own
callees in it. 2048's parameterless `Board`, small as written, went
into `main` three times carrying the whole inlined `ScoreBar` (+393
bytes on the PET, #52); measured finished, it is one function.

2048 (#53) on every native target: PET 2001 2759 → 2687, VIC-20
3486 → 3400, C64 4595 → 4495, C128 3684 → 3594, Atari 8-bit 3716 →
3599, X16 4429 → 4317, MEGA65 3659 → 3569 bytes of program; the NES
image is its fixed size. Zero page moves by −7 to +9 (a callee's locals
that a sibling's frame used to overlay are the caller's now). Examples:
hello-world 108 and hello-bx 108 unchanged, fancy 1007 → 999, joystick
2305 → 2273.

Still a call: a void body with a `return` anywhere (the `f(); return;`
idiom), a non-void body with an early return, `asm6502`, and a body
whose free names a caller's own local would capture.
