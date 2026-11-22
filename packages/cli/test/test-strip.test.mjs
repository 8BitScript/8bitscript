// `#[test]` functions and `#[cfg(test)]` modules parse and are left out of
// builds: a program with them appended builds byte for byte like the same
// program without them (test spec 3.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');

const SCORE = [
  'let mut score: utinyint = 0;',
  'pub fn main() {',
  '    score += 1;',
  '    memory::write(0x8000, score);',
  '}',
].join('\n');

const TESTS = [
  '',
  '#[test]',
  'fn adds_one() {',
  '    let a = 1;',
  '}',
  '#[test("named")]',
  'fn second() {}',
  '#[cfg(test)]',
  'mod tests {',
  '    #[test]',
  '    fn x() {}',
  '}',
  '',
].join('\n');

function quietly(fn) {
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = out;
    process.stderr.write = err;
  });
}

async function buildBoth(dir, target, options) {
  const entry = join(dir, 'main.8bs');
  const files = {};
  for (const [label, text] of [['with', SCORE + TESTS], ['without', SCORE + '\n']]) {
    await writeFile(entry, text);
    const result = await quietly(() => compile(target, entry, options));
    assert.equal(result.ok, true, `${target} ${label} builds`);
    const stem = result.outFile.replace(/\.[^./\\]+$/, '');
    const read = async (file) => readFile(file).catch(() => null);
    files[label] = {
      bytes: await readFile(result.outFile),
      lst: await read(`${stem}.lst`),
      debug: await read(`${stem}.8bs.debug.json`),
    };
  }
  return files;
}

test('a program with test declarations builds like the program without them', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-test-strip-'));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const c64 = await buildBoth(dir, 'c64', { debug: true });
    assert.ok(c64.with.bytes.length > 0);
    assert.deepEqual(c64.with.bytes, c64.without.bytes, 'c64 bytes');
    assert.ok(c64.with.lst, 'a listing was written');
    assert.deepEqual(c64.with.lst, c64.without.lst, 'listing');
    assert.ok(c64.with.debug, 'a debug map was written');
    assert.deepEqual(c64.with.debug, c64.without.debug, 'debug map');

    const web = await buildBoth(dir, 'web', { checkout: REPO, hardware: {} });
    assert.ok(web.with.bytes.length > 0);
    assert.deepEqual(web.with.bytes, web.without.bytes, 'web bytes');
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});
