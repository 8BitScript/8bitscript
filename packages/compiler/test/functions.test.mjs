// Function parameters, return values, calls as expressions, and the
// `memory.read`/`memory.write` intrinsic — the compiler features the VIC-20
// hardware-abstraction layer is built on. See docs/compiler.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyze, tokenize, parse, lower, link } from '../index.mjs';

const NATIVE_BACKEND_PENDING = 'Bare Metal: waiting on the native backend';

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
  assert.deepEqual(loweredCodes('function f(x: ptr<utinyint>): void { }'), ['8BS3001']);
});

// ---- array parameters -------------------------------------------------------
//
// An array is passed by reference — the address of its first element, with
// nothing copied — and its length rides in the type, so `t.length` is a
// constant inside the callee and never reaches the machine. See
// docs/compiler.md and AGENTS.md's "the rule that decides where work happens".

test('an array parameter carries its element type and length', () => {
  const { ir, diagnostics } = lowered(
    'const T: array<utinyint, 4> = [1, 7, 13, 19];\n'
    + 'function pick(t: array<utinyint, 4>, i: utinyint): utinyint { return t[i]; }\n'
    + 'export function main(): void { let x: utinyint = pick(T, 2); }',
  );
  assert.deepEqual(diagnostics, []);
  const pick = ir.functions.find((f) => f.name === 'pick');
  assert.deepEqual(pick.params[0], { name: 't', type: 'array', elementType: 'utinyint', length: 4 });
  assert.equal(pick.body[0].value.kind, 'index');
});

test("an array is handed over by name, and that is the only place its bare name is a value", () => {
  const { ir, diagnostics } = lowered(
    'const T: array<utinyint, 2> = [1, 2];\n'
    + 'function f(t: array<utinyint, 2>): utinyint { return t[0]; }\n'
    + 'export function main(): void { let x: utinyint = f(T); }',
  );
  assert.deepEqual(diagnostics, []);
  const call = ir.functions.find((f) => f.name === 'main').body[0].init;
  assert.deepEqual(call.args.map((a) => [a.kind, a.name]), [['ref', 'T']]);
  // Anywhere else, an array's name is still not a value.
  assert.deepEqual(
    loweredCodes('const T: array<utinyint, 2> = [1, 2];\nfunction f(): void { let x: utinyint = T; }'),
    ['8BS3001'],
  );
  assert.deepEqual(
    loweredCodes('function f(t: array<utinyint, 2>): void { let x: utinyint = t; }'),
    ['8BS3001'],
  );
});

test("an array parameter's .length is folded, not carried", () => {
  const { ir, diagnostics } = lowered(
    'function n(t: array<utinyint, 7>): utinyint { return t.length; }',
  );
  assert.deepEqual(diagnostics, []);
  // A constant in the IR: nothing about the length reaches the machine, and
  // no second argument travels with the call.
  assert.deepEqual(ir.functions[0].body[0].value, { kind: 'const', value: 7, type: 'utinyint' });
  assert.equal(ir.functions[0].params.length, 1);
});

test('an array parameter has no default', () => {
  assert.deepEqual(
    loweredCodes('const T: array<utinyint, 2> = [1, 2];\nfunction f(t: array<utinyint, 2> = T): void { }'),
    ['8BS3001'],
  );
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
    address: { kind: 'const', value: 36879, type: 'usmallint' },
    value: { kind: 'const', value: 27, type: 'utinyint' },
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

// ---- a params/return + memory.write program, on the IR and (later) native ----

const irOf = (src) => lowered(src).ir;

test('a function with params/return + memory.write lowers the call into the write', () => {
  const src = [
    'function scaled(n: utinyint): utinyint { return n * 2; }',
    'export function main(): void {',
    '    memory.write(0x1100, scaled(21));',
    '}',
  ].join('\n');
  const ir = irOf(src);
  const scaled = ir.functions.find((f) => f.name === 'scaled');
  assert.deepEqual(scaled.params, [{ name: 'n', type: 'utinyint' }]);
  assert.equal(scaled.returnType, 'utinyint');
  const write = ir.functions.find((f) => f.name === 'main').body[0];
  assert.equal(write.kind, 'memoryWrite');
  assert.deepEqual(write.address, { kind: 'const', value: 0x1100, type: 'usmallint' });
  assert.equal(write.value.kind, 'call');
  assert.equal(write.value.name, 'scaled');
  assert.deepEqual(write.value.args[0], { kind: 'const', value: 21, type: 'utinyint' });
});

test('a function with params/return + memory.write compiles and runs the same on both backends', { skip: NATIVE_BACKEND_PENDING }, async () => {
  const src = [
    'function scaled(n: utinyint): utinyint { return n * 2; }',
    'export function main(): void {',
    '    memory.write(0x1100, scaled(21));',
    '}',
  ].join('\n');
  const dir = mkdtempSync(join(tmpdir(), '8bs-fn-test-'));
  try {
    const outFile = join(dir, 'm.wasm');
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
