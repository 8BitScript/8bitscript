// The first instruction-selection rule: a memoryWrite of a literal value to
// a literal address becomes LDA #value; STA address. Everything else in
// the IR's node-kind list (see the roadmap's PIPELINE section) has no rule
// yet — a kind with no rule fails the build naming the construct, the same
// exhaustive-with-error contract the front end already holds itself to.
// Growing this rule table one IR kind at a time, milestone by milestone, is
// the whole of milestones 4, 6, 7, and 8.
import type { Directive } from '../asm/assemble.ts';

/**
 * The parts of the real linked IR this milestone's rule table reads —
 * not the full shape. packages/compiler/src/ir/index.mjs has no exported
 * TypeScript types at all yet (it's plain JS, one JSDoc @typedef for the
 * top-level program only); individual node kinds like `memoryWrite` and
 * `const` are untyped object literals there. This is deliberately narrow
 * rather than a stand-in `unknown`: it names exactly the fields `lower()`
 * reads, and grows alongside the rule table, not ahead of it.
 */
export interface IrExpr {
  kind: string;
  value?: number;
  type?: string;
}

export interface IrStatement {
  kind: string;
  address?: IrExpr;
  value?: IrExpr;
}

export interface IrFunction {
  name: string;
  body: IrStatement[];
}

export interface IrProgram {
  entry: string;
  functions: IrFunction[];
}

export type LowerResult =
  | { ok: true; program: Directive[] }
  | { ok: false; error: string };

function immediate(value: number): Directive {
  return { kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'value', value } };
}

// $0000-$00FF is zero page on every 6502; STA there is the shorter 2-byte
// form the assembler already knows as 'zeropage' — nothing PET-specific
// about the cutoff itself, just the addressing mode's own real boundary.
function store(address: number): Directive {
  const mode = address <= 0xff ? 'zeropage' : 'absolute';
  return { kind: 'instruction', mnemonic: 'STA', mode, operand: { kind: 'value', value: address } };
}

function lowerMemoryWrite(statement: IrStatement): { ok: true; directives: Directive[] } | { ok: false; error: string } {
  const { address, value } = statement;
  if (!address || address.kind !== 'const') {
    return { ok: false, error: `memoryWrite: the address must be a literal for now (got '${address?.kind ?? 'nothing'}')` };
  }
  if (!value || value.kind !== 'const') {
    return { ok: false, error: `memoryWrite: the value must be a literal for now (got '${value?.kind ?? 'nothing'}')` };
  }
  return { ok: true, directives: [immediate(value.value!), store(address.value!)] };
}

/** Lowers one function's body to a straight-line program. No control flow, no calls — those are later milestones. */
export function lower(body: IrStatement[]): LowerResult {
  const program: Directive[] = [];
  for (const statement of body) {
    if (statement.kind === 'memoryWrite') {
      const result = lowerMemoryWrite(statement);
      if (!result.ok) return result;
      program.push(...result.directives);
      continue;
    }
    return { ok: false, error: `lower: no instruction-selection rule yet for '${statement.kind}' — it lands in a later milestone` };
  }
  return { ok: true, program };
}
