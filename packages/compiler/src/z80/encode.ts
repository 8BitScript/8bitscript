import type { IsaEncode, Op } from '../isa/ops.ts';
import { write16 } from '../isa/ops.ts';

export const Z80: IsaEncode = {
  encode(ops, origin) {
    type Hole = { at: number; name: string; rel: boolean };
    const bytes: number[] = [];
    const labels = new Map<string, number>();
    const holes: Hole[] = [];
    const emit = (...b: number[]) => { bytes.push(...b); };
    for (const op of ops) {
      switch (op.kind) {
        case 'label': labels.set(op.name, bytes.length); break;
        case 'loadImm': emit(0x3e, op.value & 0xff); break;
        case 'loadAbs': emit(0x3a, op.address & 0xff, (op.address >>> 8) & 0xff); break;
        case 'storeAbs': emit(0x32, op.address & 0xff, (op.address >>> 8) & 0xff); break;
        case 'addAbs': emit(0x47, 0x3a, op.address & 0xff, (op.address >>> 8) & 0xff, 0x80); break;
        case 'subAbs': emit(0x4f, 0x3a, op.address & 0xff, (op.address >>> 8) & 0xff, 0x47, 0x79, 0x90); break;
        case 'cmpImm': emit(0xfe, op.value & 0xff); break;
        case 'cmpAbs': emit(0x4f, 0x3a, op.address & 0xff, (op.address >>> 8) & 0xff, 0x47, 0x79, 0xb8); break;
        case 'jump': emit(0xc3); holes.push({ at: bytes.length, name: op.name, rel: false }); emit(0, 0); break;
        case 'jumpZ': emit(0x28); holes.push({ at: bytes.length, name: op.name, rel: true }); emit(0); break;
        case 'jumpNZ': emit(0x20); holes.push({ at: bytes.length, name: op.name, rel: true }); emit(0); break;
        case 'jumpLT': emit(0x38); holes.push({ at: bytes.length, name: op.name, rel: true }); emit(0); break;
        case 'jumpGE': emit(0x30); holes.push({ at: bytes.length, name: op.name, rel: true }); emit(0); break;
        case 'jumpC': emit(0x38); holes.push({ at: bytes.length, name: op.name, rel: true }); emit(0); break;
        case 'jumpNC': emit(0x30); holes.push({ at: bytes.length, name: op.name, rel: true }); emit(0); break;
        case 'call': emit(0xcd); holes.push({ at: bytes.length, name: op.name, rel: false }); emit(0, 0); break;
        case 'ret': emit(0xc9); break;
        case 'halt': emit(0x76); break;
        case 'waitFrame': emit(0x00); break;
        case 'out': emit(0xd3, op.port & 0xff); break;
        case 'in': emit(0xdb, op.port & 0xff); break;
        default: return { ok: false, error: `z80 cannot encode ${(op as Op).kind}` };
      }
    }
    const buf = new Uint8Array(bytes);
    for (const hole of holes) {
      const target = labels.get(hole.name);
      if (target === undefined) return { ok: false, error: `unresolved label '${hole.name}'` };
      const dest = origin + target;
      if (hole.rel) {
        const next = origin + hole.at + 1;
        const off = dest - next;
        if (off < -128 || off > 127) return { ok: false, error: `branch '${hole.name}' is out of range` };
        buf[hole.at] = off & 0xff;
      } else {
        write16(buf, hole.at, dest);
      }
    }
    return { ok: true, bytes: buf };
  },
};
