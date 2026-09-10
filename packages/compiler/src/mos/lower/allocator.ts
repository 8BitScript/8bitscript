// A bump allocator over one contiguous zero-page range, with LIFO release.
//
// A function's locals and an expression's own temporaries turn out to be
// the same problem: "reserve some bytes, use them, give them back the
// moment nothing after this point can still need them." A local's mark is
// held for its whole enclosing block; a binop's mark is held only while
// that one sub-expression evaluates — but both are exactly a stack push and
// pop over the same budget, so one allocator serves both, nested however
// deep the real program nests. (See the roadmap's milestone-6 box: `zp/
// index.ts`'s own `allocate()` is right for globals — assigned once, never
// reused — but wrong for this, which is why this is a new, small class
// rather than a reuse of that one.)
export class ZpBudgetError extends Error {}

function hex(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(4, '0')}`;
}

export class LocalAllocator {
  private readonly origin: number;
  private readonly ceiling: number;
  private next: number;
  private high: number;

  constructor(origin: number, ceiling: number) {
    this.origin = origin;
    this.ceiling = ceiling;
    this.next = origin;
    this.high = origin;
  }

  /** A point in time to release back to later. */
  mark(): number {
    return this.next;
  }

  /** Frees everything allocated since `mark` — the corresponding scope or sub-expression is done with it. */
  release(mark: number): void {
    this.next = mark;
  }

  /** One byte, live until the caller releases back to a mark taken before this call. Throws ZpBudgetError, naming what didn't fit and what's left, when the budget is exhausted. */
  alloc(what: string): number {
    return this.allocBytes(1, what);
  }

  /** Two adjacent bytes (little-endian: `address` is the low byte, `address + 1` the high byte) for a 16-bit value — a `(zp),Y` pointer or any other 2-byte value needs this guarantee, not two separate `alloc()` calls whose adjacency would only ever be true by accident of this being a bump allocator. Throws ZpBudgetError, naming what didn't fit and what's left, when fewer than 2 bytes remain. */
  alloc16(what: string): number {
    return this.allocBytes(2, what);
  }

  private allocBytes(size: 1 | 2, what: string): number {
    if (this.next + size > this.ceiling) {
      const remaining = this.ceiling - this.next;
      throw new ZpBudgetError(
        `${what} needs ${size} byte${size === 1 ? '' : '(s)'} of zero page but only ${remaining} byte(s) remain (${hex(this.next)}..${hex(this.ceiling - 1)})`,
      );
    }
    const address = this.next;
    this.next += size;
    this.high = Math.max(this.high, this.next);
    return address;
  }

  /** The most zero page ever live at once — what the linker needs to reserve, not just what's held at the end. */
  get used(): number {
    return this.high - this.origin;
  }
}
