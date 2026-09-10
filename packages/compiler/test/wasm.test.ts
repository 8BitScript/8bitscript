import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build } from '../src/wasm/index.ts';
import type { IrProgram } from '../src/wasm/index.ts';

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

test('build() refuses a program with globals, naming the web track\'s own milestone 3', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const ir: IrProgram = { entry: 'main', functions: [{ name: 'main', body: [] }], globals: [{ name: 'x' }] };
    const result = await build(ir, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /milestone 3/);
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

test('build() refuses a non-empty entry body, naming the construct and pointing at milestone 2', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const ir: IrProgram = { entry: 'main', functions: [{ name: 'main', body: [{ kind: 'memoryWrite' }] }] };
    const result = await build(ir, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /no IR statement kind is lowered yet/);
    assert.match(result.ok ? '' : result.error, /milestone 2/);
    assert.equal(existsSync(outFile), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
