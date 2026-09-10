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
//      copy and N is small. Empty callees stay as calls: several
//      calling-convention fixtures stub a body as `[]`, and deleting
//      those would drop the argument shuffle the fixture exists to measure.
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

function countCalls(functionsByName, name) {
  let n = 0;
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node && typeof node === 'object') {
      if (node.kind === 'call' && node.name === name) n += 1;
      for (const value of Object.values(node)) walk(value);
    }
  };
  for (const fn of functionsByName.values()) walk(fn.body);
  return n;
}

function containsJump(node) {
  if (Array.isArray(node)) return node.some(containsJump);
  if (!node || typeof node !== 'object') return false;
  if (node.kind === 'break' || node.kind === 'continue') return true;
  return Object.values(node).some(containsJump);
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
    default: return null;
  }
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
  if (countCalls(ctx.functionsByName, call.name) > 1) return null;
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
      if (alwaysReturns(piece)) return out;
    }
  }
  return out;
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

function inlineVoidCall(statement, ctx) {
  if (!ctx?.functionsByName || typeof statement.name !== 'string') return null;
  const fn = ctx.functionsByName.get(statement.name);
  if (!fn) return null;
  if ((fn.body ?? []).length === 0) return null;
  if (fn.returnType && fn.returnType !== 'void') return null;
  if (ctx.inlining.has(statement.name)) return null;
  const params = fn.params ?? [];
  const args = statement.args ?? [];
  if (params.length !== args.length) return null;
  if (!args.every(isCompileTimeArg)) return null;
  const paramNames = new Set(params.map((p) => p.name));
  const unusedParams = params.length > 0 && !referencesNames(fn.body, paramNames);
  const stringCopy = containsStringByte(fn.body) || ctx.unrollingStringCopy;
  if (params.length > 0 && !stringCopy && !unusedParams) return null;
  if (unusedParams && countCalls(ctx.functionsByName, statement.name) > 1) return null;
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
    const taken = optimizeBody(statement.then, ctx);
    const otherwise = statement.else ? optimizeBody(statement.else, ctx) : null;
    const value = constValue(test);
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
    const inlined = inlineVoidCall(folded, ctx);
    if (inlined) return inlined;
    return [folded];
  }
  return [foldExpr(statement, ctx)];
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
  };
  functions = functions.map((fn) => ({ ...fn, body: optimizeBody(fn.body, ctx) }));
  ctx.functionsByName = new Map(functions.map((fn) => [fn.name, fn]));
  functions = functions.map((fn) => ({ ...fn, body: optimizeBody(fn.body, ctx) }));
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
  return pruneUnreachable(optimized);
}
