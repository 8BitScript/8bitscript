---
"@8bitscript/compiler": patch
---

A forwarder costs nothing. A function or component whose body is exactly
one call passing its own parameters through — `component Tile(row, col,
exponent) { drawTile(row, col, exponent); }`, `function range(bound) {
return random.range(bound); }` — is now that call at every site, run-time
arguments and all, in any parameter order, across an import boundary. The
site already loads and stores each argument into a parameter slot;
pointing those stores at the callee's slots instead is free, and the
forwarder's own copies and its `jsr`/`rts` are gone. This is what spec
§30 and §64 promise an element costs, and it did not hold before: 2048's
`<Tile row col exponent />` and `<Hud />` wrappers were +36 bytes on the
PET 2001 and the unexpanded VIC-20 (2048 #49), the same across a module
boundary +53 (2048 #45), and a one-line `range()` delegate +8 on five
targets — all three are now byte-identical to the hand-written calls
(2048 with all three in: PET 2001 2807 → 2763, VIC-20 3534 → 3490).

Not a forwarder, and unchanged: a global passed through (each copy would
load it again), a parameter used twice, an expression around the call, a
body of two statements — so `f(); return;`, the idiom that keeps a
helper a real call, still does. A literal the forwarder adds is inlined
while the copies cost less than the parameter stores the sites stop
making; a forwarder that reorders or drops a parameter keeps the call
when the argument has a side effect. Examples unchanged (hello-world
108, hello-bx 108, fancy 1007, joystick 2305 on the PET).
