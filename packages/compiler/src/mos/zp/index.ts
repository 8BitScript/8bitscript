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
// No array ever reaches this allocator as of 0.2.2: a const array is
// read-only program data (mos/data.ts, alongside the string table), and a
// mutable array/string<N> buffer now rides in that same data section too —
// a loaded .prg's image is ordinary RAM on these machines, so the array's
// bytes sit inside the program, initialized by the load itself. Neither is
// a zero-page concern, so this function skips both rather than assigning
// an address nothing will use.
import { storageBytes } from '../../types/index.mjs';

/** The parts of a real IR global (packages/compiler/src/ir/index.mjs) this allocator reads. */
export interface IrGlobal {
  name: string;
  type: string;
  address: number | null;
  array?: number;
  constant?: boolean;
  /** A scalar global's own initial value (always a plain number, defaulting to 0 when the source gave none — ir/index.mjs's own scalar-global lowering), or a const array's elements (also always plain numbers by the time this reaches a backend: linker/index.mjs resolves every initializer, namespaceConst references included, before handing globals over). mos/index.ts's own global-init pass and mos/data.ts are what actually read this; this allocator only reads `array`/`constant` to decide whether to skip a global entirely. */
  init?: number | number[] | null;
}

export interface ZpHole {
  /** Inclusive. */
  start: number;
  /** Exclusive. */
  end: number;
}

export interface Budget {
  zpOrigin: number;
  /** Exclusive: the first address no longer in budget. */
  zpCeiling: number;
  /** Inclusive-exclusive ranges this allocator must not occupy (BASIC 1's CHRGET at $C2-$D9 on the original PET 2001). */
  holes?: ZpHole[];
}

export type PlaceZpResult =
  | { ok: true; address: number; next: number }
  | { ok: false; remaining: number; cursor: number };

/**
 * Next free address of `size` bytes that does not overlap any hole.
 * Skips a hole entirely rather than straddling it (a 16-bit slot at $C1
 * would put its high byte inside BASIC 1's CHRGET).
 */
export function placeZp(cursor: number, size: number, ceiling: number, holes: ZpHole[] = []): PlaceZpResult {
  let addr = cursor;
  for (;;) {
    const hole = holes.find((h) => addr < h.end && addr + size > h.start);
    if (hole) {
      addr = hole.end;
      continue;
    }
    if (addr + size > ceiling) {
      return { ok: false, remaining: Math.max(0, ceiling - addr), cursor: addr };
    }
    return { ok: true, address: addr, next: addr + size };
  }
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
      // Const AND mutable arrays alike (string<N> buffers included — they
      // arrive as mutable utinyint arrays, ir/index.mjs's stringGlobal)
      // live in the data section (mos/index.ts + mos/data.ts), never zero
      // page: a loaded .prg's own image IS RAM on these machines, so a
      // mutable array's bytes ride inside it, initialized by the load
      // itself (0.2.2 — closing the "isn't allocated yet" refusal that
      // stood here through 0.2.1).
      continue;
    }
    if (global.type === 'string') {
      // Never actually produced by the front end today (ir/index.mjs's
      // stringGlobal() either inlines a const string via ir.consts, never
      // reaching a global at all, or refuses a bare `let x: string;` for
      // lacking a capacity) — kept as defense against a shape nothing here
      // has a placement rule for, the same discipline as the unknown-type
      // case just below.
      return { ok: false, error: `global '${global.name}': a bare string global isn't allocated yet` };
    }

    const size = storageBytes(global.type);
    if (size === 0) {
      return { ok: false, error: `global '${global.name}': unknown type '${global.type}', can't size it` };
    }

    const placed = placeZp(zpNext, size, budget.zpCeiling, budget.holes);
    if (!placed.ok) {
      return {
        ok: false,
        error: `global '${global.name}' needs ${size} byte(s) of zero page but only ${placed.remaining} byte(s) remain ($${hex(placed.cursor)}..$${hex(budget.zpCeiling - 1)})`,
      };
    }

    allocated.push({ name: global.name, address: placed.address, storage: 'zp', size });
    zpNext = placed.next;
  }

  return { ok: true, globals: allocated, zpUsed: zpNext - budget.zpOrigin };
}
