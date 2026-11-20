import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, resolveFrameRate, retiredOptionWarnings } from '../src/config.mjs';

test('retiredOptionWarnings names an option that no longer does anything, and stays quiet otherwise', () => {
  assert.deepEqual(retiredOptionWarnings(null), []);
  assert.deepEqual(retiredOptionWarnings({}), [], 'a project that never set it hears nothing');
  assert.deepEqual(retiredOptionWarnings({ frameRate: 50 }), [], 'options that still work are not retired');
  // Both spellings are reported: the option is gone, so the value it was
  // given no longer changes anything and staying silent about `false`
  // would be the one case where a project thinks it is still in control.
  for (const value of [true, false]) {
    const warnings = retiredOptionWarnings({ restoreOnExit: value });
    assert.equal(warnings.length, 1, String(value));
    assert.match(warnings[0], /restoreOnExit no longer does anything/);
  }
});

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

test('loadConfig returns null when there is no config file, and the default export when there is', async () => {
  const empty = await mkdtemp(join(tmpdir(), '8bs-config-'));
  try {
    assert.equal(await loadConfig(empty), null);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }

  const dir = await mkdtemp(join(tmpdir(), '8bs-config-'));
  try {
    await writeFile(join(dir, '8bitscript.config.ts'), 'export default { frameRate: 50, entry: "src/main.8bs" };\n');
    const config = await loadConfig(dir);
    assert.deepEqual(config, { frameRate: 50, entry: 'src/main.8bs' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig writes a load error and returns null when 8bitscript.config.ts does not evaluate', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-config-'));
  const stderr = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    await writeFile(join(dir, '8bitscript.config.ts'), 'throw new Error("boom");\n');
    assert.equal(await loadConfig(dir, '8bs check'), null);
    assert.match(stderr.join(''), /8bs check: cannot load 8bitscript\.config\.ts: boom/);
  } finally {
    process.stderr.write = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig prefers 8bitscript.config.ts over the older 8bs.config.ts', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-config-'));
  try {
    await writeFile(join(dir, '8bitscript.config.ts'), 'export default { frameRate: 30 };\n');
    await writeFile(join(dir, '8bs.config.ts'), 'export default { frameRate: 999 };\n');
    const config = await loadConfig(dir);
    assert.deepEqual(config, { frameRate: 30 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig still finds 8bs.config.ts, the pre-0.4.0 name, when the newer name is not there', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-config-'));
  try {
    await writeFile(join(dir, '8bs.config.ts'), 'export default { frameRate: 50 };\n');
    const config = await loadConfig(dir);
    assert.deepEqual(config, { frameRate: 50 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig refuses a directory whose only config is the old 8bitscript.config.8bs, and names the fix', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-config-'));
  try {
    await writeFile(join(dir, '8bitscript.config.8bs'), 'export default { frameRate: 30 };\n');
    await assert.rejects(loadConfig(dir, '8bs check'), (error) => {
      assert.equal(error.name, 'StaleConfigError');
      assert.match(error.message, /8bs check: .*8bitscript\.config\.8bs is no longer read; rename it to 8bitscript\.config\.ts/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig reads the .ts config when the old .8bs one sits beside it', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-config-'));
  try {
    await writeFile(join(dir, '8bitscript.config.8bs'), 'export default { frameRate: 999 };\n');
    await writeFile(join(dir, '8bitscript.config.ts'), 'export default { frameRate: 30 };\n');
    assert.deepEqual(await loadConfig(dir), { frameRate: 30 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig reads 8bitscript.config.ts as plain type-stripped TypeScript', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-config-'));
  try {
    await writeFile(
      join(dir, '8bitscript.config.ts'),
      'const frameRate: number = 50;\nexport default { frameRate, entry: "src/main.8bs" };\n',
    );
    const config = await loadConfig(dir);
    assert.deepEqual(config, { frameRate: 50, entry: 'src/main.8bs' });
    assert.deepEqual(readdirSync(dir), ['8bitscript.config.ts'], 'no temp file is left behind');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig writes a load error and returns null when a .8bs config does not evaluate', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-config-'));
  const stderr = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    await writeFile(join(dir, '8bitscript.config.8bs'), 'throw new Error("boom");\n');
    assert.equal(await loadConfig(dir, '8bs check'), null);
    assert.match(stderr.join(''), /8bs check: cannot load 8bitscript\.config\.8bs: boom/);
  } finally {
    process.stderr.write = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig loads a typed .ts config from under node_modules, and cleans up its temp file', async () => {
  const root = await mkdtemp(join(tmpdir(), '8bs-config-'));
  try {
    const dir = join(root, 'node_modules', '@8bitscript', 'studio');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, '8bitscript.config.ts'),
      'const frameRate: number = 50;\nexport default { frameRate, entry: "src/main.8bs" };\n',
    );
    assert.deepEqual(await loadConfig(dir), { frameRate: 50, entry: 'src/main.8bs' });
    assert.deepEqual(readdirSync(dir), ['8bitscript.config.ts'], 'the stripped temp file is cleaned up');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A read-only directory cannot take the temp copy; root ignores the mode bits.
const readOnlyTest = process.getuid?.() === 0 || process.platform === 'win32' ? test.skip : test;

readOnlyTest('loadConfig falls back to importing the .ts itself when the directory is read-only', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-config-ro-'));
  try {
    await writeFile(join(dir, '8bitscript.config.ts'), 'const frameRate: number = 50;\nexport default { frameRate };\n');
    await chmod(dir, 0o555);
    assert.deepEqual(await loadConfig(dir), { frameRate: 50 });
    assert.deepEqual(readdirSync(dir), ['8bitscript.config.ts'], 'nothing was left behind');
  } finally {
    await chmod(dir, 0o755);
    await rm(dir, { recursive: true, force: true });
  }
});

readOnlyTest('loadConfig names both failures when the read-only fallback cannot load either', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-config-ro-'));
  const stderr = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    await writeFile(join(dir, '8bitscript.config.ts'), 'throw new Error("boom");\n');
    await chmod(dir, 0o555);
    assert.equal(await loadConfig(dir), null);
  } finally {
    process.stderr.write = original;
    await chmod(dir, 0o755);
    await rm(dir, { recursive: true, force: true });
  }
  assert.match(stderr.join(''), /cannot load 8bitscript\.config\.ts: boom \(could not write a temporary copy in .* either: EACCES\)/);
});
