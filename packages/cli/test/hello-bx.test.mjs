// The zero-cost gate for 8BX (spec §69): hello-bx draws its greeting
// through one component; hello-world calls text.print() by hand. Both
// carry no media at all (a program that draws once and returns has no
// frame to release a voice on or to draw a placed object from), so the two
// are the same program written two ways — and the byte counts below are
// what says the component cost nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const EXAMPLES = join(REPO, 'packages', 'examples');

const CLI_LINE = /^(built |memory: |size breakdown|web bundle: |8bs build: )/;
function silently(fn) {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => (CLI_LINE.test(String(chunk)) ? true : out(chunk, ...rest));
  process.stderr.write = (chunk, ...rest) => (CLI_LINE.test(String(chunk)) ? true : err(chunk, ...rest));
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = out;
    process.stderr.write = err;
  });
}

async function buildExample(name, target) {
  const root = mkdtempSync(join(tmpdir(), `8bs-${name}-`));
  const dir = join(root, name);
  const prev = process.cwd();
  try {
    cpSync(join(EXAMPLES, name, 'src'), join(dir, 'src'), { recursive: true });
    cpSync(join(EXAMPLES, name, '8bitscript.config.ts'), join(dir, '8bitscript.config.ts'));
    cpSync(join(EXAMPLES, 'shared-release-targets.ts'), join(root, 'shared-release-targets.ts'));
    process.chdir(dir);
    const result = await silently(() => compile(target, undefined, { checkout: REPO }));
    assert.equal(result.ok, true, `${name} builds for ${target}`);
    return result.memory?.program;
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  }
}

test('hello-bx and hello-world build to the same bytes for the release PET', async () => {
  const bx = await buildExample('hello-bx', 'pet');
  const plain = await buildExample('hello-world', 'pet');
  assert.equal(typeof bx, 'number');
  assert.equal(typeof plain, 'number');
  assert.equal(bx, plain, 'Hello() inlines to the same program bytes as a direct print with shared media');
});

test('hello-world builds for the release PET and 8K VIC-20 with its shared media', async () => {
  const pet = await buildExample('hello-world', 'pet');
  const vic20 = await buildExample('hello-world', 'vic20');
  assert.ok(pet > 0);
  assert.ok(vic20 > 0);
});
