---
"@8bitscript/compiler": patch
"@8bitscript/pet": patch
---

Fix PET programs crashing on the first interrupt after they start.

The PET's zero-page budget began at `$8E`, on the reasoning that BASIC owns `$0002-$008D` and everything above it is free. It is not: the KERNAL owns the top of that page, and unlike the C64 and VIC-20 — which keep theirs at `$0314-$0319` — the PET keeps its interrupt vectors in it, `$90/$91` IRQ, `$92/$93` BRK, `$94/$95` NMI.

So a program with three bytes of globals overwrote the IRQ vector, and the next vertical retrace — within a frame of its first store — jumped through whatever it had put there. Every PET program carrying a graphics or sprite component died this way, `hello-world` and `hello-bx` included; how much of the screen it had drawn first depended only on where in the frame the interrupt landed, which is why it looked like a black screen one run and a half-drawn one the next.

A PET program that returns to BASIC now borrows the zero page it uses and gives it back: interrupts off, the bytes it will touch copied into its own image, copied back before the `rts`. That makes the whole page available to it — and the page it hands back the one BASIC left. It costs 28 bytes of code plus one image byte per byte borrowed, and a program with no variables at all pays nothing. A `waitFrame()` program is unchanged: it has already taken the machine and keeps the page.
