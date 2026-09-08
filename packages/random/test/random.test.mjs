// @8bitscript/random: it links on every target (structural proof the surface
// compiles everywhere), and on the web target it is run for real, with its
// output checked against the same LCG step worked out independently here —
// proof the compiled program does what src/index.8bs documents, not just
// that it compiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';
import { buildWasm } from '../../backend-web/src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'src');

const TARGETS = ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'];

test('the package has a bare entry (the default generator) and one subpath (the lookup table)', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg['8bitscript'].entry, './src/index.8bs');
  assert.deepEqual(pkg['8bitscript'].exports, { './table': './src/table.8bs' });
  assert.deepEqual(readdirSync(SRC).sort(), ['index.8bs', 'table.8bs']);
});

const PROBE = join(HERE, 'random-probe.8bs');
const TABLE_PROBE = join(HERE, 'table-probe.8bs');

for (const target of TARGETS) {
  test(`random links clean for ${target}`, () => {
    const source = readFileSync(PROBE, 'utf8');
    const { ir, diagnostics } = link(source, PROBE, { machine: target, facts: stockFacts(target) });
    assert.deepEqual(diagnostics, []);
    assert.equal(ir.entry, 'main');
  });

  test(`the default generator and @8bitscript/random/table both link clean for ${target}, from the same file`, () => {
    const source = readFileSync(TABLE_PROBE, 'utf8');
    const { ir, diagnostics } = link(source, TABLE_PROBE, { machine: target, facts: stockFacts(target) });
    assert.deepEqual(diagnostics, []);
    assert.equal(ir.entry, 'main');
  });
}

test('the probe offers the whole surface', () => {
  const source = readFileSync(PROBE, 'utf8');
  const { ir } = link(source, PROBE, { machine: 'c64', facts: stockFacts('c64') });
  const names = new Set(ir.functions.map((f) => f.name));
  for (const call of ['random_seed', 'random_next', 'random_range']) {
    assert.ok(names.has(call), `${call} is missing from the linked program`);
  }
});

test('the table probe offers the whole surface, on both the default generator and the table', () => {
  const source = readFileSync(TABLE_PROBE, 'utf8');
  const { ir } = link(source, TABLE_PROBE, { machine: 'c64', facts: stockFacts('c64') });
  const names = new Set(ir.functions.map((f) => f.name));
  for (const call of ['random_seed', 'random_range', 'table_seed', 'table_next', 'table_range', 'table_at']) {
    assert.ok(names.has(call), `${call} is missing from the linked program`);
  }
});

test('the table is a permutation of every byte 0-255, not an arbitrary sequence', () => {
  const source = readFileSync(join(SRC, 'table.8bs'), 'utf8');
  const match = /const TABLE: array<utinyint, 256> = \[([\s\S]*?)\];/.exec(source);
  assert.ok(match, 'TABLE literal not found');
  const values = match[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0).map(Number);
  assert.equal(values.length, 256);
  assert.deepEqual(values.slice().sort((a, b) => a - b), Array.from({ length: 256 }, (_, i) => i));
});

// The generator itself: state = state * 25173 + 13849 (mod 65536), the
// result is the new state's high byte, and range() is that mod bound.
function referenceLcg(seed) {
  let state = seed & 0xffff;
  const next = () => {
    state = (state * 25173 + 13849) & 0xffff;
    return state >> 8;
  };
  return next;
}

test('compiled to wasm, the generator matches the documented algorithm exactly', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-random-test-'));
  try {
    const entry = join(HERE, 'random-values-main.8bs');
    const source = readFileSync(entry, 'utf8');
    const { ir, diagnostics } = link(source, entry, { machine: 'web', facts: stockFacts('web') });
    assert.deepEqual(diagnostics, []);

    const outFile = join(scratch, 'random.wasm');
    const result = await buildWasm(ir, { outFile });
    assert.ok(result.ok, result.error);

    const { instance } = await WebAssembly.instantiate(await readFile(outFile));
    instance.exports.main();

    const next = referenceLcg(1);
    assert.equal(instance.exports.r0.value, next());
    assert.equal(instance.exports.r1.value, next());
    assert.equal(instance.exports.r2.value, next());
    assert.equal(instance.exports.r3.value, next() % 6);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('compiled to wasm, the table generator reads the same 256-byte table this file ships', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-random-table-test-'));
  try {
    const tableSource = readFileSync(join(SRC, 'table.8bs'), 'utf8');
    const match = /const TABLE: array<utinyint, 256> = \[([\s\S]*?)\];/.exec(tableSource);
    const TABLE = match[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0).map(Number);

    const entry = join(HERE, 'table-values-main.8bs');
    const source = readFileSync(entry, 'utf8');
    const { ir, diagnostics } = link(source, entry, { machine: 'web', facts: stockFacts('web') });
    assert.deepEqual(diagnostics, []);

    const outFile = join(scratch, 'table.wasm');
    const result = await buildWasm(ir, { outFile });
    assert.ok(result.ok, result.error);

    const { instance } = await WebAssembly.instantiate(await readFile(outFile));
    instance.exports.main();

    // seed(37); next() reads TABLE[37] then steps to 38; next() reads
    // TABLE[38] then steps to 39; range(6) reads TABLE[39] % 6 then steps
    // to 40; at(0) is stateless and always reads TABLE[0].
    assert.equal(instance.exports.t0.value, TABLE[37]);
    assert.equal(instance.exports.t1.value, TABLE[38]);
    assert.equal(instance.exports.t2.value, TABLE[39] % 6);
    assert.equal(instance.exports.t3.value, TABLE[0]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
