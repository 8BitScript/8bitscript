---
"@8bitscript/compiler": minor
---

Adds a verified per-instruction cycle-cost table for the mos backend's NMOS 6502 instruction set (`packages/compiler/src/mos/asm/cycles.ts`), cross-checked against the same published reference `encode.ts`'s own opcode table already cites. `instructionCycles(mnemonic, mode, crossesPage?)` gives a real instruction's cost, correctly modeling that a store or read-modify-write at an indexed address always pays the page-crossing cycle while a read only pays it when the address actually crosses; `branchCycles(taken, crossesPage)` covers the eight branch mnemonics, whose cost depends on their own outcome rather than their (always `relative`) addressing mode.

This is a building block, not yet wired into anything: the real prerequisite for cost-driven automatic loop unrolling (beyond today's manual `@unroll`) and for a future compile-time cycle-budget diagnostic, both scoped as follow-on work.
