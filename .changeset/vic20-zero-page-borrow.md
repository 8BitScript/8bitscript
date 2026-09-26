---
"@8bitscript/compiler": patch
---

Fix VIC-20 programs handing BASIC back a zero page they had overwritten.

Owning the machine is two decisions — how much memory a program may take, and whether it hands the machine back — and on the VIC-20 they disagreed. Calling `screen.blank()` widened the budget from the polite `$F7-$FE` to the whole page and dropped the CHRGET hole with it, but nothing changed the exit shape: the program still returned to a live interpreter whose zero page it had just written over. Measured under xvic, one reaching about 120 bytes came back to a BASIC that could no longer parse a line — an endless `?error in 263` / `?formula too complex`, the allocation having walked into CHRGET at `$73-$8A` and the text pointer at `$7A/$7B`. This machine's sheet names no `memory.chrget`, so the hole that saves the PET from the same walk was never carved here either.

The C64 never had the problem because both of its halves agree: it takes the whole page *and* halts. The PET's returning shape agrees too, since it borrows the page and gives it back. The VIC-20 now takes that same bargain — the whole page under `sei`, copied back before the `rts` — so a program gets everything while it runs and BASIC gets everything back. Measured after a 130-byte program returns, CHRGET's own code is byte-identical to a machine that never ran one.

The `screen.blank()` escalation is gone with it, and `usesScreenBlank` with that: a program's memory model no longer changes because someone added a call.
