// `8bs build` through compile() and build(): the parked-target refusals,
// a real PET .prg for a for-loop (milestone 6), and the web backend's
// not-implemented path. No emulator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build, compile } from '../src/build.mjs';

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
  }).then((result) => ({ result, stdout: stdout.join(''), stderr: stderr.join('') }));
}

const SUM = [
  'let sum: utinyint = 0;',
  'export function main(): void {',
  '    for (let i: utinyint = 0; i < 10; i++) {',
  '        sum = sum + i;',
  '    }',
  '    memory.write(0x8000, sum);',
  '}',
  '',
].join('\n');

test('build() with no target is usage and exit 2', async () => {
  const { result, stderr } = await capture(() => build([]));
  assert.equal(result, 2);
  assert.match(stderr, /Usage: 8bs build/);
  assert.match(stderr, /--target <pet\|web>/);
});

test('build() names a missing --profile value rather than treating the next flag as the name', async () => {
  const { result, stderr } = await capture(() => build(['--target', 'pet', '--profile']));
  assert.equal(result, 2);
  assert.match(stderr, /--profile expects a name/);
});

test('compile() refuses a parked machine, a retired name, and an unknown target', async () => {
  const parked = await capture(() => compile('c64'));
  assert.equal(parked.result.ok, false);
  assert.match(parked.stderr, /not a target in this release/);
  assert.match(parked.stderr, /c64/);

  const retired = await capture(() => compile('c64-pal'));
  assert.equal(retired.result.ok, false);
  assert.match(retired.stderr, /no longer a target/);
  assert.match(retired.stderr, /'--pal'/);

  const unknown = await capture(() => compile('spectrum'));
  assert.equal(unknown.result.ok, false);
  assert.match(unknown.stderr, /unknown target 'spectrum'/);
});

test('compile() for pet writes a .prg for a for-loop that sums 0..9', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-compile-'));
  const prev = process.cwd();
  try {
    const entry = join(dir, 'main.8bs');
    await writeFile(entry, SUM);
    process.chdir(dir);
    const { result, stdout, stderr } = await capture(() => compile('pet', entry));
    assert.equal(result.ok, true, stdout + stderr);
    assert.ok(result.outFile.endsWith('main-pet.prg'), result.outFile);
    assert.equal(existsSync(result.outFile), true);
    const bytes = await readFile(result.outFile);
    assert.ok(bytes.length > 15, `expected more than an empty stub, got ${bytes.length}`);
    assert.equal(bytes[0], 0x01); // PET load address $0401
    assert.equal(bytes[1], 0x04);
    assert.match(stdout, /built /);
    assert.match(stdout, /bytes of program/);
    assert.equal(result.frameRate, 60);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test('compile() for web reaches the wasm backend and reports it is not implemented', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-compile-'));
  const prev = process.cwd();
  try {
    const entry = join(dir, 'main.8bs');
    await writeFile(entry, 'export function main(): void { memory.write(0x8000, 1); }\n');
    process.chdir(dir);
    const { result, stderr } = await capture(() => compile('web', entry));
    assert.equal(result.ok, false);
    assert.match(stderr, /not implemented/);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test('compile() prints diagnostics and does not build when the entry has a problem', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-compile-'));
  const prev = process.cwd();
  try {
    const entry = join(dir, 'main.8bs');
    await writeFile(entry, 'let x: u8 = 0x;\nexport function main(): void {}\n');
    process.chdir(dir);
    const { result, stdout } = await capture(() => compile('pet', entry));
    assert.equal(result.ok, false);
    assert.match(stdout, /8BS1008/);
    assert.match(stdout, /not building/);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test('compile() names a missing entry and a project that does not list the target', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-compile-'));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const missing = await capture(() => compile('pet', join(dir, 'nope.8bs')));
    assert.equal(missing.result.ok, false);
    assert.match(missing.stderr, /does not exist/);

    await writeFile(join(dir, '8bs.config.ts'), 'export default { targets: ["web"] };\n');
    const listed = await capture(() => compile('pet', join(dir, 'main.8bs')));
    assert.equal(listed.result.ok, false);
    assert.match(listed.stderr, /does not list 'pet'/);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test('compile() refuses a frameRate that is not a positive integer', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-compile-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, '8bs.config.ts'), 'export default { frameRate: -1 };\n');
    process.chdir(dir);
    const { result, stderr } = await capture(() => compile('pet'));
    assert.equal(result.ok, false);
    assert.match(stderr, /frameRate must be a positive integer/);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test('compile() names unknown hardware and a program the PET backend cannot lower yet', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-compile-'));
  const prev = process.cwd();
  try {
    const entry = join(dir, 'main.8bs');
    await writeFile(entry, 'export function main(): void { memory.write(0x8000, 1); }\n');
    process.chdir(dir);
    const unknownHw = await capture(() => compile('pet', entry, { hardware: { model: 'nope' } }));
    assert.equal(unknownHw.result.ok, false);
    assert.match(unknownHw.stderr, /nope/);

    await writeFile(entry, 'let hp: array<utinyint, 4>;\nexport function main(): void { hp[0] = 1; }\n');
    const noRule = await capture(() => compile('pet', entry));
    assert.equal(noRule.result.ok, false);
    assert.match(noRule.stdout + noRule.stderr, /array storage isn't allocated yet/);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});
