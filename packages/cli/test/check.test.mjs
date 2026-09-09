import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { check } from '../src/check.mjs';

function capture(fn) {
  const stdout = [];
  const stderr = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = out;
    process.stderr.write = err;
  }).then((code) => ({ code, stdout: stdout.join(''), stderr: stderr.join('') }));
}

test('check with no files is usage and exit 2', async () => {
  const { code, stderr } = await capture(() => check([]));
  assert.equal(code, 2);
  assert.match(stderr, /no files given/);
});

test('check of a clean file is 0; a diagnostic is 1; a missing file is 1', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-check-'));
  try {
    const clean = join(dir, 'ok.8bs');
    await writeFile(clean, 'export function main(): void { memory.write(0x8000, 1); }\n');
    const good = await capture(() => check([clean]));
    assert.equal(good.code, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /No problems found/);

    const bad = join(dir, 'bad.8bs');
    await writeFile(bad, 'let x: u8 = 0x;\n');
    const reported = await capture(() => check([bad]));
    assert.equal(reported.code, 1);
    assert.match(reported.stdout, /8BS1008/);
    assert.match(reported.stdout, /problem\(s\) found/);

    const missing = await capture(() => check([join(dir, 'nope.8bs')]));
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /cannot read/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check refuses a project whose frameRate is not a positive integer', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-check-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, '8bs.config.ts'), 'export default { frameRate: 0 };\n');
    process.chdir(dir);
    const { code, stderr } = await capture(() => check([join(dir, 'x.8bs')]));
    assert.equal(code, 2);
    assert.match(stderr, /frameRate must be a positive integer/);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});
