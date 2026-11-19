import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeLcov, writeLcov } from './test-coverage.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(ROOT, 'packages', 'demo');

const record = (...rows) => ['SF:src/a.mjs', ...rows, 'end_of_record'].join('\n');

function merged(...runs) {
  const files = new Map();
  for (const run of runs) mergeLcov(pkg, run, files);
  const out = join(mkdtempSync(join(tmpdir(), 'lcov-merge-')), 'lcov.info');
  writeLcov(files, out);
  const text = readFileSync(out, 'utf8');
  rmSync(dirname(out), { recursive: true, force: true });
  return text.split('\n');
}

test('a run that never reached a branch adds no phantom entries', () => {
  const lines = merged(
    record('DA:10,3', 'BRDA:10,0,0,2', 'BRDA:10,0,1,1'),
    record('DA:10,1', 'BRDA:10,4,0,0', 'BRDA:10,4,1,0', 'BRDA:10,5,0,0'),
  );
  assert.deepEqual(lines.filter((l) => l.startsWith('BRDA:')), ['BRDA:10,0,0,2', 'BRDA:10,0,1,1']);
  assert.ok(lines.includes('BRF:2'));
  assert.ok(lines.includes('BRH:2'));
});

test('runs with identical branch keys sum their hits', () => {
  const lines = merged(
    record('BRDA:7,0,0,1', 'BRDA:7,0,1,0'),
    record('BRDA:7,0,0,0', 'BRDA:7,0,1,4'),
  );
  assert.deepEqual(lines.filter((l) => l.startsWith('BRDA:')), ['BRDA:7,0,0,1', 'BRDA:7,0,1,4']);
  assert.ok(lines.includes('BRH:2'));
});

test('ties on taken branches prefer the run with more entries; lines still union', () => {
  const lines = merged(
    record('DA:3,1', 'BRDA:3,0,0,-'),
    record('DA:3,2', 'BRDA:3,1,0,0', 'BRDA:3,1,1,0'),
  );
  assert.deepEqual(lines.filter((l) => l.startsWith('BRDA:')), ['BRDA:3,1,0,0', 'BRDA:3,1,1,0']);
  assert.ok(lines.includes('DA:3,3'));
  assert.ok(lines.includes('LH:1'));
});

test('branches on different lines are kept independently and sorted', () => {
  const lines = merged(record('BRDA:20,0,0,1'), record('BRDA:5,2,0,3'));
  assert.deepEqual(lines.filter((l) => l.startsWith('BRDA:')), ['BRDA:5,2,0,3', 'BRDA:20,0,0,1']);
});
