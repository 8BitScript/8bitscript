// last-run JSON: the file `8bs run` writes next to the binary so the
// editor can show a Running machines tree without scraping a terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  compileReport, displayOutFile, hardwareSnapshot, lastRunPath, writeLastRun,
} from '../src/last-run.mjs';

test('lastRunPath is dist/.8bs-last-<target>.json under cwd', () => {
  assert.equal(lastRunPath('pet', '/tmp/proj'), join('/tmp/proj', 'dist', '.8bs-last-pet.json'));
  assert.equal(lastRunPath('web', '/tmp/proj'), join('/tmp/proj', 'dist', '.8bs-last-web.json'));
});

test('hardwareSnapshot keeps the sheet a program was built for, not emulator flags', () => {
  assert.equal(hardwareSnapshot(null), null);
  assert.deepEqual(
    hardwareSnapshot({
      machine: 'pet',
      label: '8032',
      profile: '8032',
      options: { model: '8032', ram: '32' },
      facts: { 'video.columns': 80 },
      run: { xpet: ['-model', '8032'] },
    }),
    {
      machine: 'pet',
      label: '8032',
      profile: '8032',
      options: { model: '8032', ram: '32' },
      facts: { 'video.columns': 80 },
    },
  );
});

test('displayOutFile is relative when the file lives inside cwd', () => {
  assert.equal(displayOutFile('/tmp/proj/dist/main-pet.prg', '/tmp/proj'), join('dist', 'main-pet.prg'));
  assert.equal(displayOutFile('/elsewhere/x.prg', '/tmp/proj'), '/elsewhere/x.prg');
  assert.equal(displayOutFile(null), null);
});

test('compileReport names memory, size, and hardware for one target', () => {
  const report = compileReport('pet', {
    outFile: join('/tmp/proj', 'dist', 'main-pet.prg'),
    hardware: { machine: 'pet', label: 'stock', profile: null, options: {}, facts: {} },
    memory: { variables: 8, program: 331 },
    sizeReport: [{ name: 'main', bytes: 40 }],
    frameRate: 60,
  }, '/tmp/proj');
  assert.equal(report.target, 'pet');
  assert.equal(report.outFile, join('dist', 'main-pet.prg'));
  assert.deepEqual(report.memory, { variables: 8, program: 331 });
  assert.deepEqual(report.size, [{ name: 'main', bytes: 40 }]);
  assert.equal(report.hardware.label, 'stock');
  assert.equal(report.frameRate, 60);
});

test('writeLastRun merges a later patch onto the compile report', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-last-run-'));
  try {
    await writeLastRun('pet', { memory: { variables: 8, program: 10 }, size: [] }, dir);
    const merged = await writeLastRun('pet', { emulator: 'xpet' }, dir);
    assert.equal(merged.emulator, 'xpet');
    assert.deepEqual(merged.memory, { variables: 8, program: 10 });
    const onDisk = JSON.parse(await readFile(lastRunPath('pet', dir), 'utf8'));
    assert.equal(onDisk.emulator, 'xpet');
    assert.equal(typeof onDisk.writtenAt, 'string');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
