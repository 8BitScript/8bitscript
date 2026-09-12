// `8bs build` through compile() and build(): the parked-target refusals,
// a real PET .prg for a for-loop (milestone 6), and a real web .wasm for
// the same program. No emulator.
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
  // The nes stands in for "parked": every Commodore and the X16 build now.
  const parked = await capture(() => compile('nes'));
  assert.equal(parked.result.ok, false);
  assert.match(parked.stderr, /not a target in this release/);
  assert.match(parked.stderr, /nes/);

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

test('build() --size prints a breakdown under the memory line; without it, nothing extra prints', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-compile-'));
  const prev = process.cwd();
  try {
    const entry = join(dir, 'main.8bs');
    await writeFile(entry, SUM);
    process.chdir(dir);

    const plain = await capture(() => build(['--target', 'pet', entry]));
    assert.equal(plain.result, 0, plain.stdout + plain.stderr);
    assert.doesNotMatch(plain.stdout, /size breakdown/);

    const sized = await capture(() => build(['--target', 'pet', '--size', entry]));
    assert.equal(sized.result, 0, sized.stdout + sized.stderr);
    assert.match(sized.stdout, /size breakdown:\n/);
    assert.match(sized.stdout, /main/, 'the one function this program declares should be named in the breakdown');
    // Every reported percentage really is out of the same total the memory
    // line just printed, not some other number entirely.
    const programBytes = Number(/(\d+) bytes of program/.exec(sized.stdout)[1]);
    const reportedBytes = [...sized.stdout.matchAll(/^ *(\d+) *[\d.]+%/gm)].map((m) => Number(m[1]));
    assert.equal(reportedBytes.reduce((a, b) => a + b, 0), programBytes);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test('build() --size works for web too, against the module\'s own real byte total', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-compile-'));
  const prev = process.cwd();
  try {
    const entry = join(dir, 'main.8bs');
    await writeFile(entry, SUM);
    process.chdir(dir);
    const { result, stdout, stderr } = await capture(() => build(['--target', 'web', '--size', entry]));
    assert.equal(result, 0, stdout + stderr);
    assert.match(stdout, /size breakdown:\n/);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test('build() --release builds every target listed, once per name in its own release array', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-compile-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, 'main.8bs'), SUM);
    await writeFile(join(dir, '8bitscript.config.ts'), [
      'export default {',
      '  entry: "main.8bs",',
      '  targets: {',
      // '2001' is a catalog preset (the stock 4K PET); {} is not a preset at
      // all — it falls back to this target's own default hardware, the same
      // build `8bs build --target pet` already produces. That distinction
      // matters: the '4032' catalog preset also sets a speaker option this
      // project's own default hardware does not, which would build a
      // different (if equally valid) program under a different name.
      '    pet: { hardware: { model: "4032", ram: "32" }, release: ["2001", {}] },',
      '    web: {},',
      '  },',
      '};',
      '',
    ].join('\n'));
    process.chdir(dir);
    const { result, stdout, stderr } = await capture(() => build(['--release']));
    assert.equal(result, 0, stdout + stderr);
    assert.equal(existsSync(join(dir, 'dist', 'main-pet.prg')), true, '2001 (stock) should build unsuffixed');
    assert.equal(existsSync(join(dir, 'dist', 'main-pet-4032-32.prg')), true, "the target's own default hardware should build under its own name");
    assert.equal(existsSync(join(dir, 'dist', 'main.wasm')), true);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test('build() --release skips a target 8bitscript.config.ts lists that this release does not build for', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-compile-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, 'main.8bs'), SUM);
    await writeFile(
      join(dir, '8bitscript.config.ts'),
      'export default { entry: "main.8bs", targets: { c64: {}, web: {} } };\n',
    );
    process.chdir(dir);
    const { result, stdout, stderr } = await capture(() => build(['--release']));
    assert.equal(result, 0, stdout + stderr);
    assert.equal(existsSync(join(dir, 'dist', 'main.wasm')), true);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test('build() --release fails clearly when the config lists no release-ready target', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-compile-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, '8bitscript.config.ts'), 'export default { targets: { nes: {} } };\n');
    process.chdir(dir);
    const { result, stderr } = await capture(() => build(['--release']));
    assert.equal(result, 1);
    assert.match(stderr, /lists no target this release builds for/);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test('compile() for web writes a .wasm for a for-loop that sums 0..9', async () => {
  // The wasm backend's own milestones 1-5 (packages/compiler/src/wasm)
  // made this a real build, not a refusal — see the "Hello, WASM" roadmap.
  const dir = await mkdtemp(join(tmpdir(), '8bs-compile-'));
  const prev = process.cwd();
  try {
    const entry = join(dir, 'main.8bs');
    await writeFile(entry, SUM);
    process.chdir(dir);
    const { result, stdout, stderr } = await capture(() => compile('web', entry));
    assert.equal(result.ok, true, stdout + stderr);
    assert.ok(result.outFile.endsWith('main.wasm'), result.outFile);
    assert.equal(existsSync(result.outFile), true);
    const bytes = await readFile(result.outFile);
    assert.deepEqual([...bytes.slice(0, 4)], [0x00, 0x61, 0x73, 0x6d]); // the wasm magic number
    assert.equal(result.frameRate, 60);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test('compile() for web still names a real, specific gap for a construct nothing on this rail lowers, not a generic "not implemented"', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-compile-'));
  const prev = process.cwd();
  try {
    const entry = join(dir, 'main.8bs');
    // An `@address`-pinned global: hardware another machine would map,
    // nothing the web target owns — refused by name for the rail's whole
    // run (a `let` array, this fixture's previous shape, gained its
    // linear-memory home in 0.2.2). main has to actually touch it: the
    // compiler prunes whatever the entry can't reach
    // (linker/reachability.mjs), so an unreferenced global's own
    // unsupported shape would otherwise never be seen at all.
    await writeFile(entry, '@address(0xD020)\nlet border: utinyint;\nexport function main(): void { border = 1; }\n');
    process.chdir(dir);
    const { result, stderr } = await capture(() => compile('web', entry));
    assert.equal(result.ok, false);
    assert.match(stderr, /pinned global/);
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

    // A mutable array builds now (0.2.2); a runtime divide is a shape the
    // PET backend still genuinely refuses by name, and stays the fixture.
    await writeFile(entry, 'export function main(): void {\n    let a: utinyint = 9;\n    let b: utinyint = 3;\n    memory.write(0x8000, a / b);\n}\n');
    const noRule = await capture(() => compile('pet', entry));
    assert.equal(noRule.result.ok, false);
    assert.match(noRule.stdout + noRule.stderr, /the '\/' operator isn't lowered yet/);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test('compile() always writes dist/.8bs-last-<target>.json; --size fills in the breakdown', async () => {
  const { lastRunPath } = await import('../src/last-run.mjs');
  const dir = await mkdtemp(join(tmpdir(), '8bs-compile-'));
  const prev = process.cwd();
  try {
    const entry = join(dir, 'main.8bs');
    await writeFile(entry, SUM);
    process.chdir(dir);

    const plain = await capture(() => compile('pet', entry));
    assert.equal(plain.result.ok, true, plain.stdout + plain.stderr);
    const report = JSON.parse(await readFile(lastRunPath('pet', dir), 'utf8'));
    assert.equal(report.target, 'pet');
    assert.ok(report.memory.program > 0);
    assert.deepEqual(report.size, [], 'no --size, no breakdown in the file');
    assert.equal(report.hardware.machine, 'pet');

    const sized = await capture(() => compile('pet', entry, { report: true }));
    assert.equal(sized.result.ok, true, sized.stdout + sized.stderr);
    assert.match(sized.stdout, /size breakdown:/);
    const withSize = JSON.parse(await readFile(lastRunPath('pet', dir), 'utf8'));
    assert.ok(withSize.size.length > 0);
    assert.ok(withSize.size.every((e) => typeof e.name === 'string' && e.bytes > 0));
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});
