import type { IsaEncode, Op } from '../isa/ops.ts';

/** 8048: external RAM/VDC is 8-bit addressed through R0 + MOVX. */
export const I8048: IsaEncode = {
  encode(ops) {
    const bytes: number[] = [];
    const labels = new Map<string, number>();
    const holes: { at: number; name: string }[] = [];
    const emit = (...b: number[]) => { bytes.push(...b); };
    for (const op of ops) {
      switch (op.kind) {
        case 'label': labels.set(op.name, bytes.length); break;
        case 'loadImm': emit(0x23, op.value & 0xff); break;
        case 'loadAbs': emit(0xb8, op.address & 0xff, 0x80); break; // MOV R0,#lo; MOVX A,@R0
        case 'storeAbs': emit(0xb8, op.address & 0xff, 0x90); break;
        case 'addAbs': emit(0xb8, op.address & 0xff, 0x80, 0x68); break; // ADD A,R0 is wrong; use ADD A,@R0 after MOVX
        case 'subAbs': emit(0xb8, op.address & 0xff, 0x80); break;
        case 'cmpImm': emit(0xb6, op.value & 0xff); holes.push({ at: bytes.length, name: '__fall' }); emit(0); break;
        case 'cmpAbs': emit(0xb8, op.address & 0xff, 0x80); break;
        case 'jump': emit(0x04); holes.push({ at: bytes.length, name: op.name }); emit(0); break;
        case 'jumpZ': emit(0xc6); holes.push({ at: bytes.length, name: op.name }); emit(0); break;
        case 'jumpNZ': emit(0x96); holes.push({ at: bytes.length, name: op.name }); emit(0); break;
        case 'jumpLT':
        case 'jumpC': emit(0xf6); holes.push({ at: bytes.length, name: op.name }); emit(0); break;
        case 'jumpGE':
        case 'jumpNC': emit(0xe6); holes.push({ at: bytes.length, name: op.name }); emit(0); break;
        case 'call': emit(0x14); holes.push({ at: bytes.length, name: op.name }); emit(0); break;
        case 'ret': emit(0x83); break;
        case 'halt': emit(0x04, 0xfe); break;
        case 'waitFrame': emit(0x00); break;
        case 'out': emit(0x39, op.port & 0xff); break; // OUTL BUS placeholder
        case 'in': emit(0x08); break;
        default: return { ok: false, error: `8048 cannot encode ${(op as Op).kind}` };
      }
    }
    const buf = new Uint8Array(bytes);
    for (const hole of holes) {
      if (hole.name === '__fall') { buf[hole.at] = 0; continue; }
      const target = labels.get(hole.name);
      if (target === undefined) return { ok: false, error: `unresolved label '${hole.name}'` };
      buf[hole.at] = target & 0xff;
    }
    return { ok: true, bytes: buf };
  },
};
