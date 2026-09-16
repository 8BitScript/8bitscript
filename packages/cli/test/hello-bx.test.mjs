// The zero-cost gate for 8BX (spec §69): the hello-bx example, which
// draws its greeting through one component, must build to the same bytes
// as hello-world, which calls text.print() by hand. A component is a
// function and an element is a call to it; the linker's inliner is what
// makes that free when every prop is compile-time — and this is the test
// that says it is, in bytes, on the machine with the least to spare.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const EXAMPLES = join(REPO, 'packages', 'examples');

function silently(fn) {
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = out;
    process.stderr.write = err;
  });
}

/** Build one example for `target` in a scratch copy, resolving packages from this checkout. */
async function buildExample(name, target) {
  const dir = mkdtempSync(join(tmpdir(), `8bs-${name}-`));
  const prev = process.cwd();
  try {
    cpSync(join(EXAMPLES, name, 'src'), join(dir, 'src'), { recursive: true });
    cpSync(join(EXAMPLES, name, '8bitscript.config.ts'), join(dir, '8bitscript.config.ts'));
    process.chdir(dir);
    const result = await silently(() => compile(target, undefined, { checkout: REPO }));
    assert.equal(result.ok, true, `${name} builds for ${target}`);
    // Awaited here, not returned as a promise: the finally below removes the directory.
    return await readFile(result.outFile);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('hello-bx builds to the same bytes as hello-world on the PET: the component costs nothing', async () => {
  // One after the other: each build runs from its own scratch directory.
  const bx = await buildExample('hello-bx', 'pet');
  const plain = await buildExample('hello-world', 'pet');
  assert.equal(bx.length, plain.length, 'same size');
  assert.deepEqual([...bx], [...plain], 'same bytes');
});
