// Instruction selection: linked IR in, a straight-line-or-branching 6502
// program out. Milestone 4 gave this file its one rule (`memoryWrite` of a
// literal to a literal address); this milestone adds nine more —
// `binop` `unop` `assign` `local` `ref` `if` `while` `for` `break`
// `continue` `return` `block` — all restricted to 8-bit values. 16-bit
// arithmetic, `*`/`/`/`%` (no hardware support to lower them onto yet), and
// signed ordering comparisons are refused by name, the same
// exhaustive-with-error contract every earlier milestone already holds
// itself to: a construct with no rule fails the build naming exactly what
// it doesn't support yet, never silently.
//
// Every value-producing rule below leaves its result in the accumulator —
// "tree-walk codegen with zero-page temporaries first," the roadmap's own
// settled decision. Operands are always evaluated in source order, left
// then right, even where the accumulator ends up holding the right operand
// (`emitOperands` below) — not because the language defines an evaluation
// order yet (nothing in M6 can have a side effect), but because getting
// this backwards now would be a silent trap the day M7 adds calls: whup a
// comparison's own left/right assembly trick can't safely swap which
// operand is evaluated first once evaluating one can affect the other.
import type { Directive as _AsmDirective } from '../asm/assemble.ts';
import type { AddressingMode } from '../asm/encode.ts';
import { storageBytes, resolveIntegerType } from '../../types/index.mjs';
import { LocalAllocator, ZpBudgetError } from './allocator.ts';

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
  type?: string;
  name?: string;
  operator?: string;
  left?: IrExpr;
  right?: IrExpr;
  argument?: IrExpr;
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
  type?: string;
  init?: IrExpr | IrStatement | null;
  // if
  test?: IrExpr | null;
  then?: IrStatement[];
  else?: IrStatement[] | null;
  // while / for / block
  body?: IrStatement[];
  // for
  update?: IrStatement | null;
}

export interface IrFunction {
  name: string;
  body: IrStatement[];
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
  /** Zero page left over after globals (`PET_ZP_BUDGET` minus what milestone 5 already spent) — where locals and expression temporaries bump-allocate from, LIFO. Mutated by this call. */
  locals: LocalAllocator;
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

// Every ordinary integer type this milestone can touch is exactly one byte:
// utinyint, tinyint, and bool (storageBytes special-cases bool to 1). Wider
// types exist in the language today (usmallint and up) but arithmetic on
// them is milestone 8's job — a program that reaches for one here gets a
// build error naming the type, not a truncated wrong answer.
function require8Bit(type: string | undefined, what: string): void {
  if (type === undefined) throw new LowerError(`${what}: no type on this IR node — the checker/linker should have set one`);
  if (storageBytes(type) !== 1) {
    throw new LowerError(`${what} is '${type}' (${storageBytes(type)} bytes): only 8-bit arithmetic and locals are implemented yet (16-bit values land at milestone 8)`);
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
  loops: { continueLabel: string; breakLabel: string }[] = [];
  exitLabel = freshLabel('exit');

  constructor(options: LowerOptions) {
    this.symbols = new Map(options.globals);
    this.locals = options.locals;
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
        this.emit(ldaZp(this.binding(node.name!).address));
        return;
      case 'binop':
        this.binop(node);
        return;
      case 'unop':
        this.unop(node);
        return;
      default:
        throw new LowerError(`no instruction-selection rule yet for the '${node.kind}' expression — it lands in a later milestone`);
    }
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
    const mark = this.locals.mark();
    const temp = this.emitOperands(node.left!, node.right!, `'${node.operator}'`);
    this.emit(cmpZp(temp));
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
        // e` never widens or coerces (the front end doesn't emit that), so
        // a 16-bit target would otherwise silently take only e's low byte.
        // widerOf() only ever widens on `+=`-style compound assignment
        // (already folded into a binop by the time this IR exists), so
        // this is the one place plain assignment's own width has to be
        // checked explicitly.
        const binding = this.binding(node.target!);
        require8Bit(binding.type, `assignment to '${node.target}'`);
        this.expr(node.value!);
        this.emit(staZp(binding.address));
        return null;
      }
      case 'local': {
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
        if (node.value !== null && node.value !== undefined) {
          throw new LowerError(`'return' with a value isn't lowered yet — it needs a calling convention (milestone 7); a bare 'return;' works today`);
        }
        this.emit(jmp(this.exitLabel));
        return null;
      default:
        throw new LowerError(`no instruction-selection rule yet for the '${node.kind}' statement — it lands in a later milestone`);
    }
  }

  memoryWrite(statement: IrStatement): void {
    const { address, value } = statement;
    if (!address || address.kind !== 'const') {
      throw new LowerError(`memoryWrite: the address must be a literal for now (got '${address?.kind ?? 'nothing'}') — a computed address needs indexed stores, milestone 8's job`);
    }
    if (!value) throw new LowerError('memoryWrite: no value to write');
    // The value no longer has to be a literal (milestone 4's own
    // restriction) — a sum computed through a real loop and written once
    // to a fixed screen cell is exactly what this milestone's own gate
    // asks for. Only the *address* stays a literal until milestone 8.
    this.expr(value);
    const target = address.value!;
    const mode = target <= 0xff ? 'zeropage' : 'absolute';
    this.emit(instr('STA', mode, target));
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
