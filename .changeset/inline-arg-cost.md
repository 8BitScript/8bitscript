---
"@8bitscript/compiler": patch
---

The inliner weighs a call's arguments as the code they are — a load and a
store at every copy — so a small body that only passes values along stays
one function instead of being written out at every site (2048's board:
54 bytes pasted three times where the call and its body cost 31). And
`optimizeReachable` folds and prunes twice: a helper whose other callers
fold away (the animated move, on a machine without the RAM for it) is
now inlined into the one caller left. Every example builds to the same
bytes as before.
