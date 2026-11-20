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
  clean('fn double(n: utinyint) -> utinyint {\n    return n * 2;\n}\npub fn main() {\n    double(1);\n}');
});

test('parameters and return type lower onto the IR function record', () => {
  const { ir, diagnostics } = lowered('fn add(a: utinyint, b: utinyint) -> utinyint {\n    return a + b;\n}');
  assert.equal(diagnostics.length, 0);
  assert.deepEqual(ir.functions[0].params, [{ name: 'a', type: 'utinyint' }, { name: 'b', type: 'utinyint' }]);
  assert.equal(ir.functions[0].returnType, 'utinyint');
});

test('a parameter references by name inside the body', () => {
  const { ir } = lowered('fn id(n: utinyint) -> utinyint {\n    return n;\n}');
  assert.equal(ir.functions[0].body[0].value.name, 'n');
});

test('omitting the return type means void, as before', () => {
  const { ir, diagnostics } = lowered('pub fn f() {\n    return;\n}');
  assert.equal(diagnostics.length, 0);
  assert.equal(ir.functions[0].returnType, 'void');
});

test('returning a value from a void function is not compilable', () => {
  assert.deepEqual(loweredCodes('pub fn f() {\n    return 1;\n}'), ['8BS3001']);
});

test('a non-void function must return a value, not a bare return', () => {
  assert.deepEqual(loweredCodes('fn f() -> utinyint {\n    return;\n}'), ['8BS3001']);
});

test('a parameter of an unsupported type is not compilable', () => {
  assert.deepEqual(loweredCodes('fn f(x: ptr<utinyint>) {\n}'), ['8BS3001']);
});

// ---- array parameters -------------------------------------------------------
//
// An array is passed by reference — the address of its first element, with
// nothing copied — and its length rides in the type, so `t.length` is a
// constant inside the callee and never reaches the machine. See
// docs/compiler.md and AGENTS.md's "the rule that decides where work happens".

test('an array parameter carries its element type and length', () => {
  const { ir, diagnostics } = lowered(
    'const T: [utinyint; 4] = [1, 7, 13, 19];\n'
    + 'fn pick(t: [utinyint; 4], i: utinyint) -> utinyint {\n    return t[i];\n}\n'
    + 'pub fn main() {\n    let x: utinyint = pick(T, 2);\n}',
  );
  assert.deepEqual(diagnostics, []);
  const pick = ir.functions.find((f) => f.name === 'pick');
  assert.deepEqual(pick.params[0], { name: 't', type: 'array', elementType: 'utinyint', length: 4 });
  assert.equal(pick.body[0].value.kind, 'index');
});

test("an array is handed over by name, and that is the only place its bare name is a value", () => {
  const { ir, diagnostics } = lowered(
    'const T: [utinyint; 2] = [1, 2];\n'
    + 'fn f(t: [utinyint; 2]) -> utinyint {\n    return t[0];\n}\n'
    + 'pub fn main() {\n    let x: utinyint = f(T);\n}',
  );
  assert.deepEqual(diagnostics, []);
  const call = ir.functions.find((f) => f.name === 'main').body[0].init;
  assert.deepEqual(call.args.map((a) => [a.kind, a.name]), [['ref', 'T']]);
  // Anywhere else, an array's name is still not a value.
  assert.deepEqual(
    loweredCodes('const T: [utinyint; 2] = [1, 2];\nfn f() {\n    let x: utinyint = T;\n}'),
    ['8BS3001'],
  );
  assert.deepEqual(
    loweredCodes('fn f(t: [utinyint; 2]) {\n    let x: utinyint = t;\n}'),
    ['8BS3001'],
  );
});

test("an array parameter's .length is folded, not carried", () => {
  const { ir, diagnostics } = lowered(
    'fn n(t: [utinyint; 7]) -> utinyint {\n    return t.length;\n}',
  );
  assert.deepEqual(diagnostics, []);
  // A constant in the IR: nothing about the length reaches the machine, and
  // no second argument travels with the call.
  assert.deepEqual(ir.functions[0].body[0].value, { kind: 'const', value: 7, type: 'utinyint' });
  assert.equal(ir.functions[0].params.length, 1);
});

test('an array parameter has no default', () => {
  assert.deepEqual(
    loweredCodes('const T: [utinyint; 2] = [1, 2];\nfn f(t: [utinyint; 2] = T) {\n}'),
    ['8BS3001'],
  );
});

test('a call is now usable as an expression, not just a statement', () => {
  const { ir, diagnostics } = lowered(
    'let mut x: utinyint = 0;\nfn one() -> utinyint {\n    return 1;\n}\npub fn main() {\n    x = one() + one();\n}',
  );
  assert.equal(diagnostics.length, 0);
  const assign = ir.functions[1].body[0];
  assert.equal(assign.value.kind, 'binop');
  assert.equal(assign.value.left.kind, 'call');
  assert.equal(assign.value.left.name, 'one');
});

test('a call with arguments lowers each argument', () => {
  const { ir } = lowered('fn add(a: utinyint, b: utinyint) -> utinyint {\n    return a + b;\n}\npub fn main() {\n    add(1, 2);\n}');
  const call = ir.functions[1].body[0];
  assert.equal(call.kind, 'call');
  assert.deepEqual(call.args.map((a) => a.value), [1, 2]);
});

// ---- linking: parameters shadow same-named globals -------------------------

test('a parameter shadows a same-named global within its own function', () => {
  const src = 'let x: utinyint = 1;\nfn f(x: utinyint) -> utinyint {\n    return x;\n}\npub fn main() {\n    f(2);\n}';
  const { ir, diagnostics } = link(src, 't.8bs');
  assert.deepEqual(diagnostics, []);
  // The parameter is never renamed, and the function body must still refer
  // to it (not to the global `x`, output-renamed only if it collided).
  const f = ir.functions.find((fn) => fn.name === 'f');
  assert.equal(f.body[0].value.name, 'x');
  assert.equal(f.params[0].name, 'x');
});

test('a genuinely undefined name inside a function body is still 8BS2007', () => {
  const src = 'pub fn f() {\n    undeclared = 1;\n}';
  const { ir, diagnostics } = link(src, 't.8bs');
  assert.equal(ir, null);
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2007']);
});

// ---- the memory.read/memory.write intrinsic --------------------------------

test('memory.write and memory.read parse and lower clean', () => {
  clean('pub fn f() {\n    memory::write(0x900F, 27);\n}');
  assert.deepEqual(loweredCodes('let mut x: utinyint = 0;\npub fn f() {\n    x = memory::read(0x900F);\n}'), []);
});

test('memory.write lowers to a dedicated IR node with address and value', () => {
  const { ir, diagnostics } = lowered('pub fn f() {\n    memory::write(36879, 27);\n}');
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
  const { ir, diagnostics } = lowered('let mut x: utinyint = 0;\npub fn f() {\n    x = memory::read(36879);\n}');
  assert.equal(diagnostics.length, 0);
  assert.equal(ir.functions[0].body[0].value.kind, 'memoryRead');
});

test('memory.write cannot be used as an expression: it has no value', () => {
  assert.deepEqual(
    loweredCodes('let mut x: utinyint = 0;\npub fn f() {\n    x = memory::write(1, 2);\n}'),
    ['8BS3001'],
  );
});

test('memory.write and memory.read need exactly their fixed arity', () => {
  assert.deepEqual(loweredCodes('pub fn f() {\n    memory::write(1);\n}'), ['8BS3001']);
  assert.deepEqual(loweredCodes('pub fn f() {\n    memory::write(1, 2, 3);\n}'), ['8BS3001']);
  assert.deepEqual(loweredCodes('pub fn f() {\n    memory::read(1, 2);\n}'), ['8BS3001']);
});

test('an unknown memory.* member is not compilable', () => {
  assert.deepEqual(loweredCodes('pub fn f() {\n    memory::erase(1);\n}'), ['8BS3001']);
});

test('memory.write range-checks literal arguments against usmallint/utinyint', () => {
  assert.deepEqual(loweredCodes('pub fn f() {\n    memory::write(70000, 1);\n}'), ['8BS1021']);
  assert.deepEqual(loweredCodes('pub fn f() {\n    memory::write(1, 300);\n}'), ['8BS1021']);
  assert.deepEqual(loweredCodes('pub fn f() {\n    memory::write(65535, 255);\n}'), []);
  assert.deepEqual(loweredCodes('pub fn f() {\n    memory::write(0, 0);\n}'), []);
});

// ---- a params/return + memory.write program, on the IR and (later) native ----

const irOf = (src) => lowered(src).ir;

test('a function with params/return + memory.write lowers the call into the write', () => {
  const src = [
    'fn scaled(n: utinyint) -> utinyint {',
    '    return n * 2;',
    '}',
    'pub fn main() {',
    '    memory::write(0x1100, scaled(21));',
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
    'fn scaled(n: utinyint) -> utinyint {',
    '    return n * 2;',
    '}',
    'pub fn main() {',
    '    memory::write(0x1100, scaled(21));',
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
    'fn scaled(n: utinyint) -> utinyint {',
    '    return n * 2;',
    '}',
    'pub fn main() {',
    '    memory::write(0x1100, scaled(21));',
    '}',
  ].join('\n');
  const { ir, diagnostics } = link(src, 't.8bs');
  assert.deepEqual(diagnostics, []);
  assert.ok(ir);
});
