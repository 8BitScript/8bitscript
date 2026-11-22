// Regenerates fixtures/leaf.json: what `linker/optimize.mjs` computes for its leaf passes over
// every statement and expression of the linked IR of a `corpus.mjs --dump` run. Run from the
// repo root:
//   node crates/optimize/tests/gen/optimize-leaf.mjs [<dump dir>]
// With no dump directory the script runs the corpus dump itself into a scratch directory and
// removes it. Most of the passes are module-private, so the script copies optimize.mjs next to the
// original with an `export` line appended, imports the copy and deletes it. optimize.mjs itself is
// never edited.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const linkerDir = join(repo, 'packages', 'compiler', 'src', 'linker');
const copy = join(linkerDir, '.optimize-export-for-fixtures.mjs');
const names = [
  'collectAssigned', 'collectBoundNames', 'containsStringByte', 'nodeCount', 'containsReturn',
  'asmNames', 'referencesNames', 'wrapUnsigned', 'isNumericConst', 'isCompileTimeArg',
  'isSideEffectFree', 'constValue', 'reduceMultiply', 'reduceDivide', 'reduceModulo',
  'stringBytes', 'bindsName', 'alwaysReturns',
];
writeFileSync(copy, `${readFileSync(join(linkerDir, 'optimize.mjs'), 'utf8')}\nexport { ${names.join(', ')} };\n`);
let m;
try {
  m = await import(pathToFileURL(copy).href);
} finally {
  rmSync(copy, { force: true });
}

let dumpDir = process.argv[2];
let scratch = null;
if (!dumpDir) {
  scratch = mkdtempSync(join(tmpdir(), 'optimize-leaf-'));
  dumpDir = scratch;
  execFileSync(process.execPath, [join(repo, 'scripts', 'oracle', 'corpus.mjs'), '--dump', '--out', dumpDir], {
    cwd: repo,
    stdio: ['ignore', 'ignore', 'inherit'],
    maxBuffer: 1 << 28,
  });
}

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

const sorted = (value) => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
};
const canonical = (value) => JSON.stringify(sorted(value));

const CAP = 300;
const rows = [];
const counts = new Map();
const seen = new Set();

/** The set results become arrays in insertion order. */
const plain = (value) => (value instanceof Set ? [...value] : value);

function add(fn, args, run) {
  if ((counts.get(fn) ?? 0) >= CAP) return;
  const key = `${fn}\n${canonical(args)}`;
  if (seen.has(key)) return;
  seen.add(key);
  counts.set(fn, (counts.get(fn) ?? 0) + 1);
  rows.push({ fn, args, result: plain(run()) });
}

const set = (fn) => (node) => {
  const out = new Set();
  fn(node, out);
  return out;
};
const collectAssigned = set(m.collectAssigned);
const collectBoundNames = set(m.collectBoundNames);

function statementRows(stmt, ir, fn) {
  const names = fn.params.map((p) => p.name);
  add('collectAssigned', [stmt], () => collectAssigned(stmt));
  add('collectBoundNames', [stmt], () => collectBoundNames(stmt));
  add('containsStringByte', [stmt], () => m.containsStringByte(stmt));
  add('nodeCount', [stmt], () => m.nodeCount(stmt));
  add('containsJump', [stmt], () => m.containsJump(stmt));
  add('containsReturn', [stmt], () => m.containsReturn(stmt));
  add('alwaysReturns', [stmt], () => m.alwaysReturns(stmt));
  add('referencesNames', [stmt, names], () => m.referencesNames(stmt, new Set(names)));
  if (stmt.kind === 'asm') add('asmNames', [stmt, names], () => m.asmNames(stmt, new Set(names)));
  for (const name of names) add('bindsName', [stmt, name], () => m.bindsName(stmt, name));
  if (stmt.kind === 'for') {
    for (const max of [32, 4096]) add('matchCountedFor', [stmt, max], () => m.matchCountedFor(stmt, max));
  }
}

function expressionRows(expr, ir) {
  add('isNumericConst', [expr], () => m.isNumericConst(expr));
  add('isCompileTimeArg', [expr], () => m.isCompileTimeArg(expr));
  add('isSideEffectFree', [expr], () => m.isSideEffectFree(expr));
  add('constValue', [expr], () => m.constValue(expr));
  if (expr.kind === 'binop') {
    if (expr.operator === '*') add('reduceMultiply', [expr], () => m.reduceMultiply(expr));
    if (expr.operator === '/') add('reduceDivide', [expr], () => m.reduceDivide(expr));
    if (expr.operator === '%') add('reduceModulo', [expr], () => m.reduceModulo(expr));
  }
  if (expr.kind === 'const' && typeof expr.type === 'string') {
    add('wrapUnsigned', [expr.value, expr.type], () => m.wrapUnsigned(expr.value, expr.type));
  }
  if (expr.kind === 'string') {
    // The context carries the strings up to the one the expression names: `stringBytes` reads one entry.
    const ctx = { strings: (ir.strings ?? []).slice(0, expr.index + 1) };
    add('stringBytes', [expr, ctx], () => m.stringBytes(expr, ctx));
  }
}

const object = (value) => value !== null && typeof value === 'object';

function walkExpr(expr, ir) {
  if (!object(expr)) return;
  expressionRows(expr, ir);
  const each = (list) => { for (const item of list ?? []) walkExpr(item, ir); };
  switch (expr.kind) {
    case 'binop': walkExpr(expr.left, ir); walkExpr(expr.right, ir); break;
    case 'call': case 'namespaceCall': each(expr.args); break;
    case 'index': walkExpr(expr.array, ir); walkExpr(expr.index, ir); break;
    case 'memoryRead': walkExpr(expr.address, ir); break;
    case 'stringByte': walkExpr(expr.string, ir); walkExpr(expr.index, ir); break;
    case 'stringLength': walkExpr(expr.string, ir); break;
    case 'unop': walkExpr(expr.argument, ir); break;
    case 'cond': walkExpr(expr.test, ir); walkExpr(expr.consequent, ir); walkExpr(expr.alternate, ir); break;
    case 'portRead': walkExpr(expr.port, ir); break;
    case 'portWrite': walkExpr(expr.port, ir); walkExpr(expr.value, ir); break;
    case 'record': for (const field of expr.fields ?? []) walkExpr(field.value, ir); break;
    default: break;
  }
}

function walkStmt(stmt, ir, fn) {
  if (!object(stmt)) return;
  statementRows(stmt, ir, fn);
  const body = (list) => { for (const item of list ?? []) walkStmt(item, ir, fn); };
  switch (stmt.kind) {
    case 'assign': walkExpr(stmt.value, ir); break;
    case 'block': body(stmt.body); break;
    case 'call': case 'namespaceCall': for (const arg of stmt.args ?? []) walkExpr(arg, ir); break;
    case 'for': walkStmt(stmt.init, ir, fn); walkExpr(stmt.test, ir); walkStmt(stmt.update, ir, fn); body(stmt.body); break;
    case 'if': walkExpr(stmt.test, ir); body(stmt.then); body(stmt.else); break;
    case 'local': walkExpr(stmt.init, ir); break;
    case 'memoryRead': walkExpr(stmt.address, ir); break;
    case 'memoryWrite': walkExpr(stmt.address, ir); walkExpr(stmt.value, ir); break;
    case 'return': walkExpr(stmt.value, ir); break;
    case 'storeIndex': walkExpr(stmt.array, ir); walkExpr(stmt.index, ir); walkExpr(stmt.value, ir); break;
    case 'while': walkExpr(stmt.test, ir); body(stmt.body); break;
    case 'portWrite': walkExpr(stmt.port, ir); walkExpr(stmt.value, ir); break;
    case 'stringCopy': walkExpr(stmt.target, ir); walkExpr(stmt.source, ir); break;
    case 'portRead': walkExpr(stmt.port, ir); break;
    default: break;
  }
}

try {
  for (const file of linkedFiles(dumpDir)) {
    const ir = JSON.parse(readFileSync(file, 'utf8'));
    for (const fn of ir.functions ?? []) {
      fn.params ??= [];
      for (const stmt of fn.body ?? []) walkStmt(stmt, ir, fn);
    }
  }
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}

// Shapes the corpus has few of, outside the per-function cap: every operator over small operands,
// the multiply, divide and modulo reductions over their edge constants, and the unsigned wrap.
const konst = (value, type) => (type === undefined ? { kind: 'const', value } : { kind: 'const', value, type });
const ref = (name) => ({ kind: 'ref', name });
const synthetic = (fn, args, run) => {
  const key = `${fn}\n${canonical(args)}`;
  if (seen.has(key)) return;
  seen.add(key);
  rows.push({ fn, args, result: plain(run()) });
};
const operators = ['==', '!=', '<', '<=', '>', '>=', '&&', '||', '+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'];
const operands = [0, 1, 3, 5, 250, 255];
for (const type of ['utinyint', 'tinyint']) {
  for (const operator of operators) {
    for (const left of operands) {
      for (const right of operands) {
        const expr = { kind: 'binop', operator, left: konst(left, type), right: konst(right, type), type };
        synthetic('constValue', [expr], () => m.constValue(expr));
      }
    }
  }
}
for (const argument of [konst(0), konst(7), { kind: 'unop', operator: '!', argument: konst(0), type: 'bool' }]) {
  const expr = { kind: 'unop', operator: '!', argument, type: 'bool' };
  synthetic('constValue', [expr], () => m.constValue(expr));
}
for (const type of ['utinyint', 'usmallint', 'tinyint']) {
  const others = [ref('x'), { kind: 'call', name: 'f', args: [] }, { kind: 'binop', operator: '+', left: ref('x'), right: ref('y'), type }];
  for (const value of [0, 1, 2, 3, 5, 6, 7, 8, 10, 12, 15, 24, 40, 100, 255, 256, -1, 2 ** 31, 2 ** 32 + 1]) {
    for (const other of others) {
      for (const [left, right] of [[konst(value, type), other], [other, konst(value, type)]]) {
        const expr = { kind: 'binop', operator: '*', left, right, type };
        synthetic('reduceMultiply', [expr], () => m.reduceMultiply(expr));
      }
    }
  }
  for (const value of [0, 1, 2, 3, 4, 8, 16, 128, 256, 1024, 6, -2]) {
    for (const operator of ['/', '%']) {
      const expr = { kind: 'binop', operator, left: ref('x'), right: konst(value, type), type };
      synthetic(operator === '/' ? 'reduceDivide' : 'reduceModulo', [expr], () => (operator === '/' ? m.reduceDivide(expr) : m.reduceModulo(expr)));
    }
  }
}
for (const type of ['utinyint', 'usmallint', 'umediumint', 'uint', 'u8', 'u16', 'tinyint', 'smallint', 'bool', 'string', 'nothing']) {
  for (const value of [-300, -1, 0, 255, 256, 300, 65535, 65536, 1e9]) {
    synthetic('wrapUnsigned', [value, type], () => m.wrapUnsigned(value, type));
  }
}
for (const [index, strings] of [[0, []], [3, []], [3, [{ text: 'a', bytes: [97] }]], [-1, [{ text: 'a', bytes: [97] }]]]) {
  const expr = { kind: 'string', index, type: 'string' };
  const ctx = { strings };
  synthetic('stringBytes', [expr, ctx], () => m.stringBytes(expr, ctx));
}

mkdirSync(join(here, '..', 'fixtures'), { recursive: true });
writeFileSync(join(here, '..', 'fixtures', 'leaf.json'), `${JSON.stringify(rows)}\n`);
const summary = [...counts].map(([fn, n]) => `${fn} ${n}`).join(', ');
process.stdout.write(`optimize-leaf: ${rows.length} rows (${summary})\n`);
