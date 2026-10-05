// A web bundle has to load itself. `8bs build --target vic20 --web` with the
// release hardware (the VIC-20 with 8K, hardware tag `expanded`) writes
// program-expanded.wasm and program-expanded.json — the tag is part of the name
// so several models can sit side by side in dist/web — and index.html used to
// ask for `program.wasm` regardless. On a clean directory that is a 404 on the
// only file the page needs: a bundle that cannot be hosted, shared or embedded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWebBundle, renderHtml, renderEmbedExample } from '../src/web-runtime.mjs';

const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

async function bundle(options) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-bundle-name-'));
  await writeWebBundle(dir, WASM, options);
  return dir;
}

test('the page loads the file the bundle wrote, whatever it is called', async () => {
  const dir = await bundle({ wasmName: 'program-expanded' });
  try {
    const html = await readFile(join(dir, 'index.html'), 'utf8');
    const named = /src: '([^']+)'/.exec(html)[1];
    assert.equal(named, 'program-expanded.wasm');
    assert.ok(existsSync(join(dir, named)), `index.html asks for ${named}, which the bundle must contain`);
    assert.ok(existsSync(join(dir, 'program-expanded.json')), 'the loader finds the layout sidecar by the wasm name');
    assert.ok(!existsSync(join(dir, 'program.wasm')), 'and nothing else was written that the page could confuse it with');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the embed example names the same file, in the tag, the copy-paste and the instructions', async () => {
  const dir = await bundle({ wasmName: 'program-expanded' });
  try {
    const embed = await readFile(join(dir, 'embed.html'), 'utf8');
    assert.match(embed, /<eightbit-screen src="program-expanded\.wasm"/);
    assert.match(embed, /<code>program-expanded\.wasm<\/code>/);
    assert.doesNotMatch(embed, /program\.wasm/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an untagged build is unchanged: program.wasm, as every deploy so far has had', async () => {
  const dir = await bundle({});
  try {
    assert.match(await readFile(join(dir, 'index.html'), 'utf8'), /src: 'program\.wasm'/);
    assert.ok(existsSync(join(dir, 'program.wasm')));
    assert.match(renderHtml(60), /src: 'program\.wasm'/);
    assert.match(renderEmbedExample(), /src="program\.wasm"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
