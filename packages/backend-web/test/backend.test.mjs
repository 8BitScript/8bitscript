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
  const emitted = emitAssemblyScript(irOf('export function main(): void { apply(); }\nexport function apply(): void { return; }'));
  assert.ok(emitted.ok);
  assert.match(emitted.source, /apply\(\);/);
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
