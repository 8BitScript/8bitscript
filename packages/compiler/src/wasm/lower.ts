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
// Scope, refused by name below: `*` — wasm has real hardware for this too
// (`i32.mul`), but nothing built so far needs it. `/`/`%` are lowered
// (milestone 5, unsigned only — `i32.div_u`/`i32.rem_u`), added when
// linking `@8bitscript/text` turned out to always pull in `printNumber`'s
// own body, which uses both, whether a program calls it or not (the linker
// links every function a namespace import declares — no reachability
// pruning). `&`/`|`/`^`/`<<`/unsigned `>>` are lowered too (`i32.and`/
// `i32.or`/`i32.xor`/`i32.shl`/`i32.shr_u`), added when
// `@8bitscript/web/screen.8bs`'s own `setColors` turned out to mask every
// color byte with `& 15` — the first real caller, after every earlier
// milestone deliberately deferred these as "real hardware exists, nothing
// needs it yet." Ordering comparisons (`<` `>` `<=` `>=`) on a signed
// operand, signed `>>` (arithmetic vs. logical shift are different
// instructions here), and any arithmetic whose result type is signed and
// narrower than 32 bits, are refused the same way the mos backend still
// refuses them — a real, unresolved gap on both backends, not something to
// guess a masking rule for here.
//
// `waitFrame()` (milestone 6) is the one statement kind that isn't really
// "instruction selection" at all: it always lowers to the same one
// instruction, a `call` to whatever function index `build()` assigned the
// `env.waitFrame` import — see `Ctx.waitFrameIndex`.
import { resolveIntegerType } from '../types/index.mjs';
import { BlockType, Opcode, ValType, memarg, signedLEB128, unsignedLEB128 } from './encode.ts';

export interface IrExpr {
  kind: string;
  value?: number;
  type?: string | null;
  name?: string;
  operator?: string;
  left?: IrExpr;
  right?: IrExpr;
  argument?: IrExpr;
  // memoryRead
  address?: IrExpr;
  // call
  args?: IrExpr[];
  // string, stringByte, stringLength
  index?: number | IrExpr;
  string?: IrExpr;
  // index (array read): the array itself, by name (a `ref` with no type
  // of its own — this file looks it up in `ctx.arrays`, not `ctx.locals`/
  // `ctx.globals`, since an array isn't a scalar binding)
  array?: IrExpr;
  // index's own elementType (ir/index.mjs's own field, carried here for a
  // faithful real-shape fixture) — unread: `ctx.arrays` already knows an
  // array's own element width from the global that declared it.
  elementType?: string | null;
}

export interface IrStatement {
  kind: string;
  // assign; memoryWrite's own value (ir/index.mjs: memory.write's second
  // argument) — the same field name on both real IR node shapes.
  target?: string;
  value?: IrExpr | null;
  // memoryWrite
  address?: IrExpr;
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
  // call, reached in statement position — the same node shape as an
  // IrExpr's own 'call' (ir/index.mjs's own `statementExpression`: a call
  // used as a statement is the same object, its result just never read).
  args?: IrExpr[];
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
  /** Every non-pinned scalar global, to its wasm global-section index —
   * fixed once by `build()` before this file ever runs, in declaration
   * order, never reallocated (see "Hello, WASM"'s own "globals need no
   * allocator" note: a wasm global index isn't carved from a scarce
   * range the way a 6502 zero-page address is). Checked only when a name
   * isn't in `locals` — a `local` is free to shadow a global of the same
   * name, the same precedence the front end itself already allows. */
  globals: Map<string, number>;
  /** One entry per currently-open `if`, or per currently-open loop's own
   * three wasm constructs (its outer `block`, the `loop` itself, and the
   * inner `block` wrapping its body) — every entry a `br`/`br_if` might
   * need to count past, in emission order (oldest/outermost first). Only
   * `'break'` and `'continue'` entries are ever a real target; `'plain'`
   * entries (a bare `if`, or a loop's own middle `loop` construct) exist
   * purely so the depth count coming from deeper inside is correct. */
  controlStack: Array<'break' | 'continue' | 'plain'>;
  /** Every function this module defines, name to its own wasm function
   * index (assigned once, up front, by `build()` — before any body is
   * lowered, so a call can resolve a function declared later in the file,
   * or itself: nothing here refuses recursion the way the mos backend
   * still does. Recursion is free on wasm — a real call stack, not a
   * shared zero-page frame every recursive call would fight over — so
   * this backend allows it rather than porting mos's own cycle check for
   * target parity it doesn't structurally need; see "Hello, WASM"'s own
   * "recursion" decision). */
  functions: Map<string, { index: number; paramCount: number; returnsValue: boolean }>;
  /** Every string literal's own linear-memory address, by its index in
   * `ir.strings` — `build()`'s own job to lay out, once, before any body
   * is lowered (the same two-pass shape as `globals`/`functions`). A
   * `string` value at runtime is just this address: a pointer to its own
   * one-byte length prefix followed by its characters (ir/index.mjs's own
   * string-table format), so a `string` parameter needs no lowering rule
   * of its own beyond the one every other `i32`-valued parameter already
   * gets. */
  strings: number[];
  /** Every const array this module declares, name to its own linear-memory
   * address and element width — `build()`'s own job to assign, same two-
   * pass shape. Only 1-byte elements are lowered yet (utinyint/bool); a
   * 2-byte element type is refused by name where it's read, not guessed
   * at here. */
  arrays: Map<string, { address: number; elementWidth: number }>;
  /** The imported `env.waitFrame`'s own wasm function index — always 0
   * when set, since it's the only import this backend ever declares and
   * an import always occupies the function index space ahead of every
   * function the module defines. `null` when the program never calls
   * waitFrame() at all: `build()` only declares the import when a scan of
   * the whole program finds a `waitFrame` node, the same "pay only for
   * what you use" rule every other section already follows. */
  waitFrameIndex: number | null;
}

function i32Const(n: number): number[] {
  return [Opcode.i32Const, ...signedLEB128(n)];
}

/** `name`'s own get/set instruction pair — `local.get`/`local.set` when
 * it's currently a local (checked first, so a `local` can shadow a
 * global), `global.get`/`global.set` when it's a global; throws naming
 * the parameter/global gap this milestone doesn't cover yet otherwise. */
function binding(ctx: Ctx, name: string): { get: number; set: number; index: number } {
  const local = ctx.locals.get(name);
  if (local !== undefined) return { get: Opcode.localGet, set: Opcode.localSet, index: local };
  const global = ctx.globals.get(name);
  if (global !== undefined) return { get: Opcode.globalGet, set: Opcode.globalSet, index: global };
  throw new LowerError(`'${name}' is not a lowered local or global — parameters aren't lowered yet`);
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
  if (operator === '/' || operator === '%') {
    // Real hardware for this, unlike the mos backend (which subtracts to
    // avoid needing a divide routine — see "Hello, WASM"'s own WHY
    // section): `i32.div_u`/`i32.rem_u` is the whole lowering. Only
    // unsigned so far, the same restriction every other width-sensitive
    // operator here carries — `printNumber`'s own `value % 10` and
    // `value / 10` (packages/web/src/text.8bs) are both unsigned, and
    // nothing has tested a signed divide against this backend yet.
    if (operandIsSigned(left) || operandIsSigned(right)) {
      throw new LowerError(`'${operator}' on a signed value is not lowered yet — only unsigned '/'/'%' are`);
    }
    const code = [...expr(left, ctx), ...expr(right, ctx), operator === '/' ? Opcode.i32DivU : Opcode.i32RemU];
    return maskToType(code, node.type);
  }
  if (operator === '&' || operator === '|' || operator === '^') {
    // Real hardware for these too, and none of the signed-vs-unsigned
    // trouble '/'/'%'/orderings carry: a bitwise op reads the same two's-
    // complement bits regardless of which type they're declared as, so
    // there's nothing here to refuse by sign — only the usual post-op
    // width mask, the same as '+'/'-'. This was scope nothing built so
    // far needed until screen.blank() (@8bitscript/web/screen.8bs's own
    // setColors, masking a color byte with `& 15`) became the first real
    // caller — see "Hello, WASM"'s own note on why this waited.
    const opcode = operator === '&' ? Opcode.i32And : operator === '|' ? Opcode.i32Or : Opcode.i32Xor;
    const code = [...expr(left, ctx), ...expr(right, ctx), opcode];
    return maskToType(code, node.type);
  }
  if (operator === '<<' || operator === '>>') {
    // `<<` doesn't care how its own left operand is declared — the same
    // bits shift out either way — but `>>` does: wasm's `i32.shr_s` and
    // `i32.shr_u` are different instructions (arithmetic vs. logical
    // shift), and only the unsigned one is wired up so far, the same
    // "refuse the signed case by name" rule every other width-sensitive
    // operator here already follows.
    if (operator === '>>' && operandIsSigned(left)) {
      throw new LowerError("'>>' on a signed value is not lowered yet — only unsigned '>>' is");
    }
    const opcode = operator === '<<' ? Opcode.i32Shl : Opcode.i32ShrU;
    const code = [...expr(left, ctx), ...expr(right, ctx), opcode];
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

/** `name`'s own entry in `ctx.functions`, or throws — a call the linker
 * already resolved (a plain `call`, or a `namespaceCall` it rewrote into
 * one) naming nothing this file's own function-index map knows about is a
 * linker bug, not a missing lowering rule, the same distinction mos's own
 * `callSite` draws. */
function callTarget(ctx: Ctx, name: string): { index: number; paramCount: number; returnsValue: boolean } {
  const target = ctx.functions.get(name);
  if (!target) {
    throw new LowerError(`call to '${name}' resolves to nothing this backend knows about — a linker bug, not a missing lowering rule`);
  }
  return target;
}

/** Every argument, left-to-right, straight onto the operand stack — no
 * per-parameter storage step the way mos's own `callSite` needs (its
 * arguments land in the callee's zero-page slots one at a time so a
 * nested call inside an argument can't clobber a shared temporary): wasm's
 * own `call` instruction already pops its arguments off the stack in the
 * order the callee's function type declares them, so pushing them in
 * source order is the whole calling convention. */
function callSite(node: { name?: string; args?: IrExpr[] }, ctx: Ctx): number[] {
  const target = callTarget(ctx, node.name!);
  const args = node.args ?? [];
  if (args.length !== target.paramCount) {
    throw new LowerError(`call to '${node.name}': ${args.length} argument(s) but the function has ${target.paramCount} parameter(s) — the linker should already have matched these`);
  }
  return [...args.flatMap((a) => expr(a, ctx)), Opcode.call, ...unsignedLEB128(target.index)];
}

function expr(node: IrExpr, ctx: Ctx): number[] {
  if (node.kind === 'const') return i32Const(node.value!);
  if (node.kind === 'ref') {
    const b = binding(ctx, node.name!);
    return [b.get, ...unsignedLEB128(b.index)];
  }
  if (node.kind === 'binop') return binop(node, ctx);
  if (node.kind === 'unop') return unop(node, ctx);
  if (node.kind === 'memoryRead') {
    // memory.read is byte-only at the language level (ir/index.mjs's own
    // memoryIntrinsic()) — i32.load8_u zero-extends the one byte to i32,
    // exactly matching memoryRead's own fixed `utinyint` type.
    return [...expr(node.address!, ctx), Opcode.i32Load8U, ...memarg(0, 0)];
  }
  if (node.kind === 'call') return callSite(node, ctx);
  if (node.kind === 'string') {
    const slot = node.index as number;
    const address = ctx.strings[slot];
    if (address === undefined) throw new LowerError(`string literal #${slot} resolves to nothing this backend knows about — a linker bug, not a missing lowering rule`);
    return i32Const(address);
  }
  if (node.kind === 'stringLength') {
    // Byte 0 of the string's own data, through whatever expression names
    // it — a literal's own fixed address, or a parameter's own local
    // (which holds that same kind of address, passed in).
    return [...expr(node.string!, ctx), Opcode.i32Load8U, ...memarg(0, 0)];
  }
  if (node.kind === 'stringByte') {
    // Byte `index + 1` — skipping the one-byte length prefix, the same
    // "index+1" mos's own stringByte reads (see its own lower/index.ts
    // comment). Both the string's own address and the index can be
    // dynamic, so unlike a const array's own fixed-address read below,
    // this can't fold into memarg's own constant offset alone — only the
    // "+1" for the length prefix does.
    return [...expr(node.string!, ctx), ...expr(node.index as IrExpr, ctx), Opcode.i32Add, Opcode.i32Load8U, ...memarg(0, 1)];
  }
  if (node.kind === 'index') {
    const name = node.array!.name!;
    const array = ctx.arrays.get(name);
    if (!array) throw new LowerError(`'${name}' is not a lowered const array — reading an array element only works on this module's own const array today`);
    if (array.elementWidth !== 1) throw new LowerError(`'${name}': a ${array.elementWidth}-byte array element is not lowered yet — only 1-byte (utinyint/bool) array elements are`);
    // The array's own base address is already a compile-time constant, so
    // it folds straight into the load's own memarg offset — no runtime
    // add needed, the same trick `stringLength` and a literal-address
    // `memoryRead` both get for free from wasm's own instruction shape.
    return [...expr(node.index as IrExpr, ctx), Opcode.i32Load8U, ...memarg(0, array.address)];
  }
  throw new LowerError(unsupported(node.kind));
}

/** Every IR statement/expression kind the real front end can produce is
 * handled somewhere above as of milestone 6 — `asm`/`stringCopy`/
 * `storeIndex` are real, named, permanent-or-still-open gaps (not
 * milestone numbers to catch up to), and anything else reaching here is
 * either a genuinely unknown kind (a fixture, or a future front-end
 * addition this file hasn't caught up to yet) or a linker bug
 * (`namespaceCall` never survives linking — see `callTarget`'s own doc). */
function unsupported(kind: string): string {
  if (kind === 'asm') return "'asm' blocks are 6502-specific machine code and are never lowered on the web target";
  if (kind === 'stringCopy') return "'stringCopy' (a string<N> assignment) is not lowered yet — it needs a RAM buffer address for the target, a real gap milestone 5 left open";
  if (kind === 'storeIndex') return "'storeIndex' (writing an array element) is not lowered yet for a RAM (`let`) or hardware (`@address`) array — only reading a `const` array is, milestone 5's own scope";
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
    const b = binding(ctx, node.target!);
    return [...expr(node.value!, ctx), b.set, ...unsignedLEB128(b.index)];
  }
  if (node.kind === 'memoryWrite') {
    // Address, then value, matching store8's own stack order — and no
    // masking on the value: i32.store8 already writes only the low byte,
    // and memory.write's own value argument is always utinyint (byte-only
    // at the language level) regardless.
    return [...expr(node.address!, ctx), ...expr(node.value!, ctx), Opcode.i32Store8, ...memarg(0, 0)];
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
  if (node.kind === 'call') {
    const code = callSite(node, ctx);
    // Reached as a statement: the front end already type-checked this
    // call as an expression-statement (its value, if any, discarded) —
    // ir/index.mjs's own `statementExpression`. wasm's own type system
    // doesn't discard for free the way a caller-ignores-A convention
    // would on 6502: the callee's function type still pushes a result,
    // and a value left on the stack at the end of a block the validator
    // expects empty is a validation error, not a silent no-op. `drop`
    // says explicitly what mos gets for nothing.
    return callTarget(ctx, node.name!).returnsValue ? [...code, Opcode.drop] : code;
  }
  if (node.kind === 'waitFrame') {
    // `waitFrame()` has no IR fields of its own (ir/index.mjs's own
    // `{ kind: 'waitFrame' }`) and always lowers to a call with no
    // arguments — build() already scanned the whole program for this
    // kind before lowering anything, so `waitFrameIndex` being unset here
    // would be that scan disagreeing with what's actually in the tree, a
    // build() bug rather than a missing lowering rule.
    if (ctx.waitFrameIndex === null) throw new LowerError("'waitFrame' reached lowering with no import declared — a build() bug, not a missing lowering rule");
    return [Opcode.call, ...unsignedLEB128(ctx.waitFrameIndex)];
  }
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

export interface LowerOptions {
  /** This body's own parameters, in declaration order. wasm gives a
   * function's parameters local indices `0..params.length-1` automatically
   * from its own type — so unlike every other local (declared by its own
   * `local` statement, as `statement()` reaches it), a parameter needs its
   * name seeded into `ctx.locals` before the body is lowered at all: the
   * first `ref` to it has no declaration of its own to have done that.
   * Defaults to `[]`: nothing lowered before milestone 4 has any. */
  params?: { name: string; type: string }[];
  /** Every non-pinned scalar global already in scope, name to wasm
   * global-section index — `build()`'s own job to assign, in declaration
   * order, before any function body is lowered (mirroring the two-pass
   * shape mos/index.ts holds itself to for parameters: an address has to
   * be known before anything that might reference it is lowered). */
  globals?: Map<string, number>;
  /** Every function this module defines, name to its own wasm function
   * index and calling shape — `build()`'s own job to assign, once, up
   * front, before any body is lowered (the same two-pass shape as
   * `globals`, and the reason a call can reach a function declared later
   * in the file, or itself). */
  functions?: Map<string, { index: number; paramCount: number; returnsValue: boolean }>;
  /** Every string literal's own linear-memory address, by its own index in
   * `ir.strings` — `build()`'s own job to lay out, once, up front. */
  strings?: number[];
  /** Every const array this module declares, name to its own linear-memory
   * address and element width — `build()`'s own job to assign, once, up
   * front. */
  arrays?: Map<string, { address: number; elementWidth: number }>;
  /** The imported `env.waitFrame`'s own wasm function index — `build()`'s
   * own job to assign (always 0, when assigned at all) once, up front,
   * from the same whole-program scan that decides whether to declare the
   * import section entry in the first place. `null` (the default) when
   * the program never calls waitFrame() anywhere. */
  waitFrameIndex?: number | null;
}

/** Lowers a function body to wasm instruction bytes. */
export function lower(body: IrStatement[], options: LowerOptions = {}): LowerResult | LowerFailure {
  const params = options.params ?? [];
  const locals = new Map(params.map((p, i) => [p.name, i]));
  const ctx: Ctx = {
    locals,
    nextLocal: params.length,
    controlStack: [],
    globals: options.globals ?? new Map(),
    functions: options.functions ?? new Map(),
    strings: options.strings ?? [],
    arrays: options.arrays ?? new Map(),
    waitFrameIndex: options.waitFrameIndex ?? null,
  };
  try {
    const code = statements(body, ctx);
    return { ok: true, code, localCount: ctx.nextLocal - params.length };
  } catch (error) {
    if (error instanceof LowerError) return { ok: false, error: error.message };
    throw error;
  }
}
