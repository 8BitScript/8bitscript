import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build } from '../src/wasm/index.ts';
import type { IrFunction, IrGlobal, IrParam, IrProgram } from '../src/wasm/index.ts';
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

test('build() refuses an IR statement kind lower.ts doesn\'t lower yet, naming the construct and the milestone that adds it', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const ir: IrProgram = { entry: 'main', functions: [{ name: 'main', body: [{ kind: 'waitFrame' }] }] };
    const result = await build(ir, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /'waitFrame' is not lowered yet/);
    assert.match(result.ok ? '' : result.error, /milestone 6/);
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

/** Builds a whole `functions` array (milestone 4's own reason `execute()`
 * above only takes one: a program calling another function needs more
 * than one function in `ir.functions`), instantiates it, calls `entry`,
 * and returns whatever it returns. */
async function runProgram(functions: IrFunction[], entry: string, scratchLabel: string): Promise<number> {
  const scratch = await mkdtemp(join(tmpdir(), scratchLabel));
  try {
    const outFile = join(scratch, 'out.wasm');
    const ir: IrProgram = { entry, functions };
    const result = await build(ir, { outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) throw new Error('unreachable');
    const module = await WebAssembly.compile(result.bytes);
    const instance = await WebAssembly.instantiate(module, {});
    return (instance.exports[entry] as () => number)();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
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

test('milestone 3: refuses a `let` array global, by name', async () => {
  const globals: IrGlobal[] = [{ name: 'arr', type: 'utinyint', address: null, array: 4, constant: false, init: [0, 0, 0, 0] }];
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const result = await build({ entry: 'main', functions: [{ name: 'main', body: [] }], globals }, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /'arr' is a `let` array/);
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

// ---- milestone 4: functions and calls --------------------------------------

test('milestone 4 acceptance: main calls a helper with an argument, and returns the helper\'s own return value', async () => {
  const double: IrFunction = {
    name: 'double',
    params: [{ name: 'x', type: 'usmallint' }],
    returnType: 'usmallint',
    body: [{ kind: 'return', value: add(ref('x', 'usmallint'), ref('x', 'usmallint'), 'usmallint') }],
  };
  const main: IrFunction = {
    name: 'main',
    returnType: 'usmallint',
    body: [{ kind: 'return', value: { kind: 'call', name: 'double', args: [num(21, 'usmallint')], type: 'usmallint' } }],
  };
  assert.equal(await runProgram([main, double], 'main', '8bs-web-native-'), 42);
});

test('milestone 4: two parameters arrive in declaration order, not call order — sub(10, 3) is 7, not -7', async () => {
  const sub: IrFunction = {
    name: 'sub',
    params: [{ name: 'a', type: 'usmallint' }, { name: 'b', type: 'usmallint' }],
    returnType: 'usmallint',
    body: [{ kind: 'return', value: { kind: 'binop', operator: '-', left: ref('a', 'usmallint'), right: ref('b', 'usmallint'), type: 'usmallint' } }],
  };
  const main: IrFunction = {
    name: 'main',
    returnType: 'usmallint',
    body: [{ kind: 'return', value: { kind: 'call', name: 'sub', args: [num(10, 'usmallint'), num(3, 'usmallint')], type: 'usmallint' } }],
  };
  assert.equal(await runProgram([main, sub], 'main', '8bs-web-native-'), 7);
});

test('milestone 4: a void helper called as a statement needs no drop, and its side effect is visible after it returns', async () => {
  const setFive: IrFunction = {
    name: 'setFive',
    returnType: 'void',
    body: [{ kind: 'assign', target: 'counter', value: num(5, 'usmallint') }],
  };
  const main: IrFunction = {
    name: 'main',
    returnType: 'usmallint',
    body: [
      { kind: 'call', name: 'setFive', args: [] },
      { kind: 'return', value: ref('counter', 'usmallint') },
    ],
  };
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const globals: IrGlobal[] = [{ name: 'counter', type: 'usmallint', address: null, init: 0 }];
    const ir: IrProgram = { entry: 'main', functions: [main, setFive], globals };
    const result = await build(ir, { outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    const module = await WebAssembly.compile(result.bytes);
    const instance = await WebAssembly.instantiate(module, {});
    assert.equal((instance.exports.main as () => number)(), 5);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('milestone 4: a non-void helper called as a statement drops its own result — the module still validates with the value unused', async () => {
  // Without `Opcode.drop` after a discarded non-void call, the function
  // type still declares one result, so this reaches the entry's own
  // closing `end` with a value still on the stack the validator doesn't
  // expect — WebAssembly.compile() refuses it the same way a missing
  // `unreachable` did for milestone 2's own branch-return bug.
  const helper: IrFunction = {
    name: 'helper',
    returnType: 'usmallint',
    body: [{ kind: 'return', value: num(99, 'usmallint') }],
  };
  const main: IrFunction = {
    name: 'main',
    returnType: 'usmallint',
    body: [
      { kind: 'call', name: 'helper', args: [] },
      { kind: 'return', value: num(1, 'usmallint') },
    ],
  };
  assert.equal(await runProgram([main, helper], 'main', '8bs-web-native-'), 1);
});

test('milestone 4 acceptance: recursion — a recursive countdown, not refused for parity with mos', async () => {
  // mos still refuses this by name (a shared zero-page frame a recursive
  // call would clobber); wasm's own call stack is real, so nothing here
  // needs the same refusal — see lower.ts's own Ctx.functions doc.
  const countdown: IrFunction = {
    name: 'countdown',
    params: [{ name: 'n', type: 'usmallint' }],
    returnType: 'usmallint',
    body: [
      {
        kind: 'if',
        test: { kind: 'binop', operator: '==', left: ref('n', 'usmallint'), right: num(0, 'usmallint'), type: 'bool' },
        then: [{ kind: 'return', value: num(0, 'usmallint') }],
        else: null,
      },
      {
        kind: 'return',
        value: { kind: 'call', name: 'countdown', args: [{ kind: 'binop', operator: '-', left: ref('n', 'usmallint'), right: num(1, 'usmallint'), type: 'usmallint' }], type: 'usmallint' },
      },
    ],
  };
  assert.equal(await runProgram([countdown], 'countdown', '8bs-web-native-'), 0);
});

test('milestone 4 acceptance: only the entry is exported, even with a helper function present', async () => {
  const helper: IrFunction = { name: 'helper', returnType: 'usmallint', body: [{ kind: 'return', value: num(1, 'usmallint') }] };
  const main: IrFunction = { name: 'main', returnType: 'usmallint', body: [{ kind: 'return', value: { kind: 'call', name: 'helper', args: [], type: 'usmallint' } }] };
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const result = await build({ entry: 'main', functions: [helper, main] }, { outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    const module = await WebAssembly.compile(result.bytes);
    const instance = await WebAssembly.instantiate(module, {});
    const functions = Object.entries(instance.exports).filter(([, v]) => typeof v === 'function');
    assert.equal(functions.length, 1);
    assert.equal(functions[0][0], 'main');
    assert.equal((functions[0][1] as () => number)(), 1);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('milestone 4: refuses an array parameter, naming the web track\'s own milestone 5', async () => {
  const params: IrParam[] = [{ name: 't', type: 'array', elementType: 'utinyint' }];
  const helper: IrFunction = { name: 'helper', params, returnType: 'void', body: [] };
  const main: IrFunction = { name: 'main', returnType: 'void', body: [] };
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const result = await build({ entry: 'main', functions: [main, helper] }, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /'helper\(t\)': an array parameter/);
    assert.match(result.ok ? '' : result.error, /milestone 5/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('milestone 4: arguments evaluate left-to-right, not just land in the right slot — sub(bump(), bump()) sees 1 then 2, not 2 then 1', async () => {
  // The "declaration order" test above proves args[0] becomes the first
  // parameter regardless of order; it can't prove *evaluation* order,
  // since both its arguments are side-effect-free constants. This one
  // can: each `bump()` mutates a shared global and returns the new value,
  // so which one runs first is directly observable in the result — the
  // same left-to-right discipline mos's own callSite locks in by name (its
  // own file header), just proven here by execution instead of by reading
  // `args.flatMap`'s own emission order.
  const bump: IrFunction = {
    name: 'bump',
    returnType: 'usmallint',
    body: [
      { kind: 'assign', target: 'counter', value: add(ref('counter', 'usmallint'), num(1, 'usmallint'), 'usmallint') },
      { kind: 'return', value: ref('counter', 'usmallint') },
    ],
  };
  const sub: IrFunction = {
    name: 'sub',
    params: [{ name: 'a', type: 'usmallint' }, { name: 'b', type: 'usmallint' }],
    returnType: 'usmallint',
    body: [{ kind: 'return', value: { kind: 'binop', operator: '-', left: ref('a', 'usmallint'), right: ref('b', 'usmallint'), type: 'usmallint' } }],
  };
  const main: IrFunction = {
    name: 'main',
    returnType: 'usmallint',
    body: [{
      kind: 'return',
      value: {
        kind: 'call', name: 'sub', type: 'usmallint',
        args: [{ kind: 'call', name: 'bump', args: [], type: 'usmallint' }, { kind: 'call', name: 'bump', args: [], type: 'usmallint' }],
      },
    }],
  };
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const globals: IrGlobal[] = [{ name: 'counter', type: 'usmallint', address: null, init: 0 }];
    const ir: IrProgram = { entry: 'main', functions: [main, sub, bump], globals };
    const result = await build(ir, { outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    const module = await WebAssembly.compile(result.bytes);
    const instance = await WebAssembly.instantiate(module, {});
    // Left-to-right: the first bump() runs first (counter 0 -> 1, a = 1),
    // the second runs after it (counter 1 -> 2, b = 2). 1 - 2 wraps to
    // 65535 as a usmallint. Evaluated the other way around, b would see 1
    // and a would see 2, for a result of 1.
    assert.equal((instance.exports.main as () => number)(), 65535);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('milestone 4: a discarded non-void call inside a while loop body still validates', async () => {
  // The blocktype bug (&&/||) and the fallthru bug (a branch-return with
  // no unreachable) both lived in exactly this structural neighborhood —
  // a value-producing construct nested inside an open block/loop frame.
  // `drop` after a discarded call is the same kind of stack-balancing
  // instruction; this proves it validates once nested inside a loop body,
  // not just at a function's own top level (the shape the "drops its own
  // result" test above already covers).
  const helper: IrFunction = { name: 'helper', returnType: 'usmallint', body: [{ kind: 'return', value: num(99, 'usmallint') }] };
  const main: IrFunction = {
    name: 'main',
    returnType: 'utinyint',
    body: [
      { kind: 'local', name: 'i', type: 'utinyint', init: num(0, 'utinyint') },
      {
        kind: 'while',
        test: { kind: 'binop', operator: '<', left: ref('i', 'utinyint'), right: num(3, 'utinyint'), type: 'bool' },
        body: [
          { kind: 'call', name: 'helper', args: [] },
          { kind: 'assign', target: 'i', value: add(ref('i', 'utinyint'), num(1, 'utinyint'), 'utinyint') },
        ],
      },
      { kind: 'return', value: ref('i', 'utinyint') },
    ],
  };
  assert.equal(await runProgram([main, helper], 'main', '8bs-web-native-'), 3);
});

// ---- milestone 5: strings and const data ------------------------------------

const str = (index: number): IrExpr => ({ kind: 'string', index, type: 'string' });
const strLen = (string: IrExpr): IrExpr => ({ kind: 'stringLength', string, type: 'utinyint' });
const strByte = (string: IrExpr, index: IrExpr): IrExpr => ({ kind: 'stringByte', string, index, type: 'utinyint' });

test('milestone 5 acceptance: the exact place()/print() shape @8bitscript/web/text.8bs uses — a string parameter, looped by .length and s[i], written into memory', async () => {
  // place(cell, code): memory.write(CHAR_BASE + cell, code) — CHAR_BASE
  // folded to 0 here since this test isn't exercising @8bitscript/web's
  // own layout, just the same shape.
  const place: IrFunction = {
    name: 'place',
    params: [{ name: 'cell', type: 'usmallint' }, { name: 'code', type: 'utinyint' }],
    returnType: 'void',
    body: [{ kind: 'memoryWrite', address: ref('cell', 'usmallint'), value: ref('code', 'utinyint') }],
  };
  const print: IrFunction = {
    name: 'print',
    params: [{ name: 'cell', type: 'usmallint' }, { name: 's', type: 'string' }],
    returnType: 'void',
    body: [{
      kind: 'for',
      init: { kind: 'local', name: 'i', type: 'utinyint', init: num(0, 'utinyint') },
      test: { kind: 'binop', operator: '<', left: ref('i', 'utinyint'), right: strLen(ref('s', 'string')), type: 'bool' },
      update: { kind: 'assign', target: 'i', value: add(ref('i', 'utinyint'), num(1, 'utinyint'), 'utinyint') },
      body: [{
        kind: 'call', name: 'place', args: [
          add(ref('cell', 'usmallint'), ref('i', 'utinyint'), 'usmallint'),
          strByte(ref('s', 'string'), ref('i', 'utinyint')),
        ],
      }],
    }],
  };
  const main: IrFunction = {
    name: 'main',
    returnType: 'void',
    body: [{ kind: 'call', name: 'print', args: [num(0, 'usmallint'), str(0)] }],
  };
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const ir: IrProgram = { entry: 'main', functions: [main, print, place], strings: [{ text: 'HI', bytes: [72, 73] }] };
    const result = await build(ir, { outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    const module = await WebAssembly.compile(result.bytes);
    const instance = await WebAssembly.instantiate(module, {});
    (instance.exports.main as () => void)();
    const memory = new Uint8Array((instance.exports.memory as WebAssembly.Memory).buffer);
    assert.deepEqual([...memory.slice(0, 2)], [72, 73]); // 'H', 'I'
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('milestone 5: two distinct string literals land at two distinct addresses, each with its own correct length prefix and bytes', async () => {
  const main: IrFunction = {
    name: 'main',
    returnType: 'usmallint',
    body: [{
      // strLen("AB") + strByte("XYZ", 0) — folds both strings' own data
      // into one observable number, so a wrong address on either one
      // (each string's own bytes landing at the other's address, say)
      // shows up as a wrong result, not just "it didn't crash."
      kind: 'return',
      value: { kind: 'binop', operator: '+', type: 'usmallint', left: strLen(str(0)), right: strByte(str(1), num(0, 'utinyint')) },
    }],
  };
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const ir: IrProgram = {
      entry: 'main',
      functions: [main],
      strings: [{ text: 'AB', bytes: [65, 66] }, { text: 'XYZ', bytes: [88, 89, 90] }],
    };
    const result = await build(ir, { outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    const module = await WebAssembly.compile(result.bytes);
    const instance = await WebAssembly.instantiate(module, {});
    // strLen("AB") = 2, strByte("XYZ", 0) = 88 ('X') -> 2 + 88 = 90
    assert.equal((instance.exports.main as () => number)(), 90);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('milestone 5 acceptance: a const array read by a computed index, its own data-section bytes', async () => {
  const main: IrFunction = {
    name: 'main',
    params: [{ name: 'i', type: 'utinyint' }],
    returnType: 'utinyint',
    body: [{
      kind: 'return',
      value: { kind: 'index', array: { kind: 'ref', name: 'TABLE' }, index: ref('i', 'utinyint'), elementType: 'utinyint', type: 'utinyint' },
    }],
  };
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const globals: IrGlobal[] = [{ name: 'TABLE', type: 'utinyint', address: null, array: 3, constant: true, init: [10, 20, 30] }];
    const ir: IrProgram = { entry: 'main', functions: [main], globals };
    const result = await build(ir, { outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    const module = await WebAssembly.compile(result.bytes);
    const instance = await WebAssembly.instantiate(module, {});
    const entry = instance.exports.main as (i: number) => number;
    assert.equal(entry(0), 10);
    assert.equal(entry(1), 20);
    assert.equal(entry(2), 30);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('milestone 5: refuses a 2-byte-element const array, by name — only 1-byte elements are lowered', async () => {
  const main: IrFunction = {
    name: 'main',
    returnType: 'usmallint',
    body: [{
      kind: 'return',
      value: { kind: 'index', array: { kind: 'ref', name: 'WIDE' }, index: num(0, 'utinyint'), elementType: 'usmallint', type: 'usmallint' },
    }],
  };
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const globals: IrGlobal[] = [{ name: 'WIDE', type: 'usmallint', address: null, array: 2, constant: true, init: [1000, 2000] }];
    const ir: IrProgram = { entry: 'main', functions: [main], globals };
    const result = await build(ir, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /'WIDE'.*2-byte array element/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('milestone 5: data past one page of memory grows the declared minimum, not just fits by luck', async () => {
  // A single const array bigger than one page minus DATA_BASE leaves — a
  // sprite/tile table is the realistic case this guards, not a string
  // (the checker's own STRING_TOO_LONG already caps a literal at 255
  // bytes, so a giant string can't happen in a real program).
  const bigArray: IrGlobal = { name: 'BIG', type: 'utinyint', address: null, array: 60000, constant: true, init: new Array(60000).fill(7) };
  const main: IrFunction = {
    name: 'main',
    returnType: 'utinyint',
    body: [{ kind: 'return', value: { kind: 'index', array: { kind: 'ref', name: 'BIG' }, index: num(59999, 'usmallint'), elementType: 'utinyint', type: 'utinyint' } }],
  };
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const ir: IrProgram = { entry: 'main', functions: [main], globals: [bigArray] };
    const result = await build(ir, { outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    const module = await WebAssembly.compile(result.bytes);
    const instance = await WebAssembly.instantiate(module, {});
    const memory = instance.exports.memory as WebAssembly.Memory;
    assert.equal(memory.buffer.byteLength, 128 * 1024); // 2 pages, not 1
    assert.equal((instance.exports.main as () => number)(), 7);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('milestone 5: refuses a `let` array global, by name — const arrays are lowered, RAM ones are still a real gap', async () => {
  const globals: IrGlobal[] = [{ name: 'buf', type: 'utinyint', address: null, array: 4, constant: false, init: [0, 0, 0, 0] }];
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const result = await build({ entry: 'main', functions: [{ name: 'main', body: [] }], globals }, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /'buf' is a `let` array/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('milestone 5 acceptance: / and % — unblocking the real gate, since the linker links every function a namespace import declares (printNumber included) whether main.8bs calls it or not', async () => {
  // The exact shape packages/web/src/text.8bs's own printNumber body has:
  // `value % 10` and `value / 10`, both unsigned. Discovered by actually
  // building the real, unmodified hello-world example for web — it linked
  // in printNumber (not called by that file's own text.print) and failed
  // on '%', a real gap the roadmap had left unscheduled rather than a
  // milestone 5 regression.
  const main: IrFunction = {
    name: 'main',
    returnType: 'usmallint',
    body: [{
      kind: 'return',
      value: {
        kind: 'binop', operator: '+', type: 'usmallint',
        left: { kind: 'binop', operator: '/', left: num(47, 'usmallint'), right: num(10, 'usmallint'), type: 'usmallint' },
        right: { kind: 'binop', operator: '%', left: num(47, 'usmallint'), right: num(10, 'usmallint'), type: 'usmallint' },
      },
    }],
  };
  assert.equal(await run(main, '8bs-web-native-'), 11); // 47 / 10 = 4, 47 % 10 = 7, 4 + 7 = 11
});

test('milestone 5: refuses / and % on a signed operand, by name — the same gap every other width-sensitive operator here carries', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const main: IrFunction = {
      name: 'main',
      returnType: 'int',
      body: [{ kind: 'return', value: { kind: 'binop', operator: '/', left: num(-10, 'int'), right: num(3, 'int'), type: 'int' } }],
    };
    const result = await build({ entry: 'main', functions: [main] }, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /'\/' on a signed value/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

