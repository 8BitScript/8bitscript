// The zero-page allocator: every non-pinned global gets a fixed address,
// assigned once, in declaration order, never reused.
//
// The IR has no storage-class hint today — no "this global must live in
// zero page" flag, no "this one is fine anywhere in RAM" flag (confirmed
// by reading packages/compiler/src/ir/index.mjs and its own test fixtures:
// a global is just `{name, type, volatile, address, init, exported, ...}`,
// nothing more). Rather than invent a language feature this milestone
// doesn't need, every non-pinned *scalar* global is treated as wanting
// zero page — it is strictly better there (a 2-byte `STA zp` instead of a
// 3-byte `STA absolute`, see lower/index.ts's own cutoff) — and running out
// of zero page for one is the real, roadmap-mandated error case, not a
// silent fallback to regular RAM. A global already pinned by `@address(…)`
// (its `address` field is non-null) bypasses allocation entirely; that
// syntax and mechanism already exist in the front end today.
//
// Arrays and strings are refused by name, not silently mis-sized: every
// non-const array/string global in this repo today is a portable-UI
// concern (packages/ui/menubar.8bs's two `string<1>` fields) nothing on
// the PET's own critical path declares one, and string *storage* is
// explicitly milestone 9's job (the IR's length-prefixed string table
// becoming a data section) — allocating space for one here would be
// guessing at a shape that milestone hasn't settled yet.
import { storageBytes } from '../../types/index.mjs';

/** The parts of a real IR global (packages/compiler/src/ir/index.mjs) this allocator reads. */
export interface IrGlobal {
  name: string;
  type: string;
  address: number | null;
  array?: number;
}

export interface Budget {
  zpOrigin: number;
  /** Exclusive: the first address no longer in budget. */
  zpCeiling: number;
}

export type Storage = 'zp' | 'pinned';

export interface AllocatedGlobal {
  name: string;
  address: number;
  storage: Storage;
  size: number;
}

export type AllocateResult =
  | { ok: true; globals: AllocatedGlobal[]; zpUsed: number }
  | { ok: false; error: string };

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

/** Assigns every non-pinned scalar global a zero-page address; refuses arrays/strings/unknown types and zp overflow, naming the global each time. */
export function allocate(globals: IrGlobal[], budget: Budget): AllocateResult {
  const allocated: AllocatedGlobal[] = [];
  let zpNext = budget.zpOrigin;

  for (const global of globals) {
    if (global.address !== null) {
      allocated.push({ name: global.name, address: global.address, storage: 'pinned', size: 0 });
      continue;
    }

    if (global.array !== undefined) {
      return { ok: false, error: `global '${global.name}': array storage isn't allocated yet` };
    }
    if (global.type === 'string') {
      return { ok: false, error: `global '${global.name}': string storage isn't allocated yet — it lands at milestone 9` };
    }

    const size = storageBytes(global.type);
    if (size === 0) {
      return { ok: false, error: `global '${global.name}': unknown type '${global.type}', can't size it` };
    }

    if (zpNext + size > budget.zpCeiling) {
      const remaining = budget.zpCeiling - zpNext;
      return {
        ok: false,
        error: `global '${global.name}' needs ${size} byte(s) of zero page but only ${remaining} byte(s) remain ($${hex(zpNext)}..$${hex(budget.zpCeiling - 1)})`,
      };
    }

    allocated.push({ name: global.name, address: zpNext, storage: 'zp', size });
    zpNext += size;
  }

  return { ok: true, globals: allocated, zpUsed: zpNext - budget.zpOrigin };
}
