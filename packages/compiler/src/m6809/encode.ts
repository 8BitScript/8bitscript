import type { IsaEncode, Op } from '../isa/ops.ts';
import { write16 } from '../isa/ops.ts';

export const M6809: IsaEncode = {
  encode(ops, origin) {
    type Hole = { at: number; name: string; rel: boolean };
    const bytes: number[] = [];
    const labels = new Map<string, number>();
    const holes: Hole[] = [];
    const emit = (...b: number[]) => { bytes.push(...b); };
    const ext = (op: number, addr: number) => emit(op, (addr >>> 8) & 0xff, addr & 0xff);
    for (const op of ops) {
      switch (op.kind) {
        case 'label': labels.set(op.name, bytes.length); break;
        case 'loadImm': emit(0x86, op.value & 0xff); break;
        case 'loadAbs': ext(0xb6, op.address); break;
        case 'storeAbs': ext(0xb7, op.address); break;
        case 'addAbs': ext(0xbb, op.address); break;
        case 'subAbs': ext(0xb0, op.address); break;
        case 'cmpImm': emit(0x81, op.value & 0xff); break;
        case 'cmpAbs': ext(0xb1, op.address); break;
        case 'jump': emit(0x7e); holes.push({ at: bytes.length, name: op.name, rel: false }); emit(0, 0); break;
        case 'jumpZ': emit(0x27); holes.push({ at: bytes.length, name: op.name, rel: true }); emit(0); break;
        case 'jumpNZ': emit(0x26); holes.push({ at: bytes.length, name: op.name, rel: true }); emit(0); break;
        case 'jumpLT': emit(0x25); holes.push({ at: bytes.length, name: op.name, rel: true }); emit(0); break;
        case 'jumpGE': emit(0x24); holes.push({ at: bytes.length, name: op.name, rel: true }); emit(0); break;
        case 'jumpC': emit(0x25); holes.push({ at: bytes.length, name: op.name, rel: true }); emit(0); break;
        case 'jumpNC': emit(0x24); holes.push({ at: bytes.length, name: op.name, rel: true }); emit(0); break;
        case 'call': emit(0xbd); holes.push({ at: bytes.length, name: op.name, rel: false }); emit(0, 0); break;
        case 'ret': emit(0x39); break;
        case 'halt': emit(0x20, 0xfe); break; // BRA *
        case 'waitFrame': emit(0x12); break; // NOP
        case 'out':
        case 'in':
          return { ok: false, error: 'the 6809 has no port I/O; use memory-mapped registers' };
        default: return { ok: false, error: `6809 cannot encode ${(op as Op).kind}` };
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
