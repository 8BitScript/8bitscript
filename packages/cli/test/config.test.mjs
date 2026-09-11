import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, resolveFrameRate } from '../src/config.mjs';

test('resolveFrameRate defaults to 60, accepts a positive integer, and names anything else', () => {
  assert.deepEqual(resolveFrameRate(null), { ok: true, frameRate: 60 });
  assert.deepEqual(resolveFrameRate({}), { ok: true, frameRate: 60 });
  assert.deepEqual(resolveFrameRate({ frameRate: 50 }), { ok: true, frameRate: 50 });
  const bad = resolveFrameRate({ frameRate: 0 });
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.match(bad.error, /positive integer, got 0/);
  const frac = resolveFrameRate({ frameRate: 59.9 });
  assert.equal(frac.ok, false);
});

test('loadConfig returns null when there is no 8bs.config.ts, and the default export when there is', async () => {
  const empty = await mkdtemp(join(tmpdir(), '8bs-config-'));
  try {
    assert.equal(await loadConfig(empty), null);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }

  const dir = await mkdtemp(join(tmpdir(), '8bs-config-'));
  try {
    await writeFile(join(dir, '8bs.config.ts'), 'export default { frameRate: 50, entry: "src/main.8bs" };\n');
    const config = await loadConfig(dir);
    assert.deepEqual(config, { frameRate: 50, entry: 'src/main.8bs' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig writes a load error and returns null when 8bs.config.ts does not evaluate', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-config-'));
  const stderr = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    await writeFile(join(dir, '8bs.config.ts'), 'throw new Error("boom");\n');
    assert.equal(await loadConfig(dir, '8bs check'), null);
    assert.match(stderr.join(''), /8bs check: cannot load 8bs.config.ts: boom/);
  } finally {
    process.stderr.write = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig prefers 8bitscript.config.ts, the current name, over the old 8bs.config.ts', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-config-'));
  try {
    await writeFile(join(dir, '8bitscript.config.ts'), 'export default { frameRate: 30 };\n');
    const config = await loadConfig(dir);
    assert.deepEqual(config, { frameRate: 30 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig still finds 8bs.config.ts, the pre-0.4.0 name, when there is no 8bitscript.config.ts', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-config-'));
  try {
    await writeFile(join(dir, '8bs.config.ts'), 'export default { frameRate: 50 };\n');
    const config = await loadConfig(dir);
    assert.deepEqual(config, { frameRate: 50 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
