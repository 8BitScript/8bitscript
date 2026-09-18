// `8bs build --debug`: the .lst/.8bs.debug.json artifacts (compiler's
// mos/debug.ts), wired through compile()/build() the same way `--size`
// already wires the backend's own size report through.
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

const SCORE = [
  'let score: utinyint = 0;',
  'export function main(): void {',
  '    score += 1;',
  '    memory.write(0x8000, score);',
  '}',
  '',
].join('\n');

test('compile() --debug writes .lst and .8bs.debug.json beside the artifact, and neither without it', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-build-debug-'));
  const prev = process.cwd();
  try {
    const entry = join(dir, 'main.8bs');
    await writeFile(entry, SCORE);
    process.chdir(dir);

    const plain = await capture(() => compile('pet', entry));
    assert.equal(plain.result.ok, true, plain.stdout + plain.stderr);
    const lstFile = plain.result.outFile.replace(/\.prg$/, '.lst');
    const debugJsonFile = plain.result.outFile.replace(/\.prg$/, '.8bs.debug.json');
    assert.equal(existsSync(lstFile), false, 'a plain build should not write a listing');
    assert.equal(existsSync(debugJsonFile), false, 'a plain build should not write a debug map');

    const debugRun = await capture(() => compile('pet', entry, { debug: true }));
    assert.equal(debugRun.result.ok, true, debugRun.stdout + debugRun.stderr);
    assert.match(debugRun.stdout, /assembly listing:/);
    assert.match(debugRun.stdout, /debug map:/);
    assert.equal(existsSync(lstFile), true);
    assert.equal(existsSync(debugJsonFile), true);

    const lst = await readFile(lstFile, 'utf8');
    assert.match(lst, /score \+= 1;/);

    const debugMap = JSON.parse(await readFile(debugJsonFile, 'utf8'));
    assert.equal(debugMap.format, '8bitscript-debug');
    assert.equal(debugMap.version, 1);
    assert.equal(debugMap.target, 'pet');
    assert.ok(debugMap.modules.some((m) => m.endsWith('main.8bs')));
    assert.ok(debugMap.instructions.length > 0);
    assert.ok(debugMap.instructions.some((i) => i.source?.text === 'score += 1;'));
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test('build() with --debug on the command line prints the same two paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-build-debug-cli-'));
  const prev = process.cwd();
  try {
    const entry = join(dir, 'main.8bs');
    await writeFile(entry, SCORE);
    process.chdir(dir);
    const { result, stdout } = await capture(() => build(['--target', 'pet', '--debug', entry]));
    assert.equal(result, 0, stdout);
    assert.match(stdout, /assembly listing:.*\.lst/);
    assert.match(stdout, /debug map:.*\.8bs\.debug\.json/);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});
