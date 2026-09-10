import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build } from '../src/wasm/index.ts';
import type { IrFunction, IrGlobal, IrProgram } from '../src/wasm/index.ts';
import type { IrExpr } from '../src/wasm/lower.ts';

const emptyMain: IrProgram = {
  entry: 'main',
  functions: [{ name: 'main', body: [] }],
};

// ---- milestone 1: a module that validates ----------------------------------

test('build() for an empty main() writes a real, WebAssembly.validate()-accepting module', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const result = await build(emptyMain, { outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    assert.equal(WebAssembly.validate(result.bytes), true);
    assert.deepEqual([...await readFile(outFile)], [...result.bytes]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('milestone 1 acceptance: the built module instantiates, exports exactly one function under the entry\'s own name, and one page of memory', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const result = await build(emptyMain, { outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;

    const module = await WebAssembly.compile(result.bytes);
    // No imports: an empty program calls nothing outside itself yet — the
    // env.waitFrame import is milestone 6's own job.
    assert.deepEqual(WebAssembly.Module.imports(module), []);
    const instance = await WebAssembly.instantiate(module, {});

    const functions = Object.entries(instance.exports).filter(([, v]) => typeof v === 'function');
    assert.equal(functions.length, 1);
    assert.equal(functions[0][0], 'main');
    // Calling the entry does nothing and throws nothing — an empty body is
    // exactly `end`.
    assert.doesNotThrow(() => (functions[0][1] as () => void)());

    const memory = instance.exports.memory;
    assert.ok(memory instanceof WebAssembly.Memory);
    assert.equal((memory as WebAssembly.Memory).buffer.byteLength, 64 * 1024);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('build() names the linked entry point when it matches no function', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const ir: IrProgram = { entry: 'missing', functions: [{ name: 'main', body: [] }] };
    const result = await build(ir, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /'missing' names no function/);
    assert.equal(existsSync(outFile), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('build() refuses more than the entry function, naming the web track\'s own milestone 4', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const ir: IrProgram = { entry: 'main', functions: [{ name: 'main', body: [] }, { name: 'helper', body: [] }] };
    const result = await build(ir, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /milestone 4/);
    assert.equal(existsSync(outFile), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('build() refuses a program with string literals, naming the web track\'s own milestone 5', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const ir: IrProgram = { entry: 'main', functions: [{ name: 'main', body: [] }], strings: ['hi'] };
    const result = await build(ir, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /milestone 5/);
    assert.equal(existsSync(outFile), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('build() refuses an IR statement kind lower.ts doesn\'t lower yet, naming the construct and the milestone that adds it', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const ir: IrProgram = { entry: 'main', functions: [{ name: 'main', body: [{ kind: 'call', name: 'helper' }] }] };
    const result = await build(ir, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /'call' is not lowered yet/);
    assert.match(result.ok ? '' : result.error, /milestone 4/);
    assert.equal(existsSync(outFile), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ---- milestone 2: arithmetic and control flow ------------------------------
//
// Execution-based, not just byte inspection: every fixture below builds
// through the real build(), instantiates the module, calls the exported
// entry, and asserts on the actual returned value — the wasm-native
// equivalent of the mos rail's own "run it for real" screenshots, since a
// wasm function's return value is directly observable without a screen.

/** Builds `fn` (with `globals`, if any), instantiates it (no imports —
 * nothing here calls waitFrame()), calls the entry, and returns whatever
 * it returns alongside the instantiated memory — so a test can inspect
 * what memoryWrite actually left there, not just trust a returned value. */
async function execute(fn: IrFunction, globals: IrGlobal[], scratchLabel: string): Promise<{ value: number; memory: Uint8Array }> {
  const scratch = await mkdtemp(join(tmpdir(), scratchLabel));
  try {
    const outFile = join(scratch, 'out.wasm');
    const ir: IrProgram = { entry: fn.name, functions: [fn], globals };
    const result = await build(ir, { outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) throw new Error('unreachable');
    const module = await WebAssembly.compile(result.bytes);
    const instance = await WebAssembly.instantiate(module, {});
    const entry = instance.exports[fn.name] as () => number;
    const value = entry();
    const memory = new Uint8Array((instance.exports.memory as WebAssembly.Memory).buffer);
    return { value, memory };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Builds `fn`, instantiates it, calls the entry, and returns whatever it returns. */
async function run(fn: IrFunction, scratchLabel: string): Promise<number> {
  return (await execute(fn, [], scratchLabel)).value;
}

const ref = (name: string, type: string): IrExpr => ({ kind: 'ref', name, type });
const num = (value: number, type: string): IrExpr => ({ kind: 'const', value, type });
const add = (left: IrExpr, right: IrExpr, type: string): IrExpr => ({ kind: 'binop', operator: '+', left, right, type });

test('milestone 2 acceptance: a real for-loop sum, 0 through 9, returns 45', async () => {
  const main: IrFunction = {
    name: 'main',
    returnType: 'usmallint',
    body: [
      { kind: 'local', name: 'sum', type: 'usmallint', init: num(0, 'usmallint') },
      {
        kind: 'for',
        init: { kind: 'local', name: 'i', type: 'utinyint', init: num(0, 'utinyint') },
        test: { kind: 'binop', operator: '<', left: ref('i', 'utinyint'), right: num(10, 'utinyint'), type: 'bool' },
        update: { kind: 'assign', target: 'i', value: add(ref('i', 'utinyint'), num(1, 'utinyint'), 'utinyint') },
        body: [{ kind: 'assign', target: 'sum', value: add(ref('sum', 'usmallint'), ref('i', 'utinyint'), 'usmallint') }],
      },
      { kind: 'return', value: ref('sum', 'usmallint') },
    ],
  };
  assert.equal(await run(main, '8bs-web-native-'), 45);
});

test('milestone 2: while (true) { ...; break; } — the exact shape hello-world\'s own trailing loop has, minus waitFrame()', async () => {
  const main: IrFunction = {
    name: 'main',
    returnType: 'utinyint',
    body: [
      { kind: 'local', name: 'i', type: 'utinyint', init: num(0, 'utinyint') },
      {
        kind: 'while',
        test: num(1, 'bool'),
        body: [
          { kind: 'if', test: { kind: 'binop', operator: '==', left: ref('i', 'utinyint'), right: num(5, 'utinyint'), type: 'bool' }, then: [{ kind: 'break' }], else: null },
          { kind: 'assign', target: 'i', value: add(ref('i', 'utinyint'), num(1, 'utinyint'), 'utinyint') },
        ],
      },
      { kind: 'return', value: ref('i', 'utinyint') },
    ],
  };
  assert.equal(await run(main, '8bs-web-native-'), 5);
});

test('milestone 2: a function that returns from inside every branch of an if/else, with nothing after it, still validates', async () => {
  // Every path through this body returns from inside the `if`/`else`
  // itself, so the function's own closing `end` is reached with the `if`
  // frame already popped and an empty stack — but the type section
  // declares one result. Without an `unreachable` before that `end`,
  // WebAssembly.compile() correctly refuses this exact shape ("expected 1
  // elements on the stack for fallthru, found 0"), the same class of bug
  // the `&&`/`||` blocktype fix above caught, just found one level up (the
  // function body itself, not one of its own sub-expressions). This is
  // also `asciiToScreenCode`'s own real shape in the PET text package
  // (packages/pet/src/text.8bs) — milestone 5's own gate links it for
  // real, so this has to hold before that milestone can.
  const branch = (cond: number): IrFunction => ({
    name: 'main',
    returnType: 'utinyint',
    body: [{
      kind: 'if',
      test: num(cond, 'bool'),
      then: [{ kind: 'return', value: num(1, 'utinyint') }],
      else: [{ kind: 'return', value: num(2, 'utinyint') }],
    }],
  });
  assert.equal(await run(branch(1), '8bs-web-native-'), 1);
  assert.equal(await run(branch(0), '8bs-web-native-'), 2);
});

test('milestone 2: continue still runs a for loop\'s own update, not just while\'s', async () => {
  // Sums 0..9 except 5 (45 - 5 = 40) by continuing straight past it. This
  // is also the test that would actually hang, not just miscount, if
  // continue's target were "jump to the loop's own top" instead of "run
  // update, then re-test": i would stay 5 forever and never reach the
  // for's own exit condition.
  const main: IrFunction = {
    name: 'main',
    returnType: 'usmallint',
    body: [
      { kind: 'local', name: 'sum', type: 'usmallint', init: num(0, 'usmallint') },
      {
        kind: 'for',
        init: { kind: 'local', name: 'i', type: 'utinyint', init: num(0, 'utinyint') },
        test: { kind: 'binop', operator: '<', left: ref('i', 'utinyint'), right: num(10, 'utinyint'), type: 'bool' },
        update: { kind: 'assign', target: 'i', value: add(ref('i', 'utinyint'), num(1, 'utinyint'), 'utinyint') },
        body: [
          { kind: 'if', test: { kind: 'binop', operator: '==', left: ref('i', 'utinyint'), right: num(5, 'utinyint'), type: 'bool' }, then: [{ kind: 'continue' }], else: null },
          { kind: 'assign', target: 'sum', value: add(ref('sum', 'usmallint'), ref('i', 'utinyint'), 'usmallint') },
        ],
      },
      { kind: 'return', value: ref('sum', 'usmallint') },
    ],
  };
  assert.equal(await run(main, '8bs-web-native-'), 40);
});

test('milestone 2: nested for loops — an inner break only breaks the inner loop', async () => {
  const main: IrFunction = {
    name: 'main',
    returnType: 'utinyint',
    body: [
      { kind: 'local', name: 'count', type: 'utinyint', init: num(0, 'utinyint') },
      {
        kind: 'for',
        init: { kind: 'local', name: 'i', type: 'utinyint', init: num(0, 'utinyint') },
        test: { kind: 'binop', operator: '<', left: ref('i', 'utinyint'), right: num(3, 'utinyint'), type: 'bool' },
        update: { kind: 'assign', target: 'i', value: add(ref('i', 'utinyint'), num(1, 'utinyint'), 'utinyint') },
        body: [
          {
            kind: 'for',
            init: { kind: 'local', name: 'j', type: 'utinyint', init: num(0, 'utinyint') },
            test: { kind: 'binop', operator: '<', left: ref('j', 'utinyint'), right: num(3, 'utinyint'), type: 'bool' },
            update: { kind: 'assign', target: 'j', value: add(ref('j', 'utinyint'), num(1, 'utinyint'), 'utinyint') },
            body: [
              { kind: 'if', test: { kind: 'binop', operator: '==', left: ref('j', 'utinyint'), right: num(1, 'utinyint'), type: 'bool' }, then: [{ kind: 'break' }], else: null },
              { kind: 'assign', target: 'count', value: add(ref('count', 'utinyint'), num(1, 'utinyint'), 'utinyint') },
            ],
          },
        ],
      },
      { kind: 'return', value: ref('count', 'utinyint') },
    ],
  };
  // Each of the 3 outer iterations: inner runs j=0 (count+=1), j=1 breaks —
  // an unbroken inner break depth would instead exit the outer loop too,
  // giving 1, not 3.
  assert.equal(await run(main, '8bs-web-native-'), 3);
});

test('milestone 2: fixed-width wraparound — 250 + 10 as utinyint is 4, not 260', async () => {
  const main: IrFunction = {
    name: 'main',
    returnType: 'utinyint',
    body: [{ kind: 'return', value: add(num(250, 'utinyint'), num(10, 'utinyint'), 'utinyint') }],
  };
  assert.equal(await run(main, '8bs-web-native-'), 4);
});

test('milestone 2: unary ~ masks to its declared width — ~5 as utinyint is 250, not -6', async () => {
  const main: IrFunction = {
    name: 'main',
    returnType: 'utinyint',
    body: [{ kind: 'return', value: { kind: 'unop', operator: '~', argument: num(5, 'utinyint'), type: 'utinyint' } }],
  };
  assert.equal(await run(main, '8bs-web-native-'), 250);
});

test('milestone 2: && and || short-circuit left-to-right and return exactly 0 or 1', async () => {
  const and = (l: IrExpr, r: IrExpr): IrExpr => ({ kind: 'binop', operator: '&&', left: l, right: r, type: 'bool' });
  const or = (l: IrExpr, r: IrExpr): IrExpr => ({ kind: 'binop', operator: '||', left: l, right: r, type: 'bool' });
  const t = num(1, 'bool');
  const f = num(0, 'bool');
  const mk = (value: IrExpr): IrFunction => ({ name: 'main', returnType: 'bool', body: [{ kind: 'return', value }] });
  assert.equal(await run(mk(and(t, t)), '8bs-web-native-'), 1);
  assert.equal(await run(mk(and(t, f)), '8bs-web-native-'), 0);
  assert.equal(await run(mk(and(f, t)), '8bs-web-native-'), 0);
  assert.equal(await run(mk(or(f, f)), '8bs-web-native-'), 0);
  assert.equal(await run(mk(or(f, t)), '8bs-web-native-'), 1);
});

test('milestone 2: refuses an ordering comparison on a signed operand, by name — the same gap the mos backend still carries', async () => {
  const main: IrFunction = {
    name: 'main',
    returnType: 'bool',
    body: [
      { kind: 'local', name: 'x', type: 'tinyint', init: num(-5, 'tinyint') },
      { kind: 'return', value: { kind: 'binop', operator: '<', left: ref('x', 'tinyint'), right: num(0, 'tinyint'), type: 'bool' } },
    ],
  };
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const result = await build({ entry: 'main', functions: [main] }, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /'<' on a signed value is not lowered yet/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('milestone 2: refuses arithmetic whose result is a signed type narrower than 32 bits, by name', async () => {
  const main: IrFunction = {
    name: 'main',
    returnType: 'tinyint',
    body: [{ kind: 'return', value: add(num(5, 'tinyint'), num(3, 'tinyint'), 'tinyint') }],
  };
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const result = await build({ entry: 'main', functions: [main] }, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /signed 'tinyint'/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ---- milestone 3: globals and memory ---------------------------------------

test('milestone 3 acceptance: a global\'s own init value, mutated and read back through global.get/global.set', async () => {
  const globals: IrGlobal[] = [{ name: 'counter', type: 'usmallint', address: null, init: 10 }];
  const main: IrFunction = {
    name: 'main',
    returnType: 'usmallint',
    body: [
      { kind: 'assign', target: 'counter', value: add(ref('counter', 'usmallint'), num(5, 'usmallint'), 'usmallint') },
      { kind: 'return', value: ref('counter', 'usmallint') },
    ],
  };
  assert.equal((await execute(main, globals, '8bs-web-native-')).value, 15);
});

test('milestone 3: a local shadows a global of the same name, exactly like the front end already allows', async () => {
  const globals: IrGlobal[] = [{ name: 'x', type: 'utinyint', address: null, init: 100 }];
  const main: IrFunction = {
    name: 'main',
    returnType: 'utinyint',
    body: [
      { kind: 'local', name: 'x', type: 'utinyint', init: num(7, 'utinyint') },
      { kind: 'return', value: ref('x', 'utinyint') },
    ],
  };
  assert.equal((await execute(main, globals, '8bs-web-native-')).value, 7);
});

test('milestone 3 acceptance: memory.write then memory.read at a literal address round-trips, and the byte actually lands in the exported memory', async () => {
  const main: IrFunction = {
    name: 'main',
    returnType: 'utinyint',
    body: [
      { kind: 'memoryWrite', address: num(100, 'usmallint'), value: num(42, 'utinyint') },
      { kind: 'return', value: { kind: 'memoryRead', address: num(100, 'usmallint'), type: 'utinyint' } },
    ],
  };
  const { value, memory } = await execute(main, [], '8bs-web-native-');
  assert.equal(value, 42);
  assert.equal(memory[100], 42);
});

test('milestone 3 acceptance: memory.write at a computed address — the exact place() shape @8bitscript/web/text.8bs uses (base + cell)', async () => {
  // Writes 'A'+i to offsets 200..204, the same "base + loop variable"
  // address computation text.8bs's own place() does (WebRegisters.CHAR_BASE
  // + cell) — proving a non-literal address works, not just a constant one.
  const main: IrFunction = {
    name: 'main',
    body: [
      {
        kind: 'for',
        init: { kind: 'local', name: 'i', type: 'utinyint', init: num(0, 'utinyint') },
        test: { kind: 'binop', operator: '<', left: ref('i', 'utinyint'), right: num(5, 'utinyint'), type: 'bool' },
        update: { kind: 'assign', target: 'i', value: add(ref('i', 'utinyint'), num(1, 'utinyint'), 'utinyint') },
        body: [{
          kind: 'memoryWrite',
          address: add(num(200, 'usmallint'), ref('i', 'utinyint'), 'usmallint'),
          value: add(ref('i', 'utinyint'), num(65, 'utinyint'), 'utinyint'),
        }],
      },
    ],
  };
  const { memory } = await execute(main, [], '8bs-web-native-');
  assert.deepEqual([...memory.slice(200, 205)], [65, 66, 67, 68, 69]);
});

test('milestone 3: refuses a pinned global (@address(...)), by name', async () => {
  const globals: IrGlobal[] = [{ name: 'REG', type: 'utinyint', address: 0xe000, init: 0 }];
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const result = await build({ entry: 'main', functions: [{ name: 'main', body: [] }], globals }, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /'REG'.*pinned global/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('milestone 3: refuses an array global, naming the web track\'s own milestone 5', async () => {
  const globals: IrGlobal[] = [{ name: 'arr', type: 'utinyint', address: null, array: 4, init: 0 }];
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const result = await build({ entry: 'main', functions: [{ name: 'main', body: [] }], globals }, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /'arr' is an array/);
    assert.match(result.ok ? '' : result.error, /milestone 5/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('milestone 3: refuses a string<N> global, naming the web track\'s own milestone 5', async () => {
  const globals: IrGlobal[] = [{ name: 's', type: 'string', address: null, init: 0 }];
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const result = await build({ entry: 'main', functions: [{ name: 'main', body: [] }], globals }, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /'s' is a string<N>/);
    assert.match(result.ok ? '' : result.error, /milestone 5/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
