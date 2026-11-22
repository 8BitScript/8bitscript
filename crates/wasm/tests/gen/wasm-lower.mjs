// Regenerates fixtures/wasm-lower.json: what `wasm/lower.ts` computes. Run from the repo root:
//   node crates/wasm/tests/gen/wasm-lower.mjs
// Both the context helpers (lines 1-230) and `lower` itself are module-private or need a context
// `build()` lays out, so the script copies lower.ts and index.ts next to the originals (the copy of
// lower.ts gains an export line and a recording wrapper around `lower`; the copy of index.ts imports
// that copy), imports the copies and deletes them. Neither original is ever edited.
//
// The corpus rows come from one dump-and-use run: the script writes every corpus program's stage
// dumps (scripts/oracle/corpus.mjs --dump), feeds each `wasm-input.json` through the copy of
// `build()` and records every `lower()` call it makes (body, options, outcome). Rows whose
// body, parameters and context are equal are kept once; contexts are shared by index.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INTEGER_TYPE_NAMES } from '../../../../packages/compiler/src/types/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const wasmDir = join(root, 'packages', 'compiler', 'src', 'wasm');
const lowerCopy = join(wasmDir, '.lower-export-for-fixtures.ts');
const indexCopy = join(wasmDir, '.index-export-for-fixtures.ts');
const dumpDir = join(root, 'scratch-wasm-lower-dump');
const names = ['i32Const', 'binding', 'maskToType', 'UNSIGNED_ORDERING', 'EQUALITY', 'operandIsSigned'];

const LOWER_SIGNATURE = 'export function lower(body: IrStatement[], options: LowerOptions = {}): LowerResult | LowerFailure {';
// Every call's inputs are read as plain data right away: the maps are `[key, value]` entry lists.
const wrapper = `
export const __taps: unknown[] = [];
const __entries = (m: Map<string, unknown>) => [...m.entries()];
export function lower(body: IrStatement[], options: LowerOptions = {}): LowerResult | LowerFailure {
  const result = lowerImpl(body, options);
  __taps.push({
    params: options.params ?? [],
    globals: __entries(options.globals ?? new Map()),
    functions: __entries(options.functions ?? new Map()),
    strings: options.strings ?? [],
    arrays: __entries(options.arrays ?? new Map()),
    pinned: __entries(options.pinned ?? new Map()),
    waitFrameIndex: options.waitFrameIndex ?? null,
    body,
    result,
  });
  return result;
}
`;
const lowerSource = readFileSync(join(wasmDir, 'lower.ts'), 'utf8');
if (!lowerSource.includes(LOWER_SIGNATURE)) throw new Error('lower.ts: the `lower` signature moved');
const indexSource = readFileSync(join(wasmDir, 'index.ts'), 'utf8');
if (!indexSource.includes("from './lower.ts'")) throw new Error('index.ts: the lower import moved');
writeFileSync(
  lowerCopy,
  `${lowerSource.replace(LOWER_SIGNATURE, LOWER_SIGNATURE.replace('export function lower(', 'function lowerImpl('))}\nexport { ${names.join(', ')} };\n${wrapper}`,
);
writeFileSync(indexCopy, indexSource.replaceAll("from './lower.ts'", "from './.lower-export-for-fixtures.ts'"));
let m;
let wasmIndex;
try {
  m = await import(pathToFileURL(lowerCopy).href);
  wasmIndex = await import(pathToFileURL(indexCopy).href);
} finally {
  rmSync(lowerCopy, { force: true });
  rmSync(indexCopy, { force: true });
}

const attempt = (f) => {
  try {
    const value = f();
    return value instanceof Uint8Array || Array.isArray(value) ? [...value] : value;
  } catch (error) {
    return { throw: error.message };
  }
};

const out = {};
out.i32Const = [0, 1, -1, 63, -63, 64, -64, 127, -127, 128, -128, 255, 256, 65535, 2 ** 31 - 1, -(2 ** 31), 2 ** 31, 2 ** 32 - 1, 1.5, NaN]
  .map((n) => ({ args: [n], result: attempt(() => m.i32Const(n)) }));

const types = [...INTEGER_TYPE_NAMES, 'bool', null, '', 'string', 'nope'];
out.maskToType = types.map((t) => ({ args: [[0x41, 0], t], result: attempt(() => m.maskToType([0x41, 0], t)) }));

out.operandIsSigned = [...types, undefined].map((t) => {
  const node = { kind: 'ref', name: 'x', ...(t === undefined ? {} : { type: t }) };
  return { node, result: m.operandIsSigned(node) };
});
const untyped = [
  { kind: 'const', value: 1 },
  { kind: 'const', value: 1, type: 'int' },
  { kind: 'binop', operator: '+', left: { kind: 'const', value: 1 }, right: { kind: 'const', value: 2 }, type: 'tinyint' },
  { kind: 'stringLength', string: { kind: 'string', index: 0 }, type: 'utinyint' },
];
out.operandIsSignedNodes = untyped.map((node) => ({ node, result: m.operandIsSigned(node) }));

const ctx = {
  locals: [['x', 0], ['s', 2]],
  globals: [['g', 1], ['s', 3]],
};
const mapCtx = { locals: new Map(ctx.locals), globals: new Map(ctx.globals) };
out.ctx = ctx;
out.binding = ['x', 'g', 's', 'missing'].map((name) => ({ name, result: attempt(() => m.binding(mapCtx, name)) }));

out.tables = {
  unsignedOrdering: Object.entries(m.UNSIGNED_ORDERING),
  equality: Object.entries(m.EQUALITY),
};

// The corpus functions: dump every program, then lower every `wasm-input.json` function.
const wasmInputs = (dir) => readdirSync(dir, { withFileTypes: true })
  .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
  .flatMap((e) => (e.isDirectory() ? wasmInputs(join(dir, e.name)) : e.name === 'wasm-input.json' ? [join(dir, e.name)] : []));

rmSync(dumpDir, { recursive: true, force: true });
const ctxs = [];
const ctxIndex = new Map();
const corpus = [];
const seen = new Set();
// One recorded `lower()` call as a fixture row; `null` when an equal row is already in `into`.
const record = (tap, into) => {
  const ctx = {
    globals: tap.globals, functions: tap.functions, strings: tap.strings, arrays: tap.arrays,
    pinned: tap.pinned, waitFrameIndex: tap.waitFrameIndex,
  };
  const key = JSON.stringify(ctx);
  if (!ctxIndex.has(key)) {
    ctxIndex.set(key, ctxs.length);
    ctxs.push(ctx);
  }
  const row = { ctx: ctxIndex.get(key), params: tap.params, body: tap.body };
  const rowKey = `${into === corpus ? 'c' : 's'}${JSON.stringify(row)}`;
  if (seen.has(rowKey)) return;
  seen.add(rowKey);
  into.push({ ...row, result: tap.result });
};

// Hand-made bodies for the paths the corpus does not reach (every refusal, the 2-byte array
// forms, pinned scalars, string copies). They run through the same copy of `lower`.
const k = (value, type) => ({ kind: 'const', value, ...(type ? { type } : {}) });
const r = (name, type) => ({ kind: 'ref', name, ...(type ? { type } : {}) });
const bin = (operator, left, right, type) => ({ kind: 'binop', operator, left, right, ...(type ? { type } : {}) });
const un = (operator, argument, type) => ({ kind: 'unop', operator, argument, ...(type ? { type } : {}) });
const local = (name, init, type = 'int') => ({ kind: 'local', name, type, init });
const asg = (target, value) => ({ kind: 'assign', target, value });
const ret = (value = null) => ({ kind: 'return', value, start: 0, length: 0 });
const call = (name, args = []) => ({ kind: 'call', name, args });
const idx = (array, index, type) => ({ kind: 'index', array, index, ...(type ? { type } : {}) });
const store = (array, index, value) => ({ kind: 'storeIndex', array, index, value, start: 0, length: 0 });
const wh = (test, body) => ({ kind: 'while', test, body, start: 0, length: 0 });
const sctx = {
  globals: new Map([['g', 0], ['h', 1]]),
  functions: new Map([['f', { index: 1, paramCount: 1, returnsValue: true }], ['v', { index: 2, paramCount: 0, returnsValue: false }]]),
  strings: [9000, 9010],
  arrays: new Map([['a', { address: 8192, elementWidth: 1, mutable: true }], ['w', { address: 8300, elementWidth: 2, mutable: true }], ['c', { address: 8400, elementWidth: 1, mutable: false }]]),
  pinned: new Map([['p', { address: 53280, width: 1 }], ['q', { address: 1024, width: 2 }]]),
  waitFrameIndex: 0,
};
const params = [{ name: 'x', type: 'utinyint' }, { name: 'y', type: 'tinyint' }];
const bodies = [];
for (const operator of ['&&', '||', '==', '!=', '<', '<=', '>', '>=', '+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '**']) {
  bodies.push([ret(bin(operator, r('x', 'utinyint'), r('g', 'int'), 'int'))]);
  bodies.push([ret(bin(operator, r('y', 'tinyint'), r('x', 'utinyint'), 'tinyint'))]);
  bodies.push([ret(bin(operator, r('x', 'utinyint'), r('y', 'tinyint'), 'utinyint'))]);
}
for (const operator of ['!', '+', '-', '~', '++']) {
  bodies.push([ret(un(operator, r('x', 'utinyint'), 'utinyint'))]);
  bodies.push([ret(un(operator, r('g', 'int'), 'int'))]);
}
bodies.push(
  [ret({ kind: 'cond', test: r('x'), consequent: k(1), alternate: k(2) })],
  [ret({ kind: 'memoryRead', address: k(53280), type: 'utinyint', start: 0, length: 1 })],
  [{ kind: 'memoryWrite', address: k(53280), value: r('x'), start: 0, length: 1 }],
  [ret(call('f', [k(1)]))],
  [ret(call('f', []))],
  [ret(call('nope', []))],
  [call('f', [k(1)])],
  [call('v')],
  [call('nope')],
  [ret({ kind: 'string', index: 1 })],
  [ret({ kind: 'string', index: 5 })],
  [ret({ kind: 'stringLength', string: { kind: 'string', index: 0 }, type: 'utinyint' })],
  [ret({ kind: 'stringByte', string: { kind: 'string', index: 0 }, index: r('x'), type: 'utinyint' })],
  [ret(r('a')), ret(r('w')), ret(r('p')), ret(r('q')), ret(r('g')), ret(r('missing'))],
  [ret(idx(r('a'), r('x'))), ret(idx(r('w'), r('x'))), ret(idx(r('c'), k(3)))],
  [ret(idx(r('a'), bin('+', r('x', 'utinyint'), k(250), 'int')))],
  [ret(idx(r('a'), bin('+', k(250), r('x', 'utinyint'), 'int')))],
  [ret(idx(r('w'), bin('+', r('x', 'utinyint'), k(3), 'int')))],
  [ret(idx(r('a'), bin('+', r('g', 'int'), k(3), 'int')))],
  [ret(idx(r('a'), bin('+', r('x', 'utinyint'), k(-3), 'int')))],
  [ret(idx(r('a'), bin('+', r('x'), k(3), 'int')))],
  [ret(idx(r('a'), bin('-', r('x', 'utinyint'), k(3), 'int')))],
  [ret(idx(r('nope'), k(0)))],
  [ret(idx(k(0), k(0)))],
  [store(r('a'), r('x'), k(1))],
  [store(r('w'), r('x'), k(1))],
  [store(r('a'), bin('+', r('x', 'utinyint'), k(7), 'int'), k(1))],
  [store(r('w'), bin('+', k(7), r('x', 'utinyint'), 'int'), k(1))],
  [store(r('c'), r('x'), k(1))],
  [store(r('nope'), r('x'), k(1))],
  [store(k(0), r('x'), k(1))],
  [{ kind: 'stringCopy', target: r('a'), source: { kind: 'string', index: 0 }, capacity: 10, start: 0, length: 0 }],
  [{ kind: 'stringCopy', target: r('nope'), source: { kind: 'string', index: 0 }, capacity: 10, start: 0, length: 0 }],
  [local('t', k(4)), asg('t', bin('+', r('t'), k(1), 'int')), asg('g', r('t')), ret(r('t'))],
  [local('t', k(4)), { kind: 'block', body: [local('t', k(5)), asg('t', k(6))] }, ret(r('t'))],
  [asg('p', r('x')), asg('q', r('x')), ret(r('p')), ret(r('q'))],
  [asg('missing', k(1))],
  [{ kind: 'if', test: r('x'), then: [ret(k(1))], else: null, start: 0, length: 0 }],
  [{ kind: 'if', test: r('x'), then: [ret(k(1))], else: [ret(k(2))], start: 0, length: 0 }],
  [wh(r('x'), [{ kind: 'break', start: 0, length: 0 }, { kind: 'continue', start: 0, length: 0 }])],
  [wh(r('x'), [{ kind: 'if', test: r('y'), then: [{ kind: 'break', start: 0, length: 0 }], else: null, start: 0, length: 0 }, local('t', k(1))]), ret(r('t'))],
  [{ kind: 'break', start: 0, length: 0 }],
  [{ kind: 'continue', start: 0, length: 0 }],
  [{ kind: 'for', init: local('i', k(0)), test: bin('<', r('i', 'int'), k(3), 'bool'), update: asg('i', bin('+', r('i', 'int'), k(1), 'int')), body: [{ kind: 'continue', start: 0, length: 0 }, { kind: 'break', start: 0, length: 0 }], start: 0, length: 0 }],
  [{ kind: 'for', init: null, test: null, update: null, body: [{ kind: 'break', start: 0, length: 0 }], start: 0, length: 0 }],
  [{ kind: 'for', init: local('i', k(0)), test: null, update: null, body: [], start: 0, length: 0 }, ret(r('i'))],
  [ret()],
  [{ kind: 'waitFrame', start: 0, length: 0 }],
  [{ kind: 'asm', text: 'nop', start: 0, length: 0 }],
  [{ kind: 'portWrite', port: k(1), value: k(2), start: 0, length: 0 }],
  [{ kind: 'portRead', port: k(1), type: 'utinyint', start: 0, length: 0 }],
  [{ kind: 'namespaceCall', namespace: 'n', member: 'm', args: [], start: 0, length: 0 }],
  [ret({ kind: 'portRead', port: k(1), type: 'utinyint', start: 0, length: 0 })],
  [ret({ kind: 'namespaceConst', namespace: 'n', member: 'm', start: 0, length: 0 })],
  [ret({ kind: 'record', fields: [], start: 0, length: 0 })],
  [ret(k(0))],
);
const synthetic = [];
for (const body of bodies) {
  for (const waitFrameIndex of [0, null]) {
    m.__taps.length = 0;
    m.lower(body, { ...sctx, waitFrameIndex, params });
    for (const tap of m.__taps) record(tap, synthetic);
  }
}
m.__taps.length = 0;
m.lower([], { params: [] });
m.lower([{ kind: 'waitFrame', start: 0, length: 0 }], { ...sctx, waitFrameIndex: null });
for (const tap of m.__taps) record(tap, synthetic);

let inputs = 0;
try {
  execFileSync(process.execPath, [join(root, 'scripts', 'oracle', 'corpus.mjs'), '--dump', '--out', dumpDir], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
    maxBuffer: 1 << 28,
  });
  for (const file of wasmInputs(dumpDir)) {
    const input = JSON.parse(readFileSync(file, 'utf8'));
    m.__taps.length = 0;
    const built = await wasmIndex.build(
      { entry: input.entry, functions: input.functions, globals: input.globals, strings: input.strings },
      { outFile: join(dumpDir, 'out.wasm'), frameRate: 60, allowPinnedScalars: true },
    );
    if (!built.ok) throw new Error(`${file}: build refused: ${built.error}`);
    inputs++;
    for (const tap of m.__taps) record(tap, corpus);
  }
} finally {
  rmSync(dumpDir, { recursive: true, force: true });
}
if (corpus.length === 0) throw new Error('the corpus run produced no wasm-input.json function');
out.corpusCtxs = ctxs;
out.corpus = corpus;
out.synthetic = synthetic;

const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}wasm-lower.json`, `${JSON.stringify(out)}\n`);
const small = out.i32Const.length + out.maskToType.length + out.operandIsSigned.length + out.operandIsSignedNodes.length + out.binding.length;
const failures = corpus.filter((r) => !r.result.ok).length;
const syntheticFailures = synthetic.filter((r) => !r.result.ok).length;
console.log(`wasm-lower: ${small} helper rows, ${synthetic.length} synthetic bodies (${syntheticFailures} refused), ${corpus.length} corpus functions (${failures} refused) from ${inputs} wasm-input dumps, ${ctxs.length} contexts`);
