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
import { WAIT_FRAME_LABEL } from '../startup/waitframe.ts';
import { MULTIPLY_LABEL } from '../startup/multiply.ts';
import { parseAsm } from '../asm/parse.ts';

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
  // memoryRead: the address to read, constant or computed — the same shape
  // memoryWrite's own `address` takes on IrStatement.
  address?: IrExpr;
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
  // asm: the source text between an `asm6502` block's braces, exactly as
  // written (packages/compiler/src/ir/index.mjs keeps it unparsed, since
  // nothing before the 6502 backend has any reason to read assembly).
  text?: string;
  // stringCopy: the string being copied in, and the capacity of the buffer
  // it is going into (`target` above is that buffer).
  source?: IrExpr;
  capacity?: number;
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
  // while / for / block. `origin` names the callee an inlined block came
  // from, so `--size` can still attribute those bytes after the call is gone.
  body?: IrStatement[];
  origin?: string;
  // for
  update?: IrStatement | null;
  // call (a bare call statement is the same IR node as a call expression —
  // see ir/index.mjs's statement(): a CallExpression's own lowered node is
  // returned directly as the statement, never wrapped)
  args?: IrExpr[];
  // storeIndex (ir/index.mjs's indexAssignment): which array is written,
  // at which index — `value` above is the stored value, shared with
  // memoryWrite/assign the same way `init` is shared.
  array?: IrExpr;
  index?: IrExpr;
  elementType?: string | null;
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
 * or, since milestone 8, 2), and what label a `JSR` to it names.
 * `returnPair` is the fixed zero-page pair a 16-bit-returning function
 * (0.2.2 — A is one byte, so a wide result needs a home the same way a
 * wide parameter does) writes its result into before its RTS; the call
 * site copies it out to a fresh temporary immediately, so `f() + f()`
 * can't clobber its own left operand. Unset for an 8-bit or void return,
 * which keep the accumulator convention unchanged. */
export interface FunctionSite {
  label: string;
  params: { address: number; width: 1 | 2 }[];
  returnType: string;
  returnPair?: number;
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
  /** Every array global this build's data section (mos/data.ts) will place — const data and mutable `let` arrays alike as of 0.2.2, string<N> buffers included — by name: an `index`/`storeIndex` node's only source for its element width, its mutability, and its data-section label (mos/data.ts's arrayLabel(name)). A name absent here (an array parameter, or no array at all) is refused by name rather than guessed at. */
  arrays: Map<string, { elementType: string; mutable?: boolean }>;
  /** The shared 16-bit multiply routine's operand/result cells (mos/startup/multiply.ts), placed by mos/index.ts exactly when a runtime `*` survives the optimizer's strength reduction anywhere in the program — null (or absent) otherwise, and a `*` reaching this pass with no cells is the placement scan disagreeing with the tree, a build() bug rather than a missing rule. */
  multiply?: { a: number; b: number; result: number } | null;
  /** This function's own 16-bit return pair (its FunctionSite.returnPair), when it has one — where its `return <value>` statements store the result. Absent for an 8-bit or void function, whose `return` keeps the accumulator convention. */
  returnPair?: number;
}

export type LowerResult =
  | { ok: true; program: Directive[]; parts: { origin: string | null; program: Directive[] }[] }
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
// `double` is an AND-shaped pair: reach `target` only when the `skip`
// branch is NOT taken (its condition is false) AND the `take` branch IS
// taken — see comparisonBranch's own emission (`skip; take; label(skip)`).
// `either` is the OR-shaped counterpart a single skip/take pair cannot
// express at all: reach `target` when *either* mnemonic's own condition
// holds, so both branch straight to `target`, no intermediate label —
// found missing here (not a design choice, a bug: `>=` used to reuse the
// AND-shaped `double` template for what is actually an OR condition,
// which silently returned true for values well outside the intended
// range — caught building milestone 10's PET mixed-case text, where
// `code < 91` failing for code=104 ('h') by way of `>=`'s own negation
// let 'h' through the "already upper case" branch unconverted).
type BranchPlan = { mnemonic: string } | { double: [string, string] } | { either: [string, string] };
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
  // A >= B is the complement of A < B, not of A <= B: true when carry is
  // clear OR zero is set — an OR, so `either`, not `double`.
  '>=': { either: ['BCC', 'BEQ'] },
};
const NEGATE: Readonly<Record<string, string>> = { '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
// ORDER_BRANCH_IF_TRUE assumes A holds the RIGHT operand and CMP names the
// left, so the flags describe (right - left). When an operand is a constant
// or a plain zero-page binding, the cheaper emission is the other way
// around — left in A, `CMP #right` / `CMP right` — and the flags then
// describe (left - right), which is exactly the same table read through the
// mirrored operator: left < right under (left - right) branches the way
// right > left does under (right - left).
const MIRROR: Readonly<Record<string, string>> = { '==': '==', '!=': '!=', '<': '>', '>': '<', '<=': '>=', '>=': '<=' };

// The mnemonics whose result *is* the accumulator, flags included — after
// any of these, Z/N describe A exactly. `x == 0`'s no-CMP shortcut
// (comparisonBranch) may only branch straight off the flags when the last
// instruction the operand emitted is one of these; anything else (a JSR, a
// '%' loop ending on its own CMP, a label) gets an explicit CMP #0 instead
// of a guess about what the flags happen to describe.
const SETS_FLAGS_FROM_A = new Set(['LDA', 'ADC', 'SBC', 'AND', 'ORA', 'EOR', 'TXA', 'TYA', 'PLA']);
const ORDERING_OPERATORS = new Set(['<', '>', '<=', '>=']);
const EQUALITY_OPERATORS = new Set(['==', '!=']);
const COMPARISON_OPERATORS = new Set([...ORDERING_OPERATORS, ...EQUALITY_OPERATORS]);

let labelCounter = 0;
function freshLabel(tag: string): string {
  return `__8bs_${tag}_${labelCounter++}`;
}

// The predicate names the 'const' subtype, not IrExpr itself: narrowing a
// non-union type to the whole type would turn every negative branch (`the
// operand is NOT a constant, so...`) into `never`.
/**
 * `array[i + 250]` split into the part that belongs in the *address* and
 * the part that belongs in Y.
 *
 * A 6502 indexes with an 8-bit register, so an index written as `i + 250`
 * cannot be computed and then used: the sum wraps at 255 and the store
 * lands back at the start of the array. What the machine actually offers is
 * the other association — `STA base+250,Y` — which is exact for every `i`
 * Y can hold, costs nothing at run time, and is precisely what the screen
 * clearing loops in the C64 and VIC-20 packages are written in terms of
 * ("four constant offsets off one 8-bit index is the shape a 6502 wants",
 * packages/c64/src/screen.8bs). So the constant folds into the address.
 *
 * Only when what is left is 8-bit: a wider index has its own path, and Y
 * could not hold it anyway.
 */
function splitIndexOffset(node: IrExpr | undefined | null): { index: IrExpr; offset: number } | null {
  if (!node || node.kind !== 'binop' || node.operator !== '+') return null;
  const fits = (side: IrExpr | undefined) => side?.type !== undefined && side.type !== null && storageBytes(side.type) === 1;
  if (isConstNum(node.right) && node.right.value >= 0 && fits(node.left)) return { index: node.left!, offset: node.right.value };
  if (isConstNum(node.left) && node.left.value >= 0 && fits(node.right)) return { index: node.right!, offset: node.left.value };
  return null;
}

/** A label's low or high byte as an immediate, with a constant folded in. */
function immByte(name: string, half: 'lo' | 'hi', offset: number): Directive {
  const operand = offset === 0
    ? { kind: 'label' as const, name, byte: half }
    : { kind: 'label' as const, name, byte: half, offset };
  return { kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand };
}

/** `STA base+offset,Y` and friends — the offset omitted when it is zero, so nothing changes shape for the arrays that never needed one. */
function indexed(mnemonic: string, label: string, offset: number): Directive {
  const operand = offset === 0 ? { kind: 'label' as const, name: label } : { kind: 'label' as const, name: label, offset };
  return { kind: 'instruction', mnemonic, mode: 'absolute,y', operand };
}

function isConstNum(node: IrExpr | undefined | null, value?: number): node is IrExpr & { kind: 'const'; value: number } {
  if (!node || node.kind !== 'const' || typeof node.value !== 'number') return false;
  if (value !== undefined && node.value !== value) return false;
  return true;
}

function isRefNamed(node: IrExpr | undefined | null, name: string): boolean {
  return !!node && node.kind === 'ref' && node.name === name;
}

// Whether evaluating `node` can change any binding's value — the guard on
// every operand-reordering shortcut below. Reading left's own zero-page
// byte at the ADC/CMP itself, *after* right has evaluated, is only the
// same program as the temp-copy emission when nothing in right could have
// written left in between; a call can (any global, any array), so a call
// anywhere inside makes the answer false. Everything else this backend
// lowers as an expression only reads.
function isPure(node: IrExpr | undefined | null): boolean {
  if (!node) return false;
  switch (node.kind) {
    case 'const':
    case 'ref':
    case 'string':
      return true;
    case 'binop':
      return isPure(node.left) && isPure(node.right);
    case 'unop':
      return isPure(node.argument);
    case 'index':
      return isPure(node.index as IrExpr);
    case 'stringLength':
      return isPure(node.string);
    case 'stringByte':
      return isPure(node.string) && isPure(node.index as IrExpr);
    default:
      return false; // a call, or any kind this predicate doesn't know — assume it writes
  }
}

function matchConstFill(node: IrStatement): { base: number; count: number; value: number } | null {
  const init = node.init as IrStatement | null | undefined;
  if (!init || init.kind !== 'local' || !init.name) return null;
  const name = init.name;
  if (!isConstNum(init.init as IrExpr, 0)) return null;
  const test = node.test;
  if (!test || test.kind !== 'binop' || test.operator !== '<' || !isRefNamed(test.left, name) || !isConstNum(test.right)) return null;
  const count = test.right.value!;
  if (count <= 0 || count > 0x10000) return null;
  const update = node.update;
  if (!update || update.kind !== 'assign' || update.target !== name) return null;
  const inc = update.value;
  if (!inc || inc.kind !== 'binop' || inc.operator !== '+' || !isRefNamed(inc.left, name) || !isConstNum(inc.right, 1)) return null;
  const body = node.body ?? [];
  if (body.length !== 1 || body[0].kind !== 'memoryWrite') return null;
  const write = body[0];
  if (!isConstNum(write.value ?? undefined)) return null;
  const fillValue = write.value!.value!;
  if (fillValue < 0 || fillValue > 255) return null;
  const address = write.address;
  if (!address || address.kind !== 'binop' || address.operator !== '+') return null;
  let base: number | null = null;
  if (isConstNum(address.left) && isRefNamed(address.right, name)) base = address.left.value!;
  else if (isConstNum(address.right) && isRefNamed(address.left, name)) base = address.right.value!;
  if (base === null || base < 0 || base + count > 0x10000) return null;
  return { base, count, value: fillValue };
}

// ---- the pass -----------------------------------------------------------

class Lowerer {
  program: Directive[] = [];
  symbols: Map<string, Binding>;
  locals: LocalAllocator;
  functions: Map<string, FunctionSite>;
  arrays: Map<string, { elementType: string; mutable?: boolean }>;
  multiply: { a: number; b: number; result: number } | null;
  returnPair: number | null;
  loops: { continueLabel: string; breakLabel: string }[] = [];
  exitLabel = freshLabel('exit');

  constructor(options: LowerOptions) {
    this.symbols = new Map(options.globals);
    this.locals = options.locals;
    this.functions = options.functions;
    this.arrays = options.arrays;
    this.multiply = options.multiply ?? null;
    this.returnPair = options.returnPair ?? null;
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
      // `memory.read(addr)` — memoryWrite's counterpart, and the same two
      // shapes: a constant address is one LDA, a computed one goes through
      // a zp pointer with Y at 0. The value lands in A, where every other
      // 8-bit expression rule leaves its result.
      case 'memoryRead':
        this.memoryRead(node);
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
  /**
   * An 8-bit value from an expression that may be wider than 8 bits.
   *
   * `let offset: utinyint = (cellWidth - width) >> 1` is ordinary code: the
   * subtraction is 16-bit because one side is, and the answer is then kept
   * in a byte. Narrowing means the low byte — it is what every assignment
   * of a wider value to a narrower one has always meant here — so the wide
   * expression is evaluated as itself and its low byte taken, rather than
   * the whole statement being refused for a width the program never asked
   * anything unusual of.
   */
  expr8(node: IrExpr): void {
    if (node.type !== undefined && node.type !== null && storageBytes(node.type) === 2) {
      const mark = this.locals.mark();
      const pair = this.expr16(node);
      this.emit(ldaZp(pair));
      this.locals.release(mark);
      return;
    }
    this.expr(node);
  }

  expr16(node: IrExpr): number {
    if (node.type) require16Bit(node.type, `'${node.kind}'`);
    switch (node.kind) {
      case 'const': {
        const address = this.alloc16(`a 16-bit literal`);
        const value = node.value! & 0xffff;
        this.emit(ldaImm(value & 0xff), staZp(address), ldaImm((value >> 8) & 0xff), staZp(address + 1));
        return address;
      }
      case 'ref': {
        // A `string<N>` buffer lives in the data section, not zero page —
        // it is an array of its own bytes, length first (mos/index.ts
        // places it beside the string literals). So its name means its
        // address, exactly as a literal's does in the case below, rather
        // than a zero-page binding it does not have.
        if (node.type === 'string' && this.arrays.has(node.name!)) {
          const address = this.alloc16(`'${node.name}'s own address`);
          const target = arrayLabel(node.name!);
          this.emit(ldaImmLo(target), staZp(address), ldaImmHi(target), staZp(address + 1));
          return address;
        }
        return this.binding(node.name!).address;
      }
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
      case 'call': {
        // The callee left its result in its own return pair (see
        // FunctionSite.returnPair); copy it out to a fresh temporary
        // right away — the pair is the callee's, and the very next call
        // to the same function (`f() + f()`) would overwrite it.
        const target = this.functions.get(node.name!);
        if (!target) throw new LowerError(`call to '${node.name}' resolves to nothing this backend knows about — a linker bug, not a missing lowering rule`);
        if (target.returnPair === undefined) {
          throw new LowerError(`call to '${node.name}' used as a 16-bit value, but it returns '${target.returnType}' — a checker or linker bug, not a missing lowering rule`);
        }
        this.callSite(node);
        const result = this.alloc16(`a temporary for '${node.name}'s return value`);
        this.emit(ldaZp(target.returnPair), staZp(result), ldaZp(target.returnPair + 1), staZp(result + 1));
        return result;
      }
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

  /**
   * A 16-bit value stored straight into the pair at `address`/`address+1`
   * (staAddr: the pair may be a global above zero page). The temp-free
   * shapes exprTo16 can't express: a constant is four (or three, when its
   * two bytes agree) instructions with no pair allocated at all; a 16-bit
   * ref copies byte-by-byte; an 8-bit unsigned value zero-extends in
   * place. Everything else — and the narrow-signed/bool sources exprTo16
   * refuses by name — evaluates through exprTo16 and copies out, exactly
   * the emission every caller of this used to spell inline.
   */
  store16Into(node: IrExpr, address: number): void {
    // An untyped node falls through to exprTo16, which refuses it by name
    // — same defensive contract as before this shortcut existed.
    const typed = node.type !== undefined && node.type !== null;
    const narrowSigned = typed && storageBytes(node.type!) === 1 && (node.type === 'bool' || isSigned(node.type!));
    if (isConstNum(node) && typed && !narrowSigned) {
      const value = node.value! & 0xffff;
      const lo = value & 0xff;
      const hi = (value >> 8) & 0xff;
      this.emit(ldaImm(lo), staAddr(address));
      if (hi !== lo) this.emit(ldaImm(hi));
      this.emit(staAddr(address + 1));
      return;
    }
    if (node.kind === 'ref' && node.type === 'string' && this.arrays.has(node.name!)) {
      // A `string<N>` buffer passed by name: its address is its
      // data-section label's, the same two immediate loads a literal's is,
      // and not a zero-page binding — it has none (see expr16's own 'ref').
      const target = arrayLabel(node.name!);
      this.emit(ldaImmLo(target), staAddr(address), ldaImmHi(target), staAddr(address + 1));
      return;
    }
    if (node.kind === 'ref' && node.type && storageBytes(node.type) === 2) {
      const src = this.binding(node.name!).address;
      this.emit(ldaAddr(src), staAddr(address), ldaAddr(src + 1), staAddr(address + 1));
      return;
    }
    if (node.kind === 'string') {
      // A string literal's label address, straight into the pair — the
      // same two immediate loads expr16's own 'string' case fills a temp
      // with, minus the temp and the copy out of it.
      const target = stringLabel(node.index as number);
      this.emit(ldaImmLo(target), staAddr(address), ldaImmHi(target), staAddr(address + 1));
      return;
    }
    if (node.kind === 'binop' && (node.operator === '+' || node.operator === '-') && node.type && storageBytes(node.type) === 2) {
      // A 16-bit sum computes straight into the destination pair — see
      // addSub16Into for why writing the target mid-chain can't corrupt
      // an operand, even `score = score + x`'s own left side.
      this.addSub16Into(node, address);
      return;
    }
    if (node.type && storageBytes(node.type) === 1 && !narrowSigned) {
      this.expr(node);
      this.emit(staAddr(address), ldaImm(0), staAddr(address + 1));
      return;
    }
    const mark = this.locals.mark();
    const src = this.exprTo16(node);
    this.emit(ldaZp(src), staAddr(address), ldaZp(src + 1), staAddr(address + 1));
    this.locals.release(mark);
  }

  /** `x = x + 1` (and +2, -1, -2; either operand order for the commutative '+') as INC/DEC — strictly smaller and never slower than the load/add/store it replaces, with exactly the declared width's own wrap at the byte boundary. Only for a zero-page target: on a pinned hardware register a read-modify-write is not the same bus traffic as a load and a store. */
  emitIncDec(target: string, binding: Binding, value: IrExpr): boolean {
    if (binding.address > 0xff) return false;
    if (value.kind !== 'binop' || (value.operator !== '+' && value.operator !== '-')) return false;
    let amount: number | null = null;
    if (isRefNamed(value.left, target) && isConstNum(value.right)) amount = value.right.value! & 0xff;
    else if (value.operator === '+' && isConstNum(value.left) && isRefNamed(value.right, target)) amount = value.left.value! & 0xff;
    if (amount === null || amount < 1 || amount > 2) return false;
    const mnemonic = value.operator === '+' ? 'INC' : 'DEC';
    for (let i = 0; i < amount; i++) this.emit(instr(mnemonic, 'zeropage', binding.address));
    return true;
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
    if (operator === '*') {
      // The same shared routine the 8-bit path uses (see binop's own '*'
      // case) — here the whole 16-bit product is copied out to a fresh
      // pair, immediately, so a nested multiply can't clobber it in the
      // routine's own cells.
      this.multiplyInto(node);
      const cells = this.requireMultiply();
      const result = this.alloc16(`a temporary for 16-bit '*'`);
      this.emit(ldaZp(cells.result), staZp(result), ldaZp(cells.result + 1), staZp(result + 1));
      return result;
    }
    if (operator === '<<' || operator === '>>') {
      return this.shift16(node);
    }
    if (operator === '&' || operator === '|' || operator === '^') {
      return this.bitwise16(node);
    }
    if (operator !== '+' && operator !== '-') {
      throw new LowerError(`no 16-bit instruction-selection rule yet for the '${operator}' operator — only +, -, *, bitwise &/|/^, and constant-amount shifts are lowered at 16 bits`);
    }
    const result = this.alloc16(`a temporary for 16-bit '${operator}'`);
    this.addSub16Into(node, result);
    return result;
  }

  /**
   * `&`, `|` and `^` at 16 bits: a byte at a time, which is all a bitwise
   * operation ever is — there is no carry between the halves the way an
   * add has one, so the low and high bytes are independent and neither
   * order nor overlap can go wrong.
   *
   * A constant side reads as two immediates, the same saving
   * addSub16Into's own constant case makes. `cell % 256` arrives here as
   * `cell & 255` (the optimizer's own reduceModulo) and lowers to one AND
   * of each half, which is what taking a low byte costs.
   */
  bitwise16(node: IrExpr): number {
    const { operator, left, right } = node;
    const mnemonic = operator === '&' ? 'AND' : operator === '|' ? 'ORA' : 'EOR';
    const result = this.alloc16(`a temporary for 16-bit '${operator}'`);
    const mark = this.locals.mark();
    if (isConstNum(right)) {
      const value = right.value! & 0xffff;
      const leftAddr = this.exprTo16(left!);
      this.emit(ldaZp(leftAddr), instr(mnemonic, 'immediate', value & 0xff), staAddr(result));
      this.emit(ldaZp(leftAddr + 1), instr(mnemonic, 'immediate', (value >> 8) & 0xff), staAddr(result + 1));
    } else {
      const leftAddr = this.exprTo16(left!);
      const rightAddr = this.exprTo16(right!);
      this.emit(ldaZp(leftAddr), instr(mnemonic, 'zeropage', rightAddr), staAddr(result));
      this.emit(ldaZp(leftAddr + 1), instr(mnemonic, 'zeropage', rightAddr + 1), staAddr(result + 1));
    }
    this.locals.release(mark);
    return result;
  }

  /**
   * `left + right` / `left - right` at 16 bits, computed straight into the
   * pair at `target` — a fresh temp (binop16) or a real destination
   * (store16Into): the low store lands between reading the operands' low
   * bytes and their HIGH bytes, which is safe even when `target` IS an
   * operand (`score = score + x`): the pairs either coincide exactly or
   * don't overlap at all (every pair is its own allocation), so the low
   * write never touches a high byte still to be read.
   */
  addSub16Into(node: IrExpr, target: number): void {
    const { operator, left, right } = node;
    const mark = this.locals.mark();
    const carry = operator === '+' ? instr('CLC', 'implied') : instr('SEC', 'implied');
    const mnemonic = operator === '+' ? 'ADC' : 'SBC';
    // A constant side needs no pair of its own: ADC/SBC read its two bytes
    // as immediates. (Two constant sides never reach here — the optimizer
    // folds those.) The masked value is exact for a narrower constant of
    // either signedness: & 0xffff zero-extends an unsigned byte and
    // two's-complements a negative one, which is precisely what a 16-bit
    // add/subtract of it means. A constant LEFT only helps '+' — SBC wants
    // the left operand in A, and a subtrahend can't swap sides.
    if (isConstNum(right)) {
      const value = right.value! & 0xffff;
      const leftAddr = this.exprTo16(left!);
      this.emit(carry);
      this.emit(ldaZp(leftAddr), instr(mnemonic, 'immediate', value & 0xff), staAddr(target));
      this.emit(ldaZp(leftAddr + 1), instr(mnemonic, 'immediate', (value >> 8) & 0xff), staAddr(target + 1));
    } else if (operator === '+' && isConstNum(left)) {
      const value = left.value! & 0xffff;
      const rightAddr = this.exprTo16(right!);
      this.emit(carry);
      this.emit(ldaZp(rightAddr), instr(mnemonic, 'immediate', value & 0xff), staAddr(target));
      this.emit(ldaZp(rightAddr + 1), instr(mnemonic, 'immediate', (value >> 8) & 0xff), staAddr(target + 1));
    } else {
      const leftAddr = this.exprTo16(left!);
      const rightAddr = this.exprTo16(right!);
      this.emit(carry);
      this.emit(ldaZp(leftAddr), instr(mnemonic, 'zeropage', rightAddr), staAddr(target));
      this.emit(ldaZp(leftAddr + 1), instr(mnemonic, 'zeropage', rightAddr + 1), staAddr(target + 1));
    }
    this.locals.release(mark);
  }

  // A 16-bit shift by a compile-time amount, into a fresh pair the shift
  // then works on in place. A whole byte of shift is a byte move (the
  // spare byte zeroed), the remainder the standard ASL/ROL (<<) or
  // LSR/ROR (>>) pair per step — `state >> 8` (@8bitscript/random's own
  // high-byte read) is the move alone, zero shift instructions.
  shift16(node: IrExpr): number {
    if (!isConstNum(node.right)) {
      throw new LowerError(`the '${node.operator}' operator needs a compile-time shift amount — a runtime amount isn't lowered (index a table of masks instead)`);
    }
    const amount = node.right.value!;
    const result = this.alloc16(`a temporary for 16-bit '${node.operator}'`);
    const mark = this.locals.mark();
    const src = this.exprTo16(node.left!);
    this.emit(ldaZp(src), staZp(result), ldaZp(src + 1), staZp(result + 1));
    this.locals.release(mark);
    if (amount >= 16) {
      this.emit(ldaImm(0), staZp(result), staZp(result + 1));
      return result;
    }
    let remaining = amount;
    if (remaining >= 8) {
      if (node.operator === '>>') {
        this.emit(ldaZp(result + 1), staZp(result), ldaImm(0), staZp(result + 1));
      } else {
        this.emit(ldaZp(result), staZp(result + 1), ldaImm(0), staZp(result));
      }
      remaining -= 8;
    }
    for (let i = 0; i < remaining; i++) {
      if (node.operator === '>>') {
        this.emit(instr('LSR', 'zeropage', result + 1), instr('ROR', 'zeropage', result));
      } else {
        this.emit(instr('ASL', 'zeropage', result), instr('ROL', 'zeropage', result + 1));
      }
    }
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

  /** The data-section label an `index`/`storeIndex` node's own array resolves to — every array global, const data and mutable RAM alike, is placed there as of 0.2.2 (mos/index.ts's own collection; mos/index.ts's parameter pass still refuses an array parameter before `options.arrays` is even built), so a name missing here is a linker or checker bug, not a missing lowering rule. */
  arrayTarget(node: IrExpr): string {
    const name = node.array!.name!;
    if (!this.arrays.has(name)) {
      throw new LowerError(`'${name}' resolves to no array this backend placed — an array parameter isn't lowered yet, and reaching this any other way is a linker or checker bug, not a missing lowering rule`);
    }
    return arrayLabel(name);
  }

  // `name[index] = value`, 1-byte elements: the index parks in a temp
  // while the value evaluates (the value's own expression may use A and Y
  // freely), then Y picks the cell and one absolute,y store writes it —
  // the mirror of indexRead's own LDA absolute,y. A 2-byte element store
  // is refused by name: nothing real writes one yet, and its read
  // counterpart's own ASL-into-Y shape would need deciding against a
  // second byte's ordering here.
  /**
   * `base + index` in a zero-page pointer, for an index too wide for Y.
   *
   * Y is eight bits, so `screenRam[cell]` with a cell past 255 cannot be
   * indexed with it — truncating would write 1000 cells into the first 256,
   * which on a 40-column screen is the whole display collapsed into its top
   * six rows (measured: that is exactly what a C64 2048 drew). The address
   * is computed instead, the same way a computed `memory.write` address is,
   * and the store goes through `(pointer),y` with Y at 0.
   */
  arrayPointer(label: string, index: IrExpr, offset: number): number {
    const pointer = this.alloc16(`'${label}'s own address plus a 16-bit index`);
    const wide = this.expr16(index);
    this.emit(instr('CLC', 'implied'));
    this.emit(immByte(label, 'lo', offset), instr('ADC', 'zeropage', wide), staZp(pointer));
    this.emit(immByte(label, 'hi', offset), instr('ADC', 'zeropage', wide + 1), staZp(pointer + 1));
    return pointer;
  }

  storeIndex(node: IrStatement): void {
    const name = node.array!.name!;
    const entry = this.arrays.get(name);
    if (!entry) {
      throw new LowerError(`'${name}' resolves to no array this backend placed — an array parameter isn't lowered yet, and anything else reaching this is a linker or checker bug`);
    }
    if (!entry.mutable) {
      throw new LowerError(`'${name}' is a const array — data in the program, not RAM — and the checker should already have refused writing it`);
    }
    if (storageBytes(entry.elementType) !== 1) {
      throw new LowerError(`storing into '${name}': a 2-byte array element isn't written yet — only 1-byte (utinyint/bool) elements are`);
    }
    // A constant index — or a plain-ref index against a value that can't
    // write it (isPure) — needs no temp: the value evaluates into A and Y
    // takes the index directly afterward. That reorders the index READ
    // after the value's evaluation, which is only the same program when
    // the value can't have changed the index in between — hence the
    // purity gate on the ref shape (a constant can't change at all).
    const split = splitIndexOffset(node.index);
    const index = split ? split.index : node.index!;
    const offset = split ? split.offset : 0;
    if (index.type !== undefined && index.type !== null && storageBytes(index.type) === 2 && !isConstNum(index)) {
      const mark = this.locals.mark();
      const pointer = this.arrayPointer(arrayLabel(name), index, offset);
      this.expr8(node.value! as IrExpr);
      this.emit(instr('LDY', 'immediate', 0));
      this.emit(instr('STA', '(indirect),y', pointer));
      this.locals.release(mark);
      return;
    }
    if (isConstNum(index) || (index.kind === 'ref' && index.type && storageBytes(index.type) === 1 && this.binding(index.name!).address <= 0xff && isPure(node.value as IrExpr))) {
      this.expr8(node.value! as IrExpr);
      this.indexIntoY(index);
      this.emit(indexed('STA', arrayLabel(name), offset));
      return;
    }
    const mark = this.locals.mark();
    this.indexValue(index);
    const temp = this.alloc(`a temporary for '${name}[...]'s own index`);
    this.emit(staZp(temp));
    this.expr8(node.value! as IrExpr);
    this.emit(instr('LDY', 'zeropage', temp));
    this.emit(indexed('STA', arrayLabel(name), offset));
    this.locals.release(mark);
  }

  /** The index straight into Y — LDY #const / LDY zp for the simple shapes, sparing A and the TAY; everything else evaluates into A and transfers. */
  indexIntoY(node: IrExpr): void {
    if (isConstNum(node)) {
      this.emit(instr('LDY', 'immediate', node.value! & 0xff));
      return;
    }
    if (node.kind === 'ref' && node.type && storageBytes(node.type) === 1) {
      const address = this.binding(node.name!).address;
      if (address <= 0xff) {
        this.emit(instr('LDY', 'zeropage', address));
        return;
      }
    }
    this.indexValue(node);
    this.emit(instr('TAY', 'implied'));
  }

  // An index expression, either width, into A. An array holds at most 256
  // elements (one byte of index space — the whole reason Y can address
  // every element), so a 16-bit-*typed* index (`TILES[base + col]`, where
  // base is a usmallint) is still a one-byte *value* in any in-range
  // program, and its low byte is exact.
  indexValue(node: IrExpr): void {
    const width = node.type ? storageBytes(node.type) : 1;
    if (width === 2) {
      const mark = this.locals.mark();
      const addr = this.expr16(node);
      this.emit(ldaZp(addr));
      this.locals.release(mark);
      return;
    }
    this.expr(node);
  }

  // A 1-byte element: the index is the byte offset outright.
  indexRead(node: IrExpr): void {
    const target = this.arrayTarget(node);
    const split = splitIndexOffset(node.index as IrExpr);
    const index = (split ? split.index : node.index) as IrExpr;
    const offset = split ? split.offset : 0;
    if (index.type !== undefined && index.type !== null && storageBytes(index.type) === 2 && !isConstNum(index)) {
      const mark = this.locals.mark();
      const pointer = this.arrayPointer(target, index, offset);
      this.emit(instr('LDY', 'immediate', 0));
      this.emit(instr('LDA', '(indirect),y', pointer));
      this.locals.release(mark);
      return;
    }
    this.indexIntoY(index);
    this.emit(indexed('LDA', target, offset));
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
    if (isConstNum(node.index as IrExpr)) {
      // A constant index doubles at compile time; Y takes it directly.
      this.emit(instr('LDY', 'immediate', ((node.index as IrExpr).value! * 2) & 0xff));
    } else {
      this.indexValue(node.index as IrExpr);
      this.emit(instr('ASL', 'accumulator'), instr('TAY', 'implied'));
    }
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
        this.store16Into(args[i], param.address);
        this.locals.release(mark);
      } else {
        this.expr8(args[i]);
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
    if (operator === '*') {
      // The shared shift-and-add routine (mos/startup/multiply.ts) serves
      // both widths: 8-bit operands zero-extend in, and an 8-bit product
      // is the result's low byte — the same wrap `utinyint` arithmetic
      // always has. Multiplies the compiler could do cheaper (a power of
      // two, a two-set-bit constant) never reach here: linker/optimize.mjs
      // already turned them into shifts.
      this.multiplyInto(node);
      this.emit(ldaZp(this.requireMultiply().result));
      return;
    }
    if (operator === '%') {
      this.modulo8(node);
      return;
    }
    if (operator === '/') {
      throw new LowerError(`the '/' operator isn't lowered yet — the 6502 has no hardware divide, and nothing on this backend's critical path needs one ('%' subtracts instead)`);
    }
    if (operator === '&' || operator === '|' || operator === '^') {
      this.bitwise8(node);
      return;
    }
    if (operator === '<<' || operator === '>>') {
      this.shift8(node);
      return;
    }
    if (operator !== '+' && operator !== '-') {
      throw new LowerError(`no instruction-selection rule yet for the '${operator}' operator`);
    }
    // A constant or plain-binding operand needs no temp at all: evaluate
    // the other side into A and let ADC/SBC read the simple side directly.
    // A simple RIGHT side always preserves left-then-right order (right is
    // only *read*, at the ADC/SBC itself, after left evaluated). A simple
    // LEFT side means evaluating right first, which is only the same
    // program when right can't write left in between — a const can't be
    // written at all, a ref demands a pure right (isPure's own contract).
    const carry = operator === '+' ? instr('CLC', 'implied') : instr('SEC', 'implied');
    const mnemonic = operator === '+' ? 'ADC' : 'SBC';
    const rightSimple = this.simpleOperand(right!);
    if (rightSimple) {
      this.expr(left!);
      this.emit(carry, instr(mnemonic, rightSimple.mode, rightSimple.value));
      return;
    }
    if (operator === '+') {
      const leftSimple = this.simpleOperand(left!);
      if (leftSimple && (left!.kind === 'const' || isPure(right))) {
        this.expr(right!);
        this.emit(carry, instr(mnemonic, leftSimple.mode, leftSimple.value));
        return;
      }
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

  /** Whether the last instruction emitted left Z/N describing A — the gate on branching off a load's own flags instead of spending a CMP #0 (see SETS_FLAGS_FROM_A). A shift ends in accumulator mode; everything else consults the mnemonic set. */
  lastSetsFlagsFromA(): boolean {
    const d = this.program[this.program.length - 1];
    // A trailing label is a branch target: another path may arrive with
    // flags from an entirely different instruction, so nothing is known.
    if (!d || d.kind !== 'instruction') return false;
    if (d.mode === 'accumulator') return true; // ASL/LSR/ROL/ROR A
    return SETS_FLAGS_FROM_A.has(d.mnemonic);
  }

  /** An 8-bit operand ADC/SBC/CMP/AND/ORA/EOR can read directly — a constant (immediate mode) or a plain binding (its own address) — or null when only a real evaluation into A will do. */
  simpleOperand(node: IrExpr): { mode: AddressingMode; value: number } | null {
    if (isConstNum(node)) return { mode: 'immediate', value: node.value! & 0xff };
    if (node.kind === 'ref') {
      const address = this.binding(node.name!).address;
      return { mode: addrMode(address), value: address };
    }
    return null;
  }

  requireMultiply(): { a: number; b: number; result: number } {
    if (!this.multiply) {
      throw new LowerError("a '*' reached instruction selection with no multiply routine placed — the placement scan (mos/startup/multiply.ts's usesMultiply) disagrees with the tree, a build() bug rather than a missing rule");
    }
    return this.multiply;
  }

  /** Both operands into the shared routine's own cells (widened the same way a 16-bit call argument is), then JSR — the 16-bit product lands in the routine's result pair. The caller reads it out immediately, before any enclosing expression can multiply again. */
  multiplyInto(node: IrExpr): void {
    const cells = this.requireMultiply();
    const mark = this.locals.mark();
    const leftAddr = this.exprTo16(node.left!);
    const rightAddr = this.exprTo16(node.right!);
    this.emit(ldaZp(leftAddr), staZp(cells.a), ldaZp(leftAddr + 1), staZp(cells.a + 1));
    this.emit(ldaZp(rightAddr), staZp(cells.b), ldaZp(rightAddr + 1), staZp(cells.b + 1));
    this.emit(instr('JSR', 'absolute', undefined, MULTIPLY_LABEL));
    this.locals.release(mark);
  }

  // `value % bound`, both 8-bit, by repeated subtraction: CMP leaves the
  // carry set exactly when A >= bound, which is both the loop's own
  // continue condition and the borrow-in SBC needs, so the loop is three
  // instructions. Iterations are value/bound — a die roll or a board cell,
  // never a division this backend would owe a real routine for. `bound`
  // must be at least 1, the same contract every caller already documents
  // (@8bitscript/random's own range()): a zero bound loops forever here
  // exactly as `i32.rem_u`'s own trap ends the program on the web target.
  modulo8(node: IrExpr): void {
    const mark = this.locals.mark();
    this.expr(node.left!);
    const value = this.alloc(`a temporary for the left side of '%'`);
    this.emit(staZp(value));
    this.expr(node.right!);
    const bound = this.alloc(`a temporary for the right side of '%'`);
    this.emit(staZp(bound));
    const loop = freshLabel('mod');
    const done = freshLabel('mod_done');
    this.emit(ldaZp(value), label(loop), cmpZp(bound), branch('BCC', done));
    this.emit(instr('SBC', 'zeropage', bound), jmp(loop), label(done));
    this.locals.release(mark);
  }

  // `&`/`|`/`^`, all three commutative, so a constant on either side is an
  // immediate-mode operand and the temp is only paid for when both sides
  // are runtime values.
  bitwise8(node: IrExpr): void {
    const mnemonic = node.operator === '&' ? 'AND' : node.operator === '|' ? 'ORA' : 'EOR';
    const rightSimple = this.simpleOperand(node.right!);
    if (rightSimple) {
      this.expr(node.left!);
      this.emit(instr(mnemonic, rightSimple.mode, rightSimple.value));
      return;
    }
    const leftSimple = this.simpleOperand(node.left!);
    if (leftSimple && (node.left!.kind === 'const' || isPure(node.right))) {
      this.expr(node.right!);
      this.emit(instr(mnemonic, leftSimple.mode, leftSimple.value));
      return;
    }
    const mark = this.locals.mark();
    const temp = this.emitOperands(node.left!, node.right!, `'${node.operator}'`);
    this.emit(instr(mnemonic, 'zeropage', temp));
    this.locals.release(mark);
  }

  // A shift by a compile-time amount unrolls into ASL/LSR on the
  // accumulator — the only shape anything real needs (`key >> 3`,
  // `(width - used) >> 1`, the optimizer's own strength-reduced
  // multiplies). A runtime amount would be a loop, and is refused by name
  // until something actually needs one — @8bitscript/pet's own keyboard
  // table (`COLUMN_BIT`, "a table lookup is one indexed load") is the
  // documented idiom instead.
  shift8(node: IrExpr): void {
    if (!isConstNum(node.right)) {
      throw new LowerError(`the '${node.operator}' operator needs a compile-time shift amount — a runtime amount isn't lowered (index a table of masks instead)`);
    }
    const amount = node.right.value!;
    this.expr(node.left!);
    if (amount >= 8) {
      this.emit(ldaImm(0));
      return;
    }
    const mnemonic = node.operator === '<<' ? 'ASL' : 'LSR';
    for (let i = 0; i < amount; i++) this.emit(instr(mnemonic, 'accumulator'));
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
    if (isConstNum(node)) {
      // A compile-time condition is a jump or nothing — `while (true)`'s
      // own test, most commonly. The linker's optimizer folds constant
      // `if`s away entirely; this catches the loop shapes it keeps.
      if (((node.value! & 0xff) !== 0) === wantTrue) this.emit(jmp(target));
      return;
    }
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
    const width = Math.max(leftWidth, rightWidth);
    const mark = this.locals.mark();
    if (width === 2) {
      // The 16-bit path CANNOT reuse the 8-bit branch table below: after
      // `CMP low / SBC high`, only the CARRY describes the whole 16-bit
      // subtraction — Z is the HIGH byte's alone, so any plan that reads
      // BEQ/BNE off this sequence answers wrong whenever the difference
      // fits in the low byte (found running the first real 16-bit `>=`
      // ever executed, @8bitscript/pet/text's own printNumber, 2026-09-10:
      // `34 >= 100` read as "equal" and the digit loop subtracted
      // forever). So: equality compares byte-by-byte and skips the high
      // compare when the low already differs, leaving Z exact; ordering
      // subtracts in whichever direction makes the carry alone the
      // answer. Both sides go through exprTo16 — a mixed-width pair
      // (`value != 0`) zero-extends its narrower unsigned side, exactly
      // binop16's own operand rule (0.2.2).
      const leftAddr = this.exprTo16(node.left!);
      const rightAddr = this.exprTo16(node.right!);
      if (operator === '==' || operator === '!=') {
        const skipHigh = freshLabel('cmp16_hi');
        this.emit(ldaZp(leftAddr), cmpZp(rightAddr), branch('BNE', skipHigh));
        this.emit(ldaZp(leftAddr + 1), cmpZp(rightAddr + 1), label(skipHigh));
        this.emit(branch(operator === '==' ? 'BEQ' : 'BNE', target));
      } else {
        // left-right leaves C = (left >= right); right-left leaves
        // C = (right >= left). Pick the direction whose carry IS the
        // operator, and no Z is ever consulted.
        const [lo, hi, other, mnemonic] = operator === '<' ? [leftAddr, leftAddr + 1, rightAddr, 'BCC']
          : operator === '>=' ? [leftAddr, leftAddr + 1, rightAddr, 'BCS']
            : operator === '>' ? [rightAddr, rightAddr + 1, leftAddr, 'BCC']
              : [rightAddr, rightAddr + 1, leftAddr, 'BCS'];
        this.emit(ldaZp(lo), cmpZp(other), ldaZp(hi), instr('SBC', 'zeropage', other + 1));
        this.emit(branch(mnemonic, target));
      }
      this.locals.release(mark);
      return;
    }
    if (width !== 1) {
      throw new LowerError(`the '${node.operator}' comparison operates on a ${width}-byte type — only 1- and 2-byte comparisons are lowered yet`);
    }
    // A constant or plain-binding operand: no temp, CMP reads it directly.
    // With LEFT in A the flags describe (left - right) — the table read
    // through MIRROR (see its own comment). With RIGHT in A — the simple
    // side is the left one — the flags describe (right - left), which is
    // ORDER_BRANCH_IF_TRUE's own native orientation. Reordering rules are
    // binop's: a simple right always preserves left-then-right, a simple
    // left needs a const (unwritable) or a pure right.
    const rightSimple = this.simpleOperand(node.right!);
    const leftSimple = this.simpleOperand(node.left!);
    let plan: BranchPlan;
    if (rightSimple) {
      this.expr(node.left!);
      if (rightSimple.mode === 'immediate' && rightSimple.value === 0 && EQUALITY_OPERATORS.has(operator) && this.lastSetsFlagsFromA()) {
        // `x == 0` / `x != 0`, and whatever produced x left Z describing
        // A already — branch straight off it, no CMP at all.
        this.emit(branch(operator === '==' ? 'BEQ' : 'BNE', target));
        this.locals.release(mark);
        return;
      }
      this.emit(instr('CMP', rightSimple.mode, rightSimple.value));
      plan = ORDER_BRANCH_IF_TRUE[MIRROR[operator]];
    } else if (leftSimple && (node.left!.kind === 'const' || isPure(node.right))) {
      this.expr(node.right!);
      if (leftSimple.mode === 'immediate' && leftSimple.value === 0 && EQUALITY_OPERATORS.has(operator) && this.lastSetsFlagsFromA()) {
        this.emit(branch(operator === '==' ? 'BEQ' : 'BNE', target));
        this.locals.release(mark);
        return;
      }
      this.emit(instr('CMP', leftSimple.mode, leftSimple.value));
      plan = ORDER_BRANCH_IF_TRUE[operator];
    } else {
      const temp = this.emitOperands(node.left!, node.right!, `'${node.operator}'`);
      this.emit(cmpZp(temp));
      plan = ORDER_BRANCH_IF_TRUE[operator];
    }
    if ('mnemonic' in plan) {
      this.emit(branch(plan.mnemonic, target));
    } else if ('double' in plan) {
      // AND-shaped: reach `target` only when `skip`'s own condition is
      // false (so it does not fire) and `take`'s own condition is true.
      const [skipMnemonic, takeMnemonic] = plan.double;
      const skip = freshLabel('cmp_skip');
      this.emit(branch(skipMnemonic, skip), branch(takeMnemonic, target), label(skip));
    } else {
      // OR-shaped: reach `target` when either mnemonic's own condition is
      // true — both branch straight to it, no intermediate label to skip
      // past the second one.
      const [firstMnemonic, secondMnemonic] = plan.either;
      this.emit(branch(firstMnemonic, target), branch(secondMnemonic, target));
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

  // Ranges (indexes into this.program), not slices: lower() runs a
  // peephole over the finished program before it materializes the parts,
  // and an index range survives that where an eagerly-taken copy would
  // silently disagree with the program's real bytes.
  block(body: IrStatement[]): { origin: string | null; start: number; end: number }[] {
    const mark = this.locals.mark();
    const declared: Declared[] = [];
    const ranges: { origin: string | null; start: number; end: number }[] = [];
    for (const statement of body) {
      const start = this.program.length;
      const result = this.statement(statement);
      if (result) declared.push(result);
      ranges.push({
        origin: typeof statement.origin === 'string' ? statement.origin : null,
        start,
        end: this.program.length,
      });
    }
    this.unscope(declared);
    this.locals.release(mark);
    return ranges;
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
          const mark = this.locals.mark();
          this.store16Into(node.value!, binding.address);
          this.locals.release(mark);
        } else {
          require8Bit(binding.type, `assignment to '${node.target}'`);
          if (!this.emitIncDec(node.target!, binding, node.value!)) {
            this.expr8(node.value!);
            this.emit(staAddr(binding.address));
          }
        }
        return null;
      }
      case 'local': {
        const width = storageBytes(node.type!);
        if (width === 2) {
          // The local's own pair first, the initializer's temporaries above
          // it — so they release cleanly (LIFO) instead of the temp sitting
          // stranded beneath the local for the function's whole life.
          const address = this.alloc16(`local '${node.name}'`);
          const mark = this.locals.mark();
          this.store16Into(node.init as IrExpr, address);
          this.locals.release(mark);
          const shadowed = this.symbols.get(node.name!);
          this.symbols.set(node.name!, { address, type: node.type! });
          return { name: node.name!, shadowed };
        }
        require8Bit(node.type, `local '${node.name}'`);
        this.expr8(node.init as IrExpr);
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
      case 'return': {
        // A value evaluates into A — right where the caller of *this*
        // function already expects its return value (see callSite) — then
        // falls straight into the same exit jump a bare `return;` always
        // used. A 16-bit value returns its low byte: this backend only
        // lowers 8-bit returns (mos/index.ts refuses a 16-bit return
        // *type* by name), so a wider value here is the language's own
        // wrap-at-declared-width narrowing — `return state >> 8;` into a
        // utinyint (@8bitscript/random's own next()) is exactly this, and
        // the shift already put the wanted byte low. If 16-bit return
        // types ever land, this case is where the truncation stops being
        // the whole story.
        if (node.value && this.returnPair !== null) {
          // A 16-bit-returning function: the value lands in the
          // function's own fixed return pair (FunctionSite.returnPair),
          // widened from 8 bits the same way a wide call argument is.
          const mark = this.locals.mark();
          this.store16Into(node.value, this.returnPair);
          this.locals.release(mark);
        } else if (node.value) {
          const width = node.value.type ? storageBytes(node.value.type) : 1;
          if (width === 2) {
            const mark = this.locals.mark();
            const addr = this.expr16(node.value);
            this.emit(ldaZp(addr));
            this.locals.release(mark);
          } else {
            this.expr(node.value);
          }
        }
        this.emit(jmp(this.exitLabel));
        return null;
      }
      // A bare call statement (`place(cell, code);`, result discarded) —
      // deliberately not routed through expr(), which gates on node.type
      // being exactly 8-bit: a void-returning function's call is a
      // perfectly good statement and has no value to width-check.
      case 'call':
        this.callSite(node);
        return null;
      // Blocks until the next logical frame — the accumulator, the
      // calibrated measurement, and the hardware edge poll/ack all live in
      // the shared subroutine every call site JSRs to (mos/startup/
      // waitframe.ts), not here: this rule only has to know its name.
      case 'waitFrame':
        this.emit(instr('JSR', 'absolute', undefined, WAIT_FRAME_LABEL));
        return null;
      case 'storeIndex':
        this.storeIndex(node);
        return null;
      // `blank = "    "` — one `string<N>` buffer's bytes replaced by
      // another string's, length byte included.
      case 'stringCopy':
        this.stringCopy(node);
        return null;
      // `asm6502 { ... }`: the block's own text, read into the same
      // Directives everything else here emits (mos/asm/parse.ts), so the
      // assembler, the branch relaxer and the linker cannot tell which
      // instructions a human wrote. The block gets a fresh id so its local
      // labels are its own — `1:` in two blocks is two places.
      case 'asm': {
        const parsed = parseAsm(node.text ?? '', freshLabel('asm').slice('__8bs_'.length));
        if (!parsed.ok) throw new LowerError(parsed.error);
        this.emit(...parsed.directives);
        return null;
      }
      default:
        throw new LowerError(`no instruction-selection rule yet for the '${node.kind}' statement — it lands in a later milestone`);
    }
  }

  /**
   * Copies a string into a `string<N>` buffer: the length byte, then that
   * many characters, through two zero-page pointers.
   *
   * Both operands are addresses of data-section bytes (a literal's label or
   * a buffer's), so this is one loop over `(source),y` into `(target),y`
   * with Y counting from 0 — the length byte at 0 doubles as the counter.
   * Nothing clamps to the capacity here: the checker settles whether a
   * string fits its buffer before this sees it, and a copy that silently
   * truncated would be the wrong answer to give anyway.
   */
  stringCopy(node: IrStatement): void {
    const source = node.source as IrExpr | undefined;
    const target = node.target as unknown as IrExpr | undefined;
    if (!source || !target) throw new LowerError('stringCopy: needs both a source and a target');
    const mark = this.locals.mark();
    const to = this.expr16(target);
    const from = this.expr16(source);
    const loop = freshLabel('strcpy');
    const done = freshLabel('strcpy_done');
    this.emit(instr('LDY', 'immediate', 0));
    this.emit(instr('LDA', '(indirect),y', from));
    this.emit(instr('STA', '(indirect),y', to));
    this.emit(instr('TAX', 'implied'));
    this.emit(branch('BEQ', done));
    this.emit(label(loop));
    this.emit(instr('INY', 'implied'));
    this.emit(instr('LDA', '(indirect),y', from));
    this.emit(instr('STA', '(indirect),y', to));
    this.emit(instr('DEX', 'implied'));
    this.emit(branch('BNE', loop));
    this.emit(label(done));
    this.locals.release(mark);
  }

  memoryRead(node: IrExpr): void {
    const address = node.address;
    if (!address) throw new LowerError('memoryRead: no address to read from');
    if (address.kind === 'const') {
      const target = address.value!;
      this.emit(instr('LDA', target <= 0xff ? 'zeropage' : 'absolute', target));
      return;
    }
    // Same pointer discipline as memoryWrite's computed case below: the
    // address into a zp pair, Y held at 0, and the temporaries released
    // once the byte is in A.
    require16Bit(address.type, 'memoryRead: a computed address');
    const mark = this.locals.mark();
    const pointer = this.expr16(address);
    this.emit(instr('LDY', 'immediate', 0));
    this.emit(instr('LDA', '(indirect),y', pointer));
    this.locals.release(mark);
  }

  memoryWrite(statement: IrStatement): void {
    const { address, value } = statement;
    if (!address) throw new LowerError('memoryWrite: no address to write to');
    if (!value) throw new LowerError('memoryWrite: no value to write');
    if (address.kind === 'const') {
      this.expr8(value);
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
    this.expr8(value);
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
    if (this.emitConstFill(node)) return;
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

  /**
   * `for (let i = 0; i < N; i++) memory.write(BASE + i, VALUE)` with N, BASE,
   * and VALUE all compile-time constants — screen.blank()'s own loop. A
   * 16-bit index and STA (zp),Y cost ~130 bytes for 1000 cells; page-sized
   * STA abs,X loops are ~28 and use no zero page for the index.
   */
  emitConstFill(node: IrStatement): boolean {
    const fill = matchConstFill(node);
    if (!fill) return false;
    const { base, count, value } = fill;
    const pages = Math.floor(count / 256);
    const rem = count % 256;
    this.emit(ldaImm(value));
    if (pages > 0 || rem > 0) this.emit(instr('LDX', 'immediate', 0));
    for (let page = 0; page < pages; page++) {
      const pageBase = base + page * 256;
      const mode: AddressingMode = pageBase <= 0xff ? 'zeropage,x' : 'absolute,x';
      const top = freshLabel('fill');
      this.emit(label(top));
      this.emit(instr('STA', mode, pageBase));
      this.emit(instr('INX', 'implied'));
      this.emit(branch('BNE', top));
    }
    if (rem > 0) {
      const pageBase = base + pages * 256;
      const mode: AddressingMode = pageBase <= 0xff ? 'zeropage,x' : 'absolute,x';
      const top = freshLabel('fillrem');
      this.emit(label(top));
      this.emit(instr('STA', mode, pageBase));
      this.emit(instr('INX', 'implied'));
      this.emit(instr('CPX', 'immediate', rem));
      this.emit(branch('BNE', top));
    }
    return true;
  }
}

/**
 * The indexes of every JMP or conditional branch whose target label is the
 * very next placed directive — a jump to where execution falls anyway,
 * three (or two) bytes buying nothing. The common source is a `return` as
 * a function's last statement: its jump to the exit label lands
 * immediately after itself. Deleting one such jump can expose another
 * (`JMP exit` just before an `endif:` that itself precedes `exit:`), so
 * this iterates to a fixed point.
 */
function jumpsToNextLabel(program: Directive[]): Set<number> {
  const removed = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < program.length; i++) {
      if (removed.has(i)) continue;
      const d = program[i];
      if (d.kind !== 'instruction') continue;
      const isJmp = d.mnemonic === 'JMP' && d.mode === 'absolute';
      if (!isJmp && d.mode !== 'relative') continue;
      if (!d.operand || d.operand.kind !== 'label') continue;
      const target = d.operand.name;
      for (let j = i + 1; j < program.length; j++) {
        if (removed.has(j)) continue;
        const next = program[j];
        if (next.kind !== 'label') break;
        if (next.name === target) {
          removed.add(i);
          changed = true;
          break;
        }
      }
    }
  }
  return removed;
}

/**
 * Marks every `LDA` that provably reloads what the accumulator already
 * holds: scanning backward over nothing but STA instructions (which change
 * neither A nor the flags), the run is anchored by either the same LDA
 * again, or by any flags-from-A instruction when one of those STAs wrote
 * the very address being reloaded. Both cases leave A *and* the flags
 * byte-for-byte identical without the reload, so downstream code that
 * branches straight off a load's own flags (comparisonBranch's `== 0`
 * shortcut) still sees exactly what it saw. Only immediate and zeropage
 * operands qualify — an absolute LDA can be a hardware register whose READ
 * is a side effect (the PET's own $E812 acknowledges the retrace flag),
 * and every allocator-owned binding is zero page by construction.
 */
function redundantReloads(program: Directive[], removed: Set<number>): void {
  type Instr = Extract<Directive, { kind: 'instruction' }>;
  const sameOperand = (a: Instr, b: Instr): boolean =>
    a.mode === b.mode && JSON.stringify(a.operand ?? null) === JSON.stringify(b.operand ?? null);
  for (let i = 0; i < program.length; i++) {
    if (removed.has(i)) continue;
    const d = program[i];
    if (d.kind !== 'instruction' || d.mnemonic !== 'LDA') continue;
    if (d.mode !== 'immediate' && d.mode !== 'zeropage') continue;
    let sawStaSame = false;
    let anchor: Directive | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (removed.has(j)) continue;
      const p = program[j];
      // A label is a branch target: another path may arrive with any A.
      if (p.kind !== 'instruction') break;
      if (p.mnemonic === 'STA') {
        if (d.mode === 'zeropage' && p.mode === 'zeropage' && sameOperand(p, d)) sawStaSame = true;
        continue;
      }
      anchor = p;
      break;
    }
    if (!anchor || anchor.kind !== 'instruction') continue;
    const anchorFlagsFromA = anchor.mode === 'accumulator' || SETS_FLAGS_FROM_A.has(anchor.mnemonic);
    if (!anchorFlagsFromA) continue;
    if ((anchor.mnemonic === 'LDA' && sameOperand(anchor, d)) || sawStaSame) removed.add(i);
  }
}

/** Lowers one function's body to a 6502 program. `options.globals`/`options.locals` come from the caller's own zero-page accounting (milestone 5's globals, this milestone's own locals budget beneath them). */
export function lower(body: IrStatement[], options: LowerOptions): LowerResult {
  const lowerer = new Lowerer(options);
  try {
    const ranges = lowerer.block(body);
    lowerer.emit(label(lowerer.exitLabel));
    const removed = jumpsToNextLabel(lowerer.program);
    redundantReloads(lowerer.program, removed);
    const program = lowerer.program.filter((_, i) => !removed.has(i));
    const parts = ranges.map(({ origin, start, end }) => ({
      origin,
      program: lowerer.program.slice(start, end).filter((_, offset) => !removed.has(start + offset)),
    }));
    return { ok: true, program, parts };
  } catch (error) {
    if (error instanceof LowerError || error instanceof ZpBudgetError) return { ok: false, error: error.message };
    throw error;
  }
}
