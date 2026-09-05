// Function parameters, return values, calls as expressions, and the
// `memory.read`/`memory.write` intrinsic — the compiler features the VIC-20
// hardware-abstraction layer is built on. See docs/compiler.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyze, tokenize, parse, lower, link } from '../index.mjs';
import { emitAssemblyScript } from '../../backend-web/src/index.mjs';
import { emitC } from '../../backend-6502/src/index.mjs';

const codes = (src) => analyze(src, 't.8bs').map((d) => d.code);
const clean = (src) => assert.deepEqual(codes(src), []);

const lowered = (src) => {
  const { tokens } = tokenize(src, 't');
  const { ast } = parse(tokens, src, 't');
  return lower(ast, 't');
};

// These are all lowering-stage diagnostics (8BS3001/8BS1021 from `lower()`,
// not the checker) — `analyze()`/`8bs check` does not run `lower()`, so they
// only surface on an actual build, same as every other "not compilable yet"
// construct. `lowered()` is what exercises them directly.
const loweredCodes = (src) => lowered(src).diagnostics.map((d) => d.code);

// ---- parameters and return values -----------------------------------------

test('a function may take parameters and return a value', () => {
  clean('function double(n: utinyint): utinyint { return n * 2; }\nexport function main(): void { double(1); }');
});

test('parameters and return type lower onto the IR function record', () => {
  const { ir, diagnostics } = lowered('function add(a: utinyint, b: utinyint): utinyint { return a + b; }');
  assert.equal(diagnostics.length, 0);
  assert.deepEqual(ir.functions[0].params, [{ name: 'a', type: 'utinyint' }, { name: 'b', type: 'utinyint' }]);
  assert.equal(ir.functions[0].returnType, 'utinyint');
});

test('a parameter references by name inside the body', () => {
  const { ir } = lowered('function id(n: utinyint): utinyint { return n; }');
  assert.equal(ir.functions[0].body[0].value.name, 'n');
});

test('omitting the return type means void, as before', () => {
  const { ir, diagnostics } = lowered('export function f(): void { return; }');
  assert.equal(diagnostics.length, 0);
  assert.equal(ir.functions[0].returnType, 'void');
});

test('returning a value from a void function is not compilable', () => {
  assert.deepEqual(loweredCodes('export function f(): void { return 1; }'), ['8BS3001']);
});

test('a non-void function must return a value, not a bare return', () => {
  assert.deepEqual(loweredCodes('function f(): utinyint { return; }'), ['8BS3001']);
});

test('a parameter of an unsupported type is not compilable', () => {
  assert.deepEqual(loweredCodes('function f(x: array<utinyint, 4>): void { }'), ['8BS3001']);
});

test('a call is now usable as an expression, not just a statement', () => {
  const { ir, diagnostics } = lowered(
    'let x: utinyint = 0;\nfunction one(): utinyint { return 1; }\nexport function main(): void { x = one() + one(); }',
  );
  assert.equal(diagnostics.length, 0);
  const assign = ir.functions[1].body[0];
  assert.equal(assign.value.kind, 'binop');
  assert.equal(assign.value.left.kind, 'call');
  assert.equal(assign.value.left.name, 'one');
});

test('a call with arguments lowers each argument', () => {
  const { ir } = lowered('function add(a: utinyint, b: utinyint): utinyint { return a + b; }\nexport function main(): void { add(1, 2); }');
  const call = ir.functions[1].body[0];
  assert.equal(call.kind, 'call');
  assert.deepEqual(call.args.map((a) => a.value), [1, 2]);
});

// ---- linking: parameters shadow same-named globals -------------------------

test('a parameter shadows a same-named global within its own function', () => {
  const src = 'let x: utinyint = 1;\nfunction f(x: utinyint): utinyint { return x; }\nexport function main(): void { f(2); }';
  const { ir, diagnostics } = link(src, 't.8bs');
  assert.deepEqual(diagnostics, []);
  // The parameter is never renamed, and the function body must still refer
  // to it (not to the global `x`, output-renamed only if it collided).
  const f = ir.functions.find((fn) => fn.name === 'f');
  assert.equal(f.body[0].value.name, 'x');
  assert.equal(f.params[0].name, 'x');
});

test('a genuinely undefined name inside a function body is still 8BS2007', () => {
  const src = 'export function f(): void { undeclared = 1; }';
  const { ir, diagnostics } = link(src, 't.8bs');
  assert.equal(ir, null);
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2007']);
});

// ---- the memory.read/memory.write intrinsic --------------------------------

test('memory.write and memory.read parse and lower clean', () => {
  clean('export function f(): void { memory.write(0x900F, 27); }');
  assert.deepEqual(loweredCodes('let x: utinyint = 0;\nexport function f(): void { x = memory.read(0x900F); }'), []);
});

test('memory.write lowers to a dedicated IR node with address and value', () => {
  const { ir, diagnostics } = lowered('export function f(): void { memory.write(36879, 27); }');
  assert.equal(diagnostics.length, 0);
  assert.deepEqual(ir.functions[0].body[0], {
    kind: 'memoryWrite',
    address: { kind: 'const', value: 36879 },
    value: { kind: 'const', value: 27 },
    start: ir.functions[0].body[0].start,
    length: ir.functions[0].body[0].length,
  });
});

test('memory.read is usable as an expression', () => {
  const { ir, diagnostics } = lowered('let x: utinyint = 0;\nexport function f(): void { x = memory.read(36879); }');
  assert.equal(diagnostics.length, 0);
  assert.equal(ir.functions[0].body[0].value.kind, 'memoryRead');
});

test('memory.write cannot be used as an expression: it has no value', () => {
  assert.deepEqual(
    loweredCodes('let x: utinyint = 0;\nexport function f(): void { x = memory.write(1, 2); }'),
    ['8BS3001'],
  );
});

test('memory.write and memory.read need exactly their fixed arity', () => {
  assert.deepEqual(loweredCodes('export function f(): void { memory.write(1); }'), ['8BS3001']);
  assert.deepEqual(loweredCodes('export function f(): void { memory.write(1, 2, 3); }'), ['8BS3001']);
  assert.deepEqual(loweredCodes('export function f(): void { memory.read(1, 2); }'), ['8BS3001']);
});

test('an unknown memory.* member is not compilable', () => {
  assert.deepEqual(loweredCodes('export function f(): void { memory.erase(1); }'), ['8BS3001']);
});

test('memory.write range-checks literal arguments against usmallint/utinyint', () => {
  assert.deepEqual(loweredCodes('export function f(): void { memory.write(70000, 1); }'), ['8BS1021']);
  assert.deepEqual(loweredCodes('export function f(): void { memory.write(1, 300); }'), ['8BS1021']);
  assert.deepEqual(loweredCodes('export function f(): void { memory.write(65535, 255); }'), []);
  assert.deepEqual(loweredCodes('export function f(): void { memory.write(0, 0); }'), []);
});

// ---- both backends emit the new shapes -------------------------------------

const irOf = (src) => lowered(src).ir;

test('backend-6502 emits real C parameter lists and return statements', () => {
  const c = emitC(irOf('function double(n: utinyint): utinyint { return n * 2; }\nexport function main(): void { double(3); }'));
  assert.match(c, /uint8_t double\(uint8_t n\) \{/);
  assert.match(c, /return \(n \* 2\);/);
  assert.match(c, /double\(3\);/);
});

test('backend-6502 emits a volatile pointer dereference for memory.read/write', () => {
  // Integer literals lower to their numeric value, not their source radix —
  // 0x900F is 36879 by the time it reaches a backend, same as everywhere
  // else in the compiler (an @address global's hex formatting is a one-off
  // done for that one line, not a general property of literals).
  const c = emitC(irOf('export function f(): void { memory.write(0x900F, 27); }'));
  assert.match(c, /\*\(volatile uint8_t \*\)36879 = 27;/);

  const c2 = emitC(irOf('let x: utinyint = 0;\nexport function f(): void { x = memory.read(0x900F); }'));
  assert.match(c2, /x = \(\*\(volatile uint8_t \*\)36879\);/);
});

test('backend-web emits real AssemblyScript signatures and load/store intrinsics', () => {
  const as = emitAssemblyScript(irOf('function double(n: utinyint): utinyint { return n * 2; }\nexport function main(): void { double(3); }'));
  assert.ok(as.ok);
  // Only the entry is a wasm export; a helper is a plain function.
  assert.match(as.source, /^function double\(n: u8\): u8 \{/m);
  assert.match(as.source, /return <u8>\(n \* 2\);/);

  const mem = emitAssemblyScript(irOf('export function f(): void { memory.write(0x900F, 27); }'));
  assert.match(mem.source, /store<u8>\(36879, 27\);/);

  const read = emitAssemblyScript(irOf('let x: utinyint = 0;\nexport function f(): void { x = memory.read(0x900F); }'));
  assert.match(read.source, /x = <u8>load<u8>\(36879\);/);
});

// ---- real compiles: parameters, return values, and memory access agree ----

test('a function with params/return + memory.write compiles and runs the same on both backends', async () => {
  const src = [
    'function scaled(n: utinyint): utinyint { return n * 2; }',
    'export function main(): void {',
    '    memory.write(0x1100, scaled(21));',
    '}',
  ].join('\n');

  const c = emitC(irOf(src));
  assert.match(c, /uint8_t scaled\(uint8_t n\)/);
  assert.match(c, /\*\(volatile uint8_t \*\)4352 = scaled\(21\);/);

  const emitted = emitAssemblyScript(irOf(src));
  assert.ok(emitted.ok);
  assert.match(emitted.source, /store<u8>\(4352, scaled\(21\)\);/);

  const { buildWasm } = await import('../../backend-web/src/index.mjs');
  const dir = mkdtempSync(join(tmpdir(), '8bs-fn-test-'));
  try {
    const outFile = join(dir, 'm.wasm');
    const result = await buildWasm(irOf(src), { outFile });
    assert.ok(result.ok, result.error);
    const wasm = await import('node:fs/promises').then((fs) => fs.readFile(outFile));
    const { instance } = await WebAssembly.instantiate(wasm);
    instance.exports.main();
    assert.equal(instance.exports.memory.buffer.byteLength >= 0x1101, true);
    const bytes = new Uint8Array(instance.exports.memory.buffer);
    assert.equal(bytes[0x1100], 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same program links cleanly through the full pipeline', () => {
  const src = [
    'function scaled(n: utinyint): utinyint { return n * 2; }',
    'export function main(): void {',
    '    memory.write(0x1100, scaled(21));',
    '}',
  ].join('\n');
  const { ir, diagnostics } = link(src, 't.8bs');
  assert.deepEqual(diagnostics, []);
  assert.ok(ir);
});
