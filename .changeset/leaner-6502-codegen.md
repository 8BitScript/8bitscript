---
"@8bitscript/compiler": patch
---

The 6502 backend now emits substantially smaller — and never slower —
code, measured on the real 2048 game: 4005 bytes of program down to 2930
(27%), which is what lets it fit a stock 4K PET 2001. The wins, each
strictly fewer bytes *and* fewer cycles: comparisons and `+`/`-`/bitwise
operands that are constants or plain variables are read directly by
CMP/ADC/SBC/AND/ORA/EOR instead of bouncing through a zero-page temp;
`x == 0`/`x != 0` branch straight off the load's own Z flag when that's
provably sound; `i = i + 1` is INC (and `- 1` DEC); a constant loop
condition (`while (true)`) emits no test; 16-bit constants, string-label
addresses, and 16-bit sums store straight into their destination pair
instead of through a temporary; array indexes that are constants or plain
variables load Y directly; a jump to the very next address (a function's
final `return`) is deleted; a reload of a value the accumulator provably
still holds is deleted; and global initializers share one LDA per distinct
value.
