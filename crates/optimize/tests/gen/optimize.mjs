// Regenerates fixtures/optimize.json and fixtures/optimize-programs.json: what `linker/optimize.mjs`
// computes for the constant folder, the evaluator and the inlining passes over a handful of small
// synthetic programs and the smallest linked programs of a `corpus.mjs --dump` run. Run from the
// repo root:
//   node crates/optimize/tests/gen/optimize.mjs [<dump dir>]
// With no dump directory the script runs the corpus dump itself into a scratch directory and
// removes it. The passes are module-private, so the script copies optimize.mjs next to the original
// with an `export` line appended, imports the copy and deletes it. optimize.mjs itself is never
// edited.
//
// A row is `{fn, args, result}`. `args.p` names a program of optimize-programs.json, `args.f` one
// of its functions, `args.path` a statement (`[function, i, j, ...]`: the index into the body, then
// into the nested lists of block, while, for and if bodies), `args.k` a call expression of that
// statement (its position among the statement's own expressions' calls, in IR walk order; null is
// the statement's own call) and `args.ctx` the variable part of the optimizer's context. A pass that
// changes the context also returns what the context holds afterwards.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const linkerDir = join(repo, 'packages', 'compiler', 'src', 'linker');
const copy = join(linkerDir, '.optimize-export-for-fixtures.mjs');
const names = [
  'foldExpr', 'evalExpr', 'evalBlock', 'evalStmt', 'constEvalCall', 'optimizeBody', 'propagateConstLocals',
  'substituteBindings', 'forwardedCall', 'forwardCall', 'forwardExprCall', 'containsKind', 'countReturns',
  'collectNames', 'boundNames', 'freshName', 'writesOf', 'reachableHas', 'renameBound', 'singleCallerCallee',
  'siteCount', 'countCallsIn', 'siteBody', 'findValueCall', 'replaceNode', 'restIsInert', 'hoistValueCall',
  'inlineSingleCaller', 'inlineVoidCall', 'allNames',
];
writeFileSync(copy, `${readFileSync(join(linkerDir, 'optimize.mjs'), 'utf8')}\nexport { ${names.join(', ')} };\n`);
let m;
try {
  m = await import(pathToFileURL(copy).href);
} finally {
  rmSync(copy, { force: true });
}

// ---- programs --------------------------------------------------------------------------------

const T = 'utinyint';
const c = (value, type = T) => ({ kind: 'const', value, type });
const r = (name, type = T) => ({ kind: 'ref', name, type });
const bin = (operator, left, right, type = T) => ({ kind: 'binop', operator, left, right, type });
const call = (name, args, type = T) => ({ kind: 'call', name, args, type });
const callS = (name, args) => ({ kind: 'call', name, args });
const ret = (value) => ({ kind: 'return', value: value ?? null, start: 0, length: 0 });
const local = (name, init, type = T) => ({ kind: 'local', name, type, init });
const assign = (target, value) => ({ kind: 'assign', target, value });
const index = (array, at) => ({ kind: 'index', array, index: at, elementType: T, type: T });
const store = (array, at, value) => ({ kind: 'storeIndex', array, index: at, value, elementType: T, start: 0, length: 0 });
const iff = (test, then, otherwise = null) => ({ kind: 'if', test, then, else: otherwise, start: 0, length: 0 });
const str = (at) => ({ kind: 'string', index: at, type: 'string' });
const fn = (name, params, returnType, body, extra = {}) => ({
  name, exported: false, params: params.map(([n, t = T]) => ({ name: n, type: t })), returnType, body, start: 0, length: 0, ...extra,
});

const synthetic = [];
// Forwarders: a reorder, a constant, a forwarder of a forwarder, a value forwarder.
synthetic.push({
  globals: [{ name: 'g' }, { name: 'h' }],
  strings: [],
  functions: [
    fn('store2', [['a'], ['b']], 'void', [assign('g', bin('+', r('a'), r('b')))]),
    fn('fwd1', [['a'], ['b']], 'void', [callS('store2', [r('b'), r('a')])]),
    fn('fwd2', [['a']], 'void', [callS('store2', [r('a'), c(5)])]),
    fn('fwd3', [['a']], 'void', [callS('fwd1', [r('a'), c(1)])]),
    fn('fwdd', [['a'], ['b']], 'void', [callS('store2', [r('a'), r('a')])]),
    fn('val', [['a']], T, [ret(bin('+', r('a'), c(1)))]),
    fn('vfwd', [['a']], T, [ret(call('val', [r('a')]))]),
    fn('vfwdc', [['a']], T, [ret(call('val', [c(9)]))]),
    fn('vfwd2', [['a']], T, [ret(call('vfwd', [r('a')]))]),
    fn('impure', [], T, [assign('h', c(1)), ret(c(1))]),
    fn('main', [['p']], 'void', [
      callS('fwd1', [c(1), c(2)]),
      callS('fwd1', [r('p'), call('impure', [])]),
      callS('fwd2', [r('p')]),
      callS('fwd2', [c(3)]),
      callS('fwd3', [c(4)]),
      callS('fwdd', [c(1), call('impure', [])]),
      callS('fwdd', [c(1), c(2)]),
      local('v', call('vfwd', [c(4)])),
      assign('g', call('vfwd', [r('v')])),
      assign('h', call('vfwdc', [r('p')])),
      assign('h', call('vfwd2', [bin('+', r('v'), c(1))])),
      callS('store2', [call('val', [c(1)]), c(2)]),
    ]),
    fn('other', [], 'void', [callS('fwd2', [c(7)]), assign('h', call('vfwdc', [c(1)]))]),
  ],
});
// Rule 9: single callers, values and void bodies, locals kept, arrays and strings.
synthetic.push({
  globals: [{ name: 'g' }, { name: 'h' }, { name: 'acc' }, { name: 'arr', array: 4 }, { name: 'buf', type: 'string' }, { name: 'port', address: 53280 }],
  strings: [{ text: 'ab', bytes: [97, 98] }, { text: 'hello', bytes: [104, 101, 108, 108, 111] }],
  functions: [
    fn('sq', [['x']], T, [local('t', bin('*', r('x'), r('x'))), ret(r('t'))]),
    fn('two', [['a'], ['b']], T, [local('s', bin('+', r('a'), r('b'))), assign('acc', r('s')), ret(r('s'))]),
    fn('setup', [], 'void', [assign('g', c(1)), assign('h', c(2))]),
    fn('step', [['n']], 'void', [assign('g', r('n')), assign('h', bin('+', r('n'), c(1)))]),
    fn('wr', [['v']], 'void', [assign('port', r('v'))]),
    fn('rdg', [], T, [ret(r('g'))]),
    fn('bump', [], T, [assign('g', bin('+', r('g'), c(1))), ret(r('g'))]),
    fn('st', [['i']], 'void', [store(r('arr', 'array'), r('i'), c(1))]),
    fn('rd', [['i']], T, [ret(index(r('arr', 'array'), r('i')))]),
    fn('cp', [['s', 'string']], 'void', [{ kind: 'stringCopy', target: r('buf', 'string'), source: r('s', 'string'), capacity: 8, start: 0, length: 0 }]),
    fn('early', [['x']], 'void', [iff(r('x'), [ret()]), assign('g', c(1))]),
    fn('loopy', [['x']], T, [local('t', c(0)), { kind: 'while', test: bin('<', r('t'), r('x'), 'bool'), body: [assign('t', bin('+', r('t'), c(1)))], start: 0, length: 0 }, ret(r('t'))]),
    fn('main', [['p'], ['q', 'string']], 'void', [
      callS('setup', []),
      callS('step', [c(5)]),
      local('r1', call('sq', [c(3)])),
      local('r2', call('sq', [r('p')])),
      assign('g', bin('+', call('two', [r('p'), c(2)]), c(1))),
      callS('wr', [call('bump', [])]),
      assign('h', bin('+', r('g'), call('rdg', []))),
      callS('st', [c(1)]),
      assign('h', bin('+', index(r('arr', 'array'), c(0)), call('rd', [c(1)]))),
      assign('h', bin('+', call('rd', [c(2)]), r('g'))),
      callS('cp', [r('q', 'string')]),
      callS('cp', [str(0)]),
      callS('early', [r('p')]),
      assign('h', call('loopy', [c(3)])),
      iff(bin('>', call('sq', [c(2)]), c(1), 'bool'), [callS('step', [r('p')])], [callS('step', [c(0)])]),
      { kind: 'for', init: local('i', c(0)), test: bin('<', r('i'), call('rdg', []), 'bool'), update: assign('i', bin('+', r('i'), c(1))), body: [callS('step', [r('i')])], unroll: false, start: 0, length: 0 },
      { kind: 'while', test: bin('<', call('bump', []), c(9), 'bool'), body: [callS('step', [c(2)])], start: 0, length: 0 },
    ]),
    fn('again', [], 'void', [callS('step', [c(6)])]),
  ],
});
// Empty bodies, components, string copies, recursion, big bodies and unused parameters.
synthetic.push({
  globals: [{ name: 'g' }, { name: 'h' }],
  strings: [{ text: 'ab', bytes: [97, 98] }],
  functions: [
    fn('empty', [['a']], 'void', []),
    fn('comp', [['x']], 'void', [assign('g', r('x'))], { component: true }),
    fn('first', [['s', 'string']], 'void', [assign('g', { kind: 'stringByte', string: r('s', 'string'), index: c(0), type: T })]),
    fn('rec', [['n']], 'void', [callS('rec', [r('n')])]),
    fn('ping', [['n']], 'void', [callS('pong', [r('n')])]),
    fn('pong', [['n']], 'void', [callS('ping', [r('n')]), assign('h', c(1))]),
    fn('big', [['x']], 'void', [
      assign('g', bin('+', bin('*', bin('+', r('x'), c(1)), bin('+', r('x'), c(2))), bin('*', bin('+', r('x'), c(3)), bin('+', r('x'), c(4))))),
      assign('h', bin('+', bin('*', bin('+', r('x'), c(5)), bin('+', r('x'), c(6))), c(1))),
    ]),
    fn('ign', [['a']], 'void', [assign('g', c(1))]),
    fn('pure', [['a']], T, [ret(bin('+', c(2), c(3)))]),
    fn('addc', [['a'], ['b']], T, [ret(bin('+', r('a'), r('b')))]),
    fn('main', [['p']], 'void', [
      callS('empty', [c(1)]),
      callS('empty', [call('pure', [c(1)])]),
      callS('empty', [call('addc', [c(1), c(2)])]),
      callS('comp', [c(3)]),
      callS('comp', [r('p')]),
      callS('first', [str(0)]),
      callS('rec', [c(1)]),
      callS('ping', [c(1)]),
      callS('big', [c(1)]),
      callS('big', [c(2)]),
      callS('ign', [c(1)]),
      callS('ign', [c(2)]),
      assign('g', call('addc', [c(1), c(2)])),
      assign('h', call('addc', [c(250), c(10)])),
      assign('h', call('pure', [c(0)])),
    ]),
  ],
});

/** Every `linked.json` under `dir`, in ordinal path order. */
function linkedFiles(dir) {
  const found = [];
  const visit = (current) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name === 'linked.json') found.push(path);
    }
  };
  visit(dir);
  return found;
}

let dumpDir = process.argv[2];
let scratch = null;
const programs = [];
const corpus = [];
try {
  if (!dumpDir) {
    scratch = mkdtempSync(join(tmpdir(), 'optimize-'));
    dumpDir = scratch;
    execFileSync(process.execPath, [join(repo, 'scripts', 'oracle', 'corpus.mjs'), '--dump', '--out', dumpDir], {
      cwd: repo,
      stdio: ['ignore', 'ignore', 'inherit'],
      maxBuffer: 1 << 28,
    });
  }
  // The smallest programs with enough functions to have calls between them.
  const files = linkedFiles(dumpDir).map((path) => ({ path, size: statSync(path).size })).sort((a, b) => a.size - b.size || (a.path < b.path ? -1 : 1));
  for (const { path } of files) {
    if (corpus.length >= 5) break;
    const ir = JSON.parse(readFileSync(path, 'utf8'));
    if ((ir.functions ?? []).length < 4) continue;
    for (const f of ir.functions) f.params ??= [];
    corpus.push({ globals: ir.globals ?? [], strings: ir.strings ?? [], functions: ir.functions });
  }
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
const synthCount = synthetic.length;
for (const p of [...synthetic, ...corpus]) {
  p.addressed = (p.globals ?? []).filter((g) => g.address != null).map((g) => g.name);
  p.taken = [...m.allNames(p.functions, p.globals)];
  programs.push(p);
}

// ---- rows ------------------------------------------------------------------------------------

const sorted = (value) => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
};
const canonical = (value) => JSON.stringify(sorted(value));
const CAP = 600;
const rows = [];
const counts = new Map();
const seen = new Set();
const plain = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));

function add(name, args, run) {
  if ((counts.get(name) ?? 0) >= CAP) return;
  const key = `${name}\n${canonical(args)}`;
  if (seen.has(key)) return;
  seen.add(key);
  counts.set(name, (counts.get(name) ?? 0) + 1);
  rows.push({ fn: name, args, result: plain(run()) });
}

const arr = (set) => [...set].sort();
const base = { inlining: [], unrolling: false, callerBound: [], zpNames: [], currentFn: null, consumed: [], retired: [] };

function makeCtx(p, spec) {
  return {
    functionsByName: new Map(p.functions.map((f) => [f.name, f])),
    strings: p.strings,
    inlining: new Set(spec.inlining),
    unrollingStringCopy: spec.unrolling,
    taken: new Set(p.taken),
    callerBound: new Set(spec.callerBound),
    zpNames: new Set(spec.zpNames),
    currentFn: spec.currentFn === null ? null : p.functions.find((f) => f.name === spec.currentFn),
    remarks: [],
    consumed: new Set(spec.consumed),
    retired: new Set(spec.retired),
    addressed: new Set(p.addressed),
  };
}
const state = (ctx) => ({
  inlining: arr(ctx.inlining), taken: arr(ctx.taken), zpNames: arr(ctx.zpNames), consumed: arr(ctx.consumed), retired: arr(ctx.retired),
});
const withState = (ctx, out) => ({ out, state: state(ctx) });

const specsFor = (p, f, callee, full) => {
  const bound = arr(m.boundNames(f));
  const inFn = { ...base, currentFn: f.name, callerBound: bound, zpNames: bound };
  const list = [base, inFn];
  if (full) {
    list.push({ ...base, unrolling: true }, { ...inFn, unrolling: true });
    if (callee) {
      list.push({ ...base, consumed: [callee] }, { ...base, retired: [callee] }, { ...base, inlining: [callee] }, { ...inFn, retired: [callee] });
    }
    list.push({ ...base, callerBound: ['g', 'h', 'x', 'p'] });
  }
  return list;
};

const children = (s) => {
  switch (s.kind) {
    case 'block': case 'while': case 'for': return s.body ?? [];
    case 'if': return [...(s.then ?? []), ...(s.else ?? [])];
    default: return [];
  }
};
function* statementsOf(f, fi) {
  const go = function* (list, prefix) {
    for (let i = 0; i < list.length; i++) {
      const path = [...prefix, i];
      yield [list[i], path];
      yield* go(children(list[i]), path);
    }
  };
  yield* go(f.body, [fi]);
}

/** Calls in an expression, outermost first (IR walk order). */
function exprCalls(e, out) {
  if (!e || typeof e !== 'object') return;
  if (e.kind === 'call') out.push(e);
  switch (e.kind) {
    case 'binop': exprCalls(e.left, out); exprCalls(e.right, out); break;
    case 'call': case 'namespaceCall': for (const a of e.args ?? []) exprCalls(a, out); break;
    case 'index': exprCalls(e.array, out); exprCalls(e.index, out); break;
    case 'memoryRead': exprCalls(e.address, out); break;
    case 'stringByte': exprCalls(e.string, out); exprCalls(e.index, out); break;
    case 'stringLength': exprCalls(e.string, out); break;
    case 'unop': exprCalls(e.argument, out); break;
    default: break;
  }
}
/** The calls of a statement's own expressions (not the statements nested in it), in walk order. */
function ownCalls(s) {
  const out = [];
  const each = (...exprs) => { for (const e of exprs) exprCalls(e, out); };
  switch (s.kind) {
    case 'assign': case 'local': case 'return': each(s.value ?? s.init); break;
    case 'call': case 'namespaceCall': each(...(s.args ?? [])); break;
    case 'memoryRead': each(s.address); break;
    case 'memoryWrite': each(s.address, s.value); break;
    case 'storeIndex': each(s.array, s.index, s.value); break;
    case 'if': case 'while': each(s.test); break;
    case 'for': {
      if (s.init) each(s.init.value ?? s.init.init);
      each(s.test);
      if (s.update) each(s.update.value ?? s.update.init);
      break;
    }
    case 'stringCopy': each(s.target, s.source); break;
    default: break;
  }
  return out;
}
const ownExprs = (s) => {
  switch (s.kind) {
    case 'assign': return [s.value];
    case 'local': return [s.init];
    case 'return': return s.value ? [s.value] : [];
    default: return [];
  }
};

const evalResult = (res) => (res === 'abort' ? 'abort' : { returned: !!res?.returned, value: res?.value ?? null });
const envOf = (f, value) => new Map(f.params.map((param) => [param.name, value]));
const envEntries = (env) => [...env.entries()];
const TESTS = {
  store: (n) => n.kind === 'storeIndex' || n.kind === 'memoryWrite' || n.kind === 'stringCopy',
  asm: (n) => n.kind === 'asm',
  return: (n) => n.kind === 'return',
  call: (n) => n.kind === 'call',
};
const REPLACEMENT = { kind: 'const', value: 9, type: T };

function programRows(pi, p, full) {
  const fns = p.functions;
  const calleeOf = (cn) => p.functions.find((g) => g.name === cn.name);
  fns.forEach((f, fi) => {
    const A = { p: pi, f: fi };
    add('forwardedCall', A, () => {
      const out = m.forwardedCall(f);
      return out && { wrapped: out.wrapped, constants: out.constants, used: arr(out.used) };
    });
    add('boundNames', A, () => arr(m.boundNames(f)));
    for (const spec of specsFor(p, f, null, full)) {
      const C = { ...A, ctx: spec };
      add('writesOf', C, () => arr(m.writesOf(f, makeCtx(p, spec))));
      for (const test of Object.keys(TESTS)) add('reachableHas', { ...C, test }, () => m.reachableHas(f, makeCtx(p, spec), TESTS[test]));
      add('siteCount', { ...C, name: f.name }, () => m.siteCount(f.name, makeCtx(p, spec)));
      add('optimizeBody', C, () => m.optimizeBody(f.body, makeCtx(p, spec)));
    }
    add('propagateConstLocals', A, () => m.propagateConstLocals(JSON.parse(JSON.stringify(f.body)), makeCtx(p, base)));
    const callees = new Set([f.name]);
    for (const [s] of statementsOf(f, fi)) {
      for (const cn of [...ownCalls(s), ...(s.kind === 'call' ? [s] : [])]) callees.add(cn.name);
    }
    for (const name of callees) add('countCallsIn', { ...A, name }, () => m.countCallsIn(f.body, name));
    if (f.params.length <= 3) {
      for (const value of [0, 3]) {
        const env = envOf(f, value);
        add('evalBlock', { ...A, env: envEntries(env), ctx: base }, () => {
          const e = new Map(env);
          const res = evalResult(m.evalBlock(f.body, e, makeCtx(p, base)));
          return { res, env: envEntries(e) };
        });
      }
    }
    for (const [s, path] of statementsOf(f, fi)) {
      const S = { p: pi, path };
      for (const kind of ['asm', 'return', 'call', 'local', 'stringCopy']) add('containsKind', { ...S, kind }, () => m.containsKind([s], kind));
      add('countReturns', S, () => m.countReturns([s]));
      add('collectNames', S, () => { const out = new Set(); m.collectNames([s], out); return arr(out); });
      const bound = arr(m.boundNames(f));
      if (bound.length) {
        const renames = bound.map((n) => [n, `${n}_r`]);
        add('renameBound', { ...S, renames }, () => m.renameBound([s], new Map(renames)));
      }
      for (const replacement of [c(7), r('zz')]) {
        const bindings = f.params.map((param) => [param.name, replacement]);
        if (bindings.length) add('substituteBindings', { ...S, bindings }, () => m.substituteBindings([s], new Map(bindings)));
      }
      for (const spec of specsFor(p, f, null, full)) {
        const C = { ...S, ctx: spec };
        add('hoistValueCall', C, () => { const ctx = makeCtx(p, spec); return withState(ctx, m.hoistValueCall(s, ctx)); });
        add('findValueCall', C, () => {
          const found = m.findValueCall(s, makeCtx(p, spec), { container: s.kind === 'call' ? s : null });
          return found ? { k: ownCalls(s).indexOf(found) } : null;
        });
        if (s.kind === 'call') {
          add('inlineVoidCall', C, () => { const ctx = makeCtx(p, spec); return withState(ctx, m.inlineVoidCall(s, ctx)); });
        }
      }
      for (const value of [0, 3]) {
        const env = envOf(f, value);
        add('evalStmt', { ...S, env: envEntries(env), ctx: base }, () => {
          const e = new Map(env);
          const res = evalResult(m.evalStmt(s, e, makeCtx(p, base)));
          return { res, env: envEntries(e) };
        });
        for (const [x, expr] of ownExprs(s).entries()) {
          add('evalExpr', { ...S, x, env: envEntries(env), ctx: base }, () => m.evalExpr(expr, new Map(env), makeCtx(p, base)));
        }
      }
      const targets = [...(s.kind === 'call' ? [null] : []), ...ownCalls(s).map((_, k) => k)];
      const calls = ownCalls(s);
      for (const k of targets) {
        const cn = k === null ? s : calls[k];
        const callee = calleeOf(cn);
        const T2 = { ...S, k };
        for (const spec of specsFor(p, f, callee?.name, full)) {
          const C = { ...T2, ctx: spec };
          for (const wantValue of [true, false]) {
            add('singleCallerCallee', { ...C, wantValue }, () => m.singleCallerCallee(cn, makeCtx(p, spec), wantValue)?.name ?? null);
          }
          add('constEvalCall', C, () => m.constEvalCall(cn, makeCtx(p, spec)));
          if (k !== null) {
            add('foldExpr', C, () => { const ctx = makeCtx(p, spec); return withState(ctx, m.foldExpr(cn, ctx)); });
            add('forwardExprCall', C, () => { const ctx = makeCtx(p, spec); return withState(ctx, m.forwardExprCall(cn, ctx)); });
            add('restIsInert', C, () => (callee ? m.restIsInert(s, cn, callee, makeCtx(p, spec)) : null));
            add('replaceNode', { ...T2 }, () => m.replaceNode(s, cn, REPLACEMENT));
          }
          if (callee && callee.params.length === cn.args.length) {
            const last = callee.body[callee.body.length - 1];
            if (callee.returnType === 'void' || (last?.kind === 'return' && last.value)) {
              add('siteBody', C, () => {
                const ctx = makeCtx(p, spec);
                const site = m.siteBody(cn, callee, ctx);
                return withState(ctx, site && {
                  statements: site.statements, returned: site.returned ?? null, locals: [...site.locals.entries()], free: arr(site.free),
                });
              });
              if (k === null) {
                add('inlineSingleCaller', C, () => { const ctx = makeCtx(p, spec); return withState(ctx, m.inlineSingleCaller(cn, callee, ctx)); });
              }
            }
            const forwarded = m.forwardedCall(callee);
            if (forwarded) {
              add('forwardCall', C, () => m.forwardCall(cn, callee, forwarded, makeCtx(p, spec)));
            }
          }
        }
      }
    }
  });
}

programs.forEach((p, pi) => programRows(pi, p, pi < synthCount));

// Fresh names, over taken sets with gaps.
for (const taken of [[], ['a'], ['a', 'a_2'], ['a', 'a_2', 'a_3', 'b']]) {
  for (const name of ['a', 'b', 'c']) {
    add('freshName', { taken, name }, () => {
      const set = new Set(taken);
      const out = m.freshName(name, set);
      return { out, taken: [...set] };
    });
  }
}

mkdirSync(join(here, '..', 'fixtures'), { recursive: true });
const slim = programs.map((p) => ({ functions: p.functions, strings: p.strings, addressed: p.addressed, taken: p.taken }));
writeFileSync(join(here, '..', 'fixtures', 'optimize-programs.json'), `${JSON.stringify(slim)}\n`);
writeFileSync(join(here, '..', 'fixtures', 'optimize.json'), `${JSON.stringify(rows)}\n`);
const summary = [...counts].map(([name, n]) => `${name} ${n}`).join(', ');
process.stdout.write(`optimize: ${programs.length} programs, ${rows.length} rows (${summary})\n`);
