// Shared ops the new CPU backends lower IR onto. Each backend encodes these
// onto its own instruction set. Kept small on purpose: the probe program
// (globals, for, add, memory.write) and waitFrame() have to compile; the
// rest of the MOS lowerer is not copied here.

export type Op =
  | { kind: 'label'; name: string }
  | { kind: 'loadImm'; value: number }
  | { kind: 'loadAbs'; address: number }
  | { kind: 'storeAbs'; address: number }
  | { kind: 'addAbs'; address: number }
  | { kind: 'subAbs'; address: number }
  | { kind: 'cmpImm'; value: number }
  | { kind: 'cmpAbs'; address: number }
  | { kind: 'jump'; name: string }
  | { kind: 'jumpZ'; name: string }
  | { kind: 'jumpNZ'; name: string }
  | { kind: 'jumpC'; name: string }
  | { kind: 'jumpNC'; name: string }
  | { kind: 'jumpLT'; name: string }
  | { kind: 'jumpGE'; name: string }
  | { kind: 'call'; name: string }
  | { kind: 'ret' }
  | { kind: 'halt' }
  | { kind: 'waitFrame' }
  | { kind: 'out'; port: number }
  | { kind: 'in'; port: number };

export interface IsaEncode {
  encode(ops: Op[], origin: number): { ok: true; bytes: Uint8Array } | { ok: false; error: string };
}

export function write16(buf: Uint8Array, offset: number, value: number) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
}
