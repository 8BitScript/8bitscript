// Instruction selection: linked IR in, a straight-line-or-branching 6502
// program out. Milestone 4 gave this file its one rule (`memoryWrite` of a
// literal to a literal address); milestone 6 added nine more —
// `binop` `unop` `assign` `local` `ref` `if` `while` `for` `break`
// `continue` `return` `block` — all restricted to 8-bit values. `*`/`/`/`%`
// (no hardware support to lower them onto yet) and signed ordering
// comparisons are still refused by name, the same exhaustive-with-error
// contract every earlier milestone already holds itself to: a construct
// with no rule fails the build naming exactly what it doesn't support yet,
// never silently.
//
// Every 8-bit value-producing rule below (`expr()`) leaves its result in
// the accumulator — "tree-walk codegen with zero-page temporaries first,"
// the roadmap's own settled decision. Operands are always evaluated in
// source order, left then right, even where the accumulator ends up
// holding the right operand (`emitOperands` below) — not because the
// language defines an evaluation order yet (nothing in M6 can have a side
// effect), but because getting this backwards now would be a silent trap
// the day M7 adds calls: a comparison's own left/right assembly trick can't
// safely swap which operand is evaluated first once evaluating one can
// affect the other.
//
// Milestone 8 adds a second, parallel value-producing path, `expr16()`, for
// exactly-2-byte values (`usmallint`/`smallint`): the accumulator is 8
// bits, so a 16-bit value can't live where `expr()`'s results do. Rather
// than rewrite every existing rule to return a location descriptor,
// `expr16()` leaves its result at a zero-page address it returns — either
// an existing binding's address (a `ref`, copied nowhere) or a fresh
// zp-pair temporary it allocates and fills (a `const` or a `binop`),
// exactly mirroring how `emitOperands` already copies an 8-bit left operand
// out of the accumulator into a temp before evaluating the right one. See
// mos/AGENTS.md for why this shape won over widening `expr()` itself.
// `expr()` stays 8-bit-only; callers that might see either width check
// `storageBytes(node.type)` themselves and call the right one.
import type { Directive as _AsmDirective } from '../asm/assemble.ts';
import type { AddressingMode } from '../asm/encode.ts';
import { storageBytes, resolveIntegerType } from '../../types/index.mjs';
import { LocalAllocator, ZpBudgetError } from './allocator.ts';
import { arrayLabel, stringLabel } from '../data.ts';

export type Directive = _AsmDirective;

/**
 * The parts of the real linked IR this milestone's rule table reads — not
 * the full shape. packages/compiler/src/ir/index.mjs has no exported
 * TypeScript types (plain JS, one JSDoc @typedef for the top-level program);
 * individual node kinds are untyped object literals there. This grows
 * alongside the rule table, not ahead of it, same discipline milestone 4
 * set for this file.
 */
export interface IrExpr {
  kind: string;
  value?: number;
  type?: string | null;
  name?: string;
  operator?: string;
  left?: IrExpr;
  right?: IrExpr;
  argument?: IrExpr;
  // call
  args?: IrExpr[];
  // 'string': which slot of ir.strings this literal is (a number, the
  // table index) — not to be confused with 'stringByte's own `index`
  // field just below, an IrExpr (the byte position), same field name on a
  // different node kind (ir/index.mjs's own shapes, not this file's).
  index?: number | IrExpr;
  // 'stringByte' / 'stringLength': the string-typed value being read —
  // itself a 'string' literal or a 'ref' to a string parameter/local.
  string?: IrExpr;
  // 'index': which array this reads, and its element type/width.
  array?: IrExpr;
  elementType?: string | null;
}

export interface IrStatement {
  kind: string;
  // memoryWrite
  address?: IrExpr;
  value?: IrExpr | null;
  // assign
  target?: string;
  // local's own initializer (IrExpr) and for's own init clause (IrStatement,
  // a `local` or an `assign` — the same field name, `init`, on both real IR
  // node shapes, so this has to be the loose union rather than two fields).
  name?: string;
  // call's own `type` (its return type) can be null the same way IrExpr's
  // can (see IrExpr.type's own comment) — everywhere else on this
  // interface (local, etc.) it's always a real string in practice.
  type?: string | null;
  init?: IrExpr | IrStatement | null;
  // if
  test?: IrExpr | null;
  then?: IrStatement[];
  else?: IrStatement[] | null;
  // while / for / block
  body?: IrStatement[];
  // for
  update?: IrStatement | null;
  // call (a bare call statement is the same IR node as a call expression —
  // see ir/index.mjs's statement(): a CallExpression's own lowered node is
  // returned directly as the statement, never wrapped)
  args?: IrExpr[];
}

export interface IrParam {
  name: string;
  type: string;
  // array only (ir/index.mjs's function()) — refused by name in mos/index.ts's
  // parameter pass; carried here only so a test fixture describing one
  // typechecks against the real shape.
  elementType?: string;
  length?: number;
}

export interface IrFunction {
  name: string;
  // Optional so existing synthetic test fixtures (mos.test.ts) that only
  // ever cared about `body` don't all need updating for a milestone that
  // doesn't touch what they're testing — real linked IR (ir/index.mjs's
  // function()) always sets both. mos/index.ts treats a missing params as
  // `[]` and a missing returnType as `'void'`.
  params?: IrParam[];
  returnType?: string;
  body: IrStatement[];
}

/** A function's calling interface, computed once (mos/index.ts, before any
 * lowering — see mos/AGENTS.md) and shared by every call site and by the
 * function's own body: where each parameter lives, how wide it is (1 byte
 * or, since milestone 8, 2), and what label a `JSR` to it names. */
export interface FunctionSite {
  label: string;
  params: { address: number; width: 1 | 2 }[];
  returnType: string;
}

/** One resolvable name: a global (seeded by the caller from zp/index.ts's own allocation) or a local this pass allocates as it lowers a `local` statement. Both live in zero page, so every load/store below uses the 2-byte `zeropage` form unconditionally — nothing here is ever placed past $00FF. */
export interface Binding {
  address: number;
  type: string;
}

/** What a `local` statement did to `symbols`: bound `name` to a fresh slot, shadowing whatever `name` resolved to before (a global, an outer block's own local of the same name, or nothing). Lets the declaring scope put it back exactly the way it found it. */
interface Declared {
  name: string;
  shadowed: Binding | undefined;
}

export interface LowerOptions {
  /** Every global this build's zero-page allocator (milestone 5) already placed, keyed by name. `ref`/`assign` read this first; `local` adds to a private copy as its own declarations come into scope. */
  globals: Map<string, Binding>;
  /** Zero page left over after globals and every function's own parameter region (`PET_ZP_BUDGET` minus what those already spent) — where this one function's locals and expression temporaries bump-allocate from, LIFO. Mutated by this call. Starts wherever the previous function's own region ended (mos/index.ts), never shared with another function's. */
  locals: LocalAllocator;
  /** This function's own parameters, already resolved to their fixed zero-page addresses (mos/index.ts's parameter pass — see mos/AGENTS.md) — bound into scope exactly like a `local`, just once, at the start, never released. */
  params: { name: string; type: string; address: number }[];
  /** Every function in the linked program, by name — a call site's only source for where to store its arguments and which label to `JSR`. Built once before any function is lowered, precisely so a callee's address is always known regardless of lowering order. */
  functions: Map<string, FunctionSite>;
  /** Every const array global this build's data section (mos/data.ts) will place, by name — an `index` node's only source for its element width and its data-section label (mos/data.ts's arrayLabel(name)). A name absent here — a mutable array, or no array at all — is refused by name rather than guessed at; zp/index.ts already refuses a mutable one before this map is even built, so reaching that refusal here would mean the linker or checker let something through this backend never should have seen. */
  arrays: Map<string, { elementType: string }>;
}

export type LowerResult =
  | { ok: true; program: Directive[] }
  | { ok: false; error: string };

// ---- small helpers ----------------------------------------------------

class LowerError extends Error {}

function instr(mnemonic: string, mode: AddressingMode, value?: number, label?: string): Directive {
  if (label !== undefined) return { kind: 'instruction', mnemonic, mode, operand: { kind: 'label', name: label } };
  if (value !== undefined) return { kind: 'instruction', mnemonic, mode, operand: { kind: 'value', value } };
  return { kind: 'instruction', mnemonic, mode };
}

const ldaImm = (value: number): Directive => instr('LDA', 'immediate', value);
const ldaZp = (address: number): Directive => instr('LDA', 'zeropage', address);
const staZp = (address: number): Directive => instr('STA', 'zeropage', address);
const cmpZp = (address: number): Directive => instr('CMP', 'zeropage', address);
const jmp = (label: string): Directive => instr('JMP', 'absolute', undefined, label);
const branch = (mnemonic: string, label: string): Directive => instr(mnemonic, 'relative', undefined, label);
const label = (name: string): Directive => ({ kind: 'label', name });

// A binding's own address is always zp *except* a pinned global outside it
// (@address(0xE84C), a hardware register — see mos/AGENTS.md's calling
// convention doc for why every other binding is guaranteed zp by
// construction: globals, parameters, and locals are all allocated from
// budgets that never cross $00FF). memoryWrite's literal-address case
// already made exactly this call; ref/assign share it now instead of
// hardcoding zeropage the way milestones 4-8 could, because nothing on
// their own critical path had ever been pinned above $FF.
function addrMode(address: number): AddressingMode {
  return address <= 0xff ? 'zeropage' : 'absolute';
}
const ldaAddr = (address: number): Directive => instr('LDA', addrMode(address), address);
const staAddr = (address: number): Directive => instr('STA', addrMode(address), address);

// A label's address, split into its immediate low/high bytes — the
// traditional 6502 assembler's `LDA #<label` / `LDA #>label` — for
// materializing a string literal's (or, in principle, any other data-
// section label's) address into a zp pointer pair. See asm/assemble.ts's
// own Operand.byte for where the split actually happens.
const ldaImmLo = (labelName: string): Directive => ({ kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'label', name: labelName, byte: 'lo' } });
const ldaImmHi = (labelName: string): Directive => ({ kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'label', name: labelName, byte: 'hi' } });

// utinyint, tinyint, and bool (storageBytes special-cases bool to 1) take
// the 8-bit path (`expr()` and everything built on it); a program that
// reaches for a wider type there gets a build error naming the type, not a
// truncated wrong answer — expr16() below is the path for exactly 2 bytes.
function require8Bit(type: string | null | undefined, what: string): void {
  if (type === undefined || type === null) throw new LowerError(`${what}: no type on this IR node — the checker/linker should have set one`);
  if (storageBytes(type) !== 1) {
    throw new LowerError(`${what} is '${type}' (${storageBytes(type)} bytes): this path only lowers 8-bit values — 16-bit values have their own (parameters, +/-, comparisons, and a computed memoryWrite address; locals, assignment, and return values are still 8-bit only)`);
  }
}

// The milestone 8 counterpart: exactly 2 bytes (usmallint, smallint).
// Anything else reaching expr16() — an 8-bit value, or a width this backend
// has no rule for at all (mediumint/int, 4 bytes) — is refused by name
// rather than silently truncated or zero-extended.
function require16Bit(type: string | null | undefined, what: string): void {
  if (type === undefined || type === null) throw new LowerError(`${what}: no type on this IR node — the checker/linker should have set one`);
  if (storageBytes(type) !== 2) {
    throw new LowerError(`${what} is '${type}' (${storageBytes(type)} bytes): only 16-bit values take this path — mixed-width arithmetic and anything wider than 16 bits isn't lowered yet`);
  }
}

function isSigned(type: string): boolean {
  if (type === 'bool') return false;
  return resolveIntegerType(type)?.signed ?? false;
}

// left OP right, with left evaluated first and its value landing in the
// accumulator last (see emitOperands): CMP's flags end up describing
// (right - left), not (left - right), which is why the true/false branch
// picked for each operator below is not just "the obvious 6502 mnemonic
// for that symbol." Worked out once, in the header comment; NEGATE lets
// emitBranchIfFalse reuse this same table instead of needing its own.
type BranchPlan = { mnemonic: string } | { double: [string, string] };
const ORDER_BRANCH_IF_TRUE: Readonly<Record<string, BranchPlan>> = {
  '==': { mnemonic: 'BEQ' },
  '!=': { mnemonic: 'BNE' },
  // A > B, evaluated left-then-right (A=left in temp, B=right in accumulator):
  // CMP computes right-left; right<left (carry clear) is exactly left>right.
  '>': { mnemonic: 'BCC' },
  // A <= B: right>=left (carry set) is exactly left<=right.
  '<=': { mnemonic: 'BCS' },
  // A < B needs carry SET *and* zero CLEAR (right>left, not equal) — no
  // single flag/branch pair does that, so: skip the "it's true" branch
  // when equal, otherwise take it when carry is set.
  '<': { double: ['BEQ', 'BCS'] },
  // A >= B is the complement: true when carry is clear OR zero is set.
  '>=': { double: ['BCC', 'BEQ'] },
};
const NEGATE: Readonly<Record<string, string>> = { '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
const ORDERING_OPERATORS = new Set(['<', '>', '<=', '>=']);
const EQUALITY_OPERATORS = new Set(['==', '!=']);
const COMPARISON_OPERATORS = new Set([...ORDERING_OPERATORS, ...EQUALITY_OPERATORS]);

let labelCounter = 0;
function freshLabel(tag: string): string {
  return `__8bs_${tag}_${labelCounter++}`;
}

// ---- the pass -----------------------------------------------------------

class Lowerer {
  program: Directive[] = [];
  symbols: Map<string, Binding>;
  locals: LocalAllocator;
  functions: Map<string, FunctionSite>;
  arrays: Map<string, { elementType: string }>;
  loops: { continueLabel: string; breakLabel: string }[] = [];
  exitLabel = freshLabel('exit');

  constructor(options: LowerOptions) {
    this.symbols = new Map(options.globals);
    this.locals = options.locals;
    this.functions = options.functions;
    this.arrays = options.arrays;
    // A parameter is bound exactly like a local — same Binding shape, same
    // symbol table — except its address comes from mos/index.ts's own
    // parameter pass (see mos/AGENTS.md), not this.locals.alloc(), and it
    // is never released: it lives for the function's whole body.
    for (const p of options.params) this.symbols.set(p.name, { address: p.address, type: p.type });
  }

  emit(...directives: Directive[]): void {
    this.program.push(...directives);
  }

  binding(name: string): Binding {
    const found = this.symbols.get(name);
    if (!found) throw new LowerError(`'${name}' resolves to nothing this backend knows — not a global milestone 5 placed and not a local in scope (a linker or checker bug, not a missing lowering rule)`);
    return found;
  }

  // ---- expressions: every path below leaves its result in A -----------

  expr(node: IrExpr): void {
    if (node.type) require8Bit(node.type, `'${node.kind}'`);
    switch (node.kind) {
      case 'const':
        this.emit(ldaImm(node.value! & 0xff));
        return;
      case 'ref':
        this.emit(ldaAddr(this.binding(node.name!).address));
        return;
      case 'binop':
        this.binop(node);
        return;
      case 'unop':
        this.unop(node);
        return;
      case 'call':
        this.callSite(node);
        return;
      case 'stringLength':
        this.stringLength(node);
        return;
      case 'stringByte':
        this.stringByte(node);
        return;
      case 'index':
        this.indexRead(node);
        return;
      default:
        throw new LowerError(`no instruction-selection rule yet for the '${node.kind}' expression — it lands in a later milestone`);
    }
  }

  // ---- 16-bit expressions: every path below leaves its result at a zp
  // address it returns (see the file header for why this is a separate
  // path rather than a widened expr()). A `ref` returns an existing
  // binding's own address unchanged; a `const` or `binop` allocates a
  // fresh zp-pair temp, fills it, and returns that — the caller decides
  // when it's safe to release (mark/release, exactly the 8-bit rules'
  // discipline).
  expr16(node: IrExpr): number {
    if (node.type) require16Bit(node.type, `'${node.kind}'`);
    switch (node.kind) {
      case 'const': {
        const address = this.alloc16(`a 16-bit literal`);
        const value = node.value! & 0xffff;
        this.emit(ldaImm(value & 0xff), staZp(address), ldaImm((value >> 8) & 0xff), staZp(address + 1));
        return address;
      }
      case 'ref':
        return this.binding(node.name!).address;
      case 'binop':
        return this.binop16(node);
      case 'string': {
        // A string literal's own value, everywhere it isn't immediately
        // consumed by stringLength/stringByte (which take the address
        // straight from this same case, via expr16 — see those methods):
        // its data-section label's address, split into immediate low/high
        // bytes and copied into a fresh zp pointer pair. Every other
        // expr16 case fills a temp from a runtime-computed value; this one
        // fills it from an assemble-time constant (the label), the same
        // shape as 'const' just above, with the label taking the numeric
        // literal's place.
        const address = this.alloc16(`a string literal's address`);
        const target = stringLabel(node.index as number);
        this.emit(ldaImmLo(target), staZp(address), ldaImmHi(target), staZp(address + 1));
        return address;
      }
      case 'index':
        return this.indexRead16(node);
      default:
        throw new LowerError(`no 16-bit instruction-selection rule yet for the '${node.kind}' expression — it lands in a later milestone`);
    }
  }

  // A 16-bit destination's own value, accepting either width: the front end
  // never widens a narrower literal or value to match a wider declared
  // target (verified against ir/index.mjs — a call argument, a local's
  // initializer, and a plain assignment's right-hand side all keep
  // whatever narrowestIntegerType()/the source's own declared type gave
  // them, with no coercion node inserted anywhere), so if this backend
  // didn't widen here, ordinary code like `text.putChar(0, 65)` — cell 0
  // is a perfectly good utinyint-shaped literal, but putChar's own `cell`
  // is usmallint — would fail to build. Zero-extension is exact for every
  // unsigned type this backend lowers (a utinyint's whole range already
  // fits a usmallint), so this widens rather than refuses; a *signed*
  // narrow source is refused by name instead — sign-extension is a
  // different instruction sequence (replicate the sign bit into the high
  // byte, not just clear it) and nothing on the PET's own critical path
  // needs it yet.
  exprTo16(node: IrExpr): number {
    if (node.type === undefined || node.type === null) {
      throw new LowerError(`'${node.kind}': no type on this IR node — the checker/linker should have set one`);
    }
    const width = storageBytes(node.type);
    if (width === 2) return this.expr16(node);
    if (width === 1 && node.type === 'bool') {
      // A bool assigned/passed to a usmallint target is a type error the
      // checker already refuses before this backend ever sees it — refused
      // here too, rather than quietly zero-extending true/false into 1/0,
      // which would compile a program the checker should have rejected.
      throw new LowerError(`'${node.kind}' is 'bool': can't widen a bool into a 16-bit value`);
    }
    if (width === 1 && isSigned(node.type)) {
      throw new LowerError(`'${node.kind}' is '${node.type}': a signed value narrower than 16 bits can't widen into one yet — sign-extension isn't lowered`);
    }
    if (width === 1) {
      this.expr(node);
      const address = this.alloc16(`a zero-extended 16-bit value`);
      this.emit(staZp(address), ldaImm(0), staZp(address + 1));
      return address;
    }
    throw new LowerError(`'${node.kind}' is '${node.type}' (${width} bytes): only an 8-bit value can widen into 16 bits`);
  }

  // Addition/subtraction on two 16-bit operands, byte-by-byte with carry
  // chained from the low half into the high half — the standard 6502
  // multi-byte idiom. The result temp is allocated *before* the mark that
  // guards left/right's own temporaries: left and right may themselves
  // recurse into binop16 and allocate (and release) further temps above
  // that mark, but the result has to outlive this call, so it can't be
  // something release(mark) would free.
  //
  // left/right go through exprTo16(), not expr16(): the node's own `type`
  // (what routed it here) is widerOf(left.type, right.type) — the front
  // end never inserts a widening node on the narrower side (ir/index.mjs's
  // binop lowering, verified the same way exprTo16's own header comment
  // already verified it for locals/assignment/call arguments), so `cell +
  // i` with cell: usmallint and i: utinyint (exactly @8bitscript/pet/text's
  // own `place(cell + i, s[i])`, discovered building milestone 9's real
  // gate) reaches this method with a 1-byte right operand. Refusing that
  // would refuse code no more exotic than the call-argument widening this
  // backend already does; exprTo16 is the same rule, applied here too.
  binop16(node: IrExpr): number {
    const { operator, left, right } = node;
    if (operator !== '+' && operator !== '-') {
      throw new LowerError(`no 16-bit instruction-selection rule yet for the '${operator}' operator — only + and - are lowered at 16 bits`);
    }
    const result = this.alloc16(`a temporary for 16-bit '${operator}'`);
    const mark = this.locals.mark();
    const leftAddr = this.exprTo16(left!);
    const rightAddr = this.exprTo16(right!);
    if (operator === '+') {
      this.emit(instr('CLC', 'implied'));
      this.emit(ldaZp(leftAddr), instr('ADC', 'zeropage', rightAddr), staZp(result));
      this.emit(ldaZp(leftAddr + 1), instr('ADC', 'zeropage', rightAddr + 1), staZp(result + 1));
    } else {
      this.emit(instr('SEC', 'implied'));
      this.emit(ldaZp(leftAddr), instr('SBC', 'zeropage', rightAddr), staZp(result));
      this.emit(ldaZp(leftAddr + 1), instr('SBC', 'zeropage', rightAddr + 1), staZp(result + 1));
    }
    this.locals.release(mark);
    return result;
  }

  // ---- strings and const arrays: milestone 9 -----------------------------
  //
  // A string value — a literal's data-section address, or an existing
  // string-typed binding's own zp pair (a parameter or local already
  // holding some string's address) — is always materialized as a pointer
  // via expr16() first, uniformly, whichever of the two it is: the 'string'
  // case above fills a fresh temp from a literal's label, the 'ref' case
  // returns an existing binding's address unchanged. stringLength/
  // stringByte below never need to know which one they got.
  //
  // The data itself is length-prefixed — one byte, then the characters,
  // ir/index.mjs's own format (mos/data.ts lays it out the same way).
  // stringLength reads byte 0 through the pointer; stringByte reads byte
  // (index+1), skipping the length byte the same way.

  stringLength(node: IrExpr): void {
    const mark = this.locals.mark();
    const pointer = this.expr16(node.string!);
    this.emit(instr('LDY', 'immediate', 0));
    this.emit(instr('LDA', '(indirect),y', pointer));
    this.locals.release(mark);
  }

  stringByte(node: IrExpr): void {
    const mark = this.locals.mark();
    // Left (the string) evaluates first, right (the index) second — the
    // same operand order every other binary-shaped rule in this file holds
    // to (emitOperands' own header comment). The pointer's own temp, if
    // expr16() allocated one (a literal does; a ref allocates none), has
    // to survive the index's own evaluation, which is why it's computed
    // first and released only once both are done with it.
    const pointer = this.expr16(node.string!);
    this.expr(node.index as IrExpr);
    this.emit(instr('TAY', 'implied'), instr('INY', 'implied'));
    this.emit(instr('LDA', '(indirect),y', pointer));
    this.locals.release(mark);
  }

  /** The data-section label an `index` node's own array resolves to — the only array shape this backend places is a const global (mos/index.ts's parameter pass already refuses an array parameter, and zp/index.ts's allocator already refuses a mutable one, both before `options.arrays` is even built), so a name missing here is a linker or checker bug, not a missing lowering rule. */
  arrayTarget(node: IrExpr): string {
    const name = node.array!.name!;
    if (!this.arrays.has(name)) {
      throw new LowerError(`'${name}' resolves to no const array this backend placed — an array parameter or a mutable array/string<N> isn't lowered yet, and reaching this any other way is a linker or checker bug, not a missing lowering rule`);
    }
    return arrayLabel(name);
  }

  // A 1-byte element: the index (0..255, already 8-bit by node.index's own
  // type) is the byte offset outright.
  indexRead(node: IrExpr): void {
    const target = this.arrayTarget(node);
    this.expr(node.index as IrExpr);
    this.emit(instr('TAY', 'implied'));
    this.emit(instr('LDA', 'absolute,y', undefined, target));
  }

  // A 2-byte element: the index has to be doubled into a byte *offset*
  // first (ASL — a plain shift left, exact as long as index*2 fits in Y's
  // 8 bits), then read low byte, then high byte one further along. Y stays
  // an 8-bit index throughout (the 6502 has no wider index register), so
  // this is only exact while index*2 <= 255 — every const array this
  // backend has ever placed (DIGIT_PLACES, length 5) is nowhere close. A
  // 2-byte-element array past 127 elements isn't refused by name yet;
  // nothing on the PET's own critical path is anywhere near that size.
  indexRead16(node: IrExpr): number {
    const target = this.arrayTarget(node);
    this.expr(node.index as IrExpr);
    this.emit(instr('ASL', 'accumulator'), instr('TAY', 'implied'));
    const result = this.alloc16(`a temporary for reading '${node.array!.name}'`);
    this.emit(instr('LDA', 'absolute,y', undefined, target), staZp(result));
    this.emit(instr('INY', 'implied'));
    this.emit(instr('LDA', 'absolute,y', undefined, target), staZp(result + 1));
    return result;
  }

  // ---- calls: every argument into the callee's own zp slot, then JSR ----
  //
  // Arguments evaluate left-to-right (the milestone 6 decision this backend
  // already holds to) and each is stored into its parameter's address the
  // instant it's evaluated — never held in a shared temporary — so calling
  // the same function twice in one expression, or nesting a call inside an
  // argument (`f(g(x), y)`), is always safe: every function's own
  // parameters and locals live in zero page nothing else ever touches (see
  // mos/AGENTS.md). The callee's return value comes back in A, exactly
  // where every other value-producing rule already leaves its result — a
  // call used as a statement just leaves it there, unread.
  // Takes just the two fields a call site needs (not IrExpr's full shape,
  // which conflicts with IrStatement's on `value`) so this one method
  // serves both expr()'s 'call' case and statement()'s.
  callSite(node: { name?: string; args?: IrExpr[] }): void {
    const target = this.functions.get(node.name!);
    if (!target) {
      throw new LowerError(`call to '${node.name}' resolves to nothing this backend knows about — a linker bug, not a missing lowering rule`);
    }
    const args = node.args ?? [];
    if (args.length !== target.params.length) {
      throw new LowerError(`call to '${node.name}': ${args.length} argument(s) but the function has ${target.params.length} parameter(s) — the linker should already have matched these (completeCall)`);
    }
    for (let i = 0; i < args.length; i += 1) {
      const param = target.params[i];
      if (param.width === 2) {
        const mark = this.locals.mark();
        const addr = this.exprTo16(args[i]);
        this.emit(ldaZp(addr), staZp(param.address), ldaZp(addr + 1), staZp(param.address + 1));
        this.locals.release(mark);
      } else {
        this.expr(args[i]);
        this.emit(staZp(param.address));
      }
    }
    this.emit(instr('JSR', 'absolute', undefined, target.label));
  }

  // Evaluates left into a fresh temporary, then right into A — always this
  // order, regardless of which operator called it (see the file header).
  // Returns the temporary's address; the caller frees it (LIFO) once done.
  emitOperands(left: IrExpr, right: IrExpr, what: string): number {
    this.expr(left);
    const temp = this.alloc(`a temporary for the left side of ${what}`);
    this.emit(staZp(temp));
    this.expr(right);
    return temp;
  }

  binop(node: IrExpr): void {
    const { operator, left, right } = node;
    if (operator === '&&' || operator === '||') {
      // Materialised as a value (not a condition — see branchIfTrue/False
      // for the branch-only path if/while/for use instead): fall through
      // the generic bool-materialisation case below by treating this like
      // any other bool-typed expression.
      this.materializeBool(node);
      return;
    }
    if (COMPARISON_OPERATORS.has(operator!)) {
      this.materializeBool(node);
      return;
    }
    if (operator === '*' || operator === '/' || operator === '%') {
      throw new LowerError(`the '${operator}' operator isn't lowered yet — the 6502 has no hardware multiply or divide, and this backend doesn't have a software routine for one yet`);
    }
    if (operator !== '+' && operator !== '-') {
      throw new LowerError(`no instruction-selection rule yet for the '${operator}' operator`);
    }
    const mark = this.locals.mark();
    const temp = this.emitOperands(left!, right!, `'${operator}'`);
    if (operator === '+') {
      this.emit(instr('CLC', 'implied'), instr('ADC', 'zeropage', temp));
    } else {
      // A currently holds right; left-right needs left in A. Park right,
      // reload left, subtract right back out.
      const rightTemp = this.alloc(`a temporary for the right side of '-'`);
      this.emit(staZp(rightTemp), ldaZp(temp), instr('SEC', 'implied'), instr('SBC', 'zeropage', rightTemp));
    }
    this.locals.release(mark);
  }

  unop(node: IrExpr): void {
    const { operator, argument } = node;
    if (operator === '!') {
      this.materializeBool(node);
      return;
    }
    this.expr(argument!);
    if (operator === '~') {
      this.emit(instr('EOR', 'immediate', 0xff));
    } else if (operator === '-') {
      this.emit(instr('EOR', 'immediate', 0xff), instr('CLC', 'implied'), instr('ADC', 'immediate', 1));
    } else if (operator === '+') {
      // Unary plus is the identity — nothing left to emit.
    } else {
      throw new LowerError(`no instruction-selection rule yet for the unary '${operator}' operator`);
    }
  }

  /** Any bool-typed expression (a comparison, &&/||, or unary !), evaluated to a plain 0/1 value in A — for when it's used as a value (`let ok: bool = a < b;`), not directly as an `if`/`while` test (branchIfTrue/False skip this and branch straight off the flags). */
  materializeBool(node: IrExpr): void {
    const t = freshLabel('true');
    const end = freshLabel('end');
    this.branchIfTrue(node, t);
    this.emit(ldaImm(0), jmp(end), label(t), ldaImm(1), label(end));
  }

  // ---- conditions: branch straight off the flags, no value materialised

  /** Emits code that jumps to `target` iff `node` is true, and otherwise falls through. */
  branchIfTrue(node: IrExpr, target: string): void {
    this.condition(node, target, true);
  }

  /** Emits code that jumps to `target` iff `node` is false, and otherwise falls through. */
  branchIfFalse(node: IrExpr, target: string): void {
    this.condition(node, target, false);
  }

  condition(node: IrExpr, target: string, wantTrue: boolean): void {
    if (node.type) require8Bit(node.type, `'${node.kind}'`);
    if (node.kind === 'unop' && node.operator === '!') {
      this.condition(node.argument!, target, !wantTrue);
      return;
    }
    if (node.kind === 'binop' && node.operator === '&&') {
      if (wantTrue) {
        // Both sides have to be true to reach `target`. If the left side
        // is false the whole thing is false — skip straight past the right
        // side's test to the label placed right after it, falling through
        // (not jumping to target) exactly as a false result should.
        const skip = freshLabel('and_skip');
        this.branchIfFalse(node.left!, skip);
        this.branchIfTrue(node.right!, target);
        this.emit(label(skip));
        return;
      }
      this.branchIfFalse(node.left!, target);
      this.branchIfFalse(node.right!, target);
      return;
    }
    if (node.kind === 'binop' && node.operator === '||') {
      if (wantTrue) {
        this.branchIfTrue(node.left!, target);
        this.branchIfTrue(node.right!, target);
        return;
      }
      // Only false when both sides are. If the left side is already true
      // the whole thing is true — skip the right side's test, falling
      // through past the jump to target exactly as a true result should.
      const skip = freshLabel('or_skip');
      this.branchIfTrue(node.left!, skip);
      this.branchIfFalse(node.right!, target);
      this.emit(label(skip));
      return;
    }
    if (node.kind === 'binop' && COMPARISON_OPERATORS.has(node.operator!)) {
      this.comparisonBranch(node, target, wantTrue);
      return;
    }
    // Anything else that can carry a bool (a ref, a local, a nested !!x —
    // nothing left in M6's scope besides those): materialise it and test
    // it like any run-of-the-mill value. A bool is always exactly 0 or 1
    // by construction (every producer of one — a const, a comparison, &&,
    // ||, ! — already guarantees that), so testing zero/nonzero is exact,
    // not a truthiness approximation.
    this.expr(node);
    this.emit(branch(wantTrue ? 'BNE' : 'BEQ', target));
  }

  comparisonBranch(node: IrExpr, target: string, wantTrue: boolean): void {
    const operator = wantTrue ? node.operator! : NEGATE[node.operator!];
    if (ORDERING_OPERATORS.has(operator) && (isSigned(node.left!.type!) || isSigned(node.right!.type!))) {
      throw new LowerError(`the '${node.operator}' comparison on a signed type isn't lowered yet — only unsigned ordering comparisons are implemented (equality/inequality work on either); this needs the N/V-flag branch tree, a separate design not settled yet`);
    }
    const leftWidth = storageBytes(node.left!.type!);
    const rightWidth = storageBytes(node.right!.type!);
    if (leftWidth !== rightWidth) {
      throw new LowerError(`the '${node.operator}' comparison needs both sides the same width — got ${leftWidth} and ${rightWidth} byte(s); mixed-width comparison isn't lowered yet`);
    }
    const mark = this.locals.mark();
    if (leftWidth === 2) {
      // Same convention as the 8-bit path below: left evaluates first (into
      // its own zp pair), right second, and the flags end up describing
      // (right - left) — CMP's carry becomes SBC's own borrow-in directly,
      // chaining the low byte's borrow into the high byte's subtraction,
      // the standard 6502 multi-byte compare idiom.
      const leftAddr = this.expr16(node.left!);
      const rightAddr = this.expr16(node.right!);
      this.emit(ldaZp(rightAddr), cmpZp(leftAddr), ldaZp(rightAddr + 1), instr('SBC', 'zeropage', leftAddr + 1));
    } else if (leftWidth === 1) {
      const temp = this.emitOperands(node.left!, node.right!, `'${node.operator}'`);
      this.emit(cmpZp(temp));
    } else {
      throw new LowerError(`the '${node.operator}' comparison operates on a ${leftWidth}-byte type — only 1- and 2-byte comparisons are lowered yet`);
    }
    const plan = ORDER_BRANCH_IF_TRUE[operator];
    if ('mnemonic' in plan) {
      this.emit(branch(plan.mnemonic, target));
    } else {
      const [skipMnemonic, takeMnemonic] = plan.double;
      const skip = freshLabel('cmp_skip');
      this.emit(branch(skipMnemonic, skip), branch(takeMnemonic, target), label(skip));
    }
    this.locals.release(mark);
  }

  alloc(what: string): number {
    return this.locals.alloc(what);
  }

  alloc16(what: string): number {
    return this.locals.alloc16(what);
  }

  // ---- statements -------------------------------------------------------

  block(body: IrStatement[]): void {
    const mark = this.locals.mark();
    const declared: Declared[] = [];
    for (const statement of body) {
      const result = this.statement(statement);
      if (result) declared.push(result);
    }
    this.unscope(declared);
    this.locals.release(mark);
  }

  /** Puts every name a block's own locals shadowed back the way it found them — a global (or an outer block's own local of the same name) reached again once the shadow's scope ends, never left permanently unresolvable. */
  unscope(declared: Declared[]): void {
    for (const { name, shadowed } of declared) {
      if (shadowed) this.symbols.set(name, shadowed);
      else this.symbols.delete(name);
    }
  }

  /** Lowers one statement, returning what it declared (a `local` shadows whatever `name` resolved to before, possibly nothing) so the caller can restore that once this statement's scope ends. */
  statement(node: IrStatement): Declared | null {
    switch (node.kind) {
      case 'memoryWrite':
        this.memoryWrite(node);
        return null;
      case 'assign': {
        // The target's own width matters here, not just the value's: `x =
        // e` never widens or coerces (the front end doesn't emit that —
        // verified against ir/index.mjs, see exprTo16's own comment) —
        // this backend does, at the boundary, via exprTo16, rather than
        // refuse code as ordinary as `x = 5;` for a usmallint `x`.
        // widerOf() only ever widens on `+=`-style compound assignment
        // (already folded into a binop by the time this IR exists), so
        // this is the one place plain assignment's own width has to be
        // handled explicitly.
        const binding = this.binding(node.target!);
        const width = storageBytes(binding.type);
        if (width === 2) {
          const addr = this.exprTo16(node.value!);
          this.emit(ldaZp(addr), staAddr(binding.address), ldaZp(addr + 1), staAddr(binding.address + 1));
        } else {
          require8Bit(binding.type, `assignment to '${node.target}'`);
          this.expr(node.value!);
          this.emit(staAddr(binding.address));
        }
        return null;
      }
      case 'local': {
        const width = storageBytes(node.type!);
        if (width === 2) {
          const addr = this.exprTo16(node.init as IrExpr);
          const address = this.alloc16(`local '${node.name}'`);
          this.emit(ldaZp(addr), staZp(address), ldaZp(addr + 1), staZp(address + 1));
          const shadowed = this.symbols.get(node.name!);
          this.symbols.set(node.name!, { address, type: node.type! });
          return { name: node.name!, shadowed };
        }
        require8Bit(node.type, `local '${node.name}'`);
        this.expr(node.init as IrExpr);
        const address = this.alloc(`local '${node.name}'`);
        this.emit(staZp(address));
        const shadowed = this.symbols.get(node.name!);
        this.symbols.set(node.name!, { address, type: node.type! });
        return { name: node.name!, shadowed };
      }
      case 'block':
        this.block(node.body!);
        return null;
      case 'if':
        this.ifStatement(node);
        return null;
      case 'while':
        this.whileStatement(node);
        return null;
      case 'for':
        this.forStatement(node);
        return null;
      case 'break':
        if (this.loops.length === 0) throw new LowerError('break outside any loop — a checker bug, not a missing lowering rule');
        this.emit(jmp(this.loops[this.loops.length - 1].breakLabel));
        return null;
      case 'continue':
        if (this.loops.length === 0) throw new LowerError('continue outside any loop — a checker bug, not a missing lowering rule');
        this.emit(jmp(this.loops[this.loops.length - 1].continueLabel));
        return null;
      case 'return':
        // A value evaluates into A — right where the caller of *this*
        // function already expects its return value (see callSite) — then
        // falls straight into the same exit jump a bare `return;` always
        // used. Width is checked the same way every other value-producing
        // node's is, inside expr() itself; nothing extra needed here.
        if (node.value) this.expr(node.value);
        this.emit(jmp(this.exitLabel));
        return null;
      // A bare call statement (`place(cell, code);`, result discarded) —
      // deliberately not routed through expr(), which gates on node.type
      // being exactly 8-bit: a void-returning function's call is a
      // perfectly good statement and has no value to width-check.
      case 'call':
        this.callSite(node);
        return null;
      default:
        throw new LowerError(`no instruction-selection rule yet for the '${node.kind}' statement — it lands in a later milestone`);
    }
  }

  memoryWrite(statement: IrStatement): void {
    const { address, value } = statement;
    if (!address) throw new LowerError('memoryWrite: no address to write to');
    if (!value) throw new LowerError('memoryWrite: no value to write');
    if (address.kind === 'const') {
      this.expr(value);
      const target = address.value!;
      const mode = target <= 0xff ? 'zeropage' : 'absolute';
      this.emit(instr('STA', mode, target));
      return;
    }
    // A computed address (milestone 8): the full 16-bit value lands in a
    // zp pair, then STA (zp),Y stores through it — Y fixed at 0, since
    // nothing here needs an offset beyond the pointer's own value. Y is
    // scratch this store owns outright: nothing else in this backend reads
    // or holds Y live across a JSR (mos/AGENTS.md). The address is
    // computed *before* the value so the value's own temps (allocated
    // after, from wherever the allocator's cursor already sits) can never
    // land inside the address's zp pair.
    require16Bit(address.type, 'memoryWrite: a computed address');
    const mark = this.locals.mark();
    const pointer = this.expr16(address);
    this.expr(value);
    this.emit(instr('LDY', 'immediate', 0));
    this.emit(instr('STA', '(indirect),y', pointer));
    this.locals.release(mark);
  }

  ifStatement(node: IrStatement): void {
    // node.else is `[]` for a present-but-empty `else {}`, not just absent
    // (null) — falling into the two-label form for that wastes a 3-byte
    // JMP jumping to code that does nothing, so an empty else is treated
    // the same as no else at all.
    if (node.else?.length) {
      const elseLabel = freshLabel('else');
      const end = freshLabel('endif');
      this.branchIfFalse(node.test!, elseLabel);
      this.block(node.then!);
      this.emit(jmp(end), label(elseLabel));
      this.block(node.else);
      this.emit(label(end));
    } else {
      const end = freshLabel('endif');
      this.branchIfFalse(node.test!, end);
      this.block(node.then!);
      this.emit(label(end));
    }
  }

  whileStatement(node: IrStatement): void {
    const top = freshLabel('while');
    const end = freshLabel('endwhile');
    this.emit(label(top));
    this.branchIfFalse(node.test!, end);
    this.loops.push({ continueLabel: top, breakLabel: end });
    this.block(node.body!);
    this.loops.pop();
    this.emit(jmp(top), label(end));
  }

  forStatement(node: IrStatement): void {
    const mark = this.locals.mark();
    let declared: Declared | null = null;
    if (node.init) declared = this.statement(node.init as IrStatement);

    const top = freshLabel('for');
    const cont = freshLabel('forcont');
    const end = freshLabel('endfor');
    this.emit(label(top));
    if (node.test) this.branchIfFalse(node.test, end);
    this.loops.push({ continueLabel: cont, breakLabel: end });
    this.block(node.body!);
    this.loops.pop();
    this.emit(label(cont));
    if (node.update) this.statement(node.update);
    this.emit(jmp(top), label(end));

    if (declared) this.unscope([declared]);
    this.locals.release(mark);
  }
}

/** Lowers one function's body to a 6502 program. `options.globals`/`options.locals` come from the caller's own zero-page accounting (milestone 5's globals, this milestone's own locals budget beneath them). */
export function lower(body: IrStatement[], options: LowerOptions): LowerResult {
  const lowerer = new Lowerer(options);
  try {
    lowerer.block(body);
    lowerer.emit(label(lowerer.exitLabel));
    return { ok: true, program: lowerer.program };
  } catch (error) {
    if (error instanceof LowerError || error instanceof ZpBudgetError) return { ok: false, error: error.message };
    throw error;
  }
}
