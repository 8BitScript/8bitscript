// The web backend's tests: the emitted AssemblyScript as a deterministic
// string, and — because asc ships with this package — the real thing: compile
// the milestone program to wasm, instantiate it, and watch a u8 wrap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tokenize, parse, lower } from '@8bitscript/compiler';
import { emitAssemblyScript, buildWasm } from '../src/index.mjs';

const MILESTONE = 'let x: u8 = 10;\nexport function main(): void {\n    x = x + 1;\n}\n';

const irOf = (src) => {
  const { tokens } = tokenize(src, 't');
  const { ast } = parse(tokens, src, 't');
  return lower(ast, 't').ir;
};

test('emits the specified wrap-at-assignment form', () => {
  const emitted = emitAssemblyScript(irOf(MILESTONE));
  assert.ok(emitted.ok);
  assert.match(emitted.source, /export let x: u8 = 10;/);
  assert.match(emitted.source, /x = <u8>\(x \+ 1\);/);
});

test('call statements emit as plain calls', () => {
  const emitted = emitAssemblyScript(irOf('export function main(): void { apply(); }\nfunction apply(): void { return; }'));
  assert.ok(emitted.ok);
  assert.match(emitted.source, /apply\(\);/);
});

test('only the entry is a wasm export; other functions are plain', () => {
  const emitted = emitAssemblyScript(irOf('export function main(): void { apply(); }\nfunction apply(): void { return; }'));
  assert.ok(emitted.ok);
  assert.match(emitted.source, /^export function main\(\): void \{/m);
  assert.match(emitted.source, /^function apply\(\): void \{/m);
  assert.equal(emitted.usesWaitFrame, false);
});

test('waitFrame() is a host import, declared only when used', () => {
  const emitted = emitAssemblyScript(irOf('export function main(): void { while (true) { waitFrame(); } }'));
  assert.ok(emitted.ok);
  assert.equal(emitted.usesWaitFrame, true);
  assert.match(emitted.source, /@external\("env", "waitFrame"\)\ndeclare function waitFrame\(\): void;/);
  assert.match(emitted.source, /waitFrame\(\);/);
  const without = emitAssemblyScript(irOf(MILESTONE));
  assert.doesNotMatch(without.source, /@external/);
});

test('@address is a target error, not a shrug', () => {
  const emitted = emitAssemblyScript(irOf('@address(0x900F)\nlet v: volatile<u8>;'));
  assert.equal(emitted.ok, false);
  assert.match(emitted.error, /no such hardware on the web target/);
});

test('IR with unresolved imports is refused, not dropped', async () => {
  const result = await buildWasm(irOf('import { limit } from "./lib.8bs";'), { outFile: 'unused.wasm' });
  assert.equal(result.ok, false);
  assert.match(result.error, /unresolved imports/);
});

test('the milestone program runs and its u8 wraps', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-test-'));
  try {
    const outFile = join(scratch, 'm.wasm');
    const result = await buildWasm(irOf(MILESTONE), { outFile });
    assert.ok(result.ok, result.error);

    const { instance } = await WebAssembly.instantiate(await readFile(outFile));
    assert.equal(instance.exports.x.value, 10);
    instance.exports.main();
    assert.equal(instance.exports.x.value, 11);
    for (let i = 0; i < 250; i += 1) instance.exports.main();
    assert.equal(instance.exports.x.value, 5, 'u8 must wrap at 256');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a waitFrame() program builds with shared memory and runs against a host-supplied import', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-test-'));
  try {
    const outFile = join(scratch, 'w.wasm');
    const src = 'let frames: u8 = 0;\nexport function main(): void {\n    while (true) {\n        waitFrame();\n        frames = frames + 1;\n    }\n}\n';
    const result = await buildWasm(irOf(src), { outFile });
    assert.ok(result.ok, result.error);

    const module = await WebAssembly.compile(await readFile(outFile));
    assert.deepEqual(
      WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`),
      ['env.waitFrame'],
    );
    // Exactly one function export — the program — beside its globals/memory.
    assert.deepEqual(
      WebAssembly.Module.exports(module).filter((e) => e.kind === 'function').map((e) => e.name),
      ['main'],
    );

    // A headless host bounds the program by throwing out of the import: the
    // exception unwinds through the wasm frames to the caller of main().
    class Stop extends Error {}
    let calls = 0;
    // Instantiating a compiled Module yields the Instance directly.
    const instance = await WebAssembly.instantiate(module, {
      env: { waitFrame() { calls += 1; if (calls > 10) throw new Stop(); } },
    });
    assert.ok(instance.exports.memory.buffer instanceof SharedArrayBuffer, 'memory must be shared');
    assert.throws(() => instance.exports.main(), Stop);
    assert.equal(instance.exports.frames.value, 10);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
