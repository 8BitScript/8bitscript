import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeWebBundle, ISOLATION_HEADERS } from '../src/web-runtime.mjs';
import { captureScreenshot } from '../src/screenshot.mjs';
import { pixelAt } from '../src/png.mjs';

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// Writes border=2, background=0, screen-code 'A' at cell 0, color 1.
const PAINTS_A = hex(`
  00 61 73 6d 01 00 00 00
  01 04 01 60 00 00
  03 02 01 00
  05 03 01 00 01
  07 11 02 06 6d 65 6d 6f 72 79 02 00 04 6d 61 69 6e 00 00
  0a 21 01 1f 00 41 00 41 02 3a 00 00 41 01 41 00 3a 00 00
     41 02 41 41 3a 00 00 41 ea 07 41 01 3a 00 00 0b
`);

test('writeWebBundle writes index.html, worker.js, program.wasm, and COOP/COEP headers', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-bundle-'));
  try {
    await writeWebBundle(dir, PAINTS_A, { frameRate: 50 });
    const html = await readFile(join(dir, 'index.html'), 'utf8');
    assert.match(html, /LOGICAL_STEP_MS = 1000 \/ 50/);
    assert.match(html, /const GLYPHS = \{/);
    assert.match(html, /function paintGlyph/);
    assert.doesNotMatch(html, /ctx\.fillText/);
    const worker = await readFile(join(dir, 'worker.js'), 'utf8');
    assert.match(worker, /waitFrame/);
    assert.match(worker, /Atomics\.wait/);
    const wasm = await readFile(join(dir, 'program.wasm'));
    assert.deepEqual([...wasm], [...PAINTS_A]);
    const headers = await readFile(join(dir, '_headers'), 'utf8');
    assert.match(headers, /Cross-Origin-Opener-Policy/);
    assert.equal(ISOLATION_HEADERS['Cross-Origin-Embedder-Policy'], 'require-corp');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('captureScreenshot for web rasterizes wasm screen memory to a PNG of the same layout the canvas draws', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-shot-'));
  try {
    const wasmFile = join(dir, 'program.wasm');
    const shot = join(dir, 'out.png');
    await writeFile(wasmFile, PAINTS_A);
    await captureScreenshot('web', wasmFile, shot, { frames: 1 });
    const png = await readFile(shot);
    // Border color 2 is the C64 palette's '#883932'.
    assert.deepEqual(pixelAt(png, 0, 0), [0x88, 0x39, 0x32]);
    // The inner background (color 0) starts at BORDER_PX = 24.
    assert.deepEqual(pixelAt(png, 24, 24), [0x00, 0x00, 0x00]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('captureScreenshot names a target with no screenshot method', async () => {
  await assert.rejects(
    () => captureScreenshot('unknown', '/dev/null', '/tmp/nope.png'),
    /no screenshot method wired up for target 'unknown'/,
  );
});

test('8bs run web does not serve dist/web as the page — that file can be from another CLI', () => {
  const src = readFileSync(new URL('../src/run.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /root:\s*resolve\('dist',\s*'web'\)/);
});
