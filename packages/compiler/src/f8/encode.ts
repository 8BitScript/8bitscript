import type { IsaEncode, Op } from '../isa/ops.ts';

/** Fairchild F8: accumulator plus 64-byte scratchpad. Ports via INS/OUTS. */
export const F8: IsaEncode = {
  encode(ops) {
    const bytes: number[] = [];
    const labels = new Map<string, number>();
    const holes: { at: number; name: string }[] = [];
    const emit = (...b: number[]) => { bytes.push(...b); };
    for (const op of ops) {
      switch (op.kind) {
        case 'label': labels.set(op.name, bytes.length); break;
        case 'loadImm':
          if ((op.value & 0xff) < 16) emit(0x70 | (op.value & 0x0f)); // LIS
          else emit(0x20, op.value & 0xff); // LI
          break;
        case 'loadAbs': emit(0x0a); break; // LM via DC0 — DC0 is not set yet
        case 'storeAbs': emit(0x0b); break; // ST
        case 'addAbs': emit(0x0a, 0x24); break; // LM; AS
        case 'subAbs': emit(0x0a, 0x25); break;
        case 'cmpImm': emit(0x21, op.value & 0xff); break; // CI
        case 'cmpAbs': emit(0x0a, 0x21, 0x00); break;
        case 'jump': emit(0x29); holes.push({ at: bytes.length, name: op.name }); emit(0); break; // BR? JMP is 29
        case 'jumpZ': emit(0x84); holes.push({ at: bytes.length, name: op.name }); emit(0); break; // BZ
        case 'jumpNZ': emit(0x8c); holes.push({ at: bytes.length, name: op.name }); emit(0); break;
        case 'jumpLT':
        case 'jumpC': emit(0x82); holes.push({ at: bytes.length, name: op.name }); emit(0); break;
        case 'jumpGE':
        case 'jumpNC': emit(0x8a); holes.push({ at: bytes.length, name: op.name }); emit(0); break;
        case 'call': emit(0x28); holes.push({ at: bytes.length, name: op.name }); emit(0); break; // PI
        case 'ret': emit(0x1c); break; // POP
        case 'halt': emit(0x2b, 0xfe); break; // BR *
        case 'waitFrame': emit(0x2b, 0x00); break; // BR +0
        case 'out': emit(0xb0 | (op.port & 0x0f)); break; // OUTS
        case 'in': emit(0xa0 | (op.port & 0x0f)); break; // INS
        default: return { ok: false, error: `F8 cannot encode ${(op as Op).kind}` };
      }
    }
    const buf = new Uint8Array(bytes);
    for (const hole of holes) {
      const target = labels.get(hole.name);
      if (target === undefined) return { ok: false, error: `unresolved label '${hole.name}'` };
      buf[hole.at] = (target - hole.at - 1) & 0xff;
    }
    return { ok: true, bytes: buf };
  },
};
