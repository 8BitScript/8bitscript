// Pre-lowering IR rewrites that drop work the machine will never do.
//
// Called from each backend's build() via optimizeReachable(), after
// link() — never from link() itself. checkHardwareHazards must still see
// a write that lives only in a dead `if (false)` branch; folding that
// branch away here would hide an 8BS3003. The backends run this after
// that check, so a fact-folded `#fact(...)` branch costs the unused side
// nothing, which is the contract AGENTS.md and the `#fact` hover already
// state. optimizeReachable prunes first so a write in a function the
// entry never calls (hello-world's setReverse) does not keep that
// global in RAM.
//
// Rewrites, measured on hello-world's PET build (835 program / 49 zp
// before this pass, 331 / 8 after):
//
//   1. Constant `if`: `#fact` and `const == const` become a boolean, the
//      taken branch stays, the other is gone, and statements after a
//      definite `return` go with it. asciiToScreenCode was 164 bytes
//      because both character-ROM layouts compiled; only one can run.
//   2. Immutable globals: a `let` that is never assigned (only read) is
//      its initializer, inlined, in any function that does not bind the
//      same name as a parameter or local.
//   3. Unsigned arithmetic of constants, wrapping at the type's width —
//      `250 + 10` as utinyint is 4, the same answer the backends produce.
//      Signed arithmetic is left alone so the backends can still refuse it.
//   4. A string literal's `.length` and `s[i]` at a constant index are
//      the bytes themselves. Combined with (5) and (6), print of a
//      literal becomes stores of already-converted screen codes — less
//      code and less work per character than calling asciiToScreenCode
//      at run time.
//   5. A call whose every argument is a compile-time value, whose
//      return is one byte, and which has a single call site, and whose
//      body only computes a number, is that number. asciiToScreenCode('e')
//      is 5 on the PET text set. Multi-site helpers and 16-bit returns
//      stay as calls so the calling-convention gates still measure them.
//   6. A void call with compile-time arguments and a non-empty body is
//      inlined when it is a string copy (`stringByte` in the body), when
//      inlining one already (so `place` folds inside an unrolled print),
//      when it takes no parameters, or when its parameters are unused
//      and it has a single call site (PET `blank`'s color args). A
//      `for (i = 0; i < N; i++)` unrolls only when the body is a string
//      copy and N is small.
//   7. A void call whose callee is empty (PET/NES/Atari `text.setColor`,
//      `text.putColor`) is deleted, arguments and all, so a program that
//      colors a cell pays nothing on a machine that cannot. Arguments with
//      side effects keep the call so they still run. Calling-convention
//      fixtures that need the argument shuffle to survive must give the
//      stub a side-effecting body (a store), not `[]` or a bare `return`.
//   8. A forwarder — a body that is exactly one call passing the
//      function's own parameters through (`component Tile(r, c, e) {
//      drawTile(r, c, e); }`, `return random.range(bound);`) — is that
//      call at every site, run-time arguments and all. The site already
//      loads and stores each argument into a parameter slot; pointing
//      those stores at the callee's slots instead costs nothing, and the
//      forwarder's own copies and its `jsr`/`rts` are gone. Spec §30 and
//      §64 promise an element costs what the hand-written call costs; a
//      wrapper with a run-time prop was +36 bytes on the PET 2001 and the
//      VIC-20 (2048 #49), +53 across an import boundary (2048 #45), and a
//      one-line `range()` delegate +8 on five targets, all measured on
//      0.11.0 — this is the rule that makes them zero.
//   9. A function with exactly one live call site is written into that
//      site, whatever its size and whatever its arguments: the body
//      replaces the call, the argument stores, the frame and the `rts`,
//      so it can only get smaller. A run-time argument the callee reads
//      but never assigns is the argument itself (no copy — the store the
//      site made into the parameter slot is the store that is gone); one
//      the body assigns, or whose own variable the body writes, becomes
//      a local. A non-void callee whose only `return` is its last
//      statement is hoisted ahead of the statement that used its value
//      when nothing else in that statement could see the difference
//      (the rest is constants and reads of names the callee never
//      writes); `let r = f(x)` returning one of the callee's own locals
//      keeps that local as `r`. 2048's `paintTile` + `stampValue` +
//      `Tile` measured +56 bytes on every 6502 and +84 on the PET 2001
//      against the one-body `drawTile` (2048 #51) — three real calls
//      with frames where one body was meant; this is the rule that makes
//      the split free. Not inlined: a body with a `return` in a void
//      function (the `f(); return;` idiom keeps a call, same as rule 6),
//      an early return in a non-void one, `asm6502`, and a body whose
//      free names a caller's own local would capture.
//
// Bodies are optimized callees-first (`bottomUpOrder`), so the size that
// decides whether a body is pasted at several sites (rule 6) is the size
// it has once its own callees are inlined into it — not the size it was
// written at. 2048's `Board`, small as written, was under the limit and
// went into `main` three times carrying the whole inlined `ScoreBar`,
// +393 bytes on the PET 2001 (2048 #52).
//
// Does not mutate `ir`.

import { pruneUnreachable } from './reachability.mjs';
import { resolveIntegerType, storageBytes } from '../types/index.mjs';

/** Unroll a literal string copy only while the stores beat a looped print; 32 characters is still smaller than print+place+ascii. */
const MAX_UNROLL = 32;

/**
 * @param {unknown} node
 * @param {Set<string>} out
 */
function collectAssigned(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectAssigned(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    if (node.kind === 'assign' && typeof node.target === 'string') out.add(node.target);
    for (const value of Object.values(node)) collectAssigned(value, out);
  }
}

/**
 * @param {unknown} node
 * @param {Set<string>} out
 */
function collectBoundNames(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectBoundNames(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    if (node.kind === 'local' && typeof node.name === 'string') out.add(node.name);
    for (const value of Object.values(node)) collectBoundNames(value, out);
  }
}

function containsStringByte(node) {
  if (Array.isArray(node)) return node.some(containsStringByte);
  if (!node || typeof node !== 'object') return false;
  if (node.kind === 'stringByte') return true;
  return Object.values(node).some(containsStringByte);
}

/**
 * How many IR nodes a body is made of — a proxy for how much code it will
 * become, used only to decide whether duplicating it at several call sites
 * is cheaper than calling it. Measured on the 6502 backend, a body runs
 * about 1.6 bytes per node (@8bitscript/pet's input.poll(): 117 nodes,
 * 182 bytes).
 */
// Bodies at or under this many IR nodes still inline at several call
// sites: about 13 bytes at the ratio above, which is the neighbourhood
// where a duplicated body and the call it replaces cost the same.
const INLINE_DUPLICATE_NODE_LIMIT = 8;

function nodeCount(node) {
  let n = 0;
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === 'object') {
      n += 1;
      // An argument is not one node's worth of code: the caller loads it
      // and stores it into the callee's slot — 5 bytes for a byte, 8 for
      // a word on the 6502 — where the ref it is written as counts one.
      // Weighting each one like three more nodes puts a body that only
      // passes values along (2048's Board(): the HUD's three values, one
      // more call) past the limit, and it stays the one function it was
      // written as: pasted at three sites it cost 54 bytes where the
      // call and its body cost 31 (measured 2026-09-16, PET 2001).
      if (value.kind === 'call') n += 3 * (value.args?.length ?? 0);
      for (const inner of Object.values(value)) walk(inner);
    }
  };
  walk(node);
  return n;
}

function containsJump(node) {
  if (Array.isArray(node)) return node.some(containsJump);
  if (!node || typeof node !== 'object') return false;
  if (node.kind === 'break' || node.kind === 'continue') return true;
  return Object.values(node).some(containsJump);
}

function containsReturn(node) {
  if (Array.isArray(node)) return node.some(containsReturn);
  if (!node || typeof node !== 'object') return false;
  if (node.kind === 'return') return true;
  return Object.values(node).some(containsReturn);
}

function referencesNames(node, names) {
  if (names.size === 0) return false;
  if (Array.isArray(node)) return node.some((item) => referencesNames(item, names));
  if (!node || typeof node !== 'object') return false;
  if (node.kind === 'ref' && typeof node.name === 'string' && names.has(node.name)) return true;
  if (node.kind === 'assign' && typeof node.target === 'string' && names.has(node.target)) return true;
  return Object.values(node).some((value) => referencesNames(value, names));
}

function wrapUnsigned(value, type) {
  const desc = resolveIntegerType(type);
  if (!desc || desc.signed) return null;
  const mod = desc.max + 1;
  return ((value % mod) + mod) % mod;
}

function isNumericConst(node) {
  return !!node && node.kind === 'const' && typeof node.value === 'number';
}

function isCompileTimeArg(node) {
  if (isNumericConst(node)) return true;
  return !!node && node.kind === 'string' && typeof node.index === 'number';
}

/** Expression kinds with no stores, calls, or hardware reads. */
const PURE_EXPR = new Set(['const', 'ref', 'binop', 'unop', 'index', 'string', 'stringByte', 'stringLength', 'namespaceConst']);

function isSideEffectFree(node) {
  if (Array.isArray(node)) return node.every(isSideEffectFree);
  if (!node || typeof node !== 'object') return true;
  if (!PURE_EXPR.has(node.kind)) return false;
  return Object.values(node).every(isSideEffectFree);
}

function clone(node) {
  return structuredClone(node);
}

/**
 * Comparisons, boolean combinators, and unsigned wrapping +/− of constants.
 *
 * @param {unknown} node
 * @returns {number | null}
 */
function constValue(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.kind === 'const' && typeof node.value === 'number') return node.value;
  if (node.kind === 'unop' && node.operator === '!') {
    const inner = constValue(node.argument);
    if (inner === null) return null;
    return inner ? 0 : 1;
  }
  if (node.kind !== 'binop') return null;
  const left = constValue(node.left);
  const right = constValue(node.right);
  if (left === null || right === null) return null;
  switch (node.operator) {
    case '==': return left === right ? 1 : 0;
    case '!=': return left !== right ? 1 : 0;
    case '<': return left < right ? 1 : 0;
    case '<=': return left <= right ? 1 : 0;
    case '>': return left > right ? 1 : 0;
    case '>=': return left >= right ? 1 : 0;
    case '&&': return left && right ? 1 : 0;
    case '||': return left || right ? 1 : 0;
    case '+':
    case '-': {
      const wrapped = wrapUnsigned(node.operator === '+' ? left + right : left - right, node.type);
      return wrapped;
    }
    // The same wrapping-unsigned rule as '+'/'-' (rewrite 3 in the file
    // header), extended to the operators 0.2.2's backends lower: a game's
    // `TILE_H + ROW_GAP` was already 6 at compile time, and `1 * 40` or
    // `5 >> 1` deserve the same. '/'/'%' of zero stay unfolded so the
    // backends keep their own say about a divide-by-zero's runtime shape.
    case '*': return wrapUnsigned(left * right, node.type);
    case '/': return right === 0 ? null : wrapUnsigned(Math.floor(left / right), node.type);
    case '%': return right === 0 ? null : wrapUnsigned(left % right, node.type);
    case '&': return wrapUnsigned(left & right, node.type);
    case '|': return wrapUnsigned(left | right, node.type);
    case '^': return wrapUnsigned(left ^ right, node.type);
    case '<<': return wrapUnsigned(left * 2 ** right, node.type);
    case '>>': return wrapUnsigned(Math.floor(left / 2 ** right), node.type);
    default: return null;
  }
}

/**
 * `x * C` with one side a compile-time constant, rewritten into the shifts
 * and adds the backends lower more cheaply than a general multiply — the
 * root AGENTS.md rule ("if the compiler can do it, the compiler does it")
 * applied to the one operator the 6502 has no hardware for. `x * 0` is 0,
 * `x * 1` is x, a power of two is one shift, and a constant with exactly
 * two set bits is two shifts and an add — but only when `x` is a plain
 * `ref`, because that shape duplicates `x`, and duplicating anything with
 * work (or, one day, side effects) in it would run that work twice.
 * Everything else stays a real multiply for the backend's own routine.
 *
 * @returns {object | null}
 */
function reduceMultiply(node) {
  const type = node.type;
  let value = null;
  let other = null;
  if (isNumericConst(node.left)) { value = node.left.value; other = node.right; }
  else if (isNumericConst(node.right)) { value = node.right.value; other = node.left; }
  if (value === null || value < 0 || !Number.isInteger(value)) return null;
  // `x * 0` only folds away a bare ref: anything with a call in it would
  // lose that call's own work, and a multiply by literal zero of anything
  // else is not a shape worth optimizing for.
  if (value === 0) return other.kind === 'ref' ? { kind: 'const', value: 0, type } : null;
  if (value === 1) return other;
  const shift = (amount) => ({
    kind: 'binop', operator: '<<', type,
    left: clone(other), right: { kind: 'const', value: amount, type: 'utinyint' },
  });
  const bits = [];
  for (let b = 0; 2 ** b <= value; b++) if (value & (2 ** b)) bits.push(b);
  if (bits.length === 1) return shift(bits[0]);
  if (bits.length === 2 && other.kind === 'ref') {
    return { kind: 'binop', operator: '+', type, left: shift(bits[1]), right: shift(bits[0]) };
  }
  return null;
}

/**
 * `x / 256` → `x >> 8`, and every other power-of-two divisor.
 *
 * The 6502 has no divide, so the backend refuses `/` by name rather than
 * linking a routine for it — but a divisor that is a power of two is not
 * really a divide: it is a shift, exactly, and the machine has those. The
 * X16 package is written in these terms throughout (`memory.read(0x9F35) /
 * 128`, `low / 256`, `attr / 16`), which is what a program reads best; this
 * is the pass that agrees with it.
 *
 * Unsigned only. `>>` on a signed value floors toward negative infinity
 * where `/` truncates toward zero, so the two disagree on negatives, and
 * this would quietly change what a program means.
 */
function reduceDivide(node) {
  const type = node.type;
  const desc = resolveIntegerType(type);
  if (!desc || desc.signed) return null;
  if (!isNumericConst(node.right)) return null;
  const divisor = node.right.value;
  if (!Number.isInteger(divisor) || divisor < 1) return null;
  if (divisor === 1) return node.left;
  const bit = Math.log2(divisor);
  if (!Number.isInteger(bit)) return null;
  return {
    kind: 'binop', operator: '>>', type,
    left: clone(node.left), right: { kind: 'const', value: bit, type: 'utinyint' },
  };
}

/**
 * `x % 256` → `x & 255`, and every other power-of-two modulus.
 *
 * The same trade reduceDivide makes, for the other half of the same
 * operation: a modulus that is a power of two is a mask, exactly, and the
 * machine has masks. Unsigned only, for the same reason.
 */
function reduceModulo(node) {
  const type = node.type;
  const desc = resolveIntegerType(type);
  if (!desc || desc.signed) return null;
  if (!isNumericConst(node.right)) return null;
  const modulus = node.right.value;
  if (!Number.isInteger(modulus) || modulus < 1) return null;
  if (modulus === 1) return { kind: 'const', value: 0, type };
  if (!Number.isInteger(Math.log2(modulus))) return null;
  return {
    kind: 'binop', operator: '&', type,
    left: clone(node.left), right: { kind: 'const', value: modulus - 1, type },
  };
}

function stringBytes(node, ctx) {
  if (!node || !ctx?.strings) return null;
  if (node.kind !== 'string' || typeof node.index !== 'number') return null;
  const entry = ctx.strings[node.index];
  return entry?.bytes ?? null;
}

function foldExpr(node, ctx) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item) => foldExpr(item, ctx));
  const out = { ...node };
  if (out.left) out.left = foldExpr(out.left, ctx);
  if (out.right) out.right = foldExpr(out.right, ctx);
  if (out.argument) out.argument = foldExpr(out.argument, ctx);
  if (out.args) out.args = out.args.map((arg) => foldExpr(arg, ctx));
  if (out.value && typeof out.value === 'object') out.value = foldExpr(out.value, ctx);
  if (out.address) out.address = foldExpr(out.address, ctx);
  if (out.test) out.test = foldExpr(out.test, ctx);
  if (out.consequent) out.consequent = foldExpr(out.consequent, ctx);
  if (out.alternate) out.alternate = foldExpr(out.alternate, ctx);
  // `#fact(...) ? a : b`, or any `?:` whose test is known: the taken arm,
  // and the other one is gone (spec §49) — the same rule constant `if`
  // gets, applied to the expression form.
  if (out.kind === 'cond') {
    const test = constValue(out.test);
    if (test !== null) return test !== 0 ? out.consequent : out.alternate;
  }
  if (out.string) out.string = foldExpr(out.string, ctx);
  if (out.index && typeof out.index === 'object' && out.index.kind) out.index = foldExpr(out.index, ctx);
  if (out.init && typeof out.init === 'object' && out.init.kind && out.init.kind !== 'local') {
    out.init = foldExpr(out.init, ctx);
  }
  if (out.kind === 'stringLength') {
    const bytes = stringBytes(out.string, ctx);
    if (bytes) return { kind: 'const', value: bytes.length, type: out.type ?? 'utinyint' };
  }
  if (out.kind === 'stringByte') {
    const bytes = stringBytes(out.string, ctx);
    const index = constValue(out.index);
    if (bytes && index !== null && index >= 0 && index < bytes.length) {
      return { kind: 'const', value: bytes[index], type: out.type ?? 'utinyint' };
    }
  }
  if (out.kind === 'call') {
    const evaluated = constEvalCall(out, ctx);
    if (evaluated !== null) return { kind: 'const', value: evaluated, type: out.type ?? 'utinyint' };
    const forwarded = forwardExprCall(out, ctx);
    if (forwarded) return forwarded;
  }
  if (out.kind === 'binop' && out.operator === '*') {
    const reduced = reduceMultiply(out);
    if (reduced) return reduced;
  }
  if (out.kind === 'binop' && out.operator === '/') {
    const reduced = reduceDivide(out);
    if (reduced) return reduced;
  }
  if (out.kind === 'binop' && out.operator === '%') {
    const reduced = reduceModulo(out);
    if (reduced) return reduced;
  }
  const value = constValue(out);
  if (value !== null && out.kind !== 'const') {
    const comparison = out.operator === '==' || out.operator === '!=' || out.operator === '<' || out.operator === '<=' || out.operator === '>' || out.operator === '>=' || out.operator === '&&' || out.operator === '||' || out.operator === '!';
    return { kind: 'const', value, type: out.type ?? (comparison ? 'bool' : out.type) };
  }
  return out;
}

function evalExpr(node, env, ctx) {
  if (!node || typeof node !== 'object') return null;
  if (node.kind === 'const' && typeof node.value === 'number') return node.value;
  if (node.kind === 'ref' && typeof node.name === 'string' && env.has(node.name)) return env.get(node.name);
  if (node.kind === 'stringLength') {
    const bytes = stringBytes(node.string, ctx);
    return bytes ? bytes.length : null;
  }
  if (node.kind === 'stringByte') {
    const bytes = stringBytes(node.string, ctx);
    const index = evalExpr(node.index, env, ctx);
    if (bytes && index !== null && index >= 0 && index < bytes.length) return bytes[index];
    return null;
  }
  if (node.kind === 'unop' && node.operator === '!') {
    const inner = evalExpr(node.argument, env, ctx);
    if (inner === null) return null;
    return inner ? 0 : 1;
  }
  if (node.kind === 'binop') {
    const left = evalExpr(node.left, env, ctx);
    const right = evalExpr(node.right, env, ctx);
    if (left === null || right === null) return null;
    return constValue({ ...node, left: { kind: 'const', value: left }, right: { kind: 'const', value: right } });
  }
  if (node.kind === 'call') {
    const args = (node.args ?? []).map((arg) => {
      const value = evalExpr(arg, env, ctx);
      if (value === null) return null;
      return { kind: 'const', value, type: arg.type };
    });
    if (args.some((arg) => arg === null)) return null;
    return constEvalCall({ ...node, args }, ctx);
  }
  return constValue(node);
}

function evalBlock(body, env, ctx) {
  for (const statement of body ?? []) {
    const result = evalStmt(statement, env, ctx);
    if (result === 'abort') return 'abort';
    if (result && result.returned) return result;
  }
  return { returned: false, value: null };
}

function evalStmt(statement, env, ctx) {
  if (!statement) return { returned: false, value: null };
  if (statement.kind === 'block') return evalBlock(statement.body, env, ctx);
  if (statement.kind === 'local') {
    const value = statement.init ? evalExpr(statement.init, env, ctx) : 0;
    if (value === null) return 'abort';
    env.set(statement.name, value);
    return { returned: false, value: null };
  }
  if (statement.kind === 'assign') {
    if (!env.has(statement.target)) return 'abort';
    const value = evalExpr(statement.value, env, ctx);
    if (value === null) return 'abort';
    env.set(statement.target, value);
    return { returned: false, value: null };
  }
  if (statement.kind === 'return') {
    if (!statement.value) return { returned: true, value: 0 };
    const value = evalExpr(statement.value, env, ctx);
    if (value === null) return 'abort';
    return { returned: true, value };
  }
  if (statement.kind === 'if') {
    const test = evalExpr(statement.test, env, ctx);
    if (test === null) return 'abort';
    if (test) return evalBlock(statement.then, env, ctx);
    if (statement.else) return evalBlock(statement.else, env, ctx);
    return { returned: false, value: null };
  }
  return 'abort';
}

function constEvalCall(call, ctx) {
  if (!ctx?.functionsByName || typeof call.name !== 'string') return null;
  const fn = ctx.functionsByName.get(call.name);
  if (!fn) return null;
  if ((fn.body ?? []).length === 0) return null;
  if (ctx.inlining.has(call.name)) return null;
  const returnType = fn.returnType ?? 'void';
  if (returnType !== 'void' && returnType !== 'bool' && storageBytes(returnType) !== 1) return null;
  if (siteCount(call.name, ctx) > 1) return null;
  const params = fn.params ?? [];
  const args = call.args ?? [];
  if (params.length !== args.length) return null;
  if (!args.every((arg) => isNumericConst(arg) || evalExpr(arg, new Map(), ctx) !== null)) return null;
  const env = new Map();
  for (let i = 0; i < params.length; i++) {
    const value = isNumericConst(args[i]) ? args[i].value : evalExpr(args[i], new Map(), ctx);
    if (value === null) return null;
    env.set(params[i].name, value);
  }
  ctx.inlining.add(call.name);
  const result = evalBlock(fn.body, env, ctx);
  ctx.inlining.delete(call.name);
  if (result === 'abort' || !result.returned) return null;
  return result.value;
}

function alwaysReturns(statement) {
  if (!statement) return false;
  if (statement.kind === 'return') return true;
  if (statement.kind === 'block') {
    const body = statement.body ?? [];
    return body.length > 0 && alwaysReturns(body[body.length - 1]);
  }
  if (statement.kind === 'if') {
    const then = statement.then ?? [];
    const otherwise = statement.else;
    if (!otherwise || otherwise.length === 0) return false;
    const thenReturns = then.length > 0 && alwaysReturns(then[then.length - 1]);
    const elseReturns = otherwise.length > 0 && alwaysReturns(otherwise[otherwise.length - 1]);
    return thenReturns && elseReturns;
  }
  return false;
}

function optimizeBody(body, ctx) {
  const out = [];
  for (const statement of body ?? []) {
    const pieces = optimizeStatement(statement, ctx);
    for (const piece of pieces) {
      out.push(piece);
      if (alwaysReturns(piece)) return propagateConstLocals(out, ctx);
    }
  }
  return propagateConstLocals(out, ctx);
}

function bindsName(node, name) {
  if (Array.isArray(node)) return node.some((item) => bindsName(item, name));
  if (!node || typeof node !== 'object') return false;
  if (node.kind === 'local' && node.name === name) return true;
  return Object.values(node).some((value) => bindsName(value, name));
}

/**
 * A local rule 9 pasted in — a parameter it bound, or one of the callee's
 * own — holding a constant that nothing ever assigns, is the constant:
 * every read of it in the rest of its block becomes the value, and the
 * declaration goes. It was not constant when the callee was written; the
 * inlining made it one (an unrolled `place(0, 72)` inside a print, or
 * `toScreen`'s `screen` once `asciiToScreenCode(72)` folded), and it would
 * otherwise keep a zero-page byte and a store for a number the code
 * already knows. A local the program wrote where it stands is left alone
 * — it may exist to shadow, or to be refused by name.
 */
function propagateConstLocals(statements, ctx) {
  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    if (statement.kind !== 'local' || statement.inlined !== true || !isNumericConst(statement.init)) continue;
    const rest = statements.slice(i + 1);
    const assigned = new Set();
    collectAssigned(rest, assigned);
    if (assigned.has(statement.name) || bindsName(rest, statement.name)) continue;
    const value = { kind: 'const', value: statement.init.value, type: statement.type ?? statement.init.type };
    // The rest goes round again: a value that was a variable a moment ago
    // may now fold — an address into a literal, a call into its result.
    const substituted = optimizeBody(substituteBindings(rest, new Map([[statement.name, value]])), ctx);
    return [...statements.slice(0, i), ...substituted];
  }
  return statements;
}

function matchCountedFor(statement) {
  const init = statement.init;
  if (!init || init.kind !== 'local' || !init.name) return null;
  const name = init.name;
  if (!isNumericConst(init.init) || init.init.value !== 0) return null;
  const test = statement.test;
  if (!test || test.kind !== 'binop' || test.operator !== '<' || test.left?.kind !== 'ref' || test.left.name !== name) return null;
  const count = constValue(test.right);
  if (count === null || count <= 0 || count > MAX_UNROLL) return null;
  const update = statement.update;
  if (!update || update.kind !== 'assign' || update.target !== name) return null;
  const inc = update.value;
  if (!inc || inc.kind !== 'binop' || inc.operator !== '+' || inc.left?.kind !== 'ref' || inc.left.name !== name) return null;
  if (!isNumericConst(inc.right) || inc.right.value !== 1) return null;
  if (containsJump(statement.body)) return null;
  return { name, count, type: init.type ?? 'utinyint' };
}

function substituteBindings(body, bindings) {
  return mapDeep(body, (node) => {
    if (node.kind === 'ref' && typeof node.name === 'string' && bindings.has(node.name)) {
      return clone(bindings.get(node.name));
    }
    return node;
  });
}

/**
 * The one call a forwarder's body consists of, when it is one: a call
 * whose every argument is one of the function's own parameters (each at
 * most once) or a numeric constant, as the body's only statement
 * (`void`) or as the value of its only `return` (the return types must
 * agree, so no conversion is being skipped). `wrapped` is the call,
 * `constants` how many of its arguments are literals, `used` which
 * parameters it passes on. Anything else — two statements, an
 * expression around the call, a global passed through, a parameter used
 * twice — is not a forwarder, and 2048's `f(); return;` idiom for keeping
 * a helper a call is two statements.
 *
 * @returns {{ wrapped: object, constants: number, used: Set<string> } | null}
 */
function forwardedCall(fn) {
  const body = fn.body ?? [];
  if (body.length !== 1) return null;
  const [only] = body;
  const returnType = fn.returnType ?? 'void';
  let wrapped;
  if (only.kind === 'call') {
    if (returnType !== 'void') return null;
    wrapped = only;
  } else if (only.kind === 'return' && only.value?.kind === 'call') {
    if (returnType === 'void' || (only.value.type ?? returnType) !== returnType) return null;
    wrapped = only.value;
  } else {
    return null;
  }
  if (typeof wrapped.name !== 'string' || wrapped.name === fn.name) return null;
  const params = new Set((fn.params ?? []).map((param) => param.name));
  const used = new Set();
  let constants = 0;
  for (const arg of wrapped.args ?? []) {
    if (isNumericConst(arg)) {
      constants += 1;
    } else if (arg?.kind === 'ref' && params.has(arg.name) && !used.has(arg.name)) {
      used.add(arg.name);
    } else {
      return null;
    }
  }
  return { wrapped, constants, used };
}

/**
 * The call a site of a forwarder becomes: the wrapped call with the
 * site's arguments in the forwarded parameters' places. Null when the
 * rewrite would change what runs or what it costs:
 *
 * - a parameter the forwarder drops takes an argument with a side effect
 *   (the effect would vanish with it);
 * - the forwarder reorders its parameters and an argument has a side
 *   effect (spec §104: the order they run in would change);
 * - a literal the forwarder adds would be stored at every site where the
 *   function stored it once — free at one site, and worth it while the
 *   copies cost less than the parameter stores the sites no longer make
 *   (each literal is one store per extra site; each parameter forwarded
 *   is one store the forwarder no longer makes).
 */
function forwardCall(call, fn, forwarded, ctx) {
  const params = fn.params ?? [];
  const args = call.args ?? [];
  if (params.length !== args.length) return null;
  const { wrapped, constants, used } = forwarded;
  const bindings = new Map();
  for (let i = 0; i < params.length; i++) {
    if (!used.has(params[i].name) && !isSideEffectFree(args[i])) return null;
    bindings.set(params[i].name, args[i]);
  }
  const order = (wrapped.args ?? []).filter((arg) => arg.kind === 'ref').map((arg) => params.findIndex((param) => param.name === arg.name));
  const reordered = order.some((index, position) => index !== position);
  if (reordered && args.some((arg) => !isSideEffectFree(arg))) return null;
  if (constants > 0) {
    const sites = siteCount(call.name, ctx);
    if (constants * (sites - 1) > used.size) return null;
  }
  const rewritten = substituteBindings(clone(wrapped), bindings);
  return { ...rewritten, type: rewritten.type ?? fn.returnType ?? 'void' };
}

/** A non-void forwarder in expression position — `return f(x);` — is `f(x)` where it was called. */
function forwardExprCall(call, ctx) {
  if (!ctx?.functionsByName || typeof call.name !== 'string') return null;
  const fn = ctx.functionsByName.get(call.name);
  if (!fn || ctx.inlining.has(call.name)) return null;
  if (fn.body?.[0]?.kind !== 'return') return null;
  const forwarded = forwardedCall(fn);
  if (!forwarded) return null;
  const rewritten = forwardCall(call, fn, forwarded, ctx);
  if (!rewritten) return null;
  ctx.inlining.add(call.name);
  try {
    return foldExpr(rewritten, ctx);
  } finally {
    ctx.inlining.delete(call.name);
  }
}

// ---- rule 9: a single caller ----------------------------------------------

function containsKind(node, kind) {
  if (Array.isArray(node)) return node.some((item) => containsKind(item, kind));
  if (!node || typeof node !== 'object') return false;
  if (node.kind === kind) return true;
  return Object.values(node).some((value) => containsKind(value, kind));
}

function countReturns(node) {
  if (Array.isArray(node)) return node.reduce((n, item) => n + countReturns(item), 0);
  if (!node || typeof node !== 'object') return 0;
  let n = node.kind === 'return' ? 1 : 0;
  for (const value of Object.values(node)) n += countReturns(value);
  return n;
}

/** Every name a body reads or writes as a variable: refs, assignment targets, locals. */
function collectNames(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectNames(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    if ((node.kind === 'ref' || node.kind === 'local') && typeof node.name === 'string') out.add(node.name);
    if (node.kind === 'assign' && typeof node.target === 'string') out.add(node.target);
    for (const value of Object.values(node)) collectNames(value, out);
  }
}

/** The names a function binds itself: its parameters and every local in its body. */
function boundNames(fn) {
  const out = new Set((fn.params ?? []).map((param) => param.name));
  collectBoundNames(fn.body, out);
  return out;
}

/** A name not in `taken`, built from `name`. */
function freshName(name, taken) {
  let out = name;
  for (let n = 2; taken.has(out); n += 1) out = `${name}_${n}`;
  taken.add(out);
  return out;
}

/**
 * Every variable a function writes, itself or through anything it calls:
 * assignment targets and string copies. A variable at a hardware address
 * counts as written by any body (a `memory.write` may reach it), so an
 * argument reading one is copied, as the call copied it.
 */
function writesOf(fn, ctx) {
  const out = new Set(ctx.addressed);
  const seen = new Set();
  const visit = (f) => {
    if (!f || seen.has(f.name)) return;
    seen.add(f.name);
    // The function's own writes by name, parameters and locals included;
    // a callee's only for what it does not bind itself — its locals are
    // its own, whatever they happen to be called.
    const own = new Set();
    collectAssigned(f.body, own);
    const walk = (node) => {
      if (Array.isArray(node)) { for (const item of node) walk(item); return; }
      if (!node || typeof node !== 'object') return;
      if (node.kind === 'stringCopy' && typeof node.target?.name === 'string') own.add(node.target.name);
      if (node.kind === 'call' && typeof node.name === 'string') visit(ctx.functionsByName.get(node.name));
      for (const value of Object.values(node)) walk(value);
    };
    walk(f.body);
    const bound = f === fn ? new Set() : boundNames(f);
    for (const name of own) if (!bound.has(name)) out.add(name);
  };
  visit(fn);
  return out;
}

/** Whether `fn`, or anything it calls, has a node `test` accepts. */
function reachableHas(fn, ctx, test) {
  const seen = new Set();
  const visit = (f) => {
    if (!f || seen.has(f.name)) return false;
    seen.add(f.name);
    const walk = (node) => {
      if (Array.isArray(node)) return node.some(walk);
      if (!node || typeof node !== 'object') return false;
      if (test(node)) return true;
      if (node.kind === 'call' && typeof node.name === 'string' && visit(ctx.functionsByName.get(node.name))) return true;
      return Object.values(node).some(walk);
    };
    return walk(f.body);
  };
  return visit(fn);
}

/** Rename the names a callee binds (its parameters, its locals) everywhere in `body`. */
function renameBound(node, renames) {
  if (Array.isArray(node)) return node.map((item) => renameBound(item, renames));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) out[key] = renameBound(value, renames);
  if ((out.kind === 'ref' || out.kind === 'local') && typeof out.name === 'string' && renames.has(out.name)) {
    out.name = renames.get(out.name);
    if (out.kind === 'local') out.inlined = true;
  }
  if (out.kind === 'assign' && typeof out.target === 'string' && renames.has(out.target)) {
    out.target = renames.get(out.target);
  }
  return out;
}

/**
 * The callee a call has exactly one live site of, when its body can stand
 * where the call is: not recursive, not empty (rule 7 deletes those), no
 * `asm6502` (its text may name the function's own frame), and — the
 * `return` rule — a void body with a `return` anywhere stays a call
 * (2048's `f(); return;` idiom, and a `return` pasted into the caller
 * would leave the caller), while a non-void body must end in its only
 * `return`, so dropping that one statement leaves straight-line code.
 */
function singleCallerCallee(call, ctx, wantValue) {
  if (!ctx?.functionsByName || typeof call.name !== 'string') return null;
  const fn = ctx.functionsByName.get(call.name);
  if (!fn || ctx.inlining.has(call.name)) return null;
  // Inside an unrolled copy every site is one of N; inside a forwarder the
  // sites are the forwarder's, and rule 8 puts this call at each of them.
  if (ctx.unrollingStringCopy) return null;
  if (ctx.currentFn && forwardedCall(ctx.currentFn)) return null;
  const body = fn.body ?? [];
  if (body.length === 0) return null;
  if (containsKind(body, 'asm')) return null;
  if ((fn.params ?? []).length !== (call.args ?? []).length) return null;
  const returnType = fn.returnType ?? 'void';
  if (wantValue) {
    if (returnType === 'void') return null;
    const last = body[body.length - 1];
    if (!last || last.kind !== 'return' || !last.value) return null;
    if (countReturns(body) !== 1) return null;
  } else {
    if (returnType !== 'void') return null;
    if (containsReturn(body)) return null;
  }
  if (ctx.consumed.has(call.name) || ctx.retired.has(call.name)) return null;
  if (siteCount(call.name, ctx) !== 1) return null;
  return fn;
}

/**
 * How many places a function is called from once every forwarder of it
 * (rule 8) has been written out: a forwarder's own sites are the wrapped
 * function's. Counted over the bodies as they stand — a caller still
 * being optimized is counted as it was written, which is what keeps a
 * body from being pasted at the first of several sites the caller is
 * about to have.
 */
function siteCount(name, ctx, seen = new Set()) {
  if (seen.has(name)) return 2;
  seen.add(name);
  let n = 0;
  for (const fn of ctx.functionsByName.values()) {
    // A body written into its one caller stands in for that copy until the
    // caller's own optimized body is stored; after that it is counted there,
    // and the original is on its way out.
    if (ctx.retired.has(fn.name)) continue;
    const direct = countCallsIn(fn.body, name);
    if (direct === 0) continue;
    const forwarded = forwardedCall(fn);
    n += forwarded && forwarded.wrapped.name === name ? siteCount(fn.name, ctx, seen) : direct;
  }
  return n;
}

function countCallsIn(body, name) {
  let n = 0;
  const walk = (node) => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (node && typeof node === 'object') {
      if (node.kind === 'call' && node.name === name) n += 1;
      for (const value of Object.values(node)) walk(value);
    }
  };
  walk(body);
  return n;
}

/**
 * The callee's body, made to stand at the call site: its own names made
 * fresh so nothing in the caller is shadowed and no argument is read
 * after a parameter of the same name took its place; each parameter
 * either the argument itself (a constant, or a plain read of a variable
 * that neither the parameter nor the body assigns — the argument's store
 * into the parameter slot is exactly the store that disappears) or a
 * local holding it. Null when a name the body reads without binding — a
 * global — is one the caller binds as a parameter or local, since the
 * caller's binding would capture it.
 *
 * @returns {{ statements: object[], returned: object | null, locals: Set<string> } | null}
 */
function siteBody(call, fn, ctx) {
  const bound = boundNames(fn);
  const free = new Set();
  collectNames(fn.body, free);
  for (const name of bound) free.delete(name);
  for (const name of free) if (ctx.callerBound.has(name)) return null;
  const assigned = writesOf(fn, ctx);
  const renames = new Map();
  for (const name of bound) {
    const fresh = freshName(name, ctx.taken);
    renames.set(name, fresh);
    ctx.zpNames.add(fresh);
  }
  const params = fn.params ?? [];
  const args = call.args ?? [];
  const statements = [];
  const bindings = new Map();
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    const arg = args[i];
    const plainRead = arg?.kind === 'ref' && typeof arg.name === 'string' && !assigned.has(arg.name);
    // A read of the caller's own local or parameter is a zero-page read,
    // as the parameter's was; a global is an absolute read, one byte more
    // at every use, so it is copied into a local once — the store the
    // call made — and read from there. An array is its address either way.
    const zeroPage = plainRead && (ctx.zpNames.has(arg.name) || param.type === 'array');
    if ((isCompileTimeArg(arg) || zeroPage) && !assigned.has(param.name)) {
      bindings.set(renames.get(param.name), arg);
    } else if (param.type === 'string' || param.type === 'array' || arg?.type === 'string') {
      // A string or an array is a pointer the backends only hold in a
      // parameter slot or a global; there is no local to copy it into.
      return null;
    } else {
      statements.push({ kind: 'local', name: renames.get(param.name), type: param.type, init: clone(arg), inlined: true });
    }
  }
  let body = substituteBindings(renameBound(clone(fn.body), renames), bindings);
  let returned = null;
  if ((fn.returnType ?? 'void') !== 'void') {
    returned = body[body.length - 1].value;
    body = body.slice(0, -1);
  }
  const locals = new Map();
  for (const statement of body) if (statement.kind === 'local') locals.set(statement.name, statement.type ?? null);
  ctx.consumed.add(fn.name);
  return { statements: [...statements, ...body], returned, locals, free };
}

/** The expression children of a statement: everything but the statement lists control flow owns. */
const STATEMENT_LISTS = new Set(['then', 'else', 'body']);

function findValueCall(node, ctx, found) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findValueCall(item, ctx, found);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  for (const [key, value] of Object.entries(node)) {
    if (STATEMENT_LISTS.has(key)) continue;
    if (key === 'init' && value?.kind === 'local') continue;
    const hit = findValueCall(value, ctx, found);
    if (hit) return hit;
  }
  if (node.kind === 'call' && node !== found.container && singleCallerCallee(node, ctx, true)) return node;
  return null;
}

function replaceNode(node, target, replacement) {
  return mapDeep(node, (inner) => (inner === target ? replacement : inner));
}

/**
 * Whether the rest of `statement`, with `call` taken out, would run the
 * same before the callee's body as after it: only constants, reads, and
 * arithmetic on them — no other call, no hardware or array read — and no
 * read of a variable the callee writes.
 */
function restIsInert(statement, call, fn, ctx) {
  const assigned = writesOf(fn, ctx);
  const stores = reachableHas(fn, ctx, (node) => node.kind === 'storeIndex' || node.kind === 'memoryWrite' || node.kind === 'stringCopy');
  const inert = (node) => {
    if (node === call) return true;
    if (Array.isArray(node)) return node.every(inert);
    if (!node || typeof node !== 'object') return true;
    if (node === statement) {
      return Object.entries(node).every(([key, value]) => STATEMENT_LISTS.has(key) || inert(value));
    }
    if (node.kind === 'ref') return !assigned.has(node.name) && !(stores && node.type === 'string');
    if (node.kind === 'index') return !stores && inert(node.index);
    if (!PURE_EXPR.has(node.kind)) return false;
    return Object.values(node).every(inert);
  };
  return inert(statement);
}

/** Statement kinds whose expressions run once, in order, right where they stand. */
const HOISTABLE = new Set(['local', 'assign', 'call', 'memoryWrite', 'storeIndex', 'return', 'if']);

/**
 * Rule 9 for a value: the first single-caller call in `statement` whose
 * body can run ahead of it is that body, then the statement reading the
 * returned expression where the call was. `let r = f(x)` whose value is
 * one of f's own locals keeps that local as `r` — no copy.
 *
 * @returns {object[] | null}
 */
function hoistValueCall(statement, ctx) {
  if (!HOISTABLE.has(statement.kind)) return null;
  const call = findValueCall(statement, ctx, { container: statement.kind === 'call' ? statement : null });
  if (!call) return null;
  const fn = ctx.functionsByName.get(call.name);
  if (!restIsInert(statement, call, fn, ctx)) return null;
  const site = siteBody(call, fn, ctx);
  if (!site) return null;
  let { statements, returned } = site;
  let rest;
  const keepsLocal = () => {
    if (statement.kind !== 'local' || statement.init !== call || returned.kind !== 'ref') return false;
    if (!site.locals.has(returned.name) || site.locals.get(returned.name) !== (statement.type ?? null)) return false;
    // The caller's name must be new to the pasted body: not a global it
    // reads, not an argument it was handed.
    const names = new Set();
    collectNames(statements, names);
    return !names.has(statement.name);
  };
  if (keepsLocal()) {
    statements = renameBound(statements, new Map([[returned.name, statement.name]]));
    rest = [];
  } else {
    rest = [replaceNode(statement, call, returned)];
  }
  ctx.inlining.add(call.name);
  try {
    const inlined = [...optimizeBody(statements, ctx), ...optimizeBody(rest, ctx)];
    // A statement that declares nothing the code after it reads can take
    // the callee's locals in a block of its own, so their zero page is
    // released when it ends — as the callee's frame was — instead of
    // staying live under every call the caller makes after it.
    if (statement.kind === 'local' || ctx.inlining.size > 1) return inlined;
    return [{ kind: 'block', origin: call.name, body: inlined }];
  } finally {
    ctx.inlining.delete(call.name);
  }
}

/** Rule 9 for a void call statement: the callee's body, in a block of its own. */
function inlineSingleCaller(statement, fn, ctx) {
  const site = siteBody(statement, fn, ctx);
  if (!site) return null;
  ctx.inlining.add(statement.name);
  try {
    const inlined = optimizeBody(site.statements, ctx);
    if (ctx.inlining.size > 1) return inlined;
    return [{ kind: 'block', origin: statement.name, body: inlined }];
  } finally {
    ctx.inlining.delete(statement.name);
  }
}

function inlineVoidCall(statement, ctx) {
  if (!ctx?.functionsByName || typeof statement.name !== 'string') return null;
  const fn = ctx.functionsByName.get(statement.name);
  if (!fn) return null;
  if ((fn.body ?? []).length === 0) {
    if ((statement.args ?? []).some((arg) => !isSideEffectFree(arg))) return null;
    return [];
  }
  if (fn.returnType && fn.returnType !== 'void') return null;
  if (ctx.inlining.has(statement.name)) return null;
  // Rewrite 8: a void forwarder is the call it wraps, whatever its
  // arguments are — and the result goes round again, so a forwarder of a
  // forwarder, or of an empty function, or of a body the rules below
  // inline, ends where a hand-written call would.
  const forwarded = forwardedCall(fn);
  if (forwarded) {
    const rewritten = forwardCall(statement, fn, forwarded, ctx);
    if (rewritten) {
      ctx.inlining.add(statement.name);
      try {
        return optimizeStatement(rewritten, ctx);
      } finally {
        ctx.inlining.delete(statement.name);
      }
    }
  }
  // A `return` inside the body would stop meaning "leave this callee" once
  // the body is pasted into the caller — it would leave the *caller* (and
  // through a chain of inlines, the whole program: 2048's own spawnTile(),
  // a no-parameter void helper with an early return, silently ended main()
  // from inside resetGame(), found 2026-09-10). There's no block-exit IR
  // to rewrite it into, so a body with a return anywhere stays a real call.
  if (containsReturn(fn.body)) return null;
  const params = fn.params ?? [];
  const args = statement.args ?? [];
  if (params.length !== args.length) return null;
  if (!args.every(isCompileTimeArg)) return null;
  const paramNames = new Set(params.map((p) => p.name));
  const unusedParams = params.length > 0 && !referencesNames(fn.body, paramNames);
  const stringCopy = containsStringByte(fn.body) || ctx.unrollingStringCopy;
  // A component (bx/elaborate.mjs) is a composition written as a
  // function: its props are the element's attributes, and when every one
  // of them is a compile-time value the element IS its body with those
  // values in — the straight-line code a hand-written program would
  // have, which is what the abstraction was promised to cost (spec §30,
  // §64, §65). A run-time prop stays a call, and the duplicate-size rule
  // below still applies to a large body used from many places.
  const component = fn.component === true;
  if (params.length > 0 && !stringCopy && !unusedParams && !component) return null;
  if (unusedParams && siteCount(statement.name, ctx) > 1) return null;
  // Inlining a body that more than one place calls writes that body out
  // once per call site. That is a win only while the body is smaller than
  // the call it replaces — on the 6502 a call is 3 bytes at each site plus
  // one RTS, so duplicating anything past a few bytes costs more than it
  // saves, and every extra call site costs again.
  //
  // A parameterless void function used to skip this question entirely: the
  // guards above only reject on parameters, so a no-argument helper was
  // inlined everywhere it appeared no matter how large. @8bitscript/input's
  // poll() is 117 nodes, and 2048 reaches it from four places — once from
  // begin() (which primes the edge detector) and once per read in the game
  // loop — so the game carried four copies of it. Refusing those four and
  // paying for calls instead is 204 bytes on a 4K PET, 541 on a C64, 675 on
  // an Atari, and leaves hello-world byte-for-byte identical.
  if (
    nodeCount(fn.body) > INLINE_DUPLICATE_NODE_LIMIT &&
    siteCount(statement.name, ctx) > 1
  ) {
    return null;
  }
  const bindings = new Map();
  for (let i = 0; i < params.length; i++) bindings.set(params[i].name, args[i]);
  ctx.inlining.add(statement.name);
  const inlined = optimizeBody(substituteBindings(clone(fn.body), bindings), ctx);
  ctx.inlining.delete(statement.name);
  if (ctx.inlining.size > 0) return inlined;
  return [{ kind: 'block', origin: statement.name, body: inlined }];
}

function optimizeStatement(statement, ctx) {
  if (!statement) return [];
  if (statement.kind === 'block') {
    const body = optimizeBody(statement.body, ctx);
    if (statement.origin) return [{ ...statement, body }];
    return body;
  }
  if (statement.kind === 'if') {
    const test = foldExpr(statement.test, ctx);
    const value = constValue(test);
    if (value === null) {
      const hoisted = hoistValueCall({ ...statement, test }, ctx);
      if (hoisted) return hoisted;
    }
    const taken = optimizeBody(statement.then, ctx);
    const otherwise = statement.else ? optimizeBody(statement.else, ctx) : null;
    if (value !== null) return value ? taken : (otherwise ?? []);
    if (taken.length === 0 && (!otherwise || otherwise.length === 0)) return [];
    // 'then' is the IR's real field name for the taken branch (ir/index.mjs),
    // an array of statements, never a callable — S7739's thenable-safety
    // rule is about `{ then() {} }` looking like a Promise.
    return [{ ...statement, test, then: taken, else: otherwise }]; // NOSONAR: javascript:S7739
  }
  if (statement.kind === 'while') {
    return [{ ...statement, test: foldExpr(statement.test, ctx), body: optimizeBody(statement.body, ctx) }];
  }
  if (statement.kind === 'for') {
    const folded = {
      ...statement,
      test: statement.test ? foldExpr(statement.test, ctx) : statement.test,
      body: statement.body,
    };
    const counted = matchCountedFor(folded);
    if (counted && containsStringByte(folded.body)) {
      const previous = ctx.unrollingStringCopy;
      ctx.unrollingStringCopy = true;
      try {
        const unrolled = [];
        for (let i = 0; i < counted.count; i++) {
          const bindings = new Map([[counted.name, { kind: 'const', value: i, type: counted.type }]]);
          unrolled.push(...optimizeBody(substituteBindings(clone(folded.body), bindings), ctx));
        }
        return unrolled;
      } finally {
        ctx.unrollingStringCopy = previous;
      }
    }
    return [{ ...folded, body: optimizeBody(statement.body, ctx) }];
  }
  if (statement.kind === 'call') {
    const folded = foldExpr(statement, ctx);
    if (folded.kind === 'const') return [];
    const hoisted = hoistValueCall(folded, ctx);
    if (hoisted) return hoisted;
    const inlined = inlineVoidCall(folded, ctx);
    if (inlined) return inlined;
    const single = singleCallerCallee(folded, ctx, false);
    if (single) {
      const body = inlineSingleCaller(folded, single, ctx);
      if (body) return body;
    }
    // A value-returning single caller called for its effect: the body, and
    // the returned expression thrown away when nothing in it did anything.
    const valued = singleCallerCallee(folded, ctx, true);
    if (valued) {
      const site = siteBody(folded, valued, ctx);
      if (site && isSideEffectFree(site.returned)) {
        ctx.inlining.add(folded.name);
        try {
          return optimizeBody(site.statements, ctx);
        } finally {
          ctx.inlining.delete(folded.name);
        }
      }
    }
    return [folded];
  }
  const folded = foldExpr(statement, ctx);
  const hoisted = hoistValueCall(folded, ctx);
  if (hoisted) return hoisted;
  return [folded];
}

function collectCallees(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectCallees(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    if (node.kind === 'call' && typeof node.name === 'string') out.add(node.name);
    for (const value of Object.values(node)) collectCallees(value, out);
  }
}

/**
 * Callees before callers, so a body is measured and pasted in the shape
 * it has once its own calls are inlined. A cycle is visited once, in the
 * order it was met; recursion is what `ctx.inlining` refuses.
 */
function bottomUpOrder(functions) {
  const byName = new Map(functions.map((fn) => [fn.name, fn]));
  const order = [];
  const seen = new Set();
  const visit = (fn) => {
    if (seen.has(fn.name)) return;
    seen.add(fn.name);
    const callees = new Set();
    collectCallees(fn.body, callees);
    for (const name of callees) {
      const callee = byName.get(name);
      if (callee) visit(callee);
    }
    order.push(fn);
  };
  for (const fn of functions) visit(fn);
  return order;
}

/** Every variable name anywhere in the program, so a fresh local can be certain not to shadow one. */
function allNames(functions, globals) {
  const out = new Set();
  for (const global of globals ?? []) out.add(global.name);
  for (const fn of functions) {
    for (const param of fn.params ?? []) out.add(param.name);
    collectNames(fn.body, out);
  }
  return out;
}

function optimizeFunctions(functions, ctx) {
  const optimized = new Map();
  for (const fn of bottomUpOrder(functions)) {
    ctx.currentFn = fn;
    ctx.callerBound = boundNames(fn);
    ctx.zpNames = new Set(ctx.callerBound);
    const out = { ...fn, body: optimizeBody(fn.body, ctx) };
    optimized.set(fn.name, out);
    ctx.functionsByName.set(fn.name, out);
    for (const name of ctx.consumed) ctx.retired.add(name);
    ctx.consumed.clear();
  }
  return functions.map((fn) => optimized.get(fn.name));
}

function mapDeep(node, fn) {
  if (Array.isArray(node)) return node.map((item) => mapDeep(item, fn));
  if (!node || typeof node !== 'object') return node;
  const mapped = fn(node);
  if (mapped !== node) return mapped;
  const out = { ...node };
  for (const [key, value] of Object.entries(out)) {
    out[key] = mapDeep(value, fn);
  }
  return out;
}

function substituteRefs(body, immutable) {
  return mapDeep(body, (node) => {
    if (node.kind === 'ref' && typeof node.name === 'string' && immutable.has(node.name)) {
      const { value, type } = immutable.get(node.name);
      return { kind: 'const', value, type };
    }
    return node;
  });
}

function functionBinds(fn, name) {
  if ((fn.params ?? []).some((p) => p.name === name)) return true;
  const locals = new Set();
  collectBoundNames(fn.body, locals);
  return locals.has(name);
}

function applyImmutable(functions, globals) {
  const assigned = new Set();
  for (const fn of functions) collectAssigned(fn.body, assigned);
  const immutable = new Map();
  for (const global of globals ?? []) {
    if (global.address != null) continue;
    if (global.array !== undefined) continue;
    if (assigned.has(global.name)) continue;
    if (typeof global.init !== 'number') continue;
    immutable.set(global.name, { value: global.init, type: global.type });
  }
  if (immutable.size === 0) return functions;
  return functions.map((fn) => {
    const localImmutable = new Map([...immutable].filter(([name]) => !functionBinds(fn, name)));
    if (localImmutable.size === 0) return fn;
    return { ...fn, body: substituteRefs(fn.body, localImmutable) };
  });
}

/**
 * Fold constant control flow, inline never-assigned globals, and turn
 * compile-time calls into their results. Returns a new IR object.
 *
 * @template {{ name: string, body: unknown, params?: { name: string, type?: string }[], returnType?: string | null }} F
 * @template {{ name: string, type?: string, address?: number | null, array?: number, init?: unknown, constant?: boolean }} G
 * @param {{ entry: string, functions: F[], globals?: G[], strings?: { bytes: number[] }[] }} ir
 * @returns {{ entry: string, functions: F[], globals: G[], strings?: { bytes: number[] }[] }}
 */
export function optimizeIr(ir) {
  let functions = applyImmutable(ir.functions, ir.globals);
  const ctx = {
    functionsByName: new Map(functions.map((fn) => [fn.name, fn])),
    strings: ir.strings ?? [],
    inlining: new Set(),
    unrollingStringCopy: false,
    taken: allNames(functions, ir.globals),
    callerBound: new Set(),
    zpNames: new Set(),
    currentFn: null,
    consumed: new Set(),
    retired: new Set(),
    addressed: new Set((ir.globals ?? []).filter((global) => global.address != null).map((global) => global.name)),
  };
  functions = optimizeFunctions(functions, ctx);
  functions = optimizeFunctions(functions, ctx);
  return { ...ir, functions, globals: ir.globals ?? [] };
}

/**
 * Prune, then fold, then prune again. Immutable-global inlining looks at
 * assignments in the IR it is handed; a write that lives only in a
 * function the entry never calls (hello-world's `setReverse`) must not
 * keep that global in RAM. The first prune drops those writers, the fold
 * turns the leftover reads into constants, the second prune drops the
 * global itself.
 *
 * @template {{ name: string, body: unknown, params?: { name: string, type?: string }[], returnType?: string | null }} F
 * @template {{ name: string, type?: string, address?: number | null, array?: number, init?: unknown, constant?: boolean }} G
 * @param {{ entry: string, functions: F[], globals?: G[] }} ir
 * @returns {{ functions: F[], globals: G[] }}
 */
export function optimizeReachable(ir) {
  const pruned = pruneUnreachable(ir);
  const optimized = optimizeIr({ ...ir, functions: pruned.functions, globals: pruned.globals });
  // Once more from the top: folding drops whole callers (2048's animated
  // move, on a machine without the RAM for it), and a helper those were
  // the other callers of is now called from one place — which the first
  // round counted as several, and so kept as a function rather than
  // writing it into its one live caller. The second prune makes the
  // count right; the second fold acts on it.
  const live = pruneUnreachable(optimized);
  return pruneUnreachable(optimizeIr({ ...optimized, functions: live.functions, globals: live.globals }));
}
