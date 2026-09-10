// Instruction selection: linked IR in, wasm instruction bytes out. Milestone
// 2 of the web track ("arithmetic and control flow") — the mos backend's
// milestones 6 and 8 collapsed into one, since wasm has no register-width
// split to force them apart (see "Hello, WASM"'s own WHY section). Every
// value-producing node lowers to `i32` — the widest declared type
// (`int`/`uint`, 32 bits) is exactly `i32`'s own width, and everything
// narrower is masked to its declared width right after the operation that
// produced it (`maskToType` below), never lazily at the point it's read.
// That one invariant is what stands in for the mos backend's own zero-page
// wraparound-for-free: a `utinyint`'s value is always already in 0-255 by
// the time anything downstream reads it.
//
// Scope, refused by name below: `*`/`/`/`%` and every bitwise/shift operator
// (`&` `|` `^` `<<` `>>`) — wasm has real hardware for all of these (a
// genuine advantage over the 6502, which only lacks `*`/`/`/`%`), but
// nothing in this milestone's own gate (a for-loop sum) needs them, and
// adding them un-asked-for is scope this milestone doesn't need to carry.
// Ordering comparisons (`<` `>` `<=` `>=`) on a signed operand, and any
// arithmetic whose result type is signed and narrower than 32 bits, are
// refused the same way the mos backend still refuses them — a real,
// unresolved gap on both backends, not something to guess a masking rule
// for here.
import { resolveIntegerType } from '../types/index.mjs';
import { BlockType, Opcode, ValType, signedLEB128, unsignedLEB128 } from './encode.ts';

export interface IrExpr {
  kind: string;
  value?: number;
  type?: string | null;
  name?: string;
  operator?: string;
  left?: IrExpr;
  right?: IrExpr;
  argument?: IrExpr;
}

export interface IrStatement {
  kind: string;
  // assign
  target?: string;
  value?: IrExpr | null;
  // local's own initializer (IrExpr) and for's own init clause (IrStatement,
  // a `local` or an `assign`) — the same field name on both real IR node
  // shapes (ir/index.mjs), so this has to be the loose union rather than
  // two fields, the same overload mos/lower/index.ts's own IrStatement has.
  name?: string;
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
}

/** Thrown internally for any construct this milestone doesn't lower yet, and
 * caught once at `lower()`'s own boundary — an implementation convenience
 * local to this file, not a change to the exported `{ ok, error }` contract
 * every backend in this repository returns. */
class LowerError extends Error {}

interface Ctx {
  /** Every name currently in scope, to its wasm local index. Block-scoped
   * via snapshot/restore (`scoped()` below) — never popped by freeing an
   * index, since wasm locals aren't a scarce resource the way 6502 zero
   * page is (see "Hello, WASM"'s own "globals need no allocator" note): a
   * declaration always gets a fresh index, permanently, even one it only
   * needed for one loop iteration. */
  locals: Map<string, number>;
  /** The next unused local index — monotonic across the whole function,
   * unlike `locals` itself. */
  nextLocal: number;
  /** One entry per currently-open `if`, or per currently-open loop's own
   * three wasm constructs (its outer `block`, the `loop` itself, and the
   * inner `block` wrapping its body) — every entry a `br`/`br_if` might
   * need to count past, in emission order (oldest/outermost first). Only
   * `'break'` and `'continue'` entries are ever a real target; `'plain'`
   * entries (a bare `if`, or a loop's own middle `loop` construct) exist
   * purely so the depth count coming from deeper inside is correct. */
  controlStack: Array<'break' | 'continue' | 'plain'>;
}

function i32Const(n: number): number[] {
  return [Opcode.i32Const, ...signedLEB128(n)];
}

/** Masks a just-computed `i32` result down to `type`'s own declared width —
 * the one point this file ever narrows a value, so every later read of it
 * (a `ref`, a comparison, another arithmetic op) can trust it's already in
 * range. `int`/`uint` (32 bits) and `bool` need nothing: `i32` already is
 * exactly 32 bits, two's-complement wraparound already matches signed
 * 32-bit arithmetic, and a `bool` result (a comparison, `!`) is already
 * exactly 0 or 1 by construction. A signed type narrower than 32 bits would
 * need sign-extension after masking, not just an `and` — refused by name,
 * the same real gap the mos backend still carries. */
function maskToType(code: number[], type: string | null | undefined): number[] {
  if (!type || type === 'bool') return code;
  const info = resolveIntegerType(type);
  if (!info || info.bits === 32) return code;
  if (info.signed) {
    throw new LowerError(`arithmetic producing a signed '${type}' (narrower than 32 bits) is not lowered yet — only unsigned narrower types are masked so far`);
  }
  return [...code, ...i32Const(2 ** info.bits - 1), Opcode.i32And];
}

const UNSIGNED_ORDERING: Readonly<Record<string, number>> = {
  '<': Opcode.i32LtU, '>': Opcode.i32GtU, '<=': Opcode.i32LeU, '>=': Opcode.i32GeU,
};
const EQUALITY: Readonly<Record<string, number>> = { '==': Opcode.i32Eq, '!=': Opcode.i32Ne };

function operandIsSigned(node: IrExpr): boolean {
  const type = node.type;
  if (!type || type === 'bool') return false;
  const info = resolveIntegerType(type);
  return info?.signed ?? false;
}

function binop(node: IrExpr, ctx: Ctx): number[] {
  const operator = node.operator!;
  const left = node.left!;
  const right = node.right!;

  if (operator === '&&' || operator === '||') {
    // Left-to-right, short-circuit: `right` is only ever evaluated when its
    // value can actually change the result — the same evaluation-order
    // discipline the mos backend holds itself to, here for free from a
    // single-result `if`/`else`.
    const a = expr(left, ctx);
    const b = expr(right, ctx);
    // Unlike every other structured construct in this file, this `if` is
    // itself a value-producing expression — its blocktype has to be
    // `ValType.i32`, not `BlockType.empty`, or the validator sees a value
    // pushed inside a block declared to leave none.
    if (operator === '&&') return [...a, Opcode.if, ValType.i32, ...b, Opcode.else, ...i32Const(0), Opcode.end];
    return [...a, Opcode.if, ValType.i32, ...i32Const(1), Opcode.else, ...b, Opcode.end];
  }
  if (operator in EQUALITY) {
    return [...expr(left, ctx), ...expr(right, ctx), EQUALITY[operator]];
  }
  if (operator in UNSIGNED_ORDERING) {
    if (operandIsSigned(left) || operandIsSigned(right)) {
      throw new LowerError(`'${operator}' on a signed value is not lowered yet — only unsigned ordering comparisons are`);
    }
    return [...expr(left, ctx), ...expr(right, ctx), UNSIGNED_ORDERING[operator]];
  }
  if (operator === '+' || operator === '-') {
    const code = [...expr(left, ctx), ...expr(right, ctx), operator === '+' ? Opcode.i32Add : Opcode.i32Sub];
    return maskToType(code, node.type);
  }
  throw new LowerError(`'${operator}' is not lowered yet`);
}

function unop(node: IrExpr, ctx: Ctx): number[] {
  const operator = node.operator!;
  const argument = node.argument!;
  if (operator === '!') return [...expr(argument, ctx), Opcode.i32Eqz];
  if (operator === '+') return expr(argument, ctx);
  if (operator === '-') return maskToType([...i32Const(0), ...expr(argument, ctx), Opcode.i32Sub], node.type);
  if (operator === '~') return maskToType([...expr(argument, ctx), ...i32Const(-1), Opcode.i32Xor], node.type);
  throw new LowerError(`'${operator}' is not lowered yet`);
}

function expr(node: IrExpr, ctx: Ctx): number[] {
  if (node.kind === 'const') return i32Const(node.value!);
  if (node.kind === 'ref') {
    const index = ctx.locals.get(node.name!);
    if (index === undefined) throw new LowerError(`'${node.name}' is not a lowered local — globals and parameters aren't lowered yet`);
    return [Opcode.localGet, ...unsignedLEB128(index)];
  }
  if (node.kind === 'binop') return binop(node, ctx);
  if (node.kind === 'unop') return unop(node, ctx);
  throw new LowerError(unsupported(node.kind));
}

const MILESTONE_OF: Readonly<Record<string, string>> = {
  memoryRead: 'milestone 3 ("globals and memory")',
  memoryWrite: 'milestone 3 ("globals and memory")',
  call: 'milestone 4 ("functions and calls")',
  namespaceCall: 'milestone 4 ("functions and calls")',
  string: 'milestone 5 ("strings and const data")',
  stringByte: 'milestone 5 ("strings and const data")',
  stringLength: 'milestone 5 ("strings and const data")',
  stringCopy: 'milestone 5 ("strings and const data")',
  namespaceConst: 'milestone 5 ("strings and const data")',
  index: 'milestone 5 ("strings and const data")',
  storeIndex: 'milestone 5 ("strings and const data")',
  waitFrame: 'milestone 6 ("waitFrame(), and the real Hello World")',
};

function unsupported(kind: string): string {
  const milestone = MILESTONE_OF[kind];
  if (milestone) return `'${kind}' is not lowered yet — the web track's own ${milestone}`;
  if (kind === 'asm') return "'asm' blocks are 6502-specific machine code and are never lowered on the web target";
  return `'${kind}' is not lowered yet`;
}

/** Runs `body` in a fresh name scope: declarations made inside are gone
 * once it returns, and any name they shadowed is visible again — the same
 * restore-after-exit discipline the mos backend's own `LocalAllocator`
 * holds itself to for its zero-page addresses, done here with a plain
 * snapshot since wasm local *indices* are never reused. */
function scoped(body: IrStatement[], ctx: Ctx): number[] {
  const snapshot = new Map(ctx.locals);
  const code = statements(body, ctx);
  ctx.locals = snapshot;
  return code;
}

/** A `while`, or a `for`'s own loop half (`update` is null for a `while`;
 * `test` is null for a `for (;;)`, meaning "always true" — `while`'s own
 * grammar never omits it, but nothing stops treating both uniformly): an
 * outer `block` (the `break` target), a `loop` around the test and body,
 * and an inner `block` wrapping the body (the `continue` target) so that
 * `continue` still runs `update` before looping back, exactly the way a
 * bare `continue` in a real `for` loop has to. */
function loop(test: IrExpr | null, body: IrStatement[], update: IrStatement | null, ctx: Ctx): number[] {
  ctx.controlStack.push('break', 'plain', 'continue');
  const bodyCode = scoped(body, ctx);
  ctx.controlStack.pop(); // continue
  const updateCode = update ? statement(update, ctx) : [];
  ctx.controlStack.pop(); // plain (the loop itself)
  ctx.controlStack.pop(); // break
  const testCode = test ? expr(test, ctx) : i32Const(1);
  return [
    Opcode.block, BlockType.empty,
    Opcode.loop, BlockType.empty,
    ...testCode, Opcode.i32Eqz, Opcode.brIf, ...unsignedLEB128(1),
    Opcode.block, BlockType.empty,
    ...bodyCode,
    Opcode.end,
    ...updateCode,
    Opcode.br, ...unsignedLEB128(0),
    Opcode.end,
    Opcode.end,
  ];
}

/** The relative `br` depth for the nearest enclosing loop's `break` or
 * `continue` target: how many currently-open constructs (recorded in
 * `ctx.controlStack`, innermost last) sit between here and it. */
function loopDepth(ctx: Ctx, target: 'break' | 'continue'): number {
  for (let i = ctx.controlStack.length - 1; i >= 0; i--) {
    if (ctx.controlStack[i] === target) return ctx.controlStack.length - 1 - i;
  }
  throw new LowerError(`'${target}' outside a loop`);
}

function statement(node: IrStatement, ctx: Ctx): number[] {
  if (node.kind === 'local') {
    const index = ctx.nextLocal++;
    ctx.locals.set(node.name!, index);
    // Always sets, even for the implicit `{ kind: 'const', value: 0, ... }`
    // a declaration with no `= ...` lowers to (ir/index.mjs's own
    // `local()`). wasm locals do start at 0, but only once, at function
    // entry — a declaration inside any loop's own body (including a for
    // loop's own `init`, when that for loop is itself nested in another
    // loop) is reached again on every dynamic iteration of whatever
    // encloses it, and its wasm local index still holds whatever the
    // previous iteration left there. Skipping the reset for exactly the
    // zero-init case looked free and cost a real bug: a nested for loop's
    // own counter silently kept its old end-of-loop value on the second
    // trip through the outer loop, so it never ran again.
    return [...expr(node.init as IrExpr, ctx), Opcode.localSet, ...unsignedLEB128(index)];
  }
  if (node.kind === 'assign') {
    const index = ctx.locals.get(node.target!);
    if (index === undefined) throw new LowerError(`'${node.target}' is not a lowered local — globals aren't lowered yet`);
    return [...expr(node.value!, ctx), Opcode.localSet, ...unsignedLEB128(index)];
  }
  if (node.kind === 'block') return scoped(node.body ?? [], ctx);
  if (node.kind === 'if') {
    const testCode = expr(node.test!, ctx);
    ctx.controlStack.push('plain');
    const thenCode = scoped(node.then ?? [], ctx);
    const elseCode = node.else ? scoped(node.else, ctx) : null;
    ctx.controlStack.pop();
    if (elseCode) return [...testCode, Opcode.if, BlockType.empty, ...thenCode, Opcode.else, ...elseCode, Opcode.end];
    return [...testCode, Opcode.if, BlockType.empty, ...thenCode, Opcode.end];
  }
  if (node.kind === 'while') return loop(node.test ?? null, node.body ?? [], null, ctx);
  if (node.kind === 'for') {
    // The init's own declaration (if any) outlives every iteration and the
    // loop's own test/update, unlike a `local` declared inside the body —
    // so it gets the whole statement's own scope, snapshotted once, not
    // `loop()`'s per-iteration one.
    const snapshot = new Map(ctx.locals);
    const init = node.init as IrStatement | null;
    const initCode = init ? statement(init, ctx) : [];
    const code = [...initCode, ...loop(node.test ?? null, node.body ?? [], node.update ?? null, ctx)];
    ctx.locals = snapshot;
    return code;
  }
  if (node.kind === 'break') return [Opcode.br, ...unsignedLEB128(loopDepth(ctx, 'break'))];
  if (node.kind === 'continue') return [Opcode.br, ...unsignedLEB128(loopDepth(ctx, 'continue'))];
  if (node.kind === 'return') return node.value ? [...expr(node.value, ctx), Opcode.return] : [Opcode.return];
  throw new LowerError(unsupported(node.kind));
}

function statements(body: IrStatement[], ctx: Ctx): number[] {
  return body.flatMap((node) => statement(node, ctx));
}

export interface LowerResult {
  ok: true;
  /** Instruction bytes only — not the function body's own trailing `end`, which the caller (wasm/index.ts) appends alongside the locals-declaration vector this needs (`localCount`). */
  code: number[];
  /** How many `i32` locals this body's own `local` declarations need, beyond whatever parameters the caller already gave indices to. */
  localCount: number;
}
export interface LowerFailure {
  ok: false;
  error: string;
}

/** Lowers a function body to wasm instruction bytes. `paramCount` is where
 * this body's own locals start numbering from — wasm gives a function's
 * parameters local indices `0..paramCount-1` automatically from its type,
 * so a body with parameters (milestone 4) needs its own declared locals to
 * start right after them. Defaults to 0: nothing lowered yet has any. */
export function lower(body: IrStatement[], paramCount = 0): LowerResult | LowerFailure {
  const ctx: Ctx = { locals: new Map(), nextLocal: paramCount, controlStack: [] };
  try {
    const code = statements(body, ctx);
    return { ok: true, code, localCount: ctx.nextLocal - paramCount };
  } catch (error) {
    if (error instanceof LowerError) return { ok: false, error: error.message };
    throw error;
  }
}
