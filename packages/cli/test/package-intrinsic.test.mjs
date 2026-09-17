// `8bs build` and `8bs check` fold `#package("version")` from the
// project's own package.json — the file above the entry, found the same
// way whether there is a build or only a file to check — so the string a
// title screen prints is the version the package carries, and a project
// with no package.json is told so by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { build } from '../src/build.mjs';
import { check } from '../src/check.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');

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

const MAIN = `import { screen } from "@8bitscript/screen";
import { text } from "@8bitscript/text";
const VERSION: string = #package("version");
export function main(): void {
    screen.blank();
    text.print(0, VERSION);
    text.print(40, #package("name"));
    text.releaseCursor();
}
`;

async function project(pkg) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-package-'));
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'src', 'main.8bs'), MAIN);
  await writeFile(join(dir, '8bitscript.config.ts'), "export default { entry: 'src/main.8bs', targets: { pet: {}, web: {} } };\n");
  if (pkg !== null) await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module', ...pkg }));
  return dir;
}

const hasText = (bytes, word) => bytes.includes(Buffer.from(word, 'latin1'));

test('8bs build folds #package("version") and #package("name") from the project\'s package.json, into the PET image and the wasm', async () => {
  const dir = await project({ name: 'title-screen', version: '7.8.9', private: true });
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const pet = await capture(() => build(['--target', 'pet', '--checkout', REPO]));
    assert.equal(pet.result, 0, pet.stdout + pet.stderr);
    const petBytes = await readFile(join(dir, 'dist', 'main-pet.prg'));
    assert.equal(hasText(petBytes, '7.8.9'), true, 'the version is in the PET image');
    assert.equal(hasText(petBytes, 'title-screen'), true, 'the name is in the PET image');

    const web = await capture(() => build(['--target', 'web', '--checkout', REPO]));
    assert.equal(web.result, 0, web.stdout + web.stderr);
    const wasm = await readFile(join(dir, 'dist', 'main.wasm'));
    assert.equal(hasText(wasm, '7.8.9'), true, 'the version is in the wasm data');
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test('8bs check resolves the same package.json a build would, and names a missing one', async () => {
  const dir = await project({ name: 'title-screen', version: '7.8.9' });
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const ok = await capture(() => check(['src/main.8bs'], { checkout: REPO }));
    assert.equal(ok.result, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /No problems found/);
    await rm(join(dir, 'package.json'));
    const missing = await capture(() => check(['src/main.8bs'], { checkout: REPO }));
    assert.notEqual(missing.result, 0);
    assert.match(missing.stdout + missing.stderr, /8BS1042/);
    assert.match(missing.stdout + missing.stderr, /no package\.json above/);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});
