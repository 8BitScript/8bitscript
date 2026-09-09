// The startup routine every Commodore .prg's BASIC stub SYS's into.
//
// Milestone 1 has no instruction selection yet (that starts at milestone
// 4), so there is no program body to run into and nothing to set up before
// it — the routine is just RTS. main() returning to nothing is exactly
// right for an empty program: control lands back in BASIC's SYS, which
// prints READY. the same as any BASIC program falling off its own end.
// Once lowering exists (milestone 4 on), this grows into the real
// prologue/epilogue around the lowered body, still shared by the C64 and
// VIC-20 the way this file's name says it will be.

const RTS = 0x60;

export function startupBytes(): Uint8Array {
  return new Uint8Array([RTS]);
}
