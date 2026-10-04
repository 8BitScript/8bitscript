// @8bitscript/random: it links on every target (structural proof the surface
// compiles everywhere). That the compiled program does what src/index.8bs
// documents — the LCG step, exactly uniform range() and bits() — is checked
// by running it, in uniform.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'src');

const TARGETS = ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'];

test('the package has a bare entry (the default generator) and two subpaths (the lookup table, and hardware entropy where a machine has it)', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg['8bitscript'].entry, './src/index.8bs');
  assert.deepEqual(pkg['8bitscript'].exports, { './table': './src/table.8bs', './entropy': './src/entropy.8bs' });
  // entropy.8bs and its two machine twins — see entropy.test.mjs.
  assert.deepEqual(readdirSync(SRC).sort(), ['entropy.8bs', 'entropy.atari8.8bs', 'entropy.c64.8bs', 'index.8bs', 'table.8bs']);
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
  for (const call of ['random_seed', 'random_next', 'random_range', 'random_bits']) {
    assert.ok(names.has(call), `${call} is missing from the linked program`);
  }
});

test('the table probe offers the whole surface, on both the default generator and the table', () => {
  const source = readFileSync(TABLE_PROBE, 'utf8');
  const { ir } = link(source, TABLE_PROBE, { machine: 'c64', facts: stockFacts('c64') });
  const names = new Set(ir.functions.map((f) => f.name));
  for (const call of ['random_seed', 'random_range', 'random_bits', 'table_seed', 'table_next', 'table_range', 'table_bits', 'table_at']) {
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
