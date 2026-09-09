// The linker: placement policy over already-encoded content, nothing more.
// No program lowering happens here (that starts at milestone 4) — this
// module answers exactly one question, given fixed-size pieces already
// produced elsewhere (raw startup bytes today; an assembled program's
// `code`/`data` from milestone 4 on): where does everything land, does it
// fit under the machine's RAM ceiling, and what is every symbol's final
// address.
//
// Every 6502 instruction's length is fixed by its addressing mode alone
// (asm/encode.ts's own header makes the same point), so a section's size
// never depends on where it's placed — code, then data, then bss, one
// after another with no gaps, is exact on the first pass. `zp` lives in a
// completely separate address range and is placed independently of the
// other three.
import { assembleRelaxed } from '../asm/relax.ts';
import type { Directive } from '../asm/assemble.ts';

export type SectionContent =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'assembly'; program: Directive[] };

/** An address fixed by hardware or convention (a KERNAL routine, …) — outside every section, checked for overlap with one. */
export interface PinnedSymbol {
  name: string;
  address: number;
}

export interface LinkInput {
  /** Where the code section starts — the BASIC stub's own SYS target, from basicStub(). */
  codeOrigin: number;
  /** The absolute top of RAM, exclusive: code + data + bss must all land below it. */
  ramCeiling: number;
  code: SectionContent;
  /** Placed right after code. */
  data?: SectionContent;
  /** Reserved, uninitialized bytes right after data — nothing allocates into it until a later milestone. */
  bss?: number;
  /** Where the zp section starts. Only meaningful when `zp` reserves space. */
  zpOrigin?: number;
  /** Reserved zero-page bytes, placed at `zpOrigin`. Nothing allocates into it here — that is milestone 5's job. */
  zp?: number;
  /**
   * The real usable zero-page budget on a PET that returns to BASIC is an
   * open decision (see the roadmap's DECISIONS) — 0x100, the hardware
   * limit, until milestone 5 settles it.
   */
  zpCeiling?: number;
  pinned?: PinnedSymbol[];
}

export interface SectionLayout {
  name: 'code' | 'data' | 'bss' | 'zp';
  origin: number;
  size: number;
}

export type LinkResult =
  | { ok: true; bytes: Uint8Array; symbols: Map<string, number>; layout: SectionLayout[]; memory: { variables: number; program: number } }
  | { ok: false; error: string };

function hex(value: number, digits = 4): string {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}

/** Assembles `content` at `origin`, or just hands back already-final bytes. Either way: bytes, and the labels they define. */
function place(
  content: SectionContent,
  origin: number,
  section: string,
): { ok: true; bytes: Uint8Array; symbols: Map<string, number> } | { ok: false; error: string } {
  if (content.kind === 'bytes') return { ok: true, bytes: content.bytes, symbols: new Map() };
  // assembleRelaxed, not assemble directly: milestone 6's control flow is
  // the first source of branches this backend emits, and some of them
  // (a loop body over 127 bytes) won't fit a plain relative branch. Every
  // section that assembles gets the long-branch fixup for free from here.
  const result = assembleRelaxed(content.program, origin);
  if (!result.ok) return { ok: false, error: `${section}: ${result.error}` };
  return { ok: true, bytes: result.bytes, symbols: result.labels };
}

const EMPTY: SectionContent = { kind: 'bytes', bytes: new Uint8Array(0) };

/** Places code, data, bss, and zp; checks every ceiling; merges every symbol. Deterministic: same input, same layout, every time. */
export function link(input: LinkInput): LinkResult {
  const code = place(input.code, input.codeOrigin, 'code');
  if (!code.ok) return code;
  const codeEnd = input.codeOrigin + code.bytes.length;

  const dataOrigin = codeEnd;
  const data = place(input.data ?? EMPTY, dataOrigin, 'data');
  if (!data.ok) return data;
  const dataEnd = dataOrigin + data.bytes.length;

  const bssOrigin = dataEnd;
  const bssSize = input.bss ?? 0;
  const bssEnd = bssOrigin + bssSize;

  let over: { section: 'code' | 'data' | 'bss'; end: number } | null = null;
  if (codeEnd > input.ramCeiling) over = { section: 'code', end: codeEnd };
  else if (dataEnd > input.ramCeiling) over = { section: 'data', end: dataEnd };
  else if (bssEnd > input.ramCeiling) over = { section: 'bss', end: bssEnd };
  if (over) {
    return {
      ok: false,
      error: `${over.section}: program ends at $${hex(over.end)}, ${over.end - input.ramCeiling} byte(s) past the $${hex(input.ramCeiling)} RAM ceiling`,
    };
  }

  const zpOrigin = input.zpOrigin ?? 0x02;
  const zpSize = input.zp ?? 0;
  const zpCeiling = input.zpCeiling ?? 0x100;
  const zpEnd = zpOrigin + zpSize;
  if (zpEnd > zpCeiling) {
    return {
      ok: false,
      error: `zp: reserves up to $${hex(zpEnd)}, ${zpEnd - zpCeiling} byte(s) past the $${hex(zpCeiling)} zero-page ceiling`,
    };
  }

  const layout: SectionLayout[] = [
    { name: 'code', origin: input.codeOrigin, size: code.bytes.length },
    { name: 'data', origin: dataOrigin, size: data.bytes.length },
    { name: 'bss', origin: bssOrigin, size: bssSize },
    { name: 'zp', origin: zpOrigin, size: zpSize },
  ];

  const symbols = new Map<string, number>();
  for (const [name, address] of code.symbols) symbols.set(name, address);
  for (const [name, address] of data.symbols) {
    if (symbols.has(name)) return { ok: false, error: `data: label '${name}' is already defined in code` };
    symbols.set(name, address);
  }

  for (const { name, address } of input.pinned ?? []) {
    const placed = layout.find((s) => s.size > 0 && address >= s.origin && address < s.origin + s.size);
    if (placed) {
      return {
        ok: false,
        error: `pinned symbol '${name}' at $${hex(address)} falls inside the ${placed.name} section ($${hex(placed.origin)}-$${hex(placed.origin + placed.size - 1)})`,
      };
    }
    if (symbols.has(name)) return { ok: false, error: `pinned symbol '${name}' collides with a label of the same name` };
    symbols.set(name, address);
  }

  const bytes = new Uint8Array(code.bytes.length + data.bytes.length);
  bytes.set(code.bytes, 0);
  bytes.set(data.bytes, code.bytes.length);

  return {
    ok: true,
    bytes,
    symbols,
    layout,
    memory: { variables: bssSize + zpSize, program: bytes.length },
  };
}
